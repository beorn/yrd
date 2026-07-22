import type {
  InstalledStep,
  PRSnapshot,
  QueueAuthorityState,
  QueueProjectionIndex,
  QueueProjectionLookup,
  QueueProjectionPlan,
  QueueRecord,
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

export function queueLookupKey(snapshot: Readonly<PRSnapshot>, steps: readonly Readonly<InstalledStep>[]): string {
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
  snapshot: Readonly<PRSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): RunId | undefined {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.latestExact
}

export function latestPrefixRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<PRSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): RunId | undefined {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.latestPrefix
}

export function latestRootRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<PRSnapshot>,
): RunId | undefined {
  return projectionLookupGet(index.rootsByMember, queueMemberKey(snapshot))
}

export function releasedAdmissionFailures(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<PRSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): number {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.releasedAdmissionFailures ?? 0
}

export function activeQueueRootIds(authority: Readonly<QueueAuthorityState>): readonly RunId[] {
  const roots = new Set<RunId>()
  for (const token of Object.values(authority.claims)) {
    if (token.consumedBy !== undefined) roots.add(token.consumedBy)
  }
  return [...roots].toSorted(compareRunIds)
}

function childKey(parent: RunId, part: 0 | 1): string {
  return `${parent}\0${part}`
}

function queueMemberKey(snapshot: Readonly<PRSnapshot>): string {
  return JSON.stringify([snapshot.id, snapshot.revision, snapshot.headSha])
}

function lookupSnapshots(snapshot: Readonly<PRSnapshot>): readonly Readonly<PRSnapshot>[] {
  return snapshot.baseSha === undefined ? [snapshot] : [snapshot, { ...snapshot, baseSha: undefined }]
}

function compareRunIds(left: RunId, right: RunId): number {
  return left.localeCompare(right, undefined, { numeric: true })
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
