/**
 * @failure Project configuration accepts ambiguous policy or resolves defaults differently from the CLI contract.
 * @level l1
 * @consumer @yrd/cli configuration
 */
import { describe, expect, it } from "vitest"
import { defineConfig, yrd } from "@yrd/config"
import { DIAGNOSTICS_COMPARISON_READY } from "@yrd/queue"
import { loadYrdConfig, parseYrdConfig, stepGateMode } from "../src/config.ts"

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
journal: { version: 1, reader: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa }
notify:
  pr/needs-author: [submitter]
  pr/rejected: [submitter, "@ci"]
  pr/needs-review: ["@cto"]
  pr/integrated: [broadcast]
  pr/already-landed: [submitter]
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
      journal: { version: 1, reader: "a".repeat(40) },
      notify: {
        "pr/needs-author": ["submitter"],
        "pr/rejected": ["submitter", "@ci"],
        "pr/needs-review": ["@cto"],
        "pr/integrated": ["broadcast"],
        "pr/already-landed": ["submitter"],
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

  it("parses the refuse boundary and rejects malformed shapes loudly", () => {
    expect(
      parseYrdConfig(
        Bun.YAML.parse(`
refuse:
  paths: ["@", "hub/"]
  reason: pm state lives in the sibling state repo
  exception:
    kind: state-decommission-v1
    issue: "@pm/infra/21489-pm-state-repo-split/22386-decommission-hh-state-roots"
    roots: ["+kanban.md", "@km", "hub/pm"]
    tombstone: |
      # PM state moved

      Authoritative PM state moved to hh-pm.
`),
      ).refuse,
    ).toEqual({
      paths: ["@", "hub/"],
      reason: "pm state lives in the sibling state repo",
      exception: {
        kind: "state-decommission-v1",
        issue: "@pm/infra/21489-pm-state-repo-split/22386-decommission-hh-state-roots",
        roots: ["+kanban.md", "@km", "hub/pm"],
        tombstone: "# PM state moved\n\nAuthoritative PM state moved to hh-pm.\n",
      },
    })
    expect(parseYrdConfig({}).refuse).toBeUndefined()
    expect(() => parseYrdConfig({ refuse: { paths: [] } })).toThrow()
    expect(() => parseYrdConfig({ refuse: { paths: ["@"], pointer: "x" } })).toThrow()
    expect(() =>
      parseYrdConfig({
        refuse: {
          paths: ["@"],
          exception: {
            kind: "state-decommission-v1",
            issue: "@pm/infra/21489-pm-state-repo-split/22386",
            roots: [],
            tombstone: "moved",
          },
        },
      }),
    ).toThrow()
  })

  it("parses the managed do block and keeps it out of the step definitions", () => {
    const parsed = parseYrdConfig(
      Bun.YAML.parse(`
steps: [merge]
merge: { run: git merge --no-ff "$YRD_TARGET" }
do:
  lane: "@dev/0"
  assign: tent assign "$YRD_DO_ISSUE" "$YRD_DO_LANE" --first
  launch:
    run: hab up "$YRD_DO_LANE"
    timeoutMs: 120000
  pollMs: 30000
  carrierTimeoutMs: 2700000
  landingTimeoutMs: 2700000
`),
    )
    expect(parsed.do).toEqual({
      lane: "@dev/0",
      assign: { run: 'tent assign "$YRD_DO_ISSUE" "$YRD_DO_LANE" --first' },
      launch: { run: 'hab up "$YRD_DO_LANE"', timeoutMs: 120_000 },
      pollMs: 30_000,
      carrierTimeoutMs: 2_700_000,
      landingTimeoutMs: 2_700_000,
    })
    expect(Object.keys(parsed.definitions)).toEqual(["merge"])
  })

  it("refuses unknown managed do keys instead of treating them as a step", () => {
    expect(() => parseYrdConfig({ do: { lane: "@dev/0", relaunch: "x" } })).toThrow(/not supported/u)
    expect(() => parseYrdConfig({ do: { pollMs: 0 } })).toThrow()
  })

  it("carries the managed do block through the resolved config", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: (path) =>
        Promise.resolve(path.endsWith(".yrd.yml") ? 'do:\n  lane: "@dev/0"\n  assign: a\n  launch: l\n' : undefined),
    })
    expect(loaded.config.do).toEqual({ lane: "@dev/0", assign: { run: "a" }, launch: { run: "l" } })
  })

  it("loads one file and fills useful defaults", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "trunk",
      read: (path) => Promise.resolve(path.endsWith(".yrd.yml") ? "batch: 3" : undefined),
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
        flows: [expect.objectContaining({ name: "default", rev: "legacy-v1" })],
      },
    })
  })

  it("loads .yrd.ts from base-branch authority and flattens its selected step capabilities", async () => {
    const reads: string[] = []
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      readAuthority: (base, path) => {
        reads.push(`${base}:${path}`)
        return Promise.resolve(path === ".yrd.ts" ? "base source" : undefined)
      },
      loadModule: () =>
        Promise.resolve(
          defineConfig(
            yrd.journal({ version: 1, reader: "b".repeat(40) }),
            yrd.flow({
              name: "docs",
              rev: "5",
              on: ({ branch }) => branch.startsWith("docs/"),
              steps: [yrd.check("check", { run: "bun test" }), yrd.action("publish"), yrd.merge()],
            }),
          ),
        ),
    })

    expect(reads).toEqual(["main:.yrd.ts"])
    expect(loaded.path).toBe("/repo/.yrd.ts")
    expect(loaded.config).toMatchObject({
      steps: ["check", "publish", "merge"],
      definitions: {
        check: { run: "bun test", runner: "local" },
        publish: { runner: "local" },
        merge: { runner: "local" },
      },
      journal: { version: 1, reader: "b".repeat(40) },
      flows: [expect.objectContaining({ name: "docs", rev: "5" })],
    })
  })

  it("treats --config as a base-relative authority path, never a candidate filesystem escape", async () => {
    const requested: string[] = []
    await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      configPath: "delivery/yard.ts",
      readAuthority: (base, path) => {
        requested.push(`${base}:${path}`)
        return Promise.resolve("base source")
      },
      loadModule: () =>
        Promise.resolve(
          defineConfig(yrd.flow({ name: "main", rev: "1", on: () => true, steps: [yrd.check("check"), yrd.merge()] })),
        ),
    })
    expect(requested).toEqual(["main:delivery/yard.ts"])

    await expect(loadYrdConfig({ repo: "/repo", defaultBase: "main", configPath: "../candidate.ts" })).rejects.toThrow(
      "must stay inside the repository",
    )
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
    [{ journal: { version: 1, reader: "short" } }, "journal.reader"],
    [{ journal: { version: 0, reader: "a".repeat(40) } }, "journal.version"],
    [{ notify: { "pr/typo": ["submitter"] } }, "notify.pr/typo"],
    [{ notify: { "pr/rejected": ["reviewer"] } }, "notify.pr/rejected"],
    [{ notify: { "pr/needs-author": ["reviewer"] } }, "notify.pr/needs-author"],
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

describe("Yrd config — strict and delta gate modes", () => {
  it("defaults to delta and accepts either explicit mode", () => {
    const parsed = parseYrdConfig({
      inherited: { run: "bun run inherited" },
      release: { run: "bun run release", mode: "strict" },
      carrier: { run: "bun run carrier", mode: "delta" },
    })

    expect(stepGateMode(parsed.definitions.inherited!)).toBe("delta")
    expect(stepGateMode(parsed.definitions.release!)).toBe("strict")
    expect(stepGateMode(parsed.definitions.carrier!)).toBe("delta")
  })

  it("rejects an unknown gate mode", () => {
    expect(() => parseYrdConfig({ check: { run: "bun run check", mode: "legacy" } })).toThrow(
      /check\.mode.*delta or strict/u,
    )
  })

  it("requires diagnostics comparison when a structured readiness report is declared", () => {
    expect(() =>
      parseYrdConfig({
        check: { run: "bun run check", comparisonReady: DIAGNOSTICS_COMPARISON_READY },
      }),
    ).toThrow(/comparisonReady.*requires comparison: diagnostics/u)
    expect(
      parseYrdConfig({
        check: {
          run: "bun run check",
          comparison: "diagnostics",
          comparisonReady: DIAGNOSTICS_COMPARISON_READY,
        },
      }).definitions.check,
    ).toMatchObject({
      comparison: "diagnostics",
      comparisonReady: DIAGNOSTICS_COMPARISON_READY,
    })
  })
})
