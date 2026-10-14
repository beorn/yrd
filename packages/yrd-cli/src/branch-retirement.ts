import { realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { inspectCheckoutGitMetadata } from "git-super"
import {
  collectMovedGitlinks,
  createEventStore,
  gitIn,
  isAncestor,
  listRefs,
  openLog,
  readBranchHistory,
  readConfig,
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
  if (change.status !== "merged" || tip === undefined || change.tip === undefined) {
    throw new Error(`${branch}: root retirement requires an exact merged submission and event tip`)
  }
  return retireLocalBranch({
    repo,
    git,
    branch,
    tip,
    actor: input.actor,
    owner: change.submitter,
    issue: change.issue,
    reason: "merged",
    date: new Date().toISOString().slice(0, 10),
    log,
    protections: async () => {
      const current = await readStatus(input.store, input.queue, branch)
      if (current.status !== "merged" || current.commit !== tip || current.tip !== change.tip) {
        throw new Error(`${branch}: merged history changed or reopened before root retirement`)
      }
      return (await input.io.localBranchProtections?.({ repo, branch, tip, issue: change.issue })) ?? []
    },
    // Attributed submissions have a separate proven component judgment; the old root-only
    // warning remains correct only for submissions that recorded no component authors.
    disposition:
      change.componentAuthors === undefined
        ? { kind: "merged", base: input.base, target: input.target }
        : { kind: "landed", target: input.target, proof: { kind: "ancestry" } },
  })
}

export type AuthorRelease = Readonly<{
  /** Best-effort retirement after the native action has released the captured checkout. */
  retireAfterRelease(): Promise<void>
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
  if (history === undefined || history.state.status !== "merged") {
    return {
      kind: "none",
      reason: `${url}#${queue}: ${branch} has ${history?.state.status ?? "no submitted"} history; no merged author ref to retire`,
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
    if (change.componentAuthors?.length) {
      if (change.merge === undefined) throw new Error(`${branch}: merged history has no component landing commit`)
      const parent = await refAt(input.git, `${change.merge}^1`)
      if (parent === undefined) throw new Error(`${branch}: landing ${change.merge} has no readable parent`)
      base = parent
    }
    const captured = { ...input, branch, change, base, target, store, queue, log }
    const authors = await captureMergedComponentAuthors(captured)
    let used = false
    let disposed = false
    return {
      kind: "eligible",
      handle: {
        async retireAfterRelease() {
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
            await retireMergedComponentAuthors({ ...captured, authors, actor })
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
  }>,
): Promise<void> {
  for (const author of input.authors) {
    try {
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
  Readonly<{ path: string; landings: readonly LandingPin[]; reason?: string }>

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
  ): Promise<Omit<LocalBranchRetirementResult, "archiveRef"> & { archiveRef?: string }> => {
    const { repo, git, remote, selection, target } = store
    const { path, landings, reason, ...retirement } = candidate
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
      return {
        outcome: "kept",
        reason: "unreached",
        detail: `tip has no main ancestry or origin-retained exact landing pin in ${repo}`,
      }
    }
    return retireLocalBranch({
      ...retirement,
      repo,
      git,
      reason: reason ?? `landed by ${proof.kind}`,
      disposition: { kind: "landed", target: custody, proof },
    })
  }
}
