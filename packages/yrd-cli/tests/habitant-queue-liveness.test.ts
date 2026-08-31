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
import { createConditionReporter } from "@yrd/core"
import { logQueueLivenessWedge } from "../src/run.ts"
import type { YrdCliApp } from "../src/types.ts"

const NOW = "2026-08-30T00:10:00.000Z"

type Logged = Readonly<{ message: string; props: Record<string, unknown> }>

/** The same minimal typed double `cli.test.ts` already uses for
 * `habitantQueueProgress` itself: `logQueueLivenessWedge`'s whole job is
 * routing that projection's own output into a log line, so it is tested the
 * same way — a canned `queue.audit` result, never a composed app.
 *
 * Captures `.error` — the finding is queue-INTEGRITY-adjacent (a queue that
 * cannot self-recover), raised from warn 2026-08-31. */
function appWithFindings(findings: readonly Record<string, unknown>[]): Readonly<{ app: YrdCliApp; errors: Logged[] }> {
  const errors: Logged[] = []
  const app = {
    queue: { audit: () => ({ findings }) },
    log: { error: (message: string, props: Record<string, unknown>) => errors.push({ message, props }) },
  } as unknown as YrdCliApp
  return { app, errors }
}

describe("logQueueLivenessWedge — the recover-cycle's half of the liveness pair", () => {
  it("logs nothing when the queue is idle or draining", () => {
    const { app, errors } = appWithFindings([])
    logQueueLivenessWedge(app, NOW)
    expect(errors).toEqual([])
  })

  it("logs nothing for a finding that is not the liveness code — never a second reader's opinion", () => {
    const { app, errors } = appWithFindings([{ code: "queue-progress-stalled", message: "unrelated", pr: "PR9" }])
    logQueueLivenessWedge(app, NOW)
    expect(errors).toEqual([])
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
    const { app, errors } = appWithFindings([finding])

    logQueueLivenessWedge(app, NOW)

    // Computed once, consumed by both (@i/10-yrd/queue-liveness-pair
    // acceptance 1): this is the EXACT finding `habitantQueueProgress`
    // already projects into service health — never a re-derivation, never a
    // paraphrase — so the two consumers can never disagree about whether the
    // queue is draining.
    expect(errors).toEqual([
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
    const { app, errors } = appWithFindings([
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

    expect(errors.map((entry) => entry.message)).toEqual(["Queue 'main' wedged", "Queue 'release/2.0' wedged"])
  })
})

/** One double whose findings can change between calls (`setFindings`), so a
 * dedup test can drive several `logQueueLivenessWedge` ticks — including an
 * idle tick that reports the queue recovered — against the SAME `app.log`
 * and the SAME `errors` array. */
function stepwiseApp(): Readonly<{
  app: YrdCliApp
  errors: Logged[]
  setFindings: (findings: readonly Record<string, unknown>[]) => void
}> {
  const errors: Logged[] = []
  let findings: readonly Record<string, unknown>[] = []
  const app = {
    queue: { audit: () => ({ findings }) },
    log: { error: (message: string, props: Record<string, unknown>) => errors.push({ message, props }) },
  } as unknown as YrdCliApp
  return {
    app,
    errors,
    setFindings: (next) => {
      findings = next
    },
  }
}

describe("logQueueLivenessWedge — dedup and escalation via an explicit ConditionReporter", () => {
  const finding = {
    code: "queue-liveness-wedged",
    message: "Queue 'main' wedged",
    pr: "PR1",
    specimen: "queue:main:liveness-wedged",
    since: NOW,
    blockedMs: 1_800_000,
  }

  it("collapses repeats of the SAME wedge into silence, then escalates rather than staying quiet forever", () => {
    const { app, errors, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])

    // Tick 1 (first observation of this episode): loud immediately.
    logQueueLivenessWedge(app, NOW, conditions)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(finding.message)

    // Tick 2 (30-90s later, still wedged): the identical repeat collapses —
    // this is the exact spam the dedup exists to stop (measured: 16 identical
    // rows over one wedged hour).
    logQueueLivenessWedge(app, NOW, conditions)
    expect(errors).toHaveLength(1)

    // Tick 3: still the SAME condition. The doubling schedule waits for 2
    // repeats after the 1st announcement (`min(2**1, cap)`) — this tick is
    // the 2nd, so persistence crosses the threshold: escalate rather than
    // stay silent through the rest of the outage. The re-announcement names
    // how many repeats it folded in.
    logQueueLivenessWedge(app, NOW, conditions)
    expect(errors).toHaveLength(2)
    expect(errors[1]?.message).toContain("still ongoing")
    expect(errors[1]?.props.suppressedSinceLastNotice).toBe(2)
  })

  it("a NEW wedge episode (different specimen) logs immediately, independent of an unrelated persisting one", () => {
    const { app, errors, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])
    logQueueLivenessWedge(app, NOW, conditions)
    logQueueLivenessWedge(app, NOW, conditions) // suppressed, per the test above
    expect(errors).toHaveLength(1)

    const otherBase = {
      ...finding,
      message: "Queue 'release/2.0' wedged",
      pr: "PR2",
      specimen: "queue:release/2.0:liveness-wedged",
    }
    setFindings([otherBase])
    logQueueLivenessWedge(app, NOW, conditions)

    expect(errors).toHaveLength(2)
    expect(errors[1]?.message).toBe(otherBase.message)
  })

  it("flushes a closing summary once the queue stops being stalled, naming how many repeats it folded in", () => {
    const { app, errors, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])
    logQueueLivenessWedge(app, NOW, conditions) // loud
    logQueueLivenessWedge(app, NOW, conditions) // 1 repeat suppressed
    expect(errors).toHaveLength(1)

    // The queue recovers: habitantQueueProgress reports no findings, so this
    // tick's early return is where a still-pending tally would otherwise be
    // lost silently at process exit or the next unrelated episode.
    setFindings([])
    logQueueLivenessWedge(app, NOW, conditions)

    expect(errors).toHaveLength(2)
    expect(errors[1]?.message).toContain("cleared after 1 more repeated occurrence")
    expect(errors[1]?.props.suppressed).toBe(1)
  })

  it("never grows a synthetic second line for a condition that fired exactly once", () => {
    const { app, errors, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])
    logQueueLivenessWedge(app, NOW, conditions) // loud, no repeat

    setFindings([])
    logQueueLivenessWedge(app, NOW, conditions) // resolves with nothing suppressed

    expect(errors).toHaveLength(1)
  })
})
