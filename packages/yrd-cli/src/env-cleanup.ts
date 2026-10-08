import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { atomicWriteFileSync } from "@bearly/durable-file"
import {
  gitIn,
  readBranchHistory,
  type Git,
  type GitRunner,
  type GitSelection,
  type QueueConfig,
  type QueueRunOutcome,
} from "@yrd/queue-core"
import { createLocalGitProcess } from "git-super/process"
import { createLocalGitWorktreeStore } from "git-super/worktree"
import { inspectProcessCwds, type ProcessCwdProjection } from "removely"
import { environmentCwdHolder, processCwdCoverage } from "./env-close-holders.ts"
import { ENV_CLOSE_QUEUED_EXIT, closeEnvironment, environmentInventory } from "./env-commands.ts"
import {
  MAX_COVERAGE_ATTEMPTS,
  dropCloseRequest,
  listCloseRequests,
  readCloseRequest,
  restoreCloseRequest,
  stageCloseRequest,
  type StoredCloseRequest,
} from "./env-close-requests.ts"
import { environmentIssues } from "./env-cleanup-provenance.ts"
import { repositoryHere } from "./declaration.ts"
import { issueLookup, type ResolvedIssue } from "./issue-resolver.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

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
 * calls plus an issue-status lookup. `cursor` is where the next round resumes,
 * so progress is guaranteed even when a row keeps failing its cheap checks.
 *
 * Measured 2026-10-06 against the delivered fleet registry: a 16-row round took
 * 28.8 s and 29.4 s (two in a row), because the issue-status lookup costs ~2 s
 * per distinct issue — too close to the 30 s bar to be safe. At 8 rows the same
 * work is ~14 s, and the git spawns stay far below 400 (an instrumented read of
 * this path measured 4 per row).
 */
const ENVIRONMENT_BATCH = 8

/**
 * Resume state for the sweep. The cursor is a HINT read from the run's own
 * state dir, never authority: every row is re-evaluated by the rule, so a
 * missing, unreadable or stale hint costs time and nothing else (ruling 27723
 * durable cursor, 2026-10-06). Without it, a landing that moves vendor/yrd
 * restarts the service and restarts the sweep, so under landing churn the tail
 * of the registry — the backlog this change exists to retire — starves.
 */
type CleanupProgress = { cursor: number; hint: string | undefined; loaded: boolean }

/** Where the hint lives: the run's existing state dir, not a new config key. */
function cursorHintPath(workdir: string): string {
  return join(workdir, "state", "yrd", "environment-cleanup.json")
}

/**
 * Consume the durable close requests a caller filed because its own same-UID CWD
 * census could not certify the close (22894). This round IS the capable context:
 * it runs the SAME `closeEnvironment` lifecycle the direct verb runs, under the
 * direct admission predicate (clean, unlocked, no holder, ancestry not required),
 * one close per round like every other removal here.
 *
 * Retirement is loud and bounded. Existence is checked FIRST, so a path already
 * gone is an `already-removed` row and never a close attempt (23162: freshness at
 * destruction). The registry row is re-read, and a gone registration, a hold or a
 * moved HEAD retires the request as `stale`. Only an incomplete census is
 * retryable — at most MAX_COVERAGE_ATTEMPTS rounds — after which the file is
 * DELETED with the whole request and the last refusal in its final journal row
 * (no archive directory). Every other refusal retires at once with its reason.
 */
async function consumeCloseRequests(
  input: Readonly<{
    workdir: string
    registry: string
    worktrees: Git
    io: YrdCliIO
    outcome: QueueRunOutcome
  }>,
): Promise<Readonly<{ closed: number; handled: ReadonlySet<string> }>> {
  const { workdir, registry, worktrees, io, outcome } = input
  const files = listCloseRequests(workdir).slice(0, ENVIRONMENT_BATCH)
  if (files.length === 0) return { closed: 0, handled: new Set() }
  const inventory = await environmentInventory(registry, worktrees, workdir)
  const journal = (
    file: string,
    request: StoredCloseRequest | undefined,
    path: string,
    result: string,
    why: string,
    fingerprint?: string,
  ): void => {
    appendFileSync(
      outcome.log,
      `${JSON.stringify({
        kind: "observation",
        run: outcome.run,
        at: new Date().toISOString(),
        scope: "environment-cleanup",
        registry,
        path,
        ...(request === undefined
          ? { requestFile: file }
          : {
              request: {
                requester: request.requester,
                at: request.at,
                options: request.options,
                path: request.path,
                head: request.head,
                ...(fingerprint === undefined ? {} : { fingerprint }),
                ...(request.coverageAttempts === undefined ? {} : { coverageAttempts: request.coverageAttempts }),
              },
            }),
        result,
        why,
      })}\n`,
    )
    io.stderr(`yrd: environment close request ${file}: ${result}: ${why}\n`)
  }
  let closed = 0
  const handled = new Set<string>()
  for (const file of files) {
    let request: StoredCloseRequest
    try {
      const standing = readCloseRequest(file)
      if (standing === undefined) continue
      request = standing
    } catch (cause) {
      // A file this round cannot read is named and LEFT STANDING: deleting it
      // would destroy the only record of who asked for what.
      journal(file, undefined, file, "unreadable", String(cause))
      continue
    }
    handled.add(request.path)
    if (!existsSync(request.path)) {
      dropCloseRequest(file)
      journal(file, request, request.path, "already-removed", `${request.path} is gone; the request is satisfied`)
      continue
    }
    const current = inventory.rows.find((row) => row.path === request.path)
    if (current === undefined) {
      dropCloseRequest(file)
      journal(file, request, request.path, "stale", `${request.path} is no longer a registered environment`)
      continue
    }
    const fingerprint =
      `${current.name} ${current.branch ?? "(detached)"} ${current.head ?? "(no head)"} ` +
      `hold=${current.hold === null ? "no" : JSON.stringify(current.hold)}`
    if (current.hold !== null) {
      dropCloseRequest(file)
      journal(
        file,
        request,
        request.path,
        "stale",
        `held${current.hold === "" ? "" : `: ${current.hold}`}`,
        fingerprint,
      )
      continue
    }
    if (current.head !== request.head) {
      dropCloseRequest(file)
      journal(
        file,
        request,
        request.path,
        "stale",
        `registered HEAD moved from ${request.head} to ${current.head ?? "(none)"}`,
        fingerprint,
      )
      continue
    }
    // Stage before the close so two consumers cannot both act on one request and
    // a crash mid-close leaves the row in a named place.
    const staged = stageCloseRequest(file)
    let exit: YrdCliExitCode
    let output = ""
    try {
      exit = await closeEnvironment(
        request.path,
        { ...request.options, json: true },
        {
          ...io,
          cwd: registry,
          stdout: (text) => {
            output += text
          },
        },
      )
    } catch (cause) {
      dropCloseRequest(staged)
      journal(file, request, request.path, "retired", String(cause), fingerprint)
      continue
    }
    if (exit === ENV_CLOSE_QUEUED_EXIT) {
      // The round's own close could not certify either. The closure wrote its own
      // request file (create-or-match) while ours was staged, so that fresh one is
      // removed and our staged row carries the bounded count forward.
      dropCloseRequest(file)
      const attempts = (request.coverageAttempts ?? 0) + 1
      const retired = { ...request, coverageAttempts: attempts }
      if (attempts >= MAX_COVERAGE_ATTEMPTS) {
        dropCloseRequest(staged)
        journal(
          file,
          retired,
          request.path,
          "retired",
          `coverage refused ${attempts} times; last: ${output.trim()}`,
          fingerprint,
        )
      } else {
        restoreCloseRequest(staged, file, attempts)
        journal(
          file,
          retired,
          request.path,
          "kept",
          `coverage refused ${attempts} of ${MAX_COVERAGE_ATTEMPTS}; retried next round: ${output.trim()}`,
          fingerprint,
        )
      }
      continue
    }
    if (exit !== 0) {
      dropCloseRequest(staged)
      journal(file, request, request.path, "retired", `native close exited ${exit}: ${output.trim()}`, fingerprint)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(output)
    } catch {
      dropCloseRequest(staged)
      journal(file, request, request.path, "retired", `malformed close result ${output.trim()}`, fingerprint)
      continue
    }
    if (typeof parsed === "object" && parsed !== null && "closed" in parsed && parsed.closed === request.path) {
      dropCloseRequest(staged)
      closed++
      journal(file, request, request.path, "closed", `closed at the request of ${request.requester}`, fingerprint)
      // One close per round, like every other removal here: a waiting merge is
      // judged before another removal (@i/10-yrd eligibility discipline).
      break
    }
    dropCloseRequest(staged)
    journal(
      file,
      request,
      request.path,
      "retired",
      typeof parsed === "object" && parsed !== null && "kept" in parsed
        ? `kept: ${output.trim()}`
        : `unproven close result ${output.trim()}`,
      fingerprint,
    )
  }
  return { closed, handled }
}

export function createEnvironmentCleanup() {
  const cache = new Map<string, CachedEnvironment>()
  const progress: CleanupProgress = { cursor: 0, hint: undefined, loaded: false }
  return (input: Parameters<typeof cleanupEnvironments>[0]) => cleanupEnvironments(input, cache, progress)
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
  progress: CleanupProgress,
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
    const coverage = processCwdCoverage(snapshot)
    censusReceipt = {
      mechanism: snapshot.mechanism,
      complete: snapshot.complete,
      rows: snapshot.rows.length,
      unreadable: snapshot.unreadable.length,
      uncleared: coverage.uncleared.length,
    }
    if (coverage.refusal !== undefined) throw new Error(coverage.refusal)
    return snapshot
  }
  const busy = (path: string, snapshot: ProcessCwdProjection): string | undefined => {
    const holder = environmentCwdHolder(path, snapshot)
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
  try {
    snapshot = await census()
  } catch (cause) {
    for (const row of inventory.rows) preserve(row.path, String(cause))
    appendFileSync(
      outcome.log,
      `${JSON.stringify({ kind: "observation", run: outcome.run, at: new Date().toISOString(), scope: "environment-cleanup", registry, closed, kept, deferred: 0, remaining: inventory.rows.length - closed, ...(censusReceipt === undefined ? {} : { census: censusReceipt }) })}\n`,
    )
    return
  }
  // 22894: a close no caller here could certify is consumed BEFORE the cursor
  // batch, because this round is the context whose census reads every pid.
  const requests = await consumeCloseRequests({ workdir, registry, worktrees: registryGit, io, outcome })
  closed += requests.closed
  const store = { repo, remote: config.target.remote, selection: git.selection, backend: git.backend }
  const historyCache = new Map<string, ReturnType<typeof readBranchHistory>>()
  const historyOf = (branch: string): ReturnType<typeof readBranchHistory> => {
    const cached = historyCache.get(branch)
    if (cached !== undefined) return cached
    const pending = readBranchHistory(store, config.target.branch, branch)
    historyCache.set(branch, pending)
    return pending
  }
  const lookup = issueLookup(config, repo, input.env)
  const statuses = new Map<string, Promise<ResolvedIssue>>()
  let lookups = 0
  const requireClosed = async (id: string, entry: CachedEnvironment, fresh = false): Promise<void> => {
    let pending = fresh ? undefined : statuses.get(id)
    if (pending === undefined) {
      lookups++
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
  const startedAt = Date.now()
  // The hint is read once per process, before the first offset. A hint that
  // cannot be trusted starts the sweep at index 0 and is NAMED, never silently
  // ignored (ruling 27723). A plain first run has no file: that is not a fault,
  // so it is named on stderr only and adds no row to a bare run.
  const hintPath = cursorHintPath(workdir)
  if (!progress.loaded) {
    progress.loaded = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(hintPath, "utf8"))
      const hint =
        typeof parsed === "object" && parsed !== null && "cursorEnv" in parsed
          ? (parsed as { cursorEnv?: unknown }).cursorEnv
          : undefined
      if (typeof hint !== "string") throw new Error("no cursorEnv string")
      const index = inventory.rows.findIndex((row) => row.name === hint)
      if (index < 0) {
        record(
          hintPath,
          "cursor-reset",
          "resume hint names " + JSON.stringify(hint) + ", no longer a registered environment",
        )
        progress.cursor = 0
      } else progress.cursor = index
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT"
      progress.cursor = 0
      const reason = missing
        ? "absent (first run), starting at index 0"
        : "unreadable (" + String(cause) + "), starting at index 0"
      io.stderr("yrd: environment cleanup resume hint " + hintPath + ": " + reason + "\n")
      if (!missing) record(hintPath, "cursor-reset", String(cause))
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
      if (requests.handled.has(row.path)) {
        // This round already ran the direct close lifecycle for this path under a
        // filed request; evaluating it again here only repeats the census.
        continue
      }
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
      const bindingKey = async (): Promise<string> =>
        JSON.stringify([
          head,
          row.branch,
          config.blob,
          identity(ownLog),
          await Promise.all(
            [...new Set([...(row.branch === undefined ? [] : [row.branch]), ...entry.branches])].map(async (branch) => [
              branch,
              (await historyOf(branch)).history?.events.at(-1)?.id,
            ]),
          ),
        ])
      const key = await bindingKey()
      if (entry.issues === undefined || entry.bindingKey !== key) {
        const bindings = await environmentIssues(
          row.path,
          treeGit,
          row.name,
          row.branch,
          git,
          config.target.branch,
          store,
          async (branch) => (await historyOf(branch)).history,
          input.resolveIssue ??
            (async (raw) => {
              if (lookup === undefined) throw new Error(`issue ${raw}: target declaration has no issueResolver`)
              return (await lookup(raw)).id
            }),
        )
        entry.issues = bindings.issues
        entry.branches = bindings.branches
        entry.bindingKey = await bindingKey()
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
  // The hint is written in the same step as the round row that reports what the
  // round did, so a restart resumes at the next environment (ruling 27723).
  const cursorEnv = inventory.rows[progress.cursor]?.name
  progress.hint = cursorEnv
  if (cursorEnv !== undefined) {
    try {
      mkdirSync(dirname(hintPath), { recursive: true })
      atomicWriteFileSync(
        hintPath,
        JSON.stringify({ cursorEnv, runId: outcome.run, at: new Date().toISOString() }) + "\n",
      )
    } catch (cause) {
      // A hint we cannot write is named, never silent; the sweep itself stands.
      record(hintPath, "cursor-write-failed", String(cause))
    }
  }
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
      ms: Date.now() - startedAt,
      lookups,
      ...(censusReceipt === undefined ? {} : { census: censusReceipt }),
    })}\n`,
  )
}
