import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
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

export type ManagedDoStage = "concurrency" | "assign" | "bay" | "launch" | "carrier" | "draft" | "recut" | "observe"

export type ManagedDoOutcome = "landed" | "refused" | "timed-out"

export type ManagedDoTrail = Readonly<{
  issue: string
  lane: string
  bay?: string
  branch?: string
  carrier?: string
}>

export type ManagedDoResult = Readonly<{
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

/** A repository-configured command template. Same shape as a configured check
 * step: a shell `run` string plus an optional wall-clock bound. Yrd substitutes
 * nothing into the text — the issue, lane and Bay ride as `YRD_DO_*` environment
 * values, exactly the way `$YRD_BASE_SHA` reaches a check step. */
export type ManagedDoCommand = Readonly<{ run: string; timeoutMs?: number }>

export type ManagedDoConfig = Readonly<{
  lane?: string
  assign?: ManagedDoCommand
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
  openBay(input: Readonly<{ issue: string }>): Promise<ManagedDoBay>
  launch(input: Readonly<{ issue: string; lane: string; bay: string; path: string }>): Promise<void>
  /** One poll tick over the Bay's refreshed workspace head. */
  observeCarrier(input: Readonly<{ bay: string; branch: string }>): Promise<Readonly<{ headSha?: string }>>
  createDraft(input: Readonly<{ branch: string; issue: string }>): Promise<Readonly<{ pr: string }>>
  recut(input: Readonly<{ pr: string; preflight: boolean }>): Promise<void>
  observeDelivery(input: Readonly<{ pr: string }>): Promise<ManagedDoDelivery>
  sleep(ms: number): Promise<void>
  now(): number
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
): ManagedDoResult {
  return Object.freeze({ outcome: "refused" as const, stage, trail, reason, ...extra })
}

function timedOut(stage: ManagedDoStage, trail: ManagedDoTrail, reason: string): ManagedDoResult {
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

export async function runManagedDo(
  request: Readonly<{ issue: string; plan: ManagedDoPlan; stages: ManagedDoStages; lock: ManagedDoLock }>,
): Promise<ManagedDoResult> {
  const { issue, plan, stages, lock } = request
  const trail: ManagedDoTrail = { issue, lane: plan.settings.lane }
  const acquired = await lock.acquire({ issue })
  if ("holder" in acquired) {
    const holder = acquired.holder
    return refused(
      "concurrency",
      trail,
      `another managed 'do' run is active (pid ${holder.pid}, issue '${holder.issue}', since ${holder.startedAt}); ` +
        "managed concurrency is capped at 1",
    )
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

async function drive(issue: string, plan: ManagedDoPlan, stages: ManagedDoStages): Promise<ManagedDoResult> {
  const { settings } = plan
  let trail: ManagedDoTrail = { issue, lane: settings.lane }

  try {
    await stages.assign({ issue, lane: settings.lane })
  } catch (error) {
    return refused("assign", trail, detail(error))
  }

  let bay: ManagedDoBay
  try {
    bay = await stages.openBay({ issue })
  } catch (error) {
    return refused("bay", trail, detail(error))
  }
  trail = { ...trail, bay: bay.bay, branch: bay.branch }

  try {
    await stages.launch({ issue, lane: settings.lane, bay: bay.bay, path: bay.path })
  } catch (error) {
    return refused("launch", trail, detail(error))
  }

  const carrier = await awaitCarrier(bay, trail, settings, stages)
  if ("result" in carrier) return carrier.result

  // The DRAFT is cut before any gitlink commit and before any recut: an
  // authored gitlink on a submitted carrier is the trap state, and a draft is
  // the only shape that can be corrected mechanically.
  let pr: string
  try {
    pr = (await stages.createDraft({ branch: bay.branch, issue })).pr
  } catch (error) {
    const actionable = classify(error, undefined)
    return refused("draft", trail, actionable.cause, { remedy: actionable.resolution })
  }
  trail = { ...trail, carrier: pr }

  const admitted = await admit(pr, trail, bay, issue, stages)
  if (admitted !== undefined) return admitted

  return await observe(pr, trail, settings, stages)
}

async function awaitCarrier(
  bay: ManagedDoBay,
  trail: ManagedDoTrail,
  settings: ManagedDoSettings,
  stages: ManagedDoStages,
): Promise<Readonly<{ headSha: string }> | Readonly<{ result: ManagedDoResult }>> {
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
): Promise<ManagedDoResult | undefined> {
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
): Promise<ManagedDoResult | undefined> {
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
): Promise<ManagedDoResult> {
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
