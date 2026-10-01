/**
 * Linux process-start identity from `/proc/[pid]/stat`.
 *
 * yrd's one parser of `/proc/[pid]/stat` field 22. Callers read it: the
 * queue's round lock, whose body names its holder's boot and start tick as
 * diagnostic bytes (the lock itself is a kernel flock, so yrd compares
 * neither), and runner recovery, which compares the recorded identity before
 * replacing a fresh claim. The path-holder census and its wall-clock start
 * time live in removely (hh 26990).
 */

import { readFileSync, readlinkSync } from "node:fs"

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

/** Which process a pid names: its boot, PID namespace, and start tick. */
export type ProcessStartIdentity = Readonly<{
  /** `/proc/sys/kernel/random/boot_id`; undefined when it cannot be read. */
  boot?: string
  /** `/proc/[pid]/ns/pid` link target; undefined when it cannot be read. */
  pidNamespace?: string
  /** Field 22 of `/proc/[pid]/stat`; undefined when it cannot be read. */
  tick?: number
  /** Local read diagnostics; these never form part of a published claim. */
  unreadable?: ReadonlyArray<{ field: "boot" | "pidNamespace" | "startTick"; path: string; code: string }>
}>

/** Kernel PID existence, with permission denial counted as existence. */
export function pidPresence(pid: number): "present" | "absent" {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`pid must be a positive safe integer: ${String(pid)}`)
  try {
    process.kill(pid, 0)
    return "present"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return "absent"
    if (code === "EPERM") return "present"
    throw error
  }
}

/**
 * WHICH PROCESS `pid` is: its boot, PID namespace, and start tick. Each field is
 * read on its own and is undefined when it cannot be read (no proc filesystem,
 * a process that has exited, or a line that does not parse), so a boot that
 * differs is known even where the process's own line is not.
 *
 * Ticks, not a wall-clock start: that start is read against `btime`, which the kernel derives from the wall clock
 * and which moves when the clock is stepped, so one process can read two
 * different wall-clock starts. Its tick count never moves. The boot id tells
 * this boot's tick from the same tick of an earlier boot, when a process that
 * recorded its identity before a reboot is compared after it.
 *
 * Undefined is UNPROVEN, never absent: a caller asking whether the process at
 * `pid` is still the one it recorded must not read an unreadable field as a
 * different process.
 */
export function processStartIdentity(pid: number, procRoot = "/proc"): ProcessStartIdentity {
  const unreadable: NonNullable<ProcessStartIdentity["unreadable"]>[number][] = []
  const bootPath = `${procRoot}/sys/kernel/random/boot_id`
  const namespacePath = `${procRoot}/${String(pid)}/ns/pid`
  const statPath = `${procRoot}/${String(pid)}/stat`
  const boot = readProcFile(bootPath, (code) => unreadable.push({ field: "boot", path: bootPath, code }))?.trim()
  const pidNamespace = readProcLink(namespacePath, (code) =>
    unreadable.push({ field: "pidNamespace", path: namespacePath, code }),
  )
  const stat = readProcFile(statPath, (code) => unreadable.push({ field: "startTick", path: statPath, code }))
  const tick = stat === undefined ? undefined : procStatStartTicks(stat)
  return {
    ...(boot === undefined || boot === "" ? {} : { boot }),
    ...(pidNamespace === undefined ? {} : { pidNamespace }),
    ...(tick === undefined ? {} : { tick }),
    ...(unreadable.length === 0 ? {} : { unreadable }),
  }
}

function readProcLink(path: string, onUnreadable: (code: string) => void): string | undefined {
  try {
    return readlinkSync(path)
  } catch (error) {
    onUnreadable((error as NodeJS.ErrnoException).code ?? "UNKNOWN")
    // silent-fallback-allow: caller retains the path and errno and reports unproven identity in the candidate wait notice.
    return undefined
  }
}

function readProcFile(path: string, onUnreadable?: (code: string) => void): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    onUnreadable?.((error as NodeJS.ErrnoException).code ?? "UNKNOWN")
    // silent-fallback-allow: undefined is an unproven half of an identity, which the caller must treat as unproven.
    return undefined
  }
}
