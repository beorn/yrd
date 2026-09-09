/**
 * @failure A declaration is accepted with ignored or misread fields, or a
 *          retired spelling loses the remedy that tells the operator where
 *          its meaning moved; queue URLs name the same queue differently.
 * @level l0 (pure declaration parsing and queue-name normalization)
 * @consumer Queue runners and operators authoring or identifying `.yrd.yml`.
 */

import { describe, expect, it, vi } from "vitest"
import { assertQueueDeclaresChecks, parseConfig, queueName } from "../src/config.ts"

const TARGET = { branch: "release/1.x", remote: "yrd" } as const
const SOURCE = { at: "captured-target-A", blob: "b".repeat(40), target: TARGET } as const

describe("the queue declaration grammar", () => {
  it("reads every supported field and supplies only the declared defaults", () => {
    const config = parseConfig(
      [
        "setup: bun install --frozen-lockfile",
        "teardown: bun run clean",
        "checks:",
        "  - verify:",
        "      run: bun run verify",
        "      on: [submit, merge]",
        "      timeoutMs: 1234",
        "      scripts: [tools/verify.ts, config/schema.json]",
        "      environmentPassthrough: [CI, VERIFY_TOKEN]",
        "  - merge-only:",
        "      run: bun run integration",
        "notify:",
        "  - submitter:",
        "      on: [merged, failed]",
        "      run: bun tools/notify.ts --to submitter",
        "  - supervisor:",
        "      on: stuck",
        "      run: bun tools/notify.ts --to supervisor",
        "  - observer:",
        "      on: observed",
        "      run: bun tools/observe.ts",
        "  - everyone:",
        "      run: bun tools/notify.ts --to everyone",
        "",
      ].join("\n"),
      SOURCE,
    )

    expect(config).toEqual({
      blob: SOURCE.blob,
      checks: [
        {
          environmentPassthrough: ["CI", "VERIFY_TOKEN"],
          name: "verify",
          on: ["submit", "merge"],
          run: "bun run verify",
          scripts: ["tools/verify.ts", "config/schema.json"],
          timeoutMs: 1234,
        },
        {
          environmentPassthrough: undefined,
          name: "merge-only",
          on: undefined,
          run: "bun run integration",
          scripts: undefined,
          timeoutMs: undefined,
        },
      ],
      notify: [
        { name: "submitter", on: ["merged", "failed"], run: "bun tools/notify.ts --to submitter" },
        { name: "supervisor", on: ["stuck"], run: "bun tools/notify.ts --to supervisor" },
        { name: "observer", on: ["observed"], run: "bun tools/observe.ts" },
        {
          name: "everyone",
          on: ["merged", "failed", "stuck", "merged-direct"],
          run: "bun tools/notify.ts --to everyone",
        },
      ],
      setup: "bun install --frozen-lockfile",
      target: TARGET,
      teardown: "bun run clean",
    })
    expect(parseConfig("{}\n", SOURCE)).toEqual({
      blob: SOURCE.blob,
      checks: [],
      notify: [],
      setup: undefined,
      target: TARGET,
      teardown: undefined,
    })
  })

  it.each([
    ["unknown top-level key", "setupp: bun install\n", /unknown key setupp .*known:/u],
    ["empty setup", "setup: ''\n", /setup: must be a non-empty string/u],
    ["scalar notify", "notify: bun tools/notify.ts\n", /notify: must be a list of/u],
    [
      "unknown ending",
      "notify:\n  - everyone:\n      on: landed\n      run: bun x\n",
      /on: must be merged or failed or stuck or merged-direct/u,
    ],
    [
      "check-only notify key",
      "notify:\n  - everyone:\n      run: bun x\n      timeoutMs: 1000\n",
      /unknown key timeoutMs/u,
    ],
    ["retired batch", "batch: 1\nchecks:\n  - verify:\n      run: bun run test\n", /unknown key batch/u],
    [
      "unknown check phase",
      "checks:\n  - verify:\n      on: sometimes\n      run: bun run test\n",
      /on: must be submit or merge/u,
    ],
  ] as const)("refuses %s with its useful remedy", (_name, text, problem) => {
    expect(() => parseConfig(text, SOURCE)).toThrow(problem)
  })

  // @chief ba569ec5: a key is RETIRED precisely because it once worked, so
  // declarations in the wild carry it and throwing breaks a reader who did
  // nothing wrong. The table is proof we know what it meant; refusing anyway is
  // holding the answer and declining to use it. An UNKNOWN key still throws --
  // the table is the discriminator.
  describe("a retired key is accepted and ignored, never refused", () => {
    it.each([
      ["workdir", "workdir: /var/tmp/yrd\n", /git config yrd\.workdir/u],
      ["scratch", "scratch: /var/tmp/yrd\n", /git config yrd\.workdir/u],
      ["owner", "owner: '@cto'\n", /the queue addresses nobody/u],
      ["target", "target: origin#develop\n", /--queue <branch>/u],
      ["remote", "remote: origin#develop\n", /--queue <branch>/u],
      ["landing", "landing: product\n", /--queue <branch>/u],
    ] as const)("%s parses and warns instead of throwing", (key, text, cure) => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        expect(() => parseConfig(text, SOURCE)).not.toThrow()
        const said = warned.mock.calls.map((call) => String(call[0])).join("\n")
        // The warning contract: which key, that it is retired, what replaced
        // it, and that it was ignored. All four, or it is not loud enough.
        expect(said).toContain(key)
        expect(said).toMatch(/retired/iu)
        expect(said).toMatch(cure)
        expect(said).toMatch(/ignored/iu)
      } finally {
        warned.mockRestore()
      }
    })

    // The exact bytes blocking every ag component submission, pinned by their
    // real content rather than a paraphrase: ag/.yrd.yml at origin/main is this
    // one line and nothing else.
    it("parses ag's live declaration, whose entire content is one retired key", () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        expect(parseConfig("landing: product\n", SOURCE)).toEqual({
          blob: SOURCE.blob,
          checks: [],
          notify: [],
          setup: undefined,
          target: TARGET,
          teardown: undefined,
        })
      } finally {
        warned.mockRestore()
      }
    })

    // @chief a62a0d96: the fix is TWO refusals at TWO layers, and this is the
    // pair. Accepting a retired key WITHOUT the queue refusal would trade a loud
    // block for a silent ungated merge path -- a worse defect wearing a green
    // tick. The parser says the key is ignored; the queue says the file gates
    // nothing. Neither may be reached silently.
    it("PAIRS with the queue refusal: ag's declaration parses, and is then refused for gating nothing", () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        // Layer 1 — the parser accepts it and says so out loud.
        const config = parseConfig("landing: product\n", SOURCE)
        expect(warned.mock.calls.length).toBeGreaterThan(0)
        // Layer 2 — the queue refuses to admit anything against it.
        expect(() => assertQueueDeclaresChecks(config, "the declaration at origin/main")).toThrow(
          /declares NO CHECKS/u,
        )
      } finally {
        warned.mockRestore()
      }
    })

    it("still throws for an unknown key, and names only the unknown one", () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        // Retired and unknown together: the retired one is ignored with its
        // warning, and the refusal names ONLY what it genuinely cannot read.
        expect(() => parseConfig("landing: product\nsetupp: bun install\n", SOURCE)).toThrow(
          /unknown key setupp \(known:/u,
        )
        expect(() => parseConfig("landing: product\nsetupp: bun install\n", SOURCE)).not.toThrow(/landing/u)
      } finally {
        warned.mockRestore()
      }
    })
  })

  // Parsing is not policy. A declaration with no checks is well-formed, so
  // parseConfig answers it; admitting a CHANGE against it is the queue's call,
  // and a queue that gates nothing is not a queue.
  describe("a declaration that gates nothing is refused at admission", () => {
    it("refuses a parsed config declaring zero checks, naming the file and what to add", () => {
      const config = parseConfig("setup: bun install\n", SOURCE)
      expect(config.checks).toEqual([])
      let thrown: unknown
      try {
        assertQueueDeclaresChecks(config, "the declaration at origin/main")
      } catch (error) {
        thrown = error
      }
      const said = thrown instanceof Error ? thrown.message : String(thrown)
      // Name WHERE, name the fault, and show what a check looks like — a
      // refusal that omits the shape sends the author back to the page that
      // already failed them.
      expect(said).toContain("origin/main")
      expect(said).toMatch(/NO CHECKS/u)
      expect(said).toMatch(/checks:/u)
      expect(said).toMatch(/run:/u)
    })

    it("admits a declaration that names at least one check", () => {
      const config = parseConfig("checks:\n  - verify:\n      run: bun run test\n", SOURCE)
      expect(() => assertQueueDeclaresChecks(config, "the declaration at origin/main")).not.toThrow()
    })
  })
})

describe("a queue's stable name", () => {
  it.each([
    ["main", "git@github.com:beorn/hh.git", "github.com/beorn/hh#main"],
    ["main", "https://github.com/beorn/hh.git", "github.com/beorn/hh#main"],
    ["main", "/srv/git/hh.git", "/srv/git/hh.git#main"],
    ["develop", "ssh://git@example.invalid:22/x/y/", "example.invalid:22/x/y#develop"],
  ])("normalizes %s at %s", (branch, remote, expected) => {
    expect(queueName({ branch, remote: "unused" }, remote)).toBe(expected)
  })
})
