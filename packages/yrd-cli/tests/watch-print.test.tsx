/**
 * @failure  The printed page drifted from the pane: the pane got RUNNER back
 *           above the table with the pause on its own rail (yrd b2d8ebb3,
 *           0f2c45e6) while `yrd list` still printed the pause as a bare
 *           first line and RUNNER last, under the table (the operator's
 *           2026-09-05 eyeball; the retired page put RUNNER in the header
 *           block above the table, 24169-old-list.md §1). The order is
 *           tested where the page is rendered, not inferred from the pane.
 * @level    l2 (a real silvery render of the page into a headless buffer)
 * @consumer the operator reading `yrd list` (@i/10-yrd/24169)
 */

import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { journalKey, watchRows, type Journals, type JournalRun, type Row } from "@yrd/queue-core"
import { ListingPage, printListing } from "../src/watch-print.tsx"
import type { WatchSnapshot } from "../src/watch-pane.tsx"

const NOW = new Date("2026-09-05T14:00:00Z")
const RUN_ID = "q-20260905T135900000Z-abcdef12"

function row(over: Partial<Row> = {}): Row {
  return {
    branch: "task/one",
    head: "1111111111111111111111111111111111111111",
    state: "merged",
    since: new Date(NOW.getTime() - 60_000),
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
    // A snapshot built from its rows alone is a reading nothing was selected from.
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

describe("the printed page's frame", () => {
  it("shows a newly arrived ref-write warning without changing the successful row", async () => {
    // 24202: unchanged terminal fields used to make ListRow's memo hide this arrival.
    const initial = row({ run: RUN_ID, result: "pass", endedAt: NOW })
    const app = render(
      <ListingPage snapshot={snapshot({ rows: [{ row: initial }] })} options={{ columns: 120, color: false }} />,
      { cols: 120, rows: 40 },
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text).not.toContain("⚠")
      app.rerender(
        <ListingPage
          snapshot={snapshot({
            rows: [
              {
                row: {
                  ...initial,
                  diagnostics: [
                    {
                      kind: "change",
                      run: RUN_ID,
                      at: NOW.toISOString(),
                      reason: "change-ref-taken",
                      text: "ref write refused",
                      inspect: "git show refs/changes/example",
                    },
                  ],
                },
              },
            ],
          })}
          options={{ columns: 120, color: false }}
        />,
      )
      await app.waitForLayoutStable()
      expect(app.text).toContain("⚠")
      expect(app.text).toContain("merged")
    } finally {
      app.unmount()
    }
  })

  const pause = "paused by @chief: the host is down"
  const runner = {
    journalDir: "/w/logs",
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
  }

  it("puts RUNNER above the table, under the title, with the pause only on RUNNER's rail", async () => {
    const text = await paint(snapshot({ pause, runner }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const title = lines.findIndex((line) => line.includes("YRD QUEUES"))
    const box = lines.findIndex((line) => line.includes("RUNNER"))
    const header = lines.findIndex((line) => line.includes("CHANGES"))
    expect(title).toBeGreaterThanOrEqual(0)
    expect(box).toBeGreaterThan(title)
    expect(header).toBeGreaterThan(box)
    expect(text.match(new RegExp(pause, "gu"))).toHaveLength(1)
    // The pause sits inside the box: on a bordered line, not above the title.
    expect(lines[0]).not.toContain(pause)
  })

  it("keeps the pause as one loud line above the title when there is no RUNNER rail", async () => {
    const text = await paint(snapshot({ pause }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    expect(lines[0]).toContain(pause)
    expect(text).not.toContain("RUNNER")
    expect(text.match(new RegExp(pause, "gu"))).toHaveLength(1)
  })

  it("keeps the queue's own name line, the anchor a logged round's stamp sits under", async () => {
    const text = await paint(snapshot({ pause, runner }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const name = lines.findIndex((line) => line.trim() === "example.test/repo#main")
    const box = lines.findIndex((line) => line.includes("RUNNER"))
    expect(name).toBeGreaterThanOrEqual(0)
    expect(name).toBeLessThan(box)
  })
})

describe("a one-shot render when a row's check is running right now", () => {
  // `printListing` is the real production path (`renderString`, dynamically
  // imported by `queue list`'s human printer): unlike this file's own
  // `paint()` helper, which renders through silvery/test's scoped `render()`
  // and so always has an app-root scope, `renderString` has none. A row with
  // `live` set used to reach ListRow's STATUS cell, which rendered a
  // `synchronized` `<Pulse>` unconditionally in that case — and silvery's
  // useSynchronizedPhase throws when an enabled multi-step clock has no
  // app-root scope to join. Measured 2026-09-09: `yrd queue list` crashed
  // with exactly this error whenever any row (or the runner) was live at
  // read time; the same command succeeded moments later once the runner went
  // idle. This must fail on a revert of the `live`/`active` gate in
  // watch-list.tsx's `ListRow`.
  it("does not throw, and prints the row's state in its static (non-pulsing) color", async () => {
    const liveRow = row({
      state: "checked",
      live: { check: "typecheck", phase: "run", run: RUN_ID, since: NOW },
    })

    const text = await printListing(snapshot({ rows: [{ row: liveRow }] }), { color: false, columns: 120 })

    expect(text).toContain("task/one")
    // A check running now reads checking whatever the records say (24196).
    expect(text).toContain("◉ checking")
  })

  it("still leaves the RUNNER box's own marker crash-free while a run is active", async () => {
    const liveRow = row({
      state: "checked",
      live: { check: "typecheck", phase: "run", run: RUN_ID, since: NOW },
    })
    const runner = {
      journalDir: "/w/logs",
      latest: { alive: true, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
    }

    const text = await printListing(snapshot({ rows: [{ row: liveRow }], runner }), { color: false, columns: 120 })

    expect(text).toContain("RUNNER")
  })
})

/**
 * The operator's 09:25 screen, read on the queue's own machine: a draft, three
 * changes waiting, one of them checked twice, and two changes done. The whole
 * page is rendered — never assembled by the test — and the assertions are the
 * two facts the flow page exists for: the bands are in one order, and a change
 * is one row however many runs touched it.
 */
const READ_AT = new Date("2026-09-17T16:25:00.000Z")

function change(over: Partial<Row>): Row {
  return {
    branch: "task/x",
    head: "0".repeat(40),
    state: "queued",
    since: new Date(READ_AT.getTime() - 3_600_000),
    submitter: "@dev/1",
    subject: "does its work",
    ...over,
  } as Row
}

function runOfChange(branch: string, head: string, id: string, at: Date): JournalRun {
  return { at, branch, checks: [], head, id, startedAt: at }
}

/** The core rows in `list()`'s own order: in line by position, then the ended newest first, then the drafts. */
function flowRows(): readonly Row[] {
  const ago = (minutes: number): Date => new Date(READ_AT.getTime() - minutes * 60_000)
  return [
    change({ branch: "task/next", head: "1".repeat(40), position: 1, since: ago(50) }),
    change({ branch: "task/twice", head: "2".repeat(40), position: 2, since: ago(40), state: "checked" }),
    change({ branch: "task/late", head: "3".repeat(40), position: 3, since: ago(10) }),
    change({ at: ago(5), branch: "task/merged", endedAt: ago(5), head: "4".repeat(40), state: "merged" }),
    change({
      at: ago(20),
      branch: "task/broke",
      endedAt: ago(20),
      head: "5".repeat(40),
      reason: "test",
      result: "fail test",
      state: "failed",
    }),
    change({ at: ago(2), author: "ada", branch: "task/draft", head: "6".repeat(40), state: "draft" }),
  ]
}

/** Two runs checked `task/twice`, which is why it printed twice on the operator's screen. */
function flowJournals(): Journals {
  const twice = journalKey("task/twice", "2".repeat(40))
  return {
    dir: "/w/logs",
    malformed: [],
    runs: new Map([
      [
        twice,
        [
          runOfChange("task/twice", "2".repeat(40), "q-20260917T161500000Z-22222222", new Date(READ_AT.getTime() - 600_000)),
          runOfChange("task/twice", "2".repeat(40), "q-20260917T160000000Z-11111111", new Date(READ_AT.getTime() - 1_500_000)),
        ],
      ],
    ]),
  }
}

function flowSnapshot(over: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return snapshot({
    at: READ_AT,
    drafts: { unread: 0, window: "7d" },
    rows: [...watchRows(flowRows(), { journals: flowJournals() })],
    runner: {
      journalDir: "/w/logs",
      latest: {
        alive: true,
        id: RUN_ID,
        lastWriteAt: new Date(READ_AT.getTime() - 20_000),
        startedAt: new Date(READ_AT.getTime() - 120_000),
      },
    },
    ...over,
  })
}

describe("the flow page: four bands, one row per change", () => {
  it("draws drafts, waiting, the runner and done in that order, with each change on one row", async () => {
    const text = await paint(flowSnapshot())
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const drafts = lines.findIndex((line) => line.includes("pushed, not submitted"))
    const waiting = lines.findIndex((line) => line.includes("the bottom row goes next"))
    const runner = lines.findIndex((line) => line.includes("RUNNER"))
    const done = lines.findIndex((line) => line.includes("done, newest first"))

    expect(drafts, text).toBeGreaterThanOrEqual(0)
    expect(waiting, text).toBeGreaterThan(drafts)
    expect(runner, text).toBeGreaterThan(waiting)
    expect(done, text).toBeGreaterThan(runner)
    // The whole bug: two runs checked this change, and the page is about changes.
    expect(lines.filter((line) => line.includes("task/twice")), text).toHaveLength(1)
  })

  it("puts the front of the line at the bottom of waiting, against the runner, and the newest done at the top of done", async () => {
    const text = await paint(flowSnapshot())
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const index = (needle: string): number => lines.findIndex((line) => line.includes(needle))
    const runner = index("RUNNER")

    // Distance from the runner is distance from now, in both directions.
    expect(index("task/late"), text).toBeLessThan(index("task/twice"))
    expect(index("task/twice"), text).toBeLessThan(index("task/next"))
    expect(index("task/next"), text).toBeLessThan(runner)
    expect(index("task/merged"), text).toBeGreaterThan(runner)
    expect(index("task/merged"), text).toBeLessThan(index("task/broke"))
    // A draft is no change, and it is the furthest thing from the line.
    expect(index("task/draft"), text).toBeLessThan(index("task/late"))
  })

  it("draws the runner in the table's own columns and says `?` where no status is published", async () => {
    const text = await paint(flowSnapshot({ runner: undefined }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const runner = lines.find((line) => line.includes("RUNNER"))

    expect(runner, text).toBeDefined()
    // S1 does not invent a status source: the runner publishes nothing until S2.
    expect(runner).toContain("?")
    expect(text).not.toContain("╭─ RUNNER")
    // The RUN column is gone from every row.
    expect(lines.find((line) => line.includes("CHANGES"))).not.toContain("RUN")
  })
})
