import { realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { inspectCheckoutGitMetadata, verifyRetainedCopy } from "git-super"
import type { GitWorktreeStore } from "git-super/worktree"
import {
  collectMovedGitlinks,
  createEventStore,
  createLocalEventStore,
  gitIn,
  isAncestor,
  isOpen,
  listRefs,
  openLog,
  readBranchHistory,
  readConfig,
  readEventQueueWithChanges,
  resolveGitSelection,
  readRemoteCommit,
  readStatus,
  refAt,
  registeredWorktrees,
  retireLocalBranch,
  remoteHead,
  remoteUrl,
  type Git,
  type GitSelection,
  type LocalBranchRetirement,
  type LocalBranchRetirementResult,
  type EventChange,
  type QueueLocation,
  type QueueConfig,
} from "@yrd/queue-core"
import type { ResolvedIssue } from "./issue-resolver.ts"
import type { YrdCliIO } from "./types.ts"
import { originHead } from "./queue-location.ts"
import { workdirOf } from "./workdir.ts"

/** Both landing and successful native release use the same root retirement caller. */
export async function retireMergedRootAuthor(
  input: Readonly<{
    repo: string
    git: Git
    branch: string
    change: EventChange
    base: string
    target: string
    actor: string
    io: YrdCliIO
    log: LocalBranchRetirement["log"]
    store: QueueLocation
    queue: string
  }>,
): Promise<LocalBranchRetirementResult> {
  const { change, branch, git, repo, log } = input
  const tip = change.commit
  const withdrawn = change.status === "cancelled" && change.reason === "withdrawn"
  if ((!withdrawn && change.status !== "merged") || tip === undefined || change.tip === undefined) {
    throw new Error(`${branch}: root retirement requires an exact merged or withdrawn submission and event tip`)
  }
  let disposition: LocalBranchRetirement["disposition"] =
    change.componentAuthors === undefined
      ? { kind: "merged", base: input.base, target: input.target }
      : { kind: "landed", target: input.target, proof: { kind: "ancestry" } }
  if (withdrawn) {
    if (await isAncestor(git, tip, input.target)) {
      disposition = { kind: "landed", target: input.target, proof: { kind: "ancestry" } }
    } else {
      const archives = await listRefs("refs/archive/", input.store)
      const archive = [...archives].find(
        ([ref, head]) => head === tip && /^refs\/archive\/[^/]+\/[^/]+\/(.+)$/u.exec(ref)?.[1] === branch,
      )
      if (archive === undefined || (await readRemoteCommit(git, input.store.remote, archive[0])) !== tip) {
        throw new Error(`${branch}@${tip}: withdrawn author has no exact same-branch origin archive; local ref kept`)
      }
      disposition = { kind: "archived", target: tip, ref: archive[0] }
    }
  }
  return retireLocalBranch({
    repo,
    git,
    branch,
    tip,
    actor: input.actor,
    owner: change.submitter,
    issue: change.issue,
    reason: withdrawn ? "withdrawn" : "merged",
    date: new Date().toISOString().slice(0, 10),
    log,
    protections: async () => {
      const current = await readStatus(input.store, input.queue, branch)
      if (
        current.status !== change.status ||
        current.reason !== change.reason ||
        current.commit !== tip ||
        current.tip !== change.tip
      ) {
        throw new Error(`${branch}: terminal history changed or reopened before root retirement`)
      }
      if (
        disposition.kind === "archived" &&
        (await readRemoteCommit(git, input.store.remote, disposition.ref)) !== tip
      ) {
        throw new Error(`${branch}@${tip}: origin archive custody changed before root retirement`)
      }
      return (await input.io.localBranchProtections?.({ repo, branch, tip, issue: change.issue })) ?? []
    },
    // Attributed submissions have a separate proven component judgment; the old root-only
    // warning remains correct only for submissions that recorded no component authors.
    disposition,
  })
}

/** The existing public store's retention report owns the proof shape. */
export type WorktreeRemovalProof = Parameters<
  NonNullable<NonNullable<Parameters<GitWorktreeStore["remove"]>[1]>["retention"]>["report"]
>[0]

export type AuthorRelease = Readonly<{
  /** Best-effort retirement after the native action has released the captured checkout. */
  retireAfterRelease(proof?: WorktreeRemovalProof): Promise<void>
  [Symbol.dispose](): void
}>

export type AuthorReleaseResult =
  | Readonly<{ kind: "eligible"; handle: AuthorRelease }>
  | Readonly<{ kind: "none"; reason: string }>
  | Readonly<{ kind: "unreadable"; reason: string; reads: readonly string[] }>

/** Public context adapter; no lifecycle mutation or host policy belongs here. */
export async function prepareAuthorRelease(checkout: string, io: YrdCliIO): Promise<AuthorReleaseResult> {
  const reads: string[] = []
  try {
    reads.push(`checkout metadata: ${checkout}`)
    const path = realpathSync(checkout)
    const metadata = await inspectCheckoutGitMetadata(path)
    reads.push(`Git selection: ${path}`)
    const selection = await resolveGitSelection(path)
    // The common store survives removal of the linked author checkout.
    const git = gitIn(metadata.commonDirectory, undefined, selection)
    reads.push(`native worktree registry: ${metadata.commonDirectory}`)
    const rows = await registeredWorktrees(git)
    const author = rows.find((row) => resolve(row.path) === path)
    if (author === undefined || author.head === undefined) {
      throw new Error(`${path}: no exact native checkout registration and HEAD`)
    }
    if (author.branch === undefined) return { kind: "none", reason: `${path}: detached checkout has no author branch` }
    // Git lists its primary worktree first. Validate its metadata instead of guessing a queue clone.
    const primary = rows[0]
    if (primary === undefined) throw new Error(`${path}: native registry has no primary worktree`)
    reads.push(`primary worktree metadata: ${primary.path}`)
    const primaryMetadata = await inspectCheckoutGitMetadata(primary.path)
    if (
      primaryMetadata.gitDirectory !== metadata.commonDirectory ||
      primaryMetadata.commonDirectory !== metadata.commonDirectory
    ) {
      throw new Error(`${path}: no active primary worktree in captured common store ${metadata.commonDirectory}`)
    }
    const treeGit = gitIn(path, undefined, selection)
    reads.push(`checkout HEAD and declaration: ${path}@${author.head}`)
    if ((await refAt(treeGit, "HEAD")) !== author.head) {
      throw new Error(`${path}: native checkout HEAD changed during capture`)
    }
    const config = await readConfig(treeGit, author.head, { branch: "HEAD", remote: "origin" })
    reads.push(`queue workdir and merged history: ${primary.path} branch ${author.branch}`)
    const workdir = await workdirOf(git, { cwd: primary.path })
    return await captureAuthorRelease({
      repo: primary.path,
      git,
      selection,
      branch: author.branch,
      tip: author.head,
      config,
      workdir,
      io,
      checkout: path,
      metadata,
      reads,
    })
  } catch (cause) {
    return { kind: "unreadable", reason: `${checkout}: author release capture kept refs: ${String(cause)}`, reads }
  }
}

/** The ONE release sequence used by native close and public host handles:
 * capture exact native identity, recheck its release, then fresh event/ref/store/protection/CAS and archive-first retire.
 */
async function captureAuthorRelease(
  input: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    branch: string
    tip: string
    config?: QueueConfig
    workdir: string
    io: YrdCliIO
    checkout: string
    metadata: Readonly<{ gitDirectory: string; commonDirectory: string }>
    reads: string[]
  }>,
): Promise<AuthorReleaseResult> {
  const { branch, tip } = input
  const remote = input.config?.target.remote ?? "origin"
  const configuredQueue = input.config?.target.branch
  const queue =
    configuredQueue === undefined || configuredQueue === "HEAD" ? await originHead(input.git, remote) : configuredQueue
  const url = await remoteUrl(input.git, remote)
  input.reads.push(`merged event history: ${url}#${queue} branch ${branch}`)
  const store = createEventStore(input.repo, url, input.selection)
  const { history } = await readBranchHistory(store, queue, branch)
  if (
    history === undefined ||
    (history.state.status !== "merged" &&
      !(history.state.status === "cancelled" && history.state.reason === "withdrawn"))
  ) {
    return {
      kind: "none",
      reason: `${url}#${queue}: ${branch} has ${history?.state.status ?? "no submitted"} history; no merged or withdrawn author ref to retire`,
    }
  }
  const change = history.state
  if (change.commit !== tip || (await refAt(input.git, `refs/heads/${branch}`)) !== tip) {
    throw new Error(`${branch}@${tip}: checkout no longer matches its merged submission and local ref`)
  }
  input.reads.push(`queue custody: ${store.remote}#${queue}`)
  const target = await readRemoteCommit(input.git, store.remote, `refs/heads/${queue}`)
  if (target === undefined) throw new Error(`${branch}: ${store.remote}#${queue} is missing; branch kept`)
  const log = openLog(join(input.workdir, "logs"))
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    try {
      log.finish()
    } catch (cause) {
      input.io.stderr(`yrd: ${branch}: release journal could not finish: ${String(cause)}\n`)
    }
  }
  try {
    log.write({
      kind: "run",
      command: "author release",
      config: input.config?.blob,
      target: `${store.remote}#${queue}`,
    })
    log.write({ kind: "queue", queue: `${store.remote}#${queue}` })
    let base = tip
    if (change.status === "merged" && change.componentAuthors?.length) {
      if (change.merge === undefined) throw new Error(`${branch}: merged history has no component landing commit`)
      const parent = await refAt(input.git, `${change.merge}^1`)
      if (parent === undefined) throw new Error(`${branch}: landing ${change.merge} has no readable parent`)
      base = parent
    }
    const captured = { ...input, branch, change, base, target, store, queue, log }
    const authors = change.status === "merged" ? await captureMergedComponentAuthors(captured) : []
    if (change.status !== "merged" && change.componentAuthors?.length) {
      input.io.stderr(`yrd: ${branch}: withdrawn component authors kept; no merged component landing was proved\n`)
    }
    let used = false
    let disposed = false
    return {
      kind: "eligible",
      handle: {
        async retireAfterRelease(proof) {
          if (disposed || used) {
            const error = new Error(
              `${branch}: author release handle ${disposed ? "was disposed" : "was already used"}`,
            )
            error.name = disposed ? "AuthorReleaseDisposed" : "AuthorReleaseAlreadyUsed"
            throw error
          }
          used = true
          let attempted = false
          try {
            const current = (await registeredWorktrees(input.git)).find((row) => resolve(row.path) === input.checkout)
            if (current !== undefined) {
              const metadata = await inspectCheckoutGitMetadata(input.checkout)
              if (
                metadata.commonDirectory !== input.metadata.commonDirectory ||
                metadata.gitDirectory !== input.metadata.gitDirectory
              ) {
                throw new Error(
                  `${input.checkout}: registered checkout metadata changed; released identity is unreadable`,
                )
              }
              if (current.branch === branch && current.head === tip) {
                throw new Error(
                  `${input.checkout}: still bound to captured ${branch}@${tip}; native release has not completed`,
                )
              }
            }
            if ((await inspectCheckoutGitMetadata(input.repo)).commonDirectory !== input.metadata.commonDirectory) {
              throw new Error(`${input.repo}: primary repository identity changed after capture`)
            }
            const freshTarget = await readRemoteCommit(input.git, store.remote, `refs/heads/${queue}`)
            if (freshTarget === undefined) {
              throw new Error(`${store.remote}#${queue}: queue custody became unreadable after release`)
            }
            const actor = globalThis.process.env.YRD_DEFAULT_SUBMITTER?.trim() || "yrd"
            attempted = true
            await retireMergedComponentAuthors({
              ...captured,
              authors,
              actor,
              proofs: proof === undefined ? [] : [proof],
            })
            const root = await retireMergedRootAuthor({ ...captured, target: freshTarget, actor })
            if (root.outcome !== "removed") {
              input.io.stderr(
                `yrd: ${branch}@${tip} ${root.outcome === "failed" ? "retirement failed; inspect ref and archive" : "kept after release"}: ${root.detail ?? root.reason}\n`,
              )
            }
          } catch (cause) {
            const outcome = attempted ? "retirement incomplete; inspect ref and archive" : "kept before retirement"
            input.io.stderr(`yrd: ${branch}@${tip} ${outcome}: ${String(cause)}\n`)
            try {
              log.write({
                kind: "warning",
                branch,
                scope: "local-branch-retirement",
                reason: `${outcome}: ${String(cause)}`,
              })
            } catch (journalCause) {
              input.io.stderr(`yrd: ${branch}: release warning journal failed: ${String(journalCause)}\n`)
            }
          }
        },
        [Symbol.dispose]() {
          disposed = true
          finish()
        },
      },
    }
  } catch (cause) {
    finish()
    throw cause
  }
}

type AuthorStore = Readonly<{
  path: string
  branch: string
  tip: string
  landing: string
  remote: string
  commonDirectory: string
  rootCommonDirectory: string
  rootGitDirectory: string
  rootCheckout: string
  rootBranch: string
  rootTip: string
  rootEventTip: string
  issue?: string
  owner?: string
}>

/** Capture native author stores before environment cleanup removes their checkout metadata.
 * The existing moved-pin collector owns recursive declaration and pin reads.
 */
export async function captureMergedComponentAuthors(
  input: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    env?: NodeJS.ProcessEnv
    branch: string
    change: EventChange
    base: string
    target: string
    log: LocalBranchRetirement["log"]
  }>,
): Promise<readonly AuthorStore[]> {
  const { change, branch, log } = input
  if (change.componentAuthors === undefined || change.componentAuthors.length === 0) return []
  const kept = (reason: string) => log.write({ kind: "warning", branch, scope: "local-branch-retirement", reason })
  const roots = (await registeredWorktrees(input.git)).filter(
    (row) => row.branch === branch && row.head === change.commit,
  )
  const root = roots[0]
  if (roots.length !== 1 || root === undefined || change.commit === undefined) {
    kept(
      `Component authors kept: ${branch}@${change.commit ?? "missing"} has ${roots.length} native author checkout matches in ${input.repo}; no queue-clone fallback`,
    )
    return []
  }
  const metadata = await inspectCheckoutGitMetadata(root.path)
  if (metadata.commonDirectory !== (await inspectCheckoutGitMetadata(input.repo)).commonDirectory) {
    throw new Error(`native author checkout ${root.path} changed repository identity`)
  }
  if (change.tip === undefined) throw new Error(`merged change ${branch} has no event tip`)
  const rootGit = gitIn(root.path, undefined, input.selection, { env: input.env })
  if ((await refAt(rootGit, "HEAD")) !== change.commit) {
    throw new Error(`native author checkout ${root.path} advanced during capture`)
  }
  const pins = await collectMovedGitlinks(rootGit, root.path, input.base, change.merge ?? input.target)
  const captured: AuthorStore[] = []
  for (const author of change.componentAuthors) {
    try {
      const pin = pins.find((pin) => pin.path === author.path)
      if (pin === undefined) throw new Error(`no moved landing gitlink for ${author.path}`)
      if ((await refAt(pin.child, `refs/heads/${author.branch}`)) !== author.tip) {
        throw new Error(`author ref ${author.branch} no longer names submitted tip ${author.tip}`)
      }
      if (!(await isAncestor(pin.child, author.tip, pin.sha))) {
        throw new Error(`landing ${pin.sha} does not retain submitted tip ${author.tip}`)
      }
      const child = await inspectCheckoutGitMetadata(pin.checkout)
      captured.push({
        ...author,
        landing: pin.sha,
        remote: pin.remote,
        commonDirectory: child.commonDirectory,
        rootCommonDirectory: metadata.commonDirectory,
        rootGitDirectory: metadata.gitDirectory,
        rootCheckout: root.path,
        rootBranch: branch,
        rootTip: change.commit,
        rootEventTip: change.tip,
        issue: change.issue,
        owner: change.submitter,
      })
    } catch (cause) {
      kept(`Component author ${author.path} ${author.branch}@${author.tip} kept: ${String(cause)}`)
    }
  }
  return captured
}

/** An active primary materialization must still belong to the trusted root registry.
 * A copied retained store or a borrower alone does not establish mutable custody.
 */
async function activeAuthorCheckout(
  author: AuthorStore,
  selection: GitSelection,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const storeGit = gitIn(author.commonDirectory, undefined, selection, { env })
  const checkout = realpathSync((await storeGit(["rev-parse", "--show-toplevel"])).trim())
  const metadata = await inspectCheckoutGitMetadata(checkout)
  if (metadata.commonDirectory !== author.commonDirectory || metadata.gitDirectory !== author.commonDirectory) {
    throw new Error(
      `no independent active primary checkout for ${author.commonDirectory}; retained snapshots and borrowers remain unchanged`,
    )
  }
  const parent = author.path.split("/").reduce((path) => dirname(path), checkout)
  if (realpathSync(join(parent, author.path)) !== checkout) {
    throw new Error(`primary checkout ${checkout} does not match component path ${author.path}`)
  }
  const rootGit = gitIn(author.rootCommonDirectory, undefined, selection, { env })
  const roots = await registeredWorktrees(rootGit)
  if (!roots.some((row) => resolve(row.path) === parent)) {
    throw new Error(`primary component checkout ${checkout} has no surviving native root registration`)
  }
  if ((await inspectCheckoutGitMetadata(parent)).commonDirectory !== author.rootCommonDirectory) {
    throw new Error(`primary component root ${parent} changed repository identity`)
  }
  return checkout
}

/** The landing and native release callers share exact captured candidates and custody judgment. */
export async function retireMergedComponentAuthors(
  input: Readonly<{
    authors: readonly AuthorStore[]
    selection: GitSelection
    env?: NodeJS.ProcessEnv
    actor: string
    io: YrdCliIO
    log: LocalBranchRetirement["log"]
    store: QueueLocation
    queue: string
    proofs?: readonly WorktreeRemovalProof[]
  }>,
): Promise<void> {
  for (const author of input.authors) {
    try {
      const modules = join(author.rootGitDirectory, "modules")
      const inside = relative(modules, author.commonDirectory)
      // A primary root's modules survive; only a linked root's private admin store ends on close.
      if (
        author.rootGitDirectory !== author.rootCommonDirectory &&
        inside !== "" &&
        inside !== ".." &&
        !inside.startsWith(`..${sep}`) &&
        !isAbsolute(inside)
      ) {
        const proof = input.proofs?.find((candidate) => resolve(candidate.path) === resolve(author.rootCheckout))
        if (proof === undefined) throw new Error("root-owned component store kept: no sealed proof")
        if (proof.head !== author.rootTip || resolve(proof.modules) !== resolve(modules) || proof.retained === null) {
          throw new Error(
            `root-owned component store kept: removal proof identity does not match ${author.rootCheckout}@${author.rootTip}`,
          )
        }
        const sealed = verifyRetainedCopy(proof, author.rootCommonDirectory)
        if (sealed.status !== "ok") {
          throw new Error(
            `root-owned component store kept: sealed proof ${proof.manifest} failed: ${JSON.stringify(sealed)}`,
          )
        }
        const retained = realpathSync(proof.retained)
        const copiedStore = realpathSync(join(retained, inside))
        const copiedInside = relative(retained, copiedStore)
        if (
          copiedInside === "" ||
          copiedInside === ".." ||
          copiedInside.startsWith(`..${sep}`) ||
          isAbsolute(copiedInside)
        ) {
          throw new Error(`root-owned component store kept: ${copiedStore} is outside sealed copy ${retained}`)
        }
        const git = gitIn(copiedStore, undefined, input.selection, { env: input.env })
        // Like GitSuper's retained reader, --bare avoids the sealed config's vanished core.worktree.
        const finalTip = (
          await git(["--bare", "for-each-ref", "--format=%(objectname)", `refs/heads/${author.branch}`])
        ).trim()
        const unchanged = verifyRetainedCopy(proof, author.rootCommonDirectory)
        if (unchanged.status !== "ok") {
          throw new Error(
            `root-owned component store kept: sealed proof changed while reading ${proof.manifest}: ${JSON.stringify(unchanged)}`,
          )
        }
        if (finalTip !== author.tip) {
          throw new Error(
            `root-owned component store kept: final ref refs/heads/${author.branch} advanced or absent; captured ${author.tip}, sealed ${finalTip || "absent"}; proof ${proof.manifest}`,
          )
        }
        const reason = `ended with its root: refs/heads/${author.branch}@${author.tip}; landing ${author.landing}; sealed proof ${proof.manifest}; retain until ${proof.retainUntil}`
        input.io.stderr(`yrd: component ${author.path} ${reason}\n`)
        input.log.write({ kind: "observation", branch: author.branch, scope: "local-branch-retirement", reason })
        continue
      }
      const repo = await activeAuthorCheckout(author, input.selection, input.env)
      const git = gitIn(repo, undefined, input.selection, { env: input.env })
      // One fresh default-branch read per action. Unreadable authority is caught below before custody changes.
      let defaultBranch: string
      try {
        defaultBranch = await remoteHead(git, author.remote)
      } catch (cause) {
        throw new Error(`protected component default unreadable in ${repo} from ${author.remote}: ${String(cause)}`)
      }
      const target = await readRemoteCommit(git, author.remote, "refs/heads/main")
      if (target === undefined) throw new Error(`${repo} has no ${author.remote}#main`)
      const retire = createLandedBranchRetirement({
        repo,
        git,
        selection: input.selection,
        remote: author.remote,
        target,
      })
      const result = await retire({
        path: author.path,
        landings: [],
        branch: author.branch,
        tip: author.tip,
        actor: input.actor,
        owner: author.owner,
        issue: author.issue,
        reason: "merged",
        date: new Date().toISOString().slice(0, 10),
        log: input.log,
        protections: async () => {
          if (author.branch === "main" || author.branch === defaultBranch) {
            return [`protected component target/default branch ${author.branch} in ${repo} from ${author.remote}`]
          }
          await activeAuthorCheckout(author, input.selection, input.env)
          const state = await readStatus(input.store, input.queue, author.rootBranch)
          if (state.status !== "merged" || state.commit !== author.rootTip || state.tip !== author.rootEventTip) {
            throw new Error(`root change ${author.rootBranch} changed or reopened since author capture`)
          }
          const rootGit = gitIn(author.rootCommonDirectory, undefined, input.selection, { env: input.env })
          if ((await refAt(rootGit, `refs/heads/${author.rootBranch}`)) !== author.rootTip) {
            throw new Error(`root author ${author.rootBranch} advanced since capture`)
          }
          return [
            ...((await input.io.localBranchProtections?.({
              repo,
              branch: author.branch,
              tip: author.tip,
              issue: author.issue,
            })) ?? []),
            ...((await input.io.localBranchProtections?.({
              repo: author.rootCommonDirectory,
              branch: author.rootBranch,
              tip: author.rootTip,
              issue: author.issue,
            })) ?? []),
          ]
        },
      })
      if (result.outcome !== "removed") {
        input.io.stderr(
          `yrd: component ${author.path} ${author.branch}@${author.tip} ${result.outcome === "failed" ? "retirement failed; inspect ref and archive" : "kept"}: ${result.detail ?? result.reason}\n`,
        )
        input.log.write({
          kind: "warning",
          branch: author.branch,
          scope: "local-branch-retirement",
          reason: `${author.path} ${result.outcome === "failed" ? "retirement failed; inspect ref and archive" : "kept"}: ${result.detail ?? result.reason}`,
        })
      }
    } catch (cause) {
      input.io.stderr(
        `yrd: component ${author.path} ${author.branch}@${author.tip} retirement incomplete; inspect ref and archive: ${String(cause)}\n`,
      )
      input.log.write({
        kind: "warning",
        branch: author.branch,
        scope: "local-branch-retirement",
        reason: `${author.path} ${author.branch}@${author.tip} retirement incomplete; inspect ref and archive: ${String(cause)}`,
      })
    }
  }
}

type LandingPin = Readonly<{ event: string; path: string; tip: string }>
type LandedCandidate = Omit<LocalBranchRetirement, "repo" | "git" | "disposition" | "reason"> &
  Readonly<{
    path: string
    landings: readonly LandingPin[]
    reason?: string
    /** 29450: the candidate's issue is closed or dropped, so a tip with no custody is archived to origin and
     * ended with a `dropped` event (the closed disposition) instead of being kept `unreached`. */
    closed?: Readonly<{ store: QueueLocation; queue: string }>
  }>

/** One store's origin-custody judgment, shared by explicit landing candidates and manual issue selection.
 * Selection stays with the caller; this operation never enumerates or guesses author branches.
 */
export function createLandedBranchRetirement(
  store: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    remote: string
    target: string
  }>,
) {
  let remoteRefs: ReadonlyMap<string, string> | undefined
  return async (
    candidate: LandedCandidate,
  ): Promise<
    Omit<LocalBranchRetirementResult, "archiveRef"> & {
      archiveRef?: string
      /** What held the tip when it was removed: main (ancestry), a recorded landing, or the origin archive (closed). */
      custody?: "main" | "landing" | "origin"
    }
  > => {
    const { repo, git, remote, selection, target } = store
    const { path, landings, reason, closed, ...retirement } = candidate
    const pin = landings.find((pin) => pin.path === path && pin.tip === candidate.tip)
    let custody: string | undefined = (await isAncestor(git, candidate.tip, target)) ? target : undefined
    let proof: { kind: "ancestry" } | { kind: "landing"; event: string; path: string; tip: string } = {
      kind: "ancestry",
    }
    if (custody === undefined && pin !== undefined) {
      // A root gitlink retains no component object. Observe custody at component origin as well.
      remoteRefs ??= await listRefs("refs/", createEventStore(repo, remote, selection))
      for (const [ref] of remoteRefs) {
        const reached = await readRemoteCommit(git, remote, ref)
        if (reached !== undefined && (await isAncestor(git, candidate.tip, reached))) {
          custody = reached
          proof = { kind: "landing", ...pin }
          break
        }
      }
    }
    if (custody === undefined) {
      if (closed !== undefined) {
        // work.md § Events first: a close archives, then removes, its unmerged branches. The closed
        // disposition publishes the archive ref and the `dropped` event to origin in one write and reads
        // both back before the compare-and-delete; a tip nobody archived is never deleted.
        const ended = await retireLocalBranch({
          ...retirement,
          repo,
          git,
          reason: reason ?? "closed issue",
          disposition: { kind: "closed", store: closed.store, queue: closed.queue, target },
        })
        return { ...ended, custody: "origin" }
      }
      return {
        outcome: "kept",
        reason: "unreached",
        detail: `tip has no main ancestry or origin-retained exact landing pin in ${repo}`,
      }
    }
    const landed = await retireLocalBranch({
      ...retirement,
      repo,
      git,
      reason: reason ?? `landed by ${proof.kind}`,
      disposition: { kind: "landed", target: custody, proof },
    })
    return { ...landed, custody: proof.kind === "ancestry" ? "main" : "landing" }
  }
}

// ---------------------------------------------------------------------------
// 29450 — closing an issue retires its branches
//
// work.md § Events first: "Closing an issue archives, then removes, its unmerged branches, so 'closed,
// code left' cannot form." A close happens three ways (km bd close, merge-close, a hand edit of the file),
// all of which end as the issue's status, so the service's round reads that status through the declared
// resolver and retires the branches bound to closed or dropped issues through the one removal path.
// Ruled by @cto dd209c0b (2026-10-15): the queue round is the consumer; time-based cadence; a resolver
// failure keeps everything and is named; the delete is compare-and-delete against the archived tip.

/** Issue statuses the declared resolver answers that end an issue (work.md:26: a dropped `[-]` ends it too). */
export const CLOSED_ISSUE_STATUSES: ReadonlySet<string> = new Set(["closed", "dropped"])

const CLOSED_ISSUE_SWEEP_INTERVAL_MS = 3_600_000
/** The last sweep per authoring repository in THIS process: absent means the service just started. */
const closedIssueSweeps = new Map<string, number>()

/** Sweep at service start, after any round that merged, and when an hour has passed since the last sweep. */
export function closedIssueSweepDue(input: Readonly<{ repo: string; merged: number; now: number }>): boolean {
  const last = closedIssueSweeps.get(input.repo)
  return last === undefined || input.merged > 0 || input.now - last >= CLOSED_ISSUE_SWEEP_INTERVAL_MS
}

export function markClosedIssueSweep(repo: string, now: number): void {
  closedIssueSweeps.set(repo, now)
}

export type ClosedIssueRetirementRow = Readonly<{
  branch: string
  head: string
  issue?: string
  status?: string
  outcome: "removed" | "kept" | "failed"
  reason: string
  detail?: string
  archiveRef?: string
  /** What held the removed tip: main, a recorded landing, or the origin archive. */
  custody?: "main" | "landing" | "origin"
  /** For a tip the origin archive holds: the one command that brings it back as a branch. */
  recovery?: string
}>

export type ClosedIssueRetirementReport = Readonly<{
  repo: string
  /** The target commit every tip was judged against. */
  target: string
  /** Local `task/*` and `exp/*` heads other than the target branch. */
  examined: number
  /** Heads with no recorded change and no issue number in their name. */
  unnumbered: number
  /** Heads with no recorded change whose name alone carries an issue number: kept and listed, never judged (work.md:99). */
  boundByNameOnly: number
  /** Bound to an issue the resolver did not answer with exactly one bead; each is also a kept row. */
  unknownIssues: number
  /** Bound to an issue that is still open. */
  openIssues: number
  /** Distinct closed or dropped issues that still had a branch. */
  closedIssues: number
  removed: readonly ClosedIssueRetirementRow[]
  kept: readonly ClosedIssueRetirementRow[]
  failed: readonly ClosedIssueRetirementRow[]
  /** Set when nothing was judged — no protections reader, no resolver, or the resolver failed: every branch kept. */
  everyBranchKept?: string
}>

export type ClosedIssueRetirementInput = Readonly<{
  repo: string
  git: Git
  selection: GitSelection
  /** The queue's event store at origin; the closed disposition publishes archive and ending through it. */
  store: QueueLocation
  queue: string
  /** The target branch's commit at origin after this round: custody for a merged tip. */
  target: string
  io: YrdCliIO
  log: LocalBranchRetirement["log"]
  actor: string
  date?: string
  /** The issue number a branch NAME carries, for the receipt of a branch that binds by name alone; never eligibility. */
  nameNumber: (branch: string) => string | undefined
  /** One resolver run over every bound reference; absent when the target declares no resolver. */
  lookupMany: ((raws: readonly string[]) => Promise<readonly (ResolvedIssue | null)[]>) | undefined
}>

/**
 * Retire the local branches bound to closed or dropped issues (29450). Each branch's tip is judged by
 * `createLandedBranchRetirement`: on main → landed (archived locally, compare-and-deleted); otherwise
 * → the closed disposition (archive and `dropped` event published to origin and read back, then
 * compare-and-deleted). A worktree-held or moved branch is kept and names why. A resolver that fails,
 * or answers no bound bead for a reference, keeps those branches: unknown is never read as closed. This
 * operation reports every failure in its rows and never throws into the merge round.
 */
export async function retireClosedIssueBranches(
  input: ClosedIssueRetirementInput,
): Promise<ClosedIssueRetirementReport> {
  const { repo, git, selection, store, queue, target, io, log, actor } = input
  const date = input.date ?? new Date().toISOString().slice(0, 10)
  const removed: ClosedIssueRetirementRow[] = []
  const kept: ClosedIssueRetirementRow[] = []
  const failed: ClosedIssueRetirementRow[] = []
  let examined = 0
  let unnumbered = 0
  let boundByNameOnly = 0
  let unknownIssues = 0
  let openIssues = 0
  const closedIssues = new Set<string>()
  const summary = (everyBranchKept?: string): ClosedIssueRetirementReport => {
    const report: ClosedIssueRetirementReport = {
      repo,
      target,
      examined,
      unnumbered,
      boundByNameOnly,
      unknownIssues,
      openIssues,
      closedIssues: closedIssues.size,
      removed,
      kept,
      failed,
      ...(everyBranchKept === undefined ? {} : { everyBranchKept }),
    }
    log.write({
      kind: "closed-issue-retirement",
      scope: "summary",
      repo,
      target,
      examined,
      unnumbered,
      boundByNameOnly,
      unknownIssues,
      openIssues,
      closedIssues: closedIssues.size,
      removed: removed.length,
      kept: kept.length,
      failed: failed.length,
      ...(everyBranchKept === undefined ? {} : { everyBranchKept }),
    })
    io.stderr(
      `yrd: closed-issue sweep in ${repo} against ${target.slice(0, 12)}: examined ${examined}, closed issues ${closedIssues.size}, ` +
        `retired ${removed.length}, kept ${kept.length}, failed ${failed.length}` +
        (everyBranchKept === undefined ? "" : `; every branch kept: ${everyBranchKept}`) +
        "\n",
    )
    return report
  }
  const record = (row: ClosedIssueRetirementRow): void => {
    ;(row.outcome === "removed" ? removed : row.outcome === "kept" ? kept : failed).push(row)
    log.write({
      kind: "closed-issue-retirement",
      branch: row.branch,
      head: row.head,
      outcome: row.outcome,
      reason: row.reason,
      ...(row.issue === undefined ? {} : { issue: row.issue }),
      ...(row.status === undefined ? {} : { status: row.status }),
      ...(row.detail === undefined ? {} : { detail: row.detail }),
      ...(row.archiveRef === undefined ? {} : { archive: row.archiveRef }),
      ...(row.custody === undefined ? {} : { custody: row.custody }),
      ...(row.recovery === undefined ? {} : { recovery: row.recovery }),
    })
  }

  // Inventory: the local heads and the queue's recorded changes, read once.
  const heads = await listRefs("refs/heads/", createLocalEventStore(repo, selection))
  const reading = await readEventQueueWithChanges(store, queue)
  type Candidate = { branch: string; head: string; raw: string; change: EventChange | undefined }
  const candidates: Candidate[] = []
  for (const [ref, head] of heads) {
    const branch = ref.slice("refs/heads/".length)
    if (branch === queue || !/^(task|exp)\//u.test(branch)) continue
    examined++
    const change = reading.histories.get(branch)?.state
    // review @dev/review2 ee911aeb: an unreadable history proves nothing about status or custody, so it is kept and
    // named before any eligibility — the boundary the hand verb (`drop --issue`) already applies: an invalid chain,
    // or a change whose fold carries a diagnostic (an event this reader could not fold).
    const invalid = reading.invalid.get(branch)
    if (invalid !== undefined) {
      record({
        branch,
        head,
        outcome: "kept",
        reason: "unreadable",
        detail: `${invalid.ref}@${invalid.tip}: ${invalid.error}`,
      })
      continue
    }
    if (change?.diagnostic !== undefined) {
      record({ branch, head, outcome: "kept", reason: "unreadable", detail: change.diagnostic })
      continue
    }
    // @cto bbec7bb5 (work.md:99): eligibility comes from the canonical binding only — the recorded change's issue.
    // A branch that binds by its name alone is kept and listed; binding it through its commits' Refs trailers is
    // the named follow-up (the reader 29113 uses is not in yrd's io today). A person's `drop --issue` keeps its
    // explicit argument: naming the issue is not a name match.
    const raw = change?.issue
    if (raw === undefined) {
      const named = input.nameNumber(branch)
      if (named === undefined) {
        unnumbered++
      } else {
        boundByNameOnly++
        record({
          branch,
          head,
          outcome: "kept",
          reason: "bound by name only",
          detail: `issue ${named} from the branch name; no recorded change binds this branch`,
        })
      }
      continue
    }
    candidates.push({ branch, head, raw, change })
  }
  if (candidates.length === 0) return summary()
  // @cto b023d5e2 blocking 1: the host's protections reader (holds, leases, declared cwds, live use) is the one read
  // that stands between this sweep and a seat's checkout. Absent, nothing is judged and the receipt says so; an
  // absent reader is never read as "nothing is held".
  const protectionsReader = io.localBranchProtections
  if (protectionsReader === undefined) {
    return summary("no localBranchProtections reader; every branch kept")
  }
  if (input.lookupMany === undefined) {
    return summary("target declaration has no issueResolver; issue status unproven")
  }
  const raws = [...new Set(candidates.map((candidate) => candidate.raw))]
  let resolved: ReadonlyMap<string, ResolvedIssue | null>
  try {
    const answers = await input.lookupMany(raws)
    resolved = new Map(raws.map((raw, index) => [raw, answers[index] ?? null]))
  } catch (error) {
    return summary(`resolver failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const retire = createLandedBranchRetirement({ repo, git, selection, remote: store.remote, target })
  for (const { branch, head, raw, change } of candidates) {
    const issue = resolved.get(raw)
    if (issue === null || issue === undefined) {
      // @cto b023d5e2 small 3: a per-row receipt, so the resolver's gaps are visible in the first sweep's 91 rows.
      unknownIssues++
      record({
        branch,
        head,
        outcome: "kept",
        reason: "unknown issue",
        detail: `the resolver answered no single bead for ${raw}`,
      })
      continue
    }
    const status = typeof issue.status === "string" ? issue.status : undefined
    if (status === undefined || !CLOSED_ISSUE_STATUSES.has(status)) {
      openIssues++
      continue
    }
    closedIssues.add(issue.id)
    if (change !== undefined && isOpen(change.status)) {
      record({
        branch,
        head,
        issue: issue.id,
        status,
        outcome: "kept",
        reason: "active",
        detail: `change is ${change.status}`,
      })
      continue
    }
    try {
      // @cto b023d5e2 blocking 2: a merged change's custody is its merged event and recorded landing, never
      // ancestry alone — the queue rebuilds branches, so a merged tip need not be an ancestor of main. The pin lets
      // the judgment prove "landing" and the branch retires as landed, never as closed.
      const landings =
        change?.status === "merged" && change.commit !== undefined && change.ending !== undefined
          ? [{ event: change.ending.id, path: "", tip: change.commit }]
          : []
      // @cto 9a68f296 (the residual of blocking 2): a chain that ended merged takes no second ending. The closed
      // disposition is for a branch no landing holds; a merged change whose tip moved past its landing (no pin at
      // the tip, no ancestry) is kept and named, never archived as closed.
      const merged = change?.status === "merged" ? change.commit : undefined
      const result = await retire({
        path: "",
        landings,
        branch,
        tip: head,
        actor,
        owner: change?.submitter,
        issue: issue.id,
        date,
        log,
        protections: () => protectionsReader({ repo, branch, tip: head, issue: issue.id }),
        ...(merged === undefined ? { closed: { store, queue } } : {}),
      })
      const archiveRef = result.archiveRef
      const reason =
        merged !== undefined && merged !== head && result.outcome === "kept" && result.reason === "unreached"
          ? `merged at ${merged}; tip has commits past the landing`
          : result.reason
      record({
        branch,
        head,
        issue: issue.id,
        status,
        outcome: result.outcome === "removed" ? "removed" : result.outcome === "failed" ? "failed" : "kept",
        reason,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        ...(archiveRef === undefined ? {} : { archiveRef }),
        ...(result.custody === undefined ? {} : { custody: result.custody }),
        // The recovery command is for a tip only the origin archive holds; main and a recorded landing keep the rest.
        ...(result.outcome === "removed" && archiveRef !== undefined && result.custody === "origin"
          ? { recovery: `git -C ${repo} fetch ${store.remote} ${archiveRef}:refs/heads/${branch}` }
          : {}),
      })
    } catch (error) {
      record({
        branch,
        head,
        issue: issue.id,
        status,
        outcome: "failed",
        reason: "failed",
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return summary()
}
