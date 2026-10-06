import { isAbsolute, join, resolve } from "node:path"
import { queueName, remoteUrl, type Git } from "@yrd/queue-core"
import { parseQueueAddress, queueRoot, type QueueAddress } from "./address.ts"
import { hostWorkdir, originHead } from "./queue-location.ts"

export { hostWorkdir }

/**
 * The one generic temp root a queue child is narrowed to (27721).
 *
 * The queue resolves it ONCE, at the entry that already owns the workdir, and carries it down to every
 * selection that used to spell `<workdir>/tmp` for itself: compose derive, program-root setup, baseline
 * attribution, notify inside and outside a round, and the manual check. Generic Yrd learns no Hab marker,
 * no KM variable and no hh layout here — it accepts one ordinary, supplied `TMPDIR` and nothing else.
 *
 * An ABSENT or empty name keeps today's `<workdir>/tmp`. A name that is present but not a normalized
 * absolute path is refused with its own queried value: a managed launch that lost its temp root must fail
 * by name, never silently retarget a disk-backed scratch root back onto the workdir.
 */
export function queueTempRoot(workdir: string, env: NodeJS.ProcessEnv): string {
  const declared = env.TMPDIR
  if (declared === undefined || declared.trim() === "") return join(workdir, "tmp")
  if (!isAbsolute(declared) || declared.includes("\0") || resolve(declared) !== declared) {
    throw new Error(
      `TMPDIR must be a normalized absolute path; the queue read ${JSON.stringify(declared)} from the ` +
        `environment it runs in, and will not fall back to ${join(workdir, "tmp")}`,
    )
  }
  return declared
}

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
