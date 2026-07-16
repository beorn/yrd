import { resolve } from "node:path"
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
