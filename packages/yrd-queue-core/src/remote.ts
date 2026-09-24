/**
 * The queue read: one reading of the remote that yields the queue, the
 * changes and where each stands (ruling E3).
 *
 * A branch is its ref at the `yrd` remote. A change is the ref
 * `refs/yrd/<queue>/<branch>@<sha>` beside it, and a branch with no change is
 * not a change (E2): the queue read lists what was submitted and nothing
 * else. The remote is the one store; a working repository is a reader that
 * fetches their objects before it reads. Nothing here stores a status: the queue
 * is read again from the remote every time it is asked for. Gitomic lists branch
 * refs once, fetches the queue namespace once into its private namespace, and
 * reads every legacy chain in one first-parent history batch. A detail view
 * expands only its selected entries through `readHistories` to recover
 * phase-specific check evidence, and the
 * queue run expands exactly the entries whose tip could hide an ending
 * (`readObscuredEndings`, @i/10-yrd/24635). A remote with thousands of
 * unrelated branches therefore supplies no unrelated object
 * (E3; measured 2026-09-02: fetching 7,387 branches cost 17 s a round).
 */

import {
  changeOf,
  legacyStore,
  primeLegacyHistory,
  recordFromMeta,
  recordsFromHistory,
  standsEnded,
  tipRecord,
  trailer,
  type ChangeRecord,
} from "./legacy-records.ts"
import { offTheTarget, type Git } from "./git.ts"
import type { CommitMeta } from "./git.ts"
import { lineStop, pauseFromMeta, readPause, type PauseRecord } from "./pause.ts"
import { changeName, parseChangeRef, pauseRef, queueRefPrefix, type Change } from "./refs.ts"
import { readChange, tipOf, type ChangeRecords, type ChangeReading } from "./state.ts"

/** One change as the queue read sees it. */
export type QueueEntry = Readonly<{
  /** The change itself, its own branch and head included. */
  change: ChangeRecords
  reading: ChangeReading
}>

/** What one reading of the remote yields: every change, and where each stands. */
export type QueueRead = readonly QueueEntry[]

/** Root-only witnesses from the same advertisement as the queue records. */
export type QueueObservation = Readonly<{
  checked: readonly Readonly<{ mergeOid: string; recordRef: string; recordOid: string }>[]
  fence: Readonly<{ prefixes: readonly string[]; refs: readonly Readonly<{ ref: string; oid: string }>[] }>
}>

/** One captured queue reading whose object fetch failed. */
export class CapturedQueueObjectsUnavailable extends Error {
  readonly kind = "captured-queue-objects-unavailable"

  constructor(
    readonly remote: string,
    readonly queue: string,
    readonly capturedTarget: string,
    readonly detail: string,
    cause: unknown,
  ) {
    super(`${remote}#${queue} at ${capturedTarget}: could not fetch captured queue objects; read the queue again: ${detail}`, {
      cause,
    })
    this.name = "CapturedQueueObjectsUnavailable"
  }
}

/**
 * Every change at the remote, read: one entry per change ref, and nothing for
 * a branch nobody submitted (E2; `submit` is the one writer of a change), with
 * every entry judged against the caller's target commit. The caller supplies
 * that declaration-owning commit: a target moving after its declaration was
 * read belongs to the next round, not this one.
 *
 * Order is not decided here; `inLine` in state.ts is the one place that knows
 * the position in line.
 */
export async function readQueue(
  git: Git,
  remote: string,
  target: string,
  targetSha: string,
): Promise<
  Readonly<{
    changes: QueueRead
    pause: PauseRecord | undefined
    /** The stop that stands, derived from this same reading ({@link lineStop}); undefined while the line runs. */
    stop: PauseRecord | undefined
    observation: QueueObservation
    /**
     * Every branch this advertisement names but the target, at its advertised head: what a draft is read
     * from (drafts.ts), so drafts and changes share one reading of the remote and never a second one.
     */
    heads: ReadonlyMap<string, string>
  }>
> {
  const pause = pauseRef(target)
  const store = await legacyStore(git)
  // Branch names and queue records are separate authorities: listing heads
  // never fetches thousands of unrelated branch objects, while the prefix
  // fetch both names every legacy record ref and brings its history into
  // Gitomic's private namespace. Neither operation moves an application ref.
  const listedHeadRefs = await store.backend.listRefs(store.repo, "refs/heads/", remote)
  let queueRefs: ReadonlyMap<string, string>
  try {
    queueRefs = await store.backend.fetchRefs(store.repo, queueRefPrefix(target), remote)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CapturedQueueObjectsUnavailable(remote, target, targetSha, detail, error)
  }
  const headRefs = new Map(listedHeadRefs)
  const heads = new Map<string, string>()
  const prefixes = ["refs/heads/", `${queueRefPrefix(target)}/`]
  const changeRefs: Array<Readonly<{ change: Change; oid: string; ref: string }>> = []
  for (const [ref, oid] of headRefs) {
    if (ref !== `refs/heads/${target}`) heads.set(ref.slice("refs/heads/".length), oid)
  }
  for (const [ref, oid] of queueRefs) {
    if (ref === pause) continue
    const change = parseChangeRef(target, ref)
    // A ref named after the target is not a change, so the read yields none
    // for it: it is never judged, never given a record and never messaged
    // about, and above all it never accounts for a commit on the target's
    // own first-parent line, where an accounted commit hides every direct
    // at or below it (direct.ts; E5). `submit` refuses to open one, so this
    // is only about the ones a remote already holds.
    if (change !== undefined && change.branch !== target) changeRefs.push({ change, oid, ref })
  }

  // Listing heads avoids downloading thousands of unrelated draft objects.
  // Fetch only the current heads of submitted branches: readDrafts must be
  // able to date a branch pushed again after submit even when this clone has
  // never seen the new object. Deleted branches remain valid withdrawn changes
  // and therefore contribute no named ref to this exact fetch.
  const submittedHeadsByBranch = new Map<string, Set<string>>()
  for (const { change } of changeRefs) {
    const heads = submittedHeadsByBranch.get(change.branch) ?? new Set<string>()
    heads.add(change.head)
    submittedHeadsByBranch.set(change.branch, heads)
  }
  const submittedHeadRefs = [...submittedHeadsByBranch].flatMap(([branch, submittedHeads]) => {
    const ref = `refs/heads/${branch}`
    const advertised = headRefs.get(ref)
    return advertised !== undefined && !submittedHeads.has(advertised) ? [ref] : []
  })
  const missingHeadRefs = await missingObjects(
    git,
    submittedHeadRefs.map((ref) => ({ oid: headRefs.get(ref) as string, ref })),
  )
  if (missingHeadRefs.length > 0) {
    const fetchedHeads = await store.backend.fetchRefs(store.repo, missingHeadRefs, remote)
    for (const [ref, oid] of fetchedHeads) {
      headRefs.set(ref, oid)
      heads.set(ref.slice("refs/heads/".length), oid)
    }
  }

  const pauseSha = queueRefs.get(pause)
  const historyTips = [...new Set([...changeRefs.map(({ oid }) => oid), ...(pauseSha === undefined ? [] : [pauseSha])])]
  const history = await store.backend.readHistory(store.repo, historyTips)
  primeLegacyHistory(git, history)
  const byOid = new Map(history.map((meta) => [meta.oid, meta] as const))
  const tips = tipRecords(byOid, changeRefs)
  const uniqueHeads = [...new Set(changeRefs.map(({ change }) => change.head))]
  const offTarget = await offTheTarget(git, uniqueHeads, targetSha)
  const pauseMeta = pauseSha === undefined ? undefined : byOid.get(pauseSha)
  if (pauseSha !== undefined && pauseMeta === undefined) {
    throw new Error(`${remote} ${pause} at ${pauseSha.slice(0, 12)} was fetched but absent from the history batch`)
  }
  const capturedPause = pauseMeta === undefined ? undefined : pauseFromMeta(pauseMeta, `${remote} ${pause}`)

  const entries: QueueEntry[] = []
  const checked: Array<QueueObservation["checked"][number]> = []
  for (const { change: submitted, ref, oid } of changeRefs) {
    const branchHead = heads.get(submitted.branch)
    const tip = tips.get(ref)
    if (tip === undefined) {
      throw new Error(`${ref} at ${oid.slice(0, 12)} was fetched but absent from the history batch`)
    }
    if (tip.kind === "checked") {
      const merge = trailer(tip, "Merge")
      if (merge !== undefined) {
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(merge)) {
          throw new Error(`${ref}@${tip.sha}: checked Merge must name a full object ID`)
        }
        checked.push({ mergeOid: merge, recordRef: ref, recordOid: tip.sha })
      }
    }
    const isHeadOnTarget = !offTarget.has(submitted.head)
    const change: ChangeRecords = {
      ...(branchHead === undefined ? {} : { branchHead }),
      branch: submitted.branch,
      records: [tip],
      head: submitted.head,
      headOnTarget: isHeadOnTarget,
    }
    entries.push({ change, reading: readChange(change) })
  }
  // THE STOP, derived once per reading and never by a reader of its own
  // (pause.ts lineStop). A stuck stop is judged against its named change's
  // history, so exactly that one entry is expanded; every other entry keeps
  // the tip-only economy.
  const stuckOn = capturedPause?.kind === "paused" ? capturedPause.change : undefined
  const stuckEntry =
    stuckOn === undefined ? undefined : entries.find((entry) => changeName(entry.change) === changeName(stuckOn))
  const stop = lineStop(
    capturedPause,
    stuckEntry === undefined ? undefined : (await hydrateHistories(git, [stuckEntry], history, remote, target))[0],
  )
  return {
    changes: entries,
    heads,
    pause: capturedPause,
    stop,
    observation: {
      checked,
      fence: {
        prefixes,
        refs: [...headRefs, ...queueRefs]
          .filter(([ref]) => prefixes.some((prefix) => ref.startsWith(prefix)))
          .map(([ref, oid]) => ({ ref, oid })),
      },
    },
  }
}

/** The named refs whose advertised objects this clone lacks, in one local object query. */
async function missingObjects(
  git: Git,
  refs: readonly Readonly<{ oid: string; ref: string }>[],
): Promise<readonly string[]> {
  if (refs.length === 0) return []
  const output = await git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${refs.map(({ oid }) => oid).join("\n")}\n`,
  )
  const lines = output.trimEnd().split("\n")
  if (lines.length !== refs.length) {
    throw new Error(`git cat-file answered ${lines.length} submitted branch heads, expected ${refs.length}`)
  }
  return refs.flatMap(({ oid, ref }, index) => {
    const line = lines[index]
    if (line === `${oid} missing`) return [ref]
    if (line?.startsWith(`${oid} `)) return []
    throw new Error(`git cat-file gave a malformed answer for submitted branch head ${ref}: ${JSON.stringify(line)}`)
  })
}

/**
 * The pause record and the stop it derives, for a command that reads no queue
 * of its own (submit's echo, `queue pause` and `queue resume`). An operator's
 * record answers by itself; a stuck stop needs its change's reading, so only
 * then is the queue read, and the answer is that reading's own `stop` — the
 * same derivation a round makes, never a second one.
 */
export async function readStop(
  git: Git,
  remote: string,
  queue: string,
  targetSha: string,
): Promise<Readonly<{ pause: PauseRecord | undefined; stop: PauseRecord | undefined }>> {
  const pause = await readPause(git, remote, queue)
  if (pause?.kind !== "paused" || pause.cause !== "stuck") return { pause, stop: lineStop(pause, undefined) }
  const read = await readQueue(git, remote, queue, targetSha)
  return { pause: read.pause, stop: read.stop }
}

/**
 * Expand selected queue entries from their captured tip reading to their
 * full histories through their captured tips, never through a newer local ref.
 * Call this only for the entries a detail view opens; the queue-wide read stays tip-only.
 */
export async function readHistories(git: Git, entries: QueueRead, remote: string, queue: string): Promise<QueueRead> {
  if (entries.length === 0) return []
  const store = await legacyStore(git)
  const tips = [...new Set(entries.map((entry) => tipOf(entry.change).sha))]
  const history = await store.backend.readHistory(store.repo, tips)
  return hydrateHistories(git, entries, history, remote, queue)
}

async function hydrateHistories(
  git: Git,
  entries: QueueRead,
  history: Parameters<typeof recordsFromHistory>[1],
  remote: string,
  queue: string,
): Promise<QueueRead> {
  const hydrated: QueueEntry[] = []
  for (const entry of entries) {
    const tip = tipOf(entry.change).sha
    const records = await recordsFromHistory(git, history, tip)
    const first = records[0]
    if (first === undefined) {
      throw new Error(
        `${changeName(entry.change)} was listed at ${remote}#${queue} at ${tip} but its record history was absent after the queue read; run yrd queue show ${entry.change.branch} again`,
      )
    }
    const change: ChangeRecords = { ...entry.change, records: [first, ...records.slice(1)] }
    const expandedTip = tipOf(change).sha
    if (expandedTip !== tip) {
      throw new Error(`${changeName(change)} history ended at ${expandedTip}, not its captured tip ${tip}`)
    }
    // The full history can change the reading: an ending buried under a stray
    // later record is invisible to the captured tip (@i/10-yrd/24635), so a
    // kept tip-only reading would contradict the records beside it.
    hydrated.push({ ...entry, change, reading: readChange(change) })
  }
  return hydrated
}

/**
 * Expand only the entries whose captured tip cannot answer whether the chain
 * has ended: a tip that is neither an ending nor an opened record may be a
 * stray record appended after one, and a reader that trusts it re-judges — or
 * pages — a change whose chain is over (@i/10-yrd/24635). Everything else
 * keeps its tip-only capture, which is the queue-wide read's economy.
 */
export async function readObscuredEndings(
  git: Git,
  entries: QueueRead,
  remote: string,
  queue: string,
): Promise<QueueRead> {
  const suspect = entries.filter((entry) => {
    const tip = tipOf(entry.change)
    return tip.kind !== "opened" && !standsEnded(tip)
  })
  if (suspect.length === 0) return entries
  const expanded = new Map(
    (await readHistories(git, suspect, remote, queue)).map((entry) => [changeName(entry.change), entry]),
  )
  return entries.map((entry) => expanded.get(changeName(entry.change)) ?? entry)
}

/** Change-tip records from the one validated, batched history, by fetched ref. */
function tipRecords(
  byOid: ReadonlyMap<string, CommitMeta>,
  captured: readonly Readonly<{ change: Change; oid: string; ref: string }>[],
): ReadonlyMap<string, ChangeRecord> {
  if (captured.length === 0) return new Map()
  const tips = new Map<string, ChangeRecord>()
  for (const { change, oid, ref } of captured) {
    const meta = byOid.get(oid)
    const tip = tipRecord(meta === undefined ? undefined : recordFromMeta(meta), oid, ref)
    const expected = changeName(change)
    const actual = changeOf(tip, ref)
    if (actual !== expected) {
      throw new Error(`${ref} at ${oid.slice(0, 12)} carries Change: ${actual}, not ${expected}`)
    }
    tips.set(ref, tip)
  }
  return tips
}

/** The remotes this repository has, by name. */
export async function remoteNames(git: Git): Promise<readonly string[]> {
  return (await git(["remote"]))
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "")
}

/** The declared transport address, before Git's transport-only URL rewriting. */
export async function remoteUrl(git: Git, remote: string): Promise<string> {
  if (!(await remoteNames(git)).includes(remote)) {
    if (remote.includes(":") || remote.includes("/")) return remote
    throw new Error(`queue remote ${remote}: no configured remote or transport address`)
  }
  // Fetch uses the first URL; scalar config lookup returns the last. Keep
  // that same identity before insteadOf rewrites only the transport address.
  const url = (await git(["config", "--null", "--get-all", `remote.${remote}.url`])).split("\0")[0]
  if (url === undefined || url === "") {
    throw new Error(`queue remote ${remote}: expected remote.${remote}.url is missing or empty`)
  }
  return url
}

const YRD = "yrd"

/**
 * The remote name for a declared `remote:`: the name itself when the
 * repository has it; else the declaration is a URL and the remote is `yrd`,
 * added at that URL when missing (§ The change: `yrd submit` adds the `yrd`
 * remote from `.yrd.yml` when missing). A name that is neither is loud.
 */
export async function resolveRemote(git: Git, declared: string): Promise<string> {
  const names = await remoteNames(git)
  if (names.includes(declared)) return declared
  if (!declared.includes(":") && !declared.includes("/")) {
    throw new Error(`.yrd.yml remote: ${declared} is neither a remote of this repository nor a URL`)
  }
  if (names.includes(YRD)) {
    const url = await remoteUrl(git, YRD)
    if (url !== declared) throw new Error(`the remote ${YRD} is at ${url}, not at the declared ${declared}`)
    return YRD
  }
  await git(["remote", "add", YRD, declared])
  return YRD
}
