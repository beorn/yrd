/**
 * Preview custody (27510; @cto 75b60919, 142e2df8, eb147b05): a successful preview or submit keeps its candidate ROOT
 * and every recursive public recorded component readable after its composition scratch is gone.
 *
 * Each store holds one create-only anchor, `refs/yrd/preview/<clone>/<subject>/<candidate-root>`, at its own recorded
 * commit: the root store at the candidate root, each component's store (the common dir's module store, the one a
 * receipt row names) at the gitlink that root records. A reader resolves the ROOT anchor first; its absence means the
 * receipt was superseded (the subject prefix lists its successor) or retired (the prefix is empty).
 *
 * One supersession per subject, root first: create the new component anchors and then the new root (expected
 * absence), delete the old ROOT (expected OID, the commit point), then the old components. A failure before the
 * commit point removes only what this attempt created, new root first, and leaves the prior custody readable; a
 * failure after it keeps the new custody, and the old components are orphans that every later attempt sweeps.
 */
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { createExclusive, DEFAULT_MUTATION_LOCK_WAIT_MS, type Exclusive } from "git-super/exclusive"
import type { Git } from "./git.ts"
import { encodeQueueComponent } from "./refs.ts"
import {
  createRef,
  declaredSubmodules,
  gitlinksAt,
  isRepositoryAt,
  populateReferenceStores,
  refTarget,
  ReferenceUnpopulated,
  type PreviewAnchor,
} from "./reference.ts"

export const PREVIEW_REF_ROOT = "refs/yrd/preview"

export type PreviewCustodyOptions = Readonly<{
  /** Git in the author's root checkout (any worktree of the clone). */
  git: Git
  /** Git bound to a directory, with the caller's process, selection and env. */
  gitIn: (cwd: string) => Git
  /** The candidate root the receipt names. */
  candidate: string
  /** The composition scratch, still present: the source of objects an author store lacks. */
  source: string
  /** Root-relative private submodule paths the composed tree leaves out (27147). */
  excludedSubmodules: readonly string[]
  /** The change's branch: one custody chain per clone and subject. */
  subject: string
  /** Told about leftovers a committed supersession could not delete; the next attempt sweeps them. */
  leftover?: (why: string) => void
  /**
   * Subjects whose change has ended for good (landed, dropped, withdrawn or deleted), from the queue's own branch
   * fold. Their custody is retired in this clone, root first. A subject whose history could not be read is not here.
   */
  retired?: ReadonlySet<string>
  /** The clock the seven-day backstop reads; tests pass a fixed one. */
  now?: () => number
}>

/** A root anchor older than this, by its first reflog entry, is retired whatever its subject's state (27510). */
export const PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type PreviewCustody = Readonly<{
  /** The root anchor, `refs/yrd/preview/<clone>/<subject>/<candidate-root>`. */
  anchor: string
  /** The prior root anchors this attempt superseded. */
  superseded: readonly string[]
  /** Other subjects' root anchors this attempt retired: ended changes and anchors past the seven-day backstop. */
  retired: readonly string[]
}>

/** The clone's identity: the full SHA-256 of its canonical absolute git-common-dir. */
export function previewCloneKey(commonDir: string): string {
  return createHash("sha256").update(realpathSync(commonDir)).digest("hex")
}

/** Every anchor of one clone and subject shares this prefix; listing it finds the live candidate or nothing. */
export function previewSubjectPrefix(clone: string, subject: string): string {
  return `${PREVIEW_REF_ROOT}/${clone}/${encodeQueueComponent(subject)}/`
}

/** This clone's identity, its main worktree and the writer lock its stores share with git-super's mutations. */
async function previewClone(git: Git): Promise<Readonly<{ clone: string; main: string; lock: Exclusive }>> {
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  return {
    clone: previewCloneKey(common),
    lock: createExclusive(join(common, "yrd-worktree-mutations"), { timeoutMs: DEFAULT_MUTATION_LOCK_WAIT_MS }),
    main: await mainWorktree(git, common),
  }
}

/** Keep the candidate's closure through its anchors, superseding the subject's prior candidate. */
export async function anchorPreviewCustody(options: PreviewCustodyOptions): Promise<PreviewCustody> {
  const { clone, lock, main } = await previewClone(options.git)
  const prefix = previewSubjectPrefix(clone, options.subject)
  const anchor = `${prefix}${options.candidate}`
  const rootGit = options.gitIn(main)
  return lock.run(
    async () => {
      const prior = (await refsUnder(rootGit, prefix)).filter((ref) => ref.name !== anchor)
      const created: PreviewAnchor[] = []
      let rootCreated = false
      try {
        await populateReferenceStores({
          commit: options.candidate,
          excludedSubmodules: options.excludedSubmodules,
          gitIn: options.gitIn,
          preview: { anchor, anchored: (made) => created.push(made) },
          repo: main,
          source: options.source,
        })
        const held = await refTarget(rootGit, anchor)
        if (held === undefined) {
          await createRef(rootGit, anchor, options.candidate)
          rootCreated = true
        } else if (held !== options.candidate) {
          throw new ReferenceUnpopulated(main, undefined, `${main} already holds ${anchor} at ${held}`)
        }
        // The commit point: the prior candidate stops being readable only here.
        for (const old of prior) await rootGit(["update-ref", "-d", old.name, old.oid])
      } catch (error) {
        await removeAttempt(rootGit, anchor, options.candidate, rootCreated, created, options.gitIn)
        throw error
      }
      // Past the commit point nothing restores the prior candidate or undoes this one: a retirement or sweep that
      // fails is named, and its orphans wait for the next attempt's sweep.
      const clonePrefix = `${PREVIEW_REF_ROOT}/${clone}/`
      const retired: Array<Readonly<{ name: string; oid: string }>> = []
      try {
        retired.push(...(await retireRoots(rootGit, clonePrefix, prefix, options)))
      } catch (error) {
        options.leftover?.(`retirement in ${clonePrefix} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        const stores = new Set(await closureStores(options.gitIn, main, options.candidate, options.excludedSubmodules))
        for (const old of [...prior, ...retired]) {
          for (const store of await closureStores(options.gitIn, main, old.oid, options.excludedSubmodules)) {
            stores.add(store)
          }
        }
        await sweepOrphans(rootGit, options.gitIn, clonePrefix, stores, options.leftover)
      } catch (error) {
        options.leftover?.(`the orphan sweep after ${anchor} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { anchor, retired: retired.map((ref) => ref.name), superseded: prior.map((ref) => ref.name) }
    },
    { holder: `yrd preview custody ${options.subject}` },
  )
}

/**
 * Retire one subject's custody in this clone, root first, then its component anchors (27510). `yrd env close` retires
 * the closing environment's own branch: every environment of a clone shares its namespace, so closing one retires
 * that subject and no other.
 */
export async function retirePreviewSubject(
  options: Readonly<{
    git: Git
    gitIn: (cwd: string) => Git
    subject: string
    leftover?: (why: string) => void
  }>,
): Promise<readonly string[]> {
  const { clone, lock, main } = await previewClone(options.git)
  const rootGit = options.gitIn(main)
  return lock.run(
    async () => {
      const roots = await refsUnder(rootGit, previewSubjectPrefix(clone, options.subject))
      for (const root of roots) await rootGit(["update-ref", "-d", root.name, root.oid])
      const stores = new Set<string>()
      for (const root of roots) {
        for (const store of await closureStores(options.gitIn, main, root.oid, [])) stores.add(store)
      }
      await sweepOrphans(rootGit, options.gitIn, `${PREVIEW_REF_ROOT}/${clone}/`, stores, options.leftover)
      return roots.map((root) => root.name)
    },
    { holder: `yrd preview retirement ${options.subject}` },
  )
}

/**
 * Delete, root first, every other subject's root anchor in this clone whose change has ended or whose first reflog
 * entry is older than the backstop. An anchor whose age cannot be read is named and kept: absence of an age is never
 * an expiry.
 */
async function retireRoots(
  rootGit: Git,
  clonePrefix: string,
  ownPrefix: string,
  options: PreviewCustodyOptions,
): Promise<readonly Readonly<{ name: string; oid: string }>[]> {
  const ended = new Set([...(options.retired ?? [])].map((subject) => encodeQueueComponent(subject)))
  const now = (options.now ?? Date.now)()
  const retired: Array<Readonly<{ name: string; oid: string }>> = []
  for (const root of await refsUnder(rootGit, clonePrefix)) {
    if (root.name.startsWith(ownPrefix)) continue
    const subject = root.name.slice(clonePrefix.length).split("/")[0] ?? ""
    let expired = ended.has(subject)
    if (!expired) {
      const made = await firstReflogSeconds(rootGit, root.name)
      if (typeof made === "string") {
        options.leftover?.(`${root.name}'s age is unknown, so it is kept: ${made}`)
        continue
      }
      expired = now - made * 1000 > PREVIEW_MAX_AGE_MS
    }
    if (!expired) continue
    await rootGit(["update-ref", "-d", root.name, root.oid])
    retired.push(root)
  }
  return retired
}

/** When `ref`'s reflog began, in Unix seconds; otherwise why it cannot be told (no reflog, or one that reads oddly). */
async function firstReflogSeconds(git: Git, ref: string): Promise<number | string> {
  let entries: string
  try {
    entries = (await git(["reflog", "show", "--date=unix", "--format=%gd", ref, "--"])).trim()
  } catch (error) {
    return `reading its reflog failed: ${error instanceof Error ? error.message : String(error)}`
  }
  const oldest = entries.split("\n").at(-1) ?? ""
  const seconds = /@\{(\d+)\}$/u.exec(oldest)?.[1]
  return seconds === undefined ? `its oldest reflog entry reads ${JSON.stringify(oldest)}` : Number(seconds)
}

/** The clone's main worktree, whose checkout paths lead to the common dir's module stores. */
async function mainWorktree(git: Git, common: string): Promise<string> {
  const listed = await git(["worktree", "list", "--porcelain"])
  const first = listed.split("\n\n")[0] ?? ""
  const path = /^worktree (.+)$/mu.exec(first)?.[1]
  if (path === undefined || /^bare$/mu.test(first)) {
    throw new ReferenceUnpopulated(
      common,
      undefined,
      `preview custody needs the main worktree of ${common}, and git worktree list names none`,
    )
  }
  return path
}

/** A failed attempt removes only what it created, new root first, each at its expected OID. */
async function removeAttempt(
  rootGit: Git,
  anchor: string,
  candidate: string,
  rootCreated: boolean,
  created: readonly PreviewAnchor[],
  gitIn: (cwd: string) => Git,
): Promise<void> {
  if (rootCreated) await rootGit(["update-ref", "-d", anchor, candidate])
  for (const made of created) await gitIn(made.store)(["update-ref", "-d", anchor, made.sha])
}

/** Every component store a candidate's recorded closure lives in, as main-worktree checkout paths. */
async function closureStores(
  gitIn: (cwd: string) => Git,
  main: string,
  commit: string,
  excluded: readonly string[],
): Promise<readonly string[]> {
  const stores: string[] = []
  const levels: Array<Readonly<{ dir: string; prefix: string; commit: string }>> = [{ dir: main, prefix: "", commit }]
  while (levels.length > 0) {
    const level = levels.shift()
    if (level === undefined) break
    const git = gitIn(level.dir)
    const urls = await declaredSubmodules(git, level.commit)
    const included = [...urls.keys()].filter((path) => {
      const named = level.prefix === "" ? path : join(level.prefix, path)
      return !excluded.some((root) => named === root || named.startsWith(`${root}/`))
    })
    for (const { path, sha } of await gitlinksAt(git, level.commit, included)) {
      const store = join(level.dir, path)
      stores.push(store)
      levels.push({ commit: sha, dir: store, prefix: level.prefix === "" ? path : join(level.prefix, path) })
    }
  }
  return stores
}

/** A component anchor whose root anchor is gone is an orphan, deleted at its expected OID. A store path that is not a
 * repository (a private or uninitialized submodule) holds no anchor and is skipped. */
async function sweepOrphans(
  rootGit: Git,
  gitIn: (cwd: string) => Git,
  clonePrefix: string,
  stores: ReadonlySet<string>,
  leftover: PreviewCustodyOptions["leftover"],
): Promise<void> {
  for (const store of stores) {
    if (!(await isRepositoryAt(gitIn, store))) continue
    const storeGit = gitIn(store)
    for (const ref of await refsUnder(storeGit, clonePrefix)) {
      if ((await refTarget(rootGit, ref.name)) !== undefined) continue
      try {
        await storeGit(["update-ref", "-d", ref.name, ref.oid])
      } catch (error) {
        leftover?.(`${store} keeps ${ref.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

async function refsUnder(git: Git, prefix: string): Promise<readonly Readonly<{ name: string; oid: string }>[]> {
  const listed = (await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix])).trim()
  if (listed === "") return []
  return listed.split("\n").map((line) => {
    const [name, oid] = line.split(" ")
    if (name === undefined || oid === undefined) throw new Error(`for-each-ref ${prefix} printed ${line}`)
    return { name, oid }
  })
}
