// @failure Step tabs freeze selection/expansion and ignore same-run status updates
// @level l2
// @consumer @yrd/cli

import { createElement as h, useEffect, useState } from "react"
import { renderString } from "silvery"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { queueShowData, type QueueShowData } from "../src/queue-status-view.tsx"
import { QueueWorkflowStepTabs, resolveStepTabSelection } from "../src/watch-pane.tsx"
import type { QueueArtifactOutput } from "../src/watch-pane.tsx"

// One PR / one run; the reconciliation contract (21106) is entirely about the
// run's step statuses moving underneath a still-mounted detail pane.
const STEP_PR = fixturePr("PR100", "submitted", "2026-07-13T11:30:00.000Z", "Reconcile the live step")

type StepState = Readonly<{
  name: string
  status: "requested" | "running" | "passed" | "failed"
  error?: Readonly<{ code: string; message: string }>
  artifacts?: readonly Readonly<{ kind: string; uri: string }>[]
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
          ...(step.artifacts === undefined ? {} : { artifacts: step.artifacts }),
          ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
          ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
        }),
      ),
    ),
  })
  return queueShowData(run)
}

// Each step streams distinctly-named inline output so the active step remains
// readable without the removed RUN LOGS / OUTPUT accordion chrome.
function stepOutputs(steps: readonly StepState[]): readonly QueueArtifactOutput[] {
  return steps.map((step) => ({
    source: "recorded",
    run: "R100",
    step: step.name,
    attempt: 1,
    path: `/repo/.git/yrd/artifacts/R100/${step.name}/attempt-1/output.log`,
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
    prs: [STEP_PR],
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
      prs: [STEP_PR],
    }),
    { width: 100, height: 40, plain: true },
  )
}

async function renderSelected(steps: readonly StepState[], name: string): Promise<string> {
  const app = createRenderer({ cols: 100, rows: 40 })(
    h(QueueWorkflowStepTabs, {
      data: stepTabsData(steps),
      outputs: stepOutputs(steps),
      compact: true,
      active: true,
      prs: [STEP_PR],
    }),
  )
  try {
    await app.waitForLayoutStable()
    const rows = app.text.split("\n")
    const y = rows.findIndex((row) => row.includes(name))
    const x = rows[y]?.indexOf(name) ?? -1
    if (x < 0 || y < 0) throw new Error(`missing tab '${name}' in frame:\n${app.text}`)
    await app.click(x, y)
    await app.waitForLayoutStable()
    return app.text
  } finally {
    app.unmount()
  }
}

describe("queue step tabs same-run reconciliation (21106)", () => {
  it("keeps status and duration on compact equal-width two-row tabs", async () => {
    const startedAt = "2026-07-13T11:30:00.000Z"
    const frame = await renderOnce([
      { name: "prepare", status: "passed", startedAt, finishedAt: "2026-07-13T11:30:27.000Z" },
      { name: "check", status: "passed", startedAt, finishedAt: "2026-07-13T11:30:42.000Z" },
      { name: "integrate", status: "passed", startedAt, finishedAt: "2026-07-13T11:30:15.000Z" },
    ])
    const rows = frame.split("\n")
    const tabRowIndex = rows.findIndex((row) => row.includes("1: prepare") && row.includes("3: integrate"))
    const tabRow = rows[tabRowIndex] ?? ""
    const prepareX = tabRow.indexOf("1: prepare")
    const checkX = tabRow.indexOf("2: check", prepareX)
    const integrateX = tabRow.indexOf("3: integrate", checkX)
    const firstStride = checkX - prepareX
    const secondStride = integrateX - checkX
    expect(firstStride).toBeLessThan(20)
    expect(Math.abs(firstStride - secondStride)).toBeLessThanOrEqual(2)

    const statusRow = rows[tabRowIndex + 1] ?? ""
    const segment = statusRow.slice(prepareX)
    const durations = [...segment.matchAll(/\b(?:27s|42s|15s)\b/gu)]
    expect(durations.map((match) => match[0])).toEqual(["27s", "42s", "15s"])
    const ends = durations.map((match) => (match.index ?? -1) + match[0].length)
    expect(ends[0]).toBe((ends[1] ?? 0) - firstStride)
    expect(ends[1]).toBe((ends[2] ?? 0) - secondStride)
  })

  it("keeps detailed failure text in the active pane content, never in the tab label", async () => {
    const frame = await renderSelected(
      [
        {
          name: "check",
          status: "failed",
          error: { code: "check-failed", message: "typecheck found three unsafe assignments" },
        },
        { name: "integrate", status: "requested" },
      ],
      "1: check",
    )
    const tabRow = frame.split("\n").find((row) => row.includes("check") && row.includes("integrate")) ?? ""
    expect(tabRow).not.toContain("typecheck found three unsafe assignments")
    expect(frame).toContain("typecheck found three unsafe assignments")
  })

  it("selects the failing/latest-output step and marks unstarted successors canceled", async () => {
    const failed = fixtureStep(
      "check",
      fixtureJob("J101-check", "failed", {
        requestedAt: "2026-07-13T11:39:00.000Z",
        startedAt: "2026-07-13T11:40:00.000Z",
        finishedAt: "2026-07-13T11:42:00.000Z",
        error: { code: "check-failed", message: "focused tests failed" },
      }),
    )
    const successor = fixtureStep("integrate")
    const run = fixtureRun("R101", [STEP_PR], "failed", "2026-07-13T11:40:00.000Z", {
      finishedAt: "2026-07-13T11:42:00.000Z",
      error: { code: "check-failed", message: "focused tests failed" },
      steps: [failed, successor],
    })
    const outputs: readonly QueueArtifactOutput[] = [
      {
        source: "recorded",
        run: "R101",
        step: "check",
        attempt: 1,
        path: "/repo/.git/yrd/artifacts/R101/check/attempt-1/stderr.log",
        text: "the failing assertion is immediately visible\n",
      },
    ]
    const frame = await renderString(
      h(QueueWorkflowStepTabs, {
        data: queueShowData(run),
        outputs,
        compact: true,
        active: false,
        prs: [STEP_PR],
      }),
      { width: 110, height: 40, plain: true },
    )

    expect(frame).toContain("the failing assertion is immediately visible")
    expect(frame).toMatch(/1: check\s+2: integrate/u)
    expect(frame).toMatch(/× failed(?:\s+\S+)?\s+− canceled/u)
    expect(frame).not.toMatch(/2: integrate[\s\S]*○ (?:queued|requested)/u)
  })

  it("renders proof-file and full-output links beside the selected step's inline tail", async () => {
    const stdoutUri = "artifact://R100/check/attempt-1/stdout.log"
    const steps: readonly StepState[] = [
      {
        name: "check",
        status: "failed",
        error: { code: "check-failed", message: "vitest failed" },
        artifacts: [{ kind: "stdout", uri: stdoutUri }],
      },
    ]
    const app = createRenderer({ cols: 120, rows: 40 })(
      h(QueueWorkflowStepTabs, {
        data: stepTabsData(steps),
        outputs: stepOutputs(steps),
        compact: true,
        active: true,
        prs: [STEP_PR],
      }),
    )
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      const y = rows.findIndex((row) => row.includes("1: check"))
      const x = rows[y]?.indexOf("1: check") ?? -1
      if (x < 0 || y < 0) throw new Error(`missing check tab in frame:\n${app.text}`)
      await app.click(x, y)
      await app.waitForLayoutStable()

      expect(app.text).toContain("art:stdout")
      expect(app.text).toContain("open full log")
      expect(app.text).toContain("live check output")
    } finally {
      app.unmount()
    }
  })

  it("shows the run's recorded command instead of a newer config value", async () => {
    const data = stepTabsData([{ name: "check", status: "running" }])
    const app = createRenderer({ cols: 100, rows: 30 })(
      h(QueueWorkflowStepTabs, {
        data,
        outputs: [],
        commands: { check: "bun test:stale-config" },
        compact: true,
        active: true,
        prs: [STEP_PR],
      }),
    )
    await app.waitForLayoutStable()
    const [tabRow = ""] = app.text.split("\n").filter((row) => row.includes("1: check"))
    await app.click(tabRow.indexOf("1: check"), app.text.split("\n").indexOf(tabRow))
    await app.waitForLayoutStable()
    const frame = app.text
    app.unmount()
    expect(frame).toContain("$ bun vitest run")
    expect(frame).not.toContain("COMMAND $ ")
    expect(frame).not.toContain("[ $")
    expect(frame).not.toContain("stale-config")
  })

  it("follows the live step as the runtime step advances underneath the pane", async () => {
    // First: check is running (auto-selected as the live step), integrate is still queued.
    const first: readonly StepState[] = [
      { name: "check", status: "running" },
      { name: "integrate", status: "requested" },
    ]
    // Then, same run: check passes and integrate starts running.
    const second: readonly StepState[] = [
      { name: "check", status: "passed" },
      { name: "integrate", status: "running" },
    ]

    // A fresh mount selects the running step and streams its output; the
    // synthetic `0: submit` tab is gone in round 6.
    const initial = await renderOnce(first)
    expect(initial).not.toContain("0: submit")
    expect(initial).toContain("live check output")

    // A same-run advance moves the un-pinned selection to the newly running step.
    const advanced = await renderAdvance(first, second)
    expect(advanced).not.toContain("0: submit")
    expect(advanced).toContain("live integrate output")
  })

  it("keeps a step's output expanded once that step completes in the same run", async () => {
    // A single step: running then passed; round 6 removes log folding entirely.
    const first: readonly StepState[] = [{ name: "check", status: "running" }]
    const second: readonly StepState[] = [{ name: "check", status: "passed" }]

    // While running, the streamed output renders.
    expect(await renderSelected(first, "1: check")).toContain("live check output")

    // Once the step passes in the same run, the evidence remains visible.
    const advanced = await renderSelected(second, "1: check")
    expect(advanced).toContain("live check output")
  })

  it("selects the live step on a fresh mount, mirroring a new-run remount", async () => {
    const started: readonly StepState[] = [
      { name: "check", status: "passed" },
      { name: "integrate", status: "running" },
    ]
    const frame = await renderOnce(started)
    expect(frame).not.toContain("0: submit")
    expect(frame).toContain("live integrate output")
  })
})

// The selection resolver is the seam where operator intent meets live
// derivation. Output is no longer foldable in round 6.
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
})
