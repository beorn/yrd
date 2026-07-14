import { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput, useScopeEffect } from "silvery"
import {
  QueueTimelineView,
  QueueWatchView,
  queueTimelineRows,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "./queue-status-view.tsx"

export type QueueWatchSnapshot = Readonly<{
  results: readonly QueueStatusResult[]
  now: number
  projection?: QueueTimelineProjection
}>

export type WatchControl = Readonly<{ paused: boolean }>

export type QueueWatchPaneProps = Readonly<{
  initial: QueueWatchSnapshot
  load(): Promise<QueueWatchSnapshot>
  intervalMs: number
  pr?: string
}>

export function reduceWatchControl(control: WatchControl, input: string): WatchControl | "exit" {
  if (input === "q") return "exit"
  if (input === "p") return { paused: !control.paused }
  return control
}

export function QueueWatchFrame({
  snapshot,
  paused,
  pr,
}: {
  snapshot: QueueWatchSnapshot
  paused: boolean
  pr?: string
}) {
  const rows = useMemo(
    () =>
      snapshot.projection === undefined
        ? queueTimelineRows(snapshot.results, snapshot.now, false).map((row) => ({ key: row.key, pr: row.pr }))
        : snapshot.projection.rows.map((row) => ({ key: row.id, pr: row.prs[0] })),
    [snapshot],
  )
  const [cursorRowKey, setCursorRowKey] = useState<string | undefined>(() => rows[0]?.key)
  const [selectedPr, setSelectedPr] = useState<string | undefined>(() => pr ?? rows[0]?.pr)
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
    const selected = rows.find((row) => row.key === cursorRowKey) ?? rows[0]
    if (selected === undefined) return
    if (selected.key !== cursorRowKey) setCursorRowKey(selected.key)
    if (selected.pr !== selectedPr) setSelectedPr(selected.pr)
  }, [cursorRowKey, pr, rows, selectedPr])

  const selectRow = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setCursorRowKey(row.key)
    setSelectedPr(row.pr)
  }

  const detailPr = pr ?? selectedPr
  return (
    <Box flexDirection="column">
      {snapshot.projection === undefined ? (
        <QueueTimelineView
          results={snapshot.results}
          now={snapshot.now}
          nav
          cursorKey={cursor}
          onCursor={selectRow}
          onSelect={selectRow}
        />
      ) : (
        <QueueTimelineView
          projection={snapshot.projection}
          nav
          cursorKey={cursor}
          onCursor={selectRow}
          onSelect={selectRow}
        />
      )}
      {detailPr === undefined ? null : (
        <Box marginTop={1}>
          <QueueWatchView results={snapshot.results} now={snapshot.now} pr={detailPr} />
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>{paused ? "PAUSED" : "LIVE"}</Text>
        <Text color="$fg-muted"> {paused ? "p resume" : "p pause"} q quit</Text>
      </Box>
    </Box>
  )
}

export function QueueWatchPane({ initial, load, intervalMs, pr }: QueueWatchPaneProps) {
  const [snapshot, setSnapshot] = useState(initial)
  const [control, setControl] = useState<WatchControl>({ paused: false })
  const [failure, setFailure] = useState<Error | undefined>()

  useInput((input) => {
    const next = reduceWatchControl(control, input)
    if (next === "exit") return "exit"
    if (next !== control) setControl(next)
  })

  useScopeEffect(
    (scope) => {
      if (control.paused) return
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
    [control.paused, intervalMs, load],
  )

  if (failure !== undefined) throw failure
  return <QueueWatchFrame snapshot={snapshot} paused={control.paused} {...(pr === undefined ? {} : { pr })} />
}
