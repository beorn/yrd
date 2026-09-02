/**
 * @failure Two surfaces answered "did this revision land?" from two derivations.
 *          `queueSnapshot` (240ea10f) reads the Run's own merge proof to drop a
 *          landed change's `ready` row; `queue recover` reads it to close that
 *          change's still-open record. Written twice they drift, and this is the
 *          exact fact they would drift on — PR3216 merged in R3766 at 06:36 on
 *          2026-09-02 and its record stayed `submitted` with `checks: queued`
 *          for hours, alongside PR2462 (R3605) and PR2145 (R3590) since 08-28.
 * @level l1
 * @consumer @yrd/queue queue-status-projection (runProvesMerge, queueSnapshot) · queue (recover)
 */
import { describe, expect, it } from "vitest"
import { runProvesMerge } from "../src/queue-status-projection.ts"
import type { Run } from "../src/model.ts"

const PROOF = { commit: "b".repeat(40), baseSha: "a".repeat(40) }
const MERGE_STEP = { name: "merge", kind: "merge" }
const CHECK_STEP = { name: "check", kind: "check" }

const asRun = (run: Partial<Run>): Pick<Run, "steps" | "integration"> => run as unknown as Run

describe("one rule decides whether a Run landed its members (L2)", () => {
  it("a merge step plus its proof is the whole rule", () => {
    expect(runProvesMerge(asRun({ steps: [CHECK_STEP, MERGE_STEP], integration: PROOF } as never))).toBe(true)
  })

  it("no proof is no landing — a run can reach completed with nothing to merge", () => {
    expect(runProvesMerge(asRun({ steps: [CHECK_STEP, MERGE_STEP] } as never))).toBe(false)
  })

  it("no merge step is no landing, whatever else the run carries", () => {
    expect(runProvesMerge(asRun({ steps: [CHECK_STEP], integration: PROOF } as never))).toBe(false)
  })

  it("neither status nor conclusion is consulted — a run that failed a LATER step still landed", () => {
    // The gate that would have broken the two surfaces apart: recovery needs
    // its own settlement conditions ON TOP of this, and must not fold them in.
    for (const extra of [
      { status: "completed", conclusion: "failure" },
      { status: "in_progress" },
      { status: "waiting" },
    ]) {
      expect(runProvesMerge(asRun({ steps: [MERGE_STEP], integration: PROOF, ...extra } as never))).toBe(true)
    }
  })

  it("an already-landed proof still proves the revision is on the base", () => {
    // It is not a merge this queue PERFORMED — `queueSnapshot` excludes it from
    // the last-merge clock, and recovery routes it to `pr/already-landed` — but
    // the revision is settled either way, so this rule says yes.
    const alreadyLanded = { ...PROOF, alreadyLanded: { candidateSha: "c".repeat(40) } }
    expect(runProvesMerge(asRun({ steps: [MERGE_STEP], integration: alreadyLanded } as never))).toBe(true)
  })
})
