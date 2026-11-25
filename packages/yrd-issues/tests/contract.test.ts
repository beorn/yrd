/**
 * @failure  The issues interface's verb table and argv rules are shared by two providers (Yrd's argv runner and
 *           Hightea's cloud provider). If the table drifted in one of them, or a write verb stopped demanding its
 *           replay key, a retried write would land twice at one provider and not the other — and #37445's `state`
 *           verb, the first write added since the table was written, is exactly where that would first show.
 * @level    l1 (pure table and function reads; no IO, no provider)
 * @testonly none
 * @consumer Yrd's declaration reader · Hightea's GitHub provider (@cto 37a8972c, hh #37445)
 */
import { describe, expect, it } from "vitest"
import {
  allowedPlaceholders,
  checkIssuesArgv,
  ISSUES_VERB_NAMES,
  ISSUES_WRITE_VERBS,
  isIssuesVerb,
  substituteArgv,
} from "../src/index.ts"

describe("@yrd/issues contract", () => {
  it("carries the twelve original verbs plus state, and no watch without a caller", () => {
    expect(ISSUES_VERB_NAMES).toContain("state")
    expect(ISSUES_VERB_NAMES).not.toContain("watch")
    expect(ISSUES_VERB_NAMES).toHaveLength(14)
    expect(isIssuesVerb("state")).toBe(true)
    expect(isIssuesVerb("watch")).toBe(false)
    expect(isIssuesVerb("states")).toBe(false)
  })

  it("makes state a write verb that carries its replay key", () => {
    expect(ISSUES_WRITE_VERBS.has("state")).toBe(true)
    expect(allowedPlaceholders("state")).toEqual(["key", "state", "id"])
  })

  it("refuses a write verb that does not carry its replay key", () => {
    const refusal = checkIssuesArgv("state", ["<key>", "<state>"])
    expect(refusal?.message).toBe("write verb state lacks <id>; add <id> where the provider takes its replay key")
    expect(checkIssuesArgv("state", ["<key>", "<state>", "<id>"])).toBeNull()
  })

  it("refuses a placeholder the verb does not take, naming the ones it does", () => {
    expect(checkIssuesArgv("view", ["<key>", "<text>"])?.message).toBe(
      "view carries placeholder <text>, which view does not take; view takes <key>",
    )
  })

  it("refuses a placeholder embedded inside an element", () => {
    expect(checkIssuesArgv("view", ["--issue=<key>"])?.message).toBe(
      'view element "--issue=<key>" embeds <key>; a placeholder must be a whole argv element',
    )
  })

  it("substitutes one whole element per placeholder and refuses a missing value", () => {
    expect(substituteArgv(["gh", "issue", "close", "<key>"], { key: "12" })).toEqual(["gh", "issue", "close", "12"])
    expect(() => substituteArgv(["<key>"], {})).toThrow("yrd issues: no value for placeholder <key>")
  })
})
