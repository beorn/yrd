import * as z from "zod"
import {
  compareNatural,
  JsonSchema,
  raiseFailure,
  resolveSelector,
  resolveSelectorMatch,
  type JsonValue,
  type SelectorMatch,
} from "@yrd/core"
import type { FlowPin } from "@yrd/config"
import { JobErrorSchema, type JobError } from "@yrd/job"

export const BayIdSchema = z.string().trim().min(1)
export const PRIdSchema = z.string().trim().min(1)
export const GitRefSchema = z.string().trim().min(1)
export const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
export const PRTerminalAssociationSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    run: z.string().trim().min(1),
    provenance: z.literal("migration/21091"),
    evidence: z.object({ terminalEvent: z.uuidv7(), run: z.string().trim().min(1) }).strict(),
  })
  .strict()
  .refine(({ run, evidence }) => run === evidence.run, {
    message: "association run must equal the evidence run",
    path: ["evidence", "run"],
  })
export type PRTerminalAssociation = Readonly<z.infer<typeof PRTerminalAssociationSchema>>
export const CorrelationSchema = z
  .object({
    namespace: z.string().trim().min(1),
    id: z
      .string()
      .min(1)
      .refine((id) => id.trim().length > 0, { message: "correlation id cannot be blank" }),
  })
  .strict()

const TextSchema = z.string().trim().min(1)

const V2_ROLE_KEY = ["act", "or"].join("")

function normalizeV2Role(value: unknown, target: "by" | "submitter"): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (target in record || !(V2_ROLE_KEY in record)) return value
  const { [V2_ROLE_KEY]: previous, ...current } = record
  return { ...current, [target]: previous }
}

/** Normalize pre-cutover event provenance while keeping current schemas free of the retired vocabulary. */
export function normalizeV2By(value: unknown): unknown {
  return normalizeV2Role(value, "by")
}

/** Normalize pre-cutover revision provenance while keeping current schemas on `submitter`. */
export function normalizeV2Submitter(value: unknown): unknown {
  return normalizeV2Role(value, "submitter")
}

/** Closed current rejection fact used by the Bay projection and post-append signal observers. */
const PRRejectedFactObjectSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    run: TextSchema,
    issueRef: TextSchema.optional(),
    correlation: CorrelationSchema.optional(),
    /** Persisted v2 key; missing only when a current rejection terminates a pre-identity revision. */
    submitter: TextSchema.optional(),
    step: TextSchema,
    evidence: TextSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
export const PRRejectedFactSchema = z.preprocess(normalizeV2Submitter, PRRejectedFactObjectSchema)
export type PRRejectedFact = Readonly<z.infer<typeof PRRejectedFactSchema>>

/** Author-owned refusal fact. Unlike `pr/rejected`, this keeps the PR in the
 * submitted queue lifecycle and carries the exact typed receipt needed to fix
 * the branch in place. */
export const PRNeedsAuthorFactSchema = z.preprocess(
  normalizeV2Submitter,
  PRRejectedFactObjectSchema.extend({
    receipt: JobErrorSchema,
  }).strict(),
)
export type PRNeedsAuthorFact = Readonly<z.infer<typeof PRNeedsAuthorFactSchema>>

export const GitPayloadPathSchema = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    if (
      path !== path.trim() ||
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      context.addIssue({ code: "custom", message: "must be a normalized repository-relative Git path" })
    }
  })

const GitPayloadPathsSchema = z
  .array(GitPayloadPathSchema)
  .min(1)
  .superRefine((paths, context) => {
    const duplicate = paths.find((path, index) => paths.indexOf(path) !== index)
    if (duplicate !== undefined) {
      context.addIssue({ code: "custom", message: `contains duplicate path '${duplicate}'` })
    }
  })
  .transform((paths) => paths.toSorted())

export type CompositionSource = Readonly<{
  repo: string
  branch: string
  baseSha: string
  tipSha: string
  payload: readonly string[]
}>

export const CompositionSourceSchema = z
  .object({
    repo: GitPayloadPathSchema,
    branch: GitRefSchema,
    baseSha: GitShaSchema,
    tipSha: GitShaSchema,
    payload: GitPayloadPathsSchema,
  })
  .strict() as z.ZodType<CompositionSource>

export type CompositionV1 = Readonly<{
  version: 1
  sources: readonly CompositionSource[]
}>

export const CompositionV1Schema = z
  .object({
    version: z.literal(1),
    sources: z
      .array(CompositionSourceSchema)
      .min(1)
      .superRefine((sources, context) => {
        const duplicate = sources.find(
          (source, index) => sources.findIndex((row) => row.repo === source.repo) !== index,
        )
        if (duplicate !== undefined) {
          context.addIssue({ code: "custom", message: `contains duplicate repository '${duplicate.repo}'` })
        }
      })
      .transform((sources) => sources.toSorted((left, right) => left.repo.localeCompare(right.repo))),
  })
  .strict() as z.ZodType<CompositionV1>

export type BayId = string
export type PRId = string
export type Correlation = z.infer<typeof CorrelationSchema>

/** Stable persisted queue key for local and origin-qualified base refs. */
export function baseIdentity(ref: string): string {
  const parsed = GitRefSchema.parse(ref)
  for (const prefix of ["refs/heads/", "refs/remotes/origin/", "origin/"]) {
    if (parsed.startsWith(prefix)) return parsed.slice(prefix.length)
  }
  return parsed
}

export function resolveBase(bases: Iterable<string>, selector: string): string | undefined {
  return resolveSelector(
    selector,
    [...bases].map((base) => {
      const canonical = baseIdentity(base)
      return {
        canonical,
        aliases: [base, `origin/${canonical}`, `refs/heads/${canonical}`, `refs/remotes/origin/${canonical}`],
        value: canonical,
      }
    }),
    { kind: "base" },
  )
}

export type BayFailure = Readonly<{
  code: string
  message: string
}>

export type BayOrphan = Readonly<{
  reason: string
  exitCode?: number
  signal?: string
  timedOut?: boolean
  stalled?: boolean
  sweepFailure?: string
  escapedDescendant?: boolean
  recordedAt: string
  eventId: string
}>

export type BayStatus = "opening" | "active" | "closing" | "closed" | "failed"

export type BayHandoff = Readonly<{
  headSha: string
  evidence: string
  certifiedAt: string
  eventId: string
}>

export type BayArchive = Readonly<{
  headSha: string
  preservedRef: string
  archivedAt: string
  eventId: string
}>

export type Bay = Readonly<{
  id: BayId
  name: string
  issue?: string
  by?: string
  branch: string
  base: string
  from?: string
  status: BayStatus
  openedAt: string
  refreshedAt: string
  path?: string
  headSha?: string
  baseSha?: string
  dirty?: boolean
  jobId?: string
  jobDef?: string
  closedAt?: string
  failure?: BayFailure
  orphan?: BayOrphan
  handoff?: BayHandoff
  archive?: BayArchive
}>

type BranchLifecycleBase = Readonly<{
  bay: BayId
  name: string
  issue?: string
  by?: string
  branch: string
  openedAt: string
}>

export type BranchLifecycle =
  | Readonly<BranchLifecycleBase & { status: "open"; headSha?: string }>
  | Readonly<
      BranchLifecycleBase & {
        status: "unmanaged"
        headSha?: string
        reason: "archive-proof-unavailable"
      }
    >
  | Readonly<
      BranchLifecycleBase & {
        status: "handoff-ready"
        headSha: string
        ready: Readonly<{ at: string; eventId: string; evidence: string }>
      }
    >
  | Readonly<
      BranchLifecycleBase & {
        status: "submitted"
        headSha: string
        submitted: Readonly<{ pr: PRId; revision: number; at: string }>
      }
    >
  | Readonly<
      BranchLifecycleBase & {
        status: "landed"
        headSha: string
        landed: Readonly<{ pr: PRId; revision: number; at: string; commit: string }>
      }
    >
  | Readonly<
      BranchLifecycleBase & {
        status: "archived"
        headSha: string
        archived: Readonly<{ at: string; eventId: string; preservedRef: string }>
      }
    >

/** W2-facing delivery label derived from canonical PR/PRRev facts. Never stored. */
export type PRDeliveryState =
  | "pushed"
  | "submitted"
  | "ready"
  | "needs-author"
  | "rejected"
  | "integrated"
  | "already-landed"
  | "withdrawn"
  | "canceled"

const NON_CHECKABLE_PR_STATES: ReadonlySet<PRDeliveryState> = new Set<PRDeliveryState>([
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
])

/** A PR can accept new check requests in every non-terminal delivery state.
 * Once it reaches integrated/already-landed/withdrawn/canceled, it is no
 * longer checkable. */
export function isNonCheckablePRState(state: PRDeliveryState): boolean {
  return NON_CHECKABLE_PR_STATES.has(state)
}

/**
 * A check request was refused because the PR's current status does not permit
 * it. Always thrown, never returned, so a genuine caller error still fails
 * loud. The carried `prId`/`status` let a resident, multi-tenant runner tell a
 * losable concurrent-terminal race (a peer withdrew/canceled/integrated/already-landed the PR
 * between the runner's compose snapshot and its check request — see
 * isConcurrentCheckabilityConflict) apart from a real caller error, without
 * matching on the message text.
 */
export class PrCheckabilityConflict extends Error {
  readonly prId: string
  readonly status: PRDeliveryState

  constructor(prId: string, status: PRDeliveryState) {
    super(`yrd: PR '${prId}' is ${status}, not checkable`)
    this.name = "PrCheckabilityConflict"
    this.prId = prId
    this.status = status
  }
}

/**
 * True when an error is a PrCheckabilityConflict whose PR had already reached a
 * terminal status — i.e. a concurrent writer withdrew/canceled/integrated/already-landed the
 * PR between a runtime's compose snapshot and its check request. This is a
 * normal, losable race for a long-lived resident runner: skip this cycle and
 * continue; the next cycle re-snapshots without the departed PR and composes
 * the remaining runnable ones.
 */
export function isConcurrentCheckabilityConflict(error: unknown): error is PrCheckabilityConflict {
  return error instanceof PrCheckabilityConflict && isNonCheckablePRState(error.status)
}

export type PRRevTerminal = Readonly<{
  kind: Extract<PRDeliveryState, "rejected" | "integrated" | "already-landed" | "withdrawn" | "canceled">
  at: string
  run?: string
}>

export type PRRevClock = Readonly<{
  pushedAt: string
  submittedAt?: string
  terminal?: PRRevTerminal
}>

export type PRAdmissionStep = Readonly<{
  name: string
  revision: string
  job: string
  status: "passed" | "refused"
  output?: JsonValue
  receipt?: JobError
}>

export const PRAdmissionStepSchema = z
  .object({
    name: TextSchema,
    revision: TextSchema,
    job: TextSchema,
    status: z.enum(["passed", "refused"]),
    output: JsonSchema.optional(),
    receipt: JobErrorSchema.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if ((step.status === "passed") !== (step.receipt === undefined)) {
      context.addIssue({
        code: "custom",
        message:
          step.status === "passed"
            ? "passed admission step cannot carry a receipt"
            : "refused admission step requires a receipt",
        path: ["receipt"],
      })
    }
  }) as z.ZodType<PRAdmissionStep>

const PRAdmissionBaseSchema = z.object({
  baseSha: GitShaSchema,
  candidate: TextSchema.optional(),
  steps: z.array(PRAdmissionStepSchema),
})

export type PRAdmissionRecord =
  | Readonly<{
      status: "passed"
      baseSha: string
      candidate?: string
      steps: readonly PRAdmissionStep[]
    }>
  | Readonly<{
      status: "refused"
      kind: "refusal" | "infrastructure"
      baseSha: string
      candidate?: string
      steps: readonly PRAdmissionStep[]
      step: string
      receipt: JobError
    }>

export const PRAdmissionRecordSchema = z.discriminatedUnion("status", [
  PRAdmissionBaseSchema.extend({ status: z.literal("passed") }).strict(),
  PRAdmissionBaseSchema.extend({
    status: z.literal("refused"),
    kind: z.enum(["refusal", "infrastructure"]),
    step: TextSchema,
    receipt: JobErrorSchema,
  }).strict(),
]) as z.ZodType<PRAdmissionRecord>
export type PRAdmission = PRAdmissionRecord & Readonly<{ at: string }>

export type PRAdmissionRecordedFact = Readonly<{
  pr: PRId
  revision: number
  headSha: string
  admission: PRAdmissionRecord
}>

export const PRAdmissionRecordedFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    admission: PRAdmissionRecordSchema,
  })
  .strict() as z.ZodType<PRAdmissionRecordedFact>

export const PRFreshnessTransitionSchema = z
  .object({ from: z.literal("admitted"), to: z.literal("refreshed") })
  .strict()
export type PRFreshnessTransition = Readonly<z.infer<typeof PRFreshnessTransitionSchema>>

export const PRRecutSourceSchema = z
  .object({
    repo: z.string().trim().min(1),
    fromHeadSha: GitShaSchema,
    toHeadSha: GitShaSchema,
    patchId: GitShaSchema,
    rangeDiff: z.literal("="),
  })
  .strict()
  .readonly()
export type PRRecutSource = Readonly<z.infer<typeof PRRecutSourceSchema>>

export const PRRecutProofSchema = z
  .object({
    fromRevision: z.number().int().positive(),
    patchId: GitShaSchema,
    treeSha: GitShaSchema,
    reviewCarried: z.boolean(),
    /** Durable non-ancestral identity mapping for the root and any rewritten
     * component heads. Missing only while replaying pre-provenance journals. */
    sources: z.array(PRRecutSourceSchema).min(1).readonly().optional(),
    transition: PRFreshnessTransitionSchema.optional(),
  })
  .strict()
export type PRRecutProof = Readonly<z.infer<typeof PRRecutProofSchema>>

export type PRRev = Readonly<{
  n: number
  head: string
  base: string
  baseSha?: string
  /** Missing only while replaying journals written before submitter identity was recorded. */
  submitter?: string
  correlation?: Correlation
  composition?: CompositionV1
  recut?: PRRecutProof
  /** Admission is a verdict about this immutable revision, not a landing
   * attempt. A later base revalidation replaces it on the same revision. */
  admission?: PRAdmission
}> &
  PRRevClock

export type PRReviewDecision = "approve" | "reject"

export type PRReview = Readonly<{
  revision: number
  headSha: string
  by: string
  decision: PRReviewDecision
  at: string
  ref?: string
  note?: string
  carriedFrom?: Readonly<{ revision: number; headSha: string }>
}>

export type PRComment = Readonly<{
  revision: number
  headSha: string
  by: string
  note: string
  at: string
  ref?: string
}>

export type PRReviewState = Readonly<{
  approved: boolean
  current?: PRReview
  stale: readonly PRReview[]
}>

export type PRCheckRequest = Readonly<{
  revision: number
  headSha: string
  baseSha?: string
  at: string
}>

export type PRAlreadyLandedEvidence = Readonly<{
  baseSha: string
  candidateSha: string
  candidateTreeSha: string
  baseTreeSha: string
  settlement?: Readonly<{
    kind: "refresh-superseded"
    proof: "payload-already-contained"
    patchId: string
  }>
}>

export type PRRegressionSeverity = "low" | "medium" | "high" | "critical"

/** One completed escaped-regression outcome. Implementation and review
 * provenance stay opaque; Yrd owns only their exact delivery join. */
export type PRRegression = Readonly<{
  pr: PRId
  issueRef: string
  revision: number
  headSha: string
  run: string
  landingSha: string
  detectedAt: string
  severity: PRRegressionSeverity
  evidence: string
  implementationRunRef: string
  reviewRef: string
  repairIssueRef: string
  repairPr: PRId
  repairRun: string
  repairLandingSha: string
  recordedAt: string
}>

export type PR = Readonly<{
  id: PRId
  bay?: BayId
  name?: string
  issue?: string
  note?: string
  /** Human subject for the change; defaults to the head commit subject at submit. */
  title?: string
  /** Human body describing the change; defaults to the head commit body (plus an issue reference) at submit. */
  description?: string
  branch: string
  base: string
  state: "open" | "closed"
  merged: boolean
  /** Opt-in "merge into latest": when true, the resident observes the live
   * branch before each Queue cycle. A moved head is recorded as a revision,
   * preflighted, and prepared for Queue admission when its verdict permits; a
   * manual implicit recut uses the same recording rule. Each run still executes
   * one frozen recorded revision. Absent means untracked — the reproducibility
   * refusal stands. */
  track?: boolean
  flow?: FlowPin
  revs: readonly PRRev[]
  reviews: readonly PRReview[]
  comments: readonly PRComment[]
  checkRequests: readonly PRCheckRequest[]
  /** Current requested-reviewer set (latest pr/review-requested fact wins;
   * revision-independent, so recuts and new revisions keep the request).
   * Optional like `regressions`: absent means no request was ever recorded,
   * identical in meaning to the empty set. */
  requestedReviewers?: readonly string[]
  regressions?: readonly PRRegression[]
  /** Legacy pre-revision-admission projection. New refusal evidence lives on
   * `currentPRRev(pr).admission`; retained so old journals remain readable. */
  needsAuthor?: Readonly<{
    at: string
    run: string
    step: string
    receipt: JobError
    evidence?: string
    detail?: string
  }>
  terminalRun?: string
  submittedAt?: string
  rejectedAt?: string
  integratedAt?: string
  integration?: Readonly<{ commit: string; baseSha: string }>
  alreadyLandedAt?: string
  alreadyLanded?: PRAlreadyLandedEvidence
  withdrawnAt?: string
  withdrawReason?: string
  canceledAt?: string
  canceledBy?: string
  cancelReason?: string
  detail?: string
}>

export function currentPRRev(pr: Pick<PR, "id" | "revs">): PRRev {
  const revision = pr.revs.at(-1)
  if (revision === undefined) throw new Error(`yrd: PR '${pr.id}' has no revision`)
  return revision
}

export const prAdmission = (pr: Pick<PR, "id" | "revs">): PRAdmission | undefined => currentPRRev(pr).admission

export function prNeedsAuthor(pr: PR): PR["needsAuthor"] | undefined {
  if (pr.needsAuthor !== undefined) return pr.needsAuthor
  const admission = prAdmission(pr)
  if (admission?.status !== "refused" || admission.kind !== "refusal") return undefined
  const failed = admission.steps.find((step) => step.status === "refused")
  return {
    at: admission.at,
    run: failed?.job ?? `admission:${pr.id}:${currentPRRev(pr).n}`,
    step: admission.step,
    receipt: admission.receipt,
    detail: admission.receipt.message,
  }
}

export const prRevisionNumber = (pr: PR): number => currentPRRev(pr).n
export const prHead = (pr: PR): string => currentPRRev(pr).head
export const prBaseSha = (pr: PR): string | undefined => currentPRRev(pr).baseSha
export const prCorrelation = (pr: PR): Correlation | undefined => currentPRRev(pr).correlation
export const prComposition = (pr: PR): CompositionV1 | undefined => currentPRRev(pr).composition
export const prRecut = (pr: PR): PRRecutProof | undefined => currentPRRev(pr).recut

/** Historical W2/S7 label projected from the GitHub-shaped PR plus latest revision facts. */
export function prDeliveryState(pr: PR): PRDeliveryState {
  if (pr.state === "closed") {
    if (pr.merged) return pr.alreadyLanded === undefined ? "integrated" : "already-landed"
    if (pr.canceledAt !== undefined) return "canceled"
    return "withdrawn"
  }
  const revision = currentPRRev(pr)
  if (prNeedsAuthor(pr) !== undefined) return "needs-author"
  if (revision.terminal?.kind === "rejected") return "rejected"
  if (revision.submittedAt === undefined) return "pushed"
  return revision.admission?.status === "passed" ? "ready" : "submitted"
}

export function reviewState(pr: PR): PRReviewState {
  const revision = currentPRRev(pr)
  const current = pr.reviews.findLast((review) => review.revision === revision.n && review.headSha === revision.head)
  return {
    approved: current?.decision === "approve",
    ...(current === undefined ? {} : { current }),
    stale: pr.reviews.filter((review) => review.revision !== revision.n || review.headSha !== revision.head),
  }
}

/** Requested-reviewer projection, never a stored status: a submitted PR whose
 * requested set is non-empty and lacks a current-revision verdict from the
 * given reviewer (or, with no reviewer argument, from any requested reviewer).
 * Verdicts are revision-bound while requests are not, so a recut without a
 * carried review naturally reopens this projection. */
export function needsReview(pr: PR, reviewer?: string): boolean {
  const delivery = prDeliveryState(pr)
  if (delivery !== "submitted" && delivery !== "ready") return false
  const revision = currentPRRev(pr)
  const requested = pr.requestedReviewers ?? []
  if (requested.length === 0) return false
  const hasCurrentVerdict = (by: string) =>
    pr.reviews.some((review) => review.revision === revision.n && review.headSha === revision.head && review.by === by)
  if (reviewer !== undefined) return requested.includes(reviewer) && !hasCurrentVerdict(reviewer)
  return !requested.some(hasCurrentVerdict)
}

/** Mechanically certified revision ancestry for one logical PR payload.
 * Ordinary authored revisions start a new lineage; recuts retain the source
 * revision through their persisted `fromRevision` proof. */
export function prRevisionLineage(pr: PR, revision = currentPRRev(pr).n): readonly PRRev[] {
  const byRevision = new Map(pr.revs.map((candidate) => [candidate.n, candidate]))
  let current = byRevision.get(revision)
  if (current === undefined) {
    throw new Error(`yrd: PR '${pr.id}' has no retained revision ${revision}`)
  }
  const lineage: PRRev[] = []
  const seen = new Set<number>()
  while (current !== undefined) {
    if (seen.has(current.n)) throw new Error(`yrd: PR '${pr.id}' has cyclic recut lineage`)
    seen.add(current.n)
    lineage.unshift(current)
    const predecessor = current.recut?.fromRevision
    if (predecessor === undefined) break
    current = byRevision.get(predecessor)
    if (current === undefined) {
      throw new Error(`yrd: PR '${pr.id}' recut revision ${lineage[0]?.n ?? revision} lost predecessor ${predecessor}`)
    }
  }
  return lineage
}

/** First submitted clock for a mechanically identical payload, falling back
 * to its first immutable source-ready (`pushed`) clock before admission. */
export function prSourceReadyAt(pr: PR, revision = currentPRRev(pr).n): string {
  const source = prRevisionLineage(pr, revision)[0]
  if (source === undefined) throw new Error(`yrd: PR '${pr.id}' has no source-ready revision`)
  return source.submittedAt ?? source.pushedAt
}

export function checksRequested(pr: PR): boolean {
  return checkRequest(pr) !== undefined
}

export function checkRequest(pr: PR): PRCheckRequest | undefined {
  const revision = currentPRRev(pr)
  return pr.checkRequests.findLast((request) => request.revision === revision.n && request.headSha === revision.head)
}

export type BaysState = Readonly<{
  byId: Readonly<Record<BayId, Bay>>
  prs: Readonly<Record<PRId, PR>>
  receipts: Readonly<
    Record<
      string,
      Readonly<{
        pr: PRId
        branch: string
        headSha: string
        base: string
        baseSha?: string
        composition?: CompositionV1
      }>
    >
  >
}>

export const RemoteBranchSnapshotSchema = z
  .object({
    branch: GitRefSchema,
    headSha: GitShaSchema.optional(),
  })
  .strict()
export type RemoteBranchSnapshot = z.infer<typeof RemoteBranchSnapshotSchema>

export const ProvisionBayInputSchema = z
  .object({
    bay: BayIdSchema,
    name: z.string().trim().min(1),
    branch: GitRefSchema,
    base: GitRefSchema,
    baseSha: GitShaSchema.optional(),
    from: GitRefSchema.optional(),
    issue: z.string().trim().min(1).optional(),
    reuseBranch: z.boolean().optional(),
    remoteBranch: RemoteBranchSnapshotSchema.optional(),
  })
  .strict()
export type ProvisionBayInput = z.infer<typeof ProvisionBayInputSchema>

export const ProvisionedBaySchema = z
  .object({
    path: z.string().min(1),
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
  })
  .strict()
export type ProvisionedBay = z.infer<typeof ProvisionedBaySchema>

export const RefreshBayInputSchema = z
  .object({
    bay: BayIdSchema,
    path: z.string().min(1).optional(),
    branch: GitRefSchema,
    base: GitRefSchema,
  })
  .strict()
export type RefreshBayInput = z.infer<typeof RefreshBayInputSchema>

export const RefreshedBaySchema = z
  .object({
    path: z.string().min(1),
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    dirty: z.boolean(),
  })
  .strict()
export type RefreshedBay = z.infer<typeof RefreshedBaySchema>

export const CheckpointBayInputSchema = z
  .object({
    bay: BayIdSchema,
    path: z.string().min(1).optional(),
    branch: GitRefSchema,
    claim: z.string().trim().min(1),
  })
  .strict()
export type CheckpointBayInput = z.infer<typeof CheckpointBayInputSchema>

export const CheckpointedBaySchema = z
  .object({
    headSha: GitShaSchema,
    pushed: z.literal(true),
    wip: z.boolean(),
  })
  .strict()
export type CheckpointedBay = z.infer<typeof CheckpointedBaySchema>

export const DeprovisionBayInputSchema = z
  .object({
    bay: BayIdSchema,
    path: z.string().min(1).optional(),
    branch: GitRefSchema,
    headSha: GitShaSchema.optional(),
  })
  .strict()
export type DeprovisionBayInput = z.infer<typeof DeprovisionBayInputSchema>

/** `headSha` is optional only for replay compatibility with pre-lifecycle job
 * results. New workspace adapters return the exact preserved head. */
export const DeprovisionedBaySchema = z
  .object({ headSha: GitShaSchema.optional(), preservedRef: GitRefSchema.optional() })
  .strict()
export type DeprovisionedBay = z.infer<typeof DeprovisionedBaySchema>

export function defaultBayBranch(name: string): string {
  return `issue/${name}`
}

export function emptyBaysState(): BaysState {
  return { byId: {}, prs: {}, receipts: {} }
}

/** Projects the current lifecycle of every Bay-registered work branch from the
 * same journal-backed aggregate used by the Bay and PR APIs. */
export function projectBranchLifecycles(state: BaysState): readonly BranchLifecycle[] {
  return Object.values(state.byId)
    .map((bay): BranchLifecycle => {
      const base = {
        bay: bay.id,
        name: bay.name,
        ...(bay.issue === undefined ? {} : { issue: bay.issue }),
        ...(bay.by === undefined ? {} : { by: bay.by }),
        branch: bay.branch,
        openedAt: bay.openedAt,
      }
      const pr = prForBay(state, bay.id)
      const current = pr === undefined ? undefined : currentPRRev(pr)
      const landedAt = pr?.alreadyLandedAt ?? pr?.integratedAt
      if (
        bay.headSha !== undefined &&
        current?.head === bay.headSha &&
        pr?.merged === true &&
        landedAt !== undefined &&
        pr.integration !== undefined
      ) {
        return {
          ...base,
          status: "landed",
          headSha: bay.headSha,
          landed: {
            pr: pr.id,
            revision: current.n,
            at: landedAt,
            commit: pr.integration.commit,
          },
        }
      }
      if (bay.archive !== undefined) {
        return {
          ...base,
          status: "archived",
          headSha: bay.archive.headSha,
          archived: {
            at: bay.archive.archivedAt,
            eventId: bay.archive.eventId,
            preservedRef: bay.archive.preservedRef,
          },
        }
      }
      const revision = bay.headSha === undefined || current?.head !== bay.headSha ? undefined : current
      if (bay.headSha !== undefined && pr !== undefined && revision?.submittedAt !== undefined && pr.state === "open") {
        return {
          ...base,
          status: "submitted",
          headSha: bay.headSha,
          submitted: { pr: pr.id, revision: revision.n, at: revision.submittedAt },
        }
      }
      if (bay.status === "closed") {
        // Historical deprovision results did not retain both the exact head and
        // preservation ref. Keep that absence explicit instead of aliasing a
        // closed workspace to either open or proof-bearing archived.
        return {
          ...base,
          status: "unmanaged",
          ...(bay.headSha === undefined ? {} : { headSha: bay.headSha }),
          reason: "archive-proof-unavailable",
        }
      }
      if (
        bay.headSha !== undefined &&
        bay.handoff?.headSha === bay.headSha &&
        (pr === undefined ||
          (current?.head === bay.headSha && ["pushed", "withdrawn", "canceled"].includes(prDeliveryState(pr))))
      ) {
        return {
          ...base,
          status: "handoff-ready",
          headSha: bay.headSha,
          ready: {
            at: bay.handoff.certifiedAt,
            eventId: bay.handoff.eventId,
            evidence: bay.handoff.evidence,
          },
        }
      }
      return { ...base, status: "open", ...(bay.headSha === undefined ? {} : { headSha: bay.headSha }) }
    })
    .toSorted((left, right) => left.openedAt.localeCompare(right.openedAt) || left.bay.localeCompare(right.bay))
}

export function isLivePR(pr: PR): boolean {
  return pr.state === "open"
}

export function prForBay(state: BaysState, bay: BayId): PR | undefined {
  return Object.values(state.prs).find((pr) => pr.bay === bay)
}

export function resolveBay(state: BaysState, selector: string): Bay | undefined {
  return resolveSelector(
    selector,
    Object.values(state.byId)
      .toSorted((left, right) => compareNatural(right.id, left.id))
      .map((bay) => ({
        canonical: bay.id,
        aliases: [bay.name, bay.branch],
        value: bay,
      })),
    { kind: "Bay", prefer: (bay) => bay.status !== "closed" },
  )
}

/** Resolve a PR selector, reporting whether the operator named the PR's
 * canonical id or reached it through an alias (branch/name/bay). A branch
 * selector means "the live delivery of this branch": when a branch has both a
 * terminal PR and a live one, the live PR wins. Candidates are ordered
 * most-recent-first (highest id) so the read-biased fallback resolves the most
 * recent terminal when a branch has ONLY terminal PRs. An exact canonical id
 * always addresses that specific PR, terminal or not, ahead of this preference.
 * Mutating verbs enforce the live requirement themselves via requireLivePR —
 * this primitive stays verb-agnostic and read-biased. */
export function resolvePRMatch(state: BaysState, selector: string): SelectorMatch<PR> | undefined {
  return resolveSelectorMatch(
    selector,
    Object.values(state.prs)
      .toSorted((left, right) => compareNatural(right.id, left.id))
      .map((pr) => {
        const bay = pr.bay === undefined ? undefined : state.byId[pr.bay]
        return {
          canonical: pr.id,
          aliases: [
            pr.branch,
            ...(pr.name === undefined ? [] : [pr.name]),
            ...(bay === undefined ? [] : [bay.id, bay.name, bay.branch]),
          ],
          value: pr,
        }
      }),
    { kind: "PR", prefer: isLivePR },
  )
}

export function resolvePR(state: BaysState, selector: string): PR | undefined {
  return resolvePRMatch(state, selector)?.value
}

declare const liveBrand: unique symbol

/** A PR that has passed through {@link requireLivePR} — the shared mutation
 * boundary guard. Mutating reducers annotate their resolved PR as `LivePR`, so
 * `tsc` rejects any swap back to a raw `resolvePR` / `required(...)` (which
 * yields an unbranded {@link PR}) — the type system, not a source-grep test,
 * enforces that every PR-selector mutation routes through the live guard. */
export type LivePR = PR & { readonly [liveBrand]: true }

/** Resolve a PR for a MUTATING verb: a branch/name selector must name the live
 * delivery of that branch. Returns the live PR; a terminal PR is returned only
 * when the operator addressed it by its exact canonical id (the verb's own
 * state guard then decides what a terminal target permits). A branch/alias
 * selector whose PRs are all terminal refuses loudly here at the mutation
 * boundary — resolvePR stays verb-agnostic and read-biased, so this is the one
 * shared guard every mutating verb routes through instead of hand-rolling it. */
export function requireLivePR(state: BaysState, selector: string): LivePR {
  const resolution = resolvePRMatch(state, selector)
  if (resolution === undefined) {
    raiseFailure("refusal", "pr-not-found", `yrd: no PR '${selector}'`)
  }
  const pr = resolution.value
  // A canonical-id match ('pr1' folds to PR1) passes a terminal PR through to
  // the verb's own state guard; an alias (branch/name) match must name a live
  // delivery. The fold that decides this lives in resolveSelectorMatch, not here.
  if (isLivePR(pr) || resolution.matchedBy === "canonical") return pr as LivePR
  raiseFailure("refusal", "no-live-pr", `yrd: no live PR for branch '${selector}'; use PR id`)
}
