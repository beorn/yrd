/**
 * @failure Recut refuses or mis-composes a submodule gitlink conflict that is fast-forward resolvable.
 * @level l2
 * @consumer @yrd/queue Git PR recutter
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { createGitPRRecutter } from "@yrd/queue"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const child = Bun.spawn(["git", "-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return (await child.exited) === 0
}

/**
 * A superproject with one submodule `dep` cloned while the module holds only
 * commit A, plus a standalone module repo whose history can be extended per
 * test. `dep` is pinned at A (`moduleA`) and committed, ready to be a recut base.
 */
async function baseRepo(): Promise<{ repo: string; module: string; moduleA: string; sourceBase: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-recut-ff-"))
  roots.push(root)
  const repo = join(root, "repo")
  const module = join(root, "module")
  await Bun.$`git init -q -b main ${module}`
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await git(module, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  await writeFile(join(module, "version.txt"), "a\n")
  await git(module, ["add", "version.txt"])
  await git(module, ["commit", "-qm", "module a"])
  const moduleA = await git(module, ["rev-parse", "HEAD"])

  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await git(repo, ["config", "protocol.file.allow", "always"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "root"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dep at a"])
  const sourceBase = await git(repo, ["rev-parse", "HEAD"])
  return { repo, module, moduleA, sourceBase }
}

/** Commit a module version on `branch` (created if missing) and return its sha. */
async function moduleCommit(module: string, branch: string, from: string, value: string): Promise<string> {
  await git(module, ["checkout", "-q", "-B", branch, from])
  await writeFile(join(module, "version.txt"), `${value}\n`)
  await git(module, ["commit", "-qam", `module ${value}`])
  return git(module, ["rev-parse", "HEAD"])
}

/** Author a carrier commit that pins `dep` to `carrierPin` plus an unrelated file. */
async function carrier(repo: string, sourceBase: string, carrierPin: string): Promise<string> {
  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  await git(repo, ["update-index", "--cacheinfo", `160000,${carrierPin},dep`])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: bump dep + feature"])
  return git(repo, ["rev-parse", "HEAD"])
}

/** Advance authoritative main: pin `dep` to `basePin` plus an unrelated file. */
async function advanceBase(repo: string, basePin: string): Promise<string> {
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["update-index", "--cacheinfo", `160000,${basePin},dep`])
  await writeFile(join(repo, "upstream.txt"), "upstream\n")
  await git(repo, ["add", "upstream.txt"])
  await git(repo, ["commit", "-qm", "base: bump dep + upstream"])
  return git(repo, ["rev-parse", "HEAD"])
}

describe("recut fast-forward gitlink resolution", () => {
  it("resolves to the carrier pin when the base pin is its ancestor (ff-forward)", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])
    expect(await isAncestor(join(repo, "dep"), moduleC, moduleB)).toBe(true)

    const headSha = await carrier(repo, sourceBase, moduleB)
    const target = await advanceBase(repo, moduleC)

    const dirtyBefore = await git(repo, ["status", "--porcelain"])
    await using process = createProcess()
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: sourceBase,
    })

    expect(result.unchanged).toBe(false)
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(target)
    // Lands the carrier's descendant pin (B), not the base pin (C).
    expect(await git(repo, ["ls-tree", result.headSha, "dep"])).toContain(moduleB)
    expect((await git(repo, ["diff", "--name-only", target, result.headSha])).split("\n").toSorted()).toEqual([
      "dep",
      "feature.txt",
    ])
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })

  it("resolves to the base pin when the carrier pin is its ancestor (reverse ff)", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "main", moduleA, "b")
    const moduleC = await moduleCommit(module, "main", moduleB, "c")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])
    expect(await isAncestor(join(repo, "dep"), moduleB, moduleC)).toBe(true)

    const headSha = await carrier(repo, sourceBase, moduleB)
    const target = await advanceBase(repo, moduleC)

    const dirtyBefore = await git(repo, ["status", "--porcelain"])
    await using process = createProcess()
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: sourceBase,
    })

    expect(result.unchanged).toBe(false)
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(target)
    // The carrier's dep bump is superseded by the base descendant (C); only the
    // unrelated authored file survives, and dep keeps the base pin.
    expect(await git(repo, ["ls-tree", result.headSha, "dep"])).toContain(moduleC)
    expect(await git(repo, ["diff", "--name-only", target, result.headSha])).toBe("feature.txt")
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })

  it("refuses loudly when the carrier and base pins have truly diverged", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "carrier-line", moduleA, "b")
    const moduleC = await moduleCommit(module, "base-line", moduleA, "c")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "carrier-line", "base-line"])
    expect(await isAncestor(join(repo, "dep"), moduleB, moduleC)).toBe(false)
    expect(await isAncestor(join(repo, "dep"), moduleC, moduleB)).toBe(false)

    const headSha = await carrier(repo, sourceBase, moduleB)
    await advanceBase(repo, moduleC)

    const dirtyBefore = await git(repo, ["status", "--porcelain"])
    await using process = createProcess()
    await expect(
      createGitPRRecutter({ inject: { process }, repo }).recut({
        id: "PR1",
        branch: "issue/feature",
        base: "main",
        revision: 1,
        headSha,
        baseSha: sourceBase,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "recut-gitlink-conflict",
        message: expect.stringContaining("neither is an ancestor of the other"),
      },
    })
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })

  it("refuses loudly and names the object when the carrier pin is absent locally", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])
    // A well-formed pin the integrator's submodule store has never fetched.
    const absentPin = "0123456789abcdef0123456789abcdef01234567"

    const headSha = await carrier(repo, sourceBase, absentPin)
    await advanceBase(repo, moduleC)

    const dirtyBefore = await git(repo, ["status", "--porcelain"])
    await using process = createProcess()
    await expect(
      createGitPRRecutter({ inject: { process }, repo }).recut({
        id: "PR1",
        branch: "issue/feature",
        base: "main",
        revision: 1,
        headSha,
        baseSha: sourceBase,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "recut-gitlink-conflict",
        message: expect.stringContaining(`commit '${absentPin}' is not present`),
      },
    })
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })
})
