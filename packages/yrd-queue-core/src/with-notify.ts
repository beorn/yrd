/**
 * The notify ring: a queue that tells somebody what it did.
 *
 * The bare loop writes records. That is the whole of what a change IS, and a
 * reader who asks the remote sees every ending without anybody being told. This
 * ring is the telling: it runs the `notify:` entries the declaration lists, and
 * writes one sent record per entry that fired, so a reader can see who the queue
 * reached and who it did not.
 *
 * Delivery is bounded and never authoritative. A command that fails changes
 * nothing about the change — the ended record stands. Any receipt settles a name
 * for that ending: delivered is told, and a transport that answered and refused
 * is written down once as `Not-Told:` and never sent again. A command that gave
 * no receipt is handed the same record once more by `resend` on the next round,
 * keyed by the ended record's sha, so whoever hears it sees one message however
 * many times it is sent; that last attempt's record says `Not-Told:` too if it
 * fails. That repair pass is this ring's own and rides on `bookkeep`; without
 * the ring there is no delivery to repair.
 *
 * Take this file and its line out of rings.ts and the queue merges, fails and
 * gets stuck exactly as it does now, in silence, and no `sent` record is ever
 * written again.
 */

import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { prepareWorktree } from "./worktree.ts"
import { readCheckTrailer } from "./check.ts"
import type { ObservationNotice } from "./git.ts"
import type { Ending, Notifier } from "./config.ts"
import { directMergeLine, type DirectMerge } from "./direct.ts"
import { INCIDENT_TRAILERS } from "./incident.ts"
import { recordsMatching } from "./log.ts"
import {
  endedKind,
  notToldValue,
  readNotTold,
  readRecord,
  readRecords,
  trailer,
  trailers,
  type ChangeRecord,
  type WriteRecord,
} from "./records.ts"
import { changeName } from "./refs.ts"
import { recordProgramStart, recordProgramResult, short, writeRecord, type Ring, type Run } from "./run.ts"
import { tipOf } from "./state.ts"
import type { QueueEntry } from "./remote.ts"

/** This ring's own option, which the run's options carry for it (rings.ts). */
export type NotifyOptions = Readonly<{
  /** What the queue notifies, per ending; an ending no entry wants runs nothing. */
  notify?: readonly Notifier[]
}>

export const withNotify: Ring = (steps) => ({
  ...steps,

  bookkeep: async (run, entry) => {
    const outcome = await steps.bookkeep(run, entry)
    // Repair delivery to each still-owed recipient before anything is judged
    // (at-least-once, § The queue run). Reads the entry's own stale tip, so an
    // ending `bookkeep` itself just wrote (never seen there) resends nothing
    // for it here — its own `end` already told, once.
    await resend(run, entry)
    return outcome
  },

  ended: async (run, entry, kind, endedRecord, appendTip) => {
    await steps.ended(run, entry, kind, endedRecord, appendTip)
    await told(run, entry, kind, endedRecord, appendTip)
  },

  observed: async (run, notice) => {
    await steps.observed(run, notice)
    for (const { name, delivery, failure } of await notifyAll(run, "observed", { record: "observed", notice })) {
      run.log.write({
        kind: "message",
        says: "observed",
        id: notice.id,
        text: notice.text,
        to: name,
        delivery,
        delivered: delivery === "sent",
        ...(failure === undefined ? {} : { error: failure }),
      })
    }
  },

  direct: async (run, commit) => {
    await steps.direct(run, commit)
    await toldDirect(run, commit)
  },
})

/**
 * A commit that went around the queue, told about: there is no change to end.
 *
 * direct.ts finds this same commit again every run until something of the
 * queue's lands on top of it, and says so plainly: "a direct merge with
 * nothing of the queue's on top is reported again next run... so the
 * notifier sees one message however many runs say it" (E5). Nothing upstream
 * gates that repeat — it is `directMergeCommits`' own documented shape — so
 * the one-message promise is this function's to keep. A change keeps its
 * receipts on its own ref (`told`, just below); a direct merge has no change
 * and so no ref, and its receipts are its own prior "message" rows instead,
 * read back from this machine's run journals (log.ts). Only entries still
 * owed run again, mirroring `told`'s own resend logic: a row that delivered or
 * was refused settles its name, and failed rows count its attempts. A commit
 * already settled in full runs nothing at all.
 */
async function toldDirect(run: Run, commit: DirectMerge): Promise<void> {
  const target = run.options.target.branch
  const priorMessages = recordsMatching(
    join(run.options.workdir, "logs"),
    (record) => record.kind === "message" && record.says === DIRECT && record.head === commit.commit,
  )
  const settled = new Set<string>()
  const failures = new Map<string, number>()
  for (const record of priorMessages) {
    if (typeof record.to !== "string" || record.to === "") continue
    if (record.delivered === true || typeof record.refused === "string") settled.add(record.to)
    else failures.set(record.to, (failures.get(record.to) ?? 0) + 1)
  }
  const owed = (run.options.notify ?? []).filter(
    (entry) => entry.on.includes(DIRECT) && !settled.has(entry.name) && (failures.get(entry.name) ?? 0) < ATTEMPTS,
  )
  if (priorMessages.length > 0 && owed.length === 0) return
  const text = `${directMergeLine(commit)}: ${commit.why}. The queue goes on from the new base; a rollback is a git revert, pushed through the queue.`
  // A direct merge has no change, so the commit that went around the queue stands
  // where a change's name would (`NotifyRecord`).
  for (const { name, delivery, failure, refused } of await notifyAll(
    run,
    DIRECT,
    { change: commit.commit, record: DIRECT },
    owed,
  )) {
    run.log.write({
      about: target,
      branch: target,
      delivered: delivery === "sent",
      ...(failure === undefined ? {} : { error: failure }),
      head: commit.commit,
      id: commit.commit,
      kind: "message",
      ...(refused === undefined ? {} : { refused }),
      says: DIRECT,
      text,
      to: name,
    })
  }
}

/**
 * Repair the current ending's delivery: a successful sent tip can cover an
 * earlier failed recipient. `told` reads this ending's receipts, not just its
 * tip, and retries only the names still owed: not told, not settled untold, and
 * short of their last attempt.
 */
async function resend(run: Run, entry: QueueEntry): Promise<void> {
  const tip = tipOf(entry.change)
  // The head is on the target and this tip does not say merged: the catch-up
  // just above owns this change — it wrote the merged record and sent its message
  // this run, so this entry's tip is a reading from before that. Sending from
  // it would put `sent State: failed` on top of a merged change and tell its
  // submitter to fix what has already merged (ruling A2).
  if (entry.change.headOnTarget && endedKind(tip) !== "merged") return
  const unsent = tip.kind === "failed" || tip.kind === "stuck" || tip.kind === "merged"
  if (tip.kind !== "sent" && !unsent) return
  // A retired change sends nothing (ruling B3).
  const reason = trailer(tip, "Reason")
  if (reason === "replaced" || reason === "deleted") return
  const endedSha = tip.kind === "sent" ? trailer(tip, "For") : tip.sha
  if (endedSha === undefined) {
    throw new Error(`${entry.change.branch}: sent record ${tip.sha.slice(0, 12)} names no ended record to send again`)
  }
  const written = tip.kind === "sent" ? await readRecord(run.git, endedSha) : tip
  if (written.kind !== "failed" && written.kind !== "stuck" && written.kind !== "merged") {
    throw new Error(`${entry.change.branch}: ${endedSha.slice(0, 12)} is a ${written.kind} record, not an ended one`)
  }
  await run.steps.ended(run, entry, written.kind, written.sha, tip.sha)
}

/** The one message an ended change sends, in the plan's three shapes (§ Commands). */
function messageFor(
  kind: "merged" | "failed" | "stuck",
  about: Readonly<{ branch: string; head: string; subject: string; merge?: string; remedy?: string }>,
): string {
  switch (kind) {
    case "merged":
      return `close your bead: ${short(about.branch, about.head)} merged as ${(about.merge ?? "").slice(0, 12)}`
    case "failed":
      return `send it back: ${about.subject}; ${about.remedy ?? ""}`.trim()
    case "stuck":
      return `yrd broken: ${about.subject}; the queue stays down until a person fixes it`
  }
}

/**
 * One message per ended change, after its ended record; the record's sha is the
 * id. What the message says is read from that record and nowhere else, so a
 * resend after a crash says exactly what the first send said.
 */
async function told(
  run: Run,
  entry: QueueEntry,
  kind: "merged" | "failed" | "stuck",
  endedRecord: string,
  initialAppendTip: string,
): Promise<void> {
  // Only this ending's receipts count. The captured range excludes older
  // endings; a contended append can interleave unrelated records above it.
  const receipts =
    initialAppendTip === endedRecord
      ? []
      : (await readRecords(run.git, `${endedRecord}..${initialAppendTip}`)).filter(
          (record) => record.kind === "sent" && trailer(record, "For") === endedRecord,
        )
  // Any receipt settles a name: `Delivery: sent` told it, and a `Not-Told:`
  // says it will not be. A failed attempt settles nothing, and is counted.
  const successful = new Set<string>()
  const notTold = new Map<string, string>()
  const failures = new Map<string, Readonly<{ attempts: number; error: string }>>()
  for (const receipt of receipts) {
    for (const value of trailers(receipt, "Not-Told")) notTold.set(readNotTold(value).to, value)
    const delivery = trailer(receipt, "Delivery")
    const name = trailer(receipt, "To")
    if (delivery === "failed" && name !== undefined && name !== "") {
      const error =
        trailer(receipt, "Delivery-Error") ?? `sent record ${receipt.sha.slice(0, 12)} carries no Delivery-Error`
      failures.set(name, { attempts: (failures.get(name)?.attempts ?? 0) + 1, error })
    }
    if (delivery !== "sent") continue
    if (name === undefined || name === "") {
      throw new Error(`${entry.change.branch}: successful sent record ${receipt.sha.slice(0, 12)} names no recipient`)
    }
    successful.add(name)
  }
  // A chain from before `Not-Told:` resent a failing name every round; out of
  // attempts, it is settled by its own count.
  for (const [name, { attempts, error }] of failures) {
    if (attempts >= ATTEMPTS && !successful.has(name) && !notTold.has(name)) {
      notTold.set(name, notToldValue(name, { undelivered: error }))
    }
  }
  const owed = (run.options.notify ?? []).filter(
    (entry) => entry.on.includes(kind) && !successful.has(entry.name) && !notTold.has(entry.name),
  )
  // An absent name runs nothing; a newly declared name is owed this ending, and
  // a settled one never is. Only the first telling can record `none`, never a
  // completed repair pass.
  if (receipts.length > 0 && owed.length === 0) return
  const written = await readRecord(run.git, endedRecord)
  const text = messageFor(kind, {
    branch: entry.change.branch,
    head: entry.change.head,
    merge: trailer(written, "Merge") ?? "",
    remedy: trailer(written, "Remedy"),
    subject: written.subject,
  })
  // The queue addresses nobody. It says what happened and runs the entries that
  // want this ending; who hears about it is their own business. The submitter
  // travels with the record as the opaque string the submit gave — `unknown` is
  // what a submit with neither `--notify` nor `YRD_DEFAULT_SUBMITTER` records
  // (rulings B6 and D9), and it is not a seat.
  const submitter = trailer(written, "Submitter")
  const known = submitter !== undefined && submitter !== "unknown"
  const issue = trailer(written, "Issue")
  const lastCheck = trailers(written, "Check").at(-1)
  const log = lastCheck === undefined ? run.log.path : (readCheckTrailer(lastCheck).log ?? run.log.path)
  const handed = await notifyAll(
    run,
    kind,
    {
      change: changeName(entry.change),
      record: kind,
      ...(issue === undefined ? {} : { issue }),
      ...(known ? { submitter } : {}),
      ...(kind === "merged" ? { merge: trailer(written, "Merge") ?? "" } : { log, reason: reasonFor(kind, written) }),
      ...(kind === "failed" ? { failures: await failuresOf(run, entry, endedRecord) } : {}),
      ...(kind === "failed" ? await priorFailureReason(run, entry, endedRecord) : {}),
    },
    owed,
  )
  let appendTip: string | undefined = initialAppendTip
  for (const { name, delivery, failure, refused } of handed) {
    // A refusal is settled on its own record, and a name out of attempts on its
    // last one. Every later record of this ending repeats what is settled, for
    // the same reason it repeats the result: the tip alone says who was not told.
    if (refused !== undefined) notTold.set(name, notToldValue(name, { refused }))
    else if (failure !== undefined && (failures.get(name)?.attempts ?? 0) + 1 >= ATTEMPTS) {
      notTold.set(name, notToldValue(name, { undelivered: oneLine(failure) }))
    }
    // One sent record per entry that fired, so a reader can see which of them the
    // queue reached. The sent record repeats the ended state/result, so
    // fixed-cost list reads stay complete after delivery. Earlier-phase check
    // evidence remains on its own records (ruling A2).
    const sentWrite: WriteRecord = {
      change: entry.change,
      kind: "sent",
      subject: `${said(delivery)} ${name}: ${text}`,
      trailers: [
        ["Message-Id", endedRecord],
        ["To", name],
        ["State", kind],
        ["For", endedRecord],
        ["Delivery", delivery],
        ...(failure === undefined ? [] : [["Delivery-Error", oneLine(failure)] as const]),
        ...[...notTold.values()].map((value) => ["Not-Told", value] as const),
        ...written.trailers.filter(([key]) => RESULT_TRAILERS.has(key)),
      ],
    }
    const sentRecord: string | undefined =
      appendTip === undefined ? undefined : await writeRecord(run, sentWrite, appendTip)
    if (sentRecord !== undefined) appendTip = sentRecord
    // A notifier result is not durable unless its sent record landed. Keep the
    // immutable ending id in the log and distinguish this append contention from
    // later results that could not be appended after it.
    const unrecorded =
      sentRecord === undefined
        ? appendTip === undefined
          ? `the sent result for ${endedRecord.slice(0, 12)} was unrecorded after a prior sent append contended`
          : `the sent result for ${endedRecord.slice(0, 12)} was unrecorded after its append contended`
        : undefined
    if (sentRecord === undefined) appendTip = undefined
    const trouble = [failure, unrecorded].filter((why): why is string => why !== undefined).join("; ")
    run.log.write({
      about: entry.change.branch,
      branch: entry.change.branch,
      delivered: delivery === "sent" && sentRecord !== undefined,
      ...(trouble === "" ? {} : { error: trouble }),
      head: entry.change.head,
      id: endedRecord,
      kind: "message",
      ...(refused === undefined ? {} : { refused }),
      says: kind,
      text,
      to: name,
    })
  }
}

/**
 * The JSON object a notify entry reads on its stdin: the record itself, the same
 * one the change's ref stores, in the fields a reader needs and nothing else.
 *
 * `record` says which ending it is and `change` which change — its name, or for
 * a direct merge the commit that went around the queue. `submitter` and `issue` are
 * there when the submit gave them. `merged` carries the merge it made; `failed`
 * and `stuck` carry why and where to read it, and `failed` how many times this
 * branch has been sent back, the number the root's notifier raises an andon on.
 *
 * No id, no subject, no remedy, no prose: an entry composes what it says, and
 * the identity of a message is its change and its record — a resend after a
 * crash hands over the same object.
 */
export type NotifyRecord =
  | Readonly<{ record: "observed"; notice: ObservationNotice }>
  | Readonly<{
      record: Exclude<Ending, "observed">
      change: string
      submitter?: string
      issue?: string
      merge?: string
      reason?: string
      log?: string
      failures?: number
      /**
       * On a `failed` record only, and only when every prior failure of this
       * branch carried one and the same reason. The notifier's third
       * disposition — hold and route, do not resubmit — turns on this matching
       * `reason` (@i/10-yrd/24485). Absent means "not unambiguous", and the
       * notifier then says what it always said.
       */
      priorReason?: string
    }>

/** Why a change ended, as its record says it: the check for a fail, the sentence for a stuck. */
function reasonFor(kind: "failed" | "stuck", ended: ChangeRecord): string {
  return kind === "failed" ? (trailer(ended, "Reason") ?? "check") : ended.subject
}

/** The ending a direct merge is; the other three are how a change itself ended. */
const DIRECT = "merged-direct"

/** The entry name a sent record carries when the declaration wanted nobody told. */
const NOBODY = "none"

/** What a sent record's subject says about its entry, in two words. */
/**
 * One trailer is one line, and a value carrying a line break is REFUSED at
 * record-write time (`recordMessage` in records.ts), which throws out of the
 * notify path and takes the whole run down with it. A delivery that failed is
 * the worst moment to lose a run: the ending it was reporting is already
 * decided, and the crash replaces a record saying so with no record at all.
 *
 * Two producers feed this, and only one of them was safe. A notifier that EXITS
 * non-zero has its output collapsed where it is read; a notifier that could not
 * RUN carries the thrown message verbatim, and a spawn or timeout message is
 * routinely several lines. Collapsing at the writer covers both, and the next
 * producer as well.
 *
 * Every line break becomes ONE space and nothing else changes. `\s+` would
 * flatten runs of spacing the failure text meant to keep, and the point of this
 * trailer is to stay loud: the whole message survives, on one line.
 */
function oneLine(value: string): string {
  return value.replace(/\r\n|\n|\r/gu, " ")
}

function said(delivery: Delivery): string {
  return delivery === "sent" ? "told" : delivery === "none" ? "told nobody:" : "could not tell"
}

/** A change ended by its submitter moving on, which is not a failure of anything. */
const MOVED_ON = new Set(["replaced", "deleted"])

/**
 * How many times this branch has been sent back, this ending included — the
 * number the notifier raises an andon on at two or more. A merged or stuck
 * ending adds nothing to it, and neither does a change the submitter replaced
 * or deleted; the count is about a branch that keeps failing its checks.
 *
 * Two readings, because a branch's failures live in two places: the tips of its
 * OTHER changes, which the queue read already holds, and this change's own
 * records, where a retry at an unchanged head appends a second opened record and a
 * second failure under one ref, so the tip alone would forget the first.
 */
/**
 * The one reason every element carries, or nothing when they do not agree.
 *
 * Pure and exported so the rule can be tested without a queue: the notifier's
 * third disposition turns on it (@i/10-yrd/24485), and "same error again" is a
 * claim that has to be exactly right in both directions.
 */
export function sameFailureReason(reasons: readonly (string | undefined)[]): string | undefined {
  // No length check: an empty list has no first element, and the absent-reason
  // guard below already refuses `undefined`. Mutation control found the extra
  // condition unkillable by any test, which is what an unreachable branch looks
  // like from the outside.
  const first = reasons[0]
  if (first === undefined || first === "") return undefined
  return reasons.every((reason) => reason === first) ? first : undefined
}

/**
 * The reason EVERY prior failure of this branch carried, or nothing.
 *
 * Deliberately not "the reason the previous one carried". The notifier uses this
 * to decide whether a failure is the same failure again, and a branch that
 * alternates between two faults has an immediate predecessor that sometimes
 * matches by coincidence. Requiring all of them to agree makes the signal mean
 * what its consumer reads it as, and it needs no ordering across refs to
 * compute — which matters, because a branch's failures live under several and
 * their relative times are not recorded.
 *
 * Undefined whenever the answer is not unambiguous: no prior failures, a reason
 * missing from any of them, or more than one distinct reason. The notifier's
 * third disposition then does not fire, which is the safe direction — it tells
 * an author to hold, and holding on a branch that is genuinely broken in a new
 * way each time would be the same defect pointing the other way.
 */
/** Spread-shaped: a record never carries `priorReason: undefined`, it carries no field. */
async function priorFailureReason(
  run: Run,
  entry: QueueEntry,
  endedRecord: string,
): Promise<Readonly<{ priorReason?: string }>> {
  const reason = await priorFailureReasonOf(run, entry, endedRecord)
  return reason === undefined ? {} : { priorReason: reason }
}

async function priorFailureReasonOf(run: Run, entry: QueueEntry, endedRecord: string): Promise<string | undefined> {
  const elsewhere = run.queue
    .filter((candidate) => {
      if (candidate.change.branch !== entry.change.branch || candidate.change.head === entry.change.head) return false
      const tip = tipOf(candidate.change)
      return endedKind(tip) === "failed" && !MOVED_ON.has(trailer(tip, "Reason") ?? "")
    })
    .map((candidate) => trailer(tipOf(candidate.change), "Reason"))
  // `own` is append-ordered under one ref and its LAST failed record is the
  // ending being written right now, which is not its own predecessor.
  const own = (await readRecords(run.git, endedRecord))
    .filter((record) => record.kind === "failed" && !MOVED_ON.has(trailer(record, "Reason") ?? ""))
    .map((record) => trailer(record, "Reason"))
  return sameFailureReason([...elsewhere, ...own.slice(0, -1)])
}

async function failuresOf(run: Run, entry: QueueEntry, endedRecord: string): Promise<number> {
  const elsewhere = run.queue.filter((candidate) => {
    if (candidate.change.branch !== entry.change.branch || candidate.change.head === entry.change.head) return false
    const tip = tipOf(candidate.change)
    return endedKind(tip) === "failed" && !MOVED_ON.has(trailer(tip, "Reason") ?? "")
  }).length
  // Count through the written ending, regardless of concurrent local ref changes.
  const own = await readRecords(run.git, endedRecord)
  return (
    elsewhere +
    own.filter((record) => record.kind === "failed" && !MOVED_ON.has(trailer(record, "Reason") ?? "")).length
  )
}

/** How one notify entry went: it took the record, there was none to take it, or it exited non-zero. */
type Delivery = "sent" | "none" | "failed"

/**
 * The notify exit that says the transport answered and refused the send, with
 * the reason on the entry's last non-empty stdout line: never send this ending
 * to that name again. Not 3, which a check uses for cannot-judge.
 */
const REFUSED_EXIT = 4

/**
 * How many times one ending is handed to a name that gives no receipt: the
 * first telling and exactly one more round. Counted from the ending's own
 * records, so nothing new is stored.
 */
const ATTEMPTS = 2

/** How long one notify entry may run before the queue stops waiting for its answer. */
const NOTIFY_TIMEOUT_MS = 60_000

/** One entry's turn: which entry, how it went, and the reason when the transport refused it. */
type Handed = Readonly<{ name: string; delivery: Delivery; failure?: string; refused?: string }>

/**
 * Give one record to every `notify:` entry that wants this ending, in the order
 * the declaration lists them, and say how each went.
 *
 * An ending no entry wants is answered by one turn under the name `none` and
 * `Delivery: none` (ruling A4): the queue still records that it had something
 * to say and nobody to say it to, because an ending with no record at all reads
 * exactly like an ending nobody has got to yet.
 */
async function notifyAll(
  run: Run,
  ending: Ending,
  record: NotifyRecord,
  selected?: readonly Notifier[],
): Promise<readonly Handed[]> {
  const wanted = selected ?? (run.options.notify ?? []).filter((entry) => entry.on.includes(ending))
  if (wanted.length === 0) return [{ delivery: "none", name: NOBODY }]
  const handed: Handed[] = []
  for (const entry of wanted) handed.push({ ...(await deliver(run, entry, record)), name: entry.name })
  return handed
}

/**
 * Run one notify entry's command, the record a JSON object on its stdin, and
 * say how it went: `sent` when it accepted the record, `failed` with why when it
 * exited non-zero, and `refused` beside that when it exited {@link REFUSED_EXIT}.
 * A command that fails changes nothing about what a change IS: the ended record
 * stands and the failed delivery is recorded under that immutable identity.
 * Nothing here throws, so a failed notifier can never end a merged change stuck.
 */
async function deliver(
  run: Run,
  entry: Notifier,
  record: NotifyRecord,
): Promise<Readonly<{ delivery: Delivery; failure?: string; refused?: string }>> {
  try {
    const { cwd, runner } = await notificationEnvironment(run)
    const result = await runner.run({
      argv: shellCommand(entry.run),
      cwd,
      env: run.options.env,
      stdin: `${JSON.stringify(record)}\n`,
      timeoutMs: NOTIFY_TIMEOUT_MS,
    })
    if (result.exitCode === 0) return { delivery: "sent" }
    const bound = result.timedOut ? ` ran past its ${String(NOTIFY_TIMEOUT_MS)}ms bound and` : ""
    const failure =
      `the notify entry ${entry.name} in ${cwd}${bound} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`.replace(
        /\s+/gu,
        " ",
      )
    // An entry the bound killed gave no answer, whatever it printed first.
    if (result.exitCode !== REFUSED_EXIT || result.timedOut) return { delivery: "failed", failure }
    const reason = result.stdout
      .split(/\r\n|\n|\r/u)
      .map((line) => line.trim())
      .findLast((line) => line !== "")
    return {
      delivery: "failed",
      failure,
      refused: reason ?? `exited ${String(REFUSED_EXIT)}, the refusal exit, and printed no reason on stdout`,
    }
  } catch (error) {
    return {
      delivery: "failed",
      failure: `the notify entry ${entry.name} at queue commit ${run.targetSha} could not run: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Every notification in a run uses one prepared, captured-base checkout. */
const notificationEnvironments = new WeakMap<Run, Promise<Readonly<{ cwd: string; runner: Process }>>>()

function notificationEnvironment(run: Run): Promise<Readonly<{ cwd: string; runner: Process }>> {
  let prepared = notificationEnvironments.get(run)
  if (prepared === undefined) {
    prepared = (async () => {
      const runner = run.options.process ?? run.resources.use(createProcess({ cwd: run.options.repo }))
      const path = join(run.worktrees, "notify")
      const tree = await prepareWorktree(run.git, run.options.repo, run.targetSha, path, {
        targetSha: run.targetSha,
        process: runner,
        env: run.options.env,
        plumbing: run.plumbing,
        populateReference: run.options.populateReference,
        ...(run.options.setup === undefined
          ? {}
          : {
              setup: {
                run: run.options.setup,
                logDir: join(run.options.workdir, "checks", "notify", run.log.id),
                tmpdir: join(run.tmpdir, "notify", run.log.id),
              },
              starting: ({ start, log }) =>
                recordProgramStart(run, {
                  branch: run.options.target.branch,
                  head: run.targetSha,
                  name: "setup",
                  phase: "notify",
                  start,
                  log,
                }),
              record: ({ start, end, result }) =>
                recordProgramResult(
                  run,
                  {
                    branch: run.options.target.branch,
                    head: run.targetSha,
                    name: "setup",
                    phase: "notify",
                    start,
                    end,
                  },
                  result,
                ),
            }),
      })
      run.resources.defer(() => tree.remove())
      return { cwd: tree.path, runner }
    })()
    notificationEnvironments.set(run, prepared)
  }
  return prepared
}

/** An ended record's result, as its sent record carries it forward. */
const RESULT_TRAILERS = new Set([
  "Reason",
  "Fault",
  "Remedy",
  "Check",
  "Merge",
  "Base",
  "Gitlink",
  "Merged-By",
  ...INCIDENT_TRAILERS,
])
