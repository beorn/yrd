/**
 * A merge freeze: one append-only record ref at the queue's remote.
 *
 * The ref is operational state, not queue configuration. Its latest commit is
 * the whole answer: `frozen` stops queue work and `unfrozen` permits it. A
 * missing ref is the one honest unfrozen default; an unreadable ref is loud.
 */

import { ABSENT, RECORD_FORMAT, commitTrailers, type Git } from "./records.ts"
import { refAt } from "./git.ts"

export const FREEZE_REF = "refs/yrd/freeze"

export type FreezeKind = "frozen" | "unfrozen"

export type FreezeRecord = Readonly<{
  kind: FreezeKind
  sha: string
  at: Date
  reason: string
  by: string
}>

export type WriteFreeze = Readonly<{
  kind: FreezeKind
  reason: string
  by: string
}>

/** The unfrozen record and expected tip one atomic merge push must carry. */
export type UnfrozenFence = Readonly<{
  sha: string
  expected: string
  previous?: FreezeRecord
}>

/** A normal operational refusal: the queue is intentionally frozen. */
export class QueueFrozen extends Error {
  readonly freeze: FreezeRecord

  constructor(freeze: FreezeRecord) {
    super(`${freezeLine(freeze)}; run 'yrd queue unfreeze [reason]' to admit and merge work again`)
    this.name = "QueueFrozen"
    this.freeze = freeze
  }
}

/** A normal operational refusal: there is no active freeze to end. */
export class QueueNotFrozen extends Error {
  constructor() {
    super("the queue is not frozen")
    this.name = "QueueNotFrozen"
  }
}

/** The active freeze, or undefined when the ref is absent or ends unfrozen. */
export async function activeFreeze(git: Git, remote: string): Promise<FreezeRecord | undefined> {
  const record = await readFreeze(git, remote)
  return record?.kind === "frozen" ? record : undefined
}

/** Refuse while the remote's latest freeze record is frozen. */
export async function requireUnfrozen(git: Git, remote: string): Promise<void> {
  const freeze = await activeFreeze(git, remote)
  if (freeze !== undefined) throw new QueueFrozen(freeze)
}

/**
 * Read the latest freeze record from the remote. Absence alone means unfrozen;
 * malformed, unreachable and unreadable state throws instead of opening the
 * queue on a guess.
 */
export async function readFreeze(git: Git, remote: string): Promise<FreezeRecord | undefined> {
  const advertised = await freezeTip(git, remote)
  if (advertised === undefined) return undefined
  await git(["fetch", "--quiet", "--no-tags", remote, `+${FREEZE_REF}:${FREEZE_REF}`])
  const fetched = await refAt(git, FREEZE_REF)
  if (fetched === undefined) {
    throw new Error(`${remote} advertised ${FREEZE_REF} at ${advertised}, but the fetch left no readable ref`)
  }
  return parseFreeze(git, fetched, `${remote} ${FREEZE_REF}`)
}

/** Append one frozen or unfrozen record under a lease on the remote tip. */
export async function writeFreeze(git: Git, remote: string, write: WriteFreeze): Promise<FreezeRecord> {
  const reason = oneLine(write.reason, "a freeze record needs a reason")
  const by = oneLine(write.by, "a freeze record needs an actor")
  const previous = await readFreeze(git, remote)
  if (write.kind === "frozen" && previous?.kind === "frozen") throw new QueueFrozen(previous)
  if (write.kind === "unfrozen" && previous?.kind !== "frozen") throw new QueueNotFrozen()
  const commit = await freezeCommit(git, previous, { ...write, by, reason })
  await git([
    "push",
    "--quiet",
    `--force-with-lease=${FREEZE_REF}:${previous?.sha ?? ABSENT}`,
    remote,
    `${commit}:${FREEZE_REF}`,
  ])
  await git(["update-ref", FREEZE_REF, commit])
  return parseFreeze(git, commit, `${remote} ${FREEZE_REF}`)
}

/**
 * Prepare the record that linearizes one merge against `queue freeze`.
 *
 * Preparation moves no ref. The caller must include both the lease and
 * `${sha}:${FREEZE_REF}` in the SAME atomic push as the target and change
 * updates. An active freeze is a normal refusal; unreadable authority is loud.
 */
export async function unfrozenFence(
  git: Git,
  remote: string,
  write: Readonly<{ reason: string; by: string }>,
): Promise<UnfrozenFence> {
  const reason = oneLine(write.reason, "a freeze fence needs a reason")
  const by = oneLine(write.by, "a freeze fence needs an actor")
  const previous = await readFreeze(git, remote)
  if (previous?.kind === "frozen") throw new QueueFrozen(previous)
  const sha = await freezeCommit(git, previous, { by, kind: "unfrozen", reason })
  return { expected: previous?.sha ?? ABSENT, previous, sha }
}

/** The operator-facing line shared by list, submit refusal and freeze commands. */
export function freezeLine(record: FreezeRecord): string {
  const since = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long" }).format(record.at)
  return `${record.kind} by ${record.by} since ${since}: ${record.reason}`
}

async function freezeTip(git: Git, remote: string): Promise<string | undefined> {
  const rows = (await git(["ls-remote", "--refs", remote, FREEZE_REF]))
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
  if (rows.length === 0) return undefined
  if (rows.length !== 1) throw new Error(`${remote} answered with ${String(rows.length)} values for ${FREEZE_REF}`)
  const [sha, ref] = (rows[0] ?? "").split(/\s+/u)
  if (ref !== FREEZE_REF || sha === undefined || !/^[0-9a-f]+$/u.test(sha)) {
    throw new Error(`${remote} returned an unreadable ${FREEZE_REF} advertisement: ${rows[0]}`)
  }
  return sha
}

async function parseFreeze(git: Git, sha: string, where: string): Promise<FreezeRecord> {
  const [commit, atText, block, body] = (await git(["log", "-1", `--format=${RECORD_FORMAT}`, sha])).split("\x00")
  const id = commit?.trim()
  const parsed = commitTrailers(block ?? "")
  const previousKinds = parsed.filter(([name]) => name === "Event")
  if (previousKinds.length > 0) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries the former Event trailer; this reader accepts Record only. ` +
        `Bundle and reset ${FREEZE_REF} during the format switch before restarting the queue.`,
    )
  }
  const kinds = parsed.filter(([name]) => name === "Record").map(([, value]) => value)
  const kind = kinds[0]
  if (kinds.length !== 1 || (kind !== "frozen" && kind !== "unfrozen")) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries no valid Record: frozen|unfrozen trailer ` +
        `(found ${String(kinds.length)}; exactly one is required)`,
    )
  }
  const byKey = "Frozen-By"
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
    throw new Error(`${where} at ${sha.slice(0, 12)} is not a readable freeze record`)
  }
  const at = new Date(atText)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${where} at ${sha.slice(0, 12)} has an unreadable commit time '${atText}'`)
  }
  return Object.freeze({ at, by, kind, reason, sha: id })
}

async function freezeCommit(git: Git, previous: FreezeRecord | undefined, write: WriteFreeze): Promise<string> {
  const tree = (await git(["mktree"], "")).trim()
  const message = `${write.reason}\n\nRecord: ${write.kind}\nFrozen-By: ${write.by}\n`
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
