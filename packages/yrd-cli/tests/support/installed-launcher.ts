/**
 * @failure The `yrd watch` integration drills share one launcher across every
 * checkout on the box, so concurrent runs decide each other's results: whoever
 * installs or removes it last decides whether the other runs find a launcher at
 * all, and every run executes that one checkout's working tree instead of the
 * tree under test.
 * @consumer @yrd/cli tests
 *
 * The drills need a launcher that starts `yrd` the way production does — a real
 * process under a production environment, not Vitest's transform pipeline. They
 * used to reach for a launcher installed outside the package, which is neither
 * reachable from a standalone clone nor private to one worktree. This builds an
 * equivalent launcher per worktree instead, from that worktree's own entrypoint.
 */
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** The worktree these tests belong to: `packages/yrd-cli/tests/support` → root. */
export const yrdRoot = resolve(import.meta.dirname, "../../../..")

/**
 * Keyed by the worktree path so two checkouts never share a launcher, and
 * stable within a worktree so repeated runs reuse one built file.
 */
const launcherDir = join(tmpdir(), `yrd-launcher-${createHash("sha256").update(yrdRoot).digest("hex").slice(0, 16)}`)

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The production launch contract: a Silvery host runs under NODE_ENV=production
 * unless the caller pinned one, and Bun's runtime transpiler cache stays off so
 * a bucket holding a test-mode JSX transform can never be read back into a
 * production render.
 */
const launcherScript = `#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV="\${NODE_ENV:-production}"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

exec bun ${shellQuote(join(yrdRoot, "bin/yrd.ts"))} "$@"
`

let launcherPath: string | undefined

/**
 * Path to this worktree's production `yrd` launcher, building it on first use.
 *
 * Building costs one small write, so there is no cache to invalidate and no
 * staleness to reason about: every call rewrites deterministic content. The
 * write merges through a rename so a second run in the same worktree can never
 * observe a half-written script.
 */
export function installedYrdLauncher(): string {
  if (launcherPath !== undefined) return launcherPath
  const path = join(launcherDir, "yrd")
  const staging = `${path}.${process.pid}.staging`
  mkdirSync(launcherDir, { recursive: true })
  writeFileSync(staging, launcherScript)
  chmodSync(staging, 0o755)
  renameSync(staging, path)
  launcherPath = path
  return path
}
