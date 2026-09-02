/**
 * @failure An ended attempt reaches the outcome seam zero times (a refused
 *          revision or a landed merge nobody is told about) or twice (two
 *          balls for one attempt), or a faulting hook takes the pass down
 *          with an untyped throw instead of an ERROR row.
 * @level l2
 * @consumer @yrd/cli outcome-notify.ts (the notifier seam, @i/10-yrd/24028)
 *
 * Operator ruling 2026-09-01: "every failure should result in a ball". The
 * seam is `QueueOptions.onOutcome`; these fixtures count what reaches it.
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { localRunner, withJobs, type Job, type JobResult, type Jobs, type Runner } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type QueueOutcome,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

async function createApp(
  options: Readonly<{
    outcomes: QueueOutcome[]
    checkRun?: () => JobResult<z.infer<typeof CheckResultSchema>>
    mergeRun?: () => Promise<JobResult<IntegrationProof>>
    /** The Runner the queue submits its step Jobs to; absent, the built-in local one. */
    runner?: (jobs: Jobs) => Runner
    hook?: (outcome: QueueOutcome) => Promise<void>
  }>,
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> =>
      options.checkRun === undefined
        ? { status: "completed", conclusion: "success", output: { checked: true } }
        : options.checkRun(),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> =>
      options.mergeRun === undefined
        ? { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
        : options.mergeRun(),
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
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    onOutcome: async (outcome) => {
      options.outcomes.push(outcome)
      await options.hook?.(outcome)
    },
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

describe("every ended attempt reaches the outcome seam exactly once", () => {
  it("a merge that lands hands over ONE `landed` outcome with the run, the landing and the member's identity — and a second pass with nothing to do hands over none", async () => {
    const outcomes: QueueOutcome[] = []
    await using app = await createApp({ outcomes })
    await app.bays.recordBranchSubmit({ branch: "issue/lands", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(outcomes).toHaveLength(1)
    const [landed] = outcomes
    expect(landed).toMatchObject({
      kind: "landed",
      branch: "issue/lands",
      sha: SHA,
      base: "main",
      run: runs[0]?.id,
      attemptId: runs[0]?.id,
      integration: { commit: MERGED, baseSha: BASE },
    })
    expect(landed?.code).toBeUndefined()

    await app.queue.run({}, runtime)
    expect(outcomes, "a pass with nothing to do ends no attempt").toHaveLength(1)
  })

  it("a revision refused at admission (a failed required check) hands over ONE `refused` outcome with the code and admission kind, and nothing lands", async () => {
    const outcomes: QueueOutcome[] = []
    await using app = await createApp({
      outcomes,
      checkRun: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "check 'check' failed: 1 error" },
      }),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/refused", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    expect(runs.some((run) => run.conclusion === "success")).toBe(false)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      kind: "refused",
      branch: "issue/refused",
      sha: SHA,
      base: "main",
      baseSha: BASE,
      code: "check-failed",
      failureKind: "failure",
      attributableFailures: [],
    })
    expect(outcomes[0]?.attemptId).toMatch(new RegExp(`^PR\\d+@1:admission@${BASE}$`, "u"))
    expect(outcomes[0]?.reason).toContain("check 'check' failed")
  })

  /** Drive one merge a remote Runner holds open across three passes and
   * count what reaches the seam on each. `submit` picks the member's lane:
   * a stored record (`bays.submit`) or a derived, recordless branch fact
   * (`recordBranchSubmit`, the shape every refs/for push takes). */
  async function deferredMerge(
    submit: (app: Awaited<ReturnType<typeof createApp>>) => Promise<unknown>,
  ): Promise<void> {
    const outcomes: QueueOutcome[] = []
    const mergeEntered = Promise.withResolvers<void>()
    const mergeReleased = Promise.withResolvers<void>()
    let heldMerge: Promise<Job> | undefined
    await using app = await createApp({
      outcomes,
      mergeRun: async () => {
        mergeEntered.resolve()
        await mergeReleased.promise
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
      runner: (jobs) => {
        const local = localRunner({ id: "remote", jobs, leaseMs: 60_000, maxInFlight: 2 })
        return {
          ...local,
          submit: (input) => {
            const running = local.submit(input)
            // The check is an admission Job and runs to completion inline; the
            // merge Job is answered the moment it is STARTED, and held open.
            if (jobs.get(input.job)?.definition !== "queue.step.merge") return running
            heldMerge = running
            return mergeEntered.promise.then((): Job => {
              const observed = jobs.get(input.job)
              if (observed === undefined) throw new Error(`yrd: no job '${input.job}'`)
              return observed as Job
            })
          },
        }
      },
    })
    try {
      await submit(app)

      const deferring = await app.queue.run({}, runtime)

      const runId = deferring[0]?.id
      if (runId === undefined) throw new Error("expected the deferring pass to start the merge run")
      expect(app.queue.get(runId)).toMatchObject({ status: "in_progress" })
      expect(app.queue.get(runId)?.steps.find((step) => step.kind === "merge")?.job).toMatchObject({
        status: "in_progress",
        runner: "remote",
      })
      expect(outcomes, "a run a remote Runner still holds open has not ended").toHaveLength(0)

      // The remote Runner finishes the merge Job between passes.
      mergeReleased.resolve()
      if (heldMerge === undefined) throw new Error("expected the remote Runner to hold the merge Job")
      expect(await heldMerge).toMatchObject({ status: "completed", conclusion: "success" })
      expect(outcomes, "a Job completing is not a settled run").toHaveLength(0)

      await app.queue.run({}, runtime)

      expect(app.queue.get(runId)).toMatchObject({ status: "completed", conclusion: "success" })
      expect(outcomes, "the pass that settles the deferred run hands over its one outcome").toHaveLength(1)
      expect(outcomes[0]).toMatchObject({
        kind: "landed",
        attemptId: runId,
        run: runId,
        branch: "issue/deferred",
        sha: SHA,
        base: "main",
        integration: { commit: MERGED, baseSha: BASE },
      })

      await app.queue.run({}, runtime)
      expect(outcomes, "a settled attempt re-run opens nothing").toHaveLength(1)
    } finally {
      // Never leave the merge Job held open: disposal waits for it.
      mergeReleased.resolve()
    }
  }

  it("a merge a remote Runner holds open hands over NO outcome on the pass that deferred it, ONE `landed` outcome on the pass that settles it, and none on the pass after", async () => {
    // Ruling 3 (@i/10-yrd/24028): a deferred merge is settled by a LATER pass,
    // and that pass — not the one that started the run, not the one after — is
    // the one that hands its outcome over. A remote Runner answers a submit as
    // soon as the merge Job is started, so the run is live but not terminal
    // when its pass ends; the Job completes on its own clock, and the next
    // pass observes that and settles the run.
    await deferredMerge((app) => app.bays.submit({ branch: "issue/deferred", headSha: SHA, base: "main", baseSha: BASE }))
  })

  it.fails("KNOWN GAP — a DERIVED member's deferred merge is never resumed: no claim names its run, so no later selectorless pass settles it, and its outcome never sends", async () => {
    // Measured 2026-09-01 while closing ruling 3: with a recordless branch fact
    // the journal after the second pass holds only derived-identity/bound,
    // candidate/created, run/started and an admission/refused — no run/settled,
    // no pr/integrated. `pendingQueueRoots` lists claim-consuming roots only,
    // and a derived member consumes no `authority.claims` token. The settle
    // path, and with it the outcome, is unreachable for this lane until root
    // discovery covers derived runs. Flip this to `it` when it does.
    await deferredMerge((app) => app.bays.recordBranchSubmit({ branch: "issue/deferred", sha: SHA, base: "main" }))
  })

  it("a hook that throws does not take the pass down: the outcome was attempted once and the compose still resolves", async () => {
    const outcomes: QueueOutcome[] = []
    await using app = await createApp({
      outcomes,
      hook: async () => {
        throw new Error("notifier exploded")
      },
    })
    await app.bays.recordBranchSubmit({ branch: "issue/hook-throws", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(outcomes).toHaveLength(1)
  })
})
