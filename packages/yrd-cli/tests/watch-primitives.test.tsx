/**
 * @failure  A box whose identity lived in a title row above it, not on its
 *           border (item 23), and marker-led lines whose wrapped text fell
 *           back under the marker instead of hanging off it (item 29a).
 * @level    l2 (a real silvery render into a headless terminal buffer)
 * @consumer the operator reading any `yrd watch` box
 */

import { describe, expect, it } from "vitest"
import { Text } from "silvery"
import { render } from "silvery/test"
import { MarkerRow, TitledBox } from "../src/watch-primitives.tsx"

async function paint(element: Parameters<typeof render>[0], cols = 40): Promise<string> {
  const app = render(element, { cols, rows: 8 })
  await app.waitForLayoutStable()
  const text = app.text
  app.unmount()
  return text
}

describe("TitledBox", () => {
  it("punches the left title and the right label into the top border", async () => {
    const text = await paint(
      <TitledBox title="RUNNER" titleRight="RUN main#170406">
        <Text>body</Text>
      </TitledBox>,
    )
    const [top] = text.split("\n")
    expect(top).toContain("╭─ RUNNER ─")
    expect(top).toContain("─ RUN main#170406 ─╮")
    expect(text).toContain("│ body")
  })

  it("carries only the right label when no left title is given, so the status box's border IS its identity", async () => {
    const text = await paint(
      <TitledBox titleRight="RUN main#170406">
        <Text>✓ merged</Text>
      </TitledBox>,
    )
    const [top] = text.split("\n")
    expect(top?.startsWith("╭──")).toBe(true)
    expect(top).toContain(" RUN main#170406 ─╮")
  })
})

describe("MarkerRow (item 29a)", () => {
  it("puts the marker in a gutter and hangs wrapped text off it", async () => {
    const text = await paint(
      <MarkerRow marker={<Text>$</Text>}>
        <Text wrap="wrap">alpha beta gamma delta epsilon zeta eta theta</Text>
      </MarkerRow>,
      20,
    )
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    expect(lines[0]?.startsWith("$ alpha")).toBe(true)
    // Every continuation line starts at the text column, two cells in, never under the marker.
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true)
    expect(lines.length).toBeGreaterThan(1)
  })

  it("reserves the gutter when there is no marker, so sibling rows share one text column", async () => {
    const text = await paint(
      <MarkerRow>
        <Text>aligned</Text>
      </MarkerRow>,
    )
    expect(text.split("\n")[0]?.startsWith("  aligned")).toBe(true)
  })
})
