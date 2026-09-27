/** Event queue override decisions, clocks and display facts. */
/** The longest window one override may hold a check off: a hard maximum, checked at write. */
export const OVERRIDE_MAX_HOURS = 12

export type OverrideState = "active" | "expired"

export type OverrideEntry = Readonly<{
  check: string
  state: OverrideState
  until: Date
  by: string
  /** True only for a who-acted token's verified actor (25074); a git actor is claimed. */
  verified: boolean
  reason: string
  /** The record commit that set this entry. */
  record: string
  /** When the `expired` record was written; absent while no round has written it. */
  expiredAt?: Date
  /** When the entry was set: the half-window reminder falls halfway from here to `until`. */
  setAt: Date
  /** When the half-window reminder was recorded; once, so it never repeats (@cto ccd8dfa8). */
  remindedAt?: Date
}>

/** The table at one tip: `sha` is undefined when the ref does not exist. */
export type OverrideTable = Readonly<{ sha: string | undefined; entries: readonly OverrideEntry[] }>

export type OverrideActor = Readonly<{ by: string; verified: boolean }>

export type OverrideWrite =
  | Readonly<{ kind: "off"; check: string; until: Date; reason: string; actor: OverrideActor }>
  | Readonly<{ kind: "clear"; check: string; reason: string; actor: OverrideActor }>

export type OverrideDecision = Readonly<{
  kind: "set" | "replaced" | "clear"
  entries: readonly OverrideEntry[]
  replaced?: OverrideEntry
  by: string
  reason: string
}>

/** The table a merge's atomic push must carry forward, and the tip it leases. */
/** An override write refused before anything was pushed; the message is the whole answer. */
export class OverrideRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OverrideRefused"
  }
}

/** The empty table a missing ref stands for. */
export const NO_OVERRIDES: OverrideTable = Object.freeze({ entries: Object.freeze([]), sha: undefined })

/**
 * Whether an entry holds its check off at `now`: THE ONE PREDICATE. Every
 * reader asks it — the merge selection, the run header, `yrd list` and
 * `--list` — so an entry whose window has passed is off for none of them, with
 * or without its `expired` record.
 */
export function isActive(entry: OverrideEntry, now: number): boolean {
  return entry.state === "active" && entry.until.getTime() > now
}

/** The state a reader shows: `expired` from the record OR from the clock. */
export function stateAt(entry: OverrideEntry, now: number): OverrideState {
  return isActive(entry, now) ? "active" : "expired"
}

/**
 * Parse `--until`: an ISO instant, or HH:MM on the queue host's clock (the next
 * such time after `now`). Stored absolute; refused unless it is in the future
 * and within {@link OVERRIDE_MAX_HOURS} of `now` (@cto 462dfe95).
 */
export function parseUntil(text: string, now: number): Date {
  const trimmed = text.trim()
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(trimmed)
  let until: Date
  if (clock !== null) {
    until = new Date(now)
    until.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
    if (until.getTime() <= now) until.setDate(until.getDate() + 1)
  } else {
    until = new Date(trimmed)
    if (!/^\d{4}-\d{2}-\d{2}T/u.test(trimmed) || Number.isNaN(until.getTime())) {
      throw new OverrideRefused(
        `--until '${text}' is neither an ISO instant (2026-09-23T18:00:00Z) nor HH:MM on this host's clock`,
      )
    }
  }
  const limit = now + OVERRIDE_MAX_HOURS * 3_600_000
  if (until.getTime() <= now || until.getTime() > limit) {
    throw new OverrideRefused(
      `--until ${until.toISOString()} must be after now (${new Date(now).toISOString()}) and at most ` +
        `${String(OVERRIDE_MAX_HOURS)} h later (${new Date(limit).toISOString()})`,
    )
  }
  return until
}

export function decideOverride(
  previous: OverrideTable,
  write: OverrideWrite,
  declared: readonly string[],
  at: Date,
  where: string,
): OverrideDecision {
  const reason = oneLine(write.reason, "an override needs a --reason")
  const by = oneLine(write.actor.by, "an override needs an actor")
  if (!declared.includes(write.check)) {
    throw new OverrideRefused(
      `no merge check named '${write.check}' is declared; the declared merge checks are: ` +
        (declared.length === 0 ? "(none)" : declared.join(", ")),
    )
  }
  const standing = previous.entries.find((entry) => entry.check === write.check)
  const others = previous.entries.filter((entry) => entry.check !== write.check)
  if (write.kind === "off") {
    return {
      kind: standing === undefined ? "set" : "replaced",
      entries: [
        ...others,
        {
          by,
          check: write.check,
          reason,
          record: SELF,
          setAt: at,
          state: "active",
          until: write.until,
          verified: write.actor.verified,
        },
      ],
      ...(standing === undefined ? {} : { replaced: standing }),
      by,
      reason,
    }
  }
  if (standing === undefined) {
    throw new OverrideRefused(
      `no override stands on '${write.check}' to clear; ${where} holds ` +
        (previous.entries.length === 0 ? "no entries" : previous.entries.map((entry) => entry.check).join(", ")),
    )
  }
  return { kind: "clear", entries: others, replaced: standing, by, reason }
}

/** Whether an active entry is past halfway to its `until` and has not been reminded: the half-window reminder. */
export function reminderDue(entry: OverrideEntry, now: number): boolean {
  if (!isActive(entry, now) || entry.remindedAt !== undefined) return false
  const half = entry.setAt.getTime() + (entry.until.getTime() - entry.setAt.getTime()) / 2
  return now >= half
}

/** The one clock transition used by the legacy and event writers. */
export function decideOverrideClock(
  previous: OverrideTable,
  now: number,
): Readonly<{
  entries: readonly OverrideEntry[]
  expired: readonly OverrideEntry[]
  reminded: readonly OverrideEntry[]
}> {
  const expired = previous.entries.filter((entry) => entry.state === "active" && !isActive(entry, now))
  const reminded = previous.entries.filter((entry) => reminderDue(entry, now))
  const at = new Date(now)
  const entries = previous.entries.map((entry) =>
    expired.includes(entry)
      ? { ...entry, expiredAt: at, state: "expired" as const }
      : reminded.includes(entry)
        ? { ...entry, remindedAt: at }
        : entry,
  )
  return { entries, expired, reminded }
}

/**
 * Write the `expired` record for every entry whose window has passed at `now`
 * and has none yet, and mark every entry whose half-window reminder is due, in
 * ONE leased push, then return the table the round snapshots. Runs BEFORE the
 * round's snapshot (@cto 462dfe95), so the merge fence leases the post-write
 * tip; the round then notifies what this wrote (@cto ccd8dfa8), and because the
 * reminder is recorded on the chain it is never sent twice. A lost lease
 * re-reads, and an entry another runner already expired or reminded is left
 * alone. Past the bound, loud.
 */
export function overrideLine(entry: OverrideEntry, now: number): string {
  const verified = entry.verified ? "" : " (claimed)"
  if (isActive(entry, now)) {
    return `${entry.check} OFF until ${entry.until.toISOString()} (by ${entry.by}${verified}: ${entry.reason})`
  }
  return `${entry.check} override expired ${(entry.expiredAt ?? entry.until).toISOString()} (by ${entry.by}${verified})`
}

/** One override entry as every JSON reader and display carries it. */
export type OverrideFact = Readonly<{
  check: string
  state: OverrideState
  until: string
  by: string
  verified: boolean
  reason: string
  record: string
}>

/** The table as every JSON reader carries it: always an array, so its absence never reads as "no overrides". */
export function overrideFacts(table: OverrideTable, now: number): readonly OverrideFact[] {
  return table.entries.map((entry) => ({
    by: entry.by,
    check: entry.check,
    reason: entry.reason,
    record: entry.record,
    state: stateAt(entry, now),
    until: entry.until.toISOString(),
    verified: entry.verified,
  }))
}

/** A table entry as written: `SELF` stands for the record commit carrying it. */
type OverrideEntryDraft = Omit<OverrideEntry, "record"> & Readonly<{ record: string }>

/** The record commit's own sha, which it cannot contain: resolved at parse. */
const SELF = "self"

function oneLine(value: string, missing: string): string {
  const text = value.trim()
  if (text === "") throw new OverrideRefused(missing)
  if (text.includes("\n")) throw new OverrideRefused(`${missing}; it must be one line`)
  return text
}
