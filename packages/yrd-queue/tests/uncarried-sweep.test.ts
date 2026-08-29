/**
 * @failure The uncarried sweep stops enumerating, reports an empty result it
 *          cannot justify, or pays per-ref git cost for refs it will discard.
 * @level   l1
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { applyHostFindingFilter, sweepUncarriedRefs, type SweepOptions } from "../src/uncarried-sweep.ts"
import type { RefGit } from "../src/uncarried-facts.ts"

const HOUR = 60 * 60 * 1000
const NOW = Date.parse("2026-08-11T22:00:00.000Z")

const OPTIONS = {
  repo: "/repo",
  base: "main",
  namespace: "refs/remotes/origin",
  nowMs: NOW,
  ttlMs: 10 * 60 * 1000,
  ageBoundMs: 24 * HOUR,
  carriedBranches: new Set<string>(),
} as const satisfies SweepOptions

/** Records every git invocation so the test can assert what was NOT run —
 * the cheap-disqualifier ordering is only observable that way. */
function fakeGit(responses: Record<string, string>): RefGit & { calls: string[][] } {
  const calls: string[][] = []
  const answer = (args: readonly string[]): string | undefined => {
    calls.push([...args])
    for (const [prefix, value] of Object.entries(responses)) {
      if (args.join(" ").startsWith(prefix)) return value
    }
    // The sweep now probes merge-base before gathering facts. Every fixture
    // ref in this file shares history with the base — the unrelated-history
    // case is exercised against a REAL repository below, because a double that
    // can be told to have no merge base proves nothing about git's own 128.
    if (args[0] === "merge-base") return "0".repeat(40)
    if (args[0] === "reflog" && args[1] === "show") {
      const refs = responses["for-each-ref"] ?? ""
      return refs
        .split("\n")
        .filter((line) => line !== "")
        .flatMap((line) => {
          const [fullRef, ref] = line.split("\0")
          const agoMs = ref === undefined ? undefined : REF_AGES.get(ref)
          return fullRef !== undefined && agoMs !== undefined ? [reflogLine(fullRef, agoMs)] : []
        })
        .join("\n")
    }
    return undefined
  }
  return {
    calls,
    async text(_repo, args) {
      const value = answer(args)
      if (value === undefined) throw new Error(`unexpected git call: ${args.join(" ")}`)
      return value
    },
    async optionalText(_repo, args) {
      return answer(args)
    },
  }
}

const REF_AGES = new Map<string, number>()

function refLine(ref: string, agoMs: number, symref?: string): string {
  REF_AGES.set(ref, agoMs)
  const fullRef = ref.startsWith("origin/") ? `refs/remotes/${ref}` : ref
  return `${fullRef}\0${ref}\0${symref ?? ""}`
}

function reflogLine(fullRef: string, agoMs: number): string {
  return `${fullRef}@{${String(Math.floor((NOW - agoMs) / 1000))}}`
}

async function gitCommand(
  repo: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<Readonly<{ stdout: string; success: boolean }>> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) return { stdout: stderr.trim(), success: false }
  return { stdout: stdout.trim(), success: true }
}

const realGit: RefGit = {
  async text(repo, args) {
    const result = await gitCommand(repo, args)
    if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stdout}`)
    return result.stdout
  },
  async optionalText(repo, args) {
    const result = await gitCommand(repo, args)
    return result.success ? result.stdout : undefined
  },
}

describe("sweepUncarriedRefs", () => {
  it("refuses a malformed enumeration row instead of undercounting it", async () => {
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/task/valid", 40 * HOUR),
        "refs/remotes/origin/task/broken\0origin/task/broken",
      ].join("\n"),
    })

    await expect(sweepUncarriedRefs(git, OPTIONS)).rejects.toThrow(/malformed for-each-ref row.*broken/u)
  })

  it("limits the default population to authored refs", async () => {
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/HEAD", 40 * HOUR),
        refLine("origin/default", 40 * HOUR, "refs/remotes/origin/main"),
        refLine("origin/main", 40 * HOUR),
        refLine("origin/yrd/candidates/R123", 40 * HOUR),
        refLine("origin/task/authored", 40 * HOUR),
      ].join("\n"),
    })
    const authored: SweepOptions = {
      ...OPTIONS,
      authoredOnly: true,
    }

    const result = await sweepUncarriedRefs(git, authored)

    // This is the dashboard denominator. Counting the default branch, its
    // symbolic alias, or Queue's own candidates makes the rail describe Git
    // storage rather than author work.
    expect(result.scanned).toBe(1)
    expect(result.outsideAgeBound).toBe(1)

    const diagnostic = await sweepUncarriedRefs(git, OPTIONS)
    expect(diagnostic.scanned).toBe(5)
  })

  it("refuses to call an empty enumeration a clean sweep", async () => {
    const git = fakeGit({ "for-each-ref": "" })
    // A namespace that yields nothing is a broken sweep, and a rail that
    // reports it as "nothing stranded" is worse than one that is switched off:
    // it actively asserts health it never measured.
    await expect(sweepUncarriedRefs(git, OPTIONS)).rejects.toThrow(/enumerated no refs under 'refs\/remotes\/origin'/u)
  })

  it("reports the denominator alongside the findings", async () => {
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/task/carried", 2 * HOUR),
        refLine("origin/task/ancient", 40 * HOUR),
        refLine("origin/task/just-pushed", 60 * 1000),
      ].join("\n"),
    })

    const result = await sweepUncarriedRefs(git, {
      ...OPTIONS,
      carriedBranches: new Set(["task/carried"]), // as a change records it, without the remote
    })

    // Zero findings is only readable next to what produced it.
    expect(result.findings).toEqual([])
    expect(result.scanned).toBe(3)
    expect(result.carried).toBe(1)
    expect(result.outsideAgeBound).toBe(2) // too old, and inside the TTL grace
    expect(result.examined).toBe(0)
  })

  it("pays no per-ref git cost for refs the cheap filters already discarded", async () => {
    const git = fakeGit({
      "for-each-ref": [refLine("origin/task/carried", 2 * HOUR), refLine("origin/task/ancient", 40 * HOUR)].join("\n"),
    })

    await sweepUncarriedRefs(git, { ...OPTIONS, carriedBranches: new Set(["task/carried"]) })

    // One enumeration plus one aggregate reflog scan. Not ls-tree, rev-parse,
    // diff, or a clock process per ref — the ordering is the whole reason a
    // 2,000-ref sweep is affordable.
    expect(git.calls).toHaveLength(2)
    expect(git.calls[0]?.[0]).toBe("for-each-ref")
    expect(git.calls[1]?.slice(0, 2)).toEqual(["reflog", "show"])
  })

  it("actually examines a surviving ref and returns its finding", async () => {
    // The positive control, and it is not optional: every other case here
    // asserts a DISQUALIFY path, so a sweep that gathered nothing at all would
    // pass all of them. This is the only test that proves the sweep reaches
    // the gatherer and the predicate it exists to call.
    const git = fakeGit({
      "for-each-ref": refLine("origin/task/stranded", 3 * HOUR),
      "ls-tree": "160000 commit abc\tvendor/yrd",
      "rev-parse origin/task/stranded^{commit}": "deadbeefcafe",
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111\n- 2222222222222222222222222222222222222222",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.examined).toBe(1)
    expect(result.findings).toHaveLength(1)
    const [finding] = result.findings
    expect(finding?.ref).toBe("origin/task/stranded")
    expect(finding?.uniqueCommits).toBe(1)
    expect(finding?.equivalentCommits).toBe(1)
    // The split is reported rather than collapsed to a verdict: a ref that is
    // partly merged must not tell its author "unfinished" about work already
    // on trunk.
    expect(finding?.message).toContain("already applied")
  })

  it("judges refs against the swept namespace's own base, and names the baseline it used", async () => {
    // The habitant checkout's LOCAL main lags origin/main whenever nothing has
    // pulled — 18 stale commits inflated the fleet's uncarried count 2.2x
    // (@i/10-merge-queue/uncarried-stale-base). The refs being swept live in
    // refs/remotes/origin, so the remote's own base ref is the honest
    // yardstick: this ref's commits are all on origin/main (cherry is empty
    // there) while the stale local main still calls one commit unmerged.
    const git = fakeGit({
      "for-each-ref": refLine("origin/task/landed", 3 * HOUR),
      "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": "feedfacefeedfacefeedfacefeedfacefeedface",
      "ls-tree": "",
      "rev-parse origin/task/landed^{commit}": "deadbeefcafe",
      "diff --name-only refs/remotes/origin/main...origin/task/landed": "src/thing.ts",
      "cherry refs/remotes/origin/main origin/task/landed": "",
      // The stale-local-baseline answers, present so a regression that judges
      // against `main` again produces a finding and fails LOUDLY here.
      "diff --name-only main...origin/task/landed": "src/thing.ts",
      "cherry main origin/task/landed": "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.baseline).toBe("refs/remotes/origin/main")
    expect(result.examined).toBe(1)
    // Judged against the remote base the commits already landed on: no finding.
    expect(result.findings).toEqual([])
  })

  it("falls back to the local base name when the namespace has no base ref, and says so", async () => {
    const git = fakeGit({
      "for-each-ref": refLine("origin/task/stranded", 3 * HOUR),
      "ls-tree": "160000 commit abc\tvendor/yrd",
      "rev-parse origin/task/stranded^{commit}": "deadbeefcafe",
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    // fakeGit answers the baseline probe with undefined (no response key), so
    // the sweep must fall back to the caller's base — and still SAY which
    // yardstick produced the counts.
    expect(result.baseline).toBe("main")
    expect(result.findings).toHaveLength(1)
  })

  it("ages a newly observed ref from its reflog update rather than its old commit", async () => {
    const git = fakeGit({
      "for-each-ref": refLine("origin/task/old-commit-new-push", 40 * HOUR),
      "reflog show": [
        reflogLine("refs/remotes/origin/task/old-commit-new-push", 30 * 60_000),
        reflogLine("refs/remotes/origin/task/old-commit-new-pusher", 5 * 60_000),
        reflogLine("refs/remotes/origin/task/old-commit-new-push", 11 * 60_000),
      ].join("\n"),
      "ls-tree": "",
      "rev-parse origin/task/old-commit-new-push^{commit}": "deadbeefcafe",
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.findings).toMatchObject([
      {
        ref: "origin/task/old-commit-new-push",
        ageMs: 11 * 60_000,
      },
    ])
    expect(result.missingUpdateClocks).toBe(0)
  })

  it("surfaces a missing retained reflog without minting a TTL finding", async () => {
    const git = fakeGit({
      "for-each-ref": refLine("origin/task/legacy", 3 * HOUR),
      "reflog show": "",
      "ls-tree": "",
      "rev-parse origin/task/legacy^{commit}": "deadbeefcafe",
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    // A commit clock cannot prove when this clone observed the ref. Keep the
    // coverage gap loud, but never mint an actionable TTL finding from it.
    expect(result.findings).toEqual([])
    expect(result.missingUpdateClocks).toBe(1)
  })

  it("refuses malformed reflog output instead of silently losing clock coverage", async () => {
    const git = fakeGit({
      "for-each-ref": refLine("origin/task/stranded", 3 * HOUR),
      "reflog show": "refs/remotes/origin/task/stranded@{not-a-date}",
    })

    await expect(sweepUncarriedRefs(git, OPTIONS)).rejects.toThrow(/malformed reflog row/u)
  })

  it("refuses an empty reflog timestamp instead of treating it as epoch zero", async () => {
    const emptyReflogClock = fakeGit({
      "for-each-ref": refLine("origin/task/stranded", 3 * HOUR),
      "reflog show": "refs/remotes/origin/task/stranded@{}",
    })
    await expect(sweepUncarriedRefs(emptyReflogClock, OPTIONS)).rejects.toThrow(/malformed reflog row/u)
  })

  it("reads Git's real full-ref reflog selector format", async () => {
    const repo = await mkdtemp(join(tmpdir(), "yrd-uncarried-clock-"))
    try {
      expect((await gitCommand(repo, ["init", "-b", "main"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "user.name", "Yrd Test"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "user.email", "yrd@example.test"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "core.logAllRefUpdates", "true"])).success).toBe(true)
      await writeFile(join(repo, "base.txt"), "base\n", "utf8")
      expect((await gitCommand(repo, ["add", "base.txt"])).success).toBe(true)
      const oldClock = `${String(Math.floor((NOW - 40 * HOUR) / 1000))} +0000`
      expect(
        (
          await gitCommand(repo, ["commit", "-m", "base"], {
            GIT_AUTHOR_DATE: oldClock,
            GIT_COMMITTER_DATE: oldClock,
          })
        ).success,
      ).toBe(true)
      const base = (await gitCommand(repo, ["rev-parse", "HEAD"])).stdout
      await writeFile(join(repo, "change.txt"), "change\n", "utf8")
      expect((await gitCommand(repo, ["add", "change.txt"])).success).toBe(true)
      expect(
        (
          await gitCommand(repo, ["commit", "-m", "change"], {
            GIT_AUTHOR_DATE: oldClock,
            GIT_COMMITTER_DATE: oldClock,
          })
        ).success,
      ).toBe(true)
      const tip = (await gitCommand(repo, ["rev-parse", "HEAD"])).stdout
      expect((await gitCommand(repo, ["update-ref", "refs/heads/main", base, tip])).success).toBe(true)
      const observedClock = `${String(Math.floor((NOW - 11 * 60_000) / 1000))} +0000`
      expect(
        (
          await gitCommand(repo, ["update-ref", "--create-reflog", "refs/remotes/origin/task/clock", tip], {
            GIT_COMMITTER_DATE: observedClock,
          })
        ).success,
      ).toBe(true)

      const result = await sweepUncarriedRefs(realGit, { ...OPTIONS, repo })

      expect(result.findings).toMatchObject([{ ref: "origin/task/clock", ageMs: 11 * 60_000 }])
      expect(result.findings[0]?.message).toContain("observed locally 11m ago")
      expect(result.missingUpdateClocks).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("matches a change's branch name against a remote-prefixed ref", async () => {
    // The bug this pins was invisible to every other test here, because their
    // fixtures used the same string on both sides. Real data does not:
    // %(refname:short) yields "origin/task/x" and a change records
    // "task/x". Measured on the live fleet before the fix — 4,784 refs scanned,
    // 7 recognised as carried, against 810 live changes. The rail's
    // first real run reported carried work as stranded.
    const git = fakeGit({ "for-each-ref": refLine("origin/task/carried", 3 * HOUR) })
    const result = await sweepUncarriedRefs(git, {
      ...OPTIONS,
      carriedBranches: new Set(["task/carried"]),
    })
    expect(result.carried).toBe(1)
    expect(result.examined).toBe(0)
    expect(git.calls).toHaveLength(1)
  })

  it("survives a branch name containing a space", async () => {
    // %00 rather than a space separator: a space-split silently truncates such
    // a ref to its first word and then judges a branch that does not exist.
    const git = fakeGit({ "for-each-ref": refLine("origin/task/two words", 40 * HOUR) })
    const result = await sweepUncarriedRefs(git, OPTIONS)
    expect(result.scanned).toBe(1)
    expect(result.outsideAgeBound).toBe(1)
  })

  it("collapses a revision series to its newest revision and says what it absorbed", async () => {
    // THE noise case, measured 2026-08-14 on the live fleet: 129 findings, of
    // which 62 were earlier `-rN` revisions of a series whose newer revision
    // was flagged too. Every one of these three revisions is uncarried, past
    // the TTL, inside the age bound and holds unmerged commits — so without the
    // collapse this sweep reports all three, and an operator pages three times
    // on one piece of work whose only live revision is `-r3`.
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/task/thing-dev3-r1", 5 * HOUR),
        refLine("origin/task/thing-dev3-r2", 4 * HOUR),
        refLine("origin/task/thing-dev3-r3", 3 * HOUR),
      ].join("\n"),
      "ls-tree": "",
      "rev-parse origin/task/thing-dev3-r1^{commit}": "1".repeat(40),
      "rev-parse origin/task/thing-dev3-r2^{commit}": "2".repeat(40),
      "rev-parse origin/task/thing-dev3-r3^{commit}": "3".repeat(40),
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.findings).toHaveLength(1)
    const [finding] = result.findings
    expect(finding?.ref).toBe("origin/task/thing-dev3-r3")
    expect(finding?.absorbedRevisions).toBe(2)
    expect(finding?.message).toContain("supersedes 2 earlier revisions of the same series")
    expect(result.superseded).toBe(2)
    // Collapsed BEFORE the gatherer, so the dead revisions cost no diff, no
    // cherry and no rev-parse — and each ref still merges in exactly one bucket.
    expect(result.examined).toBe(1)
    expect(result.scanned).toBe(
      result.carried + result.superseded + result.missingUpdateClocks + result.outsideAgeBound + result.examined,
    )
  })

  it("lets a carried newest revision suppress its own stranded ancestors", async () => {
    // A change on `-r2` is the strongest evidence `-r1` is spent: the
    // work moved on and something already tracks it. Looking for the superseder
    // only among UNCARRIED refs would resurrect exactly the row this deletes.
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/task/thing-dev3-r1", 5 * HOUR),
        refLine("origin/task/thing-dev3-r2", 3 * HOUR),
      ].join("\n"),
    })

    const result = await sweepUncarriedRefs(git, { ...OPTIONS, carriedBranches: new Set(["task/thing-dev3-r2"]) })

    expect(result.findings).toEqual([])
    expect(result.carried).toBe(1)
    expect(result.superseded).toBe(1)
    // A carried sibling is counted as carried, never as something a row
    // absorbed — one ref, one bucket.
    expect(result.examined).toBe(0)
  })

  it("passes a name outside the -rN convention through as its own series", async () => {
    // `-r12-source` and `-r12-currentpin` both stand on this remote, where the
    // trailing word names a VARIANT rather than a revision. Reading a revision
    // out of the middle of a name would collapse two distinct artifacts into
    // each other and delete a live row — a worse failure than the noise.
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/task/thing-agent1-r11-source", 5 * HOUR),
        refLine("origin/task/thing-agent1-r12-source", 4 * HOUR),
        refLine("origin/task/plain-name", 3 * HOUR),
      ].join("\n"),
      "ls-tree": "",
      "rev-parse origin/task/thing-agent1-r11-source^{commit}": "1".repeat(40),
      "rev-parse origin/task/thing-agent1-r12-source^{commit}": "2".repeat(40),
      "rev-parse origin/task/plain-name^{commit}": "3".repeat(40),
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.superseded).toBe(0)
    expect(result.findings.map((finding) => finding.ref)).toEqual([
      "origin/task/thing-agent1-r11-source",
      "origin/task/thing-agent1-r12-source",
      "origin/task/plain-name",
    ])
    expect(result.findings.every((finding) => finding.absorbedRevisions === 0)).toBe(true)
  })

  it("orders revisions by number rather than by name", async () => {
    // `"9" > "10"` as strings, so a lexicographic winner keeps r9 and suppresses
    // the live r10 — the collapse would then delete the only row that mattered.
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/task/thing-dev3-r9", 5 * HOUR),
        refLine("origin/task/thing-dev3-r10", 3 * HOUR),
      ].join("\n"),
      "ls-tree": "",
      "rev-parse origin/task/thing-dev3-r10^{commit}": "1".repeat(40),
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.findings.map((finding) => finding.ref)).toEqual(["origin/task/thing-dev3-r10"])
    expect(result.superseded).toBe(1)
  })
})

describe("a ref with no shared ancestry is one unenumerable ROW, not a dead sweep", () => {
  /** Git's canonical empty tree, so an orphan commit can be minted without
   * touching the working tree or the index. */
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

  it("returns every other row AND names the ref it could not enumerate", async () => {
    // Specimen: a state-repo branch pushed onto the CODE remote — 1,455 commits
    // of hab lease records sharing no ancestry with main. `git diff a...b`
    // across unrelated histories is a hard 128, not an empty diff, so this ONE
    // row used to abort the whole command fleet-wide and left 12 CRITICAL pages
    // unverifiable. A fixture of well-formed refs cannot fail for this.
    //
    // The real specimen was `rescue/state-hab-launch`, and the archive
    // exemption now intercepts that name before the merge-base probe ever runs
    // — proven by the sibling test below. This fixture therefore carries the
    // same orphan under an ORDINARY name, because what it guards is unrelated
    // histories, not a namespace, and a fixture that the exemption swallows
    // would leave the git-128 path with no test at all.
    const repo = await mkdtemp(join(tmpdir(), "yrd-uncarried-unrelated-"))
    try {
      const clock = `${String(Math.floor((NOW - 40 * HOUR) / 1000))} +0000`
      const dates = { GIT_AUTHOR_DATE: clock, GIT_COMMITTER_DATE: clock }
      expect((await gitCommand(repo, ["init", "-b", "main"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "user.name", "Yrd Test"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "user.email", "yrd@example.test"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "core.logAllRefUpdates", "true"])).success).toBe(true)
      await writeFile(join(repo, "base.txt"), "base\n", "utf8")
      expect((await gitCommand(repo, ["add", "base.txt"])).success).toBe(true)
      expect((await gitCommand(repo, ["commit", "-m", "base"], dates)).success).toBe(true)
      const base = (await gitCommand(repo, ["rev-parse", "HEAD"])).stdout
      await writeFile(join(repo, "change.txt"), "change\n", "utf8")
      expect((await gitCommand(repo, ["add", "change.txt"])).success).toBe(true)
      expect((await gitCommand(repo, ["commit", "-m", "change"], dates)).success).toBe(true)
      const tip = (await gitCommand(repo, ["rev-parse", "HEAD"])).stdout
      expect((await gitCommand(repo, ["update-ref", "refs/heads/main", base, tip])).success).toBe(true)

      // The unrelated history: a commit with NO parent, so it shares not one
      // object of ancestry with main. This is what makes merge-base empty.
      const orphan = await gitCommand(repo, ["commit-tree", EMPTY_TREE, "-m", "lease records"], dates)
      expect(orphan.success).toBe(true)
      const orphanSha = orphan.stdout
      expect((await gitCommand(repo, ["merge-base", "main", orphanSha])).success).toBe(false)

      const observed = `${String(Math.floor((NOW - HOUR) / 1000))} +0000`
      for (const [ref, sha] of [
        ["refs/remotes/origin/task/ordinary", tip],
        ["refs/remotes/origin/task/state-hab-launch", orphanSha],
      ] as const) {
        expect(
          (await gitCommand(repo, ["update-ref", "--create-reflog", ref, sha], { GIT_COMMITTER_DATE: observed }))
            .success,
        ).toBe(true)
      }

      const result = await sweepUncarriedRefs(realGit, { ...OPTIONS, repo })

      // The whole point: the good row survives the bad one.
      expect(result.findings.map((finding) => finding.ref)).toEqual(["origin/task/ordinary"])
      expect(result.skipped).toMatchObject([{ ref: "origin/task/state-hab-launch", tipSha: orphanSha }])
      expect(result.skipped[0]?.reason).toContain("no merge base")
      // Named, not merely counted — a silent skip is an under-count, which is
      // strictly worse than the crash it replaced.
      expect(result.skipped[0]?.ref).toContain("state-hab-launch")

      // The skipped ref is the GAP, never the coverage.
      expect(result.examined).toBe(1)
      expect(result.measurable).toBe(result.outsideAgeBound + 1)

      // Derived a second way: every ref merges in exactly one bucket.
      expect(result.scanned).toBe(
        result.carried +
          result.exempted.length +
          result.superseded +
          result.missingUpdateClocks +
          result.outsideAgeBound +
          result.examined +
          result.skipped.length,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it("exempts an ARCHIVE ref with unrelated histories instead of paying the git 128", async () => {
    // The production specimen, under its real name. Before the exemption this
    // ref reached the merge-base probe and was reported as an unenumerable GAP
    // every sweep, forever — a permanent hole in the coverage denominator for a
    // branch that was doing exactly what it was written to do.
    const repo = await mkdtemp(join(tmpdir(), "yrd-uncarried-archive-orphan-"))
    try {
      const clock = `${String(Math.floor((NOW - 40 * HOUR) / 1000))} +0000`
      const dates = { GIT_AUTHOR_DATE: clock, GIT_COMMITTER_DATE: clock }
      expect((await gitCommand(repo, ["init", "-b", "main"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "user.name", "Yrd Test"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "user.email", "yrd@example.test"])).success).toBe(true)
      expect((await gitCommand(repo, ["config", "core.logAllRefUpdates", "true"])).success).toBe(true)
      await writeFile(join(repo, "base.txt"), "base\n", "utf8")
      expect((await gitCommand(repo, ["add", "base.txt"])).success).toBe(true)
      expect((await gitCommand(repo, ["commit", "-m", "base"], dates)).success).toBe(true)

      const orphan = await gitCommand(repo, ["commit-tree", EMPTY_TREE, "-m", "lease records"], dates)
      expect(orphan.success).toBe(true)
      expect((await gitCommand(repo, ["merge-base", "main", orphan.stdout])).success).toBe(false)

      const observed = `${String(Math.floor((NOW - HOUR) / 1000))} +0000`
      expect(
        (
          await gitCommand(
            repo,
            ["update-ref", "--create-reflog", "refs/remotes/origin/rescue/state-hab-launch", orphan.stdout],
            { GIT_COMMITTER_DATE: observed },
          )
        ).success,
      ).toBe(true)

      const result = await sweepUncarriedRefs(realGit, { ...OPTIONS, repo })

      // Exempted by policy, not skipped as a fault: the sweep never tried, so
      // this is not a hole in what it could measure.
      expect(result.exempted).toMatchObject([
        { ref: "origin/rescue/state-hab-launch", disposition: "archive", ageMs: HOUR },
      ])
      expect(result.skipped).toEqual([])
      expect(result.findings).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("policy exemptions", () => {
  // The rail's failure mode is not a missed ref; it is a reader who stopped
  // opening it. @ci's pager reached 36 unread rows
  // (@i/10-merge-queue/23091-pager-rail-unread) while these refs paged
  // nightly about work that was never going anywhere.
  it("exempts the archive namespaces instead of paging on them forever", async () => {
    // preserve/ is the sharpest specimen: a preservation ref exists so its
    // work is NOT carried, so a stranded finding on it is true by construction
    // and would page until someone stops reading the rail.
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/rescue/kernel-docs", 3 * HOUR),
        refLine("origin/preserve/migration-guard-wip", 3 * HOUR),
        refLine("origin/task/stranded", 3 * HOUR),
      ].join("\n"),
      "ls-tree": "160000 commit abc\tvendor/yrd",
      "rev-parse origin/task/stranded^{commit}": "deadbeefcafe",
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    // The archive refs never become findings, and the ordinary one still does:
    // an exemption that also swallowed real work would be the worse bug.
    expect(result.findings.map((finding) => finding.ref)).toEqual(["origin/task/stranded"])
    expect(result.exempted).toMatchObject([
      { ref: "origin/rescue/kernel-docs", disposition: "archive" },
      { ref: "origin/preserve/migration-guard-wip", disposition: "archive" },
    ])
  })

  it("keeps every exempted ref AGED, not merely counted", async () => {
    const git = fakeGit({ "for-each-ref": refLine("origin/rescue/kernel-docs", 5 * HOUR) })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    // A bare count says the class exists; it cannot say the class is growing,
    // which is the only question that would make anyone act on it.
    expect(result.exempted).toHaveLength(1)
    expect(result.exempted[0]?.ageMs).toBe(5 * HOUR)
  })

  it("pays no per-ref git cost for an exempted ref", async () => {
    const git = fakeGit({ "for-each-ref": refLine("origin/rescue/kernel-docs", 3 * HOUR) })

    await sweepUncarriedRefs(git, OPTIONS)

    // One enumeration plus one aggregate reflog scan — the exemption is a
    // name test, so it belongs with the cheap disqualifiers and must not
    // reintroduce the per-ref cost the module's ordering exists to avoid.
    expect(git.calls).toHaveLength(2)
    expect(git.calls[0]?.[0]).toBe("for-each-ref")
    expect(git.calls[1]?.slice(0, 2)).toEqual(["reflog", "show"])
  })

  it("retires a ref whose author declared it harvested", async () => {
    const git = fakeGit({ "for-each-ref": refLine("origin/task/bead-bodies-ci-r1", 3 * HOUR) })

    const result = await sweepUncarriedRefs(git, {
      ...OPTIONS,
      // Recorded as a change records a branch: without the remote prefix.
      retiredRefs: new Set(["task/bead-bodies-ci-r1"]),
    })

    // Retire means STOP TRACKING IT AS UNCARRIED, never delete the ref — the
    // fleet-wide halt on ref deletion is untouched by this mechanism.
    expect(result.findings).toEqual([])
    expect(result.exempted).toMatchObject([{ ref: "origin/task/bead-bodies-ci-r1", disposition: "retired" }])
  })

  it("counts a carried archive ref as carried, so no ref merges in two buckets", async () => {
    const git = fakeGit({ "for-each-ref": refLine("origin/rescue/kernel-docs", 3 * HOUR) })

    const result = await sweepUncarriedRefs(git, {
      ...OPTIONS,
      carriedBranches: new Set(["rescue/kernel-docs"]),
    })

    // A ref something already decided about is decided, whatever it is named.
    expect(result.carried).toBe(1)
    expect(result.exempted).toEqual([])
  })

  it("keeps the totals identity closed over the new bucket", async () => {
    const git = fakeGit({
      "for-each-ref": [
        refLine("origin/rescue/kernel-docs", 3 * HOUR),
        refLine("origin/task/carried", 3 * HOUR),
        refLine("origin/task/ancient", 40 * HOUR),
        refLine("origin/task/stranded", 3 * HOUR),
      ].join("\n"),
      "ls-tree": "160000 commit abc\tvendor/yrd",
      "rev-parse origin/task/stranded^{commit}": "deadbeefcafe",
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, { ...OPTIONS, carriedBranches: new Set(["task/carried"]) })

    // Derived a second way. An exclusion outside the identity is how a
    // disclosed count silently becomes an undisclosed one.
    expect(result.scanned).toBe(
      result.carried +
        result.exempted.length +
        result.superseded +
        result.missingUpdateClocks +
        result.outsideAgeBound +
        result.examined +
        result.skipped.length,
    )
    expect(result.exempted).toHaveLength(1)
    expect(result.examined).toBe(1)
  })

  it("never counts an exempted ref as coverage", async () => {
    const git = fakeGit({ "for-each-ref": refLine("origin/rescue/kernel-docs", 3 * HOUR) })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    // Exempted refs were never this rail's to measure. Counting them would
    // flatter the coverage with refs it deliberately declined to judge —
    // the same reason `carried` and `superseded` stay out of `measurable`.
    expect(result.measurable).toBe(0)
  })

  it("host finding filter drops in-force refs after the sweep, never through retiredRefs", () => {
    const findings = [
      { ref: "origin/feat/one-repo-root-resolver-v2", message: "rescue" },
      { ref: "origin/task/live-work", message: "rescue" },
    ]
    const out = applyHostFindingFilter(findings, (rows) => ({
      findings: rows.filter((row) => row.ref !== "origin/feat/one-repo-root-resolver-v2"),
      exemptionLines: [
        "EXEMPTED  origin/feat/one-repo-root-resolver-v2  held-by-ruling  store @yrd/uncarried-dispositions.md  ruling:: 6acb3bf6",
      ],
    }))
    expect(out.findings.map((row) => row.ref)).toEqual(["origin/task/live-work"])
    expect(out.exemptionLines[0]).toMatch(/ruling:: 6acb3bf6/)
    expect(applyHostFindingFilter(findings).findings).toEqual(findings)
  })
})
