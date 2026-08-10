/**
 * @failure Project configuration regrows deleted queue machinery or resolves
 * the one-list required-check contract differently from the runtime.
 * @level l1
 * @consumer @yrd/cli configuration
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_QUEUE_PROGRESS_POLICY } from "@yrd/queue"
import { loadYrdConfig, parseYrdConfig, renderYrdConfigScaffold, stepGateMode } from "../src/config.ts"

describe("Yrd v4 config", () => {
  it("loads the one-line checks vocabulary and installs merge as landing machinery", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async (path) => (path.endsWith(".yrd.yml") ? "checks: [typecheck]\n" : undefined),
    })

    expect(loaded.config).toMatchObject({
      base: "main",
      checks: ["typecheck"],
      steps: ["typecheck", "merge"],
      definitions: {
        typecheck: { run: "bun run typecheck", runner: "local", kind: "check" },
        merge: { runner: "local", kind: "merge" },
      },
      progress: { noLandingMs: 600_000, refusalCount: 3 },
      contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["typecheck"] },
    })
    expect(loaded.config.flows?.[0]?.steps.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "typecheck", kind: "check" },
      { name: "merge", kind: "merge" },
    ])
  })

  it("loads the one strict progress declaration and rejects unknown progress keys", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async () => "checks: [typecheck]\nprogress: {noLandingMs: 120000, refusalCount: 5}\n",
    })
    // The two declared knobs are honoured and the undeclared one falls back to
    // the shipped default, which is the whole contract for an optional knob.
    expect(loaded.config.progress).toEqual({
      noLandingMs: 120_000,
      refusalCount: 5,
      minAdmissionChecks: DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks,
    })
    const declared = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async () => "checks: [typecheck]\nprogress: {minAdmissionChecks: 4}\n",
    })
    expect(declared.config.progress?.minAdmissionChecks).toBe(4)
    expect(() => parseYrdConfig({ checks: [], progress: { minAdmissionChecks: 0 } })).toThrow(
      "yrd: config progress.minAdmissionChecks must be an integer >= 1",
    )

    expect(() =>
      parseYrdConfig({
        checks: [],
        progress: { noLandingMs: 120_000, refusalCount: 5, notify: "@chief" },
      }),
    ).toThrow("yrd: config progress.notify is not supported")
    expect(() => parseYrdConfig({ checks: [], progress: { noLandingMs: 0, refusalCount: 3 } })).toThrow(
      "yrd: config progress.noLandingMs must be an integer >= 1",
    )
  })

  it("keeps a one-line run escape hatch inside the checks list", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "trunk",
      read: async () => `
base: trunk
batch: false
checks:
  - {lint: {run: bun run lint, mode: strict, timeoutMs: 120000, noProgressMs: 30000}}
requires: [review]
contest: {concurrency: 3, timeoutMs: 60000, evaluators: [lint]}
`,
    })

    expect(loaded.config).toMatchObject({
      base: "trunk",
      batch: false,
      checks: ["lint"],
      steps: ["lint", "merge"],
      requires: ["review"],
      definitions: {
        lint: {
          run: "bun run lint",
          runner: "local",
          kind: "check",
          mode: "strict",
          timeoutMs: 120_000,
          noProgressMs: 30_000,
        },
      },
    })
  })

  it.each(["steps", "journal", "refuse", "do", "merge", "notify", "shared-main", "typecheck-admission"])(
    "refuses deleted config key '%s' loudly",
    (key) => {
      const value =
        key === "steps"
          ? { steps: ["check", "merge"] }
          : key === "journal"
            ? { journal: { version: 2 } }
            : key === "refuse"
              ? { refuse: { paths: ["hub/"] } }
              : key === "do"
                ? { do: { lane: "@dev/1" } }
                : { [key]: { run: "true" } }
      expect(() => parseYrdConfig(value)).toThrow(`yrd: config ${key} is not supported`)
    },
  )

  it("refuses unknown bare check names and teaches the inline run escape hatch", async () => {
    await expect(
      loadYrdConfig({
        repo: "/repo",
        defaultBase: "main",
        read: async () => "checks: [lint]\n",
      }),
    ).rejects.toThrow("required check 'lint' has no built-in definition; use {lint: {run: ...}}")
  })

  it("refuses duplicate checks and ambiguous inline definitions", () => {
    expect(() => parseYrdConfig({ checks: ["typecheck", "typecheck"] })).toThrow("contains duplicate checks")
    expect(() => parseYrdConfig({ checks: [{ lint: { run: "bun lint" }, test: { run: "bun test" } }] })).toThrow(
      "must define exactly one named check",
    )
  })

  it("validates inline check runner, environment, timing, and diagnostic comparison", () => {
    expect(() => parseYrdConfig({ checks: [{ lint: { run: "true", runner: "remote" } }] })).toThrow(
      "must be local or waiting",
    )
    expect(() => parseYrdConfig({ checks: [{ lint: { run: "true", timeoutMs: 0 } }] })).toThrow(
      "checks.0.lint.timeoutMs",
    )
    expect(() =>
      parseYrdConfig({
        checks: [{ lint: { run: "true", comparisonReady: "diagnostics-comparison-ready" } }],
      }),
    ).toThrow("requires comparison: diagnostics")
    expect(() => parseYrdConfig({ checks: [{ lint: { run: "true", env: { YRD_PRIVATE: "x" } } }] })).toThrow(
      "uses a reserved prefix",
    )
  })

  it("uses delta until a check explicitly selects strict", () => {
    expect(stepGateMode({ runner: "local" })).toBe("delta")
    expect(stepGateMode({ runner: "local", mode: "strict" })).toBe("strict")
  })

  it("accepts only repository-contained YAML config paths", async () => {
    await expect(loadYrdConfig({ repo: "/repo", defaultBase: "main", configPath: "../candidate.yml" })).rejects.toThrow(
      "must stay inside the repository",
    )
    await expect(loadYrdConfig({ repo: "/repo", defaultBase: "main", configPath: ".yrd.ts" })).rejects.toThrow(
      "must name a .yml or .yaml file",
    )
  })

  it("loads config from base authority instead of mutable worktree bytes", async () => {
    const reads: string[] = []
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "release",
      read: async () => {
        throw new Error("mutable reader must not run")
      },
      readAuthority: async (base, path) => {
        reads.push(`${base}:${path}`)
        return "checks: [typecheck]\n"
      },
    })
    expect(reads).toEqual(["release:.yrd.yml"])
    expect(loaded.config.checks).toEqual(["typecheck"])
  })

  it("generates the complete minimal config as one active line", () => {
    expect(renderYrdConfigScaffold()).toBe("checks: [typecheck]\n")
  })
})
