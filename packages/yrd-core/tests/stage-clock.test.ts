/**
 * The stage clock exists so a reader can add the rows up. Spans nest and cannot
 * be summed, and a partial breakdown reads as full coverage — before this, the
 * one instrumented window in `queue ls` reported ~135ms of a ~7400ms command.
 * These pin the two properties that make the table trustworthy: nested stages
 * are charged SELF time so the rows never double-count, and whatever is still
 * uninstrumented shows up as `unaccountedMs` instead of vanishing.
 */
import { beforeEach, describe, expect, test } from "vitest"
import { resetStageClock, stage, stageAsync, stageReport } from "../src/stage-clock.ts"

/** Burn wall-clock without sleeping, so the numbers are real elapsed time. */
function spin(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    /* busy */
  }
}

/** Yield the wall clock instead of holding it, so several stages can be open
 * over the SAME milliseconds — which busy-spinning cannot reproduce. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  resetStageClock()
})

describe("stage clock", () => {
  test("charges a nested stage to itself, never twice", () => {
    stage("outer", () => {
      spin(20)
      stage("inner", () => spin(30))
      spin(20)
    })
    const report = stageReport()
    // outer's own work is ~40ms; the 30ms inner belongs to inner alone.
    expect(report.stages.outer).toBeGreaterThan(25)
    expect(report.stages.outer).toBeLessThan(70)
    expect(report.stages.inner).toBeGreaterThan(20)
    expect(report.stages.inner).toBeLessThan(60)
    // The defining property: rows sum, so nesting cannot inflate the table.
    expect(report.accountedMs).toBeLessThan(90)
  })

  test("rows plus unaccountedMs reconstruct the total exactly", () => {
    stage("a", () => spin(10))
    stage("b", () => spin(10))
    const report = stageReport()
    expect(report.accountedMs + report.unaccountedMs).toBeCloseTo(report.totalMs, 1)
  })

  test("uninstrumented work merges in unaccountedMs rather than disappearing", () => {
    spin(40) // nobody's stage
    stage("measured", () => spin(10))
    const report = stageReport()
    expect(report.unaccountedMs).toBeGreaterThan(30)
    expect(report.accountedMs).toBeLessThan(report.totalMs)
  })

  test("repeated entries into one stage accumulate", () => {
    for (let i = 0; i < 3; i += 1) stage("repeated", () => spin(10))
    expect(stageReport().stages.repeated).toBeGreaterThan(20)
  })

  test("a throwing stage still owns the time it burned", () => {
    expect(() =>
      stage("boom", () => {
        spin(15)
        throw new Error("nope")
      }),
    ).toThrow("nope")
    expect(stageReport().stages.boom).toBeGreaterThan(10)
  })

  test("async stages accumulate across awaits", async () => {
    await stageAsync("async-stage", async () => {
      spin(10)
      await Promise.resolve()
      spin(10)
    })
    expect(stageReport().stages["async-stage"]).toBeGreaterThan(15)
  })

  // Crossing lifetimes make the per-stage split approximate. The instrument
  // must SAY so and must not take the command down with it — `yrd watch` can
  // have a deferred history scan in flight while a render starts, and a
  // profiler that can kill the product is worse than an approximate number.
  test("counts crossed lifetimes instead of throwing", async () => {
    // `first` opens first and closes first, so when it closes, `second` is on
    // top of the stack — the frames interleave instead of nesting.
    const first = stageAsync("first", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    const second = stageAsync("second", async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    await expect(Promise.all([first, second])).resolves.toBeDefined()
    const report = stageReport()
    expect(report.crossedStages).toBeGreaterThan(0)
    // Still reconciles, so the table remains readable even when approximate.
    expect(report.accountedMs + report.unaccountedMs).toBeCloseTo(report.totalMs, 1)
  })

  test("reports crossedStages: 0 when every stage nested cleanly", () => {
    stage("outer", () => stage("inner", () => spin(5)))
    expect(stageReport().crossedStages).toBe(0)
  })

  // Concurrent stages are the norm now that every span opens one: the queue
  // runs Git subprocesses in parallel. Wall clock cannot be given to all of
  // them, and the model that charged each its full elapsed reported 402ms of a
  // 101ms window — a table claiming four times the time that passed. Charging
  // only the innermost stage keeps the rows disjoint; `crossedStages` is what
  // tells the reader the split between the overlapping ones is approximate.
  test("concurrent stages never sum past the window they measured", async () => {
    const startedAt = performance.now()
    await Promise.all([0, 1, 2, 3].map((i) => stageAsync(`parallel-${String(i)}`, () => sleep(60))))
    const window = performance.now() - startedAt
    const report = stageReport()
    // The negative control: the previous model returned ~4x the window here.
    expect(report.accountedMs).toBeLessThanOrEqual(window + 5)
    expect(report.crossedStages).toBeGreaterThan(0)
    // And nothing vanished — the window itself is still accounted for.
    expect(report.accountedMs).toBeGreaterThan(window / 2)
  })

  test("accountedMs never exceeds totalMs, whatever the interleaving", async () => {
    stage("plain", () => spin(10))
    await Promise.all([stageAsync("a", () => sleep(30)), stageAsync("b", () => sleep(10))])
    stage("after", () => spin(10))
    const report = stageReport()
    expect(report.accountedMs).toBeLessThanOrEqual(report.totalMs)
    expect(report.unaccountedMs).toBeGreaterThanOrEqual(0)
  })
})
