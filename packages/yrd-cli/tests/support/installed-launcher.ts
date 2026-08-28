/**
 * @failure The `yrd watch` integration drills used to share one launcher path
 * across every PROCESS in a worktree, keyed only by a hash of the worktree
 * root. Two concurrent vitest invocations against the same checkout — two
 * sibling agents, or a full-suite run overlapping a targeted one — raced to
 * (re)write the same file: whoever installed or removed it last decided
 * whether the other run found a launcher at all (2026-08-28, S7 integration
 * flake hunt). The path is now unique per process, so concurrent runs in the
 * same worktree never touch each other's launcher.
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
 * Keyed by the worktree path so two checkouts never share a launcher, AND by
 * this process's pid so two concurrent runs against the SAME worktree never
 * share one either — the file used to be worktree-only, and a second vitest
 * invocation racing this one's (re)write decided whether either run found a
 * launcher at all. Cost: every process builds its own copy instead of reusing
 * one across runs, which is fine — `installedYrdLauncher` below is one write.
 */
const launcherDir = join(
  tmpdir(),
  `yrd-launcher-${createHash("sha256").update(yrdRoot).digest("hex").slice(0, 16)}-${process.pid}`,
)

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
 * Path to this process's production `yrd` launcher, building it on first use.
 *
 * Building costs one small write, so there is no cache to invalidate and no
 * staleness to reason about: every call rewrites deterministic content. The
 * write merges through a rename so a second CALL in this same process can
 * never observe a half-written script — and since `launcherDir` is now
 * per-pid, a concurrent process's own build can never race this one's.
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
