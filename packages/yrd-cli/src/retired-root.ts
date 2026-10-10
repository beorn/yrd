/**
 * The retired-root sweeper (28481 layer 3, @cto 249d8327).
 *
 * Before 27065 a yrd resolved a queue's physical root with a percent-escaped
 * separator, `<workdir>/<host>/<path>%23<queue>`. That escape decodes back to a
 * hash in URL-based module loaders, so a queue materialized there corrupts module
 * loading — the bug 27065 fixed by moving the boundary to a literal `~`. The old
 * root still exists on hosts that ran the pre-cutover code, and a stale client
 * still writes it: a write there is a silent re-creation of the bug, not a
 * spelling error.
 *
 * Layers 1 and 2 refuse the write at the two client doors. This is the backstop
 * for a client that bypasses both: the service notices the retired root has been
 * written since the cutover and turns it into an incident instead of a find
 * during a verification. It NEVER drains the root — the sweep reads and pages.
 */
import { readdirSync, statSync, type Dirent } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * The instant the tilde cutover landed — the committer date of vendor/yrd
 * `a9bf40062b80434f5a388f13565e01d9efa45ffe` ("use a tilde physical separator for
 * queue workdirs"). A retired root with no write after this is a leftover, not a
 * live writer; one with a later write names a client still on the old code.
 */
export const RETIRED_ROOT_CUTOVER = "2026-10-03T22:43:17-07:00"

/**
 * The retired root BESIDE a live queue root: the same directory name with its
 * literal-tilde boundary replaced by the percent-escaped hash the pre-cutover
 * builder wrote. This is what the running service needs — its `workdir` IS the
 * queue root, so it cannot name the host workdir an address wants. `undefined`
 * when the name carries no boundary tilde, i.e. the path is not a queue root.
 */
export function retiredRootBeside(queueRoot: string): string | undefined {
  const name = basename(queueRoot)
  const at = name.lastIndexOf("~")
  if (at < 0) return undefined
  return join(dirname(queueRoot), `${name.slice(0, at)}%23${name.slice(at + 1)}`)
}

export type RetiredRootSweep = Readonly<{
  /** The retired root that was walked. */
  root: string
  /** Regular files seen under it (a cheap census, not a reason to sweep). */
  files: number
  /** The newest regular file, or undefined when the root holds none. */
  newest?: Readonly<{ path: string; mtimeMs: number }>
  /** Round-log environment names (`logs/environments/*`) — the nearest thing to the writer's name. */
  branches: readonly string[]
  /** True when the newest write is AFTER `sinceMs` — the root is being written now. */
  live: boolean
  /**
   * Every path the census could not read: a directory whose listing raised, or a
   * file whose stat raised. Non-empty means `newest` is only the newest READABLE
   * write, so the walk cannot prove the root is quiet — a clear on this census
   * would withdraw a standing incident while a fresh write sits in the part it
   * could not see (28481 layer 3, @dev/2 review of the unreadable subtree).
   */
  unreadable: readonly string[]
}>

/**
 * Every fact about one retired root, whether or not it is live: what makes a
 * record (the root, its newest file and instant, its round-log names) and what
 * decides its clearing edge (`live`). The caller decides liveness so a root
 * whose newest write has aged past the window can still be reported as cleared.
 */
export function retiredRootSweep(root: string, sinceMs: number = Date.parse(RETIRED_ROOT_CUTOVER)): RetiredRootSweep {
  let files = 0
  let newestPath: string | undefined
  let newestMs = Number.NEGATIVE_INFINITY
  const unreadable: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // ENOENT is absence (the root, or a subtree, is simply not there) and stays
      // quiet. Any OTHER failure — EACCES, EIO — is an expected part of the root
      // the walk could not read: name it rather than pretend it is empty, because
      // an invisible subtree must never certify the root quiet.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") unreadable.push(dir)
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        let mtimeMs: number
        try {
          mtimeMs = statSync(path).mtimeMs
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") unreadable.push(path)
          continue
        }
        files += 1
        if (mtimeMs > newestMs) {
          newestMs = mtimeMs
          newestPath = path
        }
      }
    }
  }
  walk(root)
  let branches: string[] = []
  try {
    branches = readdirSync(join(root, "logs", "environments"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // A root written without round logs (a bare `repo.lock`) still counts; it just names no branch.
    branches = []
  }
  const newest = newestPath === undefined ? undefined : { path: newestPath, mtimeMs: newestMs }
  return {
    root,
    files,
    branches,
    ...(newest === undefined ? {} : { newest }),
    live: newest !== undefined && newest.mtimeMs > sinceMs,
    unreadable,
  }
}
