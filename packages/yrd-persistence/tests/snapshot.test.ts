/**
 * @failure A stale, corrupt, or foreign snapshot cache can silently diverge replayed frames, folded state, or receipts from the journal.
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  type Journal,
} from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import canonicalize from "canonicalize"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { SNAPSHOT_FILE, SNAPSHOT_REFRESH_FRAMES, encodeSnapshotFile } from "../src/snapshot.ts"

const MANIFEST = "events-v4.manifest.json"

type TestInject = Readonly<{
  thresholds?: Readonly<{ bytes?: number; frames?: number; snapshotFrames?: number }>
  log?: ConditionalLogger
  io?: Readonly<{
    read?(
      file: FileHandle,
      bytes: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<Readonly<{ bytesRead: number }>>
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

async function directory() {
  return mkdtemp(join(tmpdir(), "yrd-snapshot-"))
}

function testJournal(dir: string, inject: TestInject = {}): Journal<unknown> {
  return createJournal({ dir, inject } as unknown as Parameters<typeof createJournal>[0])
}

async function accepted(journal: Journal<unknown>, value: ReturnType<typeof frame>, cursor: number) {
  const result = await journal.append(value, cursor)
  if (!result.appended) throw new Error(`expected append at ${cursor}, observed ${result.cursor}`)
  return result.cursor
}

async function drained(journal: Journal<unknown>, after = 0, before?: number) {
  const batches = await Array.fromAsync(journal.read(after, before))
  const values = batches.flatMap((batch) => [...batch.values])
  return { batches, values, cursor: batches.at(-1)?.cursor ?? after }
}

function capture(): { log: ConditionalLogger; events: LogEvent[]; end(): void } {
  const events: LogEvent[] = []
  const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
  return { log, events, end: () => log.end() }
}

function propsOf(events: readonly LogEvent[], action: string) {
  return events
    .filter((event) => (event as { props?: { action?: string } }).props?.action === action)
    .map((event) => (event as { props: Record<string, unknown> }).props)
}

async function snapshotDocument(dir: string) {
  return JSON.parse(await readFile(join(dir, SNAPSHOT_FILE), "utf8")) as {
    v: number
    cursor: number
    frames: number
    values: unknown[]
    binding: {
      decoder: string
      generation: number
      manifestDigest: string
      tailIdentity: string
      tailLogicalStart: number
      tailPrefixSha256: string
      segments: { path: string; logicalStart: number; logicalEnd: number; compressedSha256: string }[]
    }
  }
}

/** Builds an encodeSnapshotFile view from a seeded snapshot document (binding template). */
function viewFrom(document: Awaited<ReturnType<typeof snapshotDocument>>, logicalEnd: number) {
  return {
    decoder: document.binding.decoder,
    generation: document.binding.generation,
    manifestDigest: document.binding.manifestDigest,
    tailIdentity: document.binding.tailIdentity,
    tailLogicalStart: document.binding.tailLogicalStart,
    logicalEnd,
    segments: document.binding.segments,
  }
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function counterDefinition() {
  const add = command({
    title: "Add",
    visibility: "public",
    apply: (state: { counter: number }) => ({ events: [event("counter/added", { value: state.counter + 1 })] }),
  })
  return createYrdDef().extend({
    initialState: { counter: 0 },
    commands: { counter: { add } },
    events: {
      "counter/added": z.object({ value: z.number().int() }),
      "test/recorded": z.object({ text: z.string() }),
    },
    project(state, applied) {
      return applied.name === "counter/added"
        ? { counter: (applied.data as { value: number }).value }
        : { counter: state.counter }
    },
  })
}

describe("journal snapshot cache", () => {
  it("seeds on cold replay and serves an equivalent warm replay with an empty tail", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    let cursor = 0
    for (const key of ["c1", "c2", "c3"]) cursor = await accepted(journal, frame(key), cursor)

    const cold = await drained(createJournal({ dir }))
    const document = await snapshotDocument(dir)
    expect(document).toMatchObject({ v: 1, cursor, frames: 3 })
    const written = await readFile(join(dir, SNAPSHOT_FILE), "utf8")

    const { log, events, end } = capture()
    const warm = await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(warm.values).toEqual(cold.values)
    expect(warm.values).toEqual([frame("c1"), frame("c2"), frame("c3")])
    expect(warm.cursor).toBe(cold.cursor)
    expect(propsOf(events, "snapshot-hit")).toEqual([
      expect.objectContaining({ cursor, cachedFrames: 3, replayedFrames: 0 }),
    ])
    // snapshot exactly at head: nothing replayed, no rewrite
    expect(await readFile(join(dir, SNAPSHOT_FILE), "utf8")).toBe(written)
  })

  it("replays only the tail beyond the snapshot and matches a full replay", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    let cursor = 0
    for (const key of ["c1", "c2"]) cursor = await accepted(journal, frame(key), cursor)
    const seeded = await drained(createJournal({ dir }))
    expect(seeded.values).toHaveLength(2)
    for (const key of ["c3", "c4", "c5"]) cursor = await accepted(journal, frame(key), cursor)

    const { log, events, end } = capture()
    const warm = await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(warm.values).toEqual([frame("c1"), frame("c2"), frame("c3"), frame("c4"), frame("c5")])
    expect(warm.cursor).toBe(cursor)
    // structural proof: only the 3 tail frames were decoded
    expect(propsOf(events, "snapshot-hit")).toEqual([expect.objectContaining({ cachedFrames: 2, replayedFrames: 3 })])
    // 3 tail frames stay below the refresh threshold: the snapshot is not rewritten
    expect((await snapshotDocument(dir)).frames).toBe(2)
    expect(SNAPSHOT_REFRESH_FRAMES).toBe(200)
  })

  it("serves warm replays across compacted segments plus tail", async () => {
    const dir = await directory()
    const compacting = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    let cursor = 0
    for (const key of ["s1", "s2", "s3"]) cursor = await accepted(compacting, frame(key), cursor)
    expect(
      (JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as { segments: unknown[] }).segments.length,
    ).toBeGreaterThan(0)

    const cold = await drained(createJournal({ dir }))
    const warm = await drained(createJournal({ dir }))
    expect(warm.values).toEqual(cold.values)
    expect(warm.values).toEqual([frame("s1"), frame("s2"), frame("s3")])
    expect(warm.cursor).toBe(cold.cursor)
  })

  it("rewrites the snapshot once the replayed tail exceeds the refresh threshold", async () => {
    const dir = await directory()
    const journal = testJournal(dir, { thresholds: { snapshotFrames: 2 } })
    let cursor = 0
    cursor = await accepted(journal, frame("c1"), cursor)
    await drained(journal)
    expect((await snapshotDocument(dir)).frames).toBe(1)

    for (const key of ["c2", "c3", "c4"]) cursor = await accepted(journal, frame(key), cursor)
    const warm = await drained(journal)
    expect(warm.values).toHaveLength(4)
    const refreshed = await snapshotDocument(dir)
    expect(refreshed.frames).toBe(4)
    expect(refreshed.cursor).toBe(cursor)

    // and a warm read over the refreshed snapshot serves everything from cache
    const { log, events, end } = capture()
    await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(propsOf(events, "snapshot-hit")).toEqual([expect.objectContaining({ cachedFrames: 4, replayedFrames: 0 })])
  })

  it("falls back loudly and rewrites when the snapshot file is truncated", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    let cursor = 0
    for (const key of ["c1", "c2"]) cursor = await accepted(journal, frame(key), cursor)
    await drained(journal)
    const path = join(dir, SNAPSHOT_FILE)
    const text = await readFile(path, "utf8")
    await writeFile(path, text.slice(0, Math.floor(text.length / 2)))

    const { log, events, end } = capture()
    const recovered = await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(recovered.values).toEqual([frame("c1"), frame("c2")])
    expect(propsOf(events, "full-replay")).toEqual([expect.objectContaining({ reason: "snapshot-corrupt-json" })])
    const rewritten = await snapshotDocument(dir)
    expect(rewritten).toMatchObject({ v: 1, cursor, frames: 2 })
  })

  it("falls back loudly when the snapshot binding names a replaced generation", async () => {
    const dir = await directory()
    const compacting = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 1 } })
    let cursor = 0
    cursor = await accepted(compacting, frame("c1"), cursor)
    await drained(compacting)
    const stale = await readFile(join(dir, SNAPSHOT_FILE), "utf8")

    // compaction bumps the generation and deliberately removes the snapshot
    cursor = await accepted(compacting, frame("c2"), cursor)
    await expect(readFile(join(dir, SNAPSHOT_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    // a stale snapshot resurfacing (older writer, restored backup) is rejected loudly
    await writeFile(join(dir, SNAPSHOT_FILE), stale)
    const { log, events, end } = capture()
    const recovered = await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(recovered.values).toEqual([frame("c1"), frame("c2")])
    expect(propsOf(events, "full-replay")).toEqual([
      expect.objectContaining({ reason: "snapshot-generation-mismatch", expected: 2, observed: 1 }),
    ])
    expect((await snapshotDocument(dir)).binding.generation).toBe(2)
  })

  it("falls back loudly on a wrong snapshot schema version and on a tampered header", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    await accepted(journal, frame("c1"), 0)
    await drained(journal)
    const path = join(dir, SNAPSHOT_FILE)
    const text = await readFile(path, "utf8")

    await writeFile(path, text.replace('"v":1', '"v":2'))
    const versioned = capture()
    await drained(createJournal({ dir, inject: { log: versioned.log } }))
    versioned.end()
    expect(propsOf(versioned.events, "full-replay")).toEqual([
      expect.objectContaining({ reason: "snapshot-schema-version", expected: 1, observed: 2 }),
    ])

    const document = JSON.parse(await readFile(path, "utf8")) as { cursor: number }
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(`"cursor":${document.cursor}`, `"cursor":${document.cursor + 1}`),
    )
    const tampered = capture()
    const recovered = await drained(createJournal({ dir, inject: { log: tampered.log } }))
    tampered.end()
    expect(recovered.values).toEqual([frame("c1")])
    expect(propsOf(tampered.events, "full-replay")).toEqual([
      expect.objectContaining({ reason: "snapshot-header-checksum" }),
    ])
  })

  it("falls back loudly when snapshot values are tampered", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    await accepted(journal, frame("c1"), 0)
    await drained(journal)
    const path = join(dir, SNAPSHOT_FILE)
    await writeFile(path, (await readFile(path, "utf8")).replace("hello", "jello"))

    const { log, events, end } = capture()
    const recovered = await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(recovered.values).toEqual([frame("c1")])
    expect(propsOf(events, "full-replay")).toEqual([expect.objectContaining({ reason: "snapshot-values-checksum" })])
  })

  it("never masks covered journal bytes that changed on disk", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    await accepted(journal, frame("c1"), 0)
    await drained(journal)
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as { tail: { path: string } }
    const tailPath = join(dir, manifest.tail.path)
    await writeFile(tailPath, (await readFile(tailPath, "utf8")).replace("hello", "jello"))

    const { log, events, end } = capture()
    await expect(Array.fromAsync(createJournal({ dir, inject: { log } }).read())).rejects.toThrow("checksum")
    end()
    expect(propsOf(events, "full-replay")).toEqual([
      expect.objectContaining({ reason: "snapshot-covered-tail-checksum" }),
    ])
  })

  it("ignores leftover temp files from a killed writer and stays additive for old readers", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    const first = await accepted(journal, frame("c1"), 0)
    const second = await accepted(journal, frame("c2"), first)
    await writeFile(join(dir, "events-v4.tmp-11111111-2222-7333-8444-555555555555"), "garbage from a killed writer")

    const cold = await drained(createJournal({ dir }))
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as {
      segments: { path: string }[]
      tail: { path: string }
      tailState: { path: string }
    }
    const authority = [MANIFEST, ...manifest.segments.map((segment) => segment.path), manifest.tail.path]
    const before = Object.fromEntries(
      await Promise.all(authority.map(async (path) => [path, (await readFile(join(dir, path))).toString("base64")])),
    )
    const warm = await drained(createJournal({ dir }))
    expect(warm.values).toEqual(cold.values)
    const after = Object.fromEntries(
      await Promise.all(authority.map(async (path) => [path, (await readFile(join(dir, path))).toString("base64")])),
    )
    // pure cache: every journal authority file is byte-identical, so a snapshot-unaware reader is unaffected
    expect(after).toEqual(before)
    // suffix reads bypass the cache entirely
    expect(await drained(createJournal({ dir }), first)).toMatchObject({ values: [frame("c2")], cursor: second })
  })

  it("keeps concurrent readers safe with last-write-wins snapshot writes", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    let cursor = 0
    for (const key of ["c1", "c2", "c3"]) cursor = await accepted(journal, frame(key), cursor)

    const results = await Promise.all([
      drained(createJournal({ dir })),
      drained(createJournal({ dir })),
      drained(createJournal({ dir })),
    ])
    for (const result of results) {
      expect(result.values).toEqual([frame("c1"), frame("c2"), frame("c3")])
      expect(result.cursor).toBe(cursor)
    }
    expect(await snapshotDocument(dir)).toMatchObject({ v: 1, cursor, frames: 3 })
  })

  it("bypasses the cache for bounded reads below its coverage without clobbering it", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    const first = await accepted(journal, frame("c1"), 0)
    const second = await accepted(journal, frame("c2"), first)
    await drained(journal)
    const written = await readFile(join(dir, SNAPSHOT_FILE), "utf8")

    const bounded = await drained(createJournal({ dir }), 0, first)
    expect(bounded.values).toEqual([frame("c1")])
    expect(await readFile(join(dir, SNAPSHOT_FILE), "utf8")).toBe(written)
    expect((await snapshotDocument(dir)).cursor).toBe(second)
  })

  it("returns the original receipt for a retried command id after a warm restart", async () => {
    const dir = await directory()
    const definition = counterDefinition()
    const commandId = uuid("retry:command")

    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    const original = await first.dispatch({ op: "counter.add", id: commandId })
    await first.close()

    // second boot folds read(0) and seeds the snapshot; third boot restores warm from it
    const second = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    await second.close()
    const { log, events, end } = capture()
    const third = await createYrd(definition, { inject: { journal: createJournal({ dir, inject: { log } }) } })
    const before = await third.journalSnapshot()
    const replayed = await third.dispatch({ op: "counter.add", id: commandId })
    const after = await third.journalSnapshot()
    end()

    expect(propsOf(events, "snapshot-hit").length).toBeGreaterThan(0)
    expect(replayed).toEqual(original)
    expect(after.asOf.cursor).toBe(before.asOf.cursor)
    expect(third.state().counter).toBe(1)
    await third.close()
  })

  it.each([
    ["command id", "duplicate command id"],
    ["cause id", "duplicate cause id"],
    ["event id", "duplicate event id"],
  ] as const)("keeps duplicate %s detection armed across a snapshot restore", async (kind, expected) => {
    const dir = await directory()
    const journal = createJournal({ dir })
    const first = frame("dup-1")
    const cursor = await accepted(journal, first, 0)
    await drained(journal)

    const second = frame("dup-2")
    const [firstEvent] = first.events
    const [secondEvent] = second.events
    if (firstEvent === undefined || secondEvent === undefined) throw new Error("expected seeded events")
    let duplicated: ReturnType<typeof frame>
    if (kind === "command id") {
      const commandValue = Command.parse({ id: first.command.id, op: second.command.op })
      const cause: Cause = CauseSchema.parse({
        id: uuid("dup-cause:command"),
        commandId: commandValue.id,
        op: commandValue.op,
        commandHash: Command.hash(commandValue),
      })
      duplicated = { cause, command: commandValue, events: [secondEvent] }
    } else if (kind === "cause id") {
      duplicated = {
        ...second,
        cause: CauseSchema.parse({
          id: first.cause.id,
          commandId: second.command.id,
          op: second.command.op,
          commandHash: Command.hash(second.command),
        }),
      }
    } else {
      duplicated = { ...second, events: [{ ...secondEvent, id: firstEvent.id }] }
    }
    await accepted(journal, duplicated, cursor)

    // the duplicate lives in the tail; the original comes from the snapshot — the
    // receipts/cause/event registries must be rebuilt from cached frames exactly
    await expect(createYrd(counterDefinition(), { inject: { journal: createJournal({ dir }) } })).rejects.toThrow(
      expected,
    )
  })

  it("streams events() in journal order from the warm path and matches invalid-snapshot output to a full replay", async () => {
    const dir = await directory()
    const definition = counterDefinition()
    const boot = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    for (let index = 0; index < 5; index += 1) await boot.dispatch({ op: "counter.add" })
    await boot.close()
    const seeding = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    const coldEvents = await Array.fromAsync(seeding.events())
    const coldState = seeding.state()
    await seeding.close()

    const warm = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    const warmEvents = await Array.fromAsync(warm.events())
    expect(warmEvents).toEqual(coldEvents)
    expect(warm.state()).toEqual(coldState)
    // events beyond the snapshot (tail) must stream after the checkpointed prefix in journal order
    for (let index = 0; index < 2; index += 1) await warm.dispatch({ op: "counter.add" })
    const crossing = await Array.fromAsync(warm.events())
    await warm.close()
    expect(crossing.slice(0, coldEvents.length)).toEqual(coldEvents)
    expect(crossing).toHaveLength(coldEvents.length + 2)
    const control = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    expect(await Array.fromAsync(control.events())).toEqual(crossing)
    expect(control.state().counter).toBe(7)
    await control.close()

    // an invalid snapshot must yield the same events and state as the full replay
    const path = join(dir, SNAPSHOT_FILE)
    await writeFile(path, (await readFile(path, "utf8")).slice(0, 40))
    const fallback = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    expect(await Array.fromAsync(fallback.events())).toEqual(crossing)
    expect(fallback.state().counter).toBe(7)
    await fallback.close()
  })

  it("does not create a snapshot for empty or legacy v3 journals", async () => {
    const dir = await directory()
    expect(await Array.fromAsync(createJournal({ dir }).read())).toEqual([])
    await expect(readFile(join(dir, SNAPSHOT_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("round-trips snapshot values byte-for-byte with what decode yielded", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    const value = { ...frame("exact", 'påyløad   "quoted" \\slash 1e21'), value: { receipt: [1, 2.5, null, true] } }
    await journal.append(value, 0)
    const cold = await drained(createJournal({ dir }))
    const warm = await drained(createJournal({ dir }))
    expect(warm.values).toEqual(cold.values)
    expect(canonicalize(warm.values)).toBe(canonicalize(cold.values))
  })

  it("returns the original receipt for a retried command key after a warm restart", async () => {
    const dir = await directory()
    const definition = counterDefinition()

    const first = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    const original = await first.dispatch({ op: "counter.add" }, { key: "idempotent-op" })
    await first.close()

    const seeding = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    await seeding.close()
    const warm = await createYrd(definition, { inject: { journal: createJournal({ dir }) } })
    const before = await warm.journalSnapshot()
    const replayed = await warm.dispatch({ op: "counter.add" }, { key: "idempotent-op" })
    const after = await warm.journalSnapshot()

    // receiptsByKey must be rebuilt from the cached frames exactly: same receipt, no new append
    expect(replayed).toEqual(original)
    expect(after.asOf.cursor).toBe(before.asOf.cursor)
    expect(warm.state().counter).toBe(1)
    await warm.close()
  })

  it("never seeds a snapshot inside a segment and rejects pre-fix mid-segment snapshots over corrupt authority", async () => {
    const dir = await directory()
    // frames:2 compaction: c1+c2 become ONE segment, c3 stays in the tail
    const journal = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 2 } })
    const cursor1 = await accepted(journal, frame("c1"), 0)
    const cursor2 = await accepted(journal, frame("c2"), cursor1)
    const cursor3 = await accepted(journal, frame("c3"), cursor2)

    // 1) bounded read ending INSIDE the segment completes but must not seed a snapshot
    const bounded = await drained(createJournal({ dir }), 0, cursor1)
    expect(bounded.values).toEqual([frame("c1")])
    await expect(readFile(join(dir, SNAPSHOT_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    // 2) template from a legitimate seed, then reproduce the pre-fix state: a
    //    snapshot whose cursor lands inside the compressed segment
    const seeded = await drained(createJournal({ dir }))
    expect(seeded.values).toHaveLength(3)
    const document = await snapshotDocument(dir)
    expect(document.binding.segments).toHaveLength(1)
    const [segment] = document.binding.segments
    if (segment === undefined) throw new Error("expected one compacted segment")
    expect(segment.logicalStart).toBeLessThan(cursor1)
    expect(segment.logicalEnd).toBeGreaterThan(cursor1)
    const crafted = encodeSnapshotFile({
      view: viewFrom(document, cursor3),
      cursor: cursor1,
      frames: 1,
      valuesJson: JSON.stringify(bounded.values),
      tailPrefixSha256: sha256Hex(Buffer.alloc(0)),
    })

    // 3) corrupt the covered bytes of the segment WITHOUT touching manifest or cache
    const segmentPath = join(dir, segment.path)
    const compressed = await readFile(segmentPath)
    compressed[Math.floor(compressed.length / 2)] = (compressed[Math.floor(compressed.length / 2)] ?? 0) ^ 0xff
    await writeFile(segmentPath, compressed)

    // control: cache-disabled bounded replay over the corrupt segment
    await rm(join(dir, SNAPSHOT_FILE), { force: true })
    let controlError: Error | undefined
    try {
      await drained(createJournal({ dir }), 0, cursor1)
    } catch (error) {
      controlError = error as Error
    }
    if (controlError === undefined) throw new Error("expected the control replay to reject")
    expect(controlError.message).toContain("compressed segment checksum mismatch")

    // 4) the same bounded read with the pre-fix snapshot present must warn once,
    //    fall back, raise the SAME error, and must NOT rewrite from corrupt authority
    await writeFile(join(dir, SNAPSHOT_FILE), crafted)
    const { log, events, end } = capture()
    let unmaskedError: Error | undefined
    try {
      await drained(createJournal({ dir, inject: { log } }), 0, cursor1)
    } catch (error) {
      unmaskedError = error as Error
    }
    end()
    expect(propsOf(events, "full-replay")).toEqual([
      expect.objectContaining({ reason: "snapshot-covers-partial-segment", observed: cursor1 }),
    ])
    expect(unmaskedError?.message).toBe(controlError.message)
    expect(await readFile(join(dir, SNAPSHOT_FILE), "utf8")).toBe(crafted)
  })

  it("invalidates loudly when the snapshot was written by a different decoder", async () => {
    const dir = await directory()
    const journal = createJournal({ dir })
    let cursor = 0
    for (const key of ["c1", "c2"]) cursor = await accepted(journal, frame(key), cursor)
    await drained(journal)
    const document = await snapshotDocument(dir)
    expect(document.binding.decoder).toMatch(/^journal-v4\/frame-v3\//)

    const foreign = encodeSnapshotFile({
      view: { ...viewFrom(document, cursor), decoder: "journal-v4/frame-v3/decode-r0" },
      cursor: document.cursor,
      frames: document.frames,
      valuesJson: JSON.stringify(document.values),
      tailPrefixSha256: document.binding.tailPrefixSha256,
    })
    await writeFile(join(dir, SNAPSHOT_FILE), foreign)

    const { log, events, end } = capture()
    const recovered = await drained(createJournal({ dir, inject: { log } }))
    end()
    expect(recovered.values).toEqual([frame("c1"), frame("c2")])
    expect(propsOf(events, "full-replay")).toEqual([
      expect.objectContaining({
        reason: "snapshot-decoder-mismatch",
        expected: document.binding.decoder,
        observed: "journal-v4/frame-v3/decode-r0",
      }),
    ])
    expect((await snapshotDocument(dir)).binding.decoder).toBe(document.binding.decoder)
  })

  it("reads exactly the verification and tail-delta byte ranges on a warm start", async () => {
    const dir = await directory()
    const journal = testJournal(dir, { thresholds: { bytes: Number.MAX_SAFE_INTEGER, frames: 2 } })
    const cursor1 = await accepted(journal, frame("c1"), 0)
    const cursor2 = await accepted(journal, frame("c2"), cursor1)
    const cursor3 = await accepted(journal, frame("c3"), cursor2)
    await drained(createJournal({ dir }))
    const document = await snapshotDocument(dir)
    const [segment] = document.binding.segments
    if (segment === undefined) throw new Error("expected one compacted segment")
    const compressedSize = (await stat(join(dir, segment.path))).size
    const tailStart = document.binding.tailLogicalStart
    expect(tailStart).toBe(cursor2)
    const coveredTail = cursor3 - tailStart

    const spy = () => {
      const reads = new Map<FileHandle, [number, number][]>()
      const read = (file: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) => {
        reads.set(file, [...(reads.get(file) ?? []), [position, length]])
        return file.read(bytes, offset, length, position)
      }
      return { reads, read }
    }

    // warm at head: one whole-compressed-segment integrity read + one tail-prefix
    // integrity read; NO historical decode read and NO tail re-read from offset 0
    const atHead = spy()
    const warm = await drained(testJournal(dir, { io: { read: atHead.read } }))
    expect(warm.values).toEqual([frame("c1"), frame("c2"), frame("c3")])
    const headRanges = [...atHead.reads.values()]
    expect(headRanges).toHaveLength(2)
    expect(headRanges).toEqual(expect.arrayContaining([[[0, compressedSize]], [[0, coveredTail]]]))

    // with new tail frames: the ONLY additional read is the tail delta [covered, committed)
    const cursor4 = await accepted(createJournal({ dir }), frame("c4"), cursor3)
    const delta = spy()
    const tail = await drained(testJournal(dir, { io: { read: delta.read } }))
    expect(tail.values).toEqual([frame("c1"), frame("c2"), frame("c3"), frame("c4")])
    const deltaRanges = [...delta.reads.values()]
    expect(deltaRanges).toHaveLength(2)
    expect(deltaRanges).toEqual(
      expect.arrayContaining([
        [[0, compressedSize]],
        [
          [0, coveredTail],
          [coveredTail, cursor4 - cursor3],
        ],
      ]),
    )
  })
})
