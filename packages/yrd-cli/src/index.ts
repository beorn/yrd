export { runYrdExecutable, runYrdProcess, resolveSubmitter } from "./cli.ts"
export { coreQueueCommand, type CoreQueueCommand } from "./queue-core-commands.ts"
export { listEnvironments, openEnvironment } from "./env-commands.ts"
export { parseEnvironmentList, type EnvRow, type EnvIssueBinding } from "./env-inventory.ts"
export type { EnvLifetime } from "./env-open-record.ts"
import {
  closeEnvironment as closeEnvironmentInternal,
  type EnvCloseOptions,
  type CloseExecutionContext,
} from "./env-commands.ts"
export type {
  CloseExecutionContext,
  CloseExecutionBudget,
  EnvironmentRemovalTarget,
  CloseAdmissionMode,
} from "./env-commands.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
// The package entry never forwards the internal test dependency, including from JavaScript callers.
export function closeEnvironment(
  operand: string,
  options: EnvCloseOptions,
  io: YrdCliIO,
  context?: CloseExecutionContext,
): Promise<YrdCliExitCode> {
  return closeEnvironmentInternal(
    operand,
    options,
    io,
    undefined,
    context?.onIncompleteCensus,
    undefined,
    undefined,
    context,
  )
}
export { YRD_VERSION, formatYrdRuntimeVersion } from "./version.ts"
export type { YrdCliExitCode, YrdCliIO } from "./types.ts"
export {
  ISSUES_CODES,
  ISSUES_VERB_NAMES,
  branchIssueId,
  runIssuesVerb,
  type IssuesEnvelope,
  type IssuesFailure,
  type IssuesOutcome,
  type IssuesVerb,
  type RunIssuesVerbOptions,
} from "./issues/index.ts"
export { ownedQueueClone, resolveQueueLocation, type QueueLocation } from "./queue-location.ts"

export { prepareAuthorRelease, type AuthorReleaseResult, type AuthorRelease } from "./branch-retirement.ts"
