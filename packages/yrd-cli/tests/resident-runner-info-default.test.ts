/**
 * @failure Routine lock/compose settlements leak into the resident runner's INFO stream, or disappear when an operator explicitly enables DEBUG.
 * @level l3
 * @consumer @yrd/cli resident follow-runner operators
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"

import { createYrdHost, runYrdProcess } from "../src/host.ts"
import { followQueueRuns } from "../src/run.ts"
import { formatResidentLogLine } from "../src/runner-timeline.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const YRD_BIN = join(import.meta.dirname, "../../../bin/yrd.ts")

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function runnerRepo(config = 'base: main\nbatch: 1\nsteps: [check]\ncheck: "true"\n'): Promise<{ repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-resident-info-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), config)
  await git(repo, "add", "README.md", ".yrd.yml")
  await git(repo, "commit", "-qm", "main")
  return { repo }
}

async function queuedRunnerRepo(config?: string): Promise<{ repo: string }> {
  const { repo } = await runnerRepo(config)
  await git(repo, "switch", "-qc", "issue/live-row", "main")
  await writeFile(join(repo, "live-row.txt"), "live row\n")
  await git(repo, "add", "live-row.txt")
  await git(repo, "commit", "-qm", "live row")
  const headSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  await using submitter = await createYrdHost({ cwd: repo, log: createLogger("test", [{ level: "silent" }]) })
  await submitter.app.bays.submit({ branch: "issue/live-row", headSha, base: "main" })
  return { repo }
}

async function readRecords(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8").catch(() => "")
  return text
    .trim()
    .split("\n")
    .filter((entry) => entry !== "")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("resident follow-runner lifecycle levels", () => {
  it("narrates one admission while retaining repeated waiting-run settlement attempts", async () => {
    const { repo } = await queuedRunnerRepo(`base: main
batch: 1
steps: [check, merge]
check:
  run: |
    printf '%s\\n' '{"token":"remote-check"}'
  runner: waiting
`)
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using host = await createYrdHost({ cwd: repo, log })
    const signal = { aborted: false }
    let sleeps = 0
    const io = {
      stdout: () => undefined,
      stderr: () => undefined,
      runner: "test-resident",
      scope: {
        signal,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 2) signal.aborted = true
        },
      },
    } as unknown as YrdCliIO

    await expect(followQueueRuns(host.app, [], { interval: 1 }, io, async () => undefined)).resolves.toBe(0)

    // Both settlement attempts remain structured evidence; only the first may
    // be narrated as admission, or every resident interval repeats the row.
    const runStarts = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.namespace === "yrd:queue:run" &&
        event.props?.run === "R1" &&
        event.props?.outcome === "started",
    )
    expect(runStarts).toHaveLength(2)
    const admittedRows = runStarts
      .map((event) => formatResidentLogLine(event, { color: false }))
      .filter((line): line is string => line?.includes("[main#1] admitted") === true)
    expect(admittedRows).toHaveLength(1)
    expect(runStarts.map((event) => event.props?.continuation === true)).toEqual([false, true])
    log.end()
  }, 15_000)

  it("prints one undecorated human line per live step through the shipping queue-run process", async () => {
    const { repo } = await queuedRunnerRepo()
    const cli = Bun.spawn([process.execPath, YRD_BIN, "--repo", repo, "queue", "run", "--interval", "1"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOG_LEVEL: "info", NO_COLOR: "1" },
    })
    const stdoutText = new Response(cli.stdout).text()
    let stderrText = ""
    const stderrStream = (async () => {
      const reader = cli.stderr.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        stderrText += decoder.decode(value, { stream: true })
      }
    })()
    try {
      await vi.waitFor(() => expect(stderrText).toMatch(/\bINFO yrd:queue:run \[main#\d+ 1:check\] done\b/u), {
        timeout: 20_000,
        interval: 200,
      })
      cli.kill("SIGTERM")
      expect(await cli.exited, stderrText).toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdoutText
      await stderrStream
    }

    const stepRows = stderrText.split("\n").filter((row) => row.includes(" 1:check] "))
    expect(stepRows).toHaveLength(1)
    expect(stepRows[0]).not.toMatch(/TITLE|[◆◇●○✓✗×]/u)
  }, 30_000)

  it("keeps routine compose successes at DEBUG with timing", async () => {
    // Run/check/merge settlements remain INFO milestones. A compose cycle is
    // routine DEBUG plumbing; the default resident JSONL sink retains it even
    // though the concise human branch drops it.
    const { repo } = await runnerRepo()
    const logFile = join(repo, "resident.jsonl")
    const cli = Bun.spawn([process.execPath, YRD_BIN, "--repo", repo, "queue", "run", "--interval", "1"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOGGILY_FILE: logFile, NO_COLOR: "1" },
    })
    const drainStdout = new Response(cli.stdout).text()
    const drainStderr = new Response(cli.stderr).text()
    try {
      await vi.waitFor(
        async () => {
          const records = await readRecords(logFile)
          const composeDone = records.find(
            (r) => r.name === "yrd:queue:compose" && r.outcome === "succeeded" && r.level === "debug",
          )
          expect(composeDone, "no DEBUG yrd:queue:compose succeeded settlement").toBeDefined()
          expect(composeDone).toMatchObject({ msg: "compose succeeded", durationMs: expect.any(Number) })
          expect(
            records.some((r) => r.name === "yrd:queue:compose" && r.outcome === "succeeded" && r.level === "info"),
          ).toBe(false)
        },
        { timeout: 20_000, interval: 200 },
      )
      cli.kill("SIGTERM")
      expect(await cli.exited, await drainStderr).toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await drainStdout
      await drainStderr
    }
  }, 30_000)

  it("keeps the human stream scannable: friendly-prefixed rows, roll-ups and journal chatter dropped", async () => {
    const { repo } = await runnerRepo()
    const logFile = join(repo, "timeline.jsonl")
    const cli = Bun.spawn([process.execPath, YRD_BIN, "--repo", repo, "queue", "run", "--interval", "1"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOGGILY_FILE: logFile, NO_COLOR: "1" },
    })
    const stdoutText = new Response(cli.stdout).text()
    let stderrText = ""
    const stderrStream = (async () => {
      const reader = cli.stderr.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        stderrText += decoder.decode(value, { stream: true })
      }
    })()
    try {
      // A configured JSONL sink keeps the complete DEBUG record at the default
      // resident level while the human branch admits only lifecycle narration.
      await vi.waitFor(
        async () => {
          const records = await readRecords(logFile)
          expect(records.some((r) => r.name === "yrd:queue:compose" && r.outcome === "succeeded")).toBe(true)
        },
        { timeout: 20_000, interval: 200 },
      )
      cli.kill("SIGTERM")
      // The graceful-drain notice is a first-class human row (it is NOT a step
      // roll-up), so it must surface before exit.
      await vi.waitFor(() => expect(stderrText).toContain("graceful drain requested"), {
        timeout: 20_000,
        interval: 200,
      })
      expect(await cli.exited, stderrText).toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdoutText
      await stderrStream
    }

    // Every human row leads with the loggily prefix (time LEVEL scope …) — the
    // structured JSON is a dimmed TAIL, so no row STARTS with a raw `{` dump.
    expect(stderrText).not.toMatch(/^\s*\{/mu)
    expect(stderrText).toMatch(/\bWARN yrd:runner graceful drain requested\b/u)
    // The redundant compose settlement roll-up is dropped from the human stream,
    // and low-level journal:lock chatter never reaches it...
    expect(stderrText).not.toContain("compose succeeded")
    expect(stderrText).not.toContain("journal:lock")
    // ...while the structured JSONL sink still retains the full journal detail
    // AND the full compose settlement record.
    const records = await readRecords(logFile)
    expect(records.some((r) => String(r.name) === "yrd:journal:lock")).toBe(true)
    expect(records.some((r) => r.name === "yrd:queue:compose" && r.outcome === "succeeded")).toBe(true)
  }, 40_000)

  it("keeps one-shot non-runner commands at WARN — no yrd:journal:lock INFO spam", async () => {
    const { repo } = await runnerRepo()
    const logFile = join(repo, "one-shot.jsonl")
    const previous = process.env.LOGGILY_FILE
    process.env.LOGGILY_FILE = logFile
    const stderr: string[] = []
    try {
      await runYrdProcess(["yrd", "--repo", repo, "queue", "--json"], {
        cwd: repo,
        stdout: () => {},
        stderr: (text) => stderr.push(text),
        color: false,
      })
    } finally {
      if (previous === undefined) delete process.env.LOGGILY_FILE
      else process.env.LOGGILY_FILE = previous
    }
    const records = await readRecords(logFile)
    expect(records.some((r) => r.level === "info" && String(r.name).startsWith("yrd:journal:lock"))).toBe(false)
    expect(records.some((r) => r.level === "info")).toBe(false)
    expect(stderr.join("")).not.toContain("journal:lock")
  }, 20_000)
})
