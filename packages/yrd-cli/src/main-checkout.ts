/**
 * The MAIN-checkout ("landed root") rule — the ONE copy (hh 38659, @cto 1444899a D2).
 *
 * Two readers: Yrd's workdir resolution (queue-location.ts, the `yrd.workdir` the repository Yrd ships in declares)
 * and the host launcher (`tools/yrd-runtime.mjs`, which runs the fleet's current runtime from shared main). The
 * launcher loads this file BEFORE any Yrd module or install, so it imports nothing beyond node:fs and node:path, and must
 * stay that way. Git runs through Bun's own `Bun.spawnSync` (as version.ts does), never node:child_process: Yrd's
 * sources hold no child_process import (tools/worktree-mechanics.guard.test.ts), and this file cannot import the
 * shared process adapter, which is a package the launcher has not resolved yet.
 *
 * The rule is `tools/@in`'s `resolve_code_root`: the COMMON git dir of any worktree in a normal repository is
 * `<main>/.git`, so its parent IS main — for the main checkout and for every linked worktree alike (a seat home, a
 * `/hh/dev-rev/<sha>` revision checkout). `git worktree list`'s first entry is the fallback for a `--separate-git-dir`
 * layout. A root that cannot be derived REFUSES by name; it never falls back to the caller's own checkout.
 */
import { existsSync, realpathSync } from "node:fs"
import { join } from "node:path"

type Ran = Readonly<{ status: number; stdout: string; stderr: string }>

/** `git -C <cwd> <args>` with every inherited GIT_* variable removed, so a hook's GIT_DIR cannot redirect the read. */
function git(cwd: string, args: readonly string[]): Ran {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
  let ran: ReturnType<typeof Bun.spawnSync>
  try {
    // `git -C` reports a missing or non-repository target as a Git exit; the spawn itself stays in this process's cwd.
    ran = Bun.spawnSync(["git", "-C", cwd, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    throw new Error(
      `git ${args.join(" ")} in ${cwd} could not start: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const text = (output: Uint8Array | undefined): string =>
    output === undefined ? "" : new TextDecoder().decode(output).trim()
  return { status: ran.exitCode ?? 1, stdout: text(ran.stdout), stderr: text(ran.stderr) }
}

/** The main checkout of the repository holding `from` (a directory inside any of its worktrees), as a real path. */
export function mainCheckoutOf(from: string): string {
  const common = git(from, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  let root = common.status === 0 && common.stdout.endsWith("/.git") ? common.stdout.slice(0, -"/.git".length) : ""
  if (root === "" || !existsSync(join(root, ".git"))) {
    const list = git(from, ["worktree", "list", "--porcelain"])
    const first = list.status === 0 ? list.stdout.split("\n").find((line) => line.startsWith("worktree ")) : undefined
    root = first === undefined ? "" : first.slice("worktree ".length).trim()
  }
  if (root === "") {
    throw new Error(
      `cannot derive the main checkout from ${from} — no main worktree in \`git worktree list\` there ` +
        `(git rev-parse --git-common-dir: ${common.status === 0 ? common.stdout : common.stderr || `exit ${common.status}`})`,
    )
  }
  return realpathSync(root)
}

/**
 * The outermost repository holding `from`: its own top level, then each superproject that has it as a submodule, so
 * `<host>/vendor/yrd` (or a linked worktree's copy) answers `<host>`. Throws naming `from` when it is in no repository.
 */
export function outermostRepository(from: string): string {
  const top = git(from, ["rev-parse", "--show-toplevel"])
  if (top.status !== 0 || top.stdout === "") {
    throw new Error(
      `${from} is in no git repository (git rev-parse --show-toplevel: ${top.stderr || `exit ${top.status}`})`,
    )
  }
  let repository = top.stdout
  for (;;) {
    const parent = git(repository, ["rev-parse", "--show-superproject-working-tree"])
    if (parent.status !== 0) {
      throw new Error(
        `git rev-parse --show-superproject-working-tree failed in ${repository}: ${parent.stderr || `exit ${parent.status}`}`,
      )
    }
    if (parent.stdout === "" || parent.stdout === repository) return repository
    repository = parent.stdout
  }
}
