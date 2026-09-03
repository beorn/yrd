/**
 * Path process ownership — the census of every process still holding a path.
 *
 * cwd, executable, process root, a mapped file or an open descriptor under the
 * path all count as holding it, so a descendant that changed session is still
 * attributed. The census reports its own COVERAGE beside its holders: a
 * permission denial is reduced coverage, never an empty result, so "nothing
 * holds this" and "we were not allowed to look" can never read the same.
 */

import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { linuxBootTimeMs, procStatStartedAtMs } from "./pid-identity.ts"

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

/**
 * A same-uid proc the census could not fully observe, identified as far as the
 * world-readable side of `/proc` allows. `/proc/N/stat` stays readable even for
 * dumpable-0 session procs (systemd --user, sd-pam, sshd-session), so identity
 * costs no privilege. `denied` names exactly which observations failed.
 */
export type UnreadableProcess = Readonly<{
  pid: number
  comm?: string
  ppid?: number
  /**
   * Process state from the world-readable `/proc/N/stat`. `Z` (zombie) has
   * already released its fd table and address space, so it can hold no path.
   */
  state?: string
  /**
   * The proc entry was gone (ENOENT/ESRCH on `/proc/N/stat`) by the time its
   * identity was read: it exited between the source read that was denied and
   * this one. An exited process holds no path.
   */
  exited?: true
  /**
   * Wall-clock start, ISO, from field 22 of the same stat read against the
   * host's boot time; absent when either could not be read.
   */
  startedAt?: string
  denied: readonly ("process" | "cwd" | "exe" | "root" | "maps" | "fd")[]
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
  /** Every same-uid proc behind the denied counts, identified — the counts say
   * HOW MANY observations were hidden, this says WHO hid them. Optional for
   * censuses recorded before the field existed. */
  unreadable?: readonly UnreadableProcess[]
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

/** Render read-only holder evidence into an actionable destructive-operation refusal. */
export function pathHolderRefusal(holders: readonly PathHolder[]): string | undefined {
  const evidence = uniquePathHolders(holders)
  if (evidence.length === 0) return undefined
  return `path remains held by ${evidence
    .map(({ pid, source, target }) => `pid ${pid} via ${source} (${target})`)
    .join("; ")}`
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

/** @internal Deterministic Linux seam for a synthetic proc tree. */
export async function inspectPathHolderCensusInProc(path: string, procRoot: string): Promise<PathHolderCensus> {
  return pathProcessHolderCensus(await canonicalPath(path), { procRoot })
}

async function pathProcessHolderCensus(
  root: string,
  options: Readonly<{ procRoot?: string }> = {},
): Promise<PathHolderCensus> {
  if (process.platform === "linux") return linuxPathProcessHolderCensus(root, options.procRoot ?? "/proc")
  if (process.platform === "darwin") return darwinPathProcessHolderCensus(root)
  throw new Error(`unsupported platform ${process.platform}; cannot census path ownership`)
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
  // One value per host: every unreadable proc's start time is read against it.
  const bootedAtMs = linuxBootTimeMs(procRoot)
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
  const unreadable: UnreadableProcess[] = []
  const matches = await Promise.all(
    numericEntries.map(async (entry): Promise<PathHolder[]> => {
      const pid = Number(entry.name)
      const proc = `${procRoot}/${entry.name}`
      const metadata = await observeSource(() => stat(proc), undefined)
      if (metadata.availability !== "readable") {
        processCoverage.unavailable[metadata.availability] += 1
        if (metadata.availability === "denied") {
          unreadable.push({ pid, ...(await observeProcessIdentity(proc, bootedAtMs)), denied: ["process"] })
        }
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
      const deniedSources = (
        [
          ["cwd", cwd.availability],
          ["exe", executable.availability],
          ["root", processRoot.availability],
          ["maps", mappedFiles.availability],
          ["fd", descriptors.availability],
        ] as const
      )
        .filter(([, availability]) => availability === "denied")
        .map(([name]) => name)
      if (deniedSources.length > 0) {
        unreadable.push({ pid, ...(await observeProcessIdentity(proc, bootedAtMs)), denied: deniedSources })
      }
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
      ...(unreadable.length === 0 ? {} : { unreadable: [...unreadable].sort((a, b) => a.pid - b.pid) }),
    },
  }
}

async function canonicalPath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") throw new TypeError("yrd: path-holder census requires a non-empty path")
  return realpath(resolve(path))
}

function pathWithin(root: string, candidate: string): boolean {
  const clean = candidate.endsWith(" (deleted)") ? candidate.slice(0, -" (deleted)".length) : candidate
  return clean === root || clean.startsWith(`${root}${sep}`)
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

/** Identity from the world-readable `/proc/N/stat` (readable even for dumpable-0
 * procs): `pid (comm) state ppid …`, comm parsed by the LAST `)` because comm
 * may itself contain parentheses. Best-effort: identity failure never hides
 * the denial it decorates. One failure IS an identity: ENOENT/ESRCH on the stat
 * read means the entry exited after the denied source read, which is recorded
 * as `exited` so the gap clears itself instead of being named for a waiver. */
async function observeProcessIdentity(
  proc: string,
  bootedAtMs: number | undefined,
): Promise<{ comm?: string; ppid?: number; state?: string; startedAt?: string; exited?: true }> {
  try {
    const contents = await readFile(`${proc}/stat`, "utf8")
    const open = contents.indexOf("(")
    const close = contents.lastIndexOf(")")
    if (open === -1 || close === -1 || close < open) return {}
    const comm = contents.slice(open + 1, close)
    // `pid (comm) state ppid …` — state is the first field after comm, so it
    // costs nothing beyond the read already made for identity; the start time
    // is field 22 of the same line, parsed where pid-identity parses it.
    const rest = contents
      .slice(close + 1)
      .trim()
      .split(/\s+/u)
    const state = rest[0]
    const ppid = Number(rest[1])
    const startedAtMs = procStatStartedAtMs(contents, bootedAtMs)
    return {
      comm,
      ...(state === undefined || state === "" ? {} : { state }),
      ...(Number.isSafeInteger(ppid) ? { ppid } : {}),
      ...(startedAtMs === undefined ? {} : { startedAt: new Date(startedAtMs).toISOString() }),
    }
  } catch (error) {
    if (processEntryUnavailability(error) === "exited") return { exited: true }
    return {}
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
