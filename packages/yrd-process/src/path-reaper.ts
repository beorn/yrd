/**
 * Path process ownership — inspect, reap, and certify every process still
 * holding an exclusive filesystem box.
 *
 * Process groups are the fast settlement path, but a descendant can create a
 * new session and leave its parent's group. The Bay path remains the durable
 * ownership fact: cwd, executable, or an open file under the root keeps the
 * process in the Bay lifecycle even after reparenting.
 */

import { readdir, readlink, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"

export type PathHolder = Readonly<{
  pid: number
  source: "cwd" | "exe" | "root" | `fd/${string}`
  target: string
}>

export type PathReapResult = Readonly<{
  targetedPids: readonly number[]
  survivorPids: readonly number[]
  /** Exact read-only holder evidence from the final post-signal census. */
  survivorHolders?: readonly PathHolder[]
  forcedKill: boolean
  signalFailures: readonly string[]
}>

export async function reapOwnedPath(path: string, gracefulMs: number, killMs: number): Promise<PathReapResult> {
  const root = await canonicalPath(path)
  const protectedPids = await currentProcessAncestry()
  const signalFailures: string[] = []
  const targeted = new Set<number>()
  const census = async () => pathProcessHolders(root)
  const killable = async (): Promise<number[]> =>
    uniquePids((await census()).map(({ pid }) => pid)).filter((pid) => pid > 1 && !protectedPids.has(pid))
  const signal = (pids: readonly number[], value: "SIGTERM" | "SIGKILL"): void => {
    for (const pid of pids) {
      targeted.add(pid)
      try {
        process.kill(pid, value)
      } catch (error) {
        if (errorCode(error) !== "ESRCH") {
          signalFailures.push(`pid ${pid} ${value} failed (${errorCode(error) ?? errorDetail(error)})`)
        }
      }
    }
  }

  let live = await killable()
  signal(live, "SIGTERM")
  live = await waitForPathProcesses(killable, gracefulMs)
  const forcedKill = live.length > 0
  if (forcedKill) {
    signal(live, "SIGKILL")
    await waitForPathProcesses(killable, killMs)
  }
  // Re-census the complete ownership set. Protected caller/ancestor PIDs are
  // deliberately never signalled, but they remain survivor evidence: closing a
  // Bay from a shell inside that Bay must fail loudly instead of deleting the
  // workspace beneath a still-live process.
  const survivorHolders = await census()
  const survivorPids = uniquePids(survivorHolders.map(({ pid }) => pid))
  return {
    targetedPids: [...targeted].sort((a, b) => a - b),
    survivorPids,
    survivorHolders,
    forcedKill,
    signalFailures,
  }
}

export function pathReapFailure(result: PathReapResult): string | undefined {
  const parts: string[] = []
  if (result.signalFailures.length > 0) parts.push(result.signalFailures.join("; "))
  const holderFailure = pathHolderRefusal(result.survivorHolders ?? [])
  if (holderFailure !== undefined) parts.push(holderFailure)
  else if (result.survivorPids.length > 0) {
    parts.push(`process-tree reap failed; survivor pids: ${result.survivorPids.join(", ")}`)
  }
  return parts.length === 0 ? undefined : parts.join("; ")
}

/** Render read-only holder evidence into an actionable destructive-operation refusal. */
export function pathHolderRefusal(holders: readonly PathHolder[]): string | undefined {
  const evidence = uniquePathHolders(holders)
  if (evidence.length === 0) return undefined
  return `path remains held by ${evidence
    .map(({ pid, source, target }) => `pid ${pid} via ${source} (${target})`)
    .join("; ")}`
}

const PATH_REAP_POLL_MS = 50

async function waitForPathProcesses(read: () => Promise<number[]>, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let live = await read()
  while (live.length > 0 && Date.now() < deadline) {
    await Bun.sleep(Math.min(PATH_REAP_POLL_MS, Math.max(1, deadline - Date.now())))
    live = await read()
  }
  return live
}

export async function inspectPathHolders(path: string): Promise<PathHolder[]> {
  return pathProcessHolders(await canonicalPath(path))
}

/** @internal Deterministic Linux seam for a synthetic proc tree. */
export async function inspectPathHoldersInProc(path: string, procRoot: string): Promise<PathHolder[]> {
  return pathProcessHolders(await canonicalPath(path), { procRoot })
}

async function pathProcessHolders(root: string, options: Readonly<{ procRoot?: string }> = {}): Promise<PathHolder[]> {
  if (process.platform === "linux") return linuxPathProcessHolders(root, options.procRoot ?? "/proc")
  if (process.platform === "darwin") return darwinPathProcessHolders(root)
  throw new Error(`unsupported platform ${process.platform}; cannot certify path ownership`)
}

async function darwinPathProcessHolders(root: string): Promise<PathHolder[]> {
  const child = Bun.spawn(["/usr/sbin/lsof", "+D", root, "-Fpfn"], {
    cwd: "/",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // lsof uses 1 for a successful empty selection.
  if (exitCode !== 0 && (exitCode !== 1 || stderr.trim() !== "")) {
    throw new Error(`lsof exited ${exitCode}: ${stderr.trim() || "no diagnostic"}`)
  }
  const holders: PathHolder[] = []
  let pid: number | undefined
  let source: PathHolder["source"] | undefined
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1))
      source = undefined
      continue
    }
    if (line.startsWith("f")) {
      source = darwinHolderSource(line.slice(1))
      continue
    }
    if (
      line.startsWith("n") &&
      pid !== undefined &&
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      source !== undefined &&
      pathWithin(root, line.slice(1))
    ) {
      holders.push({ pid, source, target: line.slice(1) })
    }
  }
  return uniquePathHolders(holders)
}

async function linuxPathProcessHolders(root: string, procRoot: string): Promise<PathHolder[]> {
  const entries = await readdir(procRoot, { withFileTypes: true })
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("Linux process census requires the current uid")
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry): Promise<PathHolder[]> => {
        const pid = Number(entry.name)
        const proc = `${procRoot}/${entry.name}`
        const metadata = await stat(proc).catch((error: unknown) => {
          if (processEntryUnavailable(error)) return undefined
          throw error
        })
        if (metadata === undefined || metadata.uid !== uid) return []
        const [cwd, executable, processRoot] = await Promise.all([
          readProcessLink(`${proc}/cwd`),
          readProcessLink(`${proc}/exe`),
          readProcessLink(`${proc}/root`),
        ])
        const holders: PathHolder[] = []
        if (cwd !== undefined && pathWithin(root, cwd)) holders.push({ pid, source: "cwd", target: cwd })
        if (executable !== undefined && pathWithin(root, executable)) {
          holders.push({ pid, source: "exe", target: executable })
        }
        if (processRoot !== undefined && pathWithin(root, processRoot)) {
          holders.push({ pid, source: "root", target: processRoot })
        }
        const descriptors = await readdir(`${proc}/fd`).catch((error: unknown) => {
          if (processEntryUnavailable(error)) return []
          throw error
        })
        for (const descriptor of descriptors) {
          const target = await readProcessLink(`${proc}/fd/${descriptor}`)
          if (target !== undefined && pathWithin(root, target)) {
            holders.push({ pid, source: `fd/${descriptor}`, target })
          }
        }
        return holders
      }),
  )
  return uniquePathHolders(matches.flat())
}

async function currentProcessAncestry(): Promise<Set<number>> {
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid="], {
    cwd: "/",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`ps exited ${exitCode}: ${stderr.trim() || "no diagnostic"}`)
  const parents = new Map<number, number>()
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/u)
    if (match === null) continue
    parents.set(Number(match[1]), Number(match[2]))
  }
  const ancestry = new Set<number>()
  let pid = process.pid
  while (pid > 1) {
    if (ancestry.has(pid)) throw new Error(`ps reported a cycle in current process ancestry at pid ${pid}`)
    ancestry.add(pid)
    const parent = parents.get(pid)
    if (parent === undefined) throw new Error(`ps omitted parent identity for current ancestry pid ${pid}`)
    pid = parent
  }
  return ancestry
}

async function canonicalPath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") throw new TypeError("yrd: reapPath requires a non-empty path")
  return realpath(resolve(path))
}

function pathWithin(root: string, candidate: string): boolean {
  const clean = candidate.endsWith(" (deleted)") ? candidate.slice(0, -" (deleted)".length) : candidate
  return clean === root || clean.startsWith(`${root}${sep}`)
}

function uniquePids(values: readonly number[]): number[] {
  return [...new Set(values.filter((pid) => Number.isSafeInteger(pid) && pid > 1))].sort((a, b) => a - b)
}

function uniquePathHolders(values: readonly PathHolder[]): PathHolder[] {
  const unique = new Map<string, PathHolder>()
  for (const holder of values) unique.set(`${holder.pid}\0${holder.source}\0${holder.target}`, holder)
  return [...unique.values()].sort(
    (left, right) =>
      left.pid - right.pid || left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  )
}

function darwinHolderSource(field: string): PathHolder["source"] {
  if (field === "cwd") return "cwd"
  if (field === "txt") return "exe"
  if (field === "rtd") return "root"
  return `fd/${field}`
}

async function readProcessLink(path: string): Promise<string | undefined> {
  return readlink(path).catch((error: unknown) => {
    if (processEntryUnavailable(error)) return undefined
    throw error
  })
}

function processEntryUnavailable(error: unknown): boolean {
  const code = errorCode(error)
  // `/proc` is a live, permission-filtered view. Entries may disappear between
  // readdir and inspection, and Linux security policy may hide cwd/exe/fd for
  // an otherwise same-uid process. Treat each hidden source as unavailable and
  // continue checking the remaining sources; an observable Bay-owned path
  // still enters the kill/survivor set.
  return code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM"
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
