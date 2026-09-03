/**
 * What an environment IS, as a type: a git worktree cut for one branch, and the
 * one operation that makes it.
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

export type ProvisionBayInput = Readonly<{
  bay: string
  name: string
  branch: string
  base: string
  issue?: string
}>

export type ProvisionedBay = Readonly<{
  path: string
  headSha: string
  baseSha: string
}>

/** The environment's own operation. `@yrd/bay`'s git adapter is the one
 * implementation; a test may stand in for it. */
export type BayWorkspace = Readonly<{
  provision(input: ProvisionBayInput): WorkspaceResult<ProvisionedBay> | Promise<WorkspaceResult<ProvisionedBay>>
}>
