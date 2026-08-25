import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import type { QueueAuditFindingEmission } from "./model.ts"

/**
 * Read-only census of submodule object-store alternates under one superproject
 * common git dir — the detection half of the 2026-08-25 alternates outage.
 *
 * A borrow-materialized submodule store holds almost no objects of its own:
 * every read runs through `objects/info/alternates`. When the only line points
 * into another linked worktree's `worktrees/<wt>/modules` store, recycling
 * that worktree kills the store silently — nothing notices until a candidate
 * needs an object and dies (B291's submit died at delivery-composition with
 * "no readable HEAD"). Measured across /hh/dev on 2026-08-25: 3121 alternates
 * files, 610 chained to another worktree, 66 dangling, 62 with no live
 * fallback — unreadable, all traced to two recycled trees (B158, worktree54).
 *
 * The census walks `<common>/modules/**` and `<common>/worktrees/<wt>/modules/**`
 * (module gitdirs nest as `<gitdir>/modules/<name>`, keyed by NAME), classifies
 * every alternates file, and NEVER writes or repairs anything — findings page,
 * repair stays chief-routed.
 */
export type SubmoduleAlternatesStore = Readonly<{
  /** The store's `objects` directory — the dir whose `info/alternates` was read. */
  objects: string
  /** The file's non-empty, non-comment lines as written. */
  lines: readonly string[]
}>

export type SubmoduleAlternatesCensus = Readonly<{
  /** DENOMINATOR: every alternates file inspected under the common dir. */
  scanned: number
  /** Every line dangles — the store cannot read borrowed objects any more. */
  dead: readonly SubmoduleAlternatesStore[]
  /** Reads today, but every LIVE line sits under `<common>/worktrees/` — the
   * store dies the moment that worktree is recycled. */
  armed: readonly SubmoduleAlternatesStore[]
}>

const isUnder = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * ENOENT and ENOTDIR are absences, not failures: a worktree with no submodules
 * has no `modules` dir, and both read as "nothing to census here". Anything
 * else (EACCES, EIO) throws — a census that silently skips what it cannot read
 * would report a clean estate over the exact stores it failed to inspect.
 */
async function readdirIfPresent(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw error
  }
}

async function classify(
  objects: string,
  worktreesRoot: string,
): Promise<Readonly<{ store: SubmoduleAlternatesStore; verdict: "healthy" | "dead" | "armed" }> | undefined> {
  const alternatesFile = join(objects, "info", "alternates")
  let content: string
  try {
    content = await readFile(alternatesFile, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
  const store: SubmoduleAlternatesStore = { objects, lines }
  // An empty alternates file borrows nothing: the store stands on its own.
  if (lines.length === 0) return { store, verdict: "healthy" }
  const live = lines
    .map((line) => (isAbsolute(line) ? line : resolve(objects, line)))
    .filter((line) => existsSync(line))
  if (live.length === 0) return { store, verdict: "dead" }
  // A live line OUTSIDE the worktrees tree is durable (the primary's
  // `modules/<name>` store, or an off-repository source). Lines pointing into
  // another repository's worktrees are counted durable here — the emission
  // paths never write them, and this census pages on the measured class.
  const durable = live.filter((line) => !isUnder(worktreesRoot, line))
  return { store, verdict: durable.length === 0 ? "armed" : "healthy" }
}

/**
 * Walk one modules tree. A directory owning an `objects` dir is a module
 * gitdir: classify it and recurse ONLY into its nested `modules` dir. Any
 * other directory is a name segment (`modules/vendor/` on the way to
 * `modules/vendor/yrd`): recurse into each child. Object stores themselves are
 * never descended into.
 */
async function walkModules(
  dir: string,
  worktreesRoot: string,
  out: { scanned: number; dead: SubmoduleAlternatesStore[]; armed: SubmoduleAlternatesStore[] },
): Promise<void> {
  const objects = join(dir, "objects")
  if (existsSync(objects)) {
    const classified = await classify(objects, worktreesRoot)
    if (classified !== undefined) {
      out.scanned += 1
      if (classified.verdict === "dead") out.dead.push(classified.store)
      if (classified.verdict === "armed") out.armed.push(classified.store)
    }
    await walkModules(join(dir, "modules"), worktreesRoot, out)
    return
  }
  for (const child of await readdirIfPresent(dir)) {
    await walkModules(join(dir, child), worktreesRoot, out)
  }
}

/** Census every submodule alternates file under `commonDir` — read-only. */
export async function censusSubmoduleAlternates(commonDir: string): Promise<SubmoduleAlternatesCensus> {
  const worktreesRoot = join(commonDir, "worktrees")
  const out = { scanned: 0, dead: [] as SubmoduleAlternatesStore[], armed: [] as SubmoduleAlternatesStore[] }
  await walkModules(join(commonDir, "modules"), worktreesRoot, out)
  for (const worktree of await readdirIfPresent(worktreesRoot)) {
    await walkModules(join(worktreesRoot, worktree, "modules"), worktreesRoot, out)
  }
  return out
}

const PREVIEWED_STORES = 5

function preview(stores: readonly SubmoduleAlternatesStore[]): string {
  const shown = stores
    .slice(0, PREVIEWED_STORES)
    .map((store) => store.objects)
    .join(", ")
  return stores.length > PREVIEWED_STORES ? `${shown} … and ${stores.length - PREVIEWED_STORES} more` : shown
}

/**
 * Project a census into `queue audit` findings. One AGGREGATED finding per
 * class — the page names the count and the first stores, never 600 rows — and
 * the specimen is the common dir so page adapters dedupe one page per estate
 * per class. Both findings are census facts: nothing here acts, and the
 * resolutions route repair rather than performing it.
 */
export function submoduleAlternatesFindings(
  census: SubmoduleAlternatesCensus,
  commonDir: string,
): QueueAuditFindingEmission[] {
  const findings: QueueAuditFindingEmission[] = []
  if (census.dead.length > 0) {
    findings.push({
      code: "submodule-alternates-dead-store",
      message:
        `${census.dead.length} of ${census.scanned} submodule object store(s) under ${commonDir} cannot read ` +
        `borrowed objects: every objects/info/alternates line dangles — ${preview(census.dead)}`,
      specimen: commonDir,
      resolution: [
        "Do not recycle or delete further worktrees until these stores are repaired.",
        `Route repair to @chief: append the durable ${join(commonDir, "modules", "<path>", "objects")} line to each ` +
          "store's objects/info/alternates after verifying the objects exist there; never auto-repair from the audit.",
      ],
    })
  }
  if (census.armed.length > 0) {
    findings.push({
      code: "submodule-alternates-worktree-only",
      message:
        `${census.armed.length} of ${census.scanned} submodule object store(s) under ${commonDir} depend only on ` +
        `another worktree's module store and break the moment that worktree is recycled — ${preview(census.armed)}`,
      specimen: commonDir,
      resolution: [
        "Re-materializing the checkout (any candidate, bay, or worktree materialization) anchors the durable line and disarms it.",
        "Before recycling any worktree these lines point into, re-materialize or repair its dependents.",
      ],
    })
  }
  return findings
}
