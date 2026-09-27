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
import { bufferToStyledText, render } from "silvery/test"
import { NowContext, MinuteContext } from "../src/watch-clock.ts"
import { runOf } from "../src/watch-run.ts"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import type { ChangeDetail, CheckPanel } from "../src/watch-detail.tsx"
import type { WatchRow } from "../src/watch-rows.ts"
import type { Row } from "@yrd/queue-core"

const NOW = new Date("2026-09-27T19:50:00.000Z")
const RUN_ID = "q-20260927T185000000Z-affected"

function writeCaptureIfConfigured(name: string, content: string): void {
  const dir = process.env.YRD_CAPTURE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
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

function snapshot(): WatchSnapshot {
  const rows: WatchRow[] = [{ row: failedRow() }]
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

function opener() {
  return vi.fn(async (item: WatchRow): Promise<ChangeDetail> => {
    const checks = [UNDECLARED_FAILED]
    return {
      checks,
      row: item.row,
      run: runOf(item.row, "main", checks, item.row.run),
    }
  })
}

async function paint140x50(): Promise<{ text: string; lines: string[]; ansi: string }> {
  const app = render(
    <NowContext.Provider value={NOW}>
      <MinuteContext.Provider value={NOW}>
        <WatchPane snapshot={snapshot()} live={false} open={opener()} />
      </MinuteContext.Provider>
    </NowContext.Provider>,
    { cols: 140, rows: 50 },
  )
  await app.waitForLayoutStable()
  app.press("ArrowDown")
  await app.waitForLayoutStable()
  app.press("Enter")
  await app.waitForLayoutStable()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await app.waitForLayoutStable()
  const text = app.text
  const ansi = bufferToStyledText(app.term.buffer)
  writeCaptureIfConfigured("yrd-watch-26242-140x50.ansi", ansi)
  app.unmount()
  return { text, lines: text.split("\n"), ansi }
}

function leadingSpaces(line: string): number {
  const match = /^ */u.exec(line.replace(/[╭─╮│╰┘┌┐]/gu, " "))
  return match?.[0].length ?? 0
}

describe("26242: watch detail pane at 140x50", () => {
  it("row 1: undeclared-check note and status share one left edge", async () => {
    const { lines } = await paint140x50()
    const note = lines.find((line) => line.includes("does not name this check"))
    const status = lines.find((line) => /failed exit=/u.test(line))
    expect(note).toBeDefined()
    expect(status).toBeDefined()
    expect(Math.abs(leadingSpaces(note!) - leadingSpaces(status!))).toBeLessThanOrEqual(1)
  })

  it("row 2: each fact appears once", async () => {
    const { text } = await paint140x50()
    expect(text).not.toMatch(/Failed affected-tests failed/u)
    expect(text).not.toMatch(/\(err=/u)
    expect(text.match(/× affected-tests/g)?.length ?? 0).toBe(1)
    expect(text.match(/0:01/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it("row 3: detail grows into free rows and a cut log says how many lines follow", async () => {
    const { lines, text } = await paint140x50()
    const lastList = lines.findIndex((line) => line.includes("task/24197-240col-gate"))
    const firstDetail = lines.findIndex((line) => line.includes("Failed") || line.includes("does not name this check"))
    expect(lastList).toBeGreaterThanOrEqual(0)
    expect(firstDetail).toBeGreaterThan(lastList)
    const gap = lines.slice(lastList + 1, firstDetail).filter((line) => line.trim() === "").length
    expect(gap).toBeLessThanOrEqual(3)
    expect(text).toMatch(/\d+ more lines/u)
  })

  it("row 4: RUNNER keeps its rounded box; inner dash sits under RUN", async () => {
    const { lines, text } = await paint140x50()
    expect(text).toMatch(/╭.*RUNNER/u)
    expect(text).toMatch(/╰/u)
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
  })
})
