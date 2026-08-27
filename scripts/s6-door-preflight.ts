/**
 * S6 door-2 pre-flight (READ-ONLY, run manually): proves the derived-member
 * regime's answers agree with the live record store before record WRITES are
 * retired (@i/10-merge-queue/s6-door-design; mirrors scripts/s4-parity-preflight.ts).
 *
 * Leg 1 — snapshot-sourced enrichment vs live records (the R3 risk): for every
 *         LIVE (non-terminal) record, the fields a re-sourced terminal event
 *         would emit from the retained `ChangeSnapshot` of the record's
 *         CURRENT revision must be value-identical to the record's own
 *         (branch/head/revision/issue/props/changeId). `submitter` is named,
 *         not diffed: the snapshot schema deliberately carries none, and the
 *         re-sourced emit omits it — the one accepted enrichment delta.
 * Leg 2 — the 9-cell record×submit corner table (§3 leg 3), each cell counted
 *         against the live journal THROUGH the real seam
 *         (`arbitrateDerivedChange`), zero-specimen cells named as zero, and
 *         the one impossible cell (none×same-sha) proven empty.
 * Leg 3 — mint high-water vs the frozen store's max (A9's precondition): the
 *         durable mint must already dominate the record numbers it survives.
 *
 * Reads: the journal snapshot (sqlite, readonly) and pr-mint.json beside it.
 * Writes nothing anywhere. Exit code 0 only when every leg is clean.
 */
import { Database } from "bun:sqlite"
import { dirname } from "node:path"
import { changeProps, currentChangeRev, isLiveChange, type Change } from "../packages/yrd-bay/src/index.ts"
import { createDurablePrNumberMint } from "../packages/yrd-persistence/src/index.ts"
import {
  arbitrateDerivedChange,
  latestChangeSnapshot,
  type DerivedChangeLane,
  type QueuesState,
} from "../packages/yrd-queue/src/model.ts"

const repo = process.argv[2] ?? "/hh/dev"
const journalPath = process.argv[3] ?? `${repo}/.git/yrd/journal.sqlite`

const db = new Database(journalPath, { readonly: true, strict: true })
const row = db
  .query<{ checkpoint_json: string; cursor: number; checkpoint_identity: string }, []>(
    "SELECT checkpoint_json, cursor, checkpoint_identity FROM journal_snapshot WHERE singleton = 1",
  )
  .get()
db.close()
if (row === null) throw new Error("s6-preflight: no journal_snapshot row")
console.log(`journal checkpoint: cursor ${row.cursor}, identity ${row.checkpoint_identity}`)

const state = (JSON.parse(row.checkpoint_json) as { value?: { state?: Record<string, unknown> } }).value?.state as
  | {
      bays?: { prs?: Record<string, Change>; submits?: Record<string, { sha: string; base: string; at: string }> }
      queues?: QueuesState
    }
  | undefined
if (state?.bays?.prs === undefined) throw new Error("s6-preflight: checkpoint carries no bays.prs")
if (state.bays.submits === undefined) throw new Error("s6-preflight: checkpoint carries no bays.submits")
if (state.queues === undefined) throw new Error("s6-preflight: checkpoint carries no queues state")
const prs = state.bays.prs
const submits = state.bays.submits
const queues = state.queues

let allClean = true

// Leg 1 — snapshot-sourced enrichment vs every live record.
const live = Object.values(prs).filter((pr) => isLiveChange(pr))
const enrichment = (pr: Change) => {
  const revision = currentChangeRev(pr)
  return {
    branch: pr.branch,
    head: revision.head,
    revision: revision.n,
    issue: pr.issue,
    props: changeProps(pr),
    changeId: revision.changeId,
  }
}
const canonical = (value: unknown): string =>
  value === undefined
    ? "∅"
    : JSON.stringify(value, (_key, entry: unknown) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)))
          : entry,
      )
let leg1Agree = 0
let leg1Unadmitted = 0
let leg1NeverAdmitted = 0
const leg1Disagree: string[] = []
const leg1Notes: string[] = []
for (const pr of live) {
  const wanted = enrichment(pr)
  const current = latestChangeSnapshot(queues, (s) => s.id === pr.id && s.revision === wanted.revision)
  if (current === undefined) {
    const any = latestChangeSnapshot(queues, (s) => s.id === pr.id)
    if (any === undefined) leg1NeverAdmitted += 1
    else leg1Unadmitted += 1
    continue
  }
  const derived = {
    branch: current.branch,
    head: current.headSha,
    revision: current.revision,
    issue: current.issue,
    props: current.props,
    changeId: current.changeId,
  }
  const diffs = (Object.keys(wanted) as (keyof typeof wanted)[]).filter(
    (field) => canonical(wanted[field]) !== canonical(derived[field]),
  )
  if (diffs.length === 0) leg1Agree += 1
  else {
    leg1Disagree.push(
      `${pr.id}: ${diffs.map((field) => `${field} record ${canonical(wanted[field])} ≠ snapshot ${canonical(derived[field])}`).join("; ")}`,
    )
  }
  const submitter = currentChangeRev(pr).submitter
  if (submitter !== undefined) {
    leg1Notes.push(`${pr.id}: submitter '${submitter}' is record-only (snapshot schema carries none — accepted delta)`)
  }
}
console.log(
  `\nLEG 1 — snapshot-sourced enrichment vs live records: ${leg1Agree}/${leg1Agree + leg1Disagree.length} agree, ` +
    `${leg1Disagree.length} disagree (${leg1Unadmitted} current-revision-unadmitted, ` +
    `${leg1NeverAdmitted} never-admitted, of ${live.length} live)`,
)
for (const line of leg1Disagree) console.log(`  DISAGREE ${line}`)
for (const line of leg1Notes) console.log(`  NOTE ${line}`)
if (leg1Disagree.length > 0) allClean = false

// Leg 2 — the 9-cell record×submit corner table, ruled by the real seam.
const branches = new Set<string>([...Object.values(prs).map((pr) => pr.branch), ...Object.keys(submits)])
const CELLS: ReadonlyArray<Readonly<{ record: string; submit: string; ruled: DerivedChangeLane | "impossible" }>> = [
  { record: "none", submit: "none", ruled: "none" },
  { record: "none", submit: "same-sha", ruled: "impossible" },
  { record: "none", submit: "different-sha", ruled: "derived" },
  { record: "live", submit: "none", ruled: "record" },
  { record: "live", submit: "same-sha", ruled: "record" },
  { record: "live", submit: "different-sha", ruled: "record" },
  { record: "terminal", submit: "none", ruled: "record" },
  { record: "terminal", submit: "same-sha", ruled: "record" },
  { record: "terminal", submit: "different-sha", ruled: "derived" },
]
const tally = new Map<string, { count: number; specimens: string[] }>()
const leg2Unexplained: string[] = []
for (const branch of [...branches].toSorted()) {
  const records = Object.values(prs).filter((pr) => pr.branch === branch)
  const verdict = arbitrateDerivedChange(records, submits[branch])
  const key = `${verdict.cell.record}×${verdict.cell.submit}`
  const cell = tally.get(key) ?? { count: 0, specimens: [] }
  cell.count += 1
  if (cell.specimens.length < 5) cell.specimens.push(branch)
  tally.set(key, cell)
  const ruled = CELLS.find((entry) => `${entry.record}×${entry.submit}` === key)?.ruled
  if (ruled === undefined || ruled === "impossible") {
    leg2Unexplained.push(`${branch}: occupies ${key}, which the design rules ${ruled ?? "NO CELL"}`)
  } else if (ruled !== verdict.lane) {
    leg2Unexplained.push(`${branch}: seam ruled '${verdict.lane}' but the design table says '${ruled}' for ${key}`)
  }
}
// The none×none cell is the empty universe (a branch with neither source never
// enumerates); every OTHER zero is a real measured zero.
console.log(
  `\nLEG 2 — record×submit corner table over ${branches.size} branches: ` +
    `${CELLS.length}/${CELLS.length} cells ruled, ${leg2Unexplained.length} unexplained`,
)
for (const cell of CELLS) {
  const key = `${cell.record}×${cell.submit}`
  const entry = tally.get(key)
  const note =
    cell.ruled === "impossible"
      ? "zero by construction (no record head to equal)"
      : key === "none×none"
        ? "unenumerable (a branch with neither source)"
        : `lane '${cell.ruled}'`
  const specimens = entry === undefined || entry.specimens.length === 0 ? "" : ` — ${entry.specimens.join(", ")}`
  console.log(`  ${key}: ${entry?.count ?? 0} — ${note}${specimens}`)
}
for (const line of leg2Unexplained) console.log(`  UNEXPLAINED ${line}`)
if (leg2Unexplained.length > 0) allClean = false

// Leg 3 — mint high-water vs the frozen store's max (A9 precondition).
const frozenMax = Math.max(
  0,
  ...Object.keys(prs)
    .filter((id) => /^PR\d+$/u.test(id))
    .map((id) => Number(id.slice(2))),
)
const highWater = createDurablePrNumberMint({ dir: dirname(journalPath) }).highWater()
const leg3Clean = highWater >= frozenMax
console.log(
  `\nLEG 3 — mint high-water vs frozen-store max: ${highWater} vs ${frozenMax} ` +
    (leg3Clean ? "OK (mint dominates; first derived member mints above both)" : "VIOLATION (mint is behind the store)"),
)
if (!leg3Clean) allClean = false

console.log(allClean ? "\ns6-preflight: CLEAN" : "\ns6-preflight: NOT CLEAN")
process.exitCode = allClean ? 0 : 1
