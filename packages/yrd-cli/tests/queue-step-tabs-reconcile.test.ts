// @failure Step tabs freeze selection/expansion and ignore same-run status updates
// @level l2
// @consumer @yrd/cli

import { createElement as h, useEffect, useState } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { queueShowData, type QueueShowData } from "../src/queue-status-view.tsx"
import { QueueWorkflowStepTabs, resolveStepLogExpanded, resolveStepTabSelection } from "../src/watch-pane.tsx"

// One PR / one run; the reconciliation contract (21106) is entirely about the
// run's step statuses moving underneath a still-mounted detail pane.
const STEP_PR = fixturePr("PR100", "submitted", "2026-07-13T11:30:00.000Z", "Reconcile the live step")

type StepState = Readonly<{ name: string; status: "requested" | "running" | "passed" }>

function stepTabsData(steps: readonly StepState[]): QueueShowData {
  const run = fixtureRun("R100", [STEP_PR], "running", "2026-07-13T11:40:00.000Z", {
    steps: steps.map((step) => fixtureStep(step.name, fixtureJob(`J100-${step.name}`, step.status))),
  })
  return queueShowData(run)
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
  return h(QueueWorkflowStepTabs, { data: stepTabsData(steps), outputs: [], compact: true, active: false })
}

async function renderAdvance(first: readonly StepState[], second: readonly StepState[]): Promise<string> {
  return renderString(h(SameRunAdvance, { first, second }), { width: 100, height: 40, plain: true })
}

async function renderOnce(steps: readonly StepState[]): Promise<string> {
  return renderString(
    h(QueueWorkflowStepTabs, { data: stepTabsData(steps), outputs: [], compact: true, active: false }),
    { width: 100, height: 40, plain: true },
  )
}

// The active step is read from the selected TabPanel's step-facts block: only
// the active panel renders its own `STEP <name>#<attempt> <status>` rows (the
// dedicated `ACTIVE STEP` row was removed when run/step facts split around the
// tabs — item G/H of the 2026-07-16 detail redesign; the tab labels themselves
// carry no `STEP …#` shape, so the marker is unambiguous).
function activeStepName(frame: string): string {
  const hit = frame.split("\n").find((row) => /\bSTEP \S+#/u.test(row))
  if (hit === undefined) throw new Error(`no STEP <name>#<attempt> row in frame:\n${frame}`)
  const match = /\bSTEP (\S+?)#/u.exec(hit)
  if (match === null) throw new Error(`could not read active step from: '${hit}'`)
  return match[1] as string
}

describe("queue step tabs same-run reconciliation (21106)", () => {
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

    // Expansion follows the live step too: the freshly-active step's LOG is
    // open, so its empty-output placeholder is visible.
    expect(advanced).toContain("Waiting for first output")
  })

  it("folds a step's log once that step completes in the same run", async () => {
    // A single step: running (log auto-open) then passed (log must auto-fold).
    const first: readonly StepState[] = [{ name: "check", status: "running" }]
    const second: readonly StepState[] = [{ name: "check", status: "passed" }]

    // While running, the log is open — the placeholder body renders.
    expect(await renderOnce(first)).toContain("Waiting for first output")

    // Once the step passes in the same run, a completed step folds: the body
    // disappears behind the collapsed accordion.
    const advanced = await renderAdvance(first, second)
    expect(activeStepName(advanced)).toBe("check")
    expect(advanced).not.toContain("Waiting for first output")
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
