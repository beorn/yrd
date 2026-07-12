import type { BayCommands, BaysState, HasBays } from "@yrd/bay"
import type { ContestCommands, ContestsState, HasContests } from "@yrd/contest"
import type { Yrd } from "@yrd/core"
import type { HasJobs, JobCommands, JobsState } from "@yrd/job"
import type { HasLine, LineAuditResult, LineCommands, LinesState } from "@yrd/line"
import type { HasTasks } from "@yrd/task"
import type { Scope } from "@silvery/scope"

export type YrdCliExitCode = 0 | 1 | 2 | 3

export type { LineAuditFinding, LineAuditResult } from "@yrd/line"

/** Optional operator capabilities supplied by a line-environment plugin. The
 * CLI never simulates these lifecycle operations when no plugin owns them. */
export type YrdCliLineAdministration = Readonly<{
  auditEnvironment?(): Promise<LineAuditResult>
  provision?(base?: string): Promise<unknown>
  deprovision?(base?: string): Promise<unknown>
}>

export type YrdCliState = Readonly<{
  jobs: JobsState
  bays: BaysState
  lines: LinesState
  contests: ContestsState
}>

export type YrdCliCommands = JobCommands & BayCommands & LineCommands & ContestCommands

export type YrdCliApp = Yrd<YrdCliState, YrdCliCommands> & HasJobs & HasBays & HasLine & HasTasks & HasContests

export type YrdCliServices = Readonly<{
  line?: YrdCliLineAdministration
}>

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
  /** Human output is rendered by Silvery. Tests and pipes omit color; the
   * process host supplies terminal capabilities. */
  color?: boolean
  columns?: number
  cwd?: string
  executor?: string
  leaseMs?: number
  concurrency?: number
  now?: () => number
  resolveRevision?(ref: string, cwd: string): Promise<string | undefined>
  resolveLineTarget?(ref: string, cwd: string): Promise<Readonly<{ base: string; sha: string }>>
  scope?: Pick<Scope, "signal" | "sleep">
}
