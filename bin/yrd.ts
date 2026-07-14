#!/usr/bin/env bun
import { runYrdProcess } from "../packages/yrd-cli/src/index.ts"
import { superviseYrdWatch } from "../packages/yrd-cli/src/watch-hot-reload.ts"

const args = process.argv.slice(2)
const supervised = await superviseYrdWatch({
  args,
  execArgv: process.execArgv,
  execPath: process.execPath,
  scriptPath: process.argv[1] ?? import.meta.path,
  spawn: (command, options) => Bun.spawn(command, options),
})
if (supervised !== undefined) {
  process.exitCode = supervised
} else {
  const exitCode = await runYrdProcess()
  if (process.execArgv.includes("--watch")) {
    // Bun's watch supervisor intentionally stays resident after its program
    // returns. QueueWatch `q` is a process-exit contract, so terminate only the
    // supervised inner process after Silvery and the Yrd host have disposed.
    process.exit(exitCode)
  }
  process.exitCode = exitCode
}
