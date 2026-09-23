/**
 * A change's records, which are its commits ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The change).
 *
 * A change is the ref `refs/yrd/changes/<branch>@<sha>`, its name under the
 * one prefix. Its commits are the
 * only record the queue keeps: opened, then checked, then ended, then sent.
 * Each record is ONE commit, written once and never amended, so the ref only
 * moves forward and a reader can prove what happened from git alone.
 *
 * Shape of a record commit, and why:
 * - the tree is empty, because yrd stores no content of its own;
 * - the opened record has two parents, the genesis commit first and the change's
 *   head second, so the head stays reachable from the ref and survives every
 *   prune, and `git log --first-parent` from the tip reads exactly the records
 *   and stops at the genesis (measured 2026-09-02: with the head as the only
 *   parent, a plain log walks the whole project history);
 * - every later record has one parent, the record before it, except a checked
 *   intent's one valid `Merge:` trailer adds its candidate merge second; that
 *   retains the candidate without putting it in the first-parent record history;
 * - the message is a prose first line, then trailers, one meaning each, with
 *   `Record:` naming the kind, `Change:` naming the change the record is about and
 *   `Target:` naming the branch it merges into, both on every record,
 *   `Opened:`, `Submitter:` and `Issue:` carried forward from the first
 *   record, a sent record naming who it went to (`To:`) and how it went
 *   (`Delivery: sent`, `none` or `failed`) and, once a name is settled
 *   untold, `Not-Told:` (`notToldValue`), and an ended record's result
 *   carried onto its sent record, so the tip has the whole state/result answer
 *   needed by `yrd queue list` and one `for-each-ref` answers it with no history
 *   walk. Phase-specific `Check:` evidence stays on the record where it ran;
 *   one-change detail readers walk that history through `readHistories`.
 *
 * The genesis is one object: an empty-tree commit with a fixed author and
 * time, so it has the same sha in every repository and is written at most
 * once per repository.
 *
 * Writing uses Gitomic publication with the expected old value, so two writers
 * racing on one change lose loudly instead of interleaving.
 */

import { createShellBackend, type CommitMeta, type GitomicBackend } from "gitomic"
import type { Git } from "./git.ts"
import { changeName, changeRef, type Change } from "./refs.ts"

type LegacyBackend = GitomicBackend &
  Required<Pick<GitomicBackend, "fetchRefs" | "listRefs" | "publish" | "readHistory">>

/** The one Gitomic boundary used by the legacy format until #25041 deletes it. */
export type LegacyStore = Readonly<{ repo: string; backend: LegacyBackend }>

/**
 * Resolve the repository once, then require every Gitomic capability the
 * legacy adapter uses. The optional backend is an internal test seam; queue-core's
 * public functions keep their existing signatures.
 */
export async function legacyStore(git: Git, backend: GitomicBackend = createShellBackend()): Promise<LegacyStore> {
  const repo = (await git(["rev-parse", "--absolute-git-dir"])).trim()
  if (repo === "") throw new Error("legacy queue store: git rev-parse returned an empty repository store")
  for (const capability of ["fetchRefs", "listRefs", "publish", "readHistory"] as const) {
    if (typeof backend[capability] !== "function") {
      throw new Error(`legacy queue store: Gitomic backend lacks ${capability}`)
    }
  }
  return { repo, backend: backend as LegacyBackend }
}

/** The one word for a deferred record and state, kept behind one constant (CTO ruling 25029). */
export const DEFERRED_WORD = "deferred" as const
export const RECORD_KIND_DEFERRED = DEFERRED_WORD

/** The kinds a record can be. The vocabulary is closed. */
export const RECORD_KINDS = [
  "opened",
  "checked",
  "merged",
  "failed",
  "stuck",
  "withdrawn",
  "sent",
  RECORD_KIND_DEFERRED,
] as const

export type RecordKind = (typeof RECORD_KINDS)[number]

export type ChangeRecord = Readonly<{
  kind: RecordKind
  /** The record commit's own sha — the id of what happened. */
  sha: string
  /** When the record was written, from the commit itself. */
  at: Date
  /** The prose first line. */
  subject: string
  /** Trailers in order, repeats kept: a change can carry many `Check:` lines. */
  trailers: readonly (readonly [string, string])[]
}>

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
/** Git's expected-old value for a ref that must not exist yet. */
export const ABSENT = "0".repeat(40)
/** The one genesis object, byte for byte as git stores it; its sha follows from these bytes. */
const GENESIS_OBJECT = `tree ${EMPTY_TREE}\nauthor yrd <yrd@yrd> 0 +0000\ncommitter yrd <yrd@yrd> 0 +0000\n\nyrd: genesis\n`

export type WriteRecord = Readonly<{
  /** The change the record is about: a branch at a head, written as the one `Change:` trailer. */
  change: Change
  kind: RecordKind
  subject: string
  trailers?: readonly (readonly [string, string])[]
}>

/**
 * The trailers every record carries forward from the record before it, so the tip
 * record alone identifies the change: when it was first opened (its place in
 * line), by whom, and for which issue. Written on the first record from the
 * write itself and copied on every later one; a later write naming one of
 * them again (a retry names its submitter) wins.
 */
const CARRIED = ["Opened", "Submitter", "Issue"] as const

/**
 * One record, as every reader of a commit asks for it: the sha, the committer
 * date, git's own reading of the trailer block, and the raw message. `%B` is
 * last because it is the one field that holds newlines. `%x00` separates them.
 */
export const RECORD_FORMAT = "%H%x00%cI%x00%(trailers:only,unfold)%x00%B"

/**
 * A `checked` or `withdrawn` write that arrived on a chain which had already
 * ended (@i/10-yrd/24635, @i/10-yrd/24492). The refusal is correct in every
 * case; the TYPE exists because its two causes want opposite handling and the
 * message cannot tell them apart:
 *
 * - the queue lost track of an ended chain and tried to decide it anyway — a
 *   defect, and the crash that follows is the right outcome;
 * - the chain ended WHILE this run was judging it, which a withdraw is entitled
 *   to do at any moment (@i/10-yrd/24979). Nobody is at fault, the ending has
 *   already taken the change out of the line, and the round should discard its
 *   verdict and go on.
 *
 * The caller decides which it is from where it caught this, not from the text.
 */
export class DecisionAfterEnding extends Error {
  readonly endedAt: string
  readonly endedKind: string
  /** The write that was refused: a decision (`checked`) or a second ending (`withdrawn`). */
  readonly refused: "checked" | "withdrawn"

  constructor(
    message: string,
    about: Readonly<{ endedAt: string; endedKind: string; refused: "checked" | "withdrawn" }>,
  ) {
    super(message)
    this.name = "DecisionAfterEnding"
    this.endedAt = about.endedAt
    this.endedKind = about.endedKind
    this.refused = about.refused
  }
}

/**
 * The commit one record IS, written onto `parent` — the record the caller read this
 * change at, or undefined for a change's first record, which gets the genesis and
 * the head instead. No ref moves: the object is the record, and whoever pushes it
 * under a lease for `parent` is deciding whether it becomes the change's tip.
 *
 * The sha it returns is the id of what happened — a message about an ended
 * change carries it, so a resend after a crash is the same message rather than
 * a second one.
 */
export async function recordCommit(git: Git, write: WriteRecord, parent: string | undefined): Promise<string> {
  await recordRootChanges(git, write.trailers ?? [])
  const merges =
    write.kind === "checked"
      ? (write.trailers ?? []).filter(([name]) => name.toLowerCase() === "merge").map(([, value]) => value)
      : []
  if (merges.length > 1) {
    throw new Error(`checked record carries ${merges.length} Merge: trailers; one candidate merge is required`)
  }
  const merge = merges[0]
  if (merge !== undefined && !/^[0-9a-f]{40}$/iu.test(merge)) {
    throw new Error("checked record Merge: must name a full object id")
  }
  if (merge !== undefined && parent === undefined) {
    throw new Error("checked record Merge: requires a prior record")
  }
  // A decision cannot follow an ending. Round admission drops a chain that has
  // ended (state.ts reads the same resolver), so a checked record arriving
  // here on an ended chain is a defect — refused loudly, never appended where
  // it would hide the ending from every tip reader (@i/10-yrd/24635, @cto
  // 2026-09-16). A retry's opened record re-opens a chain, a sent record only
  // repeats its ending, and a stuck chain is still open, so all of those pass.
  //
  // ADMISSION IS NOT THE ONLY WAY IN (@i/10-yrd/24979). The sentence above
  // reasons from admission, and that reasoning is why this refusal was
  // classified as a defect: if a chain can only arrive here open, a refusal
  // means the queue lost track of it. But a withdraw may land AFTER admission,
  // while the check is running, and then a correct round reaches this line
  // through no fault of anybody's. The refusal is still right; what changes is
  // that its caller must be able to tell this race from a defect, which a bare
  // Error cannot say. The type carries the ending so `guarded` can name it.
  if ((write.kind === "checked" || write.kind === "withdrawn") && parent !== undefined) {
    const ended = endingRecord(await readRecords(git, parent))
    if (ended !== undefined) {
      throw new DecisionAfterEnding(
        `${write.kind} record refused for ${changeName(write.change)}: the chain already ended ${endedKind(ended)} at ${ended.sha.slice(0, 12)}; ${write.kind === "checked" ? "a decision cannot follow an ending (@i/10-yrd/24635)" : "a withdrawal cannot follow an ending (@i/10-yrd/24492)"}`,
        { endedAt: ended.sha, endedKind: endedKind(ended), refused: write.kind },
      )
    }
  }
  const parents =
    parent === undefined ? [await genesis(git), write.change.head] : merge === undefined ? [parent] : [parent, merge]
  const carried =
    parent === undefined ? [["Opened", new Date().toISOString()] as const] : await carriedFrom(git, parent)
  const named = new Set((write.trailers ?? []).map(([name]) => name))
  const message = recordMessage({
    ...write,
    trailers: [...carried.filter(([name]) => !named.has(name)), ...(write.trailers ?? [])],
  })
  const args = ["commit-tree", EMPTY_TREE]
  for (const on of parents) args.push("-p", on)
  return (await git([...args, "-m", message])).trim()
}

/** The approved root-entry facts; no child repository, remote or delivery policy. */
export type RootChanges = Readonly<{
  merge: string
  encoded: string
  changes: readonly Readonly<{ path: string; mode: "160000"; from: string; to: string }>[]
  /** Present only when read from the producer's temporary local ref. */
  receipt?: Readonly<{ ref: string; oid: string }>
}>

/** Read a live producer receipt, or validate its exact copied Root-Changes bytes. */
export async function readRootChanges(git: Git, merge: string, copied?: string): Promise<RootChanges | undefined> {
  const format = (await git(["rev-parse", "--show-object-format"])).trim()
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`Root-Changes: unsupported repository object format ${format}`)
  }
  const width = format === "sha1" ? 40 : 64
  const oid = (value: unknown): value is string =>
    typeof value === "string" && new RegExp(`^[0-9a-f]{${width}}$`, "u").test(value) && !/^0+$/u.test(value)
  function invalid(reason: string): never {
    throw new Error(`Root-Changes for ${merge}: ${reason}`)
  }
  if (!oid(merge)) invalid(`Merge must be a full ${format} commit OID`)
  let json: string
  let receipt: RootChanges["receipt"]
  if (copied === undefined) {
    const ref = `refs/git-super/receipts/${merge}`
    const store = await legacyStore(git)
    const receiptOid = (await store.backend.listRefs(store.repo, ref)).get(ref)
    if (receiptOid === undefined) return undefined
    if (!oid(receiptOid) || (await git(["cat-file", "-t", receiptOid])).trim() !== "commit") {
      invalid(`present receipt ref ${ref} does not name one commit`)
    }
    if ((await git(["show", "-s", "--format=%P", receiptOid])).trim() !== merge) {
      invalid(`receipt ${receiptOid} must have sole parent ${merge}`)
    }
    const tree = await git(["ls-tree", "-z", receiptOid])
    const file = /^100644 blob ([0-9a-f]+)\treceipt\.json\0$/u.exec(tree)
    const blob = file?.[1]
    if (!oid(blob)) invalid(`receipt ${receiptOid} must contain exactly one regular receipt.json blob`)
    json = await git(["cat-file", "blob", blob])
    // Text transport must round-trip the original blob, never replacement-decode invalid bytes.
    if ((await git(["hash-object", "--stdin"], json)).trim() !== blob) {
      invalid(`receipt.json at ${receiptOid} is not lossless UTF-8`)
    }
    receipt = { ref, oid: receiptOid }
  } else {
    if (copied === "" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(copied)) {
      invalid("copied trailer is not canonical base64")
    }
    const bytes = Buffer.from(copied, "base64")
    if (bytes.toString("base64") !== copied) invalid("copied trailer is not canonical base64")
    try {
      json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch (error) {
      throw new Error(`Root-Changes for ${merge}: copied trailer is not UTF-8`, { cause: error })
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`Root-Changes for ${merge}: receipt.json is not JSON`, { cause: error })
  }
  // JSON.parse owns grammar. Audit only object-key uniqueness, including escaped keys it would overwrite.
  const tokens = json.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:]/gu) ?? []
  const objects: (Set<string> | undefined)[] = []
  for (const [index, token] of tokens.entries()) {
    if (token === "{") objects.push(new Set())
    else if (token === "[") objects.push(undefined)
    else if (token === "}" || token === "]") objects.pop()
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const keys = objects.at(-1)
      const key = JSON.parse(token) as string
      if (keys === undefined || keys.has(key)) invalid(`duplicate JSON field ${key}`)
      keys.add(key)
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("payload must be an object")
  const value = parsed as Record<string, unknown>
  if (
    Object.keys(value).sort().join(",") !== "changes,merge,version" ||
    value.version !== 1 ||
    value.merge !== merge ||
    !Array.isArray(value.changes)
  ) {
    invalid("payload must have version 1, the exact Merge, and a changes array")
  }
  if ((await git(["cat-file", "-t", merge])).trim() !== "commit") invalid("Merge does not name a commit")
  const paths = new Set<string>()
  const changes: RootChanges["changes"][number][] = []
  for (const item of value.changes as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) invalid("change row must be an object")
    const row = item as Record<string, unknown>
    if (
      Object.keys(row).sort().join(",") !== "from,mode,path,to" ||
      row.mode !== "160000" ||
      typeof row.path !== "string" ||
      !oid(row.from) ||
      !oid(row.to)
    ) {
      invalid("change row requires path, mode 160000 and full from/to OIDs")
    }
    const path = row.path as string
    if (
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      Buffer.from(path, "utf8").toString("utf8") !== path ||
      paths.has(path)
    ) {
      invalid(`change path ${path} must be unique, root-relative UTF-8 without traversal`)
    }
    paths.add(path)
    const actual = await git(["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", merge, "--", path])
    if (actual !== `160000 commit ${row.to}\t${path}\0`) {
      invalid(`change ${path} mode/to does not match the exact Merge tree`)
    }
    changes.push({ path, mode: "160000", from: row.from as string, to: row.to as string })
  }
  return {
    merge,
    encoded: Buffer.from(json, "utf8").toString("base64"),
    changes,
    ...(receipt === undefined ? {} : { receipt }),
  }
}

/** The caller has published this durable record; only then may its exact temporary receipt ref be removed. */
export async function cleanupRootChanges(git: Git, rootChanges: RootChanges, durableRecord: string): Promise<void> {
  const retained = await recordRootChanges(git, (await readRecord(git, durableRecord)).trailers)
  if (retained?.merge !== rootChanges.merge || retained.encoded !== rootChanges.encoded) {
    throw new Error(`Root-Changes cleanup: record ${durableRecord} does not retain the exact validated receipt`)
  }
  if (rootChanges.receipt === undefined) return
  const current = await readRootChanges(git, rootChanges.merge)
  if (current === undefined) return
  if (
    current.receipt?.ref !== rootChanges.receipt.ref ||
    current.receipt.oid !== rootChanges.receipt.oid ||
    current.encoded !== rootChanges.encoded
  ) {
    throw new Error(`Root-Changes cleanup: ${rootChanges.receipt.ref} changed; preserve its unexpected value`)
  }
  const store = await legacyStore(git)
  await store.backend.publish(store.repo, [
    { ref: rootChanges.receipt.ref, expect: rootChanges.receipt.oid, oid: null },
  ])
}

async function recordRootChanges(
  git: Git,
  trailers: readonly (readonly [string, string])[],
  record?: Pick<ChangeRecord, "kind" | "sha">,
): Promise<RootChanges | undefined> {
  const values = trailers.filter(([name]) => name.toLowerCase() === "root-changes").map(([, value]) => value)
  if (values.length === 0) return undefined
  const merges = trailers.filter(([name]) => name.toLowerCase() === "merge").map(([, value]) => value)
  const merge = merges[0]
  const copied = values[0]
  if (values.length !== 1 || merges.length !== 1 || merge === undefined || copied === undefined) {
    throw new Error("Root-Changes record requires exactly one Root-Changes: and one Merge: trailer")
  }
  const rootChanges = await readRootChanges(git, merge, copied)
  if (record?.kind === "checked") {
    const parents = (await git(["show", "-s", "--format=%P", record.sha])).trim().split(" ")
    if (parents.length !== 2 || parents[1] !== merge) {
      throw new Error(`Root-Changes checked record ${record.sha} must retain Merge ${merge} as its second parent`)
    }
  }
  return rootChanges
}

/**
 * Append one record to a change's LOCAL ref, creating the change when this is its
 * first: read the tip, write the commit onto it, move the ref under a
 * compare-and-swap, so a second writer that read the same tip fails here
 * instead of silently overwriting the first. Git spells "the ref must not exist
 * yet" as the zero sha.
 *
 * `submit` writes this way, because the local ref is what its atomic push then
 * carries to the remote. A queue run does not: the remote's tip is its
 * authority and its own local ref is bookkeeping the next queue read
 * overwrites, so it writes the object with `recordCommit` and leases the push.
 */
export async function appendRecord(git: Git, queue: string, write: WriteRecord): Promise<string> {
  const ref = changeRef(queue, write.change)
  const store = await legacyStore(git)
  const tip = (await store.backend.listRefs(store.repo, ref)).get(ref)
  const sha = await recordCommit(git, write, tip)
  await store.backend.publish(store.repo, [{ ref, expect: tip ?? ABSENT, oid: sha }])
  return sha
}

/** Write the genesis object if this repository lacks it, and return its sha. */
async function genesis(git: Git): Promise<string> {
  return (await git(["hash-object", "-w", "-t", "commit", "--stdin"], GENESIS_OBJECT)).trim()
}

/** Read one exact commit through Gitomic's history seam. */
export async function readLegacyCommit(git: Git, sha: string): Promise<CommitMeta> {
  const store = await legacyStore(git)
  const [meta] = await store.backend.readHistory(store.repo, [sha], { limit: 1 })
  if (meta?.oid !== sha) throw new Error(`${sha.slice(0, 12)} is not a readable commit`)
  return meta
}

/**
 * The exact legacy pause bytes. Gitomic owns the ref, while this private
 * compatibility writer survives until #25041 deletes the legacy format.
 */
export async function legacyPauseCommit(
  git: Git,
  previous: Readonly<{ sha: string }> | undefined,
  write: Readonly<{
    kind: "paused" | "resumed"
    reason: string
    by: string
    cause?: "operator" | "stuck"
    change?: Change
    next?: string
  }>,
  pausedAt?: Date,
): Promise<string> {
  const tree = (await git(["mktree"], "")).trim()
  const trailers = [
    `Record: ${write.kind}`,
    `Paused-By: ${write.by}`,
    ...(pausedAt === undefined ? [] : [`Paused-At: ${pausedAt.toISOString()}`]),
    ...(write.kind === "paused" ? [`Cause: ${write.cause ?? "operator"}`] : []),
    ...(write.kind === "paused" && write.change !== undefined ? [`Change: ${changeName(write.change)}`] : []),
    ...(write.kind === "paused" && write.next !== undefined
      ? [`Next: ${write.next.replace(/\s+/gu, " ").trim()}`]
      : []),
  ]
  const message = `${write.reason}\n\n${trailers.join("\n")}\n`
  const args = ["commit-tree", tree]
  if (previous !== undefined) args.push("-p", previous.sha)
  return (await git([...args, "-m", message])).trim()
}

/** The record at `sha`. A commit there that is not a record is loud: a change's ref holds only records. */
export async function readRecord(git: Git, sha: string): Promise<ChangeRecord> {
  const record = recordFromMeta(await readLegacyCommit(git, sha))
  if (record === undefined) throw new Error(`${sha.slice(0, 12)} is not a record; a change's ref holds only records`)
  await recordRootChanges(git, record.trailers, record)
  return record
}

/** The carried trailers of the record at `sha`. */
async function carriedFrom(git: Git, sha: string): Promise<readonly (readonly [string, string])[]> {
  return (await readRecord(git, sha)).trailers.filter(([name]) => (CARRIED as readonly string[]).includes(name))
}

/**
 * Every record through the captured commit, oldest first. A `before..through`
 * selection returns only records after `before`, preserving the public range
 * contract used by notification receipt reads. Never re-read a moving ref.
 */
export async function readRecords(git: Git, from: string): Promise<readonly ChangeRecord[]> {
  const store = await legacyStore(git)
  const separator = from.indexOf("..")
  if (separator < 0) {
    const history = await store.backend.readHistory(store.repo, [from])
    return recordsFromHistory(git, history, from)
  }
  const before = from.slice(0, separator)
  const through = from.slice(separator + 2)
  const history = await store.backend.readHistory(store.repo, [through], { exclude: [before] })
  return recordsFromHistorySelection(git, history, through, false)
}

/**
 * Reconstruct one first-parent legacy chain from a possibly multi-tip Gitomic
 * history batch, preserving the legacy validation and oldest-first result.
 */
export async function recordsFromHistory(
  git: Git,
  history: readonly CommitMeta[],
  from: string,
): Promise<readonly ChangeRecord[]> {
  return recordsFromHistorySelection(git, history, from, true)
}

async function recordsFromHistorySelection(
  git: Git,
  history: readonly CommitMeta[],
  from: string,
  complete: boolean,
): Promise<readonly ChangeRecord[]> {
  const byOid = new Map(history.map((meta) => [meta.oid, meta] as const))
  const records: ChangeRecord[] = []
  let oid: string | null = from
  while (oid !== null) {
    const meta = byOid.get(oid)
    if (meta === undefined) {
      // A range deliberately excludes its lower bound and everything reachable
      // from it. The first missing first parent is therefore its exact end;
      // an unbounded history remains loud when Gitomic omitted a commit.
      if (!complete) break
      throw new Error(`history from ${from} did not include first-parent commit ${oid}`)
    }
    const parsed = recordFromMeta(meta)
    // The tip is the first record this reads, and the one check that these
    // records are in the format this code understands happens on it, once. It
    // comes BEFORE the walk's own ending below, because a captured tip that is not
    // a record at all is the very case that check is about.
    if (records.length === 0) {
      const where = parsed === undefined ? `history from ${from}` : `${changeOf(parsed, from)} history from ${from}`
      records.push(tipRecord(parsed, meta.oid, where))
      oid = meta.parent
      continue
    }
    // The first-parent walk ends at the genesis, which carries no `Record:`
    // trailer. That is where this change's history ends.
    if (parsed === undefined) break
    records.push(parsed)
    oid = meta.parent
  }
  for (const record of records) await recordRootChanges(git, record.trailers, record)
  return records.reverse()
}

/** Git's final trailer paragraph, preserving folded continuation values. */
export function legacyTrailers(message: string): readonly (readonly [string, string])[] {
  const paragraphs = message.trimEnd().split(/\n[ \t]*\n/u)
  if (paragraphs.length < 2) return []
  const parsed: Array<[string, string]> = []
  for (const line of (paragraphs.at(-1) ?? "").split("\n")) {
    if (/^[ \t]+/u.test(line)) {
      const previous = parsed.at(-1)
      if (previous === undefined) return []
      previous[1] = `${previous[1]} ${line.trim()}`
      continue
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]?(.*)$/u.exec(line)
    if (match === null) return []
    parsed.push([match[1] as string, match[2] ?? ""])
  }
  return parsed
}

/** Convert Gitomic's one batched history row into the unchanged legacy shape. */
export function recordFromMeta(meta: CommitMeta): ChangeRecord | undefined {
  const trailers = legacyTrailers(meta.message)
  const kind = trailers.find(([name]) => name === "Record")?.[1]
  if (kind === undefined || !isRecordKind(kind)) return undefined
  return {
    at: new Date(meta.timestamp * 1_000),
    kind,
    sha: meta.oid,
    subject: meta.message.split("\n")[0]?.trim() ?? "",
    trailers,
  }
}

/** The message one record commit carries. */
export function recordMessage(write: WriteRecord): string {
  const lines = [write.subject, "", `Record: ${write.kind}`, `Change: ${changeName(write.change)}`]
  for (const [name, value] of write.trailers ?? []) {
    if (value.includes("\n")) throw new Error(`trailer ${name} carries a newline; one trailer is one line`)
    lines.push(`${name}: ${value}`)
  }
  return `${lines.join("\n")}\n`
}

/**
 * What a merged record's — and its merge commit's — `Merged-By:` says: which
 * queue merged it, and which of that queue's runs. One formatter and one
 * reader, because the two places it is written must not drift.
 */
export function mergedBy(queue: string, run: string): string {
  return `yrd queue ${queue} [${run}]`
}

/**
 * The run id a `Merged-By:` value names, or undefined when no queue run made
 * this merge — `direct`, or anything a reader does not understand. What a
 * reader needs from the value is exactly that: the queue's own merges carry a
 * run, and a direct merge carries the word instead.
 */
export function mergedByRun(value: string | undefined): string | undefined {
  return value === undefined ? undefined : (/^yrd queue .+ \[([^\]]+)\]$/u.exec(value)?.[1] ?? undefined)
}

/** What a `Merged-By:` says when the merge went around the queue. */
export const DIRECT_MERGE = "direct"

/**
 * One name an ending did not reach, and why, as a sent record's `Not-Told:`
 * says it. `refused` is a transport that answered and refused the send: it is
 * written once and that name is never sent this ending again. `undelivered` is
 * a name that gave no receipt to its last attempt.
 */
export type NotTold = Readonly<
  { to: string } & ({ refused: string; undelivered?: undefined } | { refused?: undefined; undelivered: string })
>

/**
 * What one `Not-Told:` says: `<name> refused=<reason>` or `<name>
 * undelivered=<reason>`. One formatter and one reader, because every later sent
 * record of the same ending repeats the value and the tip is where it is read.
 */
export function notToldValue(
  to: string,
  why: Readonly<{ refused: string }> | Readonly<{ undelivered: string }>,
): string {
  return "refused" in why ? `${to} refused=${why.refused}` : `${to} undelivered=${why.undelivered}`
}

/**
 * A `Not-Told:` value read back. A value this reader cannot split still says
 * somebody was not told, so it degrades to that value as an undelivered name
 * with the reason saying so, and never throws: a list read that dies on one
 * record takes every other change down with it (24408).
 */
export function readNotTold(value: string): NotTold {
  const [, to, why, reason] = /^(.*?) (refused|undelivered)=(.*)$/u.exec(value) ?? []
  if (to === undefined || reason === undefined) return { to: value, undelivered: `unreadable Not-Told: ${value}` }
  return why === "refused" ? { refused: reason, to } : { to, undelivered: reason }
}

/** The first value of a trailer, or undefined. */
export function trailer(record: ChangeRecord, name: string): string | undefined {
  return record.trailers.find(([key]) => key === name)?.[1]
}

/**
 * The change a record is about, from its `Change:` trailer — `<branch>@<head>`,
 * the one spelling of a change's name (refs.ts), which `parseChangeName` reads
 * back into a branch and a head. `where` names the ref, so the refusal below
 * says which change is unreadable.
 *
 * Loud when the record carries none. There is no compatibility reader on
 * purpose: two spellings of a change's name in one store would defeat the
 * name.
 */
export function changeOf(record: ChangeRecord, where: string): string {
  const change = trailer(record, "Change")
  if (change === undefined) throw new Error(`${where} at ${record.sha.slice(0, 12)} carries no Change: trailer`)
  return change
}

/**
 * The record a change ref's tip IS, held to the format this code reads: a
 * `Record:` naming its kind and a `Change:` naming the change it is about.
 *
 * A reader that meets any other shape says which ref and commit are unreadable
 * and names the expected trailer.
 */
export function tipRecord(record: ChangeRecord | undefined, sha: string, where: string): ChangeRecord {
  if (record !== undefined) {
    changeOf(record, where)
    return record
  }
  throw new Error(`${where} at ${sha.slice(0, 12)} carries no valid Record: ${RECORD_KINDS.join("|")} trailer`)
}

/** Every value of a trailer, in order. */
export function trailers(record: ChangeRecord, name: string): readonly string[] {
  return record.trailers.filter(([key]) => key === name).map(([, value]) => value)
}

/** The kind a tip stands for: a sent record stands for the ended state it repeats (`State:`, ruling A2). */
export function endedKind(tip: ChangeRecord): RecordKind {
  if (tip.kind !== "sent") return tip.kind
  const state = trailer(tip, "State")
  return state === "merged" || state === "failed" || state === "stuck" || state === "withdrawn" || state === "deferred"
    ? state
    : "sent"
}

/**
 * The kinds that END a chain: merged, failed and withdrawn (an operator's own
 * ending, @i/10-yrd/24492). A stuck chain stays open — it keeps its place in
 * line and the next queue run takes it again (state.ts) — so stuck never ends
 * one.
 */
const ENDING_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>(["merged", "failed", "withdrawn"])

/** Whether this record stands for an ending (`endedKind` reads a sent record's `State:`). */
export function standsEnded(record: ChangeRecord): boolean {
  return ENDING_KINDS.has(endedKind(record))
}

/**
 * The chain's CURRENT ending record — the newest record standing for merged or
 * failed — or undefined for a chain that is still open. A later `opened`
 * record re-opens the chain: an unchanged head resubmitted after a failure is
 * a retry (submit.ts), and the ending it follows no longer governs. A checked,
 * stuck or sent record after an ending cannot hide it: reading the literal
 * tip is how a stray checked record hid a merged ending and made the queue
 * page its own merge as a direct merge (@i/10-yrd/24635).
 */
export function endingRecord(records: readonly ChangeRecord[]): ChangeRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record === undefined) continue
    if (record.kind === "opened") return undefined
    if (standsEnded(record)) return record
  }
  return undefined
}

/**
 * The chain's current ending through a possibly tip-only capture (remote.ts
 * reads the queue tip-only on purpose). The held records answer when they are
 * conclusive — they hold an ending, or they reach the chain's root, whose
 * first record is always the opened one (E2). A rootless capture whose scan
 * found nothing walks the stored chain from its captured tip instead; the
 * queue read fetched those objects. Without the walk, a stray record on the
 * tip hides the ending exactly as records.at(-1) did (@i/10-yrd/24635).
 */
export async function endingRecordThrough(
  git: Git,
  change: Readonly<{ records: readonly ChangeRecord[] }>,
): Promise<ChangeRecord | undefined> {
  const held = endingRecord(change.records)
  if (held !== undefined) return held
  if (change.records[0]?.kind === "opened") return undefined
  const tip = change.records.at(-1)
  if (tip === undefined || tip.kind === "opened") return undefined
  return endingRecord(await readRecords(git, tip.sha))
}

/** Parse Git's already-isolated, unfolded trailer block into ordered pairs. */
export function commitTrailers(trailerBlock: string): readonly (readonly [string, string])[] {
  const found: (readonly [string, string])[] = []
  for (const line of trailerBlock.split("\n")) {
    // git's own output, one trailer per line after `unfold`: the key is
    // everything before the first colon, which git has already validated.
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    found.push([line.slice(0, colon), line.slice(colon + 1).replace(/^ /u, "")] as const)
  }
  return found
}

/**
 * The record a commit is, from its sha, date, body, and Git-read trailers;
 * undefined when the commit is not one. Git decides which body lines form the
 * final trailer block and unfolds wrapped values before this parser sees it.
 */
export function recordFrom(sha: string, at: string, body: string, trailerBlock: string): ChangeRecord | undefined {
  const found = commitTrailers(trailerBlock)
  const kind = found.find(([name]) => name === "Record")?.[1]
  if (kind === undefined || !isRecordKind(kind)) return undefined
  return { at: new Date(at), kind, sha, subject: body.split("\n")[0]?.trim() ?? "", trailers: found }
}

function isRecordKind(value: string): value is RecordKind {
  return (RECORD_KINDS as readonly string[]).includes(value)
}
