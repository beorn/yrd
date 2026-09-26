import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  configValue,
  gitIn,
  populateReferenceStores,
  queueName,
  remoteUrl,
  resolveGitSelection,
  type Git,
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
   * Whether `repo` is the queue's OWN clone rather than the caller's checkout.
   *
   * The one fact that says whether this repository may be GIVEN the submodule
   * stores a compose borrows from. Only this module can know it — everything
   * downstream sees a path — and a command that composes from a seat's own tree
   * must leave that tree alone.
   */
  owned: boolean
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

/**
 * The remote's default branch. A clone records it as refs/remotes/<remote>/HEAD (git clone, or
 * `git remote set-head <remote> -a` after the remote changes it), so it is read locally: `yrd queue
 * health` resolves it on every tick, and asking the remote each time was 156 GitHub sessions an hour
 * (hh 25626). Only a clone that recorded none asks the remote, and that failure stays loud.
 */
export async function originHead(git: Git, remote = "origin"): Promise<string> {
  const recorded = (await git(["for-each-ref", "--format=%(symref)", `refs/remotes/${remote}/HEAD`])).trim()
  const prefix = `refs/remotes/${remote}/`
  if (recorded.startsWith(prefix) && recorded.length > prefix.length) return recorded.slice(prefix.length)
  return remoteHead(git, remote)
}

/**
 * The default branch as `remote` itself answers it: a remote name, a path or a URL. It needs no
 * repository, so an address outside one resolves; a path or URL is never a remote name, so it is
 * asked directly rather than looked up in a clone's records (@dev/review2 P3 on ef04e3a459).
 */
export async function remoteHead(git: Git, remote: string): Promise<string> {
  const out = await git(["ls-remote", "--symref", remote, "HEAD"])
  const branch = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/mu.exec(out)?.[1]
  if (branch === undefined || branch === "") {
    throw new Error(`${remote}/HEAD did not name a queue branch; set the remote's HEAD or pass --queue <branch>`)
  }
  return branch
}

export async function hostWorkdir(cwd: string, env: NodeJS.ProcessEnv, git?: Git): Promise<string> {
  const declared = git !== undefined ? await configValue(git, "yrd.workdir") : undefined
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
  // Identity is the DECLARED url (remoteUrl); `remote get-url` expands url.<base>.insteadOf, so a
  // host's transport rewrite would read as a clone of another repository.
  const actual = await remoteUrl(git, "origin")
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

/**
 * The address of the queue `branch` names on the clone's `origin`: the one composition both the queue's default
 * selector and `ownedQueueClone` use (@cto on hh 25626).
 */
async function originQueueAddress(git: Git, branch: string): Promise<QueueAddress> {
  return parseQueueAddress(queueName({ branch, remote: "origin" }, await remoteUrl(git, "origin")))
}

/**
 * The queue-owned clone that a `yrd queue up` run inside `cwd` serves, from local records only: the origin URL and
 * `refs/remotes/origin/HEAD`, never a fetch or ls-remote. It names the origin/HEAD queue only, never one passed with
 * `--queue`. The merging round composes in worktrees of this clone, so its git common dir is where gitomic journals
 * the round's lease rejections (hh 25626). Throws naming the record it could not read; it never guesses a queue, and
 * so, unlike the queue's own default, it does not fall back to asking the remote (`originHead`).
 */
export async function ownedQueueClone(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const inside = repositoryHere(cwd)
  if (inside === undefined) throw new Error(`${cwd} is not inside a repository, so the queue it serves has no name`)
  const selection = await resolveGitSelection(cwd, { env })
  const git = gitIn(inside, undefined, selection, { env })
  const recorded = (await git(["for-each-ref", "--format=%(symref)", "refs/remotes/origin/HEAD"])).trim()
  const prefix = "refs/remotes/origin/"
  if (!recorded.startsWith(prefix) || recorded.length === prefix.length) {
    throw new Error(
      `${inside} records no refs/remotes/origin/HEAD; run \`git remote set-head origin --auto\` to name its queue`,
    )
  }
  return queueDirectory(await hostWorkdir(cwd, env, git), await originQueueAddress(git, recorded.slice(prefix.length)))
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
    address = await originQueueAddress(git, value ?? (await originHead(git)))
  } else {
    if (value === undefined || !addressed) {
      throw new Error(
        `queue command at ${cwd} needs a repository; run inside a clone or pass --queue <repo>#<queue>, for example --queue beorn/hh#main`,
      )
    }
    let selected = value
    if (!selected.includes("#")) selected = `${selected}#${await remoteHead(git, selected)}`
    const split = selected.indexOf("#")
    const repository = selected.slice(0, split)
    if (inside !== undefined && (await git(["remote"])).trim().split("\n").includes(repository)) {
      selected = queueName({ branch: selected.slice(split + 1), remote: repository }, await remoteUrl(git, repository))
    }
    address = parseQueueAddress(selected)
  }
  const host = await hostWorkdir(cwd, env, git)
  const workdir = queueRoot(host, address)
  if (context !== "queue" && inside !== undefined) {
    return {
      address,
      selection,
      owned: false,
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
    owned: true,
    queue: address.queue,
    referenceStores: owned.referenceStores,
    repo: owned.repo,
    workdir,
  }
}
