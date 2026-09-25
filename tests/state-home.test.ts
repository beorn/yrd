/**
 * No yrd test resolves its queue workdir to the operator's real home
 * (@i/17-test-system/25256) — pre-fix RED.
 *
 * @failure  A fixture repository with no `yrd.workdir` sends its queue-owned
 *           clone to ~/.local/state/yrd/local/tmp (12 GB, 13,449 roots by
 *           2026-09-24) and `bun install` fixtures fill ~/.bun/install/cache.
 * @level    l1 (one real git fixture, the resolver in-process)
 * @consumer every yrd test run, in yrd's own config and the root's vendor projects
 * @testonly none
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "@yrd/queue-core"
import { parseQueueAddress, queueRoot } from "../packages/yrd-cli/src/address.ts"
import { resolveQueueLocation } from "../packages/yrd-cli/src/queue-location.ts"

const REAL_STATE_HOME = join(homedir(), ".local", "state")
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** A bare remote whose `main` declares a queue, and a clone of it that sets no `yrd.workdir`. */
async function fixtureWithoutWorkdir(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-state-home-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: true\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  return work
}

describe("25256 yrd tests never resolve the real state home", () => {
  it("pins XDG_STATE_HOME and the bun install cache to a throwaway root", () => {
    const stateHome = process.env.XDG_STATE_HOME
    expect(stateHome, "XDG_STATE_HOME is unset: the state-home setup did not run").toBeDefined()
    expect(stateHome).not.toBe(REAL_STATE_HOME)
    expect(stateHome!.startsWith(homedir() + "/")).toBe(false)
    const bunCache = process.env.BUN_INSTALL_CACHE_DIR
    expect(bunCache, "BUN_INSTALL_CACHE_DIR is unset: a bun install fixture would fill ~/.bun").toBeDefined()
    expect(bunCache!.startsWith(join(homedir(), ".bun"))).toBe(false)
  })

  it("a bare Bun.spawn child sees the pin: the worker's startup environ carries it", async () => {
    // Measured 2026-09-24: a runtime `process.env` write reaches a spawn given
    // `env: process.env` and node:child_process, but a bare Bun.spawn takes the
    // startup environ, which is how uri-queue's submit still wrote the real home
    // under a per-file setup. The pin therefore precedes every worker.
    const child = Bun.spawn(["sh", "-c", 'printf "%s\n%s" "$XDG_STATE_HOME" "$BUN_INSTALL_CACHE_DIR"'], {
      stdout: "pipe",
    })
    const [seen, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exit).toBe(0)
    const [stateHome, bunCache] = seen.split("\n")
    expect(stateHome).toBe(process.env.XDG_STATE_HOME)
    expect(stateHome!.startsWith(homedir() + "/")).toBe(false)
    expect(bunCache).toBe(process.env.BUN_INSTALL_CACHE_DIR)
  })

  it("a fixture with no yrd.workdir gets its queue-owned clone under the pinned root, not the real home", async () => {
    const stateHome = process.env.XDG_STATE_HOME
    expect(stateHome, "XDG_STATE_HOME is unset: resolving now would litter the real home").toBeDefined()
    const work = await fixtureWithoutWorkdir()
    const remote = join(work, "..", "remote.git")
    const address = parseQueueAddress(`${remote}#main`)
    const realRoot = queueRoot(join(REAL_STATE_HOME, "yrd"), address)

    const location = await resolveQueueLocation(work, undefined, process.env)

    expect(location.owned).toBe(true)
    expect(location.workdir).toBe(queueRoot(join(stateHome!, "yrd"), address))
    expect(location.repo.startsWith(join(stateHome!, "yrd") + "/")).toBe(true)
    expect(existsSync(location.repo)).toBe(true)
    expect(existsSync(realRoot), `${realRoot} exists: the clone landed in the operator's real home`).toBe(false)
  })
})
