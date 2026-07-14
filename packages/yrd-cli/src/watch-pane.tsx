import { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput, useScopeEffect } from "silvery"
import { QueueTimelineView, QueueWatchView, queueTimelineRows, type QueueStatusResult } from "./queue-status-view.tsx"

export type QueueWatchSnapshot = Readonly<{
  results: readonly QueueStatusResult[]
  now: number
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
  const rows = useMemo(() => queueTimelineRows(snapshot.results, snapshot.now, false), [snapshot.results, snapshot.now])
  const [cursor, setCursor] = useState(0)
  const [selectedPr, setSelectedPr] = useState<string | undefined>(() => pr ?? rows[0]?.pr)

  useEffect(() => {
    if (rows.length === 0) {
      setCursor(0)
      setSelectedPr(pr)
      return
    }
    const nextCursor = Math.min(cursor, rows.length - 1)
    if (nextCursor !== cursor) setCursor(nextCursor)
    const nextSelected = selectedPr === undefined ? rows[nextCursor]?.pr : rows.find((row) => row.pr === selectedPr)?.pr
    if (nextSelected === undefined) setSelectedPr(rows[nextCursor]?.pr)
  }, [cursor, pr, rows, selectedPr])

  const detailPr = pr ?? selectedPr
  return (
    <Box flexDirection="column">
      <QueueTimelineView
        results={snapshot.results}
        now={snapshot.now}
        nav
        cursorKey={cursor}
        onCursor={setCursor}
        onSelect={(index) => setSelectedPr(rows[index]?.pr)}
      />
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
