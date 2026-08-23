import type { BayCommands, BaysState, HasBays, HasDeployments } from "@yrd/bay"
import type { ContestCommands, ContestsState, HasContests } from "@yrd/contest"
import type { Yrd } from "@yrd/core"
import type { HasJobs, HasRunner, JobCommands, JobsState } from "@yrd/job"
import type {
  MergeRecordEstateRepair,
  GitChangeRemerger,
  HasQueue,
  QueueAuditEmission,
  QueueCommands,
  QueuesState,
  RepositoryMergeRecordSearchResult,
  ComponentModelChangeAuthorizer,
} from "@yrd/queue"
import type { HasIssues } from "@yrd/issue"
import type {
  JournalVersionBumpResult,
  JournalViewRebuildResult,
  OrphanJournalImportResult,
  ResolvedRetention,
} from "@yrd/persistence"
import type { Process, ProcessResult } from "@yrd/process"
import type { Scope } from "@silvery/scope"
import type { QueueReadModel } from "./queue-read-model.ts"
import type { SubmoduleBranchResolver } from "./submodule-tracking.ts"
import type { RetainedWorkspace } from "./workspace-retention.ts"
import type { YrdConfig } from "@yrd/config"

export type YrdCliExitCode = 0 | 1 | 2 | 3

export type JournalRetentionPolicy = ResolvedRetention

export type JournalRetentionObservation = Readonly<{
  policy: JournalRetentionPolicy
  source: "mutable-journal"
  observedAt: string
  /** Resident driver epoch that produced this observation. */
  generation: string
}>

export type { QueueAuditEmission, QueueAuditFinding, QueueAuditResult } from "@yrd/queue"

/** Opaque host-owned reason a Bay must not be destroyed. The host resolves its
 * own consumers; Yrd only matches the Bay identity/path and reports evidence. */
export type YrdBayProtection = Readonly<{
  bay: string
  path: string
  source: string
  evidence: string
}>

/** Optional operator capabilities supplied by a queue-environment plugin. The
 * CLI never simulates these lifecycle operations when no plugin owns them. */
/** What an environment audit actually COMPARED.
 *
 * A zero-finding audit is a result only when it can say how many declarations
 * it read and against what; without a denominator, "nothing drifted" and
 * "nothing was there to check" are the same sentence. */
export type QueueEnvironmentAuditComparison = Readonly<{
  /** Resolved path of the installed-baseline authority file. */
  baselinePath: string
  /** Installed baselines compared — the denominator. */
  baselines: number
  /** The bases compared, named. */
  bases: readonly string[]
  /** Which live side each baseline was compared against. `runtime` is absent
   * when no live queue runtime is wired to compare with. */
  against: readonly ("configured" | "runtime")[]
}>

export type QueueEnvironmentAuditEmission = QueueAuditEmission &
  Readonly<{ comparison: QueueEnvironmentAuditComparison }>

export type YrdCliQueueAdministration = Readonly<{
  /** A PRODUCER: findings are built here, so the closed emission type applies —
   * a plugin cannot invent a code no consumer whitelists. Readers of the
   * concatenated audit keep the open {@link QueueAuditResult}. Refuses rather
   * than returning an empty comparison when the installed baseline is absent. */
  auditEnvironment?(): Promise<QueueEnvironmentAuditEmission>
  provision?(base?: string): Promise<unknown>
  deprovision?(base?: string): Promise<unknown>
}>

export type YrdCliJournalAdministration = Readonly<{
  importOrphan(sourcePath: string): Promise<OrphanJournalImportResult>
  rebuildViews?(): Promise<JournalViewRebuildResult>
  bump?(version: number): Promise<JournalVersionBumpResult>
}>

export type YrdCliCheckResult = ProcessResult & Readonly<{ retainedWorkspace?: RetainedWorkspace }>

export type YrdCliChecks = Readonly<{
  names: readonly string[]
  run(
    name: string,
    cwd: string,
    context?: Readonly<{ ref?: string; keepOnFailure?: boolean }>,
  ): Promise<YrdCliCheckResult>
  install(cwd: string): Promise<string>
}>

/**
 * What one pre-submit guard did. `skipped` is a first-class outcome, not a
 * quiet pass: it carries the reason so a seat can tell "this guard looked and
 * found nothing to judge" from "this guard never ran".
 */
export type YrdCliGuardOutcome = Readonly<{
  name: string
  status: "passed" | "skipped"
  candidateSha: string
  reason?: string
  stdout?: string
}>

export type YrdCliGuards = Readonly<{
  names: readonly string[]
  /**
   * `cwd` is the working tree holding the candidate — the invoking tree, or a
   * Bay's own worktree when submit selected one. It is where `HEAD` is resolved
   * and where the guard command runs; `ref`, when given, names the candidate
   * explicitly and is resolved in the repository instead.
   */
  run(name: string, context?: Readonly<{ cwd?: string; ref?: string }>): Promise<YrdCliGuardOutcome>
}>

export type YrdCliState = Readonly<{
  jobs: JobsState
  bays: BaysState
  queues: QueuesState
  contests: ContestsState
}>

export type YrdCliCommands = JobCommands & BayCommands & QueueCommands & ContestCommands

export type YrdCliApp = Yrd<YrdCliState, YrdCliCommands> &
  HasJobs &
  HasRunner &
  HasBays &
  Partial<HasDeployments> &
  HasQueue &
  HasIssues &
  HasContests

export type YrdCliServices = Readonly<{
  queue?: YrdCliQueueAdministration
  queueReadModel?: QueueReadModel
  recut?: GitChangeRemerger
  mergeRecords?: Readonly<{
    find(selector: string): Promise<RepositoryMergeRecordSearchResult>
    /** Every verified merge record on the configured base, for bulk index reconstruction. */
    all(): Promise<RepositoryMergeRecordSearchResult>
    /**
     * Enumerate every record the estate cannot prove and, with `apply`, append a
     * retraction beside each. `now` is passed in rather than read from a clock so
     * the caller owns the timestamp and the result stays reproducible.
     */
    retractUnprovable(options: Readonly<{ apply: boolean; now: string }>): Promise<MergeRecordEstateRepair>
  }>
  journal?: YrdCliJournalAdministration
  checks?: YrdCliChecks
  guards?: YrdCliGuards
  process?: Pick<Process, "run" | "reapPath">
  /** Resolve the live workspace path when a durable Bay record predates a repository move. */
  resolveBayWorkspacePath?(bay: string, recordedPath?: string): string | undefined
  /** Live base-authority flow config for deterministic doctor diagnostics. */
  config?: YrdConfig
  /** Configured base branch. */
  base?: string
  /** Exact host environment inherited by Bay child processes. */
  environment?: NodeJS.ProcessEnv
  componentModelChangeAuthorizer?: ComponentModelChangeAuthorizer
}>

/** Read-only Git facts `pr prune` proves its superseded verdicts with. The
 * default implementation shells out to Git plumbing in the invocation
 * repository; tests inject deterministic facts through YrdCliIO.pruneGit. */
/**
 * Git facts the branch-state verbs (`draft`/`submit`/`archive`/`ignore`)
 * need; defaults to real Git plumbing in `cwd`. Deliberately three
 * capabilities and no more — this surface selects branches and pushes refs,
 * and every RULE about which pushes are legal belongs to the receiver.
 */
export type ChangeStateGitFacts = Readonly<{
  /** Local branch names — `git for-each-ref --format=%(refname:short) refs/heads`. */
  branches(): readonly string[] | Promise<readonly string[]>
  /** The remote's value for one ref, or undefined when it is not set there. */
  remoteRef(ref: string): string | undefined | Promise<string | undefined>
  /**
   * Run one `git <args>` push. A rejected push is a RESULT, not a throw: its
   * `output` carries the receiver's own refusal, which the caller prints
   * unaltered.
   */
  push(
    args: readonly string[],
  ): Readonly<{ ok: boolean; output: string }> | Promise<Readonly<{ ok: boolean; output: string }>>
}>

export type PruneGitFacts = Readonly<{
  /** Full commit SHA for a ref or SHA, or undefined when it is not a commit here. */
  resolveCommit(ref: string): string | undefined | Promise<string | undefined>
  isAncestor(ancestor: string, descendant: string): boolean | Promise<boolean>
  /** Tree OID of a conflict-free merge of base and head, or undefined when the merge conflicts. */
  mergeTree(baseSha: string, headSha: string): string | undefined | Promise<string | undefined>
  treeOf(sha: string): string | Promise<string>
  /** Selected source-base distance from the pinned authoritative target. The
   * source-only side must be zero before recut can be classified safely. */
  pinDistance?(
    sourceBaseSha: string,
    targetBaseSha: string,
  ):
    | Readonly<{ sourceOnly: number; targetOnly: number }>
    | Promise<Readonly<{ sourceOnly: number; targetOnly: number }>>
  /** Parent SHAs of one commit, in order. The recut preflight gate counts
   * them to enforce the linear-root rule at the first evaluation. */
  parents?(sha: string): readonly string[] | Promise<readonly string[]>
  /** Stable patch identity and an equivalent target-side commit when one can
   * be attributed. Patch identity is evidence only; exact tree proof remains
   * the authority for a subsumed verdict. */
  patchMatch?(
    sourceBaseSha: string,
    headSha: string,
    targetBaseSha: string,
  ): Readonly<{ patchId?: string; targetSha?: string }> | Promise<Readonly<{ patchId?: string; targetSha?: string }>>
  /** Which of the given commits are present here AND already reachable from the
   * base tip — one batched answer for a whole listing. `pr list` reconciles
   * every row whose recorded state claims its content never landed, so the
   * naive one-process-per-row shape would cost seconds on a full projection.
   * A commit missing from this repository is never reported as landed: absence
   * of the object is not evidence about the content. Implementations that omit
   * this fact are still answered exactly, one `resolveCommit` + `isAncestor`
   * pair per head. */
  mergedOnBase?(baseSha: string, heads: readonly string[]): readonly string[] | Promise<readonly string[]>
}>

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
  /** Whether stdin/stdout are the invoking foreground terminal. */
  interactive?: boolean
  /** Whether stderr is an interactive terminal suitable for human-only output. */
  stderrIsTTY?: boolean
  /** Clear the current stderr terminal row without exposing terminal escapes to the CLI. */
  clearStderrLine?(): boolean
  /** Human output is rendered by Silvery. Tests and pipes omit color; the
   * process host supplies terminal capabilities. */
  color?: boolean
  columns?: number
  rows?: number
  cwd?: string
  /** Composition-owned Hab service identity for a queue runner health probe. */
  healthServiceName?: string
  /** Host-resolved primary repository whose shared Journal this command projects. */
  repositoryRoot?: string
  /** Composition-declared handle for that repository (`code`, `pm`) — the
   * queue label run names lead with (watch redesign item 36). */
  repositoryLabel?: string
  /** Probe whether a resident runner holds the drain lease in `cwd`. When it
   * reports true, `pr recut --queue` dispatches admission enqueue-only for the
   * resident to settle instead of becoming a second driver. */
  residentLeaseHeld?(cwd: string): Promise<boolean>
  /** Process-host-owned step artifact root used by the live read-only output projection. */
  artifactRoot?: string
  /** Host-owned durable state directory for artifacts and runtime coordination. */
  stateDir?: string
  /** Fresh host-owned Bay destroy protections for this invocation. */
  bayProtections?: readonly YrdBayProtection[]
  runner?: string
  /** Host-minted driver lease identity for a resident queue epoch. */
  driver?: Readonly<{ queueId: string; epoch: string }>
  /** Host-owned implementation identity captured before a resident starts serving. */
  implementationSource?: string
  /** Exact policy resolved by the mutable journal this resident serves. */
  journalRetentionPolicy?: JournalRetentionPolicy
  /**
   * The Yrd source checkout {@link implementationSource} was captured from —
   * the only repository that sha may be compared against. Absent means "resolve
   * it from the running module", which is what the host does; naming it keeps
   * the sha and the repository it came from a matched pair rather than two
   * independent derivations that can drift apart.
   */
  sourceCheckout?: string
  leaseMs?: number
  concurrency?: number
  now?: () => number
  resolveRevision?(ref: string, cwd: string): Promise<string | undefined>
  /** Parent SHAs of one commit in the invocation repository — the linear-root
   * gate's evidence at entrances that hold a sha rather than a branch
   * (`pr ready`, active-Bay submit). */
  parents?(sha: string, cwd: string): Promise<readonly string[]>
  resolveQueueTarget?(ref: string, cwd: string): Promise<Readonly<{ base: string; sha: string }>>
  /** Head commit subject + body used to default a submitted PR's title/description. */
  resolveCommitMeta?(ref: string, cwd: string): Promise<Readonly<{ subject: string; body?: string }> | undefined>
  currentBranch?(cwd: string): string | undefined
  /** Git facts for `pr prune` and `pr recut --preflight`; defaults to real Git
   * plumbing in `cwd`. */
  pruneGit?(cwd: string): PruneGitFacts
  /** Git facts for the branch-state verbs; defaults to real Git plumbing in `cwd`. */
  changeStateGit?(cwd: string): ChangeStateGitFacts
  /** Resolve a submodule's upstream default branch for `yrd admin submodule
   * init`; defaults to `git ls-remote --symref`. Tests inject a resolver to
   * avoid the network. */
  resolveSubmoduleDefaultBranch?: SubmoduleBranchResolver
  scope?: Pick<Scope, "signal" | "sleep">
  drainSignal?: AbortSignal
  /**
   * Host-evaluated uncarried exemptions, applied AFTER the sweep.
   * Not `SweepOptions.retiredRefs` — that socket prints "retired" and cannot
   * carry a held-to-date ruling (@i/10-merge-queue/23150).
   */
  filterUncarriedFindings?: <T extends { ref: string }>(
    findings: readonly T[],
  ) => { findings: readonly T[]; exemptionLines?: readonly string[] }
}
