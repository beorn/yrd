import * as z from "zod"
import { resolveSelector } from "@yrd/core"

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

/** Closed current rejection fact used by the Bay projection and post-append signal observers. */
export const PRRejectedFactSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    run: TextSchema,
    issueRef: TextSchema.optional(),
    correlation: CorrelationSchema.optional(),
    /** Missing only when a current rejection terminates a pre-actor legacy revision. */
    actor: TextSchema.optional(),
    step: TextSchema,
    evidence: TextSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
export type PRRejectedFact = Readonly<z.infer<typeof PRRejectedFactSchema>>

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

export type BayStatus = "opening" | "active" | "closing" | "closed" | "failed"

export type Bay = Readonly<{
  id: BayId
  name: string
  issue?: string
  actor?: string
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
}>

/** Monotonic delivery lifecycle for an explicitly registered Git branch.
 * This is deliberately distinct from `BayStatus`: a Bay is a physical
 * workspace, while a managed branch can outlive (or never have) a workspace. */
export type ManagedBranchStatus = "open" | "handoff-ready" | "submitted" | "landed" | "archived"

export type ManagedBranch = Readonly<{
  branch: string
  issue?: string
  actor?: string
  base: string
  baseSha?: string
  registeredHeadSha: string
  headSha: string
  status: ManagedBranchStatus
  registeredAt: string
  readyAt?: string
  handoff?: string
  pr?: PRId
  submittedAt?: string
  landedAt?: string
  archivedAt?: string
  archiveReason?: string
}>

export const MANAGED_BRANCH_SLA_MS = 30 * 60 * 1_000

/** The SLA is strict: exactly 30 minutes is still within the window. */
export function isManagedBranchOverdue(
  branch: ManagedBranch,
  nowMs: number,
  thresholdMs = MANAGED_BRANCH_SLA_MS,
): boolean {
  if (branch.status !== "handoff-ready" || branch.readyAt === undefined) return false
  return nowMs - Date.parse(branch.readyAt) > thresholdMs
}

export type PRStatus = "pushed" | "submitted" | "rejected" | "integrated" | "withdrawn" | "canceled"

const NON_CHECKABLE_PR_STATUSES: ReadonlySet<PRStatus> = new Set<PRStatus>(["integrated", "withdrawn", "canceled"])

/** A PR can only accept new check requests while pushed/submitted/rejected; once
 * it reaches a terminal status (integrated/withdrawn/canceled) it is no longer
 * checkable. */
export function isNonCheckablePRStatus(status: PRStatus): boolean {
  return NON_CHECKABLE_PR_STATUSES.has(status)
}

/**
 * A check request was refused because the PR's current status does not permit
 * it. Always thrown, never returned, so a genuine caller error still fails
 * loud. The carried `prId`/`status` let a resident, multi-tenant runner tell a
 * losable concurrent-terminal race (a peer withdrew/canceled/integrated the PR
 * between the runner's compose snapshot and its check request — see
 * isConcurrentCheckabilityConflict) apart from a real caller error, without
 * matching on the message text.
 */
export class PrCheckabilityConflict extends Error {
  readonly prId: string
  readonly status: PRStatus

  constructor(prId: string, status: PRStatus) {
    super(`yrd: PR '${prId}' is ${status}, not checkable`)
    this.name = "PrCheckabilityConflict"
    this.prId = prId
    this.status = status
  }
}

/**
 * True when an error is a PrCheckabilityConflict whose PR had already reached a
 * terminal status — i.e. a concurrent writer withdrew/canceled/integrated the
 * PR between a runtime's compose snapshot and its check request. This is a
 * normal, losable race for a long-lived resident runner: skip this cycle and
 * continue; the next cycle re-snapshots without the departed PR and composes
 * the remaining runnable ones.
 */
export function isConcurrentCheckabilityConflict(error: unknown): error is PrCheckabilityConflict {
  return error instanceof PrCheckabilityConflict && isNonCheckablePRStatus(error.status)
}

export type PRRevisionTerminal = Readonly<{
  status: Extract<PRStatus, "rejected" | "integrated" | "withdrawn" | "canceled">
  at: string
  run?: string
}>

export type PRRevisionClock = Readonly<{
  pushedAt: string
  submittedAt?: string
  terminal?: PRRevisionTerminal
}>

export const PRRecutProofSchema = z
  .object({
    fromRevision: z.number().int().positive(),
    patchId: GitShaSchema,
    treeSha: GitShaSchema,
    reviewCarried: z.boolean(),
  })
  .strict()
export type PRRecutProof = Readonly<z.infer<typeof PRRecutProofSchema>>

export type PRRevision = Readonly<{
  revision: number
  headSha: string
  base: string
  baseSha?: string
  /** Missing only while replaying journals written before submitter identity was recorded. */
  actor?: string
  correlation?: Correlation
  composition?: CompositionV1
  recut?: PRRecutProof
}> &
  PRRevisionClock

export type PRReviewDecision = "approve" | "reject"

export type PRReview = Readonly<{
  revision: number
  headSha: string
  actor: string
  decision: PRReviewDecision
  at: string
  ref?: string
  note?: string
  carriedFrom?: Readonly<{ revision: number; headSha: string }>
}>

export type PRComment = Readonly<{
  revision: number
  headSha: string
  actor: string
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
  status: PRStatus
  revision: number
  headSha: string
  baseSha?: string
  correlation?: Correlation
  composition?: CompositionV1
  recut?: PRRecutProof
  revisions: readonly PRRevision[]
  reviews: readonly PRReview[]
  comments: readonly PRComment[]
  checkRequests: readonly PRCheckRequest[]
  /** Current requested-reviewer set (latest pr/review-requested fact wins;
   * revision-independent, so recuts and new revisions keep the request).
   * Optional like `regressions`: absent means no request was ever recorded,
   * identical in meaning to the empty set. */
  requestedReviewers?: readonly string[]
  regressions?: readonly PRRegression[]
  terminalRun?: string
  submittedAt?: string
  rejectedAt?: string
  integratedAt?: string
  integration?: Readonly<{ commit: string; baseSha: string }>
  withdrawnAt?: string
  withdrawReason?: string
  canceledAt?: string
  canceledBy?: string
  cancelReason?: string
  detail?: string
}>

export function reviewState(pr: PR): PRReviewState {
  const current = pr.reviews.findLast((review) => review.revision === pr.revision && review.headSha === pr.headSha)
  return {
    approved: current?.decision === "approve",
    ...(current === undefined ? {} : { current }),
    stale: pr.reviews.filter((review) => review.revision !== pr.revision || review.headSha !== pr.headSha),
  }
}

/** Requested-reviewer projection, never a stored status: a submitted PR whose
 * requested set is non-empty and lacks a current-revision verdict from the
 * given reviewer (or, with no reviewer argument, from any requested reviewer).
 * Verdicts are revision-bound while requests are not, so a recut without a
 * carried review naturally reopens this projection. */
export function needsReview(pr: PR, reviewer?: string): boolean {
  if (pr.status !== "submitted") return false
  const requested = pr.requestedReviewers ?? []
  if (requested.length === 0) return false
  const hasCurrentVerdict = (actor: string) =>
    pr.reviews.some(
      (review) => review.revision === pr.revision && review.headSha === pr.headSha && review.actor === actor,
    )
  if (reviewer !== undefined) return requested.includes(reviewer) && !hasCurrentVerdict(reviewer)
  return !requested.some(hasCurrentVerdict)
}

/** Mechanically certified revision ancestry for one logical PR payload.
 * Ordinary authored revisions start a new lineage; recuts retain the source
 * revision through their persisted `fromRevision` proof. */
export function prRevisionLineage(pr: PR, revision = pr.revision): readonly PRRevision[] {
  const byRevision = new Map(pr.revisions.map((candidate) => [candidate.revision, candidate]))
  let current = byRevision.get(revision)
  if (current === undefined || (revision === pr.revision && current.headSha !== pr.headSha)) {
    throw new Error(`yrd: PR '${pr.id}' has no retained revision ${revision}`)
  }
  const lineage: PRRevision[] = []
  const seen = new Set<number>()
  while (current !== undefined) {
    if (seen.has(current.revision)) throw new Error(`yrd: PR '${pr.id}' has cyclic recut lineage`)
    seen.add(current.revision)
    lineage.unshift(current)
    const predecessor = current.recut?.fromRevision
    if (predecessor === undefined) break
    current = byRevision.get(predecessor)
    if (current === undefined) {
      throw new Error(
        `yrd: PR '${pr.id}' recut revision ${lineage[0]?.revision ?? revision} lost predecessor ${predecessor}`,
      )
    }
  }
  return lineage
}

/** First submitted clock for a mechanically identical payload, falling back
 * to its first immutable source-ready (`pushed`) clock before admission. */
export function prSourceReadyAt(pr: PR, revision = pr.revision): string {
  const source = prRevisionLineage(pr, revision)[0]
  if (source === undefined) throw new Error(`yrd: PR '${pr.id}' has no source-ready revision`)
  return source.submittedAt ?? source.pushedAt
}

export function checksRequested(pr: PR): boolean {
  return checkRequest(pr) !== undefined
}

export function checkRequest(pr: PR): PRCheckRequest | undefined {
  return pr.checkRequests.findLast((request) => request.revision === pr.revision && request.headSha === pr.headSha)
}

export type BaysState = Readonly<{
  byId: Readonly<Record<BayId, Bay>>
  branches: Readonly<Record<string, ManagedBranch>>
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

export const ProvisionBayInputSchema = z
  .object({
    bay: BayIdSchema,
    name: z.string().trim().min(1),
    branch: GitRefSchema,
    base: GitRefSchema,
    baseSha: GitShaSchema.optional(),
    from: GitRefSchema.optional(),
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

export const DeprovisionBayInputSchema = z
  .object({
    bay: BayIdSchema,
    path: z.string().min(1).optional(),
    branch: GitRefSchema,
    headSha: GitShaSchema.optional(),
  })
  .strict()
export type DeprovisionBayInput = z.infer<typeof DeprovisionBayInputSchema>

export const DeprovisionedBaySchema = z.object({ preservedRef: GitRefSchema.optional() }).strict()
export type DeprovisionedBay = z.infer<typeof DeprovisionedBaySchema>

export function defaultBayBranch(name: string): string {
  return `issue/${name}`
}

export function emptyBaysState(): BaysState {
  return { byId: {}, branches: {}, prs: {}, receipts: {} }
}

export function isLivePR(status: PRStatus): boolean {
  return status === "pushed" || status === "submitted" || status === "rejected"
}

export function prForBay(state: BaysState, bay: BayId): PR | undefined {
  return Object.values(state.prs).find((pr) => pr.bay === bay)
}

export function resolveBay(state: BaysState, selector: string): Bay | undefined {
  return resolveSelector(
    selector,
    Object.values(state.byId).map((bay) => ({
      canonical: bay.id,
      aliases: [bay.name, bay.branch],
      value: bay,
    })),
    { kind: "Bay" },
  )
}

export function resolveManagedBranch(state: BaysState, selector: string): ManagedBranch | undefined {
  return resolveSelector(
    selector,
    Object.values(state.branches).map((branch) => ({
      canonical: branch.branch,
      aliases: [],
      value: branch,
    })),
    { kind: "managed branch" },
  )
}

export function resolvePR(state: BaysState, selector: string): PR | undefined {
  return resolveSelector(
    selector,
    Object.values(state.prs).map((pr) => {
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
    { kind: "PR" },
  )
}
