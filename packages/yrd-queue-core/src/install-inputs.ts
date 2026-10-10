/**
 * Whether a candidate changes anything the target's one-line `setup:` reads —
 * the lockfile, every `package.json`, and the gitlinks — read by NAME from one
 * two-tree diff, never by hashing blobs and never by checking a tree out
 * (#28503, ruling 2026-10-10). yrd cannot read a target's `setup:`, so the list
 * is a deliberate superset: a change that touches none of it leaves provisioning
 * exactly as the target's own install proved it, which is what lets a phase with
 * no check of its own materialize nothing.
 */

import { treeDiffRows, type Git } from "./git.ts"

/**
 * The lockfiles a package manager writes. `bun.lock` is the one hh uses; the
 * rest are here so a target on another manager is never skipped by mistake,
 * since a name yrd does not know is a name it cannot judge.
 */
const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
])

/** Every file name `setup:` may read: the lockfiles and the manifests. */
const INSTALL_INPUT_NAMES: ReadonlySet<string> = new Set([...LOCKFILE_NAMES, "package.json"])

/** The last segment of one slash-separated repository path. */
function nameOf(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * The paths in `from..to` that a `setup:` may read, in git's order: a gitlink moving on either side, or a path named like a lockfile or a manifest.
 * Empty when the candidate changed none of them.
 */
export async function installInputPaths(git: Git, from: string, to: string): Promise<readonly string[]> {
  return (await treeDiffRows(git, from, to))
    .filter((row) => row.oldMode === "160000" || row.newMode === "160000" || INSTALL_INPUT_NAMES.has(nameOf(row.path)))
    .map((row) => row.path)
}

/** Whether a candidate's install inputs differ from its target's (#28503 slice 1). */
export async function installInputsChanged(git: Git, target: string, candidate: string): Promise<boolean> {
  return (await installInputPaths(git, target, candidate)).length > 0
}
