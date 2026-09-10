import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  configValue,
  gitIn,
  populateReferenceStores,
  queueName,
  resolveGitSelection,
  type GitSelection,
  type ReferenceStore,
} from "@yrd/queue-core"
import { parseQueueAddress, queueDirectory, queueRoot, type QueueAddress } from "./address.ts"
import { repositoryHere } from "./declaration.ts"

export type QueueLocation = Readonly<{
  repo: string
  queue: string | undefined
  workdir: string
  /** One immutable selection, resolved before address reads and retained by the queue command. */
  selection: GitSelection
  /**
   * Stores the queue-owned clone had to be given before anything could borrow
   * from it. Empty for a reference that was already self-contained, and for
   * every context that reads from the caller's own checkout instead.
   */
  referenceStores: readonly ReferenceStore[]
  /** Submission retains its author checkout and sends to this transport. */
  remote?: string
  address?: QueueAddress
}>

export async function originHead(git: ReturnType<typeof gitIn>, remote = "origin"): Promise<string> {
  const out = await git(["ls-remote", "--symref", remote, "HEAD"])
  const branch = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/mu.exec(out)?.[1]
  if (branch === undefined || branch === "") {
    throw new Error(`${remote}/HEAD did not name a queue branch; set the remote's HEAD or pass --queue <branch>`)
  }
  return branch
}

async function hostWorkdir(cwd: string, env: NodeJS.ProcessEnv, git: ReturnType<typeof gitIn>): Promise<string> {
  const declared = await configValue(git, "yrd.workdir")
  if (declared !== undefined) return resolve(repositoryHere(cwd) ?? cwd, declared)
  return join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "yrd")
}

/**
 * The queue-owned clone, and a reference every compose can borrow from.
 *
 * The clone is `--no-checkout` — the queue reads objects out of it, never
 * files — and that is also why it materializes no submodule: there is no
 * working tree for `git submodule update` to write one into. Nothing else ever
 * created those stores, so for as long as this function existed the clone it
 * returned could not be borrowed from at all. Measured 2026-09-09: fifteen
 * gitlinks, no store for any of them, every compose cloning all fifteen from
 * GitHub, 82 to 1449 seconds each, four hours of a saturated host.
 *
 * Populating here makes the clone self-contained the moment it exists, for
 * `yrd check` and `yrd env` as much as for a queue run — each composes from
 * this same repository, and none of them opens a run journal. A compose
 * populates again for its own commit (worktree.ts), because a change that adds
 * a submodule declares it at that commit and this repository's HEAD has never
 * seen it.
 */
async function ensureOwnedClone(
  root: string,
  address: QueueAddress,
  selection: GitSelection,
  env: NodeJS.ProcessEnv,
): Promise<Readonly<{ repo: string; referenceStores: readonly ReferenceStore[] }>> {
  const repo = queueDirectory(root, address)
  if (!existsSync(repo)) {
    mkdirSync(dirname(repo), { recursive: true })
    await gitIn(dirname(repo), undefined, selection, { env })([
      "clone",
      "--quiet",
      "--origin",
      "origin",
      "--no-checkout",
      address.transport,
      repo,
    ])
  }
  const git = gitIn(repo, undefined, selection, { env })
  const actual = (await git(["remote", "get-url", "origin"])).trim()
  if (actual !== address.transport) {
    throw new Error(
      `queue clone ${repo} has origin ${actual}, not ${address.transport}; move the mismatched clone aside and retry ${address.canonical}`,
    )
  }
  const referenceStores = await populateReferenceStores({
    gitIn: (cwd) => gitIn(cwd, undefined, selection, { env }),
    repo,
  })
  return { referenceStores, repo }
}

/** Resolve the one queue selector; only submission retains the author's checkout. */
export async function resolveQueueLocation(
  cwd: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  context: "queue" | "reader" | "submit" = "queue",
): Promise<QueueLocation> {
  const inside = repositoryHere(cwd)
  if (inside === undefined && context !== "queue") {
    throw new Error(
      `${context === "submit" ? "submit" : "queue list/show/watch"} at ${cwd} needs a repository; run inside a clone${context === "submit" ? " containing the branch to submit" : " or the queue-owned clone"}`,
    )
  }
  const selection = await resolveGitSelection(cwd, { env })
  const git = gitIn(inside ?? cwd, undefined, selection, { env })
  const addressed =
    value !== undefined &&
    (value.includes("#") || value.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value))
  let address: QueueAddress
  if (inside !== undefined && !addressed) {
    const queue = value ?? (await originHead(git))
    const transport = (await git(["remote", "get-url", "origin"])).trim()
    address = parseQueueAddress(queueName({ branch: queue, remote: "origin" }, transport))
  } else {
    if (value === undefined || !addressed) {
      throw new Error(
        `queue command at ${cwd} needs a repository; run inside a clone or pass --queue <repo>#<queue>, for example --queue beorn/hh#main`,
      )
    }
    let selected = value
    if (!selected.includes("#")) selected = `${selected}#${await originHead(git, selected)}`
    const split = selected.indexOf("#")
    const repository = selected.slice(0, split)
    if (inside !== undefined && (await git(["remote"])).trim().split("\n").includes(repository)) {
      const transport = (await git(["remote", "get-url", repository])).trim()
      selected = queueName({ branch: selected.slice(split + 1), remote: repository }, transport)
    }
    address = parseQueueAddress(selected)
  }
  const host = await hostWorkdir(cwd, env, git)
  const workdir = queueRoot(host, address)
  if (context !== "queue" && inside !== undefined) {
    return {
      address,
      selection,
      queue: address.queue,
      referenceStores: [],
      repo: inside,
      remote: context === "submit" && addressed ? address.transport : undefined,
      workdir,
    }
  }
  const owned = await ensureOwnedClone(host, address, selection, env)
  return {
    address,
    selection,
    queue: address.queue,
    referenceStores: owned.referenceStores,
    repo: owned.repo,
    workdir,
  }
}
