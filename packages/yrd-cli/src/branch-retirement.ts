import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { archiveRefFor, ensureArchiveRef, findArchiveRefFor, readArchiveRows } from "git-super/archive-ref"
import { readCommitSubmodules } from "git-super/commit-graph"
import { resolveSubmoduleOrigin } from "git-super/submodule-origin"
import { createGitWorktreeStore } from "git-super/worktree"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { inspectCheckoutGitMetadata, verifyRetainedCopy } from "git-super"
import type { GitWorktreeStore } from "git-super/worktree"
import {
  collectMovedGitlinks,
  drop,
  changesRef,
  enumerateChangeSegments,
  seamProcess,
  createEventStore,
  createLocalEventStore,
  gitIn,
  isAncestor,
  listRefs,
  openLog,
  readBranchHistory,
  readEventQueueWithChanges,
  initial,
  evolve,
  isOpen,
  readConfig,
  resolveGitSelection,
  readRemoteCommit,
  readStatus,
  refAt,
  registeredWorktrees,
  retireLocalBranch,
  retireOriginBranch,
  publishRetirementArchive,
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
import type { LocalBranchProtectionResult, YrdCliIO } from "./types.ts"
import { originHead } from "./queue-location.ts"
import { workdirOf } from "./workdir.ts"
import { admitEnvironmentClose } from "./env-close-holders.ts"
import { formatYrdCommand } from "./command-format.ts"

/** Ordinary cleanup permits an explicitly standalone host; missing wiring is not that declaration. */
export async function readBranchProtections(
  io: YrdCliIO,
  input: Parameters<NonNullable<YrdCliIO["localBranchProtections"]>>[0],
): Promise<LocalBranchProtectionResult> {
  if (io.localBranchProtections === null) return { protections: [], evidence: [] }
  if (io.localBranchProtections === undefined) {
    throw new Error("localBranchProtections authority reader is missing; standalone callers must explicitly pass null")
  }
  return io.localBranchProtections(input)
}

/** The existing issue retirement walk, coordinated with component author stores before root removal. */
export async function retireIssueBranches(
  input: Readonly<{
    authorRepo: string
    git: Git
    remote: string
    selection: GitSelection
    env?: NodeJS.ProcessEnv
    io: YrdCliIO
    config: QueueConfig
    request: Readonly<{ issue: string; by: string; reason?: string; apply?: boolean }>
    workdir: string
    mode: string
    targetLabel: string
    command: string
    branchIssue(branch: string, recordedIssue?: string): string | undefined
  }>,
) {
  const {
    authorRepo,
    git: authorGit,
    selection,
    env,
    io,
    config,
    request,
    workdir,
    mode,
    targetLabel,
    branchIssue,
  } = input
  const issue = request.issue

  const eventStore = createEventStore(authorRepo, input.remote, selection)
  type Row = {
    repo: string
    path: string
    branch: string
    head: string
    reason: string
    detail?: string
    archiveRef?: string
    custody?: Readonly<{ kind: "published-main" | "event"; ref: string; tip: string; archive?: string }>
  }
  const eligible: Row[] = []
  const removed: Row[] = []
  const kept: Row[] = []
  const mismatches: Row[] = []
  const failed: Row[] = []
  const inspected: string[] = []
  const excluded: { repo: string; target: number; unrelated: number; unnumbered: number }[] = []
  const unnumbered: { repo: string; branch: string; head: string }[] = []
  const log = openLog(join(workdir, "logs"))
  // THE HEADER FIRST, before the walk writes any retirement record. A journal
  // whose first record is not a run or Git row is one the projection reader
  // refuses (`invalid record before run header`) and every reader older than
  // it refuses with it — one record then denies the whole queue its positions
  // (28791 learned this for the sibling drop path; this path wrote records
  // with no header at all). The queue row marks the preamble complete so the
  // journal never reads as a run that died in it (24470).
  log.write({
    command: input.command,
    config: config.blob,
    kind: "run",
    target: targetLabel,
  })
  log.write({ kind: "queue", queue: `${eventStore.remote}#${config.target.branch}` })
  type Candidate = {
    repo: string
    path: string
    git: Git
    branch: string
    head: string
    local: boolean
    originHead?: string
    remote: string
    commonDirectory: string
  }
  const candidates: Candidate[] = []
  const stores: { repository: string; path: string; git: Git; commonDirectory: string; commit: string }[] = []
  const seenStores = new Set<string>()
  const seenCheckouts = new Set<string>()
  const notMaterialized: { repo: string; path: string; reason: "not-materialized" }[] = []
  const origins = new Map<string, Promise<ReadonlyMap<string, string>>>()
  const defaults = new Map<string, Promise<string>>()
  const targets = new Map<string, Promise<{ target: string; targetRef: string; ownQueue: boolean }>>()
  const defaultBranch = (git: Git, remote: string): Promise<string> => {
    let reading = defaults.get(remote)
    if (reading === undefined) {
      reading = remoteHead(git, remote)
      defaults.set(remote, reading)
    }
    return reading
  }
  const collect = async (
    repository: string,
    path: string,
    childGit: Git,
    commonDirectory: string,
    reading: Awaited<ReturnType<typeof readEventQueueWithChanges>>,
  ): Promise<void> => {
    const heads = await listRefs("refs/heads/", createLocalEventStore(repository, selection))
    // Resolve a local transport relative to its checkout before sharing its advertisement.
    const remote = resolveSubmoduleOrigin(
      repository,
      repository,
      await remoteUrl(childGit, path === "" ? eventStore.remote : "origin"),
    )
    let advertisement = origins.get(remote)
    if (advertisement === undefined) {
      advertisement = listRefs("refs/heads/", createEventStore(repository, remote, selection))
      origins.set(remote, advertisement)
    }
    const remoteHeads = await advertisement
    const targetBranch = path === "" ? config.target.branch : await defaultBranch(childGit, remote)
    const counts = { repo: repository, target: 0, unrelated: 0, unnumbered: 0 }
    excluded.push(counts)
    for (const [ref, head] of new Map([...remoteHeads, ...heads])) {
      const branch = ref.slice("refs/heads/".length)
      const recordedIssue = reading.histories.get(branch)?.state.issue
      const bound =
        io.branchIssue !== undefined || /^(task|exp)\//u.test(branch) ? branchIssue(branch, recordedIssue) : undefined
      if (branch === targetBranch) counts.target++
      else if (bound !== issue) {
        if (bound !== undefined && recordedIssue !== undefined && branchIssue(branch) === issue) {
          mismatches.push({
            repo: repository,
            path,
            branch,
            head,
            reason: "mismatch",
            detail: `recorded issue ${bound} differs from reviewed ${issue}`,
          })
        } else if (bound === undefined) {
          counts.unnumbered++
          unnumbered.push({ repo: repository, branch, head })
        } else counts.unrelated++
      } else {
        candidates.push({
          repo: repository,
          path,
          git: childGit,
          commonDirectory,
          branch,
          head,
          local: heads.has(ref),
          originHead: remoteHeads.get(ref),
          remote,
        })
      }
    }
  }
  const missing = (path: string): boolean => {
    try {
      lstatSync(path)
      return false
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true
      throw cause
    }
  }
  const visit = async (repository: string, path: string, commit: string, moduleStore?: string): Promise<void> => {
    try {
      if (missing(join(repository, ".git"))) {
        if (moduleStore !== undefined && missing(moduleStore)) {
          notMaterialized.push({ repo: repository, path, reason: "not-materialized" })
          return
        }
        throw new Error(
          `${repository}: checkout Git pointer is absent${moduleStore === undefined ? "" : `; existing module store ${moduleStore} cannot be inspected through it`}`,
        )
      }
      const canonical = realpathSync(repository)
      if (seenCheckouts.has(canonical)) return
      const childGit = gitIn(repository, undefined, selection, { env })
      if (realpathSync((await childGit(["rev-parse", "--show-toplevel"])).trim()) !== canonical) {
        throw new Error(`registered repository ${repository} is not materialized at its named path`)
      }
      const metadata = await inspectCheckoutGitMetadata(repository)
      seenCheckouts.add(canonical)
      if (!seenStores.has(metadata.commonDirectory)) {
        seenStores.add(metadata.commonDirectory)
        stores.push({ repository, path, git: childGit, commonDirectory: metadata.commonDirectory, commit })
      }
      for (const child of await readCommitSubmodules(seamProcess(childGit, repository), repository, commit)) {
        await visit(
          join(repository, child.path),
          path === "" ? child.path : `${path}/${child.path}`,
          child.target,
          join(metadata.gitDirectory, "modules", child.name),
        )
      }
    } catch (cause) {
      failed.push({ repo: repository, path, branch: "", head: commit, reason: "unreadable", detail: String(cause) })
    }
  }
  const targetFor = (candidate: Candidate) => {
    const key = `${candidate.commonDirectory}\0${candidate.remote}`
    let target = targets.get(key)
    if (target === undefined) {
      target = (async () => {
        const branch =
          candidate.path === "" ? config.target.branch : await defaultBranch(candidate.git, candidate.remote)
        const targetRef = `refs/heads/${branch}`
        const tip = await readRemoteCommit(candidate.git, candidate.remote, targetRef)
        if (tip === undefined) throw new Error(`${candidate.repo}: published ${candidate.remote}#${branch} is absent`)
        return {
          target: tip,
          targetRef,
          ownQueue:
            candidate.path !== "" &&
            (await readConfig(candidate.git, tip, { remote: candidate.remote, branch })) !== undefined,
        }
      })()
      targets.set(key, target)
    }
    return target
  }
  try {
    await visit(authorRepo, "", (await authorGit(["rev-parse", "HEAD"])).trim())
    for (const root of await registeredWorktrees(authorGit)) {
      if (root.head === undefined) {
        failed.push({
          repo: root.path,
          path: "",
          branch: root.branch ?? "",
          head: "",
          reason: "unreadable",
          detail: "registered author worktree has no HEAD",
        })
      } else await visit(root.path, "", root.head)
    }
    io.stderr(
      `yrd: issue cleanup will inspect ${stores.length} repository stores; ${notMaterialized.length} not materialized. Reading every registered worktree's component stores can take minutes.\n`,
    )
    const reading = await readEventQueueWithChanges(eventStore, config.target.branch)
    const landings = [...reading.histories.values()].flatMap(({ events }) => {
      let state = initial
      const pins: { event: string; path: string; tip: string }[] = []
      for (const event of events) {
        state = evolve(state, event)
        if (event.type === "merged") {
          for (const pin of state.landedGitlinks ?? []) pins.push({ event: event.id, path: pin.path, tip: pin.target })
        }
      }
      return pins
    })
    for (const store of stores) {
      inspected.push(store.repository)
      try {
        await collect(store.repository, store.path, store.git, store.commonDirectory, reading)
      } catch (cause) {
        failed.push({
          repo: store.repository,
          path: store.path,
          branch: "",
          head: store.commit,
          reason: "unreadable",
          detail: String(cause),
        })
      }
    }
    // Prefer a native local author store for a shared origin arm; inspect every store before removal.
    const originOwners = new Map<string, Candidate>()
    const key = (row: Candidate) => `${row.remote}\0${row.branch}`
    for (const candidate of candidates) {
      if (candidate.originHead === undefined) continue
      const prior = originOwners.get(key(candidate))
      if (prior === undefined || (!prior.local && candidate.local)) originOwners.set(key(candidate), candidate)
    }
    candidates.sort(
      (a, b) => Number(a.path === "") - Number(b.path === "") || b.path.split("/").length - a.path.split("/").length,
    )
    const discoveryFailure = failed[0]
    let retirementFailure: Row | undefined
    const archives = await listRefs("refs/archive/", eventStore)
    for (const candidate of candidates) {
      const origin = originOwners.get(key(candidate)) === candidate
      if (!candidate.local && !origin) continue
      const { repo, path, branch, head } = candidate
      const row = { repo, path, branch, head }
      const failure = discoveryFailure ?? retirementFailure
      if (failure !== undefined) {
        kept.push({
          ...row,
          reason: "held",
          detail: `retirement stopped after ${failure.repo}: ${failure.detail ?? failure.reason}`,
        })
        continue
      }
      try {
        const history = path === "" ? reading.histories.get(branch) : undefined
        const change = history?.state
        const invalid = path === "" ? reading.invalid.get(branch) : undefined
        if (invalid !== undefined || change?.diagnostic !== undefined) {
          failed.push({
            ...row,
            reason: "unreadable",
            detail: invalid === undefined ? change?.diagnostic : `${invalid.ref}@${invalid.tip}: ${invalid.error}`,
          })
          continue
        }
        const custody = await targetFor(candidate)
        if (path === "" && change?.commit !== undefined && change.commit !== head) {
          kept.push({
            ...row,
            reason: "advanced",
            detail:
              `current tip ${head} differs from recorded change tip ${change.commit}` +
              (await advancedCure(candidate.git, branch, head, change.commit, custody.target, targetLabel, false)),
          })
          continue
        }
        if (custody.ownQueue || (change !== undefined && isOpen(change.status))) {
          kept.push({
            ...row,
            reason: path === "" ? "active" : "held",
            detail: custody.ownQueue
              ? `component owns a queue at ${candidate.remote}#${custody.targetRef}; its ending event must authorize retirement`
              : "root change is still open",
          })
          continue
        }
        const arm =
          path === "" ? (discoveryFailure ?? retirementFailure ?? kept.find((arm) => arm.path !== "")) : undefined
        if (arm !== undefined) {
          kept.push({
            ...row,
            reason: "held",
            detail: `${arm.path === "" ? "store" : "child"} ${arm.repo} ${arm.branch}: ${arm.detail ?? arm.reason}; root kept for retry`,
          })
          continue
        }
        // Exact root event/archive custody remains authoritative even when the
        // submitted head is no longer in main's graph (including adopted history).
        // A bad branch record is reported independently; only discovery or an
        // attempted retirement failure stops subsequent mutations.
        if (path === "" && candidate.local && (!origin || !(await isAncestor(candidate.git, head, custody.target)))) {
          const landing =
            history === undefined
              ? undefined
              : enumerateChangeSegments(history.events, changesRef(config.target.branch, branch), repo).find(
                  (segment) => segment.head === head && segment.state.status === "merged",
                )
          const archive = [...archives].find(
            ([ref, tip]) => tip === head && /^refs\/archive\/[^/]+\/[^/]+\/(.+)$/u.exec(ref)?.[1] === branch,
          )
          let disposition: LocalBranchRetirement["disposition"] | undefined
          if (landing !== undefined) {
            const ending = landing.state.ending
            if (ending === undefined) {
              failed.push({
                ...row,
                reason: "unreadable",
                detail: `merged segment ${landing.opened} has no ending event`,
              })
              continue
            }
            disposition = {
              kind: "landed",
              target: head,
              proof: { kind: "landing", event: ending.id, path: "", tip: head },
            }
          } else if (archive !== undefined) {
            disposition = { kind: "archived", target: head, ref: archive[0] }
          } else if (!(await isAncestor(candidate.git, head, custody.target))) {
            kept.push({
              ...row,
              reason: "unreached",
              detail: "no exact submitted root tip in merged history or same-branch origin archive",
            })
            continue
          }
          if (disposition !== undefined) {
            const result = await retireLocalBranch({
              repo,
              git: candidate.git,
              branch,
              tip: head,
              actor: request.by,
              owner: change?.submitter,
              issue,
              reason: request.reason ?? disposition.kind,
              date: new Date().toISOString().slice(0, 10),
              dryRun: !request.apply,
              log,
              protections: async () =>
                (await readBranchProtections(io, { repo, branch, tip: head, issue })).protections,
              disposition,
            })
            const detail = origin
              ? `origin ${candidate.remote}#${branch}@${candidate.originHead} remains; this custody path selects only the local name${result.detail === undefined ? "" : `; ${result.detail}`}`
              : result.detail
            const output = {
              ...row,
              reason: result.outcome === "removed" || result.outcome === "eligible" ? disposition.kind : result.reason,
              ...(detail === undefined ? {} : { detail }),
              ...(result.archiveRef === undefined ? {} : { archiveRef: result.archiveRef }),
            }
            if (result.outcome === "eligible") eligible.push(output)
            else if (result.outcome === "removed") removed.push(output)
            else if (result.outcome === "failed") {
              retirementFailure = { ...output, reason: "failed", detail: result.reason }
              failed.push(retirementFailure)
            } else kept.push(output)
            continue
          }
        }
        const retire = createLandedBranchRetirement({
          repo,
          git: candidate.git,
          selection,
          remote: candidate.remote,
          target: custody.target,
          targetRef: custody.targetRef,
          ...(path === "" ? { queue: config.target.branch } : {}),
        })
        const result = await retire({
          path,
          landings,
          branch,
          tip: head,
          actor: request.by,
          issue,
          reason: request.reason,
          date: new Date().toISOString().slice(0, 10),
          dryRun: !request.apply,
          log,
          local: candidate.local,
          origin,
          protections: async () => (await readBranchProtections(io, { repo, branch, tip: head, issue })).protections,
        })
        const output = {
          ...row,
          reason: result.reason,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
          ...(result.archiveRef === undefined ? {} : { archiveRef: result.archiveRef }),
          ...(result.event === undefined
            ? result.custody === "main"
              ? { custody: { kind: "published-main" as const, ref: custody.targetRef, tip: custody.target } }
              : {}
            : { custody: { kind: "event" as const, ...result.event } }),
        }
        if (result.outcome === "eligible") eligible.push(output)
        else if (result.outcome === "removed") removed.push(output)
        else if (result.outcome === "failed") {
          retirementFailure = { ...output, reason: "failed", detail: result.reason }
          failed.push(retirementFailure)
        } else kept.push(output)
      } catch (cause) {
        retirementFailure = { ...row, reason: "failed", detail: String(cause) }
        failed.push(retirementFailure)
      }
    }
  } finally {
    log.finish()
  }
  const report = {
    issue,
    repo: authorRepo,
    apply: request.apply === true,
    mode:
      candidates.length === 0 && failed.length === 0
        ? `${mode} No branches matched issue key ${JSON.stringify(issue)} in the inspected stores.`
        : mode,
    inspected,
    notMaterialized,
    counts: { inspected: inspected.length, notMaterialized: notMaterialized.length },
    excluded,
    unnumbered,
    eligible,
    removed,
    // These unselected names explain a different binding; they are not child holds.
    kept: [...kept, ...mismatches],
    failed,
  }
  return report
}

type ComponentRetirementInput = Readonly<{
  repo: string
  git: Git
  selection: GitSelection
  env?: NodeJS.ProcessEnv
  io: YrdCliIO
  destination: "local" | "origin"
  request: Readonly<{ branch: string; tip: string; by: string; issue?: string; reason?: string }>
}>

/** Find the declared parent from freshly published default refs, never cached origin/HEAD. */
async function componentRetirementOwner(input: ComponentRetirementInput) {
  const { repo, git, selection, env } = input
  try {
    lstatSync(join(repo, ".yrd.yml"))
    throw new Error(`${repo}: local .yrd.yml exists but the selected target has no declaration`)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
  let owner = (await git(["rev-parse", "--show-superproject-working-tree"])).trim()
  while (owner !== "") {
    const ownerGit = gitIn(owner, undefined, selection, { env })
    const queue = await remoteHead(ownerGit, "origin")
    const ownerTarget = await readRemoteCommit(ownerGit, "origin", `refs/heads/${queue}`)
    if (ownerTarget === undefined) throw new Error(`${owner}: owning queue target origin/${queue} is absent`)
    const config = await readConfig(ownerGit, ownerTarget, { remote: "origin", branch: queue })
    if (config === undefined) {
      owner = (await ownerGit(["rev-parse", "--show-superproject-working-tree"])).trim()
      continue
    }
    return { owner, ownerGit, queue, config }
  }
  return undefined
}

/** Component cleanup has no queue event; its declared owner's existing log owns the result. */
export async function retireComponentBranch(input: ComponentRetirementInput) {
  const { repo, git, selection, env, io, request, destination } = input
  const parent = await componentRetirementOwner(input)
  if (parent === undefined) return undefined
  const { owner, ownerGit, queue, config } = parent
  const targetBranch = await remoteHead(git, "origin")
  if (request.branch === targetBranch || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(request.tip)) {
    throw new Error(`${repo}: drop retirement requires a non-target branch and a full expected commit oid`)
  }
  const remote = await remoteUrl(git, "origin")
  const target = await readRemoteCommit(git, remote, `refs/heads/${targetBranch}`)
  if (target === undefined) throw new Error(`${repo}: target origin/${targetBranch} is absent`)
  if ((await readConfig(git, target, { remote, branch: targetBranch })) !== undefined) {
    throw new Error(`${repo}: own origin target declares .yrd.yml; run retirement against that queue`)
  }
  const log = openLog(join(await workdirOf(ownerGit, { cwd: owner, env }), "logs"))
  log.write({
    kind: "run",
    command: destination === "local" ? "drop --local" : "drop --retire",
    pid: process.pid,
    target: `origin/${queue}`,
    config: config.blob,
  })
  const date = new Date().toISOString().slice(0, 10)
  let attemptedArchive: string | undefined
  try {
    const archiveRef =
      findArchiveRefFor(repo, request.branch, request.tip) ?? archiveRefFor(request.branch, request.by, date)
    const observedTip =
      destination === "local"
        ? await refAt(git, `refs/heads/${request.branch}`)
        : await readRemoteCommit(git, remote, `refs/heads/${request.branch}`)
    if (observedTip === undefined && destination === "local") {
      throw new Error(`${repo}: refs/heads/${request.branch} is absent; nothing was removed`)
    }
    const merged = await isAncestor(git, request.tip, target)
    if (destination === "origin") {
      const row = { repo, branch: request.branch, head: observedTip ?? request.tip }
      const custody = { kind: "published-main" as const, ref: `refs/heads/${targetBranch}`, tip: target }
      const retire = createLandedBranchRetirement({ repo, git, selection, remote, target, targetRef: custody.ref })
      const result = await retire({
        path: "",
        landings: [],
        branch: request.branch,
        tip: request.tip,
        actor: request.by,
        issue: request.issue,
        reason: request.reason,
        date,
        log,
        local: false,
        origin: true,
        protections: async () =>
          (
            await readBranchProtections(io, {
              repo,
              branch: request.branch,
              tip: request.tip,
              issue: request.issue,
            })
          ).protections,
      })
      const output = {
        ...row,
        reason: result.reason,
        detail: result.detail,
        ...(result.custody === "main" ? { custody } : {}),
      }
      return {
        removed: result.outcome === "removed" ? [output] : [],
        kept: result.outcome === "kept" ? [output] : [],
        failed: result.outcome === "failed" ? [output] : [],
      }
    }
    const protections = async (): Promise<readonly string[]> => {
      const host = (
        await readBranchProtections(io, { repo, branch: request.branch, tip: request.tip, issue: request.issue })
      ).protections
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
            await readBranchProtections(io, {
              repo,
              branch: request.branch,
              tip: request.tip,
              issue: request.issue,
            })
          ).protections,
      })
      if (preview.outcome !== "eligible") result = preview
      else {
        const archive = ensureArchiveRef(repo, archiveRef, request.tip)
        if (!archive.ok) throw new Error(archive.reason)
        attemptedArchive = archiveRef
        try {
          await publishRetirementArchive(createEventStore(repo, remote, selection), {
            branch: request.branch,
            archive: archiveRef,
            head: request.tip,
          })
        } catch (cause) {
          throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; local refs kept`, { cause })
        }
        result = await retireLocalBranch({ ...retirement, protections })
      }
    } else result = await retireLocalBranch({ ...retirement, protections })
    const row = {
      branch: request.branch,
      head: observedTip,
      ...(result.archiveRef === undefined ? {} : { archiveRef: result.archiveRef }),
      reason: result.outcome === "failed" ? `${repo}: ${result.reason}` : result.reason,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    }
    return {
      removed: result.outcome === "removed" ? [row] : [],
      kept: result.outcome === "kept" ? [row] : [],
      failed: result.outcome === "failed" ? [row] : [],
    }
  } catch (cause) {
    const reason = `${repo}: ${cause instanceof Error ? cause.message : String(cause)}`
    log.write({
      ...(destination === "local"
        ? { kind: "local-branch-retirement" as const }
        : { kind: "observation" as const, scope: "branch-retirement" }),
      repo,
      branch: request.branch,
      head: request.tip,
      actor: request.by,
      issue: request.issue,
      ...(attemptedArchive === undefined ? {} : { archive: attemptedArchive }),
      reason,
      outcome: "failed",
    })
    return {
      removed: [],
      kept: [],
      failed: [
        {
          branch: request.branch,
          head: request.tip,
          ...(attemptedArchive === undefined ? {} : { archiveRef: attemptedArchive }),
          reason,
        },
      ],
    }
  } finally {
    log.finish()
  }
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
    archiveRef?: string
    remote: string
    reason: string
    detail?: string
  }
  type ArchivedRow = Row & { archiveRef: string }
  const eligible: ArchivedRow[] = [],
    removed: ArchivedRow[] = [],
    alreadyRetired: ArchivedRow[] = [],
    kept: Row[] = [],
    failed: Row[] = []
  const excluded: { repo: string; path: string; reason: string }[] = []
  const evidence: LocalBranchProtectionResult["evidence"][number][] = []
  const identity = input.issueIdentity
  const date = new Date().toISOString().slice(0, 10)
  const rootArchiveRef = archiveRefFor(request.branch, request.by, date)
  const rootRow: Row = {
    repo: input.repo,
    path: "",
    branch: request.branch,
    head: request.tip,
    remote: publicText(input.remote),
    reason: publicText(request.reason),
  }
  type Candidate = {
    row: Row
    archiveRef: string
    remote: string
    checkout: string
    git: Git
    retired: boolean
    detached: boolean
  }
  const candidates: Candidate[] = []
  const readGit = (repo: string) => gitIn(repo, undefined, input.selection, { env: input.env })
  const overlaps = (root: string, path: string) => {
    const inside = relative(root, path)
    return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  }
  const protect = async ({ row, checkout }: Candidate): Promise<readonly string[]> => {
    const admission = await admitEnvironmentClose(checkout, io)
    if (admission.kind !== "admitted") {
      // The drop path has no delegation target of its own, so the hold must
      // name the cure that exists: the same command re-run from a context
      // whose census can read every same-UID pid (e.g. outside a sandbox
      // restricting /proc reads). The census receipt rides along so the
      // capable context can compare coverage; the uncleared pids stay named
      // in the refusal — an unreadable pid is never treated as absent.
      const census = admission.census
      const rerun = formatYrdCommand(
        io,
        [
          "drop",
          request.branch,
          "--local",
          "--tip",
          request.tip,
          "--issue",
          request.issue,
          "--reason",
          request.reason,
          "--release-checkout",
          ...(request.submodules === true ? ["--submodules"] : []),
          ...(request.apply === true ? ["--apply"] : []),
        ],
        input.repo,
      )
      return [
        `needs-delegation: ${admission.refusal}; census ${census.mechanism}: ${census.rows} readable, ${census.unreadable} unreadable, ${census.uncleared} uncleared. ` +
          `This caller cannot certify the release; re-run from a context that can read every same-UID pid (outside any sandbox restricting /proc reads): ${rerun}. ` +
          `The admission there is unchanged: a process holding the checkout still refuses`,
      ]
    }
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
    if (typeof io.localBranchProtections !== "function") {
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
      if (typeof io[reader] !== "function") throw new Error(`release-checkout requires the ${reader} authority reader`)
    }
    const rootStore = createEventStore(input.repo, await remoteUrl(input.git, input.remote), input.selection)
    rootRow.remote = publicText(rootStore.remote)
    const actual = await refAt(input.git, `refs/heads/${request.branch}`)
    if (actual !== undefined && actual !== request.tip) {
      kept.push({
        ...rootRow,
        reason: "moved",
        detail: `tip moved: expected ${request.tip}, found ${actual ?? "absent"}; not archived`,
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
            ? undefined
            : io.branchIssue({ branch: attached.branch })
      const archives = readArchiveRows(repository)
      const recovery =
        attached !== undefined && attached.branch === undefined
          ? archives.filter((archive) => {
              const issue = io.branchIssue === undefined ? undefined : io.branchIssue({ branch: archive.branch })
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
          const issue = io.branchIssue?.({ branch: name })
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
        const prospectiveArchive =
          archive?.ref ?? (path === "" ? rootArchiveRef : archiveRefFor(selectedBranch, request.by, date))
        const row: Row =
          path === ""
            ? rootRow
            : {
                repo: repository,
                path,
                branch: selectedBranch,
                head: commit,
                remote: publicText(remote),
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
            detail: `attached checkout does not match exact recorded pin ${commit}${row.archiveRef === undefined ? "; not archived" : ""}`,
          })
        } else {
          if (retired && (await readRemoteCommit(git, remote, prospectiveArchive)) !== commit) {
            throw new Error(`${repository}: archive ${prospectiveArchive} lacks exact remote custody at ${commit}`)
          }
          candidates.push({
            row,
            archiveRef: prospectiveArchive,
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
      if (reasons.length > 0) {
        const heldDetail = publicText(reasons.join("; "))
        kept.push({
          ...candidate.row,
          reason: "held",
          detail: candidate.row.archiveRef === undefined ? `${heldDetail}; not archived` : heldDetail,
        })
      }
    }
    if (kept.length > 0 || failed.length > 0) return report
    if (!request.apply) {
      eligible.push(
        ...candidates
          .filter((candidate) => !candidate.retired)
          .map((candidate) => ({ ...candidate.row, archiveRef: candidate.archiveRef })),
      )
      alreadyRetired.push(
        ...candidates
          .filter((candidate) => candidate.retired)
          .map((candidate) => ({ ...candidate.row, archiveRef: candidate.archiveRef })),
      )
      return report
    }
    const content = [
      publicText(request.reason),
      ...[...candidates]
        .sort((a, b) => a.row.path.localeCompare(b.row.path))
        .map(
          ({ row, archiveRef }) =>
            `repository ${row.repo}; path ${row.path || "."}; old tip ${row.head}; archive ${archiveRef}; remote ${row.remote}`,
        ),
    ].join("\n")
    const endingId = bound.history?.state.ending?.id
    if (endingId !== undefined && candidates.every((candidate) => candidate.retired)) {
      alreadyRetired.push(...candidates.map((candidate) => ({ ...candidate.row, archiveRef: candidate.archiveRef })))
      return report
    }
    for (const candidate of candidates) {
      const { row, remote, archiveRef } = candidate
      const archive = ensureArchiveRef(row.repo, archiveRef, row.head)
      if (!archive.ok) throw new Error(archive.reason)
      row.archiveRef = archiveRef
      try {
        await publishRetirementArchive(createEventStore(row.repo, remote, input.selection), {
          branch: row.branch,
          archive: archiveRef,
          head: row.head,
        })
      } catch (cause) {
        throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; local refs kept`, { cause })
      }
    }
    for (const candidate of candidates) {
      const { row } = candidate
      if (candidate.retired) {
        alreadyRetired.push({ ...row, archiveRef: candidate.archiveRef })
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
            if ((await readRemoteCommit(candidate.git, candidate.remote, candidate.archiveRef)) !== row.head) {
              return [...reasons, "origin archive custody changed"]
            }
            await verify(candidate, before)
            return reasons
          },
          disposition: { kind: "archived", target: row.head, ref: candidate.archiveRef },
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
          removed.push({ ...row, archiveRef: candidate.archiveRef })
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
        localArchive: { ref: rootRow.archiveRef ?? rootArchiveRef, tip: request.tip },
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
  if (!withdrawn && !(await isAncestor(git, tip, input.target))) {
    const result = {
      outcome: "kept",
      reason: "unreached",
      detail: `exact author head ${tip} is not an ancestor of ${input.target}; kept for owner review; not archived`,
    } as const
    log.write({
      kind: "local-branch-retirement",
      repo,
      branch,
      head: tip,
      actor: input.actor,
      owner: change.submitter,
      issue: change.issue,
      reason: result.reason,
      detail: result.detail,
      outcome: result.outcome,
    })
    input.io.stderr(`yrd: ${branch}@${tip} kept: ${result.detail}\n`)
    return result
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
      return (await readBranchProtections(input.io, { repo, branch, tip, issue: change.issue })).protections
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
            if (root.outcome !== "removed" && !(root.outcome === "kept" && root.reason === "unreached")) {
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
        targetRef: "refs/heads/main",
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
            ...(
              await readBranchProtections(input.io, {
                repo,
                branch: author.branch,
                tip: author.tip,
                issue: author.issue,
              })
            ).protections,
            ...(
              await readBranchProtections(input.io, {
                repo: author.rootCommonDirectory,
                branch: author.rootBranch,
                tip: author.rootTip,
                issue: author.issue,
              })
            ).protections,
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
    local?: boolean
    origin?: boolean
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
    targetRef: string
    queue?: string
  }>,
) {
  return async (
    candidate: LandedCandidate,
  ): Promise<
    Omit<LocalBranchRetirementResult, "archiveRef"> & {
      archiveRef?: string
      /** What held the tip when it was removed: main (ancestry), a recorded landing, or the origin archive (closed). */
      custody?: "main" | "landing" | "origin" | "event"
      event?: Readonly<{ ref: string; tip: string; archive?: string }>
    }
  > => {
    const { repo, git, target } = store
    const { path: _path, landings: _landings, reason, local = true, origin = false, ...retirement } = candidate
    const remoteTip = origin ? await readRemoteCommit(git, store.remote, `refs/heads/${candidate.branch}`) : undefined
    if (remoteTip !== undefined && remoteTip !== candidate.tip) {
      return {
        outcome: "kept",
        reason: "moved",
        detail: `origin branch moved: expected ${candidate.tip}, found ${remoteTip}`,
      }
    }
    if (origin) {
      const reasons = await candidate.protections()
      if (reasons.length > 0) return { outcome: "kept", reason: "held", detail: reasons.join("; ") }
    }
    const custody = (await isAncestor(git, candidate.tip, target)) ? target : undefined
    const proof = { kind: "ancestry" as const }
    if (custody === undefined) {
      return {
        outcome: "kept",
        reason: "unreached",
        detail: `exact branch head ${candidate.tip} is not an ancestor of target ${target}; kept for owner review`,
      }
    }
    const landed = local
      ? await retireLocalBranch({
          ...retirement,
          repo,
          git,
          reason: reason ?? `landed by ${proof.kind}`,
          disposition: { kind: "landed", target: custody, proof },
        })
      : {
          outcome: candidate.dryRun ? ("eligible" as const) : ("removed" as const),
          reason: reason ?? "merged by ancestry",
        }
    let ending: Awaited<ReturnType<typeof drop>> | undefined
    if (origin && !candidate.dryRun && landed.outcome === "removed" && remoteTip !== undefined) {
      const eventStore = createEventStore(repo, store.remote, store.selection)
      if (store.queue !== undefined) {
        ending = await drop(eventStore, {
          queue: store.queue,
          branch: candidate.branch,
          by: candidate.actor,
          retire: { tip: candidate.tip },
          note: reason ?? "merged by ancestry",
          protections: () => candidate.protections(),
        })
      } else {
        await retireOriginBranch(eventStore, {
          branch: candidate.branch,
          head: candidate.tip,
          authority: { kind: "published-main", ref: store.targetRef, tip: target },
          protections: () => candidate.protections(),
        })
      }
      candidate.log.write({
        kind: "observation",
        branch: candidate.branch,
        scope: "branch-retirement",
        reason:
          ending === undefined
            ? `${repo}: retired origin ${candidate.branch}@${candidate.tip}; ${store.targetRef}@${target} contains its exact tip`
            : `${repo}: retired origin ${candidate.branch}@${candidate.tip}; ending ${ending.event}${ending.archive === undefined ? "" : `; archive ${ending.archive}`}`,
      })
    }
    return {
      ...landed,
      ...(origin && !local && remoteTip === undefined && !candidate.dryRun
        ? { detail: `already retired: origin ${candidate.branch} is absent; this run deleted no ref` }
        : {}),
      custody: ending === undefined ? "main" : "event",
      ...(ending === undefined || store.queue === undefined
        ? {}
        : {
            event: {
              ref: changesRef(store.queue, candidate.branch),
              tip: ending.event,
              ...(ending.archive === undefined ? {} : { archive: ending.archive }),
            },
          }),
    }
  }
}

/**
 * The next step for a branch drop keeps because it moved past its recorded change tip (29579). When the target already
 * holds the current tip, as after a fast-forward to it while verifying, nothing is lost by moving the branch back to
 * the recorded tip, after which the same drop retires it (a `--local` one with `--tip` at that recorded tip);
 * otherwise the branch holds work the target lacks, which lands by being submitted. An unanswerable ancestry read is
 * named, never guessed.
 */
export async function advancedCure(
  git: Git,
  branch: string,
  head: string,
  recorded: string | undefined,
  target: string,
  targetLabel: string,
  local: boolean,
): Promise<string> {
  let held: boolean
  try {
    held = await isAncestor(git, head, target)
  } catch (error) {
    return `; whether ${targetLabel} holds ${head} is unknown (${error instanceof Error ? error.message : String(error)})`
  }
  if (!held) return `; it holds commits ${targetLabel} lacks: submit them, and drop the branch after they land`
  return (
    `; ${targetLabel} already holds ${head}, so nothing is lost: move the branch back with ` +
    `git update-ref refs/heads/${branch} ${recorded} ${head}, then ` +
    (local ? `rerun with --tip ${recorded}` : "rerun this drop")
  )
}
