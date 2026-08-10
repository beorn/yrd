import type { BayCommands, BaysState, HasBays, HasDeployments } from "@yrd/bay"
import type { ContestCommands, ContestsState, HasContests } from "@yrd/contest"
import type { Yrd } from "@yrd/core"
import type { HasJobs, HasRunner, JobCommands, JobsState } from "@yrd/job"
import type { GitPRRecutter, HasQueue, QueueAuditResult, QueueCommands, QueuesState } from "@yrd/queue"
import type { HasIntents, IntentCommands, IntentsState } from "@yrd/intent"
import type { HasIssues } from "@yrd/issue"
import type { JournalVersionBumpResult, JournalViewRebuildResult, OrphanJournalImportResult } from "@yrd/persistence"
import type { Process, ProcessResult } from "@yrd/process"
import type { Scope } from "@silvery/scope"
import type { QueueReadModel } from "./queue-read-model.ts"
import type { SubmoduleBranchResolver } from "./submodule-tracking.ts"
import type { RetainedWorkspace } from "./workspace-retention.ts"
import type { YrdConfig } from "@yrd/config"

export type YrdCliExitCode = 0 | 1 | 2 | 3

export type { QueueAuditFinding, QueueAuditResult } from "@yrd/queue"

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
export type YrdCliQueueAdministration = Readonly<{
  auditEnvironment?(): Promise<QueueAuditResult>
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

export type YrdCliState = Readonly<{
  jobs: JobsState
  bays: BaysState
  queues: QueuesState
  contests: ContestsState
  intents: IntentsState
}>

export type YrdCliCommands = JobCommands & BayCommands & QueueCommands & ContestCommands & IntentCommands

export type YrdCliApp = Yrd<YrdCliState, YrdCliCommands> &
  HasJobs &
  HasRunner &
  HasBays &
  Partial<HasDeployments> &
  HasQueue &
  HasIssues &
  HasContests &
  HasIntents

export type YrdCliServices = Readonly<{
  queue?: YrdCliQueueAdministration
  queueReadModel?: QueueReadModel
  recut?: GitPRRecutter
  journal?: YrdCliJournalAdministration
  checks?: YrdCliChecks
  process?: Pick<Process, "run" | "reapPath">
  /** Live base-authority flow config for deterministic doctor diagnostics. */
  config?: YrdConfig
  /** Configured base branch. */
  base?: string
  /** Exact host environment inherited by Bay child processes. */
  environment?: NodeJS.ProcessEnv
}>

/** Read-only Git facts `pr prune` proves its superseded verdicts with. The
 * default implementation shells out to Git plumbing in the invocation
 * repository; tests inject deterministic facts through YrdCliIO.pruneGit. */
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
  landedOnBase?(baseSha: string, heads: readonly string[]): readonly string[] | Promise<readonly string[]>
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
  /** Host-owned implementation identity captured before a resident starts serving. */
  implementationSource?: string
  leaseMs?: number
  concurrency?: number
  now?: () => number
  resolveRevision?(ref: string, cwd: string): Promise<string | undefined>
  resolveQueueTarget?(ref: string, cwd: string): Promise<Readonly<{ base: string; sha: string }>>
  /** Head commit subject + body used to default a submitted PR's title/description. */
  resolveCommitMeta?(ref: string, cwd: string): Promise<Readonly<{ subject: string; body?: string }> | undefined>
  currentBranch?(cwd: string): string | undefined
  /** Git facts for `pr prune` and `pr recut --preflight`; defaults to real Git
   * plumbing in `cwd`. */
  pruneGit?(cwd: string): PruneGitFacts
  /** Resolve a submodule's upstream default branch for `yrd admin submodule
   * init`; defaults to `git ls-remote --symref`. Tests inject a resolver to
   * avoid the network. */
  resolveSubmoduleDefaultBranch?: SubmoduleBranchResolver
  scope?: Pick<Scope, "signal" | "sleep">
  drainSignal?: AbortSignal
}
