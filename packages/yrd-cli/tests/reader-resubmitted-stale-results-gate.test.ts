/**
 * @failure A change re-submitted over stale results — the documented remedy
 * when a run consumes a change's submit authority — leaves a revision whose
 * `submittedAt` was rewritten FORWARD past the terminal fact, and the check
 * results behind it, that an earlier settle left in place. Every projection
 * that measured an age from that submit start to that stale finish computed a
 * NEGATIVE duration and threw, and the throw escaped the whole read.
 *
 * Measured live 2026-09-01 on yrd 0.0.1+caacf98e21, change 'PR2749'
 * (task/w28-silentsites, sha b3e5141d) re-submitted at 18:40:25Z over a
 * 2026-08-30T22:56Z settle against the now-dead run R3675:
 *
 *   yrd watch --repo dev   -> died: "change 'PR2749' source-ready age
 *                             finish '2026-08-30T22:56:44.041Z' precedes
 *                             start '2026-09-01T18:40:25.870Z'"
 *   yrd pr list --json     -> exit 3, EMPTY stdout for all 2275 rows:
 *                             "submitted-to-terminal age finish
 *                             '2026-08-30T22:56:51Z' precedes start
 *                             '2026-09-01T18:40:25Z'"
 *   yrd queue list         -> survived only because its 20-row text window
 *                             never reached that row.
 *
 * `yrd pr list --json` fell over on the HUMAN projection: `listPrs` builds
 * `changeListRows(...)` eagerly as a call argument, so the machine-readable
 * path evaluates it even when it will never render it.
 * @level l2
 * @consumer @yrd/cli every `yrd watch`, `yrd pr list` and `yrd queue list` operator
 *
 * WHAT IS PINNED. One rule, applied at every surface: a finish that precedes
 * its own start belongs to a PREVIOUS admission of the same sha, so the
 * current admission has no finish yet and the change reads PENDING — never a
 * negative age, and never an abort. `currentAdmissionFinish` is the single
 * home for that judgement; the per-row containment behind it is pinned by
 * {@link ./reader-watch-source-ready-age-gate.test.ts}.
 */
import { describe, expect, it } from "vitest"
import type { Change } from "@yrd/bay"
import type { BaysState } from "@yrd/bay"
import { currentAdmissionFinish, type ChangeEligibility } from "@yrd/queue"

import {
  changeListRows,
  humanQueueProjection,
  queueTimelineProjection,
  type QueueStatusResult,
} from "../src/queue-status-view.tsx"

type Run = QueueStatusResult["finished"][number]

const CHANGE = "PR2749"
const HEAD = `b3e5141d${"0".repeat(32)}`
const BASE_SHA = "a".repeat(40)
const PUSHED_AT = "2026-08-30T21:00:00.000Z"
/** The stale settle the dead run R3675 left behind. */
const TERMINAL_AT = "2026-08-30T22:56:51.000Z"
/** The re-submission that rewrote the submit fact forward past it. */
const RESUBMITTED_AT = "2026-09-01T18:40:25.870Z"
const NOW = Date.parse("2026-09-01T19:00:00.000Z")
const NO_BAYS: BaysState = { byId: {}, prs: {}, receipts: {}, submits: {} }

/** The record exactly as the re-submission leaves it. */
function resubmitted(): Change {
  return {
    id: CHANGE,
    name: "silent sites",
    branch: "task/w28-silentsites",
    base: "main",
    state: "open",
    merged: false,
    revs: [
      {
        n: 1,
        head: HEAD,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: PUSHED_AT,
        submittedAt: RESUBMITTED_AT,
        submitter: "author@example.test",
        terminal: { kind: "canceled", at: TERMINAL_AT, run: "R3675" },
      },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
    submittedAt: RESUBMITTED_AT,
  }
}

const ELIGIBILITY: ChangeEligibility = {
  pr: CHANGE,
  revision: 1,
  runnable: true,
  review: { required: false, approved: true, stale: false },
  checks: { status: "not-requested" },
}

function result(): QueueStatusResult {
  return {
    base: "main",
    prs: [resubmitted()],
    admissionOrder: [CHANGE],
    running: [],
    waiting: [],
    finished: [],
    eligibilities: [ELIGIBILITY],
  }
}

describe("reader resubmitted-stale-results gate — one rule, every listing", () => {
  it("the scoping helper is the single home for the judgement", () => {
    // A finish before its start belongs to a previous admission: no finish yet.
    expect(currentAdmissionFinish(RESUBMITTED_AT, TERMINAL_AT)).toBeUndefined()
    // A finish after its start is this admission's, and passes through.
    expect(currentAdmissionFinish(PUSHED_AT, TERMINAL_AT)).toBe(TERMINAL_AT)
    // Nothing to scope against, or nothing to scope: unchanged.
    expect(currentAdmissionFinish(undefined, TERMINAL_AT)).toBe(TERMINAL_AT)
    expect(currentAdmissionFinish(RESUBMITTED_AT, undefined)).toBeUndefined()
    // An unparseable clock is a DIFFERENT defect and is not swallowed here.
    expect(currentAdmissionFinish("not-a-date", TERMINAL_AT)).toBe(TERMINAL_AT)
  })

  it("`yrd watch` renders the row and reads it as pending", () => {
    let projection: ReturnType<typeof queueTimelineProjection> | undefined
    expect(() => {
      projection = queueTimelineProjection([result()], {
        now: NOW,
        windowMs: 100 * 365 * 24 * 60 * 60 * 1_000,
        statuses: ["pending", "running", "rejected", "integrated", "other"],
        terms: [],
        latest: false,
        rowLimit: 50,
        submissionTimes: new Map(),
      })
    }).not.toThrow()

    const row = projection?.rows.find((candidate) => candidate.pr === CHANGE)
    expect(row).toBeDefined()
    // Pending, and aged from the RE-SUBMISSION — not from the stale settle.
    expect(row?.status).toBe("ready")
    expect(row?.ageMs).toBe(NOW - Date.parse(RESUBMITTED_AT))
    expect(projection?.readFaults).toEqual([])
  })

  it("`yrd pr list` renders the row and reads it as pending", () => {
    let rows: ReturnType<typeof changeListRows> | undefined
    expect(() => {
      rows = changeListRows([{ pr: resubmitted(), eligibility: ELIGIBILITY }], [], NOW)
    }).not.toThrow()

    expect(rows).toHaveLength(1)
    const row = rows?.[0]
    expect(row?.pr).toBe(CHANGE)
    // Not the containment row — the scoping rule resolved this one cleanly.
    expect(row?.state).not.toBe("unreadable")
    expect(row?.why).not.toBe("clock-unreadable")
    // A real age measured forward from the re-submission, never "-".
    expect(row?.age).not.toBe("-")
  })

  it("`yrd queue list` renders the row and reads it as pending", () => {
    let projection: ReturnType<typeof humanQueueProjection> | undefined
    expect(() => {
      projection = humanQueueProjection(result(), NOW, { state: NO_BAYS })
    }).not.toThrow()

    // The change is OPEN queue work, not a terminal row in `recent`.
    expect(projection?.queue.map((row) => row.pr)).toEqual([CHANGE])
    expect(projection?.recent.map((row) => row.pr)).toEqual([])
    const row = projection?.queue[0]
    expect(row?.nativeStatus).toBe("submitted")
    expect(row?.state).not.toBe("unreadable")
    expect(row?.age).not.toBe("-")
  })

  /**
   * The variant that used to escape the reader rule, now closed at its source.
   * `changeDeliveryState` read `revision.terminal?.kind === "rejected"` straight
   * off the raw record, so a late REJECTED settle made the change report
   * `rejected` while the re-submission had already cleared `pr.rejectedAt`, and
   * `currentTerminalFact` then refused for want of the timestamp. That was a
   * defect in what the QUEUE ADMITS, not only in what a reader prints — the
   * change was silently held out of the queue — and it is fixed in the shared
   * model by {@link currentRevisionTerminal}
   * ({@link ../../yrd-bay/tests/late-settle-admission.test.ts}).
   *
   * So this row is no longer CONTAINED; it is RESOLVED, and reads pending like
   * every other resubmitted change. The containment behind it stays for
   * anything the rule cannot resolve, pinned in
   * {@link ./reader-watch-source-ready-age-gate.test.ts}.
   */
  it("a late REJECTED settle reads pending too — resolved at the source, not contained", () => {
    const lateRejected: Change = {
      ...resubmitted(),
      revs: [{ ...resubmitted().revs[0]!, terminal: { kind: "rejected", at: TERMINAL_AT, run: "R3675" } }],
    }
    const healthy: Change = { ...resubmitted(), id: "PR2750", branch: "task/other" }
    const healthyEligibility: ChangeEligibility = { ...ELIGIBILITY, pr: "PR2750" }

    let rows: ReturnType<typeof changeListRows> | undefined
    expect(() => {
      rows = changeListRows(
        [
          { pr: lateRejected, eligibility: ELIGIBILITY },
          { pr: healthy, eligibility: healthyEligibility },
        ],
        [],
        NOW,
      )
    }).not.toThrow()

    expect(rows).toHaveLength(2)
    const row = rows?.find((candidate) => candidate.pr === CHANGE)
    expect(row?.state).toBe("submitted")
    expect(row?.why).not.toBe("clock-unreadable")
    expect(row?.age).not.toBe("-")
    // The stale fact is still on the record; it simply decides nothing.
    expect(lateRejected.revs[0]?.terminal?.kind).toBe("rejected")
    expect(rows?.find((candidate) => candidate.pr === "PR2750")?.state).not.toBe("unreadable")
  })

  /**
   * The THIRD live shape, and the one that was still blocking the fleet's
   * canonical read after the row projections were fixed. Measured by @ci on
   * 2026-09-01 against the live journal, byte-identical on the pinned CLI
   * (764c7ac8) and on d083dce6:
   *
   *   yrd queue list --json
   *   error: change 'PR2909' total duration
   *          finish '2026-09-01T11:20:30.531Z'
   *          precedes start '2026-09-01T18:41:34.096Z'
   *
   * It is NOT the `runRevisionClockRead` closure — those two call sites go
   * through the guarded validator already. `terminalMemberFact` is a FLOW
   * metric, folded per completed Run by `foldTerminalFacts`, and it never
   * touches the revision clock at all: it pairs the lineage's own
   * `registeredAt ?? sourceReadyAt` START with the Run's finish. For a member
   * whose pinned revision is not retained on the record, `timelineRevisionLineage`
   * supplies no `registeredAt` and falls back to the change-level submit fact —
   * which the re-submission had moved to 18:41Z, hours after the dead run
   * finished at 11:20Z. One unguarded pairing, three surfaces down.
   */
  it("`yrd queue list --json` folds the FLOW metric without aborting on a resubmitted member", () => {
    const RUN_FINISHED_AT = "2026-09-01T11:20:30.531Z"
    const RESUBMITTED = "2026-09-01T18:41:34.096Z"
    // Built from the ERROR'S OWN ARITHMETIC rather than a guess at which
    // journal event produced it: the projection reported a start of
    // 18:41:34.096Z against a finish of 11:20:30.531Z, and `terminalMemberFact`
    // takes its start from the lineage's `registeredAt` — the lineage root's
    // `pushedAt` — falling back to its `sourceReadyAt`. So the pairing the live
    // read performed is a member whose lineage clock sits AFTER the run that
    // pinned it finished. That is representable directly, and the fix has to
    // hold for it however the journal got there.
    const member = { id: "PR2909", branch: "task/w28-flow", base: "main", revision: 1, headSha: HEAD, baseSha: BASE_SHA }
    const notRetained: Change = {
      ...resubmitted(),
      id: "PR2909",
      branch: "task/w28-flow",
      revs: [
        {
          ...resubmitted().revs[0]!,
          pushedAt: RESUBMITTED,
          submittedAt: RESUBMITTED,
          terminal: undefined,
        },
      ],
      submittedAt: RESUBMITTED,
    }
    const deadRun = {
      id: "R3699",
      queueId: "Q:main",
      candidateId: "C:R3699",
      base: "main",
      prs: [member],
      jobs: [],
      steps: [],
      startedAt: "2026-09-01T11:00:00.000Z",
      finishedAt: RUN_FINISHED_AT,
      cursor: 0,
      shape: { results: {} },
      status: "completed",
      conclusion: "failure",
    } as unknown as Run

    let projection: ReturnType<typeof queueTimelineProjection> | undefined
    expect(() => {
      projection = queueTimelineProjection(
        [
          {
            base: "main",
            prs: [notRetained],
            admissionOrder: ["PR2909"],
            running: [],
            waiting: [],
            finished: [deadRun],
          },
        ],
        {
          now: NOW,
          windowMs: 100 * 365 * 24 * 60 * 60 * 1_000,
          statuses: ["pending", "running", "rejected", "integrated", "other"],
          terms: [],
          latest: false,
          rowLimit: 50,
          submissionTimes: new Map(),
        },
      )
    }).not.toThrow()

    // The FLOW fact still exists — the metric is not dropped, it is honest.
    const fact = projection?.timeStatsFacts.find((candidate) => candidate.run === "R3699")
    expect(fact).toBeDefined()
    const flowMember = fact?.members.find((candidate) => candidate.pr === "PR2909")
    expect(flowMember).toBeDefined()
    // No finish belongs to this admission, so there is no total duration to
    // report. Null, never a negative number and never an abort.
    expect(flowMember?.totalMs).toBeNull()
    // And the row itself still renders.
    expect(projection?.rows.some((candidate) => candidate.pr === "PR2909")).toBe(true)
  })

  it("a settle that is genuinely this admission's still measures to it", () => {
    // Same record, but submitted BEFORE the settle — the ordinary case. The
    // scoping rule must not swallow a real terminal fact.
    const ordinary: Change = {
      ...resubmitted(),
      state: "closed",
      merged: false,
      canceledAt: TERMINAL_AT,
      revs: [{ ...resubmitted().revs[0]!, submittedAt: "2026-08-30T22:00:00.000Z" }],
      submittedAt: "2026-08-30T22:00:00.000Z",
    }
    const rows = changeListRows([{ pr: ordinary, eligibility: ELIGIBILITY }], [], NOW)
    expect(rows[0]?.state).not.toBe("unreadable")
    // Aged to the settle, not to `now` — the terminal fact is still in force.
    expect(rows[0]?.age).toBe("56m")
  })
})
