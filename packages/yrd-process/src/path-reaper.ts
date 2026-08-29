/**
 * Path process ownership — inspect, reap, and certify every process still
 * holding an exclusive filesystem sandbox.
 *
 * Process groups are the fast settlement path, but a descendant can create a
 * new session and leave its parent's group. The Bay path remains the durable
 * ownership fact: cwd, executable, or an open file under the root keeps the
 * process in the Bay lifecycle even after reparenting.
 */

import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"

export type PathHolder = Readonly<{
  pid: number
  source: "cwd" | "exe" | "root" | `fd/${string}`
  target: string
}>

export type PathHolderUnavailableCoverage = Readonly<{
  /** ENOENT/ESRCH: the live proc entry disappeared while the census ran. */
  exited: number
  /** EACCES/EPERM: the entry remained but the caller was not allowed to inspect it. */
  denied: number
}>

export type PathHolderSourceCoverage = Readonly<{
  readable: number
  unavailable: PathHolderUnavailableCoverage
}>

export type LinuxPathHolderCoverage = Readonly<{
  platform: "linux"
  /** Linux filters numeric proc entries to the caller's UID before inspecting holder sources. */
  scope: "same-uid"
  procRoot: string
  /** False only when permission denial may have hidden a same-UID holder. Exited entries are not gaps. */
  complete: boolean
  processes: Readonly<{
    enumerated: number
    sameUid: number
    otherUid: number
    unavailable: PathHolderUnavailableCoverage
  }>
  sources: Readonly<Record<"cwd" | "exe" | "root" | "maps" | "fd", PathHolderSourceCoverage>>
}>

export type DarwinPathHolderCoverage = Readonly<{
  platform: "darwin"
  mechanism: "lsof"
  /** A successful lsof traversal is complete; failures throw instead of returning an empty census. */
  complete: true
}>

export type PathHolderCoverage = LinuxPathHolderCoverage | DarwinPathHolderCoverage

export type PathHolderCensus = Readonly<{
  holders: PathHolder[]
  coverage: PathHolderCoverage
}>

/** Test wiring may replace only the observation boundary; settlement remains one implementation. */
export type PathHolderCensusReader = (path: string) => Promise<PathHolderCensus>

export type PathReapResult = Readonly<{
  targetedPids: readonly number[]
  survivorPids: readonly number[]
  /** Exact read-only holder evidence from the final post-signal census. */
  survivorHolders?: readonly PathHolder[]
  /** Coverage proof for the final post-signal census; deletion consumers must require completeness. */
  survivorCoverage?: PathHolderCoverage
  forcedKill: boolean
  signalFailures: readonly string[]
}>

export async function reapOwnedPath(path: string, gracefulMs: number, killMs: number): Promise<PathReapResult> {
  return reapOwnedPathWithCensus(path, gracefulMs, killMs, inspectPathHolderCensus)
}

/** @internal Required-dependency seam used by createProcess's test-only wiring. */
export async function reapOwnedPathWithCensus(
  path: string,
  gracefulMs: number,
  killMs: number,
  inspect: PathHolderCensusReader,
): Promise<PathReapResult> {
  const root = await canonicalPath(path)
  const protectedPids = await currentProcessAncestry()
  const signalFailures: string[] = []
  const targeted = new Set<number>()
  const census = async () => inspect(root)
  const killable = async (): Promise<number[]> =>
    uniquePids((await census()).holders.map(({ pid }) => pid)).filter((pid) => pid > 1 && !protectedPids.has(pid))
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
  // Bay beneath a still-live process.
  const survivorCensus = await census()
  const survivorPids = uniquePids(survivorCensus.holders.map(({ pid }) => pid))
  return {
    targetedPids: [...targeted].sort((a, b) => a - b),
    survivorPids,
    survivorHolders: survivorCensus.holders,
    survivorCoverage: survivorCensus.coverage,
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

/**
 * Settlement failure plus the stronger coverage proof required before deleting
 * an owned path. Blindness is a deletion refusal, not a generic process-run failure.
 */
export function pathReapDeletionFailure(result: PathReapResult): string | undefined {
  const parts = [pathReapFailure(result)]
  if (result.survivorCoverage === undefined) {
    parts.push("path-holder census coverage missing; deletion cannot be certified")
  } else if (!result.survivorCoverage.complete) {
    parts.push(
      `path-holder census incomplete; deletion cannot be certified: ${JSON.stringify(result.survivorCoverage)}`,
    )
  }
  const failures = parts.filter((part): part is string => part !== undefined)
  return failures.length === 0 ? undefined : failures.join("; ")
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

/**
 * Inspect every observable process holder and report whether the observation was complete.
 *
 * Required resources are the target path plus `/proc` on Linux or `/usr/sbin/lsof`
 * on Darwin. Missing resources and unexpected I/O failures throw. A complete empty
 * result means the reported scope was searched and no holders were found; permission
 * denial is returned as reduced coverage, never collapsed into that empty result.
 */
export async function inspectPathHolderCensus(path: string): Promise<PathHolderCensus> {
  return pathProcessHolderCensus(await canonicalPath(path))
}

/**
 * Backward-compatible holder-only view; all traversal lives in the structured census.
 * Destructive callers must use inspectPathHolderCensus so reduced coverage cannot
 * masquerade as a certified empty holder set.
 */
export async function inspectPathHolders(path: string): Promise<PathHolder[]> {
  return (await inspectPathHolderCensus(path)).holders
}

/** @internal Deterministic Linux seam for a synthetic proc tree. */
export async function inspectPathHolderCensusInProc(path: string, procRoot: string): Promise<PathHolderCensus> {
  return pathProcessHolderCensus(await canonicalPath(path), { procRoot })
}

/** @internal Backward-compatible holder-only synthetic-proc seam. */
export async function inspectPathHoldersInProc(path: string, procRoot: string): Promise<PathHolder[]> {
  return (await inspectPathHolderCensusInProc(path, procRoot)).holders
}

async function pathProcessHolderCensus(
  root: string,
  options: Readonly<{ procRoot?: string }> = {},
): Promise<PathHolderCensus> {
  if (process.platform === "linux") return linuxPathProcessHolderCensus(root, options.procRoot ?? "/proc")
  if (process.platform === "darwin") return darwinPathProcessHolderCensus(root)
  throw new Error(`unsupported platform ${process.platform}; cannot certify path ownership`)
}

async function darwinPathProcessHolderCensus(root: string): Promise<PathHolderCensus> {
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
  // lsof uses 1 for a successful empty selection. Any diagnostic means the
  // traversal cannot honestly claim complete coverage, even with exit 0.
  if ((exitCode !== 0 && exitCode !== 1) || stderr.trim() !== "") {
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
  return {
    holders: uniquePathHolders(holders),
    coverage: { platform: "darwin", mechanism: "lsof", complete: true },
  }
}

type SourceAvailability = "readable" | "exited" | "denied"
type SourceObservation<T> = Readonly<{ availability: SourceAvailability; value: T }>

async function linuxPathProcessHolderCensus(root: string, procRoot: string): Promise<PathHolderCensus> {
  const entries = await readdir(procRoot, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(`Linux path-holder census requires readable proc root '${procRoot}': ${errorDetail(error)}`, {
      cause: error,
    })
  })
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("Linux process census requires the current uid")
  const numericEntries = entries.filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
  const processCoverage = {
    enumerated: numericEntries.length,
    sameUid: 0,
    otherUid: 0,
    unavailable: { exited: 0, denied: 0 },
  }
  const sourceCoverage: Record<"cwd" | "exe" | "root" | "maps" | "fd", MutableSourceCoverage> = {
    cwd: emptySourceCoverage(),
    exe: emptySourceCoverage(),
    root: emptySourceCoverage(),
    maps: emptySourceCoverage(),
    fd: emptySourceCoverage(),
  }
  const matches = await Promise.all(
    numericEntries.map(async (entry): Promise<PathHolder[]> => {
      const pid = Number(entry.name)
      const proc = `${procRoot}/${entry.name}`
      const metadata = await observeSource(() => stat(proc), undefined)
      if (metadata.availability !== "readable") {
        processCoverage.unavailable[metadata.availability] += 1
        return []
      }
      if (metadata.value?.uid !== uid) {
        processCoverage.otherUid += 1
        return []
      }
      processCoverage.sameUid += 1
      const [cwd, executable, processRoot, mappedFiles, descriptors] = await Promise.all([
        observeProcessLink(`${proc}/cwd`),
        observeProcessLink(`${proc}/exe`),
        observeProcessLink(`${proc}/root`),
        observeProcessMaps(`${proc}/maps`),
        observeProcessDescriptors(`${proc}/fd`),
      ])
      recordSourceCoverage(sourceCoverage.cwd, cwd.availability)
      recordSourceCoverage(sourceCoverage.exe, executable.availability)
      recordSourceCoverage(sourceCoverage.root, processRoot.availability)
      recordSourceCoverage(sourceCoverage.maps, mappedFiles.availability)
      recordSourceCoverage(sourceCoverage.fd, descriptors.availability)
      const holders: PathHolder[] = []
      if (cwd.value !== undefined && pathWithin(root, cwd.value)) {
        holders.push({ pid, source: "cwd", target: cwd.value })
      }
      if (executable.value !== undefined && pathWithin(root, executable.value)) {
        holders.push({ pid, source: "exe", target: executable.value })
      }
      if (processRoot.value !== undefined && pathWithin(root, processRoot.value)) {
        holders.push({ pid, source: "root", target: processRoot.value })
      }
      for (const mappedFile of mappedFiles.value) {
        if (pathWithin(root, mappedFile)) holders.push({ pid, source: "fd/maps", target: mappedFile })
      }
      for (const descriptor of descriptors.value) {
        if (pathWithin(root, descriptor.target)) {
          holders.push({ pid, source: `fd/${descriptor.name}`, target: descriptor.target })
        }
      }
      return holders
    }),
  )
  const complete =
    processCoverage.unavailable.denied === 0 &&
    Object.values(sourceCoverage).every((coverage) => coverage.unavailable.denied === 0)
  return {
    holders: uniquePathHolders(matches.flat()),
    coverage: {
      platform: "linux",
      scope: "same-uid",
      procRoot,
      complete,
      processes: processCoverage,
      sources: sourceCoverage,
    },
  }
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

type MutableSourceCoverage = {
  readable: number
  unavailable: { exited: number; denied: number }
}

function emptySourceCoverage(): MutableSourceCoverage {
  return { readable: 0, unavailable: { exited: 0, denied: 0 } }
}

function recordSourceCoverage(coverage: MutableSourceCoverage, availability: SourceAvailability): void {
  if (availability === "readable") coverage.readable += 1
  else coverage.unavailable[availability] += 1
}

async function observeSource<T>(read: () => Promise<T>, unavailableValue: T): Promise<SourceObservation<T>> {
  try {
    return { availability: "readable", value: await read() }
  } catch (error) {
    const availability = processEntryUnavailability(error)
    if (availability === undefined) throw error
    return { availability, value: unavailableValue }
  }
}

function observeProcessLink(path: string): Promise<SourceObservation<string | undefined>> {
  return observeSource(() => readlink(path), undefined)
}

async function observeProcessMaps(path: string): Promise<SourceObservation<string[]>> {
  const observed = await observeSource(() => readFile(path, "utf8"), "")
  if (observed.availability !== "readable") return { availability: observed.availability, value: [] }
  const contents = observed.value
  const mappedFiles: string[] = []
  for (const line of contents.split("\n")) {
    // Linux maps: address perms offset device inode [pathname]. Capture the
    // whole optional pathname because real mapped files may contain spaces.
    const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/u.exec(line)
    const target = match?.[1]
    if (target?.startsWith("/") === true) mappedFiles.push(target)
  }
  return { availability: "readable", value: mappedFiles }
}

async function observeProcessDescriptors(
  path: string,
): Promise<SourceObservation<Array<Readonly<{ name: string; target: string }>>>> {
  const directory = await observeSource(() => readdir(path), [] as string[])
  if (directory.availability !== "readable") return { availability: directory.availability, value: [] }
  const links = await Promise.all(
    directory.value.map(async (name) => ({ name, observed: await observeProcessLink(`${path}/${name}`) })),
  )
  const availability = links.some(({ observed }) => observed.availability === "denied")
    ? "denied"
    : links.some(({ observed }) => observed.availability === "exited")
      ? "exited"
      : "readable"
  return {
    availability,
    value: links.flatMap(({ name, observed }) =>
      observed.value === undefined ? [] : [{ name, target: observed.value }],
    ),
  }
}

function processEntryUnavailability(error: unknown): Exclude<SourceAvailability, "readable"> | undefined {
  const code = errorCode(error)
  // `/proc` is live: ENOENT/ESRCH means the observed entry exited and cannot
  // still hold the path. EACCES/EPERM means it remains but may hide a holder;
  // preserving that distinction is what keeps an incomplete empty census from
  // masquerading as a complete clean result.
  if (code === "ENOENT" || code === "ESRCH") return "exited"
  if (code === "EACCES" || code === "EPERM") return "denied"
  return undefined
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
