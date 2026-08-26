/**
 * @failure Git work bays can escape their root, inherit ambient Git state, or lose submitted revisions.
 * @level l2
 * @consumer @yrd/grove Git workspace adapter
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import {
  createGitWorkspace,
  gitWorkspaceRevision,
  resolveBayWorkspacePath,
  type GitWorkspaceOptions,
} from "../src/git.ts"
import type { RemoteBranchSnapshot } from "../src/model.ts"

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

  it("provisions a bay from a commit SHA while another worktree still holds the branch (22358)", async () => {
    // Specimen: yrd pr checkout used the change branch name; git refuses a second checkout of a
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
})
