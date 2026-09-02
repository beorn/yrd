import { changeAdmission, changeDeliveryState, changeNeedsAuthor, type Change } from "@yrd/bay"
import { canonicalRefusalCode } from "@yrd/queue"
import { failureDisposition } from "./status-presentation.ts"

/**
 * The five states a change is in, and the only words the status surface prints
 * for one (`pm/@i/10-yrd/plan.md` § The words). Every one is DERIVED here from
 * facts the queue already records; nothing stores a state.
 *
 * The taxonomy this replaces on the surface — `env`, `job-lost`,
 * `admission-only`, `infra-retry`, `stale-pr` and their siblings — printed one
 * word (`submitted`) both for a change the queue could not carry and for a
 * change a check judged, so an operator could not tell whose fault a stopped
 * change was. The two now read differently: `stuck` is the queue's, `failed`
 * is the submitter's.
 */
export type DerivedChangeState = "queued" | "checked" | "stuck" | "merged" | "failed"

export type DerivedChangeStateReading = Readonly<{
  state: DerivedChangeState
  /** The check that judged the content. Present on `failed` whenever the
   * record names one; a `failed` with no named check is a reason the submitter
   * caused without a check running (a deleted or replaced branch). */
  check?: string
  /** Printed beside the state: whose it is to fix. */
  owner: "the queue's" | "the submitter's" | ""
  /** The code the reading was derived from, when the record carries one. This
   * is the retired taxonomy's own value, kept for `--json` readers through one
   * flag-day cycle. */
  code?: string
}>

/** What the caller already holds about the change, beyond its own record. */
export type DerivedChangeStateFacts = Readonly<{
  /** A merge proven against the target — `reconcileChangeMerges`' answer —
   * which outranks a record claiming the change was taken back. */
  merged?: boolean
  /** The last result the queue recorded for this change, when the caller holds
   * the run and the check it ran. */
  result?: Readonly<{ code?: string; check?: string }>
  /** Why the change cannot proceed, as the queue's own eligibility says. Read
   * only once the change has ended: on a live change it names a wait, never a
   * result. */
  reason?: Readonly<{ code?: string }>
}>

const QUEUES_OWN = "the queue's" as const
const SUBMITTERS_OWN = "the submitter's" as const

/**
 * The submitter ended it themselves: the branch is gone, or points elsewhere.
 * The plan ends both `failed`, with the reason in place of a check, since no
 * check judged anything and nobody is owed a message.
 */
const SUBMITTER_ENDED: Readonly<Record<string, string>> = {
  withdrawn: "deleted",
  canceled: "replaced",
}

/**
 * One reading per change, for every surface that prints a state. The rules, in
 * the order they fire:
 *
 * - `merged` — the head is on the target: the record says merged, or a live
 *   ancestry proof says so over a record that disagrees.
 * - `failed` — it ended and the submitter's own act or content ended it: a
 *   recorded code whose disposition is the author's, or a branch the submitter
 *   deleted or replaced. The check that judged it is named.
 * - `stuck` — it ended and the queue could not do its job: a recorded code
 *   whose disposition is the queue's, and every ending the queue cannot
 *   attribute. Unattributed is stuck by rule, never failed — a check is the
 *   submitter's only once it failed in the change's own worktree and passed at
 *   the target, so an ending carrying no such proof is the queue's.
 * - `checked` — its on-submit checks passed and it waits its turn.
 * - `queued` — still live: submitted, on-submit checks not yet passed. A
 *   record pushed but never submitted reads `queued` too, carrying
 *   `not-submitted` as its code; it is the one shape the five words cannot
 *   spell, and `yrd submit` is its whole cure.
 */
export function deriveChangeState(pr: Change, facts: DerivedChangeStateFacts = {}): DerivedChangeStateReading {
  const delivery = changeDeliveryState(pr)
  if (facts.merged === true || pr.merged) return { state: "merged", owner: "" }

  const submitterEnded = SUBMITTER_ENDED[delivery]
  if (submitterEnded !== undefined) {
    return { state: "failed", check: submitterEnded, owner: SUBMITTERS_OWN, code: delivery }
  }

  // A refused on-submit check ended the change whatever the delivery label
  // says. Only the `refusal` kind reaches `changeDeliveryState` as
  // `needs-author`; the `failure` and `infrastructure` kinds leave the change
  // reading `submitted`, which is the exact conflation this surface is here to
  // end — a check that ran out of disk looked like a change waiting its turn.
  const admission = changeAdmission(pr)
  const refused = admission?.status === "refused" ? admission : undefined
  if (refused !== undefined || delivery === "rejected" || delivery === "needs-author") {
    const author = changeNeedsAuthor(pr)
    const code = facts.result?.code ?? refused?.receipt.code ?? author?.receipt.code ?? facts.reason?.code
    const check = facts.result?.check ?? refused?.step ?? author?.step
    const stuck = { state: "stuck", owner: QUEUES_OWN, ...(code === undefined ? {} : { code }) } as const
    // The queue said so itself: the check could not do its job.
    if (refused?.kind === "infrastructure") return stuck
    // An ending whose code is outside the queue's own closed vocabulary cannot
    // be attributed, so it is the queue's — the same default an unproven check
    // failure takes. The code rides along rather than being swallowed.
    if (code === undefined || canonicalRefusalCode(code) === undefined) return stuck
    if (failureDisposition(code).owner === "queue") return { state: "stuck", owner: QUEUES_OWN, code }
    return { state: "failed", owner: SUBMITTERS_OWN, code, ...(check === undefined ? {} : { check }) }
  }

  if (delivery === "ready" || admission?.status === "passed") return { state: "checked", owner: "" }
  if (delivery === "pushed") return { state: "queued", owner: "", code: "not-submitted" }
  return { state: "queued", owner: "" }
}

/** The one label every surface prints: the state, then what the operator needs
 * beside it — the check that judged a `failed` change, and whose a `stuck` one
 * is. Nothing else is appended, so the five words stay readable in a column. */
export function changeStateLabel(reading: DerivedChangeStateReading): string {
  if (reading.state === "failed" && reading.check !== undefined) return `failed ${reading.check}`
  if (reading.state === "stuck") return `stuck ${QUEUES_OWN}`
  return reading.state
}

const CHANGE_STATE_COLORS: Readonly<Record<DerivedChangeState, string>> = {
  queued: "$fg-accent",
  checked: "$fg-info",
  merged: "$fg-success",
  // Both endings are red-adjacent and must not look alike: an operator reads
  // `stuck` to go and fix the queue, `failed` to send the change back.
  stuck: "$fg-warning",
  failed: "$fg-error",
}

const CHANGE_STATE_GLYPHS: Readonly<Record<DerivedChangeState, string>> = {
  queued: "○",
  checked: "◉",
  merged: "✓",
  stuck: "◌",
  failed: "×",
}

/**
 * The color for a state word. Takes a string, not the union, because one row
 * on the change list is not a change at all: `unreadableChangeListRow` renders
 * a row whose own clocks could not be reconciled, so the table can say so
 * instead of emptying itself. That row says `unreadable` in its own text and
 * takes the muted color here — it is not a sixth state, and throwing would
 * give back exactly the empty table the containment row exists to prevent.
 */
export function changeStateColor(state: string): string {
  return CHANGE_STATE_COLORS[state as DerivedChangeState] ?? "$fg-muted"
}

export function changeStateGlyph(state: DerivedChangeState): string {
  return CHANGE_STATE_GLYPHS[state]
}
