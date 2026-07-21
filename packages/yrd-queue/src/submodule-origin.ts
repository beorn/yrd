import { isAbsolute, resolve } from "node:path"
import { join as joinPosix, normalize as normalizePosix } from "node:path/posix"

const REMOTE_SCHEME = /^[a-z][a-z\d+.-]*:/iu
const SCP_REMOTE = /^((?:[^/@:]+@)?[^/:]+:)(.+)$/u

/** Resolve a Git-relative submodule URL with the superproject remote as a directory. */
export function resolveRelativeSubmoduleOrigin(superOrigin: string, relativeUrl: string): string {
  if (REMOTE_SCHEME.test(superOrigin)) {
    const directory = new URL(superOrigin)
    if (!directory.pathname.endsWith("/")) directory.pathname += "/"
    return new URL(relativeUrl, directory).toString()
  }

  const scp = SCP_REMOTE.exec(superOrigin)
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return `${scp[1]}${normalizePosix(joinPosix(scp[2], relativeUrl))}`
  }

  return resolve(superOrigin, relativeUrl)
}

/** Canonicalize a non-relative submodule URL: absolute paths, URLs with a
 * scheme, and scp-like remotes pass through; a bare local path resolves against
 * the superproject worktree. */
function canonicalRemote(repo: string, value: string): string {
  if (isAbsolute(value) || REMOTE_SCHEME.test(value) || SCP_REMOTE.test(value)) return value
  return resolve(repo, value)
}

/**
 * Resolve a submodule's declared URL to a reachable origin, matching Git's own
 * resolution: relative URLs (`./x`, `../x`) resolve against the superproject
 * origin; everything else is canonicalized. Throws when a relative URL has no
 * superproject origin to resolve against.
 */
export function resolveSubmoduleOrigin(repo: string, superOrigin: string | undefined, value: string): string {
  if (!value.startsWith("./") && !value.startsWith("../")) return canonicalRemote(repo, value)
  if (superOrigin === undefined) {
    throw new Error(`yrd: relative submodule URL '${value}' has no superproject origin`)
  }
  const base = canonicalRemote(repo, superOrigin)
  try {
    return resolveRelativeSubmoduleOrigin(base, value)
  } catch (cause) {
    throw new Error(
      `yrd: could not resolve submodule URL '${value}' against '${base}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}
