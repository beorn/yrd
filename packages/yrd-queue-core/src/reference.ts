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

import { transportFaultIn } from "./setup-transport.ts"
import { accessSync, constants, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { ensureCommitObject } from "git-super/objects"
import { GitExit, refAt, seamProcess, type Git } from "./git.ts"

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
  /** Local root whose matching gitlink stores can serve exact pins before origin is asked. */
  source?: string
  /**
   * Root-relative submodule paths the composed tree leaves out (27147: declared
   * `private = true`). Skipped, with everything under them, before any store is
   * read, created or fetched into.
   */
  excludedSubmodules?: readonly string[]
  /** One acquisition fact per pin. Observer failures propagate. */
  acquired?: (pin: ReferenceAcquisition) => void
  /** Told about each store as it is created. A store already there says nothing. */
  populated?: (store: ReferenceStore) => void
  /**
   * Preview custody (27510): keep each pin through `anchor`, a create-only ref in the EXISTING store, instead of a
   * permanent `refs/yrd/pins/<sha>`. A preview never provisions an author's checkout, so a missing store fails by
   * name and nothing is cloned. A store already holding `anchor` at the same pin is verified and reused with its age
   * untouched; at another pin it fails by name. `anchored` hears each anchor this call created, so a failed attempt
   * removes exactly those.
   */
  preview?: Readonly<{ anchor: string; anchored: (anchor: PreviewAnchor) => void }>
}>

/** One preview anchor a call created: the store it lives in, the gitlink it keeps and the pin it holds. */
export type PreviewAnchor = Readonly<{ store: string; path: string; sha: string }>

export type ReferenceAcquisition = Readonly<{ path: string; sha: string }> &
  (
    | Readonly<{ source: "present" }>
    | Readonly<{ source: "local"; localSource: string }>
    | Readonly<{ source: "remote"; localMiss?: Readonly<{ localSource: string; reason: string }> }>
  )

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
    /**
     * Set when the store could not be given because its REMOTE could not be
     * reached — the `ls-remote` answered nothing, or a clone failed on a
     * transport signature — rather than because the store itself is wrong. A
     * queue run takes such a stuck once more before it writes it.
     */
    readonly unreachable?: string,
  ) {
    super(
      path === undefined
        ? `the reference ${repo} cannot be borrowed from: ${why}`
        : `the reference ${repo} has no borrowable store for '${path}': ${why}`,
    )
    this.name = "ReferenceUnpopulated"
  }
}

/**
 * A gitlink standing at a commit its own remote does not have.
 *
 * The SUBMITTER's, and the one failure here that is. A pin the reference cannot
 * fetch has two causes with opposite owners, and telling them apart is one
 * `ls-remote`: a remote that answers and simply lacks the commit is a component
 * commit that never left somebody's bay, while a remote that cannot be reached
 * at all is the queue's own ground. Specimen 2026-09-03: a root carrier stood
 * at km gitlink 11d9312c, which existed only in the author's bay, and the queue
 * billed itself and stopped for it.
 */
export class GitlinkNotOnRemote extends Error {
  constructor(
    readonly path: string,
    readonly sha: string,
    readonly url: string,
  ) {
    super(`gitlink ${path} at ${sha} is not on ${url}`)
    this.name = "GitlinkNotOnRemote"
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
 * The ref that keeps one borrowed pin reachable in its store.
 *
 * A fetch of a bare sha writes NO ref, so the objects land unreachable and the
 * next `gc` in that store is free to take them. Measured 2026-09-09: a pin
 * borrowed that way was collected out from under a raised gitlink and the
 * submodule could not be checked out at it any more. The whole point of a
 * reference store is that what it lends today it still holds tomorrow, and in
 * Git that means a ref.
 *
 * One ref per pin, never deleted here: a pin nothing points at is the state
 * this exists to prevent, and refs pack down to a line each. Named by the sha
 * so two runs asking for the same pin write the same ref rather than racing
 * over a shared name.
 */
function pinRef(sha: string): string {
  return `refs/yrd/pins/${sha}`
}

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
/**
 * The component's main as its remote holds it NOW, read through the reference store at `store` (`<queue clone>/<gitlink
 * path>`, the store `populateReferenceStores` keeps): one fetch of `refs/heads/main` into the store's
 * `refs/remotes/origin/main`, then the ref. The compose reads main through git-super's refresh cache, and a derive
 * that trusted a cached observation forked from the main an earlier round had just published (27176, 2026-10-02
 * 18:02 PDT) — the derive step reads it fresh here, on derivation rounds only. Returns `undefined` when the store is
 * absent; an unreadable main fails with the store and query. A fetch that fails leaves the stored ref and is
 * reported to `onStale`.
 */
export async function readComponentMain(
  gitIn: (cwd: string) => Git,
  store: string,
  onStale: (why: string) => Promise<void> | void,
): Promise<string | undefined> {
  if (!existsSync(store)) return undefined
  const storeGit = gitIn(store)
  try {
    await storeGit([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ])
  } catch (error) {
    await onStale(error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error))
  }
  try {
    return (await storeGit(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"])).trim()
  } catch (error) {
    throw new Error(
      `readComponentMain: cannot read refs/remotes/origin/main^{commit} in ${store}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export async function populateReferenceStores(options: PopulateReference): Promise<readonly ReferenceStore[]> {
  const root = resolve(options.repo)
  const created: ReferenceStore[] = []
  await walkRecordedClosure(
    { commit: options.commit ?? "HEAD", excluded: options.excludedSubmodules ?? [], gitIn: options.gitIn, root },
    async ({ dir, named, recordedIn, sha, store, url }) => {
      const git = options.gitIn(dir)
      if (url === undefined) {
        // The tree carries a gitlink its own `.gitmodules` does not declare, so
        // there is no remote to clone from and no guess worth making.
        throw new ReferenceUnpopulated(root, named, `${recordedIn}:.gitmodules declares no url for it`)
      }
      const existing = await isRepositoryAt(options.gitIn, store)
      const present = existing && (await holdsCommit(options.gitIn(store), sha))
      const localSource = options.source === undefined ? undefined : resolve(options.source, named)
      const miss =
        present || localSource === undefined ? undefined : await localSourceMiss(options.gitIn, localSource, sha)
      const local = !present && localSource !== undefined && miss === undefined
      if (!existing && options.preview !== undefined) {
        throw new ReferenceUnpopulated(
          root,
          named,
          `preview custody keeps ${sha} only in an existing store, and ${store} is not one; a preview never creates it`,
        )
      }
      if (!existing) {
        const started = Date.now()
        const cloneFrom = local ? localSource : url
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
            ...(local ? ["--no-local"] : []),
            "--no-checkout",
            "--origin",
            "origin",
            cloneFrom,
            store,
          ])
          if (local) await options.gitIn(store)(["remote", "set-url", "origin", url])
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          const fault = transportFaultIn(why)
          throw new ReferenceUnpopulated(
            root,
            named,
            `cloning ${cloneFrom} into ${store} failed: ${why}`,
            fault === undefined ? undefined : `cloning ${cloneFrom} could not reach it (${fault.signature})`,
          )
        }
        const populated: ReferenceStore = { ms: Date.now() - started, path: named, sha, url }
        created.push(populated)
        options.populated?.(populated)
      }
      const storeGit = options.gitIn(store)
      if (local) {
        // Copy through the existing exact-object primitive, never alternates:
        // the owner must retain the closure after this source is removed.
        await ensureCommitObject({
          commit: sha,
          git: seamProcess(storeGit, resolve(store)),
          remote: localSource,
          repository: store,
          ...(options.preview === undefined ? {} : { anchor: false }),
        })
      }
      if (present || local || (await holdsCommit(storeGit, sha))) {
        // Present is not the same as REACHABLE, and only reachable survives.
        // A pin that arrived on a branch stops being reachable the moment that
        // branch moves, and the next gc in this store takes it — so the ref is
        // written for a pin already here exactly as for one just fetched.
        if (options.preview === undefined) await storeGit(["update-ref", pinRef(sha), sha])
        else await writePreviewAnchor(storeGit, root, store, named, sha, options.preview)
      } else {
        // TWO CAUSES, OPPOSITE OWNERS, ONE PROBE. Whichever way this fetch
        // fails, the pin is not here — but "the remote does not have it" is a
        // component commit still sitting in somebody's bay, and "the remote
        // cannot be reached" is the queue's own ground. Billing both to the
        // queue stops the whole line for one submitter's unpushed gitlink,
        // which is what happened on 2026-09-03.
        const unresolved = async (why: string): Promise<never> => {
          if (await remoteAnswers(storeGit)) throw new GitlinkNotOnRemote(named, sha, url)
          throw new ReferenceUnpopulated(
            root,
            named,
            `${why}; ${url} could not be reached either`,
            `ls-remote of ${url} answered nothing`,
          )
        }
        try {
          await storeGit([
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "origin",
            options.preview === undefined ? `${sha}:${pinRef(sha)}` : sha,
          ])
        } catch (error) {
          await unresolved(
            `${store} lacks ${sha} and fetching it from origin failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (!(await holdsCommit(storeGit, sha))) {
          await unresolved(`${store} still lacks ${sha} after one fetch from origin`)
        }
        if (options.preview !== undefined) await writePreviewAnchor(storeGit, root, store, named, sha, options.preview)
      }
      options.acquired?.(
        present
          ? { path: named, sha, source: "present" }
          : local
            ? { localSource, path: named, sha, source: "local" }
            : {
                path: named,
                sha,
                source: "remote",
                ...(localSource === undefined || miss === undefined
                  ? {}
                  : { localMiss: { localSource, reason: miss } }),
              },
      )
      // Populated or proven present: its own gitlinks are read from it next.
      return true
    },
  )
  return created
}

/** One gitlink of a recorded closure: the commit and store that record it, and the store it lives in (27510). */
export type RecordedGitlink = Readonly<{
  /** The store whose commit records this gitlink. */
  dir: string
  /** The recording commit. */
  recordedIn: string
  /** Its path in the recording commit's tree. */
  path: string
  /** Its root-relative path. */
  named: string
  sha: string
  /** The url the recording commit's `.gitmodules` declares for it, if any. */
  url: string | undefined
  /** The store it lives in: `dir` joined with `path`. */
  store: string
}>

/**
 * Walk the recorded submodule closure of `commit` in the store at `root`, breadth first, leaving out `excluded` roots
 * and everything under them. The one closure walk (27510): reference population and preview custody's store list
 * both visit through it.
 *
 * `visit` answers whether to read the gitlink's own gitlinks. Those are read only when its level is dequeued, after
 * its visit returned, so a visit that populates a store is read from the store it just populated, and a visit that
 * declines (a store that is not a repository holds nothing to read) is never read at all.
 */
export async function walkRecordedClosure(
  options: Readonly<{ gitIn: (cwd: string) => Git; root: string; commit: string; excluded: readonly string[] }>,
  visit: (link: RecordedGitlink) => Promise<boolean>,
): Promise<void> {
  const levels: Array<Readonly<{ dir: string; prefix: string; commit: string }>> = [
    { dir: options.root, prefix: "", commit: options.commit },
  ]
  while (levels.length > 0) {
    const level = levels.shift()
    if (level === undefined) break
    const git = options.gitIn(level.dir)
    const urls = await declaredSubmodules(git, level.commit)
    const included = [...urls.keys()].filter((path) => {
      const named = level.prefix === "" ? path : join(level.prefix, path)
      return !options.excluded.some((root) => named === root || named.startsWith(`${root}/`))
    })
    if (included.length === 0) continue
    for (const { path, sha } of await gitlinksAt(git, level.commit, included)) {
      const named = level.prefix === "" ? path : join(level.prefix, path)
      const store = join(level.dir, path)
      const link = { dir: level.dir, named, path, recordedIn: level.commit, sha, store, url: urls.get(path) }
      if (await visit(link)) levels.push({ commit: sha, dir: store, prefix: named })
    }
  }
}

/**
 * Create `preview.anchor` at `sha` in `store`, create-only, with a reflog whose first entry dates the anchor (27510).
 * An anchor already at `sha` is this candidate's own, and its age is kept; one at any other pin is a conflict.
 */
async function writePreviewAnchor(
  storeGit: Git,
  root: string,
  store: string,
  path: string,
  sha: string,
  preview: NonNullable<PopulateReference["preview"]>,
): Promise<void> {
  const held = await refAt(storeGit, preview.anchor)
  if (held === sha) return
  if (held !== undefined) {
    throw new ReferenceUnpopulated(root, path, `${store} already holds ${preview.anchor} at ${held}, not at ${sha}`)
  }
  await createRef(storeGit, preview.anchor, sha)
  preview.anchored({ path, sha, store })
}

/**
 * Create `ref` at `sha` only if it does not exist (`update-ref --stdin`'s `create`), with a reflog whose first entry
 * records when it was made.
 */
export async function createRef(git: Git, ref: string, sha: string): Promise<void> {
  await git(["update-ref", "--create-reflog", "--stdin"], `create ${ref} ${sha}\n`)
}

/** Missing/unreadable cache entries are misses; a broken repository or object is an error. */
async function localSourceMiss(gitIn: (cwd: string) => Git, source: string, sha: string): Promise<string | undefined> {
  try {
    accessSync(source, constants.R_OK | constants.X_OK)
    accessSync(join(source, ".git"), constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      return `local store ${source} is missing or unreadable (${code})`
    }
    throw error
  }
  const git = gitIn(source)
  try {
    const toplevel = (await git(["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim()
    if (resolve(toplevel) !== source) {
      throw new Error(`local source ${source} resolved to another repository: ${toplevel}`)
    }
    // Batch-check reports "missing" with exit zero for corrupt loose objects,
    // too. Only the strict command's exact absence answer is a cache miss.
    await git(["cat-file", "-e", `${sha}^{commit}`])
    return undefined
  } catch (error) {
    if (error instanceof GitExit && error.detail.trim() === `fatal: Not a valid object name ${sha}^{commit}`) {
      return `local store ${source} does not hold ${sha}`
    }
    if (error instanceof GitExit && /permission denied|operation not permitted/iu.test(error.detail)) {
      return `local store ${source} is unreadable: ${error.detail}`
    }
    throw new Error(
      `cannot acquire ${sha} from local source ${source}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
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
export async function declaredSubmodules(git: Git, commit: string): Promise<ReadonlyMap<string, string>> {
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
export async function gitlinksAt(
  git: Git,
  commit: string,
  paths: readonly string[],
): Promise<readonly Readonly<{ path: string; sha: string }>[]> {
  if (paths.length === 0) return []
  const levels: Array<{ git: Git; commit: string; paths: readonly string[]; prefix: string; store?: string }> = [
    { git, commit, paths, prefix: "" },
  ]
  const gitlinks: Array<Readonly<{ path: string; sha: string }>> = []
  let root: string | undefined
  while (levels.length > 0) {
    const level = levels.shift()
    if (level === undefined) break
    // Request prefixes to discover boundaries from mode 160000 in the tree.
    // A slash in a requested path does not itself identify a submodule.
    const prefixes = new Set<string>()
    for (const path of level.paths) {
      const parts = path.split("/")
      for (let count = 1; count <= parts.length; count++) prefixes.add(parts.slice(0, count).join("/"))
    }
    let listed: string
    try {
      listed = await level.git(["ls-tree", level.commit, "--", ...prefixes])
    } catch (cause) {
      throw new Error(
        `cannot read gitlinks ${level.paths.join(", ")} at level ${level.prefix || "."} in store ${level.store || "root"} at ${level.commit}`,
        { cause },
      )
    }
    for (const row of readGitlinks(listed)) {
      const named = level.prefix === "" ? row.path : `${level.prefix}/${row.path}`
      if (level.paths.includes(row.path)) gitlinks.push({ path: named, sha: row.sha })
      const children = level.paths.filter((path) => path.startsWith(`${row.path}/`))
      if (children.length === 0) continue
      root ??= (await git(["rev-parse", "--show-toplevel"])).trim()
      const store = join(root, named)
      const inStore =
        (cwd: string): Git =>
        (args, input) =>
          git(["-C", cwd, ...args], input)
      if (!(await isRepositoryAt(inStore, store))) {
        throw new Error(
          `cannot read ${children.join(", ")} across ${named}: unknown gitlink store ${store} at level ${named}`,
        )
      }
      const childGit = inStore(store)
      if (!(await holdsCommit(childGit, row.sha))) {
        throw new Error(
          `cannot read ${children.join(", ")} at level ${named}: store ${store} does not hold parent commit ${row.sha}`,
        )
      }
      levels.push({
        git: childGit,
        commit: row.sha,
        paths: children.map((path) => path.slice(row.path.length + 1)),
        prefix: named,
        store,
      })
    }
  }
  return gitlinks
}

/** The same tree-entry parser serves root and nested candidate reads. */
function readGitlinks(listed: string): readonly Readonly<{ path: string; sha: string }>[] {
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
export async function isRepositoryAt(gitIn: (cwd: string) => Git, path: string): Promise<boolean> {
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

/**
 * Whether the store's `origin` ANSWERS — not whether it holds anything.
 *
 * Deliberately without `--exit-code`: a reachable repository with no branches
 * exits 0 with empty output, and that is a reachable remote, which is the only
 * question being asked. `--exit-code` would turn it into a failure and bill the
 * queue for a remote that was talking to us perfectly well.
 *
 * One call, only on the path where a pin is already known to be missing, so a
 * healthy reference never makes it.
 */
async function remoteAnswers(git: Git): Promise<boolean> {
  try {
    await git(["ls-remote", "--heads", "origin"])
    return true
  } catch {
    // silent-fallback-allow: unreachable IS the answer, and the one caller
    // turns it straight into a loud ReferenceUnpopulated naming the url.
    return false
  }
}

export async function holdsCommit(git: Git, sha: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`])
    return true
  } catch {
    // silent-fallback-allow: absence is the answer this asks for, and the
    // caller fetches and then re-asks rather than treating this as an error.
    return false
  }
}
