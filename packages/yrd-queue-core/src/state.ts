/**
 * A change's state, derived and never stored
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * Five words, and every one of them is a reading of git plus the change's own
 * facts at the moment you ask:
 *
 * - `queued` — an opened fact and no checked fact after it;
 * - `checked` — a checked fact and no ended fact after it;
 * - `stuck` — the last fact ended with stuck; the change stays open;
 * - `merged` — the head is an ancestor of the target;
 * - `failed` — the last fact ended with failed, or the branch no longer carries
 *   this head (`replaced`), or the branch is gone (`deleted`).
 *
 * **Ancestry wins over any fact.** A change whose head is on the target reads
 * merged even when no merged fact was ever written — a hand merge in the garage
 * still shows as merged, and a queue run never re-checks content the target
 * already carries. Measured 2026-09-02: a run merged a head under one branch
 * name, then checked a second name at the identical head against the main it
 * had just moved, failed it on a check, and billed the submitter for content it
 * had itself just landed. Reading ancestry first is what makes that impossible.
 */

import type { Fact } from "./facts.ts"

export const CHANGE_STATES = ["queued", "checked", "stuck", "merged", "failed"] as const

export type ChangeState = (typeof CHANGE_STATES)[number]

export type ChangeReading = Readonly<{
  state: ChangeState
  /** Why, when the state has a reason: `replaced`, `deleted`, or a check's code. */
  reason?: string
}>

export type ChangeFacts = Readonly<{
  /**
   * The change's facts, oldest first, or only its tip: every reading here uses
   * the last one, whose trailers are the whole derived state. Never empty: a
   * change exists only when submitted, and the submit is its first fact (E2).
   */
  facts: readonly Fact[]
  /** Whether the head is an ancestor of the target, read from git. */
  headOnTarget: boolean
  /** Where the branch points now, or undefined when the branch is gone. */
  branchHead?: string
  /** The head this change is about. */
  head: string
}>

/** Read one change's state. Pure: every input is a fact or a git reading. */
export function readChange(change: ChangeFacts): ChangeReading {
  // Ancestry first, and before anything the facts say.
  if (change.headOnTarget) return { state: "merged" }

  // The submitter's own doing, and neither carries a message.
  if (change.branchHead === undefined) return { state: "failed", reason: "deleted" }
  if (change.branchHead !== change.head) return { state: "failed", reason: "replaced" }

  const last = change.facts.at(-1)
  // A change exists only when submitted (E2): the lane lists change refs and
  // nothing else, and every change ref ends in a fact. Nothing without facts
  // can reach here, and a reading of one would be a state made up on the spot.
  if (last === undefined) {
    throw new Error(`${change.head.slice(0, 12)} has no facts; a change exists only when submitted`)
  }

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
      // A sent fact repeats the ended state it followed (`State:`, ruling A2)
      // and carries that fact's result, so the tip alone answers.
      const state = last.trailers.find(([name]) => name === "State")?.[1]
      if (state === "merged") return { state: "merged" }
      if (state === "failed") return { state: "failed", reason: reasonOf(last) }
      if (state === "stuck") return { state: "stuck", reason: reasonOf(last) }
      throw new Error(`sent fact ${last.sha.slice(0, 12)} names no ended state (State: ${state ?? "absent"})`)
    }
  }
}

/**
 * Position in line: the order of opened facts by their commit time
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design). In line are
 * the queued, the checked and the stuck: a stuck change keeps its place and
 * the next queue run takes it again (§ The words). Opened facts are the one
 * kind many machines write, so a skewed clock can serve a change before its
 * turn. That is documented, not fixed: the consequence is a change served
 * early, never a wrong result, and a Lamport clock would buy ordering nobody
 * has asked for at the price of a second notion of time.
 */
export function inLine(changes: readonly ChangeFacts[]): readonly ChangeFacts[] {
  return [...changes]
    .filter((change) => {
      const state = readChange(change).state
      return state === "queued" || state === "checked" || state === "stuck"
    })
    .sort((left, right) => openedAt(left) - openedAt(right))
}

/** When the change was first opened, carried on every fact as `Opened:`. A change with no facts has no place in line, and no existence (E2). */
export function openedAt(change: ChangeFacts): number {
  const last = change.facts.at(-1)
  if (last === undefined) {
    throw new Error(`${change.head.slice(0, 12)} has no facts; a change exists only when submitted`)
  }
  const opened = last.trailers.find(([name]) => name === "Opened")?.[1]
  const time = opened === undefined ? Number.NaN : Date.parse(opened)
  if (Number.isNaN(time)) throw new Error(`fact ${last.sha.slice(0, 12)} carries no readable Opened: (${opened ?? "absent"})`)
  return time
}

/** A failed fact's `Reason` (a check's name, conflict, config-invalid, replaced, deleted); a stuck fact's `Reason` (flake, inherited, no-evidence) or its `Cause`. */
function reasonOf(fact: Fact): string | undefined {
  return fact.trailers.find(([name]) => name === "Reason")?.[1] ?? fact.trailers.find(([name]) => name === "Cause")?.[1]
}
