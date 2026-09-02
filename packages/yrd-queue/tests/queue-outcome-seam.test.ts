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
import { withJobs, type JobResult } from "@yrd/job"
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

  it("a derived member's outcome carries the submit fact's `notify` seat as its submitter; a refs/for fact with none carries none", async () => {
    const outcomes: QueueOutcome[] = []
    await using app = await createApp({ outcomes })
    await app.bays.recordBranchSubmit({ branch: "issue/notified", sha: SHA, base: "main", notify: "@dev/9" })
    expect(app.bays.state().submits["issue/notified"]).toMatchObject({ sha: SHA, notify: "@dev/9" })

    await app.queue.run({}, runtime)

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ kind: "landed", branch: "issue/notified", submitter: "@dev/9" })
  })

  it("the ball id is journaled ON THE ATTEMPT ROW (queue/attempt/notified → queues.outcomes[attempt]); the first row stands", async () => {
    const outcomes: QueueOutcome[] = []
    await using app = await createApp({ outcomes })
    await app.bays.recordBranchSubmit({ branch: "issue/row", sha: SHA, base: "main" })
    const runs = await app.queue.run({}, runtime)
    const attempt = outcomes[0]?.attemptId
    if (attempt === undefined) throw new Error("expected one ended attempt")
    expect(attempt).toBe(runs[0]?.id)
    expect(app.state().queues.outcomes).toEqual({})

    await app.queue.noteAttemptOutcome({ attempt, kind: "landed", recipient: "@dev/9", disposition: "landed", ball: "ball-1" })
    await app.queue.noteAttemptOutcome({ attempt, kind: "landed", recipient: "@cto", disposition: "landed", ball: "ball-2" })
    await app.queue.noteAttemptOutcome({ attempt: "pass:r1:t1", kind: "yrd-broken", recipient: "@cto", disposition: "pass-error" })

    expect(app.state().queues.outcomes).toEqual({
      [attempt]: { attempt, kind: "landed", recipient: "@dev/9", disposition: "landed", ball: "ball-1", at: "2026-01-01T00:00:00.000Z" },
      "pass:r1:t1": { attempt: "pass:r1:t1", kind: "yrd-broken", recipient: "@cto", disposition: "pass-error", at: "2026-01-01T00:00:00.000Z" },
    })
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
