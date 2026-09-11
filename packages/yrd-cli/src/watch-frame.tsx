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
 */

import type { ReactNode } from "react"
import { Box, Text } from "silvery"
import { RunnerBox } from "./watch-boxes.tsx"
import { bucketOf } from "./watch-list.tsx"
import type { WatchSnapshot } from "./watch-pane.tsx"

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
 * RUNNER, then the rows, then the pills row, then STATS — the one order (the
 * retired pane's items 2–6). The rows are whatever the caller renders: the
 * pane's virtualised Table, the page's static list. `pills` and `stats` are
 * absent on the page, which prints the rows and nothing interactive.
 */
export function ListStack({
  snapshot,
  label,
  columns,
  live,
  children,
  pills,
  stats,
  paddingX = 0,
}: {
  snapshot: WatchSnapshot
  label: string
  /** The inner width the boxes lay out to. */
  columns: number
  live: boolean
  children: ReactNode
  pills?: ReactNode
  stats?: ReactNode
  paddingX?: number
}) {
  const inLine = snapshot.rows.filter((item) => item.row.position !== undefined).length
  // The marker's predicate, item 5: a change is under a check RIGHT NOW, never
  // "the service process exists". Read through `bucketOf` so this and the
  // status pills answer the question from one definition -- a second predicate
  // here would drift from the list sitting directly below the box.
  const underCheck = snapshot.rows.some((item) => bucketOf(item.row) === "running")
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={paddingX}>
      {snapshot.runner === undefined ? null : (
        <RunnerBox
          facts={snapshot.runner}
          label={label}
          inLine={inLine}
          underCheck={underCheck}
          columns={columns}
          live={live}
          {...(snapshot.pause === undefined ? {} : { pause: snapshot.pause })}
        />
      )}
      {snapshot.observation === undefined ? null : (
        <Box flexDirection="column" flexShrink={0}>
          <Text>{snapshot.observation.message}</Text>
          {snapshot.observation.notices.map((notice) => (
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
