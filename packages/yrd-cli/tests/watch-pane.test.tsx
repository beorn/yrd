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

import type React from "react"
import { describe, expect, it, vi } from "vitest"
import { bufferToText, render } from "silvery/test"
import type { ChangeRecord, GitObservation, JournalRun, Row } from "@yrd/queue-core"
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
import { clock, runShortName } from "../src/watch-format.ts"
import { noticeLine } from "../src/watch-notice.ts"
import { printListing } from "../src/watch-print.tsx"
import { runOf, type WatchRun } from "../src/watch-run.ts"
import { watchRowKey, type WatchRow } from "../src/watch-rows.ts"

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
  return {
    at: NOW,
    queue: "example.test/repo#main",
    queues: [{ branch: "main", label: "main", path: "/repo" }],
    rows: [{ row: failedRow() }],
    ...over,
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
  it("is YRD QUEUES and one pill per queue, digit + friendly path + branch glyph, and nothing else", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    const [first] = text.split("\n")
    expect(first).toContain("YRD QUEUES")
    expect(first).toContain("1 /repo ⎇ main")
    // The old `QUEUE main ROOT /repo` row and the queue's address are gone from the top.
    expect(text).not.toContain("QUEUE main")
    expect(first).not.toContain("example.test")
    // A one-shot print has nothing to clear, so the retired pane's trailing `all` pill is absent from it.
    expect(first?.trimEnd().endsWith("all")).toBe(false)
  })

  it("on the live pane carries the retired pane's trailing `all` pill, which clears both filter kinds", async () => {
    const rows: WatchRow[] = [{ row: row({ branch: "task/queued", state: "queued" }) }, { row: failedRow() }]
    const app = render(<WatchPane snapshot={snapshot({ rows })} live />, { cols: 120, rows: 40 })
    await app.waitForLayoutStable()
    const [first] = app.text.split("\n")
    expect(first).toContain("1 /repo ⎇ main")
    expect(first?.trimEnd().endsWith("all")).toBe(true)

    app.press("f")
    await app.waitForLayoutStable()
    expect(app.text).toContain("1 of 2 change(s)")
    app.press("a")
    await app.waitForLayoutStable()
    expect(app.text).toContain("2 of 2 change(s)")
    app.unmount()
  })

  it("puts RUNNER before the table and keeps the pause only on its RUNNER rail", async () => {
    // The component tests covered the top pause and RUNNER independently, so
    // they missed the live screen duplicating one pause around a long table.
    const pause = "paused by @chief: the host is down"
    const text = await paint(
      <WatchPane
        snapshot={snapshot({
          pause,
          runner: {
            journalDir: "/w/logs",
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
    expect(lines[0]).toContain("YRD QUEUES")
    expect(lines.findIndex((line) => line.includes("RUNNER"))).toBeLessThan(
      lines.findIndex((line) => line.includes("CHANGES")),
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
      lines.findIndex((line) => line.includes("CHANGES")),
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

describe("the table (items 3, 28, 38)", () => {
  it("has the operator's columns: TIME STATUS RUN CHANGES BY AGE RUN, and rows that read across them", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    const header = text.split("\n").find((line) => line.includes("CHANGES"))
    expect(header).toBeDefined()
    for (const column of ["TIME", "STATUS", "RUN", "CHANGES", "BY", "AGE", "RUNTIME"]) expect(header).toContain(column)
    // The run and its duration are two columns with two names, in this order.
    expect(header!.indexOf("RUN ")).toBeLessThan(header!.indexOf("CHANGES"))
    expect(header!.trimEnd().endsWith("RUNTIME")).toBe(true)
    // The CHANGES cell is the change's branch and its subject, never the branch alone (28), with the failure's code as status.
    const line = text.split("\n").find((candidate) => candidate.includes("task/one"))
    expect(line).toContain("× failed")
    expect(line).toContain("task/one fix the parser")
    expect(line).toContain("(err=test)")
    expect(line).toContain("@chief")
    // The RUN cell names the run by its label and its own start instant, never the random tail (34/36/38, @cto 2026-09-05).
    expect(line).toContain("main#")
    expect(line).not.toContain("0badf00d")
  })

  it("shows a muted em-dash in the RUN cell of a change no run has touched (38)", async () => {
    const text = await paint(<WatchPane snapshot={snapshot({ rows: [{ row: row() }] })} live={false} />)

    const line = text.split("\n").find((candidate) => candidate.includes("task/one"))
    expect(line).toContain("—")
    expect(line).toContain("○ queued")
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
    // Runtime needs the row's lifecycle: a terminal row with no recorded ending stays unknown.
    const lines = app.text.split("\n")
    const runtimeColumn = lines.find((line) => line.includes("RUNTIME"))!.indexOf("RUNTIME")
    expect(runtimeColumn).toBeGreaterThan(0)
    expect(
      lines
        .find((line) => line.includes("task/merged"))
        ?.slice(runtimeColumn)
        .trim(),
    ).toBe("")
    expect(
      lines
        .find((line) => line.includes("task/queued"))
        ?.slice(runtimeColumn)
        .trim(),
    ).toBe("1:30")

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
    expect(
      restored
        .find((line) => line.includes("task/queued"))
        ?.slice(runtimeColumn)
        .trim(),
    ).toBe("1:30")
    expect(
      restored
        .find((line) => line.includes("task/merged"))
        ?.slice(runtimeColumn)
        .trim(),
    ).toBe("")
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

  it("renders the status pills right-aligned on the bottom row, `all` included", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    const pills = text
      .split("\n")
      .find((line) => line.includes("open") && line.includes("failed") && line.includes("all"))
    expect(pills).toBeDefined()
    expect(pills?.trimEnd().endsWith("all")).toBe(true)
  })
})

describe("the status box (items 1, 23, 29a, 39)", () => {
  it("is the very top of the detail, wears the run on its border, and hangs a step line per check off a gutter", async () => {
    const open = opener()
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} open={open} />, ["Enter"])

    expect(open).toHaveBeenCalledTimes(1)
    // No identity title row above the box: the first thing in the detail is the border with the run on it.
    expect(text).toContain("RUN main#")
    expect(text).toContain("× failed test")
    // Age · Runtime · Wait time, in the operator's order, form and words, from the one clocks() in the core.
    expect(text).toContain("Age 1h00m · Runtime 30:00 · Wait time 30:00")
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
    const text = await paint(at(<RunStatusBox run={run} live={false} />))

    expect(text).toContain("✓ passed, merged")
    expect(text).toContain("Merged as b234234abcde at")
    expect(text).toContain("Runtime 3:45")
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
    const text = await paint(at(<RunStatusBox run={mock} live={false} />))

    expect(text).toContain("RUN staging#")
    expect(text).toMatch(/✓ build image\s+1:30/u)
    expect(text).toContain("◉ roll out")
    expect(text).toMatch(/− smoke\s+not run/u)
  })
})

describe("the change list and the Changes tab (items 2, 4, 6, 24, 25, 31)", () => {
  it("lists the change under the box as `· <branch>@<sha12> <subject>` and puts Changes first on the tab strip", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} open={opener()} />, ["Enter"])

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
    const text = await paint(at(<WatchDetail detail={detail} live={false} selected={CHANGES_TAB} />), [], 100)

    // Header on the box, then the bold title and the body.
    expect(text).toContain("task/one@abcdef012345")
    expect(text).toContain("The parser dropped the last token.")
    // HISTORY newest first, human verbs only where a human acted.
    const failedAt = text.indexOf("failed test — fix the test and resubmit")
    const submittedAt = text.indexOf("submitted by @chief")
    expect(failedAt).toBeGreaterThan(-1)
    expect(submittedAt).toBeGreaterThan(failedAt)
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
    const candidate = await paint(at(<WatchDetail detail={detail} live={false} selected="0" />))
    expect(candidate).toContain("verify (merge)")
    expect(candidate).toContain("verify (base)")
    expect(candidate).toContain("CANDIDATE_FAIL")
    expect(candidate).not.toContain("BASE_PASS")
    const base = await paint(at(<WatchDetail detail={detail} live={false} selected="1" />))
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
    const text = await paint(at(<WatchDetail detail={detailOf({ row: failedRow() })} live={false} selected="2" />))

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
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
      await settle(app)
      const diagnostic = {
        kind: "change" as const,
        run: RUN_ID,
        at: new Date(NOW.getTime() + 1000).toISOString(),
        reason: "change-ref-taken",
        text: "remote ref changed after the merge",
        next: "git show refs/changes/task/one",
      }
      await vi.waitFor(() => expect(rounds.length).toBeGreaterThan(0))
      rounds
        .at(-1)
        ?.resolve(
          snapshot({ at: new Date(NOW.getTime() + 2000), rows: [{ row: { ...initial, diagnostics: [diagnostic] } }] }),
        )
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
      await settle(app)
      expect(current(app)).toContain(diagnostic.text)
      expect(current(app)).toContain(diagnostic.next)
      expect(current(app)).toContain("passed, merged")
      // A fresh journal read returns new objects even when its records did not change.
      await vi.waitFor(() => expect(rounds.length).toBeGreaterThan(1))
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

    expect(open).toHaveBeenCalledTimes(1)
    expect(app.text).toContain("1 test failed: the parser")
    app.unmount()
  })

  it("drills in to one pane when there is room for neither split", () => {
    expect(watchTier(60, 10)).toBe("full")
  })
})

describe("the running step and the check-less declaration", () => {
  it("shows how long the running step has run, from the row's own live instant, beside the pulse (item 39)", async () => {
    const live = row({
      live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: new Date(NOW.getTime() - 151_000) },
      position: 1,
      state: "checked",
    })
    const run = runOf(live, "main", [
      { name: "typecheck", result: { ms: 8_000, result: "pass" }, state: "passed" },
      { name: "affected-tests", state: "running" },
    ])
    const text = await paint(at(<RunStatusBox run={run} live={false} />))

    expect(text).toMatch(/◉ affected-tests 2:31/u)
    expect(text).toMatch(/✓ typecheck 0:08/u)
  })

  it("says so when the declaration a change was judged by names no check, instead of a bare tab strip", async () => {
    const detail = detailOf({ row: row() }, [])
    const text = await paint(at(<WatchDetail detail={detail} live={false} />))

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
    const text = await paint(
      at(<WatchDetail detail={detailOf({ row: direct }, [])} live={false} selected={CHANGES_TAB} />),
    )

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
    const text = await paint(at(<RunStatusBox run={run} live={false} />))

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
    await vi.waitFor(() => {
      expect(rounds).toHaveLength(1)
    })
    rounds[0]?.reject(LOCK_RACE)
    // The loop went on to the next round instead of ending the watch.
    await vi.waitFor(() => {
      expect(rounds).toHaveLength(2)
    })
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    app.press("Enter")
    await vi.waitFor(() => {
      expect(current(app)).toContain("⚠︎ this change's read failed at ")
    })
    const text = current(app)
    expect(text).toContain("retrying — fatal: bad object abcdef0123456789")
    expect(text).toContain("no change selected")
    // A good round re-runs the read; the warning goes and the detail comes.
    await vi.waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds.at(-1)?.resolve(snapshot({ at: new Date(NOW.getTime() + 60_000) }))
    await vi.waitFor(() => {
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
    app.press("ArrowDown")
    await app.waitForLayoutStable()
    app.press("Enter")
    await vi.waitFor(() => {
      expect(current(app)).toContain("· task/b@bbbbbbbbbbbb the second")
    })
    expect(current(app)).toContain("Home follows the newest again")
    await vi.waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds
      .at(-1)
      ?.resolve(
        snapshot({ at: new Date(NOW.getTime() + 60_000), rows: [{ row: fresh }, { row: a }, { row: b }, { row: c }] }),
      )
    await vi.waitFor(() => {
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
    app.press("ArrowDown")
    await app.waitForLayoutStable()
    app.press("Enter")
    await vi.waitFor(() => {
      expect(current(app)).toContain("· task/b@bbbbbbbbbbbb the second")
    })
    await vi.waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds.at(-1)?.resolve(snapshot({ at: new Date(NOW.getTime() + 60_000), rows: [{ row: a }, { row: c }] }))
    await vi.waitFor(() => {
      expect(current(app)).toContain("⚠︎ the row under the cursor left the table: task/b@bbbbbbbbbbbb")
    })
    const text = current(app)
    expect(text).toContain("the cursor stays on its neighbour, Home follows the newest again")
    // The neighbour at the same index is under the cursor now, and its detail is what the pane reads.
    await vi.waitFor(() => {
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
    expect(current(app)).not.toContain("Home follows the newest again")
    await vi.waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0)
    })
    rounds
      .at(-1)
      ?.resolve(snapshot({ at: new Date(NOW.getTime() + 60_000), rows: [{ row: fresh }, { row: a }, { row: b }] }))
    await vi.waitFor(() => {
      expect(current(app)).toContain("3 of 3 change(s)")
    })
    app.press("Enter")
    await vi.waitFor(() => {
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
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: NOW },
  }
  const decisions = [{ at: NOW, decision: "merged" as const, duplicate: false, run: RUN_ID }]

  it("puts the status pills between the rows and STATS", async () => {
    const app = render(<WatchPane snapshot={snapshot({ runner, decisions })} live={false} />, {
      cols: 120,
      rows: 50,
    })
    await app.waitForLayoutStable()
    await settle(app)
    const lines = app.text.split("\n")
    const lastRow = lines.findIndex((line) => line.includes("task/one"))
    const pills = lines.findIndex(
      (line, index) => index > lastRow && /\bopen\b.*\brunning\b.*\bdone\b.*\bfailed\b/u.test(line),
    )
    const stats = lines.findIndex((line) => line.includes("STATS"))
    expect(lastRow).toBeGreaterThan(0)
    expect(pills).toBeGreaterThan(lastRow)
    expect(stats).toBeGreaterThan(pills)
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
    latest: { alive: false, id: RUN_ID, lastWriteAt: NOW, startedAt: new Date(NOW.getTime() - 120_000) },
  }
  const underCheck = row({
    live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: new Date(NOW.getTime() - 151_000) },
    position: 1,
    state: "checked",
  })

  it("reads PROCESSING while a row has a live check", async () => {
    const app = render(<WatchPane snapshot={snapshot({ runner, rows: [{ row: underCheck }] })} live={false} />, {
      cols: 120,
      rows: 30,
    })
    await app.waitForLayoutStable()
    await settle(app)

    expect(app.text).toContain("processing 2:00")
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
    expect(app.text, "nothing is under a check, so nothing is processing").not.toContain("processing")
    app.unmount()
  })
})

/**
 * @failure  The operator read `yrd watch` on 2026-09-16 and could not tell what was going on: "20+
 *           checked? what does that mean", "checked does NOT obviously mean 'waiting in line to be
 *           merged'", "why is the status idle then???" Nothing said how many changes wait, what runs
 *           now or when the last merge landed; the state words were the queue's internal names, spelled
 *           separately on every surface; RUNTIME was blank or stale on every row not running; a
 *           standing observation line said nothing a reader could act on; and `?` drew its help in the
 *           pane's flow, where it took the table's rows (@i/10-yrd/24196).
 * @level    l2 (the pane, the page and the notice, rendered into a headless terminal)
 * @consumer the operator reading `yrd watch` and `yrd list`
 */
describe("the watch says what waits, what runs and what happens next (24196)", () => {
  /**
   * The keys of the ONE word table (decision 3, as corrected): the queue's own state names, the check
   * running now (`live`), the landing act (`landing`), and the TIME cell's lead words (`waiting`, `took`,
   * decision 5). Its VALUES are @cto's to rule, so no assertion here spells a state word: each reads the
   * table.
   */
  const WORD_KEYS = [
    "queued",
    "checked",
    "stuck",
    "merged",
    "failed",
    "withdrawn",
    "direct",
    "live",
    "landing",
    "waiting",
    "took",
  ] as const
  type WordTable = Record<(typeof WORD_KEYS)[number], string>

  /**
   * The table as watch-format.ts exports it, read through the module's namespace so this file compiles
   * before the table exists. Until it does, every word is a placeholder no surface prints, so each test
   * fails on its own assertion, naming what is missing, rather than on an import.
   */
  async function words(): Promise<WordTable> {
    const table = ((await import("../src/watch-format.ts")) as unknown as Readonly<Record<string, unknown>>)[
      "STATE_WORDS"
    ]
    if (table !== undefined) return table as WordTable
    return Object.fromEntries(WORD_KEYS.map((key) => [key, `<no STATE_WORDS.${key}>`])) as WordTable
  }

  const MINUTE = 60_000
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
  const MERGED_RUN = "q-20260903T115230000Z-feedf00d"
  const FAILED_RUN = "q-20260903T113500000Z-deadf00d"
  const RUNNING_SINCE = ago(3 * MINUTE + 21_000)
  const RUNNER = {
    journalDir: "/w/logs",
    latest: { alive: true, id: RUN_ID, lastWriteAt: ago(20_000), startedAt: ago(3 * MINUTE + 30_000) },
  }
  const DECISIONS = [
    { at: ago(3 * MINUTE + 12_000), decision: "merged" as const, duplicate: false, run: MERGED_RUN },
    { at: ago(20 * MINUTE), decision: "failed" as const, duplicate: false, run: FAILED_RUN },
  ]

  /** The change under a check: its only check started when its run did, so every reading of its runtime is 3:21. */
  function running(over: Partial<Row> = {}): Row {
    return row({
      at: ago(20_000),
      branch: "task/x",
      head: "1".repeat(40),
      live: { check: "affected-tests", phase: "merge", run: RUN_ID, since: RUNNING_SINCE },
      position: 1,
      run: RUN_ID,
      startedAt: RUNNING_SINCE,
      state: "checked",
      subject: "the change under a check",
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

  /**
   * EVERY_STATE: one row in each state the table draws, and one under a check. The width renders in
   * the 24196 phase A report are drawn from it, and the tier ladder below reads it.
   */
  const EVERY_STATE: readonly WatchRow[] = [
    { row: running() },
    {
      row: row({
        at: ago(3 * MINUTE),
        branch: "task/y1",
        head: "2".repeat(40),
        position: 2,
        since: ago(30 * MINUTE),
        startedAt: ago(20 * MINUTE),
        state: "checked",
        subject: "passed, waits to merge",
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
        state: "stuck",
        subject: "the queue could not judge it",
      }),
    },
    {
      row: row({
        at: ago(4 * MINUTE + 50_000),
        branch: "task/m",
        endedAt: ago(4 * MINUTE + 50_000),
        head: "5".repeat(40),
        merge: "9".repeat(40),
        result: "pass affected-tests",
        run: MERGED_RUN,
        since: ago(9 * MINUTE),
        startedAt: ago(9 * MINUTE),
        state: "merged",
        subject: "merged a moment ago",
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
        startedAt: ago(25 * MINUTE),
        state: "failed",
        subject: "a test failed",
      }),
    },
    {
      row: row({
        at: ago(30 * MINUTE),
        branch: "task/w",
        head: "7".repeat(40),
        reason: "replaced",
        state: "withdrawn",
        subject: "a newer head replaced it",
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
  ]

  /** Paint the pane and hand back its lines, with the `?` help open when asked. */
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

  /** The line right under `YRD QUEUES`: where decision 2 puts the top line, above RUNNER. */
  function topLineOf(painted: readonly string[]): Readonly<{ line: string; next: string }> {
    const title = painted.findIndex((line) => line.includes("YRD QUEUES"))
    return { line: painted[title + 1] ?? "", next: painted[title + 2] ?? "" }
  }

  it("the top line counts the changes in line — passed and waiting to merge, not yet checked — names the running change and its step, and the last merge with its age, counting a change once however many runs it has", async () => {
    const W = await words()
    const recheck = "q-20260903T112000000Z-5ecf00d0"
    const earlier = "q-20260903T111000000Z-0ea1f00d"
    const { live: _running, ...before } = running()
    const passed = row({ branch: "task/y1", head: "2".repeat(40), position: 2, state: "checked" })
    const rows: WatchRow[] = [
      // The running change, split into its run now and the run that checked it before: ONE change running.
      split(running(), RUN_ID),
      split({ ...before, at: ago(40 * MINUTE), endedAt: ago(40 * MINUTE) }, earlier, "checked"),
      // A change checked twice (the target moved under it) is ONE change waiting to merge.
      split({ ...passed, at: ago(3 * MINUTE), endedAt: ago(3 * MINUTE) }, recheck, "checked"),
      split({ ...passed, at: ago(25 * MINUTE), endedAt: ago(25 * MINUTE) }, earlier, "checked"),
      { row: row({ branch: "task/y2", head: "3".repeat(40), position: 3, state: "checked" }) },
      { row: row({ branch: "task/z1", head: "4".repeat(40), position: 4, state: "queued" }) },
      { row: row({ branch: "task/z2", head: "5".repeat(40), position: 5, state: "queued" }) },
      split(
        row({
          branch: "task/y",
          endedAt: ago(3 * MINUTE + 12_000),
          head: "6".repeat(40),
          merge: "9".repeat(40),
          state: "merged",
        }),
        MERGED_RUN,
        "merged",
      ),
    ]
    const decisions = [
      { at: ago(3 * MINUTE + 12_000), decision: "merged" as const, duplicate: false, run: MERGED_RUN },
      { at: ago(60 * MINUTE), decision: "merged" as const, duplicate: false, run: earlier },
    ]

    const painted = await lines(snapshot({ decisions, rows, runner: RUNNER }), 120, 40)

    expect(topLineOf(painted).line.trim()).toBe(
      `5 in line: 2 ${W.checked}, 2 ${W.queued} · ${W.live} task/x (affected-tests) · last merge 3:12 ago (task/y)`,
    )
  })

  it("the TIME cell names its own meaning: the running word and how long it has run, waiting since the change entered its state, took on an ended row", async () => {
    const W = await words()
    const byBranch = new Map(EVERY_STATE.map((item) => [item.row.branch, item]))
    const wanted: Readonly<Record<string, string>> = {
      "task/f": `${W.took} 5:00`,
      "task/m": `${W.took} 4:10`,
      "task/x": `${W.live} 3:21`,
      "task/y1": `${W.waiting} 3:00`,
      "task/z": `${W.waiting} 12:03`,
    }
    const rows = Object.keys(wanted).map((branch) => byBranch.get(branch)!)
    const runName = runShortName("main", RUN_ID)

    const painted = await lines(snapshot({ rows }), 120, 40)

    const cells = Object.fromEntries(
      Object.entries(wanted).map(([branch, cell]) => {
        const tail = (
          painted.find((line) => line.includes(`${branch} `) && (branch !== "task/x" || line.includes(runName))) ?? ""
        ).trimEnd()
        return [branch, tail.endsWith(cell) ? cell : tail.slice(-24)]
      }),
    )
    expect(cells).toEqual(wanted)
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

  it("? opens the help as an overlay centred over the pane, which keeps its footer, with a States section drawn from the word table", async () => {
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
    // The States entries, read inside the dialog only: from its `States` heading's column, so no word the
    // table rows or the pills draw beside the dialog can answer for the section.
    const heading = open.findIndex((line) => /\bStates\b/u.test(line))
    const column = heading < 0 ? -1 : (open[heading] ?? "").search(/\bStates\b/u)
    const section = open
      .slice(heading < 0 ? open.length : heading + 1, heading + 16)
      .map((line) => line.slice(column, column + 60))
      .join("\n")
    const stateKeys = ["queued", "checked", "stuck", "merged", "failed", "withdrawn", "direct", "live"] as const

    expect({
      centred: first > 0 && last < 48 - 1 && Math.abs((first + last) / 2 - (48 - 1) / 2) <= 2,
      footerKept: footer(open) === footer(closed),
      statesMissing: stateKeys.filter((key) => !section.includes(W[key])),
    }).toEqual({ centred: true, footerKept: true, statesMissing: [] })
  })

  it("one change to the word table changes every surface that draws a state word", async () => {
    const W = await words()
    const SENTINEL = "LIVEWORD"
    const was = W.live
    const runName = runShortName("main", RUN_ID)
    const item = running()
    const snap = snapshot({ decisions: DECISIONS, rows: [{ row: item }], runner: RUNNER })
    W.live = SENTINEL
    try {
      const pane = await lines(snap, 120, 40)
      const help = await lines(snapshot({ rows: [] }), 120, 40, ["?"])
      const page = (await printListing(snap, { color: false, columns: 120 })).split("\n")
      const paneRow = pane.find((line) => line.includes(runName) && line.includes("task/x")) ?? ""
      const pageRow = page.find((line) => line.includes(runName) && line.includes("task/x")) ?? ""
      const pageTop = page[page.findIndex((line) => line.includes("YRD QUEUES")) + 1] ?? ""
      const surfaces: Readonly<Record<string, boolean>> = {
        "notice line": noticeLine(item).includes(SENTINEL),
        "pane STATUS cell": paneRow.includes(`◉ ${SENTINEL}`),
        "pane TIME cell": paneRow.includes(`${SENTINEL} 3:21`),
        "pane top line": topLineOf(pane).line.includes(`${SENTINEL} task/x`),
        "page STATUS cell": pageRow.includes(`◉ ${SENTINEL}`),
        "page TIME cell": pageRow.includes(`${SENTINEL} 3:21`),
        "page top line": pageTop.includes(`${SENTINEL} task/x`),
        "? States section": help.some((line) => line.includes(SENTINEL)),
      }

      expect(Object.keys(surfaces).filter((surface) => surfaces[surface] !== true)).toEqual([])
    } finally {
      W.live = was
    }
  })

  it("never draws `checked` as a state word, on any surface", async () => {
    const waiting = row({ at: ago(3 * MINUTE), branch: "task/y1", position: 1, state: "checked", subject: "passed" })
    const snap = snapshot({ rows: [{ row: waiting }], runner: RUNNER })
    const pane = await lines(snap, 120, 40)
    const help = await lines(snapshot({ rows: [] }), 120, 40, ["?"])
    const page = (await printListing(snap, { color: false, columns: 120 })).split("\n")
    const checked = /\bchecked\b/u
    const surfaces: Readonly<Record<string, string>> = {
      "notice line": noticeLine(waiting),
      "pane STATUS cell": pane.find((line) => line.includes("task/y1 passed")) ?? "",
      "pane top line": topLineOf(pane).line,
      "page STATUS cell": page.find((line) => line.includes("task/y1 passed")) ?? "",
      "page top line": page[page.findIndex((line) => line.includes("YRD QUEUES")) + 1] ?? "",
      "? help": help.join("\n"),
    }

    // A surface this test cannot find is listed too, so a line it failed to locate never passes as clean.
    const offending = (surface: string): boolean =>
      (surfaces[surface] ?? "") === "" || checked.test(surfaces[surface] ?? "")
    expect(Object.keys(surfaces).filter(offending)).toEqual([])
  })

  it("at each size of the tier ladder draws the top line on one row, and the running row keeps its word and its time", async () => {
    const W = await words()
    const runName = runShortName("main", RUN_ID)
    const seen = []
    for (const [cols, rows] of [
      [213, 50],
      [212, 50],
      [100, 31],
    ] as const) {
      const painted = await lines(snapshot({ decisions: DECISIONS, rows: EVERY_STATE, runner: RUNNER }), cols, rows)
      const top = topLineOf(painted)
      const runningRow = painted.find((line) => line.includes(runName) && line.includes("task/x")) ?? ""
      seen.push({
        runningRowDrawn: runningRow !== "",
        runningTime: runningRow.includes(`${W.live} 3:21`),
        runningWord: runningRow.includes(`◉ ${W.live}`),
        size: `${String(cols)}x${String(rows)}`,
        tier: watchTier(cols, rows),
        topLineOneRow: top.line.includes(`${W.live} task/x`) && top.next.includes("╭─ RUNNER"),
      })
    }

    const drawn = { runningRowDrawn: true, runningTime: true, runningWord: true, topLineOneRow: true }
    expect(seen).toEqual([
      { ...drawn, size: "213x50", tier: "right" },
      { ...drawn, size: "212x50", tier: "below" },
      { ...drawn, size: "100x31", tier: "full" },
    ])
  })
})
