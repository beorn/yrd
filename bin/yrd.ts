#!/usr/bin/env bun

// This is the whole entry: no launcher runs before it, and nothing here checks
// whether the source it was started from is current. A freshness guard placed
// in this file could only ever be run BY the source under suspicion, which
// passes itself; the check belongs at the target's own gitlink, which is what
// `yrd queue up` reads before every round and exits for a relaunch on.

import { runYrdExecutable } from "../packages/yrd-cli/src/cli.ts"

// This bin is the standalone repository case: there is no host to ask about branch holds,
// so it says so in one visible line rather than leaving the reader absent. An embedder that
// HAS a host must pass its reader here; it can no longer forget and look like this (#29648).
await runYrdExecutable({ localBranchProtections: null })
