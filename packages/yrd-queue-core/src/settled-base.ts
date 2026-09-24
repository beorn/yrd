/** Compose the candidate's raised root gitlinks onto the target without its authored content. */
import type { Process } from "@yrd/process"
import { gitIn, type Git, type GitInvocationOptions, type GitSelection } from "./git.ts"
import type { RootChanges } from "./legacy-records.ts"
import { freshWorktree, type PlumbingLog } from "./worktree.ts"

export async function settledBaseCommit(
  options: Readonly<{
    git: Git
    repo: string
    targetSha: string
    raises: RootChanges["changes"]
    path: string
    branch: string
    env?: NodeJS.ProcessEnv
    gitOptions?: GitInvocationOptions
    plumbing?: PlumbingLog
    populateReference?: boolean
    process?: Process
    selection?: GitSelection
  }>,
): Promise<string> {
  if (options.raises.length === 0) return options.targetSha
  const composing = await freshWorktree(options.git, options.repo, options.targetSha, options.path, {
    env: options.env,
    gitOptions: options.gitOptions,
    plumbing: options.plumbing,
    populateReference: options.populateReference,
    process: options.process,
    selection: options.selection,
  })
  let commit = options.targetSha
  try {
    const wt = gitIn(composing.path, options.process, options.selection, options.gitOptions)
    for (const raise of options.raises) {
      const row = await wt([
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        options.targetSha,
        "--",
        raise.path,
      ])
      const target = /^160000 commit ([0-9a-f]{40,64})\t/u.exec(row)?.[1]
      if (target === undefined || row !== `160000 commit ${target}\t${raise.path}\0` || target === raise.to) continue
      await wt(["update-index", "-z", "--index-info"], `${raise.mode} ${raise.to}\t${raise.path}\0`)
    }
    const tree = (await wt(["write-tree"])).trim()
    const targetTree = (await wt(["rev-parse", `${options.targetSha}^{tree}`])).trim()
    if (tree !== targetTree) {
      commit = (
        await wt(["commit-tree", tree, "-p", options.targetSha, "-m", `settle the base for ${options.branch}`])
      ).trim()
      await options.git(["fetch", "--quiet", composing.path, commit])
    }
  } finally {
    await composing.remove()
  }
  return commit
}
