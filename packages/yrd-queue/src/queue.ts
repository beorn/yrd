import {
  GitRefSchema,
  GitShaSchema,
  RECEIVER_REMOTE_NAME,
  ChangeAlreadyMergedSchema,
  ChangeAdmissionRecordedFactSchema,
  ChangeIntegratedSchema,
  PRIdSchema,
  ChangeNeedsAuthorFactSchema,
  ChangeCheckabilityConflict,
  baseIdentity,
  checkRequest,
  checksRequested,
  currentChangeRev,
  normalizeV2Submitter,
  changeBaseSha,
  changeAdmission,
  changeComposition,
  changeDeliveryState,
  changeHead,
  changeNeedsAuthor,
  changeRevisionNumber,
  changeSourceReadyAt,
  resolveBase,
  changeNotFoundMessage,
  reviewState,
  type ChangeProps,
  type BaysState,
  type HasBays,
  type Change,
  type ChangeAdmission,
  type ChangeAdmissionRecord,
  type ChangeAdmissionRecordedFact,
  type ChangeAdmissionStep,
  type PrNumberMint,
} from "@yrd/bay"
import {
  command,
  compareNatural,
  event,
  failureFact,
  journalEvent,
  JsonSchema,
  observeYrdLifecycle,
  parseJournalFrame,
  raiseFailure,
  stage,
  type CommandHandler,
  type CommandResult,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type JsonValue,
  type JournalHistory,
  type YrdDef,
  type YrdDeliveryIdentity,
  type YrdLifecycleOutcome,
} from "@yrd/core"
import {
  createJobDef,
  Job,
  JobErrorSchema,
  localRunner,
  type HasJobs,
  type HasRunner,
  type JobDef,
  type JobDefs,
  type JobError,
  type JobObservation,
  type JobCompletion,
  type JobHandler,
  type JobResult,
  type JobsState,
  type Jobs,
  type Runner,
  type RunJobOptions,
} from "@yrd/job"
import { computed, type ReadSignal } from "@silvery/signals"
import type { StepKind } from "@yrd/config"
import type { ConditionalLogger } from "loggily"
import * as z from "zod"
import { CandidateFailureResultEvidenceSchema, candidateFailureResultEvidence } from "./check-attribution.ts"
import {
  CandidateSchema,
  IntegrationProofSchema,
  QueuePauseSchema,
  QueueMemberIdSchema,
  QueueRecordSchema,
  ReplayQueueRecordSchema,
  Queues,
  ChangeSnapshotSchema,
  arbitrateDerivedChange,
  latestChangeSnapshot,
  maxChangeSnapshotRevision,
  resolveMemberById,
  type AddStepResult,
  type BatchConfig,
  type Candidate,
  type InstalledStep,
  type IntegratedShape,
  type IntegrationProof,
  type QueueAuditEmission,
  type QueueAuditFinding,
  type QueueAuditFindingEmission,
  type QueueAdmissionRefusal,
  type QueueAuthorityState,
  type QueueAuthorityToken,
  type QueueFailure,
  type QueuePause,
  type QueueRecord,
  type QueueRequirement,
  type Run,
  type RunConclusion,
  type RunAuthority,
  type RunId,
  type QueueSummary,
  type QueuesState,
  type QueueStep,
  type StepName,
  DeclaredStepPlanSchema,
  type DeclaredStepPlan,
  type DeclaredStepPlanAtBase,
  type StepSelection,
  type ChangeEligibility,
  type ChangeCheckRecord,
  type ChangeShape,
  type ChangeSnapshot,
  type DerivedChange,
  type ResolvedMember,
  type UnrecordedSubmit,
} from "./model.ts"
import {
  DerivedRunMemberSchema,
  deriveRunMemberArgs,
  derivedAuthorityLookup,
  derivedLaneBranches,
  materializeDerivedRunMembers,
  type DerivedAuthorityLookup,
  type DerivedRunMember,
  type DerivedSubmitEnrichment,
} from "./derived-admission.ts"
import {
  activeQueueRootIds,
  childRunId,
  indexQueueChild,
  indexQueueStart,
  latestExactRunId,
  latestPrefixRunId,
  latestRootRunId,
  projectionLookupGet,
  projectionLookupSet,
  projectionLookupValues,
  queueLookupKey,
  recordReleasedAdmissionFailure,
  releasedAdmissionFailures,
} from "./projection-index.ts"
import { candidateRefFor } from "./candidate-refs.ts"
import { compactQueuesState, queueRetentionRoot } from "./retention.ts"

/**
 * A queue command refused to compose because a peer's Queue run already holds
 * the base branch. Always thrown, never returned, so a genuine caller error
 * still fails loud. The carried `base`/`runId` let a habitant, multi-tenant
 * runner tell this losable "the queue is busy right now" race apart from other
 * failures — without matching on the message text. For a long-lived habitant
 * watch this is losable: the peer's run settles and frees the base by the next
 * interval, so defer and retry (see isQueueRunningConflict). A one-shot
 * targeted `queue run <selector>` still sees it propagate — it has no next
 * interval.
 */
export class QueueRunningConflict extends Error {
  readonly base: string
  readonly runId: string

  constructor(base: string, runId: string) {
    super(`yrd: queue '${base}' is running '${runId}'`)
    this.name = "QueueRunningConflict"
    this.base = base
    this.runId = runId
  }
}

/** True when an error is a QueueRunningConflict — a peer already holds the base.
 * A losable race for a habitant runner: defer this cycle and retry next. */
export function isQueueRunningConflict(error: unknown): error is QueueRunningConflict {
  return error instanceof QueueRunningConflict
}

const StepNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/iu)
const QueueRequirementSchema = z.enum(["review"])
const RunIdSchema = z.string().trim().min(1)
const CandidateCreatedSchema = CandidateSchema.omit({ createdAt: true })
const StepExecutionSchema = z
  .object({
    run: RunIdSchema,
    step: StepNameSchema,
    index: z.number().int().nonnegative(),
    prs: z.array(ChangeSnapshotSchema).min(1),
    targetSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/iu)
      .optional(),
    /** Immutable Candidate facts carried into every fresh Job request. Optional
     * only while replaying pre-target-model Jobs. */
    candidate: CandidateCreatedSchema.optional(),
    shape: JsonSchema,
  })
  .strict() as unknown as z.ZodType<StepExecution>

const AdmissionStepArgsSchema = z
  .object({
    pr: ChangeSnapshotSchema,
    candidate: CandidateCreatedSchema,
    step: StepNameSchema,
    index: z.number().int().nonnegative(),
    shape: JsonSchema,
  })
  .strict()
type AdmissionStepArgs = Readonly<z.infer<typeof AdmissionStepArgsSchema>>

const QueueRunArgsSchema = z
  .object({
    prs: z.array(z.string().trim().min(1)).optional(),
    steps: z.array(StepNameSchema).optional(),
    /** Exact queue tip resolved by the effectful Queue facade before dispatch. */
    baseSha: GitShaSchema.optional(),
    /** The step plan the config at `baseSha` declares, read from git by the
     * effectful Queue facade. The default authority for this run: `apply` is a
     * pure reducer and cannot read a blob itself. */
    declaredPlan: DeclaredStepPlanSchema.optional(),
    /** Immutable Candidate facts prepared by the effectful Queue facade. */
    candidate: CandidateCreatedSchema.optional(),
    /** Derived members — branches running from their live submit fact with no
     * record (S6 door design §2). Identity minted by the driver at admission
     * time (commit-before-escape); apply re-validates each against the live
     * submit fact and materializes it for the same selection the records get.
     * Until the door retires the 2b intake sweep no live caller builds this. */
    derived: z.array(DerivedRunMemberSchema).optional(),
  })
  .strict()
export type QueueRunArgs = Readonly<z.infer<typeof QueueRunArgsSchema>>

const QueueRunReuseCoveredSchema = z
  .object({
    kind: z.literal("reusable-prefix-covered"),
    members: z.array(z.string().trim().min(1)).min(1),
    source: z.enum(["queue-run", "revision-admission"]),
    selectedSteps: z.array(StepNameSchema).min(1),
    coveredSteps: z.array(StepNameSchema).min(1),
    coveredCount: z.number().int().positive(),
    reason: z.literal("reusable prefix fully covered the selected plan"),
    reusedFrom: RunIdSchema.optional(),
  })
  .strict()
type QueueRunReuseCovered = Readonly<z.infer<typeof QueueRunReuseCoveredSchema>>

/** A considered carrier with a record: the change and the revision the verdict is about. */
const ConsideredRecordRowSchema = z
  .object({
    pr: z.string().trim().min(1),
    revision: z.number().int().positive(),
    code: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict()
/** A considered carrier WITHOUT a record: a branch approved in git that nothing can run yet (2a). */
const ConsideredUnrecordedRowSchema = z
  .object({
    branch: z.string().trim().min(1),
    sha: GitShaSchema,
    code: z.literal("unrecorded-submit"),
    reason: z.string().trim().min(1),
  })
  .strict()
const QueueRunNoRunnablePRsSchema = z
  .object({
    kind: z.literal("no-runnable-prs"),
    considered: z.array(z.union([ConsideredRecordRowSchema, ConsideredUnrecordedRowSchema])).min(1),
    selectedSteps: z.array(StepNameSchema).min(1),
    reason: z.literal("every considered PR was ineligible for the selected plan"),
  })
  .strict()
type QueueRunNoRunnablePRs = Readonly<z.infer<typeof QueueRunNoRunnablePRsSchema>>

/**
 * The OTHER zero: nothing was submitted, so nothing was considered. Until
 * 2026-08-21 this case returned `{ events: [] }` with no value and logged
 * nothing, so "I found nothing submitted" and "I never looked" were the same
 * bytes — the silent-zero instrument shape that let six surfaces report
 * healthy through the 2026-08-16 freeze (@pm/incidents/22881, ruling 22895:
 * absence of a required fact is a refusal with a reason, never a filter).
 * `considered` above is `.min(1)` on purpose; this is the shape for zero, and
 * it names the population it looked at (every record, by delivery state) and
 * what the caller excluded, so an empty FIFO and a FIFO whose members are all
 * claimed elsewhere read differently.
 */
const QueueRunNoSubmittedPRsSchema = z
  .object({
    kind: z.literal("no-submitted-prs"),
    population: z.record(z.string().trim().min(1), z.number().int().nonnegative()),
    excluded: z.number().int().nonnegative(),
    selectedSteps: z.array(StepNameSchema).min(1),
    reason: z.literal("no submitted or ready PR is visible to the queue"),
  })
  .strict()
type QueueRunNoSubmittedPRs = Readonly<z.infer<typeof QueueRunNoSubmittedPRsSchema>>

function queueRunReuseCovered(
  members: readonly string[],
  selected: readonly RuntimeStep[],
  source: QueueRunReuseCovered["source"],
  reusedFrom?: RunId,
): QueueRunReuseCovered {
  const coveredSteps = selected.map((step) => step.name)
  return QueueRunReuseCoveredSchema.parse({
    kind: "reusable-prefix-covered",
    members,
    source,
    selectedSteps: coveredSteps,
    coveredSteps,
    coveredCount: coveredSteps.length,
    reason: "reusable prefix fully covered the selected plan",
    ...(reusedFrom === undefined ? {} : { reusedFrom }),
  })
}

function queueRunNoRunnablePRs(
  decisions: readonly RunnableChangeDecision[],
  selected: readonly RuntimeStep[],
  unrecorded: readonly UnrecordedSubmit[] = [],
): QueueRunNoRunnablePRs {
  const considered = decisions.map(({ pr, eligibility }) => {
    if (eligibility.runnable || eligibility.reason === undefined) {
      throw new Error(`yrd: change '${pr.id}' was reported as rejected without an eligibility reason`)
    }
    return {
      pr: pr.id,
      revision: changeRevisionNumber(pr),
      code: eligibility.reason.code,
      reason: eligibility.reason.message,
    }
  })
  return QueueRunNoRunnablePRsSchema.parse({
    kind: "no-runnable-prs",
    considered: [
      ...considered,
      ...unrecorded.map((submit) => ({
        branch: submit.branch,
        sha: submit.sha,
        code: submit.reason.code,
        reason: submit.reason.message,
      })),
    ],
    selectedSteps: selected.map((step) => step.name),
    reason: "every considered PR was ineligible for the selected plan",
  })
}

/**
 * The approvals the queue can see but not run: every projected submit ref no
 * run has yet admitted. Since S7 there is no record lane to lose a branch to,
 * so the only question left is whether the derived lane has picked it up.
 */
function unrecordedSubmits(bays: DeepReadonly<BaysState>, queues: DeepReadonly<QueuesState>): UnrecordedSubmit[] {
  return (
    Object.entries(bays.submits)
      // S6 door: a branch the derived lane has ADMITTED at exactly this sha is a
      // MEMBER — its truth lives in run/status rows, not a refusal row. A
      // derived-lane branch nothing has admitted yet KEEPS the row: whether
      // admission can succeed needs git and wiring (Change-Id trailer, the
      // configured mint), which a projection read cannot know, and a branch the
      // queue has not picked up must stay loudly visible somewhere (A10: the
      // refusal row survives only for submits the lane has not served).
      .filter(
        ([branch, submit]) =>
          latestChangeSnapshot(
            queues as QueuesState,
            (snapshot) => snapshot.branch === branch && snapshot.headSha === submit.sha,
          ) === undefined,
      )
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([branch, submit]) => unrecordedSubmit(branch, submit))
  )
}

/**
 * Re-materialize a retained run member as the in-memory `Change` the admission
 * and eligibility machinery consumes, against the LIVE submit fact.
 *
 * This is the S7 replacement for a record lookup by id: the snapshot supplies
 * the identity a record used to hold, and the fact supplies the tree. It
 * answers `undefined` exactly when the member no longer stands — the fact
 * vanished, moved off the snapshot's sha, or the snapshot predates change-id
 * capture — so callers keep the same "this member went stale under me" branch
 * they had when a record could disappear.
 */
function materializeSnapshotMember(
  bays: DeepReadonly<BaysState>,
  member: DeepReadonly<ChangeSnapshot>,
): Change | undefined {
  if (member.intent !== undefined || member.changeId === undefined) return undefined
  const derived: DerivedRunMember = {
    branch: member.branch,
    id: member.id,
    changeId: member.changeId,
    revision: member.revision,
    headSha: member.headSha,
    ...(member.props === undefined ? {} : { props: member.props as ChangeProps }),
    ...(member.issue === undefined ? {} : { issue: member.issue }),
    ...(member.name === undefined ? {} : { title: member.name }),
  }
  try {
    return materializeDerivedRunMembers(bays, [derived])[0]
  } catch (error) {
    // A vanished or moved fact is the typed refusal this function reports as
    // `undefined`; anything else is not a staleness answer and must propagate.
    if (failureFact(error)?.kind === "refusal") return undefined
    throw error
  }
}

function unrecordedSubmit(branch: string, submit: DeepReadonly<BaysState["submits"][string]>): UnrecordedSubmit {
  return {
    branch,
    sha: submit.sha,
    base: submit.base,
    at: submit.at,
    reason: {
      code: "unrecorded-submit",
      message:
        `branch '${branch}' is submitted in git (${submit.sha.slice(0, 12)} for '${submit.base}', ` +
        `since ${submit.at}) and runs as a DERIVED member once the queue's next compose admits it (S6) — ` +
        `a row that persists means no runner is composing, derived admission is unwired (no PR-number ` +
        `mint or enrichment reader configured), the derivation was refused (action 'compose-derived-refused' ` +
        `in the queue log says why), or its admission checks refused it (action 'compose-candidate-skip', ` +
        `with the durable streak in the queue's admission-refusal ledger — 'yrd queue audit')`,
    },
  }
}

function queueRunNoSubmittedPRs(
  bays: DeepReadonly<BaysState>,
  selected: readonly RuntimeStep[],
  excluded: ReadonlySet<string>,
): QueueRunNoSubmittedPRs {
  // S7: the population the queue can see is the live submit facts, and a fact
  // that stands IS a submission — the per-delivery-state breakdown this used to
  // report was a property of records. Counting the facts keeps the refusal
  // answering "how many approvals exist that still did not run", which is the
  // question the field was added for; reporting `{}` would read as "nothing is
  // waiting" when branches are in fact queued.
  const population: Record<string, number> = {}
  const submitted = Object.keys(bays.submits).length
  if (submitted > 0) population["submitted"] = submitted
  return QueueRunNoSubmittedPRsSchema.parse({
    kind: "no-submitted-prs",
    population,
    excluded: excluded.size,
    selectedSteps: selected.map((step) => step.name),
    reason: "no submitted or ready PR is visible to the queue",
  })
}

export type AdmitSelection = Readonly<{ prs?: readonly string[] }>

const AdvanceArgsSchema = z.object({ run: RunIdSchema }).strict()
const SettledArgsSchema = AdvanceArgsSchema
/** Compatibility fact for runs whose successful projection must survive Job
 * retention. New Run lifecycle words are translated at the command boundary. */
const SettledEventSchema = SettledArgsSchema.extend({
  status: z.enum(["passed", "failed", "canceled"]).optional(),
}).strict()
const IsolateArgsSchema = AdvanceArgsSchema.extend({
  part: z.union([z.literal(0), z.literal(1)]),
  candidate: CandidateCreatedSchema.optional(),
}).strict()
type IsolateArgs = Readonly<z.infer<typeof IsolateArgsSchema>>
const BatchIsolatedSchema = z
  .object({
    parent: RunIdSchema,
    run: RunIdSchema,
    part: z.union([z.literal(0), z.literal(1)]),
    prs: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
export type PauseQueueArgs = Readonly<{
  base: string
  reason: string
  allowedPRs: readonly string[]
  expiresAt: string
}>
export type RecoverQueueOptions = Readonly<{ recoveryTime: string; reason?: string; runner?: string }>
const LegacyPauseQueueArgsSchema = z
  .object({
    base: GitRefSchema,
    reason: z.string().trim().min(1),
    allowedPRs: z.array(PRIdSchema),
  })
  .strict()
const PauseQueueArgsSchema = LegacyPauseQueueArgsSchema.extend({
  expiresAt: z.iso.datetime({ offset: true }),
})
  .strict()
  .superRefine((args, context) => {
    if (new Set(args.allowedPRs).size !== args.allowedPRs.length) {
      context.addIssue({ code: "custom", message: "duplicate allowed PR", path: ["allowedPRs"] })
    }
  }) as z.ZodType<PauseQueueArgs>
const ReplayPauseQueueArgsSchema = z.union([PauseQueueArgsSchema, LegacyPauseQueueArgsSchema])
const ResumeQueueArgsSchema = z.object({ base: GitRefSchema }).strict()
const ExpireQueuePauseArgsSchema = z
  .object({ base: GitRefSchema, expiresAt: z.iso.datetime({ offset: true }) })
  .strict()
/** One compose/admission cycle that skipped a change without producing a queue run.
 * The `compose-candidate-skip` warns that accompany it are loggily-only, so this
 * is the fact that makes a head-of-line refusal loop survive the process. */
const AdmissionRefusedSchema = z
  .object({
    pr: PRIdSchema,
    code: z.string().trim().min(1),
    kind: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1),
    /** Caller-carried identity for a member the id-seam cannot resolve: a
     * DERIVED member refused before any run retained its snapshot has no
     * record and no snapshot, and without these the refusal journaled nothing
     * (wave defect 1 — 22395 for the derived lane). Advisory when resolution
     * succeeds: the resolved member is newer truth. */
    branch: GitRefSchema.optional(),
    revision: z.number().int().positive().optional(),
    headSha: GitShaSchema.optional(),
  })
  .strict()
type AdmissionRefusedArgs = Readonly<z.infer<typeof AdmissionRefusedSchema>>
export type RecordAdmissionRefusalArgs = AdmissionRefusedArgs
/** The identity fields a refusal row needs when the id-seam cannot resolve the
 * member (a first-admission DERIVED member — no record, no retained snapshot).
 * A `DerivedRunMember` satisfies it structurally. */
type RefusedMemberIdentity = Readonly<{ id: string; branch: string; revision: number; headSha: string }>
/** `revision`/`headSha` are optional only for replaying facts written before
 * exact-revision refusal identity was introduced by 22528 (`branch` before S7);
 * new commands always populate revision and headSha. */
const AdmissionRefusedFactSchema = AdmissionRefusedSchema.strict().refine(
  (fact) => (fact.revision === undefined) === (fact.headSha === undefined),
  {
    message: "revision and headSha must be provided together",
  },
)
const SettleAdmissionRefusalSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    disposition: z.literal("needs-person"),
    reason: z.string().trim().min(1),
  })
  .strict()
export type SettleAdmissionRefusalArgs = Readonly<z.infer<typeof SettleAdmissionRefusalSchema>>
/** Consecutive refusals before `queue audit` calls a change wedged. One skip is a
 * normal losable race in a selectorless drain; a third identical cycle is not.
 *
 * Exported because the runner's self-applied-remedy pass (22474) acts on
 * exactly the PRs the queue itself calls wedged — one number, one home, so the
 * remedy can never fire earlier than the finding that justifies it. */
export const ADMISSION_REFUSAL_LOOP_THRESHOLD = 3
/**
 * Refusals a retry cannot change, because the fact they report is fixed for the
 * revision that carries it. Such a refusal needs a NEW revision, so the queue
 * parks it on the first refusal rather than re-refusing it at the head.
 *
 * `candidate-already-landed`: the member's tree is CONTAINED in the base (the
 * preparer's merge returned the base itself), so every retry re-proves the
 * same containment and every check would judge a degenerate base-vs-base
 * range — the cure is a new revision (push new commits) or retiring the
 * submission, never a re-run. (The set was empty between the re-merge
 * refactor deleting the certificate machinery's `recut-*` members and this
 * code; its park-after-1-refusal machinery waited here for exactly this.)
 */
const STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS = new Set<string>(["candidate-already-landed"])

/** How long a pushed-but-unsubmitted PR may sit before `queue audit` flags it
 * `draft-stranded`. Mirrors the 15m orphaned-run grace: long enough for a
 * deliberate push-review-submit pause, short enough that a forgotten draft
 * surfaces within the same operator session that pushed it — the live
 * specimens this covers sat 9-22 HOURS reported only by pager forensics
 * (@i/10-merge-queue/drafts-strand-silently). A re-push resets the clock:
 * age is measured from the LATEST revision's push. */
const DRAFT_STRANDED_GRACE_MS = 15 * 60 * 1000

/**
 * The one member a failure blames — but only if that member is actually here.
 *
 * A fact carrying a `pr` this partition does not contain is not attribution; it
 * is a fact about somewhere else, and acting on it would eject an innocent while
 * leaving the real refuser in place. Membership is checked, never assumed, so an
 * unrecognised id degrades to "unattributable" and the partition shares the
 * refusal exactly as it did before member isolation existed.
 */
function attributableMember(
  fact: Readonly<{ pr?: string }>,
  members: readonly Readonly<{ id: string }>[],
): string | undefined {
  const { pr } = fact
  if (pr === undefined) return undefined
  return members.some((member) => member.id === pr) ? pr : undefined
}

function structurallyPermanentAdmissionRefusal(code: string): boolean {
  return STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS.has(code)
}

const QueueStartSchema = QueueRecordSchema.omit({ startedAt: true, failure: true })
const ReplayQueueStartSchema = ReplayQueueRecordSchema.omit({ startedAt: true, failure: true })
const QueueFailedChangeSchema = z.preprocess(
  normalizeV2Submitter,
  z
    .object({
      pr: QueueMemberIdSchema,
      revision: z.number().int().positive(),
      headSha: GitShaSchema,
      submitter: z.string().trim().min(1).optional(),
    })
    .strict(),
)
const LegacyQueueFailedSchema = z.object({ run: RunIdSchema, error: JobErrorSchema }).strict()
const QueueFailedSchema = LegacyQueueFailedSchema.extend({
  prs: z.array(QueueFailedChangeSchema).min(1),
  job: z
    .object({ id: z.string().trim().min(1), attempt: z.number().int().positive() })
    .strict()
    .optional(),
}).strict()
const ReplayQueueFailedSchema = z.union([QueueFailedSchema, LegacyQueueFailedSchema])
const CancelRunArgsSchema = z
  .object({
    run: RunIdSchema,
    by: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict()
export type CancelRunArgs = Readonly<z.infer<typeof CancelRunArgsSchema>>
const QueueRunCanceledFactSchema = CancelRunArgsSchema.extend({
  pr: PRIdSchema.optional(),
  revision: z.number().int().positive().optional(),
  headSha: GitShaSchema.optional(),
}).strict()
const QuiesceLegacyRunArgsSchema = z
  .object({
    run: RunIdSchema,
    reason: z.string().trim().min(1),
  })
  .strict()
export type QuiesceLegacyRunArgs = Readonly<z.infer<typeof QuiesceLegacyRunArgsSchema>>
const SettleOrphanedRunArgsSchema = QuiesceLegacyRunArgsSchema
export type SettleOrphanedRunArgs = Readonly<z.infer<typeof SettleOrphanedRunArgsSchema>>
const QueueAuthorityTokenFactSchema = z.object({
  pr: PRIdSchema,
  revision: z.number().int().positive(),
  headSha: GitShaSchema,
})
const QueueRemergeAuthorityFactSchema = z.object({
  pr: PRIdSchema,
  successor: z.object({ revision: z.number().int().positive(), headSha: GitShaSchema }),
})
const QueueAuthorityChangeFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive().optional(),
    headSha: GitShaSchema.optional(),
  })
  .refine((fact) => (fact.revision === undefined) === (fact.headSha === undefined), {
    message: "revision and headSha must be provided together",
  })
const QueueRejectedTerminalFactSchema = z.object({
  pr: PRIdSchema,
  revision: z.number().int().positive(),
  headSha: GitShaSchema.optional(),
  run: RunIdSchema.optional(),
})
export type StepExecution<Shape extends ChangeShape = ChangeShape> = Readonly<{
  run: RunId
  step: string
  index: number
  prs: readonly ChangeSnapshot[]
  targetSha?: string
  candidate?: Readonly<Omit<Candidate, "createdAt">>
  shape: Shape
}>

export type StepRunner<Shape extends ChangeShape, Output extends JsonValue> = JobHandler<StepExecution<Shape>, Output>

declare const inputShape: unique symbol
declare const outputShape: unique symbol

export type StepDef<Input extends ChangeShape, Output extends ChangeShape> = Readonly<{
  name: string
  title: string
  revision: string
  kind: StepKind
  classification?: "base" | "carrier"
  implementationSource?: string
  job: JobDef<StepExecution, JsonValue>
  readonly [inputShape]?: Input
  readonly [outputShape]?: Output
}>

type AnyStepDef = StepDef<ChangeShape, ChangeShape>
type InputOf<Step> = Step extends StepDef<infer Input, infer _Output> ? Input : never
type OutputOf<Step> = Step extends StepDef<infer _Input, infer Output> ? Output : never
type ValidateStepChain<
  Steps extends readonly AnyStepDef[],
  Shape extends ChangeShape = ChangeShape,
> = Steps extends readonly [infer First extends AnyStepDef, ...infer Rest extends readonly AnyStepDef[]]
  ? Shape extends InputOf<First>
    ? ValidateStepChain<Rest, OutputOf<First>>
    : Readonly<{ "yrd: incompatible queue step input": never }>
  : object
type FinalShape<Steps extends readonly AnyStepDef[], Shape extends ChangeShape = ChangeShape> = Steps extends readonly [
  infer First extends AnyStepDef,
  ...infer Rest extends readonly AnyStepDef[],
]
  ? FinalShape<Rest, OutputOf<First>>
  : Shape

export type StepOptions<Output extends JsonValue> = Readonly<{
  revision: string
  title?: string
  kind?: Exclude<StepKind, "merge">
  classification?: "base" | "carrier"
  output?: z.ZodType<Output>
}>

export function withStep<const Name extends string, Shape extends ChangeShape, Output extends JsonValue>(
  name: Name,
  runner: StepRunner<Shape, Output>,
  options: StepOptions<Output>,
): StepDef<Shape, AddStepResult<Shape, Name, Output>> {
  const stepName = StepNameSchema.parse(name)
  const output = options.output ?? (JsonSchema as z.ZodType<Output>)
  const job = createJobDef({
    name: `queue.step.${stepName}`,
    title: options.title ?? stepName,
    revision: options.revision,
    input: StepExecutionSchema,
    output,
    observe: stepObservation,
    observeResult: stepResultObservation,
    execute: (input, context) => runner(input as StepExecution<Shape>, context),
  }) as JobDef<StepExecution, JsonValue>
  return Object.freeze({
    name: stepName,
    title: job.title,
    revision: job.revision,
    kind: options.kind ?? "check",
    ...(options.classification === undefined ? {} : { classification: options.classification }),
    job,
  }) as StepDef<Shape, AddStepResult<Shape, Name, Output>>
}

export function withMerge<Shape extends ChangeShape>(
  runner: StepRunner<Shape, IntegrationProof>,
  options: Readonly<{ revision: string; title?: string; implementationSource?: string }>,
): StepDef<Shape, Shape & IntegratedShape> {
  const job = createJobDef({
    name: "queue.step.merge",
    title: options.title ?? "merge",
    revision: options.revision,
    input: StepExecutionSchema,
    output: IntegrationProofSchema,
    observe: stepObservation,
    observeResult: stepResultObservation,
    execute: (input, context) => runner(input as StepExecution<Shape>, context),
  }) as JobDef<StepExecution, JsonValue>
  return Object.freeze({
    name: "merge",
    title: job.title,
    revision: job.revision,
    kind: "merge",
    ...(options.implementationSource === undefined ? {} : { implementationSource: options.implementationSource }),
    job,
  }) as StepDef<Shape, Shape & IntegratedShape>
}

export type QueueOptions<Steps extends readonly AnyStepDef[]> = Readonly<{
  steps: Steps
  batch?: BatchConfig
  defaultSteps?: readonly string[]
  /** Base branch used by selectorless drains for records that deliberately carry no base pin. */
  defaultBase?: string
  requires?: readonly QueueRequirement[]
  resolveBaseSha?(base: string): string | Promise<string>
  /** Read the step plan the config at an exact base sha declares. Git is the
   * authority for WHICH steps run; this process's installed set is the
   * authority for which ones it can execute, and a plan naming a step it never
   * installed refuses rather than running a shorter list (23192). Absent for
   * embedded hosts with no repository, which fall back to the installed set. */
  resolveDeclaredPlan?(baseSha: string): DeclaredStepPlanAtBase | Promise<DeclaredStepPlanAtBase>
  prepareCandidate?: CandidatePreparer
  /** The durable PR-number mint (S6 door): derived-member admission mints its
   * identity here at admission time, commit-before-escape — the SAME store the
   * bays plugin holds, so numbering stays one monotone sequence. Absent, the
   * compose cannot admit ref-only branches that need a fresh identity; each
   * such branch is warned and stays visible as an unrecorded-submit row. */
  prNumberMint?: PrNumberMint
  /** Read a DERIVED member's admission enrichment from git — the tip commit's
   * Change-Id trailer and any props/issue/title the host derives (S6 door:
   * records no longer mint, so admission is where identity/props enter).
   * Absent, admission still reuses retained snapshot identities and mints a
   * fresh branch's change id synthetically from its submit facts (branch, tip
   * sha) — only the props/issue/title enrichment is lost. */
  readSubmitEnrichment?(
    input: Readonly<{ branch: string; sha: string }>,
  ): DerivedSubmitEnrichment | Promise<DerivedSubmitEnrichment>
  /** Repository-truth sink for one immutable terminal merge record. */
  recordMerge?: (input: Readonly<{ run: Run; candidate: Candidate }>) => Promise<void>
  runner?: (jobs: Jobs) => Runner
  /** Progress SLO declaration. Audit emits facts; paging remains a Hab concern. */
  progress?: QueueProgressPolicy
  /**
   * Static role routing for a `needs-person` disposition (an admission
   * refusal with no mechanical remedy) — declared once for the repository
   * (`.yrd.yml` `needsPerson.owner`), never guessed at read time. Unset keeps
   * {@link DEFAULT_NEEDS_PERSON_OWNER}, which reads as explicitly unowned
   * rather than silently omitting the fact
   * (@i/10-merge-queue/22918-needs-person-unowned).
   */
  needsPersonOwner?: string
}>

/** Built-in candidate width when a repository does not declare `batch`. */
export const DEFAULT_QUEUE_BATCH_SIZE = 1

/** Resolve the configured batching vocabulary to the width Queue executes. */
function effectiveBatchSize(config: BatchConfig | undefined = DEFAULT_QUEUE_BATCH_SIZE): number {
  if (config === false) return 1
  if (!Number.isInteger(config) || config < 0) {
    throw new Error("yrd: batch size must be false or a non-negative integer")
  }
  return config <= 1 ? 1 : config
}

export type QueueProgressPolicy = Readonly<{
  noLandingMs: number
  refusalCount: number
  /**
   * Admission checks required inside the no-merge window before a TRIED queue
   * reads as stuck. A duration alone fires 37 times across this journal's
   * history, and an alarm that fires 37 times is an alarm somebody mutes: gaps
   * between merges reach 53 minutes at the 90th percentile.
   *
   * ZERO checks is deliberately NOT quiet, and that asymmetry is the whole
   * point. Two different failures both look like "no merge":
   *
   *   - tried and failing — many attempts, nothing merges. Needs this floor.
   *   - never tried at all — work is ready, the runner is alive, and NOTHING
   *     has attempted it. PR685 sat ready at position 1 for 65 minutes over a
   *     live runner while `queue audit` stayed empty (@cto, 2026-08-10).
   *
   * A merge restarts the window, so a candidate whose only check request
   * predates that merge has zero checks inside it. Treating zero as "too
   * quiet to alarm" would hide precisely the queue that is asleep over ready
   * work. Only the middle band — tried recently, but not much — stays silent,
   * because that is ordinary retry cadence.
   */
  minAdmissionChecks: number
}>

export const DEFAULT_QUEUE_PROGRESS_POLICY: QueueProgressPolicy = Object.freeze({
  noLandingMs: 30 * 60_000,
  refusalCount: ADMISSION_REFUSAL_LOOP_THRESHOLD,
  minAdmissionChecks: 10,
})

/**
 * Owner string a `needs-person` finding carries when no repository config
 * names one. Deliberately a sentence, not a blank or `undefined` — the
 * finding's `owner` field is never omitted, so an unconfigured repository
 * still SHOWS the empty slot to a reader instead of the reader having to
 * infer it from an absent field (@i/10-merge-queue/22918-needs-person-unowned).
 */
export const DEFAULT_NEEDS_PERSON_OWNER = "unowned — no needsPerson.owner is configured in .yrd.yml"

export type QueueAuditOptions = Readonly<{ now?: string }>

export type CandidatePreparationInput = Readonly<{
  id: string
  queueId: string
  baseSha: string
  revs: Candidate["revs"]
  prs: readonly ChangeSnapshot[]
}>

export type PreparedCandidate = Omit<Candidate, "createdAt" | "mergeability"> &
  Readonly<{ mergeability: "mergeable" | "conflicting" }>

export type CandidatePreparer = (input: CandidatePreparationInput) => PreparedCandidate | Promise<PreparedCandidate>

type QueueState = Readonly<{ queues: QueuesState }>
type QueueHostState = Readonly<{ bays: BaysState; jobs: JobsState }>
export type QueueRuntimeState = QueueHostState & QueueState
type RuntimeState = QueueRuntimeState
type QueueStart = Omit<QueueRecord, "startedAt" | "failure">

function queueBase(state: DeepReadonly<RuntimeState>, selector: string): string {
  const known = [
    "main",
    ...Object.values(state.bays.byId).map((bay) => bay.base),
    // The bases changes are targeting, read from the live submit facts since S7
    // — the record bases this replaces named exactly the same thing.
    ...Object.values(state.bays.submits).map((submit) => submit.base),
    ...Queues.values(state.queues).map((run) => run.base),
    ...Object.values(state.queues.pauses).map((pause) => pause.base),
  ]
  return resolveBase(known, selector) ?? baseIdentity(selector)
}

export type QueueCommands = Readonly<{
  queue: Readonly<{
    admissionStep: CommandHandler<AdmissionStepArgs, RuntimeState>
    run: CommandHandler<QueueRunArgs, RuntimeState>
    pause: CommandHandler<PauseQueueArgs, RuntimeState>
    expirePause: CommandHandler<Readonly<{ base: string; expiresAt: string }>, RuntimeState>
    resume: CommandHandler<Readonly<{ base: string }>, RuntimeState>
    advance: CommandHandler<Readonly<{ run: RunId }>, RuntimeState>
    settled: CommandHandler<Readonly<{ run: RunId }>, RuntimeState>
    isolate: CommandHandler<IsolateArgs, RuntimeState>
    retireStalePlan: CommandHandler<Readonly<{ run: RunId }>, RuntimeState>
    cancelRun: CommandHandler<CancelRunArgs, RuntimeState>
    quiesceLegacyRun: CommandHandler<QuiesceLegacyRunArgs, RuntimeState>
    settleOrphanedRun: CommandHandler<SettleOrphanedRunArgs, RuntimeState>
    admissionRefused: CommandHandler<AdmissionRefusedArgs, RuntimeState>
    settleAdmissionRefusal: CommandHandler<SettleAdmissionRefusalArgs, RuntimeState>
  }>
}>

export type Queue<Shape extends ChangeShape = ChangeShape> = Readonly<{
  readonly shape?: Shape
  state: ReadSignal<DeepReadonly<QueuesState>>
  steps(): readonly InstalledStep[]
  /** Admit immutable PR revisions and return the admitted PR ids. */
  /** RETIRED (S7 branch-is-change): always refuses `retired-command`. Admission
   * work is selected from the compose's DERIVED batch, and this verb has no
   * parameter that carries one — `AdmitSelection` is `{ prs?: string[] }`, so
   * every `admissionQueue(...)` it could reach was handed the empty default and
   * the population was unconditionally `[]`. The live path is a compose:
   * `run` -> `drainAdmissions` -> `dispatchAdmissions`, which pass the derived
   * batch. The surface survives one step so pre-S7 callers fail loud with the
   * replacement named instead of not compiling. */
  admit(args: AdmitSelection, options?: RunJobOptions): Promise<readonly string[]>
  pause(args: PauseQueueArgs): Promise<QueuePause>
  /** Clear holds whose exact recorded deadline has passed. The deadline fence
   * prevents a stale timer from clearing a renewed hold. */
  expirePauses(now: string): Promise<readonly QueuePause[]>
  resume(base: string): Promise<void>
  run(args: QueueRunArgs, options: QueueRunOptions): Promise<readonly Run[]>
  waiting(selector: string, step?: string): WaitingQueueStep
  waitingAdmission(selector: string, step?: string): WaitingAdmissionStep | undefined
  finish(selector: string, completion: FinishQueueArgs, options: RunJobOptions): Promise<Run>
  finishAdmission(selector: string, completion: FinishQueueArgs, options: RunJobOptions): Promise<void>
  cancel(args: CancelQueueArgs): Promise<readonly Run[]>
  /** Cancel every unfinished standalone admission Job for one exact PR revision. */
  cancelAdmissionJobs(args: CancelAdmissionJobsArgs): Promise<readonly string[]>
  cancelRun(args: CancelRunArgs): Promise<Run>
  recover(options: RecoverQueueOptions): Promise<readonly Run[]>
  audit(options?: QueueAuditOptions): QueueAuditEmission
  eligibility(selector: string, snapshot?: DeepReadonly<QueueRuntimeState>): ChangeEligibility
  /**
   * Branches approved in git (`refs/yrd/submit/*`, projected by the receiver)
   * that the DERIVED lane has not yet admitted at their current sha (S6) —
   * visible with the reason, retiring once a retained run snapshot serves the
   * branch.
   */
  unrecordedSubmits(snapshot?: DeepReadonly<QueueRuntimeState>): readonly UnrecordedSubmit[]
  /** One branch, both sources (record + submit ref), one answer — including
   * the S6 newest-truth arbitration verdict (`authority`), advisory while
   * record writes still flow. */
  deriveChange(branch: string, snapshot?: DeepReadonly<QueueRuntimeState>): DerivedChange
  /** Store-first by id (the S6 id-seam): a record answers when one exists;
   * otherwise the newest retained run snapshot naming the id does — the only
   * home a post-door derived member's identity has. */
  resolveMember(selector: string, snapshot?: DeepReadonly<QueueRuntimeState>): ResolvedMember | undefined
  /** PR batches whose revisions may be refreshed before the next selectorless drain.
   * Queue owns this projection because it must preserve the same candidate
   * partitioning, batch size, and FIFO order as compose. */
  freshnessCandidateBatches(): readonly (readonly string[])[]
  /** RETIRED (S7 branch-is-change): always refuses `retired-command`. The
   * repository IS the merge authority — merged-truth and the merge-record
   * notes are the read side; nothing reconciles INTO a record index anymore.
   * The surface survives one step so pre-S7 callers fail loud with the
   * replacement named instead of not compiling; it deletes with the store. */
  reconcileMerge(args: z.infer<typeof ChangeIntegratedSchema>): Promise<void>
  /** Live PR ids in the exact admission order used by a selectorless drain. */
  admissionOrder(): readonly string[]
  quiesceLegacyRoots(options: QuiesceLegacyRootsOptions): Promise<QuiesceLegacyRootsResult>
  /** Journal a preparation refusal that happened outside Queue's own admission
   * dispatcher, so the same durable wedge oracle sees every compose robot. */
  recordAdmissionRefusal(args: RecordAdmissionRefusalArgs): Promise<void>
  /** Stop selecting one exact refused revision after its automated remedy has
   * reached a durable needs-person outcome. A new revision clears the fact. */
  settleAdmissionRefusal(args: SettleAdmissionRefusalArgs): Promise<void>
  get(run: RunId): Run | undefined
  retentionDiagnostics(): Readonly<{
    retainedRuns: number
    unsettledTrees: number
    terminalTrees: number
    archiveAvailable: boolean
  }>
  history(): Promise<readonly Run[]>
  status(base: string): QueueSummary
}>

export type QuiesceLegacyRootsOptions = Readonly<{
  /** ISO timestamp used to decide whether a legacy root's writer lease is still live. */
  now: string
  /** Migration identity recorded on each settled job cancellation. */
  by: string
}>

export type QuiesceLegacyRootsResult = Readonly<{
  provenance: "migration/21012-legacy-quiesce"
  reason: "legacy-quiesced"
  quiesced: readonly Readonly<{ run: RunId; jobs: readonly string[] }>[]
}>

export type QueueRunOptions = RunJobOptions & Readonly<{ continueAdmissions?: () => boolean }>

export type WaitingQueueStep = Readonly<{
  run: Run
  step: QueueStep & Readonly<{ job: Extract<Job, { status: "waiting" }> }>
}>

export type WaitingAdmissionStep = Readonly<{
  pr: string
  revision: number
  step: Readonly<{ name: string; job: Extract<Job, { status: "waiting" }> }>
}>

export type FinishQueueArgs = Omit<JobCompletion, "token"> & Readonly<{ job: Job["id"]; step?: string; token: string }>

export type CancelQueueArgs = Readonly<{
  prs: readonly string[]
  by: string
  reason: string
}>

export type CancelAdmissionJobsArgs = Readonly<{
  pr: string
  revision: number
  by: string
  reason: string
}>

export type HasQueue<Shape extends ChangeShape = ChangeShape> = Readonly<{ queue: Queue<Shape> }>

export type QueuePlugin<Shape extends ChangeShape> = (<
  State extends object,
  Commands extends CommandTree,
  Features extends HasJobs & HasBays,
>(
  definition: YrdDef<State, Commands, Features>,
) => YrdDef<State & QueueState, Commands & QueueCommands, Features & HasQueue<Shape> & HasRunner>) &
  Readonly<{ jobDefs: JobDefs }>

export function withQueue<const Steps extends readonly AnyStepDef[]>(
  options: QueueOptions<Steps> & ValidateStepChain<Steps>,
): QueuePlugin<FinalShape<Steps>> {
  const steps = installSteps(options.steps, options.defaultSteps)
  const progress = validateQueueProgressPolicy(options.progress ?? DEFAULT_QUEUE_PROGRESS_POLICY)
  const trimmedOwner = options.needsPersonOwner?.trim()
  const needsPersonOwner = trimmedOwner === undefined || trimmedOwner === "" ? DEFAULT_NEEDS_PERSON_OWNER : trimmedOwner
  const byName = new Map(steps.map((step) => [step.name, step] as const))
  const batchSize = effectiveBatchSize(options.batch)
  validateSequence(declaredDefaultSteps(steps), false)
  // The declared plan is DELIBERATELY not seeded into the initial state. The
  // projection's checkpoint identity is a hash of `initialState` (plus the
  // registered event schemas), so while the declared check set lived here an
  // ordinary `.yrd.yml` edit was indistinguishable from a schema change: it
  // invalidated every stored checkpoint, forced a replay a retention-evicted
  // journal cannot serve, and refused any Candidate carrying it with
  // `checkpoint-migration-certificate-missing`. The declaration reaches the
  // plan through the installed step set instead (`declaredDefaultSteps`).
  const initial = Queues.empty({
    batchSize,
    ...(options.requires === undefined ? {} : { requires: z.array(QueueRequirementSchema).parse(options.requires) }),
  })
  const jobDefs = Object.freeze(Object.fromEntries(steps.map((step) => [step.job.name, step.job])))
  const commands = createQueueCommands(steps, byName, needsPersonOwner, options.prepareCandidate !== undefined)

  const install = <State extends object, Commands extends CommandTree, Features extends HasJobs & HasBays>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      initialState: { queues: initial },
      commands,
      events: {
        "queue/candidate/created": journalEvent(1, CandidateCreatedSchema),
        "queue/run/started": journalEvent(1, z.object({ run: QueueStartSchema }).strict()),
        "queue/run/failed": journalEvent(1, QueueFailedSchema),
        "queue/run/canceled": journalEvent(1, QueueRunCanceledFactSchema),
        "queue/run/settled": journalEvent(1, SettledEventSchema),
        "queue/paused": journalEvent(2, PauseQueueArgsSchema),
        "queue/pause/expired": journalEvent(1, ExpireQueuePauseArgsSchema),
        "queue/resumed": journalEvent(1, ResumeQueueArgsSchema),
        "queue/batch/isolated": journalEvent(1, BatchIsolatedSchema),
        "queue/admission/refused": journalEvent(1, AdmissionRefusedFactSchema),
        "queue/admission/settled": journalEvent(1, SettleAdmissionRefusalSchema),
      },
      replayEvents: {
        "queue/paused": ReplayPauseQueueArgsSchema,
        "queue/candidate/created": CandidateCreatedSchema,
        "queue/run/started": z.object({ run: ReplayQueueStartSchema }).strict(),
        "queue/run/failed": ReplayQueueFailedSchema,
        "queue/run/canceled": QueueRunCanceledFactSchema,
        "queue/run/settled": SettledEventSchema,
      },
      projectionVersion: "queues-v11-component-model-ruling-spend",
      project: projectQueues,
      compact: (state, complete) => {
        const runtime = complete as unknown as DeepReadonly<RuntimeState>
        return { queues: compactQueueProjection(state.queues, runtime.jobs, runtime.bays) }
      },
      create(yrd) {
        yrd.jobs.requireDefinitions(jobDefs)
        const configuredRunner = options.runner?.(yrd.jobs)
        const runner =
          configuredRunner ??
          localRunner({
            id: "local",
            jobs: yrd.jobs,
            leaseMs: 5 * 60_000,
          })
        if (Symbol.asyncDispose in runner) {
          yrd.scope.use(runner as Runner & AsyncDisposable)
        }
        return {
          runner,
          queue: createQueue(
            computed(() => yrd.state().queues),
            () => yrd.state() as unknown as DeepReadonly<RuntimeState>,
            yrd.jobs,
            {
              refresh: () => yrd.refresh(),
              admissionStep: (args) => yrd.dispatch(commands.queue.admissionStep, args),
              run: (args) => yrd.dispatch(commands.queue.run, args),
              pause: (args) => yrd.dispatch(commands.queue.pause, args),
              expirePause: (args) => yrd.dispatch(commands.queue.expirePause, args),
              resume: (base) => yrd.dispatch(commands.queue.resume, { base }),
              advance: (run) => yrd.dispatch(commands.queue.advance, { run }),
              settled: (run) => yrd.dispatch(commands.queue.settled, { run }),
              isolate: (run, part, candidate) =>
                yrd.dispatch(commands.queue.isolate, {
                  run,
                  part,
                  ...(candidate === undefined ? {} : { candidate }),
                }),
              retireStalePlan: (run) => yrd.dispatch(commands.queue.retireStalePlan, { run }),
              cancelRun: (args) => yrd.dispatch(commands.queue.cancelRun, args),
              quiesceLegacyRun: (args) => yrd.dispatch(commands.queue.quiesceLegacyRun, args),
              settleOrphanedRun: (args) => yrd.dispatch(commands.queue.settleOrphanedRun, args),
              admissionRefused: (args) => yrd.dispatch(commands.queue.admissionRefused, args),
              settleAdmissionRefusal: (args) => yrd.dispatch(commands.queue.settleAdmissionRefusal, args),
            },
            steps,
            options.defaultBase,
            options.resolveBaseSha,
            options.resolveDeclaredPlan,
            options.prepareCandidate,
            options.recordMerge,
            options.prNumberMint,
            options.readSubmitEnrichment,
            configuredRunner,
            progress,
            needsPersonOwner,
            yrd.log.child("queue"),
            yrd.history,
            async () => (await yrd.historySnapshot()).state as unknown as DeepReadonly<RuntimeState>,
          ),
        }
      },
    })

  Object.defineProperty(install, "jobDefs", { value: jobDefs, enumerable: true })
  return Object.freeze(install) as unknown as QueuePlugin<FinalShape<Steps>>
}

/** An installed step, plus the one bit that says whether the queue's DECLARED
 * configuration puts it in the default plan.
 *
 * The marker lives on the installed set — not in `QueuesState` — because the
 * declaration is a property of this process's configuration, and the durable
 * state is a record of what already ran. Before 23192 the default plan was read
 * back out of `queues.defaultSteps`, so a checkpoint written before a check was
 * declared kept that check from ever executing, and no restart could activate
 * it: replaying the checkpoint replayed the stale list. */
type RuntimeStep = AnyStepDef & Readonly<{ declaredDefault: boolean }>
type QueueActions = Readonly<{
  refresh(): Promise<unknown>
  admissionStep(args: AdmissionStepArgs): Promise<CommandResult>
  run(args: QueueRunArgs): Promise<CommandResult>
  pause(args: PauseQueueArgs): Promise<CommandResult>
  expirePause(args: Readonly<{ base: string; expiresAt: string }>): Promise<CommandResult>
  resume(base: string): Promise<CommandResult>
  advance(run: RunId): Promise<CommandResult>
  settled(run: RunId): Promise<CommandResult>
  isolate(run: RunId, part: 0 | 1, candidate?: z.infer<typeof CandidateCreatedSchema>): Promise<CommandResult>
  retireStalePlan(run: RunId): Promise<CommandResult>
  cancelRun(args: CancelRunArgs): Promise<CommandResult>
  quiesceLegacyRun(args: QuiesceLegacyRunArgs): Promise<CommandResult>
  settleOrphanedRun(args: SettleOrphanedRunArgs): Promise<CommandResult>
  admissionRefused(args: AdmissionRefusedArgs): Promise<CommandResult>
  settleAdmissionRefusal(args: SettleAdmissionRefusalArgs): Promise<CommandResult>
}>

function createQueue<Shape extends ChangeShape>(
  state: ReadSignal<DeepReadonly<QueuesState>>,
  runtime: () => DeepReadonly<RuntimeState>,
  jobs: HasJobs["jobs"],
  actions: QueueActions,
  steps: readonly RuntimeStep[],
  defaultBase: string | undefined,
  resolveBaseSha: QueueOptions<readonly AnyStepDef[]>["resolveBaseSha"],
  resolveDeclaredPlan: QueueOptions<readonly AnyStepDef[]>["resolveDeclaredPlan"],
  prepareCandidate: CandidatePreparer | undefined,
  recordMerge: QueueOptions<readonly AnyStepDef[]>["recordMerge"],
  derivedMint: PrNumberMint | undefined,
  readSubmitEnrichment: QueueOptions<readonly AnyStepDef[]>["readSubmitEnrichment"],
  configuredRunner: Runner | undefined,
  progress: QueueProgressPolicy,
  needsPersonOwner: string,
  log: ConditionalLogger,
  history: JournalHistory<unknown> | undefined,
  historicalState: () => Promise<DeepReadonly<RuntimeState>>,
): Queue<Shape> {
  const current = (id: RunId): Run => materializeRun(Queues.record(state(), id), runtime().jobs)
  const byName = new Map(steps.map((step) => [step.name, step] as const))
  const reportZeroEventRun = (value: JsonValue | undefined): boolean => {
    const covered = QueueRunReuseCoveredSchema.safeParse(value)
    if (covered.success) {
      log.warn?.("queue run emitted zero events because a reusable prefix covered every selected step", {
        action: "queue-run-reuse-covered",
        ...covered.data,
      })
      return true
    }
    const rejected = QueueRunNoRunnablePRsSchema.safeParse(value)
    if (rejected.success) {
      log.warn?.("queue run emitted zero events because every considered PR was ineligible", {
        action: "queue-run-no-runnable-prs",
        ...rejected.data,
      })
      return true
    }
    const empty = QueueRunNoSubmittedPRsSchema.safeParse(value)
    if (empty.success) {
      // info, not warn: an empty FIFO is the habitant runner's normal state
      // most of the day, and a warning that fires every tick is the noise
      // that gets a channel muted. The line still exists, with its population,
      // so an honest empty is distinguishable from a run that never looked.
      log.info?.("queue run emitted zero events because nothing is submitted", {
        action: "queue-run-no-submitted-prs",
        ...empty.data,
      })
      return true
    }
    return false
  }

  const persistMergeRecord = async (run: Run): Promise<void> => {
    if (recordMerge === undefined || !Queues.terminal(run)) return
    const candidate = runtime().queues.candidates[run.candidateId]
    if (candidate === undefined) {
      throw new Error(`yrd: queue run '${run.id}' names missing Candidate '${run.candidateId}'`)
    }
    await recordMerge({ run, candidate: candidate as Candidate })
  }

  type CycleBaseResolver = (base: string) => Promise<string>
  const createBaseResolutionCycle = (): CycleBaseResolver | undefined => {
    if (resolveBaseSha === undefined) return undefined
    const resolved = new Map<string, Promise<string>>()
    return (selector) => {
      const base = baseIdentity(selector)
      let result = resolved.get(base)
      if (result === undefined) {
        result = Promise.resolve(resolveBaseSha(base))
        resolved.set(base, result)
      }
      return result
    }
  }

  type CyclePlanResolver = (baseSha: string) => Promise<DeclaredStepPlan>
  const createDeclaredPlanCycle = (): CyclePlanResolver | undefined => {
    if (resolveDeclaredPlan === undefined) return undefined
    const resolved = new Map<string, Promise<DeclaredStepPlan>>()
    return (baseSha) => {
      let result = resolved.get(baseSha)
      if (result === undefined) {
        result = Promise.resolve(resolveDeclaredPlan(baseSha)).then((plan) => ({ baseSha, ...plan }))
        resolved.set(baseSha, result)
      }
      return result
    }
  }

  const markSettledRoot = async (id: RunId): Promise<Run> => {
    const snapshot = runtime()
    const record = Queues.record(snapshot.queues, id)
    const run = materializeRun(record, snapshot.jobs)
    if (record.parent === undefined && !needsSettlement(snapshot, run)) await actions.settled(id)
    return current(id)
  }

  const observeRunLifecycle = (
    observed: Run,
    operation: () => Run | Promise<Run>,
    options: Readonly<{ continuation?: boolean }> = {},
  ): Promise<Run> =>
    observeYrdLifecycle(
      log,
      {
        lifecycle: "run",
        identity: { run: observed.id },
        attributes: {
          base: observed.base,
          prs: observed.prs.map(deliveryIdentity),
          steps: observed.steps.map((step) => step.name),
          ...(options.continuation === true ? { continuation: true } : {}),
        },
        outcome: queueRunOutcome,
        resultAttributes: (result) => ({
          status: result.status,
          // A run-owned failure (no step owns the ERROR) carries its JobError so
          // the human row can render `err=<slug>`; harmless on a settled run.
          ...(result.error === undefined ? {} : { error: result.error }),
        }),
      },
      operation,
    )

  const reportFreshTerminal = async (run: Run): Promise<Run> => {
    const reported = await observeRunLifecycle(run, () => current(run.id))
    await markSettledRoot(run.id)
    return reported
  }

  const archived = (id: RunId): Run | undefined => {
    if (history === undefined) return undefined
    const canonical = /^r\d+$/iu.test(id.trim()) ? id.trim().toUpperCase() : id
    return materializeArchivedRun(history, jobs, state(), canonical)
  }

  /** Recovery passes its tolerant reader; the ordinary drain paths pass nothing
   * and keep failing loud, because a drain is about to WRITE over this state
   * while recovery is the one caller whose whole job is meeting it broken. */
  const cleanupSettledRoots = async (reader?: TolerantQueueReader): Promise<readonly RunId[]> => {
    const cleaned: RunId[] = []
    for (const id of activeQueueRootIds(runtime().queues)) {
      const snapshot = runtime()
      const record = Queues.record(snapshot.queues, id)
      const run = reader === undefined ? materializeRun(record, snapshot.jobs) : reader.read(record, snapshot.jobs)
      if (run === undefined) continue
      if (record.parent !== undefined || needsSettlement(snapshot, run)) continue
      const result = await actions.settled(id)
      if (result.events.length > 0) {
        cleaned.push(id)
        // A root that reaches its settlement THROUGH this sweep — typically a
        // crash-replayed run whose steps all finished before the crash — must
        // leave the same durable trail as one settled by the drive path:
        // without this its repository merge record is never persisted.
        await persistMergeRecord(run)
      }
    }
    return cleaned
  }

  /**
   * S6 door — DERIVED admission of ref-only approvals, replacing the retired
   * 2b intake sweep (census #3): every live projected submit ref on a
   * RECORDLESS branch ({@link derivedLaneBranches} — one lane consumes one
   * push; a branch with record history is the record lane's, warned per
   * compose below) becomes a derived run member — identity minted here at
   * admission time under the durable PR-number mint (commit-before-escape),
   * enrichment (Change-Id trailer, props, issue) read from git through the
   * host's configured reader, and the ChangeSnapshot the run journals is the
   * identity's only durable home. No record is minted, and the DERIVED lane
   * retires no submit fact: the fact IS the submission, and it stands until
   * the receiver sweeps the ref (branch delete) or a re-push renews it. Since
   * S7 nothing retires a fact on merge at all: the record lane's terminal was
   * the only emitter of `branch/unsubmitted` reason "superseded".)
   *
   * Loud-edge policy, carried from the sweep it replaces: a typed refusal or
   * infrastructure fact attributable to ONE branch (vanished/moved fact,
   * record-lane collision, submit facts too non-canonical to mint a synthetic
   * change id from) is warned and skipped —
   * the branch keeps its unrecorded-submit row, so the refusal cannot go dark
   * — while a mint-store failure and any untyped throw PROPAGATE and fail the
   * compose: those need a human, not a retry loop. A duplicate payload
   * refuses at materialization inside the same policy.
   *
   * With no mint configured the lane cannot admit fresh branches: say so once
   * per compose, loudly, and leave every row standing.
   */
  const deriveRefOnlyMembers = async (
    skip: ReadonlySet<string>,
    selectors?: readonly string[],
  ): Promise<DerivedRunMember[]> => {
    const snapshot = runtime()
    // The already-landed warn that stood here read a fact's sha against a
    // terminal RECORD's integration commit — the PR2139 incident cell — and can
    // no longer be computed. The hazard it named is caught downstream by
    // authority consumption instead (see `derivedLaneBranches`), which ejects a
    // merged branch's surviving fact with a `compose-candidate-skip` warn.
    const branches = narrowToSelectableBranches(
      snapshot.queues,
      derivedLaneBranches(snapshot.bays).filter((branch) => !skip.has(branch)),
      selectors,
    )
    if (branches.length === 0) return []
    if (derivedMint === undefined) {
      log.warn?.(
        "queue compose cannot admit ref-only branches: no PR-number mint is configured for derived admission " +
          "— configure the queue plugin's prNumberMint (the durable pr-mint.json store the bays plugin shares); " +
          "the derived lane is the only submission path, so every row stands until the mint exists",
        {
          action: "compose-derived-mint-missing",
          branches,
        },
      )
      return []
    }
    const derived: DerivedRunMember[] = []
    for (const branch of branches) {
      const submit = snapshot.bays.submits[branch]
      if (submit === undefined) continue
      try {
        const enrichment =
          readSubmitEnrichment === undefined ? undefined : await readSubmitEnrichment({ branch, sha: submit.sha })
        const member = deriveRunMemberArgs({
          bays: snapshot.bays,
          queues: snapshot.queues,
          mint: derivedMint,
          branch,
          ...(enrichment === undefined ? {} : { enrichment }),
        })
        derived.push(member)
        log.info?.("queue compose derived an admission for a branch submitted only in git", {
          action: "compose-derived-admitted",
          branch,
          sha: submit.sha,
          base: submit.base,
          pr: member.id,
          revision: member.revision,
        })
      } catch (error) {
        const fact = failureFact(error)
        if (fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) {
          throw error
        }
        log.warn?.("queue compose could not derive an admission for a submitted branch; its row stands", {
          action: "compose-derived-refused",
          branch,
          sha: submit.sha,
          base: submit.base,
          code: fact.code,
          kind: fact.kind,
          reason: fact.message,
        })
        continue
      }
    }
    return derived
  }

  const waiting = (selector: string, stepName?: string): WaitingQueueStep => {
    const snapshot = runtime()
    // S7: only a RUN selector reaches a waiting step. The change arm here
    // resolved a selector against the record store and then searched the queue
    // summary for a run holding that member; with no store there is nothing for
    // a bare change selector to resolve to, and the ambiguity between a run id
    // and a change id it used to arbitrate cannot arise.
    const record = Queues.resolve(snapshot.queues, selector)
    if (record === undefined) {
      raiseFailure("refusal", "queue-selection-missing", `yrd: no queue run '${selector}'`)
    }
    const selected = materializeRun(record, snapshot.jobs)

    const pending = selected.steps.filter((step) => step.job?.status === "waiting")
    const step =
      stepName === undefined
        ? pending.length === 1
          ? pending[0]
          : undefined
        : selected.steps.find((item) => item.name === stepName)
    if (stepName === undefined && pending.length !== 1) {
      raiseFailure(
        "refusal",
        pending.length === 0 ? "queue-step-not-waiting" : "queue-step-ambiguous",
        `yrd: queue run '${selected.id}' ${pending.length === 0 ? "has no waiting step" : "has multiple waiting steps; select one"}`,
      )
    }
    if (step?.job?.status !== "waiting") {
      raiseFailure(
        "refusal",
        "queue-step-not-waiting",
        `yrd: queue run '${selected.id}' has no waiting '${stepName ?? "unknown"}' step`,
      )
    }
    return { run: selected, step: step as WaitingQueueStep["step"] }
  }

  const drive = async (id: RunId, options: RunJobOptions): Promise<Run> => {
    while (true) {
      const snapshot = runtime()
      const run = materializeRun(Queues.record(snapshot.queues, id), snapshot.jobs)
      if (Queues.terminal(run) && !needsAdvance(snapshot, run)) return run
      const active = run.steps[run.cursor]
      if (active?.job?.status === "queued") {
        const guarded = await actions.advance(id)
        if (guarded.events.length > 0) continue
        try {
          const candidate = snapshot.queues.candidates[run.candidateId]
          if (candidate === undefined) {
            throw new Error(`yrd: queue run '${run.id}' names missing Candidate '${run.candidateId}'`)
          }
          const needsCandidate = active.kind !== "merge" && !("integration" in run.shape)
          const materializesCandidate = configuredRunner !== undefined && needsCandidate
          const runner =
            configuredRunner ??
            localRunner({
              id: options.runner,
              jobs,
              leaseMs: options.leaseMs,
              ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
              ...(options.now === undefined ? {} : { now: options.now }),
            })
          const submitted = await runner.submit({
            job: active.job.id,
            context: materializesCandidate
              ? { scope: "job", candidate: "rw", capabilities: ["git"] }
              : { scope: "job", candidate: "none" },
            ...(materializesCandidate && candidate.ref !== undefined ? { candidateRef: candidate.ref } : {}),
          })
          if (submitted.status === "completed" && submitted.conclusion === "cancelled") {
            log.warn?.("Another Yrd runner finished this job first; using its result.", {
              action: "canceled-skip",
              run: id,
              job: submitted.id,
              status: submitted.status,
              conclusion: submitted.conclusion,
              reason: "Runner observed a terminal cancellation while submitting the queued Job",
            })
          }
        } catch (cause) {
          // merge-queue R43: a peer runtime can cancel (or otherwise settle)
          // the Job between this runtime's ownership check and its settlement
          // commit — the commit re-folds the journal, meets the terminal Job,
          // and the transition guard throws. That guard protects state
          // integrity and stays; HERE the condition is recoverable: the Job is
          // already settled, so record a loud typed skip and keep composing
          // instead of killing the habitant runner. The skip is
          // terminal-state-verified against the refreshed projection — any
          // failure while the Job is still live propagates unchanged.
          await actions.refresh()
          const raced = runtime().jobs.byId[active.job.id]
          if (raced === undefined || !Job.terminal(raced)) throw cause
          log.warn?.("Another Yrd runner finished this job first; using its result.", {
            action: "canceled-skip",
            run: id,
            job: active.job.id,
            status: raced.status,
            ...(raced.status === "completed" ? { conclusion: raced.conclusion } : {}),
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        }
        continue
      }
      if (active?.job?.status === "in_progress" || active?.job?.status === "waiting") {
        const guarded = await actions.advance(id)
        if (guarded.events.length > 0) continue
        return run
      }
      const advanced = await actions.advance(id)
      if (advanced.events.length === 0) return current(id)
    }
  }

  const settle = async (id: RunId, options: RunJobOptions): Promise<Run> => {
    const observed = current(id)
    const continuation = observed.steps.some((step) => step.job !== undefined && step.job.status !== "queued")
    // Stale re-report guard #1: a run with nothing left to settle has ALREADY
    // emitted its one run lifecycle at its real settlement. Return it untouched —
    // no drive, no re-emit.
    if (!needsSettlement(runtime(), observed)) {
      const settled = await markSettledRoot(id)
      await persistMergeRecord(settled)
      return settled
    }

    const settleTree = async (): Promise<Run> => {
      const settled = await drive(id, options)
      if (!bisectable(settled)) return settled
      for (const part of [0, 1] as const) {
        let snapshot = runtime()
        let child = childQueue(snapshot.queues, snapshot.jobs, settled.id, part)
        if (child === undefined) {
          const parentCandidate = snapshot.queues.candidates[settled.candidateId]
          if (parentCandidate === undefined) {
            throw new Error(`yrd: queue run '${settled.id}' names missing Candidate '${settled.candidateId}'`)
          }
          const pivot = Math.ceil(settled.prs.length / 2)
          const prs = part === 0 ? settled.prs.slice(0, pivot) : settled.prs.slice(pivot)
          const candidate = await candidateFactsForSnapshots(prs, parentCandidate.baseSha)
          await actions.isolate(settled.id, part, candidate)
          snapshot = runtime()
          child = childQueue(snapshot.queues, snapshot.jobs, settled.id, part)
        }
        if (child === undefined) {
          throw new Error(`yrd: queue run '${settled.id}' did not create isolation part ${part}`)
        }
        await settle(child.id, options)
      }
      return current(id)
    }

    // Stale re-report guard #2: a run that is ALREADY terminal at entry but still
    // needs settlement is a bisection parent whose child runs are being driven
    // this cycle. Its own status/outcome is fixed, so its run lifecycle was
    // emitted when it first settled — progress the bisection tree WITHOUT
    // re-observing the parent (re-emitting a terminal run each cycle with a bogus
    // few-millisecond duration is the "R603 re-reported later, durationMs:3"
    // artifact). The child runs observe their own settlements.
    if (Queues.terminal(observed)) {
      await settleTree()
      const settled = await markSettledRoot(id)
      await persistMergeRecord(settled)
      return settled
    }

    const result = await observeRunLifecycle(observed, settleTree, { continuation })
    await persistMergeRecord(result)
    await markSettledRoot(id)
    return result
  }

  /**
   * Re-point each carrier's check request at this cycle's base.
   *
   * THE SET PASSED IN MUST BE THE SET THE DRAIN ADMITS FROM. A carrier admitted
   * against a base that no check request of its own names has its authority
   * counted against the wrong triple, so the verdict decides on evidence nobody
   * refreshed for it — the shape that shut the fleet's only merge path
   * (@yrd/core/refresh-coverage-gap). Callers get that set from
   * {@link admissionQueue} when the drain is selectorless and from their own
   * explicit targets when it is not; see the compose path below.
   *
   * DELIBERATELY EXCLUDED: a carrier with no live check request. This re-points
   * an identity, it never mints one — granting a request to a carrier that
   * never asked for checks would push it into the admission queue on the
   * strength of a housekeeping pass.
   */
  const refreshCheckIdentities = async (
    _prs: readonly DeepReadonly<Change>[],
    _resolveCycleBase: CycleBaseResolver | undefined,
  ): Promise<void> => {
    // S7: check authority is the live submit fact, pinned to exactly the
    // submit sha — admission pins the cycle base per dispatch. The record
    // lane's `pr/checks-requested` re-point verb is deleted with the mint;
    // record members exist only as replayed history and never re-enter
    // admission (the cutover gate drains active record runs first), so there
    // is nothing left to re-point for anyone.
  }

  const resolveCandidateBaseSha = async (
    prs: readonly DeepReadonly<Change>[],
    resolveCycleBase: CycleBaseResolver | undefined,
  ): Promise<string> => {
    const first = prs[0]
    if (first === undefined) throw new Error("yrd: a Candidate requires at least one change")
    const base = baseIdentity(first.base)
    if (prs.some((pr) => baseIdentity(pr.base) !== base)) {
      throw new Error("yrd: one Candidate cannot span base branches")
    }
    if (resolveCycleBase !== undefined) return resolveCycleBase(base)
    return requiredCandidateBaseSha(prs.map(Queues.snapshot))
  }

  // 22332: ids reserved by in-flight prepares. `nextCandidateId` reads the
  // journal-only max, and the journal row merges after the prepare, so two
  // concurrent prepares would otherwise both be handed the same `C<n>`. The ref
  // no longer depends on this id — it is content-addressed — but the JOURNAL
  // identity still has to be unique, which is what this set protects.
  const reservedCandidateIds = new Set<string>()
  const allocateCandidateId = (): string => {
    const journaled = Object.keys(runtime().queues.candidates)
      .filter((id) => /^C\d+$/u.test(id))
      .map((id) => Number(id.slice(1)))
    const reserved = [...reservedCandidateIds].filter((id) => /^C\d+$/u.test(id)).map((id) => Number(id.slice(1)))
    return `C${Math.max(0, ...journaled, ...reserved) + 1}`
  }

  const candidateFactsForSnapshots = async (
    snapshots: readonly DeepReadonly<ChangeSnapshot>[],
    baseSha: string,
  ): Promise<z.infer<typeof CandidateCreatedSchema> | undefined> => {
    const pinned = pinCandidateBaseSha(snapshots, baseSha)
    const existing = candidateFor(runtime().queues, pinned, baseSha)
    if (existing !== undefined && existing.mergeability !== "unknown") {
      const { createdAt: _createdAt, ...facts } = existing
      return CandidateCreatedSchema.parse(facts)
    }
    if (prepareCandidate === undefined) return undefined
    const first = pinned[0]
    if (first === undefined) throw new Error("yrd: a Candidate requires at least one change")
    const queueId = queueIdentity(first)
    const revs = pinned.map((member) => ({ pr: member.id, n: member.revision, head: member.headSha }))
    const id = allocateCandidateId()
    reservedCandidateIds.add(id)
    const input: CandidatePreparationInput = {
      id,
      queueId,
      baseSha,
      revs,
      prs: pinned,
    }
    // 22332: there is no retry-on-`candidate-ref-refused` here any more, and its
    // absence is the point. While the ref was named after this id, bumping the id
    // genuinely moved the prepare to a free ref. Now the ref is derived from the
    // composed evidence, so a fresh id re-runs the identical compose and targets
    // the identical ref: a retry could not have succeeded, it could only have
    // paid for 32 more composes before surfacing the same fault. The remaining
    // refusals are real infrastructure faults, and they surface at once.
    const prepared = CandidateCreatedSchema.parse(await prepareCandidate(input))
    if (
      prepared.id !== input.id ||
      prepared.queueId !== input.queueId ||
      prepared.baseSha !== input.baseSha ||
      prepared.revs.length !== input.revs.length ||
      prepared.revs.some((revision, index) => {
        const expected = input.revs[index]
        return (
          expected === undefined ||
          revision.pr !== expected.pr ||
          revision.n !== expected.n ||
          revision.head !== expected.head
        )
      })
    ) {
      throw new Error(`yrd: Candidate preparer changed immutable content identity for '${input.id}'`)
    }
    if (prepared.mergeability === "unknown") {
      throw new Error(`yrd: Candidate preparer left mergeability unknown for '${input.id}'`)
    }
    if (prepared.mergeability === "mergeable") {
      if (prepared.sha === undefined || prepared.ref === undefined) {
        throw new Error(`yrd: mergeable Candidate '${input.id}' requires a synthetic SHA and ref`)
      }
      // 22332: the ref is content-addressed, so this checks that the published
      // name states the evidence it carries — not that it matches an id chosen
      // before the evidence existed.
      if (prepared.ref !== candidateRefFor(prepared.sha)) {
        throw new Error(
          `yrd: Candidate '${input.id}' must publish ${candidateRefFor(prepared.sha)}, not '${prepared.ref}'`,
        )
      }
    }
    return prepared
  }

  const candidateFacts = (
    prs: readonly DeepReadonly<Change>[],
    baseSha: string,
  ): Promise<z.infer<typeof CandidateCreatedSchema> | undefined> =>
    candidateFactsForSnapshots(prs.map(Queues.snapshot), baseSha)

  const recordRevisionAdmission = (
    _pr: DeepReadonly<Change>,
    _admission: ChangeAdmissionRecord,
  ): Promise<CommandResult | undefined> => {
    // S7: the record-side admission copy was the duplicated authority this
    // program deletes — the verdict persists in the admission Jobs and the
    // queues-slice refusal streak, and the bay's `recordAdmission` verb is
    // gone with the mint. Nothing writes an admission onto a record again.
    return Promise.resolve(undefined)
  }

  /** The authority count this verdict may record.
   *
   * An unresolved tally used to be a durable data defect worth announcing: a
   * RECORD's check request that named no base left nothing able to say whether
   * it was granted against this verdict's base. Every member is derived since
   * S7, and a derived member's synthetic request records no base BY DESIGN (its
   * authority is the live submit fact, and no verdict is ever recorded for it),
   * so "unresolved" is now the normal shape rather than a defect — the warn it
   * used to raise would fire on every admission. */
  const verdictRequestCount = (pr: DeepReadonly<Change>, baseSha: string): number | "unresolved" => {
    return recordedRequestCount(revisionCheckRequestTally(pr, baseSha))
  }

  const refuseRevisionAdmission = async (
    pr: DeepReadonly<Change>,
    baseSha: string,
    step: string,
    result: JobError,
    options: Readonly<{
      candidate?: string
      kind?: Extract<ChangeAdmissionRecord, { status: "refused" }>["kind"]
      steps?: readonly ChangeAdmissionStep[]
    }> = {},
  ): Promise<
    Readonly<{ code: string; kind: Extract<ChangeAdmissionRecord, { status: "refused" }>["kind"]; reason: string }>
  > => {
    const kind = options.kind ?? admissionFailureKind(result, false)
    await recordRevisionAdmission(pr, {
      status: "refused",
      kind,
      baseSha,
      requestCount: verdictRequestCount(pr, baseSha),
      ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
      steps: [...(options.steps ?? [])],
      step,
      receipt: result,
    })
    return { code: result.code, kind, reason: result.message }
  }

  type RevisionAdmissionOutcome = Readonly<{
    processed: boolean
    refusal?: Readonly<{
      code: string
      kind: Extract<ChangeAdmissionRecord, { status: "refused" }>["kind"]
      reason: string
    }>
  }>

  const admitChangeRevision = async (
    pr: DeepReadonly<Change>,
    baseSha: string,
    runOptions?: RunJobOptions,
  ): Promise<RevisionAdmissionOutcome> => {
    const selected = admissionSteps(steps)
    const prior = changeAdmission(pr)
    const freshRetry = prior?.status === "refused" && hasFreshRevisionCheckAuthority(runtime(), pr, steps)
    if (
      prior?.status === "passed" &&
      prior.baseSha === baseSha &&
      prior.steps.length === selected.length &&
      prior.steps.every(
        (evidence, index) =>
          evidence.status === "passed" &&
          evidence.name === selected[index]?.name &&
          evidence.revision === selected[index]?.revision,
      )
    ) {
      return { processed: false }
    }
    const snapshot = pinCandidateBaseSha([Queues.snapshot(pr)], baseSha)[0]
    if (snapshot === undefined) throw new Error(`yrd: required-check run lost change '${pr.id}'`)
    let prepared: z.infer<typeof CandidateCreatedSchema> | undefined
    try {
      prepared = await candidateFactsForSnapshots([snapshot], baseSha)
    } catch (error) {
      const fact = failureFact(error)
      const result = {
        code: fact?.code ?? "candidate-refused",
        message: fact?.message ?? (error instanceof Error ? error.message : String(error)),
      }
      const kind = admissionFailureKind(result, fact?.kind === "infrastructure")
      const refusal = await refuseRevisionAdmission(pr, baseSha, "candidate", result, { kind })
      if (kind === "infrastructure") throw error
      return { processed: true, refusal }
    }
    const candidate = CandidateCreatedSchema.parse(
      prepared ?? {
        id: allocateCandidateId(),
        queueId: queueIdentity(snapshot),
        baseSha,
        revs: [{ pr: snapshot.id, n: snapshot.revision, head: snapshot.headSha }],
        mergeability: "unknown",
      },
    )
    if (candidate.mergeability === "conflicting") {
      const result = {
        code: "candidate-conflicting",
        message: `Candidate '${candidate.id}' conflicts before required checks`,
      }
      const refusal = await refuseRevisionAdmission(pr, baseSha, "candidate", result, { candidate: candidate.id })
      return { processed: true, refusal }
    }
    // Queue re-entry of landed content (live specimen PR2145, 2026-08-28): a
    // member whose tree the base already contains re-enters admission — the
    // preparer's merge finds nothing to add and returns the base itself
    // (sha === baseSha) — and every check would then judge a degenerate
    // base-vs-base range (YRD_BASE_SHA == YRD_CANDIDATE_SHA), which
    // range-shaped gates refuse, while the standing submit fact re-derives the
    // member at every new tip forever. No retry changes containment: park it
    // on the first refusal ({@link STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS})
    // with the cure in the message instead of burning a check generation per
    // tip move.
    if (candidate.sha !== undefined && candidate.sha === candidate.baseSha) {
      const result = {
        code: "candidate-already-landed",
        message:
          `Candidate '${candidate.id}' for change '${pr.id}' is its own base ${baseSha.slice(0, 12)} — branch ` +
          `'${pr.branch}' adds nothing the base does not already contain (its content landed), so required ` +
          `checks would judge a degenerate base-vs-base range. Retire the submission ` +
          `('git push bay :refs/yrd/submit/${pr.branch}') or push new commits to renew it`,
      }
      const refusal = await refuseRevisionAdmission(pr, baseSha, "candidate", result, { candidate: candidate.id })
      return { processed: true, refusal }
    }
    const admissionRunner =
      configuredRunner ??
      (runOptions === undefined
        ? undefined
        : localRunner({
            id: runOptions.runner,
            jobs,
            leaseMs: runOptions.leaseMs,
            ...(runOptions.heartbeatMs === undefined ? {} : { heartbeatMs: runOptions.heartbeatMs }),
            ...(runOptions.now === undefined ? {} : { now: runOptions.now }),
          }))
    const evidence: ChangeAdmissionStep[] = []
    let shape: ChangeShape = ChangeShape([snapshot])
    for (const [index, step] of selected.entries()) {
      const requested = await actions.admissionStep({
        pr: snapshot,
        candidate,
        step: step.name,
        index,
        shape,
      })
      const key = admissionJobKey(snapshot, baseSha, index, step.revision)
      const requestedJob = jobs.requested(requested)[0]
      const jobId =
        requestedJob ?? jobs.getByKey(key)?.id ?? jobs.getByKey(admissionJobKey(snapshot, baseSha, index))?.id
      if (jobId === undefined) throw new Error(`yrd: required check '${step.name}' did not request a Job`)
      let beforeRun = jobs.get(jobId)
      if (
        freshRetry &&
        beforeRun?.status === "completed" &&
        (beforeRun.conclusion === "failure" || beforeRun.conclusion === "timed_out")
      ) {
        beforeRun = await jobs.retry(jobId)
      }
      const job =
        admissionRunner === undefined
          ? jobs.get(jobId)
          : await admissionRunner.submit({
              job: jobId,
              context:
                configuredRunner === undefined
                  ? { scope: "job", candidate: "none" }
                  : { scope: "job", candidate: "rw", capabilities: ["git"] },
              ...(configuredRunner !== undefined && candidate.ref !== undefined ? { candidateRef: candidate.ref } : {}),
            })
      if (job === undefined) throw new Error(`yrd: required check '${step.name}' lost Job '${jobId}'`)
      if (job.status !== "completed") {
        // A remote Runner may yield durable waiting work. The revision remains
        // submitted until a later observation calls this idempotent path again;
        // the standalone Job is the live progress fact, never a Queue Run.
        return { processed: requestedJob !== undefined || beforeRun?.status === "queued" }
      }
      if (job.conclusion !== "success") {
        const result = jobFailure(job)
        // Machinery failure, not a check verdict: a lost/canceled Job (the
        // classes admissionFailureKind marks "infrastructure") or a THROWN
        // callback (the job layer's registered `runner-error`). The record lane
        // used to absorb these into a durable admission-refused record; a
        // derived member — which is every member since S7 — has none to carry
        // the verdict, and no run exists yet to attribute a ledger row to, so
        // the same absorb would leave the failure recorded NOWHERE while the
        // compose resolves clean. Propagate instead — the door's own policy for
        // infrastructure: it needs a human, not a retry loop.
        if (job.conclusion !== "failure" || result.code === "runner-error") {
          raiseFailure(
            "infrastructure",
            result.code,
            `yrd: derived member '${pr.id}' required check '${step.name}' failed without a verdict ` +
              `(${result.code}): ${result.message}`,
          )
        }
        const failed: ChangeAdmissionStep = {
          name: step.name,
          revision: step.revision,
          job: job.id,
          status: "refused",
          ...("output" in job && job.output !== undefined ? { output: job.output } : {}),
          receipt: result,
        }
        const refusal = await refuseRevisionAdmission(pr, baseSha, step.name, result, {
          candidate: candidate.id,
          // A BASE-classified step describes the target environment, never the
          // member: its red is the base's own, so it must not bill the author
          // (kind "failure" presents as required-check-failed, owner author) —
          // the same base/carrier rule the delta comparator's carrier-only
          // evidence already enforces on run-path needs-author attribution.
          kind: admissionFailureKind(result, job.conclusion !== "failure" || step.classification === "base"),
          steps: [...evidence, failed],
        })
        return { processed: true, refusal }
      }
      evidence.push({
        name: step.name,
        revision: step.revision,
        job: job.id,
        status: "passed",
        output: job.output,
      })
      shape = { ...shape, results: { ...shape.results, [step.name]: job.output } }
    }
    await recordRevisionAdmission(pr, {
      status: "passed",
      baseSha,
      requestCount: verdictRequestCount(pr, baseSha),
      candidate: candidate.id,
      steps: evidence,
    })
    return { processed: true }
  }

  const waitingRevisionAdmission = (selector: string, requestedStep?: string): WaitingAdmissionStep | undefined => {
    // S7: the member and its pinned base come from the retained run snapshot —
    // the same values the record arm read off a `Change` and re-derived with
    // `Queues.snapshot`, now read from the snapshot the run already journaled.
    const member = resolveMemberById(runtime().queues, selector)?.snapshot
    if (member?.baseSha === undefined) return undefined
    const baseSha = member.baseSha
    const snapshot = pinCandidateBaseSha([member], baseSha)[0]
    if (snapshot === undefined) return undefined
    for (const [index, step] of admissionSteps(steps).entries()) {
      if (requestedStep !== undefined && step.name !== requestedStep) continue
      const job =
        jobs.getByKey(admissionJobKey(snapshot, baseSha, index, step.revision)) ??
        jobs.getByKey(admissionJobKey(snapshot, baseSha, index))
      if (job?.status !== "waiting") continue
      return { pr: member.id, revision: member.revision, step: { name: step.name, job } }
    }
    return undefined
  }

  const cancelAdmissionJobsForRevision = async (args: CancelAdmissionJobsArgs): Promise<readonly string[]> => {
    // S7: the member and its revisions come from retained run snapshots. A
    // selector no retained run names cannot have admission Jobs to cancel.
    const member = resolveMemberById(runtime().queues, args.pr)?.snapshot
    if (member === undefined) raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(runtime().bays, args.pr))
    if (maxChangeSnapshotRevision(runtime().queues, member.id) < args.revision) {
      raiseFailure("refusal", "pr-revision-not-found", `yrd: change '${member.id}' has no revision ${args.revision}`)
    }
    const prefix = admissionRevisionKeyPrefix(member.id, args.revision)
    const selected = Object.values(runtime().jobs.byId)
      .filter((job) => job.status !== "completed" && job.key?.startsWith(prefix) === true)
      .toSorted((left, right) => compareNatural(left.id, right.id))
    for (const job of selected) {
      await jobs.cancel({ id: job.id, attempt: job.attempt, by: args.by, reason: args.reason })
    }
    return selected.map((job) => job.id)
  }

  const cancelRevisionAdmissionJobs = async (pr: DeepReadonly<Change>, reason: string): Promise<void> => {
    await cancelAdmissionJobsForRevision({
      pr: pr.id,
      revision: changeRevisionNumber(pr),
      by: "yrd/queue",
      reason,
    })
  }

  const staleRevisionAdmissionJobs = (): Array<DeepReadonly<JobsState["byId"][string]>> => {
    const snapshot = runtime()
    return Object.values(snapshot.jobs.byId).filter((job) => {
      if (job.status === "completed" || job.key?.startsWith("admission:") !== true) return false
      const match = /^admission:([^:]+):(\d+):/u.exec(job.key)
      if (match === null) throw new Error(`yrd: malformed revision admission Job key '${job.key}'`)
      const [, prId, revisionText] = match
      if (prId === undefined || revisionText === undefined) {
        throw new Error(`yrd: malformed revision admission Job key '${job.key}'`)
      }
      // Judged by the DERIVED referent, the only one left: the Job's own input
      // snapshot pinned the exact branch+sha this admission checks; a retained
      // run snapshot or the durable refusal-ledger row stands in for legacy
      // jobs whose input does not parse. Stale ⇔ the live submit fact is gone
      // (the branch was unsubmitted) or it moved off the pinned sha (a re-push
      // superseded this tree) — the fact-CAS analogue of the revision-key match
      // the record arm used to make. An unresolvable identity is never stale:
      // absence must not cancel work this sweep cannot judge. (The record arm
      // is deleted with the store: keying "stale" on a `bays.prs` miss would
      // have cancelled every live derived admission the moment it emptied.)
      const input = AdmissionJobIdentitySchema.safeParse(job.input)
      const pinned = input.success ? input.data.prs[0] : undefined
      const retained =
        pinned !== undefined
          ? undefined
          : latestChangeSnapshot(snapshot.queues as QueuesState, (candidate) => candidate.id === prId)
      const row = snapshot.queues.admissionRefusals[prId]
      const identity =
        pinned ??
        (retained !== undefined
          ? { branch: retained.branch, headSha: retained.headSha }
          : row?.branch !== undefined && row.headSha !== undefined
            ? { branch: row.branch, headSha: row.headSha }
            : undefined)
      if (identity === undefined) return false
      const submit = snapshot.bays.submits[identity.branch]
      return submit === undefined || submit.sha !== identity.headSha
    })
  }

  /**
   * Journal the per-PR refusal behind every `compose-candidate-skip` warn below.
   * The warns are loggily-only — they die with the process, and a change refused at
   * ADMISSION never becomes a run record — so without this the whole class of
   * head-of-line wedge is invisible to `queue audit` (22395).
   */
  const appendAdmissionRefusal = async (args: RecordAdmissionRefusalArgs): Promise<void> => {
    await actions.admissionRefused(args)
  }

  /** A member the refusal can attribute WITHOUT the id-seam: the caller's own
   * in-hand identity — a `DerivedRunMember`, or the equivalent fields lifted
   * from a materialized `Change`. A bare selector string stays supported for
   * callers that hold nothing more. */
  type RefusalSubject = string | undefined | DeepReadonly<Change> | RefusedMemberIdentity

  const refusalSubjectIdentity = (subject: DeepReadonly<Change> | RefusedMemberIdentity): RefusedMemberIdentity =>
    "revs" in subject
      ? {
          id: subject.id,
          branch: subject.branch,
          revision: changeRevisionNumber(subject),
          headSha: changeHead(subject),
        }
      : subject

  const noteCandidateRefusal = async (
    subjects: readonly RefusalSubject[],
    refusal: Readonly<{ code?: string; kind?: string; reason: string }>,
  ): Promise<void> => {
    for (const subject of subjects) {
      if (subject === undefined) continue
      const identity = typeof subject === "string" ? undefined : refusalSubjectIdentity(subject)
      const selector = identity?.id ?? (subject as string)
      const snapshot = runtime()
      // Record first, retained snapshot second (the id-seam): a DERIVED member
      // has no record but its refusal streak must still attribute — a wedge
      // against a recordless member is exactly as invisible as 22395's. A
      // subject the seam cannot resolve still records when the caller carried
      // the member's own identity (wave defect 1: a derived member refused at
      // its FIRST admission has no snapshot yet, and skipping it left the
      // ledger empty for the lane's own population). Only a bare selector
      // that resolves to nothing is dropped: that is the `pr-not-found`
      // refusal itself, already logged loud, and a streak against a phantom
      // id would be an invented wedge.
      const pr = resolveMemberById(snapshot.queues, selector)
      if (pr === undefined && identity === undefined) continue
      try {
        await appendAdmissionRefusal({
          pr: pr?.id ?? selector,
          // A losable skip always carries a fact code; name the gap rather than
          // dropping the cycle silently if one ever does not.
          code: refusal.code ?? "unclassified-refusal",
          ...(refusal.kind === undefined ? {} : { kind: refusal.kind }),
          reason: refusal.reason,
          ...(identity === undefined
            ? {}
            : { branch: identity.branch, revision: identity.revision, headSha: identity.headSha }),
        })
      } catch (error) {
        // Bookkeeping must never convert a survivable skip into a habitant kill,
        // but it must never fail quietly either — an unrecorded cycle is exactly
        // the blindness this ledger exists to remove.
        log.error?.("queue could not journal a required-check failure; the wedge oracle will under-count", {
          action: "admission-refusal-unrecorded",
          pr: pr?.id ?? selector,
          code: refusal.code,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const noteRevisionAdmissionRefusal = async (
    pr: DeepReadonly<Change>,
    refusal: NonNullable<RevisionAdmissionOutcome["refusal"]>,
  ): Promise<void> => {
    log.warn?.("queue admit skipped a change that failed its required checks", {
      action: "compose-candidate-skip",
      pr: pr.id,
      ...refusal,
    })
    await noteCandidateRefusal([pr], refusal)
  }

  /** One admission turn's outcome. `refused` names the selectors this turn
   * skipped with a typed per-PR refusal, so the drain can release the line
   * instead of re-picking the same refused head forever (22474). */
  type AdmissionDispatch = Readonly<{ admitted: string[]; refused: readonly string[] }>

  const dispatchAdmissions = async (
    selectors: readonly string[],
    resolveCycleBase: CycleBaseResolver | undefined,
    selection?: "explicit",
    runOptions?: RunJobOptions,
    derived: readonly DeepReadonly<Change>[] = [],
  ): Promise<AdmissionDispatch> => {
    const admitted: string[] = []
    const refused: string[] = []
    // Implicit (selectorless) drains absorb per-PR terminal races; explicit
    // targeting stays fail-loud so a one-shot caller sees the real outcome.
    const selectorless = selection !== "explicit"
    for (const selector of selectors) {
      try {
        const pr = derived.find((member) => member.id === selector)
        if (pr === undefined) raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(runtime().bays, selector))
        const snapshot = runtime()
        const delivery = changeDeliveryState(pr)
        if (delivery === "integrated" || delivery === "already-landed") {
          await cancelRevisionAdmissionJobs(pr, `PR became ${delivery}`)
          continue
        }
        if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready" && delivery !== "needs-author") {
          await cancelRevisionAdmissionJobs(pr, `PR became ${delivery}`)
          throw new ChangeCheckabilityConflict(pr.id, delivery)
        }
        if (
          blockingQueuePause(snapshot, pr) !== undefined ||
          admissionSteps(steps).length === 0 ||
          runningQueue(snapshot.queues, snapshot.jobs, pr.base) !== undefined
        ) {
          continue
        }
        const baseSha = await resolveCandidateBaseSha([pr], resolveCycleBase)
        const outcome = await admitChangeRevision(pr, baseSha, runOptions)
        if (outcome.processed) admitted.push(pr.id)
        if (outcome.refusal !== undefined) {
          await noteRevisionAdmissionRefusal(pr, outcome.refusal)
          refused.push(pr.id)
        }
      } catch (error) {
        const fact = failureFact(error)
        const checkability = error instanceof ChangeCheckabilityConflict
        if (!selectorless || (!checkability && fact?.kind !== "refusal")) {
          throw error
        }
        const refusal = {
          ...(checkability ? { code: "pr-not-checkable" } : fact?.code === undefined ? {} : { code: fact.code }),
          ...(checkability ? { kind: "refusal" } : fact?.kind === undefined ? {} : { kind: fact.kind }),
          reason: error instanceof Error ? error.message : String(error),
        }
        log.warn?.("queue admit skipped a change that is no longer eligible", {
          action: "compose-candidate-skip",
          pr: selector,
          ...refusal,
        })
        await noteCandidateRefusal([derived.find((member) => member.id === selector) ?? selector], refusal)
        refused.push(selector)
      }
    }
    return { admitted, refused }
  }

  const drainAdmissions = async (
    selectors: readonly string[],
    options: QueueRunOptions,
    resolveCycleBase: CycleBaseResolver | undefined,
    selection?: "explicit",
    derived: readonly DeepReadonly<Change>[] = [],
  ): Promise<string[]> => {
    const targets = new Set(selectors)
    const admitted = new Set<string>()
    // The pre-drain sweep that cancelled admission Jobs for a selector whose
    // RECORD had reached a terminal delivery state is deleted with the store: a
    // member has no standing delivery state to have moved past. Its live
    // equivalent is `staleRevisionAdmissionJobs`, which judges the same
    // staleness by the submit fact (gone or moved off the pinned sha).
    // PRs this drain already refused. A habitant drain dispatches ONE queued PR
    // per turn (see below), so without this set a refused head is re-picked as
    // the head every turn and the drain ends having admitted nothing — the
    // head-of-line wedge (22474): PR1791 held the whole queue through 44
    // consecutive refusal cycles while seven ready PRs stacked behind it. The
    // set only releases the LINE; the refusal itself is still ledgered exactly
    // once per cycle by dispatchAdmissions.
    const released = new Set<string>()
    const remember = (candidate: Run): void => {
      for (const pr of candidate.prs) {
        if (targets.has(pr.id)) admitted.add(pr.id)
      }
    }

    while (targets.size > 0) {
      if (options.continueAdmissions?.() === false) break
      await actions.refresh()
      const snapshot = runtime()
      const selected = admissionSteps(steps)
      // Admission verdicts no longer mint Runs, but replay can still contain an
      // admission Run from before the cutover. Legacy Runs predate explicit
      // settlement claims, so activeQueueRuns() cannot discover all of them;
      // find the retired shape directly and settle it before selecting a new
      // head. This migration path must never match an integrating Run.
      const active = Queues.values(snapshot.queues)
        .filter((record) => record.stepSelection?.authority === "admission")
        .map((record) => materializeRun(record, snapshot.jobs))
        .filter((candidate) => candidate.status === "queued" || candidate.status === "in_progress")
        .filter((candidate) => selection !== "explicit" || candidate.prs.some((pr) => targets.has(pr.id)))
        .filter((candidate) => samePlan(candidate.steps, selected))
        .toSorted((left, right) => compareNatural(left.id, right.id))[0]
      if (active !== undefined) {
        const settled = await settle(active.id, options)
        remember(settled)
        if (settled.status === "in_progress") break
        continue
      }

      const queued = admissionQueue(snapshot, steps, selection === "explicit" ? targets : undefined, derived).filter(
        (pr) => !released.has(pr.id),
      )
      // A habitant (`continueAdmissions` installed) admits one change per turn so a
      // drain signal can interrupt between admissions; a one-shot dispatches the
      // whole queue in a single turn and needs no release.
      //
      // THIS LINE IS WHERE GLOBAL ADMISSION FIFO LIVES, and it is now the only
      // place. `admissionQueue` above is ordered and NOT base-filtered, so
      // taking its head serializes admissions across every base — `runningQueue`
      // in the skip test below covers only same-base overlap.
      //
      // A second guard used to claim this job: `admissionLineHolder`, a fourth
      // disjunct in that skip test, asking whether an unrefused member sat ahead
      // of this one. It was DELETED rather than repaired. Post-S7 it was called
      // without the compose's derived batch while `admissionQueue` returns
      // `[...derived]` filtered, so it answered `undefined` for every input and
      // could not fire (@refname-reach found it by construction; no test failed,
      // then or after a trial repair). Rearming it would have been worse than
      // leaving it: on the habitant path it re-asks what this line has already
      // answered — the member it is handed IS the head, so nothing is ever ahead
      // — and on the one-shot path it would have skipped every member but the
      // first, contradicting the whole-queue dispatch this same line grants on
      // purpose. The head-of-line RELEASE it was written for survives in
      // `released` above, which is the mechanism that actually carries it.
      const turn = options.continueAdmissions === undefined ? queued : queued.slice(0, 1)
      const dispatched = await dispatchAdmissions(
        turn.map((pr) => pr.id),
        resolveCycleBase,
        selection,
        options,
        derived,
      )
      for (const pr of dispatched.admitted) admitted.add(pr)
      for (const pr of dispatched.refused) released.add(pr)
      // Head-of-line release: the turn admitted nothing because it was refused,
      // and PRs behind it have not been tried yet. Take the next one. `released`
      // grows by at least one whenever this branch is taken, so `queued` strictly
      // shrinks and the loop still terminates.
      if (dispatched.refused.length > 0 && queued.length > turn.length) continue
      if (dispatched.admitted.length > 0 && dispatched.refused.length === 0) continue

      for (const selector of targets) {
        const pr = derived.find((member) => member.id === selector)
        if (pr === undefined) continue
        const runId = checkEligibility(snapshot, pr, steps).run
        if (runId !== undefined) {
          const candidate = materializeRun(Queues.record(snapshot.queues, runId), snapshot.jobs)
          remember(candidate)
        }
      }
      break
    }
    return [...admitted].toSorted(compareNatural)
  }

  return Object.freeze({
    state,
    steps: () => steps.map(descriptor),
    admissionOrder: () => admissionOrderChanges(runtime()).map((pr) => pr.id),
    async reconcileMerge(args) {
      // S7 branch-is-change (@i/10 22991): the record index this command
      // reconciled repository-proven merges INTO is being deleted. Repository
      // truth is read directly — merged-truth's Change-Id index over main's
      // first-parent line and the refs/notes/yrd/merge-records notes — and
      // run terminals settle exactly once through the `settled` batch.
      raiseFailure(
        "refusal",
        "retired-command",
        `yrd: 'reconcileMerge' is retired for '${args.pr}' — the record index is gone; the repository is the ` +
          `merge authority (read it via merged-truth / refs/notes/yrd/merge-records), and run terminals ` +
          `settle through the queue's settled batch`,
      )
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- the retired
    // surface keeps its async signature so pre-S7 callers fail loud, not on a type.
    async admit(args) {
      // S7 branch-is-change: this verb selected from `admissionQueue`, whose
      // population is ENTIRELY its `derived` argument — and `AdmitSelection`
      // carries no derived batch, so every call site here passed the empty
      // default. The result was a verb that could not admit anything while
      // reporting `pr-not-found` for live submitted branches: a lie about the
      // CHANGE when the truth was about the VERB. Refuse loudly instead.
      raiseFailure(
        "refusal",
        "retired-command",
        `yrd: 'admit' is retired${args.prs?.length ? ` for '${args.prs.join("', '")}'` : ""} — admission selects ` +
          `from the compose's derived batch, which this verb has no parameter to carry, so it never had a ` +
          `population to select from. Admit through a compose instead: 'queue run' (selectorless drains the ` +
          `whole lane; 'queue run <selector>' narrows to what you name)`,
      )
    },
    async pause(args) {
      const snapshot = runtime()
      const base = queueBase(snapshot, args.base)
      // S7: a pause allow-list member is named by its retained run snapshot —
      // the same seam `pauseMemberStatus` reads it back through.
      const allowedPRs = args.allowedPRs.map((selector) => {
        const member = resolveMemberById(snapshot.queues, selector)
        if (member === undefined) {
          raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(snapshot.bays, selector))
        }
        return member.id
      })
      await actions.pause({ ...args, base, allowedPRs })
      const pause = state().pauses[base]
      if (pause === undefined) throw new Error(`yrd: queue '${base}' did not retain its pause`)
      return pause
    },
    async expirePauses(now) {
      const nowMs = Date.parse(now)
      if (Number.isNaN(nowMs)) throw new Error(`yrd: expirePauses requires an ISO timestamp; got '${now}'`)
      const expired = Object.values(state().pauses).filter(
        (pause): pause is DeepReadonly<QueuePause & Required<Pick<QueuePause, "expiresAt">>> =>
          pause.expiresAt !== undefined && Date.parse(pause.expiresAt) <= nowMs,
      )
      for (const pause of expired) {
        await actions.expirePause({ base: pause.base, expiresAt: pause.expiresAt })
      }
      return expired
    },
    async resume(base) {
      await actions.resume(queueBase(runtime(), base))
    },
    async recordAdmissionRefusal(args) {
      await appendAdmissionRefusal(args)
    },
    async settleAdmissionRefusal(args) {
      await actions.settleAdmissionRefusal(args)
    },
    waitingAdmission(selector, step) {
      return waitingRevisionAdmission(selector, step)
    },
    async finishAdmission(selector, completion, options) {
      const waiting = waitingRevisionAdmission(selector, completion.step)
      if (waiting === undefined) {
        raiseFailure(
          "refusal",
          "admission-step-not-waiting",
          `yrd: change '${selector}' has no waiting required check${completion.step === undefined ? "" : ` '${completion.step}'`}`,
        )
      }
      if (waiting.step.job.id !== completion.job) {
        raiseFailure(
          "refusal",
          "job-mismatch",
          `yrd: waiting required check '${waiting.step.name}' belongs to Job '${waiting.step.job.id}', not '${completion.job}'`,
        )
      }
      await jobs.finish(completion.job, {
        attempt: completion.attempt,
        runner: completion.runner,
        token: completion.token,
        result: completion.result,
      })
      // S7: re-materialize the member from its retained snapshot against the
      // LIVE submit fact. That re-materialization is the staleness check — it
      // refuses when the fact vanished or moved off the snapshot's sha, which is
      // what "changed while a required check was waiting" now means.
      const member = resolveMemberById(runtime().queues, waiting.pr)?.snapshot
      const pr = member === undefined ? undefined : materializeSnapshotMember(runtime().bays, member)
      if (pr === undefined || member === undefined || member.revision !== waiting.revision) {
        raiseFailure("refusal", "stale-pr", `yrd: change '${waiting.pr}' changed while a required check was waiting`)
      }
      const baseSha = member.baseSha
      if (baseSha === undefined) {
        raiseFailure(
          "infrastructure",
          "base-sha-missing",
          `yrd: change '${pr.id}' required checks have no resolved base`,
        )
      }
      const outcome = await admitChangeRevision(pr, baseSha, options)
      if (outcome.refusal !== undefined) await noteRevisionAdmissionRefusal(pr, outcome.refusal)
    },
    async run(args, runOptions) {
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "compose",
          attributes: { selectors: args.prs, steps: args.steps },
          outcome: queueRunsOutcome,
          label: composeSettlementLabel,
          resultAttributes: (runs) => ({ runs: runs.map(runEvidence) }),
        },
        async () => {
          const selection = args.prs !== undefined && args.prs.length > 0 ? "explicit" : undefined
          const explicitStepAuthority = args.steps !== undefined
          // A selectorless compose is a multi-candidate drain (the long-lived
          // habitant's default path, and any bare `queue run`): one candidate lost
          // to a typed refusal must not abort the whole compose nor kill the
          // habitant. Skip it LOUD and continue. A targeted one-shot run has no
          // other candidate to fall through to, so it stays fail-loud, and a
          // non-refusal (a real bug) always propagates.
          const selectorless = args.prs === undefined || args.prs.length === 0
          const settleCandidate = async (candidateId: RunId): Promise<void> => {
            try {
              await settle(candidateId, runOptions)
            } catch (error) {
              const fact = failureFact(error)
              if (!selectorless || fact?.kind !== "refusal") throw error
              // A stale-plan batch can never isolate under the installed catalog.
              // Retire it once so it cannot poison every future habitant cycle.
              if (fact.code === "stale-plan") {
                await actions.retireStalePlan(candidateId)
                log.warn?.("Skipped an outdated batch because its PRs can no longer be tested together.", {
                  action: "compose-stale-plan-retire",
                  run: candidateId,
                  code: fact.code,
                  reason: error instanceof Error ? error.message : String(error),
                })
                return
              }
              // Not ledgered: this skip is run-scoped, and a run record already
              // exists — the record walk in `auditQueues` can see it. The ledger
              // covers only the skips that never mint a record.
              log.warn?.("Skipped a change that changed while its batch was being prepared.", {
                action: "compose-candidate-skip",
                run: candidateId,
                code: fact.code,
                reason: error instanceof Error ? error.message : String(error),
              })
            }
          }
          const resolveCycleBase = createBaseResolutionCycle()
          const resolveCyclePlan = createDeclaredPlanCycle()
          await actions.refresh()
          // Roots this sweep settles are REPORTED with the cycle's runs below:
          // a crash-replayed run whose work all finished pre-crash reaches its
          // settlement here (nothing is left for the drive path to resume),
          // and dropping it from the result would make the caller's one
          // observation of that outcome vanish.
          const cleaned = await cleanupSettledRoots()
          if (args.steps?.length === 0) return []
          // Ref-only approvals derive their admission BEFORE any snapshot feeds
          // selection, so the same compose that admits them runs them (S6 door,
          // replacing the 2b record-minting sweep).
          //
          // EVERY compose, selectorless or not — this was `selectorless ? … : []`
          // and that is what made `yrd queue run <selector>` impossible. A
          // selector is matched against this batch and nothing else, and the CLI
          // passes `prs: [...selectors]` with no `derived` at all, so the batch
          // was empty for exactly the caller that needed it and every selector
          // refused `pr-not-found`.
          //
          // The mint-burn this guard was protecting is real, and the first cut
          // of this path priced it wrong. It said an unselected member's number
          // "is skipped rather than reused" — one number, once, inside the
          // mint's "number skip, never recycle" contract. It is one number per
          // un-composed branch PER RUN, forever, because an unselected member
          // anchors no durable identity for the next run to reuse. Three idle
          // branches took the high-water 1 → 4 → 7 → 10 over three explicit
          // runs.
          //
          // The escape is minting, not deriving. Deriving the lane really is a
          // precondition for resolving a selector against it, so that half
          // stands; handing a durable number to a member selection is about to
          // discard never was. `narrowToSelectableBranches` resolves the
          // selector against the two identity homes a compose leaves behind —
          // a retained snapshot, a refusal-ledger row — and derives only what
          // the selection can keep.
          const selfDerived = await deriveRefOnlyMembers(
            new Set((args.derived ?? []).map((member) => member.branch)),
            selectorless ? undefined : args.prs,
          )
          // Admit only the entries whose live submit fact still stands as
          // derived (caller-passed entries first, this compose's own
          // derivations after). The loud-edge policy: a typed refusal
          // (vanished/moved fact, record-lane collision) is warned, ledgered,
          // and skipped — the row survives into audit — while a mint-store
          // failure, a duplicate payload, or any untyped throw PROPAGATES and
          // fails the compose.
          const admitDerived = async (): Promise<DerivedRunMember[]> => {
            const cycle: DerivedRunMember[] = []
            for (const member of [...(args.derived ?? []), ...selfDerived]) {
              try {
                materializeDerivedRunMembers(runtime().bays, [member])
                cycle.push(member)
              } catch (error) {
                const fact = failureFact(error)
                if (fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) throw error
                log.warn?.("queue compose skipped a derived member whose submit fact no longer admits it", {
                  action: "compose-candidate-skip",
                  pr: member.id,
                  branch: member.branch,
                  code: fact.code,
                  kind: fact.kind,
                  reason: fact.message,
                })
                await noteCandidateRefusal([member], { code: fact.code, kind: fact.kind, reason: fact.message })
              }
            }
            return cycle
          }
          let cycleDerived = await admitDerived()
          let cycleArgs: QueueRunArgs =
            cycleDerived.length === 0 ? { ...args, derived: undefined } : { ...args, derived: cycleDerived }
          const derivedEntry = (id: string): DerivedRunMember | undefined =>
            cycleDerived.find((member) => member.id === id)
          const materializedDerived = (bays: DeepReadonly<BaysState>): Change[] =>
            cycleDerived.flatMap((member) => {
              try {
                return materializeDerivedRunMembers(bays, [member])
              } catch (error) {
                // Mirrors the record path's tolerance for changes that
                // disappeared mid-cycle: the authoritative CAS refuses loudly
                // at dispatch if anything still names the member.
                if (failureFact(error)?.kind === "refusal") return []
                throw error
              }
            })
          // The intent lane that used to interleave here with a head-of-line
          // release (keyed by submodule) is retired along with the rest of the
          // intent rail — there is no longer a second lane of queue members to
          // arbitrate against, so this compose always proceeds straight to PR
          // selection below. `intentCutoff` stays declared (always `undefined`
          // now) because `requestedPRs` still takes it as a general parameter.
          const intentCutoff: QueuePosition | undefined = undefined
          let snapshot = runtime()
          // `cycleArgs`, not `args`: this resolves the same selectors
          // `requestedPRs` does, and it runs FIRST, so handing it the caller's
          // untouched arguments made it the surface that refused `pr-not-found`
          // before the compose's own derived batch was ever consulted. Both
          // resolutions must see one population or the earlier one speaks for
          // the later.
          const resumable = resumableQueueRoots(snapshot, cycleArgs, steps)
          // Cleaned roots join an UNFILTERED drain only: an explicit selection
          // (or step filter) never reported runs outside it, and the sweep's
          // settlements are not scoped to the caller's selectors.
          const roots: RunId[] =
            selectorless && args.steps === undefined
              ? [...cleaned, ...resumable.map((run) => run.id)]
              : resumable.map((run) => run.id)
          for (const run of resumable) await settleCandidate(run.id)

          snapshot = runtime()
          const activeBases = new Set(
            resumable
              .map((run) => materializeRun(Queues.record(snapshot.queues, run.id), snapshot.jobs))
              .filter((run) => !Queues.terminal(run))
              .map((run) => run.base),
          )
          const consumed = new Set(
            resumable.flatMap((run) =>
              run.prs.filter((pr) => pinnedChangeError(snapshot, [pr], run.id) === undefined).map((pr) => pr.id),
            ),
          )
          const requested = requestedPRs(snapshot.bays, cycleArgs, consumed, intentCutoff)
          const authoritySteps = requestedOrDeclaredSteps(steps, args.steps, args.declaredPlan)
          const cycleAuthority = derivedAuthorityLookup(snapshot)
          const authorityGaps = selectorless
            ? requested.flatMap((pr) => {
                const requestedSnapshot = Queues.snapshot(pr)
                return queueAuthorityGaps(
                  snapshot.queues.authority,
                  [requestedSnapshot],
                  authoritySteps,
                  integratedChangeShape([pr]) !== undefined,
                  cycleAuthority,
                )
              })
            : []
          for (const gap of authorityGaps) {
            try {
              // The record-lane eject that used to run here wrote a durable
              // pr/needs-author onto the record. No member has one since S7 (the
              // PURE-GIT ruling) — a consumed authority is already legible from
              // run history, and the warn plus the refusal-ledger row below are
              // its whole trace.
              const gapReason =
                gap.reason === "consumed"
                  ? `${gap.kind} authority was consumed by queue run '${gap.consumedBy}'`
                  : `no ${gap.kind} authority fact exists`
              log.warn?.("queue compose ejected a candidate without runnable authority", {
                action: "compose-candidate-skip",
                pr: gap.pr,
                code: `queue-${gap.kind}-authority-${gap.reason}`,
                reason: gapReason,
                remedy: "tracked changes re-merge implicitly when the branch moves; fallback: 'yrd pr submit <branch>'",
              })
              // Every gap takes a ledger row since S7. A gap used to be able to
              // leave its trace on a record instead — `consumed` ejected with a
              // durable `pr/needs-author` — and only `missing` needed the
              // ledger. With no record to write on, both would otherwise
              // re-skip the same member every cycle leaving nothing behind; the
              // cure for either is a re-push.
              await noteCandidateRefusal([derivedEntry(gap.pr) ?? gap.pr], {
                code: `queue-${gap.kind}-authority-${gap.reason}`,
                reason: gapReason,
              })
            } catch (error) {
              // 22306 class: a single PR's authority/eject refusal must not abort the
              // selectorless drain (same boundary as the per-candidate wrap below).
              const fact = failureFact(error)
              if (!selectorless || fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) {
                throw error
              }
              log.warn?.("queue compose skipped an authority-gap change lost to a losable failure", {
                action: "compose-candidate-skip",
                pr: gap.pr,
                code: fact.code,
                kind: fact.kind,
                reason: fact.message,
              })
              await noteCandidateRefusal([derivedEntry(gap.pr) ?? gap.pr], {
                code: fact.code,
                kind: fact.kind,
                reason: fact.message,
              })
            }
          }
          const authorityGapIds = new Set(authorityGaps.map((gap) => gap.pr))
          snapshot = runtime()
          const refusedAdmissions = selectorless ? refusedRevisionAdmissions(snapshot) : []
          const checked = explicitStepAuthority
            ? []
            : [...requested, ...refusedAdmissions].filter((pr) => !authorityGapIds.has(pr.id) && checksRequested(pr))
          const before = new Map(checked.map((pr) => [pr.id, checkEligibility(snapshot, pr, steps).status]))
          // Every carrier this drain can ADMIT, which is strictly more than the
          // ones it selected for merging. A selectorless `drainAdmissions` walks
          // `admissionQueue` unfiltered — it applies `targets` only for an
          // explicit selection — and that queue also holds `pushed` carriers,
          // which `requestedPRs` never returns and `refusedRevisionAdmissions`
          // does not reach either. Refreshing only `checked` therefore admitted
          // a carrier in that gap against a base no check request of its own
          // named, so its authority count resolved against the wrong triple
          // (@yrd/core/refresh-coverage-gap).
          //
          // DELIBERATELY EXCLUDED: carriers this cycle already ejected for an
          // authority gap. The cycle has decided they do not run and handed
          // them back to their author; re-pointing one would mint a check
          // request for work just refused. That is the same exclusion `checked`
          // has always applied, extended to the wider set rather than a second
          // policy. Carriers a live run holds need no exclusion of their own:
          // their admission still matches their request, so `admissionQueue`
          // drops them structurally.
          const admissible = selectorless
            ? admissionQueue(snapshot, steps, undefined, materializedDerived(snapshot.bays)).filter(
                (pr) => !authorityGapIds.has(pr.id),
              )
            : []
          const checkedIds = new Set(checked.map((pr) => pr.id))
          const refreshable = [...checked, ...admissible.filter((pr) => !checkedIds.has(pr.id))]
          // Admission is revision-owned evidence, not a Queue Run. Revalidate
          // each requested revision against this cycle's base before selecting
          // merge work. The driver still settles any historical active
          // admission Run before recording a new immutable revision verdict.
          try {
            await refreshCheckIdentities(refreshable, resolveCycleBase)
            // ENTER the drain with the set it admits from, which is the set just
            // refreshed. Handing it `checked` gated the loop on the SUBMITTED
            // selection being non-empty, so a cycle whose only work was `pushed`
            // never entered `drainAdmissions` at all and completed looking
            // healthy having admitted nothing (@yrd/core/pushed-only-cycle-never-drains).
            //
            // The narrow entry set was never load-bearing: a selectorless drain
            // applies `targets` only to an explicit selection and otherwise
            // walks `admissionQueue` unfiltered, so this widens WHETHER the loop
            // runs without changing WHICH carriers it admits once it does. It
            // also makes the returned set the set actually admitted from, rather
            // than dropping every pushed carrier the drain took.
            const enteringDerived = materializedDerived(runtime().bays)
            const entering = refreshable.flatMap((pr) => {
              const current = enteringDerived.find((member) => member.id === pr.id)
              return current === undefined ? [] : [current]
            })
            await drainAdmissions(
              entering.map((pr) => pr.id),
              runOptions,
              resolveCycleBase,
              selection,
              enteringDerived,
            )
          } catch (error) {
            const fact = failureFact(error)
            // Refusals only. A typed INFRASTRUCTURE fact reaching this boundary
            // must fail the compose — admitChangeRevision already rethrows its
            // candidate-preparation infra errors on purpose, and swallowing
            // them here let the compose proceed to merge selection without a
            // step's verdict, with a TYPED infra error quieter than an untyped
            // throw.
            if (!selectorless || fact?.kind !== "refusal") {
              throw error
            }
            log.warn?.("queue compose skipped required-check work lost to a losable failure", {
              action: "compose-candidate-skip",
              code: fact.code,
              kind: fact.kind,
              reason: fact.message,
              prs: checked.map((pr) => pr.id),
            })
            await noteCandidateRefusal(checked, { code: fact.code, kind: fact.kind, reason: fact.message })
          }
          snapshot = runtime()
          const settledDerived = materializedDerived(snapshot.bays)
          const currentChecked = checked.flatMap((pr) => {
            const current = settledDerived.find((member) => member.id === pr.id)
            return current === undefined ? [] : [current]
          })
          const unsettled = currentChecked.filter((pr) => checkEligibility(snapshot, pr, steps).status !== "passed")
          const pending = unsettled.filter((pr) => checkEligibility(snapshot, pr, steps).status !== "failed")
          const pendingIds = new Set(pending.map((pr) => pr.id))
          if (unsettled.length > 0) {
            const newlyFailed = unsettled.some(
              (pr) => before.get(pr.id) !== "failed" && checkEligibility(snapshot, pr, steps).status === "failed",
            )
            if (
              selection === "explicit" &&
              (newlyFailed || unsettled.some((pr) => checkEligibility(snapshot, pr, steps).status !== "failed"))
            ) {
              return []
            }
          }
          // The admission phase owns these still-checking PRs for this tick.
          // Exclude them from merge selection without aborting the whole phase,
          // so unrelated ready PRs can integrate while targeted one-PR drains
          // return their admission result instead of a checks-running refusal.
          const unavailable = new Set([...consumed, ...pendingIds, ...authorityGaps.map((gap) => gap.pr)])
          // Re-prune the derived entries against the post-admission state so a
          // member whose fact vanished mid-cycle drops out of merge selection
          // instead of failing the drain (the dispatch below still CAS-refuses
          // loudly if a fact vanishes between here and apply).
          cycleDerived = cycleDerived.filter((member) =>
            settledDerived.some((materialized) => materialized.id === member.id),
          )
          cycleArgs = cycleDerived.length === 0 ? { ...args, derived: undefined } : { ...args, derived: cycleDerived }
          const runnable = runnableChangeSelection(snapshot, cycleArgs, steps, needsPersonOwner, unavailable, {
            explicitStepAuthority,
            ...(intentCutoff === undefined ? {} : { implicitBefore: intentCutoff }),
          })
          const prs = runnable.prs.filter((pr) => !activeBases.has(baseIdentity(pr.base)))
          if (selectorless && prs.length === 0) {
            // Re-evaluate the whole FIFO-visible set for diagnostics, before the
            // admission phase's temporary exclusions hide the reason it emitted
            // no candidate. This uses the SAME eligibility helper as selection;
            // it broadens evidence only, never what may run.
            const diagnostic = runnableChangeSelection(snapshot, cycleArgs, steps, needsPersonOwner, consumed, {
              explicitStepAuthority,
              ...(intentCutoff === undefined ? {} : { implicitBefore: intentCutoff }),
            })
            const rejected = diagnostic.decisions.filter(({ eligibility }) => !eligibility.runnable)
            const unrecorded = unrecordedSubmits(snapshot.bays, snapshot.queues)
            if (rejected.length > 0 || (diagnostic.decisions.length === 0 && unrecorded.length > 0)) {
              reportZeroEventRun(queueRunNoRunnablePRs(rejected, authoritySteps, unrecorded))
            } else if (diagnostic.decisions.length === 0) {
              // Nothing to consider at all (as opposed to runnable members held
              // back by an active base, which the admission loop reports itself).
              reportZeroEventRun(queueRunNoSubmittedPRs(snapshot.bays, authoritySteps, consumed))
            }
          }
          for (const candidate of partitionCandidates(prs, snapshot.queues.batchSize)) {
            if (runOptions.continueAdmissions?.() === false) break
            // 22306 residual: wrap the FULL per-candidate admission (base resolve,
            // prepare, start, settle) so a recut-certificate / command-refused /
            // candidate-ref-refused on ONE partition cannot exit the selectorless
            // drain. Explicit PR targeting still fails loud.
            // The members still in this partition. A refusal attributable to ONE
            // member ejects that member and retries the survivors rather than
            // failing the whole partition: an 8-PR candidate must not be zeroed
            // by one poisoned carrier, and the seven innocents must not inherit
            // its refusal record — that record is what `queue audit` reads, so a
            // stain replays as a finding every cycle until someone reads the
            // carrier by hand.
            // Records first, derived after (order preserved within each class):
            // the dispatch below carries record ids in `prs` and derived
            // entries in `derived`, and apply re-selects them in exactly that
            // concatenation — the Candidate's rev order must match it.
            let members = [
              ...candidate.filter((pr) => derivedEntry(pr.id) === undefined),
              ...candidate.filter((pr) => derivedEntry(pr.id) !== undefined),
            ]
            try {
              const baseSha = await resolveCandidateBaseSha(candidate, resolveCycleBase)
              let facts: z.infer<typeof CandidateCreatedSchema> | undefined
              let prepared = false
              let abandoned = false
              // Bounded by construction: every pass either settles, abandons, or
              // removes at least one member, so it cannot outlive the partition.
              for (let pass = 0; pass < candidate.length; pass += 1) {
                try {
                  facts = await candidateFacts(members, baseSha)
                  prepared = true
                  break
                } catch (error) {
                  const fact = failureFact(error)
                  if (
                    !selectorless ||
                    fact === undefined ||
                    (fact.kind !== "refusal" && fact.kind !== "infrastructure")
                  ) {
                    throw error
                  }
                  const guilty = attributableMember(fact, members)
                  if (guilty === undefined || members.length === 1) {
                    // Unattributable, or nothing left to isolate: the refusal is
                    // the partition's, exactly as it was before isolation.
                    log.warn?.("queue compose skipped a Candidate that could not be prepared", {
                      action: "compose-candidate-skip",
                      ...(members.length === 1 ? { pr: members[0]?.id } : { prs: members.map((pr) => pr.id) }),
                      code: fact.code,
                      kind: fact.kind,
                      reason: fact.message,
                    })
                    await noteCandidateRefusal(members, { code: fact.code, kind: fact.kind, reason: fact.message })
                    abandoned = true
                    break
                  }
                  log.warn?.("queue compose ejected the member that refused Candidate preparation", {
                    action: "compose-candidate-skip",
                    pr: guilty,
                    code: fact.code,
                    kind: fact.kind,
                    reason: fact.message,
                    remedy:
                      "tracked changes re-merge implicitly when the branch moves; fallback: 'yrd pr submit <branch>'",
                  })
                  // Only the member that actually refused earns the durable record.
                  await noteCandidateRefusal([members.find((pr) => pr.id === guilty) ?? guilty], {
                    code: fact.code,
                    kind: fact.kind,
                    reason: fact.message,
                  })
                  members = members.filter((pr) => pr.id !== guilty)
                }
              }
              if (abandoned) continue
              // Never proceed on an unsettled preparation: `facts` is legitimately
              // undefined when no preparer is installed, so absence alone cannot
              // stand in for success.
              if (!prepared) {
                throw new Error(
                  `yrd: Candidate preparation did not settle for '${members.map((pr) => pr.id).join(", ")}'`,
                )
              }
              // Git is read HERE, at the exact base sha this candidate was
              // prepared against — so a run re-prepared after the base moved
              // picks up the config that moved with it, and `apply` stays a
              // pure reducer over the plan it is handed.
              const declaredPlan = await resolveCyclePlan?.(baseSha)
              const derivedInRun = members.flatMap((pr) => {
                const entry = derivedEntry(pr.id)
                return entry === undefined ? [] : [entry]
              })
              const started = await actions.run({
                prs: members.filter((pr) => derivedEntry(pr.id) === undefined).map((pr) => pr.id),
                ...(derivedInRun.length === 0 ? {} : { derived: derivedInRun }),
                ...(args.steps === undefined ? {} : { steps: args.steps }),
                baseSha,
                ...(declaredPlan === undefined
                  ? {}
                  : { declaredPlan: { ...declaredPlan, steps: [...declaredPlan.steps] } }),
                ...(facts === undefined ? {} : { candidate: facts }),
              })
              const ejected = started.events.find((applied) => applied.name === "pr/needs-author")
              if (ejected !== undefined) {
                const refusal = ChangeNeedsAuthorFactSchema.parse(ejected.data)
                if (!selectorless) raiseFailure("refusal", refusal.receipt.code, refusal.receipt.message)
                log.warn?.("queue compose ejected a candidate without runnable authority", {
                  action: "compose-candidate-skip",
                  pr: refusal.pr,
                  code: refusal.receipt.code,
                  reason: refusal.receipt.message,
                  remedy:
                    "tracked changes re-merge implicitly when the branch moves; fallback: 'yrd pr submit <branch>'",
                })
                continue
              }
              const startedEvent = started.events.find((applied) => applied.name === "queue/run/started")
              // A submitted PR whose configured plan is entirely admission work can
              // already be satisfied by a retained successful Run. The command is
              // then an intentional idempotent no-op; keep draining later candidates
              // instead of terminating a habitant runner at the first cached PR.
              if (
                startedEvent === undefined &&
                started.events.every((event) => event.name === "queue/candidate/created")
              ) {
                reportZeroEventRun(started.value)
                continue
              }
              if (startedEvent === undefined) throw new Error("yrd: queue run did not start a run")
              const id = QueueStartSchema.parse((startedEvent.data as { run?: unknown }).run).id
              roots.push(id)
              const root = current(id)
              if (Queues.terminal(root)) await reportFreshTerminal(root)
              else await settleCandidate(id)
            } catch (error) {
              const fact = failureFact(error)
              if (!selectorless || fact === undefined || (fact.kind !== "refusal" && fact.kind !== "infrastructure")) {
                throw error
              }
              // The installed set and the base-declared plan disagree (23192):
              // a PROCESS fault every candidate of this compose shares, not a
              // fact about this candidate — skipped, it drains the whole queue
              // to a clean [] with the disagreement recorded nowhere, while the
              // explicit path rejects. Same by-code carve-out shape as
              // settleCandidate's stale-plan above.
              if (fact.code === "declared-step-not-installed") throw error
              // Same attribution rule as preparation: a failure that names one
              // member is that member's alone. `members`, not `candidate`, so a
              // member already ejected above is not stained a second time.
              const guilty = attributableMember(fact, members)
              const blamed = guilty === undefined ? members.map((pr) => pr.id) : [guilty]
              log.warn?.("queue compose skipped a candidate lost to a losable failure", {
                action: "compose-candidate-skip",
                ...(blamed.length === 1 ? { pr: blamed[0] } : { prs: blamed }),
                code: fact.code,
                kind: fact.kind,
                reason: fact.message,
              })
              await noteCandidateRefusal(
                blamed.map((id) => members.find((pr) => pr.id === id) ?? id),
                { code: fact.code, kind: fact.kind, reason: fact.message },
              )
            }
          }
          const final = runtime()
          return [...new Set(roots)].flatMap((root) => queueTree(final.queues, final.jobs, root))
        },
      )
    },
    waiting,
    async finish(selector, completion, runOptions) {
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "finish",
          identity: { job: completion.job, attempt: completion.attempt, runner: completion.runner },
          attributes: { selector, step: completion.step },
          outcome: queueRunOutcome,
          resultAttributes: runEvidence,
        },
        async () => {
          const selected = waiting(selector, completion.step)
          if (selected.step.job.id !== completion.job) {
            raiseFailure(
              "refusal",
              "queue-job-mismatch",
              `yrd: Job '${completion.job}' is not the waiting '${selected.step.name}' Job '${selected.step.job.id}' for queue run '${selected.run.id}'`,
            )
          }
          await jobs.finish(completion.job, {
            attempt: completion.attempt,
            runner: completion.runner,
            token: completion.token,
            result: completion.result,
          })
          return settle(selected.run.id, runOptions)
        },
      )
    },
    async cancel(args) {
      const selected = new Set(args.prs)
      const affected: RunId[] = []
      for (const candidate of activeQueueRuns(runtime().queues, runtime().jobs)) {
        if (!candidate.prs.some((pr) => selected.has(pr.id))) continue
        const active = candidate.steps[candidate.cursor]?.job
        const cancelable =
          active?.status === "queued" || active?.status === "in_progress" || active?.status === "waiting"
        if (!cancelable && Queues.terminal(candidate)) continue
        if (cancelable) {
          if (configuredRunner === undefined) {
            await jobs.cancel({ id: active.id, attempt: active.attempt, by: args.by, reason: args.reason })
          } else {
            await configuredRunner.cancel(active.id, { by: args.by, reason: args.reason })
          }
        }
        await actions.advance(candidate.id)
        affected.push(candidate.id)
      }
      return affected.map(current)
    },
    cancelAdmissionJobs: cancelAdmissionJobsForRevision,
    async cancelRun(args) {
      const record = Queues.resolve(runtime().queues, args.run)
      if (record === undefined) raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      const run = materializeRun(record, runtime().jobs)
      if (Queues.terminal(run)) {
        raiseFailure(
          "refusal",
          "run-terminal",
          `yrd: queue run '${args.run}' is ${run.status}; only a running or waiting run can be canceled`,
        )
      }
      // Multi-tenant, deadlock-free cancel. This runs as a SEPARATE cli process
      // from the habitant follow-runner. Journal the run cancellation FIRST: it
      // marks the record canceled (advanceQueue then stops reconciling it, so no
      // pr/canceled) and releases authority so the still-submitted PRs re-queue on
      // a future drain. THEN cancel the active job to abort in-flight work. We
      // NEVER synchronously cancel our own loop's active merge from inside the
      // drive loop (that deadlocks: the loop holds the queue writer while blocked
      // mid-merge). When the run's merge is in flight in the habitant, this
      // journaled job cancellation surfaces there as a typed settlement conflict
      // that habitantCycleRecovery honors at the next safe cycle boundary — no
      // second scheduler, no daemon.
      await actions.cancelRun(args)
      const active = run.steps[run.cursor]?.job
      const cancelable = active?.status === "queued" || active?.status === "in_progress" || active?.status === "waiting"
      if (cancelable) {
        if (configuredRunner === undefined) {
          await jobs.cancel({ id: active.id, attempt: active.attempt, by: args.by, reason: args.reason })
        } else {
          await configuredRunner.cancel(active.id, { by: args.by, reason: args.reason })
        }
      }
      const canceled = current(args.run)
      await persistMergeRecord(canceled)
      return canceled
    },
    async recover(recoverOptions) {
      // Capture ownership at the synchronous API boundary. A habitant runner can
      // settle and release a lost root while recovery is entering its observed
      // async operation; that race must not erase the run from recovery evidence.
      const rootsBeforeRecovery = activeQueueRootIds(runtime().queues)
      return observeYrdLifecycle(
        log,
        {
          lifecycle: "recover",
          attributes: {
            recoveryTime: recoverOptions.recoveryTime,
            ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
            ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
          },
          outcome: (runs) => (runs.length === 0 ? "succeeded" : "recovered"),
          resultAttributes: (runs) => ({ runs: runs.map(runEvidence) }),
        },
        async () => {
          const recoveredJobs = new Set(
            await (configuredRunner === undefined
              ? jobs.recover({
                  now: recoverOptions.recoveryTime,
                  ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
                  ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
                })
              : configuredRunner.recover({
                  now: recoverOptions.recoveryTime,
                  ...(recoverOptions.reason === undefined ? {} : { reason: recoverOptions.reason }),
                  ...(recoverOptions.runner === undefined ? {} : { runner: recoverOptions.runner }),
                })),
          )
          const staleAdmissions = staleRevisionAdmissionJobs()
          for (const job of staleAdmissions) {
            await jobs.cancel({
              id: job.id,
              attempt: job.attempt,
              by: recoverOptions.runner ?? "yrd/recover",
              reason: "entry checks no longer belong to a live change revision",
            })
          }
          if (staleAdmissions.length > 0) {
            log.warn?.("Stopped required-check jobs whose PR revision is no longer live.", {
              action: "recover-stale-admission-settle",
              reason: "stale-admission-job",
              jobs: staleAdmissions.map((job) => job.id),
            })
          }
          const affected = new Set<RunId>()
          // Recovery's OWN reader, held across every enumeration below so one
          // unreadable record is quarantined once and cannot veto the repair of
          // any other. {@link createTolerantQueueReader} carries the incident.
          const reader = createTolerantQueueReader()
          let snapshot = runtime()
          const recoveryRoots = new Set([...rootsBeforeRecovery, ...activeQueueRootIds(snapshot.queues)])
          const candidates = [...recoveryRoots].flatMap((root) => reader.tree(snapshot, root))
          const staleQueued: Array<{ run: RunId; step: StepName; drift: string }> = []
          for (const candidate of candidates) {
            const active = candidate.steps[candidate.cursor]
            const drift = active?.job?.status === "queued" ? plannedStepDrift(byName, active) : undefined
            if (active !== undefined && drift !== undefined) {
              const reconciled = await actions.advance(candidate.id)
              if (reconciled.events.length > 0) {
                affected.add(candidate.id)
                staleQueued.push({ run: candidate.id, step: active.name, drift })
              }
              snapshot = runtime()
              continue
            }
            const ownsRecoveredJob = candidate.steps.some(
              (step) => step.job !== undefined && recoveredJobs.has(step.job.id),
            )
            const hasTerminalFailure = candidate.steps.some((step) => step.job !== undefined && jobFailed(step.job))
            if (hasTerminalFailure && needsAdvance(snapshot, candidate)) {
              const reconciled = await actions.advance(candidate.id)
              if (reconciled.events.length > 0) affected.add(candidate.id)
              snapshot = runtime()
            }
            if (ownsRecoveredJob) affected.add(candidate.id)
          }
          if (staleQueued.length > 0) {
            log.warn?.("Stopped queue runs whose queued step definition changed.", {
              action: "recover-stale-steps-release",
              reason: "stale-steps",
              runs: staleQueued.map(({ run }) => run),
              steps: staleQueued.map(({ step }) => step),
              details: staleQueued.map(({ drift }) => drift),
            })
          }
          // Orphan hygiene: cancel every requested Job whose parent run is
          // terminal or absent, so a state upgrade or a settled/canceled run that
          // never terminalized its pending Job cannot strand it forever (the class
          // that fed the selectorless-compose poison). Loud structured result
          // naming every settled Job + run; a terminal-run orphan's record is
          // re-materialized into the return, an absent-run orphan has no record to
          // return so the result is its report.
          const settledOrphans = orphanedRequestedQueueJobs(runtime(), reader)
          for (const orphan of settledOrphans) {
            await jobs.cancel({
              id: orphan.job.id,
              attempt: orphan.job.attempt,
              by: recoverOptions.runner ?? "yrd/recover",
              reason: `orphaned requested job (${orphan.reason})`,
            })
            if (orphan.reason === "run-terminal") affected.add(orphan.run)
          }
          if (settledOrphans.length > 0) {
            log.warn?.("Stopped jobs whose queue run had already ended.", {
              action: "recover-orphan-settle",
              reason: "orphaned-requested-job",
              jobs: settledOrphans.map((orphan) => orphan.job.id),
              runs: [...new Set(settledOrphans.map((orphan) => orphan.run))],
            })
          }
          // Settle every run whose cursor step has had no Job past the orphan
          // grace: nothing else can. `jobs.recover()` above walks Jobs, and
          // `advance` no-ops without one, so a jobless run is projected `running`
          // forever (R1582 ticked for 45h over an already-integrated change). Loud
          // structured result naming every settled run and the step it stalled on.
          const orphanedRuns = orphanedJoblessRuns(runtime(), recoverOptions.recoveryTime, reader)
          for (const orphan of orphanedRuns) {
            await actions.settleOrphanedRun({
              run: orphan.run,
              reason: `yrd: runner disappeared before step '${orphan.step}' started; no job since ${orphan.since}`,
            })
            affected.add(orphan.run)
          }
          if (orphanedRuns.length > 0) {
            log.warn?.("Stopped queue runs whose next step never started.", {
              action: "recover-orphan-run-settle",
              reason: "orphaned-run",
              runs: orphanedRuns.map((orphan) => orphan.run),
              steps: orphanedRuns.map((orphan) => orphan.step),
            })
          }
          // Retire every FAILED batch whose recorded plan drifted so it can never
          // isolate — otherwise it re-refuses isolation every compose cycle forever
          // (the isolate-path zombie). Typed stale-plan release; loud result.
          const plannedRetirements = unisolableStalePlanBatches(runtime(), byName, reader)
          const retiredBatches: UnisolableStalePlanBatch[] = []
          for (const planned of plannedRetirements) {
            // Each retirement appends and re-compacts the live projection. That
            // can evict another old planned batch before this loop reaches it
            // (live: retiring R523 crossed the retention boundary and evicted
            // R533). Re-resolve against the refreshed projection instead of
            // dispatching a stale plan into a now-archived run.
            const snapshot = runtime()
            const record = Queues.get(snapshot.queues, planned.run)
            if (record === undefined) continue
            const run = reader.read(record, snapshot.jobs)
            if (run === undefined) continue
            if (!bisectable(run) || recordedPlanDrift(run.steps, byName) === undefined) continue
            const result = await actions.retireStalePlan(planned.run)
            if (result.events.length === 0) continue
            retiredBatches.push(planned)
            affected.add(planned.run)
          }
          if (retiredBatches.length > 0) {
            log.warn?.("Removed outdated batches that can no longer be tested.", {
              action: "recover-stale-plan-retire",
              reason: "stale-plan",
              runs: retiredBatches.map((batch) => batch.run),
            })
          }
          for (const id of await cleanupSettledRoots(reader)) affected.add(id)
          // The disclosure half of the quarantine, and the reason this reader is
          // not a silent fallback: every record recovery could not read is named
          // here with WHAT (the run), WHERE (this recovery pass) and WHY (the
          // reader's exact refusal), at the moment recovery worked around it.
          // `queue audit` reports the same rows as `invalid-run` for as long as
          // they stand — recovery repairs what it can and hides nothing.
          const unreadable = reader.quarantined()
          if (unreadable.length > 0) {
            log.warn?.("Skipped queue runs whose records could not be read; recovery repaired the rest.", {
              action: "recover-unreadable-run-quarantine",
              reason: "unreadable-run",
              runs: unreadable.map((row) => row.run),
              details: unreadable.map((row) => row.reason),
            })
          }
          const final = runtime()
          return [...affected].flatMap((id) => {
            const record = Queues.get(final.queues, id)
            const run = record === undefined ? undefined : reader.read(record, final.jobs)
            if (run !== undefined) return [run]
            const historical = archived(id)
            if (historical !== undefined) return [historical]
            // Quarantined above and already reported: recovery acted on it, and
            // dropping it from the evidence list is not silence. A run absent
            // from projection AND history with no read failure is a different
            // animal — nothing acted on it — so that still fails loud.
            if (reader.isQuarantined(id)) return []
            throw new Error(`yrd: recovered queue run '${id}' is absent from live projection and journal history`)
          })
        },
      )
    },
    audit: (options = {}) => auditQueues(runtime(), steps, progress, needsPersonOwner, options),
    eligibility(selector, projected) {
      // Called once per change by the queue views, and the single largest stage of a
      // cold `queue ls` — resolveChange plus checkEligibility together dominate it.
      return stage("eligibility", () => {
        const snapshot = projected ?? runtime()
        // The same identity the published order uses (see
        // `standingLaneMembers`), so `checks.position` and `admissionOrder()`
        // report one number rather than two.
        const member = resolveMemberById(snapshot.queues, selector)?.snapshot
        const pr = member === undefined ? undefined : materializeSnapshotMember(snapshot.bays, member)
        if (pr === undefined) raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(snapshot.bays, selector))
        return ChangeEligibility(snapshot, pr, steps, needsPersonOwner)
      })
    },
    unrecordedSubmits(projected) {
      const snapshot = projected ?? runtime()
      return unrecordedSubmits(snapshot.bays, snapshot.queues)
    },
    deriveChange(branch, projected) {
      const snapshot = projected ?? runtime()
      const submit = snapshot.bays.submits[branch]
      return {
        branch,
        ...(submit === undefined ? {} : { submit, unrecorded: unrecordedSubmit(branch, submit) }),
        authority: arbitrateDerivedChange([], submit),
      }
    },
    resolveMember(selector, projected) {
      const snapshot = projected ?? runtime()
      return resolveMemberById(snapshot.queues, selector)
    },
    freshnessCandidateBatches() {
      const snapshot = runtime()
      const candidates = runnablePRs(snapshot, {}, steps, needsPersonOwner, new Set(), {
        explicitStepAuthority: true,
      }).filter((pr) => checksRequested(pr))
      return partitionCandidates(candidates, snapshot.queues.batchSize).map((candidate) => candidate.map((pr) => pr.id))
    },
    async quiesceLegacyRoots(options) {
      await actions.refresh()
      const now = Date.parse(options.now)
      if (Number.isNaN(now)) throw new Error(`yrd: quiesceLegacyRoots requires an ISO 'now'; got '${options.now}'`)
      const targets = legacyRootTargets(runtime())
      const leased = targets.filter((target) => target.leased(now)).map((target) => target.run)
      if (leased.length > 0) {
        // A genuinely-active previous writer is protected: name the leased roots so
        // the operator learns which are held, and that unleased ones auto-quiesce.
        raiseFailure(
          "refusal",
          "legacy-root-leased",
          `yrd: Queue projection migration is blocked by live-leased legacy roots; a previous writer still holds ${leased.join(
            ", ",
          )} — unleased legacy roots would have been auto-quiesced`,
        )
      }
      const quiesced: { run: RunId; jobs: string[] }[] = []
      for (const planned of targets) {
        // Every settlement append can compact the live projection. Re-resolve
        // the planned root from refreshed authority instead of dispatching a
        // stale target that replay or compaction has already retired.
        await actions.refresh()
        const target = legacyRootTarget(runtime(), planned.run)
        if (target === undefined) continue
        if (target.leased(now)) {
          raiseFailure(
            "refusal",
            "legacy-root-leased",
            `yrd: Queue projection migration is blocked by live-leased legacy roots; a previous writer still holds ${target.run} — unleased legacy roots would have been auto-quiesced`,
          )
        }
        // Settle the run terminal first (record.failure stops re-advance), then
        // cancel each still-live job so the run AND its jobs all reach terminal.
        await actions.quiesceLegacyRun({ run: target.run, reason: "legacy-quiesced" })
        for (const job of target.jobs) {
          await jobs.cancel({ id: job.id, attempt: job.attempt, by: options.by, reason: "legacy-quiesced" })
        }
        quiesced.push({ run: target.run, jobs: target.jobs.map((job) => job.id) })
      }
      if (quiesced.length > 0) {
        // ONE loud structured result naming every settled root and job.
        log.warn?.(`Stopped old queue runs during startup: ${quiesced.map((entry) => entry.run).join(", ")}.`, {
          action: "legacy-quiesce",
          reason: "legacy-quiesced",
          by: options.by,
          runs: quiesced.map((entry) => entry.run),
          jobs: quiesced.flatMap((entry) => entry.jobs),
        })
      }
      return { provenance: "migration/21012-legacy-quiesce", reason: "legacy-quiesced", quiesced }
    },
    retentionDiagnostics() {
      const snapshot = state()
      const roots = new Set(Queues.values(snapshot).map((record) => queueRetentionRoot(snapshot, record.id)))
      const terminalTrees = [...roots].filter((root) => snapshot.retention.terminalOrder[root] !== undefined).length
      return {
        retainedRuns: Queues.values(snapshot).length,
        unsettledTrees: roots.size - terminalTrees,
        terminalTrees,
        archiveAvailable: history !== undefined,
      }
    },
    get(id) {
      const record = Queues.resolve(state(), id)
      return record === undefined ? archived(id) : materializeRun(record, runtime().jobs)
    },
    async history() {
      const snapshot = await historicalState()
      return orderedQueues(snapshot.queues, snapshot.jobs)
    },
    status: (base) => queueSummary(state(), runtime().jobs, queueBase(runtime(), base)),
  }) as Queue<Shape>
}

function deliveryIdentity(pr: DeepReadonly<ChangeSnapshot>): YrdDeliveryIdentity {
  return {
    pr: pr.id,
    revision: pr.revision,
    headSha: pr.headSha,
    // Carried so the habitant runner's timeline rows can name the branch — the
    // watch-pane grammar (`R604 PR411.2  branch (merge ✓)`) needs it.
    branch: pr.branch,
    ...(pr.issue === undefined ? {} : { issue: pr.issue }),
    ...(pr.props === undefined ? {} : { props: pr.props }),
  }
}

function stepObservation(input: StepExecution): JobObservation {
  return {
    lifecycle: input.step,
    identity: { run: input.run, step: input.step },
    attributes: {
      index: input.index,
      // The run's base, carried so the habitant timeline can name a step row
      // `[<base>#<run> <index>:<step>]`; every change in a run shares its base.
      ...(input.prs[0]?.base === undefined ? {} : { base: input.prs[0].base }),
      prs: input.prs.map(deliveryIdentity),
      ...(input.targetSha === undefined ? {} : { targetSha: input.targetSha }),
    },
  }
}

type StepArtifactReference = Readonly<{
  name?: string
  path?: string
  kind?: string
  uri?: string
}>

function stepArtifactReference(value: unknown): StepArtifactReference | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Readonly<Record<string, unknown>>
  const path = typeof record.path === "string" && record.path !== "" ? record.path : undefined
  const uri = typeof record.uri === "string" && record.uri !== "" ? record.uri : undefined
  if (path === undefined && uri === undefined) return undefined
  return {
    ...(typeof record.name === "string" && record.name !== "" ? { name: record.name } : {}),
    ...(path === undefined ? {} : { path }),
    ...(typeof record.kind === "string" && record.kind !== "" ? { kind: record.kind } : {}),
    ...(uri === undefined ? {} : { uri }),
  }
}

function directStepArtifacts(value: unknown): readonly StepArtifactReference[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return []
  const artifacts = (value as Readonly<Record<string, unknown>>).artifacts
  if (!Array.isArray(artifacts)) return []
  return artifacts.flatMap((artifact) => {
    const reference = stepArtifactReference(artifact)
    return reference === undefined ? [] : [reference]
  })
}

function nestedStepArtifacts(value: unknown): readonly StepArtifactReference[] {
  if (value === null || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(nestedStepArtifacts)
  const record = value as Readonly<Record<string, unknown>>
  return [
    ...directStepArtifacts(record),
    ...Object.entries(record).flatMap(([key, nested]) => (key === "artifacts" ? [] : nestedStepArtifacts(nested))),
  ]
}

/** Queue owns the standardized artifact convention for its step definitions.
 * Generic Jobs keeps result/evidence payloads opaque and invokes only this
 * definition-owned typed projection. Output and waiting artifacts are direct;
 * typed refusal evidence may nest the command evidence that owns its files. */
function stepResultObservation(result: JobResult): Readonly<Record<string, unknown>> {
  const artifacts = [
    ...(result.status === "waiting" ? directStepArtifacts(result) : directStepArtifacts(result.output)),
    ...(result.status === "completed" && result.conclusion === "failure"
      ? nestedStepArtifacts(result.error.evidence)
      : []),
  ]
  if (artifacts.length === 0) return {}
  return {
    artifacts: [...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()],
  }
}

function runEvidence(run: DeepReadonly<Run>): Record<string, unknown> {
  return {
    run: run.id,
    base: run.base,
    status: run.status,
    ...(run.conclusion === undefined ? {} : { conclusion: run.conclusion }),
    prs: run.prs.map(deliveryIdentity),
    steps: run.steps.map((step) => step.name),
  }
}

function queueRunOutcome(run: DeepReadonly<Run>): YrdLifecycleOutcome {
  if (Queues.succeeded(run)) return "succeeded"
  if (Queues.failed(run)) {
    // When a step Job failed, that step already owns the single ERROR
    // (yrd:jobs:<step>); the run settles at INFO so one failure is not re-raised
    // as a duplicate ERROR one level up. But a run that failed with NO step to
    // own it — a pinned/stale-base refusal rejected before the step's Job ran
    // (record.failure) — has no deeper ERROR. The run must own it, or the
    // failure is silent: fail loud with a run-scoped ERROR.
    const stepOwned = run.steps.some((step) => step.job !== undefined && jobFailed(step.job))
    return stepOwned ? "settled" : "failed"
  }
  if (Queues.terminal(run)) return "settled"
  return "progress"
}

function queueRunsOutcome(runs: readonly DeepReadonly<Run>[]): YrdLifecycleOutcome {
  if (runs.some((run) => run.status === "queued" || run.status === "in_progress" || run.status === "waiting")) {
    return "progress"
  }
  // As with a single run, a batch that finished with failures does not re-raise
  // ERROR: each failing run's deepest job already did. The compose settles at
  // INFO, and composeSettlementLabel names the per-run mix on the message.
  if (runs.some(Queues.failed)) return "settled"
  return "succeeded"
}

/** Name the per-run outcome mix of a settled compose so the flat "compose
 * failed" never misrepresents a batch that also passed runs. Returns undefined
 * for a uniform or still-running batch (the plain outcome word reads fine
 * there); a mixed/all-failed terminal batch gets `settled: N failed, M passed`. */
function composeSettlementLabel(runs: readonly DeepReadonly<Run>[]): string | undefined {
  if (runs.length === 0 || !runs.every(Queues.terminal)) return undefined
  const failed = runs.filter(Queues.failed).length
  if (failed === 0) return undefined
  const passed = runs.filter(Queues.succeeded).length
  const other = runs.length - failed - passed
  const parts = [`${failed} failed`]
  if (passed > 0) parts.push(`${passed} passed`)
  if (other > 0) parts.push(`${other} other`)
  return `settled: ${parts.join(", ")}`
}

function queueFailedEvent(
  state: DeepReadonly<RuntimeState>,
  run: DeepReadonly<Pick<QueueRecord, "id" | "prs">>,
  error: DeepReadonly<JobError>,
  job?: DeepReadonly<Pick<Job, "id" | "attempt">>,
): EventDraft {
  return event("queue/run/failed", {
    run: run.id,
    error,
    ...(job === undefined ? {} : { job: { id: job.id, attempt: job.attempt } }),
    // The `submitter` a record revision carried is gone with the store; a run
    // member records no author, so the field is simply absent since S7.
    prs: run.prs.map((pr) => ({ pr: pr.id, revision: pr.revision, headSha: pr.headSha })),
  })
}

function sameSubmoduleModelSource(
  left: NonNullable<Candidate["componentModelChanges"]>[number]["source"],
  right: NonNullable<Candidate["componentModelChanges"]>[number]["source"],
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.repo === right.repo &&
    left.fromHeadSha === right.fromHeadSha &&
    left.toHeadSha === right.toHeadSha &&
    left.patchId === right.patchId &&
    left.rangeDiff === right.rangeDiff
  )
}

function sameSubmoduleModelAuthorization(
  left: NonNullable<Candidate["componentModelChanges"]>[number],
  right: NonNullable<Candidate["componentModelChanges"]>[number],
): boolean {
  const sameDecision =
    left.operation === right.operation &&
    left.path === right.path &&
    left.ruling === right.ruling &&
    left.authorizer === right.authorizer &&
    left.pr === right.pr
  if (!sameDecision) return false
  if (left.revision === right.revision && left.headSha === right.headSha) {
    return left.patchId === right.patchId && sameSubmoduleModelSource(left.source, right.source)
  }
  if (left.patchId === undefined || right.patchId === undefined || left.patchId !== right.patchId) return false
  return (
    right.source?.fromHeadSha === left.headSha &&
    right.source.toHeadSha === right.headSha &&
    right.source.patchId === right.patchId &&
    right.source.rangeDiff === "="
  )
}

/** One ruling is a one-shot decision about one immutable change, never a
 * standing permission. Candidate facts are retained in the Journal projection,
 * so the spend survives retries, restarts, and terminal-run compaction. */
export function assertSubmoduleModelAuthorizationsAvailable(
  queues: DeepReadonly<QueuesState>,
  candidate: DeepReadonly<Pick<Candidate, "componentModelChanges">>,
): void {
  const prior = Object.values(queues.candidates).flatMap((entry) => entry.componentModelChanges ?? [])
  const claimed = [...prior]
  for (const authorization of candidate.componentModelChanges ?? []) {
    const existing = claimed.filter(({ ruling }) => ruling === authorization.ruling)
    if (existing.length > 0 && !existing.some((entry) => sameSubmoduleModelAuthorization(entry, authorization))) {
      const first = existing[0] as (typeof existing)[number]
      raiseFailure(
        "refusal",
        "component-model-ruling-spent",
        `yrd: component-model ruling '${authorization.ruling}' is already spent by ` +
          `${first.pr} revision ${first.revision} (${first.operation} ${first.path}); ` +
          `ask @cto for a new ruling for ${authorization.operation} ${authorization.path}`,
      )
    }
    claimed.push(authorization)
  }
}

function createQueueCommands(
  steps: readonly RuntimeStep[],
  byName: ReadonlyMap<string, RuntimeStep>,
  needsPersonOwner: string,
  requiresPreparedCandidate = false,
): QueueCommands {
  const admissionStep = command({
    title: "Run one revision required check",
    params: AdmissionStepArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmissionStepArgs) {
      // Freshness referent (same rule as pinnedChangeError): the member answers
      // from its live submit fact at exactly the pinned sha and base. The record
      // arm this used to choose between is gone with the store.
      const fresh =
        state.bays.submits[args.pr.branch]?.sha === args.pr.headSha &&
        baseIdentity(state.bays.submits[args.pr.branch]?.base ?? "") === baseIdentity(args.pr.base)
      if (!fresh) {
        raiseFailure(
          "refusal",
          "stale-pr",
          `yrd: required checks target stale revision ${args.pr.revision} (${args.pr.headSha}) of change '${args.pr.id}'`,
        )
      }
      const selected = admissionSteps(steps)
      const step = selected[args.index]
      if (step === undefined || step.name !== args.step) {
        throw new Error(`yrd: required check ${args.index} is '${step?.name ?? "missing"}', not '${args.step}'`)
      }
      if (
        args.candidate.baseSha !== args.pr.baseSha ||
        args.candidate.revs.length !== 1 ||
        args.candidate.revs[0]?.pr !== args.pr.id ||
        args.candidate.revs[0]?.n !== args.pr.revision ||
        args.candidate.revs[0]?.head !== args.pr.headSha
      ) {
        throw new Error(`yrd: required-check Candidate '${args.candidate.id}' does not match change '${args.pr.id}'`)
      }
      const key = admissionJobKey(args.pr, args.candidate.baseSha, args.index, step.revision)
      if (state.jobs.byKey[key] !== undefined) return { events: [] }
      if (state.queues.candidates[args.candidate.id] === undefined) {
        assertSubmoduleModelAuthorizationsAvailable(state.queues, args.candidate)
      }
      return {
        events: [
          ...(state.queues.candidates[args.candidate.id] === undefined
            ? [event("queue/candidate/created", args.candidate)]
            : []),
          step.job.request(
            {
              run: admissionExecutionId(args.pr, args.candidate.baseSha),
              step: step.name,
              index: args.index,
              prs: [args.pr],
              candidate: args.candidate,
              shape: args.shape as ChangeShape,
            },
            { key },
          ),
        ],
      }
    },
  })

  const pause = command({
    title: "Pause queue",
    visibility: "public",
    params: PauseQueueArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: PauseQueueArgs) {
      const base = baseIdentity(args.base)
      const paused = {
        ...args,
        base,
        allowedPRs: [...args.allowedPRs].toSorted(compareNatural),
      }
      const current = state.queues.pauses[base]
      if (
        current?.reason === paused.reason &&
        current.expiresAt === paused.expiresAt &&
        current.allowedPRs.length === paused.allowedPRs.length &&
        current.allowedPRs.every((pr, index) => pr === paused.allowedPRs[index])
      ) {
        return { events: [] }
      }
      return { events: [event("queue/paused", paused)] }
    },
  })

  const expirePause = command({
    title: "Expire queue pause",
    visibility: "internal",
    params: ExpireQueuePauseArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ base: string; expiresAt: string }>) {
      const base = baseIdentity(args.base)
      const current = state.queues.pauses[base]
      return {
        events:
          current?.expiresAt === args.expiresAt
            ? [event("queue/pause/expired", { base, expiresAt: args.expiresAt })]
            : [],
      }
    },
  })

  const resume = command({
    title: "Resume queue",
    visibility: "public",
    params: ResumeQueueArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ base: string }>) {
      const base = baseIdentity(args.base)
      return { events: state.queues.pauses[base] === undefined ? [] : [event("queue/resumed", { base })] }
    },
  })

  const run = command({
    title: "Run queue",
    visibility: "public",
    params: QueueRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: QueueRunArgs) {
      if (args.steps?.length === 0) return { events: [] }
      const selected = requestedOrDeclaredSteps(steps, args.steps, args.declaredPlan)
      const selection = stepSelection(
        steps,
        selected,
        args.steps === undefined ? "configured" : "explicit",
        args.steps === undefined ? args.declaredPlan : undefined,
      )
      const explicitStepAuthority = selection.authority === "explicit"
      const selectionResult = runnableChangeSelection(state, args, steps, needsPersonOwner, new Set(), {
        explicitStepAuthority,
      })
      const prs = selectionResult.prs
      if (prs.length === 0) {
        const rejected = selectionResult.decisions.filter(({ eligibility }) => !eligibility.runnable)
        const unrecorded = unrecordedSubmits(state.bays, state.queues)
        return {
          events: [],
          value:
            rejected.length === 0 && unrecorded.length === 0
              ? queueRunNoSubmittedPRs(state.bays, selected, new Set())
              : queueRunNoRunnablePRs(rejected, selected, unrecorded),
        }
      }
      const base = prs[0] === undefined ? undefined : baseIdentity(prs[0].base)
      if (base === undefined) throw new Error("yrd: a queue run requires at least one change")
      if (prs.some((pr) => baseIdentity(pr.base) !== base)) {
        throw new Error("yrd: one queue candidate cannot span base branches")
      }
      if (prs.length > state.queues.batchSize) {
        throw new Error(
          `yrd: queue candidate has ${prs.length} PRs; configured batch size is ${state.queues.batchSize}`,
        )
      }
      const active = runningQueue(state.queues, state.jobs, base)
      const selectedPRs = new Set(prs.map((pr) => pr.id))
      const superseded =
        active !== undefined &&
        explicitStepAuthority &&
        active.prs.every((pr) => selectedPRs.has(pr.id)) &&
        unstartedAdmission(active, state.queues, steps)
          ? active
          : undefined
      // A check-only admission (no integrating steps) never moves the base, so
      // it must not gate the START of an integrating run — gating here was the
      // deepest layer of the 2026-07-22 merge-starvation livelock. Integrating
      // runs still conflict with each other, a new non-integrating run still
      // waits for whatever is active, and same-PR overlap stays impossible via
      // the claims layer (a change inside a started admission is not runnable).
      const plansIntegration = (plan: readonly { kind: StepKind }[]): boolean =>
        plan.some((step) => step.kind !== "check")
      const checkOnlyActive = active !== undefined && !plansIntegration(active.steps) && plansIntegration(selected)
      if (active !== undefined && !checkOnlyActive && superseded === undefined) {
        throw new QueueRunningConflict(base, active.id)
      }
      const integrated = integratedChangeShape(prs)
      validateSequence(selected, integrated !== undefined)
      const snapshots = prs.map(Queues.snapshot)
      const candidateBaseSha = args.baseSha ?? requiredCandidateBaseSha(snapshots)
      const candidateSnapshots = pinCandidateBaseSha(snapshots, candidateBaseSha)
      const admissionReuse =
        integrated === undefined && !explicitStepAuthority
          ? reusableRevisionAdmission(state, candidateSnapshots, selected)
          : undefined
      const runReuse =
        integrated === undefined && !explicitStepAuthority && admissionReuse === undefined
          ? reusablePrefix(state, candidateSnapshots, selected)
          : undefined
      const reuse = admissionReuse ?? runReuse
      const remaining = reuse === undefined ? selected : selected.slice(reuse.count)
      const reusedRun: RunId | undefined =
        reuse !== undefined && "run" in reuse && typeof reuse.run === "string" ? reuse.run : undefined
      if (remaining.length === 0 && reuse !== undefined) {
        return {
          events: [],
          value: queueRunReuseCovered(
            candidateSnapshots.map((snapshot) => snapshot.id),
            selected,
            admissionReuse === undefined ? "queue-run" : "revision-admission",
            runReuse?.run,
          ),
        }
      }
      const derivedAuthority = derivedAuthorityLookup(state)
      const authorityGap = queueAuthorityGaps(
        state.queues.authority,
        candidateSnapshots,
        remaining,
        integrated !== undefined,
        derivedAuthority,
      )[0]
      if (authorityGap !== undefined) {
        // The consumed-authority arm used to answer with a durable
        // `pr/needs-author` written onto the gap's RECORD. With no record to
        // carry it, every gap — consumed or missing — refuses here instead, and
        // the compose's refusal ledger is what makes it durable.
        requireQueueAuthority(
          state.queues.authority,
          candidateSnapshots,
          remaining,
          integrated !== undefined,
          derivedAuthority,
        )
      }
      if (requiresPreparedCandidate && args.candidate === undefined) {
        throw new Error("yrd: queue run requires prepared Candidate facts")
      }
      if (args.candidate !== undefined && state.queues.candidates[args.candidate.id] === undefined) {
        assertSubmoduleModelAuthorizationsAvailable(state.queues, args.candidate)
      }
      const started = startRun(
        state.queues,
        Queues.nextId(state.queues),
        candidateSnapshots,
        candidateBaseSha,
        args.candidate,
        remaining,
        selection,
        reuse?.shape ?? integrated ?? ChangeShape(candidateSnapshots),
        integrated?.integration,
        {},
        reuse === undefined
          ? undefined
          : { ...(reusedRun === undefined ? {} : { run: reusedRun }), results: reuse.shape.results },
      )
      return superseded === undefined
        ? started
        : {
            run: started.run,
            events: [
              queueFailedEvent(state, superseded, {
                code: "step-selection-superseded",
                message: `explicit steps '${selection.steps.join(",")}' superseded unstarted configured checks`,
              }),
              ...started.events,
            ],
          }
    },
  })

  const advance = command({
    title: "Advance queue run",
    params: AdvanceArgsSchema,
    apply: (state: DeepReadonly<RuntimeState>, args) =>
      advanceQueue(state, Queues.record(state.queues, args.run), byName),
  })

  const settled = command({
    title: "Release settled queue run projection",
    params: SettledArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: Readonly<{ run: RunId }>) {
      const record = Queues.record(state.queues, args.run)
      if (record.parent !== undefined) return { events: [] }
      const run = materializeRun(record, state.jobs)
      if (needsSettlement(state, run)) return { events: [] }
      const root = resolveQueueAuthorityRoot(state.queues.authority, run.id)
      // Carry the run's terminal projection into the settlement fact. `passed`
      // is the outcome that has no other record-level proof, so without this the
      // run's status dies with its Jobs when retention prunes them. The fact
      // names `root`, so only attach a status the root's own projection owns.
      const settledRun = root === run.id ? run : materializeRun(Queues.record(state.queues, root), state.jobs)
      const status =
        settledRun.status !== "completed"
          ? undefined
          : settledRun.conclusion === "success"
            ? ("passed" as const)
            : settledRun.conclusion === "cancelled"
              ? ("canceled" as const)
              : ("failed" as const)
      // S6 → S7 — every member's SINGLE terminal-emission point. A recordless
      // member has no store to absorb `pr/integrated` through an advance (and
      // an advance-side emission would repeat: nothing state-visible marks it
      // done), so the settlement batch carries its terminal facts, sourced
      // from each run's own snapshots — and the settled event's application
      // retires the root from the active set, which is what makes this
      // once-per-run by construction. S7 widens the same batch to RECORD
      // members (the advance-path record loop is deleted): while records
      // still exist — until the store-deletion step — their terminals emit
      // here byte-identically to that loop, same fields, same store dedupe,
      // same submit-fact retirement, so a run straddling the cutover cannot
      // double-emit. The whole settled
      // TREE emits here, per PASSED run: a bisected root fails while its
      // isolated children merge their halves, and those merges' terminals
      // used to ride the children's own advances — with the advance loop
      // gone, the root's settlement is the one write that still sees them.
      const memberTerminals: EventDraft[] = settlementTreeRuns(state, settledRun).flatMap((settling): EventDraft[] => {
        // Integration PROOF is the emission key, not the run's conclusion: a
        // run whose merge landed and whose deploy then failed is a FAILED run
        // of MERGED members — the advance loop emitted their terminals at the
        // merge step regardless of later steps, and judging by conclusion here
        // would leave repository-merged members reading `submitted` forever.
        const integration = settling.integration
        if (integration === undefined) return []
        return settling.prs
          .filter((member) => member.intent === undefined)
          .flatMap((member): EventDraft[] => {
            const alreadyMerged = integration.alreadyLanded
            if (alreadyMerged !== undefined) {
              return [
                event("pr/already-landed", {
                  pr: member.id,
                  revision: member.revision,
                  headSha: member.headSha,
                  run: settling.id,
                  ...(member.issue === undefined ? {} : { issueRef: member.issue }),
                  baseSha: integration.baseSha,
                  candidateSha: alreadyMerged.candidateSha,
                  candidateTreeSha: alreadyMerged.candidateTreeSha,
                  baseTreeSha: alreadyMerged.baseTreeSha,
                  ...(member.props === undefined ? {} : { props: member.props }),
                }),
              ]
            }
            if (member.changeId === undefined) {
              // Unreachable for a member the derived admission built — it
              // refuses a tip without a Change-Id trailer — and a merged
              // truth without stable identity must not be claimed.
              return []
            }
            return [
              event("pr/integrated", {
                pr: member.id,
                revision: member.revision,
                headSha: member.headSha,
                run: settling.id,
                ...(member.issue === undefined ? {} : { issueRef: member.issue }),
                commit: integration.commit,
                landingSha: integration.commit,
                baseSha: integration.baseSha,
                changeId: member.changeId,
                ...(member.props === undefined ? {} : { props: member.props }),
              }),
            ]
          })
      })
      // UNCONDITIONAL, and the guard it replaces is why (S7, branch-is-change).
      // This read `claimed || memberTerminals.length > 0`, where `claimed`
      // asked whether `authority.claims` held a token consumed by this root.
      // That store is written only by the `pr/submitted` and
      // `pr/checks-requested` reducers, both bare `return state` since the
      // change-record store was deleted, so `claimed` is now false for every
      // run that has ever existed. For a DERIVED member neither disjunct can
      // fire — no stored claim, and a check-only run has no integration to
      // produce a member terminal — so a non-integrating root emitted NOTHING
      // and journaled no `queue/run/settled` at all.
      //
      // That is the R1582 phantom-run class, and the invariant it breaks is
      // stated four lines above: `passed` is the outcome with no other
      // record-level proof, so the run's status died with its Jobs the moment
      // retention pruned them, and the run resurrected as a `running` row over
      // already-integrated work.
      //
      // Nothing here needed a claim to be correct. Every early return above has
      // already established that this is a settled ROOT — `record.parent` is
      // undefined and `needsSettlement` is false — which is the whole
      // precondition for the fact. Re-emission is bounded by the same facts:
      // `markQueueTerminalRoot` is idempotent, and a root it has marked leaves
      // {@link activeQueueRootIds}, so `cleanupSettledRoots` cannot pick it up
      // a second time.
      return {
        events: [
          ...memberTerminals,
          event("queue/run/settled", { run: root, ...(status === undefined ? {} : { status }) }),
        ],
      }
    },
  })

  const isolate = command({
    title: "Isolate failed queue batch",
    params: IsolateArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args) {
      const parent = materializeRun(Queues.record(state.queues, args.run), state.jobs)
      if (childQueue(state.queues, state.jobs, parent.id, args.part) !== undefined) return { events: [] }
      if (!bisectable(parent)) throw new Error(`yrd: queue run '${parent.id}' is not a failed pre-merge batch`)
      const active = runningQueue(state.queues, state.jobs, parent.base)
      if (active !== undefined) throw new QueueRunningConflict(parent.base, active.id)

      // A batch can only bisect if its recorded plan still matches the installed
      // catalog. If the plan drifted, isolation is impossible under any config —
      // raise a TYPED stale-plan refusal (not the bare requirePlannedStep throw)
      // so the compose layer can retire it once instead of re-refusing forever.
      const drift = recordedPlanDrift(parent.steps, byName)
      if (drift !== undefined) {
        raiseFailure("refusal", "stale-plan", `yrd: queue run '${parent.id}' cannot isolate: ${drift}`)
      }
      const pivot = Math.ceil(parent.prs.length / 2)
      const prs = args.part === 0 ? parent.prs.slice(0, pivot) : parent.prs.slice(pivot)
      if (prs.length === 0) throw new Error(`yrd: queue run '${parent.id}' has no isolation part ${args.part}`)
      if (requiresPreparedCandidate && args.candidate === undefined) {
        throw new Error("yrd: queue isolation requires prepared Candidate facts")
      }
      if (args.candidate !== undefined && state.queues.candidates[args.candidate.id] === undefined) {
        assertSubmoduleModelAuthorizationsAvailable(state.queues, args.candidate)
      }
      const selected = parent.steps.map((planned) => requirePlannedStep(byName, planned))
      const parentCandidate = state.queues.candidates[parent.candidateId]
      if (parentCandidate === undefined) {
        throw new Error(`yrd: queue run '${parent.id}' names missing Candidate '${parent.candidateId}'`)
      }
      const started = startRun(
        state.queues,
        Queues.nextId(state.queues),
        prs,
        parentCandidate.baseSha,
        args.candidate,
        selected,
        parent.stepSelection,
        ChangeShape(prs),
        undefined,
        {
          parent: parent.id,
        },
      )
      return {
        events: [
          event("queue/batch/isolated", {
            parent: parent.id,
            run: started.run.id,
            part: args.part,
            prs: prs.map((pr) => pr.id),
          }),
          ...started.events,
        ],
      }
    },
  })

  const retireStalePlan = command({
    title: "Retire an un-isolable stale-plan batch",
    visibility: "public",
    params: AdvanceArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      const run = materializeRun(record, state.jobs)
      // Idempotent: a batch already retired carries a release-reason error, which
      // flips `bisectable` false — re-dispatch (replay, a second recover) is a
      // clean no-op, never a duplicate failed event.
      if (!bisectable(run)) return { events: [] }
      const drift = recordedPlanDrift(run.steps, byName)
      // Guard the typed release: only a genuinely-drifted plan retires. A current
      // plan is still isolable, so refuse rather than silently retiring a live batch.
      if (drift === undefined) {
        raiseFailure(
          "refusal",
          "run-plan-current",
          `yrd: queue run '${args.run}' plan matches the installed catalog; nothing to retire`,
        )
      }
      return {
        events: [queueFailedEvent(state, record, { code: "stale-plan", message: `yrd: cannot isolate: ${drift}` })],
      }
    },
  })

  const cancelRun = command({
    title: "Cancel queue run",
    visibility: "public",
    params: CancelRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: CancelRunArgs) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) {
        raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      }
      const run = materializeRun(record, state.jobs)
      if (Queues.terminal(run)) {
        raiseFailure(
          "refusal",
          "run-terminal",
          `yrd: queue run '${args.run}' is ${run.status}; only a running or waiting run can be canceled`,
        )
      }
      return { events: [event("queue/run/canceled", { run: args.run, by: args.by, reason: args.reason })] }
    },
  })

  const quiesceLegacyRun = command({
    title: "Quiesce a pre-settlement legacy queue run",
    params: QuiesceLegacyRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: QuiesceLegacyRunArgs) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) {
        raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      }
      const run = materializeRun(record, state.jobs)
      if (Queues.terminal(run)) {
        // Idempotent: a replay that already folded the settlement meets a terminal
        // root and re-quiescing it is a no-op, never a duplicate failure event.
        return { events: [] }
      }
      // Fail (not cancel) so record.failure fixes the run terminal: a canceled run
      // whose PR is still submitted re-queues (needsAdvance), which is not settled.
      return { events: [queueFailedEvent(state, record, { code: "legacy-quiesced", message: args.reason })] }
    },
  })

  const settleOrphanedRun = command({
    title: "Settle a queue run whose writer disappeared before its step started",
    params: SettleOrphanedRunArgsSchema,
    apply(state: DeepReadonly<RuntimeState>, args: SettleOrphanedRunArgs) {
      const record = Queues.resolve(state.queues, args.run)
      if (record === undefined) raiseFailure("refusal", "run-not-found", `yrd: no queue run '${args.run}'`)
      const run = materializeRun(record, state.jobs)
      // Idempotent: a replay or a second recover meets a terminal run and settles
      // nothing, never a duplicate failure event.
      if (Queues.terminal(run)) return { events: [] }
      const step = run.steps[run.cursor]
      // Guard the typed release: only a genuinely jobless cursor settles here. A
      // run with a live Job belongs to lease recovery, which reclaims it honestly.
      if (step === undefined || step.job !== undefined) {
        raiseFailure(
          "refusal",
          "run-not-orphaned",
          `yrd: queue run '${args.run}' has a job at step '${step?.name ?? run.cursor}'; nothing to settle`,
        )
      }
      // Fail (not cancel) so record.failure fixes the run terminal; `orphaned-run`
      // releases the run's queue authority, so a member PR that is still submitted
      // re-admits fresh instead of being rejected for a fault that is not its own.
      return { events: [queueFailedEvent(state, record, { code: "orphaned-run", message: args.reason })] }
    },
  })

  const admissionRefused = command({
    title: "Record a compose cycle that skipped a change without admitting it",
    params: AdmissionRefusedSchema,
    apply(state: DeepReadonly<RuntimeState>, args: AdmissionRefusedArgs) {
      // Fail loud on an unattributable refusal: the ledger's whole job is to name
      // the wedged PR, so a phantom id must never become a phantom finding. A
      // A member is attributable through the id-seam — its identity lives in
      // retained run snapshots — or, refused before ANY run retained a
      // snapshot, through the caller-carried branch+tree identity (wave defect
      // 1: without it the first-admission refusal journaled nothing and the
      // ledger stayed empty).
      const member = resolveMemberById(state.queues, args.pr)
      const identity =
        member === undefined
          ? args.branch !== undefined && args.revision !== undefined && args.headSha !== undefined
            ? { branch: args.branch, n: args.revision, head: args.headSha }
            : raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(state.bays, args.pr))
          : { branch: member.snapshot.branch, n: member.snapshot.revision, head: member.snapshot.headSha }
      const refused = event("queue/admission/refused", {
        pr: args.pr,
        code: args.code,
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        reason: args.reason,
        revision: identity.n,
        headSha: identity.head,
        branch: identity.branch,
      })
      return {
        events: structurallyPermanentAdmissionRefusal(args.code)
          ? [
              refused,
              event("queue/admission/settled", {
                pr: args.pr,
                revision: identity.n,
                headSha: identity.head,
                disposition: "needs-person",
                reason: args.reason,
              }),
            ]
          : [refused],
      }
    },
  })

  const settleAdmissionRefusal = command({
    title: "Settle one exact required-check refusal as needing a person",
    params: SettleAdmissionRefusalSchema,
    apply(state: DeepReadonly<RuntimeState>, args: SettleAdmissionRefusalArgs) {
      // S7 freshness: the ledger row names the branch, and the live submit fact
      // is that branch's current tree — the fact-CAS analogue of the record
      // revision match this replaces. A settlement aimed at a tree the fact has
      // moved off is stale exactly as before; a row whose branch cannot be
      // resolved at all cannot be CAS'd, and settling it blind would record a
      // disposition against a tree nothing can name.
      const row = state.queues.admissionRefusals[args.pr]
      const branch =
        row?.branch ?? latestChangeSnapshot(state.queues as QueuesState, (member) => member.id === args.pr)?.branch
      if (branch === undefined) {
        raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(state.bays, args.pr))
      }
      if (state.bays.submits[branch]?.sha !== args.headSha) {
        raiseFailure(
          "refusal",
          "stale-pr",
          `yrd: this settlement targets stale revision ${args.revision} (${args.headSha}) of change '${args.pr}'`,
        )
      }
      const refusal = row
      if (refusal === undefined) {
        raiseFailure(
          "refusal",
          "admission-refusal-missing",
          `yrd: change '${args.pr}' has no failed required check to settle`,
        )
      }
      if (refusal.revision !== undefined && (refusal.revision !== args.revision || refusal.headSha !== args.headSha)) {
        raiseFailure(
          "refusal",
          "admission-refusal-stale",
          `yrd: the failed check for change '${args.pr}' belongs to revision ${refusal.revision} (${refusal.headSha})`,
        )
      }
      if (
        refusal.settlement?.disposition === args.disposition &&
        refusal.settlement.reason === args.reason &&
        refusal.revision === args.revision &&
        refusal.headSha === args.headSha
      ) {
        return { events: [] }
      }
      return { events: [event("queue/admission/settled", args)] }
    },
  })

  return {
    queue: {
      admissionStep,
      run,
      pause,
      expirePause,
      resume,
      advance,
      settled,
      isolate,
      retireStalePlan,
      cancelRun,
      quiesceLegacyRun,
      settleOrphanedRun,
      admissionRefused,
      settleAdmissionRefusal,
    },
  }
}

type QueueAuthorityKind = "submit" | "checks"
type QueueAuthorityRelease = NonNullable<RunAuthority["released"]>
type QueueAuthorityGap = Readonly<{
  kind: QueueAuthorityKind
  pr: string
  revision: number
  headSha: string
  reason: "missing" | "consumed"
  consumedBy?: RunId
}>

function queueAuthorityReleaseReason(
  error: DeepReadonly<JobError> | undefined,
): QueueAuthorityRelease["reason"] | undefined {
  // A base race (the base branch or checked candidate ref moved out from under a
  // pinned Run) is environmental, not a change-content fault: release the Run's queue
  // authority so the still-submitted PR re-admits against the fresh base, instead
  // of terminally rejecting a change that would merge cleanly once the base settles.
  // `stale-steps` is the same shape one level up: a pending run's not-yet-started
  // step revision drifted out from under it when the installed config moved; the
  // PR is blameless and re-admits fresh under the installed plan. `stale-plan` is
  // the isolate-path sibling: a FAILED bisectable batch whose recorded plan
  // drifted can never be bisected under the installed catalog — retiring it
  // releases authority so it stops being reconciled forever (its terminal member
  // PRs simply re-admit if still submitted).
  if (
    error?.code === "queue-environment-refused" ||
    error?.code === "job-lost" ||
    error?.code === "stale-base" ||
    error?.code === "stale-check" ||
    error?.code === "stale-steps" ||
    error?.code === "stale-plan" ||
    // The authoritative root may already have merged when publication of its
    // derived submodule-main refs hits a transient push/fetch failure. The
    // promotion is idempotent and the root must never be compensated; release
    // the same PR revision so a fresh merge attempt reconciles the missing refs.
    error?.code === "component-main-promotion-failed" ||
    error?.code === "component-main-inspection-failed" ||
    // `orphaned-run` is the jobless sibling: the run's writer vanished before the
    // cursor step was requested (or its Jobs aged out of retention while the
    // record survived), so no Job exists to lose and no advance can ever move it.
    // The member PRs are blameless — release so they re-admit fresh.
    error?.code === "orphaned-run" ||
    isInfraRetryCompositionFailure(error?.code)
  ) {
    return error.code
  }
  return undefined
}

function authorityRequirement(
  authority: DeepReadonly<QueueAuthorityState>,
  pr: DeepReadonly<ChangeSnapshot>,
  steps: readonly DeepReadonly<InstalledStep>[],
  alreadyIntegrated = false,
): QueueAuthorityKind | undefined {
  if (pr.intent !== undefined) return undefined
  if (steps.some((step) => step.kind === "merge")) return "submit"
  if (alreadyIntegrated) return undefined
  if (availableAuthorityToken(authority.checks[pr.id], pr)) return "checks"
  if (availableAuthorityToken(authority.submits[pr.id], pr)) return "submit"
  // No token is available: the authority LEVEL still decides which kind this
  // member must hold. A submit fact for this exact revision — consumed or not —
  // means the member operates under submit-level authority (submit covers
  // checks); without one it is a draft revision and can only ever hold
  // checks-level authority. Derived from the token facts alone: the stored
  // per-change status copy this used to read is deleted (22991 phase 2), and
  // a projection-path caller has no cross-slice record to consult.
  return sameAuthorityToken(authority.submits[pr.id], pr) ? "submit" : "checks"
}

function sameAuthorityToken(
  token: DeepReadonly<QueueAuthorityToken> | undefined,
  pr: DeepReadonly<ChangeSnapshot>,
): boolean {
  if (token === undefined) return false
  return token.pr === pr.id && token.revision === pr.revision && token.headSha === pr.headSha
}

function availableAuthorityToken(
  token: DeepReadonly<QueueAuthorityToken> | undefined,
  pr: DeepReadonly<ChangeSnapshot>,
): boolean {
  return sameAuthorityToken(token, pr) && token?.consumedBy === undefined
}

function queueAuthorityGaps(
  authority: DeepReadonly<QueueAuthorityState>,
  prs: readonly DeepReadonly<ChangeSnapshot>[],
  steps: readonly DeepReadonly<InstalledStep>[],
  alreadyIntegrated = false,
  derived?: DerivedAuthorityLookup,
): QueueAuthorityGap[] {
  const gaps: QueueAuthorityGap[] = []
  for (const pr of prs) {
    const kind = authorityRequirement(authority, pr, steps, alreadyIntegrated)
    if (kind === undefined) continue
    const token = kind === "submit" ? authority.submits[pr.id] : authority.checks[pr.id]
    if (token === undefined || !sameAuthorityToken(token, pr)) {
      // Derived members (S6) hold no token: their standing authority IS the
      // live submit fact for exactly this sha, consumption derived from run
      // history — no event, no projection (design §2).
      const fact = derived?.(pr as ChangeSnapshot)
      if (fact?.standing === true) continue
      if (fact !== undefined) {
        gaps.push({
          kind,
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          reason: "consumed",
          consumedBy: fact.consumedBy,
        })
        continue
      }
      gaps.push({ kind, pr: pr.id, revision: pr.revision, headSha: pr.headSha, reason: "missing" })
    } else {
      const consumedBy = token.consumedBy
      if (consumedBy === undefined) continue
      gaps.push({
        kind,
        pr: pr.id,
        revision: pr.revision,
        headSha: pr.headSha,
        reason: "consumed",
        consumedBy,
      })
    }
  }
  return gaps
}

function requireQueueAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  prs: readonly DeepReadonly<ChangeSnapshot>[],
  steps: readonly DeepReadonly<InstalledStep>[],
  alreadyIntegrated = false,
  derived?: DerivedAuthorityLookup,
): void {
  const gap = queueAuthorityGaps(authority, prs, steps, alreadyIntegrated, derived)[0]
  if (gap === undefined) return
  const detail =
    gap.reason === "consumed"
      ? `${gap.kind} authority was consumed by queue run '${gap.consumedBy}'`
      : `no ${gap.kind} authority fact exists`
  raiseFailure(
    "refusal",
    `queue-${gap.kind}-authority-${gap.reason}`,
    `yrd: change '${gap.pr}' revision ${gap.revision} (${gap.headSha}) cannot start a queue run: ${detail}`,
  )
}

function projectRunAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  run: DeepReadonly<QueueStart>,
): QueueAuthorityState {
  if (run.parent !== undefined) {
    const inherited = projectionLookupGet(authority.runs, run.parent)
    const members = new Set(run.prs.map((pr) => pr.id))
    return {
      ...authority,
      runs: projectionLookupSet(authority.runs, run.id, {
        inheritedFrom: run.parent,
        missingSubmits:
          inherited === undefined
            ? run.prs.map((pr) => pr.id)
            : inherited.missingSubmits.filter((pr) => members.has(pr)),
        missingChecks: inherited === undefined ? [] : inherited.missingChecks.filter((pr) => members.has(pr)),
      }),
    }
  }

  const gaps = queueAuthorityGaps(authority, run.prs, run.steps, run.initialIntegration !== undefined)
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  const explicitSettlement = run.settlement === "explicit"
  const consumesSubmit = run.steps.some((step) => step.kind === "merge")
  for (const pr of run.prs) {
    const current = authority.current[pr.id]
    if (explicitSettlement && current !== undefined && sameAuthorityToken(current, pr)) {
      claims[pr.id] = {
        pr: current.pr,
        revision: current.revision,
        headSha: current.headSha,
        consumedBy: run.id,
      }
    }
    const kind = authorityRequirement(authority, pr, run.steps, run.initialIntegration !== undefined)
    if (kind === undefined) continue
    const token = kind === "submit" ? authority.submits[pr.id] : authority.checks[pr.id]
    if (token === undefined || !sameAuthorityToken(token, pr) || token.consumedBy !== undefined) continue
    const consumed: QueueAuthorityToken = {
      pr: token.pr,
      revision: token.revision,
      headSha: token.headSha,
      consumedBy: run.id,
    }
    if (explicitSettlement) claims[pr.id] = consumed
    if (kind === "submit" && consumesSubmit) submits[pr.id] = consumed
    if (kind === "checks") checks[pr.id] = consumed
  }
  return {
    ...authority,
    submits,
    checks,
    claims,
    runs: projectionLookupSet(authority.runs, run.id, {
      missingSubmits: gaps.filter((gap) => gap.kind === "submit").map((gap) => gap.pr),
      missingChecks: gaps.filter((gap) => gap.kind === "checks").map((gap) => gap.pr),
    }),
  }
}

function resolveQueueAuthorityRoot(authority: DeepReadonly<QueueAuthorityState>, run: RunId): RunId {
  const seen = new Set<RunId>()
  let root = run
  while (true) {
    if (seen.has(root)) throw new Error(`yrd: queue authority ancestry for '${run}' is cyclic`)
    seen.add(root)
    const projected = projectionLookupGet(authority.runs, root)
    if (projected === undefined) throw new Error(`yrd: queue run '${root}' has no authority projection`)
    if (projected.inheritedFrom === undefined) return root
    root = projected.inheritedFrom
  }
}

function releaseRunAuthority(
  authority: DeepReadonly<QueueAuthorityState>,
  run: DeepReadonly<QueueRecord>,
  release: QueueAuthorityRelease,
): QueueAuthorityState {
  const root = resolveQueueAuthorityRoot(authority, run.id)
  const projected = projectionLookupGet(authority.runs, run.id)
  if (projected === undefined) throw new Error(`yrd: queue run '${run.id}' has no authority projection`)
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  for (const pr of run.prs) {
    const submit = authority.submits[pr.id]
    if (submit !== undefined && sameAuthorityToken(submit, pr) && submit.consumedBy === root) {
      submits[pr.id] = { pr: submit.pr, revision: submit.revision, headSha: submit.headSha }
    }
    const check = authority.checks[pr.id]
    if (check !== undefined && sameAuthorityToken(check, pr) && check.consumedBy === root) {
      checks[pr.id] = { pr: check.pr, revision: check.revision, headSha: check.headSha }
    }
    if (claims[pr.id]?.consumedBy === root) delete claims[pr.id]
  }
  return {
    ...authority,
    submits,
    checks,
    claims,
    runs: projectionLookupSet(authority.runs, run.id, { ...projected, released: release }),
  }
}

function settleRunClaim(authority: DeepReadonly<QueueAuthorityState>, run: RunId): QueueAuthorityState {
  const root = resolveQueueAuthorityRoot(authority, run)
  const claims: Record<string, QueueAuthorityToken> = { ...authority.claims }
  for (const [pr, token] of Object.entries(authority.claims)) {
    if (token.consumedBy === root) delete claims[pr]
  }
  return { ...authority, claims }
}

function invalidateChangeAuthority(authority: DeepReadonly<QueueAuthorityState>, pr: string): QueueAuthorityState {
  const submits: Record<string, QueueAuthorityToken> = { ...authority.submits }
  const checks: Record<string, QueueAuthorityToken> = { ...authority.checks }
  delete submits[pr]
  delete checks[pr]
  return { ...authority, submits, checks }
}

function currentAuthorityMatches(
  authority: DeepReadonly<QueueAuthorityState>,
  token: DeepReadonly<QueueAuthorityToken>,
): boolean {
  const current = authority.current[token.pr]
  return current?.revision === token.revision && current.headSha === token.headSha
}

function terminalAuthorityMatches(
  authority: DeepReadonly<QueueAuthorityState>,
  terminal: DeepReadonly<{ pr: string; revision: number; headSha?: string }>,
  eventName: string,
  requireCurrent: boolean,
): boolean {
  const current = authority.current[terminal.pr]
  if (current === undefined) {
    if (requireCurrent) {
      throw new Error(`yrd: terminal '${eventName}' for change '${terminal.pr}' has no current queue authority`)
    }
    return false
  }
  if (
    current.revision !== terminal.revision ||
    (terminal.headSha !== undefined && current.headSha !== terminal.headSha)
  ) {
    throw new Error(
      `yrd: stale terminal '${eventName}' for change '${terminal.pr}' targets ${terminal.revision}@${terminal.headSha ?? "unknown"}; queue authority is ${current.revision}@${current.headSha}`,
    )
  }
  return true
}

function projectSettledQueueRun(state: DeepReadonly<QueueState>, applied: Event): QueueState {
  const settled = SettledEventSchema.parse(applied.data)
  const record = Queues.get(state.queues, settled.run)
  if (record === undefined) throw new Error(`yrd: no queue run '${settled.run}'`)
  if (record.parent !== undefined) throw new Error(`yrd: settled queue run '${settled.run}' is not a root`)
  // A settled `passed` run is terminal on the record from here on, so Job
  // retention can prune its Jobs without resurrecting it as a phantom `running`.
  // `failed`/`canceled` already carry their own record-level fact.
  const settledRecord =
    settled.status === "passed" && record.passedAt === undefined ? { ...record, passedAt: applied.ts } : record
  return {
    queues: markQueueTerminalRoot(
      {
        ...state.queues,
        authority: settleRunClaim(state.queues.authority, record.id),
        ...(settledRecord === record ? {} : { records: Queues.set(state.queues.records, settledRecord) }),
      },
      record.id,
    ),
  }
}

function markQueueTerminalRoot(queues: DeepReadonly<QueuesState>, root: RunId): QueuesState {
  if (queues.retention.terminalOrder[root] !== undefined) return queues as QueuesState
  const next = Math.max(0, ...Object.values(queues.retention.terminalOrder)) + 1
  return {
    ...queues,
    retention: { terminalOrder: { ...queues.retention.terminalOrder, [root]: next } },
  }
}

export function compactQueueProjection(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  bays: DeepReadonly<BaysState>,
): QueuesState {
  const runtime = { queues, jobs, bays }
  const terminalOrder = { ...queues.retention.terminalOrder }
  for (const root of Object.keys(terminalOrder)) {
    const order = jobs.retention.queueTerminalOrder[root]
    if (order !== undefined) terminalOrder[root] = order
  }
  for (const record of Queues.values(queues)) {
    if (record.parent !== undefined || record.settlement !== undefined) continue
    if (needsSettlement(runtime, materializeRun(record, jobs))) continue
    const order = jobs.retention.queueTerminalOrder[record.id]
    if (order === undefined) {
      // A pre-settlement root can carry its own durable failure/cancellation
      // without a terminal Job result (or after that result aged out). Rank
      // that explicit Queue authority before every result-ordered root so it
      // compacts first; never invent an order for an unexplained success.
      if (record.failure === undefined && record.canceledAt === undefined) {
        throw new Error(`yrd: quiesced legacy Queue root '${record.id}' has no terminal journal order`)
      }
      terminalOrder[record.id] = 0
      continue
    }
    terminalOrder[record.id] = order
  }
  // A refusal streak only describes a change that is still trying to get in. Drop
  // the entries for PRs that left the bay or reached a terminal delivery state
  // so the ledger cannot grow without bound (or outlive the wedge it names).
  const admissionRefusals = Object.fromEntries(
    Object.entries(queues.admissionRefusals).filter(([id, row]) => {
      // Still trying to get in ⇔ a live submit fact stands for the member's
      // branch, read from the row's own recorded branch or, for legacy rows,
      // the member's retained run snapshot. A row neither can resolve names
      // nothing a future cycle can wedge on again — drop it. (The record arm
      // this replaces keyed the same question on delivery state; keeping it
      // would have dropped EVERY streak at the first compaction after the
      // store emptied.)
      const branch =
        row.branch ?? latestChangeSnapshot(queues as QueuesState, (candidate) => candidate.id === id)?.branch
      return branch !== undefined && bays.submits[branch] !== undefined
    }),
  )
  return compactQueuesState(
    { ...queues, admissionRefusals, retention: { terminalOrder } },
    queueDecisionRoots(queues, bays),
  )
}

function queueDecisionRoots(queues: DeepReadonly<QueuesState>, bays: DeepReadonly<BaysState>): ReadonlySet<RunId> {
  const roots = new Set<RunId>()
  for (const record of Queues.values(queues)) {
    // A failed record carries its own terminal fact after Queue-owned Jobs
    // co-evict. Keep it only while that exact plan still governs admission.
    if (record.failure === undefined || record.stepSelection?.authority !== "admission" || record.prs.length !== 1) {
      continue
    }
    const snapshot = record.prs[0]
    if (snapshot === undefined) continue
    // The failed-admission decision still governs admission while the live
    // submit fact stands at EXACTLY the refused sha — the fact-CAS analogue of
    // the record arm's lookup-key freshness match. A moved or retired fact
    // superseded the refused tree, and the root ages out like any other
    // terminal.
    if (snapshot.intent !== undefined) continue
    const submit = bays.submits[snapshot.branch]
    if (submit === undefined || submit.sha !== snapshot.headSha) continue
    roots.add(queueRetentionRoot(queues, record.id))
  }
  return roots
}

/** The one production projection path for a started Queue run.
 *
 * S6 note, stated where the row is written: this projection is queues-slice
 * pure and cannot see `bays`, so a DERIVED member — whose standing authority
 * is its live submit fact, not a token — books here as `missingSubmits` in
 * token vocabulary. That row is a fact about TOKENS, not a verdict; the audit
 * (which holds the whole runtime state) interprets it through
 * `isDerivedRunMember` before reporting ancestry findings. */
export function projectQueueStarted(queues: DeepReadonly<QueuesState>, record: DeepReadonly<QueueRecord>): QueuesState {
  if (Queues.get(queues, record.id) !== undefined) throw new Error(`yrd: duplicate queue run '${record.id}'`)
  validateRunCandidateResult(queues, record)
  return {
    ...queues,
    records: Queues.set(queues.records, record),
    index: indexQueueStart(queues.index, record),
    authority: projectRunAuthority(queues.authority, record),
  }
}

function validateRunCandidateResult(queues: DeepReadonly<QueuesState>, record: DeepReadonly<QueueRecord>): void {
  const candidate = queues.candidates[record.candidateId]
  if (candidate === undefined) {
    throw new Error(`yrd: Queue run '${record.id}' names missing Candidate '${record.candidateId}'`)
  }
  const mismatch = (detail: string): never => {
    throw new Error(`yrd: Queue run '${record.id}' ${detail} Candidate '${candidate.id}'`)
  }
  const first = record.prs[0]
  if (first === undefined) {
    throw new Error(`yrd: Queue run '${record.id}' has no PR result for Candidate '${candidate.id}'`)
  }
  if (record.queueId !== candidate.queueId) mismatch(`queue '${record.queueId}' does not match`)
  if (queueIdentity(first) !== candidate.queueId) mismatch("snapshot queue does not match")
  if (baseIdentity(record.base) !== baseIdentity(first.base)) mismatch("queue target does not match")
  if (!sameFlow(record.flow, candidateFlow(record.prs))) mismatch("Flow result does not match")

  const baseSha = (() => {
    try {
      return requiredCandidateBaseSha(record.prs)
    } catch {
      return mismatch("has an invalid base-SHA result for")
    }
  })()
  if (baseSha !== candidate.baseSha) mismatch("base SHA does not match")
  if (
    candidate.revs.length !== record.prs.length ||
    candidate.revs.some((revision, index) => {
      const snapshot = record.prs[index]
      return (
        snapshot === undefined ||
        revision.pr !== snapshot.id ||
        revision.n !== snapshot.revision ||
        revision.head !== snapshot.headSha
      )
    })
  ) {
    mismatch("ordered PR revisions do not match")
  }
}

function projectQueues(state: DeepReadonly<QueueState>, applied: Event): QueueState {
  if (applied.name === "pr/pushed" || applied.name === "pr/recut") {
    const token =
      applied.name === "pr/pushed"
        ? QueueAuthorityTokenFactSchema.parse(applied.data)
        : ((fact) => ({ pr: fact.pr, ...fact.successor }))(QueueRemergeAuthorityFactSchema.parse(applied.data))
    const invalidated = invalidateChangeAuthority(state.queues.authority, token.pr)
    return {
      queues: {
        // A push or re-merge is the operator's answer to the refusal: the old streak
        // describes a revision that no longer exists, so it must not keep the
        // wedge finding alive against fresh content.
        ...clearAdmissionRefusals(state.queues, [token.pr]),
        authority: { ...invalidated, current: { ...invalidated.current, [token.pr]: token } },
      },
    }
  }
  if (applied.name === "pr/submitted") {
    const token = QueueAuthorityTokenFactSchema.parse(applied.data)
    const current = state.queues.authority.current[token.pr]
    if (current !== undefined && !currentAuthorityMatches(state.queues.authority, token)) return state
    return {
      queues: {
        ...state.queues,
        authority: {
          ...state.queues.authority,
          current: { ...state.queues.authority.current, [token.pr]: token },
          submits: { ...state.queues.authority.submits, [token.pr]: token },
        },
      },
    }
  }
  if (applied.name === "pr/checks-requested") {
    const token = QueueAuthorityTokenFactSchema.parse(applied.data)
    const current = state.queues.authority.current[token.pr]
    if (current !== undefined && !currentAuthorityMatches(state.queues.authority, token)) return state
    return {
      queues: {
        ...state.queues,
        authority: {
          ...state.queues.authority,
          current: { ...state.queues.authority.current, [token.pr]: token },
          checks: { ...state.queues.authority.checks, [token.pr]: token },
        },
      },
    }
  }
  if (applied.name === "pr/admission-recorded") {
    const recorded = ChangeAdmissionRecordedFactSchema.parse(applied.data)
    if (!currentAuthorityMatches(state.queues.authority, recorded)) return state
    // The delivery-status label this used to store per change is derived at
    // read time now (22991 phase 2); the queues slice keeps only its own
    // authority consequence — a passing admission retires the refusal streak.
    if (recorded.admission.status !== "passed") return state
    return { queues: clearAdmissionRefusals(state.queues, [recorded.pr]) }
  }
  // pr/needs-author no longer projects into the queues slice: the only thing
  // it ever wrote here was the stored delivery-status copy deleted by 22991
  // phase 2. The change record keeps the needs-author fact (@yrd/bay), and the
  // submitted/ready precondition this slice used to re-assert at replay is
  // enforced where the event is emitted, against the canonical record
  // (`changeDeliveryState`) — see the settlement paths. A replay-time
  // re-check against a second stored copy is exactly the drift surface being
  // deleted.
  if (applied.name === "pr/rejected") {
    const rejected = QueueRejectedTerminalFactSchema.parse(applied.data)
    if (!terminalAuthorityMatches(state.queues.authority, rejected, applied.name, typeof rejected.run === "string")) {
      return state
    }
    return {
      queues: {
        ...state.queues,
        authority: invalidateChangeAuthority(state.queues.authority, rejected.pr),
      },
    }
  }
  if (applied.name === "pr/integrated") {
    const integrated = QueueAuthorityTokenFactSchema.parse(applied.data)
    // S6 relaxation: a DERIVED member's terminal names no current token — its
    // authority was the submit fact, never a token, so there is nothing to
    // invalidate and nothing to require. Tolerant (never the old throw); the
    // stale-terminal invariant still fires when a token EXISTS and disagrees.
    if (!terminalAuthorityMatches(state.queues.authority, integrated, applied.name, false)) return state
    return {
      queues: {
        ...state.queues,
        authority: invalidateChangeAuthority(state.queues.authority, integrated.pr),
      },
    }
  }
  if (applied.name === "pr/already-landed") {
    const alreadyMerged = ChangeAlreadyMergedSchema.parse(applied.data)
    // S6 relaxation — same rule as pr/integrated above.
    if (!terminalAuthorityMatches(state.queues.authority, alreadyMerged, applied.name, false)) return state
    return {
      queues: {
        ...state.queues,
        authority: invalidateChangeAuthority(state.queues.authority, alreadyMerged.pr),
      },
    }
  }
  if (applied.name === "pr/withdrawn" || applied.name === "pr/canceled") {
    const closed = QueueAuthorityChangeFactSchema.parse(applied.data)
    if (closed.revision !== undefined && closed.headSha !== undefined) {
      const currentTerminal =
        applied.name === "pr/withdrawn" || typeof (applied.data as { run?: unknown }).run === "string"
      const terminal = { pr: closed.pr, revision: closed.revision, headSha: closed.headSha }
      if (!terminalAuthorityMatches(state.queues.authority, terminal, applied.name, currentTerminal)) return state
    }
    return {
      queues: {
        ...state.queues,
        authority: invalidateChangeAuthority(state.queues.authority, closed.pr),
      },
    }
  }
  if (applied.name === "queue/paused") {
    const parsed = ReplayPauseQueueArgsSchema.parse(applied.data)
    const paused = QueuePauseSchema.parse({ ...parsed, base: baseIdentity(parsed.base), pausedAt: applied.ts })
    return { queues: { ...state.queues, pauses: { ...state.queues.pauses, [paused.base]: paused } } }
  }
  if (applied.name === "queue/pause/expired") {
    const expired = ExpireQueuePauseArgsSchema.parse(applied.data)
    const base = baseIdentity(expired.base)
    if (state.queues.pauses[base]?.expiresAt !== expired.expiresAt) return state
    return {
      queues: {
        ...state.queues,
        pauses: Object.fromEntries(Object.entries(state.queues.pauses).filter(([candidate]) => candidate !== base)),
      },
    }
  }
  if (applied.name === "queue/resumed") {
    const base = baseIdentity(ResumeQueueArgsSchema.parse(applied.data).base)
    return {
      queues: {
        ...state.queues,
        pauses: Object.fromEntries(Object.entries(state.queues.pauses).filter(([candidate]) => candidate !== base)),
      },
    }
  }
  if (applied.name === "queue/batch/isolated") {
    const isolated = BatchIsolatedSchema.parse(applied.data)
    return {
      queues: {
        ...state.queues,
        index: indexQueueChild(state.queues.index, isolated.parent, isolated.part, isolated.run),
      },
    }
  }
  if (applied.name === "queue/candidate/created") {
    const candidate = CandidateSchema.parse({ ...CandidateCreatedSchema.parse(applied.data), createdAt: applied.ts })
    const existing = state.queues.candidates[candidate.id]
    if (existing !== undefined) {
      throw new Error(`yrd: duplicate Candidate '${candidate.id}'`)
    }
    assertSubmoduleModelAuthorizationsAvailable(state.queues, candidate)
    return {
      queues: {
        ...state.queues,
        candidates: { ...state.queues.candidates, [candidate.id]: candidate },
      },
    }
  }
  if (applied.name === "queue/run/started") {
    const started = ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run)
    if (Queues.get(state.queues, started.id) !== undefined) throw new Error(`yrd: duplicate queue run '${started.id}'`)
    const candidateId = started.candidateId ?? Queues.nextCandidateId(state.queues)
    const queueId = baseIdentity(started.queueId ?? started.base)
    // Pre-Candidate batch Runs carried each change's last check base independently,
    // so one immutable Run could contain several base SHAs. Target-model replay
    // gives that synthetic Candidate the first ordered result as its stable
    // compatibility anchor and pins the projected snapshots to the same SHA.
    // Fresh Runs always carry candidateId and retain strict common-base checks.
    const legacyBaseSha =
      started.candidateId === undefined ? requiredCandidateBaseSha(started.prs.slice(0, 1)) : undefined
    const candidatePrs = legacyBaseSha === undefined ? started.prs : pinCandidateBaseSha(started.prs, legacyBaseSha)
    const legacyCandidate =
      legacyBaseSha === undefined
        ? undefined
        : CandidateSchema.parse({
            id: candidateId,
            queueId,
            baseSha: legacyBaseSha,
            revs: candidatePrs.map((pr) => ({ pr: pr.id, n: pr.revision, head: pr.headSha })),
            mergeability: "unknown",
            createdAt: applied.ts,
          })
    if (legacyCandidate === undefined && state.queues.candidates[candidateId] === undefined) {
      throw new Error(`yrd: queue run '${started.id}' names missing Candidate '${candidateId}'`)
    }
    const replayed = ReplayQueueRecordSchema.parse({
      ...started,
      queueId,
      candidateId,
      base: baseIdentity(started.base),
      prs: candidatePrs.map((pr) => ({ ...pr, base: baseIdentity(pr.base) })),
      startedAt: applied.ts,
    })
    const record: QueueRecord = { ...replayed, queueId, candidateId }
    const queues = {
      // Admission succeeded for every member PR, so their refusal streaks end
      // here — "consecutive refusals WITHOUT queueing" is the whole claim.
      ...clearAdmissionRefusals(
        state.queues,
        record.prs.map(({ id }) => id),
      ),
      candidates:
        legacyCandidate === undefined
          ? state.queues.candidates
          : { ...state.queues.candidates, [legacyCandidate.id]: legacyCandidate },
    }
    return { queues: projectQueueStarted(queues, record) }
  }
  if (applied.name === "queue/run/settled") {
    return projectSettledQueueRun(state, applied)
  }
  if (applied.name === "queue/run/failed") {
    const failed = ReplayQueueFailedSchema.parse(applied.data)
    const record = Queues.get(state.queues, failed.run)
    if (record === undefined) throw new Error(`yrd: no queue run '${failed.run}'`)
    const releaseReason = queueAuthorityReleaseReason(failed.error)
    const failedRecord = {
      ...record,
      failure: {
        at: applied.ts,
        error: failed.error,
        ...(!("job" in failed) || failed.job === undefined ? {} : { job: failed.job }),
      },
    }
    return {
      queues: {
        ...state.queues,
        authority:
          releaseReason === undefined
            ? state.queues.authority
            : releaseRunAuthority(state.queues.authority, record, {
                reason: releaseReason,
                ref: applied.id,
              }),
        records: Queues.set(state.queues.records, failedRecord),
        index:
          releaseReason === undefined
            ? state.queues.index
            : recordReleasedAdmissionFailure(state.queues.index, failedRecord),
      },
    }
  }
  if (applied.name === "queue/run/canceled") {
    const canceled = QueueRunCanceledFactSchema.parse(applied.data)
    const record = Queues.get(state.queues, canceled.run)
    if (record === undefined) throw new Error(`yrd: no queue run '${canceled.run}'`)
    // A canceled run is terminal, but — unlike a failure — its member PRs are NOT
    // rejected. Release the run's queue authority (mirroring queue/run/failed) so
    // the still-submitted PRs are re-admissible on a future drain, and mark the
    // record canceled so advanceQueue stops reconciling it (no pr/canceled emission).
    const canceledRecord = {
      ...record,
      canceledAt: applied.ts,
      canceledBy: canceled.by,
      cancelReason: canceled.reason,
    }
    const queues = {
      ...state.queues,
      authority: releaseRunAuthority(state.queues.authority, record, {
        reason: "run-canceled",
        ref: applied.id,
      }),
      records: Queues.set(state.queues.records, canceledRecord),
      index: recordReleasedAdmissionFailure(state.queues.index, canceledRecord),
    }
    return { queues: record.parent === undefined ? markQueueTerminalRoot(queues, record.id) : queues }
  }
  if (applied.name === "queue/admission/refused") {
    const refusal = AdmissionRefusedFactSchema.parse(applied.data)
    const streak = state.queues.admissionRefusals[refusal.pr]
    const sameRevision =
      refusal.revision === undefined ||
      streak?.revision === undefined ||
      (streak.revision === refusal.revision && streak.headSha === refusal.headSha)
    const prior = sameRevision ? streak : undefined
    const sameCode = prior?.code === refusal.code
    // Branch carries across revisions (`streak`, not `prior`): one id is one
    // member is one branch, and a legacy fact without the field must not
    // strip the identity a newer fact recorded.
    const branch = refusal.branch ?? streak?.branch
    return {
      queues: {
        ...state.queues,
        admissionRefusals: {
          ...state.queues.admissionRefusals,
          [refusal.pr]: {
            pr: refusal.pr,
            ...(branch === undefined ? {} : { branch }),
            ...(refusal.revision === undefined
              ? prior?.revision === undefined
                ? {}
                : { revision: prior.revision, headSha: prior.headSha }
              : { revision: refusal.revision, headSha: refusal.headSha }),
            code: refusal.code,
            ...(refusal.kind === undefined ? {} : { kind: refusal.kind }),
            reason: refusal.reason,
            // The streak counts cycles, not codes: a wedge that flaps between
            // refusal codes is still one change that never got in. The latest code
            // is what an operator needs to act on.
            count: (prior?.count ?? 0) + 1,
            sameCodeCount: sameCode ? (prior?.sameCodeCount ?? prior?.count ?? 0) + 1 : 1,
            firstAt: prior?.firstAt ?? applied.ts,
            sameCodeFirstAt: sameCode ? (prior?.sameCodeFirstAt ?? prior?.firstAt ?? applied.ts) : applied.ts,
            lastAt: applied.ts,
            ...(prior?.settlement === undefined ? {} : { settlement: prior.settlement }),
          },
        },
      },
    }
  }
  if (applied.name === "queue/admission/settled") {
    const settlement = SettleAdmissionRefusalSchema.parse(applied.data)
    const refusal = state.queues.admissionRefusals[settlement.pr]
    if (refusal === undefined) {
      throw new Error(`yrd: the settlement names change '${settlement.pr}', which has no failed check`)
    }
    if (
      refusal.revision !== undefined &&
      (refusal.revision !== settlement.revision || refusal.headSha !== settlement.headSha)
    ) {
      throw new Error(`yrd: the settlement for change '${settlement.pr}' does not match the revision that failed`)
    }
    return {
      queues: {
        ...state.queues,
        admissionRefusals: {
          ...state.queues.admissionRefusals,
          [settlement.pr]: {
            ...refusal,
            revision: settlement.revision,
            headSha: settlement.headSha,
            settlement: {
              disposition: settlement.disposition,
              reason: settlement.reason,
              settledAt: applied.ts,
            },
          },
        },
      },
    }
  }
  return state
}

/** Drop the refusal streaks for PRs that just got in (or whose refused revision
 * was replaced). Exported semantics live in {@link QueueAdmissionRefusal}. */
function clearAdmissionRefusals(queues: DeepReadonly<QueuesState>, prs: readonly string[]): QueuesState {
  const dropped = new Set(prs.filter((pr) => queues.admissionRefusals[pr] !== undefined))
  if (dropped.size === 0) return queues as QueuesState
  return {
    ...(queues as QueuesState),
    admissionRefusals: Object.fromEntries(Object.entries(queues.admissionRefusals).filter(([pr]) => !dropped.has(pr))),
  }
}

function installSteps(definitions: readonly AnyStepDef[], declared?: readonly string[]): readonly RuntimeStep[] {
  const names = new Set<string>()
  for (const step of definitions) {
    if (names.has(step.name)) throw new Error(`yrd: queue step '${step.name}' is already installed`)
    names.add(step.name)
  }
  // An absent declaration means "every installed step", exactly as an absent
  // `--steps` selection did. A present one is validated here — the single place
  // the declared plan is resolved — so an unknown or repeated name fails at
  // construction rather than silently narrowing the plan at run time.
  const selected = declared === undefined ? undefined : new Set(declared)
  if (selected !== undefined && declared !== undefined) {
    if (selected.size !== declared.length) throw new Error("yrd: queue.run: duplicate step name")
    for (const name of selected) {
      if (!names.has(name)) throw new Error(`yrd: queue step '${name}' is not installed`)
    }
  }
  return Object.freeze(
    definitions.map((step) => Object.freeze({ ...step, declaredDefault: selected?.has(step.name) ?? true })),
  )
}

/** The plan the configuration DECLARES, in installed order — the authority for
 * every default-authority run. `selectSteps` has always ignored the requested
 * ordering and returned installed order, so filtering the marked set is the
 * same list it produced, sourced from the declaration instead of the state. */
function declaredDefaultSteps(steps: readonly RuntimeStep[]): RuntimeStep[] {
  return steps.filter((step) => step.declaredDefault)
}

/** The plan a run request executes.
 *
 * Precedence: an explicit `--steps` selection, then the plan git declares at
 * this run's base sha, then the installed set (embedded hosts with no
 * repository to read). The durable state is never consulted — it no longer
 * carries a plan at all (23192).
 */
function requestedOrDeclaredSteps(
  steps: readonly RuntimeStep[],
  requested?: readonly string[],
  declared?: DeclaredStepPlan,
): RuntimeStep[] {
  if (requested !== undefined) return selectSteps(steps, requested)
  if (declared !== undefined) return declaredPlanSteps(steps, declared)
  return declaredDefaultSteps(steps)
}

/** Map a git-declared plan onto this process's installed steps, IN THE ORDER
 * THE CONFIG DECLARES.
 *
 * A step defs's Job is registered when the process is built, so a name the base
 * ref declares but this process never installed has nothing to execute. Running
 * the remainder is precisely the defect 23192 records — a declared check that
 * silently never ran — so this refuses and names the gap and its remedy. That
 * refusal is also what keeps the pure admission projections honest: they read
 * the installed set, and no run proceeds while the two disagree.
 */
function declaredPlanSteps(steps: readonly RuntimeStep[], declared: DeclaredStepPlan): RuntimeStep[] {
  const installed = new Map(steps.map((step) => [step.name, step] as const))
  const missing = declared.steps.filter((name) => !installed.has(name))
  if (missing.length > 0) {
    raiseFailure(
      "refusal",
      "declared-step-not-installed",
      `yrd: the queue config at base ${declared.baseSha.slice(0, 8)} (blob ${declared.configBlobSha.slice(0, 8)}) ` +
        `declares ${missing.map((name) => `'${name}'`).join(", ")}, which this runner did not install. ` +
        `It installed ${steps.map((step) => step.name).join("→")}. Running the rest would execute fewer checks ` +
        "than the base branch declares. Restart this queue runner so it builds the declared steps.",
    )
  }
  return declared.steps.flatMap((name) => {
    const step = installed.get(name)
    return step === undefined ? [] : [step]
  })
}

function descriptor(step: RuntimeStep | QueueStep): InstalledStep {
  return {
    name: step.name,
    title: step.title,
    revision: step.revision,
    kind: step.kind,
    ...(step.classification === undefined ? {} : { classification: step.classification }),
    ...(step.implementationSource === undefined ? {} : { implementationSource: step.implementationSource }),
  }
}

function selectSteps(steps: readonly RuntimeStep[], names?: readonly string[]): RuntimeStep[] {
  if (names === undefined) return [...steps]
  const selected = new Set(names)
  if (selected.size !== names.length) throw new Error("yrd: queue.run: duplicate step name")
  for (const name of selected) {
    if (!steps.some((step) => step.name === name)) throw new Error(`yrd: queue step '${name}' is not installed`)
  }
  return steps.filter((step) => selected.has(step.name))
}

function stepSelection(
  installed: readonly RuntimeStep[],
  selected: readonly RuntimeStep[],
  authority: StepSelection["authority"],
  declaredPlan: DeclaredStepPlan | undefined,
): StepSelection {
  const names = selected.map((step) => step.name)
  const selectedNames = new Set(names)
  const configuredNames = new Set(
    declaredPlan === undefined ? declaredDefaultSteps(installed).map((step) => step.name) : declaredPlan.steps,
  )
  const plan = installed.filter((step) => selectedNames.has(step.name) || configuredNames.has(step.name))
  const omittedSteps =
    authority === "explicit"
      ? plan.flatMap((step, index) =>
          selectedNames.has(step.name)
            ? []
            : [
                {
                  ...descriptor(step),
                  index,
                  status: "skipped" as const,
                  reason: "not-selected" as const,
                },
              ],
        )
      : []
  return {
    authority,
    // Which list judged this Run is only half the record; WHERE it came from is
    // the other half. `declared-at-base` carries the two shas an audit needs to
    // compare what executed against what the config declares now, with no
    // written baseline file in between (23192, 23193).
    source: authority === "explicit" ? "explicit" : "declared-at-base",
    ...(authority === "explicit" || declaredPlan === undefined
      ? {}
      : { baseSha: declaredPlan.baseSha, configBlobSha: declaredPlan.configBlobSha }),
    steps: names,
    ...(omittedSteps.length === 0 ? {} : { omittedSteps }),
  }
}

function validateSequence(steps: readonly RuntimeStep[], alreadyIntegrated: boolean): void {
  let integrated = alreadyIntegrated
  for (const step of steps) {
    if (step.kind !== "merge") continue
    if (integrated) throw new Error("yrd: merge step cannot run after the change is already integrated")
    integrated = true
  }
}

function startRun(
  queues: DeepReadonly<QueuesState>,
  id: RunId,
  prs: readonly ChangeSnapshot[],
  baseSha: string,
  prepared: DeepReadonly<Omit<Candidate, "createdAt">> | undefined,
  selected: readonly RuntimeStep[],
  selection: StepSelection | undefined,
  shape: ChangeShape,
  integration?: IntegrationProof,
  lineage: Readonly<{ parent?: RunId; isolationPart?: 0 | 1 }> = {},
  reuse?: Readonly<{ run?: RunId; results: Readonly<Record<string, JsonValue>> }>,
): Readonly<{ run: QueueStart; events: readonly EventDraft[] }> {
  const pr = prs[0]
  if (pr === undefined) throw new Error("yrd: a queue run requires at least one change")
  requiredCandidateBaseSha(prs)
  const flow = candidateFlow(prs)
  const queueId = queueIdentity(pr)
  const selectedCandidate = candidateFor(queues, prs, baseSha)
  const candidate =
    selectedCandidate ??
    CandidateCreatedSchema.parse({
      ...(prepared ?? {
        id: Queues.nextCandidateId(queues),
        queueId,
        baseSha,
        revs: prs.map((member) => ({ pr: member.id, n: member.revision, head: member.headSha })),
        mergeability: "unknown",
      }),
    })
  if (candidate.queueId !== queueId || candidate.baseSha !== baseSha) {
    throw new Error(`yrd: prepared Candidate '${candidate.id}' does not match queue '${queueId}' at ${baseSha}`)
  }
  if (
    candidate.revs.length !== prs.length ||
    candidate.revs.some((revision, index) => {
      const snapshot = prs[index]
      return (
        snapshot === undefined ||
        revision.pr !== snapshot.id ||
        revision.n !== snapshot.revision ||
        revision.head !== snapshot.headSha
      )
    })
  ) {
    throw new Error(`yrd: prepared Candidate '${candidate.id}' does not match its ordered PR revisions`)
  }
  const createdEvents = selectedCandidate === undefined ? [event("queue/candidate/created", candidate)] : []
  const run: QueueStart = {
    id,
    settlement: "explicit",
    queueId: candidate.queueId,
    candidateId: candidate.id,
    prs,
    base: baseIdentity(pr.base),
    batchSize: queues.batchSize,
    ...(flow === undefined ? {} : { flow }),
    steps: selected.map(descriptor),
    ...(selection === undefined ? {} : { stepSelection: selection }),
    ...(integration === undefined ? {} : { initialIntegration: integration }),
    ...(reuse === undefined ? {} : { initialResults: reuse.results }),
    ...(reuse?.run === undefined ? {} : { reusedFrom: reuse.run }),
    ...lineage,
  }
  if (candidate.mergeability === "conflicting") {
    return {
      run,
      events: [
        ...createdEvents,
        event("queue/run/started", { run }),
        event("queue/run/failed", {
          run: run.id,
          prs: run.prs.map((pr) => ({ pr: pr.id, revision: pr.revision, headSha: pr.headSha })),
          error: {
            code: "candidate-conflicting",
            message: `Candidate '${candidate.id}' conflicts before Job execution`,
          },
        }),
      ],
    }
  }
  return {
    run,
    events: [
      ...createdEvents,
      event("queue/run/started", { run }),
      ...(selected[0] === undefined ? [] : [requestStep(selected[0], run, candidate, 0, shape)]),
    ],
  }
}

function pinCandidateBaseSha(prs: readonly DeepReadonly<ChangeSnapshot>[], baseSha: string): readonly ChangeSnapshot[] {
  return prs.map((pr) => ChangeSnapshotSchema.parse({ ...pr, baseSha }))
}

function requiredCandidateBaseSha(prs: readonly DeepReadonly<ChangeSnapshot>[]): string {
  const baseSha = prs[0]?.baseSha
  if (baseSha === undefined) {
    throw new Error("yrd: a Candidate requires the exact merge-queue base SHA")
  }
  if (prs.some((pr) => pr.baseSha !== baseSha)) {
    throw new Error("yrd: one Candidate cannot span merge-queue base SHAs")
  }
  return baseSha
}

function candidateResultKey(prs: readonly DeepReadonly<ChangeSnapshot>[], baseSha: string): string {
  return JSON.stringify([
    prs[0] === undefined ? "" : queueIdentity(prs[0]),
    baseSha,
    ...prs.map((pr) => [pr.id, pr.revision, pr.headSha, pr.composition]),
  ])
}

function sameFlow(left: DeepReadonly<ChangeSnapshot["flow"]>, right: DeepReadonly<ChangeSnapshot["flow"]>): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.name === right.name && left.rev === right.rev && left.fingerprint === right.fingerprint
}

function candidateFlow(prs: readonly DeepReadonly<ChangeSnapshot>[]): DeepReadonly<ChangeSnapshot["flow"]> {
  const flow = prs[0]?.flow
  if (prs.some((pr) => !sameFlow(pr.flow, flow))) {
    throw new Error("yrd: one Candidate cannot span Flow revisions")
  }
  return flow
}

function queueIdentity(pr: Pick<DeepReadonly<ChangeSnapshot>, "base" | "flow">): string {
  const base = baseIdentity(pr.base)
  return pr.flow === undefined ? base : `${pr.flow.name}/${base}`
}

function candidateFor(
  queues: DeepReadonly<QueuesState>,
  prs: readonly DeepReadonly<ChangeSnapshot>[],
  baseSha: string,
): DeepReadonly<Candidate> | undefined {
  const first = prs[0]
  if (first === undefined) return undefined
  const key = candidateResultKey(prs, baseSha)
  const records = Queues.values(queues)
  const record = records.find((run) => {
    const candidate = queues.candidates[run.candidateId]
    return (
      candidate !== undefined &&
      candidate.mergeability !== "unknown" &&
      candidateResultKey(run.prs, candidate.baseSha) === key
    )
  })
  if (record !== undefined) return queues.candidates[record.candidateId]
  return Object.values(queues.candidates).find(
    (candidate) =>
      candidate.mergeability !== "unknown" &&
      candidate.queueId === queueIdentity(first) &&
      candidate.baseSha === baseSha &&
      candidate.revs.length === prs.length &&
      candidate.revs.every((revision, index) => {
        const snapshot = prs[index]
        return (
          snapshot !== undefined &&
          revision.pr === snapshot.id &&
          revision.n === snapshot.revision &&
          revision.head === snapshot.headSha
        )
      }),
  )
}

/**
 * A pre-settlement (v1) Queue root that replay left non-terminal. Queue v2 adds
 * explicit live-root claims; historical v1 runs carry no settlement marker, so a
 * genuinely unfinished v1 root cannot be migrated losslessly by projection alone.
 * The migration ({@link Queue.quiesceLegacyRoots}) settles the abandoned ones and
 * refuses only while a previous writer still holds a live lease.
 */
type LegacyRootTarget = Readonly<{
  run: RunId
  /** Non-terminal jobs the migration must cancel so the run and its jobs are all terminal. */
  jobs: readonly DeepReadonly<Job>[]
  /** True when a still-unexpired writer lease is held at `now` (ms since epoch). */
  leased(now: number): boolean
}>

function legacyRootTargets(state: DeepReadonly<RuntimeState>): readonly LegacyRootTarget[] {
  return projectionLookupValues(state.queues.records)
    .flatMap((record) => {
      const target = legacyRootTargetForRecord(state, record)
      return target === undefined ? [] : [target]
    })
    .toSorted((left, right) => compareNatural(left.run, right.run))
}

function legacyRootTarget(state: DeepReadonly<RuntimeState>, run: RunId): LegacyRootTarget | undefined {
  const record = Queues.get(state.queues, run)
  return record === undefined ? undefined : legacyRootTargetForRecord(state, record)
}

function legacyRootTargetForRecord(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<QueueRecord>,
): LegacyRootTarget | undefined {
  if (record.parent !== undefined || record.settlement !== undefined) return undefined
  const run = materializeRun(record, state.jobs)
  // A v1 failed Run settled by writing PR revision TERMINALS used to be excluded
  // here: those terminals were replay evidence that the old writer had already
  // quiesced the root, and treating them as live would reclassify completed
  // history. The evidence lived on record revisions and is unreadable since S7,
  // so such a root now presents as needing settlement — quiescing it again is
  // idempotent, where the old misclassification was not.
  if (!needsSettlement(state, run)) return undefined
  const jobs = run.steps
    .map((step) => step.job)
    .filter((job): job is DeepReadonly<Job> => job !== undefined && !Job.terminal(job))
  return {
    run: run.id,
    jobs,
    leased: (now) => jobs.some((job) => job.status === "in_progress" && Date.parse(job.leaseExpiresAt) > now),
  }
}

function requestStep(
  step: RuntimeStep,
  run: Pick<QueueStart, "id" | "prs">,
  candidate: DeepReadonly<Candidate> | DeepReadonly<Omit<Candidate, "createdAt">>,
  index: number,
  shape: ChangeShape,
) {
  const { createdAt: _createdAt, ...candidateFacts } = candidate as DeepReadonly<Candidate>
  return step.job.request(
    {
      run: run.id,
      step: step.name,
      index,
      prs: run.prs,
      candidate: CandidateCreatedSchema.parse(candidateFacts),
      shape,
    },
    { key: jobKey(run.id, index) },
  )
}

/** Exported as the S6 re-sourced-emitter test seam: the merge bookkeeping and
 * needs-author emissions for DERIVED members are asserted on this pure
 * function's event drafts (e.g. the moved-fact gate, which no journaled
 * lifecycle can hold still long enough to observe). */
export function advanceQueue(
  state: DeepReadonly<RuntimeState>,
  record: DeepReadonly<QueueRecord>,
  steps: ReadonlyMap<string, RuntimeStep>,
): Readonly<{ events: readonly EventDraft[] }> {
  if (activeQueueFailure(record, state.jobs) !== undefined) return { events: [] }
  // A run-canceled record is terminal: never emit pr/canceled or pr/rejected for
  // its members. Their status is untouched (still submitted), so a future drain
  // re-queues them — cancel is a re-queue, not a rejection.
  if (record.canceledAt !== undefined) return { events: [] }
  const stale = pinnedChangeError(state, record.prs, record.id)
  if (stale !== undefined) {
    return { events: [queueFailedEvent(state, record, stale)] }
  }

  const jobs = queueJobs(record, state.jobs)
  const index = jobs.length - 1
  const job = jobs[index]
  if (job === undefined) return { events: [] }
  const planned = record.steps[index]
  if (planned === undefined) throw new Error(`yrd: queue run '${record.id}' lost step ${index}`)
  if (job.status === "queued") {
    const drift = plannedStepDrift(steps, planned)
    return {
      events:
        drift === undefined ? [] : [queueFailedEvent(state, record, { code: "stale-steps", message: `yrd: ${drift}` })],
    }
  }
  if (job.status === "in_progress" || job.status === "waiting") return { events: [] }
  if (!jobSucceeded(job)) {
    const before = shapeThrough(record, state.jobs, index)
    if (job.conclusion === "cancelled") {
      const canceledPr = record.prs.length === 1 ? record.prs[0] : undefined
      return {
        events: isIntegrated(before)
          ? []
          : [
              event("queue/run/canceled", {
                run: record.id,
                by: job.canceledBy,
                reason: job.cancelReason,
                ...(canceledPr === undefined
                  ? {}
                  : {
                      pr: canceledPr.id,
                      revision: canceledPr.revision,
                      headSha: canceledPr.headSha,
                    }),
              }),
            ],
      }
    }

    const failure = jobFailure(job)
    if (queueAuthorityReleaseReason(failure) !== undefined) {
      return { events: [queueFailedEvent(state, record, failure)] }
    }
    const failed = queueFailedEvent(state, record, failure, job)
    const pr = record.prs.length === 1 ? record.prs[0] : undefined
    const evidence =
      (job.conclusion === "failure" ? firstArtifact(job.error.evidence, "stderr") : undefined) ??
      firstArtifact(checkEvidence(job), "stderr") ??
      ("artifacts" in job ? firstArtifact({ artifacts: job.artifacts }, "stderr") : undefined)
    const authorResult = needsAuthorJobResult(job)
    if (authorResult === undefined || isIntegrated(before) || pr === undefined) {
      return { events: [failed] }
    }
    // RE-SOURCE (S6 census #13): the author-facing refusal FACT emits from the
    // run's own snapshot — going dark here would starve the audit/status
    // surfaces and settlement of the needs-author trail. The submitted/ready
    // gate's pure-git analogue: the live submit fact still stands at exactly the
    // pinned sha (a mid-run re-push or branch delete means the author already
    // superseded this member, and nagging them about it would be noise).
    if (state.bays.submits[pr.branch]?.sha !== pr.headSha) return { events: [failed] }
    const refusal = {
      pr: pr.id,
      revision: pr.revision,
      headSha: pr.headSha,
      run: record.id,
      ...(pr.issue === undefined ? {} : { issueRef: pr.issue }),
      ...(pr.props === undefined ? {} : { props: pr.props }),
      step: planned.name,
      ...(evidence === undefined ? {} : { evidence }),
      detail: failure.message,
    }
    return { events: [failed, event("pr/needs-author", { ...refusal, receipt: authorResult })] }
  }

  const shape = shapeThrough(record, state.jobs, index + 1)
  const events: EventDraft[] = []
  if (planned.kind === "merge") {
    if (!isIntegrated(shape)) throw new Error(`yrd: merge step '${planned.name}' produced no integration proof`)
    // S7 settlement single-writer: NO terminal facts emit here. Every
    // non-intent member's `pr/integrated`/`pr/already-landed` emits from the
    // `settled` command's batch, sourced from the run's own snapshots; the
    // settled event's application retiring the root is the state-visible
    // once-marker. The advance-path record loop, its same-payload sweep over
    // the store, and the store dedupe are all deleted with the record era
    // (@i/10 22991 inventory §a).
  }

  const next = record.steps[index + 1]
  if (next !== undefined) {
    const drift = plannedStepDrift(steps, next)
    if (drift !== undefined && !isIntegrated(shape)) {
      return {
        events: [queueFailedEvent(state, record, { code: "stale-steps", message: `yrd: ${drift}` })],
      }
    }
    const candidate = state.queues.candidates[record.candidateId]
    if (candidate === undefined) {
      throw new Error(`yrd: queue run '${record.id}' names missing Candidate '${record.candidateId}'`)
    }
    events.push(requestStep(requirePlannedStep(steps, next), record, candidate, index + 1, shape))
  }
  return { events }
}

function queueLifecycleRun(applied: Event): RunId | undefined {
  if (applied.name === "queue/run/started") {
    return ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run).id
  }
  if (applied.name === "queue/run/failed") return ReplayQueueFailedSchema.parse(applied.data).run
  if (applied.name === "queue/run/canceled") return QueueRunCanceledFactSchema.parse(applied.data).run
  if (applied.name === "queue/run/settled") return SettledEventSchema.parse(applied.data).run
  return undefined
}

function materializeArchivedRun(
  history: JournalHistory<unknown>,
  jobs: HasJobs["jobs"],
  live: DeepReadonly<QueuesState>,
  id: RunId,
): Run | undefined {
  const entries = new Map<number, unknown>()
  const runs = new Set<RunId>()
  const visiting = new Set<RunId>()
  const visit = (runId: RunId): boolean => {
    if (runs.has(runId)) return true
    if (visiting.has(runId)) throw new Error(`yrd: archived queue ancestry for '${id}' is cyclic`)
    visiting.add(runId)
    const slice = history.entity("queue", runId)
    if (slice.length === 0) {
      visiting.delete(runId)
      return false
    }
    let parent: RunId | undefined
    for (const entry of slice) {
      entries.set(entry.cursor, entry.value)
      const frame = parseJournalFrame(entry.value)
      for (const applied of frame.events) {
        if (applied.name !== "queue/run/started") continue
        const started = ReplayQueueStartSchema.parse((applied.data as { run?: unknown }).run)
        if (started.id === runId) parent = started.parent
      }
    }
    if (parent !== undefined && !visit(parent)) {
      throw new Error(`yrd: archived queue run '${runId}' references missing parent '${parent}'`)
    }
    visiting.delete(runId)
    runs.add(runId)
    return true
  }
  if (!visit(id)) return undefined

  let projection: QueueState = {
    queues: Queues.empty({ batchSize: live.batchSize, requires: live.requires }),
  }
  for (const [, value] of [...entries].toSorted(([left], [right]) => left - right)) {
    const frame = parseJournalFrame(value)
    for (const applied of frame.events) {
      const runId = queueLifecycleRun(applied)
      if (runId !== undefined && runs.has(runId)) projection = projectQueues(projection, applied)
    }
  }
  const record = Queues.get(projection.queues, id)
  if (record === undefined) {
    throw new Error(`yrd: journal queue index names '${id}' without a queue/run/started event`)
  }

  const byId: Record<string, Job> = {}
  const byKey: Record<string, string> = {}
  for (const [index] of record.steps.entries()) {
    const key = jobKey(record.id, index)
    const job = jobs.getByKey(key)
    if (job === undefined) continue
    if (job.key !== key) throw new Error(`yrd: archived queue job '${job.id}' does not match key '${key}'`)
    byId[job.id] = job
    byKey[key] = job.id
  }
  return materializeRun(record, {
    byId,
    byKey,
    retention: {
      next: 1,
      standaloneTerminalOrder: {},
      queueRoots: {},
      queueTerminalOrder: {},
      legacyQueueRoots: {},
      detachedQueueJobs: {},
    },
  })
}

function materializeRun(record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): Run {
  const jobList = queueJobs(record, jobs)
  const steps = record.steps.map(
    (step, index): QueueStep => ({
      ...step,
      ...(jobList[index] === undefined ? {} : { job: jobList[index] }),
    }),
  )
  const cursor = steps.findIndex((step) => step.job === undefined || !Job.terminal(step.job))
  const failed = steps.find((step) => step.job !== undefined && jobFailed(step.job))?.job
  const waiting = steps.some((step) => step.job?.status === "waiting")
  const passed =
    record.passedAt !== undefined || steps.every((step) => step.job !== undefined && jobSucceeded(step.job))
  const started = steps.some((step) => step.job !== undefined && step.job.status !== "queued")
  const projectedFailure = activeQueueFailure(record, jobs)
  const status =
    record.canceledAt !== undefined
      ? "completed"
      : projectedFailure !== undefined
        ? "completed"
        : failed !== undefined
          ? "completed"
          : waiting
            ? "waiting"
            : passed
              ? "completed"
              : started
                ? "in_progress"
                : "queued"
  const conclusion: RunConclusion | undefined =
    record.canceledAt !== undefined
      ? "cancelled"
      : projectedFailure !== undefined
        ? "failure"
        : failed === undefined
          ? passed
            ? "success"
            : undefined
          : failed.status !== "completed"
            ? "failure"
            : failed.conclusion === "cancelled"
              ? "cancelled"
              : failed.conclusion === "timed_out"
                ? "timed_out"
                : failed.conclusion === "skipped"
                  ? "skipped"
                  : "failure"
  const last = steps.at(-1)?.job
  const finishedAt =
    record.canceledAt ??
    projectedFailure?.at ??
    (failed?.status === "completed"
      ? failed.finishedAt
      : status === "completed"
        ? last?.status === "completed"
          ? last.finishedAt
          : (record.passedAt ?? record.startedAt)
        : undefined)
  const shape = shapeThrough(record, jobs)
  const {
    initialIntegration: _initialIntegration,
    initialResults: _initialResults,
    failure: _failure,
    steps: _steps,
    ...facts
  } = record
  return {
    ...facts,
    cursor: cursor < 0 ? steps.length : cursor,
    ...(isIntegrated(shape) ? { integration: shape.integration } : {}),
    status,
    ...(conclusion === undefined ? {} : { conclusion }),
    jobs: jobList.map((job) => job.id),
    steps,
    shape,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(projectedFailure === undefined
      ? failed === undefined
        ? {}
        : { error: jobFailure(failed) }
      : { error: projectedFailure.error }),
  }
}

function activeQueueFailure(
  record: DeepReadonly<Pick<QueueRecord, "failure">>,
  jobs: DeepReadonly<JobsState>,
): DeepReadonly<QueueFailure> | undefined {
  const failure = record.failure
  if (failure?.job === undefined) return failure
  const current = jobs.byId[failure.job.id]
  if (current === undefined) return failure
  return current.attempt > failure.job.attempt || !jobFailed(current) ? undefined : failure
}

/**
 * Where a step Job says it sits: the three `StepExecution` fields `queueJobs`
 * cross-checks against the run's own step plan.
 *
 * The Job layer owns validating `job.input`. `withStep` and `withMerge` declare
 * `input: StepExecutionSchema` on the Job definition, and `yrd-job` parses the
 * input against that schema when the request is recorded and again when it is
 * replayed — so by the time a projection reader sees `job.input`, the schema has
 * already had its say. Re-parsing it here validated nothing new and cost the
 * most: the strict parse walks `prs` and the arbitrarily deep `shape` blob for
 * every job, and `queueJobs` runs once per CALLER per run rather than once per
 * run. Measured on the live hh projection (1,192 retained runs), one
 * `yrd queue list` paid 16,478 of these parses.
 *
 * Reading only the placement fields keeps the cross-check below exact while
 * making its cost independent of how large a shape the step carries. A
 * malformed input still fails loud here rather than reaching the comparison as
 * `undefined` and quietly matching nothing.
 */
function stepExecutionPlacement(input: unknown, job: string): Pick<StepExecution, "run" | "index" | "step"> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>).run !== "string" ||
    typeof (input as Record<string, unknown>).step !== "string" ||
    typeof (input as Record<string, unknown>).index !== "number"
  ) {
    throw new Error(`yrd: job '${job}' input is not a step execution`)
  }
  return input as Pick<StepExecution, "run" | "index" | "step">
}

function queueJobs(record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): Job[] {
  const result: Job[] = []
  let missing = false
  for (const [index, step] of record.steps.entries()) {
    const id = jobs.byKey[jobKey(record.id, index)]
    if (id === undefined) {
      missing = true
      continue
    }
    if (missing) throw new Error(`yrd: queue run '${record.id}' requested steps out of order`)
    const job = jobs.byId[id]
    if (job === undefined) throw new Error(`yrd: queue run '${record.id}' lost job '${id}'`)
    const input = stepExecutionPlacement(job.input, job.id)
    if (
      input.run !== record.id ||
      input.index !== index ||
      input.step !== step.name ||
      job.definition !== `queue.step.${step.name}` ||
      job.revision !== step.revision
    ) {
      throw new Error(`yrd: queue run '${record.id}' job '${job.id}' does not match step '${step.name}'`)
    }
    result.push(job)
  }
  return result
}

function jobKey(run: RunId, index: number): string {
  return `queue:${run}:${index}`
}

function admissionExecutionId(pr: DeepReadonly<ChangeSnapshot>, baseSha: string): string {
  return `${admissionRevisionKeyPrefix(pr.id, pr.revision)}${baseSha}`
}

/** Every admission Job key for one member, whatever revision or base it ran
 * against. The audit's attempt count reads this rather than the literal, so a
 * change to the key shape cannot silently zero the count. */
function admissionMemberKeyPrefix(pr: string): string {
  return `admission:${pr}:`
}

function admissionRevisionKeyPrefix(pr: string, revision: number): string {
  return `${admissionMemberKeyPrefix(pr)}${revision}:`
}

function admissionJobKey(
  pr: DeepReadonly<ChangeSnapshot>,
  baseSha: string,
  index: number,
  stepRevision?: string,
): string {
  const prefix = `${admissionExecutionId(pr, baseSha)}:${index}`
  return stepRevision === undefined ? prefix : `${prefix}:${stepRevision}`
}

/** The slice of an admission Job's `StepExecution` input that names the member
 * tree it checks. Parsed loosely, and only by the stale-admission sweep: a
 * DERIVED member's Job carries its own pinned identity here, and an
 * unparseable legacy input downgrades to the retained-snapshot / refusal-row
 * fallbacks rather than throwing. */
const AdmissionJobIdentitySchema = z
  .object({ prs: z.array(z.object({ branch: z.string().min(1), headSha: z.string().min(1) }).loose()).min(1) })
  .loose()

function shapeThrough(
  record: DeepReadonly<QueueRecord>,
  jobs: DeepReadonly<JobsState>,
  limit = record.steps.length,
): ChangeShape {
  const hasMerge = record.steps.some((step) => step.kind === "merge")
  let shape: ChangeShape | IntegratedShape = {
    results: { ...record.initialResults },
    ...(record.initialIntegration === undefined || hasMerge ? {} : { integration: record.initialIntegration }),
  }
  const jobList = queueJobs(record, jobs)
  for (let index = 0; index < Math.min(limit, record.steps.length); index += 1) {
    const planned = record.steps[index]
    const job = jobList[index]
    if (planned === undefined || job === undefined || !jobSucceeded(job)) break
    shape =
      planned.kind === "merge"
        ? { ...shape, integration: IntegrationProofSchema.parse(job.output) }
        : { ...shape, results: { ...shape.results, [planned.name]: job.output } }
  }
  return shape
}

function orderedQueues(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>): Run[] {
  return Queues.values(queues)
    .map((record) => materializeRun(record, jobs))
    .toSorted((left, right) => compareNatural(left.id, right.id))
}

function runningQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  base: string,
  except?: RunId,
): Run | undefined {
  const identity = baseIdentity(base)
  return activeQueueRuns(queues, jobs).find(
    (run) =>
      run.id !== except &&
      baseIdentity(run.base) === identity &&
      (run.status === "queued" || run.status === "in_progress"),
  )
}

function childQueue(
  queues: DeepReadonly<QueuesState>,
  jobs: DeepReadonly<JobsState>,
  parent: RunId,
  part: 0 | 1,
): Run | undefined {
  const id = childRunId(queues.index, parent, part)
  const record = id === undefined ? undefined : Queues.get(queues, id)
  return record === undefined ? undefined : materializeRun(record, jobs)
}

/** A run record no reader can materialize, and the exact refusal that says why.
 *
 * Both fields are load-bearing: `run` is WHERE and `reason` is WHY, because a
 * quarantined row that reports only its own existence tells an operator nothing
 * they can act on. */
export type UnreadableQueueRun = Readonly<{ run: RunId; reason: string }>

/** A queue population read one record at a time, plus the quarantine. */
type TolerantQueueReader = Readonly<{
  /** The materialized run, or `undefined` once this record is quarantined. */
  read(record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): Run | undefined
  /** Every readable record in the whole population; quarantines the rest. */
  population(state: DeepReadonly<RuntimeState>): readonly Run[]
  /** Every readable record in one root's tree; quarantines the rest. */
  tree(state: DeepReadonly<RuntimeState>, root: RunId): readonly Run[]
  /** Whether this exact record has already been quarantined. */
  isQuarantined(run: RunId): boolean
  /** Everything quarantined so far, one entry per record, in encounter order. */
  quarantined(): readonly UnreadableQueueRun[]
}>

/**
 * The reader recovery owns, and the only one that survives its own worst row.
 *
 * {@link materializeRun} is total over a VALID record and throws over an invalid
 * one, and every enumeration in this file maps it across a whole population. One
 * unreadable record is therefore a veto over every other — the exact structure
 * that took the merge queue down for 2h22m on 2026-08-17, where a comparator
 * that threw inside `toSorted` removed `pr list`, `queue audit`, `bay status`,
 * the habitant's own progress probe and `queue recover` — the tool that repairs
 * precisely that state — from a fleet with no other way back.
 *
 * That comparator is deleted, but its SHAPE is not: recovery still shared its
 * eager reader with every ordinary path, so any state the reader rejected was
 * unrecoverable by construction. A repair tool cannot require the state it
 * repairs to be already well-formed.
 *
 * So recovery reads one record at a time and quarantines what it cannot
 * materialize. This is not a silent fallback and must never become one: the
 * reader keeps every refusal verbatim and the CALLER is obliged to report each
 * one (what, where, why) — `recover` as a structured result, `auditQueues` as
 * an `invalid-run` finding. What this removes is the veto, never the disclosure.
 *
 * A record is quarantined once however many enumerations meet it, so one bad row
 * reads to an operator as one incident rather than as five.
 */
function createTolerantQueueReader(): TolerantQueueReader {
  const quarantined = new Map<RunId, UnreadableQueueRun>()
  const read = (record: DeepReadonly<QueueRecord>, jobs: DeepReadonly<JobsState>): Run | undefined => {
    try {
      return materializeRun(record, jobs)
    } catch (error) {
      // silent-fallback-allow: the quarantine below preserves the exact refusal, and every
      // caller reports it — this replaces a whole-population veto with a named row, not with silence.
      const reason = error instanceof Error ? error.message : String(error)
      if (!quarantined.has(record.id)) quarantined.set(record.id, { run: record.id, reason })
      return undefined
    }
  }
  return {
    read,
    population: (state) =>
      Queues.values(state.queues).flatMap((record) => {
        const run = read(record, state.jobs)
        return run === undefined ? [] : [run]
      }),
    tree: (state, root) => {
      const runs: Run[] = []
      const visit = (id: RunId): void => {
        const record = Queues.get(state.queues, id)
        if (record === undefined) return
        const run = read(record, state.jobs)
        if (run !== undefined) runs.push(run)
        // Children are visited even under an unreadable parent: a child's
        // readability is its own property, and abandoning the subtree would
        // reintroduce the same veto one level down.
        for (const part of [0, 1] as const) {
          const child = childRunId(state.queues.index, id, part)
          if (child !== undefined) visit(child)
        }
      }
      visit(root)
      return runs
    },
    isQuarantined: (run) => quarantined.has(run),
    quarantined: () => [...quarantined.values()],
  }
}

function queueTree(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, root: RunId): Run[] {
  const result: Run[] = []
  const visit = (id: RunId): void => {
    const record = Queues.get(queues, id)
    if (record === undefined) return
    result.push(materializeRun(record, jobs))
    for (const part of [0, 1] as const) {
      const child = childRunId(queues.index, id, part)
      if (child !== undefined) visit(child)
    }
  }
  visit(root)
  return result
}

function activeQueueRuns(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>): Run[] {
  return activeQueueRootIds(queues).flatMap((root) => queueTree(queues, jobs, root))
}

function queueSummary(queues: DeepReadonly<QueuesState>, jobs: DeepReadonly<JobsState>, base: string): QueueSummary {
  const identity = baseIdentity(base)
  const runs = orderedQueues(queues, jobs).filter((run) => baseIdentity(run.base) === identity)
  return {
    base: identity,
    running: runs.filter((run) => run.status === "queued" || run.status === "in_progress"),
    waiting: runs.filter((run) => run.status === "waiting"),
    finished: runs.filter(Queues.terminal),
    ...(queues.pauses[identity] === undefined ? {} : { pause: queues.pauses[identity] }),
  }
}

const QUEUE_JOB_KEY_PATTERN = /^queue:(.+):\d+$/u

type OrphanedRequestedJob = Readonly<{
  job: DeepReadonly<JobsState>["byId"][string]
  run: RunId
  reason: "run-absent" | "run-terminal"
}>

/**
 * Requested queue Jobs whose parent run is terminal or absent — a strand a state
 * upgrade, or a settled/canceled run that never terminalized its pending Job,
 * left behind. A NON-terminal run's requested current-step Job is normal
 * in-flight work and is never an orphan. This walks {@link JobsState} directly:
 * {@link auditQueues}'s record walk skips terminal runs, so this class is exactly
 * the audit blind spot that let "queue audit clean" print over poison.
 */
function orphanedRequestedQueueJobs(
  state: DeepReadonly<RuntimeState>,
  reader: TolerantQueueReader,
): readonly OrphanedRequestedJob[] {
  const orphans: OrphanedRequestedJob[] = []
  for (const job of Object.values(state.jobs.byId)) {
    if (job.status !== "queued" || job.key === undefined) continue
    const run = QUEUE_JOB_KEY_PATTERN.exec(job.key)?.[1]
    if (run === undefined) continue
    const record = Queues.get(state.queues, run)
    if (record === undefined) {
      orphans.push({ job, run, reason: "run-absent" })
      continue
    }
    const parent = reader.read(record, state.jobs)
    // An unreadable parent is quarantined, never judged. "Absent" and
    // "terminal" are both claims about a record that was READ; cancelling live
    // work under a record no reader can read would be a repair invented from no
    // evidence. The caller's quarantine result is what says so out loud.
    if (parent === undefined) continue
    if (Queues.terminal(parent)) {
      orphans.push({ job, run, reason: "run-terminal" })
    }
  }
  return orphans
}

type UnisolableStalePlanBatch = Readonly<{ run: RunId; drift: string }>

/**
 * FAILED bisectable batches whose recorded plan drifted from the installed
 * catalog. Isolation re-plans every parent step, so such a batch can never
 * bisect — {@link needsSettlement} keeps it alive and every compose cycle re-tries
 * (and re-refuses) isolation forever. This is the isolate-path sibling of the
 * advance-path stale-steps drift. Already-retired batches carry a release reason,
 * which flips {@link bisectable} false, so they self-exclude here — the detection
 * clears once retired (audit stops lying).
 */
/** A run whose cursor step has no Job and that no writer can still be starting.
 *
 * A Job is requested in the SAME event batch as the transition that entitles it
 * (`startRun` emits `queue/run/started` + the step-0 request; `advanceQueue`
 * emits the next request with the previous step's terminal projection), so the
 * only legitimate joblessness at the cursor is the window between a Job
 * finishing and the next `advance` — seconds under a live runner. Past
 * {@link ORPHANED_RUN_GRACE_MS} the writer is gone, and the run can NEVER settle
 * on its own: `advanceQueue` returns no events when the cursor has no Job, and
 * `jobs.recover()` iterates Jobs, so it has nothing to reclaim. That is the
 * permanent phantom `● run` (live incident: R1582, 45h and counting).
 */
const ORPHANED_RUN_GRACE_MS = 15 * 60_000

type OrphanedRun = Readonly<{ run: RunId; step: StepName; since: string }>

/** The last instant this run is known to have been driven: the newest terminal
 * step Job before the cursor, else the run's start. Anchoring on `startedAt`
 * alone would settle a long-lived multi-step run that just advanced. */
function lastDriven(record: DeepReadonly<QueueRecord>, run: Run): string {
  let latest = record.startedAt
  for (const step of run.steps.slice(0, run.cursor)) {
    const job = step.job
    const finishedAt = job?.status === "completed" ? job.finishedAt : undefined
    if (finishedAt !== undefined && Date.parse(finishedAt) > Date.parse(latest)) latest = finishedAt
  }
  return latest
}

function orphanedJoblessRuns(
  state: DeepReadonly<RuntimeState>,
  recoveryTime: string,
  reader: TolerantQueueReader,
): readonly OrphanedRun[] {
  const cutoff = Date.parse(recoveryTime) - ORPHANED_RUN_GRACE_MS
  const orphans: OrphanedRun[] = []
  for (const record of Queues.values(state.queues)) {
    const run = reader.read(record, state.jobs)
    // Quarantined: its cursor and its step Jobs are exactly what could not be
    // read, so there is no honest orphan judgment to make about it.
    if (run === undefined) continue
    if (Queues.terminal(run)) continue
    const step = run.steps[run.cursor]
    if (step === undefined || step.job !== undefined) continue
    const since = lastDriven(record, run)
    if (Date.parse(since) > cutoff) continue
    orphans.push({ run: record.id, step: step.name, since })
  }
  return orphans
}

function unisolableStalePlanBatches(
  state: DeepReadonly<RuntimeState>,
  byName: ReadonlyMap<string, RuntimeStep>,
  reader: TolerantQueueReader,
): readonly UnisolableStalePlanBatch[] {
  const batches: UnisolableStalePlanBatch[] = []
  for (const record of Queues.values(state.queues)) {
    const run = reader.read(record, state.jobs)
    // Quarantined: `bisectable` and the plan-drift comparison both read the
    // materialized steps, which is the read that failed.
    if (run === undefined) continue
    if (!bisectable(run)) continue
    const drift = recordedPlanDrift(run.steps, byName)
    if (drift !== undefined) batches.push({ run: record.id, drift })
  }
  return batches
}

function auditQueues(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  progress: QueueProgressPolicy,
  needsPersonOwner: string,
  options: QueueAuditOptions,
): QueueAuditEmission {
  // Emissions, not readings: every code pushed below — or written inline into
  // the returned object — must be listed in YRD_QUEUE_AUDIT_FINDING_CODES or
  // this file stops compiling. The return type carries that closure outward;
  // returning the open reader type would let an inline finding widen at the
  // boundary and type-check with any string.
  const findings: QueueAuditFindingEmission[] = []
  const installed = new Map(steps.map((step) => [step.name, step]))
  // ONE reader for the whole walk. The record walk below used to carry its own
  // local try/catch, which made `invalid-run` look covered while three later
  // population walks in this same function still called the eager reader
  // directly — so an unreadable record threw straight out of `queue audit` past
  // the very finding written to report it. A reader shared by every walk is what
  // makes that finding reachable; a second private catch is how it stopped being.
  const reader = createTolerantQueueReader()
  const auditNowMs = options.now === undefined ? undefined : parseAuditTime(options.now, "now")
  for (const pause of Object.values(state.queues.pauses)) {
    const specimen = `queue:${baseIdentity(pause.base)}`
    if (pause.expiresAt === undefined) {
      findings.push({
        code: "queue-hold-ttl-missing",
        message: `Queue '${baseIdentity(pause.base)}' has a legacy hold with no TTL: ${pause.reason}`,
        specimen,
        since: pause.pausedAt,
      })
      continue
    }
    const expiresAtMs = parseAuditTime(pause.expiresAt, "queue pause expiry")
    if (auditNowMs !== undefined && expiresAtMs <= auditNowMs) {
      findings.push({
        code: "queue-hold-expired",
        message: `Queue '${baseIdentity(pause.base)}' hold expired at ${pause.expiresAt} but remains active: ${pause.reason}`,
        specimen,
        since: pause.pausedAt,
        blockedMs: Math.max(0, auditNowMs - expiresAtMs),
      })
    }
  }
  // `draft-stranded` reported a change PUSHED but never submitted — a record
  // state (@i/10-merge-queue/drafts-strand-silently, #undead; specimens
  // PR846/849/856/886 sat 9-22 HOURS). Since S7 a push with no submit ref
  // creates nothing the queue can see at all: there is no record to age, and the
  // branch is invisible to this projection rather than stranded within it. What
  // survives is the mirror finding below — an approval in git the lane has not
  // served — which is the half a queue projection can still witness.
  //
  // NOT COVERED, and deliberately named here rather than left silent: a pushed
  // branch nobody submitted now ages entirely outside yrd. Restoring that
  // finding needs a git-side branch census this layer cannot make.
  if (auditNowMs !== undefined) {
    // The mirror image of a stranded draft: a branch APPROVED in git
    // (refs/yrd/submit/<branch>, projected by the receiver) that no record
    // carries, so nothing can run it (branch-is-change 2a). Same grace as a
    // draft, so a push that is about to be followed by its `pr submit` does
    // not page; same consumer contract — the watcher reads this, never git.
    for (const submit of unrecordedSubmits(state.bays, state.queues)) {
      const atMs = parseAuditTime(submit.at, "branch submit clock")
      if (auditNowMs - atMs <= DRAFT_STRANDED_GRACE_MS) continue
      findings.push({
        code: "unrecorded-submit",
        message: submit.reason.message,
        specimen: `branch:${submit.branch}`,
        since: submit.at,
        blockedMs: Math.max(0, auditNowMs - atMs),
        // S6: the derived lane serves live submits; a persisting row means the
        // compose is not running, derived admission is unwired, or the
        // derivation refused (the queue log's 'compose-derived-*' actions say
        // which). Re-pushing branch + submit ref renews the authority.
        resolution: [`git push ${RECEIVER_REMOTE_NAME} ${submit.branch}:refs/for/${submit.base}/<issue>`],
      })
    }
  }
  // Three member-level findings are deleted with the record store, none of them
  // reachable without it. `missing-pr` reported a run member the store could not
  // materialize — store corruption — and there is no store left to disagree with
  // a run: a member's snapshot IS its identity, and a damaged run is what the
  // journal's hash chain detects. `run-without-submit-ancestry` and
  // `run-without-check-ancestry` reported a member the queues-slice booked as
  // holding no TOKEN; every member's authority is its live submit fact, verified
  // at run start and never a token, so both could only fire on a record member.
  // "Started without authority" is now the admission-refusal ledger's story,
  // read at the end of this walk.
  for (const record of Queues.values(state.queues)) {
    // Quarantined rows become `invalid-run` findings once, after every walk has
    // had its say, so a record several walks meet is reported once.
    const run = reader.read(record, state.jobs)
    if (run === undefined) continue
    if (Queues.terminal(run)) continue
    // Step 0's Job is requested in the same event batch as `queue/run/started`,
    // so a non-terminal run with NO Job at all never started and never can:
    // `advance` no-ops without a Job. Unambiguous — unlike a later cursor step,
    // this cannot be the brief window between a Job finishing and the next
    // advance, so flag it with no clock. `recover` settles it.
    if (run.steps.every((step) => step.job === undefined)) {
      findings.push({
        code: "orphaned-run",
        message: `queue run '${record.id}' is ${run.status} with no job for any step; it can never advance`,
        run: record.id,
        ...(record.steps[0] === undefined ? {} : { step: record.steps[0].name }),
      })
    }
    // The read side of the lease seam (21094). A step whose Job is still
    // `in_progress` PROJECTS as running no matter how long ago its lease lapsed,
    // so the queue view showed a healthy run and audit said nothing while
    // nothing was left to renew it. R1740's lease expired at 20:35:03.925Z and
    // the `lose` transition was not written until 20:45:27.620Z — 10m24s in
    // which every reader was told the run was fine. `recover` is the writer that
    // settles this; the audit's job is to stop the gap being invisible, so it
    // reports the lapse and how long it has stood. Clock-gated like the hold
    // checks above: with no `now`, an expiry cannot be judged at all.
    if (auditNowMs !== undefined) {
      for (const step of run.steps) {
        const job = step.job
        if (job?.status !== "in_progress") continue
        const leaseExpiresAtMs = parseAuditTime(job.leaseExpiresAt, "job lease expiry")
        if (leaseExpiresAtMs > auditNowMs) continue
        findings.push({
          code: "run-lease-expired",
          message:
            `queue run '${record.id}' step '${step.name}' still reports job '${job.id}' running, but its ` +
            `runner lease expired at ${job.leaseExpiresAt} and nothing is renewing it; 'recover' settles it`,
          run: record.id,
          step: step.name,
          since: job.leaseExpiresAt,
          blockedMs: Math.max(0, auditNowMs - leaseExpiresAtMs),
        })
      }
    }
    for (const planned of record.steps) {
      const current = installed.get(planned.name)
      if (current === undefined) {
        findings.push({
          code: "step-unavailable",
          message: `queue run '${record.id}' requires unavailable step '${planned.name}' revision '${planned.revision}'`,
          run: record.id,
          step: planned.name,
        })
      } else if (current.revision !== planned.revision) {
        findings.push({
          code: "step-revision-drift",
          message: `queue run '${record.id}' requires step '${planned.name}' revision '${planned.revision}', installed '${current.revision}'`,
          run: record.id,
          step: planned.name,
        })
      }
    }
  }
  // `candidate-revision-mismatch` compared a run's pinned member against the
  // change's CURRENT record revision — a comparison with no second term since
  // S7. A member's snapshot is its revision, so a run can no longer disagree
  // with a newer one; the live equivalent (the fact moved off the pinned sha)
  // is `stale-pr`, reported by `pinnedChangeError` at dispatch.
  // The record walk above `continue`s past terminal runs and never inspects Jobs
  // whose run record is gone — so a requested Job stranded under a terminal or
  // absent run was invisible ("queue audit clean" printed over it). Surface it.
  for (const orphan of orphanedRequestedQueueJobs(state, reader)) {
    findings.push({
      code: "orphaned-requested-job",
      message: `requested job '${orphan.job.id}' (${orphan.job.key}) is stranded: its parent queue run '${orphan.run}' is ${orphan.reason === "run-absent" ? "absent" : "terminal"}`,
      run: orphan.run,
    })
  }
  // A FAILED batch is terminal, so the record walk above skipped its step drift.
  // An un-isolable stale-plan batch would otherwise re-refuse isolation every
  // cycle unseen — surface it so "audit clean" stops lying about a live zombie.
  for (const batch of unisolableStalePlanBatches(state, installed, reader)) {
    findings.push({
      code: "unisolable-stale-plan",
      message: `failed batch '${batch.run}' can never isolate under the installed catalog: ${batch.drift}`,
      run: batch.run,
    })
  }
  // Every walk that reads run records is above this line, so the quarantine is
  // now complete: one finding per record no reader could materialize, carrying
  // the reader's exact refusal. This is the standing operator surface for the
  // class — `recover` reports the same rows as a result at the moment it works
  // around them, and this reports them for as long as they stand.
  for (const unreadable of reader.quarantined()) {
    findings.push({
      code: "invalid-run",
      message: unreadable.reason,
      run: unreadable.run,
    })
  }
  // Every code above walks RUN RECORDS. A change refused during required checks
  // never becomes one, so a head-of-line refusal loop was structurally invisible
  // here: `queue audit` reported `findings: []` through a 5h46m block while each
  // cycle logged a loggily-only `compose-candidate-skip`. The refusal ledger is
  // the durable trace of exactly that, so read it (22395).
  //
  // NEITHER population may be `admissionQueue`'s. That function's members are
  // MATERIALIZED by the compose — it needs the PR-number mint and a git
  // enrichment read to derive one — and `audit` is a pure read with neither, so
  // it can only ever pass an empty `derived` and get an empty queue back. That
  // is exactly how these three codes went dark under S7: the list of finding
  // codes never changed, so the `satisfies` fence stayed green, while the
  // population every producer walked emptied out. Both walks below therefore
  // read DURABLE state only — standing submit facts, retained run snapshots,
  // the refusal ledger and the Job store — so there is no argument a caller can
  // forget to pass.
  const refusalFindings = admissionRefusalAuditFindings(state, progress, needsPersonOwner)
  findings.push(...refusalFindings)
  findings.push(...queueProgressAuditFindings(state, steps, refusalFindings, progress, options))
  return { findings }
}

function admissionRefusalAuditFindings(
  state: DeepReadonly<RuntimeState>,
  progress: QueueProgressPolicy,
  needsPersonOwner: string,
): QueueAuditFindingEmission[] {
  const findings: QueueAuditFindingEmission[] = []
  const head = requiredCheckQueueHead(state)
  for (const refusal of Object.values(state.queues.admissionRefusals).toSorted((left, right) =>
    compareNatural(left.pr, right.pr),
  )) {
    // A settled refusal stopped being a head-of-line RETRY loop the moment a
    // person's judgment replaced automatic remediation — but "stop retrying"
    // and "stop REPORTING" are different facts, and the original design
    // conflated them: this exact branch used to `continue` here, and
    // `queue audit` went silent the instant a refusal most needed a human
    // (@i/10-merge-queue/22918-needs-person-unowned). Reported
    // unconditionally, never gated on being the head of line — a parked PR
    // lets others proceed around it, so it is no longer a queue-blocking
    // wedge, but it is still an unresolved judgment call nobody owns until a
    // person acts on it.
    if (refusal.settlement !== undefined) {
      findings.push({
        code: "admission-refusal-needs-person",
        message:
          `change '${refusal.pr}' needs a person: its entry-check failure '${refusal.code}' has no ` +
          `mechanical remedy — ${refusal.settlement.reason}. Owner: ${needsPersonOwner}.`,
        pr: refusal.pr,
        specimen: `pr:${refusal.pr}:needs-person`,
        refusal: refusal.code,
        since: refusal.settlement.settledAt,
        owner: needsPersonOwner,
      })
      continue
    }
    const sameCodeCount = refusal.sameCodeCount ?? refusal.count
    const sameCodeFirstAt = refusal.sameCodeFirstAt ?? refusal.firstAt
    if (head?.id !== refusal.pr) continue
    const threshold = structurallyPermanentAdmissionRefusal(refusal.code) ? 1 : progress.refusalCount
    if (sameCodeCount < threshold) continue
    const blockedMs = Math.max(0, Date.parse(refusal.lastAt) - Date.parse(sameCodeFirstAt))
    findings.push({
      code: "admission-refusal-loop",
      message:
        `change '${refusal.pr}' at the head of the required-check queue failed its entry checks ` +
        `${sameCodeCount} consecutive times ` +
        `over ${formatRefusalSpan(blockedMs)} (since ${sameCodeFirstAt}) without ever completing required checks; ` +
        `latest failure '${refusal.code}': ${refusal.reason}`,
      pr: refusal.pr,
      specimen: `pr:${refusal.pr}:refusal:${refusal.code}`,
      refusal: refusal.code,
      count: sameCodeCount,
      since: sameCodeFirstAt,
      blockedMs,
    })
  }
  return findings
}

/**
 * The head of the required-check queue, named from DURABLE state alone.
 *
 * A refusal only reads as a head-of-line LOOP if something can say what the
 * head is, and pre-S7 that was `admissionQueue` — a population the audit can no
 * longer obtain, because a derived member is materialized by the compose from
 * the PR-number mint and a git enrichment read. Asking for it from a pure audit
 * returns `[]` forever, and an empty queue has no head, so every refusal fell
 * through the `head?.id !== refusal.pr` guard and `admission-refusal-loop` went
 * permanently silent while the ledger behind it kept counting.
 *
 * What survives is the ordering itself, which never needed materialization: the
 * queue is ordered by the clock a member's own submit fact carries
 * ({@link queueProgressTime} reduces to exactly `submit.at` for a derived
 * member, because the fact IS the check request), tie-broken by id. So this
 * walks the standing facts and names each one the way the compose would:
 *
 *   - its refusal-ledger row's id, when a compose refused it (the row is a
 *     refused member's ONLY durable identity — no run, so no snapshot), else
 *   - its latest retained run snapshot's id.
 *
 * A fact with neither has never been composed, holds no id, and cannot be the
 * member a refusal is blocking. A fact whose snapshot a run has already
 * consumed is PAST admission and leaves this queue — a live ledger row does not
 * hold it here, for the reason the loop body spells out.
 */
function requiredCheckQueueHead(state: DeepReadonly<RuntimeState>): Readonly<{ id: string; at: string }> | undefined {
  const authority = derivedAuthorityLookup(state)
  const candidates: Readonly<{ id: string; at: string }>[] = []
  for (const [branch, submit] of Object.entries(state.bays.submits)) {
    if (submit === undefined) continue
    const ledger = branchAdmissionRefusal(state.queues, branch)
    const snapshot = latestChangeSnapshot(
      state.queues as QueuesState,
      (member) => member.branch === branch && member.headSha === submit.sha,
    )
    const id = ledger?.pr ?? snapshot?.id
    if (id === undefined) continue
    // A member a run already holds is PAST admission, and a ledger row does not
    // put it back: every compose after the admitting one re-derives the member,
    // finds its authority spent and ledgers `queue-submit-authority-consumed`,
    // so a merge that hangs for an hour mints a refusal STREAK on a member that
    // passed its entry checks on the first try. Reported as a head-of-line
    // refusal loop that is a false page with the wrong cure, and — worse — it
    // suppressed the `queue-progress-stalled` finding that names the real
    // failure, because the progress walk yields to the refusal walk on a shared
    // member. The run is where this member's story is; `queue-progress-stalled`
    // tells it.
    if (snapshot !== undefined && authority(snapshot)?.standing !== true) continue
    const pause = state.queues.pauses[baseIdentity(submit.base)]
    if (pause !== undefined && !pause.allowedPRs.includes(id)) continue
    candidates.push({ id, at: submit.at })
  }
  return candidates.toSorted((left, right) => left.at.localeCompare(right.at) || compareNatural(left.id, right.id))[0]
}

/** The refusal-ledger row a branch currently carries, if any. Keyed by branch
 * rather than by id because a refused derived member's id is minted by the very
 * compose being refused — the row is what makes the id stable across cycles.
 *
 * The READ side (@yrd/cli `derivedDeliveryStatus`) had the same problem and
 * solved it the wrong way: it looked the ledger up as
 * `admissionRefusals[member.id]`, gating the one lookup that can report a
 * failure on the member that the failure prevented — so every operator surface
 * read a refused branch as "pending". It calls this instead; do not grow a
 * second copy, which is how the next cutover leaves one of them behind. */
export function branchAdmissionRefusal(
  queues: DeepReadonly<QueuesState>,
  branch: string,
): DeepReadonly<QueueAdmissionRefusal> | undefined {
  return Object.values(queues.admissionRefusals).find((row) => row.branch === branch)
}

/**
 * The identity a standing fact carries when no compose has served its CURRENT
 * sha. Same ladder as {@link requiredCheckQueueHead}, with one rung added at
 * the bottom: under branch-is-change a branch nothing has ever composed has no
 * number at all, and the branch name is then the only identity that exists.
 *
 * The bottom rung is deliberately a real, actionable string rather than an
 * omitted field: `queue-never-started` is in the page-worthy set
 * (`habitantQueueProgress`), whose consumer requires `pr` alongside `count`, so
 * a finding that omitted it would take the whole audit source down rather than
 * report the queue it was describing.
 */
function unservedMemberIdentity(state: DeepReadonly<RuntimeState>, branch: string): string {
  const ledger = branchAdmissionRefusal(state.queues, branch)
  if (ledger !== undefined) return ledger.pr
  return latestChangeSnapshot(state.queues as QueuesState, (member) => member.branch === branch)?.id ?? branch
}

/**
 * Admission attempts the queue actually DISPATCHED for these approvals — the
 * post-S7 quantity `progress.minAdmissionChecks` gates on the never-started arm.
 *
 * Keyed on the BRANCH and sha the Job pinned, never on the member's id, and
 * that is what makes it work at all. A member whose admission is still in
 * flight has no retained run snapshot and no refusal row, so it has no PR
 * NUMBER anywhere durable — the mint runs inside the compose — and a key-prefix
 * count (`admission:<id>:`) answers ZERO for exactly the member whose admission
 * is running, which would page every in-flight approval as untouched. The Job's
 * own input carries the branch+sha it pinned ({@link AdmissionJobIdentitySchema},
 * the field the stale-admission sweep already reads), which is durable,
 * mint-independent, and survives a compose refactor.
 *
 * KNOWN LIMIT, stated rather than left to be discovered: only the ZERO boundary
 * is meaningfully countable. This yields about one per member per
 * (revision, base), so a configured `minAdmissionChecks` above roughly 2
 * behaves the same as 2. The retry CADENCE the knob was written for was a count
 * of `ChangeCheckRequest` rows, and a standing submit fact is now that request —
 * singular and permanent. Restoring the numeric band needs a durable per-member
 * attempt counter nothing writes today. What survives, and is load-bearing, is
 * the asymmetry the policy field itself argues for: zero dispatched attempts
 * over ready work is a runner asleep, and must page.
 */
function admissionAttempts(
  state: DeepReadonly<RuntimeState>,
  approvals: readonly Readonly<{ branch: string; sha: string }>[],
  sinceMs: number,
): number {
  const wanted = new Set(approvals.map((approval) => `${approval.branch}@${approval.sha}`))
  return Object.values(state.jobs.byId).filter((job) => {
    if (job.key?.startsWith("admission:") !== true) return false
    if (parseAuditTime(job.requestedAt, "admission job clock") < sinceMs) return false
    const identity = AdmissionJobIdentitySchema.safeParse(job.input)
    if (!identity.success) return false
    return identity.data.prs.some((member) => wanted.has(`${member.branch}@${member.headSha}`))
  }).length
}

/**
 * Work the queue has SERVED and not delivered: a standing submit fact whose
 * current sha a run admitted, where that run has not merged.
 *
 * This is the population `queueProgressQueue` used to compute, and the reason
 * it returned nothing is worth stating because the mistake is easy to make
 * again. It kept a member only while `derivedAuthorityLookup` called its fact
 * STANDING — but standing means "no run has consumed this authority yet", and
 * a run consumes it at ADMISSION, not at merge. So the moment the queue
 * accepted a member it dropped out of the progress population, and
 * "admission passes, nothing merges" — the one failure this walk exists to
 * catch — was the exact shape it could no longer see.
 *
 * Delivery, not consumption, is the retirement: the consuming run's
 * `passedAt`, the same stamp {@link latestQueueMergeMs} reads as this base's
 * merge clock, so a member leaves this population at precisely the moment it
 * becomes the event that restarts the window for everybody behind it.
 */
function outstandingServedMembers(state: DeepReadonly<RuntimeState>, steps: readonly RuntimeStep[]): Change[] {
  const selected = declaredDefaultSteps(steps)
  if (!selected.some((step) => step.kind === "merge")) return []
  const authority = derivedAuthorityLookup(state)
  return Object.entries(state.bays.submits)
    .flatMap(([branch, submit]): Change[] => {
      if (submit === undefined) return []
      const snapshot = latestChangeSnapshot(
        state.queues as QueuesState,
        (member) => member.branch === branch && member.headSha === submit.sha,
      )
      // No snapshot at this sha is the UNSERVED half, reported by
      // `queue-never-started` — never silently dropped between the two walks.
      if (snapshot === undefined) return []
      const verdict = authority(snapshot)
      if (verdict === undefined) return []
      if (!verdict.standing && queueRunDelivered(state, verdict.consumedBy)) return []
      const pr = materializeSnapshotMember(state.bays, snapshot)
      return pr === undefined ? [] : [pr]
    })
    .filter((pr) => blockingQueuePause(state, pr) === undefined)
    .toSorted(
      (left, right) =>
        queueProgressTime(left).localeCompare(queueProgressTime(right)) || compareNatural(left.id, right.id),
    )
}

/** Did this run MERGE its members? `passedAt` is the stamp a root run gets when
 * it reaches `passed`, and it is the same fact `latestQueueMergeMs` reads. */
function queueRunDelivered(state: DeepReadonly<RuntimeState>, run: RunId): boolean {
  return Queues.get(state.queues as QueuesState, run)?.passedAt !== undefined
}

/**
 * The two ways a queue fails to move, both re-sourced onto standing submit
 * facts (S7, branch-is-change @i/10 22991) and split by ONE durable question —
 * has any compose served this fact's current sha?
 *
 *   - No  ⇒ `queue-never-started`. The approval stands and nothing has run it.
 *   - Yes ⇒ `queue-progress-stalled`. Something ran it and nothing merged.
 *
 * That split replaces the record lane's `checksRequested(pr)` test, which since
 * S7 answers TRUE for every member alive (the fact is the check request), so
 * the never-started arm it used to gate had emptied permanently.
 */
function queueProgressAuditFindings(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  refusalFindings: readonly QueueAuditFinding[],
  progress: QueueProgressPolicy,
  options: QueueAuditOptions,
): QueueAuditFindingEmission[] {
  if (options.now === undefined) return []
  const selected = declaredDefaultSteps(steps)
  // Both arms stay behind the merge-step guard, unchanged and still not
  // endorsed: the selection is PERSISTED at install time and nothing
  // reconciles it with the config the CLI would compute today, so a queue
  // installed merge-less audits clean forever. `unrecorded-submit` is the
  // surface that still speaks for such a queue, and it takes no guard.
  if (!selected.some((step) => step.kind === "merge")) return []
  const nowMs = parseAuditTime(options.now, "now")
  const findings: QueueAuditFindingEmission[] = []
  findings.push(...neverStartedFindings(state, refusalFindings, progress, nowMs))
  findings.push(...progressStalledFindings(state, steps, refusalFindings, progress, nowMs))
  return findings
}

/**
 * Approvals standing in git that no compose has served — PR685's shape (ready
 * at position 1 for 65 minutes over a LIVE runner while `queue audit` stayed
 * empty), which is why zero attempts must stay loud rather than read as quiet.
 *
 * Same population as `unrecorded-submit`, deliberately, and reused from it
 * rather than derived a second time: one branch-level row per approval for a
 * reader, one aggregate per queue for the pager, and no way for the two to
 * disagree about who is waiting.
 */
function neverStartedFindings(
  state: DeepReadonly<RuntimeState>,
  refusalFindings: readonly QueueAuditFinding[],
  progress: QueueProgressPolicy,
  nowMs: number,
): QueueAuditFindingEmission[] {
  const findings: QueueAuditFindingEmission[] = []
  const unserved = unrecordedSubmits(state.bays, state.queues)
    .map((submit) => ({ ...submit, id: unservedMemberIdentity(state, submit.branch) }))
    .filter((submit) => {
      const pause = state.queues.pauses[baseIdentity(submit.base)]
      return pause === undefined || pause.allowedPRs.includes(submit.id)
    })
  const byBase = Map.groupBy(unserved, (submit) => baseIdentity(submit.base))
  for (const [base, submits] of [...byBase.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = submits.toSorted(
      (left, right) => left.at.localeCompare(right.at) || compareNatural(left.id, right.id),
    )
    const head = ordered[0]
    if (head === undefined) continue
    // The window is dated from the OLDEST unserved approval: a later approval
    // joining must not drag the clock forward and shorten a wedge that has
    // already been running.
    const since = head.at
    const blockedMs = Math.max(0, nowMs - parseAuditTime(since, "branch submit clock"))
    if (blockedMs < progress.noLandingMs) continue
    // A member the refusal walk already named owns its own finding, with the
    // ledger's exact code and streak. Two pages for one wedge is how an
    // operator learns to mute both.
    if (refusalFindings.some((finding) => ordered.some((submit) => submit.id === finding.pr))) continue
    // The policy's quiet middle band, unchanged in meaning and re-sourced in
    // quantity ({@link admissionAttempts}): zero attempts is a runner asleep
    // over ready work and must page; a handful is ordinary retry cadence; many
    // is a queue trying and failing.
    const attempts = admissionAttempts(
      state,
      ordered.map((submit) => ({ branch: submit.branch, sha: submit.sha })),
      parseAuditTime(since, "branch submit clock"),
    )
    if (attempts > 0 && attempts < progress.minAdmissionChecks) continue
    findings.push({
      code: "queue-never-started",
      message:
        `Queue '${base}' has ${ordered.length} submitted ` +
        `${ordered.length === 1 ? "approval" : "approvals"} that no compose has served for ` +
        `${formatRefusalSpan(blockedMs)} (since ${since}); head is branch '${head.branch}'.`,
      resolution: [`Start or restart the habitant queue runner, then verify it composes branch '${head.branch}'.`],
      pr: head.id,
      specimen: `queue:${base}:never-started`,
      count: ordered.length,
      since,
      blockedMs,
    })
  }
  return findings
}

/**
 * Served work that is not landing: the queue admitted it and no merge followed
 * inside the SLO. The window restarts on every real merge, so this measures the
 * gap since the queue last MOVED, not since the work arrived.
 *
 * `minAdmissionChecks` deliberately does NOT gate this arm, and that is a
 * finding rather than an omission. The knob's original quantity — check
 * REQUESTS inside the window — died with S7, because a standing submit fact IS
 * the check request and every member carries exactly one forever. Two
 * replacements were measured here and BOTH turned out to be artifacts of how
 * the compose currently happens to behave rather than facts about the queue:
 * the refusal ledger's `queue-submit-authority-consumed` streak (one row per
 * post-admission cycle), and the admission-Job count. The first stopped being
 * written and the second changed shape — 10 cycles went from 9 rows to 2 Jobs —
 * inside a single afternoon of unrelated compose work, which is the whole
 * argument: a stall alarm keyed on compose cadence goes quiet whenever the
 * compose is refactored, and goes quiet SILENTLY, which is exactly the failure
 * this walk was re-sourced to end.
 *
 * What is stable is the question itself. A member the queue ADMITTED, whose run
 * has not merged, past the SLO, is stalled however many times anything has been
 * tried — more attempts would not make it more stalled, and one attempt does
 * not make it less so. `minAdmissionChecks` still gates the never-started arm,
 * where attempts are a property of the population (nothing has been dispatched
 * at all) rather than of the loop that dispatches them.
 */
function progressStalledFindings(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  refusalFindings: readonly QueueAuditFinding[],
  progress: QueueProgressPolicy,
  nowMs: number,
): QueueAuditFindingEmission[] {
  const findings: QueueAuditFindingEmission[] = []
  const outstanding = outstandingServedMembers(state, steps)
  const byBase = Map.groupBy(outstanding, (pr) => baseIdentity(pr.base))
  for (const [base, prs] of [...byBase.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const first = prs[0]
    if (first === undefined) continue
    const latestMergeMs = latestQueueMergeMs(state, base)
    const queuedAtMs = Math.min(...prs.map((pr) => parseAuditTime(queueProgressTime(pr), `queue time for ${pr.id}`)))
    const sinceMs = Math.max(queuedAtMs, latestMergeMs ?? queuedAtMs)
    const blockedMs = Math.max(0, nowMs - sinceMs)
    if (blockedMs < progress.noLandingMs) continue
    if (refusalFindings.some((finding) => finding.pr === first.id)) continue
    const since = new Date(sinceMs).toISOString()
    findings.push({
      code: "queue-progress-stalled",
      message:
        `Queue '${base}' has ${prs.length} admitted ${prs.length === 1 ? "change" : "changes"} and ` +
        `no merge for ${formatRefusalSpan(blockedMs)} (since ${since}); head is '${first.id}'.`,
      pr: first.id,
      specimen: `queue:${base}`,
      count: prs.length,
      since,
      blockedMs,
    })
  }
  return findings
}

/** When this base last merged, read from the RUNS that merged it. The record
 * `integratedAt`/`alreadyLandedAt` stamps this replaces said the same thing one
 * level down; a root run that reached `passed` on this base is the same event,
 * and is what still exists since S7. Retention bounds it: with every run for a
 * base pruned, the queue has no merge clock and the caller falls back to the
 * queued-at clock exactly as it did for a base that never merged. */
function latestQueueMergeMs(state: DeepReadonly<RuntimeState>, base: string): number | undefined {
  return Queues.values(state.queues)
    .filter((record) => record.parent === undefined && baseIdentity(record.base) === base)
    .map((record) => record.passedAt)
    .filter((at): at is string => at !== undefined)
    .map((at) => parseAuditTime(at, "merge time"))
    .reduce<number | undefined>((latest, at) => (latest === undefined ? at : Math.max(latest, at)), undefined)
}

function validateQueueProgressPolicy(policy: QueueProgressPolicy): QueueProgressPolicy {
  if (!Number.isSafeInteger(policy.noLandingMs) || policy.noLandingMs < 1) {
    throw new Error("yrd: queue progress noLandingMs must be an integer >= 1")
  }
  if (!Number.isSafeInteger(policy.refusalCount) || policy.refusalCount < 1) {
    throw new Error("yrd: queue progress refusalCount must be an integer >= 1")
  }
  if (!Number.isSafeInteger(policy.minAdmissionChecks) || policy.minAdmissionChecks < 1) {
    throw new Error("yrd: queue progress minAdmissionChecks must be an integer >= 1")
  }
  return Object.freeze({ ...policy })
}

function parseAuditTime(value: string, field: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`yrd: queue audit ${field} must be an ISO timestamp`)
  return milliseconds
}

/** Compact block span for the audit message. Deliberately derived from the two
 * journal timestamps rather than a wall clock, so `queue audit` stays a pure
 * function of projected state and the number is reproducible on replay. */
function formatRefusalSpan(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${seconds}s`
}

/** Classify a planned step against the installed catalog: `undefined` when it
 * still matches, else a human-readable drift reason. The single source of truth
 * for both the fail-loud {@link requirePlannedStep} (isolate path) and the typed
 * stale-steps release (advance path). */
function plannedStepDrift(steps: ReadonlyMap<string, RuntimeStep>, planned: InstalledStep): string | undefined {
  const current = steps.get(planned.name)
  if (current === undefined) return `queue step '${planned.name}' is not installed`
  if (
    current.revision !== planned.revision ||
    current.kind !== planned.kind ||
    current.classification !== planned.classification
  ) {
    return `queue step '${planned.name}' revision '${planned.revision}' does not match installed revision '${current.revision}'`
  }
  return undefined
}

function requirePlannedStep(steps: ReadonlyMap<string, RuntimeStep>, planned: InstalledStep): RuntimeStep {
  const drift = plannedStepDrift(steps, planned)
  if (drift !== undefined) throw new Error(`yrd: ${drift}`)
  const current = steps.get(planned.name)
  if (current === undefined) throw new Error(`yrd: queue step '${planned.name}' is not installed`)
  return current
}

/** First drift across a run's ENTIRE recorded plan against the installed catalog,
 * or `undefined` when every step still matches. Isolation re-plans every parent
 * step ({@link requirePlannedStep} over `parent.steps`), so a drift on ANY of them
 * makes the batch permanently un-isolable — the trigger for a stale-plan retirement. */
function recordedPlanDrift(
  steps: readonly InstalledStep[],
  byName: ReadonlyMap<string, RuntimeStep>,
): string | undefined {
  for (const planned of steps) {
    const drift = plannedStepDrift(byName, planned)
    if (drift !== undefined) return drift
  }
  return undefined
}

/**
 * The members an explicit `prs: [...]` selection names.
 *
 * S7: a selector resolves against the run's OWN derived batch, never a store.
 * That is not a narrowing — `args.derived` is the whole population a compose
 * can run, so a selector naming anything else names something the run could not
 * have executed anyway, and refusing it here is the same `pr-not-found` the
 * record lookup used to raise. `materialized` is the batch the caller already
 * built, so selection and execution cannot disagree about what a member is.
 */
function explicitPRs(
  state: DeepReadonly<BaysState>,
  args: QueueRunArgs,
  materialized: readonly Change[],
): Change[] | undefined {
  // `prs: []` beside a non-empty `derived` is an EXPLICIT selection of exactly
  // those derived members (the compose's candidate dispatch for an all-derived
  // partition); a bare empty/absent `prs` stays the implicit queue.
  if (args.prs !== undefined && args.prs.length === 0 && (args.derived?.length ?? 0) > 0) return []
  const selectors = args.prs === undefined || args.prs.length === 0 ? undefined : args.prs
  if (selectors === undefined) return undefined
  const prs = selectors.map((selector) => {
    // The two spellings fold DIFFERENTLY, and the asymmetry is the ruling
    // (@chief), not an oversight to tidy away.
    //
    // The minted id is OUR namespace — we mint every value in it, so folding
    // can never collapse two distinct members, and the status surfaces an
    // operator copies it off already fold. The branch is GIT'S namespace, where
    // refs are case-sensitive and `Topic/Selectors` and `topic/selectors` can
    // both exist and mean different things; a folding branch selector could
    // resolve to a branch the operator did not name, at the moment they are
    // asking us to merge it. Making someone retype a branch is cheap.
    //
    // So: do not "make the three selector surfaces agree" by folding both.
    const pr = materialized.find(
      (member) => member.id.toLowerCase() === selector.toLowerCase() || member.branch === selector,
    )
    if (pr === undefined) raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(state, selector))
    return pr
  })
  const ids = new Set<string>()
  for (const pr of prs) {
    if (ids.has(pr.id)) {
      raiseFailure("usage", "duplicate-pr", `yrd: queue.run: duplicate change '${pr.id}'`)
    }
    ids.add(pr.id)
  }
  return prs
}

/**
 * The derived-lane branches an explicit selector could possibly name — the
 * narrowing that keeps a named run from MINTING a number for every branch it is
 * about to discard.
 *
 * Deriving the whole lane on an explicit compose is required and stays: a
 * selector is matched against that batch and nothing else, so `prs: ["PR1"]`
 * cannot resolve against a lane that was never derived. What is NOT required is
 * handing a durable number to a member the selection then throws away, and that
 * is what the un-narrowed derivation did.
 *
 * The cost is per invocation, not per branch, and this correction is the point:
 * an unselected member retains no run snapshot and no refusal-ledger row, so it
 * has no durable identity home, so the NEXT explicit run cannot reuse its number
 * and mints another. Measured with three un-composed branches present, the mint
 * high-water went 1 → 4 → 7 → 10 across three `queue run <selector>` calls — N
 * numbers per run for N un-composed branches, forever, not the single skipped
 * number the first cut of this path claimed. Twelve idle submissions and ten
 * explicit runs burn 120.
 *
 * Resolution without minting is possible because a number a selector can
 * meaningfully name is already anchored somewhere durable — a retained
 * `ChangeSnapshot` (the member ran) or its refusal-ledger row (the member was
 * refused at admission). Those are exactly the two arms
 * `mintDerivedMemberIdentity` reuses. A `PRn` matching neither names a number
 * that escaped a previous run and can never be reissued; refusing it
 * `pr-not-found` is correct, and it is what the operator already sees — before
 * this narrowing that id resolved to a DIFFERENT branch on every run, so it was
 * never stably nameable in the first place.
 *
 * Folding matches {@link explicitPRs} exactly, including the asymmetry and for
 * the same @chief ruling: the minted id is our namespace and folds; the branch
 * is git's namespace and does not. The two functions must agree — this one
 * decides what gets derived and that one decides what the selector picked, so a
 * divergence would silently narrow a member out of a batch and then refuse it as
 * missing.
 */
function narrowToSelectableBranches(
  queues: DeepReadonly<QueuesState>,
  branches: readonly string[],
  selectors: readonly string[] | undefined,
): readonly string[] {
  if (selectors === undefined || selectors.length === 0) return branches
  const named = new Set(selectors)
  const folded = new Set(selectors.map((selector) => selector.toLowerCase()))
  return branches.filter((branch) => {
    if (named.has(branch)) return true
    const anchored = anchoredDerivedId(queues, branch)
    return anchored !== undefined && folded.has(anchored.toLowerCase())
  })
}

/** A derived branch's durable id when it has one, minting nothing. The same two
 * reuse arms `mintDerivedMemberIdentity` consults, in the same order: a retained
 * run snapshot first, then the refusal-ledger row that anchors a member refused
 * before any run retained one. Absent from both ⇒ the branch has never held a
 * number that outlived a compose. */
function anchoredDerivedId(queues: DeepReadonly<QueuesState>, branch: string): string | undefined {
  const retained = latestChangeSnapshot(queues as QueuesState, (snapshot) => snapshot.branch === branch)
  return retained?.id ?? branchAdmissionRefusal(queues, branch)?.pr
}

type QueuePosition = Readonly<{ at: string; identity: string }>

function changeQueuePosition(pr: DeepReadonly<Change>): QueuePosition {
  const submittedAt = currentChangeRev(pr).submittedAt
  if (submittedAt === undefined) throw new Error(`yrd: queued change '${pr.id}' has no submit time`)
  // Legacy projections expose no cross-plugin journal ordinal. Equal clocks
  // therefore have no recoverable chronology; retain the established PR line
  // ahead of additive intent rows, then use natural identity for replay.
  return { at: submittedAt, identity: `0:pr:${pr.id}` }
}

function compareQueuePosition(left: QueuePosition, right: QueuePosition): number {
  return left.at.localeCompare(right.at) || compareNatural(left.identity, right.identity)
}

function requestedPRs(
  state: DeepReadonly<BaysState>,
  args: QueueRunArgs,
  excluded: ReadonlySet<string> = new Set(),
  implicitBefore?: QueuePosition,
): Change[] {
  // Every member is derived since S7, so the batch IS the population: an
  // explicit selection picks out of it, and the implicit queue takes all of it
  // in submit-clock order. The record half that used to be unioned in here is
  // gone, and with it the interleave the two lanes needed.
  const derived = materializeDerivedRunMembers(state, args.derived ?? [])
  const explicit = explicitPRs(state, args, derived)
  const bySubmitClock = (left: Change, right: Change): number => {
    const leftSubmittedAt = currentChangeRev(left).submittedAt
    const rightSubmittedAt = currentChangeRev(right).submittedAt
    if (leftSubmittedAt === undefined) throw new Error(`yrd: queued change '${left.id}' has no submit time`)
    if (rightSubmittedAt === undefined) {
      throw new Error(`yrd: queued change '${right.id}' has no submit time`)
    }
    return leftSubmittedAt.localeCompare(rightSubmittedAt) || compareNatural(left.id, right.id)
  }
  // A NAMED selection is exactly what was named — nothing is unioned back in.
  //
  // This used to append every unselected member of the batch after the
  // selection, so `queue run <one-branch>` composed the whole batch. It was
  // written for ONE internal caller — the compose's own candidate dispatch,
  // which passes `prs: []` beside the candidate's `derived` entries meaning
  // "exactly these members" — where the union is the intended set and no
  // narrowing was ever asked for. With a real selector it silently re-added
  // everything the operator did not ask for, and a merge step then merged it.
  //
  // `explicit.length === 0` separates the two, and can only mean the internal
  // caller: `explicitPRs` returns `[]` for that dispatch alone, while a
  // non-empty selector list either resolves to a non-empty selection or raises
  // `pr-not-found`, so it can never arrive here empty.
  const prs = (explicit === undefined || explicit.length === 0 ? [...derived].toSorted(bySubmitClock) : [...explicit])
    .filter((pr) => !excluded.has(pr.id))
    .filter(
      (pr) =>
        explicit !== undefined ||
        implicitBefore === undefined ||
        compareQueuePosition(changeQueuePosition(pr), implicitBefore) < 0,
    )
  for (const pr of prs) {
    const delivery = changeDeliveryState(pr)
    if (
      delivery !== "submitted" &&
      delivery !== "ready" &&
      delivery !== "needs-author" &&
      delivery !== "integrated" &&
      delivery !== "already-landed"
    ) {
      raiseFailure("refusal", "pr-not-ready", `yrd: change '${pr.id}' is ${delivery}, not ready for the queue`)
    }
  }
  return prs
}

function resumableQueueRoots(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
): Run[] {
  const explicit = explicitPRs(state.bays, args, materializeDerivedRunMembers(state.bays, args.derived ?? []))
  const selected = explicit === undefined ? undefined : new Set(explicit.map((pr) => pr.id))
  const admissions = admissionSteps(steps)
  const requested = args.steps === undefined ? undefined : selectSteps(steps, args.steps)
  const indexed = (explicit ?? []).flatMap((pr) => {
    const id = latestRootRunId(state.queues.index, Queues.snapshot(pr))
    const record = id === undefined ? undefined : Queues.get(state.queues, id)
    return record === undefined ? [] : [materializeRun(record, state.jobs)]
  })
  const candidates = new Map<RunId, Run>(pendingQueueRoots(state).map((run) => [run.id, run]))
  for (const run of indexed) candidates.set(run.id, run)
  return [...candidates.values()].filter(
    (run) =>
      needsSettlement(state, run) &&
      projectionLookupGet(state.queues.authority.runs, run.id)?.released === undefined &&
      !samePlan(run.steps, admissions) &&
      (requested === undefined ||
        (samePlan(run.steps, requested) &&
          (run.stepSelection === undefined || run.stepSelection.authority === "explicit"))) &&
      (selected === undefined || run.prs.every((pr) => selected.has(pr.id))),
  )
}

function pendingQueueRoots(state: DeepReadonly<RuntimeState>): Run[] {
  return activeQueueRootIds(state.queues)
    .map((id) => Queues.get(state.queues, id))
    .filter((record): record is DeepReadonly<QueueRecord> => record !== undefined)
    .map((record) => materializeRun(record, state.jobs))
    .filter((run) => needsSettlement(state, run))
}

function needsSettlement(state: DeepReadonly<RuntimeState>, run: Run): boolean {
  if (!Queues.terminal(run) || needsAdvance(state, run)) return true
  if (!bisectable(run)) return false
  return ([0, 1] as const).some((part) => {
    const child = childQueue(state.queues, state.jobs, run.id, part)
    return child === undefined || needsSettlement(state, child)
  })
}

/** The settling root plus every isolation descendant, materialized — the runs
 * whose PASSED merges the settlement batch emits terminals for. A bisected
 * root fails while its children merge the halves; only the root ever reaches
 * the `settled` command (children return early), so the root's write must
 * carry the whole tree's terminals. */
function settlementTreeRuns(state: DeepReadonly<RuntimeState>, root: Run): Run[] {
  const runs: Run[] = [root]
  const walk = (run: Run): void => {
    for (const part of [0, 1] as const) {
      const child = childQueue(state.queues, state.jobs, run.id, part)
      if (child === undefined) continue
      runs.push(child)
      walk(child)
    }
  }
  walk(root)
  return runs
}

/** The admission plan: the declared plan up to (excluding) the first merge —
 * the checks a revision must pass before it may enter a Queue run. */
function admissionSteps(steps: readonly RuntimeStep[]): RuntimeStep[] {
  const selected = declaredDefaultSteps(steps)
  const boundary = selected.findIndex((step) => step.kind === "merge")
  return boundary < 0 ? selected : selected.slice(0, boundary)
}

function samePlan(actual: readonly DeepReadonly<InstalledStep>[], expected: readonly RuntimeStep[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((step, index) => {
      const candidate = expected[index]
      return (
        candidate !== undefined &&
        step.name === candidate.name &&
        step.revision === candidate.revision &&
        step.kind === candidate.kind &&
        step.classification === candidate.classification
      )
    })
  )
}

function unstartedAdmission(
  run: DeepReadonly<Run>,
  queues: DeepReadonly<QueuesState>,
  steps: readonly RuntimeStep[],
): boolean {
  return (
    run.stepSelection?.authority === "admission" &&
    samePlan(run.steps, admissionSteps(steps)) &&
    run.steps.every((step) => step.job === undefined || step.job.status === "queued")
  )
}

function admissionRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<ChangeSnapshot>,
  selected: readonly RuntimeStep[],
): Run | undefined {
  const id = latestExactRunId(state.queues.index, snapshot, selected)
  const record = id === undefined ? undefined : Queues.get(state.queues, id)
  return record === undefined ? undefined : materializeRun(record, state.jobs)
}

function checkFactRun(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<ChangeSnapshot>,
  selected: readonly RuntimeStep[],
): Run | undefined {
  const id = latestPrefixRunId(state.queues.index, snapshot, selected)
  const record = id === undefined ? undefined : Queues.get(state.queues, id)
  return record === undefined ? undefined : materializeRun(record, state.jobs)
}

/**
 * Run-level checks status: a pure fold of {@link checkStatus} over the selected
 * step prefix — "passed" only when every selected step passed, "failed" as soon
 * as any step failed, "checking" otherwise. An empty selection folds to
 * "passed" (vacuous truth), exactly as the ladder it replaced did.
 *
 * This function holds NO ladder of its own (5a: one derivation per fact). It
 * used to: a second ladder here consulted `Queues.failed` LAST while the
 * per-step ladder consulted it FIRST, and the two only agreed because a
 * completed job is exactly a succeeded-or-failed one. The old trailing
 * `Queues.failed(run)` consult is subsumed: inside {@link checkStatus} a failed
 * run settles every step without a terminal outcome as "failed", so no
 * selected step of a failed run can fold to "checking".
 *
 * Exported for the tests that pin the fold (check-status-ladder.test.ts).
 */
export function checkRunStatus(run: Run, selectedCount: number): ChangeEligibility["checks"]["status"] {
  const statuses = run.steps.slice(0, selectedCount).map((step) => checkStatus(step.job, run))
  if (statuses.every((status) => status === "passed")) return "passed"
  return statuses.includes("failed") ? "failed" : "checking"
}

const AUTOMATIC_ADMISSION_RETRIES = 1
function automaticAdmissionAttemptsExhausted(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  snapshot: DeepReadonly<ChangeSnapshot>,
  selected: readonly RuntimeStep[],
): boolean {
  const exactRequests = pr.checkRequests.filter(
    (request) =>
      request.revision === snapshot.revision &&
      request.headSha === snapshot.headSha &&
      (request.baseSha ?? changeBaseSha(pr)) === snapshot.baseSha,
  ).length
  if (exactRequests === 0) return false
  const releasedFailures = releasedAdmissionFailures(state.queues.index, snapshot, selected)
  return releasedFailures >= exactRequests + AUTOMATIC_ADMISSION_RETRIES
}

function admissionQueue(
  state: DeepReadonly<RuntimeState>,
  steps: readonly RuntimeStep[],
  targets?: ReadonlySet<string>,
  derived: readonly DeepReadonly<Change>[] = [],
): Change[] {
  const selected = admissionSteps(steps)
  if (selected.length === 0) return []
  // The population is the compose's derived batch: a member's materialized value
  // answers `submitted` with a standing check request for exactly the submit
  // sha, and its verdict evidence lives in the admission Jobs.
  //
  // Two record-lane filters are deleted here, and this is a BUG FIX, not just a
  // simplification. Both asked whether a STORED admission verdict retired the
  // member from this queue: one keyed the `needs-author` re-entry on
  // `changeAdmission`, the other retired a passed/refused verdict outright.
  // `recordRevisionAdmission` stopped writing that verdict, so neither could
  // ever fire again — and they were the record lane's ONLY exits from
  // `drainAdmissions`' `while (targets.size > 0)` loop. Measured before this
  // change: a journal seeded with pr/pushed + pr/submitted + pr/checks-requested
  // spun that loop 1389 times in 369ms with zero state delta, admitting the same
  // member forever and never yielding to a timer. The eligibility exit below —
  // the derived lane's, previously reachable only for recordless members — is
  // now the single exit for every member, and it is the one that terminates.
  return [...derived]
    .filter((pr) => targets === undefined || targets.has(pr.id))
    .filter((pr) => {
      const delivery = changeDeliveryState(pr)
      return delivery === "pushed" || delivery === "submitted" || delivery === "ready"
    })
    .filter((pr) => blockingQueuePause(state, pr) === undefined)
    .filter((pr) => checksRequested(pr))
    .filter((pr) => {
      const refusal = state.queues.admissionRefusals[pr.id]
      if (refusal?.settlement === undefined) return true
      const revision = currentChangeRev(pr)
      return refusal.revision !== revision.n || refusal.headSha !== revision.head
    })
    .filter((pr) => {
      // No stored admission verdict ever retires a member from this queue — its
      // verdict lives in the admission Jobs. Keep it only while its checks are
      // unattempted: passed retires it, failed requires a re-push (the retry
      // act — git CAS, per-push consent), checking is already dispatched.
      // Without this exit the drain loop re-admits the same member forever.
      return checkEligibility(state, pr, steps).status === "queued"
    })
    .filter((pr) => {
      const snapshot = Queues.snapshot(pr)
      const run = admissionRun(state, snapshot, selected)
      if (run === undefined) return true
      return (
        checkRunStatus(run, selected.length) === "failed" &&
        availableAuthorityToken(state.queues.authority.checks[pr.id], snapshot) &&
        !automaticAdmissionAttemptsExhausted(state, pr, snapshot, selected)
      )
    })
    .toSorted((left, right) => {
      const leftAt = queueProgressTime(left)
      const rightAt = queueProgressTime(right)
      return leftAt.localeCompare(rightAt) || compareNatural(left.id, right.id)
    })
}

/** The one queue ordering clock, and it is TOTAL: check-request time when the
 * current revision has one, first source-ready time otherwise. Every sort over
 * a queue population uses this. Its throwing sibling (`checkQueueTime`) treated
 * "queued with no current check request" as impossible, but the writers can
 * legitimately leave that state behind — a refused `bay submit` did on
 * 2026-08-16 (PR1128), and the throw then took down every command that loads
 * queue state, including `queue recover`, the tool that repairs exactly this
 * shape. A comparator is never the place to assert an invariant: the audit
 * names the state (`queue-never-started`) instead. */
function queueProgressTime(pr: DeepReadonly<Change>): string {
  return checkRequest(pr)?.at ?? changeSourceReadyAt(pr)
}

/**
 * The one published queue order, and the only thing `position` may be derived
 * from. It ranks by check-request time exactly as `admissionQueue` does, so the
 * number a change reads predicts the order admission actually runs in rather than
 * restating submit order, which admission has not followed since check requests
 * became the thing it consumes.
 *
 * Membership stays broader than `admissionQueue`: every change the queue holds gets
 * a position, including the ones a pause or a settled admission currently keeps
 * out of the next pass. A position is where you stand in the queue, not a claim
 * that the next pass will take you.
 */
/**
 * The standing queue population, for the READ surfaces — the published
 * admission order and the position `eligibility` reports.
 *
 * S7: a member is published under the id its retained run snapshot carries. The
 * record population this replaces was ordered by the same clock, so the order
 * is unchanged in meaning — the order the facts were approved in.
 *
 * GAP, stated rather than silently dropped: a branch whose fact stands but
 * which NO compose has admitted yet holds no position here, because it has no
 * id. Reading the queue must not commit the PR-number mint (commit-before-escape
 * is a write, and a number burned on a status read would never appear in a run),
 * and the branch cannot stand in as the id — `QueueMemberIdSchema` is a journal
 * replay schema admitting only `PRnnn` and the historical intent forms. Such a
 * branch is visible as an `unrecorded-submit` audit finding instead. Closing it
 * needs a ruling on what identity an un-composed member publishes.
 */
function standingLaneMembers(state: DeepReadonly<RuntimeState>): Change[] {
  return Object.keys(state.bays.submits).flatMap((branch): Change[] => {
    const snapshot = latestChangeSnapshot(state.queues as QueuesState, (member) => member.branch === branch)
    const composed = snapshot === undefined ? undefined : materializeSnapshotMember(state.bays, snapshot)
    return composed === undefined ? [] : [composed]
  })
}

function admissionOrderChanges(state: DeepReadonly<RuntimeState>): Change[] {
  return standingLaneMembers(state).toSorted(
    (left, right) =>
      queueProgressTime(left).localeCompare(queueProgressTime(right)) || compareNatural(left.id, right.id),
  )
}

/** This PR's one-based place in the published queue order; absent when it holds none. */
function admissionPosition(state: DeepReadonly<RuntimeState>, pr: string): number | undefined {
  const index = admissionOrderChanges(state).findIndex((candidate) => candidate.id === pr)
  return index < 0 ? undefined : index + 1
}

/** Members refused at required checks and awaiting their author.
 *
 * Empty since S7, and structurally so: this read a RECORD's `needs-author`
 * delivery plus its stored refusal verdict, and neither is written any more —
 * `recordRevisionAdmission` is a no-op and there is no record to carry the
 * delivery state. A refused member's durable trace is the admission-refusal
 * ledger (`queues.admissionRefusals`), and its retry act is a re-push, so
 * nothing re-enters the compose through this path. */
function refusedRevisionAdmissions(state: DeepReadonly<RuntimeState>): Change[] {
  void state
  return []
}

function blockingQueuePause(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
): DeepReadonly<QueuePause> | undefined {
  const pause = state.queues.pauses[baseIdentity(pr.base)]
  return pause === undefined || pause.allowedPRs.includes(pr.id) ? undefined : pause
}

function hasFreshRevisionCheckAuthority(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  steps: readonly RuntimeStep[],
): boolean {
  const request = checkRequest(pr)
  const baseSha = request?.baseSha ?? changeBaseSha(pr)
  if (baseSha === undefined) return false
  const tally = revisionCheckRequestTally(pr, baseSha)
  const consumed = consumedCheckAuthorities(changeAdmission(pr), baseSha)
  // Neither side of the comparison may be invented. An unresolved tally means
  // some request's base is unreadable, and an unresolved record means the
  // verdict was written from such a tally: in both cases the number of
  // authorities this tree holds against this base is unknown, and "unknown" is
  // not "more than were spent". Granting a retry here would let an unreadable
  // request re-run the queue on every pass; refusing one leaves the carrier
  // exactly where its last verdict put it, with the unresolved fact recorded on
  // that verdict for whoever reads it next
  // (@yrd/core/rebuilt-carrier-denied-retry).
  if (tally.status === "unresolved" || consumed === "unresolved") return false
  const attempts = Math.max(
    consumed,
    ...(currentRevisionAdmissionJobs(state, pr, steps) ?? []).map((job) => job?.attempt ?? 0),
  )
  return tally.count > attempts
}

/** Check authorities a recorded verdict already spent against `baseSha`. */
function consumedCheckAuthorities(
  admission: DeepReadonly<ChangeAdmission> | undefined,
  baseSha: string,
): number | "unresolved" {
  if (admission?.baseSha !== baseSha) return 0
  // Absent is the legacy shape, written before the counter existed; such a
  // verdict spent exactly one authority. Zero and "unresolved" are both facts a
  // producer wrote deliberately and neither may be read as the other.
  return admission.requestCount ?? 1
}

type RevisionCheckRequestTally =
  | Readonly<{ status: "counted"; count: number }>
  | Readonly<{ status: "unresolved"; unreadable: number }>

/**
 * How many check authorities this change's CURRENT TREE holds against `baseSha`.
 *
 * Identity is the head, matching {@link checkRequest}, and deliberately NOT the
 * revision ordinal. `303e7845` removed the ordinal from `checkRequest` because a
 * request asks "check this tree" and the ordinal identifies nothing about the
 * tree: a mechanical rebuild merges on byte-identical content and mints a new
 * ordinal while the head, and so the meaning of every request already recorded,
 * is unchanged. This counter kept the ordinal, so the two disagreed about what
 * a request IS. A byte-identical rebuild then read zero authorities for work
 * that demonstrably ran, and the carrier it belonged to was denied the retry it
 * had just earned (@yrd/core/rebuilt-carrier-denied-retry).
 *
 * `baseSha` stays in the match for the opposite reason: it is a PARAMETER being
 * counted over rather than part of the identity. The question this answers is
 * "against THIS base", and a request whose base differs answers it with no.
 *
 * A request that records no base, on a revision that records none either, is
 * the one candidate whose base cannot be determined — it can neither be counted
 * nor ruled out. That is reported as `unresolved` rather than quietly dropped
 * from the total, because a shortfall indistinguishable from "no authority was
 * granted" is exactly what denies a carrier its retry.
 */
function revisionCheckRequestTally(pr: DeepReadonly<Change>, baseSha: string): RevisionCheckRequestTally {
  const revision = currentChangeRev(pr)
  const forThisTree = pr.checkRequests.filter((candidate) => candidate.headSha === revision.head)
  const unreadable = forThisTree.filter(
    (candidate) => candidate.baseSha === undefined && changeBaseSha(pr) === undefined,
  ).length
  if (unreadable > 0) return { status: "unresolved", unreadable }
  return {
    status: "counted",
    count: forThisTree.filter((candidate) => (candidate.baseSha ?? changeBaseSha(pr)) === baseSha).length,
  }
}

/** The tally as a recordable fact, keeping `unresolved` distinct from zero. */
function recordedRequestCount(tally: RevisionCheckRequestTally): number | "unresolved" {
  return tally.status === "counted" ? tally.count : "unresolved"
}

function checkEligibility(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  steps: readonly RuntimeStep[],
): ChangeEligibility["checks"] {
  const request = checkRequest(pr)
  const timing = request === undefined ? {} : { queuedAt: request.at }
  const selected = admissionSteps(steps)
  if (selected.length === 0) return { status: "passed", ...timing }
  const admission = changeAdmission(pr)
  const requestedBase = request?.baseSha ?? changeBaseSha(pr)
  const matchesAdmission =
    admission !== undefined &&
    requestedBase !== undefined &&
    admission.baseSha === requestedBase &&
    admission.steps.every(
      (evidence, index) => evidence.name === selected[index]?.name && evidence.revision === selected[index]?.revision,
    )
  if (
    matchesAdmission &&
    admission.status === "passed" &&
    admission.steps.length === selected.length &&
    selected.every((step) => step.classification !== "base")
  ) {
    return { status: "passed", ...timing }
  }
  if (matchesAdmission && admission.status === "refused") return { status: "failed", ...timing }
  const run = checkFactRun(state, Queues.snapshot(pr), selected)
  if (run !== undefined) return { status: checkRunStatus(run, selected.length), ...timing, run: run.id }
  const admissionJobs = currentRevisionAdmissionJobs(state, pr, steps)
  if (admissionJobs !== undefined) {
    if (admissionJobs.some((job) => job?.status === "in_progress" || job?.status === "waiting")) {
      return { status: "checking", ...timing }
    }
    if (admissionJobs.some((job) => job !== undefined && jobFailed(job))) return { status: "failed", ...timing }
    if (
      admissionJobs.length === selected.length &&
      admissionJobs.every((job) => job !== undefined && jobSucceeded(job))
    ) {
      return { status: "passed", ...timing }
    }
  }
  if (request === undefined) return { status: "not-requested" }
  // Only an open delivery can hold a live admission slot — the same predicate
  // `admissionQueue` filters on. Check requests are append-only history, so a
  // withdrawn/canceled/integrated change keeps its `queuedAt` fact while its status
  // stops claiming a slot the queue can never run. `admissionQueue` already
  // excludes it, but that exclusion only ever reached `position`, never
  // `status`. Runs that actually executed are settled above and survive: they
  // are recorded facts, not a claim about a live slot. (22390)
  const delivery = changeDeliveryState(pr as Change)
  if (delivery !== "pushed" && delivery !== "submitted" && delivery !== "ready") {
    return { status: "not-requested", ...timing }
  }
  // One derivation, shared with `admissionOrder()`. Ranking the admission queue
  // separately here is what let a single response report two positions for one
  // PR — the two lists neither hold the same members nor rank them the same way.
  const position = admissionPosition(state, pr.id)
  return { status: "queued", ...timing, ...(position === undefined ? {} : { position }) }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstArtifact(value: unknown, preferredName?: string): string | undefined {
  const artifacts = objectValue(value)?.artifacts
  if (!Array.isArray(artifacts)) return undefined
  const ordered =
    preferredName === undefined
      ? artifacts
      : artifacts.toSorted((left, right) => {
          const leftPreferred = objectValue(left)?.name === preferredName
          const rightPreferred = objectValue(right)?.name === preferredName
          return Number(rightPreferred) - Number(leftPreferred)
        })
  for (const artifact of ordered) {
    const item = objectValue(artifact)
    const location = item?.path ?? item?.uri
    if (typeof location === "string" && location !== "") return location
  }
  return undefined
}

function checkEvidence(job: Job): Record<string, unknown> | undefined {
  if (job.status === "completed" && job.conclusion === "success") return objectValue(job.output)
  if (job.status === "completed" && job.conclusion === "failure") {
    const output = objectValue(job.output)
    if (output !== undefined) return output
    const refusal = objectValue(job.error.evidence)
    if (refusal === undefined) return undefined
    const candidate = objectValue(refusal.candidateEvidence)
    const parent = objectValue(refusal.parent)
    return refusal.phase === "parent" ? (parent ?? candidate ?? refusal) : (candidate ?? parent ?? refusal)
  }
  if (job.status === "waiting") return objectValue(job.checkpoint)
  return undefined
}

function checkError(job: Job | undefined, run: Run): JobError | undefined {
  if (job?.status === "completed" && job.conclusion !== "success") return jobFailure(job)
  return run.error
}

/**
 * THE check-status tie-break ladder — the one place the priority between a
 * step's own job outcome and its run's failure is written (5a: one derivation
 * per fact). The rule, in priority order:
 *
 * 1. A terminal job outcome is the strongest fact. A completed job reads
 *    "passed" on success and "failed" on any other conclusion, and no
 *    run-level signal overrides either. (Terminal ⇔ completed ⇔ exactly one
 *    of succeeded/failed, so the run-failure guard below never shadows a
 *    terminal outcome.)
 * 2. A failed RUN settles every step with no terminal outcome of its own —
 *    job absent, queued, in progress, or waiting reads "failed", never
 *    "checking": the run's failure is the reason the step will not finish.
 * 3. Otherwise the step is still "checking".
 *
 * {@link checkRunStatus} is a pure fold of this ladder — it holds no ladder of
 * its own, so the per-step and run-level surfaces cannot disagree on a tie.
 * Exported for the tests that pin this rule (check-status-ladder.test.ts).
 */
export function checkStatus(job: Job | undefined, run: Run): ChangeCheckRecord["status"] {
  if (Queues.failed(run) && (job === undefined || !Job.terminal(job))) return "failed"
  if (job !== undefined && jobSucceeded(job)) return "passed"
  if (job !== undefined && jobFailed(job)) return "failed"
  return "checking"
}

function projectCheckStep(
  pr: DeepReadonly<Change>,
  run: Run,
  step: QueueStep,
  queuedAt: string | undefined,
): ChangeCheckRecord | undefined {
  const job = step.job
  if (job === undefined && !Queues.failed(run)) return undefined
  const evidence = job === undefined ? undefined : checkEvidence(job)
  const error = checkError(job, run)
  const diagnostics =
    Array.isArray(evidence?.diagnostics) || typeof evidence?.detail === "string"
      ? ((evidence?.diagnostics ?? evidence?.detail) as JsonValue)
      : job?.status === "waiting" && job.detail !== undefined
        ? job.detail
        : error?.message
  const artifact =
    firstArtifact(evidence, error === undefined ? undefined : "stderr") ??
    (job !== undefined && "artifacts" in job
      ? firstArtifact({ artifacts: job.artifacts }, error === undefined ? undefined : "stderr")
      : undefined)
  const command = Array.isArray(evidence?.command)
    ? evidence.command.filter((part): part is string => typeof part === "string")
    : job === undefined
      ? [`queue.step.${step.name}`]
      : [job.definition]
  return {
    pr: pr.id,
    revision: changeRevisionNumber(pr),
    run: run.id,
    step: step.name,
    status: checkStatus(job, run),
    classification: step.classification ?? "carrier",
    command,
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(error === undefined ? {} : { error }),
  }
}

function projectRevisionAdmissionJobs(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  steps: readonly RuntimeStep[],
  queuedAt: string | undefined,
): ChangeCheckRecord[] | undefined {
  const selected = admissionSteps(steps)
  const jobs = currentRevisionAdmissionJobs(state, pr, steps)
  if (jobs === undefined) return undefined
  return selected.map((step, index) => {
    const job = jobs[index]
    if (job === undefined) {
      return {
        pr: pr.id,
        revision: changeRevisionNumber(pr),
        step: step.name,
        status: "queued",
        classification: step.classification ?? "carrier",
        command: [`queue.step.${step.name}`],
        ...(queuedAt === undefined ? {} : { queuedAt }),
      }
    }
    const evidence = checkEvidence(job as Job)
    const error = jobFailed(job as Job) ? jobFailure(job as Job) : undefined
    const diagnostics =
      Array.isArray(evidence?.diagnostics) || typeof evidence?.detail === "string"
        ? ((evidence?.diagnostics ?? evidence?.detail) as JsonValue)
        : job.status === "waiting" && job.detail !== undefined
          ? job.detail
          : error?.message
    const artifact = firstArtifact(evidence, error === undefined ? undefined : "stderr")
    const status: ChangeCheckRecord["status"] =
      job.status !== "completed"
        ? job.status === "queued"
          ? "queued"
          : "checking"
        : job.conclusion === "success"
          ? "passed"
          : "failed"
    return {
      pr: pr.id,
      revision: changeRevisionNumber(pr),
      job: job.id,
      step: step.name,
      status,
      classification: step.classification ?? "carrier",
      command: [job.definition],
      ...(queuedAt === undefined ? {} : { queuedAt }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(artifact === undefined ? {} : { artifact }),
      ...(error === undefined ? {} : { error }),
    }
  })
}

function currentRevisionAdmissionJobs(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  steps: readonly RuntimeStep[],
): readonly (DeepReadonly<Job> | undefined)[] | undefined {
  const request = checkRequest(pr)
  const baseSha = request?.baseSha ?? changeBaseSha(pr) ?? derivedAdmissionBaseSha(state, pr)
  if (baseSha === undefined) return undefined
  const snapshot = pinCandidateBaseSha([Queues.snapshot(pr)], baseSha)[0]
  if (snapshot === undefined) return undefined
  const jobs = admissionSteps(steps).map((step, index) => {
    const id =
      state.jobs.byKey[admissionJobKey(snapshot, baseSha, index, step.revision)] ??
      state.jobs.byKey[admissionJobKey(snapshot, baseSha, index)]
    return id === undefined ? undefined : state.jobs.byId[id]
  })
  return jobs.every((job) => job === undefined) ? undefined : jobs
}

/**
 * The base a DERIVED member's admission actually ran against. A derived
 * member's synthetic check request records no base — its authority is the
 * live submit fact, pinned by sha, and admission pins the CYCLE base at
 * dispatch time — so the verdict is recovered from the admission Job keys for
 * this member revision (the revision ordinal is minted per push, so those
 * jobs are exactly this tree's). When the base moved between dispatches the
 * newest dispatch wins, which is the same "the request whose base is current"
 * rule the record lane's `checkRequest` applies.
 */
function derivedAdmissionBaseSha(state: DeepReadonly<RuntimeState>, pr: DeepReadonly<Change>): string | undefined {
  const prefix = admissionRevisionKeyPrefix(pr.id, changeRevisionNumber(pr))
  let newest: Readonly<{ baseSha: string; job: string }> | undefined
  for (const [key, job] of Object.entries(state.jobs.byKey)) {
    if (!key.startsWith(prefix)) continue
    const baseSha = key.slice(prefix.length).split(":")[0]
    if (baseSha === undefined || baseSha.length === 0) continue
    if (newest === undefined || compareNatural(job, newest.job) > 0) newest = { baseSha, job }
  }
  return newest?.baseSha
}

function reusableRevisionAdmission(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<ChangeSnapshot>[],
  selected: readonly RuntimeStep[],
): Readonly<{ count: number; shape: ChangeShape }> | undefined {
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot?.baseSha === undefined) return undefined
  const boundary = selected.findIndex((step) => step.kind === "merge")
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0 || prefix.some((step) => step.classification === "base")) return undefined
  // Reuse only when a merge step REMAINS. A fully-covered plan would return the
  // zero-event reuse-covered no-op, and a member's identity's only durable home
  // is the run/started snapshot — the minted number would escape nowhere and
  // burn, and the next compose would re-derive and mint again. A check-only plan
  // therefore executes its steps inside the run it must start anyway.
  //
  // The record-backed arm this replaces read a STORED admission verdict off the
  // change. Nothing writes one (`recordRevisionAdmission` is a no-op) and there
  // is no record to read, so every reuse now comes from the admission Jobs.
  if (boundary < 0) return undefined
  return derivedRevisionAdmissionReuse(state, snapshot, snapshot.baseSha, prefix)
}

/**
 * The DERIVED half of {@link reusableRevisionAdmission}: a recordless member's
 * admission verdict lives ONLY in its standalone admission Jobs —
 * `recordRevisionAdmission` deliberately skips the record-side copy — so the
 * record-backed read above can never see it, and every derived root run
 * re-executed the admission prefix its own drain had just run, invoking each
 * pre-merge step callback twice per admission. Same contract as the record
 * read: every pre-merge step of the plan, completed successfully at exactly
 * this pinned base, with its output present to seed the run's shape; anything
 * less reuses nothing.
 */
function derivedRevisionAdmissionReuse(
  state: DeepReadonly<RuntimeState>,
  snapshot: DeepReadonly<ChangeSnapshot>,
  baseSha: string,
  prefix: readonly RuntimeStep[],
): Readonly<{ count: number; shape: ChangeShape }> | undefined {
  const results: Record<string, JsonValue> = {}
  for (const [index, step] of prefix.entries()) {
    const id =
      state.jobs.byKey[admissionJobKey(snapshot, baseSha, index, step.revision)] ??
      state.jobs.byKey[admissionJobKey(snapshot, baseSha, index)]
    const job = id === undefined ? undefined : (state.jobs.byId[id] as Job | undefined)
    if (job === undefined || !jobSucceeded(job) || job.output === undefined) return undefined
    results[step.name] = job.output
  }
  return { count: prefix.length, shape: { results } }
}

function reusablePrefix(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly DeepReadonly<ChangeSnapshot>[],
  selected: readonly RuntimeStep[],
): Readonly<{ run: RunId; count: number; shape: ChangeShape }> | undefined {
  const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
  if (snapshot?.baseSha === undefined) return undefined
  const boundary = selected.findIndex((step) => step.kind === "merge")
  const prefix = boundary < 0 ? selected : selected.slice(0, boundary)
  if (prefix.length === 0 || prefix.some((step) => step.classification === "base")) return undefined
  const cached = admissionRun(state, snapshot, prefix)
  if (cached === undefined || !Queues.succeeded(cached)) return undefined
  const record = Queues.record(state.queues, cached.id)
  return { run: cached.id, count: prefix.length, shape: shapeThrough(record, state.jobs) }
}

type RunnableChangeDecision = Readonly<{ pr: Change; eligibility: ChangeEligibility }>

function runnableChangeSelection(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
  needsPersonOwner: string,
  excluded: ReadonlySet<string> = new Set(),
  options: Readonly<{ explicitStepAuthority?: boolean; implicitBefore?: QueuePosition }> = {},
): Readonly<{ prs: Change[]; decisions: RunnableChangeDecision[] }> {
  const requested = requestedPRs(state.bays, args, excluded, options.implicitBefore)
  const implicitQueue = args.prs === undefined || args.prs.length === 0
  const ignoredClaims = new Set(
    options.explicitStepAuthority === true
      ? activeQueueRuns(state.queues, state.jobs)
          .filter((run) => unstartedAdmission(run, state.queues, steps))
          .map((run) => run.id)
      : [],
  )
  const decisions = requested.map((pr) => ({
    pr,
    eligibility: ChangeEligibility(state, pr, steps, needsPersonOwner, {
      resumeIntegrated: true,
      ignoreChecks: options.explicitStepAuthority,
      ignoredClaims,
    }),
  }))
  const prs = decisions.flatMap(({ pr, eligibility }) => {
    if (eligibility.runnable) return [pr]
    if (implicitQueue || (eligibility.reason?.code === "claimed" && options.explicitStepAuthority !== true)) {
      return []
    }
    const reason = eligibility.reason
    raiseFailure(
      "refusal",
      reason?.code ?? "pr-not-ready",
      `yrd: ${reason?.message ?? `change '${pr.id}' is not ready`}`,
    )
  })
  return { prs, decisions }
}

function runnablePRs(
  state: DeepReadonly<RuntimeState>,
  args: QueueRunArgs,
  steps: readonly RuntimeStep[],
  needsPersonOwner: string,
  excluded: ReadonlySet<string> = new Set(),
  options: Readonly<{ explicitStepAuthority?: boolean; implicitBefore?: QueuePosition }> = {},
): Change[] {
  return runnableChangeSelection(state, args, steps, needsPersonOwner, excluded, options).prs
}

/**
 * How every `candidateFailure(...)` code produced by command.ts is handled.
 * Each such code must fall in EXACTLY ONE bucket — the partition is asserted by
 * composition-failure-buckets.test.ts, which grep-derives the candidateFailure
 * code set from command.ts so a NEW unclassified code reddens by construction.
 *
 * - needs-author: the queue cannot build the candidate from what the author
 *   submitted; the author must re-author (fix the composition, push a
 *   gitlink-free root, correct a declared source range or payload).
 * - infra-retry: the queue's own machinery, never the submitted branch — a git
 *   push / update-ref that can fail on a network/remote blip, scratch cleanup,
 *   or a composition that built a candidate the merge floor refuses. Retried
 *   with backoff by the env-storm path (21622 condition 4); never routed to the
 *   author. The cure is always another composition, so the retry is the remedy.
 * - plain-rejected: an ordinary failure with no composition meaning — no
 *   author-blame routing and no auto-retry; the operator re-evaluates. The
 *   intent-* codes live here because a stale evaluation is cured by
 *   re-evaluating the intent, which neither re-authoring nor retrying does.
 */
export const COMPOSITION_FAILURE_BUCKETS = {
  "needs-author": new Set<string>([
    "authored-gitlink",
    "carrier-drops-landed",
    // The declared component-model change (an add or remove ruling, carried
    // as a --prop) was evaluated and REFUSED — a decision was reached, and
    // it's the author's to act on: get a different ruling, or carry the
    // right prop. Pre-existing, unclassified gap (re-merge Phase 1: found
    // while adding `min-commit-unpublished` below). Its two unavailable-
    // capability siblings are NOT here — see `infra-retry` below; bouncing an
    // unavailable host capability to the author is exactly the "authority
    // must survive a refusal that is not the author's fault" violation this
    // phase's own bead names.
    "component-model-authorization-refused",
    // A certificate-era composed revision reaching candidate construction:
    // the composed path is retired; the author resubmits the root change with
    // its gitlink bumps.
    "composition-retired",
    // All three read the branch's authored delta base, and all are cured the
    // same way `gitlink-inspection` is: the author restores readable history.
    "contribution-inspection",
    "deletion-inspection",
    // The merge kept only one parent's version of a contested file. The remedy
    // is the author's own merge of the current base, which makes the
    // resolution a reviewable diff instead of one resolved against a virtual
    // base.
    "dropped-parent-contribution",
    "gitlink-inspection",
    // The author's gitlink is a min commit, never a value — the shaset fill-in
    // needs it reachable from the submodule's own main before it can compute
    // the final value. Re-merge Phase 1's own refusal (the shaset model's
    // stated precondition, given its own code per the Phase 0 design call
    // rather than folding into the broader `authored-gitlink`).
    "min-commit-unpublished",
    "refused-path",
    "refused-path-inspection",
    // Same remedy as `dropped-parent-contribution`; only the instrument that
    // caught the lost merge differs.
    "unauthored-path-deletion",
    "wrapper-mismatch",
    "payload-certificate",
  ]),
  "infra-retry": new Set<string>([
    "carrier-inspection",
    // The composition-time fill-in could not resolve a submodule's main —
    // a fetch/probe blip, cured by retrying, exactly as the same code is
    // treated on the merge path's release ladder.
    "component-main-inspection-failed",
    // The merge floor caught a candidate whose tree predates work already on
    // the base. The submitted branches are blameless — nothing they authored
    // deletes those paths — so this must never present as needs-author; a fresh
    // composition against the current base is the whole remedy.
    "merge-unauthored-deletion",
    "scratch-cleanup-failed",
    "wrapper-generation",
    // This Yrd HOST has no verdict-message resolver wired up, or cannot
    // compute a patch-bound authorization identity (no immutable base SHA, no
    // stable patch identity for the diff) — a host-capability gap, not a fact
    // about the author's content. Reclassified out of `needs-author` (re-merge
    // Phase 1, on review): that bucket bounces the refusal to the author as
    // if THEIR request were wrong, when the host is what's missing the
    // capability. Neither is truly "retry and it clears itself" like this
    // bucket's other members, but this is the closer of the two available
    // buckets, and the alternative — needs-author — is the one the bundling
    // review specifically ruled out as the finding-5 violation.
    "component-model-authorizer-unavailable",
    "component-model-identity-unavailable",
  ]),
  "plain-rejected": new Set<string>(["intent-base-moved", "intent-batch-refused", "intent-component-unknown"]),
} as const

const NEEDS_AUTHOR_CODES: ReadonlySet<string> = COMPOSITION_FAILURE_BUCKETS["needs-author"]

/**
 * Every failure/refusal code `@yrd/cli`'s `failureDisposition` (in
 * status-presentation.ts) must classify, in ONE authoritative place — the
 * `YRD_QUEUE_AUDIT_FINDING_CODES` pattern applied to the OTHER durable code
 * vocabulary this codebase has, so a code nobody registered turns into a
 * thrown error instead of a silent `{ state: "failed", owner: "author" }`
 * default (measured cost: `checkpoint-migration-certificate-missing`, an
 * infra refusal, billed the author and consumed a submit authority).
 *
 * Curated, not a raw grep dump: `code: "..."` object literals across
 * `packages/*\/src`, unioned with every DIRECT `JobResult.error.code`
 * constructor at the same confidence tier — `candidateFailure(code, …)` in
 * command.ts and its sibling `failed(code, …)` / `failedWithEvidence(code, …)`
 * (both return `{ status: "completed", conclusion: "failure", error: { code,
 * message } }` outright, no indirection) — plus every
 * {@link COMPOSITION_FAILURE_BUCKETS} member (folded in WHOLE, not just the
 * `needs-author`/`infra-retry` buckets `failureDisposition` already reads —
 * `plain-rejected` reaches it the identical way and was silently defaulting
 * too; the former `recut-lineage` bucket went with the certificate machinery
 * in re-merge Phase 1). A handful of spelling duplicates this codebase
 * already tolerated ad hoc — see {@link YRD_REFUSAL_CODE_ALIASES} — are
 * collapsed to ONE canonical spelling each rather than counted as independent
 * codes, so this list is the DISTINCT-CONCEPT count, not a raw literal census.
 * (`stale-base` and `check-failed` — both `failed()`-only, no `code: "..."`
 * literal anywhere — are the reason this union matters: an object-literal-only
 * census silently misses live producers.)
 *
 * Deliberately NOT exhaustive over every `raiseFailure()` call in `@yrd/cli`
 * (run.ts, host.ts and siblings raise ~230 more distinct codes): most are
 * CLI-invocation-time refusals (usage/configuration kind, caught by
 * invocation.ts and rendered through actionable-error.ts, never becoming a
 * persisted Run/Job failure). A demonstrated few DO cross over — host.ts's
 * required-check and checkpoint-migration infra codes are forwarded into a
 * `JobError.code` by the three `fact?.code ?? ...` catches wrapping required-
 * check execution in command.ts — closing that surface needs its own call-
 * graph trace and is deliberately left for a follow-up, not folded in here
 * unverified.
 */
export const YRD_REFUSAL_CODES = [
  "admission-refusal-loop",
  "admission-refusal-needs-person",
  "admission-refused",
  "artifact-root-unresolved",
  "attempt-base-mismatch",
  "attempt-pin-mismatch",
  "authored-gitlink",
  // No current producer constructs the bare form — kept because
  // CANCELED_FAILURE_CODES already accepted it (historical/external data);
  // "cancelled" registers as its alias below.
  "canceled",
  // Admission's containment park (queue re-entry of landed content): the
  // candidate the preparer returned IS the base, so checks would judge a
  // degenerate base-vs-base range. Structurally permanent — see
  // STRUCTURALLY_PERMANENT_ADMISSION_REFUSALS.
  "candidate-already-landed",
  "candidate-conflict",
  "candidate-conflicting",
  // `failed()`-only, like `stale-base` below: command.ts's pinCandidate returns
  // this as a durable JobResult error when the candidate ref cannot be pinned.
  // Its sibling `candidate-ref-refused` is the same family's WAITING branch and
  // never a failure code — only this arm reaches a JobError.
  "candidate-ref-invalid",
  "candidate-ref-refused",
  "candidate-submodules-failed",
  "carrier-drops-landed",
  "carrier-inspection",
  "check-definition-missing",
  // The generic required-check catch-all `failed()` emits in command.ts —
  // no bucket of its own, always the plain default disposition. Load-bearing
  // for status-presentation.test.ts.
  "check-failed",
  "checking",
  "checkpoint-migration-certificate-missing",
  "checkpoint-migration-certificate-stale",
  "checkpoint-migration-path-ambiguous",
  "checkpoint-migration-path-cyclic",
  "checkpoint-migration-path-missing",
  "checks-pending",
  "claimed",
  "command-refused",
  "component-main-inspection-failed",
  "component-model-authorization-refused",
  "component-model-authorizer-unavailable",
  "component-model-identity-unavailable",
  // The re-merge Phase 1 retirement refusal: a certificate-era composed
  // revision reaching candidate construction (command.ts's bay submit /
  // prepareCandidateMembers paths). Also a needs-author bucket member.
  "composition-retired",
  "config-not-found",
  "config-path-invalid",
  "contribution-inspection",
  "definition-read-only",
  "deletion-inspection",
  // S6 derived-member admission (derived-admission.ts): the re-homed loud
  // edges of the retired 2b sweep. THREE of the four below still have
  // producers, and all three are author-curable in the git regime — re-push
  // the branch/submit ref, or add the Change-Id trailer. The fourth,
  // "derived-record-lane", is historical-only (see its own note). The cure
  // this comment used to offer third — "or take the record lane" — is gone
  // with the lane; derived-admission.ts says so at the one refusal that still
  // mentions it. change-id-missing now fires only for submit facts too
  // non-canonical to mint a synthetic identity from: a trailerless tip with
  // canonical facts mints (changeIdForDerivedSubmit) instead of refusing.
  "derived-change-id-missing",
  // The host's enrichment reader raises this when the submitted commit is not
  // in the repository (R2's vanished-commit edge, attributable to one branch).
  "derived-commit-vanished",
  // HISTORICAL-ONLY: the derived/record arbitration refusal, whose producer
  // went with the record store (9352d8d7). Kept for the same reason as
  // "source-publish" below — a refusal ledgered before the sweep still names
  // it, and unregistering it would make failureDisposition throw on that row.
  "derived-record-lane",
  "derived-submit-moved",
  "derived-submit-vanished",
  "dirty-base",
  "dirty-worktree",
  "draft",
  "dropped-parent-contribution",
  "evaluator-missing-result",
  "exclusive-busy",
  "gate-script-diff-failed",
  "gate-script-missing-at-base",
  "gate-script-overlay-failed",
  "gitlink-inspection",
  "heartbeat-failed",
  "installed-plan-stale",
  "intent-base-moved",
  "intent-batch-refused",
  "intent-component-unknown",
  "invalid-arguments",
  "invalid-candidate",
  "invalid-command",
  "invalid-config",
  // HISTORICAL-ONLY: the flow-module config loader raised it; the loader went
  // with flows and flow-fingerprints (f6d79e39). Invocation-time, so unlikely
  // to be persisted — kept because "unlikely" is not "cannot", and a wrong
  // delete throws in a READ path.
  "invalid-config-module",
  "invalid-run",
  "job-canceled",
  "job-lease-expired",
  "job-lost",
  "job-skipped",
  "journal-busy",
  "journal-version-skew",
  "legacy-quiesced",
  "merge-canceled",
  "merge-command-did-not-land",
  "merge-command-waited",
  "merge-conflict",
  "merge-failed",
  "merge-push-failed",
  "merge-record-estate-unreadable",
  "merge-record-retraction-refused",
  "merge-record-unprovable-claim",
  "merge-rollback-failed",
  "merge-unauthored-deletion",
  "merge-verification-failed",
  "min-commit-unpublished",
  // TEST-FIXTURE-ONLY narrative codes (queue-watch-round6.test.ts's fictional
  // design-review rounds) — never produced by real yrd code, registered
  // as-is rather than rewriting the fixture's illustrative choice of string.
  "mock-mismatch",
  "needs-author",
  "no-merge-authority",
  "orphaned-requested-job",
  "orphaned-run",
  "payload-certificate",
  "pin-bay-invalid",
  "pin-checkout-cleanup-failed",
  "pin-invalid",
  "pin-moved",
  "pin-ref-invalid",
  "pin-ref-mismatch",
  "pin-resolution-failed",
  "pr-not-checkable",
  // Re-merge Phase 1 turned recordProposedHead's codeCarrierRefusal
  // indirection into a direct `code:` literal (command.ts), so the census
  // sees the producer it previously missed.
  "proposed-commit-missing",
  // HISTORICAL-ONLY, both: `pr publish --queue` recorded a durable publication
  // Job, and a terminal push error persisted as its JobError.code. The verb and
  // its producers went with the record lane (612198a0 → e323f5be, b599e26d,
  // 85911630); the Job errors in journals written before that did not, and
  // runner-timeline / queue-status-view classify exactly those codes.
  "publication-failed",
  "publication-unavailable",
  "pushed-not-submitted",
  // No current producer — see "canceled" above; "queue-cancelled" registers
  // as its alias below.
  "queue-canceled",
  "queue-environment-refused",
  "queue-hold-expired",
  "queue-hold-ttl-missing",
  "queue-never-started",
  "queue-only-merger",
  "queue-paused",
  "queue-progress-stalled",
  "queue-read-boundary-moved",
  // S6 door: both retired mint arms (bay intake + submit) refuse with this one
  // code when a live submit fact owns the branch and no record does.
  "record-mint-retired",
  "recut-base-missing",
  // HISTORICAL-ONLY: a recut candidate refusal, retired with the rewrite
  // machinery and the recut verb (c146f903, e323f5be). It reached run failures,
  // so recorded runs carry it — which is exactly why the entry STAYS.
  "recut-current-changed",
  "recut-publish",
  "refusal-remedy-needs-withdraw",
  "refused-path",
  "refused-path-inspection",
  "rejected",
  "repository-corrupt",
  "required-check-failed",
  "retired-command",
  "review-rejected",
  "review-required",
  "run-canceled",
  "run-lease-expired",
  "run-plan-mismatch",
  "runner-error",
  "runner-health-failed",
  "runtime-reload-exec-failed",
  "scratch-cleanup-failed",
  // HISTORICAL-ONLY: its producer (publishSourceCandidate, the composed
  // path's source publisher) went with re-merge Phase 1, but recorded runs
  // and release reasons still carry it, and status-presentation.ts keeps it
  // in INFRA_RETRY_FAILURE_CODES so their presentation stays honest —
  // unregistering it would make failureDisposition throw on exactly that
  // recorded data.
  "source-publish",
  "spawn-cwd-missing",
  // `failed()`-only, like `check-failed` above — no `code: "..."` object
  // literal anywhere; command.ts's three base-moved checks raise it directly.
  "stale-base",
  "stale-check",
  "stale-intent",
  "stale-plan",
  "stale-pr",
  "stale-steps",
  "step-revision-drift",
  "step-selection-superseded",
  "step-unavailable",
  // Alternates-audit census findings (alternates-audit.ts) — like every
  // other YRD_QUEUE_AUDIT_FINDING_CODES member above, registered so a
  // finding code surfacing through a presentation path classifies instead
  // of throwing.
  "submodule-alternates-dead-store",
  "submodule-alternates-worktree-only",
  "submodule-composition-conflict",
  "submodule-composition-unavailable",
  "terminal",
  "unauthored-path-deletion",
  "unexpected",
  "unisolable-stale-plan",
  "unrecorded-submit",
  "viewer-read-only",
  // Same TEST-FIXTURE-ONLY narrative family as "mock-mismatch" above.
  "visual-rejected",
  "wrapper-generation",
  "wrapper-mismatch",
] as const

export type RefusalCode = (typeof YRD_REFUSAL_CODES)[number]

const YRD_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(YRD_REFUSAL_CODES)

/**
 * Alternate spellings for a handful of {@link YRD_REFUSAL_CODES} members —
 * never a fresh concept, always the SAME failure this codebase already
 * tolerated under an older or synonymous name (status-presentation.ts used to
 * carry these as ad-hoc inline `code === "..."` checks and Set members; the
 * tolerance itself was the tell the vocabulary never closed). Registered here
 * so historical or external data in either spelling still classifies instead
 * of throwing, without ratifying the drift as two independent codes.
 */
export const YRD_REFUSAL_CODE_ALIASES: Readonly<Record<string, RefusalCode>> = {
  cancelled: "canceled",
  "queue-cancelled": "queue-canceled",
  "run-cancelled": "run-canceled",
  "environment-refused": "queue-environment-refused",
  "lease-timeout": "job-lease-expired",
}

/**
 * `<step-name>-failed` — NOT a finite spelling to enumerate: `run.ts`
 * (`` `${waiting.step.name}-failed` ``, an externally-completed waiting job)
 * and `command.ts` (`` `${options.purpose}${waiting ? "-launcher" : ""}-failed` ``)
 * both build this from a repo's OWN configured check/step name, which is open
 * per-project by design — the same way `check-failed` (registered above) is
 * the generic form when no step-specific code is available. Same disposition
 * either way (neither is stale/env/timeout/canceled/needs-author, so both
 * land on the plain default), so this is a STRUCTURAL alias family, checked
 * only after the closed vocabulary and the discrete alias table both miss.
 */
const DYNAMIC_STEP_FAILURE_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-failed$/u

/** A raw failure code, resolved to its registered canonical spelling — itself
 * if already canonical, its mapped form if it is a registered alias, the
 * generic `check-failed` if it matches the {@link DYNAMIC_STEP_FAILURE_CODE}
 * shape, or `undefined` if it is outside the closed vocabulary entirely. The
 * one gate every consumer that must not silently misclassify an unknown code
 * shares. */
export function canonicalRefusalCode(code: string): RefusalCode | undefined {
  if (YRD_REFUSAL_CODE_SET.has(code)) return code as RefusalCode
  const alias = YRD_REFUSAL_CODE_ALIASES[code]
  if (alias !== undefined) return alias
  return DYNAMIC_STEP_FAILURE_CODE.test(code) ? "check-failed" : undefined
}

function admissionFailureKind(
  result: DeepReadonly<JobError>,
  infrastructure: boolean,
): Extract<ChangeAdmissionRecord, { status: "refused" }>["kind"] {
  if (infrastructure) return "infrastructure"
  return NEEDS_AUTHOR_CODES.has(result.code) ? "refusal" : "failure"
}

type InfraRetryCompositionFailure =
  | "carrier-inspection"
  | "component-main-inspection-failed"
  | "merge-unauthored-deletion"
  | "source-publish"
  | "scratch-cleanup-failed"
  | "wrapper-generation"

function isInfraRetryCompositionFailure(code: string | undefined): code is InfraRetryCompositionFailure {
  return code !== undefined && COMPOSITION_FAILURE_BUCKETS["infra-retry"].has(code)
}

function terminalJobError(job: DeepReadonly<Job> | undefined): JobError | undefined {
  if (job?.status !== "completed") return undefined
  if (job.conclusion === "failure") return job.error
  if (job.conclusion === "timed_out") return { code: "job-lost", message: job.lostReason }
  if (job.conclusion === "cancelled") return jobFailure(job)
  return undefined
}

function needsAuthorJobResult(job: DeepReadonly<Job> | undefined): JobError | undefined {
  const error = terminalJobError(job)
  if (error === undefined) return undefined
  if (NEEDS_AUTHOR_CODES.has(error.code)) return error
  if (job?.status !== "completed" || job.conclusion !== "failure") return undefined
  const evidence = candidateFailureResultEvidence(job.output)
  return evidence === undefined ? undefined : JobErrorSchema.parse({ ...error, evidence })
}

/** Recover the immutable author-attribution result from an exact Queue run.
 * This remains valid after the change advances to a later revision, unlike a
 * lookup through current PR eligibility. */
export function authorAttributionResult(
  run: DeepReadonly<Run> | undefined,
  identity?: Readonly<{ pr: string; revision: number; headSha: string }>,
): JobError | undefined {
  if (run === undefined) return undefined
  if (
    identity !== undefined &&
    !run.prs.some(
      (member) =>
        member.id === identity.pr && member.revision === identity.revision && member.headSha === identity.headSha,
    )
  ) {
    return undefined
  }
  for (const step of run.steps) {
    const result = needsAuthorJobResult(step.job)
    if (result !== undefined) return result
  }
  return run.error !== undefined && NEEDS_AUTHOR_CODES.has(run.error.code) ? run.error : undefined
}

/** Recover the attributed result for a legacy rejected journal. Scans EVERY
 * step across both the admission/check run and terminal integration run,
 * including integrating steps hidden from ordinary check projections. Native
 * needs-author reads the result directly from the change fact. */
function needsAuthorResult(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  steps: readonly RuntimeStep[],
): JobError | undefined {
  const current = changeNeedsAuthor(pr)
  if (current !== undefined) return current.receipt
  const runIds = new Set<RunId>()
  const checkRun = checkEligibility(state, pr, steps).run
  if (checkRun !== undefined) runIds.add(checkRun)
  if (pr.terminalRun !== undefined) runIds.add(pr.terminalRun as RunId)
  const latestRoot = latestRootRunId(state.queues.index, Queues.snapshot(pr))
  if (latestRoot !== undefined) runIds.add(latestRoot)
  for (const runId of runIds) {
    const record = Queues.get(state.queues, runId)
    if (record === undefined) continue
    const run = materializeRun(record, state.jobs)
    const result = authorAttributionResult(run)
    if (result !== undefined) return result
  }
  return undefined
}

function needsAuthorMessage(pr: DeepReadonly<Change>, result: JobError): string {
  const attributed = CandidateFailureResultEvidenceSchema.safeParse(result.evidence)
  if (!attributed.success) return `change '${pr.id}' cannot be composed as submitted: ${result.message}`
  const failures = attributed.data.failures
    .map(
      (failure) =>
        `${failure.file}:${failure.line}${failure.column === undefined ? "" : `:${failure.column}`} ${failure.message}`,
    )
    .join("; ")
  const unchanged = attributed.data.unchangedBaselineCount
  const footer = unchanged === undefined ? "" : `; ${unchanged} baseline error${unchanged === 1 ? "" : "s"} unchanged`
  return `change '${pr.id}' introduced ${attributed.data.failures.length} check failure(s): ${failures}${footer}`
}

/** The action line of an admission-refused eligibility message. A settled
 * refusal is the remedy classifier's judgment made durable: no mechanical
 * remedy exists, so printing the re-merge drill after it points the reader back
 * into the loop the settlement closed (2026-08-19). Print the judgment fact
 * instead — including WHO decides, through the same `needsPersonOwner`
 * resolution the audit's needs-person finding carries, so the reader-facing
 * message and the finding never disagree about the owner. The drill is only
 * for refusals nothing has settled. */
function admissionRefusalNext(
  pr: string,
  settlement: Readonly<{ disposition: string; reason: string; settledAt: string }> | undefined,
  needsPersonOwner: string,
): string {
  return settlement === undefined
    ? `Next: tracked changes re-merge implicitly when the branch moves; fallback: 'yrd pr submit <branch>' (${pr})`
    : `Settled ${settlement.disposition} at ${settlement.settledAt}: ${settlement.reason}; ` +
        `decision owner: ${needsPersonOwner} — no mechanical remedy applies`
}

/** The current revision's durable settlement, when the refusal ledger holds one
 * for EXACTLY the revision the caller is looking at. A row naming a replaced
 * revision proves nothing about the current one. */
function settledAdmissionRefusal(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
): Readonly<{ disposition: string; reason: string; settledAt: string }> | undefined {
  const refusal = state.queues.admissionRefusals[pr.id]
  if (refusal?.settlement === undefined) return undefined
  const revision = currentChangeRev(pr)
  return refusal.revision === revision.n && refusal.headSha === revision.head ? refusal.settlement : undefined
}

function ChangeEligibility(
  state: DeepReadonly<RuntimeState>,
  pr: DeepReadonly<Change>,
  steps: readonly RuntimeStep[],
  needsPersonOwner: string,
  options: Readonly<{
    resumeIntegrated?: boolean
    ignoreChecks?: boolean
    ignoredClaims?: ReadonlySet<string>
  }> = {},
): ChangeEligibility {
  const reviewed = reviewState(pr)
  const required = state.queues.requires.includes("review")
  const review = {
    required,
    approved: reviewed.approved,
    stale: reviewed.stale.length > 0 && reviewed.current === undefined,
    ...(reviewed.current?.decision === undefined ? {} : { decision: reviewed.current.decision }),
    ...(reviewed.current?.by === undefined ? {} : { by: reviewed.current.by }),
    ...(reviewed.current?.ref === undefined ? {} : { ref: reviewed.current.ref }),
  }
  const checks = checkEligibility(state, pr, steps)
  const exhaustedAutomaticAdmissions =
    checks.status === "failed" &&
    automaticAdmissionAttemptsExhausted(state, pr, Queues.snapshot(pr), admissionSteps(steps))
  const verdict = (reason?: ChangeEligibility["reason"]): ChangeEligibility => ({
    pr: pr.id,
    revision: changeRevisionNumber(pr),
    runnable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    review,
    checks,
  })
  const delivery = changeDeliveryState(pr)
  const resumingIntegration =
    options.resumeIntegrated === true && (delivery === "integrated" || delivery === "already-landed")
  if (!resumingIntegration) {
    if (delivery === "pushed") {
      return verdict({ code: "draft", message: `change '${pr.id}' is pushed, not ready` })
    }
    if (delivery === "needs-author") {
      const admission = changeAdmission(pr)
      if (admission?.status === "refused") {
        return verdict({
          code: "admission-refused",
          message:
            `change '${pr.id}' required checks cannot run after the entry-check failure '${admission.receipt.code}': ` +
            `${admission.receipt.message}.\n${admissionRefusalNext(pr.id, settledAdmissionRefusal(state, pr), needsPersonOwner)}`,
        })
      }
      const result = changeNeedsAuthor(pr)?.receipt
      if (result === undefined) {
        throw new Error(`yrd: change '${pr.id}' is needs-author without an attribution result`)
      }
      return verdict({
        code: "needs-author",
        message: needsAuthorMessage(pr, result),
        result,
      })
    }
    // A composition refusal is deterministic: the queue could not build the
    // candidate from what the author submitted, so re-running the same payload
    // cannot pass — whether the failed compose left the change `submitted` or drove
    // an automatic `rejected`. Project it as `needs-author` with the refusal
    // result attached, ahead of the generic `rejected`/`required-check-failed` verdicts.
    // This is a derived projection over the failed check's recorded refusal
    // evidence; it stores no new PR state (the bay state is untouched).
    if (
      options.ignoreChecks !== true &&
      (delivery === "submitted" || delivery === "ready" || delivery === "rejected")
    ) {
      const result = needsAuthorResult(state, pr, steps)
      if (result !== undefined) {
        return verdict({
          code: "needs-author",
          message: needsAuthorMessage(pr, result),
          result,
        })
      }
    }
    if (delivery === "rejected") {
      return verdict({ code: "rejected", message: `change '${pr.id}' is rejected; submit it again before queueing` })
    }
    if (delivery !== "submitted" && delivery !== "ready") {
      return verdict({ code: "terminal", message: `change '${pr.id}' is ${delivery}, not queueable` })
    }
    const revision = currentChangeRev(pr)
    const conflictingCandidate = Object.values(state.queues.candidates)
      .filter(
        (candidate) =>
          candidate.mergeability === "conflicting" &&
          candidate.queueId === queueIdentity(pr) &&
          candidate.revs.some(
            (member) => member.pr === pr.id && member.n === revision.n && member.head === revision.head,
          ),
      )
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1)
    if (conflictingCandidate !== undefined) {
      return verdict({
        code: "candidate-conflicting",
        message: `change '${pr.id}' revision ${revision.n} conflicts in Candidate '${conflictingCandidate.id}'`,
      })
    }
    const admissionRefusal = state.queues.admissionRefusals[pr.id]
    if (
      admissionRefusal?.settlement !== undefined &&
      admissionRefusal.revision === revision.n &&
      admissionRefusal.headSha === revision.head
    ) {
      return verdict({
        code: "admission-refused",
        message:
          `change '${pr.id}' required checks cannot run after the entry-check failure '${admissionRefusal.code}': ` +
          `${admissionRefusal.reason}.\n` +
          admissionRefusalNext(pr.id, admissionRefusal.settlement, needsPersonOwner),
      })
    }
    if (options.ignoreChecks !== true && checks.status === "queued") {
      const position = checks.position === undefined ? "" : ` at position ${checks.position}`
      return verdict({ code: "checks-pending", message: `change '${pr.id}' checks are queued${position}` })
    }
    if (options.ignoreChecks !== true && checks.status === "checking") {
      const run = checks.run === undefined ? "" : ` in ${checks.run}`
      return verdict({ code: "checking", message: `change '${pr.id}' checks are running${run}` })
    }
    if (
      options.ignoreChecks !== true &&
      checks.status === "failed" &&
      (checks.run === undefined ||
        projectionLookupGet(state.queues.authority.runs, checks.run)?.released === undefined ||
        exhaustedAutomaticAdmissions)
    ) {
      const run = checks.run === undefined ? "" : ` in ${checks.run}`
      return verdict({
        code: "required-check-failed",
        message: `change '${pr.id}' required check failed${run}; fix the branch and push, or request fresh checks`,
      })
    }
    if (required && !reviewed.approved) {
      if (reviewed.current?.decision === "reject") {
        return verdict({
          code: "review-rejected",
          message: `change '${pr.id}' was rejected by ${reviewed.current.by} for revision ${changeRevisionNumber(pr)}`,
        })
      }
      return verdict({
        code: "review-required",
        message: `change '${pr.id}' needs approval for revision ${changeRevisionNumber(pr)}`,
      })
    }
  }
  const base = baseIdentity(pr.base)
  const pause = blockingQueuePause(state, pr)
  if (pause !== undefined) {
    return verdict({
      code: "queue-paused",
      message: `queue '${base}' is paused: ${pause.reason}; change '${pr.id}' is not in the allowed set`,
    })
  }
  const claimed = activeQueueRuns(state.queues, state.jobs).find(
    (run) =>
      !Queues.terminal(run) &&
      !options.ignoredClaims?.has(run.id) &&
      run.prs.some((candidate) => candidate.id === pr.id),
  )
  return claimed !== undefined
    ? verdict({
        code: "claimed",
        message: `change '${pr.id}' is already in active queue run '${claimed.id}'`,
      })
    : verdict()
}

function partitionCandidates(prs: readonly Change[], batchSize: number): Change[][] {
  const groups = new Map<string, Change[]>()
  for (const pr of prs) {
    const proof = pr.integration
    const flow = pr.flow
    const key = `${baseIdentity(pr.base)}\0${flow?.name ?? ""}\0${flow?.rev ?? ""}\0${flow?.fingerprint ?? ""}\0${proof?.commit ?? ""}\0${proof?.baseSha ?? ""}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [pr])
    else group.push(pr)
  }
  const candidates: Change[][] = []
  for (const group of groups.values()) {
    for (let index = 0; index < group.length; index += batchSize) candidates.push(group.slice(index, index + batchSize))
  }
  return candidates
}

function ChangeShape(prs: readonly ChangeSnapshot[]): ChangeShape {
  if (prs.length === 0) throw new Error("yrd: a queue run requires at least one change")
  return { results: {} }
}

function integratedChangeShape(prs: readonly Change[]): IntegratedShape | undefined {
  if (prs.every((pr) => !pr.merged)) return undefined
  const proof = prs[0]?.integration
  const alreadyMerged = prs[0]?.alreadyLanded
  if (
    proof === undefined ||
    prs.some(
      (pr) =>
        !pr.merged ||
        pr.integration?.commit !== proof.commit ||
        pr.integration?.baseSha !== proof.baseSha ||
        (alreadyMerged === undefined) !== (pr.alreadyLanded === undefined) ||
        (alreadyMerged !== undefined &&
          (pr.alreadyLanded?.baseSha !== proof.baseSha ||
            pr.alreadyLanded.candidateSha !== alreadyMerged.candidateSha ||
            pr.alreadyLanded.candidateTreeSha !== alreadyMerged.candidateTreeSha ||
            pr.alreadyLanded.baseTreeSha !== alreadyMerged.baseTreeSha)),
    )
  ) {
    throw new Error("yrd: every change in a queue candidate must share one integration proof")
  }
  const { changeId: _changeId, ...queueProof } = proof
  const integration = IntegrationProofSchema.parse(queueProof)
  return {
    ...ChangeShape(prs.map(Queues.snapshot)),
    integration:
      alreadyMerged === undefined
        ? integration
        : {
            ...integration,
            alreadyLanded: {
              candidateSha: alreadyMerged.candidateSha,
              candidateTreeSha: alreadyMerged.candidateTreeSha,
              baseTreeSha: alreadyMerged.baseTreeSha,
            },
          },
  }
}

function pinnedChangeError(
  state: DeepReadonly<RuntimeState>,
  snapshots: readonly ChangeSnapshot[],
  runId?: RunId,
): JobError | undefined {
  for (const snapshot of snapshots) {
    const intent = snapshot.intent
    if (intent !== undefined) {
      // The retired intent rail's own bookkeeping (`state.intents`) is gone, so
      // there is nothing left to verify a historical "carrier-free pin intent"
      // member against. Fail loud rather than silently trust or silently drop
      // it: any run still carrying one from before the rail's deletion ends
      // here, cleanly, instead of hanging or corrupting a merge.
      return {
        code: "stale-intent",
        message: `Intent '${intent.id}' can no longer be verified: the intent rail that tracked it is retired`,
      }
    }
    // The live submit fact is the pin's referent. Standing at exactly the
    // pinned sha ⇒ fresh; moved or vanished ⇒ the author superseded the member
    // mid-run (re-push or branch delete). The record arm this replaces asked the
    // same question of a record's current revision, base and closed state.
    if (state.bays.submits[snapshot.branch]?.sha === snapshot.headSha) continue
    return {
      code: "stale-pr",
      message: `change '${snapshot.id}' changed after queue run pinned revision ${snapshot.revision} (${snapshot.headSha})`,
    }
  }
  return undefined
}

function bisectable(run: Run): boolean {
  const failed = run.steps.some((step) => step.job !== undefined && jobFailed(step.job))
  return (
    Queues.failed(run) &&
    failed &&
    queueAuthorityReleaseReason(run.error) === undefined &&
    !isIntegrated(run.shape) &&
    run.prs.length > 1
  )
}

function needsAdvance(state: DeepReadonly<RuntimeState>, run: Run): boolean {
  if (activeQueueFailure(Queues.record(state.queues, run.id), state.jobs) !== undefined) return false
  const index = run.steps.findLastIndex((step) => step.job !== undefined)
  const step = run.steps[index]
  if (step?.job === undefined || !Job.terminal(step.job)) return false
  if (jobSucceeded(step.job)) {
    // S7 settlement single-writer: a completed step chain never holds an
    // advance open. The store-absorption wait that lived here was the record
    // loop's termination signal — the advance emitted `pr/integrated` and
    // waited to see the store absorb it. That loop is deleted: EVERY member's
    // terminal (record and derived alike) emits from the `settled` batch,
    // whose own reducers both absorb it into any surviving record and retire
    // the root, so waiting on the store here would deadlock settlement
    // against its own gate (`needsSettlement` → settled no-ops).
    return run.steps[index + 1]?.job === undefined && index + 1 < run.steps.length
  }
  if (!jobFailed(step.job)) return false
  if (queueAuthorityReleaseReason(jobFailure(step.job)) !== undefined) return true
  if (step.job.conclusion !== "cancelled") return true
  // A cancelled step re-advances only while a member is still live, which since
  // S7 means its submit fact still stands at exactly the pinned sha. The record
  // arm asked the same of a record's current revision and delivery state.
  return run.prs.some((member) => state.bays.submits[member.branch]?.sha === member.headSha)
}

function isIntegrated(shape: ChangeShape): shape is IntegratedShape {
  return "integration" in shape
}

function jobFailure(job: Job): JobError {
  if (job.status === "completed" && job.conclusion === "failure") return job.error
  if (job.status === "completed" && job.conclusion === "timed_out") {
    return { code: "job-lost", message: job.lostReason }
  }
  if (job.status === "completed" && job.conclusion === "cancelled") {
    return { code: "run-canceled", message: `Queue run canceled by ${job.canceledBy}: ${job.cancelReason}` }
  }
  if (job.status === "completed" && job.conclusion === "skipped") {
    return { code: "job-skipped", message: `Job '${job.id}' was skipped` }
  }
  throw new Error(
    `yrd: job '${job.id}' is ${job.status}${job.status === "completed" ? `+${job.conclusion}` : ""}, not failed`,
  )
}

type SuccessfulJob = Extract<Job, { status: "completed"; conclusion: "success" }>
type UnsuccessfulJob = Extract<
  Job,
  { status: "completed"; conclusion: "failure" | "cancelled" | "skipped" | "timed_out" }
>

function jobSucceeded(job: Job): job is SuccessfulJob {
  return job.status === "completed" && job.conclusion === "success"
}

function jobFailed(job: Job): job is UnsuccessfulJob {
  return job.status === "completed" && job.conclusion !== "success"
}
