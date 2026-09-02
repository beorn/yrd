import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { clearLine, cursorTo } from "node:readline"
import { createScope, type Scope } from "@silvery/scope"
import { createGit, createGitWorktreeStore, type Git } from "git-super/worktree"
import {
  createBayJobDefs,
  createDeploymentJobDefs,
  createGitDeploymentStore,
  createGitPushReceiver,
  createGitWorkspace,
  gitWorkspaceRevision,
  resolveBayWorkspacePath,
  baseIdentity,
  defaultBayBranch,
  receiverInboxDir,
  loadGitPushReceiver,
  normalizeV1CorrelationToProps,
  runReceiverHookFromEnvironment,
  withBays,
  withDeployments,
  type BayWorkspace,
  type GitDeploymentStore,
  type GitPushReceiver,
  type GitWorkspaceLifecycleHooks,
  type RemoteBranchSnapshot,
  type ReceiverDrainResult,
  type ReceiverResult,
  type ReceiverRefUpdate,
  type ReceiverSubmitIntent,
  type ReceiverTarget,
  changeIdTrailerCandidates,
  findChangeId,
  recordLaneOwnsBranch,
  currentChangeRev,
  recordChanges,
  recordChangeEntries,
  getChangeRecord,
} from "@yrd/bay"
import {
  createHeldOutCommandEvaluator,
  withContests,
  type ContestEvaluatorDef,
  type CommitResolver,
  type ContestRunnerDef,
} from "@yrd/contest"
import {
  createFailure,
  checkpointMigrationManifest,
  checkpointMigrationManifestHash,
  createYrd,
  createYrdDef,
  failureFact,
  pipe,
  raiseFailure,
  SUPPORTED_VERSIONS,
  stageReport,
  withCheckpointMigrations,
  type Journal,
  type JournalCompatibility,
  type CheckpointMigrationManifest,
} from "@yrd/core"
import { localRunner, withJobs } from "@yrd/job"
import {
  configuredCommandStep,
  configuredMergeStep,
  configuredWaitingCommandStep,
  censusReceiverInbox,
  censusSubmoduleAlternates,
  createCandidatePool,
  createCandidatePoolGit,
  createGitChangeRemerger,
  gitCandidatePreparer,
  gitCheckStep,
  gitMergeStep,
  gitMergeRecorder,
  findRepositoryMergeRecords,
  repairMergeRecordEstate,
  inspectGitQueueTarget,
  overlayGateScripts,
  resolveGitQueueTarget,
  receiverInboxFindings,
  submoduleAlternatesFindings,
  worktreeContexts,
  withQueue,
  withMerge,
  withStep,
  type CandidatePool,
  type SubmoduleModelChangeAuthorizer,
  CheckpointMigrationAttestationSchema,
  CHECKPOINT_MIGRATION_TRAILER,
  type CheckpointMigrationAttestation,
  type CommandEvidence,
  type GitCheckOptions,
  type InstalledStep,
  type IntegratedShape,
  type PinIntentProvisioner,
  type ChangeShape,
  type DeclaredStepPlanAtBase,
  type QueueAuditFindingEmission,
  type QueueRecord,
  type StepDef,
  type StepExecution,
  type StepRunner,
  Queues,
  buildMergedTruthIndex,
  landedSubmits,
  stampingEpochStop,
  type DerivedSubmitEnrichment,
  type MergedTruthGit,
  type MergedTruthIndex,
  type TrailerAbsentException,
  describeMergedTruthGaps,
  revisionOf,
  describeScratchReap,
  liveScratchOwners,
  reapOrphanedScratch,
  writeScratchOwner,
} from "@yrd/queue"
import {
  installedPlanStale,
  recentRootRuns,
  runPlanMismatch,
  tipSinceLatestRun,
  type AdmissionLookup,
  type DeclaredPlanAt,
  type QueuePlanDescriptor,
} from "./plan-audit.ts"
import {
  createDurablePrNumberMint,
  createExclusive,
  createJournal,
  createReadOnlyJournal,
  importOrphanJournal,
  type MutableJournal,
  type ResolvedRetention,
} from "@yrd/persistence"
import {
  adaptProcessGit,
  cleanGitEnvironment,
  createProcess,
  shellCommand,
  withGitTimeoutRetry,
  type Process,
  type ProcessResult,
  type PathHolderCensus,
  recordedPidIsRunning,
  recordedPidLivenessSync,
  type PathHolderCensusReader,
  type PathHolder,
} from "@yrd/process"
import { createKmIssueSource, withIssues, type IssueSource } from "@yrd/issue"
import { createLogger, type ConditionalLogger } from "loggily"
import { run } from "silvery/runtime"
import { guardScopedPaths } from "./pre-submit-guard-scope.ts"
import { reportReceiverDrainOutcome } from "./receiver-drain-refusal.ts"
import { CHECKOUT_TIMEOUT_ENV, resolveCheckoutTimeoutMs } from "./git-timeouts.ts"
import { observeFreshRemoteBranch, observeOriginBranchAdvertisement, observeOriginRemote } from "./remote-branch.ts"
import {
  implementationSourceIdentity,
  sourceRepositoryFor,
  takeImplementationSourceAttestation,
} from "./implementation-source.ts"
import { ensureWorkspaceDependencies, type LockfileRegenerationEvidence } from "./workspace-provisioning.ts"
import { submoduleManifestDrift } from "./submodule-manifest-drift.ts"
import { withGitIndexLockRetry } from "./git-index-lock-retry.ts"
import {
  declaredStepNames,
  loadYrdConfig,
  mergedTruthExceptions,
  parseYrdConfig,
  stepGateMode,
  validatePushedYrdConfig,
  type ResolvedYrdProjectConfig,
  type YrdStepConfig,
} from "./config.ts"
import { classifyFailure, resolveInvocation, type RuntimePosture } from "./invocation.ts"
import { withLiveRenderer } from "./live-renderer.ts"
import { createYrdLogger, habitantObservability, resolveYrdObservability } from "./observability.ts"
import { formatHabitantLogLine, habitantArtifactHome } from "./runner-timeline.ts"
import { diagnostic } from "./output.tsx"
import { createChangePublicationService } from "./pr-publication.ts"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { repositoryGitDir } from "./repository-authority.ts"
import {
  composeYrdArgv,
  planYrdComposition,
  takeYrdComposition,
  yrdCompositionQueueHelp,
  type YrdCompositionPlan,
} from "./repository-composition.ts"
import {
  YRD_SETTLEMENT_COMMAND,
  prepareYrdSettlementLaunch,
  runYrdSettlementWorker,
  type YrdSettlementLaunch,
} from "./settlement.ts"
import {
  activeHabitantRunner,
  canonicalQueueId,
  isYrdRuntimeReloadRequest,
  habitantRunnerLeaseHeld,
  habitantRunnerStatus,
  runYrdHelp,
  runYrdProcessRuntime,
  runtimeReloadEnv,
  yrdJsonOutputRequested,
  yrdQueueRunnerCheckRequested,
} from "./run.ts"
import { queueStepRevision, type ToolchainFingerprint } from "./host-revision.ts"
import {
  QUEUE_DRAIN_BOUND_MS,
  closeDrainedQueuePass,
  drainedQueuePassExit,
  queuePostureDrains,
  settleDrainedQueuePass,
} from "./queue-drain.ts"
import { retainedWorkspaceNote, type RetainedWorkspace } from "./workspace-retention.ts"
import type {
  YrdCliApp,
  YrdCliCheckResult,
  YrdCliChecks,
  YrdCliExitCode,
  YrdCliGuards,
  YrdCliIO,
  YrdCliQueueAdministration,
  YrdCliServices,
} from "./types.ts"
import type { QueueEnvironmentAuditComparison, QueueEnvironmentAuditEmission } from "./types.ts"
import { createQueueReadModel } from "./queue-read-model.ts"
import { queueReadBases } from "./queue-read-boundary.ts"
import { MergeAuthorityBoundary } from "./merge-authority-boundary.ts"
import { execYrdProcessInPlace } from "./runtime-reload.ts"

type QueueTargetResolver = NonNullable<YrdCliIO["resolveQueueTarget"]>

/** Viewer projections are immutable for one invocation, so they may share one
 * queue-target read. Active postures observe a changing queue and must resolve
 * the target on every cycle; caching it for a habitant turns every later base
 * advance into an endless same-base re-merge loop. */
export function createPostureQueueTargetResolver(
  posture: RuntimePosture,
  resolveTarget: QueueTargetResolver,
): QueueTargetResolver {
  if (posture !== "viewer") return resolveTarget
  const targets = new Map<string, Promise<Readonly<{ base: string; sha: string }>>>()
  return (ref, cwd) => {
    const key = `${cwd}\0${ref}`
    const cached = targets.get(key)
    if (cached !== undefined) return cached
    const recoverable = resolveTarget(ref, cwd).catch((error: unknown) => {
      targets.delete(key)
      throw error
    })
    targets.set(key, recoverable)
    return recoverable
  }
}

type RuntimeStep = StepDef<ChangeShape, ChangeShape>

const RawGitPushPattern = /(?:^|[\n;&|])\s*git\s+push(?:\s|$)/u
const RETIRED_CHANGE_RECORD_CHECKPOINT_IDENTITY = "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691"
/** Durable production predecessors: the pre-restore two-check checkpoint, the
 * three-check checkpoint rewritten by the recovery before this protocol
 * shipped, the pre-quarantine intent contract (intents-v1, no `unreadable`
 * report), and the intents-v2 contract (yrdpin#401, `unreadable` present)
 * that live deployments hold until the intent rail's deletion first migrates
 * them — the intent rail itself (`@yrd/intent`, `state.intents`, its seven
 * `intent/*` events) is gone as of this identity; every one of those events
 * is now unknown-name-quarantined at replay (`@yrd/core`'s unknown-event-name
 * tolerance), and the `intents` slice a checkpoint still carries is dropped
 * explicitly by `migrate` below rather than left to leak forever.
 *
 * ADDING AN ENTRY HERE IS HALF THE JOB. The other half is
 * `SHIPPED_CHECKPOINT_IDENTITIES` in `./checkpoint-bump-gate.ts`, which records
 * what this composition has ever ASKED a deployment to store and turns a
 * version bump that forgets its edge red in the suite instead of red on the
 * fleet's next startup (23217). Retaining costs nothing:
 * `projectionCheckpointIdentity` hashes `v`, `initialState`, `events`,
 * `replayEvents` and `projectionVersions` — migrations are not an input, so no
 * entry added here can move the target identity. */
const RETAINED_PREDECESSOR_CHECKPOINT_IDENTITIES = Object.freeze([
  "fe5e818396dd2c5f9bab6191ab0dd882d9ee584046c618463b4583ff724effe8",
  "0a3476ef91823d46f19770047a4e6462c970c5afc250cba9dd82eb31c5febc25",
  "9697d38f2755d391287f82d8fa976c8eb8177d429a09e151eae087f526e859e7",
  "0106b543f7e02d29dddc830b48352f4188e4ae86c641f4888771c27ce805f6e3",
  // The PRODUCTION composition's intents-v2 identity — what /hh's live
  // journal actually stored after yrdpin#401 migrated it. The entry above is
  // the TEST-app composition's value for the same contract; identities are
  // per-composition (initialState + registered events differ by host
  // options), so a retained edge measured in a harness does not cover a
  // deployment. 2026-08-18: PR1305 shipped with only the harness value and
  // every production boot refused (R2732) until this entry merged — measure
  // retained edges from the production journal's stored identity, never a
  // test app.
  "47f4ac247383142e258574ee2bdc635d51508a1f94621dc1a1482867d271bca7",
  // The PRODUCTION composition's correlation-era identity — what /hh's live
  // journal stored immediately before the props cut (correlation→props,
  // pr/props-set registration) moved every composition's identity. Measured
  // from the production journal itself (journal_snapshot.checkpoint_identity,
  // copy taken 2026-08-19 16:25), cross-checked against the identity embedded
  // in checkpoint_json and its stored sha256 — never from a harness value
  // (the PR1305 lesson above). The checkpoint behind it still spells revision
  // labels `correlation: {namespace, id}`; the migrate callback below folds
  // those to `props` on the way in.
  "227fed2369cdf2a8f3c6a0b63a61bff97d7a46dd60a1fdd7c782ed3b4f69f5e5",
  // The PRODUCTION composition's identity immediately before branch-is-change
  // phase 2a registered `branch/submitted` + `branch/unsubmitted` and gave
  // `bays` its `submits` slice (projectionVersion bays-v14-branch-submits).
  // Measured from the production journal itself — `journal_snapshot.
  // checkpoint_identity` at cursor 69408, copy taken 2026-08-21 02:39 PDT,
  // the embedded `identity` in checkpoint_json agreeing — never from a
  // harness (the PR1305 lesson above). Its checkpoint has no `bays.submits`;
  // `fillMissingStateFromInitial` in the migrate callback below supplies the
  // empty record, and replay resumes after the stored cursor.
  "61773b43456a2943913a6514131c04502a9d26baadedfcf28e4c12bf6d746d37",
  // The PRODUCTION composition immediately before Candidate facts began
  // retaining one-shot component-model authorization evidence. The new field
  // is optional on historical Candidates, so the shared migration callback
  // can preserve the projection verbatim while moving the checkpoint onto the
  // current identity. Measured from the refusal emitted by /hh's live journal
  // on 2026-08-21; this is the deployment identity, not a harness value.
  "063c12e0029825f80853c78e29a4c23cde4e992f3257b806b37ee256b260f691",
  // The PRODUCTION composition immediately before component-model
  // authorization receipts gained stable patch IDs and optional re-merge source
  // proofs. The prior receipt fields remain optional for replay, so the shared
  // migration preserves every stored Candidate verbatim. Measured from the
  // live /hh journal refusal while probing component commit 1ce1967d on
  // 2026-08-22; this is the deployment identity, not a harness value.
  "0150a374820eafd53c72571ff04caffc85acf1c9839c60736299ecd20f2c4657",
  // The PRODUCTION composition currently stored in /hh's live journal
  // (`journal_snapshot.checkpoint_identity` at cursor 76950, read-only
  // 2026-08-22T10:50Z). history_evicted_through=27609 so rebuild from
  // complete history is unavailable; the declared retain list had no edge
  // from this identity (refusal f41d7eff→0150a374). Measured from the
  // production journal itself, never a harness (PR1305 / R2732).
  "f41d7efff8a3d2eb53b47ae8ab6ca3cf4058e2c37ff325a35c848efea94f9fcd",
  // The PRODUCTION composition's identity immediately before the declared step
  // list left `initialState` (23192). Measured from the live journal's own
  // refusal on 2026-08-23 — `yrd pr create` printed the pair
  // 348ade4e→288eb203 with history evicted through cursor 27609, so a rebuild
  // from complete history is unavailable and only a retained edge can carry
  // the deployment across. Never a harness value (the PR1305 / R2732 lesson
  // above); the harness composition now hashes to the same identity anyway,
  // because a config change no longer moves it.
  "348ade4e2dbe135e789387756816d753858f037668bb3a121cb2719802b3b598",
  // The identity the live journal ADVANCED TO while this work was in flight:
  // running the branch build against the deployment migrated its checkpoint
  // onto the interim step-plan identity before the durable plan was deleted.
  // Measured from that journal's own refusal on 2026-08-23 (288eb203→ae0d2084,
  // history evicted through cursor 27609). It is retained because the
  // deployment really is sitting on it — a predecessor is whatever the journal
  // stores, not whatever merged on main.
  "288eb2031f0ae914db51e4fca58add50aa39397abd773be99e81d9a35c06e817",
  // The PRODUCTION composition's identity immediately before the
  // terminal-associations back-fill cut (5e cut 1) removed the
  // pr/terminal-associated event and the queues.terminalAssociations state
  // container. Measured from the production journal itself —
  // journal_snapshot.checkpoint_identity at cursor 90900, read-only copy
  // taken 2026-08-25 18:05 — never a harness value (the PR1305 / R2732
  // lesson above). That checkpoint's terminalAssociations container is
  // empty ({} pending, {} applied) and the history holds zero
  // pr/terminal-associated and zero pr/rejected events, so the migrate
  // callback below only has to drop the dead key.
  "ae0d2084bdb1202cf8205a03b4d09ccf915bcccf197e90afbe62617e7c078839",
  // The PRODUCTION composition's identity immediately before 22991 phase 2's
  // first store-deletion door removed the queues.authority.statuses copy of
  // ChangeDeliveryState from initialState. Measured from the production
  // journal itself — journal_snapshot.checkpoint_identity at cursor 92592,
  // read-only 2026-08-26 — never a harness value (the PR1305 / R2732 lesson
  // above). Pre-flight parity for the drop: all 2084 stored statuses in that
  // checkpoint equal changeDeliveryState of their change record exactly, so
  // the forward callback below can drop the key with zero information loss.
  "701431d5952e57f998e77413fe6c79dfede32f203863a5ff163b07b704ab6c25",
  // The composition immediately before `CandidateChange.containedInBase`
  // (bd1c0b88, 2026-08-28) moved the identity. Not a harness value (the
  // PR1305 / R2732 lesson above): it is the ledger's own superseded last entry
  // in `checkpoint-bump-gate.ts` — what this project has ASKED every
  // deployment to store since 2026-08-26 — and it is what shared main's vendor
  // pin 18d9b83dbb19, the composition the running yrd-runner loads, computes.
  // The new field is optional on historical CandidateChanges, so this edge
  // needs no transformation of its own: the shared callback below preserves
  // every stored record verbatim and the forward callback's drops are all
  // no-ops on a checkpoint this recent.
  "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c",
  // The composition immediately before the queue began retiring standing
  // submit facts (@i/10-yrd/absent-branch-is-terminal, 2026-08-30) moved the
  // identity. Not a harness value (the PR1305 / R2732 lesson above): it is
  // the ledger's own superseded last entry in `checkpoint-bump-gate.ts` —
  // what this project has ASKED every deployment to store since 2026-08-28.
  // The edge needs no transformation of its own: a checkpoint this recent
  // simply lacks `queues.retiredSubmits`, which the shared callback's
  // `fillMissingStateFromInitial` supplies as the empty record, and the
  // forward callback's drops are all no-ops on it.
  "74775b5709b3cf9ef1ef3cfaae63013e486aa09d6386e01bf17d4482557203f1",
  // The composition immediately before lease recovery learned to reclaim a
  // WAITING job (the no-parking ruling, 2026-08-31) moved the identity. Not a
  // harness value (the PR1305 / R2732 lesson above): it is the ledger's own
  // superseded last entry in `checkpoint-bump-gate.ts` — what this project has
  // ASKED every deployment to store since 2026-08-30. The edge needs no
  // transformation of its own: the change widens the `lose` Job transition
  // with two optional keys, so every transition a checkpoint this recent
  // already stores still parses unchanged, and the forward callback's drops
  // are all no-ops on it.
  "1d285ebf24b688b75dbca2c5101a5f1e85cf70ab004a5ca400be89a57daf53d4",
  // The composition immediately before recordless derived identities gained
  // their pre-Candidate branch+sha binding (2026-09-01). This is the ledger's
  // own superseded last entry in `checkpoint-bump-gate.ts`, hence the value a
  // deployment was asked to store. Its checkpoint simply lacks
  // `queues.derivedIdentities`; `fillMissingStateFromInitial` supplies the
  // empty record before replay resumes after the stored cursor.
  "fd6a78dfadab8397265aaa36309c18cb69794cead6b0577f0982f1c1c1ee1f5c",
])

/** Fill state fields a stored checkpoint predates with their initial values.
 *
 * Historical predecessors first migrate to the released 36d85bbb identity,
 * so every field gained before that writer is simply absent from its
 * checkpoint — and replay resumes AFTER the stored cursor, so nothing ever
 * rewrites the missing container. Recurses through plain objects only: a
 * populated container keeps its stored entries (an empty initial Record
 * contributes no keys), arrays and scalars keep the stored value, and only a
 * key with no stored value at all takes the initial one.
 */
export function fillMissingStateFromInitial<T>(initial: unknown, stored: T): T {
  if (stored === undefined) return initial as T
  if (!isPlainStateObject(initial) || !isPlainStateObject(stored)) return stored
  const filled: Record<string, unknown> = { ...stored }
  for (const [key, value] of Object.entries(initial)) {
    filled[key] = fillMissingStateFromInitial(value, filled[key])
  }
  return filled as T
}

function isPlainStateObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Fold every legacy `correlation: {namespace, id}` pair in a stored checkpoint
 * into `props`, recursively.
 *
 * The props cut normalizes journal FRAMES at their read boundary
 * (`normalizeV1CorrelationToProps` rides inside every schema that carries
 * props), but a retained checkpoint's STATE never re-parses through those
 * schemas — it restores structurally. Without this fold a correlation-era
 * checkpoint carries its pairs into a process that only reads `props`: the
 * labels turn invisible to settlement and detail views, and every future
 * checkpoint re-persists them unread forever — the exact leak the intents
 * drop below exists to prevent. Production's pre-props checkpoint holds them
 * in three families (bays.prs.*.revs[], jobs.byId.*.input.prs[],
 * queues.records…prs[]); the walk covers all three and any copy of the same
 * record shape without naming paths. Idempotent, shape-precise (only a
 * `{namespace: string, id: string}` pair folds; anything else is left for the
 * strict schema to refuse loudly), and a no-op on post-props state. */
function foldLegacyCorrelationDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(foldLegacyCorrelationDeep)
  if (!isPlainStateObject(value)) return value
  const folded = normalizeV1CorrelationToProps(value)
  if (!isPlainStateObject(folded)) return folded
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(folded)) {
    result[key] = foldLegacyCorrelationDeep(entry)
  }
  return result
}
const CHECKPOINT_MIGRATION_DERIVATION_TIMEOUT_MS = 60_000

export const CURRENT_JOURNAL_COMPATIBILITY = Object.freeze({
  version: SUPPORTED_VERSIONS.at(-1) ?? 0,
}) satisfies JournalCompatibility

export type DefaultYrdAppOptions = Readonly<{
  repo: string
  stateDir: string
  baysRoot: string
  journal: Journal<unknown>
  process: Pick<Process, "run">
  config: ResolvedYrdProjectConfig
  receiverPath?: string
  workspace?: BayWorkspace
  workspaceLifecycle?: GitWorkspaceLifecycleHooks
  issueSources?: readonly IssueSource[]
  contestRunners?: readonly ContestRunnerDef[]
  contestEvaluators?: readonly ContestEvaluatorDef[]
  contestGit?: CommitResolver
  defaultSubmitter?: string
  scope?: Scope
  log?: ConditionalLogger
  /** Opt-in warm candidate-worktree pool shared across check steps (R40). */
  candidatePool?: CandidatePool
  /** Runtime Runner identity recorded on fresh Jobs. */
  runnerId?: string
  /** Host authority for one-shot component additions/removals. Standalone Yrd
   * deliberately has none and refuses such changes. */
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer
}>

type DefaultYrdRuntimeAppOptions = DefaultYrdAppOptions &
  Readonly<{
    /** Git identity of the native implementation actually loaded by this host. */
    implementationSource?: string
    /** Source root used to derive manifests from the exact target Candidate. */
    implementationRoot?: string
    /** Repository-relative path of the config authority this host resolved
     * (`.yrd.yml` unless the invocation named another). Each Run re-reads THIS
     * path at its own base sha to derive the plan that judges it. */
    configAuthority?: string
  }>

type CheckpointMigrationCertification = Readonly<{
  currentIdentity(): string
  attestCandidate: NonNullable<GitCheckOptions["checkpointMigration"]>
}>

export type DefaultYrdDefinitionOptions = Omit<DefaultYrdRuntimeAppOptions, "journal"> &
  Readonly<{ checkpointMigrationCertification?: CheckpointMigrationCertification }>

function validateConfig(config: ResolvedYrdProjectConfig): void {
  for (const name of config.steps) {
    if (name !== "merge" && config.definitions[name]?.run === undefined) {
      raiseFailure(
        "configuration",
        "step-command-missing",
        `yrd: required check '${name}' requires an inline run definition`,
      )
    }
  }
  if (config.definitions.merge?.runner === "waiting") {
    raiseFailure("configuration", "merge-runner-invalid", "yrd: merge cannot use a waiting runner")
  }
  const mergeIndex = config.steps.indexOf("merge")
  if (mergeIndex >= 0 && config.definitions.merge?.run === undefined) {
    for (const name of config.steps.slice(mergeIndex + 1)) {
      if (RawGitPushPattern.test(config.definitions[name]?.run ?? "")) {
        raiseFailure(
          "configuration",
          "native-merge-post-push",
          `yrd: post-merge step '${name}' cannot push Git refs after the native merge step`,
        )
      }
    }
  }
  for (const evaluator of config.contest.evaluators) {
    if (config.definitions[evaluator]?.run === undefined) {
      raiseFailure(
        "configuration",
        "evaluator-command-missing",
        `yrd: contest evaluator '${evaluator}' requires a configured step command`,
      )
    }
  }
}

const MANAGED_PRE_SUBMIT_MARKER = "# managed-by-yrd: pre-submit-v1"

function annotateRetainedWorkspace(cause: unknown, workspace: RetainedWorkspace): Error {
  const note = retainedWorkspaceNote(workspace)
  const failure = failureFact(cause)
  if (failure !== undefined) {
    return createFailure({ ...failure, message: `${failure.message}; ${note}` }, cause)
  }
  if (cause instanceof Error) return new Error(`${cause.message}; ${note}`, { cause })
  return new Error(`${String(cause)}; ${note}`, { cause })
}

/**
 * The `mkdtemp` prefix EVERY entry under `pre-submit-worktrees` carries. Both
 * shapes created there begin with it — the composed checkout (`check-<rand>/`,
 * holding `worktree/` and `tmp/`) and the in-place run's private TMPDIR
 * (`check-tmp-<rand>/`) — so this one prefix names the whole population the
 * backstop below is permitted to delete, and names nothing else.
 *
 * Bound to the `mkdtemp` calls rather than spelled at each site: a reaper whose
 * prefix has drifted from what is actually created reaps NOTHING, and reports a
 * clean sweep while it does. The directory it sweeps grew to 25 GB across 95
 * entries with no such reaper at all; a silently-inert one is the same outage
 * wearing a green light.
 */
const PRE_SUBMIT_SCRATCH_PREFIX = "check-"

/** Roots already swept in this process — the memo behind `reapAbandonedPreSubmitCheckouts`. */
const reapedPreSubmitRoots = new Set<string>()

/**
 * A namespaced loggily logger rather than `console.warn`, for the reason the
 * queue's own reap site records: `console.warn` prints unconditionally and no
 * `--log-level`/`--quiet`/`LOG_LEVEL` can silence it, while a loggily logger
 * honors all three. A reap is routine housekeeping, not a check verdict, so it
 * must never land on the check's own output.
 */
const preSubmitReapLog = createLogger("yrd:cli")

/**
 * Reclaim pre-submit checkouts abandoned by a process that died before its
 * `finally`.
 *
 * Every ordinary path through `runInCheckout` — success, check failure,
 * composition conflict, materialization failure — removes its own entry. A
 * SIGKILL, an OOM kill or a host crash has no `finally`, and this scratch lives
 * on the repository's own disk (the queue state dir's `pre-submit-worktrees`),
 * so nothing clears it at reboot either. Each abandoned entry is a materialized
 * tree with its submodules populated: measured at 27 GB across 95 entries on
 * 2026-09-01, the oldest stale for 13 days.
 *
 * Placed at CREATION rather than at startup so every entry point pays for the
 * cleanup it might itself leave behind, and memoized per root so an invocation
 * running many checks does not re-walk the root per check.
 *
 * An entry is removed only when its name carries
 * {@link PRE_SUBMIT_SCRATCH_PREFIX}, it has not been written for
 * `ORPHANED_SCRATCH_MAX_AGE_MS` (24h, ~96x `DEFAULT_STEP_TIMEOUT_MS`), and its
 * own {@link writeScratchOwner} record does not claim it — the owning process
 * is still running, or `--keep-on-failure` retained it as evidence.
 *
 * The keep set was previously `git worktree list`, and that is the whole reason
 * this ran for weeks while the directory grew. Measured 2026-09-01 on the live
 * state dir: all 94 abandoned entries were STILL registered worktrees,
 * bidirectionally — each `.git` file named an admin directory that existed, and
 * each of those named the entry back — because a process killed between
 * `worktree add` and its `finally` leaves the registration behind exactly the
 * way it leaves the directory behind. Registration and abandonment are the same
 * on-disk state. Every one of those entries landed in the keep set, the sweep
 * reported a clean run, and nothing was ever freed. A reaper that cannot
 * distinguish what it protects from what it must delete is inert, and it is
 * inert quietly.
 *
 * Dropping that read also removes the other failure this had: when
 * `git worktree list` could not answer, the keep set was unknown, reaping
 * against an unknown keep set was unsafe, and the sweep was skipped entirely.
 * A per-entry record cannot be unavailable, so there is no longer any state in
 * which this declines to run.
 *
 * One sweep line is emitted every time, whatever the outcome, because the
 * failure above was invisible precisely as a silence: a sweep that keeps its
 * whole population reads identically to one with nothing to do unless the
 * counts are spelled out.
 *
 * Entries created before the owner record existed carry none, so they are
 * unowned and fall to the 24h age floor — which is the intended one-time
 * migration: it is what frees the measured 27 GB. A `--keep-on-failure`
 * workspace retained by an older binary is swept with them, and a retained
 * workspace is for immediate inspection, not for storage past a day.
 */
export async function reapAbandonedPreSubmitCheckouts(
  root: string,
  options: Readonly<{ log?: ConditionalLogger; git?: Pick<Git, "run">; repo?: string }> = {},
): Promise<void> {
  const key = resolve(root)
  if (reapedPreSubmitRoots.has(key)) return
  reapedPreSubmitRoots.add(key)
  const log = options.log ?? preSubmitReapLog
  const owners = await liveScratchOwners(key)
  const report = await reapOrphanedScratch(key, {
    keep: owners.live,
    namePrefix: PRE_SUBMIT_SCRATCH_PREFIX,
  })
  // Warn when anything resisted removal — a partial sweep is a disk that keeps
  // filling — and when the sweep freed something, since that is a real state
  // change on shared storage. Everything else is routine housekeeping.
  const record = report.failures.length > 0 ? log.warn : report.reaped > 0 ? log.info : log.debug
  record?.(
    `${describeScratchReap(report)} (${owners.running} owned by a running process, ` +
      `${owners.retained} retained by --keep-on-failure, ${owners.exited} released by an exited owner, ` +
      `${owners.unowned} claimed by nobody)`,
    {
      action: "pre-submit-scratch-reap",
      root: key,
      scanned: report.entries,
      reaped: report.reaped,
      keptLive: report.keptLive,
      keptYoung: report.keptYoung,
      keptForeign: report.keptForeign,
      failed: report.failures.length,
      bytes: report.bytes,
      running: owners.running,
      retained: owners.retained,
      exited: owners.exited,
      unowned: owners.unowned,
    },
  )
  // Reaping the directory leaves git's own registration behind, and those
  // accumulate on the same schedule the directories did — 448 registered
  // worktrees on the measured repository, 94 of them naming entries this sweep
  // is deleting. `prune` drops exactly the ones whose worktree is now gone.
  // Best-effort and never blocking: the disk is already reclaimed, and a git
  // that cannot prune is a smaller problem than one that cannot sweep.
  if (report.reaped > 0 && options.git !== undefined && options.repo !== undefined) {
    const pruned = await options.git.run(options.repo, ["worktree", "prune"], true)
    if (pruned.code !== 0) {
      log.warn?.(
        `yrd: reaped ${report.reaped} abandoned pre-submit checkouts but 'git worktree prune' failed, so their ` +
          `worktree registrations remain: ` +
          `${pruned.stderr.trim() || pruned.stdout.trim() || `git exited ${String(pruned.code)}`}`,
        { action: "pre-submit-scratch-prune-failed", root: key, code: pruned.code },
      )
    }
  }
}

export function configuredChecks(
  process: Pick<Process, "run">,
  stateDir: string,
  config: ResolvedYrdProjectConfig,
  environment: NodeJS.ProcessEnv,
): YrdCliChecks {
  const names =
    config.checks ??
    config.steps.filter(
      (name) => (config.definitions[name]?.kind ?? (name === "merge" ? "merge" : "check")) === "check",
    )
  const hook = join(stateDir, "hooks", "pre-submit")
  const repo = resolve(stateDir, "../..")
  const runInCheckout = async (
    name: string,
    definition: YrdStepConfig,
    cwd: string,
    ref: string | undefined,
    keepOnFailure: boolean,
    carrier: boolean,
  ): Promise<YrdCliCheckResult> => {
    const baseSha = await resolveCommit(process, repo, config.base)
    if (baseSha === undefined) {
      raiseFailure(
        "configuration",
        "required-check-base-missing",
        `yrd: required-check base '${config.base}' is missing`,
      )
    }
    const candidateSha = await resolveCommit(process, ref === undefined ? cwd : repo, ref ?? "HEAD")
    if (candidateSha === undefined) {
      raiseFailure(
        "configuration",
        "required-check-candidate-missing",
        `yrd: required-check candidate '${ref ?? "HEAD"}' is missing`,
      )
    }
    // The other shape of the same nothing: a carrier whose tip IS the base.
    // Nothing composes, so the collapse below never fires, and the pair is
    // degenerate from the first line — the check would compare a commit
    // against itself and report a verdict about a range that holds no commits.
    //
    // Only for a carrier. `yrd check` judges whatever tree it was pointed at,
    // and pointing it at a tree sitting on the base is an ordinary local
    // reading (22600 does exactly that); a submit or a ready is judging
    // something that has to CARRY a change, and one that carries nothing is a
    // no-op carrier the queue would have nothing to merge.
    if (carrier && candidateSha === baseSha) {
      raiseFailure(
        "refusal",
        "required-check-degenerate-range",
        `yrd: required check '${name}' has no candidate range: candidate '${ref ?? "HEAD"}' and base ` +
          `'${config.base}' are the same commit ${baseSha}, so this carrier adds nothing to its base and the ` +
          `check would compare ${baseSha} against itself. Nothing would be measured, so no verdict was ` +
          `computed. Commit the work this change is meant to carry before submitting it.`,
      )
    }
    const inherited = cleanGitEnvironment(environment)
    const declared = Object.fromEntries(
      (definition.environmentPassthrough ?? []).flatMap((name) =>
        environment[name] === undefined ? [] : [[name, environment[name]]],
      ),
    )
    const environmentFor = (candidate: string, tmpDir?: string) => ({
      ...inherited,
      ...declared,
      // Heavy checks write whole fixture trees through TMPDIR, and the
      // inherited value usually points at a small tmpfs /tmp whose per-user
      // quota mid-run turns a green candidate into dozens of spurious EDQUOT
      // suite failures. Every run gets a run-scoped tmp dir on the
      // repository's own filesystem instead; a check definition's env.TMPDIR
      // still wins.
      ...(tmpDir === undefined ? {} : { TMPDIR: tmpDir }),
      ...definition.env,
      YRD_REPO: repo,
      YRD_BASE_SHA: baseSha,
      YRD_CANDIDATE_SHA: candidate,
      ...(definition.environment === undefined ? {} : { YRD_ENVIRONMENT: definition.environment }),
    })
    const run = (workingDirectory: string, candidate: string, tmpDir?: string) =>
      process.run({
        argv: shellCommand(definition.run ?? ""),
        cwd: workingDirectory,
        env: environmentFor(candidate, tmpDir),
        timeoutMs: stepTimeoutMs(definition),
      })
    // A required check has to judge what the queue will judge: the candidate
    // composed onto current base, which is what gitCheckStep receives once
    // prepareCandidate has merged. Judging the raw branch tip instead refuses
    // ordinary staleness the queue absorbs — an ancestry-shaped check reads its
    // own base as unreachable, and a tree-reading check misses whatever main
    // fixed after the branch diverged.
    //
    // When base is already an ancestor the composition IS the candidate, so an
    // up-to-date branch keeps the old path and pays one ancestry probe. Only a
    // stale candidate composes. That diverts a stale in-place run into a
    // checkout, which stops the check from seeing uncommitted work — and
    // YRD_CANDIDATE_SHA has always named a commit, never the working tree, so
    // the composed checkout is the honest materialization of what was declared.
    const composes = !(await isAncestorCommit(process, repo, baseSha, candidateSha))
    // Composition is a no-op when the candidate is ALREADY reachable from base:
    // `git merge --no-ff <ancestor>` answers "Already up to date.", exits 0 and
    // leaves HEAD where it was, so the composed candidate IS the base and the
    // pair handed to every check is X..X — a range containing nothing.
    //
    // Measured on `task/hub-yrd-split-brain` (2026-08-28): the branch had been
    // fast-forwarded onto an earlier main, main moved on, so base was NOT an
    // ancestor of the candidate (this composes) while the candidate WAS
    // reachable from base (the merge did nothing). Both variables named
    // 136fb282ac4d. `typecheck` and `manifest-co-change` then passed VACUOUSLY
    // on the empty range — an ancestry-shaped check reads `X is an ancestor of
    // X` as yes for free — and only `substrate-pair` refused. Two green
    // verdicts over nothing is the silent error; the third check catching it
    // was luck, not design.
    //
    // Probed here rather than after the merge because everything below this
    // line is minutes of worktree, submodule population and workspace install
    // spent on a candidate that cannot be measured at all.
    if (composes && (await isAncestorCommit(process, repo, candidateSha, baseSha))) {
      raiseFailure(
        "refusal",
        "required-check-degenerate-range",
        `yrd: required check '${name}' has no candidate range: candidate ${candidateSha} is already reachable ` +
          `from base '${config.base}' (${baseSha}), so composing it onto the base is a no-op and both ` +
          `YRD_BASE_SHA and YRD_CANDIDATE_SHA would name ${baseSha}. Nothing would be measured, so no verdict ` +
          `was computed — a check that compares a base against a candidate means nothing when they are the same ` +
          `commit. This is what an already-landed branch looks like once it has been fast-forwarded onto the ` +
          `base: commit the work this branch is meant to carry, or withdraw the change. Re-submitting the same ` +
          `tip refuses here again.`,
      )
    }
    // A check with base-pinned gate scripts (23183) never runs in the invoking
    // tree: pinning would mean OVERWRITING files in the author's own checkout.
    // It always executes in a materialized checkout, where the declared paths
    // are overlaid with the base's version before the command starts.
    const pinnedScripts = definition.scripts ?? []
    const parent = join(stateDir, "pre-submit-worktrees")
    mkdirSync(parent, { recursive: true })
    // The backstop for entries no `finally` ever reached, run before this
    // invocation adds one of its own. `GIT_TIMEOUT_MS` because the only git
    // call behind it is one `worktree list --porcelain` plumbing read, not the
    // checkout work `checkoutTimeoutMs` bounds.
    //
    // When that read fails the keep set is UNKNOWN, not empty, and the sweep
    // is skipped with a line naming why. The alternative — reaping against an
    // empty keep set — would delete a retained `keepOnFailure` workspace on the
    // strength of a git fault, silently, which is a worse failure than a sweep
    // that did not happen: the next process sweeps again, and a persistent
    // fault says so every time.
    await reapAbandonedPreSubmitCheckouts(parent, {
      git: createGit(adaptProcessGit(process), inherited, GIT_TIMEOUT_MS),
      repo,
    })
    if (ref === undefined && !composes && pinnedScripts.length === 0) {
      const inPlaceTmp = await mkdtemp(join(parent, `${PRE_SUBMIT_SCRATCH_PREFIX}tmp-`))
      try {
        return await run(cwd, candidateSha, inPlaceTmp)
      } finally {
        await rm(inPlaceTmp, { recursive: true, force: true })
      }
    }

    const checkoutSha = composes ? baseSha : candidateSha
    const checkoutRoot = await mkdtemp(join(parent, PRE_SUBMIT_SCRATCH_PREFIX))
    // Claim the entry before anything expensive goes into it, so a process
    // killed mid-materialization leaves a record naming a pid that is provably
    // gone rather than an entry nothing can classify. `retained` is decided
    // here because it can only ever be READ on an entry that survived: every
    // path below removes the whole entry unless `keepOnFailure` held and the
    // run failed.
    await writeScratchOwner(checkoutRoot, {
      pid: globalThis.process.pid,
      startedAtMs: Date.now(),
      ...(keepOnFailure ? { retained: true } : {}),
    })
    const checkout = join(checkoutRoot, "worktree")
    // Lives and dies with checkoutRoot; retained alongside a kept failure
    // workspace, where leftover fixture temp is evidence rather than litter.
    const checkTmp = join(checkoutRoot, "tmp")
    mkdirSync(checkTmp, { recursive: true })
    // Candidate materialization is trusted Yrd plumbing. Repository hooks run
    // in that process by default, so the shared worktree capability quarantines
    // hooks instead of exposing Yrd's ambient authority to hook code.
    const checkoutTimeoutMs = resolveCheckoutTimeoutMs(environment)
    let worktrees: Awaited<ReturnType<typeof createGitWorktreeStore>>
    try {
      worktrees = createGitWorktreeStore({
        repo,
        gitProcess: adaptProcessGit(process),
        env: inherited,
        timeouts: { operation: checkoutTimeoutMs, cleanup: checkoutTimeoutMs },
      })
      await worktrees.add({
        kind: "detached",
        path: checkout,
        ref: checkoutSha,
        hooks: "quarantine",
        operation: `CLI pre-submit worktree add ${checkoutSha}`,
      })
    } catch (cause) {
      if (!keepOnFailure) await rm(checkoutRoot, { recursive: true, force: true })
      const message = cause instanceof Error ? cause.message : String(cause)
      const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkoutRoot, cleanup: "directory" })}` : ""
      if (/timed out after/iu.test(message)) {
        raiseFailure(
          "infrastructure",
          "required-check-checkout-timeout",
          `yrd: pre-submit checkout of '${candidateSha}' exceeded ${checkoutTimeoutMs}ms during 'git worktree add'; raise ${CHECKOUT_TIMEOUT_ENV} or retry under lower load${retained}`,
        )
      }
      raiseFailure(
        "infrastructure",
        "required-check-checkout-failed",
        `${message || `yrd: could not materialize required-check candidate '${candidateSha}'`}${retained}`,
      )
    }
    let candidate = candidateSha
    if (composes) {
      const merged = await worktrees.git.run(
        checkout,
        ["merge", "--no-ff", "-m", `pre-submit: compose ${candidateSha} onto ${baseSha}`, candidateSha],
        true,
      )
      if (merged.code !== 0) {
        await worktrees.git.run(checkout, ["merge", "--abort"], true)
        const detail = merged.stderr.trim() || merged.stdout.trim() || `git merge exited ${String(merged.code)}`
        if (!keepOnFailure) {
          await worktrees.remove(checkout, {
            operation: `CLI pre-submit failed-composition cleanup ${candidateSha}`,
          })
          await rm(checkoutRoot, { recursive: true, force: true })
        }
        const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkout, cleanup: "worktree" })}` : ""
        // Only a real conflict reaches here. Ordinary staleness composed above,
        // so this names the one thing the author still has to do by hand.
        raiseFailure(
          "refusal",
          "required-check-composition-conflict",
          `yrd: required-check candidate '${candidateSha}' conflicts with base '${baseSha}': ${detail}; ` +
            `merge base '${config.base}' into the change's branch, resolve the conflict, ` +
            `then push and run 'yrd pr submit <branch>'` +
            retained,
        )
      }
      const composed = await resolveCommit(process, checkout, "HEAD")
      if (composed === undefined) {
        raiseFailure(
          "infrastructure",
          "required-check-composition-missing",
          `yrd: composing required-check candidate '${candidateSha}' onto base '${baseSha}' left no commit in '${checkout}'`,
        )
      }
      // The invariant, asserted where the pair is MANUFACTURED: no check is
      // ever handed X..X. The containment probe above already refuses the one
      // known way to land here, and it is a probe — `isAncestorCommit` reads a
      // non-zero exit as "not an ancestor", so a git that errored rather than
      // answered falls through to this merge and composes nothing. That is the
      // case this catches, and it is Yrd's own reasoning disagreeing with
      // itself rather than anything the author can repair, so it is
      // infrastructure and not a refusal.
      if (composed === baseSha) {
        if (!keepOnFailure) {
          await worktrees.remove(checkout, {
            operation: `CLI pre-submit degenerate-composition cleanup ${candidateSha}`,
          })
          await rm(checkoutRoot, { recursive: true, force: true })
        }
        const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkout, cleanup: "worktree" })}` : ""
        raiseFailure(
          "infrastructure",
          "required-check-composition-degenerate",
          `yrd: composing required-check candidate '${candidateSha}' onto base '${baseSha}' produced the base ` +
            `itself, so required check '${name}' would compare ${baseSha} against ${baseSha} and measure nothing. ` +
            `The candidate is already reachable from the base and Yrd's containment probe did not answer that ` +
            `before the merge ran. No verdict was computed${retained}`,
        )
      }
      candidate = composed
    }
    // The hook quarantine above also silences the repository hook that used to
    // populate submodules on checkout, so a submodule-backed workspace member
    // would be missing and provisioning would fail with 'workspace:* failed to
    // resolve'. Populate them here as trusted Yrd plumbing, under the same
    // quarantine so submodule checkouts cannot run hook code either (22755).
    try {
      await worktrees.materializeSubmodules(checkout, { hooks: "quarantine" })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!keepOnFailure) {
        try {
          await worktrees.remove(checkout, {
            operation: `CLI pre-submit failed-materialization cleanup ${candidateSha}`,
          })
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            `yrd: pre-submit submodule population failed and checkout cleanup also failed: ${message}`,
            { cause },
          )
        }
        await rm(checkoutRoot, { recursive: true, force: true })
      }
      const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkout, cleanup: "worktree" })}` : ""
      if (/timed out after/iu.test(message)) {
        raiseFailure(
          "infrastructure",
          "required-check-checkout-timeout",
          `yrd: pre-submit submodule population of '${candidateSha}' exceeded ${checkoutTimeoutMs}ms during 'git submodule update'; raise ${CHECKOUT_TIMEOUT_ENV} or retry under lower load${retained}`,
        )
      }
      raiseFailure(
        "infrastructure",
        "required-check-submodule-populate-failed",
        `${message || `yrd: could not populate submodules for required-check candidate '${candidateSha}' in ${checkout}`}${retained}`,
      )
    }
    let failed = true
    try {
      await ensureWorkspaceDependencies(process, {
        path: checkout,
        subject: `required check '${name}' workspace`,
        manifestSubject: "candidate",
        env: environmentFor(candidate, checkTmp),
        fail(message) {
          raiseFailure("infrastructure", "candidate-provision-failed", `yrd: ${message}`)
        },
      })
      if (pinnedScripts.length > 0) {
        // 23183: the declared gate scripts read as the base's version for this
        // check. No restore — the checkout is destroyed after the run, and a
        // retained failure workspace honestly shows the scripts that judged it.
        await overlayGateScripts(
          {
            run: async (cwd, args) => {
              const outcome = await process.run({ argv: ["git", "-C", cwd, ...args], cwd, env: inherited })
              return { code: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }
            },
          },
          checkout,
          baseSha,
          candidate,
          pinnedScripts,
        )
      }
      const result = await run(checkout, candidate, checkTmp)
      failed = result.exitCode !== 0 || result.timedOut
      if (!failed || !keepOnFailure) return result
      return { ...result, retainedWorkspace: { path: checkout, cleanup: "worktree" } }
    } catch (cause) {
      if (keepOnFailure) throw annotateRetainedWorkspace(cause, { path: checkout, cleanup: "worktree" })
      throw cause
    } finally {
      if (!keepOnFailure || !failed) {
        try {
          await worktrees.remove(checkout, { operation: `CLI pre-submit worktree remove ${candidateSha}` })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          raiseFailure(
            "infrastructure",
            "required-check-checkout-cleanup-failed",
            /timed out after/iu.test(message)
              ? `yrd: required-check checkout removal of '${checkout}' exceeded ${checkoutTimeoutMs}ms; raise ${CHECKOUT_TIMEOUT_ENV} or retry under lower load`
              : message || `yrd: could not remove required-check checkout '${checkout}'`,
          )
        }
        await rm(checkoutRoot, { recursive: true, force: true })
      }
    }
  }
  return Object.freeze({
    names: Object.freeze([...names]),
    async run(name, cwd, context) {
      if (!names.includes(name)) {
        raiseFailure(
          "configuration",
          "required-check-unknown",
          `yrd: required check '${name}' is not configured (configured: ${names.join(", ") || "none"})`,
        )
      }
      const definition = config.definitions[name]
      if (definition?.run === undefined) {
        raiseFailure("configuration", "required-check-command-missing", `yrd: required check '${name}' has no command`)
      }
      return runInCheckout(
        name,
        definition,
        cwd,
        context?.ref,
        context?.keepOnFailure === true,
        context?.carrier === true,
      )
    },
    install(_cwd) {
      mkdirSync(join(stateDir, "hooks"), { recursive: true })
      let existing: string | undefined
      try {
        existing = readFileSync(hook, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (existing !== undefined && !existing.includes(MANAGED_PRE_SUBMIT_MARKER)) {
        raiseFailure(
          "refusal",
          "pre-submit-hook-unmanaged",
          `yrd: will not replace the unmanaged pre-submit hook at '${hook}'`,
        )
      }
      // Guards run FIRST and short-circuit. The whole point of a guard is that
      // it refuses in one process spawn, so letting a materializing check run
      // ahead of it would pay the price the guard exists to avoid. The line is
      // emitted only when guards are configured, so a repository with none
      // keeps a byte-identical hook and no reinstall churn.
      const guard = (config.guards ?? []).length === 0 ? "" : "yrd guard || exit $?\n"
      const command = names.length === 0 ? "exit 0" : `exec yrd check ${names.join(" ")}`
      const source = `#!/bin/sh\n${MANAGED_PRE_SUBMIT_MARKER}\n${guard}${command}\n`
      if (existing !== source) writeFileSync(hook, source, { encoding: "utf8", mode: 0o755 })
      chmodSync(hook, 0o755)
      return Promise.resolve(hook)
    },
  })
}

/**
 * The one wall-clock bound a guard gets when it declares none. Generous for a
 * lint over a diff and short enough that a wedged guard cannot masquerade as a
 * slow submit — a guard exists precisely because the author is waiting.
 */
const DEFAULT_GUARD_TIMEOUT_MS = 60_000

/**
 * Pre-submit guards: the cheap, in-lane half of the local gate.
 *
 * A required check answers "would this merge green?" and pays for that answer
 * with a quarantined worktree, a submodule population and a workspace install —
 * minutes, per candidate. That price is right for a merge gate and wrong for
 * an authoring rule. When the only thing wrong with a carrier is that a bead's
 * H1 is twelve characters too long, the author learns it two minutes after
 * submitting, having already consumed a queue slot, and pays the whole round
 * trip again for a one-word edit.
 *
 * A guard is the other shape. It runs in the author's own working repository,
 * in one process spawn, BEFORE the revision is registered — so a refusal costs
 * no queue slot and merges while the author is still looking at the terminal. It
 * is deliberately NOT re-run by the Queue against the Candidate: a guard is an
 * authoring rule, not merge evidence, and re-running it there would put a
 * lint in the merge path where a check belongs.
 *
 *   check                            guard
 *   ─────                            ─────
 *   quarantined checkout of the      the invoking working repository
 *     exact candidate
 *   `yrd check`, submit, AND the     submit and ready only
 *     Queue before merge
 *   minutes                          one spawn
 *   the merge gate                 authoring hygiene
 *
 * Yrd stays repository-agnostic: it owns WHEN a guard runs, WHAT it is told
 * (base and candidate SHAs, in the environment) and HOW a refusal surfaces,
 * while the repository owns the command and the paths it cares about. Nothing
 * here knows what the guard is checking.
 *
 * NO SILENT ERRORS: an unknown guard name, an unresolvable base, an
 * unresolvable candidate, a diff that could not be computed and a timeout all
 * raise. Only a computed, empty path intersection skips a guard, and that skip
 * reports the globs that produced it rather than passing quietly.
 */
export function configuredGuards(
  process: Pick<Process, "run">,
  stateDir: string,
  config: ResolvedYrdProjectConfig,
  environment: NodeJS.ProcessEnv,
): YrdCliGuards {
  const repo = resolve(stateDir, "../..")
  const names = config.guards ?? []
  return Object.freeze({
    names: Object.freeze([...names]),
    async run(name, context) {
      const definition = config.guardDefinitions?.[name]
      if (definition === undefined) {
        raiseFailure(
          "configuration",
          "pre-submit-guard-unknown",
          `yrd: pre-submit guard '${name}' is not configured (configured: ${names.join(", ") || "none"})`,
        )
      }
      const baseSha = await resolveCommit(process, repo, config.base)
      if (baseSha === undefined) {
        raiseFailure(
          "configuration",
          "pre-submit-guard-base-missing",
          `yrd: pre-submit guard base '${config.base}' is missing`,
        )
      }
      // Where the candidate actually lives. `pr submit` hands us a Bay's own
      // worktree with no ref — its HEAD is the candidate, and resolving HEAD in
      // the main repository instead would silently guard a different commit
      // than the one being submitted. An explicit ref names a commit the
      // repository owns, so that one resolves against the repository.
      const candidateTree = context?.cwd ?? repo
      const candidateRef = context?.ref ?? "HEAD"
      const candidateSha = await resolveCommit(process, context?.ref === undefined ? candidateTree : repo, candidateRef)
      if (candidateSha === undefined) {
        raiseFailure(
          "configuration",
          "pre-submit-guard-candidate-missing",
          `yrd: pre-submit guard candidate '${candidateRef}' is missing`,
        )
      }
      if (definition.paths !== undefined) {
        const changed = await changedCandidatePaths(process, candidateTree, baseSha, candidateSha)
        if (guardScopedPaths(changed, definition.paths).length === 0) {
          return {
            name,
            status: "skipped",
            candidateSha,
            reason: `no path changed by ${candidateSha} matches ${definition.paths.join(", ")}`,
          }
        }
      }
      const timeoutMs = definition.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS
      const result = await process.run({
        argv: shellCommand(definition.run),
        cwd: candidateTree,
        env: {
          ...cleanGitEnvironment(environment),
          ...Object.fromEntries(
            (definition.environmentPassthrough ?? []).flatMap((passed) =>
              environment[passed] === undefined ? [] : [[passed, environment[passed]]],
            ),
          ),
          ...definition.env,
          YRD_REPO: repo,
          YRD_BASE_SHA: baseSha,
          YRD_CANDIDATE_SHA: candidateSha,
          YRD_GUARD: name,
        },
        timeoutMs,
      })
      if (result.timedOut) {
        raiseFailure(
          "infrastructure",
          "pre-submit-guard-timeout",
          `yrd: pre-submit guard '${name}' exceeded ${timeoutMs}ms before it produced a verdict`,
        )
      }
      // A killed guard never reached a verdict, so it is infrastructure, not a
      // refusal. Collapsing the two would tell an author to fix their carrier
      // because the OOM killer arrived — the most expensive wrong direction,
      // since the carrier is fine and the edit they make in response cannot help.
      if (result.signal === "SIGKILL" || (result.signal === null && result.exitCode === 137)) {
        raiseFailure(
          "infrastructure",
          "pre-submit-guard-signal",
          `yrd: pre-submit guard '${name}' ended by SIGKILL (exit ${String(result.exitCode)}) before it produced a verdict`,
        )
      }
      if (result.exitCode !== 0) {
        // The guard's OWN diagnostic is the entire product here — it is the half
        // that names the file, the measurement and the minimum repair, and Yrd
        // cannot reconstruct any of it. Passed through verbatim rather than
        // summarized into an exit code.
        const detail = result.stderr.trim() || result.stdout.trim() || `exited ${String(result.exitCode)}`
        raiseFailure("refusal", "pre-submit-guard-failed", `yrd: pre-submit guard '${name}' refused: ${detail}`)
      }
      return { name, status: "passed", candidateSha, stdout: result.stdout }
    },
  })
}

/**
 * The files the candidate changed relative to where it forked from base.
 *
 * Three-dot on purpose. Two-dot would also list everything base gained since
 * the fork, so a guard would be handed files the author never touched and a
 * long-lived branch would be refused for somebody else's edit.
 */
async function changedCandidatePaths(
  process: Pick<Process, "run">,
  repo: string,
  baseSha: string,
  candidateSha: string,
): Promise<readonly string[]> {
  const result = await process.run({
    argv: ["git", "diff", "--name-only", `${baseSha}...${candidateSha}`],
    cwd: repo,
  })
  if (result.exitCode !== 0) {
    raiseFailure(
      "infrastructure",
      "pre-submit-guard-scope-failed",
      `yrd: could not determine what '${candidateSha}' changed against '${baseSha}': ` +
        (result.stderr.trim() || `git diff exited ${String(result.exitCode)}`),
    )
  }
  return result.stdout.split("\n").filter((line) => line !== "")
}

function hostToolchainFingerprint(): ToolchainFingerprint {
  return {
    bun: Bun.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }
}

function contestEvaluatorRevision(
  repo: string,
  stateDir: string,
  checkoutParent: string,
  name: string,
  config: YrdStepConfig,
  timeoutMs: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation: "yrd-contest-command-v3",
        repo,
        stateDir,
        checkoutParent,
        name,
        run: config.run,
        runner: config.runner,
        environment: config.environment,
        timeoutMs,
      }),
    )
    .digest("hex")
}

function eraseStep<Input extends ChangeShape, Output extends ChangeShape>(step: StepDef<Input, Output>): RuntimeStep {
  return step as unknown as RuntimeStep
}

/**
 * The ONE default wall-clock bound for a queue step's local command (21012 S1).
 * Generous by design — a legitimate broad local gate takes minutes; only a
 * wedged process tree exceeds it. Declarative override: `timeoutMs` on the
 * step config. Applies to the local command execution of BOTH runners (a
 * waiting step's LAUNCHER is still a local command); the remote work behind a
 * waiting step is governed by the remote system's own timeout. Policy lives
 * HERE (host), mechanism lives in @yrd/process — never bound inside the lib.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60_000
const GIT_TIMEOUT_MS = 30_000

function assertGitDidNotTimeOut(result: Pick<ProcessResult, "timedOut">, args: readonly string[]): void {
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
}

/** Effective wall-clock bound for a step: declared, else the host default. */
export function stepTimeoutMs(config: YrdStepConfig): number {
  return config.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
}

/**
 * The default no-output-progress bound for a queue step's local command. A
 * step that emits its banner then goes SILENT — a wedged child that neither
 * progresses nor exits, the 2026-07-16 R423 failure — is caught here: sooner
 * and more specifically than the coarse wall-clock DEFAULT_STEP_TIMEOUT_MS,
 * and it fails LOUDLY as `<step>-stalled` with a STALLED verdict in the
 * evidence instead of leaving the queue awaiting a pipe only SIGKILL can free.
 * Kept strictly below the wall-clock bound so silence stalls before it times
 * out, yet generous enough that a legitimately slow-but-progressing gate
 * (which resets the lease on every byte) never trips it. Declarative override:
 * `noProgressMs` on the step config. Policy lives HERE (host); mechanism lives
 * in @yrd/process — never bound inside the lib.
 */
export const DEFAULT_STEP_NO_PROGRESS_MS = 10 * 60_000

/** Effective no-output-progress bound for a step: declared, else the host default. */
export function stepNoProgressMs(config: YrdStepConfig): number {
  return config.noProgressMs ?? DEFAULT_STEP_NO_PROGRESS_MS
}

function stepCommand(name: string, config: YrdStepConfig): string {
  if (config.run === undefined) throw new Error(`yrd: queue step '${name}' has no command`)
  return config.run
}

/**
 * Disclose a regenerated lockfile as a run artifact.
 *
 * A relaxed install resolves dependencies nobody committed, so the run must be
 * able to say which submodule manifests forced it and what the lockfile became.
 * Written next to the step's other artifacts so it travels with the evidence
 * an operator already reads; a disclosure that cannot be written is itself a
 * provisioning failure, never a silent success.
 */
function recordLockfileRegeneration(artifactRoot: string, step: string, evidence: LockfileRegenerationEvidence): void {
  const directory = join(artifactRoot, "lockfile-regeneration")
  const file = join(directory, `${step}-${evidence.after.sha256.slice(0, 12)}.json`)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, `${JSON.stringify({ step, ...evidence }, undefined, 2)}\n`)
  } catch (cause) {
    raiseFailure(
      "infrastructure",
      "candidate-provision-failed",
      `yrd: candidate provisioning '${step}' regenerated '${evidence.lockfile}' in ${evidence.path} but could not ` +
        `disclose it to '${file}': ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/** Provision a manifest-changing pin before Queue fixes the Candidate identity.
 * The callback may generate exactly bun.lock; @yrd/queue owns staging and the
 * final samePaths proof so checked bytes and merged bytes cannot diverge. */
export function createPinIntentProvisioner(
  options: Readonly<{
    process: Pick<Process, "run">
    repo: string
    artifactRoot: string
    materializeSubmodules?: (path: string) => Promise<void>
  }>,
): PinIntentProvisioner {
  return async ({ path, baseSha, provisionalCandidateSha }) => {
    const provisionFailure: (message: string) => never = (message) =>
      raiseFailure("infrastructure", "candidate-provision-failed", `yrd: ${message}`)
    if (options.materializeSubmodules === undefined) {
      const worktrees = createGitWorktreeStore({
        repo: options.repo,
        gitProcess: adaptProcessGit(options.process),
      })
      await worktrees.materializeSubmodules(path, { hooks: "quarantine" })
    } else {
      await options.materializeSubmodules(path)
    }
    const drifts = await submoduleManifestDrift(options.process, {
      repo: options.repo,
      workspace: path,
      baseSha,
      candidateSha: provisionalCandidateSha,
      fail: provisionFailure,
    })
    const manifests = drifts.flatMap((drift) => drift.manifests)
    if (manifests.length === 0) return { generatedPaths: [] }

    let regeneration: LockfileRegenerationEvidence | undefined
    await ensureWorkspaceDependencies(options.process, {
      path,
      subject: "pin-intent candidate workspace",
      manifestSubject: "candidate",
      lockfileRegeneration: {
        changedSubmoduleManifests: () => Promise.resolve(manifests),
        record(evidence) {
          regeneration = evidence
          recordLockfileRegeneration(
            options.artifactRoot,
            `candidate-${provisionalCandidateSha.slice(0, 12)}`,
            evidence,
          )
        },
      },
      fail: provisionFailure,
    })
    if (regeneration === undefined || !regeneration.lockfileChanged) return { generatedPaths: [] }
    if (regeneration.lockfile !== "bun.lock") {
      provisionFailure(
        `pin-intent provisioning generated unsupported lockfile '${regeneration.lockfile}'; allowed [bun.lock]`,
      )
    }
    return { generatedPaths: [regeneration.lockfile] }
  }
}

function candidateStep(
  process: Pick<Process, "run">,
  repo: string,
  stateDir: string,
  checkoutParent: string,
  name: string,
  config: YrdStepConfig,
  revision: string,
  candidatePool: CandidatePool | undefined,
  kind: "check" | "action",
  checkpointMigration?: NonNullable<GitCheckOptions["checkpointMigration"]>,
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer,
): RuntimeStep {
  const command = shellCommand(stepCommand(name, config))
  const checkProcess: Pick<Process, "run"> = {
    async run(request) {
      if (
        request.argv.length === command.length &&
        request.argv.every((argument, index) => argument === command[index])
      ) {
        if (request.cwd === undefined) {
          raiseFailure(
            "infrastructure",
            "candidate-provision-failed",
            `yrd: required check '${name}' has no candidate working directory to provision`,
          )
        }
        const workspacePath = request.cwd
        // Annotated, not inferred: control-flow narrowing past a never-returning
        // call only happens when the callee's type is declared explicitly.
        const provisionFailure: (message: string) => never = (message) =>
          raiseFailure("infrastructure", "candidate-provision-failed", `yrd: ${message}`)
        await ensureWorkspaceDependencies(process, {
          path: workspacePath,
          subject: `required check '${name}' workspace`,
          manifestSubject: "candidate",
          ...(request.env === undefined ? {} : { env: request.env }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          fail: provisionFailure,
        })
      }
      return process.run(request)
    },
  }
  return eraseStep(
    withStep(
      name,
      gitCheckStep({
        inject: { process: checkProcess },
        repo,
        command,
        checkoutParent,
        artifactRoot: join(stateDir, "artifacts"),
        // Candidates this step reconstructs itself (no runner context) still
        // regenerate the lock inside the shaset commit — the runner-context
        // path gets the same provisioner through prepareCandidate.
        provisionPinIntent: createPinIntentProvisioner({
          process,
          repo,
          artifactRoot: join(stateDir, "artifacts"),
        }),
        purpose: name,
        runner: config.runner,
        mode: stepGateMode(config),
        classification: config.classification ?? "carrier",
        ...(config.scripts === undefined ? {} : { scripts: config.scripts }),
        ...(config.comparison === undefined ? {} : { comparison: config.comparison }),
        ...(config.comparisonReady === undefined ? {} : { comparisonReady: config.comparisonReady }),
        timeoutMs: stepTimeoutMs(config),
        noProgressTimeoutMs: stepNoProgressMs(config),
        ...(config.environment === undefined ? {} : { environment: config.environment }),
        ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
        ...(config.environmentPassthrough === undefined
          ? {}
          : { environmentPassthrough: config.environmentPassthrough }),
        ...(candidatePool === undefined ? {} : { candidatePool }),
        ...(checkpointMigration === undefined ? {} : { checkpointMigration }),
        ...(authorizeSubmoduleModelChange === undefined ? {} : { authorizeSubmoduleModelChange }),
      }),
      {
        revision,
        kind,
        classification: config.classification ?? "carrier",
      },
    ),
  )
}

/**
 * Derive the installed-step descriptor — identity, integration contract, and
 * revision — for every configured step. This is the ONE home for the descriptor
 * recipe: {@link configuredQueueSteps} wires its runtime machinery around these
 * revisions, and the environment audit re-derives from a freshly loaded config
 * through this same function, so drift detection always proves the CURRENT
 * on-disk config rather than a startup snapshot.
 */
/** Object shas of every declared gate script, at ONE exact ref, sorted so the
 * revision digest is stable. Absent when this config declares none. */
export type GateScriptShas = Readonly<Record<string, string>>

/** The per-step slice of the resolved gate-script shas, in sorted-path order.
 * A declared path the resolution did not cover is a programming error — the
 * resolver and this projection read the same config — and refuses loudly
 * rather than deriving a revision that silently omits the script identity. */
function stepGateScriptShas(
  name: string,
  stepConfig: YrdStepConfig,
  resolved: GateScriptShas | undefined,
): Readonly<Record<string, string>> | undefined {
  if (stepConfig.scripts === undefined) return undefined
  const entries = [...stepConfig.scripts].toSorted().map((path) => {
    const sha = resolved?.[path]
    if (sha === undefined) {
      raiseFailure(
        "configuration",
        "gate-script-unresolved",
        `yrd: step '${name}' declares gate script '${path}' but no object sha was resolved for it; ` +
          "the descriptor derivation and the script resolution read the same config, so this is a defect, not drift",
      )
    }
    return [path, sha] as const
  })
  return Object.fromEntries(entries)
}

function configuredStepDescriptors(
  fixed: Readonly<{ repo: string; stateDir: string; baysRoot: string }>,
  config: ResolvedYrdProjectConfig,
  mergeCommand: readonly string[] | undefined,
  gateScriptShas?: GateScriptShas,
): readonly InstalledStep[] {
  const toolchain = hostToolchainFingerprint()
  const mergeIndex = config.steps.indexOf("merge")
  return config.steps.map((name, index) => {
    const stepConfig = config.definitions[name] ?? { runner: "local" as const }
    const kind =
      stepConfig.kind ?? (name === "merge" ? "merge" : mergeIndex >= 0 && index > mergeIndex ? "action" : "check")
    const timeoutMs = stepTimeoutMs(stepConfig)
    const noProgressMs = stepNoProgressMs(stepConfig)
    const scripts = stepGateScriptShas(name, stepConfig, gateScriptShas)
    if (kind === "merge") {
      return {
        name,
        title: "merge",
        revision: queueStepRevision({
          repo: fixed.repo,
          stateDir: fixed.stateDir,
          name,
          config: stepConfig,
          timeoutMs,
          noProgressMs,
          toolchain,
          resolvedCommand: mergeCommand,
          ...(scripts === undefined ? {} : { scripts }),
        }),
        kind,
      }
    }
    if (kind === "check") {
      return {
        name,
        title: name,
        revision: queueStepRevision({
          repo: fixed.repo,
          stateDir: fixed.stateDir,
          name,
          config: stepConfig,
          timeoutMs,
          noProgressMs,
          toolchain,
          checkoutParent: fixed.baysRoot,
          ...(scripts === undefined ? {} : { scripts }),
        }),
        kind,
        classification: stepConfig.classification ?? "carrier",
      }
    }
    return {
      name,
      title: name,
      revision: queueStepRevision({
        repo: fixed.repo,
        stateDir: fixed.stateDir,
        name,
        config: stepConfig,
        timeoutMs,
        noProgressMs,
        toolchain,
        ...(scripts === undefined ? {} : { scripts }),
      }),
      kind,
    }
  })
}

/** Resolve every declared gate script's object sha (blob or tree) at ONE
 * exact commit — the ref whose config declared them. Undefined when the
 * config declares none, so the feature costs nothing where unused. A declared
 * path the commit does not hold refuses: the config comes from that very
 * commit, so a script it names but does not carry cannot gate anything, and a
 * script ADDED by a change takes effect for the NEXT change (23183). */
async function resolveGateScriptShas(
  process: Pick<Process, "run">,
  repo: string,
  config: ResolvedYrdProjectConfig,
  sha: string,
): Promise<GateScriptShas | undefined> {
  const paths = [...new Set(Object.values(config.definitions).flatMap((definition) => definition.scripts ?? []))]
  if (paths.length === 0) return undefined
  const env = cleanGitEnvironment(globalThis.process.env)
  const entries: [string, string][] = []
  for (const path of paths.toSorted()) {
    const resolved = await process.run({
      argv: ["git", "-C", repo, "rev-parse", `${sha}:${path}`],
      cwd: repo,
      env,
    })
    if (resolved.exitCode !== 0) {
      raiseFailure(
        "configuration",
        "gate-script-missing-at-base",
        `yrd: gate script '${path}' does not exist at ${sha.slice(0, 8)}, the commit whose config declares it. ` +
          "Gate scripts execute at the base ref's version, so a script must be ON the base before a check may " +
          "declare it; a change adding both merges the script first (it takes effect for the NEXT change).",
      )
    }
    entries.push([path, resolved.stdout.trim()])
  }
  return Object.fromEntries(entries)
}

/** The plan git declares at ONE EXACT commit, as full step descriptors.
 *
 * The same recipe this process uses for its own installed set
 * ({@link configuredStepDescriptors}), fed the config blob at `sha` instead of
 * the base tip, so revisions on both sides of a comparison are comparable:
 * the derived audit reads git HERE for the tip (leg c) and for each recorded
 * Run's own base sha (leg a), with no written baseline in between (23193).
 * Fails loud on an invalid config so the audit never certifies a broken
 * selection. */
async function declaredPlanAt(
  repository: YrdRepository,
  process: Pick<Process, "run">,
  sha: string,
  configPath?: string,
): Promise<DeclaredPlanAt> {
  const env = cleanGitEnvironment(globalThis.process.env)
  const exists = await process.run({
    argv: ["git", "-C", repository.repo, "cat-file", "-e", `${sha}^{commit}`],
    cwd: repository.repo,
    env,
  })
  if (exists.exitCode !== 0) {
    raiseFailure(
      "infrastructure",
      "plan-base-missing",
      `yrd: commit ${sha.slice(0, 8)} is not in repository '${repository.repo}', so the plan git declares there ` +
        "cannot be derived. A recorded Run's base is an ancestor of the base branch; one that is gone means the " +
        "repository history or the journal has been altered since that Run.",
    )
  }
  let configBlobSha: string | undefined
  const loaded = await loadYrdConfig({
    repo: repository.repo,
    defaultBase: repository.defaultBase,
    ...(configPath === undefined ? {} : { configPath }),
    readAuthority: async (_base, path) => {
      const object = `${sha}:${path}`
      const blob = await process.run({
        argv: ["git", "-C", repository.repo, "rev-parse", object],
        cwd: repository.repo,
        env,
      })
      if (blob.exitCode !== 0) return undefined
      const shown = await process.run({
        argv: ["git", "-C", repository.repo, "show", object],
        cwd: repository.repo,
        env,
      })
      if (shown.exitCode !== 0) {
        raiseFailure(
          "infrastructure",
          "config-read-failed",
          shown.stderr.trim() || `yrd: failed to read '${path}' at ${sha.slice(0, 8)}`,
        )
      }
      configBlobSha = blob.stdout.trim()
      return shown.stdout
    },
  })
  validateConfig(loaded.config)
  const mergeCommand =
    loaded.config.definitions.merge?.run === undefined ? undefined : shellCommand(loaded.config.definitions.merge.run)
  // Gate scripts resolve at THIS sha, exactly like the config: a script edit
  // merge on the base changes the derived revision from that commit on,
  // which is how the record names the script version that judged each run.
  const gateScriptShas = await resolveGateScriptShas(process, repository.repo, loaded.config, sha)
  return {
    sha,
    ...(configBlobSha === undefined ? {} : { configBlobSha }),
    batchSize: configuredBatchSize(loaded.config.batch),
    steps: configuredStepDescriptors(
      { repo: repository.repo, stateDir: repository.stateDir, baysRoot: repository.baysRoot },
      loaded.config,
      mergeCommand,
      gateScriptShas,
    ),
  }
}

/** Config is already schema-validated at this boundary. Queue independently
 * normalizes its public construction input; the host-level drift regression
 * proves these two effective-policy views stay equal without exporting a
 * tuning helper from `@yrd/queue`. */
function configuredBatchSize(batch: false | number): number {
  return batch === false || batch <= 1 ? 1 : batch
}

function integratedRunner(
  process: Pick<Process, "run">,
  repo: string,
  stateDir: string,
  name: string,
  config: YrdStepConfig,
): StepRunner<IntegratedShape, CommandEvidence> {
  const options = {
    inject: { process },
    command: shellCommand(stepCommand(name, config)),
    cwd: repo,
    purpose: name,
    mode: stepGateMode(config),
    timeoutMs: stepTimeoutMs(config),
    noProgressTimeoutMs: stepNoProgressMs(config),
    artifactRoot: join(stateDir, "artifacts"),
    variables: (input: StepExecution<IntegratedShape>) => ({
      YRD_INTEGRATED_SHA: input.shape.integration.commit,
      ...(config.environment === undefined ? {} : { YRD_ENVIRONMENT: config.environment }),
    }),
    ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
    ...(config.environmentPassthrough === undefined ? {} : { environmentPassthrough: config.environmentPassthrough }),
  }
  return config.runner === "waiting" ? configuredWaitingCommandStep(options) : configuredCommandStep(options)
}

function configuredQueueSteps(
  options: DefaultYrdDefinitionOptions,
  mergeCommand: readonly string[] | undefined,
  gateScriptShas: GateScriptShas | undefined,
): readonly RuntimeStep[] {
  const descriptors = configuredStepDescriptors(
    { repo: options.repo, stateDir: options.stateDir, baysRoot: options.baysRoot },
    options.config,
    mergeCommand,
    gateScriptShas,
  )
  const mergeIndex = descriptors.findIndex((descriptor) => descriptor.kind === "merge")
  const certificationIndex = descriptors.findLastIndex(
    (descriptor, index) => descriptor.kind === "check" && (mergeIndex === -1 || index < mergeIndex),
  )
  return options.config.steps.map((name, index) => {
    const config = options.config.definitions[name] ?? { runner: "local" as const }
    const descriptor = descriptors[index]
    if (descriptor === undefined) throw new Error(`yrd: missing derived descriptor for queue step '${name}'`)
    const revision = descriptor.revision
    if (descriptor.kind === "merge") {
      return eraseStep(
        withMerge(
          mergeCommand === undefined
            ? gitMergeStep({
                inject: { process: options.process },
                repo: options.repo,
                provisionPinIntent: createPinIntentProvisioner({
                  process: options.process,
                  repo: options.repo,
                  artifactRoot: join(options.stateDir, "artifacts"),
                }),
                ...(options.checkpointMigrationCertification === undefined
                  ? {}
                  : { checkpointIdentity: options.checkpointMigrationCertification.currentIdentity }),
              })
            : configuredMergeStep({
                inject: { process: options.process },
                repo: options.repo,
                command: mergeCommand,
                artifactRoot: join(options.stateDir, "artifacts"),
                provisionPinIntent: createPinIntentProvisioner({
                  process: options.process,
                  repo: options.repo,
                  artifactRoot: join(options.stateDir, "artifacts"),
                }),
                timeoutMs: stepTimeoutMs(config),
                ...(config.environment === undefined ? {} : { environment: config.environment }),
                ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
                ...(config.environmentPassthrough === undefined
                  ? {}
                  : { environmentPassthrough: config.environmentPassthrough }),
                ...(options.checkpointMigrationCertification === undefined
                  ? {}
                  : { checkpointIdentity: options.checkpointMigrationCertification.currentIdentity }),
              }),
          {
            revision,
          },
        ),
      )
    }
    if (descriptor.kind === "check") {
      return candidateStep(
        options.process,
        options.repo,
        options.stateDir,
        options.baysRoot,
        name,
        config,
        revision,
        options.candidatePool,
        descriptor.kind,
        index === certificationIndex ? options.checkpointMigrationCertification?.attestCandidate : undefined,
        options.authorizeSubmoduleModelChange,
      )
    }
    return eraseStep(
      withStep(name, integratedRunner(options.process, options.repo, options.stateDir, name, config), {
        revision,
        kind: "action",
      }),
    )
  })
}

async function resolveCommit(process: Pick<Process, "run">, repo: string, ref: string): Promise<string | undefined> {
  // HEAD names the selected checkout, never the remote's default branch.
  // Trying refs/remotes/origin/HEAD first silently replaced a linked-worktree
  // candidate with main, so required checks compared the base to itself.
  // Named branches remain remote-first because submit validates pushed bytes.
  const candidates = ref === "HEAD" || ref.startsWith("refs/") ? [ref] : [`refs/remotes/origin/${ref}`, ref]
  for (const candidate of candidates) {
    const args = ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`]
    const result = await process.run({
      argv: ["git", "-C", repo, ...args],
      cwd: repo,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    assertGitDidNotTimeOut(result, args)
    if (result.exitCode === 0) return result.stdout.trim().toLowerCase()
  }
  return undefined
}

/** Parent SHAs of one commit — the linear-root gate's evidence at entrances
 * that hold a sha rather than a branch (`pr ready`, active-Bay submit). */
async function readCommitParents(process: Pick<Process, "run">, repo: string, sha: string): Promise<readonly string[]> {
  const args = ["rev-list", "--parents", "-n", "1", sha]
  const lineage = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(lineage, args)
  const [commit, ...parents] = lineage.stdout.trim().toLowerCase().split(/\s+/u)
  if (lineage.exitCode !== 0 || commit !== sha.toLowerCase()) {
    raiseFailure(
      "configuration",
      "commit-lineage-inspection-failed",
      `yrd: could not inspect commit lineage at '${sha}': ` +
        `${lineage.stderr.trim() || lineage.stdout.trim() || `exit ${String(lineage.exitCode)}`}`,
    )
  }
  return parents
}

/** Submission asks whether this is unpublished local work or "what commit does
 * the authored branch name on origin now?" Once origin advertises the branch,
 * stale remote-tracking refs are never accepted as live. */
async function resolveSubmitCommit(
  process: Pick<Process, "run">,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const origin = await observeOriginRemote(process, repo)
  if (!origin.ok) {
    raiseFailure(
      "configuration",
      "submit-origin-inspection-failed",
      `yrd: could not inspect origin before resolving submitted branch '${branch}': ${origin.detail}`,
    )
  }
  if (!origin.configured) {
    return resolveCommit(process, repo, `refs/heads/${branch}`)
  }
  const advertisement = await observeOriginBranchAdvertisement(process, repo, branch)
  if (!advertisement.ok) {
    raiseFailure(
      "configuration",
      "submit-branch-refresh-failed",
      `yrd: could not refresh live branch '${branch}' from origin: ${advertisement.detail}\n` +
        "remedy: restore access to origin and retry; Yrd did not submit the stale local ref",
    )
  }
  // Origin absence is a fact, not a fetch failure: this is an unpublished
  // authored branch and its local commit is the only candidate available.
  if (!advertisement.advertised) {
    return resolveCommit(process, repo, `refs/heads/${branch}`)
  }
  const observed = await observeFreshRemoteBranch(process, repo, branch)
  // Origin advertised the branch a moment ago and no longer does: it was deleted
  // between the two observations. Naming the race is the whole remedy — retrying
  // is right if the deletion was a mistake, and pointless if it was not.
  if (!observed.ok && observed.phase === "absent") {
    raiseFailure(
      "refusal",
      "submit-branch-deleted-during-submit",
      `yrd: branch '${branch}' was deleted from origin while Yrd was submitting it (${observed.detail})\n` +
        "remedy: restore the branch on origin if the deletion was unintended, then retry; " +
        "Yrd did not submit the stale local ref",
    )
  }
  if (!observed.ok && observed.phase === "fetch") {
    raiseFailure(
      "configuration",
      "submit-branch-refresh-failed",
      `yrd: could not refresh live branch '${branch}' from origin: ${observed.detail}\n` +
        "remedy: restore access to origin and retry; Yrd did not submit the stale local ref",
    )
  }
  if (!observed.ok) {
    raiseFailure(
      "configuration",
      "submit-branch-head-missing",
      `yrd: refreshed live branch '${branch}' but '${observed.target}' did not resolve to a commit: ${observed.detail}`,
    )
  }
  return observed.head
}

async function readConfigFromBase(
  process: Pick<Process, "run">,
  repository: YrdRepository,
  base: string,
  path: string,
): Promise<string | undefined> {
  const { sha } = await inspectGitQueueTarget({
    inject: { process },
    repo: repository.repo,
    branch: baseIdentity(base),
  })
  const object = `${sha}:${path}`
  const exists = await process.run({
    argv: ["git", "-C", repository.repo, "cat-file", "-e", object],
    cwd: repository.repo,
    env: cleanGitEnvironment(globalThis.process.env),
  })
  if (exists.exitCode !== 0) return undefined
  const shown = await process.run({
    argv: ["git", "-C", repository.repo, "show", object],
    cwd: repository.repo,
    env: cleanGitEnvironment(globalThis.process.env),
  })
  if (shown.exitCode !== 0) {
    raiseFailure(
      "infrastructure",
      "config-read-failed",
      shown.stderr.trim() || `yrd: failed to read config '${path}' from base '${base}'`,
    )
  }
  return shown.stdout
}

/** Read the step plan the config declares at ONE EXACT base sha.
 *
 * The per-Run authority (C5, C11): `.yrd.yml` at the commit the Run is merging
 * onto, never a copy this process cached at startup and never durable state.
 * Both the blob id and the derived list are returned so the Run records what it
 * was judged by, and `queue audit` can compare that against the config now with
 * no written baseline file in between (23193).
 */
export async function readDeclaredPlanAtBase(
  process: Pick<Process, "run">,
  repo: string,
  baseSha: string,
  authority: string,
): Promise<DeclaredStepPlanAtBase> {
  const object = `${baseSha}:${authority}`
  const env = cleanGitEnvironment(globalThis.process.env)
  const blob = await process.run({ argv: ["git", "-C", repo, "rev-parse", object], cwd: repo, env })
  if (blob.exitCode !== 0) {
    raiseFailure(
      "refusal",
      "queue-config-missing-at-base",
      `yrd: base ${baseSha.slice(0, 8)} has no queue config at '${authority}', so it declares no step plan. ` +
        "A Run's checks come from the config at the commit it merges onto; commit one to that base before queuing.",
    )
  }
  const shown = await process.run({ argv: ["git", "-C", repo, "show", object], cwd: repo, env })
  if (shown.exitCode !== 0) {
    raiseFailure(
      "infrastructure",
      "config-read-failed",
      shown.stderr.trim() || `yrd: failed to read '${authority}' at base ${baseSha.slice(0, 8)}`,
    )
  }
  return {
    configBlobSha: blob.stdout.trim(),
    steps: declaredStepNames(parseYrdConfig(Bun.YAML.parse(shown.stdout))),
  }
}

function loadRepositoryConfig(
  repository: YrdRepository,
  process: Pick<Process, "run">,
  configPath?: string,
): ReturnType<typeof loadYrdConfig> {
  return loadYrdConfig({
    repo: repository.repo,
    defaultBase: repository.defaultBase,
    ...(configPath === undefined ? {} : { configPath }),
    readAuthority: (base, path) => readConfigFromBase(process, repository, base, path),
  })
}

async function resolveCommitMeta(
  process: Pick<Process, "run">,
  repo: string,
  ref: string,
): Promise<Readonly<{ subject: string; body?: string }> | undefined> {
  const sha = await resolveCommit(process, repo, ref)
  if (sha === undefined) return undefined
  const args = ["show", "--no-patch", "--format=%s%x00%b", sha]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  if (result.exitCode !== 0) return undefined
  const separator = result.stdout.indexOf("\0")
  const subject = (separator === -1 ? result.stdout : result.stdout.slice(0, separator)).trim()
  if (subject === "") return undefined
  const body = separator === -1 ? "" : result.stdout.slice(separator + 1).trim()
  return { subject, ...(body === "" ? {} : { body }) }
}

async function resolveQueueTarget(
  process: Pick<Process, "run">,
  repo: string,
  configuredBase: string,
  requestedBase: string,
  options: Readonly<{ refreshAuthority?: boolean; remoteBranch?: string }> = {},
): Promise<Readonly<{ base: string; sha: string; remoteBranch?: RemoteBranchSnapshot }>> {
  const configured = baseIdentity(configuredBase)
  const requested = baseIdentity(requestedBase)
  const base = requested === configured ? configured : requested
  if (requestedBase !== base && (await resolveCommit(process, repo, requestedBase)) === undefined) {
    throw new Error(`yrd: queue base '${requestedBase}' does not resolve`)
  }
  const target =
    options.refreshAuthority === true
      ? await resolveGitQueueTarget({
          inject: { process },
          repo,
          branch: base,
          ...(options.remoteBranch === undefined ? {} : { refreshRemoteBranches: [options.remoteBranch] }),
        })
      : await inspectGitQueueTarget({ inject: { process }, repo, branch: base })
  if (options.remoteBranch === undefined || target.remote !== "origin") return { base, sha: target.sha }
  const headSha = await resolveCommit(process, repo, `refs/remotes/origin/${options.remoteBranch}`)
  // Say WHICH fact an absent headSha is. Only a positive "origin does not
  // advertise it" earns `absent`; origin advertising a branch whose head we
  // cannot resolve locally is `unknown`, because we still have no head to give.
  const advertisement =
    headSha === undefined ? await observeOriginBranchAdvertisement(process, repo, options.remoteBranch) : undefined
  if (advertisement?.ok === false && advertisement.timedOut) {
    throw new Error(
      `yrd: git ls-remote --heads --exit-code origin refs/heads/${options.remoteBranch} timed out after ${GIT_TIMEOUT_MS}ms`,
    )
  }
  const headState =
    headSha !== undefined ? "resolved" : advertisement?.ok === true && !advertisement.advertised ? "absent" : "unknown"
  return {
    base,
    sha: target.sha,
    remoteBranch: {
      branch: options.remoteBranch,
      headState,
      ...(headSha === undefined ? {} : { headSha }),
    },
  }
}

function localCommitResolver(process: Pick<Process, "run">, repo: string): CommitResolver {
  return {
    revision: createHash("sha256").update(`yrd-contest-git-v2\0${repo}`).digest("hex"),
    resolveCommit: (ref) => resolveCommit(process, repo, ref),
  }
}

function bayPath(root: string, bay: string): string {
  const path = resolve(root, bay)
  const local = relative(resolve(root), path)
  if (local === "" || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`yrd: contest Bay '${bay}' escapes the configured Bays root`)
  }
  return path
}

function contestAdapters(options: DefaultYrdDefinitionOptions): {
  runners: readonly ContestRunnerDef[]
  evaluators: readonly ContestEvaluatorDef[]
  git: CommitResolver
} {
  const evaluators =
    options.contestEvaluators ??
    options.config.contest.evaluators.map((id) => {
      const step = options.config.definitions[id]
      if (step === undefined) throw new Error(`yrd: contest evaluator '${id}' has no step configuration`)
      return createHeldOutCommandEvaluator({
        id,
        revision: contestEvaluatorRevision(
          options.repo,
          options.stateDir,
          options.baysRoot,
          id,
          step,
          options.config.contest.timeoutMs,
        ),
        command: shellCommand(stepCommand(id, step)),
        timeoutMs: options.config.contest.timeoutMs,
        runner: step.runner,
        ...(step.environment === undefined ? {} : { targetEnvironment: step.environment }),
        checkoutParent: options.baysRoot,
        artifactRoot: join(options.stateDir, "artifacts"),
        resolveBayPath: (bay) => bayPath(options.baysRoot, bay),
        inject: { process: options.process },
      })
    })
  const runners = options.contestRunners ?? []
  return { runners, evaluators, git: options.contestGit ?? localCommitResolver(options.process, options.repo) }
}

/** Compose the built-in workflow from immutable plugins and injected resources. */
async function createDefaultYrdDefinition(options: DefaultYrdDefinitionOptions) {
  validateConfig(options.config)
  const mergeCommand =
    options.config.definitions.merge?.run === undefined ? undefined : shellCommand(options.config.definitions.merge.run)
  const workspace =
    options.workspace ??
    (await createGitWorkspace({
      repo: options.repo,
      baysRoot: options.baysRoot,
      process: options.process,
      ...(options.receiverPath === undefined ? {} : { intakeRemote: options.receiverPath }),
      ...options.workspaceLifecycle,
    }))
  const bayJobs = createBayJobDefs(
    workspace,
    createChangePublicationService({ repo: options.repo, process: options.process }),
  )
  let deploymentStorePromise: ReturnType<typeof createGitDeploymentStore> | undefined
  const deploymentStore = () => {
    deploymentStorePromise ??= createGitDeploymentStore({
      repo: options.repo,
      deploymentsRoot: join(options.stateDir, "deployments"),
      process: options.process,
      prepare: (path) =>
        ensureWorkspaceDependencies(options.process, {
          path,
          subject: "immutable deployment",
          manifestSubject: "deployment",
          runPostinstall: true,
          fail(message) {
            throw new Error(`yrd: ${message}`)
          },
        }),
    })
    return deploymentStorePromise
  }
  const lazyDeploymentStore: GitDeploymentStore = {
    materialize: async (input) => (await deploymentStore()).materialize(input),
    reap: async (input) => (await deploymentStore()).reap(input),
    release: async (input) => (await deploymentStore()).release(input),
  }
  const deploymentJobs = createDeploymentJobDefs(lazyDeploymentStore)
  // The gate scripts' identity, resolved once at the same base authority the
  // config itself was read from (23183). None declared → no git reads at all.
  const gateScriptShas = Object.values(options.config.definitions).every(
    (definition) => definition.scripts === undefined,
  )
    ? undefined
    : await resolveGateScriptShas(
        options.process,
        options.repo,
        options.config,
        (
          await inspectGitQueueTarget({
            inject: { process: options.process },
            repo: options.repo,
            branch: baseIdentity(options.config.base),
          })
        ).sha,
      )
  // ONE durable mint for both plugins (S6): bays keeps it for grandfathered
  // revision numbering, and the queue mints derived-member identities from the
  // same monotone sequence at admission time. Lives beside journal.sqlite,
  // outside checkpoint-identity state: mint durability must survive the store
  // re-initialization class (22986).
  const prNumberMint = createDurablePrNumberMint({ dir: options.stateDir })
  const queue = withQueue({
    steps: configuredQueueSteps(options, mergeCommand, gateScriptShas),
    batch: options.config.batch,
    defaultSteps: options.config.steps,
    defaultBase: options.config.base,
    requires: options.config.requires,
    prNumberMint,
    readSubmitEnrichment: ({ sha }) => readDerivedSubmitEnrichment(options.process, options.repo, sha),
    scanLandedSubmits: landedSubmitScanner({
      process: options.process,
      repo: options.repo,
      exceptions: mergedTruthExceptions(options.config),
      ...(options.log === undefined ? {} : { log: options.log }),
    }),
    isSubmitSuperseded: ({ sha, base }) => isSubmitContentLanded(options.process, options.repo, sha, base),
    ...(options.config.progress === undefined ? {} : { progress: options.config.progress }),
    ...(options.config.needsPerson === undefined ? {} : { needsPersonOwner: options.config.needsPerson.owner }),
    resolveBaseSha: async (base) =>
      (
        await resolveGitQueueTarget({
          inject: { process: options.process },
          repo: options.repo,
          branch: baseIdentity(base),
        })
      ).sha,
    // Only when this host RESOLVED a config authority in a repository: that is
    // what makes the per-Run re-read a like-for-like comparison. An app built
    // from a hand-supplied config has no file to re-read and keeps the
    // installed set as its plan.
    ...(options.configAuthority === undefined
      ? {}
      : {
          resolveDeclaredPlan: (baseSha: string) =>
            readDeclaredPlanAtBase(options.process, options.repo, baseSha, options.configAuthority ?? ".yrd.yml"),
        }),
    prepareCandidate: gitCandidatePreparer({
      inject: { process: options.process },
      repo: options.repo,
      checkoutParent: options.baysRoot,
      artifactRoot: join(options.stateDir, "artifacts"),
      provisionPinIntent: createPinIntentProvisioner({
        process: options.process,
        repo: options.repo,
        artifactRoot: join(options.stateDir, "artifacts"),
      }),
      ...(options.candidatePool === undefined ? {} : { candidatePool: options.candidatePool }),
      ...(options.authorizeSubmoduleModelChange === undefined
        ? {}
        : { authorizeSubmoduleModelChange: options.authorizeSubmoduleModelChange }),
    }),
    recordMerge: gitMergeRecorder({ inject: { process: options.process }, repo: options.repo }),
    runner: (jobs) => {
      const contexts = worktreeContexts({
        repo: options.repo,
        parent: options.baysRoot,
        size: 2,
        submodules: "isolated",
        git: createCandidatePoolGit(options.process),
        ...(options.candidatePool === undefined ? {} : { pool: options.candidatePool }),
        ...(options.log === undefined ? {} : { log: options.log }),
      })
      const runner = localRunner({
        id: options.runnerId ?? "yrd-local",
        jobs,
        leaseMs: 60_000,
        maxInFlight: contexts.maxInFlight,
        contexts,
      })
      return Object.freeze({ ...runner, [Symbol.asyncDispose]: () => contexts.close() })
    },
  })
  const installedContests = contestAdapters(options)
  const contests = withContests({
    ...installedContests,
    defaultBase: options.config.base,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs, deploymentJobs] }),
    withDeployments({ jobs: deploymentJobs }),
    withIssues({
      sources: options.issueSources ?? [createKmIssueSource({ process: options.process, cwd: options.repo })],
    }),
    withBays({
      jobs: bayJobs,
      prNumberMint,
      defaultBase: baseIdentity(options.config.base),
      ...(options.defaultSubmitter === undefined ? {} : { defaultSubmitter: options.defaultSubmitter }),
      resolveBase: async (base, context) => {
        const target = await resolveQueueTarget(options.process, options.repo, options.config.base, base, {
          refreshAuthority: true,
          ...(context?.branch === undefined ? {} : { remoteBranch: context.branch }),
        })
        return {
          base: target.base,
          baseSha: target.sha,
          ...(target.remoteBranch === undefined ? {} : { remoteBranch: target.remoteBranch }),
        }
      },
    }),
  )
  const definition = contests(queue(base))
  return withCheckpointMigrations(definition, [
    ...RETAINED_PREDECESSOR_CHECKPOINT_IDENTITIES.map((from) => ({
      from,
      to: RETIRED_CHANGE_RECORD_CHECKPOINT_IDENTITY,
      migrate: (state: Parameters<typeof definition.compact>[0]) => {
        // Correlation-era checkpoints spell revision labels
        // `correlation: {namespace, id}`; fold them to `props` FIRST, at this
        // read boundary, so everything downstream — fill, compact, the process
        // that runs on the migrated state — sees only the current vocabulary.
        const folded = foldLegacyCorrelationDeep(state) as typeof state
        // Every historical retained edge merges on the released 36d85bbb
        // identity, so a checkpoint predates fields added since its writer ran.
        // Fill those from initial values BEFORE compacting — compaction and
        // validation both assume the current contract (2026-08-18: intents-v2
        // added `unreadable`, absent from every intents-v1 checkpoint).
        const compacted = definition.compact(fillMissingStateFromInitial(definition.initialState, folded))
        // The intent rail's deletion (2026-08-18) dropped `intents` from the
        // state contract entirely — no feature owns that key anymore, so
        // `compact`'s composition (each surviving feature merges only ITS OWN
        // slice) has no one left to prune it and would otherwise pass a stale
        // `intents` value through forever, unread by anything. Drop it here,
        // explicitly, once, rather than let a retained checkpoint leak it into
        // every future one. Every retained predecessor above — including this
        // migration's own immediate one, intents-v2 — routes through this same
        // callback, so this single drop covers all of them.
        const { intents: _deadIntents, ...withoutDeadIntents } = compacted as typeof compacted &
          Readonly<{ intents?: unknown }>
        // Same reason as `batchSize` below, and the defect that made it urgent
        // (23192): the declared step list is construction policy, not a journal
        // fact. Nothing plans from the stored copy any more, so drop it here
        // rather than carry a list into every future checkpoint that only ever
        // reports as drift. `@yrd/queue` still reports one it finds, because a
        // library cannot assume its host ran this migration.
        const { defaultSteps: _retiredStepPlan, ...queuesWithoutStoredPlan } =
          compacted.queues as typeof compacted.queues & Readonly<{ defaultSteps?: unknown }>
        // The terminal-associations back-fill cut (5e cut 1) dropped
        // `queues.terminalAssociations` from the state contract entirely — no
        // feature owns the key anymore, so compact would pass a stale (always
        // empty in production) container through forever. Drop it here,
        // explicitly, once, exactly like `intents` above.
        const { terminalAssociations: _retiredBackfill, ...queuesWithoutBackfill } =
          queuesWithoutStoredPlan as typeof queuesWithoutStoredPlan & Readonly<{ terminalAssociations?: unknown }>
        return {
          ...withoutDeadIntents,
          queues: {
            ...queuesWithoutBackfill,
            // Construction policy is not a journal fact. A retained checkpoint
            // keeps historical Run widths, but future candidates must use the
            // current config/default selected by this process.
            batchSize: definition.initialState.queues.batchSize,
          },
        }
      },
    })),
    {
      from: RETIRED_CHANGE_RECORD_CHECKPOINT_IDENTITY,
      migrate: (state) => {
        // The live deployment already wrote a 36d85bbb checkpoint before
        // this retired nested field was noticed. A real forward edge is the
        // only opportunity to remove it from runtime and durable state. It
        // also predates later top-level projection fields; unlike the retained
        // predecessor callbacks above, this direct edge must fill them here.
        const filled = fillMissingStateFromInitial(definition.initialState, state)
        const prsWithoutRegressions = Object.fromEntries(
          recordChangeEntries(filled.bays).map(([id, pr]) => {
            const { regressions: _retiredRegressions, ...withoutRegressions } = pr as typeof pr &
              Readonly<{ regressions?: unknown }>
            return [id, withoutRegressions]
          }),
        )
        const { terminalAssociations: _retiredBackfill, ...queuesWithoutBackfill } =
          filled.queues as typeof filled.queues & Readonly<{ terminalAssociations?: unknown }>
        // 22991 phase 2, first store-deletion door: the queue's stored copy of
        // per-change delivery state (`authority.statuses`) is deleted from the
        // contract — ChangeDeliveryState is "derived, never stored" and the
        // copy was the drift surface. Every path into the current identity
        // takes this edge last, so this single drop covers every retained
        // predecessor; parity was proven against the live checkpoint before
        // the cut (2084/2084 stored labels equal the record derivation).
        const { statuses: _retiredStatusCopy, ...authorityWithoutStatusCopy } =
          queuesWithoutBackfill.authority as typeof queuesWithoutBackfill.authority & Readonly<{ statuses?: unknown }>
        const { intents: _deadIntents, ...withoutDeadIntents } = filled as typeof filled &
          Readonly<{ intents?: unknown }>
        return {
          ...withoutDeadIntents,
          bays: { ...withoutDeadIntents.bays, prs: prsWithoutRegressions },
          queues: { ...queuesWithoutBackfill, authority: authorityWithoutStatusCopy },
        }
      },
    },
  ])
}

/** Derive the data-only projection contract from the exact production
 * definition builder; certification never maintains a second assembly path. */
export async function createDefaultYrdCheckpointMigrationAttestation(
  options: DefaultYrdDefinitionOptions,
): Promise<CheckpointMigrationAttestation> {
  const refuse = () => ({
    status: "completed" as const,
    conclusion: "failure" as const,
    error: { code: "definition-read-only", message: "yrd: definition derivation cannot mutate bay workspaces" },
  })
  const workspace =
    options.workspace ??
    Object.freeze({
      revision: gitWorkspaceRevision({
        repo: options.repo,
        baysRoot: options.baysRoot,
        ...(options.receiverPath === undefined ? {} : { intakeRemote: options.receiverPath }),
        ...options.workspaceLifecycle,
      }),
      provision: refuse,
      refresh: refuse,
      checkpoint: refuse,
      deprovision: refuse,
    })
  const manifest: CheckpointMigrationManifest = checkpointMigrationManifest(
    await createDefaultYrdDefinition({ ...options, workspace }),
  )
  return CheckpointMigrationAttestationSchema.parse({
    version: 1,
    manifest,
    hash: checkpointMigrationManifestHash(manifest),
  })
}

export function targetImplementationEntrypoint(
  assemblyRoot: string,
  implementationRoot: string,
  candidateRoot: string,
  baysRoot?: string,
  implementationWorkTree?: string,
): string {
  // A vendored implementation's Candidate-relative location is its path inside
  // the working tree the runner actually executes from — which may be a LINKED
  // git worktree of the repository, not the primary root. Linked worktrees
  // live under an untracked directory of the primary root, so stripping the
  // assembly root leaves that directory prefixed onto the mapped path
  // (2026-08-18: every new-PR check refused with Module not found
  // <bay>/worktree/.worktrees/<runner-worktree>/…/bin/yrd.ts). The caller
  // resolves the enclosing working tree from the implementation itself; the
  // assembly root stays the base when none exists.
  const mappingBase =
    implementationWorkTree === undefined || implementationWorkTree === "" ? assemblyRoot : implementationWorkTree
  const implementationPath = relative(resolve(mappingBase), resolve(implementationRoot))
  const outsideAssembly = implementationPath === ".." || implementationPath.startsWith(`..${sep}`)
  const bayPath = baysRoot === undefined ? undefined : relative(resolve(baysRoot), resolve(implementationRoot))
  const insideBays = bayPath !== undefined && bayPath !== ".." && !bayPath.startsWith(`..${sep}`)
  if (outsideAssembly || insideBays) {
    // Standalone consumers install Yrd outside the repository being admitted,
    // and a habitant runner executes Yrd from a bay INSIDE the repository's
    // bays root — untracked, so no Candidate tree can contain it. Both are
    // fixed implementations across this Candidate; only config is
    // target-owned. Mapping a bay path into the Candidate composes a phantom
    // path (2026-08-17: every habitant substrate-pair refused with Module
    // not found <warm-bay>/.bays/<runner-bay>/vendor/yrd/bin/yrd.ts).
    // Composed roots resolve Yrd inside the Candidate instead.
    return join(implementationRoot, "bin", "yrd.ts")
  }
  return join(candidateRoot, implementationPath, "bin", "yrd.ts")
}

function targetCheckpointMigrationAttestor(
  options: Pick<DefaultYrdRuntimeAppOptions, "repo" | "process" | "implementationRoot" | "baysRoot">,
): NonNullable<GitCheckOptions["checkpointMigration"]> | undefined {
  const implementationRoot = options.implementationRoot
  if (implementationRoot === undefined) return undefined
  return async ({ path }) => {
    // The runner may execute from a linked worktree of the repository; the
    // implementation's own superproject working tree — not the assembly root —
    // is then the base its Candidate-relative path strips from. That base is
    // only valid when the enclosing working tree is a checkout OF THE ASSEMBLY
    // REPOSITORY (same git common dir): a runner whose implementation is
    // vendored in some OTHER repository is a standalone consumer of this
    // assembly, and mapping its path into the Candidate would compose a
    // phantom. Empty output means no enclosing superproject; every failure
    // degrades to the assembly-root base, whose outside-assembly branch keeps
    // the implementation fixed rather than composing a phantom Candidate path.
    const gitLine = async (cwd: string, ...args: readonly string[]): Promise<string | undefined> => {
      const result = await adaptProcessGit(options.process, {
        timeoutMs: CHECKPOINT_MIGRATION_DERIVATION_TIMEOUT_MS,
      }).run({ repo: cwd, args })
      return result.timedOut === true || result.code !== 0 ? undefined : result.stdout.trim()
    }
    let implementationWorkTree =
      (await gitLine(implementationRoot, "rev-parse", "--show-superproject-working-tree")) ?? ""
    if (implementationWorkTree !== "") {
      const assemblyCommonDir = await gitLine(options.repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
      const workTreeCommonDir = await gitLine(
        implementationWorkTree,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      )
      if (assemblyCommonDir === undefined || assemblyCommonDir !== workTreeCommonDir) implementationWorkTree = ""
    }
    const entrypoint = targetImplementationEntrypoint(
      options.repo,
      implementationRoot,
      path,
      options.baysRoot,
      implementationWorkTree === "" ? undefined : implementationWorkTree,
    )
    const result = await options.process.run({
      argv: [
        globalThis.process.execPath,
        entrypoint,
        "_checkpoint-migration-manifest",
        "--assembly-root",
        options.repo,
      ],
      cwd: path,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: CHECKPOINT_MIGRATION_DERIVATION_TIMEOUT_MS,
    })
    if (result.timedOut || result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
      raiseFailure(
        "infrastructure",
        "checkpoint-migration-target-derivation-failed",
        `yrd: target Candidate checkpoint migration derivation failed: ${detail}`,
      )
    }
    const records = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(CHECKPOINT_MIGRATION_TRAILER))
    if (records.length !== 1) {
      raiseFailure(
        "infrastructure",
        "checkpoint-migration-target-output-invalid",
        `yrd: target Candidate emitted ${records.length} checkpoint migration records; expected exactly one`,
      )
    }
    try {
      return CheckpointMigrationAttestationSchema.parse(
        JSON.parse((records[0] as string).slice(CHECKPOINT_MIGRATION_TRAILER.length)),
      )
    } catch (cause) {
      raiseFailure(
        "infrastructure",
        "checkpoint-migration-target-output-invalid",
        `yrd: target Candidate emitted an invalid checkpoint migration record: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
}

async function createDefaultYrdRuntimeApp(options: DefaultYrdRuntimeAppOptions): Promise<YrdCliApp> {
  const checkpoint = { identity: undefined as string | undefined }
  const attestCandidate = targetCheckpointMigrationAttestor(options)
  const checkpointMigrationCertification =
    attestCandidate === undefined
      ? undefined
      : Object.freeze({
          currentIdentity() {
            if (checkpoint.identity === undefined) {
              raiseFailure(
                "infrastructure",
                "checkpoint-migration-current-identity-unavailable",
                "yrd: stored checkpoint identity is unavailable at merge authority",
              )
            }
            return checkpoint.identity
          },
          attestCandidate,
        })
  const definition = await createDefaultYrdDefinition({
    ...options,
    ...(checkpointMigrationCertification === undefined ? {} : { checkpointMigrationCertification }),
  })
  const targetIdentity = checkpointMigrationManifest(definition).targetIdentity
  const app = await createYrd(definition, {
    inject: {
      journal: options.journal,
      compatibility: CURRENT_JOURNAL_COMPATIBILITY,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  })
  checkpoint.identity = (await options.journal.checkpoint?.inspect?.())?.identity ?? targetIdentity
  return app
}

export function createDefaultYrdApp(options: DefaultYrdAppOptions): Promise<YrdCliApp> {
  return createDefaultYrdRuntimeApp(options)
}

export type YrdHost = Readonly<{
  app: YrdCliApp
  repository: YrdRepository
  config: ResolvedYrdProjectConfig
  receiver: GitPushReceiver
  process: Process
  /** Native implementation identity captured exactly once during host startup. */
  implementationSource?: string
  /** Exact policy resolved once by this active host's mutable journal. */
  journalRetention?: ResolvedRetention
  services: YrdCliServices
  drain(): Promise<void>
  /** Releases the owned app, process, and scope. Idempotent with async disposal. */
  close(): Promise<void>
  /** Releases the host through the same lifecycle as close(). */
  [Symbol.asyncDispose](): Promise<void>
}>

/**
 * What `receiverTarget` below requires of a `refs/heads/` push, in one sentence,
 * rendered into the receiver's refusal. It lives beside the resolver rather than
 * at the call sites so the rule and the explanation of the rule cannot drift
 * apart.
 *
 * Note what the rule is NOT: there is no branch-name pattern anywhere in intake.
 * A branch is authorized because an ACTIVE BAY tracks it, which is both stricter
 * than a name prefix and indifferent to what the branch is called — `cto/…` and
 * `chief/…` are admitted on the same terms as `task/…`.
 *
 * It also does not describe a `refs/for/` push, which carries its authorization
 * in the ref and so can never fail this way. That path refuses by throwing the
 * reason it actually hit — this sentence would name a bay the pusher was never
 * asked for.
 */
const INTAKE_POLICY =
  "no active bay tracks this branch — open one with `yrd bay open --bay <name>`, or push a branch an active bay already tracks"

/**
 * Resolves what a pushed ref merges on: a branch push must find an active bay,
 * a submit push carries its own answer.
 *
 * The asymmetry is the point. A `refs/for/<base>/<change>` push predates its bay
 * by construction — that is what "push IS submit" means — so it cannot be
 * authorized by "an active bay tracks this branch", and asking it to be is how
 * the whole namespace stayed unreachable. Intake does not need a bay either:
 * `bay.intake` takes `bay` as optional and mints a change from branch/name/base
 * alone. The PR is the unit of intake; a bay is a workspace that usually
 * happens to exist.
 */
/**
 * Exactly the bay fields the resolver reads. Narrow on purpose: it is what lets
 * the rule be tested against a literal instead of a booted runtime, and it says
 * in the type that intake authorization looks at nothing else.
 */
export type ReceiverBayView = Readonly<{
  id: string
  name: string
  issue?: string
  branch: string
  base: string
  baseSha?: string
  status: string
}>
export type ReceiverBayIndex = Readonly<{
  state: () => Readonly<{ bays: Readonly<{ byId: Readonly<Record<string, ReceiverBayView>> }> }>
}>

export function receiverTarget(app: ReceiverBayIndex, process: Pick<Process, "run">, repo: string) {
  // Derive at read, never store at write (w24-bases): a base is read live off
  // the main repository on EVERY call, for a bay-tracked branch exactly as for
  // a bay-less submit below, rather than trusting a value pinned once and
  // reused. `bay.baseSha` names what the bay opened against — a fact that
  // stays true forever — not what the branch must gate against on push N; a
  // bay can sit active for weeks while main moves and its author rebases
  // without ever re-opening it, and a pin frozen at open time silently
  // answers every later push, and every reader downstream of it (validatePin,
  // the recorded revision, audits comparing declared base to actual), with a
  // base the change may no longer have. Never `return null` on a vanished
  // base: null renders INTAKE_POLICY, which would answer a race about a base
  // branch with instructions to open a bay — the caller already proved this
  // base existed a moment ago (the bay's own open, or the push's entry
  // check), so its disappearance is a race worth naming, not an
  // authorization verdict.
  const baseTip = async (base: string, subject: string): Promise<string> => {
    const baseSha = await resolveCommit(process, repo, `refs/heads/${base}`)
    if (baseSha === undefined) {
      throw new Error(`yrd: base branch '${base}' disappeared between ${subject} and resolution`)
    }
    return baseSha
  }
  return async (
    branch: string,
    _update: Readonly<ReceiverRefUpdate>,
    intent?: ReceiverSubmitIntent,
  ): Promise<ReceiverTarget | null> => {
    // One rule for what a change is called: the branch a bay for this issue
    // would already have. So a bay opened later for the same issue converges on
    // the carrier the submit already created rather than forking a second one.
    const carrier = intent === undefined ? branch : defaultBayBranch(intent.name)
    const bay = Object.values(app.state().bays.byId).find(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.branch === carrier || (intent !== undefined && candidate.issue === intent.name)),
    )
    if (bay !== undefined) {
      return {
        bay: bay.id,
        name: bay.name,
        ...(bay.issue === undefined ? {} : { issue: bay.issue }),
        base: bay.base,
        baseSha: await baseTip(bay.base, "its bay's entry check"),
        // A branch push names its branch in the ref and the receiver reads it
        // there; only a submit push needs to be told.
        ...(intent === undefined ? {} : { branch: bay.branch }),
      }
    }
    if (intent === undefined) return null
    return {
      name: intent.name,
      issue: intent.name,
      base: intent.base,
      baseSha: await baseTip(intent.base, "its entry check"),
      branch: carrier,
    }
  }
}

/**
 * Creates the carrier branch a submit push named, at the head it pushed.
 *
 * A `refs/heads/` push already IS its branch, so this is a no-op there. A
 * `refs/for/<base>/<change>` push names a CHANGE, and the carrier is derived —
 * which means nothing creates it unless intake does. Without this the change is
 * admitted and then permanently undeliverable: the pre-submit gate resolves the
 * PR's branch and finds no such ref, so it refuses with
 * `required-check candidate '<branch>' is missing` and the change can never
 * leave draft. An intake path must not validate against a thing it does not
 * materialize.
 *
 * It also gives the pushed head an anchor of its own. Until now it was
 * reachable only through whatever branch the pusher happened to hold, so moving
 * that branch orphaned the change.
 *
 * Fast-forward only, under a compare-and-swap: `update-ref <ref> <new> <old>`
 * fails if anyone moved the carrier in between, so a concurrent writer is a
 * loud refusal rather than a silently lost revision.
 */
/**
 * S6 door: a DERIVED member's admission enrichment, read from the tip commit
 * at exactly the submitted sha — the `Change-Id` trailer (stable identity),
 * the `Bead` trailer (issue linkage plus the settlement-visible `bead` prop),
 * and the subject as the display title. Missing trailers come back absent;
 * the derived admission fills a missing Change-Id itself, minting a synthetic
 * identity from the submission's stable facts (a retained snapshot's identity
 * or a present trailer wins over that mint).
 */
/**
 * The merged-truth reader's two git reads, over this host's process runner.
 *
 * `text` throws on ANY non-zero exit — an unreadable repository is a loud
 * failure, never an empty index, and it is that throw which makes a negative
 * containment answer trustworthy. `optionalText` maps a non-zero exit to
 * undefined for the one question where that is a real answer (`merge-base
 * --is-ancestor` exits 1 for "not contained"). A TIMEOUT stays fatal in both:
 * git never finished asking, and reporting that as "not contained" would read
 * a stalled repository as a clean not-merged.
 */
export function mergedTruthGit(process: Pick<Process, "run">): MergedTruthGit {
  const read = async (repo: string, args: readonly string[]): Promise<ProcessResult> => {
    const result = await process.run({
      argv: ["git", "-C", repo, ...args],
      cwd: repo,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    assertGitDidNotTimeOut(result, args)
    return result
  }
  return {
    async text(repo, args) {
      const result = await read(repo, args)
      if (result.exitCode !== 0) {
        throw new Error(`yrd: git ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.trim()}`)
      }
      return result.stdout.trim()
    },
    async optionalText(repo, args) {
      const result = await read(repo, args)
      return result.exitCode === 0 ? result.stdout.trim() : undefined
    },
  }
}

/**
 * The queue's `scanLandedSubmits` capability: which standing submit facts does
 * this repository already carry?
 *
 * One first-parent index per DISTINCT base, built on demand and cached inside
 * one scan, and BOUNDED at the trailer-stamping epoch — the contract
 * `merged-truth.ts` states for its production callers, which this one used to
 * decline.
 *
 * It declined on the grounds that "this consumer asks only `mergedByAncestry`,
 * whose verdict is pure containment and never consults the Change-Id lineage
 * index or its specimens". The runner refuted that in its own log: it emits
 * `compose-derived-fact-landing-unresolved` with `reason: "unreadable"` and a
 * detail naming the lineage index as the thing that could not answer. The
 * lineage proof is reached exactly when containment does NOT settle it — a
 * revision the queue rebuilt at merge — so the window is load-bearing.
 * Measured 2026-08-31 on this base: 26533 commits walked, 6008 specimens,
 * 77.4% coverage, every landed fact answering `unreadable` forever, and the
 * stale-fact set that took the landing path down for 72 minutes.
 *
 * THE BOUND IS THE EPOCH AND MUST NOT BE TIGHTER. A bound above a landed
 * change's merge commit turns its fact into a TRUSTED not-found, and the queue
 * re-admits and re-runs work that already landed — silently, as a re-run
 * rather than an error. Today nothing is trusted because 6008 specimens force
 * `unknown`, so clearing specimens is what ARMS that hazard. Bounding at the
 * epoch is lossless because every trailered commit is post-epoch by
 * definition: the excluded range contributes no index entries at all, so the
 * only verdicts that can change are `unknown` becoming answerable. Tightening
 * it for speed is the one variant that loses data.
 *
 * The epoch is DERIVED rather than configured, so the safety property is
 * structural instead of a number someone maintains and can silently get wrong.
 * Costs one grep-filtered log per base — measured 0.12s over 26533 commits —
 * memoized for the scanner's life, since the oldest stamped commit does not
 * move as the tip advances.
 */
function landedSubmitScanner(
  options: Readonly<{
    process: Pick<Process, "run">
    repo: string
    /** Declared rulings on commits this repository's history cannot identify —
     * the config half of the specimen mechanism. Absent leaves every specimen
     * standing, which is loud, not silent. */
    exceptions?: ReadonlyMap<string, TrailerAbsentException>
    log?: ConditionalLogger
  }>,
) {
  const git = mergedTruthGit(options.process)
  const stops = new Map<string, Promise<string | undefined>>()
  const stopFor = (base: string, tip: string): Promise<string | undefined> => {
    const cached = stops.get(base)
    if (cached !== undefined) return cached
    const derived = stampingEpochStop(git, options.repo, tip)
    stops.set(base, derived)
    return derived
  }
  // WHAT THE INDEX COULD NOT SETTLE, SAID ONCE PER (base, tip) RATHER THAN
  // never or every tick. Never is how this cost 2.5 hours of dark queue: the
  // specimens were only ever named inside a per-candidate refusal detail, so
  // the condition was visible one ejected candidate at a time and never as
  // itself. Every tick is the opposite failure — a resident runner scans on a
  // loop, and three unchanging lines per tick is a log nobody reads. Keyed by
  // tip too, so the same gap is restated when main moves and a reader looking
  // at recent log lines is not told about a window that no longer exists.
  const reported = new Set<string>()
  const reportGaps = (index: MergedTruthIndex): void => {
    const key = `${index.repo} ${index.tip}`
    if (reported.has(key)) return
    reported.add(key)
    for (const line of describeMergedTruthGaps(index)) options.log?.warn?.(line)
  }
  return async (input: Readonly<{ bays: Parameters<typeof landedSubmits>[2] }>) =>
    landedSubmits(
      git,
      async (base) => {
        const tip = (
          await resolveGitQueueTarget({
            inject: { process: options.process },
            repo: options.repo,
            branch: baseIdentity(base),
          })
        ).sha
        const stop = await stopFor(base, tip)
        const index = await buildMergedTruthIndex(git, options.repo, {
          tip,
          ...(stop === undefined ? {} : { stop }),
          ...(options.exceptions === undefined ? {} : { exceptions: options.exceptions }),
        })
        reportGaps(index)
        return index
      },
      input.bays,
    )
}

/**
 * Does the base branch already contain this standing fact's content?
 *
 * Answers the queue's `isSubmitSuperseded` capability from git, because the
 * queue layer is pure over its own state and the record store can no longer
 * answer it: a merged branch usually has no record left, and the queue
 * rebuilds a candidate at merge into a NEW head, so comparing the fact's sha
 * to a recorded integration commit fails even when a record exists.
 *
 * Ancestry, not sha equality. It is the general form — equality is its
 * reflexive case — and it holds across the rebuild, since the rebuilt commit
 * lands on the base and the fact's own tip becomes its ancestor.
 *
 * BOUNDARY, stated rather than papered over: a REBASED landing changes the
 * content's identity, so the original tip is not an ancestor of the base and
 * this returns false. Catching that needs tree-equality (`git merge-tree`),
 * which `yrd admin pr prune` implements for its own verdict. This covers the
 * merge and fast-forward cases, which are the queue's own landing paths.
 */
export async function isSubmitContentLanded(
  process: Pick<Process, "run">,
  repo: string,
  sha: string,
  base: string,
): Promise<boolean> {
  const target = await resolveGitQueueTarget({ inject: { process }, repo, branch: baseIdentity(base) })
  const args = ["merge-base", "--is-ancestor", sha, target.sha]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  // git answers this one in the exit code: 0 ancestor, 1 not. Every OTHER
  // code is git failing to answer, and the two wrong readings are not
  // symmetric. Reading a failure as "superseded" would DROP a live
  // submission and say nothing — the worst outcome available here. Reading
  // it as "not superseded" restores the pre-fix behaviour for one branch,
  // whose ghost is then loud on every pass. So this throws, and the compose
  // degrades per branch instead of guessing.
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error(
    `yrd: could not decide whether ${sha.slice(0, 12)} is already on '${base}': ` +
      (result.stderr.trim() || `git merge-base --is-ancestor exited ${String(result.exitCode)}`),
  )
}

export async function readDerivedSubmitEnrichment(
  process: Pick<Process, "run">,
  repo: string,
  sha: string,
): Promise<DerivedSubmitEnrichment> {
  const args = [
    "show",
    "-s",
    "--format=%(trailers:key=Change-Id,valueonly,separator=%x2c)%x09%(trailers:key=Bead,valueonly,separator=%x2c)%x09%s",
    sha,
  ]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  if (result.exitCode !== 0) {
    // R2's vanished-commit edge: the submit fact stands but its commit is not
    // in this repository (pruned, or never fetched). Attributable to the ONE
    // branch — a typed refusal the compose skips loudly, never a compose-wide
    // failure that would starve every healthy sibling.
    if (/bad object|unknown revision|not a valid object name|bad revision/iu.test(result.stderr)) {
      raiseFailure(
        "refusal",
        "derived-commit-vanished",
        `yrd: submitted commit ${sha.slice(0, 12)} is not in this repository — re-push the branch and its ` +
          `submit ref to renew the submission`,
      )
    }
    throw new Error(
      `yrd: could not read derived-submit enrichment at ${sha.slice(0, 12)}: ${result.stderr.trim() || "git show failed"}`,
    )
  }
  const [changeIds = "", beads = "", subject = ""] = result.stdout.split("\n")[0]?.split("\t") ?? []
  // Shared with the receiver's push-time gate (@yrd/bay change-identity.ts):
  // what this reader accepts and what the gate admitted are the same rule.
  const changeId = findChangeId(changeIdTrailerCandidates(changeIds))
  const bead = beads
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  const title = subject.trim()
  return {
    ...(changeId === undefined ? {} : { changeId }),
    ...(bead === undefined ? {} : { issue: bead, props: { bead } }),
    ...(title.length === 0 ? {} : { title }),
  }
}

export async function materializeCarrier(
  process: Pick<Process, "run">,
  repo: string,
  pushResult: Readonly<ReceiverResult>,
): Promise<void> {
  if (pushResult.change === undefined) return
  const ref = `refs/heads/${pushResult.branch}`
  const current = await resolveCommit(process, repo, ref)
  // Replaying a result must not fail; the carrier is already where it belongs.
  if (current === pushResult.headSha) return
  if (current !== undefined && !(await isAncestorCommit(process, repo, current, pushResult.headSha))) {
    throw new Error(
      `yrd: carrier '${pushResult.branch}' is at ${current.slice(0, 12)}, which the pushed head ` +
        `${pushResult.headSha.slice(0, 12)} does not descend from; rebase the change onto it and push again`,
    )
  }
  const previous = current ?? "0".repeat(pushResult.headSha.length)
  const args = ["update-ref", ref, pushResult.headSha, previous]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `yrd: could not create carrier '${pushResult.branch}' at ${pushResult.headSha.slice(0, 12)}`,
    )
  }
}

async function isAncestorCommit(
  process: Pick<Process, "run">,
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", ancestor, descendant]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  return result.exitCode === 0
}

/**
 * The ref that WOULD carry this content as its own change.
 *
 * `-rN` is the machine-parsed series convention (`revisionOf`), so the
 * suggestion has to respect it rather than blindly append: a push already on
 * `-r2` must be told `-r3`, not `-r2-r2`. Incremented as a BigInt because a ref
 * name may carry an arbitrarily long digit run, and `Number` would silently tie
 * two distinct revisions past 2^53 — the same reason `stranded.ts` compares
 * these as digit strings.
 */
function freshSubmitRef(base: string, change: string): string {
  const marker = revisionOf(change)
  if (marker === undefined) return `refs/for/${base}/${change}-r2`
  return `refs/for/${base}/${marker.stem}-r${(BigInt(marker.revision) + 1n).toString()}`
}

/**
 * Say, at the push, that this push did not append a revision.
 *
 * The S6 door below declines intake for any branch a LIVE record does not own,
 * and for a branch whose record is TERMINAL that decline is invisible: the push
 * is accepted, the submit fact is written, and the queue derives a NEW change
 * from it. An author who pushed expecting revision N+1 of their change gets a
 * different change number and no message — the freeze is discovered by looking,
 * afterwards, which is how it cost a cycle.
 *
 * Only the terminal-record case speaks. A branch with NO record is the ordinary
 * derived-lane submission — the overwhelmingly common path, and the one this
 * door exists to serve — and warning there would put a notice on every healthy
 * push, which is the same defect pointed the other way.
 *
 * This runs inside the receiver hook process, whose stderr git inherits, so the
 * line reaches the pusher's terminal as `remote:` output rather than only the
 * runner's log.
 */
function reportFrozenRecord(log: ConditionalLogger, app: YrdCliApp, result: Readonly<ReceiverResult>, branch: string) {
  const record = recordChanges(app.state().bays).find((pr) => pr.branch === branch)
  if (record === undefined) return
  const change = result.change ?? record.name ?? record.id
  const base = result.intake.base
  log.warn?.(
    `yrd: this push did not append a revision to change '${change}': that change is ${record.state} and no longer ` +
      `owns branch '${branch}'. The push was accepted — the submit fact stands at ${result.headSha} and the queue ` +
      `derives a NEW change from it — so nothing is lost, but revision ${currentChangeRev(record).n + 1} of ` +
      `'${change}' is not what this produced. To submit this content under a name that says so, push a fresh ref: ` +
      `git push --no-recurse-submodules bay HEAD:${freshSubmitRef(base, change)}`,
    {
      action: "receiver-frozen-record-no-revision",
      branch,
      change,
      pr: record.id,
      state: record.state,
      merged: record.merged,
      sha: result.headSha,
      freshRef: freshSubmitRef(base, change),
    },
  )
}

async function intakeResult(
  app: YrdCliApp,
  result: Readonly<ReceiverResult>,
  process: Pick<Process, "run">,
  repo: string,
  log: ConditionalLogger,
): Promise<void> {
  // Before the dispatch, never after: a change that exists without its carrier is
  // exactly the undeliverable state this exists to prevent, and a failure here
  // leaves the result for the next drain to retry.
  await materializeCarrier(process, repo, result)
  // S6 door — the receiver's conditional dispatch: intake only when a live
  // record owns the branch (a grandfathered revision append). Otherwise the
  // branch is the DERIVED lane's, the submit-ref write that follows in the
  // drain IS the submission, and dispatching intake would refuse
  // `record-mint-retired` and wedge the drain retrying the result forever.
  const branch = result.intake.branch ?? result.branch
  if (branch !== undefined && !recordLaneOwnsBranch(app.state().bays, branch)) {
    reportFrozenRecord(log, app, result, branch)
    return
  }
  await app.dispatch(
    app.commands.bay.intake,
    { ...result.intake, receipt: result.id },
    { key: `receiver:${result.id}` },
  )
}

/** How many most-recent root Runs `queue audit` compares against git when the
 * caller does not say. Each distinct base sha costs two git reads, so the
 * walk stays bounded while still covering more history than any one incident. */
const DEFAULT_AUDITED_RUNS = 20

/**
 * The derived plan audit (23192, 23193) — git against the journal against
 * this process, every side named by the sha it was read from and no written
 * baseline anywhere:
 *
 * - **leg c, `installed-plan-stale`:** the plan THIS PROCESS installed versus
 *   the plan the base tip declares now. The per-cycle run gate reads only
 *   this leg (`recordedRuns: 0`).
 * - **leg a, `run-plan-mismatch`:** each recent recorded Run's plan versus
 *   what git derives at that Run's own base sha. Equal by construction.
 * - **leg b, informational:** the tip's plan versus the most recent
 *   declared-at-base Run, printed with both blob shas whether or not it moved.
 *
 * `runtime` is absent for the supervisor health probe, which deliberately
 * builds no queue runtime and opens no journal; the comparison then says so
 * instead of reporting an empty leg as a clean one.
 */
function queueAdministration(
  process: Pick<Process, "run">,
  repository: YrdRepository,
  options: Readonly<{
    base: string
    /** Repository-relative config authority path, `.yrd.yml` unless `--config` named another. */
    configAuthority: string
    configPath?: string
    /** The installed leg's subject. A full host compares its OWN runtime; the
     * supervisor probe, which builds none, compares the plan the live habitant
     * PUBLISHED in its heartbeat. `records` is absent when the invocation
     * opened no journal. */
    runtime?: Readonly<{
      source: "this-process" | "resident-heartbeat"
      /** Pid of the habitant whose published plan is compared. */
      pid?: number
      installed(): QueuePlanDescriptor
      records?(): readonly QueueRecord[]
      /** The passed checks-before-queueing record for one Run member at one
       * exact base sha — how legs a/b count a check the Run itself did not
       * execute as executed. Absent (the probe) leaves those checks read as
       * run-executed-only, which is why the probe never walks records. */
      admission?: AdmissionLookup
    }>
    /** Why no installed leg could run, when `runtime` is absent: named in the
     * comparison so an unread leg never prints as a clean one. */
    installedUnavailable?: string
  }>,
): YrdCliQueueAdministration {
  const base = baseIdentity(options.base)
  const declaredAt = (sha: string) => declaredPlanAt(repository, process, sha, options.configPath)
  return Object.freeze({
    async auditEnvironment(auditOptions = {}): Promise<QueueEnvironmentAuditEmission> {
      const recordedRuns = auditOptions.recordedRuns ?? DEFAULT_AUDITED_RUNS
      if (!Number.isSafeInteger(recordedRuns) || recordedRuns < 0) {
        throw new Error(`yrd: queue audit recordedRuns must be a non-negative integer, got ${String(recordedRuns)}`)
      }
      // The tip is inspected, never fetched: the audit is a read, and it must
      // name the same ref every Run resolves (origin/<base> when a remote is
      // configured, the local branch otherwise).
      const target = await inspectGitQueueTarget({ inject: { process }, repo: repository.repo, branch: base })
      const tip = await declaredAt(target.sha)
      const findings: QueueAuditFindingEmission[] = []
      const runtime = options.runtime
      const installed = runtime?.installed()
      if (runtime !== undefined && installed !== undefined) {
        const stale = installedPlanStale(
          base,
          tip,
          installed,
          runtime.source === "resident-heartbeat"
            ? `the habitant runner${runtime.pid === undefined ? "" : ` (pid ${String(runtime.pid)})`}`
            : undefined,
        )
        if (stale !== undefined) findings.push(stale)
      }
      let runs: NonNullable<QueueEnvironmentAuditComparison["runs"]> | undefined
      if (runtime?.records !== undefined && recordedRuns > 0) {
        const recent = recentRootRuns(runtime.records(), recordedRuns)
        const declaredByBase = new Map<string, Promise<DeclaredPlanAt>>()
        let compared = 0
        let explicit = 0
        let unrecorded = 0
        let latest: NonNullable<QueueEnvironmentAuditComparison["runs"]>["latest"] | undefined
        let sinceLatest: string | undefined
        for (const recorded of recent) {
          if (recorded.source === "explicit") {
            explicit += 1
            continue
          }
          if (recorded.source === undefined || recorded.baseSha === undefined) {
            unrecorded += 1
            continue
          }
          let declared = declaredByBase.get(recorded.baseSha)
          if (declared === undefined) {
            declared = declaredAt(recorded.baseSha)
            declaredByBase.set(recorded.baseSha, declared)
          }
          const mismatch = runPlanMismatch(recorded, await declared, runtime.admission)
          if (mismatch !== undefined) findings.push(mismatch)
          compared += 1
          if (latest === undefined) {
            latest = {
              run: recorded.run,
              baseSha: recorded.baseSha,
              ...(recorded.configBlobSha === undefined ? {} : { configBlobSha: recorded.configBlobSha }),
              steps: recorded.steps.map((step) => step.name),
            }
            sinceLatest = tipSinceLatestRun(base, tip, recorded, runtime.admission)
          }
        }
        runs = {
          read: recent.length,
          compared,
          explicit,
          unrecorded,
          ...(latest === undefined ? {} : { latest }),
          ...(sinceLatest === undefined ? {} : { sinceLatest }),
        }
      }
      // Submodule-alternates census (read-only): the environment fact the
      // 2026-08-25 outage lacked — a dead store pages, an armed store becomes
      // visible before it detonates. The audit only reports; repair stays
      // chief-routed. The common dir is resolved here, never hardcoded, so the
      // census follows whichever repository this administration serves.
      const commonDirProbe = await process.run({
        argv: ["git", "-C", repository.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: repository.worktree,
        timeoutMs: 30_000,
      })
      const commonDir = commonDirProbe.stdout.trim()
      if (commonDirProbe.timedOut || commonDirProbe.exitCode !== 0 || commonDir === "") {
        throw new Error(
          commonDirProbe.stderr.trim() ||
            `yrd: cannot resolve the common git dir for '${repository.worktree}' to census submodule alternates`,
        )
      }
      findings.push(...submoduleAlternatesFindings(await censusSubmoduleAlternates(commonDir), commonDir))
      // The receive path's own window, which no journal or ref walk can see: a
      // push git ACCEPTED whose result has not reached intake yet. The
      // directory is the receiver's default (`createGitPushReceiver` derives
      // it from the same stateDir and neither host call site overrides it) and
      // the census names it in every finding, so a census that looked in the
      // wrong place says where it looked rather than reporting clean.
      findings.push(
        ...receiverInboxFindings(await censusReceiverInbox(receiverInboxDir(repository.stateDir), Date.now())),
      )
      const comparison: QueueEnvironmentAuditComparison = {
        base,
        tip: {
          sha: tip.sha,
          configAuthority: options.configAuthority,
          ...(tip.configBlobSha === undefined ? {} : { configBlobSha: tip.configBlobSha }),
          steps: tip.steps.map((step) => step.name),
          batchSize: tip.batchSize,
        },
        ...(runtime === undefined || installed === undefined
          ? {}
          : {
              installed: {
                source: runtime.source,
                ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
                steps: installed.steps.map((step) => step.name),
                batchSize: installed.batchSize,
              },
            }),
        ...(runtime !== undefined || options.installedUnavailable === undefined
          ? {}
          : { installedUnavailable: options.installedUnavailable }),
        ...(runs === undefined ? {} : { runs }),
      }
      return { findings, comparison }
    },
  })
}

type HabitantRunnerSeed = Readonly<{
  id: string
  epoch: string
  host: string
  pane?: string
}>

/**
 * Which kind of pass is driving admission for this queue. BOTH kinds take the
 * one runner lease for the whole of their pass — that is the entire mechanism
 * that keeps them off each other. Only a `resident` additionally publishes a
 * heartbeat, sweeps, and follows; a `once` pass drains and exits.
 *
 * Measured 2026-09-01, 15:11 PDT: two `yrd queue run code --once` processes ran
 * at once against one repository. Only the resident took the lease, so a
 * one-shot refused beside a resident and NOTHING refused beside another
 * one-shot; the second pass cancelled the first's run ("entry checks no longer
 * belong to a live change revision") and the first exited 3 on PR2916.
 */
type QueueRunnerLeaseMode = "resident" | "once"

type QueueRunnerSeed = HabitantRunnerSeed & Readonly<{ leaseMode: QueueRunnerLeaseMode }>

type HabitantRunnerIdentity = QueueRunnerSeed & Readonly<{ queueId: string }>

type HabitantRunnerLease = Readonly<{ close(): Promise<void> }>

function habitantRunnerSeed(env: NodeJS.ProcessEnv): HabitantRunnerSeed {
  const pane = [env.HERDR_PANE_ID, env.CMUX_SURFACE_ID]
    .map((value) => value?.trim())
    .find((value): value is string => value !== undefined && value !== "")
  return Object.freeze({
    id: `yrd-cli:${globalThis.process.pid}`,
    epoch: randomUUID(),
    host: hostname(),
    ...(pane === undefined ? {} : { pane }),
  })
}

function habitantRunnerLog(log: ConditionalLogger, identity: HabitantRunnerSeed, queueId?: string): ConditionalLogger {
  return log.child({
    runner: identity.id,
    ...(queueId === undefined ? {} : { driverQueue: queueId }),
    driverEpoch: identity.epoch,
    host: identity.host,
    ...(identity.pane === undefined ? {} : { pane: identity.pane }),
  })
}

/** The three identity fields the lock body carries about whoever holds it:
 * `pid` and `startedAt` are written by git-super's `acquireExclusive`, and the
 * mode rides in the `holder` string this file composes. One reader, so a
 * refusal cannot name a pid from one read and a mode from another. */
type QueueRunnerLockOwner = Readonly<{ pid?: number; startedAt?: string; holder?: string }>

function queueRunnerLockOwner(stateDir: string): QueueRunnerLockOwner {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, "resident-runner", "writer.lock"), "utf8")) as {
      pid?: unknown
      startedAt?: unknown
      holder?: unknown
    }
    return {
      ...(typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(typeof value.startedAt === "string" && value.startedAt !== "" ? { startedAt: value.startedAt } : {}),
      ...(typeof value.holder === "string" && value.holder.trim() !== "" ? { holder: value.holder } : {}),
    }
  } catch {
    // silent-fallback-allow: unreadable advisory owner metadata means the lock owner is unknown.
    // This only ENRICHES a refusal that is already being raised from the lock's own
    // answer — it never decides ownership, and an empty read costs detail, not safety.
    return {}
  }
}

/**
 * Whether the process a record names is running — the one shared verdict
 * (`@yrd/process` recordedPidLiveness), not a fourth copy of `kill -0`.
 *
 * These callers assert no identity: the resident-runner records they read carry
 * a logical `startedAt` rather than an observed process start (see
 * `habitantRunnerRunning`), and the advisory writer lock records nothing but a
 * pid. Both gaps are closed by RECORDING an observed start, never by comparing
 * against a timestamp some other clock wrote.
 */
function processAlive(pid: number): boolean {
  return recordedPidIsRunning(recordedPidLivenessSync({ pid }))
}

function assertHabitantSupportsJournalVersion(stateDir: string, target: number): void {
  let record: Readonly<{
    pid?: unknown
    exitedAt?: unknown
    journalVersions?: unknown
  }>
  try {
    record = JSON.parse(readFileSync(join(stateDir, "resident-runner", "status.json"), "utf8")) as typeof record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    record.exitedAt !== undefined ||
    !processAlive(record.pid)
  ) {
    return
  }
  const versions =
    Array.isArray(record.journalVersions) &&
    record.journalVersions.every(
      (version: unknown) => typeof version === "number" && Number.isSafeInteger(version) && version > 0,
    )
      ? (record.journalVersions as number[])
      : []
  const capability = Math.max(0, ...versions)
  if (capability < target) {
    raiseFailure(
      "refusal",
      "journal-resident-version-skew",
      `yrd: live habitant pid ${String(record.pid)} supports journal v${String(capability)} but bump target is v${String(target)}; stop or upgrade that habitant first`,
    )
  }
}

/** The lease body's holder line. `mode` is the field that makes one-shot-beside-
 * one-shot expressible at all: pid and start time already ride in the lock body,
 * but nothing said WHAT was holding it, so the two kinds of pass could not name
 * each other. Appended after `epoch` so every existing reader of the
 * `queue=… epoch=…` prefix keeps parsing. */
function queueRunnerLeaseHolder(identity: HabitantRunnerIdentity): string {
  return `queue=${identity.queueId} epoch=${identity.epoch} mode=${identity.leaseMode}`
}

/**
 * Take the ONE admission lease for this queue, for the whole of this pass.
 *
 * Every driver takes it — a resident follow-runner and a one-shot `queue run`
 * alike — because they contend for exactly the same git state, and a lease only
 * one of them takes cannot keep two of the other off each other. The refusal
 * names the holder's mode, pid and start time, so an operator learns which kind
 * of pass is in the way without reading a status file.
 *
 * Nothing here proves liveness: the lock is a real `flock(2)` (git-super ->
 * @bearly/flock), so the kernel releases it when its holder dies and a stale
 * lease cannot exist. The dead-pid retry below is not a liveness heuristic —
 * it only absorbs the beat between a hard death and the kernel's release.
 */
async function acquireQueueRunnerLease(
  stateDir: string,
  identity: HabitantRunnerIdentity,
  log: ConditionalLogger,
): Promise<HabitantRunnerLease> {
  const runnerLog = log.child("runner")
  // When a prior owner died hard, the kernel may still be releasing the flock
  // for a beat after the pid is gone. Retry briefly if the lock body names a
  // dead pid so re-arm does not need a human `rm` of writer.lock (22306).
  const attempts = 8
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const released = Promise.withResolvers<void>()
    const acquired = Promise.withResolvers<void>()
    const held = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(
      async () => {
        acquired.resolve()
        await released.promise
      },
      { holder: queueRunnerLeaseHolder(identity) },
    )
    try {
      await Promise.race([acquired.promise, held])
      runnerLog.debug?.("Queue runner lease acquired", { runner: identity.id, mode: identity.leaseMode, stateDir })
      let closePromise: Promise<void> | undefined
      return Object.freeze({
        // Release is a `finally` inside `createExclusive`, so `await held`
        // rethrows anything the release threw: a lease that fails to come off
        // reaches the caller as a failure, never a swallowed one.
        close: () =>
          (closePromise ??= (async () => {
            released.resolve()
            await held
            runnerLog.debug?.("Queue runner lease released", {
              runner: identity.id,
              mode: identity.leaseMode,
              stateDir,
            })
          })()),
      })
    } catch (error) {
      lastError = error
      if (failureFact(error)?.code !== "exclusive-busy") throw error
      const ownerPid = queueRunnerLockOwner(stateDir).pid
      const ownerDead = ownerPid !== undefined && !processAlive(ownerPid)
      if (!ownerDead || attempt === attempts - 1) break
      // info, not warn: a dead owner pid is a confirmed-safe reclaim, and this
      // line reports its OWN retry succeeding (the loop is about to re-acquire
      // now that the stale holder is gone) — a documented, self-resolving race,
      // never a fault needing an operator's attention.
      runnerLog.info?.("resident-runner lock busy with dead owner pid; retrying reclaim", {
        action: "resident-runner-lock-reap-retry",
        ownerPid,
        attempt: attempt + 1,
      })
      await Bun.sleep(25 * (attempt + 1))
    }
  }
  const error = lastError
  if (failureFact(error)?.code === "exclusive-busy") {
    const detail = error instanceof Error ? error.message.replace(/^yrd:\s*/u, "") : String(error)
    const owner = queueRunnerLockOwner(stateDir)
    const ownerPid = owner.pid
    const deadHint =
      ownerPid !== undefined && !processAlive(ownerPid)
        ? ` Owner pid ${ownerPid} is dead — if re-arm keeps failing, inspect \`lsof ${join(stateDir, "resident-runner", "writer.lock")}\` for a live holder.`
        : ""
    // The three identity fields of whoever is in the way, printed together and
    // in the same order for every combination of holder and contender: a
    // refusal read at 2am must answer "what is holding it, since when, and as
    // what" without a second command.
    const holderFacts = [
      `mode=${queueRunnerHolderMode(owner.holder) ?? "unknown"}`,
      `pid=${ownerPid ?? "unknown"}`,
      `started=${owner.startedAt ?? "unknown"}`,
    ].join(" ")
    raiseFailure(
      "refusal",
      "resident-runner-active",
      `yrd: resident-runner-active: ${detail}. Holder: ${holderFacts}. ` +
        `${queueRunnerContentionCure(queueRunnerHolderMode(owner.holder), identity.leaseMode, ownerPid)}${deadHint}`,
    )
  }
  throw error
}

/** The holder's mode as the lock body records it, or undefined when the body is
 * unreadable or was written by a Yrd that did not record one. Undefined is a
 * real answer and prints as `unknown` — never guessed into "resident". */
function queueRunnerHolderMode(holder: string | undefined): QueueRunnerLeaseMode | undefined {
  const mode = holder === undefined ? undefined : /\bmode=(resident|once)\b/u.exec(holder)?.[1]
  return mode === "resident" || mode === "once" ? mode : undefined
}

/** What to actually DO, chosen by who holds the lease — not by who is refused.
 * A resident holder is a service to submit work to; a one-shot holder is a pass
 * that ends on its own, and telling an operator to "stop the runner" there
 * sends them hunting for a service that does not exist. */
function queueRunnerContentionCure(
  holder: QueueRunnerLeaseMode | undefined,
  contender: QueueRunnerLeaseMode,
  ownerPid: number | undefined,
): string {
  if (holder === "once") {
    const who = ownerPid === undefined ? "that one-shot pass" : `that one-shot pass (pid ${ownerPid})`
    return `Wait for ${who} to finish, or stop it, before starting another 'yrd queue run'.`
  }
  if (holder === "resident" && contender === "once") {
    return (
      "A one-shot 'yrd queue run' cannot run beside the resident runner. Submit with 'yrd pr submit <branch>' and " +
      "let the resident runner drain it; if the resident is dead, 'hab --hab-dir <root> restart yrd-runner'."
    )
  }
  return "Stop the active 'yrd queue run' before starting another."
}

async function closeRuntime(
  app: YrdCliApp | undefined,
  process: Process,
  scope: Scope,
  habitant?: HabitantRunnerLease,
  candidatePool?: CandidatePool,
): Promise<void> {
  try {
    await app?.close()
  } finally {
    try {
      // Warm worktrees are removed via Git BEFORE the Process closes — a closed
      // Process rejects every run(), which would strand the pool's worktrees.
      await candidatePool?.close()
    } finally {
      try {
        await process.close()
      } finally {
        try {
          await scope[Symbol.asyncDispose]()
        } finally {
          await habitant?.close()
        }
      }
    }
  }
}

type ShutdownSignal = "SIGINT" | "SIGTERM"

/** Announce a graceful drain as ONE structured loggily record — never a bare
 * wrapped stderr paragraph, since the habitant runner's stderr IS its log
 * stream. The force-stop hint and its consequences are structured FIELDS, so a
 * viewer can surface them without parsing prose. No recovery argv rides along
 * (5e cut 6): restart re-derives recovery — the next runner start reclaims a
 * dead predecessor's leases and the habitant sweep settles expired ones. */
export function reportGracefulShutdown(log: ConditionalLogger, signal: ShutdownSignal, repositoryRoot: string): void {
  log.warn?.(`Stopping after the current run finishes (${signal}); press Ctrl-C again to stop immediately.`, {
    signal,
    mode: "drain",
    forceStop: "press Ctrl-C again to stop immediately",
    repository: repositoryRoot,
  })
}

/**
 * Settle the one-shot pass's own in-flight run, so the journal records why it
 * stopped instead of leaving a row `in_progress` for the next pass to find.
 *
 * Bounded and non-throwing (`settleDrainedQueuePass`): this runs on the way
 * out, and a throw here would cost BOTH the terminal state and the lease
 * release that follows it in `closeHost`'s `finally`. Every failure is reported
 * loudly with its scope instead. No recovery argv rides along (5e cut 6):
 * restart re-derives recovery — the next runner start reclaims a dead
 * predecessor's leases and the habitant sweep settles expired ones.
 */
async function settleOneShotQueueRun(
  host: YrdHost,
  runner: string,
  signal: ShutdownSignal,
  log: ConditionalLogger,
): Promise<void> {
  await settleDrainedQueuePass(host.app.queue, runner, signal, {
    info: (message, props) => log.info?.(message, { ...props, repository: host.repository.repo }),
    error: (message, props) => log.error?.(message, { ...props, repository: host.repository.repo }),
  })
}

/** The slice of `process` signal ownership needs, injectable so the two-phase
 * behaviour below can be driven by a test without a test runner that kills
 * itself on `forward()`. */
export type ShutdownProcess = Readonly<{
  on(event: ShutdownSignal, handler: () => void): void
  off(event: ShutdownSignal, handler: () => void): void
  kill(pid: number, signal: ShutdownSignal): void
  readonly pid: number
}>

/**
 * Own process signals at the run-to-exit CLI boundary, then restore native
 * signal exit semantics only after the host has drained its resources.
 *
 * Two phases when a `drain` is supplied: the first signal ASKS (the command
 * keeps running and stops on its own terms), the second TAKES (host close, then
 * the native signal is re-raised so the exit status stays honest). With no
 * `drain`, every signal is the second kind — which is what every one-shot queue
 * pass got until 2026-09-01, and why three of them died mid-job in one day.
 *
 * `bound` is the promise the first phase cannot keep on its own: a drain waits
 * on work it does not control, so without a deadline "graceful" and "hung" are
 * the same observation. At the bound it escalates itself, exactly as a second
 * signal would, after saying so.
 */
export function bindProcessShutdown(
  shutdown: (signal: ShutdownSignal) => Promise<void>,
  drain?: (signal: ShutdownSignal) => void,
  bound?: Readonly<{ ms: number; onExpire?: (signal: ShutdownSignal) => void }>,
  runtime: ShutdownProcess = globalThis.process as unknown as ShutdownProcess,
): () => void {
  let draining = false
  let hardSignal: ShutdownSignal | undefined
  let boundTimer: ReturnType<typeof setTimeout> | undefined
  const remove = (): void => {
    runtime.off("SIGINT", onSigint)
    runtime.off("SIGTERM", onSigterm)
  }
  const forward = (signal: ShutdownSignal): void => {
    remove()
    runtime.kill(runtime.pid, signal)
  }
  const clearBound = (): void => {
    if (boundTimer !== undefined) clearTimeout(boundTimer)
    boundTimer = undefined
  }
  const finish = (): void => {
    clearBound()
    remove()
    if (hardSignal !== undefined) forward(hardSignal)
  }
  const escalate = (signal: ShutdownSignal): void => {
    if (hardSignal !== undefined) return
    hardSignal = signal
    clearBound()
    // Closing the host aborts a live renderer, but the renderer owns terminal
    // restoration in its surrounding `using` block. Let the command boundary
    // unwind that block before `finish()` restores native signal exit status.
    void shutdown(signal).catch(() => undefined)
  }
  const onSignal = (signal: ShutdownSignal): void => {
    if (drain !== undefined && !draining) {
      draining = true
      drain(signal)
      if (bound !== undefined) {
        boundTimer = setTimeout(() => {
          bound.onExpire?.(signal)
          escalate(signal)
        }, bound.ms)
        // Never a reason for the process to stay alive: the bound exists to end
        // a stop, so holding the loop open for it would be the hang it prevents.
        boundTimer.unref?.()
      }
      return
    }
    escalate(signal)
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  runtime.on("SIGINT", onSigint)
  runtime.on("SIGTERM", onSigterm)
  return finish
}

export type YrdHostOptions = Readonly<{
  cwd?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  log?: ConditionalLogger
  workspaceLifecycle?: GitWorkspaceLifecycleHooks
  /** Opaque logical submitter supplied by an embedding host; standalone Yrd defaults to operator. */
  defaultSubmitter?: string
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer
  /**
   * Runs once after the host is fully closed and before the executable
   * boundary terminates. Detached background work belongs here rather than
   * after the call: past this point the process may exit without returning.
   */
  afterCommand?: () => void
}>

export type YrdProcessHostOptions = Pick<
  YrdHostOptions,
  "workspaceLifecycle" | "defaultSubmitter" | "afterCommand" | "authorizeSubmoduleModelChange"
> &
  Readonly<{
    /** The composition host's declared handle for the selected repository
     * (`code`, `pm`) — the queue LABEL run names lead with (item 36). Absent
     * for standalone invocations, which have no config handles yet. */
    repositoryLabel?: string
    /** Host-evaluated stranded-refs exemptions. Copied onto IO so both the
     * `queue uncarried` command and the habitant sweeper share one adapter. */
    strandedFilter?: YrdCliIO["filterStrandedFindings"]
    /** Test-only required census dependency for destructive Bay fixtures. */
    testPathHolderCensus?: PathHolderCensusReader
  }>

type YrdRuntimeHostOptions = YrdHostOptions &
  Readonly<{
    /** Loaded identity attested by the process host for a gitless sealed root. */
    implementationSource?: string
    /** Repair a stale view registry before the runtime replays Journal history. */
    repairViewsBeforeReplay?: boolean
    testPathHolderCensus?: PathHolderCensusReader
  }>

export const YRD_TEST_PATH_HOLDER_CENSUS_ENV = "YRD_TEST_PATH_HOLDER_CENSUS" as const

function testPathHolderCoverage(complete: boolean): PathHolderCensus["coverage"] {
  return globalThis.process.platform === "linux"
    ? {
        platform: "linux",
        scope: "same-uid",
        procRoot: "test-fixture",
        complete,
        processes: {
          enumerated: complete ? 0 : 1,
          sameUid: complete ? 0 : 1,
          otherUid: 0,
          unavailable: { exited: 0, denied: 0 },
        },
        sources: {
          cwd: { readable: 0, unavailable: { exited: 0, denied: complete ? 0 : 1 } },
          exe: { readable: 0, unavailable: { exited: 0, denied: complete ? 0 : 1 } },
          root: { readable: 0, unavailable: { exited: 0, denied: complete ? 0 : 1 } },
          maps: { readable: 0, unavailable: { exited: 0, denied: complete ? 0 : 1 } },
          fd: { readable: 0, unavailable: { exited: 0, denied: complete ? 0 : 1 } },
        },
      }
    : { platform: "darwin", mechanism: "lsof", complete: true }
}

function emptyTestPathHolderCensus(complete: boolean): PathHolderCensusReader {
  // oxlint-disable-next-line typescript/require-await -- PathHolderCensusReader is a Promise-returning contract.
  return async (): Promise<PathHolderCensus> => ({ holders: [], coverage: testPathHolderCoverage(complete) })
}

function fileTestPathHolderCensus(path: string): PathHolderCensusReader {
  if (!isAbsolute(path)) throw new Error(`yrd: test path-holder census file must be absolute, found '${path}'`)
  // oxlint-disable-next-line typescript/require-await -- PathHolderCensusReader is a Promise-returning contract.
  return async (): Promise<PathHolderCensus> => {
    const value = JSON.parse(readFileSync(path, "utf8")) as { complete?: unknown; holders?: unknown }
    if (typeof value.complete !== "boolean" || !Array.isArray(value.holders)) {
      throw new Error(`yrd: test path-holder census file '${path}' requires boolean complete and holders[]`)
    }
    const holders = value.holders.map((holder, index): PathHolder => {
      if (
        typeof holder !== "object" ||
        holder === null ||
        !Number.isSafeInteger((holder as { pid?: unknown }).pid) ||
        typeof (holder as { source?: unknown }).source !== "string" ||
        typeof (holder as { target?: unknown }).target !== "string"
      ) {
        throw new Error(`yrd: invalid test path-holder census row ${index} in '${path}'`)
      }
      return holder as PathHolder
    })
    return { holders: holders.filter(({ pid }) => processAlive(pid)), coverage: testPathHolderCoverage(value.complete) }
  }
}

function resolveTestPathHolderCensus(
  env: NodeJS.ProcessEnv,
  injected: PathHolderCensusReader | undefined,
): PathHolderCensusReader | undefined {
  const fixture = env[YRD_TEST_PATH_HOLDER_CENSUS_ENV]
  if (env.NODE_ENV !== "test") {
    if (injected !== undefined || fixture !== undefined) {
      throw new Error("yrd: test path-holder census wiring is available only under NODE_ENV=test")
    }
    return undefined
  }
  if (injected !== undefined) return injected
  if (fixture === "complete-empty") return emptyTestPathHolderCensus(true)
  if (fixture === "incomplete-denied") return emptyTestPathHolderCensus(false)
  if (fixture?.startsWith("file:") === true) return fileTestPathHolderCensus(fixture.slice("file:".length))
  if (fixture !== undefined) {
    throw new Error(
      `yrd: ${YRD_TEST_PATH_HOLDER_CENSUS_ENV} must be complete-empty, incomplete-denied, or file:<absolute-path>, found '${fixture}'`,
    )
  }
  // oxlint-disable-next-line typescript/require-await -- PathHolderCensusReader is a Promise-returning contract.
  return async () => {
    throw new Error(
      `yrd: destructive test fixture must inject a path-holder census; set ${YRD_TEST_PATH_HOLDER_CENSUS_ENV} or pass testPathHolderCensus`,
    )
  }
}

export async function createYrdHost(options: YrdHostOptions = {}): Promise<YrdHost> {
  return createYrdRuntimeHost(options, undefined, "active")
}

/**
 * Build only the read-only plan audit needed by the habitant health command.
 * It reads the base tip's declared plan from git but deliberately has no app
 * and no journal, so its cost cannot grow with delivery history — and its
 * comparison says which legs that leaves unread rather than reporting them
 * clean.
 */
async function runnerHealthProbeServices(options: YrdRuntimeHostOptions): Promise<YrdCliServices> {
  const scope = createScope("yrd-runner-health")
  const ownsLog = options.log === undefined
  const log =
    options.log ??
    createYrdLogger(resolveYrdObservability({}, options.env ?? globalThis.process.env), (text) =>
      globalThis.process.stderr.write(text),
    )
  const env = cleanGitEnvironment(options.env ?? globalThis.process.env)
  const census = resolveTestPathHolderCensus(env, options.testPathHolderCensus)
  const process = withGitTimeoutRetry(
    withGitIndexLockRetry(
      createProcess({
        cwd: options.cwd,
        env,
        inject: { scope, log, ...(census === undefined ? {} : { pathHolderCensus: census }) },
      }),
    ),
  )
  try {
    const repository = await discoverYrdRepository({ cwd: options.cwd, env, process })
    const loaded = await loadRepositoryConfig(repository, process, options.configPath)
    // The probe builds no runtime, so its installed leg is the plan the LIVE
    // habitant published in its heartbeat (23192 leg c). Liveness is judged
    // exactly as the health classifier judges it: an exit marker or a dead pid
    // means nothing is serving, and a habitant older than the field published
    // nothing — each named in the comparison, never compared as empty.
    const habitant = activeHabitantRunner(await habitantRunnerStatus(repository.repo, repository.stateDir))
    const published = habitant?.installedPlan
    const administration = queueAdministration(process, repository, {
      base: loaded.config.base,
      configAuthority: loaded.path === undefined ? ".yrd.yml" : relative(repository.repo, loaded.path),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(habitant !== undefined && habitant !== null && published !== undefined
        ? { runtime: { source: "resident-heartbeat", pid: habitant.pid, installed: () => published } }
        : {
            installedUnavailable:
              habitant === null || habitant === undefined
                ? "no live habitant runner, so no installed plan was published to compare"
                : `the habitant runner (pid ${String(habitant.pid)}) published no installed plan — it predates the ` +
                  "field; restart it to publish one",
          }),
    })
    if (administration.auditEnvironment === undefined) {
      throw new Error("yrd: runner health audit is unavailable")
    }
    // The audit still runs EAGERLY here — the probe closes its process and
    // scope in `finally`, so a deferred audit would have no runtime left. A
    // failure is carried forward rather than thrown out of construction: the
    // health classifier owns what it means for a service, and it cannot
    // classify a failure that already escaped past it.
    const audit = await administration.auditEnvironment().then(
      (result) => () => Promise.resolve(result),
      (error: unknown) => () => Promise.reject(error),
    )
    return Object.freeze({
      base: loaded.config.base,
      queue: Object.freeze({ auditEnvironment: audit }),
    })
  } finally {
    try {
      await closeRuntime(undefined, process, scope)
    } finally {
      if (ownsLog) log.end()
    }
  }
}

function createViewerWorkspace(): BayWorkspace {
  const refuse = () => ({
    status: "completed" as const,
    conclusion: "failure" as const,
    error: { code: "viewer-read-only", message: "yrd: viewer runtime cannot mutate bay workspaces" },
  })
  return Object.freeze({
    revision: "yrd-viewer-read-only-v1",
    provision: refuse,
    refresh: refuse,
    checkpoint: refuse,
    deprovision: refuse,
  })
}

async function createViewerReceiver(repository: YrdRepository, process: Process): Promise<GitPushReceiver> {
  const args = ["rev-parse", "--show-object-format"]
  const result = await process.run({
    argv: ["git", "-C", repository.repo, ...args],
    cwd: repository.repo,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  const objectFormat = result.stdout.trim()
  if (result.exitCode !== 0 || (objectFormat !== "sha1" && objectFormat !== "sha256")) {
    throw new Error(result.stderr.trim() || `yrd: unsupported Git object format '${objectFormat}'`)
  }
  const refuse = (): never => {
    throw new Error("yrd: viewer runtime cannot mutate or drain the push receiver")
  }
  return Object.freeze({
    version: 1,
    receiverPath: join(repository.stateDir, "prs.git"),
    mainRepo: repository.repo,
    stateDir: repository.stateDir,
    inboxDir: join(repository.stateDir, "receiver-inbox"),
    objectFormat,
    shaLength: objectFormat === "sha1" ? 40 : 64,
    process,
    prepare: refuse,
    finalize: refuse,
    drain: refuse,
  })
}

async function createYrdRuntimeHost(
  options: YrdRuntimeHostOptions,
  /** Every queue-run driver, resident or one-shot; undefined for every other
   * command, which takes no admission lease at all. */
  runnerSeed: QueueRunnerSeed | undefined,
  mode: "active" | "viewer",
): Promise<YrdHost & Readonly<{ habitant?: HabitantRunnerIdentity }>> {
  const scope = createScope("yrd-host")
  const ownsLog = options.log === undefined
  const log =
    options.log ??
    createYrdLogger(resolveYrdObservability({}, options.env ?? globalThis.process.env), (text) =>
      globalThis.process.stderr.write(text),
    )
  const env = cleanGitEnvironment(options.env ?? globalThis.process.env)
  const census = resolveTestPathHolderCensus(env, options.testPathHolderCensus)
  const process = withGitTimeoutRetry(
    withGitIndexLockRetry(
      createProcess({
        cwd: options.cwd,
        env,
        inject: { scope, log, ...(census === undefined ? {} : { pathHolderCensus: census }) },
      }),
    ),
  )
  let app: YrdCliApp | undefined
  let habitantLease: HabitantRunnerLease | undefined
  let candidatePool: CandidatePool | undefined
  try {
    const repository = await discoverYrdRepository({ cwd: options.cwd, env, process })
    const loaded = await loadRepositoryConfig(repository, process, options.configPath)
    const runner =
      runnerSeed === undefined
        ? undefined
        : Object.freeze({
            ...runnerSeed,
            // The canonical id and the historical `resolve(repo)#base` agree
            // for a habitant started in the main worktree — which every
            // production habitant is — so recorded heartbeats stay comparable.
            queueId: canonicalQueueId(repository.repo, baseIdentity(loaded.config.base)),
          })
    // BOTH modes take it, and before anything else this host does: the lease is
    // what keeps two admission drivers apart, so it is taken before the receiver
    // is opened, before the queue is read, and before any compose or step work.
    if (runner !== undefined) {
      habitantLease = await acquireQueueRunnerLease(
        repository.stateDir,
        runner,
        habitantRunnerLog(log, runner, runner.queueId),
      )
    }
    // A one-shot holds the lease but is not a SERVICE: no heartbeat, no driver
    // epoch, no retention attestation. Everything downstream that means "the
    // resident runner" keeps reading undefined for a one-shot pass.
    const habitant = runner?.leaseMode === "resident" ? runner : undefined
    using _setupSpan = log.span?.("setup", { phase: "pre-worktree", repo: repository.repo })
    const discoveredImplementationSource = sourceRepositoryFor(import.meta.url)
    const receiver =
      mode === "active"
        ? await createGitPushReceiver({
            mainRepo: repository.repo,
            stateDir: repository.stateDir,
            process,
          })
        : await createViewerReceiver(repository, process)
    const queueReadModel = createQueueReadModel({ dir: repository.stateDir })
    const journal =
      mode === "active"
        ? createJournal({
            dir: repository.stateDir,
            views: [queueReadModel.view],
            writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
            inject: { log },
          })
        : createReadOnlyJournal({
            dir: repository.stateDir,
            inject: { log },
          })
    if (options.repairViewsBeforeReplay === true) {
      await (journal as MutableJournal).views.rebuild()
    }
    const defaultSubmitter = options.defaultSubmitter ?? "operator"
    if (mode === "active") {
      candidatePool = createCandidatePool({
        repo: repository.repo,
        parent: repository.baysRoot,
        git: createCandidatePoolGit(process, env),
        log,
      })
    }
    const implementationSource =
      options.implementationSource ?? (await implementationSourceIdentity(process, discoveredImplementationSource))
    if (habitant !== undefined && implementationSource === undefined) {
      raiseFailure(
        "refusal",
        "runtime-source-unavailable",
        "yrd: habitant runner cannot determine the implementation source it loaded; not starting",
      )
    }
    app = await createDefaultYrdRuntimeApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      ...(mode === "active" ? { receiverPath: receiver.receiverPath } : { workspace: createViewerWorkspace() }),
      ...(options.workspaceLifecycle === undefined ? {} : { workspaceLifecycle: options.workspaceLifecycle }),
      journal,
      process,
      config: loaded.config,
      ...(loaded.path === undefined ? {} : { configAuthority: relative(repository.repo, loaded.path) }),
      defaultSubmitter,
      ...(options.authorizeSubmoduleModelChange === undefined
        ? {}
        : { authorizeSubmoduleModelChange: options.authorizeSubmoduleModelChange }),
      scope,
      log,
      candidatePool,
      runnerId: habitant?.id ?? `yrd-cli:${globalThis.process.pid}`,
      ...(implementationSource === undefined ? {} : { implementationSource }),
      ...(discoveredImplementationSource === undefined
        ? {}
        : { implementationRoot: discoveredImplementationSource.root }),
    })
    if (mode === "active") {
      // Cutover migration: a pre-settlement (v1) journal can leave non-terminal
      // legacy roots that the v2 projection cannot settle on its own. Settle the
      // abandoned ones (loud result) and refuse only while a previous writer still
      // holds a live lease — before any command reads or advances the queue.
      await app.queue.quiesceLegacyRoots({ now: new Date().toISOString(), by: "yrd/migration" })
    }
    const runtimeApp = app
    const resolveTarget = receiverTarget(runtimeApp, process, repository.repo)
    const receiverLog = log.child("receiver")
    const drain = async (): Promise<void> => {
      if (mode === "viewer") throw new Error("yrd: viewer runtime cannot drain the push receiver")
      using _span = receiverLog.span?.("drain")
      const result = await receiver.drain({
        resolveTarget,
        intakePolicy: INTAKE_POLICY,
        intake: (result) => intakeResult(runtimeApp, result, process, repository.repo, receiverLog),
        lockTimeoutMs: 30_000,
      })
      // Two dispositions, because the inbox holds two different things.
      //
      // A FAILED entry is wreckage — a result that would not parse, or whose
      // stored authorization no longer matches the push it claims. Refusing is
      // right there: it is an integrity signal about this inbox.
      //
      // An AMBIGUOUS entry is not. `pre-receive` writes the `.prepared.json`
      // BEFORE Git decides whether to accept the update, so a ref that does not
      // carry the head means only "this push did not complete" — in flight,
      // rejected downstream, or abandoned, three events with byte-identical
      // files. It is the same class as `deferred`, which this drain has always
      // skipped, and `recoverPrepared` retries it on every pass, so an entry
      // that becomes resolvable is delivered later under the same id.
      //
      // Refusing the whole inbox on one of those made one submitter's
      // interruption stop the queue for everybody: measured 2026-09-01 17:29:57
      // PDT, an orphaned entry left every later pass exiting 3 while eight
      // eligible changes waited behind a row none of them had anything to do
      // with. So it is skipped and reported, never fatal — and reported with
      // the per-entry rows, because an operator cannot clear what nobody named.
      const refusal = reportReceiverDrainOutcome(receiverLog, result, Date.now())
      if (refusal !== undefined) throw refusal
    }
    if (mode === "active") await drain()
    const checks = configuredChecks(process, repository.stateDir, loaded.config, env)
    const guards = configuredGuards(process, repository.stateDir, loaded.config, env)
    const mergeRecordBaseSha = async (): Promise<string> =>
      (
        await resolveGitQueueTarget({
          inject: { process },
          repo: repository.repo,
          branch: baseIdentity(loaded.config.base),
        })
      ).sha
    const services = Object.freeze({
      queue: queueAdministration(process, repository, {
        base: loaded.config.base,
        configAuthority: loaded.path === undefined ? ".yrd.yml" : relative(repository.repo, loaded.path),
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
        runtime: {
          source: "this-process",
          // The installed leg must come from the live runtime object — the
          // policy and steps this process actually installed — never
          // re-derived from config, which is the other side of the comparison.
          installed: () => ({ batchSize: runtimeApp.queue.state().batchSize, steps: runtimeApp.queue.steps() }),
          records: () => Queues.values(runtimeApp.queue.state()),
          // How legs a/b see the checks-before-queueing stage: the passed
          // record for the member's EXACT revision at the Run's own base sha.
          // A Run that reused this evidence executed only the remainder, and
          // reading its executed steps alone as "what was checked" is the
          // false "did not run" this closes (item 0).
          admission: (member, baseSha) => {
            const pr = getChangeRecord(runtimeApp.state().bays, member.id)
            const revision = pr?.revs.find((rev) => rev.n === member.revision)
            const admission = revision?.admission
            if (admission?.status !== "passed" || admission.baseSha !== baseSha) return undefined
            return admission.steps
              .filter((step) => step.status === "passed")
              .map((step) => ({ name: step.name, revision: step.revision }))
          },
        },
      }),
      recut: createGitChangeRemerger({ inject: { process }, repo: repository.repo, env }),
      mergeRecords: Object.freeze({
        async find(selector: string) {
          return findRepositoryMergeRecords({
            inject: { process },
            repo: repository.repo,
            baseSha: await mergeRecordBaseSha(),
            selector,
          })
        },
        async all() {
          return findRepositoryMergeRecords({
            inject: { process },
            repo: repository.repo,
            baseSha: await mergeRecordBaseSha(),
            // The bulk read exists for index reconstruction over an estate that may already be
            // damaged; one unverifiable note must cost that note, not the whole scan.
            isolateUnverifiable: true,
          })
        },
        async retractUnprovable(repairOptions: Readonly<{ apply: boolean; now: string }>) {
          return repairMergeRecordEstate({
            inject: { process },
            repo: repository.repo,
            baseSha: await mergeRecordBaseSha(),
            now: repairOptions.now,
            apply: repairOptions.apply,
          })
        },
      }),
      base: loaded.config.base,
      [MergeAuthorityBoundary]: loaded.config.merge ?? "expected",
      checks,
      guards,
      journal: Object.freeze({
        importOrphan: (sourcePath: string) =>
          importOrphanJournal({
            dir: repository.stateDir,
            sourcePath,
            importedBy: defaultSubmitter,
            views: [queueReadModel.view],
            log,
          }),
        rebuildViews: () => {
          if (mode !== "active") throw new Error("yrd: viewer runtime cannot rebuild Journal views")
          return (journal as MutableJournal).views.rebuild()
        },
        bump: (version: number) => {
          if (mode !== "active") throw new Error("yrd: viewer runtime cannot bump the Journal version")
          assertHabitantSupportsJournalVersion(repository.stateDir, version)
          return (journal as MutableJournal).administration.bump(version)
        },
      }),
      queueReadModel: Object.freeze({ snapshot: queueReadModel.snapshot }),
      process,
      resolveBayWorkspacePath: (bay: string, recordedPath?: string) =>
        resolveBayWorkspacePath({ baysRoot: repository.baysRoot, bay, recordedPath }),
      environment: env,
      ...(options.authorizeSubmoduleModelChange === undefined
        ? {}
        : { submoduleModelChangeAuthorizer: options.authorizeSubmoduleModelChange }),
    })
    let closePromise: Promise<void> | undefined
    const close = () =>
      (closePromise ??= closeRuntime(app, process, scope, habitantLease, candidatePool).finally(() => {
        if (ownsLog) log.end()
      }))
    return Object.freeze({
      app,
      repository,
      config: loaded.config,
      receiver,
      process,
      ...(habitant === undefined ? {} : { habitant }),
      ...(implementationSource === undefined ? {} : { implementationSource }),
      ...(mode === "active" ? { journalRetention: (journal as MutableJournal).retention } : {}),
      services,
      drain,
      close,
      [Symbol.asyncDispose]: close,
    })
  } catch (error) {
    await closeRuntime(app, process, scope, habitantLease, candidatePool)
    if (ownsLog) log.end()
    throw error
  }
}

async function runReceiverHook(
  mode: "pre-receive" | "post-receive",
  env: NodeJS.ProcessEnv,
  workspaceLifecycle?: GitWorkspaceLifecycleHooks,
): Promise<void> {
  const gitDir = env.GIT_DIR
  if (gitDir === undefined || gitDir === "") throw new Error("yrd: receiver hook requires GIT_DIR")
  const scope = createScope("yrd-receiver-hook")
  const rootLog = createYrdLogger(resolveYrdObservability({}, env), (text) => globalThis.process.stderr.write(text))
  const log = rootLog.child({ host: "receiver-hook", mode })
  const runtimeProcess = withGitTimeoutRetry(
    withGitIndexLockRetry(createProcess({ cwd: globalThis.process.cwd(), env, inject: { scope, log } })),
  )
  let app: YrdCliApp | undefined
  try {
    const receiver = await loadGitPushReceiver(resolve(globalThis.process.cwd(), gitDir), runtimeProcess)
    const repository = await discoverYrdRepository({ cwd: receiver.mainRepo, env, process: runtimeProcess })
    const loaded = await loadRepositoryConfig(repository, runtimeProcess)
    const implementationRepository = sourceRepositoryFor(import.meta.url)
    const implementationSource = await implementationSourceIdentity(runtimeProcess, implementationRepository)
    app = await createDefaultYrdRuntimeApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      receiverPath: receiver.receiverPath,
      journal: createJournal({
        dir: repository.stateDir,
        views: [createQueueReadModel({ dir: repository.stateDir }).view],
        writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
        inject: { log },
      }),
      process: runtimeProcess,
      config: loaded.config,
      ...(workspaceLifecycle === undefined ? {} : { workspaceLifecycle }),
      scope,
      log,
      ...(implementationSource === undefined ? {} : { implementationSource }),
      ...(implementationRepository === undefined ? {} : { implementationRoot: implementationRepository.root }),
    })
    const runtimeApp = app
    await runReceiverHookFromEnvironment(mode, {
      env,
      process: runtimeProcess,
      resolveTarget: receiverTarget(runtimeApp, runtimeProcess, repository.repo),
      intakePolicy: INTAKE_POLICY,
      intake: (result) => intakeResult(runtimeApp, result, runtimeProcess, repository.repo, log),
      // The queue's own admission gate: an invalid pushed `.yrd.yml` is refused
      // at the push itself, so it can never reach the base ref queue.audit /
      // loadYrdConfig reads. See validatePushedYrdConfig's doc for the PR1337
      // incident this closes.
      validateConfig: validatePushedYrdConfig,
      // Push-time half of the derived lane's Change-Id contract: exempt only
      // carriers a LIVE record owns — the same predicate the S6 door dispatch
      // (`intakeResult`) consults, so the gate and the lane never disagree
      // about which branch owes a tip trailer.
      recordOwnsBranch: (branch) => recordLaneOwnsBranch(runtimeApp.state().bays, branch),
      // branch-is-change phase 2a: an accepted refs/yrd/submit/<branch> write
      // becomes a journal fact the queue projects; before this the ref stood
      // in git and no reader could see it (@yrd/core/22991).
      branchSubmitted: async (fact) => {
        await runtimeApp.bays.recordBranchSubmit(fact)
      },
      branchUnsubmitted: async (fact) => {
        await runtimeApp.bays.recordBranchUnsubmit(fact)
      },
      // The pusher is blocked on this hook for its whole duration: git has
      // already applied the refs, and receive-pack does not return until
      // post-receive exits. Every other bound in this path is per-git-call
      // (`GIT_TIMEOUT_MS`, retried three times by `withGitTimeoutRetry`) or
      // per-lock (the journal's own 30s), so the TOTAL was unbounded and a
      // push paid for every branch waiting in the inbox. This is the only
      // bound over the whole critical section.
      //
      // Not the cure for the 102s stall of 2026-08-31: that was the hook's own
      // worktree-store init waiting on `yrd-worktree-mutations/writer.lock`
      // held by its ANCESTOR `git-super push`, fixed in git-super by 51c72de.
      // This bounds what is left over once that deadlock is gone.
      drainDeadlineMs: RECEIVE_DRAIN_BUDGET_MS,
      // Wait briefly rather than not at all: a concurrent drain usually
      // finishes in well under a second, and the alternative (`?? 0`) turned
      // an ordinary overlap into a deferral on every collision.
      lockTimeoutMs: RECEIVE_DRAIN_LOCK_WAIT_MS,
      drainDeferred: (drained) => reportDeferredDrain(log, drained),
    })
  } finally {
    await closeRuntime(app, runtimeProcess, scope)
    rootLog.end()
  }
}

/**
 * How long ONE post-receive drain pass may run, and how long it waits for the
 * drain lock.
 *
 * The budget is a latency promise to the pusher, not a capacity limit: results
 * the pass does not reach stay `pending`, and the next push or the resident
 * runner takes them. Ten seconds is well under any human's patience for a push
 * and comfortably above the ~1s a healthy single-result drain measures.
 */
const RECEIVE_DRAIN_BUDGET_MS = 10_000
const RECEIVE_DRAIN_LOCK_WAIT_MS = 2_000

/**
 * Say, on the pusher's own terminal, that this push's inbox result is still
 * waiting — and why.
 *
 * The hook's stderr is git's `remote:` channel, so this reaches the person who
 * pushed. Loud, because the alternative is the shape this whole change exists
 * to kill: a drain that quietly did nothing looks exactly like a drain that
 * cleanly did everything, and for 102 seconds on 2026-08-31 nobody could tell
 * which had happened.
 */
function reportDeferredDrain(log: ConditionalLogger, drained: Readonly<ReceiverDrainResult>): void {
  if (drained.deferred.length === 0) return
  const why =
    drained.lockBusy ??
    (drained.deadlineExceeded === true
      ? `this drain pass hit its ${String(RECEIVE_DRAIN_BUDGET_MS)}ms budget`
      : "the drain pass ended early")
  log.warn?.(
    `yrd: ${String(drained.deferred.length)} receiver inbox result(s) are still waiting after this push: ${why}. ` +
      "The push itself is accepted and the refs stand; the results are durable and the next drain takes them. " +
      "Run 'yrd queue audit' if they do not clear.",
    {
      action: "receiver-drain-deferred",
      deferred: drained.deferred,
      ...(drained.lockBusy === undefined ? {} : { lockBusy: drained.lockBusy }),
    },
  )
}

/**
 * Silvery `run()` options for the live, interactive watch UI (`yrd watch`,
 * `yrd queue ls --watch`, …).
 *
 * `mouse: true` is load-bearing, not cosmetic. The watch UI is a fullscreen
 * (alternate-screen) app whose primary surface is a scrollable `ListView`.
 * When mouse tracking is NOT enabled, terminals (Ghostty, xterm-family) fall
 * back to "alternate scroll": they translate the trackpad/mouse wheel into
 * cursor arrow-key sequences (ESC[A / ESC[B). Those arrows reach silvery as
 * ordinary keyboard input, and the ListView's built-in navigation consumes
 * them to move the selection cursor — so scrolling the trackpad moves the
 * highlighted row instead of scrolling the viewport. Enabling mouse tracking
 * (silvery emits CSI ?1003h / ?1006h) makes the terminal deliver the wheel as
 * SGR mouse reports, which the ListView scrolls the viewport with while
 * leaving the cursor put. Regression: @km/code/trackpad-wheel-not-scrolling.
 */
export const WATCH_LIVE_RENDER_OPTIONS = {
  mode: "fullscreen",
  mouse: true,
  // Mouse tracking intercepts terminal-native drag selection. Keep Silvery's
  // selection feature explicit and copy completed drags through OSC52.
  selection: true,
  copyOnSelect: true,
} as const

function defaultIO(): YrdCliIO {
  const color = process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined)
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  const stderrIsTTY = process.stderr.isTTY === true
  const io: YrdCliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    interactive,
    stderrIsTTY,
    clearStderrLine: () => {
      const positioned = cursorTo(process.stderr, 0)
      const cleared = clearLine(process.stderr, 0)
      return positioned && cleared
    },
    color,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: process.cwd(),
    ...(process.env.HAB_SERVICE_NAME?.trim() ? { healthServiceName: process.env.HAB_SERVICE_NAME.trim() } : {}),
    habitantLeaseHeld: (cwd) => habitantRunnerLeaseHeld(cwd),
  }
  if (!interactive) return io
  return withLiveRenderer(io, async (element, options) => {
    using handle = await run(element, { ...WATCH_LIVE_RENDER_OPTIONS, signal: options.signal })
    await handle.waitUntilExit()
  })
}

/** Process entrypoint shared by yrd and git-yrd. */
async function runYrdProcessHost(
  argv: readonly string[],
  io: YrdCliIO,
  terminateAfterCleanup: boolean,
  options: YrdProcessHostOptions,
): Promise<YrdCliExitCode> {
  if (options.strandedFilter) io.filterStrandedFindings = options.strandedFilter
  const env = process.env
  const invocation = resolveInvocation(argv)
  if (invocation.args[0] === "receiver-hook") {
    const json = yrdJsonOutputRequested(argv)
    const mode = invocation.args[1]
    if (mode !== "pre-receive" && mode !== "post-receive") {
      await diagnostic(
        io,
        createFailure({
          kind: "usage",
          code: "invalid-arguments",
          message: "yrd: receiver-hook requires pre-receive or post-receive",
        }),
        { json },
      )
      return 2
    }
    try {
      await runReceiverHook(mode, env, options.workspaceLifecycle)
      return 0
    } catch (error) {
      await diagnostic(io, error, { json })
      return classifyFailure(error).exitCode
    }
  }
  if (invocation.args[0] === "_checkpoint-migration-manifest") {
    const assemblyFlag = invocation.args.indexOf("--assembly-root")
    const assemblyRoot = assemblyFlag === -1 ? undefined : invocation.args[assemblyFlag + 1]
    const extra = invocation.args.filter(
      (argument, index) => index !== 0 && index !== assemblyFlag && index !== assemblyFlag + 1,
    )
    if (assemblyRoot === undefined || extra.length > 0) {
      await diagnostic(
        io,
        createFailure({
          kind: "usage",
          code: "invalid-arguments",
          message: "yrd: _checkpoint-migration-manifest requires exactly --assembly-root <path>",
        }),
        { json: false },
      )
      return 2
    }
    const scope = createScope("yrd-checkpoint-migration-manifest")
    await using runtimeProcess = createProcess({
      cwd: io.cwd ?? globalThis.process.cwd(),
      env,
      inject: { scope },
    })
    try {
      const candidate = await discoverYrdRepository({
        cwd: io.cwd ?? globalThis.process.cwd(),
        env,
        process: runtimeProcess,
      })
      const assembly = await discoverYrdRepository({ cwd: assemblyRoot, env, process: runtimeProcess })
      const loaded = await loadRepositoryConfig(candidate, runtimeProcess)
      const attestation = await createDefaultYrdCheckpointMigrationAttestation({
        repo: assembly.repo,
        stateDir: assembly.stateDir,
        baysRoot: assembly.baysRoot,
        receiverPath: join(assembly.stateDir, "prs.git"),
        process: runtimeProcess,
        config: loaded.config,
        defaultSubmitter: "operator",
        scope,
      })
      io.stdout(`${CHECKPOINT_MIGRATION_TRAILER}${JSON.stringify(attestation)}\n`)
      return 0
    } catch (error) {
      await diagnostic(io, error, { json: false })
      return classifyFailure(error).exitCode
    } finally {
      await scope[Symbol.asyncDispose]()
    }
  }

  const wantsRootHelp = invocation.args.length === 0
  if (
    wantsRootHelp ||
    invocation.args.some(
      (argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-V",
    )
  ) {
    return runYrdHelp(wantsRootHelp ? [...argv, "--help"] : argv, io)
  }

  let log: ConditionalLogger | undefined
  let host: YrdHost | undefined
  let oneShotRunner: string | undefined
  let shutdownLog: ConditionalLogger | undefined
  let drainRequested: ShutdownSignal | undefined
  let closePromise: Promise<void> | undefined
  const closeHost = (signal?: ShutdownSignal) => {
    const stopped = signal ?? drainRequested
    return (closePromise ??= closeDrainedQueuePass({
      // A drain reaches here with no `signal` argument: the first signal only
      // ASKED the pass to stop, and the pass then ran to its own end and fell
      // into the boundary's `finally`. Settling on that path too is the whole
      // fix — before it, the drain-free one-shot fired this close CONCURRENTLY
      // with the still-running pass, so the recovery raced the live job and the
      // process still died by the re-raised signal.
      ...(stopped === undefined ? {} : { stopped }),
      settle: async (interrupt) => {
        if (host === undefined || oneShotRunner === undefined || shutdownLog === undefined) return
        await settleOneShotQueueRun(host, oneShotRunner, interrupt, shutdownLog)
      },
      // Releases the queue runner lease last (`closeRuntime`), on every path
      // out including a settle that failed or timed out.
      close: async () => {
        await host?.close()
      },
    }))
  }
  let removeShutdownSignals: () => void = () => undefined
  let processExit: YrdCliExitCode | undefined
  try {
    const sourceAttestation = takeImplementationSourceAttestation(env)
    if (
      io.implementationSource !== undefined &&
      sourceAttestation !== undefined &&
      io.implementationSource !== sourceAttestation
    ) {
      throw new Error("yrd: process-host implementation source conflicts with launcher attestation")
    }
    const exitCode = await runYrdProcessRuntime(argv, io, {
      ambientCwd: io.cwd ?? globalThis.process.cwd(),
      env,
      ...(yrdQueueRunnerCheckRequested(argv)
        ? {
            async probe(context) {
              return {
                services: await runnerHealthProbeServices({
                  cwd: context.repo,
                  env,
                  ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
                }),
                io: { cwd: context.repo },
              }
            },
          }
        : {}),
      async load(context, posture) {
        // One seed for both queue-run postures, carrying which kind of pass it
        // is. The lease is taken for either; only `habitant-queue-run` goes on
        // to be a resident (heartbeat, follow loop, drain signal).
        const runner: QueueRunnerSeed | undefined =
          posture === "habitant-queue-run" || posture === "one-shot-queue-run"
            ? { ...habitantRunnerSeed(env), leaseMode: posture === "habitant-queue-run" ? "resident" : "once" }
            : undefined
        const habitantSeed = runner?.leaseMode === "resident" ? runner : undefined
        // The habitant follow-runner logs at DEBUG-by-default (see
        // habitantObservability) so run/step starts and successful completions
        // reach its concise human formatter; one-shot commands keep WARN.
        const observability =
          habitantSeed === undefined ? context.observability : habitantObservability(context.observability)
        // For the habitant, the stderr log stream renders as scannable
        // watch-timeline rows (JSON stays in the JSONL file sink); one-shot
        // commands keep the default console format.
        const habitantArtifacts: { root: string | undefined } = { root: undefined }
        const human =
          habitantSeed === undefined
            ? undefined
            : (event: Parameters<typeof formatHabitantLogLine>[0]) => {
                const artifactRoot = habitantArtifacts.root
                if (artifactRoot !== undefined) {
                  const home = habitantArtifactHome(event, artifactRoot)
                  if (home !== undefined) mkdirSync(home, { recursive: true })
                }
                return formatHabitantLogLine(event, {
                  color: io.color === true,
                  ...(artifactRoot === undefined ? {} : { artifactRoot }),
                  includeDebug: observability.explicitLevel || observability.debug !== undefined,
                })
              }
        log = createYrdLogger(observability, (text) => io.stderr(text), human)
        const runtimeLog = runner === undefined ? log : habitantRunnerLog(log, runner)
        const selectedImplementationSource = io.implementationSource ?? sourceAttestation
        const activeHost = await createYrdRuntimeHost(
          {
            cwd: context.repo,
            env,
            log: runtimeLog,
            ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
            ...(selectedImplementationSource === undefined
              ? {}
              : { implementationSource: selectedImplementationSource }),
            ...(posture === "journal-view-repair" ? { repairViewsBeforeReplay: true } : {}),
            ...(options.workspaceLifecycle === undefined ? {} : { workspaceLifecycle: options.workspaceLifecycle }),
            ...(options.defaultSubmitter === undefined ? {} : { defaultSubmitter: options.defaultSubmitter }),
            ...(options.authorizeSubmoduleModelChange === undefined
              ? {}
              : { authorizeSubmoduleModelChange: options.authorizeSubmoduleModelChange }),
            ...(options.testPathHolderCensus === undefined
              ? {}
              : { testPathHolderCensus: options.testPathHolderCensus }),
          },
          runner,
          posture === "viewer" ? "viewer" : "active",
        )
        const habitant = activeHost.habitant
        const resolveReadQueueTarget = createPostureQueueTargetResolver(posture, (ref, cwd) =>
          io.resolveQueueTarget === undefined
            ? resolveQueueTarget(activeHost.process, activeHost.repository.repo, activeHost.config.base, ref)
            : io.resolveQueueTarget(ref, cwd),
        )
        if (posture === "viewer") {
          await Promise.all(
            queueReadBases(activeHost.app.state(), activeHost.config.base).map((base) =>
              resolveReadQueueTarget(base, activeHost.repository.worktree),
            ),
          )
        }
        habitantArtifacts.root = join(activeHost.repository.stateDir, "artifacts")
        host = activeHost
        const runnerLog = runtimeLog.child("runner")
        oneShotRunner = posture === "one-shot-queue-run" ? runner?.id : undefined
        shutdownLog = runnerLog
        const drain = queuePostureDrains(posture) ? new AbortController() : undefined
        removeShutdownSignals = bindProcessShutdown(
          closeHost,
          drain === undefined
            ? undefined
            : (signal) => {
                drain.abort(signal)
                if (posture === "bracketed-bay-open") {
                  runtimeLog.warn?.(`Bay work was interrupted by ${signal}; preserving the Bay instead of closing it.`)
                  return
                }
                // Both queue postures drain the same way and say so the same
                // way. The one-shot needs it MORE than the resident, not less:
                // the resident is supervised and restarts, while a one-shot's
                // death is final and takes its unsettled run with it.
                drainRequested = signal
                reportGracefulShutdown(runnerLog, signal, activeHost.repository.repo)
              },
          drain === undefined
            ? undefined
            : {
                ms: QUEUE_DRAIN_BOUND_MS,
                onExpire: (signal) =>
                  runnerLog.error?.(`Drain did not finish within ${String(QUEUE_DRAIN_BOUND_MS)}ms; stopping now.`, {
                    action: "queue-drain-bound-expired",
                    signal,
                    boundMs: QUEUE_DRAIN_BOUND_MS,
                    repository: activeHost.repository.repo,
                  }),
              },
        )
        return {
          app: activeHost.app,
          services: activeHost.services,
          io: {
            cwd: activeHost.repository.worktree,
            repositoryRoot: activeHost.repository.repo,
            ...(options.repositoryLabel === undefined ? {} : { repositoryLabel: options.repositoryLabel }),
            artifactRoot: join(activeHost.repository.stateDir, "artifacts"),
            stateDir: activeHost.repository.stateDir,
            ...(runner === undefined ? {} : { runner: runner.id }),
            ...(habitant === undefined ? {} : { driver: { queueId: habitant.queueId, epoch: habitant.epoch } }),
            ...(runner === undefined || activeHost.implementationSource === undefined
              ? {}
              : { implementationSource: activeHost.implementationSource }),
            ...(habitant === undefined || activeHost.journalRetention === undefined
              ? {}
              : { journalRetentionPolicy: activeHost.journalRetention }),
            concurrency: io.concurrency ?? activeHost.config.contest.concurrency,
            resolveRevision: (ref, cwd) =>
              io.resolveRevision === undefined
                ? resolveSubmitCommit(activeHost.process, cwd, ref)
                : io.resolveRevision(ref, cwd),
            parents: (sha, cwd) =>
              io.parents === undefined ? readCommitParents(activeHost.process, cwd, sha) : io.parents(sha, cwd),
            resolveCommitMeta: (ref, cwd) =>
              io.resolveCommitMeta === undefined
                ? resolveCommitMeta(activeHost.process, cwd, ref)
                : io.resolveCommitMeta(ref, cwd),
            resolveQueueTarget: resolveReadQueueTarget,
            ...(drain === undefined ? {} : { drainSignal: drain.signal }),
          },
        }
      },
    })
    // A drained ONE-SHOT leaves its own code, never the 0 its work would have
    // returned: nobody supervises a one-shot, so its exit status is the only
    // thing the operator who sent the signal — or the script that ran it — ever
    // learns, and "0" there is indistinguishable from a pass that finished.
    //
    // Scoped to the one-shot on purpose. The RESIDENT's drained exit is already
    // specified as 0 and is load-bearing the other way: it runs under
    // `hab restart=on-failure`, so a clean drain must read as success or the
    // supervisor restarts the runner an operator just stopped (D3, asserted in
    // `queue-cancel.test.ts` and `host.test.ts`). Same event, opposite correct
    // codes, because one of the two has a supervisor and the other has a
    // terminal.
    const drainedOneShot = oneShotRunner === undefined ? undefined : drainRequested
    const stoppedExit = drainedQueuePassExit(exitCode, {
      ...(drainedOneShot === undefined ? {} : { drained: drainedOneShot }),
    })
    processExit = stoppedExit
    return stoppedExit
  } catch (error) {
    if (isYrdRuntimeReloadRequest(error)) {
      try {
        return await execYrdProcessInPlace({
          closeRuntime: closeHost,
          removeShutdownSignals,
          closeLog: () => log?.end(),
          execPath: globalThis.process.execPath,
          argv,
          // Same argv, same env — plus the consecutive-reload count, so the
          // replacement can tell a transition from a loop and refuse at the
          // bound instead of exec'ing forever.
          env: runtimeReloadEnv(env, error),
          execve: (execPath, execArgv, execEnv) => {
            const execve = globalThis.process.execve
            if (execve === undefined) throw new Error("this Bun runtime cannot reload a habitant with execve")
            return execve(execPath, [...execArgv], execEnv)
          },
        })
      } catch (reloadError) {
        await diagnostic(io, reloadError, { json: yrdJsonOutputRequested(argv) })
        processExit = classifyFailure(reloadError).exitCode
        return processExit
      }
    }
    await diagnostic(io, error, { json: yrdJsonOutputRequested(argv) })
    processExit = classifyFailure(error).exitCode
    return processExit
  } finally {
    try {
      await closeHost()
    } finally {
      removeShutdownSignals()
      // One command, one stage table. Emitted last so it covers the whole
      // invocation, and through the host-owned logger so `DEBUG=yrd:perf`
      // reaches it like any other namespace. `unaccountedMs` is the honest row:
      // a breakdown that silently omits most of the command reads as coverage,
      // which is how a multi-second stage stayed invisible behind a `totalMs`
      // that described 2% of the work.
      // Bun 1.3 can spin or fault while disposing an invocation's file-backed
      // logger. The executable boundary already owns termination; the writer's
      // process-exit hook flushes its buffer after host cleanup, preserving the
      // classified code instead of losing it to a hang or SIGILL.
      options.afterCommand?.()
      if (processExit !== undefined && terminateAfterCleanup) {
        await flushProcessOutput()
        globalThis.process.exit(processExit)
      }
      log?.child("perf").debug?.("command stage breakdown", stageReport())
      log?.end()
    }
  }
}

/** Drain both stdio streams before `process.exit`. On pipe-backed stdio the
 * runtime buffers writes asynchronously and `process.exit` drops whatever has
 * not reached the fd yet — which is how a command's LAST line (typically the
 * failure line) went missing or landed after later writers. A zero-length
 * write's callback fires only after everything queued before it has flushed,
 * so awaiting it is the barrier. */
async function flushProcessOutput(): Promise<void> {
  await Promise.all(
    [globalThis.process.stdout, globalThis.process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.write("", () => resolve())
        }),
    ),
  )
}

/** Process-host seam for embedded callers and focused tests. */
export function runYrdProcess(
  argv: readonly string[] = process.argv,
  io: YrdCliIO = defaultIO(),
  options: YrdProcessHostOptions = {},
): Promise<YrdCliExitCode> {
  return runYrdProcessHost(argv, io, false, options)
}

export const YRD_DEFAULT_SUBMITTER_ENV = "YRD_DEFAULT_SUBMITTER" as const

function helpOrVersionOnly(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every declared repository, read in turn, each answer labelled with the
 * repository it came from. A failure in one repository is reported and the
 * remaining repositories are still read: a composition-wide question that
 * stops at the first broken member answers about a subset without saying so. */
async function runEveryComposedRepository(
  argv: readonly string[],
  io: YrdCliIO,
  options: YrdProcessHostOptions,
  plan: Extract<YrdCompositionPlan, { kind: "all-repositories" }>,
): Promise<YrdCliExitCode> {
  let exitCode: YrdCliExitCode = 0
  for (const repository of plan.repositories) {
    io.stdout(`=== ${repository.name} (${repository.path}) ===\n`)
    try {
      const composed = composeYrdArgv(argv, ["--repo", repository.path, ...plan.args])
      // Each iteration reads ONE declared repository; its handle is that
      // repository's queue label (item 36), so the listing's rows lead with
      // `code  /repo@main` rather than the base-branch fallback.
      const targetExit = await runYrdProcessHost(composed, io, false, {
        ...options,
        repositoryLabel: repository.name,
      })
      if (targetExit !== 0) exitCode = targetExit
    } catch (error) {
      io.stderr(`yrd: repository ${repository.name} failed: ${errorDetail(error)}\n`)
      exitCode = 3
    }
  }
  return exitCode
}

/**
 * Only a habitant invocation (`queue run`) owns the settlement drain.
 *
 * Its worker starts BEFORE the runner does and lives beside it, ticking on
 * its own cycle until the runner exits. Every other command must return
 * spawning nothing at all: the habitant is already draining on its own
 * cycle, and a second worker there only contends with it for the writer
 * lock. Measured 2026-08-29 — @chief's census of the runner's own log, 46
 * minutes: 41 `writer lock is busy` warnings, a steady 0.9/min tax, 61% of
 * it (`25/41`) from one ordinary caller (`@adhoc/1`) alone, none of it the
 * runner itself.
 *
 * This is the ONLY gate {@link spawnYrdSettlementWorker} may be called
 * behind. A second, ungated call site is exactly the regression this
 * function exists to make impossible to reintroduce silently — see
 * settlement-drain-is-runner-owned.
 *
 * `plan.kind === "all-repositories"` can never carry a habitant command:
 * `queue run` always names one declared repository
 * (normalizeYrdRepositoryAliasInvocation routes it to `repository-write`,
 * never `all-repositories-read`), so a composed multi-repository read owns
 * no drain either — it spawns nothing, same as any other non-habitant call.
 */
export function habitantOwnsSettlementDrain(settlement: YrdSettlementLaunch | undefined): boolean {
  return settlement?.habitant === true
}

/**
 * Real executable boundary: fully close the host, then terminate even when a
 * file-backed logger would otherwise retain or fault Bun resources. Kept out of
 * the package index; only bin/yrd.ts owns process lifetime.
 *
 * This is also where an embedding host's composition is applied — named
 * repositories, and background settlement of the terminal facts a command
 * commits. Both are declared entirely in the environment, so a standalone Yrd
 * reaches the same `runYrdProcessHost` call it always did.
 *
 * There is deliberately NO source-freshness guard here, and adding one is not
 * an oversight to correct. A guard that lives inside the source it guards
 * cannot refuse a stale copy of itself: the stale tree runs its own stale
 * guard and passes. The sound replacement is receiver-side, at the journal
 * every source writes to — tracked upstream as @yrd/core/shim-source-guard.
 */
export async function runYrdExecutable(): Promise<never> {
  const io = defaultIO()
  const env = globalThis.process.env
  const argv = globalThis.process.argv
  const invocation = resolveInvocation(argv)

  if (invocation.args[0] === YRD_SETTLEMENT_COMMAND) {
    await runYrdSettlementWorker(env, { stderr: (text) => io.stderr(text) })
    await flushProcessOutput()
    globalThis.process.exit(0)
  }

  const submitter = env[YRD_DEFAULT_SUBMITTER_ENV]?.trim()
  const options: YrdProcessHostOptions =
    submitter === undefined || submitter === "" ? {} : { defaultSubmitter: submitter }

  let plan: YrdCompositionPlan | undefined
  let settlement: YrdSettlementLaunch | undefined
  try {
    const composition = takeYrdComposition(env)
    if (composition !== undefined) {
      if (helpOrVersionOnly(invocation.args) && invocation.args.includes("queue")) {
        io.stdout(yrdCompositionQueueHelp(invocation.name, composition))
      }
      plan = planYrdComposition(invocation.args, composition, { env })
    }
    const selected = plan?.kind === "repository" ? plan.repository : undefined
    // Help and version describe the command rather than run it, and they are
    // the one thing that must answer from anywhere — including outside any
    // repository, where settlement has no state directory to resolve.
    settlement = helpOrVersionOnly(invocation.args)
      ? undefined
      : prepareYrdSettlementLaunch({
          env,
          args: plan?.args ?? invocation.args,
          execPath: globalThis.process.execPath,
          scriptPath: argv[1] ?? import.meta.path,
          cwd: globalThis.process.cwd(),
          ...(selected === undefined ? {} : { operationRepository: selected.path, repositoryName: selected.name }),
          gitDir: (chosen) =>
            repositoryGitDir({
              env,
              cwd: globalThis.process.cwd(),
              ...(chosen === undefined ? {} : { selected: chosen }),
            }),
          stderr: globalThis.process.stderr,
          write: (text) => io.stderr(text),
        })
  } catch (error) {
    await diagnostic(io, error, { json: false })
    await flushProcessOutput()
    globalThis.process.exit(classifyFailure(error).exitCode)
  }

  settlement?.drainNotices()

  if (plan?.kind === "all-repositories") {
    // Never a habitant invocation (see habitantOwnsSettlementDrain) — this
    // composed, multi-repository read owns no drain and spawns nothing.
    const exitCode = await runEveryComposedRepository(argv, io, options, plan)
    await flushProcessOutput()
    globalThis.process.exit(exitCode)
  }

  // The habitant runner's worker starts BEFORE the runner does and lives
  // beside it; every other command owns no drain (habitantOwnsSettlementDrain)
  // and spawns nothing, neither before nor after — see that function's doc.
  const habitant = habitantOwnsSettlementDrain(settlement)
  if (habitant) settlement?.spawn(true)
  const exitCode = await runYrdProcessHost(plan === undefined ? argv : composeYrdArgv(argv, plan.args), io, true, {
    ...options,
    ...(plan?.kind === "repository" ? { repositoryLabel: plan.repository.name } : {}),
  })
  await flushProcessOutput()
  globalThis.process.exit(exitCode)
}
