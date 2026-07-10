import { existsSync } from "node:fs"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Frame } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess } from "@yrd/process"
import { createGitWorkspace, type GitWorkspaceOptions } from "../src/git.ts"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"

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

async function createApp(workspace: BayWorkspace) {
  const jobs = createBayJobDefs(workspace)
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs }))
  return createYrd(definition, { inject: { journal: createMemoryJournal() } })
}

async function runRequested(app: Awaited<ReturnType<typeof createApp>>, frame: Frame): Promise<void> {
  const id = app.jobs.requested(frame)[0]
  if (id === undefined) throw new Error("expected a Bay job")
  await app.jobs.run(id, { executor: "local", leaseMs: 60_000 })
}

function workspace(process: ReturnType<typeof createProcess>, options: Omit<GitWorkspaceOptions, "process">) {
  return createGitWorkspace({ ...options, process })
}

describe("createGitWorkspace", () => {
  it("keeps the repository clean with the default in-repository bays root", async () => {
    const { repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(workspace(process, { repo }))

    await runRequested(app, await app.bays.open({ name: "clean-main" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active" })
    expect(await git(repo, ["status", "--porcelain"])).toMatchObject({ stdout: "" })
  })

  it("does not inherit ambient Git control variables", async () => {
    const { root, repo } = await repository()
    await using runner = createProcess({
      env: {
        ...process.env,
        GIT_DIR: join(root, "poison.git"),
        GIT_WORK_TREE: join(root, "poison-worktree"),
      },
    })
    await using app = await createApp(workspace(runner, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "clean-git-env" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active" })
  })

  it("uses worktree-local push defaults and preserves dirty work until a clean close", async () => {
    const { root, repo, intake } = await repository()
    await using process = createProcess()
    await using app = await createApp(workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }))

    await runRequested(app, await app.bays.open({ name: "safe-push" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(await git(bay.path, ["config", "--worktree", "--get", "remote.pushDefault"])).toMatchObject({
      stdout: "bay",
    })
    expect(await git(bay.path, ["config", "--worktree", "--get", "push.default"])).toMatchObject({ stdout: "current" })
    expect((await git(repo, ["config", "--local", "--get", "remote.pushDefault"], true)).code).toBe(1)

    const dirtyPath = join(bay.path, "uncommitted.txt")
    await writeFile(dirtyPath, "keep me\n")
    await runRequested(app, await app.bays.close({ bay: bay.id }))
    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "dirty-worktree" } })
    expect(existsSync(dirtyPath)).toBe(true)

    await unlink(dirtyPath)
    await runRequested(app, await app.bays.close({ bay: bay.id }))
    expect(app.bays.get("B1")?.status).toBe("closed")
    expect(existsSync(bay.path)).toBe(false)
    expect(await git(repo, ["rev-parse", "--verify", "refs/yrd/closed/B1"])).toMatchObject({ code: 0 })
  })

  it("provisions intake-enabled bays concurrently without racing the shared remote", async () => {
    const { root, repo, intake } = await repository()
    await using process = createProcess()
    await using app = await createApp(workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }))

    const [first, second] = await Promise.all([
      app.bays.open({ name: "parallel-one" }),
      app.bays.open({ name: "parallel-two" }),
    ])
    await Promise.all([first, second].map((frame) => runRequested(app, frame)))

    expect(app.bays.list().map((bay) => ({ status: bay.status, failure: bay.failure }))).toEqual([
      { status: "active" },
      { status: "active" },
    ])
    expect((await git(repo, ["remote", "get-url", "bay"])).stdout).toBe(intake)
    for (const bay of app.bays.list()) {
      if (bay.path === undefined) throw new Error("expected active Bay path")
      expect(await git(bay.path, ["config", "--worktree", "--get", "remote.pushDefault"])).toMatchObject({
        stdout: "bay",
      })
    }
  })

  it("opens an existing branch without inventing an adopt operation", async () => {
    const { root, repo } = await repository()
    await git(repo, ["branch", "release-fix"])
    await using process = createProcess()
    await using app = await createApp(workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "repair-release", from: "release-fix" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(bay).toMatchObject({ status: "active", branch: "release-fix", from: "release-fix" })
    expect((await git(bay.path, ["branch", "--show-current"])).stdout).toBe("release-fix")
  })

  it("refreshes the committed head and reports uncommitted work", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(workspace(process, { repo, baysRoot: join(root, "bays") }))
    await runRequested(app, await app.bays.open({ name: "refresh-head" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")

    await writeFile(join(bay.path, "work.txt"), "committed\n")
    await git(bay.path, ["add", "work.txt"])
    await git(bay.path, ["commit", "-qm", "work"])
    const committed = (await git(bay.path, ["rev-parse", "HEAD"])).stdout
    await writeFile(join(bay.path, "dirty.txt"), "not committed\n")

    await runRequested(app, await app.bays.refresh({ bay: "B1" }))
    expect(app.bays.get("B1")).toMatchObject({ status: "active", headSha: committed, dirty: true })
  })

  it("provisions from an explicit base pin even when the branch moves before execution", async () => {
    const { root, repo } = await repository()
    const pinned = (await git(repo, ["rev-parse", "main"])).stdout
    await using process = createProcess()
    await using app = await createApp(workspace(process, { repo, baysRoot: join(root, "bays") }))
    const opened = await app.bays.open({ name: "pinned-base", base: "main", baseSha: pinned })

    await writeFile(join(repo, "later.txt"), "base moved\n")
    await git(repo, ["add", "later.txt"])
    await git(repo, ["commit", "-qm", "move base"])
    expect((await git(repo, ["rev-parse", "main"])).stdout).not.toBe(pinned)

    await runRequested(app, opened)
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(bay).toMatchObject({ status: "active", base: "main", baseSha: pinned, headSha: pinned })
    expect((await git(bay.path, ["rev-parse", "HEAD"])).stdout).toBe(pinned)
  })
})
