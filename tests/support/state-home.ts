/**
 * Every yrd test run has its state home pinned to a throwaway root
 * (@i/17-test-system/25256).
 *
 * `hostWorkdir` (packages/yrd-cli/src/queue-location.ts) falls back to
 * `$XDG_STATE_HOME/yrd`, then `$HOME/.local/state/yrd`, when a repository sets
 * no `git config yrd.workdir`. Almost no fixture sets one, so every queue-owned
 * clone a test made landed in the operator's real state directory, beside the
 * real github.com queue: 13,449 fixture roots and 12 GB under
 * ~/.local/state/yrd/local/tmp, measured 2026-09-24. The bun-install fixtures
 * (env-open, queue-core run) filled `~/.bun/install/cache` the same way.
 *
 * The pin is written at CONFIG LOAD, in the Vitest main process, before any
 * worker exists. A per-file setup was measured insufficient on the same day:
 * `process.env.X = v` inside a worker reaches the in-process resolver and a
 * spawn given `env: process.env`, but a bare `Bun.spawn(argv)` takes the
 * worker's STARTUP environ, so uri-queue's submit still wrote the real home.
 * Workers inherit the main process's env, so a pin that precedes them reaches
 * every spawn shape. A test that pins its own `XDG_STATE_HOME` or `HOME`
 * keeps it. The root is removed by the paired globalSetup teardown.
 */

import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT_VARIABLE = "YRD_TEST_STATE_ROOT"

/**
 * Pin once per Vitest main process; a second config evaluation keeps the first
 * root. Nothing is created here: the root is named after the main process and
 * comes into being only when a fixture's first clone or install writes under
 * it, so a config evaluation that runs no yrd test leaves nothing behind.
 */
export function pinYrdTestStateHome(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env[ROOT_VARIABLE]
  if (existing !== undefined && existing !== "") return existing
  const root = join(tmpdir(), `yrd-test-state-${String(process.pid)}`)
  env[ROOT_VARIABLE] = root
  env.XDG_STATE_HOME = join(root, "state")
  env.BUN_INSTALL_CACHE_DIR = join(root, "bun-install-cache")
  return root
}

/** Vitest globalSetup: the pin already happened at config load, so setup only checks it is there. */
export function setup(): void {
  const root = process.env[ROOT_VARIABLE]
  if (root === undefined || root === "") {
    throw new Error("yrd test state home: the config did not call pinYrdTestStateHome() before the run")
  }
}

/** Vitest globalSetup: removes the pinned root after the run. */
export function teardown(): void {
  const root = process.env[ROOT_VARIABLE]
  if (root === undefined || root === "") return
  rmSync(root, { force: true, recursive: true })
}
