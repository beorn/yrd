/**
 * Retained, detached environments at exact commits. Git's worktree registry
 * is their identity; no branch ownership or second environment registry.
 * Materialization and setup use the same boundaries as queue checkouts, but
 * setup failure preserves a retained environment for inspection.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  checkedTree,
  freshWorktree,
  gitIn,
  readConfig,
  refAt,
  registeredWorktrees,
  runCheck,
  runId,
  runSetup,
  SetupFailed,
  type Git,
} from "@yrd/queue-core"
import { createProcess } from "@yrd/process"
import { repositoryHere } from "./declaration.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"

export type EnvOpenOptions = Readonly<{ json?: boolean }>
export type EnvListOptions = Readonly<{ json?: boolean }>
export type EnvCloseOptions = Readonly<{ json?: boolean }>

/** One environment as git holds it: a worktree under the derived root. */
export type EnvRow = Readonly<{ name: string; path: string; branch?: string; head?: string }>

function requireRepository(io: YrdCliIO): string {
  const cwd = io.cwd ?? process.cwd()
  const root = repositoryHere(cwd)
  if (root === undefined)
    throw new Error(`yrd env needs a repository: no Git clone contains ${cwd}; run it inside a clone`)
  return root
}

/**
 * Open the exact commit detached and print its retained path on stdout.
 */
export async function openEnvironment(commit: string, options: EnvOpenOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new Error(`yrd env open needs an exact commit object ID, not '${commit}'; resolve it with git rev-parse HEAD`)
  }
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process)
  if ((await refAt(git, commit)) !== commit) {
    throw new Error(
      `yrd env open: commit ${commit} is not a commit object in ${root}; fetch that commit before opening it`,
    )
  }
  const config = await readConfig(git, commit, { branch: "HEAD", remote: "origin" })
  const workdir = resolve(root, await workdirOf(git))
  const name = `${commit.slice(0, 12)}-${runId()}`
  const environments = join(workdir, "environments")
  mkdirSync(environments, { recursive: true })
  const path = join(environments, name)
  await freshWorktree(git, root, commit, path)
  const setup = config?.setup
  if (setup !== undefined) {
    const artifacts = join(workdir, "logs", "environments", name)
    try {
      const tree = await checkedTree(path, commit, process)
      await runSetup({
        cwd: path,
        process,
        setup: { logDir: join(artifacts, "logs"), run: setup, tmpdir: join(artifacts, "tmp") },
        tree,
      })
    } catch (error) {
      if (!(error instanceof SetupFailed)) throw error
      const result = error.ran.result
      const output = readFileSync(result.log, "utf8").trim() || "(setup produced no output)"
      const why = result.why === undefined ? "" : ` (${result.why})`
      throw new Error(
        `environment setup ${result.result} in preserved environment ${path}: exit ${String(result.exit)}${why}\n` +
          `command: ${setup}\n${output}\nlog ${result.log}`,
        { cause: error },
      )
    }
  }
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ head: commit, name, path })}\n`)
  } else {
    io.stderr(`${name} detached at ${commit}\n`)
    io.stdout(`${path}\n`)
  }
  return 0
}

/** `yrd env list` — the environments this repository holds, as git holds them. */
export async function listEnvironments(options: EnvListOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  await using process = createProcess({ cwd: root })
  const environments = join(resolve(root, await workdirOf(gitIn(root, process))), "environments")
  let physicalRoot = environments
  try {
    physicalRoot = realpathSync(environments)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const under = `${physicalRoot}/`
  const rows: EnvRow[] = (await registeredWorktrees(gitIn(root, process)))
    .filter(({ path }) => path.startsWith(under))
    .map(({ path, head, branch }) => ({
      name: basename(path),
      path,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
    }))
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ environments: rows })}\n`)
    return 0
  }
  if (rows.length === 0) {
    io.stdout(
      `no registered environments under ${environments}${existsSync(environments) ? "" : " (it does not exist)"}; worktrees elsewhere excluded\n`,
    )
    return 0
  }
  io.stdout(`${rows.map((row) => `${row.name}  ${row.branch ?? "(detached)"}  ${row.path}`).join("\n")}\n`)
  return 0
}

/** Refuse before running user teardown; a dirty tree is work, not garbage. */
async function requireClean(git: Git, path: string): Promise<void> {
  const dirty = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])
  if (dirty !== "") throw new Error(`environment ${path} is dirty; preserve or commit its changes before yrd env close`)
}

/** Retained environments use Git's non-force removal, never queue reaping. */
export async function closeEnvironment(
  operand: string,
  options: EnvCloseOptions,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process)
  const workdir = resolve(root, await workdirOf(git))
  const environments = join(workdir, "environments")
  const requested = resolve(io.cwd ?? globalThis.process.cwd(), operand)
  let path: string
  try {
    path = realpathSync(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR")
      throw error
    throw new Error(
      `environment ${requested} is not registered at an existing path; inspect git worktree list before retrying`,
      { cause: error },
    )
  }
  const registered = (await registeredWorktrees(git)).find((entry) => resolve(entry.path) === path)
  if (registered === undefined)
    throw new Error(`environment ${requested} is not registered in ${root}; inspect git worktree list`)
  if (!existsSync(environments))
    throw new Error(`environment ${path} is outside the absent environment root ${environments}; nothing was removed`)
  const within = relative(realpathSync(environments), path)
  if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error(`environment ${path} is outside environment root ${environments}; nothing was removed`)
  }
  if (registered.locked !== undefined)
    throw new Error(
      `environment ${path} is locked${registered.locked === "" ? "" : `: ${registered.locked}`}; resolve its owner before closing it`,
    )
  const treeGit = gitIn(path, process)
  await requireClean(treeGit, path)
  const commit = (await treeGit(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(treeGit, commit, { branch: "HEAD", remote: "origin" })
  if (config?.teardown !== undefined) {
    const artifacts = join(workdir, "logs", "environments", basename(path), runId())
    const result = await runCheck({
      cwd: path,
      process,
      tree: { base: commit, candidate: commit },
      spec: { name: "teardown", run: config.teardown },
      logDir: join(artifacts, "logs"),
      tmpdir: join(artifacts, "tmp"),
    })
    if (result.result !== "pass") {
      const output = readFileSync(result.log, "utf8").trim() || "(teardown produced no output)"
      throw new Error(
        `environment teardown ${result.result} in preserved environment ${path}: exit ${String(result.exit)}${result.why === undefined ? "" : ` (${result.why})`}\ncommand: ${config.teardown}\n${output}\nlog ${result.log}`,
      )
    }
    await requireClean(treeGit, path)
  }
  await git(["worktree", "remove", path])
  io.stdout(options.json === true ? `${JSON.stringify({ closed: path })}\n` : `closed environment ${path}\n`)
  return 0
}
