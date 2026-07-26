/**
 * @failure A terminal PR (withdrawn/canceled/integrated) keeps reporting
 * `checks.status: "queued"` because the checks projection is derived from the
 * append-only check-request history without consulting delivery state — so a
 * reader sees work in flight that the admission queue can never run.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, prDeliveryState, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withQueue, withStep, type PRShape, type StepExecution, type StepRunner } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
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

async function createQueueApp(check?: StepRunner<PRShape, CheckResult>) {
  const checkStep = withStep(
    "check",
    (input: StepExecution, context): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      check?.(input, context) ?? { status: "completed", conclusion: "success", output: { checked: true } },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

async function submitWithChecks(app: Pick<QueueApp, "bays" | "state">, branch: string): Promise<string> {
  await app.bays.submit({ branch, headSha: HEAD, base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id })
  return pr.id
}

describe("terminal PRs never project a live check status", () => {
  it("stops reporting checks.status queued once a requested PR is withdrawn", async () => {
    await using app = await createQueueApp()
    const pr = await submitWithChecks(app, "topic/withdrawn-while-queued")

    // Baseline: the request is live and waiting on the admission queue. It is
    // not yet `runnable` — that flips only once checks settle — but the reason
    // is `checks-pending`, i.e. a live slot, not a terminal state.
    expect(app.queue.eligibility(pr).checks.status).toBe("queued")
    expect(app.queue.eligibility(pr).reason?.code).toBe("checks-pending")

    await app.bays.closePr({ pr })

    const withdrawn = app.bays.pr(pr)
    if (withdrawn === undefined) throw new Error("expected PR")
    expect(prDeliveryState(withdrawn)).toBe("withdrawn")

    const eligibility = app.queue.eligibility(pr)
    // The delivery-state surface already tells the truth.
    expect(eligibility.runnable).toBe(false)
    expect(eligibility.reason?.code).toBe("terminal")
    // The checks surface must agree: a withdrawn PR is not queued for anything.
    // Its `queuedAt` remains as history, but `status` may not claim a live slot.
    expect(eligibility.checks.status).not.toBe("queued")
    expect(eligibility.checks.status).toBe("not-requested")
    expect(eligibility.checks.position).toBeUndefined()
    expect(eligibility.checks.queuedAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("keeps a materialized run's real verdict on a terminal PR", async () => {
    // Gating must not erase facts. A run that actually executed is history, not
    // a claim about a live queue slot, so its verdict survives withdrawal.
    await using app = await createQueueApp()
    const pr = await submitWithChecks(app, "topic/passed-then-withdrawn")
    await app.queue.run({}, runtime)
    expect(app.queue.eligibility(pr).checks.status).toBe("passed")

    await app.bays.closePr({ pr })

    const eligibility = app.queue.eligibility(pr)
    expect(eligibility.reason?.code).toBe("terminal")
    expect(eligibility.checks.status).toBe("passed")
    expect(eligibility.checks.run).toBeDefined()
  })
})
