/**
 * @failure A terminal change (withdrawn/canceled/integrated) keeps reporting
 * `checks.status: "queued"` because the checks projection is derived from the
 * append-only check-request history without consulting delivery state — so a
 * reader sees work in flight that the admission queue can never run.
 * @level l2
 * @consumer @yrd/queue
 *
 * S7 conversion note (branch-is-change, @i/10 22991). The record-lane fixture
 * is gone — `bays.requestChecks`, `closePr` and `resolveChange` are deleted,
 * and replayed `pr/*` history materializes nothing — but the invariant is NOT
 * gone, and on the derived lane its original guard is structurally dead:
 *
 * `checkEligibility` (queue.ts) still ends with a terminal-delivery guard that
 * returns `not-requested` for anything not pushed/submitted/ready. Every change
 * that surface can see is now built by `materializeDerivedRunMember`
 * (derived-admission.ts:109), which synthesizes `state: "open"` with no
 * terminal fact and ALWAYS populates `checkRequests` from the live submit fact.
 * So `changeDeliveryState` is unconditionally "submitted" for a derived member,
 * the `request === undefined` early-out can never fire, and the terminal guard
 * can never fire either. A derived member is structurally incapable of being
 * "terminal" in the sense that guard tests for.
 *
 * What still ends the claim is the run: `checkFactRun` answers with the run's
 * own outcome for a member that has one. These fixtures fence exactly that —
 * consumption by a settled run, not delivery state, is what must stop a member
 * claiming a live admission slot.
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"
import { compactQueueProjection } from "../src/queue.ts"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const BRANCH = "issue/consumed-by-its-run"
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

async function createApp() {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
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
    withBays({ jobs: bayJobs }),
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

/** Submit the branch and drive the selectorless compose that derives, admits
 * and integrates it. The submit fact deliberately OUTLIVES the run. */
async function runToIntegration(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  await app.bays.recordBranchSubmit({ branch: BRANCH, sha: SHA, base: "main" })
  const runs = await app.queue.run({}, runtime)
  expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
  const member = runs[0]?.prs.find((candidate) => candidate.branch === BRANCH)
  if (member === undefined) throw new Error("expected the derived member to have run")
  return member.id
}

describe("a member consumed by its run never projects a live check status", () => {
  it("reports the run's own outcome, not a queued admission slot", async () => {
    await using app = await createApp()
    const pr = await runToIntegration(app)

    // The fact still stands — derived facts outlive their runs — so the member
    // still materializes as `state: "open"` / delivery "submitted", carrying a
    // standing check authority. Only the RUN can end its claim to a slot.
    expect(app.state().bays.submits[BRANCH]).toMatchObject({ sha: SHA })

    const eligibility = app.queue.eligibility(pr)
    expect(
      eligibility.checks.status,
      "a member whose run already settled may not claim a slot the queue can never run again",
    ).not.toBe("queued")
    expect(eligibility.checks.status).toBe("passed")
    expect(eligibility.checks.position).toBeUndefined()
  })

  it("still reports no live slot once the settled run's evidence is compacted away", async () => {
    await using app = await createApp()
    const pr = await runToIntegration(app)
    const state = app.state()

    // The retention edge, and the one the derived lane has no guard for: with
    // the run's evidence pruned, `checkFactRun` can no longer answer, and every
    // remaining branch of the projection reads a live standing authority — the
    // materialized member is open, submitted, and holds a check request. If the
    // fall-through wins, a settled member advertises a slot forever (the R1583
    // shape: a projection re-deriving `running` after its Jobs aged out).
    const compacted = compactQueueProjection(state.queues, state.jobs, state.bays)
    const eligibility = app.queue.eligibility(pr, { ...state, queues: compacted })
    expect(
      eligibility.checks.status,
      "compaction prunes evidence, and evidence pruning may never resurrect a live admission claim",
    ).not.toBe("queued")
  })
})
