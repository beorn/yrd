import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The resident memory of a process tree read once, at the moment its bound kills it (@cto dd0e43f2). One read, no
 * sampler: the peak is unknowable once the kill wins the race with the tree's own exit report, so this names what was
 * resident when the kill was decided. An unreadable /proc is said by its errno, never left blank.
 */
export type RssAtKill =
  | Readonly<{
      readable: true
      /** Processes in the group (or the direct child alone) that /proc still listed. */
      processes: number
      totalBytes: number
      /** VmSwap summed over the same processes: under memory pressure RSS alone hides what the tree holds. */
      swapBytes: number
      /** The process holding the most memory (resident plus swapped), with its own two figures. */
      largest?: Readonly<{ pid: number; comm: string; bytes: number; swapBytes: number }>
    }>
  | Readonly<{ readable: false; error: string }>

/**
 * Every live process whose process group is `pgid`, plus `pgid` itself (a child that is not a group leader still
 * counts), with its VmRSS. A process that exits mid-scan is skipped: it holds no memory any more.
 */
export function readRssAtKill(pgid: number, procRoot = "/proc"): RssAtKill {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch (error) {
    return { readable: false, error: errnoOf(error) }
  }
  let processes = 0
  let totalBytes = 0
  let swapBytes = 0
  let largest: { pid: number; comm: string; bytes: number; swapBytes: number } | undefined
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number(entry)
    // ENOENT/ESRCH on either read: the process exited mid-scan, so it holds nothing now.
    const stat = readOrNull(join(procRoot, entry, "stat"))
    if (stat === null) continue
    const close = stat.lastIndexOf(")")
    const comm = stat.slice(stat.indexOf("(") + 1, close)
    // Fields after the comm: state, ppid, pgrp, … (proc(5)). Only a group member's status is read.
    const pgrp = Number(stat.slice(close + 2).split(" ")[2])
    if (pgrp !== pgid && pid !== pgid) continue
    const status = readOrNull(join(procRoot, entry, "status"))
    if (status === null) continue
    // A zombie or kernel thread has no VmRSS/VmSwap line: it is in the group but holds no memory.
    const bytes = statusKib(status, "VmRSS") * 1024
    processes += 1
    totalBytes += bytes
    const swapped = statusKib(status, "VmSwap") * 1024
    swapBytes += swapped
    if (largest === undefined || bytes + swapped > largest.bytes + largest.swapBytes) {
      largest = { pid, comm, bytes, swapBytes: swapped }
    }
  }
  return { readable: true, processes, totalBytes, swapBytes, ...(largest === undefined ? {} : { largest }) }
}

/** "RSS at kill 10.0 GiB + swap 0.5 GiB (largest bun; …)", or "RSS unreadable: EACCES" — the clause a bound-kill reason carries. */
export function describeRssAtKill(rss: RssAtKill | undefined): string {
  if (rss === undefined) return "RSS unreadable: not measured by this process runner"
  if (!rss.readable) return `RSS unreadable: ${rss.error}`
  if (rss.largest === undefined) return "RSS at kill 0.0 GiB + swap 0.0 GiB (no process left in its group)"
  const { largest } = rss
  return (
    `RSS at kill ${gib(largest.bytes)} GiB + swap ${gib(largest.swapBytes)} GiB (largest ${largest.comm}; ` +
    `${String(rss.processes)} process(es), ${gib(rss.totalBytes)} GiB RSS + ${gib(rss.swapBytes)} GiB swap total)`
  )
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error)
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    // silent-fallback-allow: a process that exits between readdir and this read holds no memory; it is not a failure
    return null
  }
}

function statusKib(status: string, field: "VmRSS" | "VmSwap"): number {
  const kib = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "mu").exec(status)?.[1]
  return kib === undefined ? 0 : Number(kib)
}
