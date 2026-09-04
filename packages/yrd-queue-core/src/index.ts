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

export { CHANGES, changeName, changeRef, parseChangeName, parseChangeRef, refOfChange } from "./refs.ts"
export type { Change } from "./refs.ts"
export { appendRecord, DIRECT_MERGE, mergedBy, mergedByRun, readRecord, readRecords, trailer, trailers } from "./records.ts"
export type { ChangeRecord, Git } from "./records.ts"
export { inLine, readChange } from "./state.ts"
export { configValue, gitIn, refAt } from "./git.ts"
export { checkLogPath, checkTrailer, readCheckTrailer, runCheck } from "./check.ts"
export type { CheckedTree, CheckResult } from "./check.ts"
export { runId } from "./log.ts"
export type { LogRecord } from "./log.ts"
export { checkedTree, claimWorktrees, prepareWorktree, runSetup, SetupFailed } from "./worktree.ts"
export { queueRun } from "./run.ts"
export type { QueueRunOptions, QueueRunOutcome } from "./run.ts"
export { ENDINGS, hintsIn, parseTarget, queueName, readConfig, targetName } from "./config.ts"
export type { Ending, Notifier, QueueConfig, Target } from "./config.ts"
export { list, show } from "./table.ts"
export type { Row } from "./table.ts"
export { readQueue, resolveRemote } from "./remote.ts"
export { directMergeCommits, directMergeLine } from "./direct.ts"
export { refuseTarget, submit, issueOf } from "./submit.ts"
export {
  FREEZE_REF,
  QueueFrozen,
  QueueNotFrozen,
  activeFreeze,
  freezeLine,
  readFreeze,
  requireUnfrozen,
  writeFreeze,
} from "./freeze.ts"
export type { FreezeRecord, FreezeKind, WriteFreeze } from "./freeze.ts"
