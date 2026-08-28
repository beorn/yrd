/**
 * @failure A terminal change (withdrawn/canceled/integrated) keeps reporting
 * `checks.status: "queued"` because the checks projection is derived from the
 * append-only check-request history without consulting delivery state — so a
 * reader sees work in flight that the admission queue can never run.
 * @level l2
 * @consumer @yrd/queue
 *
 * S7 conversion note (branch-is-change, @i/10 22991): the record verbs these
 * journeys drove (`bays.submit` per-id, `requestChecks`, `closePr`) are
 * deleted; the record states under test now seed as replayed journal history
 * (boot-time frames plus a mid-test appended withdrawal folded in with
 * `app.refresh()`). The revision verdict is seeded too (`pr/admission-recorded`
 * history) — post-S7 nothing writes an admission onto a record, so a stored
 * verdict only exists as replay. The projection under test is unchanged.
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, changeAdmission, changeDeliveryState, resolveChange, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withQueue, withStep, type ChangeShape, type StepExecution, type StepRunner } from "@yrd/queue"
import {
  appendSeedFrame,
  changeEvent,
  changeSeedEvents,
  seedFrame,
  seedIds,
  type ChangeSeed,
} from "./support/seeded-changes.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

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

async function createQueueApp(
  seeds: readonly ChangeSeed[],
  check?: StepRunner<ChangeShape, CheckResult>,
) {
  const checkStep = withStep(
    "check",
    (input: StepExecution, context): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      check?.(input, context) ?? { status: "completed", conclusion: "success", output: { checked: true } },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  const nextId = seedIds()
  const journal = createMemoryJournal<unknown>([seedFrame(nextId, changeSeedEvents(nextId, seeds))])
  const app = await createYrd(queue(base), {
    inject: {
      journal: journal as never,
      id: nextId,
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
  return { app, journal, nextId }
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>["app"]

/** The old `closePr` withdrawal, as the replayed fact it used to write. */
async function withdraw(fixture: Awaited<ReturnType<typeof createQueueApp>>, pr: string): Promise<void> {
  await appendSeedFrame(
    fixture.journal,
    seedFrame(fixture.nextId, [changeEvent(fixture.nextId, "pr/withdrawn", { pr, revision: 1, headSha: HEAD })]),
  )
  await fixture.app.refresh()
}

function recordedChange(app: QueueApp, pr: string) {
  const change = resolveChange(app.state().bays, pr)
  if (change === undefined) throw new Error("expected PR")
  return change
}

describe("terminal PRs never project a live check status", () => {
  it("stops reporting checks.status queued once a requested PR is withdrawn", async () => {
    const fixture = await createQueueApp([
      { pr: "PR1", branch: "topic/withdrawn-while-queued", headSha: HEAD, checksRequested: true },
    ])
    await using app = fixture.app
    const pr = "PR1"

    // Baseline: the request is live and waiting on the admission queue. It is
    // not yet `runnable` — that flips only once checks settle — but the reason
    // is `checks-pending`, i.e. a live slot, not a terminal state.
    expect(app.queue.eligibility(pr).checks.status).toBe("queued")
    expect(app.queue.eligibility(pr).reason?.code).toBe("checks-pending")

    await withdraw(fixture, pr)

    const withdrawn = recordedChange(app, pr)
    expect(changeDeliveryState(withdrawn)).toBe("withdrawn")

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

  it("keeps an immutable revision verdict on a terminal change", async () => {
    // Gating must not erase facts. The revision verdict is history, not a claim
    // about a live queue slot, so it survives withdrawal without a Queue Run.
    // Post-S7 the verdict itself is replayed history: nothing writes an
    // admission onto a record any more, so the passed verdict seeds as the
    // `pr/admission-recorded` fact the admission path used to write.
    const fixture = await createQueueApp([
      { pr: "PR1", branch: "topic/passed-then-withdrawn", headSha: HEAD, checksRequested: true },
    ])
    await using app = fixture.app
    const pr = "PR1"
    await appendSeedFrame(
      fixture.journal,
      seedFrame(fixture.nextId, [
        changeEvent(fixture.nextId, "pr/admission-recorded", {
          pr,
          revision: 1,
          headSha: HEAD,
          admission: {
            status: "passed",
            baseSha: BASE,
            requestCount: 1,
            steps: [{ name: "check", revision: "check-v1", job: "J-check", status: "passed", output: { checked: true } }],
          },
        }),
      ]),
    )
    await app.refresh()
    expect(app.queue.eligibility(pr).checks.status).toBe("passed")
    expect(changeAdmission(recordedChange(app, pr))).toMatchObject({ status: "passed", baseSha: BASE })

    await withdraw(fixture, pr)

    const eligibility = app.queue.eligibility(pr)
    expect(eligibility.reason?.code).toBe("terminal")
    expect(eligibility.checks.status).toBe("passed")
    expect(eligibility.checks.run).toBeUndefined()
  })
})
