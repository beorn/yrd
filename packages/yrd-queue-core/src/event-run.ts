/** Run a change from the event projection, leasing its merge with the queue. */
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

import {
  appendChangeEvent,
  appendPublishedMerge,
  listChangeHistories,
  mergedHistoryCommits,
  readEventQueue,
  readStatus,
} from "./events.ts"
import { eventRows } from "./event-table.ts"
import { eventDirectMergeCommits } from "./direct.ts"
import { listRefs } from "gitomic/events"
import { queueName } from "./config.ts"
import { gitIn } from "./git.ts"
import { openLog } from "./log.ts"
import { queueRefPrefix } from "./refs.ts"
import { remoteUrl } from "./remote.ts"
import { verifyCandidate } from "./verifying.ts"
import type { QueueRunOptions, QueueRunOutcome } from "./run.ts"

export async function eventQueueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  // The first runner slice only admits queues that declare no executable work.
  // A configured check or notifier must never disappear behind a successful merge.
  if (options.checks.length > 0 || options.setup !== undefined || (options.notify?.length ?? 0) > 0) {
    throw new Error(
      `event queue ${options.target.remote}#${options.target.branch} has checks, setup or notifications; runner execution remains pending in #25040`,
    )
  }
  const store = { repo: options.repo, remote: options.target.remote }
  const queue = options.target.branch
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  log.write({
    kind: "run",
    base: options.targetSha,
    checks: [],
    config: options.configBlob,
    gitlink: options.targetSha,
    pid: process.pid,
    target: queue,
  })
  const git =
    options.git ??
    gitIn(options.repo, options.process, options.selection, {
      ...(options.env === undefined ? {} : { env: options.env }),
      openOutput: log.openGitOutput,
      onInvocation: log.writeGitInvocation,
    })
  const hooksPath = join(options.workdir, "hooks-disabled")
  mkdirSync(hooksPath, { recursive: true })
  const hooks = readdirSync(hooksPath).sort()
  if (hooks.length > 0) {
    throw new Error(
      `queue-owned hooks path ${hooksPath} is not empty (${hooks.join(", ")}); remove the named entries, then run yrd queue run`,
    )
  }

  const url = await remoteUrl(git, options.target.remote)
  log.write({ kind: "queue", queue: queueName(options.target, url) })
  const prefix = queueRefPrefix(queue)
  const advertised = await listRefs(prefix, store)
  const targetRef = `refs/heads/${queue}`
  const target = (await listRefs(targetRef, store)).get(targetRef)
  if (target === undefined) throw new Error(`event queue ${url}#${queue}: missing target ${targetRef}`)
  if (target !== options.targetSha) {
    throw new Error(
      `event queue ${url}#${queue}: target moved from ${options.targetSha} to ${target}; start a new round`,
    )
  }
  const selected = gitIn(options.repo, options.process, options.selection, {
    ...(options.env === undefined ? {} : { env: options.env }),
    openOutput: log.openGitOutput,
    onInvocation: log.writeGitInvocation,
  })
  const observation = await selected.observe({
    version: 1,
    root: { remote: url, targetRef, targetOid: target },
    checked: [],
    fence: { prefixes: [prefix], refs: [...advertised].map(([ref, oid]) => ({ ref, oid })) },
  })
  log.write({
    kind: "observation",
    contract: observation.contract,
    message: observation.message,
    ...(observation.contract === "native" ? {} : { outcome: observation.outcome }),
  })
  let directMerges: readonly string[] = []
  const result = (
    exitCode: 0 | 1 | 2,
    merged: string[] = [],
    failed: string[] = [],
    stuck: string[] = [],
    deferred: string[] = [],
    stopped?: QueueRunOutcome["stopped"],
    targetAfter = target,
  ): QueueRunOutcome => ({
    observation,
    base: options.targetSha,
    config: options.configBlob,
    exitCode,
    log: log.path,
    run: log.id,
    target: targetAfter,
    merged,
    failed,
    stuck,
    deferred,
    directMerges,
    checkedWaiting: 0,
    ...(stopped === undefined ? {} : { stopped }),
  })
  if (observation.contract === "root-v1" && observation.outcome !== "observed") {
    return result(observation.outcome === "invalid" ? 2 : 0)
  }

  const queueState = await readEventQueue(store, queue)
  const histories = await listChangeHistories(store, queue)
  const changes = new Map([...histories].map(([branch, history]) => [branch, history.state]))
  const direct = await eventDirectMergeCommits(
    git,
    queue,
    target,
    queueState.declaration,
    mergedHistoryCommits(histories),
  )
  directMerges = direct.map((commit) => commit.commit)
  for (const commit of direct) {
    log.write({
      kind: "merged-direct",
      branch: queue,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
  }
  if (queueState.pause !== undefined && options.foreground !== true) {
    log.write({ kind: "pause", reason: queueState.pause.reason, by: queueState.pause.by, sha: queueState.pause.id })
    return result(0, [], [], [], [], { ring: "pause", says: queueState.pause.reason, what: queueState.pause })
  }
  const open: { branch: string; status: string; since: Date; commit: string; tip: string; reason?: string }[] = []
  for (const row of eventRows(changes)) {
    if (row.position === undefined) continue
    const branch = row.branch
    if (options.only !== undefined && (options.only.branch !== branch || options.only.head !== row.head)) continue
    const change = changes.get(branch)
    if (change === undefined) throw new Error(`event queue ${url}#${queue}: missing projected change ${branch}`)
    if (change.since === undefined || change.commit === undefined || change.tip === undefined) {
      throw new Error(`event queue ${url}#${queue}: open change ${branch} lacks its opening time, commit or tip`)
    }
    open.push({
      branch,
      status: row.state,
      since: change.since,
      commit: change.commit,
      tip: change.tip,
      reason: change.reason,
    })
  }
  const standing = open.find((change) => change.status === "stuck")
  if (standing !== undefined) {
    log.write({
      kind: "change",
      branch: standing.branch,
      head: standing.commit,
      decision: "stuck",
      reason: standing.reason ?? "queue could not judge this change",
    })
    return result(2, [], [], [standing.branch])
  }
  for (const selectedChange of open) {
    const { branch, commit: head } = selectedChange
    let tip = selectedChange.tip
    if (options.stopAtMs !== undefined && (options.now?.() ?? Date.now()) >= options.stopAtMs) {
      return result(0, [], [], [], [branch])
    }
    // This first runner slice cannot publish component mains beside the root
    // target. Refuse either side's gitlinks before composing a candidate.
    for (const oid of [target, head]) {
      const tree = await git(["ls-tree", "-r", oid])
      if (tree.split("\n").some((line) => line.startsWith("160000 ") || line.endsWith("\t.gitmodules"))) {
        throw new Error(
          `event queue ${url}#${queue}: component pins in ${oid} need atomic publication; runner support remains pending in #25040`,
        )
      }
    }
    log.write({ kind: "change", branch, head })
    const path = join(options.workdir, "worktrees", log.id, branch.replaceAll("/", "_"))
    mkdirSync(join(options.workdir, "worktrees", log.id), { recursive: true })
    const verified = await verifyCandidate({
      git,
      repo: options.repo,
      targetHead: target,
      head,
      path,
      message: `Merge ${branch}`,
      process: options.process,
      env: options.env,
      hooksPath,
    })
    try {
      if (verified.state === "failed") {
        await verified.failedWorktree.remove()
        await appendChangeEvent(store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          reason: verified.verifying.detail.message,
        })
        log.write({ kind: "change", branch, head, decision: "failed" })
        return result(1, [], [branch])
      }
      const candidate = verified.verifying.candidate
      tip = await appendChangeEvent(store, queue, branch, tip, { type: "verifying", at: new Date(), commit: candidate })
      tip = await appendChangeEvent(store, queue, branch, tip, { type: "checking", at: new Date() })
      tip = await appendChangeEvent(store, queue, branch, tip, { type: "merging", at: new Date() })
      await appendPublishedMerge(store, queue, branch, tip, {
        at: new Date(),
        commit: candidate,
        targetExpect: target,
        queueTip: queueState.tip,
      })
      log.write({ kind: "merge", branch, head, commit: candidate })
      log.write({ kind: "change", branch, head, decision: "merged" })
      return result(0, [branch], [], [], [], undefined, candidate)
    } catch (error) {
      let current
      try {
        current = await readStatus(store, queue, branch)
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          `event queue ${url}#${queue}: ${branch} decision failed and its current chain could not be read`,
        )
      }
      if (current.ending === undefined) throw error
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: `change ended ${current.ending.kind} at ${current.ending.id} while this round judged it: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return result(0)
}
