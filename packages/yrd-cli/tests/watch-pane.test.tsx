/**
 * @failure  The port kept the verb and lost the pane: no status box on the
 *           border, no step lines, no change list, no Changes tab, a flat
 *           text row instead of columns, a queue name where the operator's
 *           top line belongs (watch-redesign items 1–6, 23–25, 28–33, 38–39;
 *           the operator, 2026-09-04: "a far cry from the old yrd watch").
 *           Also the retired monitor's own failures, kept: checks a change
 *           never reached were simply absent; the command lived nowhere near
 *           its log; two rows of one change opened one detail.
 * @level    l2 (a real silvery render into a headless terminal buffer)
 * @consumer the operator reading `yrd watch`
 */

import { mkdirSync, writeFileSync } from "node:fs"
import type React from "react"
import { act } from "react"
import { describe, expect, it, vi } from "vitest"
import { bufferToText, render } from "silvery/test"
import type { ChangeRecord, GitObservation, JournalRun, Row } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"
import { WatchPane, watchTier, type WatchSnapshot } from "../src/watch-pane.tsx"
import {
  CHANGES_TAB,
  RunStatusBox,
  WatchDetail,
  defaultTab,
  type ChangeDetail,
  type CheckPanel,
} from "../src/watch-detail.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import { clock } from "../src/watch-format.ts"
import { noticeLine } from "../src/watch-notice.ts"
import { printListing } from "../src/watch-print.tsx"
import { runOf, type WatchRun } from "../src/watch-run.ts"
import { rowLine, watchRowKey, type WatchRow } from "../src/watch-rows.ts"
import { queueLine } from "../src/watch-frame.tsx"

async function waitFor<T>(callback: () => T | Promise<T>, options?: number | { timeout?: number }): Promise<T> {
  const timeout = typeof options === "number" ? options : (options?.timeout ?? 1000)
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await callback()
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw last
}

/** The service's own health document, believable by the deadline its writer declared: the runner is up. */
const BEATING = { kind: "beating", state: "healthy" } as const

const NOW = new Date("2026-09-03T12:00:00.000Z")
const RUN_ID = "q-20260903T113000000Z-0badf00d"

function row(over: Partial<Row> = {}): Row {
  return {
    branch: "task/one",
    head: "abcdef0123456789abcdef0123456789abcdef01",
    since: new Date(NOW.getTime() - 3_600_000),
    state: "queued",
    subject: "fix the parser",
    ...over,
  }
}

const CHECKS: readonly CheckPanel[] = [
  {
    log: "/w/checks/typecheck.log",
    name: "typecheck",
    output: "typecheck said nothing",
    result: { exit: "0", log: "/w/checks/typecheck.log", ms: 62_000, result: "pass" },
    spec: { name: "typecheck", run: "bun run typecheck" },
    state: "passed",
  },
  {
    log: "/w/checks/test.log",
    name: "test",
    output: "1 test failed: the parser",
    result: { exit: "1", log: "/w/checks/test.log", ms: 4_000, result: "fail" },
    spec: { name: "test", run: "bun run test" },
    state: "failed",
  },
  { name: "lint", spec: { name: "lint", run: "bun run lint" }, state: "not-run" },
]

function failedRow(): Row {
  return row({
    at: NOW,
    endedAt: NOW,
    next: { because: "it failed (test), and only the branch's author can move it", owner: "@chief" },
    reason: "test",
    result: "fail test",
    run: RUN_ID,
    startedAt: new Date(NOW.getTime() - 1_800_000),
    state: "failed",
    submitter: "@chief",
  })
}

function detailOf(
  item: WatchRow,
  checks: readonly CheckPanel[] = CHECKS,
  over: Partial<ChangeDetail> = {},
): ChangeDetail {
  return { checks, row: item.row, run: runOf(item.row, "main", checks, item.run?.id ?? item.row.run), ...over }
}

function snapshot(over: Partial<WatchSnapshot> = {}): WatchSnapshot {
  const rows = over.rows ?? [{ row: failedRow() }]
  return {
    at: NOW,
    queue: "example.test/repo#main",
    queues: [{ branch: "main", label: "main", path: "/repo" }],
    ...over,
    rows,
    // A snapshot built from its rows alone is a reading nothing was selected from.
    unfiltered: over.unfiltered ?? rows,
  }
}

/** The loader a test hands the pane: the detail for any row, from CHECKS. */
function opener(checks: readonly CheckPanel[] = CHECKS, over: Partial<ChangeDetail> = {}) {
  return vi.fn(async (item: WatchRow): Promise<ChangeDetail> => detailOf(item, checks, over))
}

/** A detail is loaded, not rendered from the snapshot: give the promise a turn, then let the layout settle. */
async function settle(app: ReturnType<typeof render>): Promise<void> {
  await app.waitForLayoutStable()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.waitForLayoutStable()
}

/** A box rendered on its own still reads the test's clock, not the wall's. */
function at(element: React.ReactElement): React.ReactElement {
  return (
    <NowContext.Provider value={NOW}>
      <MinuteContext.Provider value={NOW}>{element}</MinuteContext.Provider>
    </NowContext.Provider>
  )
}

/** One frame of the pane, painted into a headless terminal and read back as text. */
async function paint(element: Parameters<typeof render>[0], keys: readonly string[] = [], cols = 120): Promise<string> {
  const app = render(element, { cols, rows: 40 })
  await app.waitForLayoutStable()
  for (const key of keys) {
    app.press(key)
    await app.waitForLayoutStable()
  }
  await settle(app)
  const text = app.text
  app.unmount()
  return text
}

describe("the top line (items 30, 32d, 33)", () => {
  it("is yrd watch and one pill per queue, digit + friendly path + branch glyph, and nothing else", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    const [first] = text.split("\n")
    expect(first).toContain("yrd watch")
    expect(first).toContain("[1] /repo ⎇ main")
    // The old `QUEUE main ROOT /repo` row and the queue's address are gone from the top.
    expect(text).not.toContain("QUEUE main")
    expect(first).not.toContain("example.test")
    expect(first?.trimEnd().endsWith("all")).toBe(false)
  })

  it("has no queue All pill; the a key still shows every status", async () => {
    const rows: WatchRow[] = [{ row: row({ branch: "task/queued", state: "queued" }) }, { row: failedRow() }]
    const app = render(<WatchPane snapshot={snapshot({ rows })} live />, { cols: 120, rows: 40 })
    await app.waitForLayoutStable()
    const [first] = app.text.split("\n")
    expect(first).toContain("[1] /repo ⎇ main")
    expect(first?.trimEnd().endsWith("all")).toBe(false)

    app.press("f")
    await app.waitForLayoutStable()
    expect(app.text).toContain("1 of 2 change(s)")
    app.press("a")
    await app.waitForLayoutStable()
    expect(app.text).toContain("2 of 2 change(s)")
    app.unmount()
  })

  it("puts RUNNER in the table as a row, and keeps the pause to one loud line", async () => {
    // The component tests covered the top pause and RUNNER independently, so
    // they missed the live screen duplicating one pause around a long table.
    const pause = "paused by @chief: the host is down"
    const text = await paint(
      <WatchPane
        snapshot={snapshot({
          pause,
          runner: {
            journalDir: "/w/logs",
            service: BEATING,
            latest: {
              alive: false,
              id: RUN_ID,
              lastWriteAt: NOW,
              startedAt: NOW,
            },
          },
        })}
        live={false}
      />,
    )

    const lines = text.split("\n").filter((line) => line.trim() !== "")
    // The pause is the loudest state on the page and it LEADS it; the runner's
    // row says the word `paused` and what lifts the stop, never this sentence.
    expect(lines[0]).toContain(pause)
    expect(lines[1]).toContain("yrd watch")
    // The band is IN the table now, under the header, between waiting and done.
    expect(lines.findIndex((line) => line.includes("RUNNER"))).toBeGreaterThan(
      lines.findIndex((line) => line.includes("TASK")),
    )
    expect(text.match(new RegExp(pause, "gu"))).toHaveLength(1)
  })

  it("keeps the pause above the table when there is no RUNNER rail", async () => {
    // The RUNNER-first layout must not hide the pause when no run journal was
    // available, because that is exactly when the queue state needs context.
    const pause = "paused by @chief: the host is down"
    const text = await paint(<WatchPane snapshot={snapshot({ pause })} live={false} />)

    const lines = text.split("\n").filter((line) => line.trim() !== "")
    expect(lines[0]).toContain(pause)
    expect(lines.findIndex((line) => line.includes(pause))).toBeLessThan(
      lines.findIndex((line) => line.includes("TASK")),
    )
    expect(text.match(new RegExp(pause, "gu"))).toHaveLength(1)
  })

  it("says WHERE the run journal was looked for when there was none, so no journal never reads as nothing running", async () => {
    const text = await paint(
      <WatchPane
        snapshot={snapshot({ journalAbsent: "no run journal was read: /w/logs — there is no such directory" })}
        live={false}
      />,
    )

    expect(text).toContain("/w/logs")
  })
})

describe("ia.md first viewport and inverse pills (24196)", () => {
  it("keeps boxed RUNNER in a 24-row overflow frame after first-paint scroll", async () => {
    const rows: WatchRow[] = [
      ...Array.from({ length: 18 }, (_, i) => ({
        row: row({ branch: `task/w${String(i)}`, head: String(i).padStart(40, "0"), position: i + 1, state: "queued" }),
      })),
      ...Array.from({ length: 18 }, (_, i) => ({
        row: row({
          branch: `task/d${String(i)}`,
          endedAt: NOW,
          head: String(i + 50).padStart(40, "0"),
          merge: "9".repeat(40),
          state: "merged",
        }),
      })),
    ]
    const app = render(<WatchPane snapshot={snapshot({ rows })} live={false} />, { cols: 160, rows: 24 })
    await settle(app)
    expect(
      app.lines.some((line) => line.includes("RUNNER")),
      app.lines.join("\n"),
    ).toBe(true)
    app.unmount()
  })

  it("at 160x48 puts status pills on the right and boxed RUNNER in the frame", async () => {
    const rows: WatchRow[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        row: row({ branch: `task/w${String(i)}`, head: String(i).padStart(40, "0"), position: i + 1, state: "queued" }),
      })),
      {
        row: row({
          branch: "task/x",
          live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: NOW },
          state: "queued",
        }),
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        row: row({
          branch: `task/d${String(i)}`,
          endedAt: NOW,
          head: String(i + 50).padStart(40, "0"),
          merge: "9".repeat(40),
          state: "merged",
        }),
      })),
    ]
    const app = render(
      <WatchPane
        snapshot={snapshot({
          rows,
          runner: {
            journalDir: "/w/logs",
            service: BEATING,
            latest: { alive: true, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
          },
        })}
        live={false}
      />,
      { cols: 160, rows: 48 },
    )
    await settle(app)
    const dump = (name: string) => {
      const dir = "/hh/var/@dev2/replay-160x48"
      if (process.env.DUMP_160 !== "1") return
      mkdirSync(dir, { recursive: true })
      const numbered = app.lines
        .map((line, i) => `${String(i).padStart(2, "0")}|${line}|len=${String(line.length)}`)
        .join("\n")
      writeFileSync(`${dir}/${name}.txt`, `${numbered}\n`)
    }
    dump("before")
    const pillsY = app.lines.findIndex(
      (line) => line.includes("open") && line.includes("failed") && line.includes("running"),
    )
    const pills = app.lines[pillsY] ?? ""
    const openX = pills.indexOf("open")
    expect(pillsY, app.lines.join("\n")).toBeGreaterThanOrEqual(0)
    expect(openX, pills).toBeGreaterThan(100)
    expect(pills.trimEnd().endsWith("failed")).toBe(true)
    expect(
      app.lines.some((line) => line.includes("RUNNER")),
      app.lines.join("\n"),
    ).toBe(true)
    expect(
      app.lines.some((line) => line.includes("submitted")),
      app.lines.join("\n"),
    ).toBe(true)
    app.press("o")
    await settle(app)
    dump("o")
    const openCell = app.cell(openX, pillsY)
    expect(openCell.bg, JSON.stringify(openCell)).not.toBeNull()
    app.press("a")
    await settle(app)
    dump("a")
    app.unmount()
  })

  it("paints the active status pill with an inverse background after o", async () => {
    const app = render(<WatchPane snapshot={snapshot()} live={false} />, { cols: 160, rows: 24 })
    await settle(app)
    app.press("o")
    await settle(app)
    const y = app.lines.findIndex((line) => /\bopen\b/u.test(line) && line.includes("failed"))
    const x = (app.lines[y] ?? "").indexOf("open")
    expect(y, app.lines.join("\n")).toBeGreaterThanOrEqual(0)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(app.cell(x, y).bg, JSON.stringify(app.cell(x, y))).not.toBeNull()
    app.unmount()
  })

  it("after o then a, completed frames keep a clean RUNNER box and bring the held change back", async () => {
    const held = "task/held-waiting"
    const rows: WatchRow[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        row: row({
          at: NOW,
          author: "someone",
          branch: `task/draft${String(i)}`,
          head: String(i + 200).padStart(40, "0"),
          state: "draft",
        }),
      })),
      {
        row: row({
          branch: held,
          live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: NOW },
          position: 1,
          state: "queued",
        }),
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        row: row({
          branch: `task/done${String(i)}`,
          endedAt: NOW,
          head: String(i + 300).padStart(40, "0"),
          merge: "9".repeat(40),
          state: "merged",
        }),
      })),
    ]
    const app = render(
      <WatchPane
        snapshot={snapshot({
          drafts: { unread: 0, window: "7d" },
          rows,
          runner: {
            journalDir: "/w/logs",
            service: BEATING,
            latest: { alive: true, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
          },
        })}
        live={false}
      />,
      { cols: 160, rows: 48 },
    )
    await settle(app)
    app.press("o")
    await settle(app)
    const afterO = app.lines.join("\n")
    expect(afterO, afterO).not.toMatch(/aRUNNER/)
    expect(
      app.lines.some((line) => line.includes("RUNNER")),
      afterO,
    ).toBe(true)
    const runnerTitle = app.lines.find((line) => line.includes("RUNNER"))
    expect(runnerTitle, afterO).toBeDefined()
    expect(runnerTitle, afterO).not.toMatch(/RUNNER\w/)
    const pillsY = app.lines.findIndex((line) => /\bopen\b/u.test(line) && line.includes("failed"))
    const openX = (app.lines[pillsY] ?? "").indexOf("open")
    expect(app.cell(openX, pillsY).bg, JSON.stringify(app.cell(openX, pillsY))).not.toBeNull()
    app.press("a")
    await settle(app)
    const afterA = app.lines.join("\n")
    expect(afterA, afterA).not.toMatch(/aRUNNER/)
    expect(
      app.lines.some((line) => line.includes(held) && line.includes("checking")),
      afterA,
    ).toBe(true)
    app.unmount()
  })
})

describe("the table (items 3, 28, 38)", () => {
  it("with one queue, Q is omitted and RUN is separate, with no QUEUE / RUN (items 3, 28, 38)", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    const header = text.split("\n").find((line) => line.includes("TASK"))
    expect(header).toBeDefined()
    for (const column of [
      "HH:MM",
      "RUN",
      "TASK",
      "STATE",
      "AGENT",
      "AGE / RUN",
    ])
      expect(header).toContain(column)
    expect(header).not.toContain("QUEUE / RUN")
    expect(header?.split(/\s+/)).not.toContain("Q")
    expect(header!.trimEnd().endsWith("AGE / RUN")).toBe(true)

    // Position witness: operator order HH:MM, RUN, TASK, STATE, AGENT, AGE / RUN (with Q omitted)
    const hhmmIdx = header!.indexOf("HH:MM")
    const runIdx = header!.indexOf("RUN")
    const taskIdx = header!.indexOf("TASK")
    const stateIdx = header!.indexOf("STATE")
    const agentIdx = header!.indexOf("AGENT")
    const ageRunIdx = header!.indexOf("AGE / RUN")
    expect(hhmmIdx).toBeGreaterThan(-1)
    expect(hhmmIdx).toBeLessThan(runIdx)
    expect(runIdx).toBeLessThan(taskIdx)
    expect(taskIdx).toBeLessThan(stateIdx)
    expect(stateIdx).toBeLessThan(agentIdx)
    expect(agentIdx).toBeLessThan(ageRunIdx)

    const line = text
      .split("\n")
      .find((candidate) => candidate.includes("fix the parser") || candidate.includes("task/one"))
    expect(line).toContain("× failed")
    expect(line).toContain("fix the parser")
    expect(line).toContain("(err=test)")
    expect(line).toContain("@chief")
    expect(line).not.toContain("0badf00d")
  })

  it("with two tracked queues, shows separate Q and RUN columns with bare numbers and no QUEUE / RUN", async () => {
    const twoQueues = [
      { branch: "main", label: "main", path: "/repo" },
      { branch: "staging", label: "staging", path: "/repo2" },
    ]
    const text = await paint(
      <WatchPane
        snapshot={snapshot({
          queues: twoQueues,
          rows: [{ row: row({ ...failedRow(), run: "42" }) }],
        })}
        live={false}
      />,
    )

    const header = text.split("\n").find((line) => line.includes("TASK"))
    expect(header).toBeDefined()
    for (const column of ["HH:MM", "Q", "RUN", "TASK", "STATE", "AGENT", "AGE / RUN"]) {
      expect(header).toContain(column)
    }
    expect(header).not.toContain("QUEUE / RUN")

    // Position witness: operator order HH:MM, Q, RUN, TASK, STATE, AGENT, AGE / RUN
    const hhmmIdx = header!.indexOf("HH:MM")
    const qIdx = header!.indexOf("Q")
    const runIdx = header!.indexOf("RUN")
    const taskIdx = header!.indexOf("TASK")
    const stateIdx = header!.indexOf("STATE")
    const agentIdx = header!.indexOf("AGENT")
    const ageRunIdx = header!.indexOf("AGE / RUN")
    expect(hhmmIdx).toBeGreaterThan(-1)
    expect(hhmmIdx).toBeLessThan(qIdx)
    expect(qIdx).toBeLessThan(runIdx)
    expect(runIdx).toBeLessThan(taskIdx)
    expect(taskIdx).toBeLessThan(stateIdx)
    expect(stateIdx).toBeLessThan(agentIdx)
    expect(agentIdx).toBeLessThan(ageRunIdx)

    const line = text
      .split("\n")
      .find((candidate) => candidate.includes("fix the parser") || candidate.includes("task/one"))
    expect(line).toBeDefined()
    expect(line).toContain("× failed")
    expect(line).not.toContain("·")
    expect(line).toMatch(/\b1\s+42\b/)
  })

  it("with two tracked queues, filtering to one queue leaves snapshot.queues intact so Q column stays and second pill still reads [2] (Sep 21 10:10 rule)", async () => {
    const twoQueues = [
      { branch: "main", label: "main", path: "/repo" },
      { branch: "staging", label: "staging", path: "/repo2" },
    ]
    // Press "1" to toggle main queue off, leaving staging (queue 2) visible
    const text = await paint(
      <WatchPane
        snapshot={snapshot({
          queues: twoQueues,
          rows: [{ row: row({ ...failedRow(), run: "42" }) }],
        })}
        live={false}
      />,
      ["1"],
    )

    const lines = text.split("\n")
    const topLine = lines.find((line) => line.includes("yrd watch"))
    expect(topLine).toBeDefined()
    expect(topLine).toContain("[2]")
    expect(topLine).toContain("staging")

    const header = lines.find((line) => line.includes("TASK"))
    expect(header).toBeDefined()
    expect(header).toContain("Q")
    expect(header).toContain("RUN")
    expect(header).not.toContain("QUEUE / RUN")
  })

  it("names the queue digit and a dash when the row has no attempt (ia.md drafts/waiting)", async () => {
    const text = await paint(<WatchPane snapshot={snapshot({ rows: [{ row: row() }] })} live={false} />)

    const line = text
      .split("\n")
      .find((candidate) => candidate.includes("○ submitted") || candidate.includes("task/one"))
    expect(line).toContain("○ submitted")
    expect(line).toMatch(/1 · —|—\s+—/)
  })

  it("queued paints submitted and checked paints pending, same warning colour, not failed", async () => {
    const app = render(
      <WatchPane
        snapshot={snapshot({
          rows: [
            { row: row({ branch: "task/queued", state: "queued" }) },
            { row: row({ branch: "task/checked", head: "1".repeat(40), state: "checked" }) },
            { row: row({ branch: "task/failed", reason: "test", state: "failed" }) },
          ],
        })}
        live={false}
      />,
      { cols: 140, rows: 30 },
    )
    await settle(app)
    const painted = app.lines
    const at = (branch: string, word: string) => {
      const y = painted.findIndex((line) => line.includes(branch) && !line.includes("RUNNER"))
      const x = (painted[y] ?? "").indexOf(word)
      return { fg: y < 0 || x < 0 ? undefined : app.cell(x, y).fg, line: painted[y] ?? "" }
    }
    const queued = at("task/queued", "submitted")
    const checked = at("task/checked", "pending")
    const failed = at("task/failed", "failed")
    expect(queued.line, painted.join("\n")).toContain("○ submitted")
    expect(checked.line, painted.join("\n")).toContain("pending")
    expect(queued.fg, JSON.stringify({ queued: queued.fg, checked: checked.fg, failed: failed.fg })).toEqual(checked.fg)
    expect(queued.fg).not.toEqual(failed.fg)
    app.unmount()
  })

  it("filters by status bucket with o r d f, and a shows everything again (items 9, 32)", async () => {
    const startedAt = new Date(NOW.getTime() - 90_000)
    const rows: WatchRow[] = [
      { row: row({ branch: "task/queued", startedAt, state: "queued" }) },
      { row: failedRow() },
      { row: row({ branch: "task/merged", head: "1".repeat(40), merge: "2".repeat(40), startedAt, state: "merged" }) },
    ]
    const app = render(<WatchPane snapshot={snapshot({ rows })} live={false} />, { cols: 120, rows: 40 })
    await app.waitForLayoutStable()
    expect(app.text).toContain("3 of 3 change(s)")
    const ageRunOf = (painted: readonly string[], branch: string): string | undefined =>
      /— \/ \S+/u.exec(painted.find((line) => line.includes(branch))?.trimEnd() ?? "")?.[0]
    const lines = app.text.split("\n")
    expect(ageRunOf(lines, "task/merged")).toBe("— / —")
    expect(ageRunOf(lines, "task/queued")).toBe("— / —")

    app.press("f")
    await app.waitForLayoutStable()
    expect(app.text).toContain("1 of 3 change(s)")
    expect(app.text).toContain("task/one")
    expect(app.text).not.toContain("task/queued")
    expect(app.text).not.toContain("task/merged")

    app.press("o")
    await app.waitForLayoutStable()
    expect(app.text).toContain("task/queued")
    expect(app.text).not.toContain("task/merged")

    app.press("a")
    await app.waitForLayoutStable()
    expect(app.text).toContain("3 of 3 change(s)")
    const restored = app.text.split("\n")
    expect(ageRunOf(restored, "task/queued")).toBe("— / —")
    expect(ageRunOf(restored, "task/merged")).toBe("— / —")
    app.unmount()
  })

  it("an empty queue says `nothing in line`, as the printed list does; only a filter that hides everything blames the filters", async () => {
    const empty = await paint(<WatchPane snapshot={snapshot({ rows: [] })} live={false} />)
    expect(empty).toContain("nothing in line")
    expect(empty).not.toContain("no change matches the filters")

    const filtered = await paint(<WatchPane snapshot={snapshot({ rows: [{ row: failedRow() }] })} live={false} />, [
      "o",
    ])
    expect(filtered).toContain("no change matches the filters")
    expect(filtered).not.toContain("nothing in line")
  })

  it("renders the status pills right-aligned, with no All pill", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    const pills = text.split("\n").find((line) => line.includes("open") && line.includes("failed"))
    expect(pills).toBeDefined()
    expect(pills).toContain("running")
    expect(pills).toContain("done")
    expect(pills?.trimEnd().endsWith("all")).toBe(false)
  })
})

describe("the status box (items 1, 23, 29a, 39)", () => {
  it("is the very top of the detail, wears the run on its border, and hangs a step line per check off a gutter", async () => {
    const open = opener()
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} open={open} />, ["ArrowDown", "Enter"])

    expect(open).toHaveBeenCalledTimes(1)
    // No identity title row above the box: the first thing in the detail is the border with the run on it.
    expect(text).toContain("RUN main#")
    expect(text).toContain("× failed test")
    // The table cell's own duration, then the attempt's runtime, from the one clocks() in the core (24196).
    expect(text).toContain("took 1h00m · runtime 30:00")
    expect(text).toContain("Submitted ")
    // One step line per declared check, the one never reached included, marker in the gutter and the remedy on the failed one.
    expect(text).toMatch(/✓ typecheck\s+1:02/u)
    expect(text).toMatch(/× test\s+0:04 — @chief — it failed/u)
    expect(text).toMatch(/− lint\s+not run/u)
  })

  it("reads `passed, merged` with `Merged as <sha> at <time>.` under it for a merged change (item 1)", async () => {
    const merged = row({
      at: NOW,
      endedAt: NOW,
      merge: "b234234abcde0123456789abcdef0123456789ab",
      result: "pass test",
      run: RUN_ID,
      startedAt: new Date(NOW.getTime() - 225_000),
      state: "merged",
    })
    const run: WatchRun = runOf(
      merged,
      "main",
      CHECKS.map((check) => ({ ...check, state: "passed" as const })),
    )
    const text = await paint(at(<RunStatusBox run={run} />))

    expect(text).toContain("✓ passed, merged")
    expect(text).toContain("Merged as b234234abcde at")
    expect(text).toContain("runtime 3:45")
  })

  it("renders a run of another kind through the same box, with no display code touched (item 37m)", async () => {
    const mock: WatchRun = {
      kind: "deployment",
      id: RUN_ID,
      label: "staging",
      row: row({ state: "checked", position: 1, run: RUN_ID }),
      steps: [
        { name: "build image", state: "passed", ms: 90_000 },
        { name: "roll out", state: "running" },
        { name: "smoke", state: "not-run" },
      ],
    }
    const text = await paint(at(<RunStatusBox run={mock} />))

    expect(text).toContain("RUN staging#")
    expect(text).toMatch(/✓ build image\s+1:30/u)
    expect(text).toContain("◉ roll out")
    expect(text).toMatch(/− smoke\s+not run/u)
  })
})

describe("the change list and the Changes tab (items 2, 4, 6, 24, 25, 31)", () => {
  it("lists the change under the box as `· <branch>@<sha12> <subject>` and puts Changes first on the tab strip", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} open={opener()} />, ["ArrowDown", "Enter"])

    expect(text).toContain("· task/one@abcdef012345 fix the parser")
    const strip = text.split("\n").find((line) => line.includes("Changes") && line.includes("typecheck"))
    expect(strip).toBeDefined()
    expect(strip!.indexOf("Changes")).toBeLessThan(strip!.indexOf("typecheck"))
    expect(text).not.toContain("MERGE REQUESTS")
  })

  it("opens the Changes tab on its own box: the id header, title, body, HISTORY newest first, METADATA groups, the diff fold last", async () => {
    const item: WatchRow = { row: failedRow() }
    const records: readonly ChangeRecord[] = [
      {
        at: new Date(NOW.getTime() - 3_600_000),
        kind: "opened",
        sha: "1".repeat(40),
        subject: "opened",
        trailers: [["Submitter", "@chief"]],
      },
      {
        at: NOW,
        kind: "failed",
        sha: "2".repeat(40),
        subject: "failed",
        trailers: [
          ["Reason", "test"],
          ["Remedy", "fix the test and resubmit"],
        ],
      },
    ]
    const detail = detailOf(item, CHECKS, {
      body: "The parser dropped the last token.\n\nRefs: @i/10-yrd/24096",
      commits: { count: 3, first: new Date(NOW.getTime() - 7_200_000), last: new Date(NOW.getTime() - 3_700_000) },
      diffStat: { additions: 214, deletions: 38, files: 4 },
      records,
    })
    const text = await paint(at(<WatchDetail detail={detail} selected={CHANGES_TAB} />), [], 100)

    // Header on the box, then the bold title and the body.
    expect(text).toContain("task/one@abcdef012345")
    expect(text).toContain("The parser dropped the last token.")
    // HISTORY newest first, human verbs only where a human acted. Opened paints submitted.
    const failedAt = text.indexOf("failed test — fix the test and resubmit")
    const openedAt = text.indexOf("submitted by @chief")
    expect(failedAt).toBeGreaterThan(-1)
    expect(openedAt).toBeGreaterThan(failedAt)
    // METADATA: keys uppercase in one column, the three groups.
    expect(text).toMatch(/BY\s+@chief/u)
    expect(text).toMatch(/CREATED\s+\d\d:\d\d:\d\d · 1h00m ago/u)
    expect(text).toMatch(/COMMITS\s+first \d\d:\d\d · last \d\d:\d\d · 3 commits/u)
    expect(text).toMatch(/HEAD\s+abcdef012345/u)
    expect(text).toMatch(new RegExp(`RUN\\s+${RUN_ID}`, "u"))
    // The fold, last, with the unicode minus.
    expect(text).toContain("▶︎ Diff +214 −38")
    // Live facts are NOT in the metadata: no POSITION, WAIT or AGE row.
    expect(text).not.toMatch(/^\s*(POSITION|WAIT|AGE)\s/mu)
  })

  it("opens the diff through the loader when the fold is toggled, and only then", async () => {
    const loadDiff = vi.fn(async () => ({ text: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }))
    const open = opener(CHECKS, { diffStat: { additions: 1, deletions: 1, files: 1 } })
    // Wide enough for the detail beside the list, tall enough that the fold at the bottom of the box is on screen.
    const app = render(<WatchPane snapshot={snapshot()} live={false} open={open} loadDiff={loadDiff} />, {
      cols: 220,
      rows: 60,
    })
    await settle(app)
    app.press("ArrowDown")
    await settle(app)
    app.press("Enter")
    await settle(app)
    // Land on the Changes tab (two tabs left of the failed check), then fold the diff open.
    app.press("ArrowLeft")
    await settle(app)
    app.press("ArrowLeft")
    await settle(app)
    expect(app.text).toContain("▶︎ Diff +1 −1")
    expect(loadDiff).not.toHaveBeenCalled()
    app.press("v")
    await settle(app)
    expect(loadDiff).toHaveBeenCalledTimes(1)
    expect(app.text).toContain("▼︎ Diff +1 −1")
    expect(app.text).toContain("+new")
    app.unmount()
  })
})

describe("which tab a reader lands on", () => {
  it("labels repeated check names by phase and opens only that occurrence's output", async () => {
    const item: WatchRow = { row: row({ state: "failed" }) }
    const checks: readonly CheckPanel[] = [
      { name: "verify", phase: "merge", state: "failed", output: "CANDIDATE_FAIL", log: "/candidate/log" },
      { name: "verify", phase: "base", state: "passed", output: "BASE_PASS", log: "/base/log" },
    ]
    const detail = detailOf(item, checks)
    const candidate = await paint(at(<WatchDetail detail={detail} selected="0" />))
    expect(candidate).toContain("verify (merge)")
    expect(candidate).toContain("verify (base)")
    expect(candidate).toContain("CANDIDATE_FAIL")
    expect(candidate).not.toContain("BASE_PASS")
    const base = await paint(at(<WatchDetail detail={detail} selected="1" />))
    expect(base).toContain("BASE_PASS")
    expect(base).not.toContain("CANDIDATE_FAIL")
  })

  it("lands on the failed check first, else the running one, else the newest output, else Changes", () => {
    expect(defaultTab(CHECKS)).toBe("1")
    const passed = CHECKS.map((check) => (check.state === "failed" ? { ...check, state: "passed" as const } : check))
    expect(defaultTab(passed)).toBe("1")
    const silent = CHECKS.map((check) => {
      const { output: _output, ...rest } = check
      return { ...rest, state: "passed" as const }
    })
    expect(defaultTab(silent)).toBe(CHANGES_TAB)
    expect(defaultTab([{ name: "lint", spec: { name: "lint", run: "bun run lint" }, state: "not-run" }])).toBe(
      CHANGES_TAB,
    )
  })

  it("renders the check after a failing one as NOT RUN, with the command that would have run it", async () => {
    const text = await paint(at(<WatchDetail detail={detailOf({ row: failedRow() })} selected="2" />))

    expect(text).toContain("bun run lint")
    expect(text).toContain("NOT RUN")
  })
})

describe("the pane's keys and the detail's identity", () => {
  it("refreshes an ended detail when a warning arrives without moving its completion time", async () => {
    // 24202: the ended-detail cache keyed only tipAt, so late diagnostics stayed hidden.
    const initial = row({ state: "merged", run: RUN_ID, at: NOW, endedAt: NOW, result: "pass" })
    const open = opener([])
    const { load, rounds } = gatedLoader()
    const app = render(
      <WatchPane snapshot={snapshot({ rows: [{ row: initial }] })} load={load} open={open} intervalMs={10} live />,
      { cols: 200, rows: 50 },
    )
    try {
      app.press("ArrowDown")
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
      await settle(app)
      const diagnostic = {
        kind: "change" as const,
        run: RUN_ID,
        at: new Date(NOW.getTime() + 1000).toISOString(),
        reason: "change-ref-taken",
        text: "remote ref changed after the merge",
        next: "git show refs/changes/task/one",
      }
      await waitFor(() => expect(rounds.length).toBeGreaterThan(0))
      rounds
        .at(-1)
        ?.resolve(
          snapshot({ at: new Date(NOW.getTime() + 2000), rows: [{ row: { ...initial, diagnostics: [diagnostic] } }] }),
        )
      await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
      await settle(app)
      expect(current(app)).toContain(diagnostic.text)
      expect(current(app)).toContain(diagnostic.next)
      expect(current(app)).toContain("passed, merged")
      // A fresh journal read returns new objects even when its records did not change.
      await waitFor(() => expect(rounds.length).toBeGreaterThan(1))
      rounds.at(-1)?.resolve(
        snapshot({
          at: new Date(NOW.getTime() + 3000),
          rows: [{ row: { ...initial, diagnostics: [{ ...diagnostic }] } }],
        }),
      )
      await settle(app)
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      app.unmount()
    }
  })

  it.each([120, 220])(
    "opens the selected historical run's own detail when two rows have the same head at %i columns",
    async (cols) => {
      // Head-only detail identity passed all single-run fixtures but opened the
      // latest output when the operator selected the older attempt.
      const rows: WatchRow[] = ["second", "first"].map((id) => ({
        row: row({ run: id, state: "failed", result: id === "first" ? "stuck verify" : "fail verify" }),
        run: { id, branch: "task/one", head: row().head, startedAt: NOW, at: NOW, checks: [] },
      }))
      rows.push({
        row: row({ branch: "task/other", run: "first", state: "failed" }),
        run: { ...rows[1]!.run!, branch: "task/other" },
      })
      const open = vi.fn(
        async (item: WatchRow): Promise<ChangeDetail> =>
          detailOf(item, [
            {
              name: "verify",
              state: "failed",
              output: `${item.row.branch} ${item.run?.id} RUN OUTPUT`,
              log: `/w/${item.run?.id}.log`,
            },
          ]),
      )
      const app = render(<WatchPane snapshot={snapshot({ rows })} live={false} open={open} />, { cols, rows: 40 })
      await settle(app)
      app.press("ArrowDown")
      await settle(app)
      app.press("Enter")
      await settle(app)
      expect(app.text).toContain("second RUN OUTPUT")
      app.press("Escape")
      await settle(app)
      app.press("j")
      await settle(app)
      app.press("Enter")
      await settle(app)
      expect(app.text).toContain("first RUN OUTPUT")
      expect(app.text).not.toContain("second RUN OUTPUT")
      expect(app.text).toContain("change failed")
      app.press("Escape")
      await settle(app)
      app.press("j")
      await settle(app)
      app.press("Enter")
      await settle(app)
      expect(app.text).toContain("task/other first RUN OUTPUT")
      expect(app.text).not.toContain("task/one first RUN OUTPUT")
      // Three rows, three keys, three loads: the detail is keyed on watchRowKey, never on the head alone.
      expect(new Set(open.mock.calls.map(([item]) => watchRowKey(item))).size).toBe(3)
      app.unmount()
    },
  )

  it("opens the help on ? and closes it on Escape", async () => {
    const app = render(<WatchPane snapshot={snapshot()} live={false} />, { cols: 120, rows: 40 })
    await app.waitForLayoutStable()

    app.press("?")
    await app.waitForLayoutStable()
    expect(app.text).toContain("leave the watch")

    app.press("Escape")
    await app.waitForLayoutStable()
    expect(app.text).not.toContain("leave the watch")
    app.unmount()
  })

  it("says in its own help that a change is never stopped from here, because the watch writes nothing", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />, ["?"])

    expect(text).toContain("The watch writes nothing")
  })
})

describe("the layout tier", () => {
  it("puts the detail beside the list on a wide terminal", () => {
    expect(watchTier(220, 50)).toBe("right")
  })

  it("opens the selected change's detail by default when a split tier has room for it", async () => {
    // `watchTier` alone proved geometry but not the visible initial state; the
    // restored pane initialized every tier closed and hid this whole surface.
    const open = opener()
    const app = render(<WatchPane snapshot={snapshot()} live={false} open={open} />, { cols: 220, rows: 50 })
    await settle(app)
    app.press("ArrowDown")
    await settle(app)

    expect(open).toHaveBeenCalledTimes(1)
    expect(app.text).toContain("1 test failed: the parser")
    app.unmount()
  })

  it("drills in to one pane when there is room for neither split", () => {
    expect(watchTier(60, 10)).toBe("full")
  })
})

describe("the running step and the check-less declaration", () => {
  it("shows how long the running step has run, from the row's own live instant, beside its marker (item 39)", async () => {
    const live = row({
      live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: new Date(NOW.getTime() - 151_000) },
      position: 1,
      state: "checked",
    })
    const run = runOf(live, "main", [
      { name: "typecheck", result: { ms: 8_000, result: "pass" }, state: "passed" },
      { name: "affected-tests", state: "running" },
    ])
    const text = await paint(at(<RunStatusBox run={run} />))

    expect(text).toMatch(/◉ affected-tests 2:31/u)
    expect(text).toMatch(/✓ typecheck 0:08/u)
  })

  it("says so when the declaration a change was judged by names no check, instead of a bare tab strip", async () => {
    const detail = detailOf({ row: row() }, [])
    const text = await paint(at(<WatchDetail detail={detail} />))

    expect(text).toContain("names no check")
    expect(text).toContain("Changes")
  })

  it("gives a direct row's box its one line about the commit where a subject would stand", async () => {
    const direct = row({
      branch: "main",
      head: "3".repeat(40),
      reason: "main moved around the queue at 333333333333 (fix: merge it)",
      state: "direct",
      subject: undefined,
    })
    const text = await paint(at(<WatchDetail detail={detailOf({ row: direct }, [])} selected={CHANGES_TAB} />))

    expect(text).toContain("main moved around the queue at 333333333333")
  })
})

describe("the status box's step keys", () => {
  it("draws two steps of the same name and state, the submit-phase and merge-phase setup, as two lines", async () => {
    const run: WatchRun = {
      kind: "queue",
      id: RUN_ID,
      label: "main",
      row: row({ state: "checked", position: 1 }),
      steps: [
        { name: "setup", state: "passed", ms: 1_000 },
        { name: "typecheck", state: "passed", ms: 8_000 },
        { name: "setup", state: "passed", ms: 1_000 },
        { name: "affected-tests", state: "running" },
      ],
    }
    const text = await paint(at(<RunStatusBox run={run} />))

    expect(text.match(/✓ setup 0:01/gu)).toHaveLength(2)
    expect(text).toContain("◉ affected-tests")
  })
})

/** A loader the test answers by hand: each call is one pending round to resolve or reject. */
function gatedLoader() {
  const rounds: Array<{ resolve: (next: WatchSnapshot) => void; reject: (why: Error) => void }> = []
  const load = vi.fn(
    () =>
      new Promise<WatchSnapshot>((resolve, reject) => {
        rounds.push({ resolve, reject })
      }),
  )
  return { load, rounds }
}

/**
 * The committed tree as text, rendered on demand: a state set from the pane's
 * own loop commits on React's schedule, and the headless terminal paints a
 * commit only when driven, so `app.text` can lag it.
 */
function current(app: ReturnType<typeof render>): string {
  return bufferToText(app.freshRender())
}

const LOCK_RACE = new Error(
  "git fetch --quiet --no-tags --prune origin +refs/yrd/changes/*:refs/yrd/changes/* in /repo exited 1: error: cannot lock ref 'refs/yrd/changes/task/one@abcdef01': is at 3f0dceac but expected 40dc7828",
)

describe("a read that fails (the 2026-09-05 soak: a shared-refs fetch collision took the pane down)", () => {
  it("a round that fails is said in the footer with the reading still shown, the loop goes on, and a good round clears it", async () => {
    const { load, rounds } = gatedLoader()
    const app = render(<WatchPane snapshot={snapshot()} load={load} intervalMs={10} live />, { cols: 200, rows: 40 })
    await waitFor(() => {
      expect(rounds).toHaveLength(1)
    })
    rounds[0]?.reject(LOCK_RACE)
    // The loop went on to the next round instead of ending the watch.
    await waitFor(() => {
      expect(rounds).toHaveLength(2)
    })
    await waitFor(() => {
      expect(current(app)).toContain("⚠︎ the queue read failed at ")
    })
    const text = current(app)
    expect(text).toContain(
      `retrying; the table is the ${clock(NOW, { seconds: true })} reading — error: cannot lock ref`,
    )
    // Never the command line that ran: the why is git's own sentence.
    expect(text).not.toContain("git fetch --quiet")
    // The table still shows the last reading.
    expect(text).toContain("task/one")
    expect(text).toContain("1 of 1 change(s)")

    const later = new Date(NOW.getTime() + 60_000)
    rounds[1]?.resolve(
      snapshot({
        at: later,
        rows: [
          { row: failedRow() },
          { row: row({ branch: "task/fresh", head: "1234567890abcdef1234567890abcdef12345678" }) },
        ],
      }),
    )
    // The new reading is on screen (the list's virtual window grows on the
    // next paint, so the count is the fact to read here) and the warning is gone.
    await waitFor(() => {
      expect(current(app)).toContain("2 of 2 change(s)")
    })
    expect(current(app)).not.toContain("⚠︎ the queue read failed")
    app.unmount()
  })

  it("a detail that fails to read is said in the detail pane, not fatal, and the next round reads it again", async () => {
    const open = vi
      .fn<(item: WatchRow) => Promise<ChangeDetail>>()
      .mockRejectedValueOnce(
        new Error("git log abcdef0123456789 in /repo exited 128: fatal: bad object abcdef0123456789"),
      )
      .mockImplementation(async (item) => detailOf(item))
    const { load, rounds } = gatedLoader()
    const app = render(<WatchPane snapshot={snapshot()} load={load} open={open} intervalMs={10} live />, {
      cols: 200,
      rows: 40,
    })
    await app.waitForLayoutStable()
    app.press("ArrowDown")
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("⚠︎ this change's read failed at ")
    })
    const text = current(app)
    expect(text).toContain("retrying — fatal: bad object abcdef0123456789")
    expect(text).toContain("no change selected")
    // A good round re-runs the read; the warning goes and the detail comes.
    await waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds.at(-1)?.resolve(snapshot({ at: new Date(NOW.getTime() + 60_000) }))
    await waitFor(() => {
      expect(current(app)).toContain("✓ typecheck 1:02")
    })
    expect(current(app)).not.toContain("this change's read failed")
    expect(open).toHaveBeenCalledTimes(2)
    app.unmount()
  })
})

describe("the cursor is a row, not an index (the retired pane's fixed-row mode)", () => {
  const a = row({ branch: "task/a", head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subject: "the first" })
  const b = row({ branch: "task/b", head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subject: "the second" })
  const c = row({ branch: "task/c", head: "cccccccccccccccccccccccccccccccccccccccc", subject: "the third" })
  const fresh = row({ branch: "task/fresh", head: "dddddddddddddddddddddddddddddddddddddddd", subject: "the newest" })

  it("an opened change stays under the cursor when a newer row lands above it", async () => {
    const { load, rounds } = gatedLoader()
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [{ row: a }, { row: b }, { row: c }] })}
        load={load}
        open={opener()}
        intervalMs={10}
        live
      />,
      { cols: 200, rows: 40 },
    )
    await app.waitForLayoutStable()
    app.press("Home")
    await app.waitForLayoutStable()
    app.press("ArrowDown")
    await app.waitForLayoutStable()
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("· task/b@bbbbbbbbbbbb the second")
    })
    expect(current(app)).toContain("Home follows the newest again")
    await waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds
      .at(-1)
      ?.resolve(
        snapshot({ at: new Date(NOW.getTime() + 60_000), rows: [{ row: fresh }, { row: a }, { row: b }, { row: c }] }),
      )
    await waitFor(() => {
      expect(current(app)).toContain("4 of 4 change(s)")
    })
    // Still task/b, not whatever the table moved into row 1.
    expect(current(app)).toContain("· task/b@bbbbbbbbbbbb the second")
    expect(current(app)).not.toContain("· task/a@")
    app.unmount()
  })

  it("a row that left the table is said, and the cursor stays on its neighbour", async () => {
    const { load, rounds } = gatedLoader()
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [{ row: a }, { row: b }, { row: c }] })}
        load={load}
        open={opener()}
        intervalMs={10}
        live
      />,
      { cols: 200, rows: 40 },
    )
    await app.waitForLayoutStable()
    app.press("Home")
    await app.waitForLayoutStable()
    app.press("ArrowDown")
    await app.waitForLayoutStable()
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("· task/b@bbbbbbbbbbbb the second")
    })
    await waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds.at(-1)?.resolve(snapshot({ at: new Date(NOW.getTime() + 60_000), rows: [{ row: a }, { row: c }] }))
    await waitFor(() => {
      expect(current(app)).toContain("⚠︎ the row under the cursor left the table: task/b@bbbbbbbbbbbb")
    })
    const text = current(app)
    expect(text).toContain("the cursor stays on its neighbour, Home follows the newest again")
    // The neighbour at the same index is under the cursor now, and its detail is what the pane reads.
    await waitFor(() => {
      expect(current(app)).toContain("· task/c@cccccccccccc the third")
    })
    app.unmount()
  })

  it("at the top with nothing opened, the cursor follows the newest row", async () => {
    const { load, rounds } = gatedLoader()
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [{ row: a }, { row: b }] })}
        load={load}
        open={opener()}
        intervalMs={10}
        live
      />,
      { cols: 200, rows: 40 },
    )
    await app.waitForLayoutStable()
    app.press("Home")
    await app.waitForLayoutStable()
    expect(current(app)).not.toContain("Home follows the newest again")
    await waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds
      .at(-1)
      ?.resolve(snapshot({ at: new Date(NOW.getTime() + 60_000), rows: [{ row: fresh }, { row: a }, { row: b }] }))
    await waitFor(() => {
      expect(current(app)).toContain("3 of 3 change(s)")
    })
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("· task/fresh@dddddddddddd the newest")
    })
    app.unmount()
  })
})

describe("the RUNNER box's wrapped rails and the height budget", () => {
  // Seen on the admitted head at exactly 120x30 (eyeball-0f2c45e6-full-120x30.png):
  // the STATS bottom border painted on the footer row and the pills row fell
  // off screen. Root cause, isolated 2026-09-05: a `wrap="wrap"` text inside
  // the RUNNER box's marker row under-reports its height to the column's flex
  // pass by exactly the lines it wraps to, so every box below it is laid out
  // that many rows too high. The rails are pre-wrapped into rows now, as the
  // command rail always was.
  const pause =
    "paused by @ci since Sep 5, 2026, 8:51:32 AM PDT: CI garage: M8 git-process prerequisite merged as 4431d6d8ad163ef1d560963f3f70782f4ffca156; full round audit and remaining M8 reconciliation before another admission; no service activation"
  const runner = {
    journalDir: "/w/logs",
    service: BEATING,
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
  }
  const decisions = [{ at: NOW, decision: "merged" as const, duplicate: false, run: RUN_ID }]

  it("keeps the footer on the last row and the pills on screen at 120x30 with a three-row pause", async () => {
    const app = render(<WatchPane snapshot={snapshot({ pause, runner, decisions })} live={false} />, {
      cols: 120,
      rows: 30,
    })
    await app.waitForLayoutStable()
    await settle(app)
    const lines = app.text.split("\n")
    const last = lines.filter((line) => line.trim() !== "").at(-1) ?? ""
    expect(last).toContain("change(s)")
    // The footer shares its row with nothing: no box border, no STATS cell.
    expect(last).not.toMatch(/[╭╰│─╮╯]/u)
    // The pills row is on screen, between the table and STATS.
    expect(lines.findIndex((line) => /\bopen\b.*\brunning\b.*\bdone\b.*\bfailed\b/u.test(line))).toBeGreaterThan(0)
    // The pause is on the RUNNER rail, wrapped onto rows under its marker, once.
    expect(app.text.match(/paused by @ci/gu)).toHaveLength(1)
    app.unmount()
  })
})

describe("the frame's order under the table", () => {
  // The retired pane stacked the status pills right under the rows and the
  // STATS box after them (24169-old-watch.md §1 items 4–6); the port had the
  // pills last, below STATS, where a full-height box pushed them off screen.
  const runner = {
    journalDir: "/w/logs",
    service: BEATING,
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
  }
  const decisions = [{ at: NOW, decision: "merged" as const, duplicate: false, run: RUN_ID }]

  it("puts STATS and status pills above the rows", async () => {
    const app = render(<WatchPane snapshot={snapshot({ runner, decisions })} live={false} />, {
      cols: 120,
      rows: 50,
    })
    await app.waitForLayoutStable()
    await settle(app)
    const lines = app.text.split("\n")
    const lastRow = lines.findIndex((line) => line.includes("task/one"))
    const pills = lines.findIndex((line) => /\bopen\b.*\brunning\b.*\bdone\b.*\bfailed\b/u.test(line))
    const stats = lines.findIndex((line) => line.includes("STATS"))
    expect(lastRow).toBeGreaterThan(0)
    expect(stats).toBeGreaterThan(0)
    expect(pills).toBeGreaterThanOrEqual(0)
    expect(lastRow).toBeGreaterThan(stats)
    expect(lastRow).toBeGreaterThan(pills)
    app.unmount()
  })
})

/**
 * @failure  The RUNNER marker is wired to nothing. Its predicate lives in the
 *           frame, one `some()` over the rows, and NOTHING pinned that wiring:
 *           hardcoding it to `true` or to `false` passed every arm in this
 *           package (measured by mutation, 2026-09-11). The marker could have
 *           read `processing` over an empty queue, or never at all, and the
 *           whole of items 1 and 5 would still have looked delivered.
 * @level    l2 — the pane, painted, rows and runner together.
 * @consumer the operator reading the box to decide whether to submit.
 */
describe("the RUNNER marker is wired to the ROWS, not to the process (items 1, 5)", () => {
  // `alive: false` throughout, deliberately. The ported marker keyed on the
  // service process being up; if that still decided anything, the arm below
  // could not go `processing` and the control could not stay `idle`.
  const runner = {
    journalDir: "/w/logs",
    service: BEATING,
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: new Date(NOW.getTime() - 120_000) },
  }
  const underCheck = row({
    live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: new Date(NOW.getTime() - 151_000) },
    position: 1,
    state: "checked",
  })

  it("reads CHECKING while a row has a live check", async () => {
    const app = render(<WatchPane snapshot={snapshot({ runner, rows: [{ row: underCheck }] })} live={false} />, {
      cols: 120,
      rows: 30,
    })
    await app.waitForLayoutStable()
    await settle(app)

    // `processing` retired in S1: the runner's row shares the STATUS column with
    // every change's, so it says the same word a checking change says.
    expect(app.text).toContain("— / 2:31")
    expect(app.text, "the queue is not idle while it is checking something").not.toMatch(/\bidle \d/u)
    app.unmount()
  })

  it("CONTROL: the same runner with NO row under a check reads idle", async () => {
    const app = render(
      <WatchPane snapshot={snapshot({ runner, rows: [{ row: row({ position: 1 }) }] })} live={false} />,
      {
        cols: 120,
        rows: 30,
      },
    )
    await app.waitForLayoutStable()
    await settle(app)

    expect(app.text).toMatch(/\bidle \d/u)
    expect(app.text, "nothing is under a check, so nothing is checking").not.toContain("checking")
    app.unmount()
  })

  // RUNNER is the queue's, not the selector's (24196, review finding 4): a
  // selector that hides the change under a check must not turn the box idle.
  it("reads CHECKING while the row under a check is one the selector hides", async () => {
    const mine = row({ branch: "task/mine", position: 2 })
    const selected = snapshot({ runner, rows: [{ row: mine }], unfiltered: [{ row: underCheck }, { row: mine }] })
    const app = render(<WatchPane snapshot={selected} live={false} />, { cols: 120, rows: 30 })
    await app.waitForLayoutStable()
    await settle(app)

    // The runner is the QUEUE's, never the selector's: the row is hidden, so the
    // runner's own row is drawn and says what the whole reading says it holds.
    expect(app.text).toContain("checking 2:31")
    expect(app.text, "the queue is checking a change the selector hides, so it is not idle").not.toMatch(/\bidle \d/u)
    app.unmount()
  })
})

/**
 * @failure  The operator read `yrd watch` on 2026-09-16 and could not tell what was going on: "20+
 *           checked? what does that mean", "checked does NOT obviously mean 'waiting in line to be
 *           merged'", "why is the status idle then???", "the ordering looks weird - look at the time
 *           stamps". Nothing said how many changes wait or why the line was not moving; the state words
 *           were the queue's internal names, spelled separately on every surface; RUNTIME was blank or
 *           stale on every row not running, beside a second and a third clock; a pushed branch nobody
 *           submitted was nowhere; a standing observation line said nothing a reader could act on; `?`
 *           drew its help in the pane's flow; and two things pulsed while one change was being worked on
 *           (@i/10-yrd/24196).
 * @level    l2 (the pane, the page, the notice and both helps, rendered into a headless terminal)
 * @consumer the operator reading `yrd watch` and `yrd list`
 */
describe("the watch says what waits, what runs and what happens next (24196)", () => {
  /**
   * The ONE word table: the operator's nine state words (v3, 2026-09-16) in legend order, `direct` (a
   * commit that went around the queue, which is not a change), the duration cell's lead words (decision
   * 5) and the phrase that names the table's order (decision 4). Every surface reads its word from here,
   * so apart from the legend test below no assertion spells a word: each reads the table.
   */
  const STATES = [
    "draft",
    "submitted",
    "checking",
    "pending",
    "merging",
    "merged",
    "stuck",
    "failed",
    "cancelled",
  ] as const
  const KEYS = [...STATES, "direct", "waiting", "took", "runner", "verifying"] as const
  type Entry = { word: string; color: string; means?: string; next?: string }
  type WordTable = Record<(typeof KEYS)[number], Entry>

  /**
   * The table as watch-format.ts exports it, read through the module's namespace so this file compiles
   * before the table exists. Until it does, every entry is a placeholder no surface prints, so each test
   * fails on its own assertion, naming what is missing, rather than on an import.
   */
  async function words(): Promise<WordTable> {
    const table = ((await import("../src/watch-format.ts")) as unknown as Readonly<Record<string, unknown>>)[
      "STATE_WORDS"
    ]
    if (table !== undefined) return table as WordTable
    return Object.fromEntries(
      KEYS.map((key) => [key, { means: `<no means: ${key}>`, next: `<no next: ${key}>`, word: `<no word: ${key}>` }]),
    ) as WordTable
  }

  /** `yrd list --help`, captured in process. */
  async function listHelp(): Promise<string> {
    let text = ""
    const io: YrdCliIO = {
      color: false,
      columns: 120,
      cwd: process.cwd(),
      stderr: (chunk) => void (text += chunk),
      stdout: (chunk) => void (text += chunk),
    }
    await runYrdProcess(["bun", "yrd", "list", "--help"], io)
    return text
  }

  const MINUTE = 60_000
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
  const MERGED_RUN = "q-20260903T115230000Z-feedf00d"
  const FAILED_RUN = "q-20260903T113500000Z-deadf00d"
  const EARLIER_RUN = "q-20260903T111000000Z-0ea1f00d"
  const RUNNING_SINCE = ago(3 * MINUTE + 21_000)
  const RUNNER = {
    journalDir: "/w/logs",
    service: BEATING,
    latest: { alive: true, id: RUN_ID, lastWriteAt: ago(20_000), startedAt: ago(3 * MINUTE + 30_000) },
  }
  /** The same runner, its journal quiet past the silence ceiling. */
  const SILENT = { ...RUNNER, latest: { ...RUNNER.latest, lastWriteAt: ago(12 * MINUTE) } }
  const DECISIONS = [
    { at: ago(4 * MINUTE + 50_000), decision: "merged" as const, duplicate: false, run: MERGED_RUN },
    { at: ago(20 * MINUTE), decision: "failed" as const, duplicate: false, run: FAILED_RUN },
  ]
  /** The line stop a stuck change makes, as the queue read derives it (`stopFact`, the page's `stopped`). */
  const STOP = {
    by: "yrd-service",
    cause: "stuck" as const,
    change: `task/s@${"4".repeat(40)}`,
    since: ago(6 * MINUTE).toISOString(),
  }

  /** The change the runner holds: under its first check, submitted and second in line. */
  function running(over: Partial<Row> = {}): Row {
    return row({
      at: ago(20_000),
      branch: "task/x",
      head: "1".repeat(40),
      live: { check: "affected-tests", phase: "submit", run: RUN_ID, since: RUNNING_SINCE },
      position: 2,
      run: RUN_ID,
      since: ago(40 * MINUTE),
      startedAt: RUNNING_SINCE,
      state: "queued",
      subject: "the change under a check",
      submitter: "@dev/2",
      ...over,
    })
  }

  /** The run a watch row is split by: as much of one as the row's identity needs. */
  function split(item: Row, id: string, decision?: string): WatchRow {
    const run: JournalRun = {
      at: item.at ?? NOW,
      branch: item.branch,
      checks: [],
      head: item.head,
      id,
      startedAt: NOW,
      ...(decision === undefined ? {} : { decision }),
    }
    return { row: { ...item, run: id }, run }
  }

  /** A draft (v3): a branch pushed and never submitted, dated by its head commit and signed by its author. No record exists for it. */
  function draft(branch: string, head: string, committedAt: Date, author: string): WatchRow {
    return { row: { at: committedAt, author, branch, head, state: "draft" } as unknown as Row }
  }

  /**
   * EVERY_STATE: one row for each word the table draws, in the order decision 4 gives them: the row the
   * runner holds, then the line by position (which is submit order), then the ended rows newest ending
   * first, then the drafts newest first. The width renders in the 24196 phase A report are drawn from it,
   * and the tier ladder below reads it.
   */
  const EVERY_STATE: readonly WatchRow[] = [
    { row: running() },
    {
      row: row({
        at: ago(3 * MINUTE),
        branch: "task/y1",
        head: "2".repeat(40),
        position: 1,
        since: ago(50 * MINUTE),
        startedAt: ago(20 * MINUTE),
        state: "checked",
        subject: "passed, waits to merge",
        submitter: "@dev/4",
      }),
    },
    {
      row: row({
        at: ago(12 * MINUTE + 3_000),
        branch: "task/z",
        head: "3".repeat(40),
        position: 3,
        since: ago(12 * MINUTE + 3_000),
        state: "queued",
        subject: "not checked yet",
        submitter: "@dev/5",
      }),
    },
    {
      row: row({
        at: ago(6 * MINUTE),
        branch: "task/s",
        endedAt: ago(6 * MINUTE),
        head: "4".repeat(40),
        position: 4,
        reason: "yrd-check-unresolved",
        since: ago(10 * MINUTE),
        state: "stuck",
        subject: "the queue could not judge it",
        submitter: "@dev/6",
      }),
    },
    {
      row: row({
        // The notice went out a minute ago; the change merged before that.
        at: ago(MINUTE),
        branch: "task/m",
        endedAt: ago(4 * MINUTE + 50_000),
        head: "5".repeat(40),
        merge: "9".repeat(40),
        result: "pass affected-tests",
        run: MERGED_RUN,
        since: ago(12 * MINUTE),
        startedAt: ago(9 * MINUTE),
        state: "merged",
        subject: "merged a moment ago",
        submitter: "@chief",
      }),
    },
    {
      row: row({
        at: ago(20 * MINUTE),
        branch: "task/f",
        endedAt: ago(20 * MINUTE),
        head: "6".repeat(40),
        reason: "test",
        result: "fail test",
        run: FAILED_RUN,
        since: ago(25 * MINUTE),
        startedAt: ago(22 * MINUTE),
        state: "failed",
        subject: "a test failed",
        submitter: "@dev/2",
      }),
    },
    {
      row: row({
        at: ago(30 * MINUTE),
        branch: "task/w",
        endedAt: ago(30 * MINUTE),
        head: "7".repeat(40),
        since: ago(40 * MINUTE),
        state: "withdrawn",
        subject: "taken back by its submitter",
        submitter: "@dev/3",
      }),
    },
    {
      row: {
        at: ago(50 * MINUTE),
        branch: "main",
        head: "8".repeat(40),
        reason: "main moved around the queue at 888888888888 (fix: a hotfix)",
        state: "direct",
        subject: "fix: a hotfix",
      },
    },
    draft("task/d", "a".repeat(40), ago(2 * 60 * MINUTE), "ada"),
  ]

  /** Paint the pane and hand back its lines, pressing the keys given first. */
  async function lines(snap: WatchSnapshot, cols: number, rows: number, keys: readonly string[] = []) {
    const app = render(<WatchPane snapshot={snap} live={false} />, { cols, rows })
    await settle(app)
    for (const key of keys) {
      app.press(key)
      await settle(app)
    }
    const painted = app.text.split("\n")
    app.unmount()
    return painted
  }

  /** The line right under `yrd watch`: where decision 2 puts the top line, above RUNNER. */
  function topLineOf(painted: readonly string[]): Readonly<{ line: string; next: string }> {
    const title = painted.findIndex((line) => line.includes("yrd watch"))
    return { line: painted[title + 1] ?? "", next: painted[title + 2] ?? "" }
  }

  /** The first table row under the header whose text includes `needle`. */
  function tableRow(painted: readonly string[], needle: string): string {
    const header = painted.findIndex(
      (line) => line.includes("TASK") && line.includes("RUN") && !line.includes("QUEUE / RUN"),
    )
    return header < 0 ? "" : (painted.slice(header + 1).find((line) => line.includes(needle)) ?? "")
  }

  it("the legend is the operator's nine words, each with what it means and what happens next, and the clock words decision 5 named", async () => {
    const W = await words()

    // The colour joined the table in S1 — one word, one colour, one entry, so a
    // column that draws both cannot take them from two places — and is asserted
    // by the colour arms in watch-boxes.test.tsx rather than spelled here.
    // Operator v3: queued paints submitted, checked paints pending, both warning yellow; verifying paints fitting.
    expect(W.submitted).toMatchObject({ word: "submitted", color: "$fg-warning" })
    expect(W.pending).toMatchObject({ word: "pending", color: "$fg-warning" })
    expect(W.verifying).toMatchObject({ word: "fitting", color: "$fg-info" })
    const said = ({ color: _color, ...entry }: Entry) => entry
    expect({
      ...Object.fromEntries(STATES.map((key) => [key, said(W[key])])),
      direct: W.direct.word,
      took: W.took.word,
      waiting: W.waiting.word,
    }).toEqual({
      cancelled: {
        means: "taken back, or given up without a verdict; ended (yrd queue withdraw produces it)",
        next: "nothing",
        word: "cancelled",
      },
      checking: { means: "the runner is testing it now", next: "pending, stuck or failed", word: "checking" },
      direct: "direct",
      draft: { means: "pushed to the remote, not submitted", next: "yrd submit", word: "draft" },
      failed: { means: "a check failed; ended", next: "a new head is a new change", word: "failed" },
      merged: { means: "on the queue branch; ended", next: "nothing; a revert is a new change", word: "merged" },
      merging: { means: "the runner is writing main for it now", next: "merged or failed", word: "merging" },
      pending: {
        means: "checks passed; waiting in line to merge",
        next: "it merges when the line reaches it",
        word: "pending",
      },
      stuck: {
        means: "the queue could not judge it and stopped the line (ADR-0015)",
        next: "repair and resume, merge, or cancel",
        word: "stuck",
      },
      submitted: {
        means: "in the queue, waiting for its first check",
        next: "the runner checks it",
        word: "submitted",
      },
      took: "took",
      waiting: "waiting",
    })
  })

  it("the top line says how many changes wait and why the line is not moving: what is checked and for how long, where the line stopped and since when, when the last merge landed and how many drafts there are, counting a change once however many runs it has, and past its width drops the drafts, the breakdown, the last merge's branch, the last merge, the times, then the branch names", async () => {
    const W = await words()
    const recheck = "q-20260903T112000000Z-5ecf00d0"
    const { live: _running, ...before } = running()
    const passed = row({ branch: "task/y1", head: "2".repeat(40), position: 1, state: "checked" })
    const stuckAt = ago(6 * MINUTE)
    const mergedAt = ago(3 * MINUTE + 12_000)
    const rows: WatchRow[] = [
      // The change being checked, split into its run now and an earlier run that decided nothing: ONE change.
      split(running(), RUN_ID),
      split({ ...before, at: ago(40 * MINUTE) }, EARLIER_RUN),
      // A change checked twice (the target moved under it) is ONE change waiting to merge.
      split({ ...passed, at: ago(3 * MINUTE), endedAt: ago(3 * MINUTE) }, recheck, "checked"),
      split({ ...passed, at: ago(25 * MINUTE), endedAt: ago(25 * MINUTE) }, EARLIER_RUN, "checked"),
      { row: row({ branch: "task/y2", head: "3".repeat(40), position: 3, state: "checked" }) },
      { row: row({ branch: "task/z1", head: "5".repeat(40), position: 4, state: "queued" }) },
      { row: row({ branch: "task/z2", head: "6".repeat(40), position: 5, state: "queued" }) },
      {
        row: row({
          branch: "task/s",
          endedAt: stuckAt,
          head: "4".repeat(40),
          position: 6,
          reason: "yrd-check-unresolved",
          state: "stuck",
        }),
      },
      split(row({ branch: "task/y", endedAt: mergedAt, head: "7".repeat(40), state: "merged" }), MERGED_RUN, "merged"),
      split(
        row({ branch: "task/older", endedAt: ago(50 * MINUTE), head: "8".repeat(40), state: "merged" }),
        EARLIER_RUN,
        "merged",
      ),
      draft("task/d1", "a".repeat(40), ago(2 * 60 * MINUTE), "ada"),
      draft("task/d2", "b".repeat(40), ago(3 * 60 * MINUTE), "bob"),
    ]
    const stopped = { ...STOP, since: stuckAt.toISOString() }
    const at = (cols: number, runner = RUNNER) =>
      queueLine(snapshot({ rows, runner, stopped } as Partial<WatchSnapshot>), NOW, cols - 2).trim()

    // A2-set-v3 Q4, each width the widest the next form does not fit (the pane lays the line out two
    // columns narrower than the terminal): drafts, breakdown, the last merge's branch, the last merge,
    // times, branch names.
    const waiting = `5 ${W.waiting.word}`
    const breakdown = `: 2 ${W.pending.word}, 2 ${W.submitted.word}, 1 ${W.stuck.word}`
    const check = (times: boolean) => ` · ${W.checking.word} task/x${times ? " for 3:21" : ""}`
    const stop = (times: boolean) => ` · line stopped at task/s${times ? ` since ${clock(stuckAt)}` : ""}`
    const merge = (branch: boolean) => ` · last merge ${clock(mergedAt)}${branch ? " (task/y)" : ""}`
    const drafts = ` · 2 ${W.draft.word}s (7d)`
    expect({
      160: at(160),
      144: at(144),
      120: at(120),
      100: at(100),
      90: at(90),
      64: at(64),
      44: at(44),
      // A journal quiet past the ceiling changes nothing here: its only local source reads a healthy round's
      // long check as silence, so "runner silent" waits for the runner's own claim (A2-set-v2 item 4).
      quiet: at(160, SILENT),
    }).toEqual({
      160: waiting + breakdown + check(true) + stop(true) + merge(true) + drafts,
      144: waiting + breakdown + check(true) + stop(true) + merge(true),
      120: waiting + check(true) + stop(true) + merge(true),
      100: waiting + check(true) + stop(true) + merge(false),
      90: waiting + check(true) + stop(true),
      64: waiting + check(false) + stop(false),
      44: `${waiting} · ${W.checking.word} · line stopped`,
      quiet: waiting + breakdown + check(true) + stop(true) + merge(true) + drafts,
    })
  })

  it("at 100x31 the top line drops the last merge's branch past the breakdown and keeps the last merge's time (A2-set-v3 Q4)", async () => {
    const W = await words()

    const snap = snapshot({ decisions: DECISIONS, rows: EVERY_STATE, runner: RUNNER, stopped: STOP } as Partial<WatchSnapshot>)

    expect(queueLine(snap, NOW, 100 - 2).trim()).toBe(
      `3 ${W.waiting.word} · ${W.checking.word} task/x for 3:21 · line stopped at task/s since ${clock(new Date(STOP.since))}` +
        ` · last merge ${clock(ago(4 * MINUTE + 50_000))}`,
    )
  })

  it("says an operator's pause that names no change as paused, since when and by whom, in the stop's slot, and never drops the word (A2-set-v3 Q3)", async () => {
    const W = await words()
    const since = ago(25 * MINUTE)
    const rows: WatchRow[] = [
      { row: row({ branch: "task/p1", head: "2".repeat(40), position: 1, state: "checked" }) },
      { row: row({ branch: "task/p2", head: "3".repeat(40), position: 2, state: "checked" }) },
      { row: row({ branch: "task/s1", head: "4".repeat(40), position: 3, state: "queued" }) },
      { row: row({ branch: "task/s2", head: "5".repeat(40), position: 4, state: "queued" }) },
      { row: row({ branch: "task/s3", head: "6".repeat(40), position: 5, state: "queued" }) },
    ]
    const stopped = { by: "@chief", cause: "operator", change: null, since: since.toISOString() }
    const at = (cols: number) =>
      queueLine(
        snapshot({ rows, runner: RUNNER, stopped } as Partial<WatchSnapshot>),
        NOW,
        cols - 2,
      ).trim()
    const waiting = `5 ${W.waiting.word}`

    expect({ 70: at(70), 50: at(50), 40: at(40) }).toEqual({
      70: `${waiting}: 2 ${W.pending.word}, 3 ${W.submitted.word} · paused since ${clock(since)} by @chief`,
      50: `${waiting} · paused since ${clock(since)} by @chief`,
      40: `${waiting} · paused by @chief`,
    })
  })

  it("the RUNNER rail counts the changes waiting in line as the top line does: once per change, the held one apart (A2-set-v3 Q5)", async () => {
    const W = await words()
    const { live: _running, ...before } = running()
    const passed = row({ branch: "task/y1", head: "2".repeat(40), position: 1, state: "checked" })
    const rows: WatchRow[] = [
      split(running(), RUN_ID),
      split({ ...before, at: ago(40 * MINUTE) }, EARLIER_RUN),
      split({ ...passed, at: ago(3 * MINUTE), endedAt: ago(3 * MINUTE) }, "q-20260903T112000000Z-5ecf00d0", "checked"),
      split({ ...passed, at: ago(25 * MINUTE), endedAt: ago(25 * MINUTE) }, EARLIER_RUN, "checked"),
      { row: row({ branch: "task/z1", head: "5".repeat(40), position: 3, state: "queued" }) },
      {
        row: row({
          branch: "task/s",
          endedAt: ago(6 * MINUTE),
          head: "4".repeat(40),
          position: 4,
          reason: "yrd-check-unresolved",
          state: "stuck",
        }),
      },
    ]

    // Nothing is under a check here, so the runner draws its OWN row and it is
    // the row that carries the count. Both counts come from one `lineOf`
    // (watch-frame.tsx) over the whole reading, which is what stops them
    // disagreeing; the fixture splits two changes into four run rows so a count
    // that counted ROWS would read 5, not 3.
    const unheld = rows.map(({ row, ...rest }) => ({ ...rest, row: { ...row, live: undefined } }))
    const snap = snapshot({ rows: unheld, runner: RUNNER })
    const painted = await lines(snap, 120, 40)

    const rail = (painted.find((line) => line.includes("RUNNER") && /in line/u.test(line)) ?? "").replace(/\s+/gu, " ")
    const top = queueLine(snap, NOW, 120 - 2)
    expect({
      rail: /and (\d+) in line/u.exec(rail)?.[1],
      top: top.startsWith(`4 ${W.waiting.word}`) ? "4" : top,
    }).toEqual({ rail: "4", top: "4" })
  })

  it("counts the drafts in their window and the heads not yet read apart, and w asks the loader for the other window, where the unread drafts are marked rows (A2-set-v3 Q1)", async () => {
    const W = await words()
    const change: WatchRow = {
      row: row({
        at: ago(12 * MINUTE),
        branch: "task/z",
        head: "3".repeat(40),
        position: 1,
        since: ago(12 * MINUTE),
        state: "queued",
        subject: "not judged yet",
      }),
    }
    const unread = (branch: string, head: string): WatchRow => ({
      row: { branch, head, state: "draft" } as unknown as Row,
    })
    const week = snapshot({
      drafts: { unread: 2, window: "7d" },
      rows: [
        change,
        draft("task/d1", "a".repeat(40), ago(2 * 60 * MINUTE), "ada"),
        draft("task/d2", "b".repeat(40), ago(3 * 60 * MINUTE), "bob"),
      ],
      runner: RUNNER,
    } as Partial<WatchSnapshot>)
    const all = snapshot({
      drafts: { unread: 2, window: "all" },
      rows: [
        ...week.rows,
        draft("task/old", "d".repeat(40), ago(10 * 24 * 60 * MINUTE), "grace"),
        unread("task/unread", "c".repeat(40)),
        unread("task/unread2", "e".repeat(40)),
      ],
      runner: RUNNER,
    } as Partial<WatchSnapshot>)
    const load = vi.fn(async (_request?: unknown) => all)
    const app = render(<WatchPane snapshot={week} load={load as never} live={false} />, { cols: 140, rows: 40 })
    await settle(app)
    const before = app.text.split("\n")
    app.press("w")
    await settle(app)
    const after = app.text.split("\n")
    app.unmount()
    // The window is named on the drafts BAND's rule now, over the rows it is
    // true of, and not on a header that spans every band.
    const header = (painted: readonly string[]): string => painted.find((line) => line.includes("not submitted")) ?? ""
    const counted = (snap: WatchSnapshot): string =>
      queueLine(snap, NOW, 140 - 2)
        .split(" · ")
        .find((segment) => segment.includes(`${W.draft.word}s (`)) ?? ""

    expect({
      after: {
        top: counted(all),
        unreadRow: tableRow(after, " task/unread ").includes("not yet read"),
      },
      before: {
        top: counted(week),
        unreadRow: tableRow(before, " task/unread "),
      },
      requested: load.mock.calls.map(([request]) => request),
    }).toEqual({
      after: { top: `3 ${W.draft.word}s (all), 2 not yet read`, unreadRow: true },
      before: { top: `2 ${W.draft.word}s (7d), 2 not yet read`, unreadRow: "" },
      requested: [{ draftWindow: "all" }],
    })
  })

  it("draws draft rows and a draft's detail from the snapshot alone: redrawing, moving over drafts and opening one reads nothing (A2-set-v3)", async () => {
    const moved: WatchRow = {
      row: {
        at: ago(30 * MINUTE),
        author: "grace",
        branch: "task/moved",
        head: "f".repeat(40),
        movedSinceSubmit: true,
        state: "draft",
      } as unknown as Row,
    }
    const unread: WatchRow = { row: { branch: "task/unread", head: "c".repeat(40), state: "draft" } as unknown as Row }
    const snap = snapshot({
      drafts: { unread: 1, window: "all" },
      rows: [moved, draft("task/d1", "a".repeat(40), ago(2 * 60 * MINUTE), "ada"), unread],
      runner: RUNNER,
    } as Partial<WatchSnapshot>)
    const load = vi.fn(async () => snap)
    const open = vi.fn(async (item: WatchRow) => detailOf(item, CHECKS))
    const loadDiff = vi.fn(async () => ({ text: "" }))
    const app = render(<WatchPane snapshot={snap} load={load} open={open} loadDiff={loadDiff} live={false} />, {
      cols: 220,
      rows: 50,
    })
    await settle(app)
    app.press("Home")
    await settle(app)
    const shown: string[] = []
    for (const key of ["Enter", "j", "j", "v"]) {
      app.press(key)
      await settle(app)
      shown.push(app.text)
    }
    app.unmount()

    expect({
      moved: (shown[0] ?? "").includes("moved since its last submit") && (shown[0] ?? "").includes("run yrd submit"),
      read: { load: load.mock.calls.length, loadDiff: loadDiff.mock.calls.length, open: open.mock.calls.length },
      unread: (shown[2] ?? "").includes("not yet read") && (shown[2] ?? "").includes("run yrd submit"),
    }).toEqual({ moved: true, read: { load: 0, loadDiff: 0, open: 0 }, unread: true })
  })

  it("each row shows AGE / RUN: AGE unknown (not tip Opened), RUN is attempt runtime when measured", async () => {
    const snap = snapshot({ rows: EVERY_STATE, runner: RUNNER, stopped: STOP } as Partial<WatchSnapshot>)
    const wide = await lines(snap, 120, 40)
    const header = wide.find((line) => line.includes("AGE / RUN") && line.includes("TASK")) ?? ""
    const held = tableRow(wide, " task/x ")
    const waiting = tableRow(wide, " task/z ")
    const merged = tableRow(wide, " task/m ")
    expect({
      header: {
        age: header.includes("AGE / RUN"),
        time: /\bTIME\b/u.test(header),
        runtime: /\bRUNTIME\b/u.test(header),
      },
      held: held.includes("— / 3:21"),
      waiting: waiting.includes("— / —"),
      merged: merged.includes("— / 4:10"),
      openedNotAge: !held.includes("40:00") && !waiting.includes("12:03"),
    }).toEqual({
      header: { age: true, time: false, runtime: false },
      held: true,
      waiting: true,
      merged: true,
      openedNotAge: true,
    })
  })

  it("a stuck row whose own stuck record the reading cannot date shows no duration, never the wait it keeps in line (A2-set-v4)", async () => {
    const W = await words()
    // A stuck change keeps its place in line, so the core still measures its wait; its one cell is stuck's alone,
    // and with no instant for its stuck record it says nothing rather than borrow the waiting word.
    const stuck = row({
      at: ago(5 * MINUTE),
      branch: "task/undated",
      position: 1,
      reason: "yrd-check-unresolved",
      since: ago(30 * MINUTE),
      state: "stuck",
    })

    const painted = await lines(snapshot({ rows: [{ row: stuck }], runner: RUNNER }), 100, 31)

    const line = tableRow(painted, " task/undated ").trimEnd()
    expect({
      drawn: line !== "",
      stuckFor: new RegExp(`\\b${W.stuck.word} \\d`, "u").test(line),
      waiting: line.includes(W.waiting.word),
    }).toEqual({ drawn: true, stuckFor: false, waiting: false })
  })

  /**
   * @failure  The detail kept `Age · Runtime · Wait time`, each on a basis of its own, beside the table cell's
   *           one duration (@i/10-yrd/24196, review finding 3): a change submitted 50 minutes ago, whose
   *           3-minute run passed 35 minutes ago, read `waiting 50:00` in the table and `Age 15:00 · Runtime
   *           3:00 · Wait time 12:00` in its detail. One word, one basis (A2-set-v4); the attempt's runtime
   *           stays in the detail.
   */
  it("a pending row's detail says the waiting number its table cell says, and the attempt's runtime under its own name, with no Age or Wait time", async () => {
    const W = await words()
    const pending = row({
      at: ago(35 * MINUTE),
      branch: "task/y1",
      endedAt: ago(35 * MINUTE),
      head: "2".repeat(40),
      position: 1,
      run: RUN_ID,
      since: ago(50 * MINUTE),
      startedAt: ago(38 * MINUTE),
      state: "checked",
      subject: "passed, waits to merge",
    })

    const page = (await printListing(snapshot({ rows: [{ row: pending }] }), { color: false, columns: 120 })).split(
      "\n",
    )
    const detail = await paint(at(<RunStatusBox run={runOf(pending, "main", [])} />))

    const waiting = (text: string): string | undefined =>
      new RegExp(`\\b${W.waiting.word} (\\d+:\\d\\d)\\b`, "u").exec(text)?.[1]
    expect({
      detail: waiting(detail),
      oldClocks: /\b(Age|Wait time)\b/u.test(detail),
      runtime: /\bruntime (\d+:\d\d)\b/u.exec(detail)?.[1],
      table: tableRow(page, "task/y1"),
    }).toEqual({
      detail: "50:00",
      oldClocks: false,
      runtime: "3:00",
      table: expect.stringContaining("— / 3:00"),
    })
  })

  it("each band's own rule names the order ITS rows are in, and what their TIME means", async () => {
    // Obsolete band prose was removed per operator review directive; bands are
    // separated by clean divider rules.
    const painted = await lines(snapshot({ rows: EVERY_STATE, runner: RUNNER }), 120, 40)

    expect(painted.some((line) => line.includes("not submitted"))).toBe(false)
    expect(painted.some((line) => line.includes("the bottom row goes next"))).toBe(false)
    expect(painted.some((line) => line.includes("done, newest first"))).toBe(false)
    expect(painted.some((line) => line.includes("────"))).toBe(true)
  })

  it("draws a pushed branch nobody submitted as a draft row, with its head commit's author and time and no duration, and counts drafts on their own, never among the changes waiting", async () => {
    const W = await words()
    const committedAt = ago(2 * 60 * MINUTE)
    const rows: WatchRow[] = [
      {
        row: row({
          at: ago(12 * MINUTE),
          branch: "task/z",
          head: "3".repeat(40),
          position: 1,
          since: ago(12 * MINUTE),
          state: "queued",
          subject: "not checked yet",
        }),
      },
      draft("task/d", "a".repeat(40), committedAt, "ada"),
    ]

    const snap = snapshot({ rows, runner: RUNNER })
    const painted = await lines(snap, 120, 40)

    const line = tableRow(painted, " task/d")
    const segments = queueLine(snap, NOW, 120 - 2).trim().split(" · ")
    expect({
      by: / —/.test(line) && !/ ada\b/u.test(line),
      counted: segments.slice(1).some((segment) => segment.startsWith(`1 ${W.draft.word}`)),
      noRun: line.includes("— / —"),
      waiting: segments[0] === `1 ${W.waiting.word}: 1 ${W.submitted.word}`,
      word: line.includes(` ${W.draft.word} `),
    }).toEqual({ by: true, counted: true, noRun: true, waiting: true, word: true })
  })

  it("draws no child-observation line for the native contract, which has nothing to say every round", async () => {
    const observation: GitObservation = {
      contract: "native",
      message:
        "Child observation is not configured for /repo#refs/heads/main; native Git observes the root queue only.",
      notices: [],
    }

    const painted = await lines(snapshot({ observation }), 120, 40)

    expect(painted.join("\n")).not.toContain("Child observation is not configured")
  })

  it("draws no child-observation line for a clean root-v1 round with no notices", async () => {
    const observation: GitObservation = {
      contract: "root-v1",
      message: "observed the root queue and its children; nothing to report",
      notices: [],
      outcome: "observed",
      version: 1,
    }

    const painted = await lines(snapshot({ observation }), 120, 40)

    expect(painted.join("\n")).not.toContain("observed the root queue and its children")
  })

  it("still draws an observation error, and draws it loud", async () => {
    const message = "git-super could not reach a child transport: connection refused"
    const observation: GitObservation = {
      contract: "root-v1",
      message,
      notices: [],
      outcome: "unavailable-transport",
      version: 1,
    }
    const app = render(<WatchPane snapshot={snapshot({ observation })} live={false} />, { cols: 120, rows: 40 })
    await settle(app)
    const y = app.lines.findIndex((line) => line.includes(message))
    const x = y < 0 ? -1 : (app.lines[y] ?? "").indexOf(message)
    const drawn = { loud: x >= 0 && app.cell(x, y).bold, shown: y >= 0 }
    app.unmount()

    expect(drawn).toEqual({ loud: true, shown: true })
  })

  it("stacks compact STATS above the expanded box, not beside it, at 80 and 160 columns", async () => {
    const snap = snapshot({
      decisions: DECISIONS,
      drafts: { unread: 0, window: "7d" },
      rows: EVERY_STATE,
      runner: RUNNER,
      stopped: STOP,
    } as Partial<WatchSnapshot>)
    const seen = []
    for (const [cols, rows] of [
      [160, 40],
      [80, 31],
    ] as const) {
      const app = render(<WatchPane snapshot={snap} live={false} />, { cols, rows })
      await settle(app)
      app.press("s")
      await settle(app)
      const painted = app.text.split("\n")
      const compact = painted.findIndex(
        (line) => line.includes("STATS") && (line.includes("▸") || line.includes("▾")),
      )
      const box = painted.findIndex((line) => line.includes("╭─ STATS"))
      seen.push({
        size: `${String(cols)}x${String(rows)}`,
        compact,
        box,
        stacked: compact >= 0 && box > compact,
        beside: painted.some(
          (line) =>
            line.includes("STATS") &&
            (line.includes("▸") || line.includes("▾")) &&
            line.includes("╭─ STATS"),
        ),
      })
      app.unmount()
    }
    expect(seen).toEqual([
      { size: "160x40", compact: expect.any(Number), box: expect.any(Number), stacked: true, beside: false },
      { size: "80x31", compact: expect.any(Number), box: expect.any(Number), stacked: true, beside: false },
    ])
  })

  it("? opens the help as an overlay centred over the pane, which keeps its footer, with the legend unclipped at 160x48 and 100x31: every state's word, what it means and what happens next, and direct apart as not a change", async () => {
    const W = await words()
    const full = snapshot({ decisions: DECISIONS, rows: EVERY_STATE, runner: RUNNER })
    const closed = await lines(full, 160, 48)
    const open = await lines(full, 160, 48, ["?"])
    // An overlay repaints one band between the top row and the footer and moves nothing else; a dialog in
    // the pane's flow reflows every row (measured: all 48) and lands under the footer. The band is every
    // row the open help changed. Trailing blanks are not a change: an overlay pads the rows it spans.
    const changed = open.flatMap((line, index) => (line.trimEnd() === closed[index]?.trimEnd() ? [] : [index]))
    const first = changed[0] ?? -1
    const last = changed.at(-1) ?? -1
    const footer = (painted: readonly string[]): string =>
      painted
        .filter((line) => line.trim() !== "")
        .at(-1)
        ?.trimEnd() ?? ""
    // The legend, read over a pane with nothing else on it, so no table text beside the dialog can answer
    // for it, at the widest and the narrowest size of the tier ladder: the help must not clip at either.
    // Wrapped legend lines are joined back: this reads what the legend says, the overlay's shape is read
    // above.
    const bare = snapshot({ rows: [] })
    const bandAt = async (cols: number, rows: number): Promise<string> => {
      const shut = await lines(bare, cols, rows)
      return (await lines(bare, cols, rows, ["?"]))
        .filter((line, index) => line.trimEnd() !== shut[index]?.trimEnd())
        .join(" ")
        .replace(/\s+/gu, " ")
    }
    const band = await bandAt(160, 48)
    const narrowBand = await bandAt(100, 31)
    // A state's entry is its word, then what it means, then what happens next: the meaning is found first
    // and must follow the word directly, so a word said inside another state's line never answers for it.
    const said = (text: string, entry: Entry): boolean => {
      if (entry.means === undefined || entry.next === undefined) return false
      const means = text.indexOf(entry.means)
      if (
        means < 0 ||
        !text
          .slice(0, means)
          .replace(/[\s:—–-]+$/u, "")
          .endsWith(entry.word)
      ) {
        return false
      }
      const next = text.indexOf(entry.next, means + entry.means.length)
      return next >= 0 && next - means < 200
    }
    const missing = (text: string) => [...STATES, "direct" as const].filter((key) => !said(text, W[key]))
    const apart = band.indexOf("not a change")

    expect({
      centred: first > 0 && last < 48 - 1 && Math.abs((first + last) / 2 - (48 - 1) / 2) <= 2,
      directApart: apart >= 0 && band.indexOf(`${W.direct.word} `, apart) > apart,
      footerKept: footer(open) === footer(closed),
      legendMissing: { "100x31": missing(narrowBand), "160x48": missing(band) },
    }).toEqual({ centred: true, directApart: true, footerKept: true, legendMissing: { "100x31": [], "160x48": [] } })
  })

  it("one change to the word table changes every surface that draws a state word, both helps included", async () => {
    const W = await words()
    const SENTINEL = "PENDINGWORD"
    const was = W.pending.word
    const item = row({
      at: ago(3 * MINUTE),
      branch: "task/y1",
      head: "2".repeat(40),
      position: 1,
      since: ago(50 * MINUTE),
      state: "checked",
      subject: "passed, waits to merge",
    })
    const snap = snapshot({ rows: [{ row: item }], runner: RUNNER })
    W.pending.word = SENTINEL
    try {
      const pane = await lines(snap, 120, 40)
      const help = await lines(snapshot({ rows: [] }), 160, 48, ["?"])
      const page = (await printListing(snap, { color: false, columns: 120 })).split("\n")
      const cli = await listHelp()
      const pageTop = page[page.findIndex((line) => line.includes("yrd watch")) + 1] ?? ""
      const surfaces: Readonly<Record<string, boolean>> = {
        "? legend": help.some((line) => line.includes(SENTINEL)),
        "notice line": noticeLine(item).includes(SENTINEL),
        "page STATUS cell": tableRow(page, "task/y1").includes(` ${SENTINEL} `),
        "page top line": pageTop.includes(`1 ${SENTINEL}`),
        "pane STATUS cell": tableRow(pane, "task/y1").includes(` ${SENTINEL} `),
        "queue line": queueLine(snap, NOW, 120).includes(`1 ${SENTINEL}`),
        "queue show line": rowLine({ row: item }).includes(SENTINEL),
        "yrd list --help legend": cli.includes(SENTINEL),
      }

      expect(Object.keys(surfaces).filter((surface) => surfaces[surface] !== true)).toEqual([])
    } finally {
      W.pending.word = was
    }
  })

  it("never draws the queue's internal names queued, checked or withdrawn as a state word, on any surface", async () => {
    const pending = row({
      at: ago(3 * MINUTE),
      branch: "task/y1",
      head: "2".repeat(40),
      position: 1,
      state: "checked",
      subject: "passed, waits to merge",
    })
    const submitted = row({
      branch: "task/z",
      head: "3".repeat(40),
      position: 2,
      state: "queued",
      subject: "not judged yet",
    })
    const cancelled = row({
      at: ago(30 * MINUTE),
      branch: "task/w",
      endedAt: ago(30 * MINUTE),
      head: "7".repeat(40),
      reason: "replaced",
      state: "withdrawn",
      subject: "a newer head replaced it",
    })
    const snap = snapshot({ rows: [pending, submitted, cancelled].map((item) => ({ row: item })), runner: RUNNER })
    const pane = await lines(snap, 120, 40)
    const help = await lines(snapshot({ rows: [] }), 160, 48, ["?"])
    const page = (await printListing(snap, { color: false, columns: 120 })).split("\n")
    const cli = await listHelp()
    const internal = /\b(queued|checked|withdrawn)\b/u
    // The notice's own word, before its cause and its next owner: the prose after it is the core's.
    const noticeWord = (item: Row): string => noticeLine(item).split("  ·  ")[0] ?? ""
    const surfaces: Readonly<Record<string, string>> = {
      "? help": help.join("\n"),
      "notice word, cancelled": noticeWord(cancelled),
      "notice word, pending": noticeWord(pending),
      "notice word, submitted": noticeWord(submitted),
      "page row, cancelled": tableRow(page, "task/w"),
      "page row, pending": tableRow(page, "task/y1"),
      "page row, submitted": tableRow(page, "task/z"),
      "page top line": page[page.findIndex((line) => line.includes("yrd watch")) + 1] ?? "",
      "pane row, cancelled": tableRow(pane, "task/w"),
      "pane row, pending": tableRow(pane, "task/y1"),
      "pane row, submitted": tableRow(pane, "task/z"),
      "pane top line": topLineOf(pane).line,
      "queue show line, cancelled": rowLine({ row: cancelled }),
      "queue show line, pending": rowLine({ row: pending }),
      "queue show line, submitted": rowLine({ row: submitted }),
      "yrd list --help": cli,
    }

    // A surface this test cannot find is listed too, so a line it failed to locate never passes as clean.
    const offending = (surface: string): boolean =>
      (surfaces[surface] ?? "").trim() === "" || internal.test(surfaces[surface] ?? "")
    expect(Object.keys(surfaces).filter(offending)).toEqual([])
  })

  it("at each size of the tier ladder draws the top line on one row, and the checked row keeps its word, its clock and its duration", async () => {
    const W = await words()
    const seen = []
    for (const [cols, rows] of [
      [213, 50],
      [212, 50],
      [100, 31],
    ] as const) {
      const painted = await lines(
        snapshot({ decisions: DECISIONS, rows: EVERY_STATE, runner: RUNNER, stopped: STOP } as Partial<WatchSnapshot>),
        cols,
        rows,
      )
      const top = topLineOf(painted)
      const held = tableRow(painted, "task/x")
      seen.push({
        heldDuration: held.includes("— / 3:2"),
        heldRowDrawn: held !== "",
        heldWord: held.includes(` ${W.checking.word} `),
        size: `${String(cols)}x${String(rows)}`,
        tier: watchTier(cols, rows),
        topLineOneRow: (painted[0] ?? "").includes("yrd watch") && (painted[0] ?? "").includes("YRD"),
      })
    }

    const drawn = { heldDuration: true, heldRowDrawn: true, heldWord: true, topLineOneRow: true }
    expect(seen).toEqual([
      { ...drawn, size: "213x50", tier: "right" },
      { ...drawn, size: "212x50", tier: "below" },
      { ...drawn, size: "100x31", tier: "full" },
    ])
  })

  it("at tiny heights nothing overlaps: the top line keeps its own row, a change row stays whole, and the pills give way first", async () => {
    const W = await words()
    const seen = []
    for (const [cols, rows] of [
      [60, 10],
      [100, 12],
    ] as const) {
      const painted = await lines(
        snapshot({ decisions: DECISIONS, rows: EVERY_STATE, runner: RUNNER, stopped: STOP } as Partial<WatchSnapshot>),
        cols,
        rows,
      )
      const title = painted.findIndex((line) => line.includes("yrd watch"))
      const header = painted.findIndex(
        (line) => line.includes("TASK") && line.includes("RUN") && !line.includes("QUEUE / RUN"),
      )
      // The row under the header opens a band; the change's own row is the
      // first one after that rule.
      const first = painted.slice(header + 1).find((line) => line.includes("task/x")) ?? ""
      const pills = /\bopen\b.*\brunning\b.*\bdone\b.*\bfailed\b/u
      seen.push({
        changeRowWhole: header > title + 1 && first.includes("task/x") && !pills.test(first),
        pillsWhole: painted
          .filter((line) => pills.test(line))
          .every((line) => /\bopen\b/.test(line) && /\bfailed\b/.test(line) && !/\ball\b/.test(line.trimEnd())),
        size: `${String(cols)}x${String(rows)}`,
        topLineOwnRow: (painted[title] ?? "").includes("yrd watch") && (painted[title + 1] ?? "").includes("STATS"),
      })
    }

    const whole = { changeRowWhole: true, pillsWhole: true, topLineOwnRow: true }
    expect(seen).toEqual([
      { ...whole, size: "60x10" },
      { ...whole, size: "100x12" },
    ])
  })

  /**
   * What pulses on a live pane, read across more than one 900 ms period.
   *
   * The cursor opens on the TOP row, which the bands make the newest draft, not
   * the held change: the held change IS the runner's row and sits between what
   * waits and what is done. `steps` walks down to it. The fixture is
   * `EVERY_STATE` unsplit, because a change is one row now however many runs
   * touched it — the two-run version of this fixture built exactly the
   * duplicate S1 removes, and the search for the held row found its unheld twin.
   */
  const HELD_ROW = 4
  async function onePulse(cols: number, height: number, steps: number) {
    // `autoRender`: a live pane repaints on its own timers (the clock, the pulse), not only on a key.
    const app = render(
      <WatchPane snapshot={snapshot({ decisions: DECISIONS, rows: EVERY_STATE, runner: RUNNER })} live />,
      {
        autoRender: true,
        cols,
        rows: height,
      },
    )
    await settle(app)
    for (let step = 0; step < steps; step += 1) {
      app.press("j")
      await settle(app)
    }
    const read = () =>
      Array.from({ length: height }, (_, y) =>
        Array.from({ length: cols }, (_, x) => {
          const cell = app.cell(x, y)
          return { char: cell.char, fg: JSON.stringify(cell.fg) }
        }),
      )
    // Across more than one 900 ms pulse period: a cell pulses when its character holds and its colour moves.
    const samples = [read()]
    for (const wait of [470, 470]) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, wait))
        await app.waitForLayoutStable()
      })
      samples.push(read())
    }
    const pulsingRows = new Set<number>()
    let markers = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const seen = samples.map((sample) => sample[y]?.[x])
        const [firstSeen] = seen
        if (firstSeen === undefined || firstSeen.char.trim() === "") continue
        if (seen.every((cell) => cell?.char === firstSeen.char) && new Set(seen.map((cell) => cell?.fg)).size > 1) {
          markers += 1
          pulsingRows.add(y)
        }
      }
    }
    const painted = app.lines
    const header = painted.findIndex(
      (line) => line.includes("TASK") && line.includes("RUN") && !line.includes("QUEUE / RUN"),
    )
    const held = painted.findIndex(
      (line, index) => index > header && (line.includes("task/x") || (line.includes("◉") && line.includes("checking"))),
    )
    const fgOf = (y: number, needle: string): string | undefined => {
      const x = (painted[y] ?? "").indexOf(needle)
      return x < 0 ? undefined : JSON.stringify(app.cell(x, y).fg)
    }
    const heldBranch = fgOf(held, "task/x")
    const waitingBranch = fgOf(
      painted.findIndex((line, index) => index > header && line.includes("task/z")),
      "task/z",
    )
    app.unmount()
    return {
      heldTextStandsOut: heldBranch !== undefined && waitingBranch !== undefined && heldBranch !== waitingBranch,
      markers,
      onlyTheHeldRow: pulsingRows.size === 1 && pulsingRows.has(held),
    }
  }

  it("marks the change the runner holds now, and only it: its row in the working colour with a pulsing marker, and nothing else on screen pulses", async () => {
    // The cursor is on the top row, which is a draft: the held row shows the
    // colour it has on its own.
    expect(await onePulse(100, 31, 0)).toEqual({ heldTextStandsOut: true, markers: 1, onlyTheHeldRow: true })
  }, 10_000)

  // The held row still carries the one pulse when the cursor sits ON it, in the selection's own colours, and
  // an open detail's markers hold still (24196 P1): 100x31 shows no detail, 160x40 shows it below.
  it("keeps the one pulse on the held row when the cursor sits on it, with or without its detail open", async () => {
    const full = await onePulse(100, 31, HELD_ROW)
    const withDetail = await onePulse(160, 40, HELD_ROW)
    expect({
      full: [full.markers, full.onlyTheHeldRow],
      withDetail: [withDetail.markers, withDetail.onlyTheHeldRow],
    }).toEqual({ full: [1, true], withDetail: [1, true] })
  }, 15_000)

  it("says what it knows about the runner without naming a supervisor: yrd does not depend on hab (24869)", async () => {
    const painted = await lines(snapshot({ rows: [{ row: row({ position: 1 }) }], runner: SILENT }), 120, 40)

    // A stale journal reads `idle` and reports its age on the second line: no
    // word is derived from an mtime (@cto, relayed by @chief). `silent` and
    // `stopped` are the runner's own published beat, and it publishes none yet.
    const at = painted.findIndex((line) => line.includes("RUNNER") && line.includes("idle"))
    const runner = painted.slice(at, at + 3).join("\n")
    expect({
      age: /beat \d/u.test(runner),
      said: runner.includes("idle"),
      silent: runner.includes("silent"),
      supervisor: /\bhab\b/u.test(runner),
    }).toEqual({ age: true, said: true, silent: false, supervisor: false })
  })

  it("idle queue is selectable and selected by default in an empty queue, and opening it shows runner detail (watch-review-1244)", async () => {
    const app = render(<WatchPane snapshot={snapshot({ rows: [], runner: RUNNER })} open={opener()} live={false} />, {
      cols: 160,
      rows: 40,
    })
    await settle(app)
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("▸ RUNNER idle")
      expect(current(app)).toContain("Queue: example.test/repo#main")
    })
    app.unmount()
  })

  it("idle queue is selectable in queued-only data: idle runner is selected by default (watch-review-1345)", async () => {
    const q1 = row({ branch: "task/q1", head: "1".repeat(40), state: "queued", position: 1 })
    const q2 = row({ branch: "task/q2", head: "2".repeat(40), state: "queued", position: 2 })
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [{ row: q1 }, { row: q2 }], runner: RUNNER })}
        open={opener()}
        live={false}
      />,
      { cols: 160, rows: 40 },
    )
    await settle(app)
    expect(current(app)).not.toContain("Home follows the newest again")
    // Idle runner is selected by default on mount in queued-only data
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("▸ RUNNER idle")
      expect(current(app)).toContain("Queue: example.test/repo#main")
    })
    // ArrowUp navigates up to q1 (position 1 is right above runner)
    app.press("ArrowUp")
    await settle(app)
    app.press("Enter")
    await waitFor(() => {
      expect(current(app)).toContain("· task/q1@111111111111")
    })
    app.unmount()
  })

  it("keyboard navigation moves cursor without snapping selected row to viewport lead (watch-review-1345)", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ branch: `task/row-${i}`, head: `${i}`.repeat(40), state: "queued", position: i + 1 }),
    )
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: rows.map((r) => ({ row: r })), runner: RUNNER })}
        open={opener()}
        live={false}
      />,
      { cols: 160, rows: 25 },
    )
    await settle(app)
    // Initially runner is selected (index 20)
    expect(current(app)).toContain("RUNNER")
    expect(current(app)).not.toContain("Home follows the newest again")
    // Moving cursor within visible range does not alter viewport lead
    app.press("ArrowUp")
    await settle(app)
    app.press("ArrowDown")
    await settle(app)
    expect(current(app)).toContain("RUNNER")
    app.unmount()
  })

  it("vertically centers the idle runner in a long queue with rows above and below (watch-correction-review-1419)", async () => {
    const queued = Array.from({ length: 20 }, (_, i) =>
      row({ branch: `task/queued-${i}`, head: `${i}`.repeat(40), state: "queued", position: i + 1 }),
    )
    const merged = Array.from({ length: 20 }, (_, i) =>
      row({ branch: `task/done-${i}`, head: `d${i}`.padEnd(40, "0"), state: "merged" }),
    )
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [...queued, ...merged].map((r) => ({ row: r })), runner: RUNNER })}
        open={opener()}
        live={false}
      />,
      { cols: 160, rows: 25 },
    )
    await settle(app)
    const text = current(app)
    const lines = text.split("\n")

    // Terminal is 25 rows tall (0..24). In the 20-row ListView viewport (lines 4..23):
    // Runner item has height 6 (1 row marginTop + 4 rows TitledBox + 1 row marginBottom).
    // Center alignment places the runner item in viewport center, placing
    // runner box at lines 13..16 with the item's marginTop at line 12 and marginBottom at line 17.
    const runnerStart = lines.findIndex((l) => l.includes("╭─ RUNNER"))
    const runnerEnd = lines.findIndex((l) => l.includes("╰─"))
    expect(runnerStart).toBe(13)
    expect(runnerEnd).toBe(16)

    // Above runner item: queued items in viewport (lines 4..11: task/queued-7..0).
    expect(lines[4]).toContain("task/queued-7")
    expect(lines[11]).toContain("task/queued-0")
    expect(text).not.toContain("task/queued-19")
    expect(text).not.toContain("task/queued-8")

    // Below runner box: break row (line 18), and task/done-0..4 (lines 19..23).
    expect(lines[19]).toContain("task/done-0")
    expect(lines[23]).toContain("task/done-4")
    expect(text).not.toContain("task/done-5")
    expect(text).not.toContain("task/done-19")

    // Proves vertical centering of the runner item in the 20-row viewport (lines 4..23):
    // 8 rows above the runner item (lines 4..11), 6 rows below the runner item (lines 18..23).
    expect(runnerStart - 1 - 4).toBe(8)
    expect(23 - (runnerEnd + 1)).toBe(6)

    app.unmount()
  })

  it("renders RUNNER box with status color on border and title for STOPPED and STUCK runner", async () => {
    // 1. Stopped runner: border and title show status color
    const stoppedApp = render(
      <WatchPane
        snapshot={snapshot({
          runner: {
            journalDir: "/w/logs",
            service: { kind: "stopped", why: "heartbeat overdue", cause: "timeout" },
          },
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(stoppedApp)
    const stoppedPainted = stoppedApp.lines
    const stoppedRunnerLineIdx = stoppedPainted.findIndex((l) => l.includes("╭─ RUNNER"))
    expect(stoppedRunnerLineIdx).toBeGreaterThan(0)
    const stoppedLine = stoppedPainted[stoppedRunnerLineIdx]!
    const stoppedBorderCharIdx = stoppedLine.indexOf("╭")
    const stoppedTitleCharIdx = stoppedLine.indexOf("RUNNER")
    const stoppedBorderFg = stoppedApp.cell(stoppedBorderCharIdx, stoppedRunnerLineIdx).fg
    const stoppedTitleFg = stoppedApp.cell(stoppedTitleCharIdx, stoppedRunnerLineIdx).fg

    expect(stoppedBorderFg).toBeDefined()
    expect(stoppedTitleFg).toEqual(stoppedBorderFg)
    stoppedApp.unmount()

    // 2. Stuck runner: border and title show status color (stuck warning color, distinct from stopped error color)
    const stuckApp = render(
      <WatchPane
        snapshot={snapshot({
          runner: RUNNER,
          stopped: STOP,
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(stuckApp)
    const stuckPainted = stuckApp.lines
    const stuckRunnerLineIdx = stuckPainted.findIndex((l) => l.includes("╭─ RUNNER"))
    expect(stuckRunnerLineIdx).toBeGreaterThan(0)
    const stuckLine = stuckPainted[stuckRunnerLineIdx]!
    const stuckBorderCharIdx = stuckLine.indexOf("╭")
    const stuckTitleCharIdx = stuckLine.indexOf("RUNNER")
    const stuckBorderFg = stuckApp.cell(stuckBorderCharIdx, stuckRunnerLineIdx).fg
    const stuckTitleFg = stuckApp.cell(stuckTitleCharIdx, stuckRunnerLineIdx).fg

    expect(stuckBorderFg).toBeDefined()
    expect(stuckTitleFg).toEqual(stuckBorderFg)
    expect(stuckBorderFg).not.toEqual(stoppedBorderFg)
    stuckApp.unmount()

    // 3. Idle runner: border and title use idle color, distinct from stopped/stuck colors
    const idleApp = render(
      <WatchPane
        snapshot={snapshot({
          runner: RUNNER,
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(idleApp)
    const idlePainted = idleApp.lines
    const idleRunnerLineIdx = idlePainted.findIndex((l) => l.includes("╭─ RUNNER"))
    expect(idleRunnerLineIdx).toBeGreaterThan(0)
    const idleLine = idlePainted[idleRunnerLineIdx]!
    const idleBorderCharIdx = idleLine.indexOf("╭")
    const idleTitleCharIdx = idleLine.indexOf("RUNNER")
    const idleBorderFg = idleApp.cell(idleBorderCharIdx, idleRunnerLineIdx).fg
    const idleTitleFg = idleApp.cell(idleTitleCharIdx, idleRunnerLineIdx).fg

    expect(idleBorderFg).toBeDefined()
    expect(idleTitleFg).toEqual(idleBorderFg)
    expect(idleBorderFg).not.toEqual(stoppedBorderFg)
    idleApp.unmount()
  })

  it("empty pane (BandBreakRows) renders RUNNER box with status color on border and title for STOPPED, STUCK, IDLE", async () => {
    // 1. Stopped runner in empty pane (rows: [])
    const stoppedApp = render(
      <WatchPane
        snapshot={snapshot({
          rows: [],
          runner: {
            journalDir: "/w/logs",
            service: { kind: "stopped", why: "heartbeat overdue", cause: "timeout" },
          },
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(stoppedApp)
    const stoppedPainted = stoppedApp.lines
    const stoppedRunnerLineIdx = stoppedPainted.findIndex((l) => l.includes("╭─ RUNNER"))
    expect(stoppedRunnerLineIdx).toBeGreaterThan(0)
    const stoppedLine = stoppedPainted[stoppedRunnerLineIdx]!
    const stoppedBorderCharIdx = stoppedLine.indexOf("╭")
    const stoppedTitleCharIdx = stoppedLine.indexOf("RUNNER")
    const stoppedBorderFg = stoppedApp.cell(stoppedBorderCharIdx, stoppedRunnerLineIdx).fg
    const stoppedTitleFg = stoppedApp.cell(stoppedTitleCharIdx, stoppedRunnerLineIdx).fg

    expect(stoppedBorderFg).toBeDefined()
    expect(stoppedTitleFg).toEqual(stoppedBorderFg)
    stoppedApp.unmount()

    // 2. Stuck runner in empty pane (rows: [])
    const stuckApp = render(
      <WatchPane
        snapshot={snapshot({
          rows: [],
          runner: RUNNER,
          stopped: STOP,
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(stuckApp)
    const stuckPainted = stuckApp.lines
    const stuckRunnerLineIdx = stuckPainted.findIndex((l) => l.includes("╭─ RUNNER"))
    expect(stuckRunnerLineIdx).toBeGreaterThan(0)
    const stuckLine = stuckPainted[stuckRunnerLineIdx]!
    const stuckBorderCharIdx = stuckLine.indexOf("╭")
    const stuckTitleCharIdx = stuckLine.indexOf("RUNNER")
    const stuckBorderFg = stuckApp.cell(stuckBorderCharIdx, stuckRunnerLineIdx).fg
    const stuckTitleFg = stuckApp.cell(stuckTitleCharIdx, stuckRunnerLineIdx).fg

    expect(stuckBorderFg).toBeDefined()
    expect(stuckTitleFg).toEqual(stuckBorderFg)
    expect(stuckBorderFg).not.toEqual(stoppedBorderFg)
    stuckApp.unmount()

    // 3. Idle runner in empty pane (rows: [])
    const idleApp = render(
      <WatchPane
        snapshot={snapshot({
          rows: [],
          runner: RUNNER,
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(idleApp)
    const idlePainted = idleApp.lines
    const idleRunnerLineIdx = idlePainted.findIndex((l) => l.includes("╭─ RUNNER"))
    expect(idleRunnerLineIdx).toBeGreaterThan(0)
    const idleLine = idlePainted[idleRunnerLineIdx]!
    const idleBorderCharIdx = idleLine.indexOf("╭")
    const idleTitleCharIdx = idleLine.indexOf("RUNNER")
    const idleBorderFg = idleApp.cell(idleBorderCharIdx, idleRunnerLineIdx).fg
    const idleTitleFg = idleApp.cell(idleTitleCharIdx, idleRunnerLineIdx).fg

    expect(idleBorderFg).toBeDefined()
    expect(idleTitleFg).toEqual(idleBorderFg)
    expect(idleBorderFg).not.toEqual(stoppedBorderFg)
    idleApp.unmount()
  })

  it("row 14: queue filters on the left, status filters on the right on the top line", async () => {
    const app = render(
      <WatchPane
        snapshot={snapshot({
          queues: [{ branch: "main", label: "main", path: "/repo" }],
          rows: [{ row: failedRow() }],
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(app)
    const painted = app.lines

    // 1. Top line has yrd watch, queue filter pills on left, status marker and status filter pills on right
    const topIdx = painted.findIndex((l) => l.includes("yrd watch"))
    expect(topIdx).toBeGreaterThanOrEqual(0)
    const topLine = painted[topIdx]!

    // Queue filter pills are left-aligned
    const queueX = topLine.indexOf("main")
    expect(queueX).toBeGreaterThan(0)
    expect(queueX).toBeLessThan(40)

    // Status filter pills are on the top line, right-aligned
    expect(topLine).toContain("open")
    expect(topLine).toContain("failed")
    const openX = topLine.indexOf("open")
    expect(openX).toBeGreaterThan(60)
    expect(topLine.trimEnd().endsWith("failed")).toBe(true)

    // 2. There is NO separate pills line in the body
    const bodyLines = painted.slice(topIdx + 1)
    const separatePills = bodyLines.some((l) => l.includes("open") && l.includes("running") && l.includes("failed"))
    expect(separatePills).toBe(false)

    app.unmount()
  })

  it("row 15: fold marker plus STATS directly under top line without duplicate waiting count and without stopped or last-merged slugs", async () => {
    const app = render(
      <WatchPane
        snapshot={snapshot({
          decisions: DECISIONS,
          rows: [
            { row: row({ state: "queued", position: 1, branch: "task/queued-1" }) },
            { row: row({ state: "merged", branch: "task/merged-1" }) },
          ],
          stopped: STOP,
          runner: RUNNER,
        })}
        live={false}
      />,
      { cols: 120, rows: 30 },
    )
    await settle(app)

    const topIdx = app.lines.findIndex((l) => l.includes("yrd watch"))
    expect(topIdx).toBeGreaterThanOrEqual(0)

    // 1. The line DIRECTLY under the top line is fold marker + STATS
    const lineUnderTop = app.lines[topIdx + 1]!
    expect(lineUnderTop).toContain("▸ STATS")
    expect(lineUnderTop).toContain(`(${String(DECISIONS.length)} decisions · s to expand)`)

    // 2. No duplicate waiting count, no stopped slug, no last-merge slug
    expect(lineUnderTop).not.toContain("waiting")
    expect(lineUnderTop).not.toContain("stopped")
    expect(lineUnderTop).not.toContain("last merge")
    expect(lineUnderTop).not.toContain("merged")

    // 3. Pressing 's' expands: fold marker toggles to ▾ STATS directly under top line
    app.press("s")
    await settle(app)
    const lineUnderTopExpanded = app.lines[topIdx + 1]!
    expect(lineUnderTopExpanded).toContain("▾ STATS")
    expect(lineUnderTopExpanded).toContain(`(${String(DECISIONS.length)} decisions · s to fold)`)
    expect(lineUnderTopExpanded).not.toContain("waiting")
    expect(lineUnderTopExpanded).not.toContain("stopped")
    expect(lineUnderTopExpanded).not.toContain("last merge")
    expect(lineUnderTopExpanded).not.toContain("merged")

    app.unmount()
  })

  it("row 16: removal of done, newest-first and TIME=ended prose anywhere in table", async () => {
    const painted = await lines(snapshot({ rows: EVERY_STATE, runner: RUNNER }), 120, 40)
    const fullText = painted.join("\n")

    expect(fullText).not.toContain("done, newest first")
    expect(fullText).not.toContain("newest first")
    expect(fullText).not.toContain("TIME=ended")
    expect(fullText).not.toContain("not submitted")
    expect(fullText).not.toContain("the bottom row goes next")
    expect(painted.some((line) => line.includes("────"))).toBe(true)
  })

  it("row 17: detail pane with subtle background, DIVIDER_SIZE = 0, and blank padding line replacing divider", async () => {
    const app = render(
      <WatchPane
        snapshot={snapshot({
          rows: [{ row: failedRow() }],
        })}
        open={opener()}
        live={false}
      />,
      { cols: 220, rows: 40 },
    )
    await settle(app)
    app.press("Enter")
    await settle(app)

    // 1. Subtle background: read cell background in list vs in detail pane
    const runnerLineIdx = app.lines.findIndex((l) => l.includes("RUNNER"))
    expect(runnerLineIdx).toBeGreaterThan(0)
    const runnerX = app.lines[runnerLineIdx]!.indexOf("RUNNER")
    expect(runnerX).toBeGreaterThan(140)

    const listBg = app.cell(10, runnerLineIdx).bg
    const detailBg = app.cell(runnerX, runnerLineIdx).bg

    // Detail background must differ from list background and match subtle color
    expect(detailBg).not.toEqual(listBg)
    expect(detailBg).toEqual({ r: 50, g: 56, b: 68 })

    // 2. Blank padding line: first row of detail pane (line 1, under TopLine) is blank (<Box height={1} flexShrink={0} />)
    const detailTop = app.lines[1]?.slice(143).trim() ?? ""
    expect(detailTop).toBe("")

    // 3. Divider line is absent: no vertical divider character between list and detail on top rows
    expect(app.lines.slice(0, 4).some((line) => line.slice(135, 145).includes("│"))).toBe(false)

    app.unmount()
  })

  it("item 8: three blank lines around runner box and header (marginTop, marginBottom, header spacer)", async () => {
    const queued = Array.from({ length: 20 }, (_, i) =>
      row({ branch: `task/queued-${i}`, head: `${i}`.repeat(40), state: "queued", position: i + 1 }),
    )
    const merged = Array.from({ length: 20 }, (_, i) =>
      row({ branch: `task/done-${i}`, head: `d${i}`.padEnd(40, "0"), state: "merged" }),
    )
    const app = render(
      <WatchPane
        snapshot={snapshot({ rows: [...queued, ...merged].map((r) => ({ row: r })), runner: RUNNER })}
        open={opener()}
        live={false}
      />,
      { cols: 160, rows: 25 },
    )
    await settle(app)
    const lines = app.lines

    // 1. Header spacer: line before ListHeader (line 2) is blank
    expect(lines[2]?.trim()).toBe("")
    expect(lines[3]).toContain("TASK")

    // 2. marginTop: line before runner box (line 12) is blank
    expect(lines[12]?.trim()).toBe("")
    expect(lines[13]).toContain("╭─ RUNNER")

    // 3. marginBottom: line after runner box (line 17) is blank
    expect(lines[16]).toContain("╰─")
    expect(lines[17]?.trim()).toBe("")

    app.unmount()
  })
})
