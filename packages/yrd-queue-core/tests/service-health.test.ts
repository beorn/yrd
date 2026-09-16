import { describe, expect, test } from "vitest"

import {
  absentHealthDocument,
  believableHealthDocument,
  parseQueueHealthDocument,
  QUEUE_HEALTH_SCHEMA,
  queueHealthExitCode,
  ROUND_BUDGET_MS,
  roundHealthDocument,
  STUCK_RECORD_CODE,
  unreadableHealthDocument,
} from "../src/service-health.ts"
import type { PauseRecord } from "../src/pause.ts"

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
  next: "repair the queue setup, then run yrd queue run; three ways out of the line: yrd queue withdraw task/one",
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
  test("a running line is healthy and running, and says it is not stopped", () => {
    const doc = roundHealthDocument("yrd-service", undefined, INTERVAL, NOW)
    expect(doc).toMatchObject({ schema: QUEUE_HEALTH_SCHEMA, state: "healthy", verdict: { kind: "running" } })
    expect(doc.error).toBeUndefined()
    expect(doc.facts).toMatchObject({ stopped: null })
    expect(queueHealthExitCode(doc.state)).toBe(0)
  })

  // unhealthy + RUNNING is the combination the supervisor pages on without a
  // restart — the service is alive and HOLDING the stop. A stuck stop that
  // reported `stopped` would be claiming the loop had died.
  test("a stuck stop is unhealthy and still running, names the change and its cures, and never clears by itself", () => {
    const doc = roundHealthDocument("yrd-service", stuckStop, INTERVAL, NOW)
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

  // A person's pause is deliberate: it stops the line and pages nobody, and
  // the document still says who stopped it.
  test("an operator's pause is healthy, and names who stopped the line", () => {
    const doc = roundHealthDocument("yrd-service", operatorStop, INTERVAL, NOW)
    expect(doc.state).toBe("healthy")
    expect(doc.error).toBeUndefined()
    expect(doc.facts).toMatchObject({ stopped: { by: "@chief", cause: "operator", change: null } })
  })

  // absent + stopped, never unhealthy: nothing claimed this service. Reporting
  // unhealthy here would page for a service nobody started.
  test("no document at all is absent and stopped, not unhealthy", () => {
    const doc = absentHealthDocument("yrd-service", "no round has finished")
    expect(doc.state).toBe("absent")
    expect(doc.verdict).toEqual({ kind: "stopped" })
    expect(queueHealthExitCode(doc.state)).toBe(1)
  })

  test("a broken document is unknown/unparsed and quotes what it saw", () => {
    const doc = unreadableHealthDocument("yrd-service", "trailing garbage", '{"schema":')
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
    const written = roundHealthDocument("yrd-service", stuckStop, INTERVAL, NOW)
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
 * @failure  A round hangs inside the run, the loop never writes again, and the
 *           probe keeps printing the last round's `healthy` for as long as the
 *           hang lasts — an instrument asserting a verdict it did not measure,
 *           getting more confident the longer the outage runs. Worse than no
 *           probe at all, because a page that never opens reads exactly like a
 *           service that is fine (@cto follow-up F1, 2026-09-11).
 * @level    l1
 * @consumer the supervisor, which pages on unhealthy-while-running
 */
describe("a document expires", () => {
  const written = (sleepMs: number) => roundHealthDocument("yrd-service", undefined, sleepMs, NOW)
  const at = (ms: number) => new Date(NOW.getTime() + ms)

  test("carries when it was written and when it stops being believable", () => {
    const doc = written(INTERVAL)
    expect(doc.facts).toMatchObject({
      writtenAt: NOW.toISOString(),
      staleAfter: at(INTERVAL + ROUND_BUDGET_MS).toISOString(),
    })
  })

  // The deadline is the loop's OWN sleep plus a budget, never a fixed cadence a
  // reader assumed — so a deliberate thirty-minute interval is not overdue at
  // minute eleven.
  test("a long deliberate interval is not overdue", () => {
    const long = 30 * 60 * 1000
    const doc = written(long)
    const stillFine = believableHealthDocument(doc, at(long + ROUND_BUDGET_MS - 1))
    expect(stillFine).toEqual(doc)
  })

  test("is believed right up to its deadline", () => {
    const doc = written(INTERVAL)
    expect(believableHealthDocument(doc, at(INTERVAL + ROUND_BUDGET_MS))).toEqual(doc)
  })

  // THE ONE THAT MATTERS: a stale HEALTHY is the confident lie.
  test("past its deadline a healthy document reads OVERDUE, and names when it was written", () => {
    const doc = written(INTERVAL)
    const overdue = believableHealthDocument(doc, at(INTERVAL + ROUND_BUDGET_MS + 60_000))
    expect(overdue.state).toBe("unhealthy")
    expect(overdue.verdict).toEqual({ kind: "running" })
    expect(overdue.error?.code).toBe("queue-round-overdue")
    expect(overdue.error?.cause).toContain(NOW.toISOString())
    expect(overdue.facts).toMatchObject({ overdueBy: 60_000 })
    expect(queueHealthExitCode(overdue.state)).toBe(2)
  })

  test("overdue outranks a stale unhealthy too — the interesting fact is that nothing has finished", () => {
    const doc = roundHealthDocument("yrd-service", stuckStop, INTERVAL, NOW)
    expect(doc.error?.code).toBe("queue-round-stuck")
    const overdue = believableHealthDocument(doc, at(INTERVAL + ROUND_BUDGET_MS + 1))
    expect(overdue.error?.code).toBe("queue-round-overdue")
  })

  // NEGATIVE CONTROL, and it is why expiry is a written field rather than a
  // reader-side assumption: a document from a loop that predates this change
  // has no deadline, and the ABSENCE of one is not evidence that one passed.
  test("a document with no deadline is passed through, never declared overdue", () => {
    const old = {
      schema: QUEUE_HEALTH_SCHEMA,
      service: "yrd-service",
      state: "healthy",
      verdict: { kind: "running" },
    } as const
    expect(believableHealthDocument(old, at(10 * 365 * 24 * 60 * 60 * 1000))).toEqual(old)
  })

  test("an unparseable deadline is passed through rather than guessed at", () => {
    const doc = { ...written(INTERVAL), facts: { writtenAt: "x", staleAfter: "not a date" } }
    expect(believableHealthDocument(doc, at(999_999_999))).toEqual(doc)
  })
})

// THE CONTRACT TEST THAT USED TO SIT HERE HAS MOVED TO THE ROOT, to
// `tools/yrd-health-contract.test.ts`, and it is checked on every root run.
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
