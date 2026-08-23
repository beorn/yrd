import { isAbsolute, relative, resolve, sep } from "node:path"
import { authoredDeltaBase, type GitlinkAuthorshipGit } from "@yrd/bay"
import { adaptProcessGit, type Process, type ProcessResult } from "@yrd/process"
import { resolveSubmoduleMain, type SubmoduleMainGit } from "@yrd/queue"
import { changedCommitGitlinks, readCommitGitlinks } from "git-super/commit-graph"
import { remoteContainsCommit } from "git-super/push"
import { cleanGitEnvironment } from "./git-environment.ts"

const GIT_TIMEOUT_MS = 30_000

export type UnpublishedSubmodulePin = Readonly<{
  path: string
  pin: string
  repository: string
}>

function submoduleRepository(repo: string, path: string): string {
  const repository = resolve(repo, path)
  const fromRoot = relative(repo, repository)
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`yrd: changed submodule path escapes the invocation repository: ${path}`)
  }
  if (isAbsolute(fromRoot)) throw new Error(`yrd: changed submodule path is outside the invocation repository: ${path}`)
  return repository
}

/**
 * The pins the queue could NOT fetch from their submodule's origin — reachability, the
 * queue-carried question. A composition or re-merge pin is queue-authored: its commit only
 * needs to be somewhere the merge path can fetch it from, because submodule main is
 * promoted AT merge, not before. This is deliberately the old any-branch oracle under an
 * honest name; asking main-ancestry here would deadlock the publication pipeline, since a
 * queue-carried pin cannot be on main until the very merge being admitted.
 *
 * Author min commits ask a different question — `submodulePinPublications` below — and the two
 * used to share one word ("unpublished"), which is how a side-branch pin passed as
 * published for two months.
 */
export async function unreachableSubmodulePins(options: {
  process: Pick<Process, "run">
  pins: readonly UnpublishedSubmodulePin[]
}): Promise<readonly UnpublishedSubmodulePin[]> {
  const git = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const unreachable: UnpublishedSubmodulePin[] = []

  for (const pin of options.pins) {
    const reachable = await remoteContainsCommit({
      repository: pin.repository,
      remote: "origin",
      commit: pin.pin,
      refPrefixes: ["refs/heads/"],
      timeoutMs: GIT_TIMEOUT_MS,
      git,
    })
    if (!reachable) unreachable.push(pin)
  }

  return Object.freeze(unreachable)
}

export type SubmodulePinPublication =
  | Readonly<{ state: "on-submodule-main"; pin: UnpublishedSubmodulePin }>
  | Readonly<{ state: "off-submodule-main"; pin: UnpublishedSubmodulePin; mainSha: string }>
  | Readonly<{ state: "undetermined"; pin: UnpublishedSubmodulePin; reason: string }>

/**
 * Where each changed pin sits relative to its own submodule's MAIN — the shaset model's
 * submodule-main-first rule, asked with the merge path's mechanism.
 *
 * This used to ask git-super whether the commit sat under any tip matching `refs/heads/`,
 * which is every branch, so a pin pushed only to someone's unmerged side branch counted as
 * published. That was harmless only while the authored-gitlink refusal rejected the request
 * a few lines later regardless; the shaset build removes that backstop, and admitting a pin
 * the submodule never accepted would compose a candidate against a commit with no home.
 *
 * Three states, not two, and the third is the point: "I could not tell" must never collapse
 * into "not published". They need opposite remedies — one says merge your commit on the
 * submodule's main, the other says the check could not reach the submodule's origin at all —
 * and reporting the second as the first sends someone to merge a branch over a network fault.
 */
export async function submodulePinPublications(options: {
  process: Pick<Process, "run">
  pins: readonly UnpublishedSubmodulePin[]
}): Promise<readonly SubmodulePinPublication[]> {
  const run: SubmoduleMainGit = async (repository, args) => {
    const result: ProcessResult = await options.process.run({
      argv: ["git", "-C", repository, ...args],
      cwd: repository,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  const publications: SubmodulePinPublication[] = []
  for (const pin of options.pins) {
    const main = await resolveSubmoduleMain(run, pin.repository, "origin")
    if (main.status === "unavailable") {
      publications.push({ state: "undetermined", pin, reason: main.message })
      continue
    }
    // Ask before comparing, so a pin that is simply absent here is named as absent rather
    // than surfacing as an unreadable merge-base failure.
    const present = await run(pin.repository, ["cat-file", "-e", `${pin.pin}^{commit}`])
    if (present.code !== 0) {
      publications.push({
        state: "undetermined",
        pin,
        reason: `commit '${pin.pin}' is not present in '${pin.repository}', so it cannot be compared with that submodule's main`,
      })
      continue
    }
    const reached = await run(pin.repository, ["merge-base", "--is-ancestor", pin.pin, main.sha])
    if (reached.code === 0) {
      publications.push({ state: "on-submodule-main", pin })
      continue
    }
    if (reached.code === 1) {
      publications.push({ state: "off-submodule-main", pin, mainSha: main.sha })
      continue
    }
    publications.push({
      state: "undetermined",
      pin,
      reason:
        `could not compare '${pin.pin}' with submodule main '${main.sha}': ` +
        `${reached.stderr.trim() || reached.stdout.trim() || "git merge-base failed"}`,
    })
  }

  return Object.freeze(publications)
}

/**
 * The commit a change's own changes are measured from in a client checkout: the
 * live merge base of its base branch and its head, resolved through the same
 * `origin/<base>` then `<base>` order every other client-side base lookup uses.
 *
 * Returns undefined when no ref for the base resolves locally. The caller must
 * refuse on that rather than fall back to the change's recorded base — measuring
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
        Object.freeze({ path: entry.path, pin: entry.target, repository: submoduleRepository(repo, entry.path) }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  )
}

/**
 * Which of a set of changed gitlinks are NEW paths — added by `headSha`, absent at `baseSha`
 * — as opposed to an existing gitlink's value moving.
 *
 * `changedCommitGitlinks` (git-super) is structurally blind to a THIRD case, deletion: it
 * diffs by reading `headSha`'s own gitlinks and keeping the ones whose value differs from
 * `baseSha`, so a path present at `baseSha` and absent at `headSha` never appears in either
 * function's output at all — a pre-existing gap this function does not attempt to close.
 *
 * Distinguishing an addition matters because a min commit is a floor on an EXISTING
 * submodule: the shaset-commit writer (`synthesizeGitlinkWrapper`) is update-only (comma-form
 * `--cacheinfo` cannot add a path), so admitting an added gitlink here would let a request
 * through that composition can never actually satisfy.
 */
export async function addedSubmodulePins(options: {
  process: Pick<Process, "run">
  repo: string
  baseSha: string
  pins: readonly UnpublishedSubmodulePin[]
}): Promise<readonly UnpublishedSubmodulePin[]> {
  if (options.pins.length === 0) return Object.freeze([])
  const repo = resolve(options.repo)
  const git = adaptProcessGit(options.process, { timeoutMs: GIT_TIMEOUT_MS })
  const atBase = new Set((await readCommitGitlinks(git, repo, options.baseSha)).map((entry) => entry.path))
  return Object.freeze(options.pins.filter((pin) => !atBase.has(pin.path)))
}
