/**
 * @failure Durable replay, migration, compaction, recovery, or cursor CAS can lose or expose journal frames.
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import {
  CauseSchema,
  Command,
  EventSchema,
  command,
  createYrd,
  createYrdDef,
  event,
  type Cause,
  type Cursor,
  type Event,
  type Journal,
} from "@yrd/core"
import { createJournal, createReadOnlyJournal, type Exclusive, type ExclusiveOptions } from "@yrd/persistence"
import canonicalize from "canonicalize"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"

const MANIFEST = "events-v4.manifest.json"
const RECOVERY = "events-v4.recovery.json"
const V3 = "events-v3.jsonl"
const V3_CUTOVER = `{"v":4,"cutover":"events-v4.manifest.json"}\n`

type Manifest = Readonly<{
  formatVersion: 4
  generation: number
  logicalEnd: number
  frames: number
  digest: string
  segments: readonly Readonly<{
    path: string
    rawSha256: string
    compressedSha256: string
    logicalStart: number
    logicalEnd: number
    rawBytes: number
    frames: number
  }>[]
  tail: Readonly<{ path: string; identity: string; logicalStart: number }>
  tailState: Readonly<{ path: string }>
}>

type TailState = Readonly<{
  committedBytes: number
  logicalEnd: number
  frames: number
  digest: string
}>

type TestInject = Readonly<{
  thresholds?: Readonly<{ bytes?: number; frames?: number }>
  platform?: string
  phase?: (phase: string, details: Readonly<Record<string, unknown>>) => void | Promise<void>
  log?: ConditionalLogger
  exclusive?: Exclusive
  io?: Partial<
    Readonly<{
      write(
        file: FileHandle,
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): Promise<Readonly<{ bytesWritten: number }>>
      read(
        file: FileHandle,
        bytes: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): Promise<Readonly<{ bytesRead: number }>>
      datasync(file: FileHandle): Promise<void>
    }>
  >
}>

type ExpectedJournalOptions = Readonly<{
  dir: string
  lock?: ExclusiveOptions
  inject?: Readonly<{
    exclusive?: Exclusive
    io?: TestInject["io"]
    log?: ConditionalLogger
  }>
}>

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

function digest(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("expected canonical JSON")
  return createHash("sha256").update(encoded).digest("hex")
}

function v3Line(value: ReturnType<typeof frame>): string {
  const data = { v: 3, ...value }
  return `${JSON.stringify({ ...data, checksum: digest(data) })}\n`
}

async function directory() {
  return mkdtemp(join(tmpdir(), "yrd-journal-"))
}

function testJournal(dir: string, inject: TestInject = {}): Journal<unknown> {
  return createJournal({ dir, inject } as unknown as Parameters<typeof createJournal>[0])
}

async function manifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Manifest
}

async function tailState(dir: string, value?: Manifest): Promise<TailState> {
  const active = value ?? (await manifest(dir))
  return JSON.parse(await readFile(join(dir, active.tailState.path), "utf8")) as TailState
}

async function accepted(journal: Journal<unknown>, value: ReturnType<typeof frame>, cursor: number) {
  const result = await journal.append(value, cursor)
  if (!result.appended) throw new Error(`expected append at ${cursor}, observed ${result.cursor}`)
  return result.cursor
}

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true
    throw error
  }
}

async function authoritativeBytes(dir: string): Promise<Record<string, string>> {
  const value = await manifest(dir)
  const paths = [MANIFEST, ...value.segments.map((segment) => segment.path), value.tail.path, value.tailState.path]
  return Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, (await readFile(join(dir, path))).toString("base64")])),
  )
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
  it("keeps Core cursors opaque, createJournal synchronous, and the public option surface frozen", async () => {
    expectTypeOf<Cursor>().toEqualTypeOf<number>()
    expectTypeOf<Parameters<typeof createJournal>[0]>().toEqualTypeOf<ExpectedJournalOptions>()
    expectTypeOf(createJournal).returns.toEqualTypeOf<Journal<unknown>>()

    const dir = await directory()
    const journal = createJournal({ dir })
    expect(journal).not.toBeInstanceOf(Promise)
    expect(Object.keys(journal).sort()).toEqual(["append", "read"])
    expect(await missing(join(dir, MANIFEST))).toBe(true)
  })

  it("emits structured append and writer-lock lifecycle evidence", async () => {
    const dir = await directory()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = createJournal({ dir, inject: { log } })

    await expect(journal.append(frame("observable"), 0)).resolves.toMatchObject({ appended: true })
    await expect(journal.append(frame("stale-writer"), 0)).resolves.toMatchObject({ appended: false })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "log",
          namespace: "yrd:journal:lock",
          level: "info",
          props: expect.objectContaining({ lifecycle: "lock", outcome: "succeeded", durationMs: expect.any(Number) }),
        }),
        expect.objectContaining({
          kind: "log",
          namespace: "yrd:journal:append",
          level: "info",
          props: expect.objectContaining({
            lifecycle: "append",
            expectedCursor: 0,
            outcome: "succeeded",
            durationMs: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          kind: "log",
          namespace: "yrd:journal:append",
          level: "trace",
          props: expect.objectContaining({
            lifecycle: "append",
            expectedCursor: 0,
            appended: false,
            outcome: "progress",
          }),
        }),
      ]),
    )
    log.end()
  })

  it("generates UUIDv7 command, cause, and event ids uniquely across fresh processes", async () => {
    const dir = await directory()
    const results = await Promise.all([dispatchInFreshProcess(dir), dispatchInFreshProcess(dir)])
    const stored = (await Array.fromAsync(createJournal({ dir }).read())).flatMap((batch) => batch.values) as {
      cause: { id: string }
      command: { id: string }
      events: { id: string }[]
    }[]
    const resultIds = results.flatMap((value) => {
      const result = value as { command: { id: string }; events: { id: string }[] }
      return [result.command.id, ...result.events.map((event) => event.id)]
    })
    const storedIds = stored.flatMap((value) => [
      value.cause.id,
      value.command.id,
      ...value.events.map((event) => event.id),
    ])

    expect(stored).toHaveLength(2)
    expect(new Set(storedIds).size).toBe(storedIds.length)
    expect(new Set(resultIds).size).toBe(resultIds.length)
    expect(storedIds.every((id) => z.uuidv7().safeParse(id).success)).toBe(true)
    expect(resultIds.every((id) => storedIds.includes(id))).toBe(true)
  })

  it("round-trips frames as logical cursor-addressed batches", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    const first = { ...frame("c1", "hello"), value: { receipt: "saved" } }
    const second = frame("c2")

    const firstCursor = await accepted(journal, first, 0)
    const secondCursor = await accepted(journal, second, firstCursor)

    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor: secondCursor, values: [first, second] }])
    expect(await Array.fromAsync(journal.read(firstCursor))).toEqual([{ cursor: secondCursor, values: [second] }])
    const active = await manifest(dir)
    const state = await tailState(dir, active)
    expect(active.logicalEnd + state.committedBytes).toBe(secondCursor)
  })

  it("uses compare-and-append instead of exposing writer leases", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    const cursor = await accepted(journal, frame("c1"), 0)

    await expect(journal.append(frame("stale"), 0)).resolves.toEqual({ appended: false, cursor })
    expect(await Array.fromAsync(journal.read())).toEqual([{ cursor, values: [frame("c1")] }])
  })

  it("preserves concurrent commands from independent runtimes", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
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
    createJournal({ dir })
    const syncEntered = Promise.withResolvers<void>()
    const syncRelease = Promise.withResolvers<void>()
    let syncs = 0
    const journal = testJournal(dir, {
      io: {
        async datasync(file) {
          syncs += 1
          if (syncs === 4) {
            syncEntered.resolve()
            await syncRelease.promise
          }
          await file.datasync()
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
    const result = await append
    if (!result.appended) throw new Error("expected append")
    await expect(read).resolves.toEqual([{ cursor: result.cursor, values: [frame("durable")] }])
  })

  it("does not hold the journal lock while a reader consumes its pinned snapshot", async () => {
    const dir = await directory()
    const seed = createJournal({ dir })
    const cursor = await accepted(seed, frame("first"), 0)
    const snapshotReady = Promise.withResolvers<void>()
    const snapshotRelease = Promise.withResolvers<void>()
    const readerJournal = testJournal(dir, {
      async phase(phase) {
        if (phase !== "after-read-snapshot") return
        snapshotReady.resolve()
        await snapshotRelease.promise
      },
    })
    const reader = readerJournal.read()[Symbol.asyncIterator]()
    const next = reader.next()
    await snapshotReady.promise

    const writer = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    const secondCursor = await accepted(writer, frame("second"), cursor)
    snapshotRelease.resolve()

    await expect(next).resolves.toEqual({ done: false, value: { cursor, values: [frame("first")] } })
    await reader.return?.()

    const unadvanced = createJournal({ dir }).read()
    expect(await Array.fromAsync(unadvanced)).toEqual([
      { cursor, values: [frame("first")] },
      { cursor: secondCursor, values: [frame("second")] },
    ])
  })

  it("retries short file writes until metadata and frames are durable", async () => {
    const dir = await directory()
    let writes = 0
    const journal = testJournal(dir, {
      io: {
        write(file, bytes, offset, length, position) {
          writes += 1
          return file.write(bytes, offset, Math.min(length, 7), position)
        },
      },
    })

    const cursor = await accepted(journal, frame("short-write"), 0)
    expect(writes).toBeGreaterThan(1)
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor, values: [frame("short-write")] }])
  })

  it("rejects invalid write progress without creating authority", async () => {
    const dir = await directory()
    const broken = testJournal(dir, {
      io: {
        async write() {
          return { bytesWritten: 0 }
        },
      },
    })

    await expect(broken.append(frame("stalled"), 0)).rejects.toThrow("invalid progress")

    const journal = createJournal({ dir })
    expect(await Array.fromAsync(journal.read())).toEqual([])
    const cursor = await accepted(journal, frame("recovered"), 0)
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor, values: [frame("recovered")] }])
  })

  it("never acknowledges tail bytes whose state pointer did not commit", async () => {
    const dir = await directory()
    const seed = createJournal({ dir })
    const cursor = await accepted(seed, frame("committed"), 0)
    const before = await manifest(dir)
    const state = await tailState(dir, before)
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const broken = testJournal(dir, {
      log,
      phase(phase) {
        if (phase === "before-tail-state-replace") throw new Error("injected state-pointer interruption")
      },
    })

    let acknowledged = false
    await expect(
      broken.append(frame("unacknowledged"), cursor).then((result) => {
        acknowledged = result.appended
        return result
      }),
    ).rejects.toThrow("state-pointer interruption")
    expect(acknowledged).toBe(false)
    expect((await stat(join(dir, before.tail.path))).size).toBeGreaterThan(state.committedBytes)

    const recovered = testJournal(dir, { log })
    await expect(Array.fromAsync(recovered.read())).resolves.toEqual([{ cursor, values: [frame("committed")] }])
    expect((await stat(join(dir, before.tail.path))).size).toBe(state.committedBytes)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          props: expect.objectContaining({ action: "recovered", reason: "uncommitted-tail" }),
        }),
      ]),
    )
    log.end()
  })

  it("repairs a legacy file with no committed newline before migration", async () => {
    const dir = await directory()
    await writeFile(join(dir, V3), "x".repeat(130 * 1024))
    const journal = createJournal({ dir })

    const cursor = await accepted(journal, frame("first"), 0)
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor, values: [frame("first")] }])
  })

  it("fails on newline-committed corruption and checksum drift", async () => {
    const corruptDir = await directory()
    await writeFile(join(corruptDir, V3), "{bad}\n")
    await expect(Array.fromAsync(createJournal({ dir: corruptDir }).read())).rejects.toThrow("journal corrupt")

    const driftDir = await directory()
    const valid = createJournal({ dir: driftDir })
    await accepted(valid, frame("c1"), 0)
    const active = await manifest(driftDir)
    const path = join(driftDir, active.tail.path)
    const text = await readFile(path, "utf8")
    await writeFile(path, text.replace("hello", "jello"))
    await expect(Array.fromAsync(valid.read())).rejects.toThrow("checksum")
  })

  it("activates byte and frame thresholds inclusively while below-threshold appends remain a no-op", async () => {
    const byteDir = await directory()
    const byteSeed = testJournal(byteDir, {
      thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: Number.MAX_SAFE_INTEGER },
    })
    const byteCursor = await accepted(byteSeed, frame("byte-first"), 0)
    const byteState = await tailState(byteDir)
    expect((await manifest(byteDir)).segments).toHaveLength(0)

    const exactByte = testJournal(byteDir, {
      thresholds: { bytes: byteState.committedBytes, frames: Number.MAX_SAFE_INTEGER },
    })
    await accepted(exactByte, frame("byte-second"), byteCursor)
    expect((await manifest(byteDir)).segments).toHaveLength(1)

    const frameDir = await directory()
    const below = testJournal(frameDir, {
      thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 2 },
    })
    const firstCursor = await accepted(below, frame("frame-first"), 0)
    const secondCursor = await accepted(below, frame("frame-second"), firstCursor)
    expect((await manifest(frameDir)).segments).toHaveLength(0)
    await accepted(below, frame("frame-third"), secondCursor)
    expect((await manifest(frameDir)).segments).toHaveLength(1)

    const aboveDir = await directory()
    const aboveSeed = testJournal(aboveDir, {
      thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: Number.MAX_SAFE_INTEGER },
    })
    const aboveFirst = await accepted(aboveSeed, frame("above-first"), 0)
    const aboveSecond = await accepted(aboveSeed, frame("above-second"), aboveFirst)
    const above = testJournal(aboveDir, {
      thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 },
    })
    await accepted(above, frame("above-third"), aboveSecond)
    expect((await manifest(aboveDir)).segments).toHaveLength(1)
  })

  it("keeps prior persistence cursors valid across compaction and process restart", async () => {
    const dir = await directory()
    const journal = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    const persistedCursor = await accepted(journal, frame("before-compact"), 0)
    const currentCursor = await accepted(journal, frame("after-compact"), persistedCursor)
    expect(currentCursor).toBeGreaterThan(persistedCursor)

    const restarted = createJournal({ dir })
    await expect(Array.fromAsync(restarted.read(persistedCursor))).resolves.toEqual([
      { cursor: currentCursor, values: [frame("after-compact")] },
    ])
  })

  it("seals exact tail bytes with both digests and never rewrites retained segments", async () => {
    const dir = await directory()
    const seed = createJournal({ dir })
    const firstCursor = await accepted(seed, frame("raw-first", "exact bytes"), 0)
    const before = await manifest(dir)
    const raw = await readFile(join(dir, before.tail.path))

    const compacting = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    const secondCursor = await accepted(compacting, frame("raw-second"), firstCursor)
    const once = await manifest(dir)
    expect(once.segments).toHaveLength(1)
    const firstSegment = once.segments[0]
    if (firstSegment === undefined) throw new Error("expected compacted segment")
    const compressed = await readFile(join(dir, firstSegment.path))
    expect(gunzipSync(compressed)).toEqual(raw)
    expect(createHash("sha256").update(raw).digest("hex")).toBe(firstSegment.rawSha256)
    expect(createHash("sha256").update(compressed).digest("hex")).toBe(firstSegment.compressedSha256)

    await accepted(compacting, frame("raw-third"), secondCursor)
    const twice = await manifest(dir)
    expect(twice.segments).toHaveLength(2)
    expect(twice.segments[0]).toEqual(firstSegment)
    expect(await readFile(join(dir, firstSegment.path))).toEqual(compressed)
  })

  it("refuses a stale compactor with zero authoritative mutation", async () => {
    const dir = await directory()
    const seed = createJournal({ dir })
    const cursor = await accepted(seed, frame("cas-seed"), 0)
    const paused = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const stale = testJournal(dir, {
      thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 },
      log,
      async phase(phase) {
        if (phase !== "candidate-ready") return
        paused.resolve()
        await release.promise
      },
    })
    const staleAppend = stale.append(frame("cas-stale"), cursor)
    await paused.promise

    const winner = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    const winnerCursor = await accepted(winner, frame("cas-winner"), cursor)
    const beforeStaleInstall = await authoritativeBytes(dir)
    release.resolve()

    await expect(staleAppend).resolves.toEqual({ appended: false, cursor: winnerCursor })
    expect(await authoritativeBytes(dir)).toEqual(beforeStaleInstall)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          props: expect.objectContaining({ action: "refused", reason: "concurrent-generation-or-writer" }),
        }),
      ]),
    )
    log.end()
  })

  it("keeps v3 authoritative until process-fresh v4 replay verifies, then seals it", async () => {
    const dir = await directory()
    const legacy = Buffer.from(v3Line(frame("legacy-first")) + v3Line(frame("legacy-second")))
    await writeFile(join(dir, V3), legacy)
    const verifying = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const journal = testJournal(dir, {
      async phase(phase) {
        if (phase !== "before-verification") return
        verifying.resolve()
        await release.promise
      },
    })
    const append = journal.append(frame("post-migration"), legacy.length)
    await verifying.promise
    expect(await readFile(join(dir, V3))).toEqual(legacy)
    release.resolve()
    const result = await append
    if (!result.appended) throw new Error("expected migrated append")
    expect(await readFile(join(dir, V3), "utf8")).toBe(V3_CUTOVER)
    expect((await stat(join(dir, V3))).mode & 0o222).toBe(0)

    const restarted = createJournal({ dir })
    await expect(Array.fromAsync(restarted.read(legacy.length))).resolves.toEqual([
      { cursor: result.cursor, values: [frame("post-migration")] },
    ])
  })

  it("preserves and refuses a v3 tail recreated after v4 cutover", async () => {
    const dir = await directory()
    const legacy = Buffer.from(v3Line(frame("legacy-authority")))
    await writeFile(join(dir, V3), legacy)
    const journal = createJournal({ dir })
    await accepted(journal, frame("post-migration"), legacy.length)

    const recreated = Buffer.from(v3Line(frame("phantom-old-writer")))
    await rm(join(dir, V3), { force: true })
    await writeFile(join(dir, V3), recreated)

    await expect(Array.fromAsync(createJournal({ dir }).read())).rejects.toThrow(
      "legacy v3 journal changed after v4 cutover",
    )
    expect(await readFile(join(dir, V3))).toEqual(recreated)
  })

  it("restores v3 and preserves failed-generation evidence when production verification fails", async () => {
    const dir = await directory()
    const legacy = Buffer.from(v3Line(frame("legacy-authority")))
    await writeFile(join(dir, V3), legacy)
    const journal = testJournal(dir, {
      async phase(phase, details) {
        if (phase !== "before-verification") return
        const paths = details.segmentPaths as string[]
        await writeFile(join(dir, paths.at(-1) ?? "missing-segment"), "corrupt")
      },
    })

    await expect(journal.append(frame("must-not-commit"), legacy.length)).rejects.toThrow("previous authority restored")
    expect(await readFile(join(dir, V3))).toEqual(legacy)
    expect((await readdir(dir)).some((path) => path.includes(".failed-") && path.endsWith(".manifest.json"))).toBe(true)
    expect((await readdir(dir)).some((path) => path.includes(".failed-") && path.endsWith(".recovery.json"))).toBe(true)
    await expect(Array.fromAsync(createJournal({ dir }).read())).resolves.toEqual([
      { cursor: legacy.length, values: [frame("legacy-authority")] },
    ])
  })

  it.each(["before-manifest-replace", "after-manifest-replace", "before-cleanup"])(
    "recovers losslessly after interruption at %s",
    async (faultPhase) => {
      const dir = await directory()
      const seed = createJournal({ dir })
      const cursor = await accepted(seed, frame(`fault-seed:${faultPhase}`), 0)
      const interrupted = testJournal(dir, {
        thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 },
        phase(phase) {
          if (phase === faultPhase) throw new Error(`injected ${faultPhase}`)
        },
      })

      await expect(interrupted.append(frame(`fault-attempt:${faultPhase}`), cursor)).rejects.toThrow(faultPhase)
      const recovered = createJournal({ dir })
      await expect(Array.fromAsync(recovered.read())).resolves.toEqual([
        { cursor, values: [frame(`fault-seed:${faultPhase}`)] },
      ])
      const nextCursor = await accepted(recovered, frame(`fault-retry:${faultPhase}`), cursor)
      await expect(Array.fromAsync(recovered.read(cursor))).resolves.toEqual([
        { cursor: nextCursor, values: [frame(`fault-retry:${faultPhase}`)] },
      ])
      expect(await missing(join(dir, RECOVERY))).toBe(true)
    },
  )

  it("keeps empty and populated read-only journals byte-pure", async () => {
    const parent = await directory()
    const emptyDir = join(parent, "absent")
    const empty = createReadOnlyJournal({ dir: emptyDir })
    await expect(Array.fromAsync(empty.read())).resolves.toEqual([])
    expect(await missing(emptyDir)).toBe(true)
    expect(empty.checkpoint).toBeUndefined()
    await expect(empty.append(frame("read-only-refusal"), 0)).rejects.toThrow("read-only journal cannot append")
    expect(await missing(emptyDir)).toBe(true)

    const dir = await directory()
    const cursor = await accepted(createJournal({ dir }), frame("read-only-seed"), 0)
    const namesBefore = (await readdir(dir)).toSorted()
    const lockBefore = await readFile(join(dir, "writer.lock"))
    const readOnly = createReadOnlyJournal({ dir })
    await expect(Array.fromAsync(readOnly.read())).resolves.toEqual([{ cursor, values: [frame("read-only-seed")] }])
    expect(readOnly.checkpoint).toBeUndefined()
    expect((await readdir(dir)).toSorted()).toEqual(namesBefore)
    expect(await readFile(join(dir, "writer.lock"))).toEqual(lockBefore)
    expect(await missing(join(dir, "snapshot-v1.json"))).toBe(true)
    expect(await missing(join(dir, "projection-checkpoint-v1.json"))).toBe(true)
  })

  it("fails read-only replay loudly instead of repairing interrupted authority", async () => {
    const recoveryDir = await directory()
    const cursor = await accepted(createJournal({ dir: recoveryDir }), frame("read-only-recovery-seed"), 0)
    const interrupted = testJournal(recoveryDir, {
      thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 },
      phase(phase) {
        if (phase === "before-cleanup") throw new Error("injected read-only recovery")
      },
    })
    await expect(interrupted.append(frame("read-only-recovery-attempt"), cursor)).rejects.toThrow(
      "injected read-only recovery",
    )
    const recoveryBefore = await readFile(join(recoveryDir, RECOVERY))
    const lockBefore = await readFile(join(recoveryDir, "writer.lock"))
    await expect(Array.fromAsync(createReadOnlyJournal({ dir: recoveryDir }).read())).rejects.toThrow(
      "journal recovery is required before read-only access",
    )
    expect(await readFile(join(recoveryDir, RECOVERY))).toEqual(recoveryBefore)
    expect(await readFile(join(recoveryDir, "writer.lock"))).toEqual(lockBefore)

    const tailDir = await directory()
    await accepted(createJournal({ dir: tailDir }), frame("read-only-tail-seed"), 0)
    const active = await manifest(tailDir)
    const tailPath = join(tailDir, active.tail.path)
    await appendFile(tailPath, "uncommitted")
    const tailBefore = await readFile(tailPath)
    await expect(Array.fromAsync(createReadOnlyJournal({ dir: tailDir }).read())).rejects.toThrow(
      "journal recovery is required before read-only access",
    )
    expect(await readFile(tailPath)).toEqual(tailBefore)

    const cutoverDir = await directory()
    const legacy = Buffer.from(v3Line(frame("read-only-cutover-legacy")))
    await writeFile(join(cutoverDir, V3), legacy)
    await accepted(createJournal({ dir: cutoverDir }), frame("read-only-cutover-next"), legacy.length)
    await rm(join(cutoverDir, V3))
    await expect(Array.fromAsync(createReadOnlyJournal({ dir: cutoverDir }).read())).rejects.toThrow(
      "legacy v3 cutover marker is missing",
    )
    expect(await missing(join(cutoverDir, V3))).toBe(true)
  })

  it("refuses Windows before creating the journal directory or any authority", async () => {
    const parent = await directory()
    const dir = join(parent, "unsupported")
    const journal = testJournal(dir, { platform: "win32" })

    await expect(journal.append(frame("windows"), 0)).rejects.toThrow("unsupported platform")
    expect(await missing(dir)).toBe(true)
  })

  it("reports cold replay cost as retained-history work rather than bounded compaction", async () => {
    const dir = await directory()
    const journal = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    const first = await accepted(journal, frame("cold-first"), 0)
    await accepted(journal, frame("cold-second"), first)
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const cold = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 }, log })

    await Array.fromAsync(cold.read())
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          props: expect.objectContaining({
            action: "none",
            reason: "cold-replay-retained-history",
            frames: 2,
            coldReplayMs: expect.any(Number),
          }),
        }),
      ]),
    )
    log.end()
  })
})
