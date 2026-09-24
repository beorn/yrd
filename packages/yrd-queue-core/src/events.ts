/** Yrd's event meaning. Gitomic owns the commits and CAS; this module owns the fold. */
import { Conflict } from "./git.ts"
import { chainsUnder, listRefs, openEvents } from "./git.ts"
import type { AlsoRef, Event, EventInput, GitomicBackend, Oid } from "./git.ts"

import { queueRefPrefix } from "./refs.ts"
import type { PauseRecord } from "./pause.ts"
import { assertPlainEventQueueConfig } from "./event-config.ts"
import { gitIn, refAt } from "./git.ts"
import type { GitSelection } from "./git.ts"
import type { QueueConfig } from "./config.ts"
import { checkTrailer, readCheckTrailer } from "./check.ts"
import type { CheckResult } from "./check.ts"

export const CHANGE_STATUSES = [
  "draft",
  "queued",
  "verifying",
  "checking",
  "merging",
  "merged",
  "failed",
  "stuck",
  "cancelled",
] as const
export type ChangeStatus = (typeof CHANGE_STATUSES)[number]
export type ChangeEnding = "merged" | "failed" | "cancelled"
export type CancellationReason = "resubmitted" | "dropped" | "deleted"
const LANDING_IN_PROGRESS = "landing in progress; resubmit after merged/failed/stuck, resume if runner gone"

export const EVENT_TRAILERS = {
  by: "By",
  commit: "Commit",
  issue: "Issue",
  queue: "Queue",
  reason: "Reason",
  time: "Time",
  check: "Check",
  base: "Base",
  config: "Config",
  retried: "Retried",
  retryReason: "Retry-Reason",
  checkName: "Check-Name",
  phase: "Phase",
  projectedMs: "ProjectedMs",
  boundMs: "BoundMs",
  for: "For",
  branch: "Branch",
  to: "To",
  result: "Result",
  key: "Key",
} as const
const COMMIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
/** Only the run path that atomically publishes the target may write merged with this producer. */
export const QUEUE_RUN_WRITER = "yrd-run"

export const CHANGE_EVENT_TYPES = [
  "opened",
  "verifying",
  "checking",
  "merging",
  "merged",
  "failed",
  "stuck",
  "deferred",
  "cancelled",
  "ignored",
  "unignored",
  "notified",
] as const
export type ChangeEventType = (typeof CHANGE_EVENT_TYPES)[number]

export type EventChange = Readonly<{
  status: ChangeStatus
  /** The submitted commit, or the last head when a branch was dropped before any submit. */
  commit?: string
  /** The last verified composition, kept by its verifying event. */
  candidate?: string
  issue?: string
  submitter?: string
  since?: Date
  at?: Date
  endedAt?: Date
  tip?: string
  /** This chain's latest ending, including the event that recorded it. */
  ending?: { kind: ChangeEnding; id: string }
  /** The latest verdict a notification may name; a stuck verdict leaves the change open. */
  lastNotifiable?: Readonly<{ id: string; kind: ChangeEnding | "deferred" | "stuck" }>
  reason?: string
  ignored?: Readonly<{ reason: string; by: string }>
  deferred?: Readonly<{
    id: string
    check: string
    phase: "submit" | "merge"
    reason: string
    projectedMs: number
    boundMs: number
    at: Date
  }>
  notices?: Readonly<
    Record<string, Readonly<{ for: string; to: string; result: "delivered" | "refused" | "failed"; reason?: string }>>
  >
}>

export const initial: EventChange = Object.freeze({ status: "draft" })

export type EventCheck = Readonly<{ run: CheckResult; attempt: number; phase: "submit" | "merge"; tier?: "long" }>
export type DeferredWrite = Readonly<{
  check: string
  phase: "submit" | "merge"
  reason: string
  projectedMs: number
  boundMs: number
}>
export type NoticeWrite = Readonly<{
  for: string
  to: string
  result: "delivered" | "refused" | "failed"
  key: string
  reason?: string
}>

type ChangeInputDetails = Readonly<{
  queueTip: string
  at: Date
  commit?: string
  issue?: string
  by?: string
  reason?: string
  title?: string
  content?: string
  checks?: readonly EventCheck[]
  base?: string
  config?: string
  retry?: Readonly<{ retried: 1; reason?: string }>
  deferred?: DeferredWrite
  notice?: NoticeWrite
}>

/** The bounded decision evidence; legacy causal trailers stay in changeInput. */
function evidenceProps(type: ChangeEventType, details: ChangeInputDetails): [string, string][] {
  if (details.checks !== undefined && !["merging", "failed", "stuck", "deferred"].includes(type)) {
    throw new TypeError(`${type} cannot carry Check: rows`)
  }
  if (type === "merging" && details.checks?.some(({ run }) => run.result !== "pass")) {
    throw new TypeError("merging Check: rows must all pass")
  }
  if (
    details.checks?.length &&
    (details.base === undefined || details.config === undefined || details.commit === undefined)
  ) {
    throw new TypeError(`${type} Check: rows need Base:, Config: and kept Commit:`)
  }
  if (type === "deferred" && details.deferred === undefined) {
    throw new TypeError("deferred needs check and window detail")
  }
  if (type === "notified" && details.notice === undefined) throw new TypeError("notified needs notice detail")
  if (details.deferred !== undefined) {
    if (type !== "deferred" || details.commit === undefined) throw new TypeError("deferred needs kept Commit:")
    if (details.reason !== details.deferred.reason) throw new TypeError("deferred Reason: must match its detail")
    if (details.deferred.check.trim() === "" || !["submit", "merge"].includes(details.deferred.phase)) {
      throw new TypeError("deferred needs a check name and phase")
    }
    if (![details.deferred.projectedMs, details.deferred.boundMs].every((ms) => Number.isSafeInteger(ms) && ms >= 0)) {
      throw new TypeError("deferred needs nonnegative window milliseconds")
    }
  }
  if (details.notice !== undefined) {
    if (type !== "notified") throw new TypeError("notice detail belongs on notified")
    if (details.notice.key !== `${details.notice.for}:${details.notice.to}`) {
      throw new TypeError("notified has invalid Key:")
    }
    if (details.notice.result !== "delivered" && details.reason !== details.notice.reason) {
      throw new TypeError("refused or failed notice needs matching Reason:")
    }
  }
  if (details.retry !== undefined && type !== "stuck") throw new TypeError("Retried: belongs on stuck")
  if (
    details.retry !== undefined &&
    !details.checks?.some(({ attempt }) => attempt === 2) &&
    details.retry.reason === undefined
  ) {
    throw new TypeError("Retried: 1 needs a second Check: attempt or Retry-Reason:")
  }
  if (
    details.retry !== undefined &&
    details.retry.reason === undefined &&
    !details.checks?.some(({ attempt }) => attempt === 1)
  ) {
    throw new TypeError("Retried: 1 needs the first Check: attempt or Retry-Reason:")
  }
  const props: [string, string][] = []
  if (details.base !== undefined) props.push([EVENT_TRAILERS.base, details.base])
  if (details.config !== undefined) props.push([EVENT_TRAILERS.config, details.config])
  for (const check of details.checks ?? []) props.push([EVENT_TRAILERS.check, checkTrailer(check.run, check)])
  if (details.retry !== undefined) {
    props.push([EVENT_TRAILERS.retried, "1"])
    if (details.retry.reason !== undefined) props.push([EVENT_TRAILERS.retryReason, details.retry.reason])
  }
  if (details.deferred !== undefined) {
    const detail = details.deferred
    props.push([EVENT_TRAILERS.checkName, detail.check], [EVENT_TRAILERS.phase, detail.phase])
    props.push(
      [EVENT_TRAILERS.projectedMs, String(detail.projectedMs)],
      [EVENT_TRAILERS.boundMs, String(detail.boundMs)],
    )
  }
  if (details.notice !== undefined) {
    const notice = details.notice
    props.push([EVENT_TRAILERS.for, notice.for], [EVENT_TRAILERS.to, notice.to])
    props.push([EVENT_TRAILERS.result, notice.result], [EVENT_TRAILERS.key, notice.key])
  }
  return props
}

/** Construct Yrd's required causal trailers; a recorded commit is always kept. */
export function changeInput(type: ChangeEventType, details: ChangeInputDetails): EventInput {
  if (!COMMIT_OID.test(details.queueTip)) throw new TypeError(`Queue: must name a commit oid, got ${details.queueTip}`)
  if (Number.isNaN(details.at.getTime())) throw new TypeError("Time: needs a valid instant")
  if ((type === "opened" || type === "verifying" || type === "merging") && details.commit === undefined) {
    throw new TypeError(`${type} needs Commit:`)
  }
  if (type === "opened" && (details.by === undefined || details.by.trim() === "")) {
    throw new TypeError("opened needs By:")
  }
  if ((type === "ignored" || type === "unignored") && (details.by === undefined || details.by.trim() === "")) {
    throw new TypeError(`yrd-ignore-event-malformed: ${type} needs By:`)
  }
  if (type === "ignored" && (details.reason === undefined || details.reason.trim() === "")) {
    throw new TypeError("yrd-ignore-reason-required: ignored needs Reason:")
  }
  if (type === "unignored" && details.reason !== undefined) {
    throw new TypeError("yrd-ignore-reason-conflict: unignored cannot carry Reason:")
  }
  if (details.commit !== undefined && !COMMIT_OID.test(details.commit)) {
    throw new TypeError(`Commit: must name a commit oid, got ${details.commit}`)
  }
  if (details.issue !== undefined && details.issue.trim() === "") throw new TypeError("Issue: cannot be empty")
  if (details.reason !== undefined && details.reason.trim() === "") throw new TypeError("Reason: cannot be empty")
  const props: [string, string][] = [
    [EVENT_TRAILERS.queue, details.queueTip],
    [EVENT_TRAILERS.time, details.at.toISOString()],
  ]
  if (details.commit !== undefined) props.push([EVENT_TRAILERS.commit, details.commit])
  if (details.issue !== undefined) props.push([EVENT_TRAILERS.issue, details.issue])
  if (details.by !== undefined) props.push([EVENT_TRAILERS.by, details.by])
  if (details.reason !== undefined) props.push([EVENT_TRAILERS.reason, details.reason])
  props.push(...evidenceProps(type, details))
  return {
    type,
    props,
    ...(details.commit === undefined ? {} : { keeps: [details.commit] }),
    ...(details.title === undefined ? {} : { title: details.title }),
    ...(details.content === undefined ? {} : { content: details.content }),
  }
}

/** Queue life is a chain at one reserved leaf, distinct from branch changes. */
export function queueRef(queue: string): string {
  return `${queueRefPrefix(queue)}/queue`
}

/** One chain for a branch's entire sequence of changes. */
export function changesRef(queue: string, branch: string): string {
  assertBranch(branch)
  return `${queueRefPrefix(queue)}/changes/${branch}`
}

function assertBranch(branch: string): void {
  if (
    branch.length === 0 ||
    branch === "@" ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    /[\x00-\x20\x7f~^:?*[\\]/u.test(branch) ||
    branch.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new TypeError(`invalid branch for an event ref: ${JSON.stringify(branch)}`)
  }
}

type EventShape = Pick<Event, "id" | "type" | "props" | "links">

/** What the queue projection reads; a not-yet-written event is validated in this shape, never as a full Event. */
type QueueEventShape = EventShape & Pick<Event, "parent" | "writer">

function prop(event: EventShape, key: string): string | undefined {
  const found = event.props.filter(([name]) => name === key)
  if (found.length > 1) throw new Error(`event ${event.id} repeats ${key}:`)
  return found[0]?.[1]
}

function requiredProp(event: EventShape, key: string): string {
  const value = prop(event, key)
  if (value === undefined || value.trim() === "") throw new Error(`event ${event.id} (${event.type}) needs ${key}:`)
  return value
}

function positiveMs(event: EventShape, key: string): number {
  const written = requiredProp(event, key)
  const value = Number(written)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`event ${event.id} needs ${key}: as nonnegative milliseconds`)
  }
  return value
}

function checkedRows(event: EventShape): void {
  const rows = event.props
    .filter(([key]) => key === EVENT_TRAILERS.check)
    .map(([, value]) => {
      const header = value.split(" log=", 1)[0] ?? ""
      const seen = new Set<string>()
      for (const field of header.split(" ").slice(1)) {
        const key = field.split("=", 1)[0]
        if (key === undefined || !["exit", "ms", "result", "attempt", "phase", "tier"].includes(key)) continue
        if (seen.has(key)) throw new Error(`event ${event.id} Check: repeats ${key}`)
        seen.add(key)
      }
      const tier = /(?:^| )tier=([^ ]*)(?: |$)/u.exec(header)?.[1]
      if (tier !== undefined && tier !== "long") throw new Error(`event ${event.id} Check: has invalid tier=${tier}`)
      return readCheckTrailer(value)
    })
  if (rows.length > 0 && !["merging", "failed", "stuck", "deferred"].includes(event.type)) {
    throw new Error(`event ${event.id} (${event.type}) cannot carry Check: rows`)
  }
  for (const row of rows) {
    if (
      row.name === "" ||
      row.result === undefined ||
      row.attempt === undefined ||
      row.phase === undefined ||
      row.exit === undefined ||
      row.ms === undefined
    ) {
      throw new Error(`event ${event.id} has a malformed Check: row`)
    }
    if (event.type === "merging" && row.result !== "pass") {
      throw new Error(`event ${event.id} merging Check: rows must all pass`)
    }
  }
  if (rows.length > 0) {
    requiredProp(event, EVENT_TRAILERS.base)
    requiredProp(event, EVENT_TRAILERS.config)
    keptCommit(event)
  }
  if (
    event.type === "deferred" &&
    !rows.some(
      (row) =>
        row.result === "deferred" &&
        row.name === prop(event, EVENT_TRAILERS.checkName) &&
        row.phase === prop(event, EVENT_TRAILERS.phase),
    )
  ) {
    throw new Error(`event ${event.id} deferred needs its matching Check: name, phase and verdict`)
  }
  const retried = prop(event, EVENT_TRAILERS.retried)
  if (retried !== undefined) {
    if (event.type !== "stuck" || retried !== "1") throw new Error(`event ${event.id} has invalid Retried:`)
    if (!rows.some((row) => row.attempt === 2) && prop(event, EVENT_TRAILERS.retryReason) === undefined) {
      throw new Error(`event ${event.id} Retried: 1 needs second attempt or Retry-Reason:`)
    }
    if (!rows.some((row) => row.attempt === 1) && prop(event, EVENT_TRAILERS.retryReason) === undefined) {
      throw new Error(`event ${event.id} Retried: 1 needs first Check: attempt or Retry-Reason:`)
    }
  }
}

function requireCause(event: EventShape): Date {
  const queue = prop(event, EVENT_TRAILERS.queue)
  if (queue === undefined || !COMMIT_OID.test(queue)) {
    throw new Error(`event ${event.id} (${event.type}) needs Queue: naming the queue chain tip`)
  }
  const time = prop(event, EVENT_TRAILERS.time)
  if (time === undefined || Number.isNaN(Date.parse(time)) || new Date(time).toISOString() !== time) {
    throw new Error(`event ${event.id} (${event.type}) needs Time: as an ISO instant`)
  }
  return new Date(time)
}

function keptCommit(event: EventShape): string {
  const commit = prop(event, "Commit")
  if (commit === undefined) throw new Error(`event ${event.id} (${event.type}) needs Commit:`)
  if (!event.links.includes(commit)) throw new Error(`event ${event.id} (${event.type}) must keep Commit: ${commit}`)
  return commit
}

function endingRefusal(state: EventChange, event: EventShape): never {
  const ending = state.ending
  if (ending === undefined) throw new Error(`event ${event.id} (${event.type}) needs an open change`)
  throw new Error(`event ${event.id} (${event.type}) follows ${ending.kind} at ${ending.id}; open a new change first`)
}

function advanceChange(
  state: EventChange,
  event: EventShape,
  type: "verifying" | "checking" | "merging" | "stuck",
  next: EventChange,
): EventChange {
  if (state.status === "stuck" && type !== "verifying") {
    throw new Error(`event ${event.id} (${type}) cannot advance a stuck change; merge or cancel it`)
  }
  if (!isOpen(state.status)) return endingRefusal(state, event)
  if (type === "checking" && state.status !== "verifying") {
    throw new Error(`event ${event.id} checking needs verifying, found ${state.status}`)
  }
  if (type === "merging" && state.status !== "checking") {
    throw new Error(`event ${event.id} merging needs checking, found ${state.status}`)
  }
  if (type === "merging" && keptCommit(event) !== state.candidate) {
    throw new Error(`event ${event.id} merging must keep verified candidate ${state.candidate ?? "absent"}`)
  }
  if (
    type === "stuck" &&
    event.props.some(([key]) => key === EVENT_TRAILERS.check) &&
    keptCommit(event) !== state.candidate
  ) {
    throw new Error(`event ${event.id} stuck must keep checked candidate ${state.candidate ?? "absent"}`)
  }
  if (type === "verifying" && !["queued", "verifying", "checking", "merging", "stuck"].includes(state.status)) {
    throw new Error(
      `event ${event.id} verifying needs queued, verifying, checking, merging or stuck, found ${state.status}`,
    )
  }
  return {
    ...next,
    status: type,
    candidate: type === "verifying" ? keptCommit(event) : state.candidate,
    reason: prop(event, EVENT_TRAILERS.reason),
    ...(type === "verifying" ? { deferred: undefined, lastNotifiable: undefined } : {}),
    ...(type === "stuck" ? { lastNotifiable: { id: event.id, kind: "stuck" as const } } : {}),
  }
}

function deferChange(state: EventChange, event: EventShape, next: EventChange, at: Date): EventChange {
  if (state.status !== "checking") throw new Error(`event ${event.id} deferred needs checking, found ${state.status}`)
  if (keptCommit(event) !== state.candidate) {
    throw new Error(`event ${event.id} deferred must keep verified candidate ${state.candidate ?? "absent"}`)
  }
  const phase = requiredProp(event, EVENT_TRAILERS.phase)
  if (phase !== "submit" && phase !== "merge") {
    throw new Error(`event ${event.id} has invalid Phase:`)
  }
  const reason = requiredProp(event, EVENT_TRAILERS.reason)
  return {
    ...next,
    status: "queued",
    reason,
    lastNotifiable: { id: event.id, kind: "deferred" },
    deferred: {
      id: event.id,
      check: requiredProp(event, EVENT_TRAILERS.checkName),
      phase,
      reason,
      projectedMs: positiveMs(event, EVENT_TRAILERS.projectedMs),
      boundMs: positiveMs(event, EVENT_TRAILERS.boundMs),
      at,
    },
  }
}

function settleNotice(state: EventChange, event: EventShape): EventChange {
  const forEvent = requiredProp(event, EVENT_TRAILERS.for)
  if (state.lastNotifiable?.id !== forEvent) {
    throw new Error(`event ${event.id} notified needs For: matching the last notifiable event`)
  }
  const to = requiredProp(event, EVENT_TRAILERS.to)
  const key = requiredProp(event, EVENT_TRAILERS.key)
  if (key !== `${forEvent}:${to}`) throw new Error(`event ${event.id} has invalid notice Key:`)
  if (state.notices?.[key] !== undefined) throw new Error(`event ${event.id} notice key already settled: ${key}`)
  const result = requiredProp(event, EVENT_TRAILERS.result)
  if (result !== "delivered" && result !== "refused" && result !== "failed") {
    throw new Error(`event ${event.id} has invalid notice Result:`)
  }
  const reason = prop(event, EVENT_TRAILERS.reason)
  if (result !== "delivered" && (reason === undefined || reason.trim() === "")) {
    throw new Error(`event ${event.id} ${result} notice needs Reason:`)
  }
  if (result === "delivered" && reason !== undefined) {
    throw new Error(`event ${event.id} delivered notice cannot carry Reason:`)
  }
  return {
    ...state,
    tip: event.id,
    notices: {
      ...state.notices,
      [key]: {
        for: forEvent,
        to,
        result,
        ...(reason === undefined ? {} : { reason }),
      },
    },
  }
}

/** Pure fold. Unknown kinds and malformed transitions fail at the selected event chain. */
export function evolve(state: EventChange, event: EventShape): EventChange {
  const at = requireCause(event)
  checkedRows(event)
  if (event.props.some(([key]) => key === "Status")) {
    throw new Error(`event ${event.id} stores Status:; status must be a fold`)
  }
  if (
    state.status === "merging" &&
    event.type !== "merged" &&
    event.type !== "failed" &&
    event.type !== "stuck" &&
    event.type !== "verifying"
  ) {
    throw new Error(`event ${event.id}: ${LANDING_IN_PROGRESS}`)
  }
  const next = { ...state, at, tip: event.id }
  switch (event.type) {
    case "opened": {
      if (isOpen(state.status)) throw new Error(`event ${event.id} opens a second change before the first ends`)
      const submitter = prop(event, EVENT_TRAILERS.by)
      if (submitter === undefined || submitter.trim() === "") throw new Error(`event ${event.id} opened needs By:`)
      const {
        ignored: _previousIgnore,
        deferred: _previousDeferred,
        notices: _previousNotices,
        lastNotifiable: _previousNotifiable,
        ...fresh
      } = next
      return {
        ...fresh,
        status: "queued",
        commit: keptCommit(event),
        candidate: undefined,
        issue: prop(event, EVENT_TRAILERS.issue),
        submitter,
        since: at,
        endedAt: undefined,
        ending: undefined,
        reason: undefined,
      }
    }
    case "verifying":
    case "checking":
    case "merging":
    case "stuck":
      return advanceChange(state, event, event.type, next)
    case "deferred":
      return deferChange(state, event, next, at)
    case "notified":
      return settleNotice(state, event)
    case "failed":
    case "cancelled": {
      const reason = prop(event, "Reason")
      // Dropping a branch records the last head being deleted even when no
      // change was open. This is also the first event for an unsubmitted branch.
      if (!isOpen(state.status) && event.type === "cancelled" && reason === "dropped") {
        return {
          ...next,
          status: "cancelled",
          commit: state.commit ?? keptCommit(event),
          issue: undefined,
          submitter: undefined,
          since: undefined,
          ending: { kind: "cancelled", id: event.id },
          lastNotifiable: { kind: "cancelled", id: event.id },
          endedAt: at,
          reason,
        }
      }
      if (!isOpen(state.status)) return endingRefusal(state, event)
      if (
        event.type === "failed" &&
        event.props.some(([key]) => key === EVENT_TRAILERS.check) &&
        keptCommit(event) !== state.candidate
      ) {
        throw new Error(`event ${event.id} failed must keep checked candidate ${state.candidate ?? "absent"}`)
      }
      if (event.type === "cancelled") {
        if (reason !== "resubmitted" && reason !== "dropped" && reason !== "deleted") {
          throw new Error(`event ${event.id} cancelled needs Reason: resubmitted, dropped or deleted`)
        }
        if (reason === "dropped" || reason === "deleted") keptCommit(event)
      }
      return {
        ...next,
        status: event.type,
        ending: { kind: event.type, id: event.id },
        lastNotifiable: { kind: event.type, id: event.id },
        endedAt: at,
        reason,
      }
    }
    case "merged":
      // A merge observed on main is ground truth even after a recorded ending.
      if (state.commit === undefined) throw new Error(`event ${event.id} merged needs an opened change`)
      if (state.status === "merging" && state.candidate === undefined) {
        throw new Error(`event ${event.id} merged needs the verified candidate`)
      }
      const kept = keptCommit(event)
      if (state.status === "merging" && kept !== state.candidate) {
        throw new Error(`event ${event.id} merged must keep candidate ${state.candidate}`)
      }
      if (
        state.status !== "merging" &&
        kept !== state.commit &&
        kept !== state.candidate &&
        prop(event, EVENT_TRAILERS.reason) !== `observed on target at ${kept}`
      ) {
        throw new Error(
          `event ${event.id} merged must keep submitted commit ${state.commit}, candidate ${state.candidate ?? "absent"}, or name its observed target commit`,
        )
      }
      return {
        ...next,
        status: "merged",
        ending: { kind: "merged", id: event.id },
        lastNotifiable: { kind: "merged", id: event.id },
        endedAt: at,
        reason: prop(event, "Reason"),
      }
    case "ignored": {
      const reason = prop(event, "Reason")
      const by = prop(event, "By")
      if (reason === undefined || reason.trim() === "") {
        throw new Error(`yrd-ignore-event-malformed: event ${event.id} ignored needs Reason:`)
      }
      if (by === undefined || by.trim() === "") {
        throw new Error(`yrd-ignore-event-malformed: event ${event.id} ignored needs By:`)
      }
      if (!isOpen(state.status)) {
        throw new Error(
          `yrd-ignore-change-ended: event ${event.id} ignored follows ${state.status} at ${state.ending?.id ?? state.tip}`,
        )
      }
      if (state.ignored !== undefined) {
        throw new Error(`yrd-ignore-state-unchanged: event ${event.id} change is already ignored at ${state.tip}`)
      }
      return { ...next, ignored: { reason, by } }
    }
    case "unignored": {
      if (prop(event, "Reason") !== undefined) {
        throw new Error(`yrd-ignore-event-malformed: event ${event.id} unignored cannot carry Reason:`)
      }
      const by = prop(event, "By")
      if (by === undefined || by.trim() === "") {
        throw new Error(`yrd-ignore-event-malformed: event ${event.id} unignored needs By:`)
      }
      if (!isOpen(state.status)) {
        throw new Error(
          `yrd-ignore-change-ended: event ${event.id} unignored follows ${state.status} at ${state.ending?.id ?? state.tip}`,
        )
      }
      if (state.ignored === undefined) {
        throw new Error(`yrd-ignore-state-unchanged: event ${event.id} change is already not ignored at ${state.tip}`)
      }
      const { ignored: _previousIgnore, ...unignored } = next
      return unignored
    }
    default:
      throw new Error(`unknown Yrd change event ${event.type} at ${event.id}`)
  }
}

/** Whether a change with this status is still open: in line, or somewhere between verifying and merged. */
export function isOpen(status: ChangeStatus): boolean {
  return (
    status === "queued" || status === "verifying" || status === "checking" || status === "merging" || status === "stuck"
  )
}

function pending(input: EventInput): EventShape {
  return { id: "pending", type: input.type, props: input.props ?? [], links: input.keeps ?? [] }
}

/** Decide an append from the current chain; a second submit cancels then opens. */
export function decide(events: readonly Event[], input: EventInput): readonly EventInput[] {
  const state = events.reduce(evolve, initial)
  if (input.type === "opened" && isOpen(state.status)) {
    const cause = (input.props ?? []).filter(([key]) => key === EVENT_TRAILERS.queue || key === EVENT_TRAILERS.time)
    const cancelled: EventInput = { type: "cancelled", props: [...cause, [EVENT_TRAILERS.reason, "resubmitted"]] }
    evolve(evolve(state, pending(cancelled)), pending(input))
    return [cancelled, input]
  }
  evolve(state, pending(input))
  return [input]
}

export type QueueLocation = Readonly<{ repo: string; remote: string; selection: GitSelection; backend: GitomicBackend }>
export type DropRequest = Readonly<{ queue: string; branch: string; by: string; note?: string }>
export type Dropped = Readonly<{ queue: string; branch: string; head: string; event: string }>
export type SetBranchIgnoredRequest = Readonly<
  { queue: string; branch: string; by: string } & ({ ignored: true; reason: string } | { ignored: false })
>

type EventQueueProjection = Readonly<{
  created: string
  /** Derived from the created event's kept commit. This is the queue's start, not legacy run.ts's resolved .yrd.yml declaration. */
  declaration: Oid
  tip: string
  pause?: Readonly<{ id: string; at: Date; reason: string; by: string }>
  observed: Readonly<Record<string, Readonly<{ id: string; branch?: string }>>>
  notices: Readonly<
    Record<string, Readonly<{ id: string; for: string; to: string; result: NoticeWrite["result"]; reason?: string }>>
  >
}>

const validatedQueue = Symbol("validated event queue")
export type EventQueue = EventQueueProjection & Readonly<{ [validatedQueue]: true }>
const queueLocations = new WeakMap<
  EventQueue,
  Readonly<{ repo: string; remote: string; queue: string; backend?: GitomicBackend }>
>()

/** The queue stop in the existing command response shape. */
export function eventPause(queue: EventQueueProjection): PauseRecord | undefined {
  if (queue.pause === undefined) return undefined
  return {
    kind: "paused",
    sha: queue.pause.id,
    at: queue.pause.at,
    reason: queue.pause.reason,
    by: queue.pause.by,
    cause: "operator",
  }
}

/** The first event declares a queue and keeps the commit carrying .yrd.yml. */
export async function createEventQueue(
  store: QueueLocation,
  queue: string,
  commit: string,
  config: QueueConfig,
  at: Date,
): Promise<string> {
  const ref = queueRef(queue)
  if (!COMMIT_OID.test(commit)) throw new TypeError(`Commit: must name a commit oid, got ${commit}`)
  if (Number.isNaN(at.getTime())) throw new TypeError("Time: needs a valid instant")
  if (config === undefined) {
    throw new Error(
      `cannot create event queue ${queue} at ${commit}: the pinned commit has no declared QueueConfig; #25040 does not invent a default`,
    )
  }
  if (config.target.remote !== store.remote || config.target.branch !== queue) {
    throw new Error(
      `cannot create event queue ${store.remote}#${queue}: QueueConfig targets ${config.target.remote}#${config.target.branch}`,
    )
  }
  const blob = await refAt(gitIn(store.repo, undefined, store.selection), `${commit}:.yrd.yml`, "blob")
  if (blob === undefined) {
    throw new Error(
      `cannot create event queue ${queue} at ${commit}: the pinned commit has no .yrd.yml; #25040 does not invent a default`,
    )
  }
  if (blob !== config.blob) {
    throw new Error(
      `cannot create event queue ${queue} at ${commit}: config blob ${config.blob} does not match ${commit}:.yrd.yml at ${blob}`,
    )
  }
  assertPlainEventQueueConfig(config, "create")
  const result = await (
    await openEvents({ ...store, ref, writer: "yrd" })
  ).append(
    [
      {
        type: "created",
        props: [
          [EVENT_TRAILERS.commit, commit],
          [EVENT_TRAILERS.time, at.toISOString()],
        ],
        keeps: [commit],
      },
    ],
    { expect: null },
  )
  const created = result.events[0]?.id
  if (created === undefined) throw new Error(`${ref} in ${store.repo}: created event was not written`)
  return created
}

/** Read and validate the queue declaration and its current operator stop. */
export async function readEventQueue(store: QueueLocation, queue: string): Promise<EventQueue> {
  const ref = queueRef(queue)
  const events = await (await openEvents({ ...store, ref })).events({ limit: 1024 })
  const result: EventQueue = { ...projectEventQueue(events, ref, store.repo), [validatedQueue]: true }
  queueLocations.set(result, { repo: store.repo, remote: store.remote, queue, backend: store.backend })
  return result
}

/** Whether the queue was explicitly resumed after this change's latest stuck event. */
export async function queueResumedAfter(
  store: QueueLocation,
  queue: string,
  branch: string,
  history: ChangeHistory | undefined,
): Promise<boolean> {
  const stuck = history?.events.findLast((event) => event.type === "stuck")
  if (stuck === undefined) {
    throw new Error(`event queue ${store.remote}#${queue}: stuck change ${branch} has no stuck event`)
  }
  const ref = queueRef(queue)
  const events = await (await openEvents({ ...store, ref })).events({ limit: 1024 })
  projectEventQueue(events, ref, store.repo)
  const cause = prop(stuck, EVENT_TRAILERS.queue)
  const index = events.findIndex((event) => event.id === cause)
  if (index < 0) throw new Error(`${stuck.id} names Queue: ${cause ?? "missing"} outside ${ref}`)
  return events.slice(index + 1).some((event) => event.type === "resumed")
}

export type WriteQueueEvent =
  | Readonly<{ type: "paused" | "resumed"; reason: string; by: string; at: Date }>
  | Readonly<{ type: "observed"; commit: string; branch?: string; by: string; at: Date }>
  | Readonly<{ type: "notified"; notice: NoticeWrite; by: string; at: Date }>

/** Append a queue stop under Gitomic's CAS; retries fold the current chain again. */
export async function writeQueueEvent(store: QueueLocation, queue: string, write: WriteQueueEvent): Promise<string> {
  const ref = queueRef(queue)
  if ((write.type === "paused" || write.type === "resumed") && write.reason.trim() === "") {
    throw new TypeError(`${write.type} needs Reason:`)
  }
  if (Number.isNaN(write.at.getTime())) throw new TypeError("Time: needs a valid instant")
  const chain = await openEvents({ ...store, ref, writer: write.by })
  let existing: string | undefined
  const result = await chain.transact((events) => {
    const current = projectEventQueue(events, ref, store.repo)
    if (write.type === "observed") existing = current.observed[write.commit]?.id
    if (write.type === "notified") existing = current.notices[write.notice.key]?.id
    if (existing !== undefined) return []
    const details: [string, string][] = []
    let keeps: string[] | undefined
    if (write.type === "observed") {
      details.push([EVENT_TRAILERS.commit, write.commit], [EVENT_TRAILERS.reason, "direct"])
      if (write.branch !== undefined) details.push([EVENT_TRAILERS.branch, write.branch])
      keeps = [write.commit]
    } else if (write.type === "notified") {
      details.push(
        [EVENT_TRAILERS.for, write.notice.for],
        [EVENT_TRAILERS.to, write.notice.to],
        [EVENT_TRAILERS.result, write.notice.result],
        [EVENT_TRAILERS.key, write.notice.key],
      )
      if (write.notice.reason !== undefined) details.push([EVENT_TRAILERS.reason, write.notice.reason])
    } else {
      details.push([EVENT_TRAILERS.reason, write.reason])
    }
    const input: EventInput = {
      type: write.type,
      props: [[EVENT_TRAILERS.queue, current.tip], [EVENT_TRAILERS.time, write.at.toISOString()], ...details],
      ...(keeps === undefined ? {} : { keeps }),
    }
    const pending: QueueEventShape = {
      id: "pending",
      parent: current.tip,
      links: input.keeps ?? [],
      type: input.type,
      props: input.props ?? [],
      writer: write.by,
    }
    projectEventQueue([...events, pending], ref, store.repo)
    return [input]
  }, `${write.type} ${queue}`)
  const written = existing ?? result.events[0]?.id
  if (written === undefined) throw new Error(`${ref} in ${store.repo}: ${write.type} event was not written`)
  return written
}

function createdQueueDetails(event: QueueEventShape, ref: string): Pick<EventQueueProjection, "declaration" | "pause"> {
  if (event.type !== "created") throw new Error(`${ref}: first event ${event.id} must be created`)
  const declaration = keptCommit(event)
  if (prop(event, EVENT_TRAILERS.queue) !== undefined) {
    throw new Error(`${ref}: created event ${event.id} cannot name a preceding Queue:`)
  }
  const reason = prop(event, "Start-Paused")
  if (reason === undefined) return { declaration }
  if (reason.trim() === "" || event.writer === null) {
    throw new Error(`${ref}: created event ${event.id} needs a nonempty Start-Paused: and writer`)
  }
  return {
    declaration,
    pause: { id: event.id, at: new Date(requiredProp(event, EVENT_TRAILERS.time)), reason, by: event.writer },
  }
}

function projectEventQueue(events: readonly QueueEventShape[], ref: string, repo: string): EventQueueProjection {
  const first = events[0]
  if (first === undefined) throw new Error(`missing event queue chain ${ref} in ${repo}`)
  if (first.parent !== null) {
    throw new Error(`event queue chain ${ref} in ${repo} exceeds 1024 events; refusing a partial read`)
  }
  let previous: string | undefined
  let declaration: string | undefined
  let pause: EventQueueProjection["pause"]
  const observed: Record<string, { id: string; branch?: string }> = {}
  const notices: Record<
    string,
    { id: string; for: string; to: string; result: NoticeWrite["result"]; reason?: string }
  > = {}
  for (const [index, event] of events.entries()) {
    if (index === 0) {
      const created = createdQueueDetails(event, ref)
      declaration = created.declaration
      pause = created.pause
    } else {
      if (prop(event, "Start-Paused") !== undefined) throw new Error(`${ref}: Start-Paused: belongs only on created`)
      if (prop(event, EVENT_TRAILERS.queue) !== previous) {
        throw new Error(`${ref}: event ${event.id} (${event.type}) needs Queue: ${previous}`)
      }
    }
    const time = prop(event, EVENT_TRAILERS.time)
    if (time === undefined || Number.isNaN(Date.parse(time)) || new Date(time).toISOString() !== time) {
      throw new Error(`${ref}: event ${event.id} (${event.type}) needs Time: as an ISO instant`)
    }
    if (event.props.some(([key]) => key === "Status")) throw new Error(`${ref}: event ${event.id} stores Status:`)
    switch (event.type) {
      case "created":
        if (index !== 0) throw new Error(`${ref}: event ${event.id} declares a second queue`)
        break
      case "paused": {
        if (pause !== undefined) throw new Error(`${ref}: event ${event.id} pauses an already paused queue`)
        const reason = prop(event, EVENT_TRAILERS.reason)
        if (reason === undefined || reason.length === 0) {
          throw new Error(`${ref}: paused event ${event.id} needs Reason:`)
        }
        if (event.writer === null) throw new Error(`${ref}: paused event ${event.id} needs a writer`)
        pause = { id: event.id, at: new Date(time), reason, by: event.writer }
        break
      }
      case "resumed":
        if (pause === undefined) throw new Error(`${ref}: event ${event.id} resumes a running queue`)
        if (prop(event, EVENT_TRAILERS.reason) === undefined) {
          throw new Error(`${ref}: resumed event ${event.id} needs Reason:`)
        }
        pause = undefined
        break
      case "configured":
      case "started":
      case "stopped":
        break
      case "observed": {
        if (event.writer !== QUEUE_RUN_WRITER) {
          throw new Error(`${ref}: observed event ${event.id} needs writer ${QUEUE_RUN_WRITER}`)
        }
        const commit = keptCommit(event)
        if (!COMMIT_OID.test(commit)) throw new Error(`${ref}: observed event ${event.id} has invalid Commit:`)
        if (prop(event, EVENT_TRAILERS.reason) !== "direct") {
          throw new Error(`${ref}: observed event ${event.id} needs Reason: direct`)
        }
        if (observed[commit] !== undefined) throw new Error(`${ref}: duplicate observed Commit: ${commit}`)
        const branch = prop(event, EVENT_TRAILERS.branch)
        if (branch !== undefined) assertBranch(branch)
        observed[commit] = { id: event.id, ...(branch === undefined ? {} : { branch }) }
        break
      }
      case "notified": {
        if (event.writer !== QUEUE_RUN_WRITER) {
          throw new Error(`${ref}: notified event ${event.id} needs writer ${QUEUE_RUN_WRITER}`)
        }
        const forEvent = requiredProp(event, EVENT_TRAILERS.for)
        const to = requiredProp(event, EVENT_TRAILERS.to)
        const key = requiredProp(event, EVENT_TRAILERS.key)
        const result = requiredProp(event, EVENT_TRAILERS.result)
        if (!Object.values(observed).some(({ id }) => id === forEvent)) {
          throw new Error(`${ref}: notified event ${event.id} has no observed For: ${forEvent}`)
        }
        if (key !== `${forEvent}:${to}`) throw new Error(`${ref}: notified event ${event.id} has invalid Key:`)
        if (result !== "delivered" && result !== "refused" && result !== "failed") {
          throw new Error(`${ref}: notified event ${event.id} has invalid Result:`)
        }
        if (notices[key] !== undefined) throw new Error(`${ref}: duplicate notified Key: ${key}`)
        const reason = prop(event, EVENT_TRAILERS.reason)
        if (result !== "delivered" && (reason === undefined || reason.trim() === "")) {
          throw new Error(`${ref}: notified event ${event.id} needs Reason:`)
        }
        notices[key] = { id: event.id, for: forEvent, to, result, ...(reason === undefined ? {} : { reason }) }
        break
      }
      default:
        throw new Error(`${ref}: unknown queue event ${event.type} at ${event.id}`)
    }
    previous = event.id
  }
  if (previous === undefined) throw new Error(`missing event queue tip ${ref} in ${repo}`)
  if (declaration === undefined) throw new Error(`${ref}: missing declaration commit`)
  return { created: first.id, declaration, tip: previous, observed, notices, ...(pause === undefined ? {} : { pause }) }
}

/** One advertisement selects the format. An event queue with no changes is empty. */
export async function queueFormat(store: QueueLocation, queue: string): Promise<"event" | "legacy"> {
  const refs = await listRefs(queueRefPrefix(queue), store)
  return refs.has(queueRef(queue)) ? "event" : "legacy"
}

/** Read one existing branch chain; a missing selected chain is a data error. */
export async function readStatus(store: QueueLocation, queue: string, branch: string): Promise<EventChange> {
  await readEventQueue(store, queue)
  const ref = changesRef(queue, branch)
  const chain = await openEvents({ ...store, ref })
  if ((await chain.head()) === null) throw new Error(`missing event chain ${ref} in ${store.repo}`)
  return project(await chain.events({ limit: 1024 }), ref, store.repo)
}

/** Toggle one open change's attributed ignore overlay under its selected chain tip. */
export async function setBranchIgnored(store: QueueLocation, request: SetBranchIgnoredRequest): Promise<void> {
  const { queue, branch, by } = request
  if (request.ignored !== true && request.ignored !== false) {
    throw new TypeError(`yrd-ignore-event-malformed: ${branch}: ignored must be true or false`)
  }
  if (typeof by !== "string" || by.trim() === "") {
    throw new TypeError(`yrd-ignore-event-malformed: ${branch}: By: must name the actor`)
  }
  if (request.ignored) {
    if (typeof request.reason !== "string" || request.reason.trim() === "") {
      throw new TypeError(`yrd-ignore-reason-required: ${branch}: ignoring an open change requires --reason <text>`)
    }
  } else if ("reason" in request) {
    throw new TypeError(`yrd-ignore-reason-conflict: ${branch}: unignore does not accept --reason`)
  }
  const ref = changesRef(queue, branch)
  const queueTip = (await readEventQueue(store, queue)).tip
  const chain = await openEvents({ ...store, ref, writer: by })
  const selectedTip = await chain.head()
  if (selectedTip === null) {
    throw new Error(`yrd-ignore-change-missing: ${branch}: ${ref} is absent in ${store.repo}; submit the branch first`)
  }
  const state = project(await chain.events({ limit: 1024 }), ref, store.repo)
  if (!isOpen(state.status)) {
    throw new Error(
      `yrd-ignore-change-ended: ${branch}: change ended ${state.status} at ${state.ending?.id ?? selectedTip}; only an open change can be ignored`,
    )
  }
  if (state.status === "merging") {
    throw new Error(
      `yrd-ignore-change-landing: ${branch}: the change is landing; retry after it settles as merged, failed or stuck`,
    )
  }
  if ((state.ignored !== undefined) === request.ignored) {
    throw new Error(
      `yrd-ignore-state-unchanged: ${branch}: change is already ${request.ignored ? "ignored" : "not ignored"} at ${selectedTip}`,
    )
  }
  const type = request.ignored ? "ignored" : "unignored"
  const input = changeInput(type, {
    queueTip,
    at: new Date(),
    by,
    ...(request.ignored ? { reason: request.reason } : {}),
  })
  evolve(state, pending(input))
  const result = await chain.append([input], { expect: selectedTip })
  if (result.events.length !== 1 || result.events[0]?.type !== type) {
    throw new Error(`${ref} in ${store.repo}: ${type} event was not written`)
  }
}

/** Read the history selected by a table row; refuse a changed tip instead of showing another snapshot. */
export async function readChangeEvents(
  store: QueueLocation,
  queue: string,
  branch: string,
  selectedTip: string,
): Promise<readonly Event[]> {
  const ref = changesRef(queue, branch)
  const events = await (await openEvents({ ...store, ref })).events({ limit: 1024 })
  const state = project(events, ref, store.repo)
  if (state.tip !== selectedTip) {
    throw new Conflict(`${ref} moved after the selected reading: expected ${selectedTip}, read ${state.tip}`, {
      refs: [ref],
    })
  }
  return events
}

/** Write one run decision against the row it judged; a rival tip discards that judgement. */
type ChangeWrite = Readonly<{
  type: Exclude<ChangeEventType, "opened">
  at: Date
  commit?: string
  issue?: string
  reason?: string
  title?: string
  content?: string
  checks?: readonly EventCheck[]
  base?: string
  config?: string
  retry?: Readonly<{ retried: 1; reason?: string }>
  deferred?: DeferredWrite
  notice?: NoticeWrite
  writer?: string
  /** A target or branch ref moved in the same CAS publish as this event. */
  also?: readonly AlsoRef[]
}>

export async function appendChangeEvent(
  store: QueueLocation,
  queue: string,
  branch: string,
  selectedTip: string,
  write: ChangeWrite,
): Promise<string> {
  if (write.writer === QUEUE_RUN_WRITER) {
    throw new TypeError(`${QUEUE_RUN_WRITER} writer is reserved for an atomic published merge`)
  }
  return appendDecision(store, queue, branch, selectedTip, write)
}

/** The sole event append that attributes a merge to this queue run; both refs are leased. */
export async function appendPublishedMerge(
  store: QueueLocation,
  queue: string,
  branch: string,
  selectedTip: string,
  request: Readonly<{ at: Date; commit: Oid; targetExpect: Oid; queueTip: Oid; reason?: string }>,
): Promise<string> {
  if (request.commit === request.targetExpect) {
    throw new TypeError(`published merge needs the target to move from ${request.targetExpect}`)
  }
  return appendDecision(store, queue, branch, selectedTip, {
    type: "merged",
    at: request.at,
    commit: request.commit,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    writer: QUEUE_RUN_WRITER,
    also: [
      { ref: `refs/heads/${queue}`, expect: request.targetExpect, oid: request.commit },
      { ref: queueRef(queue), expect: request.queueTip, oid: request.queueTip },
    ],
  })
}

async function appendDecision(
  store: QueueLocation,
  queue: string,
  branch: string,
  selectedTip: string,
  write: ChangeWrite,
): Promise<string> {
  const queueTip = (await readEventQueue(store, queue)).tip
  const history = await readChangeEvents(store, queue, branch, selectedTip)
  const input = changeInput(write.type, {
    queueTip,
    at: write.at,
    ...(write.commit === undefined ? {} : { commit: write.commit }),
    ...(write.issue === undefined ? {} : { issue: write.issue }),
    ...(write.reason === undefined ? {} : { reason: write.reason }),
    ...(write.title === undefined ? {} : { title: write.title }),
    ...(write.content === undefined ? {} : { content: write.content }),
    ...(write.checks === undefined ? {} : { checks: write.checks }),
    ...(write.base === undefined ? {} : { base: write.base }),
    ...(write.config === undefined ? {} : { config: write.config }),
    ...(write.retry === undefined ? {} : { retry: write.retry }),
    ...(write.deferred === undefined ? {} : { deferred: write.deferred }),
    ...(write.notice === undefined ? {} : { notice: write.notice }),
  })
  const planned = decide(history, input)
  if (planned.length !== 1) {
    throw new Error(`${changesRef(queue, branch)}: a run decision wrote ${planned.length} events`)
  }
  const ref = changesRef(queue, branch)
  // A stuck event's Queue: must still be the queue tip when it is published.
  // Otherwise a concurrent resume could appear after that tip but before stuck.
  const also =
    write.type === "stuck"
      ? [{ ref: queueRef(queue), expect: queueTip, oid: queueTip }, ...(write.also ?? [])]
      : write.also
  const result = await (
    await openEvents({ ...store, ref, writer: write.writer ?? "yrd" })
  ).append(planned, {
    expect: selectedTip,
    ...(also === undefined ? {} : { also }),
  })
  const written = result.events.findLast((event) => event.type === write.type)?.id
  if (written === undefined) throw new Error(`${ref} in ${store.repo}: ${write.type} event was not written`)
  return written
}

/** End a branch and delete its name in the same leased publish. */
export async function drop(store: QueueLocation, request: DropRequest): Promise<Dropped> {
  const { queue, branch } = request
  if ((await queueFormat(store, queue)) !== "event") {
    throw new Error(`drop needs an event queue at ${store.remote}#${queue}; use yrd withdraw for legacy changes`)
  }
  const queueTip = (await readEventQueue(store, queue)).tip
  const ref = changesRef(queue, branch)
  const chain = await openEvents({ ...store, ref, writer: request.by })
  const selectedTip = await chain.head()
  const history = selectedTip === null ? [] : await chain.events({ limit: 1024 })
  const state = selectedTip === null ? initial : project(history, ref, store.repo)
  const branchRef = `refs/heads/${branch}`
  const fetchRefs = store.backend.fetchRefs
  if (fetchRefs === undefined) throw new Error("Gitomic backend lacks fetchRefs for dropped branch commit")
  const head = (await fetchRefs(store.repo, branchRef, store.remote)).get(branchRef)
  if (head === undefined) {
    if (state.ending !== undefined && state.reason === "dropped") {
      const ending = history.findLast((event) => event.id === state.ending?.id)
      if (ending === undefined) throw new Error(`${ref} in ${store.repo}: missing dropped ending ${state.ending.id}`)
      return { queue, branch, event: ending.id, head: keptCommit(ending) }
    }
    const disposition = isOpen(state.status)
      ? `its open change must end cancelled (deleted) by the deleted-branch observer`
      : state.ending === undefined
        ? `there is no branch to drop`
        : `its change already ended ${state.ending.kind} at ${state.ending.id}; there is no branch to drop`
    throw new Error(
      `${branchRef} in ${store.repo}${store.remote === undefined ? "" : ` at ${store.remote}`} is absent; ${disposition}`,
    )
  }
  const input = changeInput("cancelled", {
    queueTip,
    at: new Date(),
    commit: head,
    reason: "dropped",
    by: request.by,
    title: `dropped ${branch}`,
    ...(request.note === undefined ? {} : { content: request.note }),
  })
  const planned = decide(history, input)
  const result = await chain.append(planned, {
    expect: selectedTip,
    // The event keeps H, so this branch delete only removes its name.
    also: [{ ref: branchRef, expect: head, oid: null }],
  })
  const written = result.events.findLast((event) => event.type === "cancelled")?.id
  if (written === undefined) throw new Error(`${ref} in ${store.repo}: dropped event was not written`)
  return { queue, branch, event: written, head }
}

type ChangeHistory = Readonly<{ state: EventChange; events: readonly Event[] }>

function projectChangeHistories(
  chains: ReadonlyMap<string, readonly Event[]>,
  prefix: string,
  repo: string,
): ReadonlyMap<string, ChangeHistory> {
  const changes = new Map<string, ChangeHistory>()
  for (const [ref, events] of chains) {
    changes.set(ref.slice(prefix.length), { state: project(events, ref, repo), events })
  }
  return changes
}

/** Read the validated queue and its change chains concurrently for a listing. */
export async function readEventQueueWithChanges(
  store: QueueLocation,
  queue: string,
): Promise<Readonly<{ queue: EventQueue; histories: ReadonlyMap<string, ChangeHistory> }>> {
  const prefix = `${queueRefPrefix(queue)}/changes/`
  const [queueState, chains] = await Promise.all([
    readEventQueue(store, queue),
    chainsUnder(prefix, { ...store, limit: 1024 }),
  ])
  return { queue: queueState, histories: projectChangeHistories(chains, prefix, store.repo) }
}

/** Branch histories and projections from one batched remote fetch. */
export async function listChangeHistories(
  store: QueueLocation,
  queue: string,
  options: Readonly<{ knownQueue?: EventQueue }> = {},
): Promise<ReadonlyMap<string, ChangeHistory>> {
  if (options.knownQueue === undefined) {
    if ((await queueFormat(store, queue)) !== "event") {
      throw new Error(`queue ${queue} in ${store.repo} has no event queue chain`)
    }
    await readEventQueue(store, queue)
  } else {
    const location = queueLocations.get(options.knownQueue)
    if (
      location?.repo !== store.repo ||
      location.remote !== store.remote ||
      location.queue !== queue ||
      location.backend !== store.backend
    ) {
      throw new Error(`validated queue must come from the same location: ${store.remote}#${queue} in ${store.repo}`)
    }
  }
  const prefix = `${queueRefPrefix(queue)}/changes/`
  const chains = await chainsUnder(prefix, { ...store, limit: 1024 })
  return projectChangeHistories(chains, prefix, store.repo)
}

/** Branch projections for an event queue. */
export async function listChanges(store: QueueLocation, queue: string): Promise<ReadonlyMap<string, EventChange>> {
  const histories = await listChangeHistories(store, queue)
  return new Map([...histories].map(([branch, history]) => [branch, history.state]))
}

/** Queue publications and merges observed on the target, including older endings after a branch reopened. */
export function mergedHistoryCommits(histories: ReadonlyMap<string, ChangeHistory>): ReadonlySet<Oid> {
  const commits = new Set<Oid>()
  for (const { events } of histories.values()) {
    for (const event of events) {
      if (event.type === "merged") commits.add(keptCommit(event))
    }
  }
  return commits
}

function project(events: readonly Event[], ref: string, repo: string): EventChange {
  if (events.length === 0) throw new Error(`empty event chain ${ref} in ${repo}`)
  if (events[0]?.parent !== null) {
    throw new Error(`event chain ${ref} in ${repo} exceeds 1024 events; refusing a partial status`)
  }
  return events.reduce(evolve, initial)
}
