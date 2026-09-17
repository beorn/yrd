/**
 * A merge pause: one append-only record ref at the queue's remote.
 *
 * The ref is operational state, not queue configuration. Its latest commit is
 * the whole answer: `paused` stops queue work and `resumed` permits it. A
 * missing ref is the one honest resumed default; an unreadable ref is loud.
 *
 * A pause has a CAUSE, and that is the andon (operator 2026-09-16: "STUCK means
 * fail loud and fix - andon - stop the line - fix it"). `operator` is a
 * person's `yrd queue pause`, and a record that names no cause is one: every
 * record written before causes existed was. `stuck` is the queue pausing
 * ITSELF: a change it could not judge stopped the line, and the record names
 * that change and carries its stuck record's cures. Either way the line stops —
 * nothing is checked or merged automatically — and submits are still accepted,
 * queueing behind the stop.
 *
 * An operator's stop lifts only by `yrd queue resume`. A stuck stop also lifts
 * when the change it names leaves the line: withdrawn, merged, or ended by a
 * later judgement. No timer ever lifts either. {@link lineStop} is the ONE
 * derivation of "is the line stopped", and every reader asks it — the run, the
 * service and its page, list, submit and the pause writers — so no two of them
 * can decide it differently.
 */

import {
  ABSENT,
  RECORD_FORMAT,
  commitTrailers,
  endedKind,
  standsEnded,
  type ChangeRecord,
  type Git,
} from "./records.ts"
import { readRemoteCommit } from "./git.ts"

import { changeName, parseChangeName, pauseRef, type Change } from "./refs.ts"
import { holdsPlaceInLine, type ChangeState } from "./state.ts"

export type PauseKind = "paused" | "resumed"

/** Who stopped the line: a person, or the queue itself on a change it could not judge. */
export type PauseCause = "operator" | "stuck"

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

export type WritePause = Readonly<{
  kind: PauseKind
  reason: string
  by: string
  /** Absent is `operator`. A `stuck` pause names its `change`, and may carry that change's cures as `next`. */
  cause?: PauseCause
  change?: Change
  next?: string
}>

/** The state-preserving record and expected tip one atomic merge push must carry. */
export type PauseFence = Readonly<{
  sha: string
  expected: string
  previous?: PauseRecord
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

/**
 * The stop that stands, or undefined while the line runs: THE ONE DERIVATION.
 *
 * `named` is the queue read's entry for the change a stuck stop names, with its
 * record history — `readQueue` expands exactly that one entry. An operator's
 * stop stands until a resume record replaces it. A stuck stop stands while its
 * change still holds a place in line (state.ts `holdsPlaceInLine`, the predicate
 * `inLine` selects by) AND no ending has been recorded on it since it last
 * stuck. So ANY ending lifts it — merged, withdrawn, failed, a replaced head —
 * with no list of ending kinds kept here. A same-head retry re-opens the chain
 * without curing anything, while an ending followed by a resubmit is a new
 * submission this stop never named, and must never stop the line a second time. A change the read cannot find at all
 * keeps the line stopped — nothing says it left — and `yrd queue resume` cures
 * that. The record itself is never rewritten here: a stop that lifted leaves its
 * record in place until the next write to the pause ref replaces it, which the
 * next merge's atomic fence does.
 */
export function lineStop(
  pause: PauseRecord | undefined,
  named:
    | Readonly<{ change: Readonly<{ records: readonly ChangeRecord[] }>; reading: Readonly<{ state: ChangeState }> }>
    | undefined,
): PauseRecord | undefined {
  if (pause?.kind !== "paused") return undefined
  if (pause.cause === "operator" || named === undefined) return pause
  if (!holdsPlaceInLine(named.reading.state)) return undefined
  const records = named.change.records
  const stuckAt = records.findLastIndex((record) => endedKind(record) === "stuck")
  return records.slice(stuckAt + 1).some((record) => standsEnded(record)) ? undefined : pause
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

/**
 * Read the latest pause record from the remote. Absence alone means resumed;
 * malformed, unreachable and unreadable state throws instead of opening the
 * queue on a guess.
 */
export async function readPause(git: Git, remote: string, queue: string): Promise<PauseRecord | undefined> {
  const ref = pauseRef(queue)
  const captured = await readRemoteCommit(git, remote, ref)
  return captured === undefined ? undefined : parsePause(git, captured, `${remote} ${ref}`)
}

/**
 * Append one paused or resumed record under a lease on the remote tip.
 *
 * `lifted` is a paused record the caller derived as no longer standing
 * ({@link lineStop}): a new pause may chain on it, and there is nothing for a
 * resume to end. Any OTHER paused tip is a stop that stands.
 */
export async function writePause(
  git: Git,
  remote: string,
  queue: string,
  write: WritePause,
  lifted?: PauseRecord,
): Promise<PauseRecord> {
  const ref = pauseRef(queue)
  const reason = oneLine(write.reason, "a pause record needs a reason")
  const by = oneLine(write.by, "a pause record needs an actor")
  if (write.kind === "paused" && write.cause === "stuck" && write.change === undefined) {
    throw new Error("a stuck pause names the change it stopped for")
  }
  if ((write.cause ?? "operator") === "operator" && (write.change !== undefined || write.next !== undefined)) {
    throw new Error("an operator's pause names no change: only a stuck stop waits on one")
  }
  const previous = await readPause(git, remote, queue)
  const stands = previous?.kind === "paused" && previous.sha !== lifted?.sha ? previous : undefined
  if (write.kind === "paused" && stands !== undefined) throw new QueuePaused(stands, remote, queue)
  if (write.kind === "resumed" && stands === undefined) {
    throw new QueueNotPaused(previous?.kind === "paused" ? previous : undefined)
  }
  const commit = await pauseCommit(git, previous, { ...write, by, reason })
  await git(["push", "--quiet", `--force-with-lease=${ref}:${previous?.sha ?? ABSENT}`, remote, `${commit}:${ref}`])
  return parsePause(git, commit, `${remote} ${ref}`)
}

/**
 * Prepare the record that linearizes one merge against `queue pause`.
 *
 * Preparation moves no ref. The caller must include both the lease and
 * `${sha}:${pauseRef(queue)}` in the SAME atomic push as the target and change
 * updates. Only the unchanged pause admitting an explicit foreground round
 * may be carried forward paused; a stop the round derived as lifted is
 * replaced by a resumed record in that same push; any newer pause refuses.
 * Unreadable authority is loud.
 */
export async function pauseFence(
  git: Git,
  remote: string,
  queue: string,
  write: Readonly<{ reason: string; by: string }>,
  admittedPause?: PauseRecord,
  liftedPause?: PauseRecord,
): Promise<PauseFence> {
  const reason = oneLine(write.reason, "a pause fence needs a reason")
  const by = oneLine(write.by, "a pause fence needs an actor")
  const previous = await readPause(git, remote, queue)
  if (previous?.kind === "paused" && previous.sha !== admittedPause?.sha && previous.sha !== liftedPause?.sha) {
    throw new QueuePaused(previous, remote, queue)
  }
  const sha =
    previous?.kind === "paused" && previous.sha === admittedPause?.sha
      ? await pauseCommit(git, previous, { ...carried(previous), kind: "paused" }, previous.at)
      : await pauseCommit(git, previous, { by, kind: "resumed", reason })
  return { expected: previous?.sha ?? ABSENT, previous, sha }
}

/** The operator-facing line shared by list, the submit echo, refusals and the pause commands. */
export function pauseLine(record: PauseRecord): string {
  const since = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long" }).format(record.at)
  const stuck = record.change === undefined ? "" : ` (stuck: ${changeName(record.change)})`
  return `${record.kind} by ${record.by} since ${since}: ${record.reason}${stuck}`
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

export async function parsePause(git: Git, sha: string, where: string): Promise<PauseRecord> {
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
  // A foreground fence is a new commit, not a new decision to pause. Keep the
  // original pause time while its own commit time records the merge's fence.
  const pauseTimes = parsed.filter(([name]) => name === "Paused-At").map(([, value]) => value)
  if (pauseTimes.length > 1) throw new Error(`${where} at ${sha.slice(0, 12)} carries multiple Paused-At: trailers`)
  const at = new Date(pauseTimes[0] ?? atText)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${where} at ${sha.slice(0, 12)} has an unreadable pause time '${pauseTimes[0] ?? atText}'`)
  }
  // No Cause at all is the operator's: every record before causes existed.
  // A cause nobody defined, or two, is refused rather than guessed at — a stop
  // read as the wrong cause is lifted by the wrong act.
  const causes = parsed.filter(([name]) => name === "Cause").map(([, value]) => value)
  const cause = causes[0] ?? "operator"
  if (causes.length > 1 || (cause !== "operator" && cause !== "stuck")) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} carries an unreadable Cause: ${causes.join(", ")} (operator or stuck, at most one)`,
    )
  }
  const changes = parsed.filter(([name]) => name === "Change").map(([, value]) => value)
  const change = changes.length === 1 ? parseChangeName(changes[0] ?? "") : undefined
  if (cause === "stuck" && kind === "paused" && change === undefined) {
    throw new Error(
      `${where} at ${sha.slice(0, 12)} is a stuck stop with no readable Change: <branch>@<sha> ` +
        `(found ${String(changes.length)}); no reader could say which change lifts it`,
    )
  }
  const nexts = parsed.filter(([name]) => name === "Next").map(([, value]) => value)
  return Object.freeze({
    at,
    by,
    cause,
    kind,
    reason,
    sha: id,
    ...(cause === "stuck" && change !== undefined ? { change } : {}),
    ...(cause === "stuck" && nexts[0] !== undefined ? { next: nexts[0] } : {}),
  })
}

/** The facts a carried-forward paused record keeps: the decision, not the commit. */
function carried(previous: PauseRecord): Omit<WritePause, "kind"> {
  return {
    by: previous.by,
    cause: previous.cause,
    reason: previous.reason,
    ...(previous.change === undefined ? {} : { change: previous.change }),
    ...(previous.next === undefined ? {} : { next: previous.next }),
  }
}

async function pauseCommit(
  git: Git,
  previous: PauseRecord | undefined,
  write: WritePause,
  pausedAt?: Date,
): Promise<string> {
  const tree = (await git(["mktree"], "")).trim()
  const trailers = [
    `Record: ${write.kind}`,
    `Paused-By: ${write.by}`,
    ...(pausedAt === undefined ? [] : [`Paused-At: ${pausedAt.toISOString()}`]),
    // A resume ends whatever stood, so it names no cause of its own.
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

function oneLine(value: string, missing: string): string {
  const text = value.trim()
  if (text === "") throw new Error(missing)
  if (text.includes("\n")) throw new Error(`${missing}; it must be one line`)
  return text
}
