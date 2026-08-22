import { basename } from "node:path"
import type { Process, ProcessRequest, ProcessResult } from "./index.ts"

/** Two backoffs → three attempts. N=90 git calls at 20–40% per-call stall is
 * overdetermined failure (1e-14 at 70%); a few timeout retries target ~99.9%
 * per-call. Timeouts only — non-timeout failures stay one-shot. Bound is
 * unchanged (lock-hold is a separate control). */
const DEFAULT_GIT_TIMEOUT_RETRY_DELAYS_MS = Object.freeze([200, 200] as const)
const DEFAULT_CONSECUTIVE_TIMEOUT_LIMIT = 3
const DEFAULT_BREAKER_WINDOW_MS = 60_000

type BreakerState = {
  consecutiveTimeouts: number
  openedAtMs: number | undefined
}

type RetryOptions = Readonly<{
  delaysMs?: readonly number[]
  sleep?: (delayMs: number) => Promise<void>
  consecutiveTimeoutLimit?: number
  breakerWindowMs?: number
  now?: () => number
  announce?: (message: string) => void
  breaker?: BreakerState
}>

function isGitRequest(request: ProcessRequest): boolean {
  const executable = request.argv[0]
  return executable !== undefined && basename(executable) === "git"
}

function breakerOpenMessage(limit: number): string {
  return `git-timeout-retry: circuit breaker open after ${String(limit)} consecutive timeouts; failing through`
}

function failThrough(limit: number): ProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: breakerOpenMessage(limit),
    durationMs: 0,
    timedOut: true,
    verdict: "TIMED_OUT",
  }
}

function breakerIsOpen(state: BreakerState, nowMs: number, windowMs: number): boolean {
  if (state.openedAtMs === undefined) return false
  if (nowMs - state.openedAtMs >= windowMs) {
    state.openedAtMs = undefined
    state.consecutiveTimeouts = 0
    return false
  }
  return true
}

function recordInnerResult(
  state: BreakerState,
  timedOut: boolean,
  nowMs: number,
  limit: number,
  announce: (message: string) => void,
): boolean {
  if (!timedOut) {
    state.consecutiveTimeouts = 0
    state.openedAtMs = undefined
    return false
  }
  state.consecutiveTimeouts += 1
  if (state.consecutiveTimeouts < limit) return false
  state.openedAtMs = nowMs
  announce(breakerOpenMessage(limit))
  return true
}

async function runWithGitTimeoutRetry(
  process: Pick<Process, "run">,
  request: ProcessRequest,
  options: RetryOptions = {},
): Promise<ProcessResult> {
  if (!isGitRequest(request) || request.interactive === true) return process.run(request)
  const delaysMs = options.delaysMs ?? DEFAULT_GIT_TIMEOUT_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((delayMs: number) => Bun.sleep(delayMs))
  const limit = options.consecutiveTimeoutLimit ?? DEFAULT_CONSECUTIVE_TIMEOUT_LIMIT
  const windowMs = options.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS
  const now = options.now ?? Date.now
  const announce =
    options.announce ?? ((message: string) => void globalThis.process.stderr.write(`${message}\n`))
  const state = options.breaker ?? { consecutiveTimeouts: 0, openedAtMs: undefined }

  if (breakerIsOpen(state, now(), windowMs)) return failThrough(limit)

  let result = await process.run(request)
  if (recordInnerResult(state, result.timedOut === true, now(), limit, announce)) return result
  for (const delayMs of delaysMs) {
    if (result.timedOut !== true) return result
    await sleep(delayMs)
    result = await process.run(request)
    if (recordInnerResult(state, result.timedOut === true, now(), limit, announce)) return result
  }
  return result
}

/** Retry timed-out git children only. Queue createGit and CLI composition
 * share this so N=90 drain calls and worker `pr submit` probes use one policy.
 * A consecutive-timeout breaker stops connecting into a blocked host: one
 * timeout is a stall, three in a row is a block — fail through for a window. */
export function withGitTimeoutRetry<T extends Pick<Process, "run">>(process: T, options: RetryOptions = {}): T {
  const breaker: BreakerState = { consecutiveTimeouts: 0, openedAtMs: undefined }
  return {
    ...process,
    run: (request: ProcessRequest) => runWithGitTimeoutRetry(process, request, { ...options, breaker }),
  }
}

export { runWithGitTimeoutRetry }
