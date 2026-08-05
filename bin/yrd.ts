#!/usr/bin/env bun
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
