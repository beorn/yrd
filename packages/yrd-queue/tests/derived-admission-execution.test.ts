/**
 * @failure A DERIVED member's admission executes a step callback twice per
 * admission (once as the drain's standalone admission Job, once again inside
 * the root run, because the run's admission-reuse read is record-backed and a
 * derived member has no record), or an infrastructure-class failure inside the
 * admission drain — a step callback that THROWS instead of returning a
 * verdict, or a base-declared plan this process cannot execute — is downgraded
 * to a warn-and-skip and the selectorless compose resolves cleanly having
 * recorded that verdict nowhere. Both are invisible to step callbacks that are
 * idempotent and never raise, which is every callback the door's own tests
 * use; these fixtures count invocations and throw on purpose.
 * @level l2
 * @consumer @yrd/queue
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
  type DeclaredStepPlanAtBase,
  type IntegrationProof,
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

/** submit-intake.test.ts's exact reference configuration, with the two knobs
 * these regressions need: an instrumented `check` callback and an optional
 * base-declared plan. `calls` counts CALLBACK INVOCATIONS — the door's own
 * suites only ever observe the run projection, which is exactly why neither
 * defect was visible to them. */
async function createApp(
  options: Readonly<{
    calls?: Map<string, number>
    checkRun?: () => JobResult<z.infer<typeof CheckResultSchema>>
    resolveDeclaredPlan?: (baseSha: string) => DeclaredStepPlanAtBase
  }> = {},
) {
  const count = (step: string): void => {
    const calls = options.calls
    if (calls !== undefined) calls.set(step, (calls.get(step) ?? 0) + 1)
  }
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => {
      count("check")
      return options.checkRun === undefined
        ? { status: "completed", conclusion: "success", output: { checked: true } }
        : options.checkRun()
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => {
      count("merge")
      return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
    },
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
    ...(options.resolveDeclaredPlan === undefined ? {} : { resolveDeclaredPlan: options.resolveDeclaredPlan }),
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

describe("derived admission executes each step exactly once and fails loud (post-S6)", () => {
  it("one selectorless compose invokes each step callback EXACTLY once per derived admission", async () => {
    const calls = new Map<string, number>()
    await using app = await createApp({ calls })
    await app.bays.recordBranchSubmit({ branch: "issue/counted", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    // The admission drain already executed `check` as a standalone admission
    // Job; the root run must REUSE that verdict (as the record lane does), not
    // execute the callback a second time. One admission, one invocation.
    expect(Object.fromEntries(calls)).toEqual({ check: 1, merge: 1 })
  })

  it("a step callback that THROWS during a derived admission fails the compose loudly with the registered runner-error code", async () => {
    const calls = new Map<string, number>()
    await using app = await createApp({
      calls,
      checkRun: () => {
        throw new Error("git object store unreadable: input/output error")
      },
    })
    await app.bays.recordBranchSubmit({ branch: "issue/infra", sha: SHA, base: "main" })

    // A thrown callback is machinery failure, not a check verdict — the job
    // layer records it as the registered `runner-error` code. The record lane
    // absorbs it into a durable admission-refused record; a DERIVED member has
    // no record to carry that verdict, so proceeding silently would leave the
    // failure recorded NOWHERE. The compose must refuse loudly instead.
    await expect(app.queue.run({}, runtime)).rejects.toThrow(/runner-error|input\/output error/u)
    expect(calls.get("merge")).toBeUndefined()
  })

  it("a base ref declaring a step this process cannot execute refuses the DERIVED compose the way it refuses an explicit run", async () => {
    const calls = new Map<string, number>()
    await using app = await createApp({
      calls,
      resolveDeclaredPlan: () => ({ configBlobSha: "d".repeat(40), steps: ["check", "publish", "merge"] }),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/unknown-step", sha: SHA, base: "main" })

    // 23192's contract: no run proceeds while the installed set and the
    // declared plan disagree. The explicit path already rejects; the
    // selectorless derived path must not downgrade the same refusal to a
    // warn-and-skip that resolves cleanly.
    await expect(app.queue.run({}, runtime)).rejects.toThrow(/publish/u)
    expect(calls.get("merge"), "nothing may integrate under a plan this process cannot honour").toBeUndefined()
  })
})
