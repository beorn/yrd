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
notify:
  pr/rejected: [submitter, "@ci"]
  pr/needs-review: ["@cto"]
  pr/integrated: [broadcast]
  run/failed: [submitter, "@ci"]
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
      notify: {
        "pr/rejected": ["submitter", "@ci"],
        "pr/needs-review": ["@cto"],
        "pr/integrated": ["broadcast"],
        "run/failed": ["submitter", "@ci"],
      },
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
        notify: {},
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
    [{ notify: { "pr/typo": ["submitter"] } }, "notify.pr/typo"],
    [{ notify: { "pr/rejected": ["reviewer"] } }, "notify.pr/rejected"],
    [{ notify: { "pr/rejected": ["submitter", "submitter"] } }, "duplicate notification targets"],
    [{ notify: { "pr/needs-review": ["broadcast"] } }, "notify.pr/needs-review"],
    [{ notify: { "pr/integrated": ["submitter"] } }, "notify.pr/integrated"],
    [{ notify: { "run/failed": ["broadcast"] } }, "notify.run/failed"],
  ])("rejects invalid policy %#", (value, message) => {
    let failure: unknown
    try {
      parseYrdConfig(value)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ failure: { kind: "configuration", code: "invalid-config" } })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(message)
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

describe("Yrd config — step noProgressMs (a silent child must stall, never wedge the queue)", () => {
  it("accepts a declarative per-step noProgressMs and threads it through parsing", () => {
    const parsed = parseYrdConfig(
      Bun.YAML.parse(`
check: { run: bun run check, noProgressMs: 600000 }
`),
    )
    expect(parsed.definitions.check).toEqual({ run: "bun run check", runner: "local", noProgressMs: 600_000 })
  })

  it("rejects a nonsense no-progress bound instead of silently accepting it", () => {
    expect(() =>
      parseYrdConfig(
        Bun.YAML.parse(`
check: { run: bun run check, noProgressMs: 0 }
`),
      ),
    ).toThrow()
  })
})

describe("Yrd config — diagnostics comparison is explicit", () => {
  it("accepts the diagnostics comparator only when a step declares it", () => {
    const parsed = parseYrdConfig(
      Bun.YAML.parse(`
lint: { run: bun run lint, comparison: diagnostics }
test: { run: bun run test }
`),
    )

    expect(parsed.definitions.lint).toEqual({
      run: "bun run lint",
      runner: "local",
      comparison: "diagnostics",
    })
    expect(parsed.definitions.test).toEqual({ run: "bun run test", runner: "local" })
  })

  it("rejects an unknown comparison contract", () => {
    expect(() =>
      parseYrdConfig(
        Bun.YAML.parse(`
check: { run: bun run check, comparison: output }
`),
      ),
    ).toThrow()
  })

  it.each([{ runner: "waiting", run: "launch-lint", comparison: "diagnostics" }, { comparison: "diagnostics" }])(
    "rejects a diagnostics comparator that no local command can honor",
    (step) => {
      expect(() => parseYrdConfig({ lint: step })).toThrow()
    },
  )
})
