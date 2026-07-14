import type { BayCommands, BaysState, HasBays } from "@yrd/bay"
import type { ContestCommands, ContestsState, HasContests } from "@yrd/contest"
import type { Yrd } from "@yrd/core"
import type { HasJobs, JobCommands, JobsState } from "@yrd/job"
import type { HasQueue, QueueAuditResult, QueueCommands, QueuesState } from "@yrd/queue"
import type { HasIssues } from "@yrd/issue"
import type { Scope } from "@silvery/scope"

export type YrdCliExitCode = 0 | 1 | 2 | 3

export type { QueueAuditFinding, QueueAuditResult } from "@yrd/queue"

/** Optional operator capabilities supplied by a queue-environment plugin. The
 * CLI never simulates these lifecycle operations when no plugin owns them. */
export type YrdCliQueueAdministration = Readonly<{
  auditEnvironment?(): Promise<QueueAuditResult>
  provision?(base?: string): Promise<unknown>
  deprovision?(base?: string): Promise<unknown>
}>

export type YrdCliState = Readonly<{
  jobs: JobsState
  bays: BaysState
  queues: QueuesState
  contests: ContestsState
}>

export type YrdCliCommands = JobCommands & BayCommands & QueueCommands & ContestCommands

export type YrdCliApp = Yrd<YrdCliState, YrdCliCommands> & HasJobs & HasBays & HasQueue & HasIssues & HasContests

export type YrdCliServices = Readonly<{
  queue?: YrdCliQueueAdministration
}>

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
  /** Human output is rendered by Silvery. Tests and pipes omit color; the
   * process host supplies terminal capabilities. */
  color?: boolean
  columns?: number
  cwd?: string
  runner?: string
  leaseMs?: number
  concurrency?: number
  now?: () => number
  resolveRevision?(ref: string, cwd: string): Promise<string | undefined>
  resolveQueueTarget?(ref: string, cwd: string): Promise<Readonly<{ base: string; sha: string }>>
  currentBranch?(cwd: string): string | undefined
  scope?: Pick<Scope, "signal" | "sleep">
  drainSignal?: AbortSignal
}
