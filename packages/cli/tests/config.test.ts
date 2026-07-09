import { describe, expect, it } from "vitest"
import { loadYrdConfig, parseYrdConfig } from "../src/config.ts"

describe("Yrd config", () => {
  it("parses the complete project policy", () => {
    expect(
      parseYrdConfig(
        Bun.YAML.parse(`
line: { base: main, batch: 4, steps: [check, review, merge, deploy] }
steps:
  check: bun run check
  review: { run: bun run review, runner: waiting }
  merge: { run: git merge --no-ff "$YRD_TARGET" }
  deploy: bun run deploy
contest: { concurrency: 2, timeoutMs: 1800000, evaluators: [check] }
`),
      ),
    ).toEqual({
      line: { base: "main", batch: 4, steps: ["check", "review", "merge", "deploy"] },
      steps: {
        check: { run: "bun run check", runner: "local" },
        review: { run: "bun run review", runner: "waiting" },
        merge: { run: 'git merge --no-ff "$YRD_TARGET"', runner: "local" },
        deploy: { run: "bun run deploy", runner: "local" },
      },
      contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["check"] },
    })
  })

  it("loads one file and fills useful defaults", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "trunk",
      read: () => Promise.resolve("line: { batch: 3 }"),
    })
    expect(loaded).toMatchObject({
      path: "/repo/.yrd.yml",
      config: {
        line: { base: "trunk", batch: 3, steps: ["check", "merge"] },
        steps: { check: { runner: "local" }, merge: { runner: "local" } },
        contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["check"] },
      },
    })
  })

  it.each([
    [{ legacy: true }, "legacy is not supported"],
    [{ line: { batch: 1.5 } }, "line.batch must be an integer >= 0"],
    [{ line: { steps: ["check", "check"] } }, "line.steps contains duplicate steps"],
    [{ steps: { check: { runner: "remote" } } }, "steps.check.runner must be local or waiting"],
    [{ contest: { concurrency: 0 } }, "contest.concurrency must be an integer >= 1"],
  ])("rejects invalid policy %#", (value, message) => {
    expect(() => parseYrdConfig(value)).toThrow(message)
  })
})
