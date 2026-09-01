/**
 * @failure `timelineRunMemberRows` measured a run member's AGE from
 * `lineage.sourceReadyAt` — `changeSourceReadyAt`, the lineage ROOT's
 * `submittedAt` — in preference to the run-scoped admission clock
 * `runRevisionClockRead` had just resolved beside it, then subtracted that
 * from THIS run's own `finishedAt`. The lineage clock is mutable: re-submitting
 * the same sha (the documented remedy when a run consumes a change's submit
 * authority) rewrites it FORWARD, past runs that finished days earlier. So a
 * LATER admission dated an EARLIER run, `elapsedMs` threw on the inversion, and
 * the throw escaped the whole projection — `yrd watch` printed its dead-man
 * lines and died, taking every healthy row with it.
 *
 * Measured live 2026-09-01 by the operator on yrd 0.0.1+caacf98e21:
 *
 *   yrd watch --repo dev
 *   error: change 'PR2749' source-ready age finish '2026-08-30T22:56:44.041Z'
 *          precedes start '2026-09-01T18:40:25.870Z'
 *
 * PR2749 (branch task/w28-silentsites, sha b3e5141d, derived lane) had checks
 * that passed on 2026-08-30 under a run that later settled against the now-dead
 * run R3675; at 2026-09-01T18:40Z the same sha was re-submitted, refreshing both
 * its submit fact and its check request past that dead run. `runRevisionClockRead`
 * then correctly found NO causal clock at or before the run's start and returned
 * a `no-causal-clock` fault — the row was already marked `unreadable` — but the
 * age arithmetic ran anyway, on the unscoped lineage clock, and aborted.
 * @level l2
 * @consumer @yrd/cli every `yrd watch` / `yrd queue list` operator
 *
 * WHAT IS PINNED. Two rules, in order.
 *
 * 1. SCOPE. A member's age starts at the admission that CAUSED THIS RUN. A
 *    cumulative lineage anchor is kept only while it is still causal for this
 *    run (at or before the run-scoped clock, which is what "cumulative" already
 *    asserts); a read that faulted has no causal clock here at all and reads as
 *    pending rather than borrowing a later admission's number. The cumulative
 *    source-ready age that {@link ../src/queue-status-view.tsx} exists to show
 *    is UNCHANGED wherever the record has not been refreshed past the run.
 *
 * 2. CONTAINMENT. Any residual inconsistency marks its own row `unreadable`
 *    with the verbatim cause plus a remedy and keeps the projection rendering
 *    (the e78134986 idiom). `--strict` restores the historical abort, matching
 *    `yrd log --strict` ({@link ./reader-log-lister-lane-fault-gate.test.ts}).
 */
import { describe, expect, it } from "vitest"
import type { Change } from "@yrd/bay"
import { elapsedMs } from "@yrd/queue"

import { queueRunRevisionKey, queueTimelineProjection, type QueueStatusResult } from "../src/queue-status-view.tsx"

type Run = QueueStatusResult["finished"][number]

const CHANGE = "PR2749"
/** A DERIVED member: a live submit fact on a branch with no `Change` record,
 * so `result.prs` never holds it (`isDerivedMemberId`). Nothing scopes its
 * clock to a run, which is why containment — not scoping — is what covers it. */
const DERIVED_CHANGE = "PR2750"
const DERIVED_RUN_ID = "R3676"
const HEAD = `b3e5141d${"0".repeat(32)}`
const BASE_SHA = "a".repeat(40)
const RUN_ID = "R3675"

/** The live specimen's own clocks. */
const PUSHED_AT = "2026-08-30T21:00:00.000Z"
const RUN_STARTED_AT = "2026-08-30T22:30:00.000Z"
/** The finish the operator's error names. */
const RUN_FINISHED_AT = "2026-08-30T22:56:44.041Z"
/** The start the operator's error names: the re-submission, two days later. */
const RESUBMITTED_AT = "2026-09-01T18:40:25.870Z"
const NOW = Date.parse("2026-09-01T19:00:00.000Z")

/** The exact text `yrd watch` died with. */
const SPECIMEN = `change '${CHANGE}' source-ready age finish '${RUN_FINISHED_AT}' precedes start '${RESUBMITTED_AT}'`

const MEMBER = {
  id: CHANGE,
  branch: "task/w28-silentsites",
  base: "main",
  revision: 1,
  headSha: HEAD,
  baseSha: BASE_SHA,
} as const

function run(): Run {
  return {
    id: RUN_ID,
    queueId: "Q:main",
    candidateId: `C:${RUN_ID}`,
    base: "main",
    prs: [MEMBER],
    jobs: [],
    steps: [],
    startedAt: RUN_STARTED_AT,
    finishedAt: RUN_FINISHED_AT,
    cursor: 0,
    shape: { results: {} },
    status: "completed",
    conclusion: "success",
  } as unknown as Run
}

/**
 * The change as the record store holds it after the re-submission: one retained
 * revision whose submit fact AND whose check request both now postdate the run
 * that already finished against it. Nothing else about the record moved.
 */
function resubmittedChange(): Change {
  return {
    id: CHANGE,
    branch: "task/w28-silentsites",
    base: "main",
    state: "open",
    merged: false,
    revs: [{ n: 1, head: HEAD, base: "main", baseSha: BASE_SHA, pushedAt: PUSHED_AT, submittedAt: RESUBMITTED_AT }],
    reviews: [],
    comments: [],
    checkRequests: [{ revision: 1, headSha: HEAD, baseSha: BASE_SHA, at: RESUBMITTED_AT }],
    submittedAt: RESUBMITTED_AT,
  }
}

/** The same record BEFORE the re-submission — the control. Its clocks are
 * causal for the run, so nothing about this row may change. */
function healthyChange(): Change {
  const submittedAt = "2026-08-30T22:00:00.000Z"
  return {
    ...resubmittedChange(),
    revs: [{ n: 1, head: HEAD, base: "main", baseSha: BASE_SHA, pushedAt: PUSHED_AT, submittedAt }],
    checkRequests: [{ revision: 1, headSha: HEAD, baseSha: BASE_SHA, at: submittedAt }],
    submittedAt,
  }
}

const DERIVED_MEMBER = { ...MEMBER, id: DERIVED_CHANGE, branch: "task/w28-derived" } as const

/** The run carrying the derived member, finishing before that member's only
 * available clock. */
function derivedRun(): Run {
  return { ...run(), id: DERIVED_RUN_ID, candidateId: `C:${DERIVED_RUN_ID}`, prs: [DERIVED_MEMBER] } as Run
}

function resultOf(pr: Change, runs: readonly Run[] = [run()]): QueueStatusResult {
  return { base: "main", prs: [pr], admissionOrder: [CHANGE], running: [], waiting: [], finished: [...runs] }
}

function project(
  pr: Change,
  strict = false,
  runs: readonly Run[] = [run()],
  submissionTimes: ReadonlyMap<string, string | null> = new Map(),
) {
  return queueTimelineProjection([resultOf(pr, runs)], {
    now: NOW,
    windowMs: 100 * 365 * 24 * 60 * 60 * 1_000,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 50,
    submissionTimes,
    ...(strict ? { strict: true } : {}),
  })
}

/**
 * The RESIDUAL case the scope rule cannot reach: a derived member has no
 * record, so there is no run-scoped admission clock to fall back to — only the
 * admission time the caller supplies, which here postdates the run's finish.
 */
function projectDerived(strict = false) {
  return project(healthyChange(), strict, [run(), derivedRun()], new Map([
    [queueRunRevisionKey(derivedRun(), DERIVED_MEMBER), RESUBMITTED_AT],
  ]))
}

describe("reader watch source-ready-age gate — a refreshed submit fact never blinds `yrd watch`", () => {
  it("renders the row instead of aborting the projection", () => {
    let projection: ReturnType<typeof project> | undefined
    expect(() => {
      projection = project(resubmittedChange())
    }).not.toThrow()

    const row = projection?.rows.find((candidate) => candidate.run === RUN_ID)
    expect(row?.pr).toBe(CHANGE)
    // The honest reading: no admission of THIS run dates this member.
    expect(row?.ageMs).toBeNull()
    expect(row?.sourceReadyAt).toBeUndefined()
  })

  it("marks the row unreadable, names the cause verbatim, and reports it on the projection", () => {
    const projection = project(resubmittedChange())
    const row = projection.rows.find((candidate) => candidate.run === RUN_ID)

    expect(row?.unreadable?.run).toBe(RUN_ID)
    expect(row?.unreadable?.change).toBe(CHANGE)
    expect(row?.unreadable?.headSha).toBe(HEAD)
    expect(row?.unreadable?.reason).toBe("no-causal-clock")
    expect(row?.detail).toContain("unreadable: no-causal-clock")
    // Reported to the caller too, never only on the row.
    expect(projection.readFaults).toHaveLength(1)
    expect(projection.readFaults[0]).toMatchObject({ run: RUN_ID, change: CHANGE, reason: "no-causal-clock" })
  })

  /**
   * The reproduction itself. The fixture's two clocks ARE the operator's two
   * clocks, and pairing them still produces the operator's message verbatim —
   * so this pins both the fixture's fidelity and the message shape, while the
   * tests above pin that the projection no longer pairs them.
   */
  it("the fixture's clocks are the operator's clocks, and still yield that exact text when paired", () => {
    expect(() => elapsedMs(RESUBMITTED_AT, RUN_FINISHED_AT, `change '${CHANGE}' source-ready age`)).toThrow(SPECIMEN)
    const pr = resubmittedChange()
    expect(pr.revs[0]?.submittedAt).toBe(RESUBMITTED_AT)
    expect(run().finishedAt).toBe(RUN_FINISHED_AT)
  })

  it("`--strict` does not resurrect the abort — the scope rule removed the inversion, it did not hide it", () => {
    expect(() => project(resubmittedChange(), true)).not.toThrow()
  })

  it("contains a RESIDUAL inversion no scope rule can reach, and names its remedy", () => {
    let projection: ReturnType<typeof projectDerived> | undefined
    expect(() => {
      projection = projectDerived()
    }).not.toThrow()

    const row = projection?.rows.find((candidate) => candidate.run === DERIVED_RUN_ID)
    expect(row?.pr).toBe(DERIVED_CHANGE)
    expect(row?.ageMs).toBeNull()
    expect(row?.unreadable?.reason).toBe("no-causal-clock")
    expect(row?.detail).toContain("unreadable: no-causal-clock")

    const message = row?.unreadable?.message ?? ""
    // The verbatim cause, not a paraphrase. The AGE is scoped away by
    // `currentAdmissionFinish` — a finish belonging to an earlier admission is
    // a known, legal state. The QUEUE WAIT is deliberately NOT scoped: it
    // measures how long this member waited before this run STARTED, so a
    // submit clock after that start means the run record and the submission
    // times disagree about what admitted this member. That is not a legal
    // state with an honest reading, so it is marked rather than nulled.
    expect(message).toContain(
      `change '${DERIVED_CHANGE}' queue wait finish '${RUN_STARTED_AT}' precedes start '${RESUBMITTED_AT}'`,
    )
    // …plus the remedy that would have saved the reader.
    expect(message).toContain(`no admission of run '${DERIVED_RUN_ID}' can date this member`)
    expect(message).toContain(`yrd log --pr ${DERIVED_CHANGE}`)
    expect(message).toContain("--strict")

    // The healthy sibling row still projects — one bad member never blinds it.
    expect(projection?.rows.some((candidate) => candidate.run === RUN_ID)).toBe(true)
  })

  it("`--strict` still fails LOUD on that residual inversion", () => {
    expect(() => projectDerived(true)).toThrow(
      `change '${DERIVED_CHANGE}' queue wait finish '${RUN_STARTED_AT}' precedes start '${RESUBMITTED_AT}'`,
    )
  })

  it("the member's AGE is scoped to pending rather than marked — the two rules do different jobs", () => {
    const row = projectDerived().rows.find((candidate) => candidate.run === DERIVED_RUN_ID)
    expect(row?.ageMs).toBeNull()
    expect(row?.queueWaitMs).toBeNull()
  })

  it("a record whose clocks are causal for the run is untouched — age, anchor and no mark", () => {
    const projection = project(healthyChange())
    const row = projection.rows.find((candidate) => candidate.run === RUN_ID)

    expect(row?.unreadable).toBeUndefined()
    expect(projection.readFaults).toEqual([])
    expect(row?.sourceReadyAt).toBe("2026-08-30T22:00:00.000Z")
    expect(row?.ageMs).toBe(Date.parse(RUN_FINISHED_AT) - Date.parse("2026-08-30T22:00:00.000Z"))
    // …and `--strict` changes nothing about a healthy read.
    expect(project(healthyChange(), true).rows).toEqual(projection.rows)
  })
})
