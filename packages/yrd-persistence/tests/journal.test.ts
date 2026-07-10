import { createHash } from "node:crypto"
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { Frame, command, createYrd, createYrdDef, event, type Cause, type Event } from "@yrd/core"
import { createJournal } from "@yrd/persistence"

const cause = (commandId: string): Cause => ({
  commandId,
  op: "test.record",
  operationHash: createHash("sha256").update(commandId).digest("hex"),
})

function frame(commandId: string, text = "hello") {
  const applied: Event = {
    id: `event-${commandId}`,
    name: "test/recorded",
    ts: "2026-07-09T12:00:00.000Z",
    data: { text },
  }
  return Frame.parse({ cause: cause(commandId), events: [applied] })
}

async function directory() {
  return mkdtemp(join(tmpdir(), "yrd-journal-"))
}

describe("filesystem Journal", () => {
  it("round-trips frames as cursor-addressed JSONL batches", async () => {
    const dir = await directory()
    const journal = await createJournal({ dir })
    const first = frame("c1", "héllo")
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
    expect(Buffer.byteLength(await readFile(join(dir, "events.jsonl"), "utf8"))).toBe(appendedSecond.cursor)
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
    const id = (prefix: string) => {
      let next = 0
      return () => `${prefix}-${++next}`
    }
    const appA = await createYrd(definition, { inject: { journal, id: id("a") } })
    const appB = await createYrd(definition, { inject: { journal, id: id("b") } })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const app = index % 2 === 0 ? appA : appB
        return app.command(app.commands.counter.add, undefined)
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
    let enteredSync = () => {}
    let releaseSync = () => {}
    const syncEntered = new Promise<void>((resolve) => (enteredSync = resolve))
    const syncRelease = new Promise<void>((resolve) => (releaseSync = resolve))
    const journal = await createJournal({
      dir,
      inject: {
        io: {
          async datasync(file) {
            enteredSync()
            await syncRelease
            await file.datasync()
          },
        },
      },
    })

    const append = journal.append(frame("durable"), 0)
    await syncEntered
    let readFinished = false
    const read = Array.fromAsync(journal.read()).finally(() => {
      readFinished = true
    })
    await Bun.sleep(25)
    expect(readFinished).toBe(false)

    releaseSync()
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
    const path = join(dir, "events.jsonl")
    await appendFile(path, "x".repeat(130 * 1024))

    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor: accepted.cursor, values: [frame("c1")] }])

    const repaired = await journal.append(frame("c2"), accepted.cursor)
    expect(repaired).toMatchObject({ appended: true })
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(2)
  })

  it("repairs a file with no committed newline from cursor zero", async () => {
    const dir = await directory()
    const path = join(dir, "events.jsonl")
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
    await writeFile(join(corruptDir, "events.jsonl"), "{bad}\n")
    const corrupt = await createJournal({ dir: corruptDir })
    await expect(Array.fromAsync(corrupt.read())).rejects.toThrow("journal corrupt")

    const driftDir = await directory()
    const valid = await createJournal({ dir: driftDir })
    await valid.append(frame("c1"), 0)
    const path = join(driftDir, "events.jsonl")
    const text = await readFile(path, "utf8")
    await writeFile(path, text.replace("hello", "jello"))
    await expect(Array.fromAsync(valid.read())).rejects.toThrow("checksum")
  })
})
