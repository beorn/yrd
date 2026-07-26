import type { JobResult } from "@yrd/job"
import type { IntegrationProof } from "./model.ts"
import { ComponentMainOutcomesSchema } from "./model.ts"

/**
 * A cleanup failure changes the terminal verdict, but it must not erase the
 * component-main actions that already happened. Preserve their typed receipts
 * on the failure so retries and operators can distinguish settled pins from
 * work that still needs an actuator.
 */
export function componentMainScratchCleanupFailure(
  outcome: JobResult<IntegrationProof>,
  message: string,
): JobResult<IntegrationProof> {
  const receipts =
    outcome.status === "completed" && outcome.conclusion === "success" ? (outcome.output.componentMains ?? []) : []
  return {
    status: "completed",
    conclusion: "failure",
    error: {
      code: "scratch-cleanup-failed",
      message,
      ...(receipts.length === 0
        ? {}
        : {
            evidence: ComponentMainOutcomesSchema.parse({
              kind: "component-main-outcomes",
              receipts,
              refusals: [],
            }),
          }),
    },
  }
}
