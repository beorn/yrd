/**
 * One change, opened: its identity, then its clocks, then one tab per check
 * with the command that ran it directly above the output it produced (S2.16,
 * S2.18, S2.19, S2.21; README 782-789).
 *
 * Three rules from the operator's own spec are structural here, not incidental:
 *
 * - **The checks after a failing one render NOT RUN.** The queue stops at the
 *   first check that is not a pass, so they did not run — and leaving them off
 *   the screen entirely is what made a reader believe a change had been judged
 *   by checks it never reached. `checksOf` in the core produces them; this
 *   only draws them.
 * - **The newest output is selected by default.** A reader opening a change
 *   wants the last thing that happened, not the first.
 * - **The command lives above its output, and the log path is real.** The path
 *   is a live OSC 8 hyperlink, so it can be opened rather than retyped.
 *
 * Every reading was made before this rendered. Nothing here opens a file.
 */

import { hyperlink } from "@silvery/ansi"
import { Box, ScrollArea, Tab, TabList, TabPanel, Tabs, Text } from "silvery"
import type { CheckView, Row } from "@yrd/queue-core"
import { clocksLine, noticeLine } from "./watch-notice.ts"

/**
 * A check with what its log actually held. The output is read by whatever
 * loads the snapshot, never here; `why` carries the reason there is none, so
 * an empty pane always says what it looked for.
 */
export type CheckPanel = CheckView &
  Readonly<{
    /** What the log file held, when it could be read. */
    output?: string
    /** Why there is no output: no log path recorded, the file is not on this machine, or it could not be read. */
    why?: string
  }>

export type ChangeDetail = Readonly<{
  row: Row
  checks: readonly CheckPanel[]
  /** Why these are the checks shown, when the declaration the change was judged by could not be read. */
  note?: string
}>

/** The tab a reader lands on: the newest output there is, else the last check that ran, else the first. */
export function defaultCheckIndex(checks: readonly CheckPanel[]): number {
  const newestOutput = checks.findLastIndex((check) => check.output !== undefined && check.output !== "")
  if (newestOutput !== -1) return newestOutput
  const lastRan = checks.findLastIndex((check) => check.result !== undefined)
  return lastRan === -1 ? 0 : lastRan
}

/** The word a tab wears, so the strip alone says which checks were never reached. */
const TAB_WORD: Readonly<Record<CheckView["state"], string>> = {
  failed: "×",
  "not-run": "−",
  passed: "✓",
  running: "◉",
  stuck: "◌",
  unmeasured: "?",
}

const TAB_COLOR: Readonly<Record<CheckView["state"], string>> = {
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
  now,
  selected,
  onSelect,
}: {
  detail: ChangeDetail | undefined
  joinedRun?: boolean
  now: Date
  selected?: number
  onSelect?: (index: number) => void
}) {
  if (detail === undefined) {
    return (
      <Box flexDirection="column" paddingX={1} minWidth={0}>
        <Text color="$fg-muted">no change selected</Text>
      </Box>
    )
  }
  const { row } = detail
  const index = selected ?? defaultCheckIndex(detail.checks)
  const clocks = clocksLine(row, now)
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={1}>
      {/* Identity first (S2.16): which change this is, at which head, on which
          base, submitted by whom. */}
      <Text bold wrap="truncate">
        {row.branch} {row.head.slice(0, 12)}
      </Text>
      {row.subject === undefined ? null : (
        <Text color="$fg-muted" wrap="truncate">
          {row.subject}
        </Text>
      )}
      <Text wrap="truncate">{noticeLine(row, joinedRun)}</Text>
      {/* Then the clocks. A clock nothing measured is left out, never zero. */}
      {clocks === "" ? null : <Text color="$fg-muted">{clocks}</Text>}
      <Box flexDirection="row" columnGap={2} flexShrink={0}>
        {row.submitter === undefined ? null : <Text color="$fg-muted">by {row.submitter}</Text>}
        {row.issue === undefined ? null : <Text color="$fg-muted">{row.issue}</Text>}
        {row.base === undefined ? null : <Text color="$fg-muted">base {row.base.slice(0, 12)}</Text>}
        {row.merge === undefined ? null : <Text color="$fg-muted">merge {row.merge.slice(0, 12)}</Text>}
        {row.run === undefined ? null : <Text color="$fg-muted">run {row.run}</Text>}
      </Box>
      {detail.note === undefined ? null : (
        <Text color="$fg-warning" wrap="wrap">
          {detail.note}
        </Text>
      )}
      {detail.checks.length === 0 ? (
        <Text color="$fg-muted">the declaration this change was judged by names no check</Text>
      ) : (
        <Tabs
          value={String(index)}
          onChange={(value: string) => {
            const at = Number(value)
            if (Number.isInteger(at) && at >= 0 && at < detail.checks.length) onSelect?.(at)
          }}
        >
          <TabList>
            {detail.checks.map((check, at) => (
              <Tab key={String(at)} value={String(at)}>
                <Text color={TAB_COLOR[check.state]}>
                  {TAB_WORD[check.state]} {check.name}
                  {check.phase !== undefined && detail.checks.filter((other) => other.name === check.name).length > 1
                    ? ` (${check.phase})`
                    : ""}
                </Text>
              </Tab>
            ))}
          </TabList>
          {detail.checks.map((check, at) => (
            <TabPanel key={String(at)} value={String(at)}>
              <CheckBody check={check} />
            </TabPanel>
          ))}
        </Tabs>
      )}
    </Box>
  )
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
        <Text color="$fg-muted">the declaration this change was judged by does not name this check</Text>
      ) : (
        <Text wrap="truncate">$ {check.spec.run}</Text>
      )}
      <Text color="$fg-muted" wrap="truncate">
        {check.state === "not-run"
          ? "NOT RUN"
          : check.state === "unmeasured"
            ? "unmeasured — no result recorded"
            : check.state}
        {exit}
        {check.result?.ms === undefined ? "" : ` ${String(check.result.ms)}ms`}
      </Text>
      {/* The REAL path, as a link that opens it (S2.21). A path we do not have
          is absent, never a link to nowhere. */}
      {check.log === undefined ? null : <Text color="$fg-muted">{hyperlink(check.log, pathUrl(check.log))}</Text>}
      {check.output === undefined || check.output === "" ? (
        <Text color="$fg-muted" wrap="wrap">
          {check.why ?? "no output was read"}
        </Text>
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
