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
import {
  CHECK_STORAGE_EXHAUSTED,
  SCRATCH_ROOT_UNAVAILABLE,
  WORKTREE_STORAGE_EXHAUSTED,
} from "../src/scratch-storage.ts"

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
    expect(codes).toContain("min-commit-unpublished")
    expect(codes).toContain("composition-retired")
  })

  it("classifies every derived candidateFailure code into exactly one bucket", () => {
    for (const code of derivedCandidateFailureCodes()) {
      const owning = BUCKETS.filter(([, set]) => set.has(code)).map(([name]) => name)
      expect(
        owning,
        `code '${code}' must be classified into exactly one bucket, got [${owning.join(", ")}]`,
      ).toHaveLength(1)
    }
  })

  it("declares no phantom bucket code that command.ts never produces", () => {
    const derived = new Set(derivedCandidateFailureCodes())
    // Produced by other live mints, not candidateFailure — the submodule-main
    // promotion path (carrier-drops-landed) and the rebuild/record refusals
    // thrown via createFailure (payload-certificate) — still run/admission
    // error codes NEEDS_AUTHOR_CODES must classify.
    const promotionPathCodes = new Set([
      "carrier-drops-landed",
      "payload-certificate",
      "scratch-cleanup-failed",
      // The two identity refusals: thrown via queueRefusal/createFailure from
      // the candidate writer and the rebuild seam rather than returned as a
      // candidateFailure, and still author-curable run errors the bucket must
      // classify.
      "candidate-change-id-missing",
      "recut-change-id-missing",
      // The checkpoint-migration admission refusal: returned as a plain
      // `{ code, message }` from `checkpointMigrationAdmissionRefusal` on the
      // MERGE path rather than as a candidateFailure, and still a run/admission
      // error the buckets must classify — unbucketed it billed the author for a
      // certificate a check run mints.
      "checkpoint-migration-certificate-missing",
      "checkpoint-migration-certificate-stale",
    ])
    for (const [name, set] of BUCKETS) {
      for (const code of set) {
        if (promotionPathCodes.has(code)) {
          expect(commandSource).toContain(`"${code}"`)
          continue
        }
        // Produced by command.ts's `storageExhaustionResult` as a JobResult
        // error, through the `WORKTREE_STORAGE_EXHAUSTED` constant rather than
        // a literal — nothing here for the census above to see, so the live
        // producer is proved by name (2026-09-01: it sat unbucketed, billed to
        // the author, until the constant-following registry census caught it).
        if (code === WORKTREE_STORAGE_EXHAUSTED) {
          expect(commandSource).toContain("storageExhaustionError(")
          continue
        }
        // Same constant-only shape: the command runner's own storage verdict
        // (PR3159, 2026-09-01), emitted as `CHECK_STORAGE_EXHAUSTED`.
        if (code === CHECK_STORAGE_EXHAUSTED) {
          expect(commandSource).toContain("CHECK_STORAGE_EXHAUSTED")
          continue
        }
        // Thrown by scratch-storage.ts's `ensureScratchRoot` through the
        // `SCRATCH_ROOT_UNAVAILABLE` constant, from the command runner's spawn
        // seam (@i/10-yrd/24031) — the live producer is proved by the call.
        if (code === SCRATCH_ROOT_UNAVAILABLE) {
          expect(commandSource).toContain("ensureScratchRoot(")
          continue
        }
        expect(derived.has(code), `bucket '${name}' declares '${code}' which no candidateFailure() produces`).toBe(true)
      }
    }
  })

  it("keeps needs-author free of the retired certificate-era codes", () => {
    for (const retired of ["merge-tip-carrier", "source-publish", "composition-invalid", "recut-base-diverged"]) {
      for (const [, set] of BUCKETS) expect(set.has(retired)).toBe(false)
    }
  })

  // PR3159 (2026-09-01): an EDQUOT inside `affected-tests` retired the
  // submission as the author's. The filesystem's verdict is infrastructure.
  it.each([
    "carrier-inspection",
    "wrapper-generation",
    CHECK_STORAGE_EXHAUSTED,
    WORKTREE_STORAGE_EXHAUSTED,
    SCRATCH_ROOT_UNAVAILABLE,
  ])("routes %s to infra-retry rather than blaming the author", (code) => {
    expect(COMPOSITION_FAILURE_BUCKETS["infra-retry"].has(code)).toBe(true)
    expect(COMPOSITION_FAILURE_BUCKETS["needs-author"].has(code)).toBe(false)
  })
})
