import { join, resolve } from "node:path"
import type { LegacyStateLocation } from "./state-layout.ts"

export type RepositoryProcessRequest = Readonly<{
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}>

export type RepositoryProcessResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type RepositoryProcessRunner = (request: RepositoryProcessRequest) => Promise<RepositoryProcessResult>

export type YrdRepository = Readonly<{
  repo: string
  worktree: string
  gitDir: string
  stateDir: string
  baysRoot: string
  defaultBase: string
  legacyLocations: readonly LegacyStateLocation[]
}>

const defaultProcess: RepositoryProcessRunner = async (request) => {
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("GIT_")))
}

async function git(
  runner: RepositoryProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  allowFailure = false,
): Promise<RepositoryProcessResult> {
  const result = await runner({ argv: ["git", "-C", cwd, ...args], cwd, env })
  if (!Number.isSafeInteger(result.exitCode)) throw new Error("yrd: Git returned an invalid exit code")
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `yrd: git ${args.join(" ")} exited ${result.exitCode}`)
  }
  return result
}

function value(result: RepositoryProcessResult): string | undefined {
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
      .filter((line) => line.includes(" "))
      .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
  )
  const path = fields.get("worktree")
  if (path === undefined || path === "") return undefined
  const branch = fields.get("branch")
  return { path: resolve(path), ...(branch === undefined ? {} : { branch }) }
}

async function defaultBranch(
  runner: RepositoryProcessRunner,
  repo: string,
  env: NodeJS.ProcessEnv,
  primaryBranch?: string,
): Promise<string> {
  const remote = value(
    await git(runner, repo, env, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true),
  )
  if (remote !== undefined) return remote.startsWith("origin/") ? remote.slice("origin/".length) : remote
  if (primaryBranch?.startsWith("refs/heads/") === true) return primaryBranch.slice("refs/heads/".length)
  const configured = value(await git(runner, repo, env, ["config", "--get", "init.defaultBranch"], true))
  if (configured !== undefined) return configured
  const main = await git(runner, repo, env, ["show-ref", "--verify", "--quiet", "refs/heads/main"], true)
  if (main.exitCode === 0) return "main"
  const current = value(await git(runner, repo, env, ["branch", "--show-current"], true))
  return current ?? "main"
}

/** Resolve one shared Yrd authority even when invoked from a linked worktree.
 * Inherited Git hook variables are stripped before every discovery command. */
export async function discoverYrdRepository(options: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  process?: RepositoryProcessRunner
} = {}): Promise<YrdRepository> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const runner = options.process ?? defaultProcess
  const sourceEnv = options.env ?? process.env
  const env = cleanEnvironment(sourceEnv)
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
  const repo = primary.path
  const configuredLegacy = value(await git(runner, repo, env, ["config", "--get", "bay.dir"], true))
  const legacyLocations: LegacyStateLocation[] = []
  legacyLocations.push({ path: join(repo, ".bay"), source: "<repo>/.bay" })
  if (sourceEnv.BAY_DIR?.trim()) legacyLocations.push({ path: resolve(repo, sourceEnv.BAY_DIR), source: "BAY_DIR" })
  if (configuredLegacy !== undefined) legacyLocations.push({ path: resolve(repo, configuredLegacy), source: "bay.dir" })

  return {
    repo,
    worktree: resolve(worktree),
    gitDir,
    stateDir: join(gitDir, "yrd"),
    baysRoot: join(repo, ".bays"),
    defaultBase: await defaultBranch(runner, repo, env, primary.branch),
    legacyLocations,
  }
}
