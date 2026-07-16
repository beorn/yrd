import { useEffect, useMemo, useRef, useState } from "react"
import {
  Accordion,
  Box,
  ListView,
  SplitPane,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  clampSplitPaneRatio,
  resolveSplitPaneLayout,
  useInput,
  useScopeEffect,
  useWindowSize,
  type ListViewHandle,
} from "silvery"
import {
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QueueEvidenceView,
  QueueShowView,
  QueueTimelineView,
  QueueWatchView,
  TitledBox,
  queueTimelineFilterBuckets,
  queueTimelineRows,
  queueTimelineVisibleDefaultCursorId,
  queueTimelineVisibleRows,
  type QueueShowData,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineStatusBucket,
} from "./queue-status-view.tsx"

const LIST_NATURAL_WIDTH = 80
const DETAIL_NATURAL_WIDTH = 72
// Queue chrome is 13 fixed rows at the production cap (tabs, clocks, filter,
// header, STATS, spacer). Reserve enough primary height to keep useful rows
// visible before selecting the persistent-below tier.
const LIST_NATURAL_HEIGHT = 19
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

export function queueTimelineColumns(
  columns: number,
  tier: QueueDetailTier,
  detailOpen: boolean,
  splitRatio: number,
): number {
  if (tier !== "right" || !detailOpen) return columns
  const visibleRatio = clampSplitPaneRatio(splitRatio, {
    containerSize: columns,
    dividerSize: DIVIDER_SIZE,
    minPrimarySize: LIST_NATURAL_WIDTH,
    minSecondarySize: DETAIL_NATURAL_WIDTH,
  })
  return Math.round(visibleRatio * Math.max(0, columns - DIVIDER_SIZE))
}

export type QueueWatchSnapshot = Readonly<{
  results: readonly QueueStatusResult[]
  now: number
  projection?: QueueTimelineProjection
  outputs?: readonly QueueArtifactOutput[]
}>

export type QueueWatchPaneProps = Readonly<{
  initial: QueueWatchSnapshot
  load(): Promise<QueueWatchSnapshot>
  intervalMs: number
  pr?: string
}>

type QueueArtifactOutputLine = Readonly<{
  key: string
  text: string
  kind: "heading" | "muted" | "body"
}>

export function QueueArtifactOutputView({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  const listRef = useRef<ListViewHandle | null>(null)
  const [atEnd, setAtEnd] = useState(true)
  const [unseenLines, setUnseenLines] = useState(0)
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
  const previousLineCount = useRef(lines.length)

  useEffect(() => {
    const addedLines = Math.max(0, lines.length - previousLineCount.current)
    previousLineCount.current = lines.length
    if (atEnd) setUnseenLines(0)
    else if (addedLines > 0) setUnseenLines((count) => count + addedLines)
  }, [atEnd, lines.length])

  // Reassert the tail after new output is committed. ListView's follow
  // authority observes the prior viewport during the same render; without
  // this post-commit scroll, an End-resumed pane can miss the next append.
  useEffect(() => {
    if (atEnd) listRef.current?.scrollToBottom()
  }, [atEnd, lines.length])

  useInput((_input, key) => {
    if (!key.end) return
    listRef.current?.scrollToBottom()
    setAtEnd(true)
    setUnseenLines(0)
  })

  if (lines.length === 0) return null
  const followStatus = atEnd
    ? "FOLLOWING END"
    : `FOLLOW PAUSED${
        unseenLines === 0 ? "" : ` | ${unseenLines} new ${unseenLines === 1 ? "line" : "lines"}`
      } | End resumes`
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}>
      <Text color="$fg-muted" bold={!atEnd}>
        {followStatus}
      </Text>
      <ListView
        ref={listRef}
        items={lines}
        getKey={(line) => line.key}
        follow="end"
        onAtBottomChange={(nextAtEnd) => {
          setAtEnd(nextAtEnd)
          if (nextAtEnd) setUnseenLines(0)
        }}
        scrollbarVisibility="always"
        renderItem={(line) =>
          line.kind === "heading" ? (
            <Text bold wrap="truncate">
              {line.text}
            </Text>
          ) : line.kind === "muted" ? (
            <Text color="$fg-muted">{line.text}</Text>
          ) : (
            // Body lines mirror a step's raw `output.log` tail — foreign terminal
            // output whose embedded ANSI (colors AND backgrounds, e.g. vitest's
            // cyan ` RUN ` banner) is intentional. `bgConflict="ignore"` keeps
            // those colors and stops silvery's background-conflict guard (default
            // `throw`) from killing the watch loop, while the global throw stays a
            // safety net for silvery's own pipeline bugs everywhere else.
            <Text bgConflict="ignore">{line.text}</Text>
          )
        }
      />
    </Box>
  )
}

function isSuccessfulStepStatus(status: string): boolean {
  return status === "passed" || status === "skipped"
}

function queueStepNames(data: QueueShowData): readonly string[] {
  return [...new Set(data.steps.map((row) => row.step))]
}

function defaultQueueStep(data: QueueShowData, names: readonly string[]): string | undefined {
  const needsAttention = names.find((name) =>
    data.steps.some((row) => row.step === name && !isSuccessfulStepStatus(row.status)),
  )
  return needsAttention ?? names.at(-1)
}

function stepLogStartsExpanded(data: QueueShowData, step: string): boolean {
  return data.steps.some((row) => row.step === step && !isSuccessfulStepStatus(row.status))
}

function QueueWorkflowStepTabs({
  data,
  outputs,
  compact,
  active,
  highlightPr,
}: {
  data: QueueShowData
  outputs: readonly QueueArtifactOutput[]
  compact: boolean
  active: boolean
  highlightPr?: string
}) {
  const names = useMemo(() => queueStepNames(data), [data])
  const fallbackStep = defaultQueueStep(data, names)
  const [selectedStep, setSelectedStep] = useState(fallbackStep)
  const [expandedLogs, setExpandedLogs] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(names.map((name) => [name, stepLogStartsExpanded(data, name)])),
  )
  const activeStep = selectedStep !== undefined && names.includes(selectedStep) ? selectedStep : fallbackStep

  if (activeStep === undefined) {
    return (
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <QueueShowView data={data} compact={compact} highlightPr={highlightPr} />
        <QueueArtifactOutputView outputs={outputs} />
      </Box>
    )
  }

  return (
    <Tabs value={activeStep} onChange={setSelectedStep} isActive={active}>
      <TabList>
        {names.map((name) => (
          <Tab key={name} value={name}>
            {name}
          </Tab>
        ))}
      </TabList>
      {names.map((name) => {
        const stepRows = data.steps.filter((row) => row.step === name)
        const stepOutputs = outputs.filter((output) => output.step === name)
        const stepData: QueueShowData = { ...data, steps: stepRows }
        const logExpanded = expandedLogs[name] ?? stepLogStartsExpanded(data, name)
        return (
          <TabPanel key={name} value={name}>
            <Text color="$fg-muted">
              ACTIVE STEP <Text bold>{name}</Text>
            </Text>
            <QueueShowView data={stepData} compact={compact} highlightPr={highlightPr} />
            <Accordion
              title="LOG"
              expanded={logExpanded}
              onToggle={(expanded) => setExpandedLogs((current) => ({ ...current, [name]: expanded }))}
              marginTop={1}
              flexGrow={1}
              minHeight={0}
            >
              {stepOutputs.length === 0 ? (
                <Text color="$fg-muted">Waiting for first output…</Text>
              ) : (
                <Box minHeight={8} flexGrow={1}>
                  <QueueArtifactOutputView outputs={stepOutputs} />
                </Box>
              )}
            </Accordion>
          </TabPanel>
        )
      })}
    </Tabs>
  )
}

export function QueueWatchFrame({ snapshot, pr }: { snapshot: QueueWatchSnapshot; pr?: string }) {
  const { columns, rows: viewportRows } = useWindowSize()
  const tier = queueDetailTier(columns, Math.max(0, viewportRows - 1))
  // The four operator buckets (user respec 2026-07-15): p/r/f/d toggle them
  // and the FILTER row's checkbox indicators mirror + click-toggle the same
  // state. Initial visibility mirrors the CLI-level --status filters.
  const [visibleBuckets, setVisibleBuckets] = useState<ReadonlySet<QueueTimelineStatusBucket>>(() =>
    snapshot.projection === undefined
      ? new Set(QUEUE_TIMELINE_STATUS_BUCKETS)
      : queueTimelineFilterBuckets(snapshot.projection.filters.statuses),
  )
  const toggleBucket = (bucket: QueueTimelineStatusBucket): void => {
    setVisibleBuckets((current) => {
      const next = new Set(current)
      if (next.has(bucket)) next.delete(bucket)
      else next.add(bucket)
      return next
    })
  }
  const projectedRows = useMemo(
    () =>
      snapshot.projection === undefined ? undefined : queueTimelineVisibleRows(snapshot.projection, visibleBuckets),
    [snapshot.projection, visibleBuckets],
  )
  const rows = useMemo(
    () =>
      snapshot.projection === undefined
        ? queueTimelineRows(snapshot.results, snapshot.now, false).map((row) => ({
            key: row.key,
            pr: row.pr,
            ...(row.run === undefined ? {} : { run: row.run }),
          }))
        : (projectedRows ?? []).map((row) => ({
            key: row.id,
            pr: row.pr,
            ...(row.run === undefined ? {} : { run: row.run }),
          })),
    [projectedRows, snapshot],
  )
  // Default cursor: first RUNNING row, else the newest FINISHED row. A manual
  // cursor move is sticky — default-follow stops until the pinned row leaves
  // the window or the view is reopened.
  const defaultCursorKey =
    snapshot.projection === undefined
      ? rows[0]?.key
      : queueTimelineVisibleDefaultCursorId(snapshot.projection, visibleBuckets)
  const [manualCursor, setManualCursor] = useState(false)
  const [cursorRowKey, setCursorRowKey] = useState<string | undefined>(() => defaultCursorKey)
  const [selectedPr, setSelectedPr] = useState<string | undefined>(
    () => pr ?? rows.find((row) => row.key === defaultCursorKey)?.pr ?? rows[0]?.pr,
  )
  const [detailOpen, setDetailOpen] = useState(() => snapshot.projection === undefined || tier !== "full")
  const [evidenceOpen, setEvidenceOpen] = useState(false)
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
    if (key.escape) {
      setDetailOpen(false)
      return
    }
    if (key.return) {
      setDetailOpen(true)
      return
    }
    if (snapshot.projection === undefined) return
    // Direct status-filter toggles (user respec 2026-07-15). Pause/resume is
    // removed: `p` toggles the pending bucket.
    if (input === "p") toggleBucket("pending")
    if (input === "r") toggleBucket("running")
    if (input === "f") toggleBucket("failed")
    if (input === "d") toggleBucket("done")
    // `o` jumps to the EVIDENCE section of the detail body.
    if (input === "o") {
      setDetailOpen(true)
      setEvidenceOpen(true)
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
  const timelineColumns = queueTimelineColumns(columns, tier, detailOpen, splitRatio)
  const timeline =
    snapshot.projection === undefined ? (
      <QueueTimelineView
        results={snapshot.results}
        now={snapshot.now}
        columns={timelineColumns}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={selectRow}
      />
    ) : (
      <QueueTimelineView
        projection={snapshot.projection}
        columns={timelineColumns}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={selectRow}
        paneChrome
        fillHeight
        visibleBuckets={visibleBuckets}
        onToggleBucket={toggleBucket}
        freshRows={newRows}
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
      // Evidence lives INSIDE the scrollable detail body as a disclosure
      // section (user respec 2026-07-15); `o` expands it.
      <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        <QueueWorkflowStepTabs
          key={detailData.run}
          data={detailData}
          outputs={detailOutputs}
          // Detail facts always stack vertically (user respec 2026-07-15):
          // label/value rows that fit the pane width, never a sprawling table.
          compact
          active={detailOpen}
          highlightPr={selectedRow?.pr}
        />
        <Accordion
          title="EVIDENCE"
          expanded={evidenceOpen}
          onToggle={setEvidenceOpen}
          marginTop={1}
          flexShrink={0}
          minWidth={0}
        >
          <QueueEvidenceView data={detailData} />
        </Accordion>
      </Box>
    )
  if (snapshot.projection === undefined) {
    return (
      <Box flexDirection="column">
        {timeline}
        {detailPr === undefined ? null : <Box marginTop={1}>{selectedDetail}</Box>}
        <Box marginTop={1}>
          <Text color="$fg-muted">q quit - enter/esc show/hide detail - h/j/k/l navigate</Text>
        </Box>
      </Box>
    )
  }

  const detail = selectedDetail

  // Both panes carry the one title-in-border chrome idiom with one cell of
  // outer padding (user directive 2026-07-15); content, headers, and the
  // FILTER/STATS rows all sit inside that padding. The QUEUE pane is `flushTop`
  // (no top padding) so its `updated` clock reads flush against the title
  // border rather than below an offset gap (user directive 2026-07-16).
  const queuePaneTitle = `QUEUE ${snapshot.projection.base}`
  const framedTimeline = (
    <TitledBox title={queuePaneTitle} padding={1} fill flushTop>
      {timeline}
    </TitledBox>
  )
  const framedDetail = (
    <TitledBox title="DETAIL" padding={1} fill>
      {detail}
    </TitledBox>
  )
  return (
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0}>
      <Box flexGrow={1} minWidth={0} minHeight={0}>
        {tier === "full" ? (
          <Box flexGrow={1} minWidth={0} minHeight={0}>
            {detailOpen ? framedDetail : framedTimeline}
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
            primary={framedTimeline}
            secondary={framedDetail}
          />
        )}
      </Box>
      <Box height={1} flexShrink={0}>
        {/* Exact keybinding footer (user respec 2026-07-15). Pause/resume is
            removed; `N new` moved to the pane header's temporal-trust row. */}
        <Text color="$fg-muted">q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate</Text>
      </Box>
    </Box>
  )
}

export function QueueWatchPane({ initial, load, intervalMs, pr }: QueueWatchPaneProps) {
  const [snapshot, setSnapshot] = useState(initial)
  const [failure, setFailure] = useState<Error | undefined>()

  useInput((input) => {
    if (input === "q") return "exit"
  })

  useScopeEffect(
    (scope) => {
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
    [intervalMs, load],
  )

  if (failure !== undefined) throw failure
  return <QueueWatchFrame snapshot={snapshot} {...(pr === undefined ? {} : { pr })} />
}
