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
import { setTimeout as sleep } from "node:timers/promises"
import { type FlockHandle, tryAcquireFlock } from "@bearly/flock"
import type { Git } from "./git.ts"
import { declaredSubmodules, gitlinksAt, holdsCommit } from "./reference.ts"
import { transportFaultIn } from "./setup-transport.ts"

/** The file inside a mirror holding the ISO instant its last refresh completed. */
export const MIRROR_REFRESHED_AT = "yrd-refreshed-at"

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

export type MirrorStamp = Readonly<{ at: Date; remote: string; refspecs: readonly string[] }>

export type RefreshMirrorOptions = Readonly<
  {
    url: string
    /** One Git bound to a directory, as the caller instruments it (reference.ts takes the same). */
    gitIn: (cwd: string) => Git
    /** Skip the remote when the last refresh is younger than this. Absent: always refresh. */
    maxAgeMs?: number
    lockWaitMs?: number
    /** Exact refs the display reads. An owned queue clone supplies these. */
    refspecs?: readonly string[]
  } & ({ root: string; path?: never } | { path: string; root?: never })
>

const MIRROR_REFSPECS = ["+refs/*:refs/*"] as const

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

/** The last completed, scoped refresh. An older instant alone certifies no ref set. */
function readMirrorStamp(path: string): MirrorStamp | undefined {
  const stamp = join(path, MIRROR_REFRESHED_AT)
  if (!existsSync(stamp)) return undefined
  const raw = readFileSync(stamp, "utf8").trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${stamp} has no complete remote/refspec freshness record`, { cause: error })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${stamp} has no complete remote/refspec freshness record`)
  }
  const record = parsed as Record<string, unknown>
  const at = new Date(typeof record.at === "string" ? record.at : "")
  if (
    Number.isNaN(at.getTime()) ||
    at.getTime() > Date.now() + 5_000 ||
    typeof record.remote !== "string" ||
    record.remote === "" ||
    !Array.isArray(record.refspecs) ||
    record.refspecs.length === 0 ||
    !record.refspecs.every((ref) => typeof ref === "string" && ref !== "")
  ) {
    throw new Error(`${stamp} has no complete remote/refspec freshness record`)
  }
  return { at, remote: record.remote, refspecs: record.refspecs as string[] }
}

/** The last completed refresh instant; kept as a Date for existing callers. */
export function mirrorRefreshedAt(path: string): Date | undefined {
  const stamp = join(path, MIRROR_REFRESHED_AT)
  if (!existsSync(stamp)) return undefined
  const raw = readFileSync(stamp, "utf8").trim()
  const legacy = new Date(raw)
  if (!Number.isNaN(legacy.getTime())) return legacy
  return readMirrorStamp(path)?.at
}

function recordedScope(path: string, legacyMayRefresh: boolean): MirrorStamp | undefined {
  if (mirrorRefreshedAt(path) === undefined) return undefined
  try {
    return readMirrorStamp(path)
  } catch (error) {
    if (legacyMayRefresh && existsSync(join(path, MIRROR_REFRESHED_AT))) {
      const raw = readFileSync(join(path, MIRROR_REFRESHED_AT), "utf8").trim()
      if (!Number.isNaN(new Date(raw).getTime())) return undefined
    }
    throw error
  }
}

function covers(stamp: MirrorStamp | undefined, remote: string, refspecs: readonly string[]): stamp is MirrorStamp {
  return (
    stamp !== undefined &&
    stamp.remote === remote &&
    refspecs.every((ref) => stamp.refspecs.includes(ref) || stamp.refspecs.includes("+refs/*:refs/*"))
  )
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
  const location = options.path === undefined ? mirrorLocation(options.root, options.url) : undefined
  if (options.path === undefined && location === undefined) {
    throw new MirrorUnavailable(options.url, undefined, `${options.url} names no hosted repository`)
  }
  const path = options.path ?? (location as MirrorLocation).path
  if (options.path !== undefined && !existsSync(path)) {
    throw new MirrorUnavailable(options.url, path, "the selected queue store is absent")
  }
  const remote = "origin"
  const refspecs = options.refspecs ?? MIRROR_REFSPECS
  const asked = new Date()
  const result = async (outcome: MirrorRefresh["outcome"], refreshedAt: Date): Promise<MirrorRefresh> => ({
    url: options.url,
    path,
    outcome,
    ms: Date.now() - started,
    bytes: await storeBytes(options.gitIn(path)),
    refreshedAt,
  })
  const before = recordedScope(path, options.path === undefined)
  if (options.path !== undefined && before !== undefined && !covers(before, remote, refspecs)) {
    throw new MirrorUnavailable(
      options.url,
      path,
      `${join(path, MIRROR_REFRESHED_AT)} does not cover the requested remote and refs`,
    )
  }
  if (
    options.maxAgeMs !== undefined &&
    covers(before, remote, refspecs) &&
    asked.getTime() - before.at.getTime() < options.maxAgeMs
  ) {
    return result("fresh", before.at)
  }
  using _lock = await lockMirror(options.url, path, options.lockWaitMs ?? MIRROR_LOCK_WAIT_MS)
  const meanwhile = recordedScope(path, options.path === undefined)
  if (options.path !== undefined && meanwhile !== undefined && !covers(meanwhile, remote, refspecs)) {
    throw new MirrorUnavailable(
      options.url,
      path,
      `${join(path, MIRROR_REFRESHED_AT)} does not cover the requested remote and refs`,
    )
  }
  if (covers(meanwhile, remote, refspecs) && meanwhile.at.getTime() >= asked.getTime()) {
    return await result("coalesced", meanwhile.at)
  }
  const outcome = existsSync(path) ? await fetchMirror(options, path) : await createMirror(options, path)
  const refreshedAt = new Date()
  const stamp = join(path, MIRROR_REFRESHED_AT)
  writeFileSync(`${stamp}.tmp`, `${JSON.stringify({ at: refreshedAt.toISOString(), remote, refspecs })}\n`)
  renameSync(`${stamp}.tmp`, stamp)
  return await result(outcome, refreshedAt)
}

/**
 * A queue writer invalidates the local status view after publishing remote refs.
 * Use the refresh lock so an in-flight fetch cannot publish a fresh stamp after
 * this unlink. An absent store has no cached view and its first reader creates it.
 */
export async function invalidateMirrorStamp(path: string, url: string): Promise<void> {
  if (!existsSync(path)) return
  try {
    using _lock = await lockMirror(url, path, MIRROR_LOCK_WAIT_MS)
    rmSync(join(path, MIRROR_REFRESHED_AT), { force: true })
  } catch (error) {
    throw new MirrorUnavailable(
      url,
      path,
      `status stamp could not be invalidated: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
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
    if (options.path !== undefined) {
      const git = options.gitIn(path)
      const bare = (await git(["rev-parse", "--is-bare-repository"])).trim() === "true"
      if (!bare && (await git(["ls-files", "--stage"])).trim() !== "") {
        throw new Error(`${path} has an index with checked-out files; scoped refresh cannot update its HEAD branch`)
      }
    }
    await options.gitIn(path)([
      "fetch",
      "--prune",
      "--quiet",
      ...(options.path === undefined ? [] : ["--update-head-ok"]),
      "origin",
      ...(options.refspecs ?? []),
    ])
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

export type RefreshDeclaredOptions = Readonly<{
  root: string
  gitIn: (cwd: string) => Git
  maxAgeMs?: number
  lockWaitMs?: number
  /** The repository whose declarations are read. */
  repo: string
  /** The commit whose `.gitmodules` is read; nested levels are read at their gitlinks, inside their mirrors. */
  commit?: string
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
  const levels: Array<Readonly<{ git: Git; commit: string; prefix: string }>> = [
    { git: options.gitIn(options.repo), commit: options.commit ?? "HEAD", prefix: "" },
  ]
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
