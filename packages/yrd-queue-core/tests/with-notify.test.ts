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

describe("messageFor names a queue re-cut (24977)", () => {
  const about = {
    branch: "task/24977-recut",
    head: "abcdef1234567890abcdef1234567890abcdef12",
    subject: "task/24977-recut merged into main as 0123456789ab",
    merge: "0123456789abcdef0123456789abcdef01234567",
    recuts: ["ag 1111111111111111111111111111111111111111 + 2222222222222222222222222222222222222222 -> 3333333333333333333333333333333333333333"],
  }

  it("says the merged change was re-cut, naming the change's pin, the main merged in, and the composed commit", () => {
    expect(messageFor("merged", about)).toBe(
      "close your bead: task/24977-recut@abcdef123456 merged as 0123456789ab; the queue re-cut it: ag 111111111111 + main 222222222222 -> 333333333333",
    )
  })

  it("says nothing about a re-cut when there was none", () => {
    expect(messageFor("merged", { ...about, recuts: [] })).toBe(
      "close your bead: task/24977-recut@abcdef123456 merged as 0123456789ab",
    )
  })
})
