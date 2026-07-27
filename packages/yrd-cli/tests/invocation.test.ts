import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { canonicalizeYrdCommandAliases, resolveInvocation, resolveYrdContext } from "../src/invocation.ts"

describe("canonicalizeYrdCommandAliases", () => {
  it.each(["bay", "pr", "queue"])("canonicalizes every public list alias: %s ls", (command) => {
    expect(canonicalizeYrdCommandAliases([command, "ls", "--json"], "root")).toEqual([command, "list", "--json"])
  })

  it.each([
    { args: ["prs", "ls", "--json"], expected: ["pr", "list", "--json"] },
    { args: ["queues", "ls", "--latest"], expected: ["queue", "list", "--latest"] },
    { args: ["watch", "--status", "running"], expected: ["queue", "list", "--watch", "--status", "running"] },
    { args: ["watch", "--pr", "PR1", "--json"], expected: ["queue", "list", "--watch", "--pr", "PR1", "--json"] },
    { args: ["queue", "--status", "pending"], expected: ["queue", "list", "--status", "pending"] },
    { args: ["queue", "topic/alpha", "--latest"], expected: ["queue", "list", "topic/alpha", "--latest"] },
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
    expect(canonicalizeYrdCommandAliases(args, "root")).toEqual(expected)
    expect(args).not.toBe(expected)
  })

  it("does not project root aliases onto git-bay", () => {
    expect(canonicalizeYrdCommandAliases(["bays"], "bay")).toEqual(["bays"])
    expect(canonicalizeYrdCommandAliases(["ls", "--json"], "bay")).toEqual(["list", "--json"])
  })
})

describe("resolveInvocation", () => {
  it.each([
    {
      argv: ["/usr/bin/bun", "/repo/bin/yrd", "--version"],
      invocation: { name: "yrd", args: ["--version"], projection: "root" },
    },
    {
      argv: ["/usr/bin/bun", "/repo/bin/git-yrd", "-V"],
      invocation: { name: "git yrd", args: ["-V"], projection: "root" },
    },
    {
      argv: ["git", "yrd", "--version"],
      invocation: { name: "git yrd", args: ["--version"], projection: "root" },
    },
    {
      argv: ["/usr/bin/bun", "/repo/bin/git-bay", "status"],
      invocation: { name: "git bay", args: ["status"], projection: "bay" },
    },
  ])("projects $argv", ({ argv, invocation }) => {
    expect(resolveInvocation(argv)).toEqual(invocation)
  })
})

describe("resolveYrdContext", () => {
  const ambient = join(tmpdir(), "yrd-context", "caller")

  it.each([
    {
      name: "CLI selector over environment",
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
        persona: { name: "cli-work", mailbox: "@dev/cli-work", registration: "ensure" },
        wire: "file:/tmp/cli-wire.jsonl",
      },
    },
    {
      name: "environment selector over ambient discovery",
      options: {},
      env: { YRD_REPO: "../env-repo", HAB_NAME: "env-work", HAB_WIRE: "fd:3" },
      context: {
        repo: resolve(ambient, "../env-repo"),
        observability: { level: "warn", spans: false, explicitLevel: false },
        persona: { name: "env-work", mailbox: "@dev/env-work", registration: "ensure" },
        wire: "fd:3",
      },
    },
    {
      name: "transitional Tribe identity when Hab has no name",
      options: {},
      env: { TRIBE_NAME: "@agent/7" },
      context: {
        repo: resolve(ambient),
        observability: { level: "warn", spans: false, explicitLevel: false },
        persona: { name: "7", mailbox: "@agent/7", registration: "existing" },
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
})
