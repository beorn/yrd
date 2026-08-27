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
import { createLogger } from "loggily"
import {
  createBayJobDefs,
  recordLaneOwnsBranch,
  volatilePrNumberMint,
  withBays,
  type BayWorkspace,
  type PrNumberMint,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, failureFact, parseJournalFrame, pipe } from "@yrd/core"
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

const passingMerge = () =>
  withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
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
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    steps?: readonly ReturnType<typeof passingCheck | typeof passingMerge>[]
    defaultSteps?: readonly string[]
    /** Arms the door's compose self-derivation (S6): the durable mint derived
     * admission commits identities to, and the git-enrichment reader. */
    prNumberMint?: PrNumberMint
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
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
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
  journal: ReturnType<typeof createMemoryJournal>,
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

      // A10: the derived run is audit-clean — no missing-pr, no ancestry
      // finding — because a recordless member above the frozen max is derived
      // BY DESIGN, not store corruption.
      const audit = app.queue.audit()
      expect(audit.findings.filter((finding) => finding.code === "missing-pr")).toEqual([])
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

  it("derived submit authority is one-per-fact: consumed by the merge run, standing again after a re-push (design §2)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    // One durable mint across derivations, as production has: the re-derive
    // below reuses PR2 and must see the high-water its mint committed.
    const mint = volatilePrNumberMint(1)
    const entry = doorEntry(app, "issue/derived", { mint })
    await app.queue.run({ derived: [entry] }, runtime)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run")

    const lookup = derivedAuthorityLookup(app.state())
    const snapshot = record.prs[0]
    if (snapshot === undefined) throw new Error("run lost its member")
    expect(lookup(snapshot)).toEqual({ standing: false, consumedBy: record.id })

    // Re-push = per-push consent: the fact re-projects with a newer clock and
    // the SAME sha still renews authority (git CAS is the actuator).
    const repushed = {
      ...app.state(),
      bays: {
        ...app.state().bays,
        submits: { "issue/derived": { sha: SHA, base: "main", at: "2026-01-02T00:00:00.000Z" } },
      },
    }
    expect(derivedAuthorityLookup(repushed)(snapshot)).toEqual({ standing: true })

    // And the compose acts on consumption: the same member again is skipped
    // (consumed authority — the cure is a re-push), with the durable ledger
    // row and no phantom needs-author on a record that does not exist.
    await expect(app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)).resolves.toEqual([])
    expect(app.state().queues.admissionRefusals.PR2).toMatchObject({
      pr: "PR2",
      code: "queue-submit-authority-consumed",
    })
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
    expect(() => materializeDerivedRunMembers(app.state().bays, [entry])).toThrow(/record lane owns it/)
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
    expect(() => materializeDerivedRunMembers(app.state().bays, [entry])).toThrow(/now stands at/)

    // Vanished: no fact at all refuses with the re-push cure.
    const gone = { ...app.state().bays, submits: {} }
    expect(() => materializeDerivedRunMembers(gone, [entry])).toThrow(/no live submit fact/)
    expect(() => doorEntry(app, "issue/never-submitted")).toThrow(/no live submit fact/)

    // Duplicate payload: another open record already carries this exact
    // base+head — one payload under two identities PROPAGATES (2b's policy).
    await app.bays.submit({ branch: "issue/other", headSha: RESUBMIT_SHA, base: "main", baseSha: BASE })
    const duplicate = doorEntry(app, "issue/derived")
    const collision = (() => {
      try {
        materializeDerivedRunMembers(app.state().bays, [duplicate])
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

    // Change-Id trailer missing: refused at derivation, never a dark terminal.
    await using bare = await createApp()
    await strandDerivedBranch(bare, "issue/bare")
    expect(() =>
      deriveRunMemberArgs({
        bays: bare.state().bays,
        queues: bare.state().queues,
        mint: volatilePrNumberMint(1),
        branch: "issue/bare",
      }),
    ).toThrow(/no Change-Id trailer/)
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
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/post-door"])
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
    expect(app.queue.unrecordedSubmits()).toEqual([])
    const audit = app.queue.audit({ now: "2026-01-02T00:00:00.000Z" })
    expect(audit.findings.filter((finding) => finding.code === "unrecorded-submit")).toEqual([])
    // Not yet served stays visible: a second ref-only branch with no compose
    // between keeps its row — the row is "not picked up", never silence.
    await app.bays.recordBranchSubmit({ branch: "issue/waiting", sha: RESUBMIT_SHA, base: "main" })
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/waiting"])
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

describe("S6 door — the retired mint arms and the receiver's lane rule (A2)", () => {
  it("bay.intake refuses record-mint-retired for a branch a live submit fact owns and no record does", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "issue/facted", sha: SHA, base: "main" })
    await expect(
      app.bays.intake({ branch: "issue/facted", headSha: SHA, base: "main", baseSha: BASE }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "record-mint-retired" } })
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
})
