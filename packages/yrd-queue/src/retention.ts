import type { DeepReadonly } from "@yrd/core"
import { Queues, type QueueRecord, type QueuesState, type RunId } from "./model.ts"
import {
  emptyQueueProjectionIndex,
  indexQueueStart,
  projectionLookupEntries,
  projectionLookupFromEntries,
  recordReleasedAdmissionFailure,
} from "./projection-index.ts"

const TERMINAL_QUEUE_WINDOW = 512

export function queueRetentionRoot(queues: DeepReadonly<QueuesState>, id: RunId): RunId {
  const seen = new Set<RunId>()
  let root = id
  while (true) {
    if (seen.has(root)) throw new Error(`yrd: queue retention ancestry for '${id}' is cyclic`)
    seen.add(root)
    const record = Queues.get(queues, root)
    if (record === undefined) throw new Error(`yrd: queue retention ancestry for '${id}' is missing '${root}'`)
    if (record.parent === undefined) return root
    root = record.parent
  }
}

/** @internal Pure bounded live projection. `protectedRoots` are terminal facts
 * that still participate in a live decision; immutable Journal replay remains
 * complete for everything else. */
export function compactQueuesState(
  queues: DeepReadonly<QueuesState>,
  protectedRoots: ReadonlySet<RunId> = new Set(),
): QueuesState {
  if (Object.keys(queues.retention.terminalOrder).length <= TERMINAL_QUEUE_WINDOW) return queues as QueuesState
  const records = Queues.values(queues)
  const trees = new Map<RunId, QueueRecord[]>()
  for (const record of records) {
    const root = queueRetentionRoot(queues, record.id)
    trees.set(root, [...(trees.get(root) ?? []), record])
  }
  const terminalRoots: Array<Readonly<{ root: RunId; order: number }>> = []
  const retainedRoots = new Set<RunId>()
  for (const root of trees.keys()) {
    const order = queues.retention.terminalOrder[root]
    if (order === undefined || protectedRoots.has(root)) retainedRoots.add(root)
    else terminalRoots.push({ root, order })
  }
  terminalRoots
    .toSorted(
      (left, right) => right.order - left.order || right.root.localeCompare(left.root, undefined, { numeric: true }),
    )
    .slice(0, TERMINAL_QUEUE_WINDOW)
    .forEach(({ root }) => retainedRoots.add(root))
  const keep = new Set(
    [...trees].flatMap(([root, members]) => (retainedRoots.has(root) ? members.map(({ id }) => id) : [])),
  )
  if (keep.size === records.length) return queues as QueuesState

  const retained = records.filter(({ id }) => keep.has(id))
  const recordsLookup = projectionLookupFromEntries(retained.map((value) => ({ key: value.id, value })))
  let index = emptyQueueProjectionIndex()
  for (const record of retained) {
    index = indexQueueStart(index, record)
    if (record.failure !== undefined || record.canceledAt !== undefined) {
      index = recordReleasedAdmissionFailure(index, record)
    }
  }
  index = { ...index, nextRunNumber: queues.index.nextRunNumber }
  const runs = projectionLookupFromEntries(
    projectionLookupEntries(queues.authority.runs).filter(({ key }) => keep.has(key)),
  )
  const claims = Object.fromEntries(
    Object.entries(queues.authority.claims).filter(
      ([, token]) => token.consumedBy === undefined || keep.has(token.consumedBy),
    ),
  )
  const terminalOrder = Object.fromEntries(
    Object.entries(queues.retention.terminalOrder).filter(([root]) => retainedRoots.has(root)),
  )
  const applied = Object.fromEntries(
    Object.entries(queues.terminalAssociations.applied).filter(([, association]) => keep.has(association.run)),
  )
  return {
    ...queues,
    records: recordsLookup,
    index,
    authority: { ...queues.authority, claims, runs },
    terminalAssociations: { ...queues.terminalAssociations, applied },
    retention: { terminalOrder },
  }
}
