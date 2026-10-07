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

function noteAttempt(attempt: TransientPushAttempt): void {
  const request = attempt.requestId ?? "none"
  process.stderr.write(
    `yrd: transient 5xx push attempt ${String(attempt.attempt)}/${String(attempt.attempts)} repository=${attempt.repository} ref=${attempt.ref} request-id=${request} ${attempt.line}\n`,
  )
}

/**
 * Run `work` up to three times when its throw or result text matches a 5xx.
 * Unrecognized failures propagate on the first attempt.
 */
export async function retryTransientPush<T>(
  work: () => Promise<T>,
  options: Readonly<{
    repository: string
    ref: string
    text?: (result: T) => string
    note?: (attempt: TransientPushAttempt) => void
  }>,
): Promise<T> {
  const attempts = transientPushRetry.attempts
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await work()
      const hit = matchTransientPush5xx(options.text?.(result) ?? "")
      if (hit === undefined) return result
      const record = { ...hit, attempt, attempts, repository: options.repository, ref: options.ref }
      noteAttempt(record)
      options.note?.(record)
      if (attempt === attempts) return result
    } catch (error) {
      const hit = matchTransientPush5xx(errorText(error))
      if (hit === undefined) throw error
      const record = { ...hit, attempt, attempts, repository: options.repository, ref: options.ref }
      noteAttempt(record)
      options.note?.(record)
      if (attempt === attempts) throw error
    }
    const wait = transientPushRetry.backoffMs[attempt]
    if (wait !== undefined) await transientPushRetry.sleep(wait)
  }
  throw new Error("transient 5xx retry fell through")
}
