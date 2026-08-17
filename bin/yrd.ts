#!/usr/bin/env bun

// This is the whole entry: no launcher runs before it, and nothing here checks
// whether the source it was started from is current. A freshness guard placed
// in this file could only ever be run BY the source under suspicion, which
// passes itself; the check belongs at the journal every source writes to, and
// is tracked upstream as @yrd/core/shim-source-guard.

import { runYrdExecutable } from "../packages/yrd-cli/src/host.ts"
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
  await runYrdExecutable()
}
