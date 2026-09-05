/**
 * The notify ring: a queue that tells somebody what it did.
 *
 * The bare loop writes records. That is the whole of what a change IS, and a
 * reader who asks the remote sees every ending without anybody being told. This
 * ring is the telling: it runs the `notify:` entries the declaration lists, and
 * writes one sent record per entry that fired, so a reader can see who the queue
 * reached and who it did not.
 *
 * Delivery is at-least-once and never authoritative. A command that fails
 * changes nothing about the change — the ended record stands — and `resend`
 * hands the same record over on the next round, keyed by the ended record's sha,
 * so whoever hears it sees one message however many times it is sent. That
 * repair pass is this ring's own and rides on `bookkeep`; without the ring
 * there is no delivery to repair.
 *
 * Take this file and its line out of rings.ts and the queue merges, fails and
 * gets stuck exactly as it does now, in silence, and no `sent` record is ever
 * written again.
 */

import { createProcess, shellCommand } from "@yrd/process"
import { readCheckTrailer } from "./check.ts"
import type { Ending, Notifier } from "./config.ts"
import { directMergeLine, type DirectMerge } from "./direct.ts"
import { INCIDENT_TRAILERS } from "./incident.ts"
import {
  endedKind,
  readRecord,
  readRecords,
  trailer,
  trailers,
  type ChangeRecord,
  type WriteRecord,
} from "./records.ts"
import { changeName } from "./refs.ts"
import { short, writeRecord, type Ring, type Run } from "./run.ts"
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
    await steps.bookkeep(run, entry)
    // An ended change whose message reached nobody is sent again (at-least-once,
    // § The queue run), so the repair rides on the pass that runs before
    // anything is judged.
    await resend(run, entry)
  },

  ended: async (run, entry, kind, endedRecord, appendTip) => {
    await steps.ended(run, entry, kind, endedRecord, appendTip)
    await told(run, entry, kind, endedRecord, appendTip)
  },

  direct: async (run, commit) => {
    await steps.direct(run, commit)
    await toldDirect(run, commit)
  },
})

/** A commit that went around the queue, told about: there is no change to end. */
async function toldDirect(run: Run, commit: DirectMerge): Promise<void> {
  const target = run.options.target.branch
  const text = `${directMergeLine(commit)}: ${commit.why}. The queue goes on from the new base; a rollback is a git revert, pushed through the queue.`
  // A direct merge has no change, so the commit that went around the queue stands
  // where a change's name would (`NotifyRecord`).
  for (const { name, delivery, failure } of await notifyAll(run, DIRECT, {
    change: commit.commit,
    record: DIRECT,
  })) {
    run.log.write({
      about: target,
      branch: target,
      delivered: delivery === "sent",
      ...(failure === undefined ? {} : { error: failure }),
      head: commit.commit,
      id: commit.commit,
      kind: "message",
      says: DIRECT,
      text,
      to: name,
    })
  }
}

/**
 * Resend an undelivered ending exposed by the captured tip: an ended tip with
 * no sent record (a crash between the two), or a sent record whose delivery
 * failed. The id is the ended record's sha, so whoever hears it can identify
 * repeated attempts (§ The queue run, at-least-once).
 */
async function resend(run: Run, entry: QueueEntry): Promise<void> {
  const tip = tipOf(entry.change)
  // The head is on the target and this tip does not say merged: the catch-up
  // just above owns this change — it wrote the merged record and sent its message
  // this run, so this entry's tip is a reading from before that. Sending from
  // it would put `sent State: failed` on top of a merged change and tell its
  // submitter to fix what has already landed (ruling A2).
  if (entry.change.headOnTarget && endedKind(tip) !== "merged") return
  const undelivered = tip.kind === "sent" && trailer(tip, "Delivery") === "failed"
  const unsent = tip.kind === "failed" || tip.kind === "stuck" || tip.kind === "merged"
  if (!undelivered && !unsent) return
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
  const handed = await notifyAll(run, kind, {
    change: changeName(entry.change),
    record: kind,
    ...(issue === undefined ? {} : { issue }),
    ...(known ? { submitter } : {}),
    ...(kind === "merged" ? { merge: trailer(written, "Merge") ?? "" } : { log, reason: reasonFor(kind, written) }),
    ...(kind === "failed" ? { failures: await failuresOf(run, entry, endedRecord) } : {}),
  })
  let appendTip: string | undefined = initialAppendTip
  for (const { name, delivery, failure } of handed) {
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
        ...(failure === undefined ? [] : [["Delivery-Error", failure] as const]),
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
export type NotifyRecord = Readonly<{
  record: Ending
  change: string
  submitter?: string
  issue?: string
  merge?: string
  reason?: string
  log?: string
  failures?: number
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

/** One entry's turn: which entry, and how it went. */
type Handed = Readonly<{ name: string; delivery: Delivery; failure?: string }>

/**
 * Give one record to every `notify:` entry that wants this ending, in the order
 * the declaration lists them, and say how each went.
 *
 * An ending no entry wants is answered by one turn under the name `none` and
 * `Delivery: none` (ruling A4): the queue still records that it had something
 * to say and nobody to say it to, because an ending with no record at all reads
 * exactly like an ending nobody has got to yet.
 */
async function notifyAll(run: Run, ending: Ending, record: NotifyRecord): Promise<readonly Handed[]> {
  const wanted = (run.options.notify ?? []).filter((entry) => entry.on.includes(ending))
  if (wanted.length === 0) return [{ delivery: "none", name: NOBODY }]
  const handed: Handed[] = []
  for (const entry of wanted) handed.push({ ...(await deliver(run, entry, record)), name: entry.name })
  return handed
}

/**
 * Run one notify entry's command, the record a JSON object on its stdin, and
 * say how it went: `sent` when it accepted the record, `failed` with why when it
 * exited non-zero. A command that fails changes nothing about what a change IS:
 * the ended record stands and the failed delivery is recorded under that
 * immutable identity (ruling D9). Nothing here throws, so a failed notifier can
 * never end a merged change stuck.
 */
async function deliver(
  run: Run,
  entry: Notifier,
  record: NotifyRecord,
): Promise<Readonly<{ delivery: Delivery; failure?: string }>> {
  const command = entry.run
  const runner = run.options.process ?? createProcess({ cwd: run.options.repo })
  const result = await runner.run({
    argv: shellCommand(command),
    cwd: run.options.repo,
    env: run.options.env,
    stdin: `${JSON.stringify(record)}\n`,
    timeoutMs: 60_000,
  })
  if (result.exitCode === 0) return { delivery: "sent" }
  return {
    delivery: "failed",
    failure:
      `the notify entry ${entry.name} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`.replace(
        /\s+/gu,
        " ",
      ),
  }
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
