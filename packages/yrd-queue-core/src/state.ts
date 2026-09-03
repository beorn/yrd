/**
 * A change's state, derived and never stored
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * Five words, and every one of them is a reading of git plus the change's own
 * records at the moment you ask:
 *
 * - `queued` — an opened record and no checked record after it;
 * - `checked` — a checked record and no ended record after it;
 * - `stuck` — the last record ended with stuck; the change stays open;
 * - `merged` — the head is an ancestor of the target;
 * - `failed` — the last record ended with failed, or the branch no longer carries
 *   this head (`replaced`), or the branch is gone (`deleted`).
 *
 * **Ancestry wins over any record.** A change whose head is on the target reads
 * merged even when no merged record was ever written — a direct merge in the garage
 * still shows as merged, and a queue run never re-checks content the target
 * already carries. Measured 2026-09-02: a run merged a head under one branch
 * name, then checked a second name at the identical head against the main it
 * had just moved, failed it on a check, and billed the submitter for content it
 * had itself just landed. Reading ancestry first is what makes that impossible.
 */

import type { ChangeRecord } from "./records.ts"

export const CHANGE_STATES = ["queued", "checked", "stuck", "merged", "failed"] as const

export type ChangeState = (typeof CHANGE_STATES)[number]

export type ChangeReading = Readonly<{
  state: ChangeState
  /** Why, when the state has a reason: `replaced`, `deleted`, or a check's code. */
  reason?: string
}>

export type ChangeRecords = Readonly<{
  /** The change's own branch. Never the target: that one is `QueueRunOptions.target`. */
  branch: string
  /**
   * The change's records, oldest first, or only its tip: every reading here uses
   * the last one, whose trailers are the whole derived state. Never empty, and
   * the type says so: a change exists only when submitted, and the submit is
   * its first record (E2). Every reader used to ask anyway and invent an answer
   * for a case no constructor can build.
   */
  records: readonly [ChangeRecord, ...ChangeRecord[]]
  /** Whether the head is an ancestor of the target, read from git. */
  headOnTarget: boolean
  /** Where the branch points now, or undefined when the branch is gone. */
  branchHead?: string
  /** The head this change is about. */
  head: string
}>

/**
 * The change's tip: the record whose trailers are the whole derived state.
 *
 * The `??` is what the language costs to say what the type already knows —
 * `at(-1)` is `Record | undefined` for any tuple, while the tuple's first
 * element is a `Record` outright, and on a change with one record they are the
 * same record.
 */
export function tipOf(change: ChangeRecords): ChangeRecord {
  return change.records.at(-1) ?? change.records[0]
}

/** Read one change's state. Pure: every input is a record or a git reading. */
export function readChange(change: ChangeRecords): ChangeReading {
  // Ancestry first, and before anything the records say.
  if (change.headOnTarget) return { state: "merged" }

  // The submitter's own doing, and neither carries a message.
  if (change.branchHead === undefined) return { state: "failed", reason: "deleted" }
  if (change.branchHead !== change.head) return { state: "failed", reason: "replaced" }

  const last = tipOf(change)
  switch (last.kind) {
    case "merged":
      return { state: "merged" }
    case "failed":
      return { state: "failed", reason: reasonOf(last) }
    case "stuck":
      return { state: "stuck", reason: reasonOf(last) }
    case "checked":
      return { state: "checked" }
    case "opened":
      return { state: "queued" }
    case "sent": {
      // A sent record repeats the ended state it followed (`State:`, ruling A2)
      // and carries that record's result, so the tip alone answers.
      const state = last.trailers.find(([name]) => name === "State")?.[1]
      if (state === "merged") return { state: "merged" }
      if (state === "failed") return { state: "failed", reason: reasonOf(last) }
      if (state === "stuck") return { state: "stuck", reason: reasonOf(last) }
      throw new Error(`sent record ${last.sha.slice(0, 12)} names no ended state (State: ${state ?? "absent"})`)
    }
  }
}

/**
 * Position in line: the order of opened records by their commit time
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design). In line are
 * the queued, the checked and the stuck: a stuck change keeps its place and
 * the next queue run takes it again (§ The words). Opened records are the one
 * kind many machines write, so a skewed clock can serve a change before its
 * turn. That is documented, not fixed: the consequence is a change served
 * early, never a wrong result, and a Lamport clock would buy ordering nobody
 * has asked for at the price of a second notion of time.
 */
export function inLine(changes: readonly ChangeRecords[]): readonly ChangeRecords[] {
  return [...changes]
    .filter((change) => {
      const state = readChange(change).state
      return state === "queued" || state === "checked" || state === "stuck"
    })
    .sort((left, right) => openedAt(left) - openedAt(right))
}

/** When the change was first opened, carried on every record as `Opened:`. A change with no records has no place in line, and no existence (E2). */
export function openedAt(change: ChangeRecords): number {
  const last = tipOf(change)
  const opened = last.trailers.find(([name]) => name === "Opened")?.[1]
  const time = opened === undefined ? Number.NaN : Date.parse(opened)
  if (Number.isNaN(time)) {
    throw new Error(`record ${last.sha.slice(0, 12)} carries no readable Opened: (${opened ?? "absent"})`)
  }
  return time
}

/**
 * A failed record's `Reason` (a check's name, conflict, config-invalid,
 * unrelated-history, gitlink-off-main, replaced, deleted) or a stuck record's
 * (a check's name, setup, crash): one key on both, because stuck is always the
 * queue's and needs no second word for it.
 */
function reasonOf(record: ChangeRecord): string | undefined {
  return record.trailers.find(([name]) => name === "Reason")?.[1]
}
