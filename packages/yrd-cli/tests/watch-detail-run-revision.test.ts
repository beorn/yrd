/**
 * Watch DETAIL pane — run/revision association (user-reported 2026-07-16).
 *
 * Selecting a PENDING queue row whose CURRENT revision has no run yet must not
 * present the PR's newest HISTORICAL run (which ran against a now-superseded
 * revision) as the current state. The reported screenshot showed a rev-2
 * pending PR whose detail read "RUN R520 STATUS failed OUTCOME rejected …
 * BLOCKER check-failed" — R520 ran against rev 1. The run block must be labeled
 * as history (the run header carries the revision it ran + "superseded"), the
 * current revision's real state ("no run yet") must be stated above it, and the
 * BLOCKER must be scoped to the historical revision, never rendered as the PR's
 * current blocker.
 */

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureResult, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { QueueWatchView } from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const BASE_SHA = "a".repeat(40)
const REV1_HEAD = "bc1ce38b0824".padEnd(40, "0")
const REV2_HEAD = "970294c68f1a".padEnd(40, "0")

// A PR at revision 2 sitting PENDING (submitted, no run yet), whose revision 1
// was already rejected by run R520 — exactly the reported shape.
function supersededPr() {
  return fixturePr("PR380", "submitted", "2026-07-13T11:05:00.000Z", "Repair the watch detail run association", {
    revision: 2,
    headSha: REV2_HEAD,
    revisions: [
      {
        revision: 1,
        headSha: REV1_HEAD,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: "2026-07-13T09:00:00.000Z",
        submittedAt: "2026-07-13T09:05:00.000Z",
        terminal: { status: "rejected", at: "2026-07-13T09:25:00.000Z", run: "R520" },
      },
      {
        revision: 2,
        headSha: REV2_HEAD,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: "2026-07-13T11:00:00.000Z",
        submittedAt: "2026-07-13T11:05:00.000Z",
      },
    ],
  })
}

function rejectedRev1Run(pr: ReturnType<typeof supersededPr>) {
  return fixtureRun("R520", [pr], "failed", "2026-07-13T09:10:00.000Z", {
    finishedAt: "2026-07-13T09:25:00.000Z",
    error: { code: "check-failed", message: "check command exited 1" },
    memberRevisions: { PR380: 1 },
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J520-check", "failed", {
          requestedAt: "2026-07-13T09:09:00.000Z",
          startedAt: "2026-07-13T09:10:00.000Z",
          changedAt: "2026-07-13T09:25:00.000Z",
          finishedAt: "2026-07-13T09:25:00.000Z",
          error: { code: "check-failed", message: "check command exited 1" },
        }),
      ),
    ],
  })
}

describe("watch detail — pending row whose latest run ran a superseded revision", () => {
  it("labels the historical run, states the current revision has no run, and scopes the blocker", () => {
    const pr = supersededPr()
    const result = fixtureResult([pr], [rejectedRev1Run(pr)])
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueWatchView, { results: [result], now: NOW, pr: "PR380" }),
    )
    try {
      // (a) The run block is labeled as history: the run header carries the
      //     revision it ran + "superseded".
      expect(app.text).toContain("main#520")
      expect(app.text).toContain("(rev 1 · superseded)")
      // (b) The current revision's real state is stated plainly above the run.
      expect(app.text).toContain("CURRENT rev 2")
      expect(app.text).toContain("no run yet")
      // (c) The blocker is scoped to the historical revision, not presented as
      //     the PR's current blocker.
      expect(app.text).toContain("BLOCKER (rev 1)")
      expect(app.text).toContain("err=check-failed — check command exited 1")
    } finally {
      app.unmount()
    }
  })
})

describe("watch detail — current-revision run keeps today's rendering", () => {
  it("does not add superseded/no-run labeling when the latest run ran the current revision", () => {
    // Same PR, but its latest run (R521) ran the CURRENT revision (2) and failed.
    const pr = supersededPr()
    const currentRun = fixtureRun("R521", [pr], "failed", "2026-07-13T11:10:00.000Z", {
      finishedAt: "2026-07-13T11:25:00.000Z",
      error: { code: "check-failed", message: "check command exited 1" },
      memberRevisions: { PR380: 2 },
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J521-check", "failed", {
            requestedAt: "2026-07-13T11:09:00.000Z",
            startedAt: "2026-07-13T11:10:00.000Z",
            changedAt: "2026-07-13T11:25:00.000Z",
            finishedAt: "2026-07-13T11:25:00.000Z",
            error: { code: "check-failed", message: "check command exited 1" },
          }),
        ),
      ],
    })
    const result = fixtureResult([pr], [currentRun])
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueWatchView, { results: [result], now: NOW, pr: "PR380" }),
    )
    try {
      expect(app.text).toContain("main#521")
      expect(app.text).not.toContain("superseded")
      expect(app.text).not.toContain("no run yet")
      // The current-revision blocker keeps its plain (unscoped) presentation.
      expect(app.text).toContain("BLOCKER")
      expect(app.text).not.toContain("BLOCKER (rev")
    } finally {
      app.unmount()
    }
  })
})
