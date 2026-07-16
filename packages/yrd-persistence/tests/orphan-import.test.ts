/**
 * @failure Importing a preserved orphan journal can revive phantom domain state, duplicate live identities, or lose provenance.
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yrd-orphan-import-"))
  const dir = join(root, "journal")
  const sourcePath = join(root, "events-v3.orphan.jsonl")
  await mkdir(dir)
  return { root, dir, sourcePath }
}

async function authority(dir: string) {
  const manifest = JSON.parse(await readFile(join(dir, "events-v4.manifest.json"), "utf8")) as {
    tail: { path: string }
    tailState: { path: string }
  }
  return Promise.all([
    readFile(join(dir, "events-v4.manifest.json"), "base64"),
    readFile(join(dir, manifest.tail.path), "base64"),
    readFile(join(dir, manifest.tailState.path), "base64"),
  ])
}

describe("orphan journal import", () => {
  it("archives valid v3 rows in v4 without exposing them to live replay", async () => {
    const f = await fixture()
    try {
      const live = frame("live")
      const orphan = [frame("orphan-1"), frame("orphan-2")]
      const source = orphan.map(v3Line).join("")
      await writeFile(f.sourcePath, source)
      const liveCursor = await accepted(createJournal({ dir: f.dir }), live, 0)

      const imported = await importOrphanJournal({
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
      await expect(Array.fromAsync(createJournal({ dir: f.dir }).read())).resolves.toEqual([
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
              "imported-at": "2026-07-16T04:00:00.000Z",
              "imported-by": "@adhoc/0",
              "collision-policy": "refuse",
            },
            frame: { command: { id: orphan[1]!.command.id } },
          },
        ],
      })
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
      const cursor = await accepted(createJournal({ dir: f.dir }), live, 0)
      const before = await authority(f.dir)

      await expect(
        importOrphanJournal({
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
      const cursor = await accepted(createJournal({ dir: f.dir }), live, 0)
      const before = await authority(f.dir)

      await expect(
        importOrphanJournal({
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
        importOrphanJournal({
          dir: f.dir,
          sourcePath: f.sourcePath,
          importedBy: "@adhoc/0",
          importedAt: "2026-07-16T04:00:00.000Z",
        }),
      ).rejects.toThrow("checksum")
      await expect(Array.fromAsync(createJournal({ dir: f.dir }).read())).resolves.toEqual([])
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toEqual({ cursor: 0, records: [] })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("treats an exact source digest as an idempotent import", async () => {
    const f = await fixture()
    try {
      await writeFile(f.sourcePath, v3Line(frame("idempotent")))
      const options = {
        dir: f.dir,
        sourcePath: f.sourcePath,
        importedBy: "@adhoc/0",
        importedAt: "2026-07-16T04:00:00.000Z",
      }
      const first = await importOrphanJournal(options)
      const second = await importOrphanJournal(options)

      expect(first).toMatchObject({ status: "imported", records: 1 })
      expect(second).toEqual({
        status: "already-imported",
        cursor: first.cursor,
        records: 1,
        sourceSha256: first.sourceSha256,
      })
      await expect(readArchivedOrphans({ dir: f.dir })).resolves.toMatchObject({
        cursor: first.cursor,
        records: [{ provenance: { "origin-row": frame("idempotent").command.id } }],
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
