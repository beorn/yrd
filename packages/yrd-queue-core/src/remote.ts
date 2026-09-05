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
 * One object-only fetch brings the captured target, pause, change tips and
 * relevant branch heads without moving a local ref or writing `FETCH_HEAD`.
 * One no-walk log reads the tip records, then ancestry is asked once per
 * distinct submitted head. A detail view expands only its selected entries
 * through `readHistories` to recover phase-specific check evidence. A remote
 * with thousands of unrelated branches therefore supplies no unrelated object
 * (E3; measured 2026-09-02: fetching 7,387 branches cost 17 s a round).
 */

import { changeOf, readRecords, recordFrom, tipRecord, type ChangeRecord, type Git } from "./records.ts"
import { isAncestor } from "./git.ts"
import { parsePause, type PauseRecord } from "./pause.ts"
import { changeName, parseChangeRef, pauseRef, type Change } from "./refs.ts"
import { readChange, tipOf, type ChangeRecords, type ChangeReading } from "./state.ts"

/** One change as the queue read sees it. */
export type QueueEntry = Readonly<{
  /** The change itself, its own branch and head included. */
  change: ChangeRecords
  reading: ChangeReading
}>

/** What one reading of the remote yields: every change, and where each stands. */
export type QueueRead = readonly QueueEntry[]

/**
 * Every change at the remote, read: one entry per change ref, and nothing for
 * a branch nobody submitted (E2; `submit` is the one writer of a change), plus
 * the commit the target stood at in that same reading.
 *
 * The target's commit is the queue read's own answer, not a second question:
 * the `ls-remote` below already carries it and the fetch below already brings
 * it, so every caller that used to ask again — the queue run with an
 * `ls-remote` and a fetch of its own, `queue list` with a local re-read that
 * only worked because this fetch had run first — reads it from here.
 *
 * Order is not decided here; `inLine` in state.ts is the one place that knows
 * the position in line.
 */
export async function readQueue(
  git: Git,
  remote: string,
  target: string,
): Promise<Readonly<{ target: string; changes: QueueRead; pause: PauseRecord | undefined }>> {
  const pause = pauseRef(target)
  // Where every branch and every change stands at the remote, in one reading.
  // Every later operation uses these captured object ids, never a tracking or
  // queue ref that another reader or writer can move underneath it.
  const rows = (await git(["ls-remote", "--refs", remote])).split("\n")
  const heads = new Map<string, string>()
  const changeRefs: Array<Readonly<{ change: Change; oid: string; ref: string }>> = []
  let targetSha: string | undefined
  let pauseSha: string | undefined
  for (const row of rows) {
    const [sha, ref] = row.trim().split(/\s+/u)
    if (sha === undefined || ref === undefined) continue
    if (ref === `refs/heads/${target}`) {
      targetSha = sha
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
  if (targetSha === undefined) throw new Error(`the target ${target} is not at ${remote}`)

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

  const tips = await tipRecords(git, changeRefs)
  const headOnTarget = new Map<string, boolean>()
  const capturedPause = pauseSha === undefined ? undefined : await parsePause(git, pauseSha, `${remote} ${pause}`)

  const entries: QueueEntry[] = []
  for (const { change: submitted, ref } of changeRefs) {
    const branchHead = heads.get(submitted.branch)
    const tip = tips.get(ref)
    // The ls-remote listed this change and the fetch was to bring it: a change
    // gone between the two readings is two moments, not one reading, and is loud.
    if (tip === undefined) {
      throw new Error(`${ref} was at ${remote} but not here after the fetch; read the queue again`)
    }
    let isHeadOnTarget = headOnTarget.get(submitted.head)
    if (isHeadOnTarget === undefined) {
      isHeadOnTarget = await isAncestor(git, submitted.head, targetSha)
      headOnTarget.set(submitted.head, isHeadOnTarget)
    }
    const change: ChangeRecords = {
      ...(branchHead === undefined ? {} : { branchHead }),
      branch: submitted.branch,
      records: [tip],
      head: submitted.head,
      headOnTarget: isHeadOnTarget,
    }
    entries.push({ change, reading: readChange(change) })
  }
  return { changes: entries, pause: capturedPause, target: targetSha }
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
    hydrated.push({ ...entry, change })
  }
  return hydrated
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
    const url = (await git(["remote", "get-url", YRD])).trim()
    if (url !== declared) throw new Error(`the remote ${YRD} is at ${url}, not at the declared ${declared}`)
    return YRD
  }
  await git(["remote", "add", YRD, declared])
  return YRD
}
