#!/usr/bin/env bun
import { runYrdProcess } from "../packages/yrd-cli/src/index.ts"

process.exitCode = await runYrdProcess()
