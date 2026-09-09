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
import { createTermless, render } from "silvery/test"
import { run } from "silvery/runtime"
import { runId } from "@yrd/queue-core"
import { RunnerBox } from "../src/watch-boxes.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import { WATCH_RUN_OPTIONS } from "../src/watch-run-options.ts"
import { SILENT_AFTER_MS, readRunnerFacts, runnerHealth, type RunnerFacts } from "../src/watch-runner.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

/** A workdir with one run journal started `ageMs` ago, its header record, and optionally a `.pid` file. */
function workdirWith(
  options: Readonly<{
    ageMs: number
    pid?: number
    pidDirectory?: boolean
    pidText?: string
    header?: boolean | string
    gitBeforeHeader?: boolean
    lastWriteAgoMs?: number
  }>,
): string {
  const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
  const logs = join(workdir, "logs")
  mkdirSync(logs, { recursive: true })
  const id = runId(new Date(NOW.getTime() - options.ageMs))
  const path = join(logs, `${id}.jsonl`)
  const header =
    typeof options.header === "string"
      ? options.header
      : options.header === false
        ? "not a record\n"
        : `${JSON.stringify({ at: NOW.toISOString(), checks: ["typecheck", "test"], gitlink: "3c285a41af46".padEnd(40, "0"), kind: "run", queue: "main", run: id, target: "main" })}\n`
  const prefix = options.gitBeforeHeader
    ? `${JSON.stringify({ kind: "git", run: id, at: NOW.toISOString(), evidence: join(logs, id, "git", "1.stdout.bin.json") })}\n`
    : ""
  writeFileSync(path, `${prefix}${header}`)
  const lastWrite = new Date(NOW.getTime() - (options.lastWriteAgoMs ?? 0))
  utimesSync(path, lastWrite, lastWrite)
  if (options.pid !== undefined || options.pidText !== undefined || options.pidDirectory === true) {
    mkdirSync(join(workdir, "worktrees", id), { recursive: true })
    const pidPath = join(workdir, "worktrees", id, ".pid")
    if (options.pidDirectory === true) mkdirSync(pidPath)
    else writeFileSync(pidPath, options.pidText ?? `${String(options.pid)}\n`)
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

  it.each([false, true])(
    "reads the newest run, including its header after Git evidence: prefix=%s",
    (gitBeforeHeader) => {
      const facts = readRunnerFacts(
        workdirWith({ ageMs: 60_000, pid: process.pid, lastWriteAgoMs: 5_000, gitBeforeHeader }),
      )
      const latest = facts.latest
      if (latest === undefined) throw new Error("no run read")
      expect(latest.alive).toBe(true)
      expect(latest.pid).toBe(process.pid)
      expect(latest.startedAt.getTime()).toBe(NOW.getTime() - 60_000)
      expect(Math.abs(latest.lastWriteAt.getTime() - (NOW.getTime() - 5_000))).toBeLessThan(1_500)
      expect(latest.target).toBe("main")
      expect(latest.checks).toEqual(["typecheck", "test"])
      expect(latest.gitlink?.startsWith("3c285a41af46")).toBe(true)
    },
  )

  it("reads a dead pid as not alive", () => {
    // 2147483647 is the largest pid Linux can hand out and is not ours.
    const dead = readRunnerFacts(workdirWith({ ageMs: 60_000, pid: 2_147_483_647 }))
    expect(dead.latest?.alive).toBe(false)
  })

  it.each([
    ["invalid JSON", "not a record\n"],
    ["an empty record", "\n"],
    ["the wrong record kind", `${JSON.stringify({ kind: "message" })}\n`],
    ["an incomplete Git record", `${JSON.stringify({ kind: "git" })}\n`],
    [
      "Git evidence without a run header",
      `${JSON.stringify({ kind: "git", run: "q-test", at: NOW.toISOString(), evidence: "/logs/git/1.json" })}\n`,
    ],
  ])("refuses a required run journal with %s", (_case, header) => {
    const workdir = workdirWith({ ageMs: 60_000, header })
    expect(() => readRunnerFacts(workdir)).toThrow(/run journal .* (record|header)/u)
  })

  it("refuses a newest run journal that cannot be read", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-watch-runner-"))
    const logs = join(workdir, "logs")
    mkdirSync(logs)
    const path = join(logs, `${runId(new Date(NOW.getTime() - 60_000))}.jsonl`)
    mkdirSync(path)

    expect(() => readRunnerFacts(workdir)).toThrow(`run journal ${path}`)
  })

  it("refuses malformed and unreadable run pid files instead of calling the runner idle", () => {
    const malformed = workdirWith({ ageMs: 60_000, pidText: "42junk\n" })
    expect(() => readRunnerFacts(malformed)).toThrow(/run pid file .* positive safe integer/u)

    const unreadable = workdirWith({ ageMs: 60_000, pidDirectory: true })
    expect(() => readRunnerFacts(unreadable)).toThrow(/run pid file .* cannot be read/u)
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
    // The banner is pre-wrapped into rows under its marker (never a live wrap): read it row by row.
    expect(text).toContain("RUNNER SILENT — no journal write for 12:00 while 3 changes wait")
    expect(text).toContain("in line; is yrd-service up? (hab ps yrd-service)")
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

  /**
   * @failure The RUNNING marker pulsed between two FOREGROUND tokens
   *          ($fg-info against $fg-muted, #81A1C1 against #8F95A1, 1.12:1)
   *          while the IDLE marker swung against the ground at 4.15:1 — so the
   *          marker blinked while the queue was IDLE and sat still while a run
   *          EXECUTED. Salience inverted, which is worse than no indicator: the
   *          operator read a working queue as a dead one.
   * @level   l1 (the painted cell, under termless, logical colour only)
   * @consumer the operator watching whether anything is happening
   *
   * NOTHING COVERED THIS. Every other RunnerBox render in this file passes
   * live={false}, so neither Pulse branch was executed by any test, and no test
   * in the package asserted a FOREGROUND colour at all.
   */
  it("the running marker actually pulses, and its two phases are far apart", async () => {
    using term = createTermless({ cols: 72, rows: 12 })
    const handle = await run(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <RunnerBox facts={latest({ alive: true, pid: 4242 })} label="main" inLine={1} columns={70} live />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      term,
      WATCH_RUN_OPTIONS,
    )
    try {
      await handle.waitForLayoutStable()
      const lines = term.screen.getLines()
      const row = lines.findIndex((line) => line.includes("$ yrd queue run"))
      expect(row, "the running marker line must be painted").toBeGreaterThan(-1)
      const column = lines[row]!.indexOf("$")

      // GUARD THE CAPTURE BEFORE MEASURING IT. Under a 16-colour capture Nord
      // #81a1c1 collapses to #c0c0c0, and two earlier findings on this exact
      // view were WITHDRAWN on 2026-09-07 for that artifact. A distance
      // computed off a degraded capture is a confident wrong answer, which is
      // the defect family this arm belongs to. Termless hands back a truecolor
      // {r,g,b} only when it really captured one, so the SHAPE is the guard.
      const rgb = (at: { readonly fg: unknown }): readonly [number, number, number] => {
        const fg = at.fg as { r?: unknown; g?: unknown; b?: unknown } | null
        expect(fg, "the marker cell must carry a colour at all").not.toBeNull()
        for (const channel of ["r", "g", "b"] as const) {
          expect(typeof fg?.[channel], `${channel} must be a truecolor channel, not an ANSI index`).toBe("number")
        }
        return [fg?.r as number, fg?.g as number, fg?.b as number]
      }

      const first = rgb(term.cell(row, column))
      // Wait for the OBSERVABLE flip rather than sleeping one pulse interval:
      // the phase comes from a shared synchronized clock this component does not
      // expose, so a fixed sleep could sample the same phase twice.
      let second = first
      const deadline = Date.now() + 4_000
      while (second.every((value, at) => value === first[at]) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        second = rgb(term.cell(row, column))
      }
      expect(second, "a running marker that never changes colour is not pulsing").not.toEqual(first)

      // The two phases must be FAR apart, not merely unequal. The defect WAS
      // unequal — #81A1C1 against #8F95A1 differs in every channel and is still
      // invisible at 1.12:1. Largest per-channel distance is deliberately crude
      // and local: it needs no dependency yrd-cli does not already carry, and it
      // is a comparison rather than a second contrast implementation.
      //
      // MEASURED, not chosen: run against the pre-fix source this arm fails with
      // "phases 129,161,193 and 143,149,161 ... expected 32 to be greater than
      // 40" — #81A1C1 against #8F95A1, the exact pair the report named at
      // 1.12:1. So 40 sits above the defect and below the fixed pair, and the
      // arm is red-first by construction rather than by assertion.
      const distance = Math.max(...first.map((value, at) => Math.abs(value - second[at]!)))
      expect(distance, `phases ${first.join(",")} and ${second.join(",")} are too close to see`).toBeGreaterThan(40)
    } finally {
      handle.unmount()
    }
  }, 20_000)
})
