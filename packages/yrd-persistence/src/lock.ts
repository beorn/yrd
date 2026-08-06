import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { dlopen, FFIType, suffix } from "bun:ffi"
import { createFailure, observeYrdLifecycle } from "@yrd/core"
import { createLogger, type ConditionalLogger } from "loggily"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>, options?: ExclusiveRunOptions): Promise<Result>
}>

export type ExclusiveRunOptions = Readonly<{ holder?: string }>

export type ExclusiveOptions = Readonly<{
  timeoutMs?: number
  pollIntervalMs?: number
}>

type WriterLock = Readonly<{ release(): void }>
type Flock = { flock(fd: number, operation: number): number }

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
    async run(operation, runOptions = {}) {
      const holder = runOptions.holder?.trim()
      if (holder !== undefined && (holder === "" || /\r|\n/u.test(holder))) {
        throw new TypeError("yrd: exclusive holder must be a non-empty single line")
      }
      const lock = await observeYrdLifecycle(
        log,
        {
          lifecycle: "lock",
          attributes: {
            path: join(dir, "writer.lock"),
            timeoutMs: options.timeoutMs ?? 30_000,
            ...(holder === undefined ? {} : { holder }),
          },
          now: inject.now,
        },
        () => acquire(dir, options, holder),
      )
      try {
        return await operation()
      } finally {
        lock.release()
      }
    },
  }
}

async function acquire(dir: string, options: ExclusiveOptions, holder?: string): Promise<WriterLock> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, "writer.lock")
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000)
  const pollMs = Math.max(1, options.pollIntervalMs ?? 10)
  const deadline = Date.now() + timeoutMs
  // Contenders back off with jitter, never in lockstep — a fixed poll interval has
  // every waiter wake at the same instant and thunder the lock. Full jitter over
  // [0, pollMs] de-synchronizes them and keeps a busy contender off the CPU.
  const backoff = (): Promise<void> => Bun.sleep(1 + Math.floor(Math.random() * pollMs))

  while (held.has(path)) {
    if (Date.now() >= deadline) throw busy(path, holder)
    await backoff()
  }

  const fd = openSync(path, "a+")
  let locked = false
  try {
    while (!(locked = flock(fd, LOCK_EX | LOCK_NB) === 0)) {
      if (Date.now() >= deadline) throw busy(path, holder)
      await backoff()
    }
    held.add(path)
    const body = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(holder === undefined ? {} : { holder }),
    })
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

function flock(fd: number, operation: number): number {
  libc ??= loadFlock()
  return libc.flock(fd, operation)
}

export function posixLibcCandidates(platform: NodeJS.Platform): readonly string[] {
  if (platform === "darwin") return ["libc.dylib"]
  if (platform === "linux") return ["libc.so.6", "libc.so"]
  return [`libc.${suffix}`]
}

function loadFlock(): Flock {
  const candidates = posixLibcCandidates(process.platform)
  let cause: unknown
  for (const path of candidates) {
    try {
      return dlopen(path, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      }).symbols as unknown as Flock
    } catch (error) {
      cause = error
    }
  }
  throw new Error(`yrd: failed to load POSIX flock from ${candidates.join(" or ")}`, { cause })
}

function busy(path: string, contender?: string): Error {
  let owner = "another process"
  let holder = "unknown operation"
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; holder?: unknown }
    if (typeof value.pid === "number") owner = `yrd-cli:${value.pid}`
    if (typeof value.holder === "string" && value.holder.trim() !== "") holder = value.holder
  } catch {
    // silent-fallback-allow: diagnostic metadata never decides authoritative lock ownership.
  }
  return createFailure({
    kind: "infrastructure",
    code: "exclusive-busy",
    message:
      `yrd: writer lock is busy (holder=${holder}; owner=${owner}; contender=yrd-cli:${process.pid}` +
      `${contender === undefined ? "" : ` operation=${contender}`}; ${path})`,
  })
}
