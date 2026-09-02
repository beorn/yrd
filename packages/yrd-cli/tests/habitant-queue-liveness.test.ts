/**
 * @failure Two failures, one line apart in the same function.
 *
 *          (1) The habitant's lease-expiry sweep logs "recover succeeded ...
 *          runs: []" every ~60s whether or not the queue is draining, so a
 *          human tailing the runner's own log stream sees nothing wrong while
 *          eligible work sits uncomposed for hours. 2026-08-2x specimen: two
 *          standing submit facts could never merge and the runner reported
 *          healthy for 17 hours while minting phantom changes.
 *
 *          (2) The alarm added for (1) was raised to ERROR on 2026-08-31, and
 *          on 2026-09-01 ERROR acquired a second meaning — "any ERROR ends the
 *          pass", latched by the host, exit 17. The row that REPORTED the
 *          wedge became the row that KILLED the reporter. Measured 2026-09-02:
 *          a resident booted into a queue whose last merge was 1h25m old
 *          emitted `queue-liveness-wedged` before attempting a single member
 *          and exited 17 on every start, so a queue with four eligible changes
 *          drained never. The dead-man is a health observation, never a
 *          per-pass fatal (@i/10-yrd/liveness-is-health).
 * @level l1
 * @consumer @yrd/cli habitant runner (D1b maintenance tick) · the page rail
 */
import { describe, expect, it } from "vitest"
import { createConditionReporter } from "@yrd/core"
import { habitantQueueProgress, logQueueLivenessWedge } from "../src/run.ts"
import { createResidentLivenessClock, type ResidentWedgePage } from "../src/resident-liveness.ts"
import type { YrdCliApp } from "../src/types.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"

const NOW = "2026-08-30T00:10:00.000Z"

type Logged = Readonly<{ message: string; props: Record<string, unknown> }>

/** The same minimal typed double `cli.test.ts` already uses for
 * `habitantQueueProgress` itself: `logQueueLivenessWedge`'s whole job is
 * routing that projection's own output into a log line, so it is tested the
 * same way — a canned `queue.audit` result, never a composed app.
 *
 * Captures BOTH streams. The severity is the thing under test now: a row on
 * `error` is a row that ends the pass, so a test that only watched one stream
 * could not tell "reported" from "reported and died". */
function appWithFindings(findings: readonly Record<string, unknown>[]): Readonly<{
  app: YrdCliApp
  warnings: Logged[]
  errors: Logged[]
  auditOptions: Record<string, unknown>[]
}> {
  const warnings: Logged[] = []
  const errors: Logged[] = []
  const auditOptions: Record<string, unknown>[] = []
  const app = {
    queue: {
      audit: (options: Record<string, unknown>) => {
        auditOptions.push(options)
        return { findings }
      },
    },
    log: {
      warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
      error: (message: string, props: Record<string, unknown>) => errors.push({ message, props }),
    },
  } as unknown as YrdCliApp
  return { app, warnings, errors, auditOptions }
}

describe("logQueueLivenessWedge — the recover-cycle's half of the liveness pair", () => {
  it("logs nothing when the queue is idle or draining", async () => {
    const { app, warnings, errors } = appWithFindings([])
    await logQueueLivenessWedge(app, NOW)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it("logs nothing for a finding that is not the liveness code — never a second reader's opinion", async () => {
    const { app, warnings } = appWithFindings([{ code: "queue-progress-stalled", message: "unrelated", pr: "PR9" }])
    await logQueueLivenessWedge(app, NOW)
    expect(warnings).toEqual([])
  })

  it("logs the SAME message queue audit and service health already carry, attached to the recover cycle's own cadence", async () => {
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

    await logQueueLivenessWedge(app, NOW)

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

  it("logs one warning per wedged base, so a multi-base queue does not lose one behind another", async () => {
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

    await logQueueLivenessWedge(app, NOW)

    expect(warnings.map((entry) => entry.message)).toEqual(["Queue 'main' wedged", "Queue 'release/2.0' wedged"])
  })
})

/**
 * Acceptance 1 (@i/10-yrd/liveness-is-health): the finding leaves the fatal
 * per-pass diagnostic set.
 *
 * This is the whole bead in one assertion. The host latches the FIRST
 * ERROR-level row any child logger emits and aborts the pass's drain with it
 * (`createYrdLogger`'s `onError` → `host.ts` `onFatalError`), so severity here
 * is not a presentation choice — it is the difference between a runner that
 * reports a wedge and a runner that dies of one.
 */
describe("logQueueLivenessWedge — severity is the stop rule", () => {
  const finding = {
    code: "queue-liveness-wedged",
    message: "Queue 'main' has 4 eligible changes outstanding and no merge for 1h25m",
    pr: "PR1",
    specimen: "queue:main:liveness-wedged",
    since: NOW,
    blockedMs: 5_100_000,
  }

  it("never writes the liveness finding to the ERROR stream the host latches as fatal", async () => {
    const { app, warnings, errors } = appWithFindings([finding])

    await logQueueLivenessWedge(app, NOW)

    expect(warnings).toHaveLength(1)
    // The row that used to be here is the row that exited the runner 17.
    expect(errors).toEqual([])
  })

  it("keeps the ERROR stream clean through an escalation too — a wedge that persists never becomes fatal", async () => {
    const { app, warnings, errors } = appWithFindings([finding])
    const conditions = createConditionReporter(app.log)

    // Loud, suppressed, escalated: the full doubling schedule, all of it WARN.
    for (let tick = 0; tick < 3; tick += 1) await logQueueLivenessWedge(app, NOW, conditions)

    expect(warnings).toHaveLength(2)
    expect(warnings[1]?.message).toContain("still ongoing")
    expect(errors).toEqual([])
  })
})

/** One double whose findings can change between calls (`setFindings`), so a
 * dedup test can drive several `logQueueLivenessWedge` ticks — including an
 * idle tick that reports the queue recovered — against the SAME `app.log`
 * and the SAME `warnings` array. */
function stepwiseApp(): Readonly<{
  app: YrdCliApp
  warnings: Logged[]
  errors: Logged[]
  setFindings: (findings: readonly Record<string, unknown>[]) => void
}> {
  const warnings: Logged[] = []
  const errors: Logged[] = []
  let findings: readonly Record<string, unknown>[] = []
  const app = {
    queue: { audit: () => ({ findings }) },
    log: {
      warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
      error: (message: string, props: Record<string, unknown>) => errors.push({ message, props }),
    },
  } as unknown as YrdCliApp
  return {
    app,
    warnings,
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

  it("collapses repeats of the SAME wedge into silence, then escalates rather than staying quiet forever", async () => {
    const { app, warnings, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])

    // Tick 1 (first observation of this episode): loud immediately.
    await logQueueLivenessWedge(app, NOW, conditions)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(finding.message)

    // Tick 2 (30-90s later, still wedged): the identical repeat collapses —
    // this is the exact spam the dedup exists to stop (measured: 16 identical
    // rows over one wedged hour).
    await logQueueLivenessWedge(app, NOW, conditions)
    expect(warnings).toHaveLength(1)

    // Tick 3: still the SAME condition. The doubling schedule waits for 2
    // repeats after the 1st announcement (`min(2**1, cap)`) — this tick is
    // the 2nd, so persistence crosses the threshold: escalate rather than
    // stay silent through the rest of the outage. The re-announcement names
    // how many repeats it folded in.
    await logQueueLivenessWedge(app, NOW, conditions)
    expect(warnings).toHaveLength(2)
    expect(warnings[1]?.message).toContain("still ongoing")
    expect(warnings[1]?.props.suppressedSinceLastNotice).toBe(2)
  })

  it("a NEW wedge episode (different specimen) logs immediately, independent of an unrelated persisting one", async () => {
    const { app, warnings, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])
    await logQueueLivenessWedge(app, NOW, conditions)
    await logQueueLivenessWedge(app, NOW, conditions) // suppressed, per the test above
    expect(warnings).toHaveLength(1)

    const otherBase = {
      ...finding,
      message: "Queue 'release/2.0' wedged",
      pr: "PR2",
      specimen: "queue:release/2.0:liveness-wedged",
    }
    setFindings([otherBase])
    await logQueueLivenessWedge(app, NOW, conditions)

    expect(warnings).toHaveLength(2)
    expect(warnings[1]?.message).toBe(otherBase.message)
  })

  it("flushes a closing summary once the queue stops being stalled, naming how many repeats it folded in", async () => {
    const { app, warnings, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])
    await logQueueLivenessWedge(app, NOW, conditions) // loud
    await logQueueLivenessWedge(app, NOW, conditions) // 1 repeat suppressed
    expect(warnings).toHaveLength(1)

    // The queue recovers: habitantQueueProgress reports no findings, so this
    // tick's early return is where a still-pending tally would otherwise be
    // lost silently at process exit or the next unrelated episode.
    setFindings([])
    await logQueueLivenessWedge(app, NOW, conditions)

    expect(warnings).toHaveLength(2)
    expect(warnings[1]?.message).toContain("cleared after 1 more repeated occurrence")
    expect(warnings[1]?.props.suppressed).toBe(1)
  })

  it("never grows a synthetic second line for a condition that fired exactly once", async () => {
    const { app, warnings, setFindings } = stepwiseApp()
    const conditions = createConditionReporter(app.log)
    setFindings([finding])
    await logQueueLivenessWedge(app, NOW, conditions) // loud, no repeat

    setFindings([])
    await logQueueLivenessWedge(app, NOW, conditions) // resolves with nothing suppressed

    expect(warnings).toHaveLength(1)
  })
})

/**
 * Acceptance 2 and 4 (@i/10-yrd/liveness-is-health): the clock is the runner's
 * own, it pauses inside attempts, and a wedge that persists AFTER attempted
 * work pages at escalating generations without ever killing the runner.
 */
describe("logQueueLivenessWedge — the runner's own clock and the page rail", () => {
  const finding = {
    code: "queue-liveness-wedged",
    message: "Queue 'main' has 4 eligible changes outstanding and no merge for 1h25m",
    pr: "PR1",
    specimen: "queue:main:liveness-wedged",
    since: "2026-08-29T22:45:00.000Z",
    blockedMs: 5_100_000,
  }

  it("hands the audit ITS OWN epoch, so the finding is measured from this runner rather than the journal it inherited", async () => {
    const { app, auditOptions } = appWithFindings([])
    const bootMs = Date.parse("2026-08-30T00:00:00.000Z")
    const clock = createResidentLivenessClock(bootMs)

    await logQueueLivenessWedge(app, NOW, undefined, { clock })

    expect(auditOptions).toHaveLength(1)
    expect(auditOptions[0]).toMatchObject({ now: NOW, livenessEpoch: "2026-08-30T00:00:00.000Z" })
  })

  it("takes NO reading while a pass is inside an attempt — a stopped clock reports nothing, not zero", async () => {
    const { app, warnings, errors, auditOptions } = appWithFindings([finding])
    const clock = createResidentLivenessClock(Date.parse("2026-08-29T20:00:00.000Z"))

    clock.attemptStarted(Date.parse("2026-08-30T00:00:00.000Z"))
    await logQueueLivenessWedge(app, NOW, undefined, { clock })

    // Not merely quiet: the audit was never asked. A 90-minute affected-tests
    // turn is the runner draining, and time inside it is not time it failed to.
    expect(auditOptions).toEqual([])
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it("adds attempt time to the epoch rather than resetting it, so an endlessly retrying wedge still pages", async () => {
    const { app, auditOptions } = appWithFindings([])
    const bootMs = Date.parse("2026-08-30T00:00:00.000Z")
    const clock = createResidentLivenessClock(bootMs)

    // A 30-minute attempt, then a 10-minute idle gap, then another 30-minute
    // attempt. The epoch advances by the 60 minutes spent ATTEMPTING and by
    // nothing else — a reset would have moved it to the end of the last
    // attempt and made the 10 idle minutes unaccountable, which is how a queue
    // that attempts and fails forever goes permanently silent.
    clock.attemptStarted(bootMs)
    clock.attemptEnded(bootMs + 30 * 60_000)
    clock.attemptStarted(bootMs + 40 * 60_000)
    clock.attemptEnded(bootMs + 70 * 60_000)

    await logQueueLivenessWedge(app, NOW, undefined, { clock })

    expect(auditOptions[0]).toMatchObject({ livenessEpoch: "2026-08-30T01:00:00.000Z" })
  })

  it("pages the owner once per ANNOUNCEMENT, on the reporter's own escalating schedule — never once per tick", async () => {
    const { app, warnings, errors } = appWithFindings([finding])
    const conditions = createConditionReporter(app.log)
    const pages: ResidentWedgePage[] = []
    const options = {
      generations: new Map<string, number>(),
      page: async (page: ResidentWedgePage) => void pages.push(page),
    }

    // Five ticks: announce, suppress, announce, suppress, suppress.
    for (let tick = 0; tick < 5; tick += 1) await logQueueLivenessWedge(app, NOW, conditions, options)

    // The page rides the log's own schedule, so the two can never disagree
    // about how loud this condition is.
    expect(pages).toHaveLength(warnings.length)
    expect(pages.map((page) => page.generation)).toEqual([1, 2])
    expect(pages[0]).toMatchObject({ base: "main", pr: "PR1", blockedMs: 5_100_000 })
    // Acceptance 4: escalating generations, and the runner is still alive to
    // send the next one.
    expect(errors).toEqual([])
  })

  it("pages nothing when the queue is draining", async () => {
    const { app } = appWithFindings([])
    const pages: ResidentWedgePage[] = []
    await logQueueLivenessWedge(app, NOW, undefined, { page: async (page) => void pages.push(page) })
    expect(pages).toEqual([])
  })
})

/**
 * The heartbeat's half of the pause (@i/10-yrd/24039). The maintenance tick
 * abstains while the clock is paused, but `startHabitantRunnerHeartbeat`
 * recomputes `queueProgress` every 5s regardless — so an epoch that only
 * folded in FINISHED attempts stayed frozen at the current attempt's start,
 * and 30 minutes into any attempt the audit's `noLandingMs` threshold was
 * crossed and `queue-liveness-wedged` reached service health. A 90-minute
 * affected-tests turn read as 60 minutes of no progress on the health probe.
 */
describe("createResidentLivenessClock — the attempt in flight", () => {
  const BOOT = Date.parse("2026-08-30T00:00:00.000Z")

  it("counts the attempt IN FLIGHT, so a mid-attempt sample measures from boot plus every attempted millisecond including this one", () => {
    const clock = createResidentLivenessClock(BOOT)

    // One finished 10-minute attempt, a 5-minute idle gap, then a second
    // attempt still running at the sampling instant.
    clock.attemptStarted(BOOT)
    clock.attemptEnded(BOOT + 10 * 60_000)
    clock.attemptStarted(BOOT + 15 * 60_000)

    const sampleMs = BOOT + 46 * 60_000 // 31 minutes into the live attempt
    expect(clock.epoch(sampleMs)).toBe(new Date(BOOT + (10 + 31) * 60_000).toISOString())
    // The 5 idle minutes are the only span the audit may bill as blocked, so
    // the epoch is still PAUSED, never CLEARED: it has not reached `sampleMs`.
    expect(Date.parse(clock.epoch(sampleMs))).toBe(sampleMs - 5 * 60_000)
  })

  it("is continuous across the end of an attempt — the same instant reads the same epoch before and after attemptEnded", () => {
    const clock = createResidentLivenessClock(BOOT)
    clock.attemptStarted(BOOT + 60_000)

    const endMs = BOOT + 91 * 60_000
    const before = clock.epoch(endMs)
    clock.attemptEnded(endMs)

    // No jump. `attemptEnded` folds in exactly the span `epoch` was already
    // counting, so a supervisor sampling one millisecond either side of the
    // boundary cannot see blocked time appear or vanish.
    expect(clock.epoch(endMs)).toBe(before)
  })

  it("never moves the epoch EARLIER when the clock runs backwards inside an attempt", () => {
    const clock = createResidentLivenessClock(BOOT)
    clock.attemptStarted(BOOT + 30 * 60_000)

    // An `io.now` fixture or an NTP step hands back an instant before the
    // attempt started. The floor may not subtract from what it already had.
    expect(clock.epoch(BOOT + 20 * 60_000)).toBe(new Date(BOOT).toISOString())
    expect(clock.epoch(BOOT + 40 * 60_000)).toBe(new Date(BOOT + 10 * 60_000).toISOString())
  })
})

/**
 * The seam the heartbeat actually crosses: `habitantQueueProgress` hands the
 * clock's reading to `queue.audit` as `livenessEpoch`, and the audit measures
 * `blockedMs = now - max(observed, epoch)`. Pinned here rather than only in
 * `queue-liveness-wedge.test.ts` because the arithmetic that broke was the
 * CALLER's: the audit was always correct about the epoch it was given.
 */
describe("habitantQueueProgress — the epoch it hands the audit mid-attempt", () => {
  it("hands the audit an epoch that tracks the sample, so blocked time cannot grow while an attempt is in flight", () => {
    const { app, auditOptions } = appWithFindings([])
    const bootMs = Date.parse("2026-08-30T00:00:00.000Z")
    const clock = createResidentLivenessClock(bootMs)

    // Ten idle minutes, then an attempt that has been running for 31 — one
    // minute past `noLandingMs`, which is where the old frozen floor started
    // publishing a wedge into service health.
    clock.attemptStarted(bootMs + 10 * 60_000)
    const sampleMs = bootMs + 41 * 60_000
    const sample = new Date(sampleMs).toISOString()

    habitantQueueProgress(app, sample, clock.epoch(sampleMs))

    expect(auditOptions).toHaveLength(1)
    // The epoch is the sample minus the IDLE time before the attempt, so the
    // audit's `now - max(observed, epoch)` can only ever reach 10 minutes for
    // as long as this attempt runs, whatever the queue's own history says.
    expect(auditOptions[0]).toMatchObject({
      now: sample,
      livenessEpoch: new Date(sampleMs - 10 * 60_000).toISOString(),
    })
    expect(sampleMs - Date.parse(String(auditOptions[0]?.livenessEpoch))).toBeLessThan(30 * 60_000)
  })
})

/**
 * Acceptance 5, first row: a resident booted into a journal whose last merge is
 * hours old attempts its first eligible member and emits no liveness row.
 *
 * The finding-side half of that row (the audit itself declining to emit under
 * an epoch) is pinned in `packages/yrd-queue/tests/queue-liveness-epoch.test.ts`;
 * this is the resident-side half — the tick that used to fire before any work
 * was attempted, and the exit that followed it.
 */
describe("a resident booted into a stale journal", () => {
  it("emits no liveness row on its first tick and reaches its first attempt alive", async () => {
    // The queue's own history: eligible work, last merge 1h25m ago. Under the
    // journal-only clock this is a finding on tick one. Under the runner's own
    // clock the audit declines to emit it, so `findings` is empty here for the
    // same reason production's would be.
    const harness = createHabitantHarness({ run: async () => [], audit: () => ({ findings: [] }) })
    const clock = createResidentLivenessClock(Date.parse("2026-08-30T00:09:00.000Z"))

    await logQueueLivenessWedge(harness.app, NOW, undefined, { clock })

    expect(harness.errors).toEqual([])
    expect(harness.warnings).toEqual([])
    // Nothing latched, so the pass is still the pass: the loop goes on to run
    // the queue rather than exiting 17 before touching a single member.
    await harness.app.queue.run({} as never, {} as never)
    expect(harness.runCalls()).toBe(1)
  })
})

/**
 * The shared habitant double, and why this block exists beside the two
 * hand-rolled ones above.
 *
 * Those two exist for ONE reason: `createHabitantHarness` had no `error` on its
 * log. `app.log.error?.()` is an optional call, so on that double every ERROR
 * the resident raises was a silent no-op — a runner that stood down loudly and
 * one that died saying nothing left identical transcripts, and no test using
 * the shared harness could tell them apart. Anything wanting to assert a loud
 * line had to bring its own app, which is how one file ends up with three.
 *
 * The harness now carries the stream, and this pins that it really is wired to
 * the same `log` the resident writes through — and, since 2026-09-02, that the
 * liveness row arrives on the WARN side of it.
 */
describe("logQueueLivenessWedge — through the SHARED habitant harness", () => {
  it("captures the wedge as a WARN, leaving the ERROR stream (which ends the pass) empty", async () => {
    const finding = {
      code: "queue-liveness-wedged",
      message: "Queue 'main' wedged",
      pr: "PR7",
      blockedMs: 3_600_000,
      since: "2026-08-29T23:10:00.000Z",
    }
    const harness = createHabitantHarness({ run: async () => [], audit: () => ({ findings: [finding] }) })

    await logQueueLivenessWedge(harness.app, NOW)

    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toMatchObject({
      message: finding.message,
      props: { action: "resident-queue-liveness-wedged", pr: "PR7" },
    })
    // The distinction the whole capability is for, inverted by 24034: the
    // wedge is reported, and the stream the host latches stays clean.
    expect(harness.errors).toEqual([])
  })

  it("stays silent when the queue is draining — an empty stream is a real answer", async () => {
    const harness = createHabitantHarness({ run: async () => [] })
    await logQueueLivenessWedge(harness.app, NOW)
    expect(harness.warnings).toEqual([])
    expect(harness.errors).toEqual([])
  })
})
