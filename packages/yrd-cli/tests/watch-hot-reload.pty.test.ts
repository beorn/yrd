/**
 * @failure The installed yrd watch process leaks its process group or corrupts
 * the terminal on startup failure, SIGINT, or SIGTERM, or Bun's watch loop fails
 * to terminate when the production QueueWatch command finishes.
 * @level l3
 * @consumer @yrd/cli
 *
 * These drills need the full integration environment: a `@termless` PTY, a
 * production `yrd` launcher, and a Silvery build that exports the QueueWatch
 * renderer. They are intentionally kept apart from `watch-hot-reload.test.ts`
 * (pure supervisor logic) so the latter runs in a bare standalone clone.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createTestTerminal } from "@termless/test"
import { describe, expect, it } from "vitest"
import { installedYrdLauncher, yrdRoot } from "./support/installed-launcher.ts"

const installedYrd = installedYrdLauncher()

// Every deadline here separates "happens" from "hangs" on a box that may be
// running the whole fleet. Unloaded these drills settle in about a second; a
// bound near that measures load instead. `watch-idle-cpu.slow.test.ts` already
// waits 30s for the same `QUEUE main` sentinel under a PTY.
const SETTLE_MS = 30_000

async function waitFor<T>(read: () => T, accept: (value: T) => boolean, detail: string): Promise<T> {
  const deadline = Date.now() + SETTLE_MS
  let value = read()
  while (!accept(value)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`)
    await Bun.sleep(20)
    value = read()
  }
  return value
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
}

function createRepository(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Yrd Test")
  git(repo, "config", "user.email", "yrd@example.invalid")
  writeFileSync(join(repo, "README.md"), "fixture\n")
  git(repo, "add", "README.md")
  git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
  return repo
}

function processGroupMembers(pgid: number): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`ps failed: ${result.stderr.toString()}`)
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .map((raw) => raw.trim().split(/\s+/u).map(Number))
    .filter((fields) => fields[1] === pgid)
    .map((fields) => fields[0]!)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function launchInstalledWatch(repo: string, env: Record<string, string> = {}) {
  const pidPath = join(repo, "watch.pid")
  const terminal = createTestTerminal({ cols: 100, rows: 30 })
  await terminal.spawn(
    ["/bin/sh", "-c", 'printf "%s\\n" "$$" > "$1"; exec "$2" watch', "yrd-watch", pidPath, installedYrd],
    { cwd: repo, env: { FORCE_COLOR: "1", TERM: "xterm-256color", ...env } },
  )
  const pid = await waitFor(
    () => (Bun.file(pidPath).size > 0 ? Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10) : 0),
    (value) => Number.isSafeInteger(value) && value > 1,
    "installed watch pid",
  )
  return { pid, terminal }
}

async function expectBoundedExit(terminal: ReturnType<typeof createTestTerminal>, expected?: number): Promise<void> {
  const exitInfo = await waitFor(
    () => terminal.exitInfo,
    (value) => value !== null,
    "installed watch exit",
  )
  if (expected === undefined) expect(exitInfo).toMatch(/^exit=[1-9]\d*$/u)
  else expect(exitInfo).toBe(`exit=${expected}`)
  await terminal.waitForStable(25, 1_000)
  expect(terminal.getMode("altScreen")).toBe(false)
  expect(terminal.getCursor().visible).toBe(true)
}

async function expectProcessesGone(pgid: number, pids: readonly number[]): Promise<void> {
  await waitFor(
    () => ({ group: processGroupMembers(pgid), children: pids.filter(processExists) }),
    ({ group, children }) => group.length === 0 && children.length === 0,
    `process group ${pgid} and children ${pids.join(",") || "(none)"} removal`,
  )
}

describe("yrd watch hot reload (installed)", () => {
  it("keeps Yrd's test-mode JSX transforms out of an inherited production cache", () => {
    const manifest = JSON.parse(readFileSync(resolve(yrdRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    const testScript = manifest.scripts?.test
    expect(testScript).toContain("NODE_ENV=test")
    expect(testScript).toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH=")
    expect(testScript).toContain("bun-transpiler-yrd-test")
  })

  it("recovers a test-mode JSX transform persisted in its production cache before rendering", async () => {
    const repo = createRepository("yrd-installed-watch-poisoned-")
    const home = mkdtempSync(join(tmpdir(), "yrd-installed-watch-home-"))
    const cache = join(home, ".cache", "silvercode", "bun-transpiler-yrd-production")
    const watchPane = resolve(yrdRoot, "packages/yrd-cli/src/watch-pane.tsx")
    const poison = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(watchPane)})`], {
      cwd: yrdRoot,
      env: {
        ...process.env,
        HOME: home,
        NODE_ENV: "test",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(poison.exitCode, poison.stderr.toString()).toBe(0)
    expect(
      readdirSync(cache).some((name) => readFileSync(join(cache, name)).includes("jsxDEV")),
      "the test-mode child must reproduce persisted dev JSX in the installed production bucket",
    ).toBe(true)

    const running = await launchInstalledWatch(repo, { HOME: home, NODE_ENV: "production" })
    try {
      await running.terminal.waitFor("QUEUE main", SETTLE_MS).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}; exit=${running.terminal.exitInfo ?? "pending"}\n${running.terminal.getText()}`)
      })
      expect(running.terminal.alive).toBe(true)
      running.terminal.press("q")
      await expectBoundedExit(running.terminal, 0)
    } finally {
      if (processExists(running.pid)) process.kill(-running.pid, "SIGKILL")
      await running.terminal.close()
      rmSync(repo, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 90_000)

  it("restores the terminal and reaps installed watch process groups on startup failure, SIGINT, and SIGTERM", async () => {
    const roots: string[] = []
    try {
      const failedRepo = createRepository("yrd-installed-watch-failed-")
      roots.push(failedRepo)
      writeFileSync(join(failedRepo, ".yrd.yml"), "steps: [\n")
      git(failedRepo, "add", ".yrd.yml")
      git(failedRepo, "-c", "commit.gpgsign=false", "commit", "-qm", "invalid base config")
      const failed = await launchInstalledWatch(failedRepo)
      try {
        await expectBoundedExit(failed.terminal)
        await expectProcessesGone(failed.pid, [])
      } finally {
        await failed.terminal.close()
      }

      for (const [signal, exitCode] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        const repo = createRepository(`yrd-installed-watch-${signal.toLowerCase()}-`)
        roots.push(repo)
        const running = await launchInstalledWatch(repo)
        try {
          // The 2026-07-15 footer respec removed both the LIVE indicator and
          // keybinding footer; the queue identity is the stable liveness sentinel.
          await running.terminal.waitFor("QUEUE main", SETTLE_MS).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`${message}; exit=${running.terminal.exitInfo ?? "pending"}\n${running.terminal.getText()}`)
          })
          expect(running.terminal.alive).toBe(true)
          const members = processGroupMembers(running.pid)
          expect(members).toContain(running.pid)

          process.kill(running.pid, signal)
          await expectBoundedExit(running.terminal, exitCode)
          await expectProcessesGone(running.pid, members)
        } finally {
          if (processExists(running.pid)) process.kill(-running.pid, "SIGKILL")
          await running.terminal.close()
        }
      }
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it("terminates Bun's watch loop when the production QueueWatch command finishes", async () => {
    const child = Bun.spawn([process.execPath, join(yrdRoot, "bin/yrd.ts"), "watch"], {
      cwd: yrdRoot,
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      // The failure is a watch loop that never terminates, so the bound only has
      // to separate "exits" from "hangs". A cold start is ~0.5s unloaded; bounds
      // near that measure how busy the box is instead.
      const outcome = await Promise.race([child.exited, Bun.sleep(SETTLE_MS).then(() => "timeout" as const)])
      expect(outcome).not.toBe("timeout")
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  }, 45_000)
})
