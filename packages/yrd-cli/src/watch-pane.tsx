import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Box,
  Divider,
  ListView,
  ScrollArea,
  SplitPane,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  clampSplitPaneRatio,
  resolveSplitPaneLayout,
  useFocusManager,
  useInput,
  useScopeEffect,
  useScrollController,
  useWindowSize,
  type ListViewHandle,
} from "silvery"
import { prHead, prRevisionNumber, type PR } from "@yrd/bay"
import {
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QueueDetailRunPrBlocks,
  QueueDetailTitle,
  QueueShowView,
  QueueTimelineView,
  queueShowData,
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

export type QueuePrDiff =
  | Readonly<{
      pr: string
      revision: number
      additions: number
      deletions: number
      files: readonly string[]
      patch: string
    }>
  | Readonly<{
      pr: string
      revision: number
      unavailable: "refs-pruned" | "git-error"
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
  /** Revision-bound source deltas for the synthetic submit step. */
  diffs?: readonly QueuePrDiff[]
  /** Resolved project commands for the live step headers. */
  commands?: Readonly<Record<string, string>>
}>

/** The one immutable row identity whose expensive detail data watch may load. */
export type QueueWatchFocus = Readonly<{
  pr: string
  revision: number
  run?: string
}>

function sameQueueWatchFocus(left: QueueWatchFocus | undefined, right: QueueWatchFocus | undefined): boolean {
  return left?.pr === right?.pr && left?.revision === right?.revision && left?.run === right?.run
}

function selectedQueueWatchFocus(
  row: Readonly<{ pr: string; run?: string }> | undefined,
  projectedRow: QueueTimelineProjectedRow | undefined,
  prs: readonly PR[],
): QueueWatchFocus | undefined {
  if (row === undefined) return undefined
  const pr = prs.find((candidate) => candidate.id === row.pr)
  const revision = projectedRow?.revision ?? (pr === undefined ? undefined : prRevisionNumber(pr))
  if (revision === undefined) return undefined
  return { pr: row.pr, revision, ...(row.run === undefined ? {} : { run: row.run }) }
}

function useReportQueueWatchFocus(
  focus: QueueWatchFocus | undefined,
  onFocusChange: ((focus: QueueWatchFocus) => void) | undefined,
): void {
  useEffect(() => {
    if (focus !== undefined) onFocusChange?.(focus)
  }, [focus, onFocusChange])
}

export type QueueWatchPaneProps = Readonly<{
  initial: QueueWatchSnapshot
  load(focus?: QueueWatchFocus): Promise<QueueWatchSnapshot>
  intervalMs: number
  pr?: string
  onCancelRun?: (run: string) => void | Promise<void>
}>

type QueueArtifactOutputLine = Readonly<{
  key: string
  text: string
  kind: "heading" | "muted" | "body"
}>

function queueArtifactOutputLines(
  outputs: readonly QueueArtifactOutput[],
  inline: boolean,
): readonly QueueArtifactOutputLine[] {
  return outputs.flatMap((output) => {
    const outputKey = `${output.run}:${output.step}:${output.attempt}:${output.path}`
    const textLines = output.text.split("\n")
    if (textLines.at(-1) === "") textLines.pop()
    return [
      ...(inline
        ? []
        : [
            {
              key: `${outputKey}:heading`,
              text: `OUTPUT ${output.step}#${output.attempt}`,
              kind: "heading" as const,
            },
          ]),
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
        ? [
            {
              key: `${outputKey}:waiting`,
              text: inline ? "No output recorded." : "Waiting for output...",
              kind: "body" as const,
            },
          ]
        : textLines.map((text, index) => ({
            key: `${outputKey}:line:${index}`,
            text,
            kind: "body" as const,
          }))),
    ] satisfies readonly QueueArtifactOutputLine[]
  })
}

function QueueArtifactOutputList({ outputs, inline }: { outputs: readonly QueueArtifactOutput[]; inline: boolean }) {
  const listRef = useRef<ListViewHandle | null>(null)
  const [atEnd, setAtEnd] = useState(true)
  const [unseenLines, setUnseenLines] = useState(0)
  const lines = useMemo(() => queueArtifactOutputLines(outputs, inline), [inline, outputs])
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
    <Box flexDirection="column" flexGrow={1} minHeight={0} marginTop={inline ? 0 : 1}>
      {inline ? null : (
        <Text color="$fg-muted" bold={!atEnd}>
          {followStatus}
        </Text>
      )}
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
        renderItem={(row) => (
          // ListView suppresses selection on its navigation wrapper. Restore a
          // text-selectable island for every output row so drag-select reaches
          // Silvery's OSC52 copy path while mouse tracking remains enabled.
          <Box userSelect="text" flexDirection="column" width="100%" minWidth={0} overflow="hidden">
            {row.kind === "heading" ? (
              <Text bold wrap="truncate">
                {row.text}
              </Text>
            ) : row.kind === "muted" ? (
              <Text color="$fg-muted">{row.text}</Text>
            ) : inline ? (
              <Text color="$fg-muted" bgConflict="ignore" wrap="wrap">
                {row.text}
              </Text>
            ) : (
              // Body rows mirror a step's raw `output.log` tail — foreign terminal
              // output whose embedded ANSI (colors AND backgrounds, e.g. vitest's
              // cyan ` RUN ` banner) is intentional. `bgConflict="ignore"` keeps
              // those colors and stops silvery's background-conflict guard (default
              // `throw`) from killing the watch loop, while the global throw stays a
              // safety net for silvery's own pipeline bugs everywhere else.
              <Text bgConflict="ignore" wrap="wrap">
                {row.text}
              </Text>
            )}
          </Box>
        )}
      />
    </Box>
  )
}

export function QueueArtifactOutputView({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  return <QueueArtifactOutputList outputs={outputs} inline={false} />
}

function queueStepNames(data: QueueShowData): readonly string[] {
  return [...new Set(data.steps.map((row) => row.step))]
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

/** Step output is static inside the single scroll owner shared by its tab. */
function QueueInlineArtifactOutputRows({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  const lines = useMemo(() => queueArtifactOutputLines(outputs, true), [outputs])
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {lines.map((row) => (
        <Text key={row.key} color="$fg-muted" bgConflict="ignore" wrap="wrap">
          {row.text === "" ? " " : row.text}
        </Text>
      ))}
    </Box>
  )
}

function QueueTabScrollArea({ children, followEnd = false }: { children: ReactNode; followEnd?: boolean }) {
  const controller = useScrollController()
  const previousGeometry = useRef({ contentHeight: 0, maxScroll: 0 })

  useEffect(() => {
    const previous = previousGeometry.current
    const contentGrew = controller.contentHeight > previous.contentHeight
    const wasAtEnd = previous.maxScroll === 0 || controller.scrollOffset >= previous.maxScroll
    previousGeometry.current = { contentHeight: controller.contentHeight, maxScroll: controller.maxScroll }
    if (followEnd && contentGrew && wasAtEnd) controller.setScrollOffset(controller.maxScroll)
  }, [controller, followEnd])

  return (
    <ScrollArea controller={controller} userSelect="text">
      {children}
    </ScrollArea>
  )
}

function usableStepOutput(output: string | undefined): string | undefined {
  const trimmed = output?.trim()
  if (trimmed === undefined || trimmed === "" || trimmed === "-" || /^waiting\b/iu.test(trimmed)) return undefined
  return trimmed
}

function nativeMergeCommand(data: QueueShowData, step: string): string | undefined {
  // Composition members are materialized through composePR rather than this
  // git command. In that case the honest UI is the MERGE/PARENTS summary below,
  // never a plausible-looking command the runner did not execute.
  if (step !== "merge" || data.prs.length === 0 || data.prs.some((pr) => pr.composition !== undefined)) {
    return undefined
  }
  return data.prs.map((pr) => `git merge --no-ff --no-edit ${pr.headSha}`).join(" && ")
}

function stepSummaryOutput(data: QueueShowData, step: string, output: string | undefined): readonly string[] {
  if (step === "merge" && data.integration !== undefined) {
    const parents = [data.integration.baseSha, ...data.prs.map((pr) => pr.headSha)]
    return [`PARENTS ${parents.join(" ")}`]
  }
  const recorded = usableStepOutput(output)
  if (recorded !== undefined) return recorded.split("\n")
  return ["No output recorded."]
}

type QueueStepExecution = Readonly<{
  command?: string
  outputs: readonly QueueArtifactOutput[]
}>

function queueStepExecutions({
  data,
  name,
  stepRows,
  stepOutputs,
  commands,
}: {
  data: QueueShowData
  name: string
  stepRows: QueueShowData["steps"]
  stepOutputs: readonly QueueArtifactOutput[]
  commands?: Readonly<Record<string, string>>
}): readonly QueueStepExecution[] {
  const fallbackCommand = nativeMergeCommand(data, name) ?? commands?.[name]
  if (stepRows.length > 0) {
    return stepRows.map((stepRow) => {
      const attempt = syntheticArtifactAttempt(stepRow.attempt)
      const recorded = stepOutputs.filter((output) => output.attempt === attempt)
      const command = usableStepOutput(stepRow.command) ?? fallbackCommand
      return {
        ...(command === undefined ? {} : { command }),
        outputs:
          recorded.length > 0
            ? recorded
            : [
                {
                  run: data.run,
                  step: name,
                  attempt,
                  path: "",
                  text: stepSummaryOutput(data, name, stepRow.output).join("\n"),
                },
              ],
      }
    })
  }

  const outputsByAttempt = new Map<number, QueueArtifactOutput[]>()
  for (const output of stepOutputs) {
    const attemptOutputs = outputsByAttempt.get(output.attempt) ?? []
    attemptOutputs.push(output)
    outputsByAttempt.set(output.attempt, attemptOutputs)
  }
  if (outputsByAttempt.size > 0) {
    return [...outputsByAttempt.values()].map((attemptOutputs) => ({
      ...(fallbackCommand === undefined ? {} : { command: fallbackCommand }),
      outputs: attemptOutputs,
    }))
  }

  return [
    {
      ...(fallbackCommand === undefined ? {} : { command: fallbackCommand }),
      outputs: [
        {
          run: data.run,
          step: name,
          attempt: syntheticArtifactAttempt(undefined),
          path: "",
          text: stepSummaryOutput(data, name, undefined).join("\n"),
        },
      ],
    },
  ]
}

/** Synthetic inline summaries only need a stable positive artifact key. */
function syntheticArtifactAttempt(attempt: string | undefined): number {
  const parsed = attempt === undefined ? Number.NaN : Number(attempt)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function submitClock(data: QueueShowData, prs: readonly PR[]): string {
  const submitted = data.prs.flatMap((member) => {
    const pr = prs.find((candidate) => candidate.id === member.id)
    const revision = pr?.revs.find((candidate) => candidate.n === member.revision && candidate.head === member.headSha)
    const at = revision?.submittedAt ?? revision?.pushedAt
    return at === undefined ? [] : [at]
  })
  const latest = submitted.toSorted().at(-1)
  if (latest === undefined) return "time unavailable"
  const date = new Date(latest)
  if (Number.isNaN(date.getTime())) return "time unavailable"
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function QueueSubmitDiff({
  data,
  diff,
  expanded,
  onToggle,
}: {
  data: QueueShowData
  diff: QueuePrDiff | undefined
  expanded: boolean
  onToggle(): void
}) {
  const focusId = `queue-submit-diff-${data.run}-${diff?.pr ?? "missing"}-${diff?.revision ?? "missing"}`
  const { activeId } = useFocusManager()
  const focused = activeId === focusId
  useInput(
    (input, key) => {
      if (key.return || (input === " " && !key.ctrl && !key.meta && !key.shift)) onToggle()
    },
    { isActive: focused && diff !== undefined && !("unavailable" in diff) },
  )
  if (diff === undefined || "unavailable" in diff) {
    return (
      <Box flexDirection="column" minWidth={0}>
        <Box height={1} flexShrink={0} />
        <Text color="$fg-muted">
          {diff === undefined || diff.unavailable === "refs-pruned"
            ? "diff unavailable (refs pruned)"
            : "diff unavailable (git error)"}
        </Text>
        <Box height={1} flexShrink={0} />
        <Divider />
      </Box>
    )
  }
  const summary = `Diff +${diff.additions} / -${diff.deletions} lines`
  return (
    <Box flexDirection="column" minWidth={0} userSelect="text" {...(expanded ? { onClick: onToggle } : {})}>
      <Box height={1} flexShrink={0} />
      <Box
        testID={focusId}
        focusable
        {...(expanded ? {} : { onClick: onToggle })}
        userSelect="text"
        minWidth={0}
        backgroundColor={focused ? "$bg-selected" : undefined}
      >
        <Text wrap="truncate" color={focused ? "$fg-on-selected" : undefined}>
          {summary}
        </Text>
      </Box>
      <Box height={1} flexShrink={0} />
      {expanded ? (
        <>
          <Text color="$fg-muted">Files ({diff.files.length})</Text>
          {diff.files.map((file) => (
            <Text key={file} color="$fg-muted" wrap="wrap">
              - {file}
            </Text>
          ))}
          {diff.patch.split("\n").map((line, index) => (
            <Text key={`patch:${index}`} color="$fg-muted" bgConflict="ignore" wrap="wrap">
              {line === "" ? " " : line}
            </Text>
          ))}
        </>
      ) : null}
      <Divider />
    </Box>
  )
}

function QueueSubmitPanel({
  data,
  row,
  rows,
  prs,
  runDetails,
  diffs,
}: {
  data: QueueShowData
  row?: QueueTimelineProjectedRow
  rows: readonly QueueTimelineProjectedRow[]
  prs: readonly PR[]
  runDetails: readonly QueueShowData[]
  diffs: readonly QueuePrDiff[]
}) {
  const [expandedPr, setExpandedPr] = useState<string | null>(null)
  return (
    <Box flexDirection="column" minWidth={0} flexGrow={1}>
      {data.prs.map((member) => {
        const key = `${member.id}:${member.revision}`
        const diff = diffs.find((candidate) => candidate.pr === member.id && candidate.revision === member.revision)
        return (
          <Box key={key} flexDirection="column" minWidth={0}>
            <QueueDetailRunPrBlocks
              data={{ ...data, prs: [member] }}
              row={row}
              rows={rows}
              prs={prs}
              runDetails={runDetails}
            />
            <QueueSubmitDiff
              data={data}
              diff={diff}
              expanded={expandedPr === key}
              onToggle={() => setExpandedPr((current) => (current === key ? null : key))}
            />
          </Box>
        )
      })}
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
  runRows = [],
  runDetails = [],
  diffs = [],
}: {
  data?: QueueShowData
  row?: QueueTimelineProjectedRow
  outputs: readonly QueueArtifactOutput[]
  commands?: Readonly<Record<string, string>>
  compact: boolean
  active: boolean
  highlightPr?: string
  prs: readonly PR[]
  runRows?: readonly QueueTimelineProjectedRow[]
  runDetails?: readonly QueueShowData[]
  diffs?: readonly QueuePrDiff[]
}) {
  const names = useMemo(() => (data === undefined ? [] : queueStepNames(data)), [data])
  const tabNames = useMemo(() => (data === undefined ? [] : ["submit", ...names]), [data, names])
  // Revision B makes submission the stable entry point. Runtime step progress
  // still colors the real tabs; operator selection overrides the initial tab.
  // The parent remounts on run change, resetting that override.
  const liveStep = data === undefined ? undefined : "submit"
  const [userSelectedStep, setUserSelectedStep] = useState<string | null>(null)
  const activeStep = resolveStepTabSelection(tabNames, liveStep, userSelectedStep)

  const selectedPr = prs.find((pr) => pr.id === row?.pr) ?? prs[0]
  const submitted = row?.timestamp === null ? undefined : row?.timestamp
  const submitStatus =
    data === undefined ? "" : `✓ ${submitClock(data, prs)} ${data.prs.length} PR${data.prs.length === 1 ? "" : "s"}`

  // Round 6 tabs are two-row, equally measured segments. Both active and
  // inactive states are filled, and no flex growth may stretch them past the
  // widest title/status+duration content.
  const stepTabWidth =
    data === undefined
      ? 0
      : Math.max(
          1,
          ...tabNames.map((name) => {
            if (name === "submit") return Math.max("0: submit".length, submitStatus.length)
            const rep = data.steps.filter((row) => row.step === name).at(-1)
            const duration = rep?.duration === undefined || rep.duration === "-" ? "" : rep.duration
            const glyph = rep === undefined ? "" : timelineStatusGlyph(rep.status)
            return Math.max(
              `${names.indexOf(name) + 1}: ${name}`.length,
              `${glyph} ${rep?.status ?? ""}${duration === "" ? "" : ` ${duration}`}`.length,
            )
          }),
        )
  const stepTabLabel = (name: string, selected: boolean) => {
    if (data === undefined) return name
    if (name === "submit") {
      return (
        <Text color={selected ? "$fg-on-selected" : undefined}>
          {"0: submit".padEnd(stepTabWidth)}
          {"\n"}
          <Text color={selected ? "$fg-on-selected" : "$fg-success"}>{submitStatus}</Text>
          {" ".repeat(Math.max(0, stepTabWidth - submitStatus.length))}
        </Text>
      )
    }
    const stepRows = data.steps.filter((row) => row.step === name)
    const rep = stepRows.at(-1)
    if (rep === undefined) return name
    const duration = rep.duration === "-" ? "" : rep.duration
    const number = names.indexOf(name) + 1
    const glyph = timelineStatusGlyph(rep.status)
    const status = `${glyph} ${rep.status}`
    const remainder = Math.max(0, stepTabWidth - status.length - (duration === "" ? 0 : duration.length + 1))
    return (
      <Text color={selected ? "$fg-on-selected" : undefined}>
        {`${number}: ${name}`.padEnd(stepTabWidth)}
        {"\n"}
        <Text color={selected ? "$fg-on-selected" : taskStatusColor(rep.taskStatus)} bold={rep.taskStatus === "wip"}>
          {status}
        </Text>
        {duration === "" ? "" : " "}
        {duration === "" ? null : (
          <Text color={selected ? "$fg-on-selected" : undefined} bold={false} internal_dim>
            {duration}
          </Text>
        )}
        {" ".repeat(remainder)}
      </Text>
    )
  }
  return (
    // Detail order (item H, 2026-07-16): run-level facts at the TOP, then the
    // step TABS row, then the selected step's content BELOW — the tab is the
    // visual title of the step section, so step title + step contents read as
    // one grouped unit.
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {data === undefined ? (
        <>
          <QueueDetailRunPrBlocks row={row} rows={runRows} prs={prs} runDetails={runDetails} />
          {row?.position === undefined ? null : <Text>{`${"POSITION".padEnd(9, " ")}${row.position}`}</Text>}
          {submitted === undefined ? null : (
            <Text>{`${"TIMELINE".padEnd(9, " ")}${submitted.slice(11, 19)} → pending`}</Text>
          )}
          {selectedPr === undefined ? null : (
            <Text wrap="truncate" color="$fg-muted">{`${"HEAD".padEnd(9, " ")}${prHead(selectedPr)}`}</Text>
          )}
        </>
      ) : activeStep === undefined ? (
        <>
          <QueueShowView
            data={data}
            compact={compact}
            highlightPr={highlightPr}
            section="run"
            titleAbove
            showMembers={false}
            showIntegration={false}
          />
          <QueueSubmitPanel data={data} row={row} rows={runRows} prs={prs} runDetails={runDetails} diffs={diffs} />
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
            showIntegration={false}
          />
          <Tabs value={activeStep} onChange={setUserSelectedStep} isActive={active}>
            <Box height={1} flexShrink={0} />
            <TabList>
              {tabNames.map((name) => (
                <Box
                  key={name}
                  backgroundColor={activeStep === name ? "$bg-selected" : "$bg-surface-subtle"}
                  paddingLeft={2}
                  paddingY={1}
                  width={stepTabWidth + 4}
                  flexShrink={0}
                >
                  <Tab value={name}>{stepTabLabel(name, activeStep === name)}</Tab>
                </Box>
              ))}
            </TabList>
            <Box height={1} flexShrink={0} />
            {tabNames.map((name) => {
              if (name === "submit") {
                return (
                  <TabPanel key={name} value={name}>
                    <QueueTabScrollArea>
                      <QueueSubmitPanel
                        data={data}
                        row={row}
                        rows={runRows}
                        prs={prs}
                        runDetails={runDetails}
                        diffs={diffs}
                      />
                    </QueueTabScrollArea>
                  </TabPanel>
                )
              }
              const stepRows = data.steps.filter((row) => row.step === name)
              const stepOutputs = outputs.filter((output) => output.step === name)
              const stepData: QueueShowData = { ...data, steps: stepRows }
              // The job input is durable proof of what this run actually executed;
              // current config is only a preview for a step that has no job yet.
              const executions = queueStepExecutions({ data, name, stepRows, stepOutputs, commands })
              return (
                <TabPanel key={name} value={name}>
                  <QueueTabScrollArea followEnd>
                    {/* Only the step-level facts here (item H); the run-level facts
                    render once above the tabs. */}
                    <QueueShowView
                      data={stepData}
                      compact={compact}
                      highlightPr={highlightPr}
                      section="steps"
                      showLogArtifacts={false}
                      {...(selectedPr?.issue === undefined ? {} : { stepIssue: selectedPr.issue })}
                    />
                    {name === "merge" && data.integration !== undefined ? (
                      <>
                        <Text wrap="truncate">COMMIT {data.integration.commit}</Text>
                        <Text wrap="truncate">
                          PARENTS {[data.integration.baseSha, ...data.prs.map((pr) => pr.headSha)].join(" ")}
                        </Text>
                      </>
                    ) : null}
                    {executions.map((execution, index) => (
                      <Box key={`${name}:execution:${index}`} flexDirection="column" minWidth={0}>
                        <Box height={1} flexShrink={0} />
                        {execution.command === undefined ? null : (
                          <Box backgroundColor="$bg-surface-subtle" paddingX={1} flexShrink={0} minWidth={0}>
                            <Text bold color="$fg" wrap="truncate">
                              $ {execution.command}
                            </Text>
                          </Box>
                        )}
                        <QueueInlineArtifactOutputRows outputs={execution.outputs} />
                      </Box>
                    ))}
                  </QueueTabScrollArea>
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
  onFocusChange,
}: {
  snapshot: QueueWatchSnapshot
  pr?: string
  onCancelRun?: (run: string) => void | Promise<void>
  onFocusChange?: (focus: QueueWatchFocus) => void
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
  // Revision A makes DETAIL run-scoped: resolve every immutable run member for
  // the PR blocks, while pending rows retain the same one-template shape.
  const allFullPrs = snapshot.results.flatMap((result) => result.prs)
  // `rows` is a trimmed {key,pr,run} projection; the DETAIL identity and the
  // status-parameterized template need the full projected row at this index.
  const selectedProjectedRow = projectedRows?.[cursor]
  useReportQueueWatchFocus(selectedQueueWatchFocus(selectedRow, selectedProjectedRow, allFullPrs), onFocusChange)
  const detailRunRows =
    selectedRow?.run === undefined
      ? selectedProjectedRow === undefined
        ? []
        : [selectedProjectedRow]
      : (snapshot.projection?.rows.filter((candidate) => candidate.run === selectedRow.run) ?? [])
  const detailRunDetails = snapshot.results.flatMap((result) => {
    const runs = [...result.running, ...result.waiting, ...result.finished]
    return runs.map((run) => queueShowData(run, runs))
  })
  const detailMemberIds = new Set(
    detailData?.prs.map((member) => member.id) ?? (detailPr === undefined ? [] : [detailPr]),
  )
  const detailFullPrs = allFullPrs.filter((candidate) => detailMemberIds.has(candidate.id))
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
          runRows={detailRunRows}
          runDetails={detailRunDetails}
          diffs={snapshot.diffs ?? []}
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
  // is headed by an emphasized run identity with STATUS/OUTCOME right-aligned,
  // then exactly one blank row and the run-scoped body.
  // One cell of horizontal padding keeps content off the
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
      <Box height={1} flexShrink={0} />
      <Box flexGrow={1} minWidth={0} minHeight={0}>
        {detail}
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0} userSelect="text">
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
  const mounted = useRef(true)
  const focus = useRef<QueueWatchFocus | undefined>(undefined)
  const refreshRequested = useRef(false)
  const refreshInFlight = useRef<Promise<void> | undefined>(undefined)
  const refresh = useCallback((): Promise<void> => {
    refreshRequested.current = true
    const active = refreshInFlight.current
    if (active !== undefined) return active
    const pending = (async () => {
      while (refreshRequested.current) {
        refreshRequested.current = false
        const requestedFocus = focus.current
        const next = await load(requestedFocus)
        // Input wins: never commit details for a row the cursor left while its
        // async Git/artifact work was still in flight. The pending flag causes
        // one coalesced refresh for the newest focus instead of overlapping.
        if (mounted.current && sameQueueWatchFocus(requestedFocus, focus.current)) setSnapshot(next)
      }
    })().finally(() => {
      refreshInFlight.current = undefined
    })
    refreshInFlight.current = pending
    return pending
  }, [load])
  const onFocusChange = useCallback(
    (next: QueueWatchFocus): void => {
      if (sameQueueWatchFocus(focus.current, next)) return
      focus.current = next
      void refresh().catch((error: unknown) => {
        if (mounted.current) setFailure(error instanceof Error ? error : new Error(String(error)))
      })
    },
    [refresh],
  )

  useInput((input) => {
    if (input === "q") return "exit"
  })

  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  useScopeEffect(
    (scope) => {
      void (async () => {
        while (!scope.signal.aborted) {
          await refresh()
          if (scope.signal.aborted) return
          await scope.sleep(intervalMs)
        }
      })().catch((error: unknown) => {
        if (scope.signal.aborted) return
        setFailure(error instanceof Error ? error : new Error(String(error)))
      })
    },
    [intervalMs, refresh],
  )

  if (failure !== undefined) throw failure
  return (
    <QueueWatchFrame
      snapshot={snapshot}
      {...(pr === undefined ? {} : { pr })}
      {...(onCancelRun === undefined ? {} : { onCancelRun })}
      onFocusChange={onFocusChange}
    />
  )
}
