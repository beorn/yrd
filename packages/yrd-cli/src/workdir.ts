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
  // A repository without an origin has no queue address, so its workdir is the host's. Any other failure to read
  // origin (unreachable, no HEAD branch, a bad url) is an error: guessing would move every environment and log (25843).
  if (address === undefined && (await hasOrigin(git))) {
    const queue = await originHead(git)
    const remote = "origin"
    const url = await remoteUrl(git, remote)
    address = parseQueueAddress(queueName({ branch: queue, remote }, url))
  }
  const host = await hostWorkdir(cwd, env, git)
  if (address !== undefined) {
    return queueRoot(host, address)
  }
  return host
}

async function hasOrigin(git: Git): Promise<boolean> {
  return (await git(["remote"])).split("\n").some((name) => name.trim() === "origin")
}
