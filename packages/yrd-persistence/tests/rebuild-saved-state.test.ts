/**
 * @failure A journal whose evicted prefix outlived its checkpoint identity stays unbootable, or a rebuild stitches a prefix it never verified.
 * @level l1
 * @consumer @yrd/persistence saved-state rebuild
 */
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  command,
  createYrd,
  createYrdDef,
  event,
  failureFact,
  journalEvent,
  type CommandTree,
  type Journal,
  type YrdDef,
} from "@yrd/core"
import {
  createExclusive,
  createJournal as createSqliteJournal,
  rebuildSavedState,
  type MutableJournal,
  type SavedStateRebuildReport,
} from "@yrd/persistence"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"

type CounterState = { counter: { value: number } }

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-rebuild-saved-state-"))
  roots.push(root)
  return root
}

function createJournal(options: Parameters<typeof createSqliteJournal>[0]): MutableJournal {
  const inject = options.inject ?? {}
  return createSqliteJournal({
    ...options,
    inject: { ...inject, sqliteVersion: "3.53.0" },
  } as unknown as Parameters<typeof createSqliteJournal>[0]) as MutableJournal
}

/**
 * Two definitions that project identically but carry different projection
 * versions, so the second one's checkpoint identity cannot load the first
 * one's saved state — the exact shape of the 2026-08-13 outage.
 */
function counterDefinition(projectionVersion: string): YrdDef<CounterState, CommandTree, object> {
  const add = command({
    title: "Add",
    visibility: "public",
    params: z.object({ by: z.number().int() }),
    apply: (state: CounterState, args: { by: number }) => ({
      events: [event("counter/changed", { from: state.counter.value, by: args.by })],
    }),
  })
  return createYrdDef().extend({
    initialState: { counter: { value: 0 } },
    commands: { counter: { add } },
    events: {
      "counter/changed": journalEvent(1, z.object({ from: z.number().int(), by: z.number().int() })),
    },
    projectionVersion,
    project(state: CounterState, applied: { name: string; data: unknown }) {
      return { counter: { value: state.counter.value + (applied.data as { by: number }).by } }
    },
  }) as YrdDef<CounterState, CommandTree, object>
}

const V1 = "counter-v1"
const V2 = "counter-v2"

async function dispatchAdds(dir: string, projectionVersion: string, count: number, retentionFrames?: number) {
  const journal = createJournal({
    dir,
    ...(retentionFrames === undefined
      ? { retention: "disabled" as const }
      : { retention: { keepFrames: retentionFrames } }),
  })
  const app = await createYrd(counterDefinition(projectionVersion), { inject: { journal } })
  for (let index = 0; index < count; index += 1) await app.dispatch({ op: "counter.add", args: { by: 1 } })
  const value = app.state().counter.value
  await app.close()
  return value
}

function journalFacts(dir: string) {
  using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
  const scalar = (sql: string, field: string) =>
    (database.query<Record<string, number | null>, []>(sql).get()?.[field] ?? 0) as number
  const evicted = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get("history_evicted_through")
  const snapshot = database
    .query<{ cursor: number; checkpoint_identity: string | null }, []>(
      "SELECT cursor, checkpoint_identity FROM journal_snapshot WHERE singleton = 1",
    )
    .get()
  return {
    head: Number(
      database.query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?").get("head_cursor")
        ?.value ?? "0",
    ),
    historyLow: scalar("SELECT MIN(cursor) AS c FROM journal_history", "c"),
    historyHigh: scalar("SELECT MAX(cursor) AS c FROM journal_history", "c"),
    evictedThrough: evicted === null ? 0 : Number(evicted.value),
    checkpointCursor: snapshot?.cursor ?? 0,
    checkpointIdentity: snapshot?.checkpoint_identity ?? null,
  }
}

async function snapshotPath(dir: string): Promise<string> {
  const home = join(dir, "journal-snapshots")
  const entries = await readdir(home)
  const found = entries.find((entry) => entry.endsWith(".sqlite"))
  if (found === undefined) throw new Error(`no pre-bump snapshot under ${home}`)
  return join(home, found)
}

/**
 * The outage fixture: a journal whose history was evicted under a checkpoint
 * the CURRENT definition can no longer load, plus the pre-eviction snapshot
 * that still holds the evicted prefix.
 */
async function evictedJournal(shape: Readonly<{ before?: number; after?: number; keepFrames?: number }> = {}) {
  const dir = await stateDir()
  // Everything below runs at V1, which is the identity the checkpoint is
  // written under and the one the rebuild must replace.
  await dispatchAdds(dir, V1, shape.before ?? 40)
  // The pre-bump snapshot writer is the artifact an operator actually has:
  // taken while the whole prefix is still present, before any eviction.
  await createJournal({ dir, retention: "disabled" }).administration.bump(1)
  // A window narrower than the journal, so this round's checkpoint evicts a
  // prefix the snapshot above still covers — the overlap the rebuild verifies.
  const expected = await dispatchAdds(dir, V1, shape.after ?? 10, shape.keepFrames ?? 20)
  return { dir, snapshot: await snapshotPath(dir), expected }
}

/** The failure fact behind a refusal, so a test pins the CHECK that fired. */
async function refusalOf(attempt: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await attempt
  } catch (error) {
    const fact = failureFact(error)
    if (fact === undefined) {
      throw new Error(
        `expected a named yrd failure, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      )
    }
    return { code: fact.code, message: fact.message }
  }
  throw new Error("expected a refusal, but the rebuild succeeded")
}

async function rebuild(
  dir: string,
  projectionVersion: string,
  options: Readonly<{ snapshot?: string; dryRun?: boolean; lockTimeoutMs?: number }> = {},
): Promise<SavedStateRebuildReport> {
  return rebuildSavedState(
    {
      dir,
      ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
      ...(options.dryRun === true ? { dryRun: true } : {}),
      lock: { timeoutMs: options.lockTimeoutMs ?? 0 },
      inject: { sqliteVersion: "3.53.0" },
    } as Parameters<typeof rebuildSavedState>[0],
    async (journal: Journal<unknown>) => {
      await using app = await createYrd(counterDefinition(projectionVersion), { inject: { journal } })
      return app.state().counter.value
    },
  )
}

describe("saved-state rebuild", () => {
  it("reproduces the outage: an evicted prefix under a stale identity cannot boot", async () => {
    const { dir } = await evictedJournal()
    const facts = journalFacts(dir)
    expect(facts.evictedThrough).toBeGreaterThan(0)
    expect(facts.historyLow).toBe(facts.evictedThrough + 1)

    const journal = createJournal({ dir, retention: { keepFrames: 20 } })
    await expect(createYrd(counterDefinition(V2), { inject: { journal } })).rejects.toThrow(
      /saved state must be rebuilt from the journal, but history below cursor/u,
    )
  })

  it("rebuilds the checkpoint from a pre-eviction snapshot so the next boot loads it", async () => {
    const { dir, snapshot, expected } = await evictedJournal()
    const stale = journalFacts(dir)

    const report = await rebuild(dir, V2, { snapshot })

    expect(report.result).toBe(expected)
    expect(report.written).toBe(true)
    expect(report.dryRun).toBe(false)
    expect(report.head).toBe(stale.head)
    expect(report.cursor).toBe(stale.head)
    expect(report.snapshot?.frames).toBe(stale.evictedThrough)
    expect(report.snapshot?.from).toBe(1)
    expect(report.snapshot?.to).toBe(stale.evictedThrough)
    expect(report.live.from).toBe(stale.evictedThrough + 1)
    expect(report.live.to).toBe(stale.head)
    expect(report.snapshot!.frames + report.live.frames).toBe(stale.head)
    expect(report.overlapVerified).toBeGreaterThan(0)

    const rebuilt = journalFacts(dir)
    expect(rebuilt.checkpointIdentity).toBe(report.identity)
    expect(rebuilt.checkpointIdentity).not.toBe(stale.checkpointIdentity)

    // The whole point: the definition that could not boot now boots from the
    // checkpoint, without replaying anything.
    const journal = createJournal({ dir, retention: { keepFrames: 20 } })
    await using app = await createYrd(counterDefinition(V2), { inject: { journal } })
    expect(app.state().counter.value).toBe(expected)
  })

  it("rebuilds from the live journal alone when nothing was evicted", async () => {
    const dir = await stateDir()
    const expected = await dispatchAdds(dir, V1, 12)
    expect(journalFacts(dir).evictedThrough).toBe(0)

    const report = await rebuild(dir, V2)

    expect(report.result).toBe(expected)
    expect(report.written).toBe(true)
    expect(report.snapshot).toBeUndefined()
    expect(report.live.from).toBe(1)
    expect(report.live.frames).toBe(report.head)
    expect(report.overlapVerified).toBe(0)
    expect(journalFacts(dir).checkpointIdentity).toBe(report.identity)
  })

  it("reports what it would write without writing it, under --dry-run", async () => {
    const { dir, snapshot, expected } = await evictedJournal()
    const stale = journalFacts(dir)

    const report = await rebuild(dir, V2, { snapshot, dryRun: true })

    expect(report.result).toBe(expected)
    expect(report.dryRun).toBe(true)
    expect(report.written).toBe(false)
    // The identity it WOULD write is still named, so a dry run is a real answer.
    expect(report.identity).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/u))
    expect(report.cursor).toBe(stale.head)
    expect(journalFacts(dir).checkpointIdentity).toBe(stale.checkpointIdentity)
  })

  it("refuses when history was evicted and no snapshot was offered", async () => {
    const { dir } = await evictedJournal()
    const evicted = journalFacts(dir).evictedThrough
    const failure = await refusalOf(rebuild(dir, V2))
    expect(failure.code).toBe("saved-state-rebuild-snapshot-required")
    // Names what it checked, what it found, and where to look for the remedy.
    expect(failure.message).toMatch(new RegExp(`lost history through cursor ${String(evicted)}`, "u"))
    expect(failure.message).toMatch(/journal-snapshots/u)
  })

  it("refuses when a snapshot frame no longer matches its recorded digest", async () => {
    const { dir, snapshot } = await evictedJournal()
    {
      using database = new Database(snapshot, { readwrite: true, strict: true })
      database
        .query("UPDATE journal_history SET value_json = json_set(value_json, '$.tampered', 1) WHERE cursor = ?")
        .run(7)
    }
    const failure = await refusalOf(rebuild(dir, V2, { snapshot }))
    expect(failure.code).toBe("saved-state-rebuild-frame-damaged")
    expect(failure.message).toMatch(/cursor 7/u)
  })

  it("refuses when an overlap cursor diverges between the snapshot and the live journal", async () => {
    const { dir, snapshot } = await evictedJournal()
    const overlap = journalFacts(dir).evictedThrough + 1
    {
      // Rewrite the row AND its digest, so only the cross-source comparison can
      // catch it — per-row integrity alone would pass.
      using database = new Database(snapshot, { readwrite: true, strict: true })
      const row = database
        .query<{ value_json: string }, [number]>("SELECT value_json FROM journal_history WHERE cursor = ?")
        .get(overlap)
      const edited = JSON.stringify({ ...(JSON.parse(row!.value_json) as object), divergent: true })
      database
        .query("UPDATE journal_history SET value_json = ?, sha256 = ? WHERE cursor = ?")
        .run(edited, createHash("sha256").update(edited).digest("hex"), overlap)
    }
    const failure = await refusalOf(rebuild(dir, V2, { snapshot }))
    expect(failure.code).toBe("saved-state-rebuild-overlap-divergence")
    expect(failure.message).toMatch(new RegExp(`cursor ${String(overlap)}`, "u"))
  })

  it("refuses when the snapshot was taken too early to reach the eviction floor", async () => {
    // A genuinely short snapshot: taken at cursor 20, but eviction later
    // reached 30, so cursors 21..30 survive in neither source.
    const { dir, snapshot } = await evictedJournal({ before: 20, after: 30, keepFrames: 20 })
    const facts = journalFacts(dir)
    expect(facts.evictedThrough).toBeGreaterThan(20)

    const failure = await refusalOf(rebuild(dir, V2, { snapshot }))
    expect(failure.code).toBe("saved-state-rebuild-snapshot-short")
    expect(failure.message).toMatch(/ends at cursor 20/u)
    expect(failure.message).toMatch(/exist in neither source/u)
  })

  it("refuses while another writer holds the journal", async () => {
    const { dir, snapshot } = await evictedJournal()
    // Hold the real writer lock for the whole attempt, exactly as a live
    // resident runner would, and prove the rebuild will not proceed beside it.
    await createExclusive(dir, { timeoutMs: 0 }).run(async () => {
      const failure = await refusalOf(rebuild(dir, V2, { snapshot, lockTimeoutMs: 0 }))
      expect(failure.code).toBe("exclusive-busy")
      expect(failure.message).toMatch(/writer lock is busy/u)
      expect(failure.message).toMatch(/doctor rebuild-saved-state/u)
    })
  })
})
