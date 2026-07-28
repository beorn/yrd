/**
 * @failure A natural-order comparator that reorders differently from the collation it replaced silently rewrites every queue/PR listing; a reintroduced inline `{ numeric: true }` options object rebuilds an ICU collator per comparison and returns `yrd queue list` to multi-second CPU burn.
 * @level l1
 * @consumer @yrd/core
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { compareNatural } from "../src/order.ts"

/** The exact spelling `compareNatural` replaces. Ordering must be identical. */
function inlineNaturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0
}

/** Identifier shapes yrd actually sorts: run ids, PR ids, isolation children,
 * submission revisions, bay ids, branch-ish aliases, and mixed-width numbers. */
const CORPUS: readonly string[] = [
  "R0",
  "R1",
  "R2",
  "R9",
  "R10",
  "R11",
  "R41",
  "R41b",
  "R100",
  "R1000",
  "#1",
  "#9",
  "#10",
  "#988",
  "#1037",
  "#1207",
  "pr#4.1",
  "pr#4.2",
  "pr#4.10",
  "pr#40.1",
  "C1",
  "C10",
  "C2",
  "bay-1",
  "bay-10",
  "bay-2",
  "task/22501-collator-hoist",
  "task/2250-collator",
  "main",
  "origin/main",
  "wt0",
  "wt1",
  "wt10",
  "wt9",
  "",
  "0",
  "00",
  "01",
  "1",
  "007",
  "7",
  "a1b2",
  "a1b10",
  "a10b2",
  "A1",
  "a1",
  "Z9",
  "z10",
]

describe("compareNatural", () => {
  it("returns the same sign as the inline `{ numeric: true }` collation for every ordered pair", () => {
    const mismatches: string[] = []
    for (const left of CORPUS) {
      for (const right of CORPUS) {
        if (sign(compareNatural(left, right)) !== sign(inlineNaturalCompare(left, right))) {
          mismatches.push(`${JSON.stringify(left)} vs ${JSON.stringify(right)}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it("sorts a corpus byte-identically to the inline collation, ascending and descending", () => {
    expect(CORPUS.toSorted(compareNatural)).toEqual(CORPUS.toSorted(inlineNaturalCompare))
    expect(CORPUS.toSorted((left, right) => compareNatural(right, left))).toEqual(
      CORPUS.toSorted((left, right) => inlineNaturalCompare(right, left)),
    )
  })

  it("sorts a large generated id corpus byte-identically to the inline collation", () => {
    const generated = Array.from({ length: 4000 }, (_, index) => `R${(index * 7919) % 4001}`)
    expect(generated.toSorted(compareNatural)).toEqual(generated.toSorted(inlineNaturalCompare))
  })

  it("orders digits numerically rather than lexicographically", () => {
    expect(["R10", "R9", "R100", "R1"].toSorted(compareNatural)).toEqual(["R1", "R9", "R10", "R100"])
  })

  it("is a consistent total preorder (antisymmetric and reflexive)", () => {
    for (const left of CORPUS) {
      expect(sign(compareNatural(left, left))).toBe(0)
      for (const right of CORPUS) {
        // `+ 0` normalizes -0, which `toBe` (Object.is) would otherwise reject.
        expect(sign(compareNatural(left, right)) + sign(compareNatural(right, left))).toBe(0)
      }
    }
  })
})

function sourceFiles(): string[] {
  // `import.meta.dir` is Bun-only and undefined under vite-node; derive from the URL.
  const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path)
    }
  }
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, "src")
    if (existsSync(src) && statSync(src).isDirectory()) walk(src)
  }
  if (found.length === 0) throw new Error(`yrd: collator guard scanned '${packagesDir}' and found no source files`)
  return found
}

describe("collator hoist guard", () => {
  // `localeCompare(x, locales, options)` constructs and locale-canonicalizes a
  // fresh ICU collator on EVERY call. One `yrd queue list` made 3.49M such
  // calls, and `ucol_open` / `uloc_toLanguageTag` dominated the CPU sample.
  // `compareNatural` is the hoisted replacement; nothing in src/ may reopen the
  // per-comparison path. This test is the #undead pin: the defect regrew twice
  // before because nothing failed when it came back.
  it("finds no per-comparison collator construction in any package source", () => {
    // `[^()]` spans newlines, so a formatter that breaks the call across lines
    // cannot hide the third argument from this scan.
    const pattern = /\.localeCompare\(\s*[^()]*,\s*[^()]*,\s*\{/gu
    const offenders = sourceFiles().flatMap((file) => {
      // order.ts documents the defect it replaces; its mentions are prose, not calls.
      if (file.endsWith(join("yrd-core", "src", "order.ts"))) return []
      const source = readFileSync(file, "utf8")
      return [...source.matchAll(pattern)].flatMap((match) => {
        const line = source.slice(0, match.index).split("\n").length
        const text = source.slice(match.index, source.indexOf("\n", match.index))
        // An explicit `collator-hoist-allow:` comment on the same line records a
        // reviewed exception (e.g. a deliberately locale-pinned comparator).
        return text.includes("collator-hoist-allow:") ? [] : [`${file}:${line}: ${text.trim()}`]
      })
    })
    expect(offenders).toEqual([])
  })
})
