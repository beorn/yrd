import * as z from "zod"

export const BayIdSchema = z.string().trim().min(1)
export const PRIdSchema = z.string().trim().min(1)
export const GitRefSchema = z.string().trim().min(1)
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/iu)

export type BayId = string
export type PRId = string

export type BayFailure = Readonly<{
  code: string
  message: string
}>

export type BayStatus = "opening" | "active" | "closing" | "closed" | "failed"

export type PRReviewDecision = "approve" | "reject" | "comment"

export type PRReview = Readonly<{
  revision: number
  actor: string
  decision: PRReviewDecision
  at: string
  ref?: string
}>

export type Bay = Readonly<{
  id: BayId
  name: string
  task?: string
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

export type PRStatus = "pushed" | "submitted" | "rejected" | "integrated" | "withdrawn"

export type PRRevision = Readonly<{
  revision: number
  headSha: string
  base: string
  baseSha?: string
  pushedAt: string
}>

export type PR = Readonly<{
  id: PRId
  bay?: BayId
  name?: string
  branch: string
  base: string
  status: PRStatus
  revision: number
  headSha: string
  baseSha?: string
  revisions: readonly PRRevision[]
  requirements?: readonly string[]
  submittedAt?: string
  rejectedAt?: string
  integratedAt?: string
  reviews?: readonly PRReview[]
  integration?: Readonly<{ commit: string; baseSha: string }>
  withdrawnAt?: string
  detail?: string
}>

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
  return `task/${name}`
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
