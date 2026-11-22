/**
 * #37838: the computed `in_progress` columns. A provider answer says what the work item is; only Yrd knows which
 * of its environments still holds an issue open, so this module joins the two on the issue key the provider
 * already prints. Two legs decide it: an open environment that names the issue, and an owner seen writing to it
 * inside the activity window.
 *
 * Shape, agreed with the paged reader (@dev/3, #37793): `list-page` rows are `{path, version, row}` and the columns
 * go inside `row`; `view` is one flat issue object and the columns go beside `status`/`owner`.
 */
import type { IssuesVerb } from "./declaration.ts"

/** One environment that names an issue; while it is open, that issue is in progress. */
export type IssuesEnvironmentHold = Readonly<{ name: string; issue: string; expiresAt?: string }>

/** One journal record: who wrote to which issue, and when (epoch ms). */
export type IssuesActivityEvent = Readonly<{ path: string; actor: string; ts: number }>

/** How recent an owner's write must be for the issue to count as in progress (#37838 slice 2). */
export const OWNER_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000

export type InProgressColumns = Readonly<{ in_progress: boolean; in_progress_reason: string | null }>

export type InProgressInputs = Readonly<{
  holds: readonly IssuesEnvironmentHold[]
  /** The owner-activity leg's journal records; absent, only environments decide. */
  activity?: readonly IssuesActivityEvent[]
  /** How fresh an owner's record must be. Defaults to {@link OWNER_ACTIVITY_WINDOW_MS}. */
  windowMs?: number
}>

export type InProgressAnnotation =
  | Readonly<{ ok: true; result: unknown; notice?: string }>
  | Readonly<{ ok: false; fault: "environment" | "provider"; detail: string }>

const IDLE: InProgressColumns = { in_progress: false, in_progress_reason: null }

/** Open means an expiry still ahead of now; `expiresAt <= now` is closed, and an unreadable expiry is not a guess. */
function openHolds(
  holds: readonly IssuesEnvironmentHold[],
  now: number,
): ReadonlyMap<string, string> | Readonly<{ unreadable: string }> {
  const byIssue = new Map<string, string>()
  for (const hold of [...holds].sort((left, right) => left.name.localeCompare(right.name))) {
    if (hold.expiresAt !== undefined) {
      const expiresAt = Date.parse(hold.expiresAt)
      if (Number.isNaN(expiresAt)) {
        return { unreadable: `environment ${hold.name} has an unreadable expiresAt ${JSON.stringify(hold.expiresAt)}` }
      }
      if (expiresAt <= now) continue
    }
    const identity = identityOf(hold.issue)
    if (!byIssue.has(identity)) byIssue.set(identity, hold.name)
  }
  return byIssue
}

/**
 * The bead number a path carries, or null when it is not a bead file's. The same grammar as km's own
 * `numericBeadIdFromPath` (#37793 AC2, @cto 10:48) — the number survives a `km mv`, the storage id does not — and
 * Hightea's `beadNumberFromPath` pins the same cases. km owns the rule; this copy exists because yrd must not
 * depend on km.
 */
export function beadNumberFromPath(path: string): number | null {
  const stripped = path.startsWith("./") ? path.slice(2) : path
  const normalized = stripped.endsWith(".md") ? stripped.slice(0, -3) : stripped
  if (!normalized.startsWith("@")) return null
  const leafStart = normalized.lastIndexOf("/")
  if (leafStart < 0) return null
  const leaf = normalized.slice(leafStart + 1)
  if (/^\d{4}-\d{2}-\d{2}/u.test(leaf)) return null
  const match = /^(\d{4,})-.+$/u.exec(leaf)
  if (match === null) return null
  const number = Number.parseInt(match[1] as string, 10)
  return Number.isInteger(number) && number >= 0 ? number : null
}

/** The key a row and a journal record share: the bead number when both carry one, else the path as it stood. */
function identityOf(path: string): string {
  const number = beadNumberFromPath(path)
  const stripped = path.endsWith(".md") ? path.slice(0, -3) : path
  return number === null ? `path:${stripped}` : `bead:${String(number)}`
}

/** The latest in-window record per (issue, actor), as an ISO time, so the reason names when the owner was last seen. */
function activeByIssue(
  events: readonly IssuesActivityEvent[],
  now: number,
  windowMs: number,
): ReadonlyMap<string, string> {
  const latest = new Map<string, number>()
  for (const event of events) {
    if (!Number.isFinite(event.ts) || event.ts <= now - windowMs) continue
    const key = `${identityOf(event.path)}\u0000${event.actor}`
    const held = latest.get(key)
    if (held === undefined || event.ts > held) latest.set(key, event.ts)
  }
  return new Map([...latest].map(([key, ts]) => [key, new Date(ts).toISOString()]))
}

/** Columns for one row: an open environment is the stronger fact; the owner's recent write is the other. */
function columns(
  path: string,
  owner: string,
  open: ReadonlyMap<string, string>,
  active: ReadonlyMap<string, string>,
): InProgressColumns {
  const identity = identityOf(path)
  const environment = open.get(identity)
  if (environment !== undefined) return { in_progress: true, in_progress_reason: `environment ${environment}` }
  const activity = owner === "" ? undefined : active.get(`${identity}\u0000${owner}`)
  return activity === undefined ? IDLE : { in_progress: true, in_progress_reason: `owner ${owner}, active ${activity}` }
}

/** The row's owner column as the provider spells it; empty means nobody holds it. */
function ownerOf(row: Record<string, unknown>): string {
  return typeof row.owner === "string" ? row.owner.trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Read an `activity` answer: one journal record per line (`km tail --json`), each naming who wrote to which issue
 * and when. A line that is not JSON is the provider breaking its contract, never something to skip.
 */
export function readActivity(stdout: string): readonly IssuesActivityEvent[] {
  const events: IssuesActivityEvent[] = []
  for (const [index, line] of stdout.split("\n").entries()) {
    if (line.trim() === "") continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error(`activity line ${String(index + 1)} is not JSON`)
    }
    if (!isRecord(record)) throw new Error(`activity line ${String(index + 1)} is not a journal record`)
    const path = recordPath(record)
    const actor = record.actor
    const ts = record.ts
    if (path === undefined || typeof actor !== "string" || actor === "") continue
    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      throw new Error(`activity line ${String(index + 1)} names ${path} with no numeric ts`)
    }
    events.push({ path, actor, ts })
  }
  return events
}

/**
 * The issue path a journal record names. km keeps it on the record's payload: a bare `path` for an item-history
 * record, `set.fs_path` for an update and `subtree[0].fs_path` for a delete — the same three spots km's own
 * changed-since reader looks in (#37793). The payload is nested inside `data.data` on the journal.
 */
function recordPath(record: Record<string, unknown>): string | undefined {
  if (typeof record.path === "string" && record.path !== "") return record.path
  const data = record.data
  if (!isRecord(data)) return undefined
  const payload = isRecord(data.data) ? data.data : data
  if (typeof payload.path === "string" && payload.path !== "") return payload.path
  const set = isRecord(payload.set) ? payload.set : undefined
  if (set !== undefined && typeof set.fs_path === "string" && set.fs_path !== "") return set.fs_path
  const subtree = payload.subtree
  if (Array.isArray(subtree) && isRecord(subtree[0]) && typeof subtree[0].fs_path === "string") {
    return subtree[0].fs_path === "" ? undefined : subtree[0].fs_path
  }
  return undefined
}

function issueId(row: Record<string, unknown>): string | undefined {
  return typeof row.id === "string" && row.id.length > 0 ? row.id : undefined
}

/**
 * Locate the provider's issue rows and put the columns on them. Returns the shape it could not read instead of
 * leaving a consumer to read an absent `in_progress` as false.
 */
export function annotateInProgress(
  verb: IssuesVerb,
  result: unknown,
  inputs: InProgressInputs,
  now: number,
): InProgressAnnotation {
  if (verb !== "view" && verb !== "list-page" && verb !== "list") return { ok: true, result }
  const open = openHolds(inputs.holds, now)
  if ("unreadable" in open) return { ok: false, fault: "environment", detail: open.unreadable }
  const active = activeByIssue(inputs.activity ?? [], now, inputs.windowMs ?? OWNER_ACTIVITY_WINDOW_MS)

  if (verb === "view") {
    if (!isRecord(result)) return skip(result)
    const id = issueId(result)
    // A provider answer that is not an issue object at all passes back whole (the interface's contract); one that
    // carries issue fields but no key is a broken answer, and a column guessed false would hide held work.
    if (id === undefined) {
      return "status" in result
        ? {
            ok: false,
            fault: "provider",
            detail: `expected one issue object with a string id, found ${describe(result)}`,
          }
        : skip(result)
    }
    return { ok: true, result: { ...result, ...columns(id, ownerOf(result), open, active) } }
  }

  if (verb === "list-page") {
    const page = isRecord(result) ? result : undefined
    const rows = page?.rows
    if (!Array.isArray(rows)) return skip(result)
    if (!rows.every((entry) => isRecord(entry) && isRecord(entry.row))) return skip(result)
    const shaped = rows as readonly Readonly<{ row: Record<string, unknown> }>[]
    const annotated: unknown[] = []
    for (const [index, entry] of shaped.entries()) {
      const row = entry.row
      const id = issueId(row)
      if (id === undefined) {
        return {
          ok: false,
          fault: "provider",
          detail: `row ${String(index)} carries no string id; cannot say whether it is in progress`,
        }
      }
      annotated.push({ ...entry, row: { ...row, ...columns(id, ownerOf(row), open, active) } })
    }
    return { ok: true, result: { ...page, rows: annotated } }
  }

  // The unpaged `list` dump has no fixed row shape across providers: annotate what is recognisable, and say so
  // rather than let an absent column read as false.
  const entries = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.rows)
      ? result.rows
      : undefined
  if (entries === undefined) {
    return skip(result)
  }
  if (!entries.every((entry) => isRecord(entry) && issueId(entry) !== undefined)) {
    return { ok: true, result, notice: "yrd issues list: rows without a string id; in_progress columns skipped\n" }
  }
  const annotated = entries.map((entry) => {
    const row = entry as Record<string, unknown>
    return { ...row, ...columns(row.id as string, ownerOf(row), open, active) }
  })
  return {
    ok: true,
    result: Array.isArray(result) ? annotated : { ...(result as Record<string, unknown>), rows: annotated },
  }
}

/** A shape this reader cannot place: hand the provider's answer back untouched and say so on stderr. */
function skip(result: unknown): InProgressAnnotation {
  return {
    ok: true,
    result,
    notice: `yrd issues: no issue rows located (${describe(result)}); in_progress columns skipped\n`,
  }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `an array of ${String(value.length)}`
  return typeof value === "object"
    ? `an object with keys ${JSON.stringify(Object.keys(value).slice(0, 6))}`
    : typeof value
}
