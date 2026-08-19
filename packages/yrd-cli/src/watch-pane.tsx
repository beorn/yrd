import { pathToFileURL } from "node:url"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Box,
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
import { formatChangeRevisionSelector, changeRevisionNumber, type BaysState, type PR } from "@yrd/bay"
import type { QueueAuditFinding } from "@yrd/queue"
import {
  QUEUE_TIMELINE_STATUS_BUCKETS,
  QueueDetailChangeList,
  QueueTopLine,
  QueueDetailRunChangeBlocks,
  QueueShowView,
  queueRunStepFacts,
  QueueStatusNotice,
  QueueTimelineView,
  queueShowData,
  queueTimelineDisplayRows,
  queueTimelineFilterBuckets,
  queueTimelineRows,
  queueTimelineVisibleDefaultCursorId,
  queueTimelineVisibleRows,
  type QueueShowData,
  type QueueRunnerRefusal,
  type QueueStatusResult,
  type QueueTimelineProjection,
  type QueueTimelineProjectedRow,
  type QueueTimelineStatusBucket,
} from "./queue-status-view.tsx"
import { timelineStatusGlyph } from "./runner-timeline.ts"
import { statusPresentation } from "./status-presentation.ts"
import { reduceRunCancelKey } from "./watch-cancel.ts"
import { queueReadFailureMessage, type QueueReadFailure } from "./queue-read-failure.ts"

const LIST_NATURAL_WIDTH = 80
const DETAIL_NATURAL_WIDTH = 72
// This compact primary height reserves the queue title, runner, filter, table
// header, and useful data rows. The taller calendar STATS panel has its
// own responsive height gate and is omitted when a split only fits this floor.
const LIST_NATURAL_HEIGHT = 19
const DETAIL_NATURAL_HEIGHT = 12
const DIVIDER_SIZE = 1
const DEFAULT_SPLIT_RATIO = 0.52
const QUEUE_PANE_PADDING_X = 1
// Fixed-height chrome OUTSIDE the QUEUE/DETAIL split: the top line (item 12,
// always present) plus the footer's reserved row (present or not, so a
// notice appearing never reflows the panes above it). Both are `height={1}`
// siblings of the split; every viewport-row budget below subtracts this
// count up front rather than each caller guessing its own "-1"/"-2".
const QUEUE_WATCH_CHROME_ROWS = 2

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

export type QueueChangeDiff =
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
  /** Absolute repository authority whose Journal this snapshot projects. */
  repositoryRoot?: string
  results: readonly QueueStatusResult[]
  state?: BaysState
  now: number
  projection?: QueueTimelineProjection
  runnerRefusal?: QueueRunnerRefusal
  /** A bounded read could not make the Journal and derived attempt view agree.
   * The frame remains usable on named partial or last-complete data. */
  readFailure?: QueueReadFailure
  outputs?: readonly QueueArtifactOutput[]
  /** Revision-bound source deltas shown in the PR-scoped detail header. */
  diffs?: readonly QueueChangeDiff[]
  /** Resolved project commands for the live step headers. */
  commands?: Readonly<Record<string, string>>
  /** `draft-stranded` findings old enough to page (`.yrd.yml`
   * `drafts.pageAfterHours`) — a visible row, never only a `queue audit`
   * record nobody ran. Absent/empty both mean "no stale drafts"; the pane
   * never distinguishes not-yet-measured from measured-and-clean here, unlike
   * the resident status file, because a live watch snapshot always measures. */
  staleDrafts?: readonly QueueAuditFinding[]
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
  const revision = projectedRow?.revision ?? (pr === undefined ? undefined : changeRevisionNumber(pr))
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
            key: `${outputKey}:row:${index}`,
            text,
            kind: "body" as const,
          }))),
    ] satisfies readonly QueueArtifactOutputLine[]
  })
}

function QueueArtifactOutputList({ outputs, inline }: { outputs: readonly QueueArtifactOutput[]; inline: boolean }) {
  const listRef = useRef<ListViewHandle | null>(null)
  const [atEnd, setAtEnd] = useState(true)
  const [unseenRows, setUnseenRows] = useState(0)
  const rows = useMemo(() => queueArtifactOutputLines(outputs, inline), [inline, outputs])
  const previousRowCount = useRef(rows.length)

  useEffect(() => {
    const addedRows = Math.max(0, rows.length - previousRowCount.current)
    previousRowCount.current = rows.length
    if (atEnd) setUnseenRows(0)
    else if (addedRows > 0) setUnseenRows((count) => count + addedRows)
  }, [atEnd, rows.length])

  // Reassert the tail after new output is committed. ListView's follow
  // authority observes the prior viewport during the same render; without
  // this post-commit scroll, an End-resumed pane can miss the next append.
  useEffect(() => {
    if (atEnd) listRef.current?.scrollToBottom()
  }, [atEnd, rows.length])

  useInput((_input, key) => {
    if (!key.end) return
    listRef.current?.scrollToBottom()
    setAtEnd(true)
    setUnseenRows(0)
  })

  if (rows.length === 0) return null
  const followStatus = atEnd
    ? "FOLLOWING END"
    : `FOLLOW PAUSED${
        unseenRows === 0 ? "" : ` | ${unseenRows} new ${unseenRows === 1 ? "row" : "rows"}`
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
        items={rows}
        getKey={(row) => row.key}
        follow="end"
        onAtBottomChange={(nextAtEnd) => {
          setAtEnd(nextAtEnd)
          if (nextAtEnd) setUnseenRows(0)
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
              // few long records can't fill the pane; "open full log" is the escape
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

/** The collapsed command block shows at most this many trailing output rows. */
const COMMAND_OUTPUT_TAIL_LINES = 10

/**
 * Tab 0 is a synthetic PR/submission overview (user directive 2026-07-21,
 * restoring it): PR facts + changed files + diff. The sentinel id has a
 * leading space so it cannot collide with a real step name (step names are
 * bare identifiers like `check`/`merge`, never space-prefixed). Labeled
 * "Changes" (operator spec item 3, renamed from "PR"); the id below is
 * unaffected — nothing outside this file's tab plumbing reads the label text.
 */
const PR_TAB_ID = "\u0000pr"
const PR_TAB_LABEL = "Changes"

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
        // One terminal row per log record (truncate, never wrap) — the 21684
        // contract; the full-log link carries overflow while preserving scan stability.
        <Text color="$fg-muted" bgConflict="ignore" wrap="truncate" minWidth={0}>
          {row.text === "" ? " " : row.text}
        </Text>
      )}
    </Box>
  )
}

/** Step output is static inside the single scroll owner shared by its tab. */
export function QueueInlineArtifactOutputRows({ outputs }: { outputs: readonly QueueArtifactOutput[] }) {
  const rows = useMemo(() => queueArtifactOutputLines(outputs, true), [outputs])
  if (rows.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {rows.map((row) => (
        <Box key={row.key} minWidth={0}>
          {row.kind === "link" ? (
            <Link href={row.href}>{row.text}</Link>
          ) : (
            // One terminal row per log record (truncate, never wrap) — see the
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
 * tail window — the last {@link COMMAND_OUTPUT_TAIL_LINES} rows scrolling by
 * live — and clicking the block toggles the full log. A step's command list
 * is never buried by one command's output. Proof-link and truncation rows
 * stay pinned above the window.
 */
export function QueueCommandExecutionBlock({
  command,
  outputs,
}: {
  command?: string
  outputs: readonly QueueArtifactOutput[]
}) {
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded((current) => !current)
  const rows = useMemo(() => queueArtifactOutputLines(outputs, true), [outputs])
  const chrome = rows.filter((row) => row.kind !== "body")
  const body = rows.filter((row) => row.kind === "body")
  const visibleBody = expanded ? body : body.slice(-COMMAND_OUTPUT_TAIL_LINES)
  const hidden = body.length - visibleBody.length
  const hiddenUnit = hidden === 1 ? ["li", "ne"].join("") : ["li", "nes"].join("")
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
            … {hidden} earlier {hiddenUnit} — click to expand
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

/**
 * One change's diff, folded by default (operator spec item 4: "diff lines
 * fronted by a folding triangle marker (▶ collapsed, ▼ expanded), the way
 * `ag code` does it"). silvery ships the ▶/▼ disclosure convention itself
 * (TreeView's expand/collapse); this stays a lighter, purpose-built toggle —
 * one diff, no tree — rather than reimplementing that primitive for a single
 * node, but borrows its exact glyphs and its click/Enter/Space activation.
 * State is owned here (not by the caller) so each change's box in the
 * Changes tab folds independently of its siblings.
 */
function QueueChangeDiffView({ diff }: { diff: QueueChangeDiff | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const onToggle = () => setExpanded((current) => !current)
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
        <Text color="$fg-muted">
          {diff === undefined || diff.unavailable === "refs-pruned"
            ? "diff unavailable (refs pruned)"
            : "diff unavailable (git error)"}
        </Text>
      </Box>
    )
  }
  const summary = `Diff +${diff.additions} −${diff.deletions}`
  // Plain triangles (operator ruling 2026-08-18, item 31: no emoji
  // presentation selector). Silvery emoji-presents a bare U+25B6 — appending
  // VS16 and rendering the blue play button — so the TEXT presentation
  // selector (U+FE0E) pins the plain glyph the ruling asks for.
  const fold = expanded ? "▼\uFE0E" : "▶\uFE0E"
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
          {fold} {summary}
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
          {diff.patch.split("\n").map((patchRow, index) => (
            <Text key={`patch:${index}`} color="$fg-muted" bgConflict="ignore" wrap="wrap">
              {patchRow === "" ? " " : patchRow}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  )
}

/**
 * The Changes-tab / pre-run body (user directive 2026-07-21; expanded by
 * operator spec item 4 from "the selected member only" to every member of
 * the run): each batched PR gets its own box via QueueDetailRunPrBlocks,
 * complete with its own diff. Only the member matching the pane's own title
 * row skips its identity line — every other member still needs one, since
 * the title above shows just the one PR the cursor is on.
 */
function QueueDetailChangeSection({
  data,
  row,
  rows,
  prs,
  runDetails,
  diffs,
  showFacts = true,
  showDiff = true,
}: {
  data?: QueueShowData
  row?: QueueTimelineProjectedRow
  rows: readonly QueueTimelineProjectedRow[]
  prs: readonly PR[]
  runDetails: readonly QueueShowData[]
  diffs: readonly QueueChangeDiff[]
  showFacts?: boolean
  showDiff?: boolean
}) {
  return (
    <Box flexDirection="column" minWidth={0} flexShrink={0}>
      {showFacts ? (
        <QueueDetailRunChangeBlocks
          {...(data === undefined ? {} : { data })}
          {...(row === undefined ? {} : { row })}
          rows={rows}
          prs={prs}
          runDetails={runDetails}
          {...(row?.position === undefined ? {} : { position: row.position })}
          {...(showDiff
            ? {
                renderDiff: (member: Readonly<{ id: string; revision: number }>) => (
                  <QueueChangeDiffView
                    diff={diffs.find((candidate) => candidate.pr === member.id && candidate.revision === member.revision)}
                  />
                ),
              }
            : {})}
        />
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
  runLabel,
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
  diffs?: readonly QueueChangeDiff[]
  /** The run's queue label for the status box border (item 39). */
  runLabel?: string
}) {
  const names = useMemo(() => (data === undefined ? [] : queueStepNames(data)), [data])
  // The PR/submission overview remains tab 0, ahead of the real step tabs.
  // Default selection follows the failing/live step, then the newest recorded
  // output or terminal step. Operator selection overrides it; the parent
  // remounts on run change, resetting that override.
  const tabNames = useMemo(() => (data === undefined ? [] : [PR_TAB_ID, ...names]), [data, names])
  const liveStep = data === undefined ? undefined : queueDefaultStepTab(data, outputs)
  const [userSelectedStep, setUserSelectedStep] = useState<string | null>(null)
  const activeStep = resolveStepTabSelection(tabNames, liveStep, userSelectedStep)

  // ONE derivation feeds the status box's step lines AND these tab labels
  // (operator ruling 2026-08-18, item 39) — glyph, status word, and duration
  // can never disagree between the two surfaces.
  const stepFacts = useMemo(() => (data === undefined ? [] : queueRunStepFacts(data)), [data])
  const stepFactByName = useMemo(() => new Map(stepFacts.map((fact) => [fact.step, fact])), [stepFacts])
  // Round 6 tabs are two-row, equally measured segments. Both active and
  // inactive states are filled, and no flex growth may stretch them past the
  // widest title/status+duration content.
  const stepTabWidth =
    data === undefined
      ? 0
      : Math.max(
          1,
          PR_TAB_LABEL.length,
          ...names.map((name) => {
            const fact = stepFactByName.get(name)
            const duration = fact?.duration ?? ""
            return Math.max(
              `${names.indexOf(name) + 1}: ${name}`.length,
              `${fact?.glyph ?? ""} ${fact?.status ?? ""}${duration === "" ? "" : ` ${duration}`}`.length,
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
    if (data === undefined) return name
    const fact = stepFactByName.get(name)
    if (fact === undefined) return name
    const duration = fact.duration
    const number = names.indexOf(name) + 1
    const status = `${fact.glyph} ${fact.status}`
    const remainder = Math.max(0, stepTabWidth - status.length - (duration === "" ? 0 : duration.length + 1))
    return (
      <Text color={selected ? "$fg-on-selected" : undefined}>
        {`${number}: ${name}`.padEnd(stepTabWidth)}
        {"\n"}
        <Text color={selected ? "$fg-on-selected" : fact.color} bold={fact.active}>
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
    // Detail order: one persistent status box (RUN identity/timing folded
    // into its border/body — operator spec item 1), then the run's PR list
    // (item 2), then the Changes tab and real workflow-step tabs. The newest
    // relevant step is selected automatically; the Changes tab remains
    // available for source facts.
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {data === undefined ? (
        <>
          <QueueStatusNotice
            {...(row === undefined ? {} : { row })}
            runDetails={runDetails}
            live={active}
            {...(runLabel === undefined ? {} : { runLabel })}
          />
          <QueueDetailChangeList data={data} rows={runRows} prs={prs} />
          <QueueDetailChangeSection
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
          <QueueStatusNotice
            {...(row === undefined ? {} : { row })}
            data={data}
            runDetails={runDetails}
            live={active}
            {...(runLabel === undefined ? {} : { runLabel })}
          />
          <QueueDetailChangeList data={data} rows={runRows} prs={prs} />
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
                <QueueDetailChangeSection
                  data={data}
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
              const stepRows = data.steps.filter((row) => row.step === name)
              const stepOutputs = outputs.filter((output) => output.step === name)
              const stepData: QueueShowData = { ...data, steps: stepRows }
              // The job input is durable proof of what this run actually executed;
              // current config is only a preview for a step that has no job yet.
              const executions = queueStepExecutions({ data, name, stepRows, stepOutputs, commands })
              return (
                <TabPanel key={name} value={name}>
                  <QueueTabScrollArea followEnd>
                    <QueueShowView
                      data={data}
                      compact={compact}
                      highlightPr={highlightPr}
                      section="run"
                      titleAbove
                      showMembers={data.prs.length > 1}
                      showIntegration={false}
                      showFailureDetails={false}
                    />
                    <Box height={1} flexShrink={0} />
                    <QueueShowView
                      data={stepData}
                      compact={compact}
                      highlightPr={highlightPr}
                      section="steps"
                      showLogArtifacts
                      showFailureDetails={false}
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
  return formatChangeRevisionSelector(row.pr, row.revision)
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
  return (
    firstRunningCursorRow(rows, runningRunOrder) ??
    rows.find((row) => row.status === "ready" || row.status === "pending")
  )
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
  ["1 - 9", "toggle a queue's pill on / off"],
  ["a", "everything on — every queue, every status"],
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

/** One footer-width line for however many page-worthy stale drafts the
 * snapshot carries: the oldest (first — `staleDraftFindings` filters, never
 * reorders, so array order is audit order) leads with its owner, and the rest
 * collapse to a count rather than truncating mid-list. Undefined for none,
 * matching every other footer notice's absent-means-nothing contract. */
function staleDraftFooterNotice(findings: readonly QueueAuditFinding[]): string | undefined {
  const [first, ...rest] = findings
  if (first === undefined) return undefined
  const owner = first.submitter === undefined ? "no recorded owner" : first.submitter
  const pr = first.pr === undefined ? "a draft" : `PR ${first.pr}`
  const more = rest.length === 0 ? "" : `, +${rest.length} more`
  return `${pr} stranded (owner=${owner}${more}) — yrd queue audit for detail, yrd pr submit or withdraw to clear`
}

function QueueWatchFooter({
  cancelArmed,
  selectedRun,
  readFailure,
  cursorNotice,
  staleDrafts,
}: Readonly<{
  cancelArmed: boolean
  selectedRun?: string
  readFailure?: QueueReadFailure
  cursorNotice?: string
  staleDrafts?: readonly QueueAuditFinding[]
}>) {
  if (cancelArmed && selectedRun !== undefined) {
    return (
      <Box height={1} flexShrink={0}>
        <Text color="$fg-warning" bold>
          Cancel run {selectedRun}? Its PRs re-queue, not rejected. y/Enter to confirm, any other key to abort.
        </Text>
      </Box>
    )
  }
  // Priority, highest first: an active read failure is a broken surface right
  // now; a cursor notice means the row the operator was on just disappeared,
  // both more urgent than a background fact that has been true for hours by
  // the time it can appear here at all (drafts.pageAfterHours, default 4h).
  const notice =
    readFailure === undefined
      ? (cursorNotice ?? staleDraftFooterNotice(staleDrafts ?? []))
      : queueReadFailureMessage(readFailure, true)
  if (notice === undefined) return null
  return (
    <Box height={1} flexShrink={0}>
      <Text color="$fg-warning" wrap="truncate">
        ⚠ {notice}
      </Text>
    </Box>
  )
}

/**
 * The watch frame's own top line (operator rulings 2026-08-18, items
 * 30/32/32b/33): `YRD QUEUES` plus the queue pills — the whole queue chrome
 * in one row. The pills carry each queue's digit accelerator, config handle,
 * and pretty `path ⎇ branch` identity, so the old right-aligned `for /hh`
 * half (item 12) and the `QUEUE main ROOT /hh` header row below it are both
 * gone: the identity they carried lives ON the pills now (item 32b dropped
 * the address side as redundant). Sits above both the QUEUE and DETAIL panes
 * since it identifies the whole frame; renders before the first projection
 * loads (title only) so it never flashes in partway.
 */
function QueueWatchTopLine({
  snapshot,
  visibleQueues,
  onToggleQueue,
  onShowAll,
  allActive,
}: Readonly<{
  snapshot: QueueWatchSnapshot
  visibleQueues: ReadonlySet<string>
  onToggleQueue: (base: string) => void
  onShowAll: () => void
  allActive: boolean
}>) {
  // A projection built before the loader threaded repositoryRoot still has
  // the snapshot-level root; pills prefer the queue's own path and fall back
  // to it, so the identity pair renders whenever either layer knows it.
  const queues = (snapshot.projection?.queues ?? []).map((queue) =>
    queue.path === undefined && snapshot.repositoryRoot !== undefined
      ? { ...queue, path: snapshot.repositoryRoot }
      : queue,
  )
  return (
    <QueueTopLine
      queues={queues}
      visibleQueues={visibleQueues}
      onToggleQueue={onToggleQueue}
      onShowAll={onShowAll}
      allActive={allActive}
    />
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
  const tier = queueDetailTier(columns, Math.max(0, viewportRows - QUEUE_WATCH_CHROME_ROWS))
  // The four operator buckets (user respec 2026-07-23): lowercase o/r/d/f and
  // pill clicks select one court, `a` restores all, and uppercase O/R/D/F
  // toggles individual membership. Initial visibility mirrors the CLI-level
  // --status filters.
  const [visibleBuckets, setVisibleBuckets] = useState<ReadonlySet<QueueTimelineStatusBucket>>(() =>
    snapshot.projection === undefined
      ? new Set(QUEUE_TIMELINE_STATUS_BUCKETS)
      : queueTimelineFilterBuckets(snapshot.projection.filters.statuses),
  )
  // Queues are ON/OFF filters (operator ruling 2026-08-18, item 32,
  // restoring the 2026-08-13 toggle): every queue is shown by default and a
  // digit or pill click TOGGLES that queue's membership. `undefined` means no
  // filter is active — every queue this projection currently has, tracked
  // dynamically — while a concrete Set is a specific choice pinned to those
  // bases, so a snapshot that relabels (a queue appears or drains away)
  // cannot silently move the operator's choice onto a different queue. A
  // toggle that lands back on the full set collapses to `undefined` so the
  // dynamic default resumes.
  const [shownQueues, setShownQueues] = useState<ReadonlySet<string> | undefined>(undefined)
  const queues = snapshot.projection?.queues
  const visibleQueues = useMemo(
    () => new Set(shownQueues === undefined ? (queues ?? []).map(({ base }) => base) : shownQueues),
    [queues, shownQueues],
  )
  const toggleQueue = (base: string): void => {
    setShownQueues((current) => {
      const everyBase = (queues ?? []).map((queue) => queue.base)
      const next = new Set(current ?? everyBase)
      if (next.has(base)) next.delete(base)
      else next.add(base)
      return everyBase.length > 0 && everyBase.every((candidate) => next.has(candidate)) ? undefined : next
    })
  }
  const showAllQueues = (): void => {
    setShownQueues(undefined)
  }
  const [expandedStorms, setExpandedStorms] = useState<ReadonlySet<string>>(() => new Set())
  const selectOnlyBucket = (bucket: QueueTimelineStatusBucket): void => {
    setVisibleBuckets(new Set([bucket]))
  }
  // `a` clears BOTH filter kinds together, which otherwise operate
  // independently (item 9) — the one keystroke/pill that resets the whole
  // filter row back to its unfiltered default.
  const showAll = (): void => {
    setVisibleBuckets(new Set(QUEUE_TIMELINE_STATUS_BUCKETS))
    showAllQueues()
  }
  // The `all` pill reads "on" only when NEITHER filter kind is narrowed —
  // it clears both at once, so it only lights when both already show
  // everything (item 32; the rule the bottom row's centered pill carried).
  const allFiltersActive =
    QUEUE_TIMELINE_STATUS_BUCKETS.every((bucket) => visibleBuckets.has(bucket)) &&
    (queues ?? []).every(({ base }) => visibleQueues.has(base))
  const toggleBucket = (bucket: QueueTimelineStatusBucket): void => {
    setVisibleBuckets((current) => {
      const next = new Set(current)
      if (next.has(bucket)) next.delete(bucket)
      else next.add(bucket)
      return next
    })
  }
  // The interactive pane renders fill-height (below), so the cursor set is the
  // uncapped fill set — the ListView receives every retained row and mounts a
  // bounded index window of them (virtualization="index"; the mount-all
  // DEFAULT silently applied here after the 15332 W7 threshold raise and cost
  // ~260 KB RSS + ~2 idle-CPU points per 100 retained rows — @yrd/cli/22258).
  // Cursor indices index THIS array, so it must match the ListView's items.
  const visibleProjectedRows = useMemo(
    () =>
      snapshot.projection === undefined
        ? undefined
        : queueTimelineVisibleRows(snapshot.projection, visibleBuckets, true, visibleQueues),
    [snapshot.projection, visibleBuckets, visibleQueues],
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
      : queueTimelineVisibleDefaultCursorId(snapshot.projection, visibleBuckets, true, visibleQueues)
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
    // Status-filter keys (user respec 2026-07-23). Lowercase o/r/d/f selects
    // ONLY that bucket (the advertised default), `a` restores all buckets, and
    // capital O/R/D/F toggles one bucket's membership (power path,
    // unadvertised). Pause/resume remains removed.
    if (character === "o") selectOnlyBucket("open")
    if (character === "r") selectOnlyBucket("running")
    if (character === "d") selectOnlyBucket("done")
    if (character === "f") selectOnlyBucket("failed")
    if (character === "a") showAll()
    // 1..9 TOGGLE that queue by its pill digit (item 32 — the toggle idiom
    // restored; digits are filter accelerators, never names). Only digits
    // this projection actually has respond, so a stray digit is inert.
    if (/^[1-9]$/u.test(character)) {
      const queue = snapshot.projection.queues.find(({ label }) => label === Number(character))
      if (queue !== undefined) toggleQueue(queue.base)
      return
    }
    if (character === "O") toggleBucket("open")
    if (character === "R") toggleBucket("running")
    if (character === "D") toggleBucket("done")
    if (character === "F") toggleBucket("failed")
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
  // Every Run's detail projection, and it depends on nothing but the snapshot.
  // Unmemoized it was rebuilt on EVERY render — so moving the cursor, which only
  // changes which row is highlighted, re-derived the whole queue's details. That
  // is the per-keypress cost the operator feels; `queueShowData` is O(runs) per
  // Run, so the rebuild is quadratic in queue size. A new snapshot arrives per
  // watch tick, which is when this legitimately has to run again.
  const detailRunDetails = useMemo(
    () =>
      snapshot.results.flatMap((result) => {
        const runs = [...result.running, ...result.waiting, ...result.finished]
        return runs.map((run) => queueShowData(run, runs))
      }),
    [snapshot.results],
  )
  const detailMemberIds = new Set(
    detailData?.prs.map((member) => member.id) ?? (detailPr === undefined ? [] : [detailPr]),
  )
  const detailFullPrs = allFullPrs.filter((candidate) => detailMemberIds.has(candidate.id))
  // The status box border leads with the queue's config handle (item 36's
  // label-primary run naming), base branch when none is declared.
  const detailQueueBase = detailData?.base ?? selectedProjectedRow?.base
  const detailQueue = snapshot.projection?.queues.find((queue) => queue.base === detailQueueBase)
  const detailRunLabel = detailQueue === undefined ? detailQueueBase : (detailQueue.name ?? detailQueue.base)
  const timelineOuterColumns = queueTimelineColumns(columns, tier, detailOpen, splitRatio)
  const timelineColumns =
    snapshot.projection === undefined
      ? timelineOuterColumns
      : Math.max(0, timelineOuterColumns - 2 * QUEUE_PANE_PADDING_X)
  const timelineRows = queueTimelineHeight(Math.max(0, viewportRows - QUEUE_WATCH_CHROME_ROWS), tier, detailOpen, splitRatio)
  const timeline =
    snapshot.projection === undefined ? (
      <QueueTimelineView
        repositoryRoot={snapshot.repositoryRoot}
        results={snapshot.results}
        state={snapshot.state}
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
        repositoryRoot={snapshot.repositoryRoot}
        projection={snapshot.projection}
        runnerRefusal={snapshot.runnerRefusal}
        results={snapshot.results}
        state={snapshot.state}
        columns={timelineColumns}
        nav={!helpOpen}
        cursorKey={cursor}
        onCursor={selectRow}
        onSelect={activateRow}
        paneChrome
        fillHeight
        availableRows={timelineRows}
        visibleBuckets={visibleBuckets}
        visibleQueues={visibleQueues}
        expandedStorms={expandedStorms}
        onSelectBucket={selectOnlyBucket}
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
          {...(detailRunLabel === undefined ? {} : { runLabel: detailRunLabel })}
        />
      </Box>
    )
  if (snapshot.projection === undefined) {
    return (
      <Box position="relative" flexDirection="column">
        <QueueWatchTopLine
          snapshot={snapshot}
          visibleQueues={visibleQueues}
          onToggleQueue={toggleQueue}
          onShowAll={showAll}
          allActive={allFiltersActive}
        />
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
  // is headed by the selected PR's identity + ISSUE (the detail view is FOR a
  // PR), with the branch row directly beneath it and run identity/status owned
  // by the composite header and outlined notice in the body.
  // One cell of horizontal padding keeps content off the
  // pane edge; the title sits flush at the top.
  const framedTimeline = (
    // The QUEUE pane is its own selection scope (item 4a): a drag started here
    // resolves to this Box as the nearest `contain` boundary, so it never grows
    // across the SplitPane divider into the DETAIL pane. `contain` keeps the
    // rows selectable while bounding the range; the STATUS/STATS boxes nest
    // their own tighter scopes inside it.
    <Box
      flexDirection="column"
      width="100%"
      height="100%"
      minWidth={0}
      minHeight={0}
      paddingX={QUEUE_PANE_PADDING_X}
      userSelect="contain"
    >
      {timeline}
    </Box>
  )
  const framedDetail = (
    // The DETAIL pane is its own selection scope (item 4a): a drag inside the
    // detail body resolves to this Box as the nearest `contain` boundary, so it
    // cannot grow back across the divider into the QUEUE pane.
    <Box
      flexDirection="column"
      width="100%"
      height="100%"
      minWidth={0}
      minHeight={0}
      paddingX={QUEUE_PANE_PADDING_X}
      userSelect="contain"
    >
      {/* No identity title row (operator ruling 2026-08-18, item 23): the
          pane's top is the RUN status box itself, rendered by the detail
          body; each member box beneath carries its own identity header. */}
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
      <QueueWatchTopLine
        snapshot={snapshot}
        visibleQueues={visibleQueues}
        onToggleQueue={toggleQueue}
        onShowAll={showAll}
        allActive={allFiltersActive}
      />
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
          chrome is reserved for explicit state changes: run cancellation, a
          loud cursor recovery when the selected row disappears, and — lowest
          priority, since it is a background fact rather than something this
          render just did — a page-worthy stale draft. */}
      <QueueWatchFooter
        cancelArmed={cancelArmed}
        {...(selectedRow?.run === undefined ? {} : { selectedRun: selectedRow.run })}
        {...(snapshot.readFailure === undefined ? {} : { readFailure: snapshot.readFailure })}
        {...(resolvedCursorState.notice === undefined ? {} : { cursorNotice: resolvedCursorState.notice })}
        {...(snapshot.staleDrafts === undefined ? {} : { staleDrafts: snapshot.staleDrafts })}
      />
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
