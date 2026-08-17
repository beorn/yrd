import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Command } from "@silvery/commander"
import { beforeAll, describe, expect, it } from "vitest"
import {
  canonicalizeYrdCommandAliases,
  configureYrdGlobalOptions,
  normalizeYrdInvocation,
  normalizeYrdRepositoryAliasInvocation,
  resolveInvocation,
  resolveYrdContext,
} from "../src/invocation.ts"

describe("canonicalizeYrdCommandAliases", () => {
  it.each(["bay", "pr", "queue"])("canonicalizes every public list alias: %s ls", (command) => {
    expect(canonicalizeYrdCommandAliases([command, "ls", "--json"])).toEqual([command, "list", "--json"])
  })

  it.each([
    { args: ["prs", "ls", "--json"], expected: ["pr", "list", "--json"] },
    { args: ["queues", "ls", "--latest"], expected: ["queue", "list", "--latest"] },
    { args: ["watch", "--status", "running"], expected: ["queue", "list", "--watch", "--status", "running"] },
    { args: ["watch", "--pr", "PR1", "--json"], expected: ["queue", "list", "--watch", "--pr", "PR1", "--json"] },
    { args: ["queue", "--status", "pending"], expected: ["queue", "list", "--status", "pending"] },
    { args: ["queue", "topic/alpha", "--latest"], expected: ["queue", "list", "topic/alpha", "--latest"] },
    { args: ["queue", "status"], expected: ["queue", "list"] },
    { args: ["queue", "status", "--since", "24h"], expected: ["queue", "list", "--since", "24h"] },
    { args: ["queue", "watch"], expected: ["queue", "list", "--watch"] },
    { args: ["queue", "watch", "topic/alpha"], expected: ["queue", "list", "--watch", "topic/alpha"] },
    { args: ["queue", "watch", "--status", "running"], expected: ["queue", "list", "--watch", "--status", "running"] },
    { args: ["queue", "--help"], expected: ["queue", "--help"] },
    { args: ["queue", "-h"], expected: ["queue", "-h"] },
    { args: ["queue", "run", "PR1"], expected: ["queue", "run", "PR1"] },
    { args: ["queue", "finish", "R1"], expected: ["queue", "finish", "R1"] },
    { args: ["--repo", "prs", "issues", "--json"], expected: ["--repo", "prs", "issue", "--json"] },
    {
      args: ["--config", "delivery/yard.ts", "prs", "--json"],
      expected: ["--config", "delivery/yard.ts", "pr", "--json"],
    },
    { args: ["--log-level=debug", "contests"], expected: ["--log-level=debug", "contest"] },
    { args: ["bay", "open", "prs"], expected: ["bay", "open", "prs"] },
  ])("canonicalizes parse-only command aliases in $args", ({ args, expected }) => {
    expect(canonicalizeYrdCommandAliases(args)).toEqual(expected)
    expect(args).not.toBe(expected)
  })
})

describe("resolveInvocation", () => {
  it.each([
    {
      argv: ["/usr/bin/bun", "/repo/bin/yrd", "--version"],
      invocation: { name: "yrd", args: ["--version"] },
    },
    {
      argv: ["/usr/bin/bun", "/repo/bin/git-yrd", "-V"],
      invocation: { name: "git yrd", args: ["-V"] },
    },
    {
      argv: ["git", "yrd", "--version"],
      invocation: { name: "git yrd", args: ["--version"] },
    },
  ])("projects $argv", ({ argv, invocation }) => {
    expect(resolveInvocation(argv)).toEqual(invocation)
  })

  it("does not retain the retired git-bay compatibility mode", () => {
    const argv = ["/usr/bin/bun", "/repo/bin/git-bay", "status"]
    expect(resolveInvocation(argv)).toEqual({ name: "yrd", args: argv })
  })
})

describe("normalizeYrdInvocation", () => {
  it.each([
    {
      argv: ["/usr/bin/bun", "/repo/bin/yrd", "queue", "run"],
      expected: { args: ["queue", "run"], posture: "resident-queue-run", queueRunMode: "follow" },
    },
    {
      argv: ["yrd", "queue", "run", "PR7"],
      expected: { args: ["queue", "run", "PR7"], posture: "one-shot-queue-run", queueRunMode: "once" },
    },
    {
      argv: ["yrd", "queue", "run", "--once"],
      expected: { args: ["queue", "run", "--once"], posture: "one-shot-queue-run", queueRunMode: "once" },
    },
    {
      argv: ["yrd", "queue", "list", "--check", "--json"],
      expected: { args: ["queue", "list", "--check", "--json"], posture: "viewer", queueRunnerCheck: true },
    },
    {
      argv: ["yrd", "queue"],
      expected: { args: ["queue", "list"], posture: "viewer", queueRunnerCheck: false },
    },
    {
      argv: ["yrd", "--repo", "/repo", "sh"],
      expected: { args: ["--repo", "/repo", "sh"], posture: "bracketed-bay-open", queueRunnerCheck: false },
    },
    {
      argv: ["yrd", "mr", "view", "PR1"],
      expected: { args: ["mr", "view", "PR1"], posture: "viewer", queueRunnerCheck: false },
    },
  ])("classifies $argv once", ({ argv, expected }) => {
    expect(normalizeYrdInvocation(argv)).toMatchObject(expected)
  })
})

describe("repository aliases supplied by a composition host", () => {
  const repositories = [
    { repository: { name: "alpha", path: "/srv/alpha" }, queue: { base: "main" } },
    { repository: { name: "beta", path: "/srv/beta" }, queue: { base: "release" } },
  ] as const

  it.each([
    {
      args: ["queue"],
      expected: { kind: "all-repositories-read", args: ["queue", "list"] },
    },
    {
      args: ["queue", "status", "--since", "24h"],
      expected: { kind: "all-repositories-read", args: ["queue", "list", "--since", "24h"] },
    },
    {
      args: ["queue", "ls", "--latest"],
      expected: { kind: "all-repositories-read", args: ["queue", "list", "--latest"] },
    },
    {
      args: ["--log-level", "warn", "queue", "status"],
      expected: { kind: "all-repositories-read", args: ["--log-level", "warn", "queue", "list"] },
    },
    {
      args: ["queues", "status"],
      expected: { kind: "all-repositories-read", args: ["queue", "list"] },
    },
    {
      args: ["queue", "alpha", "--json"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--json"],
      },
    },
    {
      args: ["queue", "alpha", "--watch"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--watch"],
      },
    },
    {
      // An operator who names a base still gets exactly that queue: `--base`
      // travels in the tail like any other option, unrewritten.
      args: ["queue", "beta", "--base", "release", "--watch"],
      expected: {
        kind: "repository-read",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "list", "--base", "release", "--watch"],
      },
    },
    {
      args: ["queue", "run", "beta", "--once"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "run", "--once"],
      },
    },
    {
      args: ["queue", "pause", "beta", "--reason", "schema cutover", "--for", "30m"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "pause", "release", "--reason", "schema cutover", "--for", "30m"],
      },
    },
    {
      args: ["queue", "resume", "alpha"],
      expected: {
        kind: "repository-write",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "resume", "main"],
      },
    },
    {
      args: ["queue", "recover", "beta", "--reason", "expired worker"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "recover", "--reason", "expired worker"],
      },
    },
    {
      args: ["queue", "cancel", "alpha", "R7", "--reason", "superseded"],
      expected: {
        kind: "repository-write",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "cancel", "R7", "--reason", "superseded"],
      },
    },
    {
      args: ["queue", "finish", "beta", "PR9", "--step", "verify", "--ok"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "finish", "PR9", "--step", "verify", "--ok"],
      },
    },
    // The repository may name itself BEFORE the subcommand. Every spelling
    // below used to fall through as a positional filter term: `queue alpha
    // list` searched the timeline for "list" (1,091 rows → 8 on the live
    // estate) and `queue alpha run` quietly listed instead of running.
    {
      args: ["queue", "alpha", "list", "--json"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--json"],
      },
    },
    {
      args: ["queue", "alpha", "ls"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list"],
      },
    },
    {
      args: ["queue", "alpha", "status", "--since", "24h"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--since", "24h"],
      },
    },
    {
      args: ["queue", "alpha", "watch"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--watch"],
      },
    },
    {
      args: ["queue", "beta", "audit", "--json"],
      expected: {
        kind: "repository-read",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "audit", "--json"],
      },
    },
    {
      args: ["queue", "beta", "uncarried"],
      expected: {
        kind: "repository-read",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "uncarried"],
      },
    },
    {
      args: ["queue", "beta", "run", "--once"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "run", "--once"],
      },
    },
    {
      args: ["queue", "beta", "pause", "--reason", "schema cutover"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "pause", "release", "--reason", "schema cutover"],
      },
    },
    {
      args: ["queue", "alpha", "resume"],
      expected: {
        kind: "repository-write",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "resume", "main"],
      },
    },
    {
      args: ["queue", "beta", "recover", "--reason", "expired worker"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "recover", "--reason", "expired worker"],
      },
    },
    {
      args: ["queue", "alpha", "cancel", "R7", "--reason", "superseded"],
      expected: {
        kind: "repository-write",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "cancel", "R7", "--reason", "superseded"],
      },
    },
    {
      args: ["queue", "beta", "finish", "PR9", "--step", "verify", "--ok"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "finish", "PR9", "--step", "verify", "--ok"],
      },
    },
    // The mirror hole: a DECLARED name after a read verb was searched for as a
    // filter term across every repository instead of scoping the read to it.
    {
      args: ["queue", "list", "alpha", "--latest"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--latest"],
      },
    },
    {
      args: ["queue", "audit", "beta"],
      expected: {
        kind: "repository-read",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "audit"],
      },
    },
    // An UNDECLARED operand after a read verb stays what it has always been:
    // an ordinary filter term over every repository.
    {
      args: ["queue", "list", "topic/alpha"],
      expected: { kind: "all-repositories-read", args: ["queue", "list", "topic/alpha"] },
    },
    {
      args: ["queue", "audit"],
      expected: { kind: "bypass", args: ["queue", "audit"] },
    },
    {
      args: ["pr", "view", "PR1"],
      expected: { kind: "bypass", args: ["pr", "view", "PR1"] },
    },
    {
      args: ["--repo=/srv/alpha", "queue"],
      expected: { kind: "bypass", args: ["--repo=/srv/alpha", "queue"] },
    },
  ])("classifies and rewrites $args", ({ args, expected }) => {
    expect(normalizeYrdRepositoryAliasInvocation(args, repositories)).toEqual(expected)
  })

  it("leaves the composed health probe on the bootstrap-free check path", () => {
    // `yrd queue <repository> --check --json` is the service health command.
    // Its rewrite must stay recognizable as a runner check, or the probe loads
    // the whole journal to answer a question about a lease. An injected
    // `--base` made it unrecognizable, so every health tick paid for a full
    // bootstrap.
    const { args } = normalizeYrdRepositoryAliasInvocation(["queue", "alpha", "--check", "--json"], repositories)
    expect(args).toEqual(["--repo", "/srv/alpha", "queue", "list", "--check", "--json"])
    expect(normalizeYrdInvocation(["yrd", ...args])).toMatchObject({ queueRunnerCheck: true, posture: "viewer" })
  })

  it("refuses an undeclared repository alias and names the valid set", () => {
    expect(() => normalizeYrdRepositoryAliasInvocation(["queue", "run", "docs"], repositories)).toThrow(
      "unknown Yrd repository 'docs'; expected alpha or beta",
    )
    for (const args of [["watch"], ["queue", "watch"], ["queue", "list", "--watch"], ["queue", "--watch"]]) {
      expect(() => normalizeYrdRepositoryAliasInvocation(args, repositories)).toThrow(
        "all-repository queue watch is unsupported; run 'yrd queue alpha --watch' or 'yrd queue beta --watch'",
      )
    }
  })

  it.each(["recover", "cancel", "finish"])("refuses a missing repository alias for queue %s", (command) => {
    expect(() => normalizeYrdRepositoryAliasInvocation(["queue", command], repositories)).toThrow(
      "unknown Yrd repository ''; expected alpha or beta",
    )
  })

  it.each(["init", "deinit"])("does not preserve the retired direct queue %s spelling", (command) => {
    expect(() => normalizeYrdRepositoryAliasInvocation(["queue", command], repositories)).toThrow(
      `unknown Yrd repository '${command}'; expected alpha or beta`,
    )
  })

  it.each([
    {
      what: "strips its own repository's prefix from a write selector",
      args: ["queue", "cancel", "alpha", "alpha:main#7", "--reason", "superseded"],
      expected: ["--repo", "/srv/alpha", "queue", "cancel", "main#7", "--reason", "superseded"],
    },
    {
      what: "strips its own repository's prefix from a read filter",
      args: ["queue", "alpha", "alpha:main#7"],
      expected: ["--repo", "/srv/alpha", "queue", "list", "main#7"],
    },
    {
      what: "leaves an undeclared prefix alone rather than guessing at it",
      args: ["queue", "cancel", "alpha", "fixes:issue#12"],
      expected: ["--repo", "/srv/alpha", "queue", "cancel", "fixes:issue#12"],
    },
    {
      what: "leaves a colon that is not a run reference alone",
      args: ["queue", "cancel", "alpha", "R7", "--reason", "topic:alpha"],
      expected: ["--repo", "/srv/alpha", "queue", "cancel", "R7", "--reason", "topic:alpha"],
    },
    {
      // The reason is prose an operator wrote for a human to read. Rewriting
      // the whole tail edited it: the reason became "main#7" and the journal
      // recorded words nobody typed.
      what: "leaves its OWN prefix alone inside an option value",
      args: ["queue", "cancel", "alpha", "main#7", "--reason", "superseded by alpha:main#7"],
      expected: ["--repo", "/srv/alpha", "queue", "cancel", "main#7", "--reason", "superseded by alpha:main#7"],
    },
    {
      what: "leaves a bare own-repository run reference in an option value alone",
      args: ["queue", "cancel", "alpha", "main#7", "--reason", "alpha:main#7"],
      expected: ["--repo", "/srv/alpha", "queue", "cancel", "main#7", "--reason", "alpha:main#7"],
    },
    {
      // Same token, different position: as an operand it IS the subject and is
      // rewritten; the option value beside it is not.
      what: "rewrites the operand while the option value beside it stays prose",
      args: ["queue", "finish", "alpha", "alpha:main#7", "--step", "verify", "--ok"],
      expected: ["--repo", "/srv/alpha", "queue", "finish", "main#7", "--step", "verify", "--ok"],
    },
    {
      what: "leaves a variadic option's values alone",
      args: ["queue", "pause", "alpha", "--allow", "PR1", "alpha:main#7"],
      expected: ["--repo", "/srv/alpha", "queue", "pause", "main", "--allow", "PR1", "alpha:main#7"],
    },
  ])("$what", ({ args, expected }) => {
    expect(normalizeYrdRepositoryAliasInvocation(args, repositories).args).toEqual(expected)
  })

  it("does not abort a command over a SIBLING's run reference written as an option value", () => {
    // `--reason "beta:release#9"` is prose about another repository's run, not
    // a request to reach it. Refusing here aborted a cancel whose subject was
    // this repository's own run, and the refusal named a run that was never the
    // subject.
    expect(
      normalizeYrdRepositoryAliasInvocation(
        ["queue", "cancel", "alpha", "main#7", "--reason", "beta:release#9"],
        repositories,
      ).args,
    ).toEqual(["--repo", "/srv/alpha", "queue", "cancel", "main#7", "--reason", "beta:release#9"])
  })

  it("refuses another repository's run reference by naming where it lives", () => {
    // `beta:release#9` cannot resolve against alpha's journal, and alpha may
    // well have its own release#9 — so stripping the prefix would answer with
    // the WRONG run. Say where it lives and how to reach it instead.
    expect(() =>
      normalizeYrdRepositoryAliasInvocation(["queue", "cancel", "alpha", "beta:release#9"], repositories),
    ).toThrow("run 'beta:release#9' lives in Yrd repository 'beta', not 'alpha'")
    // The printed remedy is the command a human would type — and the one
    // `actionable-error` hands a runner as a machine remedy, so it carries no
    // `...` for anyone to fill in.
    expect(() =>
      normalizeYrdRepositoryAliasInvocation(["queue", "cancel", "alpha", "beta:release#9"], repositories),
    ).toThrow("run 'yrd queue cancel beta release#9' to reach it")
    expect(() => normalizeYrdRepositoryAliasInvocation(["queue", "alpha", "beta:release#9"], repositories)).toThrow(
      "run 'yrd queue beta release#9' to reach it",
    )
  })
})

describe("resolveYrdContext", () => {
  const ambient = join(tmpdir(), "yrd-context", "caller")
  beforeAll(() => {
    // Explicit selectors are stat-checked at resolution (the ENOENT-
    // misattribution fix below), so the table's selector fixtures must exist.
    // The ambient directory itself stays absent: ambient discovery is exempt.
    mkdirSync(join(tmpdir(), "yrd-context", "cli-repo"), { recursive: true })
    mkdirSync(join(tmpdir(), "yrd-context", "env-repo"), { recursive: true })
  })

  it.each([
    {
      name: "CLI repository selector over environment",
      options: {
        repo: "../cli-repo",
        config: "delivery/yard.ts",
        name: "cli-work",
        wire: "file:/tmp/cli-wire.jsonl",
      },
      env: {
        YRD_REPO: "../env-repo",
        HAB_NAME: "env-work",
        HAB_WIRE: "file:/tmp/env-wire.jsonl",
        TRIBE_NAME: "@agent/7",
      },
      context: {
        repo: resolve(ambient, "../cli-repo"),
        configPath: "delivery/yard.ts",
        observability: { level: "warn", spans: false, explicitLevel: false },
      },
    },
    {
      name: "repository environment selector over ambient discovery",
      options: {},
      env: { YRD_REPO: "../env-repo", HAB_NAME: "env-work", HAB_WIRE: "fd:3" },
      context: {
        repo: resolve(ambient, "../env-repo"),
        observability: { level: "warn", spans: false, explicitLevel: false },
      },
    },
    {
      name: "ambient discovery without interpreting orchestration identity",
      options: {},
      env: { TRIBE_NAME: "@agent/7" },
      context: {
        repo: resolve(ambient),
        observability: { level: "warn", spans: false, explicitLevel: false },
      },
    },
    {
      name: "ambient discovery when selectors are absent",
      options: {},
      env: {},
      context: { repo: resolve(ambient), observability: { level: "warn", spans: false, explicitLevel: false } },
    },
  ])("resolves $name against one captured ambient cwd", ({ options, env, context }) => {
    expect(resolveYrdContext(options, env, ambient)).toEqual(context)
  })

  it("refuses an explicit selector whose resolved path does not exist, naming both spellings", () => {
    // 2026-08-16: `--repo code` (an alias spelling, not a path) resolved to a
    // nonexistent directory, became the first spawned process's cwd, and Bun
    // misattributed the chdir failure to the program — "ENOENT posix_spawn
    // .../git" with git demonstrably on PATH. The selector is checked at the
    // one chokepoint every rail flows through, and the refusal names the raw
    // value, the resolved path, and the literal-path contract.
    expect(() => resolveYrdContext({ repo: "code" }, {}, ambient)).toThrow(
      /repository selector 'code'.*resolves to '.*yrd-context.*code'.*does not exist.*literal path/su,
    )
    expect(() => resolveYrdContext({}, { YRD_REPO: "../missing-env-repo" }, ambient)).toThrow(
      /repository selector '\.\.\/missing-env-repo'/u,
    )
    // Ambient discovery stays exempt even when the ambient directory is absent
    // (this suite's `ambient` is never created): the invocation directory
    // exists by construction in production, and repository discovery reports
    // its own absence loudly.
    expect(() => resolveYrdContext({}, {}, ambient)).not.toThrow()
  })

  it("exposes only product-level global selectors", () => {
    const help = configureYrdGlobalOptions(new Command("yrd")).helpInformation()
    expect(help).not.toContain("--name")
    expect(help).not.toContain("--wire")
  })
})
