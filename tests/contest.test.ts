import { describe, expect, it } from "vitest"
import { builtInAgentCommand, extractMetrics } from "../src/contest.ts"

describe("contest agent commands", () => {
  it("runs Codex through ag's native codex exec path", () => {
    expect(builtInAgentCommand("codex", "fix it")).toEqual(["ag", "codex", "exec", "--json", "--", "fix it"])
  })

  it("runs Claude through ag's native prompt JSON path", () => {
    expect(builtInAgentCommand("claude", "fix it")).toEqual([
      "ag",
      "claude",
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--",
      "fix it",
    ])
  })
})

describe("contest metrics", () => {
  it("extracts token and cost evidence from mixed runner logs", () => {
    const text = [
      "human log line",
      JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.0123 }),
      JSON.stringify({ totalTokens: 22 }),
    ].join("\n")

    expect(extractMetrics(text, "runner-output")).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 22,
      costUsd: 0.0123,
      source: "runner-output",
    })
  })
})
