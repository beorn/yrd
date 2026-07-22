import type {
  InstalledStep,
  PRSnapshot,
  QueueAuthorityState,
  QueueProjectionIndex,
  QueueProjectionLookup,
  QueueProjectionPlan,
  QueueRecord,
  QueueRunId,
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
    plans: {},
  }
}

export function queueLookupKey(snapshot: Readonly<PRSnapshot>, steps: readonly Readonly<InstalledStep>[]): string {
  return JSON.stringify([
    [snapshot.id, snapshot.revision, snapshot.headSha, snapshot.base, snapshot.baseSha ?? null],
    steps.map((step) => [
      step.name,
      step.revision,
      step.integrates,
      step.needsIntegration,
      step.classification ?? null,
    ]),
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
  const snapshot = record.prs.length === 1 ? record.prs[0] : undefined
  if (snapshot === undefined) return { ...index, nextRunNumber, childByParentPart }

  const exactKey = queueLookupKey(snapshot, record.steps)
  const exact = projectionLookupGet(index.plans, exactKey)
  let plans = updatePlan(index.plans, exactKey, {
    latestExact: latestRunId(exact?.latestExact, record.id),
  })
  for (let length = 1; length <= record.steps.length; length += 1) {
    const key = queueLookupKey(snapshot, record.steps.slice(0, length))
    const prefix = projectionLookupGet(plans, key)
    plans = updatePlan(plans, key, {
      latestPrefix: latestRunId(prefix?.latestPrefix, record.id),
    })
  }
  return { ...index, nextRunNumber, childByParentPart, plans }
}

export function recordReleasedAdmissionFailure(
  index: Readonly<QueueProjectionIndex>,
  record: Readonly<QueueRecord>,
): QueueProjectionIndex {
  const snapshot =
    record.stepSelection?.authority === "admission" && record.prs.length === 1 ? record.prs[0] : undefined
  if (snapshot === undefined) return index
  const key = queueLookupKey(snapshot, record.steps)
  return {
    ...index,
    plans: updatePlan(index.plans, key, {
      releasedAdmissionFailures: (projectionLookupGet(index.plans, key)?.releasedAdmissionFailures ?? 0) + 1,
    }),
  }
}

export function childRunId(
  index: Readonly<QueueProjectionIndex>,
  parent: QueueRunId,
  part: 0 | 1,
): QueueRunId | undefined {
  return projectionLookupGet(index.childByParentPart, childKey(parent, part))
}

export function latestExactRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<PRSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): QueueRunId | undefined {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.latestExact
}

export function latestPrefixRunId(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<PRSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): QueueRunId | undefined {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.latestPrefix
}

export function releasedAdmissionFailures(
  index: Readonly<QueueProjectionIndex>,
  snapshot: Readonly<PRSnapshot>,
  steps: readonly Readonly<InstalledStep>[],
): number {
  return projectionLookupGet(index.plans, queueLookupKey(snapshot, steps))?.releasedAdmissionFailures ?? 0
}

export function activeQueueRootIds(authority: Readonly<QueueAuthorityState>): readonly QueueRunId[] {
  const roots = new Set<QueueRunId>()
  for (const token of Object.values(authority.claims)) {
    if (token.consumedBy !== undefined) roots.add(token.consumedBy)
  }
  return [...roots].toSorted(compareRunIds)
}

function childKey(parent: QueueRunId, part: 0 | 1): string {
  return `${parent}\0${part}`
}

function compareRunIds(left: QueueRunId, right: QueueRunId): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function latestRunId(current: QueueRunId | undefined, candidate: QueueRunId): QueueRunId {
  return current === undefined || compareRunIds(current, candidate) < 0 ? candidate : current
}

function updatePlan(
  lookup: Readonly<QueueProjectionLookup<QueueProjectionPlan>>,
  key: string,
  fields: Readonly<QueueProjectionPlan>,
): QueueProjectionLookup<QueueProjectionPlan> {
  return projectionLookupSet(lookup, key, { ...projectionLookupGet(lookup, key), ...fields })
}
