/**
 * @failure A new candidateFailure() code ships unclassified, so a composition
 * refusal is silently misrouted (needs-author vs infra-retry vs recut-lineage)
 * or double-classified — the partition drifts without anyone noticing.
 * @level l2
 * @consumer @yrd/queue
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { COMPOSITION_FAILURE_BUCKETS } from "../src/queue.ts"

const here = dirname(fileURLToPath(import.meta.url))
const commandSource = readFileSync(join(here, "..", "src", "command.ts"), "utf8")

/** Grep-derive the candidateFailure codes straight from command.ts — never a
 * hand-maintained list — so a NEW code turns this test red until it is
 * classified. `\s*` spans the newline of the multiline `candidateFailure(\n
 * "code"` calls as well as the inline form. */
function derivedCandidateFailureCodes(): readonly string[] {
  const codes = new Set<string>()
  for (const match of commandSource.matchAll(/candidateFailure\(\s*"([a-z][a-z-]*)"/g)) {
    if (match[1] !== undefined) codes.add(match[1])
  }
  return [...codes].toSorted()
}

const BUCKETS = Object.entries(COMPOSITION_FAILURE_BUCKETS) as ReadonlyArray<readonly [string, ReadonlySet<string>]>

describe("composition failure buckets — the partition is total and disjoint", () => {
  it("derives a non-empty candidateFailure code set from command.ts", () => {
    const codes = derivedCandidateFailureCodes()
    // Guard against a regex/refactor that silently derives nothing (which would
    // make every assertion below vacuously pass).
    expect(codes.length).toBeGreaterThan(10)
    expect(codes).toContain("authored-gitlink")
    expect(codes).toContain("source-publish")
  })

  it("classifies every derived candidateFailure code into exactly one bucket", () => {
    for (const code of derivedCandidateFailureCodes()) {
      const owning = BUCKETS.filter(([, set]) => set.has(code)).map(([name]) => name)
      expect(owning, `code '${code}' must be classified into exactly one bucket, got [${owning.join(", ")}]`).toHaveLength(
        1,
      )
    }
  })

  it("declares no phantom bucket code that command.ts never produces", () => {
    const derived = new Set(derivedCandidateFailureCodes())
    for (const [name, set] of BUCKETS) {
      for (const code of set) {
        expect(derived.has(code), `bucket '${name}' declares '${code}' which no candidateFailure() produces`).toBe(true)
      }
    }
  })

  it("routes source-publish to infra-retry, not needs-author (a push/update-ref blip is transient)", () => {
    expect(COMPOSITION_FAILURE_BUCKETS["infra-retry"].has("source-publish")).toBe(true)
    expect(COMPOSITION_FAILURE_BUCKETS["needs-author"].has("source-publish")).toBe(false)
  })
})
