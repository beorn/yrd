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
import { createGitDeploymentStore, readDeploymentBySource, readLiveDeployments } from "../src/deployment.ts"

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

    const result = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })
    try {
      const add = calls.find((argv) => argv.includes("worktree") && argv.includes("add"))
      expect(add).toEqual(expect.arrayContaining(["--lock", "--reason", "--detach", sha]))
      expect(calls.some((argv) => argv.includes("worktree") && argv.includes("lock"))).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await store.release(result)
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
      const result = await first
      await firstStore.release(result)
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
    await expect(readDeploymentBySource(join(root, "deployments"), first.path, first.sha)).resolves.toEqual(first)
    await expect(readDeploymentBySource(join(root, "deployments"), join(root, "missing"), first.sha)).resolves.toBe(
      undefined,
    )
    await expect(readLiveDeployments(join(root, "deployments"))).resolves.toEqual([first, second])
    await store.release(first)
    await expect(readLiveDeployments(join(root, "deployments"))).resolves.toEqual([second])
    await store.release(second)
  })

  it("models rollback as a fresh deployment of an older SHA", async () => {
    const { root, repo, sha: olderSha } = await repository()
    await writeFile(join(repo, "README.md"), "newer\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "newer")
    const newerSha = await git(repo, "rev-parse", "HEAD")
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })

    const current = await store.materialize({ deploymentId: "D-current", generation: "G1", sha: newerSha, pin: "tip" })
    const rollback = await store.materialize({
      deploymentId: "D-rollback",
      generation: "G2",
      sha: olderSha,
      pin: "tip",
    })

    expect(rollback.path).not.toBe(current.path)
    expect(await git(rollback.path, "rev-parse", "HEAD")).toBe(olderSha)
    expect(await readFile(join(rollback.path, "README.md"), "utf8")).toBe("root\n")
    await store.release(current)
    await store.release(rollback)
  })

  it("records the exact recursive submodule closure", async () => {
    const { root, repo, sha, nestedSha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })

    const result = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "last-green" })

    expect(result.submodules.map(({ path }) => path)).toEqual(["vendor/dependency", "vendor/dependency/vendor/nested"])
    expect(result.submodules.find(({ path }) => path.endsWith("vendor/nested"))?.sha).toBe(nestedSha)
    expect(existsSync(join(result.path, "vendor/dependency/vendor/nested/nested.txt"))).toBe(true)
    expect(JSON.parse(await readFile(join(root, "deployments", "records", "D1.json"), "utf8"))).toEqual(result)
    await store.release(result)
  })

  it("refuses cleanup unless Hab releases the exact generation, path, and SHA", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })
    const result = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })

    await expect(store.release({ ...result, generation: "G-other" })).rejects.toThrow("generation")
    await expect(store.release({ ...result, path: join(root, "wrong") })).rejects.toThrow("path")
    await expect(store.release({ ...result, sha: "0".repeat(40) })).rejects.toThrow("SHA")
    expect(existsSync(result.path)).toBe(true)

    await expect(store.release(result)).resolves.toEqual({ released: true, path: result.path })
    expect(existsSync(result.path)).toBe(false)
    await expect(store.release(result)).resolves.toEqual({ released: true, path: result.path })
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
    const result = await store.materialize(input)
    expect(result).toMatchObject(input)
    await store.release(result)
  })
})
