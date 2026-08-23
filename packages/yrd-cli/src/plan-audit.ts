import type { InstalledStep, QueueAuditFindingEmission, QueueRecord, StepPlanSource, StepSelection } from "@yrd/queue"

/** The derived queue-plan audit (23192, 23193).
 *
 * Nothing here reads a written baseline: there is none. Git is the authority
 * for what a queue declares, the journal is the record of what judged each
 * Run, and this process's installed step set is what it can execute. The audit
 * compares those three pairwise and prints every side with the sha it was read
 * from, so a zero always says what it is zero OVER. */

/** The effective queue policy one side of a comparison holds: its batch size
 * and its ordered step descriptors (identity, integration contract, revision). */
export type QueuePlanDescriptor = Readonly<{
  batchSize: number
  steps: readonly InstalledStep[]
}>

/** The plan git declares at one exact commit, derived through the same
 * descriptor recipe this process uses for its own installed set, so revisions
 * on both sides are comparable. `configBlobSha` is absent only when that commit
 * carries no config file at all (the built-in plan is in force). */
export type DeclaredPlanAt = QueuePlanDescriptor &
  Readonly<{
    sha: string
    configBlobSha?: string
  }>

/** One recorded Run's plan, as the journal holds it.
 *
 * `plan` is the FULL ordered list that judged the Run (`stepSelection.steps`,
 * read from the config blob at `baseSha`); `steps` are the descriptors the Run
 * executed ITSELF. The two differ by design: when a change's checks already
 * ran at the checks-before-queueing stage against the same base sha, the Run
 * reuses that evidence and executes only the remainder — usually the single
 * merge. Reading `steps` as "what was checked" is how a live audit called four
 * executed checks "did not run" (item 0 of this slice). */
export type RecordedRunPlan = Readonly<{
  run: string
  startedAt: string
  steps: readonly InstalledStep[]
  plan?: readonly string[]
  members: readonly Readonly<{ id: string; revision: number }>[]
  source?: StepPlanSource
  authority?: StepSelection["authority"]
  baseSha?: string
  configBlobSha?: string
}>

export function recordedRunPlan(record: QueueRecord): RecordedRunPlan {
  const selection = record.stepSelection
  return {
    run: record.id,
    startedAt: record.startedAt,
    steps: record.steps,
    ...(selection?.steps === undefined ? {} : { plan: selection.steps }),
    members: record.prs.map((pr) => ({ id: pr.id, revision: pr.revision })),
    ...(selection?.source === undefined ? {} : { source: selection.source }),
    ...(selection?.authority === undefined ? {} : { authority: selection.authority }),
    ...(selection?.baseSha === undefined ? {} : { baseSha: selection.baseSha }),
    ...(selection?.configBlobSha === undefined ? {} : { configBlobSha: selection.configBlobSha }),
  }
}

/** One check the checks-before-queueing stage certified for one change
 * revision at one exact base sha, as `ChangeAdmission.steps` records it. */
export type AdmissionCheck = Readonly<{ name: string; revision: string }>

/** The passed checks recorded for one Run member at one exact base sha, or
 * undefined when that member has no passed record at that base. The audit is
 * handed this as a lookup so the pure comparison never touches state. */
export type AdmissionLookup = (
  member: Readonly<{ id: string; revision: number }>,
  baseSha: string,
) => readonly AdmissionCheck[] | undefined

/** Where each step of a Run's judged plan actually executed.
 *
 * - `run` — the Run executed it itself (`steps` carries its descriptor).
 * - `admission` — every member's checks-before-queueing record at the Run's
 *   own base sha carried it passed; the Run reused that evidence.
 * - `missing` — neither stage executed it. That is the real finding.
 */
export type StepExecutionPlace = Readonly<{
  name: string
  where: "run" | "admission" | "missing"
  /** The executing side's recorded revision (`admission`: the first member's). */
  revision?: string
}>

export function accountRunSteps(recorded: RecordedRunPlan, admissionFor?: AdmissionLookup): StepExecutionPlace[] {
  const plan = recorded.plan ?? recorded.steps.map((step) => step.name)
  const ran = new Map(recorded.steps.map((step) => [step.name, step] as const))
  const memberEvidence =
    recorded.baseSha === undefined || admissionFor === undefined || recorded.members.length === 0
      ? undefined
      : recorded.members.map((member) => admissionFor(member, recorded.baseSha as string))
  return plan.map((name) => {
    const inRun = ran.get(name)
    if (inRun !== undefined) return { name, where: "run", revision: inRun.revision }
    const evidence = memberEvidence?.map((checks) => checks?.find((check) => check.name === name))
    if (evidence !== undefined && evidence.length > 0 && evidence.every((check) => check !== undefined)) {
      return { name, where: "admission", ...(evidence[0] === undefined ? {} : { revision: evidence[0].revision }) }
    }
    return { name, where: "missing" }
  })
}

/** "merge ran in the Run; typecheck, affected-tests ran at admission for base
 * 6a3cbce6, the Run's base" — the sentence a healthy accounting reads as. */
export function describeStepExecution(places: readonly StepExecutionPlace[], baseSha: string | undefined): string {
  const at = (where: StepExecutionPlace["where"]): string[] =>
    places.filter((place) => place.where === where).map((place) => place.name)
  const parts: string[] = []
  const ran = at("run")
  if (ran.length > 0) parts.push(`${ran.join(", ")} ran in the Run`)
  const admitted = at("admission")
  if (admitted.length > 0) {
    parts.push(`${admitted.join(", ")} ran at admission for base ${shortSha(baseSha)}, the Run's base`)
  }
  const missing = at("missing")
  if (missing.length > 0) parts.push(`${missing.join(", ")} executed in NEITHER stage`)
  return parts.join("; ")
}

/** The most recent root Runs, newest first. Bisection children inherit their
 * parent's plan, so only roots are compared. */
export function recentRootRuns(records: readonly QueueRecord[], limit: number): readonly RecordedRunPlan[] {
  return records
    .filter((record) => record.parent === undefined)
    .toSorted(
      (left, right) => right.startedAt.localeCompare(left.startedAt) || runNumber(right.id) - runNumber(left.id),
    )
    .slice(0, limit)
    .map(recordedRunPlan)
}

function runNumber(id: string): number {
  const parsed = Number(id.replace(/^R/u, ""))
  return Number.isSafeInteger(parsed) ? parsed : 0
}

export const shortSha = (sha: string | undefined): string => (sha === undefined ? "none" : sha.slice(0, 8))

export const planArrow = (steps: readonly Readonly<{ name: string }>[]): string =>
  steps.length === 0 ? "(no steps)" : steps.map((step) => step.name).join("→")

/** Abbreviate long hash-shaped revisions for the operator message; leave
 * short human-readable revisions (test fixtures, tags) intact. */
const shortRevision = (revision: string): string =>
  /^[0-9a-f]{16,}$/iu.test(revision) ? revision.slice(0, 8) : revision

/** Each side of a plan comparison names itself, so the operator can read WHICH
 * pair disagreed and in which direction without decoding the finding code. */
export type PlanVocabulary = Readonly<{
  /** The side that is the authority, e.g. "main's tip 6a3cbce6". */
  expected: string
  /** The side under judgement, e.g. "this process". */
  actual: string
  /** Verb for a step the authority names and the other side lacks. */
  missingActual: string
  /** Verb for a step the other side holds and the authority does not name. */
  missingExpected: string
}>

/** Every way two effective plans can differ, as operator sentences: batch
 * size, membership in either direction, per-step revision, integration
 * contract, and ORDER — step revisions deliberately exclude sequence, so a
 * pure reorder leaves every per-step delta empty and is caught separately. */
export function planDeltas(
  expected: QueuePlanDescriptor,
  actual: QueuePlanDescriptor,
  vocabulary: PlanVocabulary,
): string[] {
  const deltas: string[] = []
  if (expected.batchSize !== actual.batchSize) {
    deltas.push(
      `batch size ${String(expected.batchSize)} (${vocabulary.expected}) vs ${String(actual.batchSize)} (${vocabulary.actual})`,
    )
  }
  const actualByName = new Map(actual.steps.map((step) => [step.name, step] as const))
  const expectedByName = new Map(expected.steps.map((step) => [step.name, step] as const))
  for (const step of expected.steps) {
    const other = actualByName.get(step.name)
    if (other === undefined) {
      deltas.push(`step '${step.name}' ${vocabulary.missingActual}`)
      continue
    }
    if (other.revision !== step.revision) {
      deltas.push(
        `step '${step.name}' revision '${shortRevision(step.revision)}' (${vocabulary.expected}) vs ` +
          `'${shortRevision(other.revision)}' (${vocabulary.actual})`,
      )
    } else if (other.kind !== step.kind || other.classification !== step.classification) {
      deltas.push(
        `step '${step.name}' integration contract differs between ${vocabulary.expected} and ${vocabulary.actual}`,
      )
    }
  }
  for (const step of actual.steps) {
    if (!expectedByName.has(step.name)) deltas.push(`step '${step.name}' ${vocabulary.missingExpected}`)
  }
  const expectedSequence = expected.steps.map((step) => step.name).filter((name) => actualByName.has(name))
  const actualSequence = actual.steps.map((step) => step.name).filter((name) => expectedByName.has(name))
  if (expectedSequence.length > 0 && expectedSequence.join(">") !== actualSequence.join(">")) {
    deltas.push(
      `step order ${expectedSequence.join("→")} (${vocabulary.expected}) vs ${actualSequence.join("→")} (${vocabulary.actual})`,
    )
  }
  return deltas
}

/** Leg (c): the plan THIS PROCESS installed against the plan the base tip
 * declares now. A declared step this process never installed has no Job to
 * execute, so every Run at that tip refuses with `declared-step-not-installed`
 * — the finding predicts that refusal and names the restart that closes it.
 * Any other delta (a changed command revision, a dropped step, a reorder, a
 * batch change) means this process's step definitions are stale: Runs still
 * follow git for WHICH steps run, but the commands they execute and the
 * admission projections come from the set this process built at startup. */
export function installedPlanStale(
  base: string,
  tip: DeclaredPlanAt,
  installed: QueuePlanDescriptor,
  /** Whose installed plan this is: "this process" (the default, a full host
   * judging its own runtime) or the habitant whose PUBLISHED plan the
   * supervisor probe compares, e.g. "the habitant runner (pid 4242)". */
  subject = "this process",
): QueueAuditFindingEmission | undefined {
  const deltas = planDeltas(tip, installed, {
    expected: `${base} tip ${shortSha(tip.sha)}`,
    actual: subject,
    missingActual: `is declared at the tip but not installed in ${subject}`,
    missingExpected: `is installed in ${subject} but no longer declared at the tip`,
  })
  if (deltas.length === 0) return undefined
  const installedNames = new Set(installed.steps.map((step) => step.name))
  const missing = tip.steps.filter((step) => !installedNames.has(step.name)).map((step) => `'${step.name}'`)
  const consequence =
    missing.length > 0
      ? `Every Run at this tip would refuse with declared-step-not-installed because ${missing.join(", ")} ` +
        `${missing.length === 1 ? "has" : "have"} no Job in ${subject}. `
      : "Runs read WHICH steps run from git, but the commands they execute and the admission projections come " +
        `from the step definitions ${subject} built at startup, which no longer match the tip. `
  return {
    code: "installed-plan-stale",
    message:
      `yrd: ${subject} installed ${planArrow(installed.steps)} (batch ${String(installed.batchSize)}), but ` +
      `${base} tip ${shortSha(tip.sha)} (config blob ${shortSha(tip.configBlobSha)}) declares ` +
      `${planArrow(tip.steps)} (batch ${String(tip.batchSize)}): ${deltas.join("; ")}. ${consequence}` +
      "Restart this queue runner so it builds the declared steps.",
    // Not a yrd command, so it cannot be lifted from the prose; without this
    // the projection would print "retry the same command", which is exactly
    // wrong for a process that must be replaced.
    resolution: [INSTALLED_PLAN_STALE_RESOLUTION],
  }
}

/** The one remedy for a stale installed plan, spelled once for the audit, the
 * health probe and the habitant reload path. */
export const INSTALLED_PLAN_STALE_RESOLUTION =
  "Restart the habitant queue runner so it builds the steps the base declares."

/** A recorded Run disagreeing with the repository is a forensic fact, not
 * something a retry or a restart changes. */
export const RUN_PLAN_MISMATCH_RESOLUTION =
  "Inspect the journal and the repository history: a Run's record must equal the config at its base."

/** Leg (a): a recorded Run against what git declares at that Run's own base
 * sha, with the checks-before-queueing stage counted as execution.
 *
 * The judged plan (`stepSelection.steps`) was read from that very blob, so
 * its names and order equal the derivation by construction; a delta there
 * means the journal and the repository disagree. Each declared step must then
 * have EXECUTED somewhere: in the Run itself, or at admission for the Run's
 * own base sha (every member, name and revision) — the Run reuses that
 * evidence by design and runs only the remainder. Only a step neither stage
 * executed, a revision that does not match the derivation, or a blob the
 * repository does not hold at that base is a finding. */
export function runPlanMismatch(
  recorded: RecordedRunPlan,
  declared: DeclaredPlanAt,
  admissionFor?: AdmissionLookup,
): QueueAuditFindingEmission | undefined {
  const plan = recorded.plan ?? recorded.steps.map((step) => step.name)
  const declaredByName = new Map(declared.steps.map((step) => [step.name, step] as const))
  const problems: string[] = []
  if (plan.join(">") !== declared.steps.map((step) => step.name).join(">")) {
    problems.push(`the judged plan ${plan.join("→")} is not the plan git derives there (${planArrow(declared.steps)})`)
  }
  const places = accountRunSteps(recorded, admissionFor)
  for (const place of places) {
    const expected = declaredByName.get(place.name)
    if (place.where === "missing") {
      problems.push(
        `step '${place.name}' is declared at that base and executed neither in the Run nor at admission for base ${shortSha(recorded.baseSha)}`,
      )
      continue
    }
    if (expected !== undefined && place.revision !== undefined && place.revision !== expected.revision) {
      problems.push(
        `step '${place.name}' executed ${place.where === "run" ? "in the Run" : "at admission"} at revision ` +
          `'${shortRevision(place.revision)}', but git at that base derives '${shortRevision(expected.revision)}'`,
      )
    }
  }
  const planned = new Set(plan)
  for (const step of recorded.steps) {
    if (!planned.has(step.name)) {
      problems.push(`step '${step.name}' executed in the Run but is not in the judged plan`)
    }
  }
  const blobMismatch = recorded.configBlobSha !== undefined && recorded.configBlobSha !== declared.configBlobSha
  if (problems.length === 0 && !blobMismatch) return undefined
  const blobs = blobMismatch
    ? `The record names config blob ${shortSha(recorded.configBlobSha)}, but git holds blob ` +
      `${shortSha(declared.configBlobSha)} at that base. `
    : `Both name config blob ${shortSha(declared.configBlobSha)}. `
  return {
    code: "run-plan-mismatch",
    message:
      `yrd: run ${recorded.run} (started ${recorded.startedAt}) was judged by the plan ${plan.join("→")} ` +
      `read from base ${shortSha(recorded.baseSha)}${problems.length === 0 ? "" : `: ${problems.join("; ")}`}. ${blobs}` +
      "A Run's record must equal the config at its base and every declared check must have executed in the Run " +
      "or at admission for that base; this one does not hold — inspect the journal and the repository history " +
      "before trusting either.",
    resolution: [RUN_PLAN_MISMATCH_RESOLUTION],
  }
}

/** Leg (b), informational: how the tip's plan relates to the most recent
 * declared-at-base Run. "Config changed" is claimed ONLY when the blob
 * actually differs; with the same blob the line accounts for WHERE each
 * declared check executed — the Run, or admission at the Run's own base —
 * because a merge-only Run whose checks passed at admission is the designed
 * shape, not a gap (item 0: a live audit read exactly that as "did not run"). */
export function tipSinceLatestRun(
  base: string,
  tip: DeclaredPlanAt,
  latest: RecordedRunPlan,
  admissionFor?: AdmissionLookup,
): string {
  const plan = latest.plan ?? latest.steps.map((step) => step.name)
  const places = accountRunSteps(latest, admissionFor)
  const execution = describeStepExecution(places, latest.baseSha)
  if (latest.configBlobSha === tip.configBlobSha) {
    const judged =
      plan.join(">") === tip.steps.map((step) => step.name).join(">")
        ? "the plan the tip declares"
        : `${plan.join("→")} — NOT the plan the tip derives from the same blob; see run-plan-mismatch`
    return (
      `latest run ${latest.run} (base ${shortSha(latest.baseSha)}, blob ${shortSha(latest.configBlobSha)}) ` +
      `was judged by ${judged}: ${execution}.`
    )
  }
  const tipNames = tip.steps.map((step) => step.name)
  const planSet = new Set(plan)
  const tipSet = new Set(tipNames)
  const changes = [
    ...tipNames
      .filter((name) => !planSet.has(name))
      .map((name) => `step '${name}' is declared at the tip and was not in that run's plan`),
    ...plan
      .filter((name) => !tipSet.has(name))
      .map((name) => `step '${name}' was in that run's plan and is no longer declared at the tip`),
  ]
  const shared = plan.filter((name) => tipSet.has(name))
  const sharedAtTip = tipNames.filter((name) => planSet.has(name))
  if (shared.join(">") !== sharedAtTip.join(">")) {
    changes.push(`step order ${shared.join("→")} (run) vs ${sharedAtTip.join("→")} (tip)`)
  }
  return (
    `config changed since run ${latest.run} (blob ${shortSha(latest.configBlobSha)} → ${shortSha(tip.configBlobSha)})` +
    `${changes.length === 0 ? " without changing the declared step names" : `: ${changes.join("; ")}`}. ` +
    `That run: ${execution}. The next run uses the new plan ${planArrow(tip.steps)}.`
  )
}
