import { makeEvent } from "../core.ts"
import type { BayEvent, BayRuntime, Cause, StepFinishMetadata, StepRunData } from "../types.ts"

/**
 * line/step event builders — the ONE spelling for "a step ran against a target
 * tree", shared by every path that runs one (docs/events.md § event families):
 * the serial check/merge (merge-worker.ts), a fused push's continuation
 * (receive.ts), and the batch bisect's baseline + prefix gates
 * (batch-build.ts). Pure run-records: nothing folds them into state; stats
 * folds (`tent bay-stats`, the future `git bay stats`) derive per-step runtime
 * and failure rates from the started/finished pair.
 */

export function stepStarted(bay: BayRuntime, data: StepRunData, cause: Cause): BayEvent {
  return makeEvent(bay, "line/step/started", data, cause)
}

export function stepFinished(
  bay: BayRuntime,
  data: StepRunData,
  ok: boolean,
  detail: string | undefined,
  cause: Cause,
  metadata: StepFinishMetadata = {},
): BayEvent {
  return makeEvent(
    bay,
    "line/step/finished",
    {
      ...data,
      ok,
      ...(detail !== undefined ? { detail } : {}),
      ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
      ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
      ...(metadata.error !== undefined ? { error: metadata.error } : {}),
      ...(metadata.artifacts !== undefined && metadata.artifacts.length > 0 ? { artifacts: metadata.artifacts } : {}),
      ...(metadata.baseSha !== undefined ? { baseSha: metadata.baseSha } : {}),
      ...(metadata.headSha !== undefined ? { headSha: metadata.headSha } : {}),
    },
    cause,
  )
}
