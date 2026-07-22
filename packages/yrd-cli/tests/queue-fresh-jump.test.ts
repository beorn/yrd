// @failure A selected row anchors the ListView viewport, hiding newer runs behind a positional "N new" cue; cursor intent is also collapsed into one manual boolean.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import type { QueueWatchSnapshot } from "../src/watch-pane.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const BASE_SHA = "a".repeat(40)
const INTEGRATED_SHA = "b".repeat(40)
const CLOCK_ZERO = Date.parse("2026-07-13T08:00:00.000Z")

type FixtureItem = Readonly<{
  pr: ReturnType<typeof fixturePr>
  run: ReturnType<typeof fixtureRun>
}>

function clock(minutes: number): string {
  return new Date(CLOCK_ZERO + minutes * 60_000).toISOString()
}

function integratedItem(value: number): FixtureItem {
  const submittedAt = clock(value)
  const startedAt = clock(value + 1)
  const finishedAt = clock(value + 2)
  const runId = `R${value}`
  const headSha = String(value).at(-1)?.repeat(40) ?? "1".repeat(40)
  const pr = fixturePr(`PR${value}`, "integrated", submittedAt, `Settled ${value}`, {
    headSha,
    terminalRun: runId,
    integratedAt: finishedAt,
    integration: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
    revisions: [
      {
        revision: 1,
        headSha,
        base: "main",
        baseSha: BASE_SHA,
        pushedAt: submittedAt,
        submittedAt,
        terminal: { status: "integrated", at: finishedAt, run: runId },
      },
    ],
  })
  return {
    pr,
    run: fixtureRun(runId, [pr], "passed", startedAt, { finishedAt }),
  }
}

function runningItem(value: number, startedMinute: number): FixtureItem {
  const pr = fixturePr(`PR${value}`, "submitted", clock(startedMinute - 1), `Running ${value}`)
  return {
    pr,
    run: fixtureRun(`R${value}`, [pr], "running", clock(startedMinute)),
  }
}

function finishItem(item: FixtureItem, finishedMinute: number): FixtureItem {
  const finishedAt = clock(finishedMinute)
  const submittedAt = item.pr.submittedAt ?? clock(finishedMinute - 2)
  const runId = item.run.id
  const pr = fixturePr(item.pr.id, "integrated", submittedAt, item.pr.name ?? `Finished ${item.pr.id}`, {
    headSha: item.pr.headSha,
    terminalRun: runId,
    integratedAt: finishedAt,
    integration: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
    revisions: [
      {
        revision: item.pr.revision,
        headSha: item.pr.headSha,
        base: item.pr.base,
        baseSha: item.pr.baseSha,
        pushedAt: submittedAt,
        submittedAt,
        terminal: { status: "integrated", at: finishedAt, run: runId },
      },
    ],
  })
  return {
    pr,
    run: fixtureRun(runId, [pr], "passed", item.run.startedAt, { finishedAt }),
  }
}

function snapshot(items: readonly FixtureItem[], rowLimit = 80): QueueWatchSnapshot {
  return fixtureSnapshot(
    fixtureResult(
      items.map(({ pr }) => pr),
      items.map(({ run }) => run),
    ),
    { rowLimit },
  )
}

function rowIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((row) => row.includes(needle) && /^\s*\d{2}:\d{2}:\d{2}/u.test(row))
}

function clickRow(app: ReturnType<ReturnType<typeof createRenderer>>, needle: string): void {
  const rows = app.text.split("\n")
  const y = rowIndexOf(app.text, needle)
  const x = rows[y]?.indexOf(needle) ?? -1
  expect(y, `${needle} is visible in the timeline`).toBeGreaterThanOrEqual(0)
  expect(x, `${needle} has an on-screen column`).toBeGreaterThanOrEqual(0)
  app.click(x, y)
}

function detailTitle(text: string): string {
  return text.split("\n")[0] ?? ""
}

describe("QueueWatchFrame live-follow cursor contract", () => {
  it("keeps latest rows visible while a settled cursor stays on the same PR", async () => {
    const initialItems = Array.from({ length: 30 }, (_, index) => integratedItem(index + 1))
    const render = createRenderer({ cols: 200, rows: 22 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot(initialItems) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#25.1")
      await waitFor(() => detailTitle(app.text).includes("pr#25.1"))

      const nextItems = Array.from({ length: 50 }, (_, index) => integratedItem(index + 1))
      app.rerender(createElement(QueueWatchFrame, { snapshot: snapshot(nextItems) }))
      await app.waitForLayoutStable()

      expect(rowIndexOf(app.text, "pr#50.1"), "the newest row remains visible without input").toBeGreaterThanOrEqual(0)
      expect(detailTitle(app.text), "inserting rows above does not steal the settled selection").toContain("pr#25.1")
      expect(app.text).not.toMatch(/new runs?|G jumps/u)
    } finally {
      app.unmount()
    }
  })

  it("uses g to arm auto-follow-run without assigning the top row", async () => {
    const settled = Array.from({ length: 8 }, (_, index) => integratedItem(index + 1))
    const render = createRenderer({ cols: 200, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot(settled) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#5.1")
      await waitFor(() => detailTitle(app.text).includes("pr#5.1"))

      await app.press("g")
      await app.waitForLayoutStable()
      expect(detailTitle(app.text), "g never assigns the topmost settled row").toContain("pr#5.1")

      const live = runningItem(90, 90)
      app.rerender(createElement(QueueWatchFrame, { snapshot: snapshot([...settled, live]) }))
      await waitFor(() => detailTitle(app.text).includes("pr#90.1"))
    } finally {
      app.unmount()
    }
  })

  it("follows running work by run-start order, then holds when no run remains", async () => {
    const followed = runningItem(80, 80)
    const render = createRenderer({ cols: 200, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([followed]) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#80.1")
      await waitFor(() => detailTitle(app.text).includes("pr#80.1"))

      const laterStart = runningItem(82, 100)
      const nextByStart = runningItem(81, 90)
      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([finishItem(followed, 85), laterStart, nextByStart]),
        }),
      )
      await waitFor(() => detailTitle(app.text).includes("pr#81.1"))

      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([finishItem(followed, 85), finishItem(laterStart, 110), finishItem(nextByStart, 105)]),
        }),
      )
      await app.waitForLayoutStable()
      expect(detailTitle(app.text), "the last followed row is held when the queue becomes idle").toContain("pr#81.1")
    } finally {
      app.unmount()
    }
  })

  it("chooses the prior nearest surviving neighbor and reports a disappeared selection", async () => {
    const initial = [integratedItem(10), integratedItem(11), integratedItem(12)]
    const render = createRenderer({ cols: 200, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot(initial) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#11.1")
      await waitFor(() => detailTitle(app.text).includes("pr#11.1"))

      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([integratedItem(10), integratedItem(12), integratedItem(13)]),
        }),
      )
      await waitFor(() => detailTitle(app.text).includes("pr#12.1"))

      expect(detailTitle(app.text), "a missing middle row never falls through to newest row 0").not.toContain("pr#13.1")
      expect(app.text).toMatch(/selection moved.*pr#11\.1.*pr#12\.1/iu)
    } finally {
      app.unmount()
    }
  })
})
