/**
 * The boxes under the table: RUNNER (watch-redesign items 13, 14, 16, 17,
 * 27, 29, 29a, 37) and STATS (items 18–22).
 *
 *   ╭─ RUNNER ──────────────────────────────────────────── run 0:42 ─╮
 *   │ $ yrd queue run · main#170406 [pid 1712479]                     │  ← blue, `$` pulses while a run executes;
 *   │   target main · gitlink 3c285a41af46 · checks typecheck, tests  │    the other rails muted (14), hanging off
 *   │   progress 17:04:45 · 2s ago                                    │    the marker's gutter (29, 29a)
 *   ╰─────────────────────────────────────────────────────────────────╯
 *
 * Four words drive it, from `runnerHealth` and nothing else (27: severity is
 * never muted): `running` blue and pulsing, `idle` grey and pulsing slowly,
 * `silent` solid red with the reason on its own line, `absent` grey with the
 * sentence that says where the journal was looked for. One `RUNNER` frame,
 * as item 37 rules; per-queue lines arrive with M8's queues.
 */

import { Box, Pulse, Text } from "silvery"
import { useMinute, useNow } from "./watch-clock.ts"
import { boundedHangingLines, clock, mediaDuration, runShortName } from "./watch-format.ts"
import { MarkerRow, TitledBox } from "./watch-primitives.tsx"
import { runnerHealth, type RunnerFacts, type RunnerHealth } from "./watch-runner.ts"
import { STATS_ROWS, countCell, statsBuckets, type RunDecision, type StatsBucket } from "./watch-stats.ts"

/** Gutter 2 + borders 2 + the box's paddingX 2: what the command text cannot have (the retired box's own accounting). */
const RUNNER_CHROME = 6

const HEALTH_COLOR: Readonly<Record<RunnerHealth, string>> = {
  absent: "$fg-muted",
  idle: "$fg-muted",
  running: "$fg-info",
  silent: "$fg-error",
}

/** The one health marker, `$`, colored and pulsed by the word (item 13). */
function HealthMarker({ health, live }: { health: RunnerHealth; live: boolean }) {
  const color = HEALTH_COLOR[health]
  if (live && health === "running") {
    return (
      <Pulse synchronized colors={["$fg-info", "$fg-muted"]} bold flexShrink={0}>
        $
      </Pulse>
    )
  }
  if (live && health === "idle") {
    return (
      <Pulse synchronized colors={["$fg-muted", "$bg-surface-default"]} flexShrink={0}>
        $
      </Pulse>
    )
  }
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
  columns,
  pause,
  live = true,
}: {
  facts: RunnerFacts
  /** The queue's name, for the run's short form. */
  label: string
  /** How many changes wait in line: silence only matters while something waits. */
  inLine: number
  /** The pane's width, so the command wraps with a hanging indent bounded to three rows (item 29). */
  columns: number
  /** The pause line, when the queue is paused: the box's border and its last rail say so (item 27). */
  pause?: string
  live?: boolean
}) {
  const now = useNow()
  const health = runnerHealth(facts, inLine, now)
  const color = HEALTH_COLOR[health]
  const latest = facts.latest
  const sinceWrite = latest === undefined ? undefined : now.getTime() - latest.lastWriteAt.getTime()
  const timer =
    latest === undefined
      ? undefined
      : health === "running"
        ? `run ${mediaDuration(now.getTime() - latest.startedAt.getTime())}`
        : `${health} ${mediaDuration(sinceWrite ?? 0)}`
  const border = health === "silent" ? "$fg-error" : pause === undefined ? undefined : "$fg-warning"
  const command =
    latest === undefined
      ? "yrd queue up"
      : health === "running"
        ? `yrd queue run · ${runShortName(label, latest.id)}${latest.pid === undefined ? "" : ` [pid ${String(latest.pid)}]`}`
        : `yrd queue up · last run ${runShortName(label, latest.id)} wrote ${mediaDuration(sinceWrite ?? 0)} ago`
  const commandRows = boundedHangingLines(command, Math.max(8, columns - RUNNER_CHROME), 3)
  // Item 14: while a run executes the informational rails go muted so the
  // activity line carries the eye; item 27: an error rail keeps its color.
  const rail = "$fg-muted"
  return (
    <TitledBox
      title="RUNNER"
      {...(timer === undefined ? {} : { titleRight: timer })}
      {...(border === undefined ? {} : { borderColor: border })}
    >
      <MarkerRow marker={<HealthMarker health={health} live={live} />}>
        {commandRows.map((row) => (
          <Text key={row} color={color} wrap="truncate" minWidth={0}>
            {row}
          </Text>
        ))}
      </MarkerRow>
      {latest === undefined ? (
        <MarkerRow>
          <Text color={rail} wrap="wrap" minWidth={0}>
            {facts.absent ?? `no run journal was read: ${facts.journalDir}`}
          </Text>
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
          {health === "silent" ? (
            <MarkerRow>
              <Text color="$fg-error" bold wrap="wrap" minWidth={0}>
                RUNNER SILENT — no journal write for {mediaDuration(sinceWrite ?? 0)} while {String(inLine)}{" "}
                {inLine === 1 ? "change waits" : "changes wait"} in line; is yrd-service up? (hab ps yrd-service)
              </Text>
            </MarkerRow>
          ) : null}
        </>
      )}
      {pause === undefined ? null : (
        <>
          <Box height={1} flexShrink={0} />
          <MarkerRow marker={<Text color="$fg-warning">⚠︎</Text>}>
            <Text color="$fg-warning" bold wrap="wrap" minWidth={0}>
              {pause}
            </Text>
          </MarkerRow>
        </>
      )}
    </TitledBox>
  )
}

/** The label column of the STATS box, wide enough for `MERGES` and a space. */
const STATS_LABEL_WIDTH = 8
/** One hour cell: two digits or up to three digits of count, right-aligned. */
const STATS_HOUR_WIDTH = 3
/** The two calendar columns. */
const STATS_PERIOD_WIDTHS = [6, 8] as const

/** How many hour buckets fit beside the label and the two calendar columns, between 6 and 24. */
export function statsHoursFor(columns: number): number {
  const fixed = RUNNER_CHROME + STATS_LABEL_WIDTH + STATS_PERIOD_WIDTHS[0] + STATS_PERIOD_WIDTHS[1] + 2
  return Math.max(6, Math.min(24, Math.floor((columns - fixed) / STATS_HOUR_WIDTH)))
}

/**
 * The STATS box (items 18–22): `TODAY`, `YSTRDAY`, then the hours of the last
 * day newest first; every number right-aligned (item 19); the local midnight
 * as its own one-character column running through header and rows alike
 * (item 20); DUP muted and just above FAILS (items 21, 22).
 */
export function StatsBox({
  decisions,
  columns,
  absent,
}: {
  decisions: readonly RunDecision[]
  columns: number
  /** Why there are no decisions to count, when there are none: the journal sentence. */
  absent?: string
}) {
  // Hour buckets move on the minute at most; nothing here needs the seconds.
  const minute = useMinute()
  const buckets = statsBuckets(decisions, minute, statsHoursFor(columns))
  const periods = buckets.filter((bucket) => bucket.kind === "period")
  const hours = buckets.filter((bucket) => bucket.kind === "hour")
  const cell = (bucket: StatsBucket, text: string, color: string | undefined, bold = false) => (
    <Box
      key={bucket.key}
      width={bucket.kind === "hour" ? STATS_HOUR_WIDTH : STATS_PERIOD_WIDTHS[bucket.key === "today" ? 0 : 1]}
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
  const line = (label: string, text: (bucket: StatsBucket) => string, color: string | undefined, bold = false) => (
    <Box flexDirection="row" minWidth={0} overflow="hidden">
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
      {line("", (bucket) => bucket.label, "$fg-muted", true)}
      {STATS_ROWS.map((row) =>
        line(row.label, (bucket) => countCell(bucket, row.key), row.key === "duplicates" ? "$fg-muted" : undefined),
      )}
      {decisions.length === 0 && absent !== undefined ? (
        <Text color="$fg-muted" wrap="wrap">
          {absent}
        </Text>
      ) : null}
    </TitledBox>
  )
}
