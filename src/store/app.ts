import { createReadStream, existsSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join } from "node:path"
import type { YrdEvent, YrdEventStore } from "../app.ts"
import { acquireWriterLock, type WriterLockOptions } from "./lock.ts"

const EVENTS_FILE = "events.jsonl"

export async function createYrdEventStore(options: { dir: string; lock?: WriterLockOptions }): Promise<YrdEventStore> {
  await mkdir(options.dir, { recursive: true })
  const path = join(options.dir, EVENTS_FILE)
  const lockOptions = { timeoutMs: 30_000, pollIntervalMs: 10, ...options.lock }
  let activeWriter = false
  let closed = false

  function assertOpen(): void {
    if (closed) throw new Error("yrd: event store is closed")
  }

  async function* replay(): AsyncIterable<YrdEvent> {
    assertOpen()
    if (!existsSync(path)) return
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })
    let lineNo = 0
    for await (const line of lines) {
      lineNo++
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (cause) {
        throw new Error(`yrd: event journal corrupt at ${path}:${lineNo} - invalid JSON`, { cause })
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Partial<YrdEvent>).id !== "string" ||
        typeof (parsed as Partial<YrdEvent>).name !== "string" ||
        typeof (parsed as Partial<YrdEvent>).ts !== "string" ||
        typeof (parsed as Partial<YrdEvent>).cause?.commandId !== "string" ||
        typeof (parsed as Partial<YrdEvent>).cause?.op !== "string" ||
        !("data" in parsed)
      ) {
        throw new Error(`yrd: event journal corrupt at ${path}:${lineNo} - invalid event envelope`)
      }
      yield parsed as YrdEvent
    }
  }

  return {
    replay,
    async append(events) {
      assertOpen()
      if (!activeWriter) throw new Error("yrd: append requires an active writer lease")
      if (events.length === 0) return
      await appendFile(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8")
    },
    async read(run) {
      assertOpen()
      if (activeWriter) return await run()
      const lock = await acquireWriterLock(options.dir, lockOptions)
      try {
        return await run()
      } finally {
        await lock.release()
      }
    },
    async withWriter(run) {
      assertOpen()
      if (activeWriter) throw new Error("yrd: nested writer lease is not allowed")
      const lock = await acquireWriterLock(options.dir, lockOptions)
      activeWriter = true
      try {
        return await run()
      } finally {
        activeWriter = false
        await lock.release()
      }
    },
    close() {
      closed = true
      return Promise.resolve()
    },
  }
}
