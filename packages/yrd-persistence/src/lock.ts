import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { dlopen, FFIType, suffix } from "bun:ffi"
import { createFailure, observeYrdLifecycle } from "@yrd/core"
import { createLogger, type ConditionalLogger } from "loggily"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>): Promise<Result>
}>

export type ExclusiveOptions = Readonly<{
  timeoutMs?: number
  pollIntervalMs?: number
}>

type WriterLock = Readonly<{ release(): void }>
type Flock = { flock(fd: number, operation: number): number }

const LOCK_SH = 1
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const held = new Set<string>()
let libc: Flock | undefined

export function createExclusive(
  dir: string,
  options: ExclusiveOptions = {},
  inject: Readonly<{ log?: ConditionalLogger; now?: () => number }> = {},
): Exclusive {
  const log = inject.log ?? createLogger("yrd", [{ level: "warn" }])
  return {
    async run(operation) {
      const lock = await observeYrdLifecycle(
        log,
        {
          lifecycle: "lock",
          attributes: { path: join(dir, "writer.lock"), timeoutMs: options.timeoutMs ?? 30_000 },
          now: inject.now,
        },
        () => acquire(dir, options),
      )
      try {
        return await operation()
      } finally {
        lock.release()
      }
    },
  }
}

async function acquire(dir: string, options: ExclusiveOptions): Promise<WriterLock> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, "writer.lock")
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000)
  const pollMs = Math.max(1, options.pollIntervalMs ?? 10)
  const deadline = Date.now() + timeoutMs

  while (held.has(path)) {
    if (Date.now() >= deadline) throw busy(path)
    await Bun.sleep(pollMs)
  }

  const fd = openSync(path, "a+")
  let locked = false
  try {
    while (!(locked = flock(fd, LOCK_EX | LOCK_NB) === 0)) {
      if (Date.now() >= deadline) throw busy(path)
      await Bun.sleep(pollMs)
    }
    held.add(path)
    const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    ftruncateSync(fd, 0)
    writeSync(fd, body, 0, "utf8")
    fsyncSync(fd)
  } catch (error) {
    if (locked) flock(fd, LOCK_UN)
    closeSync(fd)
    throw error
  }

  let released = false
  return {
    release() {
      if (released) return
      released = true
      held.delete(path)
      flock(fd, LOCK_UN)
      closeSync(fd)
    },
  }
}

export type ExclusiveHolder = Readonly<{ pid?: number; startedAt?: string }>
export type ExclusiveProbe = Readonly<{ held: boolean; holder?: ExclusiveHolder }>

/**
 * Read-only liveness probe for an exclusive dir. The kernel flock is the
 * authority: a shared non-blocking grab succeeds only when no writer holds
 * the lock, so a crashed holder never reads as present. The lock body's
 * `{pid, startedAt}` is diagnostic identity, never the liveness verdict.
 */
export function probeExclusive(dir: string): ExclusiveProbe {
  const path = join(dir, "writer.lock")
  if (held.has(path)) return { held: true, ...probeHolder(path) }
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { held: false }
    throw cause
  }
  try {
    if (flock(fd, LOCK_SH | LOCK_NB) === 0) {
      flock(fd, LOCK_UN)
      return { held: false }
    }
    return { held: true, ...probeHolder(path) }
  } finally {
    closeSync(fd)
  }
}

function probeHolder(path: string): Readonly<{ holder?: ExclusiveHolder }> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; startedAt?: unknown }
    const holder = {
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    }
    return Object.keys(holder).length === 0 ? {} : { holder }
  } catch {
    // Diagnostic data never decides lock ownership; a held lock with an
    // unreadable body still reports held with an unknown holder.
    return {}
  }
}

function flock(fd: number, operation: number): number {
  libc ??= loadFlock()
  return libc.flock(fd, operation)
}

function loadFlock(): Flock {
  const path = process.platform === "darwin" ? "libc.dylib" : `libc.${suffix}`
  try {
    return dlopen(path, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols as unknown as Flock
  } catch (cause) {
    throw new Error(`yrd: failed to load POSIX flock from ${path}`, { cause })
  }
}

function busy(path: string): Error {
  let owner = "another process"
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }
    if (typeof value.pid === "number") owner = `yrd-cli:${value.pid}`
  } catch {
    // Diagnostic data never decides lock ownership.
  }
  return createFailure({
    kind: "infrastructure",
    code: "exclusive-busy",
    message: `yrd: writer lock is busy (${owner}; ${path})`,
  })
}
