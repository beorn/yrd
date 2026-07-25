/**
 * @failure The live queue silently falls back to legacy PR/QueueRun workflow semantics.
 * @level l1
 * @consumer Yrd flow authors and runner integrations
 */
import { defineConfig, selectFlow, withCheckStep, withFlow, withMergeStep } from "@yrd/config"
import { localRunner } from "@yrd/job"
import { describe, expect, it } from "vitest"
import { CandidateSchema } from "../src/index.ts"

describe("S2-S5 target model contract", () => {
  it("binds an immutable Candidate to exactly one versioned Flow and a Runner seam", () => {
    const selected = selectFlow(
      defineConfig(
        withFlow({
          name: "main",
          rev: "1",
          on: ({ base }) => base === "main",
          steps: [withCheckStep("test"), withMergeStep()],
        }),
      ),
      { base: "main", branch: "topic", head: "a".repeat(40) },
    )

    expect(selected.pin).toMatchObject({ name: "main", rev: "1" })
    expect(selected.pin.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
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

  it("refuses ambiguous FlowDef matches", () => {
    const flow = (name: string) =>
      withFlow({ name, rev: "1", on: () => true, steps: [withCheckStep("test"), withMergeStep()] })

    expect(() =>
      selectFlow(defineConfig(flow("main"), flow("release")), {
        base: "main",
        branch: "topic",
        head: "a".repeat(40),
      }),
    ).toThrow("matched multiple flows: main, release")
  })
})
