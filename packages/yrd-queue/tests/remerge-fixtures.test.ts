/**
 * @failure A Phase 1 fixture silently stops exhibiting the property it exists for — the
 *          moved base stops moving, the gitlink fixture stops diverging, or the 23167
 *          specimen stops producing an empty rebuild — and every test built on it
 *          proves nothing.
 * @level l1
 * @consumer the re-merge refactor's Phase 1 tests (moved base, both-sides-moved
 *           gitlink, empty-candidate refusal)
 *
 * Each builder's advertised property is proven MECHANICALLY here, against git,
 * so the fixtures stay trustworthy for the phase that consumes them. The 23167
 * case is where the two Phase 1 prep deliverables meet: the fixture constructs
 * the history, `exactDelta` proves the rebuilt candidate is empty.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { exactDelta } from "../src/content-identity.ts"
import {
  bothSidesMovedGitlinkFixture,
  emptyCandidateFixture,
  fixtureRefGit,
  movedBaseFixture,
} from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("movedBaseFixture", () => {
  it("builds a base that really moved, with the author's change parented on the old base", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    expect(fixture.baseTwo).not.toBe(fixture.baseOne)
    await git.text(fixture.repo, ["merge-base", "--is-ancestor", fixture.baseOne, fixture.baseTwo])
    expect(await git.text(fixture.repo, ["rev-parse", `${fixture.authorTip}^`])).toBe(fixture.baseOne)
  })

  it("disjoint-paths: main's move and the author's change touch no common path", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    const mainDelta = await exactDelta(git, fixture.repo, fixture.baseOne, fixture.baseTwo)
    const authorDelta = await exactDelta(git, fixture.repo, fixture.baseOne, fixture.authorTip)

    expect(mainDelta.entries.map((entry) => entry.path)).toEqual([...fixture.mainPaths])
    expect(authorDelta.entries.map((entry) => entry.path)).toEqual([fixture.authorPath])
    expect(fixture.mainPaths).not.toContain(fixture.authorPath)
  })

  it("overlapping-path-mergeable: same path on both sides, and a re-merge still resolves", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "overlapping-path-mergeable" })
    roots.push(fixture.root)

    expect(fixture.mainPaths).toContain(fixture.authorPath)
    const merge = await git.exec(fixture.repo, ["merge-tree", "--write-tree", fixture.baseTwo, fixture.authorTip])
    expect(merge.code).toBe(0)
    const mergedTree = merge.stdout.split("\n")[0]
    if (mergedTree === undefined || mergedTree === "") throw new Error("merge-tree reported no tree id")
    // The merged result carries BOTH edits: it differs from the moved base by
    // exactly the shared path.
    const delta = await exactDelta(git, fixture.repo, fixture.baseTwo, mergedTree)
    expect(delta.entries.map((entry) => [entry.kind, entry.path])).toEqual([["modified", fixture.authorPath]])
  })

  it("overlapping-path-conflicting: same region on both sides, and a re-merge conflicts", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "overlapping-path-conflicting" })
    roots.push(fixture.root)

    expect(fixture.mainPaths).toContain(fixture.authorPath)
    const merge = await git.exec(fixture.repo, ["merge-tree", "--write-tree", fixture.baseTwo, fixture.authorTip])
    expect(merge.code).toBe(1)
    expect(merge.stdout).toContain(fixture.authorPath)
  })
})

describe("bothSidesMovedGitlinkFixture", () => {
  it("moves the SAME gitlink on both sides, to submodule commits that diverged from the base", async () => {
    const fixture = await bothSidesMovedGitlinkFixture()
    roots.push(fixture.root)

    expect(fixture.mainGitlink).not.toBe(fixture.authorGitlink)
    // Both targets descend from the recorded base commit, and neither side
    // contains the other — a genuine divergence, judged in the submodule's own
    // repository (the superproject object store cannot read these objects).
    await git.text(fixture.submoduleRepo, ["merge-base", "--is-ancestor", fixture.baseGitlink, fixture.mainGitlink])
    await git.text(fixture.submoduleRepo, ["merge-base", "--is-ancestor", fixture.baseGitlink, fixture.authorGitlink])
    const forward = await git.exec(fixture.submoduleRepo, [
      "merge-base",
      "--is-ancestor",
      fixture.mainGitlink,
      fixture.authorGitlink,
    ])
    const backward = await git.exec(fixture.submoduleRepo, [
      "merge-base",
      "--is-ancestor",
      fixture.authorGitlink,
      fixture.mainGitlink,
    ])
    expect(forward.code).not.toBe(0)
    expect(backward.code).not.toBe(0)

    const mainDelta = await exactDelta(git, fixture.superRepo, fixture.baseSha, fixture.mainTip)
    const authorDelta = await exactDelta(git, fixture.superRepo, fixture.baseSha, fixture.authorTip)
    expect(mainDelta.entries).toHaveLength(1)
    expect(mainDelta.entries[0]).toMatchObject({
      path: fixture.gitlinkPath,
      kind: "modified",
      object: "gitlink",
      candidateOid: fixture.mainGitlink,
    })
    expect(authorDelta.entries).toHaveLength(1)
    expect(authorDelta.entries[0]).toMatchObject({
      path: fixture.gitlinkPath,
      kind: "modified",
      object: "gitlink",
      candidateOid: fixture.authorGitlink,
    })
  })

  it("cannot be auto-merged: both sides moved the gitlink, so the re-merge conflicts", async () => {
    const fixture = await bothSidesMovedGitlinkFixture()
    roots.push(fixture.root)

    const merge = await git.exec(fixture.superRepo, ["merge-tree", "--write-tree", fixture.mainTip, fixture.authorTip])
    expect(merge.code).toBe(1)
    expect(merge.stdout).toContain(fixture.gitlinkPath)
  })
})

describe("emptyCandidateFixture (the 23167 specimen)", () => {
  it("gives the second sibling a real delta against the ORIGINAL base", async () => {
    const fixture = await emptyCandidateFixture()
    roots.push(fixture.root)

    const delta = await exactDelta(git, fixture.repo, fixture.base, fixture.secondTip)

    expect(delta.entries.map((entry) => [entry.kind, entry.path])).toEqual([["modified", fixture.path]])
  })

  it("rebuilding the second sibling against the merged first yields an EMPTY candidate", async () => {
    const fixture = await emptyCandidateFixture()
    roots.push(fixture.root)

    // Commit-graph reasoning still claims unique work: the revert and the
    // restore are unique patches, so `git cherry` reports them as '+' rows.
    const cherry = await git.text(fixture.repo, ["cherry", fixture.mainTip, fixture.secondTip])
    const unique = cherry.split("\n").filter((line) => line.startsWith("+"))
    expect(unique.length).toBeGreaterThan(0)

    // The tree truth disagrees. Rebuild the second sibling against the new
    // base the way the re-merge path does — a merged result tree — and the
    // candidate's delta against that base is EMPTY: the refusal condition.
    const rebuilt = await git.text(fixture.repo, ["merge-tree", "--write-tree", fixture.mainTip, fixture.secondTip])
    const candidateTree = rebuilt.split("\n")[0]
    if (candidateTree === undefined || candidateTree === "") throw new Error("merge-tree reported no tree id")

    const delta = await exactDelta(git, fixture.repo, fixture.mainTip, candidateTree)

    expect(delta.entries).toEqual([])
    expect(delta.baseTree).toBe(delta.candidateTree)
    expect(delta.baseTree).toBe(await git.text(fixture.repo, ["rev-parse", `${fixture.mainTip}^{tree}`]))
  })
})
