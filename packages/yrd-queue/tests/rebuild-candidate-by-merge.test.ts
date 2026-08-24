/**
 * @failure A base-moved rebuild silently rewrites the author's tip, drops a witness that
 *          would catch lost work, mis-resolves a moved submodule gitlink, or mints
 *          bay-state that nothing should mint any more (a rebuild is not a new revision).
 * @level l2
 * @consumer re-merge Phase 1 — the freshness pass's direct-revision rebuild
 *
 * `rebuildCandidateByMerge` replaces the scratch `rebase --onto` path
 * (`remergeDirectChange`) for the direct (non-composed, non-proposed) case: a
 * candidate is `merge(base tip, unchanged authored tip)` plus the shaset
 * fill-in, built by the SAME per-member logic `prepareCandidateMembers` uses
 * for first-candidate construction (one-element `prs`) — proof of that reuse
 * is test 9 below, run against the exact fixtures the first-candidate witness
 * suite already trusts.
 *
 * Every case runs over real git history via `tests/support/remerge-fixtures.ts`.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { rebuildCandidateByMerge } from "@yrd/queue"
import { exactDelta } from "../src/content-identity.ts"
import { emptyCandidateFixture, fixtureRefGit, movedBaseFixture } from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function options(repo: string): Parameters<typeof rebuildCandidateByMerge>[0] {
  return { inject: { process: createProcess() }, repo }
}

describe("rebuildCandidateByMerge — moved base, direct revision", () => {
  it("1. never rewrites the authored tip: the candidate's second parent is the unchanged authored tip", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const parents = await git.run(fixture.repo, ["rev-list", "--parents", "-n1", result.sha])
    const [, ...parentShas] = parents.split(/\s+/u)
    expect(parentShas).toEqual([fixture.baseTwo, fixture.authorTip])
  })

  it("2. overlapping-but-mergeable: resolves cleanly and the delta against the new base names exactly the authored path", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "overlapping-path-mergeable" })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const delta = await exactDelta(git, fixture.repo, fixture.baseTwo, result.sha)
    expect(delta.entries.map((entry) => entry.path)).toEqual([fixture.authorPath])
  })

  it("3. overlapping-and-conflicting: refuses merge-conflict naming the authored path with the DoD remedy", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "overlapping-path-conflicting" })
    roots.push(fixture.root)

    await expect(
      rebuildCandidateByMerge(
        options(fixture.repo),
        { sha: fixture.baseTwo },
        {
          id: "PR1",
          branch: fixture.authorBranch,
          headSha: fixture.authorTip,
        },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "merge-conflict",
        message: expect.stringContaining(fixture.authorPath),
      },
    })
    await expect(
      rebuildCandidateByMerge(
        options(fixture.repo),
        { sha: fixture.baseTwo },
        {
          id: "PR1",
          branch: fixture.authorBranch,
          headSha: fixture.authorTip,
        },
      ),
    ).rejects.toMatchObject({
      failure: { message: expect.stringContaining("merge or rebase locally") },
    })
  })
})

/**
 * A REAL, fetchable submodule (`git submodule add`, matching
 * `command.test.ts`'s `hookedSubmoduleRepository` technique) where the
 * superproject's `main` and an author branch each advance the SAME gitlink to
 * a DIFFERENT submodule commit — the conflict `git merge` reports at that
 * path. `content-identity.test.ts`'s `bothSidesMovedGitlinkFixture` cannot
 * serve these tests: its submodule objects are deliberately absent from any
 * fetchable remote (built for `exactDelta` tree-level testing only), and the
 * shaset fill-in genuinely fetches from the submodule's origin.
 */
async function gitlinkConflictFixture(options: {
  /** Whether the author's move is reachable from the submodule's own main
   * BEFORE the rebuild runs — the shaset fill-in's precondition. */
  authorPublishedToMain: boolean
}): Promise<{
  root: string
  superRepo: string
  moduleRepo: string
  gitlinkPath: string
  targetSha: string
  authorBranch: string
  authorTip: string
  authorModuleSha: string
}> {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(tmpdir(), "yrd-rebuild-gitlink-"))
  const superRepo = join(root, "super")
  const moduleRepo = join(root, "module")
  const gitlinkPath = "dep"

  await git.run(root, ["init", "-q", "-b", "main", "module"])
  await git.run(moduleRepo, ["config", "user.name", "Yrd Test"])
  await git.run(moduleRepo, ["config", "user.email", "yrd@example.invalid"])
  await Bun.write(`${moduleRepo}/version.txt`, "base\n")
  await git.run(moduleRepo, ["add", "version.txt"])
  await git.run(moduleRepo, ["commit", "-qm", "module base"])

  await git.run(root, ["init", "-q", "-b", "main", "super"])
  await git.run(superRepo, ["config", "user.name", "Yrd Test"])
  await git.run(superRepo, ["config", "user.email", "yrd@example.invalid"])
  await git.run(superRepo, ["config", "protocol.file.allow", "always"])
  await git.run(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRepo, gitlinkPath])
  await git.run(superRepo, ["commit", "-qm", "add dependency"])
  const baseSuperSha = await git.run(superRepo, ["rev-parse", "HEAD"])

  const authorBranch = "task/author-gitlink"
  await git.run(superRepo, ["switch", "-qc", authorBranch, baseSuperSha])
  await git.run(moduleRepo, ["switch", "-qc", "side"])
  // A disjoint path from "main move" below, so publishing this to main (a
  // real --no-ff merge, not a fast-forward — the two submodule commits are
  // genuine siblings off the same base) resolves cleanly with no content
  // conflict of its own; only the SHA divergence matters to this fixture.
  await Bun.write(`${moduleRepo}/author.txt`, "author\n")
  await git.run(moduleRepo, ["add", "author.txt"])
  await git.run(moduleRepo, ["commit", "-qm", "author move"])
  const authorModuleSha = await git.run(moduleRepo, ["rev-parse", "HEAD"])
  await git.run(moduleRepo, ["switch", "-q", "main"])
  await git.run(join(superRepo, gitlinkPath), ["fetch", "-q", "origin"])
  await git.run(join(superRepo, gitlinkPath), ["checkout", "-q", authorModuleSha])
  await git.run(superRepo, ["add", "--", gitlinkPath])
  await git.run(superRepo, ["commit", "-qm", "author: advance dependency"])
  const authorTip = await git.run(superRepo, ["rev-parse", "HEAD"])

  await git.run(superRepo, ["switch", "-q", "main"])
  await Bun.write(`${moduleRepo}/main.txt`, "main\n")
  await git.run(moduleRepo, ["add", "main.txt"])
  await git.run(moduleRepo, ["commit", "-qm", "main move"])
  const mainModuleSha = await git.run(moduleRepo, ["rev-parse", "HEAD"])
  await git.run(join(superRepo, gitlinkPath), ["fetch", "-q", "origin"])
  await git.run(join(superRepo, gitlinkPath), ["checkout", "-q", mainModuleSha])
  await git.run(superRepo, ["add", "--", gitlinkPath])
  await git.run(superRepo, ["commit", "-qm", "main: advance dependency"])
  const targetSha = await git.run(superRepo, ["rev-parse", "HEAD"])

  if (options.authorPublishedToMain) {
    await git.run(moduleRepo, ["merge", "-q", "--no-ff", "-m", "publish author's move", "side"])
  }

  return { root, superRepo, moduleRepo, gitlinkPath, targetSha, authorBranch, authorTip, authorModuleSha }
}

describe("rebuildCandidateByMerge — both sides moved the same gitlink", () => {
  it("4. author's submodule commit IS published to the submodule's main: the gitlink fills from main, no refusal", async () => {
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const filled = await git.run(fixture.superRepo, ["rev-parse", `${result.sha}:${fixture.gitlinkPath}`])
    const submoduleMain = await git.run(fixture.moduleRepo, ["rev-parse", "main"])
    expect(filled).toBe(submoduleMain)
    // The fill is main's newest commit, which contains the author's move.
    await git.run(fixture.moduleRepo, ["merge-base", "--is-ancestor", fixture.authorModuleSha, submoduleMain])
  })

  it("5. author's submodule commit is NOT published to the submodule's main: refuses min-commit-unpublished", async () => {
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: false })
    roots.push(fixture.root)

    await expect(
      rebuildCandidateByMerge(
        options(fixture.superRepo),
        { sha: fixture.targetSha },
        {
          id: "PR1",
          branch: fixture.authorBranch,
          headSha: fixture.authorTip,
        },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "min-commit-unpublished",
        message: expect.stringMatching(new RegExp(`${fixture.gitlinkPath}.*${fixture.authorModuleSha}`, "u")),
      },
    })
  })
})

describe("rebuildCandidateByMerge — the 23167 specimen (empty candidate)", () => {
  it("6. a rebuild whose tree is identical to the new base settles empty, not a bare refusal", async () => {
    const fixture = await emptyCandidateFixture()
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.mainTip },
      {
        id: "PR2",
        branch: fixture.secondBranch,
        headSha: fixture.secondTip,
      },
    )

    const delta = await exactDelta(git, fixture.repo, fixture.mainTip, result.sha)
    expect(delta.entries).toEqual([])
    expect(result.unchanged).toBe(true)
  })
})

describe("rebuildCandidateByMerge — the shaset fill-in", () => {
  it("7. the shaset commit's parent is the merge commit, and its tree differs by exactly the filled gitlink path", async () => {
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const parent = await git.run(fixture.superRepo, ["rev-parse", `${result.sha}^`])
    const mergeParents = await git.run(fixture.superRepo, ["rev-list", "--parents", "-n1", parent])
    const [, ...mergeParentShas] = mergeParents.split(/\s+/u)
    expect(mergeParentShas).toEqual([fixture.targetSha, fixture.authorTip])

    const delta = await exactDelta(git, fixture.superRepo, parent, result.sha)
    expect(delta.entries.map((entry) => entry.path)).toEqual([fixture.gitlinkPath])
  })
})

describe("rebuildCandidateByMerge — merge parents", () => {
  it("8. records exactly [base tip, authored tip] as the merge commit's parents, in that order", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const parents = await git.run(fixture.repo, ["rev-list", "--parents", "-n1", result.sha])
    const [, ...parentShas] = parents.split(/\s+/u)
    expect(parentShas).toEqual([fixture.baseTwo, fixture.authorTip])
  })
})

describe("rebuildCandidateByMerge — witnesses still run (proves the ONE code path)", () => {
  /**
   * The criss-cross specimen `command.test.ts` uses to prove
   * `unauthoredDeletionFailure` on the first-candidate path (search that file
   * for "unauthored-path-deletion"): two sibling lines off one base, merged
   * into the queue base in one order (so the base keeps both), and merged into
   * the "carrier" tip in the OTHER order with a hand-resolution that drops one
   * file — with more than one merge-base between them, so `ort`'s virtual base
   * erases the drop silently. Rebuilt here through `rebuildCandidateByMerge`
   * instead of `gitCandidatePreparer`, to prove the SAME witness fires on the
   * rebuild path — not a parallel implementation that happens to agree today.
   */
  async function criscrossUnauthoredDeletionFixture(): Promise<{
    repo: string
    root: string
    queueBaseHead: string
    carrierBranch: string
    carrierHead: string
  }> {
    const root = await (async () => {
      const { mkdtemp } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      return mkdtemp(join(tmpdir(), "yrd-rebuild-unauthored-deletion-"))
    })()
    const { join } = await import("node:path")
    const repo = join(root, "repo")
    await git.run(root, ["init", "-q", "-b", "main", "repo"])
    await git.run(repo, ["config", "user.name", "Yrd Test"])
    await git.run(repo, ["config", "user.email", "yrd@example.invalid"])
    await Bun.write(`${repo}/README.md`, "main\n")
    await git.run(repo, ["add", "README.md"])
    await git.run(repo, ["commit", "-qm", "main"])
    const originalBase = await git.run(repo, ["rev-parse", "main"])

    await git.run(repo, ["switch", "-qc", "issue/sibling", originalBase])
    await Bun.write(`${repo}/sibling.txt`, "sibling\n")
    await git.run(repo, ["add", "sibling.txt"])
    await git.run(repo, ["commit", "-qm", "sibling work"])
    const siblingSha = await git.run(repo, ["rev-parse", "HEAD"])

    await git.run(repo, ["switch", "-qc", "issue/mint", originalBase])
    await Bun.write(`${repo}/merged-mint.md`, "mint\n")
    await git.run(repo, ["add", "merged-mint.md"])
    await git.run(repo, ["commit", "-qm", "merge the mint"])
    const mintSha = await git.run(repo, ["rev-parse", "HEAD"])

    // The queue base absorbs both, so the mint is merged work main carries.
    await git.run(repo, ["switch", "-q", "main"])
    await git.run(repo, ["merge", "-q", "--no-ff", siblingSha, "-m", "merge sibling work"])
    await git.run(repo, ["merge", "-q", "--no-ff", mintSha, "-m", "merge the mint"])
    const queueBaseHead = await git.run(repo, ["rev-parse", "HEAD"])

    // The author's branch absorbs the same two lines in the OTHER order and
    // resolves by dropping the mint file, then continues linearly.
    const carrierBranch = "issue/mint"
    await git.run(repo, ["switch", "-q", carrierBranch])
    await git.run(repo, ["merge", "--no-ff", "--no-commit", siblingSha])
    await git.run(repo, ["rm", "-q", "merged-mint.md"])
    await git.run(repo, ["commit", "-qm", "recomposed tree drops the mint"])
    await Bun.write(`${repo}/carrier.txt`, "carrier payload\n")
    await git.run(repo, ["add", "carrier.txt"])
    await git.run(repo, ["commit", "-qm", "carrier payload"])
    const carrierHead = await git.run(repo, ["rev-parse", "HEAD"])

    // The facts that make this the residual case (more than one merge base),
    // not any earlier guard: `git.run` throws on a non-zero exit, so the
    // ancestry call is itself the assertion that containment holds.
    await git.run(repo, ["merge-base", "--is-ancestor", mintSha, carrierHead])
    expect(await git.run(repo, ["merge-base", "--all", queueBaseHead, carrierHead])).toContain("\n")

    return { repo, root, queueBaseHead, carrierBranch, carrierHead }
  }

  it("9. refuses an unauthored deletion — the SAME refusal the first-candidate path proves, through the rebuild entry point", async () => {
    const fixture = await criscrossUnauthoredDeletionFixture()
    roots.push(fixture.root)

    await expect(
      rebuildCandidateByMerge(
        options(fixture.repo),
        { sha: fixture.queueBaseHead },
        {
          id: "PR1",
          branch: fixture.carrierBranch,
          headSha: fixture.carrierHead,
        },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "unauthored-path-deletion",
        message: expect.stringContaining("merged-mint.md"),
      },
    })
  })
})

describe("rebuildCandidateByMerge — idempotence (no revision is minted)", () => {
  it("10. is a pure computation: the same inputs produce the same candidate tree on repeat calls", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    const first = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )
    const second = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    expect(first.treeSha).toBe(second.treeSha)
    // A pure rebuild is a function of (base, authored tip) alone — nothing about
    // it depends on, or writes, a revision counter. There is no ChangeRev in
    // scope at this layer to assert against; that is the point.
  })
})

describe("rebuildCandidateByMerge — content conflict beside a gitlink conflict", () => {
  it("11. refuses merge-conflict naming the content conflict", async () => {
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true })
    roots.push(fixture.root)
    // Add a genuine content conflict ON TOP of the (independently resolvable)
    // gitlink conflict: both main and the author's branch also edit the same
    // line of an ordinary file. `git merge` reports both conflicts together;
    // the content one is what must surface, since it has no automatic fix.
    const contentPath = "shared.txt"
    await git.run(fixture.superRepo, ["switch", "-q", "main"])
    await Bun.write(`${fixture.superRepo}/${contentPath}`, "main line\n")
    await git.run(fixture.superRepo, ["add", "--", contentPath])
    await git.run(fixture.superRepo, ["commit", "-qm", "main: edit shared"])
    const mainTip = await git.run(fixture.superRepo, ["rev-parse", "HEAD"])

    await git.run(fixture.superRepo, ["switch", "-q", fixture.authorBranch])
    await Bun.write(`${fixture.superRepo}/${contentPath}`, "author line\n")
    await git.run(fixture.superRepo, ["add", "--", contentPath])
    await git.run(fixture.superRepo, ["commit", "-qm", "author: edit shared"])
    const authorTip = await git.run(fixture.superRepo, ["rev-parse", "HEAD"])

    await expect(
      rebuildCandidateByMerge(
        options(fixture.superRepo),
        { sha: mainTip },
        {
          id: "PR1",
          branch: fixture.authorBranch,
          headSha: authorTip,
        },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "merge-conflict",
        message: expect.stringContaining(contentPath),
      },
    })
  })
})
