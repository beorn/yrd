/**
 * @failure Git work bays can escape their root, inherit ambient Git state, or lose submitted revisions.
 * @level l2
 * @consumer @yrd/bay Git workspace adapter
 */
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type CommandResult } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createLogger, type ConditionalLogger } from "loggily"
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

async function createApp(adapter: BayWorkspace, log?: ConditionalLogger) {
  const jobs = createBayJobDefs(adapter)
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs }))
  return createYrd(definition, { inject: { journal: createMemoryJournal(), ...(log === undefined ? {} : { log }) } })
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

  it("keeps the repository clean with the default in-repository bays root", async () => {
    const { repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo }))

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
    await using app = await createApp(await workspace(runner, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "clean-git-env" }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active" })
  })

  it("uses worktree-local push defaults and preserves dirty work until a clean close", async () => {
    const { root, repo, intake } = await repository()
    await using process = createProcess()
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    await runRequested(app, await app.bays.open({ name: "safe-push" }))
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

    await runRequested(app, await app.bays.open({ name: "submodule-close" }))
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

    await runRequested(app, await app.bays.open({ name: "dirty-submodule" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    await git(bay.path, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
    const dirtyPath = join(bay.path, "vendor", "dependency", "dependency.txt")
    await writeFile(dirtyPath, "dirty dependency\n")

    await runRequested(app, await app.bays.close({ bay: bay.id }))

    expect(app.bays.get("B1")).toMatchObject({ status: "active", failure: { code: "dirty-worktree" } })
    expect(existsSync(dirtyPath)).toBe(true)
  })

  it("resumes close after interruption leaves the preservation ref behind", async () => {
    const { root, repo } = await repository()
    await using actual = createProcess()
    let interruptRemoval = true
    const process: Pick<Process, "run"> = {
      run(request) {
        const args = request.argv.slice(3)
        if (interruptRemoval && args[0] === "worktree" && args[1] === "remove") {
          interruptRemoval = false
          return Promise.resolve(processResult(1, "simulated removal interruption"))
        }
        return actual.run(request)
      },
    }
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "resume-close" }))
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

    await runRequested(app, await app.bays.open({ name: "resume-removed-close" }))
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

  it("closes and preserves a worktree left mounted by failed provisioning", async () => {
    const { root, repo } = await repository()
    const baysRoot = join(root, "bays")
    const bayPath = join(baysRoot, "B1")
    await using actual = createProcess()
    let refuseBayConfig = true
    const process: Pick<Process, "run"> = {
      run(request) {
        const args = request.argv.slice(3)
        if (
          refuseBayConfig &&
          request.argv[2] === bayPath &&
          args.join(" ") === "config --local submodule.alternateLocation superproject"
        ) {
          refuseBayConfig = false
          return Promise.resolve(processResult(1, "simulated post-mount configuration failure"))
        }
        return actual.run(request)
      },
    }
    const log = createLogger("yrd", [{ level: "trace" }, { write: () => {} }])
    await using app = await createApp(await workspace(process, { repo, baysRoot }), log)

    await runRequested(app, await app.bays.open({ name: "failed-after-mount" }))
    expect(app.bays.get("B1")?.status).toBe("failed")
    expect(app.bays.get("B1")).not.toHaveProperty("path")
    expect(app.bays.get("B1")).not.toHaveProperty("headSha")
    expect(existsSync(bayPath)).toBe(true)

    await runRequested(app, await app.bays.close({ bay: "B1" }))

    expect(app.bays.get("B1")?.status).toBe("closed")
    expect(existsSync(bayPath)).toBe(false)
    expect(await git(repo, ["rev-parse", "--verify", "refs/yrd/closed/B1"])).toMatchObject({ code: 0 })
    log.end()
  })

  it("closes and retries a failed provision that created no workspace or head", async () => {
    const { root, repo } = await repository()
    const baysRoot = join(root, "bays")
    await using process = createProcess()
    const log = createLogger("yrd", [{ level: "trace" }, { write: () => {} }])
    await using app = await createApp(await workspace(process, { repo, baysRoot }), log)

    await runRequested(app, await app.bays.open({ name: "missing-source", from: "refs/remotes/origin/missing" }))
    expect(app.bays.get("B1")?.status).toBe("failed")
    expect(app.bays.get("B1")).not.toHaveProperty("path")
    expect(app.bays.get("B1")).not.toHaveProperty("headSha")
    expect(existsSync(join(baysRoot, "B1"))).toBe(false)

    await runRequested(app, await app.bays.close({ bay: "B1" }))

    expect(app.bays.get("B1")?.status).toBe("closed")
    await runRequested(app, await app.bays.open({ name: "missing-source" }))
    expect(app.bays.get("B2")?.status).toBe("active")
    log.end()
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

    if (provisioned.status === "failed") throw new Error(provisioned.error.message)
    if (provisioned.status !== "passed") throw new Error("Bay provisioning unexpectedly waited")
    expect(await git(provisioned.output.path, ["config", "--worktree", "--get", "remote.pushDefault"])).toMatchObject({
      stdout: "bay",
    })
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
      status: "failed",
      error: { code: "provision-failed", message: expect.stringContaining("could not read worktree config") },
    })
  })

  it("does not overwrite an existing closed-bay preservation ref", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "preserve-ref" }))
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

  it("provisions intake-enabled bays concurrently without racing the shared remote", async () => {
    const { root, repo, intake } = await repository()
    await using process = createProcess()
    await using app = await createApp(
      await workspace(process, { repo, baysRoot: join(root, "bays"), intakeRemote: intake }),
    )

    const [first, second] = await Promise.all([
      app.bays.open({ name: "parallel-one" }),
      app.bays.open({ name: "parallel-two" }),
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

    await runRequested(app, await app.bays.open({ name: "separate-worktree" }))

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

    await runRequested(app, await app.bays.open({ name: "bare-guard" }))
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
    await runRequested(app, await app.bays.open({ name: "healed" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect((await git(bay.path, ["rev-parse", "--is-bare-repository"])).stdout).toBe("false")
  })

  it("opens an existing branch without inventing an adopt operation", async () => {
    const { root, repo } = await repository()
    await git(repo, ["branch", "release-fix"])
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))

    await runRequested(app, await app.bays.open({ name: "repair-release", from: "release-fix" }))
    const bay = app.bays.get("B1")
    if (bay?.path === undefined) throw new Error("expected active Bay path")
    expect(bay).toMatchObject({ status: "active", branch: "release-fix", from: "release-fix" })
    expect((await git(bay.path, ["branch", "--show-current"])).stdout).toBe("release-fix")
  })

  it("refreshes the committed head and reports uncommitted work", async () => {
    const { root, repo } = await repository()
    await using process = createProcess()
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))
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
    await using app = await createApp(await workspace(process, { repo, baysRoot: join(root, "bays") }))
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
