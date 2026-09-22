/** Yrd's event meaning. Gitomic owns the commits and CAS; this module owns the fold. */
import { chainsUnder, listRefs, openEvents } from "gitomic/events"
import type { Event, EventInput } from "gitomic/events"
import type { GitomicBackend } from "gitomic"

import { queueRefPrefix } from "./refs.ts"

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

export type EventChange = Readonly<{
  status: ChangeStatus
  /** The submitted commit of the current or last change. */
  commit?: string
  /** This chain's latest ending, including the event that recorded it. */
  ending?: { kind: ChangeEnding; id: string }
  reason?: string
  ignored: boolean
}>

export const initial: EventChange = Object.freeze({ status: "draft", ignored: false })

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
  if (event.props.some(([key]) => key === "Status")) {
    throw new Error(`event ${event.id} stores Status:; status must be a fold`)
  }
  switch (event.type) {
    case "opened": {
      if (isOpen(state.status)) throw new Error(`event ${event.id} opens a second change before the first ends`)
      return { ...state, status: "queued", commit: keptCommit(event), ending: undefined, reason: undefined }
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
      return { ...state, status: event.type, reason: prop(event, "Reason") }
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
      return { ...state, status: event.type, ending: { kind: event.type, id: event.id }, reason }
    }
    case "merged":
      // A merge observed on main is ground truth even after a recorded ending.
      if (state.commit === undefined) throw new Error(`event ${event.id} merged needs an opened change`)
      return { ...state, status: "merged", ending: { kind: "merged", id: event.id }, reason: prop(event, "Reason") }
    case "ignored": {
      const reason = prop(event, "Reason")
      if (reason === undefined || reason.length === 0) throw new Error(`event ${event.id} ignored needs Reason:`)
      return { ...state, ignored: true }
    }
    case "unignored":
      return { ...state, ignored: false }
    case "sent":
    case "observed":
      return state
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
    const cancelled: EventInput = { type: "cancelled", props: [["Reason", "resubmitted"]] }
    evolve(evolve(state, pending(cancelled)), pending(input))
    return [cancelled, input]
  }
  evolve(state, pending(input))
  return [input]
}

export type EventStore = Readonly<{ repo: string; backend?: GitomicBackend; remote?: string }>

/** One advertisement selects the format. An event queue with no changes is empty. */
export async function queueFormat(queue: string, store: EventStore): Promise<"event" | "legacy"> {
  const refs = await listRefs(queueRefPrefix(queue), store)
  return refs.has(queueRef(queue)) ? "event" : "legacy"
}

/** Read one existing branch chain; a missing selected chain is a data error. */
export async function readStatus(queue: string, branch: string, store: EventStore): Promise<EventChange> {
  const ref = changesRef(queue, branch)
  const chain = await openEvents({ ...store, ref })
  if ((await chain.head()) === null) throw new Error(`missing event chain ${ref} in ${store.repo}`)
  return project(await chain.events({ limit: 1024 }), ref, store.repo)
}

/** Branch projections for a local event queue, with one shared history walk. */
export async function listChanges(queue: string, store: EventStore): Promise<ReadonlyMap<string, EventChange>> {
  if ((await queueFormat(queue, store)) !== "event") {
    throw new Error(`queue ${queue} in ${store.repo} has no event queue chain`)
  }
  if (store.remote !== undefined) {
    throw new TypeError("remote event listing requires gitomic 3a.1 batch fetch")
  }
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
