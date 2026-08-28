/**
 * @failure A derived member's identity is minted twice, recycled, or lost. A
 * recordless member has no store row, so its id lives only in run history —
 * and if the mint re-derives instead of reusing, every compose of the same
 * branch burns a fresh number (and every refused compose burns one before any
 * run exists to retain a snapshot). This file is the id-seam: which source
 * answers for an id, which source supplies a re-pushed branch's identity, and
 * the commit-before-escape contract that makes a crash skip a number rather
 * than re-issue one.
 *
 * S7 (branch-is-change, @i/10 22991): the change-record store is gone, so the
 * mint reads run history alone — the latest retained snapshot for the branch,
 * then the refusal-ledger row, then a fresh number. The record x submit
 * arbitration this file used to table-test collapses with it: with no store to
 * fill, only the two `record: "none"` cells are constructible, and the "never
 * both lanes" guarantee is structural rather than arbitrated.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import {
  createBayJobDefs,
  volatilePrNumberMint,
  withBays,
  type BaysState,
  type BayWorkspace,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  latestChangeSnapshot,
  maxChangeSnapshotRevision,
  mintDerivedMemberIdentity,
  Queues,
  resolveMemberById,
  withQueue,
  withStep,
  type ChangeSnapshot,
  type QueueAdmissionRefusal,
  type QueueRecord,
  type QueuesState,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const OTHER_SHA = "d".repeat(40)
const AT = "2026-01-01T00:00:00.000Z"
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

async function createQueueApp() {
  const checkStep = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => AT,
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

describe("one lane per branch — the submit fact is the whole question", () => {
  it("a branch with a standing submit fact is derived; without one there is nothing to derive", async () => {
    // What the 9-cell record x submit matrix collapsed to. Six of its eight
    // constructible cells needed a Change record to build, and no writer can
    // mint one any more, so the record axis is unreachable: `lane` is a
    // function of the submit fact alone.
    await using app = await createQueueApp()
    expect(app.queue.deriveChange("issue/nothing")).toMatchObject({
      branch: "issue/nothing",
      authority: { lane: "none", cell: { record: "none", submit: "none" } },
    })

    await app.bays.recordBranchSubmit({ branch: "issue/facted", sha: OTHER_SHA, base: "main" })
    const derived = app.queue.deriveChange("issue/facted")
    expect(derived).toMatchObject({
      branch: "issue/facted",
      submit: { sha: OTHER_SHA, base: "main", at: AT },
      authority: { lane: "derived", cell: { record: "none", submit: "different-sha" } },
    })
    // A derived verdict always stands on a live submit fact, and no record
    // answers for the branch because none can exist.
    expect(derived.submit).toBeDefined()
    expect(derived.record).toBeUndefined()
  })

  it("an unsubmit retires the branch from the derived lane in the same read", async () => {
    await using app = await createQueueApp()
    await app.bays.recordBranchSubmit({ branch: "issue/gone", sha: OTHER_SHA, base: "main" })
    await app.bays.recordBranchUnsubmit({ branch: "issue/gone", reason: "deleted" })

    expect(app.queue.deriveChange("issue/gone")).toMatchObject({
      branch: "issue/gone",
      authority: { lane: "none", cell: { record: "none", submit: "none" } },
    })
    expect(app.state().bays.submits["issue/gone"]).toBeUndefined()
  })
})

// ————— id-seam: pure-state fixtures over run history, the only identity home
// a recordless member has. —————

function baysWith(submits: Readonly<Record<string, Readonly<{ sha: string; base: string; at: string }>>> = {}): BaysState {
  return { byId: {}, submits }
}

function snapshot(
  overrides: Readonly<{ id: string; branch: string; revision: number; changeId?: string; headSha?: string }>,
): ChangeSnapshot {
  return {
    id: overrides.id,
    ...(overrides.changeId === undefined ? {} : { changeId: overrides.changeId }),
    branch: overrides.branch,
    base: "main",
    revision: overrides.revision,
    headSha: overrides.headSha ?? "b".repeat(40),
  }
}

function runRecord(id: string, prs: readonly ChangeSnapshot[]): QueueRecord {
  return { id, queueId: "main", candidateId: "C1", prs, base: "main", steps: [], startedAt: AT }
}

function queuesWith(...records: readonly QueueRecord[]): QueuesState {
  const empty = Queues.empty({ batchSize: 1 })
  return { ...empty, records: records.reduce((lookup, record) => Queues.set(lookup, record), empty.records) }
}

function queuesWithRefusal(row: QueueAdmissionRefusal, ...records: readonly QueueRecord[]): QueuesState {
  return { ...queuesWith(...records), admissionRefusals: { [row.pr]: row } }
}

function refusalRow(
  overrides: Readonly<{ pr: string; branch: string; revision?: number; headSha?: string }>,
): QueueAdmissionRefusal {
  return {
    pr: overrides.pr,
    branch: overrides.branch,
    ...(overrides.revision === undefined ? {} : { revision: overrides.revision }),
    ...(overrides.headSha === undefined ? {} : { headSha: overrides.headSha }),
    code: "authored-gitlink",
    reason: "the branch authors a gitlink bump it may not carry",
    count: 1,
    sameCodeCount: 1,
    firstAt: AT,
    lastAt: AT,
  } as QueueAdmissionRefusal
}

describe("id-seam — an id answers from the newest snapshot that names it", () => {
  it("resolves a recordless id from run history, and reports an id nothing names as unknown", () => {
    const queues = queuesWith(
      runRecord("R2", [snapshot({ id: "PR7", branch: "issue/old", revision: 3 })]),
      runRecord("R10", [snapshot({ id: "PR9", branch: "issue/new", revision: 2, changeId: "I0123abcd" })]),
    )
    // Every id answers from a snapshot now — there is no store arm left to
    // out-rank one, so `source` is the same for every resolvable member.
    expect(resolveMemberById(queues, "PR7")).toMatchObject({ source: "snapshot", id: "PR7" })
    expect(resolveMemberById(queues, "pr#9")).toMatchObject({
      source: "snapshot",
      id: "PR9",
      snapshot: { revision: 2, changeId: "I0123abcd" },
    })
    expect(resolveMemberById(queues, "9")).toMatchObject({ source: "snapshot", id: "PR9" })
    expect(resolveMemberById(queues, "PR8")).toBeUndefined()
  })

  it("the newest snapshot wins by natural run order (R10 after R2), and intent members never match", () => {
    const queues = queuesWith(
      runRecord("R2", [snapshot({ id: "PR9", branch: "issue/new", revision: 1 })]),
      runRecord("R10", [snapshot({ id: "PR9", branch: "issue/new", revision: 4 })]),
    )
    expect(latestChangeSnapshot(queues, (candidate) => candidate.id === "PR9")?.revision).toBe(4)
    expect(maxChangeSnapshotRevision(queues, "PR9")).toBe(4)
    expect(maxChangeSnapshotRevision(queues, "PR404")).toBe(0)
  })
})

describe("id-seam — admission-time mint (commit-before-escape)", () => {
  it("a fresh member mints strictly above the high-water at revision 1, committing first", () => {
    const mint = volatilePrNumberMint(3)
    const identity = mintDerivedMemberIdentity({
      mint,
      bays: baysWith(),
      queues: queuesWith(),
      branch: "issue/fresh",
    })
    expect(identity).toEqual({ id: "PR4", revision: 1, minted: true })
    // The high-water moved BEFORE the id escaped: the crash window skips a
    // number, never re-issues one.
    expect(mint.highWater()).toBe(4)
  })

  it("a re-pushed derived branch reuses its snapshot identity — id, changeId, next revision — without minting", () => {
    const mint = volatilePrNumberMint(9)
    const queues = queuesWith(
      runRecord("R1", [snapshot({ id: "PR9", branch: "issue/derived", revision: 3, changeId: "I0123abcd" })]),
      runRecord("R2", [snapshot({ id: "PR9", branch: "issue/derived", revision: 4, changeId: "I0123abcd" })]),
    )
    const identity = mintDerivedMemberIdentity({ mint, bays: baysWith(), queues, branch: "issue/derived" })
    expect(identity).toEqual({ id: "PR9", changeId: "I0123abcd", revision: 5, minted: false })
    expect(mint.highWater()).toBe(9)
  })

  it("a member refused before ANY run reuses its refusal-ledger id, keeping the refused revision while the tree is unchanged", () => {
    // The only other durable identity home a derived member has: without this
    // arm every refused compose burned a fresh number for the same branch,
    // and the standing admission Jobs stopped keying.
    const mint = volatilePrNumberMint(5)
    const queues = queuesWithRefusal(
      refusalRow({ pr: "PR5", branch: "issue/refused", revision: 2, headSha: HEAD }),
    )
    const identity = mintDerivedMemberIdentity({
      mint,
      bays: baysWith({ "issue/refused": { sha: HEAD, base: "main", at: AT } }),
      queues,
      branch: "issue/refused",
    })
    expect(identity).toEqual({ id: "PR5", revision: 2, minted: false })
    expect(mint.highWater()).toBe(5)
  })

  it("a re-push past a refused member continues the revision count above the refused one", () => {
    const mint = volatilePrNumberMint(5)
    const queues = queuesWithRefusal(
      refusalRow({ pr: "PR5", branch: "issue/refused", revision: 2, headSha: HEAD }),
    )
    // The submit fact now stands at a DIFFERENT tree than the refusal recorded.
    const identity = mintDerivedMemberIdentity({
      mint,
      bays: baysWith({ "issue/refused": { sha: OTHER_SHA, base: "main", at: AT } }),
      queues,
      branch: "issue/refused",
    })
    expect(identity).toEqual({ id: "PR5", revision: 3, minted: false })
    expect(mint.highWater()).toBe(5)
  })

  it("a retained snapshot outranks the refusal ledger for the same branch", () => {
    const mint = volatilePrNumberMint(9)
    const queues = queuesWithRefusal(
      refusalRow({ pr: "PR5", branch: "issue/both", revision: 2, headSha: HEAD }),
      runRecord("R1", [snapshot({ id: "PR9", branch: "issue/both", revision: 4, changeId: "Iabcd0123" })]),
    )
    const identity = mintDerivedMemberIdentity({ mint, bays: baysWith(), queues, branch: "issue/both" })
    expect(identity).toEqual({ id: "PR9", changeId: "Iabcd0123", revision: 5, minted: false })
  })

  it("a reused id above the high-water is an escaped id and refuses loudly", () => {
    const queues = queuesWith(runRecord("R1", [snapshot({ id: "PR9", branch: "issue/derived", revision: 1 })]))
    expect(() =>
      mintDerivedMemberIdentity({ mint: volatilePrNumberMint(3), bays: baysWith(), queues, branch: "issue/derived" }),
    ).toThrow(/exceeds the mint high-water/)
  })

  it("an escaped id in the refusal ledger refuses just as loudly as one in a snapshot", () => {
    // The ledger arm needs its own guard: it is reached only when no snapshot
    // exists, so a snapshot-only test leaves it unfenced.
    const queues = queuesWithRefusal(refusalRow({ pr: "PR9", branch: "issue/refused", revision: 1, headSha: HEAD }))
    expect(() =>
      mintDerivedMemberIdentity({ mint: volatilePrNumberMint(3), bays: baysWith(), queues, branch: "issue/refused" }),
    ).toThrow(/exceeds the mint high-water/)
  })
})
