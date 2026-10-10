/**
 * @failure A declaration is accepted with ignored or misread fields, or a
 *          retired spelling loses the remedy that tells the operator where
 *          its meaning moved; queue URLs name the same queue differently.
 * @level l0 (pure declaration parsing and queue-name normalization)
 * @consumer Queue runners and operators authoring or identifying `.yrd.yml`.
 */

import { describe, expect, it } from "vitest"
import { parseConfig, queueName } from "../src/config.ts"

const TARGET = { branch: "release/1.x", remote: "yrd" } as const
const SOURCE = { at: "captured-target-A", blob: "b".repeat(40), target: TARGET } as const

describe("the queue declaration grammar", () => {
  it("reads a bounded pre-submit admission command", () => {
    expect(
      parseConfig("admission:\n  run: bun tools/yrd-admission.ts\n  timeoutMs: 15000\n", SOURCE).admission,
    ).toEqual({
      run: "bun tools/yrd-admission.ts",
      timeoutMs: 15000,
    })
  })
  it.each([
    ["missing run", "admission:\n  timeoutMs: 15000\n"],
    ["empty run", "admission:\n  run: ''\n  timeoutMs: 15000\n"],
    ["missing timeout", "admission:\n  run: true\n"],
    ["unbounded timeout", "admission:\n  run: true\n  timeoutMs: 0\n"],
    ["unknown key", "admission:\n  run: true\n  timeoutMs: 15000\n  extra: ignored\n"],
  ])("refuses %s in admission", (_name, declaration) => {
    expect(() => parseConfig(declaration, SOURCE)).toThrow(/admission/u)
  })
  it("reads a host issue resolver as an argument vector", () => {
    expect(parseConfig("issueResolver: [hh-km, bd, show, --json]\n", SOURCE).issueResolver).toEqual([
      "hh-km",
      "bd",
      "show",
      "--json",
    ])
  })
  it.each(["[]", "''", "[hh-km, '']", "[hh-km, 42]"])("refuses an invalid issue resolver %s", (value) => {
    expect(() => parseConfig(`issueResolver: ${value}\n`, SOURCE)).toThrow(/issueResolver: must be a non-empty argv/u)
  })

  it("reads every supported field and supplies only the declared defaults", () => {
    const config = parseConfig(
      [
        "setup: bun install --frozen-lockfile",
        "derive: bun tools/derive.ts",
        "teardown: bun run clean",
        "archive-after: never",
        "revert-guard: refuse",
        "ignore: [draft/*, 'scratch/**']",
        "checks:",
        "  - verify:",
        "      run: bun run verify",
        "      on: [submit, merge]",
        "      timeoutMs: 1234",
        "      scripts: [tools/verify.ts, config/schema.json]",
        "      environmentPassthrough: [CI, VERIFY_TOKEN]",
        "      programRoot: true",
        "  - merge-only:",
        "      run: bun run integration",
        "notify:",
        "  - submitter:",
        "      on: [merged, failed, cancelled]",
        "      run: bun tools/notify.ts --to submitter",
        "  - supervisor:",
        "      on: stuck",
        "      run: bun tools/notify.ts --to supervisor",
        "  - observer:",
        "      on: observed",
        "      run: bun tools/observe.ts",
        "  - everyone:",
        "      run: bun tools/notify.ts --to everyone",
        "health:",
        "  stallAfter: 1h",
        "",
      ].join("\n"),
      SOURCE,
    )

    expect(config).toEqual({
      archiveAfter: "never",
      blob: SOURCE.blob,
      checks: [
        {
          environmentPassthrough: ["CI", "VERIFY_TOKEN"],
          name: "verify",
          on: ["submit", "merge"],
          programRoot: true,
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
      health: { declared: true, stallAfterMs: 60 * 60_000 },
      ignore: ["draft/*", "scratch/**"],
      notify: [
        { name: "submitter", on: ["merged", "failed", "cancelled"], run: "bun tools/notify.ts --to submitter" },
        { name: "supervisor", on: ["stuck"], run: "bun tools/notify.ts --to supervisor" },
        { name: "observer", on: ["observed"], run: "bun tools/observe.ts" },
        {
          name: "everyone",
          on: ["merged", "failed", "stuck", "merged-direct", "cancelled"],
          run: "bun tools/notify.ts --to everyone",
        },
      ],
      setup: "bun install --frozen-lockfile",
      derive: "bun tools/derive.ts",
      revertGuard: "refuse",
      target: TARGET,
      teardown: "bun run clean",
    })
    expect(parseConfig("{}\n", SOURCE)).toEqual({
      archiveAfter: "never",
      blob: SOURCE.blob,
      checks: [],
      health: { declared: false, stallAfterMs: 45 * 60_000 },
      ignore: [],
      notify: [],
      revertGuard: "observe",
      setup: undefined,
      target: TARGET,
      teardown: undefined,
    })
  })

  it.each([
    [
      "positive retention is halted",
      "archive-after: 1\n",
      /yrd-archive-after-disabled: \.yrd\.yml archive-after 1 days: ref deletion is disabled; the only accepted value is never/u,
    ],
    [
      "zero retention",
      "archive-after: 0\n",
      /yrd-archive-after-invalid: \.yrd\.yml archive-after: the only accepted value is never/u,
    ],
    [
      "fractional retention",
      "archive-after: 1.5\n",
      /yrd-archive-after-invalid: \.yrd\.yml archive-after: the only accepted value is never/u,
    ],
    [
      "string retention",
      "archive-after: soon\n",
      /yrd-archive-after-invalid: \.yrd\.yml archive-after: the only accepted value is never/u,
    ],
    // 25669 (@cto fa6f3457 rider 2): the stall threshold is validated like every other key, never defaulted over.
    ["a scalar health", "health: 45m\n", /yrd-health-invalid: \.yrd\.yml health: must be a mapping/u],
    ["an unknown health key", "health:\n  stall: 45m\n", /\.yrd\.yml health: unknown key stall \(known: stallAfter\)/u],
    [
      "a malformed stallAfter",
      "health:\n  stallAfter: soon\n",
      /yrd-health-stall-after-invalid: \.yrd\.yml health\.stallAfter: "soon" is not a duration/u,
    ],
    [
      "a numeric stallAfter",
      "health:\n  stallAfter: 45\n",
      /yrd-health-stall-after-invalid: \.yrd\.yml health\.stallAfter: 45 is not a duration/u,
    ],
    [
      "a stallAfter below the round budget",
      "health:\n  stallAfter: 5m\n",
      /yrd-health-stall-after-below-floor: \.yrd\.yml health\.stallAfter 5m is below the round budget of 10m/u,
    ],
    ["scalar ignore", "ignore: draft/*\n", /yrd-ignore-pattern-invalid: \.yrd\.yml ignore: must be a list/u],
    // 27363 (@cto 32105469): revert-guard is a SCALAR top-level key; refuse is
    // the one accepted word and absent means observe. A mapping, a boolean, or
    // any other word refuses loud with the known list.
    [
      "an explicit observe",
      "revert-guard: observe\n",
      /yrd-revert-guard-invalid: \.yrd\.yml revert-guard: the only accepted value is refuse; received "observe"/u,
    ],
    [
      "a boolean revert-guard",
      "revert-guard: true\n",
      /yrd-revert-guard-invalid: \.yrd\.yml revert-guard: the only accepted value is refuse; received true/u,
    ],
    [
      "a mapping revert-guard",
      "revert-guard:\n  mode: refuse\n",
      /yrd-revert-guard-invalid: \.yrd\.yml revert-guard: the only accepted value is refuse/u,
    ],
    ["empty pattern", "ignore: ['']\n", /yrd-ignore-pattern-invalid: \.yrd\.yml ignore entry 0: pattern is empty/u],
    [
      "negated pattern",
      "ignore: ['!draft/*']\n",
      /yrd-ignore-pattern-invalid: \.yrd\.yml ignore entry 0: pattern starts with !/u,
    ],
    [
      "absolute pattern",
      "ignore: ['/draft/*']\n",
      /yrd-ignore-pattern-invalid: \.yrd\.yml ignore entry 0: pattern starts with \/ /u,
    ],
    [
      "NUL pattern",
      'ignore: ["draft\\0bad"]\n',
      /yrd-ignore-pattern-invalid: \.yrd\.yml ignore entry 0: pattern contains NUL/u,
    ],
  ] as const)("refuses %s", (_name, text, problem) => {
    expect(() => parseConfig(text, SOURCE)).toThrow(problem)
  })

  it("reads the scalar revert-guard and defaults to observe when absent", () => {
    expect(parseConfig("revert-guard: refuse\n", SOURCE).revertGuard).toBe("refuse")
    expect(parseConfig("{}\n", SOURCE).revertGuard).toBe("observe")
  })

  // 28481: `queue-root: tilde` is the capability gate that makes a STRICT pre-cutover
  // reader refuse a declaration it would otherwise honour by silently writing the
  // legacy %23 root (a tolerant reader only warns — see the key's doc comment).
  // `tilde` is the one accepted word; absent asks for nothing.
  it("reads queue-root and refuses anything but the tilde word", () => {
    expect(parseConfig("queue-root: tilde\n", SOURCE).queueRoot).toBe("tilde")
    expect(parseConfig("{}\n", SOURCE).queueRoot).toBeUndefined()
    expect("queueRoot" in parseConfig("{}\n", SOURCE)).toBe(false)
    expect(() => parseConfig("queue-root: hash\n", SOURCE)).toThrow(
      /yrd-queue-root-invalid: \.yrd\.yml queue-root: the only accepted value is tilde; received "hash"/u,
    )
  })

  // 27187: a read that never RUNS the declaration (submit, list) hears the names of
  // top-level keys newer than its parser and reads the rest; a read that runs it
  // (the queue's round, check) still refuses, as do retired keys and nested fields.
  describe("a top-level key newer than this parser", () => {
    const text = "later: bun tools/later.ts\nsetup: bun install\n"
    it("refuses in a strict read, as the queue's round reads it", () => {
      expect(() => parseConfig(text, SOURCE)).toThrow(/\.yrd\.yml: unknown key later \(known:/u)
    })
    it("is named to the handler and left out of a tolerant read", () => {
      const heard: string[][] = []
      const config = parseConfig(text, { ...SOURCE, newerKeys: (keys) => heard.push([...keys]) })
      expect(heard).toEqual([["later"]])
      expect(config.setup).toBe("bun install")
      expect("later" in config).toBe(false)
    })
    it("leaves the handler silent when every key is known", () => {
      const heard: string[][] = []
      parseConfig("setup: bun install\n", { ...SOURCE, newerKeys: (keys) => heard.push([...keys]) })
      expect(heard).toEqual([])
    })
    it.each([
      ["a retired key", "workdir: /var/tmp/yrd\n", /unknown key workdir .*git config yrd\.workdir/u],
      [
        "Gitomic's legacy landing: declaration",
        "landing: none\n",
        /unknown key landing .*protected-branch declaration.*checks:/u,
      ],
      [
        "an unknown field inside checks:",
        "checks:\n  - verify:\n      run: bun run verify\n      later: true\n",
        /checks\[0\] verify: unknown key later/u,
      ],
    ] as const)("still refuses %s in a tolerant read", (_name, declaration, problem) => {
      expect(() => parseConfig(declaration, { ...SOURCE, newerKeys: () => undefined })).toThrow(problem)
    })
  })

  it.each([
    ["unknown top-level key", "setupp: bun install\n", /unknown key setupp .*known:/u],
    ["empty setup", "setup: ''\n", /setup: must be a non-empty string/u],
    ["retired workdir", "workdir: /var/tmp/yrd\n", /unknown key workdir .*git config yrd\.workdir/u],
    ["retired scratch", "scratch: /var/tmp/yrd\n", /unknown key scratch .*git config yrd\.workdir/u],
    ["retired owner", "owner: '@cto'\n", /unknown key owner .*the queue addresses nobody.*notify:/u],
    [
      "retired target",
      "target: origin#develop\n",
      /unknown key target.*target: is not read; submit resolves the queue from --queue or the origin head/u,
    ],
    ["retired remote", "remote: origin#develop\n", /unknown key remote .*--queue <branch>/u],
    [
      "false program-root opt-in",
      "checks:\n  - verify:\n      run: bun run verify\n      programRoot: false\n",
      /programRoot: must be true when present/u,
    ],
    [
      "null program-root opt-in",
      "checks:\n  - verify:\n      run: bun run verify\n      programRoot: null\n",
      /programRoot: must be true when present/u,
    ],
    [
      "string program-root opt-in",
      "checks:\n  - verify:\n      run: bun run verify\n      programRoot: 'true'\n",
      /programRoot: must be true when present/u,
    ],
    [
      "numeric program-root opt-in",
      "checks:\n  - verify:\n      run: bun run verify\n      programRoot: 1\n",
      /programRoot: must be true when present/u,
    ],
    [
      "list program-root opt-in",
      "checks:\n  - verify:\n      run: bun run verify\n      programRoot: []\n",
      /programRoot: must be true when present/u,
    ],
    ["scalar notify", "notify: bun tools/notify.ts\n", /notify: must be a list of/u],
    [
      "unknown ending",
      "notify:\n  - everyone:\n      on: landed\n      run: bun x\n",
      /on: must be admission-warning or merged or failed or stuck or merged-direct/u,
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

  it("writes a v2 key only for a # branch, including Unicode byte escapes (26201)", () => {
    expect(queueName({ branch: "release#é", remote: "origin" }, "https://github.com/beorn/hh.git")).toBe(
      "v2#github.com%2Fbeorn%2Fhh#release%23%C3%A9",
    )
  })
})
