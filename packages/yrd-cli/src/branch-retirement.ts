import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { archiveRefFor, ensureArchiveRef, readArchiveRows } from "git-super/archive-ref"
import { readCommitSubmodules } from "git-super/commit-graph"
import { createGitWorktreeStore } from "git-super/worktree"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { inspectCheckoutGitMetadata, verifyRetainedCopy } from "git-super"
import type { GitWorktreeStore } from "git-super/worktree"
import {
  collectMovedGitlinks,
  drop,
  issueFromBranchName,
  seamProcess,
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
import type { LocalBranchProtectionResult, YrdCliIO } from "./types.ts"
import { originHead } from "./queue-location.ts"
import { workdirOf } from "./workdir.ts"
import { admitEnvironmentClose } from "./env-close-holders.ts"

/** The existing per-repository custody step, shared by component drops and retained checkout release. */
async function publishRetirementArchive(
  input: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    remote: string
    archiveRef: string
    tip: string
  }>,
): Promise<void> {
  const { repo, git, selection, remote, archiveRef, tip } = input
  const archive = ensureArchiveRef(repo, archiveRef, tip)
  if (!archive.ok) throw new Error(archive.reason)
  const store = createEventStore(repo, remote, selection)
  const previous = (await listRefs(archiveRef, store)).get(archiveRef)
  if (previous !== undefined && previous !== tip) {
    throw new Error(`${repo}: origin archive holds ${previous}, not ${tip}`)
  }
  if (store.backend.publish === undefined) throw new Error(`${repo}: Gitomic backend lacks archive publication`)
  await store.backend.publish(repo, [{ ref: archiveRef, expect: previous ?? "0".repeat(tip.length), oid: tip }], remote)
  if ((await readRemoteCommit(git, remote, archiveRef)) !== tip) {
    throw new Error(`${repo}: archive custody did not read back; local refs kept`)
  }
}

/** Plain component-local cleanup has no queue event; its declared owner's existing log owns the result. */
export async function retireComponentLocalBranch(
  input: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    env?: NodeJS.ProcessEnv
    io: YrdCliIO
    request: Readonly<{ branch: string; tip: string; by: string; issue?: string; reason?: string }>
  }>,
) {
  const { repo, git, selection, env, io, request } = input
  try {
    lstatSync(join(repo, ".yrd.yml"))
    throw new Error(`${repo}: local .yrd.yml exists but the selected target has no declaration`)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
  let owner = (await git(["rev-parse", "--show-superproject-working-tree"])).trim()
  while (owner !== "") {
    const ownerGit = gitIn(owner, undefined, selection, { env })
    const queue = await originHead(ownerGit)
    const ownerTarget = await readRemoteCommit(ownerGit, "origin", `refs/heads/${queue}`)
    if (ownerTarget === undefined) throw new Error(`${owner}: owning queue target origin/${queue} is absent`)
    const config = await readConfig(ownerGit, ownerTarget, { remote: "origin", branch: queue })
    if (config === undefined) {
      owner = (await ownerGit(["rev-parse", "--show-superproject-working-tree"])).trim()
      continue
    }
    const targetBranch = await originHead(git)
    if (request.branch === targetBranch || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(request.tip)) {
      throw new Error(`${repo}: drop --local requires a non-target branch and a full expected commit oid`)
    }
    const remote = await remoteUrl(git, "origin")
    const target = await readRemoteCommit(git, remote, `refs/heads/${targetBranch}`)
    if (target === undefined) throw new Error(`${repo}: target origin/${targetBranch} is absent`)
    const log = openLog(join(await workdirOf(ownerGit, { cwd: owner, env }), "logs"))
    log.write({ kind: "run", command: "drop --local", target: `origin/${queue}`, config: config.blob })
    const date = new Date().toISOString().slice(0, 10)
    const archiveRef = archiveRefFor(request.branch, request.by, date)
    try {
      const observedTip = await refAt(git, `refs/heads/${request.branch}`)
      if (observedTip === undefined) {
        throw new Error(`${repo}: refs/heads/${request.branch} is absent; nothing was removed`)
      }
      const merged = await isAncestor(git, request.tip, target)
      const protections = async (): Promise<readonly string[]> => {
        const host =
          (await io.localBranchProtections?.({ repo, branch: request.branch, tip: request.tip, issue: request.issue }))
            ?.protections ?? []
        if (!merged && (await readRemoteCommit(git, remote, archiveRef)) !== request.tip) {
          throw new Error(`${repo}: archive custody changed before conditional removal`)
        }
        return host
      }
      const retirement = {
        repo,
        git,
        branch: request.branch,
        tip: request.tip,
        actor: request.by,
        issue: request.issue,
        reason: request.reason ?? "explicit local branch cleanup",
        date,
        log,
        disposition: merged
          ? { kind: "merged" as const, base: target, target }
          : { kind: "archived" as const, target: request.tip, ref: archiveRef },
      }
      let result: LocalBranchRetirementResult
      if (!merged) {
        // The same policy's existing preview checks native and host protections before custody is written.
        const preview = await retireLocalBranch({
          ...retirement,
          dryRun: true,
          protections: async () =>
            (
              await io.localBranchProtections?.({
                repo,
                branch: request.branch,
                tip: request.tip,
                issue: request.issue,
              })
            )?.protections ?? [],
        })
        if (preview.outcome !== "eligible") result = preview
        else {
          await publishRetirementArchive({ repo, git, selection, remote, archiveRef, tip: request.tip })
          result = await retireLocalBranch({ ...retirement, protections })
        }
      } else result = await retireLocalBranch({ ...retirement, protections })
      const row = {
        branch: request.branch,
        head: observedTip,
        archiveRef: result.archiveRef,
        reason: result.outcome === "failed" ? `${repo}: ${result.reason}` : result.reason,
        detail: result.detail,
      }
      return {
        removed: result.outcome === "removed" ? [row] : [],
        kept: result.outcome === "kept" ? [row] : [],
        failed: result.outcome === "failed" ? [row] : [],
      }
    } catch (cause) {
      const reason = `${repo}: ${cause instanceof Error ? cause.message : String(cause)}`
      log.write({
        kind: "local-branch-retirement",
        repo,
        branch: request.branch,
        head: request.tip,
        actor: request.by,
        issue: request.issue,
        archive: archiveRef,
        reason,
        outcome: "failed",
      })
      return { removed: [], kept: [], failed: [{ branch: request.branch, head: request.tip, archiveRef, reason }] }
    } finally {
      log.finish()
    }
  }
  return undefined
}

/** Explicit exact-tip drop retaining the checkout and its private bytes.
 * The root event owns the environment receipt; each repository owns its archive.
 */
export async function releaseRetainedCheckouts(
  input: Readonly<{
    repo: string
    git: Git
    selection: GitSelection
    env?: NodeJS.ProcessEnv
    io: YrdCliIO
    log: LocalBranchRetirement["log"]
    queue: string
    remote: string
    issueIdentity: (value: string) => string
    request: Readonly<{
      branch: string
      tip: string
      issue: string
      reason: string
      by: string
      submodules?: boolean
      apply?: boolean
    }>
  }>,
) {
  const { request, io } = input
  // Transport keeps the configured URL; receipts and diagnostics never retain
  // its userinfo. Match URLs within error text as well as standalone origins.
  const publicText = (value: string) => value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/giu, "$1")
  type Row = {
    repo: string
    path: string
    branch: string
    head: string
    archiveRef: string
    remote: string
    reason: string
    detail?: string
  }
  const eligible: Row[] = [],
    removed: Row[] = [],
    alreadyRetired: Row[] = [],
    kept: Row[] = [],
    failed: Row[] = []
  const excluded: { repo: string; path: string; reason: string }[] = []
  const evidence: LocalBranchProtectionResult["evidence"][number][] = []
  const identity = input.issueIdentity
  const date = new Date().toISOString().slice(0, 10)
  const rootRow: Row = {
    repo: input.repo,
    path: "",
    branch: request.branch,
    head: request.tip,
    remote: publicText(input.remote),
    archiveRef: archiveRefFor(request.branch, request.by, date),
    reason: publicText(request.reason),
  }
  type Candidate = { row: Row; remote: string; checkout: string; git: Git; retired: boolean; detached: boolean }
  const candidates: Candidate[] = []
  const readGit = (repo: string) => gitIn(repo, undefined, input.selection, { env: input.env })
  const overlaps = (root: string, path: string) => {
    const inside = relative(root, path)
    return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  }
  const protect = async ({ row, checkout }: Candidate): Promise<readonly string[]> => {
    const admission = await admitEnvironmentClose(checkout, io)
    if (admission.kind !== "admitted") return [`needs-delegation: ${admission.refusal}`]
    if (io.liveEnvironmentUse === undefined) {
      throw new Error("release-checkout requires the liveEnvironmentUse authority reader")
    }
    const uses: unknown = await io.liveEnvironmentUse()
    if (!Array.isArray(uses)) throw new Error("live environment-use reader did not return an array")
    for (const use of uses as readonly unknown[]) {
      if (
        typeof use !== "object" ||
        use === null ||
        !("path" in use) ||
        typeof use.path !== "string" ||
        !isAbsolute(use.path) ||
        !("reason" in use) ||
        typeof use.reason !== "string" ||
        !use.reason.trim()
      ) {
        throw new Error("live environment-use reader needs absolute paths and nonempty reasons")
      }
      if (overlaps(checkout, use.path)) return [`live use: ${use.reason} (${use.path})`]
    }
    if (io.localBranchProtections === undefined) {
      throw new Error("release-checkout requires the localBranchProtections authority reader")
    }
    const result = await io.localBranchProtections({
      repo: row.repo,
      branch: row.branch,
      tip: row.head,
      issue: request.issue,
      retainedCheckout: checkout,
    })
    for (const item of result.evidence) {
      const row = { ...item, reason: publicText(item.reason) }
      if (!evidence.some((seen) => seen.kind === row.kind && seen.path === row.path && seen.reason === row.reason)) {
        evidence.push(row)
      }
    }
    return result.protections
  }
  const hash = (path: string): string | null => {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex")
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null
      throw cause
    }
  }
  const receipt = async ({ checkout, git }: Candidate) => {
    const metadata = await inspectCheckoutGitMetadata(checkout)
    return {
      status: await git(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      head: await refAt(git, "HEAD"),
      index: hash(join(metadata.gitDirectory, "index")),
      lease: hash(join(checkout, ".agent-lease.json")),
      lock: hash(join(metadata.gitDirectory, "locked")),
    }
  }
  type Snapshot = Awaited<ReturnType<typeof receipt>>
  const receipts: { checkout: string; before: Snapshot; after: Snapshot }[] = []
  const report = {
    repo: input.repo,
    branch: request.branch,
    issue: request.issue,
    apply: request.apply === true,
    eligible,
    removed,
    alreadyRetired,
    kept,
    failed,
    excluded,
    evidence,
    receipts,
  }
  const verify = async (candidate: Candidate, before: Awaited<ReturnType<typeof receipt>>) => {
    const after = await receipt(candidate)
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(
        `${candidate.checkout}: retained checkout receipt changed; inspect status, HEAD, index, lease and lock; checkout preserved`,
      )
    }
    const existing = receipts.find((row) => row.checkout === candidate.checkout)
    if (existing === undefined) receipts.push({ checkout: candidate.checkout, before, after })
    else existing.after = after
    io.stderr(
      `yrd: retained checkout ${candidate.checkout}: status --porcelain=v2 -z (all untracked), HEAD ${after.head}, index, .agent-lease.json and Git lock unchanged\n`,
    )
  }
  try {
    for (const reader of ["liveEnvironmentUse", "localBranchProtections"] as const) {
      if (io[reader] === undefined) throw new Error(`release-checkout requires the ${reader} authority reader`)
    }
    const rootStore = createEventStore(input.repo, await remoteUrl(input.git, input.remote), input.selection)
    rootRow.remote = publicText(rootStore.remote)
    const actual = await refAt(input.git, `refs/heads/${request.branch}`)
    if (actual !== undefined && actual !== request.tip) {
      kept.push({
        ...rootRow,
        reason: "moved",
        detail: `tip moved: expected ${request.tip}, found ${actual ?? "absent"}`,
      })
      return report
    }
    const bound = await readBranchHistory(rootStore, input.queue, request.branch)
    if (bound.history?.state.diagnostic !== undefined) throw new Error(bound.history.state.diagnostic)
    if (bound.history?.state.issue !== undefined && identity(bound.history.state.issue) !== identity(request.issue)) {
      throw new Error(`recorded issue ${bound.history.state.issue} differs from requested ${request.issue}`)
    }
    const registrations = await registeredWorktrees(input.git)
    const attachedRoots = registrations.filter((row) => row.head === request.tip && row.branch === request.branch)
    const roots =
      attachedRoots.length > 0
        ? attachedRoots
        : registrations.filter((row) => row.head === request.tip && row.branch === undefined)
    const root = roots[0]
    if (roots.length !== 1 || root === undefined) {
      throw new Error(`expected one retained checkout for ${request.branch}@${request.tip}; found ${roots.length}`)
    }
    rootRow.repo = root.path
    const visit = async (repository: string, path: string, commit: string, branch?: string): Promise<void> => {
      const git = readGit(repository)
      const metadata = await inspectCheckoutGitMetadata(repository)
      if (realpathSync((await git(["rev-parse", "--show-toplevel"])).trim()) !== realpathSync(repository)) {
        throw new Error(`${repository}: pinned repository is not materialized at its named path`)
      }
      const registrations = await registeredWorktrees(git)
      // Git reports a submodule's primary checkout by its admin/common directory.
      // The existing metadata reader plus exact native toplevel proof above bind that row to this checkout.
      const attached =
        registrations.find((row) => resolve(row.path) === realpathSync(repository)) ??
        (metadata.gitDirectory === metadata.commonDirectory
          ? registrations.find((row) => resolve(row.path) === metadata.commonDirectory)
          : undefined)
      io.stderr(
        `yrd: release inspection ${repository}@${commit}: attached ${attached?.branch ?? "none"} at ${attached?.head ?? "unreadable"}\n`,
      )
      const mappedIssue =
        attached?.branch === undefined
          ? undefined
          : io.branchIssue === undefined
            ? issueFromBranchName(attached.branch)
            : io.branchIssue({ branch: attached.branch })
      const archives = readArchiveRows(repository)
      const recovery =
        attached !== undefined && attached.branch === undefined
          ? archives.filter((archive) => {
              const issue =
                io.branchIssue === undefined
                  ? issueFromBranchName(archive.branch)
                  : io.branchIssue({ branch: archive.branch })
              return branch === undefined
                ? issue !== undefined && identity(issue) === identity(request.issue)
                : archive.branch === branch
            })
          : []
      if (recovery.length > 1) {
        throw new Error(`${repository}: ambiguous archive custody: ${recovery.map((row) => row.ref).join(", ")}`)
      }
      const detachedBranches: string[] = []
      if (attached !== undefined && attached.branch === undefined && branch === undefined && recovery.length === 0) {
        for (const [ref] of await listRefs("refs/heads/", createLocalEventStore(repository, input.selection))) {
          const name = ref.slice("refs/heads/".length)
          const issue = io.branchIssue === undefined ? issueFromBranchName(name) : io.branchIssue({ branch: name })
          if (issue !== undefined && identity(issue) === identity(request.issue)) detachedBranches.push(name)
        }
        if (detachedBranches.length > 1) {
          throw new Error(`${repository}: ambiguous detached checkout branches: ${detachedBranches.join(", ")}`)
        }
      }
      if (
        branch !== undefined ||
        recovery.length > 0 ||
        detachedBranches.length > 0 ||
        (mappedIssue !== undefined && identity(mappedIssue) === identity(request.issue))
      ) {
        const selectedBranch = branch ?? attached?.branch ?? recovery[0]?.branch ?? detachedBranches[0]
        if (selectedBranch === undefined) throw new Error(`${repository}: selected attached branch became unreadable`)
        const custody = archives.filter((archive) => archive.branch === selectedBranch)
        if (custody.length > 1) {
          throw new Error(`${repository}: ambiguous archive custody: ${custody.map((row) => row.ref).join(", ")}`)
        }
        const archive = custody[0]
        if (archive !== undefined && archive.tip !== commit) {
          throw new Error(`${repository}: archive ${archive.ref} holds ${archive.tip}, not pinned tip ${commit}`)
        }
        const current = await refAt(git, `refs/heads/${selectedBranch}`)
        const retired =
          attached !== undefined && attached.branch === undefined && current === undefined && archive !== undefined
        const remote = path === "" ? rootStore.remote : await remoteUrl(git, "origin")
        const row: Row =
          path === ""
            ? rootRow
            : {
                repo: repository,
                path,
                branch: selectedBranch,
                head: commit,
                remote: publicText(remote),
                archiveRef: archiveRefFor(selectedBranch, request.by, date),
                reason: publicText(request.reason),
              }
        if (archive !== undefined) row.archiveRef = archive.ref
        if (
          attached?.head !== commit ||
          (!retired && ((attached.branch !== undefined && attached.branch !== selectedBranch) || current !== commit))
        ) {
          kept.push({
            ...row,
            reason: "moved",
            detail: `attached checkout does not match exact recorded pin ${commit}`,
          })
        } else {
          if (retired && (await readRemoteCommit(git, remote, row.archiveRef)) !== commit) {
            throw new Error(`${repository}: archive ${row.archiveRef} lacks exact remote custody at ${commit}`)
          }
          candidates.push({
            row,
            remote,
            checkout: realpathSync(repository),
            git,
            retired,
            detached: attached.branch === undefined,
          })
        }
      } else {
        excluded.push({ repo: repository, path, reason: "no current attached branch mapping to the requested issue" })
      }
      if (request.submodules) {
        for (const child of await readCommitSubmodules(seamProcess(git, repository), repository, commit)) {
          const childRepo = join(repository, child.path)
          const childPath = path === "" ? child.path : `${path}/${child.path}`
          let materialized = true
          try {
            lstatSync(join(childRepo, ".git"))
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
            materialized = false
          }
          if (!materialized) {
            excluded.push({
              repo: childRepo,
              path: childPath,
              reason: `recorded pin ${child.target} has no materialized checkout metadata`,
            })
            continue
          }
          await visit(childRepo, childPath, child.target)
        }
      }
    }
    await visit(root.path, "", request.tip, request.branch)
    // Descendants retire before their parent; a partial apply leaves the root addressable.
    candidates.sort(
      (a, b) => b.row.path.split("/").length - a.row.path.split("/").length || b.row.path.localeCompare(a.row.path),
    )
    const snapshots = new Map<Candidate, Awaited<ReturnType<typeof receipt>>>()
    for (const candidate of candidates) {
      const before = await receipt(candidate)
      snapshots.set(candidate, before)
      let reasons: readonly string[] = []
      try {
        reasons = candidate.retired ? [] : await protect(candidate)
      } catch (cause) {
        failed.push({ ...candidate.row, reason: "failed", detail: publicText(String(cause)) })
      }
      await verify(candidate, before)
      if (reasons.length > 0) kept.push({ ...candidate.row, reason: "held", detail: publicText(reasons.join("; ")) })
    }
    if (kept.length > 0 || failed.length > 0) return report
    if (!request.apply) {
      eligible.push(...candidates.filter((candidate) => !candidate.retired).map((candidate) => candidate.row))
      alreadyRetired.push(...candidates.filter((candidate) => candidate.retired).map((candidate) => candidate.row))
      return report
    }
    const content = [
      publicText(request.reason),
      ...[...candidates]
        .sort((a, b) => a.row.path.localeCompare(b.row.path))
        .map(
          ({ row }) =>
            `repository ${row.repo}; path ${row.path || "."}; old tip ${row.head}; archive ${row.archiveRef}; remote ${row.remote}`,
        ),
    ].join("\n")
    const endingId = bound.history?.state.ending?.id
    if (endingId !== undefined && candidates.every((candidate) => candidate.retired)) {
      alreadyRetired.push(...candidates.map((candidate) => candidate.row))
      return report
    }
    for (const { row, remote } of candidates) {
      await publishRetirementArchive({
        repo: row.repo,
        git: readGit(row.repo),
        selection: input.selection,
        remote,
        archiveRef: row.archiveRef,
        tip: row.head,
      })
    }
    for (const candidate of candidates) {
      const { row } = candidate
      if (candidate.retired) {
        alreadyRetired.push(row)
        continue
      }
      const before = snapshots.get(candidate)
      if (before === undefined) throw new Error(`${candidate.checkout}: expected retained-checkout snapshot is missing`)
      let original: { branch: string; tip: string } | undefined
      const reattach = async () => {
        const restore = original
        original = undefined
        if (restore === undefined) return
        const head = await refAt(candidate.git, "HEAD")
        if (head !== restore.tip) {
          throw new Error(
            `${candidate.checkout}: HEAD advanced to ${head ?? "absent"}; retained without reattachment; expected ${restore.tip}`,
          )
        }
        try {
          await candidate.git(
            ["update-ref", "--stdin"],
            `start\nverify ${restore.branch} ${restore.tip}\nsymref-update HEAD ${restore.branch} oid ${restore.tip}\nprepare\ncommit\n`,
          )
        } catch (cause) {
          const current = await refAt(candidate.git, "HEAD")
          throw new Error(
            `${candidate.checkout}: could not reattach ${restore.branch}; HEAD ${current ?? "absent"} preserved; resolve the competing writer and retry the same release command: ${String(cause)}`,
          )
        }
      }
      try {
        const reasons = await protect(candidate)
        await verify(candidate, before)
        if (reasons.length > 0) {
          kept.push({ ...row, reason: "held", detail: publicText(reasons.join("; ")) })
          break
        }
        const store = createGitWorktreeStore({ repo: row.repo, gitProcess: seamProcess(candidate.git, row.repo) })
        if (!candidate.detached) {
          original = await store.detachAt(candidate.checkout, row.head, `refs/heads/${row.branch}`)
        }
        const result = await retireLocalBranch({
          repo: row.repo,
          git: candidate.git,
          branch: row.branch,
          tip: row.head,
          actor: request.by,
          issue: request.issue,
          reason: request.reason,
          date,
          log: input.log,
          protections: async () => {
            const reasons = await protect(candidate)
            if ((await readRemoteCommit(candidate.git, candidate.remote, row.archiveRef)) !== row.head) {
              return [...reasons, "origin archive custody changed"]
            }
            await verify(candidate, before)
            return reasons
          },
          disposition: { kind: "archived", target: row.head, ref: row.archiveRef },
        })
        if (result.outcome !== "removed") {
          try {
            await reattach()
          } catch (cause) {
            throw new Error(`${result.reason}: ${result.detail ?? result.reason}; ${String(cause)}`, { cause })
          }
          const destination = result.outcome === "failed" ? failed : kept
          destination.push({
            ...row,
            reason: publicText(result.reason),
            detail: publicText(result.detail ?? result.reason),
          })
        } else {
          original = undefined
          removed.push(row)
        }
        await verify(candidate, before)
      } catch (cause) {
        let detail = String(cause)
        try {
          await reattach()
        } catch (restoreError) {
          detail += `; ${String(restoreError)}`
        }
        failed.push({ ...row, reason: "failed", detail: publicText(detail) })
      }
      if (kept.length > 0 || failed.length > 0) break
    }
    if (kept.length === 0 && failed.length === 0 && endingId === undefined) {
      await drop(rootStore, {
        queue: input.queue,
        branch: request.branch,
        by: request.by,
        issue: request.issue,
        note: content,
        localArchive: { ref: rootRow.archiveRef, tip: request.tip },
      })
    }
  } catch (cause) {
    failed.push({ ...rootRow, reason: "failed", detail: publicText(String(cause)) })
  }
  return report
}

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
      return (await input.io.localBranchProtections?.({ repo, branch, tip, issue: change.issue }))?.protections ?? []
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
            ...((
              await input.io.localBranchProtections?.({
                repo,
                branch: author.branch,
                tip: author.tip,
                issue: author.issue,
              })
            )?.protections ?? []),
            ...((
              await input.io.localBranchProtections?.({
                repo: author.rootCommonDirectory,
                branch: author.rootBranch,
                tip: author.rootTip,
                issue: author.issue,
              })
            )?.protections ?? []),
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
        protections: async () => (await protectionsReader({ repo, branch, tip: head, issue: issue.id })).protections,
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
