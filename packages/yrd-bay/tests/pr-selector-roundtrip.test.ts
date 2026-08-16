/**
 * @failure Yrd prints a revision-qualified PR identity that its own selector
 * resolver rejects, aliases to the current revision, or permits a mutating
 * verb to target through a historical revision.
 * @level l2
 * @consumer @yrd/bay selector and formatter boundary
 */
import { describe, expect, it } from "vitest"
import {
  baseIdentity,
  formatPRRevisionSelector,
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

  // `pr submit origin/<branch>` stores the qualifier verbatim, and the refresh
  // path re-prefixes it into refs/heads/origin/<branch>, which cannot exist. So
  // the defect only bites on the RECOVERY path, exactly when recut is the
  // remedy. The seven cases above never caught it because none names a remote.
  //
  // The normalizer for this is `baseIdentity`, which ALREADY exists and is
  // already applied to base refs in eight places. These cases pin that it is
  // equally the answer for a BRANCH selector, so the submit path can reuse it
  // instead of growing a second one.
  it.each([
    ["origin/task/thing", "task/thing"],
    ["task/thing", "task/thing"],
    // Deeply nested branch names keep every segment after the qualifier.
    ["origin/task/@tent/tooling/22660-rail", "task/@tent/tooling/22660-rail"],
    // The fully-qualified forms collapse to the same key.
    ["refs/heads/task/thing", "task/thing"],
    ["refs/remotes/origin/task/thing", "task/thing"],
    // Only the LEADING qualifier goes; an inner segment is part of the branch.
    ["task/origin/x", "task/origin/x"],
  ] as const)("collapses %s to one stored form", (selector, expected) => {
    expect(baseIdentity(selector)).toBe(expected)
  })

  it("stores the same branch whether or not the operator qualified it", () => {
    expect(baseIdentity("origin/task/thing")).toBe(baseIdentity("task/thing"))
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
