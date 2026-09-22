/** Yrd's event meaning. Gitomic owns the commits and CAS; this module owns the fold. */
import { chainsUnder, listRefs, openEvents } from "gitomic/events"
import type { AlsoRef, Event, EventInput } from "gitomic/events"
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
  by: "By",
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
    by?: string
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
  if (type === "opened" && (details.by === undefined || details.by.trim() === "")) {
    throw new TypeError("opened needs By:")
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
      const submitter = prop(event, EVENT_TRAILERS.by)
      if (submitter === undefined || submitter.trim() === "") throw new Error(`event ${event.id} opened needs By:`)
      return {
        ...next,
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
      if (
        event.type === "verifying" &&
        state.status !== "queued" &&
        state.status !== "verifying" &&
        state.status !== "checking" &&
        state.status !== "merging"
      ) {
        throw new Error(
          `event ${event.id} verifying needs queued, verifying, checking or merging, found ${state.status}`,
        )
      }
      const candidate = event.type === "verifying" ? keptCommit(event) : state.candidate
      return { ...next, status: event.type, candidate, reason: prop(event, "Reason") }
    }
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
          endedAt: at,
          reason,
        }
      }
      if (!isOpen(state.status)) return endingRefusal(state, event)
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
      if (
        (state.status === "merging" && kept !== state.candidate) ||
        (state.status !== "merging" && kept !== state.commit && kept !== state.candidate)
      ) {
        throw new Error(
          `event ${event.id} merged must keep ${state.status === "merging" ? `candidate ${state.candidate}` : `submitted commit ${state.commit}${state.candidate === undefined ? "" : ` or candidate ${state.candidate}`}`}`,
        )
      }
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

export type QueueLocation = Readonly<{ repo: string; remote: string; backend?: GitomicBackend }>
export type DropRequest = Readonly<{ queue: string; branch: string; by: string; note?: string }>
export type Dropped = Readonly<{ queue: string; branch: string; head: string; event: string }>

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
export async function createEventQueue(store: QueueLocation, queue: string, commit: string, at: Date): Promise<string> {
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
export async function readEventQueue(store: QueueLocation, queue: string): Promise<EventQueue> {
  const ref = queueRef(queue)
  const events = await (await openEvents({ ...store, ref })).events({ limit: 1024 })
  return projectEventQueue(events, ref, store.repo)
}

export type WriteQueueEvent = Readonly<{ type: "paused" | "resumed"; reason: string; by: string; at: Date }>

/** Append a queue stop under Gitomic's CAS; retries fold the current chain again. */
export async function writeQueueEvent(store: QueueLocation, queue: string, write: WriteQueueEvent): Promise<string> {
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
    throw new Error(`${ref} moved after the selected reading: expected ${selectedTip}, read ${state.tip}`)
  }
  return events
}

/** Write one run decision against the row it judged; a rival tip discards that judgement. */
export async function appendChangeEvent(
  store: QueueLocation,
  queue: string,
  branch: string,
  selectedTip: string,
  write: Readonly<{
    type: Exclude<ChangeEventType, "opened">
    at: Date
    commit?: string
    issue?: string
    reason?: string
    title?: string
    content?: string
    writer?: string
    /** A target or branch ref moved in the same CAS publish as this event. */
    also?: readonly AlsoRef[]
  }>,
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
  })
  const planned = decide(history, input)
  if (planned.length !== 1) {
    throw new Error(`${changesRef(queue, branch)}: a run decision wrote ${planned.length} events`)
  }
  const ref = changesRef(queue, branch)
  const result = await (
    await openEvents({ ...store, ref, writer: write.writer ?? "yrd" })
  ).append(planned, {
    expect: selectedTip,
    ...(write.also === undefined ? {} : { also: write.also }),
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
  const head = (await listRefs(branchRef, store)).get(branchRef)
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

/** Branch projections for an event queue, with one batched remote fetch and history walk. */
export async function listChanges(store: QueueLocation, queue: string): Promise<ReadonlyMap<string, EventChange>> {
  if ((await queueFormat(store, queue)) !== "event") {
    throw new Error(`queue ${queue} in ${store.repo} has no event queue chain`)
  }
  await readEventQueue(store, queue)
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
