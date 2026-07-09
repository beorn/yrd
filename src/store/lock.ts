import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { dlopen, FFIType, suffix } from "bun:ffi"

export type WriterLock = {
  release: () => Promise<void>
}

type LockHolder = {
  pid: number
  startedAt: string
}

export type WriterLockOptions = {
  timeoutMs?: number
  pollIntervalMs?: number
}

const LOCK_FILE_NAME = "writer.lock"
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const heldPaths = new Set<string>()

interface FlockSymbol {
  flock(fd: number, operation: number): number
}

let cachedFlock: FlockSymbol | undefined

export function resolveWriterLockPath(dir: string): string {
  return join(dir, LOCK_FILE_NAME)
}

/**
 * Hold an OS-owned advisory lock for the writer lifetime. The file stays in
 * place across releases; its JSON is diagnostic only and never grants or
 * revokes ownership.
 */
export async function acquireWriterLock(dir: string, opts: WriterLockOptions = {}): Promise<WriterLock> {
  await mkdir(dir, { recursive: true })
  const lockPath = resolveWriterLockPath(dir)
  if (heldPaths.has(lockPath)) throw busyError(lockPath)

  const fd = openSync(lockPath, "a+")
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 0)
  const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? 25)
  const deadline = Date.now() + timeoutMs
  let acquired = false

  try {
    while (true) {
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
        acquired = true
        break
      }
      if (Date.now() >= deadline) break
      await Bun.sleep(pollIntervalMs)
    }

    if (!acquired) throw busyError(lockPath)
    heldPaths.add(lockPath)
    writeHolder(fd)
  } catch (error) {
    if (acquired) flock(fd, LOCK_UN)
    closeSync(fd)
    throw error
  }

  let released = false
  return {
    release(): Promise<void> {
      if (released) return Promise.resolve()
      released = true
      heldPaths.delete(lockPath)
      flock(fd, LOCK_UN)
      closeSync(fd)
      return Promise.resolve()
    },
  }
}

function writeHolder(fd: number): void {
  const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() }
  const body = JSON.stringify(holder)
  ftruncateSync(fd, 0)
  writeSync(fd, body, 0, "utf8")
  fsyncSync(fd)
}

function busyError(lockPath: string): Error {
  const pid = readHolderPid(lockPath)
  const holder = pid === undefined ? "another process" : `pid ${pid}`
  return new Error(`bay: another bay writer is running (${holder}); stop it before retrying (${lockPath})`)
}

function readHolderPid(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockHolder>
    return typeof parsed.pid === "number" ? parsed.pid : undefined
  } catch {
    return undefined
  }
}

function flock(fd: number, operation: number): number {
  return getFlock().flock(fd, operation)
}

function getFlock(): FlockSymbol {
  if (cachedFlock !== undefined) return cachedFlock
  const libcPath = process.platform === "darwin" ? "libc.dylib" : `libc.${suffix}`
  try {
    const library = dlopen(libcPath, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    cachedFlock = library.symbols as unknown as FlockSymbol
    return cachedFlock
  } catch (cause) {
    throw new Error(`bay: failed to load POSIX flock from ${libcPath}`, { cause })
  }
}
