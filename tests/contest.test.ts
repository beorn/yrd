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

  it("keeps model-specific Claude variants in ag instead of yrd built-ins", () => {
    expect(() => builtInAgentCommand("claude-opus", "fix it")).toThrow("built-ins: codex, claude")
  })
})

describe("contest metrics", () => {
  it("extracts token and cost evidence from mixed runner logs", () => {
    const text = [
      "human log line",
      JSON.stringify({ usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 }, cost_usd: 0.0123 }),
      JSON.stringify({ modelUsage: { "claude-opus": { cacheCreationInputTokens: 6, cacheReadInputTokens: 12 } } }),
      JSON.stringify({ totalTokens: 22 }),
    ].join("\n")

    expect(extractMetrics(text, "runner-output")).toEqual({
      inputTokens: 10,
      cachedInputTokens: 4,
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 12,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 22,
      costUsd: 0.0123,
      source: "runner-output",
    })
  })
})
