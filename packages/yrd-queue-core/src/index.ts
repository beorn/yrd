/**
 * The queue's core: one store, which is the git repository.
 *
 * A branch is its ref at the queue's remote; a change is the ref
 * `refs/yrd/changes/<branch>@<sha>`, whose commits are its facts; a merge is
 * one `--no-ff` merge commit on the target, naming its change. Nothing else is
 * written and nothing is remembered: every state a reader sees is derived from
 * those refs and the target's ancestry at the moment they ask.
 *
 * This package is the replacement core of the [plan](../../../../pm/@i/10-yrd/plan.md)
 * § Milestones M4. It reuses the git wrapper, submodule materialization, the
 * check driver and the notifier unchanged, and the incumbent `queue.ts` is
 * untouched until the flag day at M5 retires it whole.
 */

export { CHANGES, changeName, changeRef, parseChangeName, parseChangeRef } from "./refs.ts"
export {
  FACT_KINDS,
  appendFact,
  endedKind,
  factFrom,
  factMessage,
  readFact,
  readFacts,
  trailer,
  trailers,
} from "./facts.ts"
export type { Fact, FactKind, Git, WriteFact } from "./facts.ts"
export { CHANGE_STATES, inLine, openedAt, readChange } from "./state.ts"
export type { ChangeFacts, ChangeReading, ChangeState } from "./state.ts"
export { GitExit, gitIn, gitlinkRows, isAncestor, refAt } from "./git.ts"
export { DEFAULT_CHECK_BOUND_MS, runCheck } from "./check.ts"
export type { CheckResult, CheckSpec, RunCheck } from "./check.ts"
export { LOG_KINDS, openLog } from "./log.ts"
export type { LogKind, LogRecord, QueueRunLog } from "./log.ts"
export { freshWorktree } from "./worktree.ts"
export type { Worktree } from "./worktree.ts"
export { queueRun } from "./run.ts"
export type { QueueCheck, QueueRunOptions, QueueRunOutcome } from "./run.ts"
export { hintsIn, readConfig, readHints } from "./config.ts"
export type { Hints, QueueConfig } from "./config.ts"
export { list, show } from "./table.ts"
export type { ListOptions, Row } from "./table.ts"
export { readQueue, remoteNames, resolveRemote } from "./remote.ts"
export type { QueueEntry, QueueRead } from "./remote.ts"
export { handMovedLine, outsideCommits } from "./outside.ts"
export type { OutsideCommit } from "./outside.ts"
export { submit, workItemOf } from "./submit.ts"
export type { SubmitRequest, Submitted } from "./submit.ts"
