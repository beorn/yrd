/**
 * @failure S7 deletes the PR record store, so every status projection that
 * joined run members to `bays.prs` either crashes on the members the store
 * never names (derived members are recordless BY DESIGN; history rows outlive
 * the fed change list's revision retention) or mislabels the live derived
 * population. These fixtures hold the projections to the derived-first
 * contract: identity resolves from a record only while records last, else from
 * the newest retained run snapshot; a missing revision clock is a defined
 * admission-is-the-run state, never a throw; and a pause allow-list member's
 * serveability answers from its live submit fact via the one authority
 * derivation (`derivedAuthorityLookup`), never a second one.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import {
  createBayJobDefs,
  volatilePrNumberMint,
  withBays,
  type BayWorkspace,
  type Change,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  deriveRunMemberArgs,
  materializeDerivedRunMembers,
  queueLogSubmissionTime,
  queuePauseHealth,
  queuePauseWarnings,
  queueRunRevisionClocks,
  queueRunRevisionKey,
  queueTimelineAdmissionTimes,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type DerivedRunMember,
  type IntegrationProof,
  type QueueStatusResult,
  type Run,
  type StepExecution,
} from "@yrd/queue"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const RECORD_RUN_SHA = "1".repeat(40)
const RECORD_LIVE_SHA = "2".repeat(40)
const STRAND_SHA = "9".repeat(40)
const DERIVED_SHA = "7".repeat(40)
const RENEWED_SHA = "8".repeat(40)
const CHANGE_ID = `I${"c".repeat(40)}`
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

/** A strictly ticking clock: consumption and renewal are ordered by comparing
 * a run's start to a fact's projection time, so the fixture needs real
 * before/after — a frozen clock cannot express "re-pushed AFTER the run". */
function tickingClock(): () => string {
  let tick = 0
  return () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ++tick * 1_000).toISOString()
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: RECORD_RUN_SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: RECORD_RUN_SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: RECORD_RUN_SHA, pushed: true, wip: false },
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

async function createApp(mint: ReturnType<typeof volatilePrNumberMint>) {
  const queue = withQueue({
    steps: [passingCheck(), passingMerge()],
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
  } as never as Parameters<typeof withQueue>[0])
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    // ONE mint for both lanes, as in production (one durable pr-mint store):
    // record intake and derived admission share a single monotone sequence.
    withBays({ prNumberMint: mint, jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: tickingClock(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

function recorded(app: App, branch: string): Change {
  const pr = Object.values(app.state().bays.prs).findLast((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr
}

/**
 * The mixed post-door population every status surface must serve at once:
 *
 * - `PR1` — record member, run to integration (`R1`): the legacy arm.
 * - `PR2` — terminal (withdrawn) record stranding `issue/derived`.
 * - `PR3` — DERIVED member of `issue/derived`: recordless by design, minted at
 *   admission, run under `R2`; its only identity home is `R2`'s snapshot.
 * - `PR4` — record member, submitted and never run: the live legacy arm.
 */
async function mixedFixture(): Promise<
  Readonly<{
    app: App
    mint: ReturnType<typeof volatilePrNumberMint>
    entry: DerivedRunMember
    r1: Run
    r2: Run
    result: QueueStatusResult
  }>
> {
  const mint = volatilePrNumberMint()
  const app = await createApp(mint)
  await app.bays.submit({ branch: "issue/record-run", headSha: RECORD_RUN_SHA, base: "main", baseSha: BASE })
  await app.queue.run({ prs: ["PR1"] }, runtime)
  await app.bays.submit({ branch: "issue/derived", headSha: STRAND_SHA, base: "main", baseSha: BASE })
  await app.bays.closePr({ pr: recorded(app, "issue/derived").id, reason: "superseded" })
  await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: DERIVED_SHA, base: "main" })
  const entry = deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint,
    branch: "issue/derived",
    enrichment: { changeId: CHANGE_ID },
  })
  expect(entry).toMatchObject({ id: "PR3", branch: "issue/derived", revision: 2, headSha: DERIVED_SHA })
  await app.queue.run({ derived: [entry] }, runtime)
  // Submitted LAST so neither run's implicit selection sweeps it in: the live,
  // never-run record arm of the mixed population.
  await app.bays.submit({ branch: "issue/record-live", headSha: RECORD_LIVE_SHA, base: "main", baseSha: BASE })
  const summary = app.queue.status("main")
  const r1 = summary.finished.find((run) => run.prs.some((member) => member.id === "PR1"))
  const r2 = summary.finished.find((run) => run.prs.some((member) => member.id === "PR3"))
  if (r1 === undefined || r2 === undefined) throw new Error("expected both the record run and the derived run")
  const result: QueueStatusResult = {
    ...summary,
    prs: Object.values(app.state().bays.prs),
    admissionOrder: [],
  }
  return { app, mint, entry, r1, r2, result }
}

const pauseOf = (allowedPRs: readonly string[]) =>
  ({ base: "main", reason: "hold", allowedPRs, pausedAt: "2026-01-01T00:00:00.000Z" }) as const

describe("queuePauseHealth — derived-first allow-list status", () => {
  it("resolves records from the store and derived members from their retained run snapshot", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const state = app.state()

    // Derived member PR4: its fact was consumed by R2, and the honest status
    // word for a consumed fact (integrated? rejected?) belongs to the
    // run-outcome projection — the tolerant arm answers, never a mislabel.
    const consumed = queuePauseHealth(state.bays, pauseOf(["PR1", "PR4", "PR3", "PR999"]), state.queues)
    expect(consumed.members).toEqual([
      { id: "PR1", status: "integrated" },
      { id: "PR4", status: "submitted" },
      { id: "PR3", status: "unknown" },
      { id: "PR999", status: "unknown" },
    ])
    expect(consumed.blocksAll).toBe(false)

    // A re-push renews the authority (per-push consent): the SAME sha
    // re-projected after R2 makes PR4's fact standing again — the snapshot
    // resolves the id, the fact answers for serveability.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: DERIVED_SHA, base: "main" })
    const renewed = queuePauseHealth(app.state().bays, pauseOf(["PR3"]), app.state().queues)
    expect(renewed.members).toEqual([{ id: "PR3", status: "submitted" }])
  })

  it("blocksAll stays conservative: a terminal record warns, an unknown or serveable member disarms it", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const { result } = fixture
    const state = app.state()

    expect(queuePauseHealth(state.bays, pauseOf(["PR1"]), state.queues).blocksAll).toBe(true)
    expect(queuePauseHealth(state.bays, pauseOf(["PR1", "PR3"]), state.queues).blocksAll).toBe(false)

    const blocked: QueueStatusResult = { ...result, pause: pauseOf(["PR1"]) }
    expect(queuePauseWarnings(state.bays, [blocked], state.queues)).toEqual([
      "[pause-blocks-all] queue 'main' pause blocks every change: all allowed PRs are terminal (PR1 integrated)",
    ])
    const disarmed: QueueStatusResult = { ...result, pause: pauseOf(["PR1", "PR3"]) }
    expect(queuePauseWarnings(state.bays, [disarmed], state.queues)).toEqual([])
  })

  it("without queues the legacy record arm still answers and derived ids tolerate as unknown", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const health = queuePauseHealth(app.state().bays, pauseOf(["PR4", "PR3"]))
    expect(health.members).toEqual([
      { id: "PR4", status: "submitted" },
      { id: "PR3", status: "unknown" },
    ])
  })
})

describe("queueRunRevisionClocks — no clock is a defined state, never corruption", () => {
  it("mints clocks for retained record revisions, skips derived members, and never throws over the store feed", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const { r1, r2 } = fixture
    const clocks = queueRunRevisionClocks(Object.values(app.state().bays.prs), [r1, r2])

    const r1Member = r1.prs[0]
    const r2Member = r2.prs[0]
    if (r1Member === undefined || r2Member === undefined) throw new Error("expected run members")
    expect(clocks.get(queueRunRevisionKey(r1, r1Member))).toMatchObject({ pr: "PR1", admittedBy: "submission" })
    // The derived member is recordless BY DESIGN: no clock, and no throw —
    // pre-S7 this same absence was ruled tolerable only by a record-membership
    // test; post-purge it is simply the defined admission-is-the-run state.
    expect(clocks.get(queueRunRevisionKey(r2, r2Member))).toBeUndefined()
  })

  it("a materialized derived member clocks its own run, and one at a later revision skips instead of throwing", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const { entry, r2 } = fixture
    const r2Member = r2.prs[0]
    if (r2Member === undefined) throw new Error("expected the derived run member")

    // Materialized at the run's own revision: the snapshot-fed change list
    // CAN clock a derived member — its submit fact is the submission.
    const current = materializeDerivedRunMembers(app.state().bays, [entry])
    const clocked = queueRunRevisionClocks(current, [r2])
    expect(clocked.get(queueRunRevisionKey(r2, r2Member))).toMatchObject({ pr: "PR3", admittedBy: "submission" })

    // Re-push at a NEW sha, re-derive: the branch's identity continues (same
    // id, next revision), so the materialized value no longer retains R2's
    // pinned revision — the projection skips that run instead of throwing.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RENEWED_SHA, base: "main" })
    const renewed = deriveRunMemberArgs({
      bays: app.state().bays,
      queues: app.state().queues,
      mint: fixture.mint,
      branch: "issue/derived",
    })
    expect(renewed).toMatchObject({ id: "PR3", revision: 3, headSha: RENEWED_SHA })
    const stale = materializeDerivedRunMembers(app.state().bays, [renewed])
    const skipped = queueRunRevisionClocks(stale, [r2])
    expect(skipped.get(queueRunRevisionKey(r2, r2Member))).toBeUndefined()
  })
})

describe("queueTimelineAdmissionTimes — derived and history rows admit from the run itself", () => {
  it("dates record members from their revision clock and derived members null, without throwing", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const { r1, r2, result } = fixture
    const r1Member = r1.prs[0]
    const r2Member = r2.prs[0]
    if (r1Member === undefined || r2Member === undefined) throw new Error("expected run members")

    const times = queueTimelineAdmissionTimes([result])
    const submitted = times.get(queueRunRevisionKey(r1, r1Member))
    expect(typeof submitted).toBe("string")
    // The derived member's row EXISTS (the timeline renders it) and reads
    // null — the run is the admission — where the record-era code threw.
    expect(times.has(queueRunRevisionKey(r2, r2Member))).toBe(true)
    expect(times.get(queueRunRevisionKey(r2, r2Member))).toBeNull()
  })

  it("a listed change that no longer retains the run's pinned revision falls back instead of throwing", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const { r2, result } = fixture
    const r2Member = r2.prs[0]
    if (r2Member === undefined) throw new Error("expected the derived run member")

    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RENEWED_SHA, base: "main" })
    const renewed = deriveRunMemberArgs({
      bays: app.state().bays,
      queues: app.state().queues,
      mint: fixture.mint,
      branch: "issue/derived",
    })
    const materialized = materializeDerivedRunMembers(app.state().bays, [renewed])
    const fed: QueueStatusResult = { ...result, prs: [...result.prs, ...materialized] }
    const times = queueTimelineAdmissionTimes([fed])
    // PR3 is now LISTED (a materialized member at revision 3), while R2
    // pinned revision 2: the projection must not treat the miss as
    // corruption. The change-level submit time post-dates R2's start, so the
    // causal fallback answers null.
    expect(times.get(queueRunRevisionKey(r2, r2Member))).toBeNull()
  })
})

describe("queueLogSubmissionTime — the record-membership throw is retired", () => {
  it("a missing clock reads undefined even for ids the caller lists as records", async () => {
    const fixture = await mixedFixture()
    await using app = fixture.app
    const { r1, r2 } = fixture
    const r1Member = r1.prs[0]
    const r2Member = r2.prs[0]
    if (r1Member === undefined || r2Member === undefined) throw new Error("expected run members")
    const clocks = queueRunRevisionClocks(Object.values(app.state().bays.prs), [r1, r2])

    expect(typeof queueLogSubmissionTime(clocks, r1, r1Member)).toBe("string")
    // The exact input that used to throw: a clock miss for an id the caller's
    // record set names. Post-purge that set can only describe the FED list —
    // materialized members and history projections — so membership no longer
    // implies a clock, and the miss is a defined no-submission-time state.
    expect(queueLogSubmissionTime(clocks, r2, r2Member, new Set([r2Member.id]))).toBeUndefined()
    expect(queueLogSubmissionTime(clocks, r2, r2Member)).toBeUndefined()
  })
})
