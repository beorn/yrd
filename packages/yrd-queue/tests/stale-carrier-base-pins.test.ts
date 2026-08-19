/**
 * @failure Composition stops absorbing a stale carrier — one that never touched
 * a gitlink but whose base moved its submodule pins on — and either refuses it
 * as authored or lands it carrying the older pin.
 * @level l2
 * @consumer @yrd/queue candidate preparer
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { gitCandidatePreparer } from "@yrd/queue"

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

async function gitlinkAt(repo: string, ref: string, path = "dep"): Promise<string> {
  return git(repo, ["ls-tree", "--format=%(objectname)", ref, "--", path])
}

/**
 * A superproject pinning `dep` at A, a carrier branched from there that only
 * adds a file, and a base that has since advanced the pin to B without the
 * carrier's involvement. This is the ordinary shape of any branch that sat
 * while main landed a submodule bump.
 */
async function staleCarrierRepository(): Promise<{
  repo: string
  headSha: string
  branchPointSha: string
  currentBaseSha: string
  moduleA: string
  moduleB: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-stale-carrier-pins-"))
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
  const branchPointSha = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-qc", "issue/feature", branchPointSha])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "carrier: add feature, touch no pin"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])

  await writeFile(join(module, "version.txt"), "b\n")
  await git(module, ["commit", "-qam", "module b"])
  const moduleB = await git(module, ["rev-parse", "HEAD"])
  await git(repo, ["-c", "submodule.recurse=false", "switch", "-q", "main"])
  await git(repo, ["update-index", "--cacheinfo", `160000,${moduleB},dep`])
  await writeFile(join(repo, "upstream.txt"), "upstream\n")
  await git(repo, ["add", "upstream.txt"])
  await git(repo, ["commit", "-qm", "base: bump dep to b"])
  const currentBaseSha = await git(repo, ["rev-parse", "HEAD"])
  return { repo, headSha, branchPointSha, currentBaseSha, moduleA, moduleB }
}

describe("composition absorbs a stale carrier's base pin movement", () => {
  it("composes a carrier that touched no gitlink and keeps the base's newer pin", async () => {
    const fixture = await staleCarrierRepository()
    expect(fixture.moduleA).not.toBe(fixture.moduleB)
    // The carrier's own tree still holds the old pin; only composition decides
    // which one lands.
    expect(await gitlinkAt(fixture.repo, fixture.headSha)).toBe(fixture.moduleA)
    expect(await gitlinkAt(fixture.repo, fixture.currentBaseSha)).toBe(fixture.moduleB)
    await using process = createProcess()

    const candidate = await gitCandidatePreparer({ inject: { process }, repo: fixture.repo })({
      id: "C1",
      queueId: "main",
      baseSha: fixture.currentBaseSha,
      revs: [{ pr: "PR1", n: 1, head: fixture.headSha }],
      prs: [
        {
          id: "PR1",
          branch: "issue/feature",
          base: "main",
          revision: 1,
          headSha: fixture.headSha,
          // The recorded base is where the branch was cut, not where main is
          // now. Composition never consults it to decide authorship.
          baseSha: fixture.branchPointSha,
        },
      ] as never,
    })

    expect(candidate.mergeability).toBe("mergeable")
    expect(candidate.sha).toBeDefined()
    // Main's newer pin survives, and the carrier's file arrives with it.
    expect(await gitlinkAt(fixture.repo, candidate.sha!)).toBe(fixture.moduleB)
    expect(await git(fixture.repo, ["show", `${candidate.sha!}:feature.txt`])).toBe("feature")
    expect(await git(fixture.repo, ["show", `${candidate.sha!}:upstream.txt`])).toBe("upstream")
  })
})
