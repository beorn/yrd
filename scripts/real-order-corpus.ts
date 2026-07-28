/**
 * Regenerate `packages/yrd-core/tests/real-id-corpus.ts` from a real journal.
 *
 * The ordering guarantee `compareNatural` makes is only worth what the corpus
 * proving it is worth, and a synthetic corpus proves nothing about the strings
 * this system actually emits. So the fixture is sampled from a live journal —
 * deterministically, stratified across every identifier shape yrd sorts, so a
 * regeneration on a different journal still covers the same vocabulary.
 *
 *   bun scripts/real-order-corpus.ts <path/to/.git/yrd/journal.sqlite>
 *
 * There is no default path on purpose: a journal is machine-local state, and a
 * silent fallback to an empty or wrong corpus would turn this guard into
 * decoration. Missing or unreadable input throws.
 */
import { Database } from "bun:sqlite"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const journalPath = process.argv[2]
if (journalPath === undefined) {
  throw new Error("yrd: real-order-corpus needs a journal path: bun scripts/real-order-corpus.ts <journal.sqlite>")
}

/** Every field name the natural-order comparators read, plus timestamp and SHA
 * fields so the fixture also covers the shapes that must NOT be converted. */
const ID_KEYS = new Set([
  "id",
  "key",
  "pr",
  "run",
  "root",
  "bay",
  "base",
  "branch",
  "issue",
  "ref",
  "name",
  "at",
  "submittedAt",
  "startedAt",
  "createdAt",
  "pushedAt",
  "finishedAt",
  "requestedAt",
  "touchedAt",
  "lastAt",
  "firstAt",
  "rejectedAt",
  "withdrawnAt",
  "openedAt",
  "receivedAt",
  "mergedAt",
  "queueId",
  "candidateId",
  "terminalRun",
  "headSha",
  "baseSha",
  "sha",
  "head",
  "job",
])
/** Maps whose KEYS are the identifiers a comparator sorts. */
const KEYED_MAPS = new Set([
  "prs",
  "byId",
  "records",
  "counts",
  "queues",
  "admissionRefusals",
  "pauses",
  "heads",
  "jobs",
])

const strings = new Set<string>()
const add = (value: unknown): void => {
  if (typeof value === "string" && value.length > 0 && value.length < 400) strings.add(value)
}
const walk = (node: unknown, key: string | undefined): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, key)
    return
  }
  if (node !== null && typeof node === "object") {
    const keysAreIds = key !== undefined && KEYED_MAPS.has(key)
    for (const [childKey, childValue] of Object.entries(node as Record<string, unknown>)) {
      if (keysAreIds) add(childKey)
      walk(childValue, childKey)
    }
    return
  }
  if (key !== undefined && ID_KEYS.has(key)) add(node)
}

const database = new Database(journalPath, { readonly: true })
try {
  for (const row of database
    .query<{ checkpoint_json: string | null; prefix_json: string }, []>(
      "select checkpoint_json, prefix_json from journal_snapshot",
    )
    .all()) {
    walk(JSON.parse(row.prefix_json) as unknown, undefined)
    if (row.checkpoint_json !== null) walk(JSON.parse(row.checkpoint_json) as unknown, undefined)
  }
  for (const row of database.query<{ value_json: string }, []>("select value_json from journal_history").all()) {
    walk(JSON.parse(row.value_json) as unknown, undefined)
  }
} finally {
  database.close()
}

const corpus = [...strings]
if (corpus.length < 1000) {
  throw new Error(`yrd: '${journalPath}' yielded only ${corpus.length} identifier strings; that is not a real journal`)
}

const STRATA: readonly (readonly [string, RegExp, number])[] = [
  ["run ids", /^R\d+$/u, 70],
  ["pr ids", /^PR\d+$/u, 70],
  ["candidate ids", /^C\d+$/u, 50],
  ["bay ids", /^B\d+$/u, 50],
  ["issue refs", /^@/u, 70],
  ["branches", /^(?:task\/|wt\d)/u, 50],
  ["timestamps", /^\d{4}-\d{2}-\d{2}T/u, 40],
  ["shas", /^[0-9a-f]{40}$/u, 30],
  ["uuids", /^[0-9a-f]{8}-[0-9a-f]{4}-/u, 20],
]

const sampled: string[] = []
for (const [label, pattern, want] of STRATA) {
  const all = corpus.filter((value) => pattern.test(value)).sort()
  if (all.length === 0) throw new Error(`yrd: stratum '${label}' is empty; the extraction missed it`)
  const step = Math.max(1, Math.floor(all.length / want))
  const picked: string[] = []
  for (let index = 0; index < all.length && picked.length < want; index += step) picked.push(all[index] as string)
  console.error(`${label}: ${all.length} available -> ${picked.length} sampled`)
  sampled.push(...picked)
}

const fixture = [...new Set(sampled)].sort()
const header = `/**
 * Real identifier strings this system actually produced, sampled from the live
 * \`.git/yrd/journal.sqlite\` checkpoint + history (${corpus.length} distinct strings) by
 * stratified deterministic sampling across every identifier shape yrd sorts:
 * run ids, PR ids, candidate ids, bay ids, issue/bead refs, branch names, ISO
 * timestamps, 40-hex SHAs, and job UUIDs.
 *
 * Synthetic fixtures cannot prove an ordering change is safe — only the shapes
 * the running system emits can. Regenerate with
 * \`bun scripts/real-order-corpus.ts <journal.sqlite>\` if the identifier
 * vocabulary ever changes.
 */
export const REAL_ID_CORPUS: readonly string[] = [
`
const body = fixture.map((value) => `  ${JSON.stringify(value)},`).join("\n")
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "yrd-core", "tests", "real-id-corpus.ts")
await Bun.write(target, `${header}${body}\n]\n`)
console.error(`wrote ${fixture.length} strings -> ${target}`)
