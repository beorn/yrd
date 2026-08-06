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
  ] as const)("parses %s without guessing", (selector, expected) => {
    expect(parsePRSelector(selector)).toEqual(expected)
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
