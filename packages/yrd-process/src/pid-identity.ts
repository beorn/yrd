/**
 * Linux `/proc/[pid]/stat` boot-time and process-start-time parsing.
 *
 * The one parser of `/proc/[pid]/stat` field 22. Two callers read it:
 * `path-reaper.ts`'s path-holder census, to attribute a held path to the
 * process that has held it since before the census began, and the queue's
 * round lock, to tell the process that holds the lock from an unrelated one
 * that has since been given its pid.
 */

import { readFileSync } from "node:fs"

/**
 * Linux fixes USER_HZ at 100 for `/proc/[pid]/stat` regardless of CONFIG_HZ; it
 * is ABI, which is why procps hardcodes it too.
 */
const LINUX_USER_HZ = 100

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
 * started: field 22, in clock ticks since boot, against the boot time. The
 * path-holder census reads it through here. It reads up to a second early,
 * because `btime` is whole seconds (0.9 s early on the host measured
 * 2026-09-16), and it moves when the wall clock is stepped.
 */
export function procStatStartedAtMs(stat: string, bootedAtMs: number | undefined): number | undefined {
  if (bootedAtMs === undefined) return undefined
  const ticks = procStatStartTicks(stat)
  return ticks === undefined ? undefined : bootedAtMs + (ticks / LINUX_USER_HZ) * 1_000
}

/**
 * Field 22 of a `/proc/[pid]/stat` line, the clock tick since boot at which the
 * process started. The one parser of that field.
 *
 * `comm` is field 2, is parenthesized, and may itself contain spaces AND
 * parentheses — so the split point is the LAST `)`, never the first, and never a
 * whitespace split of the whole line.
 */
function procStatStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(")")
  if (close < 0) return undefined
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u)
  // fields[0] is `state`, which is field 3; field 22 is therefore index 19.
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined
}

/** Which process a pid names: the boot it runs in and the clock tick it started at. */
export type ProcessStartIdentity = Readonly<{
  /** `/proc/sys/kernel/random/boot_id`; undefined when it cannot be read. */
  boot?: string
  /** Field 22 of `/proc/[pid]/stat`; undefined when it cannot be read. */
  tick?: number
}>

/**
 * WHICH PROCESS `pid` is, in two halves that two readings of one process always
 * agree on: the boot it runs in and the clock tick it started at. Each half is
 * read on its own and is undefined when it cannot be read (no proc filesystem,
 * a process that has exited, or a line that does not parse), so a boot that
 * differs is known even where the process's own line is not.
 *
 * Ticks, not the wall-clock start {@link procStatStartedAtMs} computes: that
 * start is read against `btime`, which the kernel derives from the wall clock
 * and which moves when the clock is stepped, so one process can read two
 * different wall-clock starts. Its tick count never moves. The boot id tells
 * this boot's tick from the same tick of an earlier boot, when a process that
 * recorded its identity before a reboot is compared after it.
 *
 * Undefined is UNPROVEN, never absent: a caller asking whether the process at
 * `pid` is still the one it recorded must not read an unreadable half as a
 * different process.
 */
export function processStartIdentity(pid: number, procRoot = "/proc"): ProcessStartIdentity {
  const boot = readProcFile(`${procRoot}/sys/kernel/random/boot_id`)?.trim()
  const stat = readProcFile(`${procRoot}/${String(pid)}/stat`)
  const tick = stat === undefined ? undefined : procStatStartTicks(stat)
  return {
    ...(boot === undefined || boot === "" ? {} : { boot }),
    ...(tick === undefined ? {} : { tick }),
  }
}

function readProcFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    // silent-fallback-allow: undefined is an unproven half of an identity, which the caller must treat as unproven.
    return undefined
  }
}
