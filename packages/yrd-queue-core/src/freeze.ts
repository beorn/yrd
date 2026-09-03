/**
 * A merge freeze: one append-only event ref at the queue's remote.
 *
 * The ref is operational state, not queue configuration. Its latest commit is
 * the whole answer: `frozen` stops queue work and `unfrozen` permits it. A
 * missing ref is the one honest unfrozen default; an unreadable ref is loud.
 */

import type { Git } from "./events.ts"
import { refAt } from "./git.ts"

export const FREEZE_REF = "refs/yrd/freeze"

export type FreezeKind = "frozen" | "unfrozen"

export type FreezeEvent = Readonly<{
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

/** A normal operational refusal: the queue is intentionally frozen. */
export class QueueFrozen extends Error {
  readonly freeze: FreezeEvent

  constructor(freeze: FreezeEvent) {
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

const ABSENT = "0".repeat(40)
const FORMAT = "%H%x00%cI%x00%(trailers:only,unfold)%x00%s"

/** The active freeze, or undefined when the ref is absent or ends unfrozen. */
export async function activeFreeze(git: Git, remote: string): Promise<FreezeEvent | undefined> {
  const event = await readFreeze(git, remote)
  return event?.kind === "frozen" ? event : undefined
}

/** Refuse while the remote's latest freeze event is frozen. */
export async function requireUnfrozen(git: Git, remote: string): Promise<void> {
  const freeze = await activeFreeze(git, remote)
  if (freeze !== undefined) throw new QueueFrozen(freeze)
}

/**
 * Read the latest freeze event from the remote. Absence alone means unfrozen;
 * malformed, unreachable and unreadable state throws instead of opening the
 * queue on a guess.
 */
export async function readFreeze(git: Git, remote: string): Promise<FreezeEvent | undefined> {
  const advertised = await freezeTip(git, remote)
  if (advertised === undefined) return undefined
  await git(["fetch", "--quiet", "--no-tags", remote, `+${FREEZE_REF}:${FREEZE_REF}`])
  const fetched = await refAt(git, FREEZE_REF)
  if (fetched === undefined) {
    throw new Error(`${remote} advertised ${FREEZE_REF} at ${advertised}, but the fetch left no readable ref`)
  }
  return parseFreeze(git, fetched, `${remote} ${FREEZE_REF}`)
}

/** Append one frozen or unfrozen event under a lease on the remote tip. */
export async function writeFreeze(git: Git, remote: string, write: WriteFreeze): Promise<FreezeEvent> {
  const reason = oneLine(write.reason, "a freeze event needs a reason")
  const by = oneLine(write.by, "a freeze event needs an actor")
  const previous = await readFreeze(git, remote)
  if (write.kind === "frozen" && previous?.kind === "frozen") throw new QueueFrozen(previous)
  if (write.kind === "unfrozen" && previous?.kind !== "frozen") throw new QueueNotFrozen()
  const tree = (await git(["mktree"], "")).trim()
  const byTrailer = write.kind === "frozen" ? "Frozen-By" : "Unfrozen-By"
  const message = `${reason}\n\nFreeze: ${write.kind}\n${byTrailer}: ${by}\n`
  const args = ["commit-tree", tree]
  if (previous !== undefined) args.push("-p", previous.sha)
  const commit = (await git([...args, "-m", message])).trim()
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

/** The operator-facing line shared by list, submit refusal and freeze commands. */
export function freezeLine(event: FreezeEvent): string {
  return `${event.kind} by ${event.by} since ${event.at.toISOString()}: ${event.reason}`
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

async function parseFreeze(git: Git, sha: string, where: string): Promise<FreezeEvent> {
  const [commit, atText, block, subject] = (await git(["log", "-1", `--format=${FORMAT}`, sha])).split("\x00")
  const id = commit?.trim()
  const kinds = trailerValues(block, "Freeze")
  const kind = kinds[0]
  if (kinds.length !== 1 || (kind !== "frozen" && kind !== "unfrozen")) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries no valid Freeze: frozen|unfrozen trailer ` +
        `(found ${String(kinds.length)}; exactly one is required)`,
    )
  }
  const byKey = kind === "frozen" ? "Frozen-By" : "Unfrozen-By"
  const actors = trailerValues(block, byKey)
  const by = actors[0]
  if (actors.length !== 1 || by === undefined || by === "") {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries no single non-empty ${byKey}: trailer ` +
        `(found ${String(actors.length)})`,
    )
  }
  const reason = subject?.trim()
  if (id === undefined || id === "" || atText === undefined || reason === undefined || reason === "") {
    throw new Error(`${where} at ${sha.slice(0, 12)} is not a readable freeze event`)
  }
  const at = new Date(atText)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${where} at ${sha.slice(0, 12)} has an unreadable commit time '${atText}'`)
  }
  return Object.freeze({ at, by, kind, reason, sha: id })
}

function trailerValues(block: string | undefined, key: string): readonly string[] {
  const prefix = `${key}:`
  return (block ?? "")
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
}

function oneLine(value: string, missing: string): string {
  const text = value.trim()
  if (text === "") throw new Error(missing)
  if (text.includes("\n")) throw new Error(`${missing}; it must be one line`)
  return text
}
