import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PRDeliveryState } from "@yrd/bay"
import { failureFact } from "@yrd/core"
import { actionableFailure, type ActionableFailure } from "./actionable-error.ts"
import { configuration } from "./invocation.ts"

/**
 * The managed composition behind `yrd do`.
 *
 * `do` is a COMPOSITION, not an engine: every stage below is an existing Yrd or
 * repository-configured surface. It adds no second Bay provisioner, no second
 * carrier path, and no second landing queue. The final stage is an OBSERVATION —
 * the resident runner (or the operator) drains the queue, so the managed driver
 * never becomes the second driver the drain lease exists to prevent.
 *
 * Supervision is deliberately thin and declared: a bounded poll, a timeout, and
 * a loud refusal that names the stage that stopped, plus the issue, the Bay and
 * the carrier so a dead run leaves a diagnosable trail instead of a stranded Bay.
 */

export type ManagedDoStage =
  | "concurrency"
  | "assign"
  | "seat"
  | "bay"
  | "launch"
  | "carrier"
  | "draft"
  | "recut"
  | "observe"

export type ManagedDoOutcome = "landed" | "refused" | "timed-out"

export type ManagedDoTrail = Readonly<{
  issue: string
  lane: string
  bay?: string
  branch?: string
  carrier?: string
}>

type ManagedDoTerminalResult = Readonly<{
  outcome: ManagedDoOutcome
  /** The stage that produced this result — always named, on every path. */
  stage: ManagedDoStage
  trail: ManagedDoTrail
  reason?: string
  landingSha?: string
  /** The command a reader runs to prove the landing SHA reached the base. */
  ancestry?: string
  /** A remedy the managed path is not allowed to run itself; operator guidance. */
  remedy?: readonly string[]
  /** Set when the failure needs human judgment (a compose that can conflict). */
  escalation?: string
}>

export type ManagedDoStageTiming = Readonly<{
  stage: ManagedDoStage
  phase: Exclude<ManagedDoStagePhase, "started">
  startedAt: string
  endedAt: string
  durationMs: number
}>

export type ManagedDoResult = ManagedDoTerminalResult &
  Readonly<{
    startedAt: string
    endedAt: string
    durationMs: number
    timings: readonly ManagedDoStageTiming[]
  }>

export type ManagedDoStagePhase = "started" | "completed" | "refused" | "timed-out"

/** One wall-clock-stamped transition in the managed verb. Domain commands
 * still own their canonical Yrd events; this journal records the composition's
 * orchestration boundary, including repository-owned external commands. */
export type ManagedDoStageBoundary = Readonly<{
  at: string
  issue: string
  lane: string
  stage: ManagedDoStage
  phase: ManagedDoStagePhase
  trail: ManagedDoTrail
  /** Present on terminal boundaries; measured from this stage's started row. */
  durationMs?: number
  reason?: string
}>

export type ManagedDoStageBoundaryInput = Omit<ManagedDoStageBoundary, "at"> &
  Readonly<{
    /** Tests and embedders may supply the boundary instant; the process host
     * stamps it when absent. */
    at?: string
  }>

export type ManagedDoJournal = (boundary: ManagedDoStageBoundaryInput) => Promise<void>
export type ManagedDoScoreboard = (result: ManagedDoResult) => Promise<void>

/** A repository-configured command template. Same shape as a configured check
 * step: a shell `run` string plus an optional wall-clock bound. Yrd substitutes
 * nothing into the text — the issue, lane and Bay ride as `YRD_DO_*` environment
 * values, exactly the way `$YRD_BASE_SHA` reaches a check step. */
export type ManagedDoCommand = Readonly<{ run: string; timeoutMs?: number }>

export type ManagedDoConfig = Readonly<{
  lane?: string
  assign?: ManagedDoCommand
  seat?: ManagedDoCommand
  launch?: ManagedDoCommand
  pollMs?: number
  carrierTimeoutMs?: number
  landingTimeoutMs?: number
}>

export type ManagedDoSettings = Readonly<{
  lane: string
  base: string
  pollMs: number
  carrierTimeoutMs: number
  landingTimeoutMs: number
}>

export type ManagedDoPlan = Readonly<{
  settings: ManagedDoSettings
  assign: ManagedDoCommand
  seat: ManagedDoCommand
  launch: ManagedDoCommand
}>

export type ManagedDoDelivery = Readonly<{
  state: PRDeliveryState
  landingSha?: string
  findings: readonly Readonly<{ code: string; message: string; count?: number }>[]
}>

export type ManagedDoBay = Readonly<{ bay: string; branch: string; path: string; headSha?: string }>

/** Every stage the composition drives, injected so the order, the refusal paths
 * and the timeout are unit-testable without a repository. */
export type ManagedDoStages = Readonly<{
  assign(input: Readonly<{ issue: string; lane: string }>): Promise<void>
  decideSeat(input: Readonly<{ issue: string; lane: string }>): Promise<void>
  openBay(input: Readonly<{ issue: string }>): Promise<ManagedDoBay>
  launch(input: Readonly<{ issue: string; lane: string; bay: string; path: string }>): Promise<void>
  /** Roll back the exact just-opened managed Bay when launch cannot take
   * ownership. The Bay adapter preserves its ordinary archived lifecycle/ref;
   * this is not raw branch deletion. */
  closeBay(input: Readonly<{ bay: string }>): Promise<void>
  /** One poll tick over the Bay's refreshed workspace head. */
  observeCarrier(input: Readonly<{ bay: string; branch: string }>): Promise<Readonly<{ headSha?: string }>>
  createDraft(input: Readonly<{ branch: string; issue: string }>): Promise<Readonly<{ pr: string }>>
  recut(input: Readonly<{ pr: string; preflight: boolean }>): Promise<void>
  observeDelivery(input: Readonly<{ pr: string }>): Promise<ManagedDoDelivery>
  sleep(ms: number): Promise<void>
  now(): number
  wallNow(): Date
  recordBoundary(boundary: ManagedDoStageBoundary): Promise<void>
  note?(text: string): void
}>

export type ManagedDoHolder = Readonly<{ pid: number; issue: string; startedAt: string }>
export type ManagedDoLease = Readonly<{ reclaimed?: ManagedDoHolder; release(): Promise<void> }>
export type ManagedDoAcquisition = ManagedDoLease | Readonly<{ holder: ManagedDoHolder }>

/** Managed concurrency is capped at 1 for v0. */
export type ManagedDoLock = Readonly<{ acquire(input: Readonly<{ issue: string }>): Promise<ManagedDoAcquisition> }>

const DEFAULT_POLL_MS = 30_000
const DEFAULT_TIMEOUT_MS = 45 * 60_000
const CONFIG_FILE = ".yrd.yml"

/** Delivery states that end the observation. */
const LANDED_STATES: ReadonlySet<PRDeliveryState> = new Set<PRDeliveryState>(["integrated", "already-landed"])
const TERMINAL_REFUSALS: ReadonlySet<PRDeliveryState> = new Set<PRDeliveryState>(["rejected", "withdrawn", "canceled"])

/** The audit code a wedged front-of-queue carrier raises (22395). */
const WEDGE_CODE = "admission-refusal-loop"

/** `--seat` is the explicit request; a process host that POSITIVELY reports no
 * terminal is the headless default. An absent `interactive` flag is not evidence
 * of a headless caller — the process host always states it (`stdin.isTTY &&
 * stdout.isTTY`), so only an embedded/API caller leaves it undefined, and
 * silently flipping such a caller into an unattended composition would be a mode
 * change it never asked for. */
export function managedDoRequested(
  options: Readonly<{ seat?: boolean }>,
  io: Readonly<{ interactive?: boolean }>,
): boolean {
  return options.seat === true || io.interactive === false
}

function requireCommand(value: ManagedDoCommand | undefined, key: string): ManagedDoCommand {
  if (value === undefined || value.run.trim() === "") {
    configuration(
      `managed 'do' requires ${CONFIG_FILE} key '${key}'; the repository owns that command, Yrd never invents it`,
    )
  }
  return value
}

export function resolveManagedDoPlan(config: Readonly<{ do?: ManagedDoConfig; base: string }>): ManagedDoPlan {
  const declared = config.do ?? {}
  const lane = declared.lane?.trim()
  if (lane === undefined || lane === "") {
    configuration(`managed 'do' requires ${CONFIG_FILE} key 'do.lane'; Yrd never invents a persona identity`)
  }
  return Object.freeze({
    settings: Object.freeze({
      lane,
      base: config.base,
      pollMs: declared.pollMs ?? DEFAULT_POLL_MS,
      carrierTimeoutMs: declared.carrierTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      landingTimeoutMs: declared.landingTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    }),
    assign: requireCommand(declared.assign, "do.assign"),
    seat: requireCommand(declared.seat, "do.seat"),
    launch: requireCommand(declared.launch, "do.launch"),
  })
}

function detail(error: unknown): string {
  const fact = failureFact(error)
  if (fact !== undefined) return fact.message
  return error instanceof Error ? error.message : String(error)
}

function classify(error: unknown, delivery: PRDeliveryState | undefined): ActionableFailure {
  const fact = failureFact(error)
  const like =
    fact === undefined
      ? { code: "unexpected", message: error instanceof Error ? error.message : String(error) }
      : { code: fact.code, message: fact.message }
  return actionableFailure(like, delivery === undefined ? {} : { delivery })
}

function refused(
  stage: ManagedDoStage,
  trail: ManagedDoTrail,
  reason: string,
  extra: Readonly<{ remedy?: readonly string[]; escalation?: string }> = {},
): ManagedDoTerminalResult {
  return Object.freeze({ outcome: "refused" as const, stage, trail, reason, ...extra })
}

function timedOut(stage: ManagedDoStage, trail: ManagedDoTrail, reason: string): ManagedDoTerminalResult {
  return Object.freeze({ outcome: "timed-out" as const, stage, trail, reason })
}

/** Remedy steps the managed path may run itself. `pr ready` and `pr submit` are
 * deliberately absent: the managed carrier is cut as a DRAFT before any gitlink
 * commit and only ever advanced by `recut --queue`. A remedy naming anything
 * else is printed for the operator, never executed. */
type RemedyStep = Readonly<{ kind: "draft" }> | Readonly<{ kind: "recut"; preflight: boolean }>

export function managedRemedySteps(resolution: readonly string[]): readonly RemedyStep[] | undefined {
  const steps: RemedyStep[] = []
  for (const entry of resolution) {
    const text = entry.trim()
    if (/^yrd\s+pr\s+create\b/iu.test(text)) {
      steps.push({ kind: "draft" })
      continue
    }
    if (/^yrd\s+pr\s+recut\b/iu.test(text)) {
      steps.push({ kind: "recut", preflight: /--preflight\b/u.test(text) })
      continue
    }
    return undefined
  }
  return steps.length === 0 ? undefined : Object.freeze(steps)
}

async function emitBoundary(
  stages: ManagedDoStages,
  stage: ManagedDoStage,
  phase: ManagedDoStagePhase,
  trail: ManagedDoTrail,
  reason?: string,
): Promise<string | undefined> {
  try {
    await stages.recordBoundary({
      at: stages.wallNow().toISOString(),
      issue: trail.issue,
      lane: trail.lane,
      stage,
      phase,
      trail,
      ...(reason === undefined ? {} : { reason }),
    })
    return undefined
  } catch (error) {
    return `managed do journal failed at ${stage}:${phase}: ${detail(error)}`
  }
}

function joinedReason(reason: string, journalFailure: string | undefined): string {
  return journalFailure === undefined ? reason : `${reason}; ${journalFailure}`
}

async function refuseAt(
  stages: ManagedDoStages,
  stage: ManagedDoStage,
  trail: ManagedDoTrail,
  reason: string,
  extra: Readonly<{ remedy?: readonly string[]; escalation?: string }> = {},
): Promise<ManagedDoTerminalResult> {
  return refused(stage, trail, joinedReason(reason, await emitBoundary(stages, stage, "refused", trail, reason)), extra)
}

async function startStage(
  stages: ManagedDoStages,
  stage: ManagedDoStage,
  trail: ManagedDoTrail,
): Promise<ManagedDoTerminalResult | undefined> {
  const failure = await emitBoundary(stages, stage, "started", trail)
  return failure === undefined ? undefined : refused(stage, trail, failure)
}

async function completeStage(
  stages: ManagedDoStages,
  stage: ManagedDoStage,
  trail: ManagedDoTrail,
): Promise<ManagedDoTerminalResult | undefined> {
  const failure = await emitBoundary(stages, stage, "completed", trail)
  return failure === undefined ? undefined : refused(stage, trail, failure)
}

async function finishStageResult(
  stages: ManagedDoStages,
  result: ManagedDoTerminalResult,
): Promise<ManagedDoTerminalResult> {
  const phase: ManagedDoStagePhase =
    result.outcome === "landed" ? "completed" : result.outcome === "timed-out" ? "timed-out" : "refused"
  const journalFailure = await emitBoundary(stages, result.stage, phase, result.trail, result.reason)
  if (journalFailure === undefined) return result
  return refused(result.stage, result.trail, joinedReason(result.reason ?? result.outcome, journalFailure), {
    ...(result.remedy === undefined ? {} : { remedy: result.remedy }),
    ...(result.escalation === undefined ? {} : { escalation: result.escalation }),
  })
}

function boundaryDurationMs(startedAt: string, endedAt: string): number {
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0
}

function measureManagedDo(stages: ManagedDoStages): Readonly<{
  stages: ManagedDoStages
  finish(result: ManagedDoTerminalResult): ManagedDoResult
}> {
  const starts = new Map<ManagedDoStage, string>()
  const timings: ManagedDoStageTiming[] = []
  let startedAt: string | undefined
  let endedAt: string | undefined
  return {
    stages: {
      ...stages,
      recordBoundary: async (boundary) => {
        startedAt ??= boundary.at
        endedAt = boundary.at
        if (boundary.phase === "started") {
          starts.set(boundary.stage, boundary.at)
          await stages.recordBoundary(boundary)
          return
        }
        const stageStartedAt = starts.get(boundary.stage) ?? boundary.at
        const timing: ManagedDoStageTiming = Object.freeze({
          stage: boundary.stage,
          phase: boundary.phase,
          startedAt: stageStartedAt,
          endedAt: boundary.at,
          durationMs: boundaryDurationMs(stageStartedAt, boundary.at),
        })
        timings.push(timing)
        await stages.recordBoundary({ ...boundary, durationMs: timing.durationMs })
      },
    },
    finish: (result) => {
      const first = startedAt ?? stages.wallNow().toISOString()
      const last = endedAt ?? first
      return Object.freeze({
        ...result,
        startedAt: first,
        endedAt: last,
        durationMs: boundaryDurationMs(first, last),
        timings: Object.freeze([...timings]),
      })
    },
  }
}

export async function runManagedDo(
  request: Readonly<{ issue: string; plan: ManagedDoPlan; stages: ManagedDoStages; lock: ManagedDoLock }>,
): Promise<ManagedDoResult> {
  const measured = measureManagedDo(request.stages)
  const result = await runManagedDoUnmeasured({ ...request, stages: measured.stages })
  return measured.finish(result)
}

async function runManagedDoUnmeasured(
  request: Readonly<{ issue: string; plan: ManagedDoPlan; stages: ManagedDoStages; lock: ManagedDoLock }>,
): Promise<ManagedDoTerminalResult> {
  const { issue, plan, stages, lock } = request
  const trail: ManagedDoTrail = { issue, lane: plan.settings.lane }
  const concurrencyStart = await startStage(stages, "concurrency", trail)
  if (concurrencyStart !== undefined) return concurrencyStart
  let acquired: ManagedDoAcquisition
  try {
    acquired = await lock.acquire({ issue })
  } catch (error) {
    return refuseAt(stages, "concurrency", trail, detail(error))
  }
  if ("holder" in acquired) {
    const holder = acquired.holder
    return refuseAt(
      stages,
      "concurrency",
      trail,
      `another managed 'do' run is active (pid ${holder.pid}, issue '${holder.issue}', since ${holder.startedAt}); ` +
        "managed concurrency is capped at 1",
    )
  }
  const concurrencyComplete = await completeStage(stages, "concurrency", trail)
  if (concurrencyComplete !== undefined) {
    await acquired.release()
    return concurrencyComplete
  }
  if (acquired.reclaimed !== undefined) {
    stages.note?.(
      `yrd: reclaimed a stale managed 'do' marker left by dead pid ${acquired.reclaimed.pid} ` +
        `(issue '${acquired.reclaimed.issue}', since ${acquired.reclaimed.startedAt})\n`,
    )
  }
  try {
    return await drive(issue, plan, stages)
  } finally {
    await acquired.release()
  }
}

async function drive(issue: string, plan: ManagedDoPlan, stages: ManagedDoStages): Promise<ManagedDoTerminalResult> {
  const { settings } = plan
  let trail: ManagedDoTrail = { issue, lane: settings.lane }

  const assignStart = await startStage(stages, "assign", trail)
  if (assignStart !== undefined) return assignStart
  try {
    await stages.assign({ issue, lane: settings.lane })
  } catch (error) {
    return refuseAt(stages, "assign", trail, detail(error))
  }
  const assignComplete = await completeStage(stages, "assign", trail)
  if (assignComplete !== undefined) return assignComplete

  const seatStart = await startStage(stages, "seat", trail)
  if (seatStart !== undefined) return seatStart
  try {
    await stages.decideSeat({ issue, lane: settings.lane })
  } catch (error) {
    return refuseAt(stages, "seat", trail, detail(error))
  }
  const seatComplete = await completeStage(stages, "seat", trail)
  if (seatComplete !== undefined) return seatComplete

  const bayStart = await startStage(stages, "bay", trail)
  if (bayStart !== undefined) return bayStart
  let bay: ManagedDoBay
  try {
    bay = await stages.openBay({ issue })
  } catch (error) {
    return refuseAt(stages, "bay", trail, detail(error))
  }
  trail = { ...trail, bay: bay.bay, branch: bay.branch }
  const bayComplete = await completeStage(stages, "bay", trail)
  if (bayComplete !== undefined) {
    return closeAfterLaunchFailure(stages, bay, trail, bayComplete.reason ?? "Bay boundary journal failed", "bay")
  }

  const launchStart = await startStage(stages, "launch", trail)
  if (launchStart !== undefined) {
    return closeAfterLaunchFailure(stages, bay, trail, launchStart.reason ?? "launch boundary journal failed")
  }
  try {
    await stages.launch({ issue, lane: settings.lane, bay: bay.bay, path: bay.path })
  } catch (error) {
    return closeAfterLaunchFailure(stages, bay, trail, detail(error))
  }
  const launchComplete = await completeStage(stages, "launch", trail)
  if (launchComplete !== undefined) {
    return closeAfterLaunchFailure(stages, bay, trail, launchComplete.reason ?? "launch boundary journal failed")
  }

  const carrierStart = await startStage(stages, "carrier", trail)
  if (carrierStart !== undefined) return carrierStart
  const carrier = await awaitCarrier(bay, trail, settings, stages)
  if ("result" in carrier) return finishStageResult(stages, carrier.result)
  const carrierComplete = await completeStage(stages, "carrier", trail)
  if (carrierComplete !== undefined) return carrierComplete

  // The DRAFT is cut before any gitlink commit and before any recut: an
  // authored gitlink on a submitted carrier is the trap state, and a draft is
  // the only shape that can be corrected mechanically.
  const draftStart = await startStage(stages, "draft", trail)
  if (draftStart !== undefined) return draftStart
  let pr: string
  try {
    pr = (await stages.createDraft({ branch: bay.branch, issue })).pr
  } catch (error) {
    const actionable = classify(error, undefined)
    return refuseAt(stages, "draft", trail, actionable.cause, { remedy: actionable.resolution })
  }
  trail = { ...trail, carrier: pr }
  const draftComplete = await completeStage(stages, "draft", trail)
  if (draftComplete !== undefined) return draftComplete

  const recutStart = await startStage(stages, "recut", trail)
  if (recutStart !== undefined) return recutStart
  const admitted = await admit(pr, trail, bay, issue, stages)
  if (admitted !== undefined) return finishStageResult(stages, admitted)
  const recutComplete = await completeStage(stages, "recut", trail)
  if (recutComplete !== undefined) return recutComplete

  const observeStart = await startStage(stages, "observe", trail)
  if (observeStart !== undefined) return observeStart
  return finishStageResult(stages, await observe(pr, trail, settings, stages))
}

async function closeAfterLaunchFailure(
  stages: ManagedDoStages,
  bay: ManagedDoBay,
  trail: ManagedDoTrail,
  reason: string,
  stage: "bay" | "launch" = "launch",
): Promise<ManagedDoTerminalResult> {
  let cleanupFailure: string | undefined
  try {
    await stages.closeBay({ bay: bay.bay })
  } catch (error) {
    cleanupFailure = `Bay '${bay.bay}' rollback failed: ${detail(error)}`
  }
  return refuseAt(stages, stage, trail, cleanupFailure === undefined ? reason : `${reason}; ${cleanupFailure}`)
}

async function awaitCarrier(
  bay: ManagedDoBay,
  trail: ManagedDoTrail,
  settings: ManagedDoSettings,
  stages: ManagedDoStages,
): Promise<Readonly<{ headSha: string }> | Readonly<{ result: ManagedDoTerminalResult }>> {
  const leaseBase = bay.headSha
  const deadline = stages.now() + settings.carrierTimeoutMs
  for (;;) {
    let observed: Readonly<{ headSha?: string }>
    try {
      observed = await stages.observeCarrier({ bay: bay.bay, branch: bay.branch })
    } catch (error) {
      return { result: refused("carrier", trail, detail(error)) }
    }
    const head = observed.headSha
    if (head !== undefined && head !== leaseBase) return { headSha: head }
    if (stages.now() >= deadline) {
      return {
        result: timedOut(
          "carrier",
          trail,
          `no commit appeared on branch '${bay.branch}' in Bay '${bay.bay}' within ${settings.carrierTimeoutMs}ms; ` +
            "the Bay and its branch are preserved",
        ),
      }
    }
    await stages.sleep(settings.pollMs)
  }
}

/** Preflight the recut, then admit the fresh revision. `--queue` is opt-in on
 * recut and load-bearing: without it the call succeeds and leaves the carrier
 * invisible to the queue. */
async function admit(
  pr: string,
  trail: ManagedDoTrail,
  bay: ManagedDoBay,
  issue: string,
  stages: ManagedDoStages,
): Promise<ManagedDoTerminalResult | undefined> {
  for (const preflight of [true, false]) {
    try {
      await stages.recut({ pr, preflight })
    } catch (error) {
      const recovered = await recover(error, pr, trail, bay, issue, stages, preflight)
      if (recovered !== undefined) return recovered
    }
  }
  return undefined
}

/** Follow the state-aware remedy ONCE, and only when every step stays inside the
 * managed verb set. An `escalation` means at least one step needs human
 * judgment, so the driver stops with the stage named instead of running it. */
async function recover(
  error: unknown,
  pr: string,
  trail: ManagedDoTrail,
  bay: ManagedDoBay,
  issue: string,
  stages: ManagedDoStages,
  preflight: boolean,
): Promise<ManagedDoTerminalResult | undefined> {
  let delivery: PRDeliveryState | undefined
  try {
    delivery = (await stages.observeDelivery({ pr })).state
  } catch (observeError) {
    return refused("recut", trail, `${detail(error)} (carrier state unreadable: ${detail(observeError)})`)
  }
  const actionable = classify(error, delivery)
  if (actionable.escalation !== undefined) {
    return refused("recut", trail, actionable.cause, {
      remedy: actionable.escalation.steps,
      escalation: actionable.escalation.reason,
    })
  }
  const steps = managedRemedySteps(actionable.resolution)
  if (steps === undefined) {
    return refused(
      "recut",
      trail,
      `${actionable.cause}; the recorded remedy leaves the managed verb set (draft then recut --queue only)`,
      { remedy: actionable.resolution },
    )
  }
  try {
    for (const step of steps) {
      if (step.kind === "draft") await stages.createDraft({ branch: bay.branch, issue })
      else await stages.recut({ pr, preflight: step.preflight })
    }
    await stages.recut({ pr, preflight })
  } catch (retryError) {
    const retried = classify(retryError, delivery)
    return refused("recut", trail, `${retried.cause} (after following the recorded remedy once)`, {
      remedy: retried.resolution,
    })
  }
  return undefined
}

/** OBSERVE the resident drain. Never `queue run`: one queue, one driver. */
async function observe(
  pr: string,
  trail: ManagedDoTrail,
  settings: ManagedDoSettings,
  stages: ManagedDoStages,
): Promise<ManagedDoTerminalResult> {
  const deadline = stages.now() + settings.landingTimeoutMs
  for (;;) {
    let delivery: ManagedDoDelivery
    try {
      delivery = await stages.observeDelivery({ pr })
    } catch (error) {
      return refused("observe", trail, detail(error))
    }
    if (LANDED_STATES.has(delivery.state)) {
      if (delivery.landingSha === undefined) {
        return refused(
          "observe",
          trail,
          `carrier '${pr}' reports '${delivery.state}' without a landing SHA; the landing cannot be proven`,
        )
      }
      return Object.freeze({
        outcome: "landed" as const,
        stage: "observe" as const,
        trail,
        landingSha: delivery.landingSha,
        ancestry: `git merge-base --is-ancestor ${delivery.landingSha} origin/${settings.base}`,
      })
    }
    if (TERMINAL_REFUSALS.has(delivery.state)) {
      return refused("observe", trail, `carrier '${pr}' is ${delivery.state}`)
    }
    const wedge = delivery.findings.find((finding) => finding.code === WEDGE_CODE)
    if (wedge !== undefined) {
      return refused(
        "observe",
        trail,
        `queue audit reports ${WEDGE_CODE} for carrier '${pr}'${wedge.count === undefined ? "" : ` (${wedge.count} consecutive refusals)`}: ${wedge.message}`,
      )
    }
    if (stages.now() >= deadline) {
      return timedOut(
        "observe",
        trail,
        `carrier '${pr}' was still '${delivery.state}' after ${settings.landingTimeoutMs}ms; ` +
          "the carrier is preserved for the queue",
      )
    }
    await stages.sleep(settings.pollMs)
  }
}

/** Append-only composition journal beside the managed concurrency marker.
 * Every row is one stage boundary and carries its own wall-clock instant so
 * later speed analysis never has to infer time from process output. */
export function createManagedDoJournal(options: Readonly<{ stateDir: string; now?: () => Date }>): ManagedDoJournal {
  const dir = join(options.stateDir, "do-managed")
  const path = join(dir, "journal.jsonl")
  const now = options.now ?? (() => new Date())
  return async (boundary) => {
    await mkdir(dir, { recursive: true })
    const at = boundary.at ?? now().toISOString()
    await appendFile(path, `${JSON.stringify({ schema: 1, at, ...boundary })}\n`, "utf8")
  }
}

function formatManagedDoDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Math.round(durationMs))
  if (milliseconds < 1_000) return `${milliseconds}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(3)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = ((milliseconds % 60_000) / 1_000).toFixed(3).padStart(6, "0")
  return `${minutes}:${seconds}`
}

/** Stable plain-text projection used by every managed-do exit path. */
export function formatManagedDoTimingTable(result: ManagedDoResult): string {
  const rows = [
    ...result.timings.map((timing) => ({
      stage: timing.stage,
      duration: formatManagedDoDuration(timing.durationMs),
      outcome: timing.phase,
    })),
    { stage: "TOTAL", duration: formatManagedDoDuration(result.durationMs), outcome: result.outcome },
  ]
  const stageWidth = Math.max("STAGE".length, ...rows.map((row) => row.stage.length))
  const durationWidth = Math.max("DURATION".length, ...rows.map((row) => row.duration.length))
  return [
    "managed do stage durations",
    `${"STAGE".padEnd(stageWidth)}  ${"DURATION".padStart(durationWidth)}  OUTCOME`,
    ...rows.map((row) => `${row.stage.padEnd(stageWidth)}  ${row.duration.padStart(durationWidth)}  ${row.outcome}`),
    "",
  ].join("\n")
}

/** Append one terminal summary per managed run. The detailed boundary journal
 * stays lossless; this row is the comparison-ready speed scoreboard. */
export function createManagedDoScoreboard(options: Readonly<{ stateDir: string }>): ManagedDoScoreboard {
  const dir = join(options.stateDir, "do-managed")
  const path = join(dir, "scoreboard.jsonl")
  return async (result) => {
    await mkdir(dir, { recursive: true })
    await appendFile(
      path,
      `${JSON.stringify({ schema: 1, issue: result.trail.issue, lane: result.trail.lane, ...result })}\n`,
      "utf8",
    )
  }
}

/** Filesystem-backed concurrency marker: one active managed run per state
 * directory. A marker whose pid is dead is reclaimed LOUDLY rather than
 * silently overwritten or silently obeyed. */
export function createManagedDoLock(
  options: Readonly<{ stateDir: string; pid?: number; alive?: (pid: number) => boolean; now?: () => Date }>,
): ManagedDoLock {
  const dir = join(options.stateDir, "do-managed")
  const marker = join(dir, "active.json")
  const pid = options.pid ?? process.pid
  const alive =
    options.alive ??
    ((candidate: number) => {
      try {
        process.kill(candidate, 0)
        return true
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
      }
    })
  return Object.freeze({
    async acquire(input) {
      const existing = await readMarker(marker)
      if (existing !== undefined && existing.pid !== pid && alive(existing.pid)) return { holder: existing }
      await mkdir(dir, { recursive: true })
      const startedAt = (options.now ?? (() => new Date()))().toISOString()
      await writeFile(marker, `${JSON.stringify({ pid, issue: input.issue, startedAt })}\n`, "utf8")
      return {
        ...(existing === undefined ? {} : { reclaimed: existing }),
        release: async () => {
          const held = await readMarker(marker)
          if (held?.pid === pid) await rm(marker, { force: true })
        },
      }
    },
  })
}

async function readMarker(path: string): Promise<ManagedDoHolder | undefined> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { pid?: unknown }).pid !== "number" ||
    typeof (parsed as { issue?: unknown }).issue !== "string" ||
    typeof (parsed as { startedAt?: unknown }).startedAt !== "string"
  ) {
    throw new Error(`yrd: managed 'do' marker ${path} is not a readable holder record`)
  }
  return Object.freeze(parsed as ManagedDoHolder)
}
