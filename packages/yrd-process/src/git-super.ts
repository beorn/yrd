import type { GitProcess, GitProcessResult } from "git-super/process"
import type { OutputTruncation, Process } from "./index.ts"

export type GitProcessDefaults = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

/** Remove caller-owned Git routing variables before selecting a repository.
 * Git honors these variables ahead of `-C`, so every CLI Git boundary shares
 * this scrubber rather than allowing ambient hook state to change authority. */
export function cleanGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  )
}

function gitEnvironment(source: NodeJS.ProcessEnv, overlay: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnvironment(source),
    ...overlay,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    TZ: "UTC",
  }
}

/** Yrd's only adapter from its supervised process port to git-super's Git port. */
export function adaptProcessGit(process: Pick<Process, "run">, defaults: GitProcessDefaults = {}): GitProcess {
  return {
    async run(request) {
      const argv = ["git", "-C", request.repo, ...request.args]
      const env = gitEnvironment(defaults.env ?? globalThis.process.env, request.env)
      const result = await process.run({
        argv,
        cwd: request.repo,
        env,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...((request.signal ?? defaults.signal) === undefined ? {} : { signal: request.signal ?? defaults.signal }),
        ...((request.timeoutMs ?? defaults.timeoutMs) === undefined
          ? {}
          : { timeoutMs: request.timeoutMs ?? defaults.timeoutMs }),
      })
      const truncation = truncationFailure(argv, result.outputTruncation ?? [])
      const settlement =
        (result.verdict !== undefined && result.verdict !== "EXITED") || result.sweepFailure !== undefined
          ? (result.sweepFailure ?? `process verdict ${result.verdict}`)
          : undefined
      const failure = [truncation, settlement].filter((entry): entry is string => entry !== undefined).join("; ")
      return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal,
        timedOut: result.timedOut,
        ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
        ...(failure === "" ? {} : { failure }),
      }
    },
  }
}

/**
 * Past `maxOutputBytes` the capture keeps a head and a tail, drops the middle, lets the child exit 0, and
 * names the loss only in this field and a WARN line — so a consumer that parses stdout reads a hole as a
 * complete answer (the one oversized file that bounces the queue, 24650/24669). Reported as `failure`,
 * the field every consumer already refuses, and named with the command and the exact limit it ran past.
 */
function truncationFailure(argv: readonly string[], truncations: readonly OutputTruncation[]): string | undefined {
  if (truncations.length === 0) return undefined
  const losses = truncations
    .map(
      ({ stream, droppedBytes, totalBytes, limitBytes }) =>
        `${stream}: ${String(droppedBytes)} of ${String(totalBytes)} bytes dropped past the ${String(limitBytes)}-byte capture limit`,
    )
    .join("; ")
  return `${argv.join(" ")}: capture truncated (${losses}), so the middle of the output is gone and this read is not complete`
}

/** One human-readable line for a failed `adaptProcessGit` call: the process-level
 * failure if there is one (a crash, a signal, a sweep that could not certify
 * teardown), else the timeout, else Git's own stderr/stdout, else the bare exit
 * code. `timeoutMs` only labels a timeout that already happened — it does not
 * configure one. */
export function gitFailure(result: GitProcessResult, timeoutMs: number): string {
  if (result.timedOut === true) return `timed out after ${String(timeoutMs)}ms`
  return result.failure ?? (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`)
}
