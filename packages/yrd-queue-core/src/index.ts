/**
 * The queue's core: one store, which is the git repository.
 *
 * A branch is its ref at the queue's remote; a change is the ref
 * `refs/yrd/changes/<branch>@<sha>`, whose commits are its records; a merge is
 * one `--no-ff` merge commit on the target, naming its change. Nothing else is
 * written and nothing is remembered: every state a reader sees is derived from
 * those refs and the target's ancestry at the moment they ask.
 *
 * This package is the replacement core of the [plan](../../../../pm/@i/10-yrd/plan.md)
 * § Milestones M4. It reuses the git wrapper, submodule materialization, the
 * check driver and the notifier unchanged, and the incumbent `queue.ts` is
 * untouched until the flag day at M5 retires it whole.
 *
 * **This file lists what is imported from outside the package, and nothing
 * else.** It carried 84 names for 41 that anybody imports — genesis constants,
 * worktree plumbing, the log writer, the shapes of arguments nobody names —
 * and every one of them read as a promise the package was not keeping. A name
 * a consumer needs is one line to add back; a name nobody needs is a surface
 * that has to keep working. `mergeBase` is deliberately NOT here: the two
 * modules that use it are inside this package and import `./git.ts`, which is
 * their path, not this one.
 */

export {
  changeName,
  changeRef,
  encodeQueueComponent,
  parseChangeName,
  parseChangeRef,
  pauseRef,
  queueRefPrefix,
  refOfChange,
} from "./refs.ts"
export type { Change } from "./refs.ts"
export {
  appendRecord,
  DIRECT_MERGE,
  mergedBy,
  mergedByRun,
  readRecord,
  readRecords,
  trailer,
  trailers,
} from "./records.ts"
export type { ChangeRecord, Git } from "./records.ts"
export { incidentFrom, incidentLine, incidentLines, incidentTrailers } from "./incident.ts"
export type { Incident } from "./incident.ts"
export { inLine, nextOwner, readChange, tipOf } from "./state.ts"
export type { NextOwner } from "./state.ts"
export { configValue, gitIn, refAt } from "./git.ts"
export { checkLogPath, checkTrailer, checksOf, readCheckTrailer, runCheck } from "./check.ts"
export type { CheckedNow, CheckedTree, CheckResult, CheckRun, CheckSpec, CheckView } from "./check.ts"
export { journalKey, readJournals, readRunLog, runId, runStartedAt } from "./log.ts"
export type { JournalCheck, JournalRun, Journals, LogRecord } from "./log.ts"
export { checkedTree, claimWorktrees, freshWorktree, prepareWorktree, runSetup, SetupFailed } from "./worktree.ts"
export { queueRun } from "./run.ts"
export type { QueueRunOptions, QueueRunOutcome } from "./run.ts"
export { ENDINGS, hintsIn, parseTarget, queueName, readConfig, targetName } from "./config.ts"
export type { Ending, Notifier, QueueConfig, Target } from "./config.ts"
export { clocks, list, show, subjects } from "./table.ts"
export type { Clocks, ListOptions, Row } from "./table.ts"
export { readHistories, readQueue, resolveRemote } from "./remote.ts"
export { directMergeCommits, directMergeLine } from "./direct.ts"
export { refuseTarget, submit, issueOf } from "./submit.ts"
export { QueuePaused, QueueNotPaused, activePause, pauseLine, readPause, requireResumed, writePause } from "./pause.ts"
export type { PauseRecord, PauseKind, WritePause } from "./pause.ts"
