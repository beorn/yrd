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
 * How long past its own next-round instant a document is still believed.
 *
 * THE DEFECT THIS EXISTS FOR (@cto, 2026-09-11): a document with no expiry is
 * an instrument that asserts a verdict it did not measure. If a round hangs
 * inside the run, the loop never writes again and the probe keeps printing the
 * last round's `healthy` for as long as the hang lasts — the longer the outage,
 * the more confident the lie. That is the silent-fallback shape with a clock
 * attached, and it is worse than having no probe, because a page that never
 * opens reads exactly like a service that is fine.
 *
 * Ten minutes, and the number is MEASURED rather than borrowed. @cto read all
 * 189 queue journals since 2026-09-10 and timed each round from its first event
 * to its last: median 3 s, p90 262 s, p95 346 s, p99 388 s, max 489 s — 8.2
 * minutes, run q-20260911T075823542Z-25b8774a. Fourteen rounds passed five
 * minutes, one passed eight, none passed ten.
 *
 * SO THE MARGIN IS ABOUT 1.8 MINUTES ABOVE THE WORST ROUND EVER OBSERVED, and
 * that is written here so the next reader sees how thin it is instead of
 * rediscovering it. What an overrun costs is a PAGE, not delivery: the round
 * that finally finishes writes healthy and the supervisor drops the page by
 * itself.
 *
 * BATCHING MOVES THIS NUMBER (@i/10-yrd/24227, M10). One round will check N
 * changes by design, so rounds get longer and ten minutes stops being a
 * measurement of anything. When batching lands, derive the budget from the
 * round's OWN declared check limits rather than from a constant — then a round
 * cannot legitimately outlive its deadline, and the reader still only reads the
 * loop's word.
 *
 * The number also happens to be the fleet's own ceiling — a request older than
 * ten minutes is broken, not slow — which is why it reads naturally, but the
 * measurement above is the reason to keep it. It is a BUDGET ON TOP of the
 * sleep the loop actually chose, so a deliberately long interval does not read
 * as overdue — staleness is measured against the loop's own declared intent,
 * never against a fixed cadence a reader assumed.
 */
export const ROUND_BUDGET_MS = 10 * 60 * 1000

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
 * The document the loop writes at the end of every round.
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
): QueueHealthDocument {
  const base = { schema: QUEUE_HEALTH_SCHEMA, service, verdict: { kind: "running" } as const }
  // WHEN THIS STOPS BEING BELIEVABLE, written by the loop rather than computed
  // by a reader. The loop is the only party that knows what sleep it chose, so
  // a reader re-deriving the deadline would be a second opinion about the one
  // thing the loop is authoritative on.
  const facts = {
    writtenAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + sleepMs + ROUND_BUDGET_MS).toISOString(),
    nextRoundInMs: sleepMs,
    stopped: stopFact(stop),
  }
  if (stop?.cause !== "stuck" || stop.change === undefined) return { ...base, state: "healthy", facts }
  const change = changeName(stop.change)
  return {
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
  }
}

/** The stuck record's own code, as `queue list` and `queue show` render it. */
export const STUCK_RECORD_CODE = "yrd-round-stuck"

/**
 * The document a reader should act on: the stored one, or an OVERDUE verdict
 * when the loop stopped writing.
 *
 * Overdue outranks whatever the document last said, including `healthy`, and
 * that ordering is the point: past `staleAfter` the interesting fact is not
 * what the last round found, it is that no round has finished since. A stale
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
        `no round has finished since ${typeof writtenAt === "string" ? writtenAt : "an unrecorded instant"}; ` +
        `the loop declared its next round due by ${staleAfter} and has written nothing since, ` +
        `so its last verdict (${document.state}) is no longer a measurement of anything`,
      resolution: [
        "A round is hung or the loop is gone; the document cannot tell which apart, and says so rather than guessing.",
        "Read the newest run journal to see where the round stopped.",
        "This clears by itself the moment any round finishes and writes again.",
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
 */
export function relaunchStalledHealthDocument(
  service: string,
  awaited: Readonly<{ path: string; sha: string; checkout: string }>,
  why: string,
  waiting: Readonly<Record<string, unknown>>,
  stalls: number,
  nextAlarmInMs: number,
  now: Date,
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
      // document stays on disk until the RELAUNCHED service finishes its first
      // round and writes over it.
      resolution: [
        `Check out ${awaited.path}@${awaited.sha} in ${awaited.checkout}.`,
        "No restart, and nothing to delete: this process relaunches itself with exit 0 the moment that checkout lands.",
        "No queue round runs until then.",
        "This page clears after the relaunched service finishes its first round.",
      ],
    },
    // No `nextRoundInMs`: there is no next round to promise. `nextAlarmInMs` is
    // the interval this document is re-written on, which is a different claim.
    facts: {
      ...waiting,
      writtenAt: now.toISOString(),
      staleAfter: new Date(now.getTime() + nextAlarmInMs + ROUND_BUDGET_MS).toISOString(),
      reasonKey: `relaunch-wait:${awaited.path}`,
      stalledAlarms: stalls,
      nextAlarmInMs,
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
        "Start the service — `yrd queue up` writes this document at the end of every round.",
        "A service that IS running and has not finished its first round has not written one yet.",
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
        "The document is written whole by the service at the end of each round; a partial one is a defect, not a state.",
        "The next completed round overwrites it.",
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
