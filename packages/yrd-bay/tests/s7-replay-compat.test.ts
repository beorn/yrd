/**
 * @failure An old journal's pr/* history stops parsing or stops materializing
 * its records (history loss), a terminal fact for a recordless derived member
 * wedges replay, or a live command grows back the ability to emit a NEW pr/*
 * record event.
 * @level l2
 * @consumer @yrd/bay S7 replay contract (branch-is-change, @i/10 22991)
 *
 * The S7 distinction under test, stated once: reducers stay LIVE — an old
 * journal replays with its records intact (the store field deletes only at
 * the integration step's checkpoint migration) — while every COMMAND that
 * could emit a new pr/* record event is gone. Two projection deltas ride the
 * boundary: the receipts satellite is write-dead, and the four terminal
 * reducers that threw on a missing record (withdrawn/rejected/canceled/recut)
 * are no-ops there, because queue-side terminals for derived members name no
 * record by design.
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"
import { changeDeliveryState, resolveChange, type BaysState } from "../src/model.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)
const TREE = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const silentLog = createLogger("test", [{ level: "silent" }])

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspaceAdapter(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD_1, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const pushed = (pr: string, branch: string, headSha: string, extra: Record<string, unknown> = {}) => ({
  name: "pr/pushed",
  data: { pr, branch, base: "main", headSha, baseSha: BASE, revision: 1, ...extra },
})
const submitted = (pr: string, headSha: string) => ({
  name: "pr/submitted",
  data: { pr, revision: 1, headSha },
})

/** Every pr/* event family a shipped journal can carry, plus the four
 * terminal/recut shapes naming records this journal never pushed (the derived
 * members' recordless terminals). One command's worth of seeded history. */
const FULL_FAMILY_EVENTS: ReadonlyArray<{ name: string; data: Record<string, unknown> }> = [
  // PR1 — the fully-decorated live change, pushed with a receiver receipt.
  pushed("PR1", "topic/decorated", HEAD_1, {
    changeId: `I${"7".repeat(40)}`,
    submitter: "@dev/1",
    receipt: "f".repeat(64),
  }),
  { name: "pr/props-set", data: { pr: "PR1", revision: 1, headSha: HEAD_1, props: { request: "review-1" } } },
  submitted("PR1", HEAD_1),
  { name: "pr/reviewed", data: { pr: "PR1", revision: 1, headSha: HEAD_1, by: "@dev/2", decision: "approve" } },
  { name: "pr/commented", data: { pr: "PR1", revision: 1, headSha: HEAD_1, by: "@dev/2", note: "looks right" } },
  { name: "pr/review-requested", data: { pr: "PR1", reviewers: ["@dev/2"], requestedBy: "@dev/1" } },
  { name: "pr/checks-requested", data: { pr: "PR1", revision: 1, headSha: HEAD_1, baseSha: BASE } },
  {
    name: "pr/admission-recorded",
    data: { pr: "PR1", revision: 1, headSha: HEAD_1, admission: { status: "passed", baseSha: BASE, steps: [] } },
  },
  {
    name: "pr/needs-author",
    data: {
      pr: "PR1",
      revision: 1,
      headSha: HEAD_1,
      run: "R1",
      step: "merge",
      receipt: { code: "merge-conflict", message: "conflict on main" },
    },
  },
  // PR2 — legacy pushed (no changeId/submitter) landing integrated.
  pushed("PR2", "topic/landed", HEAD_2),
  submitted("PR2", HEAD_2),
  {
    name: "pr/integrated",
    data: { pr: "PR2", revision: 1, headSha: HEAD_2, run: "R2", commit: BASE, landingSha: BASE, baseSha: BASE },
  },
  // PR3 — withdrawn; PR4 — rejected; PR5 — canceled; PR6 — already-landed.
  pushed("PR3", "topic/withdrawn", HEAD_1),
  { name: "pr/withdrawn", data: { pr: "PR3", revision: 1, headSha: HEAD_1, reason: "author pulled it" } },
  pushed("PR4", "topic/rejected", HEAD_1),
  submitted("PR4", HEAD_1),
  {
    name: "pr/rejected",
    data: { pr: "PR4", revision: 1, headSha: HEAD_1, run: "R4", step: "check", detail: "red suite" },
  },
  pushed("PR5", "topic/canceled", HEAD_2),
  submitted("PR5", HEAD_2),
  {
    name: "pr/canceled",
    data: { pr: "PR5", revision: 1, headSha: HEAD_2, run: "R5", by: "@ci", reason: "superseded" },
  },
  pushed("PR6", "topic/already-landed", HEAD_1),
  submitted("PR6", HEAD_1),
  {
    name: "pr/already-landed",
    data: {
      pr: "PR6",
      revision: 1,
      headSha: HEAD_1,
      run: "R6",
      baseSha: BASE,
      candidateSha: HEAD_1,
      candidateTreeSha: TREE,
      baseTreeSha: TREE,
    },
  },
  // PR7 — recut to revision 2.
  pushed("PR7", "topic/recut", HEAD_1),
  {
    name: "pr/recut",
    data: {
      pr: "PR7",
      fromRevision: 1,
      patchId: "d".repeat(40),
      baseSha: BASE,
      treeSha: "c".repeat(40),
      reviewCarried: false,
      predecessor: { revision: 1, headSha: HEAD_1, baseSha: BASE },
      successor: { revision: 2, headSha: HEAD_2, baseSha: BASE },
    },
  },
  // PR8 — edit metadata + the retired session facts (the parse-and-discard exemplar).
  pushed("PR8", "topic/edited", HEAD_2),
  { name: "pr/edited", data: { pr: "PR8", title: "feat: edited title" } },
  { name: "pr/session-started", data: { pr: "PR8", launchId: "hab-1" } },
  { name: "pr/session-ended", data: { pr: "PR8", launchId: "hab-1", outcome: "completed" } },
  // PR9 — the retired correlation vocabulary folding into props on replay.
  pushed("PR9", "topic/correlated", HEAD_1),
  {
    name: "pr/correlation-bound",
    data: { pr: "PR9", revision: 1, headSha: HEAD_1, correlation: { namespace: "request", id: "review-9" } },
  },
  // The derived lane's own bay-side facts.
  { name: "branch/submitted", data: { branch: "task/replayed-fact", sha: HEAD_2, base: "main" } },
  // ── recordless terminals: queue-side facts for DERIVED members name no
  // record, and the un-checkpointed tail can carry them. Each of these named
  // a missing record and THREW before S7; now they must no-op.
  { name: "pr/withdrawn", data: { pr: "PR90", revision: 1, headSha: HEAD_1 } },
  { name: "pr/rejected", data: { pr: "PR91", revision: 1, headSha: HEAD_1, run: "R91", step: "check" } },
  { name: "pr/canceled", data: { pr: "PR92", revision: 1, headSha: HEAD_1, run: "R92", by: "@ci", reason: "gone" } },
  {
    name: "pr/recut",
    data: {
      pr: "PR93",
      fromRevision: 1,
      patchId: "e".repeat(40),
      baseSha: BASE,
      treeSha: "c".repeat(40),
      reviewCarried: false,
      predecessor: { revision: 1, headSha: HEAD_1 },
      successor: { revision: 2, headSha: HEAD_2, baseSha: BASE },
    },
  },
  {
    name: "pr/needs-author",
    data: {
      pr: "PR94",
      revision: 1,
      headSha: HEAD_1,
      run: "R94",
      step: "merge",
      receipt: { code: "merge-conflict", message: "conflict" },
    },
  },
  {
    name: "pr/integrated",
    data: { pr: "PR95", revision: 1, headSha: HEAD_1, run: "R95", commit: BASE, landingSha: BASE, baseSha: BASE },
  },
  {
    name: "pr/already-landed",
    data: {
      pr: "PR96",
      revision: 1,
      headSha: HEAD_1,
      run: "R96",
      baseSha: BASE,
      candidateSha: HEAD_1,
      candidateTreeSha: TREE,
      baseTreeSha: TREE,
    },
  },
]

async function replayedApp() {
  const nextId = ids()
  const at = "2026-01-01T00:00:00.000Z"
  const seededCommand = { id: nextId(), op: "fixture.s7-replay" }
  const journal = createMemoryJournal([
    {
      command: seededCommand,
      cause: {
        id: nextId(),
        commandId: seededCommand.id,
        op: seededCommand.op,
        commandHash: Command.hash(seededCommand),
      },
      events: FULL_FAMILY_EVENTS.map(({ name, data }) => ({ id: nextId(), name, ts: at, data })),
    },
  ])
  const jobs = createBayJobDefs(workspaceAdapter())
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
  return createYrd(definition, { inject: { journal, clock: () => at, id: nextId, log: silentLog } })
}

describe("S7 replay compatibility", () => {
  it("replays every pr/* family with records intact, recordless terminals as no-ops, and receipts write-dead", async () => {
    await using app = await replayedApp()
    const state = app.bays.state() as BaysState

    // History intact: the store still materializes on replay.
    expect(Object.keys(state.prs).toSorted()).toEqual(
      ["PR1", "PR2", "PR3", "PR4", "PR5", "PR6", "PR7", "PR8", "PR9"].toSorted(),
    )
    const delivery = (id: string) => changeDeliveryState(state.prs[id]!)
    expect(delivery("PR1")).toBe("needs-author")
    expect(delivery("PR2")).toBe("integrated")
    expect(delivery("PR3")).toBe("withdrawn")
    expect(delivery("PR4")).toBe("rejected")
    expect(delivery("PR5")).toBe("canceled")
    expect(delivery("PR6")).toBe("already-landed")
    expect(delivery("PR7")).toBe("pushed")
    expect(state.prs.PR7?.revs).toHaveLength(2)
    expect(state.prs.PR8?.title).toBe("feat: edited title")
    // The retired correlation pair folds into props at the read boundary.
    expect(state.prs.PR9?.revs[0]?.props).toEqual({ request: "review-9" })
    // Full decoration materialized (the reducers are live, not parse-and-discard).
    expect(state.prs.PR1).toMatchObject({
      reviews: [expect.objectContaining({ by: "@dev/2", decision: "approve" })],
      comments: [expect.objectContaining({ note: "looks right" })],
      requestedReviewers: ["@dev/2"],
      checkRequests: [expect.objectContaining({ headSha: HEAD_1 })],
    })
    expect(state.prs.PR1?.revs[0]?.admission).toMatchObject({ status: "passed", baseSha: BASE })

    // The recordless terminals no-op'd instead of throwing (the app booted at
    // all — this line names the four relaxed reducers plus the S6-relaxed
    // three, none of which may materialize anything).
    for (const absent of ["PR90", "PR91", "PR92", "PR93", "PR94", "PR95", "PR96"]) {
      expect(state.prs[absent]).toBeUndefined()
    }

    // The receipts satellite is write-dead: the pr/pushed receipt PARSED
    // (PR1 exists) and projected nothing.
    expect(state.receipts).toEqual({})

    // The derived lane's facts replay beside the records.
    expect(state.submits["task/replayed-fact"]).toMatchObject({ sha: HEAD_2, base: "main" })
  })

  it("no live command can produce a new pr/* record event", async () => {
    await using app = await replayedApp()
    const before = (await Array.fromAsync(app.events())).map(({ name }) => name)

    // The one live submission surface appends exactly one branch/submitted —
    // never pr/pushed, never pr/submitted.
    const submittedResult = await app.bays.submitSelection("topic/new-work", {
      base: "main",
      resolveRevision: async () => HEAD_2,
      run: runtime,
    })
    expect(submittedResult).toMatchObject({ lane: "derived", branch: "topic/new-work", sha: HEAD_2 })

    // The retired record writers refuse with the cure instead of emitting.
    await expect(app.bays.intake({ branch: "topic/new-work", headSha: HEAD_2, baseSha: BASE })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "record-mint-retired" },
    })
    await expect(app.bays.submit({ branch: "topic/new-work", headSha: HEAD_2 })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "record-mint-retired" },
    })

    const after = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.slice(before.length)).toEqual(["branch/submitted"])
    // A resubmit of a branch whose REPLAYED record is live routes derived too:
    // the record store gains nothing from any live path.
    const resubmit = await app.bays.submitSelection("topic/decorated", {
      base: "main",
      resolveRevision: async () => HEAD_2,
      run: runtime,
    })
    expect(resubmit).toMatchObject({ lane: "derived", branch: "topic/decorated" })
    const state = app.bays.state() as BaysState
    expect(Object.keys(state.prs)).toHaveLength(9)
    expect((await Array.fromAsync(app.events())).filter(({ name }) => name.startsWith("pr/"))).toHaveLength(
      FULL_FAMILY_EVENTS.filter(({ name }) => name.startsWith("pr/")).length,
    )
  })

  it("resolution still reads the replayed records (the deprecated read-survivors serve history)", async () => {
    await using app = await replayedApp()
    const state = app.bays.state() as BaysState
    expect(resolveChange(state, "topic/landed")).toMatchObject({ id: "PR2" })
    expect(resolveChange(state, "pr#7.2")?.revs).toHaveLength(2)
    expect(resolveChange(state, "PR1")).toMatchObject({ branch: "topic/decorated" })
  })
})
