/**
 * @failure The production queue story can pass submodule-renderer tests while
 * the real PTY output hides the selected JOB detail or drops the STATS frame's
 * right border at the live split-pane width.
 * @level l3
 * @consumer @yrd/cli queue watch
 */
import { resolve } from "node:path"
import { createTestTerminal } from "@termless/test"
import { describe, expect, it } from "vitest"

const yrdRoot = resolve(import.meta.dirname, "../../..")
const storybook = resolve(yrdRoot, "packages/yrd-cli/dev/queue-timeline-storybook.tsx")

function expectCleanFrame(text: string, title: string): void {
  const rows = text.split("\n")
  const topIndex = rows.findIndex((row) => row.includes(`╭─ ${title} `))
  expect(topIndex, `top border for ${title}`).toBeGreaterThanOrEqual(0)
  const top = rows[topIndex]!
  const left = top.indexOf(`╭─ ${title} `)
  const right = top.indexOf("╮", left)
  expect(right, `top-right corner for ${title}`).toBeGreaterThan(left)

  let bottomIndex = -1
  for (let index = topIndex + 1; index < rows.length; index += 1) {
    if (rows[index]![left] === "╰") {
      bottomIndex = index
      break
    }
    expect(rows[index]![left], `${title} left border at row ${index}`).toBe("│")
    expect(rows[index]![right], `${title} right border at row ${index}`).toBe("│")
  }
  expect(bottomIndex, `bottom border for ${title}`).toBeGreaterThan(topIndex)
  expect(rows[bottomIndex]![right], `${title} bottom-right corner`).toBe("╯")
  expect(/^[─]+$/u.test(rows[bottomIndex]!.slice(left + 1, right)), `${title} bottom edge unbroken`).toBe(true)
}

describe("queue timeline storybook PTY", () => {
  it("keeps the selected JOB visible and the live-width STATS frame intact", async () => {
    // 243 columns resolves the open right-hand split to a 126-cell queue pane,
    // the width where Silvery 0.23.1 exposed the missing-right-border defect.
    const terminal = createTestTerminal({ cols: 243, rows: 60 })
    try {
      await terminal.spawn([process.execPath, storybook], {
        cwd: yrdRoot,
        env: {
          ...process.env,
          FORCE_COLOR: "1",
          SILVERY_STRICT: "2",
          TERM: "xterm-256color",
        },
      })
      await terminal.waitFor("STATS", 10_000)
      await terminal.waitFor("JOB yrd#J42-check", 10_000)
      await terminal.waitForStable(100, 2_000)

      expect(terminal.getText()).toContain("JOB yrd#J42-check")
      expectCleanFrame(terminal.getText(), "STATS")
    } finally {
      if (terminal.alive) terminal.press("q")
      await terminal.close()
    }
  }, 15_000)
})
