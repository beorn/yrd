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
import {
  canonicalRefusalCode,
  COMPOSITION_FAILURE_BUCKETS,
  YRD_REFUSAL_CODES,
  YRD_REFUSAL_CODE_ALIASES,
} from "../src/queue.ts"
import { failureDisposition } from "../../yrd-cli/src/status-presentation.ts"

const here = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(here, "..", "..")

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

/** Grep-derive every code this codebase actually EMITS, straight from source
 * — never a hand-maintained list — so a new one turns this test red until it
 * is registered. Same three producer shapes YRD_REFUSAL_CODES was built from:
 * object-literal `code: "..."`, `candidateFailure("...", …)`, and
 * `failed("...", …)` / `failedWithEvidence("...", …)` (both direct
 * `JobResult.error.code` constructors — `stale-base` and `check-failed` exist
 * ONLY through this last shape, never as a `code:` literal). */
function derivedEmittedCodes(): readonly string[] {
  const files: string[] = []
  for (const pkgDir of readdirSync(packagesRoot)) {
    const src = join(packagesRoot, pkgDir, "src")
    try {
      if (statSync(src).isDirectory()) walk(src, files)
    } catch {
      continue
    }
  }
  const codes = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/code:\s*"([a-z0-9-]+)"/g)) {
      if (match[1] !== undefined && match[1] !== "custom") codes.add(match[1]) // "custom" is Zod's ZodIssueCode, not ours
    }
    for (const match of source.matchAll(/candidateFailure\(\s*"([a-z][a-z-]*)"/g)) {
      if (match[1] !== undefined) codes.add(match[1])
    }
    for (const match of source.matchAll(/\bfailed(?:WithEvidence)?\(\s*"([a-z][a-z0-9._-]*)"/g)) {
      if (match[1] !== undefined) codes.add(match[1])
    }
  }
  return [...codes].toSorted()
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

  it("still classifies both spellings of a registered alias identically", () => {
    expect(failureDisposition("cancelled")).toEqual(failureDisposition("canceled"))
    expect(failureDisposition("environment-refused")).toEqual(failureDisposition("queue-environment-refused"))
    expect(failureDisposition("lease-timeout")).toEqual(failureDisposition("job-lease-expired"))
  })
})
