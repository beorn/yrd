import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import {
  baseIdentity,
  currentChangeRev,
  formatChangeRevisionSelector,
  isNonCheckableChangeState,
  isChangeRevisionSelector,
  parseChangeSelector,
  changeDeliveryState,
  changeProps,
  changeHead,
  changeNeedsAuthor,
  changeRevisionLineage,
  changeRevisionNumber,
  changeSourceReadyAt,
  type BaysState,
  type ChangeProps,
  type Change,
  type ChangeDeliveryState,
  type ChangeRevClock,
  type ChangeRevTerminal,
} from "@yrd/bay"
import { compareNatural, stageAsync, type Event, type JsonValue } from "@yrd/core"
import { JobRequestSchema, JobTransitionSchema, type Job, type JobError } from "@yrd/job"
import { derivedLaneBranches } from "@yrd/queue"
import type {
  Candidate,
  InstalledStep,
  IntegrationProof,
  ChangeCheckRecord,
  ChangeEligibility,
  QueueAuditFinding,
  QueueMemberKind,
  Run,
  QueueStep,
  QueueSummary,
} from "@yrd/queue"
import {
  ACTIVITY_PULSE_COLORS,
  AG_PULSE_INTERVAL_MS,
  attemptArtifacts,
  boundedQueue,
  BRANCH_ICON_COLOR,
  byRunStarted,
  CANCELED_CODES,
  type ChangeActivityEntry,
  type ChangeCheckViewRecord,
  changeIdValue,
  type ChangeListWindow,
  changeRevisionClocks,
  type ChangeRevisionHistoryClock,
  type ChangeRunRevisionClock,
  CHECK_REQUEST_ECHO_TOLERANCE_MS,
  checkDiagnosticText,
  collapseRecomposedSources,
  descriptionWithoutDuplicatedIssue,
  type DurationDistribution,
  elapsedMs,
  eligibilityForCurrentRevision,
  evidenceDisplay,
  explicitArtifactHref,
  failedAttemptsByRun,
  failureFact,
  fitTimelineLabel,
  FLOW_DAY_MS,
  formatQueueChangeId,
  GateCertificateSchema,
  type GateEvidence,
  gateEvidenceFromOutput,
  gateEvidenceLabel,
  GENERIC_REJECTION_CODES,
  type HabitantInstalledPlan,
  integrationProofDetail,
  isObjectValue,
  isolationPartLabel,
  issueHref,
  jobCheckpoint,
  jobStatus,
  lastFailedSubmission,
  latest,
  latestCandidateForCurrentRevision,
  latestChangeRun,
  latestRunForCurrentRevision,
  mediaDuration,
  type MergeVerdict,
  mergeVerdictOfOutcome,
  NO_ATTEMPTS,
  NO_HOVER_SELECT,
  parsedTimelineTimestamp,
  parseRunIdSuffix,
  preciseDuration,
  presentFact,
  projectedChangeStatus,
  propsField,
  QUEUE_HEALTH_GLYPH,
  QUEUE_ROW_LIMIT,
  QUEUE_STATS_MIN_PANE_ROWS,
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  type QueueAttempt,
  queueAttemptsByRun,
  queueDisplayState,
  type QueueDriverEpoch,
  type QueueFlowMetrics,
  type QueueHeadBlockDetails,
  type QueueHealthMarker,
  queueIntegration,
  type QueueLogAttempt,
  type QueueLogCoverage,
  queueLogLevel,
  type QueueLogLocation,
  type QueueLogLocationEntry,
  type QueueLogResult,
  queueLogSubmissionTime,
  queueMemberKind,
  queueMerge,
  queueMergeLabel,
  queueOutcomeIntegration,
  queuePauseAllowedText,
  queuePauseHealth,
  queueRetryPeers,
  queueRetryPeersOf,
  queueRevisionKey,
  type QueueRunnerAbsence,
  QueueRunnerProgress,
  type QueueRunnerRefusal,
  type QueueRunPresentationKind,
  queueRunRevisionKey,
  queueRunsByKey,
  queueRunSteps,
  queueShowRetries,
  type QueueStatusResult,
  queueTimelineAdmissionTimes,
  queueTimelineFilterBuckets,
  type QueueTimelineGroup,
  type QueueTimelineQueue,
  type QueueTimelineRepeat,
  type QueueTimelineRevisionLineage,
  type QueueTimelineRow,
  type QueueTimelineStatusBucket,
  type QueueTimelineStatusFilter,
  type QueueWaitDistribution,
  RECENT_ROW_LIMIT,
  relativeAge,
  relevantStep,
  requiredQueuePosition,
  retrySuffix,
  revisionCheckRequests,
  revisionSubmitter,
  runIdValue,
  RUNNER_VIEW_STALE_MS,
  runnerBoxTimer,
  runnerClock,
  runnerMergeTimer,
  type RunnerSourcePin,
  runOutputQueueageIndex,
  runRevisionClock,
  safeText,
  singleQueue,
  STALE_CODES,
  stepCheckpointText,
  stepCommand,
  stepDetail,
  stepError,
  stepErrorCode,
  stepEvidence,
  stepLost,
  stepNamesOfRun,
  stepOutput,
  TIMELINE_CONTENT_CAP,
  TIMELINE_STATE_CAP,
  TIMELINE_STATUS_ORDER,
  TIMELINE_WHY_CAP,
  timelineAge,
  type TimelineCellLayout,
  timelineLocalCalendarDay,
  timelineMemberSubject,
  timelineQueueWaits,
  timelineRevisionLineage,
  type TimelineRunCellModel,
  timelineRunCellText,
  timelineShowQueueLabel,
  type TimelineStatusCell,
  type TimelineStepCell,
  timestamp,
  toIso,
  uncarriedLine,
  type UncarriedObservation,
  uncarriedRailColor,
  withTimelineLineage,
} from "@yrd/queue"
import {
  Box,
  formatNounId,
  Link,
  ListView,
  MarkdownView,
  NounId,
  Pulse,
  Tab,
  TabList,
  Table,
  Tabs,
  Text,
  TogglePill,
  TogglePillGroup,
  type ListViewHandle,
  type TableColumn,
  type TextProps,
  useWindowSize,
} from "silvery"
import { queueAdmissionPositions } from "./queue-admission-index.ts"
import {
  formatQueueRunAddress,
  friendlyRepositoryPath,
  QUEUE_BRANCH_GLYPH,
  queueFullName,
  queuePrettyName,
  queueRunLabel,
  shortUniqueQueuePaths,
} from "./queue-naming.ts"
import {
  artifactHref as locationHref,
  artifactLabel,
  artifactLocation as artifactPath,
  directArtifacts,
  nestedArtifacts,
} from "./artifact-reference.ts"
import { formatLocalClock, TIMELINE_BRANCH_ICON, timelineStatusGlyph } from "./runner-timeline.ts"
import {
  formatDuration,
  ChangeStatusView,
  statusVariant,
  StatusValue,
  TaskStatusGlyph,
  TaskStatusValue,
} from "./status-view.tsx"
import {
  failureBreakdownClass,
  failureDisposition,
  failureStatusClass,
  statusPresentation,
  statusPresentationState,
  type FailureDisposition,
  type StatusPresentationColor,
  type StatusPresentationState,
} from "./status-presentation.ts"
import {
  actionableFailure,
  actionableFailureSummary,
  errorCodeLabel,
  type ActionableFailure,
  type FailureLike,
} from "./actionable-error.ts"
import { failureSlug } from "./failure-slug.ts"
import {
  checkTaskStatusOf,
  jobAttemptTaskStatusOf,
  changeTaskStatusOf,
  runTaskStatusOf,
  stepTaskStatusOf,
  taskStatusFields,
  taskStatusGlyph,
  type StatusGlyph,
  type TaskStatus,
  type TaskStatusFields,
} from "./task-status.ts"
import { QueueStatsPanel } from "./time-stats-box.tsx"
import { finiteNonnegative, numericDistribution } from "./numeric-distribution.ts"
import {
  type QueueTerminalFact,
  type QueueTerminalMemberFact,
  type QueueTerminalOutcome,
} from "./queue-terminal-facts.ts"
import { boundedHangingLines, MarkerRow, TitledBox } from "./queue-view-primitives.tsx"
import type { JournalRetentionObservation } from "./types.ts"

export type { QueueTerminalFact, QueueTerminalMemberFact, QueueTerminalOutcome } from "./queue-terminal-facts.ts"
export { TitledBox, timelineMetric } from "./queue-view-primitives.tsx"
// Moved to @yrd/queue (5a: one derivation per fact); re-exported so existing
// `./queue-status-view.tsx` consumers keep one import site.
export {
  type ChangeCheckViewRecord,
  type ChangeListWindow,
  changeRevisionClocks,
  type ChangeRevisionHistoryClock,
  type ChangeRunRevisionClock,
  collapseRecomposedSources,
  type DurationDistribution,
  formatQueueChangeId,
  type HabitantInstalledPlan,
  latestRunForCurrentRevision,
  type MergeVerdict,
  mergeVerdictOfOutcome,
  projectedChangeStatus,
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  type QueueAttempt,
  queueDisplayState,
  type QueueDisplayState,
  type QueueDriverEpoch,
  type QueueFlowMetrics,
  type QueueHealthKind,
  type QueueHealthMarker,
  type QueueLogAttempt,
  queueLogAttempts,
  type QueueLogCoverage,
  queueMergeLabel,
  queuePauseWarnings,
  queueRevisionKey,
  type QueueRunnerAbsence,
  QueueRunnerProgress,
  type QueueRunnerRefusal,
  type QueueRunPresentationKind,
  queueRunRevisionClocks,
  queueRunRevisionKey,
  type QueueStatusResult,
  queueTimelineAdmissionTimes,
  queueTimelineFilterBuckets,
  type QueueTimelineGroup,
  type QueueTimelineQueue,
  type QueueTimelineRepeat,
  type QueueTimelineRevisionLineage,
  type QueueTimelineRow,
  type QueueTimelineStatusBucket,
  type QueueTimelineStatusFilter,
  type QueueWaitDistribution,
  RUNNER_STALE_MS,
  RUNNER_VIEW_STALE_MS,
  type RunnerSourcePin,
  runRevisionClock,
  stepNamesOfRun,
  type UncarriedBuckets,
  uncarriedCoverageFloor,
  uncarriedDenominator,
  uncarriedFloorCount,
  uncarriedLine,
  type UncarriedObservation,
  uncarriedObservation,
  uncarriedRailColor,
} from "@yrd/queue"

type QueueNounIdProps = Omit<React.ComponentProps<typeof NounId>, "noun" | "value" | "revision">

/**
 * The JSX half of the identity render. `noun="pr"` is an assertion about KIND,
 * so it is spent only on an id the schema claims — otherwise a pin-advance
 * record printed `pr#yrdpin#357` here exactly as it did in the text path
 * (@i/10-merge-queue/22924-pr-prefix-on-non-pr). Both halves ask the same
 * exported question, so they cannot disagree about what a record is.
 */
function QueueChangeId({
  pr,
  revision,
  times,
  ...props
}: { pr: string; revision: number | string; times?: number } & QueueNounIdProps) {
  const suffix = retrySuffix(times)
  const number = typeof revision === "number" ? revision : Number(revision)
  return (
    <>
      {isChangeRevisionSelector(pr) ? (
        <NounId noun="pr" value={changeIdValue(pr)} revision={revision} {...props} />
      ) : (
        <Text {...props}>{formatChangeRevisionSelector(pr, number)}</Text>
      )}
      {suffix === "" ? null : <Text {...props}>{suffix}</Text>}
    </>
  )
}

function RunId({ base, run, ...props }: { base: string; run: string } & QueueNounIdProps) {
  return <NounId noun={base} value={runIdValue(run)} {...props} />
}
// `draft`, `rev`, and `ready` are display-only statuses for the
// non-integrated PRs that are not (yet) run members — a registered-but-unsubmitted
// PR (bay status `pushed`; `rev` when it carries failed-submission history)
// and a submitted PR awaiting its run. They never enter queue mechanics
// (composition, admission, terminal facts, FLOW stats) — see
// `timelineNonIntegratedRows`. (`pending` is retained as the shared pre-run
// group/filter/bucket name; `ready` is the status it now renders.)
export type QueueTimelineStatus = "draft" | "rev" | "ready" | "pending" | "running" | QueueTerminalOutcome

/**
 * One physical, selectable queue row. The list deliberately denormalizes one
 * exact PR revision (RunMember) per row: a batched Run repeats its Run facts
 * (`run`, `status`, `step`, `totalMs`) on one row per member while `pr`,
 * `revision`, `branch`, `subject`, `ageMs`, and `queueWaitMs` are member
 * facts. `id` is the composite cursor identity (`runId + prId + revision` for
 * Run rows, `prId + revision` for pending rows) that live reshuffles preserve.
 */
export type QueueTimelineProjectedRow = Readonly<{
  /** Typeable `path@branch#N` run address; present when the projection knows
   * its repository root and this row has a run (items 34/36). */
  address?: string
  id: string
  base: string
  /**
   * This row's queue label (1..N) when the projection spans MORE than one
   * queue, absent when it spans one. The presence of the field is what turns
   * the compact `1:main#2173` run reference on, so a single-queue projection
   * renders byte-identically to a projection that never knew about labels.
   */
  queueLabel?: number
  group: QueueTimelineGroup
  status: QueueTimelineStatus
  glyph: string
  timestamp: string | null
  timestampMs: number | null
  /** Immutable attempted integration. Present on every Run row, absent only for a pending PR revision. */
  candidateId?: string
  run?: string
  pr: string
  /** What kind of record `pr` names, decided ONCE from the schemas the mints
   * write through. Renderers read this instead of re-parsing the id, which is
   * how a pin-advance record came to print as `pr#yrdpin#357`
   * (@i/10-merge-queue/22924-pr-prefix-on-non-pr). `undefined` means neither
   * schema claimed it — a renderer must not then assume `pr`. */
  kind?: QueueMemberKind
  /** A live submit-fact row (derived lane, pre-admission): the branch has been
   * submitted in git but no retained run has admitted this exact sha, so there
   * is NO minted change identity yet — `pr` holds the BRANCH and `revision`
   * holds the impossible value 0. Renderers must branch on this flag instead
   * of formatting `pr`/`revision` as a change id; the deliberately-invalid 0
   * makes any renderer that forgets show a visibly wrong `.0`, never a
   * plausible one (NO SILENT ERRORS). */
  factOnly?: true
  revision: number
  headSha: string
  branch: string
  /** Canonical issue path for this change revision; presentation may replace the branch with this stronger identity. */
  issue?: string
  subject: string
  /** The identity that submitted this exact PR revision; absent only for older journals. */
  submitter?: string
  step?: string
  detail: string
  /** The blocking eligibility reason's human message on a pre-run row. The
   * detail above folds it into presentation text (with lineage decoration);
   * this is the raw message the renderer shows, so the WHY a change is not
   * running reaches the timeline instead of being computed and discarded. */
  whyMessage?: string
  position?: number
  sourceReadyAt?: string
  revisionLineage: readonly QueueTimelineRevisionLineage[]
  failure?: Readonly<{ code: string; message: string }>
  ageMs: number | null
  totalMs: number | null
  activeMs: number | null
  waitMs: number | null
  queueWaitMs: number | null
  /** Diagnostic merge class for display/JSON (21801) — not a success verdict. */
  mergeVerdict?: MergeVerdict
  /** Step names in run order — scripts must not infer merge from glyph alone. */
  stepNames?: readonly string[]
}>

export type QueueTimelineDisplayRow = QueueTimelineProjectedRow & Readonly<{ repeat?: QueueTimelineRepeat }>

/** The `path@branch#N` script-stable address for one run (items 34/36),
 * derivable only when the projection knows its repository root. */
function timelineRunAddress(repositoryRoot: string | undefined, base: string, run: string): string | undefined {
  if (repositoryRoot === undefined) return undefined
  return formatQueueRunAddress({ path: repositoryRoot, base }, runIdValue(run))
}

/** Select the rows the one-shot view draws. Live rows — draft/rev/ready, the
 * current state of open PRs — take priority over history within the display
 * cap, no matter how old their clock anchor is; history fills only the budget
 * live rows leave. The cap itself still binds (the print path must stay
 * bounded), so when live rows alone exceed it the newest `shown` live rows win
 * and the residue line discloses the rest. Display order is preserved. (Live
 * specimen 2026-08-07: two days-old drafts sorted below the cap and vanished
 * from the human timeline while `--json` carried them.) */
export function timelineRetainedRows(
  displayRows: readonly QueueTimelineDisplayRow[],
  shown: number,
): QueueTimelineDisplayRow[] {
  if (displayRows.length <= shown) return [...displayRows]
  const live = (row: QueueTimelineDisplayRow): boolean =>
    row.status === "draft" || row.status === "rev" || row.status === "ready"
  const liveCount = displayRows.reduce((count, row) => (live(row) ? count + 1 : count), 0)
  let liveBudget = Math.min(shown, liveCount)
  let historyBudget = shown - liveBudget
  return displayRows.filter((row) => {
    if (live(row)) {
      if (liveBudget > 0) {
        liveBudget -= 1
        return true
      }
      return false
    }
    if (historyBudget > 0) {
      historyBudget -= 1
      return true
    }
    return false
  })
}

export type QueueTimelineRunner = Readonly<{
  pid: number
  startedAt: string
  lastTickAt: string
  /** Queue-outcome progress captured by the habitant from the canonical audit.
   * Absent only for status records written before progress-aware heartbeats. */
  queueProgress?: QueueRunnerProgress
  /** The habitant runner's launch command; absent for status records written before it was captured. */
  command?: string
  /** Exact Yrd source captured by the habitant heartbeat at startup. */
  implementationSource?: string
  /** Compiled-in journal versions this habitant can read. */
  journalVersions?: readonly number[]
  /** Exact writer policy observed from the mutable journal this habitant serves. */
  retention?: JournalRetentionObservation
  /** Content of the driver lease. Probes assert this, never a process/service suffix. */
  driver?: QueueDriverEpoch
  /**
   * Last uncarried sweep, carried as a MEASUREMENT rather than a number.
   *
   * The sweep costs seconds, so it runs on its own cadence and cannot be
   * recomputed per render. That makes the count a stored belief, and a stored
   * belief rendered as if it were current is the shape that cost this fleet
   * most: a value derived in truth, authored in practice, with nothing
   * asserting the two agree. `observedAt` is what keeps it honest — the rail
   * renders "N uncarried, as of 4m ago" and a dead runner reads "as of 3h ago"
   * instead of a confident zero.
   *
   * Absent means NOT MEASURED, which must never render as 0. A queue with no
   * stranded refs and a queue nobody has swept are different facts.
   */
  uncarried?: UncarriedObservation
  /** ISO time the habitant wrote its exit marker on shutdown. The status file is
   * NEVER deleted on close — it is left with this marker so a successor can still
   * reclaim this pid's leases (idempotently). Absent while the runner is live. */
  exitedAt?: string
  /** With `exitedAt`: true = clean operator/drain stop, false = signal-forced or
   * crash exit. Absent while the runner is live. */
  clean?: boolean
  /**
   * How the habitant's booted `implementationSource` relates to the queue
   * repository's RECORDED Yrd pin, computed at observation time (never per
   * render — see `runnerPinBehind` in run.ts). The base is the pin and only
   * the pin (@i/10-merge-queue/23041-staleness-measures-the-observer): a
   * figure derived from any checkout's HEAD tracks whoever is looking.
   *
   * Absent means UNPINNED (the queue records no Yrd submodule, or the source
   * is not a plain git sha) and renders as silence. A pin that exists but
   * could not be read or related arrives as `state: "unknown"` with its
   * reason, and must render loudly — never as silence, never as a number.
   */
  sourcePin?: RunnerSourcePin
  /**
   * `draft-stranded` findings (@yrd/queue `auditQueues`) old enough to page —
   * projected by the habitant from the canonical audit exactly like
   * {@link QueueRunnerProgress}, so the probe never re-derives draft state
   * itself (the fast, journal-free health path cannot afford to). Age-gated by
   * `.yrd.yml` `drafts.pageAfterHours` at the point this is computed, so
   * presence here already means "page-worthy" — a shorter-lived draft is a
   * real `queue audit` finding but is deliberately absent here, or every
   * ordinary push-review-submit pause would page.
   *
   * Absent means NOT MEASURED (a status record written before this field
   * existed) or measured-and-empty; both render as "no stale drafts" today,
   * matching every other habitant-observed fact on this type.
   */
  staleDrafts?: readonly QueueAuditFinding[]
  /**
   * `admission-refusal-needs-person` findings (@yrd/queue `auditQueues`) —
   * changes whose admission refusal settled `needs-person` and stopped
   * being retried, so the one finding that used to mark them
   * (`admission-refusal-loop`) went silent the instant they most needed a
   * human (@i/10-merge-queue/22918-needs-person-unowned). Projected by the
   * habitant from the canonical audit exactly like {@link staleDrafts},
   * immediately — no age threshold, since a settlement already only happens
   * after the queue exhausted its own retries or mechanical remedy. Each
   * finding names its `owner` — the repository's `.yrd.yml`
   * `needsPerson.owner` role, or the explicit unowned default — so the probe
   * routes without re-deriving anything.
   *
   * Absent means NOT MEASURED (a status record written before this field
   * existed) or measured-and-empty; both render as "nothing needs a person"
   * today, matching every other habitant-observed fact on this type.
   */
  needsPerson?: readonly QueueAuditFinding[]
  /**
   * The step plan this resident built at startup — batch size and the full
   * installed descriptors (name, revision, kind, classification, order) — so
   * the supervisor probe can compare the RESIDENT's plan against the plan the
   * base tip declares without building a runtime of its own (23192 leg c).
   * Static for the life of the pid: a resident that must change it reloads.
   *
   * Absent means NOT PUBLISHED (a status record written by a resident older
   * than this field), and the probe says so rather than comparing nothing.
   */
  installedPlan?: HabitantInstalledPlan
}>

export type QueueTimelineProjection = Readonly<{
  now: string
  base: string
  /**
   * Every queue with rows in this projection, primary base first, then the
   * rest by name. A single-queue repository has exactly one entry and no
   * surface changes; watch shows them all at once and lets the operator toggle
   * one off by its label (user directive 2026-08-13, superseding queue tabs).
   */
  queues: readonly QueueTimelineQueue[]
  siblingBases: readonly string[]
  /** Habitant-runner heartbeat status; null renders loudly — nothing drains this queue. */
  runner: QueueTimelineRunner | null
  /** Why `runner` is null. Present only when it is; the banner needs it to name a remedy. */
  runnerAbsence?: QueueRunnerAbsence
  pause?: QueueSummary["pause"]
  oldestOpenMs: number | null
  filters: Readonly<{
    windowMs: number
    since: string
    statuses: readonly QueueTimelineStatusFilter[]
    terms: readonly string[]
    latest: boolean
  }>
  coverage: Readonly<{
    requestedSince: string
    retainedSince?: string
    complete: boolean
  }>
  display: Readonly<{ limit: number; shown: number; hidden: number }>
  rows: readonly QueueTimelineProjectedRow[]
  details: readonly QueueShowData[]
  metrics: QueueFlowMetrics
  /** Every retained completed-Run terminal fact, for the calendar STATS panel. */
  timeStatsFacts: readonly QueueTerminalFact[]
  /** Oldest timestamped journal record (ms), or null when none — drives the "-" coverage gate. */
  earliestFactMs: number | null
}>

export type QueueTimelineProjectionOptions = Readonly<{
  now: number
  windowMs: number
  /**
   * Window for the flow-metrics aggregate. Defaults to `windowMs` when omitted,
   * so a caller can widen the metrics horizon (e.g. 24h) while the listing rows
   * stay on the tighter `windowMs`. Never narrows the display set.
   */
  metricsWindowMs?: number
  statuses: readonly QueueTimelineStatusFilter[]
  terms: readonly string[]
  latest: boolean
  rowLimit: number
  submissionTimes: ReadonlyMap<string, string | null>
  attempts?: readonly QueueAttempt[]
  retainedSinceMs?: number
  siblingBases?: readonly string[]
  base?: string
  state?: BaysState
  runner?: QueueTimelineRunner | null
  runnerAbsence?: QueueRunnerAbsence
  /** Repository root the projected journal belongs to — the `path` half of
   * every queue's FQN identity pair (items 32a/36). One journal per repo, so
   * one path covers every queue this projection labels. */
  repositoryRoot?: string
  /** Config-handle labels by base (`main` → `code`). Today only a composition
   * host declares one, for its configured base; per-queue config labels ride
   * the 37i machinery. */
  queueNames?: ReadonlyMap<string, string>
}>

export type QueueLogRow = Readonly<{
  run: string
  base: string
  pr: string
  branch: string
  subject: string
  taskStatus: TaskStatus
  revision: string
  headSha: string
  baseSha: string
  outcome: string
  startedAt: string
  finishedAt?: string
  submittedAt?: string
  started: string
  finished: string
  age: string
  ageMs?: number
  duration: string
  durationMs?: number
  totalDuration: string
  totalDurationMs?: number
  activeDuration: string
  activeDurationMs?: number
  waitDuration: string
  waitDurationMs?: number
  attempts: readonly (QueueLogAttempt & TaskStatusFields)[]
  activeSteps: readonly Readonly<{ step: string; duration: string; durationMs: number }>[]
  retries: string
  parent: string
  isolationPart: "0" | "1" | "-"
  result: string
  error: string
  location?: QueueLogLocation
  locations: readonly QueueLogLocationEntry[]
  integration?: IntegrationProof
  props?: ChangeProps
  merge: string
}>

type Row = Readonly<{
  pr: string
  changeHref?: string
  state: string
  target: string
  age: string
  touched: string
  run: string
  step: string
  result: string
  log?: string
  artifactCount: number
  artifact?: string
  path?: string
}>

export type HumanFailureProjection = ActionableFailure &
  Readonly<{
    summary: string
    evidence?: Readonly<{ text: string; href?: string }>
  }>

export type HumanChangeProjection = Row &
  Readonly<{
    revision: number
    branch: string
    subject: string
    nativeStatus: ChangeDeliveryState
    taskStatus: TaskStatus
    candidateId?: string
    runId?: string
    submittedAt?: string
    sourceReadyAt?: string
    revisionLineage: readonly number[]
    touchedAt?: string
    failure?: HumanFailureProjection
  }>

export type HumanQueueProjection = Readonly<{
  target: string
  open: number
  activeCount: number
  integrated: number
  alreadyMerged: number
  rejected: number
  needsAuthor: number
  pause?: QueueSummary["pause"]
  active?: WatchActiveRow
  oldestOpen: string
  queue: readonly (HumanChangeProjection & Readonly<{ position: number }>)[]
  queueOverflow: number
  recent: readonly HumanChangeProjection[]
}>

type QueueShowRow = Readonly<{
  step: string
  revision: string
  status: string
  taskStatus: TaskStatus
  attempt: string
  uuid: string
  runner: string
  lease: string
  requested: string
  started: string
  changed: string
  finished: string
  duration: string
  durationMs?: number
  command?: string
  errorCode: string
  error: string
  failure?: HumanFailureProjection
  lost: string
  detail: string
  output: string
  artifacts: string
  evidence: string | Record<string, unknown>
  gate?: GateEvidence
  checkpoint: string
  merge: string
  location?: QueueLogLocation
  locations: readonly QueueLogLocationEntry[]
}>

/** Render-side run glyph (5e cut 4 — glyph left the stored shape). Non-landing
 * success must not share ✓ with real merges (21801), so it borrows the
 * status-presentation "passed" ring instead of the work-vocabulary glyph. */
export function queueShowGlyph(data: Readonly<{ taskStatus: TaskStatus; mergeVerdict: MergeVerdict }>): string {
  return data.mergeVerdict === "non-landing" ? statusPresentation("passed").glyph : taskStatusGlyph(data.taskStatus)
}

export type QueueShowData = Readonly<{
  /** Typeable `path@branch#N` run address, stamped by the projection when
   * the repository root is known (items 34/36). */
  address?: string
  run: string
  candidateId: string
  base: string
  status: Run["status"]
  conclusion?: Run["conclusion"]
  taskStatus: TaskStatus
  outcome: string
  /** Perfect detector: merged only when merge/integration proof exists. */
  mergeVerdict: MergeVerdict
  /** Step names in run order — scripts must not infer merge from glyph alone. */
  stepNames: readonly string[]
  started: string
  finished: string
  duration: string
  durationMs?: number
  totalDuration: string
  totalDurationMs?: number
  activeDuration: string
  activeDurationMs?: number
  waitDuration: string
  waitDurationMs?: number
  retries: number
  merge: string
  integration?: IntegrationProof
  parent: string
  isolationPart: "0" | "1" | "-"
  failure?: HumanFailureProjection
  prs: Run["prs"]
  revisionClock?: ChangeRunRevisionClock
  attempts: readonly (QueueAttempt & TaskStatusFields)[]
  steps: readonly QueueShowRow[]
}>

export type ChangeRunsData = Readonly<{
  pr: Change
  eligibility?: ChangeEligibility
  runs: readonly QueueShowData[]
}>

function age(timestamp: string | undefined, now: number, subject: string): string {
  if (timestamp === undefined) return "-"
  const value = elapsedMs(timestamp, new Date(now).toISOString(), subject)
  return value === undefined ? "-" : formatDuration(value)
}

function durationDistribution(values: readonly number[]): DurationDistribution {
  const { n, min, avg, p50, p90, max } = numericDistribution(values, "FLOW duration sample")
  return {
    n,
    minMs: min,
    avgMs: avg,
    p50Ms: p50,
    p90Ms: p90,
    maxMs: max,
  }
}

function waitDistribution(values: readonly number[]): QueueWaitDistribution {
  const { n, avgMs, p50Ms, p90Ms, maxMs } = durationDistribution(values)
  return { n, avgMs, p50Ms, p90Ms, maxMs }
}

export function queueFlowMetrics(
  facts: Iterable<QueueTerminalFact>,
  options: Readonly<{ now: number; windowMs: number; oldestOpenMs?: number | null }>,
): QueueFlowMetrics {
  const now = finiteNonnegative(options.now, "FLOW snapshot time")
  const windowMs = finiteNonnegative(options.windowMs, "FLOW window")
  const earliest = now - windowMs
  const seenRuns = new Set<string>()
  const activeAll: number[] = []
  const activeIntegrated: number[] = []
  const activeAlreadyMerged: number[] = []
  const activeFailed: number[] = []
  const waits: number[] = []
  let integrated = 0
  let alreadyMerged = 0
  let passed = 0
  let rejected = 0
  let environmentRefused = 0
  let stale = 0
  let lost = 0
  let legacy = 0
  let refused = 0
  let canceled = 0

  for (const fact of facts) {
    const terminalAtMs = finiteNonnegative(fact.terminalAtMs, `Run '${fact.run}' terminal time`)
    if (terminalAtMs < earliest || terminalAtMs > now) continue
    if (seenRuns.has(fact.run)) throw new Error(`yrd: duplicate terminal FLOW fact for Run '${fact.run}'`)
    seenRuns.add(fact.run)

    if (fact.outcome === "integrated") integrated += 1
    else if (fact.outcome === "already-landed") alreadyMerged += 1
    else if (fact.outcome === "passed") passed += 1
    else if (fact.outcome === "rejected") rejected += 1
    else if (fact.outcome === "environment-refused") environmentRefused += 1
    else if (fact.outcome === "stale") stale += 1
    else if (fact.outcome === "lost") lost += 1
    else if (fact.outcome === "legacy") legacy += 1
    else if (fact.outcome === "refused") refused += 1
    else if (fact.outcome === "canceled") canceled += 1
    else {
      const outcome: never = fact.outcome
      throw new TypeError(`yrd: unknown terminal FLOW outcome '${String(outcome)}'`)
    }

    if (fact.activeMs !== null) {
      const activeMs = finiteNonnegative(fact.activeMs, `Run '${fact.run}' active duration`)
      activeAll.push(activeMs)
      if (fact.outcome === "integrated") activeIntegrated.push(activeMs)
      else if (fact.outcome === "already-landed") activeAlreadyMerged.push(activeMs)
      else activeFailed.push(activeMs)
    }
    for (const wait of fact.queueWaitMs) {
      waits.push(finiteNonnegative(wait, `Run '${fact.run}' queue wait`))
    }
  }

  const decisions = integrated + alreadyMerged + rejected
  return {
    windowMs,
    terminalAttempts: seenRuns.size,
    outcomes: {
      integrated,
      alreadyMerged,
      passed,
      rejected,
      environmentRefused,
      stale,
      lost,
      legacy,
      refused,
      canceled,
    },
    decisionRejection: {
      rejected,
      decisions,
      rate: decisions === 0 ? null : rejected / decisions,
    },
    throughput: { merged: integrated, per24h: windowMs === 0 ? null : (integrated * FLOW_DAY_MS) / windowMs },
    oldestOpenMs: options.oldestOpenMs ?? null,
    activeRun: {
      allTerminal: durationDistribution(activeAll),
      integratedOnly: durationDistribution(activeIntegrated),
      alreadyLandedOnly: durationDistribution(activeAlreadyMerged),
      failedOnly: durationDistribution(activeFailed),
    },
    queueWait: waitDistribution(waits),
  }
}

export function queueTimelineRows(
  results: readonly QueueStatusResult[],
  now: number,
  latest: boolean,
  state?: BaysState,
): QueueTimelineRow[] {
  const projection = queueTimelineProjection(results, {
    now,
    windowMs: now,
    statuses: [],
    terms: [],
    latest,
    rowLimit: Number.MAX_SAFE_INTEGER,
    submissionTimes: queueTimelineAdmissionTimes(results),
    state,
  })
  return projection.rows.map((row) => {
    return {
      key: row.id,
      pr: row.pr,
      revision: row.revision,
      ...(row.candidateId === undefined ? {} : { candidateId: row.candidateId }),
      ...(row.run === undefined ? {} : { run: row.run }),
      ...(row.position === undefined ? {} : { position: row.position }),
      base: row.base,
      status: row.status === "pending" ? "ready" : row.status,
      subject: row.subject,
      detail: row.detail,
      clock: age(row.timestamp ?? undefined, now, "queue timeline row"),
      timestampMs: row.timestampMs ?? -1,
    }
  })
}

function duration(started: string | undefined, finished: string | undefined): string {
  const value = elapsedMs(started, finished)
  return value === undefined ? "-" : formatDuration(value)
}

function queueLogClock(timestamp: string, compact: boolean, includeDate: boolean): string {
  if (timestamp === "-") return timestamp
  const when = new Date(timestamp)
  if (Number.isNaN(when.getTime())) throw new Error(`yrd: invalid queue-log timestamp '${timestamp}'`)
  // Operators read the queue in their own wall-clock time, so render the
  // system-local timezone rather than UTC. The include-date decision upstream
  // stays calendar-day-in-UTC; only the displayed value is localized.
  const clock = formatLocalClock(when, includeDate)
  if (includeDate) return clock
  return compact ? clock.slice(0, 5) : clock
}

function runDurations(
  run: Run,
  attempts: readonly QueueLogAttempt[],
): {
  totalDurationMs?: number
  activeDurationMs?: number
  waitDurationMs?: number
  activeSteps: { step: string; duration: string; durationMs: number }[]
} {
  const totalDurationMs = elapsedMs(run.startedAt, run.finishedAt)
  const activeSteps = run.steps.flatMap((step) => {
    const job = step.job
    if (job === undefined || !("startedAt" in job) || !("finishedAt" in job)) return []
    const durationMs = elapsedMs(job.startedAt, job.finishedAt)
    return durationMs === undefined ? [] : [{ step: step.name, duration: preciseDuration(durationMs), durationMs }]
  })
  if (totalDurationMs === undefined) return { activeSteps }
  const activeDurationMs = Math.min(
    totalDurationMs,
    attempts.length > 0
      ? attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)
      : activeSteps.reduce((sum, step) => sum + step.durationMs, 0),
  )
  return {
    totalDurationMs,
    activeDurationMs,
    waitDurationMs: totalDurationMs - activeDurationMs,
    activeSteps,
  }
}

function artifactLocation(step: QueueStep | undefined): QueueLogLocation | undefined {
  return stepLocations(step)[0]?.location
}

function stepLocations(step: QueueStep | undefined): QueueLogLocationEntry[] {
  if (step?.job === undefined) return []
  const locations: QueueLogLocationEntry[] = []
  const seen = new Set<string>()
  const add = (label: string, location: QueueLogLocation): void => {
    const key = "path" in location ? `path:${location.path}` : `url:${location.url}`
    if (seen.has(key)) return
    seen.add(key)
    locations.push({ label, display: evidenceDisplay(label, location), location })
  }
  for (const artifact of stepArtifacts(step)) {
    const location = artifactPath(artifact)
    if (location !== undefined) add(artifactLabel(artifact), location)
  }
  if (typeof (step.job as { url?: unknown }).url === "string") {
    const url = (step.job as { url: string }).url
    if (url !== "") add("job", { url })
  }
  return locations
}

function attemptLocations(attempt: QueueAttempt): QueueLogLocationEntry[] {
  return attemptArtifacts(attempt).flatMap((artifact) => {
    const location = artifactPath(artifact)
    if (location === undefined) return []
    const label = artifactLabel(artifact)
    return [{ label, display: evidenceDisplay(label, location), location }]
  })
}

function runLocations(run: Run): QueueLogLocationEntry[] {
  const locations = run.steps.flatMap((step) => stepLocations(step))
  return [...new Map(locations.map((entry) => [JSON.stringify(entry.location), entry])).values()]
}

function runLocation(run: Run): QueueLogLocation | undefined {
  return run.steps.toReversed().flatMap(stepLocations).at(0)?.location
}

function stepArtifacts(step: QueueStep | undefined): readonly unknown[] {
  if (step?.job === undefined) return []
  const artifacts: unknown[] = []
  const append = (value: unknown): void => {
    if (isObjectValue(value) && Array.isArray(value.artifacts)) {
      artifacts.push(...(value.artifacts as readonly unknown[]))
    }
  }
  if ("artifacts" in step.job && Array.isArray(step.job.artifacts)) {
    artifacts.push(...(step.job.artifacts as readonly unknown[]))
  }
  if (
    step.job.status === "completed" &&
    (step.job.conclusion === "success" || step.job.conclusion === "failure") &&
    isObjectValue(step.job.output)
  ) {
    artifacts.push(...directArtifacts(step.job.output))
  }
  if (step.job.status === "completed" && step.job.conclusion === "failure") {
    artifacts.push(...nestedArtifacts(step.job.error.evidence))
  }
  if (step.job.status === "completed" && step.job.conclusion === "failure") {
    const refusal = isObjectValue(step.job.error.evidence) ? step.job.error.evidence : undefined
    const candidate = isObjectValue(refusal?.candidateEvidence) ? refusal.candidateEvidence : undefined
    const parent = isObjectValue(refusal?.parent) ? refusal.parent : undefined
    const selected = refusal?.phase === "parent" ? (parent ?? candidate ?? refusal) : (candidate ?? parent ?? refusal)
    for (const evidence of [selected, candidate, parent, refusal]) append(evidence)
  }
  const checkpoint = jobCheckpoint(step.job)
  artifacts.push(...directArtifacts(checkpoint))
  return [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()]
}

function artifactHref(artifact: unknown): string | undefined {
  const location = artifactPath(artifact)
  if (location === undefined) return undefined
  return locationHref(location)
}

function queueOutcome(run: Run): string {
  if (run.status === "completed" && run.conclusion === "success") {
    const integration = queueIntegration(run)
    return integration === undefined
      ? "passed"
      : integration.alreadyLanded === undefined
        ? "integrated"
        : "already-landed"
  }
  if (run.status === "completed" && run.conclusion === "cancelled") return "canceled"
  if (run.status === "completed") return terminalProjection(run).display
  // "canceled" is a distinct terminal outcome — a canceled run is NOT rejected;
  // its PRs re-queue. "running"/"waiting" fall through unchanged.
  return run.status === "waiting" ? "waiting" : "running"
}

function queueState(pr: Change, run: Run | undefined): string {
  if (run?.status === "queued" || run?.status === "in_progress") return "checking"
  if (run?.status === "waiting") return "waiting"
  if (run?.status === "completed") return terminalProjection(run).display
  return projectedChangeStatus(pr)
}

function stepDuration(step: QueueStep): string {
  const job = step.job
  if (job === undefined) return "-"
  if (job.status === "queued" || job.status === "in_progress" || job.status === "waiting") return "-"
  if (job.status === "completed" && "startedAt" in job) {
    return duration(job.startedAt, job.finishedAt)
  }
  return "-"
}

function stepArtifactsText(step: QueueStep): string {
  const artifacts = stepArtifacts(step)
  if (artifacts.length === 0) return "-"
  const first = artifacts[0]
  if (isObjectValue(first) && typeof first.name === "string") return first.name
  return String(artifacts.length)
}

function CellLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} minWidth={0} maxWidth="100%" flexShrink={1} wrap="truncate">
      {children}
    </Link>
  )
}

/** An issue reference rendered as an OSC 8 hyperlink whenever it has a
 * meaningful native or km-internal target. */
function IssueValue({ issue, flex = false }: { issue: string; flex?: boolean }) {
  const href = issueHref(issue)
  return href === undefined ? (
    <Text color="$fg-link" minWidth={flex ? 0 : undefined} flexShrink={flex ? 1 : undefined} wrap="truncate">
      {issue}
    </Text>
  ) : flex ? (
    <Link href={href} wrap="truncate" minWidth={0} flexShrink={1}>
      {issue}
    </Link>
  ) : (
    <CellLink href={href}>{issue}</CellLink>
  )
}

/**
 * A change description rendered as Markdown. Authored hard-wraps reflow to the pane
 * width (a commit body wrapped at 72 columns no longer shows mangled mid-word
 * breaks in a narrow detail pane), and bold / lists / inline code / headings
 * render styled instead of raw. Shared by the watch detail pane and `pr view`
 * via QueueDetailRunChangeBlocks / ChangeDetailView. See silvery's MarkdownView.
 */
function DescriptionBlock({ description }: { description: string }) {
  return <MarkdownView source={description} minWidth={0} />
}

function LocationLinks({ entries }: { entries: readonly QueueLogLocationEntry[] }) {
  if (entries.length === 0) return "-"
  return (
    <Box flexDirection="row" gap={1}>
      {entries.map((entry) => {
        const target = "path" in entry.location ? entry.location.path : entry.location.url
        const href = "path" in entry.location ? pathToFileURL(entry.location.path).href : entry.location.url
        return (
          <CellLink key={`${entry.label}:${target}`} href={href}>
            {`${entry.label}=${entry.display ?? target}`}
          </CellLink>
        )
      })}
    </Box>
  )
}

function QueueLogLocationLinks({ entries, compact }: { entries: readonly QueueLogLocationEntry[]; compact: boolean }) {
  if (entries.length === 0) return <Text>-</Text>
  return (
    <Text>
      art:
      {entries.map((entry, index) => {
        const href = "path" in entry.location ? pathToFileURL(entry.location.path).href : entry.location.url
        return (
          <Text key={`${entry.label}:${href}`}>
            {compact || index === 0 ? null : "+"}
            <Link href={href}>{compact ? String(index + 1) : (entry.display ?? entry.label)}</Link>
          </Text>
        )
      })}
    </Text>
  )
}

// Canonical queue marker vocabulary: working disc, neutral pending ring, red
// failure cross, muted minus, and completion check. Each lifecycle class stays
// distinguishable before color; color is foreground-only.
// The status → glyph map lives in runner-timeline.ts (pure, no silvery) so the
// headless habitant runner shares this exact vocabulary.
const statusGlyph = timelineStatusGlyph

function projectFailure(fact: FailureLike, evidence?: HumanFailureProjection["evidence"]): HumanFailureProjection {
  const failure = actionableFailure(fact)
  return {
    ...failure,
    summary: actionableFailureSummary(failure),
    ...(evidence === undefined ? {} : { evidence }),
  }
}

type QueueTerminalProjection = Readonly<{ outcome: QueueTerminalOutcome; display: string }>

/**
 * Project one terminal Run once. `outcome` is the compact lifecycle/metrics
 * class; `display` is the log/show value and deliberately preserves an
 * unrecognized raw failure code. Timeline rows keep the raw code in their
 * failure fact / STEP cell without bloating the fixed STATUS column.
 */
function terminalProjection(run: Run): QueueTerminalProjection {
  if (run.status !== "completed") {
    throw new TypeError(`yrd: nonterminal Run '${run.id}' cannot be projected as a terminal outcome`)
  }
  if (run.conclusion === "success") {
    // Perfect detector (21801 / 22323 audit): only a recorded integration proof
    // is a merge. `queueIntegration(run)?.alreadyMerged === undefined` used to
    // treat missing proof as integrated because `undefined?.x === undefined`.
    const integration = queueIntegration(run)
    if (integration === undefined) {
      return { outcome: "passed", display: "passed" }
    }
    return integration.alreadyLanded === undefined
      ? { outcome: "integrated", display: "integrated" }
      : { outcome: "already-landed", display: "already-landed" }
  }
  if (run.conclusion === "cancelled") return { outcome: "canceled", display: "canceled" }
  const failure = failureFact(run, relevantStep(run))
  if (failure === undefined) return { outcome: "rejected", display: "rejected" }
  if (GENERIC_REJECTION_CODES.has(failure.code)) return { outcome: "rejected", display: "rejected" }
  if (CANCELED_CODES.has(failure.code)) return { outcome: "canceled", display: "canceled" }
  if (failure.code === "job-lost") return { outcome: "lost", display: "lost" }
  if (STALE_CODES.has(failure.code)) return { outcome: "stale", display: "stale" }
  if (failure.code === "queue-environment-refused") {
    return { outcome: "environment-refused", display: "environment-refused" }
  }
  if (failure.code === "legacy-quiesced") return { outcome: "legacy", display: "legacy" }
  if (failure.code === "legacy-root-leased") return { outcome: "refused", display: "refused" }
  return { outcome: "rejected", display: failure.code }
}

/** Reject a nonterminal status at the terminal-fact boundary. */
function terminalOutcome(status: QueueTimelineStatus): QueueTerminalOutcome {
  if (status === "draft" || status === "rev" || status === "ready" || status === "pending" || status === "running") {
    throw new TypeError(`yrd: nonterminal status '${status}' cannot become a terminal FLOW fact`)
  }
  return status
}

function timelineStatusFilter(status: QueueTimelineStatus): QueueTimelineStatusFilter {
  // Every pre-run status (draft/rev/ready) filters with `pending`/`todo`:
  // they surface under the default view and the todo bucket, without minting new
  // CLI status filters.
  if (status === "draft" || status === "rev" || status === "ready") return "pending"
  if (status === "already-landed") return "integrated"
  if (status === "pending" || status === "running" || status === "rejected" || status === "integrated") {
    return status
  }
  return "other"
}

function timelineRunMemberRows(
  result: QueueStatusResult,
  run: Run,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string | null>,
  state: BaysState | undefined,
  /** Attempts for THIS run only — see {@link queueAttemptsByRun}. Narrowing at
   * the call site keeps the projection linear in the attempt count instead of
   * rescanning every attempt once per run. */
  runAttempts: readonly QueueAttempt[],
): QueueTimelineProjectedRow[] {
  const running = run.status === "queued" || run.status === "in_progress" || run.status === "waiting"
  const terminal = running ? null : terminalProjection(run)
  const status: QueueTimelineStatus = terminal === null ? "running" : terminal.outcome
  const timestamp = running ? toIso(run.startedAt) : run.finishedAt === undefined ? null : toIso(run.finishedAt)
  const timestampMs = parsedTimelineTimestamp(timestamp ?? undefined, `Run '${run.id}' timeline`)
  const elapsedRunMs = running
    ? timelineAge(run.startedAt, nowIso, `Run '${run.id}' active duration`)
    : (elapsedMs(run.startedAt, run.finishedAt, `Run '${run.id}' active duration`) ?? null)
  const durations = runDurations(run, runAttempts)
  const totalMs = running ? elapsedRunMs : (durations.totalDurationMs ?? null)
  const activeMs = running ? null : (durations.activeDurationMs ?? null)
  const waitMs = running ? null : (durations.waitDurationMs ?? null)
  const merged = status === "integrated" || status === "already-landed"
  const failure = merged ? undefined : failureFact(run, relevantStep(run))
  const step = relevantStep(run)
  // The row's STEP cell names the currently executing step; a later queued
  // step (requested) only shows when nothing is actively running.
  const currentStep =
    run.steps.toReversed().find((candidate) => ["running", "waiting"].includes(jobStatus(candidate))) ?? step
  const stepLabel =
    running && currentStep !== undefined ? `${run.steps.indexOf(currentStep) + 1}:${currentStep.name}` : undefined
  const baseDetail =
    failure === undefined
      ? merged
        ? queueMerge(run)
        : step === undefined
          ? run.status
          : `${step.name}: ${jobStatus(step)}`
      : actionableFailureSummary(actionableFailure(failure))
  const queueWaits = timelineQueueWaits(run, submissionTimes)
  const ageEndIso = running ? nowIso : (run.finishedAt ?? nowIso)
  const stepNames = stepNamesOfRun(run)
  const mergeVerdict = running ? ("running" as const) : mergeVerdictOfOutcome(status)
  return run.prs.map((member, index) => {
    // S7 invariant: EVERY member renders its full row from its own snapshot —
    // identity (id, branch, revision, headSha), subject (`name`), and issue all
    // live on the `ChangeSnapshot` the run journals. The record join below is
    // the LEGACY enrichment arm only (revision-lineage history, the causal
    // admission clock, submitter identity — facts only the record store ever
    // held); a recordless member is the NORMAL derived-lane shape, never
    // corruption, so the old "no retained change" throw is deliberately gone.
    // The loud edge moved to parse time: a snapshot missing an identity field
    // cannot pass ChangeSnapshotSchema, so no silent-blank row can exist here.
    const current = result.prs.find((candidate) => candidate.id === member.id)
    const lineage =
      current === undefined
        ? { pr: member.id, revisions: [member.revision] }
        : timelineRevisionLineage(current, member.revision)
    const runKey = queueRunRevisionKey(run, member)
    const submittedAt = submissionTimes.has(runKey)
      ? (submissionTimes.get(runKey) ?? undefined)
      : (submissionTimes.get(queueRevisionKey(member)) ?? undefined)
    // Member AGE anchors on the causal admission clock of THIS run, so a
    // later resubmission of the same revision can never postdate an earlier
    // run's finish (the 21106 timestamp-crash class).
    const admission = current !== undefined && current.revs.length > 0 ? runRevisionClock(current, run) : undefined
    const sourceReadyAt =
      admission === undefined
        ? (lineage.sourceReadyAt ?? submittedAt)
        : admission.admittedBy === "submission"
          ? (lineage.sourceReadyAt ?? admission.submittedAt)
          : (admission.checkRequestedAt ?? admission.pushedAt)
    const submitter = current === undefined ? undefined : revisionSubmitter(current, member.revision, member.headSha)
    // Derived world first: the snapshot's own issue is the journaled truth for
    // THIS revision; the record's is the legacy arm (it can only be newer by a
    // post-hoc `pr edit`, a verb that retires with the store).
    const issue = presentFact(member.issue ?? current?.issue)
    return {
      id: `${run.base}:run:${run.id}:${member.id}:${member.revision}`,
      base: run.base,
      group: running ? ("running" as const) : ("completed" as const),
      status,
      glyph: statusGlyph(status),
      timestamp,
      timestampMs,
      candidateId: run.candidateId,
      run: run.id,
      pr: member.id,
      // A run member is a change *or* a pin intent — this is the row where a
      // gitlink id actually reaches the renderer.
      ...(queueMemberKind(member.id) === undefined ? {} : { kind: queueMemberKind(member.id) }),
      revision: member.revision,
      headSha: member.headSha,
      branch: member.branch,
      ...(issue === undefined ? {} : { issue }),
      subject: timelineMemberSubject(result, member, state),
      ...(submitter === undefined ? {} : { submitter }),
      ...(stepLabel === undefined ? {} : { step: stepLabel }),
      detail: withTimelineLineage(baseDetail, [lineage]),
      ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
      revisionLineage: [lineage],
      ...(failure === undefined ? {} : { failure }),
      ageMs: elapsedMs(sourceReadyAt, ageEndIso, `change '${member.id}' source-ready age`) ?? null,
      totalMs,
      activeMs,
      waitMs,
      queueWaitMs: queueWaits[index] ?? null,
      mergeVerdict,
      stepNames,
    }
  })
}

/** `rev · <slug>` annotated with the code of the most recent failed
 * submission when that run is still retained; bare `rev` otherwise. */
function revisionDetail(pr: Change, runs: readonly Run[]): string {
  const runId = lastFailedSubmission(pr)?.terminal?.run
  const run = runId === undefined ? undefined : runs.find((candidate) => candidate.id === runId)
  const code = run === undefined ? undefined : failureFact(run, relevantStep(run))?.code
  return code === undefined ? "rev" : `rev · ${failureSlug(code)}`
}

/**
 * One PENDING row per live submit fact the DERIVED lane owns that no retained
 * run has admitted at its exact sha — the fact lane's pre-run band. The
 * branch/submitted fact IS the submission on the derived lane, so a standing
 * fact with no run member must surface here or a submitted branch stays
 * INVISIBLE until compose picks it up (the s5-silent-rows class, one band
 * earlier). The population rule is core's, reused rather than re-derived:
 * `derivedLaneBranches` (live fact, no live record, arbitration says derived,
 * the PR2139 already-landed cell excluded) minus branches a retained run
 * member already carries at the fact's exact sha — "a branch the derived lane
 * has ADMITTED at exactly this sha is a MEMBER; its truth lives in run/status
 * rows" (the `unrecordedSubmits` rule, projected over this result's runs).
 *
 * Nothing is minted before admission, so the row makes NO change-id claim:
 * `factOnly` marks it, `pr` carries the branch, `revision` the impossible 0.
 * Identity is the fact itself (branch, sha, base, at as the clock); the
 * subject and issue join through the owning BAY when one tracks the branch —
 * bays and composed runs are the only issue sources the derived world has.
 */
function timelineSubmitFactRows(
  result: QueueStatusResult,
  nowIso: string,
  state: BaysState | undefined,
): QueueTimelineProjectedRow[] {
  if (state === undefined) return []
  const members = [...result.running, ...result.waiting, ...result.finished].flatMap((run) => run.prs)
  return derivedLaneBranches(state).flatMap((branch): QueueTimelineProjectedRow[] => {
    const fact = state.submits[branch]
    if (fact === undefined) return []
    if (baseIdentity(fact.base) !== baseIdentity(result.base)) return []
    if (members.some((member) => member.branch === branch && member.headSha === fact.sha)) return []
    const bay = Object.values(state.byId).find((candidate) => candidate.branch === branch)
    const issue = presentFact(bay?.issue)
    const queueWaitMs = timelineAge(fact.at, nowIso, `branch '${branch}' queue wait`)
    return [
      {
        id: `${result.base}:submit:${branch}:${fact.sha}`,
        base: result.base,
        group: "pending" as const,
        status: "ready" as const,
        glyph: statusGlyph("ready"),
        timestamp: fact.at,
        timestampMs: parsedTimelineTimestamp(fact.at, `branch '${branch}' submit fact`),
        pr: branch,
        factOnly: true as const,
        revision: 0,
        headSha: fact.sha,
        branch,
        ...(issue === undefined ? {} : { issue }),
        subject: boundedQueue(bay?.path ?? bay?.name ?? `${fact.sha.slice(0, 12)} base ${fact.base}`, 80),
        detail: "submitted — awaiting compose",
        sourceReadyAt: fact.at,
        revisionLineage: [],
        ageMs: timelineAge(fact.at, nowIso, `branch '${branch}' source-ready age`),
        totalMs: null,
        activeMs: null,
        waitMs: queueWaitMs,
        queueWaitMs,
      },
    ]
  })
}

/**
 * One row per non-integrated change that is not currently a run member, each carrying
 * a derived, display-only status (`queueDisplayState().preRun`): `draft`/`rev` for
 * a registered-but-unsubmitted PR (bay status `pushed`) and `ready` for one
 * awaiting its run. These never distort queue mechanics — the `draft` group
 * (draft + rev) is excluded from every terminal FLOW fact and the
 * `oldestOpenMs` DRAIN gauge, while `ready` keeps the pending group's
 * queue-wait accounting it always had. `draft`/`rev` anchor AGE and the TIME
 * cell on the current revision's registration (`pushedAt`); `ready` keeps its
 * submission clock. BY is the current revision's author throughout.
 *
 * S7: these are the RECORD lane's pre-run rows — the legacy arm while the
 * store still holds live records. The derived lane's pre-run band is
 * {@link timelineSubmitFactRows}, prepended here so both lanes share one
 * entry point and the pending group.
 */
function timelineNonIntegratedRows(
  result: QueueStatusResult,
  nowIso: string,
  submissionTimes: ReadonlyMap<string, string | null>,
  state: BaysState | undefined,
): QueueTimelineProjectedRow[] {
  const activeRevisions = new Set(
    [...result.running, ...result.waiting].flatMap((run) => run.prs.map((member) => queueRevisionKey(member))),
  )
  const positions = queueAdmissionPositions(result.admissionOrder)
  const runs = [...result.running, ...result.waiting, ...result.finished]
  const factRows = timelineSubmitFactRows(result, nowIso, state)
  const recordRows = result.prs.flatMap((pr): QueueTimelineProjectedRow[] => {
    const revision = currentChangeRev(pr)
    const revisionKey = queueRevisionKey({ id: pr.id, revision: revision.n, headSha: revision.head })
    const eligibility = eligibilityForCurrentRevision(result, pr)
    const display = queueDisplayState(pr, { runs, eligibility })
    const status = display.preRun
    if (status === undefined) return []
    if (status === "ready" && activeRevisions.has(revisionKey)) return []
    const timestamp = submissionTimes.get(revisionKey) ?? revision.submittedAt ?? pr.submittedAt ?? null
    const timestampMs = parsedTimelineTimestamp(timestamp ?? undefined, `change '${pr.id}' submit time`)
    const position = positions.get(pr.id)
    const bayPath = pr.bay === undefined ? undefined : state?.byId[pr.bay]?.path
    const revisionLineage = [timelineRevisionLineage(pr)]
    const sourceReadyAt = revisionLineage[0]?.sourceReadyAt ?? timestamp ?? undefined
    const candidate = latestCandidateForCurrentRevision(result, pr)
    const blockingReason = eligibility?.runnable === false ? eligibility.reason : undefined
    const readyDetail = withTimelineLineage(
      blockingReason?.message ?? (position === undefined ? "queued" : `position ${position}`),
      revisionLineage,
    )
    const submitter = revisionSubmitter(pr)
    const issue = presentFact(pr.issue)
    const subject = boundedQueue(bayPath ?? pr.title ?? pr.name ?? pr.branch, 80)

    if (status === "ready") {
      return [
        {
          id: `${pr.base}:pr:${pr.id}:${revision.n}:${revision.head}`,
          base: pr.base,
          group: "pending" as const,
          status,
          glyph: statusGlyph(status),
          timestamp,
          timestampMs,
          ...(candidate === undefined ? {} : { candidateId: candidate.id }),
          pr: pr.id,
          ...(display.kind === undefined ? {} : { kind: display.kind }),
          revision: revision.n,
          headSha: revision.head,
          branch: pr.branch,
          ...(issue === undefined ? {} : { issue }),
          subject,
          ...(submitter === undefined ? {} : { submitter }),
          detail: readyDetail,
          ...(blockingReason === undefined ? {} : { whyMessage: blockingReason.message }),
          ...(position === undefined ? {} : { position }),
          ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
          revisionLineage,
          ageMs: timelineAge(sourceReadyAt, nowIso, `change '${pr.id}' source-ready age`),
          totalMs: null,
          activeMs: null,
          waitMs: timelineAge(timestamp ?? undefined, nowIso, `change '${pr.id}' queue wait`),
          queueWaitMs: timelineAge(timestamp ?? undefined, nowIso, `change '${pr.id}' queue wait`),
        },
      ]
    }

    // draft | rev — pushed, pre-queue WIP anchored on registration (pushedAt).
    const registeredAt = revision.pushedAt
    const detail = status === "rev" ? (blockingReason?.message ?? revisionDetail(pr, runs)) : "draft"
    return [
      {
        id: `${pr.base}:draft:${pr.id}:${revision.n}:${revision.head}`,
        base: pr.base,
        group: "draft" as const,
        status,
        glyph: statusGlyph(status),
        timestamp: registeredAt,
        timestampMs: parsedTimelineTimestamp(registeredAt, `change '${pr.id}' registration`),
        ...(candidate === undefined ? {} : { candidateId: candidate.id }),
        pr: pr.id,
        ...(display.kind === undefined ? {} : { kind: display.kind }),
        revision: revision.n,
        headSha: revision.head,
        branch: pr.branch,
        ...(issue === undefined ? {} : { issue }),
        subject,
        ...(submitter === undefined ? {} : { submitter }),
        detail: withTimelineLineage(detail, revisionLineage),
        ...(blockingReason === undefined ? {} : { whyMessage: blockingReason.message }),
        ...(registeredAt === undefined ? {} : { sourceReadyAt: registeredAt }),
        revisionLineage,
        ...(blockingReason === undefined
          ? {}
          : { failure: { code: blockingReason.code, message: blockingReason.message } }),
        ageMs: timelineAge(registeredAt, nowIso, `change '${pr.id}' source-ready age`),
        totalMs: null,
        activeMs: null,
        waitMs: null,
        queueWaitMs: null,
      },
    ]
  })
  return [...factRows, ...recordRows]
}

type QueueTimelineSortableRow = Readonly<{
  row: QueueTimelineProjectedRow
  calendarDay: string | null
}>

function timelineSort(left: QueueTimelineSortableRow, right: QueueTimelineSortableRow): number {
  // Round 6: date headers describe contiguous calendar-day groups. Grouping by
  // status before time could interleave days across midnight (07-18 / 07-19 /
  // 07-18), so calendar day is the outer ordering key. Within one day the
  // queue's status/position ordering remains unchanged.
  if (left.calendarDay !== null && right.calendarDay !== null && left.calendarDay !== right.calendarDay) {
    return right.calendarDay.localeCompare(left.calendarDay)
  }
  const leftRow = left.row
  const rightRow = right.row
  const groupOrder: Record<QueueTimelineGroup, number> = { draft: 0, pending: 1, running: 2, completed: 3 }
  const group = groupOrder[leftRow.group] - groupOrder[rightRow.group]
  if (group !== 0) return group
  if (leftRow.group === "pending" && rightRow.group === "pending") {
    const position = (leftRow.position ?? Number.MAX_SAFE_INTEGER) - (rightRow.position ?? Number.MAX_SAFE_INTEGER)
    if (position !== 0) return position
  }
  const leftAt = leftRow.timestampMs ?? Number.NEGATIVE_INFINITY
  const rightAt = rightRow.timestampMs ?? Number.NEGATIVE_INFINITY
  if (leftAt !== rightAt) return leftRow.group === "completed" ? rightAt - leftAt : leftAt - rightAt
  return compareNatural(leftRow.id, rightRow.id)
}

function timelineMatches(row: QueueTimelineProjectedRow, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  const searchable = [row.candidateId ?? "", row.run ?? "", row.pr, row.branch, row.subject, row.failure?.code ?? ""]
    .join("\n")
    .toLocaleLowerCase()
  return terms.some((term) => searchable.includes(term))
}

function latestTimelineRows(rows: readonly QueueTimelineProjectedRow[]): QueueTimelineProjectedRow[] {
  const latestByPr = new Map<string, QueueTimelineProjectedRow>()
  for (const row of rows) {
    const current = latestByPr.get(row.pr)
    const currentAt = current?.timestampMs ?? Number.NEGATIVE_INFINITY
    const nextAt = row.timestampMs ?? Number.NEGATIVE_INFINITY
    if (current === undefined || nextAt > currentAt || (nextAt === currentAt && row.id > current.id)) {
      latestByPr.set(row.pr, row)
    }
  }
  return rows.filter((row) => latestByPr.get(row.pr)?.id === row.id)
}

function terminalMemberFact(
  row: QueueTimelineProjectedRow,
  run: string,
  terminalAt: string,
  failedAttempts: ReadonlyMap<string, number>,
): QueueTerminalMemberFact {
  const lineage = row.revisionLineage.find((candidate) => candidate.pr === row.pr)
  const totalStart = lineage?.registeredAt ?? lineage?.sourceReadyAt
  const totalMs =
    totalStart === undefined ? null : (elapsedMs(totalStart, terminalAt, `change '${row.pr}' total duration`) ?? null)
  return {
    pr: row.pr,
    revision: row.revision,
    totalMs,
    totalApproximate: totalStart !== undefined && lineage?.registeredAt === undefined,
    // Agent-held time becomes journal truth with the draft/claim model (21707).
    // Queue data must never stand in for it.
    codingMs: null,
    jobRunMs: row.activeMs,
    retries: Math.max(0, (lineage?.revisions.length ?? 1) - 1) + (failedAttempts.get(run) ?? 0),
  }
}

function foldTerminalFacts(
  rows: readonly QueueTimelineProjectedRow[],
  attempts: readonly QueueAttempt[],
): QueueTerminalFact[] {
  const byRun = new Map<string, QueueTerminalFact>()
  const failedAttempts = failedAttemptsByRun(attempts)
  for (const row of rows) {
    if (row.group !== "completed" || row.timestamp === null || row.timestampMs === null || row.run === undefined) {
      continue
    }
    const key = `${row.base}:${row.run}`
    const fact = byRun.get(key)
    const waits = row.queueWaitMs === null ? [] : [row.queueWaitMs]
    const outcome = terminalOutcome(row.status)
    const failureClass =
      outcome === "integrated" || outcome === "already-landed" || outcome === "passed"
        ? null
        : failureBreakdownClass(row.failure?.code ?? row.status)
    const member = terminalMemberFact(row, row.run, row.timestamp, failedAttempts)
    if (fact === undefined) {
      byRun.set(key, {
        run: row.run,
        terminalAtMs: row.timestampMs,
        outcome,
        failureClass,
        activeMs: row.totalMs,
        queueWaitMs: waits,
        members: [member],
      })
      continue
    }
    if (fact.outcome !== outcome || fact.failureClass !== failureClass) {
      throw new Error(`yrd: Run '${row.run}' member rows disagree on terminal outcome`)
    }
    if (fact.members.some((candidate) => candidate.pr === member.pr)) {
      throw new Error(`yrd: Run '${row.run}' repeats terminal change member '${member.pr}'`)
    }
    byRun.set(key, {
      ...fact,
      queueWaitMs: [...fact.queueWaitMs, ...waits],
      members: [...fact.members, member],
    })
  }
  return [...byRun.values()]
}

type QueueTimelineProjectionBuild = Readonly<{
  projection: QueueTimelineProjection
  metricFacts: readonly QueueTerminalFact[]
}>

/**
 * Label the queues this projection covers: the primary base first (label 1),
 * then every other base carrying a summary, by name. A base is a queue here
 * because that is what the journal separates runs by — the label is display
 * shorthand for it, never a second identity.
 */
function queueTimelineQueues(
  results: readonly QueueStatusResult[],
  primary: string | undefined,
  repositoryRoot: string | undefined,
  queueNames: ReadonlyMap<string, string> | undefined,
): readonly QueueTimelineQueue[] {
  const base = primary ?? results[0]?.base ?? "main"
  const others = [...new Set(results.map((result) => result.base))].filter((candidate) => candidate !== base).toSorted()
  return [base, ...others].map((queueBase, index) => ({
    label: index + 1,
    base: queueBase,
    ...(repositoryRoot === undefined ? {} : { path: repositoryRoot }),
    ...(queueNames?.get(queueBase) === undefined ? {} : { name: queueNames.get(queueBase) }),
    address: queueFullName({ ...(repositoryRoot === undefined ? {} : { path: repositoryRoot }), base: queueBase }),
  }))
}

function buildQueueTimelineProjection(
  results: readonly QueueStatusResult[],
  options: QueueTimelineProjectionOptions,
): QueueTimelineProjectionBuild {
  if (!Number.isFinite(options.now) || options.now < 0) throw new TypeError("yrd: timeline snapshot time is invalid")
  if (!Number.isFinite(options.windowMs) || options.windowMs < 0) {
    throw new TypeError("yrd: timeline window is invalid")
  }
  if (
    options.metricsWindowMs !== undefined &&
    (!Number.isFinite(options.metricsWindowMs) || options.metricsWindowMs < 0)
  ) {
    throw new TypeError("yrd: timeline metrics window is invalid")
  }
  if (!Number.isFinite(options.rowLimit) || options.rowLimit < 0) {
    throw new TypeError("yrd: timeline row limit is invalid")
  }
  const metricsWindowMs = options.metricsWindowMs ?? options.windowMs
  const nowIso = new Date(options.now).toISOString()
  const sinceMs = options.now - options.windowMs
  const since = new Date(sinceMs).toISOString()
  const requestedStatuses = options.statuses.length === 0 ? TIMELINE_STATUS_ORDER : options.statuses
  const statuses = TIMELINE_STATUS_ORDER.filter((status) => requestedStatuses.includes(status))
  const selectedStatuses = new Set(statuses)
  const terms = [...new Set(options.terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))]
  const attemptsByRun = queueAttemptsByRun(options.attempts ?? [])
  const rawRows = results.flatMap((result) => [
    ...timelineNonIntegratedRows(result, nowIso, options.submissionTimes, options.state),
    ...[...result.running, ...result.waiting, ...result.finished].flatMap((run) =>
      timelineRunMemberRows(
        result,
        run,
        nowIso,
        options.submissionTimes,
        options.state,
        attemptsByRun.get(run.id) ?? NO_ATTEMPTS,
      ),
    ),
  ])
  // Status + window + term filtering, then the optional latest-per-PR fold.
  // Shared by the display window and the (possibly wider) metrics window so
  // both apply identical criteria and only the window bound differs.
  const selectRows = (windowStartMs: number): QueueTimelineProjectedRow[] => {
    const filtered = rawRows
      .filter((row) => selectedStatuses.has(timelineStatusFilter(row.status)))
      .filter((row) => row.timestampMs === null || (row.timestampMs >= windowStartMs && row.timestampMs <= options.now))
      .filter((row) => timelineMatches(row, terms))
    return options.latest ? latestTimelineRows(filtered) : filtered
  }
  const displayed = selectRows(sinceMs)
  const queues = queueTimelineQueues(results, options.base, options.repositoryRoot, options.queueNames)
  const labelsByBase = new Map(queues.map(({ label, base: queueBase }) => [queueBase, label]))
  // One queue means no labels at all — not label 1 — so nothing about a
  // single-queue watch changes shape when the feature ships. Every
  // run-bearing row also carries its typeable `path@branch#N` address when
  // the repository root is known (items 34/36).
  const rows = displayed
    .map((row) => ({
      row,
      calendarDay: row.timestamp === null ? null : timelineLocalCalendarDay(row.timestamp),
    }))
    .toSorted(timelineSort)
    .map(({ row }) => {
      const address = row.run === undefined ? undefined : timelineRunAddress(options.repositoryRoot, row.base, row.run)
      return {
        ...row,
        ...(queues.length > 1 && labelsByBase.has(row.base) ? { queueLabel: labelsByBase.get(row.base) } : {}),
        ...(address === undefined ? {} : { address }),
      }
    })
  // Terminal facts drive the flow aggregate over the metrics window, which may
  // reach further back than the listing window; reuse the display set when the
  // windows coincide.
  const metricsRows = metricsWindowMs === options.windowMs ? displayed : selectRows(options.now - metricsWindowMs)
  // Metrics stay per-Run: member rows of one batched Run fold into one terminal
  // fact carrying every visible member's queue wait.
  const terminalFacts = foldTerminalFacts(metricsRows, options.attempts ?? [])
  // The calendar STATS panel folds the FULL retained fact horizon (rawRows,
  // before any window bound), NOT the display `windowMs` listing nor the
  // `metricsWindowMs` default. `earliestFactMs` gates each calendar bucket
  // until retained history reaches its start. Facts stay unfiltered by the
  // operator's view so a health readout never hides failures behind a filter.
  const timeStatsFacts = foldTerminalFacts(rawRows, options.attempts ?? [])
  // The retained terminal-fact horizon: the oldest timestamped row this
  // projection can still count. This is intentionally more conservative than
  // the journal's first event because compacted Run facts cannot prove a zero;
  // a calendar bucket renders `—` until retained facts reach its start.
  const earliestFactMs = rawRows.reduce<number | null>(
    (earliest, row) =>
      row.timestampMs === null ? earliest : earliest === null ? row.timestampMs : Math.min(earliest, row.timestampMs),
    null,
  )
  const allRuns = results.flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
  const finished = results.flatMap((result) => result.finished)
  const runsByKey = queueRunsByKey(allRuns)
  const retryPeers = queueRetryPeers(finished)
  const detailRuns = new Set<string>()
  const details = rows.flatMap((row) => {
    if (row.run === undefined) return []
    const key = `${row.base}:${row.run}`
    if (detailRuns.has(key)) return []
    detailRuns.add(key)
    const run = runsByKey.get(key)
    // `queueShowData` re-filters both lists it is handed down to this Run, so
    // passing the pre-narrowed slices is semantically identical and drops two
    // per-detail-row scans of the whole journal: every attempt, and every
    // finished Run.
    if (run === undefined) return []
    const data = queueShowData(run, queueRetryPeersOf(retryPeers, run), attemptsByRun.get(run.id) ?? NO_ATTEMPTS)
    const address = timelineRunAddress(options.repositoryRoot, data.base, data.run)
    return [address === undefined ? data : { ...data, address }]
  })
  const limit = Math.max(1, Math.floor(options.rowLimit))
  const retainedSince =
    options.retainedSinceMs === undefined ? undefined : new Date(options.retainedSinceMs).toISOString()
  const base = options.base ?? results[0]?.base ?? "main"
  const pause = results.find((result) => result.base === base)?.pause
  const oldestOpenMs = rows
    .filter((row) => row.group === "pending")
    .reduce<number | null>((oldest, row) => {
      if (row.ageMs === null) return oldest
      return oldest === null ? row.ageMs : Math.max(oldest, row.ageMs)
    }, null)
  const projection: QueueTimelineProjection = {
    now: nowIso,
    base,
    queues,
    siblingBases: [...new Set(options.siblingBases ?? [])].filter((candidate) => candidate !== base).toSorted(),
    runner: options.runner ?? null,
    ...(options.runner != null || options.runnerAbsence === undefined ? {} : { runnerAbsence: options.runnerAbsence }),
    ...(pause === undefined ? {} : { pause }),
    oldestOpenMs,
    filters: { windowMs: options.windowMs, since, statuses, terms, latest: options.latest },
    coverage: {
      requestedSince: since,
      ...(retainedSince === undefined ? {} : { retainedSince }),
      // An unbounded window shows every retained row, so coverage is complete
      // by definition (the `now - window` cutoff would otherwise read as older
      // than any retained record and falsely trip the incompleteness warning).
      complete:
        options.windowMs >= QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS ||
        options.retainedSinceMs === undefined ||
        options.retainedSinceMs <= sinceMs,
    },
    display: { limit, shown: Math.min(rows.length, limit), hidden: Math.max(0, rows.length - limit) },
    rows,
    details,
    metrics: queueFlowMetrics(terminalFacts, { now: options.now, windowMs: metricsWindowMs, oldestOpenMs }),
    timeStatsFacts,
    earliestFactMs,
  }
  return { projection, metricFacts: terminalFacts }
}

export function queueTimelineProjection(
  results: readonly QueueStatusResult[],
  options: QueueTimelineProjectionOptions,
): QueueTimelineProjection {
  return buildQueueTimelineProjection(results, options).projection
}

export type QueueTimelineProjectionClock = Readonly<{
  projection: QueueTimelineProjection
  reclock(now: number): QueueTimelineProjection
}>

export function createQueueTimelineProjectionClock(
  results: readonly QueueStatusResult[],
  options: QueueTimelineProjectionOptions,
): QueueTimelineProjectionClock {
  const built = buildQueueTimelineProjection(results, options)
  const metricsWindowMs = options.metricsWindowMs ?? options.windowMs
  let current = built.projection
  return Object.freeze({
    projection: current,
    reclock(now) {
      current = reclockQueueTimelineProjection(current, now, metricsWindowMs, built.metricFacts)
      return current
    },
  })
}

function reclockTimelineRow(row: QueueTimelineProjectedRow, nowIso: string): QueueTimelineProjectedRow {
  if (row.group === "completed") return row
  const ageMs = timelineAge(row.sourceReadyAt, nowIso, `change '${row.pr}' source-ready age`)
  if (row.group === "running") {
    return {
      ...row,
      ageMs,
      totalMs: timelineAge(row.timestamp ?? undefined, nowIso, `Run '${row.run ?? "unknown"}' active duration`),
    }
  }
  if (row.group === "pending") {
    const queueWaitMs = timelineAge(row.timestamp ?? undefined, nowIso, `change '${row.pr}' queue wait`)
    return { ...row, ageMs, waitMs: queueWaitMs, queueWaitMs }
  }
  return { ...row, ageMs }
}

/**
 * Advance only wall-clock-derived queue facts while the Journal cursor, read
 * model generation, and resident-runner token stay unchanged. Durable Run/PR
 * folding, detail construction, and terminal statistics remain shared by
 * identity; time can only move rows out of a fixed window, never into it.
 */
function reclockQueueTimelineProjection(
  projection: QueueTimelineProjection,
  now: number,
  metricsWindowMs: number,
  metricFacts: readonly QueueTerminalFact[],
): QueueTimelineProjection {
  const nowIso = new Date(now).toISOString()
  if (nowIso === projection.now) return projection
  const sinceMs = now - projection.filters.windowMs
  const requestedSince = new Date(sinceMs).toISOString()
  const rows = projection.rows
    .map((row) => reclockTimelineRow(row, nowIso))
    .filter((row) => row.timestampMs === null || (row.timestampMs >= sinceMs && row.timestampMs <= now))
  const retainedRuns = new Set(rows.flatMap((row) => (row.run === undefined ? [] : [row.run])))
  const retainedDetails = projection.details.filter((detail) => retainedRuns.has(detail.run))
  const details = retainedDetails.length === projection.details.length ? projection.details : retainedDetails
  const oldestOpenMs = rows
    .filter((row) => row.group === "pending")
    .reduce<number | null>(
      (oldest, row) => (row.ageMs === null ? oldest : oldest === null ? row.ageMs : Math.max(oldest, row.ageMs)),
      null,
    )
  const retainedSinceMs =
    projection.coverage.retainedSince === undefined ? undefined : Date.parse(projection.coverage.retainedSince)
  const reclocked: QueueTimelineProjection = {
    ...projection,
    now: nowIso,
    oldestOpenMs,
    filters: {
      ...projection.filters,
      since: requestedSince,
    },
    coverage: {
      ...projection.coverage,
      requestedSince,
      complete:
        projection.filters.windowMs >= QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS ||
        retainedSinceMs === undefined ||
        retainedSinceMs <= sinceMs,
    },
    display: {
      ...projection.display,
      shown: Math.min(rows.length, projection.display.limit),
      hidden: Math.max(0, rows.length - projection.display.limit),
    },
    rows,
    details,
    metrics: queueFlowMetrics(metricFacts, { now, windowMs: metricsWindowMs, oldestOpenMs }),
  }
  return reclocked
}

function failureEvidence(step: QueueStep | undefined): HumanFailureProjection["evidence"] {
  const location = stepLocations(step)[0]?.location
  if (location === undefined) return undefined
  return "path" in location
    ? { text: location.path, href: pathToFileURL(location.path).href }
    : { text: location.url, href: location.url }
}

function projectPR(
  state: BaysState | undefined,
  result: QueueSummary,
  pr: Change,
  now: number,
  runOverride?: Run,
  candidateOverride?: Candidate,
  eligibility?: ChangeEligibility,
): HumanChangeProjection {
  const run = runOverride ?? latestRunForCurrentRevision(pr, result)
  const candidate = candidateOverride
  const step = relevantStep(run)
  const job = step?.job
  const path = pr.bay === undefined ? undefined : state?.byId[pr.bay]?.path
  const revisionClocks = changeRevisionClocks(pr)
  const revision =
    run === undefined
      ? revisionClocks.find(
          (candidate) => candidate.revision === changeRevisionNumber(pr) && candidate.headSha === changeHead(pr),
        )
      : runRevisionClock(pr, run)
  const isCurrentRevision =
    revision === undefined || (revision.revision === changeRevisionNumber(pr) && revision.headSha === changeHead(pr))
  const submittedAt = revision?.submittedAt ?? (run === undefined && isCurrentRevision ? pr.submittedAt : undefined)
  const projectedRevision = revision?.revision ?? changeRevisionNumber(pr)
  const lineage = timelineRevisionLineage(pr, projectedRevision)
  const sourceReadyAt = lineage.sourceReadyAt
  const revisionLineage = lineage.revisions
  const touchedAt = latest(
    ...(runOverride === undefined
      ? [
          revision?.pushedAt,
          submittedAt,
          revision?.terminal?.at,
          pr.rejectedAt,
          pr.integratedAt,
          pr.alreadyLandedAt,
          pr.withdrawnAt,
        ]
      : []),
    run?.startedAt,
    run?.finishedAt,
    candidate?.createdAt,
    ...(run?.steps ?? []).flatMap((item) => {
      const itemJob = item.job
      return itemJob === undefined
        ? []
        : [
            itemJob.requestedAt,
            itemJob.changedAt,
            "startedAt" in itemJob ? itemJob.startedAt : undefined,
            "finishedAt" in itemJob ? itemJob.finishedAt : undefined,
          ]
    }),
  )
  const runDurationMs =
    run === undefined
      ? undefined
      : elapsedMs(run.startedAt, run.finishedAt ?? new Date(now).toISOString(), `run '${run.id}' duration`)
  const runDuration = runDurationMs === undefined ? "-" : formatDuration(runDurationMs)
  const artifacts = stepArtifacts(step)
  const artifact = artifactHref(artifacts[0])
  const candidateConflict =
    run === undefined && eligibility?.runnable === false && eligibility.reason?.code === "candidate-conflicting"
  const projectedState = projectedChangeStatus(pr, eligibility)
  const stateLabel = candidateConflict
    ? eligibility.reason.code
    : projectedState === "needs-author"
      ? projectedState
      : queueState(pr, run)
  const taskStatus = candidateConflict
    ? "blocked"
    : runOverride === undefined || run === undefined
      ? changeTaskStatusOf(pr)
      : runTaskStatusOf(run)
  const fact = failureFact(run, step)
  const evidence = failureEvidence(step)
  const terminalAt =
    revision?.terminal?.at ??
    runOverride?.finishedAt ??
    (isCurrentRevision
      ? changeDeliveryState(pr) === "needs-author"
        ? changeNeedsAuthor(pr)?.at
        : changeDeliveryState(pr) === "rejected"
          ? pr.rejectedAt
          : changeDeliveryState(pr) === "integrated"
            ? pr.integratedAt
            : changeDeliveryState(pr) === "already-landed"
              ? pr.alreadyLandedAt
              : changeDeliveryState(pr) === "withdrawn"
                ? pr.withdrawnAt
                : undefined
      : undefined)
  const parsedTerminalAt = terminalAt === undefined ? Number.NaN : Date.parse(terminalAt)
  const ageAt = Number.isFinite(parsedTerminalAt) ? parsedTerminalAt : now
  const failure = fact === undefined || run === undefined ? undefined : projectFailure(fact, evidence)
  const candidateId = run?.candidateId ?? candidate?.id
  return {
    pr: pr.id,
    revision: projectedRevision,
    ...(path === undefined ? {} : { changeHref: pathToFileURL(path).href, path }),
    branch: pr.branch,
    subject: boundedQueue(pr.title ?? pr.name ?? pr.branch, 80),
    nativeStatus: changeDeliveryState(pr),
    state: stateLabel,
    ...taskStatusFields(taskStatus),
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(run === undefined ? {} : { runId: run.id }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
    ...(sourceReadyAt === undefined ? {} : { sourceReadyAt }),
    revisionLineage,
    target: pr.base,
    age: age(sourceReadyAt ?? submittedAt ?? revision?.pushedAt, ageAt, `change '${pr.id}' source-ready age`),
    touched: age(touchedAt, now, `change '${pr.id}' touched age`),
    ...(touchedAt === undefined ? {} : { touchedAt }),
    run: runDuration,
    step: step?.name ?? "-",
    result:
      (candidateConflict ? eligibility.reason.message : undefined) ??
      failure?.summary ??
      (job !== undefined && "detail" in job && typeof job.detail === "string" ? boundedQueue(job.detail) : undefined) ??
      (step === undefined ? "-" : jobStatus(step)),
    ...(job !== undefined && "url" in job && job.url !== undefined ? { log: job.url } : {}),
    artifactCount: artifacts.length,
    ...(artifact === undefined ? {} : { artifact }),
    ...(failure === undefined ? {} : { failure }),
  }
}

/**
 * A HumanChangeProjection for a RECORDLESS run member (derived/intent): the
 * snapshot carries identity and subject, the run carries the terminal truth.
 * Facts only the record store held — the source-ready/admission clock,
 * pre-run candidate joins, bay paths — render the explicit "-" marker, never
 * a fabricated value and never a silent blank (the same absence contract as
 * the derived log rows' age "-").
 */
function projectFinishedRunMember(member: Run["prs"][number], run: Run, now: number): HumanChangeProjection {
  const step = relevantStep(run)
  const job = step?.job
  const outcome = run.status === "completed" ? terminalProjection(run) : null
  const nativeStatus: ChangeDeliveryState =
    outcome === null
      ? "submitted"
      : outcome.outcome === "integrated" || outcome.outcome === "already-landed" || outcome.outcome === "canceled"
        ? outcome.outcome
        : outcome.outcome === "passed"
          ? // A non-landing pass closes nothing delivery-wise: the submit fact
            // stands and the branch re-queues on content change.
            "submitted"
          : "rejected"
  const touchedAt = latest(run.startedAt, run.finishedAt)
  const runDurationMs = elapsedMs(
    run.startedAt,
    run.finishedAt ?? new Date(now).toISOString(),
    `run '${run.id}' duration`,
  )
  const fact = failureFact(run, step)
  const failure = fact === undefined ? undefined : projectFailure(fact, failureEvidence(step))
  const artifacts = stepArtifacts(step)
  const artifact = artifactHref(artifacts[0])
  return {
    pr: member.id,
    revision: member.revision,
    branch: member.branch,
    subject: boundedQueue(member.name ?? member.branch, 80),
    nativeStatus,
    state: queueOutcome(run),
    ...taskStatusFields(runTaskStatusOf(run)),
    ...(run.candidateId === undefined ? {} : { candidateId: run.candidateId }),
    runId: run.id,
    revisionLineage: [member.revision],
    target: member.base,
    age: "-",
    touched: age(touchedAt, now, `change '${member.id}' touched age`),
    ...(touchedAt === undefined ? {} : { touchedAt }),
    run: runDurationMs === undefined ? "-" : formatDuration(runDurationMs),
    step: step?.name ?? "-",
    result: failure?.summary ?? (step === undefined ? "-" : jobStatus(step)),
    ...(job !== undefined && "url" in job && job.url !== undefined ? { log: job.url } : {}),
    artifactCount: artifacts.length,
    ...(artifact === undefined ? {} : { artifact }),
    ...(failure === undefined ? {} : { failure }),
  }
}

/** S7: `result.prs` is the record store's LEGACY projection arm — it drains
 * to empty as the store purges. Recordless members join the human projection
 * through {@link projectFinishedRunMember}; pre-run submit facts surface on
 * the timeline via `timelineSubmitFactRows`. */
function projectedChangeRows(
  state: BaysState | undefined,
  result: QueueStatusResult,
  now: number,
): HumanChangeProjection[] {
  return result.prs.map((pr) =>
    projectPR(
      state,
      result,
      pr,
      now,
      undefined,
      latestCandidateForCurrentRevision(result, pr),
      eligibilityForCurrentRevision(result, pr),
    ),
  )
}

function byTouchedNewest(left: HumanChangeProjection, right: HumanChangeProjection): number {
  const order = (right.touchedAt ?? "").localeCompare(left.touchedAt ?? "")
  return order === 0 ? compareNatural(left.pr, right.pr) : order
}

export function humanQueueProjection(
  result: QueueStatusResult,
  now: number,
  options: Readonly<{
    selected?: ReadonlySet<string>
    state?: BaysState
  }> = {},
): HumanQueueProjection {
  const selected = options.selected ?? new Set<string>()
  const rows = projectedChangeRows(options.state, result, now)
  const positions = queueAdmissionPositions(result.admissionOrder)
  const queueRows = rows
    .filter((row) => row.nativeStatus === "submitted" || row.nativeStatus === "ready")
    .map((row) => ({ ...row, position: requiredQueuePosition(positions, row.pr) }))
    .toSorted((left, right) => left.position - right.position)
  const historical = result.finished.flatMap((run) =>
    run.prs.flatMap((member) => {
      if (selected.size === 0 && (run.status !== "completed" || run.conclusion !== "failure")) return []
      const pr = result.prs.find((candidate) => candidate.id === member.id)
      if (pr === undefined) {
        // Recordless (derived/intent) member: the snapshot + run terminal are
        // the whole truth. Dropping the row here silently erased every derived
        // member from RECENT (the s5-silent-rows class).
        if (selected.size > 0 && !selected.has(member.id)) return []
        return [projectFinishedRunMember(member, run, now)]
      }
      const delivery = changeDeliveryState(pr)
      if (selected.size > 0 && (!selected.has(pr.id) || delivery === "submitted" || delivery === "ready")) {
        return []
      }
      return [projectPR(options.state, result, pr, now, run)]
    }),
  )
  const represented = new Set(historical.map((row) => row.pr))
  const recentCandidates = [
    ...historical,
    ...rows.filter((row) => {
      if (represented.has(row.pr)) return false
      return selected.size === 0
        ? row.nativeStatus === "rejected" || row.state === "needs-author"
        : selected.has(row.pr) && row.nativeStatus !== "submitted" && row.nativeStatus !== "ready"
    }),
  ]
  const queue = queueRows.slice(0, QUEUE_ROW_LIMIT)
  const active = activeWatchRow(result, now, selected)
  return {
    target: `${result.base}${result.headSha === undefined ? "" : `@${result.headSha.slice(0, 12)}`}`,
    open: queueRows.length,
    activeCount: queueRows.filter((row) => ["checking", "waiting"].includes(row.state)).length,
    integrated: rows.filter((row) => row.nativeStatus === "integrated").length,
    alreadyMerged: rows.filter((row) => row.nativeStatus === "already-landed").length,
    rejected: rows.filter((row) => row.nativeStatus === "rejected" && row.state !== "needs-author").length,
    needsAuthor: rows.filter((row) => row.state === "needs-author").length,
    ...(result.pause === undefined ? {} : { pause: result.pause }),
    ...(active === undefined ? {} : { active }),
    oldestOpen: queueRows[0]?.age ?? "-",
    queue,
    queueOverflow: Math.max(0, queueRows.length - queue.length),
    recent: recentCandidates.toSorted(byTouchedNewest).slice(0, RECENT_ROW_LIMIT),
  }
}

export function QueueRunsView({ runs }: { runs: readonly Run[] }) {
  if (runs.length === 0) return <Text color="$fg-muted">Queue idle.</Text>
  const data = runs.map((run) => {
    const taskStatus = runTaskStatusOf(run)
    return {
      run: run.id,
      prs: run.prs.map((pr) => pr.id).join(","),
      state: run.status,
      ...taskStatusFields(taskStatus),
      steps: boundedQueue(queueRunSteps(run)),
    }
  })
  return (
    <Table
      data={data}
      columns={[
        { header: "RUN", key: "run" },
        { header: "PRS", key: "prs" },
        {
          header: "STATE",
          key: "state",
          minWidth: 12,
          render: (row) => <TaskStatusValue taskStatus={row.taskStatus} value={row.state} />,
        },
        { header: "STEPS", key: "steps", grow: true },
      ]}
    />
  )
}

export type ChangeListRow = Readonly<{
  pr: string
  state: string
  stateLabel: string
  glyph: string
  revision: number
  lineage: string
  subject: string
  submitter: string
  target: string
  review: "n/a" | "need" | "ok" | "reject"
  checks: "n/a" | "wait" | "run" | "pass" | "fail"
  why: string
  /** The human message behind the `why` code, when the eligibility carries one.
   * The code token stays the column's VALUE — table widths are computed from
   * it — while the message rides alongside for the cell renderer and any row
   * consumer, so nobody re-derives it from a second eligibility lookup. */
  whyMessage?: string
  age: string
  touched: string
}>

const checkLabels = {
  "not-requested": "n/a",
  queued: "wait",
  checking: "run",
  passed: "pass",
  failed: "fail",
} as const satisfies Record<ChangeEligibility["checks"]["status"], ChangeListRow["checks"]>

function reviewLabel(eligibility: ChangeEligibility): ChangeListRow["review"] {
  if (!eligibility.review.required) return "n/a"
  if (eligibility.review.decision === "reject") return "reject"
  return eligibility.review.approved && !eligibility.review.stale ? "ok" : "need"
}

export function changeListRows(
  entries: readonly Readonly<{ pr: Change; eligibility: ChangeEligibility }>[],
  runs: readonly Run[],
  now: number,
  merges: ReadonlyMap<string, Readonly<{ code: string }>> = new Map(),
): ChangeListRow[] {
  const summary: QueueSummary = {
    base: "*",
    running: runs.filter((run) => run.status === "queued" || run.status === "in_progress"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter((run) => run.status === "completed"),
  }
  return entries.map(({ pr, eligibility }) => {
    const revision = changeRevisionNumber(pr)
    if (eligibility.pr !== pr.id || eligibility.revision !== revision) {
      throw new Error(
        `yrd: change '${pr.id}' revision ${revision} has mismatched eligibility for '${eligibility.pr}' revision ${eligibility.revision}`,
      )
    }
    if (!eligibility.runnable && eligibility.reason === undefined) {
      throw new Error(`yrd: change '${pr.id}' revision ${revision} is ineligible without a typed blocking reason`)
    }
    const projected = projectPR(undefined, summary, pr, now, undefined, undefined, eligibility)
    // A proven merge outranks the recorded state: `withdrawn` is a claim
    // about content, and a head already reachable from the base contradicts it.
    // Showing the later write as the whole truth sends the author back to
    // re-cut a branch that is already on the base branch (22376).
    const merge = merges.get(pr.id)
    const state = merge === undefined ? projectedChangeStatus(pr, eligibility) : "already-landed"
    const glyph = merge === undefined ? taskStatusGlyph(projected.taskStatus) : "✓"
    return {
      pr: projected.pr,
      state,
      stateLabel: `${glyph} ${state}`,
      glyph,
      revision,
      lineage: projected.revisionLineage.join("→"),
      subject: projected.subject,
      submitter: revisionSubmitter(pr) ?? "-",
      target: projected.target,
      review: reviewLabel(eligibility),
      checks: checkLabels[eligibility.checks.status],
      why: merge?.code ?? eligibility.reason?.code ?? "-",
      // Only when the eligibility reason is what the WHY column shows: a
      // proven merge outranks it (above), and pairing its code with the
      // eligibility's unrelated message would caption one fact with another.
      ...(merge === undefined && eligibility.reason?.message !== undefined
        ? { whyMessage: eligibility.reason.message }
        : {}),
      age: projected.age,
      touched: projected.touched,
    }
  })
}

/** Table sizes its viewport by ROW count, so a cell that wraps to a second
 * physical line evicts a row off the bottom without a word. Every custom cell
 * renderer in this table therefore carries the same single-line contract the
 * Table's own default cell has: shrinkable, capped at the track, truncating
 * rather than wrapping. The live specimen is 22376 — two `already-landed`
 * labels one cell too wide for the STATE track hid the two NEWEST PRs. */
function ChangeStateValue({ row }: { row: ChangeListRow }) {
  const variant = statusVariant(row.state)
  return (
    <Text bold color={variant === "default" ? "$fg" : `$fg-${variant}`} minWidth={0} maxWidth="100%" wrap="truncate">
      {row.stateLabel}
    </Text>
  )
}

export function ChangeListView({
  rows,
  columns: terminalColumns,
  window: listWindow,
}: {
  rows: readonly ChangeListRow[]
  columns: number
  window?: ChangeListWindow
}) {
  const base: TableColumn<ChangeListRow> = { header: "BASE", key: "target", minWidth: 6, maxWidth: 14 }
  const submitter: TableColumn<ChangeListRow> = { header: "BY", key: "submitter", minWidth: 4, maxWidth: 10 }
  const ageColumn: TableColumn<ChangeListRow> = { header: "AGE", key: "age", minWidth: 5, maxWidth: 7 }
  const changed: TableColumn<ChangeListRow> = { header: "CHANGED", key: "touched", minWidth: 9, maxWidth: 9 }
  const changeWidth = Math.min(
    16,
    rows.reduce((width, row) => Math.max(width, formatQueueChangeId(row.pr, row.revision).length + 2), 8),
  )
  // Track padding is 2, so a label needs label.length + 2 of track before the
  // Table's own cell would have to cut it. Sizing from the widest label present
  // keeps every state readable in full; the truncation contract in ChangeStateValue
  // is the guarantee, not the plan.
  const stateWidth = Math.min(
    20,
    rows.reduce((width, row) => Math.max(width, row.stateLabel.length + 2), 15),
  )
  // WHY holds typed reason codes. It keeps its historical 18 unless a row
  // carries a longer code — a reconciled merge does — and never exceeds 25.
  const whyWidth = Math.min(
    25,
    rows.reduce((width, row) => Math.max(width, row.why.length + 2), 18),
  )
  const columns: TableColumn<ChangeListRow>[] = [
    {
      header: "PR",
      key: "pr",
      minWidth: changeWidth,
      maxWidth: 16,
      render: (row: ChangeListRow) => <QueueChangeId pr={row.pr} revision={row.revision} wrap="truncate" />,
    },
    {
      header: "STATE",
      key: "stateLabel",
      minWidth: stateWidth,
      maxWidth: stateWidth,
      render: (row: ChangeListRow) => <ChangeStateValue row={row} />,
    },
    { header: "HISTORY", key: "lineage", minWidth: 8, maxWidth: 10 },
    ...(terminalColumns >= 110 ? [submitter] : []),
    { header: "SUBJECT", key: "subject", minWidth: 9, maxWidth: 26, grow: true },
    ...(terminalColumns >= 100 ? [base] : []),
    { header: "REVIEW", key: "review", minWidth: 8, maxWidth: 8 },
    { header: "CHECKS", key: "checks", minWidth: 8, maxWidth: 8 },
    {
      header: "WHY",
      key: "why",
      minWidth: 5,
      maxWidth: whyWidth,
      grow: true,
      // The code token, then whatever of the human message fits — same
      // single-line truncation contract as ChangeStateValue above. Width
      // policy stays computed from the CODE alone.
      render: (row: ChangeListRow) => (
        <Text minWidth={0} maxWidth="100%" wrap="truncate">
          {row.why}
          {row.whyMessage === undefined ? "" : <Text color="$fg-muted"> {row.whyMessage}</Text>}
        </Text>
      ),
    },
    ...(terminalColumns >= 110 ? [ageColumn] : []),
    ...(terminalColumns >= 120 ? [changed] : []),
  ]
  const hidden = listWindow === undefined || listWindow.hidden <= 0 ? undefined : listWindow
  return (
    <Box flexDirection="column">
      <Table data={rows} columns={columns} />
      {hidden === undefined ? null : (
        <Text color="$fg-muted">
          {`${hidden.hidden} of ${hidden.total} rows hidden by the default window; the ${rows.length} newest are shown` +
            ` — scope it (--base/--state/--issue) or use --json for all ${hidden.total}.`}
        </Text>
      )}
    </Box>
  )
}

export function ChangeChecksView({
  records,
  now = Date.now(),
}: {
  records: readonly ChangeCheckViewRecord[]
  now?: number
}) {
  const data = records.map((record) => {
    const taskStatus = checkTaskStatusOf(record)
    return {
      pr: record.pr,
      revision: record.revision,
      check: record.step ?? (record.position === undefined ? "-" : `queue #${record.position}`),
      state: record.status,
      ...taskStatusFields(taskStatus),
      classification: record.classification ?? "-",
      age:
        record.queuedAt === undefined || !Number.isFinite(Date.parse(record.queuedAt))
          ? "-"
          : formatDuration(Math.max(0, now - Date.parse(record.queuedAt))),
      command: singleQueue(record.command?.join(" ") ?? "-"),
      diagnostic: checkDiagnosticText(record.diagnostics ?? record.error?.message),
      artifact: record.artifact,
    }
  })
  return (
    <Box flexDirection="column">
      <Table
        data={data}
        columns={[
          { header: "PR", key: "pr", render: (row) => <QueueChangeId pr={row.pr} revision={row.revision} /> },
          { header: "CHECK", key: "check" },
          {
            header: "STATE",
            key: "state",
            render: (row) => <TaskStatusValue taskStatus={row.taskStatus} value={row.state} />,
          },
          { header: "CLASS", key: "classification" },
          { header: "AGE", key: "age" },
          { header: "COMMAND", key: "command", maxWidth: 40 },
          { header: "DIAGNOSTIC", key: "diagnostic", minWidth: 24, grow: true },
          {
            header: "ARTIFACT",
            key: "artifact",
            maxWidth: 40,
            render: (row) =>
              row.artifact === undefined ? (
                <Text>-</Text>
              ) : (
                <CellLink href={explicitArtifactHref(row.artifact)}>{row.artifact}</CellLink>
              ),
          },
        ]}
      />
      {data
        .filter((row) => row.state === "failed")
        .map((row) => (
          <Text key={`${row.pr}:${row.revision}:${row.check}`}>
            {`FAIL ${formatQueueChangeId(row.pr, row.revision)} ${row.check} COMMAND ${row.command} DIAGNOSTIC ${row.diagnostic}${row.artifact === undefined ? "" : ` ARTIFACT ${row.artifact}`}`}
          </Text>
        ))}
    </Box>
  )
}

export function ChangeResultView({
  prs,
  runs,
  checks,
  eligibilities,
  now,
  columns,
}: {
  prs: readonly Change[]
  runs: readonly Run[]
  checks?: readonly ChangeCheckViewRecord[]
  eligibilities?: readonly ChangeEligibility[]
  now?: number
  /** Terminal width, when known — forwarded so narrow tables can drop WHY. */
  columns?: number
}) {
  return (
    <Box flexDirection="column">
      <ChangeStatusView prs={prs} eligibilities={eligibilities} columns={columns} />
      {checks === undefined && runs.length > 0 && (
        <Box marginTop={1}>
          <QueueRunsView runs={runs} />
        </Box>
      )}
      {checks !== undefined && (
        <Box marginTop={1}>
          <ChangeChecksView records={checks} now={now} />
        </Box>
      )}
    </Box>
  )
}

export type ChangeDetailData = Readonly<{
  pr: Change
  runs: readonly QueueShowData[]
  run?: QueueShowData
}>

export function ChangeDetailData(
  pr: Change,
  runs: readonly Run[],
  attempts: readonly QueueAttempt[] = [],
): ChangeDetailData {
  const matchingRuns = runs.filter((run) => run.prs.some((member) => member.id === pr.id))
  const details = matchingRuns.map((run) => queueShowData(run, matchingRuns, attempts))
  const latest = latestChangeRun(pr, matchingRuns)
  const run = latest === undefined ? undefined : details.find((detail) => detail.run === latest.id)
  return { pr, runs: details, ...(run === undefined ? {} : { run }) }
}

function diagnosticBlocker(
  pr: Change,
  run: Run | undefined,
  step: QueueStep | undefined,
  now: number,
): string | undefined {
  const job = step?.job
  if (job?.status === "completed" && job.conclusion === "failure") {
    return actionableFailureSummary(actionableFailure(job.error))
  }
  if (job?.status === "completed" && job.conclusion === "timed_out") {
    return actionableFailureSummary(actionableFailure({ code: "job-lost", message: job.lostReason }))
  }
  if (job?.status === "completed" && job.conclusion === "cancelled") {
    return actionableFailureSummary(actionableFailure({ code: "job-canceled", message: job.cancelReason }))
  }
  if (job?.status === "in_progress") {
    const leaseExpiresAt = Date.parse(job.leaseExpiresAt)
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now) {
      return actionableFailureSummary(
        actionableFailure({
          code: "job-lease-expired",
          message: `${job.leaseExpiresAt} (${formatDuration(now - leaseExpiresAt)} ago)`,
        }),
      )
    }
  }
  if (job?.status === "waiting") return `waiting: ${singleQueue(job.detail ?? job.url ?? job.token)}`
  if (run?.error !== undefined) return actionableFailureSummary(actionableFailure(run.error))
  if (pr.detail !== undefined) return singleQueue(pr.detail)
  return undefined
}

export function ChangeDetailView({
  pr,
  liveSource,
  eligibility,
  runs,
  attempts = [],
  now,
  position,
}: {
  pr: Change
  liveSource?: Readonly<{ head: string }>
  eligibility?: ChangeEligibility
  runs: readonly Run[]
  attempts?: readonly QueueAttempt[]
  now: number
  position?: number
}) {
  const run = latestChangeRun(pr, runs)
  const runMember = run?.prs.find((member) => member.id === pr.id)
  // The newest run for this change may have executed against a now-superseded
  // revision (e.g. rev 1 was rejected while rev 2 sits pending with no run of
  // its own). Presenting that historical run as the change's current state reads as
  // "this pending item already failed", so it is scoped to a history block and
  // the current revision's real state is stated above it (user-reported
  // 2026-07-16). A superseded run implies the current revision has no run yet:
  // any run against it would sort newer and be selected here instead.
  const revision = currentChangeRev(pr)
  const delivery = changeDeliveryState(pr)
  const supersededRunRevision =
    run !== undefined && runMember !== undefined && runMember.revision !== revision.n ? runMember.revision : undefined
  const currentStateWord = delivery === "submitted" ? "pending" : delivery
  const activeStep = relevantStep(run)
  const blocker = diagnosticBlocker(pr, run, activeStep, now)
  const merge = pr.integration ?? (run === undefined ? undefined : queueIntegration(run))
  const detail = ChangeDetailData(pr, runs, attempts)
  const lineage = timelineRevisionLineage(pr)
  const revisionLineage = lineage.revisions.map((revision) => `rev${revision}`).join("→")
  const recomposedSources = changeRevisionLineage(pr).flatMap((candidate) => candidate.recut?.sources ?? [])
  const taskStatus = changeTaskStatusOf(pr)
  const projectionFields = taskStatusFields(taskStatus)

  return (
    <Box flexDirection="column">
      <Text>
        <QueueChangeId pr={pr.id} revision={revision.n} /> <Text bold>STATUS</Text> <StatusValue value={delivery} />{" "}
        <TaskStatusGlyph taskStatus={projectionFields.taskStatus} />
        {position === undefined ? null : ` POSITION ${position}`}
      </Text>
      {eligibility?.reason?.code === "needs-author" ? (
        <Text wrap="wrap">
          <Text bold>NEEDS AUTHOR</Text> {eligibility.reason.message}
        </Text>
      ) : null}
      {pr.title === undefined ? null : (
        <Text wrap="truncate" bgConflict="ignore">
          <Text bold>TITLE</Text> {pr.title}
        </Text>
      )}
      {liveSource === undefined ? (
        <Text>
          <Text bold>FROZEN SOURCE</Text> <Text color={BRANCH_ICON_COLOR}>{BRANCH_ICON}</Text> {pr.branch}{" "}
          <Text bold>REV {revision.n} HEAD</Text> {revision.head}
        </Text>
      ) : (
        <>
          <Text>
            <Text bold>SOURCE</Text> <Text color={BRANCH_ICON_COLOR}>{BRANCH_ICON}</Text> {pr.branch}{" "}
            <Text bold>LIVE HEAD</Text> {liveSource.head}
          </Text>
          <Text>
            <Text bold>FROZEN REV {revision.n}</Text> <Text bold>HEAD</Text> {revision.head}
          </Text>
          {liveSource.head === revision.head ? null : (
            <Text wrap="wrap">
              <Text bold>BRANCH MOVED</Text> — live branch differs from frozen rev {revision.n}; re-merge before review
            </Text>
          )}
        </>
      )}
      <Text>
        <Text bold>BASE</Text> {pr.base}
        {revision.baseSha === undefined ? null : `@${revision.baseSha}`}
      </Text>
      {pr.issue === undefined ? null : (
        <Text wrap="truncate">
          <Text bold>ISSUE</Text> <IssueValue issue={pr.issue} />
        </Text>
      )}
      <Text>
        <Text bold>SOURCE READY</Text> {lineage.sourceReadyAt ?? "-"} <Text bold>HISTORY</Text> {revisionLineage}
      </Text>
      {recomposedSources.length === 0 ? null : (
        <Text wrap="wrap">
          <Text bold>RECOMPOSED</Text> {collapseRecomposedSources(recomposedSources).join(" · ")}
        </Text>
      )}
      {pr.description === undefined ? null : (
        <Box flexDirection="column" minWidth={0}>
          <Text bold>DESCRIPTION</Text>
          <DescriptionBlock description={pr.description} />
        </Box>
      )}
      {supersededRunRevision === undefined ? null : (
        <Text>
          <Text bold>CURRENT rev {revision.n}</Text> — {currentStateWord}, no run yet
        </Text>
      )}
      {detail.run === undefined ? null : (
        <QueueShowView
          data={detail.run}
          compact
          highlightPr={pr.id}
          {...(supersededRunRevision === undefined ? {} : { historyRevision: supersededRunRevision })}
          {...(supersededRunRevision === undefined && eligibility?.reason?.code === "needs-author"
            ? { nextAction: "fix the branch and push; the same PR resumes automatically" }
            : {})}
        />
      )}
      {blocker === undefined ? null : (
        <Text color={supersededRunRevision === undefined ? "$fg-warning" : "$fg-muted"}>
          <Text bold>BLOCKER</Text>
          {supersededRunRevision === undefined ? "" : ` (rev ${supersededRunRevision})`} {blocker}
        </Text>
      )}
      {detail.run === undefined && merge !== undefined ? (
        <Text>
          <Text bold>MERGE</Text> {merge.commit === merge.baseSha ? merge.commit : `${merge.commit}@${merge.baseSha}`}
        </Text>
      ) : null}
    </Box>
  )
}

export function queueStatusRows(
  state: BaysState,
  result: QueueStatusResult,
  selected: ReadonlySet<string>,
  now: number,
): Row[] {
  return projectedChangeRows(state, result, now).filter(
    (row) =>
      selected.has(row.pr) ||
      (row.nativeStatus !== "integrated" && row.nativeStatus !== "already-landed" && row.nativeStatus !== "withdrawn"),
  )
}

function SummaryQueue({ projection, repositoryRoot }: { projection: HumanQueueProjection; repositoryRoot?: string }) {
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} minWidth={0}>
      <Text wrap="truncate">
        <Text bold>QUEUE</Text> {projection.target}
      </Text>
      <QueueRepositoryRoot root={repositoryRoot} />
      <Text wrap="truncate">
        <Text bold>OPEN</Text> {projection.open} <Text bold>ACTIVE</Text> {projection.activeCount}{" "}
        <Text bold>INTEGRATED</Text> {projection.integrated} <Text bold>REJECTED</Text> {projection.rejected}
        {projection.alreadyMerged === 0 ? null : (
          <>
            {" "}
            <Text bold>ALREADY-MERGED</Text> {projection.alreadyMerged}
          </>
        )}
        {projection.needsAuthor === 0 ? null : (
          <>
            {" "}
            <Text bold>NEEDS-AUTHOR</Text> {projection.needsAuthor}
          </>
        )}{" "}
        <Text bold>DRAIN</Text> {projection.oldestOpen}
      </Text>
    </Box>
  )
}

export function QueueListView({ results, now }: { results: readonly QueueStatusResult[]; now: number }) {
  return (
    <Box flexDirection="column">
      {results.map((result) => (
        <SummaryQueue key={result.base} projection={humanQueueProjection(result, now)} />
      ))}
    </Box>
  )
}

function ActiveQueue({ active }: { active: WatchActiveRow }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        <Text bold>ACTIVE RUN </Text>
        <RunId base={active.base} run={active.run} /> <QueueChangeId pr={active.pr} revision={active.revision} />{" "}
        {active.subject} <TaskStatusGlyph taskStatus={active.taskStatus} /> {active.steps} {active.elapsed}
      </Text>
    </Box>
  )
}

function ProjectedChangeQueue({ row, position }: { row: HumanChangeProjection; position?: number }) {
  return (
    <Box height={1}>
      <Text wrap="truncate">
        {position === undefined ? "" : `${position}. `}
        <TaskStatusGlyph taskStatus={row.taskStatus} />{" "}
        {row.changeHref === undefined ? (
          <QueueChangeId pr={row.pr} revision={row.revision} />
        ) : (
          <Link href={row.changeHref}>
            <QueueChangeId pr={row.pr} revision={row.revision} />
          </Link>
        )}{" "}
        {row.candidateId === undefined ? null : (
          <>
            {"→ "}
            <Text bold>{`CANDIDATE ${row.candidateId}`}</Text>{" "}
          </>
        )}
        {row.runId === undefined ? null : (
          <>
            {"→ RUN "}
            <RunId base={row.target} run={row.runId} />{" "}
          </>
        )}
        {row.subject} <StatusValue value={row.state} href={row.log} /> age={row.age}
      </Text>
    </Box>
  )
}

function FailureQueues({ failure }: { failure: HumanFailureProjection }) {
  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text wrap="truncate"> {failure.summary}</Text>
      </Box>
      {failure.evidence === undefined ? null : (
        <Box height={1}>
          <Text wrap="truncate">
            {"    evidence: "}
            {failure.evidence.href === undefined ? (
              failure.evidence.text
            ) : (
              <CellLink href={failure.evidence.href}>{failure.evidence.text}</CellLink>
            )}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function ActionableFailureView({ failure }: { failure: ActionableFailure }) {
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text color="$fg-error" wrap="wrap">
        ERROR {errorCodeLabel(failure.code)}
      </Text>
      <Text wrap="wrap">CAUSE {failure.cause}</Text>
      {failure.resolution.map((step, index) => (
        <Text key={`${failure.code}:resolution:${index}`} wrap="wrap">
          RESOLVE {step}
        </Text>
      ))}
      {failure.escalation === undefined ? null : (
        <>
          <Text color="$fg-error" wrap="wrap">
            ESCALATE {failure.escalation.reason}
          </Text>
          {failure.escalation.steps.map((step, index) => (
            <Text key={`${failure.code}:escalation:${index}`} wrap="wrap">
              MANUAL {step}
            </Text>
          ))}
        </>
      )}
      {failure.reference === undefined ? null : <Text wrap="wrap">REFERENCE {failure.reference}</Text>}
    </Box>
  )
}

function ProjectionRows({
  projection,
  queueHeading = "QUEUE",
}: {
  projection: HumanQueueProjection
  queueHeading?: string
}) {
  return (
    <Box flexDirection="column">
      {projection.queue.length === 0 ? null : (
        <>
          <Box height={1}>
            <Text bold>{queueHeading}</Text>
          </Box>
          {projection.queue.map((row) => (
            <ProjectedChangeQueue key={row.pr} row={row} position={row.position} />
          ))}
          {projection.queueOverflow === 0 ? null : (
            <Box height={1}>
              <Text color="$fg-muted">... {projection.queueOverflow} more runnable</Text>
            </Box>
          )}
        </>
      )}
      {projection.recent.length === 0 ? null : (
        <>
          <Box height={1}>
            <Text bold>
              {projection.recent.some((row) => row.failure !== undefined) ? "Recent failures" : "Recent results"}
            </Text>
          </Box>
          {projection.recent.map((row, index) => (
            <Box key={`${row.pr}:${row.runId ?? index}`} flexDirection="column">
              <ProjectedChangeQueue row={row} />
              {row.failure === undefined ? null : <FailureQueues failure={row.failure} />}
            </Box>
          ))}
        </>
      )}
      {projection.queue.length === 0 && projection.recent.length === 0 ? (
        <Box height={1}>
          <Text color="$fg-muted">No runnable or recent failed PRs.</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function QueueStatusView({
  state,
  results,
  selected,
  now,
}: {
  state: BaysState
  results: readonly QueueStatusResult[]
  selected: ReadonlySet<string>
  now: number
}) {
  return (
    <Box flexDirection="column">
      {results.map((result, index) => {
        const projection = humanQueueProjection(result, now, { selected, state })
        const pauseHealth = projection.pause === undefined ? undefined : queuePauseHealth(state, projection.pause)
        const allowed = projection.pause === undefined ? "none" : queuePauseAllowedText(projection.pause, pauseHealth)
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <SummaryQueue projection={projection} />
            {projection.pause !== undefined && (
              <Box height={1}>
                <Text wrap="truncate">
                  <Text color={pauseHealth?.blocksAll === true ? "$fg-error" : "$fg-warning"} bold>
                    {pauseHealth?.blocksAll === true ? "⚠ PAUSE BLOCKING EVERYTHING" : "PAUSE"}
                  </Text>
                  {pauseHealth?.blocksAll === true
                    ? ` — ${projection.pause.reason} (allowed: ${allowed})`
                    : `: ${projection.pause.reason} (allowed: ${allowed})`}
                </Text>
              </Box>
            )}
            {projection.active === undefined ? null : <ActiveQueue active={projection.active} />}
            <ProjectionRows projection={projection} />
          </Box>
        )
      })}
    </Box>
  )
}

export type WatchQueueRow = Readonly<{
  pos: number
  pr: string
  subject: string
  taskStatus: TaskStatus
  state: string
  step: string
  age: string
  touched: string
  run: string
  result: string
}>

export function watchQueueRows(result: QueueStatusResult, now: number): WatchQueueRow[] {
  return humanQueueProjection(result, now).queue.map((row) => ({
    pos: row.position,
    pr: row.pr,
    subject: row.subject,
    taskStatus: row.taskStatus,
    state: row.state,
    step: row.step,
    age: row.age,
    touched: row.touched,
    run: row.run,
    result: row.result,
  }))
}

export type WatchActiveRow = Readonly<{
  base: string
  run: string
  pr: string
  revision: number
  subject: string
  step: string
  steps: string
  status: Run["status"]
  taskStatus: TaskStatus
  elapsed: string
}>

export function activeWatchRow(
  result: QueueStatusResult,
  now: number,
  selected: ReadonlySet<string> = new Set<string>(),
): WatchActiveRow | undefined {
  const run = [...result.running, ...result.waiting]
    .filter((candidate) => selected.size === 0 || candidate.prs.some((member) => selected.has(member.id)))
    .toSorted(byRunStarted)
    .at(0)
  if (run === undefined) return undefined
  const member = run.prs.find((candidate) => selected.size === 0 || selected.has(candidate.id))
  if (member === undefined) return undefined
  const pr = result.prs.find((candidate) => candidate.id === member.id)
  const step = relevantStep(run) ?? run.steps.at(0)
  const taskStatus = runTaskStatusOf(run)
  return {
    base: run.base,
    run: run.id,
    pr: member.id,
    revision: member.revision,
    // Record enrichment first, then the member snapshot's own name/branch — a
    // recordless (derived) member must fall back to snapshot identity, never
    // silently to a bare id (NSE-2).
    subject: boundedQueue(pr?.title ?? pr?.name ?? member.name ?? member.branch, 80),
    step: step?.name ?? "-",
    steps: queueRunSteps(run),
    status: run.status,
    ...taskStatusFields(taskStatus),
    elapsed: age(run.startedAt, now, `run '${run.id}' elapsed`),
  }
}

export function QueueWatchView({
  results,
  now,
  pr,
}: {
  results: readonly QueueStatusResult[]
  now: number
  pr?: string
}) {
  if (pr !== undefined) {
    const selected = results
      .flatMap((result) =>
        result.prs.map((candidate) => ({
          pr: candidate,
          eligibility: eligibilityForCurrentRevision(result, candidate),
        })),
      )
      .find(({ pr: candidate }) => candidate.id === pr)
    const runs = [
      ...new Map(
        results
          .flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
          .map((run) => [run.id, run] as const),
      ).values(),
    ]
    if (selected === undefined) {
      // The record store is only ONE of the two populations a selector can
      // live in — a derived member exists solely as a retained run snapshot,
      // and a miss that says "no change" about one trains the reader to
      // distrust the surface (NSE-3). Name what was searched, always.
      const memberRun = runs.find((run) =>
        run.prs.some((member) => member.id === pr || member.branch === pr),
      )
      if (memberRun !== undefined) {
        return (
          <Text color="$fg-muted">
            Change '{pr}' has no retained record — it rides run {memberRun.id} as a derived member. Its truth lives
            in the run rows: yrd queue show {memberRun.id}.
          </Text>
        )
      }
      const recordCount = results.reduce((count, result) => count + result.prs.length, 0)
      const memberCount = runs.reduce((count, run) => count + run.prs.length, 0)
      return (
        <Text color="$fg-muted">
          No change '{pr}' — searched {recordCount} retained records and {memberCount} retained run members (live
          facts surface as run members once composed).
        </Text>
      )
    }
    return <ChangeDetailView pr={selected.pr} eligibility={selected.eligibility} runs={runs} now={now} />
  }

  return (
    <Box flexDirection="column">
      {results.map((result, index) => {
        const projection = humanQueueProjection(result, now)
        const pauseState = projection.pause === undefined ? "active" : `paused: ${projection.pause.reason}`
        return (
          <Box key={result.base} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <SummaryQueue projection={projection} />
            <Box height={1}>
              <Text wrap="truncate">
                <Text bold>PAUSE</Text> {pauseState} <Text bold>DRAIN</Text> {projection.oldestOpen}
              </Text>
            </Box>
            {projection.active === undefined ? null : <ActiveQueue active={projection.active} />}
            <ProjectionRows projection={projection} queueHeading="QUEUE POS" />
          </Box>
        )
      })}
    </Box>
  )
}
/**
 * Powerline branch glyph (U+E0A0), prefixed on every rendered branch name in
 * the watch UI (user directive 2026-07-16), matching ag-code's `BRANCH_ICON`.
 */
const BRANCH_ICON = TIMELINE_BRANCH_ICON

function timelineRunCellModel(
  row: QueueTimelineProjectedRow,
  runLabels: ReadonlyMap<string, string>,
  showQueueLabel: boolean,
  continuesRun: boolean,
): TimelineRunCellModel {
  if (row.run === undefined) return { kind: "none" }
  if (continuesRun) return { kind: "continuation" }
  const label = showQueueLabel ? (runLabels.get(row.base) ?? row.base) : ""
  // No state glyph here: the STATUS cell already renders this row's status as
  // icon+text, and repeating the icon alone made every run row say its status
  // twice (operator, 2026-08-25 — supersedes item 38's glyph clause).
  return { kind: "run", label, number: `#${runIdValue(row.run)}` }
}

/** Config-handle (or base) run label per base, from the projection's queues (item 36). */
function timelineRunLabels(queues: readonly QueueTimelineQueue[]): ReadonlyMap<string, string> {
  return new Map(queues.map((queue) => [queue.base, queueRunLabel(queue)]))
}

/** Adjacent rows sharing one run id are that run's batch members in display
 * order; only strict adjacency counts, so an interleaved row restarts the
 * bright id (item 38). */
function timelineRunContinues(
  row: QueueTimelineProjectedRow,
  previous: QueueTimelineProjectedRow | undefined,
): boolean {
  return row.run !== undefined && previous !== undefined && previous.run === row.run && previous.base === row.base
}

/**
 * The RUN region's identity + timing block. It stays above the tab strip for
 * every active tab, so the operator never has to leave the failing output to
 * recover which run and clocks they are looking at.
 */
function queueDetailRunTimingRows(data: QueueShowData, row: QueueTimelineProjectedRow | undefined): readonly string[] {
  const startedAt = presentFact(data.started)
  const finishedAt = presentFact(data.finished)
  const queueWaitMs = row?.queueWaitMs ?? null
  const startedMs = startedAt === undefined ? Number.NaN : Date.parse(startedAt)
  const admittedAt =
    queueWaitMs === null || !Number.isFinite(startedMs) ? undefined : new Date(startedMs - queueWaitMs).toISOString()
  const clocks = [
    ...(admittedAt === undefined ? [] : [`Submitted ${queueLogClock(admittedAt, false, false)}`]),
    ...(startedAt === undefined ? [] : [`Started ${queueLogClock(startedAt, false, false)}`]),
    ...(finishedAt === undefined ? [] : [`Completed ${queueLogClock(finishedAt, false, false)}`]),
  ]
  const runtimeMs = row?.totalMs ?? data.totalDurationMs
  const metrics = [
    ...(row?.ageMs === null || row?.ageMs === undefined ? [] : [`Age ${mediaDuration(row.ageMs)}`]),
    ...(runtimeMs === null || runtimeMs === undefined ? [] : [`Runtime ${mediaDuration(runtimeMs)}`]),
    ...(queueWaitMs === null ? [] : [`Wait time ${mediaDuration(queueWaitMs)}`]),
  ]
  // The metrics line is the operator's exact composite-header sample (Age ·
  // Runtime · Wait time); the clocks line above it keeps its historical
  // comma join — no sample specifies it, and `watch-detail-rework.test.ts`
  // only pins the substring "Started ", not a separator.
  return [...(clocks.length === 0 ? [] : [clocks.join(", ")]), ...(metrics.length === 0 ? [] : [metrics.join(" · ")])]
}

export type StatusNoticeState = StatusPresentationState

export type StatusNotice = Readonly<{
  state: StatusNoticeState
  glyph: string
  color: StatusPresentationColor
  headline: string
  explanation: string
  auto: Readonly<{
    kind: "requeue" | "recut" | "retry" | "none"
    when: string
  }>
  owner?: "author" | "ci" | "queue"
}>

function statusNoticeFailure(
  row: QueueTimelineProjectedRow | undefined,
  data: QueueShowData | undefined,
): HumanFailureProjection | undefined {
  return (
    data?.failure ??
    data?.steps.findLast((step) => step.failure !== undefined)?.failure ??
    (row?.failure === undefined ? undefined : projectFailure(row.failure))
  )
}

function noticeState(
  row: QueueTimelineProjectedRow | undefined,
  data: QueueShowData | undefined,
  failureState: FailureDisposition["state"] | undefined,
): StatusNoticeState | undefined {
  if (data !== undefined) {
    if (data.status === "completed" && data.conclusion === "success") {
      // Non-merge success is "passed", never "done" (21801).
      return data.integration === undefined ? "passed" : "integrated"
    }
    if (data.status === "completed" && data.conclusion === "failure") return failureState ?? "failed"
    if (data.status === "completed" && data.conclusion === "timed_out") return "timeout"
    if (data.status === "completed" && (data.conclusion === "cancelled" || data.conclusion === "skipped")) {
      return "canceled"
    }
    if (data.status === "in_progress") return "running"
    return statusPresentationState(data.status)
  }
  if (row === undefined) return undefined
  if (row.status === "rejected" && failureState !== undefined) return failureState
  return statusPresentationState(row.status)
}

function noticeHeadline(
  state: StatusNoticeState,
  row: QueueTimelineProjectedRow | undefined,
  data: QueueShowData | undefined,
): string {
  if (data?.status === "completed" && data.conclusion === "failure") {
    if (state === "failed" && (data.outcome === "rejected" || row?.status === "rejected")) {
      return "failed, rejected"
    }
    return state === "failed" ? "failed" : `failed, ${state}`
  }
  // `integrated` and `already-landed` both print as "merged"; the parenthetical
  // keeps the already-on-main case distinguishable without a second state word.
  if (state === "integrated") {
    const label =
      data?.outcome === "already-landed" || row?.status === "already-landed" ? "merged (already on main)" : "merged"
    return data?.status === "completed" && data.conclusion === "success" ? `passed, ${label}` : label
  }
  // No Run drives this row (the pre-run band draft/rev/ready, or a terminal
  // row whose Run detail happens to be unavailable): read the exact word
  // `timelineStatusCell` gives the list's STATUS column for this row, rather
  // than falling through to the coarser `state` below — that fallback is the
  // one-status-not-two bug (a submitted-awaiting-run "ready" row printed
  // "queued" here). Every `data !== undefined` case is handled above or in
  // the state checks that follow, so this never overrides a Run-driven
  // headline.
  if (data === undefined && row !== undefined) {
    const word = timelineStatusCell(row).word
    // The queue position is a LIVE fact and the status box is its single
    // home (operator ruling 2026-08-18, item 31): `queued #1` joins the
    // headline rather than riding a metadata row.
    if (word === "queued" && row.position !== undefined) return `queued #${row.position}`
    return word
  }
  if (state === "running") return "checking"
  if (state === "rejected") return "failed"
  if (state === "needs-author") return "needs author"
  return state
}

function noticeArtifact(data: QueueShowData | undefined): string | undefined {
  const entry = data?.steps.findLast((step) => step.failure !== undefined || step.errorCode !== "-")?.locations[0]
  if (entry === undefined) return undefined
  return entry.display ?? ("path" in entry.location ? entry.location.path : entry.location.url)
}

function noticeAutomation(state: StatusNoticeState): StatusNotice["auto"] {
  if (state === "queued") return { kind: "retry", when: "when queue capacity is available" }
  if (state === "env" || state === "timeout") return { kind: "requeue", when: "on the next queue pass" }
  return { kind: "none", when: "no automatic action is scheduled" }
}

function runningStepName(
  row: QueueTimelineProjectedRow | undefined,
  data: QueueShowData | undefined,
): string | undefined {
  return (
    data?.steps.findLast((candidate) => candidate.status === "running" || candidate.status === "waiting")?.step ??
    row?.step?.replace(/^\d+:/u, "")
  )
}

function historicalStepP50Ms(
  step: string | undefined,
  currentRun: string | undefined,
  runDetails: readonly QueueShowData[],
): number | null {
  if (step === undefined) return null
  const durations = runDetails
    .filter((detail) => detail.run !== currentRun)
    .flatMap((detail) =>
      detail.steps.flatMap((candidate) =>
        candidate.step === step &&
        candidate.durationMs !== undefined &&
        !["requested", "running", "waiting"].includes(candidate.status)
          ? [candidate.durationMs]
          : [],
      ),
    )
    .toSorted((left, right) => left - right)
  return numericDistribution(durations, `historical '${step}' duration`).p50
}

function noticeExplanation(
  state: StatusNoticeState,
  row: QueueTimelineProjectedRow | undefined,
  data: QueueShowData | undefined,
  failure: HumanFailureProjection | undefined,
  stepP50Ms: number | null,
): string {
  const failureSummary = failure?.summary
  if (state === "queued") {
    const position = row?.position === undefined ? "" : ` at position ${row.position}`
    return `Queued${position}; starts automatically when queue capacity is available.`
  }
  if (state === "running") {
    const step = runningStepName(row, data)
    const elapsedMs = row?.totalMs ?? data?.totalDurationMs
    const timing = [
      ...(elapsedMs === undefined || elapsedMs === null ? [] : [`${mediaDuration(elapsedMs)} elapsed`]),
      stepP50Ms === null ? "step p50 unavailable" : `step p50 ${mediaDuration(stepP50Ms)}`,
    ]
    return `${step === undefined ? "Run" : `Step ${step}`} is running (${timing.join("; ")}).`
  }
  if (state === "integrated") {
    const merge = presentFact(data?.merge)
    const completed = presentFact(data?.finished)
    return `Integrated${merge === undefined ? "" : ` as ${queueMergeLabel(merge)}`}${
      completed === undefined ? "" : ` at ${detailClock(completed)}`
    }.`
  }
  if (state === "done") return "Run completed; no automatic action remains."
  if (state === "env") {
    return `${failureSummary === undefined ? "" : `${failureSummary}. `}Infrastructure fault; the candidate is innocent. Automatically requeued on the next queue pass.`
  }
  if (state === "stale") {
    const prefix = failureSummary === undefined ? "" : `${failureSummary}. `
    if (failure?.code === "stale-base") {
      return `${prefix}The base advanced after this revision requested required checks. Automatically re-merged and requeued on the next queue pass.`
    }
    if (failure?.code === "stale-check") {
      return `${prefix}The checked candidate changed after its required checks. Automatically requeued for fresh checks on the next queue pass.`
    }
    if (failure?.code === "stale-steps") {
      return `${prefix}The installed check configuration changed after this run passed its checks. Automatically requeued under the installed checks on the next queue pass.`
    }
    if (failure?.code === "stale-plan") {
      return `${prefix}The recorded run plan changed after this batch began required checks. Automatically requeued under the installed plan on the next queue pass.`
    }
    if (failure?.code === "stale-pr") {
      return `${prefix}The change revision changed after this run was pinned. This historical run will not retry; follow the current revision's queue state.`
    }
    return `${prefix}This run is stale, but the journal does not name an automatic recovery. Follow the current PR revision's queue state.`
  }
  if (state === "timeout") {
    const elapsedMs = row?.totalMs ?? data?.totalDurationMs
    const elapsed = elapsedMs === undefined || elapsedMs === null ? "" : ` after ${mediaDuration(elapsedMs)}`
    return `${failureSummary === undefined ? "" : `${failureSummary}. `}The job lease expired${elapsed}. The journal does not distinguish a killed process, crash, or hang. The candidate is innocent and is automatically requeued on the next queue pass.`
  }
  if (state === "canceled") {
    return `${failureSummary === undefined ? "" : `${failureSummary}. `}The run was canceled; no further steps will run.`
  }
  if (state === "needs-author") {
    return `${failureSummary === undefined ? "" : `${failureSummary}. `}The author must repair the submitted source and resubmit; this is not retried automatically.`
  }
  if (state === "draft") return "Registered, not queued. The author must submit this revision when it is ready."
  if (state === "rejected") {
    return `${failureSummary === undefined ? "The change failed." : `${failureSummary}.`} The author must fix the branch and resubmit; this is not retried automatically.`
  }
  const artifact = noticeArtifact(data)
  return `${failureSummary === undefined ? "The run failed." : `${failureSummary}.`} This failure is not retried automatically; the author must fix the branch and resubmit.${
    artifact === undefined ? " Remedies are in the linked stderr/output log." : ` Remedies are in ${artifact}.`
  }`
}

/** Pure status notice projection derived from the already-materialized
 * queue/PR facts. It stores no journal state and never invents automation. */
export function queueStatusNotice(
  row: QueueTimelineProjectedRow | undefined,
  data: QueueShowData | undefined,
  context: Readonly<{ stepP50Ms?: number | null }> = {},
): StatusNotice | undefined {
  const failure = statusNoticeFailure(row, data)
  const disposition = failure === undefined ? undefined : failureDisposition(failure.code)
  const state = noticeState(row, data, disposition?.state)
  if (state === undefined) return undefined
  const presentation = statusPresentation(state)
  const automation = disposition?.automation
  const auto =
    automation === "auto-re-merge"
      ? ({ kind: "recut", when: "on the next queue pass" } as const)
      : automation === "auto-requeue"
        ? ({ kind: "requeue", when: "on the next queue pass" } as const)
        : noticeAutomation(state)
  const owner =
    disposition?.owner ??
    (state === "queued" || state === "running" || state === "env" || state === "timeout"
      ? "queue"
      : state === "failed" || state === "rejected" || state === "needs-author" || state === "draft"
        ? "author"
        : undefined)
  return {
    state,
    ...presentation,
    headline: noticeHeadline(state, row, data),
    explanation: noticeExplanation(state, row, data, failure, context.stepP50Ms ?? null),
    auto,
    ...(owner === undefined ? {} : { owner }),
  }
}

/**
 * ONE derivation for a run's step lines, shared by the status box (item 39)
 * and the workflow step tabs — the two surfaces can never drift. Each step
 * contributes its LAST attempt row (the tabs' own rule): glyph + name +
 * duration, an `active` flag for the ag-code pulse, and for failed steps the
 * severity color plus the remedy inline (failure summary, then the first
 * linked artifact as the evidence pointer).
 */
export type QueueRunStepFact = Readonly<{
  step: string
  status: string
  glyph: string
  color: StatusPresentationColor
  duration: string
  active: boolean
  failed: boolean
  remedy?: string
}>

export function queueRunStepFacts(data: Pick<QueueShowData, "steps">): readonly QueueRunStepFact[] {
  const names = [...new Set(data.steps.map((row) => row.step))]
  return names.flatMap((name) => {
    const rep = data.steps.filter((row) => row.step === name).at(-1)
    if (rep === undefined) return []
    const failed = rep.status === "failed" || rep.status === "lost" || rep.taskStatus === "blocked"
    const active = rep.status === "running" || rep.status === "waiting"
    const presentation = statusPresentation(rep.status)
    const evidence = rep.locations[0]
    const evidenceText =
      evidence === undefined
        ? undefined
        : (evidence.display ?? ("path" in evidence.location ? evidence.location.path : evidence.location.url))
    const remedy =
      !failed || rep.failure === undefined
        ? undefined
        : `${rep.failure.summary}${evidenceText === undefined ? "" : ` (${evidenceText})`}`
    return [
      {
        step: name,
        status: rep.status,
        glyph: presentation.glyph,
        color: presentation.color,
        duration: rep.duration === "-" ? "" : rep.duration,
        active,
        failed,
        ...(remedy === undefined ? {} : { remedy }),
      },
    ]
  })
}

export type QueueRunPresentation = Readonly<{
  kind: QueueRunPresentationKind
  /** Border identity, e.g. `RUN code#23423` (deploys would name their environment). */
  title: string
  steps: readonly QueueRunStepFact[]
}>

export function queueRunPresentation(
  data: Pick<QueueShowData, "steps" | "base" | "run">,
  runLabel?: string,
): QueueRunPresentation {
  return {
    kind: "integration",
    title: `RUN ${runLabel ?? data.base}#${runIdValue(data.run)}`,
    steps: queueRunStepFacts(data),
  }
}

/**
 * The detail pane's top status box (operator spec item 1): one TitledBox
 * integrating what were two separate elements — the RUN identity/timing
 * header and the status notice. The border carries no left title, only the
 * right-aligned `RUN base#run` identity, so the outline itself reads as the
 * run's label; the body carries the glyph+headline, the explanation, and
 * (when a Run drives this row) the Age/Runtime/Wait-time line. A pre-run row
 * (no Run yet) gets the same box with no right-aligned title and no timing
 * line — one template for pending, running, and terminal rows alike.
 */
export function QueueStatusNotice({
  row,
  data,
  runDetails = [],
  live = false,
  runLabel,
}: {
  row?: QueueTimelineProjectedRow
  data?: QueueShowData
  runDetails?: readonly QueueShowData[]
  live?: boolean
  /** The run's queue label (config handle, base fallback) for the border identity. */
  runLabel?: string
}) {
  const stepP50Ms = historicalStepP50Ms(runningStepName(row, data), data?.run, runDetails)
  const notice = queueStatusNotice(row, data, { stepP50Ms })
  if (notice === undefined) return null
  const timingRows = data === undefined ? [] : queueDetailRunTimingRows(data, row)
  const steps = data === undefined ? [] : queueRunStepFacts(data)
  // Identity on the border (item 39): `RUN <label>#N` — label-primary run
  // naming (item 36), the same `queueRunLabel` fallback the list cells use,
  // so the two surfaces can never drift onto different formats.
  const titleRight = data === undefined ? undefined : `RUN ${runLabel ?? data.base}#${runIdValue(data.run)}`
  const glyphNode =
    live && notice.state === "running" ? (
      <Pulse synchronized colors={[notice.color, "$fg-muted"]} intervalMs={AG_PULSE_INTERVAL_MS} bold flexShrink={0}>
        {notice.glyph}
      </Pulse>
    ) : (
      <Text bold color={notice.color} flexShrink={0}>
        {notice.glyph}
      </Text>
    )
  return (
    <TitledBox title="" {...(titleRight === undefined ? {} : { titleRight })} borderColor={notice.color}>
      {/* Hanging markers throughout (item 29a): the glyph sits in a 2-cell
          gutter and every body line — headline, explanation, clocks, step
          rows — aligns to ONE text column, wrapped text hanging off it. */}
      <MarkerRow marker={glyphNode}>
        <Text bold color={notice.color} wrap="wrap" minWidth={0}>
          {notice.headline}
        </Text>
      </MarkerRow>
      <MarkerRow>
        <Text color={notice.color} wrap="wrap" minWidth={0}>
          {notice.explanation}
        </Text>
      </MarkerRow>
      {timingRows.map((timing) => (
        <MarkerRow key={timing}>
          <Text wrap="truncate">{timing}</Text>
        </MarkerRow>
      ))}
      {/* One line per step (item 39): hanging glyph + name + duration; the
          active step pulses in the ag-code idiom; a failed step takes the
          box's severity color WITH its remedy inline. The same derivation
          feeds the workflow step tabs, so the two can never disagree. */}
      <RunStepLines steps={steps} live={live} />
    </TitledBox>
  )
}

/**
 * The kind-agnostic step-line skeleton (items 39 + 37m): one hanging-marker
 * line per step, active pulsing, failed severity-colored with the remedy
 * inline. It consumes {@link QueueRunStepFact}s and nothing else, so a
 * deployment-kind run renders its rollout phases through this exact
 * component with zero display-code changes — the run's KIND selects what
 * produces the facts, never how they draw.
 */
export function RunStepLines({ steps, live = false }: { steps: readonly QueueRunStepFact[]; live?: boolean }) {
  return (
    <>
      {steps.map((step) => (
        <MarkerRow
          key={step.step}
          marker={
            step.active ? (
              <ActivityPulse live={live}>{step.glyph}</ActivityPulse>
            ) : (
              <Text color={step.color}>{step.glyph}</Text>
            )
          }
        >
          <Text wrap="wrap" minWidth={0}>
            <Text color={step.failed ? step.color : step.active ? "$fg-info" : undefined}>{step.step}</Text>
            {step.duration === "" ? null : <Text color="$fg-muted"> {step.duration}</Text>}
            {step.remedy === undefined ? null : <Text color={step.color}> — {step.remedy}</Text>}
          </Text>
        </MarkerRow>
      ))}
    </>
  )
}

// Marker + state colors (15d screenshot re-rule): running pulses blue,
// success is GREEN semantic, pending is blue, failures keep semantic reds.
function timelineStatusColor(row: QueueTimelineProjectedRow): string {
  return statusPresentation(row.status).color
}

const TIMELINE_STATUS_WORDS = {
  draft: "draft",
  rev: "rev",
  ready: "ready",
  pending: "queued",
  running: "checking",
  integrated: "merged",
  "already-landed": "merged",
  // Non-merge success — never the word "merged" (21801 / 22323).
  passed: "passed",
  rejected: "failed",
  "environment-refused": "env",
  stale: "stale",
  lost: "lost",
  legacy: "legacy",
  refused: "failed",
  canceled: "canceled",
} as const satisfies Readonly<Record<QueueTimelineStatus, string>>

// 15e is later than 15c/15d: STATUS remains a fixed column between TIME
// and the RUN cell, while 15d supplies its semantic foreground colors.
// Vocabulary (user respec 2026-07-15; rejected renders `fail`, integrated
// renders `done`). The pre-run PRs now carry their own fine STATUS words —
// `draft`/`rev`/`ready` — so a non-integrated change is always visible with
// an explicit label (user directive 2026-07-22, generalizing the 2026-07-21
// pending→`todo` rule); the coarse filter pills stay todo/running/failed/done.
//
// Exported so the detail pane's headline (`noticeHeadline`) can read the
// exact word this row's list STATUS cell shows, instead of re-deriving one
// through the coarser `StatusPresentationState` alias table — that second
// derivation is what let a submitted-awaiting-run PR print "ready" in the
// list and "queued" in the detail pane (one status, not two).
export function timelineStatusCell(row: QueueTimelineProjectedRow): TimelineStatusCell {
  const word = TIMELINE_STATUS_WORDS[row.status]
  return { word, color: timelineStatusColor(row) }
}

// The STEP cell carries the current `ordinal:name` while running, semantic
// GREEN `integrated` on success (15d), or the failure CODE (the cause) on
// failed terminals.
function timelineStepCell(row: QueueTimelineProjectedRow): TimelineStepCell {
  if (row.status === "running") return { text: row.step ?? "" }
  if (row.failure !== undefined) {
    const slug = fitTimelineLabel(failureSlug(row.failure.code), TIMELINE_STATE_CAP)
    return {
      text: `err=${slug}`,
      color: ["environment-refused", "stale", "legacy", "refused"].includes(row.status)
        ? "$fg-warning"
        : row.status === "canceled"
          ? "$fg-muted"
          : "$fg-error",
    }
  }
  // A pre-run row blocked for a typed reason shows the reason's human message
  // (draft/rev rows carry a failure above and keep their err= code). Without
  // this the projection computed the message into `detail` and rendered it
  // nowhere — the timeline named the state and hid the WHY.
  if (row.whyMessage !== undefined && row.whyMessage !== "") {
    return { text: fitTimelineLabel(row.whyMessage, TIMELINE_WHY_CAP), color: "$fg-warning" }
  }
  return { text: "" }
}

function timelineAgeCell(row: QueueTimelineProjectedRow): string {
  return row.ageMs === null ? "" : mediaDuration(row.ageMs)
}

function timelineTotalCell(row: QueueTimelineProjectedRow): string {
  return row.totalMs === null ? "" : mediaDuration(row.totalMs)
}

function timelineClockCell(row: QueueTimelineProjectedRow, layout: TimelineCellLayout): string {
  return row.timestamp === null ? "-" : queueLogClock(row.timestamp, false, layout.includeDate)
}

function timelineRepeatLabel(repeat: QueueTimelineRepeat): string {
  const first = queueLogClock(repeat.firstTimestamp, false, false).slice(0, 5)
  const last = queueLogClock(repeat.lastTimestamp, false, false).slice(0, 5)
  return `×${repeat.count} · ${first}–${last}`
}

function timelineByCell(row: QueueTimelineProjectedRow): string {
  return row.submitter ?? "-"
}

function timelineCellLayout(
  rows: readonly QueueTimelineProjectedRow[],
  includeDate: boolean,
  columns: number,
  runCells: readonly TimelineRunCellModel[],
): TimelineCellLayout {
  const compact = columns <= 80
  return {
    timeWidth: includeDate ? 19 : 8,
    statusWidth: Math.max(6, ...rows.map((row) => timelineStatusCell(row).word.length + 2)),
    runWidth: Math.max(3, ...runCells.map((model) => timelineRunCellText(model).length)),
    byWidth: columns < 100 ? 0 : Math.max(2, ...rows.map((row) => timelineByCell(row).length)),
    ageWidth: Math.max(3, ...rows.map((row) => timelineAgeCell(row).length)),
    runDurationWidth: Math.max(3, ...rows.map((row) => (row.totalMs === null ? 0 : timelineTotalCell(row).length))),
    compact,
    includeDate,
  }
}

/** Default list cursor: the first RUNNING row, else the most recently finished row. */
export function queueTimelineDefaultCursorId(
  rows: readonly Pick<QueueTimelineProjectedRow, "id" | "status" | "group" | "timestampMs">[],
): string | undefined {
  const running = rows.find((row) => row.status === "running")
  if (running !== undefined) return running.id
  let finished: (typeof rows)[number] | undefined
  for (const row of rows) {
    if (row.group !== "completed") continue
    if (
      finished === undefined ||
      (row.timestampMs ?? Number.NEGATIVE_INFINITY) > (finished.timestampMs ?? Number.NEGATIVE_INFINITY)
    ) {
      finished = row
    }
  }
  return (finished ?? rows[0])?.id
}

/**
 * A synchronized semantic activity pulse for "in progress right now" content
 * (items 12/13). It pulses the caller's color pair when `live` and keeps that
 * pair under row selection; `forceFg` applies only to non-activity content.
 */
function ActivityPulse({
  live,
  colors = ACTIVITY_PULSE_COLORS,
  children,
  ...rest
}: {
  live: boolean
  colors?: readonly [string, string]
  children: React.ReactNode
} & Omit<TextProps, "color" | "children">) {
  if (live) {
    return (
      <Pulse synchronized colors={colors} intervalMs={AG_PULSE_INTERVAL_MS} {...rest}>
        {children}
      </Pulse>
    )
  }
  return (
    <Text color={colors[0]} {...rest}>
      {children}
    </Text>
  )
}

function TimelineMarker({ row, live }: { row: QueueTimelineProjectedRow; live: boolean }) {
  if (row.status === "running") return <ActivityPulse live={live}>{row.glyph}</ActivityPulse>
  return <Text color={timelineStatusColor(row)}>{row.glyph}</Text>
}

/**
 * ONE shared column-geometry component consumed by the header AND every row
 * (silverize verdict 2026-07-15): fixed TIME/STATUS/RUN cells, ONE flexGrow
 * PR cell (absorbs all reclaimed width), and right-anchored STEP/BY/AGE/RUN
 * duration cells at fixed offsets. Header labels and row values render into
 * the same cells, so the header cannot drift from the rows. `rowId` derives
 * per-cell ids (`th-*` for the header, `td-*-<rowId>` for rows) so tests
 * assert x-offset equality via boundingBox, not text scans.
 */
function TimelineCells({
  layout,
  rowId,
  backgroundColor,
  time,
  status,
  run,
  pr,
  by,
  age,
  runDuration,
}: Readonly<{
  layout: TimelineCellLayout
  rowId?: string
  backgroundColor?: string
  time: React.ReactNode
  status: React.ReactNode
  run: React.ReactNode
  pr: React.ReactNode
  by: React.ReactNode
  age: React.ReactNode
  runDuration: React.ReactNode
}>) {
  const id = (name: string): string => (rowId === undefined ? `th-${name}` : `td-${name}-${rowId}`)
  return (
    <Box
      height={1}
      width="100%"
      flexDirection="row"
      gap={1}
      minWidth={0}
      overflow="hidden"
      backgroundColor={backgroundColor}
    >
      <Box id={id("time")} width={layout.timeWidth} flexShrink={0} minWidth={0}>
        {time}
      </Box>
      <Box
        id={id("status")}
        width={layout.statusWidth}
        flexDirection="row"
        flexShrink={0}
        minWidth={0}
        overflow="hidden"
      >
        {status}
      </Box>
      <Box id={id("run")} width={layout.runWidth} flexShrink={0} minWidth={0}>
        {run}
      </Box>
      <Box id={id("pr")} flexDirection="row" flexGrow={1} flexBasis={0} minWidth={12} overflow="hidden">
        {pr}
      </Box>
      {layout.byWidth === 0 ? null : (
        // BY is left-aligned — header and cells (user directive 2026-07-16,
        // supersedes the 15c right-aligned BY clause).
        <Box id={id("by")} width={layout.byWidth} flexShrink={0} minWidth={0}>
          {by}
        </Box>
      )}
      <Box id={id("age")} width={layout.ageWidth} flexShrink={0} minWidth={0} justifyContent="flex-end">
        {age}
      </Box>
      {/* id is `dur`, not `run-duration` — a `run-` prefix would collide with the RUN(id) cell's prefix queries. */}
      <Box id={id("dur")} width={layout.runDurationWidth} flexShrink={0} minWidth={0} justifyContent="flex-end">
        {runDuration}
      </Box>
    </Box>
  )
}

// Header: TIME | STATUS | RUN | CHANGES | BY | AGE | RUN — RUN(id) and
// CHANGES are separate labels, each exactly over its own column; the
// trailing bare RUN header belongs to the run-duration column. STEP was
// folded into the CHANGES cell (user directive 2026-07-16, item Q). The
// column's internal id stays `pr` (see `id("pr")` in TimelineCells) — only
// the printed label renamed, matching the detail pane's Changes tab
// (operator spec: list and detail must not name this two different things).
function TimelineHeader({ layout }: { layout: TimelineCellLayout }) {
  // The column header reads white + bold (user directive 2026-07-16) so it
  // stands out above the muted row cells.
  const label = (text: string): React.ReactElement => (
    <Text color="$fg" bold wrap="truncate">
      {text}
    </Text>
  )
  return (
    <TimelineCells
      layout={layout}
      time={label("TIME")}
      status={label("STATUS")}
      run={label("RUN")}
      pr={label("CHANGES")}
      by={label("BY")}
      age={label("AGE")}
      runDuration={label("RUN")}
    />
  )
}

/**
 * EVERY row renders its own TIME, STATUS and RUN, including the second and
 * third member of a convoy that merged together.
 *
 * Until 2026-08-17 an adjacent member sharing the leader's base+run rendered
 * those three cells as `-` (the "Round 8 continuation placeholder"). That made
 * a merged PR and a never-attempted one print the SAME row of dashes, so the
 * one question a human asks this list — did my work merge — had no answer for
 * two thirds of a convoy: R2649 merged PR1151/1152/1153 and only PR1151 showed
 * a status. Operator directive, superseding Round 8: "make sure all PRs show in
 * the watch/list - i always assumed that they would show"
 * (@i/10-merge-queue/22925-watch-shows-every-pr). De-duplicating the run label
 * is not worth a row that cannot distinguish success from nothing-ever-happened.
 */
function TimelineProjectedRow({
  row,
  runCell,
  cursor,
  hovered,
  layout,
  live,
}: {
  row: QueueTimelineDisplayRow
  runCell: TimelineRunCellModel
  cursor: boolean
  hovered: boolean
  layout: TimelineCellLayout
  live: boolean
}) {
  const active = row.status === "running"
  const status = timelineStatusCell(row)
  const step = timelineStepCell(row)
  const runDuration = timelineTotalCell(row)
  // Selection forces the semantic pair on EVERY cell (user respec
  // 2026-07-15): $bg-selected under $fg-on-selected, no per-cell colors.
  const forcedFg = cursor ? "$fg-on-selected" : undefined
  // Hover is affordance-only (item P): a background tint under the pointer that
  // never moves the cursor or detail selection. Cursor selection wins, so a
  // hovered cursor row keeps $bg-selected; foreground is untouched by hover.
  const rowBackground = cursor ? "$bg-selected" : hovered ? "$bg-surface-hover" : undefined
  return (
    <TimelineCells
      layout={layout}
      rowId={row.id}
      backgroundColor={rowBackground}
      time={
        <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
          {timelineClockCell(row, layout)}
        </Text>
      }
      status={
        <>
          <Box width={1} flexShrink={0}>
            {/* A running row's glyph keeps its km warning pulse even under
              selection; other statuses take the selection fg. */}
            {active || !cursor ? <TimelineMarker row={row} live={live} /> : <Text color={forcedFg}>{row.glyph}</Text>}
          </Box>
          <Box paddingLeft={1} minWidth={0} overflow="hidden">
            {/* The running status word pulses blue in the shared phase (item 12)
              and stays blue when the row is selected (item 13). */}
            {active ? (
              <ActivityPulse live={live} wrap="truncate">
                {status.word}
              </ActivityPulse>
            ) : (
              <Text color={forcedFg ?? status.color} wrap="truncate">
                {status.word}
              </Text>
            )}
          </Box>
        </>
      }
      run={
        // Item 38, amended 2026-08-25: `label#N` — the queue label muted, the
        // run number bright. The run's state is NOT repeated here: the STATUS
        // cell already carries it as icon+text, and the old icon-only glyph
        // suffix said every row's status twice. Pre-run rows carry a muted
        // em-dash; a batch member behind the first carries a muted `·`
        // continuation instead of repeating the id.
        runCell.kind === "none" ? (
          <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
            —
          </Text>
        ) : runCell.kind === "continuation" ? (
          <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
            ·
          </Text>
        ) : (
          <Box flexDirection="row" minWidth={0} overflow="hidden">
            {runCell.label === "" ? null : (
              <Text color={forcedFg ?? "$fg-muted"} flexShrink={0}>
                {runCell.label}
              </Text>
            )}
            <Text color={forcedFg} wrap="truncate" minWidth={0}>
              {runCell.number}
            </Text>
          </Box>
        )
      }
      pr={
        // The CHANGES cell is `pr#id.rev <title>` (operator ruling 2026-08-18,
        // item 28): the change's id then its TITLE, ellipsis-truncated — never
        // the branch name, which lives only in the detail pane's per-change
        // box header (`pr#id.rev ⎇ branch`). The live step / terminal failure
        // code keeps its parenthesized colorized suffix (status, not identity).
        // A `factOnly` row (pre-admission submit fact) has NO minted id — the
        // branch IS its identity, so it renders `⎇ branch` here instead of a
        // fabricated change id.
        <>
          {row.factOnly === true ? (
            <Text color={forcedFg} flexShrink={0}>
              <Text color={forcedFg ?? BRANCH_ICON_COLOR}>{BRANCH_ICON}</Text> {row.branch}
            </Text>
          ) : (
            <QueueChangeId pr={row.pr} revision={row.revision} color={forcedFg} flexShrink={0} />
          )}
          {row.repeat?.collapsed === true ? (
            <Text color={forcedFg ?? "$fg-warning"} flexShrink={0}>
              {` ${timelineRepeatLabel(row.repeat)}`}
            </Text>
          ) : null}
          <Box paddingLeft={1} minWidth={0} overflow="hidden" flexDirection="row">
            <Text color={forcedFg} wrap="truncate" minWidth={0} bgConflict="ignore">
              {row.subject}
            </Text>
            {step.text === "" ? null : (
              <Text color={forcedFg ?? (active ? "$fg-info" : step.color)} flexShrink={0} wrap="truncate">
                {" "}
                ({step.text})
              </Text>
            )}
          </Box>
        </>
      }
      by={
        <Text color={forcedFg ?? "$fg-muted"} wrap="truncate">
          {timelineByCell(row)}
        </Text>
      }
      age={<Text color={forcedFg ?? "$fg-muted"}>{timelineAgeCell(row)}</Text>}
      runDuration={
        // Run duration: no clock glyph, just the dimmed time (user directive
        // 2026-07-16, supersedes the 15c `◷`-carries-onto-RUN clause).
        runDuration === "" ? <Text> </Text> : <Text color={forcedFg ?? "$fg-muted"}>{runDuration}</Text>
      }
    />
  )
}

// Legacy summary rows (the non-projection dashboard) still name their root;
// the path routes through the one user-friendly formatter (item 33).
function QueueRepositoryRoot({ root }: { root: string | undefined }) {
  return root === undefined ? null : (
    <Text color="$fg-muted" wrap="truncate" flexShrink={0}>
      ROOT {friendlyRepositoryPath(root)}
    </Text>
  )
}

/**
 * The one top line every queue surface leads with (operator rulings
 * 2026-08-18, items 30/32/32b/33/36): the `YRD QUEUES` title, then the queue
 * tabs. Each tab is `digit label path ⎇ branch` — the digit filter
 * accelerator, the config handle when one is declared, and the pretty
 * rendering of the queue's FQN identity pair (shortest unique friendly
 * path). The old `QUEUE main` / `ROOT /hh` header row is deleted — the tabs
 * ARE the queue identity now, so no second line repeats it.
 *
 * These read as TABS, not as the bottom status pills (operator, 2026-08-19):
 * the selected queue is lit by the same `$bg-selected` surface the detail
 * pane's step tabs use, and an unselected one sits on `$bg-surface-subtle`,
 * so "which queue am I looking at" is answered by a filled background rather
 * than by a shade of foreground text. The title is indented one column to
 * match the heading it replaced. Selection stays a TOGGLE underneath — a
 * digit or a click still turns one queue on or off.
 *
 * `all` is deliberately NOT here (operator, 2026-08-19). It clears both
 * filter kinds, so it belongs with the status pills at the bottom, where it
 * lived before; the `a` key is unchanged and the watch help still teaches it.
 */
export function QueueTopLine({
  queues,
  visibleQueues,
  onToggleQueue,
}: {
  queues: readonly QueueTimelineQueue[]
  /** Bases currently shown; undefined means every queue (the default). */
  visibleQueues?: ReadonlySet<string>
  onToggleQueue?: (base: string) => void
}) {
  const shortPaths = shortUniqueQueuePaths(queues.flatMap((queue) => (queue.path === undefined ? [] : [queue.path])))
  return (
    <Box height={1} flexDirection="row" columnGap={2} flexShrink={0} minWidth={0} overflow="hidden" paddingLeft={1}>
      <Text bold flexShrink={0}>
        YRD QUEUES
      </Text>
      {queues.length === 0 ? null : (
        <TogglePillGroup flexShrink={1} minWidth={0} overflow="hidden">
          {queues.map((queue) => {
            const pretty = queuePrettyName(queue, queue.path === undefined ? undefined : shortPaths.get(queue.path))
            const handle = queue.name === undefined ? "" : `${queue.name} `
            const selected = visibleQueues === undefined || visibleQueues.has(queue.base)
            return (
              <Box
                key={`${queue.path ?? ""}@${queue.base}`}
                backgroundColor={selected ? "$bg-selected" : "$bg-surface-subtle"}
                paddingX={1}
                flexShrink={0}
              >
                <TogglePill
                  label={`${String(queue.label)} ${handle}${pretty}`}
                  boldFirstLetter
                  active={selected}
                  onToggle={() => onToggleQueue?.(queue.base)}
                />
              </Box>
            )
          })}
        </TogglePillGroup>
      )}
    </Box>
  )
}

/**
 * `nowMs` is the caller's — never re-derived from `projection.now` here
 * (operator ruling 2026-08-18, items 16/17: ONE derivation for every
 * relative age in the RUNNER box, fed by the box's own coarse re-render
 * tick, never a second parallel clock). `projection.now` only advances once
 * per poll (~15s); a `now` pinned to it freezes every "X ago" reading
 * on-screen for up to that long even though real time keeps passing — the
 * exact freeze the operator reported.
 */
function runnerTiming(
  projection: QueueTimelineProjection,
  nowMs: number,
): Readonly<{ ageMs: number; uptimeMs: number }> | null {
  const runner = projection.runner
  if (runner === null) return null
  const startedAt = Date.parse(runner.startedAt)
  const lastTickAt = Date.parse(runner.lastTickAt)
  if (![nowMs, startedAt, lastTickAt].every(Number.isFinite)) {
    throw new Error("yrd: queue runner projection contains an invalid timestamp")
  }
  return { ageMs: Math.max(0, nowMs - lastTickAt), uptimeMs: Math.max(0, nowMs - startedAt) }
}

/** Newest terminal (completed-group) row timestamp — when the queue last drained anything. */
function timelineLastDrainedMs(projection: QueueTimelineProjection): number | null {
  let newest: number | null = null
  for (const row of projection.rows) {
    if (row.group !== "completed" || row.timestampMs === null) continue
    if (newest === null || row.timestampMs > newest) newest = row.timestampMs
  }
  return newest
}

/** Newest proven merge over the retained journal-terminal horizon
 * (`timeStatsFacts` folds every retained row before any display window or
 * status filter binds). S7: the record-store arm is gone — journal terminals
 * ARE the merge history; the store's copy was a second derivation of the same
 * fact. Unlike the last-drained clock, this ignores refusals/rejections and
 * display filters. */
function timelineLastMergeMs(projection: QueueTimelineProjection): number | null {
  return projection.timeStatsFacts.reduce<number | null>(
    (latest, fact) =>
      fact.outcome !== "integrated"
        ? latest
        : latest === null
          ? fact.terminalAtMs
          : Math.max(latest, fact.terminalAtMs),
    null,
  )
}

function queueHeadBlockDetails(
  projection: QueueTimelineProjection,
  state: BaysState | undefined,
  results: readonly QueueStatusResult[] | undefined,
  nowMs: number,
): QueueHeadBlockDetails | undefined {
  const runner = projection.runner
  if (runner?.queueProgress?.state !== "stalled") return undefined
  const result = results?.find((candidate) => baseIdentity(candidate.base) === baseIdentity(projection.base))
  // The identities THIS base knows, across both lanes: retained records
  // (legacy arm), run-member snapshots (id AND branch — derived refusals key
  // on either), and live submit-fact branches. Scoping on record ids alone
  // silently dropped every derived member's admission-refusal-loop finding
  // the moment results were present.
  const resultIds =
    result === undefined
      ? undefined
      : new Set([
          ...result.prs.map((pr) => pr.id),
          ...[...result.running, ...result.waiting, ...result.finished].flatMap((run) =>
            run.prs.flatMap((member) => [member.id, member.branch]),
          ),
          ...(state === undefined
            ? []
            : Object.entries(state.submits)
                .filter(([, fact]) => baseIdentity(fact.base) === baseIdentity(result.base))
                .map(([branch]) => branch)),
        ])
  const finding = runner.queueProgress.findings.find((candidate) => {
    if (candidate.code !== "admission-refusal-loop" || candidate.pr === undefined) return false
    if (resultIds !== undefined) return resultIds.has(candidate.pr)
    // The change-record lookup that used to answer "which base is this
    // refusal's delivery on" went with the store; the projection's own rows
    // carry the same base for every member it knows.
    return projection.rows.some(
      (row) => row.pr === candidate.pr && baseIdentity(row.base) === baseIdentity(projection.base),
    )
  })
  if (finding?.pr === undefined) return undefined
  const positions = new Map(
    (result?.eligibilities ?? []).flatMap((eligibility) =>
      eligibility.checks.position === undefined ? [] : [[eligibility.pr, eligibility.checks.position] as const],
    ),
  )
  const position = positions.get(finding.pr)
  const queuedBehind =
    position === undefined ? undefined : [...positions.values()].filter((candidate) => candidate > position).length
  const since = finding.since === undefined ? Number.NaN : Date.parse(finding.since)
  // `nowMs` is the caller's coarse-ticking clock (items 16/17), not a second
  // `Date.parse(projection.now)` derivation — this age shares the same
  // ONE-clock rule as every other relative reading in the RUNNER box.
  const blockedMs =
    Number.isFinite(since) && Number.isFinite(nowMs) ? Math.max(0, nowMs - since) : (finding.blockedMs ?? 0)
  const row = projection.rows.find((candidate) => candidate.pr === finding.pr)
  // Recordless (derived) finding: the member snapshot is the identity source.
  const member =
    result === undefined
      ? undefined
      : [...result.running, ...result.waiting, ...result.finished]
          .flatMap((run) => run.prs)
          .find((candidate) => candidate.id === finding.pr || candidate.branch === finding.pr)
  return {
    pr: finding.pr,
    // The record's `title`/`name` led this chain; the run member's own name and
    // branch are what remain, and they were already the recordless fallback.
    subject: member?.name ?? member?.branch ?? row?.subject ?? finding.pr,
    ...(position === undefined ? {} : { position }),
    ...(queuedBehind === undefined ? {} : { queuedBehind }),
    blockedMs,
    ...(finding.count === undefined ? {} : { retryCount: finding.count }),
    refusal: finding.refusal ?? finding.code,
    resolution: finding.resolution ?? [],
  }
}

/**
 * Missing, stale, or outcome-stalled is solid red; active is pulsing blue;
 * idle is pulsing grey. `nowMs` is the caller's coarse-ticking clock (items
 * 16/17) — this stale/down detection freezes for up to a whole poll cycle
 * otherwise, the same bug the age TEXT had.
 */
export function queueHealthMarker(projection: QueueTimelineProjection, nowMs: number): QueueHealthMarker {
  const timing = runnerTiming(projection, nowMs)
  if (projection.runner === null || (timing !== null && timing.ageMs > RUNNER_VIEW_STALE_MS)) {
    return { kind: "down", color: "$fg-error", pulse: null }
  }
  const progress = projection.runner.queueProgress
  const progressAgeMs = progress === undefined ? undefined : QueueRunnerProgress.ageMs(progress, nowMs)
  if (
    progress === undefined ||
    progressAgeMs === undefined ||
    progressAgeMs > RUNNER_VIEW_STALE_MS ||
    progress.state === "stalled"
  ) {
    return { kind: "stalled", color: "$fg-error", pulse: null }
  }
  if (projection.rows.some((row) => row.status === "running")) {
    return { kind: "processing", color: "$fg-info", pulse: ["$fg-info", "$fg-muted"] }
  }
  return { kind: "idle", color: "$fg-muted", pulse: ["$fg-muted", "$bg-surface-default"] }
}

function RunnerActivity({
  marker,
  live,
  children,
  ...rest
}: {
  marker: QueueHealthMarker
  live: boolean
  children: React.ReactNode
} & Omit<TextProps, "color" | "children">) {
  if (marker.pulse !== null && live) {
    return (
      <Pulse synchronized colors={marker.pulse} intervalMs={AG_PULSE_INTERVAL_MS} {...rest}>
        {children}
      </Pulse>
    )
  }
  return (
    <Text color={marker.color} {...rest}>
      {children}
    </Text>
  )
}

/** The RUNNER box's source rail, pin-staleness flagged inline (@yrd/core/stale-runner-never-recycles
 * box 2) so a watcher sees a booted-source/pin gap without cross-referencing the pin by
 * hand. Every annotation names the RECORDED pin as its base
 * (@i/10-merge-queue/23041-staleness-measures-the-observer); an unpinned queue renders
 * the bare source, and a pin that could not be read renders its reason loudly — never a
 * confident "0 behind", never a number from a different base. */
function runnerSourceLine(runner: QueueTimelineRunner): string {
  const source = `source ${runner.implementationSource ?? "unknown"}`
  const pin = runner.sourcePin
  if (pin === undefined) return source
  if (pin.state === "at") return `${source} (at pin)`
  if (pin.state === "behind") return `${source} (${String(pin.commits)} behind pin)`
  return `${source} (pin unknown: ${pin.reason})`
}

function RunnerProgressStatus({
  progress,
  headBlock,
}: {
  progress: QueueRunnerProgress | undefined
  headBlock: QueueHeadBlockDetails | undefined
}) {
  if (progress?.state !== "stalled") return null
  if (headBlock === undefined) {
    return (
      <Text color="$fg-error" bold wrap="truncate">
        NO PROGRESS — {progress.findings.map((finding) => finding.message).join(" · ")}
      </Text>
    )
  }
  return (
    <>
      <Text color="$fg-error" bold wrap="wrap">
        NO PROGRESS — BLOCKED {headBlock.pr} · {headBlock.subject}
      </Text>
      <Text color="$fg-error" bold wrap="wrap">
        {headBlock.position === undefined ? "" : `position ${headBlock.position} · `}
        {headBlock.refusal} · blocked {runnerClock(headBlock.blockedMs)}
        {headBlock.retryCount === undefined ? "" : ` · retry ${headBlock.retryCount}`}
        {headBlock.queuedBehind === undefined ? "" : ` · ${headBlock.queuedBehind} queued behind`}
      </Text>
      {headBlock.resolution.map((step) => (
        <Text key={step} color="$fg-error" wrap="wrap">
          REMEDY — {step}
        </Text>
      ))}
    </>
  )
}

function RunnerProgressObservation({ progress, now }: { progress: QueueRunnerProgress | undefined; now: number }) {
  if (progress === undefined) {
    return (
      <Text color="$fg-error" bold wrap="truncate">
        PROGRESS NOT MEASURED — heartbeat proves ticking only
      </Text>
    )
  }
  const ageMs = QueueRunnerProgress.ageMs(progress, now)
  if (ageMs === undefined) {
    return (
      <Text color="$fg-error" bold wrap="truncate">
        PROGRESS INVALID — measurement time is not readable
      </Text>
    )
  }
  if (ageMs > RUNNER_VIEW_STALE_MS) {
    return (
      <Text color="$fg-error" bold wrap="truncate">
        PROGRESS STALE — last measured {mediaDuration(ageMs)} ago
      </Text>
    )
  }
  return <Text color="$fg-muted">progress measured {mediaDuration(ageMs)} ago</Text>
}

/**
 * The one line a reader gets when nothing is draining this queue, and the only
 * place the three runner-absence states are told apart.
 *
 * They used to share one sentence. A runner killed by SIGKILL, a runner that
 * stopped cleanly, and a queue no runner has ever touched all rendered
 * "NO RUNNER - no drained run in window" (cli.test.ts pinned that identical
 * string for the dead-pid case and the missing-status-file case), so the banner
 * announced a problem without saying which one, and never said what to do. Each
 * state now names its own fact and carries its own remedy inline: this row is
 * `wrap="truncate"` by design (see the header-row comment below), so a remedy
 * parked on a separate rail is a remedy a narrow pane hides — the reason the
 * sentences stay short enough to survive a normal-width frame.
 */
export function queueNoRunnerBanner(
  projection: Pick<QueueTimelineProjection, "base" | "oldestOpenMs" | "runnerAbsence">,
  drainedMs: number | null,
  nowMs: number,
  runnerRefusal?: QueueRunnerRefusal,
): string {
  if (runnerRefusal !== undefined) {
    return `NO RUNNER - runner stopped: stale step contract on ${runnerRefusal.run ?? "unknown run"}`
  }
  const start = `yrd queue run ${projection.base}`
  const absence = projection.runnerAbsence
  if (absence?.kind === "departed") {
    const ago = mediaDuration(Math.max(0, nowMs - absence.lastAliveMs))
    // A clean exit is a decision someone made; a missing exit marker is a death
    // nobody recorded, and only the second is a reason to look at why.
    return absence.clean
      ? `NO RUNNER - habitant runner [${absence.pid}] stopped ${ago} ago; restart it: ${start}`
      : `NO RUNNER - habitant runner [${absence.pid}] died ${ago} ago, no exit marker; restart it: ${start}`
  }
  // Nothing has ever drained HERE, and something may be waiting on it — the two
  // facts a reader needs before deciding this queue is merely quiet.
  if (drainedMs === null) {
    const waiting = projection.oldestOpenMs === null ? "" : `, oldest open ${mediaDuration(projection.oldestOpenMs)}`
    return `NO RUNNER - no runner has ever drained this queue${waiting}; start one: ${start}`
  }
  return `NO RUNNER - queue last drained ${mediaDuration(nowMs - drainedMs)} ago, none habitant since; start one: ${start}`
}

/**
 * A coarse, live-ticking clock for relative-time display ONLY (operator
 * ruling 2026-08-18, items 16/17). `projection.now` is the data snapshot's
 * own clock — it only advances once per watch poll (~15s) — so every "X ago"
 * reading fed by it freezes on-screen for up to that long even though real
 * time keeps passing. That is the exact bug the operator reported as
 * "progress measured 0:05 ago" looking stuck: `now` was not ticking BETWEEN
 * events, not the runner's own ~5s heartbeat oscillating.
 *
 * Anchored to `serverNowMs` (re-anchoring the instant it changes, so a fresh
 * poll is authoritative the moment it merges) and advanced by real elapsed
 * wall-clock time since, so it never drifts against `setInterval` jitter.
 * Inert when `!live` (the one-shot print path has no app scope and a static
 * print cannot tick) — returns `serverNowMs` unchanged, matching the file's
 * existing live/static split for the activity pulse.
 */
function useCoarseNow(serverNowMs: number, live: boolean, tickMs = 1000): number {
  const capturedAtRef = useRef(Date.now())
  const seenServerNowRef = useRef(serverNowMs)
  if (seenServerNowRef.current !== serverNowMs) {
    seenServerNowRef.current = serverNowMs
    capturedAtRef.current = Date.now()
  }
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => forceTick((tick) => (tick + 1) % 1_000_000), tickMs)
    return () => clearInterval(id)
  }, [live, tickMs])
  if (!live) return serverNowMs
  return serverNowMs + Math.max(0, Date.now() - capturedAtRef.current)
}

/**
 * Habitant runner status is always visible in its own RUNNER frame. The
 * queue-pause STATUS line lives INSIDE this frame (user directive 2026-07-21,
 * supersedes the separate STATUS box), the uptime/downtime timer rides the
 * top border right-aligned opposite the RUNNER title, and the health marker
 * is a pulsing `$` shell prompt. Border severity: down/stale/unmeasured red,
 * paused warning, measured healthy default.
 */
function TimelineRunnerBox({
  projection,
  runnerRefusal,
  results,
  state,
  live = false,
  columns = 120,
}: {
  projection: QueueTimelineProjection
  runnerRefusal?: QueueRunnerRefusal
  results?: readonly QueueStatusResult[]
  state?: BaysState
  live?: boolean
  /** Pane content width, for the bounded hanging command wrap (item 29). */
  columns?: number
}) {
  const runner = projection.runner
  // ONE derivation for every relative age in this box (items 16/17): a
  // coarse-ticking clock, live only in the interactive pane, that every
  // age/health computation below is fed explicitly rather than each
  // re-deriving its own `Date.parse(projection.now)`.
  const now = useCoarseNow(Date.parse(projection.now), live)
  const timing = runnerTiming(projection, now)
  const runnerStale = timing !== null && timing.ageMs > RUNNER_VIEW_STALE_MS
  const marker = queueHealthMarker(projection, now)
  const pause = projection.pause
  const pauseHealth = pause === undefined || state === undefined ? undefined : queuePauseHealth(state, pause)
  const pauseAllowed = pause === undefined ? "none" : queuePauseAllowedText(pause, pauseHealth)
  const drained = timelineLastDrainedMs(projection)
  const lastMerge = timelineLastMergeMs(projection)
  const downMs =
    runner === null
      ? drained === null
        ? null
        : Math.max(0, now - drained)
      : runnerStale
        ? (timing?.ageMs ?? null)
        : null
  const uptimeMs = timing?.uptimeMs ?? 0
  const runnerTimer = runnerBoxTimer(marker, downMs, uptimeMs)
  const mergeTimer = runnerMergeTimer(lastMerge, now, uptimeMs, runner !== null)
  const timer = runnerTimer === undefined ? mergeTimer : `${runnerTimer} · ${mergeTimer}`
  const headBlock = queueHeadBlockDetails(projection, state, results, now)
  const borderColor =
    marker.kind === "down" || marker.kind === "stalled" ? "$fg-error" : pause !== undefined ? "$fg-warning" : undefined
  // Text coloring is STATE-CONDITIONAL (operator ruling 2026-08-18, item 27):
  // while running normally the `$ …` command line renders BLUE (the marker
  // color) with the pulsing activity marker, and every INFORMATIONAL rail is
  // muted grey so the activity line carries the eye — but severity text
  // NEVER mutes: a warning source/uncarried rail and every error row keep
  // the box's severity color regardless of runner activity (muting must
  // never dim an error; the pre-27 build muted a behind-pin warning while
  // running, which is exactly the bug this rule bans).
  // Item 29: ALL text left-aligns with the COMMAND TEXT column — the `$`
  // sits outdented as a hanging marker in its own 2-cell gutter. Wrapped
  // command text hangs off the marker BOUNDED (≤3 rows, `…`-elided) so the
  // run list always survives on narrow panes — the 2026-08-13 regression
  // guard's reason, with wrap-with-hanging-indent as the new mechanism.
  // Gutter 2 + borders 2 + TitledBox paddingX 2 = 6 cells of chrome.
  const commandWidth = Math.max(8, columns - 6)
  const commandRows =
    runner === null
      ? []
      : boundedHangingLines(`${runner.command ?? "habitant runner"} [${runner.pid}]`, commandWidth, 3)
  return (
    <TitledBox
      title="RUNNER"
      {...(timer === undefined ? {} : { titleRight: timer })}
      {...(borderColor === undefined ? {} : { borderColor })}
    >
      <MarkerRow
        marker={
          <RunnerActivity marker={marker} live={live} bold flexShrink={0}>
            {QUEUE_HEALTH_GLYPH}
          </RunnerActivity>
        }
      >
        {runner === null ? (
          // The NO RUNNER banner stays a one-line elided rail: a remedy
          // parked on wrapped continuation rows is a remedy a narrow pane
          // spends its whole height on (queue-timeline-chrome, "12-column
          // projected-live header").
          <Text color="$fg-error" bold wrap="truncate" minWidth={0}>
            {queueNoRunnerBanner(projection, drained, now, runnerRefusal)}
          </Text>
        ) : (
          commandRows.map((commandRow, index) => (
            <Text key={`command:${index}`} color={marker.color} wrap="truncate" minWidth={0}>
              {commandRow}
            </Text>
          ))
        )}
      </MarkerRow>
      {runner === null ? null : (
        <MarkerRow>
          <Text
            color={runner.sourcePin === undefined || runner.sourcePin.state === "at" ? "$fg-muted" : "$fg-warning"}
            wrap="truncate"
            minWidth={0}
          >
            {runnerSourceLine(runner)}
          </Text>
        </MarkerRow>
      )}
      {/* Its own rail, per acceptance: pushed-and-uncarried is invisible from
          every other surface here, because a ref with no change has no
          candidate and so appears in no row. Colour rules live in
          `uncarriedRailColor` — only genuine stranded work earns attention,
          and a warning-colored rail never mutes (item 27). Coverage is
          carried by the TEXT, never by the colour. */}
      {runner === null ? null : (
        <MarkerRow>
          <Text color={uncarriedRailColor(runner.uncarried)} wrap="truncate" minWidth={0}>
            {uncarriedLine(runner.uncarried, now)}
          </Text>
        </MarkerRow>
      )}
      {runner === null && runnerRefusal !== undefined ? (
        <MarkerRow>
          <Text color="$fg-error" wrap="truncate" minWidth={0}>
            {runnerRefusal.code}: {runnerRefusal.message}
          </Text>
        </MarkerRow>
      ) : null}
      {runnerStale && timing !== null ? (
        <MarkerRow>
          <Text color="$fg-error" bold wrap="truncate">
            RUNNER STALE — last tick {mediaDuration(timing.ageMs)} ago
          </Text>
        </MarkerRow>
      ) : null}
      {runner === null ? null : (
        <MarkerRow>
          <RunnerProgressObservation progress={runner.queueProgress} now={now} />
        </MarkerRow>
      )}
      <MarkerRow>
        <RunnerProgressStatus progress={runner?.queueProgress} headBlock={headBlock} />
      </MarkerRow>
      {pause === undefined ? null : (
        <>
          <Box height={1} flexShrink={0} />
          <MarkerRow
            marker={
              <Text color={pauseHealth?.blocksAll === true ? "$fg-error" : "$fg-warning"} flexShrink={0}>
                {pauseHealth?.blocksAll === true ? "⚠" : "×"}
              </Text>
            }
          >
            <Text color={pauseHealth?.blocksAll === true ? "$fg-error" : "$fg-warning"} wrap="truncate" minWidth={0}>
              {pauseHealth?.blocksAll === true ? (
                <>
                  <Text bold>PAUSE BLOCKING EVERYTHING</Text> — {pause.reason} · allowed {pauseAllowed}
                </>
              ) : (
                <>
                  {/* Not `STATUS HOLD THE LINE`: STATUS names the row column
                      two lines below, and one word cannot name two things on
                      one screen (21479). The blocking branch above never had
                      the label; this rail joins it. */}
                  <Text bold>HOLD THE LINE</Text> — {pause.reason} · allowed {pauseAllowed}
                </>
              )}
            </Text>
          </MarkerRow>
        </>
      )}
    </TitledBox>
  )
}

/** Bucket a row status onto the operator courts (user respec 2026-07-23):
 * `open` = the agents' court (draft/rev — editable, next action is the author);
 * `running` = the queue's court (ready/queued/running — next action is the
 * runner); every non-success terminal outcome is `failed`; integrated and
 * already-landed are `done`. Admission-only `passed` is NOT done (21801). */
export function queueTimelineStatusBucket(status: QueueTimelineStatus): QueueTimelineStatusBucket {
  if (status === "draft" || status === "rev") return "open"
  if (status === "ready" || status === "pending" || status === "running") return "running"
  return status === "integrated" || status === "already-landed" ? "done" : "failed"
}

/**
 * The rows the timeline renders. In the default (one-shot print) mode the set
 * is capped to `display.shown` and the residue surfaces as `... N more`. In
 * `fill` mode (the interactive pane, item 5) the cap is dropped and every
 * retained row is returned: the pane's ListView virtualizes and shows as many
 * as physically fit, scrolling the rest, so the row set is bounded by pane
 * height rather than a fixed pre-slice. `fill` widens the set to a superset of
 * the capped prefix, so an externally computed cursor over the capped set stays
 * valid against the fill set.
 */
export function queueTimelineVisibleRows(
  projection: Pick<QueueTimelineProjection, "rows" | "display">,
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>,
  fill = false,
  visibleQueues?: ReadonlySet<string>,
): readonly QueueTimelineProjectedRow[] {
  const rows = fill ? projection.rows : projection.rows.slice(0, projection.display.shown)
  const byQueue = visibleQueues === undefined ? rows : rows.filter((row) => visibleQueues.has(row.base))
  if (visibleBuckets === undefined) return byQueue
  return byQueue.filter((row) => visibleBuckets.has(queueTimelineStatusBucket(row.status)))
}

function timelineOutcomeKey(row: QueueTimelineProjectedRow): string {
  return JSON.stringify([row.base, row.pr, row.revision, row.headSha, row.status, row.failure?.code ?? ""])
}

function sameTimelineOutcome(left: QueueTimelineProjectedRow, right: QueueTimelineProjectedRow): boolean {
  return (
    left.group === "completed" && right.group === "completed" && timelineOutcomeKey(left) === timelineOutcomeKey(right)
  )
}

function timelineRepeatKey(row: QueueTimelineProjectedRow, boundaryId: string): string {
  return JSON.stringify([timelineOutcomeKey(row), boundaryId])
}

/**
 * Fold consecutive retries of the same immutable PR revision and terminal
 * outcome for display only. The projection stays lossless for metrics, JSON,
 * detail lookup, and expansion; an expanded group returns every source row.
 */
export function queueTimelineDisplayRows(
  rows: readonly QueueTimelineProjectedRow[],
  expanded: ReadonlySet<string> = new Set(),
): readonly QueueTimelineDisplayRow[] {
  const display: QueueTimelineDisplayRow[] = []
  for (let index = 0; index < rows.length; ) {
    const first = rows[index]
    if (first === undefined) break
    const group = [first]
    let next = index + 1
    while (next < rows.length) {
      const candidate = rows[next]
      if (candidate === undefined || !sameTimelineOutcome(first, candidate)) break
      group.push(candidate)
      next += 1
    }
    const last = group.at(-1) ?? first
    if (group.length === 1 || first.timestamp === null || last.timestamp === null) {
      display.push(...group)
      index = next
      continue
    }
    // The next row is the stable boundary of this occurrence. New retries
    // prepend to a storm, so anchoring on `first.id` would collapse an open
    // group on every refresh; the following row also distinguishes disjoint
    // storms with the same PR/outcome identity.
    const key = timelineRepeatKey(first, rows[next]?.id ?? "$tail")
    const repeat = {
      key,
      count: group.length,
      firstTimestamp: last.timestamp,
      lastTimestamp: first.timestamp,
      collapsed: !expanded.has(key),
    } satisfies QueueTimelineRepeat
    if (repeat.collapsed) display.push({ ...first, repeat })
    else display.push({ ...first, repeat }, ...group.slice(1))
    index = next
  }
  return display
}

export function queueTimelineVisibleDefaultCursorId(
  projection: Pick<QueueTimelineProjection, "rows" | "display">,
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>,
  fill = false,
  visibleQueues?: ReadonlySet<string>,
): string | undefined {
  const rows = queueTimelineVisibleRows(projection, visibleBuckets, fill, visibleQueues)
  return queueTimelineDefaultCursorId(rows) ?? rows[0]?.id
}

/**
 * The YYYY-MM-DD (local time) date-header label to show above `current`, or
 * `null` when no header belongs there. A header appears strictly BETWEEN two
 * adjacent visible entries whose local calendar day differs: pass the entry
 * immediately above `current` in on-screen order as `previous`.
 *
 * Design call: `previous === undefined` (the very first visible entry) always
 * returns `null` — there is no leading header above day one. The per-row TIME
 * cell already grows to carry an inline date once the visible window spans
 * more than one day (`includeDate` in `timelineCellLayout`), so the top entry
 * is never ambiguous about which day it belongs to, and a pairwise "only
 * BETWEEN entries" rule needs no special top-of-list case. Either side
 * missing a `timestamp` also suppresses the header — an untimed pending
 * entry carries no day to anchor a boundary to.
 */
export function queueTimelineDateSeparatorLabel(
  previous: QueueTimelineProjectedRow | undefined,
  current: QueueTimelineProjectedRow,
): string | null {
  const previousTimestamp = previous?.timestamp
  if (previousTimestamp === undefined || previousTimestamp === null || current.timestamp === null) return null
  const previousDay = timelineLocalCalendarDay(previousTimestamp)
  const currentDay = timelineLocalCalendarDay(current.timestamp)
  return previousDay === currentDay ? null : currentDay
}

/**
 * The YYYY-MM-DD header to show above the row at `index`. The boundary rule is
 * the r5 rule (a header strictly BETWEEN two adjacent rows whose local calendar
 * day differs). In `leading` mode (the fill pane, item 1) the first timed row
 * ALSO gets a header — the fill TIME cell is time-of-day only, so the top day
 * needs its own anchor; the one-shot print path keeps the boundary-only rule
 * because its inline-date TIME cell already anchors the first day.
 */
export function queueTimelineDateHeaderAt(
  rows: readonly QueueTimelineProjectedRow[],
  index: number,
  leading: boolean,
): string | null {
  const current = rows[index]
  if (current === undefined) return null
  if (leading && index === 0) {
    return current.timestamp === null ? null : timelineLocalCalendarDay(current.timestamp)
  }
  return queueTimelineDateSeparatorLabel(rows[index - 1], current)
}

/**
 * The FILTER row (user respec 2026-07-15): only non-default dimensions render
 * — `since=` always has a value, `terms=` only when terms were passed, `latest`
 * only when on; no `none`/`no`/`all` placeholders. The status buckets render as
 * pills: a pointer click or lowercase o/r/d/f SELECTS ONLY that bucket, and
 * capital O/R/D/F toggles one bucket's membership (power path, unadvertised)
 * — user respec 2026-07-23. `all` is back in this cluster (operator,
 * 2026-08-19), where it sat before item 9 moved it out: it clears both filter
 * kinds, and the queue selector at the top now reads as tabs, which is no
 * place for a pill that is not a queue.
 */
function TimelineFilterLine({
  projection,
  buckets,
  onSelectBucket,
  onShowAll,
  allActive = true,
}: {
  projection: QueueTimelineProjection
  buckets: ReadonlySet<QueueTimelineStatusBucket>
  onSelectBucket?: (bucket: QueueTimelineStatusBucket) => void
  onShowAll?: () => void
  allActive?: boolean
}) {
  const filters = projection.filters
  // The "FILTER" label text is deleted (item 3): the pills stand alone. The
  // non-default dimensions (`since=` only when the window is bounded, `terms=`
  // only when terms were passed, `latest` only when on) survive as a dim group
  // label; the common unbounded/no-terms watch renders no label at all.
  const bounded = filters.windowMs < QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS
  const dimensions = [
    bounded ? `since=${mediaDuration(filters.windowMs)}` : "",
    filters.terms.length === 0 ? "" : `terms=${filters.terms.join("|")}`,
    filters.latest ? "latest" : "",
  ]
    .filter(Boolean)
    .join(" ")
  // The status buckets are TogglePills labelled by their plain word with a
  // BOLD first letter — `open`/`running`/`done`/`failed` (user respec
  // 2026-07-23), the bold o/r/d/f doubling as the hotkey hint (no `[o]`
  // brackets). Click or lowercase key = select ONLY that bucket; capital
  // letters toggle membership (unadvertised). The whole cluster sits very dim
  // and lifts together on hover (silvery TogglePillGroup).
  return (
    <TogglePillGroup
      {...(dimensions === "" ? {} : { label: dimensions })}
      flexShrink={0}
      minWidth={0}
      overflow="hidden"
    >
      {QUEUE_TIMELINE_STATUS_BUCKETS.map((bucket) => (
        <TogglePill
          key={bucket}
          label={bucket}
          boldFirstLetter
          active={buckets.has(bucket)}
          onToggle={() => onSelectBucket?.(bucket)}
        />
      ))}
      {onShowAll === undefined ? null : (
        <TogglePill label="all" boldFirstLetter active={allActive} onToggle={() => onShowAll()} />
      )}
    </TogglePillGroup>
  )
}

/**
 * The one temporal-trust cue, `updated HH:MM:SS`. The snapshot clock is always
 * "now", so day qualification never applies. The QUEUE pane renders it flush
 * against the title border (its `flushTop` drops the top padding) so it reads
 * as aligned with the QUEUE title rather than floating below an offset gap
 * (user directive 2026-07-16).
 */
/**
 * `yrd queue list` rows lead with label + FQN (operator ruling 2026-08-18,
 * item 36): one row per queue — the config handle (base branch when none is
 * declared) bright, then the typeable `path@branch` address muted. Rendered
 * only when a queue HAS a path-qualified address to type; the live watch
 * keeps the pretty forms on its pills instead.
 */
function QueueAddressRows({ queues }: { queues: readonly QueueTimelineQueue[] }) {
  const addressed = queues.filter((queue) => queue.address.includes("@"))
  if (addressed.length === 0) return null
  const labelWidth = Math.max(0, ...addressed.map((queue) => queueRunLabel(queue).length)) + 2
  return (
    <Box flexDirection="column" minWidth={0} flexShrink={0}>
      {addressed.map((queue) => (
        <Box key={queue.address} height={1} flexDirection="row" minWidth={0} overflow="hidden">
          <Text flexShrink={0}>{queueRunLabel(queue).padEnd(labelWidth)}</Text>
          <Text color="$fg-muted" wrap="truncate" minWidth={0}>
            {queue.address}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function QueueUpdatedClock({ now }: { now: string }) {
  return (
    <Text color="$fg-muted" flexShrink={0}>
      updated {queueLogClock(now, false, false)}
    </Text>
  )
}

function ProjectedQueueTimeline({
  repositoryRoot,
  projection,
  runnerRefusal,
  results,
  state,
  nav,
  cursorKey,
  onCursor,
  onSelect,
  columns,
  paneChrome = false,
  fillHeight = false,
  availableRows,
  visibleBuckets,
  visibleQueues,
  expandedStorms,
  onSelectBucket,
  onShowAll,
  allFiltersActive = true,
  listRef,
}: {
  repositoryRoot?: string
  projection: QueueTimelineProjection
  runnerRefusal?: QueueRunnerRefusal
  results?: readonly QueueStatusResult[]
  state?: BaysState
  nav: boolean
  cursorKey?: number
  onCursor?: (index: number) => void
  onSelect?: (index: number) => void
  columns: number
  paneChrome?: boolean
  fillHeight?: boolean
  /** Actual queue-pane height when hosted in a split; viewport height otherwise. */
  availableRows?: number
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>
  /** Bases currently shown; undefined means every queue, the default. */
  visibleQueues?: ReadonlySet<string>
  expandedStorms?: ReadonlySet<string>
  onSelectBucket?: (bucket: QueueTimelineStatusBucket) => void
  /** Clears both filter kinds; renders the `all` pill beside the status pills. */
  onShowAll?: () => void
  allFiltersActive?: boolean
  listRef?: React.Ref<ListViewHandle>
}) {
  // Fold the complete visible set before applying the one-shot row cap. A
  // retry storm must cost one display row everywhere, not `limit` rows plus
  // a misleading raw-row remainder outside the interactive fill pane.
  const displayRows = queueTimelineDisplayRows(
    queueTimelineVisibleRows(projection, visibleBuckets, true, visibleQueues),
    expandedStorms,
  )
  const rows = fillHeight ? displayRows : timelineRetainedRows(displayRows, projection.display.shown)
  const hiddenDisplayRows = Math.max(0, displayRows.length - rows.length)
  const buckets = visibleBuckets ?? queueTimelineFilterBuckets(projection.filters.statuses)
  // In the fill pane the TIME cell is time-of-day only (item 1) and the day is
  // carried by YYYY-MM-DD header rows (leading + per-boundary, below). The
  // one-shot print path is pinned: it keeps the inline-date TIME cell when the
  // visible window spans more than one local day.
  const includeDate =
    !fillHeight &&
    rows.some((row) => row.timestamp !== null && row.timestamp.slice(0, 10) !== projection.now.slice(0, 10))
  // One RUN-cell model per row, derived once against display ORDER: batch
  // continuation needs each row's predecessor, and the label-elide rule needs
  // the visible-queue count (items 34/38). "Visible" is the ON filter subset
  // — a queue toggled on with no rows in the window still counts, so the ALL
  // view never elides just because one queue happens to be quiet.
  const runLabels = timelineRunLabels(projection.queues)
  const visibleQueueCount = projection.queues.filter(
    ({ base }) => visibleQueues === undefined || visibleQueues.has(base),
  ).length
  const showQueueLabel = timelineShowQueueLabel(visibleQueueCount)
  const runCells = rows.map((row, index) =>
    timelineRunCellModel(row, runLabels, showQueueLabel, timelineRunContinues(row, rows[index - 1])),
  )
  const layout = timelineCellLayout(rows, includeDate, columns, runCells)
  // The one-shot print's queue surfaces (pills + address rows) fall back to
  // the submodule-level repositoryRoot for queues whose projection predates
  // the loader threading it.
  const printQueues = projection.queues.map((queue) =>
    queue.path === undefined && repositoryRoot !== undefined
      ? { ...queue, path: repositoryRoot, address: queueFullName({ path: repositoryRoot, base: queue.base }) }
      : queue,
  )
  const { rows: viewportRows } = useWindowSize()
  return (
    <Box width="100%" minWidth={0} minHeight={0} flexGrow={fillHeight ? 1 : undefined}>
      <Box flexGrow={1} flexBasis={0} maxWidth={TIMELINE_CONTENT_CAP} flexDirection="column" minWidth={0} minHeight={0}>
        {paneChrome ? null : (
          // One-shot prints lead with the same YRD QUEUES top line the live
          // frame owns (items 30/33) — the old `QUEUE main` / `ROOT /hh`
          // header row is deleted, the pills carry the queue identity — and
          // keep the muted `updated HH:MM:SS` stamp on its own row beneath it
          // (item 30's sub-point: the stamp survives, never on the top line;
          // the live pane's temporal-trust cue stays the RUNNER border timer,
          // user directive 2026-07-21). The live frame renders its top line
          // itself, above the split, so `paneChrome` contributes no header.
          <>
            <QueueTopLine queues={printQueues} />
            <Box height={1} flexDirection="row" justifyContent="flex-end" gap={1} minWidth={0}>
              <QueueUpdatedClock now={projection.now} />
            </Box>
            <QueueAddressRows queues={printQueues} />
          </>
        )}
        <TimelineRunnerBox
          projection={projection}
          runnerRefusal={runnerRefusal}
          results={results}
          state={state}
          live={nav}
          columns={columns}
        />
        {/* No blank row above the table header (item 5): the header sits flush
            under the boxes above it. The pills + coverage row moved BELOW the
            list (item 2), rendered after the rows block. */}
        {rows.length === 0 ? (
          <Text color="$fg-muted">No matching queue rows.</Text>
        ) : (
          // In fill mode (item 5) the row block claims the pane's vertical
          // slack so the virtualizing ListView shows as many rows as fit and
          // scrolls the rest; STATS then anchors at the bottom. Off fill it
          // stays content-sized.
          <Box flexDirection="column" minWidth={0} flexShrink={1} minHeight={0} flexGrow={fillHeight ? 1 : undefined}>
            <TimelineHeader layout={layout} />
            <ListView
              ref={listRef}
              items={rows}
              nav={nav}
              cursorKey={cursorKey}
              onCursor={onCursor}
              onSelect={onSelect}
              // Hover must NOT move the selection / detail pane (user directive
              // 2026-07-16, item P). Overriding onItemHover suppresses ListView's
              // default hover→cursor (which fires onCursor and switches the
              // detail); CLICK still selects via the default onSelect path.
              onItemHover={NO_HOVER_SELECT}
              // Explicit, because the DEFAULT is mount-all for lists up to
              // 10,000 items (threshold raised 100 → 10,000 in 15332 W3/W7 for
              // silvercode chat) and timeline rows are EXPENSIVE: a ~1,000-row
              // production timeline mounted every row, and the render pipeline
              // walked all of them on every frame — ~260 KB RSS and ~2 idle-CPU
              // points per 100 rows on a live pane, with ~40 rows visible
              // (@yrd/cli/22258). Index-window mode bounds the mounted set to
              // ~100 rows around the cursor/viewport regardless of retention.
              virtualization="index"
              active={true}
              getKey={(row) => row.id}
              // A date-header entry grows one cell to two: the separator sits
              // ABOVE the row inside the same list item, so `items`/`getKey`/
              // `cursorKey`/`onCursor`/`onSelect` all keep their existing
              // one-entry-per-row index contract with the caller (watch-pane's
              // externally computed `cursor` indexes this exact `rows` array).
              estimateHeight={(index) => (queueTimelineDateHeaderAt(rows, index, fillHeight) === null ? 1 : 2)}
              renderItem={(row, index, meta) => {
                const dateSeparator = queueTimelineDateHeaderAt(rows, index, fillHeight)
                const entry = (
                  <TimelineProjectedRow
                    row={row}
                    runCell={runCells[index] ?? { kind: "none" }}
                    cursor={meta.isCursor}
                    hovered={meta.isHovered}
                    layout={layout}
                    live={nav}
                  />
                )
                return dateSeparator === null ? (
                  entry
                ) : (
                  <Box flexDirection="column">
                    <Text variant="h1">{dateSeparator}</Text>
                    {entry}
                  </Box>
                )
              }}
            />
          </Box>
        )}
        {/* An empty fill pane's spacer pushes the pills + STATS panel to
            the bottom; a non-empty fill pane grows its row block instead, so no
            spacer competes with it. */}
        {fillHeight && rows.length === 0 ? <Box flexGrow={1} minHeight={0} /> : null}
        {/* The bottom row keeps ONLY the status pills, right-aligned
            (operator ruling 2026-08-18, item 32) — the queue pills and the
            `all` pill moved to the top line, which is where filtering by
            queue now lives. One-shot prints keep their coverage facts
            ("... N more" / retained horizon) on the left of this row; the
            fill pane suppresses both (rows virtualize, nothing is hidden). */}
        <Box height={1} flexDirection="row" minWidth={0} overflow="hidden">
          <Box flexGrow={1} flexBasis={0} flexDirection="row" gap={1} minWidth={0} flexShrink={1}>
            {fillHeight || hiddenDisplayRows === 0 ? null : (
              <Text color="$fg-muted" wrap="truncate">
                ... {hiddenDisplayRows} more
              </Text>
            )}
            {fillHeight || projection.coverage.complete ? null : (
              <Text color="$fg-warning" wrap="truncate">
                retained since {projection.coverage.retainedSince}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" justifyContent="flex-end" minWidth={0} flexShrink={0}>
            <TimelineFilterLine
              projection={projection}
              buckets={buckets}
              onSelectBucket={onSelectBucket}
              {...(onShowAll === undefined ? {} : { onShowAll })}
              allActive={allFiltersActive}
            />
          </Box>
        </Box>
        {!fillHeight ||
        (availableRows ?? viewportRows) === 0 ||
        (availableRows ?? viewportRows) >= QUEUE_STATS_MIN_PANE_ROWS ? (
          <QueueStatsPanel
            facts={projection.timeStatsFacts}
            now={projection.now}
            earliestFactMs={projection.earliestFactMs}
            width={columns}
          />
        ) : null}
      </Box>
    </Box>
  )
}

export function QueueTimelineView({
  repositoryRoot,
  projection,
  runnerRefusal,
  results,
  now,
  latest = false,
  state,
  nav = false,
  cursorKey,
  onCursor,
  onSelect,
  columns = 120,
  paneChrome = false,
  fillHeight = false,
  availableRows,
  visibleBuckets,
  visibleQueues,
  expandedStorms,
  onSelectBucket,
  onShowAll,
  allFiltersActive = true,
  listRef,
}: {
  repositoryRoot?: string
  projection?: QueueTimelineProjection
  runnerRefusal?: QueueRunnerRefusal
  results?: readonly QueueStatusResult[]
  now?: number
  latest?: boolean
  state?: BaysState
  nav?: boolean
  cursorKey?: number
  onCursor?: (index: number) => void
  onSelect?: (index: number) => void
  columns?: number
  paneChrome?: boolean
  fillHeight?: boolean
  availableRows?: number
  visibleBuckets?: ReadonlySet<QueueTimelineStatusBucket>
  visibleQueues?: ReadonlySet<string>
  expandedStorms?: ReadonlySet<string>
  onSelectBucket?: (bucket: QueueTimelineStatusBucket) => void
  /** Clears both filter kinds; renders the `all` pill beside the status pills. */
  onShowAll?: () => void
  allFiltersActive?: boolean
  listRef?: React.Ref<ListViewHandle>
}) {
  if (projection !== undefined) {
    // 15e: the list is left-flush — no gutter, no centering; the surface
    // still caps at 160 cells on wide viewports.
    const surfaceWidth = Math.max(1, Math.min(columns, TIMELINE_CONTENT_CAP))
    return (
      <ProjectedQueueTimeline
        repositoryRoot={repositoryRoot}
        projection={projection}
        runnerRefusal={runnerRefusal}
        results={results}
        state={state}
        nav={nav}
        cursorKey={cursorKey}
        onCursor={onCursor}
        onSelect={onSelect}
        columns={surfaceWidth}
        paneChrome={paneChrome}
        fillHeight={fillHeight}
        availableRows={availableRows}
        visibleBuckets={visibleBuckets}
        visibleQueues={visibleQueues}
        expandedStorms={expandedStorms}
        onSelectBucket={onSelectBucket}
        {...(onShowAll === undefined ? {} : { onShowAll })}
        allFiltersActive={allFiltersActive}
        listRef={listRef}
      />
    )
  }
  if (results === undefined || now === undefined) {
    throw new Error("yrd: queue timeline requires results and snapshot time")
  }
  const rows = queueTimelineRows(results, now, latest, state)
  return (
    <Box flexDirection="column">
      {results.map((result) => (
        <SummaryQueue
          key={result.base}
          projection={humanQueueProjection(result, now)}
          repositoryRoot={repositoryRoot}
        />
      ))}
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching queue rows.</Text>
      ) : (
        <ListView
          ref={listRef}
          items={rows}
          nav={nav}
          cursorKey={cursorKey}
          onCursor={onCursor}
          onSelect={onSelect}
          active={true}
          getKey={(row) => row.key}
          // Same mount-all default hazard as the projection timeline above
          // (@yrd/cli/22258): this legacy path can also carry hundreds of rows.
          virtualization="index"
          estimateHeight={1}
          renderItem={(row, _index, meta) => (
            <Box height={1}>
              <Text wrap="truncate">
                {meta.isCursor ? "> " : "  "}
                <Text bold>{row.clock}</Text> <Text bold>{row.status}</Text>{" "}
                <QueueChangeId pr={row.pr} revision={row.revision} />{" "}
                {row.run === undefined ? "-" : <RunId base={row.base} run={row.run} />} {row.subject}{" "}
                <Text color="$fg-muted">{row.detail}</Text>
              </Text>
            </Box>
          )}
        />
      )}
    </Box>
  )
}

export function queueLogRows(
  results: readonly QueueLogResult[],
  selectedPrs: ReadonlySet<string>,
  changeFilter: string | undefined,
  changeStatus?: ReadonlyMap<string, ChangeDeliveryState>,
  attempts: readonly QueueLogAttempt[] = [],
  revisionSubjects: ReadonlyMap<string, string> = new Map(),
  revisionClocks?: ReadonlyMap<string, ChangeRunRevisionClock>,
): QueueLogRow[] {
  const rows: QueueLogRow[] = []
  const finished = results.flatMap((result) => result.finished)
  // Record membership decides derived-member clock tolerance in
  // queueLogSubmissionTime — the set-membership rule, never a number frontier.
  // S7 makes the tolerance direction explicit: `results[].prs` is the LEGACY
  // history arm; as the store drains this set shrinks toward empty, at which
  // point every member is derived and the tolerance is unconditional BY THE
  // SAME RULE (an empty set has no members), not by accident. What must stay
  // loud is the other direction: a member that IS in this set and still has
  // no clock throws inside queueLogSubmissionTime.
  const recordIds = new Set(results.flatMap((result) => result.prs ?? []).map((record) => record.id))

  for (const result of results) {
    for (const run of result.finished) {
      for (const pr of run.prs) {
        if (selectedPrs.size > 0 && !selectedPrs.has(pr.id)) continue
        if (changeFilter !== undefined && pr.id !== changeFilter) continue
        const outcome = queueOutcome(run)
        if (outcome === "running" || outcome === "waiting") continue

        const runError =
          run.error?.message ??
          run.steps
            .toReversed()
            .map((step) => step.job)
            .find((job) => job?.status === "completed" && job.conclusion === "failure")?.error?.message ??
          "-"
        const location = runLocation(run)
        const locations = runLocations(run)
        const runAttempts = attempts.filter((attempt) => attempt.run === run.id)
        const attemptSummaries = runAttempts.map(
          ({
            job,
            run: attemptRun,
            step,
            index,
            attempt,
            runner,
            outcome: attemptOutcome,
            startedAt,
            finishedAt,
            durationMs,
          }) => ({
            job,
            run: attemptRun,
            step,
            index,
            attempt,
            runner,
            outcome: attemptOutcome,
            ...taskStatusFields(jobAttemptTaskStatusOf({ outcome: attemptOutcome })),
            startedAt,
            finishedAt,
            durationMs,
          }),
        )
        const durations = runDurations(run, runAttempts)
        const durationMs = durations.totalDurationMs
        const finishedAt = run.finishedAt === undefined ? undefined : toIso(run.finishedAt)
        const submittedAt = queueLogSubmissionTime(revisionClocks, run, pr, recordIds)
        const ageMs = elapsedMs(submittedAt, finishedAt, `change '${pr.id}' submitted-to-terminal age`)
        const showLocation = changeStatus?.get(pr.id) === "withdrawn" ? undefined : location
        const taskStatus = runTaskStatusOf(run)
        rows.push({
          run: run.id,
          base: run.base,
          pr: pr.id,
          branch: pr.branch,
          subject: revisionSubjects.get(queueRevisionKey(pr)) ?? pr.branch,
          ...taskStatusFields(taskStatus),
          revision: String(pr.revision),
          headSha: pr.headSha,
          baseSha: pr.baseSha ?? "-",
          outcome,
          startedAt: toIso(run.startedAt),
          ...(finishedAt === undefined ? {} : { finishedAt }),
          submittedAt,
          started: toIso(run.startedAt),
          finished: finishedAt ?? "-",
          age: ageMs === undefined ? "-" : preciseDuration(ageMs),
          ...(ageMs === undefined ? {} : { ageMs }),
          duration: duration(run.startedAt, run.finishedAt),
          ...(durationMs === undefined ? {} : { durationMs }),
          totalDuration: durationMs === undefined ? "-" : preciseDuration(durationMs),
          ...(durationMs === undefined ? {} : { totalDurationMs: durationMs }),
          activeDuration: durations.activeDurationMs === undefined ? "-" : preciseDuration(durations.activeDurationMs),
          ...(durations.activeDurationMs === undefined ? {} : { activeDurationMs: durations.activeDurationMs }),
          waitDuration: durations.waitDurationMs === undefined ? "-" : preciseDuration(durations.waitDurationMs),
          ...(durations.waitDurationMs === undefined ? {} : { waitDurationMs: durations.waitDurationMs }),
          attempts: attemptSummaries,
          activeSteps: durations.activeSteps,
          retries: String(Math.max(0, runOutputQueueageIndex(finished, run, pr.revision, pr.id))),
          merge: queueMerge(run),
          integration:
            (outcome === "integrated" || outcome === "already-landed") &&
            run.status === "completed" &&
            run.conclusion === "success"
              ? queueOutcomeIntegration(run)
              : undefined,
          parent: run.parent ?? "-",
          isolationPart: isolationPartLabel(run),
          result: safeText(run.prs.length > 0 ? run.prs : ["-"]),
          error: safeText(runError),
          ...propsField(pr),
          locations,
          ...(showLocation === undefined
            ? {}
            : "path" in showLocation
              ? { location: { path: showLocation.path } }
              : { location: { url: showLocation.url } }),
        })
      }
    }
  }

  if (changeFilter !== undefined) {
    const runPrs = changeStatus
    const status = runPrs?.get(changeFilter)
    const matching = rows.filter((row) => row.pr === changeFilter)
    if (status === "withdrawn" && matching.length === 0) {
      // Derived world first: the retained run-member snapshot is the journaled
      // identity; the record (when the store still holds one) is the legacy
      // enrichment arm.
      const memberMatch = Array.from(results)
        .flatMap((result) => result.finished)
        .flatMap((run) => run.prs)
        .find((candidate) => candidate.id === changeFilter)
      const exampleResult =
        memberMatch ?? results.flatMap((result) => result.prs ?? []).find((pr) => pr.id === changeFilter)
      const exampleRevision =
        exampleResult === undefined
          ? undefined
          : "revs" in exampleResult
            ? currentChangeRev(exampleResult)
            : { n: exampleResult.revision, head: exampleResult.headSha, baseSha: exampleResult.baseSha }
      const headSha = (exampleRevision?.head ?? "-").slice(0, 40)
      const baseSha = (exampleRevision?.baseSha ?? "-").slice(0, 40)
      const exampleKey =
        exampleResult === undefined || exampleRevision === undefined
          ? undefined
          : queueRevisionKey({ id: exampleResult.id, revision: exampleRevision.n, headSha: exampleRevision.head })
      const taskStatus = runTaskStatusOf({ status: "retired" })
      rows.push({
        run: "-",
        base: exampleResult?.base ?? "-",
        pr: changeFilter,
        branch: exampleResult?.branch ?? "-",
        subject:
          (exampleKey === undefined ? undefined : revisionSubjects.get(exampleKey)) ??
          exampleResult?.branch ??
          changeFilter,
        ...taskStatusFields(taskStatus),
        revision: String(exampleRevision?.n ?? 0),
        headSha,
        baseSha,
        outcome: "retired",
        startedAt: "-",
        started: "-",
        finished: "-",
        age: "-",
        duration: "-",
        totalDuration: "-",
        activeDuration: "-",
        waitDuration: "-",
        attempts: [],
        activeSteps: [],
        retries: "0",
        merge: "-",
        parent: "-",
        isolationPart: "-",
        result: "-",
        error: "-",
        ...propsField(exampleResult),
        locations: [],
      })
    } else if (
      matching.length === 0 &&
      // A change riding a live (running/waiting) run is not unretained — the
      // log simply has no FINISHED run for it yet; that state stays rowless.
      !results.some((result) =>
        [...result.running, ...result.waiting].some((run) =>
          run.prs.some((member) => member.id === changeFilter || member.branch === changeFilter),
        ),
      ) &&
      // A LIVE record with no terminal rows is a normal pre-run state (a
      // pushed draft, a pending submit) — the view's plain empty message is
      // the right answer and the timeline carries the live row. The loud
      // absence row is for a change the snapshot does not know AT ALL, which
      // post-purge (empty `prs`) is every unretained selector.
      !results.some((result) => (result.prs ?? []).some((record) => record.id === changeFilter))
    ) {
      // NSE-4: a filtered change with no retained run must say so and name
      // what was searched — zero rows reads as "the log is empty", which is a
      // different fact. Post-purge the withdrawn arm above cannot fire (its
      // status map is record-derived), so this is the loud floor for EVERY
      // filtered miss.
      const memberCount = finished.reduce((count, run) => count + run.prs.length, 0)
      const taskStatus = runTaskStatusOf({ status: "retired" })
      rows.push({
        run: "-",
        base: results[0]?.base ?? "-",
        pr: changeFilter,
        branch: "-",
        subject: changeFilter,
        ...taskStatusFields(taskStatus),
        revision: "0",
        headSha: "-",
        baseSha: "-",
        outcome: "unretained",
        startedAt: "-",
        started: "-",
        finished: "-",
        age: "-",
        duration: "-",
        totalDuration: "-",
        activeDuration: "-",
        waitDuration: "-",
        attempts: [],
        activeSteps: [],
        retries: "0",
        merge: "-",
        parent: "-",
        isolationPart: "-",
        result: `no retained runs for '${changeFilter}' — searched ${finished.length} retained runs (${memberCount} members)`,
        error: "-",
        locations: [],
      })
    }
  }

  return rows.toSorted((left, right) => {
    const leftAt = Date.parse(left.started)
    const rightAt = Date.parse(right.started)
    if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) {
      return byRunStarted(
        { id: left.run, startedAt: left.started, base: left.base } as Run,
        { id: right.run, startedAt: right.started, base: right.base } as Run,
      )
    }
    if (Number.isNaN(leftAt)) return 1
    if (Number.isNaN(rightAt)) return -1
    if (leftAt !== rightAt) return leftAt - rightAt
    return parseRunIdSuffix(left.run) - parseRunIdSuffix(right.run)
  })
}

function queueShowStepRow(run: Run, step: QueueStep): QueueShowRow {
  const location = artifactLocation(step)
  const locations = stepLocations(step)
  const command = stepCommand(step)
  const taskStatus = stepTaskStatusOf(step)
  const stepFailure = failureFact(undefined, step)
  const gate = step.job !== undefined && "output" in step.job ? gateEvidenceFromOutput(step.job.output) : undefined
  const stepDurationMs =
    step.job === undefined || !("startedAt" in step.job) || !("finishedAt" in step.job)
      ? undefined
      : elapsedMs(step.job.startedAt, step.job.finishedAt)
  return {
    step: step.name,
    revision: step.revision,
    status: jobStatus(step),
    ...taskStatusFields(taskStatus),
    attempt: step.job === undefined ? "-" : String(step.job.attempt),
    uuid: step.job?.id ?? "-",
    runner: step.job !== undefined && "runner" in step.job ? step.job.runner : "-",
    lease: step.job?.status === "in_progress" ? toIso(step.job.leaseExpiresAt) : "-",
    requested: step.job === undefined ? "-" : toIso(step.job.requestedAt),
    started: step.job === undefined || !("startedAt" in step.job) ? "-" : toIso(step.job.startedAt),
    changed: step.job === undefined ? "-" : toIso(step.job.changedAt),
    finished:
      step.job === undefined || step.job.status === "in_progress" || step.job.status === "queued"
        ? "-"
        : toIso((step.job as { finishedAt?: string } | undefined)?.finishedAt),
    duration: step.job === undefined ? "-" : stepDuration(step),
    ...(stepDurationMs === undefined ? {} : { durationMs: stepDurationMs }),
    ...(command === undefined ? {} : { command }),
    errorCode: stepErrorCode(step),
    error: stepError(step),
    ...(stepFailure === undefined ? {} : { failure: projectFailure(stepFailure) }),
    lost: stepLost(step),
    detail: stepDetail(step),
    output: stepOutput(step),
    artifacts: stepArtifactsText(step),
    evidence: stepEvidence(step, gate),
    ...(gate === undefined ? {} : { gate }),
    checkpoint: stepCheckpointText(step),
    merge: queueMerge(run),
    locations,
    ...(location === undefined ? {} : { location }),
  }
}

function queueShowAttemptRow(run: Run, attempt: QueueAttempt): QueueShowRow {
  const step = run.steps[attempt.index] ?? run.steps.find((candidate) => candidate.name === attempt.step)
  if (step?.job?.id === attempt.job && step.job.attempt === attempt.attempt) {
    return {
      ...queueShowStepRow(run, step),
      requested: toIso(attempt.requestedAt),
      started: toIso(attempt.startedAt),
      finished: toIso(attempt.finishedAt),
      duration: preciseDuration(attempt.durationMs),
      durationMs: attempt.durationMs,
    }
  }

  const output = attempt.result.status === "lost" ? undefined : attempt.result.output
  const gate = gateEvidenceFromOutput(output)
  const locations = attemptLocations(attempt)
  const firstLocation = locations[0]?.location
  const artifacts = attemptArtifacts(attempt)
  const detail = isObjectValue(output) && typeof output.detail === "string" ? output.detail : undefined
  const taskStatus = jobAttemptTaskStatusOf(attempt)
  const attemptFailure =
    attempt.result.status === "failed"
      ? projectFailure(attempt.result.error)
      : attempt.result.status === "lost"
        ? projectFailure({ code: "job-lost", message: attempt.result.reason })
        : undefined
  return {
    step: attempt.step,
    revision: attempt.revision,
    status: attempt.outcome,
    ...taskStatusFields(taskStatus),
    attempt: String(attempt.attempt),
    uuid: attempt.job,
    runner: attempt.runner,
    lease: "-",
    requested: toIso(attempt.requestedAt),
    started: toIso(attempt.startedAt),
    changed: toIso(attempt.finishedAt),
    finished: toIso(attempt.finishedAt),
    duration: preciseDuration(attempt.durationMs),
    durationMs: attempt.durationMs,
    errorCode: attempt.result.status === "failed" ? attempt.result.error.code : "-",
    error: attempt.result.status === "failed" ? attempt.result.error.message : "-",
    ...(attemptFailure === undefined ? {} : { failure: attemptFailure }),
    lost: attempt.result.status === "lost" ? attempt.result.reason : "-",
    detail: detail ?? (attempt.result.status === "failed" ? attempt.result.error.message : "-"),
    output:
      attempt.result.status === "lost"
        ? "-"
        : safeText(attempt.result.output ?? (attempt.result.status === "failed" ? attempt.result.error : undefined)),
    artifacts: artifacts.length === 0 ? "-" : artifactLabel(artifacts[0]),
    evidence:
      gate === undefined
        ? isObjectValue(output)
          ? output
          : "-"
        : isObjectValue(output)
          ? { ...output, gate: gateEvidenceLabel(gate) }
          : { gate: gateEvidenceLabel(gate) },
    ...(gate === undefined ? {} : { gate }),
    checkpoint: "-",
    merge: queueMerge(run),
    locations,
    ...(firstLocation === undefined ? {} : { location: firstLocation }),
  }
}

function queueShowRows(run: Run, attempts: readonly QueueAttempt[]): readonly QueueShowRow[] {
  const terminalStepIndex = run.steps.findIndex((step) => {
    const job = step.job
    return (
      job?.status === "completed" &&
      (job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "cancelled")
    )
  })
  const usedAttempts = new Set<QueueAttempt>()
  const planned = run.steps.flatMap((step, index) => {
    const stepAttempts = attempts.filter((attempt) => attempt.index === index)
    if (stepAttempts.length > 0) {
      for (const attempt of stepAttempts) usedAttempts.add(attempt)
      return stepAttempts.map((attempt) => queueShowAttemptRow(run, attempt))
    }
    const row = queueShowStepRow(run, step)
    const canceled =
      terminalStepIndex >= 0 && index > terminalStepIndex && (step.job === undefined || step.job.status === "queued")
    return canceled ? [{ ...row, status: "canceled", ...taskStatusFields("dropped") }] : [row]
  })
  const unplanned = attempts
    .filter((attempt) => !usedAttempts.has(attempt))
    .map((attempt) => queueShowAttemptRow(run, attempt))
  return [...planned, ...unplanned]
}

export function queueShowData(
  run: Run,
  allRuns: readonly Run[] = [],
  attempts: readonly QueueAttempt[] = [],
  revisionClock?: ChangeRunRevisionClock,
): QueueShowData {
  const finished = allRuns.filter((candidate) => candidate.status === "completed")
  const runAttempts = attempts
    .filter((attempt) => attempt.run === run.id)
    .toSorted((left, right) => left.index - right.index || left.attempt - right.attempt)
    .map((attempt) => ({ ...attempt, ...taskStatusFields(jobAttemptTaskStatusOf(attempt)) }))
  const durations = runDurations(run, runAttempts)
  const runDurationMs = durations.totalDurationMs
  const taskStatus = runTaskStatusOf(run)
  const outcome = queueOutcome(run)
  const mergeVerdict = mergeVerdictOfOutcome(outcome)
  const stepNames = stepNamesOfRun(run)
  const runFailure = failureFact(run, relevantStep(run))
  return {
    run: run.id,
    candidateId: run.candidateId,
    base: run.base,
    status: run.status,
    ...(run.conclusion === undefined ? {} : { conclusion: run.conclusion }),
    taskStatus,
    outcome,
    mergeVerdict,
    stepNames,
    started: toIso(run.startedAt),
    finished: run.finishedAt === undefined ? "-" : toIso(run.finishedAt),
    duration: runDurationMs === undefined ? "-" : preciseDuration(runDurationMs),
    ...(runDurationMs === undefined ? {} : { durationMs: runDurationMs }),
    totalDuration: runDurationMs === undefined ? "-" : preciseDuration(runDurationMs),
    ...(runDurationMs === undefined ? {} : { totalDurationMs: runDurationMs }),
    activeDuration: durations.activeDurationMs === undefined ? "-" : preciseDuration(durations.activeDurationMs),
    ...(durations.activeDurationMs === undefined ? {} : { activeDurationMs: durations.activeDurationMs }),
    waitDuration: durations.waitDurationMs === undefined ? "-" : preciseDuration(durations.waitDurationMs),
    ...(durations.waitDurationMs === undefined ? {} : { waitDurationMs: durations.waitDurationMs }),
    retries: queueShowRetries(finished, run),
    merge: queueMerge(run),
    integration: run.status === "completed" && run.conclusion === "success" ? queueIntegration(run) : undefined,
    parent: run.parent ?? "-",
    isolationPart: isolationPartLabel(run),
    ...(runFailure === undefined ? {} : { failure: projectFailure(runFailure) }),
    prs: run.prs,
    ...(revisionClock === undefined ? {} : { revisionClock }),
    attempts: runAttempts,
    steps: queueShowRows(run, runAttempts),
  }
}

export function QueueLogView({
  rows,
  coverage,
  columns = 120,
}: {
  rows: readonly QueueLogRow[]
  coverage?: QueueLogCoverage
  columns?: number
}) {
  const compact = columns <= 80
  const visibleRows = rows.toReversed().slice(0, 20)
  const visibleDates = new Set(
    visibleRows.flatMap((row) => {
      const timestamp = Date.parse(row.startedAt)
      return Number.isFinite(timestamp) ? [new Date(timestamp).toISOString().slice(0, 10)] : []
    }),
  )
  const includeDate = visibleDates.size > 1
  const tableRows = visibleRows.map((row) => ({
    ...row,
    clock: queueLogClock(row.startedAt, false, includeDate),
    level: queueLogLevel(row.outcome),
    baseLabel: `[${row.base}]`,
    runIdentity: formatNounId(row.base, runIdValue(row.run)),
    ageValue: `age=${row.ageMs === undefined ? "-" : relativeAge(row.ageMs)}`,
    totalValue: `total=${row.totalDurationMs === undefined ? "-" : mediaDuration(row.totalDurationMs)}`,
    activeValue: `active=${row.activeDurationMs === undefined ? "-" : mediaDuration(row.activeDurationMs)}`,
    waitValue: `wait=${row.waitDurationMs === undefined ? "-" : mediaDuration(row.waitDurationMs)}`,
  }))
  const identityColumns = compact
    ? []
    : [
        { header: "LEVEL", key: "level" as const, width: 5 },
        { header: "BASE", key: "baseLabel" as const, width: 12 },
      ]
  const logColumns = [
    { header: "TIME", key: "clock" as const, width: includeDate ? 21 : 9 },
    ...identityColumns,
    {
      header: "PR",
      key: "pr" as const,
      minWidth: compact ? 8 : 10,
      maxWidth: compact ? 12 : 16,
      render: (row: (typeof tableRows)[number]) => <QueueChangeId pr={row.pr} revision={row.revision} />,
    },
    { header: "RUN", key: "runIdentity" as const, minWidth: compact ? 8 : 10, maxWidth: compact ? 12 : 18 },
    { header: "OUTCOME", key: "outcome" as const, maxWidth: 13 },
    ...(compact
      ? []
      : [
          {
            header: "ART",
            key: "locations" as const,
            width: 9,
            render: (row: (typeof tableRows)[number]) => <QueueLogLocationLinks entries={row.locations} compact />,
          },
        ]),
    { header: "SUBJECT", key: "subject" as const, minWidth: 0, grow: true },
    { header: "AGE", key: "ageValue" as const, align: "right" as const },
    { header: "TOTAL", key: "totalValue" as const, align: "right" as const },
    { header: "ACTIVE", key: "activeValue" as const, align: "right" as const },
    { header: "WAIT", key: "waitValue" as const, align: "right" as const },
  ]
  const hidden = Math.max(0, rows.length - visibleRows.length)
  void coverage
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? (
        <Text color="$fg-muted">No matching terminal log rows.</Text>
      ) : (
        <Table data={tableRows} columns={logColumns} padding={1} showHeader={false} />
      )}
      {hidden === 0 ? null : <Text color="$fg-muted">... {hidden} more</Text>}
    </Box>
  )
}

function queueShowNextAction(data: QueueShowData): string {
  if (data.outcome === "integrated") return "none — merge proof is recorded"
  if (data.outcome === "already-landed") return "none — equivalence proof is recorded; no merge was needed"
  if (["queued", "in_progress", "waiting"].includes(data.status)) {
    return "follow live output or wait for the current step"
  }
  if (data.outcome === "canceled" || data.failure?.code === "run-canceled") {
    return "no resubmission — the change remains submitted and re-queues automatically"
  }
  const errorCode = presentFact(data.steps.findLast((step) => presentFact(step.errorCode) !== undefined)?.errorCode)
  const actionable = data.failure ?? data.steps.findLast((step) => step.failure !== undefined)?.failure
  if (actionable !== undefined) return actionable.resolution.join("; then ")
  if (errorCode === "queue-environment-refused") {
    return "repair the queue environment, then rerun the change"
  }
  if (["stale-pr", "stale-check", "stale-base"].includes(errorCode ?? "")) {
    return "refresh the current PR revision against queue authority, then rerun it"
  }
  if (errorCode === "job-lost") return "recover the lost run, then rerun the change"
  if (["canceled", "cancelled", "queue-canceled", "queue-cancelled"].includes(errorCode ?? "")) {
    return "inspect the newer PR revision; resubmit only if delivery is still required"
  }
  return "fix the branch and push; the same PR resumes automatically"
}

function queueShowFailureAction(
  failure: HumanFailureProjection,
  nextAction: string | undefined,
): HumanFailureProjection {
  return nextAction === undefined ? failure : { ...failure, resolution: [nextAction] }
}

function QueueShowMembersValue({ data, highlightPr }: { data: QueueShowData; highlightPr?: string }) {
  return (
    <>
      {data.prs.map((pr, index) => (
        <Text key={pr.id} color={pr.id === highlightPr ? "$fg-warning" : undefined}>
          {index === 0 ? "" : ","}
          <QueueChangeId pr={pr.id} revision={pr.revision} />:{pr.headSha.slice(0, 12)}
        </Text>
      ))}
    </>
  )
}

function QueueShowIdentityChain({ data }: { data: QueueShowData }) {
  return (
    <Text color="$fg-muted" wrap="truncate">
      CHAIN{" "}
      {data.prs.map((pr, index) => (
        <Text key={pr.id} color="inherit">
          {index === 0 ? "" : ","}
          <QueueChangeId pr={pr.id} revision={pr.revision} color="inherit" />
        </Text>
      ))}
      {" → "}
      {data.candidateId}
      {" → "}
      <RunId base={data.base} run={data.run} color="inherit" />
    </Text>
  )
}

// The batched-members group is called `PRs`, never `MEMBERS`. The list-selected
// member stays visibly highlighted so shared Run steps/logs do not erase which
// row the user chose.
function QueueShowMembersLine({ data, highlightPr }: { data: QueueShowData; highlightPr?: string }) {
  return (
    <Text wrap="truncate">
      PRs <QueueShowMembersValue data={data} highlightPr={highlightPr} />
    </Text>
  )
}

function queueGateSummary(data: QueueShowData): string | undefined {
  const gates = data.steps.flatMap((step) => (step.gate === undefined ? [] : [step.gate]))
  const [first] = gates
  if (first === undefined) return undefined
  const modes = new Set(gates.map(({ mode }) => mode))
  if (modes.size === 1) {
    return gateEvidenceLabel({
      mode: first.mode,
      residualCount: gates.reduce((total, { residualCount }) => total + residualCount, 0),
    })
  }
  return gates.map(gateEvidenceLabel).join(", ")
}

/**
 * Detail timestamps share the timeline's clock convention: local HH:MM:SS,
 * date-qualified only across day boundaries (relative to the local today).
 */
function detailClock(value: string): string {
  if (presentFact(value) === undefined) return value
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return value
  const includeDate = when.toDateString() !== new Date().toDateString()
  return queueLogClock(value, false, includeDate)
}

function QueueProofView({ data }: { data: QueueShowData }) {
  return (
    <Box flexDirection="column">
      {data.steps.length === 0 ? (
        <Text color="$fg-muted">No step evidence recorded.</Text>
      ) : (
        data.steps.map((row) => {
          const evidence = presentFact(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))
          const checkpoint = presentFact(row.checkpoint)
          return (
            <Box key={`${row.uuid}:${row.attempt}:proof`} height={1}>
              <Text wrap="truncate">
                {`PROOF ${row.step}#${row.attempt}`}
                {row.locations.length === 0 ? null : (
                  <>
                    {" ART "}
                    <QueueLogLocationLinks entries={row.locations} compact={false} />
                  </>
                )}
                {evidence === undefined ? "" : ` EVIDENCE ${evidence}`}
                {checkpoint === undefined ? "" : ` CHECKPOINT ${checkpoint}`}
              </Text>
            </Box>
          )
        })
      )}
      {presentFact(data.merge) === undefined ? null : (
        <Text>
          MERGE <Text color="$fg-muted">{queueMergeLabel(data.merge)}</Text>
        </Text>
      )}
    </Box>
  )
}

export function QueueEvidenceView({ data }: { data: QueueShowData }) {
  return (
    <Box flexDirection="column">
      <Text bold>EVIDENCE {data.run}</Text>
      <QueueProofView data={data} />
    </Box>
  )
}

/** Merge-owned merge facts shared by one-shot detail and the watch merge tab. */
export function QueueIntegrationFacts({ data }: { data: QueueShowData }) {
  if (data.integration === undefined) return null
  const proofDetail = integrationProofDetail(data.integration)
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text wrap="truncate">
        Committed as {data.integration.commit} on {data.base}
      </Text>
      {proofDetail === undefined ? null : <Text wrap="wrap">- integration proof: {proofDetail}</Text>}
    </Box>
  )
}

function changeReviewLine(review: Change["reviews"][number]): string {
  const note = presentFact(review.note)
  return `REVIEW ${review.decision} ${review.by} ${detailClock(review.at)}${note === undefined ? "" : ` — ${note}`}`
}

function changeCommentLine(comment: Change["comments"][number]): string {
  const note = presentFact(comment.note)
  return `COMMENT ${comment.by} ${detailClock(comment.at)}${note === undefined ? "" : ` — ${note}`}`
}

function runActivityState(data: QueueShowData): StatusNoticeState {
  if (data.status === "queued" || data.status === "in_progress" || data.status === "waiting") return "running"
  if (data.conclusion === "success") return data.integration === undefined ? "passed" : "integrated"
  if (data.failure !== undefined) return failureStatusClass(data.failure.code)
  return data.conclusion === "cancelled" ? "canceled" : "failed"
}

function changeTerminalLineageEntries(
  pr: Change,
  memberRevision: number,
  runDetails: readonly QueueShowData[],
): readonly ChangeActivityEntry[] {
  const terminal = changeRevisionClocks(pr)
    .filter((clock) => clock.revision <= memberRevision)
    .flatMap((clock) => {
      if (clock.terminal === undefined) return []
      const submittedAt = clock.submittedAt ?? clock.pushedAt
      const ageMs = elapsedMs(
        submittedAt,
        clock.terminal.at,
        `change '${pr.id}' revision ${clock.revision} terminal age`,
      )
      const reason =
        clock.terminal.kind === "rejected"
          ? (runDetails.find((detail) => detail.run === clock.terminal?.run)?.failure?.summary ?? "reason not recorded")
          : undefined
      const suffix = reason !== undefined ? ` (${reason})` : ageMs === undefined ? "" : ` (age ${mediaDuration(ageMs)})`
      return [{ at: clock.terminal.at, rank: 60, text: `r${clock.revision} ${clock.terminal.kind}${suffix}` }]
    })
  const submitted = pr.revs.find((revision) => revision.n === memberRevision)
  const submittedAt = submitted?.submittedAt ?? submitted?.pushedAt
  const entries =
    submittedAt === undefined
      ? terminal
      : [...terminal, { at: submittedAt, rank: 20, text: `submitted by ${submitted?.submitter ?? "-"}` }]
  return entries.toSorted(
    (left, right) => right.at.localeCompare(left.at) || right.rank - left.rank || left.text.localeCompare(right.text),
  )
}

function changeActivityEntries(
  pr: Change,
  runDetails: readonly QueueShowData[],
  currentRow: QueueTimelineProjectedRow | undefined,
): readonly ChangeActivityEntry[] {
  void currentRow
  const entries: ChangeActivityEntry[] = []
  const revisions = pr.revs
  // ONE line per revision (operator ruling 2026-08-18, item 31): a human
  // verb only where a human acted — `submitted by @chief` — while a machine
  // base-advance reads `re-merged onto <short-sha>` with no fabricated
  // "submitted by -" beside it.
  for (const revision of revisions) {
    const submitted = revision.submittedAt !== undefined
    const activityAt = revision.submittedAt ?? revision.pushedAt
    if (revision.recut !== undefined) {
      entries.push({
        at: revision.pushedAt,
        rank: 20,
        text: `r${revision.n} re-merged${revision.baseSha === undefined ? "" : ` onto ${revision.baseSha.slice(0, 8)}`}`,
      })
      continue
    }
    entries.push({
      at: activityAt,
      rank: 20,
      text: `r${revision.n} ${submitted ? "submitted" : "registered"} by ${revision.submitter ?? "-"}`,
    })
  }
  // The mechanical `check requested` echo renders ONLY when its time differs
  // from the revision row (a genuine re-request) — the same-transaction echo
  // is noise (item 31). The record carries no failure state yet; when it
  // does, a FAILED request must always render (failures never collapse).
  for (const request of pr.checkRequests) {
    const revision = revisions.find((candidate) => candidate.n === request.revision)
    const revisionAt = revision?.submittedAt ?? revision?.pushedAt
    const revisionAtMs = revisionAt === undefined ? Number.NaN : Date.parse(revisionAt)
    const requestAtMs = Date.parse(request.at)
    const echoesRevisionRow =
      Number.isFinite(revisionAtMs) &&
      Number.isFinite(requestAtMs) &&
      Math.abs(requestAtMs - revisionAtMs) <= CHECK_REQUEST_ECHO_TOLERANCE_MS
    if (echoesRevisionRow) continue
    entries.push({ at: request.at, rank: 30, text: `r${request.revision} check requested` })
  }
  for (const review of pr.reviews) {
    entries.push({
      at: review.at,
      rank: 40,
      text: `r${review.revision} review ${review.decision} by ${review.by}`,
      ...(presentFact(review.note) === undefined ? {} : { detail: presentFact(review.note) }),
    })
  }
  for (const comment of pr.comments) {
    entries.push({
      at: comment.at,
      rank: 50,
      text: `r${comment.revision} comment by ${comment.by}`,
      ...(presentFact(comment.note) === undefined ? {} : { detail: presentFact(comment.note) }),
    })
  }

  // Run rows stay plain history facts: the outcome is part of the sentence,
  // never a colored status chip fused onto the row (item 31 — the CURRENT
  // run's live status lives in the status box, its single home).
  const representedRuns = new Set<string>()
  for (const data of runDetails) {
    const member = data.prs.find((candidate) => candidate.id === pr.id)
    if (member === undefined) continue
    const at = presentFact(data.finished) ?? presentFact(data.started)
    if (at === undefined) continue
    representedRuns.add(`${member.revision}:${data.run}`)
    const state = runActivityState(data)
    entries.push({
      at,
      rank: 60,
      text: `r${member.revision} run ${formatNounId(data.base, runIdValue(data.run))} ${
        state === "failed" ? data.outcome : state
      }`,
      ...(data.failure === undefined ? {} : { detail: data.failure.summary }),
    })
  }

  // Old retained PRs can outlive their Run records. Preserve those terminal
  // clocks as honest activity without manufacturing details the journal lacks.
  for (const revision of revisions) {
    const terminal = revision.terminal
    if (terminal === undefined || representedRuns.has(`${revision.n}:${terminal.run}`)) continue
    entries.push({
      at: terminal.at,
      rank: 60,
      text: `r${revision.n}${terminal.run === undefined ? "" : ` run ${terminal.run}`} ${terminal.kind}`,
    })
  }

  // Newest first (operator spec item 4: "reverse-chronological history"),
  // matching prTerminalLineageEntries's own comparator above — the only two
  // producers QueueDetailRunChangeBlocks reads, so both need to agree here rather
  // than have their shared caller re-sort either one's output.
  return entries.toSorted(
    (left, right) => right.at.localeCompare(left.at) || right.rank - left.rank || left.text.localeCompare(right.text),
  )
}

function QueueChangeActivity({ entries }: { entries: readonly ChangeActivityEntry[] }) {
  if (entries.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {entries.map((entry, index) => (
        <Box key={`${entry.at}:${entry.rank}:${index}`} flexDirection="row" minWidth={0}>
          <Text color="$fg-muted" flexShrink={0}>
            {queueLogClock(entry.at, true, false)}{" "}
          </Text>
          <Text wrap="wrap" minWidth={0} bgConflict="ignore">
            {entry.text}
            {entry.detail === undefined ? "" : ` — ${entry.detail}`}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

type ChangeMetadataFact = Readonly<{ key: string; value: string; render?: () => React.ReactElement }>

/**
 * The per-change metadata under the ratified design (operator ruling
 * 2026-08-18, item 31): three groups separated by blank rows, no group labels,
 * keys muted uppercase in one fixed-width column —
 *
 *   identity — ISSUE, BY (plus the change's own annotations: NOTE, DETAIL,
 *     one row per prop, REVIEWERS, COMPOSITION, REGRESSIONS);
 *   dates — CREATED, UPDATED, COMMITS `first … · last … · N revisions`.
 *     The clock halves are supplied by the pr-dates retrofit
 *     ([[workedat-retrofit]]); until the record carries them only the
 *     revision count renders;
 *   code — HEAD `<short-sha> (rN)`, BASE, with the `▶ Diff +A −B` fold row
 *     rendered last by the caller.
 *
 * LIVE facts deliberately have no row here: position joined the status-box
 * headline, and Age · Runtime · Wait live on its timing line — the status
 * box is their single home. The mechanical check-requested echo moved to
 * HISTORY under its only-when-differing rule.
 */
function changeMetadataGroups(
  pr: Change | undefined,
  member: Readonly<{ id: string; revision: number; headSha: string; base?: string }>,
  issue: string | undefined,
  submitter: string | undefined,
): readonly (readonly ChangeMetadataFact[])[] {
  const retained = pr?.revs.find((candidate) => candidate.n === member.revision)
  const props = retained?.props
  const note = pr === undefined ? undefined : presentFact(pr.note)
  const detail = pr === undefined ? undefined : presentFact(pr.detail)
  const requestedReviewers = pr?.requestedReviewers ?? []
  const by = presentFact(submitter ?? retained?.submitter)
  const identity: ChangeMetadataFact[] = [
    ...(issue === undefined ? [] : [{ key: "issue", value: issue, render: () => <IssueValue issue={issue} /> }]),
    ...(by === undefined ? [] : [{ key: "by", value: by }]),
    ...(note === undefined ? [] : [{ key: "note", value: note }]),
    ...(detail === undefined ? [] : [{ key: "detail", value: detail }]),
    ...(props === undefined ? [] : Object.entries(props).map(([key, value]) => ({ key, value }))),
    ...(requestedReviewers.length === 0 ? [] : [{ key: "reviewers", value: requestedReviewers.join(", ") }]),
    ...(retained?.composition === undefined
      ? []
      : [{ key: "composition", value: boundedQueue(safeText(retained.composition), 160) }]),
  ]
  // Revision 0 is the unminted submit-fact contract: the branch is submitted
  // but no revision exists until admission mints one, so the revision count
  // and the `(rN)` head suffix would both be fabrications here.
  const unminted = member.revision === 0
  const revisionCount = pr?.revs.filter((candidate) => candidate.n <= member.revision).length ?? 1
  const dates: ChangeMetadataFact[] = unminted
    ? []
    : [
        // CREATED and UPDATED join this group when the pr-dates retrofit merges
        // them on the record; fabricating them from other clocks would be the
        // silent-fallback bug this file bans.
        { key: "commits", value: `${revisionCount} ${revisionCount === 1 ? "revision" : "revisions"}` },
      ]
  const headSha = retained?.head ?? (pr === undefined ? member.headSha : changeHead(pr))
  const code: ChangeMetadataFact[] = [
    { key: "head", value: unminted ? headSha.slice(0, 8) : `${headSha.slice(0, 8)} (r${member.revision})` },
    { key: "base", value: retained?.base ?? pr?.base ?? member.base ?? "-" },
  ]
  return [identity, dates, code].filter((group) => group.length > 0)
}

/** Shared by {@link QueueDetailChangeList} and {@link QueueDetailRunChangeBlocks}: the
 * one subject-resolution fallback chain, so the summary line and the full
 * per-change box can never show two different titles for the same PR. */
function memberSubject(
  member: Pick<QueueShowData["prs"][number], "id" | "name">,
  pr: Change | undefined,
  memberRow: QueueTimelineProjectedRow | undefined,
): string | undefined {
  return presentFact(pr?.title) ?? presentFact(member.name) ?? presentFact(pr?.name) ?? memberRow?.subject
}

/**
 * Directly under the status box (operator spec item 2): one line per run
 * member — `· pr#id.rev` then its bold title, ellipsis-truncated to width.
 * This is the "what's in this run" overview; full per-change detail (branch,
 * description, history, diff) lives in the Changes tab's boxes below
 * ({@link QueueDetailRunChangeBlocks}), which shares this exact subject fallback.
 */
export function QueueDetailChangeList({
  data,
  rows,
  prs,
}: {
  data?: QueueShowData
  rows: readonly QueueTimelineProjectedRow[]
  prs: readonly Change[]
}) {
  const members = data?.prs ?? []
  if (members.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0} flexShrink={0}>
      {members.map((member) => {
        const memberRow = rows.find(
          (candidate) =>
            candidate.pr === member.id &&
            candidate.revision === member.revision &&
            candidate.headSha === member.headSha,
        )
        const pr = prs.find((candidate) => candidate.id === member.id)
        const subject = memberSubject(member, pr, memberRow)
        return (
          <Box key={`${member.id}:${member.revision}:${member.headSha}`} flexDirection="row" minWidth={0}>
            <Text flexShrink={0}>{"· "}</Text>
            <QueueChangeId pr={member.id} revision={member.revision} color="$fg-warning" flexShrink={0} />
            <Text flexShrink={0}> </Text>
            {subject === undefined ? null : (
              <Text bold wrap="truncate" minWidth={0} bgConflict="ignore">
                {subject}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The per-change boxes of the detail pane (operator rulings 2026-08-18,
 * items 23/25): the pane's top is the RUN status box, no identity row above
 * it, so EVERY member's box — the cursor member included — carries its own
 * `pr#id.rev ⎇ branch` header, then the bold subject, the reverse-
 * chronological history, and the grouped metadata.
 */
export function QueueDetailRunChangeBlocks({
  data,
  row,
  rows,
  prs,
  runDetails = [],
  position,
  renderDiff,
}: {
  data?: QueueShowData
  row?: QueueTimelineProjectedRow
  rows: readonly QueueTimelineProjectedRow[]
  prs: readonly Change[]
  runDetails?: readonly QueueShowData[]
  /** Queue position for pending rows — reserved; the status box owns it now (item 31). */
  position?: number
  /** Diff slot for one change's box (operator spec item 4: "diff lines fronted
   * by a folding triangle marker"). Injected rather than owned here: the diff
   * toggle is a stateful silvery/React component (focus + expand/collapse)
   * that belongs with watch-pane's own interaction code, not with this
   * queue-projection file. Callers that have no diffs (both tests using this
   * block today) simply omit it. */
  renderDiff?: (member: Readonly<{ id: string; revision: number }>) => React.ReactNode
}) {
  const members =
    data?.prs ??
    (row === undefined
      ? []
      : [{ id: row.pr, revision: row.revision, headSha: row.headSha, branch: row.branch, base: row.base }])
  if (members.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0} flexShrink={0} color="$fg">
      {members.map((member, index) => {
        const memberRow = rows.find(
          (candidate) =>
            candidate.pr === member.id &&
            candidate.revision === member.revision &&
            candidate.headSha === member.headSha,
        )
        const pr = prs.find((candidate) => candidate.id === member.id)
        const subject = memberSubject(member, pr, memberRow)
        // Derived world first: the run-journaled snapshot's issue is this
        // revision's truth; the record's is the legacy enrichment arm. A
        // recordless member with a snapshot issue used to render this cell
        // blank.
        const issue = presentFact(("issue" in member ? member.issue : undefined) ?? pr?.issue)
        const description = descriptionWithoutDuplicatedIssue(presentFact(pr?.description), issue)
        // Newest first (operator spec item 4: "reverse-chronological
        // history") — both prTerminalLineageEntries and prActivityEntries
        // already sort that way; the one-entry fallback below has nothing to
        // order.
        const activity =
          pr === undefined
            ? memberRow?.timestamp === null || memberRow?.timestamp === undefined
              ? []
              : [
                  {
                    at: memberRow.timestamp,
                    rank: 20,
                    // Revision 0 = unminted submit fact: the submission exists,
                    // a revision does not (it mints at admission).
                    text:
                      member.revision === 0
                        ? "submitted — awaiting compose"
                        : `r${member.revision} submitted by ${memberRow.submitter ?? "-"}`,
                  },
                ]
            : data?.status === "completed" && member.revision === changeRevisionNumber(pr)
              ? changeTerminalLineageEntries(pr, member.revision, runDetails)
              : changeActivityEntries(pr, runDetails, memberRow ?? row)
        const memberSubmitter = (memberRow ?? row)?.submitter
        const metadataGroups = changeMetadataGroups(pr, member, issue, memberSubmitter)
        const factKeyWidth = Math.max(0, ...metadataGroups.flatMap((group) => group.map((fact) => fact.key.length))) + 2
        return (
          <TitledBox key={`${member.id}:${member.revision}:${member.headSha}`} title="" marginTop={index === 0 ? 0 : 1}>
            {/* Header line (items 4.a + 25): `pr#id.rev ⎇ branch` on EVERY
                member's box, the cursor member included — the pane title no
                longer carries any identity, so no member may skip its own.
                Revision 0 is the unminted submit-fact contract (a `factOnly`
                timeline row): no change id exists yet, so the header is the
                `⎇ branch` identity alone. */}
            <Box flexDirection="row" minWidth={0}>
              {member.revision === 0 ? null : (
                <>
                  <QueueChangeId
                    pr={member.id}
                    revision={member.revision}
                    color="$fg-warning"
                    wrap="truncate"
                    flexShrink={0}
                  />
                  <Text flexShrink={0}> </Text>
                </>
              )}
              {/* The ⎇ branch idiom (items 4/32d) — the same glyph the queue
                  pills spell, so the two surfaces share one convention. */}
              <Text internal_dim flexShrink={0}>
                {QUEUE_BRANCH_GLYPH}
              </Text>
              <Text wrap="wrap" minWidth={0}>
                {` ${member.branch}`}
              </Text>
            </Box>
            {subject === undefined ? null : (
              <>
                <Box height={1} flexShrink={0} />
                <Text bold wrap="wrap" bgConflict="ignore">
                  {subject}
                </Text>
              </>
            )}
            {description === undefined ? null : <DescriptionBlock description={description} />}
            {activity.length === 0 ? null : (
              <>
                <Box height={1} flexShrink={0} />
                <QueueChangeActivity entries={activity} />
              </>
            )}
            {metadataGroups.map((group, groupIndex) => (
              <Box key={`group:${groupIndex}`} flexDirection="column" minWidth={0}>
                <Box height={1} flexShrink={0} />
                {group.map((fact, factIndex) => (
                  <Box key={`${fact.key}:${factIndex}`} flexDirection="row" minWidth={0}>
                    <Text color="$fg-muted" flexShrink={0}>
                      {fact.key.toUpperCase().padEnd(factKeyWidth)}
                    </Text>
                    {fact.render === undefined ? (
                      <Text wrap="truncate" minWidth={0} bgConflict="ignore">
                        {fact.value}
                      </Text>
                    ) : (
                      fact.render()
                    )}
                  </Box>
                ))}
              </Box>
            ))}
            {renderDiff?.(member)}
          </TitledBox>
        )
      })}
    </Box>
  )
}

// PR-level facts (item J, 2026-07-16): the batched members' subject, review /
// comment / check-request activity, and revision history — none of which live
// on the run's `ChangeSnapshot`, so they are threaded from the full status PRs.
// Timestamps use the local detail clock; only present facts render; every row
// carrying an author-authored string sets `bgConflict="ignore"`.
export function QueueDetailChangeFacts({ prs }: { prs: readonly Change[] }) {
  if (prs.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {prs.map((pr, index) => {
        const name = presentFact(pr.name)
        const title = presentFact(pr.title)
        const issue = presentFact(pr.issue)
        const note = presentFact(pr.note)
        const description = presentFact(pr.description)
        const clocks = changeRevisionClocks(pr)
        return (
          <Box key={pr.id} flexDirection="column" minWidth={0} marginTop={index === 0 ? 0 : 1}>
            <Text wrap="truncate" bgConflict="ignore">
              <QueueChangeId pr={pr.id} revision={changeRevisionNumber(pr)} />
              {name === undefined ? "" : ` ${name}`}
            </Text>
            {title === undefined ? null : (
              <Text wrap="truncate" bgConflict="ignore">
                TITLE {title}
              </Text>
            )}
            {issue === undefined ? null : (
              <Text wrap="truncate">
                ISSUE <IssueValue issue={issue} />
              </Text>
            )}
            {note === undefined ? null : (
              <Text wrap="truncate" bgConflict="ignore">
                NOTE {note}
              </Text>
            )}
            {description === undefined ? null : (
              <Box flexDirection="column" minWidth={0}>
                <Text bold>DESCRIPTION</Text>
                <DescriptionBlock description={description} />
              </Box>
            )}
            {pr.reviews.map((review, reviewIndex) => (
              <Text key={`review:${reviewIndex}`} wrap="truncate" bgConflict="ignore">
                {changeReviewLine(review)}
              </Text>
            ))}
            {pr.comments.map((comment, commentIndex) => (
              <Text key={`comment:${commentIndex}`} wrap="truncate" bgConflict="ignore">
                {changeCommentLine(comment)}
              </Text>
            ))}
            {pr.checkRequests.map((request, requestIndex) => (
              <Text key={`check:${requestIndex}`} wrap="truncate">
                CHECK REQUESTED {detailClock(request.at)}
              </Text>
            ))}
            {clocks.map((clock, clockIndex) => (
              <Text key={`rev:${clockIndex}`} wrap="truncate">
                REV {clock.revision} {clock.terminal?.kind ?? "open"}{" "}
                {detailClock(clock.terminal?.at ?? clock.submittedAt ?? clock.pushedAt)}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The one compact round-6 timing sentence:
 * `Started HH:MM:SS, ended HH:MM:SS (total M:SS, wait N)`.
 * The merge sentence owns the integration proof on its separate row, so the SHA is never
 * duplicated here.
 */
function queueRunTimingRow(data: QueueShowData): string | undefined {
  // Round 6's sentence is deliberately clock-only even for historical runs;
  // the surrounding queue row already owns the date context.
  const startClock = presentFact(data.started) === undefined ? undefined : queueLogClock(data.started, false, false)
  const endClock = presentFact(data.finished) === undefined ? undefined : queueLogClock(data.finished, false, false)
  if (startClock === undefined) return undefined
  const clocks = endClock === undefined ? `Started ${startClock}` : `Started ${startClock}, ended ${endClock}`
  const total =
    data.totalDurationMs === undefined ? presentFact(data.totalDuration) : mediaDuration(data.totalDurationMs)
  const wait =
    data.waitDurationMs === undefined
      ? presentFact(data.waitDuration)
      : data.waitDurationMs === 0
        ? "0"
        : mediaDuration(data.waitDurationMs)
  const durations = [
    ...(total === undefined ? [] : [`total ${total}`]),
    ...(wait === undefined ? [] : [`wait ${wait}`]),
  ]
  return durations.length === 0 ? clocks : `${clocks} (${durations.join(", ")})`
}

/**
 * Round-6's final keyed grammar is `JOB yrd#<job-id>`. Runner and revision are
 * intentionally absent from the default body; failures still carry their
 * runner/revision evidence in the durable log projections.
 */
function QueueStepInternals({ row, issue }: { row: QueueShowRow; issue?: string }) {
  const job = presentFact(row.uuid)
  if (job === undefined) return null
  return (
    <Text bold wrap="truncate">
      JOB <NounId noun="yrd" value={job} />
      {issue === undefined ? null : (
        <>
          {" "}
          <IssueValue issue={issue} />
        </>
      )}
    </Text>
  )
}

// The watch detail pane's vertical facts layout (user respec 2026-07-15):
// stacked label/value rows that always fit the pane width — never a
// horizontally sprawling table. Only present facts render; timestamps share
// the timeline's local clock convention; `X@X` merges dedupe to one SHA.
/**
 * The compact run/step detail. `section` splits it for the workflow-step tabs
 * (user directive 2026-07-16, item H): `"run"` renders the run-level facts (+
 * COMMIT/timing/NEXT) once above the tabs, `"steps"` renders per-step facts under the
 * selected tab, `"all"` (default) renders everything in order for non-tab
 * contexts. When `titleAbove` is set the caller renders the Candidate + Run
 * identity and STATUS/OUTCOME in a title row above, so the RUN header row is
 * dropped here (items a/c, 2026-07-16). Subprocess-derived strings (ERROR,
 * MESSAGE, LOST, EVIDENCE) carry `bgConflict="ignore"` so raw ANSI in the data
 * keeps its colors without crashing the event loop.
 */
function CompactQueueShowView({
  data,
  highlightPr,
  section = "all",
  historyRevision,
  titleAbove = false,
  showMembers = true,
  showLogArtifacts = true,
  showIntegration = true,
  showTiming = true,
  showFailureDetails = true,
  stepIssue,
  nextAction,
}: {
  data: QueueShowData
  highlightPr?: string
  section?: "run" | "steps" | "all"
  /**
   * When set, this run executed against a now-superseded PR revision: the RUN
   * header is dimmed and annotated `(rev N · superseded)` so a historical run
   * is never read as the change's current state (user-reported 2026-07-16).
   */
  historyRevision?: number
  /** When true, the Candidate + Run identity and STATUS/OUTCOME live in a title
   *  row above, so the RUN header row is omitted here (framedDetail title). */
  titleAbove?: boolean
  /** False when the watch's run-scoped PR blocks already own this fact. */
  showMembers?: boolean
  /** False when the surrounding inline output list owns locations/artifact names. */
  showLogArtifacts?: boolean
  /** False when a workflow tab owns merge facts (Round-6 Revision B). */
  showIntegration?: boolean
  /** False when the persistent RUN header already owns timing. */
  showTiming?: boolean
  /** False when StatusNotice owns the failure explanation and recovery. */
  showFailureDetails?: boolean
  /** Selected PR issue shown beside the step's JOB identity. */
  stepIssue?: string
  /** Caller-owned current-PR guidance, used when a run's generic failure
   * resolution would hide a native needs-author fix-push action. */
  nextAction?: string
}) {
  const runFacts = section !== "steps"
  const stepFacts = section !== "run"
  const parent = presentFact(data.parent)
  const isolation = data.isolationPart === "-" ? undefined : data.isolationPart
  const timing = queueRunTimingRow(data)
  const gate = queueGateSummary(data)
  const latestStep = data.steps.at(-1)
  return (
    // minWidth={0} lets the long truncate-Text facts shrink to the (narrow)
    // detail pane instead of overflowing it (canonical CSS escape hatch).
    <Box flexDirection="column" minWidth={0} flexShrink={0}>
      {runFacts ? (
        <>
          {titleAbove ? null : (
            <Text bold wrap="truncate" {...(historyRevision === undefined ? {} : { color: "$fg-muted" })}>
              CANDIDATE {data.candidateId} RUN <RunId base={data.base} run={data.run} />
              {historyRevision === undefined ? "" : ` (rev ${historyRevision} · superseded)`} STATUS {data.status}{" "}
              OUTCOME {data.outcome}
            </Text>
          )}
          {showMembers ? (
            <Text wrap="truncate">
              {"PRs".padEnd(9, " ")}
              <QueueShowMembersValue data={data} highlightPr={highlightPr} />
            </Text>
          ) : null}
          {data.retries > 1 && data.prs[0] !== undefined ? (
            <Text wrap="truncate">
              <QueueChangeId pr={data.prs[0].id} revision={data.prs[0].revision} times={data.retries} />
            </Text>
          ) : null}
          {!showTiming || timing === undefined ? null : <Text wrap="truncate">{timing}</Text>}
          {gate === undefined ? null : <Text wrap="truncate">GATE {gate}</Text>}
          {showIntegration ? <QueueIntegrationFacts data={data} /> : null}
          {parent === undefined && isolation === undefined ? null : (
            <Text wrap="truncate" color="$fg-muted">
              {parent === undefined ? "" : `PARENT ${parent}`}
              {parent !== undefined && isolation !== undefined ? " " : ""}
              {isolation === undefined ? "" : `ISO ${isolation}`}
            </Text>
          )}
        </>
      ) : null}
      {stepFacts ? (
        <>
          {latestStep === undefined ? null : <QueueStepInternals row={latestStep} issue={stepIssue} />}
          {data.steps.map((row) => {
            const failure = row.failure === undefined ? undefined : queueShowFailureAction(row.failure, nextAction)
            const error = presentFact(row.errorCode)
            const detail = presentFact(row.detail)
            const lost = presentFact(row.lost)
            const evidence = presentFact(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))
            // Artifact/checkpoint facts stay in the selected step body while
            // the surrounding inline output list owns raw execution output.
            const artifacts = presentFact(row.artifacts)
            const checkpoint = presentFact(row.checkpoint)
            const visibleArtifacts = showLogArtifacts ? artifacts : undefined
            const visibleLocations = showLogArtifacts ? row.locations : []
            const hasProof =
              visibleLocations.length > 0 ||
              evidence !== undefined ||
              visibleArtifacts !== undefined ||
              checkpoint !== undefined
            return (
              // The step tab (glyph + name + duration) is the step summary, so
              // the duplicate STEP header row is dropped (item d, 2026-07-16).
              <Box
                key={`${row.uuid}:${row.attempt}:compact`}
                flexDirection="column"
                width="100%"
                minWidth={0}
                overflow="hidden"
              >
                {showFailureDetails && failure !== undefined ? (
                  <ActionableFailureView failure={failure} />
                ) : !showFailureDetails || error === undefined ? null : (
                  <Text wrap="wrap" color="$fg-error" bgConflict="ignore">
                    ERROR {errorCodeLabel(error)}
                  </Text>
                )}
                {detail === undefined ? null : (
                  <Box flexDirection="row" width="100%" minWidth={0} overflow="hidden">
                    <Text color="$fg-muted" flexShrink={0}>
                      {"MESSAGE".padEnd(9, " ")}
                    </Text>
                    <Text
                      flexGrow={1}
                      flexBasis={0}
                      flexShrink={1}
                      wrap="truncate"
                      minWidth={0}
                      color="$fg-muted"
                      bgConflict="ignore"
                    >
                      {detail}
                    </Text>
                  </Box>
                )}
                {!showFailureDetails || lost === undefined ? null : (
                  <Text wrap="truncate" color="$fg-warning" bgConflict="ignore">
                    {"LOST".padEnd(9, " ")}
                    {lost}
                  </Text>
                )}
                {!hasProof ? null : (
                  <Text wrap="truncate" minWidth={0} bgConflict="ignore">
                    {"PROOF".padEnd(9, " ")}
                    {visibleLocations.length === 0 ? null : (
                      <>
                        {" "}
                        <QueueLogLocationLinks entries={visibleLocations} compact={false} />
                      </>
                    )}
                    {visibleArtifacts === undefined ? "" : ` ARTIFACTS ${visibleArtifacts}`}
                    {evidence === undefined ? "" : ` EVIDENCE ${evidence}`}
                    {checkpoint === undefined ? "" : ` CHECKPOINT ${checkpoint}`}
                  </Text>
                )}
              </Box>
            )
          })}
        </>
      ) : null}
    </Box>
  )
}

export function QueueShowView({
  data,
  compact = false,
  highlightPr,
  section = "all",
  historyRevision,
  titleAbove = false,
  showMembers = true,
  showLogArtifacts = true,
  showIntegration = true,
  showTiming = true,
  showFailureDetails = true,
  stepIssue,
  nextAction,
}: {
  data: QueueShowData
  compact?: boolean
  highlightPr?: string
  /** Compact-only: split run-level vs step-level facts for the step tabs (item H). */
  section?: "run" | "steps" | "all"
  /** Compact-only: mark this run as history for a now-superseded revision. */
  historyRevision?: number
  /** Compact-only: the Candidate + Run identity and STATUS/OUTCOME live in a
   *  title row above, so drop the RUN header row here (framedDetail title). */
  titleAbove?: boolean
  /** Compact-only: hide the PRs row when surrounding run-scoped PR blocks own it. */
  showMembers?: boolean
  /** Compact-only: hide log locations/artifact names owned by the inline output list. */
  showLogArtifacts?: boolean
  /** Compact-only: keep merging facts out of the run header when a merge tab owns them. */
  showIntegration?: boolean
  /** Compact-only: hide timing when the persistent RUN header owns it. */
  showTiming?: boolean
  /** Compact-only: hide parallel failure chrome when StatusNotice owns it. */
  showFailureDetails?: boolean
  /** Compact-only: selected PR issue rendered with the step JOB identity. */
  stepIssue?: string
  nextAction?: string
}) {
  if (compact) {
    return (
      <CompactQueueShowView
        data={data}
        highlightPr={highlightPr}
        section={section}
        titleAbove={titleAbove}
        showMembers={showMembers}
        showLogArtifacts={showLogArtifacts}
        showIntegration={showIntegration}
        showTiming={showTiming}
        showFailureDetails={showFailureDetails}
        {...(nextAction === undefined ? {} : { nextAction })}
        {...(stepIssue === undefined ? {} : { stepIssue })}
        {...(historyRevision === undefined ? {} : { historyRevision })}
      />
    )
  }
  return (
    <Box flexDirection="column">
      <QueueShowIdentityChain data={data} />
      <QueueShowMembersLine data={data} {...(highlightPr === undefined ? {} : { highlightPr })} />
      <Table
        data={[data]}
        columns={[
          {
            header: "RUN",
            key: "run",
            minWidth: 8,
            render: (row) => <RunId base={row.base} run={row.run} />,
          },
          { header: "BASE", key: "base", minWidth: 5 },
          {
            header: "STATUS",
            key: "status",
            minWidth: 15,
            render: (row) => (
              <TaskStatusValue taskStatus={row.taskStatus} glyph={queueShowGlyph(row)} value={row.status} />
            ),
          },
          { header: "OUTCOME", key: "outcome", minWidth: 11 },
          { header: "START", key: "started", grow: true },
          { header: "END", key: "finished", grow: true },
          { header: "TOTAL", key: "totalDuration", minWidth: 7, align: "right" },
          { header: "ACTIVE", key: "activeDuration", minWidth: 7, align: "right" },
          { header: "WAIT", key: "waitDuration", minWidth: 7, align: "right" },
          {
            header: "PARENT",
            key: "parent",
            minWidth: 8,
            render: (row) => (row.parent === "-" ? "-" : row.parent),
          },
          {
            header: "ISO",
            key: "isolationPart",
            minWidth: 4,
            align: "right",
            render: (row) => (row.isolationPart === "-" ? "-" : row.isolationPart),
          },
          { header: "INTEGRATION", key: "merge", grow: true },
        ]}
        padding={1}
      />
      <Box marginTop={1}>
        <Table
          data={data.steps}
          columns={[
            { header: "STEP", key: "step", minWidth: 8 },
            {
              header: "REV",
              key: "revision",
              minWidth: 8,
              maxWidth: 12,
              render: (row) => <Text wrap="truncate">{row.revision.slice(0, 12)}</Text>,
            },
            {
              header: "STATUS",
              key: "status",
              minWidth: 12,
              render: (row) => <TaskStatusValue taskStatus={row.taskStatus} value={row.status} />,
            },
            { header: "ATT", key: "attempt", align: "right" },
            { header: "DUR", key: "duration", align: "right", minWidth: 8 },
            {
              header: "ERROR",
              key: "errorCode",
              minWidth: 22,
              maxWidth: 32,
              grow: true,
              render: (row) => (
                <Text wrap="truncate">{row.errorCode === "-" ? "-" : errorCodeLabel(row.errorCode)}</Text>
              ),
            },
            { header: "START", key: "started", grow: true },
            { header: "END", key: "finished", grow: true },
            { header: "REQ", key: "requested" },
            {
              header: "LOST",
              key: "lost",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleQueue(row.lost)}</Text>,
            },
            {
              header: "MESSAGE",
              key: "error",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleQueue(row.error)}</Text>,
            },
            {
              header: "DETAIL",
              key: "detail",
              grow: true,
              render: (row) => <Text wrap="truncate">{singleQueue(row.detail)}</Text>,
            },
            {
              header: "OUTPUT",
              key: "output",
              grow: true,
              minWidth: 10,
              render: (row) => <Text wrap="truncate">{singleQueue(row.output)}</Text>,
            },
            { header: "ART", key: "artifacts", grow: true },
            {
              header: "PATH",
              key: "locations",
              render: (row) => <LocationLinks entries={row.locations} />,
            },
            {
              header: "EVIDENCE",
              key: "evidence",
              minWidth: 10,
              grow: false,
              render: (row) => (
                <Text wrap="truncate">
                  {singleQueue(typeof row.evidence === "string" ? row.evidence : safeText(row.evidence))}
                </Text>
              ),
            },
            { header: "CHECKPOINT", key: "checkpoint", minWidth: 10, grow: false },
          ]}
          padding={1}
        />
      </Box>
      {data.steps.some((step) => step.failure !== undefined) ? (
        <Box marginTop={1} flexDirection="column">
          {data.steps.flatMap((step, index) =>
            step.failure === undefined
              ? []
              : [
                  <ActionableFailureView
                    key={`${step.step}:${index}`}
                    failure={queueShowFailureAction(step.failure, nextAction)}
                  />,
                ],
          )}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <QueueProofView data={data} />
      </Box>
      <Text wrap="wrap">NEXT {nextAction ?? queueShowNextAction(data)}</Text>
    </Box>
  )
}

function RevisionClockView({
  clock,
  checkRequests,
}: {
  clock: ChangeRevisionHistoryClock
  checkRequests: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        REVISION CLOCK <QueueChangeId pr={clock.pr} revision={clock.revision} /> HEAD {clock.headSha}
      </Text>
      <Text wrap="wrap">PUSHED {clock.pushedAt}</Text>
      <Text wrap="wrap">SUBMITTED {clock.submittedAt ?? "-"}</Text>
      <Text wrap="wrap">CHECK REQUESTED {checkRequests.length === 0 ? "-" : checkRequests.join(", ")}</Text>
      <Text wrap="wrap">
        TERMINAL {clock.terminal?.kind ?? "-"} AT {clock.terminal?.at ?? "-"}
      </Text>
    </Box>
  )
}

function RunAdmissionClockView({ run }: { run: QueueShowData }) {
  const clock = run.revisionClock
  if (clock === undefined) throw new Error(`yrd: run '${run.run}' has no projected entry-check clock`)
  const at = clock.admittedBy === "submission" ? clock.submittedAt : clock.checkRequestedAt
  return (
    <Text wrap="wrap">
      RUN <RunId base={run.base} run={run.run} /> CHECKS REQUESTED {clock.admittedBy} AT {at}
    </Text>
  )
}

export function ChangeRunsView({ data }: { data: ChangeRunsData }) {
  const clocks = changeRevisionClocks(data.pr)
  if (clocks.length === 0) return <Text color="$fg-muted">No revision history recorded.</Text>
  const projectedStatus = projectedChangeStatus(data.pr, data.eligibility)
  const eligibilityRefusal = data.eligibility?.reason?.code === "needs-author" ? data.eligibility.reason : undefined
  const revisionRefusal = changeNeedsAuthor(data.pr)
  const needsAuthor =
    eligibilityRefusal ??
    (revisionRefusal === undefined
      ? undefined
      : {
          message: revisionRefusal.detail ?? revisionRefusal.receipt.message,
          result: revisionRefusal.receipt,
        })
  const currentRevision = currentChangeRev(data.pr)
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <QueueChangeId pr={data.pr.id} revision={currentRevision.n} /> STATUS <StatusValue value={projectedStatus} />
      </Text>
      {needsAuthor === undefined ? null : (
        <>
          <Text wrap="wrap">NEEDS AUTHOR {needsAuthor.message}</Text>
          {needsAuthor.result === undefined ? null : (
            <Text wrap="wrap">
              ATTRIBUTED {needsAuthor.result.code}: {needsAuthor.result.message}
            </Text>
          )}
        </>
      )}
      {clocks.map((clock, revisionIndex) => {
        const checkRequests = revisionCheckRequests(data.pr, clock).map((request) => request.at)
        const runs = data.runs.filter(
          (run) =>
            run.revisionClock?.pr === clock.pr &&
            run.revisionClock.revision === clock.revision &&
            run.revisionClock.headSha === clock.headSha,
        )
        return (
          <Box
            key={`${clock.revision}:${clock.headSha}`}
            flexDirection="column"
            marginTop={revisionIndex === 0 ? 0 : 1}
          >
            <RevisionClockView clock={clock} checkRequests={checkRequests} />
            {runs.length === 0 ? (
              <Text color="$fg-muted">No runs recorded for this revision.</Text>
            ) : (
              runs.map((run, runIndex) => (
                <Box key={run.run} flexDirection="column" marginTop={runIndex === 0 ? 0 : 1}>
                  <RunAdmissionClockView run={run} />
                  <QueueShowView
                    data={run}
                    {...(needsAuthor !== undefined &&
                    clock.revision === currentRevision.n &&
                    clock.headSha === currentRevision.head
                      ? { nextAction: "fix the branch and push; the same PR resumes automatically" }
                      : {})}
                  />
                </Box>
              ))
            )}
          </Box>
        )
      })}
    </Box>
  )
}
