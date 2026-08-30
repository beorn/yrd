/**
 * @failure An ordinary schema-version spread across the fleet's checkouts blocks every journal verb at once, or a reader silently reads around a journal it should have migrated.
 * @level l1
 * @consumer @yrd/persistence
 *
 * Two incidents paid for these rows. 2026-07-17: three yrd source versions were
 * live at once and delivery stopped fleet-wide. 2026-08-17, at larger scale:
 * FOUR live versions, and `pr submit` refused from every tree — a finished,
 * pushed, tracked change could not be submitted by anyone, because a reader one
 * schema behind threw at journal open and every verb opens the journal.
 *
 * The asymmetry under test is the whole design. A reader BEHIND the journal
 * degrades and keeps working; a reader AHEAD of the journal still refuses.
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CauseSchema, Command, EventSchema, type Cause, type Event, type Journal } from "@yrd/core"
import { classifyJournalSchema, createJournal, createReadOnlyJournal, type JournalSchemaSkew } from "@yrd/persistence"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, it } from "vitest"

const SQLITE = "journal.sqlite"
const SAFE_SQLITE = "3.53.0"

/** What this reader compiles against. The fixtures below sit one step either side of it. */
const COMPILED = 2

type TestInject = Readonly<{ log?: ConditionalLogger; sqliteVersion?: string }>

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

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-schema-skew-"))
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

async function seeded(dir: string, key = "seed"): Promise<void> {
  const result = await testJournal(dir).append(frame(key), 0)
  if (!result.appended) throw new Error("fixture could not seed its first frame")
}

/**
 * What a future migration does to a journal this reader will then meet: it adds
 * structure and stamps the new version. Additive is the realistic shape — every
 * column this reader compiled against survives, which is exactly why an older
 * reader can still do useful work against it.
 */
function advanceFixtureOneSchemaAhead(dir: string): void {
  using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
  database.run("ALTER TABLE journal_snapshot ADD COLUMN future_note TEXT")
  database.query("UPDATE journal_metadata SET value = ? WHERE key = 'schema_version'").run(String(COMPILED + 1))
  database.run(`PRAGMA user_version = ${COMPILED + 1}`)
}

/**
 * A journal one schema BEHIND this reader. Only the recorded version moves: the
 * refusal keys on that alone, and the mutable path would migrate a v1 journal
 * rather than meet it, so the read-only reader — which holds no migration
 * authority — is where this direction is observable at all.
 */
function retreatFixtureOneSchemaBehind(dir: string): void {
  using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
  database.run(`PRAGMA user_version = ${COMPILED - 1}`)
}

describe("journal schema skew", () => {
  it("classifies a compiled/found pair once, for every open site to consult", () => {
    expect(classifyJournalSchema(2, 2)).toEqual({ kind: "same", compiled: 2, found: 2 })
    expect(classifyJournalSchema(2, 3)).toEqual({ kind: "reader-behind", compiled: 2, found: 3 })
    expect(classifyJournalSchema(2, 9)).toEqual({ kind: "reader-behind", compiled: 2, found: 9 })
    expect(classifyJournalSchema(2, 1)).toEqual({ kind: "journal-behind", compiled: 2, found: 1 })
    expect(classifyJournalSchema(2, 0)).toEqual({ kind: "journal-behind", compiled: 2, found: 0 })
    expect(classifyJournalSchema(2, undefined)).toEqual({ kind: "unreadable", compiled: 2 })
  })

  it("types the classification so a consumer must handle every direction", () => {
    const describeSkew = (skew: JournalSchemaSkew): string => {
      switch (skew.kind) {
        case "same":
          return "same"
        case "reader-behind":
          return `behind by ${skew.found - skew.compiled}`
        case "journal-behind":
          return `ahead by ${skew.compiled - skew.found}`
        case "unreadable":
          return "unreadable"
      }
    }
    expect(describeSkew(classifyJournalSchema(2, 4))).toBe("behind by 2")
    expect(describeSkew(classifyJournalSchema(2, 1))).toBe("ahead by 1")
  })

  it("degrades instead of throwing when the journal is one schema ahead of this reader", async () => {
    const dir = await directory()
    await seeded(dir, "written-before-the-migration")
    advanceFixtureOneSchemaAhead(dir)

    const batches = await Array.fromAsync(testJournal(dir).read())
    expect(batches.flatMap((batch) => batch.values)).toMatchObject([
      { events: [{ name: "test/recorded", data: { text: "hello" } }] },
    ])
  })

  it("still appends to a journal one schema ahead, so submit is not blocked fleet-wide", async () => {
    const dir = await directory()
    await seeded(dir, "before")
    advanceFixtureOneSchemaAhead(dir)

    await expect(testJournal(dir).append(frame("after"), 1)).resolves.toMatchObject({ appended: true, cursor: 2 })

    using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: COMPILED + 1,
    })
  })

  it("says out loud that it is reading a newer journal, so the skew is never silent", async () => {
    const dir = await directory()
    await seeded(dir)
    advanceFixtureOneSchemaAhead(dir)

    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await Array.fromAsync(testJournal(dir, { log }).read())

    expect(
      events.filter(
        (event) =>
          event.kind === "log" &&
          typeof event.message === "string" &&
          event.message.includes(`v${COMPILED + 1}`) &&
          event.message.includes(`v${COMPILED}`),
      ),
    ).not.toHaveLength(0)
  })

  it("still refuses a journal one schema behind this reader, naming both versions", async () => {
    const dir = await directory()
    await seeded(dir)
    retreatFixtureOneSchemaBehind(dir)

    await expect(Array.fromAsync(testReadOnlyJournal(dir).read())).rejects.toThrow(
      new RegExp(
        `unsupported or incomplete SQLite journal schema.*v${COMPILED - 1}.*compiled against v${COMPILED}.*migrate`,
        "su",
      ),
    )
  })
})
