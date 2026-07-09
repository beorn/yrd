import { createReadStream, existsSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, open } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join } from "node:path"
import type { YrdEvent, YrdEventStore } from "../app.ts"
import { createYrdEventIndex, type YrdEventIndex } from "./index.ts"
import { acquireWriterLock, type WriterLockOptions } from "./lock.ts"

const EVENTS_FILE = "events.jsonl"

export type YrdFilesystemEventStore = YrdEventStore & { index: YrdEventIndex }

export async function createYrdEventStore(options: {
  dir: string
  lock?: WriterLockOptions
}): Promise<YrdFilesystemEventStore> {
  await mkdir(options.dir, { recursive: true })
  const path = join(options.dir, EVENTS_FILE)
  const lockOptions = { timeoutMs: 30_000, pollIntervalMs: 10, ...options.lock }
  const writerScope = new AsyncLocalStorage<boolean>()
  let writer = Promise.resolve()
  let closed = false
  const index = createYrdEventIndex(options.dir)

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

  const initialLock = await acquireWriterLock(options.dir, lockOptions)
  try {
    index.rebuild(await Array.fromAsync(replay()))
  } catch (error) {
    index.close()
    throw error
  } finally {
    await initialLock.release()
  }

  return {
    index,
    replay,
    async append(events) {
      assertOpen()
      if (writerScope.getStore() !== true) throw new Error("yrd: append requires an active writer lease")
      if (events.length === 0) return
      const file = await open(path, "a")
      try {
        await file.writeFile(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8")
        await file.datasync()
      } finally {
        await file.close()
      }
      try {
        index.record(events)
      } catch {
        index.rebuild(await Array.fromAsync(replay()))
      }
    },
    async read(run) {
      assertOpen()
      if (writerScope.getStore() === true) return await run()
      await writer
      const lock = await acquireWriterLock(options.dir, lockOptions)
      try {
        return await run()
      } finally {
        await lock.release()
      }
    },
    withWriter(run) {
      assertOpen()
      if (writerScope.getStore() === true) return Promise.reject(new Error("yrd: nested writer lease is not allowed"))
      const execute = async () => {
        const lock = await acquireWriterLock(options.dir, lockOptions)
        try {
          return await writerScope.run(true, run)
        } finally {
          await lock.release()
        }
      }
      const result = writer.then(execute, execute)
      writer = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    close() {
      closed = true
      index.close()
      return Promise.resolve()
    },
  }
}
