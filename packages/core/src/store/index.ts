import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { YrdCause, YrdEvent } from "../app.ts"

const SCHEMA_VERSION = "1"

export type IndexedYrdEvent = YrdEvent & { seq: number }

export type EventIndexQuery = {
  name?: string
  namePrefix?: string
  commandId?: string
  op?: string
  after?: number
  limit?: number
}

export type YrdEventIndex = {
  path: string
  query(filter?: EventIndexQuery): IndexedYrdEvent[]
  close(): void
}

type MutableYrdEventIndex = YrdEventIndex & {
  record(events: readonly YrdEvent[]): void
  rebuild(events: readonly YrdEvent[]): void
}

type EventRow = {
  seq: number
  id: string
  ts: string
  name: string
  command_id: string
  op: string
  data_json: string
  cause_json: string
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new Error(`yrd: SQLite event index contains invalid ${label}`, { cause })
  }
}

function indexedEvent(row: EventRow): IndexedYrdEvent {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    name: row.name,
    data: parseJson(row.data_json, `data for '${row.id}'`),
    cause: parseJson(row.cause_json, `cause for '${row.id}'`) as YrdCause,
  }
}

function queryLimit(value: number | undefined): number {
  if (value === undefined) return 1_000
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("yrd: event index query limit must be an integer from 1 to 10000")
  }
  return value
}

export function createYrdEventIndex(dir: string): MutableYrdEventIndex {
  const path = join(dir, "index.sqlite")
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = FULL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS yrd_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS yrd_events (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      name TEXT NOT NULL,
      command_id TEXT NOT NULL,
      op TEXT NOT NULL,
      data_json TEXT NOT NULL,
      cause_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS yrd_events_name_seq ON yrd_events(name, seq);
    CREATE INDEX IF NOT EXISTS yrd_events_command_seq ON yrd_events(command_id, seq);
    CREATE INDEX IF NOT EXISTS yrd_events_op_seq ON yrd_events(op, seq);
  `)
  db.query("INSERT OR REPLACE INTO yrd_meta(key, value) VALUES ('schema-version', ?)").run(SCHEMA_VERSION)

  const insert = db.query(`
    INSERT INTO yrd_events(seq, id, ts, name, command_id, op, data_json, cause_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const replaceAll = db.transaction((events: readonly YrdEvent[]) => {
    db.exec("DELETE FROM yrd_events")
    events.forEach((event, index) => {
      insert.run(
        index + 1,
        event.id,
        event.ts,
        event.name,
        event.cause.commandId,
        event.cause.op,
        JSON.stringify(event.data),
        JSON.stringify(event.cause),
      )
    })
  })
  const append = db.transaction((events: readonly YrdEvent[]) => {
    const last = db.query<{ seq: number }, []>("SELECT COALESCE(MAX(seq), 0) AS seq FROM yrd_events").get()?.seq ?? 0
    events.forEach((event, index) => {
      insert.run(
        last + index + 1,
        event.id,
        event.ts,
        event.name,
        event.cause.commandId,
        event.cause.op,
        JSON.stringify(event.data),
        JSON.stringify(event.cause),
      )
    })
  })

  return {
    path,
    query(filter = {}) {
      const where: string[] = []
      const values: Array<string | number> = []
      if (filter.name !== undefined) {
        where.push("name = ?")
        values.push(filter.name)
      }
      if (filter.namePrefix !== undefined) {
        where.push("name LIKE ? ESCAPE '\\'")
        values.push(`${filter.namePrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`)
      }
      if (filter.commandId !== undefined) {
        where.push("command_id = ?")
        values.push(filter.commandId)
      }
      if (filter.op !== undefined) {
        where.push("op = ?")
        values.push(filter.op)
      }
      if (filter.after !== undefined) {
        if (!Number.isSafeInteger(filter.after) || filter.after < 0) {
          throw new Error("yrd: event index query 'after' must be a non-negative integer")
        }
        where.push("seq > ?")
        values.push(filter.after)
      }
      values.push(queryLimit(filter.limit))
      const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`
      return db
        .query<EventRow, Array<string | number>>(
          `SELECT seq, id, ts, name, command_id, op, data_json, cause_json FROM yrd_events${clause} ORDER BY seq LIMIT ?`,
        )
        .all(...values)
        .map(indexedEvent)
    },
    record(events) {
      append(events)
    },
    rebuild(events) {
      const ids = new Set<string>()
      for (const event of events) {
        if (ids.has(event.id)) throw new Error(`yrd: event journal contains duplicate event id '${event.id}'`)
        ids.add(event.id)
      }
      replaceAll(events)
    },
    close() {
      db.close()
    },
  }
}
