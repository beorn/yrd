import { describe, expect, it } from "vitest"
import { messageFor, notifyEnvRetired } from "../src/with-notify.ts"

describe("env-retired dispatch (29720)", () => {
  it("answers one none delivery when no entry names env-retired, without touching git", async () => {
    const handed = await notifyEnvRetired(
      {
        git: (() => {
          throw new Error("git must not run when nobody wants the occasion")
        }) as never,
        notify: [],
        repo: "/r",
        targetSha: "a".repeat(40),
        workdir: "/w",
        tempRoot: "/t",
      },
      {
        record: "env-retired",
        change: "task/thing@abcdef1234567890abcdef1234567890abcdef12",
        endingId: "q-run9:/w/thing",
        endedAt: "2026-10-17T00:00:00.000Z",
        submitter: "@dev/3",
        environment: "/w/thing",
        proof: "/retained/thing/manifest.json",
        retainUntil: "2026-10-24T00:00:00.000Z",
      },
    )
    expect(handed).toEqual([{ delivery: "none", name: "none" }])
  })
})

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
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projected 58m > 30m)")
  })

  it("formats < when projected duration is less than bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 17 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projected 17m < 30m)")
  })

  it("formats = when projected duration equals bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 30 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projected 30m = 30m)")
  })

  it("falls back to projection exceeded bound when timing is undefined", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: undefined,
      boundMs: undefined,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projection exceeded bound)")
  })
})

describe("messageFor names a queue re-cut (24977)", () => {
  const about = {
    branch: "task/24977-recut",
    head: "abcdef1234567890abcdef1234567890abcdef12",
    subject: "task/24977-recut merged into main as 0123456789ab",
    merge: "0123456789abcdef0123456789abcdef01234567",
    recuts: [
      "ag 1111111111111111111111111111111111111111 + 2222222222222222222222222222222222222222 -> 3333333333333333333333333333333333333333",
    ],
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
