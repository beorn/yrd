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
  overrideRef,
  pauseRef,
  queueRefPrefix,
  refOfChange,
} from "./refs.ts"
export type { Change } from "./refs.ts"
export {
  CHANGE_EVENT_TYPES,
  CHANGE_STATUSES,
  EVENT_TRAILERS,
  adoptedChange,
  adoptedInput,
  appendOpsCutover,
  changeInput,
  changesRef,
  createEventQueue,
  decide,
  expireQueueOverrides,
  drop,
  eventPause,
  evolve,
  enumerateChangeSegments,
  initial,
  listChangeHistories,
  listChanges,
  queueFormat,
  queueRef,
  readChangeEvents,
  readEventQueue,
  readEventOps,
  readEventQueueWithChanges,
  readStatus,
  resetQueueFormatCache,
  setBranchIgnored,
  writeQueueEvent,
  writeQueueOverride,
} from "./events.ts"
export type { Event } from "./git.ts"
export type {
  AdoptedInputDetails,
  CancellationReason,
  ChangeEventType,
  ChangeStatus,
  EventChange,
  EventQueue,
  OpsCutoverReceipt,
  QueueLocation,
  SetBranchIgnoredRequest,
  DropRequest,
  Dropped,
} from "./events.ts"
export { eventListRows, eventRows } from "./event-table.ts"
export { assertPlainEventQueueConfig } from "./event-config.ts"
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
} from "./legacy-records.ts"
export type { ChangeRecord } from "./legacy-records.ts"
export { incidentFrom, incidentLine, incidentLines, incidentTrailers } from "./incident.ts"
export type { Incident } from "./incident.ts"
export { holdsPlaceInLine, inLine, nextOwner, readChange, tipOf } from "./state.ts"
export type { NextOwner } from "./state.ts"
export {
  configValue,
  createEventStore,
  executableFor,
  selectionFor,
  gitIn,
  listRefs,
  readRemoteCommit,
  refAt,
  resolveGitSelection,
  type GitSelection,
  type GitRunner,
  type GitObservation,
  type Git,
} from "./git.ts"
export { checkLogPath, checkTrailer, checksOf, readCheckTrailer, runCheck, skippedChecks } from "./check.ts"
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
export type { JournalCheck, JournalCommand, JournalRun, JournalStep, Journals, LogRecord } from "./log.ts"
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
export { queueRun, QueueAuthorityUnreadable, QUEUE_RUN_FAILED_EXIT } from "./run.ts"
export type { QueueRunOptions, QueueRunOutcome, RoundLine } from "./run.ts"
export { ENDINGS, hintsIn, parseTarget, queueName, readConfig, targetName } from "./config.ts"
export { parseDuration } from "./duration.ts"
export type { Ending, Notifier, QueueConfig, QueueHealthConfig, Target } from "./config.ts"
export { clocks, endingInstants, list, show, subjects, watchRows, watchRowKey } from "./table.ts"
export type { Clocks, ListOptions, Row, WatchRow, WatchRowOptions } from "./table.ts"
export { readHistories, readQueue, readStop, resolveRemote } from "./remote.ts"
export { DRAFT_EXCLUDED_PREFIXES, DRAFT_ROW_MS, DRAFT_WINDOW_MS, foldDrafts, readDrafts } from "./drafts.ts"
export type { Draft, DraftReading } from "./drafts.ts"
export { directMergeCommits, directMergeLine, eventDirectMergeCommits } from "./direct.ts"
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
export {
  NO_OVERRIDES,
  OVERRIDE_MAX_HOURS,
  OverrideRefused,
  expireOverrides,
  isActive as isOverrideActive,
  overrideFacts,
  overrideLine,
  parseUntil,
  readOverrides,
  stateAt as overrideStateAt,
  writeOverride,
} from "./override.ts"
export type {
  OverrideActor,
  OverrideEntry,
  OverrideFact,
  OverrideState,
  OverrideTable,
  OverrideWrite,
} from "./override.ts"
export { notifyOutsideRound, overrideNotice } from "./with-notify.ts"
export type { OutsideRound, OverrideNotice } from "./with-notify.ts"
export { inspectLegacyAdoption, adoptLegacy } from "./migration.ts"
export type { LegacyAdoptionPlan, LegacyAdoptionRow, LegacyAdoptionReceipt } from "./migration.ts"

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
  gracefulStopHealthDocument,
  relaunchStalledHealthDocument,
  ROUND_BUDGET_MS,
  ROUND_LOCK,
  DEFAULT_STALL_AFTER_MS,
  lineStall,
  roundHealthDocument,
  serviceStoppedLine,
  STALL_AFTER_FLOOR_MS,
  STALLED_LINE_CODE,
  STUCK_RECORD_CODE,
  unreadableHealthDocument,
  withLineFlow,
  writtenHealthDocument,
} from "./service-health.ts"
export type {
  FlowReading,
  HealthHeartbeat,
  HealthWriter,
  LineFlow,
  LineStall,
  QueueHealthDocument,
  QueueHealthFailure,
  QueueHealthState,
  QueueHealthVerdict,
  ServiceIntentFact,
  StallThreshold,
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

export { readRemoteCalls, remoteCallsLine, traceRemoteCalls } from "./remote-calls.ts"
export type { RemoteCalls } from "./remote-calls.ts"
export {
  MIRROR_LOCK_WAIT_MS,
  MIRROR_REFRESHED_AT,
  mirrorLocation,
  mirrorRefreshedAt,
  MirrorUnavailable,
  refreshDeclaredMirrors,
  refreshMirror,
} from "./mirror.ts"
export type {
  MirrorLocation,
  MirrorRefresh,
  MirrorSkip,
  RefreshDeclaredOptions,
  RefreshMirrorOptions,
} from "./mirror.ts"
