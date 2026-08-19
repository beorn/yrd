import { homedir } from "node:os"

/**
 * The three-tier queue naming model (operator rulings 2026-08-18, items
 * 30a/32a/33/34/36 of the watch redesign):
 *
 * - FULLY QUALIFIED NAME — `path@branch`, the canonical identity and address
 *   (`/hh@main`, `/hh/pm@main`). Unique by construction: queue identity IS the
 *   pair (repository path, base branch), because the merge step writes exactly
 *   one ref and a serialization domain can never be wider than what it writes.
 * - LABEL — the short config handle (`code`, `pm`), unique per config, shown
 *   on the surfaces. Run names lead with it: `code#23423`.
 * - PRETTY NAME — `path ⎇ branch`, the FQN's display rendering: user-friendly
 *   path plus the branch glyph the per-change box headers already use.
 *
 * Digits are unstable filter accelerators and never appear in names (item 34,
 * killing item 11's `1:main#23423` prefix form).
 */

/** The branch glyph the pretty name and the queue pills use (items 32d/5:
 * real glyphs, the same ⎇ idiom as `pr#id ⎇ branch`). */
export const QUEUE_BRANCH_GLYPH = "⎇"

/**
 * ONE user-friendly path formatter for every surface that prints a repository
 * path (items 30a/33): home-relative with `~` where applicable, the way a
 * shell prompt would print it. `/hh` stays `/hh`; a repository under $HOME
 * reads `~/repo`, never the expanded absolute. Non-absolute input passes
 * through untouched — it is already a display form, not an authority.
 */
export function friendlyRepositoryPath(path: string, home: string = homedir()): string {
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
  const homeNormalized = home.length > 1 && home.endsWith("/") ? home.slice(0, -1) : home
  if (homeNormalized === "" || homeNormalized === "/") return normalized
  if (normalized === homeNormalized) return "~"
  if (normalized.startsWith(`${homeNormalized}/`)) return `~${normalized.slice(homeNormalized.length)}`
  return normalized
}

/**
 * Shortest unique friendly path per queue (item 32b: `/hh/pm` renders as its
 * unique suffix `pm` when nothing else ends in `pm`). Uniqueness is judged
 * across the whole set, so two repositories sharing a basename both keep one
 * more leading segment instead of colliding on it. Single-segment results
 * drop the leading slash (`pm`, not `/pm`); a path whose shortening IS the
 * full path keeps its friendly form.
 */
export function shortUniqueQueuePaths(paths: readonly string[], home: string = homedir()): ReadonlyMap<string, string> {
  const friendly = new Map(paths.map((path) => [path, friendlyRepositoryPath(path, home)] as const))
  const suffixes = (path: string): string[] => {
    const value = friendly.get(path) ?? path
    const segments = value.split("/").filter((segment) => segment !== "")
    const candidates: string[] = []
    for (let take = 1; take <= segments.length; take += 1) {
      const suffix = segments.slice(segments.length - take).join("/")
      candidates.push(take === segments.length && value.startsWith("/") ? value : suffix)
    }
    if (candidates.length === 0) candidates.push(value)
    return candidates
  }
  const result = new Map<string, string>()
  for (const path of new Set(paths)) {
    const own = suffixes(path)
    const chosen =
      own.find((candidate) =>
        [...new Set(paths)].every((other) => other === path || !suffixes(other).includes(candidate)),
      ) ??
      friendly.get(path) ??
      path
    result.set(path, chosen)
  }
  return result
}

export type QueueIdentity = Readonly<{
  /** Absolute repository path the queue writes; absent when the surface does not know it. */
  path?: string
  /** Base branch — the ref the merge step writes. */
  base: string
}>

/**
 * The canonical `path@branch` address (item 36). Without a known path the
 * degenerate standalone form is the bare branch — never a fabricated path.
 */
export function queueFullName(queue: QueueIdentity): string {
  return queue.path === undefined ? queue.base : `${queue.path}@${queue.base}`
}

/** The display rendering of the FQN: `path ⎇ branch` (item 36's pretty name).
 * `pathDisplay` lets a pill pass its shortened unique form; otherwise the
 * friendly full path renders. Pathless queues degrade to `⎇ branch`. */
export function queuePrettyName(queue: QueueIdentity, pathDisplay?: string, home: string = homedir()): string {
  const path = pathDisplay ?? (queue.path === undefined ? undefined : friendlyRepositoryPath(queue.path, home))
  return path === undefined ? `${QUEUE_BRANCH_GLYPH} ${queue.base}` : `${path} ${QUEUE_BRANCH_GLYPH} ${queue.base}`
}

/**
 * The display label a run name leads with (item 36: `label#N` is the primary
 * shown form). The config handle when the surface knows one; the base branch
 * otherwise — a standalone repository has no config handles yet, and its base
 * is what its run ids have always led with (`main#2173`).
 */
export function queueRunLabel(queue: Readonly<{ name?: string; base: string }>): string {
  return queue.name ?? queue.base
}

/** `path@branch#N` — the script-stable run address every CLI accepts (item 36). */
export function formatQueueRunAddress(queue: QueueIdentity, runNumber: string | number): string {
  return `${queueFullName(queue)}#${String(runNumber)}`
}

export type ParsedQueueRunAddress = Readonly<{ path: string; base: string; run: string }>

/**
 * Parse the canonical `path@branch#N` run address. Only an ABSOLUTE or
 * `~`-rooted path qualifies — `topic@v2#3` stays an ordinary token — and the
 * run half keeps the `<base>#<number>` shape the resolver already accepts.
 */
export function parseQueueRunAddress(token: string): ParsedQueueRunAddress | undefined {
  const match = /^(?<path>(?:~|\/)[^@\s]*)@(?<base>[^\s#@]+)#(?<number>\d+)$/u.exec(token)
  const groups = match?.groups
  if (groups?.path === undefined || groups.base === undefined || groups.number === undefined) return undefined
  return Object.freeze({ path: groups.path, base: groups.base, run: `${groups.base}#${groups.number}` })
}
