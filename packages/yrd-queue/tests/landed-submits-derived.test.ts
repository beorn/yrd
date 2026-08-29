/**
 * @failure "Has this standing submit fact's content already landed?" is
 *          answered out of the change-record store, so a recordless branch and
 *          a merge-time rebuild both read as NOT landed and compose again —
 *          the PR2139 double-merge — or a store row claiming a landing the
 *          repository does not carry is silently preferred over git.
 * @level l1
 * @consumer @yrd/queue `landedSubmits` (the compose door's landed-content
 *           exclusion via `derivedLaneBranches`, and `yrd admin pr prune`'s
 *           unscanned-fact report). S5 pilot: the first consumer cut off
 *           `BaysState.prs` onto `merged-truth.ts`.
 *
 * Every case runs over a REAL repository. The question is a containment fact
 * about git's own history, so a canned string fixture would prove the mock,
 * not the read — and the retired store-keyed answer is reproduced beside each
 * derived one so the delta between them is the assertion, not a claim.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { BaysState } from "@yrd/bay"
import type { DeepReadonly } from "@yrd/core"
import { derivedLaneBranches, landedSubmitBranches, landedSubmits } from "../src/derived-admission.ts"
import { buildMergedTruthIndex, type MergedTruthIndex } from "../src/merged-truth.ts"
import { fixtureRefGit } from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A sha this repository has never held — the unreadable-fact specimen. */
const ABSENT_SHA = "f".repeat(40)

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-landed-submits-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git.text(root, ["init", "-b", "main", "repo"])
  await Bun.write(join(repo, "base.txt"), "base\n")
  await git.text(repo, ["add", "--", "base.txt"])
  await git.text(repo, ["commit", "-m", "chore: base"])
  return repo
}

/** Author a branch and queue-merge it into main the way the queue does. */
async function queueMerge(
  repo: string,
  options: Readonly<{ branch: string; file: string; member: string; base?: string }>,
): Promise<Readonly<{ authoredTip: string; mergeCommit: string }>> {
  const base = options.base ?? "main"
  await git.text(repo, ["checkout", "-q", "-b", options.branch, base])
  await Bun.write(join(repo, options.file), `${options.file}\n`)
  await git.text(repo, ["add", "--", options.file])
  await git.text(repo, ["commit", "-m", `feat: ${options.file}`])
  const authoredTip = await git.text(repo, ["rev-parse", "HEAD"])
  await git.text(repo, ["checkout", "-q", base])
  await git.text(repo, ["merge", "--no-ff", "-m", `yrd: merge ${options.member} revision 1`, options.branch])
  return { authoredTip, mergeCommit: await git.text(repo, ["rev-parse", "HEAD"]) }
}

/** Author a branch and leave it UNMERGED. */
async function authorOnly(repo: string, branch: string, file: string): Promise<string> {
  await git.text(repo, ["checkout", "-q", "-b", branch, "main"])
  await Bun.write(join(repo, file), `${file}\n`)
  await git.text(repo, ["add", "--", file])
  await git.text(repo, ["commit", "-m", `feat: ${file}`])
  const tip = await git.text(repo, ["rev-parse", "HEAD"])
  await git.text(repo, ["checkout", "-q", "main"])
  return tip
}

type FactSpec = Readonly<{ branch: string; sha: string }>
/** A TERMINAL record naming `commit` as the landing it delivered. */
type RecordSpec = Readonly<{ id: string; branch: string; commit: string }>

function bays(facts: readonly FactSpec[], records: readonly RecordSpec[] = []): DeepReadonly<BaysState> {
  return {
    byId: {},
    receipts: {},
    prs: Object.fromEntries(
      records.map((record) => [
        record.id,
        {
          id: record.id,
          branch: record.branch,
          state: "closed",
          merged: true,
          revs: [{ n: 1, head: record.commit }],
          reviews: [],
          integration: { commit: record.commit },
        },
      ]),
    ),
    submits: Object.fromEntries(
      facts.map((fact) => [fact.branch, { sha: fact.sha, base: "main", at: "2026-08-28T00:00:00.000Z" }]),
    ),
  } as unknown as DeepReadonly<BaysState>
}

/**
 * The RETIRED reader, reproduced verbatim so each case can assert what the
 * store would have said. Deleting the production copy without keeping this one
 * would leave every "the store got this wrong" claim unevidenced.
 */
function storeLandedSubmits(state: DeepReadonly<BaysState>): readonly string[] {
  return Object.entries(state.submits)
    .flatMap(([branch, submit]) =>
      Object.values(state.prs).some(
        (pr) => pr.branch === branch && pr.state !== "open" && pr.integration?.commit === submit.sha,
      )
        ? [branch]
        : [],
    )
    .toSorted()
}

async function indexOf(repo: string): Promise<MergedTruthIndex> {
  return await buildMergedTruthIndex(git, repo, { tip: "main" })
}

const indexFor = (repo: string) => async () => await indexOf(repo)

describe("landedSubmits derives landed content from the repository, not the change record", () => {
  it("finds a RECORDLESS branch's landed content the record store structurally cannot see", async () => {
    // The 2026-08-28 outage's own shape: four merged branches whose facts were
    // never retired, none of them holding a record, composing on every pass.
    const repo = await makeRepo()
    const merged = await queueMerge(repo, { branch: "issue/ghost", file: "ghost.txt", member: "PR1" })
    const state = bays([{ branch: "issue/ghost", sha: merged.authoredTip }])

    // The retired oracle: no record on the branch, so nothing to match.
    expect(storeLandedSubmits(state), "the record store answers a bare, wrong zero").toEqual([])

    const scan = await landedSubmits(git, indexFor(repo), state)
    expect(scan.landed).toEqual([{ branch: "issue/ghost", sha: merged.authoredTip, mergeCommit: merged.mergeCommit }])
    expect(scan.unresolved).toEqual([])
    expect(scan.facts, "the denominator the zero would have been a zero across").toBe(1)

    // The disagreement is REPORTED, never reconciled away.
    expect(scan.disagreements).toHaveLength(1)
    expect(scan.disagreements[0]).toMatchObject({ branch: "issue/ghost", store: "not-landed", derived: "landed" })
    expect(scan.disagreements[0]?.record, "no record produced the store's claim").toBeUndefined()

    // The behaviour that changed: the branch leaves the derived lane.
    expect(derivedLaneBranches(state, new Set()), "without the repository's answer it composes").toEqual([
      "issue/ghost",
    ])
    expect(derivedLaneBranches(state, landedSubmitBranches(scan)), "with it, it does not").toEqual([])
  })

  it("survives a merge-time REBUILD, where the store's sha equality cannot hold", async () => {
    // The queue rebuilds a candidate at merge under a new head, so a terminal
    // record's `integration.commit` is not the fact's sha even when the record
    // exists and the content really did land.
    const repo = await makeRepo()
    const merged = await queueMerge(repo, { branch: "task/rebuilt", file: "rebuilt.txt", member: "PR2" })
    const state = bays(
      [{ branch: "task/rebuilt", sha: merged.authoredTip }],
      [{ id: "PR2", branch: "task/rebuilt", commit: merged.mergeCommit }],
    )

    expect(storeLandedSubmits(state), "the sha equality the store tests does not survive the rebuild").toEqual([])

    const scan = await landedSubmits(git, indexFor(repo), state)
    expect(scan.landed.map((row) => row.branch)).toEqual(["task/rebuilt"])
    expect(scan.disagreements[0]).toMatchObject({ branch: "task/rebuilt", store: "not-landed", derived: "landed" })
  })

  it("REFUSES a store row claiming a landing the repository does not carry", async () => {
    // The direction that must never be silent: the record says merged, git
    // says the commit is not on main. The repository decides, and the
    // contradiction is named with the record that made the claim.
    const repo = await makeRepo()
    const unmerged = await authorOnly(repo, "task/phantom", "phantom.txt")
    const state = bays(
      [{ branch: "task/phantom", sha: unmerged }],
      [{ id: "PR9", branch: "task/phantom", commit: unmerged }],
    )

    expect(storeLandedSubmits(state), "the store certifies the landing").toEqual(["task/phantom"])

    const scan = await landedSubmits(git, indexFor(repo), state)
    expect(scan.landed, "git carries no such commit on main").toEqual([])
    expect(scan.unresolved).toEqual([])
    expect(scan.disagreements).toHaveLength(1)
    expect(scan.disagreements[0]).toMatchObject({
      branch: "task/phantom",
      store: "landed",
      derived: "not-landed",
      record: "PR9",
    })
    expect(scan.disagreements[0]?.detail).toContain("the repository does not carry")
    // Nothing proved a landing, so this reader bars nothing. (Whether the
    // branch then composes is arbitration's separate question — a terminal
    // record at the fact's own sha is its own exclusion cell.)
    expect(landedSubmitBranches(scan)).toEqual(new Set())
  })

  it("answers the loud unknown, never `landed`, when containment would hold for free", async () => {
    // merged-truth's self-comparison door-stop: a fact standing at the walked
    // tip itself satisfies `is A contained in B` for nothing. The content is on
    // the tip by construction, so the branch is still barred — but the scan
    // says it could not PROVE it, and which row it could not prove.
    const repo = await makeRepo()
    await queueMerge(repo, { branch: "task/tip", file: "tip.txt", member: "PR3" })
    const tip = await git.text(repo, ["rev-parse", "main"])
    const state = bays([{ branch: "task/tip", sha: tip }])

    const scan = await landedSubmits(git, indexFor(repo), state)
    expect(scan.landed, "a free yes is not evidence of a merge").toEqual([])
    expect(scan.unresolved).toMatchObject([{ branch: "task/tip", sha: tip, reason: "degenerate" }])
    expect(scan.unresolved[0]?.detail).toContain("the SAME commit")
    expect(landedSubmitBranches(scan), "unprovable-but-on-the-tip still bars admission").toEqual(new Set(["task/tip"]))
  })

  it("attributes an unreadable fact to ITS branch, keeps it admissible, and answers its siblings", async () => {
    // The per-branch boundary: one fact whose commit this repository does not
    // hold must not starve the scan, and must not be read as landed — dropping
    // a live submission on a failed read is the worse of the two errors.
    const repo = await makeRepo()
    const merged = await queueMerge(repo, { branch: "issue/real", file: "real.txt", member: "PR4" })
    const state = bays([
      { branch: "issue/real", sha: merged.authoredTip },
      { branch: "issue/vanished", sha: ABSENT_SHA },
    ])

    const scan = await landedSubmits(git, indexFor(repo), state)
    expect(scan.facts).toBe(2)
    expect(
      scan.landed.map((row) => row.branch),
      "the healthy sibling is still answered",
    ).toEqual(["issue/real"])
    expect(scan.unresolved).toMatchObject([{ branch: "issue/vanished", sha: ABSENT_SHA, reason: "unreadable" }])
    expect(scan.unresolved[0]?.detail).toContain(ABSENT_SHA)
    expect(landedSubmitBranches(scan), "an unreadable fact is not evidence of a landing").toEqual(
      new Set(["issue/real"]),
    )
  })

  it("agrees with the store on an unmerged branch, and says what it walked", async () => {
    // The positive control for every zero above: a genuinely unmerged fact
    // reads not-landed from BOTH oracles, so the disagreements the other cases
    // report are the readers differing, not this reader answering `landed` to
    // everything.
    const repo = await makeRepo()
    await queueMerge(repo, { branch: "task/other", file: "other.txt", member: "PR5" })
    const live = await authorOnly(repo, "task/live", "live.txt")
    const state = bays([{ branch: "task/live", sha: live }])

    expect(storeLandedSubmits(state)).toEqual([])
    const scan = await landedSubmits(git, indexFor(repo), state)
    expect(scan).toMatchObject({ landed: [], unresolved: [], disagreements: [], facts: 1 })
    expect(derivedLaneBranches(state, landedSubmitBranches(scan))).toEqual(["task/live"])
  })

  it("asks each fact's OWN base, so a release-branch fact is not answered by main's index", async () => {
    // An index is pinned to one walked tip. A fact declares the base it
    // targets, and answering it from another base's history would answer a
    // different question without saying so.
    const repo = await makeRepo()
    await git.text(repo, ["branch", "release", "main"])
    const releaseOnly = await queueMerge(repo, {
      branch: "task/release",
      file: "release.txt",
      member: "PR6",
      base: "release",
    })
    await git.text(repo, ["checkout", "-q", "main"])

    const state = {
      byId: {},
      receipts: {},
      prs: {},
      submits: {
        "task/release": { sha: releaseOnly.authoredTip, base: "release", at: "2026-08-28T00:00:00.000Z" },
      },
    } as unknown as DeepReadonly<BaysState>

    const asked: string[] = []
    const scan = await landedSubmits(
      git,
      async (base) => {
        asked.push(base)
        return await buildMergedTruthIndex(git, repo, { tip: base })
      },
      state,
    )
    expect(asked, "the fact's own base was walked").toEqual(["release"])
    expect(scan.landed.map((row) => row.branch)).toEqual(["task/release"])

    // The control: main's index answers the opposite for the same fact, which
    // is exactly why the base may not be assumed.
    const fromMain = await landedSubmits(git, indexFor(repo), state)
    expect(fromMain.landed, "main does not carry the release-only content").toEqual([])
    expect(fromMain.unresolved).toEqual([])
  })

  it("fails ONE base loudly rather than the whole scan when its index cannot be built", async () => {
    const repo = await makeRepo()
    const merged = await queueMerge(repo, { branch: "issue/fine", file: "fine.txt", member: "PR7" })
    const state = {
      byId: {},
      receipts: {},
      prs: {},
      submits: {
        "issue/fine": { sha: merged.authoredTip, base: "main", at: "2026-08-28T00:00:00.000Z" },
        "issue/nobase": { sha: merged.authoredTip, base: "no-such-base", at: "2026-08-28T00:00:00.000Z" },
      },
    } as unknown as DeepReadonly<BaysState>

    const scan = await landedSubmits(git, async (base) => await buildMergedTruthIndex(git, repo, { tip: base }), state)
    expect(scan.landed.map((row) => row.branch)).toEqual(["issue/fine"])
    expect(scan.unresolved).toMatchObject([{ branch: "issue/nobase", reason: "unreadable" }])
    expect(scan.unresolved[0]?.detail).toContain("no-such-base")
  })
})
