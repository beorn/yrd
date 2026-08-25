import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { isTracked, type Change } from "../src/model.ts"

const change = (overrides: Partial<Change>): Change => ({ ...overrides }) as Change

describe("isTracked", () => {
  it("reads an explicit bit through", () => {
    expect(isTracked(change({ track: true }))).toBe(true)
    expect(isTracked(change({ track: false }))).toBe(false)
  })

  it("an absent bit resolves to the fleet default (untracked until tracked-delivery step 2 flips it)", () => {
    expect(isTracked(change({}))).toBe(false)
  })
})

describe("isTracked is the only behavioral reader of Change.track", () => {
  const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const rawReadPattern = /\b(?:pr|change|targetedPr)\.track\b/

  const sourceFiles = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
      else if (entry.endsWith(".ts")) out.push(path)
    }
    return out
  }

  it("no raw Change.track read survives outside model.ts", () => {
    const packageDirs = readdirSync(packagesRoot).filter((entry) => {
      const src = join(packagesRoot, entry, "src")
      try {
        return statSync(src).isDirectory()
      } catch {
        return false
      }
    })
    expect(packageDirs.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const pkg of packageDirs) {
      for (const file of sourceFiles(join(packagesRoot, pkg, "src"))) {
        if (file.endsWith(join("yrd-bay", "src", "model.ts"))) continue
        const source = readFileSync(file, "utf8")
        if (rawReadPattern.test(source)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
