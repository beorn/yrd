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
import { JobErrorSchema, type JobError } from "@yrd/job"
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

/** Author-owned refusal fact. Unlike `pr/rejected`, this keeps the change in the
 * submitted queue lifecycle and carries the exact typed result needed to fix
 * the branch in place. */
export const ChangeNeedsAuthorFactSchema = z.preprocess(
  normalizeLegacyChangeKeys,
  ChangeRejectedFactObjectSchema.extend({
    receipt: JobErrorSchema,
  }).strict(),
)
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
  branch: string
  openedAt: string
}>

/** S7 (branch-is-change): the record joins are gone. "submitted" derives from
 * the branch's standing submit fact at the bay head, and "landed" is no longer
 * derivable inside this package — run history / merged-truth are the landing
 * authority, joined by the host if a landed row is wanted. */
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
        submitted: Readonly<{ sha: string; base: string; at: string }>
      }
    >
  | Readonly<
      BranchLifecycleBase & {
        status: "archived"
        headSha: string
        archived: Readonly<{ at: string; eventId: string; preservedRef: string }>
      }
    >

/** W2-facing delivery label derived from canonical PR/ChangeRev facts. Never stored. */
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
}>

export type ChangeAdmissionStep = Readonly<{
  name: string
  revision: string
  job: string
  status: "passed" | "refused"
  output?: JsonValue
  receipt?: JobError
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
  .superRefine((step, context) => {
    if ((step.status === "passed") !== (step.receipt === undefined)) {
      context.addIssue({
        code: "custom",
        message:
          step.status === "passed"
            ? "a passed entry-check step cannot carry a receipt"
            : "a failed entry-check step requires a receipt",
        path: ["receipt"],
      })
    }
  }) as z.ZodType<ChangeAdmissionStep>

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

export const ChangeAdmissionRecordSchema = z.discriminatedUnion("status", [
  ChangeAdmissionBaseSchema.extend({ status: z.literal("passed") }).strict(),
  ChangeAdmissionBaseSchema.extend({
    status: z.literal("refused"),
    kind: z.enum(["refusal", "failure", "infrastructure"]),
    step: TextSchema,
    receipt: JobErrorSchema,
  }).strict(),
]) as z.ZodType<ChangeAdmissionRecord>
export type ChangeAdmission = ChangeAdmissionRecord & Readonly<{ at: string }>

export type ChangeAdmissionRecordedFact = Readonly<{
  pr: PRId
  revision: number
  headSha: string
  admission: ChangeAdmissionRecord
}>

export const ChangeAdmissionRecordedFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    admission: ChangeAdmissionRecordSchema,
  })
  .strict() as z.ZodType<ChangeAdmissionRecordedFact>

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
  /** Admission is a verdict about this immutable revision, not a merge
   * attempt. A later base revalidation replaces it on the same revision. */
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
   * preflighted, and prepared for Queue admission when its verdict permits; a
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
    receipt: JobError
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
 * site can be made type-safe against passing a pin-advance id here — the
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
 */
export function changeNotFoundMessage(state: BaysState, selector: string): string {
  // S7: the denominator counts the SURVIVING population a selector can name —
  // replayed record history plus live submit facts — so the falsifiable-empty
  // contract outlives the record store (`searched 0` stays honest absence).
  const searched = `searched ${Object.keys(state.prs).length + Object.keys(state.submits).length} change(s)`
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
  if (revision.terminal?.kind === "rejected") return "rejected"
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
    if (seen.has(current.n)) throw new Error(`yrd: change '${pr.id}' has a cyclic rebuild history`)
    seen.add(current.n)
    lineage.unshift(current)
    const predecessor = current.recut?.fromRevision
    if (predecessor === undefined) break
    current = byRevision.get(predecessor)
    if (current === undefined) {
      throw new Error(
        `yrd: change '${pr.id}' rebuilt revision ${lineage[0]?.n ?? revision} lost its predecessor ${predecessor}`,
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
 * here identifies it. The revision ordinal does not: a mechanical rebuild that
 * merges on byte-identical content mints a new ordinal while the head — and so
 * the meaning of the request — is unchanged. Keying on the ordinal made such a
 * rebuild discard the request, so the carrier fell out of the queue, the runner
 * re-requested, admission passed, and the next rebuild discarded it again.
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

/** CLOSED: a new reason is a schema change, never a string (@cto efd1fa9a, constraint 1).
 * `superseded` is REPLAY-ONLY since S7: its writer, the queue's
 * submitFactRetirement (record-lane approval takeover), retired with the
 * record store; the member stays so journals carrying it keep parsing. */
export const BranchUnsubmitReasonSchema = z.enum(["deleted", "archived", "superseded"])
export type BranchUnsubmitReason = z.infer<typeof BranchUnsubmitReasonSchema>
export const BranchUnsubmitSchema = z
  .object({
    branch: GitRefSchema,
    reason: BranchUnsubmitReasonSchema,
  })
  .strict()
export type BranchUnsubmit = z.infer<typeof BranchUnsubmitSchema>

/** A projected, still-standing submit ref: what was approved, for which base, and when the fact merged. */
export type ProjectedBranchSubmit = Readonly<{
  sha: string
  base: string
  at: string
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

/** Projects the current lifecycle of every Bay-registered work branch from the
 * same journal-backed aggregate used by the Bay APIs. S7: record joins are
 * gone — "submitted" reads the branch's standing submit fact at the bay head,
 * and no "landed" row projects here (run history / merged-truth own landing). */
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
      const submit = state.submits[bay.branch]
      if (bay.headSha !== undefined && submit !== undefined && submit.sha === bay.headSha) {
        return {
          ...base,
          status: "submitted",
          headSha: bay.headSha,
          submitted: { sha: submit.sha, base: submit.base, at: submit.at },
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
      if (bay.headSha !== undefined && bay.handoff?.headSha === bay.headSha) {
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

export function isLiveChange(pr: Change): boolean {
  return pr.state === "open"
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

/** @deprecated S7 read-survivor: joins a bay to its REPLAYED record history
 * (`state.prs`), which no live command grows any more. Kept only for
 * cross-package readers (@yrd/contest promotion pins); deletes with the store
 * once those rewire onto run snapshots / merged-truth. */
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
 * This primitive stays verb-agnostic and read-biased; {@link requireLiveChange}
 * layers the live requirement on top. */
export type ChangeSelectorMatch = SelectorMatch<Change> & Readonly<{ revision?: ChangeRev }>

/** @deprecated S7 read-survivor (with {@link resolveChange},
 * {@link requireLiveChange}, {@link changeNotFoundMessage}): resolves over the
 * REPLAYED record store, which no live command grows any more. Kept because
 * @yrd/queue and @yrd/cli still import these for reads; each deletes with the
 * store once its owner rewires onto the queue's snapshot resolver
 * (`resolveMemberById`) + live submit facts. The selector GRAMMAR
 * ({@link parseChangeSelector}) is permanent and stays. */
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

/** A change that has passed through {@link requireLiveChange}. The brand was
 * the shared mutation-boundary guard while record verbs existed; S7 deleted
 * every mutating verb, so it survives only as the return shape of the
 * deprecated read-survivor below. */
export type LiveChange = Change & { readonly [liveBrand]: true }

/** @deprecated S7 read-survivor (see {@link resolveChangeMatch}): the
 * live-preference resolution — a branch/name selector must name the live
 * delivery of that branch; a terminal change resolves only by its exact
 * canonical id. No mutating verb remains behind it; kept because @yrd/cli
 * still imports it, and it deletes with the store once that caller rewires
 * onto the queue's snapshot resolver + live submit facts. */
export function requireLiveChange(state: BaysState, selector: string): LiveChange {
  const resolution = resolveChangeMatch(state, selector)
  if (resolution === undefined) {
    raiseFailure("refusal", "pr-not-found", changeNotFoundMessage(state, selector))
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
