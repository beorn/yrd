import type { HasBays } from "@yrd/bay"
import type { HasContests } from "@yrd/contest"
import type { AnyYrdApp, HasEffects } from "@yrd/core"
import type { HasLine } from "@yrd/line"
import type { HasTasks } from "@yrd/task"

export type YrdCliExitCode = 0 | 1 | 2 | 3

export type LineAuditFinding = Readonly<{
  code: string
  message: string
  run?: string
  submission?: string
}>

export type LineAuditResult = Readonly<{
  findings: readonly LineAuditFinding[]
}>

/** Optional operator capabilities supplied by a line-environment plugin. The
 * CLI never simulates these lifecycle operations when no plugin owns them. */
export type YrdCliLineAdministration = Readonly<{
  audit?(): Promise<LineAuditResult>
  provision?(base?: string): Promise<unknown>
  deprovision?(base?: string): Promise<unknown>
}>

export type YrdCliApp = AnyYrdApp & HasEffects & HasBays & HasLine & HasTasks & HasContests

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
  hyperlink?(label: string, target: string): string
  cwd?: string
  executor?: string
  leaseMs?: number
  concurrency?: number
  now?: () => number
  resolveRevision?(ref: string, cwd: string): Promise<string | undefined>
  signal?: AbortSignal
  sleep?(milliseconds: number, signal?: AbortSignal): Promise<void>
}
