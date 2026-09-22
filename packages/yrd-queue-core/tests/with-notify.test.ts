import { describe, expect, it } from "vitest"
import { messageFor } from "../src/with-notify.ts"

describe("messageFor deferred timing relation", () => {
  const base = {
    branch: "task/25029-fix",
    head: "abcdef1234567890abcdef1234567890abcdef12",
    subject: "fix(yrd): deferral notice relation",
  }

  it("formats > when projected duration exceeds bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 58 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe(
      "waits for long check: task/25029-fix@abcdef123456 (projected 58m > 30m)",
    )
  })

  it("formats < when projected duration is less than bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 17 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe(
      "waits for long check: task/25029-fix@abcdef123456 (projected 17m < 30m)",
    )
  })

  it("formats = when projected duration equals bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 30 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe(
      "waits for long check: task/25029-fix@abcdef123456 (projected 30m = 30m)",
    )
  })

  it("falls back to projection exceeded bound when timing is undefined", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: undefined,
      boundMs: undefined,
    })
    expect(msg).toBe(
      "waits for long check: task/25029-fix@abcdef123456 (projection exceeded bound)",
    )
  })
})
