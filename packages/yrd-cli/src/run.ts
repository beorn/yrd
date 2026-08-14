import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Command as CliCommand, CommanderError, int } from "@silvery/commander"
import { Fragment, createElement } from "react"
import {
  CompositionV1Schema,
  CorrelationSchema,
  DeploymentInputSchema,
  DeploymentSourceReceiptSchema,
  baseIdentity,
  currentPRRev,
  prBaseSha,
  prComposition,
  prCorrelation,
  prDeliveryState,
  prHead,
  isLivePR,
  prNeedsAuthor,
  prRevisionNumber,
  prRevisionLineage,
  prPublicationJobKey,
  PrPublicationInputSchema,
  prSourceReadyAt,
  deploymentJobKey,
  HabGenerationReleaseReceiptSchema,
  ReleaseDeploymentJobInputSchema,
  isConcurrentCheckabilityConflict,
  resolveBay,
  resolveBase,
  resolvePR,
  requireLivePR,
  type Bay,
  type BaysState,
  type CompositionV1,
  type Correlation,
  type PR,
  type PRFreshnessTransition,
  type PRDeliveryState,
  type PRRegression,
  type PRRegressionSeverity,
  type PRRev,
  type PrPublicationInput,
  type MaterializeDeploymentInput,
  type ReleaseDeploymentJobInput,
} from "@yrd/bay"
import { CompetitorDefSchema, type CompetitorDef, type Contest } from "@yrd/contest"
import {
  compareNatural,
  createFailure,
  failureFact,
  raiseFailure,
  SUPPORTED_VERSIONS,
  type DeepReadonly,
  type JournalSnapshot,
} from "@yrd/core"
import { isConcurrentSettlementConflict } from "@yrd/job"
import type { Job, JobError } from "@yrd/job"
import { createProcess, pathReapFailure, type Process, type ProcessResult } from "@yrd/process"
import {
  isQueueRunningConflict,
  MERGE_RECORD_REF,
  mergeRecordToStatement,
  Queues,
  resolveSubmoduleOrigin,
  sweepUncarriedRefs,
  synthesizePinIntentCarrier,
  type InTotoStatement,
  type MergeRecordBody,
  type PREligibility,
  type RefGit,
  type QueueAuditFinding,
  type QueueSummary,
  type Run,
} from "@yrd/queue"
import { createExclusive } from "@yrd/persistence"
import { loadYrdConfig, renderYrdConfigScaffold } from "./config.ts"
import { diagnoseYrdFlows } from "./config-doctor.ts"
import { cleanGitEnvironment } from "./git-environment.ts"
import { actionableFailure, formatActionableFailure } from "./actionable-error.ts"
import {
  classifyFailure,
  configureYrdGlobalOptions,
  configuration,
  normalizeYrdInvocation,
  refusal,
  resolveYrdContext,
  stableJson,
  usage,
  type NormalizedYrdInvocation,
  type RuntimePosture,
  type YrdContext,
} from "./invocation.ts"
import { requireUnqualifiedRunSelector } from "./qualified-run-ref.ts"
import { getLiveRenderer } from "./live-renderer.ts"
import {
  QueueLogView,
  PRChecksView,
  PRDetailView,
  PRListView,
  PRRunsView,
  QueueRecoveryView,
  QueueRunsView,
  QueueTimelineView,
  QueueStatusView,
  type PRCheckViewRecord,
  type QueueLogCoverage,
  type QueueLogRow,
  PRResultView,
  queueLogRows,
  latestRunForCurrentRevision,
  prListRows,
  prDetailData,
  projectedPrStatus,
  queuePauseWarnings,
  queueRunRevisionClocks,
  queueTimelineAdmissionTimes,
  createQueueTimelineProjectionClock,
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  RUNNER_STALE_MS,
  runRevisionClock,
  queueShowData,
  type QueueAttempt,
  type QueueRunnerRefusal,
  QueueRunnerProgress,
  type QueueDriverEpoch,
  type QueueTimelineProjection,
  type QueueTimelineRunner,
  type QueueTimelineStatusFilter,
  type UncarriedObservation,
  type QueueStatusResult,
} from "./queue-status-view.tsx"
import type { QueueReadModel } from "./queue-read-model.ts"
import {
  preflightRecut,
  prunePrs,
  withdrawPrs,
  type RecutPreflightResult,
  type RecutPreflightVerdict,
} from "./pr-withdraw.ts"
import {
  foldRefusalStall,
  formatRemedyCommand,
  planRefusalRemedies,
  refusalRemedyKey,
  RESIDENT_REFUSAL_STALL_CYCLES,
  type RefusalRemedyPlan,
  type RemedyStep,
  type ResidentRefusalObservation,
  type ResidentRefusalStall,
} from "./refusal-remedy.ts"
import { reconcilePrLandings, type PrLanding } from "./pr-landing.ts"
import { requireImplicitRecutBranchFreshness } from "./recut-branch-freshness.ts"
import { resolveSubmitSelectors } from "./submit-selection.ts"
import { lifecycleStatus } from "./status-presentation.ts"
import {
  classifyBayStatus,
  formatBayStatusHuman,
  parseOwnerPid,
  parseYrdBayProtections,
  protectionGapEvidenceForBay,
  protectionEvidenceForBay,
  freshOriginBranchMissing,
  YRD_BAY_PROTECTIONS_ENV,
  type BayStatusClass,
  type BayStatusFacts,
  type BayStatusReport,
} from "./bay-status.ts"
import { diagnostic, printHuman, printResult, printResultWithWarnings } from "./output.tsx"
import {
  createSubmoduleBranchResolver,
  firstLine,
  readSubmoduleEntries,
  setSubmoduleBranch,
  submoduleTrackingWarnings,
  superprojectOrigin,
  superprojectRoot,
  unbranchedSubmodules,
  type SubmoduleEntry,
} from "./submodule-tracking.ts"
import {
  BayStatusView,
  ContestStatusView,
  IssueLensView,
  type IssueDeliveryRow,
  type IssueLensRow,
} from "./status-view.tsx"
import {
  checkTaskStatusOf,
  issueTaskStatusOf,
  jobAttemptTaskStatusOf,
  prDeliveryTaskStatusOf,
  projectPRTaskStatus,
  projectQueueRunTaskStatus,
  taskStatusFields,
} from "./task-status.ts"
import type { YrdBayProtection, YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices, YrdCliState } from "./types.ts"
import { formatYrdRuntimeVersion, YRD_VERSION } from "./version.ts"
import { ensureWorkspaceDependencies } from "./workspace-provisioning.ts"
import { retainedWorkspaceNote } from "./workspace-retention.ts"
import { artifactLocation, directArtifacts, nestedArtifacts, uniqueArtifacts } from "./artifact-reference.ts"
import { readInstalledBaselines } from "./installed-baseline.ts"
import { renderRemedyStep } from "@yrd/intent"
import { admitPinIntent } from "./intent-admission.ts"
import { authoredSubmodulePinBase, changedSubmodulePins, unpublishedSubmodulePins } from "./pr-submodule-publication.ts"
import { landingAuthorityBoundary } from "./landing-authority-boundary.ts"
import { queueReadFailureMessage, type QueueReadFailure } from "./queue-read-failure.ts"
// The live watch UI is loaded lazily at its single use site in watchQueue(): it is the only
// module that pulls silvery's SplitPane, and eagerly importing it here would make every CLI
// path (yrd --version, submit, one-shot queue) require the interactive TUI dependency at module
// load. Types are erased, so they stay as a static type-only import.
import type { QueueArtifactOutput, QueuePrDiff, QueueWatchFocus, QueueWatchSnapshot } from "./watch-pane.tsx"

const GIT_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_CODE = "ETIMEDOUT"

function gitTimeoutError(args: readonly string[], cause?: unknown): Error & { code: typeof GIT_TIMEOUT_CODE } {
  const message = `yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })
  return Object.assign(error, { code: GIT_TIMEOUT_CODE } as const)
}

function isGitTimeoutError(error: unknown): error is Error & { code: typeof GIT_TIMEOUT_CODE } {
  return typeof error === "object" && error !== null && "code" in error && error.code === GIT_TIMEOUT_CODE
}

function gitSync(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: cleanGitEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    })
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ETIMEDOUT") {
      throw gitTimeoutError(args, error)
    }
    throw error
  }
}

type QueueGitRunner = (cwd: string, args: readonly string[]) => Promise<string>

export async function runQueueGit(
  process: Pick<Process, "run">,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await process.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.timedOut) {
    throw gitTimeoutError(args)
  }
  if (result.exitCode !== 0) {
    throw new Error(`yrd: git ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

async function gitAsync(cwd: string, args: readonly string[]): Promise<string> {
  await using process = createProcess()
  return await runQueueGit(process, cwd, args)
}

/** Memoized answers for {@link queueGitDir}, keyed by the cwd exactly as passed
 * (normalizing it would itself cost a syscall, and every caller already threads
 * one stable cwd). A repository's common Git directory cannot move under a
 * running process, so this is immutable process state, not a staleness risk.
 * The absence answer is cached too — otherwise the not-a-repository path keeps
 * paying the fork it is supposed to have stopped paying. */
const queueGitDirs = new Map<string, string | undefined>()

/** `git rev-parse --git-common-dir` for the queue repository.
 *
 * `residentRunnerStatus` sits on top of this, and `queueListSnapshot` calls that
 * unconditionally — once per 1s watch tick AND once per focus/cursor change. The
 * lookup is `execFileSync`, so an uncached call BLOCKS the watch UI on a git fork
 * for every keypress. The value is immutable for the lifetime of the process, so
 * it is computed once per cwd and memoized. */
function queueGitDir(cwd: string): string | undefined {
  if (queueGitDirs.has(cwd)) return queueGitDirs.get(cwd)
  const gitDir = readQueueGitDir(cwd)
  queueGitDirs.set(cwd, gitDir)
  return gitDir
}

function readQueueGitDir(cwd: string): string | undefined {
  try {
    const output = gitSync(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    const gitDir = output.trim()
    if (gitDir === "") return undefined
    return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir)
  } catch (error) {
    // A timeout is a transient failure, never an answer: rethrow it so the caller
    // sees it and `queueGitDir` leaves the memo unpopulated for this cwd, rather
    // than poisoning the whole process with a cached "no git dir".
    if (isGitTimeoutError(error)) throw error
    // silent-fallback-allow: `rev-parse --git-common-dir` fails exactly when `cwd`
    // is not inside a Git repository. That is a legitimate ABSENCE, and it is
    // reported loudly by every caller rather than swallowed here —
    // `residentRunnerLeaseHeld` and `runnerGitHealth` raise
    // `runner-health-unavailable` naming the cwd, and `residentRunnerStatusPath`
    // returns undefined so `residentRunnerStatus` answers "no resident runner".
    // The only information discarded is git's wording of "not a repository".
    return undefined
  }
}

const RESIDENT_RUNNER_HEARTBEAT_MS = 5_000

/** How often the resident follow loop runs its unscoped lease-expiry recovery
 * sweep (D1b). Startup reclaim is one-shot; this settles ghosts left by runners
 * that die AFTER it. A constant, not config — the throttle is measured in wall
 * time via `io.now`, so a busy tick cadence cannot starve or spam it. */
const RESIDENT_RECOVERY_SWEEP_MS = 60_000
const RESIDENT_MAINTENANCE_INTERVAL_MS = 60_000

/** Exit code when a hard signal cuts an unfinished drain short, leaving in-flight
 * work (D3). An operator-requested stop that FINISHES (drain complete) exits 0;
 * a signal-forced interruption exits non-zero so the resident breaker records
 * the failure instead of mistaking interrupted work for a clean lifetime. */
const RESIDENT_INTERRUPTED_EXIT: YrdCliExitCode = 3
/** A resident that restarts itself out of presumptive poisoned-observer state
 * (22474 specimen 3) exits with the same UNCLEAN code as a signal-forced stop:
 * both mean "this runner stopped with queue work outstanding" and must count
 * against the resident breaker. The distinguishing evidence is the loud
 * `resident-refusal-stall-restart` record, not the code. */
const RESIDENT_POISONED_EXIT: YrdCliExitCode = RESIDENT_INTERRUPTED_EXIT

function residentRunnerStatusPath(cwd: string, stateDir?: string): string | undefined {
  if (stateDir !== undefined) return join(stateDir, "resident-runner", "status.json")
  const gitDir = queueGitDir(cwd)
  return gitDir === undefined ? undefined : join(gitDir, "yrd", "resident-runner", "status.json")
}

function residentRunnerTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", `yrd: resident runner ${field} is invalid`)
  }
  return value
}

function parseResidentRunnerProgress(value: unknown): QueueRunnerProgress | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner queueProgress is invalid")
  }
  const progress = value as Record<string, unknown>
  const observedAt =
    progress.observedAt === undefined
      ? undefined
      : residentRunnerTimestamp(progress.observedAt, "queueProgress observedAt")
  // Status records from progress-aware runners before the observation-time
  // contract remain readable, but their un-timestamped belief is not health.
  if (progress.state === "healthy") return observedAt === undefined ? undefined : { state: "healthy", observedAt }
  if (progress.state === "stalled" && Array.isArray(progress.findings) && progress.findings.length > 0) {
    const findings = progress.findings.map((finding): QueueAuditFinding => {
      if (typeof finding !== "object" || finding === null) {
        raiseFailure(
          "infrastructure",
          "resident-runner-status-invalid",
          "yrd: resident runner queueProgress finding is invalid",
        )
      }
      const record = finding as Record<string, unknown>
      if (typeof record.code !== "string" || typeof record.message !== "string") {
        raiseFailure(
          "infrastructure",
          "resident-runner-status-invalid",
          "yrd: resident runner queueProgress finding identity is invalid",
        )
      }
      for (const field of ["run", "pr", "specimen", "step", "refusal"] as const) {
        if (record[field] !== undefined && typeof record[field] !== "string") {
          raiseFailure(
            "infrastructure",
            "resident-runner-status-invalid",
            `yrd: resident runner queueProgress finding ${field} is invalid`,
          )
        }
      }
      if (
        record.resolution !== undefined &&
        (!Array.isArray(record.resolution) || record.resolution.some((step) => typeof step !== "string"))
      ) {
        raiseFailure(
          "infrastructure",
          "resident-runner-status-invalid",
          "yrd: resident runner queueProgress finding resolution is invalid",
        )
      }
      if (record.count !== undefined && (!Number.isSafeInteger(record.count) || (record.count as number) < 0)) {
        raiseFailure(
          "infrastructure",
          "resident-runner-status-invalid",
          "yrd: resident runner queueProgress finding count is invalid",
        )
      }
      if (
        record.since !== undefined &&
        (typeof record.since !== "string" || !Number.isFinite(Date.parse(record.since)))
      ) {
        raiseFailure(
          "infrastructure",
          "resident-runner-status-invalid",
          "yrd: resident runner queueProgress finding since is invalid",
        )
      }
      if (
        record.blockedMs !== undefined &&
        (!Number.isSafeInteger(record.blockedMs) || (record.blockedMs as number) < 0)
      ) {
        raiseFailure(
          "infrastructure",
          "resident-runner-status-invalid",
          "yrd: resident runner queueProgress finding blockedMs is invalid",
        )
      }
      return record as QueueAuditFinding
    })
    return observedAt === undefined ? undefined : { state: "stalled", observedAt, findings }
  }
  raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner queueProgress is invalid")
}

function parseQueueDriverEpoch(value: unknown): QueueDriverEpoch | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner driver is invalid")
  }
  const driver = value as Record<string, unknown>
  if (typeof driver.queueId !== "string" || driver.queueId.trim() === "") {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner driver queueId is invalid")
  }
  if (typeof driver.epoch !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(driver.epoch)) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner driver epoch is invalid")
  }
  let lastLanded: QueueDriverEpoch["lastLanded"]
  if (driver.lastLanded === null) {
    lastLanded = null
  } else if (typeof driver.lastLanded === "object" && driver.lastLanded !== null) {
    const landed = driver.lastLanded as Record<string, unknown>
    if (
      typeof landed.commit !== "string" ||
      !/^[0-9a-f]{40,64}$/u.test(landed.commit) ||
      typeof landed.at !== "string" ||
      !Number.isFinite(Date.parse(landed.at))
    ) {
      raiseFailure(
        "infrastructure",
        "resident-runner-status-invalid",
        "yrd: resident runner driver lastLanded is invalid",
      )
    }
    lastLanded = { commit: landed.commit, at: landed.at }
  } else {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: resident runner driver lastLanded is invalid",
    )
  }
  return { queueId: driver.queueId, epoch: driver.epoch, lastLanded }
}

function parseUncarriedObservation(value: unknown): UncarriedObservation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner uncarried is invalid")
  }
  const observation = value as Record<string, unknown>
  if (!Number.isSafeInteger(observation.count) || (observation.count as number) < 0) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner uncarried count is invalid")
  }
  if (!Number.isSafeInteger(observation.scanned) || (observation.scanned as number) < 0) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: resident runner uncarried scanned count is invalid",
    )
  }
  if (
    observation.missingUpdateClocks !== undefined &&
    (!Number.isSafeInteger(observation.missingUpdateClocks) || (observation.missingUpdateClocks as number) < 0)
  ) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: resident runner uncarried missing update-clock count is invalid",
    )
  }
  const count = observation.count as number
  const scanned = observation.scanned as number
  const missingUpdateClocks = observation.missingUpdateClocks as number | undefined
  if (count > scanned || (missingUpdateClocks !== undefined && count + missingUpdateClocks > scanned)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: resident runner uncarried counts exceed its scanned population",
    )
  }
  const observedAt = residentRunnerTimestamp(observation.observedAt, "uncarried observedAt")
  return {
    count,
    scanned,
    ...(missingUpdateClocks === undefined ? {} : { missingUpdateClocks }),
    observedAt,
  }
}

function parseResidentRunnerStatus(text: string): QueueTimelineRunner {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner status is not JSON")
  }
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner status is not an object")
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner pid is invalid")
  }
  const startedAt = residentRunnerTimestamp(record.startedAt, "startedAt")
  const lastTickAt = residentRunnerTimestamp(record.lastTickAt, "lastTickAt")
  const queueProgress = parseResidentRunnerProgress(record.queueProgress)
  const driver = parseQueueDriverEpoch(record.driver)
  const uncarried = parseUncarriedObservation(record.uncarried)
  if (Date.parse(lastTickAt) < Date.parse(startedAt)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: resident runner lastTickAt precedes startedAt",
    )
  }
  if (record.command !== undefined && typeof record.command !== "string") {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner command is invalid")
  }
  if (record.clean !== undefined && typeof record.clean !== "boolean") {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner clean flag is invalid")
  }
  if (
    record.implementationSource !== undefined &&
    (typeof record.implementationSource !== "string" ||
      !/^(?:dirty|git):[0-9a-f]{40,64}$/u.test(record.implementationSource))
  ) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: resident runner implementationSource is invalid",
    )
  }
  if (
    record.journalVersions !== undefined &&
    (!Array.isArray(record.journalVersions) ||
      record.journalVersions.some((version) => !Number.isSafeInteger(version) || (version as number) < 1))
  ) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: resident runner journalVersions is invalid")
  }
  return {
    pid: record.pid as number,
    startedAt,
    lastTickAt,
    ...(queueProgress === undefined ? {} : { queueProgress }),
    ...(driver === undefined ? {} : { driver }),
    ...(uncarried === undefined ? {} : { uncarried }),
    ...(record.command === undefined ? {} : { command: record.command as string }),
    ...(record.exitedAt === undefined ? {} : { exitedAt: residentRunnerTimestamp(record.exitedAt, "exitedAt") }),
    ...(record.clean === undefined ? {} : { clean: record.clean }),
    implementationSource:
      record.implementationSource === undefined ? "unknown" : (record.implementationSource as string),
    ...(record.journalVersions === undefined ? {} : { journalVersions: record.journalVersions as number[] }),
  }
}

export async function residentRunnerStatus(cwd: string, stateDir?: string): Promise<QueueTimelineRunner | null> {
  const path = residentRunnerStatusPath(cwd, stateDir)
  if (path === undefined) return null
  try {
    return parseResidentRunnerStatus(await readFile(path, "utf8"))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
    throw cause
  }
}

/** Whether the recorded pid still names a live process. ESRCH is proof it is
 * gone; EPERM proves the opposite — a process exists that this user does not
 * own — so only ESRCH may retire a runner. */
function residentRunnerRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** The status file is no longer deleted on close (D1a) — a departed runner leaves
 * an exit marker so a successor can reclaim its pid. For DISPLAY (health + timeline)
 * an exited runner is not draining, so it reads as "no active runner", preserving
 * the pre-marker "NO RUNNER"/absent semantics. Reclaim, by contrast, consumes the
 * raw marker (it needs the dead pid), so it must NOT go through this filter.
 *
 * `exitedAt` alone only retires runners that got to write it. A SIGKILL, an OOM,
 * or a crash leaves the record behind with a plausible pid and a frozen
 * heartbeat, which then displays as STALE — "a runner that is running late" —
 * for an unattended queue (22374). The pid probe is what separates departed from
 * late, so display asks it directly. */
function activeResidentRunner(runner: QueueTimelineRunner | null): QueueTimelineRunner | null {
  if (runner === null || runner.exitedAt !== undefined) return null
  return residentRunnerRunning(runner.pid) ? runner : null
}

type RunnerGitDistance = Readonly<{
  base: string
  baseSha: string
  ahead?: number
  behind?: number
  unavailable?: string
}>

type RunnerGitHealth = Readonly<{
  cwd: string
  headSha: string
  dirty: boolean
  baselines: readonly RunnerGitDistance[]
}>

/** The toolchain THIS invocation is running on. Step identity no longer depends
 * on the launcher's bun/node versions (22374), but which binary is in the
 * caller's PATH remains the discriminating read whenever a resident and an
 * operator disagree — and `execPath` is the part that names the install rather
 * than merely a version two installs can share. */
type RunnerLauncherFacts = Readonly<{
  bun: string
  node: string
  platform: string
  arch: string
  execPath: string
}>

function runnerLauncherFacts(): RunnerLauncherFacts {
  return {
    bun: Bun.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
  }
}

type RunnerHealthFacts = Readonly<{
  lease: "held" | "free" | "unknown"
  leaseDriver?: Readonly<{ queueId: string; epoch: string }>
  runnerStatus: "fresh" | "stale" | "missing"
  runnerAgeMs?: number
  runner?: QueueTimelineRunner
  queueProgress: QueueRunnerProgress | Readonly<{ state: "unknown" }>
  queueProgressAgeMs?: number
  launcher: RunnerLauncherFacts
  git: RunnerGitHealth
}>

type RunnerHealthPayload = Readonly<{
  schema: "hab-service-health/1"
  command: "queue.list.check"
  service: string
  state: "healthy" | "absent" | "unhealthy"
  running: boolean
  error?: ReturnType<typeof actionableFailure>
  facts: RunnerHealthFacts
}>

type ResidentRunnerLeaseObservation = Readonly<{
  held: boolean
  driver?: Readonly<{ queueId: string; epoch: string }>
}>

function residentRunnerLeaseDriver(message: string): ResidentRunnerLeaseObservation["driver"] {
  const match = /holder=queue=(.*?) epoch=([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:;|\))/iu.exec(message)
  const queueId = match?.[1]
  const epoch = match?.[2]
  return queueId === undefined || epoch === undefined ? undefined : { queueId, epoch }
}

async function residentRunnerLeaseObservation(cwd: string): Promise<ResidentRunnerLeaseObservation> {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) {
    raiseFailure("infrastructure", "runner-health-unavailable", `yrd: '${cwd}' is not a Git queue repository`)
  }
  try {
    await createExclusive(join(gitDir, "yrd", "resident-runner"), { timeoutMs: 0 }).run(() => Promise.resolve())
    return { held: false }
  } catch (error) {
    const fact = failureFact(error)
    if (fact?.code === "exclusive-busy") {
      const driver = residentRunnerLeaseDriver(fact.message)
      return { held: true, ...(driver === undefined ? {} : { driver }) }
    }
    throw error
  }
}

export async function residentRunnerLeaseHeld(cwd: string): Promise<boolean> {
  return (await residentRunnerLeaseObservation(cwd)).held
}

function gitDistance(cwd: string, baseSha: string, headSha: string): Omit<RunnerGitDistance, "base" | "baseSha"> {
  try {
    const counts = gitSync(cwd, ["rev-list", "--left-right", "--count", `${baseSha}...${headSha}`])
      .trim()
      .split(/\s+/u)
      .map(Number)
    const behind = counts[0]
    const ahead = counts[1]
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new Error("invalid rev-list counts")
    return { ahead, behind }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message.split("\n", 1)[0] : String(error) }
  }
}

async function runnerGitHealth(cwd: string): Promise<RunnerGitHealth> {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) {
    raiseFailure("infrastructure", "runner-health-unavailable", `yrd: '${cwd}' is not a Git queue repository`)
  }
  const headSha = gitSync(cwd, ["rev-parse", "HEAD"]).trim().toLowerCase()
  const dirty = gitSync(cwd, ["status", "--porcelain"]).trim() !== ""
  const baselines = await readInstalledBaselines(join(gitDir, "yrd"))
  return {
    cwd,
    headSha,
    dirty,
    baselines: Object.values(baselines).map((baseline) => ({
      base: baseline.base,
      baseSha: baseline.baseSha,
      ...gitDistance(cwd, baseline.baseSha, headSha),
    })),
  }
}

function runnerHealthError(code: string, cause: string, resolution: readonly string[]) {
  return Object.freeze({ code, cause, resolution: Object.freeze([...resolution]) })
}

function queuedDeliveryCount(app: YrdCliApp): number {
  return Object.values(stateOf(app).bays.prs).filter((pr) => {
    const delivery = prDeliveryState(pr)
    return delivery === "submitted" || delivery === "ready"
  }).length
}

function sameDriverLanding(left: QueueDriverEpoch["lastLanded"], right: QueueDriverEpoch["lastLanded"]): boolean {
  return left === null ? right === null : right !== null && left.commit === right.commit && left.at === right.at
}

function runnerDriverHealthError(
  runner: QueueTimelineRunner,
  expectedQueueId: string,
  expectedLastLanded: QueueDriverEpoch["lastLanded"] | undefined,
): ReturnType<typeof runnerHealthError> | undefined {
  if (runner.driver === undefined) {
    return runnerHealthError(
      "resident-runner-driver-unknown",
      "resident runner heartbeat is fresh but does not identify its queue driver epoch",
      ["Restart the resident queue runner with the installed Yrd source."],
    )
  }
  if (runner.driver.queueId !== expectedQueueId) {
    return runnerHealthError(
      "resident-runner-driver-mismatch",
      `resident runner owns '${runner.driver.queueId}', not expected queue '${expectedQueueId}'`,
      ["Stop the mismatched resident and start the runner from the expected repository."],
    )
  }
  if (expectedLastLanded !== undefined && !sameDriverLanding(runner.driver.lastLanded, expectedLastLanded)) {
    return runnerHealthError(
      "resident-runner-driver-stale",
      "resident runner heartbeat does not report the queue's latest landed commit",
      ["Inspect the resident runner log and restart it if its driver epoch is no longer advancing."],
    )
  }
  return undefined
}

/** Project the resident's canonical progress findings into its lightweight
 * status record. The supervisor can then prove outcome progress without
 * replaying Journal history in its health probe. */
export function residentQueueProgress(app: YrdCliApp, now: string): QueueRunnerProgress {
  const findings = app.queue
    .audit({ now })
    .findings.filter(
      (finding) =>
        finding.code === "queue-progress-stalled" ||
        finding.code === "queue-never-started" ||
        finding.code === "admission-refusal-loop" ||
        finding.code === "queue-hold-ttl-missing" ||
        finding.code === "queue-hold-expired",
    )
    .map((finding) => {
      if (finding.code !== "admission-refusal-loop") return finding
      const failure = actionableFailure({
        code: finding.refusal ?? finding.code,
        message: finding.message,
        ...(finding.resolution === undefined ? {} : { resolution: finding.resolution }),
      })
      return { ...finding, resolution: failure.resolution }
    })
  return findings.length === 0 ? { state: "healthy", observedAt: now } : { state: "stalled", observedAt: now, findings }
}

/** Exact latest landing driven for one queue. The epoch heartbeat publishes
 * this content so a probe can distinguish the right driver from an unrelated
 * resident process with the same service name. */
export function residentDriverLastLanded(app: YrdCliApp, base: string): QueueDriverEpoch["lastLanded"] {
  return (
    Object.values(stateOf(app).bays.prs)
      .flatMap((pr) => {
        if (
          baseIdentity(pr.base) !== baseIdentity(base) ||
          pr.integratedAt === undefined ||
          pr.integration === undefined
        ) {
          return []
        }
        return [{ commit: pr.integration.commit, at: pr.integratedAt }]
      })
      .toSorted((left, right) => left.at.localeCompare(right.at))
      .at(-1) ?? null
  )
}

async function queueRunnerHealth(
  app: YrdCliApp | undefined,
  services: YrdCliServices,
  io: YrdCliIO,
  options: Readonly<{ queueProgress?: QueueRunnerProgress }> = {},
): Promise<{
  payload: RunnerHealthPayload
  exitCode: YrdCliExitCode
}> {
  const cwd = io.cwd ?? process.cwd()
  const service = io.healthServiceName?.trim() || "yrd-runner"
  const audit = services.queue?.auditEnvironment
  let leaseHeld: boolean | undefined
  let leaseDriver: ResidentRunnerLeaseObservation["driver"]
  let git: RunnerGitHealth = { cwd, headSha: "unknown", dirty: false, baselines: [] }
  try {
    const lease = await residentRunnerLeaseObservation(cwd)
    leaseHeld = lease.held
    leaseDriver = lease.driver
    if (audit === undefined) {
      raiseFailure(
        "configuration",
        "queue-audit-unavailable",
        "yrd: queue.audit capability is not installed; runner health cannot prove baseline freshness",
      )
    }
    const runner = activeResidentRunner(await residentRunnerStatus(cwd))
    git = await runnerGitHealth(cwd)
    const auditResult = await audit()
    const now = io.now?.() ?? Date.now()
    const runnerAgeMs = runner === null ? undefined : Math.max(0, now - Date.parse(runner.lastTickAt))
    const runnerStatus = runnerAgeMs === undefined ? "missing" : runnerAgeMs > RUNNER_STALE_MS ? "stale" : "fresh"
    const queueProgress = options.queueProgress ?? runner?.queueProgress ?? { state: "unknown" as const }
    const progressAgeMs = queueProgress.state === "unknown" ? undefined : QueueRunnerProgress.ageMs(queueProgress, now)
    const facts: RunnerHealthFacts = {
      lease: leaseHeld ? "held" : "free",
      ...(leaseDriver === undefined ? {} : { leaseDriver }),
      runnerStatus,
      ...(runnerAgeMs === undefined ? {} : { runnerAgeMs }),
      ...(runner === null ? {} : { runner }),
      queueProgress,
      ...(progressAgeMs === undefined ? {} : { queueProgressAgeMs: progressAgeMs }),
      launcher: runnerLauncherFacts(),
      git,
    }
    const drift = auditResult.findings.filter(
      (finding) => finding.code === "config-drift" || finding.code === "runtime-drift",
    )
    if (drift.length > 0) {
      const first = drift[0]
      if (first === undefined) throw new Error("drift projection lost its first finding")
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: leaseHeld,
          error: actionableFailure({ code: first.code, message: drift.map((finding) => finding.message).join("\n") }),
          facts,
        },
      }
    }
    if (!leaseHeld) {
      const hasQueuedWork = app !== undefined && queuedDeliveryCount(app) > 0
      if (hasQueuedWork) {
        return {
          exitCode: 2,
          payload: {
            schema: "hab-service-health/1",
            command: "queue.list.check",
            service,
            state: "unhealthy",
            running: false,
            error: runnerHealthError(
              "resident-runner-missing",
              "the queue has work but no resident runner owns the drain lease",
              ["Start or restart the resident queue runner."],
            ),
            facts,
          },
        }
      }
      return {
        exitCode: 1,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "absent",
          running: false,
          facts,
        },
      }
    }
    if (runnerStatus !== "fresh") {
      const detail = runnerStatus === "missing" ? "has no heartbeat" : `heartbeat is stale by ${runnerAgeMs ?? 0}ms`
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: true,
          error: runnerHealthError("resident-runner-unhealthy", `resident runner lease is held but ${detail}`, [
            "Inspect the lease owner and resident log, then stop that owner before starting a replacement.",
          ]),
          facts,
        },
      }
    }
    const base = baseIdentity(services.base ?? "main")
    const expectedLastLanded = app === undefined ? undefined : residentDriverLastLanded(app, base)
    const driverError =
      runner === null ? undefined : runnerDriverHealthError(runner, `${resolve(cwd)}#${base}`, expectedLastLanded)
    if (driverError !== undefined) {
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: true,
          error: driverError,
          facts,
        },
      }
    }
    const leaseContentError =
      leaseDriver === undefined
        ? runnerHealthError(
            "resident-runner-lease-content-unknown",
            "resident runner lease is held but does not name its queue driver epoch",
            ["Restart the resident queue runner with the installed Yrd source."],
          )
        : runner?.driver !== undefined &&
            (leaseDriver.queueId !== runner.driver.queueId || leaseDriver.epoch !== runner.driver.epoch)
          ? runnerHealthError(
              "resident-runner-lease-content-mismatch",
              "resident runner lease content does not match its heartbeat driver epoch",
              ["Stop the mismatched resident and start one replacement for the expected queue."],
            )
          : undefined
    if (leaseContentError !== undefined) {
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: true,
          error: leaseContentError,
          facts,
        },
      }
    }
    if (queueProgress.state === "unknown") {
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: true,
          error: runnerHealthError(
            "resident-runner-progress-unknown",
            "resident runner heartbeat is fresh but reports no queue outcome progress",
            ["Restart the resident queue runner with the installed Yrd source."],
          ),
          facts,
        },
      }
    }
    if (progressAgeMs === undefined || progressAgeMs > RUNNER_STALE_MS) {
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: true,
          error: runnerHealthError(
            "resident-runner-progress-stale",
            `resident runner heartbeat is fresh but its queue outcome observation is ${
              progressAgeMs === undefined ? "invalid" : `stale by ${String(progressAgeMs)}ms`
            }`,
            ["Restart the resident queue runner with the installed Yrd source."],
          ),
          facts,
        },
      }
    }
    if (queueProgress.state === "stalled") {
      return {
        exitCode: 2,
        payload: {
          schema: "hab-service-health/1",
          command: "queue.list.check",
          service,
          state: "unhealthy",
          running: true,
          error: runnerHealthError(
            "resident-runner-no-progress",
            queueProgress.findings.map((finding) => finding.message).join("\n"),
            ["Inspect queue audit and the resident log before restarting the runner."],
          ),
          facts,
        },
      }
    }

    const hasQueuedWork = app !== undefined && queuedDeliveryCount(app) > 0
    if (runnerStatus === "fresh" && hasQueuedWork && runnerAgeMs !== undefined && runner !== null) {
      const runnerUptimeMs = now - Date.parse(runner.startedAt)
      if (runnerUptimeMs >= 3 * 60 * 60_000) {
        const expectedLastLanded = app === undefined ? undefined : residentDriverLastLanded(app, base)
        const lastLandedMs = expectedLastLanded ? Date.parse(expectedLastLanded.at) : 0
        const noMergeMs = now - lastLandedMs
        if (noMergeMs >= 3 * 60 * 60_000) {
          const uptimeFormatted = Math.floor(runnerUptimeMs / 3600000)
          const noMergeFormatted = Math.floor(noMergeMs / 3600000)
          return {
            exitCode: 2,
            payload: {
              schema: "hab-service-health/1",
              command: "queue.list.check",
              service,
              state: "unhealthy",
              running: true,
              error: runnerHealthError(
                "resident-runner-stalled-no-merge",
                `resident runner has cycled for >${uptimeFormatted} hours with a non-empty ready set and no merge for >${noMergeFormatted} hours`,
                ["Inspect the queue audit and restore delivery progress; process presence alone is not progress."],
              ),
              facts,
            },
          }
        }
      }
    }

    return {
      exitCode: 0,
      payload: {
        schema: "hab-service-health/1",
        command: "queue.list.check",
        service,
        state: "healthy",
        running: true,
        facts,
      },
    }
  } catch (error) {
    const fact = failureFact(error) ?? {
      code: "runner-health-failed",
      message: error instanceof Error ? error.message : String(error),
    }
    const lease = leaseHeld === undefined ? "unknown" : leaseHeld ? "held" : "free"
    return {
      exitCode: 2,
      payload: {
        schema: "hab-service-health/1",
        command: "queue.list.check",
        service,
        state: "unhealthy",
        running: leaseHeld === true,
        error: actionableFailure(fact),
        facts: {
          lease,
          runnerStatus: "missing",
          queueProgress: { state: "unknown" },
          launcher: runnerLauncherFacts(),
          git,
        },
      },
    }
  }
}

/** Second liveness clock for active seats. Unlike the resident heartbeat, this
 * invocation reconstructs queue progress from the loaded state and then uses
 * the same runner-health decision as the Hab timer probe. It is advisory: the
 * requested command still runs. Human invocations report the observation on
 * stderr; machine-readable invocations keep their one-document contract while
 * still executing the read-only check. */
async function runClientDeadMan(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
  emitHuman: boolean,
): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  const base = baseIdentity(services.base ?? "main")
  const nowMs = io.now?.() ?? Date.now()
  const queueProgress = residentQueueProgress(app, new Date(nowMs).toISOString())
  const runner = activeResidentRunner(await residentRunnerStatus(cwd))
  const runnerAgeMs = runner === null ? undefined : Math.max(0, nowMs - Date.parse(runner.lastTickAt))
  const runnerError =
    runner === null
      ? queuedDeliveryCount(app) > 0
        ? runnerHealthError(
            "resident-runner-missing",
            "the queue has work but no resident runner owns the drain lease",
            ["Start or restart the resident queue runner."],
          )
        : undefined
      : runnerAgeMs !== undefined && runnerAgeMs > RUNNER_STALE_MS
        ? runnerHealthError("resident-runner-unhealthy", `resident runner heartbeat is stale by ${runnerAgeMs}ms`, [
            "Inspect the resident runner log, then restart it.",
          ])
        : runnerDriverHealthError(runner, `${resolve(cwd)}#${base}`, residentDriverLastLanded(app, base))
  const observations = [
    ...(queueProgress.state === "stalled"
      ? queueProgress.findings.map((finding) => ({ code: finding.code, cause: finding.message }))
      : []),
    ...(runnerError === undefined ? [] : [{ code: runnerError.code, cause: runnerError.cause }]),
  ]
  if (!emitHuman) return
  for (const observation of observations) {
    io.stderr(`yrd: dead-man: ${observation.cause}\n`)
  }
}

async function checkQueueRunner(
  app: YrdCliApp | undefined,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const result = await queueRunnerHealth(app, services, io)
  const gitLines = result.payload.facts.git.baselines.map((distance) =>
    distance.unavailable === undefined
      ? `git ${distance.base}: ahead=${distance.ahead ?? 0} behind=${distance.behind ?? 0} baseline=${distance.baseSha.slice(0, 12)}`
      : `git ${distance.base}: distance unavailable (${distance.unavailable})`,
  )
  const human = [
    `yrd-runner ${result.payload.state} (lease=${result.payload.facts.lease}, heartbeat=${result.payload.facts.runnerStatus})`,
    ...(result.payload.error === undefined ? [] : [formatActionableFailure(result.payload.error)]),
    ...gitLines,
  ].join("\n")
  await printResult(io, jsonEnabled(options), result.payload, human)
  return result.exitCode
}

export type ResidentRunnerReclaim = Readonly<{ reclaim: false }> | Readonly<{ reclaim: true; runner: string }>

/**
 * Decide whether an incoming resident runner should reclaim the leases of the
 * prior resident recorded in `status.json`. The prior resident is reclaimable
 * only when it is a different process that is no longer alive; a live prior pid
 * (or an absent status file) yields no reclaim. `isProcessAlive` is injected so
 * the decision is unit-testable without spawning a process.
 */
export function planResidentRunnerReclaim(
  prior: QueueTimelineRunner | null,
  currentPid: number,
  isProcessAlive: (pid: number) => boolean,
): ResidentRunnerReclaim {
  if (prior === null || prior.pid === currentPid) return { reclaim: false }
  if (isProcessAlive(prior.pid)) return { reclaim: false }
  return { reclaim: true, runner: `yrd-cli:${prior.pid}` }
}

function residentRunnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // ESRCH means no such process — dead, safe to reclaim. Any other error
    // (EPERM in particular) means the process exists but we cannot signal it;
    // treat it as alive and skip reclaim.
    return (cause as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function reclaimDeadResidentRunner(app: YrdCliApp, io: YrdCliIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  const prior = await residentRunnerStatus(cwd)
  const decision = planResidentRunnerReclaim(prior, process.pid, residentRunnerProcessAlive)
  if (!decision.reclaim) return
  const runs = await app.queue.recover({
    recoveryTime: new Date(io.now?.() ?? Date.now()).toISOString(),
    reason: "previous resident runner disappeared",
    runner: decision.runner,
  })
  if (runs.length === 0) return
  io.stderr(`Reclaimed ${runs.length} run(s) from a departed resident runner ${decision.runner}.\n`)
}

type ResidentRunnerHeartbeat = Readonly<{
  check(): void
  /** Publish terminal progress evidence before a typed resident control transfer. */
  recordProgress(progress: QueueRunnerProgress): Promise<void>
  /** Stop the heartbeat and leave an exit marker in status.json (never delete it).
   * `clean` = true for an operator/drain stop, false for a signal-forced/crash exit. */
  close(clean: boolean): Promise<void>
}>

function heartbeatDelay(intervalMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (elapsed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(elapsed)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(true), intervalMs)
    timer.unref?.()
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export async function startResidentRunnerHeartbeat(
  io: YrdCliIO,
  options: Readonly<{
    intervalMs?: number
    queueProgress?: (now: string) => QueueRunnerProgress
    /** Last uncarried sweep, if one has completed. Returning undefined is a
     * real answer — the rail says "not swept" rather than 0. */
    uncarried?: () => UncarriedObservation | undefined
    driver?: Readonly<{
      queueId: string
      epoch?: string
      lastLanded: () => QueueDriverEpoch["lastLanded"]
    }>
  }> = {},
): Promise<ResidentRunnerHeartbeat> {
  const cwd = io.cwd ?? process.cwd()
  const path = residentRunnerStatusPath(cwd)
  if (path === undefined) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-unavailable",
      `yrd: cannot resolve resident runner status path from '${cwd}'`,
    )
  }
  const intervalMs = options.intervalMs ?? RESIDENT_RUNNER_HEARTBEAT_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError("yrd: resident runner heartbeat interval must be a positive integer")
  }
  const directory = join(path, "..")
  const temporary = `${path}.${process.pid}.tmp`
  const implementationSource = io.implementationSource
  if (implementationSource === undefined) {
    raiseFailure(
      "refusal",
      "runtime-source-unavailable",
      "yrd: resident runner startup did not capture an implementation source; not serving",
    )
  }
  const nowIso = (): string => {
    const now = io.now?.() ?? Date.now()
    if (!Number.isFinite(now) || now < 0) throw new TypeError("yrd: resident runner heartbeat clock is invalid")
    return new Date(now).toISOString()
  }
  const startedAt = nowIso()
  let recordedProgress: QueueRunnerProgress | undefined
  const driverEpoch = options.driver === undefined ? undefined : (options.driver.epoch ?? randomUUID())
  // The dedicated RUNNER box renders this verbatim: `[pid] <command>`.
  const command = [basename(process.argv[0] ?? "bun"), ...process.argv.slice(1)].join(" ")
  const writeStatus = async (exit?: Readonly<{ exitedAt: string; clean: boolean }>): Promise<void> => {
    await mkdir(directory, { recursive: true })
    const lastTickAt = nowIso()
    const queueProgress = recordedProgress ?? options.queueProgress?.(lastTickAt)
    const uncarried = options.uncarried?.()
    const status: QueueTimelineRunner = {
      pid: process.pid,
      startedAt,
      lastTickAt,
      ...(queueProgress === undefined ? {} : { queueProgress }),
      // Omitted, never zeroed: absent means not measured, and the rail must be
      // able to tell that from a swept-and-clean queue.
      ...(uncarried === undefined ? {} : { uncarried }),
      ...(options.driver === undefined || driverEpoch === undefined
        ? {}
        : {
            driver: {
              queueId: options.driver.queueId,
              epoch: driverEpoch,
              lastLanded: options.driver.lastLanded(),
            },
          }),
      command,
      implementationSource,
      journalVersions: SUPPORTED_VERSIONS,
      ...exit,
    }
    try {
      await writeFile(temporary, `${JSON.stringify(status)}\n`, "utf8")
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const write = () => writeStatus()

  await write()
  const stop = new AbortController()
  let failure: unknown
  const loop = (async () => {
    while (await heartbeatDelay(intervalMs, stop.signal)) await write()
  })().catch((cause: unknown) => {
    failure = cause
  })
  let closePromise: Promise<void> | undefined
  return {
    check() {
      if (failure !== undefined) throw failure
    },
    async recordProgress(progress) {
      stop.abort()
      await loop
      if (failure !== undefined) throw failure
      recordedProgress = progress
      await write()
    },
    close: (clean: boolean) =>
      (closePromise ??= (async () => {
        stop.abort()
        await loop
        // NEVER delete status.json on close. Overwrite it atomically with an exit
        // marker instead: a successor resident reads this (not null) and reclaims
        // this pid's leases via planResidentRunnerReclaim, clean or not — the
        // deletion used to strand ghosts because the null-status path skipped
        // reclaim. queue.recover is idempotent, so reclaiming a clean exit is a
        // no-op. `clean` records whether this was an operator/drain stop (true) or
        // a signal-forced/crash exit (false).
        try {
          await writeStatus({ exitedAt: nowIso(), clean })
        } finally {
          await rm(temporary, { force: true })
        }
        if (failure !== undefined) throw failure
      })()),
  }
}

function commitSubject(cwd: string, headSha: string): string | undefined {
  try {
    const subject = gitSync(cwd, ["show", "-s", "--format=%s", "--no-show-signature", headSha, "--"]).trimEnd()
    return subject === "" ? undefined : subject
  } catch (error) {
    if (isGitTimeoutError(error)) throw error
    return undefined
  }
}

async function firstEventTimestamp(app: YrdCliApp): Promise<string> {
  for await (const event of app.events()) return event.ts
  return "-"
}

async function queueLegacyCoverage(cwd: string, since: string): Promise<QueueLogCoverage | undefined> {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) return undefined
  const paths = [join(gitDir, "yrd", "events.jsonl"), join(gitDir, "bay", "journal.jsonl")]
  const legacy = (
    await Promise.all(
      paths.map(async (path) => {
        try {
          const content = await readFile(path, "utf8")
          return { path, frames: content.split(/\r?\n/u).filter((value) => value.trim() !== "").length }
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return undefined
          }
          throw error
        }
      }),
    )
  ).filter((coverage): coverage is { path: string; frames: number } => coverage !== undefined)
  return legacy.length === 0 ? undefined : { since, completeness: "queue-only", legacy }
}

type RuntimeOptions = {
  runner: string
  leaseMs: number
  now?: () => number
  continueAdmissions?: () => boolean
}

type QueueListOptions = Readonly<{
  base?: string
  pr?: string
  status?: string
  since?: string
  latest?: boolean
  watch?: boolean
  check?: boolean
  json?: boolean
}>

type WatchOptions = QueueListOptions

type JsonOption = { json?: boolean }
type IntentSubmitOptions = JsonOption & {
  component?: string
  target?: string
  issue?: string
  expectPin?: string
  allowOffTrunk?: boolean
  submitter?: string
  base?: string
  force?: boolean
}
type IntentTombstoneOptions = JsonOption & {
  component?: string
  sha?: string
  issue?: string
  submitter?: string
  reason?: string
}
type IntentWithdrawOptions = JsonOption & { reason?: string }
type IntentMaterializeOptions = JsonOption & {
  target?: string
  issue?: string
  base?: string
  branch?: string
}

// Flow metrics default to a 24h horizon (median/p90 wait, run durations,
// rejection rate, throughput) independent of the tighter listing window; an
// explicit --since overrides both.
const QUEUE_METRICS_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000
const QUEUE_TIMELINE_STATUSES: readonly QueueTimelineStatusFilter[] = [
  "pending",
  "running",
  "rejected",
  "integrated",
  "other",
]

// The STATUS column prints the converged words; --status accepts them too, so
// anything the CLI shows can be typed straight back into the filter.
const QUEUE_TIMELINE_STATUS_ALIASES: Readonly<Record<string, QueueTimelineStatusFilter>> = {
  queued: "pending",
  checking: "running",
  failed: "rejected",
  merged: "integrated",
}

const QUEUE_TIMELINE_STATUS_HELP =
  "comma-separated queued|pending, checking|running, failed|rejected, merged|integrated, other"

function queueTimelineRowLimit(io: YrdCliIO): number {
  if (io.rows === undefined) return 20
  // Tabs, metadata, worst-case abnormal STATUS box, filter, columns,
  // STATISTICS, and cap/coverage disclosures remain outside ListView.
  return Math.max(1, io.rows - 14)
}

function parseDurationMs(value: string, option: string, positive = false): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/iu.exec(value.trim())
  const expectation = positive ? "a positive duration" : "a duration"
  if (match === null) usage(`${option} must be ${expectation} such as 30m, 6h, or 1d`)
  const amount = Number(match?.[1])
  const unit = match?.[2]?.toLocaleLowerCase()
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  const milliseconds = amount * multiplier
  if (!Number.isFinite(milliseconds) || (positive ? milliseconds <= 0 : milliseconds < 0)) {
    usage(
      positive
        ? `${option} must be a positive duration such as 30m, 6h, or 1d`
        : `${option} must be a finite non-negative duration`,
    )
  }
  return milliseconds
}

function queueTimelineWindow(value: string | undefined): number {
  return value === undefined ? QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS : parseDurationMs(value, "--since")
}

// The flow-metrics window: 24h by default, but an explicit --since wins so the
// stats track the same span the operator scoped the listing to.
function queueMetricsWindow(value: string | undefined): number {
  return value === undefined ? QUEUE_METRICS_DEFAULT_WINDOW_MS : queueTimelineWindow(value)
}

function queueTimelineStatuses(value: string | undefined): QueueTimelineStatusFilter[] {
  if (value === undefined) return [...QUEUE_TIMELINE_STATUSES]
  const written = [
    ...new Set(
      value
        .split(",")
        .map((status) => status.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ]
  if (written.length === 0) usage("--status must name at least one timeline status")
  const invalid = written.find(
    (status) =>
      !QUEUE_TIMELINE_STATUSES.includes(status as QueueTimelineStatusFilter) &&
      QUEUE_TIMELINE_STATUS_ALIASES[status] === undefined,
  )
  if (invalid !== undefined) {
    usage(`--status '${invalid}' is invalid; expected ${QUEUE_TIMELINE_STATUS_HELP}`)
  }
  return [
    ...new Set(written.map((status) => QUEUE_TIMELINE_STATUS_ALIASES[status] ?? (status as QueueTimelineStatusFilter))),
  ]
}

type TrackerDeliveryIdentity = Readonly<{
  issueRef: string
  pr: string
  revision: number
  headSha: string
  status: PRDeliveryState | "needs-author"
  at: string
  runs: readonly string[]
  correlation?: Correlation
}>

type TrackerBounce = Readonly<{ run: string; detail?: string }>

type TrackerDeliveryV1 =
  | (TrackerDeliveryIdentity & Readonly<{ status: "pushed" | "submitted" | "withdrawn" | "canceled" }>)
  | (TrackerDeliveryIdentity & Readonly<{ status: "rejected"; bounce: TrackerBounce }>)
  | (TrackerDeliveryIdentity &
      Readonly<{ status: "integrated"; landingSha: string; regressions?: readonly PRRegression[] }>)
  | (TrackerDeliveryIdentity &
      Readonly<{
        status: "already-landed"
        baseSha: string
        candidateSha: string
        candidateTreeSha: string
        baseTreeSha: string
      }>)

type TrackerDeliveryV2 =
  | TrackerDeliveryV1
  | (TrackerDeliveryIdentity & Readonly<{ status: "needs-author"; bounce: TrackerBounce; attributedReceipt: JobError }>)

type TrackerBridgeV1 = Readonly<{
  version: 1
  asOf: JournalSnapshot<YrdCliState>["asOf"]
  deliveries: readonly TrackerDeliveryV1[]
}>

type TrackerBridgeV2 = Readonly<{
  version: 2
  asOf: JournalSnapshot<YrdCliState>["asOf"]
  deliveries: readonly TrackerDeliveryV2[]
}>

function trackerDeliveryV2(
  pr: DeepReadonly<PR>,
  state: DeepReadonly<YrdCliState>,
  eligibility: PREligibility,
): TrackerDeliveryV2 | undefined {
  if (pr.issue === undefined) return undefined
  const revision = currentPRRev(pr)
  const runs = Queues.values(state.queues)
    .filter((run) =>
      run.prs.some(
        (candidate) =>
          candidate.id === pr.id && candidate.revision === revision.n && candidate.headSha === revision.head,
      ),
    )
    .toSorted((left, right) => {
      const started = left.startedAt.localeCompare(right.startedAt)
      return started === 0 ? compareNatural(left.id, right.id) : started
    })
    .map(({ id }) => id)
  const identity = {
    issueRef: pr.issue,
    pr: pr.id,
    revision: revision.n,
    headSha: revision.head,
    runs,
    ...(revision.correlation === undefined ? {} : { correlation: revision.correlation }),
  }
  const refusalFact =
    prNeedsAuthor(pr) ??
    (eligibility.reason?.code === "needs-author" && eligibility.reason.receipt !== undefined
      ? {
          at: pr.rejectedAt ?? revision.submittedAt ?? revision.pushedAt,
          run: pr.terminalRun ?? eligibility.checks.run ?? "unknown",
          receipt: eligibility.reason.receipt,
          detail: eligibility.reason.message,
        }
      : undefined)
  if (refusalFact !== undefined) {
    return {
      ...identity,
      status: "needs-author",
      at: refusalFact.at,
      bounce: {
        run: refusalFact.run,
        ...(refusalFact.detail === undefined ? {} : { detail: refusalFact.detail }),
      },
      attributedReceipt: refusalFact.receipt,
    }
  }
  const delivery = prDeliveryState(pr)
  switch (delivery) {
    case "pushed":
      return { ...identity, status: "pushed", at: revision.pushedAt }
    // `ready` is revision-admission evidence inside Yrd. The delivery remains
    // externally submitted until it reaches a terminal landing state.
    case "ready":
    case "submitted":
      return revision.submittedAt === undefined
        ? undefined
        : { ...identity, status: "submitted", at: revision.submittedAt }
    case "needs-author":
      refusal(`trackerBridge v2 cannot project needs-author PR '${pr.id}' without an attributed result`)
    case "rejected":
      if (pr.rejectedAt === undefined) return undefined
      if (pr.terminalRun === undefined) {
        refusal(`trackerBridge v1 cannot project rejected PR '${pr.id}' without a typed Queue bounce run`)
      }
      const bounce = { run: pr.terminalRun, ...(pr.detail === undefined ? {} : { detail: pr.detail }) }
      return {
        ...identity,
        status: "rejected",
        at: pr.rejectedAt,
        bounce,
      }
    case "integrated": {
      const landing = prLandingOutcome(pr)
      if (landing.outcome !== "landed") refusal(`integrated PR '${pr.id}' has no canonical landing outcome`)
      return {
        ...identity,
        status: "integrated",
        at: landing.at,
        landingSha: landing.landingSha,
        ...(pr.regressions === undefined || pr.regressions.length === 0 ? {} : { regressions: pr.regressions }),
      }
    }
    case "already-landed": {
      const landing = prLandingOutcome(pr)
      if (landing.outcome !== "already-landed") {
        refusal(`PR '${pr.id}' is recorded as already merged but has no canonical equivalence proof`)
      }
      return {
        ...identity,
        status: "already-landed",
        at: landing.at,
        baseSha: landing.baseSha,
        candidateSha: landing.candidateSha,
        candidateTreeSha: landing.candidateTreeSha,
        baseTreeSha: landing.baseTreeSha,
      }
    }
    case "withdrawn":
      return pr.withdrawnAt === undefined ? undefined : { ...identity, status: "withdrawn", at: pr.withdrawnAt }
    case "canceled":
      return pr.canceledAt === undefined ? undefined : { ...identity, status: "canceled", at: pr.canceledAt }
    default: {
      const unhandled: never = delivery
      throw new TypeError(`yrd: unknown PR delivery state '${String(unhandled)}'`)
    }
  }
}

const TRACKER_V1_STATUS_MAP = {
  pushed: "pushed",
  submitted: "submitted",
  "needs-author": "rejected",
  rejected: "rejected",
  integrated: "integrated",
  "already-landed": "already-landed",
  withdrawn: "withdrawn",
  canceled: "canceled",
} as const satisfies Record<TrackerDeliveryV2["status"], TrackerDeliveryV1["status"]>

function trackerDeliveryV1(delivery: TrackerDeliveryV2): TrackerDeliveryV1 {
  const identity = {
    issueRef: delivery.issueRef,
    pr: delivery.pr,
    revision: delivery.revision,
    headSha: delivery.headSha,
    at: delivery.at,
    runs: delivery.runs,
    ...(delivery.correlation === undefined ? {} : { correlation: delivery.correlation }),
  }
  const status = TRACKER_V1_STATUS_MAP[delivery.status]
  if (status === "rejected") {
    if (delivery.status !== "rejected" && delivery.status !== "needs-author") {
      throw new TypeError(`trackerBridge v1 status mapping for '${delivery.status}' lost its bounce`)
    }
    return { ...identity, status, bounce: delivery.bounce }
  }
  if (status === "integrated") {
    if (delivery.status !== "integrated") {
      throw new TypeError(`trackerBridge v1 status mapping for '${delivery.status}' lost its landing`)
    }
    return {
      ...identity,
      status,
      landingSha: delivery.landingSha,
      ...(delivery.regressions === undefined ? {} : { regressions: delivery.regressions }),
    }
  }
  if (status === "already-landed") {
    if (delivery.status !== "already-landed") {
      throw new TypeError(`trackerBridge v1 status mapping for '${delivery.status}' lost its equivalence proof`)
    }
    return {
      ...identity,
      status,
      baseSha: delivery.baseSha,
      candidateSha: delivery.candidateSha,
      candidateTreeSha: delivery.candidateTreeSha,
      baseTreeSha: delivery.baseTreeSha,
    }
  }
  return { ...identity, status }
}

function trackerBridges(
  app: YrdCliApp,
  snapshot: JournalSnapshot<YrdCliState>,
  include: (delivery: TrackerDeliveryV2) => boolean,
): Readonly<{ trackerBridge: TrackerBridgeV1; trackerBridgeV2: TrackerBridgeV2 }> {
  const deliveries = Object.values(snapshot.state.bays.prs)
    .map((pr) => trackerDeliveryV2(pr, snapshot.state, app.queue.eligibility(pr.id, snapshot.state)))
    .filter((delivery): delivery is TrackerDeliveryV2 => delivery !== undefined && include(delivery))
    .toSorted((left, right) => compareNatural(left.pr, right.pr))
  const trackerBridgeV2 = { version: 2 as const, asOf: snapshot.asOf, deliveries }
  return {
    trackerBridge: {
      version: 1,
      asOf: snapshot.asOf,
      deliveries: trackerBridgeV2.deliveries.map(trackerDeliveryV1),
    },
    trackerBridgeV2,
  }
}

function issueDeliveryRows(bridge: TrackerBridgeV2): IssueDeliveryRow[] {
  return bridge.deliveries.map((delivery) => {
    const taskStatus = prDeliveryTaskStatusOf(delivery.status)
    return {
      pr: delivery.pr,
      revision: delivery.revision,
      headSha: delivery.headSha,
      status: delivery.status,
      runs: delivery.runs,
      ...taskStatusFields(taskStatus),
      ...(delivery.status === "integrated"
        ? {
            landingSha: delivery.landingSha,
            ...(delivery.regressions === undefined ? {} : { regressions: delivery.regressions }),
          }
        : {}),
      ...(delivery.status === "already-landed"
        ? {
            baseSha: delivery.baseSha,
            candidateSha: delivery.candidateSha,
            candidateTreeSha: delivery.candidateTreeSha,
            baseTreeSha: delivery.baseTreeSha,
          }
        : {}),
      ...(delivery.status === "rejected" ? { bounce: delivery.bounce } : {}),
      ...(delivery.status === "needs-author"
        ? { bounce: delivery.bounce, attributedReceipt: delivery.attributedReceipt }
        : {}),
    }
  })
}

export type { RuntimePosture } from "./invocation.ts"
const RuntimeInvocationCwd = Symbol("yrd.runtime-invocation-cwd")
const RuntimeChildArgv = Symbol("yrd.runtime-child-argv")
type RuntimeInvocationIO = YrdCliIO & {
  [RuntimeInvocationCwd]?: string
  [RuntimeChildArgv]?: readonly string[]
}

type RuntimeBootstrap = Readonly<{
  ambientCwd: string
  env: NodeJS.ProcessEnv
  /** Lightweight supervisor probe; must not instantiate or replay the Yrd app journal. */
  probe?(context: YrdContext): Promise<Readonly<{ services: YrdCliServices; io?: Partial<YrdCliIO> }>>
  load(
    context: YrdContext,
    posture: RuntimePosture,
  ): Promise<
    Readonly<{
      app: YrdCliApp
      services: YrdCliServices
      io?: Partial<YrdCliIO>
    }>
  >
}>

function runtimeOptions(io: YrdCliIO): RuntimeOptions {
  const drainSignal = io.drainSignal
  return {
    runner: io.runner ?? "yrd-cli",
    leaseMs: io.leaseMs ?? 5 * 60_000,
    ...(io.now === undefined ? {} : { now: io.now }),
    ...(drainSignal === undefined ? {} : { continueAdmissions: () => !drainSignal.aborted }),
  }
}

function stateOf(app: YrdCliApp): YrdCliState {
  return app.state()
}

function knownBases(state: YrdCliState): string[] {
  return [
    "main",
    ...Object.values(state.bays.byId).map((bay) => bay.base),
    ...Object.values(state.bays.prs).map((pr) => pr.base),
    ...Queues.values(state.queues).map((run) => run.base),
    ...Object.values(state.queues.pauses).map((pause) => pause.base),
  ]
}

function selectedBase(state: YrdCliState, selector: string): string {
  return resolveBase(knownBases(state), selector) ?? baseIdentity(selector)
}

async function runJobs(app: YrdCliApp, ids: readonly string[], _io: YrdCliIO): Promise<Job[]> {
  return Promise.all(ids.map((job) => app.runner.submit({ job })))
}

function assertJobsPassed(runs: readonly Job[], action: string): void {
  const unresolved = runs.find((run) => run.status !== "completed" || run.conclusion !== "success")
  if (unresolved === undefined) return
  const failure =
    unresolved.status === "completed" && unresolved.conclusion === "failure"
      ? unresolved.error
      : unresolved.status === "completed" && unresolved.conclusion === "timed_out"
        ? { code: "job-lost", message: unresolved.lostReason }
        : {
            code: `job-${unresolved.status === "completed" ? unresolved.conclusion : unresolved.status}`,
            message:
              ("detail" in unresolved ? unresolved.detail : undefined) ??
              (unresolved.status === "completed" ? unresolved.conclusion : unresolved.status),
          }
  raiseFailure(
    "refusal",
    failure.code,
    `${action} ${unresolved.status}${unresolved.status === "completed" ? `+${unresolved.conclusion}` : ""}: ${failure.message}`,
  )
}

type DeploymentOperation = "materialize" | "reap" | "release"

async function requestAndRunDeploymentJob(
  app: YrdCliApp,
  operation: DeploymentOperation,
  input: MaterializeDeploymentInput | ReleaseDeploymentJobInput,
): Promise<Job> {
  const deployments = app.deployments ?? configuration("deployment capability is not installed")
  const key = deploymentJobKey(operation, String(input.deploymentId))
  const definition = `deployment.${operation}`
  let job = app.jobs.getByKey(key)
  if (job === undefined) {
    const requested =
      operation === "materialize"
        ? await deployments.materialize(input as MaterializeDeploymentInput)
        : operation === "reap"
          ? await deployments.reap(input as MaterializeDeploymentInput)
          : await deployments.release(input as Parameters<typeof deployments.release>[0])
    const id = app.jobs.requested(requested)[0] ?? app.jobs.getByKey(key)?.id
    job = id === undefined ? undefined : app.jobs.get(id)
  } else if (job.definition !== definition || !sameDeploymentJobRequest(operation, job.input, input)) {
    raiseFailure(
      "refusal",
      "deployment-request-conflict",
      `yrd: deployment Job '${job.id}' already owns key '${key}' with different terms`,
    )
  } else if (job.status === "completed" && (job.conclusion === "failure" || job.conclusion === "timed_out")) {
    job = await app.jobs.retry(job.id)
  }
  if (job === undefined) throw new Error(`yrd: deployment ${operation} request produced no Job`)
  if (job.status === "queued") job = await app.runner.submit({ job: job.id })
  if (job.status === "in_progress" || job.status === "waiting") {
    raiseFailure(
      "refusal",
      "deployment-job-active",
      `yrd: deployment Job '${job.id}' is already ${job.status}; wait for its current runner`,
    )
  }
  assertJobsPassed([job], `deployment ${operation}`)
  return job
}

function sameDeploymentJobRequest(
  operation: DeploymentOperation,
  stored: Job["input"],
  requested: MaterializeDeploymentInput | ReleaseDeploymentJobInput,
): boolean {
  if (operation !== "release") return stableJson(stored) === stableJson(requested)
  const left = ReleaseDeploymentJobInputSchema.parse(stored)
  const right = ReleaseDeploymentJobInputSchema.parse(requested)
  return stableJson(stableReleaseAuthority(left)) === stableJson(stableReleaseAuthority(right))
}

function stableReleaseAuthority(input: ReleaseDeploymentJobInput): unknown {
  const receipt = HabGenerationReleaseReceiptSchema.parse(input.authorization.receipt)
  return {
    deploymentId: input.deploymentId,
    generation: input.generation,
    path: input.path,
    sha: input.sha,
    authorization: {
      kind: input.authorization.kind,
      generation: input.authorization.generation,
      path: input.authorization.path,
      sha: input.authorization.sha,
      receipt: {
        schema: receipt.schema,
        jurisdiction: receipt.jurisdiction,
        habitatRoot: receipt.habitatRoot,
        retiredSource: receipt.retiredSource,
      },
    },
  }
}

function successfulJobOutput(job: Job): Job["input"] {
  if (job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`yrd: Job '${job.id}' did not complete successfully`)
  }
  return job.output
}

async function readJson(path: string, subject: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as unknown
  } catch (error) {
    refusal(`${subject} '${path}' is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function materializeDeployment(
  app: YrdCliApp,
  deploymentId: string,
  generation: string,
  sha: string,
  options: JsonOption & Readonly<{ pin: string }>,
  io: YrdCliIO,
): Promise<void> {
  const input = DeploymentInputSchema.parse({ deploymentId, generation, sha, pin: options.pin })
  const job = await requestAndRunDeploymentJob(app, "materialize", input)
  const receipt = DeploymentSourceReceiptSchema.parse(successfulJobOutput(job))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "deployment.materialize", job: job.id, receipt },
    `${receipt.path}\n`,
  )
}

async function reapDeployment(
  app: YrdCliApp,
  deploymentId: string,
  generation: string,
  sha: string,
  options: JsonOption & Readonly<{ pin: string }>,
  io: YrdCliIO,
): Promise<void> {
  const input = DeploymentInputSchema.parse({ deploymentId, generation, sha, pin: options.pin })
  const job = await requestAndRunDeploymentJob(app, "reap", input)
  const output = successfulJobOutput(job)
  await printResult(io, jsonEnabled(options), { command: "deployment.reap", job: job.id, output }, "reaped\n")
}

async function releaseDeployment(
  app: YrdCliApp,
  deploymentReceiptPath: string,
  habReleaseReceiptPath: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const deployment = DeploymentSourceReceiptSchema.parse(await readJson(deploymentReceiptPath, "deployment receipt"))
  const habRelease = await readJson(habReleaseReceiptPath, "Hab generation release receipt")
  const input: ReleaseDeploymentJobInput = {
    deploymentId: deployment.deploymentId,
    generation: deployment.generation,
    path: deployment.path,
    sha: deployment.sha,
    authorization: {
      kind: "hab-generation-release" as const,
      generation: deployment.generation,
      path: deployment.path,
      sha: deployment.sha,
      receipt: habRelease as ReleaseDeploymentJobInput["authorization"]["receipt"],
    },
  }
  const job = await requestAndRunDeploymentJob(app, "release", input)
  const output = successfulJobOutput(job)
  await printResult(io, jsonEnabled(options), { command: "deployment.release", job: job.id, output }, "released\n")
}

function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function currentBay(state: BaysState, cwd: string): Bay | undefined {
  return Object.values(state.byId)
    .filter((bay) => bay.path !== undefined && within(bay.path, cwd))
    .toSorted((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0]
}

function sortedBays(state: BaysState): Bay[] {
  return Object.values(state.byId).toSorted((left, right) => compareNatural(left.id, right.id))
}

function unique<Value extends { id: string }>(values: readonly Value[]): Value[] {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}

function byQueueRunChronology(left: Run, right: Run): number {
  const started = left.startedAt.localeCompare(right.startedAt)
  return started === 0 ? compareNatural(left.id, right.id) : started
}

export function mergedQueueRuns(
  canonical: QueueSummary,
  aliases: readonly QueueSummary[],
): Pick<QueueSummary, "running" | "waiting" | "finished"> {
  const canonicalIds = new Set([...canonical.running, ...canonical.waiting, ...canonical.finished].map((run) => run.id))
  const merge = (key: "running" | "waiting" | "finished"): Run[] =>
    unique([
      ...aliases.flatMap((summary) => summary[key]).filter((run) => !canonicalIds.has(run.id)),
      ...canonical[key],
    ]).toSorted(byQueueRunChronology)
  return { running: merge("running"), waiting: merge("waiting"), finished: merge("finished") }
}

function historicalQueueRuns(
  runs: readonly Run[],
  bases: ReadonlySet<string>,
): Pick<QueueSummary, "running" | "waiting" | "finished"> {
  const identities = new Set([...bases].map(baseIdentity))
  const scoped = runs.filter((run) => identities.has(baseIdentity(run.base))).toSorted(byQueueRunChronology)
  return {
    running: scoped.filter((run) => run.status === "queued" || run.status === "in_progress"),
    waiting: scoped.filter((run) => run.status === "waiting"),
    finished: scoped.filter((run) => run.status === "completed"),
  }
}

function selectedBays(state: BaysState, selectors: readonly string[], cwd: string, action: string): Bay[] {
  if (selectors.length > 0) {
    return unique(
      selectors.map((selector) => {
        const bay = resolveBay(state, selector)
        if (bay === undefined) refusal(`no bay '${selector}'`)
        return bay
      }),
    )
  }
  const local = currentBay(state, cwd)
  if (local !== undefined) return [local]
  const live = sortedBays(state).filter((bay) => bay.status !== "closed")
  if (live.length === 0) refusal(`no bays are available to ${action}`)
  return live
}

function csv(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === true) return []
  const values = Array.isArray(value) ? value : [value]
  const result = values.flatMap((item) => {
    if (typeof item !== "string") usage("expected a comma-separated list")
    return item
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  })
  return result
}

function oneOfAliases(primary: unknown, alias: unknown, primaryName: string, aliasName: string): string | undefined {
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    usage(`--${primaryName} and --${aliasName} disagree`)
  }
  const value = primary ?? alias
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") usage(`--${primaryName} requires a non-empty value`)
  return value
}

function oneBaseOfAliases(
  state: YrdCliState,
  primary: unknown,
  alias: unknown,
  primaryName: string,
  aliasName: string,
): string | undefined {
  const primaryValue = oneOfAliases(primary, undefined, primaryName, aliasName)
  const aliasValue = oneOfAliases(alias, undefined, aliasName, primaryName)
  if (primaryValue === undefined) return aliasValue === undefined ? undefined : selectedBase(state, aliasValue)
  const selected = selectedBase(state, primaryValue)
  if (aliasValue !== undefined && selectedBase(state, aliasValue) !== selected) {
    usage(`--${primaryName} and --${aliasName} disagree`)
  }
  return selected
}

function parseCorrelation(value: unknown): Correlation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") usage("--correlation requires <namespace:id>")
  const separator = value.indexOf(":")
  if (separator === -1) usage("--correlation requires <namespace:id>")
  try {
    return CorrelationSchema.parse({ namespace: value.slice(0, separator), id: value.slice(separator + 1) })
  } catch {
    usage("--correlation requires <namespace:id>")
  }
}

function jsonEnabled(options: JsonOption): boolean {
  return options.json === true
}

function projectQueueSummaryTaskStatus(summary: QueueSummary) {
  return {
    ...summary,
    running: summary.running.map(projectQueueRunTaskStatus),
    waiting: summary.waiting.map(projectQueueRunTaskStatus),
    finished: summary.finished.map(projectQueueRunTaskStatus),
  }
}

function projectQueueStatusResultTaskStatus(result: QueueStatusResult) {
  return {
    ...projectQueueSummaryTaskStatus(result),
    prs: result.prs.map(projectPRTaskStatus),
    ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
    ...(result.eligibilities === undefined
      ? {}
      : { eligibilities: result.eligibilities.map(projectEligibilityTaskStatus) }),
  }
}

function projectEligibilityTaskStatus(eligibility: PREligibility) {
  return {
    ...eligibility,
    checks: { ...eligibility.checks, ...taskStatusFields(checkTaskStatusOf(eligibility.checks)) },
  }
}

type PrListStatusProjection = Omit<ReturnType<typeof projectPRTaskStatus>, "status"> &
  Readonly<{
    /** answers: What delivery result should a reader act on? tense: current. */
    status: PRDeliveryState | "needs-author"
    /** answers: What delivery status did the rebuildable index record? tense: historical. */
    nativeStatus?: PRDeliveryState
    /** answers: Why did repository proof override nativeStatus? tense: current. */
    landedOnBase?: Readonly<Pick<PrLanding, "baseSha" | "headSha" | "code">>
  }>

function projectPrTaskStatusWithEligibility(
  pr: PR,
  eligibility: PREligibility,
  landing?: PrLanding,
): PrListStatusProjection {
  const projected = projectPRTaskStatus(pr)
  // A proven landing is the strongest projection there is: it contradicts the
  // recorded state with content, so it wins over both the native state and the
  // eligibility projection. `nativeStatus` keeps the record readable (22376).
  if (landing !== undefined) {
    return {
      ...projected,
      nativeStatus: landing.recorded,
      status: "already-landed" as const,
      landedOnBase: { baseSha: landing.baseSha, headSha: landing.headSha, code: landing.code },
    }
  }
  const status = projectedPrStatus(pr, eligibility)
  const nativeStatus = prDeliveryState(pr)
  return status === nativeStatus ? projected : { ...projected, nativeStatus, status }
}

function projectCheckTaskStatus(check: PRCheckViewRecord) {
  return { ...check, ...taskStatusFields(checkTaskStatusOf(check)) }
}

async function provisionBay(
  app: YrdCliApp,
  name: string,
  options: {
    from?: string
    head?: string
    base?: string
    queue?: string
    issue?: string
    by?: string
    json?: boolean
    expectedHead?: string
  },
  io: YrdCliIO,
  command: string,
  pr?: string,
): Promise<void> {
  const from = oneOfAliases(options.from, options.head, "from", "head")
  const base = oneBaseOfAliases(stateOf(app), options.base, options.queue, "base", "queue")
  const result = await app.bays.open({
    name,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    by: options.by ?? currentYrdOwnerAddress(),
    ...(from === undefined ? {} : { from }),
    ...(base === undefined ? {} : { base }),
  })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${name}' provision`)
  const bay = app.bays.get(name)
  if (bay?.path === undefined || bay.status !== "active") refusal(`bay '${name}' did not become active`)
  if (options.expectedHead !== undefined && bay.headSha?.toLowerCase() !== options.expectedHead.toLowerCase()) {
    const expected =
      pr === undefined ? `expected head ${options.expectedHead}` : `PR '${pr}' revision head ${options.expectedHead}`
    const recovery =
      pr === undefined ? "" : `; run 'yrd bay close ${name}', then retry 'yrd pr checkout ${pr} --bay ${name}'`
    refusal(`bay '${name}' HEAD ${bay.headSha ?? "(missing)"} does not match ${expected}${recovery}`)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command, ...(pr === undefined ? {} : { pr }), bay },
    createElement(BayStatusView, { bays: [bay] }),
  )
}

function generatedBayName(): string {
  return `yrd-${randomUUID().replaceAll("-", "").slice(0, 12)}`
}

/** Neutral process ownership used only by Bay teardown safety. */
function currentYrdOwnerAddress(): string {
  return `yrd:${String(process.pid)}`
}

function derivedWorkName(value: string): string {
  return basename(value).replace(/^@/u, "")
}

type BayOpenOptions = Readonly<{
  issue?: string
  pr?: string
  bay?: string
}>

type BayOpenResolution = Readonly<{
  claim: string
  bay: string
  branch: string
  from?: string
  issue?: string
  reattached: boolean
}>

/** What the caller already knows about the Bay it is asking for. */
type BayOpenIntent = Readonly<{
  issueResolved?: boolean
  /** Reuse the exact clean issue Bay instead of refusing; reserved for idempotent delivery ensure. */
  reuseActive?: boolean
  /** The child this caller would have run, so a refusal can name the command that works. */
  guestArgv?: readonly string[]
}>

function bayOpenIdentity(
  app: YrdCliApp,
  requestedBay: string,
  branchSeed: string,
  issue: string | undefined,
  targetedPr?: PR,
): Readonly<{ claim: string; bay: string; branch: string; issue?: string; reattached: boolean }> {
  const bay = requestedBay.trim()
  if (
    bay === "" ||
    bay === "." ||
    bay === ".." ||
    bay.includes("..") ||
    bay.endsWith(".lock") ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(bay)
  ) {
    usage("bay open --bay names must be Git-safe")
  }
  if (targetedPr !== undefined) {
    if (!isLivePR(targetedPr)) {
      refusal(`PR '${targetedPr.id}' is ${prDeliveryState(targetedPr)}; --pr requires a live PR`)
    }
    if (issue !== undefined && targetedPr.issue !== undefined && issue !== targetedPr.issue) {
      refusal(`--issue '${issue}' does not match PR '${targetedPr.id}' issue '${targetedPr.issue}'`)
    }
    return {
      claim: issue ?? targetedPr.name ?? branchSeed,
      bay,
      branch: targetedPr.branch,
      ...(issue === undefined ? {} : { issue }),
      reattached: true,
    }
  }
  const claim = issue ?? branchSeed
  const claimPrs = issue === undefined ? [] : app.bays.prs().filter((pr) => pr.issue === issue && isLivePR(pr))
  if (claimPrs.length > 1) {
    refusal(
      `claim '${claim}' has multiple live PRs (${claimPrs.map((pr) => pr.id).join(", ")}); ` +
        "withdraw the duplicate before reopening the bay",
    )
  }
  const claimPr = claimPrs[0]
  if (claimPr !== undefined) {
    return { claim, bay, branch: claimPr.branch, issue, reattached: true }
  }

  const bays = app.bays.list()
  const prs = app.bays.prs()
  const defaultBranch = `task/${branchSeed}`
  const branchOwners = (branch: string) => [
    ...bays.filter((bay) => bay.branch === branch).map((bay) => bay.issue),
    ...prs.filter((pr) => pr.branch === branch).map((pr) => pr.issue),
  ]
  const isForeignBranch = (branch: string) => branchOwners(branch).some((owner) => owner !== issue)
  const terminalDefault = prs.some((pr) => pr.branch === defaultBranch && pr.issue === issue && !isLivePR(pr))
  const collisionBranch = `${defaultBranch}-${createHash("sha256").update(claim).digest("hex").slice(0, 8)}`
  const branch = isForeignBranch(defaultBranch) || terminalDefault ? collisionBranch : defaultBranch
  if (isForeignBranch(branch)) {
    refusal(
      `claim '${claim}' collides with existing branch '${branch}'; ` +
        "link a distinct draft PR branch to the claim, then reopen the bay",
    )
  }
  return { claim, bay, branch, ...(issue === undefined ? {} : { issue }), reattached: false }
}

async function resolveBayOpen(
  app: YrdCliApp,
  arg: string | undefined,
  options: BayOpenOptions,
  resolved: BayOpenIntent = {},
): Promise<BayOpenResolution> {
  if (arg !== undefined && options.issue !== undefined) {
    usage("bay open positional config and --issue are aliases; pass exactly one")
  }
  const issue = options.issue ?? arg
  if (issue !== undefined && resolved.issueResolved !== true) {
    await app.issues.resolve(app.issues.ref(issue))
  }
  const targetedPr =
    options.pr === undefined
      ? undefined
      : (app.bays.pr(options.pr) ?? refusal(`no PR '${options.pr}'; create it explicitly before using --pr`))
  const generated = generatedBayName()
  const branchSeed =
    issue === undefined
      ? targetedPr === undefined
        ? (options.bay ?? generated)
        : derivedWorkName(targetedPr.branch)
      : derivedWorkName(issue)
  const bay =
    options.bay ??
    (arg === undefined
      ? targetedPr === undefined
        ? branchSeed
        : derivedWorkName(targetedPr.branch)
      : derivedWorkName(arg))
  const identity = bayOpenIdentity(app, bay, branchSeed, issue, targetedPr)
  return targetedPr === undefined ? identity : { ...identity, from: prHead(targetedPr) }
}

function openRunBay(app: YrdCliApp, identity: BayOpenResolution): Bay | undefined {
  return app.bays
    .list()
    .find(
      (bay) =>
        bay.status === "active" &&
        (bay.name === identity.bay ||
          bay.branch === identity.branch ||
          (identity.issue !== undefined && bay.issue === identity.issue)),
    )
}

function printBayResolution(
  io: YrdCliIO,
  resolved: Readonly<{
    bay: string
    branch: string
    issue?: string
  }>,
  resolution: string,
  write: (text: string) => unknown = io.stdout,
): void {
  write(
    `bay ${resolved.bay} → ${resolution} ${resolved.branch}, ` +
      `${resolved.issue === undefined ? "no issue linked" : `linked ${resolved.issue}`}\n`,
  )
}

function logBayResolution(app: YrdCliApp, resolved: BayOpenResolution): void {
  app.log
    .child("bay")
    .child("open")
    .info?.("resolved bay open", {
      resolved: {
        issue: resolved.issue ?? null,
        pr: resolved.branch,
        bay: resolved.bay,
      },
    })
}

async function checkpointRunBay(app: YrdCliApp, bay: Bay, claim: string, io: YrdCliIO): Promise<Bay> {
  const result = await app.bays.checkpoint({ bay: bay.id, claim })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${bay.id}' checkpoint`)
  const checkpointed = app.bays.get(bay.id)
  if (checkpointed?.status !== "active" || checkpointed.headSha === undefined) {
    refusal(`bay '${bay.id}' did not retain an active checkpoint`)
  }
  return checkpointed
}

function childFailureReason(result: ProcessResult): string {
  if (result.timedOut) return "child timed out"
  if (result.escapedDescendant === true) return "child exited with an escaped descendant"
  if (result.stalled === true) return "child stalled"
  if (result.signal !== null) return `child exited after ${result.signal}`
  if (result.sweepFailure !== undefined) return `child cleanup failed: ${result.sweepFailure}`
  return `child exited ${result.exitCode}`
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A resident's first signal is a graceful drain: stop admitting work but let
 * the current child finish. A second signal closes the host and its Process,
 * which remains the hard-interrupt path. One-shot commands still forward their
 * drain signal directly to children. */
function childInterruptionSignal(io: YrdCliIO): AbortSignal | undefined {
  return io.runner?.startsWith("yrd-cli:") === true ? undefined : io.drainSignal
}

async function orphanRunBay(app: YrdCliApp, bay: Bay, reason: string, result?: ProcessResult): Promise<void> {
  await app.bays.orphan({
    bay: bay.id,
    reason,
    ...(result === undefined ? {} : { exitCode: result.exitCode }),
    ...(result?.signal === null || result?.signal === undefined ? {} : { signal: result.signal }),
    ...(result?.timedOut === true ? { timedOut: true } : {}),
    ...(result?.stalled === true ? { stalled: true } : {}),
    ...(result?.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
    ...(result?.escapedDescendant === true ? { escapedDescendant: true } : {}),
  })
}

async function preserveInterruptedRunBay(app: YrdCliApp, bay: Bay, phase: string, io: YrdCliIO): Promise<boolean> {
  const signal = io.drainSignal
  if (signal?.aborted !== true) return false
  const source = typeof signal.reason === "string" ? ` by ${signal.reason}` : ""
  const reason = `Bay lifecycle interrupted during ${phase}${source}`
  await orphanRunBay(app, bay, reason)
  io.stderr(`yrd: ${reason}; Bay '${bay.id}' is preserved and marked orphan\n`)
  return true
}

function childOutput(io: YrdCliIO): Readonly<{
  write(output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>): void
  flush(): void
}> {
  const decoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  }
  return {
    write({ stream, chunk }) {
      const text = decoders[stream].decode(chunk, { stream: true })
      if (text !== "") io[stream](text)
    },
    flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        const text = decoders[stream].decode()
        if (text !== "") io[stream](text)
      }
    },
  }
}

/**
 * Make a Bay runnable before anything is launched inside it.
 *
 * A Bay is a brand-new worktree: it carries every tracked file and none of the
 * installed dependencies, so the first thing an agent harness does in a fresh
 * one is fail to resolve a module — `Cannot find package 'picocolors'`, twice in
 * one evening (2026-07-27). The child exits, Yrd preserves the Bay as an orphan,
 * and the operator is left holding a mystery that was one install away.
 *
 * Third-party lifecycle scripts stay off: provisioning a Bay must not run
 * install hooks nobody reviewed. The repository's OWN `postinstall` does run,
 * because it is first-party codegen, and skipping it leaves a checkout that
 * installed cleanly and still cannot boot.
 */
async function ensureBayDependencies(
  processService: Pick<Process, "run">,
  bay: Bay,
  path: string,
  io: YrdCliIO,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  await ensureWorkspaceDependencies(processService, {
    path,
    subject: `bay '${bay.id}'`,
    manifestSubject: "bay",
    runPostinstall: true,
    ...(env === undefined ? {} : { env }),
    ...(childInterruptionSignal(io) === undefined ? {} : { signal: childInterruptionSignal(io) }),
    onCommand: (argv) => io.stderr(`yrd: bay '${bay.id}' provisioning: ${argv.join(" ")}\n`),
    writeOutput: io.stderr,
    fail: refusal,
  })
}

async function runBayChild(
  processService: Pick<Process, "run">,
  bay: Bay,
  argv: readonly string[],
  io: YrdCliIO,
  options: Readonly<{
    env?: NodeJS.ProcessEnv
    onStart?: (pid: number) => void
    /** This child owns the Bay bracket, so its settlement also owns every
     * process still holding the Bay path. Guests deliberately leave this off. */
    ownedPath?: boolean
  }> = {},
): Promise<ProcessResult> {
  if (bay.path === undefined) refusal(`bay '${bay.id}' has no active workspace path`)
  await ensureBayDependencies(processService, bay, bay.path, io, options.env)
  const output = io.interactive === true ? undefined : childOutput(io)
  try {
    return await processService.run({
      argv,
      cwd: bay.path,
      ...(options.ownedPath === true ? { ownedPath: bay.path } : {}),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onStart === undefined ? {} : { onStart: options.onStart }),
      ...(childInterruptionSignal(io) === undefined ? {} : { signal: childInterruptionSignal(io) }),
      ...(output === undefined ? { interactive: true } : { inheritStdin: true, onOutput: output.write }),
    })
  } finally {
    output?.flush()
  }
}

function childSucceeded(child: ProcessResult): boolean {
  return (
    child.exitCode === 0 &&
    child.signal === null &&
    !child.timedOut &&
    child.stalled !== true &&
    child.sweepFailure === undefined &&
    child.escapedDescendant !== true
  )
}

function defaultRunArgv(services: YrdCliServices): readonly string[] {
  const shell = services.environment?.SHELL?.trim()
  return [shell === undefined || shell === "" ? "/bin/sh" : shell]
}

function resolveGuestBay(app: YrdCliApp, selector: string | undefined, cwd: string): Bay {
  if (selector === undefined) {
    const bay = currentBay(stateOf(app).bays, cwd)
    if (bay?.status !== "active") {
      refusal("no open bay contains the current directory; " + "run 'yrd bay open --bay <name>' to create its owner")
    }
    return bay
  }
  const active = app.bays
    .list()
    .filter(
      (bay) => bay.status === "active" && (bay.id === selector || bay.name === selector || bay.branch === selector),
    )
  if (active.length === 0) {
    refusal(`no open bay '${selector}'; run 'yrd bay open --bay ${selector}' to create its owner`)
  }
  if (active.length > 1) {
    refusal(
      `open bay '${selector}' is ambiguous (${active.map((bay) => bay.id).join(", ")}); ` +
        "rerun 'yrd in <Bay-id> -- <command>'",
    )
  }
  const bay = active[0]
  if (bay === undefined) throw new Error("yrd: open Bay resolution lost its only candidate")
  return bay
}

function guestArgv(services: YrdCliServices, argv: readonly string[]): readonly string[] {
  return argv.length === 0 ? defaultRunArgv(services) : argv
}

async function enterBay(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string | undefined,
  argv: readonly string[],
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const processService = services.process
  if (processService === undefined) configuration("yrd in requires the process-backed Yrd runtime")
  const runtime = io as RuntimeInvocationIO
  const bay = resolveGuestBay(app, selector, runtime[RuntimeInvocationCwd] ?? io.cwd ?? process.cwd())
  const child = await runBayChild(processService, bay, guestArgv(services, argv), io, {
    env: services.environment ?? process.env,
    onStart() {
      const resolved: BayOpenResolution = {
        claim: bay.issue ?? bay.name,
        bay: bay.name,
        branch: bay.branch,
        ...(bay.issue === undefined ? {} : { issue: bay.issue }),
        reattached: true,
      }
      printBayResolution(io, resolved, "attached")
      logBayResolution(app, resolved)
    },
  })
  if (childSucceeded(child)) return 0
  io.stderr(`yrd: guest ${childFailureReason(child)}; Bay '${bay.id}' remains owned by its open session\n`)
  return 1
}

function exactOperands(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function bayRunOperands(
  config: string | undefined,
  command: readonly string[] | undefined,
  io: YrdCliIO,
): Readonly<{ arg?: string; argv: readonly string[] }> {
  const parsedCommand = command ?? []
  const explicitChild = (io as RuntimeInvocationIO)[RuntimeChildArgv]
  if (explicitChild === undefined) {
    if (parsedCommand.length > 0) usage("bay run child commands must follow --")
    return { ...(config === undefined ? {} : { arg: config }), argv: [] }
  }
  if (exactOperands(parsedCommand, explicitChild)) {
    return { ...(config === undefined ? {} : { arg: config }), argv: explicitChild }
  }
  if (config !== undefined && exactOperands([config, ...parsedCommand], explicitChild)) {
    return { argv: explicitChild }
  }
  usage("bay run could not separate its config from the child command; place the command after --")
}

function bayInOperands(
  selector: string | undefined,
  command: readonly string[] | undefined,
  io: YrdCliIO,
): Readonly<{ selector?: string; argv: readonly string[] }> {
  const parsedCommand = command ?? []
  const explicitChild = (io as RuntimeInvocationIO)[RuntimeChildArgv]
  if (explicitChild === undefined) {
    if (parsedCommand.length === 0) return { ...(selector === undefined ? {} : { selector }), argv: [] }
    usage("yrd in child commands must follow --")
  }
  if (exactOperands(parsedCommand, explicitChild)) {
    return { ...(selector === undefined ? {} : { selector }), argv: explicitChild }
  }
  if (selector !== undefined && exactOperands([selector, ...parsedCommand], explicitChild)) {
    return { argv: explicitChild }
  }
  usage("yrd in could not separate its Bay selector from the child command; place the command after --")
}

type PreparedBay = Readonly<{ identity: BayOpenResolution; bay: Bay }>
type PreparedIssueBay = Omit<PreparedBay, "bay"> & Readonly<{ bay: Bay & Readonly<{ path: string }> }>

/**
 * The `yrd in` invocation that actually attaches to `bay` and runs the child.
 *
 * A refusal that ends in `<command>` makes the operator finish the sentence,
 * and they cannot: the guest command carries a primer this code just built.
 * Emit the whole thing, quoted, ready to paste.
 */
function guestAttachCommand(bay: Bay, guestArgv: readonly string[] | undefined): string {
  // With no child to name, the bare form is already complete: `yrd in` starts
  // the operator's shell in the Bay.
  return guestArgv === undefined || guestArgv.length === 0
    ? `yrd in ${bay.id}`
    : `yrd in ${bay.id} -- ${guestArgv.map(shellArgument).join(" ")}`
}

/** Quote only what a shell would otherwise mangle, so the command stays readable. */
function shellArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : shellQuote(value)
}

async function prepareOwnedBay(
  app: YrdCliApp,
  arg: string | undefined,
  options: BayOpenOptions,
  io: YrdCliIO,
  preResolved: BayOpenIntent = {},
): Promise<PreparedBay | undefined> {
  const identity = await resolveBayOpen(app, arg, options, preResolved)
  const existing = openRunBay(app, identity)
  if (existing !== undefined) {
    if (preResolved.reuseActive === true && existing.issue === identity.issue && existing.branch === identity.branch) {
      const refreshed = await refreshBay(app, existing, io)
      if (refreshed.dirty === true) {
        refusal(
          `bay '${refreshed.id}' holds uncommitted changes; checkpoint them before ensuring its draft PR; inspect it with:\n` +
            `  ${guestAttachCommand(refreshed, preResolved.guestArgv)}`,
        )
      }
      if (refreshed.path === undefined) refusal(`Bay '${refreshed.id}' has no workspace path`)
      logBayResolution(app, identity)
      return { identity, bay: refreshed }
    }
    refusal(
      `bay '${identity.bay}' is already open as ${existing.id}; attach with:\n` +
        `  ${guestAttachCommand(existing, preResolved.guestArgv)}`,
    )
  }
  const existingBayIds = new Set(app.bays.list().map((candidate) => candidate.id))
  let bay: Bay | undefined
  try {
    const opened = await app.bays.open({
      name: identity.bay,
      branch: identity.branch,
      by: currentYrdOwnerAddress(),
      ...(identity.from === undefined ? {} : { from: identity.from }),
      ...(identity.issue === undefined ? {} : { issue: identity.issue }),
    })
    assertJobsPassed(await runJobs(app, app.jobs.requested(opened), io), `bay '${identity.bay}' provision`)
    const active = app.bays
      .list()
      .filter(
        (candidate) =>
          candidate.status === "active" && candidate.branch === identity.branch && candidate.issue === identity.issue,
      )
    bay = active.length === 1 ? active[0] : undefined
    if (bay?.path === undefined || bay.status !== "active") {
      refusal(`bay '${identity.bay}' did not become active`)
    }
    if (await preserveInterruptedRunBay(app, bay, "pre-child provision", io)) return undefined

    // The branch carrier is durable before the child receives control. PR
    // creation and revision intake remain explicit delivery actions.
    bay = await checkpointRunBay(app, bay, identity.claim, io)
    if (await preserveInterruptedRunBay(app, bay, "pre-child checkpoint", io)) return undefined
    logBayResolution(app, identity)
  } catch (error) {
    bay ??= app.bays
      .list()
      .findLast(
        (candidate) =>
          !existingBayIds.has(candidate.id) &&
          candidate.status !== "closed" &&
          candidate.branch === identity.branch &&
          candidate.issue === identity.issue,
      )
    if (bay !== undefined) {
      await orphanRunBay(app, bay, `Bay setup failed: ${errorDetail(error)}`)
    }
    throw error
  }
  return { identity, bay }
}

/** Git-side issue ownership for `issue ensure`.
 *
 * The caller resolves the tracker reference before entering this seam.
 * `reuseActive` is intentionally opt-in so interactive ownership keeps its
 * exclusive-open refusal.
 */
async function prepareResolvedIssueBay(
  app: YrdCliApp,
  issue: string,
  io: YrdCliIO,
  options: Readonly<{ reuseActive?: boolean }> = {},
): Promise<PreparedIssueBay> {
  const opened = await prepareOwnedBay(app, issue, {}, io, {
    issueResolved: true,
    ...(options.reuseActive === true ? { reuseActive: true } : {}),
  })
  if (opened === undefined) refusal(`Bay for issue '${issue}' was interrupted before it could be used`)
  const path = opened.bay.path
  if (path === undefined) refusal(`Bay '${opened.bay.id}' opened without a workspace path`)
  return { ...opened, bay: { ...opened.bay, path } }
}

async function openPersistentBay(
  app: YrdCliApp,
  services: YrdCliServices,
  arg: string | undefined,
  options: BayOpenOptions,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const opened = await prepareOwnedBay(app, arg, options, io)
  if (opened === undefined) return 1
  if (opened.bay.path === undefined) throw new Error(`yrd: Bay '${opened.bay.id}' opened without a workspace path`)
  await services.checks?.install(opened.bay.path)
  printBayResolution(io, opened.identity, opened.identity.reattached ? "reattached" : "new", io.stderr)
  io.stdout(`${opened.bay.path}\n`)
  return 0
}

async function runBaySession(
  app: YrdCliApp,
  services: YrdCliServices,
  arg: string | undefined,
  childArgv: readonly string[],
  options: BayOpenOptions,
  io: YrdCliIO,
  runOptions: Readonly<{ keep?: boolean }> = {},
): Promise<YrdCliExitCode> {
  if (services.process === undefined) configuration("bay run requires the process-backed Yrd runtime")
  // A refusal here should hand back the command this call was about to run, so
  // the operator can attach and run exactly that.
  const provisioned = await prepareOwnedBay(app, arg, options, io, {
    guestArgv: childArgv,
  })
  if (provisioned === undefined) return 1
  const { identity } = provisioned
  let { bay } = provisioned
  if (bay.path !== undefined) await services.checks?.install(bay.path)
  printBayResolution(io, identity, identity.reattached ? "reattached" : "new")

  let child: ProcessResult
  try {
    child = await runBayChild(
      services.process,
      bay,
      childArgv.length === 0 ? defaultRunArgv(services) : childArgv,
      io,
      {
        env: services.environment ?? process.env,
        ownedPath: true,
      },
    )
  } catch (error) {
    await orphanRunBay(app, bay, `child could not settle: ${errorDetail(error)}`)
    throw error
  }

  const succeeded = childSucceeded(child)
  if (!succeeded) {
    const reason = childFailureReason(child)
    await orphanRunBay(app, bay, reason, child)
    io.stderr(`yrd: ${reason}; Bay '${bay.id}' is preserved and marked orphan\n`)
    return 1
  }
  if (await preserveInterruptedRunBay(app, bay, "child completion", io)) return 1
  if (runOptions.keep === true) return 0

  try {
    bay = await checkpointRunBay(app, bay, identity.claim, io)
    if (await preserveInterruptedRunBay(app, bay, "post-child checkpoint", io)) return 1
    const closed = await closeBayWithProcessReap(app, services.process, bay, {}, io, `bay '${bay.id}' close`)
    if (closed?.status !== "closed") refusal(`bay '${bay.id}' did not close synchronously`)
    io.stdout(`closed ${identity.bay}\n`)
    return 0
  } catch (error) {
    await orphanRunBay(app, bay, `post-child checkpoint or close failed: ${errorDetail(error)}`)
    throw error
  }
}

/** Record or reuse the one draft PR for an issue branch. The issue ensure
 * surface delegates to the public `pr create` core so PR identity, revision,
 * and tracking cannot drift. */
async function ensureIssueDraft(
  app: YrdCliApp,
  issue: string,
  branch: string,
  io: YrdCliIO,
  options: Readonly<{ track: boolean }>,
): Promise<Readonly<{ pr: PR; warnings: readonly string[] }>> {
  const selection = { issue, ...(options.track ? { track: true } : {}) }
  const result = await applyPrSelection(app, [branch], selection, io, "pr.create")
  const pr = result.prs[0]
  if (pr === undefined) refusal(`branch '${branch}' has no PR after create`)
  return { pr, warnings: result.warnings }
}

async function refreshBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const bays = selectedBays(state.bays, selectors, io.cwd ?? process.cwd(), "refresh")
  const refreshed: Bay[] = []
  for (const bay of bays) {
    refreshed.push(await refreshBay(app, bay, io))
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.refresh", bays: refreshed },
    createElement(BayStatusView, { bays: refreshed }),
  )
}

async function refreshBay(app: YrdCliApp, bay: Bay, io: YrdCliIO): Promise<Bay> {
  const result = await app.bays.refresh({ bay: bay.id })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${bay.id}' refresh`)
  const refreshed = app.bays.get(bay.id)
  if (refreshed === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after refresh`)
  return refreshed
}

async function certifyBayHandoff(
  app: YrdCliApp,
  selector: string,
  options: Readonly<{ branch: string; head: string; evidence: string; json?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  let bay = app.bays.get(selector)
  // Name the missing STEP, not the failed lookup. `no bay 'X'` is true and
  // useless: it reads as a broken tool to an author who has a branch, a head
  // and a packet and no idea a Bay was ever involved, and it cost one seat
  // three escalations and most of a day.
  //
  // The Bay is not bookkeeping this command could mint for itself — it is the
  // independent witness being certified. `certifyBayHandoff` reads that a live
  // workspace exists, sits on the branch the packet names, and stands at the
  // head the packet names. Creating one here to satisfy that check would be
  // creating the witness to pass its own witness test, so the remedy is a step
  // the author takes, and this message's whole job is to say which one.
  if (bay === undefined) {
    // A REFUSAL, not a bare Error. `throw new Error("yrd: no bay 'X'")` carries
    // no failure fact, so classifyFailure files it as infrastructure/unexpected
    // and exits 3 — the CLI was telling an author who merely skipped a step
    // that Yrd had failed internally. host.test.ts pins that exact shape as
    // "message-shaped-but-untyped", which is what this was.
    raiseFailure(
      "refusal",
      "handoff-bay-missing",
      `yrd: no active bay tracks '${selector}', and 'bay handoff' certifies a bay's materialized workspace — ` +
        `its live branch and head are the evidence, which is why this command cannot open one for you. ` +
        `Open it first:\n` +
        `  yrd bay open --bay <name> --branch ${options.branch}\n` +
        `then re-run this command. A branch or a bay name both select it.`,
    )
  }
  // The Bay projection records the last observed workspace head, while the
  // packet is cut after the agent's final commit. Refresh only when needed so
  // retries stay fact-idempotent but a newly committed exact head can certify.
  if (bay.headSha !== options.head) bay = await refreshBay(app, bay, io)
  await app.bays.certifyHandoff({
    bay: bay.id,
    branch: options.branch,
    headSha: options.head,
    evidence: options.evidence,
  })
  const certified = app.bays.get(bay.id)
  if (certified === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after handoff certification`)
  const certification = certified.handoff
  if (certification?.headSha !== options.head || certification.evidence !== options.evidence) {
    throw new Error(`yrd: bay '${bay.id}' did not retain the exact handoff certification`)
  }
  const lifecycle = app.bays.branchLifecycles().find((candidate) => candidate.bay === certified.id)
  if (lifecycle === undefined || lifecycle.status === "open" || lifecycle.status === "unmanaged") {
    throw new Error(`yrd: bay '${bay.id}' did not project a certified lifecycle state`)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.handoff", certification, lifecycle },
    createElement(BayStatusView, { bays: [certified] }),
  )
}

async function certifyBayProcessesStopped(
  processService: Pick<Process, "reapPath"> | undefined,
  bay: Bay,
): Promise<void> {
  // Provision can fail before a workspace exists. There is then no path-owned
  // process tree to reap; explicit force-close must still be able to drive the
  // durable Bay record to a terminal state.
  if (bay.path === undefined) return
  if (processService === undefined) configuration("bay close requires the process-backed Yrd runtime")
  const reaped = await processService.reapPath(bay.path)
  const failure = pathReapFailure(reaped)
  if (failure !== undefined) {
    throw new Error(`yrd: Bay '${bay.name}' process-tree teardown failed: ${failure}`)
  }
}

async function closeBayWithProcessReap(
  app: YrdCliApp,
  processService: Pick<Process, "reapPath"> | undefined,
  bay: Bay,
  options: Readonly<{ withdraw?: boolean }>,
  io: YrdCliIO,
  jobContext: string,
): Promise<Bay> {
  // First empty the active Bay. Then atomically mark it closing so `bay in`
  // refuses new guests, and re-census before the deprovision job removes the
  // ownership root. This closes the attach-between-census-and-delete race.
  await certifyBayProcessesStopped(processService, bay)
  const closing = await app.bays.close({
    bay: bay.id,
    ...(options.withdraw === true ? { withdraw: true } : {}),
  })
  await certifyBayProcessesStopped(processService, bay)
  assertJobsPassed(await runJobs(app, app.jobs.requested(closing), io), jobContext)
  const closed = app.bays.get(bay.id)
  if (closed === undefined) throw new Error(`yrd: Bay '${bay.name}' disappeared while it was closing`)
  return closed
}

async function closeBays(
  app: YrdCliApp,
  services: YrdCliServices,
  selectors: readonly string[],
  options: { withdraw?: boolean; json?: boolean; force?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  // --force requires an explicit bay name/id (no empty selector = all open).
  if (options.force === true && selectors.length === 0) {
    usage("bay close --force requires an explicit bay selector (no glob/all)")
  }
  const bays = selectedBays(stateOf(app).bays, selectors, cwd, "close")
  const closed: Bay[] = []
  const refused: BayStatusReport[] = []
  const remoteTrackingFresh = refreshBayStatusOrigin(cwd)
  const protections = activeBayProtections(io)
  for (const bay of bays) {
    const report = classifyBayStatus(
      gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now()),
    )
    if (options.force !== true && report.exit !== 0) {
      refused.push(report)
      continue
    }
    if (options.force === true && report.exit !== 0) {
      await printHuman(
        io,
        `FORCE close ${bay.id} ${bay.name}: status exit=${report.exit} (destroying despite blocks)\n${formatBayStatusHuman(report)}`,
      )
    }
    try {
      const withdrawing =
        options.withdraw === true
          ? app.bays.prs().filter((pr) => (pr.bay === bay.id || pr.branch === bay.branch) && isLivePR(pr))
          : []
      const current = await closeBayWithProcessReap(
        app,
        services.process,
        bay,
        { withdraw: options.withdraw },
        io,
        `bay '${bay.id}' close`,
      )
      if (withdrawing.length > 0) {
        await app.queue.cancel({
          prs: withdrawing.map((pr) => pr.id),
          by: io.runner ?? "operator",
          reason: "PR withdrawn",
        })
      }
      closed.push(current)
    } catch (error) {
      const current = app.bays.get(bay.id)
      const detail = errorDetail(error).replace(/^yrd:\s*/u, "")
      const earlier = closed.length === 0 ? "" : `Closed ${closed.map((entry) => entry.name).join(", ")}. `
      const message =
        current?.status === "closed"
          ? `${earlier}Bay '${bay.name}' closed, but the command did not finish: ${detail}`
          : `${earlier}Bay '${bay.name}' was not closed: ${detail}`
      const fact = failureFact(error)
      throw createFailure(
        {
          kind: fact?.kind ?? "infrastructure",
          code: fact?.code ?? "bay-close-failed",
          message,
        },
        error,
      )
    }
  }
  if (refused.length > 0) {
    const body = refused.map((report) => formatBayStatusHuman(report)).join("\n\n")
    const outcome =
      closed.length === 0
        ? "nothing closed"
        : `closed ${closed.map((bay) => bay.name).join(", ")}; kept ${refused.map((report) => report.name).join(", ")}`
    await printHuman(io, `bay close stopped: ${outcome}\n\n${body}`)
    if (closed.length === 0) {
      raiseFailure(
        "refusal",
        "request-refused",
        `could not close ${String(refused.length)} bay(s); run bay status, or bay close --force <name>`,
      )
    }
  }
  if (closed.length === 0 && refused.length === 0) {
    usage("bay close requires at least one bay selector")
  }
  const [only] = closed
  if (!jsonEnabled(options) && only !== undefined && closed.length === 1 && refused.length === 0) {
    io.stdout(`closed ${only.name}\n`)
    return
  }
  if (closed.length > 0) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "bay.close", bays: closed, refused: refused.map((report) => report.bay) },
      createElement(BayStatusView, { bays: closed }),
    )
  }
}

/**
 * Refresh once per status/close/prune command so a deleted remote branch cannot
 * survive as a stale local tracking ref and authorize destructive cleanup.
 * This is the same fetch-before-git-cherry boundary used by branch-triage.
 */
function refreshBayStatusOrigin(repoRoot: string): boolean {
  try {
    gitSync(repoRoot, ["fetch", "--no-recurse-submodules", "--prune", "--quiet", "origin"])
    return true
  } catch {
    return false
  }
}

function originBranchMissing(repoRoot: string, branch: string, remoteTrackingFresh: boolean): boolean | undefined {
  if (!remoteTrackingFresh) return undefined
  try {
    gitSync(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])
    return false
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : null
    return freshOriginBranchMissing(status)
  }
}

/** Gather live facts for one bay; classification stays pure in bay-status.ts (22290). */
function gatherBayStatusFacts(
  app: YrdCliApp,
  bay: Bay,
  repoRoot: string,
  remoteTrackingFresh: boolean,
  protections: readonly YrdBayProtection[],
  now: number,
): BayStatusFacts {
  const ownerPid = parseOwnerPid(bay.name, bay.by)
  const ownerIsCaller = ownerPid === process.pid
  let ownerAlive: boolean | undefined
  if (ownerPid !== undefined) {
    try {
      process.kill(ownerPid, 0)
      ownerAlive = true
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined
      ownerAlive = code === "ESRCH" ? false : undefined
    }
  }

  const path = bay.path
  let worktreeDirty: boolean | undefined
  let worktreeMissing: boolean | undefined
  let tipLanded: boolean | undefined
  let tipDurableAt: string | undefined
  let tipLandedUnknown: boolean | undefined
  let aheadOfOrigin: number | undefined
  let uniquePatches: number | undefined
  const branchMissingFromOrigin = originBranchMissing(repoRoot, bay.branch, remoteTrackingFresh)
  let stashAttributed = 0
  let stashUnknown: boolean | undefined

  if (path === undefined) {
    worktreeMissing = undefined
  } else {
    try {
      const status = gitSync(path, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])
      worktreeDirty = status.trim() !== ""
      worktreeMissing = false
    } catch {
      // path missing or not a git dir
      try {
        gitSync(path, ["rev-parse", "--is-inside-work-tree"])
        worktreeDirty = undefined
        worktreeMissing = false
      } catch {
        worktreeMissing = true
      }
    }

    if (worktreeMissing !== true) {
      try {
        const head = gitSync(path, ["rev-parse", "HEAD"]).trim()
        // Prefer superproject origin/main when bay is a linked worktree of the repo.
        const originMain = gitSync(repoRoot, ["rev-parse", "origin/main"]).trim()
        try {
          gitSync(path, ["merge-base", "--is-ancestor", head, originMain])
          tipLanded = true
          tipDurableAt = "origin/main"
          aheadOfOrigin = 0
          uniquePatches = 0
        } catch {
          tipLanded = false
          try {
            const counts = gitSync(path, ["rev-list", "--left-right", "--count", `${originMain}...${head}`])
              .trim()
              .split(/\s+/u)
              .map(Number)
            const ahead = counts[1]
            if (Number.isSafeInteger(ahead)) aheadOfOrigin = ahead
          } catch {
            tipLandedUnknown = true
          }
          try {
            uniquePatches = gitSync(path, ["cherry", originMain, head])
              .split("\n")
              .filter((line) => line.startsWith("+ ")).length
            if (uniquePatches === 0) {
              tipLanded = true
              tipDurableAt = "origin/main (same changes)"
              tipLandedUnknown = undefined
            } else if (remoteTrackingFresh) {
              const remoteRef = gitSync(path, [
                "for-each-ref",
                "--format=%(refname:short)",
                "--contains",
                head,
                "refs/remotes/origin/",
              ])
                .split("\n")
                .map((ref) => ref.trim())
                .find((ref) => ref !== "" && ref !== "origin")
              if (remoteRef !== undefined) {
                tipDurableAt = remoteRef
                tipLandedUnknown = undefined
              }
            } else {
              tipLandedUnknown = true
            }
          } catch {
            tipLandedUnknown = true
          }
        }
      } catch {
        tipLandedUnknown = true
      }

      try {
        const stash = gitSync(path, ["stash", "list"])
        // Best-effort: count stashes whose message mentions bay id/branch/name.
        const tokens = [bay.id, bay.branch, bay.name].filter(Boolean)
        stashAttributed = stash
          .split("\n")
          .filter((line) => line.trim() !== "" && tokens.some((token) => line.includes(token))).length
      } catch {
        stashUnknown = true
      }
    }
  }

  const openPrIds = app.bays
    .prs()
    .filter((pr) => (pr.bay === bay.id || pr.branch === bay.branch) && isLivePR(pr))
    .map((pr) => pr.id)
  const openedAt = Date.parse(bay.openedAt)
  const ageMs = Number.isFinite(openedAt) ? Math.max(0, now - openedAt) : undefined

  return {
    bayId: bay.id,
    name: bay.name,
    branch: bay.branch,
    ...(bay.status === "failed" && path === undefined ? { closedDegenerate: true } : {}),
    ...(path === undefined ? {} : { path }),
    protectedBy: protectionEvidenceForBay(protections, { id: bay.id, ...(path === undefined ? {} : { path }) }),
    protectionGaps: protectionGapEvidenceForBay(protections, {
      id: bay.id,
      ...(path === undefined ? {} : { path }),
    }),
    ...(ownerPid === undefined ? {} : { ownerPid }),
    ...(ownerPid === undefined ? {} : { ownerIsCaller }),
    ...(ownerAlive === undefined ? {} : { ownerAlive }),
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(worktreeDirty === undefined ? {} : { worktreeDirty }),
    ...(worktreeMissing === undefined ? {} : { worktreeMissing }),
    ...(tipLanded === undefined ? {} : { tipLanded }),
    ...(tipDurableAt === undefined ? {} : { tipDurableAt }),
    ...(tipLandedUnknown === undefined ? {} : { tipLandedUnknown }),
    ...(aheadOfOrigin === undefined ? {} : { aheadOfOrigin }),
    ...(uniquePatches === undefined ? {} : { uniquePatches }),
    remoteTrackingFresh,
    ...(branchMissingFromOrigin === undefined ? {} : { branchMissingFromOrigin }),
    stashAttributed,
    ...(stashUnknown === undefined ? {} : { stashUnknown }),
    openPrIds,
  }
}

function activeBayProtections(io: YrdCliIO): readonly YrdBayProtection[] {
  return io.bayProtections ?? parseYrdBayProtections(process.env[YRD_BAY_PROTECTIONS_ENV])
}

async function bayStatusCommand(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const cwd = io.cwd ?? process.cwd()
  const bays =
    selectors.length === 0
      ? app.bays.list().filter((bay) => bay.status !== "closed")
      : selectedBays(stateOf(app).bays, selectors, cwd, "status")
  if (bays.length === 0) usage("bay status requires at least one open bay (or a selector)")

  const remoteTrackingFresh = refreshBayStatusOrigin(cwd)
  const protections = activeBayProtections(io)
  const reports: BayStatusReport[] = bays.map((bay) =>
    classifyBayStatus(gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now())),
  )
  // Aggregate exit: any BLOCK → 1; else any UNKNOWN → 2; else 0.
  // YrdCliExitCode is 0|1|2|3; bay status uses the 0/1/2 subset (2 = unknown).
  let exit: YrdCliExitCode = 0
  for (const report of reports) {
    if (report.exit === 1) exit = 1
    else if (report.exit === 2 && exit === 0) exit = 2
  }

  if (jsonEnabled(options)) {
    await printResult(io, true, { command: "bay.status", wrapper: "git", exit, reports }, null)
  } else {
    const text = reports.map((report) => formatBayStatusHuman(report)).join("\n\n")
    await printHuman(io, text)
  }
  return exit
}

/** Sweep open bays via the status oracle. --dry-run is the DEFAULT (22290). */
async function bayPruneCommand(
  app: YrdCliApp,
  services: YrdCliServices,
  options: { json?: boolean; apply?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const cwd = io.cwd ?? process.cwd()
  const open = app.bays.list().filter((bay) => bay.status !== "closed")
  const remoteTrackingFresh = refreshBayStatusOrigin(cwd)
  const protections = activeBayProtections(io)
  const reports = open.map((bay) =>
    classifyBayStatus(gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now())),
  )
  const dryRun = options.apply !== true
  const preserved: string[] = []
  if (!dryRun) {
    for (const report of reports) {
      const dirty = report.lines.some((line) => line.class === "worktree" && line.verdict === "BLOCK")
      const unsafeToPreserve = report.lines.some(
        (line) =>
          line.class !== "worktree" && line.class !== "commits" && line.class !== "pr" && line.verdict !== "PASS",
      )
      if (!dirty || unsafeToPreserve) continue
      const bay = open.find((candidate) => candidate.id === report.bay)
      if (bay === undefined) throw new Error(`yrd: prune report refers to missing Bay '${report.bay}'`)
      await checkpointRunBay(app, bay, `yrd admin bay prune preserve ${bay.id}`, io)
      preserved.push(bay.id)
    }
  }
  const preservedSet = new Set(preserved)
  const outcomes = bayPruneOutcomes(reports, preservedSet)

  if (jsonEnabled(options)) {
    await printResult(
      io,
      true,
      {
        command: "bay.prune",
        dryRun,
        examined: reports.length,
        preserved,
        outcomes: outcomes.rows,
        histogram: outcomes.histogram,
        closed: dryRun ? [] : outcomes.rows.pruned,
      },
      null,
    )
  } else {
    const lines = [
      `bay prune ${dryRun ? "(dry-run DEFAULT — pass --apply to close PRUNE bays)" : "(APPLY)"}`,
      `examined ${String(reports.length)} open bay(s); prune=${String(outcomes.rows.pruned.length)}; keep=${String(outcomes.rows.kept.length)}; page=${String(outcomes.rows.paged.length)}`,
      "",
      ...reports.map((report) => {
        const disposition = preservedSet.has(report.bay)
          ? "PAGE"
          : report.exit === 0
            ? "PRUNE"
            : report.exit === 1
              ? "KEEP"
              : "PAGE"
        const evidenceLines = report.lines
          .filter((line) => line.verdict !== "PASS")
          .map((line) => `      ${line.class} ${line.verdict} ${line.evidence}`)
        if (preservedSet.has(report.bay)) {
          evidenceLines.push("      worktree PRESERVED checkpoint pushed; reevaluate on the next pass")
        }
        const evidence = evidenceLines.join("\n")
        return `${disposition}  ${report.bay} ${report.name}  ${report.branch}${evidence === "" ? "" : `\n${evidence}`}`
      }),
    ]
    await printHuman(io, lines.join("\n"))
  }

  if (!dryRun && outcomes.rows.pruned.length > 0) {
    await closeBays(app, services, outcomes.rows.pruned, { json: options.json }, io)
  }
  if (reports.length === 0) return 0
  return outcomes.rows.paged.length > 0 || outcomes.rows.pruned.length === 0 ? 1 : 0
}

type BayPruneOutcome = Readonly<{ bay: string; reasons: readonly BayStatusClass[] }>

/** Pure conservation reducer; exported for the multi-reason histogram contract test. */
export function bayPruneOutcomes(reports: readonly BayStatusReport[], preserved: ReadonlySet<string>) {
  const rows: {
    pruned: string[]
    kept: BayPruneOutcome[]
    paged: BayPruneOutcome[]
  } = { pruned: [], kept: [], paged: [] }
  const keptByReason: Partial<Record<BayStatusClass, number>> = {}
  const pagedByReason: Partial<Record<BayStatusClass, number>> = {}

  const increment = (histogram: Partial<Record<BayStatusClass, number>>, reason: BayStatusClass) => {
    histogram[reason] = (histogram[reason] ?? 0) + 1
  }
  for (const report of reports) {
    if (report.exit === 0) {
      rows.pruned.push(report.bay)
      continue
    }
    const verdict = report.exit === 1 ? "BLOCK" : "UNKNOWN"
    const reasons = report.lines.filter((line) => line.verdict === verdict).map((line) => line.class)
    if (preserved.has(report.bay)) {
      rows.paged.push({ bay: report.bay, reasons: ["worktree"] })
      increment(pagedByReason, "worktree")
      continue
    }
    if (report.exit === 1) {
      rows.kept.push({ bay: report.bay, reasons })
      const primaryReason = reasons[0]
      if (primaryReason === undefined) throw new Error(`yrd: blocked Bay '${report.bay}' has no blocking reason`)
      increment(keptByReason, primaryReason)
    } else {
      rows.paged.push({ bay: report.bay, reasons })
      const primaryReason = reasons[0]
      if (primaryReason === undefined) throw new Error(`yrd: unknown Bay '${report.bay}' has no unknown reason`)
      increment(pagedByReason, primaryReason)
    }
  }
  return {
    rows,
    histogram: { pruned: rows.pruned.length, keptByReason, pagedByReason },
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function requireQueueableSubmodulePins(pr: PR, services: YrdCliServices, io: YrdCliIO): Promise<void> {
  if (services.process === undefined) return
  const repo = io.cwd ?? process.cwd()
  const headSha = prHead(pr)
  // Not prBaseSha(pr). That field is set at create, re-set at recut, and chased
  // forward to track current main while the author's head stays exactly where
  // they left it, so a two-dot diff from it reports every pin that moved on
  // main as this PR's authorship and refuses a branch for a gitlink it never
  // touched. The queue's own composition gate has always measured from a live
  // merge base; this pre-admission gate now asks the question the same way.
  const baseSha = await authoredSubmodulePinBase({ process: services.process, repo, base: pr.base, headSha })
  if (baseSha === undefined) {
    raiseFailure(
      "refusal",
      "pr-base-unresolved",
      `yrd: PR '${pr.id}' base '${pr.base}' resolves to no ref in '${repo}'; ` + "fetch the base branch, then retry",
    )
  }
  const changed = await changedSubmodulePins({
    process: services.process,
    repo,
    baseSha,
    headSha,
  })
  const unpublished = await unpublishedSubmodulePins({ process: services.process, pins: changed })
  if (unpublished.length > 0) {
    const issue = pr.issue ?? "<issue-ref>"
    const detail = unpublished
      .map(
        ({ path, pin, repository }) =>
          `submodule '${path}' pin '${pin}' is on zero refs fetched from origin; whoever holds this commit in ` +
          `'${repository}' must publish it through that component's own git workflow — never as this refusal's ` +
          `remedy — then submit: 'yrd intent submit --component ${path} --target ${pin} --issue ${issue}'`,
      )
      .join("\n")
    raiseFailure(
      "refusal",
      "submodule-pin-unpublished",
      `yrd: PR '${pr.id}' changes unpublished submodule pins:\n${detail}`,
    )
  }
  if (changed.length === 0 || prComposition(pr) !== undefined || currentPRRev(pr).recut !== undefined) return
  const issue = pr.issue ?? "<issue-ref>"
  const intents = changed
    .map(({ path, pin }) => `'yrd intent submit --component ${path} --target ${pin} --issue ${issue}'`)
    .join(", then ")
  raiseFailure(
    "refusal",
    "authored-gitlink",
    `yrd: PR '${pr.id}' changes generated-only gitlinks [${changed.map(({ path }) => path).join(", ")}]; ` +
      `authored gitlinks are never admitted; submit ${intents}`,
  )
}

async function requireQueueableSubmodulePinsForCommand(
  pr: PR,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode | undefined> {
  try {
    await requireQueueableSubmodulePins(pr, services, io)
    return undefined
  } catch (error) {
    if (failureFact(error) === undefined) throw error
    await diagnostic(io, error, {
      json: jsonEnabled(options),
      actionableContext: { delivery: prDeliveryState(pr) },
    })
    return classifyFailure(error).exitCode
  }
}

type PublicationProjection = Readonly<{
  job: string
  status: "publication-required" | "publishing" | "published" | "publication-failed"
  continuation: PrPublicationInput["continuation"]
  detail: string
  error?: JobError
}>

function publicationJob(app: YrdCliApp, pr: PR): Job | undefined {
  const revision = currentPRRev(pr)
  const current = app.jobs.getByKey(prPublicationJobKey({ pr: pr.id, revision: revision.n, headSha: revision.head }))
  if (current !== undefined) return current
  return Object.values(stateOf(app).jobs.byId)
    .filter((job) => job.definition === "pr.publish" && PrPublicationInputSchema.parse(job.input).pr === pr.id)
    .toSorted((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0]
}

function projectPublication(job: Job | undefined): PublicationProjection | undefined {
  if (job?.definition !== "pr.publish") return undefined
  const input = PrPublicationInputSchema.parse(job.input)
  if (job.status === "queued") {
    return {
      job: job.id,
      status: "publication-required",
      continuation: input.continuation,
      detail: "waiting for the one-shot or resident queue runner",
    }
  }
  if (job.status === "in_progress" || job.status === "waiting") {
    return {
      job: job.id,
      status: "publishing",
      continuation: input.continuation,
      detail:
        job.status === "waiting" ? (job.detail ?? "publisher is waiting") : "credential-bearing publisher is running",
    }
  }
  if (job.conclusion === "success") {
    return { job: job.id, status: "published", continuation: input.continuation, detail: "immutable refs published" }
  }
  const detail =
    job.conclusion === "failure"
      ? job.error.message
      : job.conclusion === "timed_out"
        ? job.lostReason
        : job.conclusion === "cancelled"
          ? job.cancelReason
          : "publication job did not run"
  return {
    job: job.id,
    status: "publication-failed",
    continuation: input.continuation,
    detail,
    ...(job.conclusion === "failure" ? { error: job.error } : {}),
  }
}

async function publishPr(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption & Readonly<{ queue?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const process = services.process ?? configuration("pr.publish capability is not installed")
  const pr = requiredPr(app, selector)
  const revision = currentPRRev(pr)
  const baseSha = prBaseSha(pr)
  if (baseSha === undefined) raiseFailure("refusal", "pr-base-missing", `yrd: PR '${pr.id}' has no immutable base SHA`)
  const sourceRoot = resolve(io.cwd ?? globalThis.process.cwd())
  const components = await changedSubmodulePins({
    process,
    repo: sourceRoot,
    baseSha,
    headSha: revision.head,
  })
  const input: PrPublicationInput = {
    pr: pr.id,
    revision: revision.n,
    headSha: revision.head,
    baseSha,
    branch: pr.branch,
    sourceRoot,
    components: components.map(({ path, pin }) => ({ path, pin })),
    continuation: options.queue === true ? "queue" : "none",
  }
  const key = prPublicationJobKey(input)
  let job = app.jobs.getByKey(key)
  if (job === undefined) {
    const requested = await app.bays.requestPublication(input)
    const id = app.jobs.requested(requested)[0] ?? app.jobs.getByKey(key)?.id
    job = id === undefined ? undefined : app.jobs.get(id)
  } else {
    if (JSON.stringify(PrPublicationInputSchema.parse(job.input)) !== JSON.stringify(input)) {
      raiseFailure(
        "refusal",
        "publication-request-conflict",
        `yrd: PR '${pr.id}' revision ${revision.n} already has publication Job '${job.id}' with different request details`,
      )
    }
    if (job.status === "completed" && (job.conclusion === "failure" || job.conclusion === "timed_out")) {
      job = await app.jobs.retry(job.id)
    }
  }
  const publication = projectPublication(job)
  if (publication === undefined) throw new Error(`yrd: PR '${pr.id}' publication request produced no Job`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.publish", pr: projectPRTaskStatus(pr), publication },
    `${pr.id} ${publication.status}: ${publication.detail}`,
  )
}

async function readyPr(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const selected = requiredPr(app, selector)
  const refusalExit = await requireQueueableSubmodulePinsForCommand(selected, services, options, io)
  if (refusalExit !== undefined) return refusalExit
  await runRequiredChecks(services, io)
  await app.bays.ready({ pr: selector })
  let pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after ready`)
  if (!app.bays.checksRequested(pr.id)) await app.bays.requestChecks({ pr: pr.id })
  pr = app.bays.pr(pr.id)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after requesting checks`)
  const eligibility = app.queue.eligibility(pr.id)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.ready",
      pr: projectPrTaskStatusWithEligibility(pr, eligibility),
      eligibility: projectEligibilityTaskStatus(eligibility),
    },
    createElement(PRResultView, { prs: [pr], runs: [], eligibilities: [eligibility] }),
  )
  return prDeliveryState(pr) === "needs-author" ? 1 : 0
}

async function recutPr(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption &
    Readonly<{
      revision?: number
      ref?: string
      queue?: boolean
      force?: boolean
      preflight?: boolean
      apply?: boolean
    }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.ref !== undefined && options.revision !== undefined) {
    usage("--ref cannot combine with --revision")
  }
  if (options.apply === true) {
    if (options.preflight !== true || options.queue !== true) usage("--apply requires --preflight and --queue")
    if (options.revision !== undefined) {
      usage("--apply computes the current revision; it cannot combine with --revision")
    }
    if (options.force === true) usage("--apply computes whether force is safe; it cannot combine with --force")
  }
  const pr = requiredPr(app, selector)
  const commandCurrent = currentPRRev(pr)
  const explicitProposedHeadSha =
    options.ref === undefined
      ? undefined
      : ((await optionalRevision(options.ref, io)) ??
        raiseFailure(
          "refusal",
          "proposed-commit-missing",
          `yrd: proposed ref '${options.ref}' does not resolve to a commit`,
        ))
  const selectedRevision = options.revision ?? commandCurrent.n
  const selected = pr.revs.find((revision) => revision.n === selectedRevision)
  let proposedHeadSha = explicitProposedHeadSha
  if (explicitProposedHeadSha === undefined && isLivePR(pr) && selected !== undefined) {
    const freshness = await requireImplicitRecutBranchFreshness(pr, selected, options, services, io)
    if (freshness.status === "tracked-drift") proposedHeadSha = freshness.liveHead
  }
  const currentRevisionAtStart = currentPRRev(pr)
  const sourceRevision =
    proposedHeadSha !== undefined &&
    options.revision === undefined &&
    currentRevisionAtStart.head === proposedHeadSha &&
    currentRevisionAtStart.recut?.fromRevision !== undefined
      ? currentRevisionAtStart.recut.fromRevision
      : selectedRevision
  const expectedCurrent = {
    revision: currentRevisionAtStart.n,
    headSha: currentRevisionAtStart.head,
    ...(pr.track === true ? { track: true } : {}),
  }
  if (options.preflight === true) {
    const preflight = await preflightRecut(
      app,
      selector,
      {
        ...(options.json === undefined ? {} : { json: options.json }),
        ...(options.queue === undefined ? {} : { queue: options.queue }),
        ...(options.revision !== undefined ||
        (proposedHeadSha !== undefined && sourceRevision !== currentRevisionAtStart.n)
          ? { revision: sourceRevision }
          : {}),
        ...(proposedHeadSha === undefined ? {} : { proposedHeadSha, expectedCurrent }),
      },
      options.apply === true ? { ...io, stdout: () => undefined } : io,
    )
    if (options.apply !== true) return 0
    await applyPreflightVerdict(app, services, preflight, io)
    const current = requiredPr(app, selector)
    const revision = currentPRRev(current)
    const delivery = prDeliveryState(current)
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "pr.recut.apply",
        pr: current.id,
        verdict: preflight.verdict,
        executed: preflight.next,
        result: { revision: revision.n, headSha: revision.head, delivery },
      },
      [
        `${preflight.verdict} ${current.id} r${preflight.revision}`,
        `executed: ${preflight.next}`,
        `result: ${current.id} r${revision.n} ${revision.head} (${delivery})`,
      ].join("\n"),
    )
    return delivery === "needs-author" ? 1 : 0
  }
  const outcome = await executeRecutPr(
    app,
    services,
    selector,
    {
      ...(options.queue === undefined ? {} : { queue: options.queue }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(proposedHeadSha === undefined
        ? options.revision === undefined
          ? {}
          : { revision: options.revision }
        : { revision: sourceRevision, proposedHeadSha, expectedCurrent }),
    },
    io,
  )
  const revision = prRevisionNumber(outcome.current)
  await printResult(
    io,
    jsonEnabled(options),
    outcome.output,
    `${outcome.current.id} revision ${revision} ${outcome.unchanged ? "already matches" : "recut onto"} ${outcome.result.baseSha}`,
  )
  return prDeliveryState(outcome.current) === "needs-author" ? 1 : 0
}

type ExecuteRecutPrOptions = Readonly<{
  revision?: number
  proposedHeadSha?: string
  queue?: boolean
  force?: boolean
  admit?: boolean
  transition?: PRFreshnessTransition
  expectedCurrent?: Readonly<{ revision: number; headSha: string; track?: boolean }>
}>

async function cancelSupersededRevisionRuns(
  app: YrdCliApp,
  identity: Readonly<{ pr: string; revision: number; headSha: string }>,
  by: string,
  reason: string,
): Promise<void> {
  const runs = allQueueRuns(app).filter(
    (run) =>
      !Queues.terminal(run) &&
      run.prs.some(
        (member) =>
          member.id === identity.pr && member.revision === identity.revision && member.headSha === identity.headSha,
      ),
  )
  for (const run of runs) {
    try {
      await app.queue.cancelRun({ run: run.id, by, reason })
    } catch (error) {
      const failure = failureFact(error)
      if (failure?.kind === "refusal" && failure.code === "run-terminal") continue
      throw error
    }
  }
}

async function executeRecutPr(
  app: YrdCliApp,
  services: Pick<YrdCliServices, "process" | "recut">,
  selector: string,
  options: ExecuteRecutPrOptions,
  io: YrdCliIO,
) {
  const service = services.recut ?? configuration("pr.recut capability is not installed")
  const pr = requiredPr(app, selector)
  const delivery = prDeliveryState(pr)
  const currentRevision = currentPRRev(pr)
  const proposedHeadSha = options.proposedHeadSha
  const expectedCurrent = options.expectedCurrent ?? {
    revision: currentRevision.n,
    headSha: currentRevision.head,
  }
  if (
    currentRevision.n !== expectedCurrent.revision ||
    currentRevision.head !== expectedCurrent.headSha ||
    (expectedCurrent.track !== undefined && (pr.track ?? false) !== expectedCurrent.track)
  ) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: PR '${pr.id}' current revision changed from ${expectedCurrent.revision}@${expectedCurrent.headSha} ` +
        `to ${currentRevision.n}@${currentRevision.head} before the recut was computed`,
    )
  }
  if (
    delivery === "integrated" ||
    delivery === "already-landed" ||
    delivery === "withdrawn" ||
    delivery === "canceled"
  ) {
    raiseFailure(
      "refusal",
      "terminal-target",
      `yrd: PR '${pr.id}' is ${delivery}; a finished merge request cannot be recut`,
    )
  }
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1)) {
    usage("--revision must be a positive integer")
  }
  const fromRevision = options.revision ?? currentRevision.n
  const source = pr.revs.find((revision) => revision.n === fromRevision)
  if (source === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: PR '${pr.id}' has no revision ${fromRevision}`)
  }
  const certificate = proposedHeadSha === undefined ? undefined : ("frozen-code-carrier-v1" as const)
  const currentReview = app.bays.reviewState(pr.id).current
  const approvedCurrentReview = currentReview?.decision === "approve" ? currentReview : undefined
  if (certificate !== undefined) {
    if (currentReview?.decision === "reject") {
      raiseFailure(
        "refusal",
        "review-rejected",
        `yrd: PR '${pr.id}' was rejected by ${currentReview.by} for revision ${currentRevision.n}`,
      )
    }
    if (approvedCurrentReview === undefined) {
      raiseFailure("refusal", "review-required", `yrd: PR '${pr.id}' needs approval for revision ${currentRevision.n}`)
    }
  }
  // Refuse to silently discard a green check: if the PR's current head already
  // holds a passing check for its current revision, recutting supersedes that
  // revision and throws the passing result away. Require an explicit --force so
  // the discard is a deliberate operator choice, never a mechanical accident.
  const checksPassed = app.queue.eligibility(pr.id).checks.status === "passed"
  if (options.force !== true && checksPassed) {
    raiseFailure(
      "refusal",
      "recut-would-discard-green",
      `yrd: PR '${pr.id}' revision ${currentRevision.n} already passed its checks; recut would discard that result. ` +
        "Re-run with --force to override.",
    )
  }
  const sourceReview = pr.reviews.findLast((review) => review.revision === source.n && review.headSha === source.head)
  const approval = sourceReview?.decision === "approve" ? sourceReview : undefined
  const recutExpectedCurrent = {
    ...expectedCurrent,
    ...(certificate === undefined || approvedCurrentReview === undefined
      ? {}
      : {
          effectiveReview: {
            revision: approvedCurrentReview.revision,
            headSha: approvedCurrentReview.headSha,
            by: approvedCurrentReview.by,
            decision: approvedCurrentReview.decision,
            at: approvedCurrentReview.at,
            ...(approvedCurrentReview.ref === undefined ? {} : { ref: approvedCurrentReview.ref }),
            ...(approvedCurrentReview.note === undefined ? {} : { note: approvedCurrentReview.note }),
            ...(approvedCurrentReview.carriedFrom === undefined
              ? {}
              : { carriedFrom: approvedCurrentReview.carriedFrom }),
          },
          ...(options.force === true ? {} : { checksPassed: false as const }),
        }),
  }
  const currentCompositions = source.composition === undefined ? sameIssueIntegratedCompositions(app, pr) : undefined
  const recutInput: Parameters<typeof service.recut>[0] = {
    id: pr.id,
    ...(pr.bay === undefined ? {} : { bay: pr.bay }),
    ...(pr.name === undefined ? {} : { name: pr.name }),
    branch: pr.branch,
    base: pr.base,
    revision: source.n,
    headSha: source.head,
    ...(source.baseSha === undefined ? {} : { baseSha: source.baseSha }),
    ...(source.correlation === undefined ? {} : { correlation: source.correlation }),
    ...(source.composition === undefined ? {} : { composition: source.composition }),
    ...(currentCompositions === undefined ? {} : { currentCompositions }),
    ...(proposedHeadSha === undefined ? {} : { proposedHeadSha }),
    ...(currentRevision.recut === undefined
      ? {}
      : {
          current: {
            revision: currentRevision.n,
            headSha: currentRevision.head,
            ...(currentRevision.baseSha === undefined ? {} : { baseSha: currentRevision.baseSha }),
            treeSha: currentRevision.recut.treeSha,
            patchId: currentRevision.recut.patchId,
            fromRevision: currentRevision.recut.fromRevision,
            ...(currentRevision.composition === undefined ? {} : { composition: currentRevision.composition }),
          },
        }),
  }
  const result = await service.recut(recutInput)
  if (options.transition !== undefined && result.headSha === result.baseSha) {
    await app.bays.settleSuperseded({
      pr: pr.id,
      revision: currentRevision.n,
      headSha: currentRevision.head,
      baseSha: result.baseSha,
      baseTreeSha: result.treeSha,
      patchId: result.patchId,
    })
    await app.queue.cancelAdmissionJobs({
      pr: pr.id,
      revision: currentRevision.n,
      by: io.runner ?? "operator",
      reason: `PR revision ${currentRevision.n} settled because its payload is already contained`,
    })
    const current = requiredPr(app, pr.id)
    return {
      current,
      output: {
        pr: current.id,
        revision: prRevisionNumber(current),
        baseSha: result.baseSha,
        treeSha: result.treeSha,
        patchId: result.patchId,
        reviewCarried: approval !== undefined,
        ...(prCorrelation(current) === undefined ? {} : { correlation: prCorrelation(current) }),
        sourceReadyAt: prSourceReadyAt(current),
        lineage: prRevisionLineage(current).map((revision) => revision.n),
        unchanged: false,
        settlement: "payload-already-contained" as const,
      },
      result,
      unchanged: false,
      settlement: "payload-already-contained" as const,
    }
  }
  const sources =
    result.unchanged && currentRevision.recut?.sources !== undefined
      ? currentRevision.recut.sources
      : [
          {
            repo: ".",
            fromHeadSha: source.head,
            toHeadSha: result.headSha,
            patchId: result.patchId,
            rangeDiff: "=" as const,
          },
          ...(result.sourceRewrites ?? []).map((rewrite) => ({
            repo: rewrite.repo,
            fromHeadSha: rewrite.oldTipSha,
            toHeadSha: rewrite.newTipSha,
            patchId: rewrite.patchId,
            rangeDiff: rewrite.rangeDiff,
          })),
        ]
  const recorded = await app.bays.recut({
    pr: pr.id,
    fromRevision: source.n,
    headSha: result.headSha,
    baseSha: result.baseSha,
    treeSha: result.treeSha,
    patchId: result.patchId,
    reviewCarried: approval !== undefined,
    ...(certificate === undefined ? {} : { certificate }),
    sources,
    ...(result.composition === undefined ? {} : { composition: result.composition }),
    expectedCurrent: recutExpectedCurrent,
    ...(options.transition === undefined ? {} : { transition: options.transition }),
  })
  const unchanged = recorded.events.length === 0

  const queueExpectedCurrent = {
    pr: pr.id,
    revision: unchanged ? expectedCurrent.revision : expectedCurrent.revision + 1,
    headSha: unchanged ? expectedCurrent.headSha : result.headSha,
    ...(expectedCurrent.track === undefined ? {} : { track: expectedCurrent.track }),
  }
  let current = requiredPr(app, pr.id)
  if (options.queue === true) {
    await requireQueueableSubmodulePins(current, services, io)
    await app.bays.ready({ pr: pr.id, expectedCurrent: queueExpectedCurrent })
    current = requiredPr(app, pr.id)
    if (!unchanged) {
      const by = io.runner ?? "operator"
      const reason = `PR recut superseded revision ${source.n}`
      await app.queue.cancelAdmissionJobs({ pr: pr.id, revision: expectedCurrent.revision, by, reason })
      if (expectedCurrent.track === true) {
        await cancelSupersededRevisionRuns(
          app,
          { pr: pr.id, revision: expectedCurrent.revision, headSha: expectedCurrent.headSha },
          by,
          reason,
        )
      } else {
        await app.queue.cancel({ prs: [current.id], by, reason })
      }
    }
    current = requiredPr(app, current.id)
    const currentDelivery = prDeliveryState(current)
    if (currentDelivery !== "submitted" && currentDelivery !== "ready") {
      raiseFailure("refusal", "recut-not-ready", `yrd: PR '${current.id}' is ${currentDelivery}, not ready`)
    }
    if (!app.bays.checksRequested(current.id)) {
      await app.bays.requestChecks({ pr: current.id, expectedCurrent: queueExpectedCurrent })
    }
    await app.bays.ready({ pr: current.id, expectedCurrent: queueExpectedCurrent })
    current = requiredPr(app, current.id)
  }
  const output = {
    pr: current.id,
    revision: prRevisionNumber(current),
    baseSha: result.baseSha,
    treeSha: result.treeSha,
    patchId: result.patchId,
    reviewCarried: approval !== undefined,
    ...(prCorrelation(current) === undefined ? {} : { correlation: prCorrelation(current) }),
    sourceReadyAt: prSourceReadyAt(current),
    lineage: prRevisionLineage(current).map((revision) => revision.n),
    unchanged,
  }
  return { current, output, result, unchanged, settlement: undefined }
}

async function reviewPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ approve?: boolean; reject?: boolean; by?: string; ref?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.approve === options.reject) usage("pr review requires exactly one of --approve or --reject")
  await app.bays.review({
    pr: selector,
    by: options.by ?? io.runner ?? "operator",
    decision: options.approve === true ? "approve" : "reject",
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after review`)
  const review =
    options.ref === undefined
      ? app.bays.reviewState(pr.id).current
      : pr.reviews.findLast((candidate) => candidate.ref === options.ref)
  if (review === undefined) throw new Error(`yrd: PR '${pr.id}' did not retain its current review`)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.review",
      pr: prFact(pr),
      review,
      eligibility: projectEligibilityTaskStatus(app.queue.eligibility(pr.id)),
    },
    `${pr.id} revision ${prRevisionNumber(pr)} ${review.decision} by ${review.by}`,
  )
}

async function requestReviewPr(
  app: YrdCliApp,
  selector: string,
  reviewers: readonly string[],
  options: JsonOption & Readonly<{ clear?: boolean; by?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.clear === true && reviewers.length > 0) {
    usage("pr request-review --clear cannot combine with reviewer identities")
  }
  if (options.clear !== true && reviewers.length === 0) {
    usage("pr request-review requires reviewer identities or --clear")
  }
  await app.bays.requestReview({
    pr: selector,
    reviewers: options.clear === true ? [] : [...reviewers],
    by: options.by ?? io.runner ?? "operator",
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after request-review`)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.request-review",
      pr: prFact(pr),
      requestedReviewers: pr.requestedReviewers ?? [],
      needsReview: app.bays.needsReview(pr.id),
    },
    `${pr.id} requested reviewers ${(pr.requestedReviewers ?? []).length === 0 ? "cleared" : (pr.requestedReviewers ?? []).join(", ")}`,
  )
}

async function commentPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ by?: string; ref?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.note === undefined || options.note.trim() === "") usage("pr comment requires --note <text>")
  await app.bays.comment({
    pr: selector,
    by: options.by ?? io.runner ?? "operator",
    note: options.note,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after comment`)
  const comment =
    options.ref === undefined ? pr.comments.at(-1) : pr.comments.findLast((candidate) => candidate.ref === options.ref)
  if (comment === undefined) throw new Error(`yrd: PR '${pr.id}' did not retain its comment`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.comment", pr: prFact(pr), comment },
    `${pr.id} revision ${prRevisionNumber(pr)} commented by ${comment.by}`,
  )
}

async function prChecks(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption & Readonly<{ follow?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (selectors.length === 0) usage("pr checks requires at least one PR selector")
  let checks: readonly PRCheckViewRecord[] = prCheckRecords(app, selectors)
  if (options.follow === true) {
    const missing = checks.find((check) => check.status === "not-requested")
    if (missing !== undefined) refusal(`PR '${missing.pr}' has no requested checks; submit it before following`)
    checks = await followCheckRecords(app, selectors, checks, io)
  }
  if (jsonEnabled(options)) {
    for (const check of checks) io.stdout(stableJson({ kind: "pr.check", ...projectCheckTaskStatus(check) }))
  } else {
    await printHuman(io, createElement(PRChecksView, { records: checks, now: io.now?.() ?? Date.now() }))
  }
  return checks.some((check) => check.status === "failed") ? 1 : 0
}

function checksTerminal(records: readonly PRCheckViewRecord[]): boolean {
  return records.every((record) => record.status !== "queued" && record.status !== "checking")
}

async function followCheckRecords(
  app: YrdCliApp,
  selectors: readonly string[],
  initial: readonly PRCheckViewRecord[],
  io: YrdCliIO,
): Promise<readonly PRCheckViewRecord[]> {
  const scope = io.scope ?? app.scope
  let records = [...initial]
  while (!checksTerminal(records) && !scope.signal.aborted) {
    await scope.sleep(1_000)
    if (scope.signal.aborted) return records
    await app.refresh()
    if (scope.signal.aborted) return records
    records = [...prCheckRecords(app, selectors)]
  }
  return records
}

async function optionalRevision(ref: string, io: YrdCliIO): Promise<string | undefined> {
  const cwd = io.cwd ?? process.cwd()
  return io.resolveRevision?.(ref, cwd)
}

async function optionalCommitMeta(
  ref: string,
  io: YrdCliIO,
): Promise<Readonly<{ subject: string; body?: string }> | undefined> {
  const cwd = io.cwd ?? process.cwd()
  return io.resolveCommitMeta?.(ref, cwd)
}

/** True when a commit body already ends with an `Issue: <ref>` trailer for the
 * SAME issue. Commit bodies written with the GitHub "closing keyword in the
 * body" convention often carry the trailer themselves, so composeDescription
 * must not append a second copy (which rendered the issue twice). Matches the
 * last non-empty line, lenient on the `Issue:` label's case/spacing but exact
 * on the reference. */
function bodyEndsWithIssue(body: string, issue: string): boolean {
  const lastLine = body.slice(body.lastIndexOf("\n") + 1).trim()
  const match = /^issue:\s*(.+)$/iu.exec(lastLine)
  return match !== null && match[1]?.trim() === issue
}

/** The head commit body plus a trailing issue reference — mirrors GitHub's
 * "closing keyword in the body" convention while yrd keeps the issue as a
 * first-class field too. Returns undefined only when neither a body nor an
 * issue exists. */
export function composeDescription(body: string | undefined, issue: string | undefined): string | undefined {
  const parts: string[] = []
  const trimmedBody = body?.trim()
  if (trimmedBody !== undefined && trimmedBody !== "") parts.push(trimmedBody)
  const trimmedIssue = issue?.trim()
  if (
    trimmedIssue !== undefined &&
    trimmedIssue !== "" &&
    (trimmedBody === undefined || !bodyEndsWithIssue(trimmedBody, trimmedIssue))
  ) {
    parts.push(`Issue: ${trimmedIssue}`)
  }
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

async function resolvedQueueTarget(ref: string, io: YrdCliIO): Promise<Readonly<{ base: string; sha?: string }>> {
  const cwd = io.cwd ?? process.cwd()
  if (io.resolveQueueTarget !== undefined) {
    const target = await io.resolveQueueTarget(ref, cwd)
    return { ...target, base: baseIdentity(target.base) }
  }
  const sha = await optionalRevision(ref, io)
  return { base: baseIdentity(ref), ...(sha === undefined ? {} : { sha }) }
}

type QueueTargetGroup = Readonly<{ base: string; aliases: ReadonlySet<string>; headSha?: string }>

async function queueTargetGroups(bases: ReadonlySet<string>, io: YrdCliIO): Promise<QueueTargetGroup[]> {
  const groups = new Map<string, { aliases: Set<string>; headSha?: string }>()
  for (const ref of [...bases].toSorted()) {
    const target = await resolvedQueueTarget(ref, io)
    const group = groups.get(target.base) ?? { aliases: new Set<string>() }
    group.aliases.add(ref)
    group.aliases.add(baseIdentity(ref))
    group.aliases.add(target.base)
    if (target.sha !== undefined) group.headSha = target.sha
    groups.set(target.base, group)
  }
  return [...groups.entries()].map(([base, group]) => ({ base, ...group }))
}

/** Effective title/description for a submit: an explicit flag wins, else a
 * value already on the PR is carried forward, else the head commit subject/body
 * (with an issue reference) seeds the default. The commit is only read when a default
 * is actually needed, so carried-forward revisions never re-derive it. */
async function resolveSubmitMetadata(
  app: YrdCliApp,
  selector: string,
  options: Readonly<{ title?: string; description?: string; issue?: string }>,
  io: YrdCliIO,
): Promise<Readonly<{ title?: string; description?: string }>> {
  const existing = app.bays.pr(selector)
  const needTitle = options.title === undefined && existing?.title === undefined
  const needDescription = options.description === undefined && existing?.description === undefined
  const issue = options.issue ?? existing?.issue
  let commit: Readonly<{ subject: string; body?: string }> | undefined
  if (needTitle || needDescription) {
    const bay = app.bays.get(selector)
    commit = await optionalCommitMeta(bay?.branch ?? existing?.branch ?? selector, io)
  }
  const title = options.title ?? existing?.title ?? commit?.subject
  const description = options.description ?? existing?.description ?? composeDescription(commit?.body, issue)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

/** One spelling of the tracking opt-in across every surface that records it. */
const TRACK_OPTION_DESCRIPTION =
  "merge into latest: the resident records, preflights, and queues later branch pushes as frozen revisions"

type PrSelectionOptions = {
  follow?: boolean
  wait?: boolean
  base?: string
  queue?: string
  issue?: string
  title?: string
  description?: string
  correlation?: string
  composition?: string
  reviewer?: readonly string[]
  track?: boolean
  keepOnFailure?: boolean
  json?: boolean
}

type PrSelectionCommand = "bay.submit" | "pr.create" | "pr.submit"
type PrSelectionResult = Readonly<{ prs: readonly PR[]; warnings: readonly string[] }>

async function applyPrSelection(
  app: YrdCliApp,
  selectors: readonly string[],
  options: PrSelectionOptions,
  io: YrdCliIO,
  command: PrSelectionCommand,
  stageAsDraft = command === "pr.create",
): Promise<PrSelectionResult> {
  const createOnly = command === "pr.create"
  const correlation = parseCorrelation(options.correlation)
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const local = currentBay(state.bays, cwd)
  const inferred = resolveSubmitSelectors(selectors, local?.id ?? currentGitBranch(cwd, io))
  const prs: PR[] = []
  // Advisory warnings for submissions that SUCCEED with a caveat (e.g. a dirty
  // worktree — D3). Collected from the bay operation and rendered in the result
  // envelope, matching the queue list/status `warnings` shape.
  const warnings: string[] = []
  const base = oneBaseOfAliases(state, options.base, options.queue, "base", "queue")
  const composition = await readComposition(options.composition, io)
  if (composition !== undefined && inferred.length !== 1) {
    usage("--composition requires exactly one bay or branch selector")
  }
  const reviewers = options.reviewer ?? []
  for (const selector of inferred) {
    const selectedBay = app.bays.get(selector)
    const previous = app.bays.pr(selectedBay?.branch ?? selector)
    if (createOnly) {
      const delivery = previous === undefined ? undefined : prDeliveryState(previous)
      if (previous !== undefined && delivery !== "pushed" && delivery !== "rejected") {
        refusal(`PR '${previous.id}' is already ${delivery}; create is only for a draft PR`)
      }
    }
    const metadata = await resolveSubmitMetadata(app, selector, options, io)
    // Internal compatibility seam: `draft` means emit `pr/pushed` without
    // `pr/submitted`; it is deliberately not part of either submit CLI.
    let pr = await app.bays.submitSelection(selector, {
      ...(base === undefined ? {} : { base }),
      ...(options.issue === undefined ? {} : { issue: options.issue }),
      ...(metadata.title === undefined ? {} : { title: metadata.title }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(options.track === true ? { track: true } : {}),
      ...(stageAsDraft ? { draft: true } : {}),
      ...(correlation === undefined ? {} : { correlation }),
      ...(composition === undefined ? {} : { composition }),
      resolveRevision: (ref) => optionalRevision(ref, io),
      run: runtimeOptions(io),
      warnings,
    })
    if (previous !== undefined) {
      const priorRevision = currentPRRev(previous)
      const currentRevision = currentPRRev(pr)
      if (priorRevision.n !== currentRevision.n || priorRevision.head !== currentRevision.head) {
        await app.queue.cancelAdmissionJobs({
          pr: previous.id,
          revision: priorRevision.n,
          by: io.runner ?? "operator",
          reason: `a newer submit superseded revision ${priorRevision.n}`,
        })
      }
    }
    const delivery = prDeliveryState(pr)
    if (createOnly && delivery !== "pushed") {
      refusal(`PR '${pr.id}' is already ${delivery}; create is only for a draft PR`)
    }
    if (reviewers.length > 0 && delivery !== "integrated" && delivery !== "already-landed") {
      await app.bays.requestReview({
        pr: pr.id,
        reviewers: [...reviewers],
        ...(io.runner === undefined ? {} : { by: io.runner }),
      })
      const requested = app.bays.pr(pr.id)
      if (requested === undefined) throw new Error(`yrd: PR '${pr.id}' disappeared after request-review`)
      pr = requested
    }
    prs.push(pr)
  }
  return { prs, warnings }
}

async function printPrSelectionResult(
  io: YrdCliIO,
  options: JsonOption,
  command: PrSelectionCommand,
  result: PrSelectionResult,
): Promise<void> {
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    { command, prs: result.prs.map(projectPRTaskStatus) },
    createElement(PRResultView, { prs: result.prs, runs: [] }),
    result.warnings,
  )
}

function submitRequiredCheckContexts(
  app: YrdCliApp,
  selectors: readonly string[],
  io: YrdCliIO,
): readonly Readonly<{ cwd: string; ref?: string }>[] {
  const cwd = io.cwd ?? process.cwd()
  const state = stateOf(app)
  const local = currentBay(state.bays, cwd)
  const currentBranch = currentGitBranch(cwd, io)
  const inferred = resolveSubmitSelectors(selectors, local?.id ?? currentBranch)
  return inferred.map((selector) => {
    const bay = app.bays.get(selector)
    if (bay?.path !== undefined) return { cwd: bay.path }
    const branch = app.bays.pr(selector)?.branch ?? bay?.branch ?? selector
    return branch === currentBranch ? { cwd } : { cwd, ref: branch }
  })
}

/**
 * A submit into a repository that declares `landing: none` refuses HERE, before
 * the required-check hook runs, because everything after this point is work
 * spent on a candidate nothing will ever pick up.
 *
 * The gate is the declaration and only the declaration. Refusing on a missing
 * runner instead was considered and rejected on evidence: a runner is routinely
 * absent for a moment, and every fixture in this suite runs without one, so
 * that predicate measures the fixture rather than the defect. The state of a
 * queue that has never run cannot tell you whether it ever will.
 */
async function refuseSubmitWithoutLandingAuthority(
  options: PrSelectionOptions,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<YrdCliExitCode | undefined> {
  const repo = io.cwd ?? process.cwd()
  const landing =
    landingAuthorityBoundary(services) ??
    (await loadYrdConfig({ repo, defaultBase: options.base ?? options.queue ?? "main" })).config.landing
  if (landing !== "none") return undefined
  // Both halves are load-bearing. WHICH repository, because a seat working
  // across two of them reads this message with no other clue; and that no
  // runner is coming, because "submit failed" invites a retry and a retry
  // cannot help.
  const message =
    `'${repo}' declares no landing authority (selected config 'landing: none'), so its queue has no runner and ` +
    "nothing will ever drain this merge request; merge the work through whatever authority that repository does " +
    "have, or set 'landing: expected' once a runner exists"
  if (jsonEnabled(options)) {
    io.stderr(
      stableJson({
        command: "pr.submit",
        repo,
        failure: { kind: "refusal", code: "no-landing-authority", message },
      }),
    )
    return 1
  }
  refusal(message)
}

async function applyPrSelectionVerb(
  app: YrdCliApp,
  services: YrdCliServices,
  selectors: readonly string[],
  options: PrSelectionOptions,
  io: YrdCliIO,
  command: PrSelectionCommand,
): Promise<YrdCliExitCode> {
  if (command === "pr.submit") {
    const unlandable = await refuseSubmitWithoutLandingAuthority(options, io, services)
    if (unlandable !== undefined) return unlandable
    for (const context of submitRequiredCheckContexts(app, selectors, io)) {
      await runRequiredChecks(
        services,
        { ...io, cwd: context.cwd },
        undefined,
        context.ref,
        options.keepOnFailure === true,
      )
    }
    const staged = await applyPrSelection(app, selectors, options, io, command, true)
    for (const pr of staged.prs) {
      const refusalExit = await requireQueueableSubmodulePinsForCommand(pr, services, options, io)
      if (refusalExit !== undefined) return refusalExit
    }
  }
  const result = await applyPrSelection(app, selectors, options, io, command)
  const prs = [...result.prs]
  const warnings = [...result.warnings]
  const createOnly = command === "pr.create"
  // `pr.create` is the only record-only selection verb. `bay.submit` is a
  // synchronous handoff: it must continue into the check-request loop below,
  // so a submitted carrier never waits for unrelated Queue activity to start.
  if (createOnly) {
    await printPrSelectionResult(io, options, command, result)
    return 0
  }
  // Q1 — a same-head resubmit of a landed branch returns the frozen landed PR
  // (integrated or equivalence-proven already-landed, exit 0). It is not checkable and must not be admitted;
  // surface the informational note in the result envelope and drain only the
  // live submissions.
  for (const pr of prs) {
    if (prDeliveryState(pr) === "integrated") {
      warnings.push(
        `already merged as PR '${pr.id}'${pr.integration === undefined ? "" : ` (${pr.integration.commit})`}`,
      )
    } else if (prDeliveryState(pr) === "already-landed") {
      warnings.push(
        `already merged as PR '${pr.id}'${pr.integration === undefined ? "" : ` (${pr.integration.baseSha})`}`,
      )
    }
  }
  const checkable = prs.filter((pr) => {
    const delivery = prDeliveryState(pr)
    return delivery === "pushed" || delivery === "submitted" || delivery === "ready"
  })
  for (const pr of checkable) {
    const refusalExit = await requireQueueableSubmodulePinsForCommand(pr, services, options, io)
    if (refusalExit !== undefined) return refusalExit
  }
  for (const pr of checkable) await app.bays.requestChecks({ pr: pr.id })
  const selected = checkable.map((pr) => pr.id)
  if (selected.length === 0) {
    await printResult(
      io,
      jsonEnabled(options),
      { command, prs: prs.map(projectPRTaskStatus), ...(warnings.length > 0 ? { warnings } : {}) },
      createElement(PRResultView, { prs, runs: [] }),
    )
    return 0
  }
  const currentPrs = selected.map((selector) => requiredPr(app, selector))
  const current = currentPrs.map((pr) => ({ pr, eligibility: app.queue.eligibility(pr.id) }))
  await printResult(
    io,
    jsonEnabled(options),
    {
      command,
      prs: current.map(({ pr, eligibility }) => {
        return {
          ...projectPrTaskStatusWithEligibility(pr, eligibility),
          eligibility: projectEligibilityTaskStatus(eligibility),
        }
      }),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    createElement(PRResultView, {
      prs: currentPrs,
      runs: [],
      eligibilities: current.map(({ eligibility }) => eligibility),
      now: io.now?.() ?? Date.now(),
    }),
  )
  return 0
}

async function readComposition(path: string | undefined, io: YrdCliIO): Promise<CompositionV1 | undefined> {
  if (path === undefined) return undefined
  const absolute = resolve(io.cwd ?? process.cwd(), path)
  try {
    return CompositionV1Schema.parse(JSON.parse(await readFile(absolute, "utf8")))
  } catch (cause) {
    usage(
      `invalid composition manifest '${path}': ${cause instanceof Error ? cause.message : String(cause)}; ` +
        "provide version 1 with normalized repo-relative payload paths",
    )
  }
}

function requiredPr(app: YrdCliApp, selector: string): PR {
  return app.bays.pr(selector) ?? requireLivePR(stateOf(app).bays, selector)
}

type PRLandingOutcome =
  | Readonly<{
      outcome: "landed"
      status: "integrated"
      landingSha: string
      baseSha: string
      at: string
      run?: string
    }>
  | Readonly<{
      outcome: "already-landed"
      status: "already-landed"
      baseSha: string
      candidateSha: string
      candidateTreeSha: string
      baseTreeSha: string
      at: string
      run?: string
    }>
  | Readonly<{ outcome: "not-landed"; status: Exclude<PRDeliveryState, "integrated" | "already-landed"> }>

function prLandingOutcome(pr: DeepReadonly<PR>): PRLandingOutcome {
  const delivery = prDeliveryState(pr)
  if (delivery === "already-landed") {
    const hasRunProof = pr.terminalRun !== undefined
    const hasRefreshProof = pr.alreadyLanded?.settlement !== undefined
    if (
      pr.integration === undefined ||
      pr.alreadyLanded === undefined ||
      pr.alreadyLandedAt === undefined ||
      hasRunProof === hasRefreshProof
    ) {
      refusal(`PR '${pr.id}' is recorded as already merged but is missing its canonical equivalence proof`)
    }
    return {
      outcome: "already-landed",
      status: "already-landed",
      baseSha: pr.integration.baseSha,
      candidateSha: pr.alreadyLanded.candidateSha,
      candidateTreeSha: pr.alreadyLanded.candidateTreeSha,
      baseTreeSha: pr.alreadyLanded.baseTreeSha,
      at: pr.alreadyLandedAt,
      ...(pr.terminalRun === undefined ? {} : { run: pr.terminalRun }),
    }
  }
  if (delivery !== "integrated") return { outcome: "not-landed", status: delivery }
  if (pr.integration === undefined || pr.integratedAt === undefined) {
    refusal(`integrated PR '${pr.id}' is missing canonical landing proof`)
  }
  return {
    outcome: "landed",
    status: "integrated",
    landingSha: pr.integration.commit,
    baseSha: pr.integration.baseSha,
    at: pr.integratedAt,
    ...(pr.terminalRun === undefined ? {} : { run: pr.terminalRun }),
  }
}

function allQueueRuns(app: YrdCliApp): Run[] {
  return Queues.ids(stateOf(app).queues)
    .map((id) => app.queue.get(id))
    .filter((run): run is Run => run !== undefined)
    .toSorted(byQueueRunChronology)
}

function prQueueRuns(app: YrdCliApp, pr: PR): Run[] {
  return allQueueRuns(app).filter((run) => run.prs.some((member) => member.id === pr.id))
}

function sameIssueIntegratedCompositions(app: YrdCliApp, pr: PR): readonly CompositionV1[] | undefined {
  if (pr.issue === undefined) return undefined
  const integrated = new Set(
    app.bays
      .prs()
      .filter(
        (candidate) =>
          candidate.id !== pr.id &&
          candidate.issue === pr.issue &&
          (prDeliveryState(candidate) === "integrated" || prDeliveryState(candidate) === "already-landed"),
      )
      .map((candidate) => candidate.id),
  )
  const compositions = allQueueRuns(app)
    .filter(
      (run) => Queues.succeeded(run) && run.prs.length > 0 && run.prs.every((member) => integrated.has(member.id)),
    )
    .toReversed()
    .flatMap((run) => {
      const rewrites = run.integration?.sourceRewrites
      if (rewrites === undefined || rewrites.length === 0) return []
      return [
        CompositionV1Schema.parse({
          version: 1,
          sources: rewrites.map((rewrite) => ({
            repo: rewrite.repo,
            branch: rewrite.candidateRef,
            baseSha: rewrite.newBaseSha,
            tipSha: rewrite.newTipSha,
            payload: rewrite.payload,
          })),
        }),
      ]
    })
  return compositions.length === 0 ? undefined : compositions
}

async function listBays(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ all?: boolean; check?: boolean; closed?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.all === true && options.closed === true) usage("--all and --closed are mutually exclusive")
  const allBays = app.bays.list()
  const statuses = new Map(
    allBays.map((bay) => [
      bay.id,
      bay.closure?.kind === "closed-degenerate" ? ("fail" as const) : lifecycleStatus(bay.status),
    ]),
  )
  const isTerminal = (bay: DeepReadonly<Bay>): boolean => {
    const status = statuses.get(bay.id)
    return status === "done" || status === "fail"
  }
  const bays =
    options.all === true
      ? allBays
      : options.closed === true
        ? allBays.filter(isTerminal)
        : allBays.filter((bay) => !isTerminal(bay))
  const visibleBayIds = new Set(bays.map((bay) => bay.id))
  const prs = app.bays.prs()
  const jsonBays = bays.map((bay) => {
    const pr =
      prs.findLast((candidate) => candidate.bay === bay.id) ??
      prs.findLast((candidate) => candidate.branch === bay.branch)
    return {
      ...bay,
      nativeStatus: bay.status,
      status: statuses.get(bay.id),
      ...(pr === undefined ? {} : { pr: { id: pr.id, status: prDeliveryState(pr) } }),
    }
  })
  const open = bays.filter((bay) => !isTerminal(bay))
  const cwd = io.cwd ?? process.cwd()
  let reports: BayStatusReport[] | undefined
  if (options.check === true) {
    const remoteTrackingFresh = refreshBayStatusOrigin(cwd)
    const protections = activeBayProtections(io)
    reports = open.map((bay) =>
      classifyBayStatus(
        gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now()),
      ),
    )
  }
  const safety =
    reports === undefined
      ? undefined
      : new Map(
          reports.map((report) => [
            report.bay,
            report.exit === 0 ? ("safe" as const) : report.exit === 1 ? ("blocked" as const) : ("unknown" as const),
          ]),
        )
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "bay.list",
      bays: jsonBays,
      lifecycles: app.bays.branchLifecycles().filter((lifecycle) => visibleBayIds.has(lifecycle.bay)),
      ...(reports === undefined ? {} : { reports }),
    },
    createElement(BayStatusView, {
      bays,
      statuses,
      ...(safety === undefined ? {} : { safety }),
    }),
  )
}

function pathBay(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): void {
  const bay = resolveBay(stateOf(app).bays, selector)
  if (bay === undefined) refusal(`no bay '${selector}'; run 'yrd bay' to list available Bays`)
  if (bay.status !== "active") {
    refusal(
      `bay '${bay.id}' is ${bay.status}; expected an active bay; ` + "run 'yrd bay open --bay <name>' to create one",
    )
  }
  if (bay.path === undefined || !isAbsolute(bay.path)) {
    refusal(`bay '${bay.id}' has no absolute workspace path; run 'yrd bay --json' to inspect it before recreating it`)
  }
  const projection = { command: "bay.path", bay: bay.id, path: bay.path }
  io.stdout(jsonEnabled(options) ? stableJson(projection) : `${bay.path}\n`)
}

const PR_LIST_DEFAULT_WINDOW_SIZE = 20

/** Bounded default `pr list` selection: open PRs claim window slots first
 * (newest open wins when opens alone exceed the window), the remaining budget
 * goes to the newest terminal rows. Input order (oldest-first by id) is
 * preserved in the output. */
function prListRetainedRows<T extends Readonly<{ id: string; state: string }>>(
  matching: readonly T[],
  window: number,
): readonly T[] {
  if (matching.length <= window) return matching
  const open = matching.filter((pr) => pr.state === "open")
  const kept = new Set(open.slice(-window).map((pr) => pr.id))
  let historyBudget = window - kept.size
  for (let index = matching.length - 1; index >= 0 && historyBudget > 0; index -= 1) {
    const pr = matching[index]
    if (pr === undefined || pr.state === "open") continue
    kept.add(pr.id)
    historyBudget -= 1
  }
  return matching.filter((pr) => kept.has(pr.id))
}

async function listPrs(
  app: YrdCliApp,
  options: JsonOption &
    Readonly<{ base?: string; state?: string; issue?: string; needsReview?: boolean; reviewer?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reviewer !== undefined && options.needsReview !== true) usage("--reviewer requires --needs-review")
  const state = stateOf(app)
  const base = options.base === undefined ? undefined : selectedBase(state, options.base)
  const explicitlyFiltered =
    options.base !== undefined ||
    options.state !== undefined ||
    options.issue !== undefined ||
    options.needsReview === true ||
    options.reviewer !== undefined
  const matching = app.bays
    .prs()
    .filter((pr) => base === undefined || baseIdentity(pr.base) === base)
    .filter((pr) => options.issue === undefined || pr.issue === options.issue)
    .toSorted((left, right) => compareNatural(left.id, right.id))
  const json = jsonEnabled(options)
  // Preserve the bounded human default before deriving eligibility. A state
  // filter must inspect every candidate because `needs-author` is projected
  // from eligibility; an unfiltered human list only needs its final 20 rows.
  // Open PRs take priority within the window: live work outside the newest-20
  // cut (a days-old draft) must not vanish from the default surface (live
  // specimen 2026-08-07: PR138/PR182, both `pushed`, invisible by default).
  // The window itself still binds so the human list stays bounded; when open
  // PRs alone exceed it the newest ones win and the residue line discloses.
  const listed = explicitlyFiltered || json ? matching : prListRetainedRows(matching, PR_LIST_DEFAULT_WINDOW_SIZE)
  const rows = listed
    .map((pr) => ({
      pr,
      eligibility: app.queue.eligibility(pr.id),
      needsReview: app.bays.needsReview(pr.id, options.reviewer),
    }))
    .filter(
      ({ pr, eligibility }) =>
        options.state === undefined ||
        projectedPrStatus(pr, eligibility) === options.state ||
        prDeliveryState(pr) === options.state ||
        // v1 clients used `rejected` as the only author-fix bucket. Keep that
        // filter as a read-compatible superset while every returned row tells
        // the truth with native `status: needs-author`.
        (options.state === "rejected" && projectedPrStatus(pr, eligibility) === "needs-author"),
    )
    .filter(({ pr, eligibility, needsReview }) =>
      options.needsReview === true
        ? options.reviewer !== undefined
          ? needsReview
          : needsReview ||
            ((prDeliveryState(pr) === "pushed" ||
              prDeliveryState(pr) === "submitted" ||
              prDeliveryState(pr) === "ready") &&
              eligibility.review.required &&
              !eligibility.review.approved)
        : true,
    )
  const selected = new Set(rows.map(({ pr }) => pr.id))
  const runs = allQueueRuns(app).filter((run) => run.prs.some((member) => selected.has(member.id)))
  const { landings, warnings } = await reconcilePrLandings(
    rows.map(({ pr }) => pr),
    io,
  )
  const publicationWarnings = rows.flatMap(({ pr }) => {
    const publication = projectPublication(publicationJob(app, pr))
    return publication === undefined || publication.status === "published"
      ? []
      : [`${pr.id} ${publication.status}: ${publication.detail} (Job ${publication.job})`]
  })
  await printResultWithWarnings(
    io,
    json,
    {
      command: "pr.list",
      prs: rows.map(({ pr, eligibility, needsReview }) => {
        const publication = projectPublication(publicationJob(app, pr))
        return {
          ...projectPrTaskStatusWithEligibility(pr, eligibility, landings.get(pr.id)),
          eligibility: projectEligibilityTaskStatus(eligibility),
          requestedReviewers: pr.requestedReviewers ?? [],
          needsReview,
          ...(publication === undefined ? {} : { publication }),
        }
      }),
      runs: runs.map(projectQueueRunTaskStatus),
    },
    createElement(PRListView, {
      rows: prListRows(rows, runs, io.now?.() ?? Date.now(), landings),
      columns: io.columns ?? 120,
      window: { hidden: matching.length - listed.length, total: matching.length },
    }),
    [...warnings, ...publicationWarnings],
  )
}

async function viewPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
  services: YrdCliServices,
  command = "pr.view",
): Promise<void> {
  const pr = requiredPr(app, selector)
  const state = stateOf(app)
  const target = resolveQueueTargets(state, [pr.id], undefined, pr.id)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  const delivery = prDeliveryState(pr)
  const positions =
    delivery === "submitted" || delivery === "ready" ? await queuedPrPositions(app, pr.base, io) : undefined
  const position = positions?.get(pr.id)
  const runs = prQueueRuns(app, pr)
  const attempts = await queueAttempts(services)
  const detail = prDetailData(pr, runs, attempts)
  const eligibility = app.queue.eligibility(pr.id)
  const publication = projectPublication(publicationJob(app, pr))
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    {
      command,
      pr: projectPrTaskStatusWithEligibility(pr, eligibility),
      eligibility: projectEligibilityTaskStatus(eligibility),
      landing: prLandingOutcome(pr),
      ...(position === undefined ? {} : { position }),
      results: results.map(projectQueueStatusResultTaskStatus),
      detail,
      ...(publication === undefined ? {} : { publication }),
    },
    createElement(PRDetailView, {
      pr,
      eligibility,
      runs,
      attempts,
      now: io.now?.() ?? Date.now(),
      ...(position === undefined ? {} : { position }),
    }),
    publication === undefined || publication.status === "published"
      ? []
      : [`${pr.id} ${publication.status}: ${publication.detail} (Job ${publication.job})`],
  )
}

async function viewPrRuns(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<void> {
  for (let read = 0; read < 3; read += 1) {
    const snapshot = await app.journalSnapshot()
    let pr = resolvePR(snapshot.state.bays, selector)
    if (pr === undefined) {
      const confirmed = await app.journalSnapshot()
      if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
      pr = requireLivePR(snapshot.state.bays, selector)
    }
    const runs = prQueueRuns(app, pr)
    const attempts = await queueAttempts(services)
    const confirmed = await app.journalSnapshot()
    if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
    const eligibility = app.queue.eligibility(pr.id, snapshot.state)
    const data = {
      pr,
      eligibility,
      runs: runs.map((run) => queueShowData(run, runs, attempts, runRevisionClock(pr, run), prDeliveryState(pr))),
    }
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "pr.runs",
        pr: projectPrTaskStatusWithEligibility(pr, eligibility),
        eligibility: projectEligibilityTaskStatus(eligibility),
        runs: data.runs,
        ...trackerBridges(app, snapshot, ({ pr: id }) => id === pr.id),
      },
      createElement(PRRunsView, { data }),
    )
    return
  }
  refusal(
    `journal changed while reading PR '${selector}' runs; retry with 'yrd pr runs ${selector}${jsonEnabled(options) ? " --json" : ""}'`,
  )
}

async function diffPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ stat?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const pr = requiredPr(app, selector)
  const cwd = io.cwd ?? process.cwd()
  const base = prBaseSha(pr) ?? pr.base
  let diff: string
  try {
    diff = gitSync(cwd, ["diff", ...(options.stat === true ? ["--stat"] : []), `${base}...${prHead(pr)}`, "--"])
  } catch (error) {
    refusal(`cannot diff PR '${pr.id}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const composition = prComposition(pr)
  const rendered =
    composition === undefined
      ? diff
      : [
          "Source composition (the Queue generates the root gitlink wrapper):",
          ...composition.sources.flatMap((source) => [
            `  ${source.repo} ${source.branch} ${source.baseSha.slice(0, 12)}..${source.tipSha.slice(0, 12)}`,
            ...source.payload.map((path) => `    ${path}`),
          ]),
          "",
          "Root diff:",
          diff === "" ? "  (none before Candidate construction)" : diff,
        ].join("\n")
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.diff",
      pr: pr.id,
      base,
      head: prHead(pr),
      ...(composition === undefined ? {} : { composition }),
      diff,
    },
    rendered,
  )
}

async function checkoutPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ bay?: string }>,
  io: YrdCliIO,
): Promise<void> {
  const pr = requiredPr(app, selector)
  const name = options.bay ?? `pr-${pr.id.toLowerCase()}`
  // PR checkout is immutable inspection: authors normally keep the branch checked
  // out in their own Bay, while its recorded revision remains safe to materialize detached.
  const head = prHead(pr)
  await provisionBay(
    app,
    name,
    {
      from: head,
      expectedHead: head,
      base: pr.base,
      ...(pr.issue === undefined ? {} : { issue: pr.issue }),
      ...options,
    },
    io,
    "pr.checkout",
    pr.id,
  )
}

function currentGitBranch(cwd: string, io: YrdCliIO): string | undefined {
  const injected = io.currentBranch?.(cwd)
  if (injected !== undefined) return injected
  try {
    const branch = gitSync(cwd, ["branch", "--show-current"]).trim()
    return branch === "" ? undefined : branch
  } catch (error) {
    if (isGitTimeoutError(error)) throw error
    return undefined
  }
}

function currentPr(app: YrdCliApp, io: YrdCliIO): PR {
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr =
    (bay === undefined ? undefined : Object.values(state.bays.prs).find((candidate) => candidate.bay === bay.id)) ??
    Object.values(state.bays.prs).find((candidate) => candidate.branch === branch)
  if (pr === undefined) refusal("the current bay or branch has no PR; submit it with 'yrd pr submit'")
  return pr as PR
}

async function queuedPrPosition(app: YrdCliApp, pr: PR, io: YrdCliIO): Promise<number | undefined> {
  const delivery = prDeliveryState(pr)
  if (delivery !== "submitted" && delivery !== "ready") return undefined
  return (await queuedPrPositions(app, pr.base, io)).get(pr.id)
}

async function queuedPrPositions(app: YrdCliApp, base: string, io: YrdCliIO): Promise<ReadonlyMap<string, number>> {
  const state = stateOf(app)
  const prs = Object.values(state.bays.prs)
  const groups = await queueTargetGroups(new Set(prs.map((candidate) => candidate.base)), io)
  const group = groups.find((candidate) => candidate.aliases.has(base))
  if (group === undefined) throw new Error(`yrd: queue target group for base '${base}' disappeared`)
  const candidates = new Set(
    prs.filter((candidate) => group.aliases.has(candidate.base)).map((candidate) => candidate.id),
  )
  const ordered = app.queue.admissionOrder().filter((id) => candidates.has(id))
  return new Map(ordered.map((id, index) => [id, index + 1]))
}

async function statusPr(app: YrdCliApp, options: JsonOption, io: YrdCliIO, services: YrdCliServices): Promise<void> {
  const pr = currentPr(app, io)
  await viewPr(app, pr.id, options, io, services, "pr.status")
}

async function editPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption &
    Readonly<{
      issue?: string
      note?: string
      title?: string
      description?: string
      track?: boolean
      untrack?: boolean
    }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.track === true && options.untrack === true) usage("pr edit takes --track or --untrack, not both")
  const track = options.track === true ? true : options.untrack === true ? false : undefined
  if (
    options.issue === undefined &&
    options.note === undefined &&
    options.title === undefined &&
    options.description === undefined &&
    track === undefined
  ) {
    usage("pr edit requires --issue, --note, --title, --description, --track, or --untrack")
  }
  const pr = requiredPr(app, selector)
  await app.bays.editPr({
    pr: pr.id,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(track === undefined ? {} : { track }),
  })
  const edited = requiredPr(app, pr.id)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.edit", pr: projectPRTaskStatus(edited) },
    createElement(PRResultView, { prs: [edited], runs: prQueueRuns(app, edited) }),
  )
}

type PrRegressionOptions = JsonOption &
  Readonly<{
    run: string
    detectedAt: string
    severity: PRRegressionSeverity
    evidence: string
    implementationRun: string
    review: string
    repairPr: string
    repairRun: string
  }>

type PRRegressionFact = Omit<PRRegression, "recordedAt">

async function recordPrRegression(
  app: YrdCliApp,
  selector: string,
  options: PrRegressionOptions,
  io: YrdCliIO,
): Promise<void> {
  const result = await app.bays.recordRegression({
    pr: selector,
    run: options.run,
    detectedAt: options.detectedAt,
    severity: options.severity,
    evidence: options.evidence,
    implementationRunRef: options.implementationRun,
    reviewRef: options.review,
    repairPr: options.repairPr,
    repairRun: options.repairRun,
  })
  if (
    result.value === undefined ||
    result.value === null ||
    typeof result.value !== "object" ||
    Array.isArray(result.value)
  ) {
    throw new Error("yrd: regression command returned no completed outcome")
  }
  const regression = result.value as unknown as PRRegressionFact
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.regression", regression },
    `Recorded ${regression.severity} escaped regression for ${regression.pr}; repaired by ${regression.repairPr}.`,
  )
}

function prFact(pr: DeepReadonly<PR>): Readonly<{
  id: string
  branch: string
  base: string
  revision: number
  headSha: string
  baseSha?: string
}> {
  const revision = currentPRRev(pr)
  return {
    id: pr.id,
    branch: pr.branch,
    base: pr.base,
    revision: revision.n,
    headSha: revision.head,
    ...(revision.baseSha === undefined ? {} : { baseSha: revision.baseSha }),
  }
}

function selectedCheckPRs(app: YrdCliApp, selectors: readonly string[]): PR[] {
  // Was a hand-rolled `no PR '<selector>'`, a third spelling of a fact the bay
  // model already words. Routing through requiredPr keeps ONE not-found
  // message, so the searched-count reaches every surface instead of the one
  // that happened to be fixed.
  return selectors.map((selector) => requiredPr(app, selector))
}

function prCheckRecords(app: YrdCliApp, selectors: readonly string[]): PRCheckViewRecord[] {
  selectedCheckPRs(app, selectors)
  return [...app.queue.checks(selectors)]
}

function issueRows(app: YrdCliApp, state: DeepReadonly<YrdCliState>, selected?: string): IssueLensRow[] {
  const contests = app.contests.list()
  const refs = new Set<string>()
  for (const bay of Object.values(state.bays.byId)) if (bay.issue !== undefined) refs.add(bay.issue)
  for (const pr of Object.values(state.bays.prs)) if (pr.issue !== undefined) refs.add(pr.issue)
  for (const contest of contests) refs.add(`${contest.issue.ref.source}:${contest.issue.ref.id}`)
  if (selected !== undefined && !refs.has(selected)) refusal(`no issue '${selected}' is in flight`)
  return [...refs]
    .filter((issue) => selected === undefined || issue === selected)
    .toSorted()
    .map((issue) => {
      const bays = Object.values(state.bays.byId).filter((bay) => bay.issue === issue)
      const bayIds = new Set(bays.map((bay) => bay.id))
      const prs = Object.values(state.bays.prs).filter(
        (pr) => pr.issue === issue || (pr.bay !== undefined && bayIds.has(pr.bay)),
      )
      const joinedContests = contests.filter(
        (contest) => `${contest.issue.ref.source}:${contest.issue.ref.id}` === issue,
      )
      const taskStatus = issueTaskStatusOf({ prs, contests: joinedContests })
      return {
        issue,
        ...taskStatusFields(taskStatus),
        bays: bays.map((bay) => bay.id).join(",") || "-",
        prs: prs.map((pr) => pr.id).join(",") || "-",
        contests: joinedContests.map((contest) => contest.id).join(",") || "-",
        outcome:
          [...prs.map((pr) => prDeliveryState(pr)), ...joinedContests.map((contest) => contest.status)].join(",") ||
          "in-flight",
      }
    })
}

async function ensureIssueDelivery(
  app: YrdCliApp,
  issue: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  await app.issues.resolve(app.issues.ref(issue))
  const opened = await prepareResolvedIssueBay(app, issue, io, { reuseActive: true })
  const draft = await ensureIssueDraft(app, issue, opened.identity.branch, io, {
    track: true,
  })
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    {
      command: "issue.ensure",
      issue,
      bay: opened.bay,
      pr: projectPRTaskStatus(draft.pr),
    },
    `issue ${issue} → bay ${opened.bay.id} ${opened.identity.branch} → tracked draft ${draft.pr.id}`,
    draft.warnings,
  )
  return 0
}

async function listIssues(app: YrdCliApp, options: JsonOption, io: YrdCliIO, selected?: string): Promise<void> {
  for (let read = 0; read < 3; read += 1) {
    const snapshot = await app.journalSnapshot()
    const issues = issueRows(app, snapshot.state, selected)
    const bridges = trackerBridges(app, snapshot, ({ issueRef }) => selected === undefined || issueRef === selected)
    const confirmed = await app.journalSnapshot()
    if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: selected === undefined ? "issue.list" : "issue.view",
        issues,
        ...bridges,
      },
      createElement(IssueLensView, {
        rows: issues,
        ...(selected === undefined ? {} : { deliveries: issueDeliveryRows(bridges.trackerBridgeV2) }),
      }),
    )
    return
  }
  refusal(
    `journal changed while reading issues; retry with 'yrd issue${selected === undefined ? "" : ` view ${selected}`}${jsonEnabled(options) ? " --json" : ""}'`,
  )
}

type RuntimeGlobalOptions = Readonly<{
  repo?: string
  config?: string
  verbose?: number
  quiet?: number
  logLevel?: string
}>

function resolveRuntimeContext(globals: RuntimeGlobalOptions, bootstrap: RuntimeBootstrap): YrdContext {
  return resolveYrdContext(globals, bootstrap.env, bootstrap.ambientCwd)
}

async function runQueues(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown },
  io: YrdCliIO,
): Promise<readonly Run[]> {
  const steps = csv(options.steps)
  await app.queue.expirePauses(new Date(io.now?.() ?? Date.now()).toISOString())
  return app.queue.run(
    {
      prs: [...selectors],
      ...(steps === undefined ? {} : { steps }),
    },
    runtimeOptions(io),
  )
}

function queuedPublicationJobs(app: YrdCliApp): readonly Job[] {
  return Object.values(stateOf(app).jobs.byId).filter(
    (job) => job.definition === "pr.publish" && job.status === "queued",
  )
}

async function preparePublicationQueueCycle(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
): Promise<readonly Job[]> {
  const queued = queuedPublicationJobs(app)
  const executed =
    queued.length === 0
      ? []
      : await runJobs(
          app,
          queued.map((job) => job.id),
          io,
        )
  const successful = Object.values(stateOf(app).jobs.byId).filter(
    (job) => job.definition === "pr.publish" && job.status === "completed" && job.conclusion === "success",
  )
  for (const job of successful) {
    const input = PrPublicationInputSchema.parse(job.input)
    if (input.continuation !== "queue") continue
    const pr = app.bays.pr(input.pr)
    if (pr === undefined || prDeliveryState(pr) !== "pushed") continue
    const revision = currentPRRev(pr)
    if (revision.n !== input.revision || revision.head !== input.headSha) continue
    await executeRecutPr(
      app,
      services,
      pr.id,
      {
        queue: true,
        expectedCurrent: { revision: input.revision, headSha: input.headSha, ...(pr.track ? { track: true } : {}) },
      },
      io,
    )
  }
  return executed
}

/** Root `yrd cancel <selector>` — stop the CURRENT ATTEMPT (chief ruling,
 * I23): resolve a merge-request selector to its running or waiting run and
 * cancel that run; members re-queue and the merge request stays open. Cancel
 * never withdraws — "stop delivering this" is `mr close --reason`; run both
 * for both effects. A run selector passes through unchanged. */
async function cancelAttempt(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ reason?: string }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const pr = app.bays.pr(selector)
  if (pr !== undefined) {
    const summary = app.queue.status(pr.base)
    const active = [...summary.running, ...summary.waiting].find((run) => run.prs.some((member) => member.id === pr.id))
    if (active === undefined) {
      raiseFailure(
        "refusal",
        "no-active-attempt",
        `yrd: merge request '${pr.id}' has no running or waiting attempt to cancel; to stop delivering it, use 'yrd mr close --reason'`,
      )
    }
    return cancelQueueRun(app, active.id, options, io)
  }
  return cancelQueueRun(app, selector, options, io)
}

async function cancelQueueRun(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ reason?: string }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.reason?.trim() === "") usage("--reason requires text")
  const run = await app.queue.cancelRun({
    run: requireUnqualifiedRunSelector(selector),
    by: io.runner ?? "operator",
    reason: options.reason ?? "run canceled by operator",
  })
  // A canceled run is NOT rejected: its member PRs stay submitted and re-queue on
  // a future drain. State that in the human summary so the distinction is legible.
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.cancel", run: projectQueueRunTaskStatus(run) },
    `${run.id} canceled; ${run.prs.length} PR(s) re-queued (submitted), not rejected`,
  )
  return 0
}

async function pauseQueue(
  app: YrdCliApp,
  base: string | undefined,
  options: JsonOption & Readonly<{ reason?: unknown; allow?: unknown; for?: unknown }>,
  io: YrdCliIO,
): Promise<void> {
  if (typeof options.reason !== "string" || options.reason.trim() === "") usage("--reason requires text")
  if (typeof options.for !== "string") usage("--for must be a positive duration such as 30m, 6h, or 1d")
  const ttlMs = parseDurationMs(options.for, "--for", true)
  const target = await resolvedQueueTarget(selectedBase(stateOf(app), base ?? "main"), io)
  const pause = await app.queue.pause({
    base: target.base,
    reason: options.reason,
    allowedPRs: csv(options.allow) ?? [],
    expiresAt: new Date((io.now?.() ?? Date.now()) + ttlMs).toISOString(),
  })
  const allowed = pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(", ")
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.pause", pause },
    `Queue ${pause.base} paused: ${pause.reason} (allowed: ${allowed})`,
  )
}

async function recoverQueue(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption & Readonly<{ reason?: string; runner?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reason?.trim() === "") usage("--reason requires text")
  if (options.runner?.trim() === "") usage("--runner requires a runner id")
  // With `--runner` the operator asserts that runner is dead: recover force-settles
  // its running Jobs regardless of lease expiry, so a fresh (unexpired) ghost from a
  // known-dead runner clears immediately instead of waiting the lease out. Without
  // it, recover settles only leases that have already lapsed.
  const runs = await app.queue.recover({
    recoveryTime: new Date(io.now?.() ?? Date.now()).toISOString(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  })
  const findings = await queueAuditFindings(app, services)
  const blocked = admissionBlockedPrs(app)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "queue.recover",
      results: runs.map(projectQueueRunTaskStatus),
      ...(blocked.length === 0
        ? {}
        : {
            blocked: blocked.map(({ pr, eligibility }) => ({
              pr: projectPrTaskStatusWithEligibility(pr, eligibility),
              eligibility: projectEligibilityTaskStatus(eligibility),
            })),
          }),
    },
    createElement(QueueRecoveryView, { runs, findings, blocked }),
  )
}

async function queueAuditFindings(
  app: Pick<YrdCliApp, "queue">,
  services: YrdCliServices,
  now?: string,
): Promise<readonly QueueAuditFinding[]> {
  const core = app.queue.audit(now === undefined ? undefined : { now })
  const environment = await services.queue?.auditEnvironment?.()
  return [...core.findings, ...(environment?.findings ?? [])]
}

function admissionBlockedPrs(
  app: YrdCliApp,
  selectedPrIds?: ReadonlySet<string>,
): Array<Readonly<{ pr: PR; eligibility: PREligibility }>> {
  return Object.values(stateOf(app).bays.prs)
    .filter((pr) => {
      const delivery = prDeliveryState(pr)
      return (
        (selectedPrIds === undefined || selectedPrIds.has(pr.id)) &&
        (delivery === "submitted" || delivery === "ready" || delivery === "needs-author")
      )
    })
    .map((pr) => ({ pr, eligibility: app.queue.eligibility(pr.id) }))
    .filter(({ eligibility }) => eligibility.reason?.code === "admission-refused")
    .toSorted((left, right) => compareNatural(left.pr.id, right.pr.id))
}

async function migrateTerminalAssociations(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ apply?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  let plan
  if (options.apply === true) {
    plan = await app.queue.migrateTerminalAssociations()
  } else {
    await app.refresh()
    plan = app.queue.terminalAssociationPlan()
  }
  const mode = options.apply === true ? "apply" : "dry-run"
  const rows = plan.rows.map((row) =>
    row.status === "ready" ? row : { ...row, refusal: { ...row.refusal, ...actionableFailure(row.refusal) } },
  )
  const human =
    rows.length === 0
      ? `No unprojectable legacy PR terminals; ${mode} appended ${plan.summary.appended}.`
      : [
          ...rows.map((row) =>
            row.status === "ready"
              ? `READY ${row.terminal.pr} revision ${row.terminal.revision}@${row.terminal.headSha} -> ${row.association.run} (${row.terminal.event})`
              : `BLOCKED ${row.terminal.pr} revision ${row.terminal.revision}\n${formatActionableFailure(row.refusal)}`,
          ),
          `${mode}: ${plan.summary.ready} ready, ${plan.summary.refused} blocked, ${plan.summary.appended} appended`,
        ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "migrate.terminal-associations", mode, ...plan, rows }, human)
  return plan.summary.refused === 0 ? 0 : 1
}

async function resumeQueue(app: YrdCliApp, base: string | undefined, options: JsonOption, io: YrdCliIO): Promise<void> {
  const target = await resolvedQueueTarget(selectedBase(stateOf(app), base ?? "main"), io)
  await app.queue.resume(target.base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.resume", base: target.base },
    `Queue ${target.base} resumed`,
  )
}

async function renderDashboard(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = resolveQueueTargets(state, selectors, undefined, undefined)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    { command: "dashboard", results: results.map(projectQueueStatusResultTaskStatus) },
    createElement(QueueStatusView, {
      state: state.bays,
      results,
      selected: target.selected,
      now: io.now?.() ?? Date.now(),
    }),
    queuePauseWarnings(state.bays, results),
  )
}

async function queueStatusSnapshots(
  app: YrdCliApp,
  state: YrdCliState,
  target: { bases: Set<string>; selected: Set<string>; prFilter: string | undefined },
  io: YrdCliIO,
): Promise<{ results: readonly QueueStatusResult[] }> {
  if (target.selected.size === 0 && target.bases.size === 0) {
    for (const pr of Object.values(state.bays.prs)) target.bases.add(pr.base)
    for (const run of Queues.values(state.queues)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  const results: QueueStatusResult[] = []
  const admissionOrder = app.queue.admissionOrder()
  for (const group of await queueTargetGroups(target.bases, io)) {
    const canonical = app.queue.status(group.base)
    const aliases = [...group.aliases].filter((base) => base !== group.base).map((base) => app.queue.status(base))
    const runs = mergedQueueRuns(canonical, aliases)
    const scopeRun = (run: Run): Run[] => {
      if (target.selected.size === 0) return [run]
      const prs = run.prs.filter((member) => target.selected.has(member.id))
      return prs.length === 0 ? [] : [{ ...run, prs }]
    }
    const scopedRuns = {
      running: runs.running.flatMap(scopeRun),
      waiting: runs.waiting.flatMap(scopeRun),
      finished: runs.finished.flatMap(scopeRun),
    }
    const groupPrs = Object.values(state.bays.prs).filter((pr) => group.aliases.has(pr.base))
    const prs = groupPrs.filter((pr) => target.selected.size === 0 || target.selected.has(pr.id))
    const prIds = new Set(prs.map((pr) => pr.id))
    const groupPrIds = new Set(groupPrs.map((pr) => pr.id))
    results.push({
      base: group.base,
      ...scopedRuns,
      ...(canonical.pause === undefined ? {} : { pause: canonical.pause }),
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs,
      admissionOrder: admissionOrder.filter((pr) => groupPrIds.has(pr)),
      candidates: Object.values(state.queues.candidates).filter((candidate) =>
        candidate.revs.some((revision) => prIds.has(revision.pr)),
      ),
      eligibilities: prs.map((pr) => app.queue.eligibility(pr.id)),
    })
  }
  return { results }
}

function queueBases(state: YrdCliState): string[] {
  return [
    ...new Set([
      ...Object.values(state.bays.prs).map((pr) => baseIdentity(pr.base)),
      ...Queues.values(state.queues).map((run) => baseIdentity(run.base)),
    ]),
  ].toSorted()
}

type QueueListSnapshot = QueueWatchSnapshot &
  Readonly<{ projection: QueueTimelineProjection; state: YrdCliState["bays"] }>

function queueRunnerRefusal(app: Pick<YrdCliApp, "queue">): QueueRunnerRefusal | undefined {
  const finding = app.queue
    .audit()
    .findings.find(({ code }) => code === "step-revision-drift" || code === "step-unavailable")
  return finding === undefined ? undefined : { ...finding }
}

const QUEUE_ARTIFACT_TAIL_BYTES = 64 * 1_024

async function artifactTail(path: string): Promise<Readonly<{ text: string; truncatedBytes: number }> | undefined> {
  let file
  try {
    file = await open(path, "r")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
  try {
    const size = (await file.stat()).size
    const length = Math.min(size, QUEUE_ARTIFACT_TAIL_BYTES)
    const truncatedBytes = size - length
    const bytes = new Uint8Array(length)
    if (length > 0) await file.read(bytes, 0, length, truncatedBytes)
    return { text: new TextDecoder().decode(bytes), truncatedBytes }
  } finally {
    await file.close()
  }
}

export async function queueArtifactOutputs(
  results: readonly QueueStatusResult[],
  artifactRoot: string,
  attempts: readonly QueueAttempt[] = [],
): Promise<QueueArtifactOutput[]> {
  const outputs: QueueArtifactOutput[] = []
  const seen = new Set<string>()

  const append = async (run: string, step: string, attempt: number, path: string): Promise<boolean> => {
    const key = `${run}\0${step}\0${String(attempt)}\0${path}`
    if (seen.has(key)) return false
    const tail = await artifactTail(path)
    if (tail === undefined) return false
    seen.add(key)
    outputs.push({
      source: "recorded",
      run,
      step,
      attempt,
      path,
      text: tail.text,
      ...(tail.truncatedBytes === 0 ? {} : { truncatedBytes: tail.truncatedBytes }),
    })
    return true
  }

  const localArtifactPaths = (values: Iterable<unknown>): readonly string[] =>
    uniqueArtifacts(values).flatMap((artifact) => {
      const location = artifactLocation(artifact)
      return location !== undefined && "path" in location ? [location.path] : []
    })

  const visibleRuns = new Set(
    results.flatMap((result) => [...result.running, ...result.waiting, ...result.finished].map((run) => run.id)),
  )
  const recordedAttempts = new Set<string>()
  for (const attempt of attempts) {
    if (!visibleRuns.has(attempt.run)) continue
    recordedAttempts.add(`${attempt.run}\0${String(attempt.index)}\0${String(attempt.attempt)}`)
    const combined = join(
      artifactRoot,
      attempt.run,
      `${attempt.index}-${attempt.step}`,
      `attempt-${attempt.attempt}`,
      "output.log",
    )
    if (await append(attempt.run, attempt.step, attempt.attempt, combined)) continue
    if (attempt.result.status === "lost") continue
    const artifacts = [
      ...directArtifacts(attempt.result.output),
      ...(attempt.result.status === "failed" ? nestedArtifacts(attempt.result.error.evidence) : []),
    ]
    for (const path of localArtifactPaths(artifacts)) {
      await append(attempt.run, attempt.step, attempt.attempt, path)
    }
  }

  for (const result of results) {
    for (const run of [...result.running, ...result.waiting, ...result.finished]) {
      for (const [index, step] of run.steps.entries()) {
        const job = step.job
        if (job === undefined) continue
        const attempt = job.attempt
        if (recordedAttempts.has(`${run.id}\0${String(index)}\0${String(attempt)}`)) continue
        const path = join(artifactRoot, run.id, `${index}-${step.name}`, `attempt-${attempt}`, "output.log")
        if (await append(run.id, step.name, attempt, path)) continue
        const artifacts = [
          ...directArtifacts(job),
          ...("output" in job ? directArtifacts(job.output) : []),
          ...(job.status === "completed" && job.conclusion === "failure" ? nestedArtifacts(job.error.evidence) : []),
        ]
        for (const artifactPath of localArtifactPaths(artifacts)) {
          await append(run.id, step.name, attempt, artifactPath)
        }
      }
    }
  }
  return outputs
}

function queuePrDiffSource(pr: PR, revision: number): Readonly<{ base: string; headSha: string }> | undefined {
  const revisionRecord = pr.revs.find((candidate) => candidate.n === revision)
  const isCurrent = revision === prRevisionNumber(pr)
  const headSha = isCurrent ? prHead(pr) : revisionRecord?.head
  if (headSha === undefined) return undefined
  const base = isCurrent
    ? (prBaseSha(pr) ?? revisionRecord?.baseSha ?? pr.base)
    : (revisionRecord?.baseSha ?? revisionRecord?.base)
  return base === undefined ? undefined : { base, headSha }
}

function queuePrDiffResult(pr: PR, revision: number, numstat: string, patch: string): QueuePrDiff {
  const rows = numstat.split("\0").filter((row) => row !== "")
  let additions = 0
  let deletions = 0
  const files: string[] = []
  for (const row of rows) {
    const [added = "-", deleted = "-", ...pathParts] = row.split("\t")
    const addedCount = Number(added)
    const deletedCount = Number(deleted)
    if (Number.isFinite(addedCount)) additions += addedCount
    if (Number.isFinite(deletedCount)) deletions += deletedCount
    const path = pathParts.join("\t")
    if (path !== "") files.push(path)
  }
  return { pr: pr.id, revision, additions, deletions, files, patch }
}

/** Resolve a revision-bound PR delta for the watch detail's PR overview. */
export function queuePrDiff(cwd: string, pr: PR, revision = prRevisionNumber(pr)): QueuePrDiff {
  const source = queuePrDiffSource(pr, revision)
  if (source === undefined) return { pr: pr.id, revision, unavailable: "refs-pruned" }
  // Missing objects are the one recoverable absence state. Validate the
  // repository outside this catch so environment/corruption failures never
  // masquerade as ordinary ref pruning.
  gitSync(cwd, ["rev-parse", "--git-dir"])
  try {
    gitSync(cwd, ["cat-file", "-e", `${source.base}^{commit}`])
    gitSync(cwd, ["cat-file", "-e", `${source.headSha}^{commit}`])
  } catch (error) {
    if (isGitTimeoutError(error)) throw error
    return { pr: pr.id, revision, unavailable: "refs-pruned" }
  }
  const range = `${source.base}...${source.headSha}`
  const numstat = gitSync(cwd, ["diff", "--numstat", "--no-renames", "-z", range, "--"])
  const patch = gitSync(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "--no-renames",
    range,
    "--",
  ])
  return queuePrDiffResult(pr, revision, numstat, patch)
}

async function queuePrDiffAsync(cwd: string, pr: PR, revision: number, runGit: QueueGitRunner): Promise<QueuePrDiff> {
  const source = queuePrDiffSource(pr, revision)
  if (source === undefined) return { pr: pr.id, revision, unavailable: "refs-pruned" }
  await runGit(cwd, ["rev-parse", "--git-dir"])
  try {
    await runGit(cwd, ["cat-file", "-e", `${source.base}^{commit}`])
    await runGit(cwd, ["cat-file", "-e", `${source.headSha}^{commit}`])
  } catch (error) {
    if (isGitTimeoutError(error)) throw error
    return { pr: pr.id, revision, unavailable: "refs-pruned" }
  }
  const range = `${source.base}...${source.headSha}`
  const [numstat, patch] = await Promise.all([
    runGit(cwd, ["diff", "--numstat", "--no-renames", "-z", range, "--"]),
    runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--no-renames", range, "--"]),
  ])
  return queuePrDiffResult(pr, revision, numstat, patch)
}

type QueuePrDiffResolver = Readonly<{
  resolve(cwd: string, pr: PR, revision: number, now?: number): Promise<QueuePrDiff>
}>

function requiredQueueReadModel(services: Pick<YrdCliServices, "queueReadModel">): QueueReadModel {
  if (services.queueReadModel !== undefined) return services.queueReadModel
  throw new Error(
    "yrd: missing required YrdCliServices.queueReadModel.snapshot capability; createYrdHost must wire createQueueReadModel",
  )
}

async function queueAttempts(services: Pick<YrdCliServices, "queueReadModel">): Promise<readonly QueueAttempt[]> {
  return (await requiredQueueReadModel(services).snapshot()).attempts
}

/** Async, focus-scoped diff resolver. Missing immutable objects are retried only
 * after a bounded window, while successful revision deltas remain stable. */
/** Entries retained by the focused-diff cache before the oldest is evicted.
 *
 * The watch pane is LONG-LIVED and every entry pins a full `git diff` patch, so
 * an uncapped cache grows for the life of the process rather than with the work
 * on screen. Measured on a live pane at 11h uptime (@yrd/cli/22258): ~1 GB RSS
 * against 149 MB for a fresh process on identical inputs, burning 17-22.7% CPU
 * with ZERO journal events — retention is the defect and the CPU is the garbage
 * collector walking the live set. The cap is generous because re-fetching a
 * diff the operator scrolls back to is cheap and correctness never depends on a
 * hit; a bounded cache that occasionally misses beats an unbounded one that
 * never does.
 */
const QUEUE_PR_DIFF_CACHE_MAX = 256

export function createQueuePrDiffResolver(
  options: Readonly<{ runGit?: QueueGitRunner; negativeTtlMs?: number; maxEntries?: number }> = {},
): QueuePrDiffResolver {
  const runGit = options.runGit ?? gitAsync
  const negativeTtlMs = options.negativeTtlMs ?? 30_000
  const maxEntries = Math.max(1, options.maxEntries ?? QUEUE_PR_DIFF_CACHE_MAX)
  const resolved = new Map<string, QueuePrDiff>()
  const retryAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<QueuePrDiff>>()
  /** Evict least-recently-used keys. Map iterates in insertion order, and every
   * hit re-inserts, so the first key is always the coldest. */
  const evictOverflow = (): void => {
    while (resolved.size > maxEntries) {
      const coldest = resolved.keys().next()
      if (coldest.done === true) return
      resolved.delete(coldest.value)
      retryAt.delete(coldest.value)
    }
  }

  return {
    async resolve(cwd, pr, revision, now = Date.now()) {
      const source = queuePrDiffSource(pr, revision)
      if (source === undefined) return { pr: pr.id, revision, unavailable: "refs-pruned" }
      const key = `${cwd}\0${pr.id}\0${String(revision)}\0${source.base}\0${source.headSha}`
      const cached = resolved.get(key)
      const retry = retryAt.get(key)
      if (cached !== undefined && (retry === undefined || now < retry)) {
        // Re-insert so recency, not first-seen order, decides what is evicted.
        resolved.delete(key)
        resolved.set(key, cached)
        return cached
      }
      const running = inFlight.get(key)
      if (running !== undefined) return running

      const pending = queuePrDiffAsync(cwd, pr, revision, runGit)
        .catch((error): QueuePrDiff => {
          if (isGitTimeoutError(error)) throw error
          return { pr: pr.id, revision, unavailable: "git-error" }
        })
        .then((diff) => {
          if (!("unavailable" in diff) || diff.unavailable === "refs-pruned") {
            resolved.set(key, diff)
            if ("unavailable" in diff) retryAt.set(key, now + negativeTtlMs)
            else retryAt.delete(key)
            evictOverflow()
          }
          return diff
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
      return pending
    },
  }
}

type QueueListObservation = Readonly<{
  state: YrdCliState
  stateSource: "journal" | "memory"
  cursor: number
  generation: number
  attempts: readonly QueueAttempt[]
  runner: QueueTimelineRunner | null
  runnerToken: string
  runnerStateToken: string
  runnerProjectionToken: string
  now: number
  readFailure?: QueueReadFailure
}>

function queueRunnerToken(runner: QueueTimelineRunner | null): string {
  return runner === null
    ? "none"
    : JSON.stringify([
        runner.pid,
        runner.startedAt,
        runner.lastTickAt,
        runner.command ?? null,
        runner.implementationSource ?? null,
        runner.exitedAt ?? null,
        runner.clean ?? null,
      ])
}

function queueRunnerStateToken(runner: QueueTimelineRunner | null): string {
  return runner === null
    ? "none"
    : JSON.stringify([
        runner.pid,
        runner.startedAt,
        runner.command ?? null,
        runner.implementationSource ?? null,
        runner.exitedAt ?? null,
        runner.clean ?? null,
      ])
}

/** Runner facts that change chrome without invalidating durable queue facts.
 * Heartbeat time is deliberately excluded; queueProgress is not. */
function queueRunnerProjectionToken(runner: QueueTimelineRunner | null): string {
  return JSON.stringify([queueRunnerStateToken(runner), runner?.queueProgress ?? null, runner?.driver ?? null])
}

async function observeQueueList(
  app: YrdCliApp,
  io: YrdCliIO,
  readModel: QueueReadModel,
  previous?: QueueListObservation,
): Promise<QueueListObservation> {
  let read = await readModel.snapshot()
  let state: YrdCliState | undefined
  let stateSource: QueueListObservation["stateSource"] | undefined
  let readFailure: QueueReadFailure | undefined
  let journalCursor = read.cursor
  for (let sample = 0; sample < 3; sample += 1) {
    if (previous !== undefined && read.cursor === previous.cursor) {
      state = previous.state
      stateSource = "memory"
      break
    }
    const journal = await app.journalSnapshot()
    journalCursor = journal.asOf.cursor
    if (read.cursor === journalCursor) {
      state = journal.state as YrdCliState
      stateSource = "journal"
      break
    }
    if (sample < 2) {
      read = await readModel.snapshot()
      continue
    }
    state = journal.state as YrdCliState
    stateSource = "journal"
    readFailure = {
      code: "queue-read-boundary-moved",
      readCursor: read.cursor,
      journalCursor,
      showing: previous === undefined ? "bounded-partial" : "last-complete",
    }
  }
  if (state === undefined || stateSource === undefined) {
    throw new Error("yrd: queue read boundary produced no observation")
  }
  const runner = activeResidentRunner(await residentRunnerStatus(io.cwd ?? process.cwd(), io.stateDir))
  return {
    state,
    stateSource,
    cursor: readFailure === undefined ? read.cursor : journalCursor,
    generation: read.generation,
    attempts: read.attempts,
    runner,
    runnerToken: queueRunnerToken(runner),
    runnerStateToken: queueRunnerStateToken(runner),
    runnerProjectionToken: queueRunnerProjectionToken(runner),
    now: io.now?.() ?? Date.now(),
    ...(readFailure === undefined ? {} : { readFailure }),
  }
}

function narrowQueueResults(
  rows: readonly QueueStatusResult[],
  keep: (run: Readonly<{ id: string }>) => boolean,
): readonly QueueStatusResult[] {
  return rows.map((result) => ({
    ...result,
    running: result.running.filter(keep),
    waiting: result.waiting.filter(keep),
    finished: result.finished.filter(keep),
  }))
}

type QueueListSnapshotBuild = Readonly<{
  snapshot: QueueListSnapshot
  reclock(now: number): QueueTimelineProjection
}>

async function buildQueueListSnapshot(
  app: YrdCliApp,
  filters: readonly string[],
  options: QueueListOptions,
  io: YrdCliIO,
  observed: QueueListObservation,
): Promise<QueueListSnapshotBuild> {
  const { state, now, runner, attempts } = observed
  const requestedBase = options.base ?? "main"
  const target = resolveQueueTargets(state, [], options.base, options.pr)
  // An operator who named no base and no PR asked about the REPOSITORY, not
  // about `main`: every queue with work is in scope, and the view labels them
  // 1..N (user directive 2026-08-13). `queue log` has always read its targets
  // this way; the listing and watch surfaces were the outliers, and a queue
  // nobody named was simply invisible.
  if (options.base === undefined && options.pr === undefined) {
    for (const queueBase of queueBases(state)) target.bases.add(queueBase)
    if (target.bases.size === 0) target.bases.add(baseIdentity(requestedBase))
  }
  const { results } = await queueStatusSnapshots(app, state, target, io)
  // The primary queue — label 1, and the base the RUNNER/pause facts read from
  // — stays the requested (or default) one, never "whichever came back first".
  const primaryBase = baseIdentity(requestedBase)
  const base = results.some((result) => result.base === primaryBase) ? primaryBase : (results[0]?.base ?? primaryBase)
  const runnerRefusal = runner === null ? queueRunnerRefusal(app) : undefined
  const clock = createQueueTimelineProjectionClock(results, {
    now,
    windowMs: queueTimelineWindow(options.since),
    metricsWindowMs: queueMetricsWindow(options.since),
    statuses: queueTimelineStatuses(options.status),
    terms: filters,
    latest: options.latest === true,
    rowLimit: queueTimelineRowLimit(io),
    submissionTimes: queueTimelineAdmissionTimes(results),
    attempts,
    siblingBases: queueBases(state),
    base,
    state: state.bays,
    runner,
  })
  const projection = clock.projection
  // `--json` must answer the SAME question the human renderer answers. The
  // projection owns filtering (--status/--latest/filter terms), and its `rows`
  // are the full filtered set (`rowLimit` only trims what the view draws).
  const filtered =
    projection.filters.statuses.length > 0 || projection.filters.terms.length > 0 || projection.filters.latest
  const projectedRuns = new Set(projection.rows.flatMap((row) => (row.run === undefined ? [] : [row.run])))
  const filteredResults = filtered ? narrowQueueResults(results, (run) => projectedRuns.has(run.id)) : results
  return {
    snapshot: {
      repositoryRoot: io.repositoryRoot,
      results: filteredResults,
      state: state.bays,
      now,
      projection,
      ...(runnerRefusal === undefined ? {} : { runnerRefusal }),
    },
    reclock: clock.reclock,
  }
}

async function attachQueueListDetails(
  snapshot: QueueListSnapshot,
  attempts: readonly QueueAttempt[],
  io: YrdCliIO,
  focus: QueueWatchFocus | undefined,
  diffResolver: QueuePrDiffResolver,
): Promise<QueueListSnapshot> {
  const outputResults =
    focus === undefined
      ? snapshot.results
      : focus.run === undefined
        ? []
        : narrowQueueResults(snapshot.results, (run) => run.id === focus.run)
  const outputRunIds = new Set(
    outputResults.flatMap((result) => [...result.running, ...result.waiting, ...result.finished].map((run) => run.id)),
  )
  const outputAttempts = attempts.filter((attempt) => outputRunIds.has(attempt.run))
  const outputs =
    io.artifactRoot === undefined ? [] : await queueArtifactOutputs(outputResults, io.artifactRoot, outputAttempts)
  const prsById = new Map(snapshot.results.flatMap((result) => result.prs).map((pr) => [pr.id, pr] as const))
  const diffs = await (async (): Promise<readonly QueuePrDiff[]> => {
    if (focus !== undefined) {
      const focusedPr = prsById.get(focus.pr)
      if (focusedPr === undefined) return []
      return [await diffResolver.resolve(io.cwd ?? process.cwd(), focusedPr, focus.revision, snapshot.now)]
    }
    const visibleRevisions = new Map(
      snapshot.projection.rows.flatMap((row) => {
        const pr = prsById.get(row.pr)
        return pr === undefined ? [] : [[`${row.pr}:${row.revision}`, { pr, revision: row.revision }] as const]
      }),
    )
    return [...visibleRevisions.values()].map(({ pr, revision }) => {
      try {
        return queuePrDiff(io.cwd ?? process.cwd(), pr, revision)
      } catch (error) {
        if (isGitTimeoutError(error)) throw error
        return { pr: pr.id, revision, unavailable: "git-error" }
      }
    })
  })()
  const commands = Object.fromEntries(
    Object.entries(
      (
        await loadYrdConfig({
          repo: io.cwd ?? process.cwd(),
          defaultBase: snapshot.projection.base,
        })
      ).config.definitions,
    ).flatMap(([name, definition]) => (definition.run === undefined ? [] : [[name, definition.run] as const])),
  )
  return {
    ...snapshot,
    ...(outputs.length === 0 ? {} : { outputs }),
    ...(diffs.length === 0 ? {} : { diffs }),
    ...(Object.keys(commands).length === 0 ? {} : { commands }),
  }
}

export async function queueListSnapshot(
  app: YrdCliApp,
  filters: readonly string[],
  options: QueueListOptions,
  io: YrdCliIO,
  details: Readonly<{
    includeOutputs?: boolean
    focus?: QueueWatchFocus
    diffResolver?: QueuePrDiffResolver
    queueReadModel?: QueueReadModel
  }> = {},
): Promise<QueueListSnapshot> {
  const { includeOutputs = false, focus, diffResolver } = details
  const observed = await observeQueueList(app, io, requiredQueueReadModel(details))
  const built = await buildQueueListSnapshot(app, filters, options, io, observed)
  const snapshot =
    observed.readFailure === undefined ? built.snapshot : { ...built.snapshot, readFailure: observed.readFailure }
  return includeOutputs
    ? attachQueueListDetails(snapshot, observed.attempts, io, focus, diffResolver ?? createQueuePrDiffResolver())
    : snapshot
}

type QueueListSnapshotLoader = Readonly<{
  load(focus?: QueueWatchFocus): Promise<QueueListSnapshot>
}>

const QUEUE_WATCH_CLOCK_INTERVAL_MS = 60_000

function sameQueueListFocus(left: QueueWatchFocus | undefined, right: QueueWatchFocus | undefined): boolean {
  return left?.pr === right?.pr && left?.revision === right?.revision && left?.run === right?.run
}

export function createQueueListSnapshotLoader(
  app: YrdCliApp,
  filters: readonly string[],
  options: QueueListOptions,
  io: YrdCliIO,
  services: YrdCliServices,
  includeOutputs: boolean,
): QueueListSnapshotLoader {
  const queueReadModel = requiredQueueReadModel(services)
  const diffResolver = createQueuePrDiffResolver()
  const log = app.log.child("queue-read")
  let cached:
    | Readonly<{
        observed: QueueListObservation
        snapshot: QueueListSnapshot
        reclock(now: number): QueueTimelineProjection
        displayed: Readonly<{
          focus: QueueWatchFocus | undefined
          snapshot: QueueListSnapshot
        }>
      }>
    | undefined
  return {
    async load(focus) {
      const observed = await observeQueueList(app, io, queueReadModel, cached?.observed)
      if (observed.readFailure !== undefined && cached !== undefined) {
        return {
          ...cached.displayed.snapshot,
          readFailure: { ...observed.readFailure, showing: "last-complete" },
        }
      }
      const unchanged =
        cached !== undefined &&
        cached.observed.cursor === observed.cursor &&
        cached.observed.generation === observed.generation &&
        cached.observed.attempts === observed.attempts &&
        cached.observed.runnerStateToken === observed.runnerStateToken
      const clockDue =
        unchanged &&
        cached !== undefined &&
        (observed.runnerProjectionToken !== cached.observed.runnerProjectionToken ||
          observed.now < cached.snapshot.now ||
          observed.now - cached.snapshot.now >= QUEUE_WATCH_CLOCK_INTERVAL_MS)
      const stable = unchanged && !clockDue && cached !== undefined
      using span = log.span?.("snapshot", {
        cursor: observed.cursor,
        generation: observed.generation,
        state: observed.stateSource,
        projection: stable ? "stable" : unchanged ? "clock-only" : "rebuilt",
        attempts: cached?.observed.attempts === observed.attempts ? "memory" : "changed",
        runner:
          cached?.observed.runnerStateToken !== observed.runnerStateToken
            ? "changed"
            : cached.observed.runnerProjectionToken !== observed.runnerProjectionToken
              ? "progress"
              : cached.observed.runnerToken === observed.runnerToken
                ? "unchanged"
                : "heartbeat",
      })
      if (stable && cached !== undefined && sameQueueListFocus(cached.displayed.focus, focus)) {
        const current = cached
        const snapshot = current.displayed.snapshot
        cached = { ...current, observed }
        if (span) {
          Object.assign(span.spanData, {
            results: snapshot.results.length,
            rows: snapshot.projection.rows.length,
            timeStatsFacts: snapshot.projection.timeStatsFacts.length,
          })
        }
        return snapshot
      }
      const baseBuilt: QueueListSnapshotBuild =
        unchanged && cached !== undefined
          ? {
              snapshot: {
                ...cached.snapshot,
                now: observed.now,
                projection: {
                  ...cached.reclock(observed.now),
                  runner: observed.runner,
                },
              },
              reclock: cached.reclock,
            }
          : await buildQueueListSnapshot(app, filters, options, io, observed)
      const built: QueueListSnapshotBuild =
        observed.readFailure === undefined
          ? baseBuilt
          : { ...baseBuilt, snapshot: { ...baseBuilt.snapshot, readFailure: observed.readFailure } }
      const { snapshot } = built
      const displayed =
        includeOutputs && focus !== undefined
          ? await attachQueueListDetails(snapshot, observed.attempts, io, focus, diffResolver)
          : snapshot
      if (observed.readFailure !== undefined) return displayed
      cached = {
        observed,
        ...built,
        displayed: { focus, snapshot: displayed },
      }
      if (span) {
        Object.assign(span.spanData, {
          results: displayed.results.length,
          rows: displayed.projection.rows.length,
          timeStatsFacts: displayed.projection.timeStatsFacts.length,
        })
      }
      return displayed
    },
  }
}

async function listQueues(
  app: YrdCliApp,
  filters: readonly string[],
  options: QueueListOptions,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<void> {
  const snapshot = await createQueueListSnapshotLoader(app, filters, options, io, services, false).load()
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    {
      command: "queue.list",
      projection: snapshot.projection,
      results: snapshot.results.map(projectQueueStatusResultTaskStatus),
      ...(snapshot.readFailure === undefined ? {} : { readFailure: snapshot.readFailure }),
    },
    createElement(QueueTimelineView, {
      repositoryRoot: snapshot.repositoryRoot,
      projection: snapshot.projection,
      runnerRefusal: snapshot.runnerRefusal,
      results: snapshot.results,
      state: snapshot.state,
      columns: io.columns ?? 120,
    }),
    [
      ...queuePauseWarnings(snapshot.state, snapshot.results),
      ...(snapshot.readFailure === undefined ? [] : [queueReadFailureMessage(snapshot.readFailure)]),
    ],
  )
}

async function dashboard(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string }>,
  io: YrdCliIO,
): Promise<void> {
  await renderDashboard(app, options.base === undefined ? [] : [options.base], options, io)
}

async function primeYrd(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr = Object.values(state.bays.prs).find(
    (candidate) => (bay !== undefined && candidate.bay === bay.id) || candidate.branch === branch,
  )
  const queue = pr === undefined ? undefined : app.queue.status(pr.base)
  const briefing = {
    model: "issue -> bay -> pr -> queue -> integrated or parked for author",
    loop: [
      "yrd pr submit",
      "yrd pr status",
      "yrd pr runs <PR>",
      "fix the branch and push; the same PR resumes automatically",
    ],
    live: {
      bay: bay?.id,
      pr: pr?.id,
      base: pr?.base ?? bay?.base,
      position: pr === undefined ? undefined : await queuedPrPosition(app, pr, io),
      pause: queue?.pause,
    },
    boundaries: [
      "the queue is the only merger",
      "the tracker owns issue content; issue ensure creates only Git delivery facts",
    ],
    json: "add --json to every read or mutation",
  }
  const live = [
    `bay=${briefing.live.bay ?? "-"}`,
    `pr=${briefing.live.pr ?? "-"}`,
    `base=${briefing.live.base ?? "-"}`,
    `position=${briefing.live.position && briefing.live.position > 0 ? briefing.live.position : "-"}`,
    `pause=${briefing.live.pause?.reason ?? "active"}`,
  ].join(" ")
  const human = [
    "Yrd delivery briefing",
    "Pick an issue -> work in a bay -> submit a PR -> the queue runs checks and merges it.",
    "Loop:",
    ...briefing.loop.map((step, index) => `${index + 1}. ${step}`),
    `Live: ${live}`,
    "The queue is the only merger; pr merge only teaches the correct next command.",
    "The tracker holds the pen; issue list/view are read-only, while issue ensure creates only Git delivery facts.",
    "Use --json for lossless machine-readable output.",
  ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "prime", ...briefing }, human)
}

type InitOptions = JsonOption & Readonly<{ dryRun?: boolean }>

type InitAction = "set" | "would-set" | "unreachable"
type InitSource = "remote" | "fallback" | "unreachable"

type InitRow = Readonly<{
  name: string
  path: string
  url?: string
  branch?: string
  source: InitSource
  action: InitAction
  note?: string
  detail?: string
}>

function initSourceLabel(row: InitRow): string {
  if (row.source === "remote") return "remote HEAD"
  if (row.source === "fallback") return "fallback → main"
  // Reduce the Git diagnostic to a single row so multi-row ls-remote stderr
  // cannot break the table row layout.
  return `unreachable: ${firstLine(row.detail ?? "unknown")}`
}

function renderInitTable(rows: readonly InitRow[]): string {
  const header = ["SUBMODULE", "BRANCH", "SOURCE"] as const
  const cells = rows.map((row) => [row.path, row.branch ?? "-", initSourceLabel(row)] as const)
  const widths = header.map((label, column) =>
    Math.max(label.length, ...cells.map((cell) => cell[column]?.length ?? 0)),
  )
  const formatRow = (cell: readonly string[]): string =>
    cell
      .map((text, column) => (column === cell.length - 1 ? text : text.padEnd(widths[column] ?? text.length)))
      .join("  ")
  return [formatRow(header), ...cells.map(formatRow)].join("\n")
}

/**
 * `yrd admin submodule init` — set `submodule.<name>.branch` for every submodule that does not
 * yet track a branch, turning it from PINNED into TRACKED so upstream motion
 * rolls the superproject. The default branch is resolved from the submodule's
 * upstream (`git ls-remote --symref … HEAD`); a reachable remote with no branch
 * HEAD takes the documented `main` fallback; an unreachable remote is listed
 * and left unset. Existing branch values are never overwritten. The edit is
 * left uncommitted for the operator to review. `--dry-run` writes nothing.
 */
async function initSubmoduleTracking(options: InitOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const dryRun = options.dryRun === true
  const json = jsonEnabled(options)
  const cwd = io.cwd ?? process.cwd()
  const root = superprojectRoot(cwd)
  if (root === undefined) {
    raiseFailure("configuration", "not-a-worktree", `yrd: '${cwd}' is not inside a Git worktree`)
  }
  const entries = readSubmoduleEntries(root)
  const unbranched = [...unbranchedSubmodules(entries)].toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  const alreadyTracking = entries.length - unbranched.length

  if (entries.length === 0) {
    await printResult(
      io,
      json,
      { command: "admin.submodule.init", dryRun, root, results: [], alreadyTracking: 0 },
      "yrd admin submodule init: no submodules declared in .gitmodules",
    )
    return 0
  }
  if (unbranched.length === 0) {
    await printResult(
      io,
      json,
      { command: "admin.submodule.init", dryRun, root, results: [], alreadyTracking },
      `yrd admin submodule init: all ${entries.length} submodule${entries.length === 1 ? "" : "s"} already track a branch`,
    )
    return 0
  }

  const superOrigin = superprojectOrigin(root)
  const resolver = io.resolveSubmoduleDefaultBranch ?? createSubmoduleBranchResolver(root)
  const rows: InitRow[] = []
  for (const submodule of unbranched) {
    rows.push(await resolveInitRow(root, superOrigin, resolver, submodule, dryRun))
  }

  const setCount = rows.filter((row) => row.action === "set").length
  const failures = rows.filter((row) => row.action === "unreachable")
  const table = renderInitTable(rows)
  const notes = rows.filter((row) => row.note !== undefined).map((row) => `note: ${row.note}`)
  const summary: string[] = []
  if (dryRun) {
    const wouldSet = rows.filter((row) => row.action === "would-set").length
    summary.push(
      `yrd admin submodule init (dry run): would set branch= for ${wouldSet} submodule${wouldSet === 1 ? "" : "s"}` +
        `${failures.length > 0 ? `, ${failures.length} unreachable` : ""}`,
    )
    summary.push("(dry run: .gitmodules not modified)")
  } else {
    summary.push(
      `yrd admin submodule init: set branch= for ${setCount} submodule${setCount === 1 ? "" : "s"}` +
        `${failures.length > 0 ? `, ${failures.length} unreachable (left unset)` : ""}`,
    )
    if (setCount > 0) {
      summary.push(
        `Review and commit the .gitmodules change: git -C ${root} add .gitmodules && ` +
          `git -C ${root} commit -m 'chore: track submodule branches'`,
      )
    }
  }
  if (alreadyTracking > 0) {
    summary.push(
      `(${alreadyTracking} submodule${alreadyTracking === 1 ? "" : "s"} already tracking a branch, unchanged)`,
    )
  }

  await printResult(
    io,
    json,
    {
      command: "admin.submodule.init",
      dryRun,
      root,
      alreadyTracking,
      results: rows,
      ...(failures.length === 0 ? {} : { failures: failures.map((row) => ({ name: row.name, detail: row.detail })) }),
    },
    [table, ...notes, ...summary].join("\n"),
  )
  // Loud but non-fatal when SOME remotes are unreachable; nonzero only when
  // EVERY submodule that needed a branch failed to resolve.
  return failures.length === unbranched.length ? 1 : 0
}

async function resolveInitRow(
  root: string,
  superOrigin: string | undefined,
  resolver: NonNullable<YrdCliIO["resolveSubmoduleDefaultBranch"]>,
  submodule: SubmoduleEntry,
  dryRun: boolean,
): Promise<InitRow> {
  const base = {
    name: submodule.name,
    path: submodule.path,
    ...(submodule.url === undefined ? {} : { url: submodule.url }),
  }
  if (submodule.url === undefined || submodule.url === "") {
    return { ...base, source: "unreachable", action: "unreachable", detail: "no url declared in .gitmodules" }
  }
  let target: string
  try {
    target = resolveSubmoduleOrigin(root, superOrigin, submodule.url)
  } catch (cause) {
    return {
      ...base,
      source: "unreachable",
      action: "unreachable",
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  }
  const resolution = await resolver(target)
  if (resolution.status === "unreachable") {
    return { ...base, source: "unreachable", action: "unreachable", detail: resolution.detail }
  }
  if (!dryRun) setSubmoduleBranch(root, submodule.name, resolution.branch)
  return {
    ...base,
    branch: resolution.branch,
    source: resolution.status === "fallback" ? "fallback" : "remote",
    action: dryRun ? "would-set" : "set",
    ...(resolution.status === "fallback" ? { note: resolution.note } : {}),
  }
}

function resolveQueueTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  filterPr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const bases = new Set<string>()
  const selected = new Set<string>()
  if (base !== undefined) bases.add(selectedBase(state, base))
  for (const selector of selectors) {
    const pr = resolvePR(state.bays, selector)
    if (pr === undefined) bases.add(selectedBase(state, selector))
    else {
      bases.add(pr.base)
      selected.add(pr.id)
    }
  }
  let canonicalFilter: string | undefined
  if (filterPr !== undefined) {
    // Same consolidation as selectedCheckPRs: one not-found message, worded by
    // the bay model, so `queue run <unknown>` reports what it searched too.
    const found = resolvePR(state.bays, filterPr) ?? requireLivePR(state.bays, filterPr)
    canonicalFilter = found.id
    selected.add(found.id)
    bases.add(found.base)
  }
  return { bases, selected, prFilter: canonicalFilter }
}

function queueLogTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  pr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const target = resolveQueueTargets(state, selectors, base, pr)
  if (selectors.length === 0 && base === undefined && pr === undefined) {
    for (const item of Object.values(state.bays.prs)) target.bases.add(item.base)
    for (const run of Queues.values(state.queues)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  return target
}

type QueueLogOptions = Readonly<{
  all?: boolean
  base?: string
  failed?: boolean
  json?: boolean
  limit?: number
  pr?: string
  since?: string
}>

type QueueLogFilterRow = Readonly<{
  outcome: string
  finishedAt?: string
  startedAt?: string
  submittedAt?: string
}>

function queueLogSinceMs(value: string): number {
  return parseDurationMs(value, "--since")
}

function filterQueueLogRows<T extends QueueLogFilterRow>(
  rows: readonly T[],
  options: QueueLogOptions,
  now: number,
): readonly T[] {
  const since = options.since === undefined ? undefined : now - queueLogSinceMs(options.since)
  const filtered = rows.filter((row) => {
    if (options.failed === true && row.outcome !== "rejected") return false
    if (since === undefined) return true
    const timestamp = row.finishedAt ?? row.startedAt ?? row.submittedAt
    return timestamp === undefined || Date.parse(timestamp) >= since
  })
  if (options.all === true) return filtered
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1) usage("--limit must be a positive integer")
  return filtered.slice(-limit)
}

const LOG_SUBJECT_RESOLVE_CONCURRENCY = 8

async function resolveQueueLogSubjects(
  rows: readonly QueueLogRow[],
  io: YrdCliIO,
): Promise<ReadonlyMap<string, string>> {
  const headShas = [...new Set(rows.map((row) => row.headSha).filter((headSha) => headSha !== "-"))]
  const subjects = new Map<string, string>()
  const cwd = io.cwd ?? process.cwd()

  for (let offset = 0; offset < headShas.length; offset += LOG_SUBJECT_RESOLVE_CONCURRENCY) {
    const resolved = await Promise.all(
      headShas.slice(offset, offset + LOG_SUBJECT_RESOLVE_CONCURRENCY).map(async (headSha) => {
        const subject =
          io.resolveCommitMeta === undefined
            ? commitSubject(cwd, headSha)
            : (await io.resolveCommitMeta(headSha, cwd))?.subject
        return [headSha, subject] as const
      }),
    )
    for (const [headSha, subject] of resolved) {
      if (subject !== undefined) subjects.set(headSha, subject)
    }
  }

  return subjects
}

async function logRuns(
  app: YrdCliApp,
  selectors: readonly string[],
  options: QueueLogOptions,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<void> {
  const state = stateOf(app)
  const target = queueLogTargets(state, selectors, options.base, options.pr)
  const history = options.all === true ? await app.queue.history() : undefined
  if (history !== undefined && selectors.length === 0 && options.base === undefined && options.pr === undefined) {
    for (const run of history) target.bases.add(run.base)
  }
  const summaries: QueueStatusResult[] = []
  const admissionOrder = app.queue.admissionOrder()
  for (const group of await queueTargetGroups(target.bases, io)) {
    const merged =
      history === undefined
        ? mergedQueueRuns(
            app.queue.status(group.base),
            [...group.aliases].filter((base) => base !== group.base).map((base) => app.queue.status(base)),
          )
        : historicalQueueRuns(history, group.aliases)
    const inScope = (run: Run) => target.selected.size === 0 || run.prs.some((member) => target.selected.has(member.id))
    const runs = {
      running: merged.running.filter(inScope),
      waiting: merged.waiting.filter(inScope),
      finished: merged.finished.filter(inScope),
    }
    const groupPrs = Object.values(state.bays.prs).filter((pr) => group.aliases.has(pr.base))
    const groupPrIds = new Set(groupPrs.map((pr) => pr.id))
    summaries.push({
      base: group.base,
      ...runs,
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: groupPrs.filter((pr) => target.selected.size === 0 || target.selected.has(pr.id)),
      admissionOrder: admissionOrder.filter((pr) => groupPrIds.has(pr)),
    })
  }
  const prStatusById = new Map<string, PRDeliveryState>(
    summaries.flatMap((result) => result.prs.map((pr) => [pr.id, prDeliveryState(pr)])),
  )
  const runIds = new Set(
    summaries.flatMap((summary) => [...summary.running, ...summary.waiting, ...summary.finished].map((run) => run.id)),
  )
  const attempts = (await queueAttempts(services)).filter((attempt) => runIds.has(attempt.run))
  const revisionClocks = queueRunRevisionClocks(
    Object.values(state.bays.prs),
    summaries.flatMap((summary) => summary.finished),
  )
  const projectedRows = queueLogRows(
    summaries,
    target.selected,
    target.prFilter,
    prStatusById,
    attempts,
    new Map(),
    revisionClocks,
  )
  const filteredRows = filterQueueLogRows(projectedRows, options, io.now?.() ?? Date.now())
  const revisionSubjects = await resolveQueueLogSubjects(filteredRows, io)
  const rows = filteredRows.map((row) => {
    const subject = revisionSubjects.get(row.headSha)
    return subject === undefined ? row : { ...row, subject }
  })
  const coverage = await queueLegacyCoverage(io.cwd ?? process.cwd(), await firstEventTimestamp(app))
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "log",
      rows,
      ...(options.all === true
        ? {
            results: summaries.map(projectQueueStatusResultTaskStatus),
            attempts: attempts.map((attempt) => ({
              ...attempt,
              ...taskStatusFields(jobAttemptTaskStatusOf(attempt)),
            })),
          }
        : {}),
      ...(coverage === undefined ? {} : { coverage }),
    },
    createElement(QueueLogView, { rows, coverage, columns: Math.min(io.columns ?? 120, 120) }),
  )
}

/** Refuse to start expensive queue Runs while the installed baseline is stale.
 * Non-drift environment findings stay audit-only; drift on EITHER audited leg
 * blocks the run — config drift with the migration remedy, runtime drift
 * (merge-queue R41b: this process's installed steps diverge from the migrated
 * baseline) with the restart remedy. */
export async function requireFreshInstalledBaseline(
  services: YrdCliServices,
  options: Readonly<{
    reloadInPlace?: Readonly<{
      base?: string
      /** Unwind the resident completely, then replace this process image. */
      request?: (finding: Readonly<{ code: "runtime-drift"; message: string }>) => never
    }>
  }> = {},
): Promise<void> {
  const administration = services.queue
  // No queue administration is wired (embedded / no-administration host) → the
  // installed-baseline gate is a legacy no-op, as before.
  if (administration === undefined) return
  // Administration IS wired but the audit capability is missing: the guard cannot
  // prove freshness, so it must fail loud rather than silently grant zero
  // staleness protection (a config change would slip past unguarded).
  if (administration.auditEnvironment === undefined) {
    configuration("queue.audit capability is not installed")
  }
  const auditDrift = async () => {
    const result = await administration.auditEnvironment?.()
    return (result?.findings ?? []).filter(
      (finding) => finding.code === "config-drift" || finding.code === "runtime-drift",
    )
  }
  const drift = await auditDrift()
  if (drift.length === 0) return
  // 22306 residual (with 22334 constraint): follow-mode may re-provision on
  // config-drift via the SAME `provision()` path as `admin queue init` — one descriptor
  // recipe, not a second revision family. That converts "landing advanced the
  // base / another seat wrote a foreign baseline" into a hiccup, not a fatal
  // resident exit. One-shot stays fail-loud (no accidental baseline rewrite).
  // Runtime-drift still fails: this process's construction-time step set is
  // wrong and needs a restart, not another baseline write.
  const reload = options.reloadInPlace
  if (
    reload !== undefined &&
    administration.provision !== undefined &&
    drift.every((finding) => finding.code === "config-drift")
  ) {
    await administration.provision(reload.base)
    const after = await auditDrift()
    if (after.length === 0) return
    const runtimeDrift = after.find(
      (finding): finding is Readonly<{ code: "runtime-drift"; message: string }> => finding.code === "runtime-drift",
    )
    if (runtimeDrift !== undefined && reload.request !== undefined) {
      reload.request(runtimeDrift)
    }
    const firstAfter = after[0]
    if (firstAfter === undefined) return
    raiseFailure("refusal", firstAfter.code, after.map((finding) => finding.message).join("\n"))
  }
  const runtimeDrift = drift.find(
    (finding): finding is Readonly<{ code: "runtime-drift"; message: string }> => finding.code === "runtime-drift",
  )
  if (reload?.request !== undefined && runtimeDrift !== undefined) {
    reload.request(runtimeDrift)
  }
  const first = drift[0]
  if (first === undefined) return
  raiseFailure("refusal", first.code, drift.map((finding) => finding.message).join("\n"))
}

class YrdRuntimeReloadRequest extends Error {
  override readonly name = "YrdRuntimeReloadRequest"

  constructor(readonly finding: Readonly<{ code: "runtime-drift"; message: string }>) {
    super(finding.message)
  }
}

/** Typed control transfer: unwind the resident heartbeat before the process
 * host closes leases/resources and performs the same-PID exec. */
export function requestYrdRuntimeReload(finding: Readonly<{ code: "runtime-drift"; message: string }>): never {
  throw new YrdRuntimeReloadRequest(finding)
}

export function isYrdRuntimeReloadRequest(error: unknown): error is YrdRuntimeReloadRequest {
  return error instanceof YrdRuntimeReloadRequest
}

async function queueAudit(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const now = new Date(io.now?.() ?? Date.now()).toISOString()
  const result = {
    findings: (await queueAuditFindings(app, services, now)).map((finding) => ({
      ...finding,
      ...actionableFailure(finding),
    })),
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.audit", ...result },
    result.findings.length === 0
      ? "queue audit clean"
      : result.findings.map((finding) => formatActionableFailure(finding)).join("\n\n"),
  )
  return result.findings.length === 0 ? 0 : 1
}

/**
 * Adapter from the CLI's git runner to the sweep's RefGit port.
 *
 * `optional` maps a non-zero exit to undefined because "this ref has no such
 * path" is a real answer to a real question. A TIMEOUT is NOT an answer — git
 * never finished asking — so it stays fatal instead of being reported as
 * "cannot say", which would quietly downgrade a stalled repository into a
 * clean-looking sweep.
 */
function sweepGit(process: Pick<Process, "run">): RefGit {
  return {
    async run(repo, args) {
      return (await runQueueGit(process, repo, args)).trim()
    },
    async optional(repo, args) {
      try {
        return (await runQueueGit(process, repo, args)).trim()
      } catch (error) {
        if (isGitTimeoutError(error)) throw error
        return undefined
      }
    },
  }
}

/** Admission is meant to happen ON the push, so a ref is only "mid-flight" for
 * minutes. Refs older than a day are history rather than work — measured, an
 * unbounded rail reports 1,546 rows on its first run and is switched off. */
const UNCARRIED_TTL_MS = 10 * 60 * 1000
const UNCARRIED_AGE_BOUND_MS = 24 * 60 * 60 * 1000

/** How often the resident recomputes the sweep. It costs seconds, so it cannot
 * ride the heartbeat; stranded work is a minutes-to-hours concern, not a
 * per-tick one. */
const UNCARRIED_SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * The resident's uncarried sweeper.
 *
 * The heartbeat writer is synchronous and the sweep is seconds of git I/O, so
 * this keeps the last OBSERVATION and refreshes it out of band. `observe()`
 * never blocks a tick and never invents a value: before the first sweep lands
 * it returns undefined, which the rail renders as "not swept" rather than 0.
 *
 * A failing sweep is deliberately NOT swallowed into a fresh-looking number —
 * the previous observation keeps its original observedAt, so a sweeper that has
 * been broken for an hour renders "as of 1h ago" and the staleness is the
 * signal. The failure is logged as well, because a rail that only degrades
 * quietly still needs someone to know why.
 */
function createUncarriedSweeper(
  app: YrdCliApp,
  io: YrdCliIO,
  base: string,
  log: Pick<YrdCliApp["log"], "warn">,
): Readonly<{ observe: () => UncarriedObservation | undefined }> {
  const cwd = io.repositoryRoot ?? io.cwd ?? globalThis.process.cwd()
  let latest: UncarriedObservation | undefined
  let inFlight = false
  let lastAttemptMs = 0

  const refresh = async (startedMs: number): Promise<void> => {
    await using sweepProcess = createProcess()
    const result = await sweepUncarriedRefs(sweepGit(sweepProcess), {
      repo: cwd,
      base,
      namespace: "refs/remotes/origin",
      authoredOnly: true,
      carriedBranches: new Set(Object.values(stateOf(app).bays.prs).map((pr) => pr.branch)),
      nowMs: startedMs,
      ttlMs: UNCARRIED_TTL_MS,
      ageBoundMs: UNCARRIED_AGE_BOUND_MS,
    })
    latest = {
      count: result.findings.length,
      scanned: result.scanned,
      missingUpdateClocks: result.missingUpdateClocks,
      // Stamped when the sweep STARTED. Stamping on completion would make a
      // slow sweep look fresher than the facts it read.
      observedAt: new Date(startedMs).toISOString(),
    }
  }

  return {
    observe: () => {
      const nowMs = new Date(io.now?.() ?? Date.now()).getTime()
      if (!inFlight && nowMs - lastAttemptMs >= UNCARRIED_SWEEP_INTERVAL_MS) {
        lastAttemptMs = nowMs
        inFlight = true
        void refresh(nowMs)
          .catch((error: unknown) => {
            log.warn?.("uncarried sweep failed; the rail will show its previous observation aging", { error })
          })
          .finally(() => {
            inFlight = false
          })
      }
      return latest
    },
  }
}

async function queueUncarried(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string; namespace?: string }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const cwd = io.cwd ?? globalThis.process.cwd()
  const base = options.base ?? "main"
  // A branch is carried if any merge request names it — including terminal
  // ones. A ref whose PR was withdrawn is not stranded work waiting to be
  // found; it is work someone already decided about.
  const carriedBranches = new Set(Object.values(stateOf(app).bays.prs).map((pr) => pr.branch))
  await using process = createProcess()
  const result = await sweepUncarriedRefs(sweepGit(process), {
    repo: cwd,
    base,
    namespace: options.namespace ?? "refs/remotes/origin",
    authoredOnly: options.namespace === undefined,
    carriedBranches,
    nowMs: new Date(io.now?.() ?? Date.now()).getTime(),
    ttlMs: UNCARRIED_TTL_MS,
    ageBoundMs: UNCARRIED_AGE_BOUND_MS,
  })

  // The counts print on BOTH paths, not just the empty one. "no uncarried refs"
  // alone cannot be told apart from a sweep that looked at nothing, and this
  // rail's whole job is to be believable when it reads zero.
  const denominator =
    `scanned ${String(result.scanned)} · ${String(result.carried)} carried · ` +
    `${String(result.outsideAgeBound)} outside the age bound · ${String(result.examined)} examined · ` +
    `${String(result.missingUpdateClocks)} refs without retained update clocks`
  const lines = result.findings.map((finding) => `${finding.ref}  ${finding.message}`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.uncarried", ...result },
    result.findings.length === 0 ? `no uncarried refs — ${denominator}` : [...lines, "", denominator].join("\n"),
  )
  return result.findings.length === 0 ? 0 : 1
}

/** Why one repository-proven landing did not become a journal index row. */
type IndexRebuildSkip = Readonly<{
  pr: string
  revision: number
  run: string
  reason: "already-indexed" | "pr-unknown" | "legacy-no-change-id" | "revision-superseded"
  detail: string
}>

type IndexRebuildReport = Readonly<{
  ref: string
  scanned: Readonly<{ records: number; merged: number; changes: number }>
  rebuilt: readonly Readonly<{ pr: string; revision: number; run: string; commit: string }>[]
  skipped: readonly IndexRebuildSkip[]
}>

/** Rebuild every missing `pr/integrated` index row from repository truth alone.
 *
 * The bulk sibling of `yrd why <selector> --repair`, with the same per-change predicate: a row is
 * only written when the record's change matches the PR's current revision exactly. Repo truth
 * cannot recreate a PR that the journal has never seen — a merge record proves a landing, not a
 * PR's existence — so those changes are reported as skipped, never silently dropped.
 */
async function rebuildIndexFromRepo(app: YrdCliApp, services: YrdCliServices): Promise<IndexRebuildReport> {
  const mergeRecords = services.mergeRecords ?? configuration("repository merge-record capability is not installed")
  const proof = await mergeRecords.all()
  if (proof.status === "repository-corrupt" || proof.status === "repository-incomplete") {
    // Same verdict `yrd why` gives the same condition: broken repository truth is not an index gap.
    configuration(`${MERGE_RECORD_REF} is ${proof.status}: ${proof.reason}`)
  }
  const records = proof.status === "proven" ? proof.records : []
  const merged = records.filter((entry) => entry.record.merge.result === "merged")

  // One PR can appear in several attempts; only its latest merged attempt describes the landing.
  const latest = new Map<string, Readonly<{ record: MergeRecordBody; change: MergeRecordBody["changes"][number] }>>()
  let changes = 0
  for (const entry of merged) {
    for (const change of entry.record.changes) {
      changes += 1
      const known = latest.get(change.pr)
      if (known !== undefined && known.record.merge.finishedAt >= entry.record.merge.finishedAt) continue
      latest.set(change.pr, { record: entry.record, change })
    }
  }

  const rebuilt: { pr: string; revision: number; run: string; commit: string }[] = []
  const skipped: IndexRebuildSkip[] = []
  for (const [prId, { record, change }] of latest) {
    const run = record.merge.id
    const skip = (reason: IndexRebuildSkip["reason"], detail: string): void => {
      skipped.push({ pr: prId, revision: change.revision, run, reason, detail })
    }
    const pr = app.bays.pr(prId)
    if (pr === undefined) {
      skip("pr-unknown", "no PR in the journal; a merge record proves a landing, not a PR's existence")
      continue
    }
    if (change.changeId === undefined) {
      skip("legacy-no-change-id", "record predates stable Change-Id identity")
      continue
    }
    const revision = currentPRRev(pr)
    if (
      change.revision !== revision.n ||
      change.submittedHead !== revision.head ||
      change.changeId !== revision.changeId
    ) {
      skip(
        "revision-superseded",
        `record covers revision ${String(change.revision)} at ${change.submittedHead}; journal is at revision ${String(revision.n)} at ${revision.head}`,
      )
      continue
    }
    const commit = record.merge.mergedCommit
    if (commit === undefined) {
      refusal(`merge-record '${run}' reports a merged result with no merged commit`)
    }
    if (prDeliveryState(pr) === "integrated" && pr.terminalRun === run && pr.integration?.commit === commit) {
      skip("already-indexed", `pr/integrated already records ${run} at ${commit}`)
      continue
    }
    await app.queue.reconcileLanding({
      pr: change.pr,
      revision: change.revision,
      headSha: change.submittedHead,
      run,
      commit,
      landingSha: commit,
      baseSha: commit,
      changeId: change.changeId,
    })
    rebuilt.push({ pr: prId, revision: change.revision, run, commit })
  }
  return {
    ref: MERGE_RECORD_REF,
    scanned: { records: records.length, merged: merged.length, changes },
    rebuilt,
    skipped,
  }
}

function indexRebuildLines(report: IndexRebuildReport): readonly string[] {
  const { records, merged, changes } = report.scanned
  const considered = report.rebuilt.length + report.skipped.length
  const lines = [
    `scanned ${String(records)} merge record${records === 1 ? "" : "s"} under ${report.ref} — ${String(merged)} merged, ${String(changes)} change${changes === 1 ? "" : "s"}`,
    `rebuilt ${String(report.rebuilt.length)} of ${String(considered)} landing${considered === 1 ? "" : "s"}`,
  ]
  for (const entry of report.rebuilt) {
    lines.push(`  REBUILT ${entry.pr} revision ${String(entry.revision)} via ${entry.run} at ${entry.commit}`)
  }
  for (const entry of report.skipped) {
    lines.push(`  SKIPPED ${entry.pr} revision ${String(entry.revision)} ${entry.reason}: ${entry.detail}`)
  }
  return lines
}

async function configDoctor(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption & Readonly<{ rebuildViews?: boolean; rebuildIndexFromRepo?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const rebuilt =
    options.rebuildViews === true
      ? await (services.journal?.rebuildViews?.() ?? configuration("journal view rebuild capability is not installed"))
      : undefined
  const indexRebuild = options.rebuildIndexFromRepo === true ? await rebuildIndexFromRepo(app, services) : undefined
  const config = services.config
  if (config === undefined) configuration("config doctor capability is not installed")
  await app.refresh()
  const state = stateOf(app)
  const findings = diagnoseYrdFlows({ prs: Object.values(state.bays.prs), runs: Queues.values(state.queues) }, config)
  const warnings = submoduleTrackingWarnings(io.cwd ?? process.cwd())
  const clean = findings.length === 0 && warnings.length === 0
  const doctorLine =
    findings.length === 0
      ? clean
        ? rebuilt === undefined
          ? "yrd doctor clean"
          : `yrd doctor rebuilt ${String(rebuilt.views)} views at cursor ${String(rebuilt.cursor)}`
        : `yrd doctor found ${String(warnings.length)} repository warning${warnings.length === 1 ? "" : "s"}`
      : findings
          .map((finding) => `${finding.severity.toUpperCase()} ${finding.code} ${finding.owner}: ${finding.message}`)
          .join("\n")
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    {
      command: "doctor",
      findings,
      ...(rebuilt === undefined ? {} : { rebuilt }),
      ...(indexRebuild === undefined ? {} : { indexRebuild }),
    },
    indexRebuild === undefined ? doctorLine : [...indexRebuildLines(indexRebuild), doctorLine].join("\n"),
    warnings,
  )
  // A landing repo truth proves but the index still cannot carry is a real gap, not a clean run.
  const unrebuilt = indexRebuild?.skipped.some((entry) => entry.reason !== "already-indexed") === true
  return clean && !unrebuilt ? 0 : 1
}

async function journalImportOrphan(
  services: YrdCliServices,
  sourcePath: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const capability = services.journal?.importOrphan
  if (capability === undefined) configuration("journal.import-orphan capability is not installed")
  const source = resolve(io.cwd ?? process.cwd(), sourcePath)
  const result = await capability(source)
  if (result.status === "live-collision") {
    const identities = result.collisions.map((collision) => `${collision.kind}:${collision.id}`).join(", ")
    refusal(`orphan import has a live journal identity collision (${identities})`)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "journal.import-orphan", source, ...result },
    result.status === "already-imported"
      ? `${result.records} orphan journal rows were already archived from ${source}`
      : `archived ${result.records} orphan journal rows from ${source}`,
  )
}

async function runRequiredChecks(
  services: YrdCliServices,
  io: YrdCliIO,
  selected?: readonly string[],
  ref?: string,
  keepOnFailure = false,
): Promise<readonly Readonly<{ name: string; exitCode: number }>[]> {
  const checks = services.checks
  if (checks === undefined) configuration("required-check capability is not installed")
  const names = selected ?? checks.names
  if (names.length === 0) return []
  await checks.install(io.cwd ?? process.cwd())
  const results: Array<Readonly<{ name: string; exitCode: number }>> = []
  for (const name of names) {
    const context =
      ref === undefined && !keepOnFailure
        ? undefined
        : {
            ...(ref === undefined ? {} : { ref }),
            ...(keepOnFailure ? { keepOnFailure: true } : {}),
          }
    const result = await checks.run(name, io.cwd ?? process.cwd(), context)
    if (result.stdout !== "") io.stdout(result.stdout)
    if (result.signal === "SIGKILL" || (result.signal === null && result.exitCode === 137)) {
      const retained =
        result.retainedWorkspace === undefined ? "" : `; ${retainedWorkspaceNote(result.retainedWorkspace)}`
      raiseFailure(
        "infrastructure",
        "required-check-infrastructure-signal",
        `yrd: required check infrastructure failed: '${name}' ended by SIGKILL (exit ${result.exitCode}) before it produced a verdict${retained}`,
      )
    }
    if (result.exitCode !== 0 || result.timedOut) {
      const outcome = result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`
      const checkDiagnostic = result.stderr.trim()
      const diagnostic = checkDiagnostic === "" ? "" : `; check stderr: ${checkDiagnostic}`
      const retained =
        result.retainedWorkspace === undefined ? "" : `; ${retainedWorkspaceNote(result.retainedWorkspace)}`
      raiseFailure(
        "refusal",
        "required-check-failed",
        `yrd: required check failed: '${name}' ${outcome}${diagnostic}${retained}`,
      )
    }
    if (result.stderr !== "") io.stderr(result.stderr)
    results.push({ name, exitCode: result.exitCode })
  }
  return results
}

async function checkRequired(
  services: YrdCliServices,
  names: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  if (names.length === 0) usage("check requires at least one configured check name")
  const checks = await runRequiredChecks(services, io, names)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "check", checks },
    `required checks passed: ${checks.map(({ name }) => name).join(", ")}`,
  )
}

async function initYrdConfig(services: YrdCliServices, options: JsonOption, io: YrdCliIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  const path = join(cwd, ".yrd.yml")
  if (existsSync(path)) refusal(`'${path}' already exists`)
  await writeFile(path, renderYrdConfigScaffold(), "utf8")
  const hook = await services.checks?.install(cwd)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "admin.init", path, ...(hook === undefined ? {} : { hook }) },
    `initialized ${path}${hook === undefined ? "" : ` and ${hook}`}`,
  )
}

async function bumpJournal(
  services: YrdCliServices,
  version: number,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const capability = services.journal?.bump
  if (capability === undefined) configuration("journal bump capability is not installed")
  const result = await capability(version)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "admin.journal.bump", ...result },
    `journal floor bumped v${String(result.from)} → v${String(result.to)}; snapshot ${result.snapshot}; restore drill passed`,
  )
}

async function queueAdministration(
  app: YrdCliApp,
  services: YrdCliServices,
  command: "init" | "deinit",
  base: string | undefined,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const action = command === "init" ? "provision" : "deprovision"
  const administration = services.queue
  const capability = administration?.[action]
  if (capability === undefined) configuration(`queue.${command} capability is not installed`)
  const selected = selectedBase(stateOf(app), base ?? "main")
  const result = await capability(selected)
  if (command === "init") await services.checks?.install(io.cwd ?? process.cwd())
  await printResult(
    io,
    jsonEnabled(options),
    { command: `queue.${command}`, base: selected, result },
    `${selected} ${command === "init" ? "initialized" : "deinitialized"}`,
  )
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 0) usage(`${label} must be a non-negative integer`)
  return value as number
}

function artifacts(values: unknown): readonly { name: string; uri: string }[] | undefined {
  const items = csv(values)
  if (items === undefined) return undefined
  return items.map((item) => {
    const separator = item.indexOf("=")
    if (separator <= 0 || separator === item.length - 1) {
      usage(`invalid --artifact '${item}'; expected name=path-or-url`)
    }
    return { name: item.slice(0, separator), uri: item.slice(separator + 1) }
  })
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function finishQueue(
  app: YrdCliApp,
  selector: string,
  options: {
    step?: string
    ok?: boolean
    fail?: boolean
    job?: string
    runner?: string
    attempt?: string
    token?: string
    detail?: string
    url?: string
    artifact?: unknown
    exitCode?: number
    durationMs?: number
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  if (options.ok === options.fail) usage("queue finish requires exactly one of --ok or --fail")
  const { job: jobId, runner, token } = options
  if (jobId === undefined || options.attempt === undefined || runner === undefined || token === undefined) {
    usage("queue finish requires --job, --runner, --attempt, and --token")
  }
  const attempt = Number(options.attempt)
  if (!Number.isSafeInteger(attempt) || attempt < 1) usage("--attempt must be a positive integer")
  const run = requireUnqualifiedRunSelector(selector)
  const revisionAdmission = app.queue.waitingAdmission(run, options.step)
  const waiting = revisionAdmission ?? app.queue.waiting(run, options.step)
  const selectedJob = waiting.step.job
  const recordedArtifacts = artifacts(options.artifact)
  const exitCode = positiveInteger(options.exitCode, "--exit-code")
  const durationMs = positiveInteger(options.durationMs, "--duration-ms")
  const evidence = {
    ...jsonRecord(selectedJob.checkpoint),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(selectedJob.artifacts === undefined && recordedArtifacts === undefined
      ? {}
      : { artifacts: [...(selectedJob.artifacts ?? []), ...(recordedArtifacts ?? [])] }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
  const completion = {
    job: jobId,
    step: waiting.step.name,
    runner,
    attempt,
    token,
    result:
      options.ok === true
        ? ({ status: "completed", conclusion: "success", output: evidence } as const)
        : ({
            status: "completed",
            conclusion: "failure",
            error: {
              code: `${waiting.step.name}-failed`,
              message: options.detail ?? `${waiting.step.name} failed externally`,
            },
            output: evidence,
          } as const),
  }
  if (revisionAdmission !== undefined) {
    await app.queue.finishAdmission(selector, completion, runtimeOptions(io))
    const pr = requiredPr(app, selector)
    const checks = prCheckRecords(app, [pr.id])
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "queue.finish",
        pr: projectPrTaskStatusWithEligibility(pr, app.queue.eligibility(pr.id)),
        checks: checks.map(projectCheckTaskStatus),
      },
      `${pr.id} ${prDeliveryState(pr)}`,
    )
    return
  }
  const resumed = await app.queue.finish(selector, completion, runtimeOptions(io))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.finish", run: projectQueueRunTaskStatus(resumed) },
    `${resumed.id} ${resumed.status}`,
  )
}

type ResidentCycleRecovery = Readonly<{
  message: string
  props: Record<string, unknown>
  busy?: Readonly<{ base: string; run: string }>
}>

type ResidentBusyWindow = Readonly<{ base: string; run: string; suppressed: number }>

/**
 * Keep one loud warning for a busy queue, then count exact repeats until the
 * queue frees (or the resident exits). Other recoveries stay one-for-one and
 * flush any pending busy summary before their own warning.
 */
function createResidentRecoveryReporter(log: YrdCliApp["log"]): Readonly<{
  report(recovery: ResidentCycleRecovery): void
  flush(): void
}> {
  let busy: ResidentBusyWindow | null = null
  const flush = (): void => {
    if (busy !== null && busy.suppressed > 0) {
      log.warn?.(`Queue ${busy.base} is still busy; skipped ${busy.suppressed} repeated messages.`, {
        action: "resident-busy-summary",
        base: busy.base,
        run: busy.run,
        suppressed: busy.suppressed,
      })
    }
    busy = null
  }
  return Object.freeze({
    report(recovery) {
      if (recovery.busy === undefined) {
        flush()
        log.warn?.(recovery.message, recovery.props)
        return
      }
      if (busy?.base === recovery.busy.base && busy.run === recovery.busy.run) {
        busy = { ...busy, suppressed: busy.suppressed + 1 }
        return
      }
      flush()
      busy = { ...recovery.busy, suppressed: 0 }
      log.warn?.(recovery.message, recovery.props)
    },
    flush,
  })
}

/**
 * Classify a mid-compose error as a losable resident-runner race worth skipping
 * this cycle for, or `undefined` to propagate (fail-loud). Narrow and typed —
 * never message-matching: a concurrent Job settlement, a peer already running
 * the queue, or a candidate PR that reached a terminal status mid-compose. Each
 * returns a single structured (loggily) warn; the resident emits no bare stderr
 * duplicate. The next cycle re-snapshots — the busy queue frees, the departed
 * PR is gone from the submitted set — so the loop makes progress on what remains.
 */
function residentCycleRecovery(error: unknown): ResidentCycleRecovery | undefined {
  if (isConcurrentSettlementConflict(error)) {
    return {
      message: "resident runner skipped a cycle lost to a concurrent Job settlement",
      props: { action: "resident-cancel-skip", job: error.jobId, status: error.actual, reason: error.message },
    }
  }
  if (isQueueRunningConflict(error)) {
    return {
      message: "resident runner deferred a cycle — the queue is already running",
      props: { action: "resident-busy-defer", base: error.base, run: error.runId, reason: error.message },
      busy: { base: error.base, run: error.runId },
    }
  }
  if (isConcurrentCheckabilityConflict(error)) {
    return {
      message: "resident runner skipped a cycle — a candidate PR left the checkable set mid-compose",
      props: { action: "resident-withdraw-skip", pr: error.prId, status: error.status, reason: error.message },
    }
  }
  // 22306 architectural belt: any remaining PR-scoped refusal that escaped the
  // per-candidate wrap is still a cycle skip, not a resident death. Covers
  // authored-gitlink / recut-certificate / pr-not-admissible and the rest of
  // the needs-author + recut-lineage composition buckets if they bubble out.
  const fact = failureFact(error)
  if (fact?.kind === "infrastructure" && fact.code === "journal-busy") {
    return {
      message: "resident runner skipped a cycle because the journal was temporarily locked",
      props: { action: "resident-journal-busy-skip", code: fact.code, reason: fact.message },
    }
  }
  if (fact !== undefined && (fact.kind === "refusal" || fact.kind === "infrastructure")) {
    const prScoped =
      fact.code === "pr-not-admissible" ||
      fact.code === "pr-not-ready" ||
      fact.code === "pr-not-found" ||
      fact.code === "command-refused" ||
      fact.code === "candidate-ref-refused" ||
      fact.code === "recut-certificate" ||
      fact.code === "authored-gitlink" ||
      fact.code === "composition-invalid" ||
      fact.code === "merge-tip-carrier" ||
      fact.code === "wrapper-mismatch" ||
      fact.code === "source-missing" ||
      fact.code === "source-lineage" ||
      fact.code === "payload-certificate" ||
      fact.code === "payload-identity" ||
      fact.code === "payload-mismatch" ||
      fact.code === "payload-overlap" ||
      fact.code === "gitlink-inspection" ||
      fact.code === "refused-path" ||
      fact.code === "refused-path-inspection" ||
      fact.code === "restack-conflict" ||
      fact.code === "restack-failed"
    if (prScoped) {
      return {
        message: "resident runner skipped a cycle lost to a per-PR failure",
        props: { action: "resident-pr-refusal-skip", code: fact.code, reason: fact.message },
      }
    }
  }
  return undefined
}

export type ResidentTrackedRevisionTransition =
  | Readonly<{
      status: "applied"
      pr: string
      branch: string
      fromRevision: number
      fromHead: string
      sourceRevision: number
      sourceHead: string
      currentRevision: number
      verdict: RecutPreflightVerdict
      recorded: boolean
    }>
  | Readonly<{
      status: "deferred"
      pr: string
      branch: string
      revision: number
      headSha: string
      code: string
      message: string
    }>
  | Readonly<{
      status: "needs-person"
      pr: string
      branch: string
      revision: number
      headSha: string
      code: "refusal-remedy-needs-withdraw"
      message: string
    }>

function trackedPreflightSettlementRef(pr: PR, revision: Pick<PRRev, "n" | "head">): string {
  return `yrd:track-preflight-needs-person:${pr.id}:${revision.n}:${revision.head}`
}

function trackedPreflightNeedsPerson(pr: PR, revision: PRRev): boolean {
  const ref = trackedPreflightSettlementRef(pr, revision)
  return pr.comments.some(
    (comment) => comment.revision === revision.n && comment.headSha === revision.head && comment.ref === ref,
  )
}

/**
 * Observe opted-in PR branches before the resident's normal base-freshness
 * pass. When a branch moved, certify the exact observed SHA directly as the
 * successor revision. The frozen SHA and expected-current fact flow through
 * preflight together, so an interrupted cycle never leaves a provisional
 * authored revision behind.
 */
export async function refreshTrackedQueueRevisions(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
): Promise<readonly ResidentTrackedRevisionTransition[]> {
  const candidates = Object.values(stateOf(app).bays.prs)
    .filter((pr) => {
      const delivery = prDeliveryState(pr)
      return pr.track === true && isLivePR(pr) && delivery !== "pushed"
    })
    .toSorted(
      (left, right) =>
        baseIdentity(left.base).localeCompare(baseIdentity(right.base)) || compareNatural(left.id, right.id),
    )
  const outcomes: ResidentTrackedRevisionTransition[] = []

  for (const candidate of candidates) {
    if (io.drainSignal?.aborted === true) break
    const before = currentPRRev(candidate)
    let classified: RecutPreflightResult | undefined
    try {
      const freshness = await requireImplicitRecutBranchFreshness(candidate, before, { queue: true }, services, io)
      const interrupted = !app.bays.checksRequested(candidate.id) && !trackedPreflightNeedsPerson(candidate, before)
      if (freshness.status === "fresh" && !interrupted) continue

      const source = freshness.status === "tracked-drift" ? before : currentPRRev(requiredPr(app, candidate.id))
      classified = await preflightRecut(
        app,
        candidate.id,
        {
          queue: true,
          ...(freshness.status === "tracked-drift"
            ? {
                revision: before.n,
                proposedHeadSha: freshness.liveHead,
                expectedCurrent: { revision: before.n, headSha: before.head, track: true },
              }
            : {}),
        },
        io,
      )
      await applyPreflightVerdict(app, services, classified, io, { track: true })
      const current = currentPRRev(requiredPr(app, candidate.id))
      const outcome: ResidentTrackedRevisionTransition = {
        status: "applied",
        pr: candidate.id,
        branch: candidate.branch,
        fromRevision: before.n,
        fromHead: before.head,
        sourceRevision: source.n,
        sourceHead: source.head,
        currentRevision: current.n,
        verdict: classified.verdict,
        recorded: freshness.status === "tracked-drift",
      }
      outcomes.push(outcome)
      app.log.info?.("Prepared the latest tracked PR revision for the merge queue's entry checks.", {
        action: "queue-track-prepared",
        ...outcome,
      })
    } catch (error) {
      const failure = failureFact(error)
      if (failure?.kind !== "refusal") throw error
      if (failure.code === "refusal-remedy-needs-withdraw") {
        if (classified === undefined) throw error
        const classifiedRevision = { n: classified.revision, head: classified.evidence.headSha }
        const currentPr = requiredPr(app, candidate.id)
        try {
          await app.bays.comment({
            pr: currentPr.id,
            by: io.runner ?? "yrd-cli",
            ref: trackedPreflightSettlementRef(currentPr, classifiedRevision),
            note: failure.message,
            expectedCurrent: {
              pr: currentPr.id,
              revision: classifiedRevision.n,
              headSha: classifiedRevision.head,
              track: true,
            },
          })
        } catch (settlementError) {
          const settlementFailure = failureFact(settlementError)
          if (settlementFailure?.kind !== "refusal" || settlementFailure.code !== "comment-current-changed") {
            throw settlementError
          }
          const outcome: ResidentTrackedRevisionTransition = {
            status: "deferred",
            pr: candidate.id,
            branch: candidate.branch,
            revision: classifiedRevision.n,
            headSha: classifiedRevision.head,
            code: settlementFailure.code,
            message: settlementFailure.message,
          }
          outcomes.push(outcome)
          app.log.info?.("Skipped settling a tracked PR preflight because the PR changed.", {
            action: "queue-track-settlement-deferred",
            ...outcome,
          })
          continue
        }
        const outcome: ResidentTrackedRevisionTransition = {
          status: "needs-person",
          pr: currentPr.id,
          branch: currentPr.branch,
          revision: classifiedRevision.n,
          headSha: classifiedRevision.head,
          code: failure.code,
          message: failure.message,
        }
        outcomes.push(outcome)
        app.log.warn?.(`Tracked PR ${currentPr.id} needs an operator decision before entry checks.`, {
          action: "queue-track-needs-person",
          ...outcome,
        })
        continue
      }
      const deferredRevision =
        classified === undefined ? before : { n: classified.revision, head: classified.evidence.headSha }
      const outcome: ResidentTrackedRevisionTransition = {
        status: "deferred",
        pr: candidate.id,
        branch: candidate.branch,
        revision: deferredRevision.n,
        headSha: deferredRevision.head,
        code: failure.code,
        message: failure.message,
      }
      outcomes.push(outcome)
      app.log.warn?.(`Could not prepare tracked PR ${candidate.id}; it remains queued for another cycle.`, {
        action: "queue-track-deferred",
        ...outcome,
      })
    }
  }
  return outcomes
}

type ResidentQueueFreshnessTransition =
  | Readonly<{
      status: "settled"
      pr: string
      revision: number
      fromBase: string | undefined
      toBase: string
      proof: "payload-already-contained"
      patchId: string
    }>
  | Readonly<{
      status: "refreshed"
      pr: string
      revision: number
      fromBase: string | undefined
      toBase: string
      headSha: string
      patchId: string
    }>
  | Readonly<{
      status: "refused"
      pr: string
      revision: number
      fromBase: string | undefined
      toBase: string
      code: string
      message: string
    }>
  | Readonly<{
      status: "deferred"
      pr: string
      revision: number
      fromBase: string | undefined
      toBase: string
      code: "recut-current-changed"
      message: string
    }>
  | Readonly<{
      status: "recovered"
      pr: string
      revision: number
      runs: readonly string[]
      jobs: readonly string[]
    }>

/**
 * Apply the admitted -> refreshed Queue transition before the resident takes
 * its next run snapshot. The transition deliberately stays inside the existing
 * serialized resident cycle: it reuses the installed recutter and journal
 * rather than starting another writer or scheduler.
 */
export async function refreshAdmittedQueueRevisions(
  app: YrdCliApp,
  services: Pick<YrdCliServices, "recut">,
  io: YrdCliIO,
): Promise<readonly ResidentQueueFreshnessTransition[]> {
  const snapshot = stateOf(app)
  const outcomes: ResidentQueueFreshnessTransition[] = []
  const interrupted = Object.values(snapshot.bays.prs).filter(
    (pr) => currentPRRev(pr).recut?.transition?.to === "refreshed",
  )
  const staleRunsByPr = new Map<string, Run[]>()
  const staleRunIds = new Set<string>()
  const staleAdmissionRevisionsByPr = new Map<string, number[]>()
  const staleJobsByPr = new Map<string, string[]>()
  for (const pr of interrupted) {
    const claim = snapshot.queues.authority.claims[pr.id]
    const revision = currentPRRev(pr)
    const staleAdmissionRevisions = pr.revs
      .map(({ n }) => n)
      .filter((candidateRevision) => candidateRevision !== revision.n)
    if (staleAdmissionRevisions.length > 0) staleAdmissionRevisionsByPr.set(pr.id, staleAdmissionRevisions)
    if (claim?.consumedBy === undefined || (claim.revision === revision.n && claim.headSha === revision.head)) {
      continue
    }
    const run = app.queue.get(claim.consumedBy)
    if (run === undefined || Queues.terminal(run)) continue
    staleRunsByPr.set(pr.id, [run])
    staleRunIds.add(run.id)
  }
  for (const run of [...staleRunIds].toSorted(compareNatural)) {
    await app.queue.cancelRun({
      run,
      by: io.runner ?? "yrd-cli",
      reason: "recover an interrupted accepted-to-refreshed transition",
    })
  }
  for (const pr of interrupted) {
    const jobIds: string[] = []
    for (const revision of staleAdmissionRevisionsByPr.get(pr.id) ?? []) {
      jobIds.push(
        ...(await app.queue.cancelAdmissionJobs({
          pr: pr.id,
          revision,
          by: io.runner ?? "yrd-cli",
          reason: "recover an interrupted accepted-to-refreshed transition",
        })),
      )
    }
    if (jobIds.length > 0) staleJobsByPr.set(pr.id, jobIds)
  }
  for (const pr of interrupted) {
    const runIds = staleRunsByPr.get(pr.id)?.map(({ id }) => id) ?? []
    const jobIds = staleJobsByPr.get(pr.id) ?? []
    if (runIds.length === 0 && jobIds.length === 0) continue
    const revision = prRevisionNumber(pr)
    outcomes.push({ status: "recovered", pr: pr.id, revision, runs: runIds, jobs: jobIds })
    app.log.info?.("Recovered an interrupted PR update.", {
      action: "queue-freshness-recovered",
      pr: pr.id,
      revision,
      runs: runIds,
      jobs: jobIds,
    })
  }
  const batches = app.queue.freshnessCandidateBatches()
  const candidatesById = new Map(Object.values(snapshot.bays.prs).map((pr) => [pr.id, pr] as const))
  const candidates = batches.flatMap((batch, batchIndex) =>
    batch.flatMap((id, index) => {
      const candidate = candidatesById.get(id)
      return candidate === undefined
        ? []
        : [{ candidate, batch: batchIndex, base: baseIdentity(candidate.base), last: index === batch.length - 1 }]
    }),
  )
  if (candidates.length === 0) return outcomes

  const groups = await queueTargetGroups(new Set(candidates.map(({ candidate }) => candidate.base)), io)
  const preparedBatches = new Set<number>()
  const preparedBases = new Set<string>()
  for (const plan of candidates) {
    if (preparedBases.has(plan.base)) continue
    const candidate = plan.candidate
    const finishBatch = (): void => {
      if (plan.last && preparedBatches.has(plan.batch)) preparedBases.add(plan.base)
    }
    const candidateRevision = currentPRRev(candidate)
    if (io.drainSignal?.aborted === true) break
    const target = groups.find(
      (group) => group.aliases.has(candidate.base) || group.aliases.has(baseIdentity(candidate.base)),
    )
    if (target?.headSha === undefined) {
      raiseFailure(
        "infrastructure",
        "queue-base-unresolved",
        `yrd: automatic recut could not resolve the merge-queue base '${candidate.base}' for PR '${candidate.id}'`,
      )
    }
    if (candidateRevision.baseSha === target.headSha) {
      preparedBatches.add(plan.batch)
      finishBatch()
      continue
    }

    try {
      const recut = await executeRecutPr(
        app,
        services,
        candidate.id,
        {
          queue: true,
          force: true,
          admit: false,
          transition: { from: "admitted", to: "refreshed" },
        },
        io,
      )
      const refreshedRevision = currentPRRev(recut.current)
      if (recut.settlement === "payload-already-contained") {
        outcomes.push({
          status: "settled",
          pr: recut.current.id,
          revision: refreshedRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: recut.result.baseSha,
          proof: recut.settlement,
          patchId: recut.result.patchId,
        })
        app.log.info?.("Settled a queued PR whose payload current main already contains.", {
          action: "queue-freshness-superseded",
          pr: recut.current.id,
          revision: refreshedRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: recut.result.baseSha,
          proof: recut.settlement,
          patchId: recut.result.patchId,
        })
        finishBatch()
        continue
      }
      outcomes.push({
        status: "refreshed",
        pr: recut.current.id,
        revision: refreshedRevision.n,
        fromBase: candidateRevision.baseSha,
        toBase: recut.result.baseSha,
        headSha: refreshedRevision.head,
        patchId: recut.result.patchId,
      })
      preparedBatches.add(plan.batch)
      app.log.info?.("Updated a queued PR to the latest base.", {
        action: "queue-freshness-refreshed",
        pr: recut.current.id,
        revision: refreshedRevision.n,
        fromBase: candidateRevision.baseSha,
        toBase: recut.result.baseSha,
        patchId: recut.result.patchId,
      })
    } catch (error) {
      const failure = failureFact(error)
      if (failure?.kind !== "refusal") throw error
      if (failure.code === "recut-current-changed") {
        outcomes.push({
          status: "deferred",
          pr: candidate.id,
          revision: candidateRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: target.headSha,
          code: "recut-current-changed",
          message: failure.message,
        })
        app.log.info?.("Skipped updating a queued PR because it changed.", {
          action: "queue-freshness-deferred",
          pr: candidate.id,
          revision: candidateRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: target.headSha,
          code: failure.code,
          reason: failure.message,
        })
        finishBatch()
        continue
      }
      const priorRefusal = stateOf(app).queues.admissionRefusals[candidate.id]
      const repeatedRefusal =
        priorRefusal?.settlement === undefined &&
        priorRefusal?.revision === candidateRevision.n &&
        priorRefusal.headSha === candidateRevision.head &&
        priorRefusal.code === failure.code &&
        priorRefusal.reason === failure.message
      try {
        await app.queue.recordAdmissionRefusal({
          pr: candidate.id,
          code: failure.code,
          kind: failure.kind,
          reason: failure.message,
        })
      } catch (ledgerError) {
        app.log.error?.("Could not journal a queued PR freshness refusal; the wedge oracle will under-count.", {
          action: "queue-freshness-refusal-unrecorded",
          pr: candidate.id,
          code: failure.code,
          reason: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        })
      }
      outcomes.push({
        status: "refused",
        pr: candidate.id,
        revision: candidateRevision.n,
        fromBase: candidateRevision.baseSha,
        toBase: target.headSha,
        code: failure.code,
        message: failure.message,
      })
      if (!repeatedRefusal) {
        app.log.warn?.(`Could not update PR ${candidate.id} to the latest base; it remains queued.`, {
          action: "queue-freshness-refused",
          pr: candidate.id,
          revision: candidateRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: target.headSha,
          code: failure.code,
          reason: failure.message,
        })
      }
    }
    finishBatch()
  }
  return outcomes
}

/** What the resident did about one wedged PR this cycle. */
export type RefusalRemedyOutcome =
  | Readonly<{
      status: "applied"
      pr: string
      revision: number
      code: string
      count: number
      /** Every command the runner ran, verbatim, in order. */
      commands: readonly string[]
      verdict: RecutPreflightVerdict
    }>
  | Readonly<{
      status: "escalated"
      pr: string
      revision: number
      code: string
      count: number
      reason: string
      /** The printed remedy the human takes — unchanged from the refusal. */
      resolution: readonly string[]
    }>
  | Readonly<{
      status: "failed"
      pr: string
      revision: number
      code: string
      count: number
      commands: readonly string[]
      failure: string
      resolution: readonly string[]
    }>

/** Re-record the branch's corrected head onto the PR — the in-process spelling
 * of the `yrd pr submit|create <branch>` step the printed remedy leads with. */
async function applyRedeliveryStep(
  app: YrdCliApp,
  services: YrdCliServices,
  step: Extract<RemedyStep, { verb: "submit" | "create" }>,
  io: YrdCliIO,
): Promise<void> {
  const warnings: string[] = []
  const submitted = await app.bays.submitSelection(step.branch, {
    ...(step.verb === "create" ? { draft: true } : {}),
    resolveRevision: (ref) => optionalRevision(ref, io),
    run: runtimeOptions(io),
    warnings,
  })
  const delivery = prDeliveryState(submitted)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") return
  await requireQueueableSubmodulePins(submitted, services, io)
  if (!app.bays.checksRequested(submitted.id)) await app.bays.requestChecks({ pr: submitted.id })
}

/** Run the exact command `yrd pr recut --preflight` printed. The verdict IS the
 * decision — this never re-parses the printed string, so the runner and the
 * human who reads the same line can never diverge. */
async function applyPreflightVerdict(
  app: YrdCliApp,
  services: YrdCliServices,
  preflight: RecutPreflightResult,
  io: YrdCliIO,
  requirements: Readonly<{ track?: true }> = {},
): Promise<void> {
  const recutExpectedCurrent = {
    revision: preflight.evidence.expectedCurrent?.revision ?? preflight.revision,
    headSha: preflight.evidence.expectedCurrent?.headSha ?? preflight.evidence.headSha,
    ...(preflight.evidence.expectedCurrent?.track === undefined
      ? {}
      : { track: preflight.evidence.expectedCurrent.track }),
    ...requirements,
  }
  const expectedCurrent = { pr: preflight.pr, ...recutExpectedCurrent }
  if (preflight.verdict === "SUBSUMED-WITHDRAW") {
    // Withdrawal ENDS a delivery, and `yrd admin pr prune` already owns unattended
    // subsumption on its own schedule. The runner's job is to unwedge the line,
    // not to retire someone's PR mid-cycle.
    raiseFailure(
      "refusal",
      "refusal-remedy-needs-withdraw",
      `yrd: PR '${preflight.pr}' preflight verdict SUBSUMED-WITHDRAW is an operator decision; run: ${preflight.next}`,
    )
  }
  if (preflight.verdict === "FRESH-NOOP") {
    await app.bays.ready({ pr: preflight.pr, expectedCurrent })
    const pr = requiredPr(app, preflight.pr)
    await requireQueueableSubmodulePins(pr, services, io)
    if (!app.bays.checksRequested(pr.id)) {
      await app.bays.requestChecks({ pr: pr.id, expectedCurrent })
    }
    await app.bays.ready({ pr: pr.id, expectedCurrent })
    return
  }
  // `admit: false` for the same reason the freshness pass uses it: the compose
  // that follows in THIS cycle owns admission. The remedy's job is to leave a
  // queueable revision behind, not to start a second admission path.
  await executeRecutPr(
    app,
    services,
    preflight.pr,
    {
      revision: preflight.revision,
      ...(preflight.evidence.proposedHeadSha === undefined
        ? {}
        : { proposedHeadSha: preflight.evidence.proposedHeadSha }),
      expectedCurrent: recutExpectedCurrent,
      queue: true,
      admit: false,
      ...(preflight.verdict === "RECUT-FORCE" ? { force: true } : {}),
    },
    io,
  )
}

async function applyRefusalRemedy(
  app: YrdCliApp,
  services: YrdCliServices,
  plan: RefusalRemedyPlan,
  steps: readonly RemedyStep[],
  commands: string[],
  io: YrdCliIO,
): Promise<RecutPreflightVerdict> {
  let verdict: RecutPreflightVerdict | undefined
  for (const step of steps) {
    commands.push(formatRemedyCommand(step))
    if (step.verb !== "recut") {
      await applyRedeliveryStep(app, services, step, io)
      continue
    }
    if (step.preflight !== true) {
      await executeRecutPr(app, services, step.pr, { queue: step.queue, force: step.force, admit: false }, io)
      continue
    }
    // The printed `--apply` command executes this exact verdict in-process, so
    // a human and the resident both consume the same preflight decision.
    const preflight = await preflightRecut(app, step.pr, { queue: step.queue }, io)
    commands.push(preflight.next)
    await applyPreflightVerdict(app, services, preflight, io)
    verdict = preflight.verdict
  }
  if (verdict === undefined) throw new Error(`yrd: PR '${plan.pr}' remedy ran no preflight step`)
  return verdict
}

/**
 * 22474 — apply the refusal remedy the queue itself printed, instead of
 * printing it and waiting for a human to apply the verdict.
 *
 * The admission/compose path refuses an authored-gitlink carrier with a message
 * that names exact intent submission. Intent declarations are an author-owned
 * judgment, not a PR mutation, so this loop settles that refusal as
 * needs-person. Mechanical code-carrier remedies still run here because a
 * successful recut produces a new revision and makes progress.
 *
 * Runs inside the existing serialized resident cycle beside
 * {@link refreshAdmittedQueueRevisions}: same installed recutter, same journal,
 * no second writer or scheduler. Applies at most one remedy per PR revision, so
 * a remedy that fails degrades to the printed refusal rather than becoming its
 * own loop; a remedy that succeeds produces a new revision, which is what makes
 * progress instead of repetition.
 */
export async function applyRefusalRemedies(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
  attempted: Set<string>,
): Promise<readonly RefusalRemedyOutcome[]> {
  const snapshot = stateOf(app)
  const outcomes: RefusalRemedyOutcome[] = []
  for (const plan of planRefusalRemedies(snapshot.queues.admissionRefusals, snapshot.bays.prs, attempted)) {
    if (io.drainSignal?.aborted === true) break
    // Recorded BEFORE the attempt. A remedy that throws must degrade to the
    // printed refusal, never re-arm itself on the next cycle.
    attempted.add(plan.key)
    // …and the revision the attempt LEAVES BEHIND. A remedy re-records the
    // branch, so a half-applied one lands the PR on a fresh revision with a
    // fresh key — without this the "once per revision" bound would be satisfied
    // by a loop that mints a new revision every cycle. The runner never
    // remedies its own output; a human's next push mints a different revision
    // again and is eligible as normal.
    const settleAttempt = (): void => {
      const current = app.bays.pr(plan.pr)
      if (current === undefined) return
      const revision = currentPRRev(current)
      attempted.add(refusalRemedyKey(current.id, revision.n, revision.head))
    }
    const identity = { pr: plan.pr, revision: plan.revision, code: plan.failure.code, count: plan.count }
    const projected = actionableFailure(plan.failure, {
      delivery: prDeliveryState(requiredPr(app, plan.pr)),
    })
    const settleNeedsPerson = async (reason: string): Promise<void> => {
      const current = app.bays.pr(plan.pr)
      const refusal = stateOf(app).queues.admissionRefusals[plan.pr]
      if (current === undefined || refusal === undefined) return
      const revision = currentPRRev(current)
      // A mechanical redelivery may already have minted a new revision and
      // cleared the old refusal. That revision is fresh evidence and must stay
      // eligible; settle only the exact revision this refusal still names.
      if (
        (refusal.revision !== undefined && refusal.revision !== revision.n) ||
        (refusal.headSha !== undefined && refusal.headSha !== revision.head)
      ) {
        return
      }
      await app.queue.settleAdmissionRefusal({
        pr: current.id,
        revision: revision.n,
        headSha: revision.head,
        disposition: "needs-person",
        reason,
      })
    }
    if (plan.remedy.kind === "judgment") {
      await settleNeedsPerson(plan.remedy.reason)
      outcomes.push({ status: "escalated", ...identity, reason: plan.remedy.reason, resolution: projected.resolution })
      app.log.warn?.(`PR ${plan.pr} needs a person: its result has no mechanical remedy.`, {
        action: "queue-refusal-escalated",
        ...identity,
        reason: plan.remedy.reason,
        resolution: projected.resolution,
        refusal: plan.failure.message,
      })
      continue
    }
    const commands: string[] = []
    try {
      const verdict = await applyRefusalRemedy(app, services, plan, plan.remedy.steps, commands, io)
      outcomes.push({ status: "applied", ...identity, commands, verdict })
      app.log.info?.(`Applied PR ${plan.pr}'s own printed remedy.`, {
        action: "queue-refusal-remedy-applied",
        ...identity,
        commands,
        verdict,
      })
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      await settleNeedsPerson(failure)
      outcomes.push({ status: "failed", ...identity, commands, failure, resolution: projected.resolution })
      app.log.warn?.(`Could not apply PR ${plan.pr}'s printed remedy; it needs a person.`, {
        action: "queue-refusal-remedy-failed",
        ...identity,
        commands,
        failure,
        resolution: projected.resolution,
      })
    } finally {
      settleAttempt()
    }
  }
  return outcomes
}

/** Reduce the live refusal ledger and this cycle's run count to the
 * poisoned-observer observation. Reads only projected state — no extra git or
 * network work on a cycle that already did none. */
function observeResidentRefusals(app: YrdCliApp, runs: number): ResidentRefusalObservation {
  const snapshot = stateOf(app)
  const refusals = Object.values(snapshot.queues.admissionRefusals).filter(
    (refusal) => refusal.settlement === undefined,
  )
  return {
    runs,
    refusals: refusals.map(({ pr, code, count }) => ({ pr, code, count })),
    heads: Object.fromEntries(
      refusals.flatMap((refusal) => {
        const pr = snapshot.bays.prs[refusal.pr]
        return pr === undefined ? [] : [[refusal.pr, currentPRRev(pr).head] as const]
      }),
    ),
  }
}

/**
 * Fold one settled cycle into the poisoned-observer window and say whether the
 * runner should restart itself (22474 specimen 3). Off (window cleared) for a
 * targeted one-shot, which has no next cycle to break out of.
 */
function residentRefusalHealth(
  app: YrdCliApp,
  stall: ResidentRefusalStall | undefined,
  runs: number,
  watching: boolean,
): Readonly<{ stall: ResidentRefusalStall | undefined; restart: boolean }> {
  if (!watching) return { stall: undefined, restart: false }
  const next = foldRefusalStall(stall, observeResidentRefusals(app, runs))
  if (next === undefined || next.cycles < RESIDENT_REFUSAL_STALL_CYCLES) return { stall: next, restart: false }
  app.log.warn?.(
    `Queue runner could not start any candidate for ${next.cycles} consecutive cycles with nothing changing; restarting.`,
    {
      action: "resident-refusal-stall-restart",
      cycles: next.cycles,
      prs: Object.keys(next.counts).toSorted(compareNatural),
      signature: next.signature,
    },
  )
  return { stall: next, restart: true }
}

/**
 * D1b — the resident's per-tick unscoped lease-expiry recovery sweep. `recover`
 * with NO runner arg settles any orphaned running Job whose lease has lapsed,
 * regardless of the runner that left it or where a run's cursor sits — the
 * automatic settle that one-shot startup reclaim (pid-scoped, last pid only) can
 * never do. Throttled by wall time (`io.now`) so a busy tick cadence cannot starve
 * or spam it; returns the timestamp to carry as the next `lastSweepAt`. Idempotent
 * and cheap when nothing lapsed. Logs a loud structured warn ONLY when it actually
 * settles something — loggily-only, since the runner's stdout is a log stream.
 */
export async function residentRecoverySweep(
  app: Pick<YrdCliApp, "queue" | "log">,
  io: Pick<YrdCliIO, "now">,
  lastSweepAt: number,
): Promise<number> {
  const sweepNow = io.now?.() ?? Date.now()
  if (sweepNow - lastSweepAt < RESIDENT_RECOVERY_SWEEP_MS) return lastSweepAt
  const settled = await app.queue.recover({
    recoveryTime: new Date(sweepNow).toISOString(),
    reason: "resident lease-expiry sweep",
  })
  if (settled.length > 0) {
    app.log.warn?.(`Stopped abandoned queue runs: ${settled.map((run) => run.id).join(", ")}.`, {
      action: "resident-recovery-sweep",
      reason: "runner lease expired",
      runs: settled.map((run) => run.id),
    })
  }
  return sweepNow
}

/**
 * Run every revision-preparation robot in the resident's single-writer cycle.
 * Ordering is load-bearing: track the authored branch first, refresh that
 * frozen revision onto the queue base second, then repair prior admission
 * refusals. The return value tells the caller whether to re-prove its installed
 * baseline before composing.
 */
function preparationBaselineChanged(before: YrdCliState, after: YrdCliState): boolean {
  if (
    before.bays !== after.bays ||
    before.jobs !== after.jobs ||
    before.contests !== after.contests ||
    before.intents !== after.intents
  ) {
    return true
  }
  const keys = Object.keys(before.queues) as (keyof YrdCliState["queues"])[]
  return keys.some((key) => key !== "admissionRefusals" && before.queues[key] !== after.queues[key])
}

async function prepareResidentQueueCycle(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
  remedied: Set<string>,
): Promise<boolean> {
  const beforePublication = stateOf(app)
  const publications = await preparePublicationQueueCycle(app, services, io)
  const publicationChanged = publications.length > 0 || preparationBaselineChanged(beforePublication, stateOf(app))
  if (services.recut === undefined) return publicationChanged
  const beforeTracking = stateOf(app)
  const tracking = await refreshTrackedQueueRevisions(app, services, io)
  const trackingChanged = preparationBaselineChanged(beforeTracking, stateOf(app))
  const beforeFreshness = stateOf(app)
  const freshness = await refreshAdmittedQueueRevisions(app, services, io)
  const freshnessChanged = preparationBaselineChanged(beforeFreshness, stateOf(app))
  const beforeRemedies = stateOf(app)
  const remedies = await applyRefusalRemedies(app, services, io, remedied)
  const remediesChanged = preparationBaselineChanged(beforeRemedies, stateOf(app))
  return (
    publicationChanged ||
    trackingChanged ||
    freshnessChanged ||
    remediesChanged ||
    tracking.some((outcome) => outcome.status === "applied") ||
    freshness.some(({ status }) => status === "refreshed" || status === "settled" || status === "recovered") ||
    remedies.some((outcome) => outcome.status === "applied")
  )
}

export async function followQueueRuns(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown; json?: boolean; interval?: number },
  io: YrdCliIO,
  gate: () => Promise<void>,
  services: YrdCliServices = {},
): Promise<YrdCliExitCode> {
  const intervalSeconds = options.interval ?? 15
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
    usage("--interval must be a positive number of seconds")
  }
  const interval = intervalSeconds * 1_000
  const scope = io.scope ?? app.scope
  const drainSignal = io.drainSignal
  const drainRequested = () => drainSignal?.aborted === true
  const resident = io.runner?.startsWith("yrd-cli:") === true
  const base = baseIdentity(services.base ?? "main")
  const recoveryReporter = createResidentRecoveryReporter(app.log)
  // Reclaim a prior resident's leases BEFORE the heartbeat overwrites status.json —
  // once it writes, the departed pid is lost. The exclusive resident lock guarantees
  // that prior resident is not concurrently running as a resident.
  if (resident) await reclaimDeadResidentRunner(app, io)
  const heartbeat = resident
    ? await startResidentRunnerHeartbeat(io, {
        queueProgress: (now) => residentQueueProgress(app, now),
        uncarried: createUncarriedSweeper(app, io, base, app.log).observe,
        driver: {
          queueId: io.driver?.queueId ?? `${resolve(io.repositoryRoot ?? io.cwd ?? process.cwd())}#${base}`,
          ...(io.driver === undefined ? {} : { epoch: io.driver.epoch }),
          lastLanded: () => residentDriverLastLanded(app, base),
        },
      })
    : undefined
  // A clean shutdown is an operator drain that finished (no in-flight work left);
  // any other exit — a signal-forced abort or a thrown fault — is unclean. This
  // feeds the exit marker close() writes (D1a) and the process exit code (D3).
  let cleanShutdown = false
  // Wall-clock time of the last lease-expiry sweep (D1b). 0 forces a sweep on the
  // first tick — it catches older-generation ghosts the one-shot startup reclaim
  // (pid-scoped, last pid only) cannot.
  let lastSweepAt = 0
  // PR revisions this process already tried a MECHANICAL printed remedy on
  // (22474). Queue's durable refusal settlement owns judgment/no-remedy outcomes
  // across restarts; this Set only prevents a partially applied mechanical drill
  // from repeating inside the same process before its journal transition clears.
  const remedied = new Set<string>()
  // Consecutive all-candidate-refusal cycles against an unchanged world (22474
  // specimen 3). Also process-scoped: it is a claim about THIS process.
  let stall: ResidentRefusalStall | undefined
  let firstCycle = true
  let lastMaintenanceAt = 0

  const runCycle = async (): Promise<YrdCliExitCode | null> => {
    try {
      heartbeat?.check()
      const starting = firstCycle
      const beforeRefresh = app.state()
      if (!starting) await app.refresh()
      const refreshed = app.state() !== beforeRefresh
      const cycleNow = io.now?.() ?? Date.now()
      const beforeHoldExpiry = app.state()
      await app.queue.expirePauses(new Date(cycleNow).toISOString())
      const holdExpired = app.state() !== beforeHoldExpiry
      const maintenanceDue =
        starting || cycleNow < lastMaintenanceAt || cycleNow - lastMaintenanceAt >= RESIDENT_MAINTENANCE_INTERVAL_MS
      if (!starting && !refreshed && !holdExpired && !maintenanceDue && !drainRequested()) {
        if (scope.signal.aborted) return RESIDENT_INTERRUPTED_EXIT
        await sleepUntilDrain(scope.sleep(interval), drainSignal)
        heartbeat?.check()
        return scope.signal.aborted ? RESIDENT_INTERRUPTED_EXIT : null
      }
      firstCycle = false
      // Re-prove the installed baseline before EACH cycle: a config change while
      // watching must stop the watch, never let a fresh cycle start expensive
      // Runs on a stale baseline.
      await gate()
      if (maintenanceDue) lastMaintenanceAt = cycleNow
      let runRequired = starting || refreshed || holdExpired
      // D1b — bounded maintenance lease-expiry recovery sweep. ONLY the resident
      // runs it: it holds the exclusive lease, so its unscoped `recover` write is
      // single-writer safe. (A one-shot or a bare programmatic followQueueRuns
      // caller — no runner identity — never sweeps.)
      if (resident && maintenanceDue) {
        const beforeRecovery = app.state()
        lastSweepAt = await residentRecoverySweep(app, io, lastSweepAt)
        runRequired ||= app.state() !== beforeRecovery
      }
      // The optional default preserves the narrow followQueueRuns test/programmatic
      // seam. The installed CLI always supplies the recutter; a caller that does
      // not install one retains the historical drain-only behavior.
      // 22474 — a wedged PR whose refusal printed a deterministic remedy gets
      // that remedy applied here, once per revision, before the next compose
      // snapshot. Same recutter, same serialized cycle as the freshness pass.
      // A mechanical recut may itself take long enough for installed Queue
      // definitions to move. Re-prove the baseline before admitting its fresh
      // revision; never start a Run under the pre-recut gate snapshot.
      if (await prepareResidentQueueCycle(app, services, io, remedied)) {
        runRequired = true
        await gate()
      }
      if (!runRequired && !drainRequested()) {
        if (scope.signal.aborted) return RESIDENT_INTERRUPTED_EXIT
        await sleepUntilDrain(scope.sleep(interval), drainSignal)
        heartbeat?.check()
        return scope.signal.aborted ? RESIDENT_INTERRUPTED_EXIT : null
      }
      const runs = await runQueues(app, selectors, options, io)
      recoveryReporter.flush()
      heartbeat?.check()
      // The runner is a service; its stdout is a log stream. Human output is
      // loggily-only (--json still streams the structured record). The
      // QueueRunsView table (RUN/PRS/STATE/STEPS) is the interactive
      // `queue watch` viewer's surface — it must never be dumped into the
      // runner's log. (#undead: runner-loggily-only)
      if (jsonEnabled(options)) {
        for (const run of runs) {
          io.stdout(stableJson({ command: "queue.run", mode: "follow", run: projectQueueRunTaskStatus(run) }))
        }
      }
      const exit: YrdCliExitCode = runs.some(Queues.failed) ? 1 : 0
      // 22474 specimen 3 — self-health. A long-lived drain that refuses EVERY
      // candidate, cycle after cycle, against a world that is not moving has
      // stopped being evidence about the PRs and become evidence about itself.
      // Gated on the selectorless loop, not on resident identity: a targeted
      // one-shot has no next cycle to break out of.
      const health = residentRefusalHealth(app, stall, runs.length, selectors.length === 0)
      stall = health.stall
      // Exit UNCLEAN so the derived resident lifetime re-execs a fresh process
      // with fresh observation state — mechanically the SIGINT + `yrd queue run` an
      // operator performed by hand, minus the 2.5h wait. The heartbeat's
      // close(cleanShutdown=false) in the finally releases the lease.
      if (health.restart) return RESIDENT_POISONED_EXIT
      if (drainRequested()) {
        if (runs.every(Queues.terminal)) {
          // Operator drain finished with no in-flight work left — the one clean stop.
          cleanShutdown = true
          const lastRun = runs.at(-1)
          return lastRun !== undefined && Queues.failed(lastRun) ? 1 : 0
        }
        // The drain has NOT finished (a run is still in flight), yet a hard signal
        // is forcing the stop now. That is "exiting with in-flight work due to a
        // signal": stay unclean and exit non-zero so the resident breaker records
        // the failed lifetime. A single drain signal (no scope abort) still loops
        // below and finishes the drain cleanly.
        if (scope.signal.aborted) return RESIDENT_INTERRUPTED_EXIT
        await scope.sleep(interval)
        return null
      }
      if (selectors.length > 0) return exit
      if (scope.signal.aborted) return RESIDENT_INTERRUPTED_EXIT
      await sleepUntilDrain(scope.sleep(interval), drainSignal)
      heartbeat?.check()
      return scope.signal.aborted ? RESIDENT_INTERRUPTED_EXIT : null
    } catch (error) {
      // One typed recovery boundary owns the complete selectorless cycle. A
      // journal lock can surface while refreshing, preparing, or committing
      // the run. Multi-tenant races can surface at the same boundaries. All
      // recognized cases are losable for a resident and fatal for a one-shot;
      // unknown failures still propagate and stop the runner (fail-loud).
      const recovery = selectors.length === 0 ? residentCycleRecovery(error) : undefined
      if (recovery === undefined) throw error
      recoveryReporter.report(recovery)
      heartbeat?.check()
      if (drainRequested()) {
        await scope.sleep(interval)
        return null
      }
      if (scope.signal.aborted) return RESIDENT_INTERRUPTED_EXIT
      await sleepUntilDrain(scope.sleep(interval), drainSignal)
      heartbeat?.check()
      return scope.signal.aborted ? RESIDENT_INTERRUPTED_EXIT : null
    }
  }

  try {
    heartbeat?.check()
    if (heartbeat !== undefined && selectors.length === 0 && !jsonEnabled(options)) {
      io.stdout(
        `Queue runner ${io.runner} active; following the default queue every ${intervalSeconds}s (Ctrl-C drains).\n`,
      )
    }
    while (true) {
      const exit = await runCycle()
      if (exit !== null) return exit
    }
  } catch (error) {
    if (heartbeat !== undefined && isYrdRuntimeReloadRequest(error)) {
      await heartbeat.recordProgress({
        state: "stalled",
        observedAt: new Date(io.now?.() ?? Date.now()).toISOString(),
        findings: [error.finding],
      })
    }
    throw error
  } finally {
    recoveryReporter.flush()
    await heartbeat?.close(cleanShutdown)
  }
}

async function sleepUntilDrain(sleep: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return sleep
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      result()
    }
    const onAbort = () => finish(resolve)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void sleep.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

async function watchQueue(
  app: YrdCliApp,
  filters: readonly string[],
  options: WatchOptions,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<YrdCliExitCode> {
  const interval = 15_000
  const scope = io.scope ?? app.scope
  const query = createQueueListSnapshotLoader(app, filters, options, io, services, !jsonEnabled(options))
  const load = (focus?: QueueWatchFocus): Promise<QueueListSnapshot> => query.load(focus)

  if (!jsonEnabled(options)) {
    io.stderr(`yrd watch runtime: ${formatYrdRuntimeVersion()}\n`)
    const renderLive = getLiveRenderer(io)
    if (renderLive === undefined) {
      refusal("watch requires an interactive terminal; use --json for streaming output")
    }
    const initial = await load()
    const { QueueWatchPane } = await import("./watch-pane.tsx")
    await renderLive(
      createElement(QueueWatchPane, {
        initial,
        load,
        intervalMs: interval,
        ...(options.pr === undefined ? {} : { pr: options.pr }),
        // The watch `x`+confirm affordance shares the CLI's cancel path exactly:
        // cancel journals a run cancellation whose PRs re-queue (not reject), and
        // the pane's poll loop reflects it on the next cycle.
        onCancelRun: async (run: string) => {
          await app.queue.cancelRun({ run, by: io.runner ?? "operator", reason: "run canceled from watch" })
        },
      }),
      {
        signal: scope.signal,
      },
    )
    return 0
  }

  while (true) {
    const snapshot = await load()
    await printResultWithWarnings(
      io,
      true,
      {
        command: "queue.list",
        projection: snapshot.projection,
        results: snapshot.results.map(projectQueueStatusResultTaskStatus),
        ...(snapshot.readFailure === undefined ? {} : { readFailure: snapshot.readFailure }),
      },
      createElement(QueueTimelineView, {
        repositoryRoot: snapshot.repositoryRoot,
        projection: snapshot.projection,
        runnerRefusal: snapshot.runnerRefusal,
        results: snapshot.results,
        state: snapshot.state,
        columns: io.columns ?? 120,
      }),
      [
        ...queuePauseWarnings(snapshot.state, snapshot.results),
        ...(snapshot.readFailure === undefined ? [] : [queueReadFailureMessage(snapshot.readFailure, true)]),
      ],
    )
    if (scope.signal.aborted) return 0
    await scope.sleep(interval)
    if (scope.signal.aborted) return 0
  }
}

function competitors(input: string): readonly CompetitorDef[] {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    usage("--competitors must be JSON")
  }
  const parsed = CompetitorDefSchema.array().min(2).safeParse(value)
  if (!parsed.success) {
    usage("--competitors must be a JSON array with at least two {id,runner,config} entries")
  }
  return parsed.data
}

async function advanceContest(app: YrdCliApp, contest: string, io: YrdCliIO, retry = false): Promise<Contest> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  return app.contests.evaluate(contest, { ...runtimeOptions(io), concurrency, retry })
}

async function openContest(
  app: YrdCliApp,
  issueInput: string,
  options: { competitors?: string; evaluators?: unknown; base?: string; queue?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.competitors === undefined) usage("contest open requires --competitors <json>")
  const issue = await app.issues.resolve(app.issues.ref(issueInput))
  const requestedBase = oneOfAliases(options.base, options.queue, "base", "queue")
  const base = await app.contests.resolveBase(requestedBase)
  const opened = await app.contests.compete({
    issue,
    competitors: competitors(options.competitors),
    ...(csv(options.evaluators) === undefined ? {} : { evaluators: csv(options.evaluators) }),
    base: base.base,
    baseSha: base.sha,
  })
  const contest = await advanceContest(app, opened.id, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.open", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function viewContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contest = app.contests.get(id)
  if (contest === undefined) refusal(`no contest '${id}'`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.view", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function evalContest(
  app: YrdCliApp,
  id: string,
  options: { retry?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const contest = await advanceContest(app, id, io, options.retry === true)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.eval", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function finishContest(
  app: YrdCliApp,
  id: string,
  options: {
    attempt?: string
    evaluator?: string
    ok?: boolean
    fail?: boolean
    error?: string
    token?: string
    detail?: string
    artifact?: unknown
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  const errorCode = options.error?.trim()
  if (options.error !== undefined && errorCode === "") usage("contest finish --error requires a non-empty code")
  const outcomes = Number(options.ok === true) + Number(options.fail === true) + Number(errorCode !== undefined)
  if (outcomes !== 1) usage("contest finish requires exactly one of --ok, --fail, or --error")
  if (options.token === undefined || options.token === "") usage("contest finish requires --token <token>")
  const recordedArtifacts = artifacts(options.artifact)?.map(({ name, uri }) => ({ kind: name, uri })) ?? []
  if (errorCode !== undefined && recordedArtifacts.length > 0) {
    usage("contest finish --artifact records evaluator verdict evidence and cannot be used with --error")
  }
  const contest = await app.contests.finish({
    contest: id,
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    ...(options.evaluator === undefined ? {} : { evaluator: options.evaluator }),
    token: options.token,
    result:
      errorCode === undefined
        ? {
            status: "completed",
            conclusion: "success",
            output: {
              verdict: options.ok === true ? "passed" : "failed",
              ...(options.detail === undefined ? {} : { summary: options.detail }),
              artifacts: recordedArtifacts,
            },
          }
        : {
            status: "completed",
            conclusion: "failure",
            error: {
              code: errorCode,
              message: options.detail?.trim() || `remote evaluator failed (${errorCode})`,
            },
          },
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.finish", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function selectContest(
  app: YrdCliApp,
  id: string,
  options: { winner?: string; by?: string; reason?: string; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  if (options.winner === undefined || options.winner === "") usage("contest select requires --winner <attempt>")
  const contest = await app.contests.select({
    contest: id,
    attempt: options.winner,
    ...(options.by === undefined ? {} : { selectedBy: options.by }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.select", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function promoteContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  const contest = await app.contests.promote({ contest: id }, { ...runtimeOptions(io), concurrency })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.promote", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "promotion-failed" ? 1 : 0
}

async function listContests(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contests = app.contests.list()
  const human =
    contests.length === 0
      ? "No contests."
      : [
          "CONTEST ISSUE STATUS",
          ...contests.map(
            (contest) => `${contest.id} ${contest.issue.ref.source}:${contest.issue.ref.id} ${contest.status}`,
          ),
        ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "contest.list", contests }, human)
}

/**
 * Admit a pin-advance intent.
 *
 * Admission is advisory: main moves, so merge-time evaluation re-runs every
 * check and is the only authority. It exists so the submitter fails loud while
 * their context is warm — and so a typo'd component never becomes a queue row.
 */
async function submitIntent(
  app: YrdCliApp,
  services: YrdCliServices,
  options: IntentSubmitOptions,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const component = options.component ?? usage("yrd intent submit requires --component <path>")
  const issueRef = options.issue ?? usage("yrd intent submit requires --issue <ref>")
  const issue = await app.issues.resolve(app.issues.ref(issueRef))
  const repo = io.cwd ?? process.cwd()
  const host = services.process
  if (host === undefined) {
    configuration("yrd intent submit requires a process host to inspect the component")
  }
  const admission = await admitPinIntent({
    process: host,
    repo,
    base: options.base ?? services.base ?? "main",
    component,
    issue: issueRef,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.expectPin === undefined ? {} : { expectedCurrentPin: options.expectPin }),
    ...(options.allowOffTrunk === true ? { allowOffTrunk: true } : {}),
    tombstones: app.intents.tombstones(component),
  })
  if (!admission.admitted) {
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "intent.submit",
        failure: {
          code: admission.code,
          message: admission.message,
          evidence: admission.evidence,
          remedy: admission.remedy,
        },
      },
      [admission.message, "", ...admission.remedy.map((step) => `  ${renderRemedyStep(step)}`)].join("\n"),
    )
    return 1
  }

  const intent = await app.intents.submit({
    intentId: randomUUID(),
    issue: issue.ref,
    component,
    submitter: options.submitter ?? "operator",
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.expectPin === undefined ? {} : { expectedCurrentPin: options.expectPin }),
    ...(options.allowOffTrunk === true ? { allowOffTrunk: true } : {}),
    ...(options.force === true ? { forceSupersede: true } : {}),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "intent.submit", intent, admission },
    `${intent.id} ${intent.component} ${intent.target ?? "<component main tip at landing>"} (${admission.relation}; pin ${admission.currentPin})`,
  )
  return 0
}

async function tombstoneIntent(app: YrdCliApp, options: IntentTombstoneOptions, io: YrdCliIO): Promise<void> {
  const component = options.component ?? usage("yrd intent tombstone requires --component <path>")
  const sha = options.sha ?? usage("yrd intent tombstone requires --sha <commit>")
  const issueRef = options.issue ?? usage("yrd intent tombstone requires --issue <ref>")
  const issue = await app.issues.resolve(app.issues.ref(issueRef))
  const tombstone = await app.intents.tombstone({
    tombstoneId: randomUUID(),
    issue: issue.ref,
    component,
    sha,
    submitter: options.submitter ?? "operator",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "intent.tombstone", tombstone },
    `${tombstone.id} ${tombstone.component} ${tombstone.sha}`,
  )
}

async function listIntents(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const intents = app.intents.list()
  const human =
    intents.length === 0
      ? "No intents."
      : [
          "INTENT COMPONENT TARGET STATUS ISSUE",
          ...intents.map((intent) =>
            [
              intent.id,
              intent.component,
              intent.target ?? "-",
              intent.status,
              `${intent.issue.source}:${intent.issue.id}`,
            ].join(" "),
          ),
        ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "intent.list", intents }, human)
}

async function showIntent(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const intent = app.intents.get(selector)
  if (intent === undefined) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "intent.show", failure: { code: "intent-not-found", message: `yrd: no intent '${selector}'` } },
      `yrd: no intent '${selector}'`,
    )
    return 1
  }
  const human = [
    `${intent.id} ${intent.status}`,
    `component  ${intent.component}`,
    `target     ${intent.target ?? "<component main tip at landing>"}`,
    `issue      ${intent.issue.source}:${intent.issue.id}`,
    `submitter  ${intent.submitter}`,
    `submitted  ${intent.submittedAt}`,
    ...(intent.supersededBy === undefined ? [] : [`superseded ${intent.supersededBy}`]),
    ...(intent.disposition === undefined ? [] : [`disposition ${intent.disposition.code}`]),
  ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "intent.show", intent }, human)
  return 0
}

async function withdrawIntent(
  app: YrdCliApp,
  selector: string,
  options: IntentWithdrawOptions,
  io: YrdCliIO,
): Promise<void> {
  const intent = await app.intents.withdraw(selector, options.reason)
  await printResult(io, jsonEnabled(options), { command: "intent.withdraw", intent }, `${intent.id} ${intent.status}`)
}

async function materializeIntent(
  component: string,
  services: YrdCliServices,
  options: IntentMaterializeOptions,
  io: YrdCliIO,
): Promise<void> {
  const target = options.target ?? usage("yrd intent materialize requires --target <sha>")
  const issue = options.issue ?? usage("yrd intent materialize requires --issue <ref>")
  const host = services.process
  if (host === undefined) configuration("yrd intent materialize requires a process host")
  const repo = io.cwd ?? globalThis.process.cwd()
  const base = options.base ?? services.base ?? "main"
  const baseSha = (await runQueueGit(host, repo, ["rev-parse", base])).trim()
  const carrier = await synthesizePinIntentCarrier({
    inject: { process: host },
    repo,
    baseSha,
    component,
    target,
    issue,
  })
  const leaf =
    component
      .split("/")
      .at(-1)
      ?.replaceAll(/[^A-Za-z0-9._-]/gu, "-") || "component"
  const branch = options.branch ?? `yrd/intent/${leaf}-${carrier.commit.slice(0, 12)}`
  await runQueueGit(host, repo, ["check-ref-format", "--branch", branch])
  const ref = `refs/heads/${branch}`
  const current = await host.run({
    argv: ["git", "-C", repo, "rev-parse", "--verify", ref],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (current.timedOut) throw gitTimeoutError(["rev-parse", "--verify", ref])
  if (current.exitCode === 0 && current.stdout.trim() !== carrier.commit) {
    refusal(`materialized branch '${branch}' already points at ${current.stdout.trim()}`)
  }
  if (current.exitCode !== 0) {
    await runQueueGit(host, repo, ["update-ref", ref, carrier.commit, "0".repeat(40)])
  }
  // A resident runner lands open intents itself — printing the manual-submit
  // step under one teaches the reader to create a duplicate carrier that gets
  // terminated as already-landed (@i/23-yrd-vocabulary/intent-rail-hint). The
  // hint survives only in the no-runner state, and then it names that state.
  const runner = activeResidentRunner(await residentRunnerStatus(repo))
  if (runner !== null) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "intent.materialize", branch, carrier, runner: "resident" },
      `${branch} ${carrier.commit}\nresident runner (pid ${runner.pid}) lands open intents — no manual submit needed`,
    )
    return
  }
  const next = `yrd pr submit ${branch} --issue ${issue}`
  await printResult(
    io,
    jsonEnabled(options),
    { command: "intent.materialize", branch, carrier, runner: "none", next },
    `${branch} ${carrier.commit}\nnext (no resident runner): ${next}`,
  )
}

async function refusePrMerge(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    const next = `yrd pr submit ${selector}`
    const message = `the queue is the only merger; branch '${selector}' is not submitted; submit it: ${next}`
    const guidance = {
      command: "pr.merge",
      branch: selector,
      status: "not-submitted",
      next,
      guidance: { submit: next },
      failure: { kind: "refusal", code: "queue-only-merger", message },
    }
    if (jsonEnabled(options)) {
      io.stderr(stableJson(guidance))
      return 1
    }
    refusal(message)
  }

  const position = await queuedPrPosition(app, pr, io)
  const detail = prMergeRefusalDetail(pr, position, latestRunForCurrentRevision(pr, app.queue.status(pr.base)))
  const message = `the queue is the only merger; ${detail.message}`
  const guidance = {
    command: "pr.merge",
    pr: pr.id,
    status: prDeliveryState(pr),
    ...(detail.run === undefined ? {} : { run: detail.run, outcome: detail.outcome }),
    ...(position === undefined ? {} : { position }),
    next: detail.next,
    guidance: detail.guidance,
    failure: { kind: "refusal", code: "queue-only-merger", message },
  }
  if (jsonEnabled(options)) {
    io.stderr(stableJson(guidance))
    return 1
  }
  refusal(message)
}

function prMergeRefusalDetail(
  pr: PR,
  position: number | undefined,
  latestRun: Run | undefined,
): Readonly<{
  next: string
  guidance: Readonly<Record<string, string>>
  message: string
  run?: string
  outcome?: "rejected"
}> {
  const delivery = prDeliveryState(pr)
  const projectedStatus = projectedPrStatus(pr)
  if (latestRun?.status === "completed" && latestRun.conclusion === "failure") {
    const inspect = `yrd pr runs ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `PR '${pr.id}' latest Run '${latestRun.id}' was rejected; see: ${inspect}; then ${resubmit}`,
      run: latestRun.id,
      outcome: "rejected",
    }
  }
  if (currentPRRev(pr).admission?.status === "refused") {
    const inspect = `yrd pr checks ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `PR '${pr.id}' current revision failed required checks; see: ${inspect}; then ${resubmit}`,
    }
  }
  if (delivery === "submitted" || delivery === "ready") {
    const watch = `yrd watch --pr ${pr.id}`
    return {
      next: watch,
      guidance: { watch },
      message: `PR '${pr.id}' is queued${position === undefined ? "" : ` at position ${position}`}; watch: ${watch}`,
    }
  }
  if (delivery === "rejected") {
    const inspect = `yrd pr runs ${pr.id}`
    const fixPush = "fix the branch and push; the same PR resumes automatically"
    return {
      next: inspect,
      guidance: { inspect, fixPush },
      message: `PR '${pr.id}' ${projectedStatus === "needs-author" ? "needs author changes" : "was rejected"}; see: ${inspect}; then ${fixPush}`,
    }
  }
  if (delivery === "pushed") {
    const submit = `yrd pr submit ${pr.branch}`
    return { next: submit, guidance: { submit }, message: `PR '${pr.id}' is not queued; submit it: ${submit}` }
  }
  const view = `yrd pr view ${pr.id}`
  return { next: view, guidance: { view }, message: `PR '${pr.id}' is ${delivery}; see: ${view}` }
}

function maxExit(left: YrdCliExitCode, right: YrdCliExitCode): YrdCliExitCode {
  return Math.max(left, right) as YrdCliExitCode
}

/**
 * The in-toto Statement projection over a durable merge record, for `--json`
 * consumers that want the landing in attestation shape.
 *
 * `builderId` is the queue that produced the landing. It is deliberately not a
 * `MergeRecordBody` field — the record is checksummed and the projection is free
 * to change — so it comes from the journal's own run. Both ways the projection
 * can be absent are named rather than dropped from the payload: a refused or
 * canceled attempt minted no landed commit to be the Statement's subject, and a
 * record whose run the journal has never seen has no builder to attribute.
 */
function landingStatement(
  app: YrdCliApp,
  record: MergeRecordBody,
): Readonly<{ statement: InTotoStatement }> | Readonly<{ statementUnavailable: string }> {
  const run = Queues.resolve(stateOf(app).queues, record.merge.id)
  if (run === undefined) {
    return {
      statementUnavailable: `run '${record.merge.id}' is not in the journal, so the attesting queue is unknown`,
    }
  }
  const statement = mergeRecordToStatement(record, run.queueId)
  return statement === undefined
    ? {
        statementUnavailable: `merge '${record.merge.id}' is ${record.merge.result}, so it minted no landed commit to attest`,
      }
    : { statement }
}

async function explainLanding(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption & Readonly<{ repair?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (services.mergeRecords !== undefined) {
    const proof = await services.mergeRecords.find(selector)
    if (proof.status === "repository-corrupt" || proof.status === "repository-incomplete") {
      await printResult(
        io,
        jsonEnabled(options),
        { command: "why", selector, verdict: proof.status, reason: proof.reason, repaired: false },
        `${proof.status.toUpperCase()} — ${selector}: ${proof.reason}`,
      )
      return 2
    }
    if (proof.status === "proven") {
      const attempts = [...proof.records].sort((left, right) =>
        left.record.merge.finishedAt.localeCompare(right.record.merge.finishedAt),
      )
      const latest = attempts.at(-1)
      if (latest === undefined) configuration("repository merge-record query returned no proven records")
      const verdict = latest.record.merge.result
      const reason = latest.record.reason
      const fix = latest.record.fix
      let repaired = false
      const pr = app.bays.pr(selector)
      if (verdict === "merged" && options.repair === true && pr !== undefined) {
        const revision = currentPRRev(pr)
        const change = latest.record.changes.find(
          (candidate) =>
            candidate.pr === pr.id &&
            candidate.revision === revision.n &&
            candidate.submittedHead === revision.head &&
            candidate.changeId === revision.changeId,
        )
        const commit = latest.record.merge.mergedCommit
        const indexed =
          prDeliveryState(pr) === "integrated" &&
          pr.terminalRun === latest.record.merge.id &&
          pr.integration?.commit === commit
        if (!indexed && change?.changeId !== undefined && commit !== undefined) {
          await app.queue.reconcileLanding({
            pr: change.pr,
            revision: change.revision,
            headSha: change.submittedHead,
            run: latest.record.merge.id,
            commit,
            landingSha: commit,
            baseSha: commit,
            changeId: change.changeId,
          })
          repaired = true
        }
      }
      const human =
        verdict === "merged"
          ? `MERGED — ${selector} via ${latest.record.merge.id} at ${latest.record.merge.mergedCommit}`
          : `${verdict.toUpperCase()} — ${latest.record.merge.id}: ${reason?.code ?? "unknown"}: ${reason?.message ?? "no reason recorded"}${fix === undefined ? "" : ` — fix: ${fix}`}`
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "why",
          selector,
          verdict,
          repaired,
          record: latest.record,
          pointer: latest.pointer,
          attempts,
          ...landingStatement(app, latest.record),
        },
        human,
      )
      return verdict === "merged" ? 0 : 1
    }
  }
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "why", selector, verdict: "not-proven", reason: "merge-record-missing", repaired: false },
      `NOT-PROVEN — ${selector}: merge-record-missing`,
    )
    return 1
  }
  const revision = currentPRRev(pr)
  if (revision.changeId === undefined) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "why", pr: pr.id, verdict: "legacy-unprovable", repaired: false },
      `LEGACY-UNPROVABLE — ${pr.id} predates stable Change-Id identity`,
    )
    return 1
  }
  const indexed = prDeliveryState(pr) === "integrated"
  const verdict = indexed ? "index-corrupt" : "not-proven"
  await printResult(
    io,
    jsonEnabled(options),
    { command: "why", selector, verdict, reason: "merge-record-missing", repaired: false },
    `${verdict.toUpperCase()} — ${pr.id}: merge-record-missing`,
  )
  return indexed ? 2 : 1
}

type CommanderOutput = { errorCommand?: CliCommand }

function configureOutput(command: CliCommand, io: YrdCliIO, output: CommanderOutput): void {
  command.configureOutput({
    writeOut: (text) => io.stdout(text),
    // Parse failures are rendered once from the caught CommanderError. This
    // keeps suggestions, JSON diagnostics, and domain failures on one path.
    writeErr: () => {
      output.errorCommand = command
    },
    getOutHasColors: () => io.color === true,
    getErrHasColors: () => io.color === true,
    getOutHelpWidth: () => io.columns ?? 80,
    getErrHelpWidth: () => io.columns ?? 80,
  })
  for (const child of command.commands) configureOutput(child as unknown as CliCommand, io, output)
}

function addExamples(program: CliCommand, name: string): void {
  const bay = `${name} bay`
  const examples: [string, string][] = [
    [`$ ${bay} open --bay fix`, "open and keep a scratch Bay"],
    [`$ ${bay} run @km/test/fix -- make test`, "run one scoped command"],
    [`$ ${bay} in fix`, "open a guest shell in one Bay"],
    [`$ ${bay} submit`, "submit the current bay as a PR"],
  ]
  examples.push(
    [`$ ${name} pr list`, "inspect active PRs"],
    [`$ ${name} submit`, "submit the current branch as a merge request"],
    [`$ ${name} pr create topic/fix`, "create a draft before you submit"],
    [`$ ${name} watch --pr PR7`, "monitor PR and queue health"],
    [`$ ${name} contest open km:T1 --competitors '<json>'`, "compare implementations"],
  )
  program.addHelpSection("Examples:", examples)
}

function addQueueExamples(queue: CliCommand, name: string): void {
  const repository = `${name} --repo <repository>`
  queue.addHelpSection("Examples:", [
    [`$ ${name} queue`, "list active queues"],
    [`$ ${repository} queue run PR7 --steps check,merge`, "run selected steps for one PR"],
    [`$ ${name} log --base release/2.0`, "show completed work for a base"],
    [`$ ${name} pr runs PR7`, "show step-level run evidence and proofs"],
    [`$ ${repository} queue pause --reason maintenance --for 30m --allow PR7`, "pause all but selected PRs"],
    [`$ ${repository} queue recover --json`, "recover expired runner leases"],
    [`$ ${repository} queue run`, "resident follow-runner: keep the default queue moving"],
  ])
}

function addAuthoredCarrierWorkflow<
  Options extends Record<string, unknown>,
  Arguments extends unknown[],
  ArgumentRecord extends Record<string, unknown>,
>(command: CliCommand<Options, Arguments, ArgumentRecord>, name: string): void {
  command.addHelpSection("Authored root branch:", [
    [`$ ${name} pr create <branch>`, "record the authored root branch as a draft merge request"],
    [
      `$ ${name} pr recut <PR> --preflight --queue --apply`,
      "classify from pinned evidence and execute its queue-safe verdict; no composition manifest or manual triage",
    ],
  ])
}

function addRootBayCommands(
  program: CliCommand,
  installed: () => YrdCliApp,
  installedServices: () => YrdCliServices,
  io: YrdCliIO,
  setExit: (code: YrdCliExitCode) => void,
): void {
  program
    .command("in [bay] [command...]")
    .description("join an open Bay as a guest; defaults to $SHELL, or pass opaque argv after --")
    .action(async (bay, command) => {
      const request = bayInOperands(bay, command, io)
      setExit(await enterBay(installed(), installedServices(), request.selector, request.argv, io))
    })
  program
    .command("sh [config]")
    .description("run $SHELL in a scoped Bay")
    .option("--issue <ref>", "link an issue without a positional")
    .option("--pr <selector>", "continue an existing PR without creating or submitting a revision")
    .option("--bay <name>", "choose an issue-less or issue-linked Bay identity")
    .option("--keep", "leave a successful run open")
    .action(async (config, options) =>
      setExit(
        await runBaySession(
          installed(),
          installedServices(),
          config,
          defaultRunArgv(installedServices()),
          options,
          io,
          { keep: options.keep },
        ),
      ),
    )
  const run = program.command("run").description("act on individual queue runs")
  run.helpCommand(false)
  run
    .command("cancel <selector>")
    .description("cancel a waiting or running run; its PRs re-queue for a future drain, they are NOT rejected")
    .option("--reason <text>", "human-readable cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await cancelQueueRun(installed(), selector, options, io)))
}

function buildProgram(
  app: YrdCliApp | undefined,
  services: YrdCliServices,
  name: string,
  io: YrdCliIO,
  setExit: (code: YrdCliExitCode) => void,
  commanderOutput: CommanderOutput,
  invocation: NormalizedYrdInvocation,
  bootstrap?: RuntimeBootstrap,
): CliCommand {
  let runtimeApp = app
  let runtimeServices = services
  const installed = (): YrdCliApp => runtimeApp ?? configuration("command runtime is not initialized")
  const installedServices = (): YrdCliServices => runtimeServices
  const program = new CliCommand(name)
    .description("yrd (shipyard) — agentic software delivery")
    .showSuggestionAfterError()
  program.helpCommand(false)
  program.exitOverride()
  program.configureHelp({ ...program.configureHelp(), minWidthToWrap: 20 })
  if (app === undefined) {
    configureYrdGlobalOptions(program)
  }
  if (bootstrap !== undefined) {
    program.hook("preAction", async (_root, action) => {
      if (runtimeApp !== undefined) return
      const globals = action.optsWithGlobals() as RuntimeGlobalOptions
      const runtimeIO = io as RuntimeInvocationIO
      const selected = resolveRuntimeContext(globals, bootstrap)
      if (invocation.queueRunnerCheck && bootstrap.probe !== undefined) {
        const probed = await bootstrap.probe(selected)
        runtimeServices = probed.services
        runtimeIO[RuntimeInvocationCwd] = bootstrap.ambientCwd
        Object.assign(io, probed.io)
        return
      }
      const loaded = await bootstrap.load(selected, invocation.posture)
      runtimeApp = loaded.app
      runtimeServices = loaded.services
      runtimeIO[RuntimeInvocationCwd] = bootstrap.ambientCwd
      Object.assign(io, loaded.io)
      if (invocation.posture !== "resident-queue-run" && invocation.posture !== "one-shot-queue-run") {
        await runClientDeadMan(runtimeApp, runtimeServices, io, !jsonOutputRequested(program, invocation.args))
      }
    })
  }
  program.version(YRD_VERSION, "-V, --version")
  program.addHelpSection(
    "Model:",
    "Pick an issue -> work it in a bay -> create a draft -> submit it ->\nmerge requests queue per base -> a run verifies and merges each one ->\nmerged, or parked for the author with a typed receipt.",
  )
  program.addHelpSection("Objects:", [
    ["issue", "tracker-owned intent; delivery lens plus Git-side ensure"],
    ["bay", "isolated Git workspace managed through the yrd bay subtree"],
    ["pr", "merge request, also called a pull request; draft until submitted; the queue's unit"],
    ["contest", "competing implementations; winner promotes to a PR"],
    ["queue", "the merge queue: one per base; verifies and merges merge requests serially"],
  ])
  program.addHelpSection(
    "Boundaries:",
    "Runs, steps, jobs, attempts, and runners are records inside PRs and the log.\nThe queue is the only merger; pr merge only teaches the correct next command.\nThe tracker holds the pen; yrd never creates or edits issues.",
  )
  program
    .command("_dashboard", { isDefault: true, hidden: true })
    .option("--base <branch>", "scope the dashboard to one base")
    .option("--json", "emit stable JSON")
    .action(async (options) => dashboard(installed(), options, io))
  program
    .command("doctor")
    .description("diagnose Flow drift and repository configuration warnings")
    .option("--rebuild-views", "atomically rebuild registered query views from immutable Journal history")
    .option(
      "--rebuild-index-from-repo",
      "rebuild missing pr/integrated index rows from every proven merge record in the repository",
    )
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await configDoctor(installed(), installedServices(), options, io)))
  program
    .command("why <selector>")
    .description("prove one PR landing from repository truth and its journal index")
    .option("--repair", "append a missing pr/integrated index row from repository proof")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(await explainLanding(installed(), installedServices(), selector, options, io)),
    )

  const bay = program.command("bay").description("manage isolated Git work bays")
  bay.helpCommand(false)
  bay
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .option("--all", "include open and terminal Bays")
    .option("--closed", "show terminal Bays only")
    .option("--check", "compute live destroy-safety status (fetches origin; may be slow)")
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("list")
    .description("list work bays")
    .option("--json", "emit stable JSON")
    .option("--all", "include open and terminal Bays")
    .option("--closed", "show terminal Bays only")
    .option("--check", "compute live destroy-safety status (fetches origin; may be slow)")
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("open")
    .argument("[config]", "issue to link; omit for an anonymous Bay")
    .description("open and keep a Bay")
    .option("--issue <ref>", "link an issue without a positional")
    .option("--pr <selector>", "continue an existing PR without creating or submitting a revision")
    .option("--bay <name>", "choose an issue-less or issue-linked Bay identity")
    .action(async (config, options) => {
      if ((io as RuntimeInvocationIO)[RuntimeChildArgv] !== undefined) {
        usage("bay open does not run commands; use 'yrd bay run <config> -- <command>'")
      }
      setExit(await openPersistentBay(installed(), installedServices(), config, options, io))
    })
  bay
    .command("run [config] [command...]")
    .description("run one scoped command (defaults to $SHELL)")
    .option("--issue <ref>", "link an issue without a positional")
    .option("--pr <selector>", "continue an existing PR without creating or submitting a revision")
    .option("--bay <name>", "choose an issue-less or issue-linked Bay identity")
    .option("--keep", "leave a successful run open")
    .action(async (config, command, options) => {
      const request = bayRunOperands(config, command, io)
      setExit(
        await runBaySession(installed(), installedServices(), request.arg, request.argv, options, io, {
          keep: options.keep,
        }),
      )
    })
  bay
    .command("in [bay] [command...]")
    .description("join an open Bay as a guest; defaults to $SHELL, or pass opaque argv after --")
    .action(async (selector, command) => {
      const request = bayInOperands(selector, command, io)
      setExit(await enterBay(installed(), installedServices(), request.selector, request.argv, io))
    })
  bay
    .command("path <selector>")
    .description("print an active bay workspace path")
    .option("--json", "emit stable JSON")
    .action((selector, options) => pathBay(installed(), selector, options, io))
  bay
    .command("refresh [selector...]")
    .description("refresh work bays")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => refreshBays(installed(), selectors, options, io))
  bay
    .command("handoff <selector>")
    .description("certify a materialized exact-head handoff")
    .requiredOption("--branch <branch>", "exact branch recorded in the handoff packet")
    .requiredOption("--head <sha>", "exact head recorded in the handoff packet")
    .requiredOption("--evidence <ref>", "opaque materialized handoff reference")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      certifyBayHandoff(
        installed(),
        selector,
        options as Readonly<{ branch: string; head: string; evidence: string; json?: boolean }>,
        io,
      ),
    )
  bay
    .command("submit [selector...]")
    .description("submit bays or branches")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option("--correlation <namespace:id>", "bind an opaque correlation to the submitted revision")
    .option("--composition <path>", "immutable version-1 source composition JSON")
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyPrSelectionVerb(installed(), installedServices(), selectors, options, io, "bay.submit")),
    )
  bay
    .command("close [selector...]")
    .description("close work bays (checks bay status first; needs --force to override)")
    .option("--withdraw", "withdraw a live PR before closing")
    .option("--force", "bypass bay status (requires explicit bay name; prints what is destroyed)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => closeBays(installed(), installedServices(), selectors, options, io))
  bay
    .command("status [selector...]")
    .description("safety oracle: is this bay safe to remove? (exit 0=safe 1=not-safe 2=unknown)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await bayStatusCommand(installed(), selectors, options, io)))
  program
    .command("log")
    .description("show queue history, newest first")
    .option("--base <branch>", "scope log to one base branch")
    .option("--pr <pr>", "scope log to one PR")
    .option("--failed", "show rejected history only")
    .option("--since <duration>", "show history within a duration")
    .option("-L, --limit <count>", "limit history rows", int, 20)
    .option("--all", "show all rows; include lossless queue and run records in JSON")
    .option("--json", "emit stable JSON")
    .action(async (options) => logRuns(installed(), [], options, io, installedServices()))

  program
    .command("watch [filter...]")
    .description("alias for queue ls --watch")
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope watch to one PR")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each PR")
    .option("--json", "emit stable JSON")
    .action(async (filters, options) => {
      setExit(await watchQueue(installed(), filters, options, io, installedServices()))
    })

  program
    .command("submit [selector...]")
    .description("submit a merge request (also called a pull request or PR) into the merge queue")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option("--correlation <namespace:id>", "bind an opaque correlation to the submitted revision")
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after submit (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--keep-on-failure", "retain a failed client-side required-check workspace for inspection")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyPrSelectionVerb(installed(), installedServices(), selectors, options, io, "pr.submit")),
    )

  program
    .command("cancel <selector>")
    .description(
      "stop the current attempt for a merge request or run — members re-queue and the merge request stays open; to stop delivering it, use `yrd mr close --reason` (run both for both effects)",
    )
    .option("--reason <text>", "human-readable cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await cancelAttempt(installed(), selector, options, io)))

  program
    .command("prime")
    .description("brief the current Yrd delivery state")
    .option("--json", "emit stable JSON")
    .action(async (options) => primeYrd(installed(), options, io))

  const deployment = program.command("deployment").description("manage immutable runtime deployments")
  deployment.helpCommand(false)
  deployment
    .command("materialize <deployment> <generation> <sha>")
    .description("materialize and provision one fresh pinned-SHA runtime path")
    .requiredOption("--pin <provenance>", "source pin provenance: tip or last-green")
    .option("--json", "emit stable JSON")
    .action(async (deploymentId, generation, sha, options) =>
      materializeDeployment(
        installed(),
        deploymentId,
        generation,
        sha,
        options as JsonOption & Readonly<{ pin: string }>,
        io,
      ),
    )
  deployment
    .command("reap <deployment> <generation> <sha>")
    .description("reap an unpublished failed deployment using its exact materialization input")
    .requiredOption("--pin <provenance>", "source pin provenance: tip or last-green")
    .option("--json", "emit stable JSON")
    .action(async (deploymentId, generation, sha, options) =>
      reapDeployment(installed(), deploymentId, generation, sha, options as JsonOption & Readonly<{ pin: string }>, io),
    )
  deployment
    .command("release <deployment-receipt> <hab-release-receipt>")
    .description("release an exact deployment after a matching Hab generation-death receipt")
    .option("--json", "emit stable JSON")
    .action(async (deploymentReceipt, habReleaseReceipt, options) =>
      releaseDeployment(installed(), deploymentReceipt, habReleaseReceipt, options, io),
    )

  const queue = program.command("queue").description("manage integration queues")
  queue.helpCommand(false)
  const listQueue = async (filters: string[], options: QueueListOptions): Promise<void> => {
    if (options.check === true) {
      if (options.watch === true || filters.length > 0) usage("queue list --check does not accept --watch or filters")
      setExit(await checkQueueRunner(runtimeApp, installedServices(), options, io))
      return
    }
    if (options.watch === true) {
      setExit(await watchQueue(installed(), filters, options, io, installedServices()))
      return
    }
    await listQueues(installed(), filters, options, io, installedServices())
  }
  queue
    .command("_list [filter...]", { isDefault: true, hidden: true })
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope the queue timeline to one PR")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each PR")
    .option("--watch", "keep this projection live and interactive")
    .option("--check", "probe resident lease, heartbeat, baseline health, and Git distance")
    .option("--json", "emit stable JSON")
    .action(listQueue)
  queue
    .command("list [filter...]")
    .description("show the queue timeline")
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope the queue timeline to one PR")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each PR")
    .option("--watch", "keep this projection live and interactive")
    .option("--check", "probe resident lease, heartbeat, baseline health, and Git distance")
    .option("--json", "emit stable JSON")
    .action(listQueue)
  queue
    .command("audit")
    .description("check queue state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueAudit(installed(), installedServices(), options, io)))
  queue
    .command("uncarried")
    .description("find refs pushed to the remote that no merge request carries")
    .option("--base <branch>", "base branch the refs are judged against")
    .option("--namespace <ref>", "ref namespace to sweep")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueUncarried(installed(), options, io)))
  queue
    .command("pause [base]")
    .description("pause new queue runs")
    .option("--reason <text>", "record the pause reason")
    .option("--for <duration>", "required hold TTL, such as 30m, 6h, or 1d")
    .option("--allow [pr...]", "PR ids allowed through the pause")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => pauseQueue(installed(), base, options, io))
  queue
    .command("resume [base]")
    .description("resume a paused queue")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => resumeQueue(installed(), base, options, io))
  queue
    .command("recover")
    .description(
      "recover expired runner leases and settle orphaned runs whose step never started; --runner force-settles a known-dead runner's unexpired leases too",
    )
    .option("--reason <text>", "record the recovery reason")
    .option("--runner <id>", "force-settle this known-dead runner's leases now, even if unexpired")
    .option("--json", "emit stable JSON")
    .action(async (options) => recoverQueue(installed(), installedServices(), options, io))
  queue
    .command("run [selector...]")
    .description("drain the queue — resident follow by default; --once or PR selectors for a single pass")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--once", "drain the default queue exactly once, then exit")
    .option("--interval <seconds>", "follow-mode poll interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      const mode = invocation.queueRunMode
      if (mode === undefined) throw new Error("yrd: normalized queue run mode is missing")
      const gate = () =>
        requireFreshInstalledBaseline(
          installedServices(),
          mode === "follow"
            ? { reloadInPlace: bootstrap === undefined ? {} : { request: requestYrdRuntimeReload } }
            : {},
        )
      if (mode === "follow") {
        setExit(await followQueueRuns(installed(), selectors, options, io, gate, installedServices()))
        return
      }
      await gate()
      const app = installed()
      const publications = await preparePublicationQueueCycle(app, installedServices(), io)
      if (publications.length > 0) await gate()
      const runs = await runQueues(app, selectors, options, io)
      const selectedPrIds =
        selectors.length === 0 ? undefined : new Set(selectors.map((selector) => requiredPr(app, selector).id))
      const blocked = admissionBlockedPrs(app, selectedPrIds)
      const blockerText = blocked.map(({ eligibility }) => eligibility.reason?.message).join("\n")
      const human =
        blocked.length === 0
          ? createElement(QueueRunsView, { runs })
          : runs.length === 0
            ? blockerText
            : createElement(Fragment, null, createElement(QueueRunsView, { runs }), "\n", blockerText)
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "queue.run",
          publications: publications.map((job) => ({ ...job, projection: projectPublication(job) })),
          results: runs.map(projectQueueRunTaskStatus),
          ...(blocked.length === 0
            ? {}
            : {
                blocked: blocked.map(({ pr, eligibility }) => ({
                  pr: projectPrTaskStatusWithEligibility(pr, eligibility),
                  eligibility: projectEligibilityTaskStatus(eligibility),
                })),
              }),
        },
        human,
      )
      const publicationFailed = publications.some((job) => job.status !== "completed" || job.conclusion !== "success")
      setExit(publicationFailed || runs.some(Queues.failed) ? 1 : 0)
    })
  queue
    .command("cancel <run>")
    .description("cancel a running or waiting queue run and leave its PRs submitted")
    .option("--reason <text>", "record the cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (run, options) => setExit(await cancelQueueRun(installed(), run, options, io)))
  queue
    .command("finish <selector>")
    .description("resume a waiting step")
    .option("--step <name>", "waiting step name")
    .option("--ok", "record a passing result")
    .option("--fail", "record a failing result")
    .option("--job <id>", "waiting-job id")
    .option("--runner <runner>", "waiting-job runner identity")
    .option("--attempt <attempt>", "waiting-job attempt number")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => finishQueue(installed(), selector, options, io))
  addQueueExamples(queue, name)

  addRootBayCommands(program, installed, installedServices, io, setExit)

  // `mr` is the printed name; `pr` is the permanent ruled alias (I23: "the
  // `yrd mr` family becomes primary; `yrd pr *` continues working forever").
  const pr = program
    .command("mr")
    .alias("pr")
    .description(
      "manage merge requests, also called pull requests or PRs (a branch selector targets the live delivery; address a terminal merge request by its id)",
    )
  pr.helpCommand(false)
  const list = pr
    .command("list")
    .description("list pull requests")
    .option("--base <branch>", "scope PRs to one base")
    .option("--state <state>", "scope PRs to one native or projected state")
    .option("--issue <ref>", "scope PRs to one issue reference")
    .option("--needs-review", "show revisions needing approval")
    .option("--reviewer <reviewer>", "scope --needs-review to one requested reviewer")
    .option("--json", "emit stable JSON")
    .action(async (options) => listPrs(installed(), options, io))
  list.addHelpSection(
    "Status fields:",
    [
      "state — answers: is the PR record open or closed? tense: current",
      "status — answers: what delivery result should a reader act on? tense: current",
      "nativeStatus — answers: what delivery status did the rebuildable index record? tense: historical",
      "taskStatus — answers: how does this delivery map to the shared work-state vocabulary? tense: current",
      "eligibility.reason.code — answers: why can the current revision not run now? tense: current",
      "landedOnBase.code — answers: why did repository proof override nativeStatus? tense: current",
      "--state needs-author — answers: has this PR ever needed author action? tense: historical",
    ].join("\n"),
  )
  const create = pr
    .command("create [selector]")
    .description("create a draft PR without requesting required checks")
    .option("--base <branch>", "base branch for a direct branch create")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option("--correlation <namespace:id>", "bind an opaque correlation to the draft revision")
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after create (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(
        await applyPrSelectionVerb(
          installed(),
          installedServices(),
          selector === undefined ? [] : [selector],
          options,
          io,
          "pr.create",
        ),
      ),
    )
  addAuthoredCarrierWorkflow(create, name)
  pr.command("submit [selector...]")
    .description("submit PR revisions after the managed local required-check hook")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option("--correlation <namespace:id>", "bind an opaque correlation to the submitted revision")
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after submit (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--keep-on-failure", "retain a failed client-side required-check workspace for inspection")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyPrSelectionVerb(installed(), installedServices(), selectors, options, io, "pr.submit")),
    )
  pr.command("view <selector>")
    .description("show a PR and its runs")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPr(installed(), selector, options, io, installedServices()))
  pr.command("runs <selector>")
    .description("show run, step, attempt, proof, and artifact detail")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPrRuns(installed(), selector, options, io, installedServices()))
  pr.command("diff <selector>")
    .description("show the candidate diff")
    .option("--stat", "show diff statistics")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => diffPr(installed(), selector, options, io))
  pr.command("checkout <selector>")
    .description("materialize a bay from a PR revision head (detached HEAD)")
    .option("--bay <name>", "name the new bay")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => checkoutPr(installed(), selector, options, io))
  pr.command("status")
    .description("show the current bay or branch PR")
    .option("--json", "emit stable JSON")
    .action(async (options) => statusPr(installed(), options, io, installedServices()))
  pr.command("edit <selector>")
    .description("edit the issue link, note, title, description, or branch tracking")
    .option("--issue <ref>", "set the tracker-neutral issue reference")
    .option("--note <text>", "set the delivery note")
    .option("--title <text>", "set the PR subject")
    .option("--description <text>", "set the PR description body")
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--untrack", "stop tracking: a stale head again blocks the recut")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => editPr(installed(), selector, options, io))
  // Off the help surface (I23: "recut disappears — resubmitting is submit
  // again"); the verb keeps working for the flows that learned it.
  const recut = pr
    .command("recut <selector>", { hidden: true })
    .description("recut a merge request revision onto the current base")
    .option("--revision <number>", "select an older immutable PR revision", int)
    .option("--ref <ref>", "certify an independently authored candidate commit")
    .option("--preflight", "classify recut, withdraw, force, or no-op without changing anything")
    .option("--apply", "execute the regenerative verdict computed by --preflight")
    .option("--queue", "submit the fresh revision and request its configured checks")
    .option("--force", "recut even when the current revision already passed its checks")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(await recutPr(installed(), installedServices(), selector, options, io)),
    )
  addAuthoredCarrierWorkflow(recut, name)
  // Hidden with recut: the draft story is `create` = draft, `submit` = ready.
  pr.command("publish <selector>", { hidden: true })
    .description("request credential-bearing publication of one immutable PR revision")
    .option("--queue", "recut and queue the revision after publishing succeeds")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => publishPr(installed(), installedServices(), selector, options, io))
  pr.command("ready <selector>", { hidden: true })
    .description("submit a pushed PR revision and request configured checks")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(await readyPr(installed(), installedServices(), selector, options, io)),
    )
  pr.command("review <selector>")
    .description("record a revision-bound review verdict")
    .option("--approve", "approve the current revision")
    .option("--reject", "reject the current revision")
    .option("--by <identity>", "reviewer identity")
    .option("--ref <id>", "idempotency reference")
    .option("--note <text>", "review note")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => reviewPr(installed(), selector, options, io))
  pr.command("request-review <selector> [reviewers...]")
    .description("replace the requested reviewers for a PR (declarative set)")
    .option("--clear", "clear the requested reviewer set")
    .option("--by <identity>", "requesting identity")
    .option("--json", "emit stable JSON")
    .action(async (selector, reviewers, options) => requestReviewPr(installed(), selector, reviewers, options, io))
  pr.command("comment <selector>")
    .description("record a non-gating revision comment")
    .option("--by <identity>", "commenter identity")
    .option("--ref <id>", "idempotency reference")
    .requiredOption("--note <text>", "comment text")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => commentPr(installed(), selector, options, io))
  pr.command("checks <selector...>")
    .description("show required-check evidence for current PR revisions")
    .option("--follow", "follow active checks to a terminal result")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await prChecks(installed(), selectors, options, io)))
  pr.command("regression <selector>")
    .description("record one completed escaped regression and its integrated repair")
    .requiredOption("--run <run>", "original integration run")
    .requiredOption("--detected-at <timestamp>", "ISO-8601 detection timestamp")
    .requiredOption("--severity <severity>", "low, medium, high, or critical")
    .requiredOption("--evidence <ref>", "opaque regression evidence reference")
    .requiredOption("--implementation-run <ref>", "opaque original implementation run reference")
    .requiredOption("--review <ref>", "opaque original review reference")
    .requiredOption("--repair-pr <pr>", "integrated repair PR")
    .requiredOption("--repair-run <run>", "repair integration run")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      recordPrRegression(installed(), selector, options as unknown as PrRegressionOptions, io),
    )
  pr.command("close [selector...]")
    .description("close a live merge request without merging — records why, leaves the queue")
    .option("--reason <text>", "close rationale recorded on each pr/withdrawn event")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => withdrawPrs(installed(), selectors, options, io, "pr.close"))
  // Hidden ruled alias of `close` — one act, two spellings (I23); the envelope
  // keeps its stable pr.withdraw name for journal consumers.
  pr.command("withdraw <selector...>", { hidden: true })
    .description("withdraw live PRs from delivery, recording the reason")
    .option("--reason <text>", "withdrawal rationale recorded on each pr/withdrawn event")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => withdrawPrs(installed(), selectors, options, io))
  pr.command("merge <selector>")
    .description("teach that the queue is the only merger")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await refusePrMerge(installed(), selector, options, io)))

  const migrate = program.command("migrate").description("run explicit journal compatibility migrations")
  migrate.helpCommand(false)
  migrate
    .command("terminal-associations")
    .description("prove and append legacy rejected-PR Queue run associations")
    .option("--apply", "append every uniquely proven association")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await migrateTerminalAssociations(installed(), options, io)))

  program
    .command("check <name...>")
    .description("run configured required checks in the current working tree")
    .option("--json", "emit stable JSON")
    .action(async (names, options) => checkRequired(installedServices(), names, options, io))

  const admin = program.command("admin").description("perform infrequent repository and state administration")
  admin.helpCommand(false)
  admin
    .command("init")
    .description("scaffold .yrd.yml and install the managed pre-submit hook")
    .option("--json", "emit stable JSON")
    .action(async (options) => initYrdConfig(installedServices(), options, io))
  const adminQueue = admin.command("queue").description("administer queue resources")
  adminQueue
    .command("init [base]")
    .description("prepare queue resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => queueAdministration(installed(), installedServices(), "init", base, options, io))
  adminQueue
    .command("deinit [base]")
    .description("release queue resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => queueAdministration(installed(), installedServices(), "deinit", base, options, io))
  const adminBay = admin.command("bay").description("administer work bays")
  adminBay
    .command("prune")
    .description("report (default) or close every bay classified PRUNE")
    .option("--apply", "actually close PRUNE bays (default is dry-run)")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await bayPruneCommand(installed(), installedServices(), options, io)))
  const adminPr = admin.command("pr").description("administer pull requests")
  adminPr
    .command("prune")
    .description("withdraw live PRs whose content their base branch already contains")
    .option("--dry-run", "print every checked verdict without withdrawing")
    .option("--json", "emit stable JSON")
    .action(async (options) => prunePrs(installed(), options, io))
  const adminJournal = admin.command("journal").description("administer the durable journal")
  adminJournal
    .command("bump <version>")
    .description("one-way raise the journal version floor after a tested snapshot restore")
    .option("--json", "emit stable JSON")
    .action(async (version, options) => {
      const parsed = Number(version)
      if (!Number.isSafeInteger(parsed) || parsed < 1) usage("journal bump version must be a positive integer")
      await bumpJournal(installedServices(), parsed, options, io)
    })
  adminJournal
    .command("import-orphan <source>")
    .description("archive preserved v3 rows without replaying them as live entries")
    .option("--json", "emit stable JSON")
    .action(async (source, options) => journalImportOrphan(installedServices(), source, options, io))
  const adminSubmodule = admin.command("submodule").description("administer submodule tracking")
  adminSubmodule
    .command("init")
    .description("set submodule.<name>.branch for submodules not yet tracking one")
    .option("--dry-run", "print what would be set without writing .gitmodules")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await initSubmoduleTracking(options, io)))

  const issue = program.command("issue").description("inspect tracker-neutral issue delivery")
  issue.helpCommand(false)
  issue
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listIssues(installed(), options, io))
  issue
    .command("view <issue>")
    .description("show Yrd delivery records joined to an issue")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => listIssues(installed(), options, io, issueId))
  issue
    .command("ensure <issue>")
    .description("ensure one issue-owned Bay and one tracked draft PR")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => setExit(await ensureIssueDelivery(installed(), issueId, options, io)))

  const contest = program.command("contest").description("inspect and select contest attempts")
  contest.helpCommand(false)
  contest
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listContests(installed(), options, io))
  contest
    .command("open <issue>")
    .description("compare implementations of one real issue")
    .option("--competitors <json>", "opaque competitor id, runner port, and config entries")
    .option("--evaluators [evaluator...]", "evaluator ids, comma-separated or repeated")
    .option("--base <branch>", "base branch")
    .option("--queue <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => setExit(await openContest(installed(), issueId, options, io)))
  contest
    .command("eval <contest>")
    .description("run pending work and evaluators")
    .option("--retry", "retry failed work or re-evaluate failed verdicts")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await evalContest(installed(), contestId, options, io)))
  contest
    .command("finish <contest>")
    .description("finish a waiting evaluator")
    .option("--attempt <attempt>", "contest attempt id")
    .option("--evaluator <evaluator>", "evaluator id")
    .option("--ok", "record a passing evaluator verdict")
    .option("--fail", "record a failing evaluator verdict")
    .option("--error <code>", "record an evaluator infrastructure failure")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result summary")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => finishContest(installed(), contestId, options, io))
  contest
    .command("view <contest>")
    .description("show attempts, metrics, and evidence")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => viewContest(installed(), contestId, options, io))
  contest
    .command("select <contest>")
    .description("select a winner")
    .option("--winner <attempt>", "winning attempt id")
    .option("--by <identity>", "selector identity")
    .option("--reason <text>", "selection rationale")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => selectContest(installed(), contestId, options, io))
  contest
    .command("promote <contest>")
    .description("submit the selected Git pin")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await promoteContest(installed(), contestId, options, io)))

  const intent = program.command("intent").description("declare and inspect component pin advances")
  intent.helpCommand(false)
  intent
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listIntents(installed(), options, io))
  intent
    .command("submit")
    .description("declare that a component pin should advance")
    .option("--component <path>", "root-relative gitlink path, e.g. components/alpha")
    .option("--target <sha>", "component commit to advance to; omit for the component main tip at landing")
    .option("--issue <ref>", "tracker-neutral issue reference")
    .option("--expect-pin <sha>", "stop unless the current pin is exactly this sha")
    .option("--allow-off-trunk", "declare a deliberate pin onto a target the component trunk does not contain")
    .option("--submitter <identity>", "attribution recorded on the intent")
    .option("--base <branch>", "base branch whose pin the target advances")
    .option("--force", "explicitly supersede another submitter's live intent")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await submitIntent(installed(), installedServices(), options, io)))
  intent
    .command("tombstone")
    .description("record a rolled-back pin whose descendants must not re-enter")
    .option("--component <path>", "root-relative gitlink path")
    .option("--sha <commit>", "rolled-back component commit")
    .option("--issue <ref>", "rollback or incident issue reference")
    .option("--submitter <identity>", "attribution recorded on the tombstone")
    .option("--reason <text>", "why the pin was rolled back")
    .option("--json", "emit stable JSON")
    .action(async (options) => tombstoneIntent(installed(), options, io))
  intent
    .command("list")
    .description("all accepted records, in the order they were submitted")
    .option("--json", "emit stable JSON")
    .action(async (options) => listIntents(installed(), options, io))
  intent
    .command("show <intent>")
    .description("record, preconditions, and disposition; <intent> is yrdpin#162 or just 162")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await showIntent(installed(), selector, options, io)))
  intent
    // `close` is the printed spelling; `withdraw` keeps working for anyone who
    // learned it, the same way the retired status words still parse.
    .command("close <intent>")
    .silentAlias("withdraw")
    .description("close an open intent; <intent> is yrdpin#162 or just 162")
    .option("--reason <text>", "why the intent is closed")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => withdrawIntent(installed(), selector, options, io))
  intent
    .command("materialize <component>")
    .description("materialize the queue's deterministic pin branch on a new local branch")
    .option("--target <sha>", "component commit to advance to")
    .option("--issue <ref>", "issue identity embedded in the deterministic commit")
    .option("--base <branch>", "base branch to materialize against")
    .option("--branch <branch>", "local branch to create; defaults to a deterministic yrd/intent name")
    .option("--json", "emit stable JSON")
    .action(async (component, options) => materializeIntent(component, installedServices(), options, io))

  const order = new Map(
    [
      "mr",
      "bay",
      "intent",
      "issue",
      "contest",
      "queue",
      "check",
      "doctor",
      "why",
      "admin",
      "migrate",
      "log",
      "watch",
      "prime",
    ].map((command, index) => [command, index]),
  )
  const orderedCommands = program.commands as unknown as CliCommand[]
  orderedCommands.sort((left, right) => (order.get(left.name()) ?? 99) - (order.get(right.name()) ?? 99))
  addExamples(program, name)
  configureOutput(program, io, commanderOutput)
  return program
}

function commanderErrorMessage(command: CliCommand | undefined, error: CommanderError): string {
  const removedDraftSubmit =
    command?.name() === "submit" &&
    error.code === "commander.unknownOption" &&
    error.message.includes("unknown option '--draft'")
  return removedDraftSubmit ? `${error.message}; draft PRs are created with 'yrd pr create'` : error.message
}

function commandPath(command: CliCommand | undefined, fallback: string): string {
  if (command === undefined) return fallback
  const names: string[] = []
  for (
    let cursor: CliCommand | null | undefined = command;
    cursor !== null && cursor !== undefined;
    cursor = cursor.parent as CliCommand | null | undefined
  ) {
    if (!cursor.name().startsWith("_")) names.unshift(cursor.name())
  }
  return names.join(" ")
}

function conciseCommanderCause(error: CommanderError, helpCommand: string): string {
  const line = error.message
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^error:\s*/u, "")
    .replace(/\(Did you mean ([\w-]+)\?\)/u, "(Did you mean '$1'?)")
  const hiddenDefault = /^too many arguments for '_[^']+'.*got (\d+): (.+)$/u.exec(line)
  const hiddenDefaultOperands = hiddenDefault?.[2]?.replace(/\.$/u, "")
  const hiddenDefaultOperand =
    hiddenDefault === null
      ? undefined
      : hiddenDefault[1] === "1"
        ? hiddenDefaultOperands
        : hiddenDefaultOperands?.split(", ", 1)[0]
  if (hiddenDefaultOperand !== undefined) {
    return `unknown command '${hiddenDefaultOperand}' (Run '${helpCommand} --help' for available commands.)`
  }
  if (error.code !== "commander.unknownCommand" || line.includes("(Did you mean ")) return line
  return `${line} (Run '${helpCommand} --help' for available commands.)`
}

function commandOption(command: CliCommand, token: string) {
  const separator = token.indexOf("=")
  const flag = separator === -1 ? token : token.slice(0, separator)
  for (
    let cursor: CliCommand | null | undefined = command;
    cursor !== null && cursor !== undefined;
    cursor = cursor.parent as CliCommand | null | undefined
  ) {
    const option = cursor.options.find((candidate) => candidate.short === flag || candidate.long === flag)
    if (option !== undefined) return option
  }
  return undefined
}

function childCommand(command: CliCommand, token: string): CliCommand | undefined {
  return command.commands
    .map((candidate) => candidate as unknown as CliCommand)
    .find((candidate) => candidate.name() === token || candidate.aliases().includes(token))
}

/** Derive output mode from the same Commander option tree that parses the
 * invocation. A token consumed as a required option value is not a JSON flag. */
function jsonOutputRequested(program: CliCommand, args: readonly string[]): boolean {
  let command = program
  let consumesValue = false
  for (const token of args) {
    if (consumesValue) {
      consumesValue = false
      continue
    }
    if (token === "--") break
    if (token === "--json") return true
    if (token.startsWith("-")) {
      const option = commandOption(command, token)
      consumesValue = option?.required === true && !token.includes("=")
      continue
    }
    command = childCommand(command, token) ?? command
  }
  return false
}

/** Cold-path fallback for host failures outside the normal command catcher.
 * It still uses the canonical Commander definition rather than reparsing argv. */
export function yrdJsonOutputRequested(argv: readonly string[]): boolean {
  const invocation = normalizeYrdInvocation(argv)
  const io: YrdCliIO = { stdout() {}, stderr() {} }
  const program = buildProgram(undefined, {}, invocation.name, io, () => undefined, {}, invocation)
  return jsonOutputRequested(program, invocation.args)
}

/** Run the one Yrd command surface. */
async function executeYrd(
  app: YrdCliApp | undefined,
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
  bootstrap?: RuntimeBootstrap,
): Promise<YrdCliExitCode> {
  const invocation = normalizeYrdInvocation(argv)
  if (invocation.args.length === 1 && (invocation.args[0] === "--version" || invocation.args[0] === "-V")) {
    io.stdout(`${formatYrdRuntimeVersion()}\n`)
    return 0
  }
  let exit: YrdCliExitCode = 0
  const setExit = (code: YrdCliExitCode) => {
    exit = maxExit(exit, code)
  }
  const runtimeIO: YrdCliIO = { ...io }
  const separator = invocation.args.indexOf("--")
  if (separator >= 0) {
    ;(runtimeIO as RuntimeInvocationIO)[RuntimeChildArgv] = invocation.args.slice(separator + 1)
  }
  const commanderOutput: CommanderOutput = {}
  const program = buildProgram(
    app,
    services,
    invocation.name,
    runtimeIO,
    setExit,
    commanderOutput,
    invocation,
    bootstrap,
  )
  const canonicalArgs = invocation.args
  const args =
    canonicalArgs.length === 1 && (canonicalArgs[0] === "pr" || canonicalArgs[0] === "mr")
      ? [canonicalArgs[0], "--help"]
      : canonicalArgs
  try {
    await program.parseAsync(args, { from: "user" })
    return exit
  } catch (error) {
    if (invocation.queueRunnerCheck) {
      return checkQueueRunner(
        undefined,
        {
          queue: {
            auditEnvironment: () => Promise.reject(error),
          },
        },
        { json: jsonOutputRequested(program, args) },
        runtimeIO,
      )
    }
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === "commander.helpDisplayed") return 0
      const message = commanderErrorMessage(commanderOutput.errorCommand, error)
      await diagnostic(
        runtimeIO,
        createFailure(
          {
            kind: "usage",
            code: "invalid-arguments",
            message,
          },
          error,
        ),
        {
          json: jsonOutputRequested(program, args),
          humanCause: conciseCommanderCause(error, commandPath(commanderOutput.errorCommand, invocation.name)),
        },
      )
      return 2
    }
    const { exitCode } = classifyFailure(error)
    const globals = program.opts() as Readonly<{ verbose?: number }>
    await diagnostic(runtimeIO, error, {
      json: jsonOutputRequested(program, args),
      verbose: (globals.verbose ?? 0) > 0,
    })
    return exitCode
  }
}

/** Recognize the one process invocation allowed to bypass app/journal bootstrap. */
export function yrdQueueRunnerCheckRequested(argv: readonly string[]): boolean {
  return normalizeYrdInvocation(argv).queueRunnerCheck
}

/** Render command metadata without creating a repository-backed runtime. */
export function runYrdHelp(argv: readonly string[], io: YrdCliIO): Promise<YrdCliExitCode> {
  return executeYrd(undefined, argv, io, {})
}

/** Initialize the process-owned runtime from the one parsed global context. */
export function runYrdProcessRuntime(
  argv: readonly string[],
  io: YrdCliIO,
  bootstrap: RuntimeBootstrap,
): Promise<YrdCliExitCode> {
  return executeYrd(undefined, argv, io, {}, bootstrap)
}

/** Run the one Yrd command surface. */
export function runYrd(
  app: YrdCliApp,
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
): Promise<YrdCliExitCode> {
  return executeYrd(app, argv, io, services)
}
