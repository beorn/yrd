import { describe, expect, it } from "vitest"
import { resolveInvocation } from "../src/invocation.ts"

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
