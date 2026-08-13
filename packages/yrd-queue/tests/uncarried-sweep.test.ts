/**
 * @failure The uncarried sweep stops enumerating, reports an empty result it
 *          cannot justify, or pays per-ref git cost for refs it will discard.
 * @level   l1
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { describe, expect, it } from "vitest"
import { sweepUncarriedRefs, type SweepOptions } from "../src/uncarried-sweep.ts"
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
    if (args.join(" ").startsWith("reflog show")) {
      return (responses["for-each-ref"] ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const separator = line.lastIndexOf("\0")
          return `${line.slice(0, separator)}@{${line.slice(separator + 1)}}`
        })
        .join("\n")
    }
    return undefined
  }
  return {
    calls,
    async run(_repo, args) {
      const value = answer(args)
      if (value === undefined) throw new Error(`unexpected git call: ${args.join(" ")}`)
      return value
    },
    async optional(_repo, args) {
      return answer(args)
    },
  }
}

function refLine(ref: string, agoMs: number): string {
  return `${ref}\0${Math.floor((NOW - agoMs) / 1000)}`
}

function reflogLine(ref: string, agoMs: number): string {
  return `${ref}@{${Math.floor((NOW - agoMs) / 1000)}}`
}

describe("sweepUncarriedRefs", () => {
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
      carriedBranches: new Set(["task/carried"]), // as a merge request records it, without the remote
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

    // Two aggregate processes total: enumeration plus one reflog scan. Not
    // ls-tree, rev-parse, or diff per ref — the ordering is the whole reason a
    // 2,000-ref sweep remains affordable.
    expect(git.calls).toHaveLength(2)
    expect(git.calls[0]?.[0]).toBe("for-each-ref")
    expect(git.calls[1]?.[0]).toBe("reflog")
  })

  it("limits the default rail to authored refs without hiding the excluded denominator", async () => {
    const git = fakeGit({
      "for-each-ref": [
        refLine("refs/remotes/origin/HEAD", 3 * HOUR),
        refLine("refs/remotes/origin/main", 3 * HOUR),
        refLine("refs/remotes/origin/yrd/candidates/C1", 3 * HOUR),
        refLine("refs/remotes/origin/task/carried", 3 * HOUR),
      ].join("\n"),
    })

    const result = await sweepUncarriedRefs(git, {
      ...OPTIONS,
      population: "authored",
      carriedBranches: new Set(["task/carried"]),
    })

    expect(result).toMatchObject({ scanned: 4, excluded: 3, carried: 1, examined: 0 })
    expect(git.calls).toHaveLength(1)
    expect(git.calls[0]).toContain("--format=%(refname)%00%(committerdate:unix)")
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
      "log -1": String(Math.floor((NOW - 3 * HOUR) / 1000)),
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
    // partly landed must not tell its author "unfinished" about work already
    // on trunk.
    expect(finding?.message).toContain("already applied")
  })

  it("ages a newly observed ref from its reflog update rather than its old commit", async () => {
    const git = fakeGit({
      "for-each-ref": refLine("refs/remotes/origin/task/old-commit-new-push", 40 * HOUR),
      "reflog show": reflogLine("refs/remotes/origin/task/old-commit-new-push", 11 * 60_000),
      "ls-tree": "",
      "rev-parse refs/remotes/origin/task/old-commit-new-push^{commit}": "deadbeefcafe",
      "log -1": String(Math.floor((NOW - 40 * HOUR) / 1000)),
      "diff --name-only": "src/thing.ts",
      cherry: "+ 1111111111111111111111111111111111111111",
    })

    const result = await sweepUncarriedRefs(git, OPTIONS)

    expect(result.findings).toMatchObject([
      {
        ref: "refs/remotes/origin/task/old-commit-new-push",
        ageMs: 11 * 60_000,
      },
    ])
  })

  it("matches a merge request's branch name against a remote-prefixed ref", async () => {
    // The bug this pins was invisible to every other test here, because their
    // fixtures used the same string on both sides. Real data does not:
    // %(refname:short) yields "origin/task/x" and a merge request records
    // "task/x". Measured on the live fleet before the fix — 4,784 refs scanned,
    // 7 recognised as carried, against 810 live merge requests. The rail's
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
})
