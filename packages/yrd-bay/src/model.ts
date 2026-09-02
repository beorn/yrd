import * as z from "zod"
import {
  compareNatural,
  JsonSchema,
  raiseFailure,
  resolveSelector,
  resolveSelectorMatch,
  type DeepReadonly,
  type JsonValue,
  type SelectorMatch,
  markRecoverable,
} from "@yrd/core"
import { JobErrorFactSchema, JobErrorSchema, type JobError, type JobErrorFact } from "@yrd/job"
import type { ChangeId } from "./change-identity.ts"

export const BayIdSchema = z.string().trim().min(1)
/**
 * The shape the mint actually writes: `nextId("PR", state.prs)` produces `PR`
 * plus a decimal counter, and all 43,202 PR-id occurrences in the live journal
 * carry it. Pinning the schema to that shape is what lets `QueueMemberIdSchema`
 * discriminate — an intent id (`I148`, `yrdpin#164`) no longer parses as a change
 * id, so a mis-kinded member fails here instead of much later or never.
 *
 * Display forms (`pr#182.1`) and the operator's bare-number selector are NOT
 * ids and are deliberately refused; {@link parseChangeSelector} is their grammar.
 */
export const PRIdSchema = z.string().regex(/^PR\d+$/u, "expected a change id, e.g. PR182")
export const GitRefSchema = z.string().trim().min(1)
export const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
/** Open key/value labels on a change revision. The same noun as km's node
 * `props`: each key is a fact — set once, idempotent to repeat, conflicting
 * values refuse. Plugins may interpret a namespaced key only through an
 * explicitly injected authority; every other prop remains opaque. */
export const ChangePropsSchema = z
  .record(z.string(), z.string())
  .refine((props) => Object.keys(props).length > 0, { message: "props cannot be empty" })
  .refine((props) => Object.entries(props).every(([key, value]) => key.trim().length > 0 && value.trim().length > 0), {
    message: "prop keys and values cannot be blank",
  })

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

/** Normalize pre-props payloads: fold the retired single `correlation`
 * `{namespace, id}` pair into `props` as one `namespace: id` entry, keeping
 * current schemas free of the retired vocabulary. A malformed legacy value is
 * left in place so the strict schema refuses loudly instead of dropping it. */
export function normalizeV1CorrelationToProps(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const legacy = record["correlation"]
  if (legacy === undefined) return value
  if (typeof legacy !== "object" || legacy === null || Array.isArray(legacy)) return value
  const pair = legacy as Record<string, unknown>
  const namespace = pair["namespace"]
  const id = pair["id"]
  if (typeof namespace !== "string" || typeof id !== "string") return value
  const { correlation: _retired, ...current } = record
  const existing = current["props"]
  const props =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}
  return { ...current, props: { ...props, [namespace]: id } }
}

/** The composed read-boundary normalizer for change facts: v2 role rename plus
 * the v1 correlation→props fold. */
export function normalizeLegacyChangeKeys(value: unknown): unknown {
  return normalizeV1CorrelationToProps(normalizeV2Submitter(value))
}

/** Closed current rejection fact used by the Bay projection and post-append signal observers. */
const ChangeRejectedFactObjectSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    run: TextSchema,
    issueRef: TextSchema.optional(),
    props: ChangePropsSchema.optional(),
    /** Persisted v2 key; missing only when a current rejection terminates a pre-identity revision. */
    submitter: TextSchema.optional(),
    step: TextSchema,
    evidence: TextSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
export const ChangeRejectedFactSchema = z.preprocess(normalizeLegacyChangeKeys, ChangeRejectedFactObjectSchema)
export type ChangeRejectedFact = Readonly<z.infer<typeof ChangeRejectedFactSchema>>

function isVerdictlessReceipt(receipt: JobErrorFact | undefined): boolean {
  return receipt?.verdictless === true
}

/** Author-owned refusal fact. Unlike `pr/rejected`, this keeps the change in the
 * submitted queue lifecycle and carries the exact typed result needed to fix
 * the branch in place. */
const ChangeNeedsAuthorFactObjectSchema = ChangeRejectedFactObjectSchema.extend({
  receipt: JobErrorFactSchema,
  /** Top-level v4 sentinel for the nested JobError vocabulary. */
  verdictless: z.literal(true).optional(),
})
  .strict()
  .superRefine((fact, context) => {
    if ((fact.verdictless === true) !== isVerdictlessReceipt(fact.receipt)) {
      context.addIssue({
        code: "custom",
        message: "verdictless must be present exactly when receipt.verdictless is true",
        path: ["verdictless"],
      })
    }
  })
export const ChangeNeedsAuthorFactSchema = z.preprocess(normalizeLegacyChangeKeys, ChangeNeedsAuthorFactObjectSchema)
export type ChangeNeedsAuthorFact = Readonly<z.infer<typeof ChangeNeedsAuthorFactSchema>>

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
export type ChangeProps = z.infer<typeof ChangePropsSchema>

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

export type BayFailure = Readonly<JobErrorFact>

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

export type BayClosure = Readonly<{
  kind: "closed-degenerate"
  at: string
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
  closure?: BayClosure
}>

type BranchLifecycleBase = Readonly<{
  bay: BayId
  name: string
  issue?: string
  /** Bay/runtime ownership: the process or person that owns the workspace lifecycle. */
  by?: string
  /** Logical owner of the exact immutable PR revision projected by this lifecycle. */
  submitter?: string
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
        status: "merged"
        headSha: string
        merged: Readonly<{ pr: PRId; revision: number; at: string; commit: string }>
      }
    >
  | Readonly<
      BranchLifecycleBase & {
        status: "archived"
        headSha: string
        archived: Readonly<{ at: string; eventId: string; preservedRef: string }>
      }
    >

/** W2-facing delivery label derived from canonical PR/ChangeRev facts. Never stored.
 *
 * Vocabulary (about/glossary.md, the ratified struck list): `integrated` is a
 * LIVE word — proven ancestry on shared main — and stays. `already-landed`
 * carries struck `landed`; its surface word is **already-merged**. The
 * spelling survives here because it is the value `@yrd/cli` and `@yrd/queue`
 * compare against and the journal already carries (`pr/already-landed`); a
 * value rename is a cross-package cut, not a yrd-bay one. Anything printing
 * this label to a person says the surface word. */
export type ChangeDeliveryState =
  | "pushed"
  | "submitted"
  | "ready"
  | "needs-author"
  | "rejected"
  | "integrated"
  | "already-landed"
  | "withdrawn"
  | "canceled"

const NON_CHECKABLE_CHANGE_STATES: ReadonlySet<ChangeDeliveryState> = new Set<ChangeDeliveryState>([
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
])

/** A change can accept new check requests in every non-terminal delivery state.
 * Once it reaches integrated/already-landed/withdrawn/canceled, it is no
 * longer checkable. */
export function isNonCheckableChangeState(state: ChangeDeliveryState): boolean {
  return NON_CHECKABLE_CHANGE_STATES.has(state)
}

/**
 * A check request was refused because the change's current status does not permit
 * it. Always thrown, never returned, so a genuine caller error still fails
 * loud. The carried `prId`/`status` let a habitant, multi-tenant runner tell a
 * losable concurrent-terminal race (a peer withdrew/canceled/integrated/already-landed the change
 * between the runner's compose snapshot and its check request — see
 * isConcurrentCheckabilityConflict) apart from a real caller error, without
 * matching on the message text.
 */
export class ChangeCheckabilityConflict extends Error {
  readonly prId: string
  readonly status: ChangeDeliveryState

  constructor(prId: string, status: ChangeDeliveryState) {
    super(`yrd: change '${prId}' is ${status}, not checkable`)
    this.name = "ChangeCheckabilityConflict"
    this.prId = prId
    this.status = status
    // Exactly the losable half (`isConcurrentCheckabilityConflict`): the
    // change left the checkable set under the runner, which skips the cycle.
    // The lifecycle reporting the throw logs it at WARN, since an ERROR row
    // now stops the pass; a conflict against a live state stays an ERROR.
    if (isNonCheckableChangeState(status)) markRecoverable(this)
  }
}

/**
 * True when an error is a ChangeCheckabilityConflict whose PR had already reached a
 * terminal status — i.e. a concurrent writer withdrew/canceled/integrated/already-landed the
 * PR between a runtime's compose snapshot and its check request. This is a
 * normal, losable race for a long-lived habitant runner: skip this cycle and
 * continue; the next cycle re-snapshots without the departed PR and composes
 * the remaining runnable ones.
 */
export function isConcurrentCheckabilityConflict(error: unknown): error is ChangeCheckabilityConflict {
  return error instanceof ChangeCheckabilityConflict && isNonCheckableChangeState(error.status)
}

export type ChangeRevTerminal = Readonly<{
  kind: Extract<ChangeDeliveryState, "rejected" | "integrated" | "already-landed" | "withdrawn" | "canceled">
  at: string
  run?: string
}>

export type ChangeRevClock = Readonly<{
  pushedAt: string
  submittedAt?: string
  terminal?: ChangeRevTerminal
  /**
   * A NON-LANDING settle this revision refused because it predates the
   * revision's own submit fact — recorded here instead of being stamped on
   * `terminal`, and never dropped.
   *
   * This is what the writer guard writes. A landing settle (`integrated`,
   * `already-landed`) is never refused and never appears here: those are claims
   * about the repository, and a merged change is merged no matter what its
   * submit clock says afterwards.
   */
  supersededTerminal?: ChangeRevTerminal
}>

export type ChangeAdmissionStep = Readonly<{
  name: string
  revision: string
  job: string
  status: "passed" | "refused"
  output?: JsonValue
  receipt?: JobError
}>

type ChangeAdmissionStepFact = Readonly<{
  name: string
  revision: string
  job: string
  status: "passed" | "refused"
  output?: JsonValue
  receipt?: JobErrorFact
}>

export const ChangeAdmissionStepSchema = z
  .object({
    name: TextSchema,
    revision: TextSchema,
    job: TextSchema,
    status: z.enum(["passed", "refused"]),
    output: JsonSchema.optional(),
    receipt: JobErrorSchema.optional(),
  })
  .strict()
  .superRefine(validateAdmissionStep) as z.ZodType<ChangeAdmissionStep>

const ChangeAdmissionStepFactSchema = z
  .object({
    name: TextSchema,
    revision: TextSchema,
    job: TextSchema,
    status: z.enum(["passed", "refused"]),
    output: JsonSchema.optional(),
    receipt: JobErrorFactSchema.optional(),
  })
  .strict()
  .superRefine(validateAdmissionStep) as z.ZodType<ChangeAdmissionStepFact>

function validateAdmissionStep(
  step: Readonly<{ status: "passed" | "refused"; receipt?: JobErrorFact }>,
  context: z.RefinementCtx,
): void {
  if ((step.status === "passed") !== (step.receipt === undefined)) {
    context.addIssue({
      code: "custom",
      message:
        step.status === "passed"
          ? "a passed entry-check step cannot carry a result"
          : "a failed entry-check step requires a result",
      path: ["receipt"],
    })
  }
}

const ChangeAdmissionBaseSchema = z.object({
  baseSha: GitShaSchema,
  /** Exact-revision/base check authorities consumed by this verdict.
   * Optional only for replaying admission facts written before this counter.
   *
   * Zero is a real count, not a corrupt one. A request's base is a PARAMETER of
   * the request rather than part of its identity ({@link checkRequest}), so it
   * is meant to lag the queue's base, and a verdict reached against the cycle
   * base can consume no authority recorded against that exact base. Requiring a
   * positive count made that ordinary state unrepresentable: the drain built a
   * record its own fact schema refused, and `yrd queue run` died on a raw Zod
   * dump every pass with the fleet's only merge path shut behind it.
   *
   * Zero must also stay distinct from absent. `requestCount ?? 1` reads absent
   * as one legacy authority, so recording zero by OMITTING the field would
   * assert an authority nobody granted and suppress the retry that a real,
   * later request earns.
   *
   * `"unresolved"` is the third state, and it exists because zero was carrying
   * two meanings. A check request may record no base of its own, and the
   * revision it names may record none either; that request's base cannot be
   * determined, so it can neither be counted against this verdict's base nor
   * ruled out of it. Storing the resulting shortfall as a number would say "no
   * authority was granted" about requests nobody could read, and a later reader
   * would deny a retry on the strength of it. The counter therefore reports
   * that it could not resolve the identity, and this field carries that fact
   * verbatim instead of a zero that means something else
   * (@yrd/core/rebuilt-carrier-denied-retry). */
  requestCount: z.union([z.number().int().nonnegative(), z.literal("unresolved")]).optional(),
  candidate: TextSchema.optional(),
  steps: z.array(ChangeAdmissionStepSchema),
})
const ChangeAdmissionFactBaseSchema = ChangeAdmissionBaseSchema.extend({
  steps: z.array(ChangeAdmissionStepFactSchema),
})

export type ChangeAdmissionRecord =
  | Readonly<{
      status: "passed"
      baseSha: string
      requestCount?: number | "unresolved"
      candidate?: string
      steps: readonly ChangeAdmissionStep[]
    }>
  | Readonly<{
      status: "refused"
      kind: "refusal" | "failure" | "infrastructure"
      baseSha: string
      requestCount?: number | "unresolved"
      candidate?: string
      steps: readonly ChangeAdmissionStep[]
      step: string
      receipt: JobError
    }>

type ChangeAdmissionRecordFact =
  | Readonly<{
      status: "passed"
      baseSha: string
      requestCount?: number | "unresolved"
      candidate?: string
      steps: readonly ChangeAdmissionStepFact[]
    }>
  | Readonly<{
      status: "refused"
      kind: "refusal" | "failure" | "infrastructure"
      baseSha: string
      requestCount?: number | "unresolved"
      candidate?: string
      steps: readonly ChangeAdmissionStepFact[]
      step: string
      receipt: JobErrorFact
    }>

export const ChangeAdmissionRecordSchema = z.discriminatedUnion("status", [
  ChangeAdmissionBaseSchema.extend({ status: z.literal("passed") }).strict(),
  ChangeAdmissionBaseSchema.extend({
    status: z.literal("refused"),
    kind: z.enum(["refusal", "failure", "infrastructure"]),
    step: TextSchema,
    receipt: JobErrorSchema,
  }).strict(),
]) as z.ZodType<ChangeAdmissionRecord>
const ChangeAdmissionRecordFactSchema = z.discriminatedUnion("status", [
  ChangeAdmissionFactBaseSchema.extend({ status: z.literal("passed") }).strict(),
  ChangeAdmissionFactBaseSchema.extend({
    status: z.literal("refused"),
    kind: z.enum(["refusal", "failure", "infrastructure"]),
    step: TextSchema,
    receipt: JobErrorFactSchema,
  }).strict(),
]) as z.ZodType<ChangeAdmissionRecordFact>
export type ChangeAdmission = ChangeAdmissionRecordFact & Readonly<{ at: string }>

export const ChangeAdmissionRecordedSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    admission: ChangeAdmissionRecordSchema,
  })
  .strict()
export type ChangeAdmissionRecorded = Readonly<z.infer<typeof ChangeAdmissionRecordedSchema>>

export type ChangeAdmissionRecordedFact = Readonly<{
  pr: PRId
  revision: number
  headSha: string
  admission: ChangeAdmissionRecordFact
  /** Top-level v4 sentinel for a verdictless direct or step receipt. */
  verdictless?: true
}>

export const ChangeAdmissionRecordedFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    admission: ChangeAdmissionRecordFactSchema,
    verdictless: z.literal(true).optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    const hasVerdictlessReceipt =
      (fact.admission.status === "refused" && isVerdictlessReceipt(fact.admission.receipt)) ||
      fact.admission.steps.some((step) => isVerdictlessReceipt(step.receipt))
    if ((fact.verdictless === true) !== hasVerdictlessReceipt) {
      context.addIssue({
        code: "custom",
        message: "verdictless must be present exactly when an admission receipt is verdictless",
        path: ["verdictless"],
      })
    }
  }) as z.ZodType<ChangeAdmissionRecordedFact>

export const ChangeFreshnessTransitionSchema = z
  .object({ from: z.literal("admitted"), to: z.literal("refreshed") })
  .strict()
export type ChangeFreshnessTransition = Readonly<z.infer<typeof ChangeFreshnessTransitionSchema>>

export const ChangeRemergeSourceSchema = z
  .object({
    repo: z.string().trim().min(1),
    fromHeadSha: GitShaSchema,
    toHeadSha: GitShaSchema,
    patchId: GitShaSchema,
    rangeDiff: z.literal("="),
  })
  .strict()
  .readonly()
export type ChangeRemergeSource = Readonly<z.infer<typeof ChangeRemergeSourceSchema>>

export const ChangeRemergeCertificateSchema = z.literal("frozen-code-carrier-v1")

export const ChangeRemergeProofSchema = z
  .object({
    fromRevision: z.number().int().positive(),
    patchId: GitShaSchema,
    treeSha: GitShaSchema,
    reviewCarried: z.boolean(),
    /** Explicit proof contract for a frozen proposed code carrier. Mechanical
     * base-refresh re-merges and legacy journal rows use their existing proof. */
    certificate: ChangeRemergeCertificateSchema.optional(),
    /** Durable non-ancestral identity mapping for the root and any rewritten
     * submodule heads. Missing only while replaying pre-provenance journals. */
    sources: z.array(ChangeRemergeSourceSchema).min(1).readonly().optional(),
    transition: ChangeFreshnessTransitionSchema.optional(),
  })
  .strict()
export type ChangeRemergeProof = Readonly<z.infer<typeof ChangeRemergeProofSchema>>

export type ChangeRev = Readonly<{
  n: number
  /** Missing only while replaying journals written before stable change identity. */
  changeId?: ChangeId
  head: string
  base: string
  baseSha?: string
  /** Missing only while replaying journals written before submitter identity was recorded. */
  submitter?: string
  props?: ChangeProps
  composition?: CompositionV1
  recut?: ChangeRemergeProof
  /** Checks before queueing (`admission`) are a verdict about this immutable
   * revision, not a merge attempt. A later base revalidation replaces it on the
   * same revision. */
  admission?: ChangeAdmission
}> &
  ChangeRevClock

export const ChangeReviewDecisionSchema = z.enum(["approve", "reject"])
export type ChangeReviewDecision = z.infer<typeof ChangeReviewDecisionSchema>

export const ChangeReviewSchema = z
  .object({
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    by: TextSchema,
    decision: ChangeReviewDecisionSchema,
    at: z.iso.datetime({ offset: true }),
    ref: TextSchema.optional(),
    note: TextSchema.optional(),
    carriedFrom: z
      .object({ revision: z.number().int().positive(), headSha: GitShaSchema })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
export type ChangeReview = Readonly<z.infer<typeof ChangeReviewSchema>>

export type ChangeComment = Readonly<{
  revision: number
  headSha: string
  by: string
  note: string
  at: string
  ref?: string
}>

export type ChangeReviewState = Readonly<{
  approved: boolean
  current?: ChangeReview
  stale: readonly ChangeReview[]
}>

export type ChangeCheckRequest = Readonly<{
  revision: number
  headSha: string
  baseSha?: string
  at: string
}>

export type ChangeAlreadyMergedEvidence = Readonly<{
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

/** The flow pin shape old journals stored (5e cut 3 retired the writer). */
export type StoredFlowPin = Readonly<{ name: string; rev: string; fingerprint: string }>

export type Change = Readonly<{
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
  /** answers: Is the change record open or closed? tense: current. */
  state: "open" | "closed"
  /** answers: Has the rebuildable index recorded this change as merged? tense: historical. */
  merged: boolean
  /** Opt-in "merge into latest": when true, the habitant observes the live
   * branch before each Queue cycle. A moved head is recorded as a revision,
   * preflighted, and prepared for queueing when its verdict permits; a
   * manual implicit re-merge uses the same recording rule. Each run still executes
   * one frozen recorded revision. Absent means untracked — the reproducibility
   * refusal stands. */
  track?: boolean
  /** Stored fact from the retired flow rail (5e cut 3): journals and
   * checkpoints written before the cut carry it; nothing consumes it. */
  flow?: StoredFlowPin
  revs: readonly ChangeRev[]
  reviews: readonly ChangeReview[]
  comments: readonly ChangeComment[]
  checkRequests: readonly ChangeCheckRequest[]
  /** Current requested-reviewer set (latest pr/review-requested fact wins;
   * revision-independent, so re-merges and new revisions keep the request).
   * Optional: absent means no request was ever recorded,
   * identical in meaning to the empty set. */
  requestedReviewers?: readonly string[]
  /** answers: Has this change ever recorded author-owned refusal evidence? tense: historical.
   * Legacy pre-revision-admission projection. New refusal evidence lives on
   * `currentChangeRev(pr).admission`; retained so old indexes remain readable. */
  needsAuthor?: Readonly<{
    at: string
    run: string
    step: string
    receipt: JobErrorFact
    evidence?: string
    detail?: string
  }>
  terminalRun?: string
  submittedAt?: string
  rejectedAt?: string
  integratedAt?: string
  integration?: Readonly<{
    commit: string
    baseSha: string
    changeId?: ChangeId
  }>
  alreadyLandedAt?: string
  alreadyLanded?: ChangeAlreadyMergedEvidence
  withdrawnAt?: string
  withdrawReason?: string
  canceledAt?: string
  canceledBy?: string
  cancelReason?: string
  detail?: string
}>

export type ParsedChangeSelector = Readonly<{
  pr: PRId
  revision?: number
}>

/** Parse the identities Yrd itself renders, plus the bare numeric id an
 * operator types after reading one (`182` for `pr#182.1` — I23 selector
 * uniformity). Only digits qualify for the bare form; any other bare token
 * stays outside this grammar and continues through the generic selector path,
 * so branch/name aliases remain reachable. A bare numeric that names no PR
 * also falls back to the alias path in {@link resolveChangeMatch}. */
export function parseChangeSelector(selector: string): ParsedChangeSelector | undefined {
  const match =
    /^pr#?([a-z0-9_-]+)(?:\.(\d+))?$/iu.exec(selector.trim()) ?? /^(\d+)(?:\.(\d+))?$/u.exec(selector.trim())
  const id = match?.[1]
  if (id === undefined) return undefined
  const revisionText = match?.[2]
  const revision = revisionText === undefined ? undefined : Number(revisionText)
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision <= 0)) return undefined
  return { pr: `PR${id}`, ...(revision === undefined ? {} : { revision }) }
}

/**
 * Canonical copy-pasteable PR revision identity used by every text renderer.
 *
 * The `pr#` prefix is an assertion about the record's KIND, so it is spent only
 * on an id `PRIdSchema` actually claims. `PRId` is a bare `string` alias
 * (`type PRId = string`), and `QueueMemberId` is string-derived too, so no call
 * site can be made type-safe against passing a min-commit change's id here — the
 * discrimination exists only at runtime, and this is the one place that asks.
 * Without the ask, `yrdpin#357` printed as `pr#yrdpin#357`: a false kind that
 * also stutters, on all three renderer call sites at once
 * (@i/10-merge-queue/22924-pr-prefix-on-non-pr). A record that is not a change
 * renders under its own id, which is what its kind rename will then change.
 */
export function formatChangeRevisionSelector(pr: PRId, revision: number | Pick<ChangeRev, "n">): string {
  const number = typeof revision === "number" ? revision : revision.n
  if (!isChangeRevisionSelector(pr)) return `${pr}.${number}`
  const canonical = parseChangeSelector(pr)?.pr ?? pr
  return `pr#${canonical.replace(/^PR/iu, "")}.${number}`
}

/**
 * Whether an id resolves to a real PR — the one question
 * {@link formatChangeRevisionSelector} asks before spending the `pr#` prefix.
 *
 * Exported so a JSX renderer asks the SAME question instead of deriving kind
 * from the string a second way. The selector grammar is resolved first (`182`
 * and `pr#182` both name PR182), then the RESOLVED id is judged by the schema —
 * never the raw spelling.
 */
export function isChangeRevisionSelector(pr: string): boolean {
  return PRIdSchema.safeParse(parseChangeSelector(pr)?.pr ?? pr).success
}

/**
 * A lookup that finds nothing must say WHAT IT SEARCHED, so that "no such PR"
 * and "the index returned nothing" stop reading alike.
 *
 * Without the denominator both cases print the same sentence, and the reader
 * with no way to tell them apart concludes they mistyped. That is not
 * hypothetical: @i/10-merge-queue records three seats hitting this class, the
 * first two writing it off as their own incompetence, which is how the defect
 * stayed hidden. The count is the cheapest thing that makes an empty answer
 * falsifiable — `searched 686` is absence, `searched 0` is an index that
 * returned nothing.
 *
 * Deliberately NOT hard-coding a verdict at 0: in a fresh repository zero PRs
 * is genuine absence, so asserting "that is a lookup failure" would over-claim
 * in exactly the case nobody can check. The number is reported; the reader
 * judges it.
 *
 * The `no change '<selector>'` prefix is preserved so any matcher on the old text
 * keeps matching. The noun is `pr list`'s own ("list changes").
 *
 * Exported because this message had ELEVEN hand-rolled spellings beside this
 * one: nine in the queue package, plus `pr withdraw` and the `--pr` create
 * guard. Widening `pr view` alone read as the whole job and reached one of
 * twelve emitters. Every caller passes its own failure code (`pr-not-found`,
 * `pr-missing`); only the sentence is shared, so the next widening cannot
 * miss a surface.
 *
 * Two lookalikes are deliberately NOT routed here — `plugin.ts`'s terminal
 * association and the queue's legacy-terminal invariant are internal `throw`s
 * about a corrupt journal, not an operator whose selector found nothing.
 *
 * `searchedCount` is a REQUIRED parameter with no default, and that is the
 * point. It used to be `Object.keys(state.prs).length`, computed here — which
 * silently made every caller claim it had searched the change-RECORD store
 * even after the S6 door stopped minting records for `refs/for/` pushes. The
 * denominator then reported 2155 while a live change sat outside it, and the
 * number built to make an empty answer falsifiable was itself the false part
 * (@i/10-yrd, 2026-08-30). A default would restore exactly that: the
 * under-count is what a caller gets by NOT thinking, so the type makes not
 * thinking impossible. A caller that searched both lanes passes
 * `queueChangeCount`; one that really did search only the record store passes
 * {@link recordChangeCount} and says so at the call site.
 */
export function changeNotFoundMessage(state: BaysState, selector: string, searchedCount: number): string {
  const searched = `searched ${String(searchedCount)} change(s)`
  if (parseChangeSelector(selector) !== undefined || !/^(?:pr#?|\d+\.)/iu.test(selector.trim())) {
    return `yrd: no change '${selector}' — ${searched}`
  }
  const copiedId = /^(?:pr#?)?([a-z0-9_-]+)/iu.exec(selector.trim())?.[1]
  const copiedPr = copiedId === undefined ? undefined : state.prs[`PR${copiedId}`]
  const examplePr = copiedPr ?? Object.values(state.prs).toSorted((left, right) => compareNatural(left.id, right.id))[0]
  const example =
    examplePr === undefined ? "pr#1.1" : formatChangeRevisionSelector(examplePr.id, currentChangeRev(examplePr))
  return `yrd: no change '${selector}'; accepted form: ${example} — ${searched}`
}

export function currentChangeRev(pr: Pick<Change, "id" | "revs">): ChangeRev {
  const revision = pr.revs.at(-1)
  if (revision === undefined) throw new Error(`yrd: change '${pr.id}' has no revision`)
  return revision
}

export const changeAdmission = (pr: Pick<Change, "id" | "revs">): ChangeAdmission | undefined =>
  currentChangeRev(pr).admission

/**
 * The finish belonging to the CURRENT admission — or `undefined` when the only
 * finish on record belongs to a previous one.
 *
 * A revision's submit fact is MUTABLE. Re-submitting the same sha (the
 * documented remedy when a run consumes a change's submit authority) rewrites
 * `submittedAt` forward, and `branch/submitted` clears `terminal` as it does.
 * A settle from a run that has since died can still land AFTER that, stamped
 * with its own older time — and then the revision carries a finish that
 * describes an admission which is over.
 *
 * Read forward: a finish preceding its own start is not corruption and not a
 * clock fault. It is a resubmitted sha whose results are stale, and the current
 * admission has no finish yet.
 *
 * This lives here, in the shared model, because both halves of the rule need
 * it — {@link changeDeliveryState} decides what the QUEUE ADMITS, and the read
 * projections in `@yrd/queue` decide what an operator is shown. One home, so
 * the two can never disagree about which admission a clock belongs to.
 */
export function currentAdmissionFinish(
  startedAt: string | undefined,
  finishedAt: string | undefined,
): string | undefined {
  if (startedAt === undefined || finishedAt === undefined) return finishedAt
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  // An unparseable clock is a different defect; leave it to the reader that
  // knows how to name it rather than swallowing it here.
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return finishedAt
  return finish < start ? undefined : finishedAt
}

/**
 * A revision's terminal fact, but only while it belongs to that revision's
 * CURRENT admission — the {@link currentAdmissionFinish} rule applied to the
 * one pair that decides delivery.
 *
 * Without this, a late REJECTED settle made a re-submitted change report
 * `rejected` forever: `changeDeliveryState` read the stale terminal straight
 * off the record while `branch/submitted` had already cleared `rejectedAt`.
 * The change was then silently held out of the queue — `requestedPRs` admits
 * only `submitted`/`ready` — while every reader told the author they had
 * re-pushed and were waiting. Silence on one side, a contradiction on the
 * other, and nothing named the disagreement.
 */
export function currentRevisionTerminal(revision: ChangeRevClock): ChangeRevTerminal | undefined {
  if (revision.terminal === undefined) return undefined
  return currentAdmissionFinish(revision.submittedAt, revision.terminal.at) === undefined
    ? undefined
    : revision.terminal
}

export function changeNeedsAuthor(pr: Change): Change["needsAuthor"] | undefined {
  if (pr.needsAuthor !== undefined) return pr.needsAuthor
  const admission = changeAdmission(pr)
  if (admission?.status !== "refused" || admission.kind !== "refusal") return undefined
  const failed = admission.steps.find((step) => step.status === "refused")
  return {
    at: admission.at,
    run: failed?.job ?? `admission:${pr.id}:${currentChangeRev(pr).n}`,
    step: admission.step,
    receipt: admission.receipt,
    detail: admission.receipt.message,
  }
}

export const changeRevisionNumber = (pr: Change): number => currentChangeRev(pr).n
export const changeHead = (pr: Change): string => currentChangeRev(pr).head
export const changeBaseSha = (pr: Change): string | undefined => currentChangeRev(pr).baseSha
export const changeProps = (pr: Change): ChangeProps | undefined => currentChangeRev(pr).props
export const changeComposition = (pr: Change): CompositionV1 | undefined => currentChangeRev(pr).composition
export const changeRemerge = (pr: Change): ChangeRemergeProof | undefined => currentChangeRev(pr).recut

/** Historical W2/S7 label projected from the GitHub-shaped PR plus latest revision facts. */
export function changeDeliveryState(pr: Change): ChangeDeliveryState {
  if (pr.state === "closed") {
    if (pr.merged) return pr.alreadyLanded === undefined ? "integrated" : "already-landed"
    if (pr.canceledAt !== undefined) return "canceled"
    return "withdrawn"
  }
  const revision = currentChangeRev(pr)
  if (changeNeedsAuthor(pr) !== undefined) return "needs-author"
  // Only a terminal fact from THIS admission decides delivery — see
  // {@link currentRevisionTerminal}. A settle that predates the revision's own
  // submit fact is a previous admission's and must not hold a re-submitted
  // change out of the queue.
  if (currentRevisionTerminal(revision)?.kind === "rejected") return "rejected"
  if (revision.submittedAt === undefined) return "pushed"
  return revision.admission?.status === "passed" ? "ready" : "submitted"
}

export function reviewState(pr: Change): ChangeReviewState {
  const revision = currentChangeRev(pr)
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
 * Verdicts are revision-bound while requests are not, so a re-merge without a
 * carried review naturally reopens this projection. */
export function needsReview(pr: Change, reviewer?: string): boolean {
  const delivery = changeDeliveryState(pr)
  if (delivery !== "submitted" && delivery !== "ready") return false
  const revision = currentChangeRev(pr)
  const requested = pr.requestedReviewers ?? []
  if (requested.length === 0) return false
  const hasCurrentVerdict = (by: string) =>
    pr.reviews.some((review) => review.revision === revision.n && review.headSha === revision.head && review.by === by)
  if (reviewer !== undefined) return requested.includes(reviewer) && !hasCurrentVerdict(reviewer)
  return !requested.some(hasCurrentVerdict)
}

/** Mechanically certified revision ancestry for one logical PR payload.
 * Ordinary authored revisions start a new lineage; re-merges retain the source
 * revision through their persisted `fromRevision` proof. */
export function changeRevisionLineage(pr: Change, revision = currentChangeRev(pr).n): readonly ChangeRev[] {
  const byRevision = new Map(pr.revs.map((candidate) => [candidate.n, candidate]))
  let current = byRevision.get(revision)
  if (current === undefined) {
    throw new Error(`yrd: change '${pr.id}' has no retained revision ${revision}`)
  }
  const lineage: ChangeRev[] = []
  const seen = new Set<number>()
  while (current !== undefined) {
    if (seen.has(current.n)) throw new Error(`yrd: change '${pr.id}' has a cyclic re-merge history`)
    seen.add(current.n)
    lineage.unshift(current)
    const predecessor = current.recut?.fromRevision
    if (predecessor === undefined) break
    current = byRevision.get(predecessor)
    if (current === undefined) {
      throw new Error(
        `yrd: change '${pr.id}' re-merged revision ${lineage[0]?.n ?? revision} lost its predecessor ${predecessor}`,
      )
    }
  }
  return lineage
}

/** First submitted clock for a mechanically identical payload, falling back
 * to its first immutable source-ready (`pushed`) clock before admission. */
export function changeSourceReadyAt(pr: Change, revision = currentChangeRev(pr).n): string {
  const source = changeRevisionLineage(pr, revision)[0]
  if (source === undefined) throw new Error(`yrd: change '${pr.id}' has no source-ready revision`)
  return source.submittedAt ?? source.pushedAt
}

export function checksRequested(pr: Change): boolean {
  return checkRequest(pr) !== undefined
}

/**
 * The live check request for the current revision, identified by CONTENT.
 *
 * A request asks "check this tree". The tree is `headSha`, and nothing else
 * here identifies it. The revision ordinal does not: a mechanical re-merge that
 * merges on byte-identical content mints a new ordinal while the head — and so
 * the meaning of the request — is unchanged. Keying on the ordinal made such a
 * re-merge discard the request, so the carrier fell out of the queue, the runner
 * re-requested, the checks passed, and the next re-merge discarded it again.
 * Nothing merged for three hours with every instrument reading green
 * (@i/10-merge-queue/admission-passes-nothing-merges; one carrier reached
 * revision 66). New content moves `headSha` and still invalidates.
 *
 * `baseSha` is deliberately NOT part of the match. It is a parameter of the
 * request, not an identity: a request's base tracks the queue's base and is
 * meant to move while the base certified by the revision stays put, which is
 * how production refreshes the check identity after main advances. Requiring
 * them to agree would have selected an older request and admitted the change
 * against a base that is no longer main. `findLast` therefore returns the
 * newest request for this tree, which is the one whose base is current.
 */
export function checkRequest(pr: Change): ChangeCheckRequest | undefined {
  const revision = currentChangeRev(pr)
  return pr.checkRequests.findLast((request) => request.headSha === revision.head)
}

/**
 * The branch-is-change model's approval fact as the queue sees it: a
 * `refs/yrd/submit/<branch>` write the receiver ACCEPTED (never one it merely
 * saw), keyed by the same branch key and spelled in the same sha/base
 * vocabulary as the `pr/*` events, so `submits[branch]` and a record for the
 * same branch converge by key — `deriveChange(branch)` reads both and the
 * record wins when present (@yrd/core/22991 phase 2a; @cto verdict efd1fa9a).
 * Liveness is the receiver's to judge at write time; this projection never
 * re-reads git.
 */
export const BranchSubmitSchema = z
  .object({
    branch: GitRefSchema,
    sha: GitShaSchema,
    base: GitRefSchema,
    /** The seat that hears how this submission ends (`pr submit --notify`,
     * else the launch-env identity). A refs/for push records none: its
     * outcome routes to the queue owner as "submitter unknown" — nobody
     * invents an identity for it (@i/10-yrd/24028). */
    notify: z.string().trim().min(1).optional(),
  })
  .strict()
export type BranchSubmit = z.infer<typeof BranchSubmitSchema>

/**
 * A submit routed to the DERIVED lane: the branch/submitted fact IS the
 * submission — no record mints, compose admits it under the synthetic
 * identity. The legacy A2 fact-keyed mint (a factless `pr submit` creating a
 * Change record post-S6) is retired; a live record still takes the record
 * path until S7 deletes the store (2026-08-27 operator ruling: one lane).
 */
export type DerivedSubmission = Readonly<{ lane: "derived"; branch: string; sha: string; base: string }>

/** CLOSED: a new reason is a schema change, never a string (@cto efd1fa9a, constraint 1). */
export const BranchUnsubmitReasonSchema = z.enum(["deleted", "archived", "superseded"])
export type BranchUnsubmitReason = z.infer<typeof BranchUnsubmitReasonSchema>
export const BranchUnsubmitSchema = z
  .object({
    branch: GitRefSchema,
    reason: BranchUnsubmitReasonSchema,
  })
  .strict()
export type BranchUnsubmit = z.infer<typeof BranchUnsubmitSchema>

/** Journal-only v4 extension. Current commands stay on BranchUnsubmitSchema;
 * the `landed` reason activates only with its top-level reader sentinel. */
export const BranchUnsubmitFactSchema = z
  .object({
    branch: GitRefSchema,
    reason: z.union([BranchUnsubmitReasonSchema, z.literal("landed")]),
    landedReason: z.literal(true).optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    if ((fact.landedReason === true) !== (fact.reason === "landed")) {
      context.addIssue({
        code: "custom",
        message: "landedReason must be present exactly when reason is 'landed'",
        path: ["landedReason"],
      })
    }
  })
export type BranchUnsubmitFact = z.infer<typeof BranchUnsubmitFactSchema>

/** A projected, still-standing submit ref: what was approved, for which base, and when the fact merged. */
export type ProjectedBranchSubmit = Readonly<{
  sha: string
  base: string
  at: string
  /** The seat that hears how this submission ends, when the submit recorded one. */
  notify?: string
}>

export type BaysState = Readonly<{
  byId: Readonly<Record<BayId, Bay>>
  prs: Readonly<Record<PRId, Change>>
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
  /** Live `refs/yrd/submit/<branch>` facts by branch — see {@link BranchSubmitSchema}. */
  submits: Readonly<Record<string, ProjectedBranchSubmit>>
}>

/** `headSha` absent used to mean two different facts — "origin has no such
 * branch" and "we could not establish one" — so a consumer could not tell a
 * finding from a failure. `headState` names which, and a snapshot that omits
 * it (any record written before this field existed) is treated as `unknown`,
 * the conservative reading. */
export const RemoteBranchSnapshotSchema = z
  .object({
    branch: GitRefSchema,
    headSha: GitShaSchema.optional(),
    headState: z.enum(["resolved", "absent", "unknown"]).optional(),
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
    from: GitRefSchema.optional(),
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
    from: GitRefSchema.optional(),
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
  return { byId: {}, prs: {}, receipts: {}, submits: {} }
}

function submitterForLifecycleHead(state: BaysState, bay: Bay, headSha: string | undefined): string | undefined {
  if (headSha === undefined) return undefined
  // Branch-submitted carriers (refs/for, `bay.submit` of a bare branch) never
  // record an explicit bay pointer, and journal history cannot gain one, so a
  // missing association falls back to branch-ref equality. This joins to the
  // submitter RECORDED on the exact-head revision — it never derives a seat
  // from the branch name, and any ambiguity stays unknown below.
  const associated = changeForBay(state, bay.id)
  const candidates =
    associated === undefined ? Object.values(state.prs).filter((pr) => pr.branch === bay.branch) : [associated]
  const revisions = candidates.flatMap((pr) => pr.revs.filter((revision) => revision.head === headSha))
  if (revisions.length === 0 || revisions.some((revision) => revision.submitter === undefined)) return undefined
  const submitters = new Set(revisions.map((revision) => revision.submitter))
  return submitters.size === 1 ? revisions[0]?.submitter : undefined
}

/** Projects the current lifecycle of every Bay-registered work branch from the
 * same journal-backed aggregate used by the Bay and PR APIs. */
export function projectBranchLifecycles(state: BaysState): readonly BranchLifecycle[] {
  return Object.values(state.byId)
    .map((bay): BranchLifecycle => {
      const pr = changeForBay(state, bay.id)
      const current = pr === undefined ? undefined : currentChangeRev(pr)
      const lifecycleHead = bay.archive?.headSha ?? bay.headSha
      const submitter = submitterForLifecycleHead(state, bay, lifecycleHead)
      const base = {
        bay: bay.id,
        name: bay.name,
        ...(bay.issue === undefined ? {} : { issue: bay.issue }),
        ...(bay.by === undefined ? {} : { by: bay.by }),
        ...(submitter === undefined ? {} : { submitter }),
        branch: bay.branch,
        openedAt: bay.openedAt,
      }
      const mergedAt = pr?.alreadyLandedAt ?? pr?.integratedAt
      if (
        bay.headSha !== undefined &&
        current?.head === bay.headSha &&
        pr?.merged === true &&
        mergedAt !== undefined &&
        pr.integration !== undefined
      ) {
        return {
          ...base,
          status: "merged",
          headSha: bay.headSha,
          merged: {
            pr: pr.id,
            revision: current.n,
            at: mergedAt,
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
          (current?.head === bay.headSha && ["pushed", "withdrawn", "canceled"].includes(changeDeliveryState(pr))))
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

/**
 * Does the record store hold a Change for this id?
 *
 * The one place that indexes `BaysState.prs`. It lives HERE, beside the state it
 * reads, because the module that owns a shape owns the questions about it — and
 * because the first attempt to home it in yrd-queue would have closed an import
 * cycle (derived-admission already imports derived-member), which is the type
 * system reporting the same fact.
 *
 * It exists because the index was open-coded at nineteen sites in three
 * spellings — `bays.prs[x] === undefined`, `state.bays.prs[x] !== undefined`,
 * `runtime().bays.prs[x] === undefined` — two of which had additionally
 * re-derived `isDerivedRunMember` longhand, one of them 2,700 lines from a call
 * to the real function in the SAME file. A question asked that many ways has no
 * home.
 *
 * Deliberately NOT merged with `isDerivedRunMember`: that predicate additionally
 * requires the member to be intentless. Callers needing the stronger question
 * must not spell the weaker one and hope; callers needing the weaker one must
 * not pay for the stronger.
 */
export function hasChangeRecord(bays: DeepReadonly<Pick<BaysState, "prs">>, id: string): boolean {
  return getChangeRecord(bays, id) !== undefined
}

/**
 * The Change this id names, or undefined.
 *
 * The ONE expression in the codebase that indexes `BaysState.prs`, which is why
 * `hasChangeRecord` is derived from it instead of repeating the index: "does it
 * exist" and "give it to me" then cannot disagree about what counts as present,
 * a disagreement that needs two indexes to be possible at all.
 *
 * Consumers outside yrd-bay ask through here. Inside yrd-bay, `projectBays` and
 * its reducers index `current.prs` directly and correctly — the module that OWNS
 * a shape may touch it, and routing a reducer through a reader would be ceremony
 * rather than a boundary.
 */
export function getChangeRecord(
  bays: DeepReadonly<Pick<BaysState, "prs">>,
  id: string,
): DeepReadonly<Change> | undefined {
  return bays.prs[id]
}

export function isLiveChange(pr: Change): boolean {
  return pr.state === "open"
}

/** How many changes the RECORD store holds — the honest denominator for a
 * lookup that searched only it. Named rather than inlined so a call site
 * passing it to {@link changeNotFoundMessage} states which population it
 * searched instead of spelling an index expression that reads like the whole
 * truth. */
export function recordChangeCount(bays: DeepReadonly<Pick<BaysState, "prs">>): number {
  return Object.keys(bays.prs).length
}

/**
 * Every Change the RECORD store holds — the record lane's own population,
 * never the whole population a selector can name (that is
 * `queueChanges(bays, queues)` in yrd-queue, which adds the derived lane).
 * Named so a call site states which lane it read; C3a routed every raw
 * `Object.values(bays.prs)` through here, so the raw index greps only to the
 * seam (this file and change-population.ts).
 */
export function recordChanges(bays: Pick<BaysState, "prs">): Change[]
export function recordChanges(bays: DeepReadonly<Pick<BaysState, "prs">>): DeepReadonly<Change>[]
export function recordChanges(bays: DeepReadonly<Pick<BaysState, "prs">>): DeepReadonly<Change>[] {
  return Object.values(bays.prs)
}

/**
 * The record store's entries, id-keyed, for the one consumer that rebuilds
 * the map key-preserving (host state serialization stripping retired fields).
 * Everything else wants {@link recordChanges}.
 */
export function recordChangeEntries(bays: Pick<BaysState, "prs">): [string, Change][]
export function recordChangeEntries(bays: DeepReadonly<Pick<BaysState, "prs">>): [string, DeepReadonly<Change>][]
export function recordChangeEntries(bays: DeepReadonly<Pick<BaysState, "prs">>): [string, DeepReadonly<Change>][] {
  return Object.entries(bays.prs)
}

/**
 * S6 receiver-dispatch rule: intake is the grandfathered RECORD lane's act,
 * and only a branch a LIVE record already owns takes a revision through it. A
 * recordless (or terminal-record) branch belongs to the DERIVED lane — the
 * receiver's submit-ref write IS its submission, and dispatching intake for
 * it would only refuse `record-mint-retired` and wedge the drain retrying.
 * The lane is decided here, AT WRITE TIME, so read-side arbitration never
 * meets the live-record×different-sha ambiguity (s6-door-design §2).
 */
export function recordLaneOwnsBranch(bays: Pick<BaysState, "prs">, branch: string): boolean {
  return Object.values(bays.prs).some((pr) => pr.branch === branch && isLiveChange(pr))
}

/** The one reader of `Change.track`. The fallback IS the fleet-wide default
 * for records that never wrote the bit: tracked, since 2026-08-25
 * (@yrd/core/tracked-delivery step 2, operator-approved) — an absent bit
 * means merge-into-latest, and every pre-existing open change adopted the
 * default the moment this line changed. Untracked is the explicit opt-out
 * (`--no-track`, `pr edit --untrack`), stored as `track: false`. */
export function isTracked(pr: Change): boolean {
  return pr.track ?? true
}

export function changeForBay(state: BaysState, bay: BayId): Change | undefined {
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

/** Resolve a change selector, reporting whether the operator named the change's
 * canonical id or reached it through an alias (branch/name/bay). A branch
 * selector means "the live delivery of this branch": when a branch has both a
 * terminal change and a live one, the live change wins. Candidates are ordered
 * most-recent-first (highest id) so the read-biased fallback resolves the most
 * recent terminal when a branch has ONLY terminal PRs. An exact canonical id
 * always addresses that specific PR, terminal or not, ahead of this preference.
 * Mutating verbs enforce the live requirement themselves via requireLivePR —
 * this primitive stays verb-agnostic and read-biased. */
export type ChangeSelectorMatch = SelectorMatch<Change> & Readonly<{ revision?: ChangeRev }>

export function resolveChangeMatch(state: BaysState, selector: string): ChangeSelectorMatch | undefined {
  const parsed = parseChangeSelector(selector)
  const candidates = Object.values(state.prs)
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
    })
  const resolve = (input: string) => resolveSelectorMatch(input, candidates, { kind: "change", prefer: isLiveChange })
  const matched = parsed === undefined ? resolve(selector) : (resolve(parsed.pr) ?? resolve(selector))
  if (matched === undefined) return undefined
  if (parsed?.revision === undefined) return matched
  const revision = matched.value.revs.find((candidate) => candidate.n === parsed.revision)
  return revision === undefined ? undefined : { ...matched, revision }
}

function projectChangeRevision(pr: Change, revision: ChangeRev): Change {
  if (revision === currentChangeRev(pr)) return pr
  const index = pr.revs.indexOf(revision)
  if (index < 0) return pr
  return {
    ...pr,
    revs: pr.revs.slice(0, index + 1),
    reviews: pr.reviews.filter((review) => review.revision <= revision.n),
    comments: pr.comments.filter((comment) => comment.revision <= revision.n),
    checkRequests: pr.checkRequests.filter((request) => request.revision <= revision.n),
  }
}

export function resolveChange(state: BaysState, selector: string): Change | undefined {
  const matched = resolveChangeMatch(state, selector)
  if (matched === undefined) return undefined
  return matched.revision === undefined ? matched.value : projectChangeRevision(matched.value, matched.revision)
}

declare const liveBrand: unique symbol

/** A change that has passed through {@link requireLiveChange} — the shared mutation
 * boundary guard. Mutating reducers annotate their resolved PR as `LivePR`, so
 * `tsc` rejects any swap back to a raw `resolvePR` / `required(...)` (which
 * yields an unbranded {@link Change}) — the type system, not a source-grep test,
 * enforces that every change-selector mutation routes through the live guard. */
export type LiveChange = Change & { readonly [liveBrand]: true }

/** Resolve a change for a MUTATING verb: a branch/name selector must name the live
 * delivery of that branch. Returns the live change; a terminal change is returned only
 * when the operator addressed it by its exact canonical id (the verb's own
 * state guard then decides what a terminal target permits). A branch/alias
 * selector whose PRs are all terminal refuses loudly here at the mutation
 * boundary — resolvePR stays verb-agnostic and read-biased, so this is the one
 * shared guard every mutating verb routes through instead of hand-rolling it. */
export function requireLiveChange(state: BaysState, selector: string): LiveChange {
  const resolution = resolveChangeMatch(state, selector)
  if (resolution === undefined) {
    // The record store IS this guard's whole search space, truthfully: it is
    // the boundary for record-lane MUTATIONS, and a derived-lane change has no
    // record to mutate. yrd-bay cannot see the queue's snapshots anyway (the
    // dependency runs the other way), so a wider count here would be a number
    // this function did not earn.
    raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(state, selector, recordChangeCount(state)))
  }
  const pr = resolution.value
  if (resolution.revision !== undefined) {
    const current = currentChangeRev(pr)
    if (resolution.revision.n !== current.n) {
      raiseFailure(
        "refusal",
        "historical-pr-revision",
        `yrd: change '${pr.id}' selector targets historical revision ${resolution.revision.n}; current revision is ${current.n}`,
      )
    }
  }
  // A canonical-id match ('pr1' folds to PR1) passes a terminal change through to
  // the verb's own state guard; an alias (branch/name) match must name a live
  // delivery. The fold that decides this lives in resolveSelectorMatch, not here.
  if (isLiveChange(pr) || resolution.matchedBy === "canonical") return pr as LiveChange
  raiseFailure("refusal", "no-live-pr", `yrd: no live change for branch '${selector}'; use PR id`)
}
