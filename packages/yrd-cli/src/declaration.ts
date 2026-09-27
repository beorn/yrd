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
