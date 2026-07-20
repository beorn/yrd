import { join, resolve } from "node:path"
import { createProcess, type Process, type ProcessResult } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"

export type YrdRepository = Readonly<{
  repo: string
  worktree: string
  gitDir: string
  stateDir: string
  baysRoot: string
  defaultBase: string
}>

type RepositoryProcess = Pick<Process, "run">

async function git(
  process: RepositoryProcess,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  allowFailure = false,
): Promise<ProcessResult> {
  const result = await process.run({ argv: ["git", "-C", cwd, ...args], cwd, env })
  if (!Number.isSafeInteger(result.exitCode)) throw new Error("yrd: Git returned an invalid exit code")
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `yrd: git ${args.join(" ")} exited ${result.exitCode}`,
    )
  }
  return result
}

function value(result: Pick<ProcessResult, "exitCode" | "stdout">): string | undefined {
  if (result.exitCode !== 0) return undefined
  const text = result.stdout.trim()
  return text === "" ? undefined : text
}

function primaryWorktree(output: string): Readonly<{ path: string; branch?: string }> | undefined {
  const first = output.split(/\n\n+/u)[0]
  if (first === undefined) return undefined
  const fields = new Map(
    first
      .split("\n")
      .filter((entry) => entry.includes(" "))
      .map((entry) => [entry.slice(0, entry.indexOf(" ")), entry.slice(entry.indexOf(" ") + 1)]),
  )
  const path = fields.get("worktree")
  if (path === undefined || path === "") return undefined
  const branch = fields.get("branch")
  return { path: resolve(path), ...(branch === undefined ? {} : { branch }) }
}

async function configuredWorktree(
  process: RepositoryProcess,
  worktree: string,
  gitDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const file of ["config.worktree", "config"]) {
    const configured = value(
      await git(process, worktree, env, ["config", "--file", join(gitDir, file), "--get", "core.worktree"], true),
    )
    if (configured !== undefined) return resolve(gitDir, configured)
  }
  return undefined
}

async function defaultBranch(
  process: RepositoryProcess,
  repo: string,
  env: NodeJS.ProcessEnv,
  primaryBranch?: string,
): Promise<string> {
  const remote = value(
    await git(process, repo, env, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true),
  )
  if (remote !== undefined) return remote.startsWith("origin/") ? remote.slice("origin/".length) : remote
  const configured = value(await git(process, repo, env, ["config", "--get", "init.defaultBranch"], true))
  if (configured !== undefined) {
    const configuredRef = await git(
      process,
      repo,
      env,
      ["show-ref", "--verify", "--quiet", `refs/heads/${configured}`],
      true,
    )
    if (configuredRef.exitCode === 0) return configured
  }
  const main = await git(process, repo, env, ["show-ref", "--verify", "--quiet", "refs/heads/main"], true)
  if (main.exitCode === 0) return "main"
  if (primaryBranch?.startsWith("refs/heads/") === true) return primaryBranch.slice("refs/heads/".length)
  const current = value(await git(process, repo, env, ["branch", "--show-current"], true))
  return current ?? "main"
}

/** Resolve one shared Yrd authority even when invoked from a linked worktree.
 * Inherited Git hook variables are stripped before every discovery command. */
export async function discoverYrdRepository(
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    process?: RepositoryProcess
  } = {},
): Promise<YrdRepository> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const owned = options.process === undefined ? createProcess({ cwd, env: options.env }) : undefined
  const runner = options.process ?? owned
  if (runner === undefined) throw new Error("yrd: repository discovery has no Process")
  const env = cleanGitEnvironment(options.env ?? process.env)
  try {
    const top = await git(runner, cwd, env, ["rev-parse", "--path-format=absolute", "--show-toplevel"], true)
    const worktree = value(top)
    if (worktree === undefined) throw new Error(`yrd: '${cwd}' is not inside a Git worktree`)
    const common = await git(runner, worktree, env, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    const gitDirValue = value(common)
    if (gitDirValue === undefined) throw new Error("yrd: Git returned an empty common directory")
    const gitDir = resolve(worktree, gitDirValue)
    const worktrees = await git(runner, worktree, env, ["worktree", "list", "--porcelain"])
    const primary = primaryWorktree(worktrees.stdout)
    if (primary === undefined) throw new Error("yrd: Git did not report a primary worktree")
    const repo = (await configuredWorktree(runner, worktree, gitDir, env)) ?? primary.path
    return {
      repo,
      worktree: resolve(worktree),
      gitDir,
      stateDir: join(gitDir, "yrd"),
      baysRoot: join(repo, ".bays"),
      defaultBase: await defaultBranch(runner, repo, env, primary.branch),
    }
  } finally {
    await owned?.close()
  }
}
