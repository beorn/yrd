// @failure Two runner-absence states print the same NO RUNNER sentence, or a sentence names no remedy.
// @level l1
// @consumer @yrd/cli watch

import { describe, expect, it } from "vitest"
import { queueNoRunnerBanner, type QueueTimelineProjection } from "../src/queue-status-view.tsx"

type BannerProjection = Pick<QueueTimelineProjection, "base" | "oldestOpenMs" | "runnerAbsence">

const NOW = Date.parse("2026-07-13T12:00:00.000Z")

function projection(overrides: Partial<BannerProjection> = {}): BannerProjection {
  return { base: "main", oldestOpenMs: null, ...overrides }
}

describe("NO RUNNER banner", () => {
  it("tells a crashed runner, a stopped runner, and a queue nobody staffed apart", () => {
    const died = queueNoRunnerBanner(
      projection({ runnerAbsence: { kind: "departed", pid: 4242, clean: false, lastAliveMs: NOW - 90_000 } }),
      null,
      NOW,
    )
    const stopped = queueNoRunnerBanner(
      projection({ runnerAbsence: { kind: "departed", pid: 4242, clean: true, lastAliveMs: NOW - 90_000 } }),
      null,
      NOW,
    )
    const never = queueNoRunnerBanner(projection({ runnerAbsence: { kind: "never" } }), null, NOW)
    const idle = queueNoRunnerBanner(projection({ runnerAbsence: { kind: "never" } }), NOW - 3_600_000, NOW)

    expect(died).toBe(
      "NO RUNNER - habitant runner [4242] died 1:30 ago, no exit marker; restart it: yrd queue run main",
    )
    expect(stopped).toBe("NO RUNNER - habitant runner [4242] stopped 1:30 ago; restart it: yrd queue run main")
    expect(never).toBe("NO RUNNER - no runner has ever drained this queue; start one: yrd queue run main")
    expect(idle).toBe("NO RUNNER - queue last drained 1:00:00 ago, none habitant since; start one: yrd queue run main")

    // The regression this file exists for: the four lines collapsed to two.
    expect(new Set([died, stopped, never, idle]).size).toBe(4)
  })

  it("carries a remedy on every sentence, because a banner nobody can act on is noise", () => {
    const sentences = [
      queueNoRunnerBanner(
        projection({ runnerAbsence: { kind: "departed", pid: 7, clean: false, lastAliveMs: NOW } }),
        null,
        NOW,
      ),
      queueNoRunnerBanner(
        projection({ runnerAbsence: { kind: "departed", pid: 7, clean: true, lastAliveMs: NOW } }),
        null,
        NOW,
      ),
      queueNoRunnerBanner(projection({ runnerAbsence: { kind: "never" } }), null, NOW),
      queueNoRunnerBanner(projection({ runnerAbsence: { kind: "never" } }), NOW - 60_000, NOW),
    ]
    for (const sentence of sentences) expect(sentence, sentence).toContain("yrd queue run main")
  })

  it("names the remedy for the queue the reader is looking at, not a hardcoded main", () => {
    expect(queueNoRunnerBanner(projection({ base: "release/2.0" }), null, NOW)).toContain(
      "start one: yrd queue run release/2.0",
    )
  })

  it("reports how long the oldest submission has waited when nothing has ever drained here", () => {
    // A queue nobody staffed reads as merely quiet until the line says work is
    // waiting on it. Live specimen 2026-08-05: an hour of accumulated
    // submissions behind a driver that did not exist.
    expect(
      queueNoRunnerBanner(projection({ runnerAbsence: { kind: "never" }, oldestOpenMs: 62 * 60_000 }), null, NOW),
    ).toBe("NO RUNNER - no runner has ever drained this queue, oldest open 1:02:00; start one: yrd queue run main")
  })

  it("keeps the step-contract refusal ahead of every absence sentence", () => {
    // The refusal is a fact about WHY the runner stopped serving; it outranks
    // the absence, which only says that it did.
    expect(
      queueNoRunnerBanner(
        projection({ runnerAbsence: { kind: "departed", pid: 9, clean: false, lastAliveMs: NOW } }),
        null,
        NOW,
        { code: "step-revision-drift", message: "installed 'v2'", run: "R2670" },
      ),
    ).toBe("NO RUNNER - runner stopped: stale step contract on R2670")
  })

  it("stays inside a 120-column RUNNER frame, where the row truncates rather than wraps", () => {
    // The banner row is `wrap="truncate"` on purpose (a wrapped one starves the
    // timeline on a narrow pane), so a remedy that does not fit is a remedy the
    // reader never sees. 120 columns less the frame, the `$` marker and its gap.
    const widest = queueNoRunnerBanner(
      projection({
        base: "main",
        oldestOpenMs: 62 * 60_000,
        runnerAbsence: { kind: "departed", pid: 4_194_303, clean: false, lastAliveMs: NOW - 359_999_000 },
      }),
      null,
      NOW,
    )
    expect(widest.length, widest).toBeLessThanOrEqual(114)
  })
})
