import { afterEach, describe, expect, it } from "vitest"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireWriterLock, resolveWriterLockPath, type WriterLock } from "../packages/core/src/store/lock.ts"
import { createSqliteStore } from "../src/store/sqlite.ts"
import type { BayEvent, BayStore } from "../src/types.ts"

const dirs: string[] = []
const locks: WriterLock[] = []
const stores: BayStore[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-store-test-"))
  dirs.push(dir)
  return dir
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await access(path)
      return
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
      await Bun.sleep(10)
    }
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const lock of locks.splice(0)) await lock.release()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("acquireWriterLock", () => {
  it("acquires the lock, writing pid + startedAt to writer.lock", async () => {
    const dir = await makeDir()
    const lock = await acquireWriterLock(dir)
    locks.push(lock)

    const raw = await readFile(resolveWriterLockPath(dir), "utf8")
    const holder = JSON.parse(raw) as { pid: number; startedAt: string }
    expect(holder.pid).toBe(process.pid)
    expect(typeof holder.startedAt).toBe("string")
  })

  it("refuses a second acquire while the holder is live, naming its pid", async () => {
    const dir = await makeDir()
    const lock = await acquireWriterLock(dir)
    locks.push(lock)

    await expect(acquireWriterLock(dir)).rejects.toThrow(
      new RegExp(`another bay writer is running \\(pid ${process.pid}\\)`),
    )
  })

  it("reclaims a lock left behind by a dead process (stale takeover)", async () => {
    const dir = await makeDir()

    const dead = Bun.spawn(["/bin/sh", "-c", "exit 0"])
    const deadPid = dead.pid
    await dead.exited // guaranteed gone — process.kill(deadPid, 0) now throws ESRCH

    await writeFile(resolveWriterLockPath(dir), JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }))

    const lock = await acquireWriterLock(dir)
    locks.push(lock)

    const raw = await readFile(resolveWriterLockPath(dir), "utf8")
    const holder = JSON.parse(raw) as { pid: number }
    expect(holder.pid).toBe(process.pid) // we now hold it
  })

  it("never steals a live holder because diagnostic metadata looks old", async () => {
    const dir = await makeDir()
    const ready = join(dir, "holder-ready")
    const lockModule = fileURLToPath(new URL("../packages/core/src/store/lock.ts", import.meta.url))
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { acquireWriterLock } from ${JSON.stringify(lockModule)};
         import { writeFile } from "node:fs/promises";
         const lock = await acquireWriterLock(${JSON.stringify(dir)});
         await writeFile(${JSON.stringify(ready)}, "ready");
         await Bun.sleep(500);
         await lock.release();`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    await waitForFile(ready)

    await writeFile(
      resolveWriterLockPath(dir),
      JSON.stringify({ pid: child.pid, startedAt: new Date(Date.now() - 60_000).toISOString() }),
    )
    const opts = { staleMs: 1 } as Parameters<typeof acquireWriterLock>[1] & { staleMs: number }
    let acquired: WriterLock | undefined
    let error: unknown
    try {
      acquired = await acquireWriterLock(dir, opts)
      locks.push(acquired)
    } catch (cause) {
      error = cause
    }
    const [childError, childExit] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(childExit, childError).toBe(0)
    expect(acquired).toBeUndefined()
    expect(error).toBeInstanceOf(Error)
  })

  it("repairs stale diagnostic metadata when no process holds the lock", async () => {
    const dir = await makeDir()
    await writeFile(resolveWriterLockPath(dir), "{not valid json")

    const lock = await acquireWriterLock(dir)
    locks.push(lock)

    const holder = JSON.parse(await readFile(resolveWriterLockPath(dir), "utf8")) as { pid: number }
    expect(holder.pid).toBe(process.pid)
  })

  it("release() drops the lock so a fresh acquire succeeds", async () => {
    const dir = await makeDir()
    const lock = await acquireWriterLock(dir)
    await lock.release()

    const second = await acquireWriterLock(dir)
    locks.push(second)
  })

  it("release keeps the stable lock inode instead of unlinking a successor's path", async () => {
    const dir = await makeDir()
    const lockPath = resolveWriterLockPath(dir)
    const first = await acquireWriterLock(dir)

    await first.release()

    await access(lockPath)
  })
})

describe("createSqliteStore", () => {
  it("round-trips events through the journal (append then replay)", async () => {
    const dir = await makeDir()
    const store = await createSqliteStore({ dir })
    stores.push(store)

    const events: BayEvent[] = [
      {
        id: "e1",
        ts: "2026-01-01T00:00:00.000Z",
        name: "bay/refreshed",
        cause: { commandId: "c1" },
        data: { bay: "L1" },
      },
      {
        id: "e2",
        ts: "2026-01-01T00:00:01.000Z",
        name: "bay/closed",
        cause: { commandId: "c2" },
        data: { bay: "L1", via: "close" },
      },
    ]
    for (const event of events) await store.journal.append(event)

    const replayed: BayEvent[] = []
    for await (const event of store.journal.replay()) replayed.push(event)
    expect(replayed).toEqual(events)
  })

  it("close() releases the writer lock so a fresh store can open the same dir", async () => {
    const dir = await makeDir()
    const store = await createSqliteStore({ dir })
    await store.close()

    const second = await createSqliteStore({ dir })
    stores.push(second)
  })

  it("holds the writer lock for its lifetime — a concurrent store refuses", async () => {
    const dir = await makeDir()
    const store = await createSqliteStore({ dir })
    stores.push(store)

    await expect(createSqliteStore({ dir })).rejects.toThrow(/another bay writer is running/)
  })
})
