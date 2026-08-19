/**
 * @failure A scratch cleanup failure erases the per-pin component-main results produced by a successful actuator.
 * @level l2
 * @consumer @yrd/queue component-main settlement
 */
import { expect, it } from "vitest"
import type { JobResult } from "@yrd/job"
import type { IntegrationProof } from "../src/model.ts"
import { submoduleMainScratchCleanupFailure } from "../src/component-main-outcome.ts"

const sha = (digit: string): string => digit.repeat(40)

it("preserves successful per-pin results when scratch cleanup fails", () => {
  const outcome: JobResult<IntegrationProof> = {
    status: "completed",
    conclusion: "success",
    output: {
      commit: sha("3"),
      baseSha: sha("3"),
      componentMains: [
        {
          path: "vendor/yrd",
          origin: "https://example.invalid/yrd.git",
          pinSha: sha("3"),
          mainBeforeSha: sha("2"),
          mainAfterSha: sha("3"),
          action: "fast-forwarded",
        },
      ],
    },
  }

  expect(submoduleMainScratchCleanupFailure(outcome, "cleanup denied")).toMatchObject({
    status: "completed",
    conclusion: "failure",
    error: {
      code: "scratch-cleanup-failed",
      message: "cleanup denied",
      evidence: {
        kind: "component-main-outcomes",
        results: outcome.output.componentMains,
        refusals: [],
      },
    },
  })
})
