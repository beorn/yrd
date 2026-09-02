import { readFileSync } from "node:fs"
import { join } from "node:path"
import { acquireExclusive, type ExclusiveOptions as GitExclusiveOptions, type WriterLock } from "git-super/exclusive"
import { createFailure, markRecoverable, observeYrdLifecycle } from "@yrd/core"
import { createLogger, type ConditionalLogger } from "loggily"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>, options: ExclusiveRunOptions): Promise<Result>
}>

/**
 * `holder` is REQUIRED, and that is the point.
 *
 * git-super renders an unnamed holder as the literal "unknown operation", and
 * every one of 3,312 starvation messages measured on one host on 2026-08-28
 * said exactly that — so the lock could be observed to starve for ninety
 * minutes with no way to name what held it. The bead that tracked the incident
 * could not name the offender either. An optional field documented as
 * "please set this" produced one caller that did out of ten; a required one
 * cannot be omitted by a new call site, which is the only version of this rule
 * that survives the next author.
 *
 * `timeoutMs` bounds THIS acquisition and overrides the lock-wide default: a
 * checkpoint save is an optimization that must never make one command wait
 * for another process, while an append is the command itself and may wait.
 */
export type ExclusiveRunOptions = Readonly<{ holder: string; timeoutMs?: number }>

/**
 * `signal` interrupts a wait that is still polling. Without it a contender
 * parked on a busy lock could not be torn down: SIGTERM ran the host's close,
 * the close awaited the parked operation, and the parked operation awaited the
 * lock — for the whole 30 s bound (24019, measured 2026-09-01: a reader sat
 * over 60 s beside a live pass, ignored TERM and INT, and needed a
 * process-group KILL).
 */
export type ExclusiveOptions = GitExclusiveOptions & Readonly<{ signal?: AbortSignal }>

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 10

/** What the lock file says about its holder: git-super writes `{pid, startedAt, holder}`. */
export type WriterLockOwner = Readonly<{ pid?: number; holder?: string; startedAt?: string }>

/** Read the holder recorded in `<dir>/writer.lock`, or `{}` when the file is
 * absent or half-written (the race between a failed acquire and this read is
 * legitimate, and the caller is already reporting a failure it enriches). */
export function readWriterLockOwner(dir: string): WriterLockOwner {
  try {
    const value = JSON.parse(readFileSync(join(dir, "writer.lock"), "utf8")) as Record<string, unknown>
    return {
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      ...(typeof value.holder === "string" && value.holder.trim() !== "" ? { holder: value.holder } : {}),
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    }
  } catch {
    // silent-fallback-allow: diagnostic enrichment of a failure that is already
    // being raised; the lock file can vanish or be mid-write between the failed
    // acquire and this read. Ownership is decided by flock, never by this text.
    return {}
  }
}

/** `pid:1234 (queue-run pass)` — the two facts a starved contender needs. */
export function describeWriterLockOwner(owner: WriterLockOwner): string {
  const pid = owner.pid === undefined ? "another process" : `pid:${String(owner.pid)}`
  return `${pid} (${owner.holder ?? "unknown operation"})`
}

function isBusy(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("worktree mutation lock is busy")
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    signal?.addEventListener("abort", finish, { once: true })
  })
}

function interrupted(dir: string, holder: string, signal: AbortSignal): never {
  const owner = describeWriterLockOwner(readWriterLockOwner(dir))
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "interrupted")
  throw markRecoverable(
    createFailure({
      kind: "infrastructure",
      code: "exclusive-interrupted",
      message: `yrd: ${holder} stopped waiting for the writer lock held by ${owner}: ${reason} (${join(dir, "writer.lock")})`,
    }),
  )
}

/**
 * Wait for the lock with a bound the caller chose and a signal the caller can
 * pull.
 *
 * git-super's own loop is neither: it polls to a deadline and nothing can
 * reach into it. Each attempt here is one git-super acquire with a zero
 * deadline — its flock, its lock-file body, its busy message — so the
 * primitive stays git-super's; only the WAIT policy is Yrd's. The first busy
 * attempt logs one WARN row naming what holds the lock and how long this
 * contender will wait, because a wait nobody can see is the ninety-minute
 * stall of 23228 all over again.
 */
async function acquireBounded(
  dir: string,
  options: ExclusiveOptions,
  holder: string,
  timeoutMs: number,
  log: ConditionalLogger,
  now: () => number,
): Promise<WriterLock> {
  const pollMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_MS)
  const signal = options.signal
  const started = now()
  let announced = false
  while (true) {
    if (signal?.aborted) interrupted(dir, holder, signal)
    try {
      return await acquireExclusive(dir, { timeoutMs: 0, pollIntervalMs: pollMs }, holder)
    } catch (error) {
      if (!isBusy(error)) throw error
      const waited = now() - started
      const owner = readWriterLockOwner(dir)
      if (!announced) {
        announced = true
        log.warn?.(
          `${holder} is waiting up to ${String(timeoutMs)}ms for the writer lock held by ${describeWriterLockOwner(owner)}`,
          {
            holder,
            boundMs: timeoutMs,
            heldBy: owner,
            path: join(dir, "writer.lock"),
          },
        )
      }
      if (waited >= timeoutMs) {
        throw markRecoverable(
          createFailure(
            {
              kind: "infrastructure",
              code: "exclusive-busy",
              message:
                `${error.message.replace("git-super: worktree mutation lock is busy", "yrd: writer lock is busy")}` +
                ` after ${String(waited)}ms; held by ${describeWriterLockOwner(owner)}`,
            },
            error,
          ),
        )
      }
      await sleep(1 + Math.floor(Math.random() * pollMs), signal)
    }
  }
}

/** Yrd observability/failure policy around git-super's one POSIX lock primitive. */
export function createExclusive(
  dir: string,
  options: ExclusiveOptions = {},
  inject: Readonly<{ log?: ConditionalLogger; now?: () => number }> = {},
): Exclusive {
  const log = inject.log ?? createLogger("yrd", [{ level: "warn" }])
  const now = inject.now ?? (() => Date.now())
  return {
    async run(operation, runOptions) {
      // The type says `holder` is required. That reaches every TypeScript
      // caller and NO caller TypeScript cannot see — and one of those is how
      // this stayed anonymous: `tools/yrd-runtime.mjs` in the superproject is
      // a hand-written .mjs mirror of `drainSettlements`, it acquires this very
      // lock, and it never got the argument the TS original was given. It read
      // as "unknown operation" for as long as the field was optional, and as
      // `undefined is not an object (evaluating 'runOptions.holder')` the
      // moment it became required. Neither names what to do. So the check is
      // here as well as in the type, because a requirement only the compiler
      // enforces is not a requirement at the boundary a .mjs crosses.
      if (runOptions === undefined || typeof runOptions.holder !== "string") {
        throw new TypeError(
          `yrd: exclusive run requires { holder } naming the operation taking ${join(dir, "writer.lock")}; ` +
            'an unnamed holder renders as "unknown operation" in every starvation message, which is how a ' +
            "ninety-minute stall was observed with nothing to attribute it to",
        )
      }
      const holder = runOptions.holder.trim()
      if (holder === "" || /\r|\n/u.test(holder)) {
        throw new TypeError("yrd: exclusive holder must be a non-empty single line")
      }
      const timeoutMs = Math.max(0, runOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      // The busy conversion happens INSIDE the observed operation, so the
      // `lock` lifecycle reports the typed, recoverable `exclusive-busy` fact
      // rather than git-super's bare error. Converting after the lifecycle had
      // already logged the bare throw at ERROR, and an ERROR row now stops the
      // pass — for the one contention every multi-writer journal is built to
      // absorb.
      const lock: WriterLock = await observeYrdLifecycle(
        log,
        {
          lifecycle: "lock",
          attributes: {
            path: join(dir, "writer.lock"),
            timeoutMs,
            holder,
          },
          now: inject.now,
        },
        () => acquireBounded(dir, options, holder, timeoutMs, log, now),
      )
      try {
        return await operation()
      } finally {
        lock.release()
      }
    },
  }
}
