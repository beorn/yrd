/** One-time conversion of a legacy change's resting reading into event inputs (25041). */
import { Conflict, offTheTarget, openEvents, type EventInput, type Git } from "./git.ts"
import {
  adoptedInput,
  changeInput,
  changesRef,
  eventPause,
  project,
  queueRef,
  readEventQueue,
  type QueueLocation,
} from "./events.ts"
import { readChange, tipOf, type ChangeReading, type ChangeRecords } from "./state.ts"
import {
  changeOf,
  endedKind,
  endingRecord,
  recordFromMeta,
  recordsFromHistory,
  trailer,
  type ChangeRecord,
} from "./legacy-records.ts"
import { changeRef, parseChangeRef, queueRefPrefix } from "./refs.ts"
import type { QueueRead } from "./remote.ts"

export type LegacyMigrationChange = Readonly<{ ref: string; change: ChangeRecords; reading: ChangeReading }>

/** Keep the exact list's tip reading while hydrating records for source retention. */
export function sourcesForMigration(
  queue: string,
  captured: QueueRead,
  hydrated: QueueRead,
): readonly LegacyMigrationChange[] {
  const listed = new Map(captured.map((entry) => [changeRef(queue, entry.change), entry]))
  if (listed.size !== captured.length || hydrated.length !== captured.length) {
    throw new Error(`${queue}: captured and hydrated legacy change counts differ`)
  }
  const sources = hydrated.map((entry) => {
    const ref = changeRef(queue, entry.change)
    const selected = listed.get(ref)
    if (selected === undefined || tipOf(selected.change).sha !== tipOf(entry.change).sha) {
      throw new Error(`${ref}: hydrated record tip differs from the captured list reading`)
    }
    listed.delete(ref)
    return { ref, change: entry.change, reading: selected.reading }
  })
  if (listed.size !== 0) throw new Error(`${queue}: hydrated histories omitted ${[...listed.keys()].join(", ")}`)
  return sources
}

/** The only word table shared by conversion and old-row parity. */
export function migratedStatus(reading: ChangeReading): "queued" | "merged" | "failed" | "stuck" | "cancelled" {
  // A later branch head can add a superseded reason to a head that already
  // merged. The recorded ending still wins for that head.
  if (reading.state === "merged") return "merged"
  if (reading.reason === "superseded" || reading.reason === "replaced") return "cancelled"
  switch (reading.state) {
    case "queued":
    case "checked":
    case "deferred":
      return "queued"
    case "failed":
    case "stuck":
      return reading.state
    case "withdrawn":
      return "cancelled"
  }
}

function required(record: ChangeRecord, key: string, ref: string): string {
  const value = trailer(record, key)
  if (value === undefined || value.trim() === "") {
    throw new Error(`${ref}@${record.sha}: legacy ${record.kind} record needs ${key}: for event migration`)
  }
  return value
}

function sourceProps(ref: string, records: readonly ChangeRecord[]): readonly (readonly [string, string])[] {
  return records.map((record) => ["Migrated-From", `${ref}@${record.sha}`] as const)
}

function absorb(input: EventInput, ref: string, records: readonly ChangeRecord[]): EventInput {
  return {
    ...input,
    props: [...(input.props ?? []), ...sourceProps(ref, records)],
    keeps: [...new Set([...(input.keeps ?? []), ...records.map((record) => record.sha)])],
  }
}

function cancellationReason(source: LegacyMigrationChange): "resubmitted" | "dropped" | "deleted" | "unrecorded" {
  const reason = source.reading.reason
  if (reason === "superseded" || reason === "replaced") return "resubmitted"
  if (reason === "deleted") return "deleted"
  if (reason === "dropped") return "dropped"
  // Explicit withdrawn records sometimes carry no reason. The old record is
  // kept as a parent and named by Migrated-From, so only this migration path
  // can use the fourth word approved by CTO (2026-09-24).
  return "unrecorded"
}

/**
 * The old ref stays one opened segment. Run-phase records are absorbed into
 * minimal resting-state events; no check result or stage is fabricated.
 */
export function inputsForLegacy(
  source: LegacyMigrationChange,
  queueTip: string,
  atForDerivedEnding?: Date,
): readonly EventInput[] {
  const records = source.change.records
  const tip = tipOf(source.change)
  const head = source.change.head
  const status = migratedStatus(source.reading)
  const last = records.at(-1)
  if (last === undefined || last.sha !== tip.sha) {
    throw new Error(`${source.ref}: captured record chain has no matching tip`)
  }
  const openedAt = new Date(required(tip, "Opened", source.ref))
  if (Number.isNaN(openedAt.getTime())) {
    throw new Error(`${source.ref}@${tip.sha}: Opened: is not a date`)
  }
  const submitter = required(tip, "Submitter", source.ref)
  const issue = trailer(tip, "Issue")
  const terminal = status !== "queued"
  const openingRecords = terminal ? records.slice(0, -1) : records
  const terminalRecords = terminal ? records.slice(-1) : []
  const opened = absorb(
    changeInput("opened", {
      queueTip,
      at: openedAt,
      commit: head,
      by: submitter,
      ...(issue === undefined ? {} : { issue }),
    }),
    source.ref,
    openingRecords,
  )
  if (!terminal) return [opened]
  const stuckRecord = status === "stuck" ? records.findLast((record) => record.kind === "stuck") : undefined
  if (status === "stuck" && stuckRecord === undefined) {
    throw new Error(`${source.ref}@${tip.sha}: stuck reading has no original stuck record`)
  }
  const at = originalEndingRecord(records)?.at ?? stuckRecord?.at ?? atForDerivedEnding ?? tip.at
  let ending: EventInput
  if (status === "merged") {
    const merge = records.map((record) => trailer(record, "Merge")).findLast((value) => value !== undefined) ?? head
    ending = changeInput("merged", {
      queueTip,
      at,
      commit: merge,
      ...(merge === head ? {} : { reason: `observed on target at ${merge}` }),
    })
  } else if (status === "failed") {
    ending = changeInput("failed", {
      queueTip,
      at,
      ...(source.reading.reason === undefined ? {} : { reason: source.reading.reason }),
    })
  } else if (status === "stuck") {
    ending = changeInput("stuck", { queueTip, at, reason: source.reading.reason ?? required(tip, "Code", source.ref) })
  } else {
    ending = changeInput("cancelled", {
      queueTip,
      at,
      commit: head,
      reason: cancellationReason(source),
    })
  }
  return [opened, absorb(ending, source.ref, terminalRecords)]
}

export type LegacyAdoptionRow = Readonly<{
  branch: string
  ref: string
  record: string
  head: string
  branchHead: string | null
  branchObservedAt: Date
  opened: Date
  oldStatus: "queued" | "stuck" | "merged" | "failed" | "cancelled"
  plannedStatus: "queued" | "stuck" | "merged" | "failed" | "cancelled"
  /** Absent for an open chainless conversion. */
  ending?: "merged" | "failed" | "cancelled"
  targetChainTip: string | null
  /** Full old chain, retained as event parents on apply. */
  source: LegacyMigrationChange
}>

export type LegacyAdoptionPlan = Readonly<{
  queue: string
  target: string
  queueTip: string
  rows: readonly LegacyAdoptionRow[]
}>

export type LegacyAdoptionReceipt =
  | Readonly<{
      result: "adopted"
      branch: string
      oldRef: string
      oldOid: string
      eventOid: string
      branchFact: string
    }>
  | Readonly<{
      result: "refused"
      branch: string
      oldRef: string
      oldOid: string
      ref: string
      expected: string | null
      observed: string | null
      branchFact: string
      error?: string
    }>

function adoptionBranchFact(branch: string, head: string | null, observedAt: Date): string {
  const ref = `refs/heads/${branch}`
  return head === null ? `${ref} absent at ${observedAt.toISOString()}, not leasable` : `${ref} at ${head}, leased`
}

function plannedAdoptionStatus(
  oldStatus: LegacyAdoptionRow["oldStatus"],
  targetChainTip: string | null,
  actualEnding: ChangeRecord | undefined,
): LegacyAdoptionRow["plannedStatus"] {
  if (targetChainTip === null) return oldStatus
  if (actualEnding?.kind === "merged") return "merged"
  if (actualEnding?.kind === "failed") return "failed"
  if (actualEnding?.kind === "withdrawn") return "cancelled"
  if (oldStatus === "queued" || oldStatus === "stuck") return "cancelled"
  return oldStatus
}

function withCurrentBranch(
  row: LegacyAdoptionRow,
  branchHead: string | null,
  branchObservedAt: Date,
): LegacyAdoptionRow {
  const change: ChangeRecords = { ...row.source.change, branchHead: branchHead ?? undefined }
  const source = { ...row.source, change, reading: readChange(change) }
  const oldStatus = migratedStatus(source.reading)
  const actualEnding = originalEndingRecord(change.records)
  if ((oldStatus === "merged" || oldStatus === "failed") && actualEnding === undefined) {
    throw new Error(
      `${row.ref}@${row.record}: ${oldStatus} reading has no historical ending record; adoption cannot invent its ending time`,
    )
  }
  if (oldStatus === "merged" && (actualEnding === undefined || trailer(actualEnding, "Merge") === undefined)) {
    throw new Error(`${row.ref}@${row.record}: merged adoption needs the original Merge: evidence`)
  }
  const plannedStatus = plannedAdoptionStatus(oldStatus, row.targetChainTip, actualEnding)
  return {
    ...row,
    branchHead,
    branchObservedAt,
    oldStatus,
    plannedStatus,
    ending: plannedStatus === "queued" || plannedStatus === "stuck" ? undefined : plannedStatus,
    source,
  }
}

/** Read only old Record refs in the mixed queue namespace; this is a dry run. */
export async function inspectLegacyAdoption(
  input: Readonly<{
    store: QueueLocation
    git: Git
    queue: string
    target: string
  }>,
): Promise<LegacyAdoptionPlan> {
  const { store, git, queue, target } = input
  const backend = store.backend
  if (backend.listRefs === undefined || backend.fetchRefs === undefined || backend.readHistory === undefined) {
    throw new Error("old Record adoption needs Gitomic listRefs, fetchRefs and readHistory")
  }
  const targetRef = `refs/heads/${queue}`
  const remoteTarget = (await backend.listRefs(store.repo, targetRef, store.remote)).get(targetRef)
  if (remoteTarget !== target) {
    throw new Error(`${store.remote} ${targetRef}: adoption target moved from ${target} to ${remoteTarget ?? "absent"}`)
  }
  const fetchedTarget = (await backend.fetchRefs(store.repo, [targetRef], store.remote)).get(targetRef)
  if (fetchedTarget !== target) {
    throw new Error(
      `${store.remote} ${targetRef}: adoption target moved during fetch from ${target} to ${fetchedTarget ?? "absent"}`,
    )
  }
  const queueTip = (await readEventQueue(store, queue)).tip
  const prefix = `${queueRefPrefix(queue)}/`
  const names = await backend.listRefs(store.repo, prefix, store.remote)
  const candidates = [...names].flatMap(([ref, record]) => {
    if (ref === queueRef(queue) || ref === `${prefix}pause` || ref === `${prefix}override`) {
      return []
    }
    const change = parseChangeRef(queue, ref)
    if (change === undefined && ref.startsWith(`${prefix}changes/`)) return []
    if (change === undefined || change.branch === queue) {
      throw new Error(`${store.remote} ${ref}: unrecognized old Record ref under ${prefix}`)
    }
    return [{ ref, record, change }]
  })
  if (candidates.length === 0) return { queue, target, queueTip, rows: [] }
  const fetched = await backend.fetchRefs(
    store.repo,
    candidates.map(({ ref }) => ref),
    store.remote,
  )
  for (const entry of candidates) {
    if (fetched.get(entry.ref) !== entry.record) {
      throw new Error(`${store.remote} ${entry.ref}: old Record ref moved during adoption plan`)
    }
  }
  const history = await backend.readHistory(
    store.repo,
    candidates.map(({ record }) => record),
  )
  const byOid = new Map(history.map((meta) => [meta.oid, meta] as const))
  const old = [] as typeof candidates
  for (const candidate of candidates) {
    if (!candidate.ref.startsWith(`${prefix}changes/`)) {
      old.push(candidate)
      continue
    }
    const tip = byOid.get(candidate.record)
    if (tip === undefined) throw new Error(`${store.remote} ${candidate.ref}: fetched ref has no commit history`)
    if (recordFromMeta(tip) !== undefined) {
      old.push(candidate)
      continue
    }
    const chain = await openEvents({ ...store, ref: candidate.ref })
    project(await chain.events({ limit: 1024 }), candidate.ref, store.repo)
  }
  if (old.length === 0) return { queue, target, queueTip, rows: [] }
  const branchRefs = await backend.listRefs(store.repo, "refs/heads/", store.remote)
  const branchNames = [...new Set(old.map(({ change }) => `refs/heads/${change.branch}`))]
  const branchObservedAt = new Date()
  const presentBranchNames = branchNames.filter((ref) => branchRefs.has(ref))
  const fetchedBranches =
    presentBranchNames.length === 0
      ? new Map<string, string>()
      : await backend.fetchRefs(store.repo, presentBranchNames, store.remote)
  const offTarget = await offTheTarget(
    git,
    old.map(({ change }) => change.head),
    target,
  )
  const rows: LegacyAdoptionRow[] = []
  for (const entry of old) {
    const records = await recordsFromHistory(git, history, entry.record)
    const tip = records.at(-1)
    if (
      tip === undefined ||
      tip.sha !== entry.record ||
      changeOf(tip, entry.ref) !== `${entry.change.branch}@${entry.change.head}`
    ) {
      throw new Error(`${entry.ref}@${entry.record}: Record history does not match its ref`)
    }
    const first = records[0]
    if (first === undefined) throw new Error(`${entry.ref}@${entry.record}: Record history is empty`)
    const branchRef = `refs/heads/${entry.change.branch}`
    const branchHead = branchRefs.get(branchRef) ?? null
    if (branchHead !== null && fetchedBranches.get(branchRef) !== branchHead) {
      throw new Error(`${store.remote} ${branchRef}: branch moved during adoption plan`)
    }
    const change: ChangeRecords = {
      branch: entry.change.branch,
      head: entry.change.head,
      headOnTarget: !offTarget.has(entry.change.head),
      records: [first, ...records.slice(1)],
      branchHead: branchHead ?? undefined,
    }
    const source = { ref: entry.ref, change, reading: readChange(change) }
    const opened = new Date(required(tip, "Opened", entry.ref))
    if (Number.isNaN(opened.getTime())) throw new Error(`${entry.ref}@${entry.record}: Opened: is not a date`)
    const chain = await openEvents({ ...store, ref: changesRef(queue, entry.change.branch) })
    const targetChainTip = await chain.head()
    if (targetChainTip !== null) {
      project(await chain.events({ limit: 1024 }), changesRef(queue, entry.change.branch), store.repo)
    }
    const oldStatus = migratedStatus(source.reading)
    const actualEnding = originalEndingRecord(change.records)
    if ((oldStatus === "merged" || oldStatus === "failed") && actualEnding === undefined) {
      throw new Error(
        `${entry.ref}@${entry.record}: ${oldStatus} reading has no historical ending record; adoption cannot invent its ending time`,
      )
    }
    if (oldStatus === "merged" && (actualEnding === undefined || trailer(actualEnding, "Merge") === undefined)) {
      throw new Error(`${entry.ref}@${entry.record}: merged adoption needs the original Merge: evidence`)
    }
    const plannedStatus = plannedAdoptionStatus(oldStatus, targetChainTip, actualEnding)
    rows.push({
      branch: entry.change.branch,
      ref: entry.ref,
      record: entry.record,
      head: entry.change.head,
      branchHead,
      branchObservedAt,
      opened,
      oldStatus,
      plannedStatus,
      ...(plannedStatus === "queued" || plannedStatus === "stuck" ? {} : { ending: plannedStatus }),
      targetChainTip,
      source,
    })
  }
  return { queue, target, queueTip, rows }
}

/** Keep one source's old record chain and delete its ref in the same Gitomic MULTI. */
export async function adoptLegacy(
  input: Readonly<{
    store: QueueLocation
    plan: LegacyAdoptionPlan
    at: Date
  }>,
): Promise<readonly LegacyAdoptionReceipt[]> {
  const { store, plan, at } = input
  if (Number.isNaN(at.getTime())) throw new TypeError("adoption publication time is not a date")
  const queueState = await readEventQueue(store, plan.queue)
  // eventPause reads Ops: pause after the ops cut-over, where every paused event now lands (25845).
  if (eventPause(queueState) === undefined) {
    throw new Error(`${store.remote}#${plan.queue}: adoption apply requires a paused event queue`)
  }
  const rows: LegacyAdoptionReceipt[] = []
  const backend = store.backend
  if (backend.listRefs === undefined) throw new Error("old Record adoption needs Gitomic listRefs for lease readback")
  const targetRef = `refs/heads/${plan.queue}`
  const queueHeadRef = queueRef(plan.queue)
  for (const row of plan.rows) {
    const branchRef = `refs/heads/${row.branch}`
    let currentBranchHead: string | null
    let branchObservedAt: Date
    try {
      currentBranchHead = (await backend.listRefs(store.repo, branchRef, store.remote)).get(branchRef) ?? null
      branchObservedAt = new Date()
    } catch (error) {
      rows.push({
        result: "refused",
        branch: row.branch,
        oldRef: row.ref,
        oldOid: row.record,
        ref: branchRef,
        expected: row.branchHead,
        observed: null,
        branchFact: adoptionBranchFact(row.branch, row.branchHead, row.branchObservedAt),
        error: `could not read ${store.remote} ${branchRef}: ${String(error)}`,
      })
      continue
    }
    const branchFact = adoptionBranchFact(row.branch, currentBranchHead, branchObservedAt)
    if (row.branchHead !== null && currentBranchHead !== row.branchHead) {
      rows.push({
        result: "refused",
        branch: row.branch,
        oldRef: row.ref,
        oldOid: row.record,
        ref: branchRef,
        expected: row.branchHead,
        observed: currentBranchHead,
        branchFact,
      })
      continue
    }
    if (row.branchHead === null && currentBranchHead !== null) {
      if (backend.fetchRefs === undefined) {
        throw new Error("old Record adoption needs Gitomic fetchRefs for a newly present branch")
      }
      let fetchedHead: string | null
      try {
        fetchedHead = (await backend.fetchRefs(store.repo, [branchRef], store.remote)).get(branchRef) ?? null
      } catch (error) {
        rows.push({
          result: "refused",
          branch: row.branch,
          oldRef: row.ref,
          oldOid: row.record,
          ref: branchRef,
          expected: currentBranchHead,
          observed: null,
          branchFact,
          error: `could not fetch ${store.remote} ${branchRef}: ${String(error)}`,
        })
        continue
      }
      if (fetchedHead !== currentBranchHead) {
        rows.push({
          result: "refused",
          branch: row.branch,
          oldRef: row.ref,
          oldOid: row.record,
          ref: branchRef,
          expected: currentBranchHead,
          observed: fetchedHead,
          branchFact,
        })
        continue
      }
    }
    let currentRow: LegacyAdoptionRow
    try {
      currentRow = withCurrentBranch(row, currentBranchHead, branchObservedAt)
    } catch (error) {
      rows.push({
        result: "refused",
        branch: row.branch,
        oldRef: row.ref,
        oldOid: row.record,
        ref: branchRef,
        expected: row.branchHead,
        observed: currentBranchHead,
        branchFact,
        error: String(error),
      })
      continue
    }
    const changeChainRef = changesRef(plan.queue, row.branch)
    const chain = await openEvents({ ...store, ref: changeChainRef, writer: "yrd-adopter" })
    const currentTip = await chain.head()
    if (currentTip !== row.targetChainTip) {
      rows.push({
        result: "refused",
        branch: row.branch,
        oldRef: row.ref,
        oldOid: row.record,
        ref: changeChainRef,
        expected: row.targetChainTip,
        observed: currentTip,
        branchFact,
      })
      continue
    }
    const inputs =
      currentTip === null
        ? inputsForLegacy(currentRow.source, plan.queueTip, at)
        : [inputForExistingChain(currentRow, plan.queueTip, at, branchFact)]
    const recordedInputs =
      currentTip === null
        ? inputs.map((event) => ({ ...event, props: [...(event.props ?? []), ["Branch", branchFact] as const] }))
        : inputs
    try {
      const staged = await chain.stage(recordedInputs, { expect: currentTip })
      const result = await staged.publish({
        also: [
          { ref: row.ref, expect: row.record, oid: null },
          { ref: queueHeadRef, expect: plan.queueTip, oid: plan.queueTip },
          { ref: targetRef, expect: plan.target, oid: plan.target },
          ...(currentBranchHead === null
            ? []
            : [{ ref: branchRef, expect: currentBranchHead, oid: currentBranchHead }]),
        ],
      })
      if (result.head === null) throw new Error(`${row.ref}: adoption published no event`)
      rows.push({
        result: "adopted",
        branch: row.branch,
        oldRef: row.ref,
        oldOid: row.record,
        eventOid: result.head,
        branchFact,
      })
    } catch (error) {
      if (!(error instanceof Conflict)) throw error
      const expected = new Map<string, string | null>([
        [row.ref, row.record],
        [changeChainRef, row.targetChainTip],
        [queueHeadRef, plan.queueTip],
        [targetRef, plan.target],
        ...(currentBranchHead === null ? [] : [[branchRef, currentBranchHead] as const]),
      ])
      let changed: { ref: string; expected: string | null; observed: string | null } | undefined
      for (const [ref, want] of expected) {
        const observed = (await backend.listRefs(store.repo, ref, store.remote)).get(ref) ?? null
        if (observed !== want) {
          changed = { ref, expected: want, observed }
          break
        }
      }
      if (changed === undefined) {
        throw new Error(
          `${row.ref}: adoption publication conflicted, but every leased ref still has its expected oid; cannot determine which row to retry`,
          {
            cause: error,
          },
        )
      }
      rows.push({ result: "refused", branch: row.branch, oldRef: row.ref, oldOid: row.record, ...changed, branchFact })
    }
  }
  return rows
}

function inputForExistingChain(row: LegacyAdoptionRow, queueTip: string, at: Date, branchFact: string): EventInput {
  const { source } = row
  const records = source.change.records
  const tip = tipOf(source.change)
  const ending = originalEndingRecord(records)
  const status = row.ending
  if (status === undefined) throw new Error(`${row.ref}@${row.record}: existing chain adoption has no ending`)
  const actualEnding = status === "cancelled" && ending === undefined ? at : ending?.at
  if (actualEnding === undefined) {
    throw new Error(`${row.ref}@${row.record}: ${status} has no recorded ending time; adoption cannot invent one`)
  }
  const reason =
    status === "cancelled" ? (ending === undefined ? "resubmitted" : cancellationReason(source)) : source.reading.reason
  const merge = status === "merged" ? trailer(ending as ChangeRecord, "Merge") : undefined
  if (status === "merged" && merge === undefined) {
    throw new Error(`${row.ref}@${row.record}: merged ending has no Merge: evidence`)
  }
  const checks = records.flatMap((record) =>
    record.trailers.filter(([key]) => key === "Check").map(([, value]) => value),
  )
  const last = (key: string) => records.map((record) => trailer(record, key)).findLast((value) => value !== undefined)
  return adoptedInput({
    queueTip,
    at,
    head: source.change.head,
    opened: row.opened,
    status,
    ended: actualEnding,
    ...(reason === undefined ? {} : { reason }),
    submitter: required(tip, "Submitter", row.ref),
    ...(trailer(tip, "Issue") === undefined ? {} : { issue: trailer(tip, "Issue") }),
    ...(merge === undefined ? {} : { merge }),
    ...(last("Base") === undefined ? {} : { base: last("Base") }),
    ...(last("Config") === undefined ? {} : { config: last("Config") }),
    checks,
    sources: records.map((record) => ({ ref: row.ref, oid: record.sha })),
    branchFact,
  })
}

/** A sent notification repeats an ending, but its timestamp is not when that ending happened. */
export function originalEndingRecord(records: readonly ChangeRecord[]): ChangeRecord | undefined {
  const standing = endingRecord(records)
  if (standing === undefined || standing.kind !== "sent") return standing
  const kind = endedKind(standing)
  for (let index = records.lastIndexOf(standing) - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record === undefined || record.kind === "opened") break
    if (record.kind === kind) return record
  }
  throw new Error(`sent record ${standing.sha} repeats ${kind} but its original ending record is absent`)
}
