/**
 * @failure A round judged with a merge check held off reads, in the rendered log, exactly like one that ran it.
 * @level l1 @consumer the operator reading `yrd queue run` output
 * The journal rows carry the override (run.test.ts proves that); only this proves the human line says it.
 */
import { describe, expect, it } from "vitest"
import { summarize } from "../src/queue-core-commands.ts"

describe("the rendered log names a merge-check override (25296 C5)", () => {
  it("names the held-off check in the run line, each skipped check, and the round's own expiry write", () => {
    expect(
      summarize("run", {
        gitlink: "a".repeat(40),
        overrides: ["verify OFF until 2026-09-23T23:00:00.000Z (by @dev/3 (claimed): flaky gate)"],
        target: "main",
      }),
    ).toBe(
      `queue run at main ${"a".repeat(12)}; merge check verify OFF until 2026-09-23T23:00:00.000Z (by @dev/3 (claimed): flaky gate)`,
    )
    expect(summarize("run", { gitlink: "a".repeat(40), overrides: [], target: "main" })).toBe(
      `queue run at main ${"a".repeat(12)}`,
    )
    expect(
      summarize("skipped", {
        branch: "task/one",
        by: "@dev/3",
        check: "verify",
        head: "b".repeat(40),
        record: "c".repeat(40),
        until: "2026-09-23T23:00:00.000Z",
        verified: false,
      }),
    ).toBe(
      `task/one at ${"b".repeat(12)}: merge check verify skipped: override ${"c".repeat(12)} by @dev/3 (claimed) until 2026-09-23T23:00:00.000Z`,
    )
    expect(summarize("override", { check: "verify", reason: "verify until 2026-09-23T23:00:00.000Z passed", record: "expired" })).toBe(
      "merge check verify override expired: verify until 2026-09-23T23:00:00.000Z passed",
    )
  })
})
