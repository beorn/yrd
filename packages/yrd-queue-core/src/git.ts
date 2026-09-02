/**
 * The one git seam the core runs through.
 *
 * It is the existing process wrapper, unchanged: the plan reuses it rather than
 * growing a second way to spawn a child. Everything the core knows about a
 * repository comes through this function, so a test drives a real repository
 * and never a mock — the store is git, and a fake git would be a fake store.
 */

import { createProcess, type Process } from "@yrd/process"
import type { Git } from "./facts.ts"

/** A git runner rooted at one repository. Non-zero exits throw, loudly. */
export function gitIn(cwd: string, process?: Process): Git {
  const runner = process ?? createProcess({ cwd })
  return async (args: readonly string[]): Promise<string> => {
    const result = await runner.run({ argv: ["git", ...args], cwd })
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} in ${cwd} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return result.stdout
  }
}
