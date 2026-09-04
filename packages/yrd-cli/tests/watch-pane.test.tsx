/**
 * @failure  The retired monitor's detail pane hid what a reader most needed:
 *           the checks a change never reached were simply absent, so a change
 *           that failed its second check read as one judged by two; and the
 *           command that produced a log lived nowhere near it. Behavioural
 *           ports of the retired top-line, detail-completeness,
 *           run-presentation and pane-interaction suites.
 * @level    l2 (a real silvery render into a headless terminal buffer)
 * @consumer the operator reading `yrd watch`
 */

import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import type { Row } from "@yrd/queue-core"
import { WatchPane, watchTier, type WatchSnapshot } from "../src/watch-pane.tsx"
import { defaultCheckIndex, WatchDetail, type CheckPanel } from "../src/watch-detail.tsx"
import { watchRowKey, type WatchRow } from "../src/watch-rows.ts"

const NOW = new Date("2026-09-03T12:00:00.000Z")

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
    result: { exit: "0", log: "/w/checks/typecheck.log", ms: 1000, result: "pass" },
    spec: { name: "typecheck", run: "bun run typecheck" },
    state: "passed",
  },
  {
    log: "/w/checks/test.log",
    name: "test",
    output: "1 test failed: the parser",
    result: { exit: "1", log: "/w/checks/test.log", ms: 2000, result: "fail" },
    spec: { name: "test", run: "bun run test" },
    state: "failed",
  },
  { name: "lint", spec: { name: "lint", run: "bun run lint" }, state: "not-run" },
]

function snapshot(over: Partial<WatchSnapshot> = {}): WatchSnapshot {
  const failed = row({ endedAt: NOW, reason: "test", startedAt: new Date(NOW.getTime() - 1_800_000), state: "failed" })
  return {
    at: NOW,
    detail: new Map([[watchRowKey({ row: failed }), { checks: CHECKS, row: failed }]]),
    queue: "example.test/repo#main",
    rows: [{ row: failed }],
    ...over,
  }
}

/** One frame of the pane, painted into a headless terminal and read back as text. */
async function paint(element: Parameters<typeof render>[0], keys: readonly string[] = []): Promise<string> {
  const app = render(element, { cols: 120, rows: 40 })
  await app.waitForLayoutStable()
  for (const key of keys) app.press(key)
  await app.waitForLayoutStable()
  const text = app.text
  app.unmount()
  return text
}

describe("the top line", () => {
  it("names the queue", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />)

    expect(text).toContain("example.test/repo#main")
  })

  it("puts the pause above the name, because a queue that is not running is the loudest thing about it", async () => {
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

describe("one change, opened", () => {
  it("shows its identity, its subject and its clocks", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />, ["Enter"])

    expect(text).toContain("task/one")
    expect(text).toContain("fix the parser")
    // Age, runtime and wait, read from the one `clocks()` in the core.
    expect(text).toContain("Age 1h")
    expect(text).toContain("Runtime 30m")
  })

  it("renders the check after a failing one as NOT RUN, with the command that would have run it", async () => {
    const text = await paint(<WatchPane snapshot={snapshot()} live={false} />, ["Enter"])

    // Every declared check is on the tab strip, the one never reached included.
    expect(text).toContain("typecheck")
    expect(text).toContain("test")
    expect(text).toContain("lint")
  })
})

describe("which check a reader lands on", () => {
  it("labels repeated check names by phase and opens only that occurrence's output", async () => {
    const detail = {
      row: row({ state: "failed" }),
      checks: [
        { name: "verify", phase: "merge", state: "failed" as const, output: "CANDIDATE_FAIL", log: "/candidate/log" },
        { name: "verify", phase: "base", state: "passed" as const, output: "BASE_PASS", log: "/base/log" },
      ],
    }
    const candidate = await paint(<WatchDetail detail={detail} now={NOW} selected={0} />)
    expect(candidate).toContain("verify (merge)")
    expect(candidate).toContain("verify (base)")
    expect(candidate).toContain("CANDIDATE_FAIL")
    expect(candidate).not.toContain("BASE_PASS")
    const base = await paint(<WatchDetail detail={detail} now={NOW} selected={1} />)
    expect(base).toContain("BASE_PASS")
    expect(base).not.toContain("CANDIDATE_FAIL")
  })

  it("selects the newest output, not the first check", () => {
    expect(defaultCheckIndex(CHECKS)).toBe(1)
  })

  it("falls back to the last check that RAN when none of them wrote output", () => {
    const silent = CHECKS.map((check) => {
      const { output: _output, ...rest } = check
      return rest
    })

    expect(defaultCheckIndex(silent)).toBe(1)
  })

  it("lands on the first tab when nothing ran at all, rather than on nothing", () => {
    expect(defaultCheckIndex([{ name: "lint", spec: { name: "lint", run: "bun run lint" }, state: "not-run" }])).toBe(0)
  })
})

describe("the pane's keys", () => {
  it("opens the selected historical run's output when two rows have the same head", async () => {
    // Head-only detail identity passed all single-run fixtures but opened the
    // latest output when the operator selected the older attempt.
    const rows: WatchRow[] = ["second", "first"].map((id) => ({
      row: row({ run: id, state: "failed" }),
      run: { id, branch: "task/one", head: row().head, startedAt: NOW, at: NOW, checks: [] },
    }))
    rows.push({
      row: row({ branch: "task/other", run: "first", state: "failed" }),
      run: { ...rows[1]!.run!, branch: "task/other" },
    })
    const detail = new Map(
      rows.map((item) => [
        watchRowKey(item),
        {
          row: item.row,
          checks: [
            {
              name: "verify",
              state: "failed" as const,
              output: `${item.row.branch} ${item.run?.id} RUN OUTPUT`,
              log: `/w/${item.run?.id}.log`,
            },
          ],
        },
      ]),
    )
    const app = render(<WatchPane snapshot={snapshot({ rows, detail })} live={false} />, { cols: 120, rows: 40 })
    await app.waitForLayoutStable()
    app.press("Enter")
    await app.waitForLayoutStable()
    expect(app.text).toContain("second RUN OUTPUT")
    app.press("Escape")
    await app.waitForLayoutStable()
    app.press("j")
    await app.waitForLayoutStable()
    app.press("Enter")
    await app.waitForLayoutStable()
    expect(app.text).toContain("first RUN OUTPUT")
    expect(app.text).not.toContain("second RUN OUTPUT")
    app.press("Escape")
    await app.waitForLayoutStable()
    app.press("j")
    await app.waitForLayoutStable()
    app.press("Enter")
    await app.waitForLayoutStable()
    expect(app.text).toContain("task/other first RUN OUTPUT")
    expect(app.text).not.toContain("task/one first RUN OUTPUT")
    app.unmount()
  })

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
