/**
 * Compose the candidate's raised root gitlinks onto the target, together with the root lockfile(s) that same change
 * authored (hh #38155).
 *
 * A gitlink raise carries its content INSIDE the submodule; what the root keeps is its lockfile, which describes every
 * workspace member's version. A base composed from the raise alone therefore pairs a new member version with the
 * target's old lock, and a check that validates the base (lockfile-agreement, `bun install --frozen-lockfile`) then
 * refuses a tree no author ever wrote. The candidate is the only place that pairing exists, so when a raise moves, the
 * candidate's own blob for each root lockfile rides along.
 */
import type { Process } from "@yrd/process"
import { gitIn, resolveGitSelection, type Git, type GitInvocationOptions, type GitSelection } from "./git.ts"
import type { RootChanges } from "./root-changes.ts"
import { freshWorktree, type PlumbingLog, discardWorktree } from "./worktree.ts"

export async function settledBaseCommit(
  options: Readonly<{
    git: Git
    repo: string
    targetSha: string
    raises: RootChanges["changes"]
    /** The change the raises came from: the only tree where a raised pin and its root lockfile agree. */
    candidate?: string
    /**
     * The target's `derive-root-paths:` — the same declaration the derive carries a regenerated file under, so ONE
     * list governs both places and yrd stays generic (@cto dcf4a12e, 2026-11-24).
     */
    rootPaths?: readonly string[]
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
  const selection =
    options.selection ?? (await resolveGitSelection(options.repo, { process: options.process, env: options.env }))
  const composing = await freshWorktree(options.git, options.repo, options.targetSha, options.path, {
    env: options.env,
    gitOptions: options.gitOptions,
    plumbing: options.plumbing,
    populateReference: options.populateReference,
    process: options.process,
    selection,
  })
  let commit = options.targetSha
  let moved = 0
  const movedRaises: string[] = []
  try {
    const wt = gitIn(composing.path, options.process, selection, options.gitOptions)
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
      moved += 1
      movedRaises.push(raise.path)
    }
    const declared = options.rootPaths ?? []
    if (moved > 0 && options.candidate !== undefined && declared.length > 0) {
      // The candidate's lock blob may also carry THAT change's own root manifest edits, and a base must hold no
      // authored content (@cto dcf4a12e). Pairing is honest only when every root manifest outside a gitlink is the
      // same in both trees — then the lock difference can only come from the raises. Otherwise refuse by name.
      const manifests = async (sha: string): Promise<Map<string, string>> => {
        const rows = (await wt(["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", sha]))
          .split("\0")
          .filter((row) => row !== "")
        const entries = new Map<string, string>()
        for (const row of rows) {
          const entry = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t(.*)$/u.exec(row)
          if (entry === null) continue
          const path = entry[3] ?? ""
          // `-r` never descends into a gitlink, so a manifest here is never one inside a submodule.
          if (path === "package.json" || path.endsWith("/package.json")) entries.set(path, `${entry[1]} ${entry[2]}`)
        }
        return entries
      }
      const atTarget = await manifests(options.targetSha)
      const atCandidate = await manifests(options.candidate)
      const edited = [...new Set([...atTarget.keys(), ...atCandidate.keys()])]
        .filter((path) => atTarget.get(path) !== atCandidate.get(path))
        .sort()
      if (edited.length > 0) {
        throw new Error(
          `settled base refused (the queue's, not the submitter's): change raises ${movedRaises.join(", ")} and edits root manifests ${edited.join(", ")}; the base cannot pair its lock. Submit the raise separately.`,
        )
      }
      for (const name of declared) {
        const entry = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.*)$/u.exec(
          (await wt(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", options.candidate, "--", name])).replace(/\0$/u, ""),
        )
        if (entry === null) continue
        const targetEntry = await wt([
          "--literal-pathspecs",
          "ls-tree",
          "-z",
          "--full-tree",
          options.targetSha,
          "--",
          name,
        ])
        if (targetEntry === `${entry[1]} blob ${entry[2]}\t${name}\0`) continue
        await wt(["update-index", "-z", "--index-info"], `${entry[1]} ${entry[2]}\t${name}\0`)
      }
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
    await discardWorktree(composing)
  }
  return commit
}
