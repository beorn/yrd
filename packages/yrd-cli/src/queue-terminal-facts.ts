import type { FailureBreakdownClass } from "./status-presentation.ts"

export type QueueTerminalOutcome =
  | "integrated"
  | "rejected"
  | "environment-refused"
  | "stale"
  | "lost"
  | "legacy"
  | "refused"
  | "canceled"

export type QueueTerminalFact = Readonly<{
  run: string
  terminalAtMs: number
  outcome: QueueTerminalOutcome
  failureClass: FailureBreakdownClass | null
  activeMs: number | null
  queueWaitMs: readonly number[]
  members: readonly QueueTerminalMemberFact[]
}>

export type QueueTerminalMemberFact = Readonly<{
  pr: string
  revision: number
  totalMs: number | null
  totalApproximate: boolean
  codingMs: number | null
  jobRunMs: number | null
  retries: number
}>
