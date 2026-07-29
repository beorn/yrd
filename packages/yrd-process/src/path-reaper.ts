/**
 * Bay path process ownership — reap and certify every process still holding an
 * exclusive filesystem box.
 *
 * Process groups are the fast settlement path, but a descendant can create a
 * new session and leave its parent's group. The Bay path remains the durable
 * ownership fact: cwd, executable, or an open file under the root keeps the
 * process in the Bay lifecycle even after reparenting.
 */

import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"

export type PathReapResult = Readonly<{
  targetedPids: readonly number[]
  survivorPids: readonly number[]
  forcedKill: boolean
  signalFailures: readonly string[]
}>

export async function reapOwnedPath(path: string, gracefulMs: number, killMs: number): Promise<PathReapResult> {
  const root = await canonicalPath(path)
  const protectedPids = await currentProcessAncestry()
  const signalFailures: string[] = []
  const targeted = new Set<number>()
  const census = () => pathProcessPids(root)
  const killable = async (): Promise<number[]> => (await census()).filter((pid) => pid > 1 && !protectedPids.has(pid))
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
  const survivorPids = await census()
  return {
    targetedPids: [...targeted].sort((a, b) => a - b),
    survivorPids,
    forcedKill,
    signalFailures,
  }
}

export function pathReapFailure(result: PathReapResult): string | undefined {
  const parts: string[] = []
  if (result.signalFailures.length > 0) parts.push(result.signalFailures.join("; "))
  if (result.survivorPids.length > 0) {
    parts.push(`process-tree reap failed; survivor pids: ${result.survivorPids.join(", ")}`)
  }
  return parts.length === 0 ? undefined : parts.join("; ")
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

async function pathProcessPids(root: string): Promise<number[]> {
  if (process.platform === "linux") return linuxPathProcessPids(root)
  if (process.platform === "darwin") return darwinPathProcessPids(root)
  throw new Error(`unsupported platform ${process.platform}; cannot certify process-tree death`)
}

async function darwinPathProcessPids(root: string): Promise<number[]> {
  const child = Bun.spawn(["/usr/sbin/lsof", "+D", root, "-Fpn"], {
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
  return uniquePids(
    stdout
      .split("\n")
      .filter((line) => line.startsWith("p"))
      .map((line) => Number(line.slice(1))),
  )
}

async function linuxPathProcessPids(root: string): Promise<number[]> {
  const entries = await readdir("/proc", { withFileTypes: true })
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("Linux process census requires the current uid")
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry): Promise<number | undefined> => {
        const pid = Number(entry.name)
        const proc = `/proc/${entry.name}`
        const metadata = await stat(proc).catch((error: unknown) => {
          if (processGone(error)) return undefined
          throw error
        })
        if (metadata === undefined || metadata.uid !== uid) return undefined
        const [cwd, executable, argv] = await Promise.all([
          readProcessLink(`${proc}/cwd`),
          readProcessLink(`${proc}/exe`),
          readFile(`${proc}/cmdline`)
            .then((bytes) => bytes.toString("utf8").split("\0").filter(Boolean))
            .catch((error: unknown) => {
              if (processGone(error)) return []
              throw error
            }),
        ])
        if (
          (cwd !== undefined && pathWithin(root, cwd)) ||
          (executable !== undefined && pathWithin(root, executable)) ||
          argv.some((arg) => pathWithin(root, arg))
        ) {
          return pid
        }
        const descriptors = await readdir(`${proc}/fd`).catch((error: unknown) => {
          if (processGone(error)) return []
          throw error
        })
        for (const descriptor of descriptors) {
          const target = await readProcessLink(`${proc}/fd/${descriptor}`)
          if (target !== undefined && pathWithin(root, target)) return pid
        }
        return undefined
      }),
  )
  return uniquePids(matches.filter((pid): pid is number => pid !== undefined))
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

async function readProcessLink(path: string): Promise<string | undefined> {
  return readlink(path).catch((error: unknown) => {
    if (processGone(error)) return undefined
    throw error
  })
}

function processGone(error: unknown): boolean {
  const code = errorCode(error)
  return code === "ENOENT" || code === "ESRCH"
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
