/** Yrd's event meaning. Gitomic owns the commits and CAS; this module owns the fold. */
import { chainsUnder, listRefs, openEvents } from "gitomic/events"
import type { Event, EventInput } from "gitomic/events"
import type { GitomicBackend } from "gitomic"

import { queueRefPrefix } from "./refs.ts"
import type { PauseRecord } from "./pause.ts"

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

export const EVENT_TRAILERS = {
  commit: "Commit",
  issue: "Issue",
  queue: "Queue",
  reason: "Reason",
  time: "Time",
} as const
const COMMIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

export const CHANGE_EVENT_TYPES = [
  "opened",
  "verifying",
  "checking",
  "merging",
  "merged",
  "failed",
  "stuck",
  "cancelled",
  "ignored",
  "unignored",
  "sent",
  "observed",
] as const
export type ChangeEventType = (typeof CHANGE_EVENT_TYPES)[number]

export type EventChange = Readonly<{
  status: ChangeStatus
  /** The submitted commit of the current or last change. */
  commit?: string
  issue?: string
  since?: Date
  at?: Date
  endedAt?: Date
  tip?: string
  /** This chain's latest ending, including the event that recorded it. */
  ending?: { kind: ChangeEnding; id: string }
  reason?: string
  ignored: boolean
}>

export const initial: EventChange = Object.freeze({ status: "draft", ignored: false })

/** Construct Yrd's required causal trailers; a recorded commit is always kept. */
export function changeInput(
  type: ChangeEventType,
  details: Readonly<{
    queueTip: string
    at: Date
    commit?: string
    issue?: string
    reason?: string
    title?: string
    content?: string
  }>,
): EventInput {
  if (!COMMIT_OID.test(details.queueTip)) throw new TypeError(`Queue: must name a commit oid, got ${details.queueTip}`)
  if (Number.isNaN(details.at.getTime())) throw new TypeError("Time: needs a valid instant")
  if ((type === "opened" || type === "verifying") && details.commit === undefined) {
    throw new TypeError(`${type} needs Commit:`)
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
  if (details.reason !== undefined) props.push([EVENT_TRAILERS.reason, details.reason])
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

function prop(event: EventShape, key: string): string | undefined {
  const found = event.props.filter(([name]) => name === key)
  if (found.length > 1) throw new Error(`event ${event.id} repeats ${key}:`)
  return found[0]?.[1]
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

/** Pure fold. Unknown kinds and malformed transitions fail at the selected event chain. */
export function evolve(state: EventChange, event: EventShape): EventChange {
  const at = requireCause(event)
  if (event.props.some(([key]) => key === "Status")) {
    throw new Error(`event ${event.id} stores Status:; status must be a fold`)
  }
  const next = { ...state, at, tip: event.id }
  switch (event.type) {
    case "opened": {
      if (isOpen(state.status)) throw new Error(`event ${event.id} opens a second change before the first ends`)
      return {
        ...next,
        status: "queued",
        commit: keptCommit(event),
        issue: prop(event, EVENT_TRAILERS.issue),
        since: at,
        endedAt: undefined,
        ending: undefined,
        reason: undefined,
      }
    }
    case "verifying":
    case "checking":
    case "merging":
    case "stuck": {
      if (state.status === "stuck") {
        throw new Error(`event ${event.id} (${event.type}) cannot advance a stuck change; merge or cancel it`)
      }
      if (!isOpen(state.status)) return endingRefusal(state, event)
      if (event.type === "checking" && state.status !== "verifying") {
        throw new Error(`event ${event.id} checking needs verifying, found ${state.status}`)
      }
      if (event.type === "merging" && state.status !== "checking") {
        throw new Error(`event ${event.id} merging needs checking, found ${state.status}`)
      }
      if (event.type === "verifying" && state.status !== "queued" && state.status !== "verifying") {
        throw new Error(`event ${event.id} verifying needs queued or verifying, found ${state.status}`)
      }
      if (event.type === "verifying") keptCommit(event)
      return { ...next, status: event.type, reason: prop(event, "Reason") }
    }
    case "failed":
    case "cancelled": {
      if (!isOpen(state.status)) return endingRefusal(state, event)
      const reason = prop(event, "Reason")
      if (event.type === "cancelled") {
        if (reason !== "resubmitted" && reason !== "dropped" && reason !== "deleted") {
          throw new Error(`event ${event.id} cancelled needs Reason: resubmitted, dropped or deleted`)
        }
        if (reason === "dropped" || reason === "deleted") keptCommit(event)
      }
      return { ...next, status: event.type, ending: { kind: event.type, id: event.id }, endedAt: at, reason }
    }
    case "merged":
      // A merge observed on main is ground truth even after a recorded ending.
      if (state.commit === undefined) throw new Error(`event ${event.id} merged needs an opened change`)
      return {
        ...next,
        status: "merged",
        ending: { kind: "merged", id: event.id },
        endedAt: at,
        reason: prop(event, "Reason"),
      }
    case "ignored": {
      const reason = prop(event, "Reason")
      if (reason === undefined || reason.length === 0) throw new Error(`event ${event.id} ignored needs Reason:`)
      return { ...next, ignored: true }
    }
    case "unignored":
      return { ...next, ignored: false }
    case "sent":
    case "observed":
      return next
    default:
      throw new Error(`unknown Yrd change event ${event.type} at ${event.id}`)
  }
}

function isOpen(status: ChangeStatus): boolean {
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

export type EventStore = Readonly<{ repo: string; backend?: GitomicBackend; remote?: string }>

export type EventQueue = Readonly<{
  created: string
  tip: string
  pause?: Readonly<{ id: string; at: Date; reason: string; by: string }>
}>

/** The queue stop in the existing command response shape. */
export function eventPause(queue: EventQueue): PauseRecord | undefined {
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
export async function createEventQueue(queue: string, commit: string, store: EventStore, at: Date): Promise<string> {
  const ref = queueRef(queue)
  if (!COMMIT_OID.test(commit)) throw new TypeError(`Commit: must name a commit oid, got ${commit}`)
  if (Number.isNaN(at.getTime())) throw new TypeError("Time: needs a valid instant")
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
export async function readEventQueue(queue: string, store: EventStore): Promise<EventQueue> {
  const ref = queueRef(queue)
  const events = await (await openEvents({ ...store, ref })).events({ limit: 1024 })
  return projectEventQueue(events, ref, store.repo)
}

export type WriteQueueEvent = Readonly<{ type: "paused" | "resumed"; reason: string; by: string; at: Date }>

/** Append a queue stop under Gitomic's CAS; retries fold the current chain again. */
export async function writeQueueEvent(queue: string, write: WriteQueueEvent, store: EventStore): Promise<string> {
  const ref = queueRef(queue)
  if (write.reason.trim() === "") throw new TypeError(`${write.type} needs Reason:`)
  if (Number.isNaN(write.at.getTime())) throw new TypeError("Time: needs a valid instant")
  const chain = await openEvents({ ...store, ref, writer: write.by })
  const result = await chain.transact((events) => {
    const current = projectEventQueue(events, ref, store.repo)
    const input: EventInput = {
      type: write.type,
      props: [
        [EVENT_TRAILERS.queue, current.tip],
        [EVENT_TRAILERS.time, write.at.toISOString()],
        [EVENT_TRAILERS.reason, write.reason],
      ],
    }
    const pending: Event = {
      id: "pending",
      parent: current.tip,
      links: [],
      type: input.type,
      title: input.type,
      content: "",
      props: input.props ?? [],
      writer: write.by,
      instance: null,
      seq: null,
    }
    projectEventQueue([...events, pending], ref, store.repo)
    return [input]
  }, `${write.type} ${queue}`)
  const written = result.events[0]?.id
  if (written === undefined) throw new Error(`${ref} in ${store.repo}: ${write.type} event was not written`)
  return written
}

function projectEventQueue(events: readonly Event[], ref: string, repo: string): EventQueue {
  const first = events[0]
  if (first === undefined) throw new Error(`missing event queue chain ${ref} in ${repo}`)
  if (first.parent !== null) {
    throw new Error(`event queue chain ${ref} in ${repo} exceeds 1024 events; refusing a partial read`)
  }
  let previous: string | undefined
  let pause: EventQueue["pause"]
  for (const [index, event] of events.entries()) {
    if (index === 0) {
      if (event.type !== "created") throw new Error(`${ref}: first event ${event.id} must be created`)
      keptCommit(event)
      if (prop(event, EVENT_TRAILERS.queue) !== undefined) {
        throw new Error(`${ref}: created event ${event.id} cannot name a preceding Queue:`)
      }
    } else {
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
      default:
        throw new Error(`${ref}: unknown queue event ${event.type} at ${event.id}`)
    }
    previous = event.id
  }
  if (previous === undefined) throw new Error(`missing event queue tip ${ref} in ${repo}`)
  return { created: first.id, tip: previous, ...(pause === undefined ? {} : { pause }) }
}

/** One advertisement selects the format. An event queue with no changes is empty. */
export async function queueFormat(queue: string, store: EventStore): Promise<"event" | "legacy"> {
  const refs = await listRefs(queueRefPrefix(queue), store)
  return refs.has(queueRef(queue)) ? "event" : "legacy"
}

/** Read one existing branch chain; a missing selected chain is a data error. */
export async function readStatus(queue: string, branch: string, store: EventStore): Promise<EventChange> {
  await readEventQueue(queue, store)
  const ref = changesRef(queue, branch)
  const chain = await openEvents({ ...store, ref })
  if ((await chain.head()) === null) throw new Error(`missing event chain ${ref} in ${store.repo}`)
  return project(await chain.events({ limit: 1024 }), ref, store.repo)
}

/** Branch projections for an event queue, with one batched remote fetch and history walk. */
export async function listChanges(queue: string, store: EventStore): Promise<ReadonlyMap<string, EventChange>> {
  if ((await queueFormat(queue, store)) !== "event") {
    throw new Error(`queue ${queue} in ${store.repo} has no event queue chain`)
  }
  await readEventQueue(queue, store)
  const prefix = `${queueRefPrefix(queue)}/changes/`
  const chains = await chainsUnder(prefix, { ...store, limit: 1024 })
  const changes = new Map<string, EventChange>()
  for (const [ref, events] of chains) {
    changes.set(ref.slice(prefix.length), project(events, ref, store.repo))
  }
  return changes
}

function project(events: readonly Event[], ref: string, repo: string): EventChange {
  if (events.length === 0) throw new Error(`empty event chain ${ref} in ${repo}`)
  if (events[0]?.parent !== null) {
    throw new Error(`event chain ${ref} in ${repo} exceeds 1024 events; refusing a partial status`)
  }
  return events.reduce(evolve, initial)
}
