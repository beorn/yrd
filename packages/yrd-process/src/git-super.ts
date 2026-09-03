import type { GitProcess, GitProcessResult } from "git-super/process"
import type { Process } from "./index.ts"

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
      const env = gitEnvironment(defaults.env ?? globalThis.process.env, request.env)
      const result = await process.run({
        argv: ["git", "-C", request.repo, ...request.args],
        cwd: request.repo,
        env,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...((request.signal ?? defaults.signal) === undefined ? {} : { signal: request.signal ?? defaults.signal }),
        ...((request.timeoutMs ?? defaults.timeoutMs) === undefined
          ? {}
          : { timeoutMs: request.timeoutMs ?? defaults.timeoutMs }),
      })
      return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal,
        timedOut: result.timedOut,
        ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
        ...((result.verdict !== undefined && result.verdict !== "EXITED") || result.sweepFailure !== undefined
          ? { failure: result.sweepFailure ?? `process verdict ${result.verdict}` }
          : {}),
      }
    },
  }
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
