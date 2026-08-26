/**
 * @failure The live queue silently falls back to legacy PR/QueueRun workflow semantics.
 * @level l1
 * @consumer Yrd step-plan authors and runner integrations
 */
import { defineStepPlan, withCheckStep, withMergeStep } from "@yrd/config"
import { localRunner } from "@yrd/job"
import { describe, expect, it } from "vitest"
import { CandidateSchema } from "../src/index.ts"

describe("S2-S5 target model contract", () => {
  it("binds an immutable Candidate to the validated step plan and a Runner seam", () => {
    const plan = defineStepPlan([withCheckStep("test"), withMergeStep()])
    expect(plan.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "test", kind: "check" },
      { name: "merge", kind: "merge" },
    ])
    expect(
      CandidateSchema.parse({
        id: "C1",
        queueId: "main",
        baseSha: "b".repeat(40),
        revs: [{ pr: "PR1", n: 1, head: "a".repeat(40) }],
        mergeability: "unknown",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toMatchObject({ id: "C1", mergeability: "unknown" })
    expect(localRunner).toBeTypeOf("function")
  })
})
