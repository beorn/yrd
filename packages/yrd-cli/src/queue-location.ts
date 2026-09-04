import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { configValue, gitIn } from "@yrd/queue-core"
import { parseQueueAddress, queueDirectory, queueRoot, type QueueAddress } from "./address.ts"
import { repositoryHere } from "./declaration.ts"
import { workdirOf } from "./workdir.ts"

export type QueueLocation = Readonly<{
  repo: string
  queue: string | undefined
  workdir: string
  address?: QueueAddress
}>

export async function originHead(git: ReturnType<typeof gitIn>): Promise<string> {
  const out = await git(["ls-remote", "--symref", "origin", "HEAD"])
  const branch = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/mu.exec(out)?.[1]
  if (branch === undefined || branch === "") {
    throw new Error("origin/HEAD did not name a queue branch; set the remote's HEAD or pass the queue branch")
  }
  return branch
}

async function hostWorkdir(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const declared = await configValue(gitIn(cwd), "yrd.workdir")
  if (declared !== undefined) return declared
  return join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "yrd")
}

async function ensureOwnedClone(root: string, address: QueueAddress): Promise<string> {
  const repo = queueDirectory(root, address)
  if (!existsSync(repo)) {
    mkdirSync(dirname(repo), { recursive: true })
    await gitIn(dirname(repo))(["clone", "--quiet", "--origin", "origin", "--no-checkout", address.transport, repo])
  }
  const git = gitIn(repo)
  const actual = (await git(["remote", "get-url", "origin"])).trim()
  if (actual !== address.transport) {
    throw new Error(
      `queue clone ${repo} has origin ${actual}, not ${address.transport}; move the mismatched clone aside and retry ${address.canonical}`,
    )
  }
  return repo
}

/** Resolve a queue-owner command without borrowing an unrelated checkout. */
export async function resolveQueueLocation(
  cwd: string,
  operand: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<QueueLocation> {
  const inside = repositoryHere(cwd)
  const addressed =
    operand !== undefined &&
    (operand.includes("#") || operand.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(operand))
  if (inside !== undefined && !addressed) {
    const git = gitIn(inside)
    return { repo: inside, queue: operand, workdir: await workdirOf(git) }
  }
  if (operand === undefined) {
    throw new Error(
      `queue owner command at ${cwd} needs a queue address <repo>#<queue>, for example beorn/hh#main; no Git clone contains the current directory`,
    )
  }
  const address = parseQueueAddress(operand)
  const host = await hostWorkdir(cwd, env)
  return {
    address,
    queue: address.queue,
    repo: await ensureOwnedClone(host, address),
    workdir: queueRoot(host, address),
  }
}
