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
import {
  authorAttributionReceipt,
  withMerge,
  withQueue,
  withStep,
  type AddStepResult,
  type PRShape,
  type StepExecution,
  type StepRunner,
} from "@yrd/queue"

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

type CheckedShape = AddStepResult<PRShape, "check", CheckResult>

/** A check(passes) → merge(integrating) queue, so a composition refusal can be
 * placed SOLELY on the integrating step while a passed check record is also
 * present — the exact shape projectPRChecks filters out. */
async function createIntegratingApp(
  merge: (input: StepExecution<CheckedShape>) => JobResult<{ commit: string; baseSha: string }>,
) {
  const checkStep = withStep("check", (): JobResult<CheckResult> => ({ status: "passed", output: { checked: true } }), {
    revision: "check-v1",
    output: CheckResultSchema,
  })
  const mergeStep = withMerge(merge, { revision: "merge-v1" })
  const queue = withQueue({ steps: [checkStep, mergeStep] as const, batch: false, defaultSteps: ["check", "merge"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock: () => "2026-01-01T00:00:00.000Z" },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

async function submitWithChecks(
  app: Pick<QueueApp, "bays" | "state">,
  branch: string,
  headSha = HEAD,
): Promise<string> {
  await app.bays.submit({ branch, headSha, base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id })
  return pr.id
}

describe("native needs-author lifecycle", () => {
  it("projects a composition refusal that reached the runner as needs-author with its receipt", async () => {
    await using app = await createQueueApp(() => ({
      status: "failed",
      error: { code: "composition-invalid", message: "PR 'PR1' composition head contains root changes" },
    }))
    const pr = await submitWithChecks(app, "topic/authored-root")

    await expect(app.queue.run({}, runtime)).resolves.toMatchObject([{ status: "failed" }])

    expect(app.bays.pr(pr)).toMatchObject({
      id: pr,
      status: "needs-author",
      needsAuthor: {
        run: "R1",
        step: "check",
        receipt: {
          code: "composition-invalid",
          message: "PR 'PR1' composition head contains root changes",
        },
      },
    })
    expect(app.bays.pr(pr)?.revisions[0]).toMatchObject({ submittedAt: "2026-01-01T00:00:00.000Z" })
    expect(app.bays.pr(pr)?.revisions[0]?.terminal).toBeUndefined()
    const events = await Array.fromAsync(app.events())
    expect(events.map(({ name }) => name)).toContain("pr/needs-author")
    expect(events.map(({ name }) => name)).not.toContain("pr/rejected")
    expect(app.state().queues.authority).toMatchObject({
      statuses: { PR1: "needs-author" },
      submits: { PR1: { revision: 1, headSha: HEAD } },
      checks: { PR1: { revision: 1, headSha: HEAD } },
    })
    expect(app.bays.prs().map(({ id }) => id)).toContain(pr)

    const correlation = { namespace: "tribe-request", id: "needs-author-repair" }
    const correlated = await app.bays.submitSelection(pr, {
      correlation,
      resolveRevision: async (selector) => (selector === "main" ? BASE : HEAD),
      run: runtime,
    })
    expect(correlated).toMatchObject({
      id: pr,
      revision: 1,
      status: "needs-author",
      correlation,
      revisions: [{ revision: 1, correlation }],
    })
    expect(correlated.revisions).toHaveLength(1)

    const eligibility = app.queue.eligibility(pr)
    expect(eligibility.runnable).toBe(false)
    expect(eligibility.reason?.code).toBe("needs-author")
    expect(eligibility.reason?.receipt).toMatchObject({
      code: "composition-invalid",
      message: "PR 'PR1' composition head contains root changes",
    })
    expect(eligibility.reason?.message).toContain("cannot be composed as submitted")
    const rejectedRun = app.queue.get("R1")
    expect(authorAttributionReceipt(rejectedRun, { pr, revision: 1, headSha: HEAD })).toMatchObject({
      code: "composition-invalid",
    })
    expect(authorAttributionReceipt(rejectedRun, { pr: "PR-other", revision: 1, headSha: HEAD })).toBeUndefined()

    // Receiver/refresh replay of the unchanged rejected head is idempotent:
    // only new authored content may reopen and resume this PR.
    const beforeReplay = await Array.fromAsync(app.events())
    const replay = await app.bays.intake({
      branch: "topic/authored-root",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
    })
    expect(replay.events).toEqual([])
    expect(app.bays.pr(pr)).toMatchObject({ id: pr, revision: 1, headSha: HEAD, status: "needs-author" })
    expect(await Array.fromAsync(app.events())).toEqual(beforeReplay)

    // A fix push advances this already-submitted PR in place and re-requests
    // checks. There is no withdraw/new-PR or submit-again ceremony.
    const fixedHead = "2".repeat(40)
    await app.bays.intake({ branch: "topic/authored-root", headSha: fixedHead, base: "main", baseSha: BASE })
    expect(app.bays.pr(pr)).toMatchObject({ id: pr, revision: 2, headSha: fixedHead, status: "submitted" })
    expect(app.bays.checksRequested(pr)).toBe(true)
    expect(app.queue.eligibility(pr).checks.status).toBe("queued")
    expect(authorAttributionReceipt(app.queue.get("R1"), { pr, revision: 1, headSha: HEAD })).toMatchObject({
      code: "composition-invalid",
    })
  })

  it("does not reopen needs-author when same-head optional metadata, including a non-default base, is omitted", async () => {
    await using app = await createQueueApp(() => ({
      status: "failed",
      error: { code: "composition-invalid", message: "submitted composition cannot be built" },
    }))
    const composition = {
      version: 1 as const,
      sources: [
        {
          repo: "vendor/source",
          branch: "topic/source",
          baseSha: "b".repeat(40),
          tipSha: "c".repeat(40),
          payload: ["src/fix.ts"],
        },
      ],
    }
    await app.bays.submit({
      branch: "topic/same-head",
      name: "original delivery",
      headSha: HEAD,
      base: "release/2.0",
      baseSha: BASE,
      composition,
    })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({}, runtime)
    expect(app.bays.pr("PR1")).toMatchObject({ revision: 1, status: "needs-author" })

    const before = await Array.fromAsync(app.events())
    const omitted = await app.bays.intake({
      branch: "topic/same-head",
      headSha: HEAD,
    })
    const changedMetadata = await app.bays.intake({
      branch: "topic/same-head",
      name: "renamed delivery",
      headSha: HEAD,
    })

    expect(omitted.events).toEqual([])
    expect(changedMetadata.events).toEqual([])
    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 1,
      headSha: HEAD,
      status: "needs-author",
      base: "release/2.0",
      name: "original delivery",
      baseSha: BASE,
      composition,
    })
    expect(await Array.fromAsync(app.events())).toEqual(before)

    const changedComposition = {
      ...composition,
      sources: [{ ...composition.sources[0]!, tipSha: "d".repeat(40) }],
    }
    const authoredChange = await app.bays.intake({
      branch: "topic/same-head",
      headSha: HEAD,
      base: "release/2.0",
      baseSha: BASE,
      composition: changedComposition,
    })
    expect(authoredChange.events.map(({ name }) => name)).toEqual(["pr/pushed", "pr/submitted", "pr/checks-requested"])
    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 2,
      headSha: HEAD,
      status: "submitted",
      composition: changedComposition,
    })
  })

  it("keeps a same-head legacy rejection on its recorded non-default base", async () => {
    await using app = await createQueueApp(() => ({
      status: "failed",
      error: { code: "check-failed", message: "opaque check failure" },
    }))
    await app.bays.submit({
      branch: "topic/legacy-replay",
      headSha: HEAD,
      base: "release/2.0",
      baseSha: BASE,
    })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({}, runtime)
    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 1,
      status: "rejected",
      base: "release/2.0",
      baseSha: BASE,
    })

    const before = await Array.fromAsync(app.events())
    const replay = await app.bays.submit({ branch: "topic/legacy-replay", headSha: HEAD })

    expect(replay.events).toEqual([])
    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 1,
      status: "rejected",
      base: "release/2.0",
      baseSha: BASE,
    })
    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it("surfaces a refusal attached SOLELY to the integrating step (with a passed check present)", async () => {
    // The traced hole: projectPRChecks filters integrating steps and its
    // run.error fallback only fires with zero other records, so a composition
    // refusal on the merge step alongside a passed check record was invisible.
    await using app = await createIntegratingApp(() => ({
      status: "failed",
      error: { code: "wrapper-mismatch", message: "PR 'PR1' generated wrapper paths differ" },
    }))
    const pr = await submitWithChecks(app, "topic/merge-refusal")

    await app.queue.run({ prs: [pr] }, runtime)

    const eligibility = app.queue.eligibility(pr)
    expect(eligibility.reason?.code).toBe("needs-author")
    expect(eligibility.reason?.receipt).toMatchObject({ code: "wrapper-mismatch" })
  })

  it("keeps an unattributed ordinary check failure off the needs-author path", async () => {
    // A raw red without an exact-base delta cannot say whose failure it is.
    // It remains generic rejected rather than falsely routing work to author.
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
    expect(eligibility.reason?.message).toContain("fix the branch and push")
    expect(eligibility.reason?.message).not.toContain("submit it again")
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

  it("keeps intake open while another candidate runs and while processing is paused", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await using app = await createQueueApp(async () => {
      started.resolve()
      await release.promise
      return { status: "passed", output: { checked: true } }
    })
    const active = await submitWithChecks(app, "topic/active")
    const running = app.queue.run({ prs: [active] }, runtime)
    await started.promise

    const duringRun = await submitWithChecks(app, "topic/during-run", "2".repeat(40))
    expect(app.bays.pr(duringRun)).toMatchObject({ status: "submitted", branch: "topic/during-run" })
    expect(app.bays.checksRequested(duringRun)).toBe(true)

    release.resolve()
    await running

    await app.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: [] })
    const duringPause = await submitWithChecks(app, "topic/during-pause", "3".repeat(40))
    expect(app.bays.pr(duringPause)).toMatchObject({ status: "submitted", branch: "topic/during-pause" })
    expect(app.bays.checksRequested(duringPause)).toBe(true)

    expect(app.queue.eligibility(duringRun).checks.status).toBe("queued")
    expect(app.queue.eligibility(duringPause).checks.status).toBe("queued")
  })
})
