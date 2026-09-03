/**
 * `yrd env open|list` — an environment for one branch
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Commands;
 * `yrd bay` is the same command's alias and "bay" its internal name).
 *
 * An environment is a git worktree under `.bays/`, and that is all it is. It
 * is opened through `@yrd/bay`'s own workspace primitive — the one the plan
 * keeps ("bays stay as workspaces") — never through an app, a journal or a
 * job runner: the durable `Bay` record, its lifecycle states, the PR mint and
 * the receiver remote went with the old core at M6, and nothing that is left
 * reads them.
 *
 * So `list` reads the worktrees git itself holds under the bays root rather
 * than a record of what was once opened. One source per fact: if git does not
 * have the worktree, the environment is not there.
 */

import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { createGitWorkspace } from "@yrd/bay"
import { hintsIn } from "@yrd/queue-core"
import { createProcess, type Process } from "@yrd/process"
import { declarationHere } from "./declaration.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

export type EnvOpenOptions = Readonly<{ bay?: string; issue?: string; json?: boolean }>
export type EnvListOptions = Readonly<{ json?: boolean }>

/** One environment as git holds it: a worktree under the bays root. */
export type EnvRow = Readonly<{ name: string; path: string; branch?: string; head?: string }>

/**
 * The repository a command stands in, and the branch its declaration names.
 * Absent declaration is loud: an environment is cut from the queue's branch,
 * and guessing `main` when the repository never said so is the silent default
 * this whole design refuses.
 */
function repositoryHere(io: YrdCliIO): Readonly<{ root: string; branch: string }> {
  const here = declarationHere(io.cwd ?? process.cwd())
  if (here === undefined) {
    throw new Error("yrd: no .yrd.yml here or above; an environment is cut from the branch that file declares")
  }
  return { branch: hintsIn(here.text).branch ?? "main", root: here.root }
}

function baysRootOf(repo: string): string {
  return join(repo, ".bays")
}

/** The base a fresh environment is cut from: the queue's branch as this
 * checkout last fetched it, else the local branch of that name. Named, so a
 * refusal says which ref was missing rather than "could not resolve HEAD". */
async function baseRef(process: Pick<Process, "run">, repo: string, branch: string): Promise<string> {
  const tracking = `refs/remotes/origin/${branch}`
  const read = await process.run({
    argv: ["git", "rev-parse", "--verify", "--quiet", `${tracking}^{commit}`],
    cwd: repo,
  })
  return read.exitCode === 0 && read.stdout.trim() !== "" ? tracking : branch
}

/**
 * `yrd env open` — open an environment for one branch and keep it. Prints its
 * path on stdout, which is what a caller `cd`s into.
 */
export async function openEnvironment(options: EnvOpenOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const { root, branch: queueBranch } = repositoryHere(io)
  const name = (options.bay ?? options.issue ?? `env-${Date.now().toString(36)}`).trim()
  if (name === "") throw new Error("yrd: --bay needs a name")
  const branch = `task/${name}`
  await using process = createProcess({ cwd: root })
  const workspace = await createGitWorkspace({ repo: root, baysRoot: baysRootOf(root), process })
  const provisioned = await workspace.provision({
    bay: name,
    name,
    branch,
    base: await baseRef(process, root, queueBranch),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
  })
  if (provisioned.conclusion !== "success") {
    throw new Error(`yrd: could not open environment '${name}': ${provisioned.error.message}`)
  }
  const { path, headSha, baseSha } = provisioned.output
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ base: baseSha, branch, head: headSha, name, path })}\n`)
  } else {
    io.stderr(`${name} on ${branch} at ${headSha.slice(0, 12)}, cut from ${queueBranch} ${baseSha.slice(0, 12)}\n`)
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
