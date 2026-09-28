/**
 * @failure A malformed or stale runner ref could be believed as a live service.
 * @level l1 (the pure root-commit wire and freshness rule)
 * @consumer Yrd's resident publisher and off-machine readers
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, it } from "vitest"
import {
  formatRunnerClaim,
  judgeRunnerClaim,
  judgeRunnerDeadline,
  judgeRunnerDue,
  parseRunnerClaim,
  roundBoundMs,
  runnerRef,
} from "../src/index.ts"

const claim = {
  host: "queue-host",
  pid: 4242,
  started: "2026-09-27T12:00:00.000Z",
  at: "2026-09-27T12:01:00.000Z",
  beatMs: 60_000,
  state: "checking" as const,
  holding: "task/a@" + "a".repeat(40),
  since: "2026-09-27T12:00:30.000Z",
  deadline: "2026-09-27T12:30:30.000Z",
}

describe("runner claim", () => {
  /** @failure A partial identity could prove death, or new identity trailers could break an old reader. @level l1 */
  it("appends a complete PID identity group and reads a partial group as unproven", async () => {
    const withIdentity = { ...claim, boot: "boot-a", pidNamespace: "pid:[42]", startTick: 1234 }
    const message = formatRunnerClaim(withIdentity)
    expect(message).toContain("Boot: boot-a\nPidNamespace: pid:[42]\nStartTick: 1234\n")
    expect(parseRunnerClaim(message)).toEqual(withIdentity)
    // Exercise the shipped pre-identity parser, rather than simulating its schema.
    const oldSource = execFileSync("git", ["show", "9521187d10:packages/yrd-queue-core/src/runner-claim.ts"], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
    }).replace('"./refs.ts"', JSON.stringify(resolve(import.meta.dirname, "../src/refs.ts")))
    const root = mkdtempSync(join(tmpdir(), "yrd-old-runner-reader-"))
    try {
      const path = join(root, "runner-claim.ts")
      writeFileSync(path, oldSource)
      const oldReader = (await import(path)) as {
        parseRunnerClaim(body: string): typeof claim & { unknownTrailers: readonly string[] }
        formatRunnerClaim(input: typeof claim & { unknownTrailers: readonly string[] }): string
      }
      const parsed = oldReader.parseRunnerClaim(message)
      expect(parsed).toEqual({
        ...claim,
        unknownTrailers: ["Boot: boot-a", "PidNamespace: pid:[42]", "StartTick: 1234"],
      })
      expect(oldReader.formatRunnerClaim(parsed)).toBe(message)
    } finally {
      safeRemoveSync(root, { within: realpathSync(tmpdir()) })
    }
    const partial = message.replace("StartTick: 1234\n", "")
    expect(parseRunnerClaim(partial)).toEqual({ ...claim, boot: "boot-a", pidNamespace: "pid:[42]" })
    expect(() => formatRunnerClaim({ ...claim, boot: "boot-a" })).toThrow(/written together/)
  })

  it("names the queue-owned runner ref and round trips all claim trailers", () => {
    expect(runnerRef("a/b")).toBe("refs/yrd/a%2Fb/runner")
    const message = formatRunnerClaim(claim)
    expect(message).toContain("Runner: queue-host/4242\n")
    expect(message).toContain("Beat: 60000ms\n")
    expect(parseRunnerClaim(message)).toEqual(claim)
    expect(parseRunnerClaim(`${message}\n\n`)).toEqual(claim) // `git show -s --format=%B` terminal blank lines
  })

  it("judges the three-beat boundary and future clock skew", () => {
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:04:00.000Z")).status).toBe("fresh")
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:04:00.001Z")).status).toBe("silent")
    expect(judgeRunnerClaim(claim, new Date("2026-09-27T12:00:29.999Z"))).toMatchObject({
      status: "unreadable",
      reason: expect.stringContaining("clock-skew"),
    })
  })

  it("round trips a declared phase deadline and rejects one before its phase start", () => {
    const message = formatRunnerClaim(claim)
    expect(message).toContain("Since: 2026-09-27T12:00:30.000Z\nDeadline: 2026-09-27T12:30:30.000Z\n")
    expect(parseRunnerClaim(message)).toEqual(claim)
    expect(() => formatRunnerClaim({ ...claim, deadline: "2026-09-27T12:00:29.999Z" })).toThrow(/Deadline/)
    expect(() => formatRunnerClaim({ ...claim, deadline: undefined })).toThrow(/Deadline/)
    expect(() =>
      parseRunnerClaim(message.replace("Deadline: 2026-09-27T12:30:30.000Z", "Deadline: yesterday")),
    ).toThrow(/Deadline/)
    // Readers must still parse an older writer so they can label its missing deadline explicitly.
    expect(parseRunnerClaim(message.replace("Deadline: 2026-09-27T12:30:30.000Z\n", ""))).toEqual({
      ...claim,
      deadline: undefined,
    })
  })

  it("judges a phase only after its declared deadline plus three beats", () => {
    expect(judgeRunnerDeadline(claim, new Date("2026-09-27T12:33:30.000Z")).status).toBe("within")
    expect(judgeRunnerDeadline(claim, new Date("2026-09-27T12:33:30.001Z")).status).toBe("overdue")
    expect(judgeRunnerDeadline({ ...claim, deadline: undefined }, new Date("2026-09-27T12:45:00.000Z"))).toMatchObject({
      status: "unavailable",
      reason: "deadline unavailable: writer predates Deadline",
    })
    expect(
      judgeRunnerDeadline({ ...claim, state: "idle", deadline: undefined }, new Date("2026-09-27T12:45:00.000Z"))
        .status,
    ).toBe("unbounded")
  })

  /** @failure A cycling round could stay within each phase bound while exceeding its total declared plan. @level l1 */
  it("round trips one immutable round plan and judges Due after three beats", () => {
    const planned = {
      ...claim,
      round: "2026-09-27T12:00:10.000Z",
      due: "2026-09-27T13:15:10.000Z",
      candidates: 3,
    }
    const message = formatRunnerClaim(planned)
    expect(message).toContain(
      "Deadline: 2026-09-27T12:30:30.000Z\nDue: 2026-09-27T13:15:10.000Z\nRound: 2026-09-27T12:00:10.000Z\nCandidates: 3\n",
    )
    expect(parseRunnerClaim(message)).toEqual(planned)
    expect(judgeRunnerDue(planned, new Date("2026-09-27T13:18:10.000Z")).status).toBe("within")
    expect(judgeRunnerDue(planned, new Date("2026-09-27T13:18:10.001Z"))).toMatchObject({
      status: "overdue",
      reason: "round past its total declared bound (1h15m for 3 candidates, started 2026-09-27T12:00:10.000Z)",
    })
  })

  it("refuses an incomplete or incoherent round plan", () => {
    const planned = { ...claim, round: "2026-09-27T12:00:10.000Z", due: "2026-09-27T13:15:10.000Z", candidates: 3 }
    expect(() => formatRunnerClaim({ ...planned, round: "2026-09-27T12:00:31.000Z" })).toThrow(/Round.*Since/)
    expect(() => formatRunnerClaim({ ...planned, candidates: 0 })).toThrow(/Candidates/)
    expect(() => formatRunnerClaim({ ...planned, due: undefined })).toThrow(/Round.*Due|Due.*Round/)
    expect(() => formatRunnerClaim({ ...planned, due: planned.round })).toThrow(/Round.*Due|Due.*Round/)
    const message = formatRunnerClaim(planned)
    expect(() => parseRunnerClaim(message.replace("Candidates: 3", "Candidates: 03"))).toThrow(/Candidates/)
    expect(() => parseRunnerClaim(message.replace("Candidates: 3", "Candidates: 3e0"))).toThrow(/Candidates/)
  })

  /** @failure A protected check's P and C setup runs were omitted from the whole-round Due. @level l1 */
  it("includes both program-root worktrees and setup runs in each declared phase", () => {
    const bound = roundBoundMs(
      [{ name: "protected", run: "test", on: ["submit", "merge"], timeoutMs: 5 * 60_000, programRoot: true }],
      "true",
      1,
    )
    // 30m line read; two attempts of: 5 other steps, 2 phase worktrees,
    // 4 protected worktrees, 2 checks, 6 setups; one settled-base allowance.
    const attempt = 5 * 30 + 2 * 2 * 30 + 4 * 2 * 30 + 2 * 5 + 6 * 30
    const attribution = 2 * 30 + 5 * 2 * 30 + 5 * 30 + 2 * 5
    expect(bound).toBe((30 + 2 * attempt + attribution) * 60_000)
  })

  /** @failure A long-tier round inherited normal check timeouts and published Due before its checks could finish. @level l1 */
  it("budgets each long-tier check timeout in the round and attribution allowance", () => {
    const checks = [
      { name: "long-check", run: "test", on: ["merge"] as const, timeoutMs: 60_000, long: { timeoutMs: 90_000 } },
    ]
    const normal = roundBoundMs(checks, undefined, 2)
    const long = roundBoundMs(checks, undefined, 2, "long")
    // Two candidates, two attempts each, and at most one attribution per candidate.
    expect(long - normal).toBe(2 * (2 + 1) * 30_000)
  })

  /** @failure A new writer inserted its plan before the old reader's known tail and made the claim unreadable. @level l1 */
  it("leaves Due, Round, and Candidates as the old reader's unjudged tail", () => {
    const message = formatRunnerClaim({
      ...claim,
      round: "2026-09-27T12:00:10.000Z",
      due: "2026-09-27T13:15:10.000Z",
      candidates: 3,
    })
    // The pre-Due reader ended its known schema at Deadline. It required all
    // known trailers first, then preserved unique names in the unknown tail.
    const oldKnown = new Set(["Runner", "Started", "At", "Beat", "State", "Holding", "Since", "Deadline"])
    const trailers = message.trimEnd().split("\n").slice(2)
    const firstUnknown = trailers.findIndex((line) => !oldKnown.has(line.split(": ")[0] ?? ""))
    expect(trailers.slice(0, firstUnknown).map((line) => line.split(": ")[0])).toEqual([
      "Runner",
      "Started",
      "At",
      "Beat",
      "State",
      "Holding",
      "Since",
      "Deadline",
    ])
    expect(trailers.slice(firstUnknown).map((line) => line.split(": ")[0])).toEqual(["Due", "Round", "Candidates"])
    expect(new Set(trailers.slice(firstUnknown).map((line) => line.split(": ")[0])).size).toBe(3)
  })

  /** @failure Older readers treated every future claim trailer as an unreadable runner. @level l1 */
  it("ignores unique future trailers only after all known trailers", () => {
    const message = formatRunnerClaim(claim)
    const future = `${message}Intent: 2026-09-27T13:00:00.000Z\nTrace: two  spaces\n`
    expect(parseRunnerClaim(future)).toEqual({
      ...claim,
      unknownTrailers: ["Intent: 2026-09-27T13:00:00.000Z", "Trace: two  spaces"],
    })
    expect(formatRunnerClaim(parseRunnerClaim(future))).toBe(future)
    expect(() => parseRunnerClaim(message.replace("Since: ", "Step: merge\nSince: "))).toThrow(
      /unknown.*before|known.*after/,
    )
    expect(() => parseRunnerClaim(`${message}Step: merge\nAt: ${claim.at}\n`)).toThrow(/known.*after/)
    expect(() => parseRunnerClaim(`${message}Step: merge\nStep: publish\n`)).toThrow(/duplicate Step/)
  })

  it("refuses malformed, missing, and duplicated known trailers", () => {
    const message = formatRunnerClaim(claim)
    expect(() => parseRunnerClaim(message.replace("Beat: 60000ms", "Beat: 0ms"))).toThrow(/Beat/)
    expect(() => parseRunnerClaim(message.replace("Beat: 60000ms", "Beat: 29999ms"))).toThrow(/Beat/)
    expect(() => parseRunnerClaim(message.replace("State: checking", "State: sleeping"))).toThrow(/State/)
    expect(() => parseRunnerClaim(message.replace("At: 2026-09-27T12:01:00.000Z", "At: yesterday"))).toThrow(/At/)
    expect(() => parseRunnerClaim(message.replace("Holding: " + claim.holding + "\n", ""))).not.toThrow()
    expect(() => parseRunnerClaim(message.replace(claim.holding, "not-a-change"))).toThrow(/Holding/)
    expect(() => parseRunnerClaim(message.replace("Since: 2026-09-27T12:00:30.000Z\n", ""))).toThrow(/Since/)
    expect(() => parseRunnerClaim(message.replace("Beat: 60000ms\n", "Beat: 60000ms\n\n"))).toThrow(/malformed trailer/)
    expect(() => parseRunnerClaim(message + "At: 2026-09-27T12:01:00.000Z\n")).toThrow(/duplicate At/)
    expect(() => parseRunnerClaim(message + "Step=check\n")).toThrow(/malformed trailer/)
  })
})
