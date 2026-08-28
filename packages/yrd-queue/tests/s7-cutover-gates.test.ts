/**
 * @failure S7 deletes the record store (`BaysState.prs`), and three predicates
 * key "live" on store MEMBERSHIP — so the moment the store empties they invert
 * and destroy exactly the state they exist to protect: the stale-admission
 * sweep (`staleRevisionAdmissionJobs`) reads every recordless member's
 * admission Job as stale and CANCELS live derived admissions; compaction's
 * `admissionRefusals` keep-filter drops every derived member's refusal streak
 * (the only durable trace of a head-of-line wedge); and `queueDecisionRoots`
 * never protects a derived member's failed-admission root, so its decision
 * evidence evicts while the member is still wedged. These tests pin the
 * derived referent each predicate must judge by instead: the live submit fact
 * plus the member's own retained identity (job input snapshot, run snapshot,
 * or refusal-ledger row) — never store membership. Inversion measured against
 * the pre-fix predicates on this branch (each case below failed before the
 * rewire, in the direction described).
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  Queues,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"
import { compactQueueProjection } from "../src/queue.ts"
import { indexQueueStart, recordReleasedAdmissionFailure } from "../src/projection-index.ts"
import type { QueueAdmissionRefusal, QueueRecord, QueuesState } from "../src/model.ts"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const RESUBMIT_SHA = "8".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

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
      output: { path: `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/** The armed-door harness (one-lane-consumes reference config), with the one
 * admission check held WAITING so its Job is durably live when recover runs. */
async function createWaitingCheckApp() {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "waiting",
      token: "gate-pending",
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createWaitingCheckApp>>

function admissionJobs(app: App) {
  return Object.values(app.state().jobs.byId).filter((job) => job.key?.startsWith("admission:") === true)
}

describe("staleRevisionAdmissionJobs — store membership is not staleness (S7 inversion)", () => {
  it("recover() keeps a live derived member's WAITING admission job while its submit fact stands", async () => {
    await using app = await createWaitingCheckApp()
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

    // The selectorless compose derives the member and dispatches its required
    // check, which parks WAITING — a durable live admission with no record
    // and, before any run starts, no retained snapshot either.
    await app.queue.run({}, runtime)
    const waiting = admissionJobs(app)
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.every((job) => job.status === "waiting")).toBe(true)
    expect(app.state().bays.prs).toEqual({})

    // The booby trap: keying "stale" on `bays.prs[prId]` reads EVERY recordless
    // member as stale, and recover cancels the live admission it should keep.
    await app.queue.recover({ recoveryTime: "2026-01-01T00:00:01.000Z" })
    const after = admissionJobs(app)
    expect(after.length).toBe(waiting.length)
    expect(
      after.map((job) => job.status),
      "a live derived admission job must survive recover — its liveness is the submit fact, not store membership",
    ).toEqual(waiting.map(() => "waiting"))
  })

  it("recover() sweeps the derived admission job once the submit fact is retired", async () => {
    await using app = await createWaitingCheckApp()
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(admissionJobs(app).every((job) => job.status === "waiting")).toBe(true)

    // The branch is unsubmitted (ref deleted): the admission is moot, and the
    // job's own input snapshot proves which branch it belonged to.
    await app.bays.recordBranchUnsubmit({ branch: "issue/derived", reason: "deleted" })
    await app.queue.recover({ recoveryTime: "2026-01-01T00:00:01.000Z" })
    expect(admissionJobs(app).map((job) => job.status)).toEqual(admissionJobs(app).map(() => "completed"))
    expect(admissionJobs(app).every((job) => job.status === "completed" && job.conclusion === "cancelled")).toBe(true)
  })

  it("recover() sweeps the derived admission job once the fact moved to a new sha (superseded tree)", async () => {
    await using app = await createWaitingCheckApp()
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(admissionJobs(app).every((job) => job.status === "waiting")).toBe(true)

    // A re-push renews consent for NEW content; the waiting job belongs to the
    // superseded tree and must be swept exactly as a record revision bump is.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    await app.queue.recover({ recoveryTime: "2026-01-01T00:00:01.000Z" })
    expect(admissionJobs(app).every((job) => job.status === "completed" && job.conclusion === "cancelled")).toBe(true)
  })
})

const EMPTY_JOBS = {
  byId: {},
  byKey: {},
  retention: {
    next: 1,
    standaloneTerminalOrder: {},
    queueRoots: {},
    queueTerminalOrder: {},
    legacyQueueRoots: {},
    detachedQueueJobs: {},
  },
} as const

const EMPTY_BAYS = { byId: {}, prs: {}, receipts: {}, submits: {} } as const

function bays(submits: Readonly<Record<string, string>> = {}) {
  return {
    ...EMPTY_BAYS,
    submits: Object.fromEntries(
      Object.entries(submits).map(([branch, sha]) => [branch, { sha, base: "main", at: "2026-01-01T00:00:00.000Z" }]),
    ),
  }
}

function refusalRow(pr: string, branch: string | undefined, headSha: string): QueueAdmissionRefusal {
  return {
    pr,
    revision: 1,
    headSha,
    ...(branch === undefined ? {} : { branch }),
    code: "check-failed",
    reason: "'check' exited 1",
    count: 3,
    firstAt: "2026-01-01T00:00:00.000Z",
    lastAt: "2026-01-01T00:02:00.000Z",
  } as QueueAdmissionRefusal
}

/** A settled derived failed-admission root: `stepSelection.authority ===
 * "admission"`, one recordless member, its own durable failure. */
function failedAdmissionRoot(id: string, branch: string, headSha: string, at: string): QueueRecord {
  return {
    id,
    settlement: "explicit",
    queueId: "main",
    candidateId: `C${id.slice(1)}`,
    prs: [{ id: `PR9${id.slice(1)}`, branch, base: "main", revision: 1, headSha, baseSha: BASE }],
    base: "main",
    steps: [{ name: "check", title: "Check", revision: "check-v1", kind: "check" }],
    initialResults: {},
    stepSelection: { authority: "admission", steps: ["check"] },
    startedAt: at,
    failure: { at, error: { code: "check-failed", message: "'check' exited 1" } },
  } as QueueRecord
}

describe("compaction admissionRefusals filter — a derived streak survives while its fact stands", () => {
  function queuesWith(rows: readonly QueueAdmissionRefusal[]): QueuesState {
    let queues = Queues.empty({ batchSize: 1 })
    return {
      ...queues,
      admissionRefusals: Object.fromEntries(rows.map((row) => [row.pr, row])),
    }
  }

  it("keeps a recordless member's refusal streak while a live submit fact stands for its branch", () => {
    const queues = queuesWith([refusalRow("PR7", "issue/derived", SHA)])
    const kept = compactQueueProjection(queues, EMPTY_JOBS, bays({ "issue/derived": SHA }))
    expect(
      kept.admissionRefusals.PR7,
      "a derived member's wedge streak is the ONLY durable trace of its refusal loop — compaction must not drop it",
    ).toBeDefined()
  })

  it("drops the streak once the fact is gone (the wedge it named cannot recur)", () => {
    const queues = queuesWith([refusalRow("PR7", "issue/derived", SHA)])
    const kept = compactQueueProjection(queues, EMPTY_JOBS, bays())
    expect(kept.admissionRefusals.PR7).toBeUndefined()
  })

  it("resolves a legacy row without a branch through the member's retained run snapshot", () => {
    const root = failedAdmissionRoot("R1", "issue/derived", SHA, "2026-01-01T00:00:00.000Z")
    const snapshotId = root.prs[0]?.id ?? "missing"
    let queues = Queues.empty({ batchSize: 1 })
    queues = {
      ...queues,
      records: Queues.set(queues.records, root),
      index: recordReleasedAdmissionFailure(indexQueueStart(queues.index, root), root),
      admissionRefusals: { [snapshotId]: refusalRow(snapshotId, undefined, SHA) },
      retention: { terminalOrder: { R1: 1 } },
    }
    const standing = compactQueueProjection(queues, EMPTY_JOBS, bays({ "issue/derived": SHA }))
    expect(standing.admissionRefusals[snapshotId]).toBeDefined()
    const retired = compactQueueProjection(queues, EMPTY_JOBS, bays())
    expect(retired.admissionRefusals[snapshotId]).toBeUndefined()
  })
})

describe("queueDecisionRoots — a derived failed-admission root is protected while its fact stands at the refused sha", () => {
  function crowdedQueues(derivedRoot: QueueRecord): QueuesState {
    let queues = Queues.empty({ batchSize: 1 })
    const terminalOrder: Record<string, number> = {}
    queues = {
      ...queues,
      records: Queues.set(queues.records, derivedRoot),
      index: recordReleasedAdmissionFailure(indexQueueStart(queues.index, derivedRoot), derivedRoot),
    }
    terminalOrder[derivedRoot.id] = 1
    for (let index = 0; index < 513; index += 1) {
      const at = new Date(Date.UTC(2026, 0, 1, 1, 0, index)).toISOString()
      const filler: QueueRecord = {
        ...failedAdmissionRoot(`R${index + 2}`, `task/filler-${index}`, MERGED, at),
        stepSelection: { authority: "explicit", steps: ["check"] },
      } as QueueRecord
      queues = {
        ...queues,
        records: Queues.set(queues.records, filler),
        index: recordReleasedAdmissionFailure(indexQueueStart(queues.index, filler), filler),
      }
      terminalOrder[filler.id] = index + 2
    }
    return { ...queues, retention: { terminalOrder } }
  }

  it("retains the root past the terminal cap while the fact stands at the snapshot's sha, and evicts it once the fact moves", () => {
    const root = failedAdmissionRoot("R1", "issue/derived", SHA, "2026-01-01T00:00:00.000Z")
    const queues = crowdedQueues(root)

    const protectedRun = compactQueueProjection(queues, EMPTY_JOBS, bays({ "issue/derived": SHA }))
    expect(
      Queues.get(protectedRun, "R1"),
      "the failed-admission decision evidence must survive compaction while the member is still wedged",
    ).toBeDefined()

    // Fact moved: the refused tree is superseded, the decision no longer
    // governs admission, and the root ages out like any other terminal.
    const moved = compactQueueProjection(queues, EMPTY_JOBS, bays({ "issue/derived": RESUBMIT_SHA }))
    expect(Queues.get(moved, "R1")).toBeUndefined()

    // Fact gone entirely: same eviction.
    const gone = compactQueueProjection(queues, EMPTY_JOBS, bays())
    expect(Queues.get(gone, "R1")).toBeUndefined()
  })
})
