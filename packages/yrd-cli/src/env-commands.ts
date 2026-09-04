/**
 * Retained, detached environments at exact commits. Git's worktree registry
 * is their identity; no branch ownership or second environment registry.
 * Materialization and setup use the same boundaries as queue checkouts, but
 * setup failure preserves a retained environment for inspection.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { checkedTree, freshWorktree, gitIn, readConfig, refAt, runId, runSetup, SetupFailed } from "@yrd/queue-core"
import { createProcess } from "@yrd/process"
import { repositoryHere } from "./declaration.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"

export type EnvOpenOptions = Readonly<{ json?: boolean }>
export type EnvListOptions = Readonly<{ json?: boolean }>

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
  // `-z` because a worktree path may contain a newline, and the newline form
  // would then split one entry into two unreadable ones.
  const listed = await process.run({ argv: ["git", "worktree", "list", "--porcelain", "-z"], cwd: root })
  if (listed.exitCode !== 0) {
    throw new Error(`yrd: git worktree list exited ${String(listed.exitCode)}: ${listed.stderr.trim()}`)
  }
  const under = `${resolve(environments)}/`
  const rows: EnvRow[] = []
  let current: { path?: string; head?: string; branch?: string } = {}
  const take = (): void => {
    const { path, head, branch } = current
    current = {}
    if (path === undefined || !path.startsWith(under)) return
    rows.push({
      name: basename(path),
      path,
      ...(branch === undefined ? {} : { branch }),
      ...(head === undefined ? {} : { head }),
    })
  }
  for (const line of listed.stdout.split("\0")) {
    if (line.startsWith("worktree ")) {
      take()
      current.path = line.slice("worktree ".length)
    } else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim()
    else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//u, "")
    }
  }
  take()
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
