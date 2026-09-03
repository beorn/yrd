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
  /** The change's facts, oldest first. Empty for a branch pushed but never submitted. */
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
  // A branch pushed but never submitted is a change the next queue run opens:
  // it is in line, not invisible. Measured 2026-09-02: two such refs stood at
  // the receiver all day and no reader saw either.
  if (last === undefined) return { state: "queued" }

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
      // A sent fact follows an ended one and says nothing new about the change,
      // so the reading is the ended fact underneath it.
      const ended = [...change.facts].reverse().find((fact) => fact.kind !== "sent")
      return ended === undefined
        ? { state: "queued" }
        : readChange({ ...change, facts: change.facts.slice(0, change.facts.indexOf(ended) + 1) })
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

function openedAt(change: ChangeFacts): number {
  const opened = change.facts.find((fact) => fact.kind === "opened")
  return opened?.at.getTime() ?? Number.MAX_SAFE_INTEGER
}

/** A failed fact's `Reason` (a check's name, conflict, config-invalid, replaced, deleted); a stuck fact's `Reason` (flake, inherited, no-evidence) or its `Cause`. */
function reasonOf(fact: Fact): string | undefined {
  return fact.trailers.find(([name]) => name === "Reason")?.[1] ?? fact.trailers.find(([name]) => name === "Cause")?.[1]
}
