/**
 * The watch's interactive pane: the change list on one side, one change opened
 * on the other, refreshing itself until the reader leaves or the change they
 * named ends.
 *
 * Ported from the monitor deleted at yrd `1f638504` — its split/focus/scroll
 * shell, its keys and its layout tiers — re-typed against the new core's `Row`
 * and rewritten wherever it read the retired timeline. Nothing here imports
 * `@yrd/queue`, `QueueStatusResult` or a run timeline; nothing here writes;
 * and nothing here derives a change's state, which `readChange` alone does.
 *
 * Keys, kept from the monitor: `q` leaves, `Enter`/`Space` opens the change
 * under the cursor, `Escape` closes it, `End` follows the tail again, `?`
 * opens the help and `Escape` closes it. The cancel key is NOT ported: the way
 * to stop a running change is to move its branch or to pause the queue (S2.2).
 */

import { useCallback, useRef, useState } from "react"
import {
  Box,
  ListView,
  ModalDialog,
  SplitPane,
  Text,
  clampSplitPaneRatio,
  resolveSplitPaneLayout,
  useInput,
  useScopeEffect,
  useWindowSize,
  type ListViewHandle,
} from "silvery"
import type { Row } from "@yrd/queue-core"
import { useCoarseNow } from "./watch-clock.ts"
import { WatchDetail, type ChangeDetail } from "./watch-detail.tsx"
import { rowGlyph, rowLine, type WatchRow } from "./watch-rows.ts"

/** Everything one reading of the queue put on screen. The pane renders it and reads nothing itself. */
export type WatchSnapshot = Readonly<{
  /** The queue's own name, as a stranger would spell it. */
  queue: string
  /** The pause line, when the queue is paused. */
  pause?: string
  /** Where the run journal was looked for and why there was none — never a blank where a fact belongs. */
  journalAbsent?: string
  rows: readonly WatchRow[]
  /** One change opened, by head: its checks with their output. */
  detail: ReadonlyMap<string, ChangeDetail>
  /** The instant this reading was made; every age on screen counts from it. */
  at: Date
}>

// The natural sizes the monitor used, and the ratio it settled on: 0.65 is the
// smallest share that still gives the list 24 rows at the 40-row production
// geometry without changing the tier ladder.
const LIST_NATURAL_WIDTH = 140
const DETAIL_NATURAL_WIDTH = 72
const LIST_NATURAL_HEIGHT = 19
const DETAIL_NATURAL_HEIGHT = 12
const DIVIDER_SIZE = 1
const DEFAULT_SPLIT_RATIO = 0.65

export type WatchTier = "right" | "below" | "full"

/** Where the detail goes at this terminal size, or `full` when there is no room for a split. */
export function watchTier(columns: number, rows: number): WatchTier {
  const layout = resolveSplitPaneLayout({
    availableWidth: columns,
    availableHeight: rows,
    primary: { width: LIST_NATURAL_WIDTH, height: LIST_NATURAL_HEIGHT },
    secondary: { width: DETAIL_NATURAL_WIDTH, height: DETAIL_NATURAL_HEIGHT },
    dividerSize: DIVIDER_SIZE,
    preferredDirection: "row",
  })
  return layout === "row" ? "right" : layout === "column" ? "below" : "full"
}

const HELP = [
  "q          leave the watch",
  "Enter/Space  open the change under the cursor",
  "Escape     close the change, or this help",
  "End        follow the newest rows again",
  "Tab        move between the check tabs",
  "?          this help",
  "",
  "A change is stopped by moving its branch or by pausing the queue,",
  "never from here: the watch reads and writes nothing.",
]

export function WatchPane({
  snapshot,
  load,
  intervalMs = 5000,
  live = true,
  onEnding,
}: {
  snapshot: WatchSnapshot
  /** One reading of the queue. The pane calls it on a timer and never reads anything itself. */
  load?: () => Promise<WatchSnapshot>
  intervalMs?: number
  /** False in a test or a single frame: the tick that ages the screen stands still. */
  live?: boolean
  /** Called with the ending's code when every watched change has ended, so the command can exit with it. */
  onEnding?: (code: 0 | 1 | 2) => void
}) {
  const [shown, setShown] = useState(snapshot)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [checkTab, setCheckTab] = useState<number | undefined>(undefined)
  const [atEnd, setAtEnd] = useState(true)
  const listRef = useRef<ListViewHandle | null>(null)
  const { columns, rows: terminalRows } = useWindowSize()
  const now = useCoarseNow(shown.at, live)
  const tier = watchTier(columns, terminalRows)

  const refresh = useCallback(async () => {
    if (load === undefined) return
    const next = await load()
    setShown(next)
    const code = endingOf(next.rows)
    if (code !== undefined) onEnding?.(code)
  }, [load, onEnding])

  // ONE loop, owned by the scope, so leaving the pane stops it. `scope.sleep`
  // is interruptible; a bare setTimeout would keep a stopped watch alive for
  // one more interval.
  useScopeEffect(
    (scope) => {
      if (load === undefined || !live) return
      void (async () => {
        while (!scope.signal.aborted) {
          await scope.sleep(intervalMs)
          if (scope.signal.aborted) return
          await refresh()
        }
      })().catch((error: unknown) => {
        if (scope.signal.aborted) return
        setFailure(error instanceof Error ? error : new Error(String(error)))
      })
    },
    [intervalMs, live, load, refresh],
  )

  useInput((input, key) => {
    const character = key.text ?? input
    if (character === "?") {
      setHelpOpen((was) => !was)
      return undefined
    }
    if (helpOpen) {
      if (key.escape === true) setHelpOpen(false)
      return undefined
    }
    if (character === "q") return "exit"
    if (key.end === true) {
      listRef.current?.scrollToBottom()
      setAtEnd(true)
      return undefined
    }
    if (key.escape === true) {
      setOpen(false)
      return undefined
    }
    if (key.return === true || (character === " " && key.ctrl !== true && key.meta !== true)) {
      setOpen(true)
      // A newly opened change lands on ITS newest output, not on whatever tab
      // index the previous change happened to leave behind.
      setCheckTab(undefined)
      return undefined
    }
    return undefined
  })

  // A read that failed is thrown, not swallowed: a watch that quietly kept
  // showing a stale table would be the worst of both, and the error boundary
  // above prints what went wrong.
  if (failure !== undefined) throw failure

  const selected = shown.rows[cursor]
  const detail = selected === undefined ? undefined : shown.detail.get(selected.row.head)
  const list = (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      <ListView
        ref={listRef}
        items={[...shown.rows]}
        getKey={(item: WatchRow, index: number) => `${item.row.head}@${item.run?.id ?? String(index)}`}
        cursorKey={cursor}
        nav
        active={!open || tier !== "full"}
        onCursor={(index: number) => {
          setCursor(index)
          setAtEnd(false)
        }}
        renderItem={(item: WatchRow) => (
          <Text wrap="truncate">
            {rowGlyph(item.row)} {rowLine(item)}
          </Text>
        )}
      />
    </Box>
  )
  const body =
    tier === "full" || !open ? (
      open ? (
        <WatchDetail detail={detail} now={now} {...(checkTab === undefined ? {} : { selected: checkTab })} onSelect={setCheckTab} />
      ) : (
        list
      )
    ) : (
      <SplitPane
        direction={tier === "right" ? "row" : "column"}
        ratio={clampSplitPaneRatio(DEFAULT_SPLIT_RATIO, {
          containerSize: tier === "right" ? columns : terminalRows,
          dividerSize: DIVIDER_SIZE,
        })}
        dividerSize={DIVIDER_SIZE}
        primary={list}
        secondary={
          <WatchDetail
            detail={detail}
            now={now}
            {...(checkTab === undefined ? {} : { selected: checkTab })}
            onSelect={setCheckTab}
          />
        }
      />
    )

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {/* The top line: which queue this is, and — loudest first — whether it is
          running at all. */}
      {shown.pause === undefined ? null : (
        <Text bold color="$fg-warning" wrap="truncate">
          {shown.pause}
        </Text>
      )}
      <Text bold wrap="truncate">
        {shown.queue}
      </Text>
      {/* Where the journal was looked for, when there was none. A watch that
          showed no running check because it had no journal to read must say
          so, or it reads as a queue with nothing to do. */}
      {shown.journalAbsent === undefined ? null : (
        <Text color="$fg-muted" wrap="truncate">
          {shown.journalAbsent}
        </Text>
      )}
      {body}
      <Box height={1} flexShrink={0}>
        <Text color="$fg-muted" wrap="truncate">
          {atEnd ? "" : "End follows again · "}
          {String(shown.rows.length)} change(s) · ? for help · q leaves
        </Text>
      </Box>
      {helpOpen ? (
        <ModalDialog title="yrd watch">
          {HELP.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </ModalDialog>
      ) : null}
    </Box>
  )
}

/**
 * The code every watched change ended with, or undefined while any is still in
 * line — `yrd check`'s own ladder, where stuck beats failed beats merged.
 */
function endingOf(rows: readonly WatchRow[]): 0 | 1 | 2 | undefined {
  const states: readonly Row["state"][] = rows.map((row) => row.row.state)
  if (states.length === 0) return undefined
  if (states.some((state) => state === "queued" || state === "checked")) return undefined
  if (states.some((state) => state === "stuck")) return 2
  if (states.some((state) => state === "failed")) return 1
  return 0
}
