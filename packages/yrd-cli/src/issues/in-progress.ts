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

export type InProgressColumns = Readonly<{ in_progress: boolean | null; in_progress_reason: string | null }>

/**
 * #37838 (@cto 3083a003): the sparse progress frame. A native delta says which ROWS moved; it can never say that a
 * hold expired or that a previously idle owner wrote, because nothing about those rows changed. This frame carries
 * that second fact on its own — every open hold and every (identity, actor) the activity window qualifies — from
 * the SAME single capture the column annotation uses, in a size that follows the qualifying set, never the store.
 *
 * The reader joins it against its own cached rows: a hold entry qualifies by identity alone and wins whatever the
 * owner, an activity entry qualifies only when its `owner` equals the cached row's owner — the same predicate
 * {@link columns} applies, including its empty-owner rule (an empty owner matches no actor). So no row list travels
 * and no consumer re-implements the window or parses a reason.
 */
export type IssuesProgressHoldEntry = Readonly<{ id: string; reason: string }>
export type IssuesProgressActivityEntry = Readonly<{ id: string; owner: string; reason: string }>
export type IssuesProgressEntry = IssuesProgressHoldEntry | IssuesProgressActivityEntry

export type IssuesProgressSource = "ok" | "undeclared" | "unreadable"

export type IssuesProgress = Readonly<{
  /**
   * `false` when the activity source answered or none was declared, JSON `null` when one WAS declared and could not
   * be read. A string such as "unknown" would be a fourth state nobody can type; the column's three states are
   * true, false and null (@cto 8e7cbb99, 3083a003).
   */
  default: false | null
  /** How the activity leg answered, so a stale-default is visible in the frame instead of inferred from it. */
  source: IssuesProgressSource
  /** Sorted holds first, then activity, each by identity: two captures of one store differ only in the facts. */
  qualifying: readonly IssuesProgressEntry[]
  /** The capture this frame was built from was whole. A partial or cut-short frame is a failure, never this. */
  complete: true
}>

export type InProgressInputs = Readonly<{
  holds: readonly IssuesEnvironmentHold[]
  /** The owner-activity leg's journal records; absent, only environments decide. */
  activity?: readonly IssuesActivityEvent[]
  /**
   * A source WAS declared and could not be read. The columns must then say "could not say" (null) rather than
   * false: an empty activity set means nobody wrote, which is a different fact from nobody being readable
   * (@cto 8e7cbb99). A known environment hold still answers true.
   */
  activityUnknown?: boolean
  /** How fresh an owner's record must be. Defaults to {@link OWNER_ACTIVITY_WINDOW_MS}. */
  windowMs?: number
}>

export type InProgressAnnotation =
  | Readonly<{
      ok: true
      result: unknown
      notice?: string
      /** Rows whose columns came out unknown BECAUSE a declared activity source failed (#37838, @dev/3 7a95653e). */
      unknownRows?: number
    }>
  | Readonly<{ ok: false; fault: "environment" | "provider"; detail: string }>

const IDLE: InProgressColumns = { in_progress: false, in_progress_reason: null }
const UNKNOWN: InProgressColumns = { in_progress: null, in_progress_reason: null }

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

/**
 * #38182 (@cto ac9b95be): the activity leg as a fold over journal lines, so a reader that stays up can keep what it
 * applied and hand in only the lines after its offset. The window is the state's, not the batch's: an empty batch
 * still drops what has aged out, which is the one fact a delta's rows can never carry.
 *
 * `latest` is keyed `${identity}\u0000${actor}` - the key {@link activeViews} and the columns already join on.
 */
export type IssuesActivityState = Readonly<{ readonly latest: ReadonlyMap<string, number> }>

/** No journal read yet. */
export const EMPTY_ACTIVITY: IssuesActivityState = { latest: new Map() }

/**
 * Apply journal records to the state. Records outside the window are not remembered, a record older than the one held
 * never lowers it, and every call prunes what the clock has taken out of the window - so two folds of the same lines
 * at the same `now` answer the same state however the lines were split.
 */
export function applyActivity(
  state: IssuesActivityState,
  events: readonly IssuesActivityEvent[],
  now: number,
  windowMs: number = OWNER_ACTIVITY_WINDOW_MS,
): IssuesActivityState {
  const cutoff = now - windowMs
  const latest = new Map(state.latest)
  for (const event of events) {
    if (!Number.isFinite(event.ts) || event.ts <= cutoff) continue
    const key = `${identityOf(event.path)}\u0000${event.actor}`
    const held = latest.get(key)
    if (held === undefined || event.ts > held) latest.set(key, event.ts)
  }
  for (const [key, ts] of latest) {
    if (!Number.isFinite(ts) || ts <= cutoff) latest.delete(key)
  }
  return { latest }
}

/** What the columns and the frame join on: the newest in-window record per (issue, actor), as an ISO time. */
export function activeViews(
  state: IssuesActivityState,
  now: number,
  windowMs: number = OWNER_ACTIVITY_WINDOW_MS,
): ReadonlyMap<string, string> {
  const cutoff = now - windowMs
  return new Map(
    [...state.latest]
      .filter(([, ts]) => Number.isFinite(ts) && ts > cutoff)
      .map(([key, ts]) => [key, new Date(ts).toISOString()]),
  )
}

/** The latest in-window record per (issue, actor), as an ISO time, so the reason names when the owner was last seen. */
function activeByIssue(
  events: readonly IssuesActivityEvent[],
  now: number,
  windowMs: number,
): ReadonlyMap<string, string> {
  return activeViews(applyActivity(EMPTY_ACTIVITY, events, now, windowMs), now, windowMs)
}

/** Columns for one row: an open environment is the stronger fact; the owner's recent write is the other. */
function columns(
  path: string,
  owner: string,
  open: ReadonlyMap<string, string>,
  active: ReadonlyMap<string, string>,
  activityUnknown: boolean,
): InProgressColumns {
  const identity = identityOf(path)
  const environment = open.get(identity)
  if (environment !== undefined) return { in_progress: true, in_progress_reason: `environment ${environment}` }
  if (activityUnknown) return UNKNOWN
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
    } catch (error) {
      // Thread the parser's own message: the line number says WHICH record broke, and the cause says what the bytes
      // really were. A thrown Error with neither is the class the catch-cause guard counts.
      throw new Error(
        `activity line ${String(index + 1)} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const event = activityEventOf(record, `activity line ${String(index + 1)}`)
    if (event !== undefined) events.push(event)
  }
  return events
}

/**
 * One journal record as the activity leg reads it: the issue it names, the actor and when. A record that is not a
 * journal record at all, or one that names an issue with no numeric time, is the provider breaking its contract and
 * throws; a record that names no issue (a vault-level write) is simply not this leg's. `where` names the record's
 * position, so the message says which one broke. The resident reader (#38182 row 1) answers the same records in a
 * `journal` frame, so both paths read them through here.
 */
export function activityEventOf(record: unknown, where: string): IssuesActivityEvent | undefined {
  if (!isRecord(record)) throw new Error(`${where} is not a journal record`)
  const path = recordPath(record)
  const actor = record.actor
  const ts = record.ts
  if (path === undefined || typeof actor !== "string" || actor === "") return undefined
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new Error(`${where} names ${path} with no numeric ts`)
  }
  return { path, actor, ts }
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
  if (verb !== "view" && verb !== "list-page" && verb !== "list") {
    return { ok: true, result }
  }
  const open = openHolds(inputs.holds, now)
  if ("unreadable" in open) return { ok: false, fault: "environment", detail: open.unreadable }
  const active = activeByIssue(inputs.activity ?? [], now, inputs.windowMs ?? OWNER_ACTIVITY_WINDOW_MS)
  const activityUnknown = inputs.activityUnknown === true && inputs.activity === undefined

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
    return { ok: true, result: { ...result, ...columns(id, ownerOf(result), open, active, activityUnknown) } }
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
      annotated.push({ ...entry, row: { ...row, ...columns(id, ownerOf(row), open, active, activityUnknown) } })
    }
    // A traversing refresh must be able to tell an all-unknown read from a clean no-holds page (#37838).
    const unknownRows = activityUnknown
      ? annotated.filter((entry) => (entry as { row: { in_progress?: unknown } }).row.in_progress === null).length
      : 0
    return { ok: true, result: { ...page, rows: annotated }, ...(activityUnknown ? { unknownRows } : {}) }
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
    return { ...row, ...columns(row.id as string, ownerOf(row), open, active, activityUnknown) }
  })
  return {
    ok: true,
    result: Array.isArray(result) ? annotated : { ...(result as Record<string, unknown>), rows: annotated },
  }
}

/**
 * The progress frame for one refresh, built from the one capture that also annotates the rows. Refuses (with the
 * cause) rather than publish a frame it cannot vouch for: an unreadable hold expiry makes the whole frame a named
 * failure, because "no holds" and "holds I could not read" are different facts and only one is safe to join with.
 */
export function progressOf(
  holds: readonly IssuesEnvironmentHold[],
  now: number,
  activity: Readonly<{
    /** The owner-activity capture; absent, only environments qualify and the source is `undeclared`. */
    events?: readonly IssuesActivityEvent[]
    /** A declared source could not be read: the default is `null`, never `false`. */
    unknown?: boolean
    windowMs?: number
  }>,
): Readonly<{ ok: true; progress: IssuesProgress }> | Readonly<{ ok: false; detail: string }> {
  const unreadable = activity.unknown === true && activity.events === undefined
  const source: IssuesProgressSource = unreadable ? "unreadable" : activity.events === undefined ? "undeclared" : "ok"
  const windowMs = activity.windowMs ?? OWNER_ACTIVITY_WINDOW_MS
  return progressFromActivity(holds, now, {
    state: applyActivity(EMPTY_ACTIVITY, activity.events ?? [], now, windowMs),
    source,
    windowMs,
  })
}

/**
 * The same join, from the fold a resident reader already holds (#38182 row 1, @cto 77dd37ea): the serve loop keeps the
 * activity state across reads, so it applies only new journal lines and hands the state in here. One implementation of
 * the join, so a frame built by the reader and one built by the one-shot `list-page --progress` cannot disagree.
 */
export function progressFromActivity(
  holds: readonly IssuesEnvironmentHold[],
  now: number,
  activity: Readonly<{
    state: IssuesActivityState
    /** `ok` when the journal answered; `unreadable` when the refresh failed and only the holds can speak. */
    source: IssuesProgressSource
    windowMs?: number
  }>,
): Readonly<{ ok: true; progress: IssuesProgress }> | Readonly<{ ok: false; detail: string }> {
  const open = openHolds(holds, now)
  if ("unreadable" in open) return { ok: false, detail: open.unreadable }
  const active = activeViews(activity.state, now, activity.windowMs ?? OWNER_ACTIVITY_WINDOW_MS)
  const qualifying: IssuesProgressEntry[] = []
  for (const [identity, name] of [...open].sort(([left], [right]) => left.localeCompare(right))) {
    qualifying.push({ id: identity, reason: `environment ${name}` })
  }
  for (const [key, activeAt] of [...active].sort(([left], [right]) => left.localeCompare(right))) {
    const split = key.indexOf("\u0000")
    const identity = key.slice(0, split)
    // A hold already qualified this identity, whatever the actor: the same precedence `columns` applies.
    if (open.has(identity)) continue
    const actor = key.slice(split + 1)
    qualifying.push({ id: identity, owner: actor, reason: `owner ${actor}, active ${activeAt}` })
  }
  return {
    ok: true,
    progress: { default: activity.source === "unreadable" ? null : false, source: activity.source, qualifying, complete: true },
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
