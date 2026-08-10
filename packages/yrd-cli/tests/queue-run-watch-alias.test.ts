/**
 * @failure The resident queue runner emits compatibility warnings even though its no-selector invocation is the sole public resident spelling.
 * @level l2
 * @consumer @yrd/cli queue run
 */
import { describe, expect, it } from "vitest"
import { followQueueRuns } from "../src/run.ts"
import { createResponseResidentHarness as harness } from "./support/resident-harness.ts"

describe("queue run — one resident spelling", () => {
  it("runs the no-selector resident loop without compatibility warnings", async () => {
    const h = harness([
      () => {
        h.drain()
        return Promise.resolve([])
      },
    ])

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    expect(h.runCalls()).toBe(1)
    expect(h.warnings).toEqual([])
  })
})
