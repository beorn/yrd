/**
 * The queue's DISPLAY-STATE projection: what every status surface needs to
 * know about one record, derived once from `changeDeliveryState` (the
 * model-side primitive) plus run/eligibility context. Moved here from
 * `@yrd/cli`'s queue-status-view so the projection has one home a non-view
 * consumer can import without reaching into a view file (5a: one derivation
 * per fact).
 */
import { changeDeliveryState, type Change, type ChangeDeliveryState } from "@yrd/bay"
import { queueMemberKind, type ChangeEligibility, type QueueMemberKind, type Run } from "./model.ts"

/**
 * Everything the queue surfaces need to know about ONE record's display, from
 * ONE walk of it: which kind it is, whether it is settled, its delivery state,
 * and its pre-run band.
 *
 * There used to be three derivations of this. `changeDeliveryState` (the model-side
 * primitive, which stays and which this consumes), `projectedPrStatus`, and
 * `preRunTimelineStatus` each walked the same record toward the same question
 * and disagreed at the edges, because the closed-record guard existed in
 * exactly ONE of them: a withdrawn PR whose stale `needsAuthor` outlived its
 * close rendered `rev` on the timeline forever while the sibling surface
 * correctly said `withdrawn`. That is the shape docs/lessons/no-parallel-
 * derivation.md names — two systems computing the same derived quantity diverge
 * on the inputs nobody thought to test, and every new surface is one more edge
 * to keep in sync by hand.
 *
 * So the guard lives here, once. The former derivers select a field off this
 * one computation, and the word/colour/filter re-mappers downstream consume the
 * result rather than deriving it again.
 */
export type QueueDisplayState = Readonly<{
  /** Which kind of record this is. Carried so no renderer re-parses the id
   * string — the mechanism of @i/10-merge-queue/22924-pr-prefix-on-non-pr.
   * `undefined` means neither schema claimed the id; nobody may assume `pr`. */
  kind: QueueMemberKind | undefined
  /** Settled by intent: closed, so integrated / already-landed / canceled /
   * withdrawn and nothing open-only can still be true of it. */
  terminal: boolean
  /** The record's own delivery state, before any eligibility overlay. */
  native: ChangeDeliveryState
  /** The delivery state a surface shows, `needs-author` included. */
  delivery: ChangeDeliveryState | "needs-author"
  /** The pre-run timeline band, or undefined when the record is settled or
   * belongs to no pre-run band at all. */
  preRun: "draft" | "rev" | "ready" | undefined
}>

export function queueDisplayState(
  pr: Change,
  options: Readonly<{ eligibility?: ChangeEligibility; runs?: readonly Run[] }> = {},
): QueueDisplayState {
  const kind = queueMemberKind(pr.id)
  const native = changeDeliveryState(pr)
  // `needs-author` is an OPEN-only value, and `PR.needsAuthor` is cleared by
  // re-merge, submitted, admission-recorded and already-landed but never by
  // withdrawn, integrated or canceled — so a stored refusal outlives every
  // closing path. Terminality is therefore read first, everywhere, by everyone.
  //
  // A closed record keeps its FULL truth in `delivery` (withdrawn / canceled /
  // integrated / already-landed) and takes `preRun: undefined`. That is the one
  // place closed maps to absent-from-the-timeline, and it is a property of the
  // timeline's vocabulary rather than of the record: `QueueTimelineStatus` has
  // no `withdrawn` member, and the sibling PR projection independently drops
  // the same three states from its list (see `projectedPRRows` consumers
  // filtering `nativeStatus` integrated/already-landed/withdrawn, ~:3862).
  // Callers that DO have a word for a closed record read `delivery`.
  if (pr.state === "closed") return { kind, terminal: true, native, delivery: native, preRun: undefined }
  const delivery = options.eligibility?.reason?.code === "needs-author" ? "needs-author" : native
  return {
    kind,
    terminal: false,
    native,
    delivery,
    preRun: preRunBand(pr, native, options.runs ?? [], options.eligibility),
  }
}

/**
 * The pre-run band of an OPEN record: `draft`/`rev` for a registered-but-
 * unsubmitted PR (delivery `pushed`) and `ready` for one awaiting its run.
 * `rev` is a draft carrying failed-submission history — the user's "a failed
 * submission returns the change to an editable state" — and stores no new status record.
 * A `rejected` PR resurfaces as `rev` IMMEDIATELY (21707: rejection is a
 * submission fact, not a change resting state), scope-limited to PRs whose failed
 * run the result still retains, so the pre-cutover backlog of ancient rejected
 * PRs cannot flood the band; once the run ages out, the corpse stays hidden.
 *
 * Terminal records never reach here — {@link queueDisplayState} returns before
 * calling it — which is the whole point of the guard living in one place.
 */
function preRunBand(
  pr: Change,
  native: ChangeDeliveryState,
  runs: readonly Run[],
  eligibility: ChangeEligibility | undefined,
): "draft" | "rev" | "ready" | undefined {
  if (native === "needs-author") return "rev"
  if (eligibility?.reason?.code === "required-check-failed") return "rev"
  if (native === "submitted" || native === "ready") return "ready"
  if (native === "pushed") return lastFailedSubmission(pr) === undefined ? "draft" : "rev"
  if (native === "rejected") {
    const runId = lastFailedSubmission(pr)?.terminal?.run
    if (runId !== undefined && runs.some((run) => run.id === runId)) return "rev"
  }
  return undefined
}

/** Thin consumer of {@link queueDisplayState} — kept as the named surface every
 * status caller already reads, but no longer a second derivation of it. */
export function projectedChangeStatus(
  pr: Change,
  eligibility?: ChangeEligibility,
): ChangeDeliveryState | "needs-author" {
  return queueDisplayState(pr, eligibility === undefined ? {} : { eligibility }).delivery
}

/** The most recent failed submission (a `rejected` terminal) a change's revision
 * history records, or undefined when it has never failed a submission. This is
 * the derived signal — never a stored status — that turns a `draft` into a
 * `rev` row. `canceled`/`withdrawn` terminals are supersessions, not
 * failures, so they do not count. */
export function lastFailedSubmission(pr: Change): Change["revs"][number] | undefined {
  return pr.revs.filter((revision) => revision.terminal?.kind === "rejected").at(-1)
}
