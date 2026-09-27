/** Direct reads of one queue's authoritative numbered-run tree. */
import { randomUUID } from "node:crypto"
import type { GitomicBackend, Oid } from "gitomic"
import type { QueueLocation } from "./events.ts"
import { queueRef, runIndexRef } from "./refs.ts"

export const RUN_INDEX_CODES = {
  missing: "E_RUN_INDEX_MISSING",
  unknown: "E_RUN_UNKNOWN",
  corrupt: "E_RUN_INDEX_CORRUPT",
} as const

export type RunIndexRecord = Readonly<{
  id: string
  startedAt: string
  host: string
  actor: string
  firstQueueTip: Oid
}>
export type RunIndexIdentity = Omit<RunIndexRecord, "firstQueueTip">

export function runIndexPath(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`run number must be a positive safe integer, got ${number}`)
  }
  return `by-number/${Math.floor(number / 1000)}/${number}`
}

export function nextRunNumber(raw: string | undefined, ref: string): number {
  if (raw === undefined || !/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw corrupt(ref, "next", "must hold a positive decimal within the safe integer range")
  }
  return Number(raw)
}

export type RunIndexLookup =
  | Readonly<{ kind: "known"; number: number; record: RunIndexRecord }>
  | Readonly<{ kind: "unknown"; number: number }>

/** Prepare an unpublished index tip; the caller publishes it atomically with queue creation or activation. */
export async function writeRunIndexGenesis(store: QueueLocation, at: Date): Promise<Oid> {
  if (Number.isNaN(at.getTime())) throw new TypeError("run index genesis needs a valid instant")
  const root = await store.backend.writeGenesis?.(store.repo)
  if (root === undefined) throw new TypeError(`${store.repo}: Gitomic backend lacks writeGenesis for run index birth`)
  return store.backend.writeCommit(store.repo, {
    parent: root,
    time: Math.floor(at.getTime() / 1000),
    changes: new Map([["next", "1"]]),
    message: "create Yrd run index",
    writer: "yrd",
    instance: randomUUID(),
    seq: 0,
  })
}

/** Explicit one-time activation for a queue created before run indices existed. */
export async function activateRunIndex(store: QueueLocation, queue: string, at: Date): Promise<Oid> {
  const eventsRef = queueRef(queue)
  const indexRef = runIndexRef(queue)
  const fetchRefs = store.backend.fetchRefs
  const publish = store.backend.publish
  if (fetchRefs === undefined || publish === undefined) {
    throw new TypeError(`${indexRef}: Gitomic backend needs fetchRefs and atomic publish for activation`)
  }
  const tips = await fetchRefs(store.repo, [eventsRef, indexRef], store.remote, { absent: "omit" })
  const queueTip = tips.get(eventsRef)
  if (queueTip === undefined) {
    throw new Error(`${eventsRef} at ${store.remote} is absent; create the queue before activating its run index`)
  }
  const occupied = tips.get(indexRef)
  if (occupied !== undefined) {
    throw new Error(`${indexRef} at ${store.remote} already exists at ${occupied}; activation never replaces an index`)
  }
  const genesis = await writeRunIndexGenesis(store, at)
  await publish(
    store.repo,
    [
      { ref: eventsRef, expect: queueTip, oid: queueTip },
      { ref: indexRef, expect: "0".repeat(genesis.length), oid: genesis },
    ],
    store.remote,
  )
  return genesis
}

/** A queue clone may predate the index ref; seed only its derived local kept copy from remote authority. */
export async function primeRunIndexKeptRef(store: QueueLocation, queue: string): Promise<void> {
  const indexRef = runIndexRef(queue)
  const eventsRef = queueRef(queue)
  const fetchRefs = store.backend.fetchRefs
  const listRefs = store.backend.listRefs
  if (fetchRefs === undefined || listRefs === undefined) {
    throw new TypeError(`${indexRef}: Gitomic backend needs fetchRefs and listRefs for the run index`)
  }
  const tips = await fetchRefs(store.repo, [eventsRef, indexRef], store.remote, { absent: "omit" })
  if (tips.get(eventsRef) === undefined) throw new Error(`${eventsRef} at ${store.remote} is absent`)
  const remoteTip = tips.get(indexRef)
  if (remoteTip === undefined) {
    throw new Error(
      `${RUN_INDEX_CODES.missing}: ${indexRef} at ${store.remote} is absent for existing ${eventsRef}; activate the queue run index from its recovery bundle before allocating or looking up a number`,
    )
  }
  if ((await listRefs(store.repo, indexRef)).get(indexRef) !== undefined) return
  const outcome = await store.backend.compareAndSwap(store.repo, indexRef, remoteTip, "0".repeat(remoteTip.length))
  if (outcome === "locked") {
    throw new Error(`${indexRef} in ${store.repo}: local kept ref is locked during run-index setup`)
  }
  if (outcome === "moved" && (await listRefs(store.repo, indexRef)).get(indexRef) === undefined) {
    throw new Error(`${indexRef} in ${store.repo}: local kept ref moved but is still absent`)
  }
}

function corrupt(ref: string, path: string, reason: string): Error {
  return new Error(`${RUN_INDEX_CODES.corrupt}: ${ref}:${path} ${reason}`)
}

async function readBlob(
  backend: GitomicBackend,
  repo: string,
  tip: Oid,
  ref: string,
  path: string,
): Promise<string | undefined> {
  let entry: Oid | undefined
  try {
    entry = (await backend.readTree(repo, tip, path)).get(path)?.oid
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "GitPrefixNotFoundError") throw error
    return undefined
  }
  if (entry === undefined) return undefined
  const value = (await backend.readBlobs(repo, [entry])).get(entry)
  if (typeof value !== "string") throw corrupt(ref, path, "must be a UTF-8 text blob")
  return value
}

function parseRecord(ref: string, path: string, raw: string): RunIndexRecord {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw corrupt(ref, path, "contains invalid JSON")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt(ref, path, "must contain a run record object")
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== "string" ||
    record.id === "" ||
    typeof record.startedAt !== "string" ||
    Number.isNaN(Date.parse(record.startedAt)) ||
    typeof record.host !== "string" ||
    record.host === "" ||
    typeof record.actor !== "string" ||
    record.actor === "" ||
    typeof record.firstQueueTip !== "string" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(record.firstQueueTip)
  ) {
    throw corrupt(ref, path, "is missing a valid id, startedAt, host, actor, or firstQueueTip")
  }
  return {
    id: record.id,
    startedAt: record.startedAt,
    host: record.host,
    actor: record.actor,
    firstQueueTip: record.firstQueueTip,
  }
}

/** Read only `next` and the requested numbered entry; no history or whole-tree scan. */
export async function lookupRunIndex(store: QueueLocation, queue: string, number: number): Promise<RunIndexLookup> {
  runIndexPath(number)
  const indexRef = runIndexRef(queue)
  const eventsRef = queueRef(queue)
  const fetchRefs = store.backend.fetchRefs
  if (fetchRefs === undefined) {
    throw new TypeError(`${indexRef}: Gitomic backend lacks fetchRefs for remote index lookup`)
  }
  const tips = await fetchRefs(store.repo, [eventsRef, indexRef], store.remote, { absent: "omit" })
  if (tips.get(eventsRef) === undefined) {
    throw new Error(
      `${eventsRef} at ${store.remote} is absent; create or select an existing queue before looking up a run`,
    )
  }
  const tip = tips.get(indexRef)
  if (tip === undefined) {
    throw new Error(
      `${RUN_INDEX_CODES.missing}: ${indexRef} at ${store.remote} is absent for existing ${eventsRef}; activate the queue run index from its recovery bundle before allocating or looking up a number`,
    )
  }
  const nextRaw = await readBlob(store.backend, store.repo, tip, indexRef, "next")
  const next = nextRunNumber(nextRaw, indexRef)
  if (number >= next) return { kind: "unknown", number }
  const path = runIndexPath(number)
  const raw = await readBlob(store.backend, store.repo, tip, indexRef, path)
  return raw === undefined
    ? { kind: "unknown", number }
    : { kind: "known", number, record: parseRecord(indexRef, path, raw) }
}
