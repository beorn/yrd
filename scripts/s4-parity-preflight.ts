/**
 * S4 pre-flight parity (READ-ONLY, run manually): proves the live store's
 * delivery/merged claims agree with their replacements before the stored
 * `QueueAuthorityState.statuses` copy is deleted (22991 phase 2).
 *
 * Leg 1 — stored statuses vs the canonical record derivation
 *         (`changeDeliveryState`), per change.
 * Leg 2 — the store's merged claims vs the repository, via
 *         `compareMergedTruth` (ancestry + Change-Id trailer index).
 *
 * Reads: the journal snapshot (sqlite, readonly) and git plumbing. Writes
 * nothing anywhere.
 */
import { Database } from "bun:sqlite"
import { changeDeliveryState, type Change } from "../packages/yrd-bay/src/index.ts"
import { adaptProcessGit, createProcess } from "../packages/yrd-process/src/index.ts"
import {
  buildMergedTruthIndex,
  compareMergedTruth,
  type MergedTruthGit,
  type StoreMergedClaim,
} from "../packages/yrd-queue/src/merged-truth.ts"

const repo = process.argv[2] ?? "/hh/dev"
const journalPath = process.argv[3] ?? `${repo}/.git/yrd/journal.sqlite`

const db = new Database(journalPath, { readonly: true, strict: true })
const row = db
  .query<{ checkpoint_json: string; cursor: number; checkpoint_identity: string }, []>(
    "SELECT checkpoint_json, cursor, checkpoint_identity FROM journal_snapshot WHERE singleton = 1",
  )
  .get()
db.close()
if (row === null) throw new Error("s4-parity: no journal_snapshot row")
console.log(`journal checkpoint: cursor ${row.cursor}, identity ${row.checkpoint_identity}`)

const state = (JSON.parse(row.checkpoint_json) as { value?: { state?: Record<string, unknown> } }).value?.state as
  | {
      queues?: { authority?: { statuses?: Record<string, string> } }
      bays?: { prs?: Record<string, Change> }
    }
  | undefined
if (state?.bays?.prs === undefined) throw new Error("s4-parity: checkpoint carries no bays.prs")
const statuses = state.queues?.authority?.statuses ?? {}
const prs = state.bays.prs

// Leg 1 — the stored copy against the canonical derivation.
let leg1Agree = 0
const leg1Disagree: string[] = []
for (const [id, stored] of Object.entries(statuses)) {
  const pr = prs[id]
  if (pr === undefined) {
    leg1Disagree.push(`${id}: stored '${stored}' but no change record exists`)
    continue
  }
  const derived = changeDeliveryState(pr)
  if (derived === stored) leg1Agree += 1
  else leg1Disagree.push(`${id}: stored '${stored}', derived '${derived}'`)
}
console.log(`\nLEG 1 — stored statuses vs changeDeliveryState: ${leg1Agree} agree, ${leg1Disagree.length} disagree`)
for (const line of leg1Disagree) console.log(`  DISAGREE ${line}`)

// Leg 2 — merged claims against the repository.
await using runtime = createProcess({ cwd: repo })
const processGit = adaptProcessGit(runtime, { timeoutMs: 120_000 })
const git: MergedTruthGit = {
  run: async (cwd, args) => {
    const result = await processGit.run({ repo: cwd, args })
    if (result.code !== 0 || result.timedOut === true || result.failure !== undefined) {
      throw new Error(`s4-parity: git ${args.join(" ")} failed (${result.code}): ${result.stderr}`)
    }
    return result.stdout.trim()
  },
  optional: async (cwd, args) => {
    const result = await processGit.run({ repo: cwd, args })
    if (result.timedOut === true || result.failure !== undefined) {
      throw new Error(`s4-parity: git ${args.join(" ")} did not run: ${result.stderr}`)
    }
    return result.code === 0 ? result.stdout.trim() : undefined
  },
}
const index = await buildMergedTruthIndex(git, repo, { tip: "origin/main" })
console.log(
  `\nmerged-truth index: tip ${index.tip.slice(0, 12)}, ${index.commitsWalked} commits walked, ` +
    `${index.byChangeId.size} change ids, ${index.specimens.length} specimens`,
)
for (const specimen of index.specimens.slice(0, 20)) {
  console.log(`  SPECIMEN ${specimen.commit.slice(0, 12)} (${specimen.problem}) ${specimen.subject}`)
}
if (index.specimens.length > 20) console.log(`  … ${index.specimens.length - 20} more specimens`)

const claims: StoreMergedClaim[] = Object.values(prs).map((pr) => {
  const revs = pr.revs
  const last = revs[revs.length - 1]
  return {
    member: pr.id,
    ...(last?.changeId === undefined ? {} : { changeId: last.changeId }),
    ...(last?.head === undefined ? {} : { authoredTip: last.head }),
    merged: pr.merged,
    ...(pr.integration?.commit === undefined ? {} : { mergedCommit: pr.integration.commit }),
  }
})
const comparisons = await compareMergedTruth(git, index, claims)
const counts = { agree: 0, disagree: 0, unknown: 0 }
for (const comparison of comparisons) counts[comparison.agreement] += 1
console.log(`\nLEG 2 — compareMergedTruth over ${comparisons.length} claims:`)
console.log(`  agree ${counts.agree} · disagree ${counts.disagree} · unknown ${counts.unknown}`)
for (const comparison of comparisons) {
  if (comparison.agreement === "disagree") console.log(`  DISAGREE ${comparison.member}: ${comparison.detail}`)
}
const unknowns = comparisons.filter((comparison) => comparison.agreement === "unknown")
for (const comparison of unknowns.slice(0, 10)) {
  console.log(`  UNKNOWN ${comparison.member}: ${comparison.detail.slice(0, 160)}`)
}
if (unknowns.length > 10) console.log(`  … ${unknowns.length - 10} more unknowns`)
