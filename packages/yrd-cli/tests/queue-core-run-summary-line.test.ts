/**
 * @failure 29679 defect 3: a passing round's summary line printed a standing note about how the queue was
 *          OBSERVED — "Child observation is not configured for …; native Git observes the root queue only." —
 *          as though it were part of the round's RESULT. Every `pass:` line in the 2026-10-16 garage logs
 *          carried it, so a clean round read as if something was wrong. The note already has its own routes
 *          (the `yrd:queue:observation` DEBUG row, and the `invalid` observation's stderr line, which are
 *          unchanged), so the summary line carries the result and nothing else.
 * @level   l1
 * @consumer anyone reading a round's `pass:`/`fail:`/`stuck:` line, in a service log or a terminal
 * @reach   none
 * @testonly describeRun: exported so a focused test reads a round's summary line without running a whole round
 */
import { describe, expect, it } from "vitest"
import type { GitObservation } from "@yrd/queue-core"
import { describeRun } from "../src/queue-core-commands.ts"

const LOG = "/var/log/yrd/q-20261017T012910948Z-bc8094be.jsonl"
const OBSERVATION: GitObservation = {
  contract: "native",
  message:
    "Child observation is not configured for https://github.com/beorn/hh-dev.git#refs/heads/main; " +
    "native Git observes the root queue only.",
  notices: [],
}

const base = {
  exitCode: 0,
  merged: [] as readonly string[],
  failed: [] as readonly string[],
  stuck: [] as readonly string[],
  directMerges: [] as readonly string[],
  log: LOG,
  observation: OBSERVATION,
}

describe("a round's summary line", () => {
  it("says the round passed with nothing to do, and no note about how it was observed", () => {
    const line = describeRun(base)
    expect(line).toBe(`pass: nothing to do (log ${LOG})`)
    expect(line, "the child-observation note belongs to its own route, never to the result").not.toContain(
      "Child observation is not configured",
    )
  })

  it("says what a round merged, and still no note about how it was observed", () => {
    const line = describeRun({ ...base, merged: ["task/chief-29669"] })
    expect(line).toBe(`pass: merged task/chief-29669 (log ${LOG})`)
    expect(line).not.toContain("Child observation is not configured")
  })

  it("names a failed round's changes without the note", () => {
    const line = describeRun({ ...base, exitCode: 1, failed: ["task/one"] })
    expect(line).toBe(`fail: failed task/one (log ${LOG})`)
  })
})
