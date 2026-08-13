import { isAbsolute, relative, resolve, sep } from "node:path"
import { authoredDeltaBase, type GitlinkAuthorshipGit } from "@yrd/bay"
import type { Process, ProcessResult } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"

const GIT_TIMEOUT_MS = 30_000
const RawDiffEntryPattern = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/u

export type UnpublishedSubmodulePin = Readonly<{
  path: string
  pin: string
  repository: string
}>

type Git = (cwd: string, args: readonly string[]) => Promise<string>

async function runGit(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<string> {
  const result: ProcessResult = await process.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.timedOut) {
    throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
    throw new Error(`yrd: git ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout
}

function parseChangedSubmodulePins(raw: string): readonly Readonly<{ path: string; pin: string }>[] {
  const fields = raw.split("\0")
  if (fields.at(-1) === "") fields.pop()
  if (fields.length % 2 !== 0) {
    throw new Error("yrd: git diff-tree returned an incomplete raw path record")
  }

  const pins: Readonly<{ path: string; pin: string }>[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index]
    const path = fields[index + 1]
    if (metadata === undefined || path === undefined || path === "") {
      throw new Error("yrd: git diff-tree returned an invalid raw path record")
    }
    const match = RawDiffEntryPattern.exec(metadata)
    if (match === null) throw new Error(`yrd: git diff-tree returned an invalid raw entry: ${metadata}`)
    const [, , newMode, , newSha] = match
    if (newMode === undefined || newSha === undefined) {
      throw new Error(`yrd: git diff-tree omitted a required raw entry field: ${metadata}`)
    }
    if (newMode === "160000") pins.push(Object.freeze({ path, pin: newSha }))
  }
  return Object.freeze(pins)
}

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
  const git: Git = (cwd, args) => runGit(options.process, cwd, args)
  const unpublished: UnpublishedSubmodulePin[] = []

  for (const pin of options.pins) {
    await git(pin.repository, ["fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    const refs = await git(pin.repository, [
      "for-each-ref",
      "--format=%(refname)",
      `--contains=${pin.pin}`,
      "refs/remotes/origin/",
    ])
    if (refs.trim() === "") unpublished.push(pin)
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
  const git: Git = (cwd, args) => runGit(options.process, cwd, args)
  const raw = await git(repo, [
    "diff-tree",
    "--no-commit-id",
    "--raw",
    "-r",
    "-z",
    "--no-renames",
    options.baseSha,
    options.headSha,
    "--",
  ])
  return Object.freeze(
    parseChangedSubmodulePins(raw)
      .map((changed) => Object.freeze({ ...changed, repository: componentRepository(repo, changed.path) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  )
}
