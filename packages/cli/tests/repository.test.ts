import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { discoverYrdRepository } from "../src/repository.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(stderr)
}

describe("discoverYrdRepository", () => {
  it("finds the shared common Git directory and primary worktree from a linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-repository-"))
    roots.push(root)
    const primary = join(root, "primary")
    const linked = join(root, "linked")
    await git(root, "init", "-q", "-b", "trunk", primary)
    await git(primary, "config", "user.name", "Yrd Test")
    await git(primary, "config", "user.email", "yrd@example.invalid")
    await Bun.write(join(primary, "README.md"), "test\n")
    await git(primary, "add", "README.md")
    await git(primary, "commit", "-qm", "initial")
    await git(primary, "worktree", "add", "-qb", "task/linked", linked)
    const nested = join(linked, "nested")
    await mkdir(nested)
    const canonicalPrimary = await realpath(primary)
    const canonicalLinked = await realpath(linked)
    const result = await discoverYrdRepository({
      cwd: nested,
      env: { ...process.env, GIT_DIR: "/must/not/leak" },
    })

    expect(result).toEqual({
      repo: canonicalPrimary,
      worktree: canonicalLinked,
      gitDir: join(canonicalPrimary, ".git"),
      stateDir: join(canonicalPrimary, ".git", "yrd"),
      baysRoot: join(canonicalPrimary, ".bays"),
      defaultBase: "trunk",
    })
  })

  it("refuses to impersonate a repository outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-not-repository-"))
    roots.push(root)
    await expect(discoverYrdRepository({ cwd: root })).rejects.toThrow("not inside a Git worktree")
  })
})
