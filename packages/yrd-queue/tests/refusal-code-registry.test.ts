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
import { YRD_QUEUE_AUDIT_FINDING_CODES } from "../src/model.ts"
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


/**
 * Registered codes that no source in this repository so much as NAMES, each
 * with the reason it stays registered anyway. Every entry is a deliberate,
 * argued decision; the test below holds the list to the truth in both
 * directions.
 *
 * WHAT THIS DOES NOT CATCH, stated because a guard whose reach is unknown is
 * worse than none: "unreferenced" is narrower than "producerless". A code whose
 * PRODUCER is gone but which some type or registry union still names — the way
 * `RunAuthority.released.reason` and INFRA_RETRY_FAILURE_CODES still name
 * `source-publish` — passes this test with its producer long dead. That class
 * is covered by the annotation convention at the registry line itself (see the
 * HISTORICAL-ONLY blocks in queue.ts), not here.
 *
 * WHY THIS LIST HAS TO EXIST. The census above runs one way only — every code
 * the source EMITS must be registered — so nothing noticed when a producer was
 * DELETED and its registry entry stayed. Fifteen had accumulated by 2026-08-28,
 * five of them audit-finding codes the S7 record-store sweep (9352d8d7) removed
 * from YRD_QUEUE_AUDIT_FINDING_CODES in the very same commit that deleted the
 * `findings.push` writing them. A list is not evidence about a population: this
 * file's other tests are what made the emitted set trustworthy, and this test is
 * the same discipline applied to the direction nobody was watching.
 *
 * DELETE vs KEEP is decided by ONE question, and it is a question about the
 * READ path: does retained data still CARRY this code? `failureDisposition`
 * throws on an unregistered code, deliberately, rather than guessing a
 * disposition — so unregistering a code that any stored row still names crashes
 * a reader, while keeping a dead entry costs one annotated line.
 *
 * "DOES ANYTHING STILL EMIT IT" IS THE WRONG QUESTION. A producer can retire
 * while its rows outlive it, so source evidence — no producer, no `code:`
 * literal, a git log naming the commit that deleted the emitter — cannot settle
 * what is already written down. Only the journal can.
 *
 * ASK IT AS A STRUCTURED VALUE, NOT A SUBSTRING, and this is the part that cost
 * real time. Measuring `draft-stranded` as free text over this deployment's
 * journal returns 11 rows, and every one is the string appearing somewhere that
 * is not a failure code — a branch name (`task/watcher-consumes-draft-stranded-…`)
 * and a commit title from the work that BUILT the feature. Queried as the value
 * it would actually occupy, `"code":"draft-stranded"` returns ZERO.
 *
 * A CONTROL THAT SHARES THE FLAW VALIDATES NOTHING. The free-text run was
 * trusted because `stale-base` came back 2 — but `"code":"stale-base"` is also
 * zero, so those 2 were free text too. The control proved the query RAN; it
 * could not distinguish the failure that mattered, because it went down the
 * same broken path. Use a control that would come back DIFFERENT if the
 * instrument were wrong: `"code":"candidate-conflicting"` returns 135
 * structured, which is what makes a structured zero mean something.
 *
 * A ZERO STILL DOES NOT WIDEN TO ALL HISTORY. `history_evicted_through` was
 * 27,609: evicted rows cannot be re-read, so a structured zero describes the
 * surviving window. That is a reason to weigh a recently-live producer
 * carefully, not a reason to keep every dead code forever.
 */
const UNREFERENCED_REGISTRY_CODES: Readonly<Record<string, string>> = {
  "derived-record-lane": "derived/record arbitration refusal; producer deleted with the record store (9352d8d7)",
  "invalid-config-module": "flow-module config loader refusal; loader deleted with flows (f6d79e39)",
  "mock-mismatch": "test-fixture-only (queue-watch-round6.test.ts) — the fixture's error.code must classify",
  "publication-failed": "`pr publish --queue` Job error; verb and producer deleted with the record lane",
  "publication-unavailable": "same publication Job family; same deletion",
  "recut-current-changed": "recut candidate refusal; retired with the rewrite machinery (c146f903)",
  "visual-rejected": "test-fixture-only, same narrative family as mock-mismatch",
}

/** Registered codes with no `"code"` literal anywhere under any package's
 * `src` tree except the registry array itself. Deliberately a QUOTED-literal search rather
 * than the shape-aware grep above, and that is a correction, not laziness: the
 * shape list missed `carrier-drops-landed`, which reaches a real JobError as a
 * bare positional argument to `submoduleMainFailure(...)`, and reporting a live
 * code as producerless is exactly the false absence this file exists to stop.
 * Prose mentions do not rescue an entry — every retired code below is discussed
 * in comments, and none of those comments quote it. */
function unreferencedRegistryCodes(): readonly string[] {
  const files: string[] = []
  for (const pkgDir of readdirSync(packagesRoot)) {
    const src = join(packagesRoot, pkgDir, "src")
    try {
      if (statSync(src).isDirectory()) walk(src, files)
    } catch {
      continue
    }
  }
  const registry = readFileSync(join(packagesRoot, "yrd-queue", "src", "queue.ts"), "utf8")
  const registryStart = registry.indexOf("export const YRD_REFUSAL_CODES = [")
  if (registryStart < 0) throw new Error("YRD_REFUSAL_CODES declaration is gone; re-anchor this test")
  const registryEnd = registry.indexOf("] as const", registryStart)
  if (registryEnd < 0) throw new Error("YRD_REFUSAL_CODES has no terminator; re-anchor this test")
  const registryBlock = registry.slice(registryStart, registryEnd)
  const sources = files.map((file) => {
    const source = readFileSync(file, "utf8")
    return file.endsWith(join("yrd-queue", "src", "queue.ts")) ? source.replace(registryBlock, "") : source
  })
  return (YRD_REFUSAL_CODES as readonly string[])
    .filter((code) => !sources.some((source) => source.includes(`"${code}"`)))
    .toSorted()
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

  it("registers every audit finding code, so a finding never throws on a presentation path", () => {
    // The registry states this invariant in prose beside `submodule-alternates-*`
    // and nothing enforced it, which is how five codes stayed registered after
    // S7 removed them from the audit vocabulary. Exact and cheap, both ways.
    for (const code of YRD_QUEUE_AUDIT_FINDING_CODES) {
      expect(
        (YRD_REFUSAL_CODES as readonly string[]).includes(code),
        `audit finding code '${code}' is not registered in YRD_REFUSAL_CODES`,
      ).toBe(true)
    }
  })

  it("annotates every registered code no source names at all, and annotates nothing else", () => {
    const unreferenced = unreferencedRegistryCodes()
    // BOTH directions on purpose. Left to right: a code whose producer was
    // deleted must be deleted here too or argued for in writing — it may not
    // simply sit there. Right to left: an annotated code that GAINS a producer
    // must lose its annotation, so the list cannot rot into fiction.
    expect(unreferenced).toEqual(Object.keys(UNREFERENCED_REGISTRY_CODES).toSorted())
    for (const reason of Object.values(UNREFERENCED_REGISTRY_CODES)) expect(reason.length).toBeGreaterThan(20)
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
