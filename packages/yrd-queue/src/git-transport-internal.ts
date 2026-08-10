import type { Process } from "@yrd/process"
import type { SubmoduleCompositionGit } from "git-super/composition"

export function adaptProcessGit(process: Pick<Process, "run">): SubmoduleCompositionGit {
  return {
    async run(request) {
      const result = await process.run({
        argv: ["git", "-C", request.repo, ...request.args],
        cwd: request.repo,
        env: request.env,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        timeoutMs: request.timeoutMs,
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

/** Publish one immutable remote ref with create-only CAS semantics. */
export async function publishImmutableRemoteRef(request: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  origin: string
  ref: string
  sha: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<void> {
  const git = adaptProcessGit(request.inject.process)
  const existing = await remoteRef(git, request.repo, request.origin, request.ref, request)
  if (existing !== undefined) {
    if (existing === request.sha) return
    throw new Error(`remote immutable ref '${request.ref}' already names '${existing}' and will not be moved`)
  }
  const pushed = await queueGit(
    git,
    request.repo,
    [
      "push",
      "--porcelain",
      "--no-verify",
      `--force-with-lease=${request.ref}:`,
      request.origin,
      `${request.sha}:${request.ref}`,
    ],
    request,
  )
  const published = await remoteRef(git, request.repo, request.origin, request.ref, request)
  if (published === request.sha) return
  if (published !== undefined) {
    throw new Error(`remote immutable ref '${request.ref}' already names '${published}' and will not be moved`)
  }
  if (!settled(pushed) || pushed.code !== 0) throw new Error(gitDetail(pushed))
  throw new Error(`published immutable ref '${request.ref}' is missing`)
}

async function remoteRef(
  git: SubmoduleCompositionGit,
  repo: string,
  origin: string,
  ref: string,
  options: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }>,
): Promise<string | undefined> {
  const result = await queueGit(git, repo, ["ls-remote", "--refs", origin, ref], options)
  if (!settled(result) || result.code !== 0) throw new Error(gitDetail(result))
  const output = result.stdout.trim()
  if (output === "") return undefined
  const [sha, resolvedRef] = output.split(/\s+/u)
  if (resolvedRef !== ref || sha === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sha)) {
    throw new Error(`remote immutable ref '${ref}' is missing or malformed`)
  }
  return sha
}

function queueGit(
  git: SubmoduleCompositionGit,
  repo: string,
  args: readonly string[],
  options: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }>,
): Promise<Awaited<ReturnType<SubmoduleCompositionGit["run"]>>> {
  const source = options.env ?? globalThis.process.env
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv
  return git.run({
    repo,
    args,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" },
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

function settled(result: Awaited<ReturnType<SubmoduleCompositionGit["run"]>>): boolean {
  return (
    result.failure === undefined &&
    result.timedOut !== true &&
    result.stalled !== true &&
    (result.signal === undefined || result.signal === null)
  )
}

function gitDetail(result: Awaited<ReturnType<SubmoduleCompositionGit["run"]>>): string {
  const output = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`
  return result.failure === undefined ? output : `${result.failure}: ${output}`
}
