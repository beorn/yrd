/**
 * A11 — the S7 precondition made mechanical (READ-ONLY, run manually):
 * reports the live (non-terminal) record count and every record's delivery
 * state from the journal checkpoint. Under the S6 grandfathered-drain door the
 * store's write population is monotone-decreasing, so this number only falls;
 * the PR record store is deletable (S7) when this prints 0.
 *
 * Mirrors scripts/s6-door-preflight.ts's read style: the journal snapshot
 * (sqlite, readonly), no live app, writes nothing anywhere. Exit code 0 when
 * the read succeeded, whatever the count — this is a gauge, not a gate; S7's
 * ledger row cites its output.
 *
 *   bun scripts/s6-live-records.ts [repo=/hh/dev] [journal=<repo>/.git/yrd/journal.sqlite]
 */
import { Database } from "bun:sqlite"
import { changeDeliveryState, currentChangeRev, isLiveChange, type Change } from "../packages/yrd-bay/src/index.ts"

const repo = process.argv[2] ?? "/hh/dev"
const journalPath = process.argv[3] ?? `${repo}/.git/yrd/journal.sqlite`

const db = new Database(journalPath, { readonly: true, strict: true })
const row = db
  .query<{ checkpoint_json: string; cursor: number; checkpoint_identity: string }, []>(
    "SELECT checkpoint_json, cursor, checkpoint_identity FROM journal_snapshot WHERE singleton = 1",
  )
  .get()
db.close()
if (row === null) throw new Error("s6-live-records: no journal_snapshot row")
console.log(`journal checkpoint: cursor ${row.cursor}, identity ${row.checkpoint_identity}`)

const state = (JSON.parse(row.checkpoint_json) as { value?: { state?: Record<string, unknown> } }).value?.state as
  | { bays?: { prs?: Record<string, Change> } }
  | undefined
if (state?.bays?.prs === undefined) throw new Error("s6-live-records: checkpoint carries no bays.prs")
const prs = Object.values(state.bays.prs)

const live = prs.filter((pr) => isLiveChange(pr))
const terminal = prs.length - live.length
console.log(`\nlive records: ${live.length} (of ${prs.length} total; ${terminal} terminal)`)
for (const pr of live.toSorted((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }))) {
  const revision = currentChangeRev(pr)
  console.log(`  ${pr.id} ${changeDeliveryState(pr)} — ${pr.branch} rev ${revision.n} (${revision.head.slice(0, 12)})`)
}
console.log(
  live.length === 0
    ? "\nS7 precondition MET: zero live records — the store is drained and deletable."
    : `\nS7 precondition NOT met: ${live.length} record(s) must reach a terminal state first.`,
)
