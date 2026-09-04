/**
 * @failure A command reads config from the caller's checkout or a retired
 * target: hint instead of the selected queue branch at origin, so it judges
 * against the wrong rules or guesses after malformed authority.
 * @level l2 (`coreQueueCommand` against a real remote and clone)
 * @consumer Every queue command.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "@yrd/queue-core"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string }> {
  let stderr = ""
  return {
    io: { color: false, cwd, stderr: (text) => void (stderr += text), stdout: () => {} },
    stderr: () => stderr,
  }
}

async function world(config?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-declaration-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, "README.md"), "queue\n")
  if (config !== undefined) writeFileSync(join(repo, ".yrd.yml"), config)
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  return repo
}

describe("a queue is the selected origin branch carrying config", () => {
  it("refuses malformed config from the queue branch and names what it read", async () => {
    const repo = await world("checks: [{\n")
    const run = capture(repo)

    await expect(coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" })).rejects.toThrow(
      /\.yrd\.yml at origin\/main does not parse/u,
    )
  })

  it("refuses a selected branch with no config and names that branch", async () => {
    const repo = await world()
    const run = capture(repo)

    const exit = await coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" })

    expect(exit).toBe(2)
    expect(run.stderr()).toContain("queue list needs a queue")
    expect(run.stderr()).toContain("origin/main carries no .yrd.yml")
  })

  it("accepts config with no identity key because the selected branch is the identity", async () => {
    const repo = await world("{}\n")
    const run = capture(repo)

    expect(await coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" })).toBe(0)
    expect(run.stderr()).toBe("")
  })

  it("refuses the retired target: key with the selector that replaces it", async () => {
    const repo = await world("target: origin#main\n")
    const run = capture(repo)

    await expect(coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" })).rejects.toThrow(
      /unknown key target.*select it with --queue or a <repo>#<queue> operand/u,
    )
  })
})
