import type { BayCommands, BaysState, HasBays } from "@yrd/bay"
import type { ContestCommands, ContestsState, HasContests } from "@yrd/contest"
import type { Yrd } from "@yrd/core"
import type { HasJobs, HasRunner, JobCommands, JobsState } from "@yrd/job"
import type { GitPRRecutter, HasQueue, QueueAuditResult, QueueCommands, QueuesState } from "@yrd/queue"
import type { HasIssues } from "@yrd/issue"
import type { OrphanJournalImportResult } from "@yrd/persistence"
import type { Scope } from "@silvery/scope"
import type { SubmoduleBranchResolver } from "./submodule-tracking.ts"
import type { YrdConfig } from "@yrd/config"

export type YrdCliExitCode = 0 | 1 | 2 | 3

export type { QueueAuditFinding, QueueAuditResult } from "@yrd/queue"

/** Optional operator capabilities supplied by a queue-environment plugin. The
 * CLI never simulates these lifecycle operations when no plugin owns them. */
export type YrdCliQueueAdministration = Readonly<{
  auditEnvironment?(): Promise<QueueAuditResult>
  provision?(base?: string): Promise<unknown>
  deprovision?(base?: string): Promise<unknown>
}>

export type YrdCliJournalAdministration = Readonly<{
  importOrphan(sourcePath: string): Promise<OrphanJournalImportResult>
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
  HasQueue &
  HasIssues &
  HasContests

export type YrdCliServices = Readonly<{
  queue?: YrdCliQueueAdministration
  recut?: GitPRRecutter
  journal?: YrdCliJournalAdministration
  /** Live base-authority flow config for deterministic doctor diagnostics. */
  config?: YrdConfig
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
}>

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
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
  /** Process-host-owned step artifact root used by the live read-only output projection. */
  artifactRoot?: string
  runner?: string
  leaseMs?: number
  concurrency?: number
  now?: () => number
  resolveRevision?(ref: string, cwd: string): Promise<string | undefined>
  resolveQueueTarget?(ref: string, cwd: string): Promise<Readonly<{ base: string; sha: string }>>
  /** Head commit subject + body used to default a submitted PR's title/description. */
  resolveCommitMeta?(ref: string, cwd: string): Promise<Readonly<{ subject: string; body?: string }> | undefined>
  currentBranch?(cwd: string): string | undefined
  /** Git facts for `pr prune`; defaults to real Git plumbing in `cwd`. */
  pruneGit?(cwd: string): PruneGitFacts
  /** Resolve a submodule's upstream default branch for `yrd init`; defaults to
   * `git ls-remote --symref`. Tests inject a resolver to avoid the network. */
  resolveSubmoduleDefaultBranch?: SubmoduleBranchResolver
  scope?: Pick<Scope, "signal" | "sleep">
  drainSignal?: AbortSignal
}
