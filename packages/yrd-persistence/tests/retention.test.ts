/**
 * @failure An unconfigured journal deletes history nobody asked it to delete, or a configured window silently truncates a reader's replay or an entity's frame slice.
 * @level l1
 * @consumer @yrd/persistence retention window
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CauseSchema, Command, EventSchema, failureFact, type Cause, type Event, type Journal } from "@yrd/core"
import {
  createJournal,
  createReadOnlyJournal,
  resolveRetention,
  type JournalOptions,
  type MutableJournal,
} from "@yrd/persistence"
import { createLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, it } from "vitest"

const SAFE_SQLITE = "3.53.0"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-retention-"))
  roots.push(root)
  return root
}

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A frame whose payload is large enough that one frame occupies about one page. */
function frame(key: string, options: Readonly<{ ts?: string; run?: string; bytes?: number }> = {}) {
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
    ts: options.ts ?? "2026-08-14T12:00:00.000Z",
    data: {
      text: "x".repeat(options.bytes ?? 3800),
      ...(options.run === undefined ? {} : { run: options.run }),
    },
  })
  return { cause, command, events: [applied] }
}

function testJournal(dir: string, options: Partial<JournalOptions> = {}, log?: ReturnType<typeof createLogger>) {
  return createJournal({
    dir,
    ...options,
    inject: { sqliteVersion: SAFE_SQLITE, ...(log === undefined ? {} : { log }) },
  } as unknown as Parameters<typeof createJournal>[0])
}

function stats(
  dir: string,
): Readonly<{ pages: number; history: number; evictedThrough: number; evictedThroughRow: string | null }> {
  using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
  const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0
  const history = database.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM journal_history").get()?.n ?? 0
  const evicted = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get("history_evicted_through")
  return {
    pages,
    history,
    evictedThrough: evicted === null ? 0 : Number(evicted.value),
    evictedThroughRow: evicted === null ? null : evicted.value,
  }
}

/** Every cursor history holds, so "nothing was deleted" can be checked as a span rather than a count. */
function historyCursors(dir: string): number[] {
  using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
  return database
    .query<{ cursor: number }, []>("SELECT cursor FROM journal_history ORDER BY cursor")
    .all()
    .map((row) => row.cursor)
}

async function appendAll(journal: Journal<unknown>, frames: readonly ReturnType<typeof frame>[]): Promise<number> {
  let cursor = 0
  for (const value of frames) {
    const appended = await journal.append(value, cursor)
    expect(appended.appended).toBe(true)
    cursor = appended.cursor
  }
  return cursor
}

async function drainCursors(journal: Journal<unknown>, after = 0): Promise<number[]> {
  const cursors: number[] = []
  for await (const batch of journal.read(after)) cursors.push(batch.cursor)
  return cursors
}

/** Runs the identical workload twice so the page-count comparison isolates eviction from checkpoint archiving. */
async function workload(
  retention: JournalOptions["retention"],
  frames: readonly ReturnType<typeof frame>[],
  rounds = 4,
): Promise<Readonly<{ dir: string; pages: number; history: number; evictedThrough: number }>> {
  const dir = await directory()
  const journal = testJournal(dir, { retention })
  const head = await appendAll(journal, frames)
  // Repeated checkpoints at the same head: each one runs the exclusive-lock
  // maintenance pass, so incremental_vacuum(256) can walk the whole freelist.
  for (let round = 0; round < rounds; round += 1) {
    await journal.checkpoint?.save?.({ identity: `identity-${String(round)}`, cursor: head, value: { round } })
  }
  return { dir, ...stats(dir) }
}

/**
 * Pins the arming contract directly. The journal-level tests below cannot reach
 * every case: proving what an ARMED default-sized window does needs a fixture
 * past 20,000 frames, which lives in `retention-unconfigured.slow.test.ts`.
 */
describe("retention arming contract", () => {
  const saved = {
    frames: process.env.YRD_JOURNAL_KEEP_FRAMES,
    days: process.env.YRD_JOURNAL_KEEP_DAYS,
    retention: process.env.YRD_JOURNAL_RETENTION,
  }

  function withEnv<Result>(
    env: Readonly<{ frames?: string; days?: string; retention?: string }>,
    operation: () => Result,
  ): Result {
    if (env.frames === undefined) delete process.env.YRD_JOURNAL_KEEP_FRAMES
    else process.env.YRD_JOURNAL_KEEP_FRAMES = env.frames
    if (env.days === undefined) delete process.env.YRD_JOURNAL_KEEP_DAYS
    else process.env.YRD_JOURNAL_KEEP_DAYS = env.days
    if (env.retention === undefined) delete process.env.YRD_JOURNAL_RETENTION
    else process.env.YRD_JOURNAL_RETENTION = env.retention
    try {
      return operation()
    } finally {
      if (saved.frames === undefined) delete process.env.YRD_JOURNAL_KEEP_FRAMES
      else process.env.YRD_JOURNAL_KEEP_FRAMES = saved.frames
      if (saved.days === undefined) delete process.env.YRD_JOURNAL_KEEP_DAYS
      else process.env.YRD_JOURNAL_KEEP_DAYS = saved.days
      if (saved.retention === undefined) delete process.env.YRD_JOURNAL_RETENTION
      else process.env.YRD_JOURNAL_RETENTION = saved.retention
    }
  }

  it("stays disabled when nothing configures it", () => {
    // The fail-safe, and the whole point of the knob. An unconfigured journal is
    // the live one, so anything but "disabled" here means the fleet is evicting
    // its own replay prefix again — which is how delivery stopped once already,
    // when an identity change demanded a replay from 0 and the prefix was gone.
    expect(withEnv({}, () => resolveRetention(undefined))).toBe("disabled")
  })

  it("stays disabled for a retention object that names no window", () => {
    // `{}` asks for retention without asking for a bound. Reading that as the
    // companion frame cap would arm eviction on a caller who named nothing.
    expect(withEnv({}, () => resolveRetention({}))).toBe("disabled")
  })

  it("stays disabled when an environment knob is present but empty", () => {
    expect(withEnv({ frames: "" }, () => resolveRetention(undefined))).toBe("disabled")
    expect(withEnv({ days: "  " }, () => resolveRetention(undefined))).toBe("disabled")
  })

  it("stays disabled when a caller asks for it explicitly", () => {
    expect(withEnv({ frames: "500" }, () => resolveRetention("disabled"))).toBe("disabled")
  })

  it("stays disabled when the operator turns it off from the environment", () => {
    expect(withEnv({ retention: "disabled" }, () => resolveRetention(undefined))).toBe("disabled")
    // Its remaining job now that unset already means off: disarming a window
    // the environment armed, without editing the environment a fleet shares.
    expect(withEnv({ retention: "disabled", frames: "500" }, () => resolveRetention(undefined))).toBe("disabled")
    // An explicit config still wins, so one journal can keep its window.
    expect(withEnv({ retention: "disabled" }, () => resolveRetention({ keepFrames: 500 }))).toEqual({ keepFrames: 500 })
  })

  it("arms on an explicit config, and keeps the age window off unless asked", () => {
    expect(withEnv({}, () => resolveRetention({ keepFrames: 500 }))).toEqual({ keepFrames: 500 })
    expect(withEnv({}, () => resolveRetention({ keepFrames: 500, keepDays: 7 }))).toEqual({
      keepFrames: 500,
      keepDays: 7,
    })
  })

  it("arms on either environment knob alone, filling in the axis left unset", () => {
    expect(withEnv({ frames: "500" }, () => resolveRetention(undefined))).toEqual({ keepFrames: 500 })
    // keepDays alone still arms; the frame axis takes the companion cap, since
    // naming one window means the operator asked for a bounded journal.
    expect(withEnv({ days: "7" }, () => resolveRetention(undefined))).toEqual({ keepFrames: 20_000, keepDays: 7 })
    expect(withEnv({}, () => resolveRetention({ keepDays: 7 }))).toEqual({ keepFrames: 20_000, keepDays: 7 })
  })

  it("prefers an explicit config over the environment", () => {
    expect(withEnv({ frames: "500" }, () => resolveRetention({ keepFrames: 9 }))).toEqual({ keepFrames: 9 })
  })

  it("raises on a malformed value instead of quietly using the default", () => {
    // The silent-default failure this prevents: an operator reads a window into
    // force that was never in force.
    expect(() => withEnv({ frames: "lots" }, () => resolveRetention(undefined))).toThrow(/YRD_JOURNAL_KEEP_FRAMES/u)
    expect(() => withEnv({ frames: "0" }, () => resolveRetention(undefined))).toThrow(/positive safe integer/u)
    expect(() => withEnv({ frames: "-5" }, () => resolveRetention(undefined))).toThrow(/positive safe integer/u)
    expect(() => withEnv({ frames: "1.5" }, () => resolveRetention(undefined))).toThrow(/positive safe integer/u)
    expect(() => withEnv({ days: "soon" }, () => resolveRetention(undefined))).toThrow(/YRD_JOURNAL_KEEP_DAYS/u)
    expect(() => withEnv({}, () => resolveRetention({ keepFrames: 0 }))).toThrow(/keepFrames/u)
  })

  it("exposes the exact resolved policy only from the mutable journal that owns it", async () => {
    const dir = await directory()
    withEnv({ frames: "500" }, () => {
      const mutable = testJournal(dir) as MutableJournal

      expect(mutable.retention).toEqual({ keepFrames: 500 })
      expect(createReadOnlyJournal({ dir })).not.toHaveProperty("retention")
    })
  })
})

describe("journal retention window", () => {
  it("reports the durable floor and actual oldest retained cursor without inventing density", async () => {
    const dir = await directory()
    const journal = testJournal(dir, { retention: { keepFrames: 1 } })
    const head = await appendAll(journal, [frame("floor-1"), frame("floor-2"), frame("floor-3")])
    await journal.checkpoint?.save?.({ identity: "floor", cursor: head, value: {} })

    expect(journal.history?.diagnostics()).toMatchObject({
      evictedThrough: 2,
      oldestRetainedCursor: 3,
      historyFrames: 1,
      tailFrames: 0,
    })
  })

  it("raises a typed refusal when the retained floor metadata is malformed", async () => {
    const dir = await directory()
    const journal = testJournal(dir)
    const head = await appendAll(journal, [frame("malformed-floor")])
    await journal.checkpoint?.save?.({ identity: "floor", cursor: head, value: {} })
    using database = new Database(join(dir, "journal.sqlite"), { strict: true })
    database
      .query("INSERT OR REPLACE INTO journal_metadata(key, value) VALUES (?, ?)")
      .run("history_evicted_through", "not-a-cursor")

    let caught: unknown
    try {
      journal.history?.diagnostics()
    } catch (error) {
      caught = error
    }
    expect(failureFact(caught)).toMatchObject({
      kind: "infrastructure",
      code: "journal-retention-floor-invalid",
    })
  })

  it("deletes nothing from an unconfigured journal, and never records an eviction floor", async () => {
    // Retention is off unless armed, so repeated checkpoints leave the whole
    // 1..head span intact and `history_evicted_through` is never written at all
    // — absent, not merely zero, which is what a full replay from 0 needs.
    //
    // This size is affordable for the fast suite but cannot discriminate the
    // default's VALUE on its own: 120 frames also survive a 20,000-frame
    // window. `retention-unconfigured.slow.test.ts` carries the fixture past
    // 20,000 that does discriminate it; the arming contract above pins it
    // directly and cheaply.
    const keepFrames = process.env.YRD_JOURNAL_KEEP_FRAMES
    const keepDays = process.env.YRD_JOURNAL_KEEP_DAYS
    // The off switch has to go too, or an ambient one would make this pass by
    // disarming retention explicitly rather than by leaving it unarmed.
    const off = process.env.YRD_JOURNAL_RETENTION
    delete process.env.YRD_JOURNAL_KEEP_FRAMES
    delete process.env.YRD_JOURNAL_KEEP_DAYS
    delete process.env.YRD_JOURNAL_RETENTION
    try {
      const frames = Array.from({ length: 120 }, (_, index) => frame(`unconfigured-${String(index)}`))
      const dir = await directory()
      const journal = testJournal(dir)
      const head = await appendAll(journal, frames)
      for (let round = 0; round < 4; round += 1) {
        await journal.checkpoint?.save?.({ identity: `unconfigured-${String(round)}`, cursor: head, value: { round } })
      }

      expect(stats(dir)).toMatchObject({ history: 120, evictedThroughRow: null })
      expect(historyCursors(dir)).toEqual(Array.from({ length: head }, (_, index) => index + 1))
      expect((await drainCursors(journal, 0)).at(-1)).toBe(120)
    } finally {
      if (keepFrames !== undefined) process.env.YRD_JOURNAL_KEEP_FRAMES = keepFrames
      if (keepDays !== undefined) process.env.YRD_JOURNAL_KEEP_DAYS = keepDays
      if (off !== undefined) process.env.YRD_JOURNAL_RETENTION = off
    }
  })

  it("arms retention from the environment alone, with nothing passed to createJournal", async () => {
    // The contrast that gives the test above its meaning: same construction,
    // no retention argument, and the only difference is the env knob.
    const previous = process.env.YRD_JOURNAL_KEEP_DAYS
    process.env.YRD_JOURNAL_KEEP_DAYS = "14"
    try {
      const frames = Array.from({ length: 50 }, (_, index) =>
        frame(`env-armed-${String(index)}`, { ts: "2026-07-01T00:00:00.000Z" }),
      )
      const dir = await directory()
      const journal = testJournal(dir)
      const head = await appendAll(journal, frames)
      await journal.checkpoint?.save?.({ identity: "env-armed", cursor: head, value: {} })

      expect(stats(dir).evictedThrough).toBe(49)
    } finally {
      if (previous === undefined) delete process.env.YRD_JOURNAL_KEEP_DAYS
      else process.env.YRD_JOURNAL_KEEP_DAYS = previous
    }
  })

  // Large replay: two full 300-frame journal workloads (bounded + unbounded)
  // built and paged through a real SQLite journal. Isolated measured cost
  // (2026-08-30): ~0.7-0.75s. Budget below was set in 9319a804 after this
  // crossed the bare 5s vitest default 4 of 7 runs on main itself under
  // ordinary fleet load (load average ~30) — a false-red gate on the
  // instrument, not the change. 30s is >5x the worst measured cost and
  // follows this repo's trailing-arg precedent (22 other files).
  it("drops history past the window and gives the pages back", async () => {
    const frames = Array.from({ length: 300 }, (_, index) => frame(`bounded-${String(index)}`))

    const unbounded = await workload("disabled", frames)
    const bounded = await workload({ keepFrames: 50 }, frames)

    // Frame count falls: only the window (plus the retained snapshot boundary) survives.
    expect(unbounded.history).toBe(300)
    expect(bounded.history).toBeLessThanOrEqual(51)
    expect(bounded.evictedThrough).toBeGreaterThan(200)

    // Page count falls against the SAME workload without eviction, so the drop
    // cannot be credited to checkpoint archiving or to the pre-existing vacuum.
    expect(bounded.pages).toBeLessThan(unbounded.pages)
  }, 30_000)

  it("evicts by age when the frame window alone would keep everything", async () => {
    const old = Array.from({ length: 40 }, (_, index) =>
      frame(`aged-old-${String(index)}`, { ts: "2026-07-01T00:00:00.000Z" }),
    )
    const fresh = Array.from({ length: 10 }, (_, index) =>
      frame(`aged-fresh-${String(index)}`, { ts: new Date().toISOString() }),
    )

    const bounded = await workload({ keepFrames: 10_000, keepDays: 14 }, [...old, ...fresh])

    expect(bounded.history).toBe(10)
    expect(bounded.evictedThrough).toBe(40)
  })

  it("refuses a replay that starts inside the evicted range instead of serving a short history", async () => {
    const frames = Array.from({ length: 120 }, (_, index) => frame(`refuse-${String(index)}`))
    const { dir, evictedThrough } = await workload({ keepFrames: 20 }, frames)
    expect(evictedThrough).toBeGreaterThan(0)

    const reader = testJournal(dir, { retention: { keepFrames: 20 } })

    // A full replay from 0 is exactly the silent-truncation case: it must raise.
    await expect(drainCursors(reader, 0)).rejects.toThrow(/evicted/iu)

    // Reading from the first retained frame still works.
    const cursors = await drainCursors(reader, evictedThrough)
    expect(cursors.at(-1)).toBe(120)
  })

  it("keeps every frame of an entity that survives the window (never a partial slice)", async () => {
    // A run touched at the very start and again at the very end: the early
    // frames sit far past the window, but evicting them would leave
    // history.entity("queue", …) returning a partial — silently wrong — slice.
    const frames = [
      ...Array.from({ length: 5 }, (_, index) => frame(`span-early-${String(index)}`, { run: "R-longlived" })),
      ...Array.from({ length: 200 }, (_, index) => frame(`span-filler-${String(index)}`)),
      frame("span-late", { run: "R-longlived" }),
    ]

    const { dir } = await workload({ keepFrames: 20 }, frames)

    using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
    const slice = database
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM journal_entities WHERE kind = 'queue' AND id = ?")
      .all("R-longlived")
    expect(slice[0]?.n).toBe(6)

    // And the frames those entity rows point at are all still present.
    const orphanedFacts = database
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM journal_entities entity
          WHERE NOT EXISTS(SELECT 1 FROM journal_history history WHERE history.cursor = entity.cursor)
            AND NOT EXISTS(SELECT 1 FROM journal_events event WHERE event.cursor = entity.cursor)`,
      )
      .get()
    expect(orphanedFacts?.n).toBe(0)
  })

  it("says out loud how much it dropped and under which window", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const dir = await directory()
    const journal = testJournal(dir, { retention: { keepFrames: 20 } }, log)
    const head = await appendAll(
      journal,
      Array.from({ length: 120 }, (_, index) => frame(`loud-${String(index)}`)),
    )
    await journal.checkpoint?.save?.({ identity: "loud", cursor: head, value: {} })

    const eviction = events.find((event) => JSON.stringify(event).includes("history-evicted"))
    expect(eviction).toBeDefined()
    expect(JSON.stringify(eviction)).toMatch(/"frames":\s*\d+/u)
    expect(JSON.stringify(eviction)).toMatch(/keepFrames/u)
  })
})
