/**
 * #37838: the computed `in_progress` columns. A provider answer says what the work item is; only Yrd knows which
 * of its environments still holds an issue open, so this module joins the two on the issue key the provider
 * already prints. Slice 1 reads environments only; owner activity is slice 2.
 *
 * Shape, agreed with the paged reader (@dev/3, #37793): `list-page` rows are `{path, version, row}` and the columns
 * go inside `row`; `view` is one flat issue object and the columns go beside `status`/`owner`.
 */
import type { IssuesVerb } from "./declaration.ts"

/** One environment that names an issue; while it is open, that issue is in progress. */
export type IssuesEnvironmentHold = Readonly<{ name: string; issue: string; expiresAt?: string }>

export type InProgressColumns = Readonly<{ in_progress: boolean; in_progress_reason: string | null }>

export type InProgressAnnotation =
  | Readonly<{ ok: true; result: unknown; notice?: string }>
  | Readonly<{ ok: false; fault: "environment" | "provider"; detail: string }>

const IDLE: InProgressColumns = { in_progress: false, in_progress_reason: null }

/** Open means an expiry still ahead of now; `expiresAt <= now` is closed, and an unreadable expiry is not a guess. */
function openHolds(
  holds: readonly IssuesEnvironmentHold[],
  now: number,
): ReadonlyMap<string, string> | Readonly<{ unreadable: string }> {
  const byIssue = new Map<string, string>()
  for (const hold of [...holds].sort((left, right) => left.name.localeCompare(right.name))) {
    if (hold.expiresAt !== undefined) {
      const expiresAt = Date.parse(hold.expiresAt)
      if (Number.isNaN(expiresAt)) {
        return { unreadable: `environment ${hold.name} has an unreadable expiresAt ${JSON.stringify(hold.expiresAt)}` }
      }
      if (expiresAt <= now) continue
    }
    if (!byIssue.has(hold.issue)) byIssue.set(hold.issue, hold.name)
  }
  return byIssue
}

function columns(id: string, open: ReadonlyMap<string, string>): InProgressColumns {
  const environment = open.get(id)
  return environment === undefined ? IDLE : { in_progress: true, in_progress_reason: `environment ${environment}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function issueId(row: Record<string, unknown>): string | undefined {
  return typeof row.id === "string" && row.id.length > 0 ? row.id : undefined
}

/**
 * Locate the provider's issue rows and put the columns on them. Returns the shape it could not read instead of
 * leaving a consumer to read an absent `in_progress` as false.
 */
export function annotateInProgress(
  verb: IssuesVerb,
  result: unknown,
  holds: readonly IssuesEnvironmentHold[],
  now: number,
): InProgressAnnotation {
  if (verb !== "view" && verb !== "list-page" && verb !== "list") return { ok: true, result }
  const open = openHolds(holds, now)
  if ("unreadable" in open) return { ok: false, fault: "environment", detail: open.unreadable }

  if (verb === "view") {
    if (!isRecord(result)) return skip(result)
    const id = issueId(result)
    // A provider answer that is not an issue object at all passes back whole (the interface's contract); one that
    // carries issue fields but no key is a broken answer, and a column guessed false would hide held work.
    if (id === undefined) {
      return "status" in result
        ? {
            ok: false,
            fault: "provider",
            detail: `expected one issue object with a string id, found ${describe(result)}`,
          }
        : skip(result)
    }
    return { ok: true, result: { ...result, ...columns(id, open) } }
  }

  if (verb === "list-page") {
    const page = isRecord(result) ? result : undefined
    const rows = page?.rows
    if (!Array.isArray(rows)) return skip(result)
    if (!rows.every((entry) => isRecord(entry) && isRecord(entry.row))) return skip(result)
    const shaped = rows as readonly Readonly<{ row: Record<string, unknown> }>[]
    const annotated: unknown[] = []
    for (const [index, entry] of shaped.entries()) {
      const row = entry.row
      const id = issueId(row)
      if (id === undefined) {
        return {
          ok: false,
          fault: "provider",
          detail: `row ${String(index)} carries no string id; cannot say whether it is in progress`,
        }
      }
      annotated.push({ ...entry, row: { ...row, ...columns(id, open) } })
    }
    return { ok: true, result: { ...page, rows: annotated } }
  }

  // The unpaged `list` dump has no fixed row shape across providers: annotate what is recognisable, and say so
  // rather than let an absent column read as false.
  const entries = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.rows)
      ? result.rows
      : undefined
  if (entries === undefined) {
    return skip(result)
  }
  if (!entries.every((entry) => isRecord(entry) && issueId(entry) !== undefined)) {
    return { ok: true, result, notice: "yrd issues list: rows without a string id; in_progress columns skipped\n" }
  }
  const annotated = entries.map((entry) => {
    const row = entry as Record<string, unknown>
    return { ...row, ...columns(row.id as string, open) }
  })
  return {
    ok: true,
    result: Array.isArray(result) ? annotated : { ...(result as Record<string, unknown>), rows: annotated },
  }
}

/** A shape this reader cannot place: hand the provider's answer back untouched and say so on stderr. */
function skip(result: unknown): InProgressAnnotation {
  return {
    ok: true,
    result,
    notice: `yrd issues: no issue rows located (${describe(result)}); in_progress columns skipped\n`,
  }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `an array of ${String(value.length)}`
  return typeof value === "object"
    ? `an object with keys ${JSON.stringify(Object.keys(value).slice(0, 6))}`
    : typeof value
}
