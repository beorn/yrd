/**
 * @failure The production yrd watch supervisor fails to reexec on an imported
 * source change, spawns a duplicate or nested watcher, mis-scopes the watch
 * argv, or leaks its SIGINT/SIGTERM handlers.
 * @level l2
 * @consumer @yrd/cli
 *
 * Pure supervisor contract — spawn and signal handling are injected, and the
 * reexec drill runs a synthetic entry, so this file needs no PTY, installed
 * binary, or QueueWatch renderer. The integration drills that do live in
 * `watch-hot-reload.pty.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { superviseYrdWatch } from "../src/watch-hot-reload.ts"

async function waitForLines(path: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const records = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      if (records.length >= count) return records
    } catch {
      // The supervised process has not created its evidence file yet.
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${count} watch generations`)
}

describe("yrd watch hot reload", () => {
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
      expect(first.map((entry) => JSON.parse(entry))).toEqual([expect.objectContaining({ identity: "before" })])

      writeFileSync(identity, 'export const identity = "after"\n')
      const reloaded = await waitForLines(evidence, 2)
      await Bun.sleep(250)
      const settled = readFileSync(evidence, "utf8").trim().split("\n").filter(Boolean)
      expect(settled).toHaveLength(2)
      expect(reloaded.map((entry) => JSON.parse(entry))).toEqual([
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
