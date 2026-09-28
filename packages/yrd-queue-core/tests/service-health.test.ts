import { describe, expect, test } from "vitest"

import {
  absentHealthDocument,
  believableHealthDocument,
  exitedHealthDocument,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  parseQueueHealthDocument,
  QUEUE_HEALTH_SCHEMA,
  queueHealthExitCode,
  DEFAULT_STALL_AFTER_MS,
  lineStall,
  roundHealthDocument,
  STALLED_LINE_CODE,
  STUCK_RECORD_CODE,
  unreadableHealthDocument,
  withLineFlow,
} from "../src/service-health.ts"
import type { PauseRecord } from "../src/pause.ts"
import type { RunnerClaim } from "../src/runner-claim.ts"
import { judgeRunnerDue } from "../src/runner-claim.ts"
import { roundBoundMs } from "../src/check.ts"

// A stuck change STOPS THE LINE (the andon, operator 2026-09-16): the queue
// pauses itself naming the change, the service stays up holding the stop, and
// the document is the page. These assert the page reads the stop, names the
// stuck record's cures, and never promises to clear by itself.

const INTERVAL = 120_000
const NOW = new Date("2026-09-11T12:00:00.000Z")
const HEAD = "a".repeat(40)

/** A stop the queue put on itself for task/one, carrying its stuck record's cures. */
const stuckStop: PauseRecord = {
  at: new Date("2026-09-11T11:58:00.000Z"),
  by: "yrd",
  cause: "stuck",
  change: { branch: "task/one", head: HEAD },
  kind: "paused",
  next: "repair the queue setup, then run yrd queue run; four ways out of the line: yrd queue withdraw task/one",
  reason: "the queue could not prepare a worktree for task/one: setup exited 1",
  sha: "b".repeat(40),
}

/** A person's pause: deliberate, and nobody's page. */
const operatorStop: PauseRecord = {
  at: new Date("2026-09-11T11:58:00.000Z"),
  by: "@chief",
  cause: "operator",
  kind: "paused",
  reason: "49 new failures on main",
  sha: "c".repeat(40),
}

describe("the health document", () => {
  /** @failure An off-relaunch exit left a running document that aged overdue without its known cause. @level l1 */
  test("a detected terminal exit leaves a parseable stopped document without an error or deadline", () => {
    const exited = {
      kind: "declaration-unreadable" as const,
      detail: "origin/main has malformed .yrd.yml",
      exitCode: 2,
      at: NOW.toISOString(),
    }
    const doc = exitedHealthDocument("yrd", exited)
    expect(doc).toMatchObject({ state: "absent", verdict: { kind: "stopped" }, facts: { serviceExited: exited } })
    expect(doc).not.toHaveProperty("error")
    expect(doc.facts).not.toHaveProperty("staleAfter")
    expect(parseQueueHealthDocument(JSON.stringify(doc))).toEqual(doc)
  })
  test("a running line is healthy and running, and says it is not stopped", () => {
    const doc = roundHealthDocument("yrd", undefined, INTERVAL, NOW)
    expect(doc).toMatchObject({ schema: QUEUE_HEALTH_SCHEMA, state: "healthy", verdict: { kind: "running" } })
    expect(doc.error).toBeUndefined()
    expect(doc.facts).toMatchObject({ stopped: null })
    expect(queueHealthExitCode(doc.state)).toBe(0)
  })

  // unhealthy + RUNNING is the combination the supervisor pages on without a
  // restart — the service is alive and HOLDING the stop. A stuck stop that
  // reported `stopped` would be claiming the loop had died.
  test("a stuck stop is unhealthy and still running, names the change and its cures, and never clears by itself", () => {
    const doc = roundHealthDocument("yrd", stuckStop, INTERVAL, NOW)
    expect(doc.state).toBe("unhealthy")
    expect(doc.verdict).toEqual({ kind: "running" })
    expect(doc.error?.code).toBe("queue-round-stuck")
    // The page names the stuck RECORD's code, the change and the reason, so a
    // reader who has not got the journal open still knows what stopped.
    expect(doc.error?.cause).toContain(STUCK_RECORD_CODE)
    expect(doc.error?.cause).toContain(`task/one@${HEAD}`)
    expect(doc.error?.cause).toContain(stuckStop.reason)
    // The body IS the stuck record's cures, carried on the stop, verbatim.
    expect(doc.error?.resolution[0]).toBe(stuckStop.next)
    const body = doc.error?.resolution.join(" ") ?? ""
    expect(body).toMatch(/No restart is needed/u)
    expect(body).toContain("yrd queue show task/one")
    expect(body).not.toMatch(/clears on its own|next round|resets the spacing|Consecutive rounds/u)
    expect(doc.facts).toMatchObject({
      nextRoundInMs: INTERVAL,
      stopped: { by: "yrd", cause: "stuck", change: `task/one@${HEAD}`, since: stuckStop.at.toISOString() },
    })
    expect(doc.facts?.stuckRounds).toBeUndefined()
    expect(queueHealthExitCode(doc.state)).toBe(2)
  })

  test("a remote read failure remains visible beneath an existing stuck record", () => {
    const failure = { ref: "refs/yrd/main/changes/task/one", error: "remote read timed out", count: 3 }
    const doc = roundHealthDocument("yrd", stuckStop, INTERVAL, NOW, undefined, failure)
    expect(doc.error?.code).toBe("queue-round-stuck")
    expect(doc.facts?.roundReadFailure).toEqual(failure)
  })

  // A person's pause is deliberate: it stops the line and pages nobody, and
  // the document still says who stopped it.
  test("an operator's pause is healthy, and names who stopped the line", () => {
    const doc = roundHealthDocument("yrd", operatorStop, INTERVAL, NOW)
    expect(doc.state).toBe("healthy")
    expect(doc.error).toBeUndefined()
    expect(doc.facts).toMatchObject({ stopped: { by: "@chief", cause: "operator", change: null } })
  })

  /** @failure 25041: a pre-cutover stuck event has no legacy stuck pause; both facts may also stand together.
   * @level l1 @consumer Hab's yrd health page
   */
  test("a stuck event pages with its resume action beside a standing operator pause", () => {
    const doc = roundHealthDocument("yrd", operatorStop, INTERVAL, NOW, undefined, undefined, ["task/one"])
    expect(doc.state).toBe("unhealthy")
    expect(doc.error?.cause).toContain("stuck change task/one")
    expect(doc.error?.cause).toContain("operator pause also stands")
    expect(doc.error?.resolution.join(" ")).toContain("yrd queue resume")
    expect(doc.facts).toMatchObject({
      stopped: { by: "@chief", cause: "operator" },
      stuckChanges: ["task/one"],
    })
  })

  // absent + stopped, never unhealthy: nothing claimed this service. Reporting
  // unhealthy here would page for a service nobody started.
  test("no document at all is absent and stopped, not unhealthy", () => {
    const doc = absentHealthDocument("yrd", "no round has finished")
    expect(doc.state).toBe("absent")
    expect(doc.verdict).toEqual({ kind: "stopped" })
    expect(queueHealthExitCode(doc.state)).toBe(1)
  })

  test("a broken document is unknown/unparsed and quotes what it saw", () => {
    const doc = unreadableHealthDocument("yrd", "trailing garbage", '{"schema":')
    expect(doc.state).toBe("unknown")
    expect(doc.verdict).toEqual({ kind: "unknown", reason: "unparsed", observed: '{"schema":' })
    expect(queueHealthExitCode(doc.state)).toBe(3)
  })

  test("the exit ladder is exactly the supervisor's", () => {
    expect((["healthy", "absent", "unhealthy", "unknown"] as const).map((state) => queueHealthExitCode(state))).toEqual(
      [0, 1, 2, 3],
    )
  })
})

describe("reading a stored document", () => {
  test("round-trips what the loop wrote", () => {
    const written = roundHealthDocument("yrd", stuckStop, INTERVAL, NOW)
    expect(parseQueueHealthDocument(JSON.stringify(written))).toEqual(written)
  })

  // Negative controls: each is "not a health document" for a different reason,
  // and each must be distinguishable from a document that says something.
  test.each([
    ["not json at all", "yrd: stuck task/one"],
    ["json that is not an object", "[1,2,3]"],
    ["another schema", '{"schema":"hab-service-health/1","state":"healthy"}'],
    ["no state", `{"schema":"${QUEUE_HEALTH_SCHEMA}"}`],
    ["a state nobody defined", `{"schema":"${QUEUE_HEALTH_SCHEMA}","state":"degraded"}`],
  ])("%s is not a document", (_why, text) => {
    expect(parseQueueHealthDocument(text)).toBeUndefined()
  })
})

/**
 * @failure  The writer stops writing — its process gone or its event loop held —
 *           and the probe keeps printing the last `healthy` for as long as that
 *           lasts: an instrument asserting a verdict it did not measure, getting
 *           more confident the longer the outage runs. Worse than no probe at
 *           all, because a page that never opens reads exactly like a service
 *           that is fine (@cto follow-up F1, 2026-09-11).
 * @level    l1
 * @consumer the supervisor, which pages on unhealthy-while-running
 */
describe("a document expires", () => {
  const written = (sleepMs: number) => roundHealthDocument("yrd", undefined, sleepMs, NOW)
  const at = (ms: number) => new Date(NOW.getTime() + ms)
  /** One heartbeat plus grace: how long any document is believed after its write (24523 F4). */
  const WINDOW = HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS

  test("carries when it was written and when it stops being believable", () => {
    const doc = written(INTERVAL)
    expect(doc.facts).toMatchObject({
      writtenAt: NOW.toISOString(),
      staleAfter: at(WINDOW).toISOString(),
    })
  })

  // The deadline is one heartbeat plus grace, whatever sleep the round chose.
  // The loop restates its document through the sleep, so a deliberate
  // thirty-minute interval stays fresh by being rewritten, never by a deadline
  // stretched to cover it (24523 F4).
  test("a long deliberate interval does not move the deadline", () => {
    const long = 30 * 60 * 1000
    const doc = written(long)
    expect(doc.facts).toMatchObject({ nextRoundInMs: long, staleAfter: at(WINDOW).toISOString() })
  })

  test("is believed right up to its deadline", () => {
    const doc = written(INTERVAL)
    expect(believableHealthDocument(doc, at(WINDOW))).toEqual(doc)
  })

  // THE ONE THAT MATTERS: a stale HEALTHY is the confident lie.
  test("past its deadline a healthy document reads OVERDUE, and names when it was written", () => {
    const doc = written(INTERVAL)
    const overdue = believableHealthDocument(doc, at(WINDOW + 60_000))
    expect(overdue.state).toBe("unhealthy")
    expect(overdue.verdict).toEqual({ kind: "running" })
    expect(overdue.error?.code).toBe("queue-round-overdue")
    expect(overdue.error?.cause).toContain(NOW.toISOString())
    expect(overdue.facts).toMatchObject({ overdueBy: 60_000 })
    expect(queueHealthExitCode(overdue.state)).toBe(2)
  })

  test("overdue outranks a stale unhealthy too — the interesting fact is that nothing has been written since", () => {
    const doc = roundHealthDocument("yrd", stuckStop, INTERVAL, NOW)
    expect(doc.error?.code).toBe("queue-round-stuck")
    const overdue = believableHealthDocument(doc, at(WINDOW + 1))
    expect(overdue.error?.code).toBe("queue-round-overdue")
  })

  // NEGATIVE CONTROL, and it is why expiry is a written field rather than a
  // reader-side assumption: a document from a loop that predates this change
  // has no deadline, and the ABSENCE of one is not evidence that one passed.
  test("a document with no deadline is passed through, never declared overdue", () => {
    const old = {
      schema: QUEUE_HEALTH_SCHEMA,
      service: "yrd",
      state: "healthy",
      verdict: { kind: "running" },
    } as const
    expect(believableHealthDocument(old, at(10 * 365 * 24 * 60 * 60 * 1000))).toEqual(old)
  })

  test("an unparseable deadline is passed through rather than guessed at", () => {
    const doc = { ...written(INTERVAL), facts: { writtenAt: "x", staleAfter: "not a date" } }
    expect(believableHealthDocument(doc, at(999_999_999))).toEqual(doc)
  })

  // R5 (@i/4-supervision/24523). Only the service writes this document. A page
  // promising that ANY finished round clears it sends its reader to run one by
  // hand, and a hand `yrd queue run` writes nothing here, so the page stands and
  // the reader concludes the queue itself is broken.
  test("the overdue page says a hand yrd queue run does not write this document", () => {
    // Written out rather than built, so the deadline is this test's and not a builder's formula.
    const doc = {
      schema: QUEUE_HEALTH_SCHEMA,
      service: "yrd",
      state: "healthy",
      verdict: { kind: "running" },
      facts: { writtenAt: NOW.toISOString(), staleAfter: at(INTERVAL).toISOString(), stopped: null },
    } as const
    const overdue = believableHealthDocument(doc, at(INTERVAL + 1))
    expect(overdue.error?.code).toBe("queue-round-overdue")
    const body = overdue.error?.resolution.join("\n") ?? ""
    expect(body).toMatch(/a hand `yrd queue run` does not write this document/iu)
    expect(body).not.toContain("any round finishes")
  })
})

// THE CONTRACT TEST THAT USED TO SIT HERE HAS MOVED TO THE ROOT, to
// `tools/yrd-runner-service.test.ts`, and it is checked on every root run.
//
// It asserted that every document these builders emit is accepted by hab's
// `hab-service-health/2` parser — the rule a live probe broke on 2026-09-11,
// paging `health-not-measured` while all 726 tests here were green. This
// package is standalone and must not depend on the host that vendors it, so
// the version living here had to REPRODUCE hab's placement rules, and a
// reproduced rule drifts from the one actually enforced. The root holds both
// sides, so the root test imports `parseHabServiceObservedHealth` itself and
// fails when EITHER side changes.
//
// It also reaches ground this copy could not: the parser checks the EXIT
// LADDER and the state x verdict pairing, and a document-only checker sees
// neither. If you change `roundHealthDocument`, `absentHealthDocument`,
// `unreadableHealthDocument`, `believableHealthDocument` or
// `queueHealthExitCode`, that root test is the one that will catch you.

// 25669: a line holding waiting changes that judges none reads STALLED. This is
// the port of the flow instrument the old core carried (08-10
// queueProgressAuditFindings, 08-30 queue-liveness-wedged) and lost on 09-03 in
// b5b468037c; on 09-24 a line stood still for over an hour while health read
// healthy. Clock and wording per @cto fa6f3457 and d3af5793.
describe("a waiting line that judges nothing reads stalled (25669)", () => {
  const at = (iso: string) => new Date(`2026-09-24T${iso}Z`)
  const minutes = (n: number) => n * 60_000
  const threshold = { declared: false, ms: DEFAULT_STALL_AFTER_MS }
  const oldest = { branch: "task/oldest", openedAt: "2026-09-24T19:00:00.000Z" }

  test("waiting changes and no judgement past the threshold: a stopped line, naming the round, the waiting and the threshold", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T19:40:00.000Z",
      lastRoundEndedAt: "2026-09-24T20:20:00.000Z",
      oldestWaiting: oldest,
      waiting: 16,
    }
    const stall = lineStall(flow, threshold, at("20:27:00"))
    expect(stall?.shape).toBe("stopped-line")
    expect(stall?.forMs).toBe(minutes(47))
    expect(stall?.cause).toBe(
      "no round running; last completed round at 20:20Z judged nothing while 16 waited; " +
        "no change judged for 47m (oldest waiting task/oldest, opened 1h27m ago); " +
        "threshold 45m (.yrd.yml health.stallAfter, default)",
    )
  })

  test("a round still open past the threshold is the slow-round shape, naming its branch and how long it has run", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T19:40:00.000Z",
      oldestWaiting: oldest,
      roundOpen: { branch: "task/slow", startedAt: "2026-09-24T19:35:00.000Z" },
      waiting: 3,
    }
    const stall = lineStall(flow, { declared: true, ms: minutes(45) }, at("20:30:00"))
    expect(stall?.shape).toBe("slow-round")
    expect(stall?.cause).toBe(
      "a round has been running its checks for 55m on task/slow; " +
        "no change judged for 50m (oldest waiting task/oldest, opened 1h30m ago); " +
        "threshold 45m (.yrd.yml health.stallAfter)",
    )
  })

  test("the slow-round page names the phase the round is in, or why its journal could not say", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T19:40:00.000Z",
      oldestWaiting: oldest,
      roundOpen: { branch: "task/slow", phase: "merge test", startedAt: "2026-09-24T19:35:00.000Z" },
      waiting: 3,
    }
    expect(lineStall(flow, threshold, at("20:30:00"))?.cause).toContain(
      "a round has been running its checks for 55m on task/slow, at merge test; ",
    )
    const unread = { ...flow, roundOpen: { phaseUnread: "no journal", startedAt: "2026-09-24T19:35:00.000Z" } }
    expect(lineStall(unread, threshold, at("20:30:00"))?.cause).toContain("for 55m (phase unread: no journal); ")
  })

  test("an open round pages only after its current declared deadline plus three beats", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T19:40:00.000Z",
      oldestWaiting: oldest,
      roundOpen: { branch: "task/slow", phase: "affected-tests", startedAt: "2026-09-24T19:35:00.000Z" },
      waiting: 3,
    }
    const claim: RunnerClaim = {
      host: "queue-host",
      pid: 42,
      started: "2026-09-24T19:00:00.000Z",
      at: "2026-09-24T20:31:00.000Z",
      beatMs: 60_000,
      state: "checking",
      since: "2026-09-24T20:00:00.000Z",
      deadline: "2026-09-24T20:30:00.000Z",
    }
    expect(lineStall(flow, threshold, at("20:32:59"), claim)).toBeUndefined()
    expect(lineStall(flow, threshold, new Date("2026-09-24T20:33:00.001Z"), claim)).toMatchObject({
      shape: "slow-round",
      cause: expect.stringContaining(
        "round past its declared bound (affected-tests, bound 30m, since 2026-09-24T20:00:00.000Z)",
      ),
    })
    const local = roundHealthDocument("yrd", undefined, INTERVAL, at("20:32:59"), { flow, threshold, claim })
    expect(local.state).toBe("healthy")
    expect(local.facts?.flow).toMatchObject({ deadline: claim.deadline })
    const stored = { ...local, facts: { ...local.facts, runnerClaim: claim, runnerPhase: "affected-tests" } }
    expect(believableHealthDocument(stored, new Date("2026-09-24T20:33:00.001Z"))).toMatchObject({
      state: "unhealthy",
      error: { code: STALLED_LINE_CODE, cause: expect.stringContaining("round past its declared bound") },
    })
    expect(believableHealthDocument(stored, new Date("2026-09-24T20:33:00.001Z")).error?.resolution).toContain(
      "This page clears when the phase advances within its new bound or a change is judged; it never clears merely because time passes.",
    )
    expect(
      roundHealthDocument("yrd", undefined, INTERVAL, new Date("2026-09-24T20:33:00.001Z"), { flow, threshold, claim })
        .state,
    ).toBe("unhealthy")
    const legacy = { ...claim, deadline: undefined }
    expect(lineStall(flow, threshold, at("20:30:00"), legacy)?.cause).toContain(
      "deadline unavailable: writer predates Deadline; 45m fallback",
    )
    expect(
      roundHealthDocument("yrd", stuckStop, INTERVAL, new Date("2026-09-24T20:33:00.001Z"), { flow, threshold, claim })
        .error?.code,
    ).toBe("queue-round-stuck")
    const hungStep: RunnerClaim = { ...claim, state: "merging" }
    expect(
      lineStall(
        { ...flow, roundOpen: { ...flow.roundOpen, phase: "merge" } },
        threshold,
        new Date("2026-09-24T20:33:00.001Z"),
        hungStep,
      )?.cause,
    ).toBe("step merge past its declared bound (30m, since 2026-09-24T20:00:00.000Z); the runner does not cancel it")
  })

  test("idle is not stalled: nothing waiting never reads stalled, however long since the last judgement", () => {
    const flow = { lastJudgedAt: "2026-09-24T09:00:00.000Z", waiting: 0 }
    expect(lineStall(flow, threshold, at("20:00:00"))).toBeUndefined()
  })

  /** @failure Phase transitions could keep a round green after its total published Due. @level l1 */
  test("whole-round Due pages with the same cause in the live and stored health readings", () => {
    const now = new Date("2026-09-24T20:53:00.001Z")
    const claim: RunnerClaim = {
      host: "queue-host",
      pid: 42,
      started: "2026-09-24T19:00:00.000Z",
      round: "2026-09-24T19:35:00.000Z",
      due: "2026-09-24T20:50:00.000Z",
      candidates: 3,
      at: "2026-09-24T20:53:00.000Z",
      beatMs: 60_000,
      state: "checking",
      since: "2026-09-24T20:45:00.000Z",
      deadline: "2026-09-24T21:15:00.000Z",
    }
    const flow = {
      waiting: 3,
      oldestWaiting: oldest,
      roundOpen: { startedAt: "2026-09-24T19:35:00.000Z", phase: "hold" },
    }
    const reason = judgeRunnerDue(claim, now).reason
    expect(lineStall(flow, threshold, new Date("2026-09-24T20:53:00.000Z"), claim)).toBeUndefined()
    expect(lineStall(flow, threshold, now, claim)).toMatchObject({ shape: "total-round", cause: reason })
    const live = roundHealthDocument("yrd", undefined, INTERVAL, now, { flow, threshold, claim })
    expect(live.error?.cause).toBe(reason)
    const stored = roundHealthDocument("yrd", undefined, INTERVAL, new Date("2026-09-24T20:52:59.000Z"), {
      flow,
      threshold,
      claim,
    })
    expect(
      believableHealthDocument({ ...stored, facts: { ...stored.facts, runnerClaim: claim, runnerPhase: "hold" } }, now)
        .error?.cause,
    ).toBe(reason)
  })

  /** @failure 24570: the old 45-minute clock paged a healthy round during its third declared check.
   * @level l2 @consumer the local health reader and remote claim reader
   */
  test("three 25-minute checks stay unpaged while each phase and the whole round remain in bound", () => {
    const round = "2026-09-24T19:00:00.000Z"
    const checks = ["first", "second", "third"].map((name) => ({
      name,
      on: ["submit" as const],
      run: "test",
      timeoutMs: minutes(25),
    }))
    const totalBound = roundBoundMs(checks, undefined, 1)
    expect(totalBound).toBeGreaterThan(minutes(75))
    const due = new Date(Date.parse(round) + totalBound).toISOString()
    const flow = {
      waiting: 1,
      oldestWaiting: { branch: "task/long", openedAt: round },
      roundOpen: { startedAt: round },
    }
    for (const [phase, since, at] of [
      ["first", "2026-09-24T19:00:00.000Z", "2026-09-24T19:20:00.000Z"],
      ["second", "2026-09-24T19:25:00.000Z", "2026-09-24T19:47:00.000Z"],
      ["third", "2026-09-24T19:50:00.000Z", "2026-09-24T20:12:00.000Z"],
    ] as const) {
      const now = new Date(at)
      const claim: RunnerClaim = {
        host: "queue-host",
        pid: 42,
        started: round,
        round,
        due,
        candidates: 1,
        at,
        beatMs: 60_000,
        state: "checking",
        since,
        deadline: new Date(Date.parse(since) + minutes(25)).toISOString(),
      }
      const document = roundHealthDocument("yrd", undefined, INTERVAL, now, {
        flow: { ...flow, roundOpen: { ...flow.roundOpen, phase } },
        threshold,
        claim,
      })
      expect(document.state, phase).toBe("healthy")
      expect(document.error, phase).toBeUndefined()
      expect(believableHealthDocument(document, now).error, phase).toBeUndefined()
    }
  })

  /** @failure 24570: a pre-plan hang could fall through the legacy 45-minute clock instead of its line-read bound.
   * @level l2 @consumer a queue health reader before the first line observation
   */
  test("a pre-plan line read pages at its phase deadline plus three beats", () => {
    const round = "2026-09-24T19:00:00.000Z"
    const claim: RunnerClaim = {
      host: "queue-host",
      pid: 42,
      started: round,
      at: "2026-09-24T19:33:00.000Z",
      beatMs: 60_000,
      state: "provisioning",
      since: round,
      deadline: "2026-09-24T19:30:00.000Z",
    }
    const flow = {
      waiting: 1,
      oldestWaiting: { branch: "task/long", openedAt: round },
      roundOpen: { startedAt: round, phase: "line-read" },
    }
    expect(lineStall(flow, threshold, at("19:33:00"), claim)).toBeUndefined()
    const page = roundHealthDocument("yrd", undefined, INTERVAL, new Date("2026-09-24T19:33:00.001Z"), {
      flow,
      threshold,
      claim,
    })
    expect(page).toMatchObject({
      state: "unhealthy",
      error: { code: STALLED_LINE_CODE, cause: expect.stringContaining("line-read") },
    })
  })

  test("the clock starts at the later of the last judgement and the oldest change's opening, so a submit after idle hours does not page at once", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T09:00:00.000Z",
      oldestWaiting: { branch: "task/new", openedAt: "2026-09-24T20:00:00.000Z" },
      waiting: 1,
    }
    expect(lineStall(flow, threshold, at("20:44:59"))).toBeUndefined()
    expect(lineStall(flow, threshold, at("20:45:00"))?.forMs).toBe(minutes(45))
  })

  test("one minute short of the threshold is not stalled, and a judgement resets the clock", () => {
    const flow = { lastJudgedAt: "2026-09-24T20:00:00.000Z", oldestWaiting: oldest, waiting: 4 }
    expect(lineStall(flow, threshold, at("20:44:00"))).toBeUndefined()
    expect(lineStall(flow, threshold, at("20:45:00"))).toBeDefined()
    expect(lineStall({ ...flow, lastJudgedAt: "2026-09-24T20:44:30.000Z" }, threshold, at("20:45:00"))).toBeUndefined()
  })

  test("the round document pages a stalled line as unhealthy with its own code, and carries the flow either way", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T19:40:00.000Z",
      lastRoundEndedAt: "2026-09-24T20:20:00.000Z",
      oldestWaiting: oldest,
      waiting: 16,
    }
    const stalled = roundHealthDocument("yrd", undefined, INTERVAL, at("20:27:00"), { flow, threshold })
    expect(stalled.state).toBe("unhealthy")
    expect(stalled.verdict).toEqual({ kind: "running" })
    expect(stalled.error?.code).toBe(STALLED_LINE_CODE)
    expect(stalled.error?.cause).toContain("judged nothing while 16 waited")
    expect((stalled.error?.resolution ?? []).join("\n")).toContain("yrd queue show task/oldest")
    expect(stalled.facts?.flow).toMatchObject({
      stallAfterMs: DEFAULT_STALL_AFTER_MS,
      stalledForMs: minutes(47),
      waiting: 16,
    })

    const flowing = roundHealthDocument("yrd", undefined, INTERVAL, at("19:50:00"), { flow, threshold })
    expect(flowing.state).toBe("healthy")
    expect(flowing.facts?.flow).toMatchObject({ waiting: 16 })
    expect(flowing.facts?.flow).not.toHaveProperty("stalledForMs")
  })

  /** @failure 25708: repeated refused CAS attempts stayed invisible while the service kept heartbeating. */
  test("three confirmed CAS refusals page through the existing line health and two do not", () => {
    const refusal = { branch: "task/cas", ref: "refs/yrd/main/changes/task/cas", marker: HEAD, count: 3 }
    const flow = {
      waiting: 1,
      oldestWaiting: { branch: "task/cas", openedAt: "2026-09-24T20:20:00.000Z" },
      casRefused: refusal,
    }
    const quiet = roundHealthDocument("yrd", undefined, INTERVAL, at("20:27:00"), {
      flow: { ...flow, casRefused: { ...refusal, count: 2 } },
      threshold,
    })
    expect(quiet.state).toBe("healthy")
    const paged = roundHealthDocument("yrd", undefined, INTERVAL, at("20:27:00"), { flow, threshold })
    expect(paged.state).toBe("unhealthy")
    expect(paged.error?.code).toBe(STALLED_LINE_CODE)
    expect(paged.error?.cause).toContain(refusal.ref)
    expect(paged.facts?.flow).toMatchObject({ stalledShape: "cas-refused", casRefused: refusal })
    const uncertain = roundHealthDocument("yrd", undefined, INTERVAL, at("20:27:00"), {
      flow: {
        ...flow,
        casRefused: {
          ...refusal,
          firstAt: "2026-09-24T20:25:00.000Z",
          windowExhausted: {
            name: "cas-history-journals",
            journals: 128,
            oldestFile: "q-20260924T200000000Z-old",
          },
        },
      },
      threshold,
    })
    expect(uncertain.error?.cause).toContain("first observed at 2026-09-24T20:25:00.000Z")
    expect(uncertain.error?.cause).toContain("earlier refusals may lie beyond the cas-history-journals 128 files scan")
    const cleared = withLineFlow(
      paged,
      undefined,
      { flow: { waiting: 1, oldestWaiting: flow.oldestWaiting }, threshold },
      at("20:28:00"),
    )
    expect(cleared.state).toBe("healthy")
    expect(cleared.error).toBeUndefined()
  })

  /** @failure 25708: a living service could fail every remote reread while its heartbeat claimed health.
   * @level l2 @consumer queue operator and Hab health probe
   */
  test("three failed remote-read rounds page once and a successful round clears the page", () => {
    const ref = "refs/yrd/main/changes/task/read-failed"
    const failure = { ref, error: "remote reread: network unavailable", count: 2 }
    const quiet = roundHealthDocument("yrd", undefined, INTERVAL, at("20:27:00"), undefined, failure)
    expect(quiet.state).toBe("healthy")
    expect(quiet.facts?.roundReadFailure).toEqual(failure)

    const paged = roundHealthDocument("yrd", undefined, INTERVAL, at("20:27:00"), undefined, { ...failure, count: 3 })
    expect(paged.state).toBe("unhealthy")
    expect(paged.error?.code).toBe(STALLED_LINE_CODE)
    expect(paged.error?.cause).toContain(ref)
    expect(paged.error?.cause).toContain(failure.error)

    const stillPaged = roundHealthDocument("yrd", undefined, INTERVAL, at("20:28:00"), undefined, {
      ...failure,
      count: 4,
    })
    expect(stillPaged.state).toBe("unhealthy")
    expect(stillPaged.error?.code).toBe(STALLED_LINE_CODE)
    expect(roundHealthDocument("yrd", undefined, INTERVAL, at("20:29:00")).state).toBe("healthy")
  })

  test("past the round budget with no judgement the document says slow, before any page (row 2)", () => {
    const flow = { lastJudgedAt: "2026-09-24T20:00:00.000Z", oldestWaiting: oldest, waiting: 5 }
    const early = roundHealthDocument("yrd", undefined, INTERVAL, at("20:10:00"), { flow, threshold })
    expect(early.facts?.flow).toMatchObject({ slow: false, unjudgedForMs: minutes(10) })
    const slow = roundHealthDocument("yrd", undefined, INTERVAL, at("20:12:00"), { flow, threshold })
    expect(slow.state).toBe("healthy")
    expect(slow.facts?.flow).toMatchObject({ slow: true, unjudgedForMs: minutes(12) })
    const idle = roundHealthDocument("yrd", undefined, INTERVAL, at("23:00:00"), { flow: { waiting: 0 }, threshold })
    expect(idle.facts?.flow).not.toHaveProperty("slow")
    expect(idle.facts?.flow).not.toHaveProperty("unjudgedForMs")
  })

  test("a stuck stop outranks stalled: the stuck page stands and names the stuck change", () => {
    const flow = { lastJudgedAt: "2026-09-24T19:40:00.000Z", oldestWaiting: oldest, waiting: 16 }
    const doc = roundHealthDocument("yrd", stuckStop, INTERVAL, at("21:00:00"), { flow, threshold })
    expect(doc.error?.code).toBe("queue-round-stuck")
  })

  test("an operator's pause is deliberate: a paused line never reads stalled", () => {
    const flow = { lastJudgedAt: "2026-09-24T19:40:00.000Z", oldestWaiting: oldest, waiting: 16 }
    const doc = roundHealthDocument("yrd", operatorStop, INTERVAL, at("21:00:00"), { flow, threshold })
    expect(doc.state).toBe("healthy")
    expect(doc.facts?.flow).toMatchObject({ waiting: 16 })
  })

  test("the heartbeat re-judges the flow on its own clock: healthy at round end becomes stalled mid-round, then clears on a judgement", () => {
    const flow = {
      lastJudgedAt: "2026-09-24T19:40:00.000Z",
      oldestWaiting: oldest,
      roundOpen: { startedAt: "2026-09-24T19:41:00.000Z" },
      waiting: 5,
    }
    const reading = { flow, threshold }
    const atRoundStart = roundHealthDocument("yrd", undefined, INTERVAL, at("19:41:00"), reading)
    expect(atRoundStart.state).toBe("healthy")
    const midRound = withLineFlow(atRoundStart, undefined, reading, at("20:26:00"))
    expect(midRound.state).toBe("unhealthy")
    expect(midRound.error?.code).toBe(STALLED_LINE_CODE)
    expect(midRound.error?.cause).toMatch(/^a round has been running its checks for 45m; no change judged for 46m/u)
    const judged = withLineFlow(
      midRound,
      undefined,
      { flow: { ...flow, lastJudgedAt: "2026-09-24T20:26:30.000Z" }, threshold },
      at("20:27:00"),
    )
    expect(judged.state).toBe("healthy")
    expect(judged.error).toBeUndefined()
  })

  test("another page stands: a stall never overwrites the page a document already carries", () => {
    const flow = { lastJudgedAt: "2026-09-24T19:40:00.000Z", oldestWaiting: oldest, waiting: 16 }
    const relaunch = {
      ...roundHealthDocument("yrd", undefined, INTERVAL, at("21:00:00")),
      state: "unhealthy" as const,
      error: { code: "queue-relaunch-stalled", cause: "waiting on a checkout", resolution: [] },
    }
    const restated = withLineFlow(relaunch, undefined, { flow, threshold }, at("21:00:00"))
    expect(restated.error?.code).toBe("queue-relaunch-stalled")
    expect(restated.facts?.flow).toMatchObject({ waiting: 16 })
  })
})
