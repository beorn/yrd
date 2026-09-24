/**
 * One change, opened — the operator's detail page (watch-redesign items 1–6,
 * 23–25, 29a, 31, 39), rebuilt on the queue core's `Row`:
 *
 *   ╭──────────────────────────────── RUN main#000406 ─╮   the status box IS the run:
 *   │ ✓ merged                                          │   identity on the border, no
 *   │   Merged as b234234abcde at 14:15:31.             │   title row above it (23);
 *   │   took 34:23 · runtime 3:45                       │   the table cell's duration;
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
import { Box, ScrollArea, Tab, TabList, TabPanel, Tabs, Text } from "silvery"
import type { ChangeRecord, CheckView, JournalRun, Row } from "@yrd/queue-core"
import type { Event } from "@yrd/queue-core"
import {
  diffSummary,
  eventHistoryEntries,
  historyEntries,
  metadataGroups,
  metadataKeyWidth,
  timelineOf,
  type ChangeCommits,
  type HistoryEntry,
} from "./watch-change.ts"
import { useMinute, useNow } from "./watch-clock.ts"
import {
  CHECK_COLOR,
  CHECK_GLYPH,
  clock,
  diagnosticLines,
  mediaDuration,
  stateColor,
  stateGlyph,
  withoutGitConflictsBlock,
} from "./watch-format.ts"
import { MarkerRow, TitledBox } from "./watch-primitives.tsx"
import { runTitle, statusLineOf, timingRows, type WatchRun, type WatchStep } from "./watch-run.ts"

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
  /** The same journal object joined to this row; absent when no journal was read. */
  journal?: JournalRun
  /** The run this detail is about, as the status box and the RUN column draw it. */
  run: WatchRun
  checks: readonly CheckPanel[]
  /** The change's own records, for HISTORY; absent when the histories were not read. */
  records?: readonly ChangeRecord[]
  /** The event chain selected by the table, for event-format HISTORY. */
  events?: readonly Event[]
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

export function WatchDetail({
  detail,
  joinedRun = false,
  selected,
  onSelect,
  diffOpen = false,
  diff,
  onToggleDiff,
}: {
  detail: ChangeDetail | undefined
  /** True when the row is one run's view of the change, not the change's current state. */
  joinedRun?: boolean
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
      <RunStatusBox run={detail.run} joinedRun={joinedRun} />
      {/* The change list under it (items 2, 24): one row per change in the run. */}
      <ChangeList members={[row]} />
      <Box height={1} flexShrink={0} />
      {detail.note === undefined ? null : (
        <Text color="$fg-warning" wrap="wrap">
          {detail.note}
        </Text>
      )}
      {detail.checks.length === 0 ? (
        <Text color="$fg-muted">the declaration this change was judged by names no check</Text>
      ) : null}
      <Tabs
        value={tab}
        onChange={(value: string) => {
          onSelect?.(value)
        }}
      >
        <TabList flexWrap="wrap">
          <Tab key={CHANGES_TAB} value={CHANGES_TAB}>
            Timeline{(row.diagnostics?.length ?? 0) === 0 ? "" : " ⚠"}
            {"\n"}
            <Text color="$fg-muted">{cutCounter(detail)}</Text>
          </Tab>
          {detail.checks.map((check, at) => (
            <Tab key={String(at)} value={String(at)}>
              <StageLabel
                name={
                  check.phase !== undefined && detail.checks.filter((other) => other.name === check.name).length > 1
                    ? `${check.name} (${check.phase})`
                    : check.name
                }
                step={detail.run.steps[at]}
                state={check.state}
                {...(check.state === "running" && row.live?.check === check.name ? { since: row.live.since } : {})}
              />
            </Tab>
          ))}
        </TabList>
        <TabPanel key={CHANGES_TAB} value={CHANGES_TAB}>
          <ScrollArea>
            {(row.diagnostics?.length ?? 0) === 0 ? null : (
              <Text color="$fg-warning" wrap="wrap">
                {diagnosticLines(row, detail.journal).join("\n")}
              </Text>
            )}
            <ChangeBox detail={detail} diffOpen={diffOpen} diff={diff} onToggleDiff={onToggleDiff} />
          </ScrollArea>
        </TabPanel>
        {detail.checks.map((check, at) => (
          <TabPanel key={String(at)} value={String(at)}>
            {/* A failed check's remedy, which rode its step line in the status box before 25441. */}
            {detail.run.steps[at]?.remedy === undefined ? null : (
              <Text color={CHECK_COLOR[check.state]} wrap="wrap">
                {detail.run.steps[at]?.remedy}
              </Text>
            )}
            <CheckBody check={check} />
          </TabPanel>
        ))}
      </Tabs>
    </Box>
  )
}

/**
 * A stage tab's two lines (25441, the operator's Sep 4 sketch): the stage name,
 * then its glyph and how long it took. The status colour sits on the glyph
 * only, so the tab's name keeps silvery `Tab`'s own active and idle colour.
 * An off check reads `off` and a check that never ran `not run`, never a tick.
 */
function StageLabel({
  name,
  step,
  state,
  since,
}: {
  name: string
  step: WatchStep | undefined
  state: CheckView["state"]
  since?: Date
}) {
  const said =
    state === "off"
      ? " off"
      : state === "not-run"
        ? " not run"
        : since === undefined && step?.ms !== undefined
          ? ` ${mediaDuration(step.ms)}`
          : ""
  return (
    <>
      {name}
      {"\n"}
      <Text color={CHECK_COLOR[state]}>{CHECK_GLYPH[state]}</Text>
      {since === undefined ? said : <RunningFor since={since} />}
    </>
  )
}

/** The running stage's own clock: its own leaf on the second, so the tab strip does not re-render for it. */
function RunningFor({ since }: { since: Date }) {
  const now = useNow()
  return <Text> {mediaDuration(now.getTime() - since.getTime())}</Text>
}

/**
 * The status box IS the run (items 1, 39; one line since 25441): identity on
 * the border, then the marker, the bold status and its explanation, e.g.
 * `✓ Merged as 2f5d9fbe7653 at 21:04:20`. The checks are tabs, not lines here.
 * It reads a `WatchRun` and nothing else, so a run of another kind renders
 * through it untouched (37m).
 */
export function RunStatusBox({ run, joinedRun = false }: { run: WatchRun; joinedRun?: boolean }) {
  const { row } = run
  const color = stateColor(row)
  const { status, explanation } = statusLineOf(row, joinedRun)
  return (
    <TitledBox {...(runTitle(run) === undefined ? {} : { titleRight: runTitle(run) })} borderColor={color}>
      <MarkerRow
        marker={
          // Holds still: the one pulse on screen is the held row's, in the list (24196 P1).
          <Text color={color} bold flexShrink={0}>
            {stateGlyph(row)}
          </Text>
        }
      >
        <Text wrap="truncate" minWidth={0}>
          <Text color={color} bold>
            {status}
          </Text>
          {explanation === undefined ? null : <Text color={color}> {explanation}</Text>}
        </Text>
      </MarkerRow>
    </TitledBox>
  )
}

/** The clocks rows, the one part of the timeline that moves every second: its own leaf on the second clock. */
function TimingRows({ row }: { row: Row }) {
  const now = useNow()
  return (
    <>
      {timingRows(row, now).map((line) => (
        <Text key={line} color="$fg-muted" wrap="truncate">
          {line}
        </Text>
      ))}
    </>
  )
}

/** The change's history from whichever source was read: the event chain, else the legacy records. */
function historyOf(detail: ChangeDetail): readonly HistoryEntry[] | undefined {
  if (detail.events !== undefined) return eventHistoryEntries(detail.events)
  return detail.records === undefined ? undefined : historyEntries(detail.records)
}

/** The first tab's second line: which of the branch's cuts this is, e.g. `cut 2/3`. */
function cutCounter(detail: ChangeDetail): string {
  const { cut, cuts } = timelineOf(historyOf(detail) ?? [], undefined)
  return `cut ${String(cut)}/${String(cuts)}`
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

/** What stands where a subject would: a direct row's one line about its commit, else the reason the head is not here. Said, never blank. */
function subjectAbsent(row: Pick<Row, "state" | "reason">): string {
  return row.state === "direct" ? (row.reason ?? "") : "(subject not fetched: the head is not in this repository)"
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
  // History and metadata print `ago` to the minute; the seconds are noise here.
  const now = useMinute()
  const { row } = detail
  const timeline = timelineOf(historyOf(detail) ?? [], detail.commits?.last)
  const groups = metadataGroups(row, now, {
    ...(detail.commits === undefined ? {} : { commits: detail.commits }),
    ...(detail.run.id === undefined ? {} : { runId: detail.run.id }),
  })
  const keyWidth = metadataKeyWidth(groups)
  const body = detail.body === undefined ? "" : withoutGitConflictsBlock(detail.body).trim()
  return (
    <TitledBox>
      {/* The timeline first (25441): this cut's history, oldest first, each with its time to the next. */}
      {historyOf(detail) === undefined ? null : timeline.entries.length === 0 ? (
        <Text color="$fg-muted">no records were read for this change</Text>
      ) : (
        timeline.entries.map((entry) => (
          <Box key={`${entry.at.toISOString()} ${entry.text}`} flexDirection="row" minWidth={0}>
            <Text color="$fg-muted" flexShrink={0}>
              {clock(entry.at, { seconds: true })}
              {"  "}
            </Text>
            <Text wrap="wrap" minWidth={0}>
              {entry.text.charAt(0).toUpperCase() + entry.text.slice(1)}
              {entry.detail === undefined ? "" : ` — ${entry.detail}`}
              {entry.toNextMs === undefined ? null : <Text color="$fg-muted"> · {mediaDuration(entry.toNextMs)}</Text>}
            </Text>
          </Box>
        ))
      )}
      {/* The clocks and the table cell's own duration, moved here from the status box (25441). */}
      <TimingRows row={row} />
      <Box height={1} flexShrink={0} />
      <Text color="$fg-warning" wrap="truncate">
        {changeId(row)}
      </Text>
      <Box height={1} flexShrink={0} />
      <Text bold wrap="wrap">
        {row.subject ?? subjectAbsent(row)}
      </Text>
      {/* Plain text, never Markdown (25441, 25423 option B): a commit body is git's text, and a
          `#` line in it is the author's words or git's own comment, not a heading. */}
      {body === "" ? null : <Text wrap="wrap">{body}</Text>}
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
