/**
 * The stage breakdown must count everything the command already times.
 *
 * The defect these pin: `setup`, `acquire`, `materialize`, `submodules:walk`
 * and `queue:compose` were timed as spans and printed in the same log, while
 * the breakdown reported their several seconds as `unaccountedMs` — 99% of a
 * 48s pass declared uninstrumented when it was instrumented and merely not
 * summed. The unwrapped-logger test below is the negative control: it is what
 * the breakdown said before `withStageAccounting` existed, and it still says it
 * for any logger nobody wrapped.
 */
import { createLogger } from "loggily"
import { beforeEach, describe, expect, test } from "vitest"
import { resetStageClock, stageReport } from "../src/stage-clock.ts"
import { withStageAccounting } from "../src/stage-spans.ts"

/** Burn wall-clock without sleeping, so the numbers are real elapsed time. */
function spin(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    /* busy */
  }
}

/** A logger shaped like the host's: spans on, output discarded. */
function silentLogger() {
  return createLogger("yrd", [
    { level: "debug", spans: true },
    { write: () => {}, objectMode: false },
  ])
}

beforeEach(() => {
  resetStageClock()
})

describe("spans are the stage breakdown's source", () => {
  test("a span opens a stage under the namespace its SPAN line prints", () => {
    const log = withStageAccounting(silentLogger())
    {
      using _span = log.child("setup").span?.(undefined, { phase: "pre-worktree" })
      spin(20)
    }
    const report = stageReport()
    // The row is named exactly as `SPAN yrd:setup` reads, so a reader matching
    // the log against the table does not have to translate.
    expect(Object.keys(report.stages)).toContain("yrd:setup")
    expect(report.stages["yrd:setup"]).toBeGreaterThan(10)
  })

  test("NEGATIVE CONTROL: an unwrapped logger's spans stay unaccounted", () => {
    const log = silentLogger()
    {
      using _span = log.child("setup").span?.(undefined, { phase: "pre-worktree" })
      spin(20)
    }
    const report = stageReport()
    // This is the bug verbatim: the span was created and timed, and the
    // breakdown has nothing to say about it.
    expect(Object.keys(report.stages)).toHaveLength(0)
    expect(report.accountedMs).toBe(0)
  })

  test("nested spans are charged disjointly, never once per level", () => {
    const log = withStageAccounting(silentLogger())
    const queue = log.child("queue")
    {
      // The real shape: walk inside submodules:materialize inside acquire.
      using _acquire = queue.span?.("acquire", { ref: "trunk" })
      spin(20)
      {
        using _materialize = queue.child("submodules").span?.("materialize", {})
        spin(20)
        {
          using _walk = queue.child("submodules").span?.("walk", {})
          spin(30)
        }
      }
    }
    const report = stageReport()
    expect(Object.keys(report.stages).sort()).toEqual([
      "yrd:queue:acquire",
      "yrd:queue:submodules:materialize",
      "yrd:queue:submodules:walk",
    ])
    // Each level owns only its own work — summing the rows must not exceed the
    // ~70ms the whole nest took, which is what double-counting would do (~160).
    expect(report.accountedMs).toBeLessThan(120)
    expect(report.stages["yrd:queue:submodules:walk"]).toBeGreaterThan(20)
    expect(report.stages["yrd:queue:acquire"]).toBeLessThan(60)
  })

  test("a span ended explicitly and then disposed is charged once", () => {
    const log = withStageAccounting(silentLogger())
    const span = log.child("compose").span?.(undefined, {})
    spin(20)
    // observeYrdLifecycle ends in a `finally`; `using` sites dispose. A span
    // that takes both paths must not pay twice.
    span?.end()
    span?.[Symbol.dispose]()
    spin(20)
    const report = stageReport()
    expect(report.stages["yrd:compose"]).toBeGreaterThan(10)
    expect(report.stages["yrd:compose"]).toBeLessThan(35)
  })

  test("children and nested spans inherit the accounting without a call site knowing", () => {
    const log = withStageAccounting(silentLogger())
    {
      using outer = log.child("queue").span?.("compose", {})
      spin(10)
      {
        // A span created FROM a span: three levels from the wrapped root.
        using _inner = outer?.span?.("plan", {})
        spin(20)
      }
    }
    const report = stageReport()
    expect(Object.keys(report.stages)).toContain("yrd:queue:compose:plan")
    expect(report.stages["yrd:queue:compose:plan"]).toBeGreaterThan(10)
  })

  test("no span object, no stage — a default-level run is unchanged", () => {
    const log = withStageAccounting(
      createLogger("yrd", [
        { level: "warn", spans: false },
        { write: () => {}, objectMode: false },
      ]),
    )
    expect(log.child("setup").span?.(undefined, {})).toBeUndefined()
    spin(10)
    expect(stageReport().accountedMs).toBe(0)
  })
})
