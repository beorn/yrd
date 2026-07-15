import { createElement } from "react"
import { Box } from "silvery"
import { createRenderer, waitFor } from "silvery/test"
import { describe, expect, it } from "vitest"
import { QueueArtifactOutputView, type QueueArtifactOutput } from "../src/watch-pane.tsx"

function artifactOutput(lineCount: number): QueueArtifactOutput {
  return {
    run: "run-a15",
    step: "check",
    attempt: 1,
    path: "/tmp/run-a15-check.log",
    text: Array.from({ length: lineCount }, (_, index) => `line ${String(index + 1).padStart(3, "0")}`).join("\n"),
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
  it("announces paused unseen output and resumes following with End", async () => {
    const render = createRenderer({ cols: 80, rows: 12 })
    const app = render(outputFrame(80))

    expect(app.text).toContain("FOLLOWING END")

    for (let index = 0; index < 12; index += 1) await app.wheel(40, 5, -3)
    expect(app.text).toContain("FOLLOW PAUSED | End resumes")

    app.rerender(outputFrame(81))
    expect(app.text).toContain("FOLLOW PAUSED | 1 new line | End resumes")
    expect(app.text).not.toContain("line 081")

    await app.press("End")
    expect(app.text).toContain("FOLLOWING END")
    expect(app.text).not.toContain("FOLLOW PAUSED")
    expect(app.text).toContain("line 081")

    app.rerender(outputFrame(82))
    await waitFor(() => app.text.includes("line 082"))
  })
})
