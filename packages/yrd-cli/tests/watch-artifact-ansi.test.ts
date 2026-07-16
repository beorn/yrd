// @failure A check step's `output.log` tail (e.g. vitest's ` RUN  v4.1.10 <path>` banner) carries
// background SGR codes; rendered raw into the watch UI's log pane they collide with the pane's own
// background and silvery's background-conflict guard throws, killing the whole `yrd watch` event loop.
// @level l2
// @consumer yrd watch / queue list --watch log pane, queue detail table, journal feed

import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { Box } from "silvery"
import { describe, expect, it } from "vitest"
import { stripAnsi } from "../src/ansi.ts"
import { queueShowData } from "../src/queue-status-view.tsx"
import { fixtureJob, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { artifactOutputLines, QueueArtifactOutputView, type QueueArtifactOutput } from "../src/watch-pane.tsx"

// The exact line from the user-reproduced crash: vitest's run banner with a
// bold + black-fg + cyan-bg ` RUN ` segment, then version + path in fg colors.
const VITEST_BANNER =
  "\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m \x1b[36mv4.1.10 \x1b[39m\x1b[90m/Users/beorn/Code/hh/vendor/yrd\x1b[39m"

function bannerOutput(text: string): QueueArtifactOutput {
  return {
    run: "R1",
    step: "check",
    attempt: 1,
    path: "/artifacts/R1/0-check/attempt-1/output.log",
    text,
  }
}

describe("stripAnsi", () => {
  it("removes SGR (color/background/attribute) codes, keeping visible text", () => {
    const plain = stripAnsi(VITEST_BANNER)
    expect(plain).not.toMatch(/\x1b\[/u)
    expect(plain).toBe(" RUN  v4.1.10 /Users/beorn/Code/hh/vendor/yrd")
  })

  it("removes cursor and erase sequences, not just backgrounds", () => {
    expect(stripAnsi("a\x1b[2Jb\x1b[1Ac\x1b[Kd")).toBe("abcd")
  })

  it("removes OSC hyperlink sequences (BEL- and ST-terminated), keeping the label", () => {
    expect(stripAnsi("see \x1b]8;;https://x\x07link\x1b]8;;\x07 now")).toBe("see link now")
    expect(stripAnsi("title\x1b]0;window\x1b\\ kept")).toBe("title kept")
  })

  it("returns escape-free text unchanged", () => {
    expect(stripAnsi("125 tests collected")).toBe("125 tests collected")
  })
})

describe("artifactOutputLines", () => {
  it("sanitizes ANSI escapes out of the artifact log body before it becomes a renderable line", () => {
    const lines = artifactOutputLines([bannerOutput(`${VITEST_BANNER}\n`)])
    const body = lines.filter((line) => line.kind === "body")
    expect(body.length).toBeGreaterThan(0)
    for (const line of body) expect(line.text).not.toMatch(/\x1b\[/u)
    expect(body.map((line) => line.text).join("\n")).toContain(" RUN  v4.1.10 ")
  })

  it("keeps the yrd-constructed heading line intact", () => {
    const lines = artifactOutputLines([bannerOutput("checking one\n")])
    expect(lines.some((line) => line.kind === "heading" && line.text === "OUTPUT check#1")).toBe(true)
  })
})

describe("queueShowData structured fields", () => {
  // The queue detail table renders a step's captured stdout (output), error
  // message, and detail — all externally sourced. Every projected field must be
  // ANSI-free before it reaches the table's `<Text>` cells.
  it("strips ANSI from a failed step's output / error / detail", () => {
    const job = fixtureJob("J1", "failed", {
      output: "\x1b[46mFAIL RUN\x1b[49m tail",
      detail: "\x1b[33mflaky\x1b[39m: retry advised",
      error: { code: "check-failed", message: "\x1b[31mAssertionError\x1b[39m: expected true" },
    })
    const run = fixtureRun("R1", [], "failed", "2026-07-13T11:31:00.000Z", { steps: [fixtureStep("check", job)] })
    const row = queueShowData(run).steps.find((step) => step.step === "check")
    expect(row).toBeDefined()
    expect(row?.output).not.toMatch(/\x1b\[/u)
    expect(row?.error).not.toMatch(/\x1b\[/u)
    expect(row?.detail).not.toMatch(/\x1b\[/u)
    // Visible content is preserved.
    expect(row?.error).toContain("AssertionError")
  })

  it("strips ANSI from a lost step's lost-reason", () => {
    const job = fixtureJob("J2", "lost", { detail: "\x1b[46mrunner lease expired\x1b[49m" })
    const run = fixtureRun("R2", [], "failed", "2026-07-13T11:31:00.000Z", { steps: [fixtureStep("check", job)] })
    const row = queueShowData(run).steps.find((step) => step.step === "check")
    expect(row?.lost).not.toMatch(/\x1b\[/u)
    expect(row?.lost).toBe("runner lease expired")
  })
})

describe("QueueArtifactOutputView", () => {
  // Reproduces the live crash: the log pane inherits the watch UI's dark
  // background (rgb(50,50,50) == #323232), so a cyan-bg segment from the log
  // trips silvery's background-conflict guard (default mode: throw).
  it("renders a background-SGR-bearing log line over a dark pane without crashing", async () => {
    const render = createRenderer({ cols: 120, rows: 14 })
    const app = render(
      createElement(
        Box,
        { width: 120, height: 12, flexDirection: "column", backgroundColor: "#323232" },
        createElement(QueueArtifactOutputView, { outputs: [bannerOutput(`${VITEST_BANNER}\n`)] }),
      ),
    )
    try {
      await app.waitForLayoutStable()
      // The visible text survives as plain characters...
      expect(app.text).toContain("RUN")
      expect(app.text).toContain("v4.1.10")
      // ...and the log's own cyan background never reaches the emitted ANSI.
      expect(app.ansi).not.toContain("\x1b[46m")
    } finally {
      app.unmount()
    }
  })
})
