import { currentChangeRev, changeDeliveryState, type Change, type ChangeDeliveryState } from "@yrd/bay"
import { compareNatural } from "@yrd/core"
import { ADMISSION_REFUSAL_LOOP_THRESHOLD, type QueueAdmissionRefusal } from "@yrd/queue"
import { actionableFailure, redeliveryRefusedByDelivery, type FailureLike } from "./actionable-error.ts"

/**
 * One mechanically executable step of a printed refusal remedy.
 *
 * Parsed, never string-spliced: the runner executes the step, and
 * {@link formatRemedyCommand} renders the exact command line it stands for so
 * the log records what a human would have typed.
 */
export type RemedyStep =
  /** Re-record the branch's corrected head onto the change. `create` keeps a draft a
   * draft; `submit` is the state-agnostic spelling — and, for the change under
   * remedy, the runner honours it through the implicit re-merge preflight
   * rather than a blind re-record (tracked changes re-merge implicitly). */
  Readonly<{ verb: "submit" | "create"; branch: string }>

export type RefusalRemedy =
  | Readonly<{ kind: "self-applicable"; steps: readonly RemedyStep[] }>
  | Readonly<{ kind: "judgment"; reason: string }>

export type RefusalRemedyContext = Readonly<{
  /** The change's branch, substituted for the `<branch>` placeholder the printed
   * remedy carries — the one token a human had to fill in by hand. */
  branch: string
  delivery?: ChangeDeliveryState
}>

/** The `<branch>` placeholder a printed remedy uses when it does not know (or
 * does not need to name) the branch. */
const BRANCH_PLACEHOLDER = "<branch>"

function parseRedelivery(verb: "submit" | "create", argv: readonly string[], branch: string): RemedyStep | undefined {
  const [target, ...rest] = argv
  if (target === undefined || rest.length > 0) return undefined
  return Object.freeze({ verb, branch: target === BRANCH_PLACEHOLDER ? branch : target })
}

/** Parse one printed resolution line into an executable step, or `undefined`
 * when it is not a Yrd command this module can run mechanically (prose, a git
 * recipe, or a Yrd verb outside the redelivery drill). */
export function parseRemedyCommand(command: string, context: RefusalRemedyContext): RemedyStep | undefined {
  const [binary, group, verb, ...argv] = command.trim().split(/\s+/u)
  if (binary !== "yrd" || group !== "pr") return undefined
  if (verb === "submit" || verb === "create") return parseRedelivery(verb, argv, context.branch)
  return undefined
}

export function formatRemedyCommand(step: RemedyStep): string {
  return `yrd pr ${step.verb} ${step.branch}`
}

/**
 * Split a refusal into "the runner can apply this itself" and "a human has to
 * decide" — the 22474 classification.
 *
 * It is a DERIVATION of the printed remedy, not a second registry of codes: the
 * refusal message already prints the exact drill, {@link actionableFailure} is
 * the one projection that turns it into a machine-readable `resolution`, and a
 * remedy is self-applicable exactly when that projection is
 *
 *   1. free of an `escalation` — an escalated failure has no mechanical remedy
 *      by construction (its recipe can conflict, and resolving a conflict is
 *      judgment);
 *   2. made ONLY of Yrd redelivery commands this module can execute; and
 *   3. able to put the change back in the queue — a drill with no `submit`
 *      step (a terminal change, or a refusal that merely says "correct the
 *      cause") leaves the wedge exactly where it was. The runner honours the
 *      submit step through the implicit re-merge preflight, so a mechanical
 *      remedy and a tracked change's ordinary head-move take the same path.
 *
 * Everything else — re-merge/payload certificates, environment refusals, divergent
 * gitlink composes — is judgment-required and keeps printing its remedy for the
 * human who takes it. A new refusal code needs no entry here: it is mechanical
 * if and only if it prints a mechanical drill.
 */
export function classifyRefusalRemedy(failure: FailureLike, context: RefusalRemedyContext): RefusalRemedy {
  const projected = actionableFailure(failure)
  if (projected.escalation !== undefined) {
    return Object.freeze({ kind: "judgment", reason: projected.escalation.reason })
  }
  const steps: RemedyStep[] = []
  for (const command of projected.resolution) {
    const step = parseRemedyCommand(command, context)
    if (step === undefined) {
      return Object.freeze({
        kind: "judgment",
        reason: `remedy step '${command}' is not a mechanical Yrd redelivery command`,
      })
    }
    steps.push(step)
  }
  if (steps.length > 0 && redeliveryRefusedByDelivery(context.delivery)) {
    return Object.freeze({
      kind: "judgment",
      reason: `a change in delivery state '${context.delivery ?? "unknown"}' cannot be redelivered mechanically`,
    })
  }
  if (!steps.some((step) => step.verb === "submit")) {
    return Object.freeze({
      kind: "judgment",
      reason:
        "the printed remedy never re-enters the change into the merge queue, " +
        "so applying it would not clear the failure",
    })
  }
  return Object.freeze({ kind: "self-applicable", steps: Object.freeze(steps) })
}

/** One wedged PR and what the runner intends to do about it this cycle. */
export type RefusalRemedyPlan = Readonly<{
  pr: string
  branch: string
  revision: number
  headSha: string
  /** The refusal streak's latest code and message — the failure being remedied. */
  failure: FailureLike
  count: number
  /** Identity of the change REVISION this plan is for. A remedy is attempted at most
   * once per revision; a successful one produces a new revision (and clears the
   * streak), so progress never depends on retrying the same one. */
  key: string
  remedy: RefusalRemedy
}>

/** The revision-scoped identity a remedy attempt is recorded against. */
export function refusalRemedyKey(pr: string, revision: number, headSha: string): string {
  return `${pr}@${revision}:${headSha}`
}

/**
 * Consecutive all-candidate-refusal cycles before the habitant treats its own
 * process state as the suspect and restarts.
 *
 * 2026-07-27 specimen 3: after a laptop-sleep network partition a habitant
 * refused EVERY candidate with `recut-certificate` 106 consecutive times over
 * 1h44m — zero admissions, main frozen 2.5h — while a by-hand re-merge
 * preflight reported FRESH-NOOP for the same PRs. SIGINT plus a fresh `yrd
 * queue run` integrated within 60s with no PR changed: the fault was the
 * runner INSTANCE, not the PRs. At the default 15s interval this bounds that
 * class at minutes instead of hours.
 */
export const HABITANT_REFUSAL_STALL_CYCLES = 20

/** One settled habitant cycle, reduced to what a poisoned-observer verdict
 * needs: did anything get in, what is still refusing, and did the refused PRs
 * themselves move. */
export type HabitantRefusalObservation = Readonly<{
  /** Runs this cycle produced. Any run at all proves the runner is not blind. */
  runs: number
  refusals: readonly Readonly<{ pr: string; code: string; count: number }>[]
  /** Current head SHA per refused PR — evidence the PRs did not change. */
  heads: Readonly<Record<string, string>>
}>

export type HabitantRefusalStall = Readonly<{
  /** The refused PR set, their codes, and their heads — the "world" that has
   * not changed across the window. */
  signature: string
  /** Refusal counts as of the last observation, so the next cycle can prove the
   * ledger actually ADVANCED rather than merely staying equal. */
  counts: Readonly<Record<string, number>>
  cycles: number
}>

function stallSignature(observation: HabitantRefusalObservation): string {
  return observation.refusals
    .map((refusal) => `${refusal.pr}|${refusal.code}|${observation.heads[refusal.pr] ?? ""}`)
    .toSorted(compareNatural)
    .join(",")
}

/**
 * Fold one settled cycle into the poisoned-observer window, or `undefined` when
 * this cycle is not part of one.
 *
 * A cycle continues the window only when NOTHING about the world moved and the
 * runner still got nowhere: no run was produced, the same PRs are refusing with
 * the same codes at the same heads, and every one of their streaks advanced
 * (proving the compose really did reach and refuse each of them again, rather
 * than idling past them).
 */
export function foldRefusalStall(
  previous: HabitantRefusalStall | undefined,
  observation: HabitantRefusalObservation,
): HabitantRefusalStall | undefined {
  if (observation.runs > 0 || observation.refusals.length === 0) return undefined
  const signature = stallSignature(observation)
  const counts = Object.fromEntries(observation.refusals.map((refusal) => [refusal.pr, refusal.count]))
  const advanced =
    previous?.signature === signature &&
    observation.refusals.every((refusal) => refusal.count > (previous.counts[refusal.pr] ?? Number.POSITIVE_INFINITY))
  return Object.freeze({ signature, counts: Object.freeze(counts), cycles: advanced ? previous.cycles + 1 : 1 })
}

/**
 * Decide, purely, what the runner should do about the live admission-refusal
 * ledger — the 22474 "apply the button you printed" pass.
 *
 * Acts only on streaks the queue itself already calls wedged
 * ({@link ADMISSION_REFUSAL_LOOP_THRESHOLD}), so a single losable race is never
 * remediated, and skips any PR whose revision has already been attempted, so a
 * failed remedy degrades to the printed refusal instead of becoming its own
 * retry loop.
 */
export function planRefusalRemedies(
  refusals: Readonly<Record<string, QueueAdmissionRefusal>>,
  prs: Readonly<Record<string, Change>>,
  attempted: ReadonlySet<string>,
): readonly RefusalRemedyPlan[] {
  const plans: RefusalRemedyPlan[] = []
  for (const refusal of Object.values(refusals).toSorted((left, right) => compareNatural(left.pr, right.pr))) {
    if (refusal.settlement !== undefined || refusal.count < ADMISSION_REFUSAL_LOOP_THRESHOLD) continue
    const pr = prs[refusal.pr]
    // The ledger is retained past its PR (compaction drops streaks for PRs the
    // state no longer holds); a streak with no PR names nothing to remedy.
    if (pr === undefined) continue
    const revision = currentChangeRev(pr)
    const key = refusalRemedyKey(pr.id, revision.n, revision.head)
    if (attempted.has(key)) continue
    plans.push(
      Object.freeze({
        pr: pr.id,
        branch: pr.branch,
        revision: revision.n,
        headSha: revision.head,
        failure: Object.freeze({ code: refusal.code, message: refusal.reason }),
        count: refusal.count,
        key,
        remedy: classifyRefusalRemedy(
          { code: refusal.code, message: refusal.reason },
          { branch: pr.branch, delivery: changeDeliveryState(pr) },
        ),
      }),
    )
  }
  return Object.freeze(plans)
}
