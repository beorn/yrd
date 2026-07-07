import { mkdir, open, readFile, rm } from "node:fs/promises"
import { unlinkSync } from "node:fs"
import { join } from "node:path"

/**
 * Single-writer lock — `<dir>/writer.lock` as a pid-file (spec § Design
 * laws #1: the CLI mutates state directly under a flock single-writer;
 * this is the pid-file shaped version of that claim, no bun:ffi flock(2)
 * needed for M1). Exclusive create (`wx` / O_EXCL) is the atomicity
 * primitive: two processes racing to create the same path, exactly one
 * wins, the OS is the arbiter.
 *
 * Fail-loud: a live holder refuses with the holder's pid and the exact
 * remedy (law 7). A dead holder (ESRCH on `process.kill(pid, 0)`) is
 * reclaimed automatically — but only ONCE per call, so a lock file that
 * keeps reappearing as "stale" (corruption, or a racing reclaimer) is a
 * loud error, not an infinite loop.
 */

export type WriterLock = {
  release: () => Promise<void>
}

type LockHolder = {
  pid: number
  startedAt: string
}

const LOCK_FILE_NAME = "writer.lock"

export function resolveWriterLockPath(dir: string): string {
  return join(dir, LOCK_FILE_NAME)
}

export async function acquireWriterLock(dir: string, opts: { staleMs?: number } = {}): Promise<WriterLock> {
  await mkdir(dir, { recursive: true })
  const lockPath = resolveWriterLockPath(dir)

  let staleTakeoverUsed = false
  for (;;) {
    if (await tryCreate(lockPath)) break

    const holder = await readHolderOrNull(lockPath)
    if (holder === null) continue // raced free between our EEXIST and this read — try again

    if (isHolderStale(holder, opts.staleMs)) {
      if (staleTakeoverUsed) {
        throw new Error(
          `bay: writer lock at ${lockPath} keeps reappearing as stale right after takeover — ` +
            `refusing to loop; inspect ${lockPath} manually`,
        )
      }
      staleTakeoverUsed = true
      await rm(lockPath, { force: true })
      continue
    }

    throw new Error(
      `bay: another bay writer is running (pid ${holder.pid}); ` +
        `stop it or remove ${lockPath} if you know it is dead`,
    )
  }

  let released = false
  // Best-effort: a killed-9 holder can't run its release(); the exit hook
  // is the only chance to drop the file so the next process doesn't have
  // to go through the stale-takeover path.
  const onExit = (): void => {
    // silent-fallback-allow: process 'exit' handlers must be synchronous and
    // cannot surface a rejected promise — losing this race just means the
    // next acquirer takes the (correct) stale-takeover path instead.
    try {
      unlinkSync(lockPath)
    } catch {}
  }
  process.on("exit", onExit)

  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      process.off("exit", onExit)
      await rm(lockPath, { force: true })
    },
  }
}

async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx")
    try {
      const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() }
      await handle.writeFile(JSON.stringify(holder))
    } finally {
      await handle.close()
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
    throw err
  }
}

async function readHolderOrNull(lockPath: string): Promise<LockHolder | null> {
  let raw: string
  try {
    raw = await readFile(lockPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`bay: writer lock at ${lockPath} is corrupt (invalid JSON) — remove it manually`, { cause })
  }
  const holder = parsed as Partial<LockHolder>
  if (typeof holder.pid !== "number" || typeof holder.startedAt !== "string") {
    throw new Error(`bay: writer lock at ${lockPath} is corrupt (missing pid/startedAt) — remove it manually`)
  }
  return holder as LockHolder
}

/**
 * A holder is stale when its process is provably gone (ESRCH). `staleMs`
 * is an explicit opt-in on top of that: when set, a holder is ALSO stale
 * once its age exceeds the threshold, even if `process.kill(pid, 0)`
 * still succeeds (e.g. the pid was recycled by an unrelated process).
 * Left undefined (the default), only the ESRCH check applies — a lock
 * whose liveness we can't disprove is never silently stolen.
 */
function isHolderStale(holder: LockHolder, staleMs: number | undefined): boolean {
  if (!isHolderLive(holder.pid)) return true
  if (staleMs === undefined) return false
  return Date.now() - Date.parse(holder.startedAt) > staleMs
}

function isHolderLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false
    // EPERM (pid exists, different owner) or anything unexpected: we can't
    // prove the holder is dead, so treat it as live — the safe default.
    return true
  }
}
