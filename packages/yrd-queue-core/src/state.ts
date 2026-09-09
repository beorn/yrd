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
 * **Ancestry wins over any record — for a change with no failed ending.** A
 * change whose head is on the target reads merged even when no merged record
 * was ever written — a direct merge in the garage still shows as merged, and a
 * queue run never re-checks content the target already carries. Measured
 * 2026-09-02: a run merged a head under one branch name, then checked a second
 * name at the identical head against the main it had just moved, failed it on
 * a check, and billed the submitter for content it had itself just merged.
 * Reading ancestry first is what makes that impossible.
 *
 * **A head whose own last ending was failed is the one exception.** Ancestry
 * alone never promotes THAT head to merged: it reads `failed`, and
 * `superseded` naming the branch's later head, when that later head is what
 * actually reached the target. Bare reachability through somebody else's
 * merge is not this head's own merge — the garage case above is about the
 * SAME head merged by hand with no record at all, never about resurrecting a
 * head whose story already ended failed. Measured 2026-09-09: a run merged
 * `task/cto-24366-head-check` at a later head, and the queue also announced
 * two of that branch's own earlier FAILED heads as "merged as <their own
 * sha>" — each a bare ancestry echo, not a merge anybody made
 * (@i/10-yrd/24098).
 */

import { endedKind, type ChangeRecord } from "./records.ts"
import { incidentFrom } from "./incident.ts"

export const CHANGE_STATES = ["queued", "checked", "stuck", "merged", "failed"] as const

export type ChangeState = (typeof CHANGE_STATES)[number]

export type ChangeReading = Readonly<{
  state: ChangeState
  /** Why, when the state has a reason: `replaced`, `deleted`, `superseded`, or a check's code. */
  reason?: string
  /**
   * The branch's current head, named only on a `superseded` reading: the
   * later head of this same branch that reached the target and, by ancestry
   * alone, made this failed head's own commit reachable too (@i/10-yrd/24098).
   */
  supersededBy?: string
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
 * `at(-1)` is `ChangeRecord | undefined` for any tuple, while the tuple's first
 * element is a `ChangeRecord` outright, and on a change with one record they
 * are the same record.
 */
export function tipOf(change: ChangeRecords): ChangeRecord {
  return change.records.at(-1) ?? change.records[0]
}

/** Read one change's state. Pure: every input is a record or a git reading. */
export function readChange(change: ChangeRecords): ChangeReading {
  const last = tipOf(change)

  // This head's own last ending was failed, the branch has since moved on to
  // a different head, and ancestry reaches the target only through that: the
  // merge is the LATER head's, not this one's, so ancestry does not promote
  // it here. Every other case — no failed ending yet, or the same head merged
  // by hand with no record at all — falls through to ancestry-first below
  // exactly as it reads today; this is the one carve-out, and it only fires
  // once the branch has actually moved on AND reached the target
  // (@i/10-yrd/24098).
  if (
    change.headOnTarget &&
    change.branchHead !== undefined &&
    change.branchHead !== change.head &&
    endedKind(last) === "failed"
  ) {
    return { state: "failed", reason: "superseded", supersededBy: change.branchHead }
  }

  // Ancestry first, and before anything else the records say. A change merged
  // BY HAND with no record at all — the garage case — still reads merged
  // here even though its last ending (if any) was never failed.
  if (change.headOnTarget) return { state: "merged" }

  // The submitter's own doing, and neither carries a message.
  if (change.branchHead === undefined) return { state: "failed", reason: "deleted" }
  if (change.branchHead !== change.head) return { state: "failed", reason: "replaced" }

  switch (last.kind) {
    case "merged":
      return { state: "merged" }
    case "failed":
      return { state: "failed", reason: reasonOf(last) }
    case "stuck":
      return { state: "stuck", reason: incidentFrom(last).code }
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
      if (state === "stuck") return { state: "stuck", reason: incidentFrom(last).code }
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
 * unrelated-history, replaced, deleted). A stuck record has
 * the complete incident shape instead, and its code is read above.
 */
function reasonOf(record: ChangeRecord): string | undefined {
  return record.trailers.find(([name]) => name === "Reason")?.[1]
}

/**
 * Who acts next, and why: one derivation, here, beside the state it reads.
 *
 * A notice that says what a change IS without saying whose move it is leaves
 * every reader to guess, and two surfaces guessing differently is the
 * ready-vs-queued bug in another costume. So this lives next to
 * {@link readChange} and takes its reading, never a word rendered from it.
 *
 * The rule, in full: a change the queue still owes work to — queued or checked
 * — is the queue's; a failed one is the submitter's, because only the branch's
 * author can move it; a merged one is nobody's; a stuck one is the queue
 * OPERATOR's, because stuck is the queue's own statement that it could not
 * judge. The stuck record does not yet name a person (M7.5 owns that field),
 * so until it does this points at the evidence — the run journal — rather than
 * inventing an owner.
 */
export type NextOwner = Readonly<{
  /** Who moves it next, in words a reader can act on. */
  owner: string
  /** Why it is theirs. */
  because: string
}>

export function nextOwner(
  reading: ChangeReading,
  about: Readonly<{ submitter?: string; journal?: string }> = {},
): NextOwner | undefined {
  switch (reading.state) {
    case "merged":
      return undefined
    case "queued":
      return { because: "it starts when the queue reaches it", owner: "the queue" }
    case "checked":
      return { because: "its checks passed; it merges when the queue reaches it", owner: "the queue" }
    case "failed":
      return {
        because: `it failed${reading.reason === undefined ? "" : ` (${reading.reason})`}, and only the branch's author can move it`,
        owner: about.submitter ?? "the submitter",
      }
    case "stuck":
      return {
        because: `the queue could not judge it${reading.reason === undefined ? "" : ` (${reading.reason})`}; no record names a person yet, so the evidence is ${about.journal ?? "the run journal, which was not read"}`,
        owner: "the queue's operator",
      }
  }
}
