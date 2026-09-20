/**
 * The watch's interactive pane: the queue's table on one side, one change
 * opened on the other, refreshing itself until the reader leaves or the change
 * they named ends. The operator's screen (watch-redesign items 1–39, the
 * detail in `watch-detail.tsx`, the table in `watch-list.tsx`), rebuilt on the
 * queue core's `Row`.
 *
 * Three loaders, and the pane reads nothing itself:
 *
 * - `load({ draftWindow })` — the table, every interval, with the drafts of
 *   the window the reader chose; `w` asks for the other window at once.
 * - `open(row)` — one change's detail, for the row under the cursor only.
 *   Called again every round while that change is in line or under a check
 *   (its journal advances under an unmoving tip, so a key on the tip alone
 *   would freeze the step lines for the whole run — item 16 recreated); held
 *   once it has ended. The cache keeps the selection and one row back, keyed
 *   by `watchRowKey`, because the default table has one row per run and two
 *   rows of one change open two details.
 * - `loadDiff(row)` — the unified diff, only when the fold opens.
 *
 * A draft (a head at the remote nobody submitted) has no records, no checks
 * and no diff to read: its row and its detail are drawn from the snapshot
 * alone, and none of the three loaders is called for it (@i/10-yrd/24196).
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
 * `a` shows everything · `w` lists the drafts of the last seven days or every
 * draft · `1`–`9` toggle a queue's pill · `?` this help. The
 * cancel key is NOT ported: a running change is stopped by moving its branch
 * or pausing the queue (S2.2).
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import {
  Box,
  ListView,
  ModalDialog,
  ModalOverlay,
  SplitPane,
  Text,
  clampSplitPaneRatio,
  resolveSplitPaneLayout,
  useInput,
  useScopeEffect,
  useWindowSize,
  type ListViewHandle,
} from "silvery"
import type { GitObservation, Row, StopFact } from "@yrd/queue-core"
import { NowProvider, useMinute } from "./watch-clock.ts"
import { RUNNER_GLYPH, STATE_WORDS, clock, firstLine, legendLines, runShortName, stateGlyph } from "./watch-format.ts"
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
  type DraftWindow,
  type StatusBucket,
  type WatchQueue,
} from "./watch-list.tsx"
import { watchRowKey, type WatchRow } from "./watch-rows.ts"
import { StatsBox } from "./watch-boxes.tsx"
import {
  BandBreakRows,
  ListStack,
  LoudPause,
  QueueLine,
  RunnerDetail,
  queueLine,
  bandHeight,
  bandPlan,
  bandedRows,
  holdsChange,
  runnerOf,
  type BandPlan,
} from "./watch-frame.tsx"
import type { RunnerFacts } from "./watch-runner.ts"
import type { RunDecision } from "./watch-stats.ts"

/** Everything one reading of the queue put on screen. The pane renders it and reads nothing itself. */
export type WatchSnapshot = Readonly<{
  /** Current generic observation; no result survives a failed refresh. */
  observation?: GitObservation
  /** The queue's own name, as a stranger would spell it (`github.com/beorn/hh#main`). */
  queue: string
  /** The queues on this screen: pre-M8 exactly one. */
  queues: readonly WatchQueue[]
  /** The pause line, when the queue is paused. */
  pause?: string
  /** Where the run journal was looked for and why there was none — never a blank where a fact belongs. */
  journalAbsent?: string
  rows: readonly WatchRow[]
  /**
   * Every row of the reading, whatever a selector narrowed `rows` to: the queue line and the RUNNER box count the
   * queue, not the view, as STATS does. The same rows as `rows` when nothing was selected.
   */
  unfiltered: readonly WatchRow[]
  /** What the RUNNER box shows: the newest run journal and its process, read on the queue's own machine. */
  runner?: RunnerFacts
  /** What the STATS box counts: every decision the run journals on this machine recorded. */
  decisions?: readonly RunDecision[]
  /** The instant this reading was made; every age on screen counts from it. */
  at: Date
  /** The stop that stands, as the reading derived it (queue-core `stopFact`); null or absent while the line runs. */
  stopped?: StopFact | null
  /** Which drafts the rows list, and how many drafts have a head this repository has not read. */
  drafts?: Readonly<{ window: DraftWindow; unread: number }>
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
/** The TIME rows under the counts cost five more; below this height the list keeps them. */

export type WatchTier = "right" | "below" | "full"

/** Where the detail goes at this terminal size, or `full` when there is no room for a split. */
// The STATS box needs rows the list would otherwise have: below 30 rows the
// list keeps them all, below 44 the box drops its TIME rows (item 21).
const STATS_TIME_MIN_ROWS = 44
// Below this many rows the status pills give way first, so the table keeps a
// row under the title, the queue line, the header, a band rule, the runner's
// two rows and the footer. The box the 5 in this sum came from is a row now
// (1 + 1 + 1 + 1 + 2 + 1 = 7, and the pills make 8); the ceiling is left where
// it was, which only means the pills give way a little earlier than they must.
const PILLS_MIN_ROWS = 11

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

// Keys in two columns and the legend under them: short and few enough that
// the overlay neither clips nor runs off its own bottom edge at 100x31, the
// narrowest size of the tier ladder.
/** The help dialog's width: the terminal less a margin, and never wider than its longest legend entry needs. */
const HELP_MAX_WIDTH = 120

const HELP = [
  "q            leave the watch                   ?        this help",
  "Enter/Space  open the change                   Escape   close it, or this help",
  "Home         follow the newest rows again      ←/→      move between the tabs",
  "v            fold the diff open or shut        1-9      toggle a queue",
  "o r d f      show one status; O R D F toggle   a        show everything",
  "s            expand or fold STATS              w        drafts of 7d, or every draft",
  "The watch writes nothing. Stop a change by moving its ref or pausing the queue.",
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
  /** One reading of the queue, with the drafts of the window asked for. The pane calls it on a timer and on `w`, and never reads anything itself. */
  load?: (request?: Readonly<{ draftWindow: DraftWindow }>) => Promise<WatchSnapshot>
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
  const { columns, rows: terminalRows } = useWindowSize()
  const tier = watchTier(columns, terminalRows)
  const helpWidth = Math.min(columns - 4, HELP_MAX_WIDTH)
  const [shown, setShown] = useState(snapshot)
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const [readFailure, setReadFailure] = useState<ReadFailure | undefined>(undefined)
  const [detailFailure, setDetailFailure] = useState<(ReadFailure & { key: string }) | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  // Start split layouts with their detail visible; later resizes preserve the
  // operator's open/closed choice instead of reopening it behind their back.
  const [opened, setOpened] = useState(() => tier !== "full")
  const [helpOpen, setHelpOpen] = useState(false)
  const [tab, setTab] = useState<string | undefined>(undefined)
  /** The row the cursor is on, by identity; undefined at the top, following the newest. */
  const [cursorRow, setCursorRow] = useState<WatchRow | undefined>(undefined)
  const [buckets, setBuckets] = useState<ReadonlySet<StatusBucket>>(new Set(BUCKETS))
  const [visibleQueues, setVisibleQueues] = useState<ReadonlySet<string> | undefined>(undefined)
  const [held, setHeld] = useState<readonly HeldDetail[]>([])
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffs, setDiffs] = useState<ReadonlyMap<string, DiffText>>(new Map())
  const [statsOpen, setStatsOpen] = useState(false)
  const centeredRunner = useRef(false)
  const listRef = useRef<ListViewHandle | null>(null)
  /** The drafts the reader asked for, read by every round: a round begun before `w` must not undo it. */
  const draftWindow = useRef<DraftWindow>(snapshot.drafts?.window ?? "7d")

  const refresh = useCallback(async () => {
    if (load === undefined) return
    const asked = draftWindow.current
    const next = await load({ draftWindow: asked })
    if (asked !== draftWindow.current) return
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
            setShown(({ observation: _stale, ...current }) => current)
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
  // filters over the one table (items 9, 32); `all` is every one of both. The
  // bands are applied HERE, before the cursor and the detail read an index, so
  // every one of them addresses the sequence the reader is looking at.
  const visible = bandedRows(
    shown.rows.filter(
      (item) =>
        buckets.has(bucketOf(item.row)) &&
        (visibleQueues === undefined || shown.queues.length === 0 || visibleQueues.has(shown.queues[0]?.label ?? "")),
    ),
    holdsChange(runnerOf(shown, shown.at).state),
  )

  // Where the cursor's row is NOW; when it left the table, the cursor stays
  // where it was (its neighbour) and the row that left is named below.
  const cursorKey = cursorRow === undefined ? undefined : watchRowKey(cursorRow)
  const keyed = cursorKey === undefined ? -1 : visible.findIndex((item) => watchRowKey(item) === cursorKey)
  const at = keyed >= 0 ? keyed : Math.min(cursor, Math.max(0, visible.length - 1))
  const vanished = cursorKey !== undefined && keyed < 0 && visible.length > 0 ? cursorRow : undefined
  useEffect(() => {
    if (centeredRunner.current || visible.length === 0) return
    const heldAt = visible.findIndex((item) => item.row.live !== undefined)
    const doneAt = visible.findIndex((item) => {
      const bucket = bucketOf(item.row)
      return bucket === "done" || bucket === "failed"
    })
    const i = heldAt >= 0 ? heldAt : doneAt
    if (i < 0) return
    centeredRunner.current = true
    setCursor(i)
    setCursorRow(visible[i])
  }, [visible])
  useEffect(() => {
    if (!centeredRunner.current) return
    listRef.current?.scrollToItem(at)
  }, [at])
  useEffect(() => {
    if (keyed >= 0 && keyed !== cursor) setCursor(keyed)
  }, [keyed, cursor])
  const selected = visible[at]
  const selectedKey = selected === undefined ? undefined : watchRowKey(selected)
  const label = shown.queues[0]?.label ?? shown.queue
  // A draft has nothing to load: its detail is drawn from its row.
  const draft = selected?.row.state === "draft" ? selected.row : undefined

  // The detail for the row under the cursor, read only while the detail is
  // open, re-read while the change moves or gains a warning, otherwise held once it ended.
  const heldDetail = held.find((entry) => entry.key === selectedKey)
  const moving = selected !== undefined && (selected.row.position !== undefined || selected.row.live !== undefined)
  const stale =
    selected !== undefined &&
    (heldDetail === undefined ||
      moving ||
      heldDetail.tipAt !== selected.row.at?.getTime() ||
      // Journal reads allocate fresh objects; compare records, not their allocation identity.
      JSON.stringify(heldDetail.detail.row.diagnostics) !== JSON.stringify(selected.row.diagnostics))
  useEffect(() => {
    if (!opened || open === undefined || selected === undefined || selectedKey === undefined || !stale) return
    if (draft !== undefined) return
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
    if (draft !== undefined || diffs.has(selectedKey)) return
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
  }, [diffOpen, draft, loadDiff, selected, selectedKey, diffs])

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
    if (character === "s") setStatsOpen((was) => !was)
    if (character === "w" && load !== undefined) {
      // The other window, read now rather than at the next round, outside any redraw.
      const asked: DraftWindow = draftWindow.current === "7d" ? "all" : "7d"
      draftWindow.current = asked
      void load({ draftWindow: asked }).then(
        (next) => {
          if (asked !== draftWindow.current) return
          setShown(next)
          setReadFailure(undefined)
        },
        (error: unknown) => {
          setReadFailure({ at: new Date(), message: firstLine(error) })
        },
      )
    }
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
  const detailPane =
    draft !== undefined ? (
      <DraftDetail row={draft} />
    ) : (
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
  const list = (
    <ListStack
      snapshot={shown}
      paddingX={1}
      pills={terminalRows < PILLS_MIN_ROWS ? null : <StatusPills buckets={buckets} onSelectOnly={selectOnly} />}
      stats={
        <Box flexDirection="column" flexShrink={0} minWidth={0}>
          <Text wrap="truncate">
            {RUNNER_GLYPH} STATS {queueLine(shown, shown.at, Math.max(20, listColumns - 10))}
          </Text>
          {statsOpen && shown.decisions !== undefined ? (
            <StatsBox
              decisions={shown.decisions}
              columns={listColumns - 2}
              timeRows={terminalRows >= STATS_TIME_MIN_ROWS}
            />
          ) : null}
        </Box>
      }
    >
      <Table
        rows={visible}
        snapshot={shown}
        empty={shown.rows.length === 0 ? "nothing in line" : "no change matches the filters"}
        cursor={at}
        listRef={listRef}
        active={!opened || tier !== "full"}
        live={live}
        onCursor={(index) => {
          setCursor(index)
          // The top row is "the newest", followed as a position; any other row is followed as itself.
          setCursorRow(index === 0 ? undefined : visible[index])
        }}
      />
    </ListStack>
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
        {/* RUNNER owns the pause rail; without a run journal there is no rail,
            so the queue's loudest state is said up here (watch-frame.tsx). */}
        <LoudPause snapshot={shown} />
        {/* The top line is ONLY the title and the queue pills (items 30, 32b, 33). */}
        <TopLine queues={shown.queues} visible={visibleQueues} onToggle={toggleQueue} />
        <QueueLine snapshot={shown} columns={columns} />
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
            {/* A draft is a row and no change: the queue line counts the drafts. */}
            {String(changesIn(visible))} of {String(changesIn(shown.rows))} change(s) · {String(draftsIn(visible))} of{" "}
            {String(draftsIn(shown.rows))} draft(s) · ? for help · q leaves
          </Text>
        </Box>
        {helpOpen ? (
          // An overlay, so the help covers the pane where it stands and moves nothing under it.
          <ModalOverlay
            onClose={() => {
              setHelpOpen(false)
            }}
          >
            <ModalDialog title="yrd watch" width={helpWidth}>
              {HELP.map((line) => (
                <Text key={line}>{line}</Text>
              ))}
              <Text> </Text>
              <Text bold>States</Text>
              {/* Wrapped to the dialog's inside, its padding taken off, so no entry wraps a second time. */}
              {legendLines(helpWidth - 4).map((line, index) => (
                <Text key={`${String(index)}:${line}`}>{line === "" ? " " : line}</Text>
              ))}
            </ModalDialog>
          </ModalOverlay>
        ) : null}
      </Box>
    </NowProvider>
  )
}

/** How many of these rows are changes: every row but a draft's. */
function changesIn(rows: readonly WatchRow[]): number {
  return rows.filter((item) => item.row.state !== "draft").length
}

/** How many of these rows are drafts: the other population the footer must name. */
function draftsIn(rows: readonly WatchRow[]): number {
  return rows.filter((item) => item.row.state === "draft").length
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

/**
 * A draft, opened: what its row knows and what would make it a change. Drawn
 * from the row alone; a draft has no records, checks or diff to read.
 */
function DraftDetail({ row }: { row: Row }) {
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={1}>
      <Text bold wrap="truncate">
        {stateGlyph(row)} {STATE_WORDS.draft.word} {row.branch}@{row.head.slice(0, 12)}
      </Text>
      <Text color="$fg-muted" wrap="wrap">
        {STATE_WORDS.draft.means}
      </Text>
      {row.movedSinceSubmit === true ? <Text wrap="wrap">the head moved since its last submit</Text> : null}
      {row.at === undefined ? (
        <Text wrap="wrap">
          not yet read: this repository has not fetched the head, so its author and time are unknown
        </Text>
      ) : (
        <Text wrap="wrap">
          committed {clock(row.at, { seconds: true })}
          {row.author === undefined ? "" : ` by ${row.author}`}
        </Text>
      )}
      <Text wrap="wrap">run yrd submit {row.branch} to queue this head</Text>
    </Box>
  )
}

/**
 * The table: header, then the virtualized rows with their band rules, the
 * runner's row and a date separator between days.
 *
 * The bands come from `bandPlan` (watch-frame.tsx) and nowhere else. A break
 * costs rows, so `estimateHeight` budgets for it: a virtualized list that
 * under-reports a row's height lays every box below it that many rows too
 * high, which is how the STATS border landed on the footer once already.
 */
function Table({
  rows,
  snapshot,
  empty,
  cursor,
  listRef,
  active,
  onCursor,
  live,
}: {
  rows: readonly WatchRow[]
  /** The whole reading: the runner's row is the queue's, never the selector's. */
  snapshot: WatchSnapshot
  /** What an empty table says: an empty queue and a filter that hides everything are different facts. */
  empty: string
  cursor: number
  listRef: RefObject<ListViewHandle | null>
  active: boolean
  onCursor: (index: number) => void
  /** False in a test or a one-shot print: passed straight through to every row's own gate. */
  live: boolean
}) {
  // Column widths depend on how long a duration prints, which changes on the
  // minute at most; the seconds belong to the cells, not to the table.
  const minute = useMinute()
  const { columns } = useWindowSize()
  const runner = runnerOf(snapshot, minute)
  const queue = { digit: 1, label: snapshot.queues[0]?.label ?? snapshot.queue }
  const layout = listLayout(rows, columns, minute, runner, queue)
  const plan: BandPlan = bandPlan(rows, columns - 4, snapshot.drafts?.window ?? "7d", holdsChange(runner.state))
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      <ListHeader layout={layout} />
      {rows.length === 0 ? (
        <>
          <BandBreakRows brk={plan.before.get(0) ?? plan.after} snapshot={snapshot} layout={layout} />
          <Text color="$fg-muted">{empty}</Text>
        </>
      ) : (
        <ListView
          ref={listRef}
          items={[...rows]}
          getKey={watchRowKey}
          cursorKey={cursor}
          nav
          active={active}
          virtualization="index"
          estimateHeight={(index: number) =>
            (separatorBefore(rows, index) === undefined ? 1 : 2) +
            bandHeight(plan.before.get(index)) +
            (plan.holding === index ? 1 : 0)
          }
          // Hover is an affordance, not a selection: the row under the pointer
          // is tinted (`meta.isHovered` below) and the cursor stays put, so a
          // detail open on one change is not switched by a passing mouse. A
          // click selects, as ListView does by default.
          onItemHover={() => undefined}
          onCursor={onCursor}
          renderItem={(item: WatchRow, index: number, meta: { isHovered: boolean }) => {
            const separator = separatorBefore(rows, index)
            const brk = plan.before.get(index)
            const row = (
              <ListRow
                item={item}
                layout={layout}
                cursor={index === cursor}
                hovered={meta.isHovered}
                live={live}
                queueDigit={queue.digit}
                queueLabel={queue.label}
              />
            )
            if (separator === undefined && brk === undefined && plan.holding !== index) return row
            return (
              <Box flexDirection="column">
                <BandBreakRows brk={brk} snapshot={snapshot} layout={layout} />
                {separator === undefined ? null : (
                  <Text bold color="$fg-muted">
                    {separator}
                  </Text>
                )}
                {row}
                {/* The runner's second line hangs under the row that IS the runner. */}
                {plan.holding === index ? <RunnerDetail snapshot={snapshot} named /> : null}
              </Box>
            )
          }}
        />
      )}
      {/* Nothing is done yet, so the runner's row follows the last one. */}
      <BandBreakRows brk={rows.length === 0 ? undefined : plan.after} snapshot={snapshot} layout={layout} />
    </Box>
  )
}

/**
 * The code every watched change ended with, or undefined while any is still in
 * line — `yrd check`'s own ladder, where stuck beats failed beats merged, and
 * a withdrawn change stands on the failed rung (@i/10-yrd/24492).
 */
function endingOf(rows: readonly WatchRow[]): 0 | 1 | 2 | undefined {
  // A draft is no change, so it neither holds the watch open nor ends it.
  const states: readonly Row["state"][] = rows.map((row) => row.row.state).filter((state) => state !== "draft")
  if (states.length === 0) return undefined
  if (states.some((state) => state === "queued" || state === "checked")) return undefined
  if (states.some((state) => state === "stuck")) return 2
  if (states.some((state) => state === "failed" || state === "withdrawn")) return 1
  return 0
}
