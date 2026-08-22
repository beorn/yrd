import { basename } from "node:path"
import type { Process, ProcessRequest, ProcessResult } from "./index.ts"

/** Two backoffs → three attempts. N=90 git calls at 20–40% per-call stall is
 * overdetermined failure (1e-14 at 70%); a few timeout retries target ~99.9%
 * per-call. Timeouts only — non-timeout failures stay one-shot. Bound is
 * unchanged (lock-hold is a separate control). */
const DEFAULT_GIT_TIMEOUT_RETRY_DELAYS_MS = Object.freeze([200, 200] as const)

type RetryOptions = Readonly<{
  delaysMs?: readonly number[]
  sleep?: (delayMs: number) => Promise<void>
}>

function isGitRequest(request: ProcessRequest): boolean {
  const executable = request.argv[0]
  return executable !== undefined && basename(executable) === "git"
}

async function runWithGitTimeoutRetry(
  process: Pick<Process, "run">,
  request: ProcessRequest,
  options: RetryOptions = {},
): Promise<ProcessResult> {
  if (!isGitRequest(request) || request.interactive === true) return process.run(request)
  const delaysMs = options.delaysMs ?? DEFAULT_GIT_TIMEOUT_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((delayMs: number) => Bun.sleep(delayMs))
  let result = await process.run(request)
  for (const delayMs of delaysMs) {
    if (result.timedOut !== true) return result
    await sleep(delayMs)
    result = await process.run(request)
  }
  return result
}

/** Retry timed-out git children only. Queue createGit and CLI composition
 * share this so N=90 drain calls and worker `pr submit` probes use one policy. */
export function withGitTimeoutRetry<T extends Pick<Process, "run">>(process: T, options: RetryOptions = {}): T {
  return {
    ...process,
    run: (request: ProcessRequest) => runWithGitTimeoutRetry(process, request, options),
  }
}

export { runWithGitTimeoutRetry }
