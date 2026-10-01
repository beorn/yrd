/**
 * Path process ownership — the census of every process still holding a path.
 *
 * cwd, executable, process root, a mapped file, an open descriptor, or an argv
 * element that is itself a path under the path all count as holding it, so a
 * descendant that changed session is still attributed, and so is a supervisor
 * started as `bun <tree>/entry.ts` that later resolves files beside its entry
 * (@hab/26947: it holds its tree by argv alone, with cwd elsewhere and nothing
 * mapped or open). The census reports its own COVERAGE beside its holders: a
 * permission denial is reduced coverage, never an empty result, so "nothing
 * holds this" and "we were not allowed to look" can never read the same.
 *
 * The census also answers by a DEADLINE, whatever its sources do: reading
 * `/proc/<pid>/cmdline` or `maps` waits on the target's mmap lock, measured once
 * at 23 minutes (24248). A source that has not answered by then is a coverage
 * fact like a denial, `unanswered`, and no caller waits for it (@hab/26947).
 */

import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { linuxBootTimeMs, procStatStartedAtMs } from "./pid-identity.ts"

/**
 * How long a census waits for its sources before it answers with what it has. Measured normal: the whole Linux
 * census took 33-45 ms over about 870 processes on hab1 (2026-10-01, @hab/26947); 24248 gave a whole `ps` 2 s.
 */
export const PATH_HOLDER_CENSUS_DEADLINE_MS = 2_000

export type PathHolderCensusOptions = Readonly<{ deadlineMs?: number }>

/**
 * One deadline shared by every read of a census. `answer` settles with the read's value, or as unanswered once the
 * deadline has passed; a read given up on keeps running in the runtime, and its late value or error is dropped. The
 * timer never holds the process open.
 */
export type CensusDeadline = Readonly<{
  answer<T>(read: Promise<T>): Promise<Readonly<{ answered: true; value: T }> | Readonly<{ answered: false }>>
  clear(): void
}>

export function censusDeadline(ms: number): CensusDeadline {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`census deadline must be a positive number of ms, got ${ms}`)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<Readonly<{ answered: false }>>((resolve) => {
    timer = setTimeout(() => resolve({ answered: false }), ms)
    timer.unref?.()
  })
  return {
    answer: <T>(read: Promise<T>) => {
      // The race below handles an answer in time; this keeps a late rejection of an abandoned read from surfacing.
      read.catch(() => {})
      return Promise.race([read.then((value) => ({ answered: true as const, value })), expired])
    },
    clear: () => clearTimeout(timer),
  }
}

export type PathHolder = Readonly<{
  pid: number
  source: "cwd" | "exe" | "root" | "argv" | `fd/${string}`
  target: string
}>

export type PathHolderUnavailableCoverage = Readonly<{
  /** ENOENT/ESRCH: the live proc entry disappeared while the census ran. */
  exited: number
  /** EACCES/EPERM: the entry remained but the caller was not allowed to inspect it. */
  denied: number
  /** The read had not answered by the census deadline. Optional for censuses recorded before the deadline existed. */
  unanswered?: number
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
  denied: readonly ("process" | "cwd" | "exe" | "root" | "argv" | "maps" | "fd")[]
  /** Observations that had not answered by the census deadline; a gap exactly like a denial. */
  unanswered?: readonly ("process" | "cwd" | "exe" | "root" | "argv" | "maps" | "fd")[]
}>

export type LinuxPathHolderCoverage = Readonly<{
  platform: "linux"
  /** Linux filters numeric proc entries to the caller's UID before inspecting holder sources. */
  scope: "same-uid"
  procRoot: string
  /** False only when permission denial, or a read that did not answer by the deadline, may have hidden a same-UID
   * holder. Exited entries are not gaps. Always justified beside itself: an incomplete census carries a nonzero
   * `processes.unavailable.denied`, `processes.sourceDenied`, `processes.unavailable.unanswered` or
   * `processes.sourceUnanswered`, so no projection of the head can read "incomplete with nothing unavailable"
   * (24638). */
  complete: boolean
  processes: Readonly<{
    enumerated: number
    sameUid: number
    otherUid: number
    /**
     * Same-UID entries in state `Z`, counted and NOT probed.
     *
     * A zombie has been reaped by the kernel: its address space, file
     * descriptors and cwd are already released, and only its exit status
     * remains in the process table. So `/proc/N/fd` is unreadable because there
     * is nothing to list, not because permission is withheld — and counting
     * that as a denial reports "cannot tell" about a process that provably
     * holds nothing.
     *
     * That false gap is invisible in the safe direction, which is why it stood:
     * it makes `complete` false, so callers refuse rather than act, and a guard
     * that refuses too often looks exactly like one that works. Observed on
     * hab1 2026-09-10 blocking a whole-estate reap: pids 286562 (claude),
     * 1794340 (bun), 659207/659240/659270 (git) and 4034727 (sh), every one
     * state Z, every one denying only `fd`.
     */
    zombie: number
    /**
     * Live same-uid procs whose entry was readable but at least one holder
     * source (cwd/exe/root/argv/maps/fd) was denied — exactly the procs `unreadable`
     * names. Declared BEFORE the per-source breakdown so it serializes into the
     * head of the census: a hab page truncated this JSON mid-`sources`, leaving
     * a head that read `complete:false` beside all-zero counters and named no
     * gap (24638). A bounded prefix must carry the nonzero reason.
     */
    sourceDenied: number
    /** Live same-uid procs with at least one holder source that had not answered by the deadline. Optional for
     * censuses recorded before the deadline existed. */
    sourceUnanswered?: number
    unavailable: PathHolderUnavailableCoverage
  }>
  sources: Readonly<Record<"cwd" | "exe" | "root" | "argv" | "maps" | "fd", PathHolderSourceCoverage>>
  /** Every same-uid proc behind the denied counts, identified — the counts say
   * HOW MANY observations were hidden, this says WHO hid them. Optional for
   * censuses recorded before the field existed. */
  unreadable?: readonly UnreadableProcess[]
}>

export type DarwinPathHolderCoverage = Readonly<{
  platform: "darwin"
  mechanism: "lsof"
  /** lsof reports cwd, executable, root and open files; it has no argv source, so a holder by argv alone is not
   * seen on Darwin. */
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
export async function inspectPathHolderCensus(
  path: string,
  options: PathHolderCensusOptions = {},
): Promise<PathHolderCensus> {
  return pathProcessHolderCensus(await canonicalPath(path), options)
}

/** @internal Deterministic Linux seam for a synthetic proc tree. */
export async function inspectPathHolderCensusInProc(
  path: string,
  procRoot: string,
  options: PathHolderCensusOptions = {},
): Promise<PathHolderCensus> {
  return pathProcessHolderCensus(await canonicalPath(path), { ...options, procRoot })
}

async function pathProcessHolderCensus(
  root: string,
  options: Readonly<{ procRoot?: string; deadlineMs?: number }> = {},
): Promise<PathHolderCensus> {
  if (process.platform === "linux") {
    const deadline = censusDeadline(options.deadlineMs ?? PATH_HOLDER_CENSUS_DEADLINE_MS)
    try {
      return await linuxPathProcessHolderCensus(root, options.procRoot ?? "/proc", deadline)
    } finally {
      deadline.clear()
    }
  }
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

type SourceAvailability = "readable" | "exited" | "denied" | "unanswered"
type SourceObservation<T> = Readonly<{ availability: SourceAvailability; value: T }>

async function linuxPathProcessHolderCensus(
  root: string,
  procRoot: string,
  deadline: CensusDeadline,
): Promise<PathHolderCensus> {
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
    zombie: 0,
    sourceDenied: 0,
    sourceUnanswered: 0,
    unavailable: { exited: 0, denied: 0, unanswered: 0 },
  }
  const sourceCoverage: Record<"cwd" | "exe" | "root" | "argv" | "maps" | "fd", MutableSourceCoverage> = {
    cwd: emptySourceCoverage(),
    exe: emptySourceCoverage(),
    root: emptySourceCoverage(),
    argv: emptySourceCoverage(),
    maps: emptySourceCoverage(),
    fd: emptySourceCoverage(),
  }
  const unreadable: UnreadableProcess[] = []
  const matches = await Promise.all(
    numericEntries.map(async (entry): Promise<PathHolder[]> => {
      const pid = Number(entry.name)
      const proc = `${procRoot}/${entry.name}`
      const metadata = await observeSource(deadline, () => stat(proc), undefined)
      if (metadata.availability !== "readable") {
        processCoverage.unavailable[metadata.availability] += 1
        if (metadata.availability === "denied") {
          unreadable.push({ pid, ...(await observeProcessIdentity(deadline, proc, bootedAtMs)), denied: ["process"] })
        }
        if (metadata.availability === "unanswered") {
          unreadable.push({
            pid,
            ...(await observeProcessIdentity(deadline, proc, bootedAtMs)),
            denied: [],
            unanswered: ["process"],
          })
        }
        return []
      }
      if (metadata.value?.uid !== uid) {
        processCoverage.otherUid += 1
        return []
      }
      processCoverage.sameUid += 1
      // Identity FIRST, because its `state` decides whether probing is
      // meaningful at all. A zombie holds nothing — see `zombie` above — so it
      // is counted and skipped rather than probed and then reported as a gap.
      // Reading it here also means the denial path below reuses this read
      // instead of making a second one.
      const identity = await observeProcessIdentity(deadline, proc, bootedAtMs)
      if (identity.state === "Z") {
        processCoverage.zombie += 1
        return []
      }
      const [cwd, executable, processRoot, argv, mappedFiles, descriptors] = await Promise.all([
        observeProcessLink(deadline, `${proc}/cwd`),
        observeProcessLink(deadline, `${proc}/exe`),
        observeProcessLink(deadline, `${proc}/root`),
        observeProcessArgv(deadline, `${proc}/cmdline`),
        observeProcessMaps(deadline, `${proc}/maps`),
        observeProcessDescriptors(deadline, `${proc}/fd`),
      ])
      recordSourceCoverage(sourceCoverage.cwd, cwd.availability)
      recordSourceCoverage(sourceCoverage.exe, executable.availability)
      recordSourceCoverage(sourceCoverage.root, processRoot.availability)
      recordSourceCoverage(sourceCoverage.argv, argv.availability)
      recordSourceCoverage(sourceCoverage.maps, mappedFiles.availability)
      recordSourceCoverage(sourceCoverage.fd, descriptors.availability)
      const availabilities = [
        ["cwd", cwd.availability],
        ["exe", executable.availability],
        ["root", processRoot.availability],
        ["argv", argv.availability],
        ["maps", mappedFiles.availability],
        ["fd", descriptors.availability],
      ] as const
      const deniedSources = availabilities.filter(([, availability]) => availability === "denied").map(([name]) => name)
      const unansweredSources = availabilities
        .filter(([, availability]) => availability === "unanswered")
        .map(([name]) => name)
      if (deniedSources.length > 0) processCoverage.sourceDenied += 1
      if (unansweredSources.length > 0) processCoverage.sourceUnanswered += 1
      if (deniedSources.length > 0 || unansweredSources.length > 0) {
        unreadable.push({
          pid,
          ...identity,
          denied: deniedSources,
          ...(unansweredSources.length === 0 ? {} : { unanswered: unansweredSources }),
        })
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
      // Per element, never the joined line: an element must itself be a path under the root, so script text or a
      // `--flag=<path>` that mentions the path pins nothing.
      for (const element of argv.value) {
        if (element.startsWith("/") && pathWithin(root, element)) holders.push({ pid, source: "argv", target: element })
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
  // One derivation from the process-level counters. Equivalent to scanning the
  // per-source table: a source records a denial (or an unanswered read) exactly when some live same-uid
  // proc had that source denied (or unanswered), which is exactly when `sourceDenied` (`sourceUnanswered`) counted it.
  const complete =
    processCoverage.unavailable.denied === 0 &&
    processCoverage.sourceDenied === 0 &&
    processCoverage.unavailable.unanswered === 0 &&
    processCoverage.sourceUnanswered === 0
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
  if (typeof path !== "string" || path.trim() === "") {
    throw new TypeError("yrd: path-holder census requires a non-empty path")
  }
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

async function observeProcessArgv(deadline: CensusDeadline, path: string): Promise<SourceObservation<string[]>> {
  const observed = await observeSource(deadline, () => readFile(path, "utf8"), "")
  if (observed.availability !== "readable") return { availability: observed.availability, value: [] }
  return { availability: "readable", value: observed.value.split("\0").filter((element) => element !== "") }
}

type MutableSourceCoverage = {
  readable: number
  unavailable: { exited: number; denied: number; unanswered: number }
}

function emptySourceCoverage(): MutableSourceCoverage {
  return { readable: 0, unavailable: { exited: 0, denied: 0, unanswered: 0 } }
}

function recordSourceCoverage(coverage: MutableSourceCoverage, availability: SourceAvailability): void {
  if (availability === "readable") coverage.readable += 1
  else coverage.unavailable[availability] += 1
}

async function observeSource<T>(
  deadline: CensusDeadline,
  read: () => Promise<T>,
  unavailableValue: T,
): Promise<SourceObservation<T>> {
  try {
    const answer = await deadline.answer(read())
    return answer.answered
      ? { availability: "readable", value: answer.value }
      : { availability: "unanswered", value: unavailableValue }
  } catch (error) {
    const availability = processEntryUnavailability(error)
    if (availability === undefined) throw error
    return { availability, value: unavailableValue }
  }
}

function observeProcessLink(deadline: CensusDeadline, path: string): Promise<SourceObservation<string | undefined>> {
  return observeSource(deadline, () => readlink(path), undefined)
}

async function observeProcessMaps(deadline: CensusDeadline, path: string): Promise<SourceObservation<string[]>> {
  const observed = await observeSource(deadline, () => readFile(path, "utf8"), "")
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
  deadline: CensusDeadline,
  path: string,
): Promise<SourceObservation<Array<Readonly<{ name: string; target: string }>>>> {
  const directory = await observeSource(deadline, () => readdir(path), [] as string[])
  if (directory.availability !== "readable") return { availability: directory.availability, value: [] }
  const links = await Promise.all(
    directory.value.map(async (name) => ({ name, observed: await observeProcessLink(deadline, `${path}/${name}`) })),
  )
  const availability: SourceAvailability = links.some(({ observed }) => observed.availability === "denied")
    ? "denied"
    : links.some(({ observed }) => observed.availability === "unanswered")
      ? "unanswered"
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
  deadline: CensusDeadline,
  proc: string,
  bootedAtMs: number | undefined,
): Promise<{ comm?: string; ppid?: number; state?: string; startedAt?: string; exited?: true }> {
  try {
    const answer = await deadline.answer(readFile(`${proc}/stat`, "utf8"))
    // Identity is decoration: an unanswered stat read leaves the pid and its gap named without it.
    if (!answer.answered) return {}
    const contents = answer.value
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
    // silent-fallback-allow: identity is optional decoration; pid, denied sources, and incomplete coverage remain in the refusal.
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
