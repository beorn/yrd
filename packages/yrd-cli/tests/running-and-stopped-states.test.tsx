/**
 * @failure  The CLI verbs, watch header or yrd list emit states other than
 *           RUNNING or STOPPED, a stop reason fails to say why or who,
 *           the deprecated pause/resume verbs fail to print their new spelling,
 *           or yrd merge --no-check fails to skip checks and record it.
 * @level    l2
 * @consumer the operator and developers managing the queue
 */

import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { render } from "silvery/test"
import type { PauseRecord, Row } from "@yrd/queue-core"
import { pauseLine } from "@yrd/queue-core"
import { ListingPage } from "../src/watch-print.tsx"
import { queueLineStatus, type WatchSnapshot } from "../src/watch-pane.tsx"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"
import {
  boundaryRepository,
  checkAttempts,
  logOfQueueRun,
  removeTemporaryRoots,
  runYrd,
  submitOneCommit,
} from "../../../tests/boundary/fixture.ts"

const NOW = new Date("2026-09-23T18:00:00Z")

function row(over: Partial<Row> = {}): Row {
  return {
    branch: "task/one",
    head: "1".repeat(40),
    state: "queued",
    since: NOW,
    at: NOW,
    submitter: "@dev/1",
    subject: "task/one does its work",
    ...over,
  } as Row
}

function snapshot(over: Partial<WatchSnapshot> = {}): WatchSnapshot {
  const rows = over.rows ?? [{ row: row() }]
  return {
    at: NOW,
    queue: "example.test/repo#main",
    queues: [{ branch: "main", label: "main", path: "/repo" }],
    ...over,
    rows,
    unfiltered: over.unfiltered ?? rows,
  }
}

async function paint(snapshot: WatchSnapshot, columns = 120): Promise<string> {
  const app = render(<ListingPage snapshot={snapshot} options={{ columns, color: false }} />, {
    cols: columns,
    rows: 40,
  })
  await app.waitForLayoutStable()
  const text = app.text
  app.unmount()
  return text
}

function captureIo(cwd: string): Readonly<{ io: YrdCliIO; stdout(): string; stderr(): string }> {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      cwd,
      color: false,
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

describe("25367: yrd has two states, RUNNING and STOPPED, and a stop always says why", () => {
  describe("acceptance criterion 1 & 4: one STOPPED state with a reason covers pause and stuck-stop", () => {
    it("stop reason 1 (operator): header shows STOPPED and list shows 'stopped by <seat>: <reason>'", async () => {
      const operatorStopRecord: PauseRecord = {
        at: NOW,
        by: "@chief",
        cause: "operator",
        kind: "paused",
        reason: "maintenance window",
        sha: "a".repeat(40),
      }

      // Check pauseLine format: "stopped by <seat>: <reason>"
      const line = pauseLine(operatorStopRecord)
      expect(line).toBe("stopped by @chief: maintenance window")

      // Check watch header & list
      const snap = snapshot({
        pause: line,
        stopped: {
          by: "@chief",
          cause: "operator",
          change: null,
          since: NOW.toISOString(),
        },
      })

      const status = queueLineStatus(snap, NOW)
      expect(status.word).toBe("STOPPED")
      expect(status.marker).toBe("■")

      const text = await paint(snap)
      expect(text).toContain("■ YRD STOPPED")
      expect(text).toContain("stopped by @chief: maintenance window")
      expect(text).not.toContain("IDLE")
      expect(text).not.toContain("STUCK")
    })

    it("stop reason 2 (stuck): header shows STOPPED and list shows 'stopped: stuck on <change>'", async () => {
      const stuckStopRecord: PauseRecord = {
        at: NOW,
        by: "yrd",
        cause: "stuck",
        change: { branch: "task/bad", head: "b".repeat(40) },
        kind: "paused",
        reason: "tests failed to compile",
        sha: "c".repeat(40),
      }

      // Check pauseLine format: "stopped: stuck on <change>"
      const line = pauseLine(stuckStopRecord)
      expect(line).toBe(`stopped: stuck on task/bad@${"b".repeat(40)}`)

      // Check watch header & list
      const snap = snapshot({
        pause: line,
        stopped: {
          by: "yrd",
          cause: "stuck",
          change: `task/bad@${"b".repeat(40)}`,
          since: NOW.toISOString(),
        },
      })

      const status = queueLineStatus(snap, NOW)
      expect(status.word).toBe("STOPPED")
      expect(status.marker).toBe("■")

      const text = await paint(snap)
      expect(text).toContain("■ YRD STOPPED")
      expect(text).toContain(`stopped: stuck on task/bad@${"b".repeat(40)}`)
      expect(text).not.toContain("IDLE")
      expect(text).not.toContain("STUCK")
    })

    it("running/idle: watch header shows RUNNING (never IDLE)", async () => {
      const snap = snapshot({
        stopped: null,
        runner: {
          journalDir: "/w/logs",
          service: { kind: "beating", state: "healthy" },
          latest: { alive: false, id: "q-1", lastWriteAt: NOW, startedAt: NOW },
        },
      })

      const status = queueLineStatus(snap, NOW)
      expect(status.word).toBe("RUNNING")
      expect(status.marker).toBe("◉")

      const text = await paint(snap)
      expect(text).toContain("◉ YRD RUNNING")
      expect(text).not.toContain("IDLE")
      expect(text).not.toContain("STUCK")
    })
  })

  describe("acceptance criterion 2: CLI verbs use stop/start; old pause/resume print new spelling", () => {
    it("yrd queue stop stops the queue; yrd queue pause warns to stderr and stops", async () => {
      const { repo } = await boundaryRepository({ exit: 0 })
      try {
        // Test yrd queue stop
        const stopRun = captureIo(repo)
        const stopExit = await runYrdProcess(
          [process.execPath, "yrd", "queue", "stop", "--reason", "db maintenance", "--notify", "@dev/8"],
          stopRun.io,
        )
        expect(stopExit).toBe(0)
        expect(stopRun.stderr()).not.toContain("is now")

        // Test yrd queue start
        const startRun = captureIo(repo)
        const startExit = await runYrdProcess(
          [process.execPath, "yrd", "queue", "start", "--reason", "maintenance complete", "--notify", "@dev/8"],
          startRun.io,
        )
        expect(startExit).toBe(0)
        expect(startRun.stderr()).not.toContain("is now")

        // Test yrd queue pause (alias warning)
        const pauseRun = captureIo(repo)
        const pauseExit = await runYrdProcess(
          [process.execPath, "yrd", "queue", "pause", "--reason", "db maintenance again", "--notify", "@dev/8"],
          pauseRun.io,
        )
        expect(pauseExit).toBe(0)
        expect(pauseRun.stderr()).toMatch(/`pause` is now `stop`|'pause' is now 'stop'/i)

        // Test yrd queue resume (alias warning)
        const resumeRun = captureIo(repo)
        const resumeExit = await runYrdProcess(
          [process.execPath, "yrd", "queue", "resume", "--reason", "maintenance complete again", "--notify", "@dev/8"],
          resumeRun.io,
        )
        expect(resumeExit).toBe(0)
        expect(resumeRun.stderr()).toMatch(/`resume` is now `start`|'resume' is now 'start'/i)
      } finally {
        removeTemporaryRoots()
      }
    })
  })

  describe("acceptance criterion 5: yrd merge --no-check <branch>", () => {
    it("merges with git machinery only, skips every check, says so in output and in journal row", async () => {
      // Setup repo with check that exits 1 (fails if executed)
      const { repo, checkLog } = await boundaryRepository({ exit: 1 })
      try {
        const submitted = await submitOneCommit(repo, "task-no-check")

        // Run yrd merge --no-check
        const mergeResult = await runYrd(repo, "merge", "--no-check", submitted.branch)
        expect(mergeResult.exitCode, mergeResult.report).toBe(0)

        // Verify check was skipped
        expect(await checkAttempts(checkLog)).toBe(0)

        // Output mentions checks skipped / --no-check
        const output = `${mergeResult.stdout}\n${mergeResult.stderr}`
        expect(output).toMatch(/--no-check|checks skipped/i)

        // Journal row records noCheck: true and effectiveChecks: off
        const logMatch = mergeResult.stdout.match(/\(log\s+([^\s)]+)\)/)
        expect(logMatch).not.toBeNull()
        const logPath = logMatch?.[1]
        expect(logPath).toBeDefined()
        const logContent = await readFile(logPath!, "utf8")
        const records = logContent
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        const runRecord = records.find((r) => r.kind === "run")
        expect(runRecord).toBeDefined()
        expect(runRecord).toMatchObject({
          noCheck: true,
          effectiveChecks: expect.arrayContaining(["off"]),
        })
      } finally {
        removeTemporaryRoots()
      }
    })
  })
})
