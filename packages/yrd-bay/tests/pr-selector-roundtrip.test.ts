/**
 * @failure Yrd prints a revision-qualified PR identity that its own selector
 * resolver rejects, aliases to the current revision, or permits a mutating
 * verb to target through a historical revision.
 * @level l2
 * @consumer @yrd/bay selector and formatter boundary
 */
import { describe, expect, it } from "vitest"
import {
  formatPRRevisionSelector,
  normalizeBranchSelector,
  parsePRSelector,
  requireLivePR,
  resolvePRMatch,
  type BaysState,
  type PR,
} from "../src/model.ts"

const revisions = [
  { n: 1, head: "1".repeat(40), base: "main", pushedAt: "2026-08-01T00:00:00.000Z" },
  { n: 16, head: "f".repeat(40), base: "main", pushedAt: "2026-08-06T00:00:00.000Z" },
] as const

const pr: PR = {
  id: "PR1410",
  branch: "topic/round-trip",
  base: "main",
  state: "open",
  merged: false,
  revs: revisions,
  reviews: [],
  comments: [],
  checkRequests: [],
}

const state: BaysState = { byId: {}, prs: { [pr.id]: pr }, receipts: {} }

describe("displayed PR selector round trip", () => {
  it.each([
    ["pr#1410.16", { pr: "PR1410", revision: 16 }],
    ["PR1410.16", { pr: "PR1410", revision: 16 }],
    ["pr1410.16", { pr: "PR1410", revision: 16 }],
    ["pr#1410", { pr: "PR1410" }],
    ["PR1410", { pr: "PR1410" }],
    ["pr1410", { pr: "PR1410" }],
    ["1410", { pr: "PR1410" }],
    ["1410.16", { pr: "PR1410", revision: 16 }],
  ] as const)("parses %s without guessing", (selector, expected) => {
    expect(parsePRSelector(selector)).toEqual(expected)
  })

  // A remote-qualified selector submits and lands fine, then cannot be recut,
  // because the stored branch is re-prefixed into refs/heads/origin/<branch>.
  // The defect surfaces only on the recovery path, which is why seven cases
  // above never caught it: none of them names a remote.
  it.each([
    ["origin/task/thing", "task/thing"],
    ["task/thing", "task/thing"],
    // Deeply nested branch names keep every segment after the qualifier.
    ["origin/task/@tent/tooling/22660-rail", "task/@tent/tooling/22660-rail"],
    // A non-origin remote is stripped by NAME, not by a hardcoded literal.
    ["upstream/topic/x", "topic/x"],
    // Only the LEADING qualifier goes; an inner segment is part of the branch.
    ["task/origin/x", "task/origin/x"],
    // A branch genuinely named after a remote that is not configured survives.
    ["fork/topic/y", "fork/topic/y"],
    // A bare qualifier is not a branch; returning "" would be a confident wrong
    // answer, so the selector is left alone for the caller to reject.
    ["origin/", "origin/"],
  ] as const)("normalizes %s to a single stored form", (selector, expected) => {
    expect(normalizeBranchSelector(selector, ["origin", "upstream"])).toBe(expected)
  })

  it("stores the same branch whether or not the operator qualified it", () => {
    const remotes = ["origin"]
    expect(normalizeBranchSelector("origin/task/thing", remotes)).toBe(normalizeBranchSelector("task/thing", remotes))
  })

  it("keeps a bare non-numeric token out of the PR grammar (branch/name aliases stay reachable)", () => {
    expect(parsePRSelector("topic/round-trip")).toBeUndefined()
    expect(parsePRSelector("fix-thing")).toBeUndefined()
  })

  it("accepts the bare numeric id every operator types after reading pr#1410.16 (I23 selector uniformity)", () => {
    expect(resolvePRMatch(state, "1410")?.value).toBe(pr)
    expect(resolvePRMatch(state, "1410.16")?.revision).toBe(revisions[1])
    expect(requireLivePR(state, "1410")).toBe(pr)
  })

  it("falls back to branch/name aliases when a bare numeric names no PR", () => {
    const branchNumeric: PR = { ...pr, id: "PR7", branch: "9999" }
    const numericState: BaysState = { byId: {}, prs: { [branchNumeric.id]: branchNumeric }, receipts: {} }
    expect(resolvePRMatch(numericState, "9999")?.value).toBe(branchNumeric)
  })

  it("feeds the canonical renderer output back to the exact retained revision", () => {
    const displayed = formatPRRevisionSelector(pr.id, revisions[1])
    const resolved = resolvePRMatch(state, displayed)

    expect(displayed).toBe("pr#1410.16")
    expect(resolved?.value).toBe(pr)
    expect(resolved?.revision).toBe(revisions[1])
  })

  it("keeps a bare selector PR-scoped and rejects an unknown retained revision", () => {
    expect(resolvePRMatch(state, "pr#1410")?.revision).toBeUndefined()
    expect(resolvePRMatch(state, "pr#1410.99")).toBeUndefined()
  })

  it("shows a copy-pasteable accepted form when a PR-shaped selector is malformed", () => {
    expect(() => requireLivePR(state, "pr#1410.bad")).toThrow("accepted form: pr#1410.16")
  })

  it("allows the current qualified revision but refuses historical mutation", () => {
    expect(requireLivePR(state, "pr#1410.16")).toBe(pr)
    expect(() => requireLivePR(state, "pr#1410.1")).toThrow(
      "PR 'PR1410' selector targets historical revision 1; current revision is 16",
    )
  })
})
