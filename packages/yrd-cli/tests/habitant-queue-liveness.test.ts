/**
 * @failure The habitant's lease-expiry sweep logs "recover succeeded ...
 *          runs: []" every ~60s whether or not the queue is draining, so a
 *          human tailing the runner's own log stream sees nothing wrong
 *          while eligible work sits uncomposed for hours. 2026-08-2x
 *          specimen: two standing submit facts could never merge and the
 *          runner reported healthy for 17 hours while minting phantom
 *          changes; no alarm fired.
 * @level l1
 * @consumer @yrd/cli habitant runner (D1b maintenance tick)
 */
import { describe, expect, it } from "vitest"
import { logQueueLivenessWedge } from "../src/run.ts"
import type { YrdCliApp } from "../src/types.ts"

const NOW = "2026-08-30T00:10:00.000Z"

type Warn = Readonly<{ message: string; props: Record<string, unknown> }>

/** The same minimal typed double `cli.test.ts` already uses for
 * `habitantQueueProgress` itself: `logQueueLivenessWedge`'s whole job is
 * routing that projection's own output into a log line, so it is tested the
 * same way — a canned `queue.audit` result, never a composed app. */
function appWithFindings(findings: readonly Record<string, unknown>[]): Readonly<{ app: YrdCliApp; warnings: Warn[] }> {
  const warnings: Warn[] = []
  const app = {
    queue: { audit: () => ({ findings }) },
    log: { warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }) },
  } as unknown as YrdCliApp
  return { app, warnings }
}

describe("logQueueLivenessWedge — the recover-cycle's half of the liveness pair", () => {
  it("logs nothing when the queue is idle or draining", () => {
    const { app, warnings } = appWithFindings([])
    logQueueLivenessWedge(app, NOW)
    expect(warnings).toEqual([])
  })

  it("logs nothing for a finding that is not the liveness code — never a second reader's opinion", () => {
    const { app, warnings } = appWithFindings([{ code: "queue-progress-stalled", message: "unrelated", pr: "PR9" }])
    logQueueLivenessWedge(app, NOW)
    expect(warnings).toEqual([])
  })

  it("logs the SAME message queue audit and service health already carry, attached to the recover cycle's own cadence", () => {
    const finding = {
      code: "queue-liveness-wedged",
      message:
        "Queue 'main' has 2 runnable changes eligible right now and no merge for 1h0m (since " +
        "2026-08-29T23:10:00.000Z); this reads independently of any admission-refusal finding and is never " +
        "suppressed by one. Head: 'PR7'.",
      pr: "PR7",
      specimen: "queue:main:liveness-wedged",
      count: 2,
      since: "2026-08-29T23:10:00.000Z",
      blockedMs: 3_600_000,
    }
    const { app, warnings } = appWithFindings([finding])

    logQueueLivenessWedge(app, NOW)

    // Computed once, consumed by both (@i/10-yrd/queue-liveness-pair
    // acceptance 1): this is the EXACT finding `habitantQueueProgress`
    // already projects into service health — never a re-derivation, never a
    // paraphrase — so the two consumers can never disagree about whether the
    // queue is draining.
    expect(warnings).toEqual([
      {
        message: finding.message,
        props: {
          action: "resident-queue-liveness-wedged",
          pr: "PR7",
          blockedMs: 3_600_000,
          since: "2026-08-29T23:10:00.000Z",
        },
      },
    ])
  })

  it("logs one warning per wedged base, so a multi-base queue does not lose one behind another", () => {
    const { app, warnings } = appWithFindings([
      { code: "queue-liveness-wedged", message: "Queue 'main' wedged", pr: "PR1", blockedMs: 1_800_000, since: NOW },
      {
        code: "queue-liveness-wedged",
        message: "Queue 'release/2.0' wedged",
        pr: "PR2",
        blockedMs: 2_700_000,
        since: NOW,
      },
    ])

    logQueueLivenessWedge(app, NOW)

    expect(warnings.map((warning) => warning.message)).toEqual(["Queue 'main' wedged", "Queue 'release/2.0' wedged"])
  })
})
