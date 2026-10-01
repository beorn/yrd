/**
 * @failure  yrd watch's detail pane at 140x50 repeats facts, indents an
 *           undeclared-check note as a wrapped line, leaves empty rows above
 *           the log, and misaligns the unpublished RUNNER row inside its box.
 * @level    l2
 * @consumer @i/10-yrd/24169-yrd-watch-and-list-display/26242-yrd-watch-detail-pane-says-each-fact-once-and-gives-its-space-to-the-log
 * @testonly none
 *
 * Operator specimen: /home/hh/scratch/dev1-24197/24197-long-log-140x50.png
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { bufferToStyledText, debugTree, render } from "silvery/test"
import { createTerminal } from "@termless/core"
import { createGhosttyBackend, initGhostty } from "@termless/ghostty"
import { NowContext, MinuteContext } from "../src/watch-clock.ts"
import { runOf } from "../src/watch-run.ts"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import type { ChangeDetail, CheckPanel } from "../src/watch-detail.tsx"
import type { WatchRow } from "../src/watch-rows.ts"
import type { Row } from "@yrd/queue-core"

const NOW = new Date("2026-09-27T19:50:00.000Z")
const RUN_ID = "q-20260927T185000000Z-affected"

function writeCaptureIfConfigured(name: string, content: string | Uint8Array): void {
  const dir = process.env.YRD_CAPTURE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
}

async function renderAnsiPng(ansi: string, opts: { cols: number; rows: number }): Promise<Uint8Array> {
  await initGhostty()
  const backend = createGhosttyBackend()
  const term = createTerminal({ backend, cols: opts.cols, rows: opts.rows })
  term.feed(ansi.replace(/\r?\n/g, "\r\n"))
  return term.screenshot()
}

function failedRow(): Row {
  return {
    branch: "task/24197-240col-gate",
    head: "a".repeat(40),
    since: new Date(NOW.getTime() - 7_200_000),
    at: NOW,
    endedAt: NOW,
    startedAt: new Date(NOW.getTime() - 90_000),
    state: "failed",
    subject: "verify nested row wrapping at narrow width",
    reason: "affected-tests failed",
    result: "fail affected-tests",
    run: RUN_ID,
    submitter: "@dev/1",
    next: {
      owner: "@dev/1",
      because: "it failed (affected-tests), and only the branch's author can move it",
    },
  }
}

const LONG_LOG = Array.from(
  { length: 40 },
  (_, index) =>
    `LONG CHECK LOG ${String(index + 1).padStart(2, "0")} — nested row wrap verification output for the selected failed check must wrap inside the detail pane;`,
).join("\n")

const UNDECLARED_FAILED: CheckPanel = {
  name: "affected-tests",
  state: "failed",
  output: LONG_LOG,
  result: { exit: "1", log: "/w/checks/affected-tests.log", ms: 1000, result: "fail" },
}

function snapshot(rowCount = 1): WatchSnapshot {
  const rows: WatchRow[] = Array.from({ length: rowCount }, (_, index) => ({
    row: { ...failedRow(), branch: index === 0 ? failedRow().branch : `task/other-failed-${index}` },
  }))
  return {
    at: NOW,
    queue: "github.com/beorn/hh-dev#main",
    queues: [{ branch: "main", label: "main", path: "/hh/dev" }],
    rows,
    unfiltered: rows,
    runner: {
      journalDir: "/w/logs",
      absent: "no run journal was read: /w/logs — there is no such directory",
      service: { kind: "absent", why: "no health document at /w/service-health.json" },
    },
  }
}

function opener(checks: readonly CheckPanel[] = [UNDECLARED_FAILED]) {
  return vi.fn(async (item: WatchRow): Promise<ChangeDetail> => {
    return {
      checks,
      row: item.row,
      run: runOf(item.row, "main", checks, item.row.run),
    }
  })
}

async function paint(
  size = { cols: 140, rows: 50 },
  rowCount = 1,
  checks: readonly CheckPanel[] = [UNDECLARED_FAILED],
  withWarning = false,
): Promise<{ text: string; lines: string[]; ansi: string }> {
  let rejectQueueRead: ((error: Error) => void) | undefined
  const load = withWarning
    ? () =>
        new Promise<WatchSnapshot>((_resolve, reject) => {
          rejectQueueRead = reject
        })
    : undefined
  const app = render(
    <NowContext.Provider value={NOW}>
      <MinuteContext.Provider value={NOW}>
        <WatchPane snapshot={snapshot(rowCount)} live={withWarning} load={load} intervalMs={10} open={opener(checks)} />
      </MinuteContext.Provider>
    </NowContext.Provider>,
    size,
  )
  await app.waitForLayoutStable()
  app.press("ArrowDown")
  await app.waitForLayoutStable()
  app.press("Enter")
  await app.waitForLayoutStable()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await app.waitForLayoutStable()
  if (withWarning) {
    await vi.waitFor(() => expect(rejectQueueRead).toBeDefined())
    rejectQueueRead!(new Error("fixture queue read failed at /fixture/queue"))
    await vi.waitFor(async () => {
      await app.waitForLayoutStable()
      expect(app.text).toContain("fixture queue read failed at /fixture/queue")
    })
  }
  const text = app.text
  const ansi = bufferToStyledText(app.term.buffer)
  writeCaptureIfConfigured(`yrd-watch-26242-${size.cols}x${size.rows}.layout.txt`, debugTree(app.getContainer()))
  writeCaptureIfConfigured(`yrd-watch-26242-${size.cols}x${size.rows}.ansi`, ansi)
  writeCaptureIfConfigured(`yrd-watch-26242-${size.cols}x${size.rows}.png`, await renderAnsiPng(ansi, size))
  app.unmount()
  return { text, lines: text.split("\n"), ansi }
}

function leadingSpaces(line: string): number {
  const match = /^ */u.exec(line.replace(/[╭─╮│╰┘┌┐]/gu, " "))
  return match?.[0].length ?? 0
}

describe("26242: watch detail pane at 140x50", () => {
  it("row 1: undeclared-check note and status share one left edge", async () => {
    const { lines } = await paint()
    const note = lines.find((line) => line.includes("does not name this check"))
    const status = lines.find((line) => /failed exit=/u.test(line))
    const log = lines.find((line) => line.includes("LONG CHECK LOG 01"))
    expect(note).toBeDefined()
    expect(status).toBeDefined()
    expect(log).toBeDefined()
    const edge = leadingSpaces(log!)
    expect(Math.abs(leadingSpaces(note!) - edge)).toBeLessThanOrEqual(1)
    expect(Math.abs(leadingSpaces(status!) - edge)).toBeLessThanOrEqual(1)
  })

  it("row 2: each fact appears once", async () => {
    const { text, lines } = await paint()
    expect(text).not.toMatch(/Failed affected-tests failed/u)
    expect(text).not.toMatch(/\(err=/u)
    expect(text.match(/× affected-tests/g)?.length ?? 0).toBe(1)
    expect(text.match(/0:01/g)?.length ?? 0).toBeLessThanOrEqual(1)
    const failureHits = [...text.matchAll(/it failed \(affected-tests\)/giu)].length
    expect(failureHits).toBe(1)
    expect(text).not.toMatch(/Failed\s+It failed/u)
    const heading = lines.find((line) => /it failed \(affected-tests\)/iu.test(line))
    expect(heading).toBeDefined()
    expect((heading!.match(/failed/giu) ?? []).length).toBe(1)
  })

  it("row 3: unframed detail grows into free rows and a cut log says how many lines follow", async () => {
    const { lines, text } = await paint()
    const tableRow = lines.findIndex((line) => line.includes("task/24197-240col-gate"))
    const statusBox = lines.findIndex((line) => line.includes("RUN main") || line.includes("Failed"))
    expect(tableRow).toBeGreaterThanOrEqual(0)
    expect(statusBox).toBeGreaterThan(tableRow)
    const gap = lines.slice(tableRow + 1, statusBox).filter((line) => line.trim() === "").length
    expect(gap).toBeLessThanOrEqual(3)
    expect(text).toMatch(/\d+ more lines/u)
    const more = lines.findIndex((line) => /\d+ more lines/u.test(line))
    expect(more).toBeGreaterThan(-1)
    // Operator's 24197 review: the selected details under the tabs have no
    // surrounding frame. The status box above the tabs remains its own box.
    const tabs = lines.findIndex((line) => line.includes("Timeline") && line.includes("checking"))
    expect(tabs).toBeGreaterThan(-1)
    expect(lines.slice(tabs + 1).join("\n")).not.toMatch(/[╭╮╰╯]/u)
  })

  // 24197 AC2: both the list and the long log must remain useful at 200×40.
  // The one-check fixture misses the actual summary, command and path chrome.
  it("24197: a dense below-tier list and selected check log remain visible at 200x40", async () => {
    const checks: readonly CheckPanel[] = [
      { name: "typecheck", state: "not-run" },
      {
        name: "lockfile-agreement",
        state: "failed",
        spec: { name: "lockfile-agreement", run: "bun tools/check-lockfile-agreement.ts" },
        log: "/w/checks/lockfile-agreement.log",
        result: { exit: "1", log: "/w/checks/lockfile-agreement.log", ms: 1000, result: "fail" },
        // AC2 includes a genuinely wrapped log line, with no pre-wrapping.
        output: `${"WRAPPED CHECK LOG BEGIN ".padEnd(420, "wrapped detail output ")}\n${LONG_LOG}`,
      },
      { name: "affected-tests", state: "not-run" },
    ]
    const { text, lines } = await paint({ cols: 200, rows: 40 }, 40, checks, true)
    const header = lines.findIndex((line) => /TIME.*RUN.*CHANGES/u.test(line))
    const detail = lines.findIndex((line) => line.includes("It failed"))
    expect(header).toBeGreaterThanOrEqual(0)
    expect(detail).toBeGreaterThan(header)
    // The selected identity repeats in the detail: inspect only the list region.
    expect(lines.slice(header + 1, detail).join("\n")).toContain("task/24197-240col-gate")
    expect(text).toContain("WRAPPED CHECK LOG BEGIN")
    expect(text).toMatch(/\d+ more lines/u)
    expect(lines[39]).toContain("fixture queue read failed at /fixture/queue")
  })

  // 26242 row 4: RUNNER box retired in favour of borderless runner (operator round-2 feedback Telegram 1cfdbd57)
  it("row 4: borderless RUNNER sits under RUN (operator round-2 feedback Telegram 1cfdbd57)", async () => {
    const { lines, text } = await paint()
    expect(text).toMatch(/RUNNER/u)
    expect(text).toMatch(/no runner status published/u)
    const runnerTitle = lines.find((line) => line.includes("RUNNER") && line.includes("github.com"))
    expect(runnerTitle).toBeDefined()
    const header = lines.find((line) => line.includes("TIME") && line.includes("RUN") && line.includes("CHANGES"))
    const inner = lines.find((line) => line.includes("no runner status published"))
    expect(header).toBeDefined()
    expect(inner).toBeDefined()
    const runAt = header!.indexOf("RUN")
    const changesAt = header!.indexOf("CHANGES")
    const dashAt = inner!.indexOf("—")
    const holdsAt = inner!.indexOf("no runner status")
    expect(dashAt).toBeGreaterThanOrEqual(runAt - 1)
    expect(dashAt).toBeLessThan(changesAt)
    expect(holdsAt).toBeGreaterThanOrEqual(changesAt - 2)
    // Borderless runner: no rounded corner or box borders (operator round-2 feedback Telegram 1cfdbd57)
    expect(runnerTitle).toContain("RUNNER")
    expect(text).not.toMatch(/█/u)
  })
})

describe("26243: watch uses one clock format, one duration format and plain words at 140x50", () => {
  it("pins unified clock times, unified durations and plain phrases", async () => {
    const { text, lines } = await paint()

    // Clock times use one form: HH:MM, no seconds across the whole watch screen
    expect(text).not.toMatch(/\b\d\d:\d\d:\d\d\b/u)

    // Durations use one form: AGE / RUN values use the same duration form (no rogue 01:30)
    expect(text).toContain("2h00m / 1:30")
    expect(text).not.toContain("2h00m / 01:30")

    // Plain phrases replace internal terms
    expect(text).not.toContain("not journaled")
    expect(text).toContain("− not recorded")
    expect(text).not.toContain("cut 1/1")
    expect(text).toContain("attempt 1/1")
    expect(text).not.toContain("err=")
  })

  it("round 5: two queues at 140x50 have stacked runner boxes then tasks interleaved by time", async () => {
    const size = { cols: 140, rows: 50 }
    const rowQ1Newest: WatchRow = {
      row: {
        ...failedRow(),
        branch: "task/q1-newest",
        at: NOW,
        endedAt: NOW,
      },
    }
    const rowQ1Oldest: WatchRow = {
      row: {
        ...failedRow(),
        branch: "task/q1-oldest",
        at: new Date(NOW.getTime() - 120_000),
        endedAt: new Date(NOW.getTime() - 120_000),
      },
    }
    const rowQ2Middle: WatchRow = {
      row: {
        ...failedRow(),
        branch: "task/q2-middle",
        at: new Date(NOW.getTime() - 60_000),
        endedAt: new Date(NOW.getTime() - 60_000),
      },
    }
    const first: WatchSnapshot = {
      ...snapshot(2),
      rows: [rowQ1Newest, rowQ1Oldest],
      unfiltered: [rowQ1Newest, rowQ1Oldest],
    }
    const second: WatchSnapshot = {
      ...snapshot(1),
      queue: "github.com/beorn/hh-dev#queue2",
      queues: [{ branch: "queue2", label: "queue2", path: "/hh/dev" }],
      rows: [rowQ2Middle],
      unfiltered: [rowQ2Middle],
    }
    const app = render(
      <NowContext.Provider value={NOW}>
        <MinuteContext.Provider value={NOW}>
          <WatchPane
            snapshot={first}
            sources={[
              { id: "one#main", label: "one", snapshot: first },
              { id: "two#main", label: "two", snapshot: second },
            ]}
            live={false}
            open={opener()}
          />
        </MinuteContext.Provider>
      </NowContext.Provider>,
      size,
    )
    await app.waitForLayoutStable()

    // No per-queue group headers '[1] one — Enter to focus'
    expect(app.text).not.toContain("Enter to focus")

    // Both queues have an outlined RUNNER box stacked at the top
    const runnerLineIndices = app.lines.map((l, i) => (l.includes("╭─ RUNNER") ? i : -1)).filter((i) => i >= 0)
    expect(runnerLineIndices).toHaveLength(2)
    const r1Line = runnerLineIndices[0]!
    const r2Line = runnerLineIndices[1]!

    const t1Line = app.lines.findIndex((l) => l.includes("task/q1-newest"))
    const t2Line = app.lines.findIndex((l) => l.includes("task/q2-middle"))
    const t3Line = app.lines.findIndex((l) => l.includes("task/q1-oldest"))

    expect(r1Line).toBeGreaterThanOrEqual(0)
    expect(r2Line).toBe(r1Line + 3)

    // Stacked RUNNER boxes have 0 blank rows between them (bottom border line directly precedes top border line)
    expect(app.lines[r1Line + 2]).toContain("╰")
    expect(app.lines[r1Line + 3]).toContain("╭")

    // Queue 2's runner line displays its own queue ref (refs/yrd/queue2/runner), not main
    expect(app.lines[r2Line + 1]).toContain("refs/yrd/queue2/runner")
    expect(app.lines[r2Line + 1]).not.toContain("refs/yrd/main/runner")

    // Exactly 1 blank row after the last RUNNER box before the task list
    expect(app.lines[r2Line + 2]).toContain("╰")
    expect(app.lines[r2Line + 3]?.trim()).toBe("")
    expect(t1Line).toBe(r2Line + 4)
    expect(t2Line).toBeGreaterThan(t1Line)
    expect(t3Line).toBeGreaterThan(t2Line)

    // Q column shows queue digit or label for each interleaved row
    expect(app.lines[t1Line]).toMatch(/\b1\b/)
    expect(app.lines[t2Line]).toMatch(/\b2\b/)
    expect(app.lines[t3Line]).toMatch(/\b1\b/)

    const ansi = bufferToStyledText(app.term.buffer)
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round4.layout.txt", debugTree(app.getContainer()))
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round4.ansi", ansi)
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round4.png", await renderAnsiPng(ansi, size))
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round5.layout.txt", debugTree(app.getContainer()))
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round5.ansi", ansi)
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round5.png", await renderAnsiPng(ansi, size))
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round5b.layout.txt", debugTree(app.getContainer()))
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round5b.ansi", ansi)
    writeCaptureIfConfigured("yrd-watch-two-queues-140x50-round5b.png", await renderAnsiPng(ansi, size))
    writeCaptureIfConfigured("yrd-watch-live-round5.ansi", ansi)
    writeCaptureIfConfigured("yrd-watch-live-round5.png", await renderAnsiPng(ansi, size))
    writeCaptureIfConfigured("yrd-watch-live-round5b.ansi", ansi)
    writeCaptureIfConfigured("yrd-watch-live-round5b.png", await renderAnsiPng(ansi, size))

    app.unmount()
  })
})
