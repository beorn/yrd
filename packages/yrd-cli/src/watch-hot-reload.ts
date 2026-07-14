export type WatchSignal = "SIGINT" | "SIGTERM"

export type WatchProcess = Readonly<{
  exited: Promise<number>
  kill(signal: WatchSignal): void
}>

export type WatchSignals = Readonly<{
  on(signal: WatchSignal, listener: () => void): void
  off(signal: WatchSignal, listener: () => void): void
}>

export type WatchProcessSpawn = (
  command: string[],
  options: Readonly<{ stdin: "inherit"; stdout: "inherit"; stderr: "inherit" }>,
) => WatchProcess

export type YrdWatchSupervisorOptions = Readonly<{
  args: readonly string[]
  execArgv: readonly string[]
  execPath: string
  scriptPath: string
  spawn: WatchProcessSpawn
  signals?: WatchSignals
}>

/**
 * Put the production `yrd watch` entry under Bun's existing process supervisor.
 * The supervised child remains the sole QueueWatch renderer and inherits the
 * caller's terminal; Bun replaces that child when an imported Yrd/Silvery file
 * changes. An inner `--watch` process returns `undefined` so it cannot nest a
 * second supervisor.
 */
export async function superviseYrdWatch(options: YrdWatchSupervisorOptions): Promise<number | undefined> {
  if (yrdCommandOperand(options.args) !== "watch" || options.execArgv.includes("--watch")) return undefined
  const child = options.spawn([options.execPath, "--watch", "--no-clear-screen", options.scriptPath, ...options.args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const signals =
    options.signals ??
    ({
      on: (signal, listener) => process.on(signal, listener),
      off: (signal, listener) => process.off(signal, listener),
    } satisfies WatchSignals)
  const onSigint = () => child.kill("SIGINT")
  const onSigterm = () => child.kill("SIGTERM")
  signals.on("SIGINT", onSigint)
  signals.on("SIGTERM", onSigterm)
  try {
    return await child.exited
  } finally {
    signals.off("SIGINT", onSigint)
    signals.off("SIGTERM", onSigterm)
  }
}
import { yrdCommandOperand } from "./invocation.ts"
