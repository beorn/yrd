/**
 * The page plain `yrd list` (= `yrd queue list`) prints: the watch's own
 * screen, once, to a string. The retired CLI drew its one-shot list through
 * silvery's `renderString` (output.tsx at dc1142b3) — a Table with STATE bold
 * in the state's colour, the queue pills and the RUNNER box above it — and the
 * flag day replaced that with a bare line per row. This restores the one-shot
 * print through the SAME components the live pane draws with, so the plain
 * list and the watch cannot show different columns, colours or words for the
 * same change: one renderer, drawn once here and every round there.
 *
 * Reached only through `await import()` from the list command's human path:
 * `--json`, `--version` and every one-shot command that prints no table stay
 * as cold as the cold-graph test pins, and a pipe gets the same page without
 * colour (`plain`), so `yrd list | grep merged` keeps working.
 */

import React from "react"
import { Box, Text, renderString } from "silvery"
import { ListStack, LoudPause } from "./watch-frame.tsx"
import { NowProvider } from "./watch-clock.ts"
import { ListHeader, ListRow, TopLine, listLayout, separatorBefore } from "./watch-list.tsx"
import type { WatchSnapshot } from "./watch-pane.tsx"

export type ListingPrintOptions = Readonly<{
  /** The terminal's width; the page lays out to it and truncates long cells as the pane does. */
  columns: number
  /** Colour on a terminal; a pipe or a test gets the same page without ANSI. */
  color: boolean
  /** What was queried and what was left out, when a filter narrowed the rows — said above the table. */
  scope?: string
  /** The one-row notices `queue list <branch>` prints under a single match: the notice and the clocks. */
  trailer?: readonly string[]
}>

/** The page as one React tree, so a test can render it into a terminal and a print can render it to a string. */
export function ListingPage({ snapshot, options }: { snapshot: WatchSnapshot; options: ListingPrintOptions }) {
  const { rows, queues } = snapshot
  const label = queues[0]?.label ?? "main"
  const columns = Math.max(40, options.columns)
  const layout = listLayout(rows, label, columns, snapshot.at)
  return (
    <NowProvider readAt={snapshot.at} live={false}>
      <Box flexDirection="column" width={columns} minWidth={0}>
        {/* The pause rides RUNNER's rail; only a page with no run journal says it up here. */}
        <LoudPause snapshot={snapshot} />
        {/* The queue's own name, as a stranger spells it — the line a logged round's `updated` stamp sits under. */}
        <Text wrap="truncate">{snapshot.queue}</Text>
        <TopLine queues={queues} visible={undefined} onToggle={() => undefined} allOn />
        {snapshot.journalAbsent === undefined ? null : (
          <Text color="$fg-muted" wrap="truncate">
            {snapshot.journalAbsent}
          </Text>
        )}
        {options.scope === undefined ? null : (
          <Text color="$fg-muted" wrap="truncate">
            {options.scope}
          </Text>
        )}
        {/* RUNNER above the table, as the retired page had it (24169-old-list.md §1.3), then the rows. */}
        <ListStack snapshot={snapshot} label={label} columns={columns - 2} live={false}>
          <ListHeader layout={layout} />
          {rows.length === 0 ? (
            <Text color="$fg-muted">nothing in line</Text>
          ) : (
            rows.map((item, index) => {
              const separator = separatorBefore(rows, index)
              const key = `${item.row.branch}@${item.row.head}#${item.run?.id ?? item.row.run ?? String(index)}`
              return (
                <Box key={key} flexDirection="column" minWidth={0}>
                  {separator === undefined ? null : (
                    <Text bold color="$fg-muted">
                      {separator}
                    </Text>
                  )}
                  <ListRow item={item} previous={rows[index - 1]} label={label} layout={layout} cursor={false} />
                </Box>
              )
            })
          )}
          {(options.trailer ?? []).map((line) => (
            <Text key={line} wrap="truncate">
              {line}
            </Text>
          ))}
          {options.scope === undefined ? (
            <Text color="$fg-muted">{`${String(rows.length)} change(s) · one row per run per change`}</Text>
          ) : null}
        </ListStack>
      </Box>
    </NowProvider>
  )
}

/** The page as text: ANSI when `color`, plain otherwise; every row present, none scrolled away. */
export async function printListing(snapshot: WatchSnapshot, options: ListingPrintOptions): Promise<string> {
  // Tall enough for every row, its separators, the boxes and their borders: nothing is virtualized here.
  const height = snapshot.rows.length * 2 + 40
  const text = await renderString(<ListingPage snapshot={snapshot} options={options} />, {
    height,
    plain: !options.color,
    width: Math.max(40, options.columns),
  })
  return text.replace(/\s+$/u, "")
}
