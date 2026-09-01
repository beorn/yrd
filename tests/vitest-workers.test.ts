import { describe, expect, it } from "vitest"
import { DEFAULT_VITEST_MAX_WORKERS, resolveVitestMaxWorkers } from "../vitest-workers.ts"

// The requirement: a yrd Vitest run is capped by default, at the same number
// the root, km and ag configs use, so an uncapped run cannot come back as a
// habit anyone has to remember (@chief, 2026-09-01: 31 workers, load 59).
describe("yrd vitest worker cap", () => {
  it("caps a wide host at the shared default", () => {
    expect(DEFAULT_VITEST_MAX_WORKERS).toBe(6)
    expect(resolveVitestMaxWorkers({}, 32)).toBe(6)
  })

  it("leaves one core free on a narrow host, never below one worker", () => {
    expect(resolveVitestMaxWorkers({}, 4)).toBe(3)
    expect(resolveVitestMaxWorkers({}, 1)).toBe(1)
  })

  it("honours an explicit positive VITEST_MAX_WORKERS and ignores junk", () => {
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "2" }, 32)).toBe(2)
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "12" }, 32)).toBe(12)
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "0" }, 32)).toBe(6)
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "many" }, 32)).toBe(6)
  })
})
