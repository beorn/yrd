/**
 * The queue's core: one store, which is the git repository.
 *
 * A branch is its ref at the queue's remote. Event queues have one queue chain
 * and one change chain per branch under `refs/yrd/<queue>/`; their status is a
 * fold over those events. Unmigrated queues retain their legacy `Record:`
 * format until #25041 converts it. The queue-format selector chooses one.
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
  CHANGE_EVENT_TYPES,
  CHANGE_STATUSES,
  EVENT_TRAILERS,
  changeInput,
  changesRef,
  createEventQueue,
  decide,
  evolve,
  initial,
  listChanges,
  queueFormat,
  queueRef,
  readEventQueue,
  readStatus,
  writeQueueEvent,
} from "./events.ts"
export type {
  CancellationReason,
  ChangeEnding,
  ChangeEventType,
  ChangeStatus,
  EventChange,
  EventQueue,
  EventStore,
  WriteQueueEvent,
} from "./events.ts"
export { eventRows } from "./event-table.ts"
export {
  appendRecord,
  DIRECT_MERGE,
  endingRecord,
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
export { holdsPlaceInLine, inLine, nextOwner, readChange, tipOf } from "./state.ts"
export type { NextOwner } from "./state.ts"
export {
  configValue,
  gitIn,
  readRemoteCommit,
  refAt,
  resolveGitSelection,
  type GitSelection,
  type GitRunner,
  type GitObservation,
} from "./git.ts"
export { checkLogPath, checkTrailer, checksOf, readCheckTrailer, runCheck } from "./check.ts"
export type { CheckedNow, CheckedTree, CheckResult, CheckRun, CheckSpec, CheckView } from "./check.ts"
export {
  CHANGE_REF_DIAGNOSTICS,
  journalKey,
  openLog,
  readJournals,
  readRunLog,
  runDiedInPreamble,
  runId,
  runStartedAt,
} from "./log.ts"
export type { JournalCheck, JournalRun, Journals, LogRecord } from "./log.ts"
export {
  checkedTree,
  claimWorktrees,
  freshWorktree,
  prepareWorktree,
  registeredWorktrees,
  runSetup,
  SetupFailed,
  worktreeWithoutSubmodules,
} from "./worktree.ts"
export {
  GIT_SUPER_ABSENT_STORE,
  GitlinkNotOnRemote,
  populateReferenceStores,
  ReferenceUnpopulated,
} from "./reference.ts"
export type { PopulateReference, ReferenceStore } from "./reference.ts"
export { queueRun } from "./run.ts"
export type { QueueRunOptions, QueueRunOutcome } from "./run.ts"
export { ENDINGS, hintsIn, parseTarget, queueName, readConfig, targetName } from "./config.ts"
export type { Ending, Notifier, QueueConfig, Target } from "./config.ts"
export { clocks, endingInstants, list, show, subjects, watchRows, watchRowKey } from "./table.ts"
export type { Clocks, ListOptions, Row, WatchRow, WatchRowOptions } from "./table.ts"
export { readHistories, readQueue, readStop, resolveRemote } from "./remote.ts"
export { DRAFT_EXCLUDED_PREFIXES, DRAFT_WINDOW_MS, readDrafts } from "./drafts.ts"
export type { Draft, DraftReading } from "./drafts.ts"
export { directMergeCommits, directMergeLine } from "./direct.ts"
export { refuseTarget, inspectSubmit, freshnessLine, submit, issueOf } from "./submit.ts"
export type { IssueResolution } from "./submit.ts"
export { withdraw, NothingToWithdraw } from "./withdraw.ts"
export type { WithdrawRequest, Withdrawn, WithdrawnChange } from "./withdraw.ts"
export {
  QueuePaused,
  QueueNotPaused,
  liftLine,
  lineStop,
  pauseLine,
  readPause,
  stopFact,
  stuckCures,
  writePause,
} from "./pause.ts"
export type { PauseCause, PauseRecord, PauseKind, StopFact, WritePause } from "./pause.ts"
export { pauseStop, STOPPED_BY } from "./with-pause.ts"

export { remoteUrl } from "./remote.ts"

export {
  absentHealthDocument,
  believableHealthDocument,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  parseQueueHealthDocument,
  QUEUE_HEALTH_DOCUMENT,
  QUEUE_HEALTH_SCHEMA,
  queueHealthExitCode,
  relaunchStalledHealthDocument,
  ROUND_BUDGET_MS,
  ROUND_LOCK,
  roundHealthDocument,
  STUCK_RECORD_CODE,
  unreadableHealthDocument,
  writtenHealthDocument,
} from "./service-health.ts"
export type {
  HealthHeartbeat,
  HealthWriter,
  QueueHealthDocument,
  QueueHealthFailure,
  QueueHealthState,
  QueueHealthVerdict,
} from "./service-health.ts"

export {
  SETUP_UNREACHABLE_CODE,
  SETUP_UNUSABLE_CODE,
  setupStuckCode,
  setupStuckNext,
  transportFaultIn,
} from "./setup-transport.ts"
export type { TransportFault } from "./setup-transport.ts"

export { runtimeGitlinkPath } from "./runtime-gitlink.ts"
export type { RuntimeGitlinkDecision, RuntimeGitlinkOff, RuntimeGitlinkPath } from "./runtime-gitlink.ts"

export { programRootCheck } from "./program-root.ts"
