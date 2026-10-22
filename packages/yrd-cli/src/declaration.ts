import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** The working repository containing `start`, without asking Git to guess past its boundary. */
export function repositoryHere(start: string): string | undefined {
  let directory = resolve(start)
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Refuse a container repository that carries no `.yrd.yml` of its own and holds a nested
 * `dev/` checkout that does (e.g. `/hh` containing `/hh/dev`, 30719): resolving an unaddressed
 * queue or environment from the container repository reads the container's origin and state path
 * instead of the nested checkout's.
 */
export function assertNotContainerRepository(repository: string, cwd: string): void {
  const nestedDev = join(repository, "dev")
  if (
    !existsSync(join(repository, ".yrd.yml")) &&
    existsSync(join(nestedDev, ".git")) &&
    existsSync(join(nestedDev, ".yrd.yml"))
  ) {
    throw new Error(
      `${resolve(cwd)} is inside container repository ${repository} (no .yrd.yml), not the nested checkout ${nestedDev}; ` +
        `run from ${nestedDev} or use \`@in -- bun yrd ...\``,
    )
  }
}
