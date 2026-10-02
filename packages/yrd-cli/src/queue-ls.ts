/**
 * `yrd ls` — group changes by status (in check, waiting, draft, ended in the last 24 h)
 * with issue number, title, and owner seat (#27093).
 */

import type { Row, WatchRow } from "@yrd/queue-core"
import { stateWord } from "./watch-format.ts"

export const LS_FILTER_FIELDS = "branch, subject, issue, submitter, run, failure and state" as const

export function matchesLsTerm(row: WatchRow, term: string): boolean {
  const wanted = term.trim().toLocaleLowerCase()
  if (wanted === "") return true
  return [
    row.row.branch,
    row.row.subject,
    row.row.issue,
    row.row.submitter,
    row.row.author,
    row.run?.id ?? row.row.run,
    row.row.result,
    row.row.reason,
    row.row.state,
    stateWord(row.row),
  ].some((field) => field?.toLocaleLowerCase().includes(wanted) === true)
}

export function filterLsRows(rows: readonly WatchRow[], terms: readonly string[]): readonly WatchRow[] {
  const wanted = terms.map((term) => term.trim()).filter((term) => term !== "")
  if (wanted.length === 0) return rows
  return rows.filter((row) => wanted.some((term) => matchesLsTerm(row, term)))
}

export const LS_STATUS_GROUPS = ["in check", "waiting", "draft", "ended in the last 24 h"] as const

export type LsGroupStatus = (typeof LS_STATUS_GROUPS)[number]

export type QueueLsItem = Readonly<{
  issue?: string
  issueRef?: string
  title: string
  owner: string
  branch: string
  head: string
  status: string
  position?: number
  at?: string
  endedAt?: string
  detail?: string
}>

export type QueueLsGroup = Readonly<{
  status: LsGroupStatus
  count: number
  changes: readonly QueueLsItem[]
}>

export type QueueLsResult = Readonly<{
  queue: string
  at: string
  scope?: string
  groups: readonly QueueLsGroup[]
  byStatus: Record<LsGroupStatus, readonly QueueLsItem[]>
  totalCount: number
}>

/**
 * Extract an issue number or leaf identifier from a change's issue reference,
 * branch name, or commit subject.
 */
export function extractIssueNumber(row: Row): string | undefined {
  if (row.issue !== undefined && row.issue.trim() !== "") {
    const raw = row.issue.trim()
    const leaf = raw.split("/").at(-1) ?? raw
    const numMatch = leaf.match(/(?:^|[\/@#\-_])(\d{4,6})(?:[-/.]|$)/) ?? leaf.match(/^#?(\d+)(?:[-/.]|$)/)
    if (numMatch !== null) return numMatch[1]
    if (leaf !== "") return leaf
  }
  if (row.branch !== undefined) {
    const leaf = row.branch.split("/").at(-1) ?? row.branch
    const branchMatch = leaf.match(/(?:^|[\/@#\-_])(\d{4,6})(?:[-/.]|$)/) ?? leaf.match(/^#?(\d+)(?:[-/.]|$)/)
    if (branchMatch !== null) return branchMatch[1]
  }
  if (row.subject !== undefined) {
    const subMatch = row.subject.match(/(?:#|\b)(\d{4,6})\b\)?$/)
    if (subMatch !== null) return subMatch[1]
  }
  return undefined
}

/**
 * Classifies a row into one of the four status groups:
 * - "in check": currently being verified, checked, or merged by a runner
 * - "waiting": queued, stuck, or in line awaiting check
 * - "draft": unsubmitted branch head
 * - "ended in the last 24 h": merged, failed, cancelled, direct, or invalid ended within 24h
 */
export function groupOfRow(row: Row, now: Date = new Date()): LsGroupStatus | undefined {
  if (row.live !== undefined || row.state === "checking" || row.state === "verifying" || row.state === "merging") {
    return "in check"
  }
  if (row.state === "draft") {
    return "draft"
  }
  if (row.state === "queued" || row.state === "stuck" || row.position !== undefined) {
    return "waiting"
  }
  // Terminal / ended states
  if (
    row.state === "merged" ||
    row.state === "failed" ||
    row.state === "cancelled" ||
    row.state === "direct" ||
    row.state === "invalid"
  ) {
    const endedTime = row.endedAt ?? row.at ?? row.since
    if (endedTime !== undefined) {
      const ageMs = now.getTime() - endedTime.getTime()
      if (ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000) {
        return "ended in the last 24 h"
      }
      return undefined
    }
    return "ended in the last 24 h"
  }
  return undefined
}

function timeAgo(date: Date, now: Date): string {
  const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

/**
 * Builds the grouped changes result from the raw queue rows.
 */
export function queueLs(
  rows: readonly WatchRow[],
  options: Readonly<{
    queueName: string
    scope?: string
    now?: Date
    terms?: readonly string[]
  }>,
): QueueLsResult {
  const now = options.now ?? new Date()
  const terms = options.terms
  const filtered =
    terms === undefined || terms.length === 0
      ? rows
      : rows.filter((item) => terms.some((term) => matchesLsTerm(item, term)))

  const grouped: Record<LsGroupStatus, QueueLsItem[]> = {
    "in check": [],
    waiting: [],
    draft: [],
    "ended in the last 24 h": [],
  }

  for (const item of filtered) {
    const row = item.row
    const group = groupOfRow(row, now)
    if (group === undefined) continue

    const issue = extractIssueNumber(row)
    const title = row.subject ?? (row.issue ? row.issue.split("/").at(-1) : undefined) ?? row.branch
    const owner = row.submitter ?? row.author ?? "-"
    const status = stateWord(row)

    let detail: string | undefined
    if (group === "in check") {
      detail = row.live !== undefined ? `checking: ${row.live.check}` : status
    } else if (group === "waiting") {
      detail = row.position !== undefined ? `${row.position} in line` : status
    } else if (group === "ended in the last 24 h") {
      const endedTime = row.endedAt ?? row.at
      detail = endedTime !== undefined ? `${status} ${timeAgo(endedTime, now)}` : status
    }

    grouped[group].push({
      issue,
      ...(row.issue !== undefined ? { issueRef: row.issue } : {}),
      title,
      owner,
      branch: row.branch,
      head: row.head,
      status,
      ...(row.position !== undefined ? { position: row.position } : {}),
      ...(row.at !== undefined ? { at: row.at.toISOString() } : {}),
      ...(row.endedAt !== undefined ? { endedAt: row.endedAt.toISOString() } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  // Sort each group
  grouped["in check"].sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
  grouped["waiting"].sort((left, right) => (left.position ?? 9999) - (right.position ?? 9999))
  grouped["draft"].sort((left, right) => (right.at ?? "").localeCompare(left.at ?? ""))
  grouped["ended in the last 24 h"].sort((left, right) =>
    (right.endedAt ?? right.at ?? "").localeCompare(left.endedAt ?? left.at ?? ""),
  )

  const groups: QueueLsGroup[] = LS_STATUS_GROUPS.map((status) => ({
    status,
    count: grouped[status].length,
    changes: grouped[status],
  }))

  const totalCount = groups.reduce((acc, g) => acc + g.count, 0)

  return {
    queue: options.queueName,
    at: now.toISOString(),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    groups,
    byStatus: grouped,
    totalCount,
  }
}

/**
 * Formats the QueueLsResult as a human-readable table.
 */
export function formatQueueLs(result: QueueLsResult): string {
  const lines: string[] = []

  // Queue and scope header
  lines.push(result.queue)
  if (result.scope !== undefined) {
    lines.push(result.scope)
  }
  lines.push("")

  // Determine column widths across all changes
  const allChanges = result.groups.flatMap((g) => g.changes)
  let maxIssueLen = 6
  let maxOwnerLen = 10

  for (const change of allChanges) {
    const issueTag = change.issue !== undefined ? `#${change.issue}` : "-"
    if (issueTag.length > maxIssueLen) maxIssueLen = issueTag.length
    if (change.owner.length > maxOwnerLen) maxOwnerLen = change.owner.length
  }

  for (const group of result.groups) {
    const headerTitle = group.status.toUpperCase()
    lines.push(`${headerTitle} (${group.count})`)
    if (group.count === 0) {
      lines.push("  none")
    } else {
      for (const change of group.changes) {
        const issueStr = (change.issue !== undefined ? `#${change.issue}` : "-").padEnd(maxIssueLen)
        const ownerStr = change.owner.padEnd(maxOwnerLen)
        const branchStr = `(${change.branch})`
        const detailStr = change.detail !== undefined ? `[${change.detail}]` : ""
        const rowText = `  ${issueStr}  ${ownerStr}  ${change.title}  ${branchStr}${detailStr ? ` ${detailStr}` : ""}`
        lines.push(rowText)
      }
    }
    lines.push("")
  }

  if (result.totalCount === 0) {
    lines.push("0 changes across in check, waiting, draft, ended in the last 24 h")
  }

  return lines.join("\n").trimEnd()
}
