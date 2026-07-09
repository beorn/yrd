import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import type { BayStore } from "../types.ts"
import { createJsonlJournal } from "../journal.ts"
import { bayEventsPath, bayIndexPath } from "../paths.ts"
import { acquireWriterLock } from "../../packages/core/src/store/lock.ts"

/**
 * sqlite store provider (spec § Store provider — "sqlite (default;
 * bun:sqlite; WAL; single flock writer) — the zero-dep FOSS path").
 *
 * M1 keeps the sqlite side minimal on purpose: the journal (jsonl,
 * substrate-independent per spec) is the only durable state this store
 * is REQUIRED to own. `index.sqlite` today holds nothing but a `meta` row
 * recording its own schema version — materialized views (leases,
 * changesets) are a read-path optimization for later, folded from the
 * journal exactly like every other consumer (core.ts `fold()`). Adding
 * them is additive: new tables + a repopulate-from-replay step, never a
 * second source of truth.
 *
 * The writer lock is held for the store's whole lifetime — one sqlite
 * store per `dir` at a time, enforced by `acquireWriterLock` (see
 * @yrd/core's store/lock.ts for the stable OS writer lock).
 */

const SCHEMA_VERSION = 1

export async function createSqliteStore(opts: { dir: string }): Promise<BayStore> {
  const dir = opts.dir
  await mkdir(dir, { recursive: true })

  const lock = await acquireWriterLock(dir)

  let db: Database
  try {
    db = new Database(bayIndexPath(dir), { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
  } catch (err) {
    // We hold the lock but failed to stand up the db — release before
    // throwing so a caller's retry isn't blocked by our own failed attempt.
    await lock.release()
    throw err
  }

  const journal = createJsonlJournal(bayEventsPath(dir))

  let closed = false
  return {
    journal,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      db.close()
      await lock.release()
    },
  }
}
