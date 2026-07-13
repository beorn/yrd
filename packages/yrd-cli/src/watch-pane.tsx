import { useState } from "react"
import { Box, Text, useInput, useScopeEffect } from "silvery"
import { LineWatchView, type LineStatusResult } from "./line-status-view.tsx"

export type LineWatchSnapshot = Readonly<{
  results: readonly LineStatusResult[]
  now: number
}>

export type WatchControl = Readonly<{ paused: boolean }>

export type LineWatchPaneProps = Readonly<{
  initial: LineWatchSnapshot
  load(): Promise<LineWatchSnapshot>
  intervalMs: number
}>

export function reduceWatchControl(control: WatchControl, input: string): WatchControl | "exit" {
  if (input === "q") return "exit"
  if (input === "p") return { paused: !control.paused }
  return control
}

export function LineWatchFrame({ snapshot, paused }: { snapshot: LineWatchSnapshot; paused: boolean }) {
  return (
    <Box flexDirection="column">
      <LineWatchView results={snapshot.results} now={snapshot.now} />
      <Box marginTop={1}>
        <Text bold>{paused ? "PAUSED" : "LIVE"}</Text>
        <Text color="$fg-muted"> {paused ? "p resume" : "p pause"} q quit</Text>
      </Box>
    </Box>
  )
}

export function LineWatchPane({ initial, load, intervalMs }: LineWatchPaneProps) {
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
  return <LineWatchFrame snapshot={snapshot} paused={control.paused} />
}
