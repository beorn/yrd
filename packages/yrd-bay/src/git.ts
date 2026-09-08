import { resolve } from "node:path"
import { adaptProcessGit, type Process } from "@yrd/process"
import { createGitWorktreeStore, type Git } from "git-super/worktree"
import type { BayWorkspace, ProvisionBayInput, ProvisionedBay, WorkspaceResult } from "./workspace.ts"

export type GitWorkspaceOptions = Readonly<{
  repo: string
  process: Pick<Process, "run">
  baysRoot?: string
}>

const GIT_TIMEOUT_MS = 30_000

function failure(code: string, cause: unknown): WorkspaceResult<never> {
  return {
    status: "completed",
    conclusion: "failure",
    error: { code, message: cause instanceof Error ? cause.message : String(cause) },
  }
}

function rethrowWorktreeOwnershipConflict(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (!/already used by worktree|is already checked out/iu.test(message)) throw cause
  throw new Error(
    `${message}\nThe branch remains owned by its existing worktree; ` +
      "inspect it with git worktree list --porcelain and resume in the named worktree.",
  )
}

async function remoteBranchHead(git: Git, repo: string, branch: string): Promise<string | undefined> {
  const result = await git.run(repo, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], true)
  if (result.code === 2) return undefined
  if (result.code !== 0) {
    throw new Error(
      `could not verify branch '${branch}' on origin: ` +
        (result.stderr.trim() || result.stdout.trim() || `git ls-remote exited ${result.code}`),
    )
  }
  const headSha = result.stdout.trim().split(/\s+/u)[0]
  if (headSha === undefined || !/^[0-9a-f]{40,64}$/u.test(headSha)) {
    throw new Error(`origin returned no commit for branch '${branch}'`)
  }
  return headSha
}

function safeBayPath(root: string, bay: string): string {
  const path = resolve(root, bay)
  const prefix = `${resolve(root)}/`
  if (!path.startsWith(prefix)) throw new Error(`bay id '${bay}' escapes the configured bays root`)
  return path
}

export async function createGitWorkspace(options: GitWorkspaceOptions): Promise<BayWorkspace> {
  const repo = resolve(options.repo)
  const baysRoot = resolve(options.baysRoot ?? `${repo}/.bays`)
  const transport = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const worktrees = createGitWorktreeStore({ ...options, gitProcess: transport })
  const { git } = worktrees
  await worktrees.ready()
  return {
    async provision(input: ProvisionBayInput): Promise<WorkspaceResult<ProvisionedBay>> {
      const path = safeBayPath(baysRoot, input.bay)
      try {
        const baseSha = await git.commit(repo, input.base)
        await worktrees.prepareRoot(baysRoot, false)
        const localRef = `refs/heads/${input.branch}`
        const remoteRef = `refs/remotes/origin/${input.branch}`
        const [local, tracking] = await Promise.all([
          git.run(repo, ["rev-parse", "--verify", `${localRef}^{commit}`], true),
          git.run(repo, ["rev-parse", "--verify", `${remoteRef}^{commit}`], true),
        ])
        // Git's worktree registration owns the branch, not an issue marker.
        // Preserve existing work in local > tracking > remote order; ordinary
        // non-force worktree add refuses if another worktree already owns it.
        if (local.code === 0) {
          try {
            await worktrees.add({ kind: "branch", path, branch: input.branch })
          } catch (cause) {
            rethrowWorktreeOwnershipConflict(cause)
          }
        } else {
          const remoteHead = tracking.code === 0 ? undefined : await remoteBranchHead(git, repo, input.branch)
          if (remoteHead !== undefined) {
            // Fetch the captured object, not a branch that may move after the
            // observation. Adoption does not widen a single-branch clone's
            // fetch configuration or manufacture an upstream mapping.
            await git.run(repo, ["fetch", "--no-recurse-submodules", "origin", remoteHead])
          }
          await worktrees.add({
            kind: "new-branch",
            path,
            branch: input.branch,
            ref: tracking.code === 0 ? remoteRef : (remoteHead ?? baseSha),
          })
          if (tracking.code === 0) {
            await git.run(path, ["branch", "--set-upstream-to", `origin/${input.branch}`, input.branch])
          }
        }
        await worktrees.materializeSubmodules(path)
        const headSha = await git.commit(path, "HEAD")
        return { status: "completed", conclusion: "success", output: { path, headSha, baseSha } }
      } catch (cause) {
        return failure("provision-failed", cause)
      }
    },
  }
}
