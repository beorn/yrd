import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * run.ts, rings.ts and with-notify.ts import one another. Vitest's import order
 * hid a with-notify.ts module-init read of a run.ts constant that the yrd CLI,
 * which loads run.ts first, hit as a use before initialization (24977). A fresh
 * process importing run.ts alone is that order.
 */
describe("the queue core's import cycle", () => {
  it("loads with run.ts first, as the yrd CLI loads it", () => {
    const run = resolve(import.meta.dirname, "../src/run.ts")
    const loaded = spawnSync("bun", ["-e", `await import(${JSON.stringify(run)})`], { encoding: "utf8" })
    expect(loaded.stderr).not.toMatch(/before initialization/)
    expect(loaded.status).toBe(0)
  })
})
