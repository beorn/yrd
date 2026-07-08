import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, repoScopedCleanEnv } from "./layers/git.ts"

/**
 * Scratch workspaces — the intent-level seam between line code and raw
 * `git worktree` calls (SG-4, @hab/20926-gitbay/21000). Line code (batch
 * build, the bisect gate, a bayless PR's check) asks for "a workspace at
 * <ref> I can run a command in"; THIS module owns how one is made, provisioned,
 * and returned. On a plain repo the default is exactly the old behavior — a
 * detached `git worktree add` — so zero-config stays zero-cost. On a repo whose
 * gates need more than a bare checkout (submodules, installed dependencies,
 * hooks), `bay.provision` names the command that makes a scratch runnable, and
 * a provision failure is an ENVIRONMENT fault (`ProvisionError`) — callers must
 * never attribute it to the work being checked.
 */

/** A provision command failed — the scratch could not be made runnable. This is
 *  an infrastructure/environment verdict about the workspace, never about the
 *  ref checked out into it; batch recovery refuses (ejecting nobody) and a
 *  serial check rejects with code `provision-failed`, not `check-failed`. */
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisionError"
  }
}

export type ScratchLease = {
  path: string
  dispose(): Promise<void>
}

export type ScratchWorkspaces = {
  /** Create a temporary workspace with `ref` checked out. `provision: true`
   *  additionally runs the configured provision command inside it (throws
   *  ProvisionError on nonzero exit); acquisitions that only need git plumbing
   *  (e.g. composing batch merge commits) skip provisioning by default. */
  acquire(ref: string, opts?: { provision?: boolean }): Promise<ScratchLease>
}

export type ScratchOptions = {
  /** The repo whose refs scratches check out (worktrees share its object store). */
  mainRepo: string
  /** Mostly for tests; defaults to the OS temp dir. */
  scratchParent?: string
  /** Command run inside a provisioned scratch (cwd = the scratch) before any
   *  gate/check uses it — `git config bay.provision` / `BAY_PROVISION` at the
   *  CLI host. Unset means a bare checkout is already runnable. */
  provisionCommand?: string
  /** mkdtemp prefix; default `gitbay-scratch-`. */
  prefix?: string
}

function tail(text: string, max = 1200): string {
  const trimmed = text.replace(/\s+$/u, "")
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

export function createScratchWorkspaces(opts: ScratchOptions): ScratchWorkspaces {
  async function dispose(path: string): Promise<void> {
    const removed = await git(["-C", opts.mainRepo, "worktree", "remove", "--force", path], opts.mainRepo)
    if (removed.code !== 0) await rm(path, { recursive: true, force: true })
  }

  async function provision(path: string, ref: string): Promise<void> {
    const command = opts.provisionCommand
    if (command === undefined || command.trim() === "") return
    const env = { ...repoScopedCleanEnv(), BAY_SCRATCH_PATH: path, BAY_SCRATCH_REF: ref }
    const proc = Bun.spawn(["sh", "-c", command], { cwd: path, stdout: "pipe", stderr: "pipe", env })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code === 0) return
    const out = tail([stderr, stdout].filter((s) => s.trim() !== "").join("\n"))
    throw new ProvisionError(
      `bay: provision '${command}' failed (exit ${code}) in the scratch for '${ref}'${out === "" ? "" : `:\n${out}`}`,
    )
  }

  return {
    async acquire(ref, acquireOpts) {
      const path = await mkdtemp(join(opts.scratchParent ?? tmpdir(), opts.prefix ?? "gitbay-scratch-"))
      const added = await git(["-C", opts.mainRepo, "worktree", "add", "--detach", path, ref], opts.mainRepo)
      if (added.code !== 0) {
        await rm(path, { recursive: true, force: true })
        throw new Error(`bay: scratch worktree add for '${ref}' failed (exit ${added.code}):\n${added.stderr.trim()}`)
      }
      if (acquireOpts?.provision === true) {
        try {
          await provision(path, ref)
        } catch (err) {
          await dispose(path)
          throw err
        }
      }
      return { path, dispose: () => dispose(path) }
    },
  }
}
