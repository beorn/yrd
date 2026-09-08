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
    ["retired workdir", "workdir: /var/tmp/yrd\n", /unknown key workdir .*git config yrd\.workdir/u],
    ["retired scratch", "scratch: /var/tmp/yrd\n", /unknown key scratch .*git config yrd\.workdir/u],
    ["retired owner", "owner: '@cto'\n", /unknown key owner .*the queue addresses nobody.*notify:/u],
    ["retired target", "target: origin#develop\n", /unknown key target .*--queue <branch>/u],
    ["retired remote", "remote: origin#develop\n", /unknown key remote .*--queue <branch>/u],
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
