import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * The `.yrd.yml` checked out at `start` or the nearest directory above it
 * within the same repository (the walk stops at the directory that holds
 * `.git`, a worktree's file or a repository's directory), with the directory
 * it was found in; undefined when there is none. A file that exists and
 * cannot be read is loud.
 *
 * This is the ONE declaration reader the CLI has. The wrapper's own strict
 * zod loader — a second parser of the same file, which had to be edited in
 * lockstep with the core's — died with the old core at M6 (plan § Owed after
 * M5, "one declaration parser"). Reading what this file SAYS is
 * `@yrd/queue-core`'s `hintsIn`/`readConfig`, and the target's declaration,
 * never this one, is the authority for a judgement.
 */
export function declarationHere(start: string): Readonly<{ root: string; text: string }> | undefined {
  let directory = resolve(start)
  for (;;) {
    try {
      return { root: directory, text: readFileSync(join(directory, ".yrd.yml"), "utf8") }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
    if (existsSync(join(directory, ".git"))) return undefined
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}
