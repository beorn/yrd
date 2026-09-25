/**
 * A merge-check override: one append-only record ref at the queue's remote
 * (@i/10-yrd/25296, @cto 842fdb30 and 462dfe95).
 *
 * `yrd queue override --check <name> --off --until <time> --reason <text>`
 * turns one declared check off AT MERGE ONLY, for a bounded window, without a
 * commit to the gated repository and without a restart. The ref lives beside
 * the pause, `refs/yrd/<queue>/override`, and like the pause its latest commit
 * is the whole answer: every record carries the COMPLETE table after its write,
 * and the parents are the audit history.
 *
 * What it never does: remove a declaration (the run's `checks` stay what
 * `.yrd.yml` says, so the driver identity and guard 2 keep reading the
 * scripts), touch submit (checked verdicts stay keyed by the config blob), or
 * outlive its window. An entry whose `until` has passed is EXPIRED for every
 * reader at once, by the clock, and reads as expired, never as absent; the
 * first round to see it also writes the `expired` record, in its own leased
 * push, before it takes the snapshot its merge fences on.
 *
 * A missing ref is the one honest empty table. An unreadable tip is loud: a
 * queue that cannot tell which checks are off runs none of them off.
 */

import { readRemoteCommit } from "./git.ts"
import { ABSENT, RECORD_FORMAT, commitTrailers } from "./legacy-records.ts"
import type { Git } from "./git.ts"
import { overrideRef } from "./refs.ts"

/** The longest window one override may hold a check off: a hard maximum, checked at write. */
export const OVERRIDE_MAX_HOURS = 12

/** A lost lease re-reads and tries again this many times, then fails naming the ref. */
const WRITE_ATTEMPTS = 3

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

export type OverrideRecordKind = "set" | "replaced" | "clear" | "expired" | "reminded" | "fence"

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
export type OverrideFence = Readonly<{ sha: string; expected: string }>

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

/** Read the table at the remote tip. Absence is the empty table; anything unreadable throws. */
export async function readOverrides(git: Git, remote: string, queue: string): Promise<OverrideTable> {
  const ref = overrideRef(queue)
  const captured = await readRemoteCommit(git, remote, ref)
  return captured === undefined ? NO_OVERRIDES : parseOverrides(git, captured, `${remote} ${ref}`)
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

/**
 * Append one set, replace or clear record under a lease on the remote tip.
 *
 * `declared` is the check names the target's `.yrd.yml` declares at merge, read
 * by the caller from the FETCHED target: an unknown name refuses naming them. A
 * second `off` on a check with an entry replaces it (`Replaces:`). A `clear` of
 * a check with no entry refuses naming the table. A lost lease re-reads and
 * decides again, a bounded number of times, then fails naming the ref.
 */
export async function writeOverride(
  git: Git,
  remote: string,
  queue: string,
  write: OverrideWrite,
  declared: readonly string[],
): Promise<Readonly<{ kind: OverrideRecordKind; record: OverrideTable; replaced?: OverrideEntry }>> {
  const ref = overrideRef(queue)
  let lastError: unknown
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const previous = await readOverrides(git, remote, queue)
    const decision = decideOverride(previous, write, declared, new Date(), `${remote} ${ref}`)
    const { kind, entries, replaced: standing, by, reason } = decision
    const trailers: string[] = [`Check: ${write.check}`]
    if (write.kind === "off") {
      trailers.push(`Until: ${write.until.toISOString()}`)
      if (standing !== undefined) trailers.push(`Replaces: ${standing.record}`)
    }
    const subject =
      write.kind === "off"
        ? `merge check ${write.check} off until ${write.until.toISOString()}: ${reason}`
        : `merge check ${write.check} back on: ${reason}`
    const commit = await overrideCommit(git, previous, kind, subject, entries, [
      ...trailers,
      `By: ${by}`,
      `By-Verified: ${String(write.actor.verified)}`,
      `Reason: ${reason}`,
    ])
    try {
      await git(["push", "--quiet", `--force-with-lease=${ref}:${previous.sha ?? ABSENT}`, remote, `${commit}:${ref}`])
    } catch (error) {
      lastError = error
      continue
    }
    const record = await parseOverrides(git, commit, `${remote} ${ref}`)
    return standing === undefined ? { kind, record } : { kind, record, replaced: standing }
  }
  throw new Error(
    `${remote} ${ref} moved under ${String(WRITE_ATTEMPTS)} override writes in a row; nothing was written: ` +
      String(lastError),
    { cause: lastError },
  )
}

/** One decision for both the legacy Record writer and the queue event writer. */
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
export async function expireOverrides(
  git: Git,
  remote: string,
  queue: string,
  now: number,
  by: string,
): Promise<Readonly<{ table: OverrideTable; expired: readonly OverrideEntry[]; reminded: readonly OverrideEntry[] }>> {
  const ref = overrideRef(queue)
  let lastError: unknown
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const previous = await readOverrides(git, remote, queue)
    const { entries, expired: due, reminded: remind } = decideOverrideClock(previous, now)
    if (due.length === 0 && remind.length === 0) return { expired: [], reminded: [], table: previous }
    const expiredNames = due.map((entry) => entry.check)
    const remindedNames = remind.map((entry) => entry.check)
    const subject =
      due.length > 0
        ? `merge check ${expiredNames.join(", ")} back on: override expired`
        : `merge check ${remindedNames.join(", ")} still off: half its window has passed`
    const commit = await overrideCommit(git, previous, due.length > 0 ? "expired" : "reminded", subject, entries, [
      ...expiredNames.map((name) => `Check: ${name}`),
      ...remindedNames.map((name) => `Reminded: ${name}`),
      `By: ${by}`,
      "By-Verified: false",
      `Reason: ${[
        ...due.map((entry) => `${entry.check} until ${entry.until.toISOString()} passed`),
        ...remind.map((entry) => `${entry.check} is past halfway to ${entry.until.toISOString()}`),
      ].join("; ")}`,
    ])
    try {
      await git(["push", "--quiet", `--force-with-lease=${ref}:${previous.sha ?? ABSENT}`, remote, `${commit}:${ref}`])
    } catch (error) {
      lastError = error
      continue
    }
    const table = await parseOverrides(git, commit, `${remote} ${ref}`)
    const written = (entry: OverrideEntry): OverrideEntry =>
      table.entries.find((next) => next.check === entry.check) ?? entry
    return { expired: due.map(written), reminded: remind.map(written), table }
  }
  throw new Error(
    `${remote} ${ref} moved under ${String(WRITE_ATTEMPTS)} expiry writes in a row; the round cannot take a snapshot: ` +
      String(lastError),
    { cause: lastError },
  )
}

/**
 * Prepare the commit that linearizes one merge against an override write.
 *
 * A no-op lease (the ref pushed at the value it is leased at) is checked only
 * on the client: git sends no update command for an up-to-date ref, so a write
 * landing after the advertisement is never seen by the server, and the merge
 * lands on a table it did not judge (measured, /hh/var/@dev3/25296
 * probe-noop-lease-server.log). So the fence ADVANCES the ref, as the pause
 * fence does: a new commit carrying the snapshot's table unchanged, leased at
 * the snapshot, in the SAME atomic push as the target. Preparation moves no ref.
 */
export async function overrideFence(
  git: Git,
  snapshot: OverrideTable,
  by: string,
  subject: string,
): Promise<OverrideFence> {
  const sha = await overrideCommit(
    git,
    snapshot,
    "fence",
    oneLine(subject, "an override fence names its merge"),
    snapshot.entries,
    [`By: ${oneLine(by, "an override fence needs an actor")}`, "By-Verified: false"],
  )
  return { expected: snapshot.sha ?? ABSENT, sha }
}

/** One operator line per entry, shared by `--list`, the run summary and the list header. */
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

async function overrideCommit(
  git: Git,
  previous: OverrideTable,
  kind: OverrideRecordKind,
  subject: string,
  entries: readonly OverrideEntryDraft[],
  trailers: readonly string[],
): Promise<string> {
  const tree = (await git(["mktree"], "")).trim()
  const table = entries.map(
    (entry) =>
      `Override: ${JSON.stringify({
        by: entry.by,
        check: entry.check,
        reason: entry.reason,
        record: entry.record,
        state: entry.state,
        setAt: entry.setAt.toISOString(),
        until: entry.until.toISOString(),
        verified: entry.verified,
        ...(entry.expiredAt === undefined ? {} : { expiredAt: entry.expiredAt.toISOString() }),
        ...(entry.remindedAt === undefined ? {} : { remindedAt: entry.remindedAt.toISOString() }),
      })}`,
  )
  const message = `${subject}\n\n${[`Record: ${kind}`, ...trailers, ...table].join("\n")}\n`
  const args = ["commit-tree", tree]
  if (previous.sha !== undefined) args.push("-p", previous.sha)
  return (await git([...args, "-m", message])).trim()
}

export async function parseOverrides(git: Git, sha: string, where: string): Promise<OverrideTable> {
  const [commit, , block] = (await git(["log", "-1", `--format=${RECORD_FORMAT}`, sha])).split("\x00")
  const id = commit?.trim()
  if (id === undefined || id === "") {
    throw new Error(`${where} at ${sha.slice(0, 12)} is not a readable override record`)
  }
  const parsed = commitTrailers(block ?? "")
  const kinds = parsed.filter(([name]) => name === "Record").map(([, value]) => value)
  if (kinds.length !== 1 || !["set", "replaced", "clear", "expired", "reminded", "fence"].includes(kinds[0] ?? "")) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries no valid Record: set|replaced|clear|expired|reminded|fence trailer ` +
        `(found ${String(kinds.length)}; exactly one is required)`,
    )
  }
  const entries = parsed
    .filter(([name]) => name === "Override")
    .map(([, value]) => parseEntry(value, id, `${where} at ${sha.slice(0, 12)}`))
  const checks = entries.map((entry) => entry.check)
  const twice = checks.find((check, index) => checks.indexOf(check) !== index)
  if (twice !== undefined) throw new Error(`${where} at ${sha.slice(0, 12)} holds two entries for check '${twice}'`)
  return Object.freeze({ entries: Object.freeze(entries), sha: id })
}

function parseEntry(value: string, self: string, where: string): OverrideEntry {
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch (error) {
    throw new Error(`${where} carries an unreadable Override: entry '${value}'`, { cause: error })
  }
  const field = (name: string): unknown =>
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[name] : undefined
  const text = (name: string): string => {
    const found = field(name)
    if (typeof found !== "string" || found === "") {
      throw new Error(`${where} carries an Override: entry with no ${name}: '${value}'`)
    }
    return found
  }
  const time = (name: string): Date => {
    const found = new Date(text(name))
    if (Number.isNaN(found.getTime())) {
      throw new Error(`${where} carries an Override: entry with an unreadable ${name}: '${value}'`)
    }
    return found
  }
  const state = text("state")
  if (state !== "active" && state !== "expired") {
    throw new Error(`${where} carries an Override: entry in an unknown state '${state}' (active or expired)`)
  }
  const verified = field("verified")
  if (typeof verified !== "boolean") {
    throw new Error(`${where} carries an Override: entry with no boolean verified: '${value}'`)
  }
  const record = text("record")
  return Object.freeze({
    by: text("by"),
    check: text("check"),
    reason: text("reason"),
    record: record === SELF ? self : record,
    setAt: time("setAt"),
    state,
    until: time("until"),
    verified,
    ...(field("expiredAt") === undefined ? {} : { expiredAt: time("expiredAt") }),
    ...(field("remindedAt") === undefined ? {} : { remindedAt: time("remindedAt") }),
  })
}

function oneLine(value: string, missing: string): string {
  const text = value.trim()
  if (text === "") throw new OverrideRefused(missing)
  if (text.includes("\n")) throw new OverrideRefused(`${missing}; it must be one line`)
  return text
}
