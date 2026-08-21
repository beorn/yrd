/**
 * @failure The run path and the status surface computed "runnable" separately
 * and disagreed: on 2026-08-16 `queue status` showed seven carriers ready and
 * `mr list` runnable=true while the run path computed not-runnable for every
 * one, and six instruments reported healthy through a six-hour freeze
 * (@pm/incidents/22881; ruling @i/10-merge-queue/22895). Both surfaces now
 * reach `ChangeEligibility` through one constructor; this file is the
 * congruence pin that turns the next divergence into a red test instead of an
 * outage: ONE fixture, BOTH surfaces, asserted equal per carrier, with the one
 * legitimate population difference stated rather than hidden.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { changeDeliveryState, createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
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

/** A queue that REQUIRES review, so submitted-but-unapproved work is ineligible for a named reason. */
async function createQueueApp(log = createLogger("test", [{ level: "silent" }])) {
  const checkStep = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"], requires: ["review"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log,
    },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

function nextHead(app: QueueApp): string {
  // Each PR needs its own head: an identical payload is refused as a duplicate.
  return (Object.keys(app.state().bays.prs).length + 1).toString(16).repeat(40)
}

function recorded(app: QueueApp, branch: string): string {
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr.id
}

async function submit(app: QueueApp, branch: string): Promise<string> {
  await app.bays.submit({ branch, headSha: nextHead(app), base: "main", baseSha: BASE })
  return recorded(app, branch)
}

/** A pushed-not-submitted record — the draft the model keeps explicit. */
async function push(app: QueueApp, branch: string): Promise<string> {
  await app.bays.intake({ branch, headSha: nextHead(app), base: "main", baseSha: BASE })
  return recorded(app, branch)
}

/** The status surface's verdict, reduced to what a reader compares: runnable + reason. */
function statusVerdict(app: QueueApp, pr: string) {
  const eligibility = app.queue.eligibility(pr)
  return {
    pr,
    revision: eligibility.revision,
    runnable: eligibility.runnable,
    ...(eligibility.reason === undefined ? {} : { code: eligibility.reason.code, reason: eligibility.reason.message }),
  }
}

describe("eligibility congruence — one fixture, both surfaces", () => {
  it("the run path's every considered carrier carries the status surface's exact verdict", async () => {
    await using app = await createQueueApp()
    // Three submitted carriers, each ineligible for a DIFFERENT reason, so a
    // surface that collapsed reasons (or read a different input) would fail on
    // content, not just on count.
    const queued = await submit(app, "issue/checks-queued")
    await app.bays.requestChecks({ pr: queued })
    const unreviewed = await submit(app, "issue/needs-review")
    const rejected = await submit(app, "issue/review-rejected")
    await app.bays.review({ pr: rejected, by: "@reviewer", decision: "reject" })
    // Two records the run path must NOT consider, which the status surface still explains.
    const draft = await push(app, "issue/still-draft")
    const withdrawn = await submit(app, "issue/withdrawn")
    await app.bays.closePr({ pr: withdrawn, reason: "superseded" })

    // Run path: selectorless `queue run` over the default plan. With nothing
    // runnable it returns every decision it made, which is the only shape in
    // which the run path's full verdict list is observable.
    const direct = await app.dispatch(app.commands.queue.run, {})
    expect(direct.events).toEqual([])
    const outcome = direct.value as {
      kind: string
      considered: ReadonlyArray<{ pr: string; revision: number; code: string; reason: string }>
    }
    expect(outcome.kind).toBe("no-runnable-prs")

    // 1. Content congruence: each considered row IS the status verdict, field for field.
    for (const row of outcome.considered) {
      expect(statusVerdict(app, row.pr)).toEqual({ ...row, runnable: false })
    }
    // 2. The reasons really are distinct — the fixture exercised three branches of the derivation.
    expect(outcome.considered.map((row) => row.code).toSorted()).toEqual(
      ["checks-pending", "review-rejected", "review-required"].toSorted(),
    )
    // 3. Population congruence, stated: the run path considers exactly the
    //    submitted/ready records; the status surface lists every record.
    const prs = Object.values(app.state().bays.prs)
    const submitted = prs
      .filter((pr) => ["submitted", "ready"].includes(changeDeliveryState(pr)))
      .map((pr) => pr.id)
      .toSorted()
    expect(outcome.considered.map((row) => row.pr).toSorted()).toEqual(submitted)
    expect(submitted).toEqual([queued, unreviewed, rejected].toSorted())
    const statusOnly = app.queue
      .eligibilities()
      .filter((eligibility) => !submitted.includes(eligibility.pr))
      .map((eligibility) => ({ pr: eligibility.pr, code: eligibility.reason?.code }))
      .toSorted((left, right) => left.pr.localeCompare(right.pr))
    expect(statusOnly).toEqual(
      [
        { pr: draft, code: "draft" },
        { pr: withdrawn, code: "terminal" },
      ].toSorted((left, right) => left.pr.localeCompare(right.pr)),
    )
    // 4. And the status surface, read whole, is the same derivation the per-PR
    //    read returns — no second list hiding behind the plural.
    for (const eligibility of app.queue.eligibilities()) {
      expect(eligibility).toEqual(app.queue.eligibility(eligibility.pr))
    }
  })

  it("an empty FIFO says what it looked at instead of returning nothing", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(log)
    // Records exist, but none is submitted: one draft, one withdrawn.
    await push(app, "issue/only-a-draft")
    const withdrawn = await submit(app, "issue/withdrawn-again")
    await app.bays.closePr({ pr: withdrawn, reason: "superseded" })

    const direct = await app.dispatch(app.commands.queue.run, {})
    expect(direct.events).toEqual([])
    // Before 2026-08-21 this was `{ events: [] }` and nothing else: an honest
    // empty and a run that never looked were the same bytes.
    expect(direct.value).toEqual({
      kind: "no-submitted-prs",
      population: { pushed: 1, withdrawn: 1 },
      excluded: 0,
      selectedSteps: ["check"],
      reason: "no submitted or ready PR is visible to the queue",
    })

    await expect(app.queue.run({}, { runner: "local", leaseMs: 60_000 })).resolves.toEqual([])
    const line = events.find(
      (event) => event.kind === "log" && event.props?.action === "queue-run-no-submitted-prs",
    )
    expect(line).toBeDefined()
    // info, never warn: the empty FIFO is the resident runner's normal state.
    expect(line?.kind === "log" ? line.level : undefined).toBe("info")
    expect(line?.props).toMatchObject({ population: { pushed: 1, withdrawn: 1 }, excluded: 0 })
  })

  it("a runnable verdict on the status surface is a started run on the run path", async () => {
    await using app = await createQueueApp()
    const approved = await submit(app, "issue/approved")
    await app.bays.review({ pr: approved, by: "@reviewer", decision: "approve" })
    const unreviewed = await submit(app, "issue/needs-review")

    expect(statusVerdict(app, approved)).toEqual({ pr: approved, revision: 1, runnable: true })
    expect(statusVerdict(app, unreviewed)).toMatchObject({ runnable: false, code: "review-required" })

    const direct = await app.dispatch(app.commands.queue.run, {})
    // A run that starts carries no `no-runnable-prs` value: the decision list
    // is observable only on the empty path (see the first test), so here the
    // events are the evidence. The approved carrier — and only it — entered a run.
    expect((direct.value as { kind?: string } | undefined)?.kind).not.toBe("no-runnable-prs")
    const started = direct.events.flatMap((event) =>
      event.name === "queue/run/started"
        ? (event.data as { run: { prs: ReadonlyArray<{ id: string }> } }).run.prs.map((pr) => pr.id)
        : [],
    )
    expect(started).toEqual([approved])
  })
})
