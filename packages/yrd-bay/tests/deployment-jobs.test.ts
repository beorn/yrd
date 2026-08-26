/**
 * @failure Deployment job definitions can release or reap a live path without an exact Hab authorization receipt.
 * @level l2
 * @consumer Hab generation activation through Yrd
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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

describe("createDeploymentJobDefs", () => {
  it("routes authorized release through a keyed Journal Job definition", async () => {
    const { root, repo, sha } = await repository()
    await using process = createProcess()
    const store = await createGitDeploymentStore({ repo, deploymentsRoot: join(root, "deployments"), process })
    const result = await store.materialize({ deploymentId: "D1", generation: "G1", sha, pin: "tip" })
    const jobs = createDeploymentJobDefs(store)
    const release = jobs["deployment.release"]
    const context = {
      id: "release-D1",
      attempt: 1,
      runner: "test",
      signal: new AbortController().signal,
    }
    const habReleaseResult = {
      schema: "hab-service-generation-release/1" as const,
      jurisdiction: "single-habitat" as const,
      habitatRoot: join(root, "habitat"),
      retiredSource: { path: result.path, sha: result.sha, verification: "verified" as const },
      replacementSource: {
        path: join(root, "deployments", "roots", "D2"),
        sha: "2".repeat(40),
        verification: "verified" as const,
      },
      releasedAt: "2026-08-11T20:00:00.000Z",
    }
    const input = {
      deploymentId: result.deploymentId,
      generation: result.generation,
      path: result.path,
      sha: result.sha,
      authorization: {
        kind: "hab-generation-release" as const,
        generation: result.generation,
        path: result.path,
        sha: result.sha,
        receipt: habReleaseResult,
      },
    }

    expect(release.request(input, { key: deploymentJobKey("release", result.deploymentId) })).toMatchObject({
      data: { key: "deployment:D1:release" },
    })
    await expect(
      release.execute({ ...input, authorization: { ...input.authorization, path: join(root, "wrong") } }, context),
    ).resolves.toMatchObject({ status: "completed", conclusion: "failure" })
    expect(existsSync(result.path)).toBe(true)
    await expect(
      release.execute(
        {
          ...input,
          authorization: {
            ...input.authorization,
            receipt: {
              ...habReleaseResult,
              retiredSource: { path: join(root, "wrong"), sha: result.sha, verification: "verified" },
            },
          },
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "completed", conclusion: "failure" })
    expect(existsSync(result.path)).toBe(true)
    await expect(
      release.execute(
        {
          ...input,
          authorization: {
            ...input.authorization,
            receipt: { ...habReleaseResult, nonce: "strict-same-user-schema-has-no-nonce" },
          },
        },
        context,
      ),
    ).rejects.toThrow(/unrecognized key.*nonce/iu)
    expect(existsSync(result.path)).toBe(true)
    await expect(release.execute(input, context)).resolves.toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { released: true, path: result.path },
    })
  })
})
