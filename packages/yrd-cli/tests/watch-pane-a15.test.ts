import { pathToFileURL } from "node:url"
import { createElement } from "react"
import { Box, renderString } from "silvery"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { QueueArtifactOutputView, type QueueArtifactOutput } from "../src/watch-pane.tsx"

function artifactOutput(lineCount: number): Extract<QueueArtifactOutput, { source: "recorded" }> {
  return {
    source: "recorded",
    run: "run-a15",
    step: "check",
    attempt: 1,
    path: "/tmp/run-a15-check.log",
    text: Array.from({ length: lineCount }, (_, index) => `row ${String(index + 1).padStart(3, "0")}`).join("\n"),
    truncatedBytes: 0,
  }
}

function outputFrame(lineCount: number) {
  return createElement(
    Box,
    { width: 80, height: 12, flexDirection: "column" },
    createElement(QueueArtifactOutputView, { outputs: [artifactOutput(lineCount)] }),
  )
}

describe("QueueArtifactOutputView A15 tail following", () => {
  it("makes the full output file an OSC8 link", async () => {
    const output = artifactOutput(1)
    const frame = await renderString(
      createElement(Box, { width: 80, height: 12 }, createElement(QueueArtifactOutputView, { outputs: [output] })),
      { width: 80, height: 12, plain: false },
    )
    expect(frame).toContain("open full log")
    expect(frame).toContain(pathToFileURL(output.path).href)
  })

  it("renders a synthetic summary without inventing a full-log link", async () => {
    const summary: QueueArtifactOutput = {
      source: "summary",
      run: "R1",
      step: "merge",
      attempt: 1,
      text: "No output recorded.",
    }
    const frame = await renderString(
      createElement(Box, { width: 80, height: 12 }, createElement(QueueArtifactOutputView, { outputs: [summary] })),
      { width: 80, height: 12, plain: false },
    )
    expect(frame).toContain("No output recorded.")
    expect(frame).not.toContain("open full log")
    expect(frame).not.toContain("\u001b]8;;")
  })

  it("announces paused unseen output and resumes following with End", async () => {
    const render = createRenderer({ cols: 80, rows: 12 })
    const app = render(outputFrame(80))

    expect(app.text).toContain("FOLLOWING END")

    for (let index = 0; index < 12; index += 1) await app.wheel(40, 5, -3)
    expect(app.text).toContain("FOLLOW PAUSED | End resumes")

    app.rerender(outputFrame(81))
    expect(app.text).toMatch(/FOLLOW PAUSED \| 1 new \w+ \| End resumes/u)
    expect(app.text).not.toContain("row 081")

    await app.press("End")
    expect(app.text).toContain("FOLLOWING END")
    expect(app.text).not.toContain("FOLLOW PAUSED")
    expect(app.text).toContain("row 081")

    app.rerender(outputFrame(82))
    await waitFor(() => app.text.includes("row 082"))
  })
})
