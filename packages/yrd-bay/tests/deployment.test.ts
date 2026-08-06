/**
 * @failure Deployments can reuse a live path, lose recursive dependency identity, or be collected without an exact Hab release.
 * @level l2
 * @consumer Hab generation activation through Yrd
 */
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { createDeploymentJobDefs, createGitDeploymentStore, deploymentJobKey } from "../src/deployment.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(): Promise<{ root: string; repo: string; sha: string; nestedSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-deployment-"))
  roots.push(root)
  const nested = join(root, "nested")
  const dependency = join(root, "dependency")
  const repo = join(root, "repo")

  for (const path of [nested, dependency, repo]) {
    await Bun.$`git init -q -b main ${path}`
    await git(path, "config", "user.name", "Yrd Test")
    await git(path, "config", "user.email", "yrd@example.invalid")
  }

  await writeFile(join(nested, "nested.txt"), "nested\n")
  await git(nested, "add", "nested.txt")
  await git(nested, "commit", "-qm", "nested")
  const nestedSha = await git(nested, "rev-parse", "HEAD")

  await writeFile(join(dependency, "dependency.txt"), "dependency\n")
  await git(dependency, "add", "dependency.txt")
  await git(dependency, "commit", "-qm", "dependency")
  await git(dependency, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "vendor/nested")
  await git(dependency, "commit", "-qm", "nested dependency")
  const dependencySha = await git(dependency, "rev-parse", "HEAD")

  await writeFile(join(repo, "README.md"), "root\n")
  await git(repo, "add", "README.md")
  await git(repo, "commit", "-qm", "root")
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency")
  await git(repo, "commit", "-qm", "recursive dependency")
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
  const sha = await git(repo, "rev-parse", "HEAD")
  expect(dependencySha).toMatch(/^[0-9a-f]{40}$/u)
  return { root, repo, sha, nestedSha }
}

describe("createGitDeploymentStore", () => {
  it("atomically locks creation, quarantines checkout hooks, and never prunes during targeted release", async () => {
    const { root, repo, sha } = await repository()
    const marker = join(root, "post-checkout-ran")
    const hook = join(repo, ".git", "hooks", "post-checkout")
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(hook, 0o755)
    await using process = createProcess()
    const calls: string[][] = []
    const recordingProcess = {
      run: async (options: Parameters<typeof process.run>[0]) => {
        calls.push([...options.argv])
        return process.run(options)
      },
    }
    const store = await createGitDeploymentStore({
      repo,
      deploymentsRoot: join(root, "deployments"),
      process: recordingProcess,
    })

    const receipt = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })
    try {
      const add = calls.find((argv) => argv.includes("worktree") && argv.includes("add"))
      expect(add).toEqual(expect.arrayContaining(["--lock", "--reason", "--detach", sha]))
      expect(calls.some((argv) => argv.includes("worktree") && argv.includes("lock"))).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await store.release(receipt)
    }
    expect(calls.some((argv) => argv.includes("worktree") && argv.includes("prune"))).toBe(false)
  })

  it("serializes repository worktree mutations and names the holding deployment on timeout", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blockingProcess = {
      run: async (options: Parameters<typeof process.run>[0]) => {
        if (options.argv.includes("worktree") && options.argv.includes("add")) {
          entered.resolve()
          await release.promise
        }
        return process.run(options)
      },
    }
    const firstStore = await createGitDeploymentStore({
      repo,
      deploymentsRoot: join(root, "deployments"),
      process: blockingProcess,
    })
    const first = firstStore.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })
    await entered.promise
    try {
      await expect(
        createGitDeploymentStore({
          repo,
          deploymentsRoot: join(root, "deployments"),
          process,
          timeouts: { mutationLock: 0 },
        }),
      ).rejects.toThrow(/holder=deployment D1 worktree add/iu)
    } finally {
      release.resolve()
      const receipt = await first
      await firstStore.release(receipt)
    }
  })

  it("materializes a fresh locked physical path for every deployment, including the same SHA", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({
      repo,
      deploymentsRoot: join(root, "deployments"),
      process,
      now: () => "2026-08-06T12:00:00.000Z",
    })

    const first = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })
    const second = await store.materialize({ deploymentId: "D2", generation: "G2", sha, pin: "tip" })

    expect(first).toMatchObject({ deploymentId: "D1", generation: "G1", sha, pin: "tip", dirty: false })
    expect(second).toMatchObject({ deploymentId: "D2", generation: "G2", sha, pin: "tip", dirty: false })
    expect(first.path).not.toBe(second.path)
    expect(await git(first.path, "rev-parse", "HEAD")).toBe(sha)
    expect(await git(second.path, "rev-parse", "HEAD")).toBe(sha)
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain("locked immutable Yrd deployment D1")
    await store.release(first)
    await store.release(second)
  })

  it("records the exact recursive submodule closure", async () => {
    const { root, repo, sha, nestedSha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })

    const receipt = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "last-green" })

    expect(receipt.submodules.map(({ path }) => path)).toEqual(["vendor/dependency", "vendor/dependency/vendor/nested"])
    expect(receipt.submodules.find(({ path }) => path.endsWith("vendor/nested"))?.sha).toBe(nestedSha)
    expect(existsSync(join(receipt.path, "vendor/dependency/vendor/nested/nested.txt"))).toBe(true)
    expect(JSON.parse(await readFile(join(root, "deployments", "records", "D1.json"), "utf8"))).toEqual(receipt)
    await store.release(receipt)
  })

  it("refuses cleanup unless Hab releases the exact generation, path, and SHA", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })
    const receipt = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })

    await expect(store.release({ ...receipt, generation: "G-other" })).rejects.toThrow("generation")
    await expect(store.release({ ...receipt, path: join(root, "wrong") })).rejects.toThrow("path")
    await expect(store.release({ ...receipt, sha: "0".repeat(40) })).rejects.toThrow("SHA")
    expect(existsSync(receipt.path)).toBe(true)

    await expect(store.release(receipt)).resolves.toEqual({ released: true, path: receipt.path })
    expect(existsSync(receipt.path)).toBe(false)
    await expect(store.release(receipt)).resolves.toEqual({ released: true, path: receipt.path })
  })

  it("routes authorized release through a keyed Journal Job definition", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })
    const receipt = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })
    const jobs = createDeploymentJobDefs(store)
    const release = jobs["deployment.release"]
    const context = {
      id: "release-D1",
      attempt: 1,
      runner: "test",
      signal: new AbortController().signal,
    }
    const input = {
      deploymentId: receipt.deploymentId,
      generation: receipt.generation,
      path: receipt.path,
      sha: receipt.sha,
      authorization: {
        kind: "hab-generation-release" as const,
        generation: receipt.generation,
        path: receipt.path,
        sha: receipt.sha,
        receipt: { schema: "hab-launch-release/2", generation: receipt.generation, path: receipt.path },
      },
    }

    expect(release.request(input, { key: deploymentJobKey("release", receipt.deploymentId) })).toMatchObject({
      data: { key: "deployment:D1:release" },
    })
    await expect(
      release.execute({ ...input, authorization: { ...input.authorization, path: join(root, "wrong") } }, context),
    ).resolves.toMatchObject({ status: "completed", conclusion: "failure" })
    expect(existsSync(receipt.path)).toBe(true)
    await expect(release.execute(input, context)).resolves.toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { released: true, path: receipt.path },
    })
  })

  it("leaves a failed preparation unpublished and supports exact-input reap", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const deploymentsRoot = join(root, "deployments")
    const store = await createGitDeploymentStore({
      repo,
      deploymentsRoot,
      process,
      prepare: () => Promise.reject(new Error("dependency install failed")),
    })

    await expect(store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })).rejects.toThrow(
      "dependency install failed",
    )
    const failedPath = join(deploymentsRoot, "roots", "D1")
    expect(existsSync(join(deploymentsRoot, "records", "D1.json"))).toBe(false)
    expect(existsSync(failedPath)).toBe(true)
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain("locked immutable Yrd deployment D1")
    await expect(store.reap({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })).resolves.toMatchObject({
      reaped: true,
      path: failedPath,
    })
    expect(existsSync(failedPath)).toBe(false)
  })

  it("resumes an unpublished failed preparation with the same durable input", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    let attempts = 0
    const store = await createGitDeploymentStore({
      repo,
      deploymentsRoot: join(root, "deployments"),
      process,
      prepare: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("dependency install failed")
      },
    })
    const input = { deploymentId: "D1", generation: "G1", sha, pin: "tip" } as const

    await expect(store.materialize(input)).rejects.toThrow("dependency install failed")
    const receipt = await store.materialize(input)
    expect(receipt).toMatchObject(input)
    await store.release(receipt)
  })
})
