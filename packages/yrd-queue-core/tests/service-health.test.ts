import { describe, expect, test } from "vitest"

import {
  absentHealthDocument,
  nextStuckStreak,
  parseQueueHealthDocument,
  QUEUE_HEALTH_SCHEMA,
  queueHealthExitCode,
  roundHealthDocument,
  STUCK_BACKOFF_CAP_MS,
  stuckBackoffMs,
  unreadableHealthDocument,
  type StuckStreak,
} from "../src/service-health.ts"

// Stuck is a ROUND outcome, not a process outcome. These assert the two halves
// that make that safe: the spacing ladder, and the document that carries the
// alarm the process exit used to carry.

const INTERVAL = 120_000

describe("stuck spacing", () => {
  // The load-bearing one. A transient fault — a code-host 504 during setup —
  // must be retried by the very next round at the normal cadence. A ladder that
  // starts climbing on the first stuck round reintroduces the outage it exists
  // to remove, just with a shorter duration.
  test("the FIRST stuck round sleeps the plain interval", () => {
    expect(stuckBackoffMs(1, INTERVAL)).toBe(INTERVAL)
  })

  test("consecutive same-reason rounds double", () => {
    expect(stuckBackoffMs(2, INTERVAL)).toBe(2 * INTERVAL)
    expect(stuckBackoffMs(3, INTERVAL)).toBe(4 * INTERVAL)
  })

  test("the ladder is capped near thirty minutes", () => {
    expect(stuckBackoffMs(50, INTERVAL)).toBe(STUCK_BACKOFF_CAP_MS)
    expect(STUCK_BACKOFF_CAP_MS).toBe(30 * 60 * 1000)
  })

  // Never silently: a nonsense streak or interval is a caller defect.
  test.each([0, -1])("a streak of %i is refused, not clamped", (consecutive) => {
    expect(() => stuckBackoffMs(consecutive, INTERVAL)).toThrow(/at least one round/u)
  })

  test("a negative interval is refused", () => {
    expect(() => stuckBackoffMs(1, -1)).toThrow(/cannot be negative/u)
  })

  // `--interval 0` is how the service is asked to run rounds back to back, and
  // the whole existing up-loop suite drives it that way. Refusing zero here
  // turned a stuck round into a THROWN service — the exact "one fault ends the
  // process" shape this bead removes, reintroduced by its own guard.
  test("zero is a real interval and spaces out to nothing", () => {
    expect(stuckBackoffMs(1, 0)).toBe(0)
    expect(stuckBackoffMs(9, 0)).toBe(0)
  })
})

describe("the streak", () => {
  const stuckOn = (reason: string, fingerprint?: string): StuckStreak | undefined =>
    nextStuckStreak(undefined, { stuck: reason, ...(fingerprint === undefined ? {} : { fingerprint }) })

  test("a clear round ends the streak", () => {
    const three = { reason: "504 from the code host", consecutive: 3 }
    expect(nextStuckStreak(three, {})).toBeUndefined()
  })

  test("three same-reason rounds space out (acceptance d)", () => {
    let streak = nextStuckStreak(undefined, { stuck: "504", fingerprint: "a" })
    expect(stuckBackoffMs(streak!.consecutive, INTERVAL)).toBe(INTERVAL)
    streak = nextStuckStreak(streak, { stuck: "504", fingerprint: "a" })
    expect(stuckBackoffMs(streak!.consecutive, INTERVAL)).toBe(2 * INTERVAL)
    streak = nextStuckStreak(streak, { stuck: "504", fingerprint: "a" })
    expect(stuckBackoffMs(streak!.consecutive, INTERVAL)).toBe(4 * INTERVAL)
  })

  test("a new change in the line resets the spacing (acceptance d)", () => {
    const third = { reason: "504", consecutive: 3, fingerprint: "a" }
    const after = nextStuckStreak(third, { stuck: "504", fingerprint: "a+b" })
    expect(after?.consecutive).toBe(1)
    expect(stuckBackoffMs(after!.consecutive, INTERVAL)).toBe(INTERVAL)
  })

  test("a different reason starts its own ladder", () => {
    const third = { reason: "504", consecutive: 3, fingerprint: "a" }
    expect(nextStuckStreak(third, { stuck: "the remote refused", fingerprint: "a" })?.consecutive).toBe(1)
  })

  // Negative control, and the reason `fingerprint` is optional rather than
  // defaulted: a round that never read the line has no opinion about whether
  // work arrived. Treating its absence as a changed line would reset the ladder
  // on exactly the deterministic stuck the ladder exists for.
  test("an unread line neither resets nor is compared", () => {
    const third = { reason: "504", consecutive: 3, fingerprint: "a" }
    expect(nextStuckStreak(third, { stuck: "504" })?.consecutive).toBe(4)
    const unread = { reason: "504", consecutive: 3 }
    expect(nextStuckStreak(unread, { stuck: "504", fingerprint: "a" })?.consecutive).toBe(4)
  })

  test("the same line does not reset", () => {
    expect(nextStuckStreak(stuckOn("504", "a"), { stuck: "504", fingerprint: "a" })?.consecutive).toBe(2)
  })
})

describe("the health document", () => {
  test("a clear round is healthy and running", () => {
    const doc = roundHealthDocument("yrd-service", {}, undefined, INTERVAL)
    expect(doc).toMatchObject({ schema: QUEUE_HEALTH_SCHEMA, state: "healthy", verdict: { kind: "running" } })
    expect(doc.error).toBeUndefined()
    expect(queueHealthExitCode(doc.state)).toBe(0)
  })

  // unhealthy + RUNNING is the combination the supervisor turns into a page it
  // later drops — and the whole point is that it pages without restarting. A
  // stuck round that reported `stopped` would be claiming the loop had died.
  test("a stuck round is unhealthy and still running, with a typed cause", () => {
    const streak = { reason: "the code host answered 504 during setup", consecutive: 2, fingerprint: "a" }
    const doc = roundHealthDocument("yrd-service", { stuck: streak.reason, fingerprint: "a" }, streak, 2 * INTERVAL)
    expect(doc.state).toBe("unhealthy")
    expect(doc.verdict).toEqual({ kind: "running" })
    expect(doc.error?.code).toBe("queue-round-stuck")
    expect(doc.error?.cause).toBe(streak.reason)
    expect(doc.error?.resolution.join(" ")).toMatch(/No restart is needed/u)
    expect(doc.facts).toMatchObject({ stuckRounds: 2, nextRoundInMs: 2 * INTERVAL })
    expect(queueHealthExitCode(doc.state)).toBe(2)
  })

  test("a round that never read the line says so in its facts", () => {
    const streak = { reason: "the remote cannot be read", consecutive: 1 }
    const doc = roundHealthDocument("yrd-service", { stuck: streak.reason }, streak, INTERVAL)
    expect(doc.facts).toMatchObject({ lineRead: false })
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
    const doc = unreadableHealthDocument("yrd-service", "trailing garbage", "{\"schema\":")
    expect(doc.state).toBe("unknown")
    expect(doc.verdict).toEqual({ kind: "unknown", reason: "unparsed", observed: "{\"schema\":" })
    expect(queueHealthExitCode(doc.state)).toBe(3)
  })

  test("the exit ladder is exactly the supervisor's", () => {
    expect(
      (["healthy", "absent", "unhealthy", "unknown"] as const).map((state) => queueHealthExitCode(state)),
    ).toEqual([0, 1, 2, 3])
  })
})

describe("reading a stored document", () => {
  test("round-trips what the loop wrote", () => {
    const written = roundHealthDocument("yrd-service", {}, undefined, INTERVAL)
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
