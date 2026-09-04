/**
 * `yrd env open|list` — an environment for one branch
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Commands;
 * `yrd bay` is the same command's alias and "bay" its internal name).
 *
 * An environment is a git worktree under `.bays/`; that worktree is its whole
 * identity and lifecycle. Opening it runs the target's declared setup after
 * materialization, through the same bounded executor as the queue, but never
 * creates an app, journal or job: the durable `Bay` record, its lifecycle
 * states, the PR mint and the receiver remote went with the old core at M6,
 * and nothing that is left reads them.
 *
 * So `list` reads the worktrees git itself holds under the bays root rather
 * than a record of what was once opened. One source for each update: if git does not
 * have the worktree, the environment is not there.
 */

import { existsSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { createGitWorkspace } from "@yrd/bay"
import { checkedTree, gitIn, hintsIn, readConfig, refAt, runId, runSetup, SetupFailed, type Git } from "@yrd/queue-core"
import { createProcess } from "@yrd/process"
import { declarationHere } from "./declaration.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"

export type EnvOpenOptions = Readonly<{ bay?: string; issue?: string; json?: boolean }>
export type EnvListOptions = Readonly<{ json?: boolean }>

/** One environment as git holds it: a worktree under the bays root. */
export type EnvRow = Readonly<{ name: string; path: string; branch?: string; head?: string }>

/**
 * The repository a command stands in, and the target its declaration names.
 * Absent declaration is loud: an environment is cut from the target, and
 * guessing `main` when the repository never said so is the silent default
 * this whole design refuses.
 */
function repositoryHere(io: YrdCliIO): Readonly<{ root: string; target: string }> {
  const here = declarationHere(io.cwd ?? process.cwd())
  if (here === undefined) {
    throw new Error("yrd: no .yrd.yml here or above; an environment is cut from the target that file declares")
  }
  return { root: here.root, target: hintsIn(here.text).target?.branch ?? "main" }
}

function baysRootOf(repo: string): string {
  return join(repo, ".bays")
}

/** The base a fresh environment is cut from: the target as this checkout last
 * fetched it, else the local branch of that name. Named, so a refusal says
 * which ref was missing rather than "could not resolve HEAD". */
async function resolveBaseSha(git: Git, target: string): Promise<string> {
  const tracking = `refs/remotes/origin/${target}`
  const tracked = await refAt(git, tracking)
  if (tracked !== undefined) return tracked
  const local = await refAt(git, target)
  if (local !== undefined) return local
  throw new Error(`yrd: target '${target}' is absent at both ${tracking} and the local branch`)
}

/**
 * `yrd env open` — open an environment for one branch and keep it. Prints its
 * path on stdout, which is what a caller `cd`s into.
 */
export async function openEnvironment(options: EnvOpenOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const { root, target } = repositoryHere(io)
  const name = (options.bay ?? options.issue ?? `env-${Date.now().toString(36)}`).trim()
  if (name === "") throw new Error("yrd: --bay needs a name")
  const branch = `task/${name}`
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process)
  const base = await resolveBaseSha(git, target)
  const config = await readConfig(git, base)
  const workspace = await createGitWorkspace({ repo: root, baysRoot: baysRootOf(root), process })
  const provisioned = await workspace.provision({
    bay: name,
    name,
    branch,
    base,
  })
  if (provisioned.conclusion !== "success") {
    throw new Error(`yrd: could not open environment '${name}': ${provisioned.error.message}`)
  }
  const { path, headSha, baseSha } = provisioned.output
  const setup = config?.setup
  if (setup !== undefined) {
    const artifacts = join(await workdirOf(git), "environments", name, runId())
    try {
      const tree = await checkedTree(path, baseSha, process)
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
        `environment setup ${result.result} in preserved bay ${path}: exit ${String(result.exit)}${why}\n` +
          `command: ${setup}\n${output}\nlog ${result.log}`,
        { cause: error },
      )
    }
  }
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ base: baseSha, branch, head: headSha, name, path })}\n`)
  } else {
    io.stderr(`${name} on ${branch} at ${headSha.slice(0, 12)}, cut from ${target} ${baseSha.slice(0, 12)}\n`)
    io.stdout(`${path}\n`)
  }
  return 0
}

/** `yrd env list` — the environments this repository holds, as git holds them. */
export async function listEnvironments(options: EnvListOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const { root } = repositoryHere(io)
  const baysRoot = baysRootOf(root)
  await using process = createProcess({ cwd: root })
  // `-z` because a worktree path may contain a newline, and the newline form
  // would then split one entry into two unreadable ones.
  const listed = await process.run({ argv: ["git", "worktree", "list", "--porcelain", "-z"], cwd: root })
  if (listed.exitCode !== 0)
    throw new Error(`yrd: git worktree list exited ${String(listed.exitCode)}: ${listed.stderr.trim()}`)
  const under = `${resolve(baysRoot)}/`
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
      current.path = line.slice("worktree ".length).trim()
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
    io.stdout(`no environments under ${baysRoot}${existsSync(baysRoot) ? "" : " (it does not exist)"}\n`)
    return 0
  }
  io.stdout(`${rows.map((row) => `${row.name}  ${row.branch ?? "(detached)"}  ${row.path}`).join("\n")}\n`)
  return 0
}
