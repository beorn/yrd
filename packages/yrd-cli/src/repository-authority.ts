import { adaptProcessGit, type GitSyncReadCommand } from "@yrd/process"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * One repository selector resolved to the two paths every Yrd rail needs: the
 * primary worktree that owns the journal, and the common Git directory that
 * holds it.
 *
 * A composition host names repositories before any Yrd module can open one, so
 * these resolvers are deliberately synchronous and process-free where they can
 * be — they run ahead of the runtime, not inside it. Every Git call scrubs
 * inherited `GIT_*` variables first: Git honors those ahead of `-C`, so ambient
 * hook state would otherwise silently redirect authority to another repository.
 */

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const gitReader = adaptProcessGit(undefined)

function git(repositoryRoot: string, command: GitSyncReadCommand): string {
  const result = gitReader.readSync({ repo: repositoryRoot, command })
  if (result.code !== 0 || result.failure !== undefined) {
    throw new Error(result.stderr.trim() || result.failure || `git ${command.verb} exited ${result.code}`)
  }
  return result.stdout
}

/**
 * The primary worktree for a selected repository root.
 *
 * A linked worktree shares one journal with the repository that created it, so
 * a selector pointing at a slot must resolve to the primary worktree or the
 * same delivery state gets opened through two different authorities.
 */
export function repositoryAuthority(selectedRoot: string): string {
  const repositoryRoot = resolve(selectedRoot)
  const dotGit = join(repositoryRoot, ".git")
  if (!existsSync(dotGit)) throw new Error(`yrd: declared repository ${repositoryRoot} has no ${dotGit}`)
  if (lstatSync(dotGit).isDirectory()) return realpathSync(repositoryRoot)
  let output
  try {
    output = git(repositoryRoot, { verb: "worktree-list" })
  } catch (error) {
    throw new Error(`yrd: cannot resolve repository authority for ${repositoryRoot}: ${detail(error)}`)
  }
  const authority = output
    .split("\0")
    .find((field) => field.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim()
  if (!authority) throw new Error(`yrd: git returned no main worktree authority for ${repositoryRoot}`)
  return resolve(authority)
}

/** The common Git directory at one root, or undefined when the root is not a
 * repository. A linked worktree's `.git` is a file pointing at the shared
 * directory, so the answer comes from Git rather than from the path. */
export function gitDirAt(repositoryRoot: string): string | undefined {
  const dotGit = join(repositoryRoot, ".git")
  if (!existsSync(dotGit)) return undefined
  if (lstatSync(dotGit).isDirectory()) return realpathSync(dotGit)
  try {
    return resolve(
      repositoryRoot,
      git(repositoryRoot, { verb: "rev-parse", args: ["--path-format=absolute", "--git-common-dir"] }).trim(),
    )
  } catch (error) {
    throw new Error(`yrd: cannot resolve common Git directory for ${repositoryRoot}: ${detail(error)}`)
  }
}

export type RepositoryGitDirSelection = Readonly<{
  /** Repository chosen by a composition host or an explicit `--repo`. */
  selected?: string
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  /** Last resort for a runtime launched outside any repository. */
  runtimeRoot?: string
}>

/**
 * The one common Git directory a command's out-of-band state belongs to,
 * resolved in declaration order: an explicit selection, then `YRD_REPO`, then
 * the invocation directory's own repository, then the runtime's root.
 *
 * Each step that is DECLARED and wrong refuses by name rather than falling
 * through to the next: a typo in `YRD_REPO` silently answering from the cwd's
 * repository is how out-of-band state merges beside a repository nobody asked
 * about.
 */
export function repositoryGitDir(selection: RepositoryGitDirSelection): string {
  if (selection.selected !== undefined) {
    const repositoryRoot = resolve(selection.selected)
    const selectedGitDir = gitDirAt(repositoryRoot)
    if (selectedGitDir !== undefined) return selectedGitDir
    throw new Error(`yrd: declared repository ${repositoryRoot} has no ${join(repositoryRoot, ".git")}`)
  }
  for (const name of ["YRD_REPO"]) {
    const declared = selection.env[name]?.trim()
    if (!declared) continue
    const repositoryRoot = resolve(declared)
    const declaredGitDir = gitDirAt(repositoryRoot)
    if (declaredGitDir !== undefined) return declaredGitDir
    throw new Error(
      `yrd: ${name}=${repositoryRoot} is not a Git repository (${join(repositoryRoot, ".git")} is missing); ` +
        `point ${name} at the repository this command operates on`,
    )
  }
  let dir = resolve(selection.cwd)
  for (;;) {
    const cwdGitDir = gitDirAt(dir)
    if (cwdGitDir !== undefined) return cwdGitDir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (selection.runtimeRoot !== undefined) {
    const runtimeGitDir = gitDirAt(selection.runtimeRoot)
    if (runtimeGitDir !== undefined) return runtimeGitDir
  }
  throw new Error(`yrd: no Git repository at or above ${resolve(selection.cwd)} and none declared; set YRD_REPO`)
}
