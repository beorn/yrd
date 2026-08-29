/**
 * @failure A merged change whose synthesis commit dropped its Change-Id trailer reads as a
 *          silent not-merged, a second-parent-only trailer leaks into the first-parent index,
 *          or the store-parity harness folds an unanswerable window into "agree" — the exact
 *          failure classes that make derived truth unusable as the store's replacement.
 * @level l1
 * @consumer item-4 S3: `merged` derived from ancestry + the Change-Id lookup (plan.md R4);
 *           the store-deletion doors S4–S7 prove parity through `compareMergedTruth`.
 *
 * Every case runs over a real repository: merged truth is a read of git's own
 * history facts, so the fixtures are genuine first-parent lines with genuine
 * trailers, built the way the queue builds them (`git merge --no-ff` with the
 * two-trailer synthesis message), not canned strings.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildMergedTruthIndex,
  compareMergedTruth,
  mergedByAncestry,
  mergedByChangeId,
  mergedTruth,
  type MergedTruthIndex,
  type StoreMergedClaim,
  type TrailerAbsentException,
} from "../src/merged-truth.ts"
import { fixtureRefGit } from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const ID_A = `Ia${"0".repeat(39)}`
const ID_B = `Ib${"0".repeat(39)}`
const ID_C = `Ic${"0".repeat(39)}`
const ID_D = `Id${"0".repeat(39)}`
/** Lives only on an authored-subtree commit — must never reach the index. */
const ID_X = `Ie${"0".repeat(39)}`

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-merged-truth-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git.text(root, ["init", "-b", "main", "repo"])
  await Bun.write(join(repo, "base.txt"), "base\n")
  await git.text(repo, ["add", "--", "base.txt"])
  await git.text(repo, ["commit", "-m", "chore: base"])
  return repo
}

async function commitFile(repo: string, path: string, content: string, messages: readonly string[]): Promise<string> {
  await Bun.write(join(repo, path), content)
  await git.text(repo, ["add", "--", path])
  await git.text(repo, ["commit", ...messages.flatMap((message) => ["-m", message])])
  return git.text(repo, ["rev-parse", "HEAD"])
}

function synthesisTrailers(changeId: string, operation: "merge" | "compose"): string {
  return `Change-Id: ${changeId}\nMerge-Change-Id: ${changeId}-${operation}`
}

/** Author a change on its own branch and queue-merge it into main the way the
 * queue does: `merge --no-ff` with the synthesis subject and, unless dropped,
 * the two lineage trailers. Returns both sides of the merge. */
async function queueMerge(
  repo: string,
  options: Readonly<{
    branch: string
    file: string
    member: string
    revision: number
    changeId?: string
    subject?: string
  }>,
): Promise<Readonly<{ authoredTip: string; mergeCommit: string }>> {
  await git.text(repo, ["checkout", "-q", "-b", options.branch])
  const authoredTip = await commitFile(repo, options.file, `${options.file}\n`, [`feat: ${options.file}`])
  await git.text(repo, ["checkout", "-q", "main"])
  const subject = options.subject ?? `yrd: merge ${options.member} revision ${String(options.revision)}`
  const messages = options.changeId === undefined ? [subject] : [subject, synthesisTrailers(options.changeId, "merge")]
  await git.text(repo, ["merge", "--no-ff", ...messages.flatMap((message) => ["-m", message]), options.branch])
  const mergeCommit = await git.text(repo, ["rev-parse", "HEAD"])
  return { authoredTip, mergeCommit }
}

type Fixture = Readonly<{
  repo: string
  tipA: string
  mergeA: string
  tipB: string
  mergeB: string
  tipC: string
  composeD: string
  mergeD: string
  index: MergedTruthIndex
}>

/**
 * The acceptance fixture: change A merged with trailers, change B merged by a
 * trailer-DROPPED queue merge (the trailer-drop specimen), change C authored
 * and never merged, change D merged as a compose+merge pair (one Change-Id on
 * two first-parent commits, the live PR2047 shape). The authored tip of A
 * itself carries a foreign Change-Id trailer to pin the first-parent walk.
 */
async function acceptanceFixture(): Promise<Fixture> {
  const repo = await makeRepo()

  await git.text(repo, ["checkout", "-q", "-b", "task/a"])
  const tipA = await commitFile(repo, "a.txt", "a\n", ["feat: a", `Change-Id: ${ID_X}`])
  await git.text(repo, ["checkout", "-q", "main"])
  await git.text(repo, [
    "merge",
    "--no-ff",
    "-m",
    "yrd: merge PR1 revision 1",
    "-m",
    synthesisTrailers(ID_A, "merge"),
    "task/a",
  ])
  const mergeA = await git.text(repo, ["rev-parse", "HEAD"])

  const merged = await queueMerge(repo, { branch: "task/b", file: "b.txt", member: "PR2", revision: 1 })

  await git.text(repo, ["checkout", "-q", "-b", "task/c"])
  const tipC = await commitFile(repo, "c.txt", "c\n", ["feat: c"])
  await git.text(repo, ["checkout", "-q", "main"])

  const mergedD = await queueMerge(repo, {
    branch: "task/d",
    file: "d.txt",
    member: "PR4",
    revision: 2,
    changeId: ID_D,
  })
  const composeD = await commitFile(repo, "d-wrapper.txt", "wrapper\n", [
    "yrd: compose PR4 revision 2",
    synthesisTrailers(ID_D, "compose"),
  ])

  const index = await buildMergedTruthIndex(git, repo, { tip: "main" })
  return {
    repo,
    tipA,
    mergeA,
    tipB: merged.authoredTip,
    mergeB: merged.mergeCommit,
    tipC,
    composeD,
    mergeD: mergedD.mergeCommit,
    index,
  }
}

describe("buildMergedTruthIndex", () => {
  it("indexes queue synthesis commits by trailer and reports the walk's denominator", async () => {
    const fixture = await acceptanceFixture()

    // First-parent line: composeD, mergeD, mergeB, mergeA, base — five commits.
    expect(fixture.index.commitsWalked).toBe(5)
    expect(fixture.index.tip).toBe(fixture.composeD)
    const occurrencesA = fixture.index.byChangeId.get(ID_A)
    expect(occurrencesA).toHaveLength(1)
    expect(occurrencesA?.[0]).toMatchObject({
      commit: fixture.mergeA,
      operation: "merge",
      member: "PR1",
      revision: 1,
      source: "change-id-trailer",
    })
  })

  it("keeps a compose+merge pair as two occurrences of one Change-Id, newest first", async () => {
    const fixture = await acceptanceFixture()

    const occurrences = fixture.index.byChangeId.get(ID_D)
    expect(occurrences?.map((occurrence) => [occurrence.commit, occurrence.operation])).toEqual([
      [fixture.composeD, "compose"],
      [fixture.mergeD, "merge"],
    ])
  })

  it("never indexes a trailer that lives only in an authored subtree — the walk is first-parent", async () => {
    const fixture = await acceptanceFixture()

    expect(fixture.index.byChangeId.get(ID_X)).toBeUndefined()
  })

  it("maps each merge's exact second parent to its first-parent merge commit", async () => {
    const fixture = await acceptanceFixture()

    expect(fixture.index.mergeBySecondParent.get(fixture.tipA)).toBe(fixture.mergeA)
    expect(fixture.index.mergeBySecondParent.get(fixture.tipB)).toBe(fixture.mergeB)
    expect(fixture.index.mergeBySecondParent.get(fixture.tipC)).toBeUndefined()
  })

  it("surfaces a trailer-dropped queue merge as a specimen naming the commit, subject and member", async () => {
    const fixture = await acceptanceFixture()

    expect(fixture.index.specimens).toHaveLength(1)
    expect(fixture.index.specimens[0]).toMatchObject({
      commit: fixture.mergeB,
      problem: "trailer-absent",
      subject: "yrd: merge PR2 revision 1",
      member: "PR2",
      operation: "merge",
    })
  })

  it("surfaces a hand merge (default git subject, no member) as a specimen too", async () => {
    const repo = await makeRepo()
    await git.text(repo, ["checkout", "-q", "-b", "task/e"])
    await commitFile(repo, "e.txt", "e\n", ["feat: e"])
    await git.text(repo, ["checkout", "-q", "main"])
    await git.text(repo, ["merge", "--no-ff", "-m", "Merge branch 'task/e'", "task/e"])

    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens).toHaveLength(1)
    expect(index.specimens[0]).toMatchObject({ problem: "trailer-absent", subject: "Merge branch 'task/e'" })
    expect(index.specimens[0]?.member).toBeUndefined()
  })

  it("treats an old-era queue-lane subject without a trailer as a specimen even with one parent", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "old.txt", "old\n", ["yrd: compose PR112"])

    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens).toHaveLength(1)
    expect(index.specimens[0]).toMatchObject({ problem: "trailer-absent", member: "PR112", operation: "compose" })
  })

  it("counts plain history without inventing specimens", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "doc.txt", "doc\n", ["docs: plain direct commit"])

    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.commitsWalked).toBe(2)
    expect(index.specimens).toEqual([])
    expect(index.byChangeId.size).toBe(0)
  })

  it("bounds the walk at `stop`, excluding everything at and below it", async () => {
    const fixture = await acceptanceFixture()

    const bounded = await buildMergedTruthIndex(git, fixture.repo, { tip: "main", stop: fixture.mergeA })

    expect(bounded.stop).toBe(fixture.mergeA)
    expect(bounded.commitsWalked).toBe(3)
    expect(bounded.byChangeId.get(ID_A)).toBeUndefined()
    expect(bounded.byChangeId.get(ID_D)).toHaveLength(2)
    expect(bounded.specimens.map((specimen) => specimen.commit)).toEqual([fixture.mergeB])
  })

  it("recovers the change id from a surviving Merge-Change-Id when Change-Id was dropped", async () => {
    const repo = await makeRepo()
    await git.text(repo, ["checkout", "-q", "-b", "task/f"])
    await commitFile(repo, "f.txt", "f\n", ["feat: f"])
    await git.text(repo, ["checkout", "-q", "main"])
    await git.text(repo, [
      "merge",
      "--no-ff",
      "-m",
      "yrd: merge PR6 revision 1",
      "-m",
      `Merge-Change-Id: ${ID_C}-merge`,
      "task/f",
    ])

    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens).toEqual([])
    expect(index.byChangeId.get(ID_C)?.[0]).toMatchObject({ source: "merge-change-id-trailer", member: "PR6" })
  })

  it("surfaces an unreadable Change-Id value as a trailer-malformed specimen", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "g.txt", "g\n", ["yrd: merge PR7 revision 1", "Change-Id: not-a-change-id"])

    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens).toHaveLength(1)
    expect(index.specimens[0]).toMatchObject({ problem: "trailer-malformed" })
    expect(index.specimens[0]?.detail).toContain("not-a-change-id")
    expect(index.byChangeId.size).toBe(0)
  })

  it("indexes a disagreeing trailer pair under its Change-Id AND surfaces the disagreement", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "h.txt", "h\n", [
      "yrd: merge PR8 revision 1",
      `Change-Id: ${ID_A}\nMerge-Change-Id: ${ID_B}-merge`,
    ])

    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.byChangeId.get(ID_A)).toHaveLength(1)
    expect(index.specimens).toHaveLength(1)
    expect(index.specimens[0]).toMatchObject({ problem: "trailer-malformed" })
    expect(index.specimens[0]?.detail).toContain(ID_B)
  })

  it("refuses an exception that contradicts a commit's own readable trailer", async () => {
    const fixture = await acceptanceFixture()
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeA, { disposition: "carries-change", changeId: ID_B }],
    ])

    await expect(buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })).rejects.toThrow(
      /contradicts the commit's own readable lineage/u,
    )
  })

  it("applies carries-change and carries-no-change exceptions, clearing the specimens they rule on", async () => {
    const fixture = await acceptanceFixture()
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeB, { disposition: "carries-change", changeId: ID_B, note: "recovered from the merge record" }],
    ])

    const repaired = await buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })

    expect(repaired.specimens).toEqual([])
    expect(repaired.exceptionsApplied).toBe(1)
    expect(repaired.byChangeId.get(ID_B)?.[0]).toMatchObject({ commit: fixture.mergeB, source: "exception" })

    const ruledOut = await buildMergedTruthIndex(git, fixture.repo, {
      tip: "main",
      exceptions: new Map([[fixture.mergeB, { disposition: "carries-no-change", note: "ruled: sync merge" }]]),
    })
    expect(ruledOut.specimens).toEqual([])
    expect(ruledOut.byChangeId.get(ID_B)).toBeUndefined()
  })

  it("refuses a truncated exception sha outright", async () => {
    const fixture = await acceptanceFixture()
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeB.slice(0, 12), { disposition: "carries-no-change", note: "truncated" }],
    ])

    await expect(buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })).rejects.toThrow()
  })
})

describe("mergedByChangeId", () => {
  it("answers merged with the occurrence evidence", async () => {
    const fixture = await acceptanceFixture()

    const answer = mergedByChangeId(fixture.index, ID_A)

    expect(answer.kind).toBe("merged")
    if (answer.kind === "merged") expect(answer.occurrences[0]?.commit).toBe(fixture.mergeA)
  })

  it("answers the LOUD unknown, naming the specimens, when a lookup misses in a specimen window", async () => {
    const fixture = await acceptanceFixture()

    const answer = mergedByChangeId(fixture.index, ID_C)

    expect(answer).toMatchObject({ kind: "unknown", reason: "trailer-absent" })
    if (answer.kind === "unknown") {
      expect(answer.specimens.map((specimen) => specimen.commit)).toEqual([fixture.mergeB])
    }
  })

  it("narrows the veto by member context: a specimen naming another member cannot be this change", async () => {
    const fixture = await acceptanceFixture()

    // The one specimen names PR2, so a PR3-scoped miss is a definitive not-merged…
    expect(mergedByChangeId(fixture.index, ID_C, { member: "PR3" })).toMatchObject({
      kind: "not-merged",
      commitsWalked: 5,
    })
    // …while a PR2-scoped miss stays unknown.
    expect(mergedByChangeId(fixture.index, ID_C, { member: "PR2" })).toMatchObject({ kind: "unknown" })
  })

  it("never lets member context filter a member-less hand merge out of the veto", async () => {
    const repo = await makeRepo()
    await git.text(repo, ["checkout", "-q", "-b", "task/e"])
    await commitFile(repo, "e.txt", "e\n", ["feat: e"])
    await git.text(repo, ["checkout", "-q", "main"])
    await git.text(repo, ["merge", "--no-ff", "-m", "Merge branch 'task/e'", "task/e"])
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(mergedByChangeId(index, ID_C, { member: "PR9" })).toMatchObject({ kind: "unknown" })
  })

  it("answers a definitive not-merged over a specimen-free window, with the denominator", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "doc.txt", "doc\n", ["docs: plain"])
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(mergedByChangeId(index, ID_A)).toEqual({ kind: "not-merged", changeId: ID_A, commitsWalked: 2 })
  })

  it("refuses a malformed change id loudly", async () => {
    const fixture = await acceptanceFixture()

    expect(() => mergedByChangeId(fixture.index, "bogus")).toThrow()
  })
})

describe("mergedByAncestry", () => {
  it("answers merged for a contained authored tip and names the integrating merge", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedByAncestry(git, fixture.index, fixture.tipA)

    expect(answer).toEqual({ kind: "merged", authoredTip: fixture.tipA, mergeCommit: fixture.mergeA })
  })

  it("answers merged for a trailer-dropped change when the caller knows the authored tip", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedByAncestry(git, fixture.index, fixture.tipB)

    expect(answer).toEqual({ kind: "merged", authoredTip: fixture.tipB, mergeCommit: fixture.mergeB })
  })

  it("answers not-merged for an authored tip main never merged", async () => {
    const fixture = await acceptanceFixture()

    expect(await mergedByAncestry(git, fixture.index, fixture.tipC)).toEqual({
      kind: "not-merged",
      authoredTip: fixture.tipC,
    })
  })

  it("answers not-merged for unrelated history and throws for an object the repository lacks", async () => {
    const fixture = await acceptanceFixture()
    await git.text(fixture.repo, ["checkout", "-q", "--orphan", "orphan"])
    await git.text(fixture.repo, ["commit", "--allow-empty", "-m", "orphan root"])
    const orphan = await git.text(fixture.repo, ["rev-parse", "HEAD"])
    await git.text(fixture.repo, ["checkout", "-q", "main"])

    expect(await mergedByAncestry(git, fixture.index, orphan)).toMatchObject({ kind: "not-merged" })
    await expect(mergedByAncestry(git, fixture.index, "1".repeat(40))).rejects.toThrow()
  })
})

describe("mergedTruth (combined)", () => {
  it("lets ancestry decide first: a trailer-dropped change with a known tip is merged, not unknown", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedTruth(git, fixture.index, { changeId: ID_B, authoredTip: fixture.tipB })

    expect(answer).toMatchObject({ kind: "merged", via: "ancestry", mergeCommit: fixture.mergeB })
  })

  it("answers unknown for an unmerged change when a specimen could be its synthesis", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedTruth(git, fixture.index, { changeId: ID_C, authoredTip: fixture.tipC })

    expect(answer).toMatchObject({ kind: "unknown", reason: "trailer-absent", authoredTip: fixture.tipC })
  })

  it("answers a definitive not-merged for a tip-only query that misses on ancestry", async () => {
    const fixture = await acceptanceFixture()

    expect(await mergedTruth(git, fixture.index, { authoredTip: fixture.tipC })).toEqual({
      kind: "not-merged",
      authoredTip: fixture.tipC,
      commitsWalked: 5,
    })
  })

  it("refuses an empty question", async () => {
    const fixture = await acceptanceFixture()

    await expect(mergedTruth(git, fixture.index, {})).rejects.toThrow(/empty question/u)
  })
})

describe("compareMergedTruth — the store agreement harness", () => {
  function claims(fixture: Fixture): readonly StoreMergedClaim[] {
    return [
      { member: "PR1", changeId: ID_A, authoredTip: fixture.tipA, merged: true, mergedCommit: fixture.mergeA },
      { member: "PR2", changeId: ID_B, merged: true, mergedCommit: fixture.mergeB },
      { member: "PR3", changeId: ID_C, merged: false },
      { member: "PR4", changeId: ID_D, merged: true, mergedCommit: fixture.composeD },
    ]
  }

  it("agrees with ground truth, surfaces the trailer-dropped merge as unknown, and never folds it into agree", async () => {
    const fixture = await acceptanceFixture()

    const comparisons = await compareMergedTruth(git, fixture.index, claims(fixture))

    expect(comparisons.map((comparison) => [comparison.member, comparison.agreement])).toEqual([
      ["PR1", "agree"],
      ["PR2", "unknown"],
      ["PR3", "agree"],
      ["PR4", "agree"],
    ])
    const specimenReport = comparisons[1]
    expect(specimenReport?.detail).toContain(fixture.mergeB)
    // PR3's agreement is real, not accidental: the specimen names PR2, so a
    // PR3-scoped miss resolves through member context.
    expect(comparisons[2]?.detail).toContain("not merged")
  })

  it("reaches full parity once the specimen carries its named exception", async () => {
    const fixture = await acceptanceFixture()
    const repaired = await buildMergedTruthIndex(git, fixture.repo, {
      tip: "main",
      exceptions: new Map([[fixture.mergeB, { disposition: "carries-change", changeId: ID_B }]]),
    })

    const comparisons = await compareMergedTruth(git, repaired, claims(fixture))

    expect(comparisons.every((comparison) => comparison.agreement === "agree")).toBe(true)
  })

  it("disagrees when the store's merged commit is not among the repository's evidence", async () => {
    const fixture = await acceptanceFixture()

    const comparisons = await compareMergedTruth(git, fixture.index, [
      { member: "PR1", changeId: ID_A, merged: true, mergedCommit: fixture.mergeD },
    ])

    expect(comparisons[0]?.agreement).toBe("disagree")
    expect(comparisons[0]?.detail).toContain(fixture.mergeD)
  })

  it("disagrees when the store says merged over a specimen-free window that carries no such change", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "doc.txt", "doc\n", ["docs: plain"])
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    const comparisons = await compareMergedTruth(git, index, [{ member: "PR1", changeId: ID_A, merged: true }])

    expect(comparisons[0]?.agreement).toBe("disagree")
    expect(comparisons[0]?.detail).toContain("store says merged")
  })

  it("disagrees when the store says not merged but the repository carries the change", async () => {
    const fixture = await acceptanceFixture()

    const comparisons = await compareMergedTruth(git, fixture.index, [{ member: "PR1", changeId: ID_A, merged: false }])

    expect(comparisons[0]?.agreement).toBe("disagree")
    expect(comparisons[0]?.detail).toContain("repository carries the change")
  })

  it("reports an uncheckable claim as unknown instead of skipping it, keeping the denominator honest", async () => {
    const fixture = await acceptanceFixture()

    const comparisons = await compareMergedTruth(git, fixture.index, [{ member: "PR9", merged: true }])

    expect(comparisons).toHaveLength(1)
    expect(comparisons[0]?.agreement).toBe("unknown")
    expect(comparisons[0]?.detail).toContain("neither a changeId nor an authoredTip")
  })
})
