/** Run a change from the event projection, leasing its merge with the queue. */
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

import {
  appendChangeEvent,
  appendPublishedMerge,
  listChangeHistories,
  mergedHistoryCommits,
  queueResumedAfter,
  readEventQueue,
  readStatus,
  type EventChange,
} from "./events.ts"
import { eventRows } from "./event-table.ts"
import { assertPlainEventQueueRun } from "./event-config.ts"
import { eventDirectMergeCommits } from "./direct.ts"
import { listRefs } from "gitomic/events"
import { checkLogPath, runCheck, type CheckResult } from "./check.ts"
import { queueName } from "./config.ts"
import { gitIn, offTheTarget } from "./git.ts"
import { openLog } from "./log.ts"
import { recordProgramResult, recordProgramStart } from "./program-root.ts"
import { queueRefPrefix } from "./refs.ts"
import { remoteUrl } from "./remote.ts"
import { verifyCandidate } from "./verifying.ts"
import { prepareWorktree } from "./worktree.ts"
import type { QueueRunOptions, QueueRunOutcome } from "./run.ts"

export async function eventQueueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  assertPlainEventQueueRun(options, options)
  const store = { repo: options.repo, remote: options.target.remote }
  const queue = options.target.branch
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  log.write({
    kind: "run",
    base: options.targetSha,
    checks: options.checks.map((check) => check.name),
    config: options.configBlob,
    gitlink: options.targetSha,
    pid: process.pid,
    target: queue,
  })
  const gitOptions = {
    ...(options.env === undefined ? {} : { env: options.env }),
    openOutput: log.openGitOutput,
    onInvocation: log.writeGitInvocation,
  }
  const git = options.git ?? gitIn(options.repo, options.process, options.selection, gitOptions)
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
  const selected = gitIn(options.repo, options.process, options.selection, gitOptions)
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
  const observedMerged: string[] = []
  const observable = [...changes].filter(
    (entry): entry is [string, EventChange & { commit: string; tip: string }] =>
      entry[1].status !== "merged" && entry[1].commit !== undefined && entry[1].tip !== undefined,
  )
  const offTarget = await offTheTarget(git, [...new Set(observable.map(([, change]) => change.commit))], target)
  for (const [branch, change] of observable) {
    if (offTarget.has(change.commit)) continue
    const row = (
      await git([
        "rev-list",
        "--reverse",
        "--first-parent",
        "--ancestry-path",
        "--parents",
        `${change.commit}..${target}`,
      ])
    )
      .trim()
      .split("\n")[0]
      ?.trim()
      .split(/\s+/u)
      .filter((sha) => sha !== "")
    const merge = row?.[0] ?? change.commit
    const selectedTip = change.tip
    try {
      const written = await appendChangeEvent(store, queue, branch, selectedTip, {
        type: "merged",
        at: new Date(),
        commit: merge,
        reason: `observed on target at ${merge}`,
        title: `merged ${branch}`,
      })
      const ended = await readStatus(store, queue, branch)
      if (ended.status !== "merged" || ended.tip !== written || ended.ending?.id !== written) {
        throw new Error(
          `event queue ${url}#${queue}: observed merge for ${branch} wrote ${written} but read back ${ended.status} at ${ended.tip ?? "no tip"}`,
        )
      }
      changes.set(branch, ended)
      observedMerged.push(branch)
      log.write({
        kind: "change",
        branch,
        head: change.commit,
        decision: "merged",
        reason: `already on target at ${merge}`,
      })
    } catch (error) {
      let current
      try {
        current = await readStatus(store, queue, branch)
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          `event queue ${url}#${queue}: ${branch} observed-merge decision failed and its current chain could not be read`,
        )
      }
      if (current.tip === selectedTip) throw error
      changes.set(branch, current)
      log.write({
        kind: "discarded",
        branch,
        head: change.commit,
        reason: `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round recorded its target merge: ${error instanceof Error ? error.message : String(error)}`,
      })
      if (current.status === "merged") observedMerged.push(branch)
    }
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
  const endDeletedChange = async (selected: (typeof open)[number]): Promise<void> => {
    const { branch, commit: head } = selected
    let tip = selected.tip
    try {
      tip = await appendChangeEvent(store, queue, branch, tip, {
        type: "cancelled",
        at: new Date(),
        commit: head,
        reason: "deleted",
        title: `deleted ${branch}`,
      })
      const ended = await readStatus(store, queue, branch)
      if (ended.status !== "cancelled" || ended.reason !== "deleted" || ended.commit !== head || ended.tip !== tip) {
        throw new Error(
          `event queue ${url}#${queue}: deleted branch ${branch} wrote ${tip} but read back ${ended.status} at ${ended.tip ?? "no tip"}`,
        )
      }
      log.write({ kind: "change", branch, head, decision: "cancelled", reason: "branch deleted" })
    } catch (error) {
      let current
      try {
        current = await readStatus(store, queue, branch)
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          `event queue ${url}#${queue}: ${branch} deletion decision failed and its current chain could not be read`,
        )
      }
      if (current.tip === tip) throw error
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round ended its deleted branch: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  const branchHeads = await listRefs("refs/heads/", store)
  const remaining: typeof open = []
  for (const selectedChange of open) {
    if (branchHeads.has(`refs/heads/${selectedChange.branch}`)) remaining.push(selectedChange)
    else await endDeletedChange(selectedChange)
  }
  const standing = remaining.find((change) => change.status === "stuck")
  if (standing !== undefined) {
    if (!(await queueResumedAfter(store, queue, standing.branch, histories.get(standing.branch)))) {
      log.write({
        kind: "change",
        branch: standing.branch,
        head: standing.commit,
        decision: "stuck",
        reason: standing.reason ?? "queue could not judge this change",
      })
      return result(2, observedMerged, [], [standing.branch])
    }
    log.write({
      kind: "change",
      branch: standing.branch,
      head: standing.commit,
      decision: "retry",
      reason: "queue resumed",
    })
  }
  const line =
    standing === undefined ? remaining : [standing, ...remaining.filter((change) => change.branch !== standing.branch)]
  const failed: string[] = []
  for (const selectedChange of line) {
    const { branch, commit: head } = selectedChange
    let tip = selectedChange.tip
    if (options.stopAtMs !== undefined && (options.now?.() ?? Date.now()) >= options.stopAtMs) {
      return result(0, observedMerged, [], [], [branch])
    }
    const branchRef = `refs/heads/${branch}`
    if (!(await listRefs(branchRef, store)).has(branchRef)) {
      await endDeletedChange({ ...selectedChange, tip })
      continue
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
        failed.push(branch)
        continue
      }
      const candidate = verified.verifying.candidate
      tip = await appendChangeEvent(store, queue, branch, tip, { type: "verifying", at: new Date(), commit: candidate })
      const checks = options.checks.filter((check) => (check.on ?? ["merge"]).includes("merge"))
      const logDir = join(options.workdir, "checks", `${branch}@${head}`, log.id, "attempt-1", "merge")
      const checkLogs = checks.map((check) => checkLogPath(logDir, check.name))
      tip = await appendChangeEvent(store, queue, branch, tip, {
        type: "checking",
        at: new Date(),
        ...(checkLogs.length === 0 ? {} : { reason: `merge check logs: ${checkLogs.join(", ")}` }),
      })
      const results: CheckResult[] = []
      if (checks.length > 0) {
        const worktree = await prepareWorktree(
          git,
          options.repo,
          candidate,
          join(options.workdir, "worktrees", log.id, `${branch.replaceAll("/", "_")}-checking`),
          {
            targetSha: target,
            populateReference: options.populateReference,
            selection: options.selection,
            gitOptions,
            process: options.process,
            env: options.env,
          },
        )
        try {
          const tmpdir = join(options.workdir, "tmp")
          for (const check of checks) {
            const start = new Date().toISOString()
            const about = { branch, head, name: check.name, phase: "merge", start }
            recordProgramStart({ log }, { ...about, log: checkLogPath(logDir, check.name) })
            const checked = await runCheck({
              cwd: worktree.path,
              tree: worktree.tree,
              logDir,
              tmpdir,
              spec: check,
              process: options.process,
              env: options.env,
              tier: options.tier,
            })
            recordProgramResult({ log }, { ...about, end: new Date().toISOString() }, checked)
            results.push(checked)
            if (checked.result !== "pass") break
          }
        } finally {
          await worktree.remove()
        }
      }
      const stoppedCheck = results.find((check) => check.result !== "pass")
      if (stoppedCheck?.result === "fail") {
        await appendChangeEvent(store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          reason: `${stoppedCheck.name} failed (exit ${String(stoppedCheck.exit)}; log ${stoppedCheck.log})`,
        })
        log.write({
          kind: "change",
          branch,
          head,
          decision: "failed",
          reason: `${stoppedCheck.name} exited ${String(stoppedCheck.exit)}`,
        })
        failed.push(branch)
        continue
      }
      if (stoppedCheck?.result === "stuck") {
        await appendChangeEvent(store, queue, branch, tip, {
          type: "stuck",
          at: new Date(),
          reason: `${stoppedCheck.name} could not judge (${stoppedCheck.why ?? `exit ${String(stoppedCheck.exit)}`}; log ${stoppedCheck.log})`,
        })
        log.write({ kind: "change", branch, head, decision: "stuck", reason: stoppedCheck.name })
        return result(2, observedMerged, failed, [branch])
      }
      if (stoppedCheck?.result === "deferred") {
        throw new Error(
          `event queue ${url}#${queue}: check ${stoppedCheck.name} returned deferred (log ${stoppedCheck.log}); #25040 has no deferred event status and @i/10-yrd/25065-event-queues-run-every-check-kind-beyond-plain-merge-checks owns that representation before #25041`,
        )
      }
      const checkReason = checkLogs.length === 0 ? undefined : `merge checks passed; logs: ${checkLogs.join(", ")}`
      tip = await appendChangeEvent(store, queue, branch, tip, {
        type: "merging",
        at: new Date(),
        ...(checkReason === undefined ? {} : { reason: checkReason }),
      })
      await appendPublishedMerge(store, queue, branch, tip, {
        at: new Date(),
        commit: candidate,
        targetExpect: target,
        queueTip: queueState.tip,
        ...(checkReason === undefined ? {} : { reason: checkReason }),
      })
      log.write({ kind: "merge", branch, head, commit: candidate })
      log.write({ kind: "change", branch, head, decision: "merged" })
      return result(failed.length > 0 ? 1 : 0, [...observedMerged, branch], failed, [], [], undefined, candidate)
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
  return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
}
