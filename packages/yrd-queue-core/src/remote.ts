/**
 * The queue read: one reading of the remote that yields the queue, the
 * changes and where each stands (ruling E3).
 *
 * A branch is its ref at the `yrd` remote. A change is the ref
 * `refs/yrd/<queue>/<branch>@<sha>` beside it, and a branch with no change is
 * not a change (E2): the queue read lists what was submitted and nothing
 * else. The remote is the one store; a working repository is a reader that
 * fetches their captured objects before it reads. Nothing here stores a status: the queue
 * is read again from one remote advertisement every time it is asked for.
 * One object-only fetch brings the declared target, captured pause, change tips and
 * relevant branch heads without moving a local ref or writing `FETCH_HEAD`.
 * One no-walk log reads the tip records, then one batched ancestry walk
 * covers the distinct submitted heads. A detail view expands only its selected entries
 * through `readHistories` to recover phase-specific check evidence, and the
 * queue run expands exactly the entries whose tip could hide an ending
 * (`readObscuredEndings`, @i/10-yrd/24635). A remote with thousands of
 * unrelated branches therefore supplies no unrelated object
 * (E3; measured 2026-09-02: fetching 7,387 branches cost 17 s a round).
 */

import {
  changeOf,
  readRecords,
  recordFrom,
  standsEnded,
  tipRecord,
  trailer,
  type ChangeRecord,
} from "./legacy-records.ts"
import { GitExit, offTheTarget, type Git } from "./git.ts"
import { lineStop, parsePause, readPause, type PauseRecord } from "./pause.ts"
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

/** One captured queue reading whose exact-object fetch failed. */
export class CapturedQueueObjectsUnavailable extends Error {
  readonly kind = "captured-queue-objects-unavailable"

  constructor(
    readonly remote: string,
    readonly queue: string,
    readonly capturedTarget: string,
    readonly detail: string,
    cause: unknown,
  ) {
    super(
      `${remote}#${queue} at ${capturedTarget}: could not fetch captured queue objects; read the queue again: ${detail}`,
      { cause },
    )
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
  // Where every branch and every change stands at the remote, in one reading.
  // Every later operation uses these captured object ids, never a tracking or
  // queue ref that another reader or writer can move underneath it.
  const rows = (await git(["ls-remote", "--refs", remote])).split("\n")
  const heads = new Map<string, string>()
  const advertised = new Map<string, string>()
  const prefixes = ["refs/heads/", `${queueRefPrefix(target)}/`]
  const changeRefs: Array<Readonly<{ change: Change; oid: string; ref: string }>> = []
  let pauseSha: string | undefined
  for (const row of rows) {
    if (row === "") continue
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(refs\/[^\s]+)$/u.exec(row)
    const sha = match?.[1]
    const ref = match?.[2]
    if (sha === undefined || ref === undefined || advertised.has(ref)) {
      throw new Error(`${remote}#${target}: invalid or duplicate advertised ref ${JSON.stringify(row)}`)
    }
    advertised.set(ref, sha)
    if (ref === `refs/heads/${target}`) {
      continue
    } else if (ref.startsWith("refs/heads/")) {
      heads.set(ref.slice("refs/heads/".length), sha)
    } else if (ref === pause) {
      pauseSha = sha
    } else {
      const change = parseChangeRef(target, ref)
      // A ref named after the target is not a change, so the read yields none
      // for it: it is never judged, never given a record and never messaged
      // about, and above all it never accounts for a commit on the target's
      // own first-parent line, where an accounted commit hides every direct
      // at or below it (direct.ts; E5). `submit` refuses to open one, so this
      // is only about the ones a remote already holds.
      if (change !== undefined && change.branch !== target) changeRefs.push({ change, oid: sha, ref })
    }
  }
  const named = new Set(changeRefs.map(({ change }) => change.branch))
  const relevantHeads = [...named]
    .filter((branch) => branch !== target)
    .map((branch) => heads.get(branch))
    .filter((sha): sha is string => sha !== undefined)
  const objectIds = new Set([targetSha, ...changeRefs.map(({ oid }) => oid), ...relevantHeads])
  if (pauseSha !== undefined) objectIds.add(pauseSha)
  // These objects have no local ref. Keep Git's normal unreachable-object grace
  // while a reader uses them; never run `gc --prune=now` in an active workdir.
  // Empty refmaps and no FETCH_HEAD are what make concurrent readers observers
  // rather than writers. The target makes this list non-empty.
  try {
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      remote,
      ...objectIds,
    ])
  } catch (error) {
    const detail = error instanceof GitExit ? error.detail : error instanceof Error ? error.message : String(error)
    throw new CapturedQueueObjectsUnavailable(remote, target, targetSha, detail, error)
  }

  const tips = await tipRecords(git, changeRefs)
  const uniqueHeads = [...new Set(changeRefs.map(({ change }) => change.head))]
  const offTarget = await offTheTarget(git, uniqueHeads, targetSha)
  const capturedPause = pauseSha === undefined ? undefined : await parsePause(git, pauseSha, `${remote} ${pause}`)

  const entries: QueueEntry[] = []
  const checked: Array<QueueObservation["checked"][number]> = []
  for (const { change: submitted, ref, oid } of changeRefs) {
    const branchHead = heads.get(submitted.branch)
    const tip = tips.get(ref)
    // The ls-remote listed this change and the fetch was to bring it: a change
    // gone between the two readings is two moments, not one reading, and is loud.
    if (tip === undefined) {
      throw new Error(`${ref} was at ${remote} but not here after the fetch; read the queue again`)
    }
    if (tip.sha !== oid || advertised.get(ref) !== tip.sha) {
      throw new Error(`${remote}#${target}: record ${ref}@${tip.sha} does not match its captured advertisement ${oid}`)
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
    stuckEntry === undefined ? undefined : (await readHistories(git, [stuckEntry], remote, target))[0],
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
        refs: [...advertised]
          .filter(([ref]) => prefixes.some((prefix) => ref.startsWith(prefix)))
          .map(([ref, oid]) => ({ ref, oid })),
      },
    },
  }
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
  const hydrated: QueueEntry[] = []
  for (const entry of entries) {
    const tip = tipOf(entry.change).sha
    const records = await readRecords(git, tip)
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

/** Captured change-tip records, by advertised ref, without resolving a moving name. */
async function tipRecords(
  git: Git,
  captured: readonly Readonly<{ change: Change; oid: string; ref: string }>[],
): Promise<ReadonlyMap<string, ChangeRecord>> {
  if (captured.length === 0) return new Map()
  const oids = [...new Set(captured.map(({ oid }) => oid))]
  const out = await git(["log", "--no-walk", "--format=%H%x00%cI%x00%(trailers:only,unfold)%x00%B%x01", ...oids])
  const byOid = new Map<string, ChangeRecord | undefined>()
  for (const record of out.split("\x01")) {
    const [sha, at, block, body] = record.replace(/^\n/u, "").split("\x00")
    const oid = sha?.trim()
    if (oid === undefined || oid === "" || at === undefined || block === undefined || body === undefined) continue
    byOid.set(oid, recordFrom(oid, at, body, block))
  }
  const tips = new Map<string, ChangeRecord>()
  for (const { change, oid, ref } of captured) {
    const tip = tipRecord(byOid.get(oid), oid, ref)
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
