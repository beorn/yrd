import { useEffect, useMemo, useRef, useState } from "react"
import {
  Box,
  ListView,
  SplitPane,
  Text,
  resolveSplitPaneLayout,
  useInput,
  useScopeEffect,
  useWindowSize,
} from "silvery"
import {
  QueueEvidenceView,
  QueueShowView,
  QueueTimelineView,
  QueueWatchView,
  queueTimelineDefaultCursorId,
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

type QueueArtifactOutputLine = Readonly<{
  key: string
  text: string
  kind: "heading" | "muted" | "body"
}>

function QueueArtifactOutputView({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  const lines = useMemo<readonly QueueArtifactOutputLine[]>(
    () =>
      outputs.flatMap((output) => {
        const outputKey = `${output.run}:${output.step}:${output.attempt}:${output.path}`
        const textLines = output.text.split("\n")
        if (textLines.at(-1) === "") textLines.pop()
        return [
          { key: `${outputKey}:heading`, text: `OUTPUT ${output.step}#${output.attempt}`, kind: "heading" },
          ...(output.truncatedBytes === undefined
            ? []
            : [
                {
                  key: `${outputKey}:truncated`,
                  text: `... ${output.truncatedBytes} earlier bytes`,
                  kind: "muted" as const,
                },
              ]),
          ...(textLines.length === 0
            ? [{ key: `${outputKey}:waiting`, text: "Waiting for output...", kind: "body" as const }]
            : textLines.map((text, index) => ({
                key: `${outputKey}:line:${index}`,
                text,
                kind: "body" as const,
              }))),
        ] satisfies readonly QueueArtifactOutputLine[]
      }),
    [outputs],
  )
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}>
      <ListView
        items={lines}
        getKey={(line) => line.key}
        follow="end"
        scrollbarVisibility="always"
        renderItem={(line) =>
          line.kind === "heading" ? (
            <Text bold wrap="truncate">
              {line.text}
            </Text>
          ) : line.kind === "muted" ? (
            <Text color="$fg-muted">{line.text}</Text>
          ) : (
            <Text>{line.text}</Text>
          )
        }
      />
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
  const tier = queueDetailTier(columns, Math.max(0, viewportRows - 1))
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
            pr: row.pr,
            ...(row.run === undefined ? {} : { run: row.run }),
          })),
    [snapshot],
  )
  // Default cursor: first RUNNING row, else the newest FINISHED row. A manual
  // cursor move is sticky — default-follow stops until the pinned row leaves
  // the window or the view is reopened.
  const defaultCursorKey =
    snapshot.projection === undefined ? rows[0]?.key : queueTimelineDefaultCursorId(snapshot.projection.rows)
  const [manualCursor, setManualCursor] = useState(false)
  const [cursorRowKey, setCursorRowKey] = useState<string | undefined>(() => defaultCursorKey)
  const [selectedPr, setSelectedPr] = useState<string | undefined>(
    () => pr ?? rows.find((row) => row.key === defaultCursorKey)?.pr ?? rows[0]?.pr,
  )
  const [detailOpen, setDetailOpen] = useState(() => snapshot.projection === undefined || tier !== "full")
  const [detailMode, setDetailMode] = useState<QueueDetailMode>("detail")
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  const [newRows, setNewRows] = useState(0)
  const previousTier = useRef(tier)
  const previousRowKeys = useRef<readonly string[]>(rows.map((row) => row.key))
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
    const pinned = manualCursor ? rows.find((row) => row.key === cursorRowKey) : undefined
    if (pinned === undefined && manualCursor) setManualCursor(false)
    const selected =
      pinned ?? rows.find((row) => row.key === (manualCursor ? cursorRowKey : defaultCursorKey)) ?? rows[0]
    if (selected === undefined) return
    if (selected.key !== cursorRowKey) setCursorRowKey(selected.key)
    if (selected.pr !== selectedPr) setSelectedPr(selected.pr)
  }, [cursorRowKey, defaultCursorKey, manualCursor, pr, rows, selectedPr])

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
    setManualCursor(true)
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
        columns={columns}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={selectRow}
      />
    ) : (
      <QueueTimelineView
        projection={snapshot.projection}
        columns={columns}
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
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <QueueShowView
          data={detailData}
          compact={tier === "full"}
          {...(selectedRow?.pr === undefined ? {} : { highlightPr: selectedRow.pr })}
        />
        <QueueArtifactOutputView key={selectedRow?.run} outputs={detailOutputs} />
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
      <Box flexGrow={1} minWidth={0} minHeight={0}>
        {tier === "full" ? (
          <Box flexGrow={1} minWidth={0} minHeight={0}>
            {detailOpen ? detail : timeline}
          </Box>
        ) : (
          <SplitPane
            direction={tier === "right" ? "row" : "column"}
            ratio={splitRatio}
            onRatioChange={setSplitRatio}
            minPrimarySize={tier === "right" ? LIST_NATURAL_WIDTH : LIST_NATURAL_HEIGHT}
            minSecondarySize={tier === "right" ? DETAIL_NATURAL_WIDTH : DETAIL_NATURAL_HEIGHT}
            dividerSize={DIVIDER_SIZE}
            secondaryCollapsed={!detailOpen}
            primary={timeline}
            secondary={detail}
          />
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
