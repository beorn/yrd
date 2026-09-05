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
import type { ChangeRecord, Row } from "@yrd/queue-core"
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

  it("puts the pause above everything, because a queue that is not running is the loudest thing about it", async () => {
    const text = await paint(
      <WatchPane snapshot={snapshot({ pause: "paused by @chief: the host is down" })} live={false} />,
    )

    const lines = text.split("\n").filter((line) => line.trim() !== "")
    expect(lines[0]).toContain("paused by @chief")
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
    const rows: WatchRow[] = [
      { row: row({ branch: "task/queued", state: "queued" }) },
      { row: failedRow() },
      { row: row({ branch: "task/merged", head: "1".repeat(40), merge: "2".repeat(40), state: "merged" }) },
    ]
    const app = render(<WatchPane snapshot={snapshot({ rows })} live={false} />, { cols: 120, rows: 40 })
    await app.waitForLayoutStable()
    expect(app.text).toContain("3 of 3 change(s)")

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
      reason: "main moved around the queue at 333333333333 (fix: land it)",
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
