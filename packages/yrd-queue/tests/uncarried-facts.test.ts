/**
 * @failure The sweep's fact gatherer compares a pin the ref never touched, runs
 * a component query in the superproject where the objects are unreadable, or
 * reports a git failure as a direction.
 * @level l1
 * @consumer @yrd/queue
 *
 * Every case here is a way one of two seats got this wrong on 2026-08-10. The
 * gatherer is the only part of the sweep that touches git, so these are the
 * mistakes that cannot be caught by testing the predicate.
 */
import { describe, expect, it } from "vitest"
import { gatherPushedRefFact, type RefGit } from "../src/uncarried-facts.ts"

const BASE = "origin/main"
const REPO = "/repo"

/** A scripted git: exact argv match, so an unasked-for question throws rather
 * than silently returning a default that a test would then assert on. */
function scriptedGit(responses: Record<string, string | undefined>): RefGit {
  const key = (repo: string, args: readonly string[]): string => `${repo} ${args.join(" ")}`
  return {
    async run(repo, args) {
      const value = responses[key(repo, args)]
      if (value === undefined) throw new Error(`unscripted git: ${key(repo, args)}`)
      return value
    },
    async optional(repo, args) {
      return responses[key(repo, args)]
    },
  }
}

const BASELINE = {
  [`${REPO} rev-parse task/x^{commit}`]: "a".repeat(40),
  [`${REPO} cherry ${BASE} task/x`]: "+ 1111111",
} as const

const OPTIONS = {
  repo: REPO,
  base: BASE,
  observedAtMs: 1_786_000_000_000,
  carriedBranches: new Set<string>(),
  gitlinkPaths: new Set(["vendor/yrd", "km"]),
  absorbedRevisions: 0,
}

describe("gatherPushedRefFact", () => {
  it("classifies a ref whose whole diff is gitlinks as gitlink-only", async () => {
    const git = scriptedGit({
      ...BASELINE,
      [`${REPO} diff --name-only ${BASE}...task/x`]: "vendor/yrd",
      [`${REPO} rev-parse ${BASE}:vendor/yrd`]: "b".repeat(40),
      [`${REPO} rev-parse task/x:vendor/yrd`]: "c".repeat(40),
      [`${REPO}/vendor/yrd merge-base --is-ancestor ${"b".repeat(40)} ${"c".repeat(40)}`]: "",
    })
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.payloadKind).toBe("gitlink-only")
    expect(fact.pinDirection).toBe("forward")
  })

  it("calls a mixed diff content, not gitlink-only", async () => {
    const git = scriptedGit({
      ...BASELINE,
      [`${REPO} diff --name-only ${BASE}...task/x`]: "vendor/yrd\nsrc/app.ts",
      [`${REPO} rev-parse ${BASE}:vendor/yrd`]: "b".repeat(40),
      [`${REPO} rev-parse task/x:vendor/yrd`]: "b".repeat(40),
    })
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.payloadKind).toBe("content")
    expect(fact.pinDirection).toBe("aligned")
  })

  // THE FALSE-ALARM CASE, and the reason the contract exists. @fable/0's
  // rescue-breadcrumb-compact recorded a vendor/yrd pin four commits behind
  // trunk's while never touching that path. Comparing the recorded pin invents
  // a revert; git's three-way merge keeps trunk's side and merges clean.
  it("IGNORES a gitlink the ref never modified, however stale its recorded pin", async () => {
    const git = scriptedGit({
      ...BASELINE,
      // The ref touches silvery only. vendor/yrd is NOT in the diff, so its
      // recorded pin must never be consulted — and no rev-parse for it is
      // scripted, so consulting it would throw.
      [`${REPO} diff --name-only ${BASE}...task/x`]: "vendor/silvery",
    })
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.pinDirection).toBe("none")
    // vendor/silvery is not in gitlinkPaths, so this is a content payload.
    expect(fact.payloadKind).toBe("content")
  })

  it("reports DIVERGED when neither pin contains the other", async () => {
    const git = scriptedGit({
      ...BASELINE,
      [`${REPO} diff --name-only ${BASE}...task/x`]: "vendor/yrd",
      [`${REPO} rev-parse ${BASE}:vendor/yrd`]: "b".repeat(40),
      [`${REPO} rev-parse task/x:vendor/yrd`]: "c".repeat(40),
      // Neither ancestry query answers — both absent from the script means both
      // exited non-zero, which is git's way of saying "not an ancestor".
    })
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.pinDirection).toBe("diverged")
  })

  // A MISSING OBJECT IS NOT A DIRECTION. This is the exact shape that produced
  // two wrong verdicts in one evening: merge-tree's "could not read the object"
  // read as "these conflict", and an error string read as a stale pin.
  it("never reports a cheerful direction when a pin cannot be resolved", async () => {
    const git = scriptedGit({
      ...BASELINE,
      [`${REPO} diff --name-only ${BASE}...task/x`]: "vendor/yrd",
      [`${REPO} rev-parse ${BASE}:vendor/yrd`]: "b".repeat(40),
      // branch pin unresolvable
    })
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.pinDirection).toBe("diverged")
    expect(fact.pinDirection).not.toBe("aligned")
  })

  it("takes the WORST direction across several components", async () => {
    const git = scriptedGit({
      ...BASELINE,
      [`${REPO} diff --name-only ${BASE}...task/x`]: "vendor/yrd\nkm",
      [`${REPO} rev-parse ${BASE}:vendor/yrd`]: "b".repeat(40),
      [`${REPO} rev-parse task/x:vendor/yrd`]: "c".repeat(40),
      [`${REPO}/vendor/yrd merge-base --is-ancestor ${"b".repeat(40)} ${"c".repeat(40)}`]: "",
      [`${REPO} rev-parse ${BASE}:km`]: "d".repeat(40),
      [`${REPO} rev-parse task/x:km`]: "e".repeat(40),
      [`${REPO}/km merge-base --is-ancestor ${"e".repeat(40)} ${"d".repeat(40)}`]: "",
    })
    // vendor/yrd is forward, km is backward. Backward wins: one rolled-back pin
    // is enough to make the ref unsafe to carry as-is.
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.pinDirection).toBe("backward")
  })

  it("splits cherry output into unique and already-applied", async () => {
    const git = scriptedGit({
      ...BASELINE,
      [`${REPO} cherry ${BASE} task/x`]: "+ 111\n- 222\n+ 333",
      [`${REPO} diff --name-only ${BASE}...task/x`]: "src/app.ts",
    })
    const fact = await gatherPushedRefFact(git, "task/x", OPTIONS)
    expect(fact.uniqueCommits).toBe(2)
    expect(fact.equivalentCommits).toBe(1)
  })

  it("marks a ref that already has a carrier", async () => {
    const git = scriptedGit({ ...BASELINE, [`${REPO} diff --name-only ${BASE}...task/x`]: "src/app.ts" })
    const fact = await gatherPushedRefFact(git, "task/x", { ...OPTIONS, carriedBranches: new Set(["task/x"]) })
    expect(fact.carried).toBe(true)
  })
})
