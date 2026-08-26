/**
 * @failure The run path and the status surface computed "runnable" separately
 * and disagreed: on 2026-08-16 the queue view showed seven carriers ready and
 * `mr list` runnable=true while the run path computed not-runnable for every
 * one, and six instruments reported healthy through a six-hour freeze
 * (@pm/incidents/22881; ruling @i/10-merge-queue/22895). Both surfaces now
 * reach `ChangeEligibility` through one constructor; this file is the
 * congruence pin that turns the next divergence into a red test instead of an
 * outage: ONE fixture, BOTH surfaces, asserted equal per carrier, with the one
 * legitimate population difference stated rather than hidden.
 *
 * The final describe block discharges the UNSHIPPED half of the 22895 ruling
 * (@i/10-merge-queue/22895): agreeing on the verdict is not enough — every
 * blocking reason code must also REACH a human with its message. It is
 * table-driven over the whole `ChangeEligibilityReason["code"]` union with a
 * compile-time exhaustiveness pin, so a new code that renders nowhere is a red
 * test (or a type error), not a silent `-` in a WHY column.
 * @level l2
 * @consumer @yrd/queue
 */
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { changeDeliveryState, createBayJobDefs, withBays, type BayWorkspace, type Change } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withQueue, withStep, type ChangeEligibility, type ChangeEligibilityReason, type StepExecution } from "@yrd/queue"
// The human surface under test lives in @yrd/cli; tests may reach across the
// package boundary the same way refusal-code-registry.test.ts already does.
import { ChangeStatusView } from "../../yrd-cli/src/status-view.tsx"

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
    const line = events.find((event) => event.kind === "log" && event.props?.action === "queue-run-no-submitted-prs")
    expect(line).toBeDefined()
    // info, never warn: the empty FIFO is the habitant runner's normal state.
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

describe("eligibility congruence — the second source (refs/yrd/submit, projected by the receiver)", () => {
  const SHA = "7".repeat(40)

  it("a branch approved ONLY in git is visible on every surface with its reason, and runnable on none", async () => {
    // No legacy record at all — the fixture @cto made acceptance: a dual-source
    // reader tested only on rows that have both sources has not been tested.
    await using app = await createQueueApp()
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })

    // Status surface: the unrecorded list and the branch-keyed derivation agree.
    const unrecorded = app.queue.unrecordedSubmits()
    expect(unrecorded).toEqual([
      {
        branch: "issue/ref-only",
        sha: SHA,
        base: "main",
        at: "2026-01-01T00:00:00.000Z",
        reason: { code: "unrecorded-submit", message: expect.stringContaining("no PR record carries it") },
      },
    ])
    const derived = app.queue.deriveChange("issue/ref-only")
    expect(derived).toEqual({
      branch: "issue/ref-only",
      submit: { sha: SHA, base: "main", at: "2026-01-01T00:00:00.000Z" },
      unrecorded: unrecorded[0],
    })
    expect(derived.record).toBeUndefined()
    expect(derived.eligibility).toBeUndefined()
    // The record-keyed list does not invent a change for it.
    expect(app.queue.eligibilities()).toEqual([])

    // Run path: the considered rows carry the same branch-keyed verdict — not
    // "nothing is submitted", because something IS.
    const direct = await app.dispatch(app.commands.queue.run, {})
    expect(direct.events).toEqual([])
    expect(direct.value).toEqual({
      kind: "no-runnable-prs",
      considered: [
        {
          branch: "issue/ref-only",
          sha: SHA,
          code: "unrecorded-submit",
          reason: unrecorded[0]?.reason.message,
        },
      ],
      selectedSteps: ["check"],
      reason: "every considered PR was ineligible for the selected plan",
    })
  })

  it("the record wins when both sources exist for one branch, and the unrecorded row disappears", async () => {
    await using app = await createQueueApp()
    await app.bays.recordBranchSubmit({ branch: "issue/both", sha: SHA, base: "main" })
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/both"])

    const pr = await submit(app, "issue/both")
    expect(app.queue.unrecordedSubmits()).toEqual([])
    const derived = app.queue.deriveChange("issue/both")
    expect(derived.record?.id).toBe(pr)
    expect(derived.eligibility).toEqual(app.queue.eligibility(pr))
    expect(derived.submit).toMatchObject({ sha: SHA, base: "main" })
    expect(derived.unrecorded).toBeUndefined()
  })

  it("an unsubmit fact removes the branch from every surface; an unsubmit for a branch that never submitted is a no-op", async () => {
    await using app = await createQueueApp()
    await app.bays.recordBranchSubmit({ branch: "issue/gone", sha: SHA, base: "main" })
    await app.bays.recordBranchUnsubmit({ branch: "issue/gone", reason: "deleted" })
    expect(app.queue.unrecordedSubmits()).toEqual([])
    expect(app.queue.deriveChange("issue/gone")).toEqual({ branch: "issue/gone" })

    const before = app.state()
    await app.bays.recordBranchUnsubmit({ branch: "issue/never", reason: "archived" })
    expect(app.state().bays.submits).toEqual(before.bays.submits)
    // Back to the honest empty: nothing submitted anywhere.
    const direct = await app.dispatch(app.commands.queue.run, {})
    expect(direct.value).toMatchObject({ kind: "no-submitted-prs", population: {} })
  })
})

describe("eligibility congruence — every blocking reason reaches a human (22895, unshipped half)", () => {
  /** Every member of `ChangeEligibilityReason["code"]`. The `satisfies` pins
   * CODES ⊆ union; `_allCodesCovered` pins union ⊆ CODES, so growing the union
   * without extending this fence is a compile error, not a silent gap. */
  const CODES = [
    "draft",
    "checks-pending",
    "admission-refused",
    "required-check-failed",
    "needs-author",
    "candidate-conflicting",
    "review-required",
    "review-rejected",
    "queue-paused",
    "claimed",
    "checking",
    "rejected",
    "terminal",
  ] as const satisfies readonly ChangeEligibilityReason["code"][]
  type UncoveredCode = Exclude<ChangeEligibilityReason["code"], (typeof CODES)[number]>
  const _allCodesCovered: UncoveredCode extends never ? true : never = true
  void _allCodesCovered

  function viewChange(pr: string): Change {
    return {
      id: pr,
      name: `Change ${pr}`,
      branch: `topic/${pr.toLowerCase()}`,
      base: "main",
      state: "open",
      merged: false,
      revs: [
        {
          n: 1,
          head: HEAD,
          base: "main",
          baseSha: BASE,
          pushedAt: "2026-01-01T00:00:00.000Z",
          submittedAt: "2026-01-01T00:00:00.000Z",
          submitter: "author@example.test",
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
    }
  }

  it.each(CODES.map((code) => ({ code })))(
    "a change blocked with reason code '$code' renders its message on the change-status surface",
    async ({ code }) => {
      const message = `the human explanation for ${code}`
      const eligibility: ChangeEligibility = {
        pr: "PR1",
        revision: 1,
        runnable: false,
        reason: { code, message },
        review: { required: false, approved: false, stale: false },
        checks: { status: "not-requested" },
      }
      const output = await renderString(
        createElement(ChangeStatusView, { prs: [viewChange("PR1")], eligibilities: [eligibility] }),
        { width: 200, height: 100, plain: true },
      )
      expect(output, `reason code '${code}' must reach a human surface with its message`).toContain(message)
    },
  )
})
