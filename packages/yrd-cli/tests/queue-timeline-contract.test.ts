// @failure Queue list drifts from the user-settled 21106 presentation contract
// @level l2
// @consumer @yrd/cli

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { renderString } from "silvery"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseChangeSelector } from "@yrd/bay"
import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import { FAILURE_SLUGS } from "../src/failure-slug.ts"
import {
  formatQueueChangeId,
  QueueRecoveryView,
  QueueTimelineView,
  ChangeDetailView,
  queueTimelineAdmissionTimes,
  queueTimelineDefaultCursorId,
  queueTimelineDisplayRows,
  queueTimelineProjection,
  ChangeDetailData,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { QueueWatchFrame } from "../src/watch-pane.tsx"

const contractProjection = (): QueueTimelineProjection => {
  const projection = queueTimelineStories["contract-overview"].snapshot.projection
  if (projection === undefined) throw new Error("contract-overview is missing its projection")
  return projection
}

async function renderTimeline(
  projection: QueueTimelineProjection,
  width: number,
  runnerRefusal?: Readonly<{ code: string; message: string; run?: string; step?: string }>,
): Promise<string[]> {
  const rendered = await renderString(createElement(QueueTimelineView, { projection, columns: width, runnerRefusal }), {
    width,
    height: 45,
    plain: true,
  })
  return rendered.split("\n")
}

function rowIndex(rows: readonly string[], needle: string): number {
  const index = rows.findIndex((row) => row.includes(needle))
  if (index < 0) throw new Error(`expected a rendered row containing '${needle}'`)
  return index
}

/** The detail pane names its change through the change LIST bullet under the
 * status box (`· pr#12.1 …`) and each member box's `pr#12.1 ⎇ branch` header
 * — the identity title row is gone (operator ruling 2026-08-18, item 23). */
function detailShows(text: string, id: string): boolean {
  return text.split("\n").some((row) => row.includes(`· ${id}`) || row.includes(`${id} ⎇`))
}

describe("queue timeline 21106 contract", () => {
  // Queue clocks render in the system-local timezone; pin the suite to a
  // deterministic DST-free offset (+5:30) like the CLI suite does.
  let priorTZ: string | undefined
  beforeAll(() => {
    priorTZ = process.env.TZ
    process.env.TZ = "Asia/Kolkata"
  })
  afterAll(() => {
    if (priorTZ === undefined) delete process.env.TZ
    else process.env.TZ = priorTZ
  })

  it("renders one calendar STATS panel after the list", async () => {
    const rows = (await renderTimeline(contractProjection(), 120)).map((row) => row.trimEnd())
    const frame = rows.join("\n")
    const pillsLine = rows.findIndex((row) => /open.*running.*done.*failed/u.test(row))
    const statsLine = rowIndex(rows, "╭─ STATS ")

    expect(statsLine).toBeGreaterThan(pillsLine)
    expect(rows[statsLine]?.length).toBe(120)
    expect(frame).not.toContain("╭─ FLOW ")
    expect(frame).not.toContain("╭─ TIME ")
    for (const cell of [
      "RUNS",
      "ALL",
      "MERGED",
      "DUP",
      "PASS",
      "FAILS",
      "AVG TIME",
      "TOTAL",
      "QUEUING",
      "RUNNING",
      "RETRIES/RUN",
      "TODAY",
      "YSTRDAY",
      "WEEK",
      "MONTH",
    ]) {
      expect(frame).toContain(cell)
    }
    expect(frame).not.toContain("CODING")
  })

  it("renders resident health in RUNNER with the queue-pause STATUS line folded inside it", async () => {
    const normal = (await renderTimeline(contractProjection(), 120)).join("\n")
    expect(normal).toContain("╭─ RUNNER ")
    expect(normal).not.toContain("╭─ STATUS ")
    expect(normal).toContain("[84042]")

    // The separate STATUS box is gone (user directive 2026-07-21): a paused
    // queue's HOLD THE LINE line now renders INSIDE the one RUNNER box.
    const paused = queueTimelineStories.paused.snapshot.projection
    if (paused === undefined) throw new Error("paused story is missing its projection")
    const exceptional = (await renderTimeline(paused, 120)).join("\n")
    expect(exceptional).not.toContain("╭─ STATUS ")
    expect(exceptional.match(/╭─ RUNNER /gu)).toHaveLength(1)
    expect(exceptional).toContain("HOLD THE LINE")
    expect(exceptional).toContain("NO RUNNER")

    const stale = {
      ...contractProjection(),
      runner: { pid: 84042, startedAt: "2026-07-13T11:00:00.000Z", lastTickAt: "2026-07-13T11:00:00.000Z" },
    }
    const staleFrame = (await renderTimeline(stale, 120)).join("\n")
    expect(staleFrame).not.toContain("╭─ STATUS ")
    expect(staleFrame.match(/╭─ RUNNER /gu)).toHaveLength(1)
    expect(staleFrame).toContain("[84042]")
    expect(staleFrame).toContain("RUNNER STALE — last tick 1:00:00 ago")
  })

  it("distinguishes a missing runner process from a stale-step contract refusal", async () => {
    const refused = {
      ...contractProjection(),
      runner: null,
    }
    const frame = (
      await renderTimeline(refused, 120, {
        code: "step-revision-drift",
        message: "queue run 'R2670' requires step 'check' revision 'v1', installed 'v2'",
        run: "R2670",
        step: "check",
      })
    ).join("\n")

    expect(frame).toContain("NO RUNNER - runner stopped: stale step contract on R2670")
    expect(frame).toContain(
      "step-revision-drift: queue run 'R2670' requires step 'check' revision 'v1', installed 'v2'",
    )
    expect(frame).not.toContain("NO RUNNER - no drained run in window")
  })

  it("keeps the queue frame visible while naming a read boundary that could not settle", async () => {
    const snapshot = queueTimelineStories["contract-overview"].snapshot
    const render = createRenderer({ cols: 120, rows: 45 })
    const app = render(
      createElement(QueueWatchFrame, {
        snapshot: {
          ...snapshot,
          readFailure: {
            code: "queue-read-boundary-moved",
            readCursor: 25255,
            journalCursor: 25256,
            showing: "last-complete",
          },
        },
      }),
    )
    try {
      await app.waitForLayoutStable()
      expect(app.text, "the last complete queue remains mounted").toContain("RUNNER")
      expect(app.text).toContain("queue changed while reading")
      expect(app.text).toContain("showing last complete snapshot; retrying")
    } finally {
      app.unmount()
    }
  })

  it("does not call recovery idle while audit still names a blocking run", async () => {
    const frame = await renderString(
      createElement(QueueRecoveryView, {
        runs: [],
        blocked: [],
        findings: [
          {
            code: "step-revision-drift",
            message: "queue run 'R2670' requires step 'merge' revision 'v1', installed 'v2'",
            run: "R2670",
            step: "merge",
          },
        ],
      }),
      { width: 120, plain: true },
    )

    expect(frame).not.toContain("Queue idle")
    expect(frame).toContain("R2670")
    expect(frame).toContain("step-revision-drift")
    expect(frame).toContain("requires step 'merge' revision 'v1', installed 'v2'")
  })

  it("projects each draft and run occurrence with composite cursor identity", () => {
    const projection = contractProjection()
    expect(projection.rows.map((row) => [row.group, row.status, row.run ?? row.pr, row.pr, row.revision])).toEqual([
      ["draft", "rev", "PR5", "PR5", 1],
      ["pending", "ready", "PR1", "PR1", 1],
      ["running", "running", "R42", "PR42", 1],
      ["running", "running", "R42", "PR43", 1],
      ["completed", "rejected", "R5", "PR5", 1],
      ["completed", "integrated", "R4", "PR4", 1],
    ])
    expect(projection.rows[0]?.id.startsWith("main:draft:PR5:1:")).toBe(true)
    expect(projection.rows[1]?.id.startsWith("main:pr:PR1:1:")).toBe(true)
    expect(projection.rows.slice(2).map((row) => row.id)).toEqual([
      "main:run:R42:PR42:1",
      "main:run:R42:PR43:1",
      "main:run:R5:PR5:1",
      "main:run:R4:PR4:1",
    ])
    expect(projection.rows.map((row) => row.candidateId)).toEqual([undefined, undefined, "C42", "C42", "C5", "C4"])

    const minute = 60_000
    // Batched members repeat the Run facts (step, total) while AGE and queue
    // wait stay member facts.
    expect(projection.rows.map((row) => row.step)).toEqual([
      undefined,
      undefined,
      "2:check",
      "2:check",
      undefined,
      undefined,
    ])
    expect(projection.rows.map((row) => row.totalMs)).toEqual([
      null,
      null,
      20 * minute,
      20 * minute,
      12 * minute,
      15 * minute,
    ])
    expect(projection.rows.map((row) => row.ageMs)).toEqual([
      75 * minute,
      50 * minute,
      36 * minute,
      34 * minute,
      27 * minute,
      25 * minute,
    ])
    expect(projection.rows.map((row) => row.glyph)).toEqual(["×", "○", "◉", "◉", "×", "✓"])
    // BY: the submitter of each exact PR revision, lossless in JSON.
    expect(projection.rows.map((row) => row.submitter)).toEqual([
      "@agent/2",
      "@cto",
      "@agent/3",
      "@agent/5",
      "@agent/2",
      "@agent/7",
    ])
    // RUNNER: probed lease liveness rides the projection and its dedicated box.
    expect(projection.runner).toEqual({
      pid: 84042,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:58.000Z",
      queueProgress: { state: "healthy", observedAt: "2026-07-13T11:59:58.000Z" },
    })
    expect(projection.rows[2]?.headSha).toBe("c".repeat(40))
    expect(projection.rows.map((row) => row.subject)).toEqual([
      "Reject broken payload",
      "Prepare release notes",
      "Align host navigation keybindings without disturbing internal pane controls",
      "Carry the production split-pane contract into the queue detail surface",
      "Reject broken payload",
      "Land the durable patch",
    ])

    // Detail and flow metrics stay per-Run even though the list denormalizes.
    expect(projection.details.map((detail) => detail.run)).toEqual(["R42", "R5", "R4"])
    expect(projection.metrics.terminalAttempts).toBe(2)
    expect(projection.metrics.queueWait.n).toBe(2)
  })

  it("renders the information groups in order with RUNNER but no STATUS when normal", async () => {
    const rows = (await renderTimeline(contractProjection(), 120)).map((row) => row.trimEnd())
    const queueLine = rowIndex(rows, "YRD QUEUES")
    const updatedLine = rowIndex(rows, "updated 17:30:00")
    const headerLine = rowIndex(rows, "TIME")
    const lastRowLine = rowIndex(rows, "pr#4.1")
    // Item 2 (deliberate contract change): the pills row moved from ABOVE the
    // header to BELOW the list — new order updated → header → rows → pills →
    // the STATS frame.
    const pillsLine = rows.findIndex((row) => /open.*running.*done.*failed/u.test(row))
    const statsBoxLine = rowIndex(rows, "╭─ STATS ")

    expect(queueLine).toBeLessThan(updatedLine)
    expect(updatedLine).toBeLessThan(headerLine)
    expect(headerLine).toBeLessThan(lastRowLine)
    expect(lastRowLine).toBeLessThan(pillsLine)
    expect(pillsLine).toBeLessThan(statsBoxLine)

    // The status box is omitted when the queue is normal.
    expect(rows.join("\n")).not.toContain("HOLD THE LINE")
    // ACTIVE/WAIT moved out of the per-row columns into the statistics box.
    const header = rows[headerLine]
    if (header === undefined) throw new Error("expected the table header row")
    expect(header.trim()).toMatch(/^TIME\s+STATUS\s+RUN\s+CHANGES\s+BY\s+AGE\s+RUN$/u)
    expect(header).not.toContain("ACTIVE")
    expect(header).not.toContain("WAIT")
    expect(header).not.toContain("SUBJECT")
    expect(header).not.toContain("DETAIL")
    expect(header).not.toContain("TOTAL")
    expect(header).toContain("STATUS")
    // RUNNER is always visible; STATUS is reserved for actionable queue pause.
    expect(rows.join("\n")).toContain("╭─ RUNNER ")
    expect(rows.join("\n")).not.toContain("╭─ STATUS ")
    expect(rows.join("\n")).toContain("[84042]")
    expect(rows.join("\n")).not.toContain("NO RUNNER")
    expect(rows.join("\n")).not.toContain("RUNNER STALE")
    expect(rows.join("\n")).not.toContain("oldest open")
    // One STATS frame carries the fixed calendar columns and metric hierarchy.
    const statisticsText = rows.slice(statsBoxLine).join("\n")
    for (const cell of [
      "RUNS",
      "ALL",
      "MERGED",
      "DUP",
      "PASS",
      "FAILS",
      "AVG TIME",
      "TOTAL",
      "QUEUING",
      "RUNNING",
      "RETRIES/RUN",
    ]) {
      expect(statisticsText).toContain(cell)
    }
    expect(statisticsText).not.toContain("CODING")
    for (const window of ["TODAY", "YSTRDAY", "WEEK", "MONTH"]) {
      expect(statisticsText).toContain(window)
    }
  })

  it("renders the user-settled row contract at 160 columns", async () => {
    const projection = contractProjection()
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "pr#1.1")]
    const lead = rows[rowIndex(rows, "pr#42.1")]
    const partner = rows[rowIndex(rows, "pr#43.1")]
    const revised = rows[rowIndex(rows, "pr#5.1")]
    const rejected = rows[rowIndex(rows, " failed ")]
    const integrated = rows[rowIndex(rows, "pr#4.1")]

    // Row contract under the ratified display model (operator rulings
    // 2026-08-18, items 28/38): the CHANGES cell is `pr#id.rev <title>` —
    // never the branch — with the live step / failure code as its
    // parenthesized suffix; the RUN cell is `label#N <glyph>` with the label
    // ELIDED here (one visible queue), an em-dash pre-run, and a muted `·`
    // continuation on a batch member behind its lead; BY stays left-aligned
    // and the run duration is a bare dimmed time.
    expect(pending?.trim()).toMatch(/^16:40:00 ○ ready\s+—\s+pr#1\.1 Prepare release notes\s+@cto\s+50:00$/u)
    expect(lead?.trim()).toMatch(
      /^17:10:00 ◉ checking\s+#42 ◉\s+pr#42\.1 Align host navigation.*\(2:check\)\s+@agent\/3\s+36:00 20:00$/u,
    )
    // The convoy PARTNER keeps its own TIME/STATUS (a landed member and a
    // never-attempted PR must never print the same row of dashes —
    // @i/10-merge-queue/22925); the shared run id renders once, the partner
    // carrying the `·` membership continuation (item 38).
    expect(partner?.trim()).toMatch(
      /^17:10:00 ◉ checking\s+·\s+pr#43\.1 Carry the production.*\(2:check\)\s+@agent\/5\s+34:00 20:00$/u,
    )
    expect(revised?.trim()).toMatch(/^16:15:00 × rev\s+—\s+pr#5\.1 Reject broken payload\s+@agent\/2\s+1:15:00$/u)
    expect(rejected?.trim()).toMatch(
      /^16:42:00 × failed\s+#5 ×\s+pr#5\.1 Reject broken payload \(err=typecheck-failed\)\s+@agent\/2\s+27:00 12:00$/u,
    )
    expect(integrated?.trim()).toMatch(
      /^16:25:00 ✓ merged\s+#4 ✓\s+pr#4\.1 Land the durable patch\s+@agent\/7\s+25:00 15:00$/u,
    )

    // No row carries the removed clock glyph; a not-yet-started run shows the
    // muted em-dash in the RUN cell, never a run id or duration.
    for (const row of [revised, pending, lead, partner, rejected, integrated]) expect(row).not.toContain("◷")
    expect(pending).not.toContain("#1 ")
  })

  it("places the change title directly after the PR identity, branch and issue omitted", async () => {
    // Item 28: the CHANGES cell is id then TITLE — the branch lives only in
    // the detail pane's per-change box header, and the issue in its metadata.
    const rows = (await renderTimeline(contractProjection(), 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "pr#1.1")]
    const running = rows[rowIndex(rows, "pr#42.1")]

    expect(pending).toContain("pr#1.1 Prepare release notes")
    expect(running).toContain("pr#42.1 Align host navigation")
    expect(pending).not.toContain("@yrd/core/21120-pr-state-notifications")
    expect(running).not.toContain("@hab/super/21135-herdr-keybindings")
    expect(pending).not.toContain(" for ")
    expect(running).not.toContain(" for ")
  })

  it("keys the RUN label by base as well as run id when several queues are visible", async () => {
    const source = contractProjection()
    const lead = source.rows.find((row) => row.pr === "PR42")
    const partner = source.rows.find((row) => row.pr === "PR43")
    if (lead === undefined || partner === undefined) {
      throw new Error("contract fixture is missing the active batched run")
    }
    const projection = {
      ...source,
      queues: [
        { label: 1, base: "main", address: "main" },
        { label: 2, base: "release", address: "release" },
      ],
      rows: [lead, { ...partner, id: `release:${partner.id}`, base: "release" }],
      display: { ...source.display, shown: 2, hidden: 0 },
    }
    const app = createRenderer({ cols: 160, rows: 30 })(
      createElement(QueueTimelineView, { projection, columns: 160, nav: true, cursorKey: 0 }),
    )
    try {
      await app.waitForLayoutStable()
      const rows = app.text.split("\n")
      // Two visible queues: the label spells (items 34/38) — `main#42` and
      // `release#42` are DIFFERENT runs in different journals, which is the
      // collision the pair identity exists to remove. Same-numbered runs on
      // different bases never fold into a `·` continuation.
      const leadY = rowIndex(rows, "main#42")
      const partnerY = rowIndex(rows, "release#42")
      expect(leadY).not.toBe(partnerY)
      expect(rows[leadY]).toContain("pr#42.1 Align host navigation")
      expect(rows[partnerY]).toContain("pr#43.1 Carry the production")
    } finally {
      app.unmount()
    }
  })

  it("uses distinct semantic queue glyphs on every status", async () => {
    const rows = (await renderTimeline(contractProjection(), 160)).map((row) => row.trimEnd())
    const pending = rows[rowIndex(rows, "pr#1.1")]
    const running = rows[rowIndex(rows, "pr#42.1")]
    const revised = rows[rowIndex(rows, "pr#5.1")]
    const rejected = rows[rowIndex(rows, " failed ")]
    const integrated = rows[rowIndex(rows, "pr#4.1")]

    expect(pending).toContain("○ ready")
    expect(running).toContain("◉ checking")
    expect(revised).toContain("× rev")
    expect(rejected).toContain("× failed")
    expect(integrated).toContain("✓ merged")
    // The branch left the list entirely (item 28) — its `task/` prefix noise
    // went with it; the detail pane's box header owns the branch now.
    for (const row of [revised, pending, running, rejected, integrated]) expect(row).not.toContain("task/")

    const production = queueTimelineStories["production-overview"].snapshot.projection
    if (production === undefined) throw new Error("production-overview is missing its projection")
    const productionRows = (await renderTimeline(production, 160)).map((row) => row.trimEnd())
    const environment = productionRows[rowIndex(productionRows, "pr#6.1")]
    expect(environment).toContain("× env")
    expect(environment).toContain("(err=queue-env)")
  })

  it("folds a consecutive same-PR outcome storm to one selectable row and expands it on select", async () => {
    const story = queueTimelineStories["production-overview"]
    const projection = story.snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const environment = projection.rows.find((row) => row.pr === "PR6")
    if (environment?.timestampMs === undefined || environment.timestampMs === null) {
      throw new Error("production-overview is missing its environment-refused row")
    }
    const environmentTimestampMs = environment.timestampMs
    const stormRows = Array.from({ length: 21 }, (_, index) => {
      const timestampMs = environmentTimestampMs - index * 30_000
      return {
        ...environment,
        id: `main:run:R${909 - index}:PR6:1`,
        run: `R${909 - index}`,
        timestampMs,
        timestamp: new Date(timestampMs).toISOString(),
      }
    })
    const stormProjection = {
      ...projection,
      rows: stormRows,
      display: { limit: 5, shown: 5, hidden: stormRows.length - 5 },
      details: [],
    }
    const oneShot = (await renderTimeline(stormProjection, 200)).join("\n")
    expect(oneShot.match(/pr#6\.1/gu)).toHaveLength(1)
    expect(oneShot).toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)
    expect(oneShot).not.toContain("... 16 more")

    const render = createRenderer({ cols: 200, rows: 117 })
    const app = render(
      createElement(QueueWatchFrame, {
        snapshot: { ...story.snapshot, projection: stormProjection },
      }),
    )
    try {
      await app.waitForLayoutStable()
      await app.press("Escape")
      await app.waitForLayoutStable()
      const stormVisibleRows = () =>
        app.text.split("\n").filter((row) => /^\s*\d{2}:\d{2}:\d{2} × env\b/u.test(row) && row.includes("pr#6.1"))
      expect(stormVisibleRows()).toHaveLength(1)
      expect(app.text).toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)

      await app.press("Enter")
      await app.waitForLayoutStable()
      expect(stormVisibleRows()).toHaveLength(21)
      expect(app.text).not.toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)

      await app.press("Enter")
      await app.waitForLayoutStable()
      expect(stormVisibleRows()).toHaveLength(1)
      expect(app.text).toMatch(/×21 · \d{2}:\d{2}–\d{2}:\d{2}/u)
    } finally {
      app.unmount()
    }
  })

  it("expands only the selected occurrence when matching storms are separated", () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const environment = projection.rows.find((row) => row.pr === "PR6")
    const separator = projection.rows.find((row) => row.pr !== "PR6" && row.group === "completed")
    if (environment === undefined || separator === undefined) {
      throw new Error("production-overview fixtures are incomplete")
    }
    const row = (id: string) => ({ ...environment, id, run: id })
    const source = [row("A-new"), row("A-old"), separator, row("B-new"), row("B-old")]
    const folded = queueTimelineDisplayRows(source)
    const firstKey = folded[0]?.repeat?.key

    expect(folded.map((entry) => entry.id)).toEqual(["A-new", separator.id, "B-new"])
    expect(firstKey).toBeDefined()
    expect(folded[0]?.repeat?.key).not.toEqual(folded[2]?.repeat?.key)
    const expanded = queueTimelineDisplayRows(source, new Set([firstKey!]))
    expect(expanded.map((entry) => entry.id)).toEqual(["A-new", "A-old", separator.id, "B-new"])
    expect(expanded[3]?.repeat?.collapsed).toBe(true)
  })

  it("keeps the full run number and fixed fields intact at 80 columns", async () => {
    const rows = (await renderTimeline(contractProjection(), 80)).map((row) => row.trimEnd())
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(80)
    const lead = rows[rowIndex(rows, "pr#42.1")]
    expect(lead).toContain("#42")
    expect(lead).toContain("Align host naviga")
    expect(lead).not.toContain(" for ")
    expect(lead).toContain("36:00")
    expect(lead).toContain("20:00")
    expect(lead).not.toContain("◷")
    // The BY column is the first casualty on narrow tiers — dropped before
    // any identity, clock, or measurement column.
    expect(lead?.trimStart().startsWith("17:10:00 ◉ checking")).toBe(true)
    expect(lead).not.toContain("@agent/3")
    expect(rows.some((row) => row.includes("BY"))).toBe(false)
    const rejected = rows[rowIndex(rows, " failed ")]
    expect(rejected).toContain("typecheck-failed")
    expect(rejected).toContain("12:00")
    expect(rejected).not.toContain("◷")
  })

  it("pins the 15d semantic colors on markers, states, and identity cells", async () => {
    const render = createRenderer({ cols: 160, rows: 45 })
    const styled = render(createElement(QueueTimelineView, { projection: contractProjection(), columns: 160 }))
    try {
      await styled.waitForLayoutStable()
      const frame = styled.text.split("\n")
      const cell = (needle: string, anchor: string) => {
        const row = frame.findIndex((text) => text.includes(anchor))
        if (row < 0) throw new Error(`missing rendered row for '${anchor}'`)
        const column = frame[row]?.indexOf(needle) ?? -1
        if (column < 0) throw new Error(`missing '${needle}' in the '${anchor}' row`)
        return styled.cell(column, row)
      }
      // Item 9: a not-yet-started run shows a muted "-", not a blue "pending"
      // run id — the blue (info) reference is now the running km task glyph.
      const runningMarker = cell("◉", "pr#42.1").fg
      const successMarker = cell("✓", "pr#4.1").fg
      const successText = cell("merged", "pr#4.1").fg
      const failureText = cell("typecheck-failed", "err=typecheck-failed").fg
      const mutedTime = cell("16:40:00", "pr#1.1").fg
      const mutedAge = cell("50:00", "pr#1.1").fg

      for (const pinned of [runningMarker, successMarker, successText, failureText, mutedTime, mutedAge]) {
        expect(pinned).not.toBeNull()
      }
      // GREEN success marker + semantic success text (15d re-rule).
      expect(successMarker).toEqual(successText)
      expect(successMarker).not.toEqual(runningMarker)
      expect(successMarker).not.toEqual(mutedTime)
      // Failure code keeps its own semantic foreground.
      expect(failureText).not.toEqual(successMarker)
      expect(failureText).not.toEqual(runningMarker)
      expect(failureText).not.toEqual(mutedTime)
      // TIME and AGE share the muted foreground.
      expect(mutedTime).toEqual(mutedAge)
      expect(mutedTime).not.toEqual(runningMarker)
    } finally {
      styled.unmount()
    }
  })

  it("renders the list left-flush with the 160-cell cap and no dead gutter", async () => {
    const wide = await renderTimeline(contractProjection(), 200)
    // The STATS row fills the full capped width with no dead gutter.
    const wideBorder = wide[rowIndex(wide, "╭─ STATS ")]
    if (wideBorder === undefined) throw new Error("expected the statistics border row")
    expect(wideBorder.startsWith("╭─ STATS ")).toBe(true)
    expect(wideBorder.trimEnd().length).toBe(160)
    for (const row of wide) expect(Array.from(row.trimEnd()).length).toBeLessThanOrEqual(160)
    // Left-anchored surfaces start at column 0; only right-aligned facts
    // (the updated clock, the bucket checkboxes) carry leading padding. Box
    // borders anchor at column 0 with their rounded corner glyph.
    for (const anchor of ["16:40:00 ○ ready", "╭─ STATS"]) {
      expect(wide[rowIndex(wide, anchor)]?.startsWith(anchor.slice(0, 1)), anchor).toBe(true)
    }
    // The `YRD QUEUES` title is the one deliberate exception (operator,
    // 2026-08-19): it carries a single leading column, as the heading it
    // replaced did. Asserted exactly, so neither a second space nor a
    // regression back to flush passes silently.
    expect(wide[rowIndex(wide, "YRD QUEUES")]?.indexOf("YRD QUEUES")).toBe(1)
    expect(wide[rowIndex(wide, "TIME")]?.indexOf("TIME")).toBe(0)

    const narrow = await renderTimeline(contractProjection(), 100)
    const narrowBorder = narrow[rowIndex(narrow, "╭─ STATS ")]
    if (narrowBorder === undefined) throw new Error("expected the statistics border row")
    expect(narrowBorder.startsWith("╭─ STATS ")).toBe(true)
    expect(narrowBorder.trimEnd().length).toBe(100)
  })

  it("contains long raw JSON output inside the detail side of the split divider", async () => {
    const story = queueTimelineStories["production-overview"]
    const sentinel = `JSON_EDGE_SENTINEL ${JSON.stringify({ payload: "¤".repeat(800) })}`
    const snapshot = {
      ...story.snapshot,
      outputs: [
        {
          source: "recorded" as const,
          run: "R42",
          step: "check",
          attempt: 2,
          path: "/repo/.git/yrd/artifacts/R42/1-check/attempt-2/raw.json",
          text: sentinel,
        },
      ],
    }
    // Side-by-side starts at LIST_NATURAL_WIDTH + divider + DETAIL_NATURAL_WIDTH
    // = 213. 200 is a below-split and has no vertical divider.
    const render = createRenderer({ cols: 220, rows: 50 })
    const app = render(createElement(QueueWatchFrame, { snapshot }))
    try {
      await app.waitForLayoutStable()
      // The detail defaults to the live `check` step (user directive 2026-07-21:
      // tab selection follows the running step, and the synthetic `0: submit`
      // tab is gone), so R42's recorded check output — the sentinel — is visible
      // without navigating tabs.
      const rows = app.text.split("\n")
      // Row 0 is the watch pane's own top line (item 12, always present) and
      // carries no divider; the SplitPane content starts one row lower.
      const divider = rows[1]?.indexOf("│") ?? -1
      expect(divider).toBeGreaterThan(0)
      const sentinelRows = rows.filter((row) => row.includes("JSON_EDGE_SENTINEL"))
      expect(sentinelRows).toHaveLength(1)
      for (const row of sentinelRows) {
        expect(row.indexOf("JSON_EDGE_SENTINEL")).toBeGreaterThan(divider)
        expect(row.slice(0, divider)).not.toContain("JSON_EDGE_SENTINEL")
        expect(Array.from(row).length).toBeLessThanOrEqual(220)
      }
      // Log rows render ONE terminal row each (21684 truncation contract) — the
      // long payload occupies exactly its own row, clipped at the pane edge; the
      // full-log link carries overflow. The load-bearing assertions stay: the
      // sentinel and payload never bleed left of the divider.
      const payloadRows = rows.filter((row) => row.includes("¤"))
      expect(payloadRows.length, app.text).toBe(1)
      for (const row of rows) expect(row.slice(0, divider)).not.toContain("¤")
    } finally {
      app.unmount()
    }
  })

  it("attaches the right-aligned pills row directly below the list (item 2)", async () => {
    for (const width of [120, 200]) {
      const rows = await renderTimeline(contractProjection(), width)
      const headerLine = rowIndex(rows, "TIME")
      const pillsLine = rows.findIndex((row) => /open.*running.*done.*failed/u.test(row))
      // Item 2: the pills row renders BELOW the list, not above the header.
      expect(pillsLine, `width ${width}`).toBeGreaterThan(headerLine)
      const filter = rows[pillsLine]
      if (filter === undefined) throw new Error("expected the pills row")
      // Item 3: no "FILTER" label, no [t] brackets; the `since=` dimension
      // survives and the pills are plain words (pending reads `open`, user
      // directive 2026-07-21). Right-aligned to the cap.
      expect(filter).not.toContain("FILTER")
      expect(filter).not.toMatch(/\[[trfd]\]/u)
      // The bottom row keeps ONLY the status pills, right-aligned (operator
      // ruling 2026-08-18, item 32); `all` rides the top line's pill group.
      expect(filter.trim()).toContain("since=6:00:00 open running done failed")
      expect(filter).not.toContain("all ")
      expect(filter.trimEnd().length, `width ${width}`).toBe(Math.min(width, 160))
    }
  })

  it("folds the paused hold line inside the one RUNNER box with foreground-only styling", async () => {
    const projection = queueTimelineStories.paused.snapshot.projection
    if (projection === undefined) throw new Error("paused story is missing its projection")
    const rows = await renderTimeline(projection, 120)
    const statusLine = rowIndex(rows, "HOLD THE LINE")
    // The pause rail lives INSIDE the one RUNNER box (user directive
    // 2026-07-21): the state, the reason, and the allow-list ride the same row,
    // and there is no separate `╭─ STATUS` border box. The row no longer
    // carries the word STATUS at all — that belongs to the column (21479).
    expect(rows.join("\n")).not.toContain("╭─ STATUS ")
    expect(rows[statusLine]).not.toContain("STATUS")
    expect(rows[statusLine]).toContain("operator freeze")
    expect(rows[statusLine]).toContain("allowed PR2")
    // The RUNNER box frames it: `╭─ RUNNER ` opens above and `╰` closes below.
    const runnerTop = rowIndex(rows, "╭─ RUNNER ")
    expect(runnerTop).toBeLessThan(statusLine)
    const runnerBottom = rows.findIndex((row, index) => index > statusLine && row.includes("╰"))
    expect(runnerBottom, "the RUNNER box closes below the pause line").toBeGreaterThan(statusLine)
    // It still renders between the metadata clock and the pills row.
    expect(rowIndex(rows, "updated 17:30:00")).toBeLessThan(statusLine)
    const pillsAt = rows.findIndex((row) => /open.*running.*done.*failed/u.test(row))
    expect(statusLine, "the RUNNER box sits above the pills row").toBeLessThan(pillsAt)

    const render = createRenderer({ cols: 120, rows: 45 })
    const styled = render(createElement(QueueTimelineView, { projection, columns: 120 }))
    try {
      await styled.waitForLayoutStable()
      const row = styled.text.split("\n").findIndex((row) => row.includes("HOLD THE LINE"))
      expect(row).toBeGreaterThan(0)
      const column = styled.text.split("\n")[row]?.indexOf("HOLD") ?? -1
      expect(column).toBeGreaterThan(0)
      for (let offset = 0; offset < 12; offset += 1) {
        expect(styled.cell(column + offset, row).bg, "status styling is foreground-only").toBeNull()
      }
    } finally {
      styled.unmount()
    }
  })

  it("spends the word STATUS on the row column only, even in the paused state", async () => {
    // 21479: STATUS names a row COLUMN — one of the object model's fixed cells.
    // The paused RUNNER box also labelled its pause rail `STATUS`, two lines
    // above that very column header, so one word named two different things on
    // one screen. The IA contract forbids exactly this, and it survived in the
    // one state the contract was written for. The blocking sibling rail never
    // had the problem — it reads `PAUSE BLOCKING EVERYTHING` — so this branch
    // joins that family and the column keeps the name to itself.
    //
    // The older `not.toContain("╭─ STATUS ")` guards only retired the separate
    // STATUS BOX; a bare label inside another box slips straight past them.
    const projection = queueTimelineStories.paused.snapshot.projection
    if (projection === undefined) throw new Error("paused story is missing its projection")
    const frame = (await renderTimeline(projection, 120)).join("\n")
    expect(frame, "the paused frame is the specimen").toContain("HOLD THE LINE")
    const occurrences = frame.match(/\bSTATUS\b/gu) ?? []
    expect(occurrences, `STATUS appears ${occurrences.length} time(s):\n${frame}`).toHaveLength(1)
    // …and the survivor is the column header, not some other rail.
    const header = frame.split("\n").find((row) => /\bSTATUS\b/u.test(row)) ?? ""
    expect(header.trim()).toMatch(/^TIME\s+STATUS\s+RUN\s+CHANGES\b/u)
  })

  it("advances the one temporal-trust cue when the snapshot advances", async () => {
    const projection = contractProjection()
    const first = await renderTimeline(projection, 120)
    expect(first.join("\n")).toContain("updated 17:30:00")
    const advanced = { ...projection, now: "2026-07-13T12:01:00.000Z" }
    const second = await renderTimeline(advanced, 120)
    expect(second.join("\n")).toContain("updated 17:31:00")
    expect(second.join("\n")).not.toContain("updated 17:30:00")
  })

  it("shortens terminal state labels at semantic boundaries instead of clipping", async () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    // The shared presentation alias shortens queue-environment-refused before
    // fixed-width layout; nothing clips mid-token and fixed columns stay put.
    const environment = rows[rowIndex(rows, "pr#6.1")]
    expect(environment).toContain("err=queue-env")
    expect(environment).not.toContain("queue-environment")
    const canceled = rows[rowIndex(rows, "pr#7.1")]
    expect(canceled).toContain("queue-canceled")
    const integrated = rows[rowIndex(rows, "pr#4.1")]
    expect(integrated).toContain("✓ merged")
  })

  it("keeps every shared failure slug intact through the fixed-width queue projection", async () => {
    const projection = queueTimelineStories["production-overview"].snapshot.projection
    if (projection === undefined) throw new Error("production-overview is missing its projection")

    for (const [code, slug] of Object.entries(FAILURE_SLUGS)) {
      const withFailure = {
        ...projection,
        rows: projection.rows.map((row) =>
          row.pr === "PR6" ? { ...row, failure: { code, message: `failure ${code}` } } : row,
        ),
      }
      const rows = (await renderTimeline(withFailure, 160)).map((row) => row.trimEnd())
      expect(rows[rowIndex(rows, "pr#6.1")], code).toContain(`err=${slug}`)
    }
  })

  it("defaults the cursor to the first running row, else the newest finished row", () => {
    expect(queueTimelineDefaultCursorId(contractProjection().rows)).toBe("main:run:R42:PR42:1")

    const anchored = queueTimelineStories["anchored-new"].snapshot.projection
    if (anchored === undefined) throw new Error("anchored-new is missing its projection")
    expect(queueTimelineDefaultCursorId(anchored.rows)).toBe("main:run:R12:PR12:1")

    const pending = queueTimelineStories["pending-only"].snapshot.projection
    if (pending === undefined) throw new Error("pending-only is missing its projection")
    expect(queueTimelineDefaultCursorId(pending.rows)).toBe(pending.rows[0]?.id)

    expect(queueTimelineDefaultCursorId([])).toBeUndefined()
  })

  it("opens on the default cursor row and keeps manual cursor moves sticky across snapshots", async () => {
    const story = queueTimelineStories["anchored-new"]
    if (story.nextSnapshot === undefined) throw new Error("anchored-new is missing its next snapshot")
    const render = createRenderer({ cols: 200, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      // No running rows: the newest finished run R12 is the default. The
      // detail pane has no identity title (item 23) — the change list bullet
      // and the member box header carry the selected change's id.
      expect(detailShows(handle.text, "pr#12.1")).toBe(true)

      // A manual move is sticky: the arriving newer run R13 must not steal
      // the cursor.
      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(detailShows(handle.text, "pr#11.1")).toBe(true)
      handle.rerender(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot }))
      await handle.waitForLayoutStable()
      expect(detailShows(handle.text, "pr#11.1")).toBe(true)
      expect(detailShows(handle.text, "pr#13.1")).toBe(false)
    } finally {
      handle.unmount()
    }

    // A fresh view over the same newer snapshot follows the default again.
    const fresh = createRenderer({ cols: 200, rows: 50 })
    const reopened = fresh(createElement(QueueWatchFrame, { snapshot: story.nextSnapshot }))
    try {
      await reopened.waitForLayoutStable()
      expect(detailShows(reopened.text, "pr#13.1")).toBe(true)
    } finally {
      reopened.unmount()
    }
  })

  it("drops the footer and scopes batched-run detail to the selected PR while listing its run members", async () => {
    const story = queueTimelineStories["contract-overview"]
    // Side-by-side (220 ≥ 213) so the PR-tab submit lines fit in the detail
    // pane. A 200-col below-split clips them under STATS + the list share.
    const render = createRenderer({ cols: 220, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      const rows = handle.text.split("\n")
      // The bottom keybindings footer row was removed entirely (item h).
      expect(handle.text).not.toContain("q quit")
      expect(handle.text).not.toContain("⇧-drag")
      // The STATS panel still renders in the pane's bottom band below
      // the list rows.
      const statistics = rows.findIndex((row) => row.includes("╭─ STATS "))
      expect(statistics).toBeGreaterThan(0)

      // Default cursor is the batch lead PR42. The detail is PR-scoped now
      // (user directive 2026-07-21, supersedes Round-6 Revision A's per-member
      // run-as-unit blocks): `pr#42.1` heads the pane, and the run identity
      // `RUN main#42` moved into the RUN region header, which sits above the
      // step tabs (the pane opens on the running `check` step, per the
      // running-step-wins default). The batch membership surfaces there as a
      // `PRs` members row listing both pr#42.1 and pr#43.1 — the partner PR
      // no longer gets its own block or its own submit-timeline line.
      expect(detailShows(handle.text, "pr#42.1")).toBe(true)
      expect(handle.text, "the run identity rides the status-box border").toContain("RUN main#42")
      expect(handle.text, "the RUN region lists every batch member").toContain("· pr#42.1")
      expect(handle.text, "the RUN region lists the batch partner").toContain("· pr#43.1")
      expect(handle.text).not.toMatch(/(?:^|\s)(?:▸|•)\s+PRS\b/gmu)

      // PR42's own submit timeline lives on the PR tab (tab 0), which is not
      // the default when a step is running. Move left past the running
      // `check` tab and the `prepare` tab to land on the PR tab and read its
      // submit facts.
      await handle.press("h")
      await handle.waitForLayoutStable()
      await handle.press("h")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("16:54 r1 submitted by @agent/3")
      // Operator spec item 4 ("list the changes, EACH CHANGE IN ITS OWN
      // BOX") expanded the Changes tab from the lead-only scope above to every
      // batch member — the partner PR now gets its own box, submit timeline
      // included.
      expect(handle.text, "the partner PR's own submit timeline now shows too").toContain(
        "16:56 r1 submitted by @agent/5",
      )
      // The composite RUN/status context persists while the PR activity tab is
      // selected, so identity and timing never disappear during diagnosis.
      expect(handle.text, "the PR tab preserves the RUN region").toContain("RUN main#42")
    } finally {
      handle.unmount()
    }
  })

  it("scopes PR detail to member runs and omits unavailable pending placeholders", async () => {
    const result = queueTimelineStories["contract-overview"].snapshot.results[0]
    if (result === undefined) throw new Error("contract-overview is missing its queue result")
    const runs = [...result.running, ...result.waiting, ...result.finished]
    const running = result.prs.find((pr) => pr.id === "PR42")
    const pending = result.prs.find((pr) => pr.id === "PR1")
    if (running === undefined || pending === undefined) throw new Error("contract fixture is missing expected PRs")

    expect(ChangeDetailData(running, runs).runs.map((run) => run.run)).toEqual(["R42"])
    const rendered = await renderString(createElement(ChangeDetailView, { pr: pending, runs, now: 0, position: 1 }), {
      width: 100,
      height: 20,
      plain: true,
    })
    expect(rendered).not.toContain("RELATED RUNS")
    expect(rendered).not.toContain("No run recorded.")
    expect(rendered).not.toContain("LANDING -")
  })
  it("freezes AGE at the first terminal outcome while open rows keep aging", () => {
    const results = queueTimelineStories["contract-overview"].snapshot.results
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const minute = 60_000
    const at = (snapshotNow: number) =>
      queueTimelineProjection(results, {
        now: snapshotNow,
        windowMs: 6 * 60 * minute,
        statuses: ["pending", "running", "rejected", "integrated", "other"],
        terms: [],
        latest: false,
        rowLimit: 20,
        submissionTimes: queueTimelineAdmissionTimes(results),
      })
    const before = at(now)
    const after = at(now + 5 * minute)
    const facts = (projection: QueueTimelineProjection) =>
      new Map(projection.rows.map((row) => [row.id, { ageMs: row.ageMs, totalMs: row.totalMs }]))
    const b = facts(before)
    const a = facts(after)

    // Terminal rows are frozen at their outcome.
    for (const id of ["main:run:R5:PR5:1", "main:run:R4:PR4:1"]) {
      expect(a.get(id), id).toEqual(b.get(id))
    }
    // Pending and running rows keep aging with canonical start semantics.
    const growing = before.rows.filter((row) => row.group !== "completed").map((row) => row.id)
    expect(growing).toHaveLength(4)
    for (const id of growing) {
      expect(a.get(id)?.ageMs, id).toBe((b.get(id)?.ageMs ?? Number.NaN) + 5 * minute)
    }
    // A running Run's TOTAL is elapsed-so-far; terminal totals never move.
    expect(a.get("main:run:R42:PR42:1")?.totalMs).toBe(
      (b.get("main:run:R42:PR42:1")?.totalMs ?? Number.NaN) + 5 * minute,
    )
  })

  it("keeps fixed-time human and JSON values byte-identical", async () => {
    const projection = contractProjection()
    const rows = (await renderTimeline(projection, 160)).map((row) => row.trimEnd())
    // The documented duration format, reimplemented independently so the test
    // pins the byte contract rather than sharing the implementation.
    const duration = (ms: number): string => {
      const seconds = Math.round(ms / 1_000)
      const hours = Math.floor(seconds / 3_600)
      const minutes = Math.floor((seconds % 3_600) / 60)
      const remainder = String(seconds % 60).padStart(2, "0")
      return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
    }
    // Queue clocks render in the system-local timezone.
    const wallClock = (iso: string): string => {
      const when = new Date(iso)
      const pad = (value: number) => String(value).padStart(2, "0")
      return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
    }
    const frame = rows.join("\n")
    expect(frame).toContain(`updated ${wallClock(projection.now)}`)
    // The healthy runner fact is visible while STATUS remains absent.
    expect(projection.runner).not.toBeNull()
    expect(frame).toContain("[84042]")
    expect(frame).toContain("╭─ RUNNER ")
    expect(frame).not.toContain("╭─ STATUS ")

    // Unconditional: every row carries its OWN time, run, step and duration,
    // convoy members included. These assertions used to be skipped for a row
    // sharing its predecessor's run, which is precisely the blindness 22925
    // removed \u2014 the skipped rows were the ones rendering as dashes.
    projection.rows.forEach((row, index) => {
      const pr = formatQueueChangeId(row.pr, row.revision)
      expect(parseChangeSelector(pr), `rendered identity ${pr}`).toEqual({
        pr: row.pr,
        revision: Number(row.revision),
      })
      // Disambiguate same-PR rows (draft vs terminal) by their own clock.
      const clock = row.timestamp === null ? undefined : wallClock(row.timestamp)
      const rendered = rows.find(
        (candidate) => candidate.includes(pr) && (clock === undefined || candidate.includes(clock)),
      )
      if (rendered === undefined) throw new Error(`missing rendered row for ${row.id}`)
      if (row.submitter !== undefined) expect(rendered, row.id).toContain(row.submitter)
      // Item 28: the CHANGES cell carries the change's TITLE.
      expect(rendered, row.id).toContain(row.subject.slice(0, 18))
      // Item 38: the run number renders on the FIRST member row; an adjacent
      // batch member carries the `·` continuation instead of repeating it.
      const previous = projection.rows[index - 1]
      const continues =
        row.run !== undefined && previous !== undefined && previous.run === row.run && previous.base === row.base
      if (row.run !== undefined && !continues) {
        expect(rendered, row.id).toContain(`#${row.run.replace(/^R/u, "")}`)
      }
      if (row.status === "running" && row.step !== undefined) expect(rendered, row.id).toContain(`(${row.step})`)
      if (row.ageMs !== null) expect(rendered, row.id).toContain(duration(row.ageMs))
      // Run duration is a bare dimmed time now — no clock glyph (item S).
      if (row.totalMs !== null) expect(rendered, row.id).toContain(duration(row.totalMs))
    })
  })

  it("selects whole rows through the canonical primitive with no textual cursor", async () => {
    const story = queueTimelineStories["contract-overview"]
    const render = createRenderer({ cols: 220, rows: 50 })
    const handle = render(createElement(QueueWatchFrame, { snapshot: story.snapshot }))
    try {
      await handle.waitForLayoutStable()
      const frame = handle.text.split("\n")
      expect(frame.some((row) => row.trimStart().startsWith("> "))).toBe(false)

      // Default cursor row (running batch lead) carries the selection
      // background across the whole row; its sibling does not. The split
      // panes share terminal lines and the DETAIL side also names both PRs
      // now (change list + member-box headers, items 24/25) — so match on
      // the LEFT pane only, cut at the split divider.
      const divider = (frame[1] ?? "").indexOf("│")
      expect(divider).toBeGreaterThan(0)
      const leftHalf = (row: string): string => row.slice(0, divider)
      const isListRow = (row: string): boolean => /^\s*\d{2}:\d{2}:\d{2} ◉ checking/u.test(row)
      const cursorRow = frame.findIndex((row) => leftHalf(row).includes("pr#42.1") && isListRow(leftHalf(row)))
      const siblingRow = frame.findIndex((row) => leftHalf(row).includes("pr#43.1") && isListRow(leftHalf(row)))
      expect(cursorRow).toBeGreaterThan(0)
      expect(siblingRow).toBe(cursorRow + 1)
      const cursorText = frame[cursorRow] ?? ""
      for (const anchor of ["◉", "pr#42.1", "Align host navigation"]) {
        const column = cursorText.indexOf(anchor)
        expect(column, anchor).toBeGreaterThanOrEqual(0)
        expect(handle.cell(column, cursorRow).bg, `selection bg under ${anchor}`).not.toBeNull()
      }
      const siblingColumn = (frame[siblingRow] ?? "").indexOf("pr#43.1")
      expect(handle.cell(siblingColumn, siblingRow).bg).toBeNull()
    } finally {
      handle.unmount()
    }
  })
})
