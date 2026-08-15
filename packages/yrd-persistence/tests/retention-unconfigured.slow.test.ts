/**
 * @failure An unconfigured journal evicts its own replay prefix once it grows past the companion frame cap.
 * @level l1
 * @consumer @yrd/persistence retention window
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CauseSchema, Command, EventSchema, type Cause, type Event } from "@yrd/core"
import { createJournal, type JournalOptions } from "@yrd/persistence"
import { afterEach, expect, it } from "vitest"

const SAFE_SQLITE = "3.53.0"

/**
 * One past the companion frame cap. Only a journal this size can tell an
 * unconfigured default apart from a 20,000-frame window, which is why this
 * drill is here and not in the fast suite: at any smaller size both defaults
 * keep every frame, so the assertion would pass without proving anything.
 */
const FRAMES = 20_001

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Deliberately tiny: 20,001 frames have to fit in a test, and only the COUNT matters here. */
function frame(key: string) {
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
    ts: "2026-08-14T12:00:00.000Z",
    data: { text: "x" },
  })
  return { cause, command, events: [applied] }
}

function testJournal(dir: string, options: Partial<JournalOptions> = {}) {
  return createJournal({
    dir,
    ...options,
    inject: { sqliteVersion: SAFE_SQLITE },
  } as unknown as Parameters<typeof createJournal>[0])
}

it("keeps every frame of a journal past the companion cap when nothing configures retention", async () => {
  const saved = {
    frames: process.env.YRD_JOURNAL_KEEP_FRAMES,
    days: process.env.YRD_JOURNAL_KEEP_DAYS,
    // Cleared too, or an ambient off switch would make this pass by disarming
    // retention explicitly rather than by leaving it unarmed.
    retention: process.env.YRD_JOURNAL_RETENTION,
  }
  delete process.env.YRD_JOURNAL_KEEP_FRAMES
  delete process.env.YRD_JOURNAL_KEEP_DAYS
  delete process.env.YRD_JOURNAL_RETENTION
  try {
    const root = await mkdtemp(join(tmpdir(), "yrd-retention-unconfigured-"))
    roots.push(root)
    const journal = testJournal(root)

    let cursor = 0
    for (let index = 0; index < FRAMES; index += 1) {
      const appended = await journal.append(frame(`unconfigured-${String(index)}`), cursor)
      expect(appended.appended).toBe(true)
      cursor = appended.cursor
    }
    expect(cursor).toBe(FRAMES)

    // Repeated saves at the same head: each one runs the maintenance pass
    // that eviction rides on, so a window that binds gets every chance to.
    for (let round = 0; round < 4; round += 1) {
      await journal.checkpoint?.save?.({
        identity: `unconfigured-${String(round)}`,
        cursor,
        value: { round },
      })
    }

    using database = new Database(join(root, "journal.sqlite"), { readonly: true, strict: true })
    const span = database
      .query<{ n: number; low: number | null; high: number | null }, []>(
        "SELECT COUNT(*) AS n, MIN(cursor) AS low, MAX(cursor) AS high FROM journal_history",
      )
      .get()
    // The whole 1..head span, so a full replay from cursor 0 still resolves.
    expect(span).toEqual({ n: FRAMES, low: 1, high: FRAMES })

    const floor = database
      .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
      .get("history_evicted_through")
    // Absent, not zero: nothing ever advanced the floor.
    expect(floor).toBeNull()
  } finally {
    if (saved.frames === undefined) delete process.env.YRD_JOURNAL_KEEP_FRAMES
    else process.env.YRD_JOURNAL_KEEP_FRAMES = saved.frames
    if (saved.days === undefined) delete process.env.YRD_JOURNAL_KEEP_DAYS
    else process.env.YRD_JOURNAL_KEEP_DAYS = saved.days
    if (saved.retention === undefined) delete process.env.YRD_JOURNAL_RETENTION
    else process.env.YRD_JOURNAL_RETENTION = saved.retention
  }
}, 600_000)
