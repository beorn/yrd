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
import { REAL_ID_CORPUS } from "./real-id-corpus.ts"

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

// The synthetic corpus above proves the comparator is well-formed. It cannot
// prove that ordering is preserved for the strings this system actually emits —
// only real data does that, and the queue is the merge authority, so a silent
// reorder is a correctness incident, not a cosmetic one.
describe("compareNatural on real journal identifiers", () => {
  it("has a corpus covering every identifier shape yrd sorts", () => {
    // A shrunken or mis-regenerated fixture must fail here rather than pass
    // vacuously below.
    expect(REAL_ID_CORPUS.length).toBeGreaterThanOrEqual(400)
    const shapes: Record<string, RegExp> = {
      run: /^R\d+$/u,
      pr: /^PR\d+$/u,
      candidate: /^C\d+$/u,
      bay: /^B\d+$/u,
      issue: /^@/u,
      branch: /^(?:task\/|wt\d)/u,
      timestamp: /^\d{4}-\d{2}-\d{2}T/u,
      sha: /^[0-9a-f]{40}$/u,
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-/u,
    }
    const missing = Object.entries(shapes)
      .filter(([, pattern]) => !REAL_ID_CORPUS.some((value) => pattern.test(value)))
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  it("sorts real identifiers byte-identically to the inline collation it replaced", () => {
    expect(REAL_ID_CORPUS.toSorted(compareNatural)).toEqual(REAL_ID_CORPUS.toSorted(inlineNaturalCompare))
    expect(REAL_ID_CORPUS.toSorted((left, right) => compareNatural(right, left))).toEqual(
      REAL_ID_CORPUS.toSorted((left, right) => inlineNaturalCompare(right, left)),
    )
  })

  it("agrees on the sign of every real ordered pair", () => {
    const mismatches: string[] = []
    for (const left of REAL_ID_CORPUS) {
      for (const right of REAL_ID_CORPUS) {
        if (sign(compareNatural(left, right)) !== sign(inlineNaturalCompare(left, right))) {
          mismatches.push(`${JSON.stringify(left)} vs ${JSON.stringify(right)}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it("shows that a blanket conversion of bare `localeCompare` would NOT be inert", () => {
    // The 41 remaining bare `localeCompare(other)` call sites are deliberately
    // left alone. This asserts the reason: on the same real values, numeric
    // collation genuinely reorders them, so converting those sites would be a
    // behaviour change disguised as a performance fix.
    const ids = REAL_ID_CORPUS.filter((value) => /^(?:R|PR|C|B)\d+$/u.test(value))
    expect(ids.length).toBeGreaterThan(50)
    expect(ids.toSorted(compareNatural)).not.toEqual(ids.toSorted((left, right) => left.localeCompare(right)))
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

/**
 * Every `.localeCompare(` in `source`, with the number of top-level arguments
 * it was called with.
 *
 * A regex cannot do this. `[^()]` between the commas lets
 * `a.localeCompare(b(c), undefined, { … })` through, and widening it to `[^;]`
 * is worse: this codebase is formatted without semicolons, so that pattern runs
 * to the end of the file and matches anything. Counting nesting is the only
 * spelling that is both sound and complete here.
 */
function localeCompareArity(source: string): readonly { index: number; arity: number }[] {
  const calls: { index: number; arity: number }[] = []
  const needle = ".localeCompare("
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    let depth = 1
    let arity = 1
    let cursor = at + needle.length
    if (source[cursor] === ")") {
      calls.push({ index: at, arity: 0 })
      continue
    }
    for (; cursor < source.length && depth > 0; cursor++) {
      const char = source[cursor]
      if (char === "(" || char === "[" || char === "{") depth += 1
      else if (char === ")" || char === "]" || char === "}") depth -= 1
      else if (char === "," && depth === 1) arity += 1
    }
    if (depth !== 0) throw new Error(`yrd: collator guard could not balance a localeCompare call at offset ${at}`)
    calls.push({ index: at, arity })
  }
  return calls
}

describe("collator hoist guard", () => {
  // `localeCompare(x, locales, options)` constructs and locale-canonicalizes a
  // fresh ICU collator on EVERY call. One `yrd queue list` made 3.49M such
  // calls, and `ucol_open` / `uloc_toLanguageTag` dominated the CPU sample.
  // `compareNatural` is the hoisted replacement; nothing in src/ may reopen the
  // per-comparison path. This test is the #undead pin: the defect regrew twice
  // before because nothing failed when it came back.
  it("finds no per-comparison collator construction in any package source", () => {
    const offenders = sourceFiles().flatMap((file) => {
      // order.ts documents the defect it replaces; its mentions are prose, not calls.
      if (file.endsWith(join("yrd-core", "src", "order.ts"))) return []
      const source = readFileSync(file, "utf8")
      return localeCompareArity(source).flatMap(({ index, arity }) => {
        // Two-or-fewer arguments is the cached-collator fast path; only the
        // three-argument form (locales + options) reopens ICU per comparison.
        if (arity < 3) return []
        const line = source.slice(0, index).split("\n").length
        const rowEnd = source.indexOf("\n", index)
        const text = source.slice(index, rowEnd === -1 ? undefined : rowEnd)
        // An explicit `collator-hoist-allow:` comment on the same line records a
        // reviewed exception (e.g. a deliberately locale-pinned comparator).
        return text.includes("collator-hoist-allow:") ? [] : [`${file}:${line}: ${text.trim()}`]
      })
    })
    expect(offenders).toEqual([])
  })

  it("keeps `Intl.Collator` construction in exactly one place", () => {
    // The localeCompare scan above only catches one spelling of the defect. A
    // `new Intl.Collator(...)` built inside a comparator body costs exactly the
    // same and would read as a fix. `order.ts` owns the single instance, so any
    // other construction site is the regression, whatever it is called.
    const constructions = sourceFiles().flatMap((file) => {
      if (file.endsWith(join("yrd-core", "src", "order.ts"))) return []
      const source = readFileSync(file, "utf8")
      return [...source.matchAll(/new\s+Intl\.Collator\s*\(/gu)].map(
        (match) => `${file}:${source.slice(0, match.index).split("\n").length}`,
      )
    })
    expect(constructions).toEqual([])
  })
})
