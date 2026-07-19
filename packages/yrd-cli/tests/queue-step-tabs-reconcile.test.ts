// @failure Step tabs freeze selection/expansion and ignore same-run status updates
// @level l2
// @consumer @yrd/cli

import { createElement as h, useEffect, useState } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { queueShowData, type QueueShowData } from "../src/queue-status-view.tsx"
import { QueueWorkflowStepTabs, resolveStepLogExpanded, resolveStepTabSelection } from "../src/watch-pane.tsx"
import type { QueueArtifactOutput } from "../src/watch-pane.tsx"

// One PR / one run; the reconciliation contract (21106) is entirely about the
// run's step statuses moving underneath a still-mounted detail pane.
const STEP_PR = fixturePr("PR100", "submitted", "2026-07-13T11:30:00.000Z", "Reconcile the live step")

type StepState = Readonly<{
  name: string
  status: "requested" | "running" | "passed" | "failed"
  error?: Readonly<{ code: string; message: string }>
  startedAt?: string
  finishedAt?: string
}>

function stepTabsData(steps: readonly StepState[]): QueueShowData {
  const run = fixtureRun("R100", [STEP_PR], "running", "2026-07-13T11:40:00.000Z", {
    steps: steps.map((step) =>
      fixtureStep(
        step.name,
        fixtureJob(`J100-${step.name}`, step.status, {
          ...(step.error === undefined ? {} : { error: step.error }),
          ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
          ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
        }),
      ),
    ),
  })
  return queueShowData(run)
}

// Each step streams a distinctly-named output so the active step is readable
// from the rendered RUN LOGS heading (the STEP <name>#<attempt> facts row was
// dropped — the tab is the step summary now, item d of the 2026-07-16 redesign).
function stepOutputs(steps: readonly StepState[]): readonly QueueArtifactOutput[] {
  return steps.map((step) => ({
    run: "R100",
    step: step.name,
    attempt: 1,
    path: `/repo/.git/yrd/artifacts/R100/${step.name}/attempt-1/stdout.log`,
    text: `live ${step.name} output\n`,
  }))
}

// Mount with `first`, then flip to `second` after the first commit. React keeps
// the SAME QueueWorkflowStepTabs fiber across the flip (no key change), so its
// internal state survives exactly as it does for a live same-run snapshot
// advance — which is precisely where the freeze bug hides.
function SameRunAdvance({ first, second }: { first: readonly StepState[]; second: readonly StepState[] }) {
  const [steps, setSteps] = useState(first)
  useEffect(() => {
    setSteps(second)
  }, [second])
  return h(QueueWorkflowStepTabs, {
    data: stepTabsData(steps),
    outputs: stepOutputs(steps),
    compact: true,
    active: false,
    prs: [],
  })
}

async function renderAdvance(first: readonly StepState[], second: readonly StepState[]): Promise<string> {
  return renderString(h(SameRunAdvance, { first, second }), { width: 100, height: 40, plain: true })
}

async function renderOnce(steps: readonly StepState[]): Promise<string> {
  return renderString(
    h(QueueWorkflowStepTabs, {
      data: stepTabsData(steps),
      outputs: stepOutputs(steps),
      compact: true,
      active: false,
      prs: [],
    }),
    { width: 100, height: 40, plain: true },
  )
}

// The active step is the only rendered TabPanel; its expanded RUN LOGS streams
// that step's output under an `OUTPUT <name>#<attempt>` heading, so the active
// running step names itself. A completed active step folds its log (no heading)
// — which is exactly the frozen-selection bug this contract catches, so a
// missing heading is a legitimate failure, not a detection gap.
function activeStepName(frame: string): string {
  const match = /\bOUTPUT (\S+?)#/u.exec(frame)
  if (match === null) throw new Error(`no OUTPUT <name>#<attempt> heading in frame:\n${frame}`)
  return match[1] as string
}

describe("queue step tabs same-run reconciliation (21106)", () => {
  it("right-aligns durations within wide equal-width tabs", async () => {
    const startedAt = "2026-07-13T11:30:00.000Z"
    const frame = await renderOnce([
      { name: "prepare", status: "passed", startedAt, finishedAt: "2026-07-13T11:30:27.000Z" },
      { name: "check", status: "passed", startedAt, finishedAt: "2026-07-13T11:30:42.000Z" },
      { name: "integrate", status: "passed", startedAt, finishedAt: "2026-07-13T11:30:15.000Z" },
    ])
    const lines = frame.split("\n")
    const tabRowIndex = lines.findIndex((row) => row.includes("1: prepare") && row.includes("3: integrate"))
    const tabRow = lines[tabRowIndex] ?? ""
    const prepareX = tabRow.indexOf("1: prepare")
    const checkX = tabRow.indexOf("2: check", prepareX)
    const integrateX = tabRow.indexOf("3: integrate", checkX)
    const firstStride = checkX - prepareX
    const secondStride = integrateX - checkX
    expect(firstStride).toBeGreaterThanOrEqual(20)
    expect(Math.abs(firstStride - secondStride)).toBeLessThanOrEqual(2)

    const durationRow = lines[tabRowIndex + 2] ?? ""
    const segment = durationRow.slice(prepareX)
    const durations = [...segment.matchAll(/\b(?:27s|42s|15s)\b/gu)]
    expect(durations.map((match) => match[0])).toEqual(["27s", "42s", "15s"])
    const ends = durations.map((match) => (match.index ?? -1) + match[0].length)
    expect(ends[0]).toBe((ends[1] ?? 0) - firstStride)
    expect(ends[1]).toBe((ends[2] ?? 0) - secondStride)
  })

  it("keeps detailed failure text in the active pane content, never in the tab label", async () => {
    const frame = await renderOnce([
      {
        name: "check",
        status: "failed",
        error: { code: "check-failed", message: "typecheck found three unsafe assignments" },
      },
      { name: "integrate", status: "requested" },
    ])
    const tabRow = frame.split("\n").find((row) => row.includes("check") && row.includes("integrate")) ?? ""
    expect(tabRow).not.toContain("typecheck found three unsafe assignments")
    expect(frame).toContain("typecheck found three unsafe assignments")
  })

  it("shows the run's recorded command instead of a newer config value", async () => {
    const frame = await renderString(
      h(QueueWorkflowStepTabs, {
        data: stepTabsData([{ name: "check", status: "running" }]),
        outputs: [],
        commands: { check: "bun test:stale-config" },
        compact: true,
        active: false,
        prs: [],
      }),
      { width: 100, height: 30, plain: true },
    )
    expect(frame).toContain("COMMAND $ bun vitest run")
    expect(frame).not.toContain("[ $")
    expect(frame).not.toContain("stale-config")
  })

  it("follows the newly-active step when a running step passes underneath the pane", async () => {
    // First: check is running (auto-selected), integrate is still queued.
    const first: readonly StepState[] = [
      { name: "check", status: "running" },
      { name: "integrate", status: "requested" },
    ]
    // Then, same run: check passes and integrate starts running.
    const second: readonly StepState[] = [
      { name: "check", status: "passed" },
      { name: "integrate", status: "running" },
    ]

    // Sanity: on first mount the live step is `check`.
    expect(activeStepName(await renderOnce(first))).toBe("check")

    // Contract: the selected tab must follow the live step to `integrate`.
    const advanced = await renderAdvance(first, second)
    expect(activeStepName(advanced)).toBe("integrate")

    // Expansion follows the live step too: the freshly-active step's RUN LOGS
    // is open, so its streamed output is visible.
    expect(advanced).toContain("live integrate output")
  })

  it("folds a step's log once that step completes in the same run", async () => {
    // A single step: running (log auto-open) then passed (log must auto-fold).
    const first: readonly StepState[] = [{ name: "check", status: "running" }]
    const second: readonly StepState[] = [{ name: "check", status: "passed" }]

    // While running, the log is open — the streamed output renders.
    expect(await renderOnce(first)).toContain("live check output")

    // Once the step passes in the same run, a completed step folds: the output
    // disappears behind the collapsed accordion (no OUTPUT heading remains).
    const advanced = await renderAdvance(first, second)
    expect(advanced).not.toContain("live check output")
  })

  it("selects the live step on a fresh mount, mirroring a new-run remount", async () => {
    // A new run remounts the component (`key={detailData.run}`), which drops
    // every override — so a first paint always lands on the live step.
    const started: readonly StepState[] = [
      { name: "check", status: "passed" },
      { name: "integrate", status: "running" },
    ]
    expect(activeStepName(await renderOnce(started))).toBe("integrate")
  })
})

// The selection/fold resolvers are the seam where operator intent meets the
// live derivation. Testing them directly pins the preservation half of the
// 21106 contract (an explicit pick/toggle survives status advances) without an
// input harness: the component wires each resolver to a `useState` that only a
// user tab pick / log toggle writes.
describe("queue step tabs override resolution (21106 preservation)", () => {
  const names = ["prepare", "check", "integrate"] as const

  it("follows the live step when the operator has not picked a tab", () => {
    expect(resolveStepTabSelection(names, "check", null)).toBe("check")
    expect(resolveStepTabSelection(names, "integrate", null)).toBe("integrate")
  })

  it("preserves an explicit tab pick even as the live step advances", () => {
    // Operator pinned the completed `prepare` tab; the live step later moves to
    // `integrate`, but their pick stands.
    expect(resolveStepTabSelection(names, "check", "prepare")).toBe("prepare")
    expect(resolveStepTabSelection(names, "integrate", "prepare")).toBe("prepare")
  })

  it("falls back to the live step when a pinned step no longer exists", () => {
    expect(resolveStepTabSelection(names, "integrate", "gone")).toBe("integrate")
  })

  it("follows live fold state until the operator toggles a log", () => {
    // No toggle: running/attention steps open, completed steps fold.
    expect(resolveStepLogExpanded(true, undefined)).toBe(true)
    expect(resolveStepLogExpanded(false, undefined)).toBe(false)
  })

  it("preserves an explicit log toggle across status changes", () => {
    // Operator expanded a completed step's log (auto would fold it) — it stays.
    expect(resolveStepLogExpanded(false, true)).toBe(true)
    // Operator collapsed a running step's log (auto would open it) — it stays.
    expect(resolveStepLogExpanded(true, false)).toBe(false)
  })
})
