import { appendFileSync } from "node:fs"
import { relative, sep } from "node:path"
import { gitIn, listChangeHistories, type GitRunner, type QueueConfig, type QueueRunOutcome } from "@yrd/queue-core"
import { createLocalGitProcess } from "git-super/process"
import { createLocalGitWorktreeStore } from "git-super/worktree"
import { inspectProcessCwds, type ProcessCwdProjection } from "removely"
import { closeEnvironment, environmentInventory } from "./env-commands.ts"
import { environmentIssues } from "./env-cleanup-provenance.ts"
import { issueLookup } from "./issue-resolver.ts"
import type { YrdCliIO } from "./types.ts"

/** One completed round applies the same predicate to current and backlog environments. */
export async function cleanupEnvironments(
  input: Readonly<{
    repo: string
    git: GitRunner
    config: QueueConfig
    workdir: string
    outcome: QueueRunOutcome
    io: YrdCliIO
    env?: NodeJS.ProcessEnv
    resolveIssue: ((raw: string) => Promise<string>) | undefined
  }>,
): Promise<void> {
  const { repo, git, config, workdir, outcome, io } = input
  const inventory = await environmentInventory(repo, git, workdir)
  if (inventory.rows.length === 0) return
  let closed = 0
  let kept = 0
  const record = (path: string, result: string, why: string): void => {
    const row = {
      kind: "observation",
      run: outcome.run,
      at: new Date().toISOString(),
      scope: "environment-cleanup",
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
  const census = async (): Promise<ProcessCwdProjection> => {
    const snapshot = await inspectProcessCwds({ deadlineMs: 2_000 })
    if (!snapshot.complete || snapshot.unreadable.length > 0) {
      throw new Error(
        `same-UID process CWD census ${snapshot.mechanism} incomplete: ${JSON.stringify(snapshot.unreadable)}`,
      )
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
      `${JSON.stringify({ kind: "observation", run: outcome.run, at: new Date().toISOString(), scope: "environment-cleanup", closed, kept, remaining: inventory.rows.length - closed })}\n`,
    )
    return
  }
  const lookup = issueLookup(config, repo, input.env)
  const statuses = new Map<string, Promise<void>>()
  const requireClosed = async (id: string, fresh = false): Promise<void> => {
    if (!fresh && statuses.has(id)) return statuses.get(id)
    const pending = (async () => {
      if (lookup === undefined) {
        throw new Error(`issue ${id}: target declaration has no issueResolver; closure unproven`)
      }
      const issue = await lookup(id)
      if (issue.id !== id || issue.status !== "closed") {
        throw new Error(`issue ${id}: configured lookup returned ${JSON.stringify(issue)}; closure unproven`)
      }
    })()
    if (!fresh) statuses.set(id, pending)
    return pending
  }
  for (const row of inventory.rows) {
    try {
      if (row.hold !== null) throw new Error(`held${row.hold === "" ? "" : `: ${row.hold}`}`)
      const treeGit = gitIn(row.path, undefined, git.selection, { env: input.env })
      const head = (await treeGit(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
      const issues = await environmentIssues(
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
      for (const issue of issues) await requireClosed(issue)
      const holder = busy(row.path, snapshot)
      if (holder !== undefined) throw new Error(holder)
      await ancestor(row.path, head, outcome.target)
      const inspection = await createLocalGitWorktreeStore({ repo, env: input.env }).inspectRemoval(row.path)
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
      // One close per round lets the queue judge a waiting merge before another removal.
      if (closed > 0 || outcome.checkedWaiting > 0) {
        throw new Error("eligible; yielding to the next queue round before removal")
      }
      const freshHolder = busy(row.path, await census())
      if (freshHolder !== undefined) throw new Error(freshHolder)
      for (const issue of issues) await requireClosed(issue, true)
      const current = (await environmentInventory(repo, git, workdir)).rows.find((entry) => entry.path === row.path)
      if (current === undefined || current.hold !== null || current.head !== head) {
        throw new Error("registration, hold or HEAD changed before close")
      }
      let output = ""
      const exit = await closeEnvironment(
        row.path,
        { json: true, noRehome: true },
        {
          ...io,
          cwd: repo,
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
        record(row.path, "closed", "native retained removal proof accepted")
      } else if ("kept" in result && result.kept === row.path) preserve(row.path, output.trim())
      else throw new Error(`unproven close result ${output}`)
    } catch (cause) {
      preserve(row.path, String(cause))
    }
  }
  appendFileSync(
    outcome.log,
    `${JSON.stringify({ kind: "observation", run: outcome.run, at: new Date().toISOString(), scope: "environment-cleanup", closed, kept, remaining: inventory.rows.length - closed })}\n`,
  )
}
