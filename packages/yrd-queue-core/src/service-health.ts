/**
 * The health document that carries the queue's alarm.
 *
 * A stuck change STOPS THE LINE (the andon, operator 2026-09-16: "STUCK means
 * fail loud and fix - andon - stop the line - fix it"). The queue pauses itself
 * naming the change, the service stays up and holds the stop, and this
 * document is the page: it reads the stop the round derived, and it clears when
 * the line resumes — never by itself, because no timer ever resumes a stopped
 * line. The backoff ladder that once re-ran a stuck round until it cleared is
 * gone with the step-over it served.
 *
 * Everything here is pure — no clock, no filesystem, no Git. The loop supplies
 * the stop and writes what these functions return, which is what lets the
 * document be asserted without a queue.
 *
 * The schema string below is the supervisor's contract, spoken as a literal
 * on purpose: this package is standalone and must not depend on the host that
 * vendors it. The exit-code ladder is part of that contract and is stated in
 * {@link queueHealthExitCode}.
 */

import { stopFact, stuckCures, type PauseRecord } from "./pause.ts"
import { changeName } from "./refs.ts"

export const QUEUE_HEALTH_SCHEMA = "hab-service-health/2" as const

/** Where the loop leaves the document it wrote, relative to the queue workdir. */
export const QUEUE_HEALTH_DOCUMENT = "service-health.json"

/**
 * The round lock's file, relative to the queue workdir: a kernel flock that one
 * round holds at a time. Its body names the holder for a waiter to say whose
 * round it waits for, and is judged nowhere.
 */
export const ROUND_LOCK = "round.lock"

/**
 * How long a round was once measured to take at most, and NO LONGER A DEADLINE.
 *
 * It was the staleness term (@cto, 2026-09-11): a document written at a round's
 * end was believed for the loop's sleep plus this budget, because a document
 * with no expiry asserts a verdict it did not measure. Rounds outgrew it —
 * @dev/11 read 289 round journals on 2026-09-16 and 31 ran past ten minutes,
 * the longest 36.9 — and nothing ends a round at it, so a live round read
 * overdue and paged. Freshness now follows the WRITER, not the round
 * (@i/4-supervision/24523 F4): see {@link HEARTBEAT_INTERVAL_MS}.
 *
 * What survives is a WAIT CAP: the relaunch that waits for its checkout replaces
 * a round, so it announces a stall once it has waited as long as a round was
 * allowed to take. A real bound on a round belongs to @i/10-yrd/24227, derived
 * from the round's own declared check limits.
 */
export const ROUND_BUDGET_MS = 10 * 60 * 1000

/**
 * How long a line may hold waiting changes without judging one before its
 * health says it is STALLED (25669): the documented default of `.yrd.yml`
 * `health.stallAfter`, used when the declaration names none.
 *
 * 45 minutes, from one week of this repository's round journals (09-18 to
 * 09-24, @cto d3af5793): rounds that judged one change with checks on took 31
 * to 37 minutes, with outliers to 82, so a 30-minute default would page on
 * ordinary long rounds. A bead row re-tunes it from the per-round waiting count
 * once a week of that count exists.
 *
 * This is the port of the flow instrument the old core carried
 * (`queueProgressAuditFindings`, 08-10; `queue-liveness-wedged`, 08-30) and
 * lost with it on 09-03 in b5b468037c.
 */
export const DEFAULT_STALL_AFTER_MS = 45 * 60 * 1000

/**
 * The lowest `health.stallAfter` a declaration may set. A round may legitimately
 * run to the round budget, so a smaller threshold would page on every long
 * round; until @i/10-yrd/24227 derives a bound from the declared checks, the
 * floor is {@link ROUND_BUDGET_MS}.
 */
export const STALL_AFTER_FLOOR_MS = ROUND_BUDGET_MS

/**
 * How often the service restates its document while it lives
 * (@i/4-supervision/24523 D6).
 *
 * Every minute, whatever the loop is doing — a round open for half an hour, an
 * idle sleep, a line held stopped, a relaunch waiting on its checkout — so a
 * document's freshness follows its writer, never the length of a round.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000

/**
 * How long past its next heartbeat a document is still believed.
 *
 * The heartbeat is a timer on the loop's own event loop, so synchronous work
 * that holds the loop holds the heartbeat too. This grace bounds how long such
 * work may stall the loop before a live writer reads overdue. A longer stall is
 * a true page, not a false one: a loop held that long is not doing its work,
 * whether or not its process is alive. A writer that is gone or wedged pages
 * within six minutes of its last write.
 */
export const HEARTBEAT_GRACE_MS = 300_000

export type QueueHealthState = "healthy" | "absent" | "unhealthy" | "unknown"

export type QueueHealthVerdict =
  | { readonly kind: "running" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unknown"; readonly reason: "absent" | "unparsed" | "timeout"; readonly observed: string | null }

/** A typed fault: what broke, why, and the lines that clear it. */
export type QueueHealthFailure = Readonly<{
  code: string
  cause: string
  resolution: readonly string[]
}>

export type QueueHealthDocument = Readonly<{
  schema: typeof QUEUE_HEALTH_SCHEMA
  service: string
  state: QueueHealthState
  verdict: QueueHealthVerdict
  error?: QueueHealthFailure
  facts?: Readonly<Record<string, unknown>>
}>

/**
 * The exit code a probe declaring `state` must use.
 *
 * Three claims plus one disclaimer, and this is the supervisor's ladder, not
 * this package's invention: `healthy 0`, `absent 1`, `unhealthy 2`,
 * `unknown 3`. A probe that prints a state and exits with a different code is
 * making two claims that disagree, so the one function both the printer and
 * its tests read is the only place the mapping exists.
 */
export function queueHealthExitCode(state: QueueHealthState): 0 | 1 | 2 | 3 {
  switch (state) {
    case "healthy":
      return 0
    case "absent":
      return 1
    case "unhealthy":
      return 2
    case "unknown":
      return 3
  }
}

/**
 * The process that writes the document, in the shape the supervisor identifies
 * a writer by (`facts.runner`, @i/4-supervision/24523 D2): whether the process
 * at `pid` is still the one that started at `startedAt` is the supervisor's
 * question to answer, never a reader's.
 */
export type HealthWriter = Readonly<{ pid: number; startedAt: string; command: string }>

/** How often a writer restates its document, and how long past that the document is still believed. */
export type HealthHeartbeat = Readonly<{ intervalMs: number; graceMs: number }>

const SERVICE_HEARTBEAT: HealthHeartbeat = { graceMs: HEARTBEAT_GRACE_MS, intervalMs: HEARTBEAT_INTERVAL_MS }

/**
 * WHEN A DOCUMENT STOPS BEING BELIEVABLE, written by its writer rather than
 * computed by a reader: one heartbeat plus grace from the write, and nothing
 * else — not the sleep a round chose, not how long a round may take. The writer
 * is the only party that knows its heartbeat, so a reader re-deriving the
 * deadline would be a second opinion about the one thing the writer is
 * authoritative on.
 */
function freshness(heartbeat: HealthHeartbeat, now: Date): Readonly<{ writtenAt: string; staleAfter: string }> {
  return {
    writtenAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + heartbeat.intervalMs + heartbeat.graceMs).toISOString(),
  }
}

/**
 * The document as its writer publishes it at `now`: written then, believed for
 * one heartbeat plus grace, and naming the process that wrote it.
 *
 * EVERY WRITE THE LOOP MAKES GOES THROUGH HERE — its start, each round's end,
 * the relaunch wait's documents and every heartbeat — which is what makes the
 * freshness rule one rule rather than a formula per builder (24523 F4). The
 * state is the caller's and is carried unchanged, so a heartbeat restating a
 * stopped line's page restates the page.
 */
export function writtenHealthDocument(
  document: QueueHealthDocument,
  writer: HealthWriter,
  heartbeat: HealthHeartbeat,
  now: Date,
): QueueHealthDocument {
  const written = freshness(heartbeat, now)
  return { ...document, facts: { ...document.facts, ...written, runner: { ...writer, lastTickAt: written.writtenAt } } }
}

/**
 * The document the loop writes at the end of every round, and at its start for
 * the line as it stands then (24523 F1): a relaunch continues a standing page
 * rather than clearing it and opening it again.
 *
 * `running` either way: the loop IS the instance, and it is alive to write
 * this. What changes is `state`, which is what the supervisor pages on, and it
 * reads the STOP THE ROUND DERIVED (pause.ts `lineStop`), never a judgement of
 * its own: a stuck stop is `unhealthy` for as long as it stands, and the page's
 * body is the stuck record's own cures, carried on the stop. An operator's
 * pause is deliberate and pages nobody, and says so in its facts.
 */
export function roundHealthDocument(
  service: string,
  stop: PauseRecord | undefined,
  sleepMs: number,
  now: Date,
  flow?: FlowReading,
  readFailure?: RoundReadFailure,
  stuck: readonly string[] = [],
  unfinishedRelease?: string,
): QueueHealthDocument {
  const base = { schema: QUEUE_HEALTH_SCHEMA, service, verdict: { kind: "running" } as const }
  const facts = {
    ...freshness(SERVICE_HEARTBEAT, now),
    nextRoundInMs: sleepMs,
    stopped: stopFact(stop),
    ...(stuck.length === 0 ? {} : { stuckChanges: stuck }),
    ...(unfinishedRelease === undefined ? {} : { unfinishedStuckRelease: unfinishedRelease }),
  }
  if (unfinishedRelease !== undefined) {
    const completing: QueueHealthDocument = {
      ...base,
      state: "unhealthy",
      error: {
        code: "queue-stuck-release-incomplete",
        cause: `unfinished stuck release at ${unfinishedRelease}, completing`,
        resolution: ["The service completes this release on its next round; no operator resume is needed."],
      },
      facts,
    }
    return withRoundReadFailure(
      flow === undefined ? completing : withLineFlow(completing, stop, flow, now),
      readFailure,
    )
  }
  if (stuck.length > 0 && stop?.cause !== "stuck") {
    const branch = stuck[0]
    if (branch === undefined) throw new Error("stuck health needs a branch")
    const paused = stop === undefined ? "" : `; a ${stop.cause} pause also stands`
    const paged: QueueHealthDocument = {
      ...base,
      state: "unhealthy",
      error: {
        code: "queue-round-stuck",
        cause: `${STUCK_RECORD_CODE}: the line stopped at stuck change ${branch}${paused}`,
        resolution: [
          `Repair ${branch}, then run yrd queue resume to retry it; or withdraw or merge the change.`,
          `The stuck event and its evidence: yrd queue show ${branch}.`,
          "The service remains alive and holds the line; this page does not clear by itself.",
        ],
      },
      facts,
    }
    return withRoundReadFailure(flow === undefined ? paged : withLineFlow(paged, stop, flow, now), readFailure)
  }
  if (stop?.cause !== "stuck" || stop.change === undefined) {
    const healthy: QueueHealthDocument = { ...base, state: "healthy", facts }
    return withRoundReadFailure(flow === undefined ? healthy : withLineFlow(healthy, stop, flow, now), readFailure)
  }
  const change = changeName(stop.change)
  return withRoundReadFailure(
    {
      ...base,
      state: "unhealthy",
      error: {
        code: "queue-round-stuck",
        cause: `${STUCK_RECORD_CODE}: the line stopped at ${change}: ${stop.reason}`,
        resolution: [
          // The stuck record's own next step, carried on the stop rather than
          // re-worded here: a refusal names its cure (G1), and a page is read by
          // someone who has not got the journal open.
          stop.next ?? stuckCures(stop.change.branch),
          `The stuck record, its evidence and its log: yrd queue show ${stop.change.branch}.`,
          "No restart is needed or wanted: the service is alive, holds the line stopped, and checks and merges nothing.",
          `This page clears when the line resumes — ${change} withdrawn or merged, or the queue resumed — and never by itself.`,
        ],
      },
      facts,
    },
    readFailure,
  )
}

/**
 * THE LINE'S FLOW, as the service loop last knew it (25669): how many changes
 * wait, the oldest of them, when a change was last judged, and whether a round
 * is open now. The loop keeps it and every health write carries it, so `queue
 * list`, the watch and its runner line read one fact instead of each recounting.
 */
export type LineFlow = Readonly<{
  /** Changes in line: submitted and not yet ended. */
  waiting?: number
  /** The longest-waiting of them, by when its change opened. */
  oldestWaiting?: Readonly<{ branch: string; openedAt: string }>
  /** When the queue last JUDGED a change: merged, failed or recorded stuck. */
  lastJudgedAt?: string
  /** When the last round completed. */
  lastRoundEndedAt?: string
  /**
   * The round running now, when one is: the change it works and the phase it is
   * in, as its own journal last named them, or why the journal could not say.
   */
  roundOpen?: Readonly<{ startedAt: string; branch?: string; phase?: string; phaseUnread?: string }>
  casRefused?: Readonly<{
    /** Present only when a change was selected before its publication failed. */
    branch?: string
    ref: string
    marker: string
    count: number
    site?: string
    budgetMs?: number
    firstAt?: string
  }>
}>

/** The declared stall threshold and whether the declaration named it or the default applies. */
export type StallThreshold = Readonly<{ ms: number; declared: boolean }>

/** A flow reading and the threshold it is judged against, as the loop hands both to a health write. */
export type FlowReading = Readonly<{ flow: LineFlow; threshold: StallThreshold }>

/** The last remote-read round failure; the service retains and counts it until one round succeeds. */
export type RoundReadFailure = Readonly<{ ref: string; error: string; count: number }>

/** A stalled line: how long no change has been judged, which of the two shapes it is, and the sentence that says so. */
export type LineStall = Readonly<{ forMs: number; shape: "slow-round" | "stopped-line" | "cas-refused"; cause: string }>

/** The code a stalled line pages with, beside `queue-round-stuck`. */
export const STALLED_LINE_CODE = "queue-line-stalled"

/**
 * WHETHER THE LINE IS STALLED (25669, @cto d3af5793): changes wait, and none has
 * been judged for the threshold. The clock starts at the LATER of the last
 * judgement and the oldest waiting change's opening, so a change submitted into
 * a line idle for hours starts its own clock rather than paging at once. Idle is
 * not stalled: with nothing waiting this is always undefined.
 *
 * Judged, not "a round completed": on 09-24 rounds completed every few minutes
 * from 20:45Z, five records each, and judged nothing while 11 to 22 waited.
 *
 * The sentence names which of two shapes it sees, so a legitimately slow round
 * costs little triage and a stopped or blind line — the one this exists for —
 * reads as itself.
 */
export function lineStall(flow: LineFlow, threshold: StallThreshold, now: Date): LineStall | undefined {
  if (flow.casRefused !== undefined && flow.casRefused.count >= 3) {
    const refusal = flow.casRefused
    const first = refusal.firstAt === undefined ? 0 : Math.max(0, now.getTime() - Date.parse(refusal.firstAt))
    const detail = refusal.site === undefined ? "" : ` at ${refusal.site} (${String(refusal.budgetMs)}ms budget)`
    const unread = flow.waiting === undefined ? "; line not read this round" : ""
    return {
      forMs: first,
      shape: "cas-refused",
      cause: `publication CAS refused ${String(refusal.count)} consecutive times${detail} for ${refusal.ref} at ${refusal.marker}${unread}; the queue remains alive and will retry`,
    }
  }
  const forMs = unjudgedFor(flow, now)
  if (forMs === undefined || flow.oldestWaiting === undefined || forMs < threshold.ms) return undefined
  const opened = Date.parse(flow.oldestWaiting.openedAt)
  const source = threshold.declared ? ".yrd.yml health.stallAfter" : ".yrd.yml health.stallAfter, default"
  const observation =
    `no change judged for ${span(forMs)} (oldest waiting ${flow.oldestWaiting.branch}, opened ${span(now.getTime() - opened)} ago); ` +
    `threshold ${span(threshold.ms)} (${source})`
  if (flow.roundOpen !== undefined) {
    const running = span(now.getTime() - Date.parse(flow.roundOpen.startedAt))
    const on = flow.roundOpen.branch === undefined ? "" : ` on ${flow.roundOpen.branch}`
    const at =
      flow.roundOpen.phase !== undefined
        ? `, at ${flow.roundOpen.phase}`
        : flow.roundOpen.phaseUnread !== undefined
          ? ` (phase unread: ${flow.roundOpen.phaseUnread})`
          : ""
    return {
      cause: `a round has been running its checks for ${running}${on}${at}; ${observation}`,
      forMs,
      shape: "slow-round",
    }
  }
  const last =
    flow.lastRoundEndedAt === undefined
      ? "no round has completed since the service started"
      : `last completed round at ${flow.lastRoundEndedAt.slice(11, 16)}Z judged nothing`
  return {
    cause: `no round running; ${last} while ${String(flow.waiting)} waited; ${observation}`,
    forMs,
    shape: "stopped-line",
  }
}

/**
 * How long changes have waited with none judged: the stall clock itself, from
 * the LATER of the last judgement and the oldest waiting change's opening.
 * Undefined when nothing waits, because idle is not waiting on anything.
 */
function unjudgedFor(flow: LineFlow, now: Date): number | undefined {
  if (flow.waiting === undefined || flow.waiting <= 0 || flow.oldestWaiting === undefined) return undefined
  const opened = Date.parse(flow.oldestWaiting.openedAt)
  const judged = flow.lastJudgedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(flow.lastJudgedAt)
  return now.getTime() - Math.max(opened, judged)
}

/**
 * The document with the line's flow judged at `now` (25669): the flow stated as
 * a fact, and a stalled line paged. What the service loop writes at a round's
 * end AND what its heartbeat restates between rounds, so a stall that develops
 * during a long round — the 09-24 specimen was one 50-minute round — is judged
 * on the heartbeat's clock rather than waiting for the round to end.
 *
 * Only a line with no stop can read stalled. A stuck stop already pages, naming
 * its change, and outranks this; an operator's pause is deliberate and pages
 * nobody, so a paused line is not a stalled one. Any other page the document
 * carries (the relaunch wait's, say) stands, with the flow stated beside it.
 */
export function withLineFlow(
  document: QueueHealthDocument,
  stop: PauseRecord | undefined,
  reading: FlowReading,
  now: Date,
  readFailure?: RoundReadFailure,
): QueueHealthDocument {
  const foreign = document.error !== undefined && document.error.code !== STALLED_LINE_CODE
  const stall = stop === undefined && !foreign ? lineStall(reading.flow, reading.threshold, now) : undefined
  const facts = { ...document.facts, flow: flowFact(reading, unjudgedFor(reading.flow, now), stall) }
  if (foreign) return withRoundReadFailure({ ...document, facts }, readFailure)
  const { error: _cleared, ...rest } = document
  if (stall === undefined) return withRoundReadFailure({ ...rest, state: "healthy", facts }, readFailure)
  return withRoundReadFailure(
    { ...rest, state: "unhealthy", error: stalledFailure(stall, reading.flow), facts },
    readFailure,
  )
}

/** One more condition on the existing line-health rail, without claiming an unknown waiting count. */
function withRoundReadFailure(
  document: QueueHealthDocument,
  failure: RoundReadFailure | undefined,
): QueueHealthDocument {
  if (failure === undefined) return document
  const facts = { ...document.facts, roundReadFailure: failure }
  if (failure.count < 3 || (document.error !== undefined && document.error.code !== STALLED_LINE_CODE)) {
    return { ...document, facts }
  }
  return {
    ...document,
    state: "unhealthy",
    facts,
    error: {
      code: STALLED_LINE_CODE,
      cause: `remote read failed ${String(failure.count)} consecutive rounds for ${failure.ref}: ${failure.error}; the service remains alive and will retry`,
      resolution: [
        `Read the failed round journal and repair the remote read of ${failure.ref}: ${failure.error}.`,
        "The service retries at its next interval and clears this page after one successful round.",
      ],
    },
  }
}

/**
 * The flow as the document states it: the reading, the threshold it was judged
 * against, how long waiting changes have gone unjudged, and the stall when
 * there is one. `slow` is the early word, before any page (25669 row 2): past
 * {@link ROUND_BUDGET_MS} no round has judged anything, the time a round that
 * judges normally was measured to take at most. The watch's runner line and
 * `yrd queue health` read these fields; neither recomputes them.
 */
function flowFact(
  reading: FlowReading,
  unjudgedForMs: number | undefined,
  stall: LineStall | undefined,
): Readonly<Record<string, unknown>> {
  return {
    ...reading.flow,
    stallAfterMs: reading.threshold.ms,
    stallAfterDeclared: reading.threshold.declared,
    ...(unjudgedForMs === undefined ? {} : { slow: unjudgedForMs > ROUND_BUDGET_MS, unjudgedForMs }),
    ...(stall === undefined ? {} : { stalledForMs: stall.forMs, stalledShape: stall.shape }),
  }
}

/** The page a stalled line raises: its sentence, and what a reader does about it. */
function stalledFailure(stall: LineStall, flow: LineFlow): QueueHealthFailure {
  const oldest = flow.oldestWaiting?.branch
  return {
    code: STALLED_LINE_CODE,
    cause: stall.cause,
    resolution: [
      stall.shape === "cas-refused"
        ? `Read the refused publication rows in the last round journals for ${flow.casRefused?.ref ?? "the change"}; repair persistent ref contention, then let the queue retry.`
        : stall.shape === "slow-round"
          ? "A round is running: read its journal (yrd queue list shows the RUNNER line and the round's log) to see which check it is in and whether that check is making progress."
          : "No round is judging anything: read the last round's journal and the service's own log for why rounds complete without taking a change.",
      ...(oldest === undefined
        ? []
        : [`The oldest waiting change, its records and its log: yrd queue show ${oldest}.`]),
      "The service is alive and heartbeating: no restart is needed to read this, and a restart alone does not cure a line that judges nothing.",
      stall.shape === "cas-refused"
        ? "This page clears when this change publishes successfully."
        : "This page clears on the next judgement — a change merged, failed or recorded stuck — and never by itself.",
    ],
  }
}

/** A duration as a page says it: `47m`, `1h27m`. */
function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${String(minutes)}m`
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`
}

/** The stuck record's own code, as `queue list` and `queue show` render it. */
export const STUCK_RECORD_CODE = "yrd-round-stuck"

/**
 * The document a reader should act on: the stored one, or an OVERDUE verdict
 * when its writer stopped writing.
 *
 * Overdue outranks whatever the document last said, including `healthy`, and
 * that ordering is the point: past `staleAfter` the interesting fact is not
 * what the last write said, it is that nothing has been written since. The
 * writer restates its document on a heartbeat through long rounds, idle sleeps
 * and stopped lines alike, so a round's length never makes a document overdue;
 * only a writer that is gone, or whose event loop is held, does. A stale
 * `healthy` is the confident lie; a stale `unhealthy` is at least alarming for
 * the wrong reason, and both are cured by the same sentence.
 *
 * A document with no `staleAfter` at all is one a pre-2026-09-11 loop wrote. It
 * is passed through unchanged rather than declared overdue: absence of a
 * deadline is not evidence that one passed.
 */
export function believableHealthDocument(document: QueueHealthDocument, now: Date): QueueHealthDocument {
  const staleAfter = document.facts?.staleAfter
  const writtenAt = document.facts?.writtenAt
  if (typeof staleAfter !== "string") return document
  const deadline = Date.parse(staleAfter)
  if (Number.isNaN(deadline) || now.getTime() <= deadline) return document
  return {
    schema: QUEUE_HEALTH_SCHEMA,
    service: document.service,
    state: "unhealthy",
    verdict: { kind: "running" },
    error: {
      code: "queue-round-overdue",
      cause:
        `the service last wrote this document at ${typeof writtenAt === "string" ? writtenAt : "an unrecorded instant"} ` +
        `and declared it believable until ${staleAfter}; nothing has been written since, ` +
        `so its last verdict (${document.state}) is no longer a measurement of anything`,
      resolution: [
        "The service restates this document on a heartbeat, through long rounds, idle sleeps and a stopped line alike, so overdue means its writer stopped writing: the process is gone, or its event loop is held.",
        "facts.runner names that writer when the document carries one: if the process is gone, start the service again; if it is still running, it is alive and not writing, so inspect it before stopping it.",
        "A hand `yrd queue run` does not write this document, so it cannot clear this page; the page clears the moment the service writes again.",
      ],
    },
    facts: { ...document.facts, overdueBy: now.getTime() - deadline },
  }
}

/**
 * The answer when no document exists.
 *
 * `absent` + `stopped`, never `unhealthy`: nothing has claimed this service,
 * which is a different fact from a loop that is running and failing, and the
 * supervisor pages only on the second. Saying `unhealthy` here would page for
 * a service nobody started.
 */
/**
 * The document for a relaunch that is waiting on a checkout which has not come.
 *
 * ITS OWN BUILDER, NOT A BRANCH OF {@link roundHealthDocument}, and that is the
 * whole point (@cto, @i/10-yrd/24515). A stall is not a stuck round, and reusing
 * the stuck branch shipped three resolution lines that are FALSE here: there is
 * no round to read with `yrd queue list`, no next round runs until the checkout
 * lands, and the interval quoted is the alarm's, not a round's. A page that
 * contradicts its own cause is read by someone acting on it at 3am — operators
 * following resolution lines is exactly what cost us the evening of
 * 2026-09-11.
 *
 * `running` is TRUE and load-bearing: this process is alive and still waiting,
 * which is what makes this a page rather than a tombstone, and what lets the
 * supervisor's restart loop respawn later without meeting the admission gate
 * that refuses unhealthy+running.
 *
 * `facts` carries the caller's latest ANNOUNCED observation of the wait, not a
 * frozen copy from its first instant: the three values move while the checkout
 * catches up, and a page describing a moment that has passed sends a reader to
 * the wrong place. The overdue answer is built by merging `facts`, so dropping
 * them here would delete the only thing that makes a later overdue page explain
 * itself at all.
 *
 * `stop` is the last stop the loop knew, read at its start or at its latest
 * round's end, and it is stated like every other document states it: the fact is
 * always present, so its absence can never be read as a running line (24523 F3).
 */
export function relaunchStalledHealthDocument(
  service: string,
  awaited: Readonly<{ path: string; sha: string; checkout: string }>,
  why: string,
  waiting: Readonly<Record<string, unknown>>,
  stalls: number,
  nextAlarmInMs: number,
  now: Date,
  stop?: PauseRecord,
): QueueHealthDocument {
  return {
    schema: QUEUE_HEALTH_SCHEMA,
    service,
    state: "unhealthy",
    verdict: { kind: "running" },
    error: {
      code: "queue-relaunch-stalled",
      // The `why` alone: NO `yrd-round-stuck:` prefix, because this is not a
      // round and a reader who greps that code would be led to the wrong page.
      cause: why,
      // FOUR LINES, EACH OF THEM TRUE. The last one is the one that is easy to
      // get subtly wrong, and @cto caught me getting it wrong: the page does
      // NOT clear when the checkout lands. The process exits 0 then, and this
      // document stays on disk until the RELAUNCHED service writes over it,
      // which it does at its start, before its first round (24523 F1).
      resolution: [
        `Check out ${awaited.path}@${awaited.sha} in ${awaited.checkout}.`,
        "No restart, and nothing to delete: this process relaunches itself with exit 0 the moment that checkout lands.",
        "No queue round runs until then.",
        "This page clears when the relaunched service starts and writes its own document.",
      ],
    },
    // No `nextRoundInMs`: there is no next round to promise. `nextAlarmInMs` is
    // the interval this page is re-announced on, an alarm and a different claim
    // from the heartbeat that keeps it fresh.
    facts: {
      ...waiting,
      ...freshness(SERVICE_HEARTBEAT, now),
      reasonKey: `relaunch-wait:${awaited.path}`,
      stalledAlarms: stalls,
      nextAlarmInMs,
      stopped: stopFact(stop),
    },
  }
}

/**
 * Who stopped or started the service and why, as the supervisor's intent file
 * said at that moment (25430). `by` and `reason` are absent when no intent for
 * that verb was recorded: the document then says so, and never invents one.
 */
export type ServiceIntentFact = Readonly<{ since: string; by?: string; reason?: string }>

/**
 * The operator-facing line for a graceful stop, from its own fact, in the
 * watch's two words (@cto 3ced1b26): "stopped by <seat> since <time>: <reason>"
 * beside the line's "paused by <seat> since <time>: <reason>". "Stopped" alone
 * says the process is off; `at` is the time as the caller renders it.
 */
export function serviceStoppedLine(stopped: ServiceIntentFact, at: string = stopped.since): string {
  return stopped.by !== undefined && stopped.reason !== undefined
    ? `stopped by ${stopped.by} since ${at}: ${stopped.reason}`
    : `stopped since ${at}: no stop reason was recorded`
}

/**
 * The LAST document a gracefully stopping service writes (25430).
 *
 * `absent` + `stopped`, like {@link absentHealthDocument} and for the same
 * contract reason: nothing is running, which pages nobody and is what the
 * supervisor's start gate expects before a start. NO deadline either, because
 * nothing will restate it: a stopped service's document must never age into an
 * overdue page. `serviceStopped` (not `stopped`, which is the LINE's stop) is
 * who stopped the service and why, read from the supervisor's intent file.
 */
export function gracefulStopHealthDocument(
  service: string,
  serviceStopped: ServiceIntentFact,
  stop?: PauseRecord,
): QueueHealthDocument {
  return {
    schema: QUEUE_HEALTH_SCHEMA,
    service,
    state: "absent",
    verdict: { kind: "stopped" },
    facts: {
      why: serviceStoppedLine(serviceStopped),
      serviceStopped,
      stopped: stopFact(stop),
      resolution: ["Start the service when the reason above no longer holds; its first document replaces this one."],
    },
  }
}

export function absentHealthDocument(service: string, why: string): QueueHealthDocument {
  return {
    schema: QUEUE_HEALTH_SCHEMA,
    service,
    state: "absent",
    verdict: { kind: "stopped" },
    // NO `error`, and that is the CONTRACT rather than a style choice. The
    // supervisor's parser requires a typed error on `unhealthy`, allows one on
    // `unknown`, and REFUSES the whole document if `healthy` or `absent` carries
    // one — "absent probe unexpectedly carried an error". This carried one, so
    // hab read the document as unparsed and paged health-not-measured: an alarm
    // about the alarm, on a service that was simply not running yet. Measured in
    // production 2026-09-11 14:25:51Z, the first thing the live probe did.
    //
    // The explanation is not lost, only moved: `facts` is free-form and is
    // carried through by the same parser.
    facts: {
      why,
      resolution: [
        "Start the service — `yrd queue up` writes this document as it starts, before its first round, and restates it on a heartbeat while it runs.",
        "A service still reading its queue's declaration and stop has not written one yet; one that runs past that and leaves none could not write here, and its log names why.",
      ],
    },
  }
}

/**
 * The answer when a document exists and cannot be read.
 *
 * Loud and typed rather than absent: a file that is there and unparseable is
 * evidence of a defect, and reporting it as `absent` would file that defect
 * under "nobody started the service" where nobody would look for it.
 */
export function unreadableHealthDocument(service: string, why: string, observed: string | null): QueueHealthDocument {
  return {
    schema: QUEUE_HEALTH_SCHEMA,
    service,
    state: "unknown",
    verdict: { kind: "unknown", reason: "unparsed", observed },
    error: {
      code: "queue-health-document-unreadable",
      cause: why,
      resolution: [
        "The service writes the document whole, staged and renamed into place; a partial one is a defect, not a state.",
        "The service's next write replaces it, within one heartbeat while the service runs.",
      ],
    },
  }
}

/**
 * A stored document, validated, or `undefined` when the text is not one.
 *
 * Validation is deliberately shallow-but-real: the schema tag and a known
 * state. It exists so a caller can tell "this is a health document" from "this
 * is some other JSON", which is the distinction that decides between reporting
 * a state and reporting that the file is broken.
 */
export function parseQueueHealthDocument(text: string): QueueHealthDocument | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // silent-fallback-allow: the caller turns undefined into a typed unreadable document naming the text
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.schema !== QUEUE_HEALTH_SCHEMA) return undefined
  const state = record.state
  if (state !== "healthy" && state !== "absent" && state !== "unhealthy" && state !== "unknown") return undefined
  return record as unknown as QueueHealthDocument
}
