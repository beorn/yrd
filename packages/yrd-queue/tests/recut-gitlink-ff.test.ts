/**
 * @failure Recut refuses or mis-composes a submodule gitlink conflict that is fast-forward resolvable.
 * @level l2
 * @consumer @yrd/queue Git PR recutter
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type ProcessRequest, type ProcessResult } from "@yrd/process"
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

async function gitlinkAt(repo: string, ref: string, path = "dep"): Promise<string> {
  return git(repo, ["ls-tree", "--format=%(objectname)", ref, "--", path])
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

/** Author the gitlink bump and unrelated file as two immutable carrier commits. */
async function multiCommitCarrier(
  repo: string,
  sourceBase: string,
  carrierPin: string,
  order: "gitlink-first" | "file-first" = "gitlink-first",
): Promise<string> {
  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  const commitGitlink = async () => {
    await git(repo, ["update-index", "--cacheinfo", `160000,${carrierPin},dep`])
    await git(repo, ["commit", "-qm", "carrier: bump dep"])
  }
  const commitFile = async () => {
    await writeFile(join(repo, "feature.txt"), "feature\n")
    await git(repo, ["add", "feature.txt"])
    await git(repo, ["commit", "-qm", "carrier: add feature"])
  }
  if (order === "gitlink-first") {
    await commitGitlink()
    await commitFile()
  } else {
    await commitFile()
    await commitGitlink()
  }
  return git(repo, ["rev-parse", "HEAD"])
}

/** Author one mixed gitlink+file commit followed by another ordinary patch. */
async function mixedCommitCarrier(repo: string, sourceBase: string, carrierPin: string): Promise<string> {
  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  await git(repo, ["update-index", "--cacheinfo", `160000,${carrierPin},dep`])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: bump dep + feature"])
  await writeFile(join(repo, "tail.txt"), "tail\n")
  await git(repo, ["add", "tail.txt"])
  await git(repo, ["commit", "-qm", "carrier: add tail"])
  return git(repo, ["rev-parse", "HEAD"])
}

/** Author a mixed carrier whose merge shape the direct recutter cannot retain. */
async function mergeCarrier(repo: string, sourceBase: string, carrierPin: string): Promise<string> {
  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  await git(repo, ["update-index", "--cacheinfo", `160000,${carrierPin},dep`])
  await git(repo, ["commit", "-qm", "carrier: bump dep"])
  await git(repo, ["switch", "-qc", "issue/side", sourceBase])
  await writeFile(join(repo, "side.txt"), "side\n")
  await git(repo, ["add", "side.txt"])
  await git(repo, ["commit", "-qm", "carrier: add side"])
  await git(repo, ["switch", "-q", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: add feature"])
  await git(repo, ["merge", "-q", "--no-ff", "issue/side", "-m", "carrier: merge side"])
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
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleB)
    expect((await git(repo, ["diff", "--name-only", target, result.headSha])).split("\n").toSorted()).toEqual([
      "dep",
      "feature.txt",
    ])
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })

  it.each([{ order: "gitlink-first" }, { order: "file-first" }] as const)(
    "preserves a two-commit carrier ($order) when the base pin is its ancestor",
    async ({ order }) => {
      const { repo, module, moduleA, sourceBase } = await baseRepo()
      const moduleC = await moduleCommit(module, "main", moduleA, "c")
      const moduleB = await moduleCommit(module, "main", moduleC, "b")
      await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

      const headSha = await multiCommitCarrier(repo, sourceBase, moduleB, order)
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

      expect(await git(repo, ["rev-list", "--count", `${target}..${result.headSha}`])).toBe("2")
      expect(await git(repo, ["rev-parse", `${result.headSha}~2`])).toBe(target)
      expect(
        (await git(repo, ["log", "--reverse", "--format=%s", `${target}..${result.headSha}`])).split("\n"),
      ).toEqual(
        order === "gitlink-first"
          ? ["carrier: bump dep", "carrier: add feature"]
          : ["carrier: add feature", "carrier: bump dep"],
      )
      expect(await gitlinkAt(repo, result.headSha)).toBe(moduleB)
      expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
      expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
    },
  )

  it("retains a non-gitlink patch in the same commit as an FF-certified gitlink", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])
    const headSha = await mixedCommitCarrier(repo, sourceBase, moduleB)
    const target = await advanceBase(repo, moduleC)

    await using process = createProcess()
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: sourceBase,
    })

    expect(await git(repo, ["rev-parse", `${result.headSha}~2`])).toBe(target)
    expect((await git(repo, ["log", "--reverse", "--format=%s", `${target}..${result.headSha}`])).split("\n")).toEqual([
      "carrier: bump dep + feature",
      "carrier: add tail",
    ])
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleB)
    expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
    expect(await git(repo, ["show", `${result.headSha}:tail.txt`])).toBe("tail")
  })

  it("refuses a lossy UTF-8 collision in an FF-gitlink patch certificate", async () => {
    const { repo, module, moduleA } = await baseRepo()
    const encoder = new TextEncoder()
    const basePayload = "authority: base\nkeep a\nkeep b\nkeep c\nmarker: old\n"
    await writeFile(join(repo, "payload.txt"), basePayload)
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", "add overlap payload"])
    const sourceBase = await git(repo, ["rev-parse", "HEAD"])

    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

    await git(repo, ["switch", "-qc", "issue/bytes", sourceBase])
    await git(repo, ["update-index", "--cacheinfo", `160000,${moduleB},dep`])
    await writeFile(join(repo, "payload.txt"), basePayload.replace("marker: old", "marker: �("))
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", "carrier: bump dep + exact bytes"])
    const headSha = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["update-index", "--cacheinfo", `160000,${moduleC},dep`])
    const currentPayload = basePayload.replace("authority: base", "authority: current")
    await writeFile(join(repo, "payload.txt"), currentPayload)
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", "base: bump dep + overlap payload"])

    const invalidPayload = new Uint8Array([
      ...encoder.encode(currentPayload.replace("marker: old\n", "marker: ")),
      0xc3,
      0x28,
      0x0a,
    ])
    await using delegate = createProcess()
    let tamper = true
    const process = {
      run: async (request: ProcessRequest): Promise<ProcessResult> => {
        const result = await delegate.run(request)
        if (tamper && result.exitCode === 0 && request.argv.includes("rebase")) {
          tamper = false
          const path = request.cwd ?? repo
          await writeFile(join(path, "payload.txt"), invalidPayload)
          await git(path, ["add", "payload.txt"])
          await git(path, [
            "-c",
            "user.name=Yrd Queue",
            "-c",
            "user.email=yrd-queue@example.invalid",
            "commit",
            "--amend",
            "-qm",
            "tamper raw payload bytes",
          ])
        }
        return result
      },
    }

    await expect(
      createGitPRRecutter({ inject: { process }, repo }).recut({
        id: "PR1",
        branch: "issue/bytes",
        base: "main",
        revision: 1,
        headSha,
        baseSha: sourceBase,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "payload-certificate",
        message: expect.stringContaining("changed stable patch identity"),
      },
    })
  })

  it("refuses a same-tree recut that squashes an FF gitlink commit into its neighbor", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])
    const headSha = await multiCommitCarrier(repo, sourceBase, moduleB)
    await advanceBase(repo, moduleC)
    const hook = join(repo, ".git", "hooks", "post-rewrite")
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        "set -eu",
        'target=$(git rev-parse "HEAD~2")',
        'tree=$(git rev-parse "HEAD^{tree}")',
        'squashed=$(printf "%s\\n" "carrier: squashed" | git commit-tree "$tree" -p "$target")',
        'git update-ref HEAD "$squashed"',
        "",
      ].join("\n"),
    )
    await chmod(hook, 0o755)

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
        code: "payload-certificate",
        message: expect.stringContaining("not commit-sequence equivalent"),
      },
    })
  })

  it("keeps mixed merge carriers fail-closed when merge shape cannot be retained", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

    const headSha = await mergeCarrier(repo, sourceBase, moduleB)
    await advanceBase(repo, moduleC)

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
        code: "payload-certificate",
        message: expect.stringContaining("no stable commit-sequence identity"),
      },
    })
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
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleC)
    expect(await git(repo, ["diff", "--name-only", target, result.headSha])).toBe("feature.txt")
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })

  it.each([{ order: "gitlink-first" }, { order: "file-first" }] as const)(
    "drops only the absorbed gitlink commit from a two-commit carrier ($order)",
    async ({ order }) => {
      const { repo, module, moduleA, sourceBase } = await baseRepo()
      const moduleB = await moduleCommit(module, "main", moduleA, "b")
      const moduleC = await moduleCommit(module, "main", moduleB, "c")
      await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

      const headSha = await multiCommitCarrier(repo, sourceBase, moduleB, order)
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

      expect(await git(repo, ["rev-list", "--count", `${target}..${result.headSha}`])).toBe("1")
      expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(target)
      expect(await git(repo, ["log", "-1", "--format=%s", result.headSha])).toBe("carrier: add feature")
      expect(await gitlinkAt(repo, result.headSha)).toBe(moduleC)
      expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
      expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
    },
  )

  it("refuses transient absorbed-pin commits injected into the recut range", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "main", moduleA, "b")
    const moduleC = await moduleCommit(module, "main", moduleB, "c")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])
    const headSha = await multiCommitCarrier(repo, sourceBase, moduleB)
    await advanceBase(repo, moduleC)
    const hook = join(repo, ".git", "hooks", "post-rewrite")
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        "set -eu",
        `git update-index --cacheinfo 160000,${moduleB},dep`,
        'git commit -qm "tamper: restore absorbed pin"',
        `git update-index --cacheinfo 160000,${moduleC},dep`,
        'git commit -qm "tamper: restore authoritative pin"',
        "",
      ].join("\n"),
    )
    await chmod(hook, 0o755)

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
        code: "payload-certificate",
        message: expect.stringContaining("no stable commit-sequence identity"),
      },
    })
  })

  it("refuses loudly when the carrier and base pins have truly diverged", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "carrier-row", moduleA, "b")
    const moduleC = await moduleCommit(module, "base-row", moduleA, "c")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "carrier-row", "base-row"])
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
