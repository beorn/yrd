import { basename } from "node:path"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"

/** A 1.55s bounded window covers ordinary concurrent Git writers without hiding a stuck lock. */
const DEFAULT_GIT_INDEX_LOCK_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800] as const)

type RetryOptions = Readonly<{
  delaysMs?: readonly number[]
  sleep?: (delayMs: number) => Promise<void>
}>

const IndexLockContention = /Unable to create ['"][^\r\n]*[\\/]index\.lock['"]?: File exists\./u

function isGitRequest(request: ProcessRequest): boolean {
  const executable = request.argv[0]
  return executable !== undefined && basename(executable) === "git"
}

function isRetryableIndexLockContention(result: ProcessResult): boolean {
  return (
    result.exitCode !== 0 &&
    !result.timedOut &&
    result.signal === null &&
    result.stalled !== true &&
    result.sweepFailure === undefined &&
    IndexLockContention.test(result.stderr)
  )
}

function withExhaustionGuidance(result: ProcessResult, attempts: number): ProcessResult {
  const guidance =
    `Yrd tried the Git operation ${attempts} times and the index lock still exists. ` +
    `Wait for the active Git writer, then retry. Inspect ownership and age before treating it as orphaned. ` +
    `Never delete a live lock.`
  return { ...result, stderr: `${result.stderr.trimEnd()}\n${guidance}\n` }
}

/**
 * Retry only Git's exact pre-mutation `index.lock: File exists` refusal.
 *
 * Git acquires the index lock with O_EXCL before changing the index, so this
 * one failure is safe to retry. Other failures, shell-wrapped commands,
 * timeouts, signals, and sweep failures pass through after one attempt. The
 * final failure stays loud and names the safe next action; this helper never
 * removes a lock itself.
 */
export async function runWithGitIndexLockRetry(
  process: Pick<Process, "run">,
  request: ProcessRequest,
  options: RetryOptions = {},
): Promise<ProcessResult> {
  if (!isGitRequest(request)) return process.run(request)

  const delaysMs = options.delaysMs ?? DEFAULT_GIT_INDEX_LOCK_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((delayMs: number) => Bun.sleep(delayMs))
  for (let attempt = 0; ; attempt += 1) {
    const result = await process.run(request)
    if (!isRetryableIndexLockContention(result)) return result
    const delayMs = delaysMs[attempt]
    if (delayMs === undefined) return withExhaustionGuidance(result, attempt + 1)
    await sleep(delayMs)
  }
}

/** Install the retry policy once at the Yrd CLI composition root. */
export function withGitIndexLockRetry(process: Process): Process {
  return Object.freeze({
    run: (request: ProcessRequest) => runWithGitIndexLockRetry(process, request),
    close: () => process.close(),
    [Symbol.asyncDispose]: () => process[Symbol.asyncDispose](),
  })
}
