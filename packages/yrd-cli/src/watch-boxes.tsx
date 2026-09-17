/**
 * The boxes under the table: RUNNER (watch-redesign items 13, 14, 16, 17,
 * 27, 29, 29a, 37) and STATS (items 18–22).
 *
 *   ╭─ RUNNER ──────────────────────────────────────────── run 0:42 ─╮
 *   │ $ yrd queue run · main#170406 [pid 1712479]                     │  ← blue while a run executes; the other
 *   │   target main · gitlink 3c285a41af46 · checks typecheck, tests  │    rails muted (14), hanging off the
 *   │   progress 17:04:45 · 2s ago                                    │    marker's gutter (29, 29a)
 *   ╰─────────────────────────────────────────────────────────────────╯
 *
 * Five words drive it, from `runnerHealth` and nothing else (27: severity is
 * never muted): `running` blue, `idle` grey,
 * `silent` solid red with the reason on its own line, `unstarted` solid red for
 * a run that threw in its Git preamble, naming the journal that holds the
 * failing call (24470), and `absent` grey with the sentence that says where the
 * journal was looked for. One `RUNNER` frame, as item 37 rules; per-queue lines
 * arrive with M8's queues.
 *
 * The `$` never pulses (@i/10-yrd/24196): the one thing on screen that pulses
 * is the marker of the change a check holds, on its own row, so the eye goes
 * to the change and not to the process.
 */

import { join } from "node:path"
import { Box, Text } from "silvery"
import { useMinute, useNow } from "./watch-clock.ts"
import { boundedHangingLines, clock, mediaDuration, runShortName } from "./watch-format.ts"
import { MarkerRow, TitledBox } from "./watch-primitives.tsx"
import { runnerHealth, type RunnerFacts, type RunnerHealth } from "./watch-runner.ts"
import {
  STATS_ROWS,
  STATS_TIME_ROWS,
  countCell,
  statsBuckets,
  timeCell,
  type RunDecision,
  type StatsBucket,
} from "./watch-stats.ts"

/** Gutter 2 + borders 2 + the box's paddingX 2: what the command text cannot have (the retired box's own accounting). */
const RUNNER_CHROME = 6
// Row caps for the rails that can run long (the retired pane capped its pause
// banner the same way: wraps, never truncates below the cap, elides past it).
const PAUSE_MAX_ROWS = 4
const ABSENT_MAX_ROWS = 3
const SILENT_MAX_ROWS = 3
const UNSTARTED_MAX_ROWS = 3

const HEALTH_COLOR: Readonly<Record<RunnerHealth, string>> = {
  absent: "$fg-muted",
  idle: "$fg-muted",
  processing: "$fg-info",
  silent: "$fg-error",
  unstarted: "$fg-error",
}

/** The one health marker, `$`, colored by the word (item 13), and still. */
function HealthMarker({ health }: { health: RunnerHealth }) {
  const color = HEALTH_COLOR[health]
  return (
    <Text color={color} bold={health === "silent"} flexShrink={0}>
      $
    </Text>
  )
}

export function RunnerBox({
  facts,
  label,
  inLine,
  underCheck,
  columns,
  pause,
}: {
  facts: RunnerFacts
  /** The queue's name, for the run's short form. */
  label: string
  /**
   * How many changes wait in line, counted as the queue line counts them (watch-frame.tsx `lineOf`): once
   * each, the one a check holds apart. Silence is decided without it; the rail says which of the two
   * silences this is.
   */
  inLine: number
  /**
   * Is a change under a check RIGHT NOW — the marker's actual predicate (items
   * 1 and 5). Passed in rather than derived here, because the caller holds the
   * rows and the status pills already answer this exact question; two
   * derivations of one fact is how the marker and the list come to disagree.
   */
  underCheck: boolean
  /** The pane's width, so the command wraps with a hanging indent bounded to three rows (item 29). */
  columns: number
  /** The pause line, when the queue is paused: the box's border and its last rail say so (item 27). */
  pause?: string
}) {
  const now = useNow()
  const health = runnerHealth(facts, now, underCheck)
  const color = HEALTH_COLOR[health]
  const latest = facts.latest
  const sinceWrite = latest === undefined ? undefined : now.getTime() - latest.lastWriteAt.getTime()
  const timer =
    latest === undefined
      ? undefined
      : health === "processing"
        ? // ITEM 1 -- THE WORD. Every other health renders its own word beside its
          // duration; this one said `run`, so the marker never actually showed the
          // state it was in. The word is the spec's, and it names the predicate
          // above it. The DURATION still differs on purpose: for `processing` the
          // useful age is how long the run has been going, not how long since the
          // last write.
          `processing ${mediaDuration(now.getTime() - latest.startedAt.getTime())}`
        : `${health} ${mediaDuration(sinceWrite ?? 0)}`
  const border =
    health === "silent" || health === "unstarted" ? "$fg-error" : pause === undefined ? undefined : "$fg-warning"
  const command =
    latest === undefined
      ? "yrd queue up"
      : health === "processing"
        ? `yrd queue run · ${runShortName(label, latest.id)}${latest.pid === undefined ? "" : ` [pid ${String(latest.pid)}]`}`
        : `yrd queue up · last run ${runShortName(label, latest.id)} wrote ${mediaDuration(sinceWrite ?? 0)} ago`
  // Every rail that can run long is pre-wrapped into rows, like the command
  // rail: a `wrap="wrap"` text inside a marker row under-reports its height to
  // the column's flex pass by exactly the lines it wraps to, and every box below
  // RUNNER is then laid out that many rows too high (the STATS border on the
  // footer row, the pills row off screen; 2026-09-05, reproduced in isolation).
  const railWidth = Math.max(8, columns - RUNNER_CHROME)
  const commandRows = boundedHangingLines(command, railWidth, 3)
  const absentRows =
    latest === undefined
      ? boundedHangingLines(facts.absent ?? `no run journal was read: ${facts.journalDir}`, railWidth, ABSENT_MAX_ROWS)
      : []
  const silentRows =
    latest !== undefined && health === "silent"
      ? boundedHangingLines(
          `RUNNER SILENT — no journal write for ${mediaDuration(sinceWrite ?? 0)}${
            inLine === 0
              ? " and nothing is in line, so a change submitted now would not be picked up"
              : ` while ${String(inLine)} ${inLine === 1 ? "change waits" : "changes wait"} in line`
          }`,
          railWidth,
          SILENT_MAX_ROWS,
        )
      : []
  // 24470: the run threw before it reached the queue it was for. Name the state
  // and point at the evidence — the journal's last Git row IS the failing call,
  // which is a different hand from the one `hab ps` sends you to for silence.
  const unstartedRows =
    latest !== undefined && health === "unstarted"
      ? boundedHangingLines(
          `RUNNER UNSTARTED — run ${latest.id} died in its Git preamble before it could read its queue; ` +
            `its last Git row names the call that failed (${join(facts.journalDir, `${latest.id}.jsonl`)})`,
          railWidth,
          UNSTARTED_MAX_ROWS,
        )
      : []
  const pauseRows = pause === undefined ? [] : boundedHangingLines(pause, railWidth, PAUSE_MAX_ROWS)
  // Item 14: while a run executes the informational rails go muted so the
  // activity line carries the eye; item 27: an error rail keeps its color.
  const rail = "$fg-muted"
  return (
    <TitledBox
      title="RUNNER"
      {...(timer === undefined ? {} : { titleRight: timer })}
      {...(border === undefined ? {} : { borderColor: border })}
    >
      <MarkerRow marker={<HealthMarker health={health} />}>
        {commandRows.map((row) => (
          <Text key={row} color={color} wrap="truncate" minWidth={0}>
            {row}
          </Text>
        ))}
      </MarkerRow>
      {latest === undefined ? (
        <MarkerRow>
          {absentRows.map((row) => (
            <Text key={row} color={rail} wrap="truncate" minWidth={0}>
              {row}
            </Text>
          ))}
        </MarkerRow>
      ) : (
        <>
          <MarkerRow>
            <Text color={rail} wrap="truncate" minWidth={0}>
              {[
                latest.target === undefined ? undefined : `target ${latest.target}`,
                latest.gitlink === undefined ? undefined : `gitlink ${latest.gitlink.slice(0, 12)}`,
                latest.checks === undefined ? undefined : `checks ${latest.checks.join(", ")}`,
              ]
                .filter((part): part is string => part !== undefined)
                .join(" · ") || "the run's header record was not read"}
            </Text>
          </MarkerRow>
          {/* Item 16: the absolute measured-at clock beside the relative age, so
              a heartbeat that legitimately oscillates never READS frozen. */}
          <MarkerRow>
            <Text color={rail} wrap="truncate" minWidth={0}>
              progress {clock(latest.lastWriteAt, { seconds: true })} · {mediaDuration(sinceWrite ?? 0)} ago
            </Text>
          </MarkerRow>
          {silentRows.length === 0 ? null : (
            <MarkerRow>
              {silentRows.map((row) => (
                <Text key={row} color="$fg-error" bold wrap="truncate" minWidth={0}>
                  {row}
                </Text>
              ))}
            </MarkerRow>
          )}
          {unstartedRows.length === 0 ? null : (
            <MarkerRow>
              {unstartedRows.map((row) => (
                <Text key={row} color="$fg-error" bold wrap="truncate" minWidth={0}>
                  {row}
                </Text>
              ))}
            </MarkerRow>
          )}
        </>
      )}
      {pauseRows.length === 0 ? null : (
        <>
          <Box height={1} flexShrink={0} />
          <MarkerRow marker={<Text color="$fg-warning">⚠︎</Text>}>
            {pauseRows.map((row) => (
              <Text key={row} color="$fg-warning" bold wrap="truncate" minWidth={0}>
                {row}
              </Text>
            ))}
          </MarkerRow>
        </>
      )}
    </TitledBox>
  )
}

/** The label column of the STATS box, wide enough for `QUEUING` and a space. */
const STATS_LABEL_WIDTH = 8
/** One hour cell: a count of up to three digits or a duration like `45m`, right-aligned with one cell of air. */
const STATS_HOUR_WIDTH = 4
/** The four calendar columns, by bucket key: `YSTRDAY` is the wide one. */
const STATS_PERIOD_WIDTHS: Readonly<Record<string, number>> = { month: 6, today: 6, week: 6, yesterday: 8 }
const STATS_PERIODS_WIDTH = Object.values(STATS_PERIOD_WIDTHS).reduce((sum, width) => sum + width, 0)

/** How many hour buckets fit beside the label and the four calendar columns, between 6 and 24. */
export function statsHoursFor(columns: number): number {
  const fixed = RUNNER_CHROME + STATS_LABEL_WIDTH + STATS_PERIODS_WIDTH + 2
  return Math.max(6, Math.min(24, Math.floor((columns - fixed) / STATS_HOUR_WIDTH)))
}

/**
 * The colour of a count row — the retired box's: merges and passes are
 * successes, a duplicate merged nothing and is muted, a fail is an error, a
 * stuck run is the warning it is, and the run count is plain.
 */
const STATS_ROW_COLOR: Readonly<Partial<Record<(typeof STATS_ROWS)[number]["key"], string>>> = {
  duplicates: "$fg-muted",
  fails: "$fg-error",
  merges: "$fg-success",
  passes: "$fg-success",
  stuck: "$fg-warning",
}

/**
 * The STATS box (items 18–22): `TODAY`, `YSTRDAY`, `WEEK`, `MONTH`, then the
 * hours of the last day newest first; every number right-aligned (item 19);
 * the local midnight as its own one-character column running through header
 * and rows alike (item 20); DUP muted and just above FAILS (items 21, 22);
 * under the counts, the TIME rows — median opened→merged, opened→started,
 * started→ended, and the mean same-head retries a merge took — the retired
 * box's AVG TIME section on the new core's rows.
 */
export function StatsBox({
  decisions,
  columns,
  timeRows = true,
}: {
  decisions: readonly RunDecision[]
  columns: number
  /** Draw the TIME rows under the counts; a short terminal keeps the counts and gives the list the rows instead. */
  timeRows?: boolean
}) {
  // Hour buckets move on the minute at most; nothing here needs the seconds.
  const minute = useMinute()
  const buckets = statsBuckets(decisions, minute, statsHoursFor(columns))
  const periods = buckets.filter((bucket) => bucket.kind === "period")
  const hours = buckets.filter((bucket) => bucket.kind === "hour")
  const cell = (bucket: StatsBucket, text: string, color: string | undefined, bold = false) => (
    <Box
      key={bucket.key}
      width={bucket.kind === "hour" ? STATS_HOUR_WIDTH : (STATS_PERIOD_WIDTHS[bucket.key] ?? 6)}
      flexShrink={0}
      justifyContent="flex-end"
    >
      <Text color={color} bold={bold}>
        {text}
      </Text>
    </Box>
  )
  // The midnight rule: one blank-or-bar cell BEFORE every hour bucket that
  // starts a new local day, on every row, so the column reads as one line.
  const boundary = (bucket: StatsBucket) =>
    bucket.dayBoundary ? (
      <Box key={`${bucket.key}-day`} width={1} flexShrink={0}>
        <Text color="$fg-muted">│</Text>
      </Box>
    ) : null
  const line = (
    key: string,
    label: string,
    text: (bucket: StatsBucket) => string,
    color: string | undefined,
    bold = false,
  ) => (
    <Box key={key} flexDirection="row" minWidth={0} overflow="hidden">
      <Box width={STATS_LABEL_WIDTH} flexShrink={0}>
        <Text color={color ?? undefined} bold={bold}>
          {label}
        </Text>
      </Box>
      {periods.map((bucket) => cell(bucket, text(bucket), color, bold))}
      <Box width={2} flexShrink={0}>
        <Text color="$fg-muted"> │</Text>
      </Box>
      {hours.flatMap((bucket) => [boundary(bucket), cell(bucket, text(bucket), color, bold)])}
    </Box>
  )
  return (
    <TitledBox title="STATS">
      {line("header", "", (bucket) => bucket.label, "$fg-muted", true)}
      {STATS_ROWS.map((row) =>
        line(row.key, row.label, (bucket) => countCell(bucket, row.key), STATS_ROW_COLOR[row.key]),
      )}
      {/* The heading names the statistic: these rows are medians, not means or sums,
          and a reader cannot tell which from the numbers alone. Fits STATS_LABEL_WIDTH. */}
      {timeRows ? line("time", "MEDIAN", () => "", "$fg-muted", true) : null}
      {timeRows
        ? STATS_TIME_ROWS.map((row) => line(row.key, row.label, (bucket) => timeCell(bucket, row.key), "$fg-muted"))
        : null}
    </TitledBox>
  )
}
