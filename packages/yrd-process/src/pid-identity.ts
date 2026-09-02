/**
 * Recorded-pid liveness — one answer to "is the process this record names still
 * running", for every caller that persists a pid.
 *
 * A bare `kill -0` answers a different question than the one every caller is
 * actually asking. It reports whether SOME process holds that pid number, and a
 * pid number is a recycled resource: B58's Bay was refused for days because a
 * long-dead owner's pid had been handed to an unrelated process, and `kill -0`
 * said "live" every time. Absence of ESRCH is not presence of the owner.
 *
 * Identity is what closes it, and the fact needed is one a record already has:
 * a moment the true owner necessarily PRECEDES. A process that started after the
 * record naming it was written cannot be the process that wrote it, so a start
 * time later than the record is proof of recycling, not evidence of life. Where
 * the record also remembers the owner's command line, a command that no longer
 * matches is the same proof by a second route.
 *
 * Verdicts are deliberately four, not two. "Gone" and "recycled" are distinct
 * facts about the same reclaimable outcome, and callers that reclaim want to say
 * WHICH; "unknown" never collapses into either safe answer (§ Fail Loud).
 */

import { readFileSync } from "node:fs"

/**
 * How far a process start time may exceed the record before recycling is proven.
 *
 * The comparison is already sound with no margin — a recorded owner started
 * before the record it wrote — so this margin buys nothing but insurance against
 * clock arithmetic, and costs nothing but a few minutes of a window that is
 * measured in hours. It is sized for the direction that is expensive to get
 * wrong: a false "recycled" would let a live owner's workspace be reclaimed, so
 * the burden of proof sits on the recycled verdict, never on the live one.
 */
export const PID_IDENTITY_RECYCLE_MARGIN_MS = 5 * 60 * 1_000

/**
 * Linux fixes USER_HZ at 100 for `/proc/[pid]/stat` regardless of CONFIG_HZ; it
 * is ABI, which is why procps hardcodes it too.
 */
const LINUX_USER_HZ = 100

export type RecordedPidOwner = Readonly<{
  pid: number
  /**
   * Wall-clock ms of a fact the recorded owner necessarily precedes — when the
   * record was written, when the Bay it owns was opened, when the runner it
   * names started. Omit it only when the record truly remembers no such moment;
   * without it, and without `commandContains`, identity cannot be checked.
   */
  runningSinceMs?: number
  /** Substring the owner's command line must still contain. */
  commandContains?: string
}>

/** What the platform could observe about the process currently at a pid. */
export type PidIdentity = Readonly<{
  startedAtMs?: number
  command?: string
}>

export type PidObservation =
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "denied"; detail: string }>
  | Readonly<{ kind: "identified"; identity: PidIdentity }>

/**
 * `live` — the recorded owner is running.
 * `gone` — no process holds the pid.
 * `recycled` — a process holds the pid and is provably NOT the recorded owner.
 * `unknown` — a process holds the pid and identity could not be established.
 */
export type PidLiveness = "live" | "gone" | "recycled" | "unknown"

export type PidLivenessReport = Readonly<{
  liveness: PidLiveness
  evidence: string
}>

/**
 * Whether a caller that only wants a boolean should treat the owner as running.
 *
 * `unknown` counts as running: an unprovable identity must never license the
 * destructive branch. Only proof — ESRCH, or a start time that refutes the
 * record — retires an owner.
 */
export function recordedPidIsRunning(report: PidLivenessReport): boolean {
  return report.liveness === "live" || report.liveness === "unknown"
}

/** Pure classification; every observation seam feeds this one ladder. */
export function classifyRecordedPid(owner: RecordedPidOwner, observation: PidObservation): PidLivenessReport {
  if (observation.kind === "gone") {
    return { liveness: "gone", evidence: `pid ${String(owner.pid)} is not running` }
  }
  if (observation.kind === "denied") {
    return {
      liveness: "unknown",
      evidence: `pid ${String(owner.pid)} exists but its identity could not be read: ${observation.detail}`,
    }
  }
  const { command, startedAtMs } = observation.identity
  if (owner.commandContains !== undefined && command !== undefined && !command.includes(owner.commandContains)) {
    return {
      liveness: "recycled",
      evidence:
        `pid ${String(owner.pid)} now runs ${JSON.stringify(command)}, which does not contain ` +
        `${JSON.stringify(owner.commandContains)}; the recorded owner is gone and its pid was reused`,
    }
  }
  if (owner.runningSinceMs !== undefined && startedAtMs !== undefined) {
    if (startedAtMs > owner.runningSinceMs + PID_IDENTITY_RECYCLE_MARGIN_MS) {
      return {
        liveness: "recycled",
        evidence:
          `pid ${String(owner.pid)} started ${new Date(startedAtMs).toISOString()}, after the record that names it ` +
          `(${new Date(owner.runningSinceMs).toISOString()}); the recorded owner is gone and its pid was reused`,
      }
    }
    return {
      liveness: "live",
      evidence: `pid ${String(owner.pid)} is live and started ${new Date(startedAtMs).toISOString()}, before the record that names it`,
    }
  }
  if (owner.commandContains !== undefined && command !== undefined) {
    return {
      liveness: "live",
      evidence: `pid ${String(owner.pid)} is live and still runs ${JSON.stringify(owner.commandContains)}`,
    }
  }
  if (owner.runningSinceMs === undefined && owner.commandContains === undefined) {
    return {
      liveness: "live",
      evidence: `pid ${String(owner.pid)} is live; the record carries no identity to check it against`,
    }
  }
  return {
    liveness: "unknown",
    evidence: `pid ${String(owner.pid)} is live but this platform reported neither a start time nor a command line, so its identity is unproven`,
  }
}

/**
 * Observe the process currently at a pid, without awaiting.
 *
 * Linux answers from `/proc` — three small reads on a control path, never a hot
 * loop — so every caller that is synchronous today stays synchronous and still
 * gets identity. Darwin needs a subprocess and so answers only through the async
 * entrypoint; a synchronous darwin caller is told its identity is unproven
 * rather than handed a bare-`kill -0` answer wearing an identity's name.
 *
 * `procRoot` is the deterministic Linux test seam, matching `path-reaper`'s.
 */
export function observePidSync(pid: number, options: Readonly<{ procRoot?: string }> = {}): PidObservation {
  if (process.platform === "linux") return observeLinuxPid(pid, options.procRoot ?? "/proc")
  if (options.procRoot !== undefined) return observeLinuxPid(pid, options.procRoot)
  return { kind: "denied", detail: `synchronous pid identity is unavailable on ${process.platform}` }
}

/** Observe the process currently at a pid, using every source the platform has. */
export async function observePid(pid: number, options: Readonly<{ procRoot?: string }> = {}): Promise<PidObservation> {
  if (process.platform === "darwin" && options.procRoot === undefined) return observeDarwinPid(pid)
  return observePidSync(pid, options)
}

/** The one liveness call: observe, then classify. */
export async function recordedPidLiveness(
  owner: RecordedPidOwner,
  options: Readonly<{ procRoot?: string }> = {},
): Promise<PidLivenessReport> {
  return classifyRecordedPid(owner, await observePid(owner.pid, options))
}

/** The one liveness call for a synchronous caller; same classifier, same verdicts. */
export function recordedPidLivenessSync(
  owner: RecordedPidOwner,
  options: Readonly<{ procRoot?: string }> = {},
): PidLivenessReport {
  return classifyRecordedPid(owner, observePidSync(owner.pid, options))
}

function observeLinuxPid(pid: number, procRoot: string): PidObservation {
  let stat: string
  try {
    stat = readFileSync(`${procRoot}/${String(pid)}/stat`, "utf8")
  } catch (error) {
    const code = errorCode(error)
    // ENOENT/ESRCH: the entry is gone, which is proof the process exited.
    if (code === "ENOENT" || code === "ESRCH") return { kind: "gone" }
    return { kind: "denied", detail: `${procRoot}/${String(pid)}/stat: ${errorDetail(error)}` }
  }
  const startedAtMs = procStatStartedAtMs(stat, linuxBootTimeMs(procRoot))
  let command = ""
  try {
    command = readFileSync(`${procRoot}/${String(pid)}/cmdline`, "utf8")
      .replaceAll("\0", " ")
      .trim()
  } catch {
    // silent-fallback-allow: an unreadable cmdline leaves identity to the start
    // time, and its absence is reported by the classifier, never swallowed.
    command = ""
  }
  return {
    kind: "identified",
    identity: {
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      ...(command === "" ? {} : { command }),
    },
  }
}

/**
 * Boot time in wall-clock ms, from `btime` in `/proc/stat`; undefined when the
 * proc root carries none. One value per host, so a census reads it once.
 */
export function linuxBootTimeMs(procRoot: string): number | undefined {
  let raw: string
  try {
    raw = readFileSync(`${procRoot}/stat`, "utf8")
  } catch {
    // silent-fallback-allow: without btime there is no start time, which the
    // classifier reports as an unproven identity rather than as liveness.
    return undefined
  }
  const line = raw.split("\n").find((candidate) => candidate.startsWith("btime "))
  if (line === undefined) return undefined
  const seconds = Number(line.slice("btime ".length).trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined
}

/**
 * Wall-clock ms at which the process behind this `/proc/[pid]/stat` line
 * started: field 22, in clock ticks since boot, against the boot time. The one
 * parser of that field; the path-holder census reads it through here too.
 *
 * `comm` is field 2, is parenthesized, and may itself contain spaces AND
 * parentheses — so the split point is the LAST `)`, never the first, and never a
 * whitespace split of the whole line.
 */
export function procStatStartedAtMs(stat: string, bootedAtMs: number | undefined): number | undefined {
  if (bootedAtMs === undefined) return undefined
  const close = stat.lastIndexOf(")")
  if (close < 0) return undefined
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u)
  // fields[0] is `state`, which is field 3; field 22 is therefore index 19.
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) && ticks >= 0 ? bootedAtMs + (ticks / LINUX_USER_HZ) * 1_000 : undefined
}

async function observeDarwinPid(pid: number): Promise<PidObservation> {
  const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "etime=,command="], {
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
  // ps exits 1 with no output for a pid that does not exist.
  if (exitCode === 1 && stdout.trim() === "") return { kind: "gone" }
  if (exitCode !== 0) {
    return { kind: "denied", detail: `ps exited ${String(exitCode)}: ${stderr.trim() || "no diagnostic"}` }
  }
  const row = stdout.trim()
  if (row === "") return { kind: "gone" }
  const match = /^(\S+)\s*(.*)$/su.exec(row)
  if (match === null) return { kind: "denied", detail: `unparsable ps row ${JSON.stringify(row)}` }
  const elapsedMs = parseElapsedTime(match[1] ?? "")
  const command = (match[2] ?? "").trim()
  return {
    kind: "identified",
    identity: {
      ...(elapsedMs === undefined ? {} : { startedAtMs: Date.now() - elapsedMs }),
      ...(command === "" ? {} : { command }),
    },
  }
}

/** `ps -o etime` renders `[[dd-]hh:]mm:ss`. */
export function parseElapsedTime(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(text.trim())
  if (match === null) return undefined
  const [days, hours, minutes, seconds] = [match[1] ?? "0", match[2] ?? "0", match[3] ?? "0", match[4] ?? "0"].map(
    Number,
  ) as [number, number, number, number]
  return ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1_000
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
