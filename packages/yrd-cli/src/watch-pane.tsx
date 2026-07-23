import { pathToFileURL } from "node:url"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Box,
  Divider,
  Link,
  ListView,
  ModalDialog,
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
import type { PR } from "@yrd/bay"
import {
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QueueDetailRunHeader,
  QueueDetailRunPrBlocks,
  QueueDetailTitle,
  QueueShowView,
  QueueStatusNotice,
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
import { timelineStatusGlyph } from "./runner-timeline.ts"
import { statusPresentation } from "./status-presentation.ts"
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

type QueueArtifactOutputCommon = Readonly<{
  run: string
  step: string
  attempt: number
  text: string
  truncatedBytes?: number
}>

/** A recorded tail owns a real local target. Synthetic step summaries are
 * deliberately pathless, so rendering cannot turn an empty/undefined path
 * into a plausible but false OSC8 link. */
export type QueueArtifactOutput =
  | (QueueArtifactOutputCommon & Readonly<{ source: "recorded"; path: string }>)
  | (QueueArtifactOutputCommon & Readonly<{ source: "summary" }>)

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
      reason: string
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
  /** Revision-bound source deltas shown in the PR-scoped detail header. */
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
  const revision = projectedRow?.revision ?? prs.find((candidate) => candidate.id === row.pr)?.revision
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

type QueueArtifactOutputLine =
  | Readonly<{ key: string; text: string; kind: "link"; href: string }>
  | Readonly<{ key: string; text: string; kind: "heading" | "muted" | "body" }>

function queueArtifactOutputLines(
  outputs: readonly QueueArtifactOutput[],
  inline: boolean,
): readonly QueueArtifactOutputLine[] {
  return outputs.flatMap((output) => {
    const outputKey = `${output.run}:${output.step}:${output.attempt}:${
      output.source === "recorded" ? output.path : "summary"
    }`
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
      ...(output.source === "recorded"
        ? [
            {
              key: `${outputKey}:full-log`,
              text: `(f) ${output.path}`,
              kind: "link" as const,
              href: pathToFileURL(output.path).href,
            },
          ]
        : []),
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
            ) : row.kind === "link" ? (
              <Link href={row.href}>{row.text}</Link>
            ) : row.kind === "muted" ? (
              <Text color="$fg-muted">{row.text}</Text>
            ) : inline ? (
              <Text color="$fg-muted" bgConflict="ignore" wrap="truncate" minWidth={0}>
                {row.text}
              </Text>
            ) : (
              // Body rows mirror a step's raw `output.log` tail — foreign terminal
              // output whose embedded ANSI (colors AND backgrounds, e.g. vitest's
              // cyan ` RUN ` banner) is intentional. `bgConflict="ignore"` keeps
              // those colors and stops silvery's background-conflict guard (default
              // `throw`) from killing the watch loop, while the global throw stays a
              // safety net for silvery's own pipeline bugs everywhere else.
              // Log rows render ONE terminal row each (truncate, never wrap) so a
              // few long lines can't fill the pane; "open full log" is the escape
              // hatch for full content.
              <Text bgConflict="ignore" wrap="truncate" minWidth={0}>
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

/** A terminal predecessor makes later unstarted steps non-runnable. This is a
 * display projection only; the durable Run/Job records remain untouched. */
function queueDisplayStepData(data: QueueShowData): QueueShowData {
  if (data.status !== "failed" && data.status !== "canceled") return data
  const names = queueStepNames(data)
  const failedNameIndex = names.findIndex((name) =>
    data.steps.some(
      (row) => row.step === name && (row.status === "failed" || row.status === "lost" || row.taskStatus === "blocked"),
    ),
  )
  let changed = false
  const steps = data.steps.map((row) => {
    const nameIndex = names.indexOf(row.step)
    const afterFailure = failedNameIndex < 0 || nameIndex > failedNameIndex
    const unstarted = row.started === "-" && row.finished === "-"
    if (!afterFailure || !unstarted) return row
    changed = true
    return { ...row, status: "canceled", taskStatus: "dropped" as const, glyph: "−" as const }
  })
  return changed ? { ...data, steps } : data
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

/** The collapsed command block shows at most this many trailing output lines. */
const COMMAND_OUTPUT_TAIL_LINES = 10

/**
 * Tab 0 is a synthetic PR/submission overview (user directive 2026-07-21,
 * restoring it): PR facts + changed files + diff. The sentinel id has a
 * leading space so it cannot collide with a real step name (step names are
 * bare identifiers like `check`/`merge`, never space-prefixed).
 */
const PR_TAB_ID = " pr"
const PR_TAB_LABEL = "PR"

function queueDefaultStepTab(data: QueueShowData, outputs: readonly QueueArtifactOutput[]): string {
  const names = queueStepNames(data)
  const failed = data.steps.findLast(
    (step) => step.status === "failed" || step.status === "lost" || step.taskStatus === "blocked",
  )?.step
  if (failed !== undefined) return failed
  const running = data.steps.findLast((step) => step.status === "running")?.step
  if (running !== undefined) return running
  const newestOutput = outputs
    .toReversed()
    .find((output) => names.includes(output.step) && usableStepOutput(output.text) !== undefined)?.step
  if (newestOutput !== undefined) return newestOutput
  return data.steps.findLast((step) => step.status !== "requested" && step.status !== "queued")?.step ?? PR_TAB_ID
}

function QueueArtifactOutputRow({ row }: { row: QueueArtifactOutputLine }) {
  return (
    <Box minWidth={0}>
      {row.kind === "link" ? (
        <Link href={row.href}>{row.text}</Link>
      ) : (
        // One terminal row per log line (truncate, never wrap) — the 21684
        // truncation contract; the full-log link carries overflow.
        <Text color="$fg-muted" bgConflict="ignore" wrap="truncate" minWidth={0}>
          {row.text === "" ? " " : row.text}
        </Text>
      )}
    </Box>
  )
}

/** Step output is static inside the single scroll owner shared by its tab. */
export function QueueInlineArtifactOutputRows({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  const lines = useMemo(() => queueArtifactOutputLines(outputs, true), [outputs])
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {lines.map((row) => (
        <Box key={row.key} minWidth={0}>
          {row.kind === "link" ? (
            <Link href={row.href}>{row.text}</Link>
          ) : (
            // One terminal row per log line (truncate, never wrap) — see the
            // tail-list rationale above; the full-log link carries overflow.
            <Text color="$fg-muted" bgConflict="ignore" wrap="truncate" minWidth={0}>
              {row.text === "" ? " " : row.text}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

/**
 * A Silver-Code-style command block (user directive 2026-07-21): the `$ cmd`
 * header row stays visible while the output beneath it renders as a bounded
 * tail window — the last {@link COMMAND_OUTPUT_TAIL_LINES} lines scrolling by
 * live — and clicking the block toggles the full log. A step's command list
 * is never buried by one command's output. Proof-link and truncation rows
 * stay pinned above the window.
 */
function QueueCommandExecutionBlock({
  command,
  outputs,
}: {
  command?: string
  outputs: readonly QueueArtifactOutput[]
}) {
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded((current) => !current)
  const lines = useMemo(() => queueArtifactOutputLines(outputs, true), [outputs])
  const chrome = lines.filter((row) => row.kind !== "body")
  const body = lines.filter((row) => row.kind === "body")
  const visibleBody = expanded ? body : body.slice(-COMMAND_OUTPUT_TAIL_LINES)
  const hidden = body.length - visibleBody.length
  return (
    <Box flexDirection="column" minWidth={0} userSelect="text" {...(expanded ? { onClick: toggle } : {})}>
      <Box height={1} flexShrink={0} />
      {command === undefined ? null : (
        <Box backgroundColor="$bg-surface-subtle" paddingX={1} flexShrink={0} minWidth={0} onClick={toggle}>
          <Text bold wrap="truncate">
            $ {command}
          </Text>
        </Box>
      )}
      {chrome.map((row) => (
        <QueueArtifactOutputRow key={row.key} row={row} />
      ))}
      {hidden === 0 ? null : (
        <Box minWidth={0} onClick={toggle}>
          <Text color="$fg-muted" wrap="truncate">
            … {hidden} earlier {hidden === 1 ? "line" : "lines"} — click to expand
          </Text>
        </Box>
      )}
      {visibleBody.map((row) => (
        <QueueArtifactOutputRow key={row.key} row={row} />
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
                  source: "summary",
                  run: data.run,
                  step: name,
                  attempt,
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
          source: "summary",
          run: data.run,
          step: name,
          attempt: syntheticArtifactAttempt(undefined),
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

function QueueSubmitDiff({
  diff,
  expanded,
  onToggle,
}: {
  diff: QueuePrDiff | undefined
  expanded: boolean
  onToggle(): void
}) {
  const focusId = `queue-submit-diff-${diff?.pr ?? "missing"}-${diff?.revision ?? "missing"}`
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
        <Text color="$fg-muted">{diff === undefined ? "diff loading…" : `diff unavailable — ${diff.reason}`}</Text>
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

/**
 * The PR-scoped header leading the detail body (user directive 2026-07-21):
 * the selected member's branch/subject/timeline/facts block plus its
 * revision-bound source delta. The identity row lives in the pane title
 * (QueueDetailTitle), so the block renders `titleAbove`.
 */
function QueueDetailPrSection({
  data,
  row,
  rows,
  prs,
  runDetails,
  diffs,
  highlightPr,
}: {
  data?: QueueShowData
  row?: QueueTimelineProjectedRow
  rows: readonly QueueTimelineProjectedRow[]
  prs: readonly PR[]
  runDetails: readonly QueueShowData[]
  diffs: readonly QueuePrDiff[]
  highlightPr?: string
}) {
  const [diffExpanded, setDiffExpanded] = useState(false)
  const member =
    data === undefined
      ? undefined
      : (data.prs.find((candidate) => candidate.id === (highlightPr ?? row?.pr)) ?? data.prs[0])
  const diffTarget = member ?? (row === undefined ? undefined : { id: row.pr, revision: row.revision })
  const diff =
    diffTarget === undefined
      ? undefined
      : diffs.find((candidate) => candidate.pr === diffTarget.id && candidate.revision === diffTarget.revision)
  return (
    <Box flexDirection="column" minWidth={0} flexShrink={0}>
      <QueueDetailRunPrBlocks
        titleAbove
        {...(data === undefined || member === undefined ? {} : { data: { ...data, prs: [member] } })}
        {...(row === undefined ? {} : { row })}
        rows={rows}
        prs={prs}
        runDetails={runDetails}
        {...(row?.position === undefined ? {} : { position: row.position })}
      />
      {data !== undefined || diff !== undefined ? (
        <QueueSubmitDiff diff={diff} expanded={diffExpanded} onToggle={() => setDiffExpanded((current) => !current)} />
      ) : null}
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
  const displayData = useMemo(() => (data === undefined ? undefined : queueDisplayStepData(data)), [data])
  const names = useMemo(() => (displayData === undefined ? [] : queueStepNames(displayData)), [displayData])
  // The PR/submission overview remains tab 0, ahead of the real step tabs.
  // Default selection follows the failing/live step, then the newest recorded
  // output or terminal step. Operator selection overrides it; the parent
  // remounts on run change, resetting that override.
  const tabNames = useMemo(() => (displayData === undefined ? [] : [PR_TAB_ID, ...names]), [displayData, names])
  const liveStep = displayData === undefined ? undefined : queueDefaultStepTab(displayData, outputs)
  const [userSelectedStep, setUserSelectedStep] = useState<string | null>(null)
  const activeStep = resolveStepTabSelection(tabNames, liveStep, userSelectedStep)

  // Round 6 tabs are two-row, equally measured segments. Both active and
  // inactive states are filled, and no flex growth may stretch them past the
  // widest title/status+duration content.
  const stepTabWidth =
    displayData === undefined
      ? 0
      : Math.max(
          1,
          PR_TAB_LABEL.length,
          ...names.map((name) => {
            const rep = displayData.steps.filter((row) => row.step === name).at(-1)
            const duration = rep?.duration === undefined || rep.duration === "-" ? "" : rep.duration
            const glyph = rep === undefined ? "" : timelineStatusGlyph(rep.status)
            return Math.max(
              `${names.indexOf(name) + 1}: ${name}`.length,
              `${glyph} ${rep?.status ?? ""}${duration === "" ? "" : ` ${duration}`}`.length,
            )
          }),
        )
  const stepTabLabel = (name: string, selected: boolean) => {
    if (name === PR_TAB_ID) {
      return (
        <Text color={selected ? "$fg-on-selected" : undefined}>
          {PR_TAB_LABEL.padEnd(stepTabWidth)}
          {"\n"}
          {" ".repeat(stepTabWidth)}
        </Text>
      )
    }
    if (displayData === undefined) return name
    const stepRows = displayData.steps.filter((row) => row.step === name)
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
        <Text
          color={selected ? "$fg-on-selected" : statusPresentation(rep.status).color}
          bold={rep.status === "running"}
        >
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
    // Detail order: one persistent RUN/timing/status header, then the PR
    // overview tab and real workflow-step tabs. The newest relevant step is
    // selected automatically; the PR tab remains available for source facts.
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {displayData === undefined ? (
        <>
          <QueueStatusNotice {...(row === undefined ? {} : { row })} runDetails={runDetails} live={active} />
          <QueueDetailPrSection
            {...(row === undefined ? {} : { row })}
            rows={runRows}
            prs={prs}
            runDetails={runDetails}
            diffs={diffs}
            {...(highlightPr === undefined ? {} : { highlightPr })}
          />
        </>
      ) : activeStep === undefined ? null : (
        <>
          <QueueDetailRunHeader data={displayData} {...(row === undefined ? {} : { row })} />
          <QueueShowView
            data={displayData}
            compact={compact}
            highlightPr={highlightPr}
            section="run"
            titleAbove
            showMembers={displayData.prs.length > 1}
            showIntegration={false}
            showTiming={false}
            showFailureDetails={false}
          />
          <QueueStatusNotice
            {...(row === undefined ? {} : { row })}
            data={displayData}
            runDetails={runDetails}
            live={active}
          />
          <Box height={1} flexShrink={0} />
          <Tabs value={activeStep} onChange={setUserSelectedStep} isActive={active}>
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
            <TabPanel value={PR_TAB_ID}>
              <QueueTabScrollArea>
                <QueueDetailPrSection
                  data={displayData}
                  {...(row === undefined ? {} : { row })}
                  rows={runRows}
                  prs={prs}
                  runDetails={runDetails}
                  diffs={diffs}
                  {...(highlightPr === undefined ? {} : { highlightPr })}
                />
              </QueueTabScrollArea>
            </TabPanel>
            {names.map((name) => {
              const stepRows = displayData.steps.filter((row) => row.step === name)
              const stepOutputs = outputs.filter((output) => output.step === name)
              const stepData: QueueShowData = { ...displayData, steps: stepRows }
              // The job input is durable proof of what this run actually executed;
              // current config is only a preview for a step that has no job yet.
              const executions = queueStepExecutions({
                data: displayData,
                name,
                stepRows,
                stepOutputs,
                commands,
              })
              return (
                <TabPanel key={name} value={name}>
                  <QueueTabScrollArea followEnd>
                    {/* Only the step-level facts here; the run-level facts render
                    once above the step tabs. */}
                    <QueueShowView
                      data={stepData}
                      compact={compact}
                      highlightPr={highlightPr}
                      section="steps"
                      showLogArtifacts
                      showFailureDetails={false}
                    />
                    {name === "merge" && displayData.integration !== undefined ? (
                      <>
                        <Text wrap="truncate">COMMIT {displayData.integration.commit}</Text>
                        <Text wrap="truncate">
                          PARENTS{" "}
                          {[displayData.integration.baseSha, ...displayData.prs.map((pr) => pr.headSha)].join(" ")}
                        </Text>
                      </>
                    ) : null}
                    {executions.map((execution, index) => (
                      <QueueCommandExecutionBlock
                        key={`${name}:execution:${index}`}
                        {...(execution.command === undefined ? {} : { command: execution.command })}
                        outputs={execution.outputs}
                      />
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

/** The selected PR's linked issue for the PR-scoped pane title. */
function selectedDetailIssue(
  prs: readonly PR[],
  selectedPr: string | undefined,
  fallbackPr: string | undefined,
): string | undefined {
  return prs.find((candidate) => candidate.id === (selectedPr ?? fallbackPr))?.issue
}

type QueueWatchCursorMode = "follow-newest" | "auto-follow-run" | "fixed-row"

type QueueWatchCursorRow = Readonly<{
  key: string
  pr: string
  revision: number
  status: string
  run?: string
}>

type QueueWatchCursorState = Readonly<{
  mode: QueueWatchCursorMode
  rowKey?: string
  notice?: string
}>

type QueueWatchCursorOp =
  | Readonly<{ type: "select-row"; index: number; fixed: boolean }>
  | Readonly<{ type: "cycle-action-top" }>
  | Readonly<{ type: "jump-bottom" }>

function queueWatchCursorLabel(row: QueueWatchCursorRow): string {
  return `pr#${row.pr.replace(/^pr(?:[-#])?/iu, "")}.${row.revision}`
}

function queueWatchManualCursorMode(row: QueueWatchCursorRow, index: number): QueueWatchCursorMode {
  if (row.status === "running") return "auto-follow-run"
  return index === 0 ? "follow-newest" : "fixed-row"
}

function nearestPriorCursorNeighbor(
  missingKey: string,
  previousRows: readonly QueueWatchCursorRow[],
  rows: readonly QueueWatchCursorRow[],
): QueueWatchCursorRow | undefined {
  const previousIndex = previousRows.findIndex((row) => row.key === missingKey)
  if (previousIndex < 0) return undefined
  const currentByKey = new Map(rows.map((row) => [row.key, row]))
  for (let distance = 1; distance < previousRows.length; distance += 1) {
    // Prefer the visually preceding row on an equal-distance tie. This makes
    // a disappearing middle row move one line up, never to unrelated row 0.
    const before = previousRows[previousIndex - distance]
    if (before !== undefined) {
      const retained = currentByKey.get(before.key)
      if (retained !== undefined) return retained
    }
    const after = previousRows[previousIndex + distance]
    if (after !== undefined) {
      const retained = currentByKey.get(after.key)
      if (retained !== undefined) return retained
    }
  }
  return undefined
}

function firstRunningCursorRow(
  rows: readonly QueueWatchCursorRow[],
  runningRunOrder: ReadonlyMap<string, number>,
): QueueWatchCursorRow | undefined {
  const orderOf = (row: QueueWatchCursorRow): number => {
    if (row.run === undefined) throw new Error(`yrd: running queue row '${row.key}' has no run identity`)
    const order = runningRunOrder.get(row.run)
    if (order === undefined) {
      throw new Error(`yrd: running queue row '${row.key}' references inactive run '${row.run}'`)
    }
    return order
  }
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === "running")
    .sort((left, right) => orderOf(left.row) - orderOf(right.row) || left.index - right.index)[0]?.row
}

function queueWatchActionRow(
  rows: readonly QueueWatchCursorRow[],
  runningRunOrder: ReadonlyMap<string, number>,
): QueueWatchCursorRow | undefined {
  return firstRunningCursorRow(rows, runningRunOrder) ?? rows.find((row) => row.status === "submitted")
}

/** Pure cursor reconciliation: row identity and operator intent are state;
 * projection indices are only a rendering coordinate. */
function reconcileQueueWatchCursor(
  state: QueueWatchCursorState,
  previousRows: readonly QueueWatchCursorRow[],
  rows: readonly QueueWatchCursorRow[],
  runningRunOrder: ReadonlyMap<string, number>,
): QueueWatchCursorState {
  if (rows.length === 0) return state
  if (state.mode === "follow-newest") {
    const newest = rows[0]
    if (newest === undefined) return state
    return {
      mode: newest.status === "running" ? "auto-follow-run" : "follow-newest",
      rowKey: newest.key,
    }
  }

  const current = rows.find((row) => row.key === state.rowKey)
  if (state.mode === "auto-follow-run") {
    // Parking on a running PR follows that exact work until it settles. Only
    // then choose the next live run, ordered by durable run-start time.
    if (current?.status === "running") return { ...state, notice: undefined }
    const running = firstRunningCursorRow(rows, runningRunOrder)
    if (running !== undefined) return { mode: state.mode, rowKey: running.key }
    if (current !== undefined) return { ...state, notice: undefined }
  } else if (current !== undefined) {
    return state
  }

  const neighbor =
    (state.rowKey === undefined ? undefined : nearestPriorCursorNeighbor(state.rowKey, previousRows, rows)) ?? rows[0]
  if (neighbor === undefined) return state
  const missing = previousRows.find((row) => row.key === state.rowKey)
  return {
    ...state,
    rowKey: neighbor.key,
    ...(missing === undefined
      ? { notice: `selection moved: unavailable row → ${queueWatchCursorLabel(neighbor)}` }
      : {
          notice: `selection moved: ${queueWatchCursorLabel(missing)} is no longer visible → ${queueWatchCursorLabel(neighbor)}`,
        }),
  }
}

function applyQueueWatchCursorOp(
  state: QueueWatchCursorState,
  op: QueueWatchCursorOp,
  rows: readonly QueueWatchCursorRow[],
  runningRunOrder: ReadonlyMap<string, number>,
): QueueWatchCursorState {
  const current = reconcileQueueWatchCursor(state, rows, rows, runningRunOrder)
  if (op.type === "select-row") {
    const row = rows[op.index]
    if (row === undefined) return current
    return {
      mode: op.fixed ? "fixed-row" : queueWatchManualCursorMode(row, op.index),
      rowKey: row.key,
    }
  }
  if (op.type === "jump-bottom") {
    const row = rows.at(-1)
    return row === undefined ? current : { mode: "fixed-row", rowKey: row.key }
  }

  const top = rows[0]
  const actionRow = queueWatchActionRow(rows, runningRunOrder)
  const target = actionRow === undefined || current.rowKey === actionRow.key ? top : actionRow
  if (target === undefined) return current
  return {
    mode: target === actionRow && target.status === "running" ? "auto-follow-run" : "fixed-row",
    rowKey: target.key,
  }
}

function sameQueueWatchCursorState(left: QueueWatchCursorState, right: QueueWatchCursorState): boolean {
  return left.mode === right.mode && left.rowKey === right.rowKey && left.notice === right.notice
}

function initialQueueWatchCursorState(
  rows: readonly QueueWatchCursorRow[],
  requestedPr: string | undefined,
  defaultCursorKey: string | undefined,
): QueueWatchCursorState {
  if (rows.length === 0) {
    return { mode: requestedPr === undefined ? "follow-newest" : "fixed-row" }
  }
  if (requestedPr !== undefined) {
    const requested = rows.find((row) => row.pr === requestedPr)
    return requested === undefined
      ? { mode: "fixed-row" }
      : { mode: queueWatchManualCursorMode(requested, rows.indexOf(requested)), rowKey: requested.key }
  }
  const liveDefault = rows.find((row) => row.key === defaultCursorKey)
  const row = liveDefault?.status === "running" ? liveDefault : rows[0]
  if (row === undefined) throw new Error("yrd: non-empty queue has no initial cursor row")
  return {
    mode: row.status === "running" ? "auto-follow-run" : "follow-newest",
    rowKey: row.key,
  }
}

function queueRunningRunOrder(results: readonly QueueStatusResult[]): ReadonlyMap<string, number> {
  return new Map(
    results
      .flatMap((result) => result.running)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map((run, index) => [run.id, index] as const),
  )
}

function queueWatchCursorRows(
  snapshot: QueueWatchSnapshot,
  projectedRows: readonly QueueTimelineProjectedRow[] | undefined,
): readonly QueueWatchCursorRow[] {
  if (snapshot.projection === undefined) {
    return queueTimelineRows(snapshot.results, snapshot.now, false).map((row) => ({
      key: row.key,
      pr: row.pr,
      revision: row.revision,
      status: row.status,
      ...(row.run === undefined ? {} : { run: row.run }),
    }))
  }
  return (projectedRows ?? []).map((row) => ({
    key: row.id,
    pr: row.pr,
    revision: row.revision,
    status: row.status,
    ...(row.run === undefined ? {} : { run: row.run }),
  }))
}

function useQueueWatchCursor({
  rows,
  results,
  requestedPr,
  defaultCursorKey,
}: {
  rows: readonly QueueWatchCursorRow[]
  results: readonly QueueStatusResult[]
  requestedPr: string | undefined
  defaultCursorKey: string | undefined
}) {
  const [state, setState] = useState<QueueWatchCursorState>(() =>
    initialQueueWatchCursorState(rows, requestedPr, defaultCursorKey),
  )
  const previousRows = useRef<readonly QueueWatchCursorRow[]>(rows)
  const listRef = useRef<ListViewHandle | null>(null)
  const forcedFixedRowKey = useRef<string | undefined>(undefined)
  const runningRunOrder = useMemo(() => queueRunningRunOrder(results), [results])
  const resolved = reconcileQueueWatchCursor(state, previousRows.current, rows, runningRunOrder)
  const resolvedIndex = rows.findIndex((row) => row.key === resolved.rowKey)
  if (rows.length > 0 && resolvedIndex < 0) {
    throw new Error(`yrd: reconciled queue cursor '${resolved.rowKey ?? "<unset>"}' is not visible`)
  }

  useEffect(() => {
    previousRows.current = rows
    forcedFixedRowKey.current = undefined
    if (!sameQueueWatchCursorState(state, resolved)) setState(resolved)
  }, [resolved, rows, state])

  // The viewport is live data, not a cursor anchor. A changed newest identity
  // scrolls the list to row 0 while the selection remains on its row key.
  const newestRowKey = rows[0]?.key
  useEffect(() => {
    listRef.current?.scrollToTop()
  }, [newestRowKey])

  const selectRow = useCallback(
    (index: number): void => {
      const row = rows[index]
      if (row === undefined) return
      const forcedFixed = forcedFixedRowKey.current === row.key
      forcedFixedRowKey.current = undefined
      setState((current) =>
        applyQueueWatchCursorOp(current, { type: "select-row", index, fixed: forcedFixed }, rows, runningRunOrder),
      )
    },
    [rows, runningRunOrder],
  )
  const cycleActionAndTop = useCallback((): void => {
    setState((current) => applyQueueWatchCursorOp(current, { type: "cycle-action-top" }, rows, runningRunOrder))
  }, [rows, runningRunOrder])
  const jumpToBottom = useCallback((): void => {
    const target = rows.at(-1)
    if (target === undefined) return
    // ListView owns the physical G/End navigation and notifies onCursor in the
    // same input batch. Mark that callback as an explicit jump so it cannot
    // reinterpret a running bottom row as auto-follow.
    forcedFixedRowKey.current = target.key
    listRef.current?.scrollToBottom()
    setState((current) => applyQueueWatchCursorOp(current, { type: "jump-bottom" }, rows, runningRunOrder))
  }, [rows, runningRunOrder])

  return {
    cursor: Math.max(0, resolvedIndex),
    listRef,
    resolved,
    selectRow,
    cycleActionAndTop,
    jumpToBottom,
  } as const
}

const QUEUE_WATCH_HELP: ReadonlyArray<readonly [key: string, action: string]> = [
  ["g", "action position ↔ absolute top"],
  ["G", "absolute bottom"],
  ["j / k · ↑ / ↓", "move the cursor"],
  ["Enter / Esc", "open / close detail"],
  ["?", "close this help"],
]

function QueueWatchHelp({ onClose }: { onClose: () => void }) {
  return (
    <Box position="absolute" alignSelf="center" marginTop={1} flexDirection="column">
      <ModalDialog title="Watch keys" width={64} footer="Esc closes" onClose={onClose}>
        <Box flexDirection="column" paddingX={1}>
          {QUEUE_WATCH_HELP.map(([key, action]) => (
            <Box key={key} flexDirection="row">
              <Box width={18} flexShrink={0}>
                <Text bold>{key}</Text>
              </Box>
              <Text color="$fg-muted" wrap="truncate">
                {action}
              </Text>
            </Box>
          ))}
        </Box>
      </ModalDialog>
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
  const rows = useMemo(() => queueWatchCursorRows(snapshot, projectedRows), [projectedRows, snapshot])
  // Preserve the queue's active-work detail default while the viewport itself
  // always begins at physical row 0. Selection and scroll position are
  // deliberately independent contracts.
  const defaultCursorKey =
    snapshot.projection === undefined
      ? rows[0]?.key
      : queueTimelineVisibleDefaultCursorId(snapshot.projection, visibleBuckets, true)
  const cursorController = useQueueWatchCursor({
    rows,
    results: snapshot.results,
    requestedPr: pr,
    defaultCursorKey,
  })
  const { cursor, listRef: timelineListRef, resolved: resolvedCursorState, selectRow } = cursorController
  const [detailOpen, setDetailOpen] = useState(() => snapshot.projection === undefined || tier !== "full")
  const [helpOpen, setHelpOpen] = useState(false)
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  const [cancelArmed, setCancelArmed] = useState(false)
  const previousTier = useRef(tier)

  useEffect(() => {
    if (previousTier.current === tier) return
    previousTier.current = tier
    setDetailOpen(tier !== "full")
  }, [tier])

  useInput((input, key) => {
    const character = key.text ?? input
    if (character === "?") {
      setHelpOpen((open) => !open)
      return
    }
    if (helpOpen) {
      if (key.escape) setHelpOpen(false)
      return
    }
    // Cancel affordance for the SELECTED run: `x` arms a confirmation, then
    // `y`/Enter confirms and any other key (incl. a second `x`, Escape) dismisses.
    // Wired to the SAME path as the `run cancel <R>` CLI (onCancelRun). Intercepted
    // before the detail/filter keys so the armed prompt captures its confirming
    // keypress rather than opening the detail pane.
    if (onCancelRun !== undefined && (cancelArmed || character === "x")) {
      const decision = reduceRunCancelKey(
        { char: character, escape: key.escape === true, return: key.return === true },
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
    if (character === "g") {
      cursorController.cycleActionAndTop()
      return
    }
    if (character === "G") {
      cursorController.jumpToBottom()
      return
    }
    if (snapshot.projection === undefined) return
    // Direct status-filter toggles (user respec 2026-07-15). Pause/resume is
    // removed. `t` toggles the todo (pending) bucket, matching the pill's
    // bold-first-letter hint; individual queued rows use the truthful
    // `submitted` status introduced by the current projection contract.
    if (character === "t") toggleBucket("pending")
    if (character === "r") toggleBucket("running")
    if (character === "f") toggleBucket("failed")
    if (character === "d") toggleBucket("done")
  })

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

  const selectedRow = rows[cursor]
  const detailPr = pr ?? selectedRow?.pr
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
  // The pane title is PR-scoped (user directive 2026-07-21): it carries the
  // selected PR's linked issue beside the pr#id identity.
  const detailTitleIssue = selectedDetailIssue(allFullPrs, selectedRow?.pr, detailPr)
  const timelineColumns = queueTimelineColumns(columns, tier, detailOpen, splitRatio)
  const timelineRows = queueTimelineHeight(Math.max(0, viewportRows - 1), tier, detailOpen, splitRatio)
  const timeline =
    snapshot.projection === undefined ? (
      <QueueTimelineView
        results={snapshot.results}
        now={snapshot.now}
        columns={timelineColumns}
        nav={!helpOpen}
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={activateRow}
        listRef={timelineListRef}
      />
    ) : (
      <QueueTimelineView
        projection={snapshot.projection}
        columns={timelineColumns}
        nav={!helpOpen}
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={activateRow}
        paneChrome
        fillHeight
        availableRows={timelineRows}
        visibleBuckets={visibleBuckets}
        expandedStorms={expandedStorms}
        onToggleBucket={toggleBucket}
        listRef={timelineListRef}
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
      <Box position="relative" flexDirection="column">
        {timeline}
        {detailPr === undefined ? null : <Box marginTop={1}>{selectedDetail}</Box>}
        {helpOpen ? <QueueWatchHelp onClose={() => setHelpOpen(false)} /> : null}
      </Box>
    )
  }

  const detail = selectedDetail

  // QUEUE and DETAIL are PANES, not boxes (user directive 2026-07-16, items
  // L/M) — no surrounding rounded border; the SplitPane divider separates them.
  // QUEUE is headed by its tab-style label (rendered inside `timeline`); DETAIL
  // is headed by the selected PR's identity + ISSUE with STATUS/OUTCOME
  // right-aligned (user directive 2026-07-21 — the detail view is FOR a PR),
  // with the branch row reading directly beneath it and the run demoted to its
  // own filled-header region in the body.
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
        {...(detailTitleIssue === undefined ? {} : { issue: detailTitleIssue })}
        live
      />
      <Box flexGrow={1} minWidth={0} minHeight={0}>
        {detail}
      </Box>
    </Box>
  )
  return (
    <Box
      position="relative"
      flexDirection="column"
      width="100%"
      height="100%"
      minWidth={0}
      minHeight={0}
      userSelect="text"
    >
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
      {/* The keybinding footer was removed (user directive 2026-07-15). Bottom
          chrome is reserved for explicit state changes: run cancellation and
          a loud cursor recovery when the selected row disappears. */}
      {cancelArmed && selectedRow?.run !== undefined ? (
        <Box height={1} flexShrink={0}>
          <Text color="$fg-warning" bold>
            Cancel run {selectedRow.run}? Its PRs re-queue, not rejected. y/Enter to confirm, any other key to abort.
          </Text>
        </Box>
      ) : resolvedCursorState.notice === undefined ? null : (
        <Box height={1} flexShrink={0}>
          <Text color="$fg-warning" wrap="truncate">
            ⚠ {resolvedCursorState.notice}
          </Text>
        </Box>
      )}
      {helpOpen ? <QueueWatchHelp onClose={() => setHelpOpen(false)} /> : null}
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
