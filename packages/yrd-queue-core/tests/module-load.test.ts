import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * run.ts, rings.ts and with-notify.ts import one another. Vitest's import order
 * hid a with-notify.ts module-init read of a run.ts constant that the yrd CLI,
 * which loads run.ts first, hit as a use before initialization (24977). Only a
 * fresh process loads a module the way an entry does, so every entry of the two
 * packages is loaded in its own, and the executable itself is run.
 */
const packages = resolve(import.meta.dirname, "../..")
const yrdBin = resolve(packages, "../bin/yrd.ts")

function exportedEntries(name: string): string[] {
  const manifest = JSON.parse(readFileSync(resolve(packages, name, "package.json"), "utf8")) as {
    exports: Record<string, string>
  }
  return Object.values(manifest.exports).map((entry) => resolve(packages, name, entry))
}

const entries = [
  ...exportedEntries("yrd-queue-core"),
  ...exportedEntries("yrd-cli"),
  resolve(packages, "yrd-cli/src/cli.ts"), // what bin/yrd.ts imports
  resolve(packages, "yrd-queue-core/src/run.ts"), // the module the 24977 cycle broke when loaded first
]

function load(path: string) {
  return spawnSync("bun", ["-e", `await import(${JSON.stringify(path)})`], { encoding: "utf8" })
}

describe("the yrd packages load in a fresh process, as their entries are loaded", () => {
  it("has entries to load", () => {
    expect(entries.length).toBeGreaterThanOrEqual(4)
  })

  it.each(entries.map((path) => [path.slice(packages.length + 1), path]))("loads %s first", (_, path) => {
    const loaded = load(path)
    expect(loaded.stderr).not.toMatch(/before initialization/)
    expect(loaded.status).toBe(0)
  })

  it("runs the yrd executable", () => {
    const ran = spawnSync("bun", [yrdBin, "--help"], { encoding: "utf8" })
    expect(ran.stderr).not.toMatch(/before initialization/)
    expect(ran.stdout).toMatch(/^Usage: yrd/m)
    expect(ran.status).toBe(0)
  })
})
