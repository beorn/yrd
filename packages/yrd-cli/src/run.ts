import { execFileSync } from "node:child_process"
import { open, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Command as CliCommand, CommanderError, int } from "@silvery/commander"
import { createElement } from "react"
import {
  CompositionV1Schema,
  CorrelationSchema,
  baseIdentity,
  prRevisionLineage,
  prSourceReadyAt,
  resolveBay,
  resolveBase,
  resolvePR,
  type Bay,
  type BaysState,
  type CompositionV1,
  type Correlation,
  type PR,
  type PRRegression,
  type PRRegressionSeverity,
} from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import { raiseFailure, type DeepReadonly, type JournalSnapshot } from "@yrd/core"
import type { Job } from "@yrd/job"
import { Queues, type PREligibility, type QueueRun, type QueueSummary } from "@yrd/queue"
import { cleanGitEnvironment } from "./git-environment.ts"
import {
  canonicalizeYrdCommandAliases,
  classifyFailure,
  configureYrdGlobalOptions,
  configuration,
  refusal,
  resolveInvocation,
  resolveYrdContext,
  stableJson,
  usage,
  type YrdContext,
} from "./invocation.ts"
import { getLiveRenderer } from "./live-renderer.ts"
import {
  QueueLogView,
  PRChecksView,
  PRDetailView,
  PRListView,
  PRRunsView,
  QueueRunsView,
  QueueTimelineView,
  QueueStatusView,
  type PRCheckViewRecord,
  type QueueLogCoverage,
  PRResultView,
  queueLogAttempts,
  queueLogRows,
  prListRows,
  prDetailData,
  queueRevisionKey,
  queueRunRevisionClocks,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  runRevisionClock,
  queueShowData,
  type QueueTimelineProjection,
  type QueueTimelineStatusFilter,
  type QueueStatusResult,
} from "./queue-status-view.tsx"
import { submittedPrPositions } from "./queue-position.ts"
import { resolveSubmitSelectors } from "./submit-selection.ts"
import { diagnostic, printHuman, printResult } from "./output.tsx"
import { BayStatusView, ContestStatusView, IssueLensView, type IssueLensRow } from "./status-view.tsx"
import {
  checkTaskStatusOf,
  issueTaskStatusOf,
  jobAttemptTaskStatusOf,
  projectPRTaskStatus,
  projectQueueRunTaskStatus,
  taskStatusFields,
} from "./task-status.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices, YrdCliState } from "./types.ts"
import { formatYrdRuntimeVersion, YRD_VERSION } from "./version.ts"
import { QueueWatchPane, type QueueArtifactOutput, type QueueWatchSnapshot } from "./watch-pane.tsx"

function gitSync(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function queueGitDir(cwd: string): string | undefined {
  try {
    const output = gitSync(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    const gitDir = output.trim()
    if (gitDir === "") return undefined
    return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir)
  } catch {
    return undefined
  }
}

function commitSubject(cwd: string, headSha: string): string | undefined {
  try {
    const subject = gitSync(cwd, ["show", "-s", "--format=%s", "--no-show-signature", headSha, "--"]).trimEnd()
    return subject === "" ? undefined : subject
  } catch {
    return undefined
  }
}

async function firstEventTimestamp(app: YrdCliApp): Promise<string> {
  for await (const event of app.events()) return event.ts
  return "-"
}

async function queueLegacyCoverage(cwd: string, since: string): Promise<QueueLogCoverage | undefined> {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) return undefined
  const paths = [join(gitDir, "yrd", "events.jsonl"), join(gitDir, "bay", "journal.jsonl")]
  const legacy = (
    await Promise.all(
      paths.map(async (path) => {
        try {
          const content = await readFile(path, "utf8")
          return { path, frames: content.split(/\r?\n/u).filter((value) => value.trim() !== "").length }
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return undefined
          }
          throw error
        }
      }),
    )
  ).filter((coverage): coverage is { path: string; frames: number } => coverage !== undefined)
  return legacy.length === 0 ? undefined : { since, completeness: "queue-only", legacy }
}

type RuntimeOptions = {
  runner: string
  leaseMs: number
  now?: () => number
  continueAdmissions?: () => boolean
}

type QueueListOptions = Readonly<{
  base?: string
  pr?: string
  status?: string
  since?: string
  latest?: boolean
  watch?: boolean
  json?: boolean
}>

type WatchOptions = QueueListOptions

type JsonOption = { json?: boolean }

const QUEUE_TIMELINE_DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1_000
const QUEUE_TIMELINE_STATUSES: readonly QueueTimelineStatusFilter[] = [
  "pending",
  "running",
  "rejected",
  "integrated",
  "other",
]

function queueTimelineRowLimit(io: YrdCliIO): number {
  if (io.rows === undefined) return 20
  // Header, filters, four FLOW lines, columns, footer, and cap/coverage disclosures.
  return Math.max(1, io.rows - 11)
}

function queueTimelineWindow(value: string | undefined): number {
  if (value === undefined) return QUEUE_TIMELINE_DEFAULT_WINDOW_MS
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/iu.exec(value.trim())
  if (match === null) usage("--since must be a duration such as 30m, 6h, or 1d")
  const amount = Number(match?.[1])
  const unit = match?.[2]?.toLocaleLowerCase()
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  const milliseconds = amount * multiplier
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    usage("--since must be a finite non-negative duration")
  }
  return milliseconds
}

function queueTimelineStatuses(value: string | undefined): QueueTimelineStatusFilter[] {
  if (value === undefined) return [...QUEUE_TIMELINE_STATUSES]
  const statuses = [
    ...new Set(
      value
        .split(",")
        .map((status) => status.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ]
  if (statuses.length === 0) usage("--status must name at least one timeline status")
  const invalid = statuses.find((status) => !QUEUE_TIMELINE_STATUSES.includes(status as QueueTimelineStatusFilter))
  if (invalid !== undefined) {
    usage(`--status '${invalid}' is invalid; expected ${QUEUE_TIMELINE_STATUSES.join(",")}`)
  }
  return statuses as QueueTimelineStatusFilter[]
}

type TrackerDeliveryIdentity = Readonly<{
  issueRef: string
  pr: string
  revision: number
  headSha: string
  status: PR["status"]
  at: string
  runs: readonly string[]
  correlation?: Correlation
}>

type TrackerDelivery =
  | (TrackerDeliveryIdentity & Readonly<{ status: "pushed" | "submitted" | "withdrawn" | "canceled" }>)
  | (TrackerDeliveryIdentity & Readonly<{ status: "rejected"; bounce: Readonly<{ run: string; detail?: string }> }>)
  | (TrackerDeliveryIdentity &
      Readonly<{ status: "integrated"; landingSha: string; regressions?: readonly PRRegression[] }>)

type TrackerBridge = Readonly<{
  version: 1
  asOf: JournalSnapshot<YrdCliState>["asOf"]
  deliveries: readonly TrackerDelivery[]
}>

function trackerDelivery(pr: DeepReadonly<PR>, state: DeepReadonly<YrdCliState>): TrackerDelivery | undefined {
  if (pr.issue === undefined) return undefined
  const revision = pr.revisions.findLast(
    (candidate) => candidate.revision === pr.revision && candidate.headSha === pr.headSha,
  )
  const runs = Object.values(state.queues.records)
    .filter((run) =>
      run.prs.some(
        (candidate) => candidate.id === pr.id && candidate.revision === pr.revision && candidate.headSha === pr.headSha,
      ),
    )
    .toSorted((left, right) => {
      const started = left.startedAt.localeCompare(right.startedAt)
      return started === 0 ? left.id.localeCompare(right.id, undefined, { numeric: true }) : started
    })
    .map(({ id }) => id)
  const identity = {
    issueRef: pr.issue,
    pr: pr.id,
    revision: pr.revision,
    headSha: pr.headSha,
    runs,
    ...(pr.correlation === undefined ? {} : { correlation: pr.correlation }),
  }
  switch (pr.status) {
    case "pushed":
      return revision === undefined ? undefined : { ...identity, status: "pushed", at: revision.pushedAt }
    case "submitted":
      return pr.submittedAt === undefined ? undefined : { ...identity, status: "submitted", at: pr.submittedAt }
    case "rejected":
      if (pr.rejectedAt === undefined) return undefined
      if (pr.terminalRun === undefined) {
        refusal(`trackerBridge v1 cannot project rejected PR '${pr.id}' without a typed Queue bounce run`)
      }
      return {
        ...identity,
        status: "rejected",
        at: pr.rejectedAt,
        bounce: { run: pr.terminalRun, ...(pr.detail === undefined ? {} : { detail: pr.detail }) },
      }
    case "integrated":
      return pr.integratedAt === undefined || pr.integration === undefined
        ? undefined
        : {
            ...identity,
            status: "integrated",
            at: pr.integratedAt,
            landingSha: pr.integration.commit,
            ...(pr.regressions === undefined || pr.regressions.length === 0 ? {} : { regressions: pr.regressions }),
          }
    case "withdrawn":
      return pr.withdrawnAt === undefined ? undefined : { ...identity, status: "withdrawn", at: pr.withdrawnAt }
    case "canceled":
      return pr.canceledAt === undefined ? undefined : { ...identity, status: "canceled", at: pr.canceledAt }
  }
}

function trackerBridge(
  snapshot: JournalSnapshot<YrdCliState>,
  include: (delivery: TrackerDelivery) => boolean,
): TrackerBridge {
  const deliveries = Object.values(snapshot.state.bays.prs)
    .map((pr) => trackerDelivery(pr, snapshot.state))
    .filter((delivery): delivery is TrackerDelivery => delivery !== undefined && include(delivery))
    .toSorted((left, right) => left.pr.localeCompare(right.pr, undefined, { numeric: true }))
  return { version: 1, asOf: snapshot.asOf, deliveries }
}

type RuntimeBootstrap = Readonly<{
  ambientCwd: string
  env: NodeJS.ProcessEnv
  load(
    context: YrdContext,
    options: Readonly<{ resident: boolean }>,
  ): Promise<
    Readonly<{
      app: YrdCliApp
      services: YrdCliServices
      io?: Partial<YrdCliIO>
    }>
  >
}>

function runtimeOptions(io: YrdCliIO): RuntimeOptions {
  const drainSignal = io.drainSignal
  return {
    runner: io.runner ?? "yrd-cli",
    leaseMs: io.leaseMs ?? 5 * 60_000,
    ...(io.now === undefined ? {} : { now: io.now }),
    ...(drainSignal === undefined ? {} : { continueAdmissions: () => !drainSignal.aborted }),
  }
}

function stateOf(app: YrdCliApp): YrdCliState {
  return app.state()
}

function knownBases(state: YrdCliState): string[] {
  return [
    "main",
    ...Object.values(state.bays.byId).map((bay) => bay.base),
    ...Object.values(state.bays.prs).map((pr) => pr.base),
    ...Object.values(state.queues.records).map((run) => run.base),
    ...Object.values(state.queues.pauses).map((pause) => pause.base),
  ]
}

function selectedBase(state: YrdCliState, selector: string): string {
  return resolveBase(knownBases(state), selector) ?? baseIdentity(selector)
}

async function runJobs(app: YrdCliApp, ids: readonly string[], io: YrdCliIO): Promise<Job[]> {
  return [...(await app.jobs.runMany(ids, runtimeOptions(io)))]
}

function assertJobsPassed(runs: readonly Job[], action: string): void {
  const unresolved = runs.find((run) => run.status !== "passed")
  if (unresolved === undefined) return
  const detail =
    (unresolved.status === "failed" ? unresolved.error.message : undefined) ??
    (unresolved.status === "lost" ? unresolved.lostReason : undefined) ??
    ("detail" in unresolved ? unresolved.detail : undefined) ??
    unresolved.status
  refusal(`${action} ${unresolved.status}: ${detail}`)
}

function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function currentBay(state: BaysState, cwd: string): Bay | undefined {
  return Object.values(state.byId)
    .filter((bay) => bay.path !== undefined && within(bay.path, cwd))
    .toSorted((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0]
}

function sortedBays(state: BaysState): Bay[] {
  return Object.values(state.byId).toSorted((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  )
}

function unique<Value extends { id: string }>(values: readonly Value[]): Value[] {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}

function byQueueRunChronology(left: QueueRun, right: QueueRun): number {
  const started = left.startedAt.localeCompare(right.startedAt)
  return started === 0 ? left.id.localeCompare(right.id, undefined, { numeric: true }) : started
}

export function mergedQueueRuns(
  canonical: QueueSummary,
  aliases: readonly QueueSummary[],
): Pick<QueueSummary, "running" | "waiting" | "finished"> {
  const canonicalIds = new Set([...canonical.running, ...canonical.waiting, ...canonical.finished].map((run) => run.id))
  const merge = (key: "running" | "waiting" | "finished"): QueueRun[] =>
    unique([
      ...aliases.flatMap((summary) => summary[key]).filter((run) => !canonicalIds.has(run.id)),
      ...canonical[key],
    ]).toSorted(byQueueRunChronology)
  return { running: merge("running"), waiting: merge("waiting"), finished: merge("finished") }
}

function selectedBays(state: BaysState, selectors: readonly string[], cwd: string, action: string): Bay[] {
  if (selectors.length > 0) {
    return unique(
      selectors.map((selector) => {
        const bay = resolveBay(state, selector)
        if (bay === undefined) refusal(`no bay '${selector}'`)
        return bay
      }),
    )
  }
  const local = currentBay(state, cwd)
  if (local !== undefined) return [local]
  const live = sortedBays(state).filter((bay) => bay.status !== "closed")
  if (live.length === 0) refusal(`no bays are available to ${action}`)
  return live
}

function csv(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === true) return []
  const values = Array.isArray(value) ? value : [value]
  const result = values.flatMap((item) => {
    if (typeof item !== "string") usage("expected a comma-separated list")
    return item
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  })
  return result
}

function oneOfAliases(primary: unknown, alias: unknown, primaryName: string, aliasName: string): string | undefined {
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    usage(`--${primaryName} and --${aliasName} disagree`)
  }
  const value = primary ?? alias
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") usage(`--${primaryName} requires a non-empty value`)
  return value
}

function oneBaseOfAliases(
  state: YrdCliState,
  primary: unknown,
  alias: unknown,
  primaryName: string,
  aliasName: string,
): string | undefined {
  const primaryValue = oneOfAliases(primary, undefined, primaryName, aliasName)
  const aliasValue = oneOfAliases(alias, undefined, aliasName, primaryName)
  if (primaryValue === undefined) return aliasValue === undefined ? undefined : selectedBase(state, aliasValue)
  const selected = selectedBase(state, primaryValue)
  if (aliasValue !== undefined && selectedBase(state, aliasValue) !== selected) {
    usage(`--${primaryName} and --${aliasName} disagree`)
  }
  return selected
}

function parseCorrelation(value: unknown): Correlation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") usage("--correlation requires <namespace:id>")
  const separator = value.indexOf(":")
  if (separator === -1) usage("--correlation requires <namespace:id>")
  try {
    return CorrelationSchema.parse({ namespace: value.slice(0, separator), id: value.slice(separator + 1) })
  } catch {
    usage("--correlation requires <namespace:id>")
  }
}

function jsonEnabled(options: JsonOption): boolean {
  return options.json === true
}

function projectQueueSummaryTaskStatus(summary: QueueSummary) {
  return {
    ...summary,
    running: summary.running.map(projectQueueRunTaskStatus),
    waiting: summary.waiting.map(projectQueueRunTaskStatus),
    finished: summary.finished.map(projectQueueRunTaskStatus),
  }
}

function projectQueueStatusResultTaskStatus(result: QueueStatusResult) {
  return {
    ...projectQueueSummaryTaskStatus(result),
    prs: result.prs.map(projectPRTaskStatus),
  }
}

function projectEligibilityTaskStatus(eligibility: PREligibility) {
  return {
    ...eligibility,
    checks: { ...eligibility.checks, ...taskStatusFields(checkTaskStatusOf(eligibility.checks)) },
  }
}

function projectCheckTaskStatus(check: PRCheckViewRecord) {
  return { ...check, ...taskStatusFields(checkTaskStatusOf(check)) }
}

async function openBay(
  app: YrdCliApp,
  name: string,
  options: {
    from?: string
    head?: string
    base?: string
    queue?: string
    issue?: string
    actor?: string
    json?: boolean
  },
  io: YrdCliIO,
  command = "bay.open",
  pr?: string,
): Promise<void> {
  const from = oneOfAliases(options.from, options.head, "from", "head")
  const base = oneBaseOfAliases(stateOf(app), options.base, options.queue, "base", "queue")
  const result = await app.bays.open({
    name,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(from === undefined ? {} : { from }),
    ...(base === undefined ? {} : { base }),
  })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${name}' provision`)
  const bay = app.bays.get(name)
  if (bay?.path === undefined || bay.status !== "active") refusal(`bay '${name}' did not become active`)
  await printResult(
    io,
    jsonEnabled(options),
    { command, ...(pr === undefined ? {} : { pr }), bay },
    createElement(BayStatusView, { bays: [bay] }),
  )
}

async function refreshBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const bays = selectedBays(state.bays, selectors, io.cwd ?? process.cwd(), "refresh")
  const refreshed: Bay[] = []
  for (const bay of bays) {
    refreshed.push(await refreshBay(app, bay, io))
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.refresh", bays: refreshed },
    createElement(BayStatusView, { bays: refreshed }),
  )
}

async function refreshBay(app: YrdCliApp, bay: Bay, io: YrdCliIO): Promise<Bay> {
  const result = await app.bays.refresh({ bay: bay.id })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${bay.id}' refresh`)
  const refreshed = app.bays.get(bay.id)
  if (refreshed === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after refresh`)
  return refreshed
}

async function closeBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { withdraw?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const bays = selectedBays(stateOf(app).bays, selectors, io.cwd ?? process.cwd(), "close")
  const closed: Bay[] = []
  for (const bay of bays) {
    const withdrawing = app.bays
      .prs()
      .find((pr) => pr.bay === bay.id && (pr.status === "pushed" || pr.status === "submitted"))
    const result = await app.bays.close({
      bay: bay.id,
      ...(options.withdraw === true ? { withdraw: true } : {}),
    })
    if (withdrawing !== undefined) {
      await app.queue.cancel({
        prs: [withdrawing.id],
        by: io.runner ?? "operator",
        reason: "PR withdrawn",
      })
    }
    assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${bay.id}' close`)
    const current = app.bays.get(bay.id)
    if (current === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after close`)
    closed.push(current)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.close", bays: closed },
    createElement(BayStatusView, { bays: closed }),
  )
}

async function closePrs(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  if (selectors.length === 0) usage("pr close requires at least one PR selector")
  const prs: PR[] = []
  for (const selector of selectors) {
    await app.bays.closePr({ pr: selector })
    const pr = app.bays.pr(selector)
    if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after close`)
    await app.queue.cancel({ prs: [pr.id], by: io.runner ?? "operator", reason: "PR withdrawn" })
    prs.push(pr)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.close", prs: prs.map(projectPRTaskStatus) },
    createElement(PRResultView, { prs, runs: [] }),
  )
}

async function readyPr(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  await app.bays.ready({ pr: selector })
  let pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after ready`)
  if (!app.bays.checksRequested(pr.id)) await app.bays.requestChecks({ pr: pr.id })
  const admitted = await app.queue.admit({ prs: [pr.id] }, runtimeOptions(io))
  pr = app.bays.pr(pr.id)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after check admission`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.ready", pr: prFact(pr), eligibility: projectEligibilityTaskStatus(app.queue.eligibility(pr.id)) },
    createElement(PRResultView, { prs: [pr], runs: [] }),
  )
  return admitted.some(
    (run) =>
      run.status === "failed" && run.prs.some((member) => member.id === pr.id && member.revision === pr.revision),
  )
    ? 1
    : 0
}

async function recutPr(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: JsonOption & Readonly<{ revision?: number; queue?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const service = services.recut ?? configuration("pr.recut capability is not installed")
  const pr = requiredPr(app, selector)
  if (pr.status === "integrated" || pr.status === "withdrawn" || pr.status === "canceled") {
    raiseFailure("refusal", "terminal-target", `yrd: PR '${pr.id}' is ${pr.status}; terminal PRs cannot be recut`)
  }
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1)) {
    usage("--revision must be a positive integer")
  }
  const fromRevision = options.revision ?? pr.revision
  const source = pr.revisions.find((revision) => revision.revision === fromRevision)
  if (source === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: PR '${pr.id}' has no revision ${fromRevision}`)
  }
  const approval = pr.reviews.findLast(
    (review) =>
      review.revision === source.revision && review.headSha === source.headSha && review.decision === "approve",
  )
  const currentCompositions = source.composition === undefined ? sameIssueIntegratedCompositions(app, pr) : undefined
  const result = await service.recut({
    id: pr.id,
    ...(pr.bay === undefined ? {} : { bay: pr.bay }),
    ...(pr.name === undefined ? {} : { name: pr.name }),
    branch: pr.branch,
    base: pr.base,
    revision: source.revision,
    headSha: source.headSha,
    ...(source.baseSha === undefined ? {} : { baseSha: source.baseSha }),
    ...(source.correlation === undefined ? {} : { correlation: source.correlation }),
    ...(source.composition === undefined ? {} : { composition: source.composition }),
    ...(currentCompositions === undefined ? {} : { currentCompositions }),
    ...(pr.recut === undefined
      ? {}
      : {
          current: {
            revision: pr.revision,
            headSha: pr.headSha,
            ...(pr.baseSha === undefined ? {} : { baseSha: pr.baseSha }),
            treeSha: pr.recut.treeSha,
            patchId: pr.recut.patchId,
            fromRevision: pr.recut.fromRevision,
            ...(pr.composition === undefined ? {} : { composition: pr.composition }),
          },
        }),
  })
  const recorded = await app.bays.recut({
    pr: pr.id,
    fromRevision: source.revision,
    headSha: result.headSha,
    baseSha: result.baseSha,
    treeSha: result.treeSha,
    patchId: result.patchId,
    reviewCarried: approval !== undefined,
    ...(result.composition === undefined ? {} : { composition: result.composition }),
  })
  const unchanged = recorded.events.length === 0

  let current = requiredPr(app, pr.id)
  let admitted: readonly QueueRun[] = []
  if (options.queue === true) {
    if (!unchanged) {
      await app.queue.cancel({
        prs: [current.id],
        by: io.runner ?? "operator",
        reason: `PR recut superseded revision ${source.revision}`,
      })
    }
    if (current.status === "pushed") await app.bays.ready({ pr: current.id })
    current = requiredPr(app, current.id)
    if (current.status !== "submitted") {
      raiseFailure("refusal", "recut-not-ready", `yrd: PR '${current.id}' is ${current.status}, not ready`)
    }
    if (!app.bays.checksRequested(current.id)) await app.bays.requestChecks({ pr: current.id })
    admitted = await app.queue.admit({ prs: [current.id] }, runtimeOptions(io))
    current = requiredPr(app, current.id)
  }
  const output = {
    pr: current.id,
    revision: current.revision,
    baseSha: result.baseSha,
    treeSha: result.treeSha,
    patchId: result.patchId,
    reviewCarried: approval !== undefined,
    ...(current.correlation === undefined ? {} : { correlation: current.correlation }),
    sourceReadyAt: prSourceReadyAt(current),
    lineage: prRevisionLineage(current).map((revision) => revision.revision),
    unchanged,
  }
  await printResult(
    io,
    jsonEnabled(options),
    output,
    `${current.id} revision ${current.revision} ${unchanged ? "already matches" : "recut onto"} ${result.baseSha}`,
  )
  return admitted.some(
    (run) =>
      run.status === "failed" &&
      run.prs.some((member) => member.id === current.id && member.revision === current.revision),
  )
    ? 1
    : 0
}

async function reviewPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ approve?: boolean; reject?: boolean; by?: string; ref?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.approve === options.reject) usage("pr review requires exactly one of --approve or --reject")
  await app.bays.review({
    pr: selector,
    actor: options.by ?? io.runner ?? "operator",
    decision: options.approve === true ? "approve" : "reject",
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after review`)
  const review =
    options.ref === undefined
      ? app.bays.reviewState(pr.id).current
      : pr.reviews.findLast((candidate) => candidate.ref === options.ref)
  if (review === undefined) throw new Error(`yrd: PR '${pr.id}' did not retain its current review`)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.review",
      pr: prFact(pr),
      review,
      eligibility: projectEligibilityTaskStatus(app.queue.eligibility(pr.id)),
    },
    `${pr.id} revision ${pr.revision} ${review.decision} by ${review.actor}`,
  )
}

async function commentPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ by?: string; ref?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.note === undefined || options.note.trim() === "") usage("pr comment requires --note <text>")
  await app.bays.comment({
    pr: selector,
    actor: options.by ?? io.runner ?? "operator",
    note: options.note,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after comment`)
  const comment =
    options.ref === undefined ? pr.comments.at(-1) : pr.comments.findLast((candidate) => candidate.ref === options.ref)
  if (comment === undefined) throw new Error(`yrd: PR '${pr.id}' did not retain its comment`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.comment", pr: prFact(pr), comment },
    `${pr.id} revision ${pr.revision} commented by ${comment.actor}`,
  )
}

async function prChecks(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption & Readonly<{ follow?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (selectors.length === 0) usage("pr checks requires at least one PR selector")
  let checks: readonly PRCheckViewRecord[] = prCheckRecords(app, selectors)
  if (options.follow === true) {
    const missing = checks.find((check) => check.status === "not-requested")
    if (missing !== undefined) refusal(`PR '${missing.pr}' has no requested checks; submit it before following`)
    checks = await followCheckRecords(app, selectors, checks, io)
  }
  if (jsonEnabled(options)) {
    for (const check of checks) io.stdout(stableJson({ kind: "pr.check", ...projectCheckTaskStatus(check) }))
  } else {
    await printHuman(io, createElement(PRChecksView, { records: checks, now: io.now?.() ?? Date.now() }))
  }
  return checks.some((check) => check.status === "failed") ? 1 : 0
}

function checksTerminal(records: readonly PRCheckViewRecord[]): boolean {
  return records.every((record) => record.status !== "queued" && record.status !== "checking")
}

async function followCheckRecords(
  app: YrdCliApp,
  selectors: readonly string[],
  initial: readonly PRCheckViewRecord[],
  io: YrdCliIO,
): Promise<readonly PRCheckViewRecord[]> {
  const scope = io.scope ?? app.scope
  let records = [...initial]
  while (!checksTerminal(records) && !scope.signal.aborted) {
    await scope.sleep(1_000)
    if (scope.signal.aborted) return records
    await app.refresh()
    if (scope.signal.aborted) return records
    records = [...prCheckRecords(app, selectors)]
  }
  return records
}

async function optionalRevision(ref: string, io: YrdCliIO): Promise<string | undefined> {
  const cwd = io.cwd ?? process.cwd()
  return io.resolveRevision?.(ref, cwd)
}

async function resolvedQueueTarget(ref: string, io: YrdCliIO): Promise<Readonly<{ base: string; sha?: string }>> {
  const cwd = io.cwd ?? process.cwd()
  if (io.resolveQueueTarget !== undefined) {
    const target = await io.resolveQueueTarget(ref, cwd)
    return { ...target, base: baseIdentity(target.base) }
  }
  const sha = await optionalRevision(ref, io)
  return { base: baseIdentity(ref), ...(sha === undefined ? {} : { sha }) }
}

type QueueTargetGroup = Readonly<{ base: string; aliases: ReadonlySet<string>; headSha?: string }>

async function queueTargetGroups(bases: ReadonlySet<string>, io: YrdCliIO): Promise<QueueTargetGroup[]> {
  const groups = new Map<string, { aliases: Set<string>; headSha?: string }>()
  for (const ref of [...bases].toSorted()) {
    const target = await resolvedQueueTarget(ref, io)
    const group = groups.get(target.base) ?? { aliases: new Set<string>() }
    group.aliases.add(ref)
    group.aliases.add(baseIdentity(ref))
    group.aliases.add(target.base)
    if (target.sha !== undefined) group.headSha = target.sha
    groups.set(target.base, group)
  }
  return [...groups.entries()].map(([base, group]) => ({ base, ...group }))
}

async function submitBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: {
    follow?: boolean
    draft?: boolean
    base?: string
    queue?: string
    issue?: string
    correlation?: string
    composition?: string
    json?: boolean
  },
  io: YrdCliIO,
  command: "bay.submit" | "pr.submit",
): Promise<YrdCliExitCode> {
  const correlation = parseCorrelation(options.correlation)
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const local = currentBay(state.bays, cwd)
  const inferred = resolveSubmitSelectors(selectors, local?.id ?? currentGitBranch(cwd, io))
  const prs: PR[] = []
  const base = oneBaseOfAliases(state, options.base, options.queue, "base", "queue")
  const composition = await readComposition(options.composition, io)
  if (composition !== undefined && inferred.length !== 1) {
    usage("--composition requires exactly one bay or branch selector")
  }
  for (const selector of inferred) {
    const pr = await app.bays.submitSelection(selector, {
      ...(base === undefined ? {} : { base }),
      ...(options.issue === undefined ? {} : { issue: options.issue }),
      ...(options.draft === true ? { draft: true } : {}),
      ...(correlation === undefined ? {} : { correlation }),
      ...(composition === undefined ? {} : { composition }),
      resolveRevision: (ref) => optionalRevision(ref, io),
      run: runtimeOptions(io),
    })
    prs.push(pr)
  }
  if (command === "bay.submit" || options.draft === true) {
    await printResult(
      io,
      jsonEnabled(options),
      { command, prs: prs.map(projectPRTaskStatus) },
      createElement(PRResultView, { prs, runs: [] }),
    )
    return 0
  }
  for (const pr of prs) await app.bays.requestChecks({ pr: pr.id })
  const selected = prs.map((pr) => pr.id)
  const followed = (await app.queue.admit({ prs: selected }, runtimeOptions(io))).filter((run) =>
    run.prs.some((member) => prs.some((pr) => pr.id === member.id && pr.revision === member.revision)),
  )
  let checks: readonly PRCheckViewRecord[] = prCheckRecords(app, selected)
  if (options.follow === true && !checksTerminal(checks)) checks = await followCheckRecords(app, selected, checks, io)
  const currentPrs = selected.map((selector) => requiredPr(app, selector))
  await printResult(
    io,
    jsonEnabled(options),
    {
      command,
      prs: currentPrs.map(projectPRTaskStatus),
      checks: checks.map(projectCheckTaskStatus),
    },
    createElement(PRResultView, {
      prs: currentPrs,
      runs: followed,
      checks,
      now: io.now?.() ?? Date.now(),
    }),
  )
  return checks.some((check) => check.status === "failed") || followed.some((run) => run.status === "failed") ? 1 : 0
}

async function readComposition(path: string | undefined, io: YrdCliIO): Promise<CompositionV1 | undefined> {
  if (path === undefined) return undefined
  const absolute = resolve(io.cwd ?? process.cwd(), path)
  try {
    return CompositionV1Schema.parse(JSON.parse(await readFile(absolute, "utf8")))
  } catch (cause) {
    usage(
      `invalid composition manifest '${path}': ${cause instanceof Error ? cause.message : String(cause)}; ` +
        "provide version 1 with normalized repo-relative payload paths",
    )
  }
}

function requiredPr(app: YrdCliApp, selector: string): PR {
  const pr = app.bays.pr(selector)
  if (pr === undefined) refusal(`no PR '${selector}'`)
  return pr as PR
}

function allQueueRuns(app: YrdCliApp): QueueRun[] {
  return Object.keys(stateOf(app).queues.records)
    .map((id) => app.queue.get(id))
    .filter((run): run is QueueRun => run !== undefined)
    .toSorted(byQueueRunChronology)
}

function prQueueRuns(app: YrdCliApp, pr: PR): QueueRun[] {
  return allQueueRuns(app).filter((run) => run.prs.some((member) => member.id === pr.id))
}

function sameIssueIntegratedCompositions(app: YrdCliApp, pr: PR): readonly CompositionV1[] | undefined {
  if (pr.issue === undefined) return undefined
  const integrated = new Set(
    app.bays
      .prs()
      .filter(
        (candidate) => candidate.id !== pr.id && candidate.issue === pr.issue && candidate.status === "integrated",
      )
      .map((candidate) => candidate.id),
  )
  const compositions = allQueueRuns(app)
    .filter(
      (run) => run.status === "passed" && run.prs.length > 0 && run.prs.every((member) => integrated.has(member.id)),
    )
    .toReversed()
    .flatMap((run) => {
      const rewrites = run.integration?.sourceRewrites
      if (rewrites === undefined || rewrites.length === 0) return []
      return [
        CompositionV1Schema.parse({
          version: 1,
          sources: rewrites.map((rewrite) => ({
            repo: rewrite.repo,
            branch: rewrite.candidateRef,
            baseSha: rewrite.newBaseSha,
            tipSha: rewrite.newTipSha,
            payload: rewrite.payload,
          })),
        }),
      ]
    })
  return compositions.length === 0 ? undefined : compositions
}

async function listBays(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const bays = app.bays.list()
  await printResult(io, jsonEnabled(options), { command: "bay.list", bays }, createElement(BayStatusView, { bays }))
}

async function listPrs(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string; state?: string; issue?: string; needsReview?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const base = options.base === undefined ? undefined : selectedBase(state, options.base)
  const rows = app.bays
    .prs()
    .filter((pr) => base === undefined || baseIdentity(pr.base) === base)
    .filter((pr) => options.state === undefined || pr.status === options.state)
    .filter((pr) => options.issue === undefined || pr.issue === options.issue)
    .map((pr) => ({ pr, eligibility: app.queue.eligibility(pr.id) }))
    .filter(({ pr, eligibility }) =>
      options.needsReview === true
        ? (pr.status === "pushed" || pr.status === "submitted") &&
          eligibility.review.required &&
          !eligibility.review.approved
        : true,
    )
  const selected = new Set(rows.map(({ pr }) => pr.id))
  const runs = allQueueRuns(app).filter((run) => run.prs.some((member) => selected.has(member.id)))
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.list",
      prs: rows.map(({ pr, eligibility }) => ({
        ...projectPRTaskStatus(pr),
        eligibility: projectEligibilityTaskStatus(eligibility),
      })),
      runs: runs.map(projectQueueRunTaskStatus),
    },
    createElement(PRListView, {
      rows: prListRows(rows, runs, io.now?.() ?? Date.now()),
      columns: io.columns ?? 120,
    }),
  )
}

async function viewPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
  command = "pr.view",
): Promise<void> {
  const pr = requiredPr(app, selector)
  const state = stateOf(app)
  const target = resolveQueueTargets(state, [pr.id], undefined, pr.id)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  const positions = pr.status === "submitted" ? await queuedPrPositions(state, pr.base, io) : undefined
  const position = positions?.get(pr.id)
  const runs = prQueueRuns(app, pr)
  const attempts = await queueLogAttempts(app.events())
  const detail = prDetailData(pr, runs, attempts)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command,
      pr: projectPRTaskStatus(pr),
      ...(position === undefined ? {} : { position }),
      results: results.map(projectQueueStatusResultTaskStatus),
      detail,
    },
    createElement(PRDetailView, {
      pr,
      runs,
      attempts,
      now: io.now?.() ?? Date.now(),
      ...(position === undefined ? {} : { position }),
    }),
  )
}

async function viewPrRuns(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  for (let read = 0; read < 3; read += 1) {
    const snapshot = await app.journalSnapshot()
    const pr = resolvePR(snapshot.state.bays, selector)
    if (pr === undefined) {
      const confirmed = await app.journalSnapshot()
      if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
      refusal(`no PR '${selector}'`)
    }
    const runs = prQueueRuns(app, pr)
    const attempts = await queueLogAttempts(app.events())
    const confirmed = await app.journalSnapshot()
    if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
    const data = {
      pr,
      runs: runs.map((run) => queueShowData(run, runs, attempts, runRevisionClock(pr, run))),
    }
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: "pr.runs",
        pr: projectPRTaskStatus(pr),
        runs: data.runs,
        trackerBridge: trackerBridge(snapshot, ({ pr: id }) => id === pr.id),
      },
      createElement(PRRunsView, { data }),
    )
    return
  }
  refusal(
    `journal changed while reading PR '${selector}' runs; retry with 'yrd pr runs ${selector}${jsonEnabled(options) ? " --json" : ""}'`,
  )
}

async function diffPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ stat?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const pr = requiredPr(app, selector)
  const cwd = io.cwd ?? process.cwd()
  const base = pr.baseSha ?? pr.base
  let diff: string
  try {
    diff = gitSync(cwd, ["diff", ...(options.stat === true ? ["--stat"] : []), `${base}...${pr.headSha}`, "--"])
  } catch (error) {
    refusal(`cannot diff PR '${pr.id}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const composition = pr.composition
  const rendered =
    composition === undefined
      ? diff
      : [
          "Source composition (the Queue generates the root gitlink wrapper):",
          ...composition.sources.flatMap((source) => [
            `  ${source.repo} ${source.branch} ${source.baseSha.slice(0, 12)}..${source.tipSha.slice(0, 12)}`,
            ...source.payload.map((path) => `    ${path}`),
          ]),
          "",
          "Root diff:",
          diff === "" ? "  (none before Candidate construction)" : diff,
        ].join("\n")
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.diff",
      pr: pr.id,
      base,
      head: pr.headSha,
      ...(composition === undefined ? {} : { composition }),
      diff,
    },
    rendered,
  )
}

async function checkoutPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ bay?: string }>,
  io: YrdCliIO,
): Promise<void> {
  const pr = requiredPr(app, selector)
  const name = options.bay ?? `pr-${pr.id.toLowerCase()}`
  await openBay(
    app,
    name,
    { from: pr.branch, base: pr.base, ...(pr.issue === undefined ? {} : { issue: pr.issue }), ...options },
    io,
    "pr.checkout",
    pr.id,
  )
}

function currentGitBranch(cwd: string, io: YrdCliIO): string | undefined {
  const injected = io.currentBranch?.(cwd)
  if (injected !== undefined) return injected
  try {
    const branch = gitSync(cwd, ["branch", "--show-current"]).trim()
    return branch === "" ? undefined : branch
  } catch {
    return undefined
  }
}

function currentPr(app: YrdCliApp, io: YrdCliIO): PR {
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr =
    (bay === undefined ? undefined : Object.values(state.bays.prs).find((candidate) => candidate.bay === bay.id)) ??
    Object.values(state.bays.prs).find((candidate) => candidate.branch === branch)
  if (pr === undefined) refusal("the current bay or branch has no PR; submit it with 'yrd pr submit'")
  return pr as PR
}

async function queuedPrPosition(state: YrdCliState, pr: PR, io: YrdCliIO): Promise<number | undefined> {
  if (pr.status !== "submitted") return undefined
  return (await queuedPrPositions(state, pr.base, io)).get(pr.id)
}

async function queuedPrPositions(state: YrdCliState, base: string, io: YrdCliIO): Promise<ReadonlyMap<string, number>> {
  const prs = Object.values(state.bays.prs)
  const groups = await queueTargetGroups(new Set(prs.map((candidate) => candidate.base)), io)
  const group = groups.find((candidate) => candidate.aliases.has(base))
  if (group === undefined) throw new Error(`yrd: queue target group for base '${base}' disappeared`)
  const candidates = prs.filter((candidate) => group.aliases.has(candidate.base))
  return submittedPrPositions(candidates)
}

async function statusPr(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const pr = currentPr(app, io)
  await viewPr(app, pr.id, options, io, "pr.status")
}

async function editPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ issue?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.issue === undefined && options.note === undefined) usage("pr edit requires --issue or --note")
  const pr = requiredPr(app, selector)
  await app.bays.editPr({
    pr: pr.id,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
  const edited = requiredPr(app, pr.id)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.edit", pr: projectPRTaskStatus(edited) },
    createElement(PRResultView, { prs: [edited], runs: prQueueRuns(app, edited) }),
  )
}

type PrRegressionOptions = JsonOption &
  Readonly<{
    run: string
    detectedAt: string
    severity: PRRegressionSeverity
    evidence: string
    implementationRun: string
    review: string
    repairPr: string
    repairRun: string
  }>

type PRRegressionFact = Omit<PRRegression, "recordedAt">

async function recordPrRegression(
  app: YrdCliApp,
  selector: string,
  options: PrRegressionOptions,
  io: YrdCliIO,
): Promise<void> {
  const result = await app.bays.recordRegression({
    pr: selector,
    run: options.run,
    detectedAt: options.detectedAt,
    severity: options.severity,
    evidence: options.evidence,
    implementationRunRef: options.implementationRun,
    reviewRef: options.review,
    repairPr: options.repairPr,
    repairRun: options.repairRun,
  })
  if (
    result.value === undefined ||
    result.value === null ||
    typeof result.value !== "object" ||
    Array.isArray(result.value)
  ) {
    throw new Error("yrd: regression command returned no completed outcome")
  }
  const regression = result.value as unknown as PRRegressionFact
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.regression", regression },
    `Recorded ${regression.severity} escaped regression for ${regression.pr}; repaired by ${regression.repairPr}.`,
  )
}

function prFact(pr: DeepReadonly<PR>): Readonly<{
  id: string
  branch: string
  base: string
  revision: number
  headSha: string
  baseSha?: string
}> {
  return {
    id: pr.id,
    branch: pr.branch,
    base: pr.base,
    revision: pr.revision,
    headSha: pr.headSha,
    ...(pr.baseSha === undefined ? {} : { baseSha: pr.baseSha }),
  }
}

function selectedCheckPRs(app: YrdCliApp, selectors: readonly string[]): PR[] {
  return selectors.map((selector) => {
    const pr = app.bays.pr(selector)
    if (pr === undefined) refusal(`no PR '${selector}'`)
    return pr
  })
}

function prCheckRecords(app: YrdCliApp, selectors: readonly string[]): PRCheckViewRecord[] {
  selectedCheckPRs(app, selectors)
  return [...app.queue.checks(selectors)]
}

function issueRows(app: YrdCliApp, state: DeepReadonly<YrdCliState>, selected?: string): IssueLensRow[] {
  const contests = app.contests.list()
  const refs = new Set<string>()
  for (const bay of Object.values(state.bays.byId)) if (bay.issue !== undefined) refs.add(bay.issue)
  for (const pr of Object.values(state.bays.prs)) if (pr.issue !== undefined) refs.add(pr.issue)
  for (const contest of contests) refs.add(`${contest.issue.ref.source}:${contest.issue.ref.id}`)
  if (selected !== undefined && !refs.has(selected)) refusal(`no issue '${selected}' is in flight`)
  return [...refs]
    .filter((issue) => selected === undefined || issue === selected)
    .toSorted()
    .map((issue) => {
      const bays = Object.values(state.bays.byId).filter((bay) => bay.issue === issue)
      const bayIds = new Set(bays.map((bay) => bay.id))
      const prs = Object.values(state.bays.prs).filter(
        (pr) => pr.issue === issue || (pr.bay !== undefined && bayIds.has(pr.bay)),
      )
      const joinedContests = contests.filter(
        (contest) => `${contest.issue.ref.source}:${contest.issue.ref.id}` === issue,
      )
      const taskStatus = issueTaskStatusOf({ prs, contests: joinedContests })
      return {
        issue,
        ...taskStatusFields(taskStatus),
        bays: bays.map((bay) => bay.id).join(",") || "-",
        prs: prs.map((pr) => pr.id).join(",") || "-",
        contests: joinedContests.map((contest) => contest.id).join(",") || "-",
        outcome:
          [...prs.map((pr) => pr.status), ...joinedContests.map((contest) => contest.status)].join(",") || "in-flight",
      }
    })
}

async function listIssues(app: YrdCliApp, options: JsonOption, io: YrdCliIO, selected?: string): Promise<void> {
  for (let read = 0; read < 3; read += 1) {
    const snapshot = await app.journalSnapshot()
    const issues = issueRows(app, snapshot.state, selected)
    const confirmed = await app.journalSnapshot()
    if (confirmed.asOf.cursor !== snapshot.asOf.cursor) continue
    await printResult(
      io,
      jsonEnabled(options),
      {
        command: selected === undefined ? "issue.list" : "issue.view",
        issues,
        trackerBridge: trackerBridge(snapshot, ({ issueRef }) => selected === undefined || issueRef === selected),
      },
      createElement(IssueLensView, { rows: issues }),
    )
    return
  }
  refusal(
    `journal changed while reading issues; retry with 'yrd issue${selected === undefined ? "" : ` view ${selected}`}${jsonEnabled(options) ? " --json" : ""}'`,
  )
}

async function runQueues(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown },
  io: YrdCliIO,
): Promise<readonly QueueRun[]> {
  const steps = csv(options.steps)
  return app.queue.run(
    {
      prs: [...selectors],
      ...(steps === undefined ? {} : { steps }),
    },
    runtimeOptions(io),
  )
}

async function pauseQueue(
  app: YrdCliApp,
  base: string | undefined,
  options: JsonOption & Readonly<{ reason?: unknown; allow?: unknown }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reason === undefined) {
    if (csv(options.allow) !== undefined) usage("--allow requires --reason")
    const pauses = await queuePauses(app, base, io)
    const human =
      pauses.length === 0
        ? "No paused queues."
        : pauses
            .map((pause) => {
              const allowed = pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(", ")
              return `Queue ${pause.base} paused: ${pause.reason} (allowed: ${allowed})`
            })
            .join("\n")
    await printResult(io, jsonEnabled(options), { command: "queue.pause", pauses }, human)
    return
  }
  if (typeof options.reason !== "string" || options.reason.trim() === "") usage("--reason requires text")
  const target = await resolvedQueueTarget(selectedBase(stateOf(app), base ?? "main"), io)
  const pause = await app.queue.pause({
    base: target.base,
    reason: options.reason,
    allowedPRs: csv(options.allow) ?? [],
  })
  const allowed = pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(", ")
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.pause", pause },
    `Queue ${pause.base} paused: ${pause.reason} (allowed: ${allowed})`,
  )
}

async function queuePauses(app: YrdCliApp, base: string | undefined, io: YrdCliIO) {
  if (base === undefined) {
    return Object.values(stateOf(app).queues.pauses).toSorted((left, right) => left.base.localeCompare(right.base))
  }
  const target = await resolvedQueueTarget(selectedBase(stateOf(app), base), io)
  const pause = stateOf(app).queues.pauses[target.base]
  return pause === undefined ? [] : [pause]
}

async function recoverQueue(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ reason?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reason?.trim() === "") usage("--reason requires text")
  const runs = await app.queue.recover({
    recoveryTime: new Date(io.now?.() ?? Date.now()).toISOString(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.recover", results: runs.map(projectQueueRunTaskStatus) },
    createElement(QueueRunsView, { runs }),
  )
}

async function migrateTerminalAssociations(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ apply?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  let plan
  if (options.apply === true) {
    plan = await app.queue.migrateTerminalAssociations()
  } else {
    await app.refresh()
    plan = app.queue.terminalAssociationPlan()
  }
  const mode = options.apply === true ? "apply" : "dry-run"
  const human =
    plan.rows.length === 0
      ? `No unprojectable legacy PR terminals; ${mode} appended ${plan.summary.appended}.`
      : [
          ...plan.rows.map((row) =>
            row.status === "ready"
              ? `READY ${row.terminal.pr} revision ${row.terminal.revision}@${row.terminal.headSha} -> ${row.association.run} (${row.terminal.event})`
              : `REFUSED ${row.terminal.pr} revision ${row.terminal.revision}: ${row.refusal.code} — ${row.refusal.message}`,
          ),
          `${mode}: ${plan.summary.ready} ready, ${plan.summary.refused} refused, ${plan.summary.appended} appended`,
        ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "migrate.terminal-associations", mode, ...plan }, human)
  return plan.summary.refused === 0 ? 0 : 1
}

async function resumeQueue(app: YrdCliApp, base: string | undefined, options: JsonOption, io: YrdCliIO): Promise<void> {
  const target = await resolvedQueueTarget(selectedBase(stateOf(app), base ?? "main"), io)
  await app.queue.resume(target.base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.resume", base: target.base },
    `Queue ${target.base} resumed`,
  )
}

async function renderDashboard(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = resolveQueueTargets(state, selectors, undefined, undefined)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "dashboard", results: results.map(projectQueueStatusResultTaskStatus) },
    createElement(QueueStatusView, {
      state: state.bays,
      results,
      selected: target.selected,
      now: io.now?.() ?? Date.now(),
    }),
  )
}

async function queueStatusSnapshots(
  app: YrdCliApp,
  state: YrdCliState,
  target: { bases: Set<string>; selected: Set<string>; prFilter: string | undefined },
  io: YrdCliIO,
): Promise<{ results: readonly QueueStatusResult[] }> {
  if (target.selected.size === 0 && target.bases.size === 0) {
    for (const pr of Object.values(state.bays.prs)) target.bases.add(pr.base)
    for (const run of Object.values(state.queues.records)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  const results: QueueStatusResult[] = []
  for (const group of await queueTargetGroups(target.bases, io)) {
    const canonical = app.queue.status(group.base)
    const aliases = [...group.aliases].filter((base) => base !== group.base).map((base) => app.queue.status(base))
    const runs = mergedQueueRuns(canonical, aliases)
    results.push({
      base: group.base,
      ...runs,
      ...(canonical.pause === undefined ? {} : { pause: canonical.pause }),
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: Object.values(state.bays.prs).filter(
        (pr) => group.aliases.has(pr.base) && (target.selected.size === 0 || target.selected.has(pr.id)),
      ),
    })
  }
  return { results }
}

function queueBases(state: YrdCliState): string[] {
  return [
    ...new Set([
      ...Object.values(state.bays.prs).map((pr) => baseIdentity(pr.base)),
      ...Object.values(state.queues.records).map((run) => baseIdentity(run.base)),
    ]),
  ].toSorted()
}

type QueueListSnapshot = QueueWatchSnapshot & Readonly<{ projection: QueueTimelineProjection }>

const QUEUE_ARTIFACT_TAIL_BYTES = 64 * 1_024

async function artifactTail(path: string): Promise<Readonly<{ text: string; truncatedBytes: number }> | undefined> {
  let file
  try {
    file = await open(path, "r")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
  try {
    const size = (await file.stat()).size
    const length = Math.min(size, QUEUE_ARTIFACT_TAIL_BYTES)
    const truncatedBytes = size - length
    const bytes = new Uint8Array(length)
    if (length > 0) await file.read(bytes, 0, length, truncatedBytes)
    return { text: new TextDecoder().decode(bytes), truncatedBytes }
  } finally {
    await file.close()
  }
}

export async function queueArtifactOutputs(
  results: readonly QueueStatusResult[],
  artifactRoot: string,
): Promise<QueueArtifactOutput[]> {
  const outputs: QueueArtifactOutput[] = []
  for (const result of results) {
    for (const run of [...result.running, ...result.waiting, ...result.finished]) {
      for (const [index, step] of run.steps.entries()) {
        const attempt = step.job?.attempt
        if (attempt === undefined) continue
        const path = join(artifactRoot, run.id, `${index}-${step.name}`, `attempt-${attempt}`, "output.log")
        const tail = await artifactTail(path)
        if (tail === undefined) continue
        outputs.push({
          run: run.id,
          step: step.name,
          attempt,
          path,
          text: tail.text,
          ...(tail.truncatedBytes === 0 ? {} : { truncatedBytes: tail.truncatedBytes }),
        })
      }
    }
  }
  return outputs
}

async function queueListSnapshot(
  app: YrdCliApp,
  filters: readonly string[],
  options: QueueListOptions,
  io: YrdCliIO,
  includeOutputs = false,
): Promise<QueueListSnapshot> {
  const state = stateOf(app)
  const requestedBase = options.base ?? "main"
  const target = resolveQueueTargets(state, [], requestedBase, options.pr)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  const now = io.now?.() ?? Date.now()
  const base = results[0]?.base ?? baseIdentity(requestedBase)
  const projection = queueTimelineProjection(results, {
    now,
    windowMs: queueTimelineWindow(options.since),
    statuses: queueTimelineStatuses(options.status),
    terms: filters,
    latest: options.latest === true,
    rowLimit: queueTimelineRowLimit(io),
    submissionTimes: queueTimelineAdmissionTimes(results),
    siblingBases: queueBases(state),
    base,
    state: state.bays,
  })
  const outputs =
    includeOutputs && io.artifactRoot !== undefined ? await queueArtifactOutputs(results, io.artifactRoot) : []
  return {
    results,
    now,
    projection,
    ...(outputs.length === 0 ? {} : { outputs }),
  }
}

async function listQueues(
  app: YrdCliApp,
  filters: readonly string[],
  options: QueueListOptions,
  io: YrdCliIO,
): Promise<void> {
  const snapshot = await queueListSnapshot(app, filters, options, io)
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "queue.list",
      projection: snapshot.projection,
      results: snapshot.results.map(projectQueueStatusResultTaskStatus),
    },
    createElement(QueueTimelineView, { projection: snapshot.projection, columns: io.columns ?? 120 }),
  )
}

async function dashboard(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string }>,
  io: YrdCliIO,
): Promise<void> {
  await renderDashboard(app, options.base === undefined ? [] : [options.base], options, io)
}

async function primeYrd(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr = Object.values(state.bays.prs).find(
    (candidate) => (bay !== undefined && candidate.bay === bay.id) || candidate.branch === branch,
  )
  const queue = pr === undefined ? undefined : app.queue.status(pr.base)
  const briefing = {
    model: "issue -> bay -> pr -> queue -> integrated or rejected",
    loop: ["yrd pr submit", "yrd pr status", "yrd pr runs <PR>", "fix the branch and run yrd pr submit again"],
    live: {
      bay: bay?.id,
      pr: pr?.id,
      base: pr?.base ?? bay?.base,
      position: pr === undefined ? undefined : await queuedPrPosition(state, pr, io),
      pause: queue?.pause,
    },
    boundaries: ["the queue is the only merger", "issues are read-only references; edit them in the tracker"],
    json: "add --json to every read or mutation",
  }
  const live = [
    `bay=${briefing.live.bay ?? "-"}`,
    `pr=${briefing.live.pr ?? "-"}`,
    `base=${briefing.live.base ?? "-"}`,
    `position=${briefing.live.position && briefing.live.position > 0 ? briefing.live.position : "-"}`,
    `pause=${briefing.live.pause?.reason ?? "active"}`,
  ].join(" ")
  const human = [
    "Yrd agent briefing",
    "Pick an issue -> work in a bay -> submit a PR -> the queue runs checks and merges it.",
    "Loop:",
    ...briefing.loop.map((step, index) => `${index + 1}. ${step}`),
    `Live: ${live}`,
    "The queue is the only merger; pr merge only teaches the correct next command.",
    "The tracker holds the pen; yrd's issue surface is a read-only lens.",
    "Use --json for lossless machine-readable output.",
  ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "prime", ...briefing }, human)
}

function resolveQueueTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  filterPr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const bases = new Set<string>()
  const selected = new Set<string>()
  if (base !== undefined) bases.add(selectedBase(state, base))
  for (const selector of selectors) {
    const pr = resolvePR(state.bays, selector)
    if (pr === undefined) bases.add(selectedBase(state, selector))
    else {
      bases.add(pr.base)
      selected.add(pr.id)
    }
  }
  let canonicalFilter: string | undefined
  if (filterPr !== undefined) {
    const found = resolvePR(state.bays, filterPr)
    if (found === undefined) refusal(`no PR '${filterPr}'`)
    canonicalFilter = found.id
    selected.add(found.id)
    bases.add(found.base)
  }
  return { bases, selected, prFilter: canonicalFilter }
}

function queueLogTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  pr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const target = resolveQueueTargets(state, selectors, base, pr)
  if (selectors.length === 0 && base === undefined && pr === undefined) {
    for (const item of Object.values(state.bays.prs)) target.bases.add(item.base)
    for (const run of Object.values(state.queues.records)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  return target
}

type QueueLogOptions = Readonly<{
  all?: boolean
  base?: string
  failed?: boolean
  json?: boolean
  limit?: number
  pr?: string
  since?: string
}>

type QueueLogFilterRow = Readonly<{
  outcome: string
  finishedAt?: string
  startedAt?: string
  submittedAt?: string
}>

function queueLogSinceMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/u.exec(value.trim())
  if (match === null) usage("--since must be a duration such as 30m, 6h, or 1d")
  const amount = Number(match[1])
  const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]
  const durationMs = amount * unitMs!
  if (!Number.isFinite(durationMs) || durationMs < 0) usage("--since must be a finite non-negative duration")
  return durationMs
}

function filterQueueLogRows<T extends QueueLogFilterRow>(
  rows: readonly T[],
  options: QueueLogOptions,
  now: number,
): readonly T[] {
  const since = options.since === undefined ? undefined : now - queueLogSinceMs(options.since)
  const filtered = rows.filter((row) => {
    if (options.failed === true && row.outcome !== "rejected") return false
    if (since === undefined) return true
    const timestamp = row.finishedAt ?? row.startedAt ?? row.submittedAt
    return timestamp === undefined || Date.parse(timestamp) >= since
  })
  if (options.all === true) return filtered
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1) usage("--limit must be a positive integer")
  return filtered.slice(-limit)
}

async function logRuns(
  app: YrdCliApp,
  selectors: readonly string[],
  options: QueueLogOptions,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = queueLogTargets(state, selectors, options.base, options.pr)
  const summaries: QueueStatusResult[] = []
  for (const group of await queueTargetGroups(target.bases, io)) {
    const canonical = app.queue.status(group.base)
    const aliases = [...group.aliases].filter((base) => base !== group.base).map((base) => app.queue.status(base))
    const merged = mergedQueueRuns(canonical, aliases)
    const inScope = (run: QueueRun) =>
      target.selected.size === 0 || run.prs.some((member) => target.selected.has(member.id))
    const runs = {
      running: merged.running.filter(inScope),
      waiting: merged.waiting.filter(inScope),
      finished: merged.finished.filter(inScope),
    }
    summaries.push({
      base: group.base,
      ...runs,
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: Object.values(state.bays.prs).filter(
        (pr) => group.aliases.has(pr.base) && (target.selected.size === 0 || target.selected.has(pr.id)),
      ),
    })
  }
  const prStatusById = new Map<string, PR["status"]>(
    summaries.flatMap((result) => result.prs.map((pr) => [pr.id, pr.status])),
  )
  const revisionSubjects = new Map<string, string>()
  const cwd = io.cwd ?? process.cwd()
  for (const pr of summaries.flatMap((result) => result.finished.flatMap((run) => run.prs))) {
    const key = queueRevisionKey(pr)
    if (revisionSubjects.has(key)) continue
    const subject = commitSubject(cwd, pr.headSha)
    if (subject !== undefined) revisionSubjects.set(key, subject)
  }
  const runIds = new Set(
    summaries.flatMap((summary) => [...summary.running, ...summary.waiting, ...summary.finished].map((run) => run.id)),
  )
  const attempts = (await queueLogAttempts(app.events())).filter((attempt) => runIds.has(attempt.run))
  const revisionClocks = queueRunRevisionClocks(
    Object.values(state.bays.prs),
    summaries.flatMap((summary) => summary.finished),
  )
  const projectedRows = queueLogRows(
    summaries,
    target.selected,
    target.prFilter,
    prStatusById,
    attempts,
    revisionSubjects,
    revisionClocks,
  )
  const rows = filterQueueLogRows(projectedRows, options, io.now?.() ?? Date.now())
  const coverage = await queueLegacyCoverage(io.cwd ?? process.cwd(), await firstEventTimestamp(app))
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "log",
      rows,
      ...(options.all === true
        ? {
            results: summaries.map(projectQueueStatusResultTaskStatus),
            attempts: attempts.map((attempt) => ({
              ...attempt,
              ...taskStatusFields(jobAttemptTaskStatusOf(attempt)),
            })),
          }
        : {}),
      ...(coverage === undefined ? {} : { coverage }),
    },
    createElement(QueueLogView, { rows, coverage, columns: Math.min(io.columns ?? 120, 120) }),
  )
}

async function queueAudit(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const core = app.queue.audit()
  const environment = await services.queue?.auditEnvironment?.()
  const result = { findings: [...core.findings, ...(environment?.findings ?? [])] }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.audit", ...result },
    result.findings.length === 0
      ? "queue audit clean"
      : result.findings.map((finding) => `${finding.code}: ${finding.message}`).join("\n"),
  )
  return result.findings.length === 0 ? 0 : 1
}

async function queueAdministration(
  app: YrdCliApp,
  services: YrdCliServices,
  command: "init" | "deinit",
  base: string | undefined,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const action = command === "init" ? "provision" : "deprovision"
  const administration = services.queue
  const capability = administration?.[action]
  if (capability === undefined) configuration(`queue.${command} capability is not installed`)
  const selected = selectedBase(stateOf(app), base ?? "main")
  const result = await capability(selected)
  await printResult(
    io,
    jsonEnabled(options),
    { command: `queue.${command}`, base: selected, result },
    `${selected} ${command === "init" ? "initialized" : "deinitialized"}`,
  )
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 0) usage(`${label} must be a non-negative integer`)
  return value as number
}

function artifacts(values: unknown): readonly { name: string; uri: string }[] | undefined {
  const items = csv(values)
  if (items === undefined) return undefined
  return items.map((item) => {
    const separator = item.indexOf("=")
    if (separator <= 0 || separator === item.length - 1) {
      usage(`invalid --artifact '${item}'; expected name=path-or-url`)
    }
    return { name: item.slice(0, separator), uri: item.slice(separator + 1) }
  })
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function finishQueue(
  app: YrdCliApp,
  selector: string,
  options: {
    step?: string
    ok?: boolean
    fail?: boolean
    job?: string
    runner?: string
    attempt?: string
    token?: string
    detail?: string
    url?: string
    artifact?: unknown
    exitCode?: number
    durationMs?: number
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  if (options.ok === options.fail) usage("queue finish requires exactly one of --ok or --fail")
  const { job: jobId, runner, token } = options
  if (jobId === undefined || options.attempt === undefined || runner === undefined || token === undefined) {
    usage("queue finish requires --job, --runner, --attempt, and --token")
  }
  const attempt = Number(options.attempt)
  if (!Number.isSafeInteger(attempt) || attempt < 1) usage("--attempt must be a positive integer")
  const waiting = app.queue.waiting(selector, options.step)
  const selectedJob = waiting.step.job
  const recordedArtifacts = artifacts(options.artifact)
  const exitCode = positiveInteger(options.exitCode, "--exit-code")
  const durationMs = positiveInteger(options.durationMs, "--duration-ms")
  const evidence = {
    ...jsonRecord(selectedJob.checkpoint),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(selectedJob.artifacts === undefined && recordedArtifacts === undefined
      ? {}
      : { artifacts: [...(selectedJob.artifacts ?? []), ...(recordedArtifacts ?? [])] }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
  const resumed = await app.queue.finish(
    selector,
    {
      job: jobId,
      step: waiting.step.name,
      runner,
      attempt,
      token,
      result:
        options.ok === true
          ? { status: "passed", output: evidence }
          : {
              status: "failed",
              error: {
                code: `${waiting.step.name}-failed`,
                message: options.detail ?? `${waiting.step.name} failed externally`,
              },
              output: evidence,
            },
    },
    runtimeOptions(io),
  )
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.finish", run: projectQueueRunTaskStatus(resumed) },
    `${resumed.id} ${resumed.status}`,
  )
}

async function watchQueueRuns(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown; json?: boolean; interval?: number },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const intervalSeconds = options.interval ?? 15
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
    usage("--interval must be a positive number of seconds")
  }
  const interval = intervalSeconds * 1_000
  const scope = io.scope ?? app.scope
  const drainSignal = io.drainSignal
  const drainRequested = () => drainSignal?.aborted === true
  while (true) {
    const runs = await runQueues(app, selectors, options, io)
    if (jsonEnabled(options)) {
      for (const run of runs) {
        io.stdout(stableJson({ command: "queue.run", mode: "watch", run: projectQueueRunTaskStatus(run) }))
      }
    } else if (runs.length > 0) {
      await printHuman(io, createElement(QueueRunsView, { runs }))
    }
    const exit: YrdCliExitCode = runs.some((run) => run.status === "failed") ? 1 : 0
    if (drainRequested()) {
      if (runs.every(Queues.terminal)) return runs.at(-1)?.status === "failed" ? 1 : 0
      await scope.sleep(interval)
      continue
    }
    if (selectors.length > 0 || scope.signal.aborted) return exit
    await sleepUntilDrain(scope.sleep(interval), drainSignal)
    if (scope.signal.aborted) return exit
  }
}

async function sleepUntilDrain(sleep: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return sleep
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      result()
    }
    const onAbort = () => finish(resolve)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void sleep.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

async function watchQueue(
  app: YrdCliApp,
  filters: readonly string[],
  options: WatchOptions,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const interval = 1_000
  const scope = io.scope ?? app.scope
  const load = async (): Promise<QueueListSnapshot> =>
    queueListSnapshot(app, filters, options, io, !jsonEnabled(options))

  if (!jsonEnabled(options)) {
    io.stderr(`yrd watch runtime: ${formatYrdRuntimeVersion()}\n`)
    const renderLive = getLiveRenderer(io)
    if (renderLive === undefined) {
      refusal("watch requires an interactive terminal; use --json for streaming output")
    }
    const initial = await load()
    await renderLive(
      createElement(QueueWatchPane, {
        initial,
        load,
        intervalMs: interval,
        ...(options.pr === undefined ? {} : { pr: options.pr }),
      }),
      {
        signal: scope.signal,
      },
    )
    return 0
  }

  while (true) {
    const snapshot = await load()
    await printResult(
      io,
      true,
      {
        command: "queue.list",
        projection: snapshot.projection,
        results: snapshot.results.map(projectQueueStatusResultTaskStatus),
      },
      createElement(QueueTimelineView, { projection: snapshot.projection, columns: io.columns ?? 120 }),
    )
    if (scope.signal.aborted) return 0
    await scope.sleep(interval)
    if (scope.signal.aborted) return 0
  }
}

function competitors(
  input: string,
  prompt?: string,
): readonly { model: string; harness: string; config: { instructions?: string } }[] {
  const trimmed = input.trim()
  if (trimmed === "") usage("--agents must name at least one competitor")
  const firstSpace = trimmed.indexOf(" ")
  const harness = firstSpace > 0 ? trimmed.slice(0, firstSpace) : "ag"
  const modelList = firstSpace > 0 ? trimmed.slice(firstSpace + 1) : trimmed
  const models = modelList
    .split(/[/,]/u)
    .map((model) => model.trim())
    .filter(Boolean)
  if (models.length === 0) usage("--agents must name at least one competitor")
  return models.map((model) => ({
    model,
    harness,
    config: prompt === undefined ? {} : { instructions: prompt },
  }))
}

async function advanceContest(app: YrdCliApp, contest: string, io: YrdCliIO, retry = false): Promise<Contest> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  return app.contests.evaluate(contest, { ...runtimeOptions(io), concurrency, retry })
}

async function openContest(
  app: YrdCliApp,
  issueInput: string,
  options: { agents?: string; prompt?: string; evaluators?: unknown; base?: string; queue?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.agents === undefined) usage("contest open requires --agents <list>")
  if (options.prompt?.trim() === "") usage("--prompt requires non-empty text")
  const issue = await app.issues.resolve(app.issues.ref(issueInput))
  const requestedBase = oneOfAliases(options.base, options.queue, "base", "queue")
  const base = await app.contests.resolveBase(requestedBase)
  const opened = await app.contests.compete({
    issue,
    competitors: competitors(options.agents, options.prompt),
    ...(csv(options.evaluators) === undefined ? {} : { evaluators: csv(options.evaluators) }),
    base: base.base,
    baseSha: base.sha,
  })
  const contest = await advanceContest(app, opened.id, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.open", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function viewContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contest = app.contests.get(id)
  if (contest === undefined) refusal(`no contest '${id}'`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.view", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function evalContest(
  app: YrdCliApp,
  id: string,
  options: { retry?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const contest = await advanceContest(app, id, io, options.retry === true)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.eval", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function finishContest(
  app: YrdCliApp,
  id: string,
  options: {
    attempt?: string
    evaluator?: string
    ok?: boolean
    fail?: boolean
    error?: string
    token?: string
    detail?: string
    artifact?: unknown
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  const errorCode = options.error?.trim()
  if (options.error !== undefined && errorCode === "") usage("contest finish --error requires a non-empty code")
  const outcomes = Number(options.ok === true) + Number(options.fail === true) + Number(errorCode !== undefined)
  if (outcomes !== 1) usage("contest finish requires exactly one of --ok, --fail, or --error")
  if (options.token === undefined || options.token === "") usage("contest finish requires --token <token>")
  const recordedArtifacts = artifacts(options.artifact)?.map(({ name, uri }) => ({ kind: name, uri })) ?? []
  if (errorCode !== undefined && recordedArtifacts.length > 0) {
    usage("contest finish --artifact records evaluator verdict evidence and cannot be used with --error")
  }
  const contest = await app.contests.finish({
    contest: id,
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    ...(options.evaluator === undefined ? {} : { evaluator: options.evaluator }),
    token: options.token,
    result:
      errorCode === undefined
        ? {
            status: "passed",
            output: {
              verdict: options.ok === true ? "passed" : "failed",
              ...(options.detail === undefined ? {} : { summary: options.detail }),
              artifacts: recordedArtifacts,
            },
          }
        : {
            status: "failed",
            error: {
              code: errorCode,
              message: options.detail?.trim() || `remote evaluator failed (${errorCode})`,
            },
          },
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.finish", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function selectContest(
  app: YrdCliApp,
  id: string,
  options: { winner?: string; by?: string; reason?: string; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  if (options.winner === undefined || options.winner === "") usage("contest select requires --winner <attempt>")
  const contest = await app.contests.select({
    contest: id,
    attempt: options.winner,
    ...(options.by === undefined ? {} : { selectedBy: options.by }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.select", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function promoteContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  const contest = await app.contests.promote({ contest: id }, { ...runtimeOptions(io), concurrency })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.promote", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "promotion-failed" ? 1 : 0
}

async function listContests(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contests = app.contests.list()
  const human =
    contests.length === 0
      ? "No contests."
      : [
          "CONTEST ISSUE STATUS",
          ...contests.map(
            (contest) => `${contest.id} ${contest.issue.ref.source}:${contest.issue.ref.id} ${contest.status}`,
          ),
        ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "contest.list", contests }, human)
}

async function refusePrMerge(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    const next = `yrd pr submit ${selector}`
    const message = `the queue is the only merger; branch '${selector}' is not submitted; submit it: ${next}`
    const guidance = {
      command: "pr.merge",
      branch: selector,
      status: "not-submitted",
      next,
      guidance: { submit: next },
      failure: { kind: "refusal", code: "queue-only-merger", message },
    }
    if (jsonEnabled(options)) {
      io.stderr(stableJson(guidance))
      return 1
    }
    refusal(message)
  }

  const position = await queuedPrPosition(stateOf(app), pr, io)
  const detail = prMergeRefusalDetail(pr, position)
  const message = `the queue is the only merger; ${detail.message}`
  const guidance = {
    command: "pr.merge",
    pr: pr.id,
    status: pr.status,
    ...(position === undefined ? {} : { position }),
    next: detail.next,
    guidance: detail.guidance,
    failure: { kind: "refusal", code: "queue-only-merger", message },
  }
  if (jsonEnabled(options)) {
    io.stderr(stableJson(guidance))
    return 1
  }
  refusal(message)
}

function prMergeRefusalDetail(
  pr: PR,
  position: number | undefined,
): Readonly<{ next: string; guidance: Readonly<Record<string, string>>; message: string }> {
  if (pr.status === "submitted") {
    const watch = `yrd watch --pr ${pr.id}`
    return {
      next: watch,
      guidance: { watch },
      message: `PR '${pr.id}' is queued${position === undefined ? "" : ` at position ${position}`}; watch: ${watch}`,
    }
  }
  if (pr.status === "rejected") {
    const inspect = `yrd pr runs ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `PR '${pr.id}' was rejected; see: ${inspect}; then ${resubmit}`,
    }
  }
  if (pr.status === "pushed") {
    const submit = `yrd pr submit ${pr.branch}`
    return { next: submit, guidance: { submit }, message: `PR '${pr.id}' is not queued; submit it: ${submit}` }
  }
  const view = `yrd pr view ${pr.id}`
  return { next: view, guidance: { view }, message: `PR '${pr.id}' is ${pr.status}; see: ${view}` }
}

function maxExit(left: YrdCliExitCode, right: YrdCliExitCode): YrdCliExitCode {
  return Math.max(left, right) as YrdCliExitCode
}

function configureOutput(command: CliCommand, io: YrdCliIO, output: { wroteError: boolean }): void {
  command.configureOutput({
    writeOut: (text) => io.stdout(text),
    writeErr: (text) => {
      output.wroteError = true
      io.stderr(text)
    },
    getOutHasColors: () => io.color === true,
    getErrHasColors: () => io.color === true,
    getOutHelpWidth: () => io.columns ?? 80,
    getErrHelpWidth: () => io.columns ?? 80,
  })
  for (const child of command.commands) configureOutput(child as unknown as CliCommand, io, output)
}

function addExamples(program: CliCommand, name: string, projection: "root" | "bay"): void {
  const bay = projection === "bay" ? name : `${name} bay`
  const examples: [string, string][] = [
    [`$ ${bay} open fix --from topic`, "open an existing branch"],
    [`$ ${bay} submit`, "submit the current bay as a PR"],
  ]
  if (projection === "root") {
    examples.push(
      [`$ ${name} pr list`, "inspect active PRs"],
      [`$ ${name} queue run --steps check,merge`, "run selected steps"],
      [`$ ${name} watch --pr PR7`, "monitor PR and queue health"],
      [`$ ${name} contest open km:T1 -a codex/claude`, "compare implementations"],
    )
  }
  program.addHelpSection("Examples:", examples)
}

function addQueueExamples(queue: CliCommand, name: string): void {
  queue.addHelpSection("Examples:", [
    [`$ ${name} queue`, "list active queues"],
    [`$ ${name} queue run PR7 --steps check,merge`, "run selected steps for one PR"],
    [`$ ${name} log --base release/2.0`, "show completed work for a base"],
    [`$ ${name} pr runs PR7`, "show step-level run evidence and proofs"],
    [`$ ${name} queue pause --reason maintenance --allow PR7`, "pause all but selected PRs"],
    [`$ ${name} queue recover --json`, "recover expired runner leases"],
    [`$ ${name} queue run --watch`, "keep the default queue moving"],
  ])
}

function addAuthoredCarrierWorkflow<
  Options extends Record<string, unknown>,
  Arguments extends unknown[],
  ArgumentRecord extends Record<string, unknown>,
>(command: CliCommand<Options, Arguments, ArgumentRecord>, name: string): void {
  command.addHelpSection("Authored root carrier:", [
    [`$ ${name} pr submit <branch> --draft`, "record the immutable authored carrier as a draft PR"],
    [
      `$ ${name} pr recut <PR> --queue`,
      "recut and queue a new revision on that same PR; no composition manifest or manual recut",
    ],
  ])
}

function buildProgram(
  app: YrdCliApp | undefined,
  services: YrdCliServices,
  name: string,
  projection: "root" | "bay",
  io: YrdCliIO,
  setExit: (code: YrdCliExitCode) => void,
  commanderOutput: { wroteError: boolean },
  bootstrap?: RuntimeBootstrap,
): CliCommand {
  let runtimeApp = app
  let runtimeServices = services
  const installed = (): YrdCliApp => runtimeApp ?? configuration("command runtime is not initialized")
  const installedServices = (): YrdCliServices => runtimeServices
  const program = new CliCommand(name)
    .description(projection === "bay" ? "manage isolated Git work bays" : "yrd (shipyard) — agentic software delivery")
    .showHelpAfterError()
    .showSuggestionAfterError()
  program.helpCommand(false)
  program.exitOverride()
  program.configureHelp({ ...program.configureHelp(), minWidthToWrap: 20 })
  if (app === undefined) {
    configureYrdGlobalOptions(program)
  }
  if (bootstrap !== undefined) {
    program.hook("preAction", async (_root, action) => {
      if (runtimeApp !== undefined) return
      const globals = action.optsWithGlobals() as Readonly<{
        repo?: string
        verbose?: number
        quiet?: number
        logLevel?: string
      }>
      const selected = resolveYrdContext(globals, bootstrap.env, bootstrap.ambientCwd)
      const resident =
        action.name() === "run" &&
        action.parent?.name() === "queue" &&
        (action.opts() as Readonly<{ watch?: boolean }>).watch === true
      const loaded = await bootstrap.load(selected, { resident })
      runtimeApp = loaded.app
      runtimeServices = loaded.services
      Object.assign(io, loaded.io)
    })
  }
  if (projection === "root") program.version(YRD_VERSION, "-V, --version")
  if (projection === "root") {
    program.addHelpSection(
      "Model:",
      "Pick an issue -> work it in a bay -> submit as a PR -> PRs queue per base ->\na run verifies and merges each one -> integrated, or rejected with the log.",
    )
    program.addHelpSection("Objects:", [
      ["issue", "tracker-owned intent; yrd exposes a read-only delivery lens"],
      ["bay", "isolated Git workspace; also standalone as git-bay"],
      ["pr", "submitted branch@head revision; the queue's unit"],
      ["contest", "competing implementations; winner promotes to a PR"],
      ["queue", "one per base; verifies and merges PRs serially"],
    ])
    program.addHelpSection(
      "Boundaries:",
      "Runs, steps, jobs, attempts, and runners are records inside PRs and the log.\nThe queue is the only merger; pr merge is a teaching refusal.\nThe tracker holds the pen; yrd never creates or edits issues.",
    )
    program
      .command("_dashboard", { isDefault: true, hidden: true })
      .option("--base <branch>", "scope the dashboard to one base")
      .option("--json", "emit stable JSON")
      .action(async (options) => dashboard(installed(), options, io))
  }

  const bay = projection === "bay" ? program : program.command("bay").description("manage isolated Git work bays")
  bay.helpCommand(false)
  bay
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("open <name>")
    .description("open a work bay")
    .option("--from <branch>", "use an existing source branch")
    .option("--head <branch>", "alias for --from")
    .option("--base <branch>", "select the base branch")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--actor <id>", "record the worker or implementation identity")
    .option("--json", "emit stable JSON")
    .action(async (workName, options) => openBay(installed(), workName, options, io))
  bay
    .command("refresh [selector...]")
    .description("refresh work bays")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => refreshBays(installed(), selectors, options, io))
  bay
    .command("submit [selector...]")
    .description("submit bays or branches")
    .option("--draft", "register a pushed PR without requesting or admitting checks")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--correlation <namespace:id>", "bind an opaque correlation to the submitted revision")
    .option("--composition <path>", "immutable version-1 source composition JSON")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await submitBays(installed(), selectors, options, io, "bay.submit")))
  bay
    .command("close [selector...]")
    .description("close work bays")
    .option("--withdraw", "withdraw a live PR before closing")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => closeBays(installed(), selectors, options, io))

  if (projection === "bay") {
    addExamples(program, name, projection)
    configureOutput(program, io, commanderOutput)
    return program
  }

  program
    .command("log")
    .description("show queue history, newest first")
    .option("--base <branch>", "scope log to one base branch")
    .option("--pr <pr>", "scope log to one PR")
    .option("--failed", "show rejected history only")
    .option("--since <duration>", "show history within a duration")
    .option("-L, --limit <count>", "limit history rows", int, 20)
    .option("--all", "show all rows; include lossless queue and run records in JSON")
    .option("--json", "emit stable JSON")
    .action(async (options) => logRuns(installed(), [], options, io))

  program
    .command("watch [filter...]")
    .description("alias for queue ls --watch")
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope watch to one PR")
    .option("--status <statuses>", "comma-separated pending,running,rejected,integrated,other")
    .option("--since <duration>", "timeline window", "6h")
    .option("--latest", "show only the latest Run for each PR")
    .option("--json", "emit stable JSON")
    .action(async (filters, options) => {
      setExit(await watchQueue(installed(), filters, options, io))
    })

  program
    .command("prime")
    .description("brief an agent on Yrd and current delivery state")
    .option("--json", "emit stable JSON")
    .action(async (options) => primeYrd(installed(), options, io))

  const queue = program.command("queue").description("manage integration queues")
  queue.helpCommand(false)
  queue
    .command("_list [filter...]", { isDefault: true, hidden: true })
    .option("--base <branch>", "select one base queue")
    .option("--status <statuses>", "comma-separated pending,running,rejected,integrated,other")
    .option("--since <duration>", "timeline window", "6h")
    .option("--latest", "show only the latest Run for each PR")
    .option("--watch", "keep this projection live and interactive")
    .option("--json", "emit stable JSON")
    .action(async (filters, options) => {
      if (options.watch === true) {
        setExit(await watchQueue(installed(), filters, options, io))
        return
      }
      await listQueues(installed(), filters, options, io)
    })
  const queueList = queue
    .command("list [filter...]")
    .description("show the queue timeline")
    .option("--base <branch>", "select one base queue")
    .option("--status <statuses>", "comma-separated pending,running,rejected,integrated,other")
    .option("--since <duration>", "timeline window", "6h")
    .option("--latest", "show only the latest Run for each PR")
    .option("--watch", "keep this projection live and interactive")
    .option("--json", "emit stable JSON")
    .action(async (filters, options) => {
      if (options.watch === true) {
        setExit(await watchQueue(installed(), filters, options, io))
        return
      }
      await listQueues(installed(), filters, options, io)
    })
  queue
    .command("audit")
    .description("check queue state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueAudit(installed(), installedServices(), options, io)))
  queue
    .command("init [base]")
    .description("prepare queue resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => queueAdministration(installed(), installedServices(), "init", base, options, io))
  queue
    .command("deinit [base]")
    .description("release queue resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => queueAdministration(installed(), installedServices(), "deinit", base, options, io))
  queue
    .command("pause [base]")
    .description("pause new queue runs")
    .option("--reason <text>", "record the pause reason")
    .option("--allow [pr...]", "PR ids allowed through the pause")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => pauseQueue(installed(), base, options, io))
  queue
    .command("resume [base]")
    .description("resume a paused queue")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => resumeQueue(installed(), base, options, io))
  queue
    .command("recover")
    .description("recover expired runner leases")
    .option("--reason <text>", "record the recovery reason")
    .option("--json", "emit stable JSON")
    .action(async (options) => recoverQueue(installed(), options, io))
  queue
    .command("run [selector...]")
    .description("run queue steps for PRs")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--watch", "keep draining the default queue")
    .option("--interval <seconds>", "watch interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      if (options.watch === true) {
        setExit(await watchQueueRuns(installed(), selectors, options, io))
        return
      }
      const runs = await runQueues(installed(), selectors, options, io)
      await printResult(
        io,
        jsonEnabled(options),
        { command: "queue.run", results: runs.map(projectQueueRunTaskStatus) },
        createElement(QueueRunsView, { runs }),
      )
      setExit(runs.some((run) => run.status === "failed") ? 1 : 0)
    })
  queue
    .command("finish <selector>")
    .description("resume a waiting step")
    .option("--step <name>", "waiting step name")
    .option("--ok", "record a passing result")
    .option("--fail", "record a failing result")
    .option("--job <id>", "waiting-job id")
    .option("--runner <runner>", "waiting-job runner identity")
    .option("--attempt <attempt>", "waiting-job attempt number")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => finishQueue(installed(), selector, options, io))
  addQueueExamples(queue, name)

  const pr = program.command("pr").description("manage pull requests")
  pr.helpCommand(false)
  pr.command("list")
    .description("list pull requests")
    .option("--base <branch>", "scope PRs to one base")
    .option("--state <state>", "scope PRs to one native state")
    .option("--issue <ref>", "scope PRs to one issue reference")
    .option("--needs-review", "show revisions needing approval")
    .option("--json", "emit stable JSON")
    .action(async (options) => listPrs(installed(), options, io))
  const submit = pr
    .command("submit [selector...]")
    .description("submit PR revisions and admit configured checks")
    .option("--draft", "register a pushed PR without requesting or admitting checks")
    .option("--follow", "follow admitted checks to a terminal result")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--correlation <namespace:id>", "bind an opaque correlation to the submitted revision")
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root carriers")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await submitBays(installed(), selectors, options, io, "pr.submit")))
  addAuthoredCarrierWorkflow(submit, name)
  pr.command("view <selector>")
    .description("show a PR and its runs")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPr(installed(), selector, options, io))
  pr.command("runs <selector>")
    .description("show run, step, attempt, proof, and artifact detail")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPrRuns(installed(), selector, options, io))
  pr.command("diff <selector>")
    .description("show the candidate diff")
    .option("--stat", "show diff statistics")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => diffPr(installed(), selector, options, io))
  pr.command("checkout <selector>")
    .description("materialize a bay from a PR branch")
    .option("--bay <name>", "name the new bay")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => checkoutPr(installed(), selector, options, io))
  pr.command("status")
    .description("show the current bay or branch PR")
    .option("--json", "emit stable JSON")
    .action(async (options) => statusPr(installed(), options, io))
  pr.command("edit <selector>")
    .description("edit the issue link or note")
    .option("--issue <ref>", "set the tracker-neutral issue reference")
    .option("--note <text>", "set the delivery note")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => editPr(installed(), selector, options, io))
  const recut = pr
    .command("recut <selector>")
    .description("mechanically recut an immutable PR revision onto authoritative current base")
    .option("--revision <number>", "select an older immutable PR revision", int)
    .option("--queue", "ready the fresh revision and admit its configured checks")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(await recutPr(installed(), installedServices(), selector, options, io)),
    )
  addAuthoredCarrierWorkflow(recut, name)
  pr.command("ready <selector>")
    .description("submit a pushed PR revision and admit configured checks")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await readyPr(installed(), selector, options, io)))
  pr.command("review <selector>")
    .description("record a revision-bound review verdict")
    .option("--approve", "approve the current revision")
    .option("--reject", "reject the current revision")
    .option("--by <actor>", "reviewer identity")
    .option("--ref <id>", "idempotency reference")
    .option("--note <text>", "review note")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => reviewPr(installed(), selector, options, io))
  pr.command("comment <selector>")
    .description("record a non-gating revision comment")
    .option("--by <actor>", "commenter identity")
    .option("--ref <id>", "idempotency reference")
    .requiredOption("--note <text>", "comment text")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => commentPr(installed(), selector, options, io))
  pr.command("checks <selector...>")
    .description("show admitted checks for current PR revisions")
    .option("--follow", "follow active checks to a terminal result")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await prChecks(installed(), selectors, options, io)))
  pr.command("regression <selector>")
    .description("record one completed escaped regression and its integrated repair")
    .requiredOption("--run <run>", "original integration run")
    .requiredOption("--detected-at <timestamp>", "ISO-8601 detection timestamp")
    .requiredOption("--severity <severity>", "low, medium, high, or critical")
    .requiredOption("--evidence <ref>", "opaque regression evidence reference")
    .requiredOption("--implementation-run <ref>", "opaque original implementation run reference")
    .requiredOption("--review <ref>", "opaque original review reference")
    .requiredOption("--repair-pr <pr>", "integrated repair PR")
    .requiredOption("--repair-run <run>", "repair integration run")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      recordPrRegression(installed(), selector, options as unknown as PrRegressionOptions, io),
    )
  pr.command("close [selector...]")
    .description("close a live PR without merging (leaves it out of the queue)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => closePrs(installed(), selectors, options, io))
  pr.command("merge <selector>")
    .description("teach that the queue is the only merger")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await refusePrMerge(installed(), selector, options, io)))

  const migrate = program.command("migrate").description("run explicit journal compatibility migrations")
  migrate.helpCommand(false)
  migrate
    .command("terminal-associations")
    .description("prove and append legacy rejected-PR Queue run associations")
    .option("--apply", "append every uniquely proven association")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await migrateTerminalAssociations(installed(), options, io)))

  const issue = program.command("issue").description("inspect tracker-neutral issue delivery")
  issue.helpCommand(false)
  issue
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listIssues(installed(), options, io))
  issue
    .command("view <issue>")
    .description("show Yrd delivery records joined to an issue")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => listIssues(installed(), options, io, issueId))

  const contest = program.command("contest").description("inspect and select contest attempts")
  contest.helpCommand(false)
  contest
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listContests(installed(), options, io))
  contest
    .command("open <issue>")
    .description("compare implementations of one real issue")
    .option("-a, --agents <agents>", "ag-style competitor list")
    .option("--prompt <text>", "additional implementation instructions")
    .option("--evaluators [evaluator...]", "evaluator ids, comma-separated or repeated")
    .option("--base <branch>", "base branch")
    .option("--queue <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => setExit(await openContest(installed(), issueId, options, io)))
  contest
    .command("eval <contest>")
    .description("run pending work and evaluators")
    .option("--retry", "retry failed work or re-evaluate failed verdicts")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await evalContest(installed(), contestId, options, io)))
  contest
    .command("finish <contest>")
    .description("finish a waiting evaluator")
    .option("--attempt <attempt>", "contest attempt id")
    .option("--evaluator <evaluator>", "evaluator id")
    .option("--ok", "record a passing evaluator verdict")
    .option("--fail", "record a failing evaluator verdict")
    .option("--error <code>", "record an evaluator infrastructure failure")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result summary")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => finishContest(installed(), contestId, options, io))
  contest
    .command("view <contest>")
    .description("show attempts, metrics, and evidence")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => viewContest(installed(), contestId, options, io))
  contest
    .command("select <contest>")
    .description("select a winner")
    .option("--winner <attempt>", "winning attempt id")
    .option("--by <actor>", "selector identity")
    .option("--reason <text>", "selection rationale")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => selectContest(installed(), contestId, options, io))
  contest
    .command("promote <contest>")
    .description("submit the selected Git pin")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await promoteContest(installed(), contestId, options, io)))

  const order = new Map(
    ["pr", "bay", "issue", "contest", "queue", "migrate", "log", "watch", "prime"].map((command, index) => [
      command,
      index,
    ]),
  )
  const orderedCommands = program.commands as unknown as CliCommand[]
  orderedCommands.sort((left, right) => (order.get(left.name()) ?? 99) - (order.get(right.name()) ?? 99))
  addExamples(program, name, projection)
  configureOutput(program, io, commanderOutput)
  return program
}

/** Run the one Yrd command surface. git-bay projects its canonical bay subtree;
 * every mutation still resolves through the composed app's command registry. */
async function executeYrd(
  app: YrdCliApp | undefined,
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
  bootstrap?: RuntimeBootstrap,
): Promise<YrdCliExitCode> {
  const invocation = resolveInvocation(argv)
  if (invocation.args.length === 1 && (invocation.args[0] === "--version" || invocation.args[0] === "-V")) {
    io.stdout(`${formatYrdRuntimeVersion()}\n`)
    return 0
  }
  let exit: YrdCliExitCode = 0
  const setExit = (code: YrdCliExitCode) => {
    exit = maxExit(exit, code)
  }
  const runtimeIO: YrdCliIO = { ...io }
  const commanderOutput = { wroteError: false }
  const program = buildProgram(
    app,
    services,
    invocation.name,
    invocation.projection,
    runtimeIO,
    setExit,
    commanderOutput,
    bootstrap,
  )
  const canonicalArgs = canonicalizeYrdCommandAliases(invocation.args, invocation.projection)
  const args =
    invocation.projection === "root" && canonicalArgs.length === 1 && canonicalArgs[0] === "pr"
      ? ["pr", "--help"]
      : canonicalArgs
  try {
    await program.parseAsync(args, { from: "user" })
    return exit
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === "commander.helpDisplayed") return 0
      if (!commanderOutput.wroteError) await diagnostic(runtimeIO, invocation.name, error)
      return 2
    }
    const { exitCode } = classifyFailure(error)
    const globals = program.opts() as Readonly<{ verbose?: number }>
    await diagnostic(runtimeIO, invocation.name, error, { verbose: (globals.verbose ?? 0) > 0 })
    return exitCode
  }
}

/** Render command metadata without creating a repository-backed runtime. */
export function runYrdHelp(argv: readonly string[], io: YrdCliIO): Promise<YrdCliExitCode> {
  return executeYrd(undefined, argv, io, {})
}

/** Initialize the process-owned runtime from the one parsed global context. */
export function runYrdProcessRuntime(
  argv: readonly string[],
  io: YrdCliIO,
  bootstrap: RuntimeBootstrap,
): Promise<YrdCliExitCode> {
  return executeYrd(undefined, argv, io, {}, bootstrap)
}

/** Run the one Yrd command surface. git-bay projects its canonical bay subtree;
 * every mutation still resolves through the composed app's command registry. */
export function runYrd(
  app: YrdCliApp,
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
): Promise<YrdCliExitCode> {
  return executeYrd(app, argv, io, services)
}
