import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { applyCostAdapter, builtInAgentCommand, contestRecords, extractMetrics, withContests } from "../src/contest.ts"
import { createGitbay, createJsonlJournal, pipe } from "../src/index.ts"
import type { BayEvent, BayStore } from "../src/index.ts"

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
      costSource: "runner-output",
      source: "runner-output",
    })
  })

  it("applies configured token rates without guessing missing runner cost", () => {
    const metrics = extractMetrics(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }), "runner-output")

    expect(applyCostAdapter(metrics, undefined, "configured:codex")).toEqual(metrics)
    expect(applyCostAdapter(metrics, { inputTokensUsdPerMillion: 1000, outputTokensUsdPerMillion: 2000 }, "configured:codex")).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.02,
      costSource: "configured:codex",
      costRates: { inputTokensUsdPerMillion: 1000, outputTokensUsdPerMillion: 2000 },
    })
  })

  it("preserves runner-reported cost over configured token rates", () => {
    const metrics = extractMetrics(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.01 }), "runner-output")

    expect(applyCostAdapter(metrics, { inputTokensUsdPerMillion: 1000, outputTokensUsdPerMillion: 2000 }, "configured:codex")).toMatchObject({
      costUsd: 0.01,
      costSource: "runner-output",
    })
  })
})

describe("contest state layer", () => {
  it("folds contest lifecycle events into a withContests state slice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yrd-contest-layer-"))
    const journal = createJsonlJournal(join(dir, "events.jsonl"))
    const store: BayStore = { journal, close: async () => {} }
    const cause = { commandId: "test" }
    let nextId = 0
    const event = (name: BayEvent["name"], data: BayEvent["data"], ts = "2026-01-01T00:00:00.000Z"): BayEvent => {
      nextId++
      return { id: `e${nextId}`, name, ts, cause, data }
    }

    await journal.append(
      event("contest/opened", {
        contest: "C1",
        task: "make-answer",
        prompt: "write answer",
        repo: "/repo",
        base: "main",
        baseSha: "base",
        agents: ["codex"],
      }),
    )
    await journal.append(
      event("contest/attempt/started", {
        contest: "C1",
        attempt: "A1",
        agent: "codex",
        bay: "contest-c1-codex",
        bayPath: "/repo/.bays/wt1",
        command: ["ag", "codex"],
        startedAt: "2026-01-01T00:00:01.000Z",
      }),
    )
    await journal.append(
      event("contest/attempt/finished", {
        contest: "C1",
        attempt: "A1",
        agent: "codex",
        bay: "contest-c1-codex",
        bayPath: "/repo/.bays/wt1",
        startedAt: "2026-01-01T00:00:01.000Z",
        finishedAt: "2026-01-01T00:00:03.000Z",
        exitCode: 0,
        durationMs: 2000,
        logs: { stdout: "/tmp/stdout.log", stderr: "/tmp/stderr.log" },
        metrics: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "runner-output" },
        git: {
          baseSha: "base",
          headSha: "head",
          committed: true,
          changedFiles: ["answer.txt"],
          status: "",
          diffStat: "answer.txt | 1 +",
        },
        evals: [{ command: "test -f answer.txt", startedAt: "s", finishedAt: "f", durationMs: 1, exitCode: 0, stdout: "", stderr: "" }],
      }),
    )
    await journal.append(event("contest/selected", { contest: "C1", winner: "A1" }))
    await journal.append(
      event("contest/promoted", {
        contest: "C1",
        attempt: "A1",
        pr: "PR1",
        push: { code: 0, stdout: "", stderr: "" },
        submit: { code: 0, stdout: "merged", stderr: "" },
      }),
    )

    const bay = pipe(createGitbay({ store, clock: () => "2026-01-01T00:00:00.000Z" }), withContests())
    const record = contestRecords(await bay.state()).C1

    expect(record).toMatchObject({
      id: "C1",
      task: "make-answer",
      attempts: [{ id: "A1", agent: "codex", command: ["ag", "codex"], metrics: { totalTokens: 15 } }],
      winner: "A1",
      promoted: { attempt: "A1", pr: "PR1", submit: { stdout: "merged" } },
    })
  })
})
