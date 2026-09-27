import { describe, expect, it } from "vitest"

import { isChargedFailure } from "../src/with-notify.ts"

describe("isChargedFailure — which failed endings count against a branch (24977 constraint 4)", () => {
  it("never charges a queue re-cut's check failure, nor a head the submitter moved on from", () => {
    expect(isChargedFailure("recut-check")).toBe(false)
    expect(isChargedFailure("replaced")).toBe(false)
    expect(isChargedFailure("deleted")).toBe(false)
  })

  it("charges every other failure, a missing reason included", () => {
    expect(isChargedFailure("check")).toBe(true)
    expect(isChargedFailure("conflict")).toBe(true)
    expect(isChargedFailure(undefined)).toBe(true)
  })
})
