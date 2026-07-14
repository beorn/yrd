import { useEffect, useMemo, useRef, useState } from "react"
import { Box, PaneDivider, Text, useInput, useScopeEffect, useWindowSize } from "silvery"
import {
  QueueEvidenceView,
  QueueShowView,
  QueueTimelineView,
  QueueWatchView,
  queueTimelineRows,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "./queue-status-view.tsx"

const LIST_NATURAL_WIDTH = 80
const DETAIL_NATURAL_WIDTH = 72
const LIST_NATURAL_HEIGHT = 12
const DETAIL_NATURAL_HEIGHT = 12
const DIVIDER_SIZE = 1
const DEFAULT_SPLIT_RATIO = 0.52

export type QueueDetailTier = "right" | "below" | "full"

export type QueueArtifactOutput = Readonly<{
  run: string
  step: string
  attempt: number
  path: string
  text: string
  truncatedBytes?: number
}>

export function queueDetailTier(columns: number, rows: number): QueueDetailTier {
  if (columns >= LIST_NATURAL_WIDTH + DIVIDER_SIZE + DETAIL_NATURAL_WIDTH) return "right"
  if (rows >= LIST_NATURAL_HEIGHT + DIVIDER_SIZE + DETAIL_NATURAL_HEIGHT) return "below"
  return "full"
}

function clampSplitRatio(tier: Exclude<QueueDetailTier, "full">, ratio: number, columns: number, rows: number): number {
  const available = Math.max(1, (tier === "right" ? columns : rows - 1) - DIVIDER_SIZE)
  const listMinimum = tier === "right" ? LIST_NATURAL_WIDTH : LIST_NATURAL_HEIGHT
  const detailMinimum = tier === "right" ? DETAIL_NATURAL_WIDTH : DETAIL_NATURAL_HEIGHT
  const minimum = listMinimum / available
  const maximum = 1 - detailMinimum / available
  return Math.min(maximum, Math.max(minimum, ratio))
}

export function queueSplitRatioAfterDrag(
  tier: Exclude<QueueDetailTier, "full">,
  startRatio: number,
  startCoordinate: number,
  coordinate: number,
  columns: number,
  rows: number,
): number {
  const available = Math.max(1, (tier === "right" ? columns : rows - 1) - DIVIDER_SIZE)
  return clampSplitRatio(tier, startRatio + (coordinate - startCoordinate) / available, columns, rows)
}

export type QueueWatchSnapshot = Readonly<{
  results: readonly QueueStatusResult[]
  now: number
  projection?: QueueTimelineProjection
  outputs?: readonly QueueArtifactOutput[]
}>

export type WatchControl = Readonly<{ paused: boolean }>
type QueueDetailMode = "detail" | "filters" | "evidence"

export type QueueWatchPaneProps = Readonly<{
  initial: QueueWatchSnapshot
  load(): Promise<QueueWatchSnapshot>
  intervalMs: number
  pr?: string
}>

export function reduceWatchControl(control: WatchControl, input: string): WatchControl | "exit" {
  if (input === "q") return "exit"
  if (input === "p") return { paused: !control.paused }
  return control
}

function QueueArtifactOutputView({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  if (outputs.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      {outputs.map((output) => {
        const lines = output.text.split("\n")
        if (lines.at(-1) === "") lines.pop()
        const hidden = Math.max(0, lines.length - 12)
        const visible = lines.slice(-12).join("\n")
        return (
          <Box key={`${output.run}:${output.step}:${output.attempt}:${output.path}`} flexDirection="column">
            <Text bold wrap="truncate">
              OUTPUT {output.step}#{output.attempt}
            </Text>
            {output.truncatedBytes === undefined ? null : (
              <Text color="$fg-muted">... {output.truncatedBytes} earlier bytes</Text>
            )}
            {hidden === 0 ? null : <Text color="$fg-muted">... {hidden} earlier lines</Text>}
            <Text>{visible === "" ? "Waiting for output..." : visible}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

function QueueFilterView({ projection }: { projection: QueueTimelineProjection }) {
  const filters = projection.filters
  return (
    <Box flexDirection="column">
      <Text bold>FILTERS</Text>
      <Text>BASE {projection.base}</Text>
      <Text>SINCE {filters.since}</Text>
      <Text>STATUS {filters.statuses.join(",")}</Text>
      <Text>TERMS {filters.terms.length === 0 ? "none" : filters.terms.join(" OR ")}</Text>
      <Text>RUNS {filters.latest ? "latest per PR" : "all"}</Text>
      <Text color="$fg-muted">Press Esc to return to selected-row detail.</Text>
    </Box>
  )
}

export function QueueWatchFrame({
  snapshot,
  paused,
  pr,
}: {
  snapshot: QueueWatchSnapshot
  paused: boolean
  pr?: string
}) {
  const { columns, rows: viewportRows } = useWindowSize()
  const tier = queueDetailTier(columns, viewportRows)
  const rows = useMemo(
    () =>
      snapshot.projection === undefined
        ? queueTimelineRows(snapshot.results, snapshot.now, false).map((row) => ({
            key: row.key,
            pr: row.pr,
            ...(row.run === undefined ? {} : { run: row.run }),
          }))
        : snapshot.projection.rows.map((row) => ({
            key: row.id,
            pr: row.prs[0],
            ...(row.run === undefined ? {} : { run: row.run }),
          })),
    [snapshot],
  )
  const [cursorRowKey, setCursorRowKey] = useState<string | undefined>(() => rows[0]?.key)
  const [selectedPr, setSelectedPr] = useState<string | undefined>(() => pr ?? rows[0]?.pr)
  const [detailOpen, setDetailOpen] = useState(() => snapshot.projection === undefined || tier !== "full")
  const [detailMode, setDetailMode] = useState<QueueDetailMode>("detail")
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  const [newRows, setNewRows] = useState(0)
  const previousTier = useRef(tier)
  const previousRowKeys = useRef<readonly string[]>(rows.map((row) => row.key))
  const dragStart = useRef<Readonly<{ coordinate: number; ratio: number }> | undefined>(undefined)
  const cursor = Math.max(
    0,
    rows.findIndex((row) => row.key === cursorRowKey),
  )

  useEffect(() => {
    if (rows.length === 0) {
      setCursorRowKey(undefined)
      setSelectedPr(pr)
      return
    }
    const selected = rows.find((row) => row.key === cursorRowKey) ?? rows[0]
    if (selected === undefined) return
    if (selected.key !== cursorRowKey) setCursorRowKey(selected.key)
    if (selected.pr !== selectedPr) setSelectedPr(selected.pr)
  }, [cursorRowKey, pr, rows, selectedPr])

  useEffect(() => {
    const previous = new Set(previousRowKeys.current)
    const selectedIndex = rows.findIndex((row) => row.key === cursorRowKey)
    if (selectedIndex > 0) {
      const addedBeforeCursor = rows.slice(0, selectedIndex).filter((row) => !previous.has(row.key)).length
      if (addedBeforeCursor > 0) setNewRows((count) => count + addedBeforeCursor)
    }
    previousRowKeys.current = rows.map((row) => row.key)
  }, [cursorRowKey, rows])

  useEffect(() => {
    if (previousTier.current === tier) return
    previousTier.current = tier
    setDetailOpen(tier !== "full")
  }, [tier])

  useInput((input, key) => {
    if (snapshot.projection === undefined) return
    if (input === "f") {
      setDetailMode("filters")
      setDetailOpen(true)
      return
    }
    if (input === "o") {
      setDetailMode("evidence")
      setDetailOpen(true)
      return
    }
    if (key.escape) {
      if (detailMode === "detail") setDetailOpen(false)
      else setDetailMode("detail")
    }
    if (key.return) {
      setDetailMode("detail")
      setDetailOpen(true)
    }
  })

  const selectRow = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setCursorRowKey(row.key)
    setSelectedPr(row.pr)
    setNewRows(0)
  }

  const selectedRow = rows[cursor]
  const detailPr = pr ?? selectedPr
  const detailData =
    selectedRow?.run === undefined
      ? undefined
      : snapshot.projection?.details.find((candidate) => candidate.run === selectedRow.run)
  const detailOutputs =
    selectedRow?.run === undefined ? [] : (snapshot.outputs?.filter((output) => output.run === selectedRow.run) ?? [])
  const timeline =
    snapshot.projection === undefined ? (
      <QueueTimelineView
        results={snapshot.results}
        now={snapshot.now}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={selectRow}
      />
    ) : (
      <QueueTimelineView
        projection={snapshot.projection}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={selectRow}
      />
    )
  const selectedDetail =
    detailData === undefined ? (
      detailPr === undefined ? (
        <Text color="$fg-muted">No queue row selected.</Text>
      ) : (
        <QueueWatchView results={snapshot.results} now={snapshot.now} pr={detailPr} />
      )
    ) : (
      <Box flexDirection="column">
        <QueueShowView data={detailData} compact={tier === "full"} />
        <QueueArtifactOutputView outputs={detailOutputs} />
      </Box>
    )
  if (snapshot.projection === undefined) {
    return (
      <Box flexDirection="column">
        {timeline}
        {detailPr === undefined ? null : <Box marginTop={1}>{selectedDetail}</Box>}
        <Box marginTop={1}>
          <Text bold>{paused ? "PAUSED" : "LIVE"}</Text>
          <Text color="$fg-muted"> {paused ? "p resume" : "p pause"} q quit</Text>
        </Box>
      </Box>
    )
  }

  const detail =
    detailMode === "filters" ? (
      <QueueFilterView projection={snapshot.projection} />
    ) : detailMode === "evidence" ? (
      detailData === undefined ? (
        <Text color="$fg-muted">No run evidence for the selected pending PR.</Text>
      ) : (
        <QueueEvidenceView data={detailData} />
      )
    ) : (
      selectedDetail
    )

  const splitTier = tier === "full" ? undefined : tier
  const available = Math.max(1, (tier === "right" ? columns : viewportRows - 1) - DIVIDER_SIZE)
  const ratio = splitTier === undefined ? splitRatio : clampSplitRatio(splitTier, splitRatio, columns, viewportRows)
  const listSize = Math.max(1, Math.round(available * ratio))
  const resizeMove = (coordinate: number): void => {
    if (splitTier === undefined || dragStart.current === undefined) return
    setSplitRatio(
      queueSplitRatioAfterDrag(
        splitTier,
        dragStart.current.ratio,
        dragStart.current.coordinate,
        coordinate,
        columns,
        viewportRows,
      ),
    )
  }
  const footerHint =
    tier === "full"
      ? detailOpen
        ? "Esc list"
        : "Enter detail"
      : detailOpen
        ? "Esc close detail"
        : "Enter reopen detail"

  return (
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0}>
      <Box flexGrow={1} minWidth={0} minHeight={0} flexDirection={tier === "right" ? "row" : "column"}>
        {!detailOpen || tier === "full" ? (
          <Box flexGrow={1} minWidth={0} minHeight={0}>
            {detailOpen ? detail : timeline}
          </Box>
        ) : (
          <>
            <Box
              flexShrink={0}
              minWidth={0}
              minHeight={0}
              {...(tier === "right" ? { width: listSize } : { height: listSize })}
            >
              {timeline}
            </Box>
            <PaneDivider
              orientation={tier === "right" ? "vertical" : "horizontal"}
              onResizeStart={(event) => {
                dragStart.current = { coordinate: event.coordinate, ratio }
              }}
              onResizeMove={resizeMove}
              onResizeEnd={() => {
                dragStart.current = undefined
              }}
            />
            <Box flexGrow={1} minWidth={0} minHeight={0}>
              {detail}
            </Box>
          </>
        )}
      </Box>
      <Box height={1} flexShrink={0}>
        <Text bold>{paused ? "PAUSED" : "LIVE"}</Text>
        <Text color="$fg-muted">
          {" "}
          {paused ? "p resume" : "p pause"} q quit · {footerHint}
          {" · f filters · o evidence"}
          {newRows === 0 ? "" : ` · ${newRows} new`}
        </Text>
      </Box>
    </Box>
  )
}

export function QueueWatchPane({ initial, load, intervalMs, pr }: QueueWatchPaneProps) {
  const [snapshot, setSnapshot] = useState(initial)
  const [control, setControl] = useState<WatchControl>({ paused: false })
  const [failure, setFailure] = useState<Error | undefined>()

  useInput((input) => {
    const next = reduceWatchControl(control, input)
    if (next === "exit") return "exit"
    if (next !== control) setControl(next)
  })

  useScopeEffect(
    (scope) => {
      if (control.paused) return
      void (async () => {
        while (!scope.signal.aborted) {
          await scope.sleep(intervalMs)
          if (scope.signal.aborted) return
          const next = await load()
          if (scope.signal.aborted) return
          setSnapshot(next)
        }
      })().catch((error: unknown) => {
        if (scope.signal.aborted) return
        setFailure(error instanceof Error ? error : new Error(String(error)))
      })
    },
    [control.paused, intervalMs, load],
  )

  if (failure !== undefined) throw failure
  return <QueueWatchFrame snapshot={snapshot} paused={control.paused} {...(pr === undefined ? {} : { pr })} />
}
