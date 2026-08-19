/**
 * @failure The status box's step lines and the step tabs derive a run's
 *          steps twice and drift, or the run-presentation skeleton hard-codes
 *          the integration kind so a deployment run needs display changes.
 * @level   l2
 * @consumer @yrd/cli queue watch (operator rulings 2026-08-18, items 37m/39)
 */
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import {
  RunStepLines,
  queueRunPresentation,
  queueRunStepFacts,
  queueShowData,
  type QueueRunPresentation,
  type QueueRunStepFact,
} from "../src/queue-status-view.tsx"

function failedRunData() {
  const pr = fixturePr("PR9", "rejected", "2026-07-13T10:30:00.000Z", "Repair the check")
  const run = fixtureRun("R9", [pr], "failed", "2026-07-13T10:40:00.000Z", {
    finishedAt: "2026-07-13T10:42:00.000Z",
    error: { code: "check-failed", message: "check command exited 1" },
    steps: [
      fixtureStep(
        "check",
        fixtureJob("J9-check", "failed", {
          requestedAt: "2026-07-13T10:39:00.000Z",
          startedAt: "2026-07-13T10:40:00.000Z",
          finishedAt: "2026-07-13T10:42:00.000Z",
          error: { code: "check-failed", message: "check command exited 1" },
        }),
      ),
    ],
  })
  return queueShowData(run, [run])
}

describe("queueRunStepFacts — ONE derivation for box step lines and tab labels (item 39)", () => {
  it("carries glyph, status, duration, and the failed step's inline remedy", () => {
    const facts = queueRunStepFacts(failedRunData())
    expect(facts).toHaveLength(1)
    const check = facts[0]
    expect(check).toMatchObject({ step: "check", failed: true, active: false })
    expect(check?.remedy).toContain("check command exited 1")
    expect(check?.glyph).toBe("×")
  })
})

describe("run presentation kind (item 37m — generalized runs)", () => {
  it("presents today's journal runs as the integration kind with the label-led border title", () => {
    const presentation = queueRunPresentation(failedRunData(), "code")
    expect(presentation.kind).toBe("integration")
    expect(presentation.title).toBe("RUN code#9")
    expect(presentation.steps.map((step) => step.step)).toEqual(["check"])
  })

  it("renders a mock deployment-kind run's phases through the same skeleton with no display changes", async () => {
    // The acceptance shape ruled in 37m: a third run kind renders without
    // touching display code. The phases arrive as ordinary step facts — the
    // KIND selected what produced them, never how they draw.
    const phases: readonly QueueRunStepFact[] = [
      { step: "drain", status: "passed", glyph: "✓", color: "$fg-success", duration: "0:40", active: false, failed: false },
      { step: "rollout", status: "running", glyph: "◉", color: "$fg-info", duration: "", active: true, failed: false },
      {
        step: "verify",
        status: "failed",
        glyph: "×",
        color: "$fg-error",
        duration: "0:05",
        active: false,
        failed: true,
        remedy: "smoke probe 3/5 failed (probes.log)",
      },
    ]
    const deployment: QueueRunPresentation = {
      kind: "deployment",
      title: "RUN staging#7",
      steps: phases,
    }
    const rendered = await renderString(createElement(RunStepLines, { steps: deployment.steps }), {
      width: 80,
      height: 8,
      plain: true,
    })
    expect(rendered).toContain("✓ drain 0:40")
    expect(rendered).toContain("◉ rollout")
    expect(rendered).toContain("× verify 0:05 — smoke probe 3/5 failed (probes.log)")
    // Hanging markers (item 29a): every phase's text starts at one column.
    const columns = rendered
      .split("\n")
      .filter((row) => /drain|rollout|verify/u.test(row))
      .map((row) => row.search(/drain|rollout|verify/u))
    expect(new Set(columns).size).toBe(1)
  })
})
