import type { ReceiverAmbiguousResult, ReceiverDrainResult } from "@yrd/bay"
import type { ConditionalLogger } from "loggily"

/**
 * What the runtime says when the receiver inbox will not drain — one ERROR row
 * per entry it could not take, then the refusal it dies with.
 *
 * Before this existed the whole trace was the bare line the CLI prints on the
 * way out: `error: receiver inbox did not drain cleanly: {"failed":[],
 * "ambiguous":["816c247d…"]}`. A plain `error:` on stderr, not an ERROR-level
 * record, so a log reader counting ERROR rows saw zero; an opaque 64-hex id
 * with no branch, ref, head, age or file; and no word about the one thing the
 * entry's owner needed to know — a re-push does NOT clear an ambiguous entry
 * (measured 2026-09-01, while that entry blocked every pass for an hour).
 *
 * The rows carry the instance in the message and the constant `action` in the
 * fields, per docs/principles.md § Log and Error Messages: two entries never
 * read identically because each names its own id, branch, ref, age and file.
 */
export type ReceiverDrainRefusalRow = Readonly<{
  message: string
  fields: Readonly<Record<string, string | number | undefined>>
}>

export type ReceiverDrainRefusal = Readonly<{
  /** One ERROR row per entry the drain could not take, ambiguous first. */
  rows: readonly ReceiverDrainRefusalRow[]
  /** The one-line refusal the runtime dies with; names every entry and the cure. */
  summary: string
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
      `receiver inbox entry ${short(entry.id)} for branch '${entry.branch}' is ambiguous: pre-receive prepared it ` +
      `${prepared} for ${entry.ref} -> ${head}, but ${entry.ref} does not contain ${head}, so the push never ` +
      `completed and the queue cannot see it; every runtime start refuses to drain until ${entry.ref} contains ` +
      `${head} or ${entry.path} is retired — pushing the branch again does NOT clear it (a re-push is a new entry ` +
      `beside this one)`,
    fields: {
      action: "receiver-drain-ambiguous",
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
    fields: { action: "receiver-drain-failed", id: entry.id, error: entry.error },
  }
}

export function describeReceiverDrainRefusal(
  result: Pick<ReceiverDrainResult, "failed" | "ambiguous">,
  nowMs: number,
): ReceiverDrainRefusal {
  const rows = [...result.ambiguous.map((entry) => ambiguousRow(entry, nowMs)), ...result.failed.map(failedRow)]
  const ambiguous = result.ambiguous.map((entry) => {
    const age = ageMinutes(entry.receivedAt, nowMs)
    return `${short(entry.id)} (branch '${entry.branch}', ${age === undefined ? "age unknown" : `${String(age)} min old`})`
  })
  const failed = result.failed.map((entry) => `${short(entry.id)} (${entry.error})`)
  const parts = [
    ...(ambiguous.length === 0
      ? []
      : [
          `${String(ambiguous.length)} ambiguous prepared ${plural(ambiguous.length, "entry", "entries")} whose push ` +
            `never completed — ${ambiguous.join(", ")} — and a re-push does NOT clear them`,
        ]),
    ...(failed.length === 0
      ? []
      : [`${String(failed.length)} failed ${plural(failed.length, "entry", "entries")} — ${failed.join(", ")}`]),
  ]
  return {
    rows,
    summary:
      `yrd: receiver inbox did not drain cleanly: ${parts.join("; ")}; the queue cannot see those pushes and every ` +
      `runtime start refuses until each is resolved (the ERROR rows above name each entry's ref, head, age and file)`,
  }
}

/** Log the rows on the receiver logger and hand back the refusal to throw. */
export function reportReceiverDrainRefusal(
  log: ConditionalLogger,
  result: Pick<ReceiverDrainResult, "failed" | "ambiguous">,
  nowMs: number,
): Error {
  const refusal = describeReceiverDrainRefusal(result, nowMs)
  for (const row of refusal.rows) log.error?.(row.message, row.fields)
  return new Error(refusal.summary)
}
