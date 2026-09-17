/**
 * The frame the watch and the printed page share — spelled ONCE.
 *
 * The retired surface stacked, top to bottom: the loud pause line only when
 * there is no RUNNER rail to carry it, the title line, the RUNNER box with the
 * pause on its last rail, the table header and rows, the STATS box, the pills
 * (24169-old-watch.md §1, 24169-old-list.md §1). The pane and `yrd list` each
 * spelled that order by hand and drifted apart (2026-09-05: the pane got RUNNER
 * back above the table while the page still printed it last), so the order
 * lives here and both render it.
 *
 * Under the title, both draw the queue line (@i/10-yrd/24196): how many
 * changes wait and why the line is not moving, read from the same rows the
 * table shows.
 */

import type { ReactNode } from "react"
import { Box, Text } from "silvery"
import type { Row } from "@yrd/queue-core"
import { RunnerBox } from "./watch-boxes.tsx"
import { useNow } from "./watch-clock.ts"
import { STATE_WORDS, clock, displayState, mediaDuration } from "./watch-format.ts"
import { bucketOf, clockOf } from "./watch-list.tsx"
import type { WatchSnapshot } from "./watch-pane.tsx"
import type { WatchRow } from "./watch-rows.ts"

/** The pause when nothing else will carry it: RUNNER owns the rail whenever a run journal exists. */
export function pauseWithoutRunner(snapshot: Pick<WatchSnapshot, "pause" | "runner">): string | undefined {
  return snapshot.runner === undefined ? snapshot.pause : undefined
}

/** One loud line above the title — only when there is no RUNNER box to say it. */
export function LoudPause({ snapshot }: { snapshot: Pick<WatchSnapshot, "pause" | "runner"> }) {
  const pause = pauseWithoutRunner(snapshot)
  return pause === undefined ? null : (
    <Text bold color="$fg-warning" wrap="truncate">
      {pause}
    </Text>
  )
}

/**
 * The line as the rows say it: every change holding a place in it, ONCE
 * however many run rows it has. `held` is the change a check runs on right
 * now; `waiting` is every other one. The queue line and the RUNNER rail both
 * count from here, so they cannot disagree.
 */
export function lineOf(rows: readonly WatchRow[]): Readonly<{ held: Row | undefined; waiting: readonly Row[] }> {
  const changes = new Map<string, Row>()
  for (const { row } of rows) {
    if (row.position === undefined) continue
    const key = `${row.branch}@${row.head}`
    if (!changes.has(key) || row.live !== undefined) changes.set(key, row)
  }
  const inLine = [...changes.values()]
  return {
    held: inLine.find((row) => row.live !== undefined),
    waiting: inLine.filter((row) => row.live === undefined),
  }
}

/**
 * The queue line: `5 waiting: 2 pending, 2 submitted, 1 stuck · checking
 * task/x for 3:21 · line stopped at task/s since 11:54 · last merge 11:56
 * (task/y) · 2 drafts (7d), 1 not yet read`.
 *
 * It never wraps. Past its width it drops, in order: the drafts, the
 * breakdown, the last merge's branch, the last merge, the times, the branch
 * and actor names. The waiting count, the check and the stop never drop
 * entirely. The stop is the reading's own (`stopped`, queue-core `stopFact`):
 * a stuck stop names the change it waits on, and an operator's pause names
 * none and says who paused.
 */
export function queueLine(snapshot: WatchSnapshot, now: Date, width: number): string {
  const { held, waiting } = lineOf(snapshot.rows)
  const breakdown = (["pending", "submitted", "stuck"] as const)
    .map((word) => [word, waiting.filter((row) => displayState(row) === word).length] as const)
    .filter(([, count]) => count > 0)
    .map(([word, count]) => `${String(count)} ${STATE_WORDS[word].word}`)
    .join(", ")
  const stop = snapshot.stopped ?? undefined
  const merged = snapshot.rows
    .flatMap(({ row }) => {
      const at = row.state === "merged" ? clockOf(row) : undefined
      return at === undefined ? [] : [{ at, branch: row.branch }]
    })
    .sort((left, right) => right.at.getTime() - left.at.getTime())[0]
  const drafted = new Set(
    snapshot.rows
      .filter(({ row }) => row.state === "draft" && row.at !== undefined)
      .map(({ row }) => `${row.branch}@${row.head}`),
  ).size
  const unread = snapshot.drafts?.unread ?? 0
  const draftWord = STATE_WORDS.draft.word
  const drafts =
    drafted === 0 && unread === 0
      ? undefined
      : `${String(drafted)} ${draftWord}${drafted === 1 ? "" : "s"} (${snapshot.drafts?.window ?? "7d"})` +
        (unread === 0 ? "" : `, ${String(unread)} not yet read`)
  // Each level drops one more part: 1 the drafts, 2 the breakdown, 3 the last merge's branch, 4 the last
  // merge, 5 the times, 6 the names.
  const at = (level: number): string => {
    const times = level < 5
    const names = level < 6
    const parts = [
      `${String(waiting.length)} ${STATE_WORDS.waiting.word}${level < 2 && breakdown !== "" ? `: ${breakdown}` : ""}`,
    ]
    if (held?.live !== undefined) {
      const ran = mediaDuration(now.getTime() - held.live.since.getTime())
      parts.push(`${STATE_WORDS.checking.word}${names ? ` ${held.branch}` : ""}${times ? ` for ${ran}` : ""}`)
    }
    if (stop !== undefined) {
      const since = times ? ` since ${clock(new Date(stop.since))}` : ""
      if (stop.change === null) {
        parts.push(`paused${since}${names && stop.by !== "" ? ` by ${stop.by}` : ""}`)
      } else {
        const branch = stop.change.slice(0, stop.change.lastIndexOf("@"))
        parts.push(`line stopped${names ? ` at ${branch}` : ""}${since}`)
      }
    }
    if (merged !== undefined && level < 4) {
      parts.push(`last merge ${clock(merged.at)}${level < 3 ? ` (${merged.branch})` : ""}`)
    }
    if (drafts !== undefined && level < 1) parts.push(drafts)
    return parts.join(" · ")
  }
  for (let level = 0; level < 6; level += 1) {
    const line = at(level)
    if (line.length <= width) return line
  }
  return at(6)
}

/** The queue line on its own row, under the title: the same text on the pane and the page. */
export function QueueLine({ snapshot, columns }: { snapshot: WatchSnapshot; columns: number }) {
  const now = useNow()
  return (
    <Box height={1} flexShrink={0} minWidth={0} overflow="hidden" paddingX={1}>
      <Text wrap="truncate">{queueLine(snapshot, now, columns - 2)}</Text>
    </Box>
  )
}

/**
 * RUNNER, then the rows, then the pills row, then STATS — the one order (the
 * retired pane's items 2–6). The rows are whatever the caller renders: the
 * pane's virtualised Table, the page's static list. `pills` and `stats` are
 * absent on the page, which prints the rows and nothing interactive.
 */
export function ListStack({
  snapshot,
  label,
  columns,
  children,
  pills,
  stats,
  paddingX = 0,
}: {
  snapshot: WatchSnapshot
  label: string
  /** The inner width the boxes lay out to. */
  columns: number
  children: ReactNode
  pills?: ReactNode
  stats?: ReactNode
  paddingX?: number
}) {
  // The marker's predicate, item 5: a change is under a check RIGHT NOW, never
  // "the service process exists". Read through `bucketOf` so this and the
  // status pills answer the question from one definition -- a second predicate
  // here would drift from the list sitting directly below the box.
  const underCheck = snapshot.rows.some((item) => bucketOf(item.row) === "running")
  // Nothing to say is said by nothing: the native contract observes the root
  // queue only, every round, and a clean root-v1 round has no notice. A
  // reading that failed is loud.
  const observation = snapshot.observation
  const said =
    observation === undefined ||
    observation.contract === "native" ||
    (observation.outcome === "observed" && observation.notices.length === 0)
      ? undefined
      : observation
  const failed = said?.contract === "root-v1" && said.outcome !== "observed"
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={paddingX}>
      {snapshot.runner === undefined ? null : (
        <RunnerBox
          facts={snapshot.runner}
          label={label}
          inLine={lineOf(snapshot.rows).waiting.length}
          underCheck={underCheck}
          columns={columns}
          {...(snapshot.pause === undefined ? {} : { pause: snapshot.pause })}
        />
      )}
      {said === undefined ? null : (
        <Box flexDirection="column" flexShrink={0}>
          <Text {...(failed ? { bold: true, color: "$fg-error" } : {})}>{said.message}</Text>
          {said.notices.map((notice) => (
            <Text key={notice.id}>{notice.text}</Text>
          ))}
        </Box>
      )}
      {children}
      {pills}
      {stats}
    </Box>
  )
}
