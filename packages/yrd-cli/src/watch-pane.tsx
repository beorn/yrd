import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
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
  type BoxProps,
  type ListViewHandle,
} from "silvery"
import type { PR } from "@yrd/bay"
import {
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QueueDetailPrFacts,
  QueueDetailSinglePrHeader,
  QueueDetailTitle,
  QueueShowView,
  QueueTimelineView,
  queueTimelineDisplayRows,
  queueTimelineFilterBuckets,
  queueTimelineRows,
  queueTimelineVisibleDefaultCursorId,
  queueTimelineVisibleRows,
  type QueueShowData,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineProjectedRow,
  type QueueTimelineStatusBucket,
} from "./queue-status-view.tsx"
import { taskStatusColor } from "./status-view.tsx"
import { taskFoldGlyph } from "./task-status.ts"
import { timelineStatusGlyph } from "./runner-timeline.ts"
import { reduceRunCancelKey } from "./watch-cancel.ts"

const LIST_NATURAL_WIDTH = 80
const DETAIL_NATURAL_WIDTH = 72
// This compact primary height reserves the queue title, runner, filter, table
// header, and useful data rows. The taller grouped FLOW/TIME summary has its
// own responsive height gate and is omitted when a split only fits this floor.
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

function queueTimelineHeight(rows: number, tier: QueueDetailTier, detailOpen: boolean, splitRatio: number): number {
  if (tier !== "below" || !detailOpen) return rows
  const visibleRatio = clampSplitPaneRatio(splitRatio, {
    containerSize: rows,
    dividerSize: DIVIDER_SIZE,
    minPrimarySize: LIST_NATURAL_HEIGHT,
    minSecondarySize: DETAIL_NATURAL_HEIGHT,
  })
  return Math.round(visibleRatio * Math.max(0, rows - DIVIDER_SIZE))
}

export type QueueWatchSnapshot = Readonly<{
  results: readonly QueueStatusResult[]
  now: number
  projection?: QueueTimelineProjection
  outputs?: readonly QueueArtifactOutput[]
  /** Resolved project commands for the live step headers. */
  commands?: Readonly<Record<string, string>>
}>

export type QueueWatchPaneProps = Readonly<{
  initial: QueueWatchSnapshot
  load(): Promise<QueueWatchSnapshot>
  intervalMs: number
  pr?: string
  onCancelRun?: (run: string) => void | Promise<void>
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
        renderItem={(row) =>
          row.kind === "heading" ? (
            <Text bold wrap="truncate">
              {row.text}
            </Text>
          ) : row.kind === "muted" ? (
            <Text color="$fg-muted">{row.text}</Text>
          ) : (
            // Body rows mirror a step's raw `output.log` tail — foreign terminal
            // output whose embedded ANSI (colors AND backgrounds, e.g. vitest's
            // cyan ` RUN ` banner) is intentional. `bgConflict="ignore"` keeps
            // those colors and stops silvery's background-conflict guard (default
            // `throw`) from killing the watch loop, while the global throw stays a
            // safety net for silvery's own pipeline bugs everywhere else.
            <Text bgConflict="ignore">{row.text}</Text>
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

// Effective selection derives from the live step unless the operator explicitly
// picked a tab. A `null` pick means "follow the live step"; a pick that is no
// longer a real step (a step vanished between snapshots) falls back to live.
export function resolveStepTabSelection(
  names: readonly string[],
  liveStep: string | undefined,
  userSelectedStep: string | null,
): string | undefined {
  return userSelectedStep !== null && names.includes(userSelectedStep) ? userSelectedStep : liveStep
}

// Effective fold derives from live status (running/attention open, completed
// folded) unless the operator explicitly toggled this step's log.
export function resolveStepLogExpanded(autoExpanded: boolean, userToggled: boolean | undefined): boolean {
  return userToggled ?? autoExpanded
}

/** Queue-specific fold chrome using the same width-one markers as km trees. */
function QueueDisclosure({
  title,
  expanded,
  onToggle,
  children,
  ...rest
}: Readonly<{
  title: ReactNode
  expanded: boolean
  onToggle: (expanded: boolean) => void
  children: ReactNode
}> &
  Omit<BoxProps, "children">) {
  return (
    <Box flexDirection="column" {...rest}>
      <Box flexDirection="row" gap={1} mouseCursor="pointer" onMouseDown={() => onToggle(!expanded)}>
        <Text>{taskFoldGlyph(expanded)}</Text>
        <Text>{title}</Text>
      </Box>
      {expanded ? <Box flexDirection="column">{children}</Box> : null}
    </Box>
  )
}

export function QueueWorkflowStepTabs({
  data,
  row,
  outputs,
  commands,
  compact,
  active,
  highlightPr,
  prs,
}: {
  data?: QueueShowData
  row?: QueueTimelineProjectedRow
  outputs: readonly QueueArtifactOutput[]
  commands?: Readonly<Record<string, string>>
  compact: boolean
  active: boolean
  highlightPr?: string
  prs: readonly PR[]
}) {
  const names = useMemo(() => (data === undefined ? [] : queueStepNames(data)), [data])
  // The live current step re-derives from the freshest props on every render,
  // so a same-run status advance (a running step passes, the next starts) moves
  // it. Operator intent is tracked SEPARATELY and only overrides the live view
  // when the operator actually acted: `userSelectedStep === null` and an absent
  // `userToggledLogs` key both mean "follow the live derivation". The parent
  // remounts this component when the run changes (`key={detailData.run}`), which
  // resets these overrides to their empty defaults for the next run.
  const liveStep = data === undefined ? undefined : defaultQueueStep(data, names)
  const [userSelectedStep, setUserSelectedStep] = useState<string | null>(null)
  const [userToggledLogs, setUserToggledLogs] = useState<Readonly<Record<string, boolean>>>({})
  const [prsExpanded, setPrsExpanded] = useState(false)
  const activeStep = resolveStepTabSelection(names, liveStep, userSelectedStep)

  // The selected PR always surfaces its subject + linked ISSUE directly under
  // the identity row. In a batch, the selected member still owns this context;
  // the PRs disclosure carries the rest of the members and their activity.
  const headerPr = prs.find((pr) => pr.id === highlightPr) ?? (prs.length === 1 ? prs[0] : undefined)
  const selectedPrHeader = headerPr === undefined ? null : <QueueDetailSinglePrHeader pr={headerPr} />

  // The batched members' review/comment/check-request/revision history (item J)
  // is a collapsed disclosure so it never pushes the step body past a short
  // viewport; its subject/activity live behind the "PRS" header.
  const prSummary = (
    <>
      {"PRs".padEnd(9, " ")}
      {prs.map((pr, index) => (
        <Text key={pr.id} bold={pr.id === highlightPr}>
          {index === 0 ? "" : ","}
          {pr.id}@r{pr.revision}:{pr.headSha.slice(0, 12)}
        </Text>
      ))}
    </>
  )
  const prFacts =
    prs.length === 0 ? null : (
      <QueueDisclosure
        title={prSummary}
        expanded={prsExpanded}
        onToggle={setPrsExpanded}
        marginTop={1}
        flexShrink={0}
        minWidth={0}
      >
        <QueueDetailPrFacts prs={prs} />
      </QueueDisclosure>
    )

  const selectedPr = prs.find((pr) => pr.id === row?.pr) ?? prs[0]
  const submitted = row?.timestamp === null ? undefined : row?.timestamp

  // Each step tab is a three-row segment from the recovered mock: numbered
  // step, state, then a right-aligned clock. Every label has the same measured
  // width; the surrounding flex boxes divide the whole row equally. Round 4
  // makes selection a solid surface instead of surrounding every tab in chrome.
  const stepTabWidth =
    data === undefined
      ? 0
      : Math.max(
          compact ? 18 : 28,
          ...names.map((name) => {
            const rep = data.steps.filter((row) => row.step === name).at(-1)
            const duration = rep?.duration === undefined || rep.duration === "-" ? "" : rep.duration
            const glyph = rep === undefined ? "" : timelineStatusGlyph(rep.status)
            return Math.max(
              `${names.indexOf(name) + 1}: ${name}`.length,
              `${glyph} ${rep?.status ?? ""}`.length,
              duration.length + 2,
            )
          }),
        )
  const stepTabLabel = (name: string, selected: boolean) => {
    if (data === undefined) return name
    const stepRows = data.steps.filter((row) => row.step === name)
    const rep = stepRows.at(-1)
    if (rep === undefined) return name
    const duration = rep.duration === "-" ? "" : `◷ ${rep.duration}`
    const number = names.indexOf(name) + 1
    const glyph = timelineStatusGlyph(rep.status)
    return (
      <Text color={selected ? "$fg-on-selected" : undefined}>
        {`${number}: ${name}`.padEnd(stepTabWidth)}
        {"\n"}
        <Text color={selected ? "$fg-on-selected" : taskStatusColor(rep.taskStatus)} bold={rep.taskStatus === "wip"}>
          {`${glyph} ${rep.status}`.padEnd(stepTabWidth)}
        </Text>
        {"\n"}
        {(duration === "" ? " " : duration).padStart(stepTabWidth)}
      </Text>
    )
  }
  return (
    // Detail order (item H, 2026-07-16): run-level facts at the TOP, then the
    // step TABS row, then the selected step's content BELOW — the tab is the
    // visual title of the step section, so step title + step contents read as
    // one grouped unit.
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {selectedPrHeader}
      {prFacts}
      {data === undefined ? (
        <>
          {row?.position === undefined ? null : <Text>{`${"POSITION".padEnd(9, " ")}${row.position}`}</Text>}
          {submitted === undefined ? null : (
            <Text>{`${"TIMELINE".padEnd(9, " ")}${submitted.slice(11, 19)} → pending`}</Text>
          )}
          {selectedPr === undefined ? null : (
            <Text wrap="truncate" color="$fg-muted">{`${"HEAD".padEnd(9, " ")}${selectedPr.headSha}`}</Text>
          )}
        </>
      ) : activeStep === undefined ? (
        <>
          <QueueShowView data={data} compact={compact} highlightPr={highlightPr} titleAbove showMembers={false} />
          <QueueArtifactOutputView outputs={outputs} />
        </>
      ) : (
        <>
          <QueueShowView
            data={data}
            compact={compact}
            highlightPr={highlightPr}
            section="run"
            titleAbove
            showMembers={false}
          />
          <Tabs value={activeStep} onChange={setUserSelectedStep} isActive={active}>
            <TabList>
              {names.map((name) => (
                <Box
                  key={name}
                  backgroundColor={activeStep === name ? "$bg-selected" : undefined}
                  paddingLeft={1}
                  flexGrow={1}
                  flexBasis={0}
                  minWidth={0}
                >
                  <Tab value={name}>{stepTabLabel(name, activeStep === name)}</Tab>
                </Box>
              ))}
            </TabList>
            {names.map((name) => {
              const stepRows = data.steps.filter((row) => row.step === name)
              const stepOutputs = outputs.filter((output) => output.step === name)
              const stepData: QueueShowData = { ...data, steps: stepRows }
              // The job input is durable proof of what this run actually executed;
              // current config is only a preview for a step that has no job yet.
              const command = stepRows.at(-1)?.command ?? commands?.[name]
              const logExpanded = resolveStepLogExpanded(stepLogStartsExpanded(data, name), userToggledLogs[name])
              return (
                <TabPanel key={name} value={name}>
                  {/* Only the step-level facts here (item H); the run-level facts
                  render once above the tabs. */}
                  {command === undefined ? null : (
                    <Box backgroundColor="$bg-surface-subtle" paddingX={1} marginTop={1} flexShrink={0} minWidth={0}>
                      <Text bold color="$fg" wrap="truncate">
                        <Text color="$fg-muted">COMMAND </Text>$ {command}
                      </Text>
                    </Box>
                  )}
                  <QueueShowView
                    data={stepData}
                    compact={compact}
                    highlightPr={highlightPr}
                    section="steps"
                    showLogArtifacts={false}
                  />
                  <QueueDisclosure
                    title="RUN LOGS"
                    expanded={logExpanded}
                    onToggle={(expanded) => setUserToggledLogs((current) => ({ ...current, [name]: expanded }))}
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
                  </QueueDisclosure>
                </TabPanel>
              )
            })}
          </Tabs>
        </>
      )}
    </Box>
  )
}

export function QueueWatchFrame({
  snapshot,
  pr,
  onCancelRun,
}: {
  snapshot: QueueWatchSnapshot
  pr?: string
  onCancelRun?: (run: string) => void | Promise<void>
}) {
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
  const [expandedStorms, setExpandedStorms] = useState<ReadonlySet<string>>(() => new Set())
  const toggleBucket = (bucket: QueueTimelineStatusBucket): void => {
    setVisibleBuckets((current) => {
      const next = new Set(current)
      if (next.has(bucket)) next.delete(bucket)
      else next.add(bucket)
      return next
    })
  }
  // The interactive pane renders fill-height (below), so the cursor set is the
  // uncapped fill set — the ListView shows every retained row and virtualizes.
  // Cursor indices index THIS array, so it must match the ListView's items.
  const visibleProjectedRows = useMemo(
    () =>
      snapshot.projection === undefined
        ? undefined
        : queueTimelineVisibleRows(snapshot.projection, visibleBuckets, true),
    [snapshot.projection, visibleBuckets],
  )
  const projectedRows = useMemo(
    () =>
      visibleProjectedRows === undefined ? undefined : queueTimelineDisplayRows(visibleProjectedRows, expandedStorms),
    [expandedStorms, visibleProjectedRows],
  )
  const visibleStormKeys = useMemo(
    () =>
      new Set(
        visibleProjectedRows === undefined
          ? []
          : queueTimelineDisplayRows(visibleProjectedRows).flatMap((row) =>
              row.repeat === undefined ? [] : [row.repeat.key],
            ),
      ),
    [visibleProjectedRows],
  )
  useEffect(() => {
    setExpandedStorms((current) => {
      const retained = new Set([...current].filter((key) => visibleStormKeys.has(key)))
      return retained.size === current.size ? current : retained
    })
  }, [visibleStormKeys])
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
      : queueTimelineVisibleDefaultCursorId(snapshot.projection, visibleBuckets, true)
  const [manualCursor, setManualCursor] = useState(false)
  const [cursorRowKey, setCursorRowKey] = useState<string | undefined>(() => defaultCursorKey)
  const [selectedPr, setSelectedPr] = useState<string | undefined>(
    () => pr ?? rows.find((row) => row.key === defaultCursorKey)?.pr ?? rows[0]?.pr,
  )
  const [detailOpen, setDetailOpen] = useState(() => snapshot.projection === undefined || tier !== "full")
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  const [newRows, setNewRows] = useState(0)
  const [cancelArmed, setCancelArmed] = useState(false)
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
    // Cancel affordance for the SELECTED run: `x` arms a confirmation, then
    // `y`/Enter confirms and any other key (incl. a second `x`, Escape) dismisses.
    // Wired to the SAME path as the `run cancel <R>` CLI (onCancelRun). Intercepted
    // before the detail/filter keys so the armed prompt captures its confirming
    // keypress rather than opening the detail pane.
    if (onCancelRun !== undefined && (cancelArmed || input === "x")) {
      const decision = reduceRunCancelKey(
        { char: input, escape: key.escape === true, return: key.return === true },
        cancelArmed,
        rows[cursor]?.run,
      )
      setCancelArmed(decision.armed)
      if (decision.cancel !== undefined) void onCancelRun(decision.cancel)
      return
    }
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
  })

  const selectRow = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setManualCursor(true)
    setCursorRowKey(row.key)
    setSelectedPr(row.pr)
    setNewRows(0)
  }

  const activateRow = (index: number): void => {
    selectRow(index)
    const repeat = projectedRows?.[index]?.repeat
    if (repeat === undefined) return
    setExpandedStorms((current) => {
      const next = new Set(current)
      if (repeat.collapsed) next.add(repeat.key)
      else next.delete(repeat.key)
      return next
    })
  }

  // Jump-to-newest (item 4-new): the `↓ N new` cue resumes default-follow at
  // the newest row (first running, else newest finished) and clears the count.
  // It reuses the exact `defaultCursorKey` the un-pinned pane already follows,
  // so clicking the cue lands where the cursor would sit without a manual pin.
  const jumpToNewest = (): void => {
    const targetKey = defaultCursorKey ?? rows[0]?.key
    if (targetKey === undefined) return
    const target = rows.find((row) => row.key === targetKey)
    setManualCursor(false)
    setCursorRowKey(targetKey)
    setSelectedPr(target?.pr ?? pr)
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
  // The batched members' full PRs (reviews/comments/check-requests/revision
  // history) are not on the run's `PRSnapshot` — resolve them from the status
  // results by id so the detail's PR facts (item J) can render.
  const allFullPrs = snapshot.results.flatMap((result) => result.prs)
  const detailFullPrs =
    detailData === undefined
      ? allFullPrs.filter((candidate) => candidate.id === detailPr)
      : allFullPrs.filter((candidate) => detailData.prs.some((member) => member.id === candidate.id))
  // `rows` is a trimmed {key,pr,run} projection; the DETAIL identity and the
  // status-parameterized template need the full projected row at this index.
  const selectedProjectedRow = projectedRows?.[cursor]
  const timelineColumns = queueTimelineColumns(columns, tier, detailOpen, splitRatio)
  const timelineRows = queueTimelineHeight(Math.max(0, viewportRows - 1), tier, detailOpen, splitRatio)
  const timeline =
    snapshot.projection === undefined ? (
      <QueueTimelineView
        results={snapshot.results}
        now={snapshot.now}
        columns={timelineColumns}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={activateRow}
      />
    ) : (
      <QueueTimelineView
        projection={snapshot.projection}
        columns={timelineColumns}
        nav
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={activateRow}
        paneChrome
        fillHeight
        availableRows={timelineRows}
        visibleBuckets={visibleBuckets}
        expandedStorms={expandedStorms}
        onToggleBucket={toggleBucket}
        freshRows={newRows}
        onJumpToNewest={jumpToNewest}
      />
    )
  const selectedDetail =
    detailPr === undefined ? (
      <Text color="$fg-muted">No queue row selected.</Text>
    ) : (
      // ONE status-parameterized detail template owns pending, running, and
      // terminal rows. Run data only enables tabs/logs; it never selects a
      // second status-specific IA.
      <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        <QueueWorkflowStepTabs
          key={detailData?.run ?? detailPr}
          {...(detailData === undefined ? {} : { data: detailData })}
          {...(selectedProjectedRow === undefined ? {} : { row: selectedProjectedRow })}
          outputs={detailOutputs}
          {...(snapshot.commands === undefined ? {} : { commands: snapshot.commands })}
          prs={detailFullPrs}
          compact
          active={detailOpen}
          highlightPr={selectedRow?.pr}
        />
      </Box>
    )
  if (snapshot.projection === undefined) {
    return (
      <Box flexDirection="column">
        {timeline}
        {detailPr === undefined ? null : <Box marginTop={1}>{selectedDetail}</Box>}
      </Box>
    )
  }

  const detail = selectedDetail

  // QUEUE and DETAIL are PANES, not boxes (user directive 2026-07-16, items
  // L/M) — no surrounding rounded border; the SplitPane divider separates them.
  // QUEUE is headed by its tab-style label (rendered inside `timeline`); DETAIL
  // is headed by an emphasized identity title row (run + PR.rev + dimmed branch
  // glyph) with STATUS/OUTCOME right-aligned and total time directly beneath
  // it, then the body. One cell of horizontal padding keeps content off the
  // pane edge; the title sits flush at the top.
  const framedTimeline = (
    // The QUEUE pane is its own selection scope (item 4a): a drag started here
    // resolves to this Box as the nearest `contain` boundary, so it never grows
    // across the SplitPane divider into the DETAIL pane. `contain` keeps the
    // rows selectable while bounding the range; the STATUS/FLOW/TIME boxes nest
    // their own tighter scopes inside it.
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0} paddingX={1} userSelect="contain">
      {timeline}
    </Box>
  )
  const framedDetail = (
    // The DETAIL pane is its own selection scope (item 4a): a drag inside the
    // detail body resolves to this Box as the nearest `contain` boundary, so it
    // cannot grow back across the divider into the QUEUE pane.
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0} paddingX={1} userSelect="contain">
      <QueueDetailTitle
        {...(selectedProjectedRow === undefined ? {} : { row: selectedProjectedRow })}
        {...(detailData === undefined ? {} : { data: detailData })}
      />
      <Box flexGrow={1} minWidth={0} minHeight={0}>
        {detail}
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0} userSelect="none">
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
      {/* The keybinding footer was removed (user directive 2026-07-15). Only
          the run-cancel confirmation banner (#59) still occupies a bottom row,
          and only while a cancel is armed — otherwise nothing renders here. `x`
          arms the affordance (handled in the input reducer above). */}
      {cancelArmed && selectedRow?.run !== undefined ? (
        <Box height={1} flexShrink={0}>
          <Text color="$fg-warning" bold>
            Cancel run {selectedRow.run}? Its PRs re-queue, not rejected. y/Enter to confirm, any other key to abort.
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function QueueWatchPane({ initial, load, intervalMs, pr, onCancelRun }: QueueWatchPaneProps) {
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
  return (
    <QueueWatchFrame
      snapshot={snapshot}
      {...(pr === undefined ? {} : { pr })}
      {...(onCancelRun === undefined ? {} : { onCancelRun })}
    />
  )
}
