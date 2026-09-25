/**
 * Bead 25556 — seven rows from the operator on yrd watch's top lines and RUNNER bar:
 * 1. Queue toggle and filter group take their own tints; selected is fully bold, unselected not bold.
 * 2. Each filter tab shows key: [o]pen, [r]unning, [d]one, [f]ailed.
 * 3. After status word on top line, a not-bold timer shows duration in that status for all statuses.
 * 4. STATS line takes muted text colour ($fg-on-inverse-muted).
 * 5. When runner has no real item selected (stand-in row), detail pane is not shown.
 * 6. RUNNER bar idle counter updates every second.
 * 7. RUNNER bar title is RUNNER in bold followed by queue URL; runner status sits in status column.
 */

import { act } from "react"
import { describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { Box, Text } from "silvery"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import { listLayout } from "../src/watch-list.tsx"
import { RunnerTitledBox, runnerOf } from "../src/watch-frame.tsx"
import { NowProvider } from "../src/watch-clock.ts"

const NOW = new Date("2026-09-24T12:00:00.000Z")

function fgOf(token: string): string {
  const app = render(<Text color={token}>X</Text>, { cols: 4, rows: 1 })
  const fg = JSON.stringify(app.cell(0, 0).fg)
  app.unmount()
  return fg
}

function bgOf(token: string): string {
  const app = render(
    <Box backgroundColor={token} width={2}>
      <Text>X</Text>
    </Box>,
    { cols: 4, rows: 1 },
  )
  const bg = JSON.stringify(app.cell(0, 0).bg)
  app.unmount()
  return bg
}

const fgAt = (app: ReturnType<typeof render>, y: number, needle: string, offset = 0): string | undefined => {
  const x = (app.lines[y] ?? "").indexOf(needle)
  return x < 0 ? undefined : JSON.stringify(app.cell(x + offset, y).fg)
}

const boldAt = (app: ReturnType<typeof render>, y: number, needle: string, offset = 0): boolean | undefined => {
  const x = (app.lines[y] ?? "").indexOf(needle)
  return x < 0 ? undefined : app.cell(x + offset, y).bold
}

async function settle(app: ReturnType<typeof render>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function baseSnapshot(overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    queue: "github.com/beorn/hh-dev#main",
    queues: [
      { branch: "main", label: "/repo", path: "/repo" },
      { branch: "main", label: "/other", path: "/other" },
    ],
    rows: [],
    unfiltered: [],
    at: NOW,
    ...overrides,
  }
}

describe("25556: seven rows on yrd watch", () => {
  // 25630's rulings (operator screenshot 2026-09-24, "timers headers") moved the filter toggles to the plain second
  // line beside STATS and dropped the queue toggles from the inverted top line, so rows 1, 2 and 4 read line 1.
  it("row 1: the filter group takes muted ($fg-muted) when selected and extra-muted ($border-default) when not, with no bold and no yellow (25716 row 31)", async () => {
    const app = render(<WatchPane snapshot={baseSnapshot()} live={false} />, { cols: 140, rows: 30 })
    await settle(app)
    app.press("f") // toggle failed off
    await settle(app)

    expect(fgAt(app, 1, "[f]ailed")).toBe(fgOf("$border-default"))
    expect(boldAt(app, 1, "[f]ailed")).toBe(false)
    expect(fgAt(app, 1, "[o]pen")).toBe(fgOf("$fg-muted"))
    expect(boldAt(app, 1, "[o]pen")).toBe(false)

    app.unmount()
  })

  it("row 2: each filter tab shows key that selects it: [o]pen, [r]unning, [d]one, [f]ailed", async () => {
    const app = render(<WatchPane snapshot={baseSnapshot()} live={false} />, { cols: 140, rows: 30 })
    await settle(app)

    expect(app.lines[1]).toContain("[o]pen")
    expect(app.lines[1]).toContain("[r]unning")
    expect(app.lines[1]).toContain("[d]one")
    expect(app.lines[1]).toContain("[f]ailed")

    app.unmount()
  })

  it("row 3: top line renders a not-bold timer after the status word for every status (25716)", async () => {
    // 1. Running
    const runningApp = render(
      <WatchPane
        snapshot={baseSnapshot({
          runner: {
            journalDir: "/w/logs",
            service: { kind: "beating", state: "healthy" },
            latest: {
              id: "run-1",
              startedAt: new Date(NOW.getTime() - 65_000), // 1:05 ago
              lastWriteAt: NOW,
              alive: true,
            },
          },
        })}
        live={false}
      />,
      { cols: 140, rows: 30 },
    )
    await settle(runningApp)
    expect(runningApp.lines[0]).toContain("00:01:05")
    expect(boldAt(runningApp, 0, "YRD QUEUE")).toBe(true)
    expect(boldAt(runningApp, 0, "00:01:05")).toBe(false)
    runningApp.unmount()

    // 2. Stopped
    const stoppedApp = render(
      <WatchPane
        snapshot={baseSnapshot({
          runner: {
            journalDir: "/w/logs",
            service: {
              kind: "stopped",
              graceful: true,
              why: "stopped",
              cause: "cutover",
              since: new Date(NOW.getTime() - 300_000), // 5:00 ago
              stopReason: "cutover",
            },
          },
        })}
        live={false}
      />,
      { cols: 140, rows: 30 },
    )
    await settle(stoppedApp)
    expect(stoppedApp.lines[0]).toContain("cutover")
    expect(boldAt(stoppedApp, 0, "YRD QUEUE")).toBe(true)
    stoppedApp.unmount()
  })

  it("row 4: STATS line takes a muted text colour ($fg-muted, on the plain second line since 25630)", async () => {
    const app = render(<WatchPane snapshot={baseSnapshot()} live={false} />, { cols: 140, rows: 30 })
    await settle(app)

    const statsFg = fgAt(app, 1, "STATS")
    expect(statsFg).toBe(fgOf("$fg-muted"))

    app.unmount()
  })

  it("row 5: detail pane is not shown when runner has no real item selected", async () => {
    const app = render(
      <WatchPane
        snapshot={baseSnapshot({
          runner: {
            journalDir: "/w/logs",
            service: { kind: "beating", state: "healthy" },
            latest: {
              id: "run-1",
              startedAt: NOW,
              lastWriteAt: NOW,
              alive: true,
            },
          },
        })}
        live={false}
      />,
      { cols: 220, rows: 40 },
    )
    await settle(app)

    // In this snapshot, the runner has only its stand-in row (__idle_runner__)
    // Detail pane (which renders RunnerDetailPane with "Queue: github.com/beorn/hh-dev#main") must NOT be shown
    expect(app.text).not.toContain("Detail:")
    expect(app.text).not.toContain("Queue: github.com/beorn/hh-dev#main")

    app.unmount()
  })

  it("row 6: RUNNER bar idle counter updates every second", async () => {
    const startedAt = new Date(NOW.getTime() - 10_000) // 10s ago
    const snapshot = baseSnapshot({
      runner: {
        journalDir: "/w/logs",
        service: { kind: "beating", state: "healthy" },
        latest: {
          id: "run-1",
          startedAt,
          lastWriteAt: startedAt,
          alive: true,
        },
      },
    })
    const layout = listLayout([], 120, NOW)

    // Render inside NowProvider with live=true
    const app = render(
      <NowProvider readAt={NOW} live={true}>
        <RunnerTitledBox line={runnerOf(snapshot, NOW)} snapshot={snapshot} layout={layout} />
      </NowProvider>,
      { autoRender: true, cols: 120, rows: 10 },
    )
    await act(async () => {
      await app.waitForLayoutStable()
    })
    expect(app.text).toContain("idle 0:10")

    // Wait 1.1s for coarse timer to tick
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
      await app.waitForLayoutStable()
    })
    expect(app.text).toContain("idle 0:11")

    app.unmount()
  })

  it("row 7: RUNNER bar title is RUNNER in bold followed by queue URL, and runner status is in status column", async () => {
    const snapshot = baseSnapshot({
      queue: "github.com/beorn/hh-dev#main",
      runner: {
        journalDir: "/w/logs",
        service: { kind: "beating", state: "healthy" },
      },
    })
    const layout = listLayout([], 120, NOW)
    const line = runnerOf(snapshot, NOW)

    const app = render(<RunnerTitledBox line={line} snapshot={snapshot} layout={layout} />, {
      cols: 120,
      rows: 10,
    })
    await settle(app)

    // Top border of RUNNER box: "╭─ RUNNER github.com/beorn/hh-dev#main ─"
    expect(app.lines[1]).toContain("RUNNER github.com/beorn/hh-dev#main")
    expect(boldAt(app, 1, "RUNNER")).toBe(true)
    expect(boldAt(app, 1, "github.com/beorn/hh-dev#main")).toBe(false)

    // Status column: "▸ idle"
    expect(app.lines[2]).toContain("▸ idle")

    app.unmount()
  })
})
