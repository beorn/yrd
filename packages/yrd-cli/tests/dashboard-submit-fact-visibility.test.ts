/**
 * @failure The human queue dashboard's whole population is the change-RECORD
 * store (`result.prs`), so a live submission on the DERIVED lane — a standing
 * `refs/yrd/submit/<branch>` fact with no record, which post-S6 is the normal
 * shape of `git push bay HEAD:refs/for/main/<issue>` — contributes no row and
 * no count. Every rendered number is correct arithmetic over an empty set, so
 * `yrd queue list` prints `OPEN 0 ... No runnable or recent failed PRs.` and
 * reads as a true idle queue while `yrd pr list` shows the work. Live specimen
 * 2026-08-28: cfb6e186 standing on both `refs/for/main/@i/2-agent-launch/
 * 23096-account-rotation-ignored-on-resume` and its submit ref, invisible on
 * the dashboard — the operator's next move is to push again.
 * @level l2
 * @consumer @yrd/cli every operator reading `yrd queue list`
 */
import type { BaysState, Change, ProjectedBranchSubmit } from "@yrd/bay"
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"

import { fixturePr } from "../dev/queue-timeline-fixtures.ts"
import { humanQueueProjection, QueueStatusView, type QueueStatusResult } from "../src/queue-status-view.tsx"

const BASE_SHA = "a".repeat(40)
const DERIVED_SHA = "d".repeat(40)
const SECOND_SHA = "e".repeat(40)
const NOW = Date.parse("2026-07-09T12:10:00.000Z")
const DERIVED_BRANCH = "@i/2-agent-launch/23096-account-rotation-ignored-on-resume"
const SECOND_BRANCH = "@i/10-yrd/23235-dashboard-blind-to-submits"

function submitFact(sha: string, at: string): ProjectedBranchSubmit {
  return { sha, base: "main", at }
}

/** A record-backed change awaiting its run: the lane the dashboard already sees. */
function recordedChange(): Change {
  return fixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Recorded change")
}

function result(prs: readonly Change[], admissionOrder: readonly string[]): QueueStatusResult {
  return {
    base: "main",
    headSha: BASE_SHA,
    prs: [...prs],
    admissionOrder: [...admissionOrder],
    running: [],
    waiting: [],
    finished: [],
  }
}

function baysState(prs: readonly Change[], submits: Readonly<Record<string, ProjectedBranchSubmit>>): BaysState {
  return {
    byId: {},
    prs: Object.fromEntries(prs.map((pr) => [pr.id, pr])),
    receipts: {},
    submits,
  }
}

describe("the queue dashboard sees both admission lanes", () => {
  it("renders a submit fact with no record as an open queue row", () => {
    const projection = humanQueueProjection(result([], []), NOW, {
      state: baysState([], { [DERIVED_BRANCH]: submitFact(DERIVED_SHA, "2026-07-09T12:05:00.000Z") }),
    })

    expect(projection.open, "one standing submit fact is one open change").toBe(1)
    expect(projection.queue.map((row) => row.branch)).toEqual([DERIVED_BRANCH])
    expect(projection.queue[0]).toMatchObject({
      branch: DERIVED_BRANCH,
      nativeStatus: "submitted",
      target: "main",
      submittedAt: "2026-07-09T12:05:00.000Z",
    })
    expect(projection.oldestOpen, "DRAIN measures the fact's own submission clock").toBe("5m")
  })

  it("keeps every record-backed row and its published position", () => {
    const recorded = recordedChange()
    const projection = humanQueueProjection(result([recorded], ["PR1"]), NOW, {
      state: baysState([recorded], {}),
    })

    expect(projection.open).toBe(1)
    expect(projection.queue.map((row) => ({ pr: row.pr, position: row.position }))).toEqual([
      { pr: "PR1", position: 1 },
    ])
    expect(projection.queue[0]).toMatchObject({ nativeStatus: "submitted", revision: 1 })
  })

  it("counts both lanes together, records first and by their published order", () => {
    const recorded = recordedChange()
    const projection = humanQueueProjection(result([recorded], ["PR1"]), NOW, {
      state: baysState([recorded], {
        [DERIVED_BRANCH]: submitFact(DERIVED_SHA, "2026-07-09T12:05:00.000Z"),
        [SECOND_BRANCH]: submitFact(SECOND_SHA, "2026-07-09T12:01:00.000Z"),
      }),
    })

    expect(projection.open, "one record + two standing facts").toBe(3)
    expect(projection.queue.map((row) => row.pr)).toEqual(["PR1", SECOND_BRANCH, DERIVED_BRANCH])
    expect(
      projection.queue.map((row) => row.position),
      "a derived branch holds no published admission position",
    ).toEqual([1, undefined, undefined])
    expect(
      projection.integrated + projection.rejected + projection.needsAuthor + projection.activeCount,
      "a pre-run fact is neither terminal nor active",
    ).toBe(0)
  })

  it("leaves a live record's own standing fact to the record lane — one lane consumes one push", () => {
    const recorded = recordedChange()
    const projection = humanQueueProjection(result([recorded], ["PR1"]), NOW, {
      state: baysState([recorded], {
        [recorded.branch]: submitFact("1".repeat(40), "2026-07-09T12:00:00.000Z"),
      }),
    })

    expect(projection.open, "the record IS the branch's submission; a second row would double-count").toBe(1)
    expect(projection.queue.map((row) => row.pr)).toEqual(["PR1"])
  })

  it("drops a fact a retained run already admitted at that exact sha", () => {
    const admitted = result([], [])
    const run = {
      id: "R1",
      base: "main",
      status: "in_progress" as const,
      startedAt: "2026-07-09T12:06:00.000Z",
      steps: [],
      prs: [
        {
          id: "PR900",
          branch: DERIVED_BRANCH,
          base: "main",
          revision: 1,
          headSha: DERIVED_SHA,
          baseSha: BASE_SHA,
        },
      ],
    } as unknown as QueueStatusResult["running"][number]
    const projection = humanQueueProjection({ ...admitted, running: [run] }, NOW, {
      state: baysState([], { [DERIVED_BRANCH]: submitFact(DERIVED_SHA, "2026-07-09T12:05:00.000Z") }),
    })

    expect(projection.queue, "an admitted fact's truth lives in its run rows").toHaveLength(0)
    expect(projection.open).toBe(0)
  })

  it("renders the derived submission instead of the empty state", async () => {
    const recorded = recordedChange()
    const frame = await renderString(
      createElement(QueueStatusView, {
        state: baysState([recorded], {
          [DERIVED_BRANCH]: submitFact(DERIVED_SHA, "2026-07-09T12:05:00.000Z"),
        }),
        results: [result([recorded], ["PR1"])],
        selected: new Set<string>(),
        now: NOW,
      }),
      { width: 160, height: 24, plain: true },
    )

    expect(frame).toContain("OPEN 2")
    expect(frame).toContain(DERIVED_BRANCH)
    expect(frame, "the empty state is the defect's own signature").not.toContain("No runnable or recent failed PRs.")
  })
})
