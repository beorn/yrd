import { createHash } from "node:crypto"
import { makeEvent } from "../core.ts"
import type { BayEvent, BayRuntime, Cause, PrId, StepFinishMetadata, StepRunData, StepWaitingMetadata } from "../types.ts"

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
      ...(metadata.token !== undefined ? { token: metadata.token } : {}),
      ...(metadata.url !== undefined ? { url: metadata.url } : {}),
      ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
      ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
      ...(metadata.configHash !== undefined ? { configHash: metadata.configHash } : {}),
      ...(metadata.skipped !== undefined ? { skipped: metadata.skipped } : {}),
      ...(metadata.error !== undefined ? { error: metadata.error } : {}),
      ...(metadata.artifacts !== undefined && metadata.artifacts.length > 0 ? { artifacts: metadata.artifacts } : {}),
      ...(metadata.baseSha !== undefined ? { baseSha: metadata.baseSha } : {}),
      ...(metadata.headSha !== undefined ? { headSha: metadata.headSha } : {}),
    },
    cause,
  )
}

export function stepWaiting(
  bay: BayRuntime,
  data: StepRunData,
  cause: Cause,
  metadata: StepWaitingMetadata = {},
): BayEvent {
  return makeEvent(
    bay,
    "line/step/waiting",
    {
      ...data,
      ...(metadata.detail !== undefined ? { detail: metadata.detail } : {}),
      ...(metadata.token !== undefined ? { token: metadata.token } : {}),
      ...(metadata.url !== undefined ? { url: metadata.url } : {}),
      ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
      ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
      ...(metadata.configHash !== undefined ? { configHash: metadata.configHash } : {}),
      ...(metadata.artifacts !== undefined && metadata.artifacts.length > 0 ? { artifacts: metadata.artifacts } : {}),
      ...(metadata.baseSha !== undefined ? { baseSha: metadata.baseSha } : {}),
      ...(metadata.headSha !== undefined ? { headSha: metadata.headSha } : {}),
    },
    cause,
  )
}

export function stepConfigHash(step: StepRunData["step"], config: string): string {
  return createHash("sha256").update(step).update("\0").update(config.trim()).digest("hex")
}

export type FinishedStepRecord = StepRunData & { ok: boolean; detail?: string } & StepFinishMetadata

export async function latestFinishedStep(bay: BayRuntime, run: StepRunData): Promise<FinishedStepRecord | undefined> {
  if (run.pr === undefined) return undefined
  let latest: FinishedStepRecord | undefined
  for await (const ev of bay.store.journal.replay()) {
    if (ev.name !== "line/step/finished") continue
    const d = ev.data as FinishedStepRecord
    if (d.step === run.step && d.pr === run.pr && d.target === run.target && typeof d.ok === "boolean") {
      latest = d
    }
  }
  return latest
}

export function staleCheckReasons(
  check: { ok?: boolean; baseSha?: string; headSha?: string } | undefined,
  refs: { baseSha?: string; headSha?: string },
): string[] {
  if (check?.ok !== true) return []
  const reasons: string[] = []
  if (check.headSha !== undefined && refs.headSha !== undefined && check.headSha !== refs.headSha) {
    reasons.push("target changed since check")
  }
  if (check.baseSha !== undefined && refs.baseSha !== undefined && check.baseSha !== refs.baseSha) {
    reasons.push("base changed since check")
  }
  return reasons
}

export async function hasReusableSuccessfulStep(
  bay: BayRuntime,
  run: StepRunData,
  refs: { baseSha?: string; headSha?: string; configHash?: string },
): Promise<boolean> {
  if (run.pr === undefined || refs.baseSha === undefined || refs.headSha === undefined || refs.configHash === undefined) return false
  for await (const ev of bay.store.journal.replay()) {
    if (ev.name !== "line/step/finished") continue
    const d = ev.data as {
      step?: StepRunData["step"]
      pr?: PrId
      target?: string
      ok?: boolean
      baseSha?: string
      headSha?: string
      configHash?: string
    }
    if (
      d.step === run.step &&
      d.pr === run.pr &&
      d.target === run.target &&
      d.ok === true &&
      d.baseSha === refs.baseSha &&
      d.headSha === refs.headSha &&
      d.configHash === refs.configHash
    ) {
      return true
    }
  }
  return false
}

export function skippedStepEvents(
  bay: BayRuntime,
  run: StepRunData,
  cause: Cause,
  refs: { baseSha?: string; headSha?: string; configHash?: string },
): BayEvent[] {
  return [
    stepStarted(bay, run, cause),
    stepFinished(bay, run, true, `skipped; previous successful ${run.step} matches base/head/config`, cause, {
      durationMs: 0,
      configHash: refs.configHash,
      skipped: true,
      baseSha: refs.baseSha,
      headSha: refs.headSha,
    }),
  ]
}
