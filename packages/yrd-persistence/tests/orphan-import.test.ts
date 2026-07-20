/**
 * @failure Importing a preserved orphan journal can revive phantom domain state, duplicate live identities, or lose provenance.
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CauseSchema, Command, EventSchema, type Cause, type Event, type Journal } from "@yrd/core"
import { createJournal, importOrphanJournal, readArchivedOrphans } from "@yrd/persistence"
import canonicalize from "canonicalize"
import { describe, expect, it } from "vitest"

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function frame(key: string, payloadKey = key) {
  const command = Command.parse({ id: uuid(`command:${key}`), op: "test.record" })
  const cause: Cause = CauseSchema.parse({
    id: uuid(`cause:${key}`),
    commandId: command.id,
    op: command.op,
    commandHash: Command.hash(command),
  })
  const event: Event = EventSchema.parse({
    id: uuid(`event:${key}`),
    name: "test/recorded",
    ts: "2026-07-09T12:00:00.000Z",
    data: { key: payloadKey },
  })
  return { cause, command, events: [event] }
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

async function accepted(journal: Journal<unknown>, value: ReturnType<typeof frame>, cursor: number): Promise<number> {
  const result = await journal.append(value, cursor)
  if (!result.appended) throw new Error(`expected append at ${cursor}, observed ${result.cursor}`)
  return result.cursor
}

function journal(dir: string): Journal<unknown> {
  return createJournal({ dir, inject: { sqliteVersion: "3.53.0" } } as unknown as Parameters<typeof createJournal>[0])
}

function importOrphans(options: Parameters<typeof importOrphanJournal>[0]) {
  return importOrphanJournal({
    ...options,
    inject: { sqliteVersion: "3.53.0" },
  } as unknown as Parameters<typeof importOrphanJournal>[0])
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yrd-orphan-import-"))
  const dir = join(root, "journal")
  const sourcePath = join(root, "events-v3.orphan.jsonl")
  await mkdir(dir)
  return { root, dir, sourcePath }
}

async function authority(dir: string) {
  return readFile(join(dir, "journal.sqlite"), "base64")
}

describe("orphan journal import", () => {
  it("archives valid v3 rows in SQLite without exposing them to live replay", async () => {
    const f = await fixture()
    try {
      const live = frame("live")
      const orphan = [frame("orphan-1"), frame("orphan-2")]
      const source = orphan.map(v3Line).join("")
      await writeFile(f.sourcePath, source)
      const liveCursor = await accepted(journal(f.dir), live, 0)

      const imported = await importOrphans({
        dir: f.dir,
        sourcePath: f.sourcePath,
        importedBy: "@adhoc/0",
        importedAt: "2026-07-16T04:00:00.000Z",
      })

      expect(imported).toMatchObject({
        status: "imported",
        records: 2,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      })
      expect(imported.cursor).toBeGreaterThan(liveCursor)
      await expect(Array.fromAsync(journal(f.dir).read())).resolves.toEqual([
        { cursor: imported.cursor, values: [live] },
      ])
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toMatchObject({
        cursor: imported.cursor,
        records: [
          {
            kind: "archived-orphan",
            provenance: {
              "origin-lane": "v3-phantom",
              "origin-file": f.sourcePath,
              "origin-row": orphan[0]!.command.id,
              "source-sha256": imported.sourceSha256,
              "imported-at": "2026-07-16T04:00:00.000Z",
              "imported-by": "@adhoc/0",
              "collision-policy": "refuse",
            },
            frame: { command: { id: orphan[0]!.command.id } },
          },
          {
            kind: "archived-orphan",
            provenance: {
              "origin-lane": "v3-phantom",
              "origin-file": f.sourcePath,
              "origin-row": orphan[1]!.command.id,
              "source-sha256": imported.sourceSha256,
              "imported-at": "2026-07-16T04:00:00.000Z",
              "imported-by": "@adhoc/0",
              "collision-policy": "refuse",
            },
            frame: { command: { id: orphan[1]!.command.id } },
          },
        ],
      })
      const checkpoint = { identity: "test/archive-aware-v1", cursor: imported.cursor, value: { live: 1 } }
      await expect(journal(f.dir).checkpoint?.save?.(checkpoint)).resolves.toBe(true)
      await expect(journal(f.dir).checkpoint?.load(checkpoint.identity)).resolves.toEqual(checkpoint)
      await expect(readFile(f.sourcePath, "utf8")).resolves.toBe(source)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("refuses a live identity collision before authoritative bytes change", async () => {
    const f = await fixture()
    try {
      const live = frame("collision")
      await writeFile(f.sourcePath, v3Line(live))
      const cursor = await accepted(journal(f.dir), live, 0)
      const before = await authority(f.dir)

      await expect(
        importOrphans({
          dir: f.dir,
          sourcePath: f.sourcePath,
          importedBy: "@adhoc/0",
          importedAt: "2026-07-16T04:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        status: "live-collision",
        cursor,
        collisions: expect.arrayContaining([
          { kind: "cause", id: live.cause.id },
          { kind: "command", id: live.command.id },
          { kind: "event", id: live.events[0]!.id },
          { kind: "payload", id: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        ]),
      })
      await expect(authority(f.dir)).resolves.toEqual(before)
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toEqual({ cursor, records: [] })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("refuses matching live payload identity even when every UUID differs", async () => {
    const f = await fixture()
    try {
      const live = frame("live-identity", "same-payload")
      const orphan = frame("orphan-identity", "same-payload")
      await writeFile(f.sourcePath, v3Line(orphan))
      const cursor = await accepted(journal(f.dir), live, 0)
      const before = await authority(f.dir)

      await expect(
        importOrphans({
          dir: f.dir,
          sourcePath: f.sourcePath,
          importedBy: "@adhoc/0",
          importedAt: "2026-07-16T04:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        status: "live-collision",
        cursor,
        collisions: [{ kind: "payload", id: expect.stringMatching(/^[0-9a-f]{64}$/u) }],
      })
      await expect(authority(f.dir)).resolves.toEqual(before)
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toEqual({ cursor, records: [] })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("rejects checksum drift without creating journal authority", async () => {
    const f = await fixture()
    try {
      const stored = JSON.parse(v3Line(frame("tampered"))) as { checksum: string }
      stored.checksum = "0".repeat(64)
      await writeFile(f.sourcePath, `${JSON.stringify(stored)}\n`)

      await expect(
        importOrphans({
          dir: f.dir,
          sourcePath: f.sourcePath,
          importedBy: "@adhoc/0",
          importedAt: "2026-07-16T04:00:00.000Z",
        }),
      ).rejects.toThrow("checksum")
      await expect(Array.fromAsync(journal(f.dir).read())).resolves.toEqual([])
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toEqual({ cursor: 0, records: [] })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("treats an exact source digest as an idempotent import", async () => {
    const f = await fixture()
    try {
      const orphan = frame("idempotent")
      await writeFile(f.sourcePath, v3Line(orphan))
      const options = {
        dir: f.dir,
        sourcePath: f.sourcePath,
        importedBy: "@adhoc/0",
      }
      const first = await importOrphans(options)
      const second = await importOrphans(options)
      const relocatedSource = join(f.root, "relocated-events-v3.orphan.jsonl")
      await writeFile(relocatedSource, await readFile(f.sourcePath))
      const relocated = await importOrphans({ ...options, sourcePath: relocatedSource })

      expect(first).toMatchObject({ status: "imported", records: 1 })
      expect(second).toEqual({
        status: "already-imported",
        cursor: first.cursor,
        records: 1,
        sourceSha256: first.sourceSha256,
      })
      expect(relocated).toEqual(second)
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toMatchObject({
        cursor: first.cursor,
        records: [{ provenance: { "origin-row": orphan.command.id } }],
      })
      await accepted(journal(f.dir), orphan, first.cursor)
      await expect(importOrphans(options)).resolves.toMatchObject({
        status: "live-collision",
        collisions: expect.arrayContaining([{ kind: "command", id: orphan.command.id }]),
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("rejects duplicate identities inside one orphan source before creating authority", async () => {
    const f = await fixture()
    try {
      const duplicate = frame("duplicate-source-identity")
      await writeFile(f.sourcePath, `${v3Line(duplicate)}${v3Line(duplicate)}`)

      await expect(importOrphans({ dir: f.dir, sourcePath: f.sourcePath, importedBy: "@adhoc/0" })).rejects.toThrow(
        "duplicate identity",
      )
      await expect(readFile(join(f.dir, "journal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("rejects duplicate semantic payloads inside one orphan source", async () => {
    const f = await fixture()
    try {
      const first = frame("duplicate-payload-first", "same-source-payload")
      const second = frame("duplicate-payload-second", "same-source-payload")
      await writeFile(f.sourcePath, `${v3Line(first)}${v3Line(second)}`)

      await expect(importOrphans({ dir: f.dir, sourcePath: f.sourcePath, importedBy: "@adhoc/0" })).rejects.toThrow(
        "duplicate payload",
      )
      await expect(readFile(join(f.dir, "journal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("binds archived-orphan checksums to exact stored JSON bytes", async () => {
    const f = await fixture()
    try {
      await writeFile(f.sourcePath, v3Line(frame("exact-orphan-bytes")))
      await importOrphans({ dir: f.dir, sourcePath: f.sourcePath, importedBy: "@adhoc/0" })
      {
        using database = new Database(join(f.dir, "journal.sqlite"), { readwrite: true, strict: true })
        database.query("UPDATE journal_orphans SET record_json = record_json || ' '").run()
      }

      await expect(readArchivedOrphans({ dir: f.dir })).rejects.toThrow("archived orphan checksum mismatch")
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
