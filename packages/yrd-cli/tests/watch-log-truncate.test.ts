// @failure A single long log line (a vitest path row, a git remote error, a bun install
// progress line) wraps across many rows in the watch detail pane, so a handful of log
// lines fills the whole pane and the operator loses the run-facts/steps context above.
// Log rows must render ONE terminal row each — truncated, never wrapped — with the
// linked artifact-path row as the escape hatch for full content.
// @level l2
// @consumer yrd watch / queue list --watch detail pane log rows

import { createElement } from "react"
import { Box, renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { QueueArtifactOutputView, QueueInlineArtifactOutputRows, type QueueArtifactOutput } from "../src/watch-pane.tsx"

const HEAD = "HEAD-OF-LINE"
const TAIL = "TAIL-MARKER-BEYOND-WIDTH"
// One log line far wider than the 40-col frame: head, filler, distinctive tail.
const LONG_LINE = `${HEAD} ${"x".repeat(120)} ${TAIL}`

function longOutput(): QueueArtifactOutput {
  return {
    source: "recorded",
    run: "run-trunc",
    step: "check",
    attempt: 1,
    path: "/tmp/run-trunc-check.log",
    text: `${LONG_LINE}\nsecond line`,
    truncatedBytes: 0,
  }
}

describe("watch log rows truncate instead of wrapping", () => {
  it("tail list: a long line occupies one row — its overflow never renders", async () => {
    const frame = await renderString(
      createElement(
        Box,
        { width: 40, height: 12, flexDirection: "column" },
        createElement(QueueArtifactOutputView, { outputs: [longOutput()] }),
      ),
      { width: 40, height: 12, plain: true },
    )
    expect(frame).toContain(HEAD)
    expect(frame).toContain("second line")
    // Wrapped rendering spills the filler + tail onto later rows; truncation clips them.
    expect(frame).not.toContain(TAIL)
    const fillerRows = frame.split("\n").filter((row) => row.includes("xxxx")).length
    expect(fillerRows).toBeLessThanOrEqual(1)
  })

  it("detail-pane inline rows: a long line occupies one row — its overflow never renders", async () => {
    const frame = await renderString(
      createElement(
        Box,
        { width: 40, height: 12, flexDirection: "column" },
        createElement(QueueInlineArtifactOutputRows, { outputs: [longOutput()] }),
      ),
      { width: 40, height: 12, plain: true },
    )
    expect(frame).toContain(HEAD)
    expect(frame).toContain("second line")
    expect(frame).not.toContain(TAIL)
    const fillerRows = frame.split("\n").filter((row) => row.includes("xxxx")).length
    expect(fillerRows).toBeLessThanOrEqual(1)
  })
})
