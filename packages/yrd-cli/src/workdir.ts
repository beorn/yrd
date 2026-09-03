import { join } from "node:path"
import { configValue, type Git } from "@yrd/queue-core"

/**
 * The queue's working directory, where everything it writes goes: whatever
 * `git config yrd.workdir` resolves to in the repository the command runs in —
 * any scope git honours, so a host says it once in `--global` and a single
 * repository can say otherwise — else `<git-common-dir>/yrd`.
 *
 * It is git configuration and not a `.yrd.yml` key because it is about THIS
 * MACHINE, not about the queue: the declaration is one file shared by every
 * clone, and a path on the queue runner's disk means nothing in a seat's
 * checkout.
 *
 * A worktree's `.git` is a file, so the default lives under the common git dir
 * the whole repository shares, never under a path guessed from it.
 */
export async function workdirOf(git: Git): Promise<string> {
  const declared = await configValue(git, "yrd.workdir")
  if (declared !== undefined) return declared
  const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  return join(commonDir, "yrd")
}
