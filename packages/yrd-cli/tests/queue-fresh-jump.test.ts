// @failure Live watch cursor identity and viewport position are conflated: new rows can stay hidden, missing identities silently fall to row 0, and g/G cannot navigate the action/top/bottom contract.
// @level l2
// @consumer @yrd/cli watch

import { createElement } from "react"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { currentChangeRev, parseChangeSelector } from "@yrd/bay"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import type { QueueWatchSnapshot } from "../src/watch-pane.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const BASE_SHA = "a".repeat(40)
const INTEGRATED_SHA = "b".repeat(40)
const CLOCK_ZERO = Date.parse("2026-07-13T08:00:00.000Z")

type FixtureItem = Readonly<{
  pr: ReturnType<typeof fixturePr>
  run?: ReturnType<typeof fixtureRun>
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

function queuedItem(value: number): FixtureItem {
  return {
    pr: fixturePr(`PR${value}`, "submitted", clock(value), `Queued ${value}`),
  }
}

function draftItem(value: number): FixtureItem {
  return {
    pr: fixturePr(`PR${value}`, "pushed", clock(value), `Draft ${value}`),
  }
}

function finishItem(item: FixtureItem, finishedMinute: number): FixtureItem {
  if (item.run === undefined) throw new Error(`cannot finish queued change '${item.pr.id}' without a run`)
  const finishedAt = clock(finishedMinute)
  const submittedAt = item.pr.submittedAt ?? clock(finishedMinute - 2)
  const runId = item.run.id
  const revision = currentChangeRev(item.pr)
  const pr = fixturePr(item.pr.id, "integrated", submittedAt, item.pr.name ?? `Finished ${item.pr.id}`, {
    headSha: revision.head,
    terminalRun: runId,
    integratedAt: finishedAt,
    integration: { commit: INTEGRATED_SHA, baseSha: BASE_SHA },
    revisions: [
      {
        revision: revision.n,
        headSha: revision.head,
        base: revision.base,
        baseSha: revision.baseSha,
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
      items.flatMap(({ run }) => (run === undefined ? [] : [run])),
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

/** The detail pane has no identity title row (operator ruling 2026-08-18,
 * item 23) — it names its change through the change-list bullet and the
 * member-box `pr#N.1 ⎇ branch` header. Scoped RIGHT of the split divider so
 * a list row's own id (or a `·` run continuation) can never masquerade. */
function detailShows(text: string, id: string): boolean {
  const rows = text.split("\n")
  const divider = (rows[1] ?? "").indexOf("│")
  return rows.some((row) => {
    const right = divider > 0 ? row.slice(divider) : row
    return right.includes(`· ${id}`) || right.includes(`${id} ⎇`)
  })
}

describe("QueueWatchFrame live-follow cursor contract", () => {
  it("follows the physical newest row until the operator moves the cursor", async () => {
    const render = createRenderer({ cols: 220, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([integratedItem(1), queuedItem(2)]) }))
    try {
      await waitFor(() => detailShows(app.text, "pr#2.1"))

      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([integratedItem(1), queuedItem(2), draftItem(3)]),
        }),
      )
      await waitFor(() => detailShows(app.text, "pr#3.1"))
    } finally {
      app.unmount()
    }
  })

  it("keeps latest rows visible while a settled cursor stays on the same PR", async () => {
    const initialItems = Array.from({ length: 30 }, (_, index) => integratedItem(index + 1))
    const render = createRenderer({ cols: 220, rows: 22 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot(initialItems) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#25.1")
      await waitFor(() => detailShows(app.text, "pr#25.1"))

      const nextItems = Array.from({ length: 50 }, (_, index) => integratedItem(index + 1))
      app.rerender(createElement(QueueWatchFrame, { snapshot: snapshot(nextItems) }))
      await app.waitForLayoutStable()

      expect(rowIndexOf(app.text, "pr#50.1"), "the newest row remains visible without input").toBeGreaterThanOrEqual(0)
      expect(detailShows(app.text, "pr#25.1"), "inserting rows above does not steal the settled selection").toBe(true)
      expect(app.text).not.toMatch(/new runs?|G jumps/u)
    } finally {
      app.unmount()
    }
  })

  it("cycles g between the running action position and absolute top", async () => {
    const top = draftItem(200)
    const followed = runningItem(80, 80)
    const next = runningItem(81, 90)
    const bottom = integratedItem(10)
    const render = createRenderer({ cols: 220, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([top, followed, next, bottom]) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#10.1")
      await waitFor(() => detailShows(app.text, "pr#10.1"))

      await app.press("g")
      await waitFor(() => detailShows(app.text, "pr#80.1"))

      await app.press("g")
      await waitFor(() => detailShows(app.text, "pr#200.1"))

      await app.press("g")
      await waitFor(() => detailShows(app.text, "pr#80.1"))
    } finally {
      app.unmount()
    }
  })

  it("uses the first queued row as the idle g action position", async () => {
    const top = draftItem(200)
    const firstQueued = queuedItem(70)
    const laterQueued = queuedItem(60)
    const bottom = integratedItem(10)
    const render = createRenderer({ cols: 220, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([top, firstQueued, laterQueued, bottom]) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#10.1")
      await waitFor(() => detailShows(app.text, "pr#10.1"))

      await app.press("g")
      await waitFor(() => detailShows(app.text, "pr#70.1"))

      await app.press("g")
      await waitFor(() => detailShows(app.text, "pr#200.1"))
    } finally {
      app.unmount()
    }
  })

  it("uses G for absolute bottom and keeps that manual selection fixed", async () => {
    const first = runningItem(10, 10)
    const bottom = runningItem(20, 20)
    const render = createRenderer({ cols: 220, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([first, bottom]) }))
    try {
      await app.waitForLayoutStable()
      await app.press("G")
      await waitFor(() => detailShows(app.text, "pr#20.1"))

      const live = runningItem(30, 30)
      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([first, finishItem(bottom, 25), live]),
        }),
      )
      await app.waitForLayoutStable()
      expect(detailShows(app.text, "pr#20.1"), "a manual bottom jump pauses live follow").toBe(true)
    } finally {
      app.unmount()
    }
  })

  it("follows running work by run-start order, then holds when no run remains", async () => {
    const followed = runningItem(80, 80)
    const render = createRenderer({ cols: 220, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([followed]) }))
    try {
      await waitFor(() => detailShows(app.text, "pr#80.1"))

      const laterStart = runningItem(82, 100)
      const nextByStart = runningItem(81, 90)
      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([finishItem(followed, 85), laterStart, nextByStart]),
        }),
      )
      await waitFor(() => detailShows(app.text, "pr#81.1"))

      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([finishItem(followed, 85), finishItem(laterStart, 110), finishItem(nextByStart, 105)]),
        }),
      )
      await app.waitForLayoutStable()
      expect(detailShows(app.text, "pr#81.1"), "the last followed row is held when the queue becomes idle").toBe(true)
    } finally {
      app.unmount()
    }
  })

  it("chooses the prior nearest surviving neighbor and reports a disappeared selection", async () => {
    const initial = [integratedItem(10), integratedItem(11), integratedItem(12)]
    const render = createRenderer({ cols: 220, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot(initial) }))
    try {
      await app.waitForLayoutStable()
      clickRow(app, "pr#11.1")
      await waitFor(() => detailShows(app.text, "pr#11.1"))

      app.rerender(
        createElement(QueueWatchFrame, {
          snapshot: snapshot([integratedItem(10), integratedItem(12), integratedItem(13)]),
        }),
      )
      await waitFor(() => detailShows(app.text, "pr#12.1"))

      expect(detailShows(app.text, "pr#13.1"), "a missing middle row never falls through to newest row 0").toBe(false)
      const notice = app.text.match(/selection moved.*pr#11\.1.*pr#12\.1/iu)?.[0]
      expect(notice).toBeDefined()
      expect(notice?.match(/pr#[a-z0-9_-]+\.\d+/giu)?.map((token) => parseChangeSelector(token))).toEqual([
        { pr: "PR11", revision: 1 },
        { pr: "PR12", revision: 1 },
      ])
    } finally {
      app.unmount()
    }
  })

  it("documents g and G in the watch help overlay", async () => {
    const render = createRenderer({ cols: 120, rows: 30 })
    const app = render(createElement(QueueWatchFrame, { snapshot: snapshot([integratedItem(2), queuedItem(1)]) }))
    try {
      await app.waitForLayoutStable()
      await app.press("?")
      await app.waitForLayoutStable()

      const helpText = app.text.replace(/\s+/gu, " ")
      expect(helpText).toMatch(/Watch keys/iu)
      expect(helpText).toMatch(/g action position.*absolute top/iu)
      expect(helpText).toMatch(/G absolute bottom/u)
    } finally {
      app.unmount()
    }
  })
})
