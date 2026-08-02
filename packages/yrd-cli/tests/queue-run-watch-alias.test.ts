/**
 * @failure The deprecated `queue run --watch` alias stops entering follow mode, drops its one-time deprecation warn, or spams it — breaking the resident runner + relaunch recipes kept alive across the #62 cutover.
 * @level l2
 * @consumer @yrd/cli queue run --watch alias
 */
import { describe, expect, it } from "vitest"
import { followQueueRuns } from "../src/run.ts"
import { createResponseResidentHarness as harness } from "./support/resident-harness.ts"

const DEPRECATION = "--watch is no longer needed; queue run already follows by default."

describe("queue run --watch — deprecated no-op alias of follow", () => {
  it("enters follow mode and emits exactly one deprecation warn, loggily-only", async () => {
    // The responder drains one cycle then flips the abort signal so the follow
    // loop returns — a deterministic single observation of both mode entry and
    // warn emission. (Closure captures `h`; it runs only after `h` is assigned.)
    const h = harness([
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1, watch: true }, h.io, h.gate)).resolves.toBe(0)

    // (a) --watch entered follow mode: it ran a drain cycle, it did not refuse.
    expect(h.runCalls()).toBe(1)
    // (b) exactly ONE deprecation warn, with the exact contract text and typed
    // action — and NO bare 'yrd:' stderr duplicate (the resident logs loggily-only).
    const deprecations = h.warnings.filter((warn) => warn.message === DEPRECATION)
    expect(deprecations).toHaveLength(1)
    expect(deprecations[0]?.props).toMatchObject({ action: "queue-run-watch-deprecated" })
    expect(h.stderr.join("")).toBe("")
  })

  it("follow without the --watch alias emits no deprecation warn", async () => {
    const h = harness([
      () => {
        h.signal.aborted = true
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    expect(h.runCalls()).toBe(1)
    expect(h.warnings).toEqual([])
  })
})
