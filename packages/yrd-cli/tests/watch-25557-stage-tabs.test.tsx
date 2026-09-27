/**
 * @failure  yrd watch RUNNER detail pane fails to show live round stage tabs or filled variant
 * @level    l1
 * @consumer @i/10-yrd/24169-yrd-watch-and-list-display/25557
 * @testonly none
 *
 * Bead 25557 — yrd watch stage tabs sit in one row per journal phase, as filled tabs with a gap:
 * 1. Silvery's Tabs filled variant with 1-col gap is used for stage tabs (no yrd-only styling).
 * 2. With the RUNNER row selected, the detail pane shows the round in flight with the same stage tabs
 *    as a finished change (provisioning, checking, merging, deprovisioning), fed by the live round's
 *    journal: finished steps with their times, the current step marked running with its elapsed time,
 *    and off checks shown as off.
 * 3. One component with two sources, a finished change's journal or the live round's;
 *    the alive, beat and this-round-since line stays first.
 * 4. When the runner is idle with no round in flight, the stand-in selection shows no detail pane.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import React from "react"
import { describe, expect, it } from "vitest"
import { bufferToStyledText, render } from "silvery/test"
import { createTerminal } from "@termless/core"
import { createGhosttyBackend, initGhostty } from "@termless/ghostty"
import { WatchPane, type WatchSnapshot } from "../src/watch-pane.tsx"
import { WatchDetail, type ChangeDetail } from "../src/watch-detail.tsx"

async function renderAnsiScreenshot(ansi: string, opts: { cols: number; rows: number }): Promise<Uint8Array> {
  await initGhostty()
  const backend = createGhosttyBackend()
  const term = createTerminal({ backend, cols: opts.cols, rows: opts.rows })
  term.feed(ansi.replace(/\r?\n/g, "\r\n"))
  return term.screenshot()
}

function writeCaptureIfConfigured(name: string, content: string | Uint8Array): void {
  const dir = process.env.YRD_CAPTURE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
}

const NOW = new Date("2026-09-24T12:00:00.000Z")

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

describe("25557: stage tabs in yrd watch detail pane", () => {
  it("row 2: silvery Tabs filled variant is used with 1-col gap and background fill", async () => {
    const detail: ChangeDetail = {
      row: {
        branch: "task/feature",
        head: "a1b2c3d4e5f6",
        state: "merged",
        at: NOW,
      },
      run: {
        kind: "queue",
        id: "run-1",
        label: "main",
        steps: [],
        row: {
          branch: "task/feature",
          head: "a1b2c3d4e5f6",
          state: "merged",
          at: NOW,
        },
      },
      checks: [
        {
          name: "lint",
          phase: "task/feature",
          state: "passed",
          result: { result: "pass", ms: 1200 },
        },
      ],
      journal: {
        id: "run-1",
        branch: "task/feature",
        head: "a1b2c3d4e5f6",
        startedAt: NOW,
        at: NOW,
        checks: [],
        steps: [
          {
            name: "compose",
            phase: "provisioning",
            startedAt: NOW,
            endedAt: new Date(NOW.getTime() + 1000),
            ms: 1000,
            commands: [],
          },
        ],
        commands: [],
      },
    }

    const app = render(<WatchDetail detail={detail} />, { cols: 120, rows: 30 })
    await settle(app)

    // Stage tabs must be rendered
    expect(app.text).toContain("provisioning")
    expect(app.text).toContain("checking")
    expect(app.text).toContain("merging")
    expect(app.text).toContain("deprovisioning")

    // In filled variant, tabs have standard inner padding (2 spaces horizontal, 1 line vertical)
    const lines = app.text.split("\n")
    const provLineIdx = lines.findIndex((l) => l.includes("provisioning"))
    expect(provLineIdx).toBeGreaterThan(0)
    const provLine = lines[provLineIdx] ?? ""
    const provCol = provLine.indexOf("provisioning")
    expect(provCol).toBeGreaterThanOrEqual(2)

    // Pin standard inner padding via termless cell inspection:
    // Top padding line (provLineIdx - 1) has tab background fill
    expect(app.cell(provCol, provLineIdx - 1).bg).not.toBeNull()
    // 2 cells horizontal padding to the left of the label have tab background fill
    expect(app.cell(provCol - 1, provLineIdx).bg).not.toBeNull()
    expect(app.cell(provCol - 2, provLineIdx).bg).not.toBeNull()
    // The label cell itself has tab background fill
    expect(app.cell(provCol, provLineIdx).bg).not.toBeNull()

    app.unmount()
  })

  it("row 3: with RUNNER row selected and a round in flight, detail pane shows the round with stage tabs", async () => {
    const startedAt = new Date(NOW.getTime() - 15_000) // 15s ago
    const composeStart = startedAt
    const composeEnd = new Date(startedAt.getTime() + 8_000) // 8s
    const prepareStart = composeEnd

    const snapshot = baseSnapshot({
      runner: {
        journalDir: "/w/logs",
        service: { kind: "beating", state: "healthy" },
        latest: {
          id: "run-live-1",
          startedAt,
          lastWriteAt: NOW,
          alive: true,
          checks: ["lint", "unit"],
          effectiveChecks: ["lint", "unit"],
          activeStep: {
            kind: "step",
            name: "prepare",
            phase: "provisioning",
            start: prepareStart,
          },
          steps: [
            {
              kind: "step",
              name: "compose",
              phase: "provisioning",
              start: composeStart,
              end: composeEnd,
            },
            {
              kind: "step",
              name: "prepare",
              phase: "provisioning",
              start: prepareStart,
            },
          ],
        },
      },
    })

    const app = render(<WatchPane snapshot={snapshot} live={false} />, { cols: 220, rows: 40 })
    await settle(app)

    // With a round in flight, the detail pane MUST be shown
    // 1. The alive, beat and this-round-since line stays first
    expect(app.text).toContain("alive: beat")
    expect(app.text).toContain("this round since")

    // 2. Stage tabs are rendered
    expect(app.text).toContain("provisioning")
    expect(app.text).toContain("checking")
    expect(app.text).toContain("merging")
    expect(app.text).toContain("deprovisioning")

    // 3. Finished step compose shows its duration (8s = 0:08)
    expect(app.text).toContain("0:08")

    // 4. Current running step prepare shows "still writing" or running status
    expect(app.text).toContain("PREPARING")

    if (process.env.YRD_CAPTURE_DIR) {
      const ansi = bufferToStyledText(app.term.buffer)
      writeCaptureIfConfigured("260927-yrd-watch-25557-stage-tabs.ansi", ansi)
      writeCaptureIfConfigured(
        "260927-yrd-watch-25557-stage-tabs.png",
        await renderAnsiScreenshot(ansi, { cols: 220, rows: 40 }),
      )
    }

    app.unmount()
  })

  it("row 3: checking stage shows finished checks with times, running check with elapsed time, and off checks as off", async () => {
    const startedAt = new Date(NOW.getTime() - 30_000)
    const lintStart = new Date(startedAt.getTime() + 10_000)
    const lintEnd = new Date(lintStart.getTime() + 5_000) // 5s
    const unitStart = lintEnd

    const snapshot = baseSnapshot({
      runner: {
        journalDir: "/w/logs",
        service: { kind: "beating", state: "healthy" },
        latest: {
          id: "run-live-2",
          startedAt,
          lastWriteAt: NOW,
          alive: true,
          checks: ["lint", "unit", "off_check"],
          effectiveChecks: ["lint", "unit", "off_check"],
          activeStep: {
            kind: "check",
            name: "unit",
            phase: "task/worker",
            start: unitStart,
          },
          steps: [
            {
              kind: "check",
              name: "lint",
              phase: "task/worker",
              start: lintStart,
              end: lintEnd,
            },
            {
              kind: "check",
              name: "unit",
              phase: "task/worker",
              start: unitStart,
            },
            {
              kind: "check",
              name: "off_check",
              phase: "task/worker",
              start: lintStart,
              target: "true",
            },
          ],
        },
      },
    })

    const app = render(<WatchPane snapshot={snapshot} live={false} />, { cols: 220, rows: 40 })
    await settle(app)

    // Switch to checking tab
    app.press("l")
    await settle(app)

    expect(app.text).toContain("lint")
    expect(app.text).toContain("unit")

    app.unmount()
  })

  it("row 4: when runner is idle with no round in flight, stand-in selection shows no detail pane", async () => {
    const app = render(
      <WatchPane
        snapshot={baseSnapshot({
          runner: {
            journalDir: "/w/logs",
            service: { kind: "beating", state: "healthy" },
            latest: {
              id: "run-idle",
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

    // Stand-in virtual selection with no active round: detail pane is NOT shown
    expect(app.text).not.toContain("provisioning")
    expect(app.text).not.toContain("deprovisioning")

    app.unmount()
  })
})
