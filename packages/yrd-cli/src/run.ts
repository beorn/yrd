import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Command as CliCommand, CommanderError, int } from "@silvery/commander"
import { Fragment, createElement } from "react"
import * as z from "zod"
import {
  CompositionV1Schema,
  ChangePropsSchema,
  DeploymentInputSchema,
  DeploymentSourceResultSchema,
  baseIdentity,
  currentChangeRev,
  changeBaseSha,
  changeComposition,
  changeProps,
  changeDeliveryState,
  changeHead,
  isLiveChange,
  isTracked,
  changeNeedsAuthor,
  changeRevisionNumber,
  changeRevisionLineage,
  changePublicationJobKey,
  ChangePublicationInputSchema,
  changeSourceReadyAt,
  deploymentJobKey,
  HabGenerationReleaseResultSchema,
  ReleaseDeploymentJobInputSchema,
  isConcurrentCheckabilityConflict,
  resolveBay,
  resolveBase,
  hasChangeRecord,
  needsReview,
  resolveChange,
  resolveChangeMatch,
  requireLiveChange,
  getChangeRecord,
  type Bay,
  type BaysState,
  type CompositionV1,
  type ChangeProps,
  type Change,
  type ChangeFreshnessTransition,
  type ChangeDeliveryState,
  type ChangeRev,
  type ChangePublicationInput,
  type DerivedSubmission,
  type MaterializeDeploymentInput,
  type ReleaseDeploymentJobInput,
  recordChanges,
  recordChangeCount,
} from "@yrd/bay"
import { CompetitorDefSchema, type CompetitorDef, type Contest } from "@yrd/contest"
import {
  compareNatural,
  createConditionReporter,
  createFailure,
  failureFact,
  raiseFailure,
  SUPPORTED_VERSIONS,
  type ConditionReporter,
  type DeepReadonly,
  type JournalSnapshot,
} from "@yrd/core"
import { isConcurrentSettlementConflict } from "@yrd/job"
import type { Job, JobErrorFact } from "@yrd/job"
import {
  adaptProcessGit,
  cleanGitEnvironment,
  createProcess,
  observePidSync,
  pathReapDeletionFailure,
  type GitSyncReadCommand,
  recordedPidIsRunning,
  recordedPidLiveness,
  recordedPidLivenessSync,
  type Process,
  type ProcessResult,
} from "@yrd/process"
import { resolveSubmoduleOrigin } from "git-super/submodule-origin"
import {
  type MergeRecordEstateRepair,
  isQueueRunningConflict,
  CANDIDATE_REF_RETENTION_MS,
  candidateRefDenominator,
  InstalledStepSchema,
  IntentRecordIdSchema,
  isDerivedRunMember,
  MERGE_RECORD_REF,
  mergeJoinedNothing,
  mergeRecordToStatement,
  Queues,
  pruneCandidateRefs,
  sweepCandidateRefs,
  applyHostFindingFilter,
  parseSubmoduleModelChangeAuthorizationValue,
  sweepStrandedRefs,
  type CandidateRefSweepResult,
  type ChangeSnapshot,
  type QueueRecord,
  type QueuesState,
  type InTotoStatement,
  type MergeRecordBody,
  type ChangeEligibility,
  type UnverifiableMergeRecord,
  type RefGit,
  type QueueAuditFinding,
  type QueueSummary,
  type Run,
  carriedBranches,
  queueChangeNotFoundMessage,
  queueChanges,
  resolveQueueChange,
} from "@yrd/queue"
import { createExclusive } from "@yrd/persistence"
import {
  DEFAULT_DRAFT_PAGE_AFTER_HOURS,
  loadYrdConfig,
  renderYrdConfigScaffold,
  type ResolvedYrdProjectConfig,
} from "./config.ts"
import { actionableFailure, formatActionableFailure, redeliveryRefusedByDelivery } from "./actionable-error.ts"
import { INSTALLED_PLAN_STALE_RESOLUTION, RUN_PLAN_MISMATCH_RESOLUTION } from "./plan-audit.ts"
import {
  MAX_CONSECUTIVE_RUNTIME_RELOADS,
  YRD_RUNTIME_RELOADS_ENV,
  runtimeReloadLineage,
  withRuntimeReloads,
  type RuntimeReloadLineage,
} from "./runtime-reload.ts"
import {
  classifyFailure,
  configureYrdGlobalOptions,
  configuration,
  normalizeYrdInvocation,
  refusal,
  refuseShadowedQueueFilterTerms,
  resolveYrdContext,
  stableJson,
  usage,
  type NormalizedYrdInvocation,
  type RuntimePosture,
  type YrdContext,
} from "./invocation.ts"
import { requireUnqualifiedRunSelector, resolveCanonicalRunSelector } from "./qualified-run-ref.ts"
import { observeLiveBranch, requireObservedBranchHead } from "./remote-branch.ts"
import { getLiveRenderer } from "./live-renderer.ts"
import {
  type ChangeCheckViewRecord,
  type QueueLogCoverage,
  latestRunForCurrentRevision,
  projectedChangeStatus,
  queuePauseWarnings,
  queueRunRevisionReads,
  queueTimelineAdmissionTimes,
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  RUNNER_STALE_MS,
  runRevisionClock,
  type QueueAttempt,
  type QueueRunnerAbsence,
  type QueueRunnerRefusal,
  QueueRunnerProgress,
  type QueueDriverEpoch,
  type QueueTimelineStatusFilter,
  type HabitantInstalledPlan,
  type RunnerSourcePin,
  type StrandedObservation,
  strandedCoverageFloor,
  strandedDenominator,
  strandedFloorCount,
  strandedObservation,
  type QueueStatusResult,
} from "@yrd/queue"
import {
  QueueLogView,
  ChangeChecksView,
  ChangeDetailView,
  ChangeListView,
  ChangeRunsView,
  QueueRunsView,
  QueueTimelineView,
  QueueStatusView,
  type QueueLogRow,
  ChangeResultView,
  queueLogRows,
  changeListRows,
  ChangeDetailData,
  createQueueTimelineProjectionClock,
  queueShowData,
  type QueueTimelineProjection,
  type QueueTimelineRunner,
} from "./queue-status-view.tsx"
import type { QueueReadModel } from "./queue-read-model.ts"
import {
  preflightRemerge,
  prunePrs,
  withdrawOne,
  withdrawPrs,
  type RemergePreflightResult,
  type RemergePreflightVerdict,
} from "./pr-withdraw.ts"
import {
  foldRefusalStall,
  formatRemedyCommand,
  planRefusalRemedies,
  refusalRemedyKey,
  HABITANT_REFUSAL_STALL_CYCLES,
  type RefusalRemedyPlan,
  type RemedyStep,
  type HabitantRefusalObservation,
  type HabitantRefusalStall,
} from "./refusal-remedy.ts"
import { unobservableBranchRemedy } from "./remedy-admissibility.ts"
import { reconcileChangeMerges, type ChangeMerge } from "./pr-merged.ts"
import { projectHandoffReadyLanding } from "./bay-handoff-landing.ts"
import { requireImplicitRemergeBranchFreshness, type RemergeBranchFreshness } from "./recut-branch-freshness.ts"
import { resolveSubmitSelectors } from "./submit-selection.ts"
import { applyChangeState, changeStateDeps, type ChangeState } from "./change-state.ts"
import { lifecycleStatus } from "./status-presentation.ts"
import {
  classifyBayStatus,
  formatBayStatusHuman,
  parseOwnerPid,
  parseYrdBayProtections,
  protectionGapEvidenceForBay,
  protectionNotConsumedEvidenceForBay,
  protectionEvidenceForBay,
  freshOriginBranchMissing,
  YRD_BAY_PROTECTIONS_ENV,
  type BayStatusClass,
  type BayStatusFacts,
  type BayStatusReport,
  type BayStatusSubmoduleFacts,
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
  changeDeliveryTaskStatusOf,
  projectChangeTaskStatus,
  projectQueueRunTaskStatus,
  taskStatusFields,
} from "./task-status.ts"
import type {
  JournalRetentionObservation,
  JournalRetentionPolicy,
  QueueEnvironmentAuditComparison,
  YrdBayProtection,
  YrdCliApp,
  YrdCliExitCode,
  YrdCliGuardOutcome,
  YrdCliIO,
  YrdCliServices,
  YrdCliState,
} from "./types.ts"
import { formatYrdRuntimeVersion, YRD_VERSION, yrdSourceRoot } from "./version.ts"
import {
  decideHabitantSource,
  foldSourceStaleness,
  HABITANT_SOURCE_STALE_BEHIND,
  type HabitantSourceRecycle,
  type HabitantSourceStall,
} from "./source-staleness.ts"
import { HABITANT_EXIT } from "./habitant-exit.ts"
import { QUEUE_FATAL_EXIT, fatalQueueDrain } from "./queue-drain.ts"
import {
  decideHabitantMemory,
  foldMemoryCap,
  HABITANT_RSS_CAP_DEFAULT_MB,
  HABITANT_RSS_CAP_ENV,
  habitantMemoryObservation,
  type HabitantMemorySample,
  type HabitantMemoryStall,
} from "./habitant-memory.ts"
import { ensureWorkspaceDependencies } from "./workspace-provisioning.ts"
import { retainedWorkspaceNote } from "./workspace-retention.ts"
import { artifactLocation, directArtifacts, nestedArtifacts, uniqueArtifacts } from "./artifact-reference.ts"
import {
  addedSubmodulePins,
  authoredSubmodulePinBase,
  changedSubmodulePins,
  submodulePinPublications,
  unreachableSubmodulePins,
} from "./pr-submodule-publication.ts"
import { backwardGitlinkRefusal, gitlinkDirections, resolveBaseTip } from "./gitlink-forward-only.ts"
import {
  formatGitlinkAdvancePlan,
  gitlinkAdvanceName,
  materializeGitlinkTarget,
  planGitlinkAdvance,
  publishMinCommit,
  pushGitlinkAdvanceBranch,
  resolveSubmoduleOperand,
  writeGitlinkAdvanceCommit,
} from "./gitlink-advance.ts"
import { mergeAuthorityBoundary } from "./merge-authority-boundary.ts"
import { queueReadFailureMessage, type QueueReadFailure } from "./queue-read-failure.ts"
// The live watch UI is loaded lazily at its single use site in watchQueue(): it is the only
// module that pulls silvery's SplitPane, and eagerly importing it here would make every CLI
// path (yrd --version, submit, one-shot queue) require the interactive TUI dependency at module
// load. Types are erased, so they stay as a static type-only import.
import type { QueueArtifactOutput, QueueChangeDiff, QueueWatchFocus, QueueWatchSnapshot } from "./watch-pane.tsx"

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

const syncGitReader = adaptProcessGit(undefined, { timeoutMs: GIT_TIMEOUT_MS })

function localReadCommand(args: readonly string[]): GitSyncReadCommand {
  const [verb, ...rest] = args
  switch (verb) {
    case "rev-parse":
    case "for-each-ref":
    case "status":
    case "rev-list":
    case "merge-base":
    case "show":
    case "show-ref":
    case "cherry":
    case "diff":
    case "cat-file":
      return { verb, args: rest }
    case "stash":
      if (rest.length === 1 && rest[0] === "list") return { verb: "stash-list" }
      break
    case "branch":
      if (rest.length === 1 && rest[0] === "--show-current") return { verb: "branch-show-current" }
      break
    case "config": {
      const fileIndex = rest.indexOf("--file")
      const file = fileIndex < 0 ? undefined : rest[fileIndex + 1]
      const blobIndex = rest.indexOf("--blob")
      const blob = blobIndex < 0 ? undefined : rest[blobIndex + 1]
      const regexpIndex = rest.indexOf("--get-regexp")
      const pattern = regexpIndex < 0 ? undefined : rest[regexpIndex + 1]
      if (pattern !== undefined) {
        return {
          verb: "config-get-regexp",
          ...(file === undefined ? {} : { file }),
          ...(blob === undefined ? {} : { blob }),
          pattern,
        }
      }
      break
    }
  }
  throw new Error(`yrd: Git command is not a typed local read: ${args.join(" ")}`)
}

function gitSync(cwd: string, args: readonly string[]): string {
  const result = syncGitReader.readSync({ repo: cwd, command: localReadCommand(args) })
  if (result.timedOut === true) throw gitTimeoutError(args)
  if (result.code !== 0 || result.failure !== undefined) {
    throw Object.assign(new Error(result.stderr.trim() || result.failure || `git exited ${result.code}`), {
      status: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  }
  return result.stdout
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
 * `habitantRunnerStatus` sits on top of this, and `queueListSnapshot` calls that
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

/** One identity per queue. The journal lives under the git COMMON directory,
 * so every linked worktree of a repository reads and writes the SAME queue —
 * an identity derived from the invocation cwd made a worktree's yrd report the
 * habitant runner as owning a foreign queue (`/hh#main` vs
 * `/hh/.worktrees/hh-wt4#main`, 2026-08-16) while both were the one journal.
 * The path half is therefore the common dir's owning worktree, which is also
 * exactly what a habitant started in the main worktree has always recorded, so
 * existing heartbeats compare equal. Outside a repository the resolved path
 * stands in; the callers that reach that case already raise
 * `runner-health-unavailable` on the missing git dir. */
export function canonicalQueueId(path: string, base: string): string {
  const gitDir = queueGitDir(path)
  const owner = gitDir === undefined || basename(gitDir) !== ".git" ? resolve(path) : dirname(gitDir)
  return `${owner}#${base}`
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
    // `habitantRunnerLeaseHeld` and `runnerGitHealth` raise
    // `runner-health-unavailable` naming the cwd, and `habitantRunnerStatusPath`
    // returns undefined so `habitantRunnerStatus` answers "no habitant runner".
    // The only information discarded is git's wording of "not a repository".
    return undefined
  }
}

export const HABITANT_RUNNER_HEARTBEAT_MS = 5_000

/** How often the habitant follow loop runs its unscoped lease-expiry recovery
 * sweep (D1b). Startup reclaim is one-shot; this settles ghosts left by runners
 * that die AFTER it. A constant, not config — the throttle is measured in wall
 * time via `io.now`, so a busy tick cadence cannot starve or spam it. */
const HABITANT_RECOVERY_SWEEP_MS = 60_000
const HABITANT_MAINTENANCE_INTERVAL_MS = 60_000

/** Exit code when a hard signal cuts an unfinished drain short, leaving in-flight
 * work (D3). An operator-requested stop that FINISHES (drain complete) exits 0;
 * a signal-forced interruption exits non-zero so the habitant breaker records
 * the failure instead of mistaking interrupted work for a clean lifetime. */
const HABITANT_INTERRUPTED_EXIT: YrdCliExitCode = HABITANT_EXIT.interrupted
/** A habitant that restarts itself out of presumptive poisoned-observer state
 * (22474 specimen 3) still means "this runner stopped with queue work
 * outstanding" and still counts against the habitant breaker — but it says so
 * in its OWN code. The loud `resident-refusal-stall-restart` record remains the
 * detail; it is no longer the only thing that separates this from a signal. */
const HABITANT_POISONED_EXIT: YrdCliExitCode = HABITANT_EXIT.poisoned
/** A habitant that recycles itself onto a source its own checkout has moved past
 * (@yrd/core/stale-runner-never-recycles box 1). Its own code, for the same
 * reason as the poisoned exit above: the typed `resident-source-stale-restart`
 * record is the detail, and the supervisor — which has the code and not the
 * record — can now tell this apart from an interruption it should count
 * differently. */
const HABITANT_SOURCE_STALE_EXIT: YrdCliExitCode = HABITANT_EXIT["source-stale"]
/** A habitant that crossed its declared RSS cap and stood down at a cycle
 * boundary rather than waiting for the kernel's OOM killer to take it, and the
 * in-flight run with it. The one condition a fresh process does not by itself
 * cure, hence the only one dispositioned `restart-with-backoff`. */
const HABITANT_MEMORY_CAP_EXIT: YrdCliExitCode = HABITANT_EXIT["memory-cap"]
/** A habitant that recycles because the base tip's declared plan no longer
 * matches what this process installed at boot, and no in-place reload was
 * available to fix it live (23192 leg c). Its own code, for the same reason
 * as the source-stale exit above: the loud `resident-plan-stale-restart`
 * record is the detail, and this exit no longer shares `refusal`'s generic
 * code 1 with a genuine failure a supervisor should treat differently. */
const HABITANT_PLAN_STALE_EXIT: YrdCliExitCode = HABITANT_EXIT["installed-plan-stale"]
/** A habitant that stopped for its own ERROR row (operator ruling 2026-09-01:
 * any ERROR ends the pass). The host latches the row and aborts the drain
 * signal with the fatal cause as its reason; the loop reads that reason here,
 * finishes the run in flight exactly as an operator's drain would, and then
 * exits with the fatal code UNCLEAN — the heartbeat's exit marker must not
 * call a death "clean" because the runner happened to finish its run first. */
const HABITANT_FATAL_EXIT: YrdCliExitCode = QUEUE_FATAL_EXIT

/** Overrides {@link HABITANT_SOURCE_STALE_BEHIND}; `0` disables the recycle and
 * leaves the staleness visible-only. A runtime knob rather than project config:
 * it describes how this HOST supervises a habitant process, not anything about
 * the repository being merged. */
const RESIDENT_SOURCE_STALE_BEHIND_ENV = "YRD_RESIDENT_SOURCE_STALE_BEHIND"

/** Read the recycle threshold. An unparseable value is raised, never defaulted:
 * an operator who set the knob to disable a recycle and got the default instead
 * would learn about it from an unexplained restart. */
function habitantSourceStaleThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RESIDENT_SOURCE_STALE_BEHIND_ENV]?.trim()
  if (raw === undefined || raw === "") return HABITANT_SOURCE_STALE_BEHIND
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    raiseFailure(
      "configuration",
      "resident-source-stale-threshold-invalid",
      `yrd: ${RESIDENT_SOURCE_STALE_BEHIND_ENV} must be a non-negative integer (0 disables the recycle), not '${raw}'`,
    )
  }
  return parsed
}

/** Read the declared RSS cap, in BYTES, or undefined when no cap is declared.
 * Unparseable is raised for the same reason the staleness threshold raises it:
 * an operator who declared a cap and silently got the default instead would
 * learn about it from an unexplained restart — or, worse, from its absence. */
function habitantRssCapBytes(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[HABITANT_RSS_CAP_ENV]?.trim()
  const megabytes = raw === undefined || raw === "" ? HABITANT_RSS_CAP_DEFAULT_MB : Number(raw)
  if (!Number.isSafeInteger(megabytes) || megabytes < 0) {
    raiseFailure(
      "configuration",
      "habitant-rss-cap-invalid",
      `yrd: ${HABITANT_RSS_CAP_ENV} must be a non-negative integer number of megabytes (0 disables the cap), not '${raw ?? ""}'`,
    )
  }
  return megabytes === 0 ? undefined : megabytes * 1024 * 1024
}

function habitantRunnerStatusPath(cwd: string, stateDir?: string): string | undefined {
  if (stateDir !== undefined) return join(stateDir, "resident-runner", "status.json")
  const gitDir = queueGitDir(cwd)
  return gitDir === undefined ? undefined : join(gitDir, "yrd", "resident-runner", "status.json")
}

function habitantRunnerTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", `yrd: habitant runner ${field} is invalid`)
  }
  return value
}

/** One habitant-observed {@link QueueAuditFinding}, validated field-by-field.
 * Shared by every status-file field that carries findings verbatim from the
 * canonical audit (`queueProgress.findings`, `staleDrafts`) so the wire
 * contract for "what is a valid finding" cannot drift between them. `context`
 * names the owning field in every raised message. */
function parseQueueAuditFinding(value: unknown, context: string): QueueAuditFinding {
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", `yrd: habitant runner ${context} is invalid`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.code !== "string" || typeof record.message !== "string") {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      `yrd: habitant runner ${context} identity is invalid`,
    )
  }
  for (const field of [
    "run",
    "pr",
    "specimen",
    "step",
    "refusal",
    "submitter",
    "reviewCertification",
    "owner",
  ] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      raiseFailure(
        "infrastructure",
        "resident-runner-status-invalid",
        `yrd: habitant runner ${context} ${field} is invalid`,
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
      `yrd: habitant runner ${context} resolution is invalid`,
    )
  }
  if (record.count !== undefined && (!Number.isSafeInteger(record.count) || (record.count as number) < 0)) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", `yrd: habitant runner ${context} count is invalid`)
  }
  if (record.since !== undefined && (typeof record.since !== "string" || !Number.isFinite(Date.parse(record.since)))) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", `yrd: habitant runner ${context} since is invalid`)
  }
  if (record.blockedMs !== undefined && (!Number.isSafeInteger(record.blockedMs) || (record.blockedMs as number) < 0)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      `yrd: habitant runner ${context} blockedMs is invalid`,
    )
  }
  return record as QueueAuditFinding
}

function parseHabitantRunnerProgress(value: unknown): QueueRunnerProgress | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner queueProgress is invalid")
  }
  const progress = value as Record<string, unknown>
  const observedAt =
    progress.observedAt === undefined
      ? undefined
      : habitantRunnerTimestamp(progress.observedAt, "queueProgress observedAt")
  // Status records from progress-aware runners before the observation-time
  // contract remain readable, but their un-timestamped belief is not health.
  if (progress.state === "healthy") return observedAt === undefined ? undefined : { state: "healthy", observedAt }
  if (progress.state === "stalled" && Array.isArray(progress.findings) && progress.findings.length > 0) {
    const findings = progress.findings.map((finding) => parseQueueAuditFinding(finding, "queueProgress finding"))
    return observedAt === undefined ? undefined : { state: "stalled", observedAt, findings }
  }
  raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner queueProgress is invalid")
}

/** Shared by every habitant-status field that carries a plain array of
 * findings (unlike `queueProgress`, no wrapping state/observedAt envelope) —
 * presence already means "measured", and an empty array is a real, common
 * answer ("no stale drafts", "nothing needs a person"), so it is never
 * coerced to undefined the way an empty `queueProgress.findings` would be
 * nonsensical. `field` names the record key in every raised message. */
function parseFindingsField(value: unknown, field: string): readonly QueueAuditFinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", `yrd: habitant runner ${field} is invalid`)
  }
  return value.map((finding) => parseQueueAuditFinding(finding, `${field} finding`))
}

const HabitantInstalledPlanSchema = z
  .object({
    batchSize: z.number().int().min(1),
    steps: z.array(InstalledStepSchema).min(1),
  })
  .strict()

/** Absent is a real answer (a habitant older than the field); a present value
 * that does not parse is a broken wire, never silently "not published". */
function parseHabitantInstalledPlan(value: unknown): HabitantInstalledPlan | undefined {
  if (value === undefined) return undefined
  const parsed = HabitantInstalledPlanSchema.safeParse(value)
  if (!parsed.success) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      `yrd: habitant runner installedPlan is invalid: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

function parseQueueDriverEpoch(value: unknown): QueueDriverEpoch | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner driver is invalid")
  }
  const driver = value as Record<string, unknown>
  if (typeof driver.queueId !== "string" || driver.queueId.trim() === "") {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner driver queueId is invalid")
  }
  if (typeof driver.epoch !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(driver.epoch)) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner driver epoch is invalid")
  }
  // A habitant outlives the CLI that reads it, so this key is a cross-process
  // wire between two independently-versioned processes: the reader must accept
  // what an older habitant writes. `lastLanded` is the pre-2026-08-18 spelling
  // of this same field (the land->merge rename); a habitant started before that
  // rename keeps writing it for its whole lifetime. Absent BOTH spellings is
  // unknown, never "nothing has merged" -- the same rule the sibling
  // `missingUpdateClocks` states on this record.
  const reported = driver.lastMerged ?? driver.lastLanded
  let lastMerged: QueueDriverEpoch["lastMerged"]
  if (reported === null) {
    lastMerged = null
  } else if (typeof reported === "object" && reported !== null) {
    const merged = reported as Record<string, unknown>
    if (
      typeof merged.commit !== "string" ||
      !/^[0-9a-f]{40,64}$/u.test(merged.commit) ||
      typeof merged.at !== "string" ||
      !Number.isFinite(Date.parse(merged.at))
    ) {
      raiseFailure(
        "infrastructure",
        "resident-runner-status-invalid",
        "yrd: habitant runner driver lastMerged is invalid",
      )
    }
    lastMerged = { commit: merged.commit, at: merged.at }
  } else if (reported === undefined) {
    lastMerged = undefined
  } else {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner driver lastMerged is invalid",
    )
  }
  return { queueId: driver.queueId, epoch: driver.epoch, lastMerged }
}

function parseStrandedObservation(value: unknown): StrandedObservation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner uncarried is invalid")
  }
  const observation = value as Record<string, unknown>
  if (!Number.isSafeInteger(observation.count) || (observation.count as number) < 0) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner uncarried count is invalid")
  }
  if (!Number.isSafeInteger(observation.scanned) || (observation.scanned as number) < 0) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner uncarried scanned count is invalid",
    )
  }
  if (
    observation.missingUpdateClocks !== undefined &&
    (!Number.isSafeInteger(observation.missingUpdateClocks) || (observation.missingUpdateClocks as number) < 0)
  ) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner uncarried missing update-clock count is invalid",
    )
  }
  if (
    observation.measurable !== undefined &&
    (!Number.isSafeInteger(observation.measurable) || (observation.measurable as number) < 0)
  ) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner uncarried measurable count is invalid",
    )
  }
  const count = observation.count as number
  const scanned = observation.scanned as number
  const missingUpdateClocks = observation.missingUpdateClocks as number | undefined
  const measurable = observation.measurable as number | undefined
  if (count > scanned || (missingUpdateClocks !== undefined && count + missingUpdateClocks > scanned)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner uncarried counts exceed its scanned population",
    )
  }
  // Every finding comes from a ref the sweep could measure, so a count above
  // the measurable population is a corrupt record, not a busier fleet — and
  // silently rendering it would put a coverage percentage above 100 on the rail.
  if (measurable !== undefined && (count > measurable || measurable + (missingUpdateClocks ?? 0) > scanned)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner uncarried measurable count disagrees with its own population",
    )
  }
  const observedAt = habitantRunnerTimestamp(observation.observedAt, "uncarried observedAt")
  // Minted, never spread: a `status.json` written by an older habitant carries
  // no coverage fields, and re-deriving them HERE is what keeps a stale record
  // honest rather than letting it reach a renderer as a bare count.
  return strandedObservation({
    count,
    scanned,
    ...(missingUpdateClocks === undefined ? {} : { missingUpdateClocks }),
    ...(measurable === undefined ? {} : { measurable }),
    observedAt,
  })
}

function parseJournalRetentionPolicy(value: unknown): JournalRetentionPolicy {
  if (value === "disabled") return value
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner retention policy is invalid")
  }
  const policy = value as Record<string, unknown>
  const keys = Object.keys(policy).toSorted()
  if (
    !Number.isSafeInteger(policy.keepFrames) ||
    (policy.keepFrames as number) < 1 ||
    (policy.keepDays !== undefined && (!Number.isSafeInteger(policy.keepDays) || (policy.keepDays as number) < 1)) ||
    keys.some((key) => key !== "keepFrames" && key !== "keepDays")
  ) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner retention policy is invalid")
  }
  return {
    keepFrames: policy.keepFrames as number,
    ...(policy.keepDays === undefined ? {} : { keepDays: policy.keepDays as number }),
  }
}

function parseJournalRetentionObservation(value: unknown): JournalRetentionObservation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner retention observation is invalid",
    )
  }
  const observation = value as Record<string, unknown>
  if (observation.source !== "mutable-journal") {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner retention observation source is invalid",
    )
  }
  if (
    typeof observation.generation !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(observation.generation)
  ) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner retention observation generation is invalid",
    )
  }
  return {
    policy: parseJournalRetentionPolicy(observation.policy),
    source: "mutable-journal",
    observedAt: habitantRunnerTimestamp(observation.observedAt, "retention observedAt"),
    generation: observation.generation,
  }
}

function parseHabitantRunnerStatus(text: string): QueueTimelineRunner {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner status is not JSON")
  }
  if (typeof value !== "object" || value === null) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner status is not an object")
  }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner pid is invalid")
  }
  const startedAt = habitantRunnerTimestamp(record.startedAt, "startedAt")
  const lastTickAt = habitantRunnerTimestamp(record.lastTickAt, "lastTickAt")
  const queueProgress = parseHabitantRunnerProgress(record.queueProgress)
  const driver = parseQueueDriverEpoch(record.driver)
  const uncarried = parseStrandedObservation(record.uncarried)
  const retention = parseJournalRetentionObservation(record.retention)
  const staleDrafts = parseFindingsField(record.staleDrafts, "staleDrafts")
  const needsPerson = parseFindingsField(record.needsPerson, "needsPerson")
  const installedPlan = parseHabitantInstalledPlan(record.installedPlan)
  if (Date.parse(lastTickAt) < Date.parse(startedAt)) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner lastTickAt precedes startedAt",
    )
  }
  if (record.command !== undefined && typeof record.command !== "string") {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner command is invalid")
  }
  if (record.clean !== undefined && typeof record.clean !== "boolean") {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner clean flag is invalid")
  }
  if (
    record.implementationSource !== undefined &&
    (typeof record.implementationSource !== "string" ||
      !/^(?:dirty|git):[0-9a-f]{40,64}$/u.test(record.implementationSource))
  ) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-invalid",
      "yrd: habitant runner implementationSource is invalid",
    )
  }
  if (
    record.journalVersions !== undefined &&
    (!Array.isArray(record.journalVersions) ||
      record.journalVersions.some((version) => !Number.isSafeInteger(version) || (version as number) < 1))
  ) {
    raiseFailure("infrastructure", "resident-runner-status-invalid", "yrd: habitant runner journalVersions is invalid")
  }
  return {
    pid: record.pid as number,
    startedAt,
    ...(record.observedStartedAt === undefined
      ? {}
      : { observedStartedAt: habitantRunnerTimestamp(record.observedStartedAt, "observedStartedAt") }),
    lastTickAt,
    ...(queueProgress === undefined ? {} : { queueProgress }),
    ...(driver === undefined ? {} : { driver }),
    ...(uncarried === undefined ? {} : { uncarried }),
    ...(retention === undefined ? {} : { retention }),
    ...(staleDrafts === undefined ? {} : { staleDrafts }),
    ...(needsPerson === undefined ? {} : { needsPerson }),
    ...(installedPlan === undefined ? {} : { installedPlan }),
    ...(record.command === undefined ? {} : { command: record.command as string }),
    ...(record.exitedAt === undefined ? {} : { exitedAt: habitantRunnerTimestamp(record.exitedAt, "exitedAt") }),
    ...(record.clean === undefined ? {} : { clean: record.clean }),
    implementationSource:
      record.implementationSource === undefined ? "unknown" : (record.implementationSource as string),
    ...(record.journalVersions === undefined ? {} : { journalVersions: record.journalVersions as number[] }),
  }
}

export async function habitantRunnerStatus(cwd: string, stateDir?: string): Promise<QueueTimelineRunner | null> {
  const path = habitantRunnerStatusPath(cwd, stateDir)
  if (path === undefined) return null
  let status: QueueTimelineRunner
  try {
    status = parseHabitantRunnerStatus(await readFile(path, "utf8"))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
    throw cause
  }
  // The last recycle this lineage attempted (`source-recycle.json`, shared by
  // every habitant designed exit — `HabitantSourceRecycle`), merged in here so
  // every consumer of this projection (`watch`, `queue list --check`, `queue
  // status`) gets it from the one place they already read runner status, in
  // preference to duplicating this read at each call site. Absent is the
  // overwhelmingly common case (no recycle ever attempted) and costs nothing:
  // `readHabitantSourceRecycle` degrades silently rather than raising over a
  // bookkeeping file that only ever adds context.
  const lastRecycle = await readHabitantSourceRecycle(cwd, stateDir)
  return lastRecycle === undefined ? status : { ...status, lastRecycle }
}

/**
 * Whether the recorded runner pid is still running. One shared verdict
 * (`@yrd/process`), so display and reclaim can never disagree.
 *
 * No identity is asserted here, and that is deliberate rather than an oversight.
 * The status record's `startedAt` is a LOGICAL timestamp written under the
 * caller's clock — `io.now()` in tests, a restored journal event on replay — not
 * the operating system's start time for that process, so comparing it against
 * `/proc` would call a live runner recycled whenever the two clocks differ, and
 * reclaim would then recover runs out from under a runner that is still working.
 * That is the expensive direction of the error.
 *
 * Closing it properly means RECORDING the identity instead of inferring it: the
 * habitant writes its own observed start (`observePidSync(process.pid)`) into
 * the status record as `observedStartedAt` (added 2026-08-30, alongside the
 * age fix in `runnerAgeMs`'s callers and `runnerTiming` in
 * queue-status-view.tsx), and this compares the two `/proc` readings exactly,
 * immune to any clock. Wiring `observedStartedAt` into `runningSinceMs` below
 * is a follow-on, not done here: this feeds RECLAIM (recovering another
 * runner's leases), a destructive-adjacent surface that earns its own change
 * and its own tests rather than riding in on a lifecycle-record fix. Until
 * that wiring lands, a runner pid answers as it always did.
 */
function habitantRunnerRunning(pid: number): boolean {
  return recordedPidIsRunning(recordedPidLivenessSync({ pid }))
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
 * late, so display asks it directly.
 *
 * The nulling is lossy, and the banner needs what it loses: "the runner that was
 * here is gone" and "no runner was ever here" are different states with
 * different remedies, and collapsing both to null made them one sentence. So the
 * observation keeps the reason alongside the filtered runner, and asks the pid
 * ONCE — a second probe could disagree with the first if the pid exits between
 * them, and report a live runner that is also departed. */
function observeHabitantRunner(
  runner: QueueTimelineRunner | null,
): Readonly<{ runner: QueueTimelineRunner | null; absence?: QueueRunnerAbsence }> {
  if (runner === null) return { runner: null, absence: { kind: "never" } }
  if (runner.exitedAt !== undefined) {
    return {
      runner: null,
      absence: {
        kind: "departed",
        pid: runner.pid,
        // A marker written without `clean` predates the flag (D1a); it proves the
        // runner got to write an exit, which is what "clean" claims here.
        clean: runner.clean ?? true,
        lastAliveMs: Date.parse(runner.exitedAt),
      },
    }
  }
  if (habitantRunnerRunning(runner.pid)) return { runner }
  // No exit marker and no process: it died without recording anything, so the
  // last heartbeat is the last moment it is known to have been alive.
  return {
    runner: null,
    absence: { kind: "departed", pid: runner.pid, clean: false, lastAliveMs: Date.parse(runner.lastTickAt) },
  }
}

export function activeHabitantRunner(runner: QueueTimelineRunner | null): QueueTimelineRunner | null {
  return observeHabitantRunner(runner).runner
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
  /** The checkout's distance from the queue base's tip (`origin/<base>` when
   * a remote is configured, the local branch otherwise) — the same ref every
   * Run resolves its plan from. Absent only when the base does not resolve. */
  base?: RunnerGitDistance
}>

/** The toolchain THIS invocation is running on. Step identity no longer depends
 * on the launcher's bun/node versions (22374), but which binary is in the
 * caller's PATH remains the discriminating read whenever a habitant and an
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
  /** What the plan audit compared for this probe: the tip's declared plan
   * against the plan the live habitant published (23192 leg c), with the
   * legs it could not run named. Absent only when the audit itself failed. */
  planAudit?: QueueEnvironmentAuditComparison
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

type HabitantRunnerLeaseObservation = Readonly<{
  held: boolean
  driver?: Readonly<{ queueId: string; epoch: string }>
  /** Which kind of pass holds it (`host.ts` QueueRunnerLeaseMode). A one-shot
   * `queue run` takes the SAME lease as the resident, so "held" alone no longer
   * answers "is the resident serving". Undefined when the holder recorded no
   * mode — an older Yrd, which could only ever have been a resident. */
  mode?: "resident" | "once"
}>

function habitantRunnerLeaseDriver(message: string): HabitantRunnerLeaseObservation["driver"] {
  const match = /holder=queue=(.*?) epoch=([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\s|;|\))/iu.exec(message)
  const queueId = match?.[1]
  const epoch = match?.[2]
  return queueId === undefined || epoch === undefined ? undefined : { queueId, epoch }
}

function habitantRunnerLeaseMode(message: string): HabitantRunnerLeaseObservation["mode"] {
  const mode = /holder=[^;)]*\bmode=(resident|once)\b/u.exec(message)?.[1]
  return mode === "resident" || mode === "once" ? mode : undefined
}

async function habitantRunnerLeaseObservation(cwd: string): Promise<HabitantRunnerLeaseObservation> {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) {
    raiseFailure("infrastructure", "runner-health-unavailable", `yrd: '${cwd}' is not a Git queue repository`)
  }
  try {
    await createExclusive(join(gitDir, "yrd", "resident-runner"), { timeoutMs: 0 }).run(() => Promise.resolve(), {
      holder: "resident-runner-probe",
    })
    return { held: false }
  } catch (error) {
    const fact = failureFact(error)
    if (fact?.code === "exclusive-busy") {
      const driver = habitantRunnerLeaseDriver(fact.message)
      const mode = habitantRunnerLeaseMode(fact.message)
      return { held: true, ...(driver === undefined ? {} : { driver }), ...(mode === undefined ? {} : { mode }) }
    }
    throw error
  }
}

export async function habitantRunnerLeaseHeld(cwd: string): Promise<boolean> {
  return (await habitantRunnerLeaseObservation(cwd)).held
}

/**
 * Admission used to have no exclusivity of its own — only settlement did — so a
 * one-shot `queue run --once` could start composing beside another driver.
 * A PROBE stood here instead: it acquired the resident lease, released it, and
 * refused if it had been busy. That answered "is a resident running" and could
 * never answer "is another one-shot running", because a one-shot took nothing
 * to observe. Measured 2026-09-01, 15:11 PDT: two one-shot passes against one
 * repository, the second cancelling the first's run on PR2916.
 *
 * The probe is gone, and the lease is now taken by BOTH kinds of pass for the
 * whole of the pass (`acquireQueueRunnerLease`, host.ts), before the command
 * body runs at all. Two drivers of any kind cannot overlap by construction, and
 * a probe on this side would now refuse against its own process's lease — flock
 * denies a second acquire from the same process just as it denies another
 * process's.
 */
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

/** The Yrd source checkout this process is executing from, or undefined when the
 * runtime is not a Git checkout at all (an installed bundle, a packed release).
 * This is the repository `implementationSource` was captured from — see
 * `implementationSourceIdentity` — and therefore the ONLY repository in which
 * that sha may be compared against anything. */
function yrdSourceCheckout(): string | undefined {
  const root = yrdSourceRoot()
  if (root === undefined) return undefined
  return existsSync(join(root, ".git")) ? root : undefined
}

/** How far a source checkout has advanced past the sha a habitant booted from,
 * plus the head it advanced to. Both are needed together: the head is what a
 * recycle would come back as, and comparing behind-counts across cycles is only
 * meaningful when they were measured against the same head. */
type SourceAdvance = Readonly<{ headSha: string; behind: number | undefined }>

/**
 * Read one straight-line advance, uncached.
 *
 * Ancestry is required, not decorative. `rev-list --count a..b` answers for ANY
 * two commits git can resolve, including two unrelated histories that merely
 * share an object database — and that is not a hypothetical: the `/hh` queue
 * repository holds Yrd's own commits, so comparing a `vendor/yrd` sha against
 * the `/hh` checkout's HEAD returned 37576 for a habitant that was exactly
 * current. A count is only "how far behind am I" when the booted sha is an
 * ANCESTOR of the head; anything else (diverged, rewound, unrelated) is
 * unmeasurable and must answer undefined rather than a confident number.
 */
function readSourceAdvance(sourceRoot: string, runnerSha: string): SourceAdvance | undefined {
  try {
    const headSha = gitSync(sourceRoot, ["rev-parse", "HEAD"]).trim().toLowerCase()
    if (!/^[0-9a-f]{40,64}$/u.test(headSha)) return undefined
    if (headSha === runnerSha) return { headSha, behind: undefined }
    gitSync(sourceRoot, ["merge-base", "--is-ancestor", runnerSha, headSha])
    const counted = Number(gitSync(sourceRoot, ["rev-list", "--count", `${runnerSha}..${headSha}`]).trim())
    if (!Number.isSafeInteger(counted) || counted <= 0) return { headSha, behind: undefined }
    return { headSha, behind: counted }
  } catch {
    // silent-fallback-allow: every failure here — not a repository, an unknown
    // object, a booted sha that is not an ancestor (`merge-base --is-ancestor`
    // exits non-zero by design) — means the same thing to every caller: the
    // advance is UNMEASURABLE. Callers render nothing and never recycle on it,
    // so no state is reported as healthy on the strength of this catch.
    return undefined
  }
}

/** One comparison of a habitant's booted source against the queue repository's
 * RECORDED pin (@i/10-merge-queue/23041-staleness-measures-the-observer).
 * `unpinned` is the one state the watcher renders as silence: the queue
 * repository records no Yrd submodule, or the source is not a plain git sha,
 * so there is no pin to be behind. Every failure to READ a pin that should be
 * readable is `unknown` with its reason — never silence, never a number
 * computed from a different base. */
export type RunnerPinComparison = RunnerSourcePin | Readonly<{ state: "unpinned" }>

/**
 * The queue repository's recorded Yrd pin: the gitlink its `origin/main` tree
 * carries for the submodule that IS the Yrd distribution.
 *
 * This is the ONE pin-resolution site. The submodule is found by identity, not
 * by a hardcoded path — the same package-name check `yrdSourceRoot` applies to
 * the running code, applied to each recorded submodule's working tree — because
 * a host repository may pin Yrd anywhere, and Yrd source must not assume its
 * own location inside a host. `origin/main` (not HEAD) is deliberate: the
 * recorded pin is a claim about what the queue's merge branch prescribes,
 * and a local checkout mid-rebase must not move it.
 */
function queueRecordedYrdPin(
  queueCwd: string,
):
  | Readonly<{ pinSha: string; submoduleRoot: string }>
  | Extract<RunnerPinComparison, { state: "unknown" | "unpinned" }> {
  let toplevel: string
  try {
    toplevel = gitSync(queueCwd, ["rev-parse", "--show-toplevel"]).trim()
  } catch {
    return { state: "unknown", reason: "queue repository root unresolvable" }
  }
  try {
    gitSync(toplevel, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
  } catch {
    return { state: "unknown", reason: "origin/main unresolvable in the queue repository" }
  }
  let moduleConfig: string
  try {
    moduleConfig = gitSync(toplevel, [
      "config",
      "--blob",
      "origin/main:.gitmodules",
      "--get-regexp",
      String.raw`^submodule\..*\.path$`,
    ])
  } catch {
    // No .gitmodules blob at origin/main (or none declaring a path): a
    // repository with no submodules at all, which is a normal deployment.
    return { state: "unpinned" }
  }
  for (const line of moduleConfig.split("\n")) {
    const separator = line.indexOf(" ")
    if (separator < 0) continue
    const path = line.slice(separator + 1).trim()
    if (path === "") continue
    const directory = resolve(toplevel, path)
    if (yrdSourceRoot(directory) !== directory) continue
    let pinSha: string
    try {
      pinSha = gitSync(toplevel, ["rev-parse", `origin/main:${path}`])
        .trim()
        .toLowerCase()
    } catch {
      return {
        state: "unknown",
        reason: `origin/main declares the Yrd submodule at ${path} but records no gitlink there`,
      }
    }
    if (!/^[0-9a-f]{40,64}$/u.test(pinSha)) {
      return { state: "unknown", reason: `recorded pin at ${path} is not a commit id` }
    }
    return { pinSha, submoduleRoot: directory }
  }
  return { state: "unpinned" }
}

/** Exit-zero probe for relating two commits. Exit 1 (not an ancestor) and a
 * missing object both merge in the same `false` here; the caller distinguishes
 * them by probing BOTH directions — two clean falses with resolvable objects
 * means diverged, anything unresolvable means unrelatable, and each answers a
 * loud unknown rather than a number. */
function gitIsAncestor(root: string, ancestor: string, descendant: string): boolean {
  try {
    gitSync(root, ["merge-base", "--is-ancestor", ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/** Uncached single read behind {@link runnerPinBehind}. The count runs in the
 * queue's own submodule working tree — the repository that owns both the pin
 * and (in any deployment where a habitant booted from it) the booted sha —
 * never in the observer's checkout, whose history is what the pre-fix figure
 * wrongly tracked. */
function readPinComparison(queueCwd: string, runnerSha: string): RunnerPinComparison {
  const pin = queueRecordedYrdPin(queueCwd)
  if ("state" in pin) return pin
  if (runnerSha === pin.pinSha) return { state: "at" }
  if (gitIsAncestor(pin.submoduleRoot, runnerSha, pin.pinSha)) {
    try {
      const counted = Number(gitSync(pin.submoduleRoot, ["rev-list", "--count", `${runnerSha}..${pin.pinSha}`]).trim())
      if (Number.isSafeInteger(counted) && counted > 0) return { state: "behind", commits: counted }
    } catch {
      // silent-fallback-allow: ancestry held but rev-list count failed; caller
      // gets state unknown, not a fabricated distance.
    }
    return { state: "unknown", reason: `cannot count ${runnerSha.slice(0, 10)}..${pin.pinSha.slice(0, 10)}` }
  }
  if (gitIsAncestor(pin.submoduleRoot, pin.pinSha, runnerSha)) {
    // The dangerous direction (@i/10-merge-queue/23041 counter-caution): a
    // runtime NEWER than the recorded pin is what crashed settlement drain,
    // and a restart of the runner cannot fix it — the pin is what lags.
    return {
      state: "unknown",
      reason: `booted source is ahead of recorded pin ${pin.pinSha.slice(0, 10)} — the pin lags, not the runner`,
    }
  }
  return {
    state: "unknown",
    reason: `cannot relate booted ${runnerSha.slice(0, 10)} to recorded pin ${pin.pinSha.slice(0, 10)}`,
  }
}

/** Cached answer for {@link runnerPinBehind}, keyed by queue repository and the
 * habitant sha it was computed against. */
type RunnerPinBehindEntry = Readonly<{ runnerSha: string; answer: RunnerPinComparison; computedAt: number }>
const runnerPinBehindCache = new Map<string, RunnerPinBehindEntry>()

/** Matches the watch poll cadence (`watchQueue`'s `interval`). `observeQueueList`
 * also runs once per focus/cursor change (see `queueGitDir`'s doc comment on why
 * an uncached git fork there is a bug, not a feature) — this TTL keeps the
 * pin-resolution forks off that per-keystroke path while still catching a
 * min-commit advance within one poll tick. The habitant's own self-check deliberately
 * does NOT come through here: it needs consecutive observations to be genuinely
 * consecutive reads, which a cache at the poll cadence would quietly collapse. */
const RUNNER_PIN_BEHIND_TTL_MS = 15_000

/** How the habitant runner's booted source (`implementationSource`, captured
 * once at its startup) relates to the queue repository's RECORDED Yrd pin.
 *
 * This is the watcher's figure, and its base is the pin — never any checkout's
 * HEAD. The pre-fix read counted `runnerSha..HEAD` in the OBSERVER'S OWN Yrd
 * checkout, so the number tracked whoever was looking: an observer two commits
 * ahead rendered a pin-exact habitant as "28 behind pin", and moving the
 * recorded pin did not move the display. The habitant's own recycle self-check
 * (`readSourceAdvance` against the checkout it booted from) is a DIFFERENT
 * question — "has my source moved under me" — and deliberately keeps its own
 * base. */
export function runnerPinBehind(
  queueCwd: string,
  implementationSource: string | undefined,
  now: number,
): RunnerPinComparison {
  const runnerSha = habitantBootedSha(implementationSource)
  if (runnerSha === undefined) return { state: "unpinned" }
  const cached = runnerPinBehindCache.get(queueCwd)
  if (cached?.runnerSha === runnerSha && now - cached.computedAt < RUNNER_PIN_BEHIND_TTL_MS) {
    return cached.answer
  }
  const answer = readPinComparison(queueCwd, runnerSha)
  runnerPinBehindCache.set(queueCwd, { runnerSha, answer, computedAt: now })
  return answer
}

/** The commit a habitant booted from, or undefined when its source identity is
 * not a plain git sha (`dirty:` working-tree builds, an absent identity). A
 * source that cannot be named cannot be compared, and is never stale. */
function habitantBootedSha(implementationSource: string | undefined): string | undefined {
  const match = implementationSource === undefined ? null : /^git:([0-9a-f]{40,64})$/u.exec(implementationSource)
  return match === null ? undefined : (match[1] ?? "").toLowerCase()
}

function runnerGitHealth(cwd: string, base: string): RunnerGitHealth {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) {
    raiseFailure("infrastructure", "runner-health-unavailable", `yrd: '${cwd}' is not a Git queue repository`)
  }
  const headSha = gitSync(cwd, ["rev-parse", "HEAD"]).trim().toLowerCase()
  const dirty = gitSync(cwd, ["status", "--porcelain"]).trim() !== ""
  const baseSha = queueBaseTipSync(cwd, base)
  return {
    cwd,
    headSha,
    dirty,
    ...(baseSha === undefined ? {} : { base: { base, baseSha, ...gitDistance(cwd, baseSha, headSha) } }),
  }
}

/** The base tip as the queue resolves it, without a fetch: `origin/<base>`
 * when a remote is configured, else the local branch; undefined when neither
 * resolves. Mirrors `inspectQueueBase` in `@yrd/queue` for this synchronous
 * probe path. */
function queueBaseTipSync(cwd: string, base: string): string | undefined {
  const resolveRef = (ref: string): string | undefined => {
    try {
      const sha = gitSync(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
        .trim()
        .toLowerCase()
      return sha === "" ? undefined : sha
    } catch (error) {
      // `--verify --quiet` exits 1 for a ref that does not exist — a real
      // answer. Anything else (exit 128: not a repository, a corrupt object)
      // is a failure of the probe itself and stays loud.
      if ((error as { status?: unknown }).status === 1) return undefined
      throw error
    }
  }
  const remote = resolveRef(`refs/remotes/origin/${base}`)
  return remote ?? resolveRef(`refs/heads/${base}`)
}

function runnerHealthError(code: string, cause: string, resolution: readonly string[]) {
  return Object.freeze({ code, cause, resolution: Object.freeze([...resolution]) })
}

/**
 * An unhealthy `queue.list.check` verdict about QUEUE CONTENT -- whether
 * merges are happening -- never about whether an instance owns the runner
 * SERVICE. `running` is hab-core's one admission fact (`@hab/core`
 * service-admission: "does an instance already own this service?"); pairing
 * it with the finding HERE, once, makes it structurally impossible for a
 * queue-content code to slip through as `running: true` again, the way
 * `resident-runner-no-progress` and `resident-runner-stalled-no-merge` both
 * used to. Both are downstream of this file's `habitantQueueProgress` and its
 * own rule ("SERVICE health, not QUEUE CONTENT"): a finding admitted there
 * must be a property the SERVICE can fix by starting, restarting, or
 * continuing to run -- which means it can never be grounds to REFUSE that
 * same start. Returning `running: true` from these two findings made the
 * admission guard refuse the exact restart that would have cleared the stall
 * it was reporting (pm/@i/10-yrd/plan.md, C5's ruling: "the liveness guard
 * must never again refuse the restart that would clear the stall it
 * reports").
 *
 * `running: false` is not a claim that no process exists -- a live, ticking
 * habitant can absolutely be the one reporting a stalled queue. It answers
 * hab-core's narrower admission question: does this CONDITION name an
 * existing owner a start would conflict with? A stalled queue never does, so
 * hab-core records and renders it, never refuses on it alone
 * (service-admission.ts's liveness/admission split). A genuinely conflicting
 * live instance is still caught downstream by hab's own session tracking
 * (`startOrAttachHabd`), which this payload does not gate.
 */
function queueContentHealthError(
  service: string,
  facts: RunnerHealthFacts,
  code: string,
  cause: string,
  resolution: readonly string[],
): Readonly<{ payload: RunnerHealthPayload; exitCode: YrdCliExitCode }> {
  return {
    exitCode: 2,
    payload: {
      schema: "hab-service-health/1",
      command: "queue.list.check",
      service,
      state: "unhealthy",
      running: false,
      error: runnerHealthError(code, cause, resolution),
      facts,
    },
  }
}

/** Work waiting on this queue, BOTH LANES. The record-lane read this replaced
 * was the same population-vs-store defect as `habitantDriverLastMerged` above,
 * pointing the other way: it gates two findings, so a queue whose waiting work
 * is entirely derived-lane counted zero and BOTH went silent — a dead runner
 * with a full queue reported `resident-runner-missing` never, and the dead-man
 * was skipped outright. One lane read, two directions of error: the merge
 * position freezes and fires falsely, the ready set empties and never fires. */
function queuedDeliveryCount(app: YrdCliApp): number {
  const state = stateOf(app)
  return queueChanges(state.bays, state.queues).filter((pr) => {
    const delivery = changeDeliveryState(pr)
    return delivery === "submitted" || delivery === "ready"
  }).length
}

/** Both sides must be KNOWN: an unreported merge position is not comparable,
 * so callers resolve that case before reaching here rather than letting an
 * unknown quietly compare equal (or unequal) to a real commit. */
type KnownDriverMerge = Exclude<QueueDriverEpoch["lastMerged"], undefined>

function sameDriverMerge(left: KnownDriverMerge, right: KnownDriverMerge): boolean {
  return left === null ? right === null : right !== null && left.commit === right.commit && left.at === right.at
}

function runnerDriverHealthError(
  runner: QueueTimelineRunner,
  expectedQueueId: string,
  expectedLastMerged: QueueDriverEpoch["lastMerged"] | undefined,
): ReturnType<typeof runnerHealthError> | undefined {
  if (runner.driver === undefined) {
    return runnerHealthError(
      "resident-runner-driver-unknown",
      "habitant runner heartbeat is fresh but does not identify its queue driver epoch",
      ["Restart the habitant queue runner with the installed Yrd source."],
    )
  }
  if (runner.driver.queueId !== expectedQueueId) {
    return runnerHealthError(
      "resident-runner-driver-mismatch",
      `habitant runner owns '${runner.driver.queueId}', not expected queue '${expectedQueueId}'`,
      ["Stop the mismatched habitant and start the runner from the expected repository."],
    )
  }
  // A habitant that reports no merge position is not thereby unhealthy: a live
  // habitant omits the key entirely until it has merged something, and one
  // started before the 2026-08-18 land->merge rename spells it `lastLanded`.
  // Either way there is nothing to compare, so this check abstains -- the same
  // shape as the `expectedLastMerged !== undefined` guard on the other side.
  // Every other driver check (identity, epoch, heartbeat freshness, progress)
  // still runs, so abstaining here hides nothing.
  if (
    expectedLastMerged !== undefined &&
    runner.driver.lastMerged !== undefined &&
    !sameDriverMerge(runner.driver.lastMerged, expectedLastMerged)
  ) {
    return runnerHealthError(
      "resident-runner-driver-stale",
      "habitant runner heartbeat does not report the queue's latest merged commit",
      ["Inspect the habitant runner log and restart it if its driver epoch is no longer advancing."],
    )
  }
  return undefined
}

/** Project the habitant's canonical progress findings into its lightweight
 * status record. The supervisor can then prove outcome progress without
 * replaying Journal history in its health probe. */
export function habitantQueueProgress(app: YrdCliApp, now: string): QueueRunnerProgress {
  // SERVICE health, not QUEUE CONTENT. Every code admitted here makes the
  // habitant service `unhealthy`, and `hab up` refuses to start an unhealthy
  // service — so a finding in this list must be a property the SERVICE can act
  // on by starting, restarting, or continuing to run.
  //
  // `admission-refusal-loop` is deliberately NOT in this list. It is a fact
  // about ONE CHANGE — its admission keeps refusing — and admitting it here
  // made a bad change brick the runner: measured 2026-08-29, PR2599 failed
  // `manifest-co-change` (correctly: it was missing two inventory rows), the
  // service went `unhealthy` with `resident-runner-no-progress`, and
  // `hab up yrd-runner` then refused while the singleton lease stayed held by
  // the dead process. **The service that is refused startup is the only thing
  // that could ever process the fix for the change that refused it**, so the
  // state is unrecoverable from inside. That is the same head-of-line shape as
  // the per-PR refusal that cost the whole cycle that morning, one layer up and
  // worse, because the cycle case at least kept the process alive.
  //
  // The finding is not lost: `queue audit` still reports it, `yrd mr list`
  // carries it in the WHY column, and delivering it to its named owner is
  // @i/10-yrd/needs-person-reaches-only-the-log. A refusing change needs an
  // OWNER, not a dead runner.
  const findings = app.queue.audit({ now }).findings.filter(
    (finding) =>
      finding.code === "queue-progress-stalled" ||
      finding.code === "queue-never-started" ||
      finding.code === "queue-hold-ttl-missing" ||
      finding.code === "queue-hold-expired" ||
      // @i/10-yrd/queue-liveness-pair: safe here for the same reason
      // `queue-progress-stalled` above already is and `admission-refusal-loop`
      // is not — it names no PR to blame and requires no single author to
      // act, so continuing to run (once whatever is blocking the base is
      // fixed, by any means) is always a live path, never the PR2599
      // deadlock where the only fix was refused startup itself.
      finding.code === "queue-liveness-wedged",
  )
  return findings.length === 0 ? { state: "healthy", observedAt: now } : { state: "stalled", observedAt: now, findings }
}

/** Hours to milliseconds for `.yrd.yml` `drafts.pageAfterHours`. Named rather
 * than inlined `* 3_600_000` at each of its two call sites (habitant heartbeat
 * setup, watch snapshot build) so both read the identical config the identical
 * way. */
function draftPageThresholdMs(config: Pick<ResolvedYrdProjectConfig, "drafts">): number {
  return (config.drafts?.pageAfterHours ?? DEFAULT_DRAFT_PAGE_AFTER_HOURS) * 3_600_000
}

/**
 * `draft-stranded` findings old enough to page, projected from the canonical
 * audit exactly like {@link habitantQueueProgress} — never re-derived from PR
 * state directly, so the finding a watcher or health check sees and the one
 * `queue audit` prints for the same draft can never disagree.
 *
 * Age-gated by `thresholdMs` HERE, not by the caller: `draft-stranded` already
 * exists the moment `queue audit` runs (DRAFT_STRANDED_GRACE_MS, 15 minutes —
 * long enough for a deliberate push-review-submit pause), which is far too
 * eager a bar for an unattended surface a live seat did not ask to check. A
 * shorter-lived draft is a real, correct `queue audit` finding; it is
 * deliberately absent from this narrower, page-worthy set.
 */
export function staleDraftFindings(
  app: Pick<YrdCliApp, "queue">,
  now: string,
  thresholdMs: number,
): readonly QueueAuditFinding[] {
  // `unrecorded-submit` rides the same projection (branch-is-change 2a): a
  // branch approved in git that no record carries is the mirror image of a
  // draft nobody submitted — both are work waiting on a human that every
  // other surface would otherwise hide — and the same age threshold applies.
  return app.queue
    .audit({ now })
    .findings.filter(
      (finding) =>
        (finding.code === "draft-stranded" || finding.code === "unrecorded-submit") &&
        (finding.blockedMs ?? 0) >= thresholdMs,
    )
}

/** One scannable warning line per stale draft or unrecorded submit, in the
 * same `[code] message` shape {@link queuePauseWarnings} already established —
 * the finding's own `message` already names the branch, submitter and review
 * certification (@yrd/queue `auditQueues`), so this never re-derives that text. */
export function staleDraftWarnings(findings: readonly QueueAuditFinding[]): string[] {
  return findings.map((finding) => `[${finding.code}] ${finding.message}`)
}

/**
 * `admission-refusal-needs-person` findings, projected from the canonical
 * audit exactly like {@link staleDraftFindings} — never re-derived from
 * refusal state directly, so the queue-list/watch/health surfaces and
 * `queue audit` can never disagree about which changes are parked
 * waiting on a human (@i/10-merge-queue/22918-needs-person-unowned: settling
 * a refusal `needs-person` used to stop the REPORT along with the retry, and
 * the settlement vanished from every surface).
 *
 * No age threshold, unlike {@link staleDraftFindings}: a settlement already
 * only happens after the queue exhausted its own retries or mechanical remedy
 * (22474), so it is page-worthy the moment it exists — there is no legitimate
 * "give it a few minutes" window the way a fresh push has one.
 */
export function needsPersonFindings(app: Pick<YrdCliApp, "queue">, now: string): readonly QueueAuditFinding[] {
  return app.queue.audit({ now }).findings.filter((finding) => finding.code === "admission-refusal-needs-person")
}

/** One scannable warning line per needs-person change, in the same
 * `[code] message` shape {@link staleDraftWarnings} already established — the
 * finding's own `message` already names the refusal, its reason and its owner
 * (@yrd/queue `auditQueues`), so this never re-derives that text. */
export function needsPersonWarnings(findings: readonly QueueAuditFinding[]): string[] {
  return findings.map((finding) => `[admission-refusal-needs-person] ${finding.message}`)
}

/** Exact latest merge driven for one queue. The epoch heartbeat publishes
 * this content so a probe can distinguish the right driver from an unrelated
 * habitant process with the same service name.
 *
 * BOTH LANES, via `queueChanges`. Reading the record store alone (`recordChanges`)
 * froze this answer at the last RECORD-lane merge, because a derived-lane merge
 * leaves no row in `bays.prs`. Measured 2026-08-31: main advanced to 07218650a6
 * at 19:09:42Z (reflog) while the heartbeat still published dd3f0f3cb3 at
 * 17:09:57Z, so the dashboard read "no merge for 2:11:32" over a queue that had
 * merged twelve minutes earlier. Nearly all traffic now arrives through the
 * derived lane, so the frozen position also made the dead-man unconditional:
 * `resident-runner-stalled-no-merge` tests uptime and no-merge age against the
 * same 3h threshold, and a position that never advances makes the second test
 * pass whenever the first does. Same shape as the population-vs-store count
 * `queueChanges` was introduced to fix. */
export function habitantDriverLastMerged(app: YrdCliApp, base: string): QueueDriverEpoch["lastMerged"] {
  const state = stateOf(app)
  return (
    queueChanges(state.bays, state.queues)
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

/** The probe's answer when the health read itself failed: always unhealthy,
 * carrying the failure's code and remedy. Whether the service was ever
 * installed here is answered by the lease and the queued work below, never
 * by a file's absence. */
function runnerHealthFailure(
  error: unknown,
  observed: Readonly<{ service: string; leaseHeld: boolean | undefined; git: RunnerGitHealth }>,
): Readonly<{ payload: RunnerHealthPayload; exitCode: YrdCliExitCode }> {
  const fact = failureFact(error) ?? {
    code: "runner-health-failed",
    message: error instanceof Error ? error.message : String(error),
  }
  const held = observed.leaseHeld === true
  return {
    exitCode: 2,
    payload: {
      schema: "hab-service-health/1",
      command: "queue.list.check",
      service: observed.service,
      state: "unhealthy",
      running: held,
      error: actionableFailure(fact),
      facts: {
        lease: observed.leaseHeld === undefined ? "unknown" : held ? "held" : "free",
        runnerStatus: "missing",
        queueProgress: { state: "unknown" },
        launcher: runnerLauncherFacts(),
        git: observed.git,
      },
    },
  }
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
  const base = baseIdentity(services.base ?? "main")
  let leaseHeld: boolean | undefined
  let leaseDriver: HabitantRunnerLeaseObservation["driver"]
  let leaseMode: HabitantRunnerLeaseObservation["mode"]
  let git: RunnerGitHealth = { cwd, headSha: "unknown", dirty: false }
  try {
    const lease = await habitantRunnerLeaseObservation(cwd)
    leaseHeld = lease.held
    leaseDriver = lease.driver
    leaseMode = lease.mode
    if (audit === undefined) {
      raiseFailure(
        "configuration",
        "queue-audit-unavailable",
        "yrd: queue.audit capability is not installed; runner health cannot read the plan the base declares",
      )
    }
    const runner = activeHabitantRunner(await habitantRunnerStatus(cwd))
    git = runnerGitHealth(cwd, base)
    const auditResult = await audit()
    const now = io.now?.() ?? Date.now()
    const runnerAgeMs = runner === null ? undefined : Math.max(0, now - Date.parse(runner.lastTickAt))
    const runnerStatus = runnerAgeMs === undefined ? "missing" : runnerAgeMs > RUNNER_STALE_MS ? "stale" : "fresh"
    const queueProgress = options.queueProgress ?? runner?.queueProgress ?? { state: "unknown" as const }
    const progressAgeMs = queueProgress.state === "unknown" ? undefined : QueueRunnerProgress.ageMs(queueProgress, now)
    // A one-shot `queue run` holds the SAME lease as the resident, so the lock
    // alone no longer answers the question this probe exists to answer: is the
    // RESIDENT serving. Reading it as "yes" would report a transient one-shot
    // pass as a live service — and, worse, page `resident-runner-unhealthy`
    // for its missing heartbeat, which a supervisor answers by restarting the
    // resident into a refusal. `facts.lease` stays the honest observation of
    // the lock; only the resident verdict is narrowed, and the one-shot holder
    // is named below rather than passed over in silence.
    const residentHeld = leaseHeld === true && leaseMode !== "once"
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
      planAudit: auditResult.comparison,
    }
    const drift = auditResult.findings.filter(isPlanFinding)
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
          running: residentHeld,
          error: actionableFailure({
            code: first.code,
            message: drift.map((finding) => finding.message).join("\n"),
            // The producer already attached each finding's structured remedy
            // (neither is a yrd command the prose projection could lift); a
            // finding parsed back from a foreign version may lack it, so the
            // code's own remedy is the fallback rather than "retry".
            resolution:
              first.resolution ??
              (first.code === "installed-plan-stale"
                ? [INSTALLED_PLAN_STALE_RESOLUTION]
                : [RUN_PLAN_MISMATCH_RESOLUTION]),
          }),
          facts,
        },
      }
    }
    if (!residentHeld) {
      const hasQueuedWork = app !== undefined && queuedDeliveryCount(app) > 0
      if (hasQueuedWork) {
        // Name the one-shot when there is one: the queue IS being drained, just
        // not by a service, and an operator told only "no runner owns the lease"
        // would start one into a refusal.
        const oneShot = leaseMode === "once" ? " (a one-shot 'yrd queue run' pass currently holds it)" : ""
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
              `the queue has work but no habitant runner owns the drain lease${oneShot}`,
              leaseMode === "once"
                ? ["Let the one-shot pass finish, then start or restart the habitant queue runner."]
                : ["Start or restart the habitant queue runner."],
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
          error: runnerHealthError("resident-runner-unhealthy", `habitant runner lease is held but ${detail}`, [
            "Inspect the lease owner and habitant log, then stop that owner before starting a replacement.",
          ]),
          facts,
        },
      }
    }
    const expectedLastMerged = app === undefined ? undefined : habitantDriverLastMerged(app, base)
    const driverError =
      runner === null ? undefined : runnerDriverHealthError(runner, canonicalQueueId(cwd, base), expectedLastMerged)
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
            "habitant runner lease is held but does not name its queue driver epoch",
            ["Restart the habitant queue runner with the installed Yrd source."],
          )
        : runner?.driver !== undefined &&
            (leaseDriver.queueId !== runner.driver.queueId || leaseDriver.epoch !== runner.driver.epoch)
          ? runnerHealthError(
              "resident-runner-lease-content-mismatch",
              "habitant runner lease content does not match its heartbeat driver epoch",
              ["Stop the mismatched habitant and start one replacement for the expected queue."],
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
            "habitant runner heartbeat is fresh but reports no queue outcome progress",
            ["Restart the habitant queue runner with the installed Yrd source."],
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
            `habitant runner heartbeat is fresh but its queue outcome observation is ${
              progressAgeMs === undefined ? "invalid" : `stale by ${String(progressAgeMs)}ms`
            }`,
            ["Restart the habitant queue runner with the installed Yrd source."],
          ),
          facts,
        },
      }
    }
    if (queueProgress.state === "stalled") {
      return queueContentHealthError(
        service,
        facts,
        "resident-runner-no-progress",
        queueProgress.findings.map((finding) => finding.message).join("\n"),
        // The old text — "inspect queue audit and the habitant log BEFORE
        // restarting the runner" — was circular in the one state it is written
        // for: a stalled queue is exactly when a restart is prescribed, and a
        // reader who took the instruction literally waited on an inspection
        // that names no next step. It also read as a gate while naming no
        // override. It is not a gate: this finding reports `running: false` and
        // hab-core never refuses a start on it (see queueContentHealthError).
        // Say so, then give the two reads that actually name a cause.
        [
          "This is QUEUE CONTENT, not service health: it does not gate the runner, and a restart is NOT refused by it — no override is needed.",
          "Evidence: the cause above is the queue's own progress findings. `yrd queue audit` names the per-change reason, and the selectorless compose logs one `compose-implicit-not-selected` row per change it declined, with the exclusion that dropped it and its remedy.",
          "Remedy: clear the named cause if it is author-side; otherwise restart the habitant queue runner with the installed Yrd source.",
        ],
      )
    }

    const hasQueuedWork = app !== undefined && queuedDeliveryCount(app) > 0
    if (runnerStatus === "fresh" && hasQueuedWork && runnerAgeMs !== undefined && runner !== null) {
      // OBSERVED start when published; `startedAt` (the caller's clock, not
      // this process's own) only for a record written before that field
      // existed.
      const runnerUptimeMs = now - Date.parse(runner.observedStartedAt ?? runner.startedAt)
      if (runnerUptimeMs >= 3 * 60 * 60_000) {
        const expectedLastMerged = app === undefined ? undefined : habitantDriverLastMerged(app, base)
        // NO POSITION IS NOT-MEASURED, and it used to read as 1970. The old
        // `: 0` fallback made `noMergeMs` about fifty-six years whenever no
        // qualifying merge was found, so this test could not fail and the
        // dead-man collapsed onto its first conjunct: it stopped claiming that
        // merging had stopped and started claiming only that the runner had
        // been up three hours. Absence rendered as a value, which is the
        // failure this repository refuses by name.
        //
        // Suppressing is the honest answer for THIS finding: it asserts that a
        // merge cadence stopped, and that assertion needs a last merge to
        // measure from. A queue that has never merged at all may well deserve
        // an alarm, but it is a different claim and wants its own finding
        // rather than this one firing by arithmetic accident. Every other
        // driver check still runs, so nothing is hidden by abstaining here.
        const noMergeMs =
          expectedLastMerged === undefined || expectedLastMerged === null
            ? undefined
            : now - Date.parse(expectedLastMerged.at)
        if (noMergeMs !== undefined && noMergeMs >= 3 * 60 * 60_000) {
          const uptimeFormatted = Math.floor(runnerUptimeMs / 3600000)
          const noMergeFormatted = Math.floor(noMergeMs / 3600000)
          return queueContentHealthError(
            service,
            facts,
            "resident-runner-stalled-no-merge",
            `habitant runner has cycled for >${uptimeFormatted} hours with a non-empty ready set and no merge for >${noMergeFormatted} hours`,
            // Same correction as `resident-runner-no-progress` above, same
            // reason: this is queue content, it refuses no restart, and its old
            // text named an inspection with no next step after it.
            [
              "This is QUEUE CONTENT, not service health: it does not gate the runner, and a restart is NOT refused by it — no override is needed.",
              "Evidence: process presence alone is not progress. `yrd queue audit` names what holds the head change, and the selectorless compose logs one `compose-implicit-not-selected` row per change it declined, with the exclusion that dropped it and its remedy.",
              "Remedy: clear the named cause if it is author-side; otherwise restart the habitant queue runner with the installed Yrd source.",
            ],
          )
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
    return runnerHealthFailure(error, { service, leaseHeld, git })
  }
}

/** Second liveness clock for active seats. Unlike the habitant heartbeat, this
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
  const queueProgress = habitantQueueProgress(app, new Date(nowMs).toISOString())
  const runner = activeHabitantRunner(await habitantRunnerStatus(cwd))
  const runnerAgeMs = runner === null ? undefined : Math.max(0, nowMs - Date.parse(runner.lastTickAt))
  const runnerError =
    runner === null
      ? queuedDeliveryCount(app) > 0
        ? runnerHealthError(
            "resident-runner-missing",
            "the queue has work but no habitant runner owns the drain lease",
            ["Start or restart the habitant queue runner."],
          )
        : undefined
      : runnerAgeMs !== undefined && runnerAgeMs > RUNNER_STALE_MS
        ? runnerHealthError("resident-runner-unhealthy", `habitant runner heartbeat is stale by ${runnerAgeMs}ms`, [
            "Inspect the habitant runner log, then restart it.",
          ])
        : runnerDriverHealthError(runner, canonicalQueueId(cwd, base), habitantDriverLastMerged(app, base))
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
  const distance = result.payload.facts.git.base
  const gitLines =
    result.payload.facts.git.headSha === "unknown"
      ? ["git: not read — the health probe failed before its git read"]
      : distance === undefined
        ? [`git: queue base does not resolve in ${result.payload.facts.git.cwd}; no distance to report`]
        : [
            distance.unavailable === undefined
              ? `git ${distance.base}: ahead=${distance.ahead ?? 0} behind=${distance.behind ?? 0} tip=${distance.baseSha.slice(0, 12)}`
              : `git ${distance.base}: distance unavailable (${distance.unavailable})`,
          ]
  const human = [
    `yrd-runner ${result.payload.state} (lease=${result.payload.facts.lease}, heartbeat=${result.payload.facts.runnerStatus})`,
    ...(result.payload.error === undefined ? [] : [formatActionableFailure(result.payload.error)]),
    ...gitLines,
    // The denominator, printed whether or not anything was found: which plan
    // the probe compared against the tip (the habitant's published one, or
    // none and why), so a clean probe never reads as an unread one.
    ...(result.payload.facts.planAudit === undefined ? [] : [queueAuditComparisonLine(result.payload.facts.planAudit)]),
  ].join("\n")
  // Non-fatal by construction: a stale draft (or an unrouted needs-person
  // change) never flips `state`/`exitCode` — draft WIP is first-class
  // (operator ruling) and a parked PR does not mean the queue itself is
  // stalled (@i/10-merge-queue/22918-needs-person-unowned) — but it must
  // still reach whoever reads this command, JSON or human, which
  // `printResultWithWarnings` already does uniformly for every other advisory
  // finding in this CLI (queuePauseWarnings, queue-read failures).
  const warnings = [
    ...staleDraftWarnings(result.payload.facts.runner?.staleDrafts ?? []),
    ...needsPersonWarnings(result.payload.facts.runner?.needsPerson ?? []),
  ]
  await printResultWithWarnings(io, jsonEnabled(options), result.payload, human, warnings)
  return result.exitCode
}

export type HabitantRunnerReclaim = Readonly<{ reclaim: false }> | Readonly<{ reclaim: true; runner: string }>

/**
 * Decide whether an incoming habitant runner should reclaim the leases of the
 * prior habitant recorded in `status.json`. The prior habitant is reclaimable
 * only when it is a different process that is no longer alive; a live prior pid
 * (or an absent status file) yields no reclaim. `isProcessAlive` is injected so
 * the decision is unit-testable without spawning a process.
 */
export function planHabitantRunnerReclaim(
  prior: QueueTimelineRunner | null,
  currentPid: number,
  isProcessAlive: (pid: number) => boolean,
): HabitantRunnerReclaim {
  if (prior === null || prior.pid === currentPid) return { reclaim: false }
  if (isProcessAlive(prior.pid)) return { reclaim: false }
  return { reclaim: true, runner: `yrd-cli:${prior.pid}` }
}

async function reclaimDeadHabitantRunner(app: YrdCliApp, io: YrdCliIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  const prior = await habitantRunnerStatus(cwd)
  // Reclaim consumes the same verdict display does — one liveness rule, so
  // recovery can never disagree with the projection about whether the prior
  // runner is still there. This replaced a second, byte-identical bare-signal
  // helper that existed only because nothing owned the question.
  const decision = planHabitantRunnerReclaim(prior, process.pid, habitantRunnerRunning)
  if (!decision.reclaim) return
  const runs = await app.queue.recover({
    recoveryTime: new Date(io.now?.() ?? Date.now()).toISOString(),
    reason: "previous habitant runner disappeared",
    runner: decision.runner,
  })
  if (runs.length === 0) return
  io.stderr(`Reclaimed ${runs.length} run(s) from a departed habitant runner ${decision.runner}.\n`)
}

type HabitantRunnerHeartbeat = Readonly<{
  check(): void
  /** Publish terminal progress evidence before a typed habitant control transfer. */
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

export async function startHabitantRunnerHeartbeat(
  io: YrdCliIO,
  options: Readonly<{
    intervalMs?: number
    queueProgress?: (now: string) => QueueRunnerProgress
    /** Exact policy already resolved by the mutable journal; never re-derived here. */
    retention?: JournalRetentionPolicy
    /** Last stranded-refs sweep, if one has completed. Returning undefined is a
     * real answer — the rail says the sweep hasn't produced an observation
     * yet rather than 0. */
    uncarried?: () => StrandedObservation | undefined
    driver?: Readonly<{
      queueId: string
      epoch?: string
      lastMerged: () => QueueDriverEpoch["lastMerged"]
    }>
    /** Page-worthy `draft-stranded` findings, re-derived every tick exactly
     * like `queueProgress` — so the health probe (which has no app and no
     * journal, and cannot afford either) can prove them from the status file
     * instead of re-deriving draft state itself. */
    staleDrafts?: (now: string) => readonly QueueAuditFinding[]
    /** `admission-refusal-needs-person` findings, re-derived every tick
     * exactly like `staleDrafts` — no age gate, since a settlement is
     * page-worthy the moment it exists
     * (@i/10-merge-queue/22918-needs-person-unowned). */
    needsPerson?: (now: string) => readonly QueueAuditFinding[]
    /** The step plan this habitant built — published so the supervisor
     * probe can compare it against the base tip's declared plan without a
     * runtime of its own (23192 leg c). Read once: it is static for the pid. */
    installedPlan?: () => HabitantInstalledPlan
  }> = {},
): Promise<HabitantRunnerHeartbeat> {
  const cwd = io.cwd ?? process.cwd()
  const path = habitantRunnerStatusPath(cwd)
  if (path === undefined) {
    raiseFailure(
      "infrastructure",
      "resident-runner-status-unavailable",
      `yrd: cannot resolve habitant runner status path from '${cwd}'`,
    )
  }
  const intervalMs = options.intervalMs ?? HABITANT_RUNNER_HEARTBEAT_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError("yrd: habitant runner heartbeat interval must be a positive integer")
  }
  const directory = join(path, "..")
  const temporary = `${path}.${process.pid}.tmp`
  const implementationSource = io.implementationSource
  if (implementationSource === undefined) {
    raiseFailure(
      "refusal",
      "runtime-source-unavailable",
      "yrd: habitant runner startup did not capture an implementation source; not serving",
    )
  }
  const nowIso = (): string => {
    const now = io.now?.() ?? Date.now()
    if (!Number.isFinite(now) || now < 0) throw new TypeError("yrd: habitant runner heartbeat clock is invalid")
    return new Date(now).toISOString()
  }
  const startedAt = nowIso()
  // Observed once at boot, from this process's OWN clock via /proc (or the
  // platform equivalent) — never `io.now()`, which is the caller's clock and
  // exactly what `startedAt` above already is (the gap `habitantRunnerRunning`
  // flags: a logical timestamp is unsafe to compare against a live process's
  // actual age). `kind !== "identified"` — a platform this cannot read —
  // means "not measured", written as absent, never standing in `startedAt`'s
  // value for it.
  const bootObservation = observePidSync(process.pid)
  const observedStartedAt =
    bootObservation.kind === "identified" && bootObservation.identity.startedAtMs !== undefined
      ? new Date(bootObservation.identity.startedAtMs).toISOString()
      : undefined
  let recordedProgress: QueueRunnerProgress | undefined
  const driverEpoch = options.driver === undefined ? undefined : (options.driver.epoch ?? randomUUID())
  if (options.retention !== undefined && driverEpoch === undefined) {
    raiseFailure(
      "configuration",
      "resident-retention-generation-unavailable",
      "yrd: habitant retention policy cannot be attested without a driver generation",
    )
  }
  // The dedicated RUNNER box renders this verbatim: `[pid] <command>`.
  const command = [basename(process.argv[0] ?? "bun"), ...process.argv.slice(1)].join(" ")
  const installedPlan = options.installedPlan?.()
  if (installedPlan?.steps.length === 0) {
    raiseFailure(
      "configuration",
      "habitant-installed-plan-empty",
      "yrd: habitant runner has no installed steps to publish; a queue with no plan cannot serve",
    )
  }
  const writeStatus = async (exit?: Readonly<{ exitedAt: string; clean: boolean }>): Promise<void> => {
    await mkdir(directory, { recursive: true })
    const lastTickAt = nowIso()
    const queueProgress = recordedProgress ?? options.queueProgress?.(lastTickAt)
    const uncarried = options.uncarried?.()
    const staleDrafts = options.staleDrafts?.(lastTickAt)
    const needsPerson = options.needsPerson?.(lastTickAt)
    const status: QueueTimelineRunner = {
      pid: process.pid,
      startedAt,
      ...(observedStartedAt === undefined ? {} : { observedStartedAt }),
      lastTickAt,
      ...(queueProgress === undefined ? {} : { queueProgress }),
      // Omitted, never zeroed: absent means not measured, and the rail must be
      // able to tell that from a swept-and-clean queue.
      ...(uncarried === undefined ? {} : { uncarried }),
      // Unlike `uncarried`, an EMPTY array is a meaningful, common measurement
      // ("no stale drafts", "nothing needs a person") and is written as such —
      // only a caller that never wired the option at all (an older habitant)
      // omits the key.
      ...(staleDrafts === undefined ? {} : { staleDrafts }),
      ...(needsPerson === undefined ? {} : { needsPerson }),
      ...(installedPlan === undefined ? {} : { installedPlan }),
      ...(options.retention === undefined || driverEpoch === undefined
        ? {}
        : {
            retention: {
              policy: options.retention,
              source: "mutable-journal",
              observedAt: lastTickAt,
              generation: driverEpoch,
            },
          }),
      ...(options.driver === undefined || driverEpoch === undefined
        ? {}
        : {
            driver: {
              queueId: options.driver.queueId,
              epoch: driverEpoch,
              lastMerged: options.driver.lastMerged(),
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
        // marker instead: a successor habitant reads this (not null) and reclaims
        // this pid's leases via planHabitantRunnerReclaim, clean or not — the
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

/** How many of the journal's earliest frames the coverage probe reads before it
 * gives up and scans the whole journal. One frame answers it in practice —
 * every dispatched command writes its events into a frame — and eight absorbs a
 * short eventless prefix without approaching the size of the read it avoids.
 * The probe trades work, never accuracy: a prefix that cannot answer falls
 * through to the exact scan below. */
const COVERAGE_PROBE_FRAMES = 8

/** The timestamp the journal's coverage starts at: its earliest still-replayable
 * event's `ts`.
 *
 * Events come out in cursor order, so the answer sits in the journal's first
 * frames — but `app.events()` resolves its whole range before it yields, so
 * asking for one timestamp unbounded decodes every frame the journal holds.
 * Measured on the live 42,011-frame hh journal: 1,849-2,140 ms of a 3.8-4.3 s
 * `yrd log`, to read a single string. Bounding the probe makes the cost
 * independent of how long the journal has been running.
 *
 * Both reads start at the retention floor rather than at cursor 0. The journal
 * evicts a prefix of already-checkpointed frames and then REFUSES a replay
 * that begins below the floor, rather than return a history with a hole in it
 * — and the refusal turns on `after`, so bounding the probe with `before` does
 * not escape it and the unbounded fallback would throw as well. Reading from
 * the floor is also the honest answer to the question asked: coverage genuinely
 * begins at the first frame that still exists. */
async function firstEventTimestamp(app: YrdCliApp): Promise<string> {
  const head = (await app.journalSnapshot()).asOf.cursor
  if (head === 0) return "-"
  const floor = app.retentionDiagnostics().journal?.evictedThrough ?? 0
  if (floor >= head) return "-"
  const probe = Math.min(floor + COVERAGE_PROBE_FRAMES, head)
  for await (const event of app.events(floor, probe)) return event.ts
  if (probe === head) return "-"
  for await (const event of app.events(floor)) return event.ts
  return "-"
}

/**
 * `since` is a THUNK, and that is the whole point of this signature.
 *
 * The only caller's argument is {@link firstEventTimestamp}, which reads the
 * retention floor through `app.retentionDiagnostics()` — and that eagerly runs
 * the journal's full-frame fact audit. Measured 2026-09-01 against the live
 * 92,616-frame hh journal: 1.70 GB of resident set and 6.5-7.7 SECONDS with
 * the event loop blocked, for one string.
 *
 * Every repository past the legacy migration then throws that string away: with
 * no `events.jsonl` and no `bay/journal.jsonl` this returns `undefined` and
 * `since` is never read. `yrd log -L 200 --json` was paying the full audit on
 * every invocation to compute a value it discarded — 10.8 s and 3.52 GB peak to
 * print 898 KB, and seats run it routinely.
 *
 * Passing a thunk keeps the reported coverage byte-identical wherever a legacy
 * file really exists, and costs nothing where one does not. A flag was the
 * other option and is strictly worse: it would make the common path cheap only
 * for callers who knew to ask.
 */
export async function queueLegacyCoverage(
  cwd: string,
  since: () => Promise<string>,
): Promise<QueueLogCoverage | undefined> {
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
  // The audit runs HERE or not at all: only a repository that really carries a
  // legacy file pays for the timestamp that describes it.
  return legacy.length === 0 ? undefined : { since: await since(), completeness: "queue-only", legacy }
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
  term?: readonly string[]
  /** Restore the pre-containment refusal: abort the whole read (exit 3) on the
   * first run member whose clocks cannot be reconciled, instead of marking its
   * row `unreadable` and rendering the rest. Same shape and meaning as
   * `yrd log --strict`. */
  strict?: boolean
}>

type WatchOptions = QueueListOptions

type JsonOption = { json?: boolean }

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
  status: ChangeDeliveryState | "needs-author"
  at: string
  runs: readonly string[]
  props?: ChangeProps
}>

type TrackerBounce = Readonly<{ run: string; detail?: string }>

type TrackerDeliveryV1 =
  | (TrackerDeliveryIdentity & Readonly<{ status: "pushed" | "submitted" | "withdrawn" | "canceled" }>)
  | (TrackerDeliveryIdentity & Readonly<{ status: "rejected"; bounce: TrackerBounce }>)
  | (TrackerDeliveryIdentity & Readonly<{ status: "integrated"; landingSha: string }>)
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
  | (TrackerDeliveryIdentity &
      Readonly<{ status: "needs-author"; bounce: TrackerBounce; attributedResult: JobErrorFact }>)

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
  pr: DeepReadonly<Change>,
  state: DeepReadonly<YrdCliState>,
  eligibility: ChangeEligibility,
): TrackerDeliveryV2 | undefined {
  if (pr.issue === undefined) return undefined
  const revision = currentChangeRev(pr)
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
    ...(revision.props === undefined ? {} : { props: revision.props }),
  }
  // The needs-author DECISION belongs to the display-state projection
  // (@yrd/queue), never re-derived here: `projectedChangeStatus` reads
  // terminality first, so a closed change whose stored refusal outlived its
  // close reports its closing state (integrated / already-landed / withdrawn /
  // canceled) below instead of bouncing to the author. Only the refusal FACT
  // (clock, run, receipt) is looked up locally, and only once the projection
  // has ruled the state IS needs-author.
  const refusalFact =
    projectedChangeStatus(pr, eligibility) !== "needs-author"
      ? undefined
      : (changeNeedsAuthor(pr) ??
        (eligibility.reason?.code === "needs-author" && eligibility.reason.result !== undefined
          ? {
              at: pr.rejectedAt ?? revision.submittedAt ?? revision.pushedAt,
              run: pr.terminalRun ?? eligibility.checks.run ?? "unknown",
              receipt: eligibility.reason.result,
              detail: eligibility.reason.message,
            }
          : undefined))
  if (refusalFact !== undefined) {
    return {
      ...identity,
      status: "needs-author",
      at: refusalFact.at,
      bounce: {
        run: refusalFact.run,
        ...(refusalFact.detail === undefined ? {} : { detail: refusalFact.detail }),
      },
      attributedResult: refusalFact.receipt,
    }
  }
  const delivery = changeDeliveryState(pr)
  switch (delivery) {
    case "pushed":
      return { ...identity, status: "pushed", at: revision.pushedAt }
    // `ready` is revision-admission evidence inside Yrd. The delivery remains
    // externally submitted until it reaches a terminal merge state.
    case "ready":
    case "submitted":
      return revision.submittedAt === undefined
        ? undefined
        : { ...identity, status: "submitted", at: revision.submittedAt }
    case "needs-author":
      refusal(`trackerBridge v2 cannot project needs-author change '${pr.id}' without an attributed result`)
    case "rejected":
      if (pr.rejectedAt === undefined) return undefined
      if (pr.terminalRun === undefined) {
        refusal(`trackerBridge v1 cannot project rejected change '${pr.id}' without a typed Queue bounce run`)
      }
      const bounce = { run: pr.terminalRun, ...(pr.detail === undefined ? {} : { detail: pr.detail }) }
      return {
        ...identity,
        status: "rejected",
        at: pr.rejectedAt,
        bounce,
      }
    case "integrated": {
      const merge = ChangeMergeOutcome(pr)
      if (merge.outcome !== "landed") refusal(`integrated change '${pr.id}' has no canonical merge outcome`)
      return {
        ...identity,
        status: "integrated",
        at: merge.at,
        landingSha: merge.landingSha,
      }
    }
    case "already-landed": {
      const merge = ChangeMergeOutcome(pr)
      if (merge.outcome !== "already-landed") {
        refusal(`change '${pr.id}' is recorded as already merged but has no canonical equivalence proof`)
      }
      return {
        ...identity,
        status: "already-landed",
        at: merge.at,
        baseSha: merge.baseSha,
        candidateSha: merge.candidateSha,
        candidateTreeSha: merge.candidateTreeSha,
        baseTreeSha: merge.baseTreeSha,
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
    ...(delivery.props === undefined ? {} : { props: delivery.props }),
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
      throw new TypeError(`trackerBridge v1 status mapping for '${delivery.status}' lost its merge`)
    }
    return {
      ...identity,
      status,
      landingSha: delivery.landingSha,
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

/**
 * One DERIVED member's delivery row, from its newest retained root run plus the
 * branch's standing submit fact. A derived member is recordless BY DESIGN (the
 * S6 door composes it from the branch-submit fact; the terminal reducers
 * deliberately no-op for its id — "S6 relaxation", @yrd/bay plugin.ts), so its
 * delivery truth is never in `bays.prs` and must be read from the run records.
 *
 * The integration proof is read through `app.queue.get` — for a retained
 * record that is exactly `materializeRun(record, jobs)`, the same
 * materialization whose `settledRun.integration` the settle command's
 * derived-terminals batch emits from (@yrd/queue queue.ts `settled`), so this
 * projection and the settlement facts can never disagree about the proof.
 */
function derivedTrackerDelivery(
  app: YrdCliApp,
  state: DeepReadonly<YrdCliState>,
  record: DeepReadonly<QueueRecord>,
  member: ChangeSnapshot,
): TrackerDeliveryV2 | undefined {
  if (member.issue === undefined) return undefined
  const runs = Queues.values(state.queues)
    .filter((candidate) =>
      candidate.prs.some(
        (snapshot) =>
          snapshot.id === member.id && snapshot.revision === member.revision && snapshot.headSha === member.headSha,
      ),
    )
    .toSorted((left, right) => {
      const started = left.startedAt.localeCompare(right.startedAt)
      return started === 0 ? compareNatural(left.id, right.id) : started
    })
    .map(({ id }) => id)
  const identity = {
    issueRef: member.issue,
    pr: member.id,
    revision: member.revision,
    headSha: member.headSha,
    runs,
    ...(member.props === undefined ? {} : { props: member.props }),
  }
  const run = app.queue.get(record.id)
  const integration = run?.integration
  if (run?.status === "completed" && run.conclusion === "success" && integration !== undefined) {
    const at = run.finishedAt ?? record.passedAt ?? record.startedAt
    const alreadyLanded = integration.alreadyLanded
    if (alreadyLanded !== undefined) {
      return {
        ...identity,
        status: "already-landed",
        at,
        baseSha: integration.baseSha,
        candidateSha: alreadyLanded.candidateSha,
        candidateTreeSha: alreadyLanded.candidateTreeSha,
        baseTreeSha: alreadyLanded.baseTreeSha,
      }
    }
    return { ...identity, status: "integrated", at, landingSha: integration.commit }
  }
  // The DERIVED lane retires no submit fact: the fact standing at exactly the
  // member's head is the branch's continuing consent — the queue re-serves it
  // or the author re-pushes. That covers a run that PASSED without an
  // integration proof (check-only / admission-only passes: the merge is still
  // pending, and skipping the row would blind the bridge to the
  // staged-but-unlanded window) and a canceled run alike: projecting
  // "submitted" there is true (not terminally resolved) and imprecise, but a
  // cancel is the queue's act, not a verdict on the author's code.
  //
  // A run that RAN AND FAILED is the one shape that narrows. `submitted` was
  // true of it too, and a consumer could not tell "waiting to run" from "ran
  // and failed" — the blur this closes.
  //
  // The failure fact is read off the run, NOT off `queues.admissionRefusals`.
  // The ledger looks like the right source and is not: measured on this base,
  // the row a failed derived member earns is
  // `queue-submit-authority-consumed` — the queue declining to re-serve a
  // fact run R1 already consumed. That is bookkeeping, and the same row is
  // written for a member whose run has not failed, so attributing it would
  // trade this blur for an affirmative lie. The run record carries the typed
  // receipt and its own clock; that is the verdict.
  const failure =
    record.failure ??
    (run?.status === "completed" && run.conclusion === "failure" && run.error !== undefined
      ? { at: run.finishedAt ?? record.startedAt, error: run.error }
      : undefined)
  const submit = state.bays.submits[member.branch]
  if (submit !== undefined && submit.sha === member.headSha) {
    // Inside the fact-stands branch on purpose: a failed run whose fact has
    // MOVED is superseded, and the tail below must keep answering `undefined`
    // for it — the author already re-pushed, and that newer fact's own
    // composition projects the next row.
    if (failure !== undefined) {
      return {
        ...identity,
        status: "needs-author",
        at: failure.at,
        // `detail` carries the message because trackerBridge v1 maps
        // needs-author to `rejected` and keeps only `bounce` — without it the
        // v1 consumer (the tent delivery projection) gets a failed row with an
        // empty diagnostic column.
        bounce: { run: record.id, detail: failure.error.message },
        attributedResult: failure.error,
      }
    }
    return { ...identity, status: "submitted", at: submit.at }
  }
  const terminal =
    run !== undefined
      ? run.status === "completed"
      : record.failure !== undefined || record.canceledAt !== undefined || record.passedAt !== undefined
  // Still running with the fact moved or gone: the run is live delivery work
  // at this revision even though a newer push supersedes its consent, so the
  // row stays visible; only the fact's `at` is lost, so fall back to the
  // run's own start.
  if (!terminal) return { ...identity, status: "submitted", at: record.startedAt }
  // Terminal without an integration proof AND the fact vanished or moved off
  // this head: superseded — the branch's current truth is a newer fact (or
  // none), and that fact's own composition projects the next row.
  return undefined
}

/**
 * DERIVED delivery rows for the tracker bridges — the projection that keeps
 * `yrd issue --json` (and the tent tracker bridge behind it) sighted on
 * deliveries that never mint a Change record.
 *
 * Selection: retained ROOT runs, newest `startedAt` first; the first member
 * seen per BRANCH claims it (the newest run is the branch's current delivery
 * attempt — older runs' members for a claimed branch are skipped outright,
 * row or no row).
 *
 * A branch-submit FACT with no retained run yet (never composed) projects
 * NOTHING here: the pending window between `pr submit` and the first compose
 * is a declared blind spot of this bridge (known wave item, alongside the
 * durable refusal ledger), not a silent one.
 *
 * That blind spot SWALLOWS A FAILURE. This is NOT unfinished work waiting to
 * be picked up here — do not reach for a wider scan in this loop, because the
 * data it would scan for does not exist. A branch REFUSED at admission — its
 * required check ran and exited non-zero — is inside the same window, so it
 * gets no row: the queue never composes it, so no member and no run record
 * exist for this loop to visit. Nor is the failure recoverable from
 * `queues.admissionRefusals`. Measured on this base: three refused drains of
 * one branch produced three admission Jobs, all `completed`/`failure` with a
 * typed error, and left that ledger EMPTY the whole time — `noteCandidateRefusal`
 * attributes through `resolveMemberById`, which needs a record or a retained
 * snapshot, a refused branch has neither, and the attribution hits `continue`.
 * The only durable trace is an `admission:<id>:<revision>:…` Job key whose id
 * is freshly minted every cycle (PR1, PR2, PR3 over those three drains) and
 * which names no branch, so it carries neither a stable delivery identity nor
 * the `issueRef` this row type requires (`ProjectedBranchSubmit` is
 * `{sha, base, at}`; the issue reaches a member only via `readSubmitEnrichment`
 * at admission).
 *
 * So the missing piece is a DURABLE REFUSAL LEDGER for recordless members, not
 * a projection fallback: the producer must record the refusal and key it by
 * branch before any reader here can report it. That is an architectural door
 * (@i/10-yrd/23237 case B), and it is decided, not slipped in beside a
 * projection fix.
 *
 * Disjointness with the record rows is by construction: record rows project
 * from `bays.prs`, derived rows only from members whose id has no record
 * (`isDerivedRunMember`), so no id — and no branch — produces both.
 */
function derivedTrackerDeliveries(app: YrdCliApp, state: DeepReadonly<YrdCliState>): TrackerDeliveryV2[] {
  const roots = Queues.values(state.queues)
    .filter((record) => record.parent === undefined)
    .toSorted((left, right) => {
      const started = right.startedAt.localeCompare(left.startedAt)
      return started === 0 ? compareNatural(right.id, left.id) : started
    })
  const claimed = new Set<string>()
  const deliveries: TrackerDeliveryV2[] = []
  for (const record of roots) {
    for (const member of record.prs) {
      if (!isDerivedRunMember(state.bays, member)) continue
      if (claimed.has(member.branch)) continue
      claimed.add(member.branch)
      const delivery = derivedTrackerDelivery(app, state, record, member)
      if (delivery !== undefined) deliveries.push(delivery)
    }
  }
  return deliveries.toSorted((left, right) => compareNatural(left.pr, right.pr))
}

function trackerBridges(
  app: YrdCliApp,
  snapshot: JournalSnapshot<YrdCliState>,
  include: (delivery: TrackerDeliveryV2) => boolean,
): Readonly<{ trackerBridge: TrackerBridgeV1; trackerBridgeV2: TrackerBridgeV2 }> {
  const recorded = recordChanges(snapshot.state.bays)
    .map((pr) => trackerDeliveryV2(pr, snapshot.state, app.queue.eligibility(pr.id, snapshot.state)))
    .filter((delivery): delivery is TrackerDeliveryV2 => delivery !== undefined && include(delivery))
    .toSorted((left, right) => compareNatural(left.pr, right.pr))
  const derived = derivedTrackerDeliveries(app, snapshot.state).filter(include)
  const deliveries = [...recorded, ...derived]
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
    const taskStatus = changeDeliveryTaskStatusOf(delivery.status)
    return {
      pr: delivery.pr,
      revision: delivery.revision,
      headSha: delivery.headSha,
      status: delivery.status,
      runs: delivery.runs,
      ...taskStatusFields(taskStatus),
      ...(delivery.status === "integrated" ? { landingSha: delivery.landingSha } : {}),
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
        ? { bounce: delivery.bounce, attributedResult: delivery.attributedResult }
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

/**
 * WHERE THE OPERATOR IS STANDING — the one derivation, for every question of
 * the form "which bay/branch is this invocation in?".
 *
 * `io.cwd` cannot answer it. The process host overwrites `io.cwd` with the
 * DISCOVERED repository worktree (`host.ts`, the runtime io it hands the
 * command tree), so by the time any command reads it, the operator's own
 * directory is gone and every caller sees the repository root instead.
 *
 * Measured (@yrd/bay-submit-record/22958): `yrd --repo <root> bay submit` run
 * from inside bay B1 inferred its selector from the ROOT's current branch —
 * `main` — and submitted the base tip to the derived lane. Exit 0, a success
 * envelope naming branch `main`, and a fact the queue can never select
 * (`compose-derived-fact-landing-unresolved`: the authored tip IS the walked
 * tip, so containment holds for free and nothing is ever merged). The bay's
 * real commit was never submitted at all. That is the bead's consequence class
 * exactly — a submission that can never run is indistinguishable, on every
 * surface an author reads, from one that is merely waiting its turn.
 *
 * The ambient directory survives under {@link RuntimeInvocationCwd}, set on
 * this same io before the host's assignment lands. `yrd in`/`bay run` already
 * read it for this reason; this is that read, named once, so the submit path
 * and the guest-attach path cannot disagree about where the operator stands.
 *
 * The fallback is the in-process test seam: `runYrd(app, argv, io)` sets no
 * symbol, and there `io.cwd` IS the ambient directory.
 *
 * CONTAINMENT IS THE WHOLE RULE, and dropping it inverts the defect. Standing
 * somewhere unrelated to the selected repository — outside Git entirely, or in
 * a different checkout — the ambient directory says nothing about THIS
 * repository, and `--repo` is the operator's whole statement of intent. So the
 * ambient answer is taken only where it is an answer about this repository:
 * inside its worktree (a Bay lives under it) or under its repository root.
 * Otherwise the selected worktree stands, which is what `--repo` selected.
 */
function invocationCwd(io: YrdCliIO): string {
  const worktree = io.cwd ?? process.cwd()
  const ambient = (io as RuntimeInvocationIO)[RuntimeInvocationCwd]
  if (ambient === undefined) return worktree
  const inRepository =
    within(worktree, ambient) || (io.repositoryRoot !== undefined && within(io.repositoryRoot, ambient))
  return inRepository ? ambient : worktree
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
  // `continueAdmissions` is NOT a drain marker, whatever its type says. The
  // engine reads its mere PRESENCE as "this caller admits one change per turn"
  // (`queue.ts` — `queued.slice(0, 1)`), which is the resident habitant's shape;
  // a one-shot pass dispatches the whole queue in a single turn and composes
  // one multi-member run out of it. Now that a one-shot ALSO carries a drain
  // signal, keying the install on that signal would have silently serialized
  // every one-shot pass into single-member runs — a change to what the queue
  // produces, smuggled in by a change to how it stops. So it is keyed on the
  // resident driver identity, which is what it always actually meant: `driver`
  // is host-minted for `leaseMode: "resident"` and stays undefined for a
  // one-shot pass.
  const resident = io.driver !== undefined
  return {
    runner: io.runner ?? "yrd-cli",
    leaseMs: io.leaseMs ?? 5 * 60_000,
    ...(io.now === undefined ? {} : { now: io.now }),
    ...(drainSignal === undefined || !resident ? {} : { continueAdmissions: () => !drainSignal.aborted }),
  }
}

function stateOf(app: YrdCliApp): YrdCliState {
  return app.state()
}

function knownBases(state: YrdCliState): string[] {
  return [
    "main",
    ...Object.values(state.bays.byId).map((bay) => bay.base),
    ...recordChanges(state.bays).map((pr) => pr.base),
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
  const result = HabGenerationReleaseResultSchema.parse(input.authorization.receipt)
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
      result: {
        schema: result.schema,
        jurisdiction: result.jurisdiction,
        habitatRoot: result.habitatRoot,
        retiredSource: result.retiredSource,
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
  const result = DeploymentSourceResultSchema.parse(successfulJobOutput(job))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "deployment.materialize", job: job.id, result },
    `${result.path}\n`,
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
  deploymentResultPath: string,
  habReleaseResultPath: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const deployment = DeploymentSourceResultSchema.parse(await readJson(deploymentResultPath, "deployment result"))
  const habRelease = await readJson(habReleaseResultPath, "Hab generation release result")
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
        if (bay === undefined) refusal(`no bay '${selector}'; run 'yrd bay' to list available Bays`)
        return bay
      }),
    )
  }
  const local = currentBay(state, cwd)
  if (local !== undefined) return [local]
  const live = sortedBays(state).filter((bay) => bay.status !== "closed")
  if (live.length === 0) {
    refusal(`no bays are available to ${action}; run 'yrd bay open --bay <name>' to create one`)
  }
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

function parseProps(values: unknown): ChangeProps | undefined {
  if (values === undefined) return undefined
  const list = Array.isArray(values) ? values : [values]
  if (list.length === 0) return undefined
  const props: Record<string, string> = {}
  for (const value of list) {
    if (typeof value !== "string") usage("--prop requires <key>=<value>")
    const separator = value.indexOf("=")
    if (separator < 1) usage("--prop requires <key>=<value>")
    const key = value.slice(0, separator)
    const next = value.slice(separator + 1)
    const previous = props[key]
    if (previous !== undefined && previous !== next) {
      usage(`--prop '${key}' was given twice with different values`)
    }
    props[key] = next
  }
  try {
    return ChangePropsSchema.parse(props)
  } catch {
    usage("--prop requires <key>=<value>")
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
    prs: result.prs.map(projectChangeTaskStatus),
    ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
    ...(result.eligibilities === undefined
      ? {}
      : { eligibilities: result.eligibilities.map(projectEligibilityTaskStatus) }),
  }
}

function projectEligibilityTaskStatus(eligibility: ChangeEligibility) {
  return {
    ...eligibility,
    checks: { ...eligibility.checks, ...taskStatusFields(checkTaskStatusOf(eligibility.checks)) },
  }
}

type ChangeListStatusProjection = Omit<ReturnType<typeof projectChangeTaskStatus>, "status"> &
  Readonly<{
    /** answers: What delivery result should a reader act on? tense: current. */
    status: ChangeDeliveryState | "needs-author"
    /** answers: What delivery status did the rebuildable index record? tense: historical. */
    nativeStatus?: ChangeDeliveryState
    /** answers: Why did repository proof override nativeStatus? tense: current. */
    mergedOnBase?: Readonly<Pick<ChangeMerge, "baseSha" | "headSha" | "code">>
  }>

function projectChangeTaskStatusWithEligibility(
  pr: Change,
  eligibility: ChangeEligibility,
  merge?: ChangeMerge,
): ChangeListStatusProjection {
  const projected = projectChangeTaskStatus(pr)
  // A proven merge is the strongest projection there is: it contradicts the
  // recorded state with content, so it wins over both the native state and the
  // eligibility projection. `nativeStatus` keeps the record readable (22376).
  if (merge !== undefined) {
    return {
      ...projected,
      nativeStatus: merge.recorded,
      status: "already-landed" as const,
      mergedOnBase: { baseSha: merge.baseSha, headSha: merge.headSha, code: merge.code },
    }
  }
  const status = projectedChangeStatus(pr, eligibility)
  const nativeStatus = changeDeliveryState(pr)
  return status === nativeStatus ? projected : { ...projected, nativeStatus, status }
}

function projectCheckTaskStatus(check: ChangeCheckViewRecord) {
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
      pr === undefined
        ? `expected head ${options.expectedHead}`
        : `change '${pr}' revision head ${options.expectedHead}`
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
  targetedPr?: Change,
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
    if (!isLiveChange(targetedPr)) {
      refusal(`change '${targetedPr.id}' is ${changeDeliveryState(targetedPr)}; --pr requires a live change`)
    }
    if (issue !== undefined && targetedPr.issue !== undefined && issue !== targetedPr.issue) {
      refusal(`--issue '${issue}' does not match change '${targetedPr.id}' issue '${targetedPr.issue}'`)
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
  const claimPrs = issue === undefined ? [] : app.bays.prs().filter((pr) => pr.issue === issue && isLiveChange(pr))
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
  const terminalDefault = prs.some((pr) => pr.branch === defaultBranch && pr.issue === issue && !isLiveChange(pr))
  const collisionBranch = `${defaultBranch}-${createHash("sha256").update(claim).digest("hex").slice(0, 8)}`
  const branch = isForeignBranch(defaultBranch) || terminalDefault ? collisionBranch : defaultBranch
  if (isForeignBranch(branch)) {
    refusal(
      `claim '${claim}' collides with existing branch '${branch}'; ` +
        "link a distinct draft change branch to the claim, then reopen the bay",
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
  const openState = stateOf(app)
  // Both lanes: a change delivered through the receiver is a legitimate `--pr`
  // target — it has a branch to seed the bay from — and refusing it with
  // "create it explicitly" told the operator to make a change that already
  // existed.
  const targetedPr =
    options.pr === undefined
      ? undefined
      : (resolveQueueChange(openState.bays, openState.queues, options.pr) ??
        refusal(`no change '${options.pr}'; create it explicitly before using --pr`))
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
  return targetedPr === undefined ? identity : { ...identity, from: changeHead(targetedPr) }
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
    effectiveBase?: Readonly<{ base: string; baseSha?: string }>
  }>,
  resolution: string,
  write: (text: string) => unknown = io.stdout,
): void {
  const base =
    resolved.effectiveBase === undefined
      ? ""
      : `, base ${resolved.effectiveBase.base}${resolved.effectiveBase.baseSha === undefined ? "" : `@${resolved.effectiveBase.baseSha.slice(0, 12)}`}`
  write(
    `bay ${resolved.bay} → ${resolution} ${resolved.branch}, ` +
      `${resolved.issue === undefined ? "no issue linked" : `linked ${resolved.issue}`}${base}\n`,
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

/** A habitant's first signal is a graceful drain: stop admitting work but let
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
  // A Bay is the queue's own throwaway worktree — package resolution failing
  // in it (a cold cache, a submodule the hook quarantine left unpopulated) is
  // an environment fault, not a verdict on the branch. `refusal` blames the
  // author and tells them to fix a branch that was never broken; infrastructure
  // is the kind that retries (22917). Same code as the sibling provisioners in
  // this file and in host.ts's runInCheckout/createPinIntentProvisioner.
  const provisionFailure: (message: string) => never = (message) =>
    raiseFailure("infrastructure", "candidate-provision-failed", `yrd: ${message}`)
  await ensureWorkspaceDependencies(processService, {
    path,
    subject: `bay '${bay.id}'`,
    manifestSubject: "bay",
    runPostinstall: true,
    ...(env === undefined ? {} : { env }),
    ...(childInterruptionSignal(io) === undefined ? {} : { signal: childInterruptionSignal(io) }),
    onCommand: (argv) => io.stderr(`yrd: bay '${bay.id}' provisioning: ${argv.join(" ")}\n`),
    writeOutput: io.stderr,
    fail: provisionFailure,
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
  if (bay.path === undefined) refusal(`bay '${bay.id}' has no active worktree path`)
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
  const bay = resolveGuestBay(app, selector, invocationCwd(io))
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
          `bay '${refreshed.id}' holds uncommitted changes; checkpoint them before ensuring its draft change; inspect it with:\n` +
            `  ${guestAttachCommand(refreshed, preResolved.guestArgv)}`,
        )
      }
      if (refreshed.path === undefined) refusal(`Bay '${refreshed.id}' has no worktree path`)
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
  if (path === undefined) refusal(`Bay '${opened.bay.id}' opened without a worktree path`)
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
  if (opened.bay.path === undefined) throw new Error(`yrd: Bay '${opened.bay.id}' opened without a worktree path`)
  await services.checks?.install(opened.bay.path)
  printBayResolution(
    io,
    { ...opened.identity, effectiveBase: await app.bays.effectiveBase(opened.bay.id) },
    opened.identity.reattached ? "reattached" : "new",
    io.stderr,
  )
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
  printBayResolution(
    io,
    { ...identity, effectiveBase: await app.bays.effectiveBase(bay.id) },
    identity.reattached ? "reattached" : "new",
  )

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
    const closed = await closeBayWithProcessReap(app, services, bay, {}, io, `bay '${bay.id}' close`)
    if (closed?.status !== "closed") refusal(`bay '${bay.id}' did not close synchronously`)
    io.stdout(`closed ${identity.bay}\n`)
    return 0
  } catch (error) {
    await orphanRunBay(app, bay, `post-child checkpoint or close failed: ${errorDetail(error)}`)
    throw error
  }
}

/** Record or reuse the one draft change for an issue branch. The issue ensure
 * surface delegates to the public `pr create` core so PR identity, revision,
 * and tracking cannot drift. */
async function ensureIssueDraft(
  app: YrdCliApp,
  issue: string,
  branch: string,
  io: YrdCliIO,
  options: Readonly<{ track: boolean }>,
): Promise<Readonly<{ pr: Change; warnings: readonly string[] }>> {
  const selection = { issue, ...(options.track ? { track: true } : {}) }
  const result = await applyChangeSelection(app, [branch], selection, io, "pr.create")
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
  const bays = selectedBays(state.bays, selectors, invocationCwd(io), "refresh")
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

// Exported so the remedy's prescribed flags can be tested against the LIVE
// `bay open --help` — a printed remedy naming a flag the command lacks is a
// refusal with extra steps (@i/16-work/23055-handoff-lies flavour 2: this
// message shipped `--branch`, which `bay open` never had; the supported form
// operators found by hand was `--pr`).
export function handoffBayMissingRemedy(selector: string, branch: string): string {
  return (
    `yrd: no active bay tracks '${selector}', and 'bay handoff' certifies a bay's materialized workspace — ` +
    `its live branch and head are the evidence, which is why this command cannot open one for you. ` +
    `Open one from the packet's PR first:\n` +
    `  yrd bay open --pr ${branch}\n` +
    `then re-run this command. --pr takes the change selector or its branch name; if no PR exists for ` +
    `'${branch}' yet, run 'yrd pr create' from the pushed branch, then 'bay open --pr'.`
  )
}

async function certifyBayHandoff(
  app: YrdCliApp,
  selector: string,
  options: Readonly<{ branch: string; head: string; evidence: string; check?: boolean; json?: boolean }>,
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
    raiseFailure("refusal", "handoff-bay-missing", handoffBayMissingRemedy(selector, options.branch))
  }
  // --check: the read-only preflight of THIS command — the same bay resolution
  // and the same handoff-bay-missing refusal, with no refresh and no
  // certification write. It exists so a caller about to publish a durable
  // packet can refuse BEFORE writing instead of write-then-unwind, and so a
  // dry run can predict this refusal instead of reporting ready over it
  // (@i/16-work/23055-handoff-lies flavours 1 and 4).
  if (options.check === true) {
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "bay.handoff",
        check: {
          bay: bay.id,
          branch: bay.branch,
          headSha: bay.headSha,
          branchMatches: bay.branch === options.branch,
        },
      },
      createElement(BayStatusView, { bays: [bay] }),
    )
    return
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
  path: string | undefined,
  tolerateUnreadable?: ReadonlySet<number>,
): Promise<void> {
  // Provision can fail before a workspace exists. There is then no path-owned
  // process tree to reap; explicit force-close must still be able to drive the
  // durable Bay record to a terminal state.
  if (path === undefined) return
  if (processService === undefined) configuration("bay close requires the process-backed Yrd runtime")
  const reaped = await processService.reapPath(path)
  const failure = pathReapDeletionFailure(reaped, tolerateUnreadable)
  if (failure !== undefined) {
    throw new Error(`yrd: Bay '${bay.name}' process-tree teardown failed: ${failure}`)
  }
}

async function closeBayWithProcessReap(
  app: YrdCliApp,
  services: YrdCliServices,
  bay: Bay,
  options: Readonly<{ withdraw?: boolean; force?: boolean; tolerateUnreadable?: ReadonlySet<number> }>,
  io: YrdCliIO,
  jobContext: string,
): Promise<Bay> {
  // First empty the active Bay. Then atomically mark it closing so `bay in`
  // refuses new guests, and re-census before the deprovision job removes the
  // ownership root. This closes the attach-between-census-and-delete race.
  const path =
    services.resolveBayWorkspacePath === undefined ? bay.path : services.resolveBayWorkspacePath(bay.id, bay.path)
  await certifyBayProcessesStopped(services.process, bay, path, options.tolerateUnreadable)
  const closing = await app.bays.close({
    bay: bay.id,
    ...(options.withdraw === true ? { withdraw: true } : {}),
    ...(options.force === true ? { force: true } : {}),
  })
  await certifyBayProcessesStopped(services.process, bay, path, options.tolerateUnreadable)
  assertJobsPassed(await runJobs(app, app.jobs.requested(closing), io), jobContext)
  const closed = app.bays.get(bay.id)
  if (closed === undefined) throw new Error(`yrd: Bay '${bay.name}' disappeared while it was closing`)
  return closed
}

function parseToleratedUnreadablePids(value: string | undefined): ReadonlySet<number> | undefined {
  if (value === undefined) return undefined
  const pids = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
  if (pids.length === 0) usage("bay close --tolerate-unreadable requires at least one pid")
  const parsed = new Set<number>()
  for (const pid of pids) {
    const numeric = Number(pid)
    if (!/^\d+$/u.test(pid) || !Number.isSafeInteger(numeric) || numeric <= 1) {
      usage(`bay close --tolerate-unreadable requires positive pids, found '${pid}'`)
    }
    parsed.add(numeric)
  }
  return parsed
}

async function closeBays(
  app: YrdCliApp,
  services: YrdCliServices,
  selectors: readonly string[],
  options: {
    withdraw?: boolean
    json?: boolean
    force?: boolean
    quiet?: boolean
    requireAll?: boolean
    tolerateUnreadable?: string
  },
  io: YrdCliIO,
): Promise<readonly Bay[]> {
  const cwd = invocationCwd(io)
  // --force requires an explicit bay name/id (no empty selector = all open).
  if (options.force === true && selectors.length === 0) {
    usage("bay close --force requires an explicit bay selector (no glob/all)")
  }
  const tolerateUnreadable = parseToleratedUnreadablePids(options.tolerateUnreadable)
  if (tolerateUnreadable !== undefined && selectors.length === 0) {
    usage("bay close --tolerate-unreadable requires an explicit bay selector (no glob/all)")
  }
  const bays = selectedBays(stateOf(app).bays, selectors, cwd, "close")
  const closed: Bay[] = []
  const refused: BayStatusReport[] = []
  const remoteTrackingFresh = await refreshBayStatusOrigin(cwd)
  const protections = activeBayProtections(io)
  for (const bay of bays) {
    const report = classifyBayStatus(
      await gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now()),
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
          ? app.bays.prs().filter((pr) => (pr.bay === bay.id || pr.branch === bay.branch) && isLiveChange(pr))
          : []
      const current = await closeBayWithProcessReap(
        app,
        services,
        bay,
        { withdraw: options.withdraw, force: options.force, tolerateUnreadable },
        io,
        `bay '${bay.id}' close`,
      )
      if (tolerateUnreadable !== undefined) {
        // The waiver is part of the operation's record: say exactly which pids
        // the operator vouched for while this bay's teardown was certified.
        await printHuman(
          io,
          `bay close ${bay.id} ${bay.name}: census gaps tolerated for unreadable pid(s) ${[...tolerateUnreadable].sort((a, b) => a - b).join(", ")} (operator flag)`,
        )
      }
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
    if (options.quiet !== true) await printHuman(io, `bay close stopped: ${outcome}\n\n${body}`)
    if (closed.length === 0 || options.requireAll === true) {
      raiseFailure(
        "refusal",
        "request-refused",
        `${outcome}; could not close ${String(refused.length)} bay(s); run 'yrd bay status', or 'yrd bay close --force <name>'`,
      )
    }
  }
  if (closed.length === 0 && refused.length === 0) {
    usage("bay close requires at least one bay selector")
  }
  const [only] = closed
  if (
    options.quiet !== true &&
    !jsonEnabled(options) &&
    only !== undefined &&
    closed.length === 1 &&
    refused.length === 0
  ) {
    io.stdout(`closed ${only.name}\n`)
    return closed
  }
  if (options.quiet !== true && closed.length > 0) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "bay.close", bays: closed, refused: refused.map((report) => report.bay) },
      createElement(BayStatusView, { bays: closed }),
    )
  }
  return closed
}

/**
 * Refresh once per status/close/prune command so a deleted remote branch cannot
 * survive as a stale local tracking ref and authorize destructive cleanup.
 * This is the same fetch-before-git-cherry boundary used by branch-triage.
 */
async function refreshBayStatusOrigin(repoRoot: string): Promise<boolean> {
  try {
    await gitAsync(repoRoot, ["fetch", "--no-recurse-submodules", "--prune", "--quiet", "origin"])
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

function requiredPersistedBayHead(head: string | undefined): string {
  if (head === undefined) throw new Error("persisted Bay head is unavailable")
  return head
}

/**
 * Ancestor-or-patch-id-equivalent tip durability against a resolved
 * `origin/main`. Shared by the root worktree and every submodule
 * (bay-status.ts `commitDurabilityVerdict` ranks whatever this returns): a bay
 * whose root tip sat safely on origin but whose submodule held an unpublished
 * commit used to classify SAFE, because only the root was ever asked this
 * question (B399, 2026-08-30). Extracted verbatim from the single root
 * computation this used to be — same three-way fallback (ancestor, then
 * patch-id via `cherry`, then any advertised ref that contains the tip), same
 * failure shape (an unreadable `origin/main` or a failed rev-list/cherry both
 * read UNKNOWN, never PASS).
 *
 * `originMain` is read from `originRoot`, which the root's own caller keeps
 * distinct from `gitRoot`: a Bay's `path` is normally a linked worktree of
 * `repoRoot` sharing its remote-tracking refs, but preferring the
 * superproject's own view is what the freshly-refreshed-and-pruned
 * `remoteTrackingFresh` flag actually describes (`refreshBayStatusOrigin`
 * fetches `repoRoot`, not `path`). A submodule has no such split — its own
 * directory is both.
 */
function measureCommitDurability(
  gitRoot: string,
  originRoot: string,
  head: string,
  remoteTrackingFresh: boolean,
): Pick<BayStatusFacts, "tipMerged" | "tipDurableAt" | "tipMergedUnknown" | "aheadOfOrigin" | "uniquePatches"> {
  let tipMerged: boolean | undefined
  let tipDurableAt: string | undefined
  let tipMergedUnknown: boolean | undefined
  let aheadOfOrigin: number | undefined
  let uniquePatches: number | undefined
  try {
    const originMain = gitSync(originRoot, ["rev-parse", "origin/main"]).trim()
    try {
      gitSync(gitRoot, ["merge-base", "--is-ancestor", head, originMain])
      tipMerged = true
      tipDurableAt = "origin/main"
      aheadOfOrigin = 0
      uniquePatches = 0
    } catch {
      tipMerged = false
      try {
        const counts = gitSync(gitRoot, ["rev-list", "--left-right", "--count", `${originMain}...${head}`])
          .trim()
          .split(/\s+/u)
          .map(Number)
        const ahead = counts[1]
        if (Number.isSafeInteger(ahead)) aheadOfOrigin = ahead
      } catch {
        tipMergedUnknown = true
      }
      try {
        uniquePatches = gitSync(gitRoot, ["cherry", originMain, head])
          .split("\n")
          .filter((line) => line.startsWith("+ ")).length
        if (uniquePatches === 0) {
          tipMerged = true
          tipDurableAt = "origin/main (same changes)"
          tipMergedUnknown = undefined
        } else if (remoteTrackingFresh) {
          const remoteRef = gitSync(gitRoot, [
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
            tipMergedUnknown = undefined
          }
        } else {
          tipMergedUnknown = true
        }
      } catch {
        tipMergedUnknown = true
      }
    }
  } catch {
    tipMergedUnknown = true
  }
  return { tipMerged, tipDurableAt, tipMergedUnknown, aheadOfOrigin, uniquePatches }
}

/** One row of `git submodule status --recursive`: a leading ` `/`+`/`-`/`U`
 * marker, the checked-out sha, and the displaypath — nested-safe (e.g.
 * `km/apps/maddoc` reports as one row, not one row per level). Only `-`
 * (not initialized) means there is no working tree at `path` to inspect. */
const SUBMODULE_STATUS_LINE = /^([ +\-U])([0-9a-f]{40,64}) (\S+)(?: .*)?$/u

async function listBaySubmodules(
  path: string,
): Promise<readonly Readonly<{ path: string; sha: string; initialized: boolean }>[]> {
  const output = await gitAsync(path, ["submodule", "status", "--recursive"])
  return output
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => {
      const match = SUBMODULE_STATUS_LINE.exec(line)
      if (match?.[2] === undefined || match[3] === undefined) {
        throw new Error(`yrd: could not parse 'git submodule status --recursive' row '${line}'`)
      }
      return { path: match[3], sha: match[2], initialized: match[1] !== "-" }
    })
}

/** Refresh one submodule's OWN origin — never the superproject's — so its
 * commit-durability check runs against a fresh, pruned view of that
 * component's remote, exactly like the root worktree's own refresh. */
async function refreshSubmoduleOrigin(submodulePath: string): Promise<boolean> {
  try {
    await gitAsync(submodulePath, ["fetch", "--prune", "--quiet", "origin"])
    return true
  } catch {
    return false
  }
}

/**
 * Every submodule under `path`'s worktree, at every depth — mirrors what bay
 * provisioning actually materializes (`materializeSubmodules`, git-super's
 * worktree store), so this walk sees exactly the tree `bay open`/`bay run`
 * already checked out. An uninitialized submodule (`-` status) holds no local
 * commits this Bay could lose, so it is skipped rather than measured — that is
 * the SAME "nothing local to lose" PASS the root worktree already gets when
 * its own path is missing, not a gap in coverage. Each initialized submodule
 * is fetched and classified through the SAME ladder as the root worktree
 * (`measureCommitDurability` above; B399, 2026-08-30).
 */
async function gatherBaySubmoduleFacts(path: string): Promise<readonly BayStatusSubmoduleFacts[]> {
  const submodules = await listBaySubmodules(path)
  return Promise.all(
    submodules
      .filter((submodule) => submodule.initialized)
      .map(async (submodule): Promise<BayStatusSubmoduleFacts> => {
        const submodulePath = `${path}/${submodule.path}`
        const remoteTrackingFresh = await refreshSubmoduleOrigin(submodulePath)
        const durability = measureCommitDurability(submodulePath, submodulePath, submodule.sha, remoteTrackingFresh)
        return { path: submodule.path, sha: submodule.sha, remoteTrackingFresh, ...durability }
      }),
  )
}

/** Gather live facts for one bay; classification stays pure in bay-status.ts (22290). */
async function gatherBayStatusFacts(
  app: YrdCliApp,
  bay: Bay,
  repoRoot: string,
  remoteTrackingFresh: boolean,
  protections: readonly YrdBayProtection[],
  now: number,
): Promise<BayStatusFacts> {
  const ownerPid = parseOwnerPid(bay.name, bay.by)
  const ownerIsCaller = ownerPid === process.pid
  // The owner necessarily preceded the Bay it opened, so the Bay's own open time
  // is the identity this record already had: a process at that pid which started
  // later is a REUSE of the number, not the owner. B58 sat refused for days on a
  // bare `kill -0` that could not tell those apart.
  const bayOpenedAtMs = Date.parse(bay.openedAt)
  let ownerAlive: boolean | undefined
  let ownerEvidence: string | undefined
  if (ownerPid !== undefined) {
    const report = await recordedPidLiveness({
      pid: ownerPid,
      ...(Number.isFinite(bayOpenedAtMs) ? { runningSinceMs: bayOpenedAtMs } : {}),
    })
    ownerEvidence = report.evidence
    ownerAlive = report.liveness === "unknown" ? undefined : report.liveness === "live"
  }

  const path = bay.path
  let worktreeDirty: boolean | undefined
  let worktreeMissing: boolean | undefined
  let tipMerged: boolean | undefined
  let tipDurableAt: string | undefined
  let tipProofSource: BayStatusFacts["tipProofSource"]
  let tipMergedUnknown: boolean | undefined
  let aheadOfOrigin: number | undefined
  let uniquePatches: number | undefined
  const branchMissingFromOrigin = originBranchMissing(repoRoot, bay.branch, remoteTrackingFresh)
  let stashAttributed = 0
  let stashUnknown: boolean | undefined
  let submodules: readonly BayStatusSubmoduleFacts[] | undefined
  let submodulesUnknown: boolean | undefined

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

    const persistedHead = bay.headSha
    if (worktreeMissing !== true || persistedHead !== undefined) {
      const gitRoot = worktreeMissing === true ? repoRoot : path
      let head: string | undefined
      try {
        head =
          worktreeMissing === true
            ? requiredPersistedBayHead(persistedHead)
            : gitSync(path, ["rev-parse", "HEAD"]).trim()
        tipProofSource = worktreeMissing === true ? "persisted Bay head" : "live worktree HEAD"
      } catch {
        tipMergedUnknown = true
      }
      if (head !== undefined) {
        // Prefer superproject origin/main when bay is a linked worktree of the repo.
        const durability = measureCommitDurability(gitRoot, repoRoot, head, remoteTrackingFresh)
        tipMerged = durability.tipMerged
        tipDurableAt = durability.tipDurableAt
        tipMergedUnknown = durability.tipMergedUnknown
        aheadOfOrigin = durability.aheadOfOrigin
        uniquePatches = durability.uniquePatches
      }
    }

    if (worktreeMissing !== true) {
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

      try {
        submodules = await gatherBaySubmoduleFacts(path)
      } catch {
        submodulesUnknown = true
      }
    }
  }

  const openChangeIds = app.bays
    .prs()
    .filter((pr) => (pr.bay === bay.id || pr.branch === bay.branch) && isLiveChange(pr))
    .map((pr) => pr.id)
  // The derived lane writes refs/yrd/submit/<branch> directly and never mints a
  // Change record for it (model.ts recordLaneOwnsBranch), so a live derived-lane
  // submission is invisible to openChangeIds above. BaysState.submits is the only
  // inbound signal it leaves; a standing entry for this Bay's branch means a live
  // submission still depends on this workspace (@yrd/22290-bay-reaper derived-lane gap).
  const derivedLaneSubmitLive = stateOf(app).bays.submits[bay.branch] !== undefined
  const openedAt = Date.parse(bay.openedAt)
  const ageMs = Number.isFinite(openedAt) ? Math.max(0, now - openedAt) : undefined

  return {
    bayId: bay.id,
    name: bay.name,
    branch: bay.branch,
    // Read the PERSISTED closure, not a status literal. The bay domain never assigns
    // status "failed" — provision failure writes status "closed" with closure.kind
    // "closed-degenerate" (yrd-bay/src/plugin.ts, projectBayJob). Keying this on
    // "failed" meant the fact was never emitted and classifyBayStatus's all-PASS
    // closed-degenerate path was unreachable from the CLI. @yrd/22609-bayprune.
    ...(bay.closure?.kind === "closed-degenerate" && path === undefined ? { closedDegenerate: true } : {}),
    ...(path === undefined ? {} : { path }),
    protectedBy: protectionEvidenceForBay(protections, { id: bay.id, ...(path === undefined ? {} : { path }) }),
    protectionGaps: protectionGapEvidenceForBay(protections, {
      id: bay.id,
      ...(path === undefined ? {} : { path }),
    }),
    consumerNotConsumed: protectionNotConsumedEvidenceForBay(protections, {
      id: bay.id,
      ...(path === undefined ? {} : { path }),
    }),
    ...(ownerPid === undefined ? {} : { ownerPid }),
    ...(ownerPid === undefined ? {} : { ownerIsCaller }),
    ...(ownerAlive === undefined ? {} : { ownerAlive }),
    ...(ownerEvidence === undefined ? {} : { ownerEvidence }),
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(worktreeDirty === undefined ? {} : { worktreeDirty }),
    ...(worktreeMissing === undefined ? {} : { worktreeMissing }),
    ...(tipMerged === undefined ? {} : { tipMerged }),
    ...(tipDurableAt === undefined ? {} : { tipDurableAt }),
    ...(tipProofSource === undefined ? {} : { tipProofSource }),
    ...(tipMergedUnknown === undefined ? {} : { tipMergedUnknown }),
    ...(aheadOfOrigin === undefined ? {} : { aheadOfOrigin }),
    ...(uniquePatches === undefined ? {} : { uniquePatches }),
    remoteTrackingFresh,
    ...(branchMissingFromOrigin === undefined ? {} : { branchMissingFromOrigin }),
    stashAttributed,
    ...(stashUnknown === undefined ? {} : { stashUnknown }),
    ...(submodules === undefined ? {} : { submodules }),
    ...(submodulesUnknown === undefined ? {} : { submodulesUnknown }),
    openChangeIds,
    derivedLaneSubmitLive,
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
  const cwd = invocationCwd(io)
  const bays =
    selectors.length === 0
      ? app.bays.list().filter((bay) => bay.status !== "closed")
      : selectedBays(stateOf(app).bays, selectors, cwd, "status")
  if (bays.length === 0) usage("bay status requires at least one open bay (or a selector)")

  const remoteTrackingFresh = await refreshBayStatusOrigin(cwd)
  const protections = activeBayProtections(io)
  const reports: BayStatusReport[] = await Promise.all(
    bays.map(async (bay) => {
      const facts = await gatherBayStatusFacts(
        app,
        bay,
        cwd,
        remoteTrackingFresh,
        protections,
        io.now?.() ?? Date.now(),
      )
      const effectiveBase = await app.bays.effectiveBase(bay.id)
      return classifyBayStatus({ ...facts, effectiveBase })
    }),
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

const BayPruneApprovalSchema = z
  .object({
    version: z.literal(1),
    prunable: z.array(z.string()),
    excluded: z.array(z.string()),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict()

type BayPruneApproval = z.infer<typeof BayPruneApprovalSchema>

function sortedUniqueBayIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].toSorted(compareNatural)
}

/**
 * Canonical UTF-8 fingerprint preimage, including the final newline:
 * version=<decimal>\nprunable=<JSON sorted array>\nexcluded=<JSON sorted array>\n
 */
function bayPruneApprovalPreimage(approval: Pick<BayPruneApproval, "version" | "prunable" | "excluded">): string {
  return (
    `version=${String(approval.version)}\n` +
    `prunable=${JSON.stringify(approval.prunable)}\n` +
    `excluded=${JSON.stringify(approval.excluded)}\n`
  )
}

function createBayPruneApproval(prunable: readonly string[], excluded: readonly string[]): BayPruneApproval {
  const content = {
    version: 1 as const,
    prunable: sortedUniqueBayIds(prunable),
    excluded: sortedUniqueBayIds(excluded),
  }
  return {
    ...content,
    fingerprint: `sha256:${createHash("sha256").update(bayPruneApprovalPreimage(content)).digest("hex")}`,
  }
}

async function readBayPruneApproval(path: string): Promise<BayPruneApproval> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    raiseFailure(
      "configuration",
      "bay-prune-approval-unreadable",
      `cannot read bay prune approval '${path}': ${errorDetail(error)}`,
    )
  }
  const result = BayPruneApprovalSchema.safeParse(parsed)
  if (!result.success) {
    raiseFailure(
      "configuration",
      "bay-prune-approval-invalid",
      `bay prune approval '${path}' is invalid: ${z.prettifyError(result.error)}`,
    )
  }
  const approval = result.data
  const canonicalPrunable = sortedUniqueBayIds(approval.prunable)
  const canonicalExcluded = sortedUniqueBayIds(approval.excluded)
  if (
    JSON.stringify(approval.prunable) !== JSON.stringify(canonicalPrunable) ||
    JSON.stringify(approval.excluded) !== JSON.stringify(canonicalExcluded)
  ) {
    raiseFailure(
      "configuration",
      "bay-prune-approval-noncanonical",
      `bay prune approval '${path}' must contain sorted, duplicate-free prunable and excluded arrays`,
    )
  }
  const overlap = approval.prunable.filter((bay) => new Set(approval.excluded).has(bay))
  if (overlap.length > 0) {
    raiseFailure(
      "configuration",
      "bay-prune-approval-overlap",
      `bay prune approval '${path}' lists bays as both prunable and excluded: ${overlap.join(", ")}`,
    )
  }
  const expected = createBayPruneApproval(approval.prunable, approval.excluded).fingerprint
  if (approval.fingerprint !== expected) {
    raiseFailure(
      "refusal",
      "bay-prune-approval-fingerprint-mismatch",
      `bay prune approval '${path}' fingerprint mismatch: expected ${expected}, found ${approval.fingerprint}`,
    )
  }
  return approval
}

type BayPruneCommandOptions = {
  json?: boolean
  apply?: boolean
  approval?: string
  saveApproval?: string
  exclude?: readonly string[]
}

function validateBayPruneOptions(options: BayPruneCommandOptions): void {
  const applying = options.apply === true
  if (applying && options.approval === undefined) usage("--apply requires --approval <path>")
  if (!applying && options.approval !== undefined) usage("--approval requires --apply")
  if (applying && options.saveApproval !== undefined) usage("--save-approval cannot be combined with --apply")
  if (applying && (options.exclude?.length ?? 0) > 0) usage("--exclude cannot be combined with --apply")
}

/** Sweep open bays via the status oracle. Dry-run is the default (22290). */
async function bayPruneCommand(
  app: YrdCliApp,
  services: YrdCliServices,
  options: BayPruneCommandOptions,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const cwd = io.cwd ?? process.cwd()
  const dryRun = options.apply !== true
  validateBayPruneOptions(options)

  const open = app.bays.list().filter((bay) => bay.status !== "closed")
  const remoteTrackingFresh = await refreshBayStatusOrigin(cwd)
  const protections = activeBayProtections(io)
  const reports = await Promise.all(
    open.map(async (bay) =>
      classifyBayStatus(
        await gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now()),
      ),
    ),
  )
  const approvalPath = options.approval === undefined ? undefined : resolve(cwd, options.approval)
  const approval = approvalPath === undefined ? undefined : await readBayPruneApproval(approvalPath)
  const excluded =
    approval === undefined
      ? sortedUniqueBayIds(
          (options.exclude ?? []).flatMap((selector) =>
            selectedBays(stateOf(app).bays, [selector], cwd, "exclude from prune").map((bay) => {
              if (bay.status === "closed") refusal(`cannot exclude closed Bay '${selector}' from prune`)
              return bay.id
            }),
          ),
        )
      : approval.excluded
  const excludedSet = new Set(excluded)
  const censusOutcomes = bayPruneOutcomes(reports, new Set())
  const currentPrunable = censusOutcomes.rows.pruned.filter((bay) => !excludedSet.has(bay))
  if (approval !== undefined) {
    const approvedSet = new Set(approval.prunable)
    const currentSet = new Set(currentPrunable)
    const becamePrunable = currentPrunable.filter((bay) => !approvedSet.has(bay))
    const becameProtected = approval.prunable.filter((bay) => !currentSet.has(bay))
    if (becamePrunable.length > 0 || becameProtected.length > 0) {
      raiseFailure(
        "refusal",
        "bay-prune-approval-drift",
        `bay prune approval '${approvalPath}' no longer matches the current census; becamePrunable: ${becamePrunable.join(", ") || "none"}; becameProtected: ${becameProtected.join(", ") || "none"}; rerun the dry-run and approve its replacement artifact with 'yrd admin bay prune --save-approval <path>'`,
      )
    }
  }

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
  const prunable = outcomes.rows.pruned.filter((bay) => !excludedSet.has(bay))
  const approvalArtifact = createBayPruneApproval(prunable, excluded)
  const savedApprovalPath = options.saveApproval === undefined ? undefined : resolve(cwd, options.saveApproval)
  if (savedApprovalPath !== undefined) {
    try {
      await writeFile(savedApprovalPath, `${JSON.stringify(approvalArtifact, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      })
    } catch (error) {
      raiseFailure(
        "infrastructure",
        "bay-prune-approval-write-failed",
        `cannot write bay prune approval '${savedApprovalPath}': ${errorDetail(error)}`,
      )
    }
  }
  const applyLedger: {
    closed: string[]
    failed: Array<{ bay: string; error: string }>
    notAttempted: string[]
  } = { closed: [], failed: [], notAttempted: [] }
  if (!dryRun) {
    for (const [index, bay] of prunable.entries()) {
      try {
        const closed = await closeBays(app, services, [bay], { quiet: true, requireAll: true }, io)
        if (closed.length !== 1) throw new Error(`yrd: prune did not close Bay '${bay}'`)
        applyLedger.closed.push(bay)
      } catch (error) {
        applyLedger.failed.push({ bay, error: errorDetail(error) })
        applyLedger.notAttempted.push(...prunable.slice(index + 1))
        break
      }
    }
  }
  const reportedOutcomes = { prunable, kept: outcomes.rows.kept, paged: outcomes.rows.paged }
  const reportedHistogram = {
    prunable: prunable.length,
    keptByReason: outcomes.histogram.keptByReason,
    pagedByReason: outcomes.histogram.pagedByReason,
  }

  if (jsonEnabled(options)) {
    await printResult(
      io,
      true,
      {
        command: "bay.prune",
        dryRun,
        repository: cwd,
        examined: reports.length,
        preserved,
        excluded,
        outcomes: reportedOutcomes,
        histogram: reportedHistogram,
        ...(savedApprovalPath === undefined
          ? {}
          : { approval: { path: savedApprovalPath, fingerprint: approvalArtifact.fingerprint } }),
        ...applyLedger,
      },
      null,
    )
  } else {
    const lines = [
      `bay prune ${dryRun ? "(dry-run DEFAULT — pass --save-approval <path> to approve this census)" : "(APPLY — exact approved set)"}`,
      `repository ${cwd}`,
      `examined ${String(reports.length)} open bay(s); prunable=${String(prunable.length)}; excluded=${String(excluded.length)}; keep=${String(outcomes.rows.kept.length)}; page=${String(outcomes.rows.paged.length)}`,
      ...(savedApprovalPath === undefined ? [] : [`approval ${savedApprovalPath} ${approvalArtifact.fingerprint}`]),
      ...(dryRun || applyLedger.failed.length === 0
        ? []
        : [
            `failed ${applyLedger.failed.map((entry) => `${entry.bay}: ${entry.error}`).join(", ")}`,
            `not attempted ${applyLedger.notAttempted.join(", ") || "none"}`,
          ]),
      "",
      ...reports.map((report) => {
        const disposition = excludedSet.has(report.bay)
          ? "EXCLUDED"
          : preservedSet.has(report.bay)
            ? "PAGE"
            : report.exit === 0
              ? dryRun
                ? "PRUNABLE"
                : applyLedger.closed.includes(report.bay)
                  ? "CLOSED"
                  : applyLedger.failed.some((entry) => entry.bay === report.bay)
                    ? "FAILED"
                    : "NOT-ATTEMPTED"
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

  if (applyLedger.failed.length > 0) {
    io.stderr(`${applyLedger.failed.map((entry) => `${entry.bay}: ${entry.error}`).join("\n")}\n`)
    return 3
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

/**
 * Exported for characterization. Historically this gate refused EVERY authored gitlink change
 * unconditionally (the pre-shaset behaviour); step (a) tightened the publication oracle
 * without flipping the backstop, deliberately: "its deletion ships with the provisioner lift
 * or not at all" (shaset-model.md). The provisioner lift shipped in step (b), so step (d) is
 * that flip: a published, on-main, single-update authored gitlink is now admitted, and the
 * queue's own composition-time fill (`fillAuthoredGitlinksFromMain`, unchanged) fills in its
 * shaset value from the submodule's main. An ADDED gitlink still refuses unconditionally —
 * that machinery is update-only — as does a DELETED, off-main, or unpublished one.
 * See tests/authored-gitlink-admission.test.ts and @i/10-merge-queue/shaset-model.
 */
export async function requireQueueableSubmodulePins(pr: Change, services: YrdCliServices, io: YrdCliIO): Promise<void> {
  if (services.process === undefined) return
  const repo = io.cwd ?? process.cwd()
  const headSha = changeHead(pr)
  // Not changeBaseSha(pr). That field is set at create, re-set at re-merge, and chased
  // forward to track current main while the author's head stays exactly where
  // they left it, so a two-dot diff from it reports every pin that moved on
  // main as this change's authorship and refuses a branch for a gitlink it never
  // touched. The queue's own composition gate has always measured from a live
  // merge base; this pre-admission gate now asks the question the same way.
  const baseSha = await authoredSubmodulePinBase({ process: services.process, repo, base: pr.base, headSha })
  if (baseSha === undefined) {
    raiseFailure(
      "refusal",
      "pr-base-unresolved",
      `yrd: change '${pr.id}' base '${pr.base}' resolves to no ref in '${repo}'; ` +
        "fetch the base branch, then retry",
    )
  }
  const changed = await changedSubmodulePins({
    process: services.process,
    repo,
    baseSha,
    headSha,
  })
  if (changed.length === 0) return

  // Two kinds of changed gitlink, two questions — and the KIND must be decided first.
  //
  // Queue-carried pins (a composition or a re-merge) are not author min commits: the queue's own
  // publication job pushes the commit to a branch ref, and submodule main is PROMOTED at
  // merge. Asking main-ancestry at admission would deadlock that pipeline by construction —
  // the pin cannot be on main until the very merge being admitted — so the whole question
  // there is reachability: can the queue fetch this commit from the submodule's origin?
  //
  // Authored pins are the shaset model's min commits, and the min commit is submodule-main-first:
  // the submodule's own workflow must have merged the commit on that submodule's MAIN.
  // Reachability was the old oracle for these too, which is exactly the gap it left — a pin
  // on someone's unmerged side branch counted as published, and only the authored-gitlink
  // backstop caught it.
  const queueCarried = changeComposition(pr) !== undefined || currentChangeRev(pr).recut !== undefined
  if (queueCarried) {
    const unreachable = await unreachableSubmodulePins({ process: services.process, pins: changed })
    if (unreachable.length > 0) {
      const detail = unreachable
        .map(
          ({ path, pin, repository }) =>
            `submodule '${path}' pin '${pin}' is on zero refs fetched from origin; whoever holds this commit in ` +
            `'${repository}' must publish it through that submodule's own git workflow, then get it onto that ` +
            `submodule's main and submit an ordinary change whose diff is the gitlink bump`,
        )
        .join("\n")
      raiseFailure(
        "refusal",
        "submodule-pin-unpublished",
        `yrd: change '${pr.id}' changes unpublished submodule pins:\n${detail}`,
      )
    }
    return
  }

  // A min commit is a floor on an EXISTING submodule: the shaset-commit writer is
  // update-only, so an added (or, structurally invisible to changedSubmodulePins today,
  // deleted) gitlink can never be filled in the way an updated one can — always refuse.
  const added = await addedSubmodulePins({ process: services.process, repo, baseSha, pins: changed })
  if (added.length > 0) {
    const declared = parseSubmoduleModelChangeAuthorizationValue(pr.id, changeProps(pr)?.["component-model-change"])
    const exact = added.length === 1 && declared?.operation === "add" && declared.path === added[0]?.path
    if (!exact || services.submoduleModelChangeAuthorizer === undefined) {
      raiseFailure(
        "refusal",
        services.submoduleModelChangeAuthorizer === undefined && exact
          ? "component-model-authorizer-unavailable"
          : "authored-gitlink",
        `yrd: change '${pr.id}' adds generated-only gitlinks [${added.map(({ path }) => path).join(", ")}]; ` +
          "ask @cto for an exact component-model ruling and carry " +
          "--prop 'component-model-change=add <path>; ruling <verdict-message-id>' on this revision through the hh Yrd host",
      )
    }
    try {
      await services.submoduleModelChangeAuthorizer({
        ...declared,
        pr: pr.id,
        revision: changeRevisionNumber(pr),
        headSha,
      })
    } catch (cause) {
      raiseFailure(
        "refusal",
        "component-model-authorization-refused",
        `yrd: change '${pr.id}' component-model ruling '${declared.ruling}' did not authorize ` +
          `'add ${declared.path}': ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  const publications = await submodulePinPublications({ process: services.process, pins: changed })
  // Inspection failures first: the partition below cannot be trusted while any read failed,
  // and "could not tell" must never surface as "not published" — they have opposite remedies.
  // The merge path aborts its whole promotion group on the same condition, under the same code.
  const undetermined = publications.filter((entry) => entry.state === "undetermined")
  if (undetermined.length > 0) {
    const detail = undetermined
      .map(({ pin, reason }) => `submodule '${pin.path}' pin '${pin.pin}': ${reason}`)
      .join("\n")
    raiseFailure(
      "refusal",
      "component-main-inspection-failed",
      `yrd: change '${pr.id}' changes submodule pins whose submodule main could not be inspected:\n${detail}`,
    )
  }
  const offMain = publications.filter((entry) => entry.state === "off-submodule-main")
  if (offMain.length > 0) {
    const detail = offMain
      .map(
        ({ pin: { path, pin, repository }, mainSha }) =>
          `submodule '${path}' pin '${pin}' is not on that submodule's main ('${mainSha}'); whoever holds this ` +
          `commit in '${repository}' must publish it through that submodule's own git workflow, then get it ` +
          "onto that submodule's main and submit an ordinary change whose diff is the gitlink bump",
      )
      .join("\n")
    raiseFailure(
      "refusal",
      "submodule-pin-unpublished",
      `yrd: change '${pr.id}' changes submodule pins that are not on their submodule's main:\n${detail}`,
    )
  }
  // Every remaining pin is a straightforward update, published and on its submodule's main.
  // Legitimacy is settled; MONOTONICITY is a separate question and nothing above asks it.
  // PR2118 (2026-08-27) is the specimen: every sha it wrote was published and on its
  // submodule's main, so it reached exactly this line clean, while merging it would have
  // reverted eight commits across three submodules for zero unique content.
  await requireForwardOnlyGitlinks(pr, changed, services, io)
  // Both questions answered. The queue's own composition-time fill writes the shaset value
  // at merge; this gate's job was to stop refusing what that machinery can safely process,
  // and to stop admitting what it must never carry.
}

/**
 * Monotonicity, asked against main's CURRENT gitlink — the second of the two independent
 * questions an authored gitlink must answer (ADR `2026-08-27-pin-legitimacy-is-not-monotonicity`).
 *
 * `changed` is the change's OWN diff, so a branch that writes no gitlink never reaches here
 * however far its base has fallen behind — the exemption the ruling required, and the reason
 * this is not a tree comparison against main.
 *
 * The comparison re-reads main's tip every time it runs, and it runs on every path that
 * admits a revision, including the re-merge and preflight passes the queue's own cycle drives
 * (`executeRemergeChange`, `applyPreflightVerdict`). A green answer is therefore never a
 * stored fact that can be cited later: main moves, the question is asked again against where
 * main now is.
 */
async function requireForwardOnlyGitlinks(
  pr: Change,
  changed: readonly { path: string; pin: string; repository: string }[],
  services: YrdCliServices,
  io: YrdCliIO,
): Promise<void> {
  if (services.process === undefined || changed.length === 0) return
  const repo = io.cwd ?? process.cwd()
  const baseTipSha = await resolveBaseTip({ process: services.process, repo, base: pr.base })
  if (baseTipSha === undefined) {
    raiseFailure(
      "refusal",
      "pr-base-unresolved",
      `yrd: change '${pr.id}' base '${pr.base}' resolves to no ref in '${repo}', so its gitlinks cannot be ` +
        "compared with main's current values; fetch the base branch, then retry",
    )
  }
  const directions = await gitlinkDirections({
    process: services.process,
    repo,
    baseTipSha,
    gitlinks: changed.map(({ path, pin, repository }) => ({ path, gitlink: pin, repository })),
  })
  const undetermined = directions.filter((entry) => entry.state === "undetermined")
  if (undetermined.length > 0) {
    raiseFailure(
      "refusal",
      "gitlink-comparison-undetermined",
      `yrd: change '${pr.id}' writes gitlinks that could not be compared with main's current values:\n` +
        undetermined.map(({ path, reason }) => `submodule '${path}': ${reason}`).join("\n"),
    )
  }
  const backward = directions.filter((entry) => entry.state === "backward")
  if (backward.length > 0) {
    raiseFailure(
      "refusal",
      "gitlink-moves-backward",
      `yrd: change '${pr.id}' moves submodule gitlinks backwards:\n${backwardGitlinkRefusal(backward)}`,
    )
  }
}

async function requireQueueableSubmodulePinsForCommand(
  pr: Change,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode | undefined> {
  try {
    await requireQueueableSubmodulePins(pr, services, io)
    return undefined
  } catch (error) {
    if (failureFact(error) === undefined) throw error
    await diagnostic(io, error, { json: jsonEnabled(options) })
    return classifyFailure(error).exitCode
  }
}

type PublicationProjection = Readonly<{
  job: string
  status: "publication-required" | "publishing" | "published" | "publication-failed"
  continuation: ChangePublicationInput["continuation"]
  detail: string
  error?: JobErrorFact
}>

function publicationJob(app: YrdCliApp, pr: Change): Job | undefined {
  const revision = currentChangeRev(pr)
  const current = app.jobs.getByKey(
    changePublicationJobKey({ pr: pr.id, revision: revision.n, headSha: revision.head }),
  )
  if (current !== undefined) return current
  return Object.values(stateOf(app).jobs.byId)
    .filter((job) => job.definition === "pr.publish" && ChangePublicationInputSchema.parse(job.input).pr === pr.id)
    .toSorted((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0]
}

function projectPublication(job: Job | undefined): PublicationProjection | undefined {
  if (job?.definition !== "pr.publish") return undefined
  const input = ChangePublicationInputSchema.parse(job.input)
  if (job.status === "queued") {
    return {
      job: job.id,
      status: "publication-required",
      continuation: input.continuation,
      detail: "waiting for the one-shot or habitant queue runner",
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
  const revision = currentChangeRev(pr)
  const baseSha = changeBaseSha(pr)
  if (baseSha === undefined) {
    raiseFailure("refusal", "pr-base-missing", `yrd: change '${pr.id}' has no immutable base SHA`)
  }
  const sourceRoot = resolve(io.cwd ?? globalThis.process.cwd())
  const submodules = await changedSubmodulePins({
    process,
    repo: sourceRoot,
    baseSha,
    headSha: revision.head,
  })
  const input: ChangePublicationInput = {
    pr: pr.id,
    revision: revision.n,
    headSha: revision.head,
    baseSha,
    branch: pr.branch,
    sourceRoot,
    components: submodules.map(({ path, pin }) => ({ path, pin })),
    continuation: options.queue === true ? "queue" : "none",
  }
  const key = changePublicationJobKey(input)
  let job = app.jobs.getByKey(key)
  if (job === undefined) {
    const requested = await app.bays.requestPublication(input)
    const id = app.jobs.requested(requested)[0] ?? app.jobs.getByKey(key)?.id
    job = id === undefined ? undefined : app.jobs.get(id)
  } else {
    if (JSON.stringify(ChangePublicationInputSchema.parse(job.input)) !== JSON.stringify(input)) {
      raiseFailure(
        "refusal",
        "publication-request-conflict",
        `yrd: change '${pr.id}' revision ${revision.n} already has publication Job '${job.id}' with different request details`,
      )
    }
    if (job.status === "completed" && (job.conclusion === "failure" || job.conclusion === "timed_out")) {
      job = await app.jobs.retry(job.id)
    }
  }
  const publication = projectPublication(job)
  if (publication === undefined) throw new Error(`yrd: change '${pr.id}' publication request produced no Job`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.publish", pr: projectChangeTaskStatus(pr), publication },
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
  await runPreSubmitGuards(services, io, undefined, undefined, jsonEnabled(options))
  // Same gate, same erasure as `pr submit` had: the verdicts were awaited and
  // dropped, so a `pr ready` that ran four checks left no evidence any ran.
  const requiredChecks = await runRequiredChecks(services, io, undefined, undefined, false, jsonEnabled(options))
  await app.bays.ready({ pr: selector })
  let pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: change '${selector}' disappeared after ready`)
  if (!app.bays.checksRequested(pr.id)) await app.bays.requestChecks({ pr: pr.id })
  pr = app.bays.pr(pr.id)
  if (pr === undefined) throw new Error(`yrd: change '${selector}' disappeared after requesting checks`)
  const eligibility = app.queue.eligibility(pr.id)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.ready",
      pr: projectChangeTaskStatusWithEligibility(pr, eligibility),
      eligibility: projectEligibilityTaskStatus(eligibility),
      ...(requiredChecks.length === 0 ? {} : { requiredChecks }),
    },
    createElement(ChangeResultView, {
      prs: [pr],
      runs: [],
      eligibilities: [eligibility],
      ...(io.columns === undefined ? {} : { columns: io.columns }),
    }),
  )
  return changeDeliveryState(pr) === "needs-author" ? 1 : 0
}

type ExecuteRemergeChangeOptions = Readonly<{
  revision?: number
  proposedHeadSha?: string
  queue?: boolean
  force?: boolean
  admit?: boolean
  transition?: ChangeFreshnessTransition
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

async function executeRemergeChange(
  app: YrdCliApp,
  services: Pick<YrdCliServices, "process" | "recut">,
  selector: string,
  options: ExecuteRemergeChangeOptions,
  io: YrdCliIO,
) {
  const service = services.recut ?? configuration("pr.recut capability is not installed")
  const pr = requiredPr(app, selector)
  const delivery = changeDeliveryState(pr)
  const currentRevision = currentChangeRev(pr)
  const proposedHeadSha = options.proposedHeadSha
  const expectedCurrent = options.expectedCurrent ?? {
    revision: currentRevision.n,
    headSha: currentRevision.head,
  }
  if (
    currentRevision.n !== expectedCurrent.revision ||
    currentRevision.head !== expectedCurrent.headSha ||
    (expectedCurrent.track !== undefined && isTracked(pr) !== expectedCurrent.track)
  ) {
    raiseFailure(
      "refusal",
      "recut-current-changed",
      `yrd: change '${pr.id}' current revision changed from ${expectedCurrent.revision}@${expectedCurrent.headSha} ` +
        `to ${currentRevision.n}@${currentRevision.head} before the re-merge was computed`,
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
      `yrd: change '${pr.id}' is ${delivery}; a finished change cannot be re-merge`,
    )
  }
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1)) {
    usage("--revision must be a positive integer")
  }
  const fromRevision = options.revision ?? currentRevision.n
  const source = pr.revs.find((revision) => revision.n === fromRevision)
  if (source === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: change '${pr.id}' has no revision ${fromRevision}`)
  }
  // Refuse to silently discard a green check: if the change's current head already
  // holds a passing check for its current revision, re-merging supersedes that
  // revision and throws the passing result away. Require an explicit --force so
  // the discard is a deliberate operator choice, never a mechanical accident.
  const checksPassed = app.queue.eligibility(pr.id).checks.status === "passed"
  if (options.force !== true && checksPassed) {
    raiseFailure(
      "refusal",
      "recut-would-discard-green",
      `yrd: change '${pr.id}' revision ${currentRevision.n} already passed its checks; re-merge would discard that result. ` +
        "Tracked changes re-merge implicitly when the branch moves; the runner applies force only when its own " +
        "preflight verdict warrants discarding the green check.",
    )
  }
  const sourceReview = pr.reviews.findLast((review) => review.revision === source.n && review.headSha === source.head)
  const approval = sourceReview?.decision === "approve" ? sourceReview : undefined
  const remergeExpectedCurrent = expectedCurrent
  const remergeInput: Parameters<typeof service.recut>[0] = {
    id: pr.id,
    ...(pr.bay === undefined ? {} : { bay: pr.bay }),
    ...(pr.name === undefined ? {} : { name: pr.name }),
    branch: pr.branch,
    base: pr.base,
    revision: source.n,
    headSha: source.head,
    ...(source.baseSha === undefined ? {} : { baseSha: source.baseSha }),
    ...(source.props === undefined ? {} : { props: source.props }),
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
          },
        }),
  }
  const result = await service.recut(remergeInput)
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
        revision: changeRevisionNumber(current),
        baseSha: result.baseSha,
        treeSha: result.treeSha,
        patchId: result.patchId,
        reviewCarried: approval !== undefined,
        ...(changeProps(current) === undefined ? {} : { props: changeProps(current) }),
        sourceReadyAt: changeSourceReadyAt(current),
        lineage: changeRevisionLineage(current).map((revision) => revision.n),
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
        ]
  // Re-merge Phase 1 (22925 family, staged-interim per (A)): this call still
  // mints a ChangeRev — the OLD handle, kept as transition staging, not new
  // persistence semantics. `result` is computed by MERGE (or, for a tracked
  // drift, is the author's own proposed tip recorded verbatim), and
  // `result.patchId` is an honest plain identity — no equivalence was
  // certified, there is nothing to certify against under merge. Review
  // carry-over for a proposed tip is gated on plain patch equivalence
  // (`result.reviewEquivalent`), the rule that replaced payload certificates.
  // Phase 2 deletes this mint entirely for the direct path (candidate-ref +
  // checks-cache tracking replaces it) — see the plan doc's DoD row.
  const recorded = await app.bays.recut({
    pr: pr.id,
    fromRevision: source.n,
    headSha: result.headSha,
    baseSha: result.baseSha,
    treeSha: result.treeSha,
    patchId: result.patchId,
    reviewCarried: approval !== undefined && result.reviewEquivalent !== false,
    sources,
    expectedCurrent: remergeExpectedCurrent,
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
      const reason = `PR re-merge superseded revision ${source.n}`
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
    const currentDelivery = changeDeliveryState(current)
    if (currentDelivery !== "submitted" && currentDelivery !== "ready") {
      raiseFailure("refusal", "recut-not-ready", `yrd: change '${current.id}' is ${currentDelivery}, not ready`)
    }
    if (!app.bays.checksRequested(current.id)) {
      await app.bays.requestChecks({ pr: current.id, expectedCurrent: queueExpectedCurrent })
    }
    await app.bays.ready({ pr: current.id, expectedCurrent: queueExpectedCurrent })
    current = requiredPr(app, current.id)
  }
  const output = {
    pr: current.id,
    revision: changeRevisionNumber(current),
    baseSha: result.baseSha,
    treeSha: result.treeSha,
    patchId: result.patchId,
    reviewCarried: approval !== undefined,
    ...(changeProps(current) === undefined ? {} : { props: changeProps(current) }),
    sourceReadyAt: changeSourceReadyAt(current),
    lineage: changeRevisionLineage(current).map((revision) => revision.n),
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
  if (pr === undefined) throw new Error(`yrd: change '${selector}' disappeared after review`)
  const review =
    options.ref === undefined
      ? app.bays.reviewState(pr.id).current
      : pr.reviews.findLast((candidate) => candidate.ref === options.ref)
  if (review === undefined) throw new Error(`yrd: change '${pr.id}' did not retain its current review`)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.review",
      pr: changeFact(pr),
      review,
      eligibility: projectEligibilityTaskStatus(app.queue.eligibility(pr.id)),
    },
    `${pr.id} revision ${changeRevisionNumber(pr)} ${review.decision} by ${review.by}`,
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
  if (pr === undefined) throw new Error(`yrd: change '${selector}' disappeared after request-review`)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.request-review",
      pr: changeFact(pr),
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
  if (pr === undefined) throw new Error(`yrd: change '${selector}' disappeared after comment`)
  const comment =
    options.ref === undefined ? pr.comments.at(-1) : pr.comments.findLast((candidate) => candidate.ref === options.ref)
  if (comment === undefined) throw new Error(`yrd: change '${pr.id}' did not retain its comment`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.comment", pr: changeFact(pr), comment },
    `${pr.id} revision ${changeRevisionNumber(pr)} commented by ${comment.by}`,
  )
}

async function changeChecks(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption & Readonly<{ follow?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (selectors.length === 0) usage("pr checks requires at least one change selector")
  let checks: readonly ChangeCheckViewRecord[] = changeCheckRecords(app, selectors)
  if (options.follow === true) {
    // A just-submitted change's check request may not be observable yet.
    // `--follow` means WAIT, so a not-yet-requested check enters the same 1s
    // poll loop as a queued one instead of hard-refusing and making the
    // submit→follow racer hand-retry. The loop stays abortable via io.scope.
    checks = await followCheckRecords(app, selectors, checks, io)
  }
  if (jsonEnabled(options)) {
    for (const check of checks) io.stdout(stableJson({ kind: "pr.check", ...projectCheckTaskStatus(check) }))
  } else {
    await printHuman(io, createElement(ChangeChecksView, { records: checks, now: io.now?.() ?? Date.now() }))
  }
  return checksExit(checks)
}

/**
 * The exit code of `yrd pr checks`, where 0 means EVERY selected change holds a
 * recorded PASSING verdict — not merely that no record says failed.
 *
 * The old rule was `some(failed) ? 1 : 0`, which reads "no bad news" as "fine"
 * and made a real failure unprovable. Measured on PR1970 (2026-08-23,
 * @i/10-merge-queue/failed-check-erased): `yrd pr submit` ran four required
 * checks, FAILED `affected-tests` and exited 1; minutes later this command
 * reported `not-requested` and exited 0. No surface was lying about its own
 * model — the pre-submit leg writes no verdict anywhere, so `not-requested`
 * was an accurate reading of the queue-side record — but a caller who only had
 * the exit code was told the change was clean.
 *
 * `not-requested`, `queued` and `checking` are the ABSENCE of a verdict, and an
 * absent verdict is a refusal, never a silent nothing
 * (@i/18-bare-metal/out-of-resource-doctrine D1). They join `failed` at exit 1;
 * which of them it is stays legible in the rows this command already prints. An
 * EMPTY record set is the same absence with nothing to print, so it refuses too
 * rather than letting "we found nothing" pass for "we found everything green".
 */
function checksExit(records: readonly ChangeCheckViewRecord[]): YrdCliExitCode {
  return records.length > 0 && records.every((record) => record.status === "passed") ? 0 : 1
}

function checksTerminal(records: readonly ChangeCheckViewRecord[]): boolean {
  // `not-requested` is followable: right after a submit the check request can
  // simply not be observable yet, and --follow's contract is to wait for it.
  return records.every(
    (record) => record.status !== "queued" && record.status !== "checking" && record.status !== "not-requested",
  )
}

async function followCheckRecords(
  app: YrdCliApp,
  selectors: readonly string[],
  initial: readonly ChangeCheckViewRecord[],
  io: YrdCliIO,
): Promise<readonly ChangeCheckViewRecord[]> {
  const scope = io.scope ?? app.scope
  let records = [...initial]
  while (!checksTerminal(records) && !scope.signal.aborted) {
    await scope.sleep(1_000)
    if (scope.signal.aborted) return records
    await app.refresh()
    if (scope.signal.aborted) return records
    records = [...changeCheckRecords(app, selectors)]
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
 * value already on the change is carried forward, else the head commit subject/body
 * (with an issue reference) seeds the default. The commit is only read when a default
 * is actually needed, so carried-forward revisions never re-derive it. */
async function resolveSubmitMetadata(
  app: YrdCliApp,
  selector: string,
  options: Readonly<{ title?: string; description?: string; issue?: string }>,
  io: YrdCliIO,
): Promise<Readonly<{ title?: string; description?: string }>> {
  const existing = app.bays.pr(selector)
  const bay = app.bays.get(selector)
  // Commit-derived defaults exist to BIND onto a change record, so they only
  // travel where a record will take them: a bay selector, or a branch whose
  // LIVE record the submit revises. Everything else routes to the DERIVED
  // lane, where the head commit itself is the metadata — forwarding a
  // commit-derived copy there only trips the record-only-drop warning,
  // telling the author to amend a commit to carry the title it was read
  // from. Explicit flags still travel (and warn) so the drop stays loud.
  if (bay === undefined && (existing === undefined || !isLiveChange(existing))) {
    return {
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.description === undefined ? {} : { description: options.description }),
    }
  }
  const needTitle = options.title === undefined && existing?.title === undefined
  const needDescription = options.description === undefined && existing?.description === undefined
  const issue = options.issue ?? existing?.issue
  let commit: Readonly<{ subject: string; body?: string }> | undefined
  if (needTitle || needDescription) {
    commit = await optionalCommitMeta(bay?.branch ?? existing?.branch ?? selector, io)
  }
  const title = options.title ?? existing?.title ?? commit?.subject
  const description = options.description ?? existing?.description ?? composeDescription(commit?.body, issue)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

/** One spelling of the tracking surface across every verb that records it.
 * Tracking is the DEFAULT (tracked-delivery, 2026-08-25); `--track` is the
 * explicit affirmation and `--no-track` the recorded opt-out. */
const TRACK_OPTION_DESCRIPTION =
  "merge into latest (default): the habitant records, preflights, and queues later branch pushes as frozen revisions"
const NO_TRACK_OPTION_DESCRIPTION =
  "opt out of tracking: a moved branch head then refuses instead of being recorded as a revision"

type ChangeSelectionOptions = {
  follow?: boolean
  wait?: boolean
  base?: string
  queue?: string
  issue?: string
  title?: string
  description?: string
  prop?: readonly string[]
  composition?: string
  reviewer?: readonly string[]
  track?: boolean
  keepOnFailure?: boolean
  json?: boolean
}

/** One Bay-binding explanation across create and submit. The command-specific
 * caller supplies the executable escape, while this formatter keeps the
 * binding identity and terminal state from drifting between surfaces. */
function bayBindingRefusal(
  bay: Readonly<{ id: string }>,
  pr: Readonly<{ id: string }>,
  delivery: string,
  remedy: string,
): never {
  refusal(`bay '${bay.id}' is bound to change '${pr.id}' (${delivery}); ${remedy}`)
}

/** `pr create` past-draft refusal. When the change was reached through a Bay
 * binding — a bare `pr create` resolving the cwd Bay, or a Bay selector — the
 * caller never named the change, so the refusal must say which binding produced it
 * and that a branch selector is the way past it (B94, 2026-08-19: two bare
 * `pr create` refusals named only the finished PR).
 *
 * The BARE path needs a different cure, and reusing the Bay path's would be
 * worse than silence: it fires only when no Bay resolved, which means the
 * caller ALREADY named a branch. "Pass a branch" sends that reader in a circle.
 * What is past the refusal depends on whether the change is still live —
 * `redeliveryRefusedByDelivery` is the same discriminator the remedy planner
 * uses, so both answers cannot drift apart. Spelled as quoted `yrd ...`
 * commands because the renderer lifts those onto `resolve:` and discards the
 * prose around them (actionable-error.ts `embeddedYrdCommands`).
 */
function createOnlyRefusal(
  bay: Readonly<{ id: string }> | undefined,
  pr: Readonly<{ id: string }>,
  delivery: string,
): never {
  if (bay !== undefined) {
    bayBindingRefusal(bay, pr, delivery, "pass a branch — yrd pr create <branch>")
  }
  const remedy = redeliveryRefusedByDelivery(delivery as ChangeDeliveryState)
    ? `'${delivery}' is terminal and its branch is spent — move the work onto a fresh ref, then 'yrd pr create <new-branch>'`
    : `add a revision to the live change instead — 'yrd pr submit <branch>'`
  refusal(`change '${pr.id}' is already ${delivery}; create is only for a draft change; ${remedy}`)
}

type ChangeSelectionCommand = "bay.submit" | "pr.create" | "pr.submit"
type ChangeSelectionResult = Readonly<{
  prs: readonly Change[]
  derived: readonly DerivedSubmission[]
  warnings: readonly string[]
}>

async function applyChangeSelection(
  app: YrdCliApp,
  selectors: readonly string[],
  options: ChangeSelectionOptions,
  io: YrdCliIO,
  command: ChangeSelectionCommand,
  stageAsDraft = command === "pr.create",
): Promise<ChangeSelectionResult> {
  const createOnly = command === "pr.create"
  const props = parseProps(options.prop)
  const state = stateOf(app)
  const cwd = invocationCwd(io)
  const local = currentBay(state.bays, cwd)
  const inferred = resolveSubmitSelectors(selectors, local?.id ?? currentGitBranch(cwd, io))
  const prs: Change[] = []
  const derived: DerivedSubmission[] = []
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
      const delivery = previous === undefined ? undefined : changeDeliveryState(previous)
      if (previous !== undefined && delivery !== "pushed" && delivery !== "rejected") {
        createOnlyRefusal(selectedBay, previous, changeDeliveryState(previous))
      }
    }
    const metadata = await resolveSubmitMetadata(app, selector, options, io)
    // Internal compatibility seam: `draft` means emit `pr/pushed` without
    // `pr/submitted`; it is deliberately not part of either submit CLI.
    const submission = await app.bays.submitSelection(selector, {
      ...(base === undefined ? {} : { base }),
      ...(options.issue === undefined ? {} : { issue: options.issue }),
      ...(metadata.title === undefined ? {} : { title: metadata.title }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(options.track === false ? { track: false } : {}),
      // pr.create stages a real draft record; the pre-submit staging pass of
      // pr.submit/bay.submit previews without writing (a recordless branch
      // returns the derived preview instead of refusing or minting).
      ...(stageAsDraft ? (createOnly ? { draft: true } : { stage: true }) : {}),
      ...(props === undefined ? {} : { props }),
      ...(composition === undefined ? {} : { composition }),
      resolveRevision: (ref) => optionalRevision(ref, io),
      run: runtimeOptions(io),
      warnings,
    })
    if ("lane" in submission) {
      // Routed to the derived lane: the fact is the submission. Record-lane
      // aftercare (supersede-cancel, reviewers, check requests) does not apply.
      derived.push(submission)
      continue
    }
    let pr = submission
    if (previous !== undefined) {
      const priorRevision = currentChangeRev(previous)
      const currentRevision = currentChangeRev(pr)
      if (priorRevision.n !== currentRevision.n || priorRevision.head !== currentRevision.head) {
        await app.queue.cancelAdmissionJobs({
          pr: previous.id,
          revision: priorRevision.n,
          by: io.runner ?? "operator",
          reason: `a newer submit superseded revision ${priorRevision.n}`,
        })
      }
    }
    const delivery = changeDeliveryState(pr)
    if (createOnly && delivery !== "pushed") {
      createOnlyRefusal(selectedBay, pr, delivery)
    }
    if (reviewers.length > 0 && delivery !== "integrated" && delivery !== "already-landed") {
      await app.bays.requestReview({
        pr: pr.id,
        reviewers: [...reviewers],
        ...(io.runner === undefined ? {} : { by: io.runner }),
      })
      const requested = app.bays.pr(pr.id)
      if (requested === undefined) throw new Error(`yrd: change '${pr.id}' disappeared after request-review`)
      pr = requested
    }
    prs.push(pr)
  }
  return { prs, derived, warnings }
}

async function printChangeSelectionResult(
  io: YrdCliIO,
  options: JsonOption,
  command: ChangeSelectionCommand,
  result: ChangeSelectionResult,
): Promise<void> {
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    { command, prs: result.prs.map(projectChangeTaskStatus) },
    createElement(ChangeResultView, { prs: result.prs, runs: [] }),
    result.warnings,
  )
}

/**
 * The refusal when a submit would gate the WORKING TREE while recording a REF
 * that does not contain it.
 *
 * `submitRequiredCheckContexts` passes no `ref` when you submit the branch you
 * are standing on, and `runRequiredChecks` reads the working tree in that case.
 * That is fine while the tree and the pushed ref agree, and silently wrong when
 * they do not: measured on PR1546, a local `git commit --amend` that was never
 * pushed produced "manifest-co-change: clean" and a +2 identity delta about
 * three inventory rows the RECORDED sha did not contain.
 *
 * Pure, so the decision is testable without a repository, and so the message
 * cannot drift from the condition that raises it.
 */
export function submitTreeDivergenceRefusal(
  branch: string,
  headSha: string | undefined,
  refSha: string | undefined,
): string | undefined {
  // A read that failed is not a mismatch. A branch with no pushed ref fails
  // later in submit naming itself, and inventing a refusal from a git hiccup
  // would be unactionable — the one thing worse than this bug.
  if (headSha === undefined || refSha === undefined) return undefined
  if (headSha === refSha) return undefined
  return (
    `local HEAD ${headSha} is not the ref this submit would record: '${branch}' resolves to ${refSha}. ` +
    "The required checks run against your WORKING TREE when you submit the branch you are standing on, " +
    "so a green verdict here would describe content the queue cannot carry. Push the branch first, " +
    "then submit — or submit from a tree that is not on it, which gates the pushed ref instead."
  )
}

/** A commit sha, or undefined when the revision cannot be resolved at all. */
function resolvedSha(cwd: string, revision: string): string | undefined {
  try {
    const sha = gitSync(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim()
    return sha === "" ? undefined : sha
  } catch (error) {
    if (isGitTimeoutError(error)) throw error
    return undefined
  }
}

function submitRequiredCheckContexts(
  app: YrdCliApp,
  selectors: readonly string[],
  io: YrdCliIO,
): readonly Readonly<{ cwd: string; ref?: string }>[] {
  const cwd = invocationCwd(io)
  const state = stateOf(app)
  const local = currentBay(state.bays, cwd)
  const currentBranch = currentGitBranch(cwd, io)
  const inferred = resolveSubmitSelectors(selectors, local?.id ?? currentBranch)
  return inferred.map((selector) => {
    const bay = app.bays.get(selector)
    const branch = app.bays.pr(selector)?.branch ?? bay?.branch ?? selector
    if (branch !== currentBranch) return { cwd, ref: branch }
    // Standing on the branch: the checks below will read this WORKING TREE, so
    // refuse before they can earn a verdict about content the record will not
    // name. Compared against the remote-tracking ref because that is what the
    // queue will fetch, not what the local branch pointer says.
    const divergence = submitTreeDivergenceRefusal(
      branch,
      resolvedSha(cwd, "HEAD"),
      resolvedSha(cwd, `refs/remotes/origin/${branch}`),
    )
    if (divergence !== undefined) refusal(divergence)
    return { cwd }
  })
}

/** A terminal Bay binding is historical identity, not the current submit
 * target. Preserve that history in Bays, but refuse an implicit/Bay submit
 * before guards spend work on the stale branch expectation. Explicit PR and
 * branch selectors deliberately bypass this preflight. */
function refuseTerminalBaySubmitBinding(app: YrdCliApp, selectors: readonly string[], io: YrdCliIO): void {
  const cwd = invocationCwd(io)
  const local = currentBay(stateOf(app).bays, cwd)
  const inferred = resolveSubmitSelectors(selectors, local?.id ?? currentGitBranch(cwd, io))
  for (const selector of inferred) {
    const bay = app.bays.get(selector)
    if (bay === undefined) continue
    const bound = app.bays.pr(bay.id)
    if (bound === undefined || isLiveChange(bound)) continue
    const delivery = changeDeliveryState(bound)
    if (delivery !== "withdrawn" && delivery !== "canceled") continue
    const branch = currentGitBranch(bay.path ?? cwd, io)
    if (branch === undefined || branch === bay.branch) continue
    const branchPr = app.bays.pr(branch)
    const target = branchPr !== undefined && isLiveChange(branchPr) ? branchPr.id : branch
    bayBindingRefusal(
      bay,
      bound,
      delivery,
      `its workspace is on branch '${branch}'; pass the intended change explicitly — yrd pr submit ${target}`,
    )
  }
}

/**
 * A submit into a repository that declares `merge: none` refuses HERE, before
 * the required-check hook runs, because everything after this point is work
 * spent on a candidate nothing will ever pick up.
 *
 * The gate is the declaration and only the declaration. Refusing on a missing
 * runner instead was considered and rejected on evidence: a runner is routinely
 * absent for a moment, and every fixture in this suite runs without one, so
 * that predicate measures the fixture rather than the defect. The state of a
 * queue that has never run cannot tell you whether it ever will.
 */
async function refuseSubmitWithoutMergeAuthority(
  options: ChangeSelectionOptions,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<YrdCliExitCode | undefined> {
  const repo = io.cwd ?? process.cwd()
  const merge =
    mergeAuthorityBoundary(services) ??
    (await loadYrdConfig({ repo, defaultBase: options.base ?? options.queue ?? "main" })).config.merge
  if (merge !== "none") return undefined
  // Three facts are load-bearing. WHICH repository, because a seat working
  // across two of them reads this message with no other clue; that no runner is
  // coming, because "submit failed" invites a retry and a retry cannot help;
  // and THE CURE, because without it this reads as a dead end. It is not one —
  // a component with no queue is the design, and the work still lands, by the
  // route named below. Said only in a document, that route was rediscovered the
  // hard way 13 days after the document was written; a refusal that withholds
  // its own cure buys the same rediscovery every time it fires.
  //
  // The fast-forward step is prose, not a literal push command, for the reason
  // `authoredGitlinkFailure` (actionable-error.ts) spells out and
  // `intentSubmissionWorkflow` (yrd-queue) already follows: printing a raw
  // push-to-a-submodule's-branch-ref line is banned across this tool surface
  // (remedy-banned-actions-guard.test.ts). Match that wording; do not spell the
  // command.
  const message =
    `'${repo}' declares no merge authority (selected config 'merge: none'), so its queue has no runner and ` +
    "nothing will ever drain this change. A component without a queue is the design, not a dead end: get " +
    "this commit onto this repository's own main, then submit the gitlink bump as an ordinary change from " +
    "the superproject that pins it ('yrd pr submit <branch>' there). Set 'merge: expected' instead only " +
    "once this repository has a runner of its own."
  if (jsonEnabled(options)) {
    io.stderr(
      stableJson({
        command: "pr.submit",
        repo,
        failure: { kind: "refusal", code: "no-merge-authority", message },
      }),
    )
    return 1
  }
  refusal(message)
}

async function applyChangeSelectionVerb(
  app: YrdCliApp,
  services: YrdCliServices,
  selectors: readonly string[],
  options: ChangeSelectionOptions,
  io: YrdCliIO,
  command: ChangeSelectionCommand,
): Promise<YrdCliExitCode> {
  const requiredChecks: PreSubmitCheckVerdict[] = []
  if (command === "pr.submit") {
    const unlandable = await refuseSubmitWithoutMergeAuthority(options, io, services)
    if (unlandable !== undefined) return unlandable
    refuseTerminalBaySubmitBinding(app, selectors, io)
    for (const context of submitRequiredCheckContexts(app, selectors, io)) {
      // Guards first, and in the same loop, so the cheap verdict on THIS
      // carrier merges before its expensive one starts.
      await runPreSubmitGuards(services, { ...io, cwd: context.cwd }, undefined, context.ref, jsonEnabled(options))
      // Kept, never discarded: this used to be a bare `await`, so a green
      // pre-submit gate left exactly as much evidence as a red one — none.
      requiredChecks.push(
        ...(await runRequiredChecks(
          services,
          { ...io, cwd: context.cwd },
          undefined,
          context.ref,
          options.keepOnFailure === true,
          jsonEnabled(options),
        )),
      )
    }
  }
  if (command === "pr.submit" || command === "bay.submit") {
    // Stage as a draft and refuse BEFORE the real submit, so a refusal has
    // nothing queued to leave behind. `bay.submit` used to run this check only
    // after the submit: an authored-gitlink refusal then stranded a SUBMITTED
    // PR with no check request (PR1128, 2026-08-16), a state the queue loader
    // tripped over fleet-wide. A refused staging leaves only a draft — the
    // known, benign `draft-stranded` shape the pager already names.
    const staged = await applyChangeSelection(app, selectors, options, io, command, true)
    for (const pr of staged.prs) {
      const refusalExit = await requireQueueableSubmodulePinsForCommand(pr, services, options, io)
      if (refusalExit !== undefined) return refusalExit
    }
  }
  const result = await applyChangeSelection(app, selectors, options, io, command)
  const prs = [...result.prs]
  const warnings = [...result.warnings]
  const createOnly = command === "pr.create"
  // `pr.create` is the only record-only selection verb. `bay.submit` is a
  // synchronous handoff: it must continue into the check-request loop below,
  // so a submitted carrier never waits for unrelated Queue activity to start.
  if (createOnly) {
    await printChangeSelectionResult(io, options, command, result)
    return 0
  }
  // Q1 — a same-head resubmit of a merged branch returns the frozen merged PR
  // (integrated or equivalence-proven already-landed, exit 0). It is not checkable and must not be admitted;
  // surface the informational note in the result envelope and drain only the
  // live submissions.
  for (const pr of prs) {
    if (changeDeliveryState(pr) === "integrated") {
      warnings.push(
        `already merged as change '${pr.id}'${pr.integration === undefined ? "" : ` (${pr.integration.commit})`}`,
      )
    } else if (changeDeliveryState(pr) === "already-landed") {
      warnings.push(
        `already merged as change '${pr.id}'${pr.integration === undefined ? "" : ` (${pr.integration.baseSha})`}`,
      )
    }
  }
  const checkable = prs.filter((pr) => {
    const delivery = changeDeliveryState(pr)
    return delivery === "pushed" || delivery === "submitted" || delivery === "ready"
  })
  for (const pr of checkable) {
    const refusalExit = await requireQueueableSubmodulePinsForCommand(pr, services, options, io)
    if (refusalExit !== undefined) return refusalExit
  }
  for (const pr of checkable) await app.bays.requestChecks({ pr: pr.id })
  const selected = checkable.map((pr) => pr.id)
  // A submit routed entirely to the derived lane admitted nothing on the
  // record side and is still a SUCCESS: the facts are written, compose picks
  // them up. Only a selection that produced neither lane's acceptance is the
  // author-billed refusal below.
  if (selected.length === 0 && result.derived.length > 0) {
    await printResultWithWarnings(
      io,
      jsonEnabled(options),
      { command, prs: [], derived: result.derived, ...(requiredChecks.length === 0 ? {} : { requiredChecks }) },
      createElement(ChangeResultView, { prs: [], runs: [], now: io.now?.() ?? Date.now() }),
      [
        ...warnings,
        ...result.derived.map(
          (submission) =>
            `submitted to the derived lane: ${submission.branch} @ ${submission.sha.slice(0, 12)} (base ${submission.base}) — composes as a derived member on the next queue pass`,
        ),
      ],
    )
    return 0
  }
  if (selected.length === 0) {
    // Nothing was admitted, but the selection can still have handed back
    // author-owned work (a needs-author or rejected change returned
    // unmodified). This refusal exit carries the SAME envelope as the success
    // exit below — refresh first, per-change eligibility, warnings on the
    // human stream — and bills the author instead of reporting success.
    await app.refresh()
    const refusedPrs = prs.map((pr) => requiredPr(app, pr.id))
    const refused = refusedPrs.map((pr) => ({ pr, eligibility: app.queue.eligibility(pr.id) }))
    await printResultWithWarnings(
      io,
      jsonEnabled(options),
      {
        command,
        prs: refused.map(({ pr, eligibility }) => {
          return {
            ...projectChangeTaskStatusWithEligibility(pr, eligibility),
            eligibility: projectEligibilityTaskStatus(eligibility),
          }
        }),
        ...(requiredChecks.length === 0 ? {} : { requiredChecks }),
      },
      createElement(ChangeResultView, {
        prs: refusedPrs,
        runs: [],
        eligibilities: refused.map(({ eligibility }) => eligibility),
        now: io.now?.() ?? Date.now(),
        ...(io.columns === undefined ? {} : { columns: io.columns }),
      }),
      warnings,
    )
    return changeSelectionExitCode(refusedPrs)
  }
  // A selection action may commit through another live writer. Fold those
  // durable transitions before exit so the result cannot trail `pr view`.
  await app.refresh()
  const currentPrs = selected.map((selector) => requiredPr(app, selector))
  const current = currentPrs.map((pr) => ({ pr, eligibility: app.queue.eligibility(pr.id) }))
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    {
      command,
      prs: current.map(({ pr, eligibility }) => {
        return {
          ...projectChangeTaskStatusWithEligibility(pr, eligibility),
          eligibility: projectEligibilityTaskStatus(eligibility),
        }
      }),
      // A passing pre-submit gate is a fact about this submit that used to
      // reach no surface at all. It rides the envelope rather than stderr,
      // which stays silent on success (@i/10-merge-queue/failed-check-erased).
      ...(requiredChecks.length === 0 ? {} : { requiredChecks }),
      ...(result.derived.length === 0 ? {} : { derived: result.derived }),
    },
    createElement(ChangeResultView, {
      prs: currentPrs,
      runs: [],
      eligibilities: current.map(({ eligibility }) => eligibility),
      now: io.now?.() ?? Date.now(),
      ...(io.columns === undefined ? {} : { columns: io.columns }),
    }),
    [
      ...warnings,
      // The derived acceptance is a success line, not a warning, but it rides
      // the same human stream so a submit's outcome is never silent: the fact
      // is the submission, and the queue composes it on its next pass.
      ...result.derived.map(
        (submission) =>
          `submitted to the derived lane: ${submission.branch} @ ${submission.sha.slice(0, 12)} (base ${submission.base}) — composes as a derived member on the next queue pass`,
      ),
    ],
  )
  return changeSelectionExitCode(currentPrs)
}

/** Truthful exit for a submit-family result: an outcome the AUTHOR must act on
 * (needs-author, rejected) bills exit 1, exactly as narrow as `readyPr`'s
 * needs-author mapping. Integrated/already-landed resubmits stay informational
 * exit 0 (Q1 — the frozen merged identity), and a staged draft is a success. */
function changeSelectionExitCode(prs: readonly Change[]): YrdCliExitCode {
  return prs.some((pr) => {
    const delivery = changeDeliveryState(pr)
    return delivery === "needs-author" || delivery === "rejected"
  })
    ? 1
    : 0
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

/**
 * The ONE way a `change`/`pr` verb turns a selector into a change — both
 * admission lanes, one derivation.
 *
 * It used to be the record store alone (`app.bays.pr`, then the record-lane
 * live guard), which is why `yrd pr view PR2706` answered `no change 'PR2706'
 * — searched 2155 change(s)` while the queue was running PR2706's checks and
 * had merged PR2651 and PR2702–PR2705: post-S6 a `refs/for/` push mints no
 * record, so ~55 live changes were outside the only population these verbs
 * could see (@i/10-yrd, 2026-08-30). The record path is unchanged and still
 * wins — `resolveQueueChange` asks the store first — so no answer the record
 * lane already gave has moved.
 *
 * The record-lane LIVE guard is kept for record-backed selectors: it is what
 * refuses a branch alias whose changes are all terminal, and dropping it here
 * would let a mutating verb through on a change the store considers closed.
 */
function requiredPr(app: YrdCliApp, selector: string): Change {
  const state = stateOf(app)
  const derived = resolveQueueChange(state.bays, state.queues, selector)
  if (derived !== undefined && !hasChangeRecord(state.bays, derived.id)) return derived
  // Absence is reported with the denominator of what was actually searched.
  // Falling straight through to the record-lane guard would print the record
  // store's size — the under-count that made three seats read a live change's
  // absence as their own typo.
  if (derived === undefined && resolveChangeMatch(state.bays, selector) === undefined) {
    raiseFailure("refusal", "pr-not-found", queueChangeNotFoundMessage(state.bays, state.queues, selector))
  }
  return app.bays.pr(selector) ?? requireLiveChange(state.bays, selector)
}

type ChangeMergeOutcome =
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
  | Readonly<{ outcome: "not-merged"; status: Exclude<ChangeDeliveryState, "integrated" | "already-landed"> }>

function ChangeMergeOutcome(pr: DeepReadonly<Change>): ChangeMergeOutcome {
  const delivery = changeDeliveryState(pr)
  if (delivery === "already-landed") {
    const hasRunProof = pr.terminalRun !== undefined
    const hasRefreshProof = pr.alreadyLanded?.settlement !== undefined
    if (
      pr.integration === undefined ||
      pr.alreadyLanded === undefined ||
      pr.alreadyLandedAt === undefined ||
      hasRunProof === hasRefreshProof
    ) {
      refusal(`change '${pr.id}' is recorded as already merged but is missing its canonical equivalence proof`)
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
  if (delivery !== "integrated") return { outcome: "not-merged", status: delivery }
  if (pr.integration === undefined || pr.integratedAt === undefined) {
    refusal(`integrated change '${pr.id}' is missing canonical merge proof`)
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

function changeQueueRuns(app: YrdCliApp, pr: Change): Run[] {
  return allQueueRuns(app).filter((run) => run.prs.some((member) => member.id === pr.id))
}

/**
 * `bay.list` lifecycles, optionally carrying the two DERIVED facts the handoff-ready SLA
 * alarm needs but has never had: did this branch's work land, and is the certification that
 * named its head still fresh?
 *
 * Opt-in, because deriving them resolves the base through origin — an unconditional fetch
 * would put a network round trip behind a plain `yrd bay` and turn an offline listing into a
 * queue-authority refusal. Only handoff-ready rows are enriched; nothing else has a
 * certification to age.
 */
async function projectedLifecycles(
  app: YrdCliApp,
  bays: readonly DeepReadonly<Bay>[],
  visibleBayIds: ReadonlySet<string>,
  landing: boolean,
  cwd: string,
): Promise<readonly unknown[]> {
  const lifecycles = app.bays.branchLifecycles().filter((lifecycle) => visibleBayIds.has(lifecycle.bay))
  if (!landing) return lifecycles
  const bases = new Map(bays.map((bay) => [bay.id, bay.base]))
  await using process = createProcess()
  return await Promise.all(
    lifecycles.map(async (lifecycle) => {
      const base = bases.get(lifecycle.bay)
      if (lifecycle.status !== "handoff-ready" || base === undefined) return lifecycle
      return {
        ...lifecycle,
        ...(await projectHandoffReadyLanding({ process, repo: cwd, head: lifecycle.headSha, base })),
      }
    }),
  )
}

/** The bay's worktree HEAD, read now — not the persisted `bay.headSha` record,
 * which is only as fresh as the last write that touched it. `undefined` when
 * there is no live worktree to read (no path, or the path is gone). */
function liveBayHeadSha(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    return gitSync(path, ["rev-parse", "HEAD"]).trim()
  } catch {
    return undefined
  }
}

async function listBays(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ all?: boolean; check?: boolean; closed?: boolean; landing?: boolean }>,
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
  const open = bays.filter((bay) => !isTerminal(bay))
  const cwd = io.cwd ?? process.cwd()
  let reports: BayStatusReport[] | undefined
  if (options.check === true) {
    const remoteTrackingFresh = await refreshBayStatusOrigin(cwd)
    const protections = activeBayProtections(io)
    reports = await Promise.all(
      open.map(async (bay) =>
        classifyBayStatus(
          await gatherBayStatusFacts(app, bay, cwd, remoteTrackingFresh, protections, io.now?.() ?? Date.now()),
        ),
      ),
    )
  }
  // Keyed by bay id so each row's `safety` is copied from ITS OWN report —
  // the JSON payload used to carry `bays[]` and `reports[]` as two separate
  // arrays with no join key on the row itself, so a reader had to re-derive
  // the pairing `bay list --check --json` already knew and could get it wrong.
  const reportsByBay = reports === undefined ? undefined : new Map(reports.map((report) => [report.bay, report]))
  const prs = app.bays.prs()
  const jsonBays = bays.map((bay) => {
    const pr =
      prs.findLast((candidate) => candidate.bay === bay.id) ??
      prs.findLast((candidate) => candidate.branch === bay.branch)
    const report = reportsByBay?.get(bay.id)
    const liveHeadSha = options.check === true ? liveBayHeadSha(bay.path) : undefined
    return {
      ...bay,
      nativeStatus: bay.status,
      status: statuses.get(bay.id),
      ...(pr === undefined ? {} : { pr: { id: pr.id, status: changeDeliveryState(pr) } }),
      ...(report === undefined
        ? {}
        : {
            safety: {
              exit: report.exit,
              safe: report.safe,
              evidence: report.lines.map((line) => line.evidence),
            },
          }),
      ...(liveHeadSha === undefined ? {} : { liveHeadSha, stale: liveHeadSha !== bay.headSha }),
    }
  })
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
      lifecycles: await projectedLifecycles(app, bays, visibleBayIds, options.landing === true, cwd),
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
    refusal(`bay '${bay.id}' has no absolute worktree path; run 'yrd bay --json' to inspect it before recreating it`)
  }
  const projection = { command: "bay.path", bay: bay.id, path: bay.path }
  io.stdout(jsonEnabled(options) ? stableJson(projection) : `${bay.path}\n`)
}

const PR_LIST_DEFAULT_WINDOW_SIZE = 20

/** Bounded default `pr list` selection: open PRs claim window slots first
 * (newest open wins when opens alone exceed the window), the remaining budget
 * goes to the newest terminal rows. Input order (oldest-first by id) is
 * preserved in the output. */
function changeListRetainedRows<T extends Readonly<{ id: string; state: string }>>(
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

// `pr list` emits TWO state words on every row and `--state` has to serve
// both, filtering whichever field defines the value it was given.
//
// `state` is the change record's own field — PR.state in yrd-bay/src/model.ts,
// "is the change record open or closed?". `--state open` and `--state closed`
// filter it directly.
const CHANGE_LIST_RECORD_STATES: readonly Change["state"][] = ["open", "closed"]
const CHANGE_LIST_RECORD_STATE_HELP = CHANGE_LIST_RECORD_STATES.join(", ")

// `status` is the derived delivery label — the ChangeDeliveryState union in
// yrd-bay/src/model.ts — and this is every value the row filter below tests
// it against. "rejected" doubles as a read-compatible alias for
// "needs-author" (v1 clients' only author-fix bucket), already a real member
// on its own, so the alias adds no new value here. An unrecognized value used
// to fall through to an always-false filter — PR count 0 for every candidate,
// indistinguishable from "no PRs in that state" — the exact silent-empty-list
// shape this list exists to name.
const CHANGE_LIST_STATES: readonly ChangeDeliveryState[] = [
  "pushed",
  "submitted",
  "ready",
  "needs-author",
  "rejected",
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
]
const CHANGE_LIST_STATE_HELP = CHANGE_LIST_STATES.join(", ")

async function listPrs(
  app: YrdCliApp,
  options: JsonOption &
    Readonly<{
      base?: string
      state?: string
      issue?: string
      needsReview?: boolean
      reviewer?: string
      strict?: boolean
    }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reviewer !== undefined && options.needsReview !== true) usage("--reviewer requires --needs-review")
  const byRecordState =
    options.state !== undefined && CHANGE_LIST_RECORD_STATES.includes(options.state as Change["state"])
  const byDeliveryStatus =
    options.state !== undefined && CHANGE_LIST_STATES.includes(options.state as ChangeDeliveryState)
  // A value that both vocabularies define has two readings, and picking one
  // would answer a question the caller did not ask. The two sets are disjoint
  // today; this fires only if one drifts into the other, and says so rather
  // than silently filtering the field it happened to check first.
  if (byRecordState && byDeliveryStatus) {
    usage(
      `--state '${options.state}' is ambiguous: it names both a record state (${CHANGE_LIST_RECORD_STATE_HELP}) ` +
        `and a delivery status (${CHANGE_LIST_STATE_HELP})`,
    )
  }
  if (options.state !== undefined && !byRecordState && !byDeliveryStatus) {
    usage(
      `--state '${options.state}' is invalid; expected a record state (${CHANGE_LIST_RECORD_STATE_HELP}) ` +
        `or a delivery status (${CHANGE_LIST_STATE_HELP})`,
    )
  }
  const state = stateOf(app)
  const base = options.base === undefined ? undefined : selectedBase(state, options.base)
  const explicitlyFiltered =
    options.base !== undefined ||
    options.state !== undefined ||
    options.issue !== undefined ||
    options.needsReview === true ||
    options.reviewer !== undefined
  // BOTH lanes. `app.bays.prs()` is the change-RECORD store, and post-S6 a
  // `refs/for/<base>/<change>` push mints no record — so listing it alone
  // stopped this surface at PR2599 while the queue was merging PR2706
  // (@i/10-yrd, 2026-08-30). `queueChanges` is the same derivation `pr view`
  // resolves through, so the two verbs cannot disagree about the population.
  const matching = queueChanges(state.bays, state.queues)
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
  const listed = explicitlyFiltered || json ? matching : changeListRetainedRows(matching, PR_LIST_DEFAULT_WINDOW_SIZE)
  const rows = listed
    .map((pr) => ({
      pr,
      eligibility: app.queue.eligibility(pr.id),
      // The pure predicate over the change we already hold, not the
      // selector facade: that facade resolves through the record store and
      // throws for a derived member, which is how a widened `pr list` fell
      // over on the first recordless row it reached.
      needsReview: needsReview(pr, options.reviewer),
    }))
    .filter(
      ({ pr, eligibility }) =>
        options.state === undefined ||
        (byRecordState
          ? pr.state === options.state
          : projectedChangeStatus(pr, eligibility) === options.state ||
            changeDeliveryState(pr) === options.state ||
            // v1 clients used `rejected` as the only author-fix bucket. Keep
            // that filter as a read-compatible superset while every returned
            // row tells the truth with native `status: needs-author`.
            (options.state === "rejected" && projectedChangeStatus(pr, eligibility) === "needs-author")),
    )
    .filter(({ pr, eligibility, needsReview }) =>
      options.needsReview === true
        ? options.reviewer !== undefined
          ? needsReview
          : needsReview ||
            ((changeDeliveryState(pr) === "pushed" ||
              changeDeliveryState(pr) === "submitted" ||
              changeDeliveryState(pr) === "ready") &&
              eligibility.review.required &&
              !eligibility.review.approved)
        : true,
    )
  const selected = new Set(rows.map(({ pr }) => pr.id))
  const runs = allQueueRuns(app).filter((run) => run.prs.some((member) => selected.has(member.id)))
  const { merges, warnings } = await reconcileChangeMerges(
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
          ...projectChangeTaskStatusWithEligibility(pr, eligibility, merges.get(pr.id)),
          eligibility: projectEligibilityTaskStatus(eligibility),
          requestedReviewers: pr.requestedReviewers ?? [],
          needsReview,
          ...(publication === undefined ? {} : { publication }),
        }
      }),
      runs: runs.map(projectQueueRunTaskStatus),
    },
    createElement(ChangeListView, {
      rows: changeListRows(rows, runs, io.now?.() ?? Date.now(), merges, options.strict === true),
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
  const json = jsonEnabled(options)
  // Observed for EVERY output shape. This ran only when `!json`, so the
  // machine-readable path — the one everything scripts against — skipped the
  // observation entirely and answered for a change whose source branch was gone
  // as if it were ordinary (@i/10-yrd/absent-branch-is-terminal). A refusal that
  // fires for humans and not for robots is not a refusal, it is a display
  // choice; and the robots are what act on a stuck head.
  const cwd = io.cwd ?? globalThis.process.cwd()
  const git = io.pruneGit?.(cwd)
  const observed = await observeLiveBranch(services.process, cwd, pr.branch, git?.resolveCommit)
  const unobserved = observed.ok ? "" : observed.detail
  const liveSource: Readonly<{ head: string }> = {
    head: requireObservedBranchHead(observed, {
      observer: () => ({
        code: "pr-view-branch-observer-missing",
        message: `yrd: cannot observe live branch '${pr.branch}' while viewing change '${pr.id}'; ${unobserved}`,
      }),
      // `pr view` is the surface an operator reaches for while diagnosing a
      // stuck head, so it must name the branch's absence and the verb that
      // disposes of it — not send them to a `git rev-parse` that fails too.
      absent: () => ({
        code: "pr-view-branch-absent",
        message:
          `yrd: change '${pr.id}' has no source: its branch '${pr.branch}' is gone from origin (${unobserved})\n` +
          unobservableBranchRemedy("absent", pr, changeDeliveryState(pr), currentChangeRev(pr), "").text,
      }),
      fetch: () => ({
        code: "pr-view-branch-refresh-failed",
        message:
          `yrd: could not refresh live branch '${pr.branch}' from origin while viewing change '${pr.id}': ${unobserved}\n` +
          `retry: yrd pr view ${pr.id}`,
      }),
      resolve: () => ({
        code: "pr-view-branch-head-missing",
        message:
          `yrd: cannot resolve live branch '${pr.branch}' while viewing change '${pr.id}': ${unobserved}\n` +
          `inspect: git rev-parse --verify origin/${pr.branch}^{commit}`,
      }),
    }),
  }
  const state = stateOf(app)
  const target = resolveQueueTargets(state, [pr.id], undefined, pr.id)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  const delivery = changeDeliveryState(pr)
  const positions =
    delivery === "submitted" || delivery === "ready" ? await queuedChangePositions(app, pr.base, io) : undefined
  const position = positions?.get(pr.id)
  const runs = changeQueueRuns(app, pr)
  const attempts = await queueAttempts(services)
  const detail = ChangeDetailData(pr, runs, attempts)
  const eligibility = app.queue.eligibility(pr.id)
  const publication = projectPublication(publicationJob(app, pr))
  await printResultWithWarnings(
    io,
    json,
    {
      command,
      pr: projectChangeTaskStatusWithEligibility(pr, eligibility),
      eligibility: projectEligibilityTaskStatus(eligibility),
      merge: ChangeMergeOutcome(pr),
      ...(position === undefined ? {} : { position }),
      results: results.map(projectQueueStatusResultTaskStatus),
      detail,
      ...(publication === undefined ? {} : { publication }),
    },
    createElement(ChangeDetailView, {
      pr,
      liveSource,
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

async function viewChangeRuns(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<void> {
  for (let read = 0; read < 3; read += 1) {
    const snapshot = await app.journalSnapshot()
    let pr = resolveChange(snapshot.state.bays, selector)
    if (pr === undefined) {
      const confirmed = await app.journalSnapshot()
      if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
      pr =
        resolveQueueChange(snapshot.state.bays, snapshot.state.queues, selector) ??
        requireLiveChange(snapshot.state.bays, selector)
    }
    const runs = changeQueueRuns(app, pr)
    const attempts = await queueAttempts(services)
    const confirmed = await app.journalSnapshot()
    if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
    const eligibility = app.queue.eligibility(pr.id, snapshot.state)
    const data = {
      pr,
      eligibility,
      runs: runs.map((run) => queueShowData(run, runs, attempts, runRevisionClock(pr, run))),
    }
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "pr.runs",
        pr: projectChangeTaskStatusWithEligibility(pr, eligibility),
        eligibility: projectEligibilityTaskStatus(eligibility),
        runs: data.runs,
        ...trackerBridges(app, snapshot, ({ pr: id }) => id === pr.id),
      },
      createElement(ChangeRunsView, { data }),
    )
    return
  }
  refusal(
    `journal changed while reading change '${selector}' runs; retry with 'yrd pr runs ${selector}${jsonEnabled(options) ? " --json" : ""}'`,
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
  const base = changeBaseSha(pr) ?? pr.base
  let diff: string
  try {
    diff = gitSync(cwd, ["diff", ...(options.stat === true ? ["--stat"] : []), `${base}...${changeHead(pr)}`, "--"])
  } catch (error) {
    refusal(`cannot diff change '${pr.id}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const composition = changeComposition(pr)
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
      head: changeHead(pr),
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
  const head = changeHead(pr)
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

/**
 * C3b (@i/10-yrd, 2026-08-31): the current change resolves over BOTH lanes —
 * a derived member reached by bay or branch is a real change, and the
 * record-only read refused it with "has no PR; submit it" while the queue was
 * running its checks (specimen: PR2773, issue/advance-yrd-4f27b0a-take2,
 * derived from admission to merge). Bay match wins over branch match, as it
 * always has. Module-exported for current-change-both-lanes.test.ts (relative
 * import), off the package surface.
 */
export function changeForBayOrBranch(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  bayId: string | undefined,
  branch: string | undefined,
): Change | undefined {
  const population = queueChanges(bays, queues)
  return (
    (bayId === undefined ? undefined : population.find((candidate) => candidate.bay === bayId)) ??
    population.find((candidate) => candidate.branch === branch)
  )
}

function currentPr(app: YrdCliApp, io: YrdCliIO): Change {
  const state = stateOf(app)
  const cwd = invocationCwd(io)
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr = changeForBayOrBranch(state.bays, state.queues, bay?.id, branch)
  if (pr === undefined) refusal("the current bay or branch has no PR; submit it with 'yrd pr submit'")
  return pr as Change
}

async function queuedChangePosition(app: YrdCliApp, pr: Change, io: YrdCliIO): Promise<number | undefined> {
  const delivery = changeDeliveryState(pr)
  if (delivery !== "submitted" && delivery !== "ready") return undefined
  return (await queuedChangePositions(app, pr.base, io)).get(pr.id)
}

async function queuedChangePositions(app: YrdCliApp, base: string, io: YrdCliIO): Promise<ReadonlyMap<string, number>> {
  const state = stateOf(app)
  // C3b (@i/10-yrd, 2026-08-31): both lanes — derived members hold queue positions too.
  const prs = queueChanges(state.bays, state.queues)
  const groups = await queueTargetGroups(new Set(prs.map((candidate) => candidate.base)), io)
  const group = groups.find((candidate) => candidate.aliases.has(base))
  if (group === undefined) throw new Error(`yrd: queue target group for base '${base}' disappeared`)
  const candidates = new Set(
    prs.filter((candidate) => group.aliases.has(candidate.base)).map((candidate) => candidate.id),
  )
  const ordered = app.queue.admissionOrder().filter((id) => candidates.has(id))
  return new Map(ordered.map((id, index) => [id, index + 1]))
}

/**
 * `yrd gitlink advance <submodule> [<sha>|main]` — the whole delivery of a submodule
 * gitlink bump, in one command.
 *
 * Thirteen of these landed on hh main on 2026-08-29/30 and all thirteen were hand-written:
 * a bespoke subject, a hand-cut branch, a hand-staged gitlink, a hand-driven submit. Every
 * piece was already here and proven — the min-commit rule, the forward-only rule, the bay,
 * the submit path — and nothing composed them, so an author redid the composition each time
 * and no two results looked alike.
 *
 * Order matters and is the design: everything that can REFUSE runs first, in
 * `planGitlinkAdvance`, before a branch, a bay or a push exists. A refusal that has already
 * cut a branch leaves litter for the next person to find and reason about.
 */
async function advanceSubmoduleGitlink(
  app: YrdCliApp,
  services: YrdCliServices,
  submoduleOperand: string,
  target: string | undefined,
  options: JsonOption & Readonly<{ dryRun?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (services.process === undefined) configuration("gitlink advance requires the process-backed Yrd runtime")
  const cwd = io.cwd ?? process.cwd()
  const root = superprojectRoot(cwd)
  if (root === undefined) refusal(`'${cwd}' is not inside a Git repository, so it records no submodule gitlinks`)
  const base = services.base ?? "main"
  const submodule = resolveSubmoduleOperand(submoduleOperand, readSubmoduleEntries(root))
  const plan = await planGitlinkAdvance({
    process: services.process,
    repo: root,
    base,
    submodule: { name: basename(submodule.path), path: submodule.path },
    target: target ?? "main",
  })

  if (options.dryRun === true) {
    await printResult(io, jsonEnabled(options), { command: "gitlink.advance", plan }, formatGitlinkAdvancePlan(plan))
    return 0
  }

  const published = await publishMinCommit(services.process, plan)
  if (published !== undefined) io.stderr(`${published}\n`)

  const prepared = await prepareOwnedBay(app, undefined, { bay: gitlinkAdvanceName(plan.name, plan.to) }, io)
  if (prepared === undefined) return 1
  const worktree = prepared.bay.path
  if (worktree === undefined) throw new Error(`yrd: bay '${prepared.bay.id}' opened without a worktree path`)

  // Fetch, check out, install, stage, commit — and the order is the whole lesson, measured
  // twice on 2026-08-30 against two different repositories' pre-commit hooks.
  //
  // The submodule reaches the target FIRST because the hook interrogates the bay's own
  // submodule about the staged gitlink, and a store that does not hold the target cannot
  // answer. The install follows the checkout for the same reason one step further out: a bay
  // provisioned while the submodule still sat on the old commit had no `node_modules` entry
  // for the target's workspace members, and the hook's root typecheck reported ~60 phantom
  // "cannot find module" errors against a tree that was in fact correct. Installed after,
  // every one of them was gone.
  await materializeGitlinkTarget(services.process, worktree, plan)
  await ensureBayDependencies(services.process, prepared.bay, worktree, io, undefined)
  await writeGitlinkAdvanceCommit(services.process, worktree, plan, prepared.bay.id)
  await pushGitlinkAdvanceBranch(services.process, worktree, prepared.identity.branch)

  const exit = await applyChangeSelectionVerb(app, services, [prepared.identity.branch], options, io, "pr.submit")
  if (exit !== 0) return exit

  // The two facts an author needs back from one invocation: which change this became, and
  // where it sits. `pr view` can answer both later; having to run it is the composition
  // failing at the last step.
  const submitted = app.bays.pr(prepared.identity.branch)
  if (submitted === undefined) {
    raiseFailure(
      "infrastructure",
      "advance-change-missing",
      `yrd: the gitlink advance submitted branch '${prepared.identity.branch}' but no change records it; ` +
        `inspect: yrd pr status`,
    )
  }
  const position = (await queuedChangePositions(app, submitted.base, io)).get(submitted.id)
  if (!jsonEnabled(options)) {
    io.stdout(
      `${submitted.id} ${position === undefined ? "submitted" : `queued at position ${position}`} — ` +
        `advance ${plan.path} ${plan.from.slice(0, 7)}..${plan.to.slice(0, 7)}\n`,
    )
  }
  return 0
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
    { command: "pr.edit", pr: projectChangeTaskStatus(edited) },
    createElement(ChangeResultView, { prs: [edited], runs: changeQueueRuns(app, edited) }),
  )
}

function changeFact(pr: DeepReadonly<Change>): Readonly<{
  id: string
  branch: string
  base: string
  revision: number
  headSha: string
  baseSha?: string
}> {
  const revision = currentChangeRev(pr)
  return {
    id: pr.id,
    branch: pr.branch,
    base: pr.base,
    revision: revision.n,
    headSha: revision.head,
    ...(revision.baseSha === undefined ? {} : { baseSha: revision.baseSha }),
  }
}

function selectedCheckPRs(app: YrdCliApp, selectors: readonly string[]): Change[] {
  // Was a hand-rolled `no change '<selector>'`, a third spelling of a fact the bay
  // model already words. Routing through requiredPr keeps ONE not-found
  // message, so the searched-count reaches every surface instead of the one
  // that happened to be fixed.
  return selectors.map((selector) => requiredPr(app, selector))
}

function changeCheckRecords(app: YrdCliApp, selectors: readonly string[]): ChangeCheckViewRecord[] {
  selectedCheckPRs(app, selectors)
  return [...app.queue.checks(selectors)]
}

function issueRows(app: YrdCliApp, state: DeepReadonly<YrdCliState>, selected?: string): IssueLensRow[] {
  const contests = app.contests.list()
  const refs = new Set<string>()
  for (const bay of Object.values(state.bays.byId)) if (bay.issue !== undefined) refs.add(bay.issue)
  for (const pr of recordChanges(state.bays)) if (pr.issue !== undefined) refs.add(pr.issue)
  for (const contest of contests) refs.add(`${contest.issue.ref.source}:${contest.issue.ref.id}`)
  if (selected !== undefined && !refs.has(selected)) refusal(`no issue '${selected}' is in flight`)
  return [...refs]
    .filter((issue) => selected === undefined || issue === selected)
    .toSorted()
    .map((issue) => {
      const bays = Object.values(state.bays.byId).filter((bay) => bay.issue === issue)
      const bayIds = new Set(bays.map((bay) => bay.id))
      const prs = recordChanges(state.bays).filter(
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
          [...prs.map((pr) => changeDeliveryState(pr)), ...joinedContests.map((contest) => contest.status)].join(",") ||
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
      pr: projectChangeTaskStatus(draft.pr),
    },
    `issue ${issue} → bay ${opened.bay.id} ${opened.identity.branch} → tracked draft ${draft.pr.id}`,
    draft.warnings,
  )
  return 0
}

async function listIssues(app: YrdCliApp, options: JsonOption, io: YrdCliIO, selected?: string): Promise<void> {
  // journalSnapshot is already one immutable state+cursor cut. Re-reading the
  // journal to prove that nobody appended after that cut made an ordinary
  // snapshot query refuse under a live writer even though the first answer was
  // internally complete. Every field below is projected synchronously from
  // this one cut; later frames belong to the next invocation.
  const snapshot = await app.journalSnapshot()
  const issues = issueRows(app, snapshot.state, selected)
  const bridges = trackerBridges(app, snapshot, ({ issueRef }) => selected === undefined || issueRef === selected)
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
    const input = ChangePublicationInputSchema.parse(job.input)
    if (input.continuation !== "queue") continue
    const pr = app.bays.pr(input.pr)
    if (pr === undefined || changeDeliveryState(pr) !== "pushed") continue
    const revision = currentChangeRev(pr)
    if (revision.n !== input.revision || revision.head !== input.headSha) continue
    await executeRemergeChange(
      app,
      services,
      pr.id,
      {
        queue: true,
        expectedCurrent: {
          revision: input.revision,
          headSha: input.headSha,
          ...(isTracked(pr) ? { track: true } : {}),
        },
      },
      io,
    )
  }
  return executed
}

/** Root `yrd cancel <selector>` — stop the CURRENT ATTEMPT (chief ruling,
 * I23): resolve a merge-request selector to its running or waiting run and
 * cancel that run; members re-queue and the change stays open. Cancel
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
        `yrd: change '${pr.id}' has no running or waiting attempt to cancel; to stop delivering it, use 'yrd mr close --reason <text> --burn-payload'`,
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
    run: requireUnqualifiedRunSelector(resolveCanonicalRunSelector(selector, io.repositoryRoot), "cancel"),
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

async function queueAuditFindings(
  app: Pick<YrdCliApp, "queue">,
  services: YrdCliServices,
  now?: string,
): Promise<readonly QueueAuditFinding[]> {
  return (await queueAuditReport(app, services, now)).findings
}

/** The audit's findings AND what produced them. Splitting the denominator out
 * of the finding list is what lets a zero say which population it is zero over
 * (23193); callers that only render findings use {@link queueAuditFindings}. */
async function queueAuditReport(
  app: Pick<YrdCliApp, "queue">,
  services: YrdCliServices,
  now?: string,
): Promise<Readonly<{ findings: readonly QueueAuditFinding[]; comparison?: QueueEnvironmentAuditComparison }>> {
  // Take the repository's landing answer BEFORE the sync audit reads it: this
  // is a short-lived process that never composes, so without this every
  // `unrecorded-submit` row would report itself unverified. The audit stays
  // sync (its other consumers are sync callbacks); priming is what lets the
  // operator-facing waiting list derive pendingness rather than assume it.
  await app.queue.scanLanding()
  // The widening boundary: both inputs are QueueAuditEmission, so every code
  // above this line is closed over YRD_QUEUE_AUDIT_FINDING_CODES. Downstream is
  // display and JSON, where a finding may equally be one a foreign version
  // wrote, so the open QueueAuditFinding is the honest type from here on.
  const core = app.queue.audit(now === undefined ? undefined : { now })
  const environment = await services.queue?.auditEnvironment?.()
  return {
    findings: [...core.findings, ...(environment?.findings ?? [])],
    ...(environment?.comparison === undefined ? {} : { comparison: environment.comparison }),
  }
}

/** The plan audit's denominator, printed whether or not anything was found:
 * what git declares at the tip, what this process installed, and how many
 * recorded Runs were compared — each side with the sha it was read from.
 * Without it a clean audit and an unwired one print the same word, and an
 * operator cited the clean one as evidence twice (23193). A leg that did not
 * run says so; it never prints as a compared zero. */
export function queueAuditComparisonLine(comparison: QueueEnvironmentAuditComparison | undefined): string {
  if (comparison === undefined) {
    return "plan audit: not wired for this invocation — nothing was compared against git."
  }
  const short = (sha: string | undefined): string => (sha === undefined ? "none" : sha.slice(0, 8))
  const arrow = (steps: readonly string[]): string => (steps.length === 0 ? "(no steps)" : steps.join("→"))
  const { tip, installed, runs } = comparison
  const lines = [
    `plan audit: ${comparison.base} tip ${short(tip.sha)} declares ${arrow(tip.steps)} (batch ${String(tip.batchSize)}) ` +
      (tip.configBlobSha === undefined
        ? `— no '${tip.configAuthority}' at that commit, so the built-in plan is in force.`
        : `from '${tip.configAuthority}' blob ${short(tip.configBlobSha)}.`),
    installed === undefined
      ? `plan audit: no installed plan was compared against the tip — ${
          comparison.installedUnavailable ?? "this invocation built no queue runtime and read no habitant heartbeat"
        }.`
      : installed.source === "resident-heartbeat"
        ? `plan audit: the habitant runner${installed.pid === undefined ? "" : ` (pid ${String(installed.pid)})`} ` +
          `published installed ${arrow(installed.steps)} (batch ${String(installed.batchSize)}) in its heartbeat; ` +
          "compared against the tip."
        : `plan audit: this process installed ${arrow(installed.steps)} (batch ${String(installed.batchSize)}); compared against the tip.`,
  ]
  if (runs === undefined) {
    lines.push("plan audit: recorded runs were not read in this invocation, so none was compared against git.")
  } else if (runs.read === 0) {
    lines.push(
      `plan audit: 0 runs compared against tip ${short(tip.sha)} blob ${short(tip.configBlobSha)} — the journal holds no recorded run.`,
    )
  } else {
    const skipped = [
      runs.explicit === 0
        ? undefined
        : `${String(runs.explicit)} explicit --steps selection${runs.explicit === 1 ? "" : "s"} not comparable`,
      runs.unrecorded === 0
        ? undefined
        : `${String(runs.unrecorded)} pre-23192 record${runs.unrecorded === 1 ? "" : "s"} with no plan source`,
    ].filter((part): part is string => part !== undefined)
    lines.push(
      `plan audit: ${String(runs.compared)} of the ${String(runs.read)} most recent runs compared against git at their base shas` +
        (skipped.length === 0 ? "." : ` (${skipped.join("; ")}).`),
    )
    if (runs.sinceLatest !== undefined) lines.push(`plan audit: ${runs.sinceLatest}`)
  }
  return lines.join("\n")
}

/** The audit findings that make a running queue unhealthy or block a Run:
 * this process cannot (or should not) execute the plan git declares, or a
 * recorded Run disagrees with the repository about what judged it. */
function isPlanFinding(finding: Readonly<{ code: string }>): boolean {
  return finding.code === "installed-plan-stale" || finding.code === "run-plan-mismatch"
}

function admissionBlockedChanges(
  app: YrdCliApp,
  selectedChangeIds?: ReadonlySet<string>,
): Array<Readonly<{ pr: Change; eligibility: ChangeEligibility }>> {
  return recordChanges(stateOf(app).bays)
    .filter((pr) => {
      const delivery = changeDeliveryState(pr)
      return (
        (selectedChangeIds === undefined || selectedChangeIds.has(pr.id)) &&
        (delivery === "submitted" || delivery === "ready" || delivery === "needs-author")
      )
    })
    .map((pr) => ({ pr, eligibility: app.queue.eligibility(pr.id) }))
    .filter(({ eligibility }) => eligibility.reason?.code === "admission-refused")
    .toSorted((left, right) => compareNatural(left.pr.id, right.pr.id))
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
  target: { bases: Set<string>; selected: Set<string>; changeFilter: string | undefined },
  io: YrdCliIO,
): Promise<{ results: readonly QueueStatusResult[] }> {
  if (target.selected.size === 0 && target.bases.size === 0) {
    for (const pr of recordChanges(state.bays)) target.bases.add(pr.base)
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
    // C3b (@i/10-yrd, 2026-08-31): both lanes. The `runs` above already carry
    // derived members — they exist only inside runs — so the record-lane read
    // here made one projection disagree with itself: a run rendered a member
    // that the `prs`, `admissionOrder`, `candidates` and `eligibilities` beside
    // it all denied existed.
    const groupPrs = queueChanges(state.bays, state.queues).filter((pr) => group.aliases.has(pr.base))
    const prs = groupPrs.filter((pr) => target.selected.size === 0 || target.selected.has(pr.id))
    const prIds = new Set(prs.map((pr) => pr.id))
    const groupChangeIds = new Set(groupPrs.map((pr) => pr.id))
    results.push({
      base: group.base,
      ...scopedRuns,
      ...(canonical.pause === undefined ? {} : { pause: canonical.pause }),
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs,
      admissionOrder: admissionOrder.filter((pr) => groupChangeIds.has(pr)),
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
      ...recordChanges(state.bays).map((pr) => baseIdentity(pr.base)),
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

function queueChangeDiffSource(pr: Change, revision: number): Readonly<{ base: string; headSha: string }> | undefined {
  const revisionRecord = pr.revs.find((candidate) => candidate.n === revision)
  const isCurrent = revision === changeRevisionNumber(pr)
  const headSha = isCurrent ? changeHead(pr) : revisionRecord?.head
  if (headSha === undefined) return undefined
  const base = isCurrent
    ? (changeBaseSha(pr) ?? revisionRecord?.baseSha ?? pr.base)
    : (revisionRecord?.baseSha ?? revisionRecord?.base)
  return base === undefined ? undefined : { base, headSha }
}

function queueChangeDiffResult(pr: Change, revision: number, numstat: string, patch: string): QueueChangeDiff {
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
export function queueChangeDiff(cwd: string, pr: Change, revision = changeRevisionNumber(pr)): QueueChangeDiff {
  const source = queueChangeDiffSource(pr, revision)
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
  return queueChangeDiffResult(pr, revision, numstat, patch)
}

async function queueChangeDiffAsync(
  cwd: string,
  pr: Change,
  revision: number,
  runGit: QueueGitRunner,
): Promise<QueueChangeDiff> {
  const source = queueChangeDiffSource(pr, revision)
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
  return queueChangeDiffResult(pr, revision, numstat, patch)
}

type QueueChangeDiffResolver = Readonly<{
  resolve(cwd: string, pr: Change, revision: number, now?: number): Promise<QueueChangeDiff>
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
const QUEUE_CHANGE_DIFF_CACHE_MAX = 256

export function createQueueChangeDiffResolver(
  options: Readonly<{ runGit?: QueueGitRunner; negativeTtlMs?: number; maxEntries?: number }> = {},
): QueueChangeDiffResolver {
  const runGit = options.runGit ?? gitAsync
  const negativeTtlMs = options.negativeTtlMs ?? 30_000
  const maxEntries = Math.max(1, options.maxEntries ?? QUEUE_CHANGE_DIFF_CACHE_MAX)
  const resolved = new Map<string, QueueChangeDiff>()
  const retryAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<QueueChangeDiff>>()
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
      const source = queueChangeDiffSource(pr, revision)
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

      const pending = queueChangeDiffAsync(cwd, pr, revision, runGit)
        .catch((error): QueueChangeDiff => {
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
  /** Why `runner` is null; absent when a runner is live. */
  runnerAbsence?: QueueRunnerAbsence
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
 * Heartbeat time is deliberately excluded; queueProgress is not.
 *
 * The absence belongs here and nowhere else: every absent state tokenizes the
 * runner as "none", so a departed runner whose status file is then removed would
 * otherwise leave the banner naming a pid that no longer has a record. */
function queueRunnerProjectionToken(
  runner: QueueTimelineRunner | null,
  absence: QueueRunnerAbsence | undefined,
): string {
  return JSON.stringify([
    queueRunnerStateToken(runner),
    runner?.queueProgress ?? null,
    runner?.driver ?? null,
    runner?.sourcePin ?? null,
    absence ?? null,
  ])
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
  const cwd = io.cwd ?? process.cwd()
  const now = io.now?.() ?? Date.now()
  const observation = observeHabitantRunner(await habitantRunnerStatus(cwd, io.stateDir))
  const observedRunner = observation.runner
  // Measured against the queue repository's RECORDED pin, never any checkout's
  // HEAD. The two prior bases were both wrong the same way — `cwd` counted
  // across unrelated histories ("37576 behind pin" for a current habitant),
  // and the observer's own Yrd checkout counted the observer ("28 behind pin"
  // for a pin-exact habitant, tracking commits only the watcher had).
  const sourcePin = observedRunner === null ? undefined : runnerPinBehind(cwd, observedRunner.implementationSource, now)
  const runner =
    observedRunner === null || sourcePin === undefined || sourcePin.state === "unpinned"
      ? observedRunner
      : { ...observedRunner, sourcePin }
  return {
    state,
    stateSource,
    cursor: readFailure === undefined ? read.cursor : journalCursor,
    generation: read.generation,
    attempts: read.attempts,
    runner,
    ...(observation.absence === undefined ? {} : { runnerAbsence: observation.absence }),
    runnerToken: queueRunnerToken(runner),
    runnerStateToken: queueRunnerStateToken(runner),
    runnerProjectionToken: queueRunnerProjectionToken(runner, observation.absence),
    now,
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
  configuredBase: string | undefined,
): Promise<QueueListSnapshotBuild> {
  const { state, now, runner, runnerAbsence, attempts } = observed
  // Nobody named a base, so the repository's own configured base is the primary
  // one — the same `options.base ?? services.base ?? "main"` order every other
  // base-reading command uses. A repository whose queue is `release` labels
  // `release` 1, rather than putting a `main` nobody configured at the front.
  const requestedBase = options.base ?? configuredBase ?? "main"
  const target = resolveQueueTargets(state, [], options.base, options.pr)
  // An operator who named no base and no PR asked about the REPOSITORY, not
  // about `main`: every queue with work is in scope, and the view labels them
  // 1..N (user directive 2026-08-13). `yrd log` has always read its targets
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
  // Computed directly from `app`, like `runnerRefusal` above — never read back
  // off a habitant's heartbeat, which may be stale or (watching a repository
  // with no habitant yet) simply absent. Watch has the journal in hand and can
  // always afford this; the health PROBE cannot, which is why it reads the
  // habitant-precomputed field instead (queueRunnerHealth in this file).
  // Prime the landing scan before the sync audit behind `staleDraftFindings`
  // reads it: this surface pages a human about branches that are waiting, and a
  // fact whose content already landed is not waiting. `watch` has the journal
  // in hand and can afford the repository read for the same reason the comment
  // above says it can afford this projection at all.
  await app.queue.scanLanding()
  const staleDrafts = staleDraftFindings(
    app,
    new Date(now).toISOString(),
    draftPageThresholdMs((await loadYrdConfig({ repo: io.cwd ?? process.cwd(), defaultBase: requestedBase })).config),
  )
  // Computed directly from `app`, exactly like `staleDrafts` above — watch has
  // the journal in hand and can always afford this
  // (@i/10-merge-queue/22918-needs-person-unowned).
  const needsPerson = needsPersonFindings(app, new Date(now).toISOString())
  const clock = createQueueTimelineProjectionClock(results, {
    now,
    windowMs: queueTimelineWindow(options.since),
    metricsWindowMs: queueMetricsWindow(options.since),
    statuses: queueTimelineStatuses(options.status),
    terms: filters,
    latest: options.latest === true,
    rowLimit: queueTimelineRowLimit(io),
    submissionTimes: queueTimelineAdmissionTimes(results),
    // --strict restores the historical loud abort for a member whose clocks
    // cannot be reconciled — the same escape hatch, spelled the same way, that
    // `yrd log --strict` gives the lister.
    ...(options.strict === true ? { strict: true } : {}),
    attempts,
    siblingBases: queueBases(state),
    base,
    state: state.bays,
    runner,
    ...(runnerAbsence === undefined ? {} : { runnerAbsence }),
    ...(io.repositoryRoot === undefined ? {} : { repositoryRoot: io.repositoryRoot }),
    // The composition host's declared handle names its configured base's
    // queue (`code`, `pm`); other bases in the same journal stay unnamed
    // until per-queue config labels merge (item 36 / the 37i machinery).
    ...(io.repositoryLabel === undefined
      ? {}
      : { queueNames: new Map([[baseIdentity(requestedBase), io.repositoryLabel]]) }),
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
      ...(staleDrafts.length === 0 ? {} : { staleDrafts }),
      ...(needsPerson.length === 0 ? {} : { needsPerson }),
    },
    reclock: clock.reclock,
  }
}

async function attachQueueListDetails(
  snapshot: QueueListSnapshot,
  attempts: readonly QueueAttempt[],
  io: YrdCliIO,
  focus: QueueWatchFocus | undefined,
  diffResolver: QueueChangeDiffResolver,
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
  const diffs = await (async (): Promise<readonly QueueChangeDiff[]> => {
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
        return queueChangeDiff(io.cwd ?? process.cwd(), pr, revision)
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
    diffResolver?: QueueChangeDiffResolver
    queueReadModel?: QueueReadModel
    /** The repository's configured base — `services.base` at the CLI seam —
     * which labels the primary queue when the caller named no base. */
    configuredBase?: string
  }> = {},
): Promise<QueueListSnapshot> {
  const { includeOutputs = false, focus, diffResolver } = details
  const observed = await observeQueueList(app, io, requiredQueueReadModel(details))
  const built = await buildQueueListSnapshot(app, filters, options, io, observed, details.configuredBase)
  const snapshot =
    observed.readFailure === undefined ? built.snapshot : { ...built.snapshot, readFailure: observed.readFailure }
  return includeOutputs
    ? attachQueueListDetails(snapshot, observed.attempts, io, focus, diffResolver ?? createQueueChangeDiffResolver())
    : snapshot
}

type QueueListSnapshotLoader = Readonly<{
  load(focus?: QueueWatchFocus): Promise<QueueListSnapshot>
}>

export const QUEUE_WATCH_CLOCK_INTERVAL_MS = 60_000

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
  const diffResolver = createQueueChangeDiffResolver()
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
          : await buildQueueListSnapshot(app, filters, options, io, observed, services.base)
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
      ...staleDraftWarnings(snapshot.staleDrafts ?? []),
      ...needsPersonWarnings(snapshot.needsPerson ?? []),
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
  if (!dryRun) await setSubmoduleBranch(root, submodule.name, resolution.branch)
  return {
    ...base,
    branch: resolution.branch,
    source: resolution.status === "fallback" ? "fallback" : "remote",
    action: dryRun ? "would-set" : "set",
    ...(resolution.status === "fallback" ? { note: resolution.note } : {}),
  }
}

/** BOTH spellings of a scoped delivery's identity — the minted change id and
 * the branch it was pushed on — because the surfaces this scope filters emit
 * rows keyed either way. A record-lane row carries the id; a DERIVED-lane row
 * is projected from a standing submit fact that predates any mint, so its only
 * identity is the branch (`factOnly`, see submitFactChangeRows). Scoping to an
 * id alone can never match — nor exclude — a branch-keyed row, which is how a
 * named delivery still rendered an unrelated branch's fact (23238). */
function scopeChangeIdentities(selected: Set<string>, pr: Change): void {
  selected.add(pr.id)
  selected.add(pr.branch)
}

function resolveQueueTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  filterPr: string | undefined,
): { bases: Set<string>; selected: Set<string>; changeFilter: string | undefined } {
  const bases = new Set<string>()
  const selected = new Set<string>()
  if (base !== undefined) bases.add(selectedBase(state, base))
  for (const selector of selectors) {
    // Both lanes, like every other selector surface: a queue scope named by a
    // derived member's id must widen to that member's base and identities, not
    // fall through to `selectedBase` and be read as a branch name.
    const pr = resolveQueueChange(state.bays, state.queues, selector)
    if (pr === undefined) bases.add(selectedBase(state, selector))
    else {
      bases.add(pr.base)
      scopeChangeIdentities(selected, pr)
    }
  }
  let canonicalFilter: string | undefined
  if (filterPr !== undefined) {
    // Same consolidation as selectedCheckPRs: one not-found message, worded by
    // the bay model, so `queue run <unknown>` reports what it searched too.
    const found = resolveQueueChange(state.bays, state.queues, filterPr) ?? requireLiveChange(state.bays, filterPr)
    canonicalFilter = found.id
    scopeChangeIdentities(selected, found)
    bases.add(found.base)
  }
  return { bases, selected, changeFilter: canonicalFilter }
}

function queueLogTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  pr: string | undefined,
): { bases: Set<string>; selected: Set<string>; changeFilter: string | undefined } {
  const target = resolveQueueTargets(state, selectors, base, pr)
  if (selectors.length === 0 && base === undefined && pr === undefined) {
    for (const item of recordChanges(state.bays)) target.bases.add(item.base)
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
  /** Restore the pre-containment refusal: abort the whole read (exit 3) on
   * the first run member `queueLogRows` cannot resolve a causal clock for,
   * instead of marking its row `unreadable` and rendering the rest. */
  strict?: boolean
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
    // C3b: both lanes, same reason as `queueStatusSnapshots` — `yrd log`
    // listed a run and omitted its own member from the `prs` beside it.
    const groupPrs = queueChanges(state.bays, state.queues).filter((pr) => group.aliases.has(pr.base))
    const groupChangeIds = new Set(groupPrs.map((pr) => pr.id))
    summaries.push({
      base: group.base,
      ...runs,
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: groupPrs.filter((pr) => target.selected.size === 0 || target.selected.has(pr.id)),
      admissionOrder: admissionOrder.filter((pr) => groupChangeIds.has(pr)),
    })
  }
  const changeStatusById = new Map<string, ChangeDeliveryState>(
    summaries.flatMap((result) => result.prs.map((pr) => [pr.id, changeDeliveryState(pr)])),
  )
  const runIds = new Set(
    summaries.flatMap((summary) => [...summary.running, ...summary.waiting, ...summary.finished].map((run) => run.id)),
  )
  const attempts = (await queueAttempts(services)).filter((attempt) => runIds.has(attempt.run))
  const revisionReads = queueRunRevisionReads(
    recordChanges(state.bays),
    summaries.flatMap((summary) => summary.finished),
  )
  const projectedRows = queueLogRows(
    summaries,
    target.selected,
    target.changeFilter,
    changeStatusById,
    attempts,
    new Map(),
    revisionReads.clocks,
    // --strict drops fault accounting entirely, which restores the historical
    // loud abort in queueLogRows for every member it cannot resolve — the
    // same "no accounting" path reader-unreadable-member-gate.test.ts pins.
    options.strict === true ? undefined : revisionReads.faults,
  )
  const filteredRows = filterQueueLogRows(projectedRows, options, io.now?.() ?? Date.now())
  const revisionSubjects = await resolveQueueLogSubjects(filteredRows, io)
  const rows = filteredRows.map((row) => {
    const subject = revisionSubjects.get(row.headSha)
    return subject === undefined ? row : { ...row, subject }
  })
  const coverage = await queueLegacyCoverage(io.cwd ?? process.cwd(), () => firstEventTimestamp(app))
  // From the whole read, not from `rows`: --since/--limit/--pr can filter the
  // unreadable member out of the display, and a caller who is not told believes
  // the history is whole (@i/10-yrd/23228). Unioned with projectedRows' own
  // marks: queueLogRows can contain a member queueRunRevisionReads itself
  // never flagged — its recordIds is this result's whole `prs` population
  // (record lane plus derived in production), wider than the record-only join
  // queueRunRevisionReads did, so a still-live derived member can defeat its
  // derived-member tolerance and only surface as a fault inside queueLogRows'
  // own per-row derivation (measured live 2026-09-01: run 'R3578' change
  // 'PR2131'). That fault exists only on the row queueLogRows built for it.
  const knownFaults = new Set(revisionReads.faults.values())
  const readFaults = [
    ...revisionReads.faults.values(),
    ...projectedRows.flatMap((row) =>
      row.unreadable === undefined || knownFaults.has(row.unreadable) ? [] : [row.unreadable],
    ),
  ]
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
      ...(readFaults.length === 0 ? {} : { unreadable: readFaults }),
    },
    createElement(QueueLogView, { rows, coverage, readFaults, columns: Math.min(io.columns ?? 120, 120) }),
  )
}

/** The one finding the run gate acts on: this process's installed plan is not
 * the plan the base tip declares (23192 leg c). */
export type InstalledPlanStaleFinding = Readonly<{ code: "installed-plan-stale"; message: string }>

/** Refuse to start queue Runs from a process whose installed step set is not
 * the plan the base tip declares — read from git, never from a written file.
 *
 * A Run reads WHICH steps run from git at its own base sha and refuses a step
 * it cannot execute (`declared-step-not-installed`), so correctness does not
 * depend on this gate. What the gate buys is the remedy: a habitant that
 * discovers the gap here, before composing a candidate, reloads itself in
 * place and continues, instead of refusing every candidate it prepares until
 * someone restarts it by hand. A one-shot refuses loudly; it has no next cycle
 * to reload into. Only the installed leg is read (`recordedRuns: 0`): the
 * journal walk is `queue audit`'s job, and a stale record is not something a
 * restart fixes. */
export async function requireInstalledDeclaredPlan(
  services: YrdCliServices,
  options: Readonly<{
    reloadInPlace?: Readonly<{
      /** Unwind the habitant completely, then replace this process image.
       * `reloads` is the consecutive count the replacement starts from. */
      request?: (finding: InstalledPlanStaleFinding, reloads: number) => never
      /** This process's place in its reload lineage (inherited from the exec
       * env). A clean pass resets it; a stale pass past the bound refuses
       * instead of requesting another reload. Absent counts as a fresh
       * lineage, which is what an embedded host without an exec path is. */
      lineage?: RuntimeReloadLineage
    }>
  }> = {},
): Promise<void> {
  const administration = services.queue
  // No queue administration is wired (embedded / no-administration host): an
  // app built from a hand-supplied config has no git authority to compare
  // against, and its Runs keep the installed set.
  if (administration === undefined) return
  // Administration IS wired but the audit capability is missing: the guard
  // cannot read the declared plan, so it must fail loud rather than silently
  // grant zero staleness protection.
  if (administration.auditEnvironment === undefined) {
    configuration("queue.audit capability is not installed")
  }
  const result = await administration.auditEnvironment({ recordedRuns: 0 })
  const stale = result.findings.find(
    (finding): finding is InstalledPlanStaleFinding => finding.code === "installed-plan-stale",
  )
  const reload = options.reloadInPlace
  if (stale === undefined) {
    // A pass that found nothing stale ends the chain: whatever this process
    // was exec'd to fix is fixed, and the next reload — if a later merge
    // needs one — starts counting from one again.
    if (reload?.lineage !== undefined) reload.lineage.consecutiveReloads = 0
    return
  }
  if (reload?.request !== undefined) {
    const consecutive = reload.lineage?.consecutiveReloads ?? 0
    if (consecutive >= MAX_CONSECUTIVE_RUNTIME_RELOADS) {
      const { tip } = result.comparison
      raiseFailure(
        "refusal",
        "installed-plan-reload-exhausted",
        `yrd: this process was exec'd in place ${String(consecutive)} times in a row ` +
          `(${YRD_RUNTIME_RELOADS_ENV}=${String(consecutive)}) and its installed plan is still not the one ` +
          `${result.comparison.base} tip ${tip.sha.slice(0, 8)} (config blob ${tip.configBlobSha?.slice(0, 8) ?? "none"}) ` +
          `declares: ${stale.message.replace(/^yrd:\s*/u, "")} A ${ordinal(consecutive + 1)} reload would loop ` +
          "forever — either this source cannot build the declared steps, or the tip keeps moving under the reload. " +
          "Fix the config or the source, then restart the habitant by hand; a clean cycle resets the count.",
      )
    }
    reload.request(stale, consecutive + 1)
  }
  // `cause` carries the comparison this finding was read from, never surfaced
  // by `failureFact` (which only sees kind/code/message) but readable off the
  // thrown Error by a caller that already knows this refusal's shape — the
  // habitant follow loop, so it can name the stale steps and the tip's
  // revision in its designed-exit notice without a second audit read.
  throw createFailure({ kind: "refusal", code: stale.code, message: stale.message }, result.comparison)
}

function ordinal(count: number): string {
  const suffix = count % 100 >= 11 && count % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][count % 10] ?? "th")
  return `${String(count)}${suffix}`
}

class YrdRuntimeReloadRequest extends Error {
  override readonly name = "YrdRuntimeReloadRequest"

  constructor(
    readonly finding: InstalledPlanStaleFinding,
    /** Consecutive reload the replacement process starts from (≥ 1); the host
     * writes it into the exec env so the replacement can count too. */
    readonly reloads: number,
  ) {
    super(finding.message)
  }
}

/** Typed control transfer: unwind the habitant heartbeat before the process
 * host closes leases/resources and performs the same-PID exec. */
export function requestYrdRuntimeReload(finding: InstalledPlanStaleFinding, reloads: number): never {
  throw new YrdRuntimeReloadRequest(finding, reloads)
}

/** The env the replacement process is exec'd with for one reload request. */
export function runtimeReloadEnv(env: NodeJS.ProcessEnv, request: YrdRuntimeReloadRequest): NodeJS.ProcessEnv {
  return withRuntimeReloads(env, request.reloads)
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
  const report = await queueAuditReport(app, services, now)
  const result = {
    findings: report.findings.map((finding) => ({ ...finding, ...actionableFailure(finding) })),
    ...(report.comparison === undefined ? {} : { comparison: report.comparison }),
  }
  const denominator = queueAuditComparisonLine(report.comparison)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.audit", ...result },
    result.findings.length === 0
      ? `queue audit clean\n${denominator}`
      : `${result.findings.map((finding) => formatActionableFailure(finding)).join("\n\n")}\n\n${denominator}`,
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
    async text(repo, args) {
      return (await runQueueGit(process, repo, args)).trim()
    },
    async optionalText(repo, args) {
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
const STRANDED_TTL_MS = 10 * 60 * 1000
const STRANDED_AGE_BOUND_MS = 24 * 60 * 60 * 1000

/** How often the habitant recomputes the sweep. It costs seconds, so it cannot
 * ride the heartbeat; stranded work is a minutes-to-hours concern, not a
 * per-tick one. */
const STRANDED_SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * The habitant's stranded-refs sweeper.
 *
 * The heartbeat writer is synchronous and the sweep is seconds of git I/O, so
 * this keeps the last OBSERVATION and refreshes it out of band. `observe()`
 * never blocks a tick and never invents a value: before the first sweep merges
 * it returns undefined, which the rail renders as an honest "no observation
 * yet" rather than 0.
 *
 * A failing sweep is deliberately NOT swallowed into a fresh-looking number —
 * the previous observation keeps its original observedAt, so a sweeper that has
 * been broken for an hour renders "as of 1h ago" and the staleness is the
 * signal. The failure is logged as well, because a rail that only degrades
 * quietly still needs someone to know why.
 */
function createStrandedSweeper(
  app: YrdCliApp,
  io: YrdCliIO,
  base: string,
  log: Pick<YrdCliApp["log"], "warn" | "error">,
): Readonly<{ observe: () => StrandedObservation | undefined }> {
  const cwd = io.repositoryRoot ?? io.cwd ?? globalThis.process.cwd()
  let latest: StrandedObservation | undefined
  let inFlight = false
  let lastAttemptMs = 0

  const refresh = async (startedMs: number): Promise<void> => {
    await using sweepProcess = createProcess()
    const result = await sweepStrandedRefs(sweepGit(sweepProcess), {
      repo: cwd,
      base,
      namespace: "refs/remotes/origin",
      authoredOnly: true,
      carriedBranches: carriedBranches(stateOf(app).bays, stateOf(app).queues),
      // Declared empty, never omitted — the disposition store is host-evaluated
      // after this sweep (applyHostFindingFilter). retiredRefs cannot carry it.
      retiredRefs: new Set<string>(),
      nowMs: startedMs,
      ttlMs: STRANDED_TTL_MS,
      ageBoundMs: STRANDED_AGE_BOUND_MS,
    })
    const filtered = applyHostFindingFilter(result.findings, io.filterStrandedFindings)
    latest = strandedObservation({
      count: filtered.findings.length,
      scanned: result.scanned,
      missingUpdateClocks: result.missingUpdateClocks,
      // The sweep reports its own measurable population now — this used to be
      // re-added here AND in the `queue uncarried` command, two copies of one
      // sum that only had to disagree once.
      measurable: result.measurable,
      // Stamped when the sweep STARTED. Stamping on completion would make a
      // slow sweep look fresher than the facts it read.
      observedAt: new Date(startedMs).toISOString(),
    })
  }

  return {
    observe: () => {
      const nowMs = new Date(io.now?.() ?? Date.now()).getTime()
      if (!inFlight && nowMs - lastAttemptMs >= STRANDED_SWEEP_INTERVAL_MS) {
        lastAttemptMs = nowMs
        inFlight = true
        void refresh(nowMs)
          .catch((error: unknown) => {
            log.warn?.("stranded-refs sweep failed; the rail will show its previous observation aging", { error })
          })
          .finally(() => {
            inFlight = false
          })
      }
      return latest
    },
  }
}

async function queueStranded(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string; namespace?: string }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const cwd = io.cwd ?? globalThis.process.cwd()
  const base = options.base ?? "main"
  // A branch is carried if any change names it — either lane, including
  // terminal records, plus a submission standing at the door: a withdrawn
  // change is work someone already decided about, and a derived-lane change
  // or an unadmitted submit is work the queue is actively holding.
  const carried = carriedBranches(stateOf(app).bays, stateOf(app).queues)
  await using process = createProcess()
  const result = await sweepStrandedRefs(sweepGit(process), {
    repo: cwd,
    base,
    namespace: options.namespace ?? "refs/remotes/origin",
    authoredOnly: options.namespace === undefined,
    carriedBranches: carried,
    // retiredRefs stays empty: the disposition store is host-evaluated after
    // this sweep. Feeding it through retiredRefs would print "retired" for a
    // ref held to a date by a named verdict (@i/10-merge-queue/23150).
    retiredRefs: new Set<string>(),
    nowMs: new Date(io.now?.() ?? Date.now()).getTime(),
    ttlMs: STRANDED_TTL_MS,
    ageBoundMs: STRANDED_AGE_BOUND_MS,
  })
  const filtered = applyHostFindingFilter(result.findings, io.filterStrandedFindings)
  const findings = filtered.findings

  // The counts print on BOTH paths, not just the empty one. "no stranded refs"
  // alone cannot be told apart from a sweep that looked at nothing, and this
  // rail's whole job is to be believable when it reads zero.
  // Built by the shared helper, never inline: the identity this line exists to
  // let a reader check is only enforceable if one function owns every term.
  const denominator = strandedDenominator({
    scanned: result.scanned,
    carried: result.carried,
    exempt: result.exempted.length,
    superseded: result.superseded,
    outsideAgeBound: result.outsideAgeBound,
    examined: result.examined,
    missingUpdateClocks: result.missingUpdateClocks,
    unenumerable: result.skipped.length,
  })
  // The same sentence the rail shows, from the same function: a reader must not
  // have to work out from the raw ledger that the count is a floor.
  const floor = strandedCoverageFloor(result.measurable, result.missingUpdateClocks, result.skipped.length)
  // The findings count is bounded by the SAME helper the rail uses. It used to
  // print bare, so the command contradicted the rail's own reasoning about the
  // very number it was reporting — and a bare "0 stranded refs" from a 15%
  // reading is the exact "clean fleet" claim the floor exists to refuse.
  const bounded = strandedFloorCount(findings.length, result.missingUpdateClocks, result.skipped.length)
  const exemptionBlock = filtered.exemptionLines.length === 0 ? [] : [...filtered.exemptionLines, ""]
  const lines = findings.map((finding) => `${finding.ref}  ${finding.message}`)
  // Named on BOTH paths, including the "nothing found" one — that is the path
  // where an unreported skip does its damage, because there is no finding on
  // screen to make a reader wonder what else was there.
  const skippedLines = result.skipped.map((row) => `SKIPPED  ${row.ref}  ${row.tipSha}  ${row.reason}`)
  const skippedBlock = skippedLines.length === 0 ? [] : [...skippedLines, ""]
  await printResult(
    io,
    jsonEnabled(options),
    // `floor`/`bounded` ride the MACHINE payload too. They were computed one
    // line above and spent only on the human branch, so a `--json` consumer got
    // a bare `findings` array and had to rediscover from the raw ledger that the
    // count is a floor — the same misreading the human branch already refuses
    // (@i/10-merge-queue/22925-watch-shows-every-pr).
    { command: "queue.uncarried", ...result, findings, exemptionLines: filtered.exemptionLines, floor, bounded },
    // The baseline is named on BOTH paths: a count judged against a stale
    // local base once over-reported 2.2x, and the only way a reader can rule
    // that out is seeing which yardstick produced the numbers
    // (@i/10-merge-queue/uncarried-stale-base).
    findings.length === 0
      ? [
          ...exemptionBlock,
          ...skippedBlock,
          `${bounded} stranded refs (${floor}) — ${denominator} · judged against ${result.baseline}`,
        ].join("\n")
      : [
          ...exemptionBlock,
          ...lines,
          "",
          ...skippedBlock,
          `${bounded} findings (${floor})`,
          `${denominator} · judged against ${result.baseline}`,
        ].join("\n"),
  )
  return findings.length === 0 ? 0 : 1
}

/**
 * The root Candidate ref sweep, as an operator command.
 *
 * Read-only unless `--prune` is passed, and even then it deletes only what the
 * SAME inventory pass just proved reclaimable: a journaled Candidate owns the
 * ref, no live Run names it, the retention window has passed, and the ref still
 * resolves to the SHA the sweep read. Anything unknown, unclaimed or unclocked is
 * reported and kept — `/hh/docs/design/yrd.md` states that retaining beats guessing here,
 * because this namespace is the only evidence a merged composition ever existed.
 */
/** The one candidate-ref actuator left (5e cut 7): `yrd admin candidate-refs
 * prune`. Inventory lives in `yrd doctor` (candidateRefDoctorFinding); this
 * command sweeps the namespace and deletes exactly the refs that same pass
 * proved reclaimable. Unclaimed and live refs are always retained. */
async function adminPruneCandidateRefs(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ retentionDays?: string }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const cwd = io.repositoryRoot ?? io.cwd ?? globalThis.process.cwd()
  const retentionMs =
    options.retentionDays === undefined
      ? CANDIDATE_REF_RETENTION_MS
      : Number(options.retentionDays) * 24 * 60 * 60 * 1000
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    usage(`--retention-days must be a non-negative number, not '${String(options.retentionDays)}'`)
  }
  await app.refresh()
  await using process = createProcess()
  const git = sweepGit(process)
  const result = await sweepCandidateRefs(git, {
    repo: cwd,
    queues: stateOf(app).queues,
    nowMs: new Date(io.now?.() ?? Date.now()).getTime(),
    retentionMs,
  })

  const reclaimable = result.findings.filter((finding) => finding.disposition === "reclaimable")
  const pruned = await pruneCandidateRefs(git, { repo: cwd, findings: result.findings })
  const deleted = pruned.deleted
  const kept = pruned.kept

  const denominator = candidateRefDenominator(result)
  const headline = `deleted ${String(deleted.length)} of ${String(reclaimable.length)} reclaimable Candidate refs`
  const lines = result.findings.map((finding) => `${finding.ref}  ${finding.disposition}  ${finding.message}`)
  const keptLines = kept.map((entry) => `${entry.ref}  retained: ${entry.reason}`)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "admin.candidate-refs.prune",
      ...result,
      retentionMs,
      deleted,
      kept,
    },
    [...lines, ...keptLines, ...(lines.length === 0 && keptLines.length === 0 ? [] : [""]), headline, denominator].join(
      "\n",
    ),
  )
  return 0
}

/** Why one repository-proven merge did not become a journal index row.
 *
 * `already-indexed` and `intent-carrier` are the two that describe a healthy estate: the row is
 * there, or the merge was never a change and has no `pr/integrated` row to rebuild. Every other
 * reason is a gap the operator still owns. */
type IndexRebuildSkip = Readonly<{
  pr: string
  revision: number
  run: string
  reason:
    | "already-indexed"
    | "intent-carrier"
    | "pr-unknown"
    | "legacy-no-change-id"
    | "revision-superseded"
    | "unverifiable"
  detail: string
}>

/** Skips that leave nothing for the operator to do. */
const HEALTHY_SKIP_REASONS: ReadonlySet<IndexRebuildSkip["reason"]> = new Set<IndexRebuildSkip["reason"]>([
  "already-indexed",
  "intent-carrier",
])

type IndexRebuildReport = Readonly<{
  ref: string
  // `knownPrs` is the journal's OWN count, independent of what the repo scan found — the fact
  // that distinguishes "the journal is missing a few index rows" from "the journal has been
  // wiped and holds no PR entities at all," which the per-record `pr-unknown` skips below cannot
  // say on their own: each one only knows about its own PR.
  scanned: Readonly<{ records: number; merged: number; changes: number; knownPrs: number }>
  rebuilt: readonly Readonly<{ pr: string; revision: number; run: string; commit: string }>[]
  skipped: readonly IndexRebuildSkip[]
  /** Listed notes the bulk scan could not verify at all — they never became a change to consider. */
  unverifiable: readonly UnverifiableMergeRecord[]
}>

type JournalPR = NonNullable<ReturnType<YrdCliApp["bays"]["pr"]>>
type MergeRepairInput = Parameters<YrdCliApp["queue"]["reconcileMerge"]>[0]

type MergeRepair =
  | Readonly<{ status: "repairable"; input: MergeRepairInput }>
  | Readonly<{
      status: "already-indexed" | "legacy-no-change-id" | "revision-superseded" | "no-merged-commit"
      detail: string
    }>

/**
 * `merge.finishedAt` is `z.iso.datetime({ offset: true })`, so two records can
 * name the same instant with different offsets: `2026-08-12T20:00:00.000Z` and
 * `2026-08-12T21:30:00.000+02:00` are 30 minutes apart, and neither string order
 * nor `localeCompare` puts them in that order. Compare the instants.
 */
function mergeInstant(record: MergeRecordBody): number {
  const at = Date.parse(record.merge.finishedAt)
  if (Number.isNaN(at)) {
    configuration(`merge-record '${record.merge.id}' has an unparseable finishedAt '${record.merge.finishedAt}'`)
  }
  return at
}

/**
 * What repository truth can do for one change's index row, from one merge record.
 *
 * `yrd why <selector> --repair` and `yrd doctor --rebuild-index-from-repo` are
 * the same repair at different breadths, and had drifted into two copies of the
 * same "does this record cover the change's CURRENT revision" predicate and the same
 * eight-field `reconcileMerge` argument. Each caller still owns its own
 * reporting: the bulk path names every skip, the selector path stays quiet, and
 * only the bulk path treats a merged record with no merged commit as a refusal.
 */
function mergeRepair(record: MergeRecordBody, pr: JournalPR): MergeRepair {
  const revision = currentChangeRev(pr)
  const change = record.changes.find((entry) => entry.pr === pr.id)
  if (change?.changeId === undefined) {
    return { status: "legacy-no-change-id", detail: "record predates stable Change-Id identity" }
  }
  if (
    change.revision !== revision.n ||
    change.submittedHead !== revision.head ||
    change.changeId !== revision.changeId
  ) {
    return {
      status: "revision-superseded",
      detail: `record covers revision ${String(change.revision)} at ${change.submittedHead}; journal is at revision ${String(revision.n)} at ${revision.head}`,
    }
  }
  const commit = record.merge.mergedCommit
  if (commit === undefined) {
    return {
      status: "no-merged-commit",
      detail: `merge-record '${record.merge.id}' reports a merged result with no merged commit`,
    }
  }
  if (
    changeDeliveryState(pr) === "integrated" &&
    pr.terminalRun === record.merge.id &&
    pr.integration?.commit === commit
  ) {
    return { status: "already-indexed", detail: `pr/integrated already records ${record.merge.id} at ${commit}` }
  }
  return {
    status: "repairable",
    input: {
      pr: change.pr,
      revision: change.revision,
      headSha: change.submittedHead,
      run: record.merge.id,
      commit,
      landingSha: commit,
      baseSha: commit,
      changeId: change.changeId,
    },
  }
}

/** Rebuild every missing `pr/integrated` index row from repository truth alone.
 *
 * The bulk sibling of `yrd why <selector> --repair`, with the same per-change predicate: a row is
 * only written when the record's change matches the change's current revision exactly. Repo truth
 * cannot recreate a change that the journal has never seen — a merge record proves a merge, not a
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
  // The journal's own count, read once, up front — independent of anything the repo scan below
  // finds. It is the fact that tells a `pr-unknown` skip apart from a wiped journal: one skip says
  // "this change", `knownPrs === 0` says "no PR at all, and every skip below is that same fact."
  const knownPrs = recordChangeCount(stateOf(app).bays)

  // One PR can appear in several attempts; only its latest merged attempt describes the merge.
  const latest = new Map<string, Readonly<{ record: MergeRecordBody; change: MergeRecordBody["changes"][number] }>>()
  let changes = 0
  for (const entry of merged) {
    for (const change of entry.record.changes) {
      changes += 1
      const known = latest.get(change.pr)
      if (known !== undefined && mergeInstant(known.record) >= mergeInstant(entry.record)) continue
      latest.set(change.pr, { record: entry.record, change })
    }
  }

  // A merged pin intent is not a change and never had a `pr/integrated` row: `mergeRecordBody` fills
  // `changes[].pr` from the queue MEMBER's own id, and that field is `QueueMemberIdSchema` — a
  // union whose arms are pinned to the shapes their mints write, so the record itself says which
  // kind of member merged. Asking the journal for a change under an intent id can only ever answer
  // "unknown", which is why most of this repository's merges reported a change gap that was never a
  // PR — 58 of the 115 merged records under the live merge-record ref carry an intent id
  // (`I102`…`yrdpin#181`), 57 a change id, none anything else (read 2026-08-14). The intent RAIL that
  // once held those records as `app.intents` is retired (2026-08-18) — there is no live lookup
  // left to name which submodule a given intent id advanced — but the id SHAPE alone is still
  // sufficient: any id this schema accepts is a pin-intent merge by construction (the mint that
  // wrote it never wrote anything else), so it never carries a `pr/integrated` row and is never a
  // gap.
  const rebuilt: { pr: string; revision: number; run: string; commit: string }[] = []
  const skipped: IndexRebuildSkip[] = []
  for (const [prId, { record, change }] of latest) {
    const run = record.merge.id
    const skip = (reason: IndexRebuildSkip["reason"], detail: string): void => {
      skipped.push({ pr: prId, revision: change.revision, run, reason, detail })
    }
    // One record's contradictions belong to that record. A recovery scan that dies on the first
    // one hides every merge behind it, and the estate it runs on is damaged by definition.
    try {
      if (IntentRecordIdSchema.safeParse(prId).success) {
        skip("intent-carrier", `queue member is a min-commit change '${prId}'; its merge carries no pr/integrated row`)
        continue
      }
      const pr = app.bays.pr(prId)
      if (pr === undefined) {
        skip("pr-unknown", "no PR in the journal; a merge record proves a merge, not a change's existence")
        continue
      }
      const repair = mergeRepair(record, pr)
      if (repair.status === "no-merged-commit") refusal(repair.detail)
      if (repair.status !== "repairable") {
        skip(repair.status, repair.detail)
        continue
      }
      await app.queue.reconcileMerge(repair.input)
      rebuilt.push({ pr: prId, revision: change.revision, run, commit: repair.input.commit })
    } catch (cause) {
      skip("unverifiable", cause instanceof Error ? cause.message : String(cause))
    }
  }
  return {
    ref: MERGE_RECORD_REF,
    scanned: { records: records.length, merged: merged.length, changes, knownPrs },
    rebuilt,
    skipped,
    unverifiable: proof.status === "proven" ? proof.unverifiable : [],
  }
}

/**
 * The estate repair, said plainly and BY CAUSE.
 *
 * One undifferentiated count would repeat the mistake this whole bead is about:
 * the estate holds more than one producer class, and an operator deciding whether
 * to apply needs to see which. Listing without `--apply` is the default because a
 * retraction is permanent history, even though it edits nothing.
 */
function estateRepairLines(report: MergeRecordEstateRepair, applied: boolean): readonly string[] {
  if (report.planned.length === 0) {
    return [
      `merge-record estate: ${String(report.proven)} proven, ${String(report.alreadyRetracted)} already retracted, ` +
        "nothing left to retract",
    ]
  }
  const byCause = new Map<string, number>()
  for (const plan of report.planned) byCause.set(plan.classification, (byCause.get(plan.classification) ?? 0) + 1)
  const causes = [...byCause.entries()].map(([cause, count]) => `${cause}=${String(count)}`).join(" ")
  return [
    `merge-record estate: ${String(report.proven)} proven, ${String(report.alreadyRetracted)} already retracted, ` +
      `${String(report.planned.length)} UNPROVABLE (${causes})`,
    ...report.planned.map(
      (plan) => `  ${applied ? "RETRACTED" : "would retract"} ${plan.merge ?? "<unnamed record>"} note ${plan.note}`,
    ),
    ...report.planned.map((plan) => `    ${plan.reason}`),
    ...(applied
      ? [`  appended ${String(report.applied.length)} retraction(s); the retracted records are unchanged`]
      : ["  re-run with --apply to append these retractions"]),
  ]
}

function indexRebuildLines(report: IndexRebuildReport): readonly string[] {
  const { records, merged, changes, knownPrs } = report.scanned
  const considered = report.rebuilt.length + report.skipped.length
  const unverified = report.unverifiable.length
  // `knownPrs === 0` with at least one `pr-unknown` skip is not "this run found a gap or two" —
  // it is every candidate merge hitting the SAME wall, because there is no PR entity anywhere
  // in the journal to attach an index row to. Say that once, at the top, before the per-record
  // detail repeats it N times: the flag repairs a known PR's missing index row, it does not
  // reconstruct a change entity the journal has never seen (Remnant 2, @yrd/core/doctor-rebuild-hardening).
  const journalEmpty = knownPrs === 0 && report.skipped.some((entry) => entry.reason === "pr-unknown")
  const lines = [
    ...(journalEmpty
      ? [
          "the journal holds zero PR entities — every pr-unknown skip below repeats that one fact",
          "--rebuild-index-from-repo repairs a KNOWN PR's missing index row; it cannot recreate a change",
          "entity the journal has never seen (see @yrd/core/doctor-rebuild-hardening Remnant 2)",
        ]
      : []),
    `scanned ${String(records)} merge record${records === 1 ? "" : "s"} under ${report.ref} — ${String(merged)} merged, ${String(changes)} change${changes === 1 ? "" : "s"}` +
      // The count of notes that never became a change belongs beside the denominator they are
      // missing from, or "scanned N" reads as N verified.
      (unverified === 0
        ? ""
        : `, ${String(unverified)} record${unverified === 1 ? "" : "s"} the scan could not verify`),
    // `changes` counts every change in every merged attempt; one queue member can
    // appear in several, and only its latest merged attempt describes the merge.
    // Naming that collapse is what turns an unexplained shortfall into arithmetic
    // the reader can check: rebuilt + skipped = the distinct merges considered.
    `${String(changes)} change${changes === 1 ? " collapses" : "s collapse"} to ${String(considered)} distinct merge${considered === 1 ? "" : "s"} — rebuilt ${String(report.rebuilt.length)}, skipped ${String(report.skipped.length)}`,
  ]
  for (const entry of report.rebuilt) {
    lines.push(`  REBUILT ${entry.pr} revision ${String(entry.revision)} via ${entry.run} at ${entry.commit}`)
  }
  for (const entry of report.skipped) {
    lines.push(`  SKIPPED ${entry.pr} revision ${String(entry.revision)} ${entry.reason}: ${entry.detail}`)
  }
  for (const entry of report.unverifiable) {
    lines.push(`  UNVERIFIABLE ${entry.note} ${entry.status}: ${entry.reason}`)
  }
  return lines
}

/**
 * The Candidate-ref half of `yrd doctor`.
 *
 * This namespace had no enumerator at all, which is how it reached ~2000 refs
 * without anyone seeing it: `compactQueuesState` bounds terminal run trees to a
 * 512-root window, so a ref routinely outlives the run that explains it. That
 * makes an aged ref the normal end state rather than a defect, so this reports a
 * population and a remedy at WARNING severity — it must not fail `yrd doctor`'s
 * exit code over ordinary accumulated history.
 *
 * A sweep that cannot run reports that it could not run. It never degrades into
 * a clean-looking zero, which for a hygiene rail would be the worst of both: no
 * signal and no way to tell that there is no signal.
 */
type CandidateRefDoctorNote = Readonly<{ sweep?: CandidateRefSweepResult; warning?: string }>

async function candidateRefDoctorFinding(
  queues: DeepReadonly<QueuesState>,
  io: YrdCliIO,
): Promise<CandidateRefDoctorNote> {
  const cwd = io.repositoryRoot ?? io.cwd ?? globalThis.process.cwd()
  try {
    await using process = createProcess()
    const sweep = await sweepCandidateRefs(sweepGit(process), {
      repo: cwd,
      queues,
      nowMs: new Date(io.now?.() ?? Date.now()).getTime(),
    })
    const reclaimable = sweep.findings.filter((finding) => finding.disposition === "reclaimable").length
    const unclaimed = sweep.findings.filter((finding) => finding.disposition === "unclaimed").length
    if (reclaimable === 0 && unclaimed === 0) return { sweep }
    const parts = [
      ...(reclaimable === 0 ? [] : [`${String(reclaimable)} past the retention window`]),
      ...(unclaimed === 0 ? [] : [`${String(unclaimed)} claimed by no journaled Candidate`]),
    ]
    return {
      sweep,
      warning:
        `WARNING candidate-ref-orphans: ${parts.join(", ")} — ${candidateRefDenominator(sweep)}. ` +
        `Run 'yrd admin candidate-refs prune' to delete the reclaimable ones; this doctor report is the inventory.`,
    }
  } catch (error) {
    return {
      warning:
        `WARNING candidate-ref-sweep-unavailable: the Candidate ref namespace could not be enumerated in ` +
        `'${cwd}' (${error instanceof Error ? error.message : String(error)}); this run proves nothing about it.`,
    }
  }
}

type RetentionDoctorReport =
  | Readonly<{
      advisory: true
      status: "not-applicable"
      reason: string
      source: string
      observedAt: string
    }>
  | Readonly<{
      advisory: true
      floor: Readonly<{
        evictedThrough: number
        oldestRetainedCursor: number | null
        source: string
        observedAt: string
      }>
      writer:
        | Readonly<{
            active: false
            armed: false
            policy: "not-applicable"
            source: string
            observedAt: string
          }>
        | Readonly<{
            active: true
            armed: boolean
            policy: JournalRetentionPolicy
            pid: number
            generation: string
            source: string
            observedAt: string
          }>
      checkpoint:
        | Readonly<{
            status: "not-required"
            source: string
            observedAt: string
          }>
        | Readonly<{
            status: "covering"
            identity: string
            cursor: number
            cursorHeadroom: number
            source: string
            observedAt: string
          }>
    }>

function doctorObservationTime(io: YrdCliIO): Readonly<{ nowMs: number; observedAt: string }> {
  const nowMs = io.now?.() ?? Date.now()
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    raiseFailure("infrastructure", "doctor-clock-invalid", "yrd: doctor observation clock is invalid")
  }
  return { nowMs, observedAt: new Date(nowMs).toISOString() }
}

function retentionPolicyLabel(policy: JournalRetentionPolicy): string {
  if (policy === "disabled") return "disabled"
  return `armed keepFrames=${String(policy.keepFrames)}${
    policy.keepDays === undefined ? "" : ` keepDays=${String(policy.keepDays)}`
  }`
}

function retentionDoctorLine(report: RetentionDoctorReport): string {
  if ("status" in report) {
    return `ADVISORY retention not applicable: ${report.reason} (source=${report.source}, observed=${report.observedAt})`
  }
  const oldest = report.floor.oldestRetainedCursor === null ? "none" : String(report.floor.oldestRetainedCursor)
  const writer = report.writer.active ? retentionPolicyLabel(report.writer.policy) : "inactive"
  const checkpoint =
    report.checkpoint.status === "covering"
      ? `checkpoint cursor ${String(report.checkpoint.cursor)}, cursor headroom ${String(report.checkpoint.cursorHeadroom)}`
      : "checkpoint not required"
  return (
    `ADVISORY retention: evicted-through cursor ${String(report.floor.evictedThrough)}, ` +
    `oldest retained cursor ${oldest}, writer ${writer}, ${checkpoint}`
  )
}

async function retentionDoctor(app: YrdCliApp, io: YrdCliIO): Promise<RetentionDoctorReport> {
  const { nowMs, observedAt } = doctorObservationTime(io)
  const diagnostics = app.retentionDiagnostics()
  const journal = diagnostics.journal
  if (journal === undefined) {
    return {
      advisory: true,
      status: "not-applicable",
      reason: "this Journal has no history or destructive-retention capability",
      source: "yrd-core retention diagnostics",
      observedAt,
    }
  }
  if (
    !Number.isSafeInteger(journal.evictedThrough) ||
    journal.evictedThrough < 0 ||
    (journal.oldestRetainedCursor !== null &&
      (!Number.isSafeInteger(journal.oldestRetainedCursor) ||
        journal.oldestRetainedCursor < 1 ||
        journal.oldestRetainedCursor <= journal.evictedThrough))
  ) {
    raiseFailure(
      "infrastructure",
      "journal-retention-floor-invalid",
      `yrd: retention diagnostics report eviction floor ${String(journal.evictedThrough)} and oldest retained cursor ${String(journal.oldestRetainedCursor)}`,
    )
  }

  const floorSource = io.stateDir === undefined ? "journal.sqlite" : join(io.stateDir, "journal.sqlite")
  const floor = {
    evictedThrough: journal.evictedThrough,
    oldestRetainedCursor: journal.oldestRetainedCursor,
    source: floorSource,
    observedAt,
  }
  const checkpointSource = "yrd-core current projection checkpoint"
  const checkpoint = diagnostics.checkpoint
  let checkpointReport: Extract<RetentionDoctorReport, { floor: unknown }>["checkpoint"]
  if (checkpoint === undefined) {
    if (journal.evictedThrough > 0) {
      raiseFailure(
        "infrastructure",
        "journal-recovery-coverage-unavailable",
        `yrd: ${checkpointSource} is missing while ${floorSource} says history through cursor ${String(
          journal.evictedThrough,
        )} was evicted`,
      )
    }
    checkpointReport = { status: "not-required", source: checkpointSource, observedAt }
  } else {
    const cursorHeadroom = checkpoint.cursor - journal.evictedThrough
    if (cursorHeadroom < 0) {
      raiseFailure(
        "infrastructure",
        "journal-recovery-coverage-invalid",
        `yrd: ${checkpointSource} cursor ${String(checkpoint.cursor)} is below eviction floor ${String(
          journal.evictedThrough,
        )} from ${floorSource}`,
      )
    }
    checkpointReport = {
      status: "covering",
      identity: checkpoint.identity,
      cursor: checkpoint.cursor,
      cursorHeadroom,
      source: checkpointSource,
      observedAt,
    }
  }

  const cwd = io.cwd ?? process.cwd()
  const statusSource = habitantRunnerStatusPath(cwd, io.stateDir) ?? "resident-runner/status.json"
  const lease = await habitantRunnerLeaseObservation(cwd)
  const habitant = observeHabitantRunner(await habitantRunnerStatus(cwd, io.stateDir)).runner
  if (lease.held !== (habitant !== null)) {
    raiseFailure(
      "infrastructure",
      "resident-retention-source-disagreement",
      `yrd: habitant runner lease and ${statusSource} disagree about whether a writer is active`,
    )
  }
  if (habitant === null) {
    return {
      advisory: true,
      floor,
      writer: {
        active: false,
        armed: false,
        policy: "not-applicable",
        source: `habitant runner lease + ${statusSource}`,
        observedAt,
      },
      checkpoint: checkpointReport,
    }
  }

  const ageMs = Math.max(0, nowMs - Date.parse(habitant.lastTickAt))
  if (ageMs > RUNNER_STALE_MS) {
    raiseFailure(
      "infrastructure",
      "resident-retention-observation-stale",
      `yrd: retention observation source ${statusSource} is stale by ${String(ageMs)}ms`,
    )
  }
  if (
    lease.driver === undefined ||
    habitant.driver === undefined ||
    lease.driver.queueId !== habitant.driver.queueId ||
    lease.driver.epoch !== habitant.driver.epoch
  ) {
    raiseFailure(
      "infrastructure",
      "resident-retention-source-disagreement",
      `yrd: habitant runner lease driver does not match ${statusSource}`,
    )
  }
  const retention = habitant.retention
  if (retention === undefined) {
    raiseFailure(
      "infrastructure",
      "resident-retention-observation-missing",
      `yrd: active habitant ${String(habitant.pid)} has no retention observation in ${statusSource}`,
    )
  }
  if (retention.generation !== habitant.driver.epoch || retention.observedAt !== habitant.lastTickAt) {
    raiseFailure(
      "infrastructure",
      "resident-retention-observation-mismatch",
      `yrd: retention observation in ${statusSource} does not match its habitant generation and source-read time`,
    )
  }

  return {
    advisory: true,
    floor,
    writer: {
      active: true,
      armed: retention.policy !== "disabled",
      policy: retention.policy,
      pid: habitant.pid,
      generation: retention.generation,
      source: statusSource,
      observedAt: retention.observedAt,
    },
    checkpoint: checkpointReport,
  }
}

async function configDoctor(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption &
    Readonly<{
      rebuildViews?: boolean
      rebuildIndexFromRepo?: boolean
      retractUnprovable?: boolean
      apply?: boolean
      now?: string
    }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const rebuilt =
    options.rebuildViews === true
      ? await (services.journal?.rebuildViews?.() ?? configuration("journal view rebuild capability is not installed"))
      : undefined
  // `rebuildIndexFromRepo` reads `app.bays.pr(...)` to decide what repository
  // truth can repair, and writes through `reconcileMerge`. Both need a current
  // projection: refresh before it so the read is not stale, and again after so
  // the findings below see what it repaired.
  await app.refresh()
  // Estate repair runs BEFORE the index rebuild on purpose: the rebuild reads the
  // merge-record estate, and an estate holding one unprovable record refuses every
  // read. Repairing after would rebuild from an estate that just refused.
  const estateRepair =
    options.retractUnprovable === true
      ? await (services.mergeRecords?.retractUnprovable({
          apply: options.apply === true,
          now: options.now ?? new Date().toISOString(),
        }) ?? configuration("repository merge-record capability is not installed"))
      : undefined
  const indexRebuild = options.rebuildIndexFromRepo === true ? await rebuildIndexFromRepo(app, services) : undefined
  await app.refresh()
  const state = stateOf(app)
  const retention = await retentionDoctor(app, io)
  const candidateRefs = await candidateRefDoctorFinding(state.queues, io)
  const warnings = [
    ...submoduleTrackingWarnings(io.cwd ?? process.cwd()),
    ...(candidateRefs.warning === undefined ? [] : [candidateRefs.warning]),
  ]
  const clean = warnings.length === 0
  const doctorLine = clean
    ? rebuilt === undefined
      ? "yrd doctor clean"
      : `yrd doctor rebuilt ${String(rebuilt.views)} views at cursor ${String(rebuilt.cursor)}`
    : `yrd doctor found ${String(warnings.length)} repository warning${warnings.length === 1 ? "" : "s"}`
  await printResultWithWarnings(
    io,
    jsonEnabled(options),
    {
      command: "doctor",
      retention,
      ...(candidateRefs.sweep === undefined ? {} : { candidateRefs: candidateRefs.sweep }),
      ...(rebuilt === undefined ? {} : { rebuilt }),
      ...(indexRebuild === undefined ? {} : { indexRebuild }),
      ...(estateRepair === undefined ? {} : { estateRepair }),
    },
    [
      ...(estateRepair === undefined ? [] : estateRepairLines(estateRepair, options.apply === true)),
      ...(indexRebuild === undefined ? [] : indexRebuildLines(indexRebuild)),
      doctorLine,
      retentionDoctorLine(retention),
    ].join("\n"),
    warnings,
  )
  // A merge repo truth proves but the index still cannot carry is a real gap, not a clean run —
  // and so is a note the scan could not verify at all. A pin merge is neither: it has no
  // pr/integrated row to be missing.
  const unrebuilt =
    (indexRebuild !== undefined &&
      (indexRebuild.skipped.some((entry) => !HEALTHY_SKIP_REASONS.has(entry.reason)) ||
        indexRebuild.unverifiable.length > 0)) ||
    // Records that still cannot prove themselves are a real gap. Reporting them and
    // exiting 0 would be the same silence that let one poisoned record answer for
    // the whole estate for two days.
    (estateRepair !== undefined && estateRepair.planned.length > estateRepair.applied.length)
  // The exit code answers "is anything actually wrong", and only refusal-severity
  // findings and that unrebuilt gap are. `submoduleTrackingWarnings` fires on ANY
  // unbranched submodule, so every run inside a superproject carried at least one
  // warning and `clean` was false before doctor had looked at anything — which made
  // the exit code a constant 1 there, and made the gap above, however precisely it
  // is now computed, unobservable through it. Warnings are still printed; they just
  // no longer decide the verdict.
  return unrebuilt ? 1 : 0
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

/**
 * Every configured pre-submit guard, in declaration order, before anything
 * expensive and before the revision exists.
 *
 * Ordering is the feature. Guards run ahead of {@link runRequiredChecks} so the
 * one-spawn refusal cannot arrive after the minutes-long one, and ahead of
 * revision registration so a refusal consumes no queue slot — which is the
 * whole reason a guard is not simply another check.
 *
 * A repository with no guards configured returns immediately and spawns
 * nothing, so this costs unconfigured repositories exactly zero.
 */
async function runPreSubmitGuards(
  services: YrdCliServices,
  io: YrdCliIO,
  selected?: readonly string[],
  ref?: string,
  json = false,
): Promise<readonly YrdCliGuardOutcome[]> {
  const guards = services.guards
  if (guards === undefined) {
    // Selecting guards by name proves the caller expected the capability, so
    // its absence is a loud configuration fault rather than a quiet no-op.
    if (selected === undefined) return []
    configuration("pre-submit guard capability is not installed")
  }
  const names = selected ?? guards.names
  if (names.length === 0) return []
  // `io.cwd` is the tree the caller selected — the invoking tree, or the Bay
  // worktree `pr submit` chose for this carrier. It is what makes a bare-HEAD
  // guard judge the commit actually being submitted.
  const context = { ...(ref === undefined ? {} : { ref }), ...(io.cwd === undefined ? {} : { cwd: io.cwd }) }
  const outcomes: YrdCliGuardOutcome[] = []
  for (const name of names) {
    const outcome = await guards.run(name, Object.keys(context).length === 0 ? undefined : context)
    // fd1 is a machine stream under --json; raw guard stdout would corrupt it
    // (output.tsx protects every other path the same way).
    if (!json && outcome.stdout !== undefined && outcome.stdout !== "") io.stdout(outcome.stdout)
    outcomes.push(outcome)
  }
  return outcomes
}

/**
 * One pre-submit required check's SETTLED verdict — a check that ran to an exit
 * code, pass or fail.
 *
 * A check killed before it produced an exit code has no verdict and gets no
 * row here: reporting one would invent the very evidence D1 says must be
 * refused. That absence is raised as `required-check-infrastructure-signal`
 * instead.
 */
export type PreSubmitCheckVerdict = Readonly<{
  name: string
  status: "passed" | "failed"
  exitCode: number
  /** Present only when the check was killed by its own timeout. */
  timedOut?: true
}>

/**
 * `yrd pr submit`'s pre-submit required checks.
 *
 * `onVerdict` fires the instant each check settles and BEFORE any failure is
 * raised, which is the whole anti-erasure contract: a check that ran cannot be
 * un-run by a later throw. The return value is the same list, for callers that
 * only need the all-passed case.
 *
 * Returning the verdicts alone was not enough. Measured on PR1970 (2026-08-23,
 * @i/10-merge-queue/failed-check-erased): four checks ran, `affected-tests`
 * failed, and the raise below unwound past a call site that discarded the
 * return value — erasing the failure AND the three passes that preceded it.
 * The bead asked which of the two was erased; the answer is both, and it is
 * both because the ONLY report was a value the thrower never got to return.
 *
 * So the two endings report on different surfaces, because they have different
 * survivors. A passing run returns its verdicts and the caller puts them in its
 * result envelope, leaving stderr silent as a successful command must. A
 * failing run produces no envelope at all, so its ledger rides the raised
 * MESSAGE — the one artifact an unwind carries, and the one that reaches both
 * human stderr and the single `--json` failure document without becoming a
 * second document that `JSON.parse(stderr)` would choke on.
 *
 * `carrier` defaults to TRUE — the strict reading — so a run has to DECLARE
 * that it is not gating a carrier to get the permissive one. A new caller that
 * forgets the argument gets the refusal, not a vacuous verdict over an empty
 * range; the opposite default would make the silent answer the one you get by
 * saying nothing. `yrd check` is the only declared exception.
 */
async function runRequiredChecks(
  services: YrdCliServices,
  io: YrdCliIO,
  selected?: readonly string[],
  ref?: string,
  keepOnFailure = false,
  json = false,
  carrier = true,
): Promise<readonly PreSubmitCheckVerdict[]> {
  const checks = services.checks
  if (checks === undefined) configuration("required-check capability is not installed")
  const names = selected ?? checks.names
  if (names.length === 0) return []
  await checks.install(io.cwd ?? process.cwd())
  const results: PreSubmitCheckVerdict[] = []
  for (const name of names) {
    const context = {
      ...(ref === undefined ? {} : { ref }),
      ...(keepOnFailure ? { keepOnFailure: true } : {}),
      ...(carrier ? { carrier: true } : {}),
    }
    const result = await checks.run(name, io.cwd ?? process.cwd(), context)
    if (result.signal === "SIGKILL" || (result.signal === null && result.exitCode === 137)) {
      const retained =
        result.retainedWorkspace === undefined ? "" : `; ${retainedWorkspaceNote(result.retainedWorkspace)}`
      raiseFailure(
        "infrastructure",
        "required-check-infrastructure-signal",
        `yrd: required check infrastructure failed: '${name}' ended by SIGKILL (exit ${result.exitCode}) before it produced a verdict${retained}${requiredCheckLedger(results)}`,
      )
    }
    const failed = result.exitCode !== 0 || result.timedOut
    results.push({
      name,
      status: failed ? "failed" : "passed",
      exitCode: result.exitCode,
      ...(result.timedOut ? { timedOut: true as const } : {}),
    })
    if (failed) {
      const outcome = result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`
      const checkDiagnostic = result.stderr.trim()
      const diagnostic = checkDiagnostic === "" ? "" : `; check stderr: ${checkDiagnostic}`
      const retained =
        result.retainedWorkspace === undefined ? "" : `; ${retainedWorkspaceNote(result.retainedWorkspace)}`
      raiseFailure(
        "refusal",
        "required-check-failed",
        `yrd: required check failed: '${name}' ${outcome}${diagnostic}${retained}${requiredCheckLedger(results)}`,
      )
    }
    // Replay the child's buffered output only AFTER the verdict tests above:
    // a failing check's entire stdout used to replay to fd1 before the exit
    // code was even read, burying the raised diagnostic under check noise —
    // and raw child stdout must never reach a --json stream at all
    // (output.tsx protects every other path the same way). The failure
    // diagnostic already carries the check's trimmed stderr.
    if (!json && result.stdout !== "") io.stdout(result.stdout)
    if (result.stderr !== "") io.stderr(result.stderr)
  }
  return results
}

/**
 * The clause that makes a FAILED required-check run readable after the fact,
 * appended to the raised message — the one artifact that survives the unwind.
 *
 * It names the checks that already PASSED as well as the one that failed,
 * because a failing gate erased both by the same mechanism and "which gates
 * actually ran" is the question every audit of PR1970 had to answer from one
 * agent's `/tmp` scratch file.
 *
 * A single-row ledger restates what the message already said, and it is kept
 * anyway. On the SIGKILL path the killed check produced NO verdict and appears
 * nowhere in this list, so the one row is a prior pass and the only record of
 * it — and this bead is the standing evidence that a redundant line costs less
 * than an omitted one.
 */
export function requiredCheckLedger(verdicts: readonly PreSubmitCheckVerdict[]): string {
  if (verdicts.length === 0) return ""
  const rows = verdicts
    .map((verdict) =>
      verdict.status === "passed"
        ? `${verdict.name} passed`
        : `${verdict.name} FAILED (${verdict.timedOut === true ? "timed out" : `exit ${String(verdict.exitCode)}`})`,
    )
    .join(", ")
  return `; required checks run: ${rows}`
}

/**
 * `yrd guard [names...]` — the same guards submit runs, on demand.
 *
 * The managed pre-submit hook shells out to exactly this, so what a seat can
 * reproduce by hand and what the hook enforces cannot drift into two different
 * rules. Bare `yrd guard` runs every configured guard; naming one runs only it.
 */
async function guardRequired(
  services: YrdCliServices,
  names: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const guards = await runPreSubmitGuards(
    services,
    io,
    names.length === 0 ? undefined : names,
    undefined,
    jsonEnabled(options),
  )
  const ran = guards.filter((guard) => guard.status === "passed")
  const skipped = guards.filter((guard) => guard.status === "skipped")
  await printResult(
    io,
    jsonEnabled(options),
    { command: "guard", guards },
    guards.length === 0
      ? "no pre-submit guards are configured"
      : `pre-submit guards passed: ${ran.map(({ name }) => name).join(", ") || "none"}` +
          (skipped.length === 0 ? "" : `; skipped: ${skipped.map(({ name }) => name).join(", ")}`),
  )
}

async function checkRequired(
  services: YrdCliServices,
  names: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  if (names.length === 0) usage("check requires at least one configured check name")
  // The envelope below reports the verdicts only when every check passed; the
  // ledger inside reports them on the failing path too, where the passes that
  // preceded the failure used to vanish with the throw.
  // Not a carrier gate: `yrd check` runs the named check against whatever tree
  // it was pointed at, including one sitting exactly on the base. Submit and
  // ready judge something that has to carry a change and refuse a candidate
  // that adds nothing; this reading has no carrier to be empty.
  const checks = await runRequiredChecks(services, io, names, undefined, false, jsonEnabled(options), false)
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

/** `yrd admin queue init|deinit` are RETIRED, and say so rather than doing
 * nothing. Their one durable effect was writing and removing
 * `installed-baseline.json`, the stored copy of the declared plan that
 * `queue audit` and the run gate compared against. That file is gone
 * (23192, 23193): every Run reads its plan from git at its own base sha, and
 * the audit compares git against the recorded Runs and this process directly.
 * A queue therefore needs no installation step, and a verb that printed
 * "initialized" without installing anything would be the silent no-op the
 * baseline itself turned out to be. The hook `init` also installed has its
 * own command. */
/** Retired verb (5e cut 6): restart re-derives what `queue recover` did.
 *
 * The standing rails: a fresh runner's startup reclaim settles its dead
 * predecessor's leases (pid-scoped), the habitant's per-tick sweep settles any
 * lease that has lapsed (D1b), and an interrupted one-shot runner settles its
 * own runs on the signal path. The one remainder restart cannot re-derive is
 * the operator assertion `--runner <id>` carried — force-settling a known-dead
 * runner's UNEXPIRED leases without waiting them out. That case now waits for
 * lease expiry; it belongs to `yrd doctor` as a finding (a fresh lease whose
 * runner pid is gone), not to a verb — the doctor fold is a separate carrier.
 */
/** Retired verb (5e cut 7): the Candidate-ref namespace is ephemeral
 * post-item-2 evidence. `yrd doctor` is the inventory (it reports orphans with
 * the denominator), and `yrd admin candidate-refs prune` is the one actuator.
 */
function refuseRetiredQueueCandidateRefs(): never {
  // The retired verb is deliberately NOT quoted: a quoted `yrd ...` in a
  // failure message is lifted into its `resolution`, and the one command this
  // must never recommend is itself.
  raiseFailure(
    "refusal",
    "queue-candidate-refs-retired",
    "yrd: queue candidate-refs is retired. Run 'yrd doctor' to inventory the Candidate ref namespace and " +
      "'yrd admin candidate-refs prune' to delete the refs a sweep proves reclaimable.",
  )
}

function refuseRetiredQueueRecover(): never {
  // The retired verb is deliberately NOT quoted: a quoted `yrd ...` in a
  // failure message is lifted into its `resolution`, and the one command this
  // must never recommend is itself.
  raiseFailure(
    "refusal",
    "queue-recover-retired",
    "yrd: queue recover is retired and does nothing. Restart re-derives it: a new runner start reclaims its " +
      "dead predecessor's leases, the habitant sweep settles every expired lease each tick, and an interrupted " +
      "one-shot runner settles its own runs. A known-dead runner's unexpired leases settle when they lapse.",
  )
}

function refuseRetiredQueueAdministration(command: "init" | "deinit"): never {
  // The retired verb is deliberately NOT quoted: a quoted `yrd …` in a failure
  // message is lifted into its `resolution`, and the one command this must
  // never recommend is itself.
  raiseFailure(
    "refusal",
    "queue-administration-retired",
    `yrd: admin queue ${command} is retired and does nothing. It used to ${
      command === "init" ? "write" : "remove"
    } installed-baseline.json, the stored step plan the audit compared against; that file no longer ` +
      "exists (23192/23193): each Run reads its plan from .yrd.yml at its own base sha, and a stale habitant " +
      "reloads itself. " +
      (command === "init"
        ? "Run 'yrd admin init' to install the managed pre-submit hook, and 'yrd queue audit' to compare git " +
          "against the recorded runs and this process."
        : "There is nothing to release; run 'yrd queue audit' to compare git against the recorded runs and this process."),
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
  const run = requireUnqualifiedRunSelector(resolveCanonicalRunSelector(selector, io.repositoryRoot), "finish")
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
    const checks = changeCheckRecords(app, [pr.id])
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "queue.finish",
        pr: projectChangeTaskStatusWithEligibility(pr, app.queue.eligibility(pr.id)),
        checks: checks.map(projectCheckTaskStatus),
      },
      `${pr.id} ${changeDeliveryState(pr)}`,
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

type HabitantCycleRecovery = Readonly<{
  message: string
  props: Record<string, unknown>
  busy?: Readonly<{ base: string; run: string }>
}>

type HabitantBusyWindow = Readonly<{ base: string; run: string; suppressed: number }>

/**
 * Keep one loud warning for a busy queue, then count exact repeats until the
 * queue frees (or the habitant exits). Other recoveries stay one-for-one and
 * flush any pending busy summary before their own warning.
 */
function createHabitantRecoveryReporter(log: YrdCliApp["log"]): Readonly<{
  report(recovery: HabitantCycleRecovery): void
  flush(): void
}> {
  let busy: HabitantBusyWindow | null = null
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
 * the queue, or a candidate change that reached a terminal status mid-compose. Each
 * returns a single structured (loggily) warn; the habitant emits no bare stderr
 * duplicate. The next cycle re-snapshots — the busy queue frees, the departed
 * PR is gone from the submitted set — so the loop makes progress on what remains.
 */
/**
 * The refusals that are about THIS PROCESS rather than about a change, and so
 * must still stop the runner.
 *
 * A DENYLIST, and the direction is the whole point. What stood here before was
 * an allowlist of the thirteen change-scoped codes that were survivable, which
 * made every refusal code absent from it a latent resident kill — and the codes
 * absent from it were, by definition, the ones nobody had met yet. Two of them
 * collected on 2026-09-01, 21 minutes apart, and each took the whole queue
 * offline under `restart: "never"`. An allowlist defaults to killing the
 * process; this defaults to surviving, which is the safe default for a class
 * whose members are discovered one production outage at a time.
 *
 * These few default the other way because a restart is their literal cure:
 * `installed-plan-stale` ends with "Restart this queue runner so it builds the
 * declared steps", and a runner whose own status or caps will not parse cannot
 * be fixed by composing again. Swallowing one would leave a runner alive and
 * permanently useless behind a green exit, which is the exact failure the
 * cli.test.ts "exits non-zero on every habitant refusal" case pins.
 *
 * The set is short, stable and enumerable because it is the runner talking
 * about itself; the per-change population is neither, which is why it is the
 * one that gets the safe default.
 */
const RUNNER_SCOPED_REFUSALS: ReadonlySet<string> = new Set([
  "installed-plan-stale",
  "installed-plan-reload-exhausted",
  "habitant-installed-plan-empty",
  "habitant-rss-cap-invalid",
  "resident-runner-status-invalid",
  "resident-source-stale-threshold-invalid",
])

function habitantCycleRecovery(error: unknown): HabitantCycleRecovery | undefined {
  if (isConcurrentSettlementConflict(error)) {
    return {
      message: "habitant runner skipped a cycle lost to a concurrent Job settlement",
      props: { action: "resident-cancel-skip", job: error.jobId, status: error.actual, reason: error.message },
    }
  }
  if (isQueueRunningConflict(error)) {
    return {
      message: "habitant runner deferred a cycle — the queue is already running",
      props: { action: "resident-busy-defer", base: error.base, run: error.runId, reason: error.message },
      busy: { base: error.base, run: error.runId },
    }
  }
  if (isConcurrentCheckabilityConflict(error)) {
    return {
      message: "habitant runner skipped a cycle — a candidate change left the checkable set mid-compose",
      props: { action: "resident-withdraw-skip", pr: error.prId, status: error.status, reason: error.message },
    }
  }
  // 22306 architectural belt: any remaining PR-scoped refusal that escaped the
  // per-candidate wrap is still a cycle skip, not a habitant death. Covers
  // authored-gitlink / recut-certificate / pr-not-admissible and the rest of
  // the needs-author + recut-lineage composition buckets if they bubble out.
  // 22584 adds spawn-cwd-missing: every spawn directory Yrd derives is candidate
  // content (bay, scratch, and reference checkouts, down to nested submodule
  // paths a candidate ADDS but the base lacks), so an absent one is per-candidate
  // by construction. The habitant's OWN root is re-proven by every other command
  // in the cycle, so a genuinely absent root keeps warning loudly each interval —
  // and the message names the absolute path, which the bare posix_spawn ENOENT
  // this replaces never did.
  const fact = failureFact(error)
  if (fact?.kind === "infrastructure" && fact.code === "journal-busy") {
    return {
      message: "habitant runner skipped a cycle because the journal was temporarily locked",
      props: { action: "resident-journal-busy-skip", code: fact.code, reason: fact.message },
    }
  }
  // EVERY typed refusal is a cycle skip, keyed on the KIND and never on a list
  // of codes.
  //
  // A refusal is by construction a decision about one change or candidate, not
  // about this process: the compose already skips them per candidate, so one
  // arriving here means a seam upstream missed it, and the worst a skip costs
  // is this cycle. What used to sit here was a hand-kept allowlist of thirteen
  // codes, which made every refusal code ABSENT from it a latent resident kill.
  // Two of them collected on 2026-09-01, 21 minutes apart, while their thirteen
  // siblings were survivable: `derived-submit-vanished` (a seat withdrew a
  // branch, 18:51:13Z) and `derived-submit-moved` (an author re-pushed one,
  // 19:12:20Z). Each took the whole queue offline under `restart: "never"`, and
  // with a fleet pushing every few minutes every later push took it offline
  // again. Adding those two codes to the list would have bought the same bug a
  // third name; keyed on the kind, the next code anyone writes is survivable
  // the day it is written.
  //
  // A JOURNAL THAT DISAGREES WITH ITSELF is what stays fatal, and this codebase
  // already spells it differently: an invariant breach raises a BARE Error —
  // derived-admission.ts's mint-collision and duplicate-payload throws are both
  // bare — which carries no FailureFact and so falls through to the `undefined`
  // below and stops the runner, exactly as fail-loud requires.
  if (fact?.kind === "refusal" && !RUNNER_SCOPED_REFUSALS.has(fact.code)) {
    return {
      message: "habitant runner skipped a cycle lost to a per-PR failure",
      props: { action: "resident-pr-refusal-skip", code: fact.code, reason: fact.message },
    }
  }
  // Infrastructure keeps the narrow allowlist. A refusal is a verdict and can
  // only repeat as long as the change does, but an unavailable RESOURCE can
  // stay unavailable forever, and this cycle-skip path never reaches the
  // poisoned-observer breaker that would otherwise recycle the process. So the
  // ones named here are the ones proven to be derived from the candidate under
  // admission, and anything else still recycles the runner.
  if (fact?.kind === "infrastructure") {
    const changeScoped =
      fact.code === "pr-not-admissible" ||
      fact.code === "pr-not-ready" ||
      fact.code === "pr-not-found" ||
      fact.code === "command-refused" ||
      fact.code === "candidate-ref-refused" ||
      fact.code === "authored-gitlink" ||
      fact.code === "composition-retired" ||
      fact.code === "wrapper-mismatch" ||
      fact.code === "payload-certificate" ||
      fact.code === "gitlink-inspection" ||
      fact.code === "refused-path" ||
      fact.code === "refused-path-inspection" ||
      fact.code === "spawn-cwd-missing"
    if (changeScoped) {
      return {
        message: "habitant runner skipped a cycle lost to a per-PR failure",
        props: { action: "resident-pr-refusal-skip", code: fact.code, reason: fact.message },
      }
    }
  }
  return undefined
}

export type HabitantTrackedRevisionTransition =
  | Readonly<{
      status: "applied"
      pr: string
      branch: string
      fromRevision: number
      fromHead: string
      sourceRevision: number
      sourceHead: string
      currentRevision: number
      verdict: RemergePreflightVerdict
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
  /** The member stopped matching and was swept to a terminal state with a stated
   * reason, rather than left to age at the head of the queue. */
  | Readonly<{
      status: "evicted"
      pr: string
      branch: string
      revision: number
      headSha: string
      code: "recut-branch-absent"
      message: string
    }>

function trackedPreflightSettlementRef(pr: Change, revision: Pick<ChangeRev, "n" | "head">): string {
  return `yrd:track-preflight-needs-person:${pr.id}:${revision.n}:${revision.head}`
}

/**
 * Sweep one candidate whose source branch origin no longer advertises to a
 * terminal state, with the refusal itself as the recorded reason.
 *
 * No human verb is required by design: the alternative — the behaviour this
 * replaces — was to defer forever behind a doubling backoff, which reads as
 * "still working on it" on every instrument while the queue head cannot move.
 * The reason travels with the withdrawal, so `pr view` and the journal both
 * answer why the change left without anyone reconstructing it.
 */
async function evictUnobservableCandidate(
  app: YrdCliApp,
  candidate: Change,
  revision: Pick<ChangeRev, "n" | "head">,
  code: "recut-branch-absent",
  message: string,
  io: YrdCliIO,
  observation: TrackedObservationBackoff | undefined,
): Promise<HabitantTrackedRevisionTransition> {
  observation?.delete(trackedObservationKey(candidate, revision))
  await withdrawOne(app, candidate.id, message, io)
  const outcome: HabitantTrackedRevisionTransition = {
    status: "evicted",
    pr: candidate.id,
    branch: candidate.branch,
    revision: revision.n,
    headSha: revision.head,
    code,
    message,
  }
  app.log.warn?.(`Evicted tracked change ${candidate.id}: its source branch is gone from origin.`, {
    action: "queue-track-branch-absent-evicted",
    ...outcome,
  })
  return outcome
}

function trackedPreflightNeedsPerson(pr: Change, revision: ChangeRev): boolean {
  const ref = trackedPreflightSettlementRef(pr, revision)
  return pr.comments.some(
    (comment) => comment.revision === revision.n && comment.headSha === revision.head && comment.ref === ref,
  )
}

/**
 * Codes `freshRemoteBranch` raises while OBSERVING one tracked change's branch, each
 * a fact about THAT branch: deleted on origin after merging (the routine `fatal:
 * couldn't find remote ref`, exit 128), a fetch that timed out, or a refreshed
 * ref that will not resolve to a commit. Observing one candidate is per-candidate
 * work, so these defer that candidate and the cycle moves on.
 *
 * Deliberately an explicit list read at the observation call rather than a test
 * on kind:"configuration" — that kind also covers real composition faults
 * (async-command, missing Git facts) which must keep stopping the runner
 * fail-loud. `recut-branch-observer-missing` stays excluded: it says no Git
 * process is installed in THIS process, so it is identical for every candidate,
 * and deferring it per-PR would dress a process-wide gap as per-branch weather.
 * {@link refreshTrackedQueueRevisions} instead detects the missing observer
 * upfront and skips its pass with one cycle-level warning — tracking is the
 * default, so an observer-less embedder reaches it with every live change, and
 * crashing the queue runner over an ambient default would be disproportionate.
 */
const TRACKED_OBSERVATION_CODES: ReadonlySet<string> = new Set([
  "recut-branch-refresh-failed",
  "recut-branch-head-missing",
])

/**
 * Process-scoped re-observation backoff, keyed by {pr, revision, head}. A branch
 * that cannot be observed is usually structural (deleted on origin and not
 * restored), and its observation is a live `git fetch` at the HEAD of the cycle —
 * a 30s timeout there stalls every other tracked change. So each consecutive failure
 * doubles the number of cycles skipped before the next attempt, capped, which
 * bounds both the wasted fetch and the log noise while still ALWAYS retrying, so
 * a restored branch resumes without an operator turn. Any new authored revision
 * is a new key and observes immediately. Mirrors the process-scoped `remedied`
 * set that `applyRefusalRemedies` owns: a claim about this process, never
 * durable state.
 */
export type TrackedObservationBackoff = Map<string, Readonly<{ failures: number; skipped: number }>>

const MAX_OBSERVATION_SKIP = 32

function trackedObservationKey(pr: Change, revision: Pick<ChangeRev, "n" | "head">): string {
  return `${pr.id}:${revision.n}:${revision.head}`
}

/**
 * Observe opted-in PR branches before the habitant's normal base-freshness
 * pass. When a branch moved, certify the exact observed SHA directly as the
 * successor revision. The frozen SHA and expected-current fact flow through
 * preflight together, so an interrupted cycle never leaves a provisional
 * authored revision behind.
 *
 * `observation` is the caller's re-observation backoff. The habitant owns one for
 * its lifetime; a one-shot or programmatic caller omits it and observes every
 * candidate exactly once, which is the whole of its cycle.
 *
 * `conditions` is the same optional, caller-owned log dedup `logQueueLivenessWedge`
 * takes — omitted, every deferral below logs unconditionally as before; the
 * habitant loop passes its one process-lifetime reporter so a candidate whose
 * PREPARATION keeps failing the same way every cycle stops re-logging an
 * identical line (distinct from `observation` above, which only backs off the
 * OBSERVATION phase's git fetch and already logs every attempt it makes).
 */
export async function refreshTrackedQueueRevisions(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
  observation?: TrackedObservationBackoff,
  conditions?: ConditionReporter,
): Promise<readonly HabitantTrackedRevisionTransition[]> {
  const candidates = recordChanges(stateOf(app).bays)
    .filter((pr) => {
      const delivery = changeDeliveryState(pr)
      return isTracked(pr) && isLiveChange(pr) && delivery !== "pushed"
    })
    .toSorted(
      (left, right) =>
        baseIdentity(left.base).localeCompare(baseIdentity(right.base)) || compareNatural(left.id, right.id),
    )
  const outcomes: HabitantTrackedRevisionTransition[] = []
  if (candidates.length > 0 && io.pruneGit === undefined && services.process === undefined) {
    // Tracking is the default, so an embedder that wires no Git observer at all
    // still reaches this pass with every live change. That gap is a fact about
    // THIS process, identical for every candidate: report it once per cycle and
    // leave the recorded revisions authoritative, instead of crashing the queue
    // runner or parking candidates one by one as if it were per-branch weather.
    app.log.warn?.(
      `Skipped tracked-branch observation for ${String(candidates.length)} candidate(s): no Git process is installed.`,
      {
        action: "queue-track-observation-unavailable",
        prs: candidates.map((candidate) => candidate.id),
      },
    )
    return outcomes
  }
  if (observation !== undefined) {
    // Drop entries for candidates that moved or left the tracked set: a new
    // authored revision must observe immediately, not inherit a skip window.
    const live = new Set(candidates.map((candidate) => trackedObservationKey(candidate, currentChangeRev(candidate))))
    for (const key of observation.keys()) {
      if (!live.has(key)) observation.delete(key)
    }
  }

  for (const candidate of candidates) {
    if (io.drainSignal?.aborted === true) break
    const before = currentChangeRev(candidate)
    const observationKey = trackedObservationKey(candidate, before)
    const backoff = observation?.get(observationKey)
    if (backoff !== undefined && backoff.skipped < Math.min(2 ** backoff.failures, MAX_OBSERVATION_SKIP)) {
      observation?.set(observationKey, { ...backoff, skipped: backoff.skipped + 1 })
      continue
    }
    let classified: RemergePreflightResult | undefined
    let freshness: RemergeBranchFreshness
    try {
      freshness = await requireImplicitRemergeBranchFreshness(candidate, before, { queue: true }, services, io)
      observation?.delete(observationKey)
    } catch (error) {
      // Containment is scoped to the OBSERVATION phase by position: only this
      // await is wrapped, so a failure anywhere after it keeps the existing
      // refusal-only absorption below.
      const failure = failureFact(error)
      if (failure?.kind === "refusal" && failure.code === "recut-branch-absent") {
        // Origin answered authoritatively that the branch is gone, so no later
        // cycle can observe it and no retry is progress. Deferring one of these
        // is what wedged the queue behind PR1189 for 40 minutes and 19 PRs: the
        // member could never recut and never land, yet the queue kept treating
        // it as an ordinary waiting row. It leaves with its reason recorded.
        outcomes.push(
          await evictUnobservableCandidate(app, candidate, before, failure.code, failure.message, io, observation),
        )
        continue
      }
      if (failure?.kind !== "configuration" || !TRACKED_OBSERVATION_CODES.has(failure.code)) throw error
      const attempts = (backoff?.failures ?? 0) + 1
      observation?.set(observationKey, { failures: attempts, skipped: 0 })
      const outcome: HabitantTrackedRevisionTransition = {
        status: "deferred",
        pr: candidate.id,
        branch: candidate.branch,
        revision: before.n,
        headSha: before.head,
        code: failure.code,
        message: failure.message,
      }
      outcomes.push(outcome)
      app.log.warn?.(
        `Could not observe tracked change ${candidate.id}'s branch; it remains queued for another cycle.`,
        {
          action: "queue-track-observation-deferred",
          attempts,
          ...outcome,
        },
      )
      continue
    }
    try {
      const interrupted = !app.bays.checksRequested(candidate.id) && !trackedPreflightNeedsPerson(candidate, before)
      if (freshness.status === "fresh" && !interrupted) continue

      const source = freshness.status === "tracked-drift" ? before : currentChangeRev(requiredPr(app, candidate.id))
      classified = await preflightRemerge(
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
        services,
      )
      await applyPreflightVerdict(app, services, classified, io, { track: true })
      const current = currentChangeRev(requiredPr(app, candidate.id))
      const outcome: HabitantTrackedRevisionTransition = {
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
      app.log.debug?.("Prepared the latest tracked change revision for the merge queue's entry checks.", {
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
          // Both codes mean "this ONE candidate's settlement did not stick", and
          // neither is a reason to lose the cycle. `review-ref-conflict` was
          // previously a bare Error, so it fell through this guard and killed
          // the runner's cycle — which starved every OTHER candidate behind it.
          const deferrable = new Set(["comment-current-changed", "review-ref-conflict"])
          if (settlementFailure?.kind !== "refusal" || !deferrable.has(settlementFailure.code)) {
            throw settlementError
          }
          const outcome: HabitantTrackedRevisionTransition = {
            status: "deferred",
            pr: candidate.id,
            branch: candidate.branch,
            revision: classifiedRevision.n,
            headSha: classifiedRevision.head,
            code: settlementFailure.code,
            message: settlementFailure.message,
          }
          outcomes.push(outcome)
          // The reason is named from the CODE rather than assumed: this handler
          // now covers two different causes, and "the change changed" is true of
          // only one of them.
          app.log.debug?.(
            settlementFailure.code === "comment-current-changed"
              ? "Skipped settling a tracked change preflight because the change changed."
              : "Skipped settling a tracked change preflight because its settlement ref already records a " +
                  "different fact; deferring this candidate so the cycle continues.",
            {
              action: "queue-track-settlement-deferred",
              ...outcome,
            },
          )
          continue
        }
        const outcome: HabitantTrackedRevisionTransition = {
          status: "needs-person",
          pr: currentPr.id,
          branch: currentPr.branch,
          revision: classifiedRevision.n,
          headSha: classifiedRevision.head,
          code: failure.code,
          message: failure.message,
        }
        outcomes.push(outcome)
        // WARN: settled `needs-person`, so it does not recur, and it is one
        // change's work item for a person — not a fault in the runner. An
        // ERROR row ends the pass (2026-09-01), which one change must not do.
        app.log.warn?.(`Tracked PR ${currentPr.id} needs an operator decision before entry checks.`, {
          action: "queue-track-needs-person",
          ...outcome,
        })
        continue
      }
      const deferredRevision =
        classified === undefined ? before : { n: classified.revision, head: classified.evidence.headSha }
      const outcome: HabitantTrackedRevisionTransition = {
        status: "deferred",
        pr: candidate.id,
        branch: candidate.branch,
        revision: deferredRevision.n,
        headSha: deferredRevision.head,
        code: failure.code,
        message: failure.message,
      }
      outcomes.push(outcome)
      const deferredMessage = `Could not prepare tracked change ${candidate.id}; it remains queued for another cycle.`
      const deferredProps = { action: "queue-track-deferred", ...outcome }
      if (conditions === undefined) {
        app.log.warn?.(deferredMessage, deferredProps)
      } else {
        conditions.report(
          `track-deferred:${trackedObservationKey(candidate, deferredRevision)}`,
          "warn",
          deferredMessage,
          deferredProps,
        )
      }
    }
  }
  return outcomes
}

type HabitantQueueFreshnessTransition =
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
 * Apply the admitted -> refreshed Queue transition before the habitant takes
 * its next run snapshot. The transition deliberately stays inside the existing
 * serialized habitant cycle: it reuses the installed recutter and journal
 * rather than starting another writer or scheduler.
 */
export async function refreshAdmittedQueueRevisions(
  app: YrdCliApp,
  services: Pick<YrdCliServices, "recut">,
  io: YrdCliIO,
): Promise<readonly HabitantQueueFreshnessTransition[]> {
  const snapshot = stateOf(app)
  const outcomes: HabitantQueueFreshnessTransition[] = []
  const interrupted = recordChanges(snapshot.bays).filter(
    (pr) => currentChangeRev(pr).recut?.transition?.to === "refreshed",
  )
  const staleRunsByPr = new Map<string, Run[]>()
  const staleRunIds = new Set<string>()
  const staleAdmissionRevisionsByChange = new Map<string, number[]>()
  const staleJobsByPr = new Map<string, string[]>()
  for (const pr of interrupted) {
    const claim = snapshot.queues.authority.claims[pr.id]
    const revision = currentChangeRev(pr)
    const staleAdmissionRevisions = pr.revs
      .map(({ n }) => n)
      .filter((candidateRevision) => candidateRevision !== revision.n)
    if (staleAdmissionRevisions.length > 0) staleAdmissionRevisionsByChange.set(pr.id, staleAdmissionRevisions)
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
    for (const revision of staleAdmissionRevisionsByChange.get(pr.id) ?? []) {
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
    const revision = changeRevisionNumber(pr)
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
  const candidatesById = new Map(recordChanges(snapshot.bays).map((pr) => [pr.id, pr] as const))
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
    const candidateRevision = currentChangeRev(candidate)
    if (io.drainSignal?.aborted === true) break
    const target = groups.find(
      (group) => group.aliases.has(candidate.base) || group.aliases.has(baseIdentity(candidate.base)),
    )
    if (target?.headSha === undefined) {
      raiseFailure(
        "infrastructure",
        "queue-base-unresolved",
        `yrd: automatic re-merge could not resolve the merge-queue base '${candidate.base}' for change '${candidate.id}'`,
      )
    }
    if (candidateRevision.baseSha === target.headSha) {
      preparedBatches.add(plan.batch)
      finishBatch()
      continue
    }

    try {
      const remerge = await executeRemergeChange(
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
      const refreshedRevision = currentChangeRev(remerge.current)
      if (remerge.settlement === "payload-already-contained") {
        outcomes.push({
          status: "settled",
          pr: remerge.current.id,
          revision: refreshedRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: remerge.result.baseSha,
          proof: remerge.settlement,
          patchId: remerge.result.patchId,
        })
        app.log.info?.("Settled a queued PR whose payload current main already contains.", {
          action: "queue-freshness-superseded",
          pr: remerge.current.id,
          revision: refreshedRevision.n,
          fromBase: candidateRevision.baseSha,
          toBase: remerge.result.baseSha,
          proof: remerge.settlement,
          patchId: remerge.result.patchId,
        })
        finishBatch()
        continue
      }
      outcomes.push({
        status: "refreshed",
        pr: remerge.current.id,
        revision: refreshedRevision.n,
        fromBase: candidateRevision.baseSha,
        toBase: remerge.result.baseSha,
        headSha: refreshedRevision.head,
        patchId: remerge.result.patchId,
      })
      preparedBatches.add(plan.batch)
      app.log.info?.("Updated a queued PR to the latest base.", {
        action: "queue-freshness-refreshed",
        pr: remerge.current.id,
        revision: refreshedRevision.n,
        fromBase: candidateRevision.baseSha,
        toBase: remerge.result.baseSha,
        patchId: remerge.result.patchId,
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
        app.log.debug?.("Skipped updating a queued PR because it changed.", {
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
        app.log.error?.(
          `Could not journal ${candidate.id}'s queued freshness refusal; the wedge oracle will under-count.`,
          {
            action: "queue-freshness-refusal-unrecorded",
            pr: candidate.id,
            code: failure.code,
            reason: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
          },
        )
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

/** What the habitant did about one wedged PR this cycle. */
export type RefusalRemedyOutcome =
  | Readonly<{
      status: "applied"
      pr: string
      revision: number
      code: string
      count: number
      /** Every command the runner ran, verbatim, in order. */
      commands: readonly string[]
      verdict: RemergePreflightVerdict
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

/** Re-record the branch's corrected head onto the change — the in-process spelling
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
  // Routed to the derived lane: the fact is the submission; compose admits it
  // and runs its checks — nothing further to request here.
  if ("lane" in submitted) return
  const delivery = changeDeliveryState(submitted)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") return
  await requireQueueableSubmodulePins(submitted, services, io)
  if (!app.bays.checksRequested(submitted.id)) await app.bays.requestChecks({ pr: submitted.id })
}

/** Execute the re-merge preflight's verdict in-process. The verdict IS the
 * decision — this never re-parses a printed string, so the runner and the
 * human who reads the same refusal can never diverge. */
async function applyPreflightVerdict(
  app: YrdCliApp,
  services: YrdCliServices,
  preflight: RemergePreflightResult,
  io: YrdCliIO,
  requirements: Readonly<{ track?: true }> = {},
): Promise<void> {
  const remergeExpectedCurrent = {
    revision: preflight.evidence.expectedCurrent?.revision ?? preflight.revision,
    headSha: preflight.evidence.expectedCurrent?.headSha ?? preflight.evidence.headSha,
    ...(preflight.evidence.expectedCurrent?.track === undefined
      ? {}
      : { track: preflight.evidence.expectedCurrent.track }),
    ...requirements,
  }
  const expectedCurrent = { pr: preflight.pr, ...remergeExpectedCurrent }
  if (preflight.verdict === "SUBSUMED-WITHDRAW") {
    // Withdrawal ENDS a delivery, and `yrd admin pr prune` already owns unattended
    // subsumption on its own schedule. The runner's job is to unwedge the line,
    // not to retire someone's PR mid-cycle.
    raiseFailure(
      "refusal",
      "refusal-remedy-needs-withdraw",
      `yrd: change '${preflight.pr}' preflight verdict SUBSUMED-WITHDRAW is an operator decision; run: ${preflight.next}`,
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
  await executeRemergeChange(
    app,
    services,
    preflight.pr,
    {
      revision: preflight.revision,
      ...(preflight.evidence.proposedHeadSha === undefined
        ? {}
        : { proposedHeadSha: preflight.evidence.proposedHeadSha }),
      expectedCurrent: remergeExpectedCurrent,
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
): Promise<RemergePreflightVerdict> {
  let verdict: RemergePreflightVerdict | undefined
  for (const step of steps) {
    commands.push(formatRemedyCommand(step))
    // A create step, or a submit naming a DIFFERENT branch, is a plain
    // redelivery. The submit step for the change under remedy is honoured
    // through the implicit re-merge preflight instead of a blind re-record:
    // tracked changes re-merge implicitly, and the runner takes the same
    // queue-safe verdict path a moved head would (FRESH-NOOP re-readies,
    // RECUT refreshes with certification, SUBSUMED refuses).
    if (step.verb === "create" || step.branch !== plan.branch) {
      await applyRedeliveryStep(app, services, step, io)
      continue
    }
    const preflight = await preflightRemerge(app, plan.pr, { queue: true }, io, services)
    commands.push(preflight.next)
    await applyPreflightVerdict(app, services, preflight, io)
    verdict = preflight.verdict
  }
  if (verdict === undefined) throw new Error(`yrd: change '${plan.pr}' remedy ran no preflight step`)
  return verdict
}

/**
 * 22474 — apply the refusal remedy the queue itself printed, instead of
 * printing it and waiting for a human to apply the verdict.
 *
 * The admission/compose path refuses an authored-gitlink carrier with a message
 * that names exact intent submission. Intent declarations are an author-owned
 * judgment, not a change mutation, so this loop settles that refusal as
 * needs-person. Mechanical code-carrier remedies still run here because a
 * successful re-merge produces a new revision and makes progress.
 *
 * Runs inside the existing serialized habitant cycle beside
 * {@link refreshAdmittedQueueRevisions}: same installed recutter, same journal,
 * no second writer or scheduler. Applies at most one remedy per change revision, so
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
    // branch, so a half-applied one merges the change on a fresh revision with a
    // fresh key — without this the "once per revision" bound would be satisfied
    // by a loop that mints a new revision every cycle. The runner never
    // remedies its own output; a human's next push mints a different revision
    // again and is eligible as normal.
    const settleAttempt = (): void => {
      const current = app.bays.pr(plan.pr)
      if (current === undefined) return
      const revision = currentChangeRev(current)
      attempted.add(refusalRemedyKey(current.id, revision.n, revision.head))
    }
    const identity = { pr: plan.pr, revision: plan.revision, code: plan.failure.code, count: plan.count }
    const projected = actionableFailure(plan.failure)
    const settleNeedsPerson = async (reason: string): Promise<void> => {
      const current = app.bays.pr(plan.pr)
      const refusal = stateOf(app).queues.admissionRefusals[plan.pr]
      if (current === undefined || refusal === undefined) return
      const revision = currentChangeRev(current)
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
      // WARN, as for every settled needs-person row: one change's work for a
      // person, recorded durably, and never a reason to end the pass.
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
      // WARN: the remedy is per-change git work that can fail on the change's
      // own content, it is settled needs-person right above, and the row
      // names the PR and the commands. Not the runner's fault, so not fatal.
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
function observeHabitantRefusals(app: YrdCliApp, runs: number): HabitantRefusalObservation {
  const snapshot = stateOf(app)
  const refusals = Object.values(snapshot.queues.admissionRefusals).filter(
    (refusal) => refusal.settlement === undefined,
  )
  return {
    runs,
    refusals: refusals.map(({ pr, code, count }) => ({ pr, code, count })),
    heads: Object.fromEntries(
      refusals.flatMap((refusal) => {
        const pr = getChangeRecord(snapshot.bays, refusal.pr)
        return pr === undefined ? [] : [[refusal.pr, currentChangeRev(pr).head] as const]
      }),
    ),
  }
}

/**
 * Fold one settled cycle into the poisoned-observer window and say whether the
 * runner should restart itself (22474 specimen 3). Off (window cleared) for a
 * targeted one-shot, which has no next cycle to break out of.
 */
function habitantRefusalHealth(
  app: YrdCliApp,
  stall: HabitantRefusalStall | undefined,
  runs: number,
  watching: boolean,
): Readonly<{ stall: HabitantRefusalStall | undefined; restart: boolean }> {
  if (!watching) return { stall: undefined, restart: false }
  const next = foldRefusalStall(stall, observeHabitantRefusals(app, runs))
  if (next === undefined || next.cycles < HABITANT_REFUSAL_STALL_CYCLES) return { stall: next, restart: false }
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

/** Where a recycle attempt is left for the process that replaces us. It sits
 * beside `status.json` under the same resident-runner directory, because it has
 * exactly that lifetime: one queue repository's habitant lineage. */
function habitantSourceRecyclePath(cwd: string, stateDir?: string): string | undefined {
  const status = habitantRunnerStatusPath(cwd, stateDir)
  return status === undefined ? undefined : join(status, "..", "source-recycle.json")
}

/** Read back the previous process's recycle attempt. Absent is the normal case
 * (no recycle has ever been attempted here) and reads as "no prior attempt"; a
 * malformed or unreadable record reads the same way, since the only thing it
 * gates is ONE extra restart that the supervisor's budget also bounds. */
async function readHabitantSourceRecycle(
  cwd: string,
  stateDir: string | undefined,
): Promise<HabitantSourceRecycle | undefined> {
  const path = habitantSourceRecyclePath(cwd, stateDir)
  if (path === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const { bootedSha, headSha, attemptedAt, reason, staleSteps } = record
    if (typeof bootedSha !== "string" || typeof headSha !== "string" || typeof attemptedAt !== "string") {
      return undefined
    }
    // `reason`/`staleSteps` are absent on records written before 2026-08-30 —
    // degrade to "no reason recorded" (read as `"source-stale"` by
    // `decideHabitantSource`) rather than raising over an older, still-valid
    // record shape.
    if (reason !== undefined && reason !== "source-stale" && reason !== "installed-plan-stale") return undefined
    const stringArray = (value: unknown): value is readonly string[] =>
      Array.isArray(value) && value.every((step) => typeof step === "string")
    if (staleSteps !== undefined && !stringArray(staleSteps)) return undefined
    return Object.freeze({
      bootedSha,
      headSha,
      attemptedAt,
      ...(reason === undefined ? {} : { reason }),
      ...(staleSteps === undefined ? {} : { staleSteps: Object.freeze([...staleSteps]) }),
    })
  } catch {
    // silent-fallback-allow: a missing file is the overwhelmingly common case
    // and is not an error, and a corrupt one degrades to "no prior attempt" —
    // which costs at most one extra restart, still inside the supervisor's
    // restart budget. Raising here would take a healthy queue down over a
    // bookkeeping file that only ever suppresses work.
    return undefined
  }
}

/** Record the attempt BEFORE exiting, so the process that replaces us can tell a
 * recycle that worked from one that changed nothing. */
async function writeHabitantSourceRecycle(
  cwd: string,
  stateDir: string | undefined,
  recycle: HabitantSourceRecycle,
): Promise<void> {
  const path = habitantSourceRecyclePath(cwd, stateDir)
  if (path === undefined) return
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${stableJson(recycle)}\n`, "utf8")
}

/**
 * Fold one settled cycle into the source-staleness window and say whether this
 * habitant should recycle itself onto the code its own checkout now holds —
 * box 1 of @yrd/core/stale-runner-never-recycles.
 *
 * Gated on `habitant`, not merely on the selectorless loop: exiting is only an
 * actuator when something re-execs us. A one-shot `yrd queue run code --once`
 * and a bare programmatic follow have no supervisor and must finish their work
 * on whatever code they started with.
 *
 * The read is deliberately uncached and deliberately based on the checkout the
 * habitant booted from — NOT the recorded pin `runnerPinBehind` serves the
 * watcher (a cache at the poll cadence would let one git read satisfy two
 * observations that are supposed to be independent, and "has my source moved
 * under me" is a different question from "am I where the pin says").
 */
export async function habitantSourceHealth(
  app: YrdCliApp,
  io: YrdCliIO,
  stall: HabitantSourceStall | undefined,
  habitant: boolean,
  threshold: number,
): Promise<Readonly<{ stall: HabitantSourceStall | undefined; recycle: boolean }>> {
  if (!habitant || threshold === 0) return { stall: undefined, recycle: false }
  const bootedSha = habitantBootedSha(io.implementationSource)
  const sourceRoot = io.sourceCheckout ?? yrdSourceCheckout()
  const advance =
    bootedSha === undefined || sourceRoot === undefined ? undefined : readSourceAdvance(sourceRoot, bootedSha)
  const next = foldSourceStaleness(stall, { bootedSha, headSha: advance?.headSha, behind: advance?.behind }, threshold)
  const cwd = io.cwd ?? process.cwd()
  const action = decideHabitantSource(next, await readHabitantSourceRecycle(cwd, io.stateDir))
  if (action.kind === "serve") return { stall: next, recycle: false }
  if (action.kind === "checkout-behind") {
    // The one case a recycle cannot fix, and the reason this is not a bare
    // restart-on-drift: we already restarted for this exact gap and came back
    // running the same commit. Whatever the habitant boots from is not the
    // checkout that moved — a custody freeze holding the source back, a
    // launcher attesting a stale identity, a shim resolving another tree — so
    // name the checkout and the remedy instead of burning the restart budget.
    app.log.error?.(
      `Restarting did not refresh the queue runner's source: it is running git:${action.bootedSha} again while its source checkout '${sourceRoot ?? "unknown"}' is ${String(action.behind)} commits ahead at git:${action.headSha}. Not restarting again — advance the checkout the runner boots from and restart it by hand.`,
      {
        action: "resident-source-stale-checkout-behind",
        bootedSha: action.bootedSha,
        headSha: action.headSha,
        behind: action.behind,
        sourceRoot,
        previousAttemptAt: action.attemptedAt,
      },
    )
    return { stall: next, recycle: false }
  }
  await writeHabitantSourceRecycle(cwd, io.stateDir, {
    reason: "source-stale",
    bootedSha: action.bootedSha,
    headSha: action.headSha,
    attemptedAt: new Date(io.now?.() ?? Date.now()).toISOString(),
  })
  app.log.warn?.(
    `Queue runner source is ${String(action.behind)} commits behind its checkout '${sourceRoot ?? "unknown"}' after ${String(action.observations)} consecutive observations; recycling onto git:${action.headSha}.`,
    {
      action: "resident-source-stale-restart",
      bootedSha: action.bootedSha,
      headSha: action.headSha,
      behind: action.behind,
      observations: action.observations,
      sourceRoot,
    },
  )
  return { stall: next, recycle: true }
}

/** Step names whose declaration differs between what this process installed
 * and what the base tip now declares — the symmetric difference by name. A
 * revision-only or reorder-only delta (the SAME names, a different command
 * revision or order) has an empty symmetric difference by construction; the
 * full declared set names the delta instead, since every step's provenance is
 * suspect once ANY of it moved, not only a step whose name changed. */
export function habitantPlanStaleSteps(comparison: QueueEnvironmentAuditComparison): readonly string[] {
  const installed = new Set(comparison.installed?.steps ?? [])
  const tip = new Set(comparison.tip.steps)
  const added = comparison.tip.steps.filter((name) => !installed.has(name))
  const dropped = comparison.installed === undefined ? [] : comparison.installed.steps.filter((name) => !tip.has(name))
  const delta = [...added, ...dropped]
  return delta.length > 0 ? delta : comparison.tip.steps
}

/**
 * A habitant's designed response to `requireInstalledDeclaredPlan` refusing
 * because this process's installed plan is stale and no in-place reload was
 * available to fix it live (23192 leg c). The remedy is identical to
 * {@link habitantSourceHealth}'s — finish cleanly, exit unclean, let the
 * supervisor re-exec a process that installs the current plan — so the
 * record, the notice and the exit all follow the same shape, sharing the SAME
 * recycle file ({@link HabitantSourceRecycle}) rather than a parallel one.
 *
 * Whether to call this at all is the CALLER's job, not this function's,
 * mirroring `habitantSourceHealth`: exiting is only an actuator when
 * something re-execs us, and a one-shot or bare follow has no next cycle to
 * recycle into — which is exactly why `requireInstalledDeclaredPlan` itself
 * keeps refusing loudly for both. Only the habitant follow loop catches that
 * refusal and redirects it here.
 */
export async function habitantPlanRecycle(
  app: Pick<YrdCliApp, "log">,
  io: YrdCliIO,
  finding: Readonly<{ code: string; message: string }>,
  comparison: QueueEnvironmentAuditComparison | undefined,
): Promise<YrdCliExitCode> {
  const bootedSha = habitantBootedSha(io.implementationSource) ?? "unknown"
  const headSha = comparison?.tip.sha ?? "unknown"
  const staleSteps = comparison === undefined ? undefined : habitantPlanStaleSteps(comparison)
  const attemptedAt = new Date(io.now?.() ?? Date.now()).toISOString()
  const cwd = io.cwd ?? process.cwd()
  await writeHabitantSourceRecycle(cwd, io.stateDir, {
    reason: "installed-plan-stale",
    bootedSha,
    headSha,
    attemptedAt,
    ...(staleSteps === undefined ? {} : { staleSteps }),
  })
  const revision = headSha === "unknown" ? "unknown" : headSha.slice(0, 8)
  const blob = comparison?.tip.configBlobSha === undefined ? "none" : comparison.tip.configBlobSha.slice(0, 8)
  const base = comparison?.base ?? "the base"
  const steps = staleSteps === undefined || staleSteps.length === 0 ? "the declared steps" : staleSteps.join(", ")
  // "notice:", never "error:" — a designed exit a supervisor is about to fix
  // by relaunching must not read like a genuine failure (measured 2026-08-30:
  // seven of these misread as failures and paged @cto). The rich delta text
  // `requireInstalledDeclaredPlan` built stays available as `reason` below,
  // structured, for whoever debugs this after the fact.
  app.log.warn?.(
    `notice: yrd: this runner's installed plan is stale — ${base} tip ${revision} (config blob ${blob}) now ` +
      `declares ${steps} differently than what this process installed at git:${bootedSha}. Recycling: the ` +
      "supervisor relaunches this runner, which installs the currently declared steps on boot.",
    {
      action: "resident-plan-stale-restart",
      bootedSha,
      headSha,
      ...(staleSteps === undefined ? {} : { staleSteps }),
      reason: finding.message,
    },
  )
  return HABITANT_PLAN_STALE_EXIT
}

/**
 * Run the declared-plan gate, catching ONLY the one refusal a habitant with a
 * next cycle can recycle from instead of dying loud (see
 * {@link habitantPlanRecycle}). Every other outcome — a clean pass, the
 * exec-reload control transfer, the reload-exhausted refusal naming a source
 * that cannot build the declared steps, or an unrelated failure — passes
 * through unchanged: only `requireInstalledDeclaredPlan`'s terminal "no
 * reload wired" refusal, and only when `habitant` says a supervisor will
 * relaunch this process, is redirected here instead of propagating. A
 * one-shot or bare follow (`habitant` false) gets `undefined` back from
 * neither branch — it never calls this at all, keeping `gate()`'s own loud
 * refusal as its only outcome, per that function's own contract.
 */
export async function habitantGate(
  gate: () => Promise<void>,
  habitant: boolean,
  app: Pick<YrdCliApp, "log">,
  io: YrdCliIO,
): Promise<YrdCliExitCode | undefined> {
  try {
    await gate()
    return undefined
  } catch (error) {
    if (habitant) {
      const fact = failureFact(error)
      if (fact?.code === "installed-plan-stale") {
        const comparison =
          error instanceof Error ? (error.cause as QueueEnvironmentAuditComparison | undefined) : undefined
        return habitantPlanRecycle(app, io, fact, comparison)
      }
    }
    throw error
  }
}

/** Resident bytes for this process, or undefined when the runtime cannot say.
 * `process.memoryUsage.rss()` is used rather than `/proc/self/status` so the
 * check works wherever Yrd runs, not only on Linux. */
function processRssBytes(io: Pick<YrdCliIO, "rssBytes">): number | undefined {
  if (io.rssBytes !== undefined) return io.rssBytes()
  try {
    const rss = process.memoryUsage.rss()
    return Number.isSafeInteger(rss) && rss > 0 ? rss : undefined
  } catch {
    // silent-fallback-allow: a runtime that cannot report its own resident set
    // makes the cap UNMEASURABLE, which `foldMemoryCap` renders as "no window"
    // and never as "under cap". Nothing is reported healthy on this catch —
    // the habitant simply keeps serving, exactly as it does today with no cap
    // at all, and the OOM killer remains the outer bound it already was.
    return undefined
  }
}

/**
 * The wider per-cycle read behind the observation row.
 *
 * `rssBytes` still comes through {@link processRssBytes}, so an injected
 * reading keeps overriding the runtime for tests and for hosts that measure
 * resident size their own way. The heap detail has no such injection point and
 * is read straight from the runtime, because nothing decides against it.
 */
function processMemorySample(io: Pick<YrdCliIO, "rssBytes">): HabitantMemorySample {
  const rssBytes = processRssBytes(io)
  const measured = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
  try {
    const usage = process.memoryUsage()
    return {
      rssBytes,
      heapUsedBytes: measured(usage.heapUsed),
      heapTotalBytes: measured(usage.heapTotal),
      externalBytes: measured(usage.external),
      arrayBuffersBytes: measured(usage.arrayBuffers),
    }
  } catch {
    // silent-fallback-allow: a runtime with no heap accounting still yields a
    // row carrying whatever resident size it could report. Nothing is reported
    // healthy on this catch and no value is invented — the absent fields read
    // as "not measured", which is what they are, and the cap logic below never
    // consulted them in the first place.
    return {
      rssBytes,
      heapUsedBytes: undefined,
      heapTotalBytes: undefined,
      externalBytes: undefined,
      arrayBuffersBytes: undefined,
    }
  }
}

/**
 * Fold one settled cycle into the RSS-cap window and say whether this habitant
 * should stand down over its own size.
 *
 * Gated on `habitant` for the same reason the source check is: exiting is only
 * an actuator when something re-execs us. A one-shot `yrd queue run code
 * --once` and a bare programmatic follow have no supervisor, and killing them
 * over a cap would lose the work instead of respawning past it.
 */
export function habitantMemoryHealth(
  app: Pick<YrdCliApp, "log">,
  io: Pick<YrdCliIO, "rssBytes">,
  stall: HabitantMemoryStall | undefined,
  habitant: boolean,
  capBytes: number | undefined,
): Readonly<{ stall: HabitantMemoryStall | undefined; standDown: boolean }> {
  if (!habitant) return { stall: undefined, standDown: false }
  // Emitted BEFORE the cap gate, and on every cycle rather than only on the
  // ones that breach: the growth this row exists to measure is a floor that
  // rises over hours, and a series that only records its own breaches cannot
  // show a floor at all. An undeclared cap still gets rows — a host measuring
  // its working set before choosing a number is exactly the reader here.
  const sample = processMemorySample(io)
  app.log.debug?.("Queue runner memory observation.", {
    action: "habitant-memory-observation",
    ...habitantMemoryObservation(sample, capBytes),
  })
  if (capBytes === undefined) return { stall: undefined, standDown: false }
  const next = foldMemoryCap(stall, { rssBytes: sample.rssBytes, capBytes })
  const action = decideHabitantMemory(next)
  if (action.kind === "serve") return { stall: next, standDown: false }
  const mb = (bytes: number): string => String(Math.round(bytes / (1024 * 1024)))
  app.log.warn?.(
    `Queue runner resident set is ${mb(action.rssBytes)} MB against a declared cap of ${mb(action.capBytes)} MB after ${String(action.observations)} consecutive observations; standing down so the supervisor respawns a fresh process.`,
    {
      action: "habitant-memory-cap-restart",
      rssBytes: action.rssBytes,
      capBytes: action.capBytes,
      observations: action.observations,
    },
  )
  return { stall: next, standDown: true }
}

/**
 * D1b — the habitant's per-tick unscoped lease-expiry recovery sweep. `recover`
 * with NO runner arg settles any orphaned running Job whose lease has lapsed,
 * regardless of the runner that left it or where a run's cursor sits — the
 * automatic settle that one-shot startup reclaim (pid-scoped, last pid only) can
 * never do. Throttled by wall time (`io.now`) so a busy tick cadence cannot starve
 * or spam it; returns the timestamp to carry as the next `lastSweepAt`. Idempotent
 * and cheap when nothing lapsed. Logs a loud structured warn ONLY when it actually
 * settles something — loggily-only, since the runner's stdout is a log stream.
 */
export async function habitantRecoverySweep(
  app: Pick<YrdCliApp, "queue" | "log">,
  io: Pick<YrdCliIO, "now">,
  lastSweepAt: number,
): Promise<number> {
  const sweepNow = io.now?.() ?? Date.now()
  if (sweepNow - lastSweepAt < HABITANT_RECOVERY_SWEEP_MS) return lastSweepAt
  const settled = await app.queue.recover({
    recoveryTime: new Date(sweepNow).toISOString(),
    reason: "habitant lease-expiry sweep",
  })
  if (settled.length > 0) {
    app.log.info?.(`Stopped abandoned queue runs: ${settled.map((run) => run.id).join(", ")}.`, {
      action: "resident-recovery-sweep",
      reason: "runner lease expired",
      runs: settled.map((run) => run.id),
    })
  }
  return sweepNow
}

/**
 * The other half of the D1b tick (@i/10-yrd/queue-liveness-pair): loudly logs
 * the (eligible, advanced-since-last-tick) pair's own finding when it fires,
 * at the SAME cadence {@link habitantRecoverySweep} above already ticks at —
 * see that function's doc comment for why the two answer different
 * questions. Reads {@link habitantQueueProgress}'s own audit call, never a
 * second derivation, so this can never disagree with service health about
 * whether the queue is draining; loggily-only, matching every other habitant
 * log line.
 *
 * error, not warn: by the time `habitantQueueProgress` calls the queue
 * "stalled" it has already applied its own persistence threshold, so this
 * finding fires only once that bar is cleared — the queue cannot self-recover
 * on its own, which is the operator's loud-immediately bar. A live outage
 * (measured: 72 minutes, zero ERROR lines) must not read as healthy.
 *
 * `conditions` is optional and caller-owned — the same seam
 * `refreshTrackedQueueRevisions`'s `observation` backoff below uses — so a
 * one-shot or test caller that passes none gets the unconditional per-call
 * behavior this function always had; the habitant loop owns one instance for
 * its process lifetime and dedupes this tick's repeats across cycles (D1b
 * ticks every 30-90s while stalled, and this same finding used to re-log
 * identically on every one of them). Called every tick regardless of
 * `progress.state`, so a `conditions` reporter also learns the moment the
 * queue recovers and flushes any pending per-base tallies then.
 */
export function logQueueLivenessWedge(app: YrdCliApp, now: string, conditions?: ConditionReporter): void {
  const progress = habitantQueueProgress(app, now)
  if (progress.state !== "stalled") {
    conditions?.flush()
    return
  }
  for (const finding of progress.findings) {
    if (finding.code !== "queue-liveness-wedged") continue
    const props = {
      action: "resident-queue-liveness-wedged",
      ...(finding.pr === undefined ? {} : { pr: finding.pr }),
      ...(finding.blockedMs === undefined ? {} : { blockedMs: finding.blockedMs }),
      ...(finding.since === undefined ? {} : { since: finding.since }),
    }
    if (conditions === undefined) {
      app.log.error?.(finding.message, props)
      continue
    }
    const key = `liveness:${finding.specimen ?? `${finding.pr ?? "unknown"}:${finding.since ?? "unknown"}`}`
    conditions.report(key, "error", finding.message, props)
  }
}

/**
 * Run every revision-preparation robot in the habitant's single-writer cycle.
 * Ordering is load-bearing: track the authored branch first, refresh that
 * frozen revision onto the queue base second, then repair prior admission
 * refusals. The return value tells the caller whether to re-prove its installed
 * baseline before composing.
 */
function preparationBaselineChanged(before: YrdCliState, after: YrdCliState): boolean {
  if (before.bays !== after.bays || before.jobs !== after.jobs || before.contests !== after.contests) {
    return true
  }
  const keys = Object.keys(before.queues) as (keyof YrdCliState["queues"])[]
  return keys.some((key) => key !== "admissionRefusals" && before.queues[key] !== after.queues[key])
}

async function prepareHabitantQueueCycle(
  app: YrdCliApp,
  services: YrdCliServices,
  io: YrdCliIO,
  remedied: Set<string>,
  observation: TrackedObservationBackoff,
  conditions?: ConditionReporter,
): Promise<boolean> {
  const beforePublication = stateOf(app)
  const publications = await preparePublicationQueueCycle(app, services, io)
  const publicationChanged = publications.length > 0 || preparationBaselineChanged(beforePublication, stateOf(app))
  if (services.recut === undefined) return publicationChanged
  const beforeTracking = stateOf(app)
  const tracking = await refreshTrackedQueueRevisions(app, services, io, observation, conditions)
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
  const habitant = io.runner?.startsWith("yrd-cli:") === true
  const base = baseIdentity(services.base ?? "main")
  const recoveryReporter = createHabitantRecoveryReporter(app.log)
  // Reclaim a prior habitant's leases BEFORE the heartbeat overwrites status.json —
  // once it writes, the departed pid is lost. The exclusive habitant lock guarantees
  // that prior habitant is not concurrently running as a habitant.
  if (habitant) await reclaimDeadHabitantRunner(app, io)
  // Loaded once at startup, never per-tick — the same tradeoff `queueProgress`
  // and `uncarried` already make for habitant-side facts that do not need to
  // react to a config edit mid-run. A restarted habitant picks up a changed
  // `drafts.pageAfterHours` the same way it picks up any other config change.
  const draftThresholdMs = habitant
    ? draftPageThresholdMs((await loadYrdConfig({ repo: io.cwd ?? process.cwd(), defaultBase: base })).config)
    : 0
  const heartbeat = habitant
    ? await startHabitantRunnerHeartbeat(io, {
        queueProgress: (now) => habitantQueueProgress(app, now),
        uncarried: createStrandedSweeper(app, io, base, app.log).observe,
        staleDrafts: (now) => staleDraftFindings(app, now, draftThresholdMs),
        needsPerson: (now) => needsPersonFindings(app, now),
        // The plan THIS process built, from the live runtime object, so the
        // supervisor probe compares the habitant's own set against the tip
        // (23192 leg c) rather than re-deriving one from config.
        installedPlan: () => ({ batchSize: app.queue.state().batchSize, steps: app.queue.steps() }),
        ...(io.journalRetentionPolicy === undefined ? {} : { retention: io.journalRetentionPolicy }),
        driver: {
          queueId: io.driver?.queueId ?? `${resolve(io.repositoryRoot ?? io.cwd ?? process.cwd())}#${base}`,
          ...(io.driver === undefined ? {} : { epoch: io.driver.epoch }),
          lastMerged: () => habitantDriverLastMerged(app, base),
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
  // Re-observation backoff for tracked branches this process could not observe
  // (22584). Process-scoped like `remedied`: a claim about THIS runner's cycles.
  const observation: TrackedObservationBackoff = new Map()
  // ONE condition reporter for the process lifetime, process-scoped like
  // `observation` above. `logQueueLivenessWedge`'s dead-man tick and the
  // tracked-preparation "remains queued" deferral both fire on every
  // maintenance tick (30-90s) while their condition holds; without cross-cycle
  // memory each tick re-logs the identical line — measured 16 identical rows
  // over one wedged hour. Callers namespace their own keys.
  const conditions = createConditionReporter(app.log)
  // Consecutive all-candidate-refusal cycles against an unchanged world (22474
  // specimen 3). Also process-scoped: it is a claim about THIS process.
  let stall: HabitantRefusalStall | undefined
  // Consecutive cycles observing this process's own source checkout ahead of the
  // commit it booted from (@yrd/core/stale-runner-never-recycles box 1). Like the
  // refusal window above it is process-scoped: it is a claim about THIS process,
  // and the durable half — whether a recycle was already tried for this exact gap
  // — is the `source-recycle.json` record, not this variable.
  let sourceStall: HabitantSourceStall | undefined
  const sourceStaleThreshold = habitantSourceStaleThreshold()
  // Consecutive cycles observing this process over its declared RSS cap. Also
  // process-scoped: it is a claim about THIS process's size, and there is
  // nothing durable to carry across a respawn — a fresh process starts small,
  // which is the entire reason standing down is worth doing.
  let memoryStall: HabitantMemoryStall | undefined
  const rssCapBytes = habitantRssCapBytes()
  let firstCycle = true
  let lastMaintenanceAt = 0

  const runCycle = async (): Promise<YrdCliExitCode | null> => {
    try {
      heartbeat?.check()
      // The pass's own ERROR row stopped it (the host aborted the drain signal
      // with the fatal cause). Nothing is in flight between cycles, so this is
      // the clean boundary to leave from — and it must NOT take the ordinary
      // drain path below, which would run the queue once more to flush it and
      // then call the stop clean.
      if (fatalQueueDrain(drainSignal) !== undefined) return HABITANT_FATAL_EXIT
      const starting = firstCycle
      const beforeRefresh = app.state()
      if (!starting) await app.refresh()
      const refreshed = app.state() !== beforeRefresh
      const cycleNow = io.now?.() ?? Date.now()
      const beforeHoldExpiry = app.state()
      await app.queue.expirePauses(new Date(cycleNow).toISOString())
      const holdExpired = app.state() !== beforeHoldExpiry
      const maintenanceDue =
        starting || cycleNow < lastMaintenanceAt || cycleNow - lastMaintenanceAt >= HABITANT_MAINTENANCE_INTERVAL_MS
      if (!starting && !refreshed && !holdExpired && !maintenanceDue && !drainRequested()) {
        if (scope.signal.aborted) return HABITANT_INTERRUPTED_EXIT
        await sleepUntilDrain(scope.sleep(interval), drainSignal)
        heartbeat?.check()
        return scope.signal.aborted ? HABITANT_INTERRUPTED_EXIT : null
      }
      firstCycle = false
      // Re-read the base tip's declared plan before EACH cycle: a config change
      // while watching reloads the habitant in place, never lets a fresh cycle
      // prepare candidates a stale step set would then refuse.
      const staleAtOpen = await habitantGate(gate, habitant, app, io)
      if (staleAtOpen !== undefined) return staleAtOpen
      if (maintenanceDue) lastMaintenanceAt = cycleNow
      let runRequired = starting || refreshed || holdExpired
      // D1b — bounded maintenance lease-expiry recovery sweep. ONLY the habitant
      // runs it: it holds the exclusive lease, so its unscoped `recover` write is
      // single-writer safe. (A one-shot or a bare programmatic followQueueRuns
      // caller — no runner identity — never sweeps.)
      if (habitant && maintenanceDue) {
        const beforeRecovery = app.state()
        lastSweepAt = await habitantRecoverySweep(app, io, lastSweepAt)
        runRequired ||= app.state() !== beforeRecovery
        // @i/10-yrd/queue-liveness-pair: attached to the SAME cadence as the
        // sweep above, so the log stream that shows "recover succeeded ...
        // runs: []" every tick also carries the half that line cannot answer.
        // The lease-expiry sweep above asks "is the process alive"; this asks
        // "is the queue draining" — 22928's own distinction — computed from
        // the identical shared predicate `habitantQueueProgress` already
        // feeds service health with, never a second reader.
        logQueueLivenessWedge(app, new Date(cycleNow).toISOString(), conditions)
        // Level trigger (@i/10-yrd/quiet-path-starves-standing-submit-facts,
        // shapes 1 and 5): the maintenance tick ALWAYS runs the queue. The
        // edge flags above only accelerate; whether actionable work exists is
        // answered by `runQueues`' own selection — the single honest evaluator
        // — never by a second cli-side derivation of readiness. A submit fact
        // recorded mid-run (shape 1), or this runner's own admission
        // completing inside the previous cycle (shape 5), is invisible to
        // every edge flag, and the wedge line above used to fire while the
        // cycle went back to sleep — the alarm and the scheduler disagreeing
        // about the one question they share. Forcing the run at this cadence
        // makes that state impossible: an idle queue answers with a
        // zero-event run (info-logged, no journal writes), inside the same
        // 60s budget the sweep and audit above already spend.
        runRequired = true
      }
      // The optional default preserves the narrow followQueueRuns test/programmatic
      // seam. The installed CLI always supplies the recutter; a caller that does
      // not install one retains the historical drain-only behavior.
      // 22474 — a wedged PR whose refusal printed a deterministic remedy gets
      // that remedy applied here, once per revision, before the next compose
      // snapshot. Same recutter, same serialized cycle as the freshness pass.
      // A mechanical re-merge may itself take long enough for the declared plan
      // to move. Re-read it before admitting the fresh revision; never start a
      // Run under the pre-re-merge gate snapshot.
      if (await prepareHabitantQueueCycle(app, services, io, remedied, observation, conditions)) {
        runRequired = true
        const staleAfterPrepare = await habitantGate(gate, habitant, app, io)
        if (staleAfterPrepare !== undefined) return staleAfterPrepare
      }
      if (!runRequired && !drainRequested()) {
        // Box 1 of @yrd/core/stale-runner-never-recycles, the half that was
        // missing: the source-staleness exit below sits AFTER this return, so a
        // runner only ever reached it while it had work. A quiet queue never
        // does — and a runner goes stale exactly when nothing is moving, so the
        // process that most needed recycling was the one that could never get
        // there. Measured 2026-08-29: 21 minutes armed and warning every 60s,
        // three commits behind its own pin, with a submitted change waiting.
        //
        // Evaluated on THIS path or the post-run one, never both, so a cycle
        // contributes exactly one observation to the confirmation window.
        // Exiting is as clean here as it is there: no run is in flight, by
        // construction of the branch we are on.
        const idleSource = await habitantSourceHealth(app, io, sourceStall, habitant, sourceStaleThreshold)
        sourceStall = idleSource.stall
        if (idleSource.recycle) return HABITANT_SOURCE_STALE_EXIT
        // Same boundary and the same reasoning as the staleness exit above: no
        // run is in flight on this branch by construction, so standing down
        // over the cap abandons nothing. An idle habitant is also where the
        // growth is least excusable and most often noticed.
        const idleMemory = habitantMemoryHealth(app, io, memoryStall, habitant, rssCapBytes)
        memoryStall = idleMemory.stall
        if (idleMemory.standDown) return HABITANT_MEMORY_CAP_EXIT
        if (scope.signal.aborted) return HABITANT_INTERRUPTED_EXIT
        await sleepUntilDrain(scope.sleep(interval), drainSignal)
        heartbeat?.check()
        return scope.signal.aborted ? HABITANT_INTERRUPTED_EXIT : null
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
      // An ERROR row during that run ended the pass. The run it was inside has
      // just finished (or the host's drain bound cut it short and settled it),
      // so leave now, unclean, before the drain branch below could read the
      // finished run as an operator's clean stop.
      if (fatalQueueDrain(drainSignal) !== undefined) return HABITANT_FATAL_EXIT
      const exit: YrdCliExitCode = runs.some(Queues.failed) ? 1 : 0
      // 22474 specimen 3 — self-health. A long-lived drain that refuses EVERY
      // candidate, cycle after cycle, against a world that is not moving has
      // stopped being evidence about the PRs and become evidence about itself.
      // Gated on the selectorless loop, not on habitant identity: a targeted
      // one-shot has no next cycle to break out of.
      const health = habitantRefusalHealth(app, stall, runs.length, selectors.length === 0)
      stall = health.stall
      // Exit UNCLEAN so the derived habitant lifetime re-execs a fresh process
      // with fresh observation state — mechanically the SIGINT + `yrd queue run` an
      // operator performed by hand, minus the 2.5h wait. The heartbeat's
      // close(cleanShutdown=false) in the finally releases the lease.
      if (health.restart) return HABITANT_POISONED_EXIT
      // Box 1 of @yrd/core/stale-runner-never-recycles. Same boundary and same
      // reasoning as the poisoned-observer exit above, one step further out: the
      // in-flight run has just finished, so exiting here drains cleanly rather
      // than abandoning work, and the unclean code makes the supervisor re-exec
      // a process that reads the source the checkout has since moved to.
      const source = await habitantSourceHealth(app, io, sourceStall, habitant, sourceStaleThreshold)
      sourceStall = source.stall
      if (source.recycle) return HABITANT_SOURCE_STALE_EXIT
      // The in-flight run has just finished, so this exit drains cleanly rather
      // than abandoning work — which is precisely what the OOM killer this cap
      // replaces could never promise.
      const memory = habitantMemoryHealth(app, io, memoryStall, habitant, rssCapBytes)
      memoryStall = memory.stall
      if (memory.standDown) return HABITANT_MEMORY_CAP_EXIT
      if (drainRequested()) {
        if (runs.every(Queues.terminal)) {
          // Operator drain finished with no in-flight work left — the one clean stop.
          cleanShutdown = true
          const lastRun = runs.at(-1)
          return lastRun !== undefined && Queues.failed(lastRun) ? 1 : 0
        }
        // The drain has NOT finished (a run is still in flight), yet a hard signal
        // is forcing the stop now. That is "exiting with in-flight work due to a
        // signal": stay unclean and exit non-zero so the habitant breaker records
        // the failed lifetime. A single drain signal (no scope abort) still loops
        // below and finishes the drain cleanly.
        if (scope.signal.aborted) return HABITANT_INTERRUPTED_EXIT
        await scope.sleep(interval)
        return null
      }
      if (selectors.length > 0) return exit
      if (scope.signal.aborted) return HABITANT_INTERRUPTED_EXIT
      await sleepUntilDrain(scope.sleep(interval), drainSignal)
      heartbeat?.check()
      return scope.signal.aborted ? HABITANT_INTERRUPTED_EXIT : null
    } catch (error) {
      // The shared process pool refuses new work once ITS OWN close() has
      // started (yrd-process's typed process-closed) — expected the instant
      // this runner's own drain is already under way, since app.queue.run's
      // git calls share that one pool with everything else the habitant does.
      // Recognized ahead of the skip-and-retry classifier below: retrying
      // would just re-hit a pool that never reopens, spinning the interval
      // sleep forever instead of exiting. Gated on drainRequested() so a
      // process-closed OUTSIDE a requested drain — which would mean the pool
      // closed for some other reason entirely — still fails loud below; gated
      // on the selectorless loop the same way habitantCycleRecovery is below,
      // since a targeted one-shot has no next cycle to stop instead of retry
      // (2026-08-31 SIGINT teardown race, operator terminal).
      if (selectors.length === 0 && failureFact(error)?.code === "process-closed" && drainRequested()) {
        app.log.warn?.("habitant runner stopped after its own shared process pool closed mid-drain", {
          action: "resident-drain-pool-closed",
          reason: error instanceof Error ? error.message : String(error),
        })
        heartbeat?.check()
        return HABITANT_INTERRUPTED_EXIT
      }
      // One typed recovery boundary owns the complete selectorless cycle. A
      // journal lock can surface while refreshing, preparing, or committing
      // the run. Multi-tenant races can surface at the same boundaries. All
      // recognized cases are losable for a habitant and fatal for a one-shot;
      // unknown failures still propagate and stop the runner (fail-loud).
      const recovery = selectors.length === 0 ? habitantCycleRecovery(error) : undefined
      if (recovery === undefined) throw error
      recoveryReporter.report(recovery)
      heartbeat?.check()
      // A losable race is still a skipped cycle — unless an ERROR row already
      // ended this pass, in which case there is no next cycle to skip to.
      if (fatalQueueDrain(drainSignal) !== undefined) return HABITANT_FATAL_EXIT
      if (drainRequested()) {
        await scope.sleep(interval)
        return null
      }
      if (scope.signal.aborted) return HABITANT_INTERRUPTED_EXIT
      await sleepUntilDrain(scope.sleep(interval), drainSignal)
      heartbeat?.check()
      return scope.signal.aborted ? HABITANT_INTERRUPTED_EXIT : null
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
    // The cause of a control transfer — a reload, or the refusal that ends a
    // reload loop — survives in the durable heartbeat, so the supervisor reads
    // WHY the pid went away rather than a bare unclean exit.
    const exhausted = failureFact(error)
    const finding = isYrdRuntimeReloadRequest(error)
      ? error.finding
      : exhausted?.code === "installed-plan-reload-exhausted"
        ? { code: exhausted.code, message: exhausted.message }
        : undefined
    if (heartbeat !== undefined && finding !== undefined) {
      await heartbeat.recordProgress({
        state: "stalled",
        observedAt: new Date(io.now?.() ?? Date.now()).toISOString(),
        findings: [finding],
      })
    }
    throw error
  } finally {
    recoveryReporter.flush()
    conditions.flush()
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
        ...staleDraftWarnings(snapshot.staleDrafts ?? []),
        ...needsPersonWarnings(snapshot.needsPerson ?? []),
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

async function refuseChangeMerge(
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

  const position = await queuedChangePosition(app, pr, io)
  const detail = changeMergeRefusalDetail(pr, position, latestRunForCurrentRevision(pr, app.queue.status(pr.base)))
  const message = `the queue is the only merger; ${detail.message}`
  const guidance = {
    command: "pr.merge",
    pr: pr.id,
    status: changeDeliveryState(pr),
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

function changeMergeRefusalDetail(
  pr: Change,
  position: number | undefined,
  latestRun: Run | undefined,
): Readonly<{
  next: string
  guidance: Readonly<Record<string, string>>
  message: string
  run?: string
  outcome?: "rejected"
}> {
  const delivery = changeDeliveryState(pr)
  const projectedStatus = projectedChangeStatus(pr)
  if (latestRun?.status === "completed" && latestRun.conclusion === "failure") {
    const inspect = `yrd pr runs ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `change '${pr.id}' latest Run '${latestRun.id}' was rejected; see: ${inspect}; then ${resubmit}`,
      run: latestRun.id,
      outcome: "rejected",
    }
  }
  if (currentChangeRev(pr).admission?.status === "refused") {
    const inspect = `yrd pr checks ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `change '${pr.id}' current revision failed required checks; see: ${inspect}; then ${resubmit}`,
    }
  }
  if (delivery === "submitted" || delivery === "ready") {
    const watch = `yrd watch --pr ${pr.id}`
    return {
      next: watch,
      guidance: { watch },
      message: `change '${pr.id}' is queued${position === undefined ? "" : ` at position ${position}`}; watch: ${watch}`,
    }
  }
  if (delivery === "rejected") {
    const inspect = `yrd pr runs ${pr.id}`
    const fixPush = "fix the branch and push; the same PR resumes automatically"
    return {
      next: inspect,
      guidance: { inspect, fixPush },
      message: `change '${pr.id}' ${projectedStatus === "needs-author" ? "needs author changes" : "was rejected"}; see: ${inspect}; then ${fixPush}`,
    }
  }
  if (delivery === "pushed") {
    const submit = `yrd pr submit ${pr.branch}`
    return { next: submit, guidance: { submit }, message: `change '${pr.id}' is not queued; submit it: ${submit}` }
  }
  const view = `yrd pr view ${pr.id}`
  return { next: view, guidance: { view }, message: `change '${pr.id}' is ${delivery}; see: ${view}` }
}

function maxExit(left: YrdCliExitCode, right: YrdCliExitCode): YrdCliExitCode {
  return Math.max(left, right) as YrdCliExitCode
}

/**
 * The in-toto Statement projection over a durable merge record, for `--json`
 * consumers that want the merge in attestation shape.
 *
 * `builderId` is the queue that produced the merge. It is deliberately not a
 * `MergeRecordBody` field — the record is checksummed and the projection is free
 * to change — so it comes from the journal's own run. Both ways the projection
 * can be absent are named rather than dropped from the payload: a refused or
 * canceled attempt minted no merged commit to be the Statement's subject, and a
 * record whose run the journal has never seen has no builder to attribute.
 */
function mergeStatement(
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
        statementUnavailable: `merge '${record.merge.id}' is ${record.merge.result}, so it minted no merged commit to attest`,
      }
    : { statement }
}

async function explainMerge(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption & Readonly<{ repair?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (services.mergeRecords !== undefined) {
    const proof = await services.mergeRecords.find(selector)
    if (proof.status === "repository-corrupt" || proof.status === "repository-incomplete") {
      // The refusal is correct — a single answer must not come from a partially
      // verified estate — but it was indistinguishable from "your merge is
      // broken", and for two days it was the SAME text for every selector. So say
      // the one thing that separates those: whether THIS selector's own record
      // verified, and how many records the estate could not prove.
      const isolated = await services.mergeRecords.all()
      const own =
        isolated.status === "proven"
          ? isolated.records.some((entry) =>
              entry.record.changes.some((change) => change.pr === selector || entry.record.merge.id === selector),
            )
          : undefined
      const unprovable = isolated.status === "proven" ? isolated.unverifiable.length : undefined
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "why",
          selector,
          verdict: proof.status,
          reason: proof.reason,
          repaired: false,
          ...(own === undefined ? {} : { selectorRecordVerified: own }),
          ...(unprovable === undefined ? {} : { unprovableRecords: unprovable }),
        },
        [
          `${proof.status.toUpperCase()} — ${selector}: ${proof.reason}`,
          own === undefined
            ? "  the estate could not be enumerated, so this selector's own record is unknown"
            : own
              ? `  this selector's OWN record verified — the refusal is the estate's, not this merge's`
              : `  this selector's own record did not verify either`,
          unprovable === undefined
            ? ""
            : `  ${String(unprovable)} record(s) in the estate cannot prove themselves; ` +
              "a single answer is not given from a partially verified estate — " +
              "run `yrd doctor --retract-unprovable` to see them by cause",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      )
      return 2
    }
    if (proof.status === "proven") {
      const attempts = [...proof.records].sort((left, right) => mergeInstant(left.record) - mergeInstant(right.record))
      const latest = attempts.at(-1)
      if (latest === undefined) configuration("repository merge-record query returned no proven records")
      const verdict = latest.record.merge.result
      const reason = latest.record.reason
      const fix = latest.record.fix
      let repaired = false
      const pr = app.bays.pr(selector)
      if (verdict === "merged" && options.repair === true && pr !== undefined) {
        const repair = mergeRepair(latest.record, pr)
        if (repair.status === "repairable") {
          await app.queue.reconcileMerge(repair.input)
          repaired = true
        }
      }
      // Nothing-new is a first-class outcome, not a defect: the change was already
      // contained, so "at <commit>" would print the BASE and read as a fresh merge.
      // Derived here by predicate — the record stores the facts, never the label.
      const nothingNew = mergeJoinedNothing(latest.record)
      const human =
        verdict === "merged"
          ? nothingNew
            ? `MERGED — ${selector} via ${latest.record.merge.id}: already up to date — ` +
              `joined nothing new to '${latest.record.merge.base}' at ${latest.record.merge.baseSha}`
            : `MERGED — ${selector} via ${latest.record.merge.id} at ${latest.record.merge.mergedCommit}`
          : `${verdict.toUpperCase()} — ${latest.record.merge.id}: ${reason?.code ?? "unknown"}: ${reason?.message ?? "no reason recorded"}${fix === undefined ? "" : ` — fix: ${fix}`}`
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "why",
          selector,
          verdict,
          ...(nothingNew ? { nothingNew } : {}),
          repaired,
          record: latest.record,
          pointer: latest.pointer,
          attempts,
          ...mergeStatement(app, latest.record),
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
  const revision = currentChangeRev(pr)
  if (revision.changeId === undefined) {
    await printResult(
      io,
      jsonEnabled(options),
      { command: "why", pr: pr.id, verdict: "legacy-unprovable", repaired: false },
      `LEGACY-UNPROVABLE — ${pr.id} predates stable Change-Id identity`,
    )
    return 1
  }
  const indexed = changeDeliveryState(pr) === "integrated"
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
    [`$ ${bay} submit`, "submit the current bay as a change"],
  ]
  examples.push(
    [`$ ${name} pr list`, "inspect active PRs"],
    [`$ ${name} submit`, "submit the current branch as a change"],
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
    [`$ ${repository} queue run PR7 --steps check,merge`, "run selected steps for one change"],
    [`$ ${name} log --base release/2.0`, "show completed work for a base"],
    [`$ ${name} pr runs PR7`, "show step-level run evidence and proofs"],
    [`$ ${repository} queue pause --reason maintenance --for 30m --allow PR7`, "pause all but selected PRs"],
    [`$ ${repository} queue run`, "habitant follow-runner: keep the default queue moving"],
  ])
}

function addAuthoredCarrierWorkflow<
  Options extends Record<string, unknown>,
  Arguments extends unknown[],
  ArgumentRecord extends Record<string, unknown>,
>(command: CliCommand<Options, Arguments, ArgumentRecord>, name: string): void {
  command.addHelpSection("Authored root branch:", [
    [`$ ${name} pr create <branch>`, "record the authored root branch as a draft change"],
    [
      `$ ${name} pr submit <branch>`,
      "tracked changes re-merge implicitly when the branch moves; this is the explicit fallback spelling",
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
        // Set BEFORE calling probe(), never after: when the SELECTED repository's
        // own config is exactly what makes probe() throw (PR1337's shape — an
        // invalid `.yrd.yml` at the base ref), the assignment used to run only on
        // the success path, so a throw left `io.cwd` unset. The catch in this
        // function's caller then re-ran the health check against `runtimeIO`
        // unchanged, which fell back to `process.cwd()` — the AMBIENT directory,
        // never the one --repo/--config selected — and reported a misleading
        // "not a Git queue repository" about the wrong directory entirely,
        // masking the real config error behind it. --repo/--config's authority
        // over which repository is examined must hold on the error path too.
        runtimeIO[RuntimeInvocationCwd] = bootstrap.ambientCwd
        io.cwd = selected.repo
        const probed = await bootstrap.probe(selected)
        runtimeServices = probed.services
        Object.assign(io, probed.io)
        return
      }
      const loaded = await bootstrap.load(selected, invocation.posture)
      runtimeApp = loaded.app
      runtimeServices = loaded.services
      runtimeIO[RuntimeInvocationCwd] = bootstrap.ambientCwd
      Object.assign(io, loaded.io)
      if (invocation.posture !== "habitant-queue-run" && invocation.posture !== "one-shot-queue-run") {
        await runClientDeadMan(runtimeApp, runtimeServices, io, !jsonOutputRequested(program, invocation.args))
      }
    })
  }
  program.version(YRD_VERSION, "-V, --version")
  program.addHelpSection(
    "Model:",
    "Pick an issue -> work it in a bay -> create a draft -> submit it ->\nchanges queue per base -> a run verifies and merges each one ->\nmerged, or parked for the author with a typed result.",
  )
  program.addHelpSection(
    "Loop:",
    `1. ${name} pr submit\n2. ${name} pr status  (live bay, change, queue position, pause)\n3. ${name} pr runs <PR>\n4. fix the branch and push; the same PR resumes automatically.`,
  )
  program.addHelpSection("Objects:", [
    ["issue", "tracker-owned intent; delivery lens plus Git-side ensure"],
    ["bay", "isolated Git workspace managed through the yrd bay subtree"],
    ["change", "the queue's unit; draft until submitted; mr and pr are taught aliases"],
    ["contest", "competing implementations; winner promotes to a change"],
    ["queue", "the merge queue: one per base; verifies and merges changes serially"],
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
    .description("diagnose repository configuration and retention warnings")
    .option("--rebuild-views", "atomically rebuild registered query views from immutable Journal history")
    .option(
      "--rebuild-index-from-repo",
      "rebuild missing pr/integrated index rows for PRs the journal already knows, from every proven " +
        "merge record in the repository (cannot recreate a change entity the journal has never seen)",
    )
    .option(
      "--retract-unprovable",
      "list EVERY merge record the repository cannot prove, by cause; add --apply to append a retraction " +
        "beside each one so the estate verifies again (records are never edited — a retraction is a new " +
        "note on its own ref, and the original stays byte-identical)",
    )
    .option("--apply", "with --retract-unprovable, actually append the retractions instead of listing them")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await configDoctor(installed(), installedServices(), options, io)))
  program
    .command("why <selector>")
    .description("prove one change merge from repository truth and its journal index")
    .option("--repair", "append a missing pr/integrated index row from repository proof")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(
        await explainMerge(
          installed(),
          installedServices(),
          // `yrd why` accepts the canonical `path@branch#N` run address and
          // the bare `#N` form (items 34/36); the resolver validates the
          // path half against this repository before stripping it.
          resolveCanonicalRunSelector(selector, io.repositoryRoot),
          options,
          io,
        ),
      ),
    )

  const bay = program
    .command("bay")
    .description("manage work bays — a Git worktree plus a lease, an issue, and a managed lifecycle")
  bay.helpCommand(false)
  bay
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .option("--all", "include open and terminal Bays")
    .option("--closed", "show terminal Bays only")
    .option("--check", "compute live destroy-safety status (fetches origin; may be slow)")
    .option(
      "--landing",
      "derive whether handoff-ready work landed and whether its certification is still fresh (fetches origin; may be slow)",
    )
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("list")
    .description("list work bays")
    .option("--json", "emit stable JSON")
    .option("--all", "include open and terminal Bays")
    .option("--closed", "show terminal Bays only")
    .option("--check", "compute live destroy-safety status (fetches origin; may be slow)")
    .option(
      "--landing",
      "derive whether handoff-ready work landed and whether its certification is still fresh (fetches origin; may be slow)",
    )
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
    .description("print an active bay path")
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
    .option("--check", "resolve and validate the bay without certifying (read-only preflight)")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      certifyBayHandoff(
        installed(),
        selector,
        options as Readonly<{ branch: string; head: string; evidence: string; check?: boolean; json?: boolean }>,
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
    .option(
      "--prop <key>=<value>",
      "set a prop on the submitted revision — an opaque key=value label (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--composition <path>", "immutable version-1 source composition JSON")
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--no-track", NO_TRACK_OPTION_DESCRIPTION)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyChangeSelectionVerb(installed(), installedServices(), selectors, options, io, "bay.submit")),
    )
  bay
    .command("close [selector...]")
    .description("close work bays (checks bay status first; needs --force to override)")
    .option("--withdraw", "withdraw a live change before closing")
    .option("--force", "bypass bay status (requires explicit bay name; prints what is destroyed)")
    .option(
      "--tolerate-unreadable <pids>",
      "certify teardown despite census gaps caused by EXACTLY these unreadable pids (comma-separated; each waiver is printed)",
    )
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      await closeBays(installed(), installedServices(), selectors, options, io)
    })
  bay
    .command("status [selector...]")
    .description("safety oracle: is this bay safe to remove? (exit 0=safe 1=not-safe 2=unknown)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await bayStatusCommand(installed(), selectors, options, io)))
  program
    .command("log")
    .description("show queue history, newest first")
    .option("--base <branch>", "scope log to one base branch")
    .option("--pr <pr>", "scope log to one change")
    .option("--failed", "show rejected history only")
    .option("--since <duration>", "show history within a duration")
    .option("-L, --limit <count>", "limit history rows", int, 20)
    .option("--all", "show all rows; include lossless queue and run records in JSON")
    .option("--json", "emit stable JSON")
    .option("--strict", "fail loud (exit 3) on the first unreadable run member instead of marking its row")
    .action(async (options) => logRuns(installed(), [], options, io, installedServices()))

  program
    .command("watch [filter...]")
    .description("alias for queue ls --watch")
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope watch to one change")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each change")
    .option("--json", "emit stable JSON")
    .option("--strict", "fail loud (exit 3) on the first unreadable run member instead of marking its row")
    .action(async (filters, options) => {
      setExit(await watchQueue(installed(), filters, options, io, installedServices()))
    })

  program
    .command("cancel <selector>")
    .description(
      "stop the current attempt for a change or run — members re-queue and the change stays open; to stop delivering it, use `yrd mr close --reason <text> --burn-payload` (run both for both effects)",
    )
    .option("--reason <text>", "human-readable cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await cancelAttempt(installed(), selector, options, io)))

  // The branch-state verbs. `yrd branch <state>` is the complete quartet, and
  // all four states are bare top-level verbs too.
  //
  // Root `yrd submit` IS this verb (@cto 2026-08-19, cliverbs ruling-a): it
  // used to be an alias for `yrd pr submit`, which stays untouched as the change
  // path. The two are the same user intent at two phases — the receiver
  // already dual-writes `refs/yrd/submit/<branch>` on carrier push
  // (`writeSubmitRefForCarrier`, commented "phase 2 re-points readers at this
  // ref alone") — so the everyday spelling now names the phase-2 act directly.
  // `change`/`mr`/`pr` remain one noun for the merge-request RECORD.
  const CHANGE_STATE_HELP = {
    draft: "move branches into draft — the default state, and how a submitted branch is unsubmitted",
    submit: "approve branches to merge, naming each branch's current tip as the approved commit",
    archive: "shelve branches — deletes each branch, which the receiver files under refs/yrd/archive/",
    ignore: "keep branches out of the queue's view without archiving them",
  } as const satisfies Record<ChangeState, string>

  const registerChangeStateVerb = (target: CliCommand, state: ChangeState): void => {
    const verb = target
      .command(`${state} [selector...]`)
      .description(CHANGE_STATE_HELP[state])
      .option("--dry-run", "print the resolved branches and the exact git command without pushing")
    if (state === "archive") {
      verb
        .option("-m, --message <text>", "why this branch is being archived")
        .option("-F, --file <path>", "read the message from a file, or from stdin with '-'")
    }
    type ChangeStateVerbOptions = Readonly<{ dryRun?: boolean; message?: string; file?: string }>
    verb.action(async (selectors: readonly string[], options: ChangeStateVerbOptions) =>
      setExit(
        await applyChangeState(
          state,
          selectors,
          { dryRun: options.dryRun, message: options.message, messageFile: options.file },
          io,
          changeStateDeps(io, () => currentGitBranch(invocationCwd(io), io), installedServices().process),
        ),
      ),
    )
  }

  const branch = program.command("branch").description("move a branch into a delivery state")
  branch.helpCommand(false)
  for (const state of ["draft", "submit", "archive", "ignore"] as const) {
    registerChangeStateVerb(branch, state)
    registerChangeStateVerb(program, state)
  }

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
    .command("release <deployment-result> <hab-release-result>")
    .description("release an exact deployment after a matching Hab generation-death result")
    .option("--json", "emit stable JSON")
    .action(async (deploymentResult, habReleaseResult, options) =>
      releaseDeployment(installed(), deploymentResult, habReleaseResult, options, io),
    )

  const queue = program.command("queue").description("manage integration queues")
  queue.helpCommand(false)
  const listQueue = async (positional: string[], options: QueueListOptions): Promise<void> => {
    // A positional term spelled like a subcommand is the one shape this surface
    // cannot read: `queue list list` could be either. `--term` is the reading
    // that has to be asked for; everything else refuses rather than searching.
    refuseShadowedQueueFilterTerms(positional)
    const filters = [...positional, ...(options.term ?? [])]
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
  const TERM_OPTION_HELP = "filter the timeline by a literal word, including one spelled like a subcommand (repeatable)"
  const collectTerm = (value: string, previous: readonly string[]): readonly string[] => [...previous, value]
  queue
    .command("_list [filter...]", { isDefault: true, hidden: true })
    .option("--term <word>", TERM_OPTION_HELP, collectTerm, [] as readonly string[])
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope the queue timeline to one change")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each change")
    .option("--watch", "keep this projection live and interactive")
    .option("--check", "probe habitant lease, heartbeat, declared-plan freshness, and Git distance")
    .option("--json", "emit stable JSON")
    .option("--strict", "fail loud (exit 3) on the first unreadable run member instead of marking its row")
    .action(listQueue)
  queue
    .command("list [filter...]")
    .description("show the queue timeline")
    .option("--term <word>", TERM_OPTION_HELP, collectTerm, [] as readonly string[])
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope the queue timeline to one change")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each change")
    .option("--watch", "keep this projection live and interactive")
    .option("--check", "probe habitant lease, heartbeat, declared-plan freshness, and Git distance")
    .option("--json", "emit stable JSON")
    .option("--strict", "fail loud (exit 3) on the first unreadable run member instead of marking its row")
    .action(listQueue)
  queue
    .command("audit")
    .description("check queue state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueAudit(installed(), installedServices(), options, io)))
  // Retired verb (5e cut 7): stays registered, hidden, so an old runbook gets
  // a loud typed refusal naming the replacements, never a silent timeline
  // filter. Inventory: yrd doctor. Deletion: yrd admin candidate-refs prune.
  queue
    .command("candidate-refs", { hidden: true })
    .description("retired: refuses and names why")
    .option("--prune", "ignored; the verb is retired")
    .option("--retention-days <days>", "ignored; the verb is retired")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueCandidateRefs())
  queue
    .command("uncarried")
    .description("find refs pushed to the remote that no change carries")
    .option("--base <branch>", "base branch the refs are judged against")
    .option("--namespace <ref>", "ref namespace to sweep")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueStranded(installed(), options, io)))
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
  // Retired verb (5e cut 6): stays registered, hidden, so an operator
  // following an old runbook gets the reason and the replacements, not a
  // silent timeline filter. Restart re-derives recovery; see
  // refuseRetiredQueueRecover for the one remainder.
  queue
    .command("recover", { hidden: true })
    .description("retired: refuses and names why")
    .option("--reason <text>", "ignored; the verb is retired")
    .option("--runner <id>", "ignored; the verb is retired")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueRecover())
  queue
    .command("run [selector...]")
    .description("drain the queue — habitant follow by default; --once or change selectors for a single pass")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--once", "drain the default queue exactly once, then exit")
    .option("--interval <seconds>", "follow-mode poll interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      const mode = invocation.queueRunMode
      if (mode === undefined) throw new Error("yrd: normalized queue run mode is missing")
      // One lineage per process: the count this process was exec'd with, reset
      // by a clean gate pass, carried forward by the next reload request.
      const lineage = bootstrap === undefined ? undefined : runtimeReloadLineage(bootstrap.env)
      const gate = () =>
        requireInstalledDeclaredPlan(
          installedServices(),
          mode === "follow"
            ? {
                reloadInPlace:
                  bootstrap === undefined || lineage === undefined ? {} : { request: requestYrdRuntimeReload, lineage },
              }
            : {},
        )
      if (mode === "follow") {
        setExit(await followQueueRuns(installed(), selectors, options, io, gate, installedServices()))
        return
      }
      // No admission pre-gate here: this process already holds the queue runner
      // lease (taken at host construction, before this action ran) or it never
      // got this far. See the note above `gitDistance` for the probe this
      // replaced.
      await gate()
      const app = installed()
      // Stop TAKING work the moment a drain is asked for. A pass already inside
      // `runQueues` finishes the run it composed — that is the "let the job in
      // flight end" half — but a pass that has not started one must not start
      // one now, and a publication cycle is new work by the same measure. The
      // boundary settles whatever this leaves and exits `drained`.
      const draining = () => io.drainSignal?.aborted === true
      const publications = draining() ? [] : await preparePublicationQueueCycle(app, installedServices(), io)
      if (publications.length > 0) await gate()
      const runs = draining() ? [] : await runQueues(app, selectors, options, io)
      const selectedChangeIds =
        selectors.length === 0 ? undefined : new Set(selectors.map((selector) => requiredPr(app, selector).id))
      const blocked = admissionBlockedChanges(app, selectedChangeIds)
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
                  pr: projectChangeTaskStatusWithEligibility(pr, eligibility),
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
    .option("--token <token>", "waiting-job props token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => finishQueue(installed(), selector, options, io))
  addQueueExamples(queue, name)

  addRootBayCommands(program, installed, installedServices, io, setExit)

  // `change` is the printed name (operator ruling 2026-08-18, superseding
  // I23's `mr`-primary call); `mr` and `pr` are permanent taught aliases --
  // ids keep printing as PRnnn (a pure label) and both spellings keep
  // working forever.
  const pr = program
    .command("change")
    .alias("mr")
    .alias("pr")
    .description(
      "manage changes (a branch selector targets the live delivery; address a terminal change by its id, printed as PRnnn; mr/pr accepted)",
    )
  pr.helpCommand(false)
  const list = pr
    .command("list")
    .description("list changes")
    .option("--base <branch>", "scope changes to one base")
    .option(
      "--state <state>",
      `scope changes to one record state (${CHANGE_LIST_RECORD_STATE_HELP}) ` +
        `or one native or projected delivery status (${CHANGE_LIST_STATE_HELP})`,
    )
    .option("--issue <ref>", "scope changes to one issue reference")
    .option("--needs-review", "show revisions needing approval")
    .option("--reviewer <reviewer>", "scope --needs-review to one requested reviewer")
    .option("--json", "emit stable JSON")
    .option("--strict", "fail loud (exit 3) on the first unreadable change instead of marking its row")
    .action(async (options) => listPrs(installed(), options, io))
  list.addHelpSection(
    "Status fields:",
    [
      "state — answers: is the change record open or closed? tense: current",
      "status — answers: what delivery result should a reader act on? tense: current",
      "nativeStatus — answers: what delivery status did the rebuildable index record? tense: historical",
      "taskStatus — answers: how does this delivery map to the shared work-state vocabulary? tense: current",
      "eligibility.reason.code — answers: why can the current revision not run now? tense: current",
      "mergedOnBase.code — answers: why did repository proof override nativeStatus? tense: current",
      "--state needs-author — answers: does this change currently need author action? tense: current",
    ].join("\n"),
  )
  const create = pr
    .command("create [selector]")
    .description("create a draft change without requesting required checks")
    .option("--base <branch>", "base branch for a direct branch create")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option(
      "--prop <key>=<value>",
      "set a prop on the draft revision — an opaque key=value label (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after create (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--no-track", NO_TRACK_OPTION_DESCRIPTION)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(
        await applyChangeSelectionVerb(
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
    .description("submit change revisions after the managed local required-check hook")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option(
      "--prop <key>=<value>",
      "set a prop on the submitted revision — an opaque key=value label (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after submit (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--no-track", NO_TRACK_OPTION_DESCRIPTION)
    .option("--keep-on-failure", "retain a failed client-side required-check workspace for inspection")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyChangeSelectionVerb(installed(), installedServices(), selectors, options, io, "pr.submit")),
    )
  pr.command("view <selector>")
    .description("show a change and its runs")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPr(installed(), selector, options, io, installedServices()))
  pr.command("runs <selector>")
    .description("show run, step, attempt, proof, and artifact detail")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewChangeRuns(installed(), selector, options, io, installedServices()))
  pr.command("diff <selector>")
    .description("show the candidate diff")
    .option("--stat", "show diff statistics")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => diffPr(installed(), selector, options, io))
  pr.command("checkout <selector>")
    .description("materialize a bay from a change revision head (detached HEAD)")
    .option("--bay <name>", "name the new bay")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => checkoutPr(installed(), selector, options, io))
  pr.command("status")
    .description("show the current bay or branch change")
    .option("--json", "emit stable JSON")
    .action(async (options) => statusPr(installed(), options, io, installedServices()))
  pr.command("edit <selector>")
    .description("edit the issue link, note, title, description, or branch tracking")
    .option("--issue <ref>", "set the tracker-neutral issue reference")
    .option("--note <text>", "set the delivery note")
    .option("--title <text>", "set the change subject")
    .option("--description <text>", "set the change description body")
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--untrack", "stop tracking: a stale head again blocks the re-merge")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => editPr(installed(), selector, options, io))
  // Hidden with recut: the draft story is `create` = draft, `submit` = ready.
  pr.command("publish <selector>", { hidden: true })
    .description("request credential-bearing publication of one immutable change revision")
    .option("--queue", "re-merge and queue the revision after publishing succeeds")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => publishPr(installed(), installedServices(), selector, options, io))
  pr.command("ready <selector>", { hidden: true })
    .description("submit a pushed change revision and request configured checks")
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
    .description("replace the requested reviewers for a change (declarative set)")
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
    .description("show required-check evidence for current change revisions")
    .option("--follow", "follow active checks to a terminal result")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await changeChecks(installed(), selectors, options, io)))
  pr.command("close [selector...]")
    .description("close a live change without merging — records why, leaves the queue")
    .option("--reason <text>", "close rationale recorded on each pr/withdrawn event")
    .option("--burn-payload", "acknowledge that closing spends the payload identity permanently")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => withdrawPrs(installed(), selectors, options, io, "pr.close"))
  // Hidden ruled alias of `close` — one act, two spellings (I23); the envelope
  // keeps its stable pr.withdraw name for journal consumers.
  pr.command("withdraw <selector...>", { hidden: true })
    .description("withdraw live changes from delivery, recording the reason")
    .option("--reason <text>", "withdrawal rationale recorded on each pr/withdrawn event")
    .option("--burn-payload", "acknowledge that withdrawing spends the payload identity permanently")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => withdrawPrs(installed(), selectors, options, io))
  pr.command("merge <selector>")
    .description("teach that the queue is the only merger")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await refuseChangeMerge(installed(), selector, options, io)))

  const gitlink = program.command("gitlink").description("advance the submodule commits this repository records")
  gitlink.helpCommand(false)
  gitlink
    .command("advance <submodule> [target]")
    .description("advance one submodule's gitlink to a min commit and submit it, in one step")
    .addHelpText(
      "after",
      "\nTarget defaults to 'main' — the submodule's own main tip. A sha or branch that\n" +
        "descends from that main is fast-forwarded onto it first (submodules land directly);\n" +
        "anything else refuses, because no gitlink may name a commit its submodule never took.",
    )
    .option("--dry-run", "settle and print the advance without publishing, committing or submitting")
    .option("--json", "emit stable JSON")
    .action(async (submodule, target, options) =>
      setExit(await advanceSubmoduleGitlink(installed(), installedServices(), submodule, target, options, io)),
    )

  program
    .command("check <name...>")
    .description("run configured required checks in the current working tree")
    .option("--json", "emit stable JSON")
    .action(async (names, options) => checkRequired(installedServices(), names, options, io))

  program
    .command("guard [name...]")
    .description("run configured pre-submit guards against the current head; omit names for all")
    .option("--json", "emit stable JSON")
    .action(async (names, options) => guardRequired(installedServices(), names, options, io))

  const admin = program.command("admin").description("perform infrequent repository and state administration")
  admin.helpCommand(false)
  admin
    .command("init")
    .description("scaffold .yrd.yml and install the managed pre-submit hook")
    .option("--json", "emit stable JSON")
    .action(async (options) => initYrdConfig(installedServices(), options, io))
  // Retired verbs stay registered so an operator following an old runbook
  // gets the reason and the replacement, not "unknown command".
  const adminQueue = admin.command("queue", { hidden: true }).description("retired queue administration")
  adminQueue
    .command("init [base]", { hidden: true })
    .description("retired: refuses and names why")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueAdministration("init"))
  adminQueue
    .command("deinit [base]", { hidden: true })
    .description("retired: refuses and names why")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueAdministration("deinit"))
  const adminBay = admin.command("bay").description("administer work bays")
  adminBay
    .command("prune")
    .description("census prunable bays and write an approval, or apply one exact approved set")
    .option("--apply", "close the exact set in --approval")
    .option("--approval <path>", "approval artifact to verify and apply")
    .option("--save-approval <path>", "write the dry-run census as a new approval artifact")
    .option(
      "--exclude <bay>",
      "exclude a bay from the dry-run approval (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await bayPruneCommand(installed(), installedServices(), options, io)))
  const adminPr = admin.command("pr").description("administer changes")
  adminPr
    .command("prune")
    .description("withdraw live PRs whose content their base branch already contains")
    .option("--dry-run", "print every checked verdict without withdrawing")
    .option("--json", "emit stable JSON")
    .action(async (options) => prunePrs(installed(), options, io))
  const adminCandidateRefs = admin.command("candidate-refs").description("administer synthetic Candidate refs")
  adminCandidateRefs
    .command("prune")
    .description("sweep the Candidate ref namespace and delete the refs this same pass proved reclaimable")
    .option("--retention-days <days>", "override the retention window (default 7)")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await adminPruneCandidateRefs(installed(), options, io)))
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
    .description("ensure one issue-owned Bay and one tracked draft change")
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
    .option("--token <token>", "waiting-job props token")
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
    .description("submit the selected submodule commit")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await promoteContest(installed(), contestId, options, io)))

  const order = new Map(
    ["mr", "bay", "issue", "contest", "queue", "check", "doctor", "why", "admin", "log", "watch"].map(
      (command, index) => [command, index],
    ),
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
  // `intent` (submit, fix, set, withdraw, close, tombstone) is a retired verb
  // group, not an absent one — Commander's unknown-command handling prints
  // top-level usage here, indistinguishable from a typo, which is exactly the
  // wrong instruction at the moment of the block (23000). Name the
  // replacement instead of falling through to generic help.
  if (invocation.args[0] === "intent") {
    await diagnostic(
      io,
      createFailure({
        kind: "usage",
        code: "retired-command",
        message:
          "yrd intent is retired; advancing a submodule min commit is an ordinary change — run " +
          "'yrd gitlink advance <submodule> [<sha>|main]', which fast-forwards that submodule's own main, " +
          "writes the gitlink bump and submits it. By hand it is still fast-forward the submodule's own main, " +
          "then 'yrd pr submit <branch>'",
      }),
      { json: invocation.args.includes("--json") },
    )
    return 2
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
    canonicalArgs.length === 1 &&
    (canonicalArgs[0] === "change" || canonicalArgs[0] === "pr" || canonicalArgs[0] === "mr")
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
