/**
 * A merge pause: one append-only record ref at the queue's remote.
 *
 * The ref is operational state, not queue configuration. Its latest commit is
 * the whole answer: `paused` stops queue work and `resumed` permits it. A
 * missing ref is the one honest resumed default; an unreadable ref is loud.
 */

import { ABSENT, RECORD_FORMAT, commitTrailers, type Git } from "./records.ts"
import { refAt } from "./git.ts"
import { pauseRef } from "./refs.ts"

export type PauseKind = "paused" | "resumed"

export type PauseRecord = Readonly<{
  kind: PauseKind
  sha: string
  at: Date
  reason: string
  by: string
}>

export type WritePause = Readonly<{
  kind: PauseKind
  reason: string
  by: string
}>

/** The resumed record and expected tip one atomic merge push must carry. */
export type ResumedFence = Readonly<{
  sha: string
  expected: string
  previous?: PauseRecord
}>

/** A normal operational refusal: the queue is intentionally paused. */
export class QueuePaused extends Error {
  readonly pause: PauseRecord

  constructor(pause: PauseRecord, remote: string, queue: string) {
    const selector = (remote === "origin" ? queue : `${remote}#${queue}`).replaceAll("'", "'\\''")
    super(
      `${pauseLine(pause)}; run yrd queue resume --queue '${selector}' --reason '<text>' to admit and merge work again`,
    )
    this.name = "QueuePaused"
    this.pause = pause
  }
}

/** A normal operational refusal: there is no active pause to end. */
export class QueueNotPaused extends Error {
  constructor() {
    super("the queue is not paused")
    this.name = "QueueNotPaused"
  }
}

/** The active pause, or undefined when the ref is absent or ends resumed. */
export async function activePause(git: Git, remote: string, queue: string): Promise<PauseRecord | undefined> {
  const record = await readPause(git, remote, queue)
  return record?.kind === "paused" ? record : undefined
}

/** Refuse while the remote's latest pause record is paused. */
export async function requireResumed(git: Git, remote: string, queue: string): Promise<void> {
  const pause = await activePause(git, remote, queue)
  if (pause !== undefined) throw new QueuePaused(pause, remote, queue)
}

/**
 * Read the latest pause record from the remote. Absence alone means resumed;
 * malformed, unreachable and unreadable state throws instead of opening the
 * queue on a guess.
 */
export async function readPause(git: Git, remote: string, queue: string): Promise<PauseRecord | undefined> {
  const ref = pauseRef(queue)
  const advertised = await pauseTip(git, remote, ref)
  if (advertised === undefined) return undefined
  await git(["fetch", "--quiet", "--no-tags", remote, `+${ref}:${ref}`])
  const fetched = await refAt(git, ref)
  if (fetched === undefined) {
    throw new Error(`${remote} advertised ${ref} at ${advertised}, but the fetch left no readable ref`)
  }
  return parsePause(git, fetched, `${remote} ${ref}`)
}

/** Append one paused or resumed record under a lease on the remote tip. */
export async function writePause(git: Git, remote: string, queue: string, write: WritePause): Promise<PauseRecord> {
  const ref = pauseRef(queue)
  const reason = oneLine(write.reason, "a pause record needs a reason")
  const by = oneLine(write.by, "a pause record needs an actor")
  const previous = await readPause(git, remote, queue)
  if (write.kind === "paused" && previous?.kind === "paused") throw new QueuePaused(previous, remote, queue)
  if (write.kind === "resumed" && previous?.kind !== "paused") throw new QueueNotPaused()
  const commit = await pauseCommit(git, previous, { ...write, by, reason })
  await git(["push", "--quiet", `--force-with-lease=${ref}:${previous?.sha ?? ABSENT}`, remote, `${commit}:${ref}`])
  await git(["update-ref", ref, commit])
  return parsePause(git, commit, `${remote} ${ref}`)
}

/**
 * Prepare the record that linearizes one merge against `queue pause`.
 *
 * Preparation moves no ref. The caller must include both the lease and
 * `${sha}:${PAUSE_REF}` in the SAME atomic push as the target and change
 * updates. An active pause is a normal refusal; unreadable authority is loud.
 */
export async function resumedFence(
  git: Git,
  remote: string,
  queue: string,
  write: Readonly<{ reason: string; by: string }>,
): Promise<ResumedFence> {
  const reason = oneLine(write.reason, "a pause fence needs a reason")
  const by = oneLine(write.by, "a pause fence needs an actor")
  const previous = await readPause(git, remote, queue)
  if (previous?.kind === "paused") throw new QueuePaused(previous, remote, queue)
  const sha = await pauseCommit(git, previous, { by, kind: "resumed", reason })
  return { expected: previous?.sha ?? ABSENT, previous, sha }
}

/** The operator-facing line shared by list, submit refusal and pause commands. */
export function pauseLine(record: PauseRecord): string {
  const since = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long" }).format(record.at)
  return `${record.kind} by ${record.by} since ${since}: ${record.reason}`
}

async function pauseTip(git: Git, remote: string, ref: string): Promise<string | undefined> {
  const rows = (await git(["ls-remote", "--refs", remote, ref]))
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
  if (rows.length === 0) return undefined
  if (rows.length !== 1) throw new Error(`${remote} answered with ${String(rows.length)} values for ${ref}`)
  const [sha, advertisedRef] = (rows[0] ?? "").split(/\s+/u)
  if (advertisedRef !== ref || sha === undefined || !/^[0-9a-f]+$/u.test(sha)) {
    throw new Error(`${remote} returned an unreadable ${ref} advertisement: ${rows[0]}`)
  }
  return sha
}

async function parsePause(git: Git, sha: string, where: string): Promise<PauseRecord> {
  const [commit, atText, block, body] = (await git(["log", "-1", `--format=${RECORD_FORMAT}`, sha])).split("\x00")
  const id = commit?.trim()
  const parsed = commitTrailers(block ?? "")
  const kinds = parsed.filter(([name]) => name === "Record").map(([, value]) => value)
  const kind = kinds[0]
  if (kinds.length !== 1 || (kind !== "paused" && kind !== "resumed")) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries no valid Record: paused|resumed trailer ` +
        `(found ${String(kinds.length)}; exactly one is required)`,
    )
  }
  const byKey = "Paused-By"
  const actors = parsed.filter(([name]) => name === byKey).map(([, value]) => value)
  const by = actors[0]
  if (actors.length !== 1 || by === undefined || by === "") {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries no single non-empty ${byKey}: trailer ` +
        `(found ${String(actors.length)})`,
    )
  }
  const reason = body?.split("\n")[0]?.trim()
  if (id === undefined || id === "" || atText === undefined || reason === undefined || reason === "") {
    throw new Error(`${where} at ${sha.slice(0, 12)} is not a readable pause record`)
  }
  const at = new Date(atText)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${where} at ${sha.slice(0, 12)} has an unreadable commit time '${atText}'`)
  }
  return Object.freeze({ at, by, kind, reason, sha: id })
}

async function pauseCommit(git: Git, previous: PauseRecord | undefined, write: WritePause): Promise<string> {
  const tree = (await git(["mktree"], "")).trim()
  const message = `${write.reason}\n\nRecord: ${write.kind}\nPaused-By: ${write.by}\n`
  const args = ["commit-tree", tree]
  if (previous !== undefined) args.push("-p", previous.sha)
  return (await git([...args, "-m", message])).trim()
}

function oneLine(value: string, missing: string): string {
  const text = value.trim()
  if (text === "") throw new Error(missing)
  if (text.includes("\n")) throw new Error(`${missing}; it must be one line`)
  return text
}
