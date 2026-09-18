/**
 * The round lock across processes (andon phase 2, `@cto` 079b8578).
 *
 * The lock is a kernel flock on the workdir's `round.lock`, taken by the one
 * call site every round-runner shares. These legs hold what the queue relies
 * on from it and one process cannot show: another process's hold is seen as a
 * hold, and a holder that dies releases the lock whatever it leaves running.
 * That two rounds in one workdir never overlap is `queue-core-up.test.ts`'s,
 * where two real rounds record any overlap.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { isFlockHeld, tryAcquireFlock } from "@bearly/flock"
import { ROUND_LOCK } from "@yrd/queue-core"

const HOLDER = join(import.meta.dirname, "support", "round-lock-holder.ts")

const roots: string[] = []
const children: number[] = []

afterAll(() => {
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // silent-fallback-allow: a child that already exited is the outcome cleanup wants.
    }
  }
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function lockFile(): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-round-lock-"))
  roots.push(root)
  return join(root, ROUND_LOCK)
}

/** Whether a pid names a running process: EPERM is a live process this user may not signal. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

describe("the round lock across processes", () => {
  it("a lock another process holds is held here, and is free once that process exits", async () => {
    const path = lockFile()
    const holder = spawn(process.execPath, [HOLDER, "hold", path], { stdio: ["pipe", "pipe", "pipe"] })
    let stderr = ""
    holder.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => holder.on("exit", (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) resolve()
      })
      holder.on("exit", (code) => reject(new Error(`the holder exited ${String(code)} before holding: ${stderr}`)))
    })

    expect(isFlockHeld(path)).toBe(true)
    expect(tryAcquireFlock(path)).toBeNull()
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ command: "round-lock-holder hold", pid: holder.pid })

    holder.stdin.end()
    expect(await exited, stderr).toBe(0)
    expect(isFlockHeld(path)).toBe(false)
    const next = tryAcquireFlock(path)
    expect(next).not.toBeNull()
    next?.release()
  })

  // `@cto` condition 2. The kernel releases a flock when its holder's last
  // descriptor closes. A child the holder started holds none of it, so a
  // holder that dies leaves the lock to the next round even while that child
  // runs on.
  it("a holder that dies while a child it started runs on leaves the lock to the next round", async () => {
    const path = lockFile()
    const childPidFile = `${path}.child-pid`
    const holder = spawn(process.execPath, [HOLDER, "spawn-and-die", path, childPidFile], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    holder.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const exit = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) =>
      holder.on("exit", (code, signal) => resolve({ code, signal })),
    )

    // It died holding the lock: it neither released it nor failed to take it.
    expect(exit, stderr).toEqual({ code: null, signal: "SIGKILL" })
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ command: "round-lock-holder spawn-and-die" })
    const child = Number(readFileSync(childPidFile, "utf8"))
    children.push(child)
    // The instrument before the conclusion: the child it started still runs.
    expect(running(child), `child ${String(child)}`).toBe(true)

    expect(isFlockHeld(path)).toBe(false)
    const next = tryAcquireFlock(path)
    expect(next, `the lock is still held while child ${String(child)} runs`).not.toBeNull()
    next?.release()
  })
})
