import type { GitProcess, GitProcessResult } from "git-super/process"
import type { GitResultDetail, GitSuperResult } from "git-super/result"
import { Buffer } from "node:buffer"
import type { Process } from "./index.ts"

export type GitProcessDefaults = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

export type GitSyncReadCommand =
  | Readonly<{ verb: "rev-parse"; args: readonly string[] }>
  | Readonly<{ verb: "for-each-ref"; args: readonly string[] }>
  | Readonly<{ verb: "status"; args: readonly string[] }>
  | Readonly<{ verb: "rev-list"; args: readonly string[] }>
  | Readonly<{ verb: "merge-base"; args: readonly string[] }>
  | Readonly<{ verb: "show"; args: readonly string[] }>
  | Readonly<{ verb: "show-ref"; args: readonly string[] }>
  | Readonly<{ verb: "cherry"; args: readonly string[] }>
  | Readonly<{ verb: "diff"; args: readonly string[] }>
  | Readonly<{ verb: "cat-file"; args: readonly string[] }>
  | Readonly<{ verb: "log"; args: readonly string[] }>
  | Readonly<{ verb: "patch-id"; args: readonly string[] }>
  | Readonly<{ verb: "stash-list" }>
  | Readonly<{ verb: "branch-show-current" }>
  | Readonly<{ verb: "worktree-list" }>
  | Readonly<{ verb: "config-get-regexp"; file?: string; pattern: string; nul?: boolean }>
  | Readonly<{ verb: "remote-get-url"; remote: string }>

export type GitSyncReadRequest = Readonly<{
  repo: string
  command: GitSyncReadCommand
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
}>

export type YrdGitProcess = GitProcess & GitSyncReader

export type GitSyncReader = Readonly<{
  /** Bounded synchronous Git is deliberately restricted to typed local reads. */
  readSync(request: GitSyncReadRequest): GitProcessResult
}>

type SyncGitExecution = Readonly<{
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
}>

type SyncGitExecutionHandler = (execution: SyncGitExecution) => GitProcessResult

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

function decode(output: Uint8Array | undefined): string {
  return output === undefined ? "" : new TextDecoder().decode(output)
}

function executeGitSync(execution: SyncGitExecution): GitProcessResult {
  try {
    const result = Bun.spawnSync([...execution.argv], {
      cwd: execution.cwd,
      env: execution.env,
      stdin: execution.stdin === undefined ? undefined : Buffer.from(execution.stdin),
      stdout: "pipe",
      stderr: "pipe",
      ...(execution.timeoutMs === undefined ? {} : { timeout: execution.timeoutMs }),
    })
    const signal = "signalCode" in result && result.signalCode != null ? String(result.signalCode) : null
    const timedOut = "exitedDueToTimeout" in result && result.exitedDueToTimeout === true
    return {
      code: typeof result.exitCode === "number" ? result.exitCode : 1,
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      signal,
      ...(timedOut ? { timedOut: true, failure: "git sync read timed out" } : {}),
      ...(!timedOut && signal !== null ? { failure: `git sync read ended on ${signal}` } : {}),
    }
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    return { code: 1, stdout: "", stderr: failure, failure }
  }
}

function syncReadArgv(command: GitSyncReadCommand): readonly string[] {
  switch (command.verb) {
    case "stash-list":
      return ["stash", "list"]
    case "branch-show-current":
      return ["branch", "--show-current"]
    case "worktree-list":
      return ["worktree", "list", "--porcelain", "-z"]
    case "config-get-regexp":
      return [
        "config",
        ...(command.nul === true ? ["--null"] : []),
        ...(command.file === undefined ? [] : ["--file", command.file]),
        "--get-regexp",
        command.pattern,
      ]
    case "remote-get-url":
      return ["remote", "get-url", command.remote]
    default:
      return [command.verb, ...command.args]
  }
}

export function adaptProcessGit(
  process: undefined,
  defaults?: GitProcessDefaults,
  inject?: Readonly<{ executeSync?: SyncGitExecutionHandler }>,
): GitSyncReader
export function adaptProcessGit(
  process: Pick<Process, "run">,
  defaults?: GitProcessDefaults,
  inject?: Readonly<{ executeSync?: SyncGitExecutionHandler }>,
): YrdGitProcess

/** Yrd's only adapter from its supervised process port to git-super's Git port. */
export function adaptProcessGit(
  process: Pick<Process, "run"> | undefined,
  defaults: GitProcessDefaults = {},
  inject: Readonly<{ executeSync?: SyncGitExecutionHandler }> = {},
): YrdGitProcess | GitSyncReader {
  const readSync: GitSyncReader["readSync"] = (request) => {
    const argv = syncReadArgv(request.command)
    return (inject.executeSync ?? executeGitSync)({
      argv: ["git", "-C", request.repo, ...argv],
      // Let `git -C` report a missing/non-repository target as a normal Git
      // exit. Anchoring the OS spawn itself there turns that domain result into
      // an unrelated ENOENT before Git can run.
      cwd: globalThis.process.cwd(),
      env: gitEnvironment(defaults.env ?? globalThis.process.env, request.env),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...((request.timeoutMs ?? defaults.timeoutMs) === undefined
        ? {}
        : { timeoutMs: request.timeoutMs ?? defaults.timeoutMs }),
    })
  }
  if (process === undefined) return { readSync }
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
    readSync,
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

/** One human-readable line for a failed `adaptProcessGit` call: the process-level
 * failure if there is one (a crash, a signal, a sweep that could not certify
 * teardown), else the timeout, else Git's own stderr/stdout, else the bare exit
 * code. `timeoutMs` only labels a timeout that already happened — it does not
 * configure one. */
export function gitFailure(result: GitProcessResult, timeoutMs: number): string {
  if (result.timedOut === true) return `timed out after ${String(timeoutMs)}ms`
  return result.failure ?? (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`)
}
