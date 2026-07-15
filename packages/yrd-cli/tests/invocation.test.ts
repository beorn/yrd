import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { canonicalizeYrdCommandAliases, resolveInvocation, resolveYrdContext } from "../src/invocation.ts"

describe("canonicalizeYrdCommandAliases", () => {
  it.each([
    { args: ["prs", "ls", "--json"], expected: ["pr", "list", "--json"] },
    { args: ["queues", "ls", "--latest"], expected: ["queue", "list", "--latest"] },
    { args: ["--repo", "prs", "issues", "--json"], expected: ["--repo", "prs", "issue", "--json"] },
    { args: ["--log-level=debug", "contests"], expected: ["--log-level=debug", "contest"] },
    { args: ["bay", "open", "prs"], expected: ["bay", "open", "prs"] },
  ])("canonicalizes parse-only command aliases in $args", ({ args, expected }) => {
    expect(canonicalizeYrdCommandAliases(args, "root")).toEqual(expected)
    expect(args).not.toBe(expected)
  })

  it("does not project root aliases onto git-bay", () => {
    expect(canonicalizeYrdCommandAliases(["bays"], "bay")).toEqual(["bays"])
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
      options: { repo: "../cli-repo" },
      env: { YRD_REPO: "../env-repo" },
      context: { repo: resolve(ambient, "../cli-repo"), observability: { level: "warn", spans: false } },
    },
    {
      name: "environment selector over ambient discovery",
      options: {},
      env: { YRD_REPO: "../env-repo" },
      context: { repo: resolve(ambient, "../env-repo"), observability: { level: "warn", spans: false } },
    },
    {
      name: "ambient discovery when selectors are absent",
      options: {},
      env: {},
      context: { repo: resolve(ambient), observability: { level: "warn", spans: false } },
    },
  ])("resolves $name against one captured ambient cwd", ({ options, env, context }) => {
    expect(resolveYrdContext(options, env, ambient)).toEqual(context)
  })
})
