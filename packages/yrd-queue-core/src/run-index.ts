/** Direct reads of one queue's authoritative numbered-run tree. */
import { randomUUID } from "node:crypto"
import type { GitomicBackend, Oid } from "./git.ts"
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
  | Readonly<{ kind: "unknown"; number: number; knownThrough: number }>

/** Bring the index along with the event queue's existing fetch, including on a cold clone. */
export function queueReadWithRunIndex(
  store: QueueLocation,
  queue: string,
): Readonly<{
  store: QueueLocation
  tip(): Oid
}> {
  const indexRef = runIndexRef(queue)
  const eventsRef = queueRef(queue)
  const fetchRefs = store.backend.fetchRefs
  if (fetchRefs === undefined) throw new TypeError(`${indexRef}: Gitomic backend needs fetchRefs`)
  let captured: Oid | undefined
  return {
    store: {
      ...store,
      backend: {
        ...store.backend,
        fetchRefs: async (repo, refs, remote, options) => {
          const queueRead = Array.isArray(refs) && refs.includes(eventsRef)
          const requested = queueRead && !refs.includes(indexRef) ? (refs as readonly string[]).concat(indexRef) : refs
          const tips = await fetchRefs(repo, requested, remote, options)
          if (queueRead) {
            const tip = tips.get(indexRef)
            if (tip === undefined) {
              throw new Error(
                `${RUN_INDEX_CODES.missing}: ${indexRef} at ${remote} is absent for existing ${eventsRef}; activate the queue run index from its recovery bundle before allocating or looking up a number`,
              )
            }
            captured = tip
          }
          return tips
        },
      },
    },
    tip: () => {
      if (captured === undefined) throw new Error(`${indexRef}: queue read did not fetch the run index`)
      return captured
    },
  }
}

/** Stage an index successor locally; the event publisher leases both refs in one push. */
export async function stageRunIndexEntry(
  store: QueueLocation,
  queue: string,
  tip: Oid,
  identity: RunIndexIdentity,
  queueTip: Oid,
  at: Date,
): Promise<Readonly<{ number: number; next: Oid }>> {
  const ref = runIndexRef(queue)
  const number = nextRunNumber(await readBlob(store.backend, store.repo, tip, ref, "next"), ref)
  if (!Number.isSafeInteger(number + 1)) throw new Error(`${ref}: next ${number} exceeds the safe run-number range`)
  const path = runIndexPath(number)
  if ((await readBlob(store.backend, store.repo, tip, ref, path)) !== undefined) {
    throw new Error(`${ref}:${path} already exists while next is ${number}`)
  }
  const next = await store.backend.writeCommit(store.repo, {
    parent: tip,
    time: Math.floor(at.getTime() / 1000),
    changes: new Map([
      ["next", String(number + 1)],
      [path, JSON.stringify({ ...identity, firstQueueTip: queueTip })],
    ]),
    message: `allocate run ${number}`,
    writer: "yrd",
    instance: randomUUID(),
    seq: 0,
  })
  return { number, next }
}

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
  if (number >= next) return { kind: "unknown", number, knownThrough: next - 1 }
  const path = runIndexPath(number)
  const raw = await readBlob(store.backend, store.repo, tip, indexRef, path)
  return raw === undefined
    ? { kind: "unknown", number, knownThrough: next - 1 }
    : { kind: "known", number, record: parseRecord(indexRef, path, raw) }
}
