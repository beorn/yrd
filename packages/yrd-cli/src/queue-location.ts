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
  /** Submission retains its author checkout and sends to this transport. */
  remote?: string
  address?: QueueAddress
}>

export async function originHead(git: ReturnType<typeof gitIn>): Promise<string> {
  const out = await git(["ls-remote", "--symref", "origin", "HEAD"])
  const branch = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/mu.exec(out)?.[1]
  if (branch === undefined || branch === "") {
    throw new Error("origin/HEAD did not name a queue branch; set the remote's HEAD or pass --queue <branch>")
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

/** Resolve the one queue selector; only submission retains the author's checkout. */
export async function resolveQueueLocation(
  cwd: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  context: "queue" | "reader" | "submit" = "queue",
): Promise<QueueLocation> {
  const inside = repositoryHere(cwd)
  if (inside === undefined && context !== "queue") {
    throw new Error(
      `${context === "submit" ? "submit" : "queue list/show/watch"} at ${cwd} needs a repository; run inside a clone${context === "submit" ? " containing the branch to submit" : " or the queue-owned clone"}`,
    )
  }
  const addressed =
    value !== undefined &&
    (value.includes("#") || value.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value))
  if (inside !== undefined && !addressed) {
    const git = gitIn(inside)
    return { repo: inside, queue: value, workdir: await workdirOf(git) }
  }
  if (value === undefined || !addressed) {
    throw new Error(
      `queue command at ${cwd} needs a repository; run inside a clone or pass --queue <repo>#<queue>, for example --queue beorn/hh#main`,
    )
  }
  const address = parseQueueAddress(value)
  if (context === "submit" && inside !== undefined) {
    return {
      address,
      queue: address.queue,
      repo: inside,
      remote: address.transport,
      workdir: await workdirOf(gitIn(inside)),
    }
  }
  const host = await hostWorkdir(cwd, env)
  return {
    address,
    queue: address.queue,
    repo: await ensureOwnedClone(host, address),
    workdir: queueRoot(host, address),
  }
}
