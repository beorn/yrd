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
 *   │ ► Diff +214 −38                                    │
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
import type { ChangeRecord, CheckView, JournalCommand, JournalRun, JournalStep, Row } from "@yrd/queue-core"
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
import { runTitle, statusLineOf, timingRows, type WatchRun } from "./watch-run.ts"

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

function isMigratedWithoutCheckDetail(detail: ChangeDetail): boolean {
  return detail.checks.length === 0 && detail.note?.startsWith("Migrated change has no check-step detail") === true
}

export function WatchDetail({
  detail,
  change,
  joinedRun = false,
  selected,
  onSelect,
  diffOpen = false,
  diff,
  onToggleDiff,
  outputs = new Map(),
}: {
  detail: ChangeDetail | undefined
  /** The selected change's identity, displayed when loading detail (25630 Row 22). */
  change?: string | Pick<Row, "branch" | "head">
  /** True when the row is one run's view of the change, not the change's current state. */
  joinedRun?: boolean
  /** The open tab: `CHANGES_TAB`, a check's index as a string, a step's `step:<n>`, or `round`. */
  selected?: string
  onSelect?: (value: string) => void
  diffOpen?: boolean
  diff?: DiffText
  onToggleDiff?: () => void
  /** The git commands' output read so far, keyed by {@link commandKey}; the pane asks for a stage's when its tab opens. */
  outputs?: ReadonlyMap<string, DiffText>
}) {
  if (detail === undefined) {
    const changeName = typeof change === "object" ? changeId(change) : change
    if (changeName !== undefined) {
      return (
        <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" minHeight={0} minWidth={0}>
          <Text color="$fg-muted">{`Loading ${changeName}…`}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={1} minWidth={0}>
        <Text color="$fg-muted">no change selected</Text>
      </Box>
    )
  }
  const { row } = detail
  const resolved = resolveTab(selected, detail)
  const tab = resolved.tab
  const selectedSubIndex = resolved.selectedSubIndex
  const migratedWithoutChecks = isMigratedWithoutCheckDetail(detail)
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} paddingX={1}>
      {/* The status box at the VERY top, no identity row above it (items 1, 23). */}
      <RunStatusBox run={detail.run} joinedRun={joinedRun} />
      {/* The change list under it (items 2, 24): one row per change in the run. */}
      <ChangeList members={[row]} />
      <Box height={1} flexShrink={0} />
      {row.diagnostic === undefined ? null : (
        <Text color="$fg-error" wrap="wrap">
          {row.diagnostic}
        </Text>
      )}
      {migratedWithoutChecks ? (
        <Text color="$fg-warning" wrap="wrap">
          Migrated change has no check-step detail; open Checking for the retained record and old check logs.
        </Text>
      ) : detail.note === undefined ? null : (
        <Text color="$fg-warning" wrap="wrap">
          {detail.note}
        </Text>
      )}
      {detail.checks.length === 0 && !migratedWithoutChecks ? (
        <Text color="$fg-muted">no check-step detail is recorded for this change</Text>
      ) : null}
      <Tabs
        variant="filled"
        value={tab}
        onChange={(value: string) => {
          onSelect?.(value)
        }}
      >
        <TabList flexWrap="wrap">
          <Tab key={CHANGES_TAB} value={CHANGES_TAB}>
            Timeline{(row.diagnostics?.length ?? 0) === 0 && row.diagnostic === undefined ? "" : " ⚠"}
            {"\n"}
            <Text color="$fg-muted">{cutCounter(detail)}</Text>
          </Tab>
          {STAGE_TABS.map((stage) => (
            <Tab key={stage} value={stage}>
              <StageTabLabel detail={detail} stage={stage} />
            </Tab>
          ))}
        </TabList>
        <TabPanel key={CHANGES_TAB} value={CHANGES_TAB}>
          <ScrollArea>
            {(row.diagnostics?.length ?? 0) === 0 && row.diagnostic === undefined ? null : (
              <Text color="$fg-warning" wrap="wrap">
                {diagnosticLines(row, detail.journal).join("\n")}
              </Text>
            )}
            <ChangeBox detail={detail} diffOpen={diffOpen} diff={diff} onToggleDiff={onToggleDiff} />
          </ScrollArea>
        </TabPanel>
        {STAGE_TABS.map((stage) => (
          <TabPanel key={stage} value={stage}>
            <StageTabPanel detail={detail} stage={stage} outputs={outputs} selectedSubIndex={selectedSubIndex} />
          </TabPanel>
        ))}
      </Tabs>
    </Box>
  )
}

export const STAGE_TABS = ["provisioning", "checking", "merging", "deprovisioning"] as const
export type StageTabName = (typeof STAGE_TABS)[number]

export function areDeclaredChecksOff(detail: ChangeDetail): boolean {
  if (detail.checks.length === 0) return true
  return detail.checks.every((check) => check.state === "off" || check.spec?.run === "true")
}

export function isStageSkipped(detail: ChangeDetail, stage: StageTabName): boolean {
  const { row } = detail
  if (stage === "provisioning") {
    return (
      ((row.state === "queued" || row.state === "draft") && (detail.journal?.steps.length ?? 0) === 0) ||
      row.state === "direct"
    )
  }
  if (stage === "checking") {
    const unmeasured = detail.checks.find((c) => c.state === "unmeasured" && c.result === undefined)
    if (unmeasured) return false
    return areDeclaredChecksOff(detail)
  }
  if (stage === "merging") {
    return (
      row.state === "failed" ||
      row.state === "stuck" ||
      row.state === "cancelled" ||
      row.state === "queued" ||
      row.state === "draft" ||
      row.state === "direct"
    )
  }
  if (stage === "deprovisioning") {
    return areDeclaredChecksOff(detail) || row.state === "queued" || row.state === "draft" || row.state === "direct"
  }
  return false
}

export function stageSkipReason(detail: ChangeDetail, stage: StageTabName): string {
  if (stage === "checking") {
    return "every declared check is off"
  }
  if (stage === "deprovisioning") {
    return "skipped: no check worktree was created (all declared checks off)"
  }
  if (stage === "merging") {
    return "not reached: candidate ended before merge"
  }
  if (stage === "provisioning") {
    return "skipped: candidate not yet formed"
  }
  return "skipped"
}

export function stageInfo(
  detail: ChangeDetail,
  stage: StageTabName,
): {
  state: CheckView["state"]
  said?: string
  since?: Date
  ms?: number
} {
  const steps = detail.journal?.steps ?? []
  if (stage === "provisioning") {
    const compose = steps.find((s) => s.name === "compose")
    const prepare = steps.find((s) => s.name === "prepare")
    if (compose === undefined && prepare === undefined) {
      return { said: " not journaled", state: "not-run" }
    }
    const threw = compose?.threw === true || prepare?.threw === true
    const running =
      (compose !== undefined && compose.endedAt === undefined) ||
      (prepare !== undefined && prepare.endedAt === undefined)
    const ms = (compose?.ms ?? 0) + (prepare?.ms ?? 0)
    const state: CheckView["state"] = threw ? "failed" : running ? "running" : "passed"
    return {
      ms: ms > 0 ? ms : undefined,
      said: running ? undefined : threw ? (ms > 0 ? ` ${mediaDuration(ms)}` : " failed") : ms > 0 ? ` ${mediaDuration(ms)}` : " passed",
      since: running ? (compose?.startedAt ?? prepare?.startedAt) : undefined,
      state,
    }
  }
  if (stage === "checking") {
    const unmeasured = detail.checks.find((c) => c.state === "unmeasured" && c.result === undefined)
    if (unmeasured) return { said: " unended", state: "unmeasured" }
    const checks = detail.checks.filter((c) => c.phase !== "base" && c.name !== "setup")
    if (checks.length === 0) return { said: " not run", state: "not-run" }
    if (checks.every((c) => c.state === "not-run")) return { said: " not run", state: "not-run" }
    const failed = checks.find((c) => c.state === "failed" || c.state === "stuck")
    if (failed) return { said: " failed", state: failed.state }
    const running = checks.find((c) => c.state === "running")
    if (running) {
      const since = detail.row.live?.since
      return { since, state: "running" }
    }
    const totalMs = checks.reduce((acc, c) => acc + (c.result?.ms ?? 0), 0)
    return {
      ms: totalMs > 0 ? totalMs : undefined,
      said: totalMs > 0 ? ` ${mediaDuration(totalMs)}` : " passed",
      state: "passed",
    }
  }
  if (stage === "merging") {
    const publish = steps.find((s) => s.name === "publish" || s.name === "components")
    const merge = steps.find((s) => s.name === "merge" || s.name === "push")
    const notify = steps.find((s) => s.name === "notify")
    const running =
      (publish !== undefined && publish.endedAt === undefined) ||
      (merge !== undefined && merge.endedAt === undefined) ||
      (notify !== undefined && notify.endedAt === undefined)
    const ms = (publish?.ms ?? 0) + (merge?.ms ?? 0) + (notify?.ms ?? 0)
    if (running) return { since: merge?.startedAt ?? publish?.startedAt ?? notify?.startedAt, state: "running" }
    const threw = publish?.threw === true || merge?.threw === true || notify?.threw === true
    if (threw) {
      return { ms: ms > 0 ? ms : undefined, said: ms > 0 ? ` ${mediaDuration(ms)}` : " failed", state: "failed" }
    }
    if (detail.row.state === "merged") {
      if (publish === undefined && merge === undefined && notify === undefined) {
        return { said: " not journaled", state: "not-run" }
      }
      return { ms: ms > 0 ? ms : undefined, said: ms > 0 ? ` ${mediaDuration(ms)}` : " passed", state: "passed" }
    }
    return { said: " not run", state: "not-run" }
  }
  if (stage === "deprovisioning") {
    const remove = steps.find((s) => s.name === "remove" || s.name === "retain")
    const retire = steps.find((s) => s.name === "retire")
    const running =
      (remove !== undefined && remove.endedAt === undefined) || (retire !== undefined && retire.endedAt === undefined)
    const ms = (remove?.ms ?? 0) + (retire?.ms ?? 0)
    if (running) return { since: remove?.startedAt ?? retire?.startedAt, state: "running" }
    const threw = remove?.threw === true || retire?.threw === true
    if (threw) {
      return { ms: ms > 0 ? ms : undefined, said: ms > 0 ? ` ${mediaDuration(ms)}` : " failed", state: "failed" }
    }
    if (detail.row.state === "merged" || detail.row.state === "failed") {
      if (remove === undefined && retire === undefined) {
        return { said: " not journaled", state: "not-run" }
      }
      return { ms: ms > 0 ? ms : undefined, said: ms > 0 ? ` ${mediaDuration(ms)}` : " passed", state: "passed" }
    }
    return { said: " not run", state: "not-run" }
  }
  return { said: " not run", state: "not-run" }
}

export function resolveTab(
  selected: string | undefined,
  detail: ChangeDetail,
): { tab: string; selectedSubIndex?: number } {
  const target = selected ?? defaultTab(detail.checks)
  if (target === CHANGES_TAB || target === "timeline") {
    return { tab: CHANGES_TAB }
  }
  if (STAGE_TABS.includes(target as StageTabName)) {
    return { tab: target }
  }
  const num = parseInt(target, 10)
  if (!Number.isNaN(num)) {
    return { selectedSubIndex: num, tab: "checking" }
  }
  if (target.startsWith("step:")) {
    const stepIdx = parseInt(target.slice(5), 10)
    const step = detail.journal?.steps[stepIdx]
    if (step) {
      if (["compose", "prepare", "read", "worktree"].includes(step.name)) {
        return { tab: "provisioning" }
      }
      if (["merge", "push", "publish", "notify"].includes(step.name)) {
        return { tab: "merging" }
      }
      if (["remove", "retain", "retire"].includes(step.name)) {
        return { tab: "deprovisioning" }
      }
    }
    return { tab: "provisioning" }
  }
  if (target === ROUND_TAB) {
    return { tab: "provisioning" }
  }
  return { tab: target }
}

function StageTabLabel({ detail, stage }: { detail: ChangeDetail; stage: StageTabName }) {
  const skipped = isStageSkipped(detail, stage)
  if (skipped) {
    return (
      <>
        <Text color="$fg-muted">{stage}</Text>
        {"\n"}
        <Text color="$fg-muted">− not run</Text>
      </>
    )
  }
  const info = stageInfo(detail, stage)
  const isRunning = info.state === "running"
  return (
    <>
      {stage}
      {"\n"}
      <Text color={CHECK_COLOR[info.state]}>{CHECK_GLYPH[info.state]}</Text>
      {isRunning && info.since !== undefined ? (
        <RunningFor since={info.since} />
      ) : info.ms !== undefined ? (
        <Text> {mediaDuration(info.ms)}</Text>
      ) : (
        <Text>{info.said ?? ""}</Text>
      )}
    </>
  )
}

function StageTabPanel({
  detail,
  stage,
  outputs,
  selectedSubIndex,
}: {
  detail: ChangeDetail
  stage: StageTabName
  outputs: ReadonlyMap<string, DiffText>
  selectedSubIndex?: number
}) {
  const skipped = isStageSkipped(detail, stage)
  if (skipped) {
    return (
      <ScrollArea>
        <TitledBox borderColor="$border-muted">
          <Text color="$fg-muted" bold>
            {stage.toUpperCase()} — NOT RUN
          </Text>
          <Box height={1} flexShrink={0} />
          {stage === "checking" && isMigratedWithoutCheckDetail(detail) ? (
            <Text color="$fg-warning" wrap="wrap">
              {detail.note}
            </Text>
          ) : (
            <Text color="$fg-muted">{stageSkipReason(detail, stage)}</Text>
          )}
        </TitledBox>
      </ScrollArea>
    )
  }

  const info = stageInfo(detail, stage)
  const borderColor = CHECK_COLOR[info.state]

  return (
    <ScrollArea>
      <TitledBox borderColor={borderColor} titleRight={stage}>
        {stage === "provisioning" && <ProvisioningStageBody detail={detail} outputs={outputs} />}
        {stage === "checking" && <CheckingStageBody detail={detail} selectedSubIndex={selectedSubIndex} />}
        {stage === "merging" && <MergingStageBody detail={detail} outputs={outputs} />}
        {stage === "deprovisioning" && <DeprovisioningStageBody detail={detail} outputs={outputs} />}
      </TitledBox>
    </ScrollArea>
  )
}

function ProvisioningStageBody({ detail, outputs }: { detail: ChangeDetail; outputs: ReadonlyMap<string, DiffText> }) {
  const steps = detail.journal?.steps ?? []
  const roundCommands = detail.journal?.commands ?? []
  const readStep = steps.find((s) => s.name === "read")
  const composeStep = steps.find((s) => s.name === "compose")
  const prepareStep = steps.find((s) => s.name === "prepare")
  const checksOff = areDeclaredChecksOff(detail)
  const setupChecks = detail.checks.filter((c) => c.name === "setup")

  const composingCommands = [...roundCommands, ...(readStep?.commands ?? []), ...(composeStep?.commands ?? [])]

  return (
    <Box flexDirection="column" minWidth={0} gap={1}>
      {/* Subphase 1: composing (the scratch worktree and the git-super merge result) */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color="$fg-info">
          COMPOSING
          {composeStep?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(composeStep.ms)}</Text> : null}
        </Text>
        <Text color="$fg-muted">scratch worktree and git-super merge result</Text>
        {composingCommands.length > 0 ? (
          <CommandsList commands={composingCommands} step={composeStep} outputs={outputs} />
        ) : null}
        {(composeStep?.parts ?? []).map((part) => (
          <Text key={part.name} color="$fg-muted">
            {part.name} {mediaDuration(part.ms)}
          </Text>
        ))}
        {composeStep !== undefined && composeStep.endedAt === undefined && composeStep.unended !== true ? (
          <Text color="$fg-info">still writing</Text>
        ) : null}
      </Box>

      <Box height={1} flexShrink={0} />

      {/* Subphase 2: preparing (the check worktree and its setup log) */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color={checksOff ? "$fg-muted" : "$fg-info"}>
          PREPARING
          {checksOff ? (
            <Text color="$fg-muted"> — skipped (all declared checks off)</Text>
          ) : prepareStep?.ms !== undefined ? (
            <Text color="$fg-muted"> · {mediaDuration(prepareStep.ms)}</Text>
          ) : null}
        </Text>
        <Text color="$fg-muted">check worktree and setup log</Text>
        {!checksOff && prepareStep?.commands !== undefined && prepareStep.commands.length > 0 ? (
          <CommandsList commands={prepareStep.commands} step={prepareStep} outputs={outputs} />
        ) : null}
        {!checksOff && setupChecks.length > 0
          ? setupChecks.map((setupCheck, idx) => (
              <Box key={`setup-${setupCheck.phase ?? idx}`} flexDirection="column" minWidth={0}>
                <Box flexDirection="row" minWidth={0} gap={1}>
                  <Text color={CHECK_COLOR[setupCheck.state]} bold>
                    {CHECK_GLYPH[setupCheck.state]}
                  </Text>
                  <Text bold>
                    {setupCheck.phase !== undefined && setupChecks.length > 1
                      ? `${setupCheck.name} (${String(setupCheck.phase)})`
                      : setupCheck.name}
                  </Text>
                  {setupCheck.result?.ms !== undefined ? (
                    <Text color="$fg-muted"> · {mediaDuration(setupCheck.result.ms)}</Text>
                  ) : null}
                </Box>
                <CheckBody check={setupCheck} />
              </Box>
            ))
          : null}
      </Box>
    </Box>
  )
}

function CheckingStageBody({ detail, selectedSubIndex }: { detail: ChangeDetail; selectedSubIndex?: number }) {
  const declaredChecks = detail.checks.filter((c) => c.phase !== "base" && c.name !== "setup")
  const baseChecks = detail.checks.filter((c) => c.phase === "base")
  const deferredChecks = detail.checks.filter((c) => c.state === "unmeasured" || c.result?.result === "deferred")

  if (selectedSubIndex !== undefined && detail.checks[selectedSubIndex] !== undefined) {
    const selectedCheck = detail.checks[selectedSubIndex]
    const remedy = detail.run.steps[selectedSubIndex]?.remedy
    return (
      <Box flexDirection="column" minWidth={0}>
        {detail.checks.length > 1 ? (
          <Box flexDirection="column" minWidth={0}>
            {detail.checks.map((c, idx) => (
              <Box key={`summary-${c.name}-${c.phase ?? idx}`} flexDirection="row" minWidth={0} gap={1}>
                <Text color={CHECK_COLOR[c.state]} bold>
                  {CHECK_GLYPH[c.state]}
                </Text>
                <Text bold={idx === selectedSubIndex}>
                  {c.phase !== undefined && detail.checks.filter((o) => o.name === c.name).length > 1
                    ? `${c.name} (${String(c.phase)})`
                    : c.name}
                </Text>
                {c.result?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(c.result.ms)}</Text> : null}
              </Box>
            ))}
            <Box height={1} flexShrink={0} />
          </Box>
        ) : null}
        <Box flexDirection="row" minWidth={0} gap={1}>
          <Text color={CHECK_COLOR[selectedCheck.state]} bold>
            {CHECK_GLYPH[selectedCheck.state]}
          </Text>
          <Text bold>
            {selectedCheck.phase !== undefined && detail.checks.filter((o) => o.name === selectedCheck.name).length > 1
              ? `${selectedCheck.name} (${String(selectedCheck.phase)})`
              : selectedCheck.name}
          </Text>
          {selectedCheck.result?.ms !== undefined ? (
            <Text color="$fg-muted"> · {mediaDuration(selectedCheck.result.ms)}</Text>
          ) : null}
        </Box>
        {remedy !== undefined ? (
          <Text color={CHECK_COLOR[selectedCheck.state]} wrap="wrap">
            {remedy}
          </Text>
        ) : null}
        <CheckBody check={selectedCheck} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" minWidth={0}>
      {declaredChecks.length === 0 ? (
        <Text color="$fg-muted">no declared checks</Text>
      ) : (
        declaredChecks.map((check, at) => {
          const remedy = detail.run.steps[at]?.remedy
          return (
            <Box key={`${check.name}-${check.phase ?? ""}-${at}`} flexDirection="column" minWidth={0}>
              <Box flexDirection="row" minWidth={0} gap={1}>
                <Text color={CHECK_COLOR[check.state]} bold>
                  {CHECK_GLYPH[check.state]}
                </Text>
                <Text bold>
                  {check.phase !== undefined && detail.checks.filter((o) => o.name === check.name).length > 1
                    ? `${check.name} (${String(check.phase)})`
                    : check.name}
                </Text>
                {check.result?.ms !== undefined ? (
                  <Text color="$fg-muted"> · {mediaDuration(check.result.ms)}</Text>
                ) : null}
              </Box>
              {remedy !== undefined ? (
                <Text color={CHECK_COLOR[check.state]} wrap="wrap">
                  {remedy}
                </Text>
              ) : null}
              <CheckBody check={check} />
            </Box>
          )
        })
      )}

      {/* Subphase 2: attributing (the base re-run after a failure) */}
      {baseChecks.length > 0 ? (
        <Box flexDirection="column" minWidth={0}>
          <Box height={1} flexShrink={0} />
          <Text bold color="$fg-info">
            ATTRIBUTING (base re-run after failure)
          </Text>
          {baseChecks.map((check, idx) => (
            <Box key={`base-${check.name}-${idx}`} flexDirection="column" minWidth={0}>
              <Box flexDirection="row" minWidth={0} gap={1}>
                <Text color={CHECK_COLOR[check.state]} bold>
                  {CHECK_GLYPH[check.state]}
                </Text>
                <Text bold>{check.name} (base)</Text>
                {check.result?.ms !== undefined ? (
                  <Text color="$fg-muted"> · {mediaDuration(check.result.ms)}</Text>
                ) : null}
              </Box>
              <CheckBody check={check} />
            </Box>
          ))}
        </Box>
      ) : null}

      {/* Subphase 3: deferring (handed to the long tier) */}
      {deferredChecks.length > 0 ? (
        <Box flexDirection="column" minWidth={0}>
          <Box height={1} flexShrink={0} />
          <Text bold color="$fg-warning">
            DEFERRING
          </Text>
          <Text color="$fg-muted">handed to the long tier</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function MergingStageBody({ detail, outputs }: { detail: ChangeDetail; outputs: ReadonlyMap<string, DiffText> }) {
  const steps = detail.journal?.steps ?? []
  const publishStep = steps.find((s) => s.name === "publish" || s.name === "components")
  const mergeStep = steps.find((s) => s.name === "merge" || s.name === "push")
  const notifyStep = steps.find((s) => s.name === "notify")
  const mergeCommit = detail.row.merge ?? detail.journal?.merge

  return (
    <Box flexDirection="column" minWidth={0} gap={1}>
      {/* Subphase 1: publishing components */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color="$fg-info">
          PUBLISHING COMPONENTS
          {publishStep?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(publishStep.ms)}</Text> : null}
        </Text>
        {publishStep?.commands !== undefined && publishStep.commands.length > 0 ? (
          <CommandsList commands={publishStep.commands} step={publishStep} outputs={outputs} />
        ) : (
          <Text color="$fg-muted">component pins published</Text>
        )}
      </Box>

      <Box height={1} flexShrink={0} />

      {/* Subphase 2: publishing root (the CAS; a moved root retries) */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color="$fg-info">
          PUBLISHING ROOT
          {mergeStep?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(mergeStep.ms)}</Text> : null}
        </Text>
        {mergeCommit !== undefined ? <Text color="$fg-success">CAS merge commit: {mergeCommit}</Text> : null}
        {mergeStep?.commands !== undefined && mergeStep.commands.length > 0 ? (
          <CommandsList commands={mergeStep.commands} step={mergeStep} outputs={outputs} />
        ) : null}
      </Box>

      <Box height={1} flexShrink={0} />

      {/* Subphase 3: notifying */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color="$fg-info">
          NOTIFYING
          {notifyStep?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(notifyStep.ms)}</Text> : null}
        </Text>
        {notifyStep?.commands !== undefined && notifyStep.commands.length > 0 ? (
          <CommandsList commands={notifyStep.commands} step={notifyStep} outputs={outputs} />
        ) : (
          <Text color="$fg-muted">receipts sent</Text>
        )}
      </Box>
    </Box>
  )
}

function DeprovisioningStageBody({
  detail,
  outputs,
}: {
  detail: ChangeDetail
  outputs: ReadonlyMap<string, DiffText>
}) {
  const steps = detail.journal?.steps ?? []
  const removeStep = steps.find((s) => s.name === "remove" || s.name === "retain")
  const retireStep = steps.find((s) => s.name === "retire")

  return (
    <Box flexDirection="column" minWidth={0} gap={1}>
      {/* Subphase 1: removing or retaining (path shown) */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color="$fg-info">
          REMOVING OR RETAINING
          {removeStep?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(removeStep.ms)}</Text> : null}
        </Text>
        {removeStep?.commands !== undefined && removeStep.commands.length > 0 ? (
          <CommandsList commands={removeStep.commands} step={removeStep} outputs={outputs} />
        ) : (
          <Text color="$fg-muted">worktree deprovisioned</Text>
        )}
      </Box>

      <Box height={1} flexShrink={0} />

      {/* Subphase 2: retiring */}
      <Box flexDirection="column" minWidth={0}>
        <Text bold color="$fg-info">
          RETIRING
          {retireStep?.ms !== undefined ? <Text color="$fg-muted"> · {mediaDuration(retireStep.ms)}</Text> : null}
        </Text>
        {retireStep?.commands !== undefined && retireStep.commands.length > 0 ? (
          <CommandsList commands={retireStep.commands} step={retireStep} outputs={outputs} />
        ) : (
          <Text color="$fg-muted">branch retired</Text>
        )}
      </Box>
    </Box>
  )
}

function CommandsList({
  commands,
  step,
  outputs,
}: {
  commands: readonly JournalCommand[]
  step?: JournalStep
  outputs: ReadonlyMap<string, DiffText>
}) {
  return (
    <Box flexDirection="column" minWidth={0}>
      {commands.map((command, index) => {
        const output = outputs.get(commandKey(command))
        return (
          <Box key={`${String(index)}:${commandKey(command)}`} flexDirection="column" minWidth={0}>
            <Text wrap="wrap">
              <Text bold>$ git {command.args.join(" ")}</Text>
              {command.exit === undefined || command.exit === 0 ? null : (
                <Text color="$fg-error"> exit {String(command.exit)}</Text>
              )}
            </Text>
            {command.failure !== undefined ? (
              <Text color="$fg-muted" wrap="wrap">
                it failed before writing output: {command.failure}
              </Text>
            ) : output === undefined ? (
              <Text color="$fg-muted">reading its output…</Text>
            ) : output.text === undefined ? (
              <Text color="$fg-muted" wrap="wrap">
                {output.why ?? "no output was read"}
              </Text>
            ) : output.text === "" ? null : (
              <Text wrap="wrap">{output.text}</Text>
            )}
          </Box>
        )
      })}
      {(step?.parts ?? []).map((part) => (
        <Text key={part.name} color="$fg-muted">
          {part.name} {mediaDuration(part.ms)}
        </Text>
      ))}
      {step !== undefined && step.endedAt === undefined && step.unended !== true ? (
        <Text color="$fg-info">still writing</Text>
      ) : null}
    </Box>
  )
}

/** One tab of the detail after the Timeline: a stage, a check, a step of the round, or the round's own commands. */
export type StageTab =
  | Readonly<{ kind: "stage"; value: StageTabName; stage: StageTabName }>
  | Readonly<{ kind: "check"; value: string; at: number }>
  | Readonly<{ kind: "step"; value: string; step: JournalStep }>
  | Readonly<{ kind: "round"; value: typeof ROUND_TAB; commands: readonly JournalCommand[] }>

/** The tab of the git commands the round ran outside any step: shown only when there are some. */
export const ROUND_TAB = "round"

export function stagesOf(_detail: ChangeDetail): readonly StageTab[] {
  return STAGE_TABS.map((stage) => ({
    kind: "stage" as const,
    stage,
    value: stage,
  }))
}

/** The git commands a tab shows, for the pane to read their output when it opens. */
export function commandsOfTab(detail: ChangeDetail, tab: string | undefined): readonly JournalCommand[] {
  const resolved = resolveTab(tab, detail).tab
  const steps = detail.journal?.steps ?? []
  if (resolved === "provisioning") {
    const round = detail.journal?.commands ?? []
    const read = steps.find((s) => s.name === "read")?.commands ?? []
    const compose = steps.find((s) => s.name === "compose")?.commands ?? []
    const prepare = steps.find((s) => s.name === "prepare")?.commands ?? []
    return [...round, ...read, ...compose, ...prepare]
  }
  if (resolved === "merging") {
    const publish = steps.find((s) => s.name === "publish" || s.name === "components")?.commands ?? []
    const merge = steps.find((s) => s.name === "merge" || s.name === "push")?.commands ?? []
    const notify = steps.find((s) => s.name === "notify")?.commands ?? []
    return [...publish, ...merge, ...notify]
  }
  if (resolved === "deprovisioning") {
    const remove = steps.find((s) => s.name === "remove" || s.name === "retain")?.commands ?? []
    const retire = steps.find((s) => s.name === "retire")?.commands ?? []
    return [...remove, ...retire]
  }
  if (resolved === "checking") {
    const checkSteps = steps.filter(
      (s) =>
        ![
          "compose",
          "prepare",
          "read",
          "worktree",
          "publish",
          "merge",
          "push",
          "notify",
          "remove",
          "retain",
          "retire",
        ].includes(s.name),
    )
    return checkSteps.flatMap((s) => s.commands)
  }
  return []
}

/** A command's key in the outputs map: its own stdout file, which no other command shares. */
export function commandKey(command: JournalCommand): string {
  return command.stdout ?? `${command.cwd}\u0000${command.args.join("\u0000")}`
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

export type DetailStepEntry = Readonly<{
  name: string
  kind: "step" | "check"
  startedAt: Date
  endedAt?: Date
  ms?: number
}>

/** The change's steps and checks from its journal in chronological order (25716). */
export function detailSteps(detail: ChangeDetail): readonly DetailStepEntry[] {
  const steps: DetailStepEntry[] = []
  if (detail.journal?.steps) {
    for (const s of detail.journal.steps) {
      steps.push({ name: s.name, kind: "step", startedAt: s.startedAt, endedAt: s.endedAt, ms: s.ms })
    }
  }
  if (detail.journal?.checks) {
    for (const c of detail.journal.checks) {
      steps.push({ name: c.name, kind: "check", startedAt: c.startedAt, endedAt: c.endedAt, ms: c.ms })
    }
  }
  return steps.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
}

/** Lists a running change's steps with start and end times from the journal (25716). */
function RunningSteps({ detail }: { detail: ChangeDetail }) {
  const isRunning =
    detail.row.live !== undefined ||
    detail.row.state === "checking" ||
    detail.row.state === "verifying" ||
    detail.journal?.running !== undefined
  if (!isRunning && detail.journal === undefined) return null
  const steps = detailSteps(detail)
  if (steps.length === 0) return null
  return (
    <Box flexDirection="column" minWidth={0}>
      <Box height={1} flexShrink={0} />
      <Text color="$fg-muted" bold>
        STEPS
      </Text>
      {steps.map((step, idx) => {
        const start = clock(step.startedAt, { seconds: true })
        const end = step.endedAt !== undefined ? clock(step.endedAt, { seconds: true }) : "running"
        const elapsed =
          step.ms !== undefined
            ? mediaDuration(step.ms)
            : step.endedAt !== undefined
              ? mediaDuration(step.endedAt.getTime() - step.startedAt.getTime())
              : undefined
        return (
          <Box key={`${step.name}-${idx}`} flexDirection="row" minWidth={0} gap={1}>
            <Text color="$fg-muted" flexShrink={0}>
              {start} – {end}
            </Text>
            {elapsed === undefined ? null : (
              <Text color="$fg-muted" flexShrink={0}>
                ({elapsed})
              </Text>
            )}
            <Text wrap="truncate">{step.name}</Text>
          </Box>
        )
      })}
    </Box>
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
      <RunningSteps detail={detail} />
      <Box height={1} flexShrink={0} />
      <Text color="$fg-warning" wrap="wrap">
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
 * The fold at the bottom of every change box: `► Diff +A −B`, opening onto
 * the unified diff. A composition of Box and Text rather than silvery's
 * `Accordion`, whose header draws ASCII `>`/`v` and takes no glyph: the plain
 * triangle is item 5's rule, shared with STATS through Silvery's disclosure
 * markers. Click or `v` toggles; the reading is the loader's.
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
