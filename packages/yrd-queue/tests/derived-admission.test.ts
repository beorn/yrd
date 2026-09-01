/**
 * @failure The S6 door opens and a branch submitted only in git either cannot
 * run at all (selection/admission/authority all key on records), runs twice
 * under both lanes, silently loses its terminal `pr/integrated` (settlement
 * and every status surface go dark), or its identity is minted without the
 * commit-before-escape contract. Stage 3 of the door program
 * (@i/10-merge-queue/s6-door-design §5 ordering items 3-4): derived members
 * are selectable, admittable and runnable; the terminal emitters re-source
 * from the run's own ChangeSnapshot and the RELAXED reducer applies a
 * recordless terminal as a store no-op; the compose self-derives ref-only
 * branches where the 2b sweep used to mint records; and the retired mint arms
 * refuse `record-mint-retired` for any branch a live submit fact owns (A2 —
 * the fact IS the lane decision, made at write time).
 * @level l2
 * @consumer @yrd/queue
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import {
  ChangeIdSchema,
  changeDeliveryState,
  changeIdForDerivedSubmit,
  createBayJobDefs,
  recordLaneOwnsBranch,
  volatilePrNumberMint,
  withBays,
  type BayWorkspace,
  type PrNumberMint,
} from "@yrd/bay"
import {
  createMemoryJournal,
  createYrd,
  createYrdDef,
  failureFact,
  parseJournalFrame,
  pipe,
  type Journal,
  type JournalFrame,
} from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  advanceQueue,
  candidateRefFor,
  deriveRunMemberArgs,
  derivedAuthorityLookup,
  isDerivedRunMember,
  materializeDerivedRunMembers,
  Queues,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type DerivedRunMember,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"
import { indexedJournal } from "./support/indexed-journal.ts"

const packagesRoot = join(import.meta.dirname, "..", "..")
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const RESUBMIT_SHA = "8".repeat(40)
const CHANGE_ID = `I${"c".repeat(40)}`
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

const passingCheck = () =>
  withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )

const waitingCheck = () =>
  withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({ status: "waiting", token: "still-checking" }),
    { revision: "check-v1", output: CheckResultSchema },
  )

const passingMerge = () =>
  withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )

const DeployResultSchema = z.object({ environment: z.string() }).strict()
type DeployResult = z.infer<typeof DeployResultSchema>

const passingDeploy = (onCall: () => void) =>
  withStep(
    "deploy",
    (_input: StepExecution): JobResult<DeployResult> => {
      onCall()
      return { status: "completed", conclusion: "success", output: { environment: "staging" } }
    },
    { revision: "deploy-v1", kind: "action", output: DeployResultSchema },
  )

const authorFailingMerge = () =>
  withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "failure",
      error: { code: "authored-gitlink", message: "yrd: the branch authors a gitlink bump it may not carry" },
    }),
    { revision: "merge-v1" },
  )

async function createApp(
  options: Readonly<{
    journal?: Journal<unknown>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    steps?: readonly ReturnType<typeof passingCheck | typeof passingMerge | typeof passingDeploy>[]
    defaultSteps?: readonly string[]
    /** Arms the door's compose self-derivation (S6): the durable mint derived
     * admission commits identities to, and the git-enrichment reader. */
    prNumberMint?: PrNumberMint
    /** The bays plugin's own mint. Pass the SAME instance as `prNumberMint` to
     * model production, where both lanes share one durable pr-mint.json store
     * and numbering stays one monotone sequence. */
    baysPrNumberMint?: PrNumberMint
    readSubmitEnrichment?: (input: Readonly<{ branch: string; sha: string }>) => {
      changeId?: string
      props?: Record<string, string>
      issue?: string
    }
  }> = {},
) {
  const steps = options.steps ?? ([passingCheck(), passingMerge()] as const)
  // The step set varies per test, so the tuple literal withQueue's generics
  // infer from is erased here; the runtime shape is exactly the inferred one.
  const queue = withQueue({
    steps,
    batch: false,
    defaultSteps: options.defaultSteps ?? ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    ...(options.prNumberMint === undefined ? {} : { prNumberMint: options.prNumberMint }),
    ...(options.readSubmitEnrichment === undefined ? {} : { readSubmitEnrichment: options.readSubmitEnrichment }),
  } as never as Parameters<typeof withQueue>[0])
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: options.baysPrNumberMint ?? volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

/**
 * The door simulation: a branch whose record went terminal, re-submitted in
 * git at a NEW sha. The 2b sweep skips it (a record in ANY state hides the
 * branch from `unrecordedSubmits`), the arbitration rules it derived
 * (terminal×different-sha — the decisive A4 cell), and the derived-admission
 * path is the only way it can ever run — exactly the post-door regime.
 */
async function strandDerivedBranch(app: App, branch: string, sha: string = SHA): Promise<void> {
  await app.bays.submit({ branch, headSha: "9".repeat(40), base: "main", baseSha: BASE })
  const record = Object.values(app.state().bays.prs).find((pr) => pr.branch === branch)
  if (record === undefined) throw new Error(`no record for '${branch}'`)
  await app.bays.closePr({ pr: record.id, reason: "superseded" })
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
}

function doorEntry(
  app: App,
  branch: string,
  options: Readonly<{ mint?: PrNumberMint; props?: Record<string, string>; issue?: string }> = {},
): DerivedRunMember {
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: options.mint ?? volatilePrNumberMint(1),
    branch,
    enrichment: {
      changeId: CHANGE_ID,
      ...(options.props === undefined ? {} : { props: options.props }),
      ...(options.issue === undefined ? {} : { issue: options.issue }),
    },
  })
}

function stepsMapOf(app: App): ReadonlyMap<string, never> {
  const installed = app.queue.steps()
  return new Map(installed.map((step) => [step.name, { ...step, declaredDefault: true } as never]))
}

/** Every journaled event of `name`, in order — the door's terminal facts live
 * ONLY in the journal (the store write is a no-op for derived members). */
async function journalEvents(
  journal: Journal<unknown>,
  name: string,
): Promise<readonly Readonly<{ name: string; data: unknown }>[]> {
  const out: Readonly<{ name: string; data: unknown }>[] = []
  for await (const batch of journal.read(0)) {
    for (const value of batch.values) {
      const frame = parseJournalFrame(value)
      for (const applied of frame.events) if (applied.name === name) out.push(applied)
    }
  }
  return out
}

async function journalFrames(journal: Journal<unknown>): Promise<readonly JournalFrame[]> {
  const frames: JournalFrame[] = []
  for await (const batch of journal.read(0)) {
    frames.push(...batch.values.map((value) => parseJournalFrame(value)))
  }
  return frames
}

function admissionRequestEvents(frames: readonly JournalFrame[], pr: string) {
  return frames.flatMap((frame) =>
    frame.events.filter((applied) => {
      if (applied.name !== "job/requested") return false
      const input = (applied.data as { input?: { prs?: readonly { id?: unknown }[] } }).input
      return input?.prs?.some((member) => member.id === pr) === true
    }),
  )
}

/** One compose log line by its `action` prop — module-scoped so every test in
 * this file can assert on what a compose pass reported, not only the
 * @i/10-yrd/23996 block that introduced it. */
const composeEvent = (events: readonly LogEvent[], action: string) =>
  events.find(
    (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.action === action,
  )

describe("S6 stage 3 — derived-member selection, admission, run", () => {
  it("a derived member is selected, admitted against its submit-ref sha, and runs under its minted identity with zero record writes (A1 shape, check-only plan)", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    {
      await using app = await createApp({ journal, id, steps: [passingCheck()], defaultSteps: ["check"] })
      await strandDerivedBranch(app, "issue/derived")
      const prsBefore = structuredClone(app.state().bays.prs)
      const receiptsBefore = structuredClone(app.state().bays.receipts)

      // Admission-time mint (A9): terminal record PR1 is the frozen max, the
      // mint's own high-water is 1 — the derived member mints strictly above
      // both, and the revision continues the pre-door branch's count.
      const mint = volatilePrNumberMint(1)
      const entry = doorEntry(app, "issue/derived", { mint, props: { bead: "22991" }, issue: "22991" })
      expect(entry).toMatchObject({ id: "PR2", branch: "issue/derived", revision: 2, headSha: SHA })
      expect(mint.highWater()).toBe(2)

      const runs = await app.queue.run({ derived: [entry] }, runtime)
      expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

      // The run's snapshot carries the minted identity and the submit fact's
      // exact sha — the id's first escape is this journaled snapshot.
      const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
      if (record === undefined) throw new Error("expected a queue run for the derived member")
      expect(record.prs[0]).toMatchObject({
        id: "PR2",
        changeId: CHANGE_ID,
        branch: "issue/derived",
        revision: 2,
        headSha: SHA,
        props: { bead: "22991" },
        issue: "22991",
      })

      // Zero record writes: the store is byte-identical across the lifecycle,
      // and the submit fact still stands (nothing superseded it — the door
      // regime has no takeover act).
      expect(app.state().bays.prs).toEqual(prsBefore)
      expect(app.state().bays.receipts).toEqual(receiptsBefore)
      expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })

      // The id-seam answers the recordless id from the retained snapshot.
      expect(app.queue.resolveMember("PR2")).toMatchObject({ source: "snapshot", id: "PR2" })

      // A10: the derived run is audit-clean — no ancestry finding — because a
      // recordless member is derived BY DESIGN, not store corruption.
      //
      // The `missing-pr` assertion that used to lead this block is GONE, not
      // relaxed. It filtered for a code whose producer was unreachable, so it
      // held for every possible input and proved nothing about this fixture.
      // A test that cannot fail is not evidence of the property it names.
      const audit = app.queue.audit()
      expect(audit.findings.filter((finding) => finding.code === "run-without-submit-ancestry")).toEqual([])
      expect(audit.findings.filter((finding) => finding.code === "run-without-check-ancestry")).toEqual([])
    }

    // A5 (mixed eras, live half): the journal now holds a record-era terminal
    // change AND derived-member traffic (branch/submitted + queue/* snapshots
    // + admission jobs). A fresh projection over the same journal converges on
    // the same state with zero store writes for the derived era.
    await using replayed = await createApp({ journal, id, steps: [passingCheck()], defaultSteps: ["check"] })
    expect(Object.keys(replayed.state().bays.prs)).toEqual(["PR1"])
    const replayedRun = Queues.values(replayed.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    expect(replayedRun?.prs[0]).toMatchObject({ id: "PR2", headSha: SHA, revision: 2 })
  })

  it("a re-pushed derived branch reuses its retained snapshot identity through the real pipeline (A9 continuity)", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await strandDerivedBranch(app, "issue/derived")
    const mint = volatilePrNumberMint(1)
    await app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)

    // The author re-pushes the branch + submit ref at a new sha.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    const again = doorEntry(app, "issue/derived", { mint })
    expect(again).toMatchObject({ id: "PR2", revision: 3, headSha: RESUBMIT_SHA })
    // Reused, never re-minted: the high-water did not move again.
    expect(mint.highWater()).toBe(2)
  })

  it("the merge bookkeeping emits pr/integrated from the run's own snapshot for a recordless member, and the relaxed reducer applies it as a store no-op (A1/A8 emitter half)", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal })
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { props: { bead: "22991" }, issue: "22991" })
    const prsBefore = structuredClone(app.state().bays.prs)

    const runs = await app.queue.run({ derived: [entry] }, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The journaled terminal fact carries the snapshot-sourced payload — the
    // exact event settlement's hook receives (A8's enrichment half).
    const integrated = await journalEvents(journal, "pr/integrated")
    expect(integrated).toHaveLength(1)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run to be retained")
    expect(integrated[0]?.data).toMatchObject({
      pr: "PR2",
      revision: 2,
      headSha: SHA,
      run: record.id,
      commit: MERGED,
      landingSha: MERGED,
      baseSha: BASE,
      changeId: CHANGE_ID,
      props: { bead: "22991" },
      issueRef: "22991",
    })
    // The snapshot schema carries no submitter — the one accepted enrichment
    // delta (s6-door-preflight leg 1 names it rather than diffing it).
    expect((integrated[0]?.data as { submitter?: string }).submitter).toBeUndefined()

    // The relaxed reducer applied it as a store NO-OP: byte-identical records,
    // the branch's terminal record untouched, and the submit fact standing.
    expect(app.state().bays.prs).toEqual(prsBefore)
    expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })
  })

  it("pr/needs-author re-sources from the snapshot when a derived member's step fails author-owned (census #13)", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal, steps: [passingCheck(), authorFailingMerge()] })
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { props: { bead: "22991" }, issue: "22991" })
    const prsBefore = structuredClone(app.state().bays.prs)

    // Post-door the author-owned failure settles cleanly: the refusal FACT is
    // journaled from the snapshot and the relaxed reducer applies it as a
    // store no-op.
    await app.queue.run({ derived: [entry] }, runtime)
    const needsAuthor = await journalEvents(journal, "pr/needs-author")
    expect(needsAuthor).toHaveLength(1)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run to be retained")
    expect(needsAuthor[0]?.data).toMatchObject({
      pr: "PR2",
      revision: 2,
      headSha: SHA,
      run: record.id,
      issueRef: "22991",
      props: { bead: "22991" },
      step: "merge",
      receipt: { code: "authored-gitlink" },
    })
    expect(app.state().bays.prs).toEqual(prsBefore)

    // The pure-git analogue of the submitted/ready gate: once the live submit
    // fact moves off the pinned sha (the author superseded the member), the
    // refusal is not emitted — only the run failure is. Asserted on the pure
    // advance over the same run, its recorded failure stripped so the
    // emission path re-derives.
    const unfailed = { ...record, failure: undefined }
    const moved = {
      ...app.state(),
      bays: {
        ...app.state().bays,
        submits: { "issue/derived": { sha: RESUBMIT_SHA, base: "main", at: "2026-01-01T00:00:00.000Z" } },
      },
    }
    const withoutFact = advanceQueue(moved, unfailed as never, stepsMapOf(app))
    expect(withoutFact.events.some((event) => event.name === "pr/needs-author")).toBe(false)
    expect(withoutFact.events.some((event) => event.name === "queue/run/failed")).toBe(true)
    const standing = advanceQueue({ ...app.state() }, unfailed as never, stepsMapOf(app))
    expect(standing.events.some((event) => event.name === "pr/needs-author")).toBe(true)
  })

  it("derived submit authority returns once its consuming run settles, independently of a re-push (design §2; live 2026-09-01)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    // One durable mint across derivations, as production has: the re-derive
    // below reuses PR2 and must see the high-water its mint committed.
    const mint = volatilePrNumberMint(1)
    const entry = doorEntry(app, "issue/derived", { mint })
    await app.queue.run({ derived: [entry] }, runtime)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run")
    expect(record.passedAt).toBeDefined()

    // The consuming run has already SETTLED (passed) by the time `queue.run`
    // resolves, so its authority release already fired — no re-push needed.
    // Before the fix this stayed `{ standing: false, consumedBy: record.id }`
    // forever: `queue/run/settled` released only `authority.claims`, not the
    // `submits`/`checks` token `queue/run/failed` and `queue/run/canceled`
    // both release. Live incident: PR2749 and PR2909 refused
    // `queue-submit-authority-consumed` on a ~90s cadence for 19+ hours
    // against runs that had settled "passed" long before.
    const lookup = derivedAuthorityLookup(app.state())
    const snapshot = record.prs[0]
    if (snapshot === undefined) throw new Error("run lost its member")
    expect(lookup(snapshot)).toEqual({ standing: true })

    // A re-push is still an independent way to renew authority early, while a
    // consuming run is still active — per-push consent, the SAME sha included
    // (git CAS is the actuator).
    const repushed = {
      ...app.state(),
      bays: {
        ...app.state().bays,
        submits: { "issue/derived": { sha: SHA, base: "main", at: "2026-01-02T00:00:00.000Z" } },
      },
    }
    expect(derivedAuthorityLookup(repushed)(snapshot)).toEqual({ standing: true })

    // And the compose acts on the freed fact correctly: re-deriving the same
    // (already fully admitted) member reuses the settled admission instead of
    // running it again — a clean no-op, never a phantom
    // `queue-submit-authority-consumed` refusal.
    await expect(app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)).resolves.toEqual([])
    expect(app.state().queues.admissionRefusals.PR2).toBeUndefined()
  })

  it("a member with a live record for its branch never enters the derived lane (A4 — never both lanes)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    // High mint floor: the racing reopen below revives PR1 and later flows may
    // mint; the driver's number must not collide (production shares ONE
    // durable mint, where a collision is impossible by monotonicity).
    const entry = doorEntry(app, "issue/derived", { mint: volatilePrNumberMint(50) })
    // A live record appears for the branch AFTER the driver derived the entry:
    // the author's explicit D2 reopen of the terminal identity — the one
    // record-creation act the door leaves to a terminal-branch author.
    await app.bays.submit({ branch: "issue/derived", headSha: "6".repeat(40), base: "main", baseSha: BASE })
    const reopened = app.state().bays.prs.PR1
    expect(reopened?.state).toBe("open")
    expect(() => materializeDerivedRunMembers(app.state().bays, app.state().queues, [entry])).toThrow(
      /record lane owns it/,
    )
    // The selectorless compose skips the derived entry loudly instead of
    // running both lanes; the record lane owns the branch now.
    await expect(app.queue.run({ derived: [entry] }, runtime)).resolves.toBeDefined()
    const run = Queues.values(app.state().queues).find((candidate) => candidate.prs.some((pr) => pr.id === entry.id))
    expect(run).toBeUndefined()
  })

  it("the four loud edges: vanished fact, moved fact, duplicate payload, mint failure (R2 re-homed)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived")

    // Moved: the CAS refuses an entry derived at a superseded sha.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    expect(() => materializeDerivedRunMembers(app.state().bays, app.state().queues, [entry])).toThrow(/now stands at/)

    // Vanished: no fact at all refuses with the re-push cure.
    const gone = { ...app.state().bays, submits: {} }
    expect(() => materializeDerivedRunMembers(gone, app.state().queues, [entry])).toThrow(/no live submit fact/)
    expect(() => doorEntry(app, "issue/never-submitted")).toThrow(/no live submit fact/)

    // Duplicate payload: another open record already carries this exact
    // base+head — one payload under two identities PROPAGATES (2b's policy).
    await app.bays.submit({ branch: "issue/other", headSha: RESUBMIT_SHA, base: "main", baseSha: BASE })
    const duplicate = doorEntry(app, "issue/derived")
    const collision = (() => {
      try {
        materializeDerivedRunMembers(app.state().bays, app.state().queues, [duplicate])
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(String(collision)).toMatch(/payload already recorded as change/)
    expect(failureFact(collision)).toBeUndefined()
    await expect(app.queue.run({ derived: [duplicate] }, runtime)).rejects.toThrow(/payload already recorded/)

    // Mint failure: commit-before-escape means a broken mint store fails the
    // derivation loudly and mints nothing.
    const broken: PrNumberMint = Object.freeze({
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: PR-number mint store at '/broken/pr-mint.json' is unwritable: EIO")
      },
    })
    await using fresh = await createApp()
    await strandDerivedBranch(fresh, "issue/fresh")
    expect(() => doorEntry(fresh, "issue/fresh", { mint: broken })).toThrow(/PR-number mint store/)

    // Change-Id trailer missing is NOT a loud edge any more: the derivation
    // mints a synthetic identity from the submission's stable facts instead
    // of refusing (its own describe below); the refusal survives only for
    // non-canonical submit facts.
    await using bare = await createApp()
    await strandDerivedBranch(bare, "issue/bare")
    const minted = deriveRunMemberArgs({
      bays: bare.state().bays,
      queues: bare.state().queues,
      mint: volatilePrNumberMint(1),
      branch: "issue/bare",
    })
    expect(minted.changeId).toBe(changeIdForDerivedSubmit({ branch: "issue/bare", sha: SHA }))
  })

  it("A10 — a derived member is a full member row: id-seam resolution, snapshot-backed run rows, derived-by-design audit accounting", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await strandDerivedBranch(app, "issue/derived")
    await app.queue.run({ derived: [doorEntry(app, "issue/derived")] }, runtime)

    const resolved = app.queue.resolveMember("pr#2")
    expect(resolved).toMatchObject({ source: "snapshot", id: "PR2" })
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived run")
    expect(isDerivedRunMember(app.state().bays, record.prs[0] as never)).toBe(true)
    // The terminal record era still answers for ITS id — both eras named.
    expect(app.queue.resolveMember("PR1")).toMatchObject({ source: "record", id: "PR1" })
  })

  // ————— the three formerly door-gated tests, live now that the door is open —————

  it("a derived member merges end to end — pr/integrated APPLIES as a store no-op, prs/receipts byte-identical (A1 full)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    const prsBefore = structuredClone(app.state().bays.prs)
    const receiptsBefore = structuredClone(app.state().bays.receipts)
    const runs = await app.queue.run(
      { derived: [doorEntry(app, "issue/derived", { props: { bead: "22991" } })] },
      runtime,
    )
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().bays.prs).toEqual(prsBefore)
    expect(app.state().bays.receipts).toEqual(receiptsBefore)
  })

  it("a live submit is a runnable derived row served by one selectorless compose, not an unrecorded-submit refusal (A10 flip, A1 by the front door)", async () => {
    // The door's own wiring end to end: a branch + submit ref alone — no
    // records, no derived args, no intake — is derived, admitted, and run by
    // one selectorless compose under the configured mint + enrichment reader,
    // and the "visible, never runnable" refusal row retires once the lane
    // serves the branch.
    const mint = volatilePrNumberMint()
    await using app = await createApp({
      steps: [passingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      readSubmitEnrichment: () => ({ changeId: CHANGE_ID, props: { bead: "22991" }, issue: "22991" }),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/post-door", sha: SHA, base: "main" })
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/post-door"])
    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().bays.prs).toEqual({})
    const record = Queues.values(app.state().queues).find((run) =>
      run.prs.some((pr) => pr.branch === "issue/post-door"),
    )
    expect(record?.prs[0]).toMatchObject({
      id: "PR1",
      changeId: CHANGE_ID,
      headSha: SHA,
      revision: 1,
      props: { bead: "22991" },
      issue: "22991",
    })
    // Served ⇒ the refusal row retires everywhere it rendered.
    expect(await app.queue.unrecordedSubmits()).toEqual([])
    const audit = app.queue.audit({ now: "2026-01-02T00:00:00.000Z" })
    expect(audit.findings.filter((finding) => finding.code === "unrecorded-submit")).toEqual([])
    // Not yet served stays visible: a second ref-only branch with no compose
    // between keeps its row — the row is "not picked up", never silence.
    await app.bays.recordBranchSubmit({ branch: "issue/waiting", sha: RESUBMIT_SHA, base: "main" })
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/waiting"])
  })

  it("REGRESSION (2026-09-01): a compose pass reuses the SAME minted identity across passes while a derived member's required checks are still settling, instead of re-deriving a phantom sibling and abandoning the Job it just dispatched", async () => {
    // Live incident shape at yrd c576de2a: `compose-derived-admitted` minted
    // PR2919 for branch '…-r4' at 07:59:30; 56s later the SAME pass's
    // `queue-run-no-runnable-prs` still read the branch as unrecorded-submit
    // ("the last compose DID derive an admission for it… the next read
    // retires it" — it never did); 44s after that the NEXT compose pass
    // re-derived the identical (branch, sha) from scratch and minted PR2920.
    // Repeated every pass, forever — eleven branches wedged the same way.
    //
    // A required check that hands back a durable waiting token (the shape a
    // real remote Runner uses — job.ts's `JobWaiting`) never reaches
    // "completed": `admitChangeRevision` requests the Job once, reads it
    // straight back as non-terminal (queue.ts ~2890-2894), and — once
    // requested — `localRunner.submit`'s own short-circuit (job.status !==
    // "queued") means it is never re-invoked either. Checks-pending held
    // open on every later pass, deterministically, instead of racing a real
    // clock.
    const events: LogEvent[] = []
    const journal = indexedJournal()
    const id = ids()
    const mint = volatilePrNumberMint()
    await using app = await createApp({
      journal,
      id,
      steps: [waitingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      baysPrNumberMint: mint,
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/slow-checks", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    const firstMint = composeEvent(events, "compose-derived-admitted")
    expect(firstMint?.props).toMatchObject({ branch: "issue/slow-checks", pr: "PR1", revision: 1 })
    expect(mint.highWater()).toBe(1)
    const firstFrames = await journalFrames(journal)
    const bindingFrame = firstFrames.findIndex((frame) =>
      frame.events.some(
        (applied) => applied.name === "queue/derived-identity/bound" && (applied.data as { id?: unknown }).id === "PR1",
      ),
    )
    const requestFrame = firstFrames.findIndex((frame) => admissionRequestEvents([frame], "PR1").length > 0)
    // The mint's durable binding precedes the effectful candidate preparation
    // and its Job request. A crash in this deliberate gap leaves enough truth
    // for the next pass to request work under the SAME id.
    expect(bindingFrame).toBeGreaterThanOrEqual(0)
    expect(requestFrame).toBeGreaterThan(bindingFrame)

    const crashedJournal = indexedJournal(firstFrames.slice(0, bindingFrame + 1))
    const crashedAt = (await journalFrames(crashedJournal)).length
    await using restarted = await createApp({
      journal: crashedJournal,
      id,
      steps: [waitingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      baysPrNumberMint: mint,
    })
    await restarted.queue.run({}, runtime)
    const recoveredFrames = (await journalFrames(crashedJournal)).slice(crashedAt)
    expect(
      recoveredFrames.filter((frame) =>
        frame.events.some((applied) => applied.name === "queue/derived-identity/bound"),
      ),
    ).toHaveLength(0)
    const recoveredRequests = admissionRequestEvents(recoveredFrames, "PR1")
    expect(recoveredRequests).toHaveLength(1)
    expect(recoveredRequests[0]?.data).toMatchObject({ key: `admission:PR1:1:${BASE}:0:check-v1` })
    expect(mint.highWater()).toBe(1)

    events.length = 0
    await app.queue.run({}, runtime)
    const secondMint = composeEvent(events, "compose-derived-admitted")
    // THE BUG: unfixed, this mints 'PR2' — a phantom sibling for content
    // whose checks are already in flight under PR1's admissionJobKey, which
    // the pass then abandons unread.
    expect(secondMint?.props).toMatchObject({ branch: "issue/slow-checks", pr: "PR1", revision: 1 })
    expect(mint.highWater()).toBe(1)

    // A third pass for good measure — the bug re-fires every pass, not just once.
    events.length = 0
    await app.queue.run({}, runtime)
    const thirdMint = composeEvent(events, "compose-derived-admitted")
    expect(thirdMint?.props).toMatchObject({ branch: "issue/slow-checks", pr: "PR1", revision: 1 })
    expect(mint.highWater()).toBe(1)
    const requestsAfterThreePasses = admissionRequestEvents(await journalFrames(journal), "PR1")
    expect(requestsAfterThreePasses).toHaveLength(1)
    expect(requestsAfterThreePasses[0]?.data).toMatchObject({ key: `admission:PR1:1:${BASE}:0:check-v1` })

    // Still correctly "not yet landed" — that row is not the bug; the number
    // churn underneath it was. `unrecordedSubmits` only retires once a Queue
    // run actually starts, and none has (the check never settles here).
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/slow-checks"])
  })

  it("retires a legacy SHA-only Candidate loudly and binds a fresh identity to the exact branch+sha", async () => {
    const events: LogEvent[] = []
    const mint = volatilePrNumberMint(7)
    await using app = await createApp({
      steps: [waitingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      baysPrNumberMint: mint,
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    const legacyBranch = "issue/legacy-source-unknown"
    const branch = "issue/current-owner"
    await app.bays.recordBranchSubmit({ branch: legacyBranch, sha: SHA, base: "main" })
    await app.queue.run(
      {
        derived: [{ branch: legacyBranch, id: "PR7", changeId: CHANGE_ID, revision: 1, headSha: SHA }],
      },
      runtime,
    )
    expect(
      Object.values(app.state().queues.candidates).some((candidate) =>
        candidate.revs.some((revision) => revision.pr === "PR7" && revision.head === SHA),
      ),
    ).toBe(true)
    await app.bays.recordBranchUnsubmit({ branch: legacyBranch, reason: "superseded" })
    await app.bays.recordBranchSubmit({ branch, sha: SHA, base: "main" })

    events.length = 0
    await app.queue.run({}, runtime)

    expect(composeEvent(events, "compose-derived-legacy-candidate-retired")?.props).toMatchObject({
      branch,
      sha: SHA,
      legacyPr: "PR7",
      replacementPr: "PR8",
      remedy: `legacy SHA-only candidate; re-push under branch ${branch} takes the mint path`,
    })
    expect(app.state().queues.derivedIdentities[branch]?.[SHA]).toMatchObject({ id: "PR8", revision: 1 })
    expect(mint.highWater()).toBe(8)
  })

  it("does not misclassify another branch's exactly-bound Candidate as legacy at a shared sha", async () => {
    const events: LogEvent[] = []
    const mint = volatilePrNumberMint()
    await using app = await createApp({
      steps: [waitingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      baysPrNumberMint: mint,
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    const first = "issue/shared-sha-one"
    const second = "issue/shared-sha-two"
    await app.bays.recordBranchSubmit({ branch: first, sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(app.state().queues.derivedIdentities[first]?.[SHA]).toMatchObject({ id: "PR1" })

    events.length = 0
    await app.bays.recordBranchSubmit({ branch: second, sha: SHA, base: "main" })
    await app.queue.run({}, runtime)

    expect(app.state().queues.derivedIdentities[second]?.[SHA]).toMatchObject({ id: "PR2" })
    expect(composeEvent(events, "compose-derived-legacy-candidate-retired")).toBeUndefined()
  })

  it.each([
    {
      name: "an unsubmit and same-sha resubmit",
      transitions: [undefined, SHA],
      expectedIds: ["PR1", "PR1"],
      expectedBindings: 1,
    },
    {
      name: "a move away and return to the original sha",
      transitions: [RESUBMIT_SHA, SHA],
      expectedIds: ["PR1", "PR2", "PR1"],
      expectedBindings: 2,
    },
  ] as const)("keeps branch+sha identity stable through $name, live and under cold replay", async (fixture) => {
    const journal = indexedJournal()
    const id = ids()
    const mint = volatilePrNumberMint()
    const branch = "issue/identity-lifecycle"
    const composed: string[] = []
    const events: LogEvent[] = []

    const compose = async (app: App) => {
      events.length = 0
      await app.queue.run({}, runtime)
      const pr = composeEvent(events, "compose-derived-admitted")?.props?.pr
      if (typeof pr !== "string") throw new Error("expected compose-derived-admitted identity")
      composed.push(pr)
      const candidateMembers = Object.values(app.state().queues.candidates).flatMap((candidate) =>
        candidate.revs.map((revision) => revision.pr),
      )
      const runMembers = Queues.values(app.state().queues).flatMap((run) => run.prs.map((member) => member.id))
      expect(candidateMembers).not.toContain(pr)
      expect(runMembers).not.toContain(pr)
    }

    {
      await using app = await createApp({
        journal,
        id,
        steps: [passingCheck()],
        defaultSteps: ["check"],
        prNumberMint: mint,
        baysPrNumberMint: mint,
        log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
      })
      await app.queue.pause({
        base: "main",
        reason: "keep the identity pre-Candidate while exercising submit-fact lifecycle",
        allowedPRs: [],
        expiresAt: "2026-01-01T01:00:00.000Z",
      })
      await app.bays.recordBranchSubmit({ branch, sha: SHA, base: "main" })
      await compose(app)

      for (const sha of fixture.transitions) {
        if (sha === undefined) await app.bays.recordBranchUnsubmit({ branch, reason: "deleted" })
        else await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
        // Submit lifecycle changes which historical pair is current; it never
        // erases the old fact. Returning to SHA must find PR1 again live and
        // under cold replay.
        expect(app.state().queues.derivedIdentities[branch]?.[SHA]).toMatchObject({ id: "PR1" })
        if (sha !== undefined && sha !== SHA) {
          expect(app.state().queues.derivedIdentities[branch]?.[sha]).toBeUndefined()
        }
        if (sha === undefined) continue
        await compose(app)
      }

      expect(composed).toEqual(fixture.expectedIds)
      expect(mint.highWater()).toBe(fixture.expectedBindings)
      await expect(app.historySnapshot()).resolves.toBeDefined()
    }

    const replayEvents: LogEvent[] = []
    await using replayed = await createApp({
      journal,
      id,
      steps: [passingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      baysPrNumberMint: mint,
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => replayEvents.push(event) }]),
    })
    expect(replayed.state().bays.submits[branch]).toMatchObject({ sha: SHA })
    await replayed.queue.run({}, runtime)
    expect(composeEvent(replayEvents, "compose-derived-admitted")?.props).toMatchObject({ branch, pr: "PR1" })
    expect(mint.highWater()).toBe(fixture.expectedBindings)
    expect(await journalEvents(journal, "queue/derived-identity/bound")).toHaveLength(fixture.expectedBindings)
    expect(Object.keys(replayed.state().queues.derivedIdentities[branch] ?? {})).toHaveLength(fixture.expectedBindings)
    const frames = await journalFrames(journal)
    expect(frames.filter((frame) => frame.command.op === "queue.bindDerivedIdentity")).toHaveLength(
      fixture.expectedBindings,
    )
  })

  it("replay converges over a journal holding recordless terminal events, with zero store writes for the derived era (A5 full)", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let mintedPrs: unknown
    {
      await using app = await createApp({ journal, id })
      await strandDerivedBranch(app, "issue/derived")
      const prsBefore = structuredClone(app.state().bays.prs)
      await app.queue.run({ derived: [doorEntry(app, "issue/derived")] }, runtime)
      // The tolerate branch is a store NO-OP: the pre-door era's records are
      // byte-identical after the post-door segment applied its terminals.
      expect(app.state().bays.prs).toEqual(prsBefore)
      mintedPrs = prsBefore
    }
    await using replayed = await createApp({ journal, id })
    expect(replayed.state().bays.prs).toEqual(mintedPrs)
    const run = Queues.values(replayed.state().queues).find((record) => record.prs.some((pr) => pr.id === "PR2"))
    expect(run?.prs[0]).toMatchObject({ id: "PR2", headSha: SHA })
  })
})

describe("S6 derived lane — synthetic change-id mint for trailerless tips", () => {
  it("a trailerless tip is admitted by the selectorless compose under a synthetic identity — the measured production shape (2026-08-27: every agent branch refused, no agent tooling stamps trailers)", async () => {
    const events: LogEvent[] = []
    const mint = volatilePrNumberMint()
    await using app = await createApp({
      steps: [passingCheck()],
      defaultSteps: ["check"],
      prNumberMint: mint,
      // The production reader shape: the tip commit carries Bead/subject
      // trailers but NO Change-Id — enrichment comes back without one.
      readSubmitEnrichment: () => ({ props: { bead: "23231" }, issue: "23231" }),
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    await app.bays.recordBranchSubmit({ branch: "task/agent-branch", sha: SHA, base: "main" })
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["task/agent-branch"])

    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The member ran under a well-formed synthetic change id, recordless.
    const record = Queues.values(app.state().queues).find((run) =>
      run.prs.some((pr) => pr.branch === "task/agent-branch"),
    )
    expect(record?.prs[0]).toMatchObject({ id: "PR1", revision: 1, headSha: SHA, props: { bead: "23231" } })
    expect(ChangeIdSchema.safeParse(record?.prs[0]?.changeId).success).toBe(true)

    // Served — the refusal row retires, and no compose-derived-refused warn
    // fired for the branch (the old regime's dead end).
    expect(await app.queue.unrecordedSubmits()).toEqual([])
    const refused = events.filter(
      (event) => event.kind === "log" && event.level === "warn" && event.props?.action === "compose-derived-refused",
    )
    expect(refused).toEqual([])
  })

  it("the identity is stable across compose passes: the same (branch, tip sha) re-derives the same change id, and a new sha keys a NEW revision of the SAME identity via the retained snapshot", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await strandDerivedBranch(app, "issue/trailerless")
    const synthetic = changeIdForDerivedSubmit({ branch: "issue/trailerless", sha: SHA })
    const mint = volatilePrNumberMint(1)
    const derive = () =>
      deriveRunMemberArgs({ bays: app.state().bays, queues: app.state().queues, mint, branch: "issue/trailerless" })

    // Two derivations of the same push with NO snapshot journaled between
    // them: the CHANGE identity is bit-identical — a pure derivation from
    // stable facts. The number half keeps the mint's crash contract
    // (committed before escape, so an admission that never journals skips a
    // number and can never re-issue one), exactly as it does for trailered
    // branches today.
    const first = derive()
    const second = derive()
    expect(first.changeId).toBe(synthetic)
    expect(second.changeId).toBe(synthetic)
    expect(first).toMatchObject({ id: "PR2", revision: 2, headSha: SHA })
    expect(second).toMatchObject({ id: "PR3", revision: 2, headSha: SHA })

    // Compose pass 1 journals the run's snapshot — the identity's one durable
    // home.
    await app.queue.run({ derived: [second] }, runtime)

    // The author re-pushes at a NEW sha: compose pass 2 reuses the retained
    // identity — same id, same change id, NOT a re-derivation from the new
    // sha — and continues the revision count: a new revision of the SAME
    // change (branch continuity).
    await app.bays.recordBranchSubmit({ branch: "issue/trailerless", sha: RESUBMIT_SHA, base: "main" })
    const repushed = derive()
    expect(repushed).toMatchObject({ id: "PR3", changeId: synthetic, revision: 3, headSha: RESUBMIT_SHA })
    expect(repushed.changeId).not.toBe(changeIdForDerivedSubmit({ branch: "issue/trailerless", sha: RESUBMIT_SHA }))
    // Reused, never re-minted: the high-water did not move again.
    expect(mint.highWater()).toBe(3)
  })

  it("a Change-Id trailer still wins over the synthetic mint, and a retained snapshot's identity wins over both", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await strandDerivedBranch(app, "issue/derived")
    const synthetic = changeIdForDerivedSubmit({ branch: "issue/derived", sha: SHA })
    const mint = volatilePrNumberMint(1)

    // Trailer present ⇒ the trailer IS the identity; the synthetic mint never
    // fires (existing behavior, unchanged).
    const entry = doorEntry(app, "issue/derived", { mint })
    expect(entry.changeId).toBe(CHANGE_ID)
    expect(entry.changeId).not.toBe(synthetic)

    // Once the snapshot retains that identity it beats BOTH later sources: a
    // re-push derived with no enrichment at all keeps the trailer-minted id
    // rather than falling back to the synthetic mint — branch continuity.
    await app.queue.run({ derived: [entry] }, runtime)
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    const trailerless = deriveRunMemberArgs({
      bays: app.state().bays,
      queues: app.state().queues,
      mint,
      branch: "issue/derived",
    })
    expect(trailerless).toMatchObject({ id: entry.id, changeId: CHANGE_ID, revision: entry.revision + 1 })
  })

  it("the two lanes interleave without identity collision under the ONE shared durable mint production runs: numbers stay one monotone sequence, change-id namespaces are disjoint by domain", async () => {
    // Production shares ONE durable pr-mint.json between record-lane intake
    // and derived admission (queue plugin doc: "the SAME store the bays
    // plugin holds, so numbering stays one monotone sequence") — modeled here
    // by wiring a single volatile mint instance into BOTH plugins.
    const shared = volatilePrNumberMint()
    await using app = await createApp({
      steps: [passingCheck()],
      defaultSteps: ["check"],
      prNumberMint: shared,
      baysPrNumberMint: shared,
      // Trailerless: the derived lane runs on the synthetic mint.
      readSubmitEnrichment: () => ({}),
    })

    // Record lane first (factless legacy branch): PR1, command-minted id.
    await app.bays.submit({ branch: "issue/record-a", headSha: "1".repeat(40), base: "main", baseSha: BASE })
    // Derived lane (ref-only trailerless branch): composes as PR2 under the
    // synthetic change id.
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    // Record lane again: the shared mint saw the derived commit, so the next
    // record mints PR3 — a derived number is never re-issued to a record.
    await app.bays.submit({ branch: "issue/record-b", headSha: "2".repeat(40), base: "main", baseSha: BASE })

    expect(Object.keys(app.state().bays.prs).toSorted()).toEqual(["PR1", "PR3"])
    const derived = Queues.values(app.state().queues).find((run) =>
      run.prs.some((pr) => pr.branch === "issue/ref-only"),
    )
    expect(derived?.prs[0]).toMatchObject({
      id: "PR2",
      changeId: changeIdForDerivedSubmit({ branch: "issue/ref-only", sha: SHA }),
    })

    // No identity collides across the lanes: ids and change ids are each
    // pairwise distinct over every member of both.
    const recordChangeIds = Object.values(app.state().bays.prs).flatMap((pr) =>
      pr.revs.flatMap((rev) => (rev.changeId === undefined ? [] : [rev.changeId])),
    )
    expect(recordChangeIds).toHaveLength(2)
    const identities = [...recordChangeIds, derived?.prs[0]?.changeId]
    expect(new Set(identities).size).toBe(identities.length)
  })

  it("the refusal survives only for non-canonical submit facts, burns no number, and its reason names both cures", async () => {
    await using app = await createApp()
    const mint = volatilePrNumberMint(7)
    // A hand-corrupted projection: a submit fact whose sha is not a full hex
    // object name. Unreachable through the validated event path — which is
    // exactly why the mint must not manufacture a drifting identity from it.
    const corrupt = {
      ...app.state().bays,
      submits: { "issue/corrupt": { sha: "deadbeef", base: "main", at: "2026-01-01T00:00:00.000Z" } },
    }
    const refusal = (() => {
      try {
        deriveRunMemberArgs({ bays: corrupt as never, queues: app.state().queues, mint, branch: "issue/corrupt" })
        return undefined
      } catch (error) {
        return failureFact(error)
      }
    })()
    expect(refusal).toMatchObject({ kind: "refusal", code: "derived-change-id-missing" })
    expect(refusal?.message).toMatch(/carries no Change-Id trailer/)
    expect(refusal?.message).toMatch(/amend the tip commit with a Change-Id trailer/)
    expect(refusal?.message).toMatch(/amend the tip commit with a Change-Id trailer and re-push/)
    expect(refusal?.message).not.toMatch(/record lane/)
    // Commit-free refusal: the number mint never burned.
    expect(mint.highWater()).toBe(7)
  })

  it("with no PR-number mint configured the compose says so loudly, names the mint cure, and every row stands", async () => {
    const events: LogEvent[] = []
    await using app = await createApp({
      steps: [passingCheck()],
      defaultSteps: ["check"],
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/unadmittable", sha: SHA, base: "main" })
    await expect(app.queue.run({}, runtime)).resolves.toBeDefined()
    const warn = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "compose-derived-mint-missing",
    )
    expect(warn).toBeDefined()
    expect(warn?.message).toMatch(/every row stands until the mint exists/)
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/unadmittable"])
  })

  // ————— @i/10-yrd/23996: the empty return that said nothing —————
  //
  // `deriveRefOnlyMembers` hands the caller the same `[]` for a healthy empty
  // lane and for an unconfigured mint. Only the second had a voice, so from
  // outside the two were the same silence — and the standing unrecorded-submit
  // rows they leave behind read the same too. Both empty returns must now say
  // WHICH, and the two must not say the same thing.

  it("says the derived lane is EMPTY, with the population it is empty over, when the mint IS configured", async () => {
    const events: LogEvent[] = []
    await using app = await createApp({
      steps: [passingCheck()],
      defaultSteps: ["check"],
      prNumberMint: volatilePrNumberMint(),
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    // No submit facts at all: the ordinary, healthy nothing-to-do compose —
    // the exact pass that used to return `[]` without a word.
    await expect(app.queue.run({}, runtime)).resolves.toBeDefined()

    const empty = composeEvent(events, "compose-derived-lane-empty")
    expect(empty, "the empty-lane return must not be silent").toBeDefined()
    expect(empty?.level, "nothing-to-do is not a fault").toBe("info")
    expect(empty?.message).toMatch(/derived lane is EMPTY/u)
    expect(empty?.message).toMatch(/mint is configured/u)
    // What was queried, and what was excluded — never a bare zero.
    expect(empty?.props).toMatchObject({
      cause: "lane-empty",
      submits: 0,
      lane: 0,
      offered: 0,
      excludedAlreadyAdmitted: 0,
      excludedAlreadyLanded: 0,
      excludedSuperseded: 0,
      mint: "configured",
    })
    // The wiring fault it must NOT be confused with.
    expect(composeEvent(events, "compose-derived-mint-missing")).toBeUndefined()
  })

  it("says the MINT is unconfigured, not merely that the lane is empty, on the same empty return", async () => {
    const events: LogEvent[] = []
    await using app = await createApp({
      steps: [passingCheck()],
      defaultSteps: ["check"],
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
    })
    // Same empty lane, different wiring: nothing is standing, so the existing
    // mint-missing warn (which needs an offered branch) never fires. This is
    // the branch that had no voice at all.
    await expect(app.queue.run({}, runtime)).resolves.toBeDefined()

    const empty = composeEvent(events, "compose-derived-lane-empty")
    expect(empty).toBeDefined()
    expect(empty?.level, "an unwired lane is a configuration fault, not a no-op").toBe("warn")
    expect(empty?.message).toMatch(/derived admission is UNWIRED/u)
    expect(empty?.message).toMatch(/no PR-number mint is configured/u)
    expect(empty?.props).toMatchObject({ cause: "mint-unconfigured", mint: "unconfigured", submits: 0 })
  })

  it("the two empty returns do not say the same thing — that sameness WAS the defect", async () => {
    const said = async (mint: boolean): Promise<Readonly<{ level: string; message: string; cause: unknown }>> => {
      const events: LogEvent[] = []
      await using app = await createApp({
        steps: [passingCheck()],
        defaultSteps: ["check"],
        ...(mint ? { prNumberMint: volatilePrNumberMint() } : {}),
        log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]),
      })
      await app.queue.run({}, runtime)
      const empty = composeEvent(events, "compose-derived-lane-empty")
      if (empty === undefined) throw new Error("the empty-lane return logged nothing")
      return { level: empty.level, message: empty.message, cause: empty.props?.cause }
    }

    const [wired, unwired] = await Promise.all([said(true), said(false)])
    expect(wired.message).not.toBe(unwired.message)
    expect(wired.level).not.toBe(unwired.level)
    expect(wired.cause).not.toBe(unwired.cause)
  })
})

describe("S6 door — the retired mint arms and the receiver's lane rule (A2)", () => {
  it("bay.intake refuses record-mint-retired for a branch a live submit fact owns and no record does, and the message names the surviving path", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "issue/facted", sha: SHA, base: "main" })
    const refusal = await app.bays
      .intake({ branch: "issue/facted", headSha: SHA, base: "main", baseSha: BASE })
      .then(() => undefined)
      .catch((error: unknown) => failureFact(error))
    expect(refusal).toMatchObject({ kind: "refusal", code: "record-mint-retired" })
    expect(refusal?.message).toMatch(/refs\/for\/main\/<issue>/)
    expect(app.state().bays.prs).toEqual({})
  })

  it("bay.submit refuses record-mint-retired for the same branch, and the message names the surviving path", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "issue/facted", sha: SHA, base: "main" })
    await expect(
      app.bays.submit({ branch: "issue/facted", headSha: SHA, base: "main", baseSha: BASE }),
    ).rejects.toThrow(/record-mint-retired|refs\/for/)
    const refusal = await app.bays
      .submit({ branch: "issue/facted", headSha: SHA, base: "main", baseSha: BASE })
      .then(() => undefined)
      .catch((error: unknown) => failureFact(error))
    expect(refusal).toMatchObject({ kind: "refusal", code: "record-mint-retired" })
    expect(refusal?.message).toMatch(/refs\/for\/main\/<issue>/)
    expect(app.state().bays.prs).toEqual({})
  })

  it("a factless branch keeps the legacy mint — the population no receiver delivered, still visible to the S7 drain gauge", async () => {
    await using app = await createApp()
    await app.bays.submit({ branch: "issue/legacy", headSha: SHA, base: "main", baseSha: BASE })
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("the refusal code has exactly one spelling across every package source (A2 grep half)", () => {
    const roots = readdirSync(packagesRoot).flatMap((pkg) => {
      const src = join(packagesRoot, pkg, "src")
      return existsSync(src) ? [src] : []
    })
    const spellings = new Set<string>()
    for (const root of roots) {
      for (const entry of readdirSync(root, { recursive: true }) as string[]) {
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
        const source = readFileSync(join(root, entry), "utf8")
        for (const match of source.matchAll(/record[-_ ]?mint[-_ ]?retired/giu)) spellings.add(match[0])
      }
    }
    expect([...spellings]).toEqual(["record-mint-retired"])
  })

  it("no refs/for cure or resolution string sends its push to origin (class guard 55b0d841 lacked: it fixed the observation arm's one call site, not every printed cure)", () => {
    // A `refs/for` push is read by the repository's own receiver alone (the
    // prs.git store) — origin never hears of it (RECEIVER_REMOTE_NAME,
    // yrd-bay/src/git.ts). Three production cure/resolution strings named
    // `origin` here regardless and sent a reader who followed them to a
    // remote that silently discards the submission.
    const roots = readdirSync(packagesRoot).flatMap((pkg) => {
      const src = join(packagesRoot, pkg, "src")
      return existsSync(src) ? [src] : []
    })
    const cures: string[] = []
    const originCures: string[] = []
    for (const root of roots) {
      for (const entry of readdirSync(root, { recursive: true }) as string[]) {
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
        const path = join(root, entry)
        for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
          if (!/git\s+push\s+\S+[^\n]*refs\/for\//u.test(line)) continue
          cures.push(`${path}:${line.trim()}`)
          if (/git\s+push\s+origin\b/u.test(line)) originCures.push(`${path}:${line.trim()}`)
        }
      }
    }
    // Proves the scan is live rather than vacuously empty — an empty `cures`
    // walk would pass `originCures` for the wrong reason.
    expect(cures.length).toBeGreaterThanOrEqual(3)
    expect(originCures).toEqual([])
  })

  it("the receiver's lane rule: intake dispatches only for a branch a LIVE record owns", async () => {
    await using app = await createApp()
    // No record: derived lane.
    expect(recordLaneOwnsBranch(app.state().bays, "issue/nothing")).toBe(false)
    // Terminal record: still the derived lane (the decisive A4 cell).
    await strandDerivedBranch(app, "issue/terminal")
    expect(recordLaneOwnsBranch(app.state().bays, "issue/terminal")).toBe(false)
    // Live record: the grandfathered record lane.
    await app.bays.submit({ branch: "issue/live", headSha: "6".repeat(40), base: "main", baseSha: BASE })
    expect(recordLaneOwnsBranch(app.state().bays, "issue/live")).toBe(true)
  })
  it("a derived member's merged truth is PROJECTED from its merging run, so a deploy-only follow-on is admitted instead of refused for spent authority", async () => {
    // The defect this replaced: `materializeDerivedRunMember` built every
    // member with `state: "open"` and `merged: false` as adjacent literals and
    // nothing ever recomputed them, so a member read "never landed" for its
    // whole life. `integratedChangeShape` gates on `.merged`, so
    // `alreadyIntegrated` arrived false at the authority gate, the
    // `if (alreadyIntegrated) return undefined` exemption was unreachable, and
    // a deploy-only plan — which contains no merge step and needs no authority
    // at all — was refused with "checks authority was consumed by queue run
    // 'R1'". The word *checks* in that refusal was the tell.
    let deployCalls = 0
    await using app = await createApp({
      steps: [
        passingCheck(),
        passingMerge(),
        passingDeploy(() => {
          deployCalls += 1
        }),
      ],
      defaultSteps: ["check", "merge"],
    })
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { mint: volatilePrNumberMint(1) })

    // Negative control: BEFORE anything merges it, the member reads open and
    // un-merged — the projection answers "still open" honestly rather than
    // trading one hardcode for another.
    const beforeMerge = materializeDerivedRunMembers(app.state().bays, app.state().queues, [entry])[0]
    if (beforeMerge === undefined) throw new Error("expected a materialized member")
    expect(beforeMerge).toMatchObject({ state: "open", merged: false })
    expect(beforeMerge.integration).toBeUndefined()
    expect(changeDeliveryState(beforeMerge)).toBe("submitted")

    await expect(app.queue.run({ derived: [entry], steps: ["check", "merge"] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "completed", conclusion: "success" },
    ])

    // The merging run now carries the proof on its own record — the durable
    // home, stamped beside `passedAt`, that outlives Job retention.
    const merging = Queues.get(app.state().queues, "R1")
    expect(merging).toMatchObject({ passedAt: expect.any(String), integration: { commit: MERGED, baseSha: BASE } })

    // ...and the member re-materializes closed+merged, carrying that proof.
    const afterMerge = materializeDerivedRunMembers(app.state().bays, app.state().queues, [entry])[0]
    if (afterMerge === undefined) throw new Error("expected a materialized member")
    expect(afterMerge).toMatchObject({
      state: "closed",
      merged: true,
      terminalRun: "R1",
      integration: { commit: MERGED, baseSha: BASE },
      integratedAt: expect.any(String),
    })

    // The headline consequence: the deploy-only follow-on runs. It asks for no
    // merge step, so it needs no authority, and the exemption is now reachable.
    await expect(app.queue.run({ derived: [entry], steps: ["deploy"] }, runtime)).resolves.toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
    expect(deployCalls).toBe(1)
  })

  it('changeDeliveryState reaches its `integrated` arm for a derived member — the arm the sibling `state: "open"` hardcode made dead code', async () => {
    // Second consequence named by the bead: `changeDeliveryState` gates its
    // whole closed arm on `pr.state === "closed"`, so `integrated`,
    // `already-landed`, `canceled` and `withdrawn` were all unreachable on the
    // derived lane no matter what landed.
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { mint: volatilePrNumberMint(1) })
    await app.queue.run({ derived: [entry] }, runtime)

    const member = materializeDerivedRunMembers(app.state().bays, app.state().queues, [entry])[0]
    if (member === undefined) throw new Error("expected a materialized member")
    expect(changeDeliveryState(member)).toBe("integrated")
  })

  it("a member whose merging run FAILED still reads open and un-merged — the projection needs a settled proof, not merely a run", async () => {
    // The positive control for the negative: a run that named this branch and
    // planned a merge is not enough. Only a run that SETTLED passed and
    // retained its proof makes the member merged, so a failed merge cannot
    // silently mark a change landed.
    await using app = await createApp({ steps: [passingCheck(), authorFailingMerge()] })
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { mint: volatilePrNumberMint(1) })
    await app.queue.run({ derived: [entry] }, runtime)

    const failed = Queues.get(app.state().queues, "R1")
    expect(failed?.integration).toBeUndefined()

    const member = materializeDerivedRunMembers(app.state().bays, app.state().queues, [entry])[0]
    if (member === undefined) throw new Error("expected a materialized member")
    expect(member).toMatchObject({ state: "open", merged: false })
    expect(changeDeliveryState(member)).not.toBe("integrated")
  })
})
