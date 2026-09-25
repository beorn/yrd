import { queueName, remoteUrl, type Git } from "@yrd/queue-core"
import { parseQueueAddress, queueRoot, type QueueAddress } from "./address.ts"
import { hostWorkdir, originHead } from "./queue-location.ts"

export { hostWorkdir }

/**
 * The queue workdir: the service's own state root, never a watch-side guess.
 * Resolves to the queue root under hostWorkdir for the repository's queue address.
 */
export async function workdirOf(
  git: Git,
  options?: { address?: QueueAddress; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const cwd = options?.cwd ?? process.cwd()
  const env = options?.env ?? process.env
  let address = options?.address
  if (address === undefined) {
    try {
      const queue = await originHead(git)
      const remote = "origin"
      const url = await remoteUrl(git, remote)
      address = parseQueueAddress(queueName({ branch: queue, remote }, url))
    } catch {
      // Unaddressed repository, no remote, or detached HEAD
    }
  }
  const host = await hostWorkdir(cwd, env, git)
  if (address !== undefined) {
    return queueRoot(host, address)
  }
  return host
}
