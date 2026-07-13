/**
 * @failure Project configuration accepts ambiguous policy or resolves defaults differently from the CLI contract.
 * @level l1
 * @consumer @yrd/cli configuration
 */
import { describe, expect, it } from "vitest"
import { loadYrdConfig, parseYrdConfig } from "../src/config.ts"

describe("Yrd config", () => {
  it("parses the flat queue policy and top-level step definitions", () => {
    expect(
      parseYrdConfig(
        Bun.YAML.parse(`
base: main
batch: 4
steps: [check, review, merge, deploy]
requires: [review]
check: { run: bun run check, classification: base }
review: { run: bun run review, runner: waiting }
merge: { run: git merge --no-ff "$YRD_TARGET" }
deploy: bun run deploy
contest: { concurrency: 2, timeoutMs: 1800000, evaluators: [check] }
`),
      ),
    ).toEqual({
      base: "main",
      batch: 4,
      steps: ["check", "review", "merge", "deploy"],
      requires: ["review"],
      definitions: {
        check: { run: "bun run check", runner: "local", classification: "base" },
        review: { run: "bun run review", runner: "waiting" },
        merge: { run: 'git merge --no-ff "$YRD_TARGET"', runner: "local" },
        deploy: { run: "bun run deploy", runner: "local" },
      },
      contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["check"] },
    })
  })

  it("refuses the retired wrapper and teaches the flat shape", () => {
    const retiredWrapper = ["li", "ne"].join("")
    expect(() => parseYrdConfig({ [retiredWrapper]: { base: "main", batch: 1, steps: ["check", "merge"] } })).toThrow(
      `remove '${retiredWrapper}:' and configure base, batch, steps, and step definitions at the top level`,
    )
  })

  it("loads one file and fills useful defaults", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "trunk",
      read: () => Promise.resolve("batch: 3"),
    })
    expect(loaded).toMatchObject({
      path: "/repo/.yrd.yml",
      config: {
        base: "trunk",
        batch: 3,
        steps: ["check", "merge"],
        requires: [],
        definitions: { check: { runner: "local" }, merge: { runner: "local" } },
        contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["check"] },
      },
    })
  })

  it.each([
    [{ legacy: true }, "legacy is not supported"],
    [{ batch: 1.5 }, "batch must be an integer >= 0"],
    [{ steps: ["check", "check"] }, "steps contains duplicate steps"],
    [{ requires: ["approval"] }, "requires"],
    [{ requires: ["review", "review"] }, "requires contains duplicate requirements"],
    [{ check: { run: "bun run check", classification: "branch" } }, "check.classification"],
    [{ check: { runner: "remote" } }, "check.runner must be local or waiting"],
    [{ contest: { concurrency: 0 } }, "contest.concurrency must be an integer >= 1"],
  ])("rejects invalid policy %#", (value, message) => {
    expect(() => parseYrdConfig(value)).toThrow(message)
  })
})

describe("Yrd config — step timeoutMs (21012 S1: local steps cannot be silently unbounded)", () => {
  it("accepts a declarative per-step timeoutMs and threads it through parsing", () => {
    const parsed = parseYrdConfig(
      Bun.YAML.parse(`
check: { run: bun run check, timeoutMs: 60000 }
`),
    )
    expect(parsed.definitions.check).toEqual({ run: "bun run check", runner: "local", timeoutMs: 60_000 })
  })

  it("rejects a nonsense bound instead of silently accepting it", () => {
    expect(() =>
      parseYrdConfig(
        Bun.YAML.parse(`
check: { run: bun run check, timeoutMs: 0 }
`),
      ),
    ).toThrow()
  })
})
