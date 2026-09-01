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
  describeMergedTruthGaps,
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
/** Two more of the hand merge's orphaned ids, alongside ID_C and ID_D, for the
 * carries-change fixture below — the c0eb0de00707 shape names four. */
const ID_F = `If${"0".repeat(39)}`
const ID_G = `I${"0".repeat(38)}f1`

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

/**
 * The 2026-08-31 incident shape, in miniature: two identifiable landed
 * changes (real Change-Ids, real trailers) either side of one hand merge —
 * a plain `git merge`, no queue-lane subject, no Change-Id — the shape
 * c0eb0de00707 and its two siblings wore before `mergedTruthExceptions`
 * ruled them in production `.yrd.yml`. Pass `exceptions` to rule the hand
 * merge the way that config does; omit it for the unruled window the
 * incident actually hit.
 */
async function handMergeIncidentFixture(
  exceptions?: ReadonlyMap<string, TrailerAbsentException>,
): Promise<Readonly<{ repo: string; handMerge: string; index: MergedTruthIndex }>> {
  const repo = await makeRepo()
  await queueMerge(repo, { branch: "task/f", file: "f.txt", member: "PR10", revision: 1, changeId: ID_A })

  await git.text(repo, ["checkout", "-q", "-b", "task/sync"])
  await commitFile(repo, "sync.txt", "sync\n", ["feat: sync"])
  await git.text(repo, ["checkout", "-q", "main"])
  await git.text(repo, [
    "merge",
    "--no-ff",
    "-m",
    "Merge remote-tracking branch 'origin/main' into task/sync",
    "task/sync",
  ])
  const handMerge = await git.text(repo, ["rev-parse", "HEAD"])

  await queueMerge(repo, { branch: "task/g", file: "g.txt", member: "PR11", revision: 1, changeId: ID_B })

  const index = await buildMergedTruthIndex(git, repo, { tip: "main", ...(exceptions === undefined ? {} : { exceptions }) })
  return { repo, handMerge, index }
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
      [fixture.mergeA, { disposition: "carries-change", changeIds: [ID_B] }],
    ])

    await expect(buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })).rejects.toThrow(
      /contradicts the commit's own readable lineage/u,
    )
  })

  it("applies carries-change and carries-no-change exceptions, clearing the specimens they rule on", async () => {
    const fixture = await acceptanceFixture()
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeB, { disposition: "carries-change", changeIds: [ID_B], note: "recovered from the merge record" }],
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

  it("indexes a back-merge under EVERY change id its ruling names", async () => {
    // The hh shape, in miniature: one specimen commit that rejoined more than
    // one identified change. Ruling it for a single id would clear the specimen
    // — the window then trusts its not-founds — while leaving the remaining ids
    // answering a confident `not-merged` for content that is merged. Measured
    // on hh 2026-08-31: c0eb0de00707 rejoined 4 such ids, and ruling it
    // `carries-no-change` made all four answer `not-merged`.
    const fixture = await acceptanceFixture()
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeB, { disposition: "carries-change", changeIds: [ID_B, ID_C], note: "back-merge: rejoined two" }],
    ])

    const index = await buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })

    expect(index.specimens).toEqual([])
    expect(index.exceptionsApplied).toBe(1)
    expect(mergedByChangeId(index, ID_B).kind).toBe("merged")
    expect(mergedByChangeId(index, ID_C).kind).toBe("merged")
    expect(index.byChangeId.get(ID_C)?.[0]).toMatchObject({ commit: fixture.mergeB, source: "exception" })

    // DISCRIMINATING: name only the first id and the second is not merely
    // unindexed, it is answered WRONG — the specimen is cleared either way.
    const partial = await buildMergedTruthIndex(git, fixture.repo, {
      tip: "main",
      exceptions: new Map([[fixture.mergeB, { disposition: "carries-change", changeIds: [ID_B] }]]),
    })
    expect(partial.specimens).toEqual([])
    expect(mergedByChangeId(partial, ID_C).kind).toBe("not-merged")
  })

  it("refuses a carries-change ruling that names no change id", async () => {
    const fixture = await acceptanceFixture()
    // Cast: the type makes an empty list unrepresentable, and the runtime guard
    // is what catches YAML — which does not.
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeB, { disposition: "carries-change", changeIds: [] } as unknown as TrailerAbsentException],
    ])

    await expect(buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })).rejects.toThrow(
      /names no change id/u,
    )
  })

  it("carries out a declared exception the walk never reached instead of ignoring it silently", async () => {
    const fixture = await acceptanceFixture()
    // `tipC` is a real commit, authored and never merged, so it is nowhere on
    // main's first-parent line — the same shape a typo'd sha wears.
    const exceptions = new Map<string, TrailerAbsentException>([
      [fixture.mergeB, { disposition: "carries-no-change", note: "ruled: sync merge" }],
      [fixture.tipC, { disposition: "carries-no-change", note: "wrong sha" }],
    ])

    const index = await buildMergedTruthIndex(git, fixture.repo, { tip: "main", exceptions })

    expect(index.specimens).toEqual([])
    expect(index.unmatchedExceptions).toEqual([fixture.tipC])
    const gaps = describeMergedTruthGaps(index)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain(fixture.tipC)
    expect(gaps[0]).toContain("rules on nothing")
  })
})

describe("describeMergedTruthGaps", () => {
  it("names every unruled specimen and the only cure available for it", async () => {
    const fixture = await acceptanceFixture()

    const gaps = describeMergedTruthGaps(fixture.index)

    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.join("\n")).toContain(fixture.mergeB)
    // The denominator travels with the count, so a reader can tell an ancient
    // trailer-poor window from a window this change broke.
    expect(gaps[0]).toContain(String(fixture.index.commitsWalked))
    expect(gaps.join("\n")).toContain("mergedTruthExceptions")
  })

  it("says nothing once every specimen is ruled — silence is the cleared state, not an unread one", async () => {
    const fixture = await acceptanceFixture()
    const index = await buildMergedTruthIndex(git, fixture.repo, {
      tip: "main",
      exceptions: new Map([[fixture.mergeB, { disposition: "carries-no-change", note: "ruled: sync merge" }]]),
    })

    expect(index.specimens).toEqual([])
    expect(describeMergedTruthGaps(index)).toEqual([])
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

  it("hit-wins-despite-unruled-specimen: identifiable landed changes resolve merged beside an unruled hand merge — the incident shape", async () => {
    const { index } = await handMergeIncidentFixture()

    // The hand merge is a live, unruled specimen…
    expect(index.specimens).toHaveLength(1)
    // …and it still never reaches either landed change's own lookup: a HIT
    // is decided from `byChangeId` before any specimen is even consulted.
    expect(mergedByChangeId(index, ID_A)).toMatchObject({ kind: "merged" })
    expect(mergedByChangeId(index, ID_B)).toMatchObject({ kind: "merged" })
  })

  it("miss-beside-unruled-specimen: answers the loud unknown, never not-merged, while the hand merge stands unruled", async () => {
    const { index } = await handMergeIncidentFixture()

    expect(mergedByChangeId(index, ID_C)).toMatchObject({ kind: "unknown", reason: "trailer-absent" })
    // However unrelated the queried member — the hand merge names none, so
    // it vetoes regardless, exactly as it did for 1230 real lookups on
    // hh 2026-08-31 before .yrd.yml ruled it.
    expect(mergedByChangeId(index, ID_C, { member: "PR12" })).toMatchObject({ kind: "unknown" })
  })

  it("miss-with-all-merges-ruled: once the hand merge carries a ruling, an unrelated miss answers a definitive not-merged", async () => {
    const { handMerge, repo } = await handMergeIncidentFixture()
    const ruled = await buildMergedTruthIndex(git, repo, {
      tip: "main",
      exceptions: new Map([[handMerge, { disposition: "carries-no-change", note: "ruled: routine sync merge" }]]),
    })

    expect(ruled.specimens).toEqual([])
    expect(mergedByChangeId(ruled, ID_C, { member: "PR12" })).toMatchObject({ kind: "not-merged" })
  })

  it("a carries-change ruling's named ids resolve merged — the declared ruling is the only cure, and it works", async () => {
    const { handMerge, repo } = await handMergeIncidentFixture()
    // The c0eb0de00707 shape: one unruled hand merge rejoining four distinct
    // Change-Ids, none reachable on the walked first-parent line any other way.
    const orphaned = [ID_C, ID_D, ID_F, ID_G] as const
    const ruled = await buildMergedTruthIndex(git, repo, {
      tip: "main",
      exceptions: new Map([[handMerge, { disposition: "carries-change", changeIds: orphaned }]]),
    })

    expect(ruled.specimens).toEqual([])
    for (const id of orphaned) {
      expect(mergedByChangeId(ruled, id)).toMatchObject({ kind: "merged" })
    }
    // The landed changes either side of it are, as ever, unaffected.
    expect(mergedByChangeId(ruled, ID_A)).toMatchObject({ kind: "merged" })
    expect(mergedByChangeId(ruled, ID_B)).toMatchObject({ kind: "merged" })
  })

  it("negative control: a single-parent queue-lane trailer-drop still vetoes — the fix is parent count, not conservatism", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "old.txt", "old\n", ["yrd: compose PR112"])
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(mergedByChangeId(index, ID_C)).toMatchObject({ kind: "unknown", reason: "trailer-absent" })
    expect(mergedByChangeId(index, ID_C, { member: "PR112" })).toMatchObject({ kind: "unknown" })
    // A different member is still ruled out — the queue-lane subject named its own.
    expect(mergedByChangeId(index, ID_C, { member: "PR999" })).toMatchObject({ kind: "not-merged" })
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

  /**
   * The degenerate-containment door-stop. Containment answers YES for free when
   * both endpoints are the same commit, and a free yes is evidence of nothing —
   * the same fact `mergeJoinedNothing` records from the merge side. A candidate
   * that collapsed onto its base is exactly that shape, and certifying it as
   * merged is the defect these two cases pin.
   */
  it("refuses the walked tip against itself: a self-comparison answers unknown, never merged", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedByAncestry(git, fixture.index, fixture.index.tip)

    expect(answer).toMatchObject({ kind: "unknown", reason: "self-comparison", authoredTip: fixture.index.tip })
    expect(answer.kind === "unknown" ? answer.detail : "").toContain(fixture.index.tip)
  })

  it("refuses a candidate that collapsed onto its own base, though git does contain it", async () => {
    const fixture = await acceptanceFixture()

    // The control: mergeA IS contained in the walked tip, so bare containment
    // says merged — the guard fires on the collapse, not on the commit.
    expect(await mergedByAncestry(git, fixture.index, fixture.mergeA)).toMatchObject({ kind: "merged" })

    const answer = await mergedByAncestry(git, fixture.index, fixture.mergeA, { base: fixture.mergeA })

    expect(answer).toMatchObject({ kind: "unknown", reason: "collapsed-onto-base", authoredTip: fixture.mergeA })
    expect(answer.kind === "unknown" ? answer.detail : "").toContain(fixture.mergeA)
  })

  it("still proves containment by ancestry when the candidate carries work over its base", async () => {
    const fixture = await acceptanceFixture()
    const root = await git.text(fixture.repo, ["rev-list", "--max-parents=0", "main"])

    const answer = await mergedByAncestry(git, fixture.index, fixture.tipA, { base: root })

    expect(answer).toEqual({ kind: "merged", authoredTip: fixture.tipA, mergeCommit: fixture.mergeA })
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

  it("falls through to the Change-Id proof when containment degenerates, instead of certifying for free", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedTruth(git, fixture.index, {
      changeId: ID_A,
      authoredTip: fixture.mergeA,
      base: fixture.mergeA,
    })

    expect(answer).toMatchObject({ kind: "merged", via: "change-id", changeId: ID_A })
  })

  it("answers the loud unknown when containment degenerates and no lineage proof was asked for", async () => {
    const fixture = await acceptanceFixture()

    const answer = await mergedTruth(git, fixture.index, { authoredTip: fixture.index.tip })

    expect(answer).toMatchObject({ kind: "unknown", reason: "self-comparison" })
    expect(answer.kind === "unknown" && "detail" in answer ? answer.detail : "").toContain(fixture.index.tip)
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
      exceptions: new Map([[fixture.mergeB, { disposition: "carries-change", changeIds: [ID_B] }]]),
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

  it("never certifies a store claim from a collapsed candidate: the tautology reads unknown, not agree", async () => {
    const fixture = await acceptanceFixture()

    const comparisons = await compareMergedTruth(git, fixture.index, [
      { member: "PR9", authoredTip: fixture.mergeA, baseSha: fixture.mergeA, merged: true },
    ])

    expect(comparisons[0]?.agreement).toBe("unknown")
    expect(comparisons[0]?.detail).toContain(fixture.mergeA)
  })
})

/**
 * The walk reads what a synthesis commit STATES, not how its subject reads.
 *
 * Before this, member and revision were regexed out of the subject. That works
 * while the vocabulary stands still and fails catastrophically when it moves: a
 * subject the regex misses turns the commit into a specimen, and one specimen
 * makes every not-found lookup in the window answer the loud unknown.
 */
describe("synthesis facts come from trailers, with the subject as the pre-epoch fallback", () => {
  const ID_T = `Id${"0".repeat(39)}`

  /** Queue-merge with an explicit trailer block, so a case can state the
   * trailers and the subject independently — which is the whole point here. */
  async function mergeWith(
    repo: string,
    options: Readonly<{ branch: string; file: string; subject: string; trailers: string }>,
  ): Promise<string> {
    await git.text(repo, ["checkout", "-q", "-b", options.branch])
    await commitFile(repo, options.file, `${options.file}\n`, [`feat: ${options.file}`])
    await git.text(repo, ["checkout", "-q", "main"])
    await git.text(repo, ["merge", "--no-ff", "-m", options.subject, "-m", options.trailers, options.branch])
    return git.text(repo, ["rev-parse", "HEAD"])
  }

  it("resolves a fully-trailered commit whose SUBJECT the regex cannot parse", async () => {
    // The failure this exists to prevent, made concrete: a future vocabulary.
    // `yrd: land ...` is not `merge` or `compose`, so QUEUE_SYNTHESIS_SUBJECT
    // misses it entirely — and before trailers that alone was enough to make
    // the commit a specimen and poison every lookup in the window.
    const repo = await makeRepo()
    const commit = await mergeWith(repo, {
      branch: "issue/future-vocabulary",
      file: "future.txt",
      subject: "yrd: land PR9001 attempt 3",
      trailers: `Change-Id: ${ID_T}\nMerge-Change-Id: ${ID_T}-merge\nYrd-Member: PR9001\nYrd-Revision: 3`,
    })
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens, "a stated commit must never become a specimen").toEqual([])
    const found = mergedByChangeId(index, ID_T)
    expect(found.kind).toBe("merged")
    const occurrence = found.kind === "merged" ? found.occurrences[0] : undefined
    expect(occurrence?.commit).toBe(commit)
    expect(occurrence?.member, "member comes from the trailer").toBe("PR9001")
    expect(occurrence?.revision, "revision comes from the trailer").toBe(3)
    expect(occurrence?.operation, "operation comes from Merge-Change-Id, not the subject").toBe("merge")
  })

  it("makes a trailer that CONTRADICTS its subject a specimen rather than picking one", async () => {
    // Both sources present and disagreeing means the funnel wrote two different
    // answers. Silently preferring either would index a fact no one stated.
    const repo = await makeRepo()
    await mergeWith(repo, {
      branch: "issue/disagreeing",
      file: "disagree.txt",
      subject: "yrd: merge PR100 revision 1",
      trailers: `Change-Id: ${ID_T}\nMerge-Change-Id: ${ID_T}-merge\nYrd-Member: PR999\nYrd-Revision: 7`,
    })
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens).toHaveLength(1)
    expect(index.specimens[0]?.detail).toContain("PR999")
    expect(index.specimens[0]?.detail).toContain("PR100")

    // The LINEAGE still resolves, and that is correct rather than lenient: the
    // Change-Id trailer is unambiguous, so whether the change landed is a
    // question this commit answers plainly. Only the member and revision are
    // contested, and those are context, not identity.
    const found = mergedByChangeId(index, ID_T)
    expect(found.kind, "an unambiguous Change-Id still answers the landing question").toBe("merged")

    // What must NOT happen is the contested context being guessed. Neither the
    // trailer's answer nor the subject's is carried, because the commit gives
    // no basis to prefer one over the other.
    const occurrence = found.kind === "merged" ? found.occurrences[0] : undefined
    expect(occurrence?.member, "a contested member is withheld, never picked").toBeUndefined()
    expect(occurrence?.revision, "and so is the revision").toBeUndefined()
  })

  it("still reads pre-epoch history, which carries no such trailers", async () => {
    // Backward compatibility is the assertion: every commit written before this
    // change has only a subject, and must resolve exactly as it always did.
    const repo = await makeRepo()
    await mergeWith(repo, {
      branch: "issue/pre-epoch",
      file: "old.txt",
      subject: "yrd: merge PR42 revision 2",
      trailers: `Change-Id: ${ID_T}\nMerge-Change-Id: ${ID_T}-merge`,
    })
    const index = await buildMergedTruthIndex(git, repo, { tip: "main" })

    expect(index.specimens).toEqual([])
    const found = mergedByChangeId(index, ID_T)
    const occurrence = found.kind === "merged" ? found.occurrences[0] : undefined
    expect(occurrence?.member).toBe("PR42")
    expect(occurrence?.revision).toBe(2)
    expect(occurrence?.operation).toBe("merge")
  })
})
