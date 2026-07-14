import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveInvocation, resolveYrdContext } from "../src/invocation.ts"

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
