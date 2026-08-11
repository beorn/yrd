import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Command } from "@silvery/commander"
import { describe, expect, it } from "vitest"
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
      args: ["queue", "alpha", "--json"],
      expected: {
        kind: "repository-read",
        repository: { name: "alpha", path: "/srv/alpha" },
        queue: { base: "main" },
        args: ["--repo", "/srv/alpha", "queue", "list", "--base", "main", "--json"],
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
      args: ["queue", "pause", "beta", "--reason", "schema cutover"],
      expected: {
        kind: "repository-write",
        repository: { name: "beta", path: "/srv/beta" },
        queue: { base: "release" },
        args: ["--repo", "/srv/beta", "queue", "pause", "release", "--reason", "schema cutover"],
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

  it("refuses an undeclared repository alias and names the valid set", () => {
    expect(() => normalizeYrdRepositoryAliasInvocation(["queue", "run", "docs"], repositories)).toThrow(
      "unknown Yrd repository 'docs'; expected alpha or beta",
    )
  })

  it.each(["recover", "cancel", "finish"])("refuses a missing repository alias for queue %s", (command) => {
    expect(() => normalizeYrdRepositoryAliasInvocation(["queue", command], repositories)).toThrow(
      "unknown Yrd repository ''; expected alpha or beta",
    )
  })
})

describe("resolveYrdContext", () => {
  const ambient = join(tmpdir(), "yrd-context", "caller")

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

  it("exposes only product-level global selectors", () => {
    const help = configureYrdGlobalOptions(new Command("yrd")).helpInformation()
    expect(help).not.toContain("--name")
    expect(help).not.toContain("--wire")
  })
})
