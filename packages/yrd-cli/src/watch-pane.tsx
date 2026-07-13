import { useEffect, useState } from "react"
import { Box, Text, useInput, useScopeEffect } from "silvery"
import {
  QueueShowView,
  QueueTimelineView,
  type QueueStatusResult,
  type QueueTimelineRow,
  type QueueTimelineProjection,
} from "./queue-status-view.tsx"

export type QueueWatchSnapshot = Readonly<{
  results: readonly QueueStatusResult[]
  projection: QueueTimelineProjection
  now: number
}>

export type WatchControl = Readonly<{ paused: boolean }>

export type QueueWatchPaneProps = Readonly<{
  initial: QueueWatchSnapshot
  load(): Promise<QueueWatchSnapshot>
  intervalMs: number
}>

export function reduceWatchControl(control: WatchControl, input: string): WatchControl | "exit" {
  if (input === "q") return "exit"
  if (input === "p") return { paused: !control.paused }
  return control
}

export function QueueWatchFrame({ snapshot, paused }: { snapshot: QueueWatchSnapshot; paused: boolean }) {
  const [cursorId, setCursorId] = useState<string | number | null>(() => snapshot.projection.rows.at(-1)?.id ?? null)
  const [selectedRun, setSelectedRun] = useState<string | undefined>()
  const [filterOpen, setFilterOpen] = useState(false)
  const detail = snapshot.projection.details.find((candidate) => candidate.run === selectedRun)
  const selectedRow = snapshot.projection.rows.find((row) => row.id === cursorId)
  useEffect(() => {
    if (selectedRow !== undefined) return
    setCursorId(snapshot.projection.rows.at(-1)?.id ?? null)
  }, [selectedRow, snapshot.projection.rows])
  const openRow = (row: QueueTimelineRow | undefined) => {
    if (row?.run !== undefined) setSelectedRun(row.run)
  }
  useInput((input, key) => {
    if (key.escape) {
      if (detail !== undefined) setSelectedRun(undefined)
      else if (filterOpen) setFilterOpen(false)
      return
    }
    if (detail !== undefined || filterOpen) return
    if (input === "o") openRow(selectedRow)
    if (input === "f") setFilterOpen(true)
  })

  return (
    <Box flexDirection="column">
      {detail !== undefined ? (
        <Box flexDirection="column">
          <Box height={1}>
            <Text bold>RUN DETAIL {detail.run}</Text>
            <Text color="$fg-muted"> Esc back</Text>
          </Box>
          <QueueShowView data={detail} />
        </Box>
      ) : filterOpen ? (
        <Box flexDirection="column">
          <Box height={1}>
            <Text bold>FILTER</Text>
            <Text color="$fg-muted"> Esc back</Text>
          </Box>
          <Text>
            base={snapshot.projection.base} since={snapshot.projection.filters.since} status=
            {snapshot.projection.filters.statuses.join(",")} latest={String(snapshot.projection.filters.latest)} terms=
            {snapshot.projection.filters.terms.join("|") || "-"}
          </Text>
        </Box>
      ) : (
        <QueueTimelineView
          projection={snapshot.projection}
          interactive
          cursorId={cursorId}
          onActivate={openRow}
          onCursorIdChange={setCursorId}
        />
      )}
      <Box marginTop={1} height={1}>
        <Text wrap="truncate">
          <Text bold>MODE {paused ? "PAUSED" : "LIVE  "}</Text>
          <Text color="$fg-muted"> p toggle Enter detail o evidence f filter q quit</Text>
        </Text>
      </Box>
    </Box>
  )
}

export function QueueWatchPane({ initial, load, intervalMs }: QueueWatchPaneProps) {
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
  return <QueueWatchFrame snapshot={snapshot} paused={control.paused} />
}
