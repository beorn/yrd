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
  mergedTruthExceptions,
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

/**
 * The declared rulings that clear unreadable history from the lineage index.
 * They live in `.yrd.yml` rather than in a shipped package because the fact
 * being declared is one repository's own history; see
 * `MergedTruthExceptionSchema`.
 */
describe("mergedTruthExceptions config", () => {
  const SHA_A = "c0eb0de0" + "0".repeat(32)
  const SHA_B = "ba7a7568" + "1".repeat(32)
  const ID_A = "I" + "a".repeat(40)
  const ID_B = "I" + "b".repeat(40)

  const load = async (yaml: string) =>
    loadYrdConfig({ repo: "/repo", defaultBase: "main", read: async () => "checks: [typecheck]\n" + yaml })

  it("parses both dispositions into the map the index takes, keyed by full sha", async () => {
    const loaded = await load(
      "mergedTruthExceptions:\n" +
        "  - commit: " +
        SHA_A +
        "\n" +
        "    disposition: carries-change\n" +
        "    changeIds: [" +
        ID_A +
        ", " +
        ID_B +
        "]\n" +
        "    note: back-merge rejoined two\n" +
        "  - commit: " +
        SHA_B +
        "\n" +
        "    disposition: carries-no-change\n" +
        "    note: rejoined 1 commit carrying 0 Change-Ids\n",
    )

    const exceptions = mergedTruthExceptions(loaded.config)
    expect(exceptions.size).toBe(2)
    expect(exceptions.get(SHA_A)).toEqual({
      disposition: "carries-change",
      changeIds: [ID_A, ID_B],
      note: "back-merge rejoined two",
    })
    expect(exceptions.get(SHA_B)).toMatchObject({ disposition: "carries-no-change" })
  })

  it("accepts the singular changeId spelling as a one-element list", async () => {
    const loaded = await load(
      "mergedTruthExceptions:\n" +
        "  - commit: " +
        SHA_A +
        "\n" +
        "    disposition: carries-change\n" +
        "    changeId: " +
        ID_A +
        "\n",
    )

    expect(mergedTruthExceptions(loaded.config).get(SHA_A)).toEqual({
      disposition: "carries-change",
      changeIds: [ID_A],
    })
  })

  it("refuses an abbreviated commit sha, naming what an abbreviation would do", async () => {
    // The map is keyed by full sha and compared to walked commits by string
    // equality, so a short sha matches nothing: the ruling reads as declared
    // and clears no specimen. Refusing at parse time is what keeps that from
    // being indistinguishable from a working ruling.
    await expect(
      load(
        "mergedTruthExceptions:\n" +
          "  - commit: " +
          SHA_A.slice(0, 12) +
          "\n" +
          "    disposition: carries-no-change\n" +
          "    note: abbreviated\n",
      ),
    ).rejects.toThrow(/full 40-character commit sha/u)
  })

  it("refuses a carries-no-change ruling with no note", async () => {
    await expect(
      load("mergedTruthExceptions:\n  - commit: " + SHA_A + "\n    disposition: carries-no-change\n"),
    ).rejects.toThrow(/note/u)
  })

  it("refuses a carries-change ruling that names no change id", async () => {
    await expect(
      load("mergedTruthExceptions:\n  - commit: " + SHA_A + "\n    disposition: carries-change\n    note: x\n"),
    ).rejects.toThrow(/names no change id/u)
  })

  it("refuses a carries-no-change ruling that also names a change id", async () => {
    await expect(
      load(
        "mergedTruthExceptions:\n" +
          "  - commit: " +
          SHA_A +
          "\n" +
          "    disposition: carries-no-change\n" +
          "    changeId: " +
          ID_A +
          "\n" +
          "    note: contradictory\n",
      ),
    ).rejects.toThrow(/pick one/u)
  })

  it("refuses the same commit ruled twice — one of the two would silently lose", async () => {
    await expect(
      load(
        "mergedTruthExceptions:\n" +
          "  - commit: " +
          SHA_A +
          "\n    disposition: carries-no-change\n    note: first\n" +
          "  - commit: " +
          SHA_A +
          "\n    disposition: carries-no-change\n    note: second\n",
      ),
    ).rejects.toThrow(/more than once/u)
  })

  it("reads an absent key as no rulings declared, never as a cleared window", async () => {
    const loaded = await loadYrdConfig({
      repo: "/repo",
      defaultBase: "main",
      read: async () => "checks: [typecheck]\n",
    })

    expect(loaded.config.mergedTruthExceptions).toEqual([])
    expect(mergedTruthExceptions(loaded.config).size).toBe(0)
  })
})

/**
 * `scratch:` — the repository-declared root every step child gets as its
 * TMPDIR (@i/10-yrd/24031). The queue's check children inherited the runner's
 * TMPDIR, unset on the host and therefore a tmpfs `/tmp` with a per-user
 * quota shared by every agent; on 2026-09-01 it filled mid-check, git wrote
 * `Disk quota exceeded`, and two standing submissions were retired as author
 * failures. The key moves that scratch onto a filesystem the host owner
 * chooses. Parsing is pure — writability is proved by the command runner at
 * spawn time, where the failure is an infrastructure fact, not a config one.
 */
describe("scratch — the repository-declared TMPDIR root for every step child", () => {
  const load = (yaml: string) =>
    loadYrdConfig({ repo: "/repo", defaultBase: "main", read: async () => "checks: [typecheck]\n" + yaml })

  it("resolves an absolute scratch path as declared", async () => {
    const loaded = await load("scratch: /home/hh/scratch/yrd-check-scratch\n")
    expect(loaded.config.scratch).toBe("/home/hh/scratch/yrd-check-scratch")
  })

  it("resolves a relative scratch path against the repository root, never the process cwd", async () => {
    const loaded = await load("scratch: .git/yrd/check-scratch\n")
    expect(loaded.config.scratch).toBe("/repo/.git/yrd/check-scratch")
  })

  it("reads an absent key as no scratch root, so the runner's TMPDIR is inherited exactly as before", async () => {
    const loaded = await load("")
    expect(loaded.config.scratch).toBeUndefined()
    expect(parseYrdConfig({}).scratch).toBeUndefined()
  })

  it("refuses a blank or non-string scratch path loudly, naming the key", () => {
    expect(() => parseYrdConfig({ scratch: "   " })).toThrow(
      "yrd: config scratch must be a non-blank path (absolute, or relative to the repository root)",
    )
    expect(() => parseYrdConfig({ scratch: 5 })).toThrow(
      "yrd: config scratch must be a non-blank path (absolute, or relative to the repository root)",
    )
  })

  it("admits a pushed config declaring scratch through the receiver's admission gate", () => {
    expect(() => validatePushedYrdConfig("checks: [typecheck]\nscratch: /srv/yrd-check-scratch\n")).not.toThrow()
  })
})
