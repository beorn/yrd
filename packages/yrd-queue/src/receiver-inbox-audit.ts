import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { QueueAuditFindingEmission } from "./model.ts"

/**
 * Read-only census of the Git push receiver's intake inbox — the half of a
 * receive-path failure that no other audit walk can see.
 *
 * Every `refs/for/` push leaves one durable JSON result in the receiver's inbox
 * (`<state>/receiver-inbox/<id>.prepared.json`, renamed to `.pending.json` at
 * post-receive) and the drain deletes it once the change is durably intaken.
 * Between those two moments the push is REAL — git applied the refs, and the
 * pusher was told the push succeeded — while the queue has no record of it.
 *
 * That window is supposed to be milliseconds. On 2026-08-31 it was not: the
 * post-receive drain's critical section had no bound at all, so a push waited
 * 102s and gave up, leaving refs applied and a result mid-flight. Every one of
 * the 25 existing audit findings reads the JOURNAL or git refs, so none of them
 * could name what was left behind — `submit-interrupted` comes closest and
 * still requires a revision that reached the journal, which is exactly what a
 * stranded result never did.
 *
 * The census is a census: it reads files, classifies by age, and acts on
 * nothing. A result younger than the grace window is ordinary in-flight work
 * and is deliberately not a finding — the drain defers by design now, and a
 * finding on every healthy push is the same defect pointed the other way.
 */
export type ReceiverInboxEntry = Readonly<{
  id: string
  state: "prepared" | "pending"
  branch: string
  /** The receiver's own stamp, or undefined when the file could not be parsed. */
  receivedAt: string | undefined
  ageMs: number | undefined
}>

export type ReceiverInboxCensus = Readonly<{
  /** Absent inbox — no receiver has ever run here. A real answer, not an empty one. */
  present: boolean
  dir: string
  scanned: number
  stranded: readonly ReceiverInboxEntry[]
  /** Results inside the grace window: in flight, deliberately not findings. */
  inFlight: readonly ReceiverInboxEntry[]
  /** Files in the inbox whose JSON could not be read — named, never dropped. */
  unreadable: readonly string[]
}>

/**
 * How long an inbox result may sit before it is wreckage rather than weather.
 *
 * Ten minutes is far past a healthy drain (sub-second) and past the 10s budget
 * one post-receive pass now gets, while staying under the resident runner's own
 * cadence so a genuinely stuck result is named within one operator glance.
 */
export const RECEIVER_INTAKE_GRACE_MS = 600_000

const RESULT_SUFFIXES = Object.freeze([".prepared.json", ".pending.json"] as const)
const PREVIEWED_ENTRIES = 5

function classify(name: string): { id: string; state: "prepared" | "pending" } | undefined {
  for (const suffix of RESULT_SUFFIXES) {
    if (!name.endsWith(suffix)) continue
    return { id: name.slice(0, -suffix.length), state: suffix === ".prepared.json" ? "prepared" : "pending" }
  }
  return undefined
}

/**
 * Census one receiver inbox directory. `nowMs` is injected so the grace window
 * is testable without sleeping, and so the audit's own clock is the one that
 * decides — never the filesystem's mtime, which a copy or a restore rewrites.
 */
export async function censusReceiverInbox(
  inboxDir: string,
  nowMs: number,
  graceMs: number = RECEIVER_INTAKE_GRACE_MS,
): Promise<ReceiverInboxCensus> {
  if (!existsSync(inboxDir)) {
    return Object.freeze({ present: false, dir: inboxDir, scanned: 0, stranded: [], inFlight: [], unreadable: [] })
  }
  const stranded: ReceiverInboxEntry[] = []
  const inFlight: ReceiverInboxEntry[] = []
  const unreadable: string[] = []
  let scanned = 0
  for (const name of (await readdir(inboxDir)).toSorted()) {
    const kind = classify(name)
    if (kind === undefined) continue
    scanned += 1
    const path = join(inboxDir, name)
    let branch = "<unparsed>"
    let receivedAt: string | undefined
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { branch?: unknown; receivedAt?: unknown }
      if (typeof parsed.branch === "string") branch = parsed.branch
      if (typeof parsed.receivedAt === "string") receivedAt = parsed.receivedAt
    } catch {
      // NOT a silent fallback: the file is recorded in `unreadable` and still
      // counted below, so an inbox full of corrupt results reads as a problem
      // rather than as an empty inbox. Rethrowing would let one bad file hide
      // every good one from the same census.
      unreadable.push(name)
    }
    const stampMs = receivedAt === undefined ? Number.NaN : Date.parse(receivedAt)
    const ageMs = Number.isFinite(stampMs) ? nowMs - stampMs : undefined
    const entry: ReceiverInboxEntry = Object.freeze({ id: kind.id, state: kind.state, branch, receivedAt, ageMs })
    // An unparseable stamp counts as stranded, not as in-flight: "we cannot
    // tell how old it is" must never resolve to "it is probably fine".
    if (ageMs === undefined || ageMs >= graceMs) stranded.push(entry)
    else inFlight.push(entry)
  }
  return Object.freeze({ present: true, dir: inboxDir, scanned, stranded, inFlight, unreadable })
}

function preview(entries: readonly ReceiverInboxEntry[]): string {
  const shown = entries
    .slice(0, PREVIEWED_ENTRIES)
    .map((entry) => `${entry.branch} (${entry.state}${entry.ageMs === undefined ? ", age unknown" : ""})`)
    .join(", ")
  return entries.length > PREVIEWED_ENTRIES ? `${shown} … and ${entries.length - PREVIEWED_ENTRIES} more` : shown
}

/**
 * Project a census into `queue audit` findings — one aggregated finding, the
 * same shape `submoduleAlternatesFindings` uses, specimen'd on the inbox dir so
 * page adapters dedupe one page per receiver.
 */
export function receiverInboxFindings(census: ReceiverInboxCensus): QueueAuditFindingEmission[] {
  if (!census.present || census.stranded.length === 0) return []
  const oldest = census.stranded
    .map((entry) => entry.ageMs)
    .filter((age): age is number => age !== undefined)
    .reduce((left, right) => Math.max(left, right), 0)
  return [
    {
      code: "receiver-intake-stranded",
      message:
        `${census.stranded.length} of ${census.scanned} receiver inbox result(s) in ${census.dir} have been waiting ` +
        `for intake${oldest > 0 ? ` (oldest ${String(Math.round(oldest / 1000))}s)` : ""} — each is a push git ` +
        `ACCEPTED whose change the queue cannot see yet — ${preview(census.stranded)}` +
        (census.unreadable.length > 0
          ? `; ${census.unreadable.length} file(s) unreadable: ${census.unreadable.join(", ")}`
          : ""),
      specimen: census.dir,
      resolution: [
        "Run any `yrd` command against this repository: an active runtime drains the receiver inbox at startup.",
        "If they do not clear, read the drain's own refusal — a result that fails validation stays pending and " +
          "reports its error every drain; the FIRST failed result for a branch carries the real cause.",
      ],
    },
  ]
}
