import { existsSync, readdirSync } from "node:fs"
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
 * The working repository for an unaddressed command: {@link repositoryHere}, refusing a
 * container repository that carries no `.yrd.yml` of its own and holds an immediate child
 * checkout with `.git` and `.yrd.yml` (30719, @cto b43f7ac8).
 */
export function unaddressedRepository(start: string): string | undefined {
  const repository = repositoryHere(start)
  if (repository === undefined || existsSync(join(repository, ".yrd.yml"))) return repository
  const nested = readdirSync(repository, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".git")
    .map((entry) => join(repository, entry.name))
    .filter((child) => existsSync(join(child, ".git")) && existsSync(join(child, ".yrd.yml")))
    .sort()
  if (nested.length > 0) {
    const nestedList = nested.join(", ")
    throw new Error(
      `${resolve(start)} is inside container repository ${repository} (no .yrd.yml), not the nested checkout${nested.length === 1 ? "" : "s"} ${nestedList}; ` +
        `run from ${nestedList}, or address the queue with --queue <repo>#<branch>`,
    )
  }
  return repository
}
