/**
 * @failure JSONL replay or append can accept corruption, expose torn frames, or violate cursor-CAS durability.
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  CauseSchema,
  Command,
  EventSchema,
  command,
  createYrd,
  createYrdDef,
  event,
  type Cause,
  type Event,
} from "@yrd/core"
import { createJournal } from "@yrd/persistence"

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function frame(key: string, text = "hello") {
  const commandValue = Command.parse({ id: uuid(`command:${key}`), op: "test.record" })
  const cause: Cause = CauseSchema.parse({
    id: uuid(`cause:${key}`),
    commandId: commandValue.id,
    op: commandValue.op,
    commandHash: Command.hash(commandValue),
  })
  const applied: Event = EventSchema.parse({
    id: uuid(`event:${key}`),
    name: "test/recorded",
    ts: "2026-07-09T12:00:00.000Z",
    data: { text },
  })
  return { cause, command: commandValue, events: [applied] }
}

async function directory() {
  return mkdtemp(join(tmpdir(), "yrd-journal-"))
}

async function dispatchInFreshProcess(dir: string): Promise<unknown> {
  const packageDir = fileURLToPath(new URL("../", import.meta.url))
  const coreEntry = new URL("../../yrd-core/src/index.ts", import.meta.url).href
  const persistenceEntry = new URL("../src/index.ts", import.meta.url).href
  const source = `
    import * as z from "zod"
    import { command, createYrd, createYrdDef, event } from "@yrd/core"
    import { createJournal } from "@yrd/persistence"

    const coreEntry = import.meta.resolve("@yrd/core")
    const persistenceEntry = import.meta.resolve("@yrd/persistence")
    if (coreEntry !== ${JSON.stringify(coreEntry)} || persistenceEntry !== ${JSON.stringify(persistenceEntry)}) {
      throw new Error(
        "yrd: fresh process resolved a foreign workspace (core=" + coreEntry + ", persistence=" + persistenceEntry + ")",
      )
    }

    const add = command({
      title: "Add",
      visibility: "public",
      apply: (state) => ({ events: [event("counter/added", { value: state.counter + 1 })] }),
    })
    const definition = createYrdDef().extend({
      initialState: { counter: 0 },
      commands: { counter: { add } },
      events: { "counter/added": z.object({ value: z.number().int() }) },
      project: (state, applied) => applied.name === "counter/added"
        ? { counter: applied.data.value }
        : { counter: state.counter },
    })
    await using app = await createYrd(definition, { inject: { journal: createJournal({ dir: ${JSON.stringify(dir)} }) } })
    const result = await app.dispatch({ op: "counter.add" })
    console.log(JSON.stringify(result))
  `
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: packageDir,
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || `child exited ${code}`)
  return JSON.parse(stdout)
}

function ids(prefix: string) {
  let next = 0
  return () => uuid(`${prefix}:${++next}`)
}

describe("filesystem Journal", () => {
  it("generates UUIDv7 command, cause, and event ids uniquely across fresh processes", async () => {
    const dir = await directory()
    const results = await Promise.all([dispatchInFreshProcess(dir), dispatchInFreshProcess(dir)])
    const stored = (await readFile(join(dir, "events-v3.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (queue) =>
          JSON.parse(queue) as {
            v: number
            cause: { id: string }
            command: { id: string }
            events: { id: string }[]
          },
      )
    const resultIds = results.flatMap((value) => {
      const result = value as { command: { id: string }; events: { id: string }[] }
      return [result.command.id, ...result.events.map((event) => event.id)]
    })
    const ids = stored.flatMap((frame) => [frame.cause.id, frame.command.id, ...frame.events.map((event) => event.id)])

    expect(stored).toHaveLength(2)
    expect(stored.every(({ v }) => v === 3)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(resultIds).size).toBe(resultIds.length)
    expect(ids.every((id) => z.uuidv7().safeParse(id).success)).toBe(true)
    expect(resultIds.every((id) => ids.includes(id))).toBe(true)
  })

  it("round-trips frames as cursor-addressed JSONL batches", async () => {
    const dir = await directory()
    const journal = await createJournal({ dir })
    const first = { ...frame("c1", "héllo"), value: { receipt: "saved" } }
    const second = frame("c2")

    const appendedFirst = await journal.append(first, 0)
    expect(appendedFirst).toMatchObject({ appended: true })
    if (!appendedFirst.appended) throw new Error("expected append")
    const appendedSecond = await journal.append(second, appendedFirst.cursor)
    expect(appendedSecond).toMatchObject({ appended: true })
    if (!appendedSecond.appended) throw new Error("expected append")

    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor: appendedSecond.cursor, values: [first, second] }])
    expect(await Array.fromAsync(journal.read(appendedFirst.cursor))).toEqual([
      { cursor: appendedSecond.cursor, values: [second] },
    ])
    expect(Buffer.byteLength(await readFile(join(dir, "events-v3.jsonl"), "utf8"))).toBe(appendedSecond.cursor)
  })

  it("uses compare-and-append instead of exposing writer leases", async () => {
    const dir = await directory()
    const journal = await createJournal({ dir })
    const accepted = await journal.append(frame("c1"), 0)
    if (!accepted.appended) throw new Error("expected append")

    await expect(journal.append(frame("stale"), 0)).resolves.toEqual({
      appended: false,
      cursor: accepted.cursor,
    })
    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor: accepted.cursor, values: [frame("c1")] }])
  })

  it("preserves concurrent commands from independent runtimes", async () => {
    const dir = await directory()
    const journal = await createJournal({ dir })
    const add = command({
      title: "Add",
      visibility: "public",
      apply: (state: { counter: number }) => ({ events: [event("counter/added", { value: state.counter + 1 })] }),
    })
    const definition = createYrdDef().extend({
      initialState: { counter: 0 },
      commands: { counter: { add } },
      events: { "counter/added": z.object({ value: z.number().int() }) },
      project(state, applied) {
        return applied.name === "counter/added"
          ? { counter: (applied.data as { value: number }).value }
          : { counter: state.counter }
      },
    })
    const appA = await createYrd(definition, { inject: { journal, id: ids("a") } })
    const appB = await createYrd(definition, { inject: { journal, id: ids("b") } })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const app = index % 2 === 0 ? appA : appB
        return app.dispatch(app.commands.counter.add, undefined)
      }),
    )

    await Promise.all([appA.refresh(), appB.refresh()])
    expect(appA.state().counter).toBe(20)
    expect(appB.state().counter).toBe(20)
    await Promise.all([appA.close(), appB.close()])
  })

  it("does not expose an append until its data sync completes", async () => {
    const dir = await directory()
    await createJournal({ dir })
    const syncEntered = Promise.withResolvers<void>()
    const syncRelease = Promise.withResolvers<void>()
    const journal = await createJournal({
      dir,
      inject: {
        io: {
          async datasync(file) {
            syncEntered.resolve()
            await syncRelease.promise
            await file.datasync()
          },
        },
      },
    })

    const append = journal.append(frame("durable"), 0)
    await syncEntered.promise
    let readFinished = false
    const read = Array.fromAsync(journal.read()).finally(() => {
      readFinished = true
    })
    await Bun.sleep(25)
    expect(readFinished).toBe(false)

    syncRelease.resolve()
    const accepted = await append
    if (!accepted.appended) throw new Error("expected append")
    await expect(read).resolves.toEqual([{ cursor: accepted.cursor, values: [frame("durable")] }])
  })

  it("does not hold the journal lock while a reader consumes its snapshot", async () => {
    const dir = await directory()
    const journal = await createJournal({ dir })
    const first = await journal.append(frame("first"), 0)
    if (!first.appended) throw new Error("expected append")

    const reader = journal.read()[Symbol.asyncIterator]()
    await expect(reader.next()).resolves.toMatchObject({ done: false })

    let appended = false
    const next = journal.append(frame("next"), first.cursor).finally(() => {
      appended = true
    })
    await Bun.sleep(25)
    await reader.return?.()

    expect(appended).toBe(true)
    await expect(next).resolves.toMatchObject({ appended: true })
  })

  it("retries short file writes until the whole frame is durable", async () => {
    const dir = await directory()
    let writes = 0
    const journal = await createJournal({
      dir,
      inject: {
        io: {
          write(file, bytes, offset, length, position) {
            writes += 1
            return file.write(bytes, offset, Math.min(length, 7), position)
          },
        },
      },
    })

    const accepted = await journal.append(frame("short-write"), 0)
    if (!accepted.appended) throw new Error("expected append")
    expect(writes).toBeGreaterThan(1)
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: accepted.cursor, values: [frame("short-write")] },
    ])
  })

  it("rejects invalid write progress and rolls back to the committed cursor", async () => {
    const dir = await directory()
    const broken = await createJournal({
      dir,
      inject: {
        io: {
          async write() {
            return { bytesWritten: 0 }
          },
        },
      },
    })

    await expect(broken.append(frame("stalled"), 0)).rejects.toThrow("invalid progress")

    const journal = await createJournal({ dir })
    expect(await Array.fromAsync(journal.read())).toEqual([])
    const accepted = await journal.append(frame("recovered"), 0)
    if (!accepted.appended) throw new Error("expected append")
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: accepted.cursor, values: [frame("recovered")] },
    ])
  })

  it("truncates a partial write after append failure", async () => {
    const dir = await directory()
    let writes = 0
    const broken = await createJournal({
      dir,
      inject: {
        io: {
          async write(file, bytes, offset, length, position) {
            writes += 1
            if (writes > 1) throw new Error("injected write failure")
            return file.write(bytes, offset, Math.min(length, 7), position)
          },
        },
      },
    })

    await expect(broken.append(frame("partial"), 0)).rejects.toThrow("injected write failure")

    const journal = await createJournal({ dir })
    expect(await Array.fromAsync(journal.read())).toEqual([])
    const accepted = await journal.append(frame("clean"), 0)
    if (!accepted.appended) throw new Error("expected append")
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: accepted.cursor, values: [frame("clean")] },
    ])
  })

  it("ignores an uncommitted tail and repairs it on the next append", async () => {
    const dir = await directory()
    const journal = await createJournal({ dir })
    const accepted = await journal.append(frame("c1"), 0)
    if (!accepted.appended) throw new Error("expected append")
    const path = join(dir, "events-v3.jsonl")
    await appendFile(path, "x".repeat(130 * 1024))

    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor: accepted.cursor, values: [frame("c1")] }])

    const repaired = await journal.append(frame("c2"), accepted.cursor)
    expect(repaired).toMatchObject({ appended: true })
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(2)
  })

  it("repairs a file with no committed newline from cursor zero", async () => {
    const dir = await directory()
    const path = join(dir, "events-v3.jsonl")
    await writeFile(path, "x".repeat(130 * 1024))
    const journal = await createJournal({ dir })

    const accepted = await journal.append(frame("first"), 0)
    if (!accepted.appended) throw new Error("expected append")

    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: accepted.cursor, values: [frame("first")] },
    ])
  })

  it("fails on newline-committed corruption and checksum drift", async () => {
    const corruptDir = await directory()
    await writeFile(join(corruptDir, "events-v3.jsonl"), "{bad}\n")
    const corrupt = await createJournal({ dir: corruptDir })
    await expect(Array.fromAsync(corrupt.read())).rejects.toThrow("journal corrupt")

    const driftDir = await directory()
    const valid = await createJournal({ dir: driftDir })
    await valid.append(frame("c1"), 0)
    const path = join(driftDir, "events-v3.jsonl")
    const text = await readFile(path, "utf8")
    await writeFile(path, text.replace("hello", "jello"))
    await expect(Array.fromAsync(valid.read())).rejects.toThrow("checksum")
  })
})
