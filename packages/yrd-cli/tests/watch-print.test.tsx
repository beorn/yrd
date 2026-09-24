/**
 * @failure  The printed page drifted from the pane: the pane got RUNNER back
 *           above the table with the pause on its own rail (yrd b2d8ebb3,
 *           0f2c45e6) while `yrd list` still printed the pause as a bare
 *           first line and RUNNER last, under the table (the operator's
 *           2026-09-05 eyeball; the retired page put RUNNER in the header
 *           block above the table, 24169-old-list.md §1). RUNNER is a ROW
 *           between waiting and done since S1, and the band order is spelled
 *           once in watch-frame.tsx — but the drift is the same drift, so the
 *           order is still tested where the page is rendered, never inferred
 *           from the pane.
 * @level    l2 (a real silvery render of the page into a headless buffer)
 * @consumer the operator reading `yrd list` (@i/10-yrd/24169)
 */

import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { journalKey, watchRows, type Journals, type JournalRun, type Row } from "@yrd/queue-core"
import { ListingPage, printListing } from "../src/watch-print.tsx"
import type { WatchSnapshot } from "../src/watch-pane.tsx"

/** The service's own health document, believable by the deadline its writer declared: the runner is up. */
const BEATING = { kind: "beating", state: "healthy" } as const

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
    service: BEATING,
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
  }

  it("puts RUNNER in the table, under the header, in a box", async () => {
    const text = await paint(snapshot({ pause, runner }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const title = lines.findIndex((line) => line.includes("YRD"))
    const header = lines.findIndex((line) => line.includes("ISSUE / BRANCH"))
    const runnerRow = lines.findIndex((line) => line.includes("RUNNER"))
    expect(title).toBeGreaterThanOrEqual(0)
    expect(header).toBeGreaterThan(title)
    // The band is IN the table now, between what waits and what is done.
    expect(runnerRow).toBeGreaterThan(header)
    expect(text).toContain("\u256d\u2500 RUNNER")
    expect(text.match(new RegExp(pause, "gu"))).toHaveLength(1)
    // The pause is the loudest state on the page and it leads it; the runner's
    // row says the WORD paused and what lifts the stop, never the same sentence.
    expect(lines[0]).toContain(pause)
  })

  it("keeps the pause as one loud line above the title when the runner's status is not published", async () => {
    const text = await paint(snapshot({ pause }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    expect(lines[0]).toContain(pause)
    // The runner's row is always there: an empty queue still has a runner, and
    // a page that says nothing about it reads as a page with nothing to say.
    expect(text).toContain("RUNNER")
    expect(text.match(new RegExp(pause, "gu"))).toHaveLength(1)
  })

  it("keeps the queue's own name line, the anchor a logged round's stamp sits under", async () => {
    const text = await paint(snapshot({ runner }))
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const name = lines.findIndex((line) => line.trim() === "example.test/repo#main")
    const header = lines.findIndex((line) => line.includes("ISSUE / BRANCH"))
    expect(name).toBeGreaterThanOrEqual(0)
    expect(name).toBeLessThan(header)
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

  it("still leaves the runner's own marker crash-free while a run is active, and names the row it holds", async () => {
    const liveRow = row({
      state: "checked",
      live: { check: "typecheck", phase: "run", run: RUN_ID, since: NOW },
    })
    const runner = {
      journalDir: "/w/logs",
      service: BEATING,
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
          runOfChange(
            "task/twice",
            "2".repeat(40),
            "q-20260917T161500000Z-22222222",
            new Date(READ_AT.getTime() - 600_000),
          ),
          runOfChange(
            "task/twice",
            "2".repeat(40),
            "q-20260917T160000000Z-11111111",
            new Date(READ_AT.getTime() - 1_500_000),
          ),
        ],
      ],
    ]),
  }
}

/**
 * The table and everything under it, non-blank. The queue line above the header
 * names the last merge's branch, so a search for a row by its branch that began
 * at line 0 would find the summary and call it a row.
 */
function table(text: string): readonly string[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  return lines.slice(lines.findIndex((line) => line.includes("ISSUE / BRANCH")))
}

function flowSnapshot(over: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return snapshot({
    at: READ_AT,
    drafts: { unread: 0, window: "7d" },
    rows: [...watchRows(flowRows(), { journals: flowJournals() })],
    runner: {
      journalDir: "/w/logs",
      service: BEATING,
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
    const lines = table(text)
    const drafts = lines.findIndex((line) => line.includes("task/draft"))
    const waiting = lines.findIndex((line) => line.includes("task/late"))
    const runner = lines.findIndex((line) => line.includes("RUNNER"))
    const done = lines.findIndex((line) => line.includes("task/merged"))

    expect(drafts, text).toBeGreaterThanOrEqual(0)
    expect(waiting, text).toBeGreaterThan(drafts)
    expect(runner, text).toBeGreaterThan(waiting)
    expect(done, text).toBeGreaterThan(runner)
    // The whole bug: two runs checked this change, and the page is about changes.
    expect(
      lines.filter((line) => line.includes("task/twice")),
      text,
    ).toHaveLength(1)
  })

  it("puts the front of the line at the bottom of waiting, against the runner, and the newest done at the top of done", async () => {
    const text = await paint(flowSnapshot())
    const lines = table(text)
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
    const lines = table(text)
    const runner = lines.find((line) => line.includes("?") && line.includes("no runner status"))

    expect(runner, text).toBeDefined()
    expect(runner).toContain("?")
    expect(text).toContain("╭─ RUNNER")
    const header = lines.find((line) => line.includes("ISSUE / BRANCH"))
    expect(header).toContain("QUEUE")
    expect(header).toContain("RUN")
    expect(header).not.toContain("QUEUE / RUN")
  })

  it("ListingPage at 160 columns names the drafts count once (in QueueLine, drafts band rule is bare)", async () => {
    const text = await paint(
      flowSnapshot({
        drafts: { unread: 1, window: "7d" },
        rows: [
          ...watchRows(
            [
              ...flowRows(),
              change({
                at: new Date(READ_AT.getTime() - 60_000),
                author: "bob",
                branch: "task/draft2",
                head: "7".repeat(40),
                state: "draft",
              }),
            ],
            { journals: flowJournals() },
          ),
        ],
      }),
      160,
    )
    const occurrences = text.split("\n").filter((l) => l.includes("drafts (7d)"))
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]).toContain("waiting")
  })

  it("the top line says how many changes wait, what runs now and when the last merge landed (24196)", async () => {
    const ago = (minutes: number): Date => new Date(READ_AT.getTime() - minutes * 60_000)
    const rows = [
      change({
        branch: "task/live",
        head: "9".repeat(40),
        live: { check: "test", phase: "merge", run: "q-1", since: ago(2) },
        position: 1,
        since: ago(15),
      }),
      change({ branch: "task/next", head: "1".repeat(40), position: 2, since: ago(10) }),
      change({ at: ago(5), branch: "task/merged", endedAt: ago(5), head: "4".repeat(40), state: "merged" }),
    ]
    const text = await paint(flowSnapshot({ rows: rows.map((r) => ({ row: r })) }), 160)
    const queueLine = text.split("\n").find((l) => l.includes("waiting"))
    expect(queueLine).toBeDefined()
    expect(queueLine).toContain("1 waiting")
    expect(queueLine).toContain("checking task/live for 2:00")
    expect(queueLine).toMatch(/last merge \d\d:\d\d \(task\/merged\)/)
  })

  it("a paused runner shows its resume command in full, and a stuck row shows its reason in full at 80 and 120 columns (25348)", async () => {
    const snap = (cols: number) =>
      flowSnapshot({
        stopped: {
          since: READ_AT.toISOString(),
          by: "@chief",
          change: null,
          cause: "operator",
        },
        rows: [
          {
            row: row({
              branch: "task/incident",
              head: "1".repeat(40),
              state: "stuck",
              reason: "yrd-check-unresolved",
              since: READ_AT,
              at: READ_AT,
              submitter: "@dev/3",
              subject: "test incident",
            }),
          },
        ],
      })

    const text120 = await paint(snap(120), 120)
    expect(text120).toContain("resume: yrd queue resume")
    expect(text120).toContain("stuck=yrd-check-unresolved")

    const text80 = await paint(snap(80), 80)
    expect(text80).toContain("resume: yrd queue resume")
    expect(text80).toContain("stuck=yrd-check-unresolved")
  })
})

