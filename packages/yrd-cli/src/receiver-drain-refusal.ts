import type { ReceiverAmbiguousResult, ReceiverDrainResult } from "@yrd/bay"
import type { ConditionalLogger } from "loggily"

/**
 * What the runtime says about a receiver inbox entry it could not take — one
 * row per entry, and whether any of them is fatal.
 *
 * Before this existed the whole trace was the bare line the CLI prints on the
 * way out: `error: receiver inbox did not drain cleanly: {"failed":[],
 * "ambiguous":["816c247d…"]}`. A plain `error:` on stderr, not an ERROR-level
 * record, so a log reader counting ERROR rows saw zero; and an opaque 64-hex id
 * with no branch, ref, head, age or file.
 *
 * The two kinds are reported differently because they ARE different, and
 * conflating them is what took the queue down on 2026-09-01:
 *
 * - **failed** is wreckage — a result that would not parse, or whose stored
 *   authorization no longer matches the push it claims. ERROR, and fatal: it is
 *   an integrity signal about this inbox.
 * - **ambiguous** is not. `pre-receive` stores the entry BEFORE Git decides
 *   whether to accept the update, so a ref that does not contain the head means
 *   only that the push never completed — in flight, rejected downstream, or
 *   abandoned, three events with byte-identical files. WARN, and skipped: the
 *   drain retries it every pass, so one submitter's interrupted push must not
 *   stop the queue for everybody (it did, for an hour, while eight eligible
 *   changes waited behind a row none of them had anything to do with).
 *
 * The rows carry the instance in the message and the constant `action` in the
 * fields, per docs/principles.md § Log and Error Messages: two entries never
 * read identically because each names its own id, branch, ref, age and file.
 */
export type ReceiverDrainRefusalRow = Readonly<{
  message: string
  fields: Readonly<Record<string, string | number | undefined>>
}>

export type ReceiverDrainOutcome = Readonly<{
  /** WARN rows: entries this pass skipped and a later pass will retry. */
  skipped: readonly ReceiverDrainRefusalRow[]
  /** ERROR rows: entries that make this drain fatal. */
  fatal: readonly ReceiverDrainRefusalRow[]
  /**
   * The one-line refusal the runtime dies with, or absent when nothing is
   * fatal. Absent is a real answer: it is how "the inbox had entries it could
   * not take, and the queue runs anyway" is represented.
   */
  summary?: string
}>

/** Long enough to be unique within one inbox, short enough to read in a row. */
const SHORT_ID = 12

function short(hex: string): string {
  return hex.slice(0, SHORT_ID)
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/** Whole minutes since the receiver stamped the entry; undefined only for a
 * stamp that does not parse, which the caller must then SAY, never round to 0. */
function ageMinutes(receivedAt: string, nowMs: number): number | undefined {
  const stampMs = Date.parse(receivedAt)
  return Number.isFinite(stampMs) ? Math.max(0, Math.round((nowMs - stampMs) / 60_000)) : undefined
}

function ambiguousRow(entry: ReceiverAmbiguousResult, nowMs: number): ReceiverDrainRefusalRow {
  const age = ageMinutes(entry.receivedAt, nowMs)
  const prepared =
    age === undefined ? `at an unparseable time '${entry.receivedAt}'` : `${String(age)} min ago (${entry.receivedAt})`
  const head = short(entry.headSha)
  return {
    message:
      `receiver inbox entry ${short(entry.id)} for branch '${entry.branch}' is ambiguous and was SKIPPED: ` +
      `pre-receive prepared it ${prepared} for ${entry.ref} -> ${head}, but ${entry.ref} does not contain ${head}, ` +
      `so the push never completed and the queue cannot see it; the rest of the inbox drained and every later pass ` +
      `retries this entry, delivering it if ${entry.ref} comes to contain ${head} — otherwise retire ${entry.path}. ` +
      `Pushing the branch again does NOT clear it (a re-push is a new entry beside this one)`,
    fields: {
      action: "receiver-drain-ambiguous",
      disposition: "skipped",
      id: entry.id,
      path: entry.path,
      ref: entry.ref,
      branch: entry.branch,
      headSha: entry.headSha,
      receivedAt: entry.receivedAt,
      ageMinutes: age,
    },
  }
}

function failedRow(entry: ReceiverDrainResult["failed"][number]): ReceiverDrainRefusalRow {
  return {
    message:
      `receiver inbox entry ${short(entry.id)} failed to drain: ${entry.error}; it stays in the inbox and every ` +
      `runtime start refuses to drain until that cause is fixed`,
    fields: { action: "receiver-drain-failed", disposition: "fatal", id: entry.id, error: entry.error },
  }
}

export function describeReceiverDrainOutcome(
  result: Pick<ReceiverDrainResult, "failed" | "ambiguous">,
  nowMs: number,
): ReceiverDrainOutcome {
  const skipped = result.ambiguous.map((entry) => ambiguousRow(entry, nowMs))
  const fatal = result.failed.map(failedRow)
  const failed = result.failed.map((entry) => `${short(entry.id)} (${entry.error})`)
  return {
    skipped,
    fatal,
    // Undefined when nothing is fatal, and that is the whole behaviour change:
    // a summary built from ambiguous entries would be a refusal sentence with
    // nothing to refuse. Ambiguous entries are named in `skipped` instead.
    ...(failed.length === 0
      ? {}
      : {
          summary:
            `yrd: receiver inbox did not drain cleanly: ${String(failed.length)} failed ` +
            `${plural(failed.length, "entry", "entries")} — ${failed.join(", ")}; every runtime start refuses until ` +
            `each is resolved (the ERROR rows above name each entry's cause)`,
        }),
  }
}

/**
 * Log every row on the receiver logger and hand back the refusal to throw, or
 * `undefined` when the drain may proceed.
 *
 * One function so the LEVEL and the DISPOSITION cannot drift apart: an entry
 * reported at WARN is one this returns no error for, and an entry reported at
 * ERROR is one it does. A caller cannot log "skipped" and then die anyway.
 */
export function reportReceiverDrainOutcome(
  log: ConditionalLogger,
  result: Pick<ReceiverDrainResult, "failed" | "ambiguous">,
  nowMs: number,
): Error | undefined {
  const outcome = describeReceiverDrainOutcome(result, nowMs)
  for (const row of outcome.skipped) log.warn?.(row.message, row.fields)
  for (const row of outcome.fatal) log.error?.(row.message, row.fields)
  return outcome.summary === undefined ? undefined : new Error(outcome.summary)
}
