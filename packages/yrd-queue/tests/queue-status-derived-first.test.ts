/**
 * @failure S7 deletes the PR record store, so every status projection that
 * joined run members to `bays.prs` either crashes on the members the store
 * never names (derived members are recordless BY DESIGN; history rows outlive
 * the fed change list's revision retention) or mislabels the live derived
 * population. These fixtures hold the projections to the derived-first
 * contract: identity resolves from the newest retained run snapshot; a missing
 * revision clock is a defined admission-is-the-run state, never a throw; and a
 * pause allow-list member's serveability answers from its live submit fact via
 * the one authority derivation (`derivedAuthorityLookup`), never a second one.
 *
 * S7 conversion note (branch-is-change, @i/10 22991): every member here is now
 * derived. `bays.submit` refuses `record-mint-retired` and `closePr` is gone,
 * so the record arm each test contrasted against cannot be built, and with it
 * go two legs: identity resolving from the store "while records last", and the
 * never-run LIVE member (a derived member with no run snapshot has no identity
 * home at all, so no id can list it — that is the design, not a gap).
 *
 * The `blocksAll` test below is RED against a live src defect and must not be
 * softened to match it: `pauseMemberStatus` (queue-status-projection.ts:246)
 * returns only "submitted" or "unknown" for a derived member, so `blocksAll`
 * (line 259) can never arm and the `[pause-blocks-all]` warning is unreachable.
 * A consumed fact is terminal — the settlement emitted the member's terminal —
 * and a settled run's member must read THAT. Asserting the weaker behaviour
 * would fence in a safety conservatism that still reads as protection while
 * being unable to fire.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace } from "@yrd/bay"
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
const RAN_SHA = "1".repeat(40)
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
      output: { path: `/repo/.bays/${input.bay}`, headSha: RAN_SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: RAN_SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: RAN_SHA, pushed: true, wip: false },
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
    // The mint now belongs to the queue alone: derived admission is the only
    // minter left, so the single monotone sequence lives where it is spent.
    prNumberMint: mint,
  } as never as Parameters<typeof withQueue>[0])
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
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

/**
 * The post-cutover population every status surface must serve. Both members are
 * derived — `bays.submit` refuses `record-mint-retired`, so there is no second
 * lane left to contrast against:
 *
 * - `PR1` — derived member of `issue/ran`, composed selectorlessly and run to
 *   integration under `R1`. Its submit fact is CONSUMED by that settled run.
 * - `PR2` — derived member of `issue/derived`, named explicitly so its identity
 *   and Change-Id are pinned; run under `R2`. Recordless by design: its only
 *   identity home is `R2`'s retained snapshot.
 */
async function derivedFixture(): Promise<
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
  await app.bays.recordBranchSubmit({ branch: "issue/ran", sha: RAN_SHA, base: "main" })
  await app.queue.run({}, runtime)
  await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: DERIVED_SHA, base: "main" })
  const entry = deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint,
    branch: "issue/derived",
    enrichment: { changeId: CHANGE_ID },
  })
  expect(entry).toMatchObject({ id: "PR2", branch: "issue/derived", revision: 1, headSha: DERIVED_SHA })
  await app.queue.run({ derived: [entry] }, runtime)
  const summary = app.queue.status("main")
  const r1 = summary.finished.find((run) => run.prs.some((member) => member.id === "PR1"))
  const r2 = summary.finished.find((run) => run.prs.some((member) => member.id === "PR2"))
  if (r1 === undefined || r2 === undefined) throw new Error("expected both derived runs")
  const result: QueueStatusResult = {
    ...summary,
    // The fed change list is materialized members now, never a store dump.
    prs: materializeDerivedRunMembers(app.state().bays, [entry]),
    admissionOrder: [],
  }
  return { app, mint, entry, r1, r2, result }
}

const pauseOf = (allowedPRs: readonly string[]) =>
  ({ base: "main", reason: "hold", allowedPRs, pausedAt: "2026-01-01T00:00:00.000Z" }) as const

describe("queuePauseHealth — derived-first allow-list status", () => {
  it("resolves every derived member from its retained run snapshot, and serveability from the live fact", async () => {
    const fixture = await derivedFixture()
    await using app = fixture.app
    const state = app.state()

    // Both members' facts were consumed by their settled runs. A consumed fact
    // is TERMINAL — the settlement emitted the member's terminal, and that is
    // the status a settled run's member must read.
    //
    // RED against the same src defect as the `blocksAll` test below, and
    // deliberately so: `pauseMemberStatus` (queue-status-projection.ts:246)
    // collapses a consumed fact to "unknown" instead of the emitted terminal.
    const consumed = queuePauseHealth(state.bays, pauseOf(["PR1", "PR2", "PR999"]), state.queues)
    expect(consumed.members).toEqual([
      { id: "PR1", status: "integrated" },
      { id: "PR2", status: "integrated" },
      { id: "PR999", status: "unknown" },
    ])

    // A re-push renews the authority (per-push consent): the SAME sha
    // re-projected after R2 makes PR2's fact standing again — the snapshot
    // resolves the id, the fact answers for serveability.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: DERIVED_SHA, base: "main" })
    const renewed = queuePauseHealth(app.state().bays, pauseOf(["PR2"]), app.state().queues)
    expect(renewed.members).toEqual([{ id: "PR2", status: "submitted" }])
  })

  it("blocksAll stays conservative: an all-terminal allow-list warns, a serveable or unknown member disarms it", async () => {
    // RED against a known src defect, deliberately — not decay, and not to be
    // softened to match current behaviour. `pauseMemberStatus`
    // (queue-status-projection.ts:246) returns only "submitted" or "unknown"
    // for a derived member, so `blocksAll` (line 259) can never arm and the
    // operator warning for a pause that blocks every change is unreachable.
    // CORRECT behaviour, which this test asserts: a fact consumed by a settled
    // run is terminal — the settlement emitted that member's terminal — so a
    // settled run's member must read "integrated", not "unknown".
    const fixture = await derivedFixture()
    await using app = fixture.app
    const { result } = fixture
    const state = app.state()

    // Every allowed member is terminal, so the pause really does block every
    // change and must say so. This is the conservatism the surface exists for.
    expect(queuePauseHealth(state.bays, pauseOf(["PR1"]), state.queues).blocksAll).toBe(true)
    // An id nothing resolves is not evidence of terminality: it disarms.
    expect(queuePauseHealth(state.bays, pauseOf(["PR1", "PR999"]), state.queues).blocksAll).toBe(false)

    const blocked: QueueStatusResult = { ...result, pause: pauseOf(["PR1"]) }
    expect(queuePauseWarnings(state.bays, [blocked], state.queues)).toEqual([
      "[pause-blocks-all] queue 'main' pause blocks every change: all allowed PRs are terminal (PR1 integrated)",
    ])

    // A member whose fact was renewed after its run is serveable again, so the
    // pause no longer blocks everything.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: DERIVED_SHA, base: "main" })
    const renewedState = app.state()
    expect(queuePauseHealth(renewedState.bays, pauseOf(["PR1", "PR2"]), renewedState.queues).blocksAll).toBe(false)
    const disarmed: QueueStatusResult = { ...result, pause: pauseOf(["PR1", "PR2"]) }
    expect(queuePauseWarnings(renewedState.bays, [disarmed], renewedState.queues)).toEqual([])
  })
})

describe("queueRunRevisionClocks — no clock is a defined state, never corruption", () => {
  it("a run whose members the fed list does not name yields no clock, and never throws", async () => {
    const fixture = await derivedFixture()
    await using app = fixture.app
    const { r1, r2 } = fixture
    // The post-purge fed list is whatever the caller materialized, and it can
    // legitimately name neither run's member. Pre-S7 this same absence was
    // ruled tolerable only by a record-membership test; post-purge it is simply
    // the defined admission-is-the-run state.
    const clocks = queueRunRevisionClocks([], [r1, r2])
    const r1Member = r1.prs[0]
    const r2Member = r2.prs[0]
    if (r1Member === undefined || r2Member === undefined) throw new Error("expected run members")
    expect(clocks.get(queueRunRevisionKey(r1, r1Member))).toBeUndefined()
    expect(clocks.get(queueRunRevisionKey(r2, r2Member))).toBeUndefined()
    expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: DERIVED_SHA })
  })

  it("a materialized derived member clocks its own run, and one at a later revision skips instead of throwing", async () => {
    const fixture = await derivedFixture()
    await using app = fixture.app
    const { entry, r2 } = fixture
    const r2Member = r2.prs[0]
    if (r2Member === undefined) throw new Error("expected the derived run member")

    // Materialized at the run's own revision: the snapshot-fed change list
    // CAN clock a derived member — its submit fact is the submission.
    const current = materializeDerivedRunMembers(app.state().bays, [entry])
    const clocked = queueRunRevisionClocks(current, [r2])
    expect(clocked.get(queueRunRevisionKey(r2, r2Member))).toMatchObject({ pr: "PR2", admittedBy: "submission" })

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
    expect(renewed).toMatchObject({ id: "PR2", revision: 2, headSha: RENEWED_SHA })
    const stale = materializeDerivedRunMembers(app.state().bays, [renewed])
    const skipped = queueRunRevisionClocks(stale, [r2])
    expect(skipped.get(queueRunRevisionKey(r2, r2Member))).toBeUndefined()
  })
})

describe("queueTimelineAdmissionTimes — derived and history rows admit from the run itself", () => {
  it("dates a listed derived member from its own clock and an unlisted run member null, without throwing", async () => {
    const fixture = await derivedFixture()
    await using app = fixture.app
    const { r1, r2, result } = fixture
    const r1Member = r1.prs[0]
    const r2Member = r2.prs[0]
    if (r1Member === undefined || r2Member === undefined) throw new Error("expected run members")

    const times = queueTimelineAdmissionTimes([result])
    // PR2 is the one member the fed list names, so it dates from its own clock.
    expect(typeof times.get(queueRunRevisionKey(r2, r2Member))).toBe("string")
    // R1's member is not in the fed list. Its row EXISTS (the timeline renders
    // it) and reads null — the run is the admission — where the record-era
    // code threw.
    expect(times.has(queueRunRevisionKey(r1, r1Member))).toBe(true)
    expect(times.get(queueRunRevisionKey(r1, r1Member))).toBeNull()
  })

  it("a listed change that no longer retains the run's pinned revision falls back instead of throwing", async () => {
    const fixture = await derivedFixture()
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
    const fed: QueueStatusResult = { ...result, prs: materialized }
    const times = queueTimelineAdmissionTimes([fed])
    // PR2 is now LISTED at revision 2, while R2 pinned revision 1: the
    // projection must not treat the miss as corruption. The change-level submit
    // time post-dates R2's start, so the causal fallback answers null.
    expect(times.get(queueRunRevisionKey(r2, r2Member))).toBeNull()
  })
})

describe("queueLogSubmissionTime — the record-membership throw is retired", () => {
  it("a missing clock reads undefined even for ids the caller lists as records", async () => {
    const fixture = await derivedFixture()
    await using app = fixture.app
    const { entry, r1, r2 } = fixture
    const r1Member = r1.prs[0]
    const r2Member = r2.prs[0]
    if (r1Member === undefined || r2Member === undefined) throw new Error("expected run members")
    // Fed with PR2 only, so R2's member clocks and R1's cannot.
    const clocks = queueRunRevisionClocks(materializeDerivedRunMembers(app.state().bays, [entry]), [r1, r2])

    expect(typeof queueLogSubmissionTime(clocks, r2, r2Member)).toBe("string")
    // The exact input that used to throw: a clock miss for an id the caller's
    // record set names. Post-purge that set can only describe the FED list —
    // materialized members and history projections — so membership no longer
    // implies a clock, and the miss is a defined no-submission-time state.
    expect(queueLogSubmissionTime(clocks, r1, r1Member, new Set([r1Member.id]))).toBeUndefined()
    expect(queueLogSubmissionTime(clocks, r1, r1Member)).toBeUndefined()
  })
})
