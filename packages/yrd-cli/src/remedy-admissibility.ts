import type { ChangeDeliveryState } from "@yrd/bay"

/**
 * The Yrd verbs a printed remedy may name for a change whose branch could not
 * be observed, and the delivery states each verb's own guard admits.
 *
 * NOT a second registry of the guards: `remedy-executable-in-emitting-state.test.ts`
 * drives the real commands from real states and fails when this disagrees with
 * them. It exists because a remedy has to be CHOSEN before it is printed, and
 * running the guard to find out would emit the very refusal we are trying to
 * avoid printing.
 *
 * - `publish` is `requestChangePublication`'s guard (`@yrd/bay` plugin): it
 *   admits `pushed` alone, because publication is what MAKES a draft's branch
 *   exist on origin. Every state past that has already published.
 * - `withdraw` is `requiredLivePr`'s guard (`pr-withdraw.ts`): it admits every
 *   live change and refuses only the terminal ones, which have nothing left to
 *   dispose of.
 */
export type RemedyVerb = "publish" | "withdraw"

export const REMEDY_VERB_ADMISSIBLE_STATES: Readonly<Record<RemedyVerb, ReadonlySet<ChangeDeliveryState>>> =
  Object.freeze({
    publish: new Set<ChangeDeliveryState>(["pushed"]),
    withdraw: new Set<ChangeDeliveryState>(["pushed", "submitted", "ready", "needs-author", "rejected"]),
  })

/** Whether this verb's own guard admits a change in this delivery state — the
 * question a printer must answer before naming the verb. */
export function remedyAdmissibleIn(verb: RemedyVerb, delivery: ChangeDeliveryState): boolean {
  return REMEDY_VERB_ADMISSIBLE_STATES[verb].has(delivery)
}

/** Why one branch could not be observed. `absent` is origin's authoritative
 * answer that the ref is gone; `unreachable` is every transport fault, which a
 * retry can still fix. */
export type UnobservableBranchReason = "absent" | "unreachable"

export type BranchRemedy = Readonly<{
  /** The verb the printed remedy names, or `undefined` when no Yrd verb is the
   * cure — a transport fault is cured by restoring the transport, and printing
   * a delivery verb there would be a wrong instruction in a remedy's clothes. */
  verb: RemedyVerb | undefined
  text: string
}>

type ChangeIdentity = Readonly<{ id: string; branch: string }>
type RecordedRevision = Readonly<{ base: string; baseSha?: string; head: string }>

function publicationRemedy(pr: ChangeIdentity, recorded: RecordedRevision, queueFlag: string): BranchRemedy {
  return Object.freeze({
    verb: "publish" as const,
    text:
      `remedy: request credential-bearing Yrd publication for branch '${pr.branch}' on base '${recorded.base}' ` +
      `at base SHA '${recorded.baseSha ?? "unrecorded"}' and recorded head '${recorded.head}':\n` +
      `  yrd pr publish ${pr.id}${queueFlag}\n` +
      `This records a durable publication Job; without a runner it remains visible as publication-required.\n` +
      `if the publication Job cannot run: escalate to @chief for a credential-bearing publish — this branch is ` +
      `never pushed by hand, not even as an emergency fallback.`,
  })
}

function disposalRemedy(pr: ChangeIdentity): BranchRemedy {
  return Object.freeze({
    verb: "withdraw" as const,
    text:
      `remedy: origin no longer has branch '${pr.branch}', so there is no source left to re-merge and nothing a ` +
      `retry can recover. Dispose of the change:\n` +
      `  yrd pr withdraw ${pr.id} --burn-payload --reason "source branch '${pr.branch}' no longer exists on origin"\n` +
      `if the branch was deleted by mistake: restore it on origin first, and this change becomes observable again ` +
      `without any Yrd verb.`,
  })
}

function transportRemedy(pr: ChangeIdentity): BranchRemedy {
  return Object.freeze({
    verb: undefined,
    text:
      `remedy: origin could not be reached, and origin still advertises branch '${pr.branch}' — so nothing about ` +
      `change '${pr.id}' is wrong and no Yrd verb applies. Restore access to origin, then retry the same command.`,
  })
}

/**
 * The one emitter of a remedy for an unobservable branch, chosen by the state
 * that is emitting it.
 *
 * The PR1189 wedge was the opposite: one hard-coded remedy naming `yrd pr
 * publish`, printed from a `ready` change, which that verb's guard refuses —
 * *"change 'PR1189' is ready, not pushed"*. A stop whose printed cure cannot run
 * in the stopping state names no cure at all, so the cure is derived from the
 * state here and pinned exhaustively by the test.
 */
export function unobservableBranchRemedy(
  reason: UnobservableBranchReason,
  pr: ChangeIdentity,
  delivery: ChangeDeliveryState,
  recorded: RecordedRevision,
  queueFlag: string,
): BranchRemedy {
  // A change still in `pushed` never had its branch published at all — for
  // either fault, publication is the genuine cure, and its guard admits exactly
  // this state.
  if (remedyAdmissibleIn("publish", delivery)) return publicationRemedy(pr, recorded, queueFlag)
  if (reason === "absent" && remedyAdmissibleIn("withdraw", delivery)) return disposalRemedy(pr)
  return transportRemedy(pr)
}
