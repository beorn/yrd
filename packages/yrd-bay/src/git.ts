import { lstat } from "node:fs/promises"
import { resolve } from "node:path"
import { adaptProcessGit, type Process } from "@yrd/process"
import { worktreeHomeRoot } from "git-super"
import { createGitWorktreeStore, type Git } from "git-super/worktree"
import type { BayWorkspace, ProvisionBayInput, ProvisionedBay, WorkspaceResult } from "./workspace.ts"

export { DEFAULT_WORKTREE_HOME, WORKTREE_HOME_ENV, worktreeHomeRoot } from "git-super"

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
    error: { code, message: messageOf(cause) },
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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

/**
 * hh#39162: group each omitted directory under the declared submodule that holds it, as git-super's
 * `checkoutOmissions` takes them (component root-relative path to component-relative directories). Read from the
 * new worktree's own `.gitmodules`, so the declaration is the commit's. A directory no component holds refuses by
 * name: a branch environment checks the root out in full, so only a component's checkout can leave it out.
 */
async function componentOmissions(
  git: Git,
  path: string,
  directories: readonly string[],
): Promise<Map<string, string[]>> {
  const byComponent = new Map<string, string[]>()
  if (directories.length === 0) return byComponent
  const declared = await git.run(path, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], true)
  const components = declared.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(" ") + 1))
  for (const directory of directories) {
    const component = components
      .filter((candidate) => directory.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (component === undefined) {
      throw new Error(
        `environment omission ${JSON.stringify(directory)} is inside no declared submodule at ${path}; ` +
          "a branch environment can leave out only a directory inside a component's checkout",
      )
    }
    const relative = directory.slice(component.length + 1)
    const group = byComponent.get(component)
    if (group === undefined) byComponent.set(component, [relative])
    else group.push(relative)
  }
  return byComponent
}

/**
 * After materialization, each omitted directory is absent and still names tracked content at the component's HEAD.
 * The second check is what keeps a renamed directory loud: an omission that names nothing would leave the full
 * checkout in place and report success.
 */
async function verifyOmitted(git: Git, path: string, omissions: ReadonlyMap<string, readonly string[]>): Promise<void> {
  for (const [component, relatives] of omissions) {
    for (const relative of relatives) {
      const tracked = await git.run(resolve(path, component), ["ls-tree", "-d", "HEAD", "--", relative], true)
      if (tracked.code !== 0 || tracked.stdout.trim() === "") {
        throw new Error(
          `environment omission ${component}/${relative} names no tracked directory at ${component}'s HEAD; ` +
            "correct environments.omitCheckoutDirectories in .yrd.yml",
        )
      }
      if (await exists(resolve(path, component, relative))) {
        throw new Error(`environment omission ${component}/${relative} is present after materialization at ${path}`)
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function safeBayPath(root: string, bay: string): string {
  const path = resolve(root, bay)
  const prefix = `${resolve(root)}/`
  if (!path.startsWith(prefix)) throw new Error(`bay id '${bay}' escapes the configured bays root`)
  return path
}

export async function createGitWorkspace(options: GitWorkspaceOptions): Promise<BayWorkspace> {
  const repo = resolve(options.repo)
  const baysRoot = resolve(options.baysRoot ?? worktreeHomeRoot({ repo }))
  const transport = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const worktrees = createGitWorktreeStore({ ...options, gitProcess: transport })
  const { git } = worktrees
  await worktrees.ready()
  return {
    async provision(input: ProvisionBayInput): Promise<WorkspaceResult<ProvisionedBay>> {
      const path = safeBayPath(baysRoot, input.bay)
      // What this call made, so a failure removes exactly that and nothing it found (hh 25976): a half-made
      // worktree without its submodules refused the next open as "already exists" and looked usable.
      let madeWorktree = false
      let madeBranch: Readonly<{ ref: string; at: string }> | undefined
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
        let adoption: ProvisionedBay["adoption"]
        if (local.code === 0) {
          adoption = "local"
          try {
            await worktrees.add({ kind: "branch", path, branch: input.branch })
          } catch (cause) {
            rethrowWorktreeOwnershipConflict(cause)
          }
          madeWorktree = true
        } else {
          const remoteHead =
            tracking.code === 0 || input.originUnreachable === true
              ? undefined
              : await remoteBranchHead(git, repo, input.branch)
          adoption = tracking.code === 0 ? "tracking" : remoteHead === undefined ? "fresh" : "remote"
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
          madeWorktree = true
          madeBranch = { ref: localRef, at: await git.commit(repo, localRef) }
          if (tracking.code === 0) {
            await git.run(path, ["branch", "--set-upstream-to", `origin/${input.branch}`, input.branch])
          }
        }
        const omissions = await componentOmissions(git, path, input.omitCheckoutDirectories ?? [])
        await worktrees.materializeSubmodules(path, {
          ...(input.excludedSubmodules === undefined ? {} : { excludedSubmodules: input.excludedSubmodules }),
          ...(omissions.size === 0 ? {} : { checkoutOmissions: omissions }),
        })
        await verifyOmitted(git, path, omissions)
        const headSha = await git.commit(path, "HEAD")
        return { status: "completed", conclusion: "success", output: { path, headSha, baseSha, adoption } }
      } catch (cause) {
        if (!madeWorktree) return failure("provision-failed", cause)
        const undone: string[] = []
        let removedWorktree = false
        try {
          await worktrees.remove(path, { operation: `remove half-made environment ${path}` })
          removedWorktree = true
          undone.push(`removed the half-made environment ${path}`)
        } catch (removal) {
          undone.push(`could not remove the half-made environment ${path}: ${messageOf(removal)}`)
        }
        if (madeBranch !== undefined && removedWorktree) {
          // Compare-and-delete: only the branch this call created, and only while it still points where it was made.
          const deleted = await git.run(repo, ["update-ref", "-d", madeBranch.ref, madeBranch.at], true)
          undone.push(
            deleted.code === 0
              ? `deleted ${madeBranch.ref} (${madeBranch.at.slice(0, 12)})`
              : `could not delete ${madeBranch.ref}: ${deleted.stderr.trim()}`,
          )
        } else if (madeBranch !== undefined) {
          undone.push(`retained ${madeBranch.ref} for recovery of the registered environment`)
        }
        return failure("provision-failed", `${messageOf(cause)}; ${undone.join("; ")}`)
      }
    },
  }
}
