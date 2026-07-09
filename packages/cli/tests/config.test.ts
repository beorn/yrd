import { describe, expect, it } from "vitest"
import { parseYrdConfig } from "../src/config.ts"

describe("parseYrdConfig", () => {
  it("parses a GitHub-Actions-shaped policy over installed Yrd plugins", () => {
    expect(
      parseYrdConfig(
        Bun.YAML.parse(`
version: 1
line:
  base: main
  batch: 4
  steps: [check, review, merge, deploy]
steps:
  check:
    run: bun run check
  review:
    run: bun run review
    runner: waiting
  merge:
    run: git merge --no-ff "$YRD_TARGET"
  deploy:
    run: bun run deploy
contest:
  concurrency: 2
  timeoutMs: 1800000
  evaluators: [check]
`),
      ),
    ).toEqual({
      version: 1,
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

  it("keeps an empty document minimal so host defaults remain explicit", () => {
    expect(parseYrdConfig(undefined)).toEqual({ version: 1, line: {}, steps: {}, contest: {} })
  })

  it.each([
    [{ legacy: true }, "unknown top-level key 'legacy'"],
    [{ version: 2 }, "version must be 1"],
    [{ line: { batch: 1.5 } }, "line.batch must be false or a non-negative integer"],
    [{ line: { steps: ["check", "check"] } }, "line.steps contains duplicate step 'check'"],
    [{ steps: { check: { run: "" } } }, "steps.check.run must be a non-empty string"],
    [{ steps: { check: { runner: "remote" } } }, "steps.check.runner must be 'local' or 'waiting'"],
    [{ contest: { concurrency: 0 } }, "contest.concurrency must be a positive integer"],
  ])("refuses malformed or legacy configuration: %j", (input, message) => {
    expect(() => parseYrdConfig(input)).toThrow(message)
  })
})
