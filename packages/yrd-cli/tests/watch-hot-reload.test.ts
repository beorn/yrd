import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createTestTerminal } from "@termless/test"
import { describe, expect, it, vi } from "vitest"
import { superviseYrdWatch } from "../src/watch-hot-reload.ts"

const yrdRoot = resolve(import.meta.dirname, "../../..")
const installedYrd = resolve(yrdRoot, "../../tools/installed/yrd")

async function waitForLines(path: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      if (lines.length >= count) return lines
    } catch {
      // The supervised process has not created its evidence file yet.
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${count} watch generations`)
}

async function waitFor<T>(read: () => T, accept: (value: T) => boolean, detail: string): Promise<T> {
  const deadline = Date.now() + 10_000
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
    .map((line) => line.trim().split(/\s+/u).map(Number))
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

async function launchInstalledWatch(repo: string) {
  const pidPath = join(repo, "watch.pid")
  const terminal = createTestTerminal({ cols: 100, rows: 30 })
  await terminal.spawn(
    ["/bin/sh", "-c", 'printf "%s\\n" "$$" > "$1"; exec "$2" watch', "yrd-watch", pidPath, installedYrd],
    { cwd: repo, env: { FORCE_COLOR: "1", TERM: "xterm-256color" } },
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

describe("yrd watch hot reload", () => {
  it("restores the terminal and reaps installed watch process groups on startup failure, SIGINT, and SIGTERM", async () => {
    const roots: string[] = []
    try {
      const failedRepo = createRepository("yrd-installed-watch-failed-")
      roots.push(failedRepo)
      writeFileSync(join(failedRepo, ".yrd.yml"), "steps: [\n")
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
          await running.terminal.waitFor("LIVE", 10_000)
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
  }, 30_000)

  it.each([
    ["canonical", ["watch", "--repo", "/tmp/repo", "--pr", "PR7"]],
    ["pre-verb global option", ["--repo", "/tmp/repo", "watch", "--pr", "PR7"]],
  ] as const)("runs the %s production entry under one Bun supervisor with terminal ownership", async (_shape, args) => {
    const spawn = vi.fn(() => ({ exited: Promise.resolve(0), kill: vi.fn() }))

    const exit = await superviseYrdWatch({
      args,
      execArgv: [],
      execPath: "/usr/bin/bun",
      scriptPath: "/repo/vendor/yrd/bin/yrd.ts",
      spawn,
    })

    expect(exit).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      ["/usr/bin/bun", "--watch", "--no-clear-screen", "/repo/vendor/yrd/bin/yrd.ts", ...(args as readonly string[])],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    )
  })

  it.each([["--help"], ["queue", "ls"], ["queue", "ls", "--watch"]])(
    "does not supervise non-watch argv: %s",
    async (...args) => {
      const spawn = vi.fn(() => ({ exited: Promise.resolve(0), kill: vi.fn() }))
      expect(
        await superviseYrdWatch({
          args,
          execArgv: [],
          execPath: "/usr/bin/bun",
          scriptPath: "/repo/vendor/yrd/bin/yrd.ts",
          spawn,
        }),
      ).toBeUndefined()
      expect(spawn).not.toHaveBeenCalled()
    },
  )

  it("does not nest a second supervisor inside Bun's watch child", async () => {
    const spawn = vi.fn(() => ({ exited: Promise.resolve(0), kill: vi.fn() }))
    expect(
      await superviseYrdWatch({
        args: ["watch"],
        execArgv: ["--watch", "--no-clear-screen"],
        execPath: "/usr/bin/bun",
        scriptPath: "/repo/vendor/yrd/bin/yrd.ts",
        spawn,
      }),
    ).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
  })

  it("terminates Bun's watch loop when the production QueueWatch command finishes", async () => {
    const child = Bun.spawn([process.execPath, join(yrdRoot, "bin/yrd.ts"), "watch"], {
      cwd: yrdRoot,
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      const outcome = await Promise.race([child.exited, Bun.sleep(1_500).then(() => "timeout" as const)])
      expect(outcome).not.toBe("timeout")
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  }, 5_000)

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("forwards %s to the supervised watcher and removes its handler", async (signal, exitCode) => {
    const listeners = new Map<string, () => void>()
    const exited = Promise.withResolvers<number>()
    const kill = vi.fn(() => exited.resolve(exitCode))
    const signals = {
      on: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
      off: vi.fn((name: string, listener: () => void) => {
        if (listeners.get(name) === listener) listeners.delete(name)
      }),
    }

    const running = superviseYrdWatch({
      args: ["watch"],
      execArgv: [],
      execPath: "/usr/bin/bun",
      scriptPath: "/repo/vendor/yrd/bin/yrd.ts",
      spawn: () => ({ exited: exited.promise, kill }),
      signals,
    })

    expect(listeners.get(signal)).toBeTypeOf("function")
    listeners.get(signal)?.()
    expect(await running).toBe(exitCode)
    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith(signal)
    expect(listeners.has("SIGINT")).toBe(false)
    expect(listeners.has("SIGTERM")).toBe(false)
  })

  it("reexecs exactly once when an imported source identity changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-watch-reexec-"))
    const identity = join(root, "identity.ts")
    const entry = join(root, "entry.ts")
    const evidence = join(root, "generations.jsonl")
    writeFileSync(identity, 'export const identity = "before"\n')
    writeFileSync(
      entry,
      [
        'import { appendFileSync } from "node:fs"',
        'import { identity } from "./identity.ts"',
        'appendFileSync(process.argv[3]!, JSON.stringify({ identity, pid: process.pid }) + "\\n")',
        "setInterval(() => undefined, 60_000)",
        "",
      ].join("\n"),
    )

    let supervisor: ReturnType<typeof Bun.spawn> | undefined
    try {
      const done = superviseYrdWatch({
        args: ["watch", evidence],
        execArgv: [],
        execPath: process.execPath,
        scriptPath: entry,
        spawn: (command, options) => {
          supervisor = Bun.spawn(command, options)
          return supervisor
        },
      })

      const first = await waitForLines(evidence, 1)
      expect(first.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ identity: "before" })])

      writeFileSync(identity, 'export const identity = "after"\n')
      const reloaded = await waitForLines(evidence, 2)
      await Bun.sleep(250)
      const settled = readFileSync(evidence, "utf8").trim().split("\n").filter(Boolean)
      expect(settled).toHaveLength(2)
      expect(reloaded.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ identity: "before" }),
        expect.objectContaining({ identity: "after" }),
      ])

      supervisor?.kill("SIGTERM")
      await done
    } finally {
      supervisor?.kill("SIGKILL")
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)
})
