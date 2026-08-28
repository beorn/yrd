/**
 * @failure A read view joins a run member against a record store and throws on
 * the first member the store does not hold, so ONE mixed-lane state — record,
 * derived, and intent members coexisting in run snapshots — crashes
 * `yrd queue status`, `yrd log`, and the timeline for the whole repository.
 * This exact state is live main post-S6 (2026-08-27: PR2131's derived member
 * crashed three readers serially, each discovered by a production incident,
 * because no fixture held the mix). S7 (branch-is-change, @i/10 22991) deleted
 * the store outright, so EVERY historical record member a run snapshot carries
 * is now a member no store holds — the exact input that crashed those readers,
 * for the whole corpus. This gate is the batch report: every reader entry point
 * runs over one composed mixed-lane state, so a consumer regression fails HERE,
 * once, instead of live, serially.
 * @level l2
 * @consumer @yrd/cli every status/log/timeline operator; the 22991 S5 cutover
 */
import type { BaysState } from "@yrd/bay"
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"

import { fixturePr, fixtureRun, queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  activeWatchRow,
  humanQueueProjection,
  QueueDetailRunChangeBlocks,
  queueLogRows,
  queueRunRevisionClocks,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  QueueWatchView,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

type Run = QueueStatusResult["finished"][number]
type Member = Run["prs"][number]

const NOW = Date.parse("2026-07-13T12:00:00.000Z")
const PRIOR_PIN = "91297cd0be71845fb268f1e9d999172d3660caf1"
const TARGET = "a659df38e3ec2a093b9a16b7514adab10966630a"

function contractResults(): readonly QueueStatusResult[] {
  const results = queueTimelineStories["contract-overview"]?.snapshot.results
  if (results === undefined) throw new Error("contract-overview is missing its queue results")
  return results
}

/** An intent member (carrier-free pin intent, the R1480/I2 shape). */
function intentMember(id: string): Member {
  return {
    id,
    branch: "yrd/intent/yrd-e8220247527a",
    base: "main",
    issue: "@i/23-yrd-vocabulary",
    revision: 1,
    headSha: "e8220247527a9189e42dc7354ecf62712ea38ee4",
    baseSha: PRIOR_PIN,
    intent: {
      id,
      authored: {
        intentId: "01b3cb0b-c24d-4c38-a578-8434f041fb4a",
        issue: { source: "km", id: "@i/23-yrd-vocabulary" },
        component: "vendor/yrd",
        target: TARGET,
      },
      evaluated: { priorPin: PRIOR_PIN, target: TARGET },
    },
  } as Member
}

/** A derived member: recordless and non-intent — post-S6 the normal shape for
 * a refs/for submission. Its id deliberately sits BELOW the record range,
 * because lane numbering interleaves (the frontier rule died on this). */
function derivedMember(id: string): Member {
  return { ...intentMember(id), id, intent: undefined } as Member
}

/**
 * The gate state: the contract fixture's retained records and completed runs,
 * PLUS one run holding a record member, a derived member, and an intent member
 * TOGETHER, plus one all-derived run. The retained prs list is untouched, so
 * the derived/intent members have no record to join — exactly live main.
 */
function mixedLaneResults(): readonly QueueStatusResult[] {
  const results = contractResults()
  const first = results[0]
  if (first === undefined) throw new Error("contract-overview has no queue result")
  const seed = first.finished.find((run) => run.status === "completed")
  if (seed === undefined) throw new Error("contract-overview has no completed Run to clone")
  const recordMember = seed.prs[0]
  if (recordMember === undefined) throw new Error("seed run has no members")
  const mixedRun: Run = {
    ...seed,
    id: "R9001",
    prs: [recordMember, derivedMember("PR9"), intentMember("I9")],
  }
  const derivedRun: Run = { ...seed, id: "R9002", prs: [derivedMember("PR9002")] }
  return [{ ...first, finished: [...first.finished, mixedRun, derivedRun] }, ...results.slice(1)]
}

function project(results: readonly QueueStatusResult[]): QueueTimelineProjection {
  return queueTimelineProjection(results, {
    now: NOW,
    windowMs: 6 * 60 * 60_000,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 500,
    submissionTimes: queueTimelineAdmissionTimes(results),
  })
}

describe("reader lane gate — every read view survives one mixed-lane state", () => {
  const results = mixedLaneResults()
  const first = results[0]
  if (first === undefined) throw new Error("missing result")

  it("admission times: no member kind throws; derived and intent clock null", () => {
    const times = queueTimelineAdmissionTimes(results)
    expect(times.size).toBeGreaterThan(0)
    const derivedKey = JSON.stringify(["R9001", "PR9", 1, "e8220247527a9189e42dc7354ecf62712ea38ee4"])
    expect(times.get(derivedKey)).toBe(null)
  })

  it("revision clocks: records clock, derived and intent members are skipped, never thrown on", () => {
    const clocks = queueRunRevisionClocks(first.prs, first.finished)
    expect(clocks.size).toBeGreaterThan(0)
    for (const key of clocks.keys()) {
      expect(key.includes('"PR9"')).toBe(false)
      expect(key.includes('"I9"')).toBe(false)
    }
  })

  it("timeline projection renders a row for every member of the mixed run", () => {
    const projection = project(results)
    for (const id of [String(first.finished.find((run) => run.status === "completed")?.prs[0]?.id), "PR9", "I9", "PR9002"]) {
      const row = projection.rows.find((candidate) => candidate.pr === id)
      expect(row, `timeline row for ${id}`).toBeDefined()
    }
  })

  it("a derived member's timeline row is COMPLETE from its snapshot — identity and subject, no blanks", () => {
    const projection = project(results)
    const row = projection.rows.find((candidate) => candidate.pr === "PR9")
    expect(row).toBeDefined()
    // Identity comes from the snapshot, not the (absent) record.
    expect(row?.branch).toBe("yrd/intent/yrd-e8220247527a")
    expect(row?.headSha).toBe("e8220247527a9189e42dc7354ecf62712ea38ee4")
    expect(row?.revision).toBe(1)
    // Subject falls back through the snapshot (name ?? branch) — never an
    // empty cell and never a bare id standing in for a title.
    expect(row?.subject).toBeTruthy()
    expect(row?.issue).toBe("@i/23-yrd-vocabulary")
  })

  it("log rows render every member; derived and intent carry age '-', records carry a real age", () => {
    // Clocks built from the same state, exactly as run.ts wires the live path —
    // an empty map with record members present is the deliberate loud path.
    const clocks = queueRunRevisionClocks(first.prs, first.finished)
    const rows = queueLogRows(results, new Set<string>(), undefined, new Map(), [], new Map(), clocks)
    const derived = rows.find((row) => row.pr === "PR9")
    const intent = rows.find((row) => row.pr === "I9")
    expect(derived).toBeDefined()
    expect(intent).toBeDefined()
    expect(derived?.age).toBe("-")
    expect(derived?.submittedAt).toBeUndefined()
  })

  it("the whole battery runs on the all-derived run too — a run with zero records is a legal state", () => {
    const derivedOnly = [{ ...first, finished: first.finished.filter((run) => run.id === "R9002") }]
    expect(() => queueTimelineAdmissionTimes(derivedOnly)).not.toThrow()
    expect(() => queueRunRevisionClocks(first.prs, derivedOnly[0]!.finished)).not.toThrow()
    const rows = queueLogRows(derivedOnly, new Set<string>(), undefined, new Map(), [], new Map(), new Map())
    expect(rows.find((row) => row.pr === "PR9002")).toBeDefined()
  })
})

const FACT_SHA = "c".repeat(40)
const FACT_AT = "2026-07-13T10:00:00.000Z"

function baysState(overrides: Partial<BaysState> = {}): BaysState {
  return { byId: {}, submits: {}, ...overrides }
}

describe("reader lane gate — live submit facts render the pre-run pending band", () => {
  const results = mixedLaneResults()

  it("a fact the derived lane owns and no run has admitted renders a factOnly pending row", () => {
    const state = baysState({ submits: { "topic/derived-fact": { sha: FACT_SHA, base: "main", at: FACT_AT } } })
    const projection = queueTimelineProjection(results, {
      now: NOW,
      windowMs: 6 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 500,
      submissionTimes: queueTimelineAdmissionTimes(results),
      state,
    })
    const row = projection.rows.find((candidate) => candidate.pr === "topic/derived-fact")
    expect(row, "pending row for the unadmitted submit fact").toBeDefined()
    expect(row?.factOnly).toBe(true)
    expect(row?.group).toBe("pending")
    expect(row?.status).toBe("ready")
    expect(row?.branch).toBe("topic/derived-fact")
    expect(row?.headSha).toBe(FACT_SHA)
    expect(row?.revision).toBe(0)
    expect(row?.timestamp).toBe(FACT_AT)
    expect(row?.detail).toContain("awaiting compose")
    // The subject is the fact itself (sha + base) — an explicit value, never a
    // blank cell and never a fabricated change id.
    expect(row?.subject).toContain(FACT_SHA.slice(0, 12))
  })

  it("a fact already admitted at exactly its sha renders NO extra pending row — the member row owns it", () => {
    const branch = "yrd/intent/yrd-e8220247527a"
    const sha = "e8220247527a9189e42dc7354ecf62712ea38ee4"
    // PR9 rides run R9001 with exactly this branch+sha (the mixed fixture).
    const state = baysState({ submits: { [branch]: { sha, base: "main", at: FACT_AT } } })
    const projection = queueTimelineProjection(results, {
      now: NOW,
      windowMs: 6 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 500,
      submissionTimes: queueTimelineAdmissionTimes(results),
      state,
    })
    expect(projection.rows.find((candidate) => candidate.factOnly === true)).toBeUndefined()
  })

})

describe("reader lane gate — human projection and active row survive recordless members", () => {
  const derivedSnapshot = {
    id: "PR9501",
    branch: "topic/derived-member",
    base: "main",
    revision: 1,
    headSha: "d".repeat(40),
  } as QueueStatusResult["finished"][number]["prs"][number]

  it("RECENT carries a complete row for a derived member of a failed run — snapshot + run terminal", () => {
    const record = fixturePr("PR501", "rejected", "2026-07-13T10:00:00.000Z", "Record member", {
      rejectedAt: "2026-07-13T10:30:00.000Z",
      terminalRun: "R9501",
    })
    const run = fixtureRun("R9501", [record], "failed", "2026-07-13T10:10:00.000Z", {
      finishedAt: "2026-07-13T10:30:00.000Z",
      error: { code: "check-failed", message: "check command exited 1" },
    })
    const mixedRun = { ...run, prs: [...run.prs, derivedSnapshot] }
    const result: QueueStatusResult = {
      base: "main",
      prs: [record],
      admissionOrder: [],
      running: [],
      waiting: [],
      finished: [mixedRun],
    }
    const projection = humanQueueProjection(result, NOW)
    const recordRow = projection.recent.find((row) => row.pr === "PR501")
    const derivedRow = projection.recent.find((row) => row.pr === "PR9501")
    expect(recordRow, "record member row").toBeDefined()
    expect(derivedRow, "derived member row").toBeDefined()
    // The derived row is complete from the snapshot: identity, subject, run
    // join — and the record-only source-ready age is the explicit "-" marker,
    // never a silent blank or a fabricated clock.
    expect(derivedRow?.branch).toBe("topic/derived-member")
    expect(derivedRow?.subject).toBe("topic/derived-member")
    expect(derivedRow?.runId).toBe("R9501")
    expect(derivedRow?.state).toBe("rejected")
    expect(derivedRow?.age).toBe("-")
  })

  it("the ACTIVE row's subject for a derived member falls to snapshot name/branch, never the bare id (NSE-2)", () => {
    const record = fixturePr("PR502", "submitted", "2026-07-13T11:00:00.000Z")
    const run = fixtureRun("R9601", [record], "running", "2026-07-13T11:30:00.000Z")
    const named = { ...derivedSnapshot, id: "PR9601", name: "Named derived change" }
    const result: QueueStatusResult = {
      base: "main",
      prs: [],
      admissionOrder: [],
      running: [{ ...run, prs: [named] }],
      waiting: [],
      finished: [],
    }
    const active = activeWatchRow(result, NOW)
    expect(active?.pr).toBe("PR9601")
    expect(active?.subject).toBe("Named derived change")
    const unnamed = activeWatchRow(
      { ...result, running: [{ ...run, prs: [{ ...derivedSnapshot, id: "PR9601" }] }] },
      NOW,
    )
    expect(unnamed?.subject).toBe("topic/derived-member")
  })
})

describe("reader lane gate — filtered log misses are loud, not empty (NSE-4)", () => {
  const results = mixedLaneResults()
  const first = results[0]
  if (first === undefined) throw new Error("missing result")

  it("a filtered change with no retained run pushes an explicit unretained row naming the search", () => {
    const rows = queueLogRows(results, new Set<string>(), "PR404", new Map(), [], new Map(), new Map())
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.pr).toBe("PR404")
    expect(row?.outcome).toBe("unretained")
    expect(row?.result).toContain("no retained runs for 'PR404'")
    expect(row?.result).toContain("searched")
  })

  it("a change riding only a LIVE run stays rowless — it is not unretained", () => {
    const seed = first.finished.find((run) => run.status === "completed")
    if (seed === undefined) throw new Error("missing completed run seed")
    const liveMember = {
      id: "PR9700",
      branch: "topic/live-derived",
      base: "main",
      revision: 1,
      headSha: "e".repeat(40),
    } as QueueStatusResult["finished"][number]["prs"][number]
    const live: QueueStatusResult = {
      ...first,
      running: [{ ...seed, id: "R9700", status: "in_progress", prs: [liveMember] } as (typeof first.finished)[number]],
      finished: [],
    }
    const rows = queueLogRows([live], new Set<string>(), "PR9700", new Map(), [], new Map(), new Map())
    expect(rows).toHaveLength(0)
  })
})

describe("reader lane gate — a factOnly row's detail box makes no change-id claim", () => {
  it("renders the branch identity and never a fabricated `.0` revision", () => {
    const state = baysState({ submits: { "topic/derived-fact": { sha: FACT_SHA, base: "main", at: FACT_AT } } })
    const projection = queueTimelineProjection(mixedLaneResults(), {
      now: NOW,
      windowMs: 6 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 500,
      submissionTimes: queueTimelineAdmissionTimes(mixedLaneResults()),
      state,
    })
    const row = projection.rows.find((candidate) => candidate.factOnly === true)
    if (row === undefined) throw new Error("fact row missing from projection")
    const app = createRenderer({ cols: 120, rows: 30 })(
      createElement(QueueDetailRunChangeBlocks, { row, rows: [row], prs: [] }),
    )
    try {
      expect(app.text).toContain("⎇ topic/derived-fact")
      expect(app.text).not.toContain(".0 ")
      expect(app.text).not.toContain("(r0)")
      expect(app.text).toContain("awaiting compose")
    } finally {
      app.unmount()
    }
  })
})

describe("reader lane gate — watch --pr misses name what was searched (NSE-3)", () => {
  const results = mixedLaneResults()

  it("a derived member id points at its run instead of reading as absence", () => {
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueWatchView, { results: [...results], now: NOW, pr: "PR9" }),
    )
    try {
      expect(app.text).toContain("has no retained record")
      expect(app.text).toContain("R9001")
    } finally {
      app.unmount()
    }
  })

  it("a genuine miss names both searched populations with their counts", () => {
    const app = createRenderer({ cols: 120, rows: 40 })(
      createElement(QueueWatchView, { results: [...results], now: NOW, pr: "PR404" }),
    )
    try {
      expect(app.text).toContain("No change 'PR404'")
      expect(app.text).toContain("retained records")
      expect(app.text).toContain("run members")
    } finally {
      app.unmount()
    }
  })
})
