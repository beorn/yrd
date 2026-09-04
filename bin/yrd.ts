#!/usr/bin/env bun

// This is the whole entry: no launcher runs before it, and nothing here checks
// whether the source it was started from is current. A freshness guard placed
// in this file could only ever be run BY the source under suspicion, which
// passes itself; the check belongs at the target's own gitlink, which is what
// `yrd queue up` reads before every round and exits for a relaunch on.

import { runYrdExecutable } from "../packages/yrd-cli/src/cli.ts"

await runYrdExecutable()
