/**
 * @failure A branch submitted only in git either cannot run at all
 * (selection/admission/authority all key on records), runs twice, silently
 * loses its terminal `pr/integrated` (settlement and every status surface go
 * dark), or its identity is minted without the commit-before-escape contract.
 * Derived members are selectable, admittable and runnable; the terminal
 * emitters re-source from the run's own ChangeSnapshot; the compose
 * self-derives ref-only branches; and the retired record mint refuses so no
 * caller silently falls back to it.
 *
 * S7 (branch-is-change, @i/10 22991) deleted the change-record store, so the
 * "zero record writes" half of this contract is structural rather than
 * asserted — there is nothing left to write to — and the record x submit
 * arbitration cells collapse to one lane. What these tests still own is the
 * identity contract: the run snapshot is a derived member's only durable home,
 * the number mint commits before the id escapes, the change id is stable
 * across composes and continues across re-pushes, and every loud edge on the
 * submit fact stays loud.
 * @level l2
 * @consumer @yrd/queue
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import {
  ChangeIdSchema,
  changeIdForDerivedSubmit,
  createBayJobDefs,
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
    /** Arms the compose's self-derivation: the durable mint derived admission
     * commits identities to, and the git-enrichment reader. */
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
    withBays({ jobs: bayJobs }),
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

/** The whole delivery: a branch and the standing submit fact the receiver
 * projected for it. Post-S7 this is the ONLY way a member comes into being. */
async function submitted(app: App, branch: string, sha: string = SHA): Promise<void> {
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
    mint: options.mint ?? volatilePrNumberMint(),
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

/** Every journaled event of `name`, in order — a derived member's terminal
 * facts live ONLY in the journal. */
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

describe("derived-member selection, admission, run", () => {
  it("a derived member is selected, admitted against its submit-ref sha, and runs under its minted identity (check-only plan)", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    {
      await using app = await createApp({ journal, id, steps: [passingCheck()], defaultSteps: ["check"] })
      await submitted(app, "issue/derived")

      // Admission-time mint: the derived member mints strictly above the
      // mint's own high-water, and commits it before the id escapes.
      const mint = volatilePrNumberMint(1)
      const entry = doorEntry(app, "issue/derived", { mint, props: { bead: "22991" }, issue: "22991" })
      expect(entry).toMatchObject({ id: "PR2", branch: "issue/derived", revision: 1, headSha: SHA })
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
        headSha: SHA,
        props: { bead: "22991" },
        issue: "22991",
      })

      // The submit fact still stands: nothing superseded it — there is no
      // takeover act left.
      expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })

      // The id-seam answers the recordless id from the retained snapshot.
      expect(app.queue.resolveMember("PR2")).toMatchObject({ source: "snapshot", id: "PR2" })

      // The derived run is audit-clean. This used to name three codes
      // explicitly — `missing-pr`, `run-without-submit-ancestry`,
      // `run-without-check-ancestry` — because a recordless member tripped all
      // three as store corruption. S7 deleted the three outright (they are no
      // longer in YRD_QUEUE_AUDIT_FINDING_CODES), the corruption they
      // described being the normal case now. Asserting the whole finding set
      // is empty is what survives, and it is strictly stronger: it also
      // catches a NEW code inventing the same false alarm.
      expect(app.queue.audit().findings).toEqual([])
    }

    // A fresh projection over the same journal converges on the same state:
    // every event the derived era wrote is an already-registered one.
    await using replayed = await createApp({ journal, id, steps: [passingCheck()], defaultSteps: ["check"] })
    const replayedRun = Queues.values(replayed.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    expect(replayedRun?.prs[0]).toMatchObject({ id: "PR2", headSha: SHA })
  })

  it("a re-pushed derived branch reuses its retained snapshot identity through the real pipeline (continuity)", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await submitted(app, "issue/derived")
    const mint = volatilePrNumberMint(1)
    await app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)

    // The author re-pushes the branch + submit ref at a new sha.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    const again = doorEntry(app, "issue/derived", { mint })
    expect(again).toMatchObject({ id: "PR2", revision: 2, headSha: RESUBMIT_SHA })
    // Reused, never re-minted: the high-water did not move again.
    expect(mint.highWater()).toBe(2)
  })

  it("the merge bookkeeping emits pr/integrated from the run's own snapshot for a recordless member", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal })
    await submitted(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { props: { bead: "22991" }, issue: "22991" })

    const runs = await app.queue.run({ derived: [entry] }, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The journaled terminal fact carries the snapshot-sourced payload — the
    // exact event settlement's hook receives.
    const integrated = await journalEvents(journal, "pr/integrated")
    expect(integrated).toHaveLength(1)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === entry.id))
    if (record === undefined) throw new Error("expected the derived merge run to be retained")
    expect(integrated[0]?.data).toMatchObject({
      pr: entry.id,
      headSha: SHA,
      run: record.id,
      commit: MERGED,
      landingSha: MERGED,
      baseSha: BASE,
      changeId: CHANGE_ID,
      props: { bead: "22991" },
      issueRef: "22991",
    })
    // The snapshot schema carries no submitter — the one accepted enrichment delta.
    expect((integrated[0]?.data as { submitter?: string }).submitter).toBeUndefined()

    // The submit fact still stands after the terminal applied.
    expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })
  })

  it("pr/needs-author re-sources from the snapshot when a derived member's step fails author-owned", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal, steps: [passingCheck(), authorFailingMerge()] })
    await submitted(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { props: { bead: "22991" }, issue: "22991" })

    // The author-owned failure settles cleanly: the refusal FACT is journaled
    // from the snapshot.
    await app.queue.run({ derived: [entry] }, runtime)
    const needsAuthor = await journalEvents(journal, "pr/needs-author")
    expect(needsAuthor).toHaveLength(1)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === entry.id))
    if (record === undefined) throw new Error("expected the derived merge run to be retained")
    expect(needsAuthor[0]?.data).toMatchObject({
      pr: entry.id,
      headSha: SHA,
      run: record.id,
      issueRef: "22991",
      props: { bead: "22991" },
      step: "merge",
      receipt: { code: "authored-gitlink" },
    })

    // The pure-git submitted/ready gate: once the live submit fact moves off
    // the pinned sha (the author superseded the member), the refusal is not
    // emitted — only the run failure is. Asserted on the pure advance over the
    // same run, its recorded failure stripped so the emission path re-derives.
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

  it("derived submit authority is one-per-fact: consumed by the merge run, standing again after a re-push", async () => {
    await using app = await createApp()
    await submitted(app, "issue/derived")
    // One durable mint across derivations, as production has: the re-derive
    // below reuses the id and must see the high-water its mint committed.
    const mint = volatilePrNumberMint(1)
    const entry = doorEntry(app, "issue/derived", { mint })
    await app.queue.run({ derived: [entry] }, runtime)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === entry.id))
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
    // (consumed authority — the cure is a re-push), with the durable ledger row.
    await expect(app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)).resolves.toEqual([])
    expect(app.state().queues.admissionRefusals[entry.id]).toMatchObject({
      pr: entry.id,
      code: "queue-submit-authority-consumed",
    })
  })

  it("the loud edges on the submit fact: vanished fact, moved fact, mint failure", async () => {
    await using app = await createApp()
    await submitted(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived")

    // Moved: the CAS refuses an entry derived at a superseded sha.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    expect(() => materializeDerivedRunMembers(app.state().bays, [entry])).toThrow(/now stands at/)

    // Vanished: no fact at all refuses with the re-push cure.
    const gone = { ...app.state().bays, submits: {} }
    expect(() => materializeDerivedRunMembers(gone, [entry])).toThrow(/no live submit fact/)
    expect(() => doorEntry(app, "issue/never-submitted")).toThrow(/no live submit fact/)

    // Mint failure: commit-before-escape means a broken mint store fails the
    // derivation loudly and mints nothing.
    const broken: PrNumberMint = Object.freeze({
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: PR-number mint store at '/broken/pr-mint.json' is unwritable: EIO")
      },
    })
    await using fresh = await createApp()
    await submitted(fresh, "issue/fresh")
    expect(() => doorEntry(fresh, "issue/fresh", { mint: broken })).toThrow(/PR-number mint store/)

    // A missing Change-Id trailer is NOT a loud edge: the derivation mints a
    // synthetic identity from the submission's stable facts instead of
    // refusing (its own describe below).
    await using bare = await createApp()
    await submitted(bare, "issue/bare")
    const minted = deriveRunMemberArgs({
      bays: bare.state().bays,
      queues: bare.state().queues,
      mint: volatilePrNumberMint(1),
      branch: "issue/bare",
    })
    expect(minted.changeId).toBe(changeIdForDerivedSubmit({ branch: "issue/bare", sha: SHA }))
  })

  it("a derived member is a full member row: id-seam resolution, snapshot-backed run rows, derived-by-design audit accounting", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await submitted(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived")
    await app.queue.run({ derived: [entry] }, runtime)

    // The `pr#N` spelling resolves the same member as the bare id, and both
    // answer from the run's retained snapshot — the member's only home.
    expect(app.queue.resolveMember(`pr#${entry.id.slice(2)}`)).toMatchObject({ source: "snapshot", id: entry.id })
    expect(app.queue.resolveMember(entry.id)).toMatchObject({ source: "snapshot", id: entry.id })
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === entry.id))
    if (record === undefined) throw new Error("expected the derived run")
    // A full member row, not a placeholder: identity, branch, revision and the
    // exact approved sha all present on the snapshot the run retained.
    expect(record.prs[0]).toMatchObject({
      id: entry.id,
      changeId: CHANGE_ID,
      branch: "issue/derived",
      revision: 1,
      headSha: SHA,
    })
  })

  it("a live submit is a runnable derived row served by one selectorless compose, not an unrecorded-submit refusal", async () => {
    // The wiring end to end: a branch + submit ref alone — no derived args, no
    // intake — is derived, admitted, and run by one selectorless compose under
    // the configured mint + enrichment reader, and the "visible, never
    // runnable" refusal row retires once the lane serves the branch.
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
    // Served => the refusal row retires everywhere it rendered.
    expect(app.queue.unrecordedSubmits()).toEqual([])
    const audit = app.queue.audit({ now: "2026-01-02T00:00:00.000Z" })
    expect(audit.findings.filter((finding) => finding.code === "unrecorded-submit")).toEqual([])
    // Not yet served stays visible: a second ref-only branch with no compose
    // between keeps its row — the row is "not picked up", never silence.
    await app.bays.recordBranchSubmit({ branch: "issue/waiting", sha: RESUBMIT_SHA, base: "main" })
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/waiting"])
  })

  it("replay converges over a journal holding recordless terminal events", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let mintedId: string
    {
      await using app = await createApp({ journal, id })
      await submitted(app, "issue/derived")
      const entry = doorEntry(app, "issue/derived")
      mintedId = entry.id
      await app.queue.run({ derived: [entry] }, runtime)
    }
    await using replayed = await createApp({ journal, id })
    const run = Queues.values(replayed.state().queues).find((record) => record.prs.some((pr) => pr.id === mintedId))
    expect(run?.prs[0]).toMatchObject({ id: mintedId, headSha: SHA })
  })
})

describe("derived lane — synthetic change-id mint for trailerless tips", () => {
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
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["task/agent-branch"])

    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The member ran under a well-formed synthetic change id.
    const record = Queues.values(app.state().queues).find((run) =>
      run.prs.some((pr) => pr.branch === "task/agent-branch"),
    )
    expect(record?.prs[0]).toMatchObject({ id: "PR1", revision: 1, headSha: SHA, props: { bead: "23231" } })
    expect(ChangeIdSchema.safeParse(record?.prs[0]?.changeId).success).toBe(true)

    // Served — the refusal row retires, and no compose-derived-refused warn
    // fired for the branch (the old regime's dead end).
    expect(app.queue.unrecordedSubmits()).toEqual([])
    const refused = events.filter(
      (event) => event.kind === "log" && event.level === "warn" && event.props?.action === "compose-derived-refused",
    )
    expect(refused).toEqual([])
  })

  it("the identity is stable across compose passes: the same (branch, tip sha) re-derives the same change id, and a new sha keys a NEW revision of the SAME identity via the retained snapshot", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await submitted(app, "issue/trailerless")
    const synthetic = changeIdForDerivedSubmit({ branch: "issue/trailerless", sha: SHA })
    const mint = volatilePrNumberMint(1)
    const derive = () =>
      deriveRunMemberArgs({ bays: app.state().bays, queues: app.state().queues, mint, branch: "issue/trailerless" })

    // Two derivations of the same push with NO snapshot journaled between
    // them: the CHANGE identity is bit-identical — a pure derivation from
    // stable facts. The number half keeps the mint's crash contract
    // (committed before escape, so an admission that never journals skips a
    // number and can never re-issue one).
    const first = derive()
    const second = derive()
    expect(first.changeId).toBe(synthetic)
    expect(second.changeId).toBe(synthetic)
    expect(first).toMatchObject({ id: "PR2", headSha: SHA })
    expect(second).toMatchObject({ id: "PR3", headSha: SHA })

    // Compose pass 1 journals the run's snapshot — the identity's one durable home.
    await app.queue.run({ derived: [second] }, runtime)

    // The author re-pushes at a NEW sha: compose pass 2 reuses the retained
    // identity — same id, same change id, NOT a re-derivation from the new
    // sha — and continues the revision count: a new revision of the SAME
    // change (branch continuity).
    await app.bays.recordBranchSubmit({ branch: "issue/trailerless", sha: RESUBMIT_SHA, base: "main" })
    const repushed = derive()
    expect(repushed).toMatchObject({ id: "PR3", changeId: synthetic, headSha: RESUBMIT_SHA })
    expect(repushed.revision).toBe(second.revision + 1)
    expect(repushed.changeId).not.toBe(changeIdForDerivedSubmit({ branch: "issue/trailerless", sha: RESUBMIT_SHA }))
    // Reused, never re-minted: the high-water did not move again.
    expect(mint.highWater()).toBe(3)
  })

  it("a Change-Id trailer still wins over the synthetic mint, and a retained snapshot's identity wins over both", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await submitted(app, "issue/derived")
    const synthetic = changeIdForDerivedSubmit({ branch: "issue/derived", sha: SHA })
    const mint = volatilePrNumberMint(1)

    // Trailer present => the trailer IS the identity; the synthetic mint never fires.
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
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/unadmittable"])
  })
})

describe("the retired record mint refuses rather than silently minting (A2)", () => {
  it("bay.intake refuses record-mint-retired and the message names the surviving path", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "issue/facted", sha: SHA, base: "main" })
    const refusal = await app.bays
      .intake({ branch: "issue/facted", headSha: SHA, base: "main", baseSha: BASE })
      .then(() => undefined)
      .catch((error: unknown) => failureFact(error))
    expect(refusal).toMatchObject({ kind: "refusal", code: "record-mint-retired" })
    expect(refusal?.message).toMatch(/refs\/for\/main\/<issue>/)
  })

  it("bay.submit refuses record-mint-retired and the message names the surviving path", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "issue/facted", sha: SHA, base: "main" })
    const refusal = await app.bays
      .submit({ branch: "issue/facted", headSha: SHA, base: "main", baseSha: BASE })
      .then(() => undefined)
      .catch((error: unknown) => failureFact(error))
    expect(refusal).toMatchObject({ kind: "refusal", code: "record-mint-retired" })
    expect(refusal?.message).toMatch(/yrd pr submit/)
  })

  it("a branch with NO submit fact is refused the same way — the mint is retired unconditionally, not conditionally on a fact", async () => {
    // The control for the two above: while the record store existed, these
    // commands refused only for a branch a live submit fact owned, so a
    // factless branch still minted. That fallback is gone, and a test that
    // only ever passed a facted branch could not tell the difference.
    await using app = await createApp()
    const refusal = await app.bays
      .submit({ branch: "issue/legacy", headSha: SHA, base: "main", baseSha: BASE })
      .then(() => undefined)
      .catch((error: unknown) => failureFact(error))
    expect(refusal).toMatchObject({ kind: "refusal", code: "record-mint-retired" })
  })

  it("the refusal code has exactly one spelling across every package source (grep half)", () => {
    const roots = readdirSync(packagesRoot).flatMap((pkg) => {
      const src = join(packagesRoot, pkg, "src")
      return existsSync(src) ? [src] : []
    })
    const spellings = new Set<string>()
    for (const root of roots) {
      for (const entry of readdirSync(root, { recursive: true }) as string[]) {
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue
        const source = readFileSync(join(root, entry), "utf8")
        // Code-SHAPED spellings only. The separator class deliberately excludes
        // a space: refusal codes are kebab-case, so `record mint retired` can
        // only ever be English prose, and matching it made this guard fail on
        // a comment that reads "with the record mint retired" (yrd-cli
        // run.ts) — a false positive that says nothing about the vocabulary.
        for (const match of source.matchAll(/record[-_]?mint[-_]?retired/giu)) spellings.add(match[0])
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
    // walk would pass `originCures` for the wrong reason. The floor was 3 when
    // written; S7 deleted one of the three printed cures with the record-lane
    // surface that printed it, so 2 is the live count (queue.ts's
    // unrecorded-submit resolution and yrd-bay's retired-intake refusal).
    expect(cures.length).toBeGreaterThanOrEqual(2)
    expect(originCures).toEqual([])
  })
})
