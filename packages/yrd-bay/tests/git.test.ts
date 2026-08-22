/**
 * @failure Git work bays can escape their root, inherit ambient Git state, or lose submitted revisions.
 * @level l2
 * @consumer @yrd/bay Git workspace adapter
 */
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type CommandResult } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createLogger } from "loggily"
import {
  createGitWorkspace,
  gitWorkspaceRevision,
  resolveBayWorkspacePath,
  type GitWorkspaceOptions,
} from "../src/git.ts"
import type { RemoteBranchSnapshot } from "../src/model.ts"
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

async function addSubmodule(root: string, repo: string): Promise<void> {
  const dependency = join(root, "dependency")
  await Bun.$`git init -q -b main ${dependency}`
  await git(dependency, ["config", "user.name", "Yrd Test"])
  await git(dependency, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(dependency, "dependency.txt"), "dependency\n")
  await git(dependency, ["add", "dependency.txt"])
  await git(dependency, ["commit", "-qm", "initial dependency"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency"])
  await git(repo, ["commit", "-qm", "add dependency"])
}

async function createApp(adapter: BayWorkspace) {
  const jobs = createBayJobDefs(adapter)
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs }))
  return createYrd(definition, {
    inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
  })
}

async function runRequested(app: Awaited<ReturnType<typeof createApp>>, result: CommandResult): Promise<void> {
  const id = app.jobs.requested(result)[0]
  if (id === undefined) throw new Error("expected a Bay job")
  await app.jobs.run(id, { runner: "local", leaseMs: 60_000 })
}

async function workspace(process: Pick<Process, "run">, options: Omit<GitWorkspaceOptions, "process">) {
  return createGitWorkspace({ ...options, process })
}

function processResult(exitCode: number, stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, durationMs: 1, timedOut: false }
}

describe("createGitWorkspace", () => {
  it("derives the production workspace revision without preparing the repository", async () => {
    const { root, repo, intake } = await repository()
    const baysRoot = join(root, "bays")
    const postProvision = () => undefined
    await using process = createProcess()
    const adapter = await createGitWorkspace({ repo, baysRoot, intakeRemote: intake, postProvision, process })

    expect(gitWorkspaceRevision({ repo, baysRoot, intakeRemote: intake, postProvision })).toBe(adapter.revision)
  })

  it("bounds and names a blackholed Git process during workspace discovery", async () => {
    let request: ProcessRequest | undefined
    const process: Pick<Process, "run"> = {
      async run(input): Promise<ProcessResult> {
        request = input
        return {
          exitCode: 124,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          durationMs: input.timeoutMs ?? 0,
          timedOut: true,
          verdict: "TIMED_OUT",
        }
      },
    }

    await expect(createGitWorkspace({ repo: "/blackholed-repository", process })).rejects.toThrow(
      "timed out after 30000ms",
    )
    expect(request).toMatchObject({ timeoutMs: 30_000 })
  })

  it.each([
    { state: "without a recorded head", recordHead: false },
    { state: "with a recorded head", recordHead: true },
  ])("closes a never-materialized Bay $state", async ({ recordHead }) => {
    const { root, repo } = await repository()
    await using process = createProcess()
    const adapter = await workspace(process, { repo, baysRoot: join(root, "bays") })
    const headSha = recordHead ? (await git(repo, ["rev-parse", "HEAD"])).stdout : undefined

    await expect(
      adapter.deprovision(
        {
          bay: "B1",
          branch: "issue/unmaterialized",
          ...(headSha === undefined ? {} : { headSha }),
        },
        { id: "deprovision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      status: "completed",
      conclusion: "success",
      output:
        headSha === undefined
          ? {}
          : {
              headSha,
              preservedRef: "refs/yrd/closed/B1",
            },
    })
    if (headSha === undefined) {
      expect((await git(repo, ["rev-parse", "--verify", "refs/yrd/closed/B1"], true)).code).toBe(128)
    } else {
      expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(headSha)
    }
  })

  it("deprovisions the current Bay root when the recorded path predates a repository move", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    const baysRoot = join(root, "current-bays")
    const adapter = await workspace(process, { repo, baysRoot })
    const provisioned = await adapter.provision(
      { bay: "B1", name: "moved-root", branch: "issue/moved-root", base: "main" },
      { id: "provision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    if (provisioned.status !== "completed" || provisioned.conclusion !== "success") {
      throw new Error("workspace provision failed")
    }
    const stalePath = join(root, "legacy-bays", "B1")

    await expect(
      adapter.deprovision(
        {
          bay: "B1",
          path: stalePath,
          branch: "issue/moved-root",
          headSha: provisioned.output.headSha,
        },
        { id: "deprovision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ status: "completed", conclusion: "success" })
    expect(existsSync(provisioned.output.path)).toBe(false)
    expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(provisioned.output.headSha)
  })

  it("refuses ambiguous current and recorded Bay workspaces", async () => {
    const { root } = await repository()
    const baysRoot = join(root, "current-bays")
    const currentPath = join(baysRoot, "B1")
    const recordedPath = join(root, "legacy-bays", "B1")
    await Promise.all([mkdir(currentPath, { recursive: true }), mkdir(recordedPath, { recursive: true })])

    expect(() => resolveBayWorkspacePath({ baysRoot, bay: "B1", recordedPath })).toThrow(
      `Bay 'B1' has workspaces at both current path '${currentPath}' and recorded path '${recordedPath}'`,
    )
  })

  it("falls back to the sole recorded Bay workspace after a configured root change", async () => {
    const { root } = await repository()
    const recordedPath = join(root, "legacy-bays", "B1")
    await mkdir(recordedPath, { recursive: true })

    expect(resolveBayWorkspacePath({ baysRoot: join(root, "current-bays"), bay: "B1", recordedPath })).toBe(
      recordedPath,
    )
  })

  it("keeps the repository clean with the default in-repository bays root", async () => {
    const { repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo }))

    await runRequested(app, await app.bays.open({ name: "clean-main", by: "test" }))

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
    await using app = await createApp(await workspace(runner, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "clean-git-env", by: "test" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active" })
  })

  it("uses worktree-local push defaults and preserves dirty work until a clean close", async () => {
    const { root, repo, intake } = await repository()
    await using process = createProcess()
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    await runRequested(app, await app.bays.open({ name: "safe-push", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined || bay.headSha === undefined) throw new Error("expected active Bay head and path")
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
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/safe-push",
      headSha: bay.headSha,
      status: "archived",
      archived: { preservedRef: "refs/yrd/closed/B1" },
    })
  })

  it("closes a clean worktree whose repository contains submodules", async () => {
    const { root, repo } = await repository()
    await addSubmodule(root, repo)
    const unreachable = "never://network.example/dependency.git"
    await git(repo, ["config", "-f", ".gitmodules", "submodule.vendor/dependency.url", unreachable])
    await git(repo, ["config", "submodule.vendor/dependency.url", unreachable])
    await git(repo, ["commit", "-qam", "make dependency remote unreachable"])
    const unexpectedHookSync = join(root, "unexpected-post-checkout-submodule-sync")
    const postCheckout = join(repo, ".git", "hooks", "post-checkout")
    await writeFile(
      postCheckout,
      `#!/bin/sh\n[ "\${KM_NO_AUTO_SUBMODULE_UPDATE:-}" = "1" ] || : > "${unexpectedHookSync}"\n`,
    )
    await chmod(postCheckout, 0o755)
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "submodule-close", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(await git(bay.path, ["config", "--local", "--get", "submodule.alternateLocation"])).toMatchObject({
      stdout: "superproject",
    })
    expect(await git(bay.path, ["config", "--local", "--get", "submodule.alternateErrorStrategy"])).toMatchObject({
      stdout: "info",
    })
    expect(existsSync(join(bay.path, "vendor", "dependency", "dependency.txt"))).toBe(true)
    const dependencyGitDir = (await git(join(bay.path, "vendor", "dependency"), ["rev-parse", "--absolute-git-dir"]))
      .stdout
    expect((await readFile(join(dependencyGitDir, "objects", "info", "alternates"), "utf8")).trim()).toBe(
      join(await realpath(repo), ".git", "modules", "vendor", "dependency", "objects"),
    )
    expect((await git(join(bay.path, "vendor", "dependency"), ["remote", "get-url", "origin"])).stdout).toBe(
      unreachable,
    )
    const objects = join(dependencyGitDir, "objects")
    expect((await readdir(objects)).filter((name) => name !== "info" && name !== "pack")).toEqual([])
    expect(existsSync(join(objects, "pack")) ? await readdir(join(objects, "pack")) : []).toEqual([])
    expect(existsSync(unexpectedHookSync)).toBe(false)

    await runRequested(app, await app.bays.close({ bay: bay.id }))

    expect(app.bays.get("B1")?.status).toBe("closed")
    expect(existsSync(bay.path)).toBe(false)
  })

  it("preserves a Bay when an initialized submodule has uncommitted work", async () => {
    const { root, repo } = await repository()
    await addSubmodule(root, repo)
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "dirty-submodule", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    await git(bay.path, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
    const dirtyPath = join(bay.path, "vendor", "dependency", "dependency.txt")
    await writeFile(dirtyPath, "dirty dependency\n")

    await runRequested(app, await app.bays.close({ bay: bay.id }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "dirty-worktree" } })
    expect(existsSync(dirtyPath)).toBe(true)
  })

  it("refuses to checkpoint dirty submodule work without committing or pushing it", async () => {
    const { root, repo, intake } = await repository()
    await addSubmodule(root, repo)
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-qu", "origin", "main"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "checkpoint-dirty-submodule", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined || bay.headSha === undefined) throw new Error("expected active Bay head and path")
    const dirtyPath = join(bay.path, "vendor", "dependency", "dependency.txt")
    await writeFile(dirtyPath, "dirty dependency\n")

    await runRequested(app, await app.bays.checkpoint({ bay: bay.id, claim: "@km/test/dirty-submodule" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "checkpoint-failed" } })
    expect((await git(bay.path, ["rev-parse", "HEAD"])).stdout).toBe(bay.headSha)
    expect(existsSync(dirtyPath)).toBe(true)
    expect((await git(repo, ["ls-remote", "origin", `refs/heads/${bay.branch}`])).stdout).toBe("")
  })

  it("refuses to overwrite a branch created remotely after claim provisioning", async () => {
    const { root, repo, intake } = await repository()
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-qu", "origin", "main"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(
      app,
      await app.bays.open({
        name: "lease-race",
        by: "test",
        issue: "@km/test/lease-race",
        branch: "task/lease-race",
      }),
    )
    const bay = app.bays.get("B1")
    if (bay?.path === undefined || bay.headSha === undefined) throw new Error("expected active Bay head and path")
    await git(intake, ["update-ref", "refs/heads/task/lease-race", bay.headSha])
    await writeFile(join(bay.path, "claimed.txt"), "ours\n")

    await runRequested(app, await app.bays.checkpoint({ bay: bay.id, claim: "@km/test/lease-race" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "checkpoint-failed" } })
    expect((await git(intake, ["rev-parse", "refs/heads/task/lease-race"])).stdout).toBe(bay.headSha)
    expect((await git(bay.path, ["rev-parse", "HEAD"])).stdout).not.toBe(bay.headSha)
  })

  it("refuses to repair a divergent tracking lease even when origin equals the Bay head", async () => {
    const { root, repo, intake } = await repository()
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-qu", "origin", "main"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(
      app,
      await app.bays.open({
        name: "divergent-lease",
        by: "test",
        issue: "@km/test/divergent-lease",
        branch: "task/divergent-lease",
      }),
    )
    const bay = app.bays.get("B1")
    if (bay?.path === undefined || bay.headSha === undefined) throw new Error("expected active Bay head and path")
    await git(repo, ["switch", "-qc", "divergent-carrier"])
    await writeFile(join(repo, "divergent.txt"), "divergent\n")
    await git(repo, ["add", "divergent.txt"])
    await git(repo, ["commit", "-qm", "divergent carrier"])
    const divergentHead = (await git(repo, ["rev-parse", "HEAD"])).stdout
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["update-ref", "refs/remotes/origin/task/divergent-lease", divergentHead])
    await git(intake, ["update-ref", "refs/heads/task/divergent-lease", bay.headSha])

    await runRequested(app, await app.bays.checkpoint({ bay: bay.id, claim: "@km/test/divergent-lease" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "checkpoint-failed" } })
    expect((await git(repo, ["rev-parse", "refs/remotes/origin/task/divergent-lease"])).stdout).toBe(divergentHead)
  })

  it("observes a completed claim push after its process result is interrupted without force-pushing", async () => {
    const { root, repo, intake } = await repository()
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-qu", "origin", "main"])
    const originalHook = join(repo, ".git", "hooks", "pre-push")
    await writeFile(
      originalHook,
      [
        "#!/bin/sh",
        "git_dir=$(git rev-parse --git-common-dir)",
        'printf chained > "$git_dir/yrd-pre-push-ran"',
        "",
      ].join("\n"),
    )
    await chmod(originalHook, 0o755)
    await using actual = createProcess()
    const pushes: string[][] = []
    let interruptPushResult = true
    const process: Pick<Process, "run"> = {
      async run(request) {
        const args = request.argv.slice(3)
        if (args.includes("push")) {
          pushes.push(args)
          const result = await actual.run(request)
          if (result.exitCode === 0 && interruptPushResult) {
            interruptPushResult = false
            return processResult(1, "simulated push completion interruption")
          }
          return result
        }
        return actual.run(request)
      },
    }
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(
      app,
      await app.bays.open({
        name: "lease-replay",
        by: "test",
        issue: "@km/test/lease-replay",
        branch: "task/lease-replay",
      }),
    )
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    await writeFile(join(bay.path, "claimed.txt"), "ours\n")

    await runRequested(app, await app.bays.checkpoint({ bay: bay.id, claim: "@km/test/lease-replay" }))
    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: undefined })
    const pushedHead = (await git(intake, ["rev-parse", "refs/heads/task/lease-replay"])).stdout
    await git(bay.path, ["update-ref", "-d", "refs/remotes/origin/task/lease-replay"])

    await runRequested(app, await app.bays.checkpoint({ bay: bay.id, claim: "@km/test/lease-replay" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", headSha: pushedHead, failure: undefined })
    expect((await git(bay.path, ["rev-parse", "refs/remotes/origin/task/lease-replay"])).stdout).toBe(pushedHead)
    await writeFile(join(bay.path, "continued.txt"), "continued\n")
    await runRequested(app, await app.bays.checkpoint({ bay: bay.id, claim: "@km/test/lease-replay" }))

    expect((await git(intake, ["show", "refs/heads/task/lease-replay:continued.txt"])).stdout).toBe("continued")
    expect(pushes).toHaveLength(2)
    expect(pushes[0]).toContain("--force-with-lease=refs/heads/task/lease-replay:")
    expect(pushes[1]).toContain(`--force-with-lease=refs/heads/task/lease-replay:${pushedHead}`)
    expect(pushes.flat().some((argument) => argument === "--force" || argument.startsWith("+"))).toBe(false)
    expect(await readFile(join(repo, ".git", "yrd-pre-push-ran"), "utf8")).toBe("chained")
  })

  it("resumes close after interruption leaves the preservation ref behind", async () => {
    const { root, repo } = await repository()
    await using actual = createProcess()
    let interruptRemoval = true
    const removalTimeouts: (number | undefined)[] = []
    const process: Pick<Process, "run"> = {
      run(request) {
        const args = request.argv.slice(3)
        if (interruptRemoval && args[0] === "worktree" && args[1] === "remove") {
          removalTimeouts.push(request.timeoutMs)
          interruptRemoval = false
          return Promise.resolve(processResult(1, "simulated removal interruption"))
        }
        if (args[0] === "worktree" && args[1] === "remove") removalTimeouts.push(request.timeoutMs)
        return actual.run(request)
      },
    }
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "resume-close", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined || bay.headSha === undefined) throw new Error("expected active Bay head and path")

    await runRequested(app, await app.bays.close({ bay: bay.id }))
    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "deprovision-failed" } })
    expect(existsSync(bay.path)).toBe(true)
    expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(bay.headSha)

    await runRequested(app, await app.bays.close({ bay: bay.id }))

    expect(app.bays.get("B1")?.status).toBe("closed")
    expect(existsSync(bay.path)).toBe(false)
    expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(bay.headSha)
    expect(removalTimeouts).toEqual([120_000, 120_000])
  })

  it("resumes close after removal succeeds but Job completion is interrupted", async () => {
    const { root, repo } = await repository()
    await using actual = createProcess()
    let interruptCompletion = true
    const process: Pick<Process, "run"> = {
      async run(request) {
        const args = request.argv.slice(3)
        if (interruptCompletion && args[0] === "worktree" && args[1] === "remove") {
          interruptCompletion = false
          const removed = await actual.run(request)
          if (removed.exitCode !== 0) return removed
          return processResult(1, "simulated completion interruption")
        }
        return actual.run(request)
      },
    }
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "resume-removed-close", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined || bay.headSha === undefined) throw new Error("expected active Bay head and path")

    await runRequested(app, await app.bays.close({ bay: bay.id }))
    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "deprovision-failed" } })
    expect(existsSync(bay.path)).toBe(false)
    expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(bay.headSha)

    await runRequested(app, await app.bays.close({ bay: bay.id }))

    expect(app.bays.get("B1")?.status).toBe("closed")
    expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(bay.headSha)
  })

  it("removes a legacy shared bay push default while keeping the Bay-local receiver", async () => {
    const { root, repo, intake } = await repository()
    await git(repo, ["config", "--local", "remote.pushDefault", "bay"])
    await using process = createProcess()
    const adapter = await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake })

    expect((await git(repo, ["config", "--local", "--get", "remote.pushDefault"], true)).code).toBe(1)

    const provisioned = await adapter.provision(
      {
        bay: "B1",
        name: "migrate-push-default",
        branch: "issue/migrate-push-default",
        base: "main",
      },
      {
        id: "provision-B1",
        attempt: 1,
        runner: "test",
        signal: new AbortController().signal,
      },
    )

    if (provisioned.status === "completed" && provisioned.conclusion === "failure") {
      throw new Error(provisioned.error.message)
    }
    if (provisioned.status !== "completed" || provisioned.conclusion !== "success") {
      throw new Error("Bay provisioning unexpectedly waited")
    }
    expect(await git(provisioned.output.path, ["config", "--worktree", "--get", "remote.pushDefault"])).toMatchObject({
      stdout: "bay",
    })
  })

  it("answers the same for a headless snapshot as for no snapshot when origin has no such branch", async () => {
    // The defect this pins: a snapshot carrying no headSha SUPPRESSED the
    // lookup that an absent snapshot performs, so "does origin have this
    // branch" was answered by whether a snapshot happened to be threaded here
    // rather than by origin. Equivalence is the assertion, not the message —
    // if these two ever diverge again, the ambiguity is back.
    const outcome = async (remoteBranch?: RemoteBranchSnapshot) => {
      const { root, repo, intake } = await repository()
      await using process = createProcess()
      const adapter = await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake })
      const result = await adapter.provision(
        {
          bay: "B1",
          name: "no-origin-head",
          branch: "issue/no-origin-head",
          base: "main",
          issue: "@km/test/no-origin-head",
          ...(remoteBranch === undefined ? {} : { remoteBranch }),
        },
        { id: "provision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
      )
      if (result.status !== "completed") return { status: result.status }
      return result.conclusion === "failure"
        ? { conclusion: result.conclusion, message: result.error.message }
        : { conclusion: result.conclusion }
    }

    const absent = await outcome(undefined)
    const headless = await outcome({ branch: "issue/no-origin-head", headState: "unknown" })

    expect(headless).toEqual(absent)
  })

  it("fails loud when the shared push default cannot be inspected", async () => {
    const process = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        const args = request.argv.slice(3)
        if (args.join(" ") === "config --local --get core.worktree") return processResult(1)
        if (args.join(" ") === "config --local --get remote.pushDefault") {
          return processResult(2, "could not read config")
        }
        return processResult(0)
      },
    }

    await expect(createGitWorkspace({ repo: "/repo", intakeRemote: "/repo/prs.git", process })).rejects.toThrow(
      "could not read config",
    )
  })

  it("fails loud when shared worktree configuration cannot be inspected", async () => {
    const { root, repo } = await repository()
    await using actual = createProcess()
    const process = {
      run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.argv.slice(3).join(" ") === "config --local --get core.worktree") {
          return Promise.resolve(processResult(2, "could not read worktree config"))
        }
        return actual.run(request)
      },
    }
    const adapter = await createGitWorkspace({ repo, baysRoot: join(root, "bays"), process })

    await expect(
      adapter.provision(
        { bay: "B1", name: "broken-config", branch: "issue/broken-config", base: "main" },
        { id: "provision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "provision-failed", message: expect.stringContaining("could not read worktree config") },
    })
  })

  it("rolls back a post-provision hook failure so the next provision can reuse the slot and branch", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    const baysRoot = join(root, "bays")
    const branch = "issue/hook-rollback"
    const failed = await createGitWorkspace({
      repo,
      baysRoot,
      process,
      postProvision: ({ bay, path }) => {
        expect(bay).toBe("B1")
        expect(path).toBe(join(baysRoot, "B1"))
        throw new Error("pointer write refused")
      },
    })

    await expect(
      failed.provision(
        { bay: "B1", name: "hook-rollback", branch, base: "main" },
        { id: "provision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "provision-failed", message: expect.stringContaining("pointer write refused") },
    })
    expect(existsSync(join(baysRoot, "B1"))).toBe(false)
    expect((await git(repo, ["show-ref", "--verify", `refs/heads/${branch}`], true)).code).not.toBe(0)

    const retried = await createGitWorkspace({ repo, baysRoot, process, postProvision: () => undefined })
    await expect(
      retried.provision(
        { bay: "B1", name: "hook-rollback", branch, base: "main" },
        { id: "provision-B1-retry", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("invokes the post-deprovision hook only after the workspace is gone", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    const calls: Array<{ bay: string; path: string; absent: boolean }> = []
    const adapter = await createGitWorkspace({
      repo,
      baysRoot: join(root, "bays"),
      process,
      postDeprovision: ({ bay, path }) => {
        calls.push({ bay, path, absent: !existsSync(path) })
      },
    })
    const provisioned = await adapter.provision(
      { bay: "B1", name: "hook-symmetry", branch: "issue/hook-symmetry", base: "main" },
      { id: "provision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    if (provisioned.status !== "completed" || provisioned.conclusion !== "success") {
      throw new Error("workspace provision failed")
    }

    await expect(
      adapter.deprovision(
        {
          bay: "B1",
          path: provisioned.output.path,
          branch: "issue/hook-symmetry",
          headSha: provisioned.output.headSha,
        },
        { id: "deprovision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ status: "completed", conclusion: "success" })
    expect(calls).toEqual([{ bay: "B1", path: provisioned.output.path, absent: true }])
  })

  it("does not overwrite an existing closed-bay preservation ref", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "preserve-ref", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")

    await writeFile(join(repo, "new-main.txt"), "new main\n")
    await git(repo, ["add", "new-main.txt"])
    await git(repo, ["commit", "-qm", "move main"])
    const existing = (await git(repo, ["rev-parse", "HEAD"])).stdout
    await git(repo, ["update-ref", "refs/yrd/closed/B1", existing])

    await runRequested(app, await app.bays.close({ bay: bay.id }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "deprovision-failed" } })
    expect((await git(repo, ["rev-parse", "refs/yrd/closed/B1"])).stdout).toBe(existing)
    expect(existsSync(bay.path)).toBe(true)
  })

  it("provisions a bay from a commit SHA while another worktree still holds the branch (22358)", async () => {
    // Specimen: yrd pr checkout used the PR branch name; git refuses a second checkout of a
    // branch another worktree holds. Gate bays must materialize the recorded head in detached HEAD.
    const { root, repo, intake } = await repository()
    await git(repo, ["checkout", "-qb", "topic/held-by-author"])
    await writeFile(join(repo, "feature.txt"), "candidate\n")
    await git(repo, ["add", "feature.txt"])
    await git(repo, ["commit", "-qm", "candidate head"])
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-q", "-u", "origin", "topic/held-by-author"])
    // Leave the branch free in the primary worktree, then hold it in the author slot —
    // the specimen state when @ci tries to bay a live seat's PR.
    await git(repo, ["checkout", "-q", "main"])
    const authorSlot = join(root, "author-slot")
    await git(repo, ["worktree", "add", "-q", authorSlot, "topic/held-by-author"])

    await using process = createProcess()
    const adapter = await workspace(process, { repo, baysRoot: join(root, "bays") })
    const jobContext = {
      id: "provision-22358",
      attempt: 1,
      runner: "test",
      signal: new AbortController().signal,
    }

    // Branch-name as `from` reproduces the specimen failure while the author holds the branch.
    const branchHeld = await adapter.provision(
      {
        bay: "B-branch",
        name: "pr-branch-held",
        branch: "topic/held-by-author",
        base: "main",
        from: "topic/held-by-author",
      },
      jobContext,
    )
    expect(branchHeld).toMatchObject({ status: "completed", conclusion: "failure" })
    const branchHeldMessage = String((branchHeld as { error?: { message?: string } }).error?.message ?? branchHeld)
    expect(branchHeldMessage).toMatch(/already used by worktree|is already checked out/iu)
    expect(branchHeldMessage).toContain("materialize the recorded commit in detached HEAD")
    expect(branchHeldMessage).not.toContain("--from")

    // Detached HEAD at the recorded SHA succeeds and matches the revision.
    const detached = await adapter.provision(
      {
        bay: "B-detached",
        name: "pr-pr-detached",
        branch: head,
        base: "main",
        from: head,
      },
      { ...jobContext, id: "provision-22358-detached" },
    )
    expect(detached).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { headSha: head },
    })
    const path = (detached as { output: { path: string } }).output.path
    expect((await git(path, ["rev-parse", "HEAD"])).stdout).toBe(head)
    expect((await git(path, ["branch", "--show-current"])).stdout).toBe("")
    expect((await git(path, ["show", "-s", "--format=%s", "HEAD"])).stdout).toBe("candidate head")

    await writeFile(join(path, "continued.txt"), "continued in detached Bay\n")
    await git(path, ["add", "continued.txt"])
    await git(path, ["commit", "-qm", "continue held candidate"])
    const continuedHead = (await git(path, ["rev-parse", "HEAD"])).stdout
    const checkpoint = await adapter.checkpoint(
      {
        bay: "B-detached",
        path,
        branch: "topic/held-by-author",
        from: head,
        claim: "@yrd/core/21679-integration-model-v2/22646-bay-open-pr-recovery",
      },
      { ...jobContext, id: "checkpoint-22358-detached" },
    )
    expect(checkpoint, JSON.stringify(checkpoint)).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { headSha: continuedHead, pushed: true },
    })
    expect((await git(repo, ["ls-remote", "origin", "refs/heads/topic/held-by-author"])).stdout).toContain(
      continuedHead,
    )
  })

  it("provisions intake-enabled bays concurrently without racing the shared remote", async () => {
    const { root, repo, intake } = await repository()
    await using process = createProcess()
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    const [first, second] = await Promise.all([
      app.bays.open({ name: "parallel-one", by: "test" }),
      app.bays.open({ name: "parallel-two", by: "test" }),
    ])
    await Promise.all([first, second].map((result) => runRequested(app, result)))

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

  it("moves a separate worktree path out of common config before adding a bay", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-git-workspace-separated-"))
    roots.push(root)
    const repo = join(root, "repo")
    const gitDir = join(root, "repo.git")
    const intake = join(root, "prs.git")
    await Bun.$`git init -q -b main --separate-git-dir ${gitDir} ${repo}`
    await git(repo, ["config", "core.worktree", relative(gitDir, repo)])
    await git(repo, ["config", "user.name", "Yrd Test"])
    await git(repo, ["config", "user.email", "yrd@example.invalid"])
    await writeFile(join(repo, "README.md"), "initial\n")
    await git(repo, ["add", "README.md"])
    await git(repo, ["commit", "-qm", "initial"])
    await Bun.$`git init -q --bare ${intake}`
    await using process = createProcess()
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    await runRequested(app, await app.bays.open({ name: "separate-worktree", by: "test" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", path: join(root, "bays", "B1") })
    expect((await git(repo, ["config", "--get", "extensions.worktreeConfig"])).stdout).toBe("true")
    expect((await git(repo, ["config", "--local", "--get", "core.worktree"], true)).code).not.toBe(0)
    expect((await git(repo, ["config", "--worktree", "--get", "core.worktree"])).stdout).toBe(relative(gitDir, repo))
  })

  it("never reports any worktree as bare when enabling worktree config alongside pool worktrees", async () => {
    const { root, repo, intake } = await repository()
    // A pre-existing linked worktree mirrors the shared pool slots that the incident took down.
    const pool = join(root, "pool")
    await git(repo, ["worktree", "add", "-q", pool, "-b", "pool"])
    await using process = createProcess()
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    await runRequested(app, await app.bays.open({ name: "bare-guard", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")

    // Provisioning enables extensions.worktreeConfig; it must never make main, a linked pool worktree, or
    // the new Bay report as bare.
    expect((await git(repo, ["config", "--get", "extensions.worktreeConfig"])).stdout).toBe("true")
    expect((await git(repo, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")
    expect((await git(pool, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")
    expect((await git(bay.path, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")
  })

  it("repairs a shared core.bare=true that would take every linked worktree down", async () => {
    const { root, repo, intake } = await repository()
    const pool = join(root, "pool")
    await git(repo, ["worktree", "add", "-q", pool, "-b", "pool"])
    // Reproduce the incident: extensions.worktreeConfig was enabled by an earlier run, then a stray
    // core.bare=true landed in the SHARED config and propagated to every linked worktree.
    await git(repo, ["config", "extensions.worktreeConfig", "true"])
    await git(repo, ["config", "core.bare", "true"])
    expect((await git(pool, ["rev-parse", "--is-bare-repository"])).stdout).toBe("true")

    await using process = createProcess()
    // Constructing the workspace (host startup) must heal the poisoned shared config.
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    expect((await git(repo, ["config", "--local", "--get", "core.bare"], true)).code).toBe(1)
    expect((await git(repo, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")
    expect((await git(pool, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")

    // A Bay provisioned after the repair is also non-bare and usable.
    await runRequested(app, await app.bays.open({ name: "healed", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect((await git(bay.path, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")
  })

  it("opens an existing branch without inventing an adopt operation", async () => {
    const { root, repo } = await repository()
    await git(repo, ["branch", "release-fix"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "repair-release", from: "release-fix", by: "test" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(bay).toMatchObject({ status: "active", branch: "release-fix", from: "release-fix" })
    expect((await git(bay.path, ["branch", "--show-current"])).stdout).toBe("release-fix")
  })

  it("retains ordinary bay open's implicit existing-branch behavior", async () => {
    const { root, repo } = await repository()
    await git(repo, ["branch", "issue/reopen"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "reopen", by: "test" }))

    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(bay).toMatchObject({ status: "active", branch: "issue/reopen" })
    expect((await git(bay.path, ["branch", "--show-current"])).stdout).toBe("issue/reopen")
  })

  it("opens an ordinary remote-tracking-only branch at its recorded head", async () => {
    const { root, repo, intake } = await repository()
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-qu", "origin", "main"])
    await git(repo, ["switch", "-qc", "issue/tracked-remote"])
    await writeFile(join(repo, "remote.txt"), "remote head\n")
    await git(repo, ["add", "remote.txt"])
    await git(repo, ["commit", "-qm", "remote branch head"])
    const remoteHead = (await git(repo, ["rev-parse", "HEAD"])).stdout
    await git(repo, ["push", "-qu", "origin", "issue/tracked-remote"])
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["branch", "-D", "issue/tracked-remote"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "tracked-remote", by: "test" }))

    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(bay).toMatchObject({ status: "active", branch: "issue/tracked-remote", headSha: remoteHead })
    expect((await git(bay.path, ["rev-parse", "HEAD"])).stdout).toBe(remoteHead)
  })

  it("refuses a remote-tracking head that changed after its provisioning snapshot", async () => {
    const { root, repo, intake } = await repository()
    await git(repo, ["remote", "add", "origin", intake])
    await git(repo, ["push", "-qu", "origin", "main"])
    const branch = "task/snapshot-race"
    await git(repo, ["switch", "-qc", branch])
    await writeFile(join(repo, "snapshot.txt"), "pinned\n")
    await git(repo, ["add", "snapshot.txt"])
    await git(repo, ["commit", "-qm", "pinned branch head"])
    const snapshotHead = (await git(repo, ["rev-parse", "HEAD"])).stdout
    await git(repo, ["push", "-qu", "origin", branch])
    await writeFile(join(repo, "later.txt"), "moved\n")
    await git(repo, ["add", "later.txt"])
    await git(repo, ["commit", "-qm", "move tracking after snapshot"])
    const movedHead = (await git(repo, ["rev-parse", "HEAD"])).stdout
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["branch", "-D", branch])
    await git(repo, ["update-ref", `refs/remotes/origin/${branch}`, movedHead])

    await using process = createProcess()
    const adapter = await workspace(process, { repo, baysRoot: join(root, "bays") })
    const provisioned = await adapter.provision(
      {
        bay: "B1",
        name: "snapshot-race",
        branch,
        base: "main",
        baseSha: (await git(repo, ["rev-parse", "main"])).stdout,
        issue: "@km/test/snapshot-race",
        reuseBranch: true,
        remoteBranch: { branch, headSha: snapshotHead },
      },
      { id: "provision-B1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(provisioned).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "provision-failed", message: expect.stringContaining("changed after its authority snapshot") },
    })
  })

  it("refreshes the committed head and reports uncommitted work", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))
    await runRequested(app, await app.bays.open({ name: "refresh-head", by: "test" }))
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
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))
    const opened = await app.bays.open({ name: "pinned-base", base: "main", baseSha: pinned, by: "test" })

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
