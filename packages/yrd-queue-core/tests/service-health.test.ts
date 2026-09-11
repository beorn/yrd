import { describe, expect, test } from "vitest"

import {
  absentHealthDocument,
  believableHealthDocument,
  nextStuckStreak,
  parseQueueHealthDocument,
  QUEUE_HEALTH_SCHEMA,
  queueHealthExitCode,
  ROUND_BUDGET_MS,
  roundHealthDocument,
  STUCK_BACKOFF_CAP_MS,
  STUCK_RECORD_CODE,
  STUCK_RECORD_NEXT,
  stuckBackoffMs,
  unreadableHealthDocument,
  type QueueHealthDocument,
  type StuckStreak,
} from "../src/service-health.ts"

// Stuck is a ROUND outcome, not a process outcome. These assert the two halves
// that make that safe: the spacing ladder, and the document that carries the
// alarm the process exit used to carry.

const INTERVAL = 120_000
const NOW = new Date("2026-09-11T12:00:00.000Z")

/** A stuck fact with a stable key, as every real producer must emit. */
const stuck = (key: string, reason = key): { key: string; reason: string } => ({ key, reason })

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
  const stuckOn = (key: string, fingerprint?: string): StuckStreak | undefined =>
    nextStuckStreak(undefined, { stuck: stuck(key), ...(fingerprint === undefined ? {} : { fingerprint }) })

  test("a clear round ends the streak", () => {
    const three = { key: "504", reason: "504 from the code host", consecutive: 3 }
    expect(nextStuckStreak(three, {})).toBeUndefined()
  })

  test("three same-reason rounds space out (acceptance d)", () => {
    // The PROSE changes every round here and the KEY does not — which is the
    // exact case the first version got wrong, so the ladder is asserted while
    // the reason text moves underneath it.
    let streak = nextStuckStreak(undefined, { stuck: stuck("504", "504 at 12:00"), fingerprint: "a" })
    expect(stuckBackoffMs(streak!.consecutive, INTERVAL)).toBe(INTERVAL)
    streak = nextStuckStreak(streak, { stuck: stuck("504", "504 at 12:02"), fingerprint: "a" })
    expect(stuckBackoffMs(streak!.consecutive, INTERVAL)).toBe(2 * INTERVAL)
    streak = nextStuckStreak(streak, { stuck: stuck("504", "504 at 12:06"), fingerprint: "a" })
    expect(stuckBackoffMs(streak!.consecutive, INTERVAL)).toBe(4 * INTERVAL)
    // And the document shows the LATEST prose, not the first round's.
    expect(streak?.reason).toBe("504 at 12:06")
  })

  test("a new change in the line resets the spacing (acceptance d)", () => {
    const third = { key: "504", reason: "504", consecutive: 3, fingerprint: "a" }
    const after = nextStuckStreak(third, { stuck: stuck("504"), fingerprint: "a+b" })
    expect(after?.consecutive).toBe(1)
    expect(stuckBackoffMs(after!.consecutive, INTERVAL)).toBe(INTERVAL)
  })

  test("a different reason starts its own ladder", () => {
    const third = { key: "504", reason: "504", consecutive: 3, fingerprint: "a" }
    expect(nextStuckStreak(third, { stuck: stuck("the-remote-refused"), fingerprint: "a" })?.consecutive).toBe(1)
  })

  // Negative control, and the reason `fingerprint` is optional rather than
  // defaulted: a round that never read the line has no opinion about whether
  // work arrived. Treating its absence as a changed line would reset the ladder
  // on exactly the deterministic stuck the ladder exists for.
  test("an unread line neither resets nor is compared", () => {
    const third = { key: "504", reason: "504", consecutive: 3, fingerprint: "a" }
    expect(nextStuckStreak(third, { stuck: stuck("504") })?.consecutive).toBe(4)
    const unread = { key: "504", reason: "504", consecutive: 3 }
    expect(nextStuckStreak(unread, { stuck: stuck("504"), fingerprint: "a" })?.consecutive).toBe(4)
  })

  test("the same line does not reset", () => {
    expect(nextStuckStreak(stuckOn("504", "a"), { stuck: stuck("504"), fingerprint: "a" })?.consecutive).toBe(2)
  })
})

describe("the health document", () => {
  test("a clear round is healthy and running", () => {
    const doc = roundHealthDocument("yrd-service", {}, undefined, INTERVAL, NOW)
    expect(doc).toMatchObject({ schema: QUEUE_HEALTH_SCHEMA, state: "healthy", verdict: { kind: "running" } })
    expect(doc.error).toBeUndefined()
    expect(queueHealthExitCode(doc.state)).toBe(0)
  })

  // unhealthy + RUNNING is the combination the supervisor turns into a page it
  // later drops — and the whole point is that it pages without restarting. A
  // stuck round that reported `stopped` would be claiming the loop had died.
  test("a stuck round is unhealthy and still running, with a typed cause", () => {
    const streak = { key: "setup-504", reason: "the code host answered 504 during setup", consecutive: 2, fingerprint: "a" }
    const doc = roundHealthDocument("yrd-service", { stuck: stuck(streak.key, streak.reason), fingerprint: "a" }, streak, 2 * INTERVAL, NOW)
    expect(doc.state).toBe("unhealthy")
    expect(doc.verdict).toEqual({ kind: "running" })
    expect(doc.error?.code).toBe("queue-round-stuck")
    // F4: the page names the stuck RECORD's code as well as the prose, so a
    // reader who has not got the journal open still gets the cure.
    expect(doc.error?.cause).toContain(streak.reason)
    expect(doc.error?.cause).toContain(STUCK_RECORD_CODE)
    expect(doc.error?.resolution).toContain(STUCK_RECORD_NEXT)
    expect(doc.facts).toMatchObject({ reasonKey: "setup-504" })
    expect(doc.error?.resolution.join(" ")).toMatch(/No restart is needed/u)
    expect(doc.facts).toMatchObject({ stuckRounds: 2, nextRoundInMs: 2 * INTERVAL })
    expect(queueHealthExitCode(doc.state)).toBe(2)
  })

  test("a round that never read the line says so in its facts", () => {
    const streak = { key: "could-not-judge", reason: "the remote cannot be read", consecutive: 1 }
    const doc = roundHealthDocument("yrd-service", { stuck: stuck(streak.key, streak.reason) }, streak, INTERVAL, NOW)
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
    const written = roundHealthDocument("yrd-service", {}, undefined, INTERVAL, NOW)
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
  const written = (sleepMs: number) => roundHealthDocument("yrd-service", {}, undefined, sleepMs, NOW)
  const at = (ms: number) => new Date(NOW.getTime() + ms)

  test("carries when it was written and when it stops being believable", () => {
    const doc = written(INTERVAL)
    expect(doc.facts).toMatchObject({
      writtenAt: NOW.toISOString(),
      staleAfter: at(INTERVAL + ROUND_BUDGET_MS).toISOString(),
    })
  })

  // The deadline is the loop's OWN sleep plus a budget, never a fixed cadence a
  // reader assumed — so a deliberate thirty-minute backoff is not overdue at
  // minute eleven.
  test("a long deliberate backoff is not overdue", () => {
    const doc = written(STUCK_BACKOFF_CAP_MS)
    const stillFine = believableHealthDocument(doc, at(STUCK_BACKOFF_CAP_MS + ROUND_BUDGET_MS - 1))
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
    const streak = { key: "setup-504", reason: "the code host answered 504", consecutive: 2 }
    const doc = roundHealthDocument("yrd-service", { stuck: stuck(streak.key, streak.reason) }, streak, INTERVAL, NOW)
    expect(doc.error?.code).toBe("queue-round-stuck")
    const overdue = believableHealthDocument(doc, at(INTERVAL + ROUND_BUDGET_MS + 1))
    expect(overdue.error?.code).toBe("queue-round-overdue")
  })

  // NEGATIVE CONTROL, and it is why expiry is a written field rather than a
  // reader-side assumption: a document from a loop that predates this change
  // has no deadline, and the ABSENCE of one is not evidence that one passed.
  test("a document with no deadline is passed through, never declared overdue", () => {
    const old = { schema: QUEUE_HEALTH_SCHEMA, service: "yrd-service", state: "healthy", verdict: { kind: "running" } } as const
    expect(believableHealthDocument(old, at(10 * 365 * 24 * 60 * 60 * 1000))).toEqual(old)
  })

  test("an unparseable deadline is passed through rather than guessed at", () => {
    const doc = { ...written(INTERVAL), facts: { writtenAt: "x", staleAfter: "not a date" } }
    expect(believableHealthDocument(doc, at(999_999_999))).toEqual(doc)
  })
})

/**
 * @failure  A document yrd emits is REFUSED by the supervisor's parser, so hab
 *           reads it as unparsed and pages `health-not-measured` — an alarm
 *           about the alarm. Measured in production 2026-09-11 14:25:51Z, the
 *           first thing the live probe did: the ABSENT document carried a typed
 *           error, and `hab-service-health/2` forbids one on `absent` and
 *           `healthy` (@cto, hab-core service-health-probe.ts:446-482).
 * @level    l1
 * @consumer hab's health parser, which gates every page this service can open
 *
 * THE CONTRACT TEST @cto ASKED FOR, and the reason it is the right instrument:
 * every unit test here asserts what OUR code produces, and all of them passed
 * while the document was unusable. What none of them asked is whether the
 * SUPERVISOR would accept it. The rules are reproduced rather than imported —
 * this package is standalone and must not depend on the host that vendors it —
 * so the risk is drift, and that is a trade made with open eyes: a rule written
 * here is checked on every run, while a rule checked nowhere is what this
 * defect was.
 */
describe("every document yrd emits satisfies hab-service-health/2", () => {
  /** The supervisor's own placement rules, from service-health-probe.ts:453-472. */
  const accepts = (doc: QueueHealthDocument): true => {
    if (doc.schema !== QUEUE_HEALTH_SCHEMA) throw new Error(`schema is ${doc.schema}`)
    if (doc.state === "unhealthy") {
      if (doc.error === undefined) throw new Error("unhealthy probe omitted its typed error/cause/resolution")
      if (typeof doc.error.code !== "string" || doc.error.code === "") throw new Error("error.code missing")
      if (typeof doc.error.cause !== "string" || doc.error.cause === "") throw new Error("error.cause missing")
      if (!Array.isArray(doc.error.resolution)) throw new Error("error.resolution missing")
      return true
    }
    // `unknown` MAY carry one; `healthy` and `absent` may not, and a document
    // that does is rejected whole rather than trimmed.
    if (doc.state !== "unknown" && doc.error !== undefined) {
      throw new Error(`${doc.state} probe unexpectedly carried an error`)
    }
    return true
  }

  const streak = { key: "stuck-changes:task/one", reason: "the round stopped on task/one", consecutive: 2 }

  test.each([
    ["healthy", () => roundHealthDocument("yrd-service", {}, undefined, INTERVAL, NOW)],
    [
      "unhealthy (a stuck round)",
      () => roundHealthDocument("yrd-service", { stuck: stuck(streak.key, streak.reason) }, streak, INTERVAL, NOW),
    ],
    [
      "unhealthy (an overdue round)",
      () =>
        believableHealthDocument(
          roundHealthDocument("yrd-service", {}, undefined, INTERVAL, NOW),
          new Date(NOW.getTime() + INTERVAL + ROUND_BUDGET_MS + 1),
        ),
    ],
    ["absent", () => absentHealthDocument("yrd-service", "no health document at /w/service-health.json")],
    ["unknown", () => unreadableHealthDocument("yrd-service", "not a document", "{")],
  ])("%s is accepted", (_name, build) => {
    expect(accepts(build())).toBe(true)
  })

  // The absent document's explanation still reaches a person — it moved to
  // `facts`, which the same parser carries through untouched.
  test("the absent document keeps its explanation in facts", () => {
    const doc = absentHealthDocument("yrd-service", "no health document at /w/service-health.json")
    expect(doc.error).toBeUndefined()
    expect(String(doc.facts?.why)).toContain("/w/service-health.json")
    expect(Array.isArray(doc.facts?.resolution)).toBe(true)
  })

  // NEGATIVE CONTROL: the checker must actually fire. A contract test that
  // cannot fail is the decoration this defect already paid for once.
  test("the checker refuses the exact document that paged in production", () => {
    const paged = {
      ...absentHealthDocument("yrd-service", "why"),
      error: { code: "queue-health-document-absent", cause: "why", resolution: [] },
    } as QueueHealthDocument
    expect(() => accepts(paged)).toThrow(/absent probe unexpectedly carried an error/u)
  })

  test("the checker refuses an unhealthy document with no typed error", () => {
    const doc = { schema: QUEUE_HEALTH_SCHEMA, service: "yrd-service", state: "unhealthy", verdict: { kind: "running" } } as QueueHealthDocument
    expect(() => accepts(doc)).toThrow(/omitted its typed error/u)
  })
})
