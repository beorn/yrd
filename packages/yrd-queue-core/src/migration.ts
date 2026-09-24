/** One-time conversion of a legacy change's resting reading into event inputs (25041). */
import type { EventInput } from "./git.ts"
import { changeInput } from "./events.ts"
import { tipOf, type ChangeReading, type ChangeRecords } from "./state.ts"
import { trailer, type ChangeRecord } from "./legacy-records.ts"

export type LegacyMigrationChange = Readonly<{ ref: string; change: ChangeRecords; reading: ChangeReading }>

/** The only word table shared by conversion and old-row parity. */
export function migratedStatus(reading: ChangeReading): "queued" | "merged" | "failed" | "stuck" | "cancelled" {
  if (reading.reason === "superseded" || reading.reason === "replaced") return "cancelled"
  switch (reading.state) {
    case "queued":
    case "checked":
    case "deferred":
      return "queued"
    case "merged":
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
export function inputsForLegacy(source: LegacyMigrationChange, queueTip: string): readonly EventInput[] {
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
      at: terminal ? openedAt : tip.at,
      commit: head,
      by: submitter,
      ...(issue === undefined ? {} : { issue }),
    }),
    source.ref,
    openingRecords,
  )
  if (!terminal) return [opened]
  const at = tip.at
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
