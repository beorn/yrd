/**
 * @failure Queue position is derived twice from two different orderings —
 * `admissionOrder()` ranks submitted PRs by submit time, while
 * `eligibility().checks.position` ranks them by check-request time over a
 * differently-filtered list. One response then reports two different positions
 * for the same PR (the reported specimen: checks position 4, PR position 7),
 * and at least one of them is wrong at any moment.
 *
 * S7 conversion note (branch-is-change, @i/10 22991): the ORDERING half of that
 * divergence is now structural rather than tested. `bays.requestChecks` is
 * deleted, so no second clock exists to rank by, and `checks.position` routes
 * through the same `admissionPosition` -> `admissionOrderChanges` source that
 * `admissionOrder()` publishes. What these fixtures still hold is the surface
 * PAIR — the two readers that used to disagree must keep reporting the same
 * number — and the FILTER half, which still has teeth: position is where you
 * stand in the queue, not a claim about the next pass, so a member a pause
 * holds out of the next pass keeps its published position on both surfaces.
 * The assertions below look weaker than the original deliberately; that is the
 * divergence becoming impossible, not coverage decaying.
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
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock, log: createLogger("test", [{ level: "silent" }]) },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

/** The standing submit fact IS the delivery (S7 branch-is-change). Each branch
 * needs its own head: an identical payload is refused as a duplicate. */
async function submit(app: QueueApp, branch: string): Promise<string> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
  return branch
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
  it("reports one position per change across BOTH surfaces that used to disagree", async () => {
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp(() => now)

    await submit(app, "issue/submitted-first")
    now = "2026-01-01T00:01:00.000Z"
    await submit(app, "issue/submitted-second")

    // Ids come from the published order rather than being named here: on the
    // derived lane a member's number is minted for it, and the invariant under
    // test is about the two READERS agreeing, not about which id is which.
    const order = app.queue.admissionOrder()
    expect(order, "both standing submit facts must hold a queue position").toHaveLength(2)
    for (const pr of order) {
      expect(app.queue.eligibility(pr).checks.position).toBe(publishedPosition(app, pr))
    }
  })

  it("orders the published admission order by the submit clock that admission consumes", async () => {
    // `admit({})` consumes the submit-fact ordering, so the position the fleet
    // reads must predict it. One clock now, so the published order is simply
    // the order the facts were approved in.
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp(() => now)
    await submit(app, "issue/submitted-first")
    now = "2026-01-01T00:01:00.000Z"
    await submit(app, "issue/submitted-second")

    const order = app.queue.admissionOrder()
    expect(order).toHaveLength(2)
    // The earlier fact leads, and `eligibility` agrees about which one that is.
    expect(app.queue.eligibility(order[0]!).checks.position).toBe(1)
    expect(app.queue.eligibility(order[1]!).checks.position).toBe(2)
  })

  it("keeps a paused member's position on both surfaces — a position is not a claim about the next pass", async () => {
    // The FILTER half of the original divergence, and the half that still has
    // teeth: `checks.position` once ranked over a differently-filtered list, so
    // a member held out of the next pass vanished from one surface while the
    // other still published it. Position is where you stand in the queue.
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp(() => now)
    await submit(app, "issue/submitted-first")
    now = "2026-01-01T00:01:00.000Z"
    await submit(app, "issue/submitted-second")

    const before = app.queue.admissionOrder()
    expect(before).toHaveLength(2)

    // An empty allow-list holds every member out of the next pass. The pause
    // lives in queue state, never in `bays`, so it cannot reach the published
    // order — and both readers must still answer.
    now = "2026-01-01T00:02:00.000Z"
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })

    expect(app.queue.admissionOrder(), "a pause holds work; it does not un-queue it").toEqual(before)
    for (const pr of before) {
      expect(app.queue.eligibility(pr).checks.position).toBe(publishedPosition(app, pr))
    }
  })
})
