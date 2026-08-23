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

/** One recorded Run's plan, as the journal holds it: the descriptors that
 * judged it plus where that list came from (23192 records the source and, for
 * a declared plan, the base and config blob shas it was read from). */
export type RecordedRunPlan = Readonly<{
  run: string
  startedAt: string
  steps: readonly InstalledStep[]
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
    ...(selection?.source === undefined ? {} : { source: selection.source }),
    ...(selection?.authority === undefined ? {} : { authority: selection.authority }),
    ...(selection?.baseSha === undefined ? {} : { baseSha: selection.baseSha }),
    ...(selection?.configBlobSha === undefined ? {} : { configBlobSha: selection.configBlobSha }),
  }
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
): QueueAuditFindingEmission | undefined {
  const deltas = planDeltas(tip, installed, {
    expected: `${base} tip ${shortSha(tip.sha)}`,
    actual: "this process",
    missingActual: "is declared at the tip but not installed in this process",
    missingExpected: "is installed in this process but no longer declared at the tip",
  })
  if (deltas.length === 0) return undefined
  const installedNames = new Set(installed.steps.map((step) => step.name))
  const missing = tip.steps.filter((step) => !installedNames.has(step.name)).map((step) => `'${step.name}'`)
  const consequence =
    missing.length > 0
      ? `Every Run at this tip would refuse with declared-step-not-installed because ${missing.join(", ")} ` +
        `${missing.length === 1 ? "has" : "have"} no Job in this process. `
      : "Runs read WHICH steps run from git, but the commands they execute and the admission projections come " +
        "from the step definitions this process built at startup, which no longer match the tip. "
  return {
    code: "installed-plan-stale",
    message:
      `yrd: this process installed ${planArrow(installed.steps)} (batch ${String(installed.batchSize)}), but ` +
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
 * health probe and the resident reload path. */
export const INSTALLED_PLAN_STALE_RESOLUTION =
  "Restart the resident queue runner so it builds the steps the base declares."

/** A recorded Run disagreeing with the repository is a forensic fact, not
 * something a retry or a restart changes. */
export const RUN_PLAN_MISMATCH_RESOLUTION =
  "Inspect the journal and the repository history: a Run's record must equal the config at its base."

/** Leg (a): a recorded Run's plan against what git declares at that Run's own
 * base sha. Equal by construction — the Run read its plan from that very blob
 * — so any delta means the record and the repository disagree about what
 * judged the Run: the config bytes at that base are not the blob the record
 * names, or the same bytes now derive different step descriptors than the
 * ones that executed (a stale process ran an older definition under the
 * declared name). Both blob shas and both lists are printed. */
export function runPlanMismatch(
  recorded: RecordedRunPlan,
  declared: DeclaredPlanAt,
): QueueAuditFindingEmission | undefined {
  const deltas = planDeltas(
    { batchSize: declared.batchSize, steps: declared.steps },
    // The record carries no batch size of its own to compare; the declared one
    // is echoed so only the step descriptors are judged here.
    { batchSize: declared.batchSize, steps: recorded.steps },
    {
      expected: `git at base ${shortSha(declared.sha)}`,
      actual: `run ${recorded.run}`,
      missingActual: `is declared at that base but the run never executed it`,
      missingExpected: `executed in the run but is not declared at that base`,
    },
  )
  const blobMismatch = recorded.configBlobSha !== undefined && recorded.configBlobSha !== declared.configBlobSha
  if (deltas.length === 0 && !blobMismatch) return undefined
  const blobs = blobMismatch
    ? `The record names config blob ${shortSha(recorded.configBlobSha)}, but git holds blob ` +
      `${shortSha(declared.configBlobSha)} at that base. `
    : `Both name config blob ${shortSha(declared.configBlobSha)}. `
  return {
    code: "run-plan-mismatch",
    message:
      `yrd: run ${recorded.run} (started ${recorded.startedAt}) recorded the plan ${planArrow(recorded.steps)} ` +
      `read from base ${shortSha(recorded.baseSha)}, but git at ${shortSha(declared.sha)} derives ` +
      `${planArrow(declared.steps)}${deltas.length === 0 ? "" : `: ${deltas.join("; ")}`}. ${blobs}` +
      "A Run's record must equal the config at its base; this one does not, so either the journal or the " +
      "repository history has been altered since the Run — inspect both before trusting either.",
    resolution: [RUN_PLAN_MISMATCH_RESOLUTION],
  }
}

/** Leg (b), informational: how the tip's plan relates to the most recent
 * declared-at-base Run. A difference is not a finding — the next Run reads the
 * new plan from git — but it is printed with both blob shas so a reader can
 * tell "the config changed since the last Run" from "nothing changed". */
export function tipSinceLatestRun(base: string, tip: DeclaredPlanAt, latest: RecordedRunPlan): string {
  const deltas = planDeltas(
    { batchSize: tip.batchSize, steps: tip.steps },
    { batchSize: tip.batchSize, steps: latest.steps },
    {
      expected: `${base} tip ${shortSha(tip.sha)}`,
      actual: `run ${latest.run}`,
      missingActual: `is declared at the tip and did not run in that Run`,
      missingExpected: `ran in that Run and is no longer declared at the tip`,
    },
  )
  const sameBlob = latest.configBlobSha === tip.configBlobSha
  if (deltas.length === 0 && sameBlob) {
    return `latest run ${latest.run} (base ${shortSha(latest.baseSha)}, blob ${shortSha(latest.configBlobSha)}) ran ${planArrow(latest.steps)}, the plan the tip declares.`
  }
  if (deltas.length === 0) {
    return (
      `latest run ${latest.run} (base ${shortSha(latest.baseSha)}) ran ${planArrow(latest.steps)}; the config blob ` +
      `changed since (${shortSha(latest.configBlobSha)} → ${shortSha(tip.configBlobSha)}) without changing the declared plan.`
    )
  }
  return (
    `config changed since run ${latest.run} (blob ${shortSha(latest.configBlobSha)} → ${shortSha(tip.configBlobSha)}): ` +
    `${deltas.join("; ")}. The next run uses the new plan ${planArrow(tip.steps)}.`
  )
}
