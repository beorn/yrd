/**
 * @failure  The port had no RUNNER box at all: a queue whose service had
 *           died read exactly like one with nothing to do, and a running
 *           check gave no sign of the process behind it (watch-redesign
 *           items 13, 14, 16, 17, 27, 29, 37). The one instrument the new
 *           core leaves is the run journal and the run's own `.pid` file.
 * @level    l1 (the reader and the health word, against a temp workdir) and
 *           l2 (the box, painted)
 * @consumer the operator reading the bottom of `yrd watch`
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { runId } from "@yrd/queue-core"
import { RunnerBox } from "../src/watch-boxes.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import { SILENT_AFTER_MS, readRunnerFacts, runnerHealth, type RunnerFacts } from "../src/watch-runner.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

/** A workdir with one run journal started `ageMs` ago, its header record, and optionally a `.pid` file. */
function workdirWith(
  options: Readonly<{ ageMs: number; pid?: number; header?: boolean; lastWriteAgoMs?: number }>,
): string {
  const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
  const logs = join(workdir, "logs")
  mkdirSync(logs, { recursive: true })
  const id = runId(new Date(NOW.getTime() - options.ageMs))
  const path = join(logs, `${id}.jsonl`)
  const header =
    options.header === false
      ? "not a record\n"
      : `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck", "test"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", queue: "main", run: id, target: "main" })}\n`
  writeFileSync(path, header)
  const lastWrite = new Date(NOW.getTime() - (options.lastWriteAgoMs ?? 0))
  utimesSync(path, lastWrite, lastWrite)
  if (options.pid !== undefined) {
    mkdirSync(join(workdir, "worktrees", id), { recursive: true })
    writeFileSync(join(workdir, "worktrees", id, ".pid"), `${String(options.pid)}\n`)
  }
  return workdir
}

describe("readRunnerFacts", () => {
  it("says where it looked when there is no journal directory, and when the directory holds no run", () => {
    const empty = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
    expect(readRunnerFacts(empty).absent).toContain("there is no such directory")
    mkdirSync(join(empty, "logs"))
    expect(readRunnerFacts(empty).absent).toContain("holds no run journal")
  })

  it("reads the newest run: its instant from the name, the header record, the last write, and whether its process lives", () => {
    const facts = readRunnerFacts(workdirWith({ ageMs: 60_000, pid: process.pid, lastWriteAgoMs: 5_000 }))
    const latest = facts.latest
    if (latest === undefined) throw new Error("no run read")
    expect(latest.alive).toBe(true)
    expect(latest.pid).toBe(process.pid)
    expect(latest.startedAt.getTime()).toBe(NOW.getTime() - 60_000)
    expect(Math.abs(latest.lastWriteAt.getTime() - (NOW.getTime() - 5_000))).toBeLessThan(1_500)
    expect(latest.target).toBe("main")
    expect(latest.checks).toEqual(["typecheck", "test"])
    expect(latest.gitlink?.startsWith("3c285a41af46")).toBe(true)
  })

  it("reads a dead pid as not alive and a journal without a header record as a run with no header", () => {
    // 2147483647 is the largest pid Linux can hand out and is not ours.
    const dead = readRunnerFacts(workdirWith({ ageMs: 60_000, pid: 2_147_483_647 }))
    expect(dead.latest?.alive).toBe(false)
    const headless = readRunnerFacts(workdirWith({ ageMs: 60_000, header: false }))
    expect(headless.latest?.target).toBeUndefined()
    expect(headless.latest?.alive).toBe(false)
  })
})

describe("runnerHealth, the one word", () => {
  const facts = (over: Partial<NonNullable<RunnerFacts["latest"]>>): RunnerFacts => ({
    journalDir: "/w/logs",
    latest: { alive: false, id: "q-x", lastWriteAt: NOW, startedAt: NOW, ...over },
  })

  it("is running while the run's process lives, whatever else is true", () => {
    expect(runnerHealth(facts({ alive: true, lastWriteAt: new Date(0) }), 5, NOW)).toBe("running")
  })

  it("is absent with no journal, silent past the ceiling only while something waits in line, idle otherwise", () => {
    expect(runnerHealth({ journalDir: "/w/logs", absent: "none" }, 3, NOW)).toBe("absent")
    const quiet = facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS - 1) })
    expect(runnerHealth(quiet, 1, NOW)).toBe("silent")
    expect(runnerHealth(quiet, 0, NOW)).toBe("idle")
    expect(runnerHealth(facts({ lastWriteAt: new Date(NOW.getTime() - SILENT_AFTER_MS + 1_000) }), 3, NOW)).toBe("idle")
  })
})

describe("the RUNNER box", () => {
  async function paint(facts: RunnerFacts, inLine: number, pause?: string): Promise<string> {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox
            facts={facts}
            label="main"
            inLine={inLine}
            columns={70}
            live={false}
            {...(pause === undefined ? {} : { pause })}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 72, rows: 12 },
    )
    await app.waitForLayoutStable()
    const text = app.text
    app.unmount()
    return text
  }
  const latest = (over: Partial<NonNullable<RunnerFacts["latest"]>>): RunnerFacts => ({
    journalDir: "/w/logs",
    latest: {
      alive: false,
      checks: ["typecheck", "test"],
      gitlink: "3c285a41af46".padEnd(40, "0"),
      id: "q-20260903T115800000Z-0badf00d",
      lastWriteAt: new Date(NOW.getTime() - 2_000),
      startedAt: new Date(NOW.getTime() - 120_000),
      target: "main",
      ...over,
    },
  })

  it("names the live run with its pid on the `$` line, the run's facts and the measured-at clock under it, hanging off one gutter", async () => {
    const text = await paint(latest({ alive: true, pid: 4242 }), 1)

    expect(text).toContain("RUNNER")
    expect(text).toContain("run 2:00")
    expect(text).toContain("$ yrd queue run · main#")
    expect(text).toContain("[pid 4242]")
    expect(text).toMatch(/^\s*│\s{3}target main · gitlink 3c285a41af46 · checks typecheck, test/mu)
    expect(text).toMatch(/progress \d\d:\d\d:\d\d · 0:02 ago/u)
  })

  it("reads idle between runs, naming the last run and how long ago it wrote", async () => {
    const text = await paint(latest({}), 0)

    expect(text).toContain("idle 0:02")
    expect(text).toContain("$ yrd queue up · last run main#")
    expect(text).toContain("wrote 0:02 ago")
    expect(text).not.toContain("SILENT")
  })

  it("goes loud when changes wait and nothing has written past the ceiling", async () => {
    const text = await paint(latest({ lastWriteAt: new Date(NOW.getTime() - 12 * 60_000) }), 3)

    expect(text).toContain("silent 12:00")
    expect(text).toContain("RUNNER SILENT — no journal write for 12:00 while 3 changes wait in")
    expect(text).toContain("hab ps yrd-service")
  })

  it("says where the journal was looked for when there is none, never a blank", async () => {
    const text = await paint(
      { journalDir: "/w/logs", absent: "no run journal was read: /w/logs — there is no such directory" },
      2,
    )

    expect(text).toContain("$ yrd queue up")
    expect(text).toContain("/w/logs")
  })

  it("carries the pause on its own warning rail (item 27)", async () => {
    const text = await paint(latest({}), 0, "paused by @chief: the host is down")

    expect(text).toContain("⚠︎ paused by @chief: the host is down")
  })

  it("wraps a long command with a hanging indent bounded to three rows, so the rails under it survive (item 29)", async () => {
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox
            facts={latest({ alive: true, pid: 4242 })}
            label="a-very-long-queue-label-indeed-and-then-some-more-of-it"
            inLine={1}
            columns={30}
            live={false}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      { cols: 32, rows: 14 },
    )
    await app.waitForLayoutStable()
    const lines = app.text.split("\n")
    const command = lines.findIndex((line) => line.includes("$ yrd"))
    expect(command).toBeGreaterThan(-1)
    // At most three rows of command, the third ending in an ellipsis, then the rails.
    expect(lines.slice(command, command + 3).join("\n")).toContain("…")
    expect(app.text).toContain("progress")
    app.unmount()
  })
})
