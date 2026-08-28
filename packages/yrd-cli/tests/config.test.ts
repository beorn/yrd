/**
 * @failure Project configuration regrows deleted queue machinery or resolves
 * the one-list required-check contract differently from the runtime.
 * @level l1
 * @consumer @yrd/cli configuration
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_QUEUE_BATCH_SIZE, DEFAULT_QUEUE_PROGRESS_POLICY } from "@yrd/queue"
import {
  DEFAULT_DRAFT_PAGE_AFTER_HOURS,
  loadYrdConfig,
  parseYrdConfig,
  renderYrdConfigScaffold,
  stepGateMode,
  validatePushedYrdConfig,
} from "../src/config.ts"

describe("Yrd v4 config", () => {
  it("loads the one-line checks vocabulary and installs merge as merge machinery", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async (path) => (path.endsWith(".yrd.yml") ? "checks: [typecheck]\n" : undefined),
    })

    expect(loaded.config).toMatchObject({
      base: "main",
      batch: DEFAULT_QUEUE_BATCH_SIZE,
      checks: ["typecheck"],
      steps: ["typecheck", "merge"],
      definitions: {
        typecheck: { run: "bun run typecheck", runner: "local", kind: "check" },
        merge: { runner: "local", kind: "merge" },
      },
      progress: { noLandingMs: 1_800_000, refusalCount: 3 },
      contest: { concurrency: 2, timeoutMs: 1_800_000, evaluators: ["typecheck"] },
    })
    expect(
      Object.entries(loaded.config.definitions).map(([name, definition]) => ({ name, kind: definition.kind })),
    ).toEqual([
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

  it("resolves drafts.pageAfterHours, defaulting when absent and rejecting unknown drafts keys", async () => {
    const undeclared = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async () => "checks: [typecheck]\n",
    })
    expect(undeclared.config.drafts).toEqual({ pageAfterHours: DEFAULT_DRAFT_PAGE_AFTER_HOURS })

    const declared = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async () => "checks: [typecheck]\ndrafts: {pageAfterHours: 8}\n",
    })
    expect(declared.config.drafts).toEqual({ pageAfterHours: 8 })

    expect(() => parseYrdConfig({ checks: [], drafts: { pageAfterHours: 0 } })).toThrow(
      "yrd: config drafts.pageAfterHours must be a positive number",
    )
    expect(() => parseYrdConfig({ checks: [], drafts: { pageAfterHours: 4, notify: "@chief" } })).toThrow(
      "yrd: config drafts.notify is not supported",
    )
  })

  // The submission/admission gate this queue's Git receiver runs BEFORE a push
  // is even accepted (@yrd/bay's ReceiverHookOptions.validateConfig — @yrd/bay
  // cannot import this schema directly, so the receiver only reads the pushed
  // blob and hands it here). PR1337 (2026-08-19): this exact invalid key
  // passed typecheck, lockfile and manifest gates — none of them parse
  // `.yrd.yml` — then wedged the habitant for 31 minutes once its config load
  // (always from the base ref) hit the newly-merged key.
  describe("validatePushedYrdConfig — the queue's own admission gate for a pushed .yrd.yml", () => {
    it("refuses the PR1337 shape: a comparison value the schema does not accept", () => {
      expect(() => validatePushedYrdConfig("checks: [typecheck, {test-fast: {comparison: gate-residuals}}]\n")).toThrow(
        'yrd: config test-fast.comparison Invalid input: expected "diagnostics"',
      )
    })

    it("admits the current config unchanged", () => {
      expect(() => validatePushedYrdConfig("checks: [typecheck]\n")).not.toThrow()
    })

    it("admits a pushed tree with no .yrd.yml at all — the built-in defaults, not a skip", () => {
      expect(() => validatePushedYrdConfig(undefined)).not.toThrow()
    })

    it("refuses malformed YAML loudly rather than treating it as absent", () => {
      expect(() => validatePushedYrdConfig("checks: [typecheck\n")).toThrow()
    })

    it("refuses the unsatisfiable `requires: [review]` at the push, not once work has arrived", () => {
      // Same schema, same refusal, one layer earlier than the CLI's own load —
      // a candidate cannot push a config that would wedge the queue it is
      // pushing to.
      expect(() => validatePushedYrdConfig("checks: [typecheck]\nrequires: [review]\n")).toThrow("is retired")
    })
  })

  /**
   * @failure `requires: [review]` is accepted at load and wedges the queue
   * permanently: the gate reads `state.queues.requires.includes("review")` and
   * refuses `review-required`, but the approval it waits for cannot be produced
   * — `pr/reviewed` has a no-op reducer arm and no emitters, and `yrd pr review`
   * is retired with the change-record store. Every change is then refused
   * "needs approval", the queue drains to zero, and the refusal reads exactly
   * like ordinary review gating.
   */
  describe("requires: — an empty vocabulary that fails when it is SET", () => {
    it("refuses `review` at load and says what retired it", () => {
      expect(() => parseYrdConfig({ checks: [], requires: ["review"] })).toThrow(
        "yrd: config requires names 'review', which is retired",
      )
    })

    it("names the replacement, so the refusal is a cure and not just a stop", () => {
      expect(() => parseYrdConfig({ checks: [], requires: ["review"] })).toThrow(
        "the pushed submit ref is the recorded consent",
      )
    })

    it("still admits the key when it is empty, and still refuses an unknown member", () => {
      expect(() => parseYrdConfig({ checks: [], requires: [] })).not.toThrow()
      expect(() => parseYrdConfig({ checks: [], requires: ["approval"] })).toThrow("yrd: config requires")
    })

    it("control: the same config without the key loads, so the refusal is the KEY and not the fixture", () => {
      expect(() => parseYrdConfig({ checks: [] })).not.toThrow()
    })
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
contest: {concurrency: 3, timeoutMs: 60000, evaluators: [lint]}
`,
    })

    expect(loaded.config).toMatchObject({
      base: "trunk",
      batch: false,
      checks: ["lint"],
      steps: ["lint", "merge"],
      requires: [],
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

  // "merge" was a deleted key here once (an unrelated, older feature); it is
  // now the live key name for the merge-authority setting (formerly
  // `merge:`), so it no longer belongs in this deleted-keys list -- see
  // the `merge`/`merge` read-both coverage below instead.
  it.each(["steps", "journal", "refuse", "do", "notify", "shared-main", "typecheck-admission"])(
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

  it("accepts 'merge:' as the live key and 'landing:' as its deprecated read-only alias, identically", () => {
    const viaMerge = parseYrdConfig({ merge: "none" })
    const viaLanding = parseYrdConfig({ landing: "none" })
    expect(viaMerge.merge).toBe("none")
    expect(viaLanding.merge).toBe("none")
    expect(viaMerge).toEqual(viaLanding)
    // Unset stays unset (not defaulted) at the parse layer; loadYrdConfig applies the "expected" default.
    expect(parseYrdConfig({}).merge).toBeUndefined()
  })

  it("refuses loudly when 'merge:' and 'landing:' disagree, naming both", () => {
    expect(() => parseYrdConfig({ merge: "expected", landing: "none" })).toThrow(
      "yrd: config merge ('expected') and landing ('none') disagree; landing: is a deprecated alias for merge: — keep only one",
    )
  })

  it("does not refuse when 'merge:' and 'landing:' agree", () => {
    expect(parseYrdConfig({ merge: "expected", landing: "expected" }).merge).toBe("expected")
  })

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
