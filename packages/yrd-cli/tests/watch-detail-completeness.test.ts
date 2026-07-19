/**
 * 21106 item J — watch detail field completeness (PR-level + proof/artifacts).
 *
 * Layered on the run→tabs→step reorder: the batched members' subject / reviews
 * / comments / check-requests / revision history, the integration proof detail
 * beyond the landed SHA (REWRITES/SUBMODULES), and the per-step artifacts label
 * + checkpoint. Every timestamp uses the local detail clock (never a raw ISO
 * string); the PR facts set `bgConflict="ignore"` on author-authored strings.
 */

import { createElement } from "react"
import type { SourceRewrite } from "@yrd/queue"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { QueueDetailPrFacts, QueueShowView, queueShowData, type QueueShowData } from "../src/queue-status-view.tsx"

const NO_RAW_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u

const rewrite: SourceRewrite = {
  repo: "origin",
  branch: "topic/pr4",
  oldBaseSha: "a".repeat(40),
  oldTipSha: "b".repeat(40),
  newBaseSha: "c".repeat(40),
  newTipSha: "d".repeat(40),
  candidateRef: "refs/yrd/candidate/R4",
  patchId: "e".repeat(40),
  rangeDiff: "=",
  payload: ["feat: land the durable patch"],
}

function integratedRunData(): QueueShowData {
  const pr = fixturePr("PR4", "integrated", "2026-07-13T10:30:00.000Z", "Land the durable patch")
  const run = fixtureRun("R4", [pr], "passed", "2026-07-13T10:40:00.000Z", {
    finishedAt: "2026-07-13T10:55:00.000Z",
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J4-check", "passed", {
          requestedAt: "2026-07-13T10:39:00.000Z",
          startedAt: "2026-07-13T10:40:00.000Z",
          finishedAt: "2026-07-13T10:47:00.000Z",
          artifacts: [{ kind: "vitest-report", uri: "file:///repo/report.json" }],
          checkpoint: { tests: 125, failures: 0 },
        }),
      ),
    ],
  })
  const parented = { ...run, parent: "R3", isolationPart: 1 as const }
  const base = queueShowData(parented, [parented])
  return {
    ...base,
    integration: { commit: "b".repeat(40), baseSha: "a".repeat(40), sourceRewrites: [rewrite] },
  }
}

describe("watch detail completeness — run-level integration proof detail (item J)", () => {
  it("keeps the landing sentence exact and carries REWRITES as a separate fact", () => {
    const app = createRenderer({ cols: 120, rows: 30 })(
      createElement(QueueShowView, { data: integratedRunData(), compact: true, section: "run" }),
    )
    try {
      expect(app.text).toContain("RUN main#4 STATUS passed OUTCOME integrated")
      expect(app.text).toContain(`Committed as ${"b".repeat(40)} on main`)
      expect(app.text).toContain("- integration proof: REWRITES 1")
      expect(app.text).not.toMatch(NO_RAW_ISO)
    } finally {
      app.unmount()
    }
  })
})

describe("watch detail completeness — step artifacts + checkpoint (item J)", () => {
  it("renders artifacts and checkpoint on a proof row distinct from inline output", () => {
    const data = integratedRunData()
    const [row] = data.steps
    if (row === undefined) throw new Error("fixture run produced no step rows")
    // Isolate the artifacts/checkpoint cells: no ART links or EVIDENCE JSON, so
    // the single truncate PROOF row has room to show both fields.
    const stepData: QueueShowData = {
      ...data,
      steps: [{ ...row, artifacts: "vitest-report", checkpoint: "tests=125 failures=0", evidence: "-", locations: [] }],
    }
    const app = createRenderer({ cols: 120, rows: 30 })(
      createElement(QueueShowView, { data: stepData, compact: true, section: "steps" }),
    )
    try {
      // The step tab is the step summary now (item d), so the duplicate STEP
      // header row is gone; durable proof remains distinct from inline output.
      expect(app.text).not.toContain("STEP check#1")
      expect(app.text).toContain("PROOF")
      expect(app.text).toContain("ARTIFACTS vitest-report")
      expect(app.text).toContain("CHECKPOINT tests=125 failures=0")
    } finally {
      app.unmount()
    }
  })

  it("lets inline output own raw locations and artifact names without hiding non-log proof", () => {
    const data = integratedRunData()
    const [row] = data.steps
    if (row === undefined) throw new Error("fixture run produced no step rows")
    const stepData: QueueShowData = {
      ...data,
      steps: [
        {
          ...row,
          artifacts: "stdout",
          checkpoint: "tests=125 failures=0",
          evidence: "-",
          locations: [
            {
              label: "stdout",
              display: "stdout.log",
              location: { url: "file:///repo/.git/yrd/artifacts/R4/check/stdout.log" },
            },
          ],
        },
      ],
    }
    const app = createRenderer({ cols: 120, rows: 30 })(
      createElement(QueueShowView, {
        data: stepData,
        compact: true,
        section: "steps",
        showLogArtifacts: false,
      }),
    )
    try {
      expect(app.text).toContain("PROOF")
      expect(app.text).toContain("CHECKPOINT tests=125 failures=0")
      expect(app.text).not.toContain("stdout.log")
      expect(app.text).not.toContain("ARTIFACTS stdout")
    } finally {
      app.unmount()
    }
  })
})

describe("watch detail completeness — PR-level facts (item J)", () => {
  it("renders the subject, reviews, comments, check requests, and revision history with a local clock", () => {
    const head = "9".repeat(40)
    const pr = fixturePr("PR9", "submitted", "2026-07-13T11:10:00.000Z", "Wire the queue detail surface", {
      headSha: head,
      issue: "@yrd/core/21106-queue-timeline",
      note: "Keep the selected detail visible during review.",
      reviews: [
        {
          revision: 1,
          headSha: head,
          actor: "reviewer@example.test",
          decision: "approve",
          at: "2026-07-13T11:14:00.000Z",
          ref: "review://PR9/1",
          note: "Field completeness matches the accepted contract.",
        },
      ],
      comments: [
        {
          revision: 1,
          headSha: head,
          actor: "author@example.test",
          note: "Retain this source position after re-render.",
          at: "2026-07-13T11:15:00.000Z",
        },
      ],
      checkRequests: [{ revision: 1, headSha: head, baseSha: "a".repeat(40), at: "2026-07-13T11:16:00.000Z" }],
    })
    const app = createRenderer({ cols: 140, rows: 30 })(createElement(QueueDetailPrFacts, { prs: [pr] }))
    try {
      expect(app.text).toContain("pr#9.1 Wire the queue detail surface")
      expect(app.text).toContain("ISSUE @yrd/core/21106-queue-timeline")
      expect(app.text).toContain("NOTE Keep the selected detail visible during review.")
      expect(app.text).toContain("REVIEW approve reviewer@example.test")
      expect(app.text).toContain("Field completeness matches the accepted contract.")
      expect(app.text).toContain("COMMENT author@example.test")
      expect(app.text).toContain("CHECK REQUESTED")
      expect(app.text).toContain("REV 1 open")
      expect(app.text).not.toMatch(NO_RAW_ISO)
    } finally {
      app.unmount()
    }
  })

  it("renders nothing when there are no PRs", () => {
    const app = createRenderer({ cols: 80, rows: 6 })(createElement(QueueDetailPrFacts, { prs: [] }))
    try {
      expect(app.text.trim()).toBe("")
    } finally {
      app.unmount()
    }
  })
})
