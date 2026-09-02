/**
 * @failure A refusal code lands nowhere the registry knows about — reachable
 * from the SAME sites that feed a persisted Run/Job failure, it silently bills
 * the author (or worse, now throws unexpectedly) because nobody registered it.
 * @level l2
 * @consumer @yrd/cli, @yrd/queue
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { FailureKind } from "@yrd/core"
import {
  canonicalRefusalCode,
  COMPOSITION_FAILURE_BUCKETS,
  YRD_REFUSAL_CODES,
  YRD_REFUSAL_CODE_ALIASES,
} from "../src/queue.ts"
import { failureDisposition } from "../../yrd-cli/src/status-presentation.ts"
import { actionableFailure, formatHumanFailure } from "../../yrd-cli/src/actionable-error.ts"

const here = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(here, "..", "..")
/** A message carrying no check headline and no artifact path, so anything
 * check-shaped in the rendered output came from the CODE, never the text. */
const PROBE_MESSAGE = "yrd: this refusal names no check and no output log"

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue
      walk(path, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(path)
    }
  }
}

/** Every `src/` TypeScript source under `packages/`, path -> text, read once. */
function scannedSources(): ReadonlyMap<string, string> {
  const files: string[] = []
  for (const pkgDir of readdirSync(packagesRoot)) {
    const src = join(packagesRoot, pkgDir, "src")
    try {
      if (statSync(src).isDirectory()) walk(src, files)
    } catch {
      continue
    }
  }
  return new Map(files.map((file) => [file, readFileSync(file, "utf8")]))
}

/** The literal shape a refusal code has — the same one the `code: "..."` census matches. */
const REFUSAL_CODE_LITERAL = /^[a-z0-9-]+$/u

/**
 * String-literal constants the scanned sources declare, by identifier:
 * `const NAME = "…"` / `export const NAME = "…"`. A SCREAMING_CASE name declared
 * with anything other than a string literal (a number, a regex) is recorded as
 * `null`, so a `code: NAME` that resolves to it is known to be NOT a refusal
 * code rather than an unfollowable one.
 */
function declaredConstants(sources: ReadonlyMap<string, string>): ReadonlyMap<string, string | null> {
  const declared = new Map<string, string | null>()
  for (const source of sources.values()) {
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"\n]*)"|([^\s;]))/gu,
    )) {
      const [, name, literal] = match
      if (name === undefined) continue
      const value = literal ?? null
      const existing = declared.get(name)
      // Two declarations of one name with two different literals cannot be
      // followed honestly; keep the first and let the unfollowable check say so
      // if the ambiguity ever matters (none exists today).
      if (existing === undefined) declared.set(name, value)
    }
  }
  return declared
}

type EmittedCodeCensus = Readonly<{
  /** Every refusal code the sources emit, literal or constant-referenced, sorted. */
  codes: readonly string[]
  /**
   * SCREAMING_CASE identifiers used where a code is emitted that resolve to
   * NO declaration in the scanned sources. A code the census cannot follow is
   * exactly the blind spot the constant shape opened, so these are reported —
   * never skipped.
   */
  unfollowable: readonly string[]
}>

/** Grep-derive every code this codebase actually EMITS, straight from source
 * — never a hand-maintained list — so a new one turns this test red until it
 * is registered. The three producer shapes YRD_REFUSAL_CODES was built from:
 * object-literal `code: "..."`, `candidateFailure("...", …)`, and
 * `failed("...", …)` / `failedWithEvidence("...", …)` (both direct
 * `JobResult.error.code` constructors — `stale-base` and `check-failed` exist
 * ONLY through this last shape, never as a `code:` literal) — plus the SAME
 * three shapes with a CONSTANT in place of the literal (`code: SOME_CODE`),
 * followed to the constant's `const SOME_CODE = "…"` declaration in any scanned
 * source. A code emitted through an identifier is emitted all the same: the
 * receiver's `receiver-ref-nesting` (2026-09-01) was registered by hand only
 * because its author knew this census could not see it. Pure over `sources`,
 * so the blind spot itself has a test. */
function emittedCodesFromSources(sources: ReadonlyMap<string, string>): EmittedCodeCensus {
  const constants = declaredConstants(sources)
  const codes = new Set<string>()
  const unfollowable = new Set<string>()
  const emitConstant = (name: string): void => {
    const value = constants.get(name)
    if (value === undefined) {
      unfollowable.add(name)
      return
    }
    // Declared, but not as a refusal-code literal (a git exit code, an errno
    // string, a regex): not a code, not a blind spot.
    if (value !== null && REFUSAL_CODE_LITERAL.test(value)) codes.add(value)
  }
  for (const source of sources.values()) {
    for (const match of source.matchAll(/code:\s*"([a-z0-9-]+)"/g)) {
      if (match[1] !== undefined && match[1] !== "custom") codes.add(match[1]) // "custom" is Zod's ZodIssueCode, not ours
    }
    for (const match of source.matchAll(/candidateFailure\(\s*"([a-z][a-z-]*)"/g)) {
      if (match[1] !== undefined) codes.add(match[1])
    }
    for (const match of source.matchAll(/\bfailed(?:WithEvidence)?\(\s*"([a-z][a-z0-9._-]*)"/g)) {
      if (match[1] !== undefined) codes.add(match[1])
    }
    // The constant shapes. `(?![.\w(\[])` keeps `code: fact.code` / `code:
    // result.code` (a member read, dynamic by nature) out of the identifier
    // census; only a bare SCREAMING_CASE name is a constant reference.
    for (const match of source.matchAll(/code:\s*([A-Z][A-Z0-9_]*)\b(?![.\w(\[])/g)) {
      if (match[1] !== undefined) emitConstant(match[1])
    }
    for (const match of source.matchAll(/candidateFailure\(\s*([A-Z][A-Z0-9_]*)\b(?![.\w(\[])/g)) {
      if (match[1] !== undefined) emitConstant(match[1])
    }
    for (const match of source.matchAll(/\bfailed(?:WithEvidence)?\(\s*([A-Z][A-Z0-9_]*)\b(?![.\w(\[])/g)) {
      if (match[1] !== undefined) emitConstant(match[1])
    }
  }
  return { codes: [...codes].toSorted(), unfollowable: [...unfollowable].toSorted() }
}

function derivedEmittedCodes(): readonly string[] {
  return emittedCodesFromSources(scannedSources()).codes
}

/**
 * The FOURTH producer shape, and the one the three above are blind to:
 * `raiseFailure(kind, code, message)`. Its codes never become a persisted
 * Run/Job failure — they are CLI-invocation refusals — but they DO reach
 * `actionableFailure`, so they acquire a cure exactly the way a durable code
 * does, and one that ends in `-failed` acquires the CHECK cure through the
 * dynamic step-failure family without anyone registering anything.
 *
 * That is how five `-failed` codes in the gitlink-advance verb came to print
 * "The check judged the WORK, not the queue" for a refused git push while the
 * closed-vocabulary test above stayed green: `canonicalRefusalCode` resolved
 * them, just not to themselves.
 */
const FAILURE_KINDS = ["usage", "configuration", "refusal", "infrastructure"] as const satisfies readonly FailureKind[]

function isFailureKind(value: string): value is FailureKind {
  return (FAILURE_KINDS as readonly string[]).includes(value)
}

function derivedRaisedCodes(): readonly Readonly<{ kind: FailureKind; code: string }>[] {
  const files: string[] = []
  for (const pkgDir of readdirSync(packagesRoot)) {
    const src = join(packagesRoot, pkgDir, "src")
    try {
      if (statSync(src).isDirectory()) walk(src, files)
    } catch {
      continue
    }
  }
  const seen = new Map<string, { kind: FailureKind; code: string }>()
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/raiseFailure\(\s*"([a-z]+)"\s*,\s*"([a-z][a-z0-9-]*)"/g)) {
      const [, kind, code] = match
      // A first argument that is not a FailureKind means the regex matched
      // something that is not a raiseFailure call — drop it rather than carry a
      // fabricated kind into the assertions below.
      if (kind === undefined || code === undefined || !isFailureKind(kind)) continue
      if (!seen.has(code)) seen.set(code, { kind, code })
    }
  }
  return [...seen.values()].toSorted((a, b) => a.code.localeCompare(b.code))
}

describe("the refusal-code vocabulary is closed — every emitted code resolves", () => {
  it("derives a non-empty, substantial code set from source (guards against a regex/refactor derailing every assertion below)", () => {
    const codes = derivedEmittedCodes()
    expect(codes.length).toBeGreaterThan(100)
    expect(codes).toContain("checkpoint-migration-certificate-missing") // the motivating defect
    expect(codes).toContain("stale-base") // failed()-only — no code: literal anywhere
    expect(codes).toContain("check-failed") // failed()-only, same shape
  })

  it("resolves every derived emitted code to a registry member — canonical or alias", () => {
    for (const code of derivedEmittedCodes()) {
      expect(
        canonicalRefusalCode(code),
        `'${code}' is emitted but not registered in YRD_REFUSAL_CODES or YRD_REFUSAL_CODE_ALIASES`,
      ).toBeDefined()
    }
  })

  it("follows a code emitted through a CONSTANT to its literal — and would refuse an unregistered one", () => {
    // A source that emits a refusal code only as an identifier. Before the
    // constant shapes existed the census matched `code: "..."` alone, so this
    // emitted nothing, resolved nothing, and stayed green while unregistered.
    const sources = new Map([
      [
        "fake/src/emit.ts",
        [
          'export const PROBE_REFUSAL_CODE = "census-probe-unregistered"',
          'throw createFailure({ kind: "refusal", code: PROBE_REFUSAL_CODE, message: "probe" })',
          "",
        ].join("\n"),
      ],
    ])
    const census = emittedCodesFromSources(sources)
    expect(census.codes).toEqual(["census-probe-unregistered"])
    expect(census.unfollowable).toEqual([])
    // …and the registry gate above would go red on it, which is the whole point.
    expect(canonicalRefusalCode("census-probe-unregistered")).toBeUndefined()
  })

  it("follows a constant declared in ANOTHER scanned source, and ignores constants that are not refusal codes", () => {
    const sources = new Map([
      [
        "fake/src/codes.ts",
        'export const SHARED_CODE = "shared-constant-code"\nconst EXIT_CODE = 126\nconst ERRNO = "ETIMEDOUT"\n',
      ],
      [
        "fake/src/emit.ts",
        'import { SHARED_CODE } from "./codes.ts"\nrefuse({ code: SHARED_CODE })\nreturn { code: EXIT_CODE }\nObject.assign(error, { code: ERRNO })\n',
      ],
    ])
    const census = emittedCodesFromSources(sources)
    expect(census.codes).toEqual(["shared-constant-code"])
    expect(census.unfollowable).toEqual([])
  })

  it("reports a constant it cannot follow instead of skipping it", () => {
    const sources = new Map([["fake/src/emit.ts", "raise({ code: MYSTERY_CODE })\nconst other = fact.code\n"]])
    expect(emittedCodesFromSources(sources).unfollowable).toEqual(["MYSTERY_CODE"])
  })

  it("sees the receiver's constant-referenced code in the real tree — the blind spot measured 2026-09-01", () => {
    // `receiver-ref-nesting` is emitted ONLY as `code: RECEIVER_REF_NESTING_CODE`
    // (packages/yrd-bay/src/receiver.ts). On the literal-only census this line
    // fails: the code is registered, but nothing proved the census could see it.
    expect(derivedEmittedCodes()).toContain("receiver-ref-nesting")
    expect(emittedCodesFromSources(scannedSources()).unfollowable).toEqual([])
  })

  it("resolves every COMPOSITION_FAILURE_BUCKETS member — all four buckets, not just the two failureDisposition special-cases", () => {
    for (const [bucket, set] of Object.entries(COMPOSITION_FAILURE_BUCKETS)) {
      for (const code of set) {
        expect(canonicalRefusalCode(code), `bucket '${bucket}' code '${code}' is not registered`).toBeDefined()
      }
    }
  })

  it("classifies every derived emitted code without throwing", () => {
    for (const code of derivedEmittedCodes()) {
      expect(
        () => failureDisposition(code),
        `failureDisposition('${code}') threw for a code the codebase actually emits`,
      ).not.toThrow()
    }
  })

  it("every alias resolves to a canonical code that is ITSELF registered (no dangling alias target)", () => {
    for (const [alias, canonical] of Object.entries(YRD_REFUSAL_CODE_ALIASES)) {
      expect(
        (YRD_REFUSAL_CODES as readonly string[]).includes(canonical),
        `alias '${alias}' -> '${canonical}', but '${canonical}' is not a canonical member`,
      ).toBe(true)
    }
  })

  it("no alias key doubles as a canonical code (would be an ambiguous, redundant registration)", () => {
    const canonicalSet = new Set<string>(YRD_REFUSAL_CODES)
    for (const alias of Object.keys(YRD_REFUSAL_CODE_ALIASES)) {
      expect(canonicalSet.has(alias), `'${alias}' is registered as BOTH a canonical code and an alias key`).toBe(false)
    }
  })

  it("has no duplicate canonical entries (a copy-paste in the source array)", () => {
    expect(new Set(YRD_REFUSAL_CODES).size).toBe(YRD_REFUSAL_CODES.length)
  })

  it("fails loud on a code outside the closed vocabulary, mirroring lifecycleStatus/statusPresentationState", () => {
    expect(() => failureDisposition("totally-unregistered-made-up-code")).toThrow(/unknown failure code/u)
    expect(() => failureDisposition("totally-unregistered-made-up-code")).toThrow(/YRD_REFUSAL_CODES/u)
  })

  it("sees the raiseFailure() producer shape at all — the census was blind to it", () => {
    const codes = derivedRaisedCodes().map(({ code }) => code)
    expect(codes.length).toBeGreaterThan(100)
    // The blindness itself, as a control: the three ORIGINAL producer shapes
    // (`code: "..."`, `candidateFailure(...)`, `failed(...)`) see none of the
    // gitlink-advance verb's raised codes, so nothing above this line could
    // ever have gone red for them.
    expect(derivedEmittedCodes()).not.toContain("gitlink-stage-failed")
    expect(derivedEmittedCodes()).not.toContain("advance-branch-push-failed")
    // The gitlink-advance verb's own `-failed` codes: the five that fold onto
    // `check-failed` and print its cure for a git failure (yrd 9e6af249 /
    // 2fd122a9). Four were unregistered; `component-main-inspection-failed` is
    // the one that already resolved to itself, and rides here as the positive
    // control — a broken derivation would drop it along with the others.
    expect(codes).toEqual(
      expect.arrayContaining([
        "advance-branch-push-failed",
        "component-main-inspection-failed",
        "gitlink-commit-failed",
        "gitlink-stage-failed",
        "min-commit-publish-failed",
      ]),
    )
  })

  it("never lets a raised CLI code acquire the check cure it is not — rendered bytes, never the source string", () => {
    const wrong: string[] = []
    for (const { kind, code } of derivedRaisedCodes()) {
      if (code === "check-failed") continue
      const rendered = formatHumanFailure(actionableFailure({ kind, code, message: PROBE_MESSAGE }))
      if (rendered.includes("The check judged the WORK")) wrong.push(code)
    }
    expect(wrong, "these raised codes print the check-failed cure: " + wrong.join(", ")).toEqual([])
  })

  it("still classifies both spellings of a registered alias identically", () => {
    expect(failureDisposition("cancelled")).toEqual(failureDisposition("canceled"))
    expect(failureDisposition("environment-refused")).toEqual(failureDisposition("queue-environment-refused"))
    expect(failureDisposition("lease-timeout")).toEqual(failureDisposition("job-lease-expired"))
  })
})
