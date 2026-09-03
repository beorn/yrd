/**
 * What an environment IS, as a type: a git worktree cut for one branch, with
 * the four operations that make and unmake it.
 *
 * These declarations lived in `plugin.ts` and `model.ts`, beside the durable
 * `Bay` record, its journal plugin, its PR-number mint and the receiver that
 * read `refs/for/…` pushes. All of that is the old core's and is deleted at M6
 * (plan § Dropped on purpose), while "bays stay as workspaces" is kept — so
 * the workspace's own vocabulary moves here, where nothing behind it needs a
 * store, a journal or a job runner.
 *
 * The result shape is `@yrd/job`'s `JobResult` narrowed to what a workspace
 * ever returned: it never waited, so the waiting arm is gone with the package.
 */

import * as z from "zod"

export const BayIdSchema = z.string().trim().min(1)
export const GitRefSchema = z.string().trim().min(1)
export const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)

/** Why an operation could not be done, in the shape its callers already read. */
export type WorkspaceFailure = Readonly<{ code: string; message: string; evidence?: unknown }>

/**
 * One workspace operation's outcome. Two arms, both terminal: this is
 * `JobResult` with the `waiting` arm dropped, because no workspace operation
 * ever returned one — the token, the callback URL and the checkpoint it
 * carried belonged to the job runtime that is gone.
 */
export type WorkspaceResult<Output> =
  | Readonly<{ status: "completed"; conclusion: "success"; output: Output }>
  | Readonly<{ status: "completed"; conclusion: "failure"; error: WorkspaceFailure }>

/** `headSha` absent used to mean two different facts — "origin has no such
 * branch" and "we could not establish one" — so a consumer could not tell a
 * finding from a failure. `headState` names which, and a snapshot that omits
 * it is treated as `unknown`, the conservative reading. */
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

export const DeprovisionedBaySchema = z
  .object({ headSha: GitShaSchema.optional(), preservedRef: GitRefSchema.optional() })
  .strict()
export type DeprovisionedBay = z.infer<typeof DeprovisionedBaySchema>

/** The environment's own four operations. `@yrd/bay`'s git adapter is the one
 * implementation; a test may stand in for it. */
export type BayWorkspace = Readonly<{
  revision: string
  provision(input: ProvisionBayInput): WorkspaceResult<ProvisionedBay> | Promise<WorkspaceResult<ProvisionedBay>>
  refresh(input: RefreshBayInput): WorkspaceResult<RefreshedBay> | Promise<WorkspaceResult<RefreshedBay>>
  checkpoint(input: CheckpointBayInput): WorkspaceResult<CheckpointedBay> | Promise<WorkspaceResult<CheckpointedBay>>
  deprovision(
    input: DeprovisionBayInput,
  ): WorkspaceResult<DeprovisionedBay> | Promise<WorkspaceResult<DeprovisionedBay>>
}>

/** The branch an environment opens when nothing named one. */
export function defaultBayBranch(name: string): string {
  return `issue/${name}`
}
