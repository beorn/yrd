/**
 * @failure An unchanged `yrd watch` snapshot schedules the full React/Silvery
 * render pipeline on every poll and burns a core while nobody is interacting.
 * @why Correctness assertions cannot see an allocation/render spin; sample the
 * installed PTY process after warmup and bound CPU time over a real idle window.
 * @level l3
 * @consumer @yrd/cli
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createTestTerminal } from "@termless/test"
import { describe, expect, it } from "vitest"

const yrdRoot = resolve(import.meta.dirname, "../../..")
const hhRoot = resolve(yrdRoot, "../..")
const installedYrd = resolve(hhRoot, "tools/installed/yrd")
const SAMPLE_MS = 60_000
const MAX_IDLE_CPU_SECONDS = 3

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

function cpuSeconds(pid: number): number {
  const result = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`ps failed: ${result.stderr.toString()}`)
  const fields = result.stdout.toString().trim().split(":")
  if (fields.length < 2 || fields.length > 3) {
    throw new Error(`unexpected ps CPU time: ${JSON.stringify(result.stdout.toString())}`)
  }
  const seconds = Number(fields.pop())
  const minutes = Number(fields.pop())
  const hours = fields.length === 0 ? 0 : Number(fields[0])
  if (![hours, minutes, seconds].every(Number.isFinite)) {
    throw new Error(`invalid ps CPU time: ${JSON.stringify(result.stdout.toString())}`)
  }
  return hours * 3_600 + minutes * 60 + seconds
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
}

function requireAlive(terminal: ReturnType<typeof createTestTerminal>, pid: number): number {
  if (!terminal.alive) {
    throw new Error(
      `installed watch ${pid} exited during the idle CPU window (${terminal.exitInfo ?? "unknown exit"}):\n${terminal.getText()}`,
    )
  }
  return cpuSeconds(pid)
}

describe.skipIf(!existsSync(installedYrd))("yrd idle CPU (installed)", () => {
  it("uses at most 5% of one core across a 60-second idle PTY window", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-watch-idle-cpu-"))
    const pidPath = join(root, "watch.pid")
    const terminal = createTestTerminal({ cols: 100, rows: 30 })
    let pid = 0
    try {
      git(root, "init", "-q", "-b", "main")
      git(root, "config", "user.name", "Yrd Test")
      git(root, "config", "user.email", "yrd@example.invalid")
      writeFileSync(join(root, "README.md"), "idle watch fixture\n")
      git(root, "add", "README.md")
      git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
      await terminal.spawn(
        ["/bin/sh", "-c", 'printf "%s\\n" "$$" > "$1"; exec "$2" watch', "yrd-watch", pidPath, installedYrd],
        {
          cwd: root,
          // Production CPU is the contract here. Root Vitest enables tier-1
          // differential rendering, which intentionally does a fresh oracle
          // render and would measure the checker instead of `yrd watch`.
          env: { FORCE_COLOR: "1", TERM: "xterm-256color", SILVERY_STRICT: "" },
        },
      )
      pid = await waitFor(
        () => (Bun.file(pidPath).size > 0 ? Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10) : 0),
        (value) => Number.isSafeInteger(value) && value > 1,
        "installed watch pid",
      )
      await terminal.waitFor("QUEUE main", 30_000).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}; exit=${terminal.exitInfo ?? "pending"}; pid=${pid}\n${terminal.getText()}`)
      })
      await terminal.waitForStable(1_000, 10_000)

      const startedAt = Date.now()
      const startedCpu = requireAlive(terminal, pid)
      let finishedCpu = startedCpu
      for (let elapsed = 0; elapsed < SAMPLE_MS; elapsed += 5_000) {
        await Bun.sleep(5_000)
        finishedCpu = requireAlive(terminal, pid)
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1_000
      const usedCpuSeconds = finishedCpu - startedCpu

      expect(
        usedCpuSeconds,
        `idle watch used ${usedCpuSeconds.toFixed(2)} CPU seconds across ${elapsedSeconds.toFixed(2)} wall seconds`,
      ).toBeLessThanOrEqual(MAX_IDLE_CPU_SECONDS)
    } finally {
      if (terminal.alive) {
        terminal.press("q")
        await waitFor(
          () => terminal.exitInfo,
          (value) => value !== null,
          "installed watch exit",
        ).catch(() => {})
      }
      await terminal.close()
      if (pid > 1) {
        await waitFor(
          () => {
            try {
              process.kill(pid, 0)
              return false
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
              throw error
            }
          },
          Boolean,
          `watch pid ${pid} removal`,
        )
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 110_000)

  it("keeps the resident follow loop below 5% of one core while its queue is idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-follow-idle-cpu-"))
    const pidPath = join(root, "follow.pid")
    const terminal = createTestTerminal({ cols: 100, rows: 30 })
    let pid = 0
    try {
      git(root, "init", "-q", "-b", "main")
      git(root, "config", "user.name", "Yrd Test")
      git(root, "config", "user.email", "yrd@example.invalid")
      writeFileSync(join(root, "README.md"), "idle follow fixture\n")
      git(root, "add", "README.md")
      git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
      await terminal.spawn(
        [
          "/bin/sh",
          "-c",
          'printf "%s\\n" "$$" > "$1"; exec "$2" queue run --interval 15',
          "yrd-follow",
          pidPath,
          installedYrd,
        ],
        { cwd: root, env: { FORCE_COLOR: "1", TERM: "xterm-256color", SILVERY_STRICT: "" } },
      )
      pid = await waitFor(
        () => (Bun.file(pidPath).size > 0 ? Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10) : 0),
        (value) => Number.isSafeInteger(value) && value > 1,
        "installed follow pid",
      )
      await terminal.waitFor("active; following", 30_000).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}; exit=${terminal.exitInfo ?? "pending"}; pid=${pid}\n${terminal.getText()}`)
      })
      await terminal.waitForStable(1_000, 10_000)

      const startedAt = Date.now()
      const startedCpu = requireAlive(terminal, pid)
      let finishedCpu = startedCpu
      for (let elapsed = 0; elapsed < SAMPLE_MS; elapsed += 5_000) {
        await Bun.sleep(5_000)
        finishedCpu = requireAlive(terminal, pid)
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1_000
      const usedCpuSeconds = finishedCpu - startedCpu

      expect(
        usedCpuSeconds,
        `idle follow used ${usedCpuSeconds.toFixed(2)} CPU seconds across ${elapsedSeconds.toFixed(2)} wall seconds`,
      ).toBeLessThanOrEqual(MAX_IDLE_CPU_SECONDS)
    } finally {
      if (terminal.alive && pid > 1) {
        process.kill(pid, "SIGTERM")
        await waitFor(
          () => terminal.exitInfo,
          (value) => value !== null,
          "installed follow exit",
        ).catch(() => {})
      }
      await terminal.close()
      if (pid > 1) {
        await waitFor(
          () => {
            try {
              process.kill(pid, 0)
              return false
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
              throw error
            }
          },
          Boolean,
          `follow pid ${pid} removal`,
        )
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 110_000)
})
