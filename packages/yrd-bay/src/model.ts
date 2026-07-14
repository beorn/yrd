import * as z from "zod"

export const BayIdSchema = z.string().trim().min(1)
export const PRIdSchema = z.string().trim().min(1)
export const GitRefSchema = z.string().trim().min(1)
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/iu)
export const CorrelationSchema = z
  .object({
    namespace: z.string().trim().min(1),
    id: z
      .string()
      .min(1)
      .refine((id) => id.trim().length > 0, { message: "correlation id cannot be blank" }),
  })
  .strict()

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

export type PRStatus = "pushed" | "submitted" | "rejected" | "integrated" | "withdrawn" | "canceled"

export type PRRevisionTerminal = Readonly<{
  status: Extract<PRStatus, "rejected" | "integrated" | "withdrawn" | "canceled">
  at: string
}>

export type PRRevisionClock = Readonly<{
  pushedAt: string
  submittedAt?: string
  terminal?: PRRevisionTerminal
}>

export type PRRevision = Readonly<{
  revision: number
  headSha: string
  base: string
  baseSha?: string
  correlation?: Correlation
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

export type PR = Readonly<{
  id: PRId
  bay?: BayId
  name?: string
  issue?: string
  note?: string
  branch: string
  base: string
  status: PRStatus
  revision: number
  headSha: string
  baseSha?: string
  correlation?: Correlation
  revisions: readonly PRRevision[]
  reviews: readonly PRReview[]
  comments: readonly PRComment[]
  checkRequests: readonly PRCheckRequest[]
  submittedAt?: string
  rejectedAt?: string
  integratedAt?: string
  integration?: Readonly<{ commit: string; baseSha: string }>
  withdrawnAt?: string
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

export function checksRequested(pr: PR): boolean {
  return checkRequest(pr) !== undefined
}

export function checkRequest(pr: PR): PRCheckRequest | undefined {
  return pr.checkRequests.findLast((request) => request.revision === pr.revision && request.headSha === pr.headSha)
}

export type BaysState = Readonly<{
  byId: Readonly<Record<BayId, Bay>>
  prs: Readonly<Record<PRId, PR>>
  receipts: Readonly<
    Record<string, Readonly<{ pr: PRId; branch: string; headSha: string; base: string; baseSha?: string }>>
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
  return { byId: {}, prs: {}, receipts: {} }
}

export function isLivePR(status: PRStatus): boolean {
  return status === "pushed" || status === "submitted" || status === "rejected"
}

export function prForBay(state: BaysState, bay: BayId): PR | undefined {
  return Object.values(state.prs).find((pr) => pr.bay === bay)
}

export function resolveBay(state: BaysState, selector: string): Bay | undefined {
  return (
    state.byId[selector] ?? Object.values(state.byId).find((bay) => bay.name === selector || bay.branch === selector)
  )
}

export function resolvePR(state: BaysState, selector: string): PR | undefined {
  const direct = state.prs[selector]
  if (direct !== undefined) return direct
  const bayId = resolveBay(state, selector)?.id
  return Object.values(state.prs).find(
    (pr) => (bayId !== undefined && pr.bay === bayId) || pr.branch === selector || pr.name === selector,
  )
}
