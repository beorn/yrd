import { compareNatural } from "@yrd/core"
import { Queues } from "./model.ts"
import type {
  InstalledStep,
  ChangeSnapshot,
  QueueProjectionIndex,
  QueueProjectionLookup,
  QueueProjectionPlan,
  QueueRecord,
  QueuesState,
  RunId,
} from "./model.ts"
import { projectionLookupGet, projectionLookupSet } from "./projection-lookup.ts"
export {
  projectionLookupEntries,
  projectionLookupFromEntries,
  projectionLookupGet,
  projectionLookupSet,
  projectionLookupValues,
} from "./projection-lookup.ts"

export function emptyQueueProjectionIndex(): QueueProjectionIndex {
  return {
    version: 1,
    nextRunNumber: 1,
    childByParentPart: {},
    rootsByMember: {},
    plans: {},
  }
}

export function queueLookupKey(snapshot: Readonly<ChangeSnapshot>, steps: readonly Readonly<InstalledStep>[]): string {
  return JSON.stringify([
    [snapshot.id, snapshot.revision, snapshot.headSha, snapshot.base, snapshot.baseSha ?? null],
    steps.map((step) => [step.name, step.revision, step.kind, step.classification ?? null]),
  ])
}

export function indexQueueStart(
  index: Readonly<QueueProjectionIndex>,
  record: Readonly<QueueRecord>,
): QueueProjectionIndex {
  const sequence = /^R(\d+)$/u.exec(record.id)
  const observed = sequence === null ? 0 : Number(sequence[1])
  const nextRunNumber = Number.isSafeInteger(observed)
    ? Math.max(index.nextRunNumber, observed + 1)
    : index.nextRunNumber
  const parentPartKey =
    record.parent === undefined || record.isolationPart === undefined
      ? undefined
      : childKey(record.parent, record.isolationPart)
  const currentChild =
    parentPartKey === undefined ? undefined : projectionLookupGet(index.childByParentPart, parentPartKey)
  const childByParentPart =
    parentPartKey === undefined || (currentChild !== undefined && compareRunIds(currentChild, record.id) <= 0)
      ? index.childByParentPart
      : projectionLookupSet(index.childByParentPart, parentPartKey, record.id)
  let rootsByMember = index.rootsByMember
  if (record.parent === undefined) {
    for (const snapshot of record.prs) {
      const key = queueMemberKey(snapshot)
      rootsByMember = projectionLookupSet(
        rootsByMember,
        key,
        latestRunId(projectionLookupGet(rootsByMember, key), record.id),
      )
    }
  }
  const snapshot = record.prs.length === 1 ? record.prs[0] : undefined
  if (snapshot === undefined) return { ...index, nextRunNumber, childByParentPart, rootsByMember }

  let plans = index.plans
  for (const indexedSnapshot of lookupSnapshots(snapshot)) {
    const exactKey = queueLookupKey(indexedSnapshot, record.steps)
    const exact = projectionLookupGet(plans, exactKey)
    plans = updatePlan(plans, exactKey, {
      latestExact: latestRunId(exact?.latestExact, record.id),
    })
    for (let length = 1; length <= record.steps.length; length += 1) {
      const key = queueLookupKey(indexedSnapshot, record.steps.slice(0, length))
      const prefix = projectionLookupGet(plans, key)
      plans = updatePlan(plans, key, {
        latestPrefix: latestRunId(prefix?.latestPrefix, record.id),
      })
    }
  }
  return { ...index, nextRunNumber, childByParentPart, rootsByMember, plans }
}

/** Index fresh bisection provenance from its dedicated event. Run.parent is
 * the durable public relationship; this part lookup only resumes the
 * deterministic two-child traversal. */
export function indexQueueChild(
  index: Readonly<QueueProjectionIndex>,
  parent: RunId,
  part: 0 | 1,
  run: RunId,
): QueueProjectionIndex {
  const key = childKey(parent, part)
  const current = projectionLookupGet(index.childByParentPart, key)
  if (current !== undefined && compareRunIds(current, run) <= 0) return index
  return { ...index, childByParentPart: projectionLookupSet(index.childByParentPart, key, run) }
}

export function recordReleasedAdmissionFailure(
  index: Readonly<QueueProjectionIndex>,
  record: Readonly<QueueRecord>,
): QueueProjectionIndex {
  const snapshot =
    record.stepSelection?.authority === "admission" && record.prs.length === 1 ? record.prs[0] : undefined
  if (snapshot === undefined) return index
  let plans = index.plans
  for (const indexedSnapshot of lookupSnapshots(snapshot)) {
    const key = queueLookupKey(indexedSnapshot, record.steps)
    plans = updatePlan(plans, key, {
      releasedAdmissionFailures: (projectionLookupGet(plans, key)?.releasedAdmissionFailures ?? 0) + 1,
    })
  }
  return { ...index, plans }
}

export function childRunId(index: Readonly<QueueProjectionIndex>, parent: RunId, part: 0 | 1): RunId | undefined {
  return projectionLookupGet(index.childByParentPart, childKey(parent, part))
}

export function latestExactRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<ChangeSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): RunId | undefined {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.latestExact
}

export function latestPrefixRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<ChangeSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): RunId | undefined {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.latestPrefix
}

export function latestRootRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<ChangeSnapshot>,
): RunId | undefined {
  return projectionLookupGet(index.rootsByMember, queueMemberKey(snapshot))
}

export function releasedAdmissionFailures(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<ChangeSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): number {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.releasedAdmissionFailures ?? 0
}

/**
 * The root runs the queue still OWNS — recovery's population, and every other
 * caller's answer to "what is live right now".
 *
 * Re-sourced onto durable records (S7, branch-is-change @i/10 22991). This
 * walked `authority.claims` and asked which runs a claim token named as its
 * consumer. That store is seeded only by the `pr/submitted` and
 * `pr/checks-requested` reducers, both of which have been bare `return state`
 * since the change-record store was deleted, so `claims` is now permanently
 * `{}` and this function returned `[]` for every state. `queue.recover` opens
 * with it as its ownership capture, so the fleet's unwedge path reported
 * success while reclaiming nothing — measured on a root parked `waiting`:
 * `runs [["R1","waiting"]]`, `claims {}`, `activeRoots []`, `recover() []`.
 *
 * The three facts below all still have rows, and each carries one third of what
 * a claim token used to say:
 *
 *   - a ROOT record (`parent === undefined`) — the run tree's own shape, which
 *     never depended on a token;
 *   - an EXPLICIT-settlement record — the new-run marker, absent only on
 *     pre-settlement journals, which the claims walk excluded implicitly;
 *   - not TERMINAL (`retention.terminalOrder`) — written by `queue/run/settled`
 *     and by a canceled root, so a settled run retires here exactly when it
 *     used to lose its claim;
 *   - not RELEASED (`authority.runs[id].released`) — the one live member of the
 *     authority family, written by `projectRunAuthority` at every run start and
 *     stamped by `releaseRunAuthority`, and what retires a base-moved or
 *     stale-plan failure that never reaches a terminal mark.
 *
 * Deliberately NOT sourced on the stored authority TOKENS. Every one of
 * `authority.claims`, `.submits`, `.checks` and `.current` is written only by a
 * dead `pr/*` reducer; a re-source onto any of them would be born dark in
 * exactly the way this one was.
 */
export function activeQueueRootIds(queues: Readonly<QueuesState>): readonly RunId[] {
  const roots = new Set<RunId>()
  for (const record of Queues.values(queues)) {
    if (record.parent !== undefined) continue
    // A record with no `settlement` marker predates the settlement protocol, so
    // nothing will ever settle it and calling it active manufactures a root that
    // recovery would chase forever. The claims walk excluded these implicitly —
    // it only ever wrote a claim for an explicit-settlement run — and dropping
    // that exclusion resurrects the legacy replay this guard is named for.
    if (record.settlement !== "explicit") continue
    if (queues.retention.terminalOrder[record.id] !== undefined) continue
    if (projectionLookupGet(queues.authority.runs, record.id)?.released !== undefined) continue
    roots.add(record.id)
  }
  return [...roots].toSorted(compareRunIds)
}

function childKey(parent: RunId, part: 0 | 1): string {
  return `${parent}\0${part}`
}

function queueMemberKey(snapshot: Readonly<ChangeSnapshot>): string {
  return JSON.stringify([snapshot.id, snapshot.revision, snapshot.headSha])
}

function lookupSnapshots(snapshot: Readonly<ChangeSnapshot>): readonly Readonly<ChangeSnapshot>[] {
  return snapshot.baseSha === undefined ? [snapshot] : [snapshot, { ...snapshot, baseSha: undefined }]
}

function compareRunIds(left: RunId, right: RunId): number {
  return compareNatural(left, right)
}

function latestRunId(current: RunId | undefined, candidate: RunId): RunId {
  return current === undefined || compareRunIds(current, candidate) < 0 ? candidate : current
}

function updatePlan(
  lookup: Readonly<QueueProjectionLookup<QueueProjectionPlan>>,
  key: string,
  fields: Readonly<QueueProjectionPlan>,
): QueueProjectionLookup<QueueProjectionPlan> {
  return projectionLookupSet(lookup, key, { ...projectionLookupGet(lookup, key), ...fields })
}
