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

/** Commit one disjoint module file so two sibling pins can merge cleanly. */
async function moduleFileCommit(
  module: string,
  branch: string,
  from: string,
  file: string,
  value: string,
): Promise<string> {
  await git(module, ["checkout", "-q", "-B", branch, from])
  await writeFile(join(module, file), `${value}\n`)
  await git(module, ["add", file])
  await git(module, ["commit", "-qm", `module ${value}`])
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

/**
 * Reproduce PR928's root/submodule topology: the feature lineage temporarily
 * carries one submodule side, current main carries its sibling, and the final
 * feature pin is a merge descendant of both. The root branch then merges
 * current main before the authoritative root advances once more.
 */
async function currentMainMergeCarrier(
  repo: string,
  sourceBase: string,
  transientPin: string,
  authoritativePin: string,
  finalPin: string,
): Promise<{ headSha: string; recordedBase: string; target: string }> {
  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  await git(repo, ["update-index", "--cacheinfo", `160000,${transientPin},dep`])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: transient pin + feature"])
  await git(repo, ["update-index", "--cacheinfo", `160000,${finalPin},dep`])
  await git(repo, ["commit", "-qm", "carrier: final composed pin"])

  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["update-index", "--cacheinfo", `160000,${authoritativePin},dep`])
  await writeFile(join(repo, "upstream.txt"), "upstream\n")
  await git(repo, ["add", "upstream.txt"])
  await git(repo, ["commit", "-qm", "base: authoritative sibling pin"])
  const recordedBase = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-q", "issue/feature"])
  await git(repo, ["merge", "-q", "--no-ff", "main", "-m", "carrier: merge current main"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-q", "main"])
  await writeFile(join(repo, "later.txt"), "later\n")
  await git(repo, ["add", "later.txt"])
  await git(repo, ["commit", "-qm", "base: advance after submission"])
  return { headSha, recordedBase, target: await git(repo, ["rev-parse", "HEAD"]) }
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

  it("certifies the final descendant pin across a current-main merge (21556 / PR928)", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const transientPin = await moduleFileCommit(module, "network", moduleA, "network.txt", "network")
    const authoritativePin = await moduleFileCommit(module, "runtime", moduleA, "runtime.txt", "runtime")
    await git(module, ["switch", "-qc", "composed", authoritativePin])
    await git(module, ["merge", "-q", "--no-ff", transientPin, "-m", "module: compose network + runtime"])
    const finalPin = await git(module, ["rev-parse", "HEAD"])
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "network", "runtime", "composed"])
    expect(await isAncestor(join(repo, "dep"), transientPin, authoritativePin)).toBe(false)
    expect(await isAncestor(join(repo, "dep"), authoritativePin, transientPin)).toBe(false)
    expect(await isAncestor(join(repo, "dep"), transientPin, finalPin)).toBe(true)
    expect(await isAncestor(join(repo, "dep"), authoritativePin, finalPin)).toBe(true)

    const { headSha, recordedBase, target } = await currentMainMergeCarrier(
      repo,
      sourceBase,
      transientPin,
      authoritativePin,
      finalPin,
    )
    expect(await gitlinkAt(repo, recordedBase)).toBe(authoritativePin)
    expect(await gitlinkAt(repo, headSha)).toBe(finalPin)

    await using process = createProcess()
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR928",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: recordedBase,
    })

    expect(await git(repo, ["rev-parse", `${result.headSha}~1`])).toBe(target)
    expect(await gitlinkAt(repo, result.headSha)).toBe(finalPin)
    expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
  })

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

  it("accepts a same-tree recut that folds an FF gitlink-only slot into its neighbor", async () => {
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
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: sourceBase,
    })
    expect(await git(repo, ["rev-list", "--count", `${result.baseSha}..${result.headSha}`])).toBe("1")
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleB)
    expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
  })

  it("certifies a mixed merge carrier by final pin and payload when merge shape is flattened", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

    const headSha = await mergeCarrier(repo, sourceBase, moduleB)
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
    expect(await git(repo, ["merge-base", "--is-ancestor", target, result.headSha])).toBe("")
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleB)
    expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
    expect(await git(repo, ["show", `${result.headSha}:side.txt`])).toBe("side")
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

  it("ignores transient absorbed-pin history when the final pin is authoritative", async () => {
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
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: sourceBase,
    })
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleC)
    expect(await git(repo, ["show", `${result.headSha}:feature.txt`])).toBe("feature")
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

  /**
   * 21461: when the recut's scratch worktree has the submodule CHECKED OUT,
   * git's merge machinery proves the gitlink ancestry itself and fast-forwards
   * with NO conflict — the conflict-time classification never runs. These rows
   * force that environment by initializing the submodule inside the scratch
   * right after `worktree add` (the integrator's persistent-worktree shape),
   * and pin the mechanism by asserting the rebase succeeded first try with no
   * conflict-resolution `update-index --cacheinfo` call.
   */
  function scratchAutoFfProcess(delegate: { run(request: ProcessRequest): Promise<ProcessResult> }) {
    const seen: string[][] = []
    const process = {
      run: async (request: ProcessRequest): Promise<ProcessResult> => {
        seen.push([...request.argv])
        const result = await delegate.run(request)
        const argv = request.argv
        const worktreeAt = argv.indexOf("worktree")
        if (result.exitCode === 0 && worktreeAt !== -1 && argv[worktreeAt + 1] === "add") {
          // argv tail is `… worktree add --detach <path> <ref>`.
          const scratchPath = argv[argv.length - 2]
          if (scratchPath === undefined) throw new Error(`unexpected worktree-add argv: ${argv.join(" ")}`)
          await git(scratchPath, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "dep"])
        }
        return result
      },
    }
    const initialRebases = () =>
      seen.filter((argv) => argv.includes("rebase") && !argv.includes("--abort") && !argv.includes("--continue"))
    const conflictResolutions = () =>
      seen.filter((argv) => argv.includes("update-index") && argv.includes("--cacheinfo"))
    return { process, initialRebases, conflictResolutions }
  }

  it("certifies a carrier gitlink git auto-fast-forwarded without a conflict (21461)", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

    const headSha = await carrier(repo, sourceBase, moduleB)
    const target = await advanceBase(repo, moduleC)

    const dirtyBefore = await git(repo, ["status", "--porcelain"])
    await using delegate = createProcess()
    const { process, initialRebases, conflictResolutions } = scratchAutoFfProcess(delegate)
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha,
      baseSha: sourceBase,
    })

    // Mechanism pin: the rebase fast-forwarded the gitlink itself — one initial
    // rebase, no `rebase --continue`, zero conflict-time pin resolutions.
    // Without this, the row silently degenerates to the already-tested
    // conflict path.
    expect(initialRebases()).toHaveLength(1)
    expect(conflictResolutions()).toHaveLength(0)

    expect(result.unchanged).toBe(false)
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(target)
    expect(await gitlinkAt(repo, result.headSha)).toBe(moduleB)
    expect((await git(repo, ["diff", "--name-only", target, result.headSha])).split("\n").toSorted()).toEqual([
      "dep",
      "feature.txt",
    ])
    expect(await git(repo, ["status", "--porcelain"])).toBe(dirtyBefore)
  })

  it("still refuses non-gitlink tampering on the auto-fast-forward path", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "main"])

    const headSha = await carrier(repo, sourceBase, moduleB)
    await advanceBase(repo, moduleC)

    await using delegate = createProcess()
    const inner = scratchAutoFfProcess(delegate)
    let tamper = true
    const process = {
      run: async (request: ProcessRequest): Promise<ProcessResult> => {
        const result = await inner.process.run(request)
        if (tamper && result.exitCode === 0 && request.argv.includes("rebase")) {
          tamper = false
          const path = request.cwd ?? repo
          await writeFile(join(path, "feature.txt"), "tampered\n")
          await git(path, ["add", "feature.txt"])
          await git(path, [
            "-c",
            "user.name=Yrd Queue",
            "-c",
            "user.email=yrd-queue@example.invalid",
            "commit",
            "--amend",
            "-qm",
            "tamper authored payload",
          ])
        }
        return result
      },
    }

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
        code: "payload-identity",
        message: expect.stringContaining("changed blob, mode, status, path, or gitlink identity"),
      },
    })
  })

  it("stays fail-closed when the auto-fast-forward cannot be re-proved in the integrator's store", async () => {
    const { repo, module, moduleA, sourceBase } = await baseRepo()
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    const moduleB = await moduleCommit(module, "main", moduleC, "b")
    // Deliberately NO fetch into repo/dep: the scratch's fresh submodule clone
    // lets git fast-forward, but the integrator's own submodule store cannot
    // re-prove the ancestry — the path must stay unclassified and the strict
    // certificate must refuse rather than trust the scratch.
    const headSha = await carrier(repo, sourceBase, moduleB)
    await advanceBase(repo, moduleC)

    await using delegate = createProcess()
    const { process } = scratchAutoFfProcess(delegate)
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
        message: expect.stringContaining("changed stable patch identity"),
      },
    })
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
