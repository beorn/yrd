import { existsSync } from "node:fs"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryEventStore, createYrd, pipe, withEffects } from "@yrd/core"
import { createGitWorkspace, withBays } from "../src/index.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (!allowFailure && code !== 0) throw new Error(stderr || stdout)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function repository(): Promise<{ root: string; repo: string; intake: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-git-workspace-"))
  roots.push(root)
  const repo = join(root, "repo")
  const intake = join(root, "prs.git")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "initial\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "initial"])
  await Bun.$`git init -q --bare ${intake}`
  return { root, repo, intake }
}

describe("createGitWorkspace", () => {
  it("uses worktree-local push defaults and preserves dirty work until an explicit clean close", async () => {
    const { root, repo, intake } = await repository()
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: createGitWorkspace({ repo, baysRoot: join(root, "bays"), intakeRemote: intake }) }),
    )

    const opened = await app.command(app.commands.bay.open, { name: "safe-push" })
    await app.effectRuns.run(opened.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    const bay = (await app.state()).bays.bays.B1!
    expect(bay.status).toBe("active")
    expect(await git(bay.path!, ["config", "--worktree", "--get", "remote.pushDefault"])).toMatchObject({
      stdout: "bay",
    })
    expect(await git(bay.path!, ["config", "--worktree", "--get", "push.default"])).toMatchObject({
      stdout: "current",
    })
    expect((await git(repo, ["config", "--local", "--get", "remote.pushDefault"], true)).code).toBe(1)

    const dirtyPath = join(bay.path!, "uncommitted.txt")
    await writeFile(dirtyPath, "keep me\n")
    const refused = await app.command(app.commands.bay.close, { bay: bay.id })
    await app.effectRuns.run(refused.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect((await app.state()).bays.bays.B1).toMatchObject({
      status: "active",
      failure: { code: "dirty-worktree" },
    })
    expect(existsSync(dirtyPath)).toBe(true)

    await unlink(dirtyPath)
    const closed = await app.command(app.commands.bay.close, { bay: bay.id })
    await app.effectRuns.run(closed.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect((await app.state()).bays.bays.B1?.status).toBe("closed")
    expect(existsSync(bay.path!)).toBe(false)
    expect(await git(repo, ["rev-parse", "--verify", "refs/yrd/closed/B1"])).toMatchObject({ code: 0 })
  })

  it("opens an existing branch without inventing an adopt operation", async () => {
    const { root, repo } = await repository()
    await git(repo, ["branch", "release-fix"])
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: createGitWorkspace({ repo, baysRoot: join(root, "bays") }) }),
    )

    const opened = await app.command(app.commands.bay.open, { name: "repair-release", from: "release-fix" })
    await app.effectRuns.run(opened.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    const bay = (await app.state()).bays.bays.B1!
    expect(bay).toMatchObject({ status: "active", branch: "release-fix", from: "release-fix" })
    expect((await git(bay.path!, ["branch", "--show-current"])).stdout).toBe("release-fix")
  })

  it("refreshes the exact committed head and reports uncommitted work", async () => {
    const { root, repo } = await repository()
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: createGitWorkspace({ repo, baysRoot: join(root, "bays") }) }),
    )
    const opened = await app.command(app.commands.bay.open, { name: "refresh-head" })
    await app.effectRuns.run(opened.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    const bay = (await app.state()).bays.bays.B1!

    await writeFile(join(bay.path!, "work.txt"), "committed\n")
    await git(bay.path!, ["add", "work.txt"])
    await git(bay.path!, ["commit", "-qm", "work"])
    const committed = (await git(bay.path!, ["rev-parse", "HEAD"])).stdout
    await writeFile(join(bay.path!, "dirty.txt"), "not committed\n")

    const refreshed = await app.command(app.commands.bay.refresh, { bay: "B1" })
    await app.effectRuns.run(refreshed.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect((await app.state()).bays.bays.B1).toMatchObject({
      status: "active",
      headSha: committed,
      dirty: true,
    })
  })

  it("provisions from an explicit base pin even when the base branch moves before execution", async () => {
    const { root, repo } = await repository()
    const pinned = (await git(repo, ["rev-parse", "main"])).stdout
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: createGitWorkspace({ repo, baysRoot: join(root, "bays") }) }),
    )
    const opened = await app.command(app.commands.bay.open, { name: "pinned-base", base: "main", baseSha: pinned })

    await writeFile(join(repo, "later.txt"), "base moved\n")
    await git(repo, ["add", "later.txt"])
    await git(repo, ["commit", "-qm", "move base"])
    expect((await git(repo, ["rev-parse", "main"])).stdout).not.toBe(pinned)

    await app.effectRuns.run(opened.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    const bay = (await app.state()).bays.bays.B1!
    expect(bay).toMatchObject({ status: "active", base: "main", baseSha: pinned, headSha: pinned })
    expect((await git(bay.path!, ["rev-parse", "HEAD"])).stdout).toBe(pinned)
  })
})
