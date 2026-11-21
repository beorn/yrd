import { isAbsolute, parse, relative, sep } from "node:path"
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import {
  clearedByIdentity,
  inspectProcessCensus,
  inspectProcessCwds,
  isStrictlyInside,
  resolveContainedPath,
  type ProcessCwdProjection,
  type ProcessCensus,
  type UnreadableProcess,
} from "removely"
import type { YrdCliIO, CloseExecutionBudget } from "./types.ts"

/** The caller's existing clock admits each operation; this helper owns no timer. */
export function closeWorkRemaining(budget: CloseExecutionBudget): number {
  budget.signal.throwIfAborted()
  const remaining = budget.remainingMs()
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("environment close work budget exhausted or invalid; no further operation started")
  }
  return remaining
}

export function validateLiveEnvironmentUses(uses: unknown): readonly Readonly<{ path: string; reason: string }>[] {
  if (!Array.isArray(uses)) throw new Error("live environment-use reader did not return an array")
  return uses.map((use: unknown) => {
    if (
      typeof use !== "object" ||
      use === null ||
      !("path" in use) ||
      typeof use.path !== "string" ||
      !isAbsolute(use.path) ||
      !("reason" in use) ||
      typeof use.reason !== "string" ||
      use.reason.trim() === ""
    ) {
      throw new Error("live environment-use reader needs absolute paths and nonempty reasons")
    }
    return { path: use.path, reason: use.reason }
  })
}

export async function assertNoLiveEnvironmentUse(
  path: string,
  io: YrdCliIO,
  budget?: CloseExecutionBudget,
): Promise<void> {
  if (budget !== undefined) closeWorkRemaining(budget)
  if (io.liveEnvironmentUse === undefined) return
  let uses: ReturnType<typeof validateLiveEnvironmentUses>
  try {
    const answer = await (budget === undefined ? io.liveEnvironmentUse(path) : io.liveEnvironmentUse(path, budget))
    if (budget !== undefined) closeWorkRemaining(budget)
    uses = validateLiveEnvironmentUses(answer).map((use) => ({
      path: resolveContainedPath(use.path, parse(use.path).root, { allowRoot: true }),
      reason: use.reason,
    }))
  } catch (cause) {
    throw new Error(`live environment-use reader unavailable: ${String(cause)}`, { cause })
  }
  const holder = uses.find((use) => use.path === path || isStrictlyInside(use.path, path))
  if (holder !== undefined) throw new Error(`live use: ${holder.reason} (${holder.path})`)
}

/** Shared admission policy: identity-cleared denials are evidence, an unexplained gap is not. */
export function processCwdCoverage(snapshot: ProcessCwdProjection) {
  const uncleared = snapshot.unreadable.filter((entry) => clearedByIdentity(entry) === undefined)
  // A pid cleared by identity is a waiver, so it is named with the identity that cleared it (29772 row 3).
  const cleared = snapshot.unreadable.flatMap((entry) => {
    const identity = clearedByIdentity(entry)
    return identity === undefined ? [] : [`${unreadableLabel(entry)} as ${identity}`]
  })
  const refusal =
    uncleared.length > 0
      ? `same-UID process CWD census ${snapshot.mechanism} could not read ${uncleared.map(unreadableLabel).join(", ")}; a holder among them cannot be ruled out`
      : !snapshot.complete && snapshot.unreadable.length === 0
        ? `same-UID process CWD census ${snapshot.mechanism} incomplete: no readable coverage`
        : undefined
  return { uncleared, cleared, refusal }
}

/** Name denial evidence without printing the identity argv, which can contain secrets. */
function unreadableLabel(entry: UnreadableProcess): string {
  const codes = [...new Set(entry.issues.flatMap((issue) => (issue.code === undefined ? [] : [issue.code])))]
  return `pid ${entry.pid} ${entry.comm ?? "(no comm)"}${codes.length === 0 ? "" : ` (${codes.join(", ")})`}`
}

/** The same naming rule for an fd source this census could not read. */
function fdGapLabel(entry: Readonly<{ pid: number; comm?: string; issues: readonly { code?: string }[] }>): string {
  const codes = [...new Set(entry.issues.flatMap((issue) => (issue.code === undefined ? [] : [issue.code])))]
  return `pid ${entry.pid} ${entry.comm ?? "(no comm)"}${codes.length === 0 ? "" : ` (${codes.join(", ")})`}`
}

export function environmentCwdHolder(
  path: string,
  snapshot: ProcessCwdProjection,
  exempt: ReadonlySet<number> = new Set(),
) {
  let target: string
  try {
    target = realpathSync(path)
  } catch (cause) {
    throw new Error(
      `environment ${path} cannot resolve its cwd containment target; environment was preserved; inspect its path before retrying`,
      { cause },
    )
  }
  return snapshot.rows.find(({ pid, cwd }) => {
    if (exempt.has(pid)) return false
    const within = relative(target, cwd)
    return within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  })
}

/** One open descriptor from the same census that answered the cwd question. */
export type EnvironmentFdRow = Readonly<{ pid: number; name: string; target: string }>

/**
 * A process the census could not read because it EXITED mid-walk is not a gap (@dev/5's reproduction,
 * 37533): the walk enumerates first and reads after, so a short-lived `.bun-wrapped` leaves an ENOENT
 * behind. Proved by re-stat: the entry is gone, it is a zombie (which holds no files), or it answers
 * with another birth time (pid reuse). Every other failure stays a gap - an EACCES or an unanswered
 * read can still hide a holder.
 */
export function provenVanished(pid: number, startTicks: number | undefined): boolean {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
  }
  if (startTicks === undefined) return false
  const comm = stat.lastIndexOf(")")
  if (comm < 0) return false
  // /proc/<pid>/stat after the command name starts at field 3: state, then starttime at field 22.
  const fields = stat
    .slice(comm + 2)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  if (state === "Z" || state === "X" || state === "x") return true
  const born = Number(fields[19])
  return Number.isSafeInteger(born) ? born !== startTicks : false
}

/**
 * A source recorded as MISSING with ENOENT is evidence of absence, not blindness (@dev/5's reproduction,
 * 37533): the entry or the descriptors went away between the walk's enumerate and read. Measured on a
 * live `.bun-wrapped` wrapper whose descriptors EXEC closed: the process answered, its fd directory
 * listed entries that had already gone. A live process is re-read here, and a descriptor that now names
 * a path inside the environment is a holder, so this never waves one through.
 */
function missingMeansAbsent(pid: number, environment: string): boolean {
  let names: string[]
  try {
    names = readdirSync(`/proc/${pid}/fd`)
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
  }
  let target: string
  try {
    target = realpathSync(environment)
  } catch {
    return false
  }
  for (const name of names) {
    let link: string
    try {
      link = readlinkSync(`/proc/${pid}/fd/${name}`)
    } catch {
      continue
    }
    if (!isAbsolute(link)) continue
    try {
      if (isStrictlyInside(realpathSync(link), target)) return false
    } catch {
      continue
    }
  }
  return true
}

/**
 * A process holding a file open inside the environment is work in flight even when its cwd is
 * elsewhere (@cto 37455-B, 2026-11-21). Measured before this existed: a writer with cwd /tmp and a
 * read-write descriptor on a file under the tree did not stop the close, and its descriptor then
 * named a deleted inode under .trash. Read from the admission's own census, never a second scan.
 */
export function environmentFdHolder(
  path: string,
  descriptors: readonly EnvironmentFdRow[],
  exempt: ReadonlySet<number> = new Set(),
) {
  let target: string
  try {
    target = realpathSync(path)
  } catch (cause) {
    throw new Error(
      `environment ${path} cannot resolve its open-file containment target; environment was preserved; inspect its path before retrying`,
      { cause },
    )
  }
  return descriptors.find(({ pid, target: fdTarget }) => {
    if (exempt.has(pid)) return false
    // A descriptor names pipes, sockets and anon inodes too; only an absolute path can be inside a tree.
    if (!isAbsolute(fdTarget)) return false
    let physical: string
    try {
      physical = realpathSync(fdTarget)
    } catch {
      // A deleted entry says so in /proc and a vanished path cannot be a holder any more.
      return false
    }
    return isStrictlyInside(physical, target)
  })
}

/** The census facts one admission read, named so a refusal can carry them to a capable context. */
export type CloseCensusReceipt = Readonly<{
  mechanism: string
  complete: boolean
  rows: number
  unreadable: number
  uncleared: number
  /**
   * Which process asked and when (@cto 2026-11-14, 34329). Two same-UID readers
   * on this host answer the same /proc question differently, so a refusal that
   * records only counts cannot be compared with the next reader's answer. The
   * cause is unknown; the identity and time make the next comparison possible.
   */
  reader: Readonly<{ pid: number; uid: number }>
  observed_at: string
  /** What this admission's own walk cost. One close request is one walk here, so this is the whole cost. */
  elapsed_ms: number
}>

/**
 * Which process read the census and when (@cto 2026-11-14, 34329). One spelling
 * for every surface that records a refusal, so two readers' answers can be
 * compared instead of merged: the cause of their disagreement is still unknown.
 */
export function censusReaderLine(census: CloseCensusReceipt): string {
  return `census read by pid ${census.reader.pid} uid ${census.reader.uid} at ${census.observed_at}`
}

/** The process reading a census, in one spelling for every receipt (@cto 2026-11-14, 34329). */
export function censusReader(): Readonly<{ pid: number; uid: number }> {
  return {
    pid: globalThis.process.pid,
    uid: typeof globalThis.process.getuid === "function" ? globalThis.process.getuid() : -1,
  }
}

/**
 * What one admission decided.
 *
 * `admitted` may proceed. `needs-delegation` means this invocation's census
 * could NOT certify the close and no readable holder was found: the caller is
 * not permitted to quietly proceed, and refusing outright would leave the
 * environment to a human, so the intent is delegated to a context whose census
 * reads every pid (22894). A readable holder is never delegation — it is a
 * refusal, exactly as before (28120).
 */
export type CloseAdmission =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "needs-delegation"; refusal: string; census: CloseCensusReceipt }>

/** Authoritative close admission, shared by direct close and the queue's close lifecycle. */
export async function admitEnvironmentClose(
  path: string,
  io: YrdCliIO,
  censusSource?: () => Promise<ProcessCensus<"same-uid">>,
  budget?: CloseExecutionBudget,
): Promise<CloseAdmission> {
  const scanAllowance = () => {
    if (budget === undefined) return 2_000
    return Math.min(2_000, closeWorkRemaining(budget))
  }
  const deadlineMs = scanAllowance()
  const censusStartedAt = Date.now()
  const observedAt = new Date(censusStartedAt).toISOString()
  let snapshot: ProcessCwdProjection
  const exempt = new Set<number>([process.pid])
  let descriptors: readonly EnvironmentFdRow[] = []
  let fdGapRefusal: string | undefined
  let provedGone = 0
  let ancestryAvailable = false
  let unreadableAncestor: number | undefined
  if (process.platform === "linux") {
    // The existing cwd projection derives these exact facts from this same collector.
    // Keep the ppid evidence alongside them so exemptions never come from another scan.
    const census = await (censusSource === undefined
      ? inspectProcessCensus({
          scope: "same-uid",
          sources: ["cwd", "fd"],
          deadlineMs,
          ...(budget === undefined ? {} : { signal: budget.signal }),
        })
      : censusSource())
    // The open-file question is answered from this same census, so a close never pays a second walk.
    // A row's fd source that could not be read is named by the census coverage, never read as "no holder".
    // The walk enumerates before it reads, so a short-lived process leaves an unreadable row behind; one
    // proved gone is an exit, not a gap (@dev/5's reproduction, 37533).
    const gapSource = (source: { availability: string } | undefined): boolean =>
      source !== undefined && !["readable", "notApplicable", "exited"].includes(source.availability)
    // An ENOENT "missing" row is proved absent (gone, zombie, reused pid, or descriptors that closed)
    // and never a holder; a denial, an unanswered read or an ambiguous one stays a gap.
    // Only an ENOENT "missing" is evidence of absence. A denial or an unanswered read is blindness and
    // keeps the delegation split exactly as it was (@cto 56f071c7).
    const missingAbsent = (pid: number, issues: readonly Readonly<{ reason: string; code?: string }>[]): boolean =>
      issues.length > 0 &&
      issues.every((issue) => issue.reason === "missing" && issue.code === "ENOENT") &&
      missingMeansAbsent(pid, path)
    const vanishedPids = new Set(
      census.rows
        .filter((row) => gapSource(row.sources.cwd) || gapSource(row.sources.fd))
        .filter((row) => {
          const issues = [
            ...(gapSource(row.sources.cwd) ? (row.sources.cwd?.issues ?? []) : []),
            ...(gapSource(row.sources.fd) ? (row.sources.fd?.issues ?? []) : []),
          ]
          // A denial is blindness even when its pid has gone since: only an ENOENT row is absence.
          if (issues.length === 0) return false
          if (!issues.every((issue) => issue.reason === "missing" && issue.code === "ENOENT")) return false
          return provenVanished(row.pid, row.startTicks) || missingMeansAbsent(row.pid, path)
        })
        .map((row) => row.pid),
    )
    const unreadableByPid = new Map((census.coverage.unreadable ?? []).map((entry) => [entry.pid, entry]))
    const knownAbsent = (entry: { pid: number; issues: readonly Readonly<{ reason: string; code?: string }>[] }) =>
      vanishedPids.has(entry.pid) || missingAbsent(entry.pid, entry.issues)
    provedGone = vanishedPids.size
    descriptors = census.rows.flatMap((row) => {
      const fd = row.sources.fd
      if (fd?.availability !== "readable" || fd.value === undefined) return []
      return fd.value.flatMap((descriptor) => [{ pid: row.pid, name: descriptor.name, target: descriptor.target }])
    })
    // An fd source that could not be read is a GAP, never "this process holds nothing" (@cto 37455-B):
    // the same rule the cwd coverage already follows, so a denial refuses or delegates by name.
    const fdGaps = census.rows.flatMap((row) => {
      const fd = row.sources.fd
      if (fd === undefined) return []
      if (fd.availability === "readable" || fd.availability === "notApplicable" || fd.availability === "exited") {
        return []
      }
      if (vanishedPids.has(row.pid)) return []
      // The coverage entry carries the argv read for a denied identity, which is the only material
      // clearedByIdentity can recognise a systemd or ssh-agent denial by.
      const identity = unreadableByPid.get(row.pid)
      return [identity ?? { pid: row.pid, uid: row.uid ?? -1, comm: row.comm, denied: [], issues: fd.issues }]
    })
    const unclearedFd = fdGaps.filter((entry) => clearedByIdentity(entry) === undefined)
    if (unclearedFd.length > 0) {
      fdGapRefusal = `same-UID process fd census proc could not read ${unclearedFd.map(fdGapLabel).join(", ")}; a holder among them cannot be ruled out`
    }
    snapshot = {
      rows: census.rows.flatMap((row) => {
        const cwd = row.sources.cwd
        return cwd?.availability === "readable" && cwd.value !== undefined ? [{ pid: row.pid, cwd: cwd.value }] : []
      }),
      complete:
        census.coverage.complete ||
        // A census with NO unreadable rows and an incomplete flag is the caller's own limit, not absence.
        ((census.coverage.unreadable ?? []).length > 0 &&
          (census.coverage.unreadable ?? []).every((entry) => knownAbsent(entry))),
      unreadable: (census.coverage.unreadable ?? []).filter((entry) => !knownAbsent(entry)),
      mechanism: "proc",
    }
    const rows = new Map(census.rows.map((row) => [row.pid, row]))
    let parent = rows.get(process.pid)?.ppid
    ancestryAvailable = parent !== undefined
    while (parent !== undefined && parent !== 0 && !exempt.has(parent)) {
      const row = rows.get(parent)
      // An unreadable or excluded ancestor is not proof for an exemption.
      if (row?.ppid === undefined) {
        unreadableAncestor = parent
        break
      }
      exempt.add(parent)
      parent = row.ppid
    }
  } else {
    snapshot = await inspectProcessCwds({ deadlineMs, ...(budget === undefined ? {} : { signal: budget.signal }) })
  }
  scanAllowance()
  // The walk and the projection built from it are this admission's census phase. One close request is
  // one walk here — @cto declined reusing the round's snapshot across requests (40ms is not worth a
  // wider window on a seat-requested close) — so this number is the whole cost of the census.
  const censusElapsedMs = Date.now() - censusStartedAt
  const coverage = processCwdCoverage(snapshot)
  io.stderr(
    `yrd: env close ${snapshot.mechanism === "proc" ? "same-UID holders inspected; other-UID holders are not inspectable" : "lsof cwd holders inspected; UID scope and ancestry are unproven"}; exempt PIDs: ${[...exempt].join(", ")}; identity-cleared unreadable PIDs: ${coverage.cleared.length === 0 ? "none" : coverage.cleared.join(", ")}${provedGone === 0 ? "" : `; proved gone during the walk: ${provedGone} PID(s), not holders`}. This scan is non-atomic: a process can enter after the check.\n`,
  )
  const holder = environmentCwdHolder(path, snapshot, exempt)
  // A readable holder is evidence whatever the coverage says; the delegation split exists for the case
  // where no holder can be named (@cto 37455-B, 2026-11-21).
  const fdHolder = environmentFdHolder(path, descriptors, exempt)
  const censusRefusal = [coverage.refusal, fdGapRefusal].filter((part): part is string => part !== undefined).join("; ")
  if (censusRefusal !== "") {
    // A READABLE holder inside the path is a refusal, exactly as before: the
    // caller knows the pid and the cwd and can name them. Incomplete coverage
    // with NO readable holder is the case this invocation cannot decide, and it
    // is delegated rather than guessed either way.
    if (holder !== undefined) {
      throw new Error(
        `${censusRefusal}; process ${holder.pid} has CWD ${holder.cwd}; environment ${path} was preserved`,
      )
    }
    if (fdHolder !== undefined) {
      throw new Error(
        `${censusRefusal}; process ${fdHolder.pid} holds ${fdHolder.target} open; environment ${path} was preserved`,
      )
    }
    return {
      kind: "needs-delegation",
      refusal: censusRefusal,
      census: {
        mechanism: snapshot.mechanism,
        complete: snapshot.complete,
        rows: snapshot.rows.length,
        unreadable: snapshot.unreadable.length,
        uncleared: coverage.uncleared.length,
        reader: censusReader(),
        observed_at: observedAt,
        elapsed_ms: censusElapsedMs,
      },
    }
  }
  const ownCwd =
    environmentCwdHolder(path, { ...snapshot, rows: snapshot.rows.filter((row) => row.pid === process.pid) }) !==
    undefined
  if ((!ancestryAvailable && ownCwd) || (holder !== undefined && holder.pid === unreadableAncestor)) {
    throw new Error(
      `ancestry unavailable${process.platform === "linux" ? " for this invocation" : " on this platform"}; own-cwd close refused; run the close from outside the environment; environment ${path} was preserved`,
    )
  }
  if (holder !== undefined) {
    throw new Error(
      `process ${holder.pid} has CWD ${holder.cwd}; environment ${path} was preserved; wait for its owner to leave before retrying`,
    )
  }
  if (fdHolder !== undefined) {
    throw new Error(
      `process ${fdHolder.pid} holds ${fdHolder.target} open; environment ${path} was preserved; wait for its owner to leave before retrying`,
    )
  }
  return { kind: "admitted" }
}
