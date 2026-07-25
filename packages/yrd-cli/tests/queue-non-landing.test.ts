/**
 * @yrd/core/21096-cli-ux/21801 + @yrd/core/22323
 *
 * Perfect landing detectors from the 6h phantom-merge audit (96 PHANTOM / 36 LANDED):
 *   - outcome=integrated (merge proof present) → LANDED (glyph ✓, word "done")
 *   - outcome=passed without integration proof → NON-LANDING (glyph ◌, word "pass")
 * Duration is secondary and must not drive the verdict.
 */
import { describe, expect, it } from "vitest"
import {
  landingVerdictOfOutcome,
  queueShowData,
  queueTimelineProjection,
  queueTimelineStatusBucket,
} from "../src/queue-status-view.tsx"
import { statusPresentation } from "../src/status-presentation.ts"
import { fixtureJob, fixturePr, fixtureResult, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"

const HEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const LANDING_SHA = "cccccccccccccccccccccccccccccccccccccccc"
const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

function admissionOnlyRun() {
  const pr = fixturePr("PR9", "submitted", "2026-07-25T05:00:00.000Z", "Admission only", {
    headSha: HEAD_SHA,
  })
  const admission = fixtureJob("job-admission", "passed", {
    startedAt: "2026-07-25T05:00:05.000Z",
    finishedAt: "2026-07-25T05:00:05.200Z",
  })
  // Success with only bead-identity-admission — no merge step, no integration proof.
  return {
    pr,
    run: fixtureRun("R2439", [pr], "passed", "2026-07-25T05:00:00.000Z", {
      finishedAt: "2026-07-25T05:00:06.000Z",
      steps: [fixtureStep("bead-identity-admission", admission)],
      cursor: 1,
      results: {
        "bead-identity-admission": { detail: "ok", exitCode: 0 },
      },
    }),
  }
}

function landedRun() {
  const pr = fixturePr("PR8", "submitted", "2026-07-25T05:00:00.000Z", "Landed merge", {
    headSha: HEAD_SHA,
  })
  const admission = fixtureJob("job-admission", "passed", {
    startedAt: "2026-07-25T05:00:05.000Z",
    finishedAt: "2026-07-25T05:00:05.200Z",
  })
  const merge = fixtureJob("job-merge", "passed", {
    startedAt: "2026-07-25T05:00:20.000Z",
    finishedAt: "2026-07-25T05:01:00.000Z",
  })
  return {
    pr,
    run: fixtureRun("R2445", [pr], "passed", "2026-07-25T05:00:00.000Z", {
      finishedAt: "2026-07-25T05:01:00.000Z",
      steps: [fixtureStep("bead-identity-admission", admission), fixtureStep("merge", merge, { kind: "merge" })],
      cursor: 2,
      results: {
        "bead-identity-admission": { detail: "ok", exitCode: 0 },
        merge: { commit: LANDING_SHA, baseSha: BASE_SHA },
      },
    }),
  }
}

/** Strip the default fixture integration so the run is admission-only success. */
function withoutIntegration<T extends { integration?: unknown; shape: { integration?: unknown; results: unknown } }>(
  run: T,
): T {
  const { integration: _drop, ...rest } = run as T & { integration?: unknown }
  const { integration: _shapeDrop, ...shapeRest } = run.shape as {
    integration?: unknown
    results: unknown
  }
  return { ...rest, shape: shapeRest } as T
}

describe("21801 non-landing detector (perfect signals)", () => {
  it("landingVerdictOfOutcome ranks perfect detectors over duration heuristics", () => {
    expect(landingVerdictOfOutcome("integrated")).toBe("landed")
    expect(landingVerdictOfOutcome("already-landed")).toBe("already-landed")
    expect(landingVerdictOfOutcome("passed")).toBe("non-landing")
    expect(landingVerdictOfOutcome("rejected")).toBe("failed")
  })

  it("presentation: non-landing glyph is not the green check", () => {
    const landed = statusPresentation("integrated")
    const nonLanding = statusPresentation("passed")
    expect(landed.glyph).toBe("✓")
    expect(landed.color).toBe("$fg-success")
    expect(nonLanding.glyph).not.toBe("✓")
    expect(nonLanding.glyph).toBe("◌")
    expect(nonLanding.color).toBe("$fg-warning")
  })

  it("admission-only success is non-landing: status pass, not done/integrated", () => {
    const { pr, run: raw } = admissionOnlyRun()
    const run = withoutIntegration(raw)
    expect(run.integration).toBeUndefined()
    expect(run.shape).not.toHaveProperty("integration")

    const show = queueShowData(run)
    expect(show.outcome).toBe("passed")
    expect(show.landingVerdict).toBe("non-landing")
    expect(show.landing).toBe("-")
    expect(show.integration).toBeUndefined()
    expect(show.stepNames).toEqual(["bead-identity-admission"])
    expect(show.glyph).toBe("◌")

    const projection = queueTimelineProjection([fixtureResult([pr], [run])], {
      now: Date.parse("2026-07-25T05:10:00.000Z"),
      windowMs: 3_600_000,
      statuses: [],
      terms: [],
      latest: false,
      rowLimit: 50,
      submissionTimes: new Map(),
    })
    const row = projection.rows.find((candidate) => candidate.run === run.id)
    expect(row).toBeDefined()
    expect(row?.status).toBe("passed")
    expect(row?.glyph).toBe("◌")
    // Row-level JSON (not only details) carries the script-facing fields.
    expect(row?.landingVerdict).toBe("non-landing")
    expect(row?.stepNames).toEqual(["bead-identity-admission"])
    expect(queueTimelineStatusBucket("passed")).toBe("failed") // not the done court
    expect(projection.metrics.outcomes.passed).toBe(1)
    expect(projection.metrics.outcomes.integrated).toBe(0)
    // JSON details carry the same script-facing fields
    const detail = projection.details.find((candidate) => candidate.run === run.id)
    expect(detail?.outcome).toBe("passed")
    expect(detail?.landingVerdict).toBe("non-landing")
    expect(detail?.stepNames).toEqual(["bead-identity-admission"])
  })

  it("merge with integration proof remains landed: status done, green check", () => {
    const { pr, run } = landedRun()
    expect(run.integration).toBeDefined()

    const show = queueShowData(run)
    expect(show.outcome).toBe("integrated")
    expect(show.landingVerdict).toBe("landed")
    expect(show.stepNames).toContain("merge")
    expect(show.glyph).toBe("✓")

    const projection = queueTimelineProjection([fixtureResult([pr], [run])], {
      now: Date.parse("2026-07-25T05:10:00.000Z"),
      windowMs: 3_600_000,
      statuses: [],
      terms: [],
      latest: false,
      rowLimit: 50,
      submissionTimes: new Map(),
    })
    const row = projection.rows.find((candidate) => candidate.run === run.id)
    expect(row?.status).toBe("integrated")
    expect(row?.glyph).toBe("✓")
    expect(queueTimelineStatusBucket("integrated")).toBe("done")
    expect(projection.metrics.outcomes.integrated).toBe(1)
    expect(projection.metrics.outcomes.passed).toBe(0)
  })
})
