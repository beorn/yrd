/**
 * @failure `yrd queue list --json` with no flags dumped 88 MB and ran past a
 * 25 s timeout (rc 124) on 2026-09-01 because its default window reached back
 * to 1926 — a hundred years (projection.filters.windowMs 3153600000000; 1638
 * rows, 1626 details). Bounding the default to seven days must not hide OPEN
 * work: a change submitted 30 days ago and still waiting is the queue's live
 * state, and a reader who loses it to a bound has been shown a false queue.
 * And a bounded read must SAY it is bounded, in the JSON and in the print, or
 * it is mistaken for the whole history.
 * @level l2
 * @consumer @yrd/cli `queue list` / `queue list --json` readers
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineProjectionOptions,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-09-01T12:00:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1_000
/** The bound under test, spelled locally so this file runs — and fails — on a tree that has no such default. */
const SEVEN_DAYS_MS = 7 * DAY_MS
const INTEGRATED_SHA = "b".repeat(40)
const BASE_SHA = "a".repeat(40)

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** One open change 30 days old, one change integrated 8 days ago. */
function agedResults(): readonly QueueStatusResult[] {
  const openForAMonth = fixturePr("PR1", "submitted", iso(NOW - 30 * DAY_MS), "Open for a month, still waiting")
  const landedLastWeek = fixturePr("PR2", "integrated", iso(NOW - 8 * DAY_MS - 60 * 60_000), "Landed eight days ago", {
    integratedAt: iso(NOW - 8 * DAY_MS),
    terminalRun: "R2",
    integration: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
  })
  const landedRun = fixtureRun("R2", [landedLastWeek], "passed", iso(NOW - 8 * DAY_MS - 30 * 60_000), {
    finishedAt: iso(NOW - 8 * DAY_MS),
  })
  return [fixtureResult([openForAMonth, landedLastWeek], [landedRun])]
}

function project(
  results: readonly QueueStatusResult[],
  window: Pick<QueueTimelineProjectionOptions, "windowMs" | "windowSource">,
): QueueTimelineProjection {
  return queueTimelineProjection(results, {
    now: NOW,
    ...window,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 500,
    submissionTimes: queueTimelineAdmissionTimes(results),
  })
}

async function renderedText(projection: QueueTimelineProjection): Promise<string> {
  const width = 140
  const render = createRenderer({ cols: width, rows: 40 })
  const app = render(createElement(QueueTimelineView, { projection, columns: width }))
  try {
    await app.waitForLayoutStable()
    return app.text
  } finally {
    app.unmount()
  }
}

describe("the default queue timeline window is bounded, keeps open work, and says so", () => {
  it("the 7-day default shows the 30-day-old OPEN change and drops the finished run from 8 days ago", () => {
    const projection = project(agedResults(), { windowMs: SEVEN_DAYS_MS, windowSource: "default" })
    const prs = projection.rows.map((row) => row.pr)
    expect(prs, "the open change is the queue's live state — never lost to a bound").toContain("PR1")
    expect(prs, "finished history outside the window is what the bound exists to drop").not.toContain("PR2")
    expect(projection.details.map((detail) => detail.run)).toEqual([])
  })

  it("names the window that applied in the JSON — a bounded default is never mistaken for the whole history", () => {
    const projection = project(agedResults(), { windowMs: SEVEN_DAYS_MS, windowSource: "default" })
    expect(projection.filters).toMatchObject({
      windowMs: SEVEN_DAYS_MS,
      windowSource: "default",
      windowLabel: "last 7d (default; open changes always shown; --since widens)",
    })
  })

  it("--since widens: an explicit 30-day window shows the finished run too, and is labelled as explicit", () => {
    const projection = project(agedResults(), { windowMs: 30 * DAY_MS, windowSource: "explicit" })
    const prs = projection.rows.map((row) => row.pr)
    expect(prs).toEqual(expect.arrayContaining(["PR1", "PR2"]))
    expect(projection.details.map((detail) => detail.run)).toEqual(["R2"])
    expect(projection.filters).toMatchObject({
      windowSource: "explicit",
      windowLabel: "last 30d (--since; open changes always shown)",
    })
  })

  it("an explicit window narrower than the open change's age still shows the open change", () => {
    // `--since 1h` scopes finished history; it does not hide a change that is
    // still waiting — that would make the queue look empty while it is not.
    const projection = project(agedResults(), { windowMs: 60 * 60_000, windowSource: "explicit" })
    expect(projection.rows.map((row) => row.pr)).toEqual(["PR1"])
  })

  it("prints the window in the one-shot human output", async () => {
    const defaulted = await renderedText(project(agedResults(), { windowMs: SEVEN_DAYS_MS, windowSource: "default" }))
    expect(defaulted).toContain("window last 7d (default; open changes always shown; --since widens)")
    const explicit = await renderedText(project(agedResults(), { windowMs: 30 * DAY_MS, windowSource: "explicit" }))
    expect(explicit).toContain("window last 30d (--since; open changes always shown)")
  })
})
