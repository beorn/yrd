/**
 * The watch's interactive pane: the queue's table on one side, one change
 * opened on the other, refreshing itself until the reader leaves or the change
 * they named ends. The operator's screen (watch-redesign items 1–39, the
 * detail in `watch-detail.tsx`, the table in `watch-list.tsx`), rebuilt on the
 * queue core's `Row`.
 *
 * Three loaders, and the pane reads nothing itself:
 *
 * - `load()` — the table, every interval.
 * - `open(row)` — one change's detail, for the row under the cursor only.
 *   Called again every round while that change is in line or under a check
 *   (its journal advances under an unmoving tip, so a key on the tip alone
 *   would freeze the step lines for the whole run — item 16 recreated); held
 *   once it has ended. The cache keeps the selection and one row back, keyed
 *   by `watchRowKey`, because the default table has one row per run and two
 *   rows of one change open two details.
 * - `loadDiff(row)` — the unified diff, only when the fold opens.
 *
 * Nothing here writes; nothing here derives a change's state, which
 * `readChange` alone does. The 1-second clock lives in `NowProvider` and is
 * read by the leaves that format a relative time, so a tick re-renders those
 * cells and nothing else.
 *
 * A round that fails does not end the watch. The queue is read through a
 * shared refs store that other commands fetch into at the same time, and one
 * such collision (`cannot lock ref … is at X but expected Y`) took the pane
 * down 32 minutes into a soak on 2026-09-05. The retired pane said a failed
 * read in its footer and retried; this one does the same: the table keeps the
 * last reading, a warning line names the failure and the reading's time, and
 * the next round tries again. A failed detail read is said in the detail pane
 * the same way. Both are loud; neither is fatal.
 *
 * The cursor is a ROW, not an index (the retired pane's fixed-row mode): once
 * the operator moves off the top or opens a change, the cursor follows that
 * row's identity (`watchRowKey`) through every re-sort, so an open detail never
 * swaps to whatever row the table moved into its place. At the top with nothing
 * opened it follows the newest row. A row that left the table is said in a
 * warning line, and the cursor stays on its neighbour.
 *
 * Keys: `q` leaves · `Enter`/`Space` opens the change · `Escape` closes it ·
 * `Home` follows the newest rows again · `←`/`→` move between the detail's tabs ·
 * `v` folds the diff · `o r d f` show one status bucket, `O R D F` toggle one,
 * `a` shows everything · `1`–`9` toggle a queue's pill · `?` this help. The
 * cancel key is NOT ported: a running change is stopped by moving its branch
 * or pausing the queue (S2.2).
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
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
import { NowProvider, useMinute } from "./watch-clock.ts"
import { clock, firstLine, runShortName } from "./watch-format.ts"
import { WatchDetail, type ChangeDetail, type DiffText } from "./watch-detail.tsx"
import {
  BUCKETS,
  ListHeader,
  ListRow,
  StatusPills,
  TopLine,
  bucketOf,
  listLayout,
  separatorBefore,
  type StatusBucket,
  type WatchQueue,
} from "./watch-list.tsx"
import { watchRowKey, type WatchRow } from "./watch-rows.ts"
import { RunnerBox, StatsBox } from "./watch-boxes.tsx"
import type { RunnerFacts } from "./watch-runner.ts"
import type { RunDecision } from "./watch-stats.ts"

/** Everything one reading of the queue put on screen. The pane renders it and reads nothing itself. */
export type WatchSnapshot = Readonly<{
  /** The queue's own name, as a stranger would spell it (`github.com/beorn/hh#main`). */
  queue: string
  /** The queues on this screen: pre-M8 exactly one. */
  queues: readonly WatchQueue[]
  /** The pause line, when the queue is paused. */
  pause?: string
  /** Where the run journal was looked for and why there was none — never a blank where a fact belongs. */
  journalAbsent?: string
  rows: readonly WatchRow[]
  /** What the RUNNER box shows: the newest run journal and its process, read on the queue's own machine. */
  runner?: RunnerFacts
  /** What the STATS box counts: every decision the run journals on this machine recorded. */
  decisions?: readonly RunDecision[]
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
/** Below this many terminal rows the STATS box would push the table off the screen, so it yields (the retired pane's own rule). */
const STATS_MIN_ROWS = 30

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

// Short enough that the modal never wraps a line off its own bottom edge at
// the narrowest terminal the pane runs in.
const HELP = [
  "q            leave the watch",
  "Enter/Space  open the change",
  "Escape       close it, or this help",
  "Home         follow the newest rows again",
  "←/→          move between the tabs",
  "v            fold the diff open or shut",
  "o r d f      show one status; O R D F toggle",
  "a            show everything",
  "1-9          toggle a queue",
  "?            this help",
  "",
  "The watch writes nothing. Stop a change",
  "by moving its ref or pausing the queue.",
]

/** A row's detail, read at one instant; held while the change is ended, re-read while it moves. */
type HeldDetail = Readonly<{ key: string; tipAt: number | undefined; detail: ChangeDetail }>

const HELD_DETAILS = 2

export function WatchPane({
  snapshot,
  load,
  open,
  loadDiff,
  intervalMs = 5000,
  live = true,
  onEnding,
}: {
  snapshot: WatchSnapshot
  /** One reading of the queue. The pane calls it on a timer and never reads anything itself. */
  load?: () => Promise<WatchSnapshot>
  /** One change's detail, for the row under the cursor. Absent in a test of the table alone. */
  open?: (row: WatchRow) => Promise<ChangeDetail>
  /** The unified diff of one change, read only when its fold opens. */
  loadDiff?: (row: WatchRow) => Promise<DiffText>
  intervalMs?: number
  /** False in a test or a single frame: the tick that ages the screen stands still and nothing pulses. */
  live?: boolean
  /** Called with the ending's code when every watched change has ended, so the command can exit with it. */
  onEnding?: (code: 0 | 1 | 2) => void
}) {
  const [shown, setShown] = useState(snapshot)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const [readFailure, setReadFailure] = useState<ReadFailure | undefined>(undefined)
  const [detailFailure, setDetailFailure] = useState<(ReadFailure & { key: string }) | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const [opened, setOpened] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tab, setTab] = useState<string | undefined>(undefined)
  /** The row the cursor is on, by identity; undefined at the top, following the newest. */
  const [cursorRow, setCursorRow] = useState<WatchRow | undefined>(undefined)
  const [buckets, setBuckets] = useState<ReadonlySet<StatusBucket>>(new Set(BUCKETS))
  const [visibleQueues, setVisibleQueues] = useState<ReadonlySet<string> | undefined>(undefined)
  const [held, setHeld] = useState<readonly HeldDetail[]>([])
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffs, setDiffs] = useState<ReadonlyMap<string, DiffText>>(new Map())
  const listRef = useRef<ListViewHandle | null>(null)
  const { columns, rows: terminalRows } = useWindowSize()
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
          try {
            await refresh()
            setReadFailure(undefined)
          } catch (error: unknown) {
            if (scope.signal.aborted) return
            // Said, not fatal: the table keeps the last reading, the footer
            // names what failed and when, and the next round tries again.
            setReadFailure({ at: new Date(), message: firstLine(error) })
          }
        }
      })().catch((error: unknown) => {
        if (scope.signal.aborted) return
        setFailure(error instanceof Error ? error : new Error(String(error)))
      })
    },
    [intervalMs, live, load, refresh],
  )

  // The rows on screen: the status buckets and the queue pills are ON/OFF
  // filters over the one table (items 9, 32); `all` is every one of both.
  const visible = shown.rows.filter(
    (item) =>
      buckets.has(bucketOf(item.row)) &&
      (visibleQueues === undefined || shown.queues.length === 0 || visibleQueues.has(shown.queues[0]?.label ?? "")),
  )
  const allOn = buckets.size === BUCKETS.length && visibleQueues === undefined
  // Where the cursor's row is NOW; when it left the table, the cursor stays
  // where it was (its neighbour) and the row that left is named below.
  const cursorKey = cursorRow === undefined ? undefined : watchRowKey(cursorRow)
  const keyed = cursorKey === undefined ? -1 : visible.findIndex((item) => watchRowKey(item) === cursorKey)
  const at = keyed >= 0 ? keyed : Math.min(cursor, Math.max(0, visible.length - 1))
  const vanished = cursorKey !== undefined && keyed < 0 && visible.length > 0 ? cursorRow : undefined
  useEffect(() => {
    if (keyed >= 0 && keyed !== cursor) setCursor(keyed)
  }, [keyed, cursor])
  const selected = visible[at]
  const selectedKey = selected === undefined ? undefined : watchRowKey(selected)
  const label = shown.queues[0]?.label ?? shown.queue

  // The detail for the row under the cursor, read only while the detail is
  // open, re-read every round while the change moves, held once it ended.
  const heldDetail = held.find((entry) => entry.key === selectedKey)
  const moving = selected !== undefined && (selected.row.position !== undefined || selected.row.live !== undefined)
  const stale =
    selected !== undefined && (heldDetail === undefined || moving || heldDetail.tipAt !== selected.row.at?.getTime())
  useEffect(() => {
    if (!opened || open === undefined || selected === undefined || selectedKey === undefined || !stale) return
    let cancelled = false
    void (async () => {
      try {
        const detail = await open(selected)
        if (cancelled) return
        setHeld((was) =>
          [
            { detail, key: selectedKey, tipAt: selected.row.at?.getTime() },
            ...was.filter((entry) => entry.key !== selectedKey),
          ].slice(0, HELD_DETAILS),
        )
        setDetailFailure((was) => (was?.key === selectedKey ? undefined : was))
      } catch (error: unknown) {
        if (cancelled) return
        // Said in the detail pane, not fatal; the next round reads again.
        setDetailFailure({ at: new Date(), key: selectedKey, message: firstLine(error) })
      }
    })()
    return () => {
      cancelled = true
    }
    // `shown.at` is the round: a new reading re-runs this for a moving change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, open, selectedKey, shown.at, stale])

  // The diff, read once per row when its fold opens.
  useEffect(() => {
    if (!diffOpen || loadDiff === undefined || selected === undefined || selectedKey === undefined) return
    if (diffs.has(selectedKey)) return
    let cancelled = false
    void (async () => {
      try {
        const diff = await loadDiff(selected)
        if (cancelled) return
        setDiffs((was) => new Map([...was, [selectedKey, diff]]))
      } catch (error: unknown) {
        if (cancelled) return
        setDiffs(
          (was) => new Map([...was, [selectedKey, { why: error instanceof Error ? error.message : String(error) }]]),
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [diffOpen, loadDiff, selected, selectedKey, diffs])

  const toTop = (): void => {
    setCursor(0)
    setCursorRow(undefined)
  }
  const selectOnly = (bucket: StatusBucket): void => {
    setBuckets(new Set([bucket]))
    toTop()
  }
  const toggleBucket = (bucket: StatusBucket): void => {
    setBuckets((was) => {
      const next = new Set(was)
      if (next.has(bucket)) next.delete(bucket)
      else next.add(bucket)
      return next
    })
    toTop()
  }
  const showAll = (): void => {
    setBuckets(new Set(BUCKETS))
    setVisibleQueues(undefined)
  }
  const toggleQueue = (queueLabel: string): void => {
    setVisibleQueues((was) => {
      const every = new Set(shown.queues.map((queue) => queue.label))
      const next = new Set(was ?? every)
      if (next.has(queueLabel)) next.delete(queueLabel)
      else next.add(queueLabel)
      return next.size === every.size ? undefined : next
    })
    toTop()
  }

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
    if (key.escape === true) {
      setOpened(false)
      return undefined
    }
    if (key.return === true || (character === " " && key.ctrl !== true && key.meta !== true)) {
      setOpened(true)
      // The opened change stays under the cursor whatever the table does.
      setCursorRow(selected)
      // A newly opened change lands on ITS newest output, not on whatever tab
      // the previous change happened to leave behind.
      setTab(undefined)
      setDiffOpen(false)
      return undefined
    }
    if (character === "v" && opened) {
      setDiffOpen((was) => !was)
      return undefined
    }
    if (character === "o") selectOnly("open")
    if (character === "r") selectOnly("running")
    if (character === "d") selectOnly("done")
    if (character === "f") selectOnly("failed")
    if (character === "O") toggleBucket("open")
    if (character === "R") toggleBucket("running")
    if (character === "D") toggleBucket("done")
    if (character === "F") toggleBucket("failed")
    if (character === "a") showAll()
    if (character !== undefined && /^[1-9]$/u.test(character)) {
      const queue = shown.queues[Number(character) - 1]
      if (queue !== undefined) toggleQueue(queue.label)
    }
    return undefined
  })

  // A read that failed is thrown, not swallowed: a watch that quietly kept
  // showing a stale table would be the worst of both, and the error boundary
  // above prints what went wrong.
  if (failure !== undefined) throw failure

  const detail = heldDetail?.detail
  const detailPane = (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {detailFailure === undefined || detailFailure.key !== selectedKey ? null : (
        <Text bold color="$fg-warning" wrap="truncate">
          {readFailureLine(
            "this change's read",
            detailFailure,
            heldDetail === undefined ? "" : "; the detail shown is the last good read",
          )}
        </Text>
      )}
      <WatchDetail
        detail={detail}
        joinedRun={selected?.run !== undefined}
        live={live}
        {...(tab === undefined ? {} : { selected: tab })}
        onSelect={setTab}
        diffOpen={diffOpen}
        {...(selectedKey === undefined || !diffs.has(selectedKey) ? {} : { diff: diffs.get(selectedKey) })}
        onToggleDiff={() => {
          setDiffOpen((was) => !was)
        }}
      />
    </Box>
  )
  // The width the list pane gets: the whole terminal, or its share of a split.
  const listColumns = opened && tier === "right" ? Math.floor(columns * DEFAULT_SPLIT_RATIO) - DIVIDER_SIZE : columns
  const inLine = shown.rows.filter((item) => item.row.position !== undefined).length
  const list = (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={1}>
      <Table
        rows={visible}
        empty={shown.rows.length === 0 ? "nothing in line" : "no change matches the filters"}
        label={label}
        cursor={at}
        listRef={listRef}
        active={!opened || tier !== "full"}
        onCursor={(index) => {
          setCursor(index)
          // The top row is "the newest", followed as a position; any other row is followed as itself.
          setCursorRow(index === 0 ? undefined : visible[index])
        }}
      />
      {shown.runner === undefined ? null : (
        <RunnerBox
          facts={shown.runner}
          label={label}
          inLine={inLine}
          columns={listColumns - 2}
          live={live}
          {...(shown.pause === undefined ? {} : { pause: shown.pause })}
        />
      )}
      {shown.decisions === undefined || terminalRows < STATS_MIN_ROWS ? null : (
        <StatsBox decisions={shown.decisions} columns={listColumns - 2} />
      )}
      <StatusPills buckets={buckets} allOn={allOn} onSelectOnly={selectOnly} onAll={showAll} />
    </Box>
  )
  const body =
    tier === "full" || !opened ? (
      opened ? (
        detailPane
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
        secondary={detailPane}
      />
    )

  return (
    <NowProvider readAt={shown.at} live={live}>
      <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        {/* Loudest first: a queue that is not running is the loudest thing about it. */}
        {shown.pause === undefined ? null : (
          <Text bold color="$fg-warning" wrap="truncate">
            {shown.pause}
          </Text>
        )}
        {/* The top line is ONLY the title and the queue pills (items 30, 32b, 33). */}
        <TopLine
          queues={shown.queues}
          visible={visibleQueues}
          onToggle={toggleQueue}
          allOn={allOn}
          {...(live ? { onShowAll: showAll } : {})}
        />
        {/* Where the journal was looked for, when there was none. A watch that
            showed no running check because it had no journal to read must say
            so, or it reads as a queue with nothing to do. */}
        {shown.journalAbsent === undefined ? null : (
          <Text color="$fg-muted" wrap="truncate">
            {shown.journalAbsent}
          </Text>
        )}
        {body}
        {/* The loudest bottom-row fact, never hidden: a read that failed, with
            the time of the reading the table still shows. */}
        {readFailure === undefined ? null : (
          <Box height={1} flexShrink={0}>
            <Text bold color="$fg-warning" wrap="truncate">
              {readFailureLine(
                "the queue read",
                readFailure,
                `; the table is the ${clock(shown.at, { seconds: true })} reading`,
              )}
            </Text>
          </Box>
        )}
        {vanished === undefined ? null : (
          <Box height={1} flexShrink={0}>
            <Text bold color="$fg-warning" wrap="truncate">
              {`⚠︎ the row under the cursor left the table: ${vanished.row.branch}@${vanished.row.head.slice(0, 12)}${
                vanished.run === undefined ? "" : ` ${runShortName(label, vanished.run.id)}`
              }; the cursor stays on its neighbour, Home follows the newest again`}
            </Text>
          </Box>
        )}
        <Box height={1} flexShrink={0}>
          <Text color="$fg-muted" wrap="truncate">
            {cursorRow === undefined ? "" : "Home follows the newest again · "}
            {String(visible.length)} of {String(shown.rows.length)} change(s) · ? for help · q leaves
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
    </NowProvider>
  )
}

/** One read that failed: when, and the first line of why. */
type ReadFailure = Readonly<{ at: Date; message: string }>

/**
 * The warning line for a failed read, most important first so a narrow screen
 * keeps it: what failed and when, that it retries, what is still on screen,
 * then why. A git failure's why is its stderr, not the command line that ran
 * (`<command> in <dir> exited N: <stderr>` is the core's GitExit format).
 */
function readFailureLine(what: string, failure: ReadFailure, still = ""): string {
  const why = failure.message.replace(/^.* exited \d+: /u, "")
  return `⚠︎ ${what} failed at ${clock(failure.at, { seconds: true })}, retrying${still} — ${why}`
}

/** The table: header, then the virtualized rows with a date separator between days. */
function Table({
  rows,
  empty,
  label,
  cursor,
  listRef,
  active,
  onCursor,
}: {
  rows: readonly WatchRow[]
  /** What an empty table says: an empty queue and a filter that hides everything are different facts. */
  empty: string
  label: string
  cursor: number
  listRef: RefObject<ListViewHandle | null>
  active: boolean
  onCursor: (index: number) => void
}) {
  // Column widths depend on how long a duration prints, which changes on the
  // minute at most; the seconds belong to the cells, not to the table.
  const minute = useMinute()
  const { columns } = useWindowSize()
  const layout = listLayout(rows, label, columns, minute)
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      <ListHeader layout={layout} />
      {rows.length === 0 ? (
        <Text color="$fg-muted">{empty}</Text>
      ) : (
        <ListView
          ref={listRef}
          items={[...rows]}
          getKey={watchRowKey}
          cursorKey={cursor}
          nav
          active={active}
          virtualization="index"
          estimateHeight={(index: number) => (separatorBefore(rows, index) === undefined ? 1 : 2)}
          onItemHover={() => undefined}
          onCursor={onCursor}
          renderItem={(item: WatchRow, index: number) => {
            const separator = separatorBefore(rows, index)
            const row = (
              <ListRow item={item} previous={rows[index - 1]} label={label} layout={layout} cursor={index === cursor} />
            )
            return separator === undefined ? (
              row
            ) : (
              <Box flexDirection="column">
                <Text bold color="$fg-muted">
                  {separator}
                </Text>
                {row}
              </Box>
            )
          }}
        />
      )}
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
