import type { Process } from "@yrd/process"
import type { GitProcess } from "git-super/process"
import type { GitResultDetail, GitSuperResult } from "git-super/result"

export type GitProcessDefaults = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

function cleanGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  )
}

/** Yrd's only adapter from its supervised process port to git-super's Git port. */
export function adaptProcessGit(process: Pick<Process, "run">, defaults: GitProcessDefaults = {}): GitProcess {
  return {
    async run(request) {
      const env = {
        ...cleanGitEnvironment(defaults.env ?? globalThis.process.env),
        ...request.env,
      }
      const result = await process.run({
        argv: ["git", "-C", request.repo, ...request.args],
        cwd: request.repo,
        env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" },
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

/** Select the first structured failure for Yrd's domain-specific result mapping. */
export function gitSuperFailureDetail(result: GitSuperResult): GitResultDetail | undefined {
  return (
    result.detail ??
    result.repositories
      .flatMap((repository) => [repository.detail, ...repository.refs.map((entry) => entry.detail)])
      .find((detail) => detail !== undefined)
  )
}
