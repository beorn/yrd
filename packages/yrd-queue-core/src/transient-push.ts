/**
 * Narrow GitHub 5xx recognition for yrd publish retries (27995).
 *
 * Git gives no structured HTTP status. Only the explicit shapes in git's
 * stderr count as transient: `returned error: 50x` and `Internal Server Error`.
 * Anything else stays a non-transient refusal (24395 item 4).
 */

import { setTimeout as delay } from "node:timers/promises"

const MAX_LINE = 300
const RETURNED_5XX = /returned error:\s*50\d\b/iu
const INTERNAL_SERVER_ERROR = /Internal Server Error/u
const REQUEST_ID = /\bRequest ID:\s*([0-9A-Fa-f:]+)/u

export type TransientPush5xx = Readonly<{
  line: string
  requestId?: string
}>

export type TransientPushAttempt = TransientPush5xx &
  Readonly<{
    attempt: number
    attempts: number
    repository: string
    ref: string
  }>

/** 3 attempts in about 2 minutes: immediate, then 40s, then 80s. */
export const transientPushRetry = {
  attempts: 3,
  backoffMs: [0, 40_000, 80_000] as const,
  sleep: async (ms: number): Promise<void> => {
    if (ms > 0) await delay(ms)
  },
}

function requestIdIn(text: string): string | undefined {
  return REQUEST_ID.exec(text)?.[1]
}

/** Phrase written on a 5xx hold so a later round can probe after Reason: truncation. */
export const TRANSIENT_PUSH_HOLD = "transient GitHub 5xx"

/** The first 5xx shape in `text`, or undefined when the failure is not transient. */
export function matchTransientPush5xx(text: string): TransientPush5xx | undefined {
  const requestId = requestIdIn(text)
  for (const raw of text.split("\n")) {
    const returned = RETURNED_5XX.exec(raw)
    const internal = INTERNAL_SERVER_ERROR.exec(raw)
    const match = returned ?? internal
    if (match === null || match.index === undefined) continue
    return {
      line: raw.slice(match.index, match.index + MAX_LINE).trim(),
      ...(requestId === undefined ? {} : { requestId }),
    }
  }
  return undefined
}

/** A standing stuck change this code wrote; other 5xx-quoting stucks keep a manual resume. */
export function isTransientPushHold(reason: string | undefined): boolean {
  if (reason === undefined || reason === "") return false
  return reason.includes(TRANSIENT_PUSH_HOLD)
}

function errorText(error: unknown): string {
  if (error === undefined || error === null) return ""
  if (typeof error !== "object") return String(error)
  const parts: string[] = []
  if (error instanceof Error) parts.push(error.message)
  if ("detail" in error && typeof error.detail === "string") parts.push(error.detail)
  if ("reasons" in error && Array.isArray(error.reasons)) {
    for (const reason of error.reasons) {
      if (typeof reason === "string") parts.push(reason)
    }
  }
  if ("cause" in error) parts.push(errorText(error.cause))
  return parts.join("\n")
}

/**
 * The transient 5xx this error reports, or undefined when it is another failure
 * (24395 item 4). A caller uses it to tell an exhausted retry of a 5xx from every
 * other refusal, so a persistent remote error becomes a hold, never a stopped line.
 */
export function transientPush5xxOf(error: unknown): TransientPush5xx | undefined {
  return matchTransientPush5xx(errorText(error))
}

function noteAttempt(attempt: TransientPushAttempt): void {
  const request = attempt.requestId ?? "none"
  process.stderr.write(
    `yrd: transient 5xx push attempt ${String(attempt.attempt)}/${String(attempt.attempts)} repository=${attempt.repository} ref=${attempt.ref} request-id=${request} ${attempt.line}\n`,
  )
}

/**
 * Run `work` up to three times when its throw or result text matches a 5xx.
 * Unrecognized failures propagate on the first attempt.
 *
 * `landed` is the ambiguous-5xx probe (@cto, 28793): a 500 can arrive AFTER
 * GitHub applied the push, so this retry asks the remote whether the write
 * landed before it re-runs `work` — after the backoff wait, and before it gives
 * up on the last attempt. When the probe returns the staged write the attempt is
 * a success and `work` is NEVER re-run: a blind re-run would either fail the
 * lease (and stop the line) or append a second event.
 *
 * A probe that FAILS is itself unknown (@cto): an unanswered probe cannot say
 * whether the push landed, so `work` is not re-run either. The failure is
 * recorded in the attempt note and the original 5xx is settled at once, which
 * both callers turn into a HOLD.
 */
export async function retryTransientPush<T>(
  work: () => Promise<T>,
  options: Readonly<{
    repository: string
    ref: string
    text?: (result: T) => string
    note?: (attempt: TransientPushAttempt, probeError?: string) => void
    landed?: (hit: TransientPush5xx) => Promise<T | undefined>
  }>,
): Promise<T> {
  const attempts = transientPushRetry.attempts
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let hit: TransientPush5xx
    let settled: { readonly kind: "result"; readonly value: T } | { readonly kind: "throw"; readonly error: unknown }
    try {
      const value = await work()
      const matched = matchTransientPush5xx(options.text?.(value) ?? "")
      if (matched === undefined) return value
      hit = matched
      settled = { kind: "result", value }
    } catch (error) {
      const matched = matchTransientPush5xx(errorText(error))
      if (matched === undefined) throw error
      hit = matched
      settled = { kind: "throw", error }
    }
    const record = { ...hit, attempt, attempts, repository: options.repository, ref: options.ref }
    const last = attempt === attempts
    if (!last) {
      const wait = transientPushRetry.backoffMs[attempt]
      if (wait !== undefined) await transientPushRetry.sleep(wait)
    }
    let landed: T | undefined
    let probeError: string | undefined
    if (options.landed !== undefined) {
      try {
        landed = await options.landed(hit)
      } catch (error) {
        probeError = errorText(error) || `${error instanceof Error ? error.name : "the landed probe failed"}`
        const request = hit.requestId === undefined ? "" : ` request-id=${hit.requestId}`
        process.stderr.write(
          `yrd: landed probe failed after a transient 5xx on ${options.ref} (attempt ${String(attempt)}/${String(attempts)}${request}): ${probeError}\n`,
        )
      }
    }
    noteAttempt(record)
    options.note?.(record, probeError)
    if (landed !== undefined) return landed
    // Not landed, or the probe could not answer: settle with the original 5xx
    // rather than re-run a push we cannot prove did not land.
    if (probeError !== undefined || last) {
      if (settled.kind === "throw") throw settled.error
      return settled.value
    }
  }
  throw new Error("transient 5xx retry fell through")
}

/**
 * One funnel for a queue publication that can take a GitHub 5xx (28805).
 *
 * `work` runs the publish and is handed a `prepared` callback it MUST call with
 * the value that a success returns — the staged commit it is about to publish.
 * The funnel runs `work` under `retryTransientPush`; on a 5xx it asks `landed`
 * whether that staged value is already live on the remote, and returns it as the
 * success value when it is, so the write is never re-run blind (28793).
 *
 * Exhaustion is the CALLER's decision: this returns the original 5xx unchanged,
 * and the caller maps it — a runner HOLD (28793) or a loud CLI failure. A
 * `landed` probe that itself throws gives up on the original 5xx and never
 * re-runs `work` (28793 round 2), inherited here for every site.
 */
export async function publishWithTransientRetry<T>(
  work: (prepared: (staged: T) => void) => Promise<T>,
  options: Readonly<{
    repository: string
    ref: string
    text?: (result: T) => string
    note?: (attempt: TransientPushAttempt, probeError?: string) => void
    landed?: (staged: T, hit: TransientPush5xx) => Promise<T | undefined>
  }>,
): Promise<T> {
  let staged: T | undefined
  const probe = options.landed
  return retryTransientPush(
    () => {
      staged = undefined
      return work((value) => {
        staged = value
      })
    },
    {
      repository: options.repository,
      ref: options.ref,
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.note === undefined ? {} : { note: options.note }),
      ...(probe === undefined
        ? {}
        : {
            landed: async (hit: TransientPush5xx): Promise<T | undefined> => {
              if (staged === undefined) return undefined
              return probe(staged, hit)
            },
          }),
    },
  )
}
