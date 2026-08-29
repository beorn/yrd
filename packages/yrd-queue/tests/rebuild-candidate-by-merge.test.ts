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

/** A well-formed change identity: `I` + 40 hex, the shape `ChangeIdSchema` takes. */
const CHANGE_ID = `I${"a1b2c3d4".repeat(5)}`

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
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const parents = await git.text(fixture.repo, ["rev-list", "--parents", "-n1", result.sha])
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
        changeId: CHANGE_ID,
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
          changeId: CHANGE_ID,
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
          changeId: CHANGE_ID,
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
  /** Default true, matching every existing caller's assumption: main's own
   * "advance dependency" step ALSO moves the same gitlink path, producing the
   * genuine two-sided conflict `git merge` reports there. Set false for the
   * narrow-trigger fixture (test 12): main advances an unrelated path
   * instead, so the author's gitlink change is the only one at that path and
   * a plain merge resolves it — the shape that must NEVER reach the
   * pre-branch's fill-in machinery. */
  mainAlsoMovesGitlink?: boolean
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

  await git.text(root, ["init", "-q", "-b", "main", "module"])
  await git.text(moduleRepo, ["config", "user.name", "Yrd Test"])
  await git.text(moduleRepo, ["config", "user.email", "yrd@example.invalid"])
  await Bun.write(`${moduleRepo}/version.txt`, "base\n")
  await git.text(moduleRepo, ["add", "version.txt"])
  await git.text(moduleRepo, ["commit", "-qm", "module base"])

  await git.text(root, ["init", "-q", "-b", "main", "super"])
  await git.text(superRepo, ["config", "user.name", "Yrd Test"])
  await git.text(superRepo, ["config", "user.email", "yrd@example.invalid"])
  await git.text(superRepo, ["config", "protocol.file.allow", "always"])
  await git.text(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRepo, gitlinkPath])
  await git.text(superRepo, ["commit", "-qm", "add dependency"])
  const baseSuperSha = await git.text(superRepo, ["rev-parse", "HEAD"])

  const authorBranch = "task/author-gitlink"
  await git.text(superRepo, ["switch", "-qc", authorBranch, baseSuperSha])
  await git.text(moduleRepo, ["switch", "-qc", "side"])
  // A disjoint path from "main move" below, so publishing this to main (a
  // real --no-ff merge, not a fast-forward — the two submodule commits are
  // genuine siblings off the same base) resolves cleanly with no content
  // conflict of its own; only the SHA divergence matters to this fixture.
  await Bun.write(`${moduleRepo}/author.txt`, "author\n")
  await git.text(moduleRepo, ["add", "author.txt"])
  await git.text(moduleRepo, ["commit", "-qm", "author move"])
  const authorModuleSha = await git.text(moduleRepo, ["rev-parse", "HEAD"])
  await git.text(moduleRepo, ["switch", "-q", "main"])
  await git.text(join(superRepo, gitlinkPath), ["fetch", "-q", "origin"])
  await git.text(join(superRepo, gitlinkPath), ["checkout", "-q", authorModuleSha])
  await git.text(superRepo, ["add", "--", gitlinkPath])
  await git.text(superRepo, ["commit", "-qm", "author: advance dependency"])
  const authorTip = await git.text(superRepo, ["rev-parse", "HEAD"])

  await git.text(superRepo, ["switch", "-q", "main"])
  let targetSha: string
  if (options.mainAlsoMovesGitlink ?? true) {
    await Bun.write(`${moduleRepo}/main.txt`, "main\n")
    await git.text(moduleRepo, ["add", "main.txt"])
    await git.text(moduleRepo, ["commit", "-qm", "main move"])
    const mainModuleSha = await git.text(moduleRepo, ["rev-parse", "HEAD"])
    await git.text(join(superRepo, gitlinkPath), ["fetch", "-q", "origin"])
    await git.text(join(superRepo, gitlinkPath), ["checkout", "-q", mainModuleSha])
    await git.text(superRepo, ["add", "--", gitlinkPath])
    await git.text(superRepo, ["commit", "-qm", "main: advance dependency"])
    targetSha = await git.text(superRepo, ["rev-parse", "HEAD"])
  } else {
    // Genuine base divergence at a path disjoint from the gitlink: main moves
    // forward, but never touches `gitlinkPath`, so the author's own gitlink
    // change is the only one on that path — nothing for a merge to conflict
    // on there.
    await Bun.write(`${superRepo}/main-only.txt`, "main-only\n")
    await git.text(superRepo, ["add", "main-only.txt"])
    await git.text(superRepo, ["commit", "-qm", "main: unrelated advance"])
    targetSha = await git.text(superRepo, ["rev-parse", "HEAD"])
  }

  if (options.authorPublishedToMain) {
    await git.text(moduleRepo, ["merge", "-q", "--no-ff", "-m", "publish author's move", "side"])
  }

  return { root, superRepo, moduleRepo, gitlinkPath, targetSha, authorBranch, authorTip, authorModuleSha }
}

/**
 * The PR2164 shape (2026-08-28): the author's floor is an ANCESTOR of the submodule's
 * main tip, and the superproject's main ALREADY pins that tip — someone else's change
 * landed the same dependency bump first. Distinct from
 * {@link gitlinkConflictFixture}, where the two module commits are siblings and main's
 * tip is a merge of both, so the fill always has something left to write.
 */
async function landedAheadFixture(): Promise<{
  root: string
  superRepo: string
  moduleRepo: string
  gitlinkPath: string
  targetSha: string
  authorBranch: string
  authorTip: string
  authorModuleSha: string
  mainModuleSha: string
}> {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(tmpdir(), "yrd-rebuild-landed-ahead-"))
  const superRepo = join(root, "super")
  const moduleRepo = join(root, "module")
  const gitlinkPath = "dep"

  await git.text(root, ["init", "-q", "-b", "main", "module"])
  await git.text(moduleRepo, ["config", "user.name", "Yrd Test"])
  await git.text(moduleRepo, ["config", "user.email", "yrd@example.invalid"])
  await Bun.write(`${moduleRepo}/version.txt`, "base\n")
  await git.text(moduleRepo, ["add", "version.txt"])
  await git.text(moduleRepo, ["commit", "-qm", "module base"])

  await git.text(root, ["init", "-q", "-b", "main", "super"])
  await git.text(superRepo, ["config", "user.name", "Yrd Test"])
  await git.text(superRepo, ["config", "user.email", "yrd@example.invalid"])
  await git.text(superRepo, ["config", "protocol.file.allow", "always"])
  await git.text(superRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRepo, gitlinkPath])
  await git.text(superRepo, ["commit", "-qm", "add dependency"])
  const baseSuperSha = await git.text(superRepo, ["rev-parse", "HEAD"])

  // The author's move goes straight onto the submodule's main (published, so the
  // shaset fill-in's precondition holds), and main then moves PAST it.
  await Bun.write(`${moduleRepo}/author.txt`, "author\n")
  await git.text(moduleRepo, ["add", "author.txt"])
  await git.text(moduleRepo, ["commit", "-qm", "author move"])
  const authorModuleSha = await git.text(moduleRepo, ["rev-parse", "HEAD"])
  await Bun.write(`${moduleRepo}/later.txt`, "later\n")
  await git.text(moduleRepo, ["add", "later.txt"])
  await git.text(moduleRepo, ["commit", "-qm", "main moves past the floor"])
  const mainModuleSha = await git.text(moduleRepo, ["rev-parse", "HEAD"])

  const authorBranch = "task/author-gitlink"
  await git.text(superRepo, ["switch", "-qc", authorBranch, baseSuperSha])
  await git.text(join(superRepo, gitlinkPath), ["fetch", "-q", "origin"])
  await git.text(join(superRepo, gitlinkPath), ["checkout", "-q", authorModuleSha])
  await git.text(superRepo, ["add", "--", gitlinkPath])
  await git.text(superRepo, ["commit", "-qm", "author: advance dependency to the floor"])
  const authorTip = await git.text(superRepo, ["rev-parse", "HEAD"])

  // Main lands the SAME dependency ahead of the author, at the submodule's tip.
  await git.text(superRepo, ["switch", "-q", "main"])
  await git.text(join(superRepo, gitlinkPath), ["checkout", "-q", mainModuleSha])
  await git.text(superRepo, ["add", "--", gitlinkPath])
  await git.text(superRepo, ["commit", "-qm", "main: an earlier change already bumped the dependency"])
  const targetSha = await git.text(superRepo, ["rev-parse", "HEAD"])

  return {
    root,
    superRepo,
    moduleRepo,
    gitlinkPath,
    targetSha,
    authorBranch,
    authorTip,
    authorModuleSha,
    mainModuleSha,
  }
}

describe("rebuildCandidateByMerge — the base already landed the fill's own target", () => {
  /**
   * The live PR2164 wedge (2026-08-28, `needs-person` for five hours on
   * "generated wrapper paths differ: expected [km], got []"). Two mechanisms in this
   * file's own path disagreed: the gitlink conflict resolves to the BASE's value, and
   * the base already carries the submodule's main tip — which is exactly what the fill
   * then asks the shaset writer to set. `update-index` had nothing to change, the staged
   * set came back empty, and the writer's completeness proof read a no-op as a mismatch.
   */
  it("composes when the base-side conflict resolution already reached the filled value", async () => {
    const fixture = await landedAheadFixture()
    roots.push(fixture.root)

    // The fixture's own preconditions, checked with plain git so the test does not
    // depend on the internals it exercises: the author's floor is a strict ancestor of
    // the submodule's main tip, and the target already pins that tip.
    await git.text(fixture.moduleRepo, ["merge-base", "--is-ancestor", fixture.authorModuleSha, fixture.mainModuleSha])
    expect(await git.text(fixture.superRepo, ["rev-parse", `${fixture.targetSha}:${fixture.gitlinkPath}`])).toBe(
      fixture.mainModuleSha,
    )
    expect(await git.text(fixture.superRepo, ["rev-parse", `${fixture.authorTip}:${fixture.gitlinkPath}`])).toBe(
      fixture.authorModuleSha,
    )

    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      {
        id: "PR1",
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    // The candidate carries the submodule's main tip, and the authored tip is still its
    // second parent — the rebuild neither refused nor rewrote the author's work.
    expect(await git.text(fixture.superRepo, ["rev-parse", `${result.sha}:${fixture.gitlinkPath}`])).toBe(
      fixture.mainModuleSha,
    )
    expect(await git.text(fixture.superRepo, ["rev-parse", `${result.sha}^2`])).toBe(fixture.authorTip)
  })
})

describe("rebuildCandidateByMerge — both sides moved the same gitlink", () => {
  it("4. author's submodule commit IS published to the submodule's main: the gitlink fills from main, no refusal", async () => {
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      {
        id: "PR1",
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const filled = await git.text(fixture.superRepo, ["rev-parse", `${result.sha}:${fixture.gitlinkPath}`])
    const submoduleMain = await git.text(fixture.moduleRepo, ["rev-parse", "main"])
    expect(filled).toBe(submoduleMain)
    // The fill is main's newest commit, which contains the author's move.
    await git.text(fixture.moduleRepo, ["merge-base", "--is-ancestor", fixture.authorModuleSha, submoduleMain])
  })

  it("4b. the pre-branch routes around resolveCandidateSubmoduleConflict entirely — proven by construction, not by luck", async () => {
    // This exact fixture (both sides move the same gitlink, author's move
    // published to main) is the ORIGINAL bug repro: before the pre-branch
    // rework, this call threw
    //   ZodError: Unrecognized keys: "origin", "baseSha", "currentSha", "incomingSha", "message"
    // from resolveCandidateSubmoduleConflict's "composed" branch — which
    // completes every git operation, including the merge commit, and crashes
    // ONLY on its own output's schema validation on the way out. That crash is
    // unconditional once the branch runs: there is no code path through it
    // that both composes a gitlink AND avoids the schema parse. So a clean
    // result here is not "it happened not to crash this time" — it is proof
    // the branch was never entered, which the source confirms independently:
    // `rebuildCandidateByMerge`'s pre-branch returns from
    // `rebuildGitlinkConflictByTakingBase` before `prepareCandidateMembers` —
    // the only caller of `resolveCandidateSubmoduleConflict` in this file — is
    // ever invoked, whenever `authoredGitlinkPaths` is non-empty.
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true })
    roots.push(fixture.root)

    // Independent, external confirmation that the pre-branch's OWN condition
    // is true for this fixture — checked with plain git, not by calling the
    // internal `authoredGitlinkPaths` this test cannot import: the author's
    // tip records a DIFFERENT gitlink value than its own merge-base against
    // the target, which is exactly "this change authors the gitlink path".
    const mergeBase = await git.text(fixture.superRepo, ["merge-base", fixture.targetSha, fixture.authorTip])
    const baseGitlink = await git.text(fixture.superRepo, ["rev-parse", `${mergeBase}:${fixture.gitlinkPath}`])
    const authoredGitlink = await git.text(fixture.superRepo, [
      "rev-parse",
      `${fixture.authorTip}:${fixture.gitlinkPath}`,
    ])
    expect(authoredGitlink).not.toBe(baseGitlink)

    // The call that would have thrown the ZodError above, pre-rework.
    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      { id: "PR1", changeId: CHANGE_ID, branch: fixture.authorBranch, headSha: fixture.authorTip },
    )
    expect(result.sha).toBeTruthy()
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
          changeId: CHANGE_ID,
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

  it("12. genuine base divergence on an unrelated path with a non-conflicting authored gitlink never trips the pre-branch's conflict path", async () => {
    // Task C, "narrow-trigger dedicated test": the pre-branch (01a2c79e) is
    // scoped to fire its OWN conflict-resolution machinery
    // (`rebuildGitlinkConflictByTakingBase`) ONLY on an actual gitlink-mode
    // merge CONFLICT — a first cut that read "does this change author a
    // gitlink at all" as the trigger hijacked every clean, single-sided
    // gitlink advance too (command.test.ts:9195's queue-driven
    // submodule-promotion suite proved it, per command.ts's own account of
    // that regression). Tests 4/4b/5 above all use `gitlinkConflictFixture`'s
    // DEFAULT shape, where BOTH sides move the SAME gitlink — a genuine
    // conflict, exactly what SHOULD trigger it. This fixture is the other
    // half: main advances (`mainAlsoMovesGitlink: false`, an unrelated path)
    // so there is a real base divergence to merge across, but only the
    // author's branch ever touches the gitlink — nothing for `git merge` to
    // conflict on there, so the trial merge inside the pre-branch's own guard
    // (command.ts, `if (trial.code !== 0)`) succeeds and takes the "clean
    // merge" branch, never calling `rebuildGitlinkConflictByTakingBase`.
    //
    // Verified directly (temporary instrumentation, not left in): this
    // fixture's gitlink is still an AUTHORED path (its value differs from
    // the merge-base's), so it is unconditionally filled from the
    // submodule's CURRENT main by `prepareCandidateMembers`'s own native
    // authored-gitlink handling (command.ts, step (b): "an authored gitlink
    // is a min commit, a floor... the queue writes the shaset commit that
    // fills each value in from that submodule's main") — the SAME fill this
    // fixture's `authorPublishedToMain: true` step makes available, whether
    // or not the pre-branch ever ran. That fill is not this test's target;
    // it is what tests 4/4b already prove for the CONFLICTING case. This
    // test's own claim is narrower and still new: a genuine root-level base
    // divergence on a path disjoint from the gitlink does not perturb that
    // fill, and the candidate is produced successfully rather than
    // mis-detected as a conflict it is not.
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true, mainAlsoMovesGitlink: false })
    roots.push(fixture.root)
    const publishedMain = await git.text(fixture.moduleRepo, ["rev-parse", "main"])
    expect(publishedMain).not.toBe(fixture.authorModuleSha) // the --no-ff publish minted a new tip

    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      { id: "PR1", changeId: CHANGE_ID, branch: fixture.authorBranch, headSha: fixture.authorTip },
    )

    // Filled from the submodule's current main (published, a descendant of
    // the author's own commit) — the correct, by-design outcome, not the
    // author's literal value carried through untouched.
    expect(await git.text(fixture.superRepo, ["rev-parse", `${result.sha}:${fixture.gitlinkPath}`])).toBe(publishedMain)
    // The base's own divergent, gitlink-disjoint content survived the merge
    // untouched, proving the real base move was actually merged across, not
    // silently dropped or shortcut around.
    expect(await git.text(fixture.superRepo, ["rev-parse", `${result.sha}:main-only.txt`])).toBeTruthy()
    // `result.sha` is the shaset wrapper (test 7 establishes this shape for
    // the conflicting case; it holds here too, since this fill also touches
    // an authored gitlink) — a single-parent commit whose parent is the
    // merge itself. The merge commit one level up is where [target, authored
    // tip] actually lives; unwrap one level to check it, same as test 7.
    const wrapperParents = await git.text(fixture.superRepo, ["rev-list", "--parents", "-n1", result.sha])
    const [wrapperSha, mergeSha, ...extra] = wrapperParents.split(/\s+/u)
    expect(wrapperSha).toBe(result.sha)
    expect(extra).toEqual([])
    const mergeParents = await git.text(fixture.superRepo, ["rev-list", "--parents", "-n1", mergeSha!])
    const [, ...mergeParentShas] = mergeParents.split(/\s+/u)
    expect(mergeParentShas).toEqual([fixture.targetSha, fixture.authorTip])
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
        changeId: CHANGE_ID,
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
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const parent = await git.text(fixture.superRepo, ["rev-parse", `${result.sha}^`])
    const mergeParents = await git.text(fixture.superRepo, ["rev-list", "--parents", "-n1", parent])
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
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    const parents = await git.text(fixture.repo, ["rev-list", "--parents", "-n1", result.sha])
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
    await git.text(root, ["init", "-q", "-b", "main", "repo"])
    await git.text(repo, ["config", "user.name", "Yrd Test"])
    await git.text(repo, ["config", "user.email", "yrd@example.invalid"])
    await Bun.write(`${repo}/README.md`, "main\n")
    await git.text(repo, ["add", "README.md"])
    await git.text(repo, ["commit", "-qm", "main"])
    const originalBase = await git.text(repo, ["rev-parse", "main"])

    await git.text(repo, ["switch", "-qc", "issue/sibling", originalBase])
    await Bun.write(`${repo}/sibling.txt`, "sibling\n")
    await git.text(repo, ["add", "sibling.txt"])
    await git.text(repo, ["commit", "-qm", "sibling work"])
    const siblingSha = await git.text(repo, ["rev-parse", "HEAD"])

    await git.text(repo, ["switch", "-qc", "issue/mint", originalBase])
    await Bun.write(`${repo}/merged-mint.md`, "mint\n")
    await git.text(repo, ["add", "merged-mint.md"])
    await git.text(repo, ["commit", "-qm", "merge the mint"])
    const mintSha = await git.text(repo, ["rev-parse", "HEAD"])

    // The queue base absorbs both, so the mint is merged work main carries.
    await git.text(repo, ["switch", "-q", "main"])
    await git.text(repo, ["merge", "-q", "--no-ff", siblingSha, "-m", "merge sibling work"])
    await git.text(repo, ["merge", "-q", "--no-ff", mintSha, "-m", "merge the mint"])
    const queueBaseHead = await git.text(repo, ["rev-parse", "HEAD"])

    // The author's branch absorbs the same two lines in the OTHER order and
    // resolves by dropping the mint file, then continues linearly.
    const carrierBranch = "issue/mint"
    await git.text(repo, ["switch", "-q", carrierBranch])
    await git.text(repo, ["merge", "--no-ff", "--no-commit", siblingSha])
    await git.text(repo, ["rm", "-q", "merged-mint.md"])
    await git.text(repo, ["commit", "-qm", "recomposed tree drops the mint"])
    await Bun.write(`${repo}/carrier.txt`, "carrier payload\n")
    await git.text(repo, ["add", "carrier.txt"])
    await git.text(repo, ["commit", "-qm", "carrier payload"])
    const carrierHead = await git.text(repo, ["rev-parse", "HEAD"])

    // The facts that make this the residual case (more than one merge base),
    // not any earlier guard: `git.run` throws on a non-zero exit, so the
    // ancestry call is itself the assertion that containment holds.
    await git.text(repo, ["merge-base", "--is-ancestor", mintSha, carrierHead])
    expect(await git.text(repo, ["merge-base", "--all", queueBaseHead, carrierHead])).toContain("\n")

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
          changeId: CHANGE_ID,
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
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )
    const second = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        changeId: CHANGE_ID,
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
    await git.text(fixture.superRepo, ["switch", "-q", "main"])
    await Bun.write(`${fixture.superRepo}/${contentPath}`, "main line\n")
    await git.text(fixture.superRepo, ["add", "--", contentPath])
    await git.text(fixture.superRepo, ["commit", "-qm", "main: edit shared"])
    const mainTip = await git.text(fixture.superRepo, ["rev-parse", "HEAD"])

    await git.text(fixture.superRepo, ["switch", "-q", fixture.authorBranch])
    await Bun.write(`${fixture.superRepo}/${contentPath}`, "author line\n")
    await git.text(fixture.superRepo, ["add", "--", contentPath])
    await git.text(fixture.superRepo, ["commit", "-qm", "author: edit shared"])
    const authorTip = await git.text(fixture.superRepo, ["rev-parse", "HEAD"])

    await expect(
      rebuildCandidateByMerge(
        options(fixture.superRepo),
        { sha: mainTip },
        {
          id: "PR1",
          changeId: CHANGE_ID,
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

/**
 * The identity half. A rebuild writes queue-owned commits — the merge and, when
 * a gitlink fills, the shaset wrapper on top of it — and every one of them must
 * carry the change's `Change-Id`, because Change-Id ancestry IS how merged truth
 * is derived (`merged-truth.ts`). Measured 2026-08-28 on the superproject: 61
 * post-epoch `yrd: (compose|merge) … revision 1` commits carry no trailer at all
 * and 27 of them are reachable from `origin/main` — every one written through
 * THIS function, whose synthesized snapshot never had a `changeId` to stamp.
 */
describe("rebuildCandidateByMerge — the change's identity trailer", () => {
  it("12. stamps the merge commit with exactly one Change-Id and one Merge-Change-Id", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseTwo },
      {
        id: "PR1",
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    // `%(trailers:key=…,valueonly)` emits ONE line per matching trailer, so a
    // duplicate stamp shows up as a second line rather than a changed value.
    expect(
      await git.text(fixture.repo, ["show", "-s", "--format=%(trailers:key=Change-Id,valueonly)", result.sha]),
    ).toBe(CHANGE_ID)
    expect(
      await git.text(fixture.repo, ["show", "-s", "--format=%(trailers:key=Merge-Change-Id,valueonly)", result.sha]),
    ).toBe(`${CHANGE_ID}-merge`)
  })

  it("13. stamps the shaset wrapper it synthesizes on top of that merge, marked compose", async () => {
    const fixture = await gitlinkConflictFixture({ authorPublishedToMain: true })
    roots.push(fixture.root)

    const result = await rebuildCandidateByMerge(
      options(fixture.superRepo),
      { sha: fixture.targetSha },
      {
        id: "PR1",
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    expect(
      await git.text(fixture.superRepo, ["show", "-s", "--format=%(trailers:key=Change-Id,valueonly)", result.sha]),
    ).toBe(CHANGE_ID)
    expect(
      await git.text(fixture.superRepo, [
        "show",
        "-s",
        "--format=%(trailers:key=Merge-Change-Id,valueonly)",
        result.sha,
      ]),
    ).toBe(`${CHANGE_ID}-compose`)
    // The merge underneath it carries the same identity, marked as the merge.
    const parent = await git.text(fixture.superRepo, ["rev-parse", `${result.sha}^`])
    expect(
      await git.text(fixture.superRepo, ["show", "-s", "--format=%(trailers:key=Merge-Change-Id,valueonly)", parent]),
    ).toBe(`${CHANGE_ID}-merge`)
  })

  it("14. a fast-forward rebuild returns the authored tip untouched — nothing to stamp", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)

    // Base already an ancestor of the authored tip: the pre-branch returns the
    // author's own commit, which the queue never rewrites and must not stamp.
    const result = await rebuildCandidateByMerge(
      options(fixture.repo),
      { sha: fixture.baseOne },
      {
        id: "PR1",
        changeId: CHANGE_ID,
        branch: fixture.authorBranch,
        headSha: fixture.authorTip,
      },
    )

    expect(result.sha).toBe(fixture.authorTip)
    expect(
      await git.text(fixture.repo, ["show", "-s", "--format=%(trailers:key=Change-Id,valueonly)", result.sha]),
    ).toBe("")
  })
})
