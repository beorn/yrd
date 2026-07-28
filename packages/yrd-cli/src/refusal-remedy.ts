import { currentPRRev, prDeliveryState, type PR, type PRDeliveryState } from "@yrd/bay"
import { ADMISSION_REFUSAL_LOOP_THRESHOLD, type QueueAdmissionRefusal } from "@yrd/queue"
import { actionableFailure, recutRefusedByDelivery, type FailureLike } from "./actionable-error.ts"

/**
 * One mechanically executable step of a printed refusal remedy.
 *
 * Parsed, never string-spliced: the runner executes the step, and
 * {@link formatRemedyCommand} renders the exact command line it stands for so
 * the log records what a human would have typed.
 */
export type RemedyStep =
  /** Re-record the branch's corrected head onto the PR. `create` keeps a draft a
   * draft; `submit` is the state-agnostic spelling. */
  | Readonly<{ verb: "submit" | "create"; branch: string }>
  | Readonly<{ verb: "recut"; pr: string; preflight: boolean; queue: boolean; force: boolean }>

export type RefusalRemedy =
  | Readonly<{ kind: "self-applicable"; steps: readonly RemedyStep[] }>
  | Readonly<{ kind: "judgment"; reason: string }>

export type RefusalRemedyContext = Readonly<{
  /** The PR's branch, substituted for the `<branch>` placeholder the printed
   * remedy carries — the one token a human had to fill in by hand. */
  branch: string
  delivery?: PRDeliveryState
}>

/** The `<branch>` placeholder a printed remedy uses when it does not know (or
 * does not need to name) the branch. */
const BRANCH_PLACEHOLDER = "<branch>"

function parseRecut(argv: readonly string[]): RemedyStep | undefined {
  const [pr, ...flags] = argv
  if (pr === undefined || pr.startsWith("-")) return undefined
  const parsed = { verb: "recut" as const, pr, preflight: false, queue: false, force: false }
  for (const flag of flags) {
    if (flag === "--preflight") parsed.preflight = true
    else if (flag === "--queue") parsed.queue = true
    else if (flag === "--force") parsed.force = true
    // An unrecognised flag makes the command something other than the drill this
    // module knows how to run; refuse the whole remedy rather than run a
    // silently different command.
    else return undefined
  }
  return Object.freeze(parsed)
}

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
  if (verb === "recut") return parseRecut(argv)
  if (verb === "submit" || verb === "create") return parseRedelivery(verb, argv, context.branch)
  return undefined
}

export function formatRemedyCommand(step: RemedyStep): string {
  if (step.verb === "recut") {
    return [
      `yrd pr recut ${step.pr}`,
      ...(step.preflight ? ["--preflight"] : []),
      ...(step.force ? ["--force"] : []),
      ...(step.queue ? ["--queue"] : []),
    ].join(" ")
  }
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
 *   3. able to put the PR back in the queue — a drill that cannot end in a
 *      queued recut (a terminal PR, or a refusal that merely says "correct the
 *      cause") leaves the wedge exactly where it was.
 *
 * Everything else — recut/payload certificates, environment refusals, divergent
 * gitlink composes — is judgment-required and keeps printing its remedy for the
 * human who takes it. A new refusal code needs no entry here: it is mechanical
 * if and only if it prints a mechanical drill.
 */
export function classifyRefusalRemedy(failure: FailureLike, context: RefusalRemedyContext): RefusalRemedy {
  const projected = actionableFailure(failure, context.delivery === undefined ? {} : { delivery: context.delivery })
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
  if (steps.some((step) => step.verb === "recut") && recutRefusedByDelivery(context.delivery)) {
    return Object.freeze({
      kind: "judgment",
      reason: `PR delivery state '${context.delivery ?? "unknown"}' refuses recut`,
    })
  }
  if (!steps.some((step) => step.verb === "recut" && step.queue)) {
    return Object.freeze({
      kind: "judgment",
      reason: "the printed remedy never re-enters the PR into the queue, so applying it would not clear the refusal",
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
  /** Identity of the PR REVISION this plan is for. A remedy is attempted at most
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
 * Consecutive all-candidate-refusal cycles before the resident treats its own
 * process state as the suspect and restarts.
 *
 * 2026-07-27 specimen 3: after a laptop-sleep network partition a resident
 * refused EVERY candidate with `recut-certificate` 106 consecutive times over
 * 1h44m — zero admissions, main frozen 2.5h — while a by-hand `yrd pr recut
 * --preflight` reported FRESH-NOOP for the same PRs. SIGINT plus a fresh `yrd
 * queue run` integrated within 60s with no PR changed: the fault was the
 * runner INSTANCE, not the PRs. At the default 15s interval this bounds that
 * class at minutes instead of hours.
 */
export const RESIDENT_REFUSAL_STALL_CYCLES = 20

/** One settled resident cycle, reduced to what a poisoned-observer verdict
 * needs: did anything get in, what is still refusing, and did the refused PRs
 * themselves move. */
export type ResidentRefusalObservation = Readonly<{
  /** Runs this cycle produced. Any run at all proves the runner is not blind. */
  runs: number
  refusals: readonly Readonly<{ pr: string; code: string; count: number }>[]
  /** Current head SHA per refused PR — evidence the PRs did not change. */
  heads: Readonly<Record<string, string>>
}>

export type ResidentRefusalStall = Readonly<{
  /** The refused PR set, their codes, and their heads — the "world" that has
   * not changed across the window. */
  signature: string
  /** Refusal counts as of the last observation, so the next cycle can prove the
   * ledger actually ADVANCED rather than merely staying equal. */
  counts: Readonly<Record<string, number>>
  cycles: number
}>

function stallSignature(observation: ResidentRefusalObservation): string {
  return observation.refusals
    .map((refusal) => `${refusal.pr}|${refusal.code}|${observation.heads[refusal.pr] ?? ""}`)
    .toSorted((left, right) => left.localeCompare(right, undefined, { numeric: true }))
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
  previous: ResidentRefusalStall | undefined,
  observation: ResidentRefusalObservation,
): ResidentRefusalStall | undefined {
  if (observation.runs > 0 || observation.refusals.length === 0) return undefined
  const signature = stallSignature(observation)
  const counts = Object.fromEntries(observation.refusals.map((refusal) => [refusal.pr, refusal.count]))
  const advanced =
    previous !== undefined &&
    previous.signature === signature &&
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
  prs: Readonly<Record<string, PR>>,
  attempted: ReadonlySet<string>,
): readonly RefusalRemedyPlan[] {
  const plans: RefusalRemedyPlan[] = []
  for (const refusal of Object.values(refusals).toSorted((left, right) =>
    left.pr.localeCompare(right.pr, undefined, { numeric: true }),
  )) {
    if (refusal.count < ADMISSION_REFUSAL_LOOP_THRESHOLD) continue
    const pr = prs[refusal.pr]
    // The ledger is retained past its PR (compaction drops streaks for PRs the
    // state no longer holds); a streak with no PR names nothing to remedy.
    if (pr === undefined) continue
    const revision = currentPRRev(pr)
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
          { branch: pr.branch, delivery: prDeliveryState(pr) },
        ),
      }),
    )
  }
  return Object.freeze(plans)
}
