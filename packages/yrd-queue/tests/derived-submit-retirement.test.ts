/**
 * @failure `applyArchival` (yrd-bay/receiver.ts) sweeps a submit ref only
 * when `refs/heads/<branch>` is deleted at the bay remote, but the canonical
 * derived-lane delivery — `git push bay HEAD:refs/for/<base>/<issue>` — never
 * creates a branch head, so a derived-lane `refs/yrd/submit/<branch>` ref
 * that has already landed is never proven safe to retire and stays unswept
 * forever (@yrd/core/22991 derived-lane submit-ref retirement). Population at
 * last census: 11 standing refs, 7 genuinely in use, 4 already gone by other
 * means — the rest accumulate without bound.
 *
 * @level l1
 * @consumer @yrd/queue `derivedSubmitRetirements` — the derived-lane
 *   counterpart of `submitFactRetirement` (queue.ts). It reads the landing
 *   SCAN rather than `landedSubmitBranches(scan)`: that set folds ancestry,
 *   change-id and degenerate proofs into one bare "landed", which is correct
 *   for admission exclusion (over-excluding only makes work wait) and wrong
 *   for a decision that DELETES.
 *
 * The mandatory negative control runs at BOTH layers this file tests: the
 * pure decision (a hand-built scan) and the real proof pipeline
 * (`landedSubmits` over an actual git repository). Deleting a LIVE
 * derived-lane approval is the one outcome worse than never sweeping at all,
 * so every "landed" case here is paired with an "unlanded" sibling built from
 * the same fixture — and each non-ancestry proof kind has its own control
 * proving it reaches neither arm.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemove } from "removely"
import { afterEach, describe, expect, it } from "vitest"
import type { BaysState } from "@yrd/bay"
import type { DeepReadonly } from "@yrd/core"
import {
  derivedSubmitRetirements,
  landedSubmitBranches,
  landedSubmits,
  submitRefRetirementCommand,
  type LandedSubmitScan,
  type UnresolvedSubmit,
} from "../src/derived-admission.ts"
import { buildMergedTruthIndex, type MergedTruthIndex } from "../src/merged-truth.ts"
import { fixtureRefGit } from "./support/remerge-fixtures.ts"

const AT = "2026-08-28T00:00:00.000Z"

type FactSpec = Readonly<{ branch: string; sha: string; base?: string }>
type RecordSpec = Readonly<{ id: string; branch: string; head: string; live?: boolean }>

/** A minimal `BaysState` naming only what `derivedSubmitRetirements` and the
 * arbitration it delegates to actually read: `submits` and `prs`. Mirrors
 * `landed-submits-derived.test.ts`'s own `bays()` — same cast, same reason:
 * the full `Change`/`BaysState` shapes carry far more than this decision
 * touches, and a literal covering all of it would obscure which fields drive
 * the assertion. */
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
          state: record.live === true ? "open" : "closed",
          merged: record.live !== true,
          revs: [{ n: 1, head: record.head }],
          reviews: [],
          ...(record.live === true ? {} : { integration: { commit: record.head } }),
        },
      ]),
    ),
    submits: Object.fromEntries(
      facts.map((fact) => [fact.branch, { sha: fact.sha, base: fact.base ?? "main", at: AT }]),
    ),
  } as unknown as DeepReadonly<BaysState>
}

type LandedSpec = Readonly<{ branch: string; sha: string; via?: "ancestry" | "change-id"; mergeCommit?: string }>

/** A `LandedSubmitScan` naming exactly the proof kinds one case exercises.
 * The sweep reads the SCAN, not `landedSubmitBranches(scan)`: that set folds
 * ancestry, change-id and degenerate together, which is safe for admission
 * exclusion and unsafe for a decision that DELETES. `via` defaults to
 * `ancestry` so the cases about lane arbitration stay about lane
 * arbitration. */
function scan(landed: readonly LandedSpec[], unresolved: readonly UnresolvedSubmit[] = []): LandedSubmitScan {
  return {
    landed: landed.map((row) => ({
      branch: row.branch,
      sha: row.sha,
      via: row.via ?? "ancestry",
      ...(row.mergeCommit === undefined ? {} : { mergeCommit: row.mergeCommit }),
    })),
    unresolved,
    facts: landed.length + unresolved.length,
  }
}

describe("derivedSubmitRetirements — pure decision over a supplied landing scan", () => {
  it("names a recordless derived-lane branch proven landed, with the exact retirement directive", () => {
    const state = bays([{ branch: "issue/ghost", sha: "a".repeat(40) }])

    expect(derivedSubmitRetirements(state, scan([{ branch: "issue/ghost", sha: "a".repeat(40) }])).retirements).toEqual([
      {
        branch: "issue/ghost",
        sha: "a".repeat(40),
        base: "main",
        ref: "refs/yrd/submit/issue/ghost",
        command: "git push bay :refs/yrd/submit/issue/ghost",
      },
    ])
  })

  it("NEGATIVE CONTROL: leaves an UNLANDED derived-lane branch alone — same fixture, empty scan", () => {
    // The disaster this sweep must never cause: retiring a ref nothing has
    // proven landed deletes a live approval unrecoverably. 7 of the 11 refs
    // in the last census were exactly this — still pending.
    const state = bays([{ branch: "issue/ghost", sha: "a".repeat(40) }])

    expect(derivedSubmitRetirements(state, scan([])).retirements).toEqual([])
  })

  it("never retires a branch a LIVE record owns, even when the branch is reported landed", () => {
    // Lane boundary: a live record's own pending signal is the record lane's
    // business (`submitFactRetirement`), never this sweep's — arbitration
    // classifies it "record" whatever the submit sha says.
    const sha = "b".repeat(40)
    const state = bays([{ branch: "task/live", sha }], [{ id: "PR1", branch: "task/live", head: sha, live: true }])

    expect(derivedSubmitRetirements(state, scan([{ branch: "task/live", sha }])).retirements).toEqual([])
  })

  it("retires a post-integration resubmit: TERMINAL record, fact moved past it, still arbitrates derived", () => {
    // arbitrateDerivedChange's own rule: terminal record + different-sha
    // submit is the derived lane's re-entry for a branch's NEXT head — the
    // same cell `derivedLaneBranches` admits from.
    const mergedHead = "c".repeat(40)
    const resubmitted = "d".repeat(40)
    const state = bays(
      [{ branch: "task/again", sha: resubmitted }],
      [{ id: "PR2", branch: "task/again", head: mergedHead }],
    )

    expect(derivedSubmitRetirements(state, scan([{ branch: "task/again", sha: resubmitted }])).retirements).toEqual([
      {
        branch: "task/again",
        sha: resubmitted,
        base: "main",
        ref: "refs/yrd/submit/task/again",
        command: "git push bay :refs/yrd/submit/task/again",
      },
    ])
  })

  it("never retires a TERMINAL record's own fact at the record's own head — that cell is `record` lane", () => {
    // arbitrateDerivedChange: terminal record + SAME-sha submit stays
    // `record` lane (the ref names exactly the head the record already
    // accounts for); this sweep must not act on it even if a caller's
    // scan names the branch as landed.
    const head = "e".repeat(40)
    const state = bays([{ branch: "task/settled", sha: head }], [{ id: "PR3", branch: "task/settled", head }])

    expect(derivedSubmitRetirements(state, scan([{ branch: "task/settled", sha: head }])).retirements).toEqual([])
  })

  it("sorts multiple retirements by branch and matches submitRefRetirementCommand's own string exactly", () => {
    // "the machine-printed retirement command preserved for the warn rows":
    // both surfaces call the same helper, so this is a structural guarantee,
    // not a coincidence this one assertion could miss.
    const state = bays([
      { branch: "issue/zebra", sha: "1".repeat(40) },
      { branch: "issue/alpha", sha: "2".repeat(40) },
    ])

    const result = derivedSubmitRetirements(state, scan([
      { branch: "issue/zebra", sha: "1".repeat(40) },
      { branch: "issue/alpha", sha: "2".repeat(40) },
    ])).retirements
    expect(result.map((row) => row.branch)).toEqual(["issue/alpha", "issue/zebra"])
    for (const row of result) {
      expect(row.command).toBe(submitRefRetirementCommand(row.branch))
    }
  })

  it("answers empty over an empty bays.submits, never throws", () => {
    const swept = derivedSubmitRetirements(bays([]), scan([]))
    expect(swept.retirements).toEqual([])
    expect(swept.authorErrorSuspects).toEqual([])
  })

  it("NEGATIVE CONTROL: a `via: change-id` fact is NEVER retired — it is reported as an author-error suspect", () => {
    // The proof kinds are not interchangeable. `change-id` says the CHANGE
    // landed under a DIFFERENT commit; this fact's own content is unproven,
    // and when it carries new work the ref is the only pointer to it. The
    // folded `landedSubmitBranches` set cannot express this — it is exactly
    // the fold this function stopped consuming.
    const sha = "f".repeat(40)
    const merge = "9".repeat(40)
    const state = bays([{ branch: "issue/renamed", sha }])

    const landing = scan([{ branch: "issue/renamed", sha, via: "change-id", mergeCommit: merge }])

    // Teeth: the fold this function stopped consuming DOES name this branch,
    // so the previous set-based signature would have swept it. That is the
    // whole delta, and without this line the assertion below could pass for
    // the trivial reason that nothing reached the sweep at all.
    expect(landedSubmitBranches(landing), "the folded set cannot tell the proofs apart").toEqual(
      new Set(["issue/renamed"]),
    )

    const swept = derivedSubmitRetirements(state, landing)

    expect(swept.retirements, "a change-id proof must never authorize a deletion").toEqual([])
    expect(swept.authorErrorSuspects).toEqual([
      {
        branch: "issue/renamed",
        sha,
        mergeCommit: merge,
        remedy:
          "the CHANGE landed under a different commit, so this fact's own content is unproven: if it carries " +
          "new work, resubmit it under a fresh Change-Id; if it is an abandoned revision, retire it explicitly " +
          "(git push bay :refs/yrd/submit/issue/renamed)",
      },
    ])
  })

  it("NEGATIVE CONTROL: a DEGENERATE unresolved fact appears in NEITHER arm", () => {
    // `landedSubmitBranches` folds degenerate rows in, because barring
    // admission on one is safe. Deleting on one is not: containment held for
    // free against the walked tip, so nothing was proven. Its surface is the
    // compose's own warn row, which words retirement as the OPERATOR's call —
    // a mechanical sweep must not preempt that.
    const sha = "7".repeat(40)
    const state = bays([{ branch: "issue/degenerate", sha }])
    const degenerate: UnresolvedSubmit = {
      branch: "issue/degenerate",
      sha,
      reason: "degenerate",
      detail: "the fact stands at the walked tip itself",
    }

    // The fold this function no longer trusts DOES name it — that is the point.
    expect(landedSubmitBranches(scan([], [degenerate])), "the folded set bars it from admission").toEqual(
      new Set(["issue/degenerate"]),
    )

    const swept = derivedSubmitRetirements(state, scan([], [degenerate]))
    expect(swept.retirements, "a degenerate row proves nothing and must not be swept").toEqual([])
    expect(swept.authorErrorSuspects, "nor is it an author error — it is simply unproven").toEqual([])
  })
})

describe("derivedSubmitRetirements — over a REAL landing scan (proof pipeline, not a mock)", () => {
  const git = fixtureRefGit()
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => safeRemove(root, { within: tmpdir(), allowMissing: true })))
  })

  async function makeRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "yrd-derived-submit-retirement-"))
    roots.push(root)
    const repo = join(root, "repo")
    await git.text(root, ["init", "-b", "main", "repo"])
    await Bun.write(join(repo, "base.txt"), "base\n")
    await git.text(repo, ["add", "--", "base.txt"])
    await git.text(repo, ["commit", "-m", "chore: base"])
    return repo
  }

  async function queueMerge(repo: string, branch: string, file: string, member: string): Promise<string> {
    await git.text(repo, ["checkout", "-q", "-b", branch, "main"])
    await Bun.write(join(repo, file), `${file}\n`)
    await git.text(repo, ["add", "--", file])
    await git.text(repo, ["commit", "-m", `feat: ${file}`])
    const authoredTip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "-q", "main"])
    await git.text(repo, ["merge", "--no-ff", "-m", `yrd: merge ${member} revision 1`, branch])
    return authoredTip
  }

  async function authorOnly(repo: string, branch: string, file: string): Promise<string> {
    await git.text(repo, ["checkout", "-q", "-b", branch, "main"])
    await Bun.write(join(repo, file), `${file}\n`)
    await git.text(repo, ["add", "--", file])
    await git.text(repo, ["commit", "-m", `feat: ${file}`])
    const tip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "-q", "main"])
    return tip
  }

  async function indexOf(repo: string): Promise<MergedTruthIndex> {
    return await buildMergedTruthIndex(git, repo, { tip: "main" })
  }

  it("retires a derived-lane submit ref once a real merge proves its content landed", async () => {
    const repo = await makeRepo()
    const authoredTip = await queueMerge(repo, "issue/real-landing", "landing.txt", "PR1")
    const state = bays([{ branch: "issue/real-landing", sha: authoredTip }])

    const scanResult = await landedSubmits(git, async () => await indexOf(repo), state)
    const landed = landedSubmitBranches(scanResult)
    expect(landed, "the proof pipeline this function relies on must see the merge").toEqual(
      new Set(["issue/real-landing"]),
    )

    expect(derivedSubmitRetirements(state, scanResult).retirements).toEqual([
      {
        branch: "issue/real-landing",
        sha: authoredTip,
        base: "main",
        ref: "refs/yrd/submit/issue/real-landing",
        command: "git push bay :refs/yrd/submit/issue/real-landing",
      },
    ])
  })

  it("NEGATIVE CONTROL (real git): never retires a derived-lane ref for an UNLANDED branch", async () => {
    const repo = await makeRepo()
    const authoredTip = await authorOnly(repo, "issue/still-pending", "pending.txt")
    const state = bays([{ branch: "issue/still-pending", sha: authoredTip }])

    const scanResult = await landedSubmits(git, async () => await indexOf(repo), state)
    const landed = landedSubmitBranches(scanResult)
    expect(landed, "an unmerged branch must not read as landed").toEqual(new Set())

    expect(derivedSubmitRetirements(state, scanResult).retirements).toEqual([])
  })

  it("NEGATIVE CONTROL (real git, mixed population): the pending sibling survives beside the landed one", async () => {
    // The exact shape of the live population this sweep must never mis-sweep:
    // some refs landed, most still pending, in the SAME scan and the SAME
    // sweep call.
    const repo = await makeRepo()
    const landedTip = await queueMerge(repo, "issue/done", "done.txt", "PR2")
    const pendingTip = await authorOnly(repo, "issue/pending", "pending.txt")
    const state = bays([
      { branch: "issue/done", sha: landedTip },
      { branch: "issue/pending", sha: pendingTip },
    ])

    const scanResult = await landedSubmits(git, async () => await indexOf(repo), state)
    const landed = landedSubmitBranches(scanResult)
    const result = derivedSubmitRetirements(state, scanResult).retirements

    expect(result.map((row) => row.branch)).toEqual(["issue/done"])
  })
})
