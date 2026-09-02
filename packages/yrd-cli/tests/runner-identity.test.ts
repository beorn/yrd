/**
 * @failure A one-shot pass claimed Jobs under a bare `yrd-cli` — an identity
 *          with no pid — so its running rows could never be probed by
 *          identity and only their lease could ever judge them
 *          (@i/10-yrd/24030). The claim and the departed-habitant reclaim now
 *          mint through ONE helper, the shape `runnerPid` parses back.
 * @level l1
 * @consumer @yrd/cli run.ts (yrdRunnerIdentity, planHabitantRunnerReclaim)
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { runnerPid } from "@yrd/queue"
import { planHabitantRunnerReclaim, yrdRunnerIdentity } from "../src/run.ts"

describe("the runner identity carries the pid the liveness probe reads (24030)", () => {
  it("is minted in exactly ONE place — every `yrd-cli:<pid>` in yrd-cli's sources comes from yrdRunnerIdentity", () => {
    // host.ts minted the habitant seed's id and the hosted one-shot's runnerId
    // by hand beside the helper until 2026-09-02; three sites is how the
    // shape drifts. The count is asserted, not the absence, so a walk that
    // resolved the wrong root reads as a loud zero rather than a green one.
    const src = fileURLToPath(new URL("../src/", import.meta.url))
    const sites = new Map<string, number>()
    for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) continue
      const path = join(entry.parentPath, entry.name)
      const count = readFileSync(path, "utf8").split("`yrd-cli:${").length - 1
      if (count > 0) sites.set(path.slice(src.length), count)
    }
    expect([...sites.entries()]).toEqual([["run.ts", 1]])
  })

  it("mints yrd-cli:<pid>, and runnerPid reads the pid back", () => {
    expect(yrdRunnerIdentity(4242)).toBe("yrd-cli:4242")
    expect(runnerPid(yrdRunnerIdentity(4242))).toBe(4242)
    expect(runnerPid("yrd-cli")).toBeUndefined()
  })

  it("reclaim names a departed habitant by the same identity it claimed under", () => {
    const prior = {
      pid: 4242,
      startedAt: "2026-09-02T04:00:00.000Z",
      lastTickAt: "2026-09-02T04:05:00.000Z",
      queueProgress: { state: "healthy" as const, observedAt: "2026-09-02T04:05:00.000Z" },
    }
    const decision = planHabitantRunnerReclaim(prior as never, 9999, () => false)
    expect(decision).toEqual({ reclaim: true, runner: yrdRunnerIdentity(4242) })
    expect(planHabitantRunnerReclaim(prior as never, 9999, () => true)).toEqual({ reclaim: false })
    expect(planHabitantRunnerReclaim(prior as never, 4242, () => false)).toEqual({ reclaim: false })
  })
})
