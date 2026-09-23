/**
 * What a step row SAYS (@i/10-yrd/25303 box 1). A step is timed like a check:
 * its start row says it is running, so a long compose reads as running rather
 * than hung, and its end row says how long it took. Without a line of its own
 * a step row would render as a bare kind with nothing a reader can use.
 */

import { describe, expect, it } from "vitest"
import { summarize } from "../src/queue-core-commands.ts"

describe("a step row's line", () => {
  it("says a step started, then how long it ran", () => {
    const about = { branch: "task/x", head: "0123456789abcdef", name: "compose", phase: "merge" }
    expect(summarize("step", { ...about, start: "2026-09-23T21:00:00.000Z" })).toBe(
      "compose started for task/x at 0123456789ab",
    )
    expect(summarize("step", { ...about, end: "2026-09-23T21:00:12.000Z", ms: 12034 })).toBe(
      "compose ran for task/x at 0123456789ab in 12034 ms",
    )
  })

  it("names the run's target for the queue read, which is no change's step", () => {
    const read = { base: "fedcba9876543210", name: "read", phase: "run", target: "main" }
    expect(summarize("step", { ...read, start: "2026-09-23T21:00:00.000Z" })).toBe(
      "read started for main at fedcba987654",
    )
    expect(summarize("step", { ...read, ms: 310 })).toBe("read ran for main at fedcba987654 in 310 ms")
  })
})
