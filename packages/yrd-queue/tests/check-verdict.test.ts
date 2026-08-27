/**
 * @failure A required check that ran could leave NO durable trace: the
 * pre-submit leg journaled nothing (PR1970 — four checks ran, one failed, sole
 * record one agent's /tmp file), a terminal withdrawal hid the journaled
 * request and forbade any later verdict write (PR2085), and a derived member's
 * only verdict evidence was retention-pruned jobs/runs. `check/verdict` is the
 * durable content-keyed home (@i/10-merge-queue/failed-check-erased boxes
 * 1+3). This file is stage 1 of the approved design: the pure fold's replay
 * convergence (A5), the recording command's idempotency predicate (A6), and
 * the read ladder's refusal to render absence as evidence (A11) — proven
 * while only tests call the module, before the identity-moving door commit
 * registers anything.
 * @level l1
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import type { JobError } from "@yrd/job"
import {
  CheckVerdictSchema,
  checkVerdictAlreadyRecorded,
  checkVerdictSurfaceStatus,
  checkVerdictTreeKey,
  emptyCheckVerdicts,
  foldCheckVerdictFact,
  latestVerdictForTree,
  projectVerdictCheckRecords,
  verdictEligibilityStatus,
  verdictsForHead,
  verdictsForTree,
  type CheckVerdictFact,
  type CheckVerdictsState,
} from "../src/check-verdict.ts"

const HEAD = "1abc".repeat(10)
const OTHER_HEAD = "2abc".repeat(10)
const BASE = "3abc".repeat(10)
const OTHER_BASE = "4abc".repeat(10)
const T0 = "2026-08-26T10:00:00.000Z"
const T1 = "2026-08-26T10:01:00.000Z"
const T2 = "2026-08-26T10:02:00.000Z"

const receipt: JobError = { code: "required-check-failed", message: "'affected-tests' exited 1" }

function fact(overrides: Record<string, unknown> = {}): CheckVerdictFact {
  return CheckVerdictSchema.parse({
    headSha: HEAD,
    baseSha: BASE,
    step: "affected-tests",
    leg: "admission",
    status: "passed",
    by: "yrd/runner:test",
    ...overrides,
  })
}

describe("CheckVerdictSchema", () => {
  it("parses a minimal tree-local pre-submit verdict (no base — the PR1970 leg)", () => {
    const parsed = fact({ baseSha: undefined, leg: "pre-submit", exitCode: 0 })
    expect(parsed.baseSha).toBeUndefined()
    expect(parsed.leg).toBe("pre-submit")
  })

  it("refuses a non-passing verdict without a receipt — an unexplained failure is the erasure again", () => {
    for (const status of ["failed", "infrastructure"] as const) {
      expect(() => fact({ status })).toThrow(/receipt/u)
    }
    expect(fact({ status: "failed", receipt, exitCode: 1 }).receipt).toEqual(receipt)
    expect(
      fact({
        status: "infrastructure",
        receipt: { code: "runner-died", message: "previous habitant runner disappeared" },
      }).status,
    ).toBe("infrastructure")
  })

  it("refuses unknown keys and non-sha identities", () => {
    expect(() => fact({ verdict: "passed" })).toThrow()
    expect(() => fact({ headSha: "not-a-sha" })).toThrow()
  })
})

describe("checkVerdictTreeKey", () => {
  it("keys by content with an absent base spelled '-', which no sha can collide with", () => {
    expect(checkVerdictTreeKey(HEAD, BASE, "check")).toBe(`${HEAD}:${BASE}:check`)
    expect(checkVerdictTreeKey(HEAD, undefined, "check")).toBe(`${HEAD}:-:check`)
    expect(() => CheckVerdictSchema.parse({ ...fact(), baseSha: "-" })).toThrow()
  })
})

describe("foldCheckVerdictFact — A5 replay convergence", () => {
  it("tolerates the absent slice: undefined folds like empty and reads answer empty, never evidence", () => {
    expect(verdictsForTree(undefined, HEAD, BASE, "check")).toEqual([])
    expect(latestVerdictForTree(undefined, HEAD, BASE, "check")).toBeUndefined()
    expect(verdictsForHead(undefined, HEAD)).toEqual([])
    const folded = foldCheckVerdictFact(undefined, fact(), T0)
    expect(verdictsForTree(folded, HEAD, BASE, "affected-tests")).toHaveLength(1)
  })

  it("appends attempts in frame order under one key, stamping the frame clock", () => {
    const failed = fact({ status: "failed", receipt, exitCode: 1 })
    let state = foldCheckVerdictFact(emptyCheckVerdicts, failed, T0)
    state = foldCheckVerdictFact(state, fact(), T1)
    const rows = verdictsForTree(state, HEAD, BASE, "affected-tests")
    expect(rows.map((row) => [row.status, row.at])).toEqual([
      ["failed", T0],
      ["passed", T1],
    ])
    expect(latestVerdictForTree(state, HEAD, BASE, "affected-tests")?.status).toBe("passed")
  })

  it("dedupes a producer ref by returning the input state unchanged, same reference", () => {
    const first = foldCheckVerdictFact(emptyCheckVerdicts, fact({ ref: "recover:J1:2" }), T0)
    const again = foldCheckVerdictFact(first, fact({ ref: "recover:J1:2", status: "failed", receipt }), T1)
    expect(again).toBe(first)
    expect(verdictsForTree(again, HEAD, BASE, "affected-tests")).toHaveLength(1)
  })

  it("keeps distinct trees, bases and steps in distinct keys", () => {
    let state: CheckVerdictsState = emptyCheckVerdicts
    state = foldCheckVerdictFact(state, fact(), T0)
    state = foldCheckVerdictFact(state, fact({ baseSha: OTHER_BASE }), T0)
    state = foldCheckVerdictFact(state, fact({ baseSha: undefined, leg: "pre-submit" }), T0)
    state = foldCheckVerdictFact(state, fact({ step: "typecheck" }), T0)
    state = foldCheckVerdictFact(state, fact({ headSha: OTHER_HEAD }), T0)
    expect(Object.keys(state)).toHaveLength(5)
    expect(verdictsForTree(state, HEAD, BASE, "affected-tests")).toHaveLength(1)
    expect(verdictsForTree(state, HEAD, undefined, "affected-tests")).toHaveLength(1)
  })

  it("converges: refolding the same frame sequence reproduces the incrementally built state, without mutating inputs", () => {
    const frames: readonly (readonly [CheckVerdictFact, string])[] = [
      [fact({ leg: "pre-submit", baseSha: undefined, status: "failed", receipt, exitCode: 1 }), T0],
      [fact({ ref: "settle:J1:1" }), T0],
      [fact({ ref: "settle:J1:1" }), T1],
      [
        fact({
          step: "typecheck",
          status: "infrastructure",
          receipt: { code: "runner-died", message: "previous habitant runner disappeared" },
          ref: "recover:J2:1",
        }),
        T1,
      ],
      [fact({ headSha: OTHER_HEAD, leg: "carrier", run: "R1", job: "J3" }), T2],
      [fact({ ref: "recover:J2:1", step: "typecheck" }), T2],
    ]
    let incremental: CheckVerdictsState | undefined
    for (const [payload, at] of frames) {
      incremental = foldCheckVerdictFact(Object.freeze(incremental), payload, at)
    }
    let replayed: CheckVerdictsState | undefined
    for (const [payload, at] of frames) replayed = foldCheckVerdictFact(replayed, payload, at)
    expect(replayed).toEqual(incremental)
    expect(verdictsForTree(incremental, HEAD, BASE, "typecheck")).toHaveLength(1)
    expect(verdictsForTree(incremental, HEAD, BASE, "affected-tests")).toHaveLength(1)
  })
})

describe("checkVerdictAlreadyRecorded — A6 idempotency", () => {
  it("answers false on an empty or absent slice", () => {
    expect(checkVerdictAlreadyRecorded(undefined, fact())).toBe(false)
    expect(checkVerdictAlreadyRecorded(emptyCheckVerdicts, fact())).toBe(false)
  })

  it("matches by producer ref when one is carried", () => {
    const state = foldCheckVerdictFact(undefined, fact({ ref: "settle:J1:1" }), T0)
    expect(checkVerdictAlreadyRecorded(state, fact({ ref: "settle:J1:1", status: "failed", receipt }))).toBe(true)
    expect(checkVerdictAlreadyRecorded(state, fact({ ref: "settle:J1:2" }))).toBe(false)
  })

  it("matches a refless fact by whole payload, ignoring the stored frame clock", () => {
    const state = foldCheckVerdictFact(undefined, fact({ exitCode: 0 }), T0)
    expect(checkVerdictAlreadyRecorded(state, fact({ exitCode: 0 }))).toBe(true)
    expect(checkVerdictAlreadyRecorded(state, fact({ exitCode: 1 }))).toBe(false)
    expect(checkVerdictAlreadyRecorded(state, fact({ exitCode: 0, baseSha: OTHER_BASE }))).toBe(false)
  })
})

describe("verdict ladder leg — absence is never evidence (A11)", () => {
  const steps = ["affected-tests", "typecheck"]

  it("yields nothing for an empty step list, an absent slice, or a tree with no verdicts", () => {
    expect(verdictEligibilityStatus(undefined, HEAD, BASE, [])).toBeUndefined()
    expect(verdictEligibilityStatus(undefined, HEAD, BASE, steps)).toBeUndefined()
    expect(verdictEligibilityStatus(emptyCheckVerdicts, HEAD, BASE, steps)).toBeUndefined()
  })

  it("one red gate settles the revision failed, whatever the other steps say", () => {
    let state = foldCheckVerdictFact(undefined, fact({ step: "affected-tests" }), T0)
    state = foldCheckVerdictFact(state, fact({ step: "typecheck", status: "failed", receipt }), T1)
    expect(verdictEligibilityStatus(state, HEAD, BASE, steps)).toBe("failed")
  })

  it("renders a runner-death infrastructure verdict failed at the surface with its receipt intact", () => {
    const died = fact({
      status: "infrastructure",
      receipt: { code: "runner-died", message: "previous habitant runner disappeared" },
    })
    const state = foldCheckVerdictFact(undefined, died, T0)
    expect(verdictEligibilityStatus(state, HEAD, BASE, ["affected-tests"])).toBe("failed")
    const recorded = latestVerdictForTree(state, HEAD, BASE, "affected-tests")
    expect(recorded === undefined ? undefined : checkVerdictSurfaceStatus(recorded)).toBe("failed")
    expect(recorded?.receipt?.code).toBe("runner-died")
  })

  it("passes only on complete green coverage; partial passes fall through", () => {
    let state = foldCheckVerdictFact(undefined, fact({ step: "affected-tests" }), T0)
    expect(verdictEligibilityStatus(state, HEAD, BASE, steps)).toBeUndefined()
    state = foldCheckVerdictFact(state, fact({ step: "typecheck" }), T1)
    expect(verdictEligibilityStatus(state, HEAD, BASE, steps)).toBe("passed")
  })

  it("judges the newest attempt per step, so a re-request can turn a red tree green", () => {
    let state = foldCheckVerdictFact(undefined, fact({ status: "failed", receipt, exitCode: 1 }), T0)
    expect(verdictEligibilityStatus(state, HEAD, BASE, ["affected-tests"])).toBe("failed")
    state = foldCheckVerdictFact(state, fact({ exitCode: 0 }), T1)
    expect(verdictEligibilityStatus(state, HEAD, BASE, ["affected-tests"])).toBe("passed")
  })

  it("aggregates one head's history across bases and legs for the terminal-delivery read", () => {
    let state = foldCheckVerdictFact(
      undefined,
      fact({ baseSha: undefined, leg: "pre-submit", status: "failed", receipt, exitCode: 1 }),
      T0,
    )
    state = foldCheckVerdictFact(state, fact(), T1)
    state = foldCheckVerdictFact(state, fact({ baseSha: OTHER_BASE, step: "typecheck" }), T2)
    state = foldCheckVerdictFact(state, fact({ headSha: OTHER_HEAD }), T2)
    const rows = verdictsForHead(state, HEAD)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.headSha === HEAD)).toBe(true)
    expect(verdictsForHead(state, OTHER_HEAD)).toHaveLength(1)
  })
})

describe("projectVerdictCheckRecords — rows in the pr-checks shape", () => {
  const selectors = [{ name: "affected-tests" }, { name: "typecheck", classification: "base" as const }]
  const context = { pr: "PR1970", revision: 1, queuedAt: T0 }

  it("yields undefined when no selected step holds a verdict, so the ladder falls through untouched", () => {
    expect(projectVerdictCheckRecords(undefined, HEAD, BASE, selectors, context)).toBeUndefined()
    expect(projectVerdictCheckRecords(emptyCheckVerdicts, HEAD, BASE, selectors, context)).toBeUndefined()
  })

  it("renders a failing pre-submit verdict as a failed row carrying its receipt — the PR1970 read", () => {
    const failed = fact({ baseSha: undefined, leg: "pre-submit", status: "failed", receipt, exitCode: 1 })
    const state = foldCheckVerdictFact(undefined, failed, T0)
    const rows = projectVerdictCheckRecords(state, HEAD, undefined, selectors, context)
    expect(rows).toHaveLength(1)
    expect(rows?.[0]).toMatchObject({
      pr: "PR1970",
      revision: 1,
      status: "failed",
      step: "affected-tests",
      classification: "carrier",
      command: ["check.pre-submit.affected-tests"],
      diagnostics: receipt.message,
      error: receipt,
      queuedAt: T0,
    })
  })

  it("renders the newest attempt per step, keeps evidence pointers, and never sets error on a pass", () => {
    let state = foldCheckVerdictFact(undefined, fact({ status: "failed", receipt, exitCode: 1 }), T0)
    state = foldCheckVerdictFact(state, fact({ job: "J9", run: "R9", artifact: "s3://log" }), T1)
    state = foldCheckVerdictFact(state, fact({ step: "typecheck", leg: "carrier" }), T1)
    const rows = projectVerdictCheckRecords(state, HEAD, BASE, selectors, context)
    expect(rows?.map((row) => [row.step, row.status, row.classification])).toEqual([
      ["affected-tests", "passed", "carrier"],
      ["typecheck", "passed", "base"],
    ])
    expect(rows?.[0]).toMatchObject({ job: "J9", run: "R9", artifact: "s3://log" })
    expect(rows?.[0]?.error).toBeUndefined()
  })
})
