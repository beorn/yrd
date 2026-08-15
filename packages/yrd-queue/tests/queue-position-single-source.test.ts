/**
 * @failure Queue position is derived twice from two different orderings —
 * `admissionOrder()` ranks submitted PRs by submit time, while
 * `eligibility().checks.position` ranks them by check-request time over a
 * differently-filtered list. One response then reports two different positions
 * for the same PR (the reported specimen: checks position 4, PR position 7),
 * and at least one of them is wrong at any moment.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withQueue, withStep, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
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

async function createQueueApp(clock: () => string) {
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
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock, log: createLogger("test", [{ level: "silent" }]) },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

async function submit(app: QueueApp, branch: string): Promise<string> {
  // Each PR needs its own head: an identical payload is refused as a duplicate.
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr.id
}

/**
 * The published, one-based position, derived exactly as `@yrd/cli` derives it
 * for every queue row (`queueAdmissionPositions(result.admissionOrder)`). It is
 * reproduced here rather than imported so this package's contract is testable
 * without depending on its own consumer.
 */
function publishedPosition(app: QueueApp, pr: string): number | undefined {
  const index = app.queue.admissionOrder().indexOf(pr)
  return index < 0 ? undefined : index + 1
}

describe("queue position is derived once", () => {
  it("reports one position per PR when submit order and check-request order disagree", async () => {
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp(() => now)

    // `first` reaches the bay first but asks for checks last, so submit order
    // and check-request order are deliberately opposite.
    const first = await submit(app, "issue/submitted-first")
    now = "2026-01-01T00:01:00.000Z"
    const second = await submit(app, "issue/submitted-second")
    now = "2026-01-01T00:02:00.000Z"
    await app.bays.requestChecks({ pr: second })
    now = "2026-01-01T00:03:00.000Z"
    await app.bays.requestChecks({ pr: first })

    for (const pr of [first, second]) {
      expect(app.queue.eligibility(pr).checks.position).toBe(publishedPosition(app, pr))
    }
  })

  it("orders the published admission order the way admission actually runs", async () => {
    // `admit({})` consumes the check-request ordering, so the position the
    // fleet reads must predict it rather than restating submit order.
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp(() => now)
    const first = await submit(app, "issue/submitted-first")
    now = "2026-01-01T00:01:00.000Z"
    const second = await submit(app, "issue/submitted-second")
    now = "2026-01-01T00:02:00.000Z"
    await app.bays.requestChecks({ pr: second })
    now = "2026-01-01T00:03:00.000Z"
    await app.bays.requestChecks({ pr: first })

    expect(app.queue.admissionOrder()).toEqual([second, first])
  })
})
