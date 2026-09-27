/**
 * The queue's core: one store, which is the git repository.
 *
 * A branch is its ref at the queue's remote. Event queues have one queue chain
 * and one change chain per branch under `refs/yrd/<queue>/`; their status is a
 * fold over those events. A legacy queue ref is refused with its name.
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
  appendChangeEvent,
  changeInput,
  changesRef,
  createEventQueue,
  createLocalEventStore,
  decide,
  expireQueueOverrides,
  drop,
  evolve,
  enumerateChangeSegments,
  initial,
  listChangeHistories,
  listChanges,
  queueFormat,
  queueRef,
  queueResumedAfter,
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
  CancellationReason,
  ChangeEventType,
  ChangeStatus,
  EventChange,
  EventQueue,
  QueueLocation,
  LocalQueueReadStore,
  QueueReadStore,
  SetBranchIgnoredRequest,
  DropRequest,
  Dropped,
} from "./events.ts"
export { eventListRows, eventRows } from "./event-table.ts"
export { assertPlainEventQueueConfig } from "./event-config.ts"
export { DIRECT_MERGE, mergedBy, mergedByRun, trailer, trailers } from "./git.ts"
export { incidentLine, incidentLines, incidentTrailers } from "./incident.ts"
export type { Incident } from "./incident.ts"
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
export { queueRun, QueueAuthorityUnreadable } from "./run.ts"
export { QueueRunEventRetryExhausted } from "./event-run.ts"
export type { QueueRunOptions, QueueRunOutcome, RoundLine } from "./run.ts"
export { ENDINGS, hintsIn, parseTarget, queueName, readConfig, targetName } from "./config.ts"
export { parseDuration } from "./duration.ts"
export type { Ending, Notifier, QueueConfig, QueueHealthConfig, Target } from "./config.ts"
export { clocks, endingInstants, subjects, watchRows, watchRowKey } from "./table.ts"
export type { Clocks, NextOwner, Row, WatchRow, WatchRowOptions } from "./table.ts"
export { resolveRemote } from "./remote.ts"
export { DRAFT_EXCLUDED_PREFIXES, DRAFT_WINDOW_MS, readDrafts } from "./drafts.ts"
export type { Draft, DraftReading } from "./drafts.ts"
export { directMergeLine, eventDirectMergeCommits } from "./direct.ts"
export { refuseTarget, inspectSubmit, inspectSubmitAtHead, freshnessLine, submit, issueOf } from "./submit.ts"
export { pinCarrierName, preparePinCarrier } from "./pin-carrier.ts"
export type { PinCarrierPin, PreparedPinCarrier } from "./pin-carrier.ts"
export type { IssueResolution, IssueResolver } from "./submit.ts"
export { withdraw, NothingToWithdraw } from "./withdraw.ts"
export type { WithdrawRequest, Withdrawn, WithdrawnChange } from "./withdraw.ts"
export { QueuePaused, QueueNotPaused, liftLine, pauseLine, stopFact, stuckCures } from "./pause.ts"
export type { PauseCause, PauseRecord, PauseKind, StopFact } from "./pause.ts"
export {
  NO_OVERRIDES,
  OVERRIDE_MAX_HOURS,
  OverrideRefused,
  isActive as isOverrideActive,
  overrideFacts,
  overrideLine,
  parseUntil,
  stateAt as overrideStateAt,
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

export { transportFaultIn } from "./setup-transport.ts"
export type { TransportFault } from "./setup-transport.ts"

export { runtimeGitlinkPath } from "./runtime-gitlink.ts"
export type { RuntimeGitlinkDecision, RuntimeGitlinkOff, RuntimeGitlinkPath } from "./runtime-gitlink.ts"

export { programRootCheck } from "./program-root.ts"

export { readRemoteCalls, remoteCallsLine, traceRemoteCalls } from "./remote-calls.ts"
export type { RemoteCalls } from "./remote-calls.ts"
export {
  MIRROR_LOCK_WAIT_MS,
  MIRROR_REFRESHED_AT,
  invalidateMirrorStamp,
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

export {
  CANDIDATE_REF_NAMESPACE,
  SOURCE_CANDIDATE_REF_NAMESPACE,
  candidateRefFor,
  candidateRefsFor,
  deleteCandidateRefsForShas,
  isCandidateRef,
  sourceCandidateRefFor,
  sweepCandidateRefs,
} from "./candidate-refs.ts"
export type {
  CandidateRefDiscovered,
  CandidateRefSweepResult,
  DeleteCandidateRefResult,
  SweepCandidateRefsOptions,
} from "./candidate-refs.ts"

export { yrdQueueRunnerDeclarations } from "./runner-declarations.ts"
export type { YrdQueueRunnerDeclaration } from "./runner-declarations.ts"
