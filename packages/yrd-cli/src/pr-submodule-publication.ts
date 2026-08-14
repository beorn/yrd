import { isAbsolute, relative, resolve, sep } from "node:path"
import { authoredDeltaBase, type GitlinkAuthorshipGit } from "@yrd/bay"
import type { Process, ProcessResult } from "@yrd/process"
import { adaptProcessGit } from "@yrd/queue"
import { changedCommitGitlinks } from "git-super/commit-graph"
import { remoteContainsCommit } from "git-super/push"
import { cleanGitEnvironment } from "./git-environment.ts"

const GIT_TIMEOUT_MS = 30_000

export type UnpublishedSubmodulePin = Readonly<{
  path: string
  pin: string
  repository: string
}>

function componentRepository(repo: string, path: string): string {
  const repository = resolve(repo, path)
  const fromRoot = relative(repo, repository)
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`yrd: changed submodule path escapes the invocation repository: ${path}`)
  }
  if (isAbsolute(fromRoot)) throw new Error(`yrd: changed submodule path is outside the invocation repository: ${path}`)
  return repository
}

export async function unpublishedChangedSubmodulePins(options: {
  process: Pick<Process, "run">
  repo: string
  baseSha: string
  headSha: string
}): Promise<readonly UnpublishedSubmodulePin[]> {
  const changed = await changedSubmodulePins(options)
  return unpublishedSubmodulePins({ process: options.process, pins: changed })
}

export async function unpublishedSubmodulePins(options: {
  process: Pick<Process, "run">
  pins: readonly UnpublishedSubmodulePin[]
}): Promise<readonly UnpublishedSubmodulePin[]> {
  const git = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const unpublished: UnpublishedSubmodulePin[] = []

  for (const pin of options.pins) {
    const published = await remoteContainsCommit({
      repository: pin.repository,
      remote: "origin",
      commit: pin.pin,
      refPrefixes: ["refs/heads/"],
      timeoutMs: GIT_TIMEOUT_MS,
      git,
    })
    if (!published) unpublished.push(pin)
  }

  return Object.freeze(unpublished)
}

/**
 * The commit a PR's own changes are measured from in a client checkout: the
 * live merge base of its base branch and its head, resolved through the same
 * `origin/<base>` then `<base>` order every other client-side base lookup uses.
 *
 * Returns undefined when no ref for the base resolves locally. The caller must
 * refuse on that rather than fall back to the PR's recorded base — measuring
 * from a stored, independently-advancing field is exactly the misattribution
 * this replaces.
 */
export async function authoredSubmodulePinBase(options: {
  process: Pick<Process, "run">
  repo: string
  base: string
  headSha: string
}): Promise<string | undefined> {
  const repo = resolve(options.repo)
  const run: GitlinkAuthorshipGit = async (cwd, args) => {
    const result: ProcessResult = await options.process.run({
      argv: ["git", "-C", cwd, ...args],
      cwd,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (result.timedOut) {
      throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
    }
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
  const refs = options.base.startsWith("refs/") ? [options.base] : [`refs/remotes/origin/${options.base}`, options.base]
  for (const ref of refs) {
    const base = await authoredDeltaBase(run, repo, ref, options.headSha)
    if (base.status === "resolved") return base.sha
  }
  return undefined
}

export async function changedSubmodulePins(options: {
  process: Pick<Process, "run">
  repo: string
  baseSha: string
  headSha: string
}): Promise<readonly UnpublishedSubmodulePin[]> {
  const repo = resolve(options.repo)
  const git = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const changed = await changedCommitGitlinks(git, repo, options.baseSha, options.headSha)
  return Object.freeze(
    changed
      .map((entry) =>
        Object.freeze({ path: entry.path, pin: entry.target, repository: componentRepository(repo, entry.path) }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  )
}
