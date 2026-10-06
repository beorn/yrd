import { appendFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import {
  gitIn,
  listChangeHistories,
  type GitRunner,
  type GitSelection,
  type QueueConfig,
  type QueueRunOutcome,
} from "@yrd/queue-core"
import { createLocalGitProcess } from "git-super/process"
import { createLocalGitWorktreeStore } from "git-super/worktree"
import { clearedByIdentity, inspectProcessCwds, type ProcessCwdProjection, type UnreadableProcess } from "removely"
import { closeEnvironment, environmentInventory } from "./env-commands.ts"
import { environmentIssues } from "./env-cleanup-provenance.ts"
import { repositoryHere } from "./declaration.ts"
import { issueLookup, type ResolvedIssue } from "./issue-resolver.ts"
import type { YrdCliIO } from "./types.ts"

type CachedEnvironment = {
  paths: { path: string; optional: boolean }[]
  branches: readonly string[]
  issues?: readonly string[]
  bindingKey?: string
  expensiveKey?: string
  verdict?: string
  hold?: string | null
  busy?: string
  statuses: Map<string, string>
}

/**
 * A round charged the spawn-producing evaluation of at most this many
 * environments, so the first pass over the fleet's whole registry is sliced
 * across rounds instead of exceeding the 27723 cost bar (30 s, 400 spawns) in
 * one of them: the registry holds hundreds of rows, and each costs several Git
 * calls. `cursor` is where the next round resumes, so progress is guaranteed
 * even when a row keeps failing its cheap checks.
 */
const ENVIRONMENT_BATCH = 16

/** The command invocation owns these facts; a restart makes a complete first pass. */
export function createEnvironmentCleanup() {
  const cache = new Map<string, CachedEnvironment>()
  const progress = { cursor: 0 }
  return (input: Parameters<typeof cleanupEnvironments>[0]) => cleanupEnvironments(input, cache, progress)
}

/** Names a denied row by pid, command and denial code — never its argv. */
function unreadableLabel(entry: UnreadableProcess): string {
  const codes = [...new Set(entry.issues.flatMap((issue) => (issue.code === undefined ? [] : [issue.code])))]
  const suffix = codes.length === 0 ? "" : ` (${codes.join(", ")})`
  return `pid ${entry.pid} ${entry.comm ?? "(no comm)"}${suffix}`
}

/** A missing required index/reflog is uncertainty, never an unchanged identity. */
function identity(file: Readonly<{ path: string; optional: boolean }>): string {
  try {
    const stat = statSync(file.path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (file.optional && (code === "ENOENT" || code === "ENOTDIR")) return "absent optional path"
    throw new Error(`cannot inspect cleanup input ${file.path}: ${String(cause)}`, { cause })
  }
}

/** One completed round applies the same predicate to current and backlog environments. */
async function cleanupEnvironments(
  input: Readonly<{
    repo: string
    git: GitRunner
    config: QueueConfig
    workdir: string
    outcome: QueueRunOutcome
    io: YrdCliIO
    env?: NodeJS.ProcessEnv
    selection: GitSelection
    resolveIssue: ((raw: string) => Promise<string>) | undefined
  }>,
  cache: Map<string, CachedEnvironment>,
  progress: { cursor: number },
): Promise<void> {
  const { repo, git, config, workdir, outcome, io } = input
  // The author environments live in the worktree registry of the repository
  // this command STANDS IN — the declaration's own repository — never the
  // queue-owned clone the round reads its authority from (27723 @cto ruling
  // 2026-10-06: `yrd env open` registers an author environment in the
  // repository it runs in, and the fleet's are registered in /hh/dev). The
  // service stands in its landing, whose common dir is /hh/dev/.git, so the
  // same registry is read without naming any path.
  const registry = repositoryHere(io.cwd ?? globalThis.process.cwd()) ?? repo
  const registryGit = registry === repo ? git : gitIn(registry, undefined, input.selection, { env: input.env })
  const inventory = await environmentInventory(registry, registryGit, workdir)
  if (inventory.rows.length === 0) {
    // An empty registry is a fact about WHERE the round looked, never a silent
    // no-op: name the repository whose registry was read and the roots excluded.
    appendFileSync(
      outcome.log,
      `${JSON.stringify({
        kind: "observation",
        run: outcome.run,
        at: new Date().toISOString(),
        scope: "environment-cleanup",
        registry,
        closed: 0,
        kept: 0,
        remaining: 0,
        deferred: 0,
        result: "none",
        why: `no registered environments under ${inventory.roots.join(" or ")}`,
      })}\n`,
    )
    return
  }
  let closed = 0
  let kept = 0
  const record = (path: string, result: string, why: string): void => {
    const row = {
      kind: "observation",
      run: outcome.run,
      at: new Date().toISOString(),
      scope: "environment-cleanup",
      registry,
      path,
      result,
      why,
    }
    appendFileSync(outcome.log, `${JSON.stringify(row)}\n`)
    io.stderr(`yrd: environment ${path}: ${result}: ${why}\n`)
  }
  const preserve = (path: string, why: string): void => {
    kept++
    record(path, "kept", why)
  }
  /** The service's own coverage receipt; the CWD ruling requires rows, unreadable and uncleared from this process. */
  let censusReceipt:
    | Readonly<{ mechanism: string; complete: boolean; rows: number; unreadable: number; uncleared: number }>
    | undefined
  const census = async (): Promise<ProcessCwdProjection> => {
    const snapshot = await inspectProcessCwds({ deadlineMs: 2_000 })
    // A denied same-UID read is cleared only by removely's own identity
    // predicate. Anything it cannot clear could be a holder, so the run keeps
    // the environment and names the pid, command and denial it could not rule out.
    const uncleared = snapshot.unreadable.filter((entry) => clearedByIdentity(entry) === undefined)
    censusReceipt = {
      mechanism: snapshot.mechanism,
      complete: snapshot.complete,
      rows: snapshot.rows.length,
      unreadable: snapshot.unreadable.length,
      uncleared: uncleared.length,
    }
    if (uncleared.length > 0) {
      throw new Error(
        `same-UID process CWD census ${snapshot.mechanism} could not read ${uncleared
          .map((entry) => unreadableLabel(entry))
          .join(", ")}; a holder among them cannot be ruled out`,
      )
    }
    if (!snapshot.complete && snapshot.unreadable.length === 0) {
      throw new Error(`same-UID process CWD census ${snapshot.mechanism} incomplete: no readable coverage`)
    }
    return snapshot
  }
  const busy = (path: string, snapshot: ProcessCwdProjection): string | undefined => {
    const holder = snapshot.rows.find(({ cwd }) => {
      const within = relative(path, cwd)
      return within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !within.startsWith(sep))
    })
    return holder === undefined ? undefined : `process ${holder.pid} has CWD ${holder.cwd}`
  }
  const process = createLocalGitProcess()
  const ancestor = async (root: string, head: string, target: string): Promise<void> => {
    const result = await process.run({
      repo: root,
      args: ["merge-base", "--is-ancestor", head, target],
      env: input.env,
      timeoutMs: 10_000,
    })
    if (
      result.failure !== undefined ||
      result.signal ||
      result.timedOut ||
      result.stalled ||
      result.backstop !== undefined ||
      (result.code !== 0 && result.code !== 1)
    ) {
      throw new Error(`ancestry ${head} -> ${target} in ${root} failed: ${JSON.stringify(result)}`)
    }
    if (result.code === 1) throw new Error(`commit ${head} in ${root} is not on target ${target}`)
  }
  let snapshot: ProcessCwdProjection
  let histories: Awaited<ReturnType<typeof listChangeHistories>>
  try {
    snapshot = await census()
    histories = await listChangeHistories(
      { repo, remote: config.target.remote, selection: git.selection, backend: git.backend },
      config.target.branch,
    )
  } catch (cause) {
    for (const row of inventory.rows) preserve(row.path, String(cause))
    appendFileSync(
      outcome.log,
      `${JSON.stringify({ kind: "observation", run: outcome.run, at: new Date().toISOString(), scope: "environment-cleanup", registry, closed, kept, deferred: 0, remaining: inventory.rows.length - closed, ...(censusReceipt === undefined ? {} : { census: censusReceipt }) })}\n`,
    )
    return
  }
  const lookup = issueLookup(config, repo, input.env)
  const statuses = new Map<string, Promise<ResolvedIssue>>()
  const requireClosed = async (id: string, entry: CachedEnvironment, fresh = false): Promise<void> => {
    let pending = fresh ? undefined : statuses.get(id)
    if (pending === undefined) {
      pending = (async () => {
        if (lookup === undefined) {
          throw new Error(`issue ${id}: target declaration has no issueResolver; closure unproven`)
        }
        return lookup(id)
      })()
    }
    if (!fresh) statuses.set(id, pending)
    const issue = await pending
    const status = JSON.stringify(issue)
    if (entry.statuses.get(id) !== status) {
      entry.expensiveKey = undefined
      entry.statuses.set(id, status)
    }
    if (issue.id !== id || issue.status !== "closed") {
      throw new Error(`issue ${id}: configured lookup returned ${status}; closure unproven`)
    }
  }
  // Resume where the last round ran out of budget, so a row that keeps failing
  // a cheap check cannot starve the tail of the registry.
  const offset = inventory.rows.length === 0 ? 0 : progress.cursor % inventory.rows.length
  const ordered = [...inventory.rows.slice(offset), ...inventory.rows.slice(0, offset)]
  let charged = 0
  let stoppedAt = -1
  for (const [index, row] of ordered.entries()) {
    try {
      let entry = cache.get(row.path)
      if (entry === undefined) {
        entry = { paths: [], branches: [], statuses: new Map() }
        cache.set(row.path, entry)
      }
      const holder = busy(row.path, snapshot)
      if (entry.hold !== row.hold || entry.busy !== holder) entry.expensiveKey = undefined
      entry.hold = row.hold
      entry.busy = holder
      if (row.hold !== null) throw new Error(`held${row.hold === "" ? "" : `: ${row.hold}`}`)
      if (charged >= ENVIRONMENT_BATCH) {
        stoppedAt = index
        break
      }
      charged++
      const treeGit = gitIn(row.path, undefined, git.selection, { env: input.env })
      const head = row.head
      if (head === undefined) throw new Error(`registered environment ${row.path} has no HEAD`)
      if (entry.paths.length === 0) {
        for (const resource of ["index", "logs/HEAD"]) {
          const path = (await treeGit(["rev-parse", "--git-path", resource])).trim()
          if (path === "") throw new Error(`environment ${row.path}: Git returned no ${resource} path`)
          entry.paths.push({ path: resolve(row.path, path), optional: false })
        }
      }
      const ownLog = entry.paths[1]
      if (ownLog === undefined) throw new Error(`environment ${row.path}: HEAD reflog identity absent`)
      const bindingKey = (): string =>
        JSON.stringify([
          head,
          row.branch,
          config.blob,
          identity(ownLog),
          [...new Set([...(row.branch === undefined ? [] : [row.branch]), ...entry.branches])].map((branch) => [
            branch,
            histories.histories.get(branch)?.events.at(-1)?.id,
            histories.invalid.get(branch)?.tip,
          ]),
        ])
      if (entry.issues === undefined || entry.bindingKey !== bindingKey()) {
        const bindings = await environmentIssues(
          row.path,
          treeGit,
          row.name,
          row.branch,
          git,
          config.target.branch,
          { repo, remote: config.target.remote, selection: git.selection, backend: git.backend },
          histories,
          input.resolveIssue ??
            (async (raw) => {
              if (lookup === undefined) throw new Error(`issue ${raw}: target declaration has no issueResolver`)
              return (await lookup(raw)).id
            }),
        )
        entry.issues = bindings.issues
        entry.branches = bindings.branches
        entry.bindingKey = bindingKey()
        entry.expensiveKey = undefined
      }
      const issues = entry.issues
      for (const issue of issues) await requireClosed(issue, entry)
      if (holder !== undefined) throw new Error(holder)
      const expensiveKey = (): string =>
        JSON.stringify([
          head,
          row.branch,
          config.blob,
          outcome.target,
          entry.bindingKey,
          entry.paths.map((file) => [file.path, identity(file)]),
        ])
      if (entry.expensiveKey === expensiveKey()) {
        if (entry.verdict !== undefined) throw new Error(entry.verdict)
      } else {
        try {
          await ancestor(row.path, head, outcome.target)
          const inspection = await createLocalGitWorktreeStore({ repo, env: input.env }).inspectRemoval(row.path)
          for (const component of inspection.consultedRepositories) {
            if (component.path === ".") continue
            for (const resource of ["index", `refs/remotes/origin/${config.target.branch}`, "packed-refs"]) {
              const path = (await treeGit.at(component.root)(["rev-parse", "--git-path", resource])).trim()
              if (path === "") throw new Error(`component ${component.root}: Git returned no ${resource} path`)
              const absolute = resolve(component.root, path)
              if (!entry.paths.some((file) => file.path === absolute)) {
                entry.paths.push({ path: absolute, optional: resource !== "index" })
              }
            }
          }
          for (const component of inspection.uninitializedSubmodules) {
            const path = join(row.path, component, ".git")
            if (!entry.paths.some((file) => file.path === path)) entry.paths.push({ path, optional: true })
          }
          if (inspection.records.length > 0) throw new Error(`dirty root/components: ${inspection.records.join("; ")}`)
          if (inspection.notCompared.length > 0) {
            throw new Error(`repository coverage unproven: ${JSON.stringify(inspection.notCompared)}`)
          }
          if (inspection.borrowers.length > 0) throw new Error(`borrowed by ${inspection.borrowers.join(", ")}`)
          for (const component of inspection.consultedRepositories) {
            if (component.path === ".") continue
            if (component.to === undefined) throw new Error(`materialized component ${component.root} has no HEAD`)
            await ancestor(component.root, component.to, `refs/remotes/origin/${config.target.branch}`)
          }
          entry.verdict = undefined
          entry.expensiveKey = expensiveKey()
        } catch (cause) {
          entry.verdict = String(cause)
          entry.expensiveKey = expensiveKey()
          throw cause
        }
      }
      // One close per round lets the queue judge a waiting merge before another removal.
      if (closed > 0 || outcome.checkedWaiting > 0) {
        throw new Error("eligible; yielding to the next queue round before removal")
      }
      const freshHolder = busy(row.path, await census())
      if (freshHolder !== undefined) throw new Error(freshHolder)
      for (const issue of issues) await requireClosed(issue, entry, true)
      const current = (await environmentInventory(registry, registryGit, workdir)).rows.find(
        (entry) => entry.path === row.path,
      )
      if (current === undefined || current.hold !== null || current.head !== head) {
        throw new Error("registration, hold or HEAD changed before close")
      }
      let output = ""
      const exit = await closeEnvironment(
        row.path,
        { json: true, noRehome: true },
        {
          ...io,
          cwd: registry,
          stdout: (text) => {
            output += text
          },
        },
      )
      if (exit !== 0) throw new Error(`native close exited ${exit}: ${output}`)
      const result: unknown = JSON.parse(output)
      if (typeof result !== "object" || result === null) throw new Error(`malformed close result ${output}`)
      if ("closed" in result && result.closed === row.path) {
        closed++
        cache.delete(row.path)
        record(row.path, "closed", "native retained removal proof accepted")
      } else if ("kept" in result && result.kept === row.path) preserve(row.path, output.trim())
      else throw new Error(`unproven close result ${output}`)
    } catch (cause) {
      preserve(row.path, String(cause))
    }
  }
  progress.cursor = stoppedAt < 0 ? 0 : (offset + stoppedAt) % inventory.rows.length
  appendFileSync(
    outcome.log,
    `${JSON.stringify({
      kind: "observation",
      run: outcome.run,
      at: new Date().toISOString(),
      scope: "environment-cleanup",
      registry,
      closed,
      kept,
      charged,
      deferred: inventory.rows.length - charged,
      remaining: inventory.rows.length - closed,
      ...(censusReceipt === undefined ? {} : { census: censusReceipt }),
    })}\n`,
  )
}
