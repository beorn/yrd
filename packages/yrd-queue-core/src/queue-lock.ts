/**
 * One round at a time in a queue workdir: the round lock (andon phase 2).
 *
 * The service runs rounds on a loop, and a person runs one by hand with
 * `yrd queue run` or `yrd merge`. Two rounds in one workdir at once judge the
 * same line against the same worktrees and logs, so every round-runner takes
 * this lock first and releases it when its round ends. A second runner waits.
 *
 * The lock is a directory of GENERATIONS. `gen-<n>` is a claim naming the
 * process that took the lock, and the highest generation is the one that
 * decides: its holder holds the lock until it is gone.
 *
 * A claim records its holder's pid and start: the boot it runs in and the clock
 * tick it started at (yrd-process `processStartIdentity`). Neither moves for
 * one process, and neither moves with the wall clock, so each is compared by
 * equality. The holder is gone if and only if:
 *
 * - its `gen-<n>.released` marker exists, which its holder writes on release;
 * - its pid names no process (`kill(pid, 0)` answers ESRCH);
 * - the boot differs from the claim's: the claim is from before a reboot; or
 * - the live pid's start tick differs from the claim's: the pid has been given
 *   to someone else.
 *
 * A half is compared only where the claim and `/proc` can both say it. A live
 * holder that nothing proves gone, and whose start cannot be read in full on
 * either side, is NOT gone: it is waited on, and the wait says so once. Age is
 * never a test and neither is the wall clock: a round that runs long is a round
 * that runs long, a stepped clock moves no start, and nothing here takes a lock
 * over.
 *
 * THREE RULES make the generations exclusive, and each one closes a real
 * interleaving:
 *
 * - **A claim appears whole.** It is written to a private staging file and
 *   published with `link`, which fails with EEXIST when the name exists, so a
 *   reader never meets a half-written claim and two contenders never both win
 *   one name.
 * - **The highest generation is never unlinked.** Release writes a marker
 *   beside the claim instead. Unlinking it would free its number, and a
 *   contender that listed before the release and stalled could then publish
 *   that same number while a newer holder holds the next one: two holders.
 * - **Only a holder removes claims, and only below its own; a contender that
 *   loses removes only its own.** After publishing, a contender lists again. A
 *   generation above its own means a newer claim exists, so it yields by
 *   unlinking its own, which is never the highest. The highest number therefore
 *   only ever rises.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { processStartIdentity } from "@yrd/process"
import { ROUND_BUDGET_MS } from "./service-health.ts"

/** Where the lock lives, relative to the queue workdir. */
export const ROUND_LOCK = "round-lock"

/** How often a waiter looks again: well inside the service's shortest sleep, so a waiter wins the gap between two rounds. */
export const ROUND_LOCK_POLL_MS = 200

/** The process a claim names, as it named itself when it published the claim. */
export type RoundLockHolder = Readonly<{
  pid: number
  /** The boot it runs in, as `/proc` read it; absent when it could not be read. */
  boot?: string
  /** The clock tick it started at, as `/proc` read it; absent when it could not be read. */
  tick?: number
  /** The command line that took the lock. */
  command: string
  /** When the claim was published. */
  since: string
}>

/** A round lock this process holds. */
export type RoundLock = Readonly<{
  generation: number
  holder: RoundLockHolder
  /** Marks the claim released. Only the first call writes; the claim itself stays, because its number must never be reused. */
  release: () => void
}>

/** The claim a waiter is waiting on, as it is announced. */
export type RoundLockWait = Readonly<{
  generation: number
  holder: RoundLockHolder
  /** The holder's pid is live, nothing proves it gone, and its start cannot be read in full, so it is waited on without proof that it is the process that published the claim. */
  unproven: boolean
  /** When this waiter began waiting. */
  waitingSince: Date
}>

export type TakeRoundLock = Readonly<{
  /** The command line the claim names. */
  command: string
  /** Ends the wait: the promise rejects with the signal's reason. */
  signal?: AbortSignal
  /** How often a waiter looks again. Defaults to {@link ROUND_LOCK_POLL_MS}. */
  pollMs?: number
  /** Called once for each claim waited on, when waiting on it begins. */
  onWait?: (wait: RoundLockWait) => void
  /** How long one wait may last before {@link onStall} is called. Defaults to {@link ROUND_BUDGET_MS}. */
  stallMs?: number
  /** Called once per wait, when it has lasted {@link stallMs}: an alarm, and the wait goes on. */
  onStall?: (wait: RoundLockWait & Readonly<{ waitedMs: number }>) => void
  /** Where process starts are read. A test names one that cannot answer. */
  procRoot?: string
  /** The process this claim names. A test names a dead pid, or a live pid with a start that is not its own. */
  identity?: Readonly<{ pid: number; boot?: string; tick?: number }>
  /** Awaited after the claim is staged and before it is published: a test stalls a contender here. */
  beforeLink?: (generation: number) => void | Promise<void>
}>

/**
 * Take the round lock in `workdir`, waiting while another process holds it.
 *
 * Resolves once this process holds the highest generation, and never while
 * another holder that is not gone does. Rejects when the signal aborts, and
 * when a claim cannot be read as one, which the protocol never leaves.
 */
export async function takeRoundLock(workdir: string, options: TakeRoundLock): Promise<RoundLock> {
  const directory = join(workdir, ROUND_LOCK)
  mkdirSync(directory, { recursive: true })
  const procRoot = options.procRoot ?? "/proc"
  const identity = options.identity ?? { pid: process.pid, ...processStartIdentity(process.pid, procRoot) }
  const pollMs = options.pollMs ?? ROUND_LOCK_POLL_MS
  const stallMs = options.stallMs ?? ROUND_BUDGET_MS
  let waitingSince: Date | undefined
  const announced = new Set<number>()
  let stalled = false
  for (;;) {
    options.signal?.throwIfAborted()
    const highest = highestGeneration(directory)
    if (highest > 0) {
      const claim = readClaim(directory, highest)
      // Removed between the listing and the read, which only a newer holder's
      // cleanup or a losing contender's yield does: a higher one exists. Look again.
      if (claim === undefined) continue
      const standing = standingOf(directory, highest, claim, procRoot)
      if (standing !== "gone") {
        waitingSince ??= new Date()
        const wait = { generation: highest, holder: claim, unproven: standing === "unproven", waitingSince }
        if (!announced.has(highest)) {
          announced.add(highest)
          options.onWait?.(wait)
        }
        const waitedMs = Date.now() - waitingSince.getTime()
        if (!stalled && waitedMs >= stallMs) {
          stalled = true
          options.onStall?.({ ...wait, waitedMs })
        }
        await delay(pollMs, undefined, { signal: options.signal })
        continue
      }
    }
    const generation = highest + 1
    const holder: RoundLockHolder = {
      command: options.command,
      pid: identity.pid,
      since: new Date().toISOString(),
      ...(identity.boot === undefined ? {} : { boot: identity.boot }),
      ...(identity.tick === undefined ? {} : { tick: identity.tick }),
    }
    const staged = join(directory, `staged-${String(identity.pid)}-${randomUUID()}`)
    stage(staged, holder)
    try {
      await options.beforeLink?.(generation)
      try {
        linkSync(staged, join(directory, claimName(generation)))
      } catch (error) {
        // Lost the name to a contender that published first: look again.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
        throw error
      }
    } finally {
      rmSync(staged, { force: true })
    }
    // Won the name, but a contender that listed earlier and stalled can win a
    // number a holder has since cleaned up. A higher claim is newer: yield.
    if (highestGeneration(directory) > generation) {
      rmSync(join(directory, claimName(generation)), { force: true })
      continue
    }
    cleanBelow(directory, generation)
    let released = false
    return {
      generation,
      holder,
      release: () => {
        if (released) return
        released = true
        closeSync(openSync(join(directory, releasedName(generation)), "w"))
      },
    }
  }
}

/** How a waiter reads the holder of the highest claim. */
type Standing = "held" | "unproven" | "gone"

function standingOf(directory: string, generation: number, claim: RoundLockHolder, procRoot: string): Standing {
  if (existsSync(join(directory, releasedName(generation)))) return "gone"
  if (!running(claim.pid)) return "gone"
  const now = processStartIdentity(claim.pid, procRoot)
  // A half that both sides can read, and that differs, proves another process.
  if (claim.boot !== undefined && now.boot !== undefined && now.boot !== claim.boot) return "gone"
  if (claim.tick !== undefined && now.tick !== undefined && now.tick !== claim.tick) return "gone"
  // Only both halves, read on both sides, prove the holder; anything less is waited on.
  const proven =
    claim.boot !== undefined && claim.tick !== undefined && now.boot !== undefined && now.tick !== undefined
  return proven ? "held" : "unproven"
}

/** Whether a pid names a process that is running now. */
function running(pid: number): boolean {
  try {
    // Signal 0 asks the kernel about the process and sends nothing.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process this user may not signal; only ESRCH is absence.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function claimName(generation: number): string {
  return `gen-${String(generation)}`
}

function releasedName(generation: number): string {
  return `${claimName(generation)}.released`
}

const CLAIM = /^gen-([1-9][0-9]*)(\.released)?$/u

/** The highest claim published, or 0 when there is none. Markers do not count. */
function highestGeneration(directory: string): number {
  let highest = 0
  for (const name of readdirSync(directory)) {
    const match = CLAIM.exec(name)
    if (match === null || match[2] !== undefined) continue
    highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/** A holder removes every claim and marker below its own, and nothing else: the numbers it removes are never the highest. */
function cleanBelow(directory: string, generation: number): void {
  for (const name of readdirSync(directory)) {
    const match = CLAIM.exec(name)
    if (match !== null && Number(match[1]) < generation) rmSync(join(directory, name), { force: true })
  }
}

/**
 * Write the claim whole, and to disk, before it can be published: a claim that
 * survives a crash of the machine is one that was flushed before its name
 * existed, so no reader ever meets an empty one.
 */
function stage(path: string, holder: RoundLockHolder): void {
  const descriptor = openSync(path, "wx")
  try {
    writeSync(descriptor, `${JSON.stringify(holder)}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/** The claim at `generation`, or undefined when it is not there any more. */
function readClaim(directory: string, generation: number): RoundLockHolder | undefined {
  const path = join(directory, claimName(generation))
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const notAClaim = (cause?: unknown): Error =>
    new Error(
      `the round lock's claim ${path} is not a claim: ${JSON.stringify(text)}. Claims are flushed whole before they ` +
        "are published, so this is a defect, not a state; with every queue process in this workdir stopped, " +
        `remove ${directory} and start them again`,
      cause === undefined ? undefined : { cause },
    )
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw notAClaim(error)
  }
  const claim = value as Partial<Record<keyof RoundLockHolder, unknown>> | null
  if (
    typeof claim !== "object" ||
    claim === null ||
    typeof claim.pid !== "number" ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid <= 0 ||
    typeof claim.command !== "string" ||
    typeof claim.since !== "string" ||
    (claim.boot !== undefined && typeof claim.boot !== "string") ||
    (claim.tick !== undefined &&
      (typeof claim.tick !== "number" || !Number.isSafeInteger(claim.tick) || claim.tick < 0))
  ) {
    throw notAClaim()
  }
  return claim as RoundLockHolder
}
