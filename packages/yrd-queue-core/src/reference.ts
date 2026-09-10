/**
 * The queue's reference repository, self-contained by construction.
 *
 * Every worktree the queue composes borrows its submodule objects from one
 * reference repository, so that a fresh worktree does not mean a fresh network
 * fetch (worktree.ts). Borrowing needs a real object store at
 * `<reference>/<gitlink path>` — that is where git-super looks — and nothing
 * ever put one there: `ensureOwnedClone` clones `--no-checkout`, which
 * materializes no submodule at all.
 *
 * MEASURED 2026-09-09. Fifteen gitlinks, no store for any of them, so every
 * compose cloned all fifteen from GitHub: 82 to 1449 seconds each, four hours
 * of a saturated host, and the same fifteen clones again on the next compose
 * because nothing the compose did was kept. The counts were in the journal the
 * whole time and read as fetches rather than as a reference that did not exist.
 *
 * The stores are REAL CLONES, with their own objects and their own
 * `refs/remotes/origin/*`. Not alternates: pointing a store's
 * `objects/info/alternates` at the superproject's module store cures the speed
 * and leaves the objects unreferenced where they are borrowed from, so a later
 * repack or gc in either store strands them. That was tried the same night and
 * an alternates drop made one submodule un-checkout-able at its raised pin.
 *
 * `--no-checkout` throughout: the queue never reads a file out of the
 * reference, only objects, so a working tree per submodule is disk spent on
 * nothing.
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Git } from "./records.ts"

/** One store this run created, as the caller records it. */
export type ReferenceStore = Readonly<{
  /** The gitlink path inside the reference, nested paths included: `km`, `km/apps/maddoc`. */
  path: string
  /** The gitlink it was populated for. */
  sha: string
  /** The remote it was cloned from, as the owning tree's `.gitmodules` declares it. */
  url: string
  /** How long the clone took. */
  ms: number
}>

export type PopulateReference = Readonly<{
  /** The reference repository whose every gitlink must become borrowable. */
  repo: string
  /**
   * One Git bound to a directory. The caller owns process, selection, env and
   * invocation logging, and this module never reaches around it: a store is
   * created and read through the same instrumented path as every other call the
   * queue makes.
   */
  gitIn: (cwd: string) => Git
  /**
   * Whose gitlinks. The commit the reference is being made self-contained FOR,
   * which is the commit about to be composed — not the reference's own HEAD.
   * A candidate that adds a submodule declares it at its own commit and nowhere
   * else, so anchoring on HEAD would leave exactly that change unborrowable.
   */
  commit?: string
  /** Told about each store as it is created. A store already there says nothing. */
  populated?: (store: ReferenceStore) => void
}>

/**
 * A gitlink the reference cannot be given a store for.
 *
 * Its own class because its ending is its own: the queue could not build its
 * own ground, which is never the submitter's fault, so the change is stuck
 * rather than failed and the incident names the store instead of the change.
 */
export class ReferenceUnpopulated extends Error {
  constructor(
    readonly repo: string,
    /**
     * The gitlink, when this module is the one that could not give it a store.
     * Absent when git-super refused instead: its own refusal already names
     * every path and the exact command for each, and inventing one path here to
     * put in a remedy would name the wrong one whenever there were several.
     */
    readonly path: string | undefined,
    readonly why: string,
  ) {
    super(
      path === undefined
        ? `the reference ${repo} cannot be borrowed from: ${why}`
        : `the reference ${repo} has no borrowable store for '${path}': ${why}`,
    )
    this.name = "ReferenceUnpopulated"
  }
}

/** The marker git-super's own refusal carries when a reference has no store for a gitlink.
 *
 * A compose can still meet that refusal after this module ran — a gitlink added
 * between the population and the compose, a store removed underneath us — and
 * it is the same condition with the same remedy, so it gets the same ending
 * rather than the generic crash one. Kept beside the class it classifies, and
 * matched against git-super's sentence in `src/submodules.ts` rather than
 * against an exit code, because the yrd Git wrapper throws the message and
 * never parses git-super's JSON on a failure. */
export const GIT_SUPER_ABSENT_STORE = "holds no object store for"

const GITLINK_ROW = /^160000 commit ([0-9a-f]+)\t(.+)$/u

/**
 * Give every gitlink of `commit` a borrowable store inside `repo`, recursively.
 *
 * Idempotent by construction: a store that is already a repository at its path
 * is left exactly as it is, so the ordinary call does one `rev-parse` per
 * gitlink and creates nothing. Recursion is not optional — git-super borrows a
 * nested submodule from `<reference>/<parent>/<child>`, so a reference with a
 * store for `km` and none for `km/apps/maddoc` is refused one level down.
 *
 * The pin is chased with one fetch when the store does not already hold it,
 * because reading the nested `.gitmodules` needs that commit's tree. That is
 * one connection into a local store per moved gitlink per call — the same
 * repair git-super would make lazily at compose, made once instead of once per
 * worktree.
 */
export async function populateReferenceStores(options: PopulateReference): Promise<readonly ReferenceStore[]> {
  const root = resolve(options.repo)
  const created: ReferenceStore[] = []
  const levels: Array<Readonly<{ dir: string; prefix: string; commit: string }>> = [
    { dir: root, prefix: "", commit: options.commit ?? "HEAD" },
  ]
  while (levels.length > 0) {
    const level = levels.shift()
    if (level === undefined) break
    const git = options.gitIn(level.dir)
    const urls = await declaredSubmodules(git, level.commit)
    if (urls.size === 0) continue
    const gitlinks = await gitlinksAt(git, level.commit, [...urls.keys()])
    for (const { path, sha } of gitlinks) {
      const named = level.prefix === "" ? path : join(level.prefix, path)
      const url = urls.get(path)
      if (url === undefined) {
        // The tree carries a gitlink its own `.gitmodules` does not declare, so
        // there is no remote to clone from and no guess worth making.
        throw new ReferenceUnpopulated(root, named, `${level.commit}:.gitmodules declares no url for it`)
      }
      const store = join(level.dir, path)
      if (!(await isRepositoryAt(options.gitIn, store))) {
        const started = Date.now()
        try {
          await git([
            // Local paths are how every test fixture and every file-transport
            // remote reaches its dependency; git refuses file:// submodule
            // transports by default, and git-super allows it the same way for
            // the borrow it performs from these very stores.
            "-c",
            "protocol.file.allow=always",
            "clone",
            "--quiet",
            "--no-checkout",
            "--origin",
            "origin",
            url,
            store,
          ])
        } catch (error) {
          throw new ReferenceUnpopulated(
            root,
            named,
            `cloning ${url} into ${store} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const populated: ReferenceStore = { ms: Date.now() - started, path: named, sha, url }
        created.push(populated)
        options.populated?.(populated)
      }
      const storeGit = options.gitIn(store)
      if (!(await holdsCommit(storeGit, sha))) {
        try {
          await storeGit(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", sha])
        } catch (error) {
          throw new ReferenceUnpopulated(
            root,
            named,
            `${store} lacks ${sha} and fetching it from origin failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (!(await holdsCommit(storeGit, sha))) {
          throw new ReferenceUnpopulated(root, named, `${store} still lacks ${sha} after one fetch from origin`)
        }
      }
      levels.push({ commit: sha, dir: store, prefix: named })
    }
  }
  return created
}

/**
 * The remote each submodule the commit declares names, keyed by its path.
 *
 * Empty when the commit records no `.gitmodules` at all, which is a real answer
 * and the one this asks first: `config --blob` on an absent blob fails, and
 * reading that failure as "no submodules" would also read an unreadable tree
 * that way. `ls-tree` of the one path answers only the question asked — empty
 * output means absent, and a bad commit makes it fail.
 */
async function declaredSubmodules(git: Git, commit: string): Promise<ReadonlyMap<string, string>> {
  const byPath = new Map<string, string>()
  if ((await git(["ls-tree", commit, "--", ".gitmodules"])).trim() === "") return byPath
  const declared = await git([
    "config",
    "--blob",
    `${commit}:.gitmodules`,
    "--get-regexp",
    "^submodule\\..*\\.(path|url)$",
  ])
  const paths = new Map<string, string>()
  const urls = new Map<string, string>()
  for (const row of declared.split("\n")) {
    const match = /^submodule\.(.+)\.(path|url)\s+(.+)$/u.exec(row)
    const name = match?.[1]
    const key = match?.[2]
    const value = match?.[3]
    if (name === undefined || key === undefined || value === undefined) continue
    ;(key === "path" ? paths : urls).set(name, value)
  }
  for (const [name, path] of paths) {
    const url = urls.get(name)
    if (url !== undefined) byPath.set(path, url)
  }
  return byPath
}

/**
 * The gitlink each declared path stands at in this commit.
 *
 * Asked about the declared paths and nothing else. `ls-tree -r` would answer
 * the same question by listing every blob in the tree — tens of thousands of
 * rows on a real superproject, once per compose, to find fifteen of them.
 */
async function gitlinksAt(
  git: Git,
  commit: string,
  paths: readonly string[],
): Promise<readonly Readonly<{ path: string; sha: string }>[]> {
  const listed = await git(["ls-tree", commit, "--", ...paths])
  const gitlinks: Array<Readonly<{ path: string; sha: string }>> = []
  for (const row of listed.split("\n")) {
    const match = GITLINK_ROW.exec(row)
    const sha = match?.[1]
    const path = match?.[2]
    if (sha !== undefined && path !== undefined) gitlinks.push({ path, sha })
  }
  return gitlinks
}

/**
 * Whether `path` is its OWN repository, and not merely a directory.
 *
 * `existsSync` is not the question and `rev-parse --git-dir` is worse than it:
 * an uninitialized submodule is an empty directory that git accepts as a cwd
 * and resolves UPWARD from, so both weaker probes answer about the enclosing
 * repository and report a store that is not there. This is the same
 * discrimination git-super makes before it borrows, and it has to be, or the
 * two disagree about what a populated reference is.
 */
async function isRepositoryAt(gitIn: (cwd: string) => Git, path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    const toplevel = (await gitIn(path)(["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim()
    return toplevel !== "" && resolve(toplevel) === resolve(path)
  } catch {
    // silent-fallback-allow: the probe's whole job is to answer "is there a
    // repository here", and every way of there not being one — no directory, a
    // directory that is not a repository, a git that refuses to resolve it —
    // is that same answer. Saying so returns the caller to the populate path,
    // which reports and throws on its own failures.
    return false
  }
}

async function holdsCommit(git: Git, sha: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`])
    return true
  } catch {
    // silent-fallback-allow: absence is the answer this asks for, and the
    // caller fetches and then re-asks rather than treating this as an error.
    return false
  }
}
