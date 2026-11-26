import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { shellQuote } from "git-super/shell-command"
import { dirname, join, resolve } from "node:path"
import {
  configValue,
  gitIn,
  populateReferenceStores,
  queueName,
  remoteHead,
  remoteUrl,
  resolveGitSelection,
  type Git,
  type GitSelection,
  type ReferenceStore,
  type YrdQueueRunnerDeclaration,
} from "@yrd/queue-core"
import {
  hasHumanQueueBranch,
  legacyQueueDirectory,
  legacyQueueRoot,
  parseQueueAddress,
  queueDirectory,
  queueRoot,
  type QueueAddress,
} from "./address.ts"
import { repositoryHere, unaddressedRepository } from "./declaration.ts"
import { mainCheckoutOf, outermostRepository } from "./main-checkout.ts"

/**
 * A cold component store: a bare Git directory kept for custody (a retained module
 * store), never a checkout. A drop aimed here must retire the store's own branch;
 * resolving a queue from it would look in the shared root instead (30094).
 */
export function retainedComponentStoreHere(path: string): string | undefined {
  const root = resolve(path)
  if (existsSync(join(root, ".git"))) return undefined
  if (!existsSync(join(root, "HEAD")) || !existsSync(join(root, "objects"))) return undefined
  if (!existsSync(join(root, "refs"))) return undefined
  return root
}

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

type DeclaredQueue = Pick<YrdQueueRunnerDeclaration, "serviceName" | "repository" | "queue">

export type DeclaredQueueLocation =
  | Readonly<{ kind: "resolved"; declaration: DeclaredQueue; location: QueueLocation }>
  | Readonly<{ kind: "unreadable"; declaration: DeclaredQueue; error: Error }>

/** Resolve the same queue set the Yrd runner declaration serves, retaining each failed read by name. */
export async function resolveDeclaredQueueLocations(
  cwd: string,
  declarations: readonly DeclaredQueue[],
  env: NodeJS.ProcessEnv,
): Promise<readonly DeclaredQueueLocation[]> {
  const base = unaddressedRepository(cwd) ?? resolve(cwd)
  const locations: DeclaredQueueLocation[] = []
  for (const declaration of declarations) {
    try {
      const path = resolve(base, declaration.repository.path)
      const repository = repositoryHere(path)
      if (repository !== path) {
        throw new Error(
          repository === undefined
            ? `declared repository ${path} is not a Git repository`
            : `declared repository ${path} is inside ${repository}; name its root`,
        )
      }
      locations.push({
        kind: "resolved",
        declaration,
        location: await resolveQueueLocation(
          path,
          (
            await originQueueAddress(
              gitIn(path, undefined, await resolveGitSelection(path, { env }), { env }),
              declaration.queue.base,
            )
          ).canonical,
          env,
          "queue",
        ),
      })
    } catch (error: unknown) {
      locations.push({
        kind: "unreadable",
        declaration,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }
  return locations
}

/**
 * The remote's default branch. A clone records it as refs/remotes/<remote>/HEAD (git clone, or
 * `git remote set-head <remote> -a` after the remote changes it), so it is read locally: `yrd queue
 * health` resolves it on every tick, and asking the remote each time was 156 GitHub sessions an hour
 * (hh 25626). Only a clone that recorded none asks the remote, and that failure stays loud.
 */
export async function originHead(git: Git, remote = "origin", offline = false): Promise<string> {
  const recorded = (await git(["for-each-ref", "--format=%(symref)", `refs/remotes/${remote}/HEAD`])).trim()
  const prefix = `refs/remotes/${remote}/`
  if (recorded.startsWith(prefix) && recorded.length > prefix.length) return recorded.slice(prefix.length)
  if (offline) {
    throw new Error(
      `this clone records no refs/remotes/${remote}/HEAD and queue health reads no network; ` +
        `run \`git remote set-head ${remote} --auto\` or pass --queue <repo>@<branch>`,
    )
  }
  return remoteHead(git, remote)
}

/**
 * Where the queue workdir root came from, said for a reader: a probe that finds nothing must name the root it looked
 * in and why that root, or a third copy of the state answers "stopped" quietly (hh 38659).
 */
export type WorkdirResolution = Readonly<{
  root: string
  kind: "YRD_WORKDIR" | "yrd.workdir" | "own-repository" | "default"
  /** e.g. `YRD_WORKDIR`, `yrd.workdir`, `yrd.workdir (yrd's own repository /hh/dev)`, `default ($XDG_STATE_HOME/yrd)`. */
  source: string
  /** What each arm consulted before the answering one found, in order: the declared roots that were looked for. */
  tried: readonly string[]
}>

/** The directory the running Yrd ships from: this module's real path, a node_modules symlink resolved. */
export function yrdOwnLocation(): string {
  return dirname(realpathSync(fileURLToPath(import.meta.url)))
}

/**
 * The MAIN checkout of the repository the running Yrd ships in, or why there is none.
 *
 * Yrd usually ships as a submodule (`<host>/vendor/yrd`), so the outermost repository holding it is the host, and the
 * host's main checkout is the one that declares its `yrd.workdir`. Both rules live once, in main-checkout.ts, which
 * the host launcher imports too (@cto 1444899a D2).
 */
function ownRepository(location: string): Readonly<{ repository: string } | { none: string }> {
  if (!existsSync(location)) return { none: `${location} does not exist` }
  if (repositoryHere(location) === undefined) return { none: `${location} is in no repository` }
  return { repository: mainCheckoutOf(outermostRepository(location)) }
}

/**
 * ONE root resolution (hh 38659, @cto 23049856): `YRD_WORKDIR`, then `yrd.workdir` as the caller's repository reads it
 * (every scope git reads), then the `yrd.workdir` the repository Yrd ships in declares, then `$XDG_STATE_HOME/yrd`.
 * The third arm is what the host launcher used to inject; here it reaches the bare `node_modules/.bin/yrd` entry too.
 *
 * `ownLocation` is where Yrd ships from — this module, unless a test passes a fixture repository; it is a parameter,
 * never a setting (@cto 1444899a D1). A test that must not inherit its host's declared root sets `YRD_WORKDIR`.
 */
async function resolveHostWorkdir(
  cwd: string,
  env: NodeJS.ProcessEnv,
  git: Git,
  ownLocation: string = yrdOwnLocation(),
): Promise<WorkdirResolution> {
  const override = env.YRD_WORKDIR
  if (override !== undefined) {
    if (override.trim() === "") throw new Error("YRD_WORKDIR must name a directory")
    return { root: resolve(cwd, override), kind: "YRD_WORKDIR", source: "YRD_WORKDIR", tried: [] }
  }
  const tried = ["YRD_WORKDIR unset"]
  const caller = repositoryHere(cwd) ?? cwd
  const declared = await configValue(git, "yrd.workdir")
  if (declared !== undefined) {
    return { root: resolve(caller, declared), kind: "yrd.workdir", source: "yrd.workdir", tried }
  }
  tried.push(`git config yrd.workdir unset at ${caller}`)
  const own = ownRepository(ownLocation)
  if ("repository" in own) {
    const ownGit = gitIn(own.repository, undefined, await resolveGitSelection(own.repository, { env }), { env })
    const inherited = await configValue(ownGit, "yrd.workdir")
    if (inherited !== undefined) {
      return {
        root: resolve(own.repository, inherited),
        kind: "own-repository",
        source: `yrd.workdir (yrd's own repository ${own.repository})`,
        tried,
      }
    }
    tried.push(`git config yrd.workdir unset in yrd's own repository ${own.repository}`)
  } else {
    tried.push(`yrd's own repository: none, ${own.none}`)
  }
  const state = env.XDG_STATE_HOME
  return {
    root: join(state ?? join(env.HOME ?? homedir(), ".local", "state"), "yrd"),
    kind: "default",
    source: state === undefined ? "default (~/.local/state/yrd)" : "default ($XDG_STATE_HOME/yrd)",
    tried,
  }
}

export async function hostWorkdir(
  cwd: string,
  env: NodeJS.ProcessEnv,
  git: Git,
  ownLocation?: string,
): Promise<string> {
  return (await resolveHostWorkdir(cwd, env, git, ownLocation)).root
}

/**
 * The host workdir for a caller that holds no Git of its own: resolve one for `cwd` and pass it, so a
 * DECLARED `yrd.workdir` is read from every scope git reads.
 *
 * `hostWorkdir` reads `yrd.workdir` only from a supplied Git, so a caller that omits one silently takes the
 * `$XDG_STATE_HOME/yrd` fallback — which, on a host that declares its own workdir, is not where its queues
 * live. `yrd queue retire-root` did exactly that and refused its own live root by name on this host (28601):
 * the verb was unusable, and no cwd or environment reached the declared root.
 *
 * ONE resolution, inside a repository or outside it: git reads a LOCAL config only inside one, but a GLOBAL
 * or SYSTEM `yrd.workdir` outside it — exactly as `resolveQueueLocation` resolves its own Git (queue-location
 * :253) before any inside-repository check. The XDG fallback is right only when NO scope declares the key,
 * never because the caller happened to stand outside a repository (@cto 044d3ffd change 1).
 */
export async function hostWorkdirHere(cwd: string, env: NodeJS.ProcessEnv, ownLocation?: string): Promise<string> {
  const git = gitIn(repositoryHere(cwd) ?? cwd, undefined, await resolveGitSelection(cwd, { env }), { env })
  return hostWorkdir(cwd, env, git, ownLocation)
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
    // 27065: a legacy percent-escaped root beside an absent tilde root is a stopped-line cutover, never a
    // silent second tree. Creating the new root here would leave two live queues for one address.
    const legacy = legacyQueueDirectory(root, address)
    if (existsSync(legacy)) {
      throw new Error(
        `queue root ${repo} is absent but the legacy ${legacy} exists; refusing to create a second queue root. ` +
          `Move ${legacyQueueRoot(root, address)} to ${queueRoot(root, address)} in one stopped-line cutover (27065), ` +
          `then retry ${address.canonical}`,
      )
    }
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
  const inside = unaddressedRepository(cwd)
  if (inside === undefined) throw new Error(`${cwd} is not inside a repository, so the queue it serves has no name`)
  const selection = await resolveGitSelection(cwd, { env })
  const git = gitIn(inside, undefined, selection, { env })
  const recorded = (await git(["for-each-ref", "--format=%(symref)", "refs/remotes/origin/HEAD"])).trim()
  const prefix = "refs/remotes/origin/"
  if (!recorded.startsWith(prefix) || recorded.length === prefix.length) {
    throw new Error(
      `${inside} records no refs/remotes/origin/HEAD; run \`git -C ${shellQuote(inside)} remote set-head ${shellQuote("origin")} --auto\` to name its queue`,
    )
  }
  return queueDirectory(await hostWorkdir(cwd, env, git), await originQueueAddress(git, recorded.slice(prefix.length)))
}

type ResolvedAddress = Readonly<{
  inside: string | undefined
  addressed: boolean
  selection: GitSelection
  git: Git
  address: QueueAddress
}>

/**
 * The queue a selector names, before anything is cloned. `offline` is `yrd queue health`'s contract — it reads a file
 * and nothing else — so a selector that could only be completed by asking a remote is refused by name instead.
 */
async function resolveQueueAddress(
  cwd: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  context: "queue" | "reader" | "submit",
  offline: boolean,
): Promise<ResolvedAddress> {
  const addressed =
    value !== undefined &&
    (value.includes("#") ||
      hasHumanQueueBranch(value) ||
      value.startsWith("/") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value))
  const inside = addressed ? repositoryHere(cwd) : unaddressedRepository(cwd)
  if (inside === undefined && context !== "queue") {
    throw new Error(
      `${context === "submit" ? "submit" : "queue list/show/watch"} at ${cwd} needs a repository; run inside a clone${context === "submit" ? " containing the branch to submit" : " or the queue-owned clone"}`,
    )
  }
  const selection = await resolveGitSelection(cwd, { env })
  const git = gitIn(inside ?? cwd, undefined, selection, { env })
  let address: QueueAddress
  if (inside !== undefined && !addressed) {
    address = await originQueueAddress(git, value ?? (await originHead(git, "origin", offline)))
  } else {
    if (value === undefined || !addressed) {
      throw new Error(
        `queue command at ${cwd} needs a repository; run inside a clone or pass --queue <repo>@<branch>, for example --queue beorn/hh@main`,
      )
    }
    let selected = value
    if (!selected.includes("#") && !hasHumanQueueBranch(selected)) {
      if (offline) {
        throw new Error(
          `queue health reads no network, so it cannot ask ${selected} for its default branch; ` +
            `name the branch: --queue ${selected}@<branch>`,
        )
      }
      selected = `${selected}#${await remoteHead(git, selected)}`
    }
    const split = selected.indexOf("#")
    const repository = split < 0 ? undefined : selected.slice(0, split)
    if (
      repository !== undefined &&
      inside !== undefined &&
      (await git(["remote"])).trim().split("\n").includes(repository)
    ) {
      selected = queueName({ branch: selected.slice(split + 1), remote: repository }, await remoteUrl(git, repository))
    }
    address = parseQueueAddress(selected)
  }
  return { inside, addressed, selection, git, address }
}

/**
 * The queue root a selector names, and how its host root was chosen — computed, never created: no clone, no fetch, no
 * remote. `yrd queue health` reads its document here; an address whose root does not exist is the probe's answer to
 * report, not a clone to make (hh 38659).
 */
export async function resolveQueueWorkdir(
  cwd: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  ownLocation?: string,
): Promise<Readonly<{ workdir: string; resolution: WorkdirResolution }>> {
  const { git, address } = await resolveQueueAddress(cwd, value, env, "queue", true)
  const resolution = await resolveHostWorkdir(cwd, env, git, ownLocation)
  return { workdir: queueRoot(resolution.root, address), resolution }
}

/** Resolve the one queue selector; only submission retains the author's checkout. */
export async function resolveQueueLocation(
  cwd: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  context: "queue" | "reader" | "submit" = "queue",
  reportWorkdir?: (workdir: string, resolution: WorkdirResolution) => void,
  ownLocation?: string,
): Promise<QueueLocation> {
  const { inside, addressed, selection, git, address } = await resolveQueueAddress(cwd, value, env, context, false)
  const resolution = await resolveHostWorkdir(cwd, env, git, ownLocation)
  const host = resolution.root
  const workdir = queueRoot(host, address)
  reportWorkdir?.(workdir, resolution)
  if (inside !== undefined && (context === "submit" || (context === "reader" && !addressed))) {
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
