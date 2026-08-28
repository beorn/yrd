/**
 * @failure Routine lock/compose settlements leak into the habitant runner's INFO stream, or disappear when an operator explicitly enables DEBUG.
 * @level l3
 * @consumer @yrd/cli habitant follow-runner operators
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { stripAnsi } from "silvery"

import { createYrdHost, runYrdProcess } from "../src/host.ts"
import { followQueueRuns } from "../src/run.ts"
import { formatHabitantLogLine } from "../src/runner-timeline.ts"
import type { YrdCliIO } from "../src/types.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

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

async function runnerRepo(
  config = 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n',
): Promise<{ repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-habitant-info-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), config)
  await installDeclaredYrdEntry(repo)
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  return { repo }
}

async function queuedRunnerRepo(config?: string): Promise<{ repo: string }> {
  const { repo } = await runnerRepo(config)
  await git(repo, "switch", "-qc", "issue/live-row", "main")
  await writeFile(join(repo, "live-row.txt"), "live row\n")
  await git(repo, "add", "live-row.txt")
  await git(repo, "commit", "-qm", "live row")
  await git(repo, "switch", "-q", "main")
  await using submitter = await createYrdHost({ cwd: repo, log: createLogger("test", [{ level: "silent" }]) })
  // S7 (branch-is-change): the branch's standing submit fact IS the submission,
  // so the runner is seeded through the derived lane. `bays.submit` minted a
  // record and is retired — it refuses by name rather than seeding anything.
  const submission = await submitter.app.bays.submitSelection("issue/live-row", {
    base: "main",
    issue: "@yrd/core/21096-cli-ux/21706-runner-log-tag-link",
    // Answered from the fixture's own repository rather than stubbed: the
    // branch is not checked out here, so resolving its ref IS the step that
    // finds the head being submitted.
    resolveRevision: (ref) => git(repo, "rev-parse", "--verify", `${ref}^{commit}`).catch(() => undefined),
    resolveParents: async (sha) => (await git(repo, "rev-list", "--parents", "-n", "1", sha)).split(" ").slice(1),
    run: { runner: "test", leaseMs: 60_000 },
  })
  // The fixture's whole purpose is a runner with something to admit. A
  // submission that did not reach the derived lane would leave the queue empty
  // and every lifecycle assertion downstream would pass over silence.
  expect(submission).toMatchObject({ lane: "derived" })
  expect(submitter.app.bays.state().submits[submission.branch]).toMatchObject({ sha: submission.sha })
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

function defaultHabitantProcessEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.LOG_LEVEL
  delete env.DEBUG
  return { ...env, ...overrides }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("habitant follow-runner lifecycle levels", () => {
  it("narrates one admission while a waiting runner retries settlement internally", async () => {
    const { repo } = await queuedRunnerRepo(`base: main
batch: 1
checks:
  - check:
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
      runner: "test-habitant",
      scope: {
        signal,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 2) signal.aborted = true
        },
      },
    } as unknown as YrdCliIO

    await expect(followQueueRuns(host.app, [], { interval: 1 }, io, async () => undefined)).resolves.toBe(3)

    // The waiting runner owns its internal settlement retries. The outer queue
    // admission remains one structured event and therefore one human row.
    const runStarts = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.namespace === "yrd:queue:run" &&
        event.props?.run === "R1" &&
        event.props?.outcome === "started",
    )
    expect(runStarts).toHaveLength(1)
    const admittedRows = runStarts
      .map((event) => formatHabitantLogLine(event, { color: false }))
      .filter((line): line is string => line?.includes("[main#1] admitted") === true)
    expect(admittedRows).toHaveLength(1)
    expect(stripAnsi(admittedRows[0]!)).toContain(
      "[main#1] admitted pr#1.1 issue=@yrd/core/21096-cli-ux/21706-runner-log-tag-link",
    )
    expect(runStarts.map((event) => event.props?.continuation === true)).toEqual([false])
    log.end()
  }, 15_000)

  it("prints each live step transition once at explicit INFO through the shipping process", async () => {
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
      await vi.waitFor(
        () => {
          const visible = stripAnsi(stderrText)
          expect(visible).toMatch(/\[main#\d+\/0-check\] starting/u)
          expect(visible).toMatch(/\[main#\d+\/0-check\] finished duration=/u)
        },
        { timeout: 20_000, interval: 200 },
      )
      cli.kill("SIGTERM")
      expect(await cli.exited, stderrText).toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdoutText
      await stderrStream
    }

    const rows = stripAnsi(stderrText).split("\n")
    const startingRows = rows.filter((row) => row.includes("/0-check] starting"))
    const finishedRows = rows.filter((row) => row.includes("/0-check] finished "))
    expect(startingRows).toHaveLength(1)
    expect(finishedRows).toHaveLength(1)
    for (const row of [...startingRows, ...finishedRows]) expect(row).not.toMatch(/TITLE|[◆◇◉○✓✗×]/u)
  }, 30_000)

  it("keeps routine compose successes at DEBUG with timing", async () => {
    // Run/check/merge settlements remain INFO milestones. A compose cycle is
    // routine DEBUG plumbing; the default habitant JSONL sink retains it even
    // though the concise human branch drops it.
    const { repo } = await runnerRepo()
    const logFile = join(repo, "habitant.jsonl")
    const cli = Bun.spawn([process.execPath, YRD_BIN, "--repo", repo, "queue", "run", "--interval", "1"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: defaultHabitantProcessEnv({ LOGGILY_FILE: logFile, NO_COLOR: "1" }),
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
      env: defaultHabitantProcessEnv({ LOGGILY_FILE: logFile, NO_COLOR: "1" }),
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
      // habitant level while the human branch admits only lifecycle narration.
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
      await vi.waitFor(() => expect(stderrText).toContain("Stopping after the current run finishes"), {
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
    expect(stderrText).toMatch(/\bWARN yrd:runner Stopping after the current run finishes\b/u)
    // The redundant compose settlement roll-up is dropped from the human stream,
    // and low-level storage:lock chatter never reaches it...
    expect(stderrText).not.toContain("compose succeeded")
    expect(stderrText).not.toContain("storage:lock")
    // ...while the structured JSONL sink still retains the full journal detail
    // AND the full compose settlement record.
    const records = await readRecords(logFile)
    expect(records.some((r) => String(r.name) === "yrd:storage:lock")).toBe(true)
    expect(records.some((r) => r.name === "yrd:queue:compose" && r.outcome === "succeeded")).toBe(true)
  }, 40_000)

  it("keeps one-shot non-runner commands at WARN — no yrd:storage:lock INFO spam", async () => {
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
    expect(records.some((r) => r.level === "info" && String(r.name).startsWith("yrd:storage:lock"))).toBe(false)
    expect(records.some((r) => r.level === "info")).toBe(false)
    expect(stderr.join("")).not.toContain("storage:lock")
  }, 20_000)
})
