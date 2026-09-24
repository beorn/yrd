/**
 * The host's local copy of each hosted repository, read by composes instead of GitHub.
 *
 * MEASURED 2026-09-24 (25570). One submit opened 45 ssh children and a merging
 * round 33 to 107, almost all of them compose fetches of the same fifteen
 * component repositories, and the host's publickey refusals followed the same
 * curve. One `fetch --prune` per repository per round brings everything those
 * reads ask for; the compose environment then routes its reads here (@cto
 * ruling 59d6b6e3, slice 2) and the decisive reads keep asking GitHub.
 *
 * THE LAYOUT IS A CONTRACT. `<store>/<host>/<owner>/<repo>.git`, a plain
 * `clone --mirror`, refreshed by a plain `fetch --prune`, with the instant of
 * the last successful refresh in {@link MIRROR_REFRESHED_AT}. 25567's host
 * service takes over the refresh of the same store, so nothing here may depend
 * on yrd having written it.
 *
 * ONE WRITER AT A TIME, NO READER LOCK. Create and refresh hold an exclusive
 * kernel flock on `<repo>.git.lock`. A reader needs none: every ref update is
 * atomic, and the only thing that deletes objects is gc, which is switched off
 * in every mirror (`gc.auto=0`). The store therefore only grows; its size is
 * reported on every refresh, and gc under the same lock is 25567's.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { type FlockHandle, tryAcquireFlock } from "@bearly/flock"
import type { Git } from "./git.ts"
import { declaredSubmodules, gitlinksAt, holdsCommit } from "./reference.ts"
import { transportFaultIn } from "./setup-transport.ts"

/** The file inside a mirror holding the ISO instant its last refresh completed. */
export const MIRROR_REFRESHED_AT = "yrd-refreshed-at"

/** The git setting naming the host's store root; host configuration, like `yrd.workdir`, with no default. */
export const MIRROR_STORE_SETTING = "yrd.mirror"

/** A compose outside a round refreshes a mirror older than this first (@cto 59d6b6e3). */
export const MIRROR_WINDOW_MS = 10 * 60_000

/** How long a refresh waits for another writer of the same mirror before refusing. */
export const MIRROR_LOCK_WAIT_MS = 5 * 60_000

const LOCK_POLL_MS = 100

/** Where one hosted repository's mirror lives. */
export type MirrorLocation = Readonly<{ host: string; owner: string; repo: string; path: string }>

/** What one refresh did. */
export type MirrorRefresh = Readonly<{
  url: string
  path: string
  /**
   * `created` cloned it; `fetched` refreshed it; `coalesced` found a refresh that
   * completed after this one was asked for; `fresh` found it younger than the
   * window it was asked for. Only the first two contacted the remote.
   */
  outcome: "created" | "fetched" | "coalesced" | "fresh"
  /** Wall time of this call, lock wait included. */
  ms: number
  /** Loose objects plus packs, from `count-objects -v`; the alarm while gc is off. */
  bytes: number
  refreshedAt: Date
}>

export type RefreshMirrorOptions = Readonly<{
  /** The store root; the mirror is at {@link mirrorLocation}'s path under it. */
  root: string
  url: string
  /** One Git bound to a directory, as the caller instruments it (reference.ts takes the same). */
  gitIn: (cwd: string) => Git
  /** Skip the remote when the last refresh is younger than this. Absent: always refresh. */
  maxAgeMs?: number
  lockWaitMs?: number
}>

/** A mirror that could not be created, refreshed or locked; the message names which and why. */
export class MirrorUnavailable extends Error {
  constructor(
    readonly url: string,
    readonly path: string | undefined,
    readonly reason: string,
  ) {
    super(`mirror of ${url}${path === undefined ? "" : ` at ${path}`} is unavailable: ${reason}`)
    this.name = "MirrorUnavailable"
  }
}

const SCP_FORM = /^[^@/\s]+@([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u
const URL_FORM = /^(?:ssh|https?|git):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u

/**
 * The mirror a hosted URL maps to, or undefined when the URL names no hosted
 * repository: a local path, a `file://` URL or a relative submodule URL has no
 * host to be the local copy of.
 */
export function mirrorLocation(root: string, url: string): MirrorLocation | undefined {
  const match = SCP_FORM.exec(url) ?? URL_FORM.exec(url)
  const host = match?.[1]
  const owner = match?.[2]
  const repo = match?.[3]
  if (host === undefined || owner === undefined || repo === undefined) return undefined
  return { host, owner, repo, path: join(root, host, owner, `${repo}.git`) }
}

/** The last completed refresh of the mirror at `path`, or undefined when it has none. */
export function mirrorRefreshedAt(path: string): Date | undefined {
  const stamp = join(path, MIRROR_REFRESHED_AT)
  if (!existsSync(stamp)) return undefined
  const read = new Date(readFileSync(stamp, "utf8").trim())
  if (Number.isNaN(read.getTime())) throw new Error(`${stamp} holds no instant`)
  return read
}

/**
 * Create the mirror when absent, else fetch it, under its exclusive lock.
 *
 * A refresh waiting on another writer re-reads the stamp once it holds the
 * lock: if that writer finished after this call was made, everything this call
 * would have fetched is already there, and fetching again is a second login
 * for nothing (W3).
 */
export async function refreshMirror(options: RefreshMirrorOptions): Promise<MirrorRefresh> {
  const started = Date.now()
  const location = mirrorLocation(options.root, options.url)
  if (location === undefined) {
    throw new MirrorUnavailable(options.url, undefined, `${options.url} names no hosted repository`)
  }
  const { path } = location
  const asked = new Date()
  const result = async (outcome: MirrorRefresh["outcome"], refreshedAt: Date): Promise<MirrorRefresh> => ({
    url: options.url,
    path,
    outcome,
    ms: Date.now() - started,
    bytes: await storeBytes(options.gitIn(path)),
    refreshedAt,
  })
  const before = mirrorRefreshedAt(path)
  if (options.maxAgeMs !== undefined && before !== undefined && asked.getTime() - before.getTime() < options.maxAgeMs) {
    return result("fresh", before)
  }
  using _lock = await lockMirror(options.url, path, options.lockWaitMs ?? MIRROR_LOCK_WAIT_MS)
  const meanwhile = mirrorRefreshedAt(path)
  if (meanwhile !== undefined && meanwhile.getTime() >= asked.getTime()) return await result("coalesced", meanwhile)
  // Taken BEFORE the remote is contacted, so the stamp promises only what it can: every ref the remote held
  // at this instant is here. Stamped after the fetch, a coalescing caller could accept a refresh whose
  // advertisement predates its own ask and miss a push that landed in between (review-adhoc5, P3 on 2d36b8bbde).
  const refreshedAt = new Date()
  const outcome = existsSync(path) ? await fetchMirror(options, path) : await createMirror(options, path)
  const stamp = join(path, MIRROR_REFRESHED_AT)
  writeFileSync(`${stamp}.tmp`, `${refreshedAt.toISOString()}\n`)
  renameSync(`${stamp}.tmp`, stamp)
  return await result(outcome, refreshedAt)
}

async function lockMirror(url: string, path: string, waitMs: number): Promise<FlockHandle> {
  const lock = `${path}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    const handle = tryAcquireFlock(lock, {
      createParent: true,
      body: `${process.pid} ${new Date().toISOString()}\n`,
    })
    if (handle !== null) return handle
    if (Date.now() >= deadline) {
      throw new MirrorUnavailable(url, path, `the lock ${lock} was held past ${waitMs}ms (holder: ${lockHolder(lock)})`)
    }
    await sleep(LOCK_POLL_MS)
  }
}

function lockHolder(lock: string): string {
  try {
    return readFileSync(lock, "utf8").trim() || "no body written"
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Cloned beside its final path and renamed into place, so a failed or killed
 * clone never leaves a directory that the next refresh would take for a mirror.
 */
async function createMirror(options: RefreshMirrorOptions, path: string): Promise<"created"> {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const partial = `${path}.partial-${process.pid}`
  rmSync(partial, { force: true, recursive: true })
  try {
    await options.gitIn(parent)(["clone", "--mirror", "--quiet", options.url, partial])
    await options.gitIn(partial)(["config", "gc.auto", "0"])
  } catch (error) {
    rmSync(partial, { force: true, recursive: true })
    throw new MirrorUnavailable(options.url, path, remoteFailure("cloning", error))
  }
  renameSync(partial, path)
  return "created"
}

async function fetchMirror(options: RefreshMirrorOptions, path: string): Promise<"fetched"> {
  try {
    await options.gitIn(path)(["fetch", "--prune", "--quiet", "origin"])
  } catch (error) {
    throw new MirrorUnavailable(options.url, path, remoteFailure("fetching", error))
  }
  return "fetched"
}

function remoteFailure(verb: string, error: unknown): string {
  const why = error instanceof Error ? error.message : String(error)
  const fault = transportFaultIn(why)
  return fault === undefined
    ? `${verb} failed: ${why}`
    : `${verb} could not reach the remote (${fault.signature}): ${why}`
}

async function storeBytes(git: Git): Promise<number> {
  const counted = await git(["count-objects", "-v"])
  let kib = 0
  for (const row of counted.split("\n")) {
    const match = /^(size|size-pack|size-garbage): (\d+)$/u.exec(row.trim())
    if (match?.[2] !== undefined) kib += Number(match[2])
  }
  return kib * 1024
}

/** One declared submodule whose mirror was not refreshed or whose own declarations were not read. */
export type MirrorSkip = Readonly<{ path: string; url: string; reason: string }>

export type RefreshDeclaredOptions = Omit<RefreshMirrorOptions, "url"> &
  Readonly<{
    /** The repository whose declarations are read. */
    repo: string
    /**
     * The commits whose `.gitmodules` are read; nested levels are read at their
     * gitlinks, inside their mirrors. A round passes its target and every
     * candidate head, because a candidate that adds a submodule declares it at
     * its own commit and nowhere else.
     */
    commits: readonly string[]
  }>

/**
 * Refresh the mirror of every hosted repository `commit` declares, at every
 * nesting level, each repository once however many paths declare it.
 *
 * A nested level is read from the mirror just refreshed, at the gitlink its
 * parent records. When that commit is not there — a pin nobody pushed — the
 * level is named in `skipped` rather than read at some other commit, because a
 * guessed `.gitmodules` could name repositories the pin does not.
 */
export async function refreshDeclaredMirrors(
  options: RefreshDeclaredOptions,
): Promise<Readonly<{ refreshed: readonly MirrorRefresh[]; skipped: readonly MirrorSkip[] }>> {
  const refreshed = new Map<string, MirrorRefresh>()
  const skipped: MirrorSkip[] = []
  const root = options.gitIn(options.repo)
  const levels: Array<Readonly<{ git: Git; commit: string; prefix: string }>> = options.commits.map((commit) => ({
    git: root,
    commit,
    prefix: "",
  }))
  while (levels.length > 0) {
    const level = levels.shift()
    if (level === undefined) break
    const urls = await declaredSubmodules(level.git, level.commit)
    if (urls.size === 0) continue
    for (const { path, sha } of await gitlinksAt(level.git, level.commit, [...urls.keys()])) {
      const named = level.prefix === "" ? path : join(level.prefix, path)
      const url = urls.get(path)
      if (url === undefined) throw new Error(`${level.commit}:.gitmodules declares no url for ${named}`)
      const location = mirrorLocation(options.root, url)
      if (location === undefined) {
        skipped.push({ path: named, url, reason: `${url} names no hosted repository` })
        continue
      }
      if (!refreshed.has(location.path)) {
        refreshed.set(
          location.path,
          await refreshMirror({
            root: options.root,
            url,
            gitIn: options.gitIn,
            ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
            ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
          }),
        )
      }
      const mirror = options.gitIn(location.path)
      if (!(await holdsCommit(mirror, sha))) {
        skipped.push({
          path: named,
          url,
          reason: `the mirror holds no ${sha}, so the submodules it declares were not read`,
        })
        continue
      }
      levels.push({ git: mirror, commit: sha, prefix: named })
    }
  }
  return { refreshed: [...refreshed.values()], skipped }
}

/**
 * `env` with the compose's reads routed to the store: for each owner prefix a
 * mirrored URL was declared under (`git@github.com:beorn/`), one `insteadOf`
 * to that owner's directory in the store and one identity `pushInsteadOf`, so
 * a push from inside a compose (git-super's retention push) still goes to the
 * hosted URL (W1). Only COMPOSE environments get this; the queue's own Git, and
 * with it every decisive read and lease, never does (W2).
 *
 * The prefixes come from the URLs the repository actually declares, so the
 * rule matches exactly the spellings a compose will fetch. git-super's own
 * per-command borrow rules name whole URLs and are longer, so they still win.
 * With nothing mirrored the environment is returned unchanged.
 */
export function composeEnvironment(
  env: NodeJS.ProcessEnv,
  root: string,
  mirrors: readonly MirrorRefresh[],
): NodeJS.ProcessEnv {
  const routes = new Map<string, string>()
  for (const mirror of mirrors) {
    const location = mirrorLocation(root, mirror.url)
    if (location === undefined) throw new Error(`${mirror.url} was mirrored but names no hosted repository`)
    const repo = /[^/:]+?(?:\.git)?\/?$/u.exec(mirror.url)
    if (repo === null) throw new Error(`${mirror.url} has no repository segment to route`)
    routes.set(mirror.url.slice(0, repo.index), `${pathToFileURL(dirname(location.path)).href}/`)
  }
  if (routes.size === 0) return env
  const declared = Number(env.GIT_CONFIG_COUNT ?? "0")
  let count = Number.isInteger(declared) && declared >= 0 ? declared : 0
  const next: Record<string, string> = {}
  const add = (key: string, value: string): void => {
    next[`GIT_CONFIG_KEY_${String(count)}`] = key
    next[`GIT_CONFIG_VALUE_${String(count)}`] = value
    count += 1
  }
  add("protocol.file.allow", "always")
  for (const [prefix, store] of routes) {
    add(`url.${store}.insteadOf`, prefix)
    add(`url.${prefix}.pushInsteadOf`, prefix)
  }
  return { ...env, ...next, GIT_CONFIG_COUNT: String(count) }
}
