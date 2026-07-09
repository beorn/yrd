export type BayId = string
export type SubmissionId = string

export type BayFailure = {
  code: string
  message: string
}

export type BayStatus = "opening" | "active" | "closing" | "closed" | "failed"

export type Bay = {
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
  effectId?: string
  closedAt?: string
  failure?: BayFailure
}

export type SubmissionStatus = "pushed" | "submitted" | "rejected" | "integrated" | "withdrawn"

export type SubmissionRevision = {
  revision: number
  headSha: string
  base: string
  baseSha?: string
  pushedAt: string
}

export type Submission = {
  id: SubmissionId
  bay?: BayId
  name?: string
  branch: string
  base: string
  status: SubmissionStatus
  revision: number
  headSha: string
  baseSha?: string
  revisions: SubmissionRevision[]
  submittedAt?: string
  rejectedAt?: string
  integratedAt?: string
  integration?: { commit: string; baseSha: string }
  withdrawnAt?: string
  detail?: string
}

export type BaysState = {
  bays: Record<BayId, Bay>
  submissions: Record<SubmissionId, Submission>
  receipts: Record<
    string,
    { submission: SubmissionId; branch: string; headSha: string; base: string; baseSha?: string }
  >
}

export type ProvisionBayInput = {
  bay: BayId
  name: string
  branch: string
  base: string
  baseSha?: string
  from?: string
}

export type ProvisionedBay = {
  path: string
  headSha: string
  baseSha: string
}

export type RefreshBayInput = {
  bay: BayId
  path?: string
  branch: string
  base: string
}

export type RefreshedBay = {
  path: string
  headSha: string
  baseSha: string
  dirty: boolean
}

export type DeprovisionBayInput = {
  bay: BayId
  path?: string
  branch: string
  headSha?: string
}

export type DeprovisionedBay = {
  preservedRef?: string
}

export function defaultBayBranch(name: string): string {
  return `task/${name}`
}

export function emptyBaysState(): BaysState {
  return { bays: {}, submissions: {}, receipts: {} }
}

export function isLiveSubmission(status: SubmissionStatus): boolean {
  return status === "pushed" || status === "submitted" || status === "rejected"
}

export function submissionForBay(state: BaysState, bay: BayId): Submission | undefined {
  return Object.values(state.submissions).find((submission) => submission.bay === bay)
}

export function resolveBay(state: BaysState, selector: string): Bay | undefined {
  return (
    state.bays[selector] ?? Object.values(state.bays).find((bay) => bay.name === selector || bay.branch === selector)
  )
}

export function resolveSubmission(state: BaysState, selector: string): Submission | undefined {
  const direct = state.submissions[selector]
  if (direct !== undefined) return direct
  const bay = resolveBay(state, selector)
  return Object.values(state.submissions).find(
    (submission) =>
      (bay !== undefined && submission.bay === bay.id) ||
      submission.branch === selector ||
      submission.name === selector,
  )
}
