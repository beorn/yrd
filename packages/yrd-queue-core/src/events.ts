/**
 * A change's events, which are its commits ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The change).
 *
 * A change is the ref `refs/yrd/changes/<branch>@<sha>`, its name under the
 * one prefix. Its commits are the
 * only record the queue keeps: opened, then checked, then ended, then sent.
 * Each event is ONE commit, written once and never amended, so the ref only
 * moves forward and a reader can prove what happened from git alone.
 *
 * Shape of an event commit, and why:
 * - the tree is empty, because yrd stores no content of its own;
 * - the opened event has two parents, the genesis commit first and the change's
 *   head second, so the head stays reachable from the ref and survives every
 *   prune, and `git log --first-parent` from the tip reads exactly the events
 *   and stops at the genesis (measured 2026-09-02: with the head as the only
 *   parent, a plain log walks the whole project history);
 * - every later event has one parent, the event before it; the merge commit is
 *   never a parent;
 * - the message is a prose first line, then trailers, one meaning each, with
 *   `Event:` naming the kind, `Change:` naming the change the event is about and
 *   `Target:` naming the branch it lands on, both on every event,
 *   `Opened:`, `Submitter:` and `Issue:` carried forward from the first
 *   event, a sent event naming who it went to (`To:`) and how it went
 *   (`Delivery: sent`, `logged` or `failed`), and an ended event's result
 *   carried onto its sent event, so the tip
 *   event's trailers are the whole answer about the change and one
 *   `for-each-ref` answers `yrd queue list` with no history walk.
 *
 * The genesis is one object: an empty-tree commit with a fixed author and
 * time, so it has the same sha in every repository and is written at most
 * once per repository.
 *
 * Writing uses `update-ref` with the expected old value, so two writers racing
 * on one change lose loudly instead of interleaving.
 */

import { refAt } from "./git.ts"
import { changeName, changeRef, type Change } from "./refs.ts"

/** The kinds an event can be. The vocabulary is closed. */
export const EVENT_KINDS = ["opened", "checked", "merged", "failed", "stuck", "sent"] as const

export type EventKind = (typeof EVENT_KINDS)[number]

export type Event = Readonly<{
  kind: EventKind
  /** The event commit's own sha — the id of what happened. */
  sha: string
  /** When the event was written, from the commit itself. */
  at: Date
  /** The prose first line. */
  subject: string
  /** Trailers in order, repeats kept: a change can carry many `Check:` lines. */
  trailers: readonly (readonly [string, string])[]
}>

/** One git invocation, returning its stdout; `input` is its stdin. Throws on a non-zero exit. */
export type Git = (args: readonly string[], input?: string) => Promise<string>

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const ABSENT = "0".repeat(40)
/** The one genesis object, byte for byte as git stores it; its sha follows from these bytes. */
const GENESIS_OBJECT = `tree ${EMPTY_TREE}\nauthor yrd <yrd@yrd> 0 +0000\ncommitter yrd <yrd@yrd> 0 +0000\n\nyrd: genesis\n`

export type WriteEvent = Readonly<{
  /** The change the event is about: a branch at a head, written as the one `Change:` trailer. */
  change: Change
  target: string
  kind: EventKind
  subject: string
  trailers?: readonly (readonly [string, string])[]
}>

/**
 * The trailers every event carries forward from the event before it, so the tip
 * event alone identifies the change: when it was first opened (its place in
 * line), by whom, and for which issue. Written on the first event from the
 * write itself and copied on every later one; a later write naming one of
 * them again (a retry names its submitter) wins.
 */
const CARRIED = ["Opened", "Submitter", "Issue"] as const

/**
 * One event, as every reader of a commit asks for it: the sha, the committer
 * date, git's own reading of the trailer block, and the raw message. `%B` is
 * last because it is the one field that holds newlines. `%x00` separates them.
 */
const EVENT_FORMAT = "%H%x00%cI%x00%(trailers:only,unfold)%x00%B"

/**
 * The commit one event IS, written onto `parent` — the event the caller read this
 * change at, or undefined for a change's first event, which gets the genesis and
 * the head instead. No ref moves: the object is the event, and whoever pushes it
 * under a lease for `parent` is deciding whether it becomes the change's tip.
 *
 * The sha it returns is the id of what happened — a message about an ended
 * change carries it, so a resend after a crash is the same message rather than
 * a second one.
 */
export async function eventCommit(git: Git, write: WriteEvent, parent: string | undefined): Promise<string> {
  const parents = parent === undefined ? [await genesis(git), write.change.head] : [parent]
  const carried = parent === undefined ? [["Opened", new Date().toISOString()] as const] : await carriedFrom(git, parent)
  const named = new Set((write.trailers ?? []).map(([name]) => name))
  const message = eventMessage({ ...write, trailers: [...carried.filter(([name]) => !named.has(name)), ...(write.trailers ?? [])] })
  const args = ["commit-tree", EMPTY_TREE]
  for (const on of parents) args.push("-p", on)
  return (await git([...args, "-m", message])).trim()
}

/**
 * Append one event to a change's LOCAL ref, creating the change when this is its
 * first: read the tip, write the commit onto it, move the ref under a
 * compare-and-swap, so a second writer that read the same tip fails here
 * instead of silently overwriting the first. Git spells "the ref must not exist
 * yet" as the zero sha.
 *
 * `submit` writes this way, because the local ref is what its atomic push then
 * carries to the remote. A queue run does not: the remote's tip is its
 * authority and its own local ref is bookkeeping the next queue read
 * overwrites, so it writes the object with `eventCommit` and leases the push.
 */
export async function appendEvent(git: Git, write: WriteEvent): Promise<string> {
  const ref = changeRef(write.change)
  const tip = await refAt(git, ref)
  const sha = await eventCommit(git, write, tip)
  await git(["update-ref", ref, sha, tip ?? ABSENT])
  return sha
}

/** Write the genesis object if this repository lacks it, and return its sha. */
async function genesis(git: Git): Promise<string> {
  return (await git(["hash-object", "-w", "-t", "commit", "--stdin"], GENESIS_OBJECT)).trim()
}

/** The event at `sha`. A commit there that is not an event is loud: a change's ref holds only events. */
export async function readEvent(git: Git, sha: string): Promise<Event> {
  const [id, at, block, body] = (await git(["log", "-1", `--format=${EVENT_FORMAT}`, sha])).split("\x00")
  const event =
    id === undefined || at === undefined || block === undefined || body === undefined
      ? undefined
      : eventFrom(id.trim(), at, body, block)
  if (event === undefined) throw new Error(`${sha.slice(0, 12)} is not an event; a change's ref holds only events`)
  return event
}

/** The carried trailers of the event at `sha`. */
async function carriedFrom(git: Git, sha: string): Promise<readonly (readonly [string, string])[]> {
  return (await readEvent(git, sha)).trailers.filter(([name]) => (CARRIED as readonly string[]).includes(name))
}

/** Every event of a change, oldest first. An unknown change reads as no events. */
export async function readEvents(git: Git, change: Change): Promise<readonly Event[]> {
  const ref = changeRef(change)
  if ((await refAt(git, ref)) === undefined) return []
  // %x00 separates the fields and %x01 the records, because a commit message
  // holds newlines and a naive split would cut an event in half.
  const out = await git(["log", "--first-parent", `--format=${EVENT_FORMAT}%x01`, ref])
  const events: Event[] = []
  for (const record of out.split("\x01")) {
    const row = record.trim()
    if (row === "") continue
    const [sha, at, block, body] = row.split("\x00")
    if (sha === undefined || at === undefined || block === undefined || body === undefined) continue
    const parsed = eventFrom(sha, at, body, block)
    // The tip is the first record this reads, and the one check that these
    // events are in the format this code understands happens on it, once. It
    // comes BEFORE the walk's own ending below, because a ref whose tip is not
    // an event at all is the very case that check is about.
    if (events.length === 0) {
      events.push(tipEvent(parsed, block, ref))
      continue
    }
    // The first-parent walk ends at the genesis, which carries no `Event:`
    // trailer. That is where this change's history ends.
    if (parsed === undefined) break
    events.push(parsed)
  }
  return events.reverse()
}

/** The message one event commit carries. */
export function eventMessage(write: WriteEvent): string {
  const lines = [write.subject, "", `Event: ${write.kind}`, `Change: ${changeName(write.change)}`, `Target: ${write.target}`]
  for (const [name, value] of write.trailers ?? []) {
    if (value.includes("\n")) throw new Error(`trailer ${name} carries a newline; one trailer is one line`)
    lines.push(`${name}: ${value}`)
  }
  return `${lines.join("\n")}\n`
}

/**
 * What a merged event's — and its merge commit's — `Merged-By:` says: which
 * queue merged it, and which of that queue's runs. One formatter and one
 * reader, because the two places it is written must not drift.
 */
export function mergedBy(queue: string, run: string): string {
  return `yrd queue ${queue} [${run}]`
}

/**
 * The run id a `Merged-By:` value names, or undefined when no queue run made
 * this merge — `bypass`, or anything a reader does not understand. What a
 * reader needs from the value is exactly that: the queue's own merges carry a
 * run, and a bypass carries the word instead.
 */
export function mergedByRun(value: string | undefined): string | undefined {
  return value === undefined ? undefined : (/^yrd queue .+ \[([^\]]+)\]$/u.exec(value)?.[1] ?? undefined)
}

/** What a `Merged-By:` says when the merge went around the queue. */
export const BYPASS_MERGE = "bypass"

/** The first value of a trailer, or undefined. */
export function trailer(event: Event, name: string): string | undefined {
  return event.trailers.find(([key]) => key === name)?.[1]
}

/**
 * The change an event is about, from its `Change:` trailer — `<branch>@<head>`,
 * the one spelling of a change's name (refs.ts), which `parseChangeName` reads
 * back into a branch and a head. `where` names the ref, so the refusal below
 * says which change is unreadable.
 *
 * Loud when the event carries none. Events written before 2026-09-03 spelled the
 * change as a `Branch:` and `Head:` pair, and no reader here understands that
 * shape: reading it would mean two spellings of a change's name in the one
 * store, which is what the name exists to prevent. There is no compatibility
 * reader on purpose.
 */
export function changeOf(event: Event, where: string): string {
  const change = trailer(event, "Change")
  if (change === undefined) throw preFormat(where, `its event ${event.sha.slice(0, 12)} carries no Change: trailer`)
  return change
}

/**
 * The event a change ref's tip IS, held to the format this code reads: an
 * `Event:` naming its kind and a `Change:` naming the change it is about.
 *
 * Both halves changed on 2026-09-03 — the kind was `Fact:` and the change was a
 * `Branch:` and `Head:` pair — and there is no compatibility reader for either,
 * on purpose: two spellings of one thing in the one store is what a name exists
 * to prevent. So a reader that meets the old shape says which ref it is and
 * what the queue mechanic does about it, rather than "this ref does not end in
 * an event", which reads like corruption.
 */
export function tipEvent(event: Event | undefined, trailerBlock: string, where: string): Event {
  if (event !== undefined) {
    changeOf(event, where)
    return event
  }
  if (/^Fact:/mu.test(trailerBlock)) throw preFormat(where, "its tip carries Fact: where an Event: belongs")
  throw new Error(`${where} does not end in an event; a change's ref holds only events`)
}

/** The one refusal every pre-format reading earns, and the one cure it names. */
function preFormat(where: string, what: string): Error {
  return new Error(
    `${where}: ${what}. These events predate the 2026-09-03 format and no reader understands them; the queue ` +
      "mechanic bundles and deletes them — `git bundle create <file> refs/yrd/changes/*`, then delete the refs.",
  )
}

/** Every value of a trailer, in order. */
export function trailers(event: Event, name: string): readonly string[] {
  return event.trailers.filter(([key]) => key === name).map(([, value]) => value)
}

/** The kind a tip stands for: a sent event stands for the ended state it repeats (`State:`, ruling A2). */
export function endedKind(tip: Event): EventKind {
  if (tip.kind !== "sent") return tip.kind
  const state = trailer(tip, "State")
  return state === "merged" || state === "failed" || state === "stuck" ? state : "sent"
}

/**
 * The event a commit is, from its sha, committer date, message and the trailer
 * block GIT read out of it; undefined when the commit is not one.
 *
 * The trailers are git's own reading, never a second parser of the same
 * bytes: a hand-rolled `^Key: value$` scan called every prose line that looks
 * like a trailer one — `Note: fix` in the middle of a body became a `Note`
 * trailer and stood in the derived state — while git knows a trailer block is
 * the LAST paragraph and folds a wrapped value back into one line.
 */
export function eventFrom(sha: string, at: string, body: string, trailerBlock: string): Event | undefined {
  const found: (readonly [string, string])[] = []
  for (const line of trailerBlock.split("\n")) {
    // git's own output, one trailer per line after `unfold`: the key is
    // everything before the first colon, which git has already validated.
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    found.push([line.slice(0, colon), line.slice(colon + 1).replace(/^ /u, "")] as const)
  }
  const kind = found.find(([name]) => name === "Event")?.[1]
  if (kind === undefined || !isEventKind(kind)) return undefined
  return { at: new Date(at), kind, sha, subject: body.split("\n")[0]?.trim() ?? "", trailers: found }
}

function isEventKind(value: string): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(value)
}
