/**
 * @failure A composition refusal that reaches the runner is misreported as a plain
 * `checks-failed` (or as a submit-time door refusal), hiding that the author must
 * re-author the candidate; and a submitted PR with requested checks is not
 * discoverable by a later queue run when submit did not drain.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
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
      status: "passed",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "passed",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    deprovision: () => ({ status: "passed", output: {} }),
  }
}

async function createQueueApp(check?: StepRunner<PRShape, CheckResult>) {
  const checkStep = withStep(
    "check",
    (input: StepExecution, context): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      check?.(input, context) ?? { status: "passed", output: { checked: true } },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock: () => "2026-01-01T00:00:00.000Z" },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

async function submitWithChecks(app: QueueApp, branch: string): Promise<string> {
  await app.bays.submit({ branch, headSha: HEAD, base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id })
  return pr.id
}

describe("needs-author eligibility (derived composition-refusal projection)", () => {
  it("projects a composition refusal that reached the runner as needs-author with its receipt", async () => {
    await using app = await createQueueApp(() => ({
      status: "failed",
      error: { code: "composition-invalid", message: "PR 'PR1' composition head contains root changes" },
    }))
    const pr = await submitWithChecks(app, "topic/authored-root")

    await expect(app.queue.run({}, runtime)).resolves.toMatchObject([{ status: "failed" }])

    const eligibility = app.queue.eligibility(pr)
    expect(eligibility.runnable).toBe(false)
    expect(eligibility.reason?.code).toBe("needs-author")
    expect(eligibility.reason?.receipt).toMatchObject({
      code: "composition-invalid",
      message: "PR 'PR1' composition head contains root changes",
    })
    expect(eligibility.reason?.message).toContain("cannot be composed as submitted")
  })

  it("keeps an ordinary check failure (tests/lint) off the needs-author path", async () => {
    // An ordinary red check drives the normal automatic rejection; that is a
    // `rejected` verdict ("submit it again"), never `needs-author` — which is
    // reserved for a composition the queue could not build.
    await using app = await createQueueApp(() => ({
      status: "failed",
      error: { code: "check-failed", message: "unit tests failed" },
    }))
    const pr = await submitWithChecks(app, "topic/red-tests")

    await expect(app.queue.run({}, runtime)).resolves.toMatchObject([{ status: "failed" }])

    const eligibility = app.queue.eligibility(pr)
    expect(eligibility.runnable).toBe(false)
    expect(eligibility.reason?.code).toBe("rejected")
    expect(eligibility.reason?.receipt).toBeUndefined()
  })

  it("lets a later queue run discover a submitted+requested PR that submit never drained", async () => {
    // The decoupled submit only records `submitted` + requests checks; with no
    // runner active it drains nothing. A subsequent queue run must still find
    // and settle it from the admission queue.
    await using app = await createQueueApp()
    const pr = await submitWithChecks(app, "topic/late-drain")

    // No run has happened yet: the PR is waiting in the admission queue.
    const queued = app.queue.eligibility(pr)
    expect(queued.checks.status).toBe("queued")

    await app.queue.run({}, runtime)
    // The later run found it in the admission queue and settled its checks.
    expect(app.queue.eligibility(pr).checks.status).toBe("passed")
  })
})
