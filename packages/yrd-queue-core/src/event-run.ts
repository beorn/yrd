/** Run a change from the event projection, leasing its merge with the queue. */
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Conflict } from "./git.ts"

import {
  appendChangeEvent,
  appendPublishedMerge,
  changesRef,
  listChangeHistories,
  readChangeEvents,
  queueResumedAfter,
  readEventQueue,
  readStatus,
  writeQueueEvent,
  type EventCheck,
  type EventChange,
} from "./events.ts"
import { eventRows } from "./event-table.ts"
import { assertPlainEventQueueRun } from "./event-config.ts"
import { eventDirectMergeCommits } from "./direct.ts"
import { createEventStore, selectionFor, listRefs, type Event } from "./git.ts"
import { checkLogPath, DEFAULT_CHECK_BOUND_MS, runCheck, type CheckResult } from "./check.ts"
import { queueName } from "./config.ts"
import { offTheTarget, type Git, type GitInvocationOptions, type GitRunner } from "./git.ts"
import type { QueueRunLog } from "./log.ts"
import { programRootCheck, recordProgramResult, recordProgramStart } from "./program-root.ts"
import { queueRefPrefix } from "./refs.ts"
import { verifyCandidate } from "./verifying.ts"
import { publishCheckedChildren } from "./publication.ts"
import { prepareWorktree, SETUP, SetupFailed } from "./worktree.ts"
import { restoreScripts, short, type QueueRunOptions, type QueueRunOutcome, type RoundLine } from "./run.ts"
import { dispatchNotifications, messageFor } from "./with-notify.ts"
import { changeName } from "./refs.ts"
import { transportFaultIn } from "./setup-transport.ts"
import { readRootChanges } from "./legacy-records.ts"
import { mergedBy } from "./legacy-records.ts"
import { settledBaseCommit } from "./settled-base.ts"
import { repairMissingBranchHeads } from "./remote.ts"

function discardedJudgementReason(current: EventChange, error: unknown): string {
  const failed = error instanceof Error ? error.message : String(error)
  return current.ending === undefined
    ? `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round judged it: ${failed}`
    : `change ended ${current.ending.kind} at ${current.ending.id} while this round judged it: ${failed}`
}

/** Keep every diagnostic character while meeting Gitomic's single-line trailer contract. */
function noticeReason(reason: string): string {
  const written = reason.trim().replace(/[\x00-\x1f\x7f]/gu, (char) => JSON.stringify(char).slice(1, -1))
  if (written === "") throw new Error("notification failure has no reason to retain")
  return written
}

/** A migrated ending was already told by the old queue; fresh endings need their own receipt. */
export function eventNoticeOwed(
  ending: Pick<Event, "id" | "props">,
  notices: EventChange["notices"],
  recipient: string,
): boolean {
  return !ending.props.some(([key]) => key === "Migrated-From") && notices?.[`${ending.id}:${recipient}`] === undefined
}

type SettledNotice = Readonly<{ result: "delivered" | "refused" | "failed"; reason?: string }>

/** One retry budget and one journal shape for branch and direct event notices. */
async function settleEventNotice(
  context: Readonly<{
    options: QueueRunOptions
    git: Git
    target: string
    log: QueueRunLog
    url: string
    queue: string
  }>,
  entry: NonNullable<QueueRunOptions["notify"]>[number],
  kind: Parameters<typeof dispatchNotifications>[1],
  record: Parameters<typeof dispatchNotifications>[2],
  message: Readonly<{ about: string; branch: string; head: string; id: string; text: string }>,
): Promise<SettledNotice> {
  const { options, git, target, log, url, queue } = context
  for (let attempt = 1; attempt <= 2; attempt++) {
    const delivered = (
      await dispatchNotifications(
        {
          git,
          repo: options.repo,
          targetSha: target,
          workdir: options.workdir,
          notify: [entry],
          setup: options.setup,
          env: options.env,
          populateReference: options.populateReference,
          process: options.process,
        },
        kind,
        record,
      )
    )[0]
    if (delivered === undefined || delivered.delivery === "none") {
      throw new Error(
        `event queue ${url}#${queue}: ${message.branch} expected notify recipient ${entry.name}, got none`,
      )
    }
    log.write({
      kind: "message",
      ...message,
      says: kind,
      to: entry.name,
      delivered: delivered.delivery === "sent",
      ...(delivered.failure === undefined ? {} : { error: delivered.failure }),
      ...(delivered.refused === undefined ? {} : { refused: delivered.refused }),
    })
    if (delivered.delivery === "sent") return { result: "delivered" }
    if (delivered.refused !== undefined) return { result: "refused", reason: noticeReason(delivered.refused) }
    if (attempt === 2) {
      return {
        result: "failed",
        reason: noticeReason(delivered.failure ?? `notify ${entry.name} gave no delivery receipt`),
      }
    }
  }
  throw new Error(`event queue ${url}#${queue}: ${message.branch} notice ${entry.name} has no final result`)
}

export async function eventQueueRun(
  options: QueueRunOptions,
  prepared: Readonly<{
    git: Git
    gitOptions: GitInvocationOptions
    hooksPath: string
    log: QueueRunLog
    selected: GitRunner
    url: string
  }>,
): Promise<QueueRunOutcome> {
  assertPlainEventQueueRun(options, options)
  const store = createEventStore(
    options.repo,
    options.target.remote,
    options.selection ?? selectionFor(prepared.selected),
  )
  const queue = options.target.branch
  const { git, gitOptions, hooksPath, log, selected, url } = prepared
  const owned = new Set<string>()
  const appendOwnedChange = async (...args: Parameters<typeof appendChangeEvent>): Promise<string> => {
    const oid = await appendChangeEvent(...args)
    owned.add(oid)
    return oid
  }
  const appendOwnedMerge = async (...args: Parameters<typeof appendPublishedMerge>): Promise<string> => {
    const oid = await appendPublishedMerge(...args)
    owned.add(oid)
    return oid
  }
  const rivalOrThrow = async (
    branch: string,
    selectedTip: string,
    current: EventChange,
    error: unknown,
  ): Promise<void> => {
    if (current.tip === selectedTip) throw error
    if (current.tip === undefined) {
      throw new Error(`event queue ${url}#${queue}: publication-unknown for ${branch}: current chain has no tip`, {
        cause: error,
      })
    }
    const history = await readChangeEvents(store, queue, branch, current.tip)
    const at = history.findIndex((event) => event.id === selectedTip)
    const successor = at < 0 ? undefined : history[at + 1]?.id
    if (successor !== undefined && owned.has(successor)) throw error
    if (successor !== undefined && error instanceof Conflict) return
    throw new Error(
      `event queue ${url}#${queue}: publication-unknown for ${branch} after ${selectedTip}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

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
  /** The line as this round read it (25669), stated on every outcome once the line is read. */
  const read: { line?: RoundLine } = {}
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
    ...(read.line === undefined ? {} : { line: read.line }),
    ...(stopped === undefined ? {} : { stopped }),
  })
  const tell = async (
    branch: string,
    kind: "merged" | "failed" | "stuck" | "deferred" | "cancelled",
    eventId: string,
    existingEnding?: Pick<Event, "id" | "props">,
  ): Promise<void> => {
    if ((options.notify?.length ?? 0) === 0) return
    const change = await readStatus(store, queue, branch)
    if (change.commit === undefined) {
      throw new Error(`event queue ${url}#${queue}: ${branch} notice has no submitted commit`)
    }
    if (change.lastNotifiable?.id !== eventId || change.lastNotifiable.kind !== kind) {
      throw new Error(`event queue ${url}#${queue}: ${branch} notice lost its ${kind} event ${eventId}`)
    }
    const head = change.commit
    const text = messageFor(kind, {
      branch,
      head,
      subject: change.reason ?? kind,
      ...(kind === "merged" ? { merge: change.candidate ?? "" } : {}),
      ...(kind === "deferred" ? { projectedMs: change.deferred?.projectedMs, boundMs: change.deferred?.boundMs } : {}),
    })
    let tip = change.tip
    if (tip === undefined) throw new Error(`event queue ${url}#${queue}: ${branch} notice has no chain tip`)
    // Endings written by this round cannot carry migration provenance. The
    // existing-ending pass supplies the actual event so old delivery is settled.
    const ending = existingEnding ?? { id: eventId, props: [] }
    for (const entry of options.notify ?? []) {
      if (!entry.on.includes(kind)) continue
      if (!eventNoticeOwed(ending, change.notices, entry.name)) continue
      const key = `${eventId}:${entry.name}`
      const final = await settleEventNotice(
        { options, git, target, log, url, queue },
        entry,
        kind,
        {
          record: kind,
          change: changeName({ branch, head }),
          ...(change.issue === undefined ? {} : { issue: change.issue }),
          ...(change.submitter === undefined ? {} : { submitter: change.submitter }),
          ...(kind === "merged"
            ? { merge: change.candidate ?? "" }
            : { reason: kind === "cancelled" ? "branch absent from remote" : (change.reason ?? kind), log: log.path }),
          ...(kind === "deferred"
            ? { projectedMs: change.deferred?.projectedMs, boundMs: change.deferred?.boundMs }
            : {}),
        },
        { about: branch, branch, head, id: eventId, text },
      )
      tip = await appendOwnedChange(store, queue, branch, tip, {
        type: "notified",
        at: new Date(),
        ...(final.reason === undefined ? {} : { reason: final.reason }),
        notice: {
          for: eventId,
          to: entry.name,
          key,
          result: final.result,
          ...(final.reason === undefined ? {} : { reason: final.reason }),
        },
      })
    }
  }
  const tellDirect = async (commit: string, eventId: string): Promise<void> => {
    if ((options.notify?.length ?? 0) === 0) return
    for (const entry of options.notify ?? []) {
      if (!entry.on.includes("merged-direct")) continue
      const state = await readEventQueue(store, queue)
      if (state.observed[commit]?.id !== eventId) {
        throw new Error(`event queue ${url}#${queue}: direct notice lost observed ${commit} at ${eventId}`)
      }
      const key = `${eventId}:${entry.name}`
      if (state.notices[key] !== undefined) continue
      const final = await settleEventNotice(
        { options, git, target, log, url, queue },
        entry,
        "merged-direct",
        { record: "merged-direct", change: commit },
        { about: queue, branch: queue, head: commit, id: eventId, text: `direct merge ${commit} observed on ${queue}` },
      )
      await writeQueueEvent(store, queue, {
        type: "notified",
        by: "yrd-run",
        at: new Date(),
        notice: {
          for: eventId,
          to: entry.name,
          key,
          result: final.result,
          ...(final.reason === undefined ? {} : { reason: final.reason }),
        },
      })
    }
  }
  if (observation.contract === "root-v1" && observation.outcome !== "observed") {
    return result(observation.outcome === "invalid" ? 2 : 0)
  }

  let queueState = await readEventQueue(store, queue)
  for (const [commit, observed] of Object.entries(queueState.observed)) await tellDirect(commit, observed.id)
  const { histories, invalid } = await listChangeHistories(store, queue)
  for (const [branch, defect] of invalid) {
    log.write({
      kind: "observation",
      subject: "invalid-change-chain",
      branch,
      ref: defect.ref,
      tip: defect.tip,
      error: defect.error,
    })
  }
  const changes = new Map([...histories].map(([branch, history]) => [branch, history.state]))
  // WHEN THE QUEUE LAST JUDGED A CHANGE (25669): the latest merged or failed
  // ending on any chain, read from the chains themselves so a relaunched service
  // knows it without having watched it happen. A cancel is a person's act, not the
  // line flowing, and does not count.
  let lastJudgedMs: number | undefined
  for (const change of changes.values()) {
    const kind = change.ending?.kind
    if ((kind === "merged" || kind === "failed") && change.endedAt !== undefined) {
      lastJudgedMs = Math.max(lastJudgedMs ?? 0, change.endedAt.getTime())
    }
  }
  for (const [branch, change] of changes) {
    const latest = change.lastNotifiable
    if (latest !== undefined && (latest.kind !== "cancelled" || change.reason === "deleted")) {
      const history = histories.get(branch)
      const ending = history?.events.find((event) => event.id === latest.id)
      if (ending === undefined) {
        throw new Error(`event queue ${url}#${queue}: ${branch} has no event ${latest.id} for its latest notice`)
      }
      if (
        (options.notify ?? []).some(
          (entry) => entry.on.includes(latest.kind) && eventNoticeOwed(ending, change.notices, entry.name),
        )
      ) {
        await tell(branch, latest.kind, latest.id, ending)
        changes.set(branch, await readStatus(store, queue, branch))
      }
    }
  }
  const direct = await eventDirectMergeCommits(
    git,
    queue,
    target,
    queueState.declaration,
    histories,
    new Set(Object.keys(queueState.observed)),
  )
  directMerges = direct.map((commit) => commit.commit)
  for (const commit of direct) {
    const observed = await writeQueueEvent(store, queue, {
      type: "observed",
      commit: commit.commit,
      ...(commit.branch === undefined ? {} : { branch: commit.branch }),
      by: "yrd-run",
      at: new Date(),
    })
    log.write({
      kind: "merged-direct",
      branch: queue,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
    await tellDirect(commit.commit, observed)
  }
  if (direct.length > 0) queueState = await readEventQueue(store, queue)
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
      const written = await appendOwnedChange(store, queue, branch, selectedTip, {
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
      await tell(branch, "merged", written)
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
      await rivalOrThrow(branch, selectedTip, current, error)
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
  const open: {
    branch: string
    status: string
    since: Date
    commit: string
    tip: string
    reason?: string
    issue?: string
    submitter?: string
  }[] = []
  for (const row of eventRows(changes)) {
    if (row.position === undefined) continue
    const branch = row.branch
    if (options.only !== undefined && (options.only.branch !== branch || options.only.head !== row.head)) continue
    const change = changes.get(branch)
    if (change === undefined) throw new Error(`event queue ${url}#${queue}: missing projected change ${branch}`)
    if (options.tier === "long" ? change.deferred === undefined : change.deferred !== undefined) continue
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
      issue: change.issue,
      submitter: change.submitter,
    })
  }
  const endDeletedChange = async (selected: (typeof open)[number]): Promise<void> => {
    const { branch, commit: head } = selected
    let tip = selected.tip
    try {
      tip = await appendOwnedChange(store, queue, branch, tip, {
        type: "cancelled",
        at: new Date(),
        commit: head,
        reason: "deleted",
        title: `${branch} absent from remote`,
      })
      const ended = await readStatus(store, queue, branch)
      if (ended.status !== "cancelled" || ended.reason !== "deleted" || ended.commit !== head || ended.tip !== tip) {
        throw new Error(
          `event queue ${url}#${queue}: deleted branch ${branch} wrote ${tip} but read back ${ended.status} at ${ended.tip ?? "no tip"}`,
        )
      }
      log.write({ kind: "change", branch, head, decision: "cancelled", reason: "branch absent from remote" })
      await tell(branch, "cancelled", tip)
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
      await rivalOrThrow(branch, tip, current, error)
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: `change advanced to ${current.status} at ${current.tip ?? "no tip"} while this round ended its deleted branch: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  const repaired = await repairMissingBranchHeads(
    await listRefs("refs/heads/", store),
    open.map(({ branch, since }) => ({ branch, openedAt: since.getTime() })),
    store.remote,
    (exact) => listRefs(exact, store),
    options.now ?? Date.now,
    options.branchDeletionGraceMs,
  )
  log.write({
    kind: "observation",
    subject: "branch-list-omissions",
    count: repaired.omissions.length,
    branches: repaired.omissions.map((row) => row.branch),
  })
  for (const row of repaired.omissions) log.write({ kind: "observation", subject: "branch-list-omission", ...row })
  const branchHeads = repaired.heads
  const unconfirmed = new Set(repaired.omissions.filter((row) => row.protected).map((row) => row.branch))
  const remaining: typeof open = []
  for (const selectedChange of open) {
    // A merging marker owns this chain until its frozen landing settles, even
    // when the submitter deleted the branch name during a killed run.
    if (
      selectedChange.status === "merging" ||
      unconfirmed.has(selectedChange.branch) ||
      branchHeads.has(`refs/heads/${selectedChange.branch}`)
    ) {
      remaining.push(selectedChange)
    } else {
      await endDeletedChange(selectedChange)
    }
  }
  // THE LINE, journaled on every round (25669, @cto d3af5793): the waiting count
  // is the number the stall threshold is tuned from, and the service reads the
  // same reading off the outcome.
  const oldest = remaining.reduce<(typeof remaining)[number] | undefined>(
    (earliest, change) => (earliest === undefined || change.since < earliest.since ? change : earliest),
    undefined,
  )
  const roundLine: RoundLine = {
    waiting: remaining.length,
    ...(oldest === undefined ? {} : { oldest: { branch: oldest.branch, openedAt: oldest.since.toISOString() } }),
    ...(lastJudgedMs === undefined ? {} : { lastJudgedAt: new Date(lastJudgedMs).toISOString() }),
  }
  log.write({
    kind: "observation",
    subject: "line",
    waiting: roundLine.waiting,
    ...(roundLine.oldest === undefined
      ? {}
      : { oldestBranch: roundLine.oldest.branch, oldestOpenedAt: roundLine.oldest.openedAt }),
    ...(roundLine.lastJudgedAt === undefined ? {} : { lastJudgedAt: roundLine.lastJudgedAt }),
  })
  read.line = roundLine
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
  const publish = async (
    branch: string,
    head: string,
    candidate: string,
    marker: string,
    reason?: string,
  ): Promise<QueueRunOutcome> => {
    const current = await readStatus(store, queue, branch)
    if (current.tip !== marker) {
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: discardedJudgementReason(current, "marker moved before child publication"),
      })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
    }
    const parent = (await git(["show", "-s", "--format=%P", candidate])).trim().split(/\s+/u)[0]
    if (parent === undefined || parent === "") throw new Error(`candidate ${candidate} has no target parent`)
    let child
    try {
      child = await publishCheckedChildren({
        git,
        cwd: options.repo,
        candidate,
        remote: options.target.remote,
        branch: queue,
        marker: { ref: changesRef(queue, branch), tip: marker },
        process: options.process,
        env: options.env,
        hooksPath,
        gitOptions,
      })
    } catch (error) {
      const after = await readStatus(store, queue, branch)
      await rivalOrThrow(branch, marker, after, error)
      log.write({ kind: "discarded", branch, head, reason: discardedJudgementReason(after, error) })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
    }
    if (child.state === "refused") {
      const description =
        `${branch}: frozen component publication for ${candidate} refused: ${child.evidence}; ` +
        "repair the named component remote/ref, then resume the queue"
      const oneLine = description.replace(/\s+/gu, " ").trim()
      const ended = await appendOwnedChange(store, queue, branch, marker, {
        type: "stuck",
        at: new Date(),
        reason: oneLine,
      })
      await tell(branch, "stuck", ended)
      log.write({ kind: "change", branch, head, decision: "stuck", reason: oneLine, saw: child.evidence })
      return result(2, observedMerged, failed, [branch])
    }
    try {
      const ended = await appendOwnedMerge(store, queue, branch, marker, {
        at: new Date(),
        commit: candidate,
        targetExpect: parent,
        queueTip: queueState.tip,
        ...(reason === undefined ? {} : { reason }),
      })
      await tell(branch, "merged", ended)
    } catch (error) {
      const after = await readStatus(store, queue, branch)
      if (after.tip !== marker) {
        await rivalOrThrow(branch, marker, after, error)
        log.write({ kind: "discarded", branch, head, reason: discardedJudgementReason(after, error) })
        return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
      }
      const movedTarget = (await listRefs(targetRef, store)).get(targetRef)
      if (movedTarget === undefined) {
        throw new Error(`event queue ${url}#${queue}: target disappeared after component publication`, { cause: error })
      }
      if (movedTarget === parent) throw error
      await appendOwnedChange(store, queue, branch, marker, {
        type: "verifying",
        at: new Date(),
        commit: candidate,
        reason: `root target moved after component publication from ${parent} to ${movedTarget}; components at frozen sources`,
      })
      log.write({
        kind: "change",
        branch,
        head,
        decision: "retry",
        reason: "root target moved after component publication",
      })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed, [], [branch], undefined, movedTarget)
    }
    log.write({ kind: "merge", branch, head, commit: candidate })
    log.write({ kind: "change", branch, head, decision: "merged" })
    return result(failed.length > 0 ? 1 : 0, [...observedMerged, branch], failed, [], [], undefined, candidate)
  }
  for (const selectedChange of line) {
    const { branch, commit: head } = selectedChange
    if (unconfirmed.has(branch) && selectedChange.status !== "merging") {
      log.write({ kind: "observation", subject: "branch-confirmation-pending", branch, head })
      return result(failed.length > 0 ? 1 : 0, observedMerged, failed, [], [branch])
    }
    let tip = selectedChange.tip
    if (options.stopAtMs !== undefined && (options.now?.() ?? Date.now()) >= options.stopAtMs) {
      return result(0, observedMerged, [], [], [branch])
    }
    const branchRef = `refs/heads/${branch}`
    if (selectedChange.status !== "merging" && !(await listRefs(branchRef, store)).has(branchRef)) {
      await endDeletedChange({ ...selectedChange, tip })
      continue
    }
    if (selectedChange.status === "merging") {
      const candidate = changes.get(branch)?.candidate
      if (candidate === undefined) {
        throw new Error(`event queue ${url}#${queue}: merging ${branch} lost its checked candidate`)
      }
      return publish(branch, head, candidate, tip, selectedChange.reason)
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
      message: [
        `merge ${short(branch, head)} into ${queue}`,
        "",
        `Change: ${changeName({ branch, head })}`,
        `Merged-By: ${mergedBy(queue, log.id)}`,
        ...(selectedChange.issue === undefined ? [] : [`Issue: ${selectedChange.issue}`]),
        ...(selectedChange.submitter === undefined ? [] : [`Submitter: ${selectedChange.submitter}`]),
      ].join("\n"),
      process: options.process,
      env: options.env,
      hooksPath,
      worktree: {
        env: options.env,
        gitOptions,
        populateReference: options.populateReference,
        process: options.process,
        selection: options.selection,
      },
    })
    try {
      if (verified.state === "failed") {
        await verified.failedWorktree.remove()
        const ended = await appendOwnedChange(store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          reason: verified.verifying.detail.message,
        })
        await tell(branch, "failed", ended)
        log.write({ kind: "change", branch, head, decision: "failed" })
        failed.push(branch)
        continue
      }
      const candidate = verified.verifying.candidate
      const raises = (await readRootChanges(git, candidate))?.changes ?? []
      tip = await appendOwnedChange(store, queue, branch, tip, { type: "verifying", at: new Date(), commit: candidate })
      const checkLogs = (["submit", "merge"] as const).flatMap((phase) =>
        (options.noCheck === true ? [] : options.checks.filter((check) => (check.on ?? ["merge"]).includes(phase))).map(
          (check) =>
            checkLogPath(join(options.workdir, "checks", `${branch}@${head}`, log.id, "attempt-1", phase), check.name),
        ),
      )
      tip = await appendOwnedChange(store, queue, branch, tip, {
        type: "checking",
        at: new Date(),
        ...(checkLogs.length === 0 ? {} : { reason: `check logs: ${checkLogs.join(", ")}` }),
      })
      const results: EventCheck[] = []
      let attemptedRetry = false
      let decisionResults: EventCheck[] = []
      let setupDecision:
        | { kind: "failed" | "stuck"; reason: string; fault?: ReturnType<typeof transportFaultIn> }
        | undefined
      for (let attempt = 1; attempt <= 2; attempt++) {
        const startOfAttempt = results.length
        for (const phase of ["submit", "merge"] as const) {
          const checks =
            options.noCheck === true ? [] : options.checks.filter((check) => (check.on ?? ["merge"]).includes(phase))
          if (checks.length === 0 && options.setup === undefined) continue
          const logDir = join(
            options.workdir,
            "checks",
            `${branch}@${head}`,
            log.id,
            `attempt-${String(attempt)}`,
            phase,
          )
          const tmpdir = join(options.workdir, "tmp")
          const setupAbout = { branch, head, name: SETUP, phase }
          let worktree
          try {
            worktree = await prepareWorktree(
              git,
              options.repo,
              candidate,
              join(options.workdir, "worktrees", log.id, `${branch.replaceAll("/", "_")}-${phase}-${String(attempt)}`),
              {
                targetSha: target,
                populateReference: options.populateReference,
                selection: options.selection,
                gitOptions,
                process: options.process,
                env: options.env,
                ...(options.setup === undefined ? {} : { setup: { run: options.setup, logDir, tmpdir } }),
                starting: ({ log: path, start }) => recordProgramStart({ log }, { ...setupAbout, start, log: path }),
                record: ({ result: setupResult, start, end }) =>
                  recordProgramResult({ log }, { ...setupAbout, start, end }, setupResult),
              },
            )
          } catch (error) {
            if (!(error instanceof SetupFailed)) throw error
            if (options.setup === undefined) {
              throw new Error(`event queue ${url}#${queue}: ${branch} setup failed without a setup declaration`, {
                cause: error,
              })
            }
            let ground: "passed" | "failed" = "failed"
            let baseFailure: SetupFailed | undefined
            try {
              const baseCommit = await settledBaseCommit({
                git,
                repo: options.repo,
                targetSha: target,
                raises,
                path: join(
                  options.workdir,
                  "worktrees",
                  log.id,
                  "compose",
                  "base",
                  `${branch.replaceAll("/", "_")}-${String(attempt)}`,
                ),
                branch,
                env: options.env,
                gitOptions,
                populateReference: options.populateReference,
                process: options.process,
                selection: options.selection,
              })
              const baseTree = await prepareWorktree(
                git,
                options.repo,
                baseCommit,
                join(options.workdir, "worktrees", log.id, `${branch.replaceAll("/", "_")}-base-${String(attempt)}`),
                {
                  targetSha: target,
                  populateReference: options.populateReference,
                  selection: options.selection,
                  gitOptions,
                  process: options.process,
                  env: options.env,
                  setup: {
                    run: options.setup,
                    logDir: join(
                      options.workdir,
                      "checks",
                      `${branch}@${head}`,
                      log.id,
                      `attempt-${String(attempt)}`,
                      "base",
                    ),
                    tmpdir,
                  },
                },
              )
              await baseTree.remove()
              ground = "passed"
            } catch (baseError) {
              if (!(baseError instanceof SetupFailed)) {
                throw new AggregateError(
                  [error, baseError],
                  `event queue ${url}#${queue}: ${branch} setup failed and its base could not be judged`,
                )
              }
              baseFailure = baseError
            }
            results.push({
              run: error.ran.result,
              attempt,
              phase,
              ...(options.tier === "long" ? { tier: "long" as const } : {}),
            })
            let fault: ReturnType<typeof transportFaultIn>
            let logProblem: string | undefined
            if (ground === "failed") {
              try {
                fault = transportFaultIn(
                  [
                    readFileSync(error.ran.result.log, "utf8"),
                    baseFailure === undefined ? "" : readFileSync(baseFailure.ran.result.log, "utf8"),
                  ].join("\n"),
                )
              } catch (readError) {
                logProblem = `setup log unavailable for transport attribution: ${readError instanceof Error ? readError.message : String(readError)}`
              }
            }
            setupDecision = {
              kind: ground === "passed" ? "failed" : "stuck",
              reason: `setup ${error.ran.result.result} on candidate; settled base setup ${ground}; ${error.message.replace(/\s+/gu, " ")}${logProblem === undefined ? "" : `; ${logProblem}`}`,
              ...(fault === undefined ? {} : { fault }),
            }
            break
          }
          try {
            for (const check of checks) {
              const evidencePhase = phase
              if (options.stopAtMs !== undefined && (options.now?.() ?? Date.now()) >= options.stopAtMs) {
                results.push({
                  run: {
                    name: check.name,
                    result: "deferred",
                    exit: 0,
                    durationMs: 0,
                    log: "",
                    why: "stop-time",
                    projectedMs:
                      (options.tier === "long" ? check.long?.timeoutMs : undefined) ??
                      check.timeoutMs ??
                      DEFAULT_CHECK_BOUND_MS,
                    boundMs: 0,
                  },
                  attempt,
                  phase: evidencePhase,
                  ...(options.tier === "long" ? { tier: "long" as const } : {}),
                })
                break
              }
              let checked: CheckResult
              if (check.programRoot === true) {
                checked = await programRootCheck({
                  git,
                  repo: options.repo,
                  targetSha: target,
                  tree: worktree.tree,
                  spec: check,
                  branch,
                  head,
                  phase: evidencePhase,
                  root: join(options.workdir, "worktrees", log.id, "program", phase, String(attempt), check.name),
                  logDir,
                  tmpdir,
                  log,
                  setup: options.setup,
                  env: options.env,
                  process: options.process,
                  selection: options.selection,
                  gitOptions,
                  populateReference: options.populateReference,
                  tier: options.tier,
                })
              } else {
                await restoreScripts(
                  { git, targetSha: target, process: options.process, selection: options.selection, gitOptions },
                  check,
                  worktree.path,
                )
                const start = new Date().toISOString()
                const about = { branch, head, name: check.name, phase: evidencePhase, start }
                recordProgramStart({ log }, { ...about, log: checkLogPath(logDir, check.name) })
                checked = await runCheck({
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
              }
              results.push({
                run: checked,
                attempt,
                phase: evidencePhase,
                ...(options.tier === "long" ? { tier: "long" as const } : {}),
              })
              if (checked.result !== "pass") break
            }
          } finally {
            await worktree.remove()
          }
          if (setupDecision !== undefined || results.slice(startOfAttempt).some(({ run }) => run.result !== "pass")) {
            break
          }
        }
        decisionResults = results.slice(startOfAttempt)
        if (setupDecision !== undefined) {
          if (attempt === 1 && setupDecision.kind === "stuck" && setupDecision.fault !== undefined) {
            attemptedRetry = true
            log.write({
              kind: "warning",
              branch,
              head,
              reason: "retried",
              remote: setupDecision.fault.signature,
              subject: setupDecision.fault.line,
            })
            setupDecision = undefined
            continue
          }
          break
        }
        const stoppedThisAttempt = decisionResults.find(({ run }) => run.result !== "pass")
        if (attempt === 1 && stoppedThisAttempt?.run.result === "stuck") {
          const check = stoppedThisAttempt.run
          const fault = transportFaultIn(`${readFileSync(check.log, "utf8")}\n${check.why ?? ""}`)
          if (fault !== undefined) {
            attemptedRetry = true
            log.write({
              kind: "warning",
              branch,
              head,
              reason: "retried",
              remote: fault.signature,
              subject: fault.line,
            })
            continue
          }
        }
        break
      }
      const stopped = decisionResults.find(({ run }) => run.result !== "pass")
      const stoppedCheck = stopped?.run
      if (setupDecision !== undefined) {
        const ended = await appendOwnedChange(store, queue, branch, tip, {
          type: setupDecision.kind,
          at: new Date(),
          commit: candidate,
          base: target,
          config: options.configBlob,
          checks: attemptedRetry && setupDecision.kind === "stuck" ? results : decisionResults,
          reason: setupDecision.reason,
          ...(attemptedRetry && setupDecision.kind === "stuck" ? { retry: { retried: 1 as const } } : {}),
        })
        await tell(branch, setupDecision.kind, ended)
        log.write({ kind: "change", branch, head, decision: setupDecision.kind, reason: setupDecision.reason })
        if (setupDecision.kind === "stuck") return result(2, observedMerged, failed, [branch])
        failed.push(branch)
        continue
      }
      const evidence: { checks: EventCheck[]; base: string; config: string; commit: string } = {
        checks: attemptedRetry && stoppedCheck?.result === "stuck" ? results : decisionResults,
        base: target,
        config: options.configBlob,
        commit: candidate,
      }
      if (stoppedCheck?.result === "fail") {
        const ended = await appendOwnedChange(store, queue, branch, tip, {
          type: "failed",
          at: new Date(),
          ...evidence,
          reason: `${stoppedCheck.name} failed (exit ${String(stoppedCheck.exit)}; log ${stoppedCheck.log})`,
        })
        await tell(branch, "failed", ended)
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
        const ended = await appendOwnedChange(store, queue, branch, tip, {
          type: "stuck",
          at: new Date(),
          ...evidence,
          ...(attemptedRetry ? { retry: { retried: 1 as const } } : {}),
          reason: `${stoppedCheck.name} could not judge (${stoppedCheck.why ?? `exit ${String(stoppedCheck.exit)}`}; log ${stoppedCheck.log})`,
        })
        await tell(branch, "stuck", ended)
        log.write({ kind: "change", branch, head, decision: "stuck", reason: stoppedCheck.name })
        return result(2, observedMerged, failed, [branch])
      }
      if (stoppedCheck?.result === "deferred") {
        const reason = `${stoppedCheck.name} deferred (${stoppedCheck.why ?? "outside normal window"}; log ${stoppedCheck.log})`
        const ended = await appendOwnedChange(store, queue, branch, tip, {
          type: "deferred",
          at: new Date(),
          ...evidence,
          reason,
          deferred: {
            check: stoppedCheck.name,
            phase: stopped?.phase ?? "merge",
            reason,
            projectedMs: stoppedCheck.projectedMs ?? 0,
            boundMs: stoppedCheck.boundMs ?? 0,
          },
        })
        await tell(branch, "deferred", ended)
        log.write({ kind: "change", branch, head, decision: "deferred", reason })
        return result(failed.length > 0 ? 1 : 0, observedMerged, failed, [], [branch])
      }
      const checkReason = checkLogs.length === 0 ? undefined : `merge checks passed; logs: ${checkLogs.join(", ")}`
      tip = await appendOwnedChange(store, queue, branch, tip, {
        type: "merging",
        at: new Date(),
        ...evidence,
        ...(checkReason === undefined ? {} : { reason: checkReason }),
      })
      return await publish(branch, head, candidate, tip, checkReason)
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
      await rivalOrThrow(branch, tip, current, error)
      changes.set(branch, current)
      log.write({
        kind: "discarded",
        branch,
        head,
        reason: discardedJudgementReason(current, error),
      })
    }
  }
  return result(failed.length > 0 ? 1 : 0, observedMerged, failed)
}
