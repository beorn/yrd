/**
 * @failure Durable replay, migration, snapshot compaction, recovery, or cursor CAS can lose or expose journal frames.
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { appendFile, copyFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  CauseSchema,
  Command,
  EventSchema,
  type Cause,
  type Cursor,
  type Event,
  type Journal,
  type JournalCheckpoint,
} from "@yrd/core"
import {
  assertSafeWalVersion,
  createJournal,
  createReadOnlyJournal,
  readArchivedOrphans,
  resolveCustomSqliteLibrary,
  type Exclusive,
  type ExclusiveOptions,
} from "@yrd/persistence"
import canonicalize from "canonicalize"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"

const MANIFEST = "events-v4.manifest.json"
const RECOVERY = "events-v4.recovery.json"
const V3 = "events-v3.jsonl"
const V3_CUTOVER = `{"v":4,"cutover":"events-v4.manifest.json"}\n`
const SQLITE = "journal.sqlite"
const SAFE_SQLITE = "3.53.0"

type ExpectedJournalOptions = Readonly<{
  dir: string
  lock?: ExclusiveOptions
  inject?: Readonly<{
    exclusive?: Exclusive
    log?: ConditionalLogger
  }>
}>

type TestInject = Readonly<{
  exclusive?: Exclusive
  log?: ConditionalLogger
  platform?: string
  sqliteVersion?: string
  phase?: (phase: string, details: Readonly<Record<string, unknown>>) => void | Promise<void>
}>

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function frame(key: string, text = "hello") {
  const command = Command.parse({ id: uuid(`command:${key}`), op: "test.record" })
  const cause: Cause = CauseSchema.parse({
    id: uuid(`cause:${key}`),
    commandId: command.id,
    op: command.op,
    commandHash: Command.hash(command),
  })
  const applied: Event = EventSchema.parse({
    id: uuid(`event:${key}`),
    name: "test/recorded",
    ts: "2026-07-09T12:00:00.000Z",
    data: { text },
  })
  return { cause, command, events: [applied] }
}

function digest(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("expected canonical JSON")
  return createHash("sha256").update(encoded).digest("hex")
}

function exactDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function storedV3(value: ReturnType<typeof frame>) {
  const data = { v: 3, ...value }
  return { ...data, checksum: digest(data) }
}

function v3Line(value: ReturnType<typeof frame>): string {
  return `${JSON.stringify(storedV3(value))}\n`
}

function archivedOrphanLine(value: ReturnType<typeof frame>, sourceSha256 = "1".repeat(64)): string {
  const data = {
    v: 3,
    kind: "archived-orphan",
    provenance: {
      "origin-lane": "v3-phantom",
      "origin-file": "events-v3.orphan.jsonl",
      "origin-row": value.command.id,
      "source-sha256": sourceSha256,
      "imported-at": "2026-07-16T04:00:00.000Z",
      "imported-by": "@adhoc/0",
      "collision-policy": "refuse",
    },
    frame: storedV3(value),
  }
  return `${JSON.stringify({ ...data, checksum: digest(data) })}\n`
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-sqlite-journal-"))
  roots.push(root)
  return root
}

function testJournal(dir: string, inject: TestInject = {}): Journal<unknown> {
  return createJournal({
    dir,
    inject: { sqliteVersion: SAFE_SQLITE, ...inject },
  } as unknown as Parameters<typeof createJournal>[0])
}

function testReadOnlyJournal(dir: string, inject: TestInject = {}): Journal<unknown> {
  return createReadOnlyJournal({
    dir,
    inject: { sqliteVersion: SAFE_SQLITE, ...inject },
  } as unknown as Parameters<typeof createReadOnlyJournal>[0])
}

async function accepted(journal: Journal<unknown>, value: ReturnType<typeof frame>, cursor: number): Promise<number> {
  const result = await journal.append(value, cursor)
  if (!result.appended) throw new Error(`expected append at ${cursor}, observed ${result.cursor}`)
  return result.cursor
}

async function downgradeFixtureToSchemaV1(
  dir: string,
  values: readonly ReturnType<typeof frame>[],
): Promise<readonly number[]> {
  if (values.length < 2) throw new Error("schema-v1 fixture requires a prefix and tail")
  const journal = testJournal(dir)
  const cursors: number[] = []
  let cursor = 0
  for (const value of values) {
    cursor = await accepted(journal, value, cursor)
    cursors.push(cursor)
  }
  const prefixCursor = cursors[0]
  if (prefixCursor === undefined) throw new Error("schema-v1 fixture lost its prefix cursor")
  await journal.checkpoint?.save?.({ identity: "schema-v1-fixture", cursor: prefixCursor, value: { fixture: true } })

  using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
  const row = database
    .query<{ value_json: string }, [number]>("SELECT value_json FROM journal_history WHERE cursor = ?")
    .get(prefixCursor)
  if (row === null) throw new Error("schema-v1 fixture lost its compacted prefix frame")
  const prefixJson = JSON.stringify([{ cursor: prefixCursor, value: JSON.parse(row.value_json) }])
  database
    .query(
      `UPDATE journal_snapshot
       SET prefix_json = ?, prefix_sha256 = ?, prefix_last_cursor = ?
       WHERE singleton = 1`,
    )
    .run(prefixJson, exactDigest(prefixJson), prefixCursor)
  database.run(`
    DROP INDEX journal_entities_cursor;
    DROP TABLE journal_entities;
    DROP TABLE journal_event_ids;
    DROP TABLE journal_commands;
    DROP TABLE journal_history;
  `)
  database.query("UPDATE journal_metadata SET value = '1' WHERE key = 'schema_version'").run()
  database.query("DELETE FROM journal_metadata WHERE key IN ('facts_head', 'maintenance_pending')").run()
  database.run("PRAGMA user_version = 1")
  database.run("PRAGMA auto_vacuum = NONE")
  database.run("VACUUM")
  return cursors
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

async function writeV4Lines(dir: string, lines: readonly string[]) {
  const tailPath = "events-v4.tail-fixture.jsonl"
  const statePath = "events-v4.tail-fixture.state.json"
  const identity = uuid("tail:fixture")
  const raw = Buffer.from(lines.join(""))
  const lastChecksum =
    lines.at(-1) === undefined ? null : (JSON.parse(lines.at(-1)!) as Readonly<{ checksum: string }>).checksum
  const signed = <Value extends Record<string, unknown>>(value: Value) => ({ ...value, digest: digest(value) })
  const manifest = signed({
    formatVersion: 4,
    generation: 1,
    sourceGeneration: 0,
    logicalStart: 0,
    logicalEnd: 0,
    frames: 0,
    segments: [],
    tail: {
      path: tailPath,
      identity,
      logicalStart: 0,
      initialSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    },
    tailState: { path: statePath },
  })
  const state = signed({
    formatVersion: 4,
    generation: 1,
    tailIdentity: identity,
    committedBytes: raw.length,
    logicalEnd: raw.length,
    frames: lines.length,
    lastChecksum,
  })
  await Promise.all([
    writeFile(join(dir, MANIFEST), JSON.stringify(manifest)),
    writeFile(join(dir, tailPath), raw),
    writeFile(join(dir, statePath), JSON.stringify(state)),
    writeFile(join(dir, V3), V3_CUTOVER),
  ])
  return {
    cursor: raw.length,
    cursors: lines.reduce<number[]>(
      (cursors, line) => [...cursors, (cursors.at(-1) ?? 0) + Buffer.byteLength(line)],
      [],
    ),
    paths: [MANIFEST, tailPath, statePath, V3],
  }
}

async function writeV4Fixture(dir: string, values: readonly ReturnType<typeof frame>[]) {
  return writeV4Lines(dir, values.map(v3Line))
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

async function hardExitMigration(dir: string, phase: string): Promise<Readonly<{ code: number; stderr: string }>> {
  // The eval subprocess resolves modules from its own cwd, which has no
  // top-level @yrd/* under isolated (pnpm-style) linking. Point it at the
  // package entry directly so the migration replay resolves the real
  // createJournal without depending on a hoisted node_modules layout.
  const persistenceEntry = join(import.meta.dirname, "..", "src", "index.ts")
  const source = `
    import { createJournal } from ${JSON.stringify(persistenceEntry)}
    const journal = createJournal({
      dir: ${JSON.stringify(dir)},
      inject: {
        sqliteVersion: ${JSON.stringify(SAFE_SQLITE)},
        phase(name) {
          if (name === ${JSON.stringify(phase)}) process.exit(77)
        },
      },
    })
    await Array.fromAsync(journal.read())
  `
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}

describe("SQLite Journal", () => {
  it("keeps Core cursors opaque, construction synchronous, and the public option seam frozen", async () => {
    expectTypeOf<Cursor>().toEqualTypeOf<number>()
    expectTypeOf<Parameters<typeof createJournal>[0]>().toEqualTypeOf<ExpectedJournalOptions>()
    expectTypeOf(createJournal).returns.toEqualTypeOf<Journal<unknown>>()

    const dir = await directory()
    const journal = testJournal(dir)
    expect(journal).not.toBeInstanceOf(Promise)
    expect(Object.keys(journal).sort()).toEqual(["append", "read"])
    expect(await missing(join(dir, SQLITE))).toBe(true)
  })

  it("stores fresh authority in one WAL SQLite container with exact cursor-ordered checksummed events", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = await accepted(journal, frame("sqlite-first"), 0)
    const second = await accepted(journal, frame("sqlite-second"), first)

    expect([first, second]).toEqual([1, 2])
    await expect(Array.fromAsync(journal.read(first))).resolves.toEqual([
      { cursor: second, values: [frame("sqlite-second")] },
    ])

    using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    expect(database.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'journal_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
    ).toEqual([
      "journal_commands",
      "journal_entities",
      "journal_event_ids",
      "journal_events",
      "journal_history",
      "journal_metadata",
      "journal_orphans",
      "journal_snapshot",
    ])
    expect(
      database
        .query<{ cursor: number; value_json: string; sha256: string }, []>(
          "SELECT cursor, value_json, sha256 FROM journal_events ORDER BY cursor",
        )
        .all(),
    ).toEqual([
      {
        cursor: first,
        value_json: JSON.stringify(frame("sqlite-first")),
        sha256: exactDigest(JSON.stringify(frame("sqlite-first"))),
      },
      {
        cursor: second,
        value_json: JSON.stringify(frame("sqlite-second")),
        sha256: exactDigest(JSON.stringify(frame("sqlite-second"))),
      },
    ])
  })

  it("exposes journal-owned exact identity and command lookups without a second mutable projection", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const value = frame("history-lookup")
    await accepted(journal, value, 0)
    const history = (
      journal as Journal<unknown> & {
        history?: {
          command(query: Readonly<{ id?: string; key?: string }>): unknown
          hasIdentity(kind: "cause" | "event", id: string): boolean
          diagnostics(): Readonly<{
            autoVacuum: "incremental"
            historyFrames: number
            tailFrames: number
          }>
        }
      }
    ).history

    expect(history).toBeDefined()
    expect(history?.command({ id: value.command.id })).toEqual(value)
    expect(history?.hasIdentity("cause", value.cause.id)).toBe(true)
    expect(history?.hasIdentity("event", value.events[0]!.id)).toBe(true)
    expect(history?.diagnostics()).toMatchObject({
      autoVacuum: "incremental",
      historyFrames: 0,
      tailFrames: 1,
    })

    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.query("UPDATE journal_commands SET command_hash = ? WHERE cursor = 1").run("0".repeat(64))
    }
    expect(() => history?.command({ id: value.command.id })).toThrow("command lookup facts disagree")
  })

  it("pins one SQLite snapshot while history lookups race a committed append", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = frame("history-snapshot-first")
    await accepted(journal, first, 0)
    const second = frame("history-snapshot-second")
    const valueJson = JSON.stringify(second)
    const original = Database.prototype.query
    let injected = false
    const query = vi.spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
      if (!injected && sql.includes("SELECT MAX(cursor) AS cursor FROM journal_events")) {
        injected = true
        using writer = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
        writer.run("BEGIN IMMEDIATE")
        try {
          writer
            .query("INSERT INTO journal_events(cursor, value_json, sha256) VALUES (?, ?, ?)")
            .run(2, valueJson, exactDigest(valueJson))
          writer
            .query(
              `INSERT INTO journal_commands(cursor, command_id, command_key, command_hash, cause_id)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(2, second.command.id, null, second.cause.commandHash, second.cause.id)
          writer
            .query("INSERT INTO journal_event_ids(event_id, cursor, event_index) VALUES (?, ?, ?)")
            .run(second.events[0]!.id, 2, 0)
          writer.query("UPDATE journal_metadata SET value = '2' WHERE key IN ('head_cursor', 'facts_head')").run()
          writer.run("COMMIT")
        } catch (error) {
          writer.run("ROLLBACK")
          throw error
        }
      }
      return Reflect.apply(original, this, [sql])
    } as typeof Database.prototype.query)
    try {
      expect(journal.history?.command({ id: first.command.id })).toEqual(first)
    } finally {
      query.mockRestore()
    }
    expect(injected).toBe(true)
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor: 2, values: [first, second] }])
  })

  it("closes diagnostics cleanly on a fragmented journal with a large freelist", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const cursor = await accepted(journal, frame("fragmented-diagnostics"), 0)
    await journal.checkpoint?.save?.({ identity: "fragmented-v1", cursor, value: { state: 1 } })

    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.run("CREATE TABLE diagnostic_bloat(value BLOB NOT NULL) STRICT")
      database.run("BEGIN")
      const insert = database.prepare("INSERT INTO diagnostic_bloat(value) VALUES (zeroblob(4096))")
      try {
        for (let index = 0; index < 2_048; index += 1) insert.run()
      } finally {
        insert.finalize()
      }
      database.run("COMMIT")
      database.run("DROP TABLE diagnostic_bloat")
      expect(
        database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count,
      ).toBeGreaterThan(1_000)
    }

    expect(() => journal.history?.diagnostics()).not.toThrow()
    expect(journal.history?.diagnostics()).toMatchObject({
      autoVacuum: "incremental",
      historyFrames: 1,
      tailFrames: 0,
    })
  })

  it("indexes entity-shaped frames exactly and refuses a corrupt all-history index", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const source = frame("queue-entity-lookup")
    const value = {
      ...source,
      events: [
        EventSchema.parse({
          ...source.events[0],
          name: "queue/run/settled",
          data: { run: "R1" },
        }),
      ],
    }
    const cursor = await accepted(journal, value, 0)
    const lowerSource = frame("queue-entity-lowercase")
    const lowerValue = {
      ...lowerSource,
      events: [
        EventSchema.parse({
          ...lowerSource.events[0],
          name: "queue/run/settled",
          data: { run: "r1" },
        }),
      ],
    }
    await accepted(journal, lowerValue, cursor)

    expect(journal.history?.entity("queue", "R1")).toEqual([{ cursor, value }])
    expect(journal.history?.entity("queue", "r1")).toEqual([{ cursor: 2, value: lowerValue }])

    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.query("UPDATE journal_entities SET id = 'R2' WHERE kind = 'queue' AND id = 'R1'").run()
    }
    expect(() => journal.history?.entity("queue", "R2")).toThrow("entity lookup facts disagree")
    expect(() => journal.history?.diagnostics()).toThrow("entity lookup index does not equal")
  })

  it("migrates schema v1 prefix and tail into row history with identical cursor suffixes and facts", async () => {
    const dir = await directory()
    const values = [frame("schema-v1-prefix"), frame("schema-v1-tail")]
    await downgradeFixtureToSchemaV1(dir, values)
    {
      using legacy = new Database(join(dir, SQLITE), { readonly: true, strict: true })
      expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
      expect(legacy.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 })
    }

    const phases: string[] = []
    const journal = testJournal(dir, {
      phase(name) {
        phases.push(name)
      },
    })
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: 1, values: [values[0]] },
      { cursor: 2, values: [values[1]] },
    ])
    await expect(Array.fromAsync(journal.read(0, 1))).resolves.toEqual([{ cursor: 1, values: [values[0]] }])
    await expect(Array.fromAsync(journal.read(1, 2))).resolves.toEqual([{ cursor: 2, values: [values[1]] }])
    expect(phases).toEqual(
      expect.arrayContaining([
        "schema-v2-prepared",
        "schema-v2-committed",
        "schema-v2-maintenance-started",
        "schema-v2-maintenance-complete",
      ]),
    )
    expect(journal.history?.command({ id: values[0]!.command.id })).toEqual(values[0])
    expect(journal.history?.command({ id: values[1]!.command.id })).toEqual(values[1])

    using migrated = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 })
    expect(migrated.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    expect(
      migrated
        .query<{ key: string; value: string }, []>(
          "SELECT key, value FROM journal_metadata WHERE key IN ('facts_head', 'maintenance_pending') ORDER BY key",
        )
        .all(),
    ).toEqual([
      { key: "facts_head", value: "2" },
      { key: "maintenance_pending", value: "0" },
    ])
    expect(
      migrated
        .query<{ cursor: number; value_json: string; sha256: string }, []>(
          `SELECT cursor, value_json, sha256 FROM journal_history
           UNION ALL
           SELECT cursor, value_json, sha256 FROM journal_events
           ORDER BY cursor`,
        )
        .all()
        .map((row) => ({ ...row, valid: exactDigest(row.value_json) === row.sha256 })),
    ).toEqual([
      { cursor: 1, value_json: JSON.stringify(values[0]), sha256: exactDigest(JSON.stringify(values[0])), valid: true },
      { cursor: 2, value_json: JSON.stringify(values[1]), sha256: exactDigest(JSON.stringify(values[1])), valid: true },
    ])
  })

  it.each([
    ["schema-v2-committed", "1"],
    ["schema-v2-maintenance-started", "1"],
    ["schema-v2-maintenance-complete", "0"],
  ] as const)("resumes schema v1 migration idempotently after %s interruption", async (phase, pending) => {
    const dir = await directory()
    const values = [frame(`${phase}-prefix`), frame(`${phase}-tail`)]
    await downgradeFixtureToSchemaV1(dir, values)
    let interrupted = false
    const journal = testJournal(dir, {
      phase(name) {
        if (name !== phase || interrupted) return
        interrupted = true
        throw new Error(`injected ${phase} interruption`)
      },
    })
    await expect(Array.fromAsync(journal.read())).rejects.toThrow(`injected ${phase} interruption`)
    {
      using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 })
      expect(
        database
          .query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'maintenance_pending'")
          .get(),
      ).toEqual({ value: pending })
    }
    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([
      { cursor: 1, values: [values[0]] },
      { cursor: 2, values: [values[1]] },
    ])
    using completed = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(completed.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    expect(
      completed
        .query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'maintenance_pending'")
        .get(),
    ).toEqual({ value: "0" })
  })

  it("leaves migrated authority maintenance-pending when the schema v1 full VACUUM fails", async () => {
    const dir = await directory()
    const values = [frame("full-vacuum-prefix"), frame("full-vacuum-tail")]
    await downgradeFixtureToSchemaV1(dir, values)
    const original = Database.prototype.run
    const vacuum = vi.spyOn(Database.prototype, "run").mockImplementation(function (
      this: Database,
      sql: string,
      ...bindings: unknown[]
    ) {
      if (sql.trim().toUpperCase() === "VACUUM") throw new Error("injected full vacuum failure")
      return Reflect.apply(original, this, [sql, ...bindings])
    } as typeof Database.prototype.run)
    try {
      await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow("injected full vacuum failure")
    } finally {
      vacuum.mockRestore()
    }
    {
      using pending = new Database(join(dir, SQLITE), { readonly: true, strict: true })
      expect(pending.query("PRAGMA user_version").get()).toEqual({ user_version: 2 })
      expect(
        pending
          .query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'maintenance_pending'")
          .get(),
      ).toEqual({ value: "1" })
    }

    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([
      { cursor: 1, values: [values[0]] },
      { cursor: 2, values: [values[1]] },
    ])
    using completed = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(completed.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
  })

  it("uses compare-and-append across independent runtimes without losing the loser", async () => {
    const dir = await directory()
    const firstJournal = testJournal(dir)
    const secondJournal = testJournal(dir)
    const [left, right] = await Promise.all([
      firstJournal.append(frame("left"), 0),
      secondJournal.append(frame("right"), 0),
    ])

    expect([left.appended, right.appended].filter(Boolean)).toHaveLength(1)
    const winner = left.appended ? frame("left") : frame("right")
    const loser = left.appended ? frame("right") : frame("left")
    const head = left.appended ? left.cursor : right.cursor
    expect(await accepted(firstJournal, loser, head)).toBe(2)
    await expect(Array.fromAsync(secondJournal.read())).resolves.toEqual([{ cursor: 2, values: [winner, loser] }])
  })

  it("releases the writer lock before the caller consumes a pinned read result", async () => {
    const dir = await directory()
    let held = false
    let runs = 0
    const exclusive: Exclusive = {
      async run<Result>(operation: () => Promise<Result>): Promise<Result> {
        expect(held).toBe(false)
        held = true
        runs += 1
        try {
          return await operation()
        } finally {
          held = false
        }
      },
    }
    const journal = testJournal(dir, { exclusive })
    await accepted(journal, frame("reader"), 0)

    const iterator = journal.read()[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first).toEqual({ done: false, value: { cursor: 1, values: [frame("reader")] } })
    expect(held).toBe(false)
    expect(runs).toBe(2)
  })

  it("emits structured lock and append lifecycle evidence", async () => {
    const dir = await directory()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = testJournal(dir, { log })

    await expect(journal.append(frame("observable"), 0)).resolves.toMatchObject({ appended: true })
    await expect(journal.append(frame("stale"), 0)).resolves.toMatchObject({ appended: false })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "log",
          namespace: "yrd:journal:lock",
          props: expect.objectContaining({ lifecycle: "lock", outcome: "succeeded" }),
        }),
        expect.objectContaining({
          kind: "log",
          namespace: "yrd:journal:append",
          props: expect.objectContaining({ lifecycle: "append", outcome: "succeeded", cursor: 1 }),
        }),
      ]),
    )
  })

  it("reports a failed maintenance WAL checkpoint without losing an acknowledged append", async () => {
    const dir = await directory()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const original = Database.prototype.query
    const query = vi.spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("wal_checkpoint")) throw new Error("injected checkpoint failure")
      return original.call(this, sql)
    } as typeof Database.prototype.query)
    try {
      await expect(testJournal(dir, { log }).append(frame("checkpoint-warning"), 0)).resolves.toMatchObject({
        appended: true,
      })
    } finally {
      query.mockRestore()
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:journal",
        level: "warn",
        props: expect.objectContaining({
          action: "deferred",
          reason: "wal-checkpoint-failed",
          error: "injected checkpoint failure",
        }),
      }),
    )
    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).resolves.toEqual([
      { cursor: 1, values: [frame("checkpoint-warning")] },
    ])
  })

  it("reports WAL frames deferred by a pinned reader with checkpoint counts", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    await accepted(journal, frame("pinned-reader-before"), 0)
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    using reader = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    reader.run("BEGIN")
    reader.query("SELECT COUNT(*) AS count FROM journal_events").get()
    try {
      await expect(testJournal(dir, { log }).append(frame("pinned-reader-after"), 1)).resolves.toMatchObject({
        appended: true,
      })
    } finally {
      reader.run("ROLLBACK")
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:journal",
        level: "warn",
        props: expect.objectContaining({
          action: "deferred",
          reason: "wal-checkpoint-pinned",
          logFrames: expect.any(Number),
          checkpointedFrames: expect.any(Number),
        }),
      }),
    )
  })

  it("refuses affected SQLite WAL runtimes before creating authority", async () => {
    expect(() => assertSafeWalVersion("3.51.0")).toThrow("unsafe for WAL")
    expect(() => assertSafeWalVersion("3.51.3")).not.toThrow()
    expect(() => assertSafeWalVersion("3.50.7")).not.toThrow()
    expect(() => assertSafeWalVersion("3.44.6")).not.toThrow()

    const dir = await directory()
    const unsafe = testJournal(dir, { sqliteVersion: "3.51.0" })
    await expect(unsafe.append(frame("unsafe"), 0)).rejects.toThrow("SQLite 3.51.0 is unsafe for WAL")
    expect(await missing(join(dir, SQLITE))).toBe(true)
  })

  it("resolves a custom SQLite library for unsafe bundled runtimes", () => {
    expect(resolveCustomSqliteLibrary("/lib/custom.dylib", "darwin", () => true)).toBe("/lib/custom.dylib")
    expect(resolveCustomSqliteLibrary("  ", "darwin", () => true)).toBe("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")
    expect(resolveCustomSqliteLibrary(undefined, "darwin", () => false)).toBeUndefined()
    expect(resolveCustomSqliteLibrary(undefined, "linux", () => true)).toBeUndefined()
    expect(resolveCustomSqliteLibrary("/lib/custom.dylib", "linux", () => false)).toBe("/lib/custom.dylib")
  })

  it("fails loud on checksum drift instead of replaying unverified SQL", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    await accepted(journal, frame("verified"), 0)
    using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
    database.query("UPDATE journal_events SET value_json = ? WHERE cursor = 1").run(JSON.stringify(frame("tampered")))

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow("event checksum mismatch")
  })

  it("binds each SQL event checksum to its exact stored JSON bytes", async () => {
    const dir = await directory()
    await accepted(testJournal(dir), frame("exact-event-bytes"), 0)
    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.query("UPDATE journal_events SET value_json = value_json || ' ' WHERE cursor = 1").run()
    }

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow("event checksum mismatch")
  })

  it.each([
    ["lowered head", "UPDATE journal_metadata SET value='1' WHERE key='head_cursor'"],
    ["raised head", "UPDATE journal_metadata SET value='3' WHERE key='head_cursor'"],
    ["snapshot beyond head", "UPDATE journal_snapshot SET cursor=999 WHERE singleton=1"],
  ])("refuses %s metadata that disagrees with committed cursor boundaries", async (_case, mutation) => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = await accepted(journal, frame("cursor-binding-first"), 0)
    await accepted(journal, frame("cursor-binding-second"), first)
    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.run(mutation)
    }

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow(/cursor|head/iu)
  })

  it("refuses one logical cursor committed in both the live and orphan tables", async () => {
    const dir = await directory()
    const legacy = await writeV4Lines(dir, [
      v3Line(frame("overlap-live")),
      archivedOrphanLine(frame("overlap-orphan")),
      v3Line(frame("overlap-tail")),
    ])
    await Array.fromAsync(testJournal(dir).read())
    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.query("UPDATE journal_orphans SET cursor = ?").run(legacy.cursors[0]!)
    }

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow(/overlap|cursor/iu)
  })

  it("refuses live rows hidden at or below the compacted snapshot cursor", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = await accepted(journal, frame("hidden-prefix"), 0)
    await accepted(journal, frame("hidden-tail"), first)
    await journal.checkpoint?.save?.({ identity: "projection-v1", cursor: first, value: { state: 1 } })
    const hiddenJson = JSON.stringify(frame("hidden-injected"))
    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database
        .query("INSERT INTO journal_events(cursor, value_json, sha256) VALUES (?, ?, ?)")
        .run(first, hiddenJson, exactDigest(hiddenJson))
    }

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow(/snapshot|hidden|cursor/iu)
  })

  it("requires every nonzero snapshot cursor to name a prefix or orphan boundary", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = await accepted(journal, frame("boundary-prefix"), 0)
    const second = await accepted(journal, frame("boundary-tail"), first)
    await journal.checkpoint?.save?.({ identity: "projection-v1", cursor: first, value: { state: 1 } })
    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.query("DELETE FROM journal_events WHERE cursor = ?").run(second)
      database.query("UPDATE journal_snapshot SET cursor = ? WHERE singleton = 1").run(second)
    }

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow(/snapshot.*boundary|cursor/iu)
  })

  it("atomically snapshots an exact cursor prefix, deletes covered rows, and keeps old cursors replayable", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = await accepted(journal, frame("prefix-first"), 0)
    const second = await accepted(journal, frame("tail-second"), first)
    const checkpoint: JournalCheckpoint = { identity: "projection-v1", cursor: first, value: { state: 1 } }

    await expect(journal.checkpoint?.save?.(checkpoint)).resolves.toBe(true)
    await expect(journal.checkpoint?.load(checkpoint.identity)).resolves.toEqual(checkpoint)
    await expect(Array.fromAsync(journal.read(0, first))).resolves.toEqual([
      { cursor: first, values: [frame("prefix-first")] },
    ])
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: first, values: [frame("prefix-first")] },
      { cursor: second, values: [frame("tail-second")] },
    ])

    using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(database.query<{ cursor: number }, []>("SELECT cursor FROM journal_events ORDER BY cursor").all()).toEqual([
      { cursor: second },
    ])
    expect(database.query<{ cursor: number }, []>("SELECT cursor FROM journal_history ORDER BY cursor").all()).toEqual([
      { cursor: first },
    ])
    expect(
      database.query<{ cursor: number }, []>("SELECT cursor FROM journal_snapshot WHERE singleton=1").get(),
    ).toEqual({
      cursor: first,
    })
  })

  it("defers incremental vacuum failure after committing a readable checkpoint", async () => {
    const dir = await directory()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = testJournal(dir, { log })
    const first = await accepted(journal, frame("vacuum-prefix"), 0)
    const second = await accepted(journal, frame("vacuum-tail"), first)
    const checkpoint: JournalCheckpoint = { identity: "vacuum-v1", cursor: first, value: { state: 1 } }
    const original = Database.prototype.run
    const vacuum = vi.spyOn(Database.prototype, "run").mockImplementation(function (
      this: Database,
      sql: string,
      ...bindings: unknown[]
    ) {
      if (sql.includes("incremental_vacuum")) throw new Error("injected incremental vacuum failure")
      return Reflect.apply(original, this, [sql, ...bindings])
    } as typeof Database.prototype.run)
    try {
      await expect(journal.checkpoint?.save?.(checkpoint)).resolves.toBe(true)
    } finally {
      vacuum.mockRestore()
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:journal",
        level: "warn",
        props: expect.objectContaining({
          action: "deferred",
          reason: "incremental-vacuum-failed",
          error: "injected incremental vacuum failure",
        }),
      }),
    )
    await expect(journal.checkpoint?.load(checkpoint.identity)).resolves.toEqual(checkpoint)
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      { cursor: first, values: [frame("vacuum-prefix")] },
      { cursor: second, values: [frame("vacuum-tail")] },
    ])
  })

  it("binds a projection checkpoint checksum to its exact stored JSON bytes", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const cursor = await accepted(journal, frame("checkpoint-bytes"), 0)
    const checkpoint: JournalCheckpoint = { identity: "projection-v1", cursor, value: { state: 1 } }
    await expect(journal.checkpoint?.save?.(checkpoint)).resolves.toBe(true)

    using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
    database.query("UPDATE journal_snapshot SET checkpoint_json = checkpoint_json || ' '").run()

    await expect(journal.checkpoint?.load(checkpoint.identity)).resolves.toBeUndefined()
  })

  it("fails loud if deprecated prefix bytes try to become a second history authority", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const cursor = await accepted(journal, frame("prefix-bytes"), 0)
    const checkpoint: JournalCheckpoint = { identity: "projection-v1", cursor, value: { state: 1 } }
    await journal.checkpoint?.save?.(checkpoint)

    {
      using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
      database.query("UPDATE journal_snapshot SET prefix_json = prefix_json || ' '").run()
    }

    await expect(journal.checkpoint?.load?.("projection-v1")).rejects.toThrow("snapshot prefix checksum mismatch")
    await expect(journal.append(frame("tail-after-corrupt-prefix"), cursor)).rejects.toThrow(
      "snapshot prefix checksum mismatch",
    )
    await expect(Array.fromAsync(journal.read())).rejects.toThrow("snapshot prefix checksum mismatch")
  })

  it("returns only committed cursors for arbitrary bounded reads inside migrated byte gaps", async () => {
    const dir = await directory()
    const values = [frame("gap-first"), frame("gap-second")]
    const legacy = await writeV4Fixture(dir, values)
    const journal = testJournal(dir)
    await Array.fromAsync(journal.read())
    await expect(
      journal.checkpoint?.save?.({ identity: "gap-v1", cursor: legacy.cursor, value: { state: 2 } }),
    ).resolves.toBe(true)
    const [firstCursor, secondCursor] = legacy.cursors
    if (firstCursor === undefined || secondCursor === undefined) throw new Error("expected two legacy cursors")

    await expect(Array.fromAsync(journal.read(0, firstCursor - 1))).resolves.toEqual([])
    await expect(Array.fromAsync(journal.read(0, firstCursor + 1))).resolves.toEqual([
      { cursor: firstCursor, values: [values[0]] },
    ])
    await expect(Array.fromAsync(journal.read(firstCursor, secondCursor - 1))).resolves.toEqual([])
    await expect(Array.fromAsync(journal.read(firstCursor, secondCursor))).resolves.toEqual([
      { cursor: secondCursor, values: [values[1]] },
    ])
  })

  it("refuses a prepared checkpoint when a peer advances the snapshot before its commit CAS", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const first = await accepted(journal, frame("checkpoint-race-first"), 0)
    const second = await accepted(journal, frame("checkpoint-race-second"), first)
    const prepared = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const stale = testJournal(dir, {
      async phase(phase) {
        if (phase !== "checkpoint-prepared") return
        prepared.resolve()
        await resume.promise
      },
    })

    const staleSave = stale.checkpoint?.save?.({ identity: "projection-v1", cursor: first, value: { state: 1 } })
    await prepared.promise
    await expect(
      journal.checkpoint?.save?.({ identity: "projection-v1", cursor: second, value: { state: 2 } }),
    ).resolves.toBe(true)
    resume.resolve()
    await expect(staleSave).resolves.toBe(false)
    await expect(journal.checkpoint?.load("projection-v1")).resolves.toMatchObject({ cursor: second })
  })

  it("gives read-only runtimes a load-only checkpoint and no logical authority mutation", async () => {
    const emptyDir = join(await directory(), "missing")
    const empty = testReadOnlyJournal(emptyDir)
    await expect(Array.fromAsync(empty.read())).resolves.toEqual([])
    expect(await missing(emptyDir)).toBe(true)
    expect(empty.checkpoint).toMatchObject({ load: expect.any(Function) })
    expect((empty.checkpoint as { save?: unknown }).save).toBeUndefined()

    const dir = await directory()
    const journal = testJournal(dir)
    const cursor = await accepted(journal, frame("read-only"), 0)
    await journal.checkpoint?.save?.({ identity: "read-only-v1", cursor, value: { state: 1 } })
    const before = await fileHash(join(dir, SQLITE))
    const walPath = join(dir, `${SQLITE}-wal`)
    const walBefore = await readFile(walPath)
    expect(walBefore).toHaveLength(0)
    const readOnly = testReadOnlyJournal(dir)
    await expect(readOnly.checkpoint?.load("read-only-v1")).resolves.toMatchObject({ cursor })
    await expect(Array.fromAsync(readOnly.read())).resolves.toEqual([{ cursor, values: [frame("read-only")] }])
    expect(await fileHash(join(dir, SQLITE))).toBe(before)
    expect(await readFile(walPath)).toEqual(walBefore)
    await expect(readOnly.append(frame("refused"), cursor)).rejects.toThrow("read-only journal cannot append")
  })

  it("atomically migrates v4 byte cursors and replay identity before allocating SQL cursors", async () => {
    const dir = await directory()
    const values = [frame("legacy-first"), frame("legacy-second")]
    const legacy = await writeV4Fixture(dir, values)
    const journal = testJournal(dir)

    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor: legacy.cursor, values }])
    const appended = await accepted(journal, frame("sql-third"), legacy.cursor)
    expect(appended).toBe(legacy.cursor + 1)

    using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(
      database
        .query<{ cursor: number }, []>("SELECT cursor FROM journal_events ORDER BY cursor")
        .all()
        .map(({ cursor }) => cursor),
    ).toEqual([...legacy.cursors, appended])
    expect(
      database.query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key='migration_complete'").get(),
    ).toEqual({ value: "1" })

    const files = await readdir(dir)
    const backup = files.find((path) => path.startsWith("journal-v4-pre-sqlite-"))
    expect(backup).toBeDefined()
    expect((await readdir(join(dir, backup!))).toSorted()).toEqual(legacy.paths.toSorted())

    expect(JSON.parse(await readFile(join(dir, MANIFEST), "utf8"))).toMatchObject({
      cutover: SQLITE,
      backup,
    })

    await appendFile(join(dir, legacy.paths[1]!), "legacy authority must stay retired\n")
    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([
      { cursor: appended, values: [...values, frame("sql-third")] },
    ])
  })

  it("migrates strict legacy archived-orphan rows without exposing them to live replay", async () => {
    const dir = await directory()
    const live = frame("legacy-live")
    const orphan = frame("legacy-orphan")
    const legacy = await writeV4Lines(dir, [v3Line(live), archivedOrphanLine(orphan)])
    const journal = testJournal(dir)

    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor: legacy.cursor, values: [live] }])
    await expect(readArchivedOrphans({ dir })).resolves.toMatchObject({
      cursor: legacy.cursor,
      records: [
        {
          kind: "archived-orphan",
          provenance: { "origin-row": orphan.command.id, "source-sha256": "1".repeat(64) },
          frame: orphan,
        },
      ],
    })
    const [, orphanCursor] = legacy.cursors
    if (orphanCursor === undefined) throw new Error("expected an orphan cursor")
    await expect(
      journal.checkpoint?.save?.({ identity: "orphan-gap-v1", cursor: orphanCursor, value: { state: 1 } }),
    ).resolves.toBe(true)
    await expect(Array.fromAsync(journal.read(legacy.cursors[0]!, orphanCursor - 1))).resolves.toEqual([])
    await expect(Array.fromAsync(journal.read(legacy.cursors[0]!, orphanCursor))).resolves.toEqual([
      { cursor: orphanCursor, values: [] },
    ])
  })

  it("refuses pending signed v4 recovery instead of bypassing its cutpoint contract", async () => {
    const dir = await directory()
    await writeV4Fixture(dir, [frame("pending-recovery")])
    const payload = {
      formatVersion: 4,
      kind: "compact",
      fromGeneration: 1,
      toGeneration: 2,
      previousManifest: await readFile(join(dir, MANIFEST), "utf8"),
      previousManifestDigest: exactDigest(await readFile(join(dir, MANIFEST))),
      sourceV3Path: null,
      rollbackPaths: ["events-v4.tail-pending.jsonl"],
      successPaths: [],
      verifyStart: 0,
      verifyEnd: 0,
      verifyFrames: 0,
      verifyDigest: exactDigest(Buffer.alloc(0)),
    }
    await writeFile(join(dir, RECOVERY), JSON.stringify({ ...payload, digest: digest(payload) }))

    await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow(/recovery.*before.*migration/iu)
    expect(await missing(join(dir, SQLITE))).toBe(true)
  })

  it("refuses a divergent v3 lane beside v4 authority", async () => {
    const dir = await directory()
    await writeV4Fixture(dir, [frame("divergent-v3")])
    await writeFile(join(dir, V3), v3Line(frame("second-authority")))

    await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow(/legacy v3.*v4|cutover/iu)
    expect(await missing(join(dir, SQLITE))).toBe(true)
  })

  it("keeps v4 authoritative when candidate verification is interrupted, then retries cleanly", async () => {
    const dir = await directory()
    const values = [frame("before-fault")]
    const legacy = await writeV4Fixture(dir, values)
    const manifestBefore = await fileHash(join(dir, MANIFEST))
    const interrupted = testJournal(dir, {
      async phase(phase) {
        if (phase === "migration-before-publish") throw new Error("injected-before-publish")
      },
    })

    await expect(Array.fromAsync(interrupted.read())).rejects.toThrow("injected-before-publish")
    expect(await missing(join(dir, SQLITE))).toBe(true)
    expect(await fileHash(join(dir, MANIFEST))).toBe(manifestBefore)
    expect((await readdir(dir)).some((path) => path.startsWith(".journal.sqlite-"))).toBe(false)
    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([{ cursor: legacy.cursor, values }])
  })

  it.each([
    ["migration-after-retire", false],
    ["migration-after-sqlite-rename", true],
  ] as const)(
    "recovers a hard process exit at %s without reviving the retired writer lane",
    async (phase, hasSqlite) => {
      const dir = await directory()
      const values = [frame(`hard-exit-${phase}`)]
      const legacy = await writeV4Fixture(dir, values)

      const crashed = await hardExitMigration(dir, phase)
      expect(crashed).toEqual({ code: 77, stderr: "" })
      expect(await missing(join(dir, SQLITE))).toBe(!hasSqlite)
      expect(JSON.parse(await readFile(join(dir, MANIFEST), "utf8"))).toMatchObject({
        cutover: SQLITE,
        state: "pre-publish",
      })

      await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([{ cursor: legacy.cursor, values }])
      expect(JSON.parse(await readFile(join(dir, MANIFEST), "utf8"))).toMatchObject({
        cutover: SQLITE,
        state: "published",
      })
      expect((await readdir(dir)).some((path) => path.startsWith(".journal.sqlite-"))).toBe(false)
    },
  )

  it("preserves the verified candidate when legacy-pointer rollback itself fails", async () => {
    const dir = await directory()
    const values = [frame("rollback-failure")]
    const legacy = await writeV4Fixture(dir, values)
    const interrupted = testJournal(dir, {
      async phase(phase) {
        if (phase !== "migration-after-retire") return
        const backup = (await readdir(dir)).find((path) => path.startsWith("journal-v4-pre-sqlite-"))
        if (backup === undefined) throw new Error("expected preservation backup")
        await rename(join(dir, backup, MANIFEST), join(dir, backup, `${MANIFEST}.unavailable`))
        throw new Error("injected-after-retire")
      },
    })

    await expect(Array.fromAsync(interrupted.read())).rejects.toThrow(
      /rollback|recovery source|injected-after-retire/iu,
    )
    const marker = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as { candidate: string; state: string }
    expect(marker.state).toBe("pre-publish")
    expect(await missing(join(dir, marker.candidate))).toBe(false)
    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([{ cursor: legacy.cursor, values }])
  })

  it("refuses a corrupt fingerprint-named preservation backup on migration retry", async () => {
    const dir = await directory()
    await writeV4Fixture(dir, [frame("corrupt-backup")])
    const interrupted = testJournal(dir, {
      async phase(phase) {
        if (phase === "migration-before-publish") throw new Error("injected-before-publish")
      },
    })
    await expect(Array.fromAsync(interrupted.read())).rejects.toThrow("injected-before-publish")
    const backup = (await readdir(dir)).find((path) => path.startsWith("journal-v4-pre-sqlite-"))
    if (backup === undefined) throw new Error("expected preserved legacy backup")
    await writeFile(join(dir, backup, MANIFEST), "corrupt preserved authority")

    await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow(/backup.*fingerprint|preserved.*backup/iu)
    expect(await missing(join(dir, SQLITE))).toBe(true)
  })

  it("refuses a signed v4 manifest whose declared ranges disagree with its segments", async () => {
    const dir = await directory()
    await writeV4Fixture(dir, [frame("inconsistent-manifest")])
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Record<string, unknown>
    const { digest: _observed, ...payload } = manifest
    await writeFile(
      join(dir, MANIFEST),
      JSON.stringify({ ...payload, logicalEnd: 1, digest: digest({ ...payload, logicalEnd: 1 }) }),
    )

    await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow("manifest ranges or frame counts")
    expect(await missing(join(dir, SQLITE))).toBe(true)
  })

  it("treats a published complete SQLite candidate as irrevocable after a post-rename interruption", async () => {
    const dir = await directory()
    const values = [frame("published")]
    const legacy = await writeV4Fixture(dir, values)
    const interrupted = testJournal(dir, {
      async phase(phase) {
        if (phase === "migration-after-publish") throw new Error("injected-after-publish")
      },
    })

    await expect(Array.fromAsync(interrupted.read())).rejects.toThrow("injected-after-publish")
    expect(await missing(join(dir, SQLITE))).toBe(false)
    await writeFile(join(dir, MANIFEST), "legacy is now corrupt")
    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([{ cursor: legacy.cursor, values }])
  })

  it("migrates a v3 journal directly and refuses read-only implicit migration", async () => {
    const legacyDir = await directory()
    const values = [frame("v3-first"), frame("v3-second")]
    const raw = values.map(v3Line).join("")
    await writeFile(join(legacyDir, V3), raw)

    await expect(Array.fromAsync(testReadOnlyJournal(legacyDir).read())).rejects.toThrow("migration is required")
    expect(await missing(join(legacyDir, SQLITE))).toBe(true)
    await expect(Array.fromAsync(testJournal(legacyDir).read())).resolves.toEqual([
      { cursor: Buffer.byteLength(raw), values },
    ])
  })

  it.each(["v4", "v3"] as const)(
    "never resurrects retired %s authority when a published SQLite file is later missing",
    async (legacyVersion) => {
      const dir = await directory()
      const legacyFrame = frame(`missing-published-${legacyVersion}`)
      if (legacyVersion === "v4") await writeV4Fixture(dir, [legacyFrame])
      else await writeFile(join(dir, V3), v3Line(legacyFrame))
      const journal = testJournal(dir)
      const replay = await Array.fromAsync(journal.read())
      const legacyCursor = replay[0]?.cursor
      if (legacyCursor === undefined) throw new Error("expected migrated cursor")
      await accepted(journal, frame(`sql-tail-${legacyVersion}`), legacyCursor)
      await rename(join(dir, SQLITE), join(dir, `${SQLITE}.preserved-for-test`))

      await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow(
        /published SQLite journal authority is missing.*refusing legacy resurrection/iu,
      )
      expect(JSON.parse(await readFile(join(dir, legacyVersion === "v4" ? MANIFEST : V3), "utf8"))).toMatchObject({
        cutover: SQLITE,
        state: "published",
      })
    },
  )

  it("binds a published cutover marker to its complete SQLite source fingerprint", async () => {
    const left = await directory()
    const right = await directory()
    await writeV4Fixture(left, [frame("fingerprint-left")])
    await writeV4Fixture(right, [frame("fingerprint-right")])
    await Array.fromAsync(testJournal(left).read())
    await Array.fromAsync(testJournal(right).read())
    await copyFile(join(right, SQLITE), join(left, SQLITE))

    await expect(Array.fromAsync(testJournal(left).read())).rejects.toThrow(/fingerprint.*cutover marker/iu)
  })

  it("recovers a valid committed v3 prefix while discarding an unacknowledged partial tail", async () => {
    const dir = await directory()
    const committed = v3Line(frame("committed-prefix"))
    await writeFile(join(dir, V3), `${committed}{"v":3,"partial":`)

    await expect(Array.fromAsync(testJournal(dir).read())).resolves.toEqual([
      { cursor: Buffer.byteLength(committed), values: [frame("committed-prefix")] },
    ])
  })

  it("fails incomplete SQLite authority loudly instead of resurrecting legacy files", async () => {
    const dir = await directory()
    await writeV4Fixture(dir, [frame("legacy")])
    await Array.fromAsync(testJournal(dir).read())
    using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
    database.query("UPDATE journal_metadata SET value='0' WHERE key='migration_complete'").run()

    await expect(Array.fromAsync(testJournal(dir).read())).rejects.toThrow("incomplete SQLite journal migration")
  })

  it("requires legacy migration before reporting archived-orphan audit state", async () => {
    const dir = await directory()
    await writeV4Lines(dir, [archivedOrphanLine(frame("legacy-audit-orphan"))])

    await expect(readArchivedOrphans({ dir })).rejects.toThrow("migration is required")
  })

  it("refuses unsupported mutable platforms before creating SQLite authority", async () => {
    const appendDir = await directory()
    const appendJournal = testJournal(appendDir, { platform: "win32" })
    await expect(appendJournal.append(frame("windows"), 0)).rejects.toThrow("unsupported platform win32")
    expect(await missing(join(appendDir, SQLITE))).toBe(true)

    const readDir = await directory()
    const readJournal = testJournal(readDir, { platform: "win32" })
    await expect(Array.fromAsync(readJournal.read())).rejects.toThrow("unsupported platform win32")
    expect(await missing(join(readDir, SQLITE))).toBe(true)
  })
})
