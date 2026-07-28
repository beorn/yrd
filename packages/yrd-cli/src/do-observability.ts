import { YRD_LIFECYCLE_LEVELS, type YrdLifecycleOutcome } from "@yrd/core"
import type { ConditionalLogger, LogLevel, SpanLogger } from "loggily"
import type { ManagedDoJournal, ManagedDoStageBoundaryInput, ManagedDoStagePhase } from "./do-managed.ts"

/**
 * The managed `do` composition already reports every transition through ONE
 * seam — `recordBoundary`. Until now that seam wrote only to a JSONL file under
 * the host state directory, so the verb an operator actually types produced no
 * log events at all: `-v` and `DEBUG='yrd:*'` showed hundreds of Git plumbing
 * rows and not one line saying which phase the run was in.
 *
 * This wraps that same seam rather than adding a second one. Wrapping the nine
 * stage FUNCTIONS instead would miss `concurrency` (a lock), `carrier` and
 * `observe` (poll loops whose timeout is composed by the driver, not thrown by
 * a stage) — and double-report the seven that do throw.
 *
 * Severity is NOT a local policy: each boundary phase maps onto the lifecycle
 * outcome that already owns its level in {@link YRD_LIFECYCLE_LEVELS}. Stage
 * starts are promoted to INFO for the same reason delivery-step starts are —
 * they are the one-line story of a run, and an operator should not need DEBUG
 * to read it.
 */

/** Which lifecycle outcome each composition boundary reports as. A refusal and
 * a timeout stay at the outcome levels the rest of Yrd uses, because the CLI
 * boundary (`reportManagedDo`) owns the single operator-facing error — the
 * deepest failure is reported once, never re-raised up the tree. */
const BOUNDARY_OUTCOMES = Object.freeze({
  started: "started",
  completed: "succeeded",
  refused: "refused",
  "timed-out": "failed",
} as const satisfies Record<ManagedDoStagePhase, YrdLifecycleOutcome>)

export function managedDoBoundaryLevel(phase: ManagedDoStagePhase): Exclude<LogLevel, "silent"> {
  // A stage start is an operator milestone, exactly like a delivery-step start.
  if (phase === "started") return "info"
  return YRD_LIFECYCLE_LEVELS[BOUNDARY_OUTCOMES[phase]]
}

function emit(
  log: ConditionalLogger,
  phase: ManagedDoStagePhase,
  message: string,
  props: Record<string, unknown>,
): void {
  switch (managedDoBoundaryLevel(phase)) {
    case "trace":
      log.trace?.(message, props)
      break
    case "debug":
      log.debug?.(message, props)
      break
    case "info":
      log.info?.(message, props)
      break
    case "warn":
      log.warn?.(message, props)
      break
    case "error":
      log.error?.(message, props)
      break
  }
}

function boundaryProps(boundary: ManagedDoStageBoundaryInput): Record<string, unknown> {
  return {
    issue: boundary.issue,
    lane: boundary.lane,
    stage: boundary.stage,
    outcome: BOUNDARY_OUTCOMES[boundary.phase],
    ...(boundary.trail.bay === undefined ? {} : { bay: boundary.trail.bay }),
    ...(boundary.trail.branch === undefined ? {} : { branch: boundary.trail.branch }),
    ...(boundary.trail.carrier === undefined ? {} : { carrier: boundary.trail.carrier }),
    ...(boundary.durationMs === undefined ? {} : { durationMs: boundary.durationMs }),
    ...(boundary.reason === undefined ? {} : { reason: boundary.reason }),
  }
}

/**
 * Wrap a managed-`do` journal so every stage boundary also reaches the host
 * logger under `yrd:do`, with one span per stage.
 *
 * Observation only: the returned journal delegates to `journal` unchanged, and
 * a logger that refuses a level costs nothing (loggily's absent methods skip
 * argument evaluation). A journal failure still propagates — the driver already
 * treats it as a refusal, and swallowing it here would hide the composition's
 * own loss of its trail.
 */
export function observeManagedDo(log: ConditionalLogger, journal: ManagedDoJournal): ManagedDoJournal {
  const doLog = log.child("do")
  const spans = new Map<string, SpanLogger>()
  return async (boundary) => {
    const props = boundaryProps(boundary)
    const stageLog = doLog.child(boundary.stage)
    if (boundary.phase === "started") {
      const span = stageLog.span?.(undefined, () => props)
      if (span !== undefined) spans.set(boundary.stage, span)
      emit(stageLog, boundary.phase, `${boundary.stage} started`, props)
    } else {
      const span = spans.get(boundary.stage)
      if (span !== undefined) {
        Object.assign(span.spanData as Record<string, unknown>, props)
        spans.delete(boundary.stage)
        span.end()
      }
      emit(stageLog, boundary.phase, `${boundary.stage} ${boundary.phase}`, props)
    }
    await journal(boundary)
  }
}
