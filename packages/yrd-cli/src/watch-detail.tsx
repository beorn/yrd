/**
 * One change, opened — the operator's detail page (watch-redesign items 1–6,
 * 23–25, 29a, 31, 39), rebuilt on the queue core's `Row`:
 *
 *   ╭──────────────────────────────── RUN main#000406 ─╮   the status box IS the run:
 *   │ ✓ merged                                          │   identity on the border, no
 *   │   Merged as b234234abcde at 14:15:31.             │   title row above it (23);
 *   │   Age 34:23 · Runtime 3:45 · Wait time 0:10       │   one derivation, `clocks()`;
 *   │ ✓ typecheck  1:02                                 │   one step line per check,
 *   │ × test       0:04 — the submitter — it failed …   │   hanging glyphs (29a), the
 *   │ − lint       not run                              │   remedy on the failed one (39)
 *   ╰───────────────────────────────────────────────────╯
 *   · task/foo@abcdef012345  fix the parser                the change list (2, 24)
 *   [Changes] [✓ typecheck] [× test] [− lint]               Changes first (3); one tab per check
 *   ╭───────────────────────────────────────────────────╮   the Changes tab: one box per
 *   │ task/foo@abcdef012345                             │   change, its own header on
 *   │ fix the parser                                    │   every box (25), title, body,
 *   │ …                                                 │   HISTORY newest first, three
 *   │ 14:15 · 21m ago  merged as b234234abcde           │   METADATA groups, and the
 *   │ ISSUE  @i/10-yrd/24096                            │   `▶ Diff +A −B` fold last (31)
 *   │ ▶︎ Diff +214 −38                                   │
 *   ╰───────────────────────────────────────────────────╯
 *
 * Three rules from the operator's own spec are structural, not incidental:
 *
 * - **Checks after a failing one render NOT RUN.** The queue stops at the first
 *   check that is not a pass; leaving them off the screen let a reader believe a
 *   change had been judged by checks it never reached. `checksOf` in the core
 *   produces them; this only draws them.
 * - **The newest output is selected by default.** A reader opening a change
 *   wants the last thing that happened, not the first.
 * - **The command lives above its output, and the log path is real** — a live
 *   OSC 8 hyperlink, so it can be opened rather than retyped.
 *
 * Nothing here derives a state, opens a file or runs git: the loader made every
 * reading before this rendered, and the diff arrives through `onToggleDiff`.
 */

import { hyperlink } from "@silvery/ansi"
import { Box, MarkdownView, Pulse, ScrollArea, Tab, TabList, TabPanel, Tabs, Text } from "silvery"
import type { ChangeRecord, CheckView, Row } from "@yrd/queue-core"
import { clocks } from "@yrd/queue-core"
import { diffSummary, historyEntries, metadataGroups, metadataKeyWidth, type ChangeCommits } from "./watch-change.ts"
import { useNow } from "./watch-clock.ts"
import { clock, mediaDuration, stateColor, stateGlyph } from "./watch-format.ts"
import { MarkerRow, TitledBox } from "./watch-primitives.tsx"
import { explanationLine, headlineOf, runTitle, timingRows, type WatchRun, type WatchStep } from "./watch-run.ts"

/**
 * A check with what its log actually held. The output is read by whatever
 * loads the detail, never here; `why` carries the reason there is none, so an
 * empty pane always says what it looked for.
 */
export type CheckPanel = CheckView &
  Readonly<{
    /** What the log file held, when it could be read. */
    output?: string
    /** Why there is no output: no log path recorded, the file is not on this machine, or it could not be read. */
    why?: string
  }>

/** The diff a fold opens onto: what git printed, or why it printed nothing. */
export type DiffText = Readonly<{
  text?: string
  why?: string
}>

export type ChangeDetail = Readonly<{
  row: Row
  /** The run this detail is about, as the status box and the RUN column draw it. */
  run: WatchRun
  checks: readonly CheckPanel[]
  /** The change's own records, for HISTORY; absent when the histories were not read. */
  records?: readonly ChangeRecord[]
  /** The head commit's body, for the Changes tab. */
  body?: string
  /** What git said about the commits past the base. */
  commits?: ChangeCommits
  /** `git diff --shortstat` of base..head, for the fold's summary line. */
  diffStat?: Readonly<{ additions: number; deletions: number; files: number }>
  /** Why the git-derived parts (body, commits, diff) are absent: the object is not fetched, or git refused. */
  gitAbsent?: string
  /** Why these are the checks shown, when the declaration the change was judged by could not be read. */
  note?: string
}>

/** The tab a reader lands on: the last failed check, else the running one, else the newest output, else Changes. */
export function defaultTab(checks: readonly CheckPanel[]): string {
  const failed = checks.findLastIndex((check) => check.state === "failed" || check.state === "stuck")
  if (failed !== -1) return String(failed)
  const running = checks.findLastIndex((check) => check.state === "running")
  if (running !== -1) return String(running)
  const newestOutput = checks.findLastIndex((check) => check.output !== undefined && check.output !== "")
  if (newestOutput !== -1) return String(newestOutput)
  return CHANGES_TAB
}

/** The Changes tab's value: never a check's index. */
export const CHANGES_TAB = "changes"

/** The word a tab wears, so the strip alone says which checks were never reached. */
const STEP_GLYPH: Readonly<Record<CheckView["state"], string>> = {
  failed: "×",
  "not-run": "−",
  passed: "✓",
  running: "◉",
  stuck: "◌",
  unmeasured: "?",
}

const STEP_COLOR: Readonly<Record<CheckView["state"], string>> = {
  failed: "$fg-error",
  "not-run": "$fg-muted",
  passed: "$fg-success",
  running: "$fg-info",
  stuck: "$fg-warning",
  unmeasured: "$fg-warning",
}

export function WatchDetail({
  detail,
  joinedRun = false,
  live = true,
  selected,
  onSelect,
  diffOpen = false,
  diff,
  onToggleDiff,
}: {
  detail: ChangeDetail | undefined
  /** True when the row is one run's view of the change, not the change's current state. */
  joinedRun?: boolean
  /** False in a test or a single frame: nothing pulses. */
  live?: boolean
  /** The open tab: `CHANGES_TAB` or a check's index as a string. */
  selected?: string
  onSelect?: (value: string) => void
  diffOpen?: boolean
  diff?: DiffText
  onToggleDiff?: () => void
}) {
  if (detail === undefined) {
    return (
      <Box flexDirection="column" paddingX={1} minWidth={0}>
        <Text color="$fg-muted">no change selected</Text>
      </Box>
    )
  }
  const { row } = detail
  const tab = selected ?? defaultTab(detail.checks)
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={1}>
      {/* The status box at the VERY top, no identity row above it (items 1, 23). */}
      <RunStatusBox run={detail.run} live={live} joinedRun={joinedRun} />
      {/* The change list under it (items 2, 24): one row per change in the run. */}
      <ChangeList members={[row]} />
      <Box height={1} flexShrink={0} />
      {detail.note === undefined ? null : (
        <Text color="$fg-warning" wrap="wrap">
          {detail.note}
        </Text>
      )}
      <Tabs
        value={tab}
        onChange={(value: string) => {
          onSelect?.(value)
        }}
      >
        <TabList flexWrap="wrap">
          <Tab key={CHANGES_TAB} value={CHANGES_TAB}>
            <Text bold={tab === CHANGES_TAB}>Changes</Text>
          </Tab>
          {detail.checks.map((check, at) => (
            <Tab key={String(at)} value={String(at)}>
              <Text color={STEP_COLOR[check.state]}>
                {STEP_GLYPH[check.state]} {check.name}
                {check.phase !== undefined && detail.checks.filter((other) => other.name === check.name).length > 1
                  ? ` (${check.phase})`
                  : ""}
              </Text>
            </Tab>
          ))}
        </TabList>
        <TabPanel key={CHANGES_TAB} value={CHANGES_TAB}>
          <ScrollArea>
            <ChangeBox detail={detail} diffOpen={diffOpen} diff={diff} onToggleDiff={onToggleDiff} />
          </ScrollArea>
        </TabPanel>
        {detail.checks.map((check, at) => (
          <TabPanel key={String(at)} value={String(at)}>
            <CheckBody check={check} />
          </TabPanel>
        ))}
      </Tabs>
    </Box>
  )
}

/**
 * The status box IS the run (items 1, 39): identity on the border, headline,
 * explanation, timing, then one step line per step. It reads a `WatchRun` and
 * nothing else, so a run of another kind renders through it untouched (37m).
 */
export function RunStatusBox({
  run,
  live = true,
  joinedRun = false,
}: {
  run: WatchRun
  live?: boolean
  joinedRun?: boolean
}) {
  const now = useNow()
  const { row } = run
  const color = stateColor(row)
  const headline = headlineOf(row, joinedRun)
  const working = row.live !== undefined
  const explanation = explanationLine(row)
  const timing = timingRows(row, clocks(row, now))
  return (
    <TitledBox {...(runTitle(run) === undefined ? {} : { titleRight: runTitle(run) })} borderColor={color}>
      <MarkerRow
        marker={
          working && live ? (
            <Pulse synchronized colors={[color, "$fg-muted"]} bold flexShrink={0}>
              {stateGlyph(row)}
            </Pulse>
          ) : (
            <Text color={color} bold flexShrink={0}>
              {stateGlyph(row)}
            </Text>
          )
        }
      >
        <Text color={color} bold wrap="wrap" minWidth={0}>
          {headline}
        </Text>
      </MarkerRow>
      {explanation === undefined ? null : (
        <MarkerRow>
          <Text color={color} wrap="wrap" minWidth={0}>
            {explanation}
          </Text>
        </MarkerRow>
      )}
      {timing.map((line) => (
        <MarkerRow key={line}>
          <Text wrap="truncate">{line}</Text>
        </MarkerRow>
      ))}
      {run.steps.map((step) => (
        <StepLine key={`${step.name}@${step.state}`} step={step} live={live} />
      ))}
    </TitledBox>
  )
}

/** One step: hanging glyph, name, duration, and the remedy on a failed one (item 39). Kind-agnostic. */
function StepLine({ step, live }: { step: WatchStep; live: boolean }) {
  const color = STEP_COLOR[step.state]
  const active = step.state === "running"
  const failed = step.state === "failed" || step.state === "stuck"
  const duration = step.state === "not-run" ? "not run" : step.ms === undefined ? "" : mediaDuration(step.ms)
  return (
    <MarkerRow
      marker={
        active && live ? (
          <Pulse synchronized colors={[color, "$fg-muted"]} flexShrink={0}>
            {STEP_GLYPH[step.state]}
          </Pulse>
        ) : (
          <Text color={color} flexShrink={0}>
            {STEP_GLYPH[step.state]}
          </Text>
        )
      }
    >
      <Text wrap="wrap" minWidth={0}>
        <Text color={failed ? color : active ? "$fg-info" : undefined}>{step.name}</Text>
        {duration === "" ? null : <Text color="$fg-muted"> {duration}</Text>}
        {step.remedy === undefined ? null : <Text color={color}> — {step.remedy}</Text>}
      </Text>
    </MarkerRow>
  )
}

/** The change list under the status box (item 2): `· <branch>@<sha12> <bold subject>`, ellipsis-truncated. */
export function ChangeList({ members }: { members: readonly Row[] }) {
  if (members.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      {members.map((member) => (
        <MarkerRow key={member.head} marker={<Text flexShrink={0}>·</Text>}>
          <Box flexDirection="row" minWidth={0}>
            <Text color="$fg-warning" flexShrink={0}>
              {changeId(member)}
            </Text>
            <Text flexShrink={0}> </Text>
            <Text bold wrap="truncate" minWidth={0}>
              {member.subject ?? subjectAbsent(member)}
            </Text>
          </Box>
        </MarkerRow>
      ))}
    </Box>
  )
}

/** The change's id as a reader types it: `<branch>@<sha12>`, the change ref's own name, shortened. */
export function changeId(row: Pick<Row, "branch" | "head">): string {
  return `${row.branch}@${row.head.slice(0, 12)}`
}

/** What stands where a subject would, when the head is not in this repository: said, never blank. */
function subjectAbsent(row: Pick<Row, "state">): string {
  return row.state === "direct" ? "" : "(subject not fetched: the head is not in this repository)"
}

/**
 * The Changes tab: one bordered box per change, EVERY box carrying its own
 * header (item 25) — header, bold title, body, HISTORY, METADATA, the diff
 * fold last (items 4, 31).
 */
function ChangeBox({
  detail,
  diffOpen,
  diff,
  onToggleDiff,
}: {
  detail: ChangeDetail
  diffOpen: boolean
  diff: DiffText | undefined
  onToggleDiff: (() => void) | undefined
}) {
  const now = useNow()
  const { row } = detail
  const history = detail.records === undefined ? undefined : historyEntries(detail.records)
  const groups = metadataGroups(row, now, {
    ...(detail.commits === undefined ? {} : { commits: detail.commits }),
    ...(detail.run.id === undefined ? {} : { runId: detail.run.id }),
  })
  const keyWidth = metadataKeyWidth(groups)
  return (
    <TitledBox>
      <Text color="$fg-warning" wrap="truncate">
        {changeId(row)}
      </Text>
      <Box height={1} flexShrink={0} />
      <Text bold wrap="wrap">
        {row.subject ?? subjectAbsent(row)}
      </Text>
      {detail.body === undefined || detail.body.trim() === "" ? null : <MarkdownView source={detail.body} />}
      {history === undefined ? null : (
        <>
          <Box height={1} flexShrink={0} />
          {history.length === 0 ? (
            <Text color="$fg-muted">no records were read for this change</Text>
          ) : (
            history.map((entry) => (
              <Box key={`${entry.at.toISOString()} ${entry.text}`} flexDirection="row" minWidth={0}>
                <Text color="$fg-muted" flexShrink={0}>
                  {clock(entry.at)} · {mediaDuration(now.getTime() - entry.at.getTime())} ago{"  "}
                </Text>
                <Text wrap="wrap" minWidth={0}>
                  {entry.text}
                  {entry.detail === undefined ? "" : ` — ${entry.detail}`}
                </Text>
              </Box>
            ))
          )}
        </>
      )}
      {groups.map((group, index) => (
        <Box key={String(index)} flexDirection="column" minWidth={0}>
          <Box height={1} flexShrink={0} />
          {group.map((fact) => (
            <Box key={fact.key} flexDirection="row" minWidth={0}>
              <Text color="$fg-muted" flexShrink={0}>
                {fact.key.padEnd(keyWidth)}
              </Text>
              <Text wrap="truncate" minWidth={0}>
                {fact.value}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {detail.gitAbsent === undefined ? null : (
        <>
          <Box height={1} flexShrink={0} />
          <Text color="$fg-muted" wrap="wrap">
            {detail.gitAbsent}
          </Text>
        </>
      )}
      {detail.diffStat === undefined ? null : (
        <DiffFold stat={detail.diffStat} open={diffOpen} diff={diff} onToggle={onToggleDiff} />
      )}
    </TitledBox>
  )
}

/**
 * The fold at the bottom of every change box: `▶︎ Diff +A −B`, opening onto
 * the unified diff. A composition of Box and Text rather than silvery's
 * `Accordion`, whose header draws ASCII `>`/`v` and takes no glyph: the plain
 * triangle is item 5's rule, and a glyph prop on `Accordion` is the upstream
 * home this collapses into. Click or `v` toggles; the reading is the loader's.
 */
function DiffFold({
  stat,
  open,
  diff,
  onToggle,
}: {
  stat: Readonly<{ additions: number; deletions: number; files: number }>
  open: boolean
  diff: DiffText | undefined
  onToggle: (() => void) | undefined
}) {
  return (
    <Box flexDirection="column" minWidth={0}>
      <Box height={1} flexShrink={0} />
      <Box flexDirection="row" minWidth={0} onClick={onToggle}>
        <Text wrap="truncate">
          {diffSummary(stat, open)}
          <Text color="$fg-muted">
            {" "}
            · {String(stat.files)} {stat.files === 1 ? "file" : "files"} · v toggles
          </Text>
        </Text>
      </Box>
      {!open ? null : diff === undefined ? (
        <Text color="$fg-muted">reading the diff…</Text>
      ) : diff.text === undefined ? (
        <Text color="$fg-muted" wrap="wrap">
          {diff.why ?? "no diff was read"}
        </Text>
      ) : (
        diff.text.split("\n").map((line, index) => (
          <Text key={String(index)} color={diffLineColor(line)} wrap="wrap">
            {line === "" ? " " : line}
          </Text>
        ))
      )}
    </Box>
  )
}

/** Added lines green, removed lines red, hunk and file headers muted, context plain — the ag-code idiom. */
function diffLineColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "$fg-muted"
  }
  if (line.startsWith("@@")) return "$fg-info"
  if (line.startsWith("+")) return "$fg-success"
  if (line.startsWith("-")) return "$fg-error"
  return undefined
}

/** One check: its command, then the real log path, then the output itself. */
function CheckBody({ check }: { check: CheckPanel }) {
  const exit = check.result?.exit === undefined ? "" : ` exit=${check.result.exit}`
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {/* The command, ABOVE its output (S2.21). A check the declaration no
          longer names has no command to show and says so, rather than
          rendering an empty prompt that reads as a command that did nothing. */}
      {check.spec === undefined ? (
        <Text color="$fg-muted" wrap="wrap">
          {check.name === "setup"
            ? "the target's setup command, run once in the fresh worktree before any check"
            : "the declaration this change was judged by does not name this check"}
        </Text>
      ) : (
        <MarkerRow marker={<Text color="$fg-info">$</Text>}>
          <Text wrap="wrap" minWidth={0}>
            {check.spec.run}
          </Text>
        </MarkerRow>
      )}
      <MarkerRow>
        <Text color="$fg-muted" wrap="truncate">
          {check.state === "not-run"
            ? "NOT RUN"
            : check.state === "unmeasured"
              ? "unmeasured — no result recorded"
              : check.state}
          {exit}
          {check.result?.ms === undefined ? "" : ` ${mediaDuration(check.result.ms)}`}
        </Text>
      </MarkerRow>
      {/* The REAL path, as a link that opens it (S2.21). A path we do not have
          is absent, never a link to nowhere. */}
      {check.log === undefined ? null : (
        <MarkerRow>
          <Text color="$fg-muted" wrap="truncate">
            {hyperlink(check.log, pathUrl(check.log))}
          </Text>
        </MarkerRow>
      )}
      {check.output === undefined || check.output === "" ? (
        <MarkerRow>
          <Text color="$fg-muted" wrap="wrap">
            {check.why ?? "no output was read"}
          </Text>
        </MarkerRow>
      ) : (
        <ScrollArea>
          <Text>{check.output}</Text>
        </ScrollArea>
      )}
    </Box>
  )
}

/** A local path as a URL an OSC 8 link can carry. */
function pathUrl(path: string): string {
  return `file://${path}`
}
