import { describe, expect, it } from "vitest"
import { loadYrdConfig, parseYrdConfig, type YrdConfigSource } from "../src/config.ts"

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

describe("loadYrdConfig", () => {
  function source(files: Record<string, string> = {}, git: Record<string, string> = {}): YrdConfigSource {
    return {
      readText: (path) => Promise.resolve(files[path]),
      gitGet: (key) => Promise.resolve(git[key]),
    }
  }

  it("resolves file policy over current bay.* Git config and explicit defaults", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "trunk",
      source: source(
        {
          "/repo/.yrd.yml": `
line:
  batch: 3
  steps: [check, merge, deploy]
steps:
  check: { run: bun run test:file }
  deploy: { run: bun run deploy }
`,
        },
        {
          "bay.base": "release/2.0",
          "bay.batch": "8",
          "bay.check": "bun run test:git",
          "bay.merge": "git merge --no-ff \"$YRD_TARGET\"",
        },
      ),
    })

    expect(loaded.path).toBe("/repo/.yrd.yml")
    expect(loaded.config).toMatchObject({
      line: { base: "release/2.0", batch: 3, steps: ["check", "merge", "deploy"] },
      steps: {
        check: { run: "bun run test:file", runner: "local" },
        merge: { run: 'git merge --no-ff "$YRD_TARGET"', runner: "local" },
        deploy: { run: "bun run deploy", runner: "local" },
      },
      contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["check"] },
    })
  })

  it("derives a fail-closed built-in workflow without reading retired config", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      source: source({}, { "bay.autoQueue": "true", "bay.autoMerge": "true" }),
    })

    expect(loaded.config.line).toEqual({ base: "main", batch: 1, steps: ["check", "merge"] })
    expect(loaded.config.steps.check?.run).toContain("git diff --check")
    expect(loaded.config.steps).not.toHaveProperty("autoQueue")
  })

  it("refuses the retired file instead of silently dual-reading it", async () => {
    await expect(
      loadYrdConfig({
        repo: "/repo",
        defaultBase: "main",
        source: source({ "/repo/.gitbay.yml": "line: {}" }),
      }),
    ).rejects.toThrow("retired .gitbay.yml")
  })
})
