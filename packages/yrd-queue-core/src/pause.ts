/** The retained M2 intake fence and operator-facing pause facts. */
import { readRemoteCommit, type Git } from "./git.ts"
import { changeName, pauseRef, type Change } from "./refs.ts"

export type PauseKind = "paused" | "resumed"

/** Who stopped the line: a person, or the queue itself on a change it could not judge. */
export type PauseCause = "operator" | "stuck" | "maintenance"

export type PauseRecord = Readonly<{
  kind: PauseKind
  sha: string
  at: Date
  reason: string
  by: string
  /** `operator` for every record that names no cause. */
  cause: PauseCause
  /** The change a stuck stop waits on; present exactly when `cause` is `stuck`. */
  change?: Change
  /** A stuck stop's cures: its stuck record's own `Next`, carried so the page needs no second read. */
  next?: string
}>

/** A normal operational refusal: the line is intentionally stopped. */
export class QueuePaused extends Error {
  readonly pause: PauseRecord

  constructor(pause: PauseRecord, remote: string, queue: string) {
    super(`${pauseLine(pause)}; ${liftLine(pause, remote, queue)}`)
    this.name = "QueuePaused"
    this.pause = pause
  }
}

/** A normal operational refusal: there is no stop to end. */
export class QueueNotPaused extends Error {
  constructor(lifted?: PauseRecord) {
    super(
      lifted?.change === undefined
        ? "the queue is not paused"
        : `the queue is not paused: the stop on ${changeName(lifted.change)} lifted when that change left the line`,
    )
    this.name = "QueueNotPaused"
  }
}

/** The stop as every JSON reader carries it (`yrd list --json`, the page's facts, submit's echo). */
export type StopFact = Readonly<{ cause: PauseCause; change: string | null; by: string; since: string }>

/** `null` while the line runs: the field is always present, so its absence can never be read as "running". */
export function stopFact(stop: PauseRecord | undefined): StopFact | null {
  if (stop === undefined) return null
  return {
    by: stop.by,
    cause: stop.cause,
    change: stop.change === undefined ? null : changeName(stop.change),
    since: stop.at.toISOString(),
  }
}

/** Read only the permanent M2 tip. Other legacy pause records are refused. */
export async function readM2Pause(
  git: Git,
  remote: string,
  queue: string,
  created: string,
): Promise<PauseRecord | undefined> {
  const ref = pauseRef(queue)
  const sha = await readRemoteCommit(git, remote, ref)
  if (sha === undefined) return undefined
  const where = `${remote}#${queue} ${ref} at ${sha}`
  const body = await git(["show", "-s", "--format=%B", sha])
  const fields =
    /^moved to event format at ([0-9a-f]{40}(?:[0-9a-f]{24})?)\n\nRecord: paused\nPaused-By: yrd-ops-cutover\nPaused-At: ([^\n]+)\nCause: maintenance\n{1,2}$/u.exec(
      body,
    )
  if (fields === null) {
    throw new Error(
      `${where}: expected the exact M2 maintenance fence fields; read ${JSON.stringify(body.slice(0, 400))}`,
    )
  }
  const cutover = fields[1]
  if (cutover !== created) {
    throw new Error(`${where}: M2 names event-created ${cutover}; expected ${created}`)
  }
  const atText = fields[2] ?? ""
  const at = new Date(atText)
  if (Number.isNaN(at.getTime()) || at.toISOString() !== atText) {
    throw new Error(`${where}: M2 has invalid Paused-At ${JSON.stringify(atText)}`)
  }
  const parents = (await git(["show", "-s", "--format=%P", sha])).trim().split(/\s+/u)
  if (parents.length !== 1 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(parents[0] ?? "")) {
    throw new Error(`${where}: M2 must have exactly one predecessor; read ${parents.join(", ")}`)
  }
  const predecessor = await git(["show", "-s", "--format=%B", parents[0] ?? ""])
  if (/^moved to event format at [0-9a-f]{40}(?:[0-9a-f]{24})?\n\n/u.test(predecessor)) {
    throw new Error(`${where}: second commit atop an M2 fence ${parents[0]} is not an approved tip`)
  }
  return Object.freeze({
    kind: "paused",
    sha,
    at,
    reason: `moved to event format at ${created}`,
    by: "yrd-ops-cutover",
    cause: "maintenance",
  })
}

/** The operator-facing line shared by list, the submit echo, refusals and the pause commands. */
export function pauseLine(record: PauseRecord): string {
  const since = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long" }).format(record.at)
  if (record.kind === "resumed") {
    return `running: ${record.reason}`
  }
  if (record.cause === "stuck" || record.change !== undefined) {
    return `paused since ${since}: stuck on ${record.change !== undefined ? changeName(record.change) : record.reason}`
  }
  return `paused by ${record.by} since ${since}: ${record.reason}`
}

/**
 * What lifts a stop, as one sentence for a refusal or an echo.
 *
 * A stuck stop leads with its own record's cures, which already name all four
 * acts; the resume command is spelled out for the queue this reader selected,
 * because that one act needs the selector.
 */
export function liftLine(pause: PauseRecord, remote: string, queue: string): string {
  const selector = (remote === "origin" ? queue : `${remote}#${queue}`).replaceAll("'", "'\\''")
  const resume = `yrd queue resume --queue '${selector}' --reason '<text>'`
  if (pause.cause === "maintenance") {
    return `submit after resume; the person who set this maintenance stop lifts it with ${resume}`
  }
  if (pause.cause === "operator" || pause.change === undefined) return `run ${resume} to check and merge work again`
  return (
    `the line waits on ${changeName(pause.change)}: ${pause.next ?? stuckCures(pause.change.branch)}. ` +
    `Resuming this queue, once it is repaired, is: ${resume}`
  )
}

/**
 * The four acts that take a stuck change out of the line, in the words its
 * stuck record's `Next` carries and every surface after it repeats: the page,
 * the refusal and the submit echo read them from there.
 */
export function stuckCures(branch: string): string {
  return (
    `four ways out of the line: yrd queue withdraw ${branch} (an operator ends the change), ` +
    `submit a replacement head for ${branch} that clears this reason (the same content sticks on the same ground), ` +
    `merge a queued fix with yrd merge <its branch> (it runs alone on the stopped line, then ${branch} is judged once more), ` +
    "or yrd queue resume once the queue itself is repaired; until one of them, the line stays stopped"
  )
}
