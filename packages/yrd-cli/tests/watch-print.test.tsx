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
import type { Row } from "@yrd/queue-core"
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
  return {
    at: NOW,
    queue: "example.test/repo#main",
    queues: [{ branch: "main", label: "main", path: "/repo" }],
    rows: [{ row: row() }],
    ...over,
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
    expect(text).toContain("checked")
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
