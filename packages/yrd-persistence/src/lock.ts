import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { dlopen, FFIType, suffix } from "bun:ffi"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>): Promise<Result>
}>

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

export function createExclusive(dir: string, options: ExclusiveOptions = {}): Exclusive {
  return {
    async run(operation) {
      const lock = await acquire(dir, options)
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
    if (typeof value.pid === "number") owner = `pid ${value.pid}`
  } catch {
    // Diagnostic data never decides lock ownership.
  }
  return new Error(`yrd: writer lock is busy (${owner}; ${path})`)
}
