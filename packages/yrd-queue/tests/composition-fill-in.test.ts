/**
 * @failure The queue lands a composed submodule value verbatim while that submodule's main
 *          has already moved past it, so the merged root pins a commit that is not the
 *          newest commit on the submodule's main — or the fill-in write silently rewrites
 *          values it has no authority over.
 * @level l2
 * @consumer @yrd/queue candidate preparer — step (b)'s composition-time shaset write
 *
 * The shaset model: a composed submodule value is a floor. At candidate composition the
 * queue resolves that submodule's main; when main already contains the composed value and
 * has moved further, the queue fills in main's newest commit, records it as a submodule
 * resolution, and checks judge THAT tree. When the composed value is ahead of main it
 * rides unchanged (the merge-time promotion advances main to it), and genuinely diverged
 * histories refuse at composition time under the merge path's existing code.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { createProcess } from "@yrd/process"
import { gitCandidatePreparer, type CandidatePreparationInput } from "@yrd/queue"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
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

/** A superproject pinning submodule `dep` at module commit A, whose module repo
 * ("origin" for the dep checkout) can move its main per test. */
async function baseRepo(): Promise<{ repo: string; module: string; moduleA: string; rootBase: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-composition-fill-in-"))
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
  const rootBase = await git(repo, ["rev-parse", "HEAD"])
  return { repo, module, moduleA, rootBase }
}

/** Commit a module change on `branch` (created at `from` if missing) and return its sha. */
async function moduleCommit(module: string, branch: string, from: string, value: string): Promise<string> {
  await git(module, ["checkout", "-q", "-B", branch, from])
  await writeFile(join(module, "version.txt"), `${value}\n`)
  await git(module, ["commit", "-qam", `module ${value}`])
  return git(module, ["rev-parse", "HEAD"])
}

/** A source-only composed PR: the root head IS the base, and the whole payload
 * rides as one composition source over `dep`. */
function composedPreparation(
  rootBase: string,
  source: Readonly<{ branch: string; baseSha: string; tipSha: string; payload: readonly string[] }>,
): CandidatePreparationInput {
  return {
    id: "C1",
    queueId: "refs/heads/main",
    baseSha: rootBase,
    revs: [{ pr: "PR1", n: 1, head: rootBase }],
    prs: [
      {
        id: "PR1",
        branch: "issue/feature",
        base: "main",
        revision: 1,
        headSha: rootBase,
        baseSha: rootBase,
        composition: { version: 1, sources: [{ repo: "dep", ...source }] },
      },
    ],
  }
}

describe("composition-time fill-in — the queue writes the shaset from each submodule's main", () => {
  it("fills in main's newest commit when main moved past the composed floor, and records the resolution", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    // The composed work landed on the submodule's main, and main moved further.
    const moduleB = await moduleCommit(module, "main", moduleA, "b")
    const moduleM = await moduleCommit(module, "main", moduleB, "m")

    await using process = createProcess({ cwd: repo })
    const prepared = await gitCandidatePreparer({ inject: { process }, repo })(
      composedPreparation(rootBase, { branch: "main", baseSha: moduleA, tipSha: moduleB, payload: ["version.txt"] }),
    )

    expect(prepared.mergeability).toBe("mergeable")
    if (prepared.mergeability !== "mergeable" || prepared.sha === undefined) throw new Error("unreachable")
    // The candidate pins the newest commit on the submodule's main, not the floor.
    expect(await gitlinkAt(repo, prepared.sha)).toBe(moduleM)
    // The filled value is recorded as a submodule resolution — the final word the
    // merge-time validator and the merge record both read for this path.
    expect(prepared.submoduleResolutions).toEqual([{ kind: "pin", path: "dep", sha: moduleM }])
    // The certified source rewrite still names the floor: the payload certificate
    // is about the reviewed change, the resolution is about the landed value.
    expect(prepared.sourceRewrites?.[0]).toMatchObject({ repo: "dep", newTipSha: moduleB })
  })

  it("keeps a composed value that is ahead of the submodule's main — promotion advances main at merge", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "feature", moduleA, "b")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "feature"])

    await using process = createProcess({ cwd: repo })
    const prepared = await gitCandidatePreparer({ inject: { process }, repo })(
      composedPreparation(rootBase, { branch: "feature", baseSha: moduleA, tipSha: moduleB, payload: ["version.txt"] }),
    )

    expect(prepared.mergeability).toBe("mergeable")
    if (prepared.mergeability !== "mergeable" || prepared.sha === undefined) throw new Error("unreachable")
    expect(await gitlinkAt(repo, prepared.sha)).toBe(moduleB)
    // Nothing was filled in: no resolution row, so the source certificate alone
    // holds this path to its value.
    expect(prepared.submoduleResolutions).toBeUndefined()
  })

  it("refuses at composition when the composed value and the submodule's main diverge", async () => {
    const { repo, module, moduleA, rootBase } = await baseRepo()
    const moduleB = await moduleCommit(module, "feature", moduleA, "b")
    // Main took a different history after the source branched.
    const moduleC = await moduleCommit(module, "main", moduleA, "c")
    await git(join(repo, "dep"), ["fetch", "-q", "origin", "feature"])

    await using process = createProcess({ cwd: repo })
    const error = await Promise.resolve(
      gitCandidatePreparer({ inject: { process }, repo })(
        composedPreparation(rootBase, {
          branch: "feature",
          baseSha: moduleA,
          tipSha: moduleB,
          payload: ["version.txt"],
        }),
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    const fact = failureFact(error)
    if (fact === undefined) throw new Error(`expected a typed refusal, got ${String(error)}`)
    expect(fact.code).toBe("component-main-non-ancestral")
    // The receipt names both sides: the author's next act is recomposing the
    // submodule history, and they cannot check it without the two shas.
    expect(fact.message).toContain(moduleB)
    expect(fact.message).toContain(moduleC)
  })
})
