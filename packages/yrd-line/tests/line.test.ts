/**
 * @failure Line composition or projection can accept corrupt runs, lose pinned plans, or misstate integration results.
 * @level l2
 * @consumer @yrd/line
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type IntegratedShape,
  type Line,
  type PRShape,
  type StepExecution,
} from "@yrd/line"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const UPDATED = "3".repeat(40)
const runtime = { executor: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
const ReviewResultSchema = z.object({ approved: z.boolean() }).strict()
const DeployResultSchema = z.object({ environment: z.string() }).strict()

type CheckResult = z.infer<typeof CheckResultSchema>
type ReviewResult = z.infer<typeof ReviewResultSchema>
type DeployResult = z.infer<typeof DeployResultSchema>
type CheckedShape = AddStepResult<PRShape, "check", CheckResult>
type ReviewedShape = AddStepResult<CheckedShape, "review", ReviewResult>
type MergedShape = ReviewedShape & IntegratedShape
type DeployedShape = AddStepResult<MergedShape, "deploy", DeployResult>

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

function linePlugin(
  options: Readonly<{
    batch?: false | number
    check?: (input: StepExecution<PRShape>) => JobResult<CheckResult>
    merge?: (input: StepExecution<ReviewedShape>) => JobResult<{ commit: string; baseSha: string }>
    deploy?: (input: StepExecution<MergedShape>) => JobResult<DeployResult>
    checkRevision?: string
  }> = {},
) {
  const check = withStep(
    "check",
    (input: StepExecution<PRShape>): JobResult<CheckResult> =>
      options.check?.(input) ?? { status: "passed", output: { checked: true } },
    { revision: options.checkRevision ?? "check-v1", output: CheckResultSchema },
  )
  const review = withStep(
    "review",
    (_input: StepExecution<CheckedShape>): JobResult<ReviewResult> => ({
      status: "passed",
      output: { approved: true },
    }),
    { revision: "review-v1", output: ReviewResultSchema },
  )
  const merge = withMerge(
    (input: StepExecution<ReviewedShape>): JobResult<{ commit: string; baseSha: string }> =>
      options.merge?.(input) ?? { status: "passed", output: { commit: MERGED, baseSha: BASE } },
    { revision: "merge-v1" },
  )
  const deploy = withStep(
    "deploy",
    (input: StepExecution<MergedShape>): JobResult<DeployResult> =>
      options.deploy?.(input) ?? { status: "passed", output: { environment: "staging" } },
    { revision: "deploy-v1", needsIntegration: true, output: DeployResultSchema },
  )
  return withLine({
    steps: [check, review, merge, deploy] as const,
    batch: options.batch ?? false,
    defaultSteps: ["check", "review", "merge", "deploy"],
  })
}

async function createLineApp(options: Parameters<typeof linePlugin>[0] = {}, journal = createMemoryJournal()) {
  const bayJobs = createBayJobDefs(workspace())
  const line = linePlugin(options)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, line.jobDefs] }), withBays({ jobs: bayJobs }))
  const definition = line(base)
  return createYrd(definition, {
    inject: { journal, id: ids(), clock: () => "2026-01-01T00:00:00.000Z" },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createLineApp>>, branch: string, base = "main") {
  await app.bays.submit({ branch, headSha: HEAD, base })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

describe("Line", () => {
  it("composes one immutable typed plan and rejects a pre-merge deploy", async () => {
    await using app = await createLineApp()
    expectTypeOf(app.line).toMatchTypeOf<Line<DeployedShape>>()
    expect(app.line.steps().map((step) => step.name)).toEqual(["check", "review", "merge", "deploy"])

    const check = withStep(
      "check",
      (_input: StepExecution<PRShape>) => ({ status: "passed" as const, output: { checked: true } }),
      { revision: "check-v1", output: CheckResultSchema },
    )
    const deploy = withStep(
      "deploy",
      (_input: StepExecution<MergedShape>) => ({ status: "passed" as const, output: { environment: "test" } }),
      { revision: "deploy-v1", needsIntegration: true, output: DeployResultSchema },
    )
    const invalid = (): void => {
      // @ts-expect-error deploy requires the shape produced by withMerge
      void withLine({ steps: [check, deploy] as const })
    }
    void invalid
  })

  it("treats an explicit empty step selection as a true no-op", async () => {
    await using app = await createLineApp()
    const pr = await submitBranch(app, "task/no-steps")

    const result = await app.dispatch(app.commands.line.integrate, { prs: [pr.id], steps: [] })
    expect(result.events).toEqual([])
    await expect(app.line.integrate({ prs: [pr.id], steps: [] }, runtime)).resolves.toEqual([])
    expect(app.state().lines.records).toEqual({})
    expect(app.state().bays.prs[pr.id]?.status).toBe("submitted")
  })

  it("keys a selected step suffix by run order rather than installed order", async () => {
    await using app = await createLineApp()
    const pr = await submitBranch(app, "task/selected-suffix")

    const run = (await app.line.integrate({ prs: [pr.id], steps: ["merge", "deploy"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "passed",
      steps: [{ name: "merge" }, { name: "deploy" }],
      shape: { integration: { commit: MERGED }, results: { deploy: { environment: "staging" } } },
    })
    expect(app.state().lines.records.R1?.steps).toEqual([
      expect.not.objectContaining({ index: expect.anything() }),
      expect.not.objectContaining({ index: expect.anything() }),
    ])
    expect(app.state().jobs.byKey).toMatchObject({ "line:R1:0": expect.any(String), "line:R1:1": expect.any(String) })
  })

  it("rejects a failure event for an unknown Line run as journal corruption", async () => {
    const journal = createMemoryJournal([
      {
        cause: {
          id: "00000000-0000-7000-8000-000000000002",
          commandId: "00000000-0000-7000-8000-000000000001",
          op: "line.advance",
          commandHash: Command.hash({ op: "line.advance" }),
        },
        command: { id: "00000000-0000-7000-8000-000000000001", op: "line.advance" },
        events: [
          {
            id: "00000000-0000-7000-8000-000000000003",
            name: "line/run/failed",
            ts: "2026-07-10T00:00:00.000Z",
            data: { run: "R404", error: { code: "missing-run", message: "missing" } },
          },
        ],
      },
    ])

    await expect(createLineApp({}, journal)).rejects.toThrow("no line run 'R404'")
  })

  it("runs checks, merge, and deploy across base lines and derives every Job field", async () => {
    await using app = await createLineApp({
      batch: 2,
      deploy: (input) => ({ status: "passed", output: { environment: input.prs[0]!.base } }),
    })
    const first = await submitBranch(app, "task/one")
    const second = await submitBranch(app, "task/two")
    const release = await submitBranch(app, "task/release", "release/2.0")

    const runs = await app.line.integrate({ prs: [] }, runtime)

    expect(runs.map((run) => [run.base, run.prs.map((pr) => pr.id)])).toEqual([
      ["main", [first.id, second.id]],
      ["release/2.0", [release.id]],
    ])
    for (const run of runs) {
      expect(run).toMatchObject({
        status: "passed",
        shape: {
          results: {
            check: { checked: true },
            review: { approved: true },
            deploy: { environment: run.base },
          },
          integration: { commit: MERGED, baseSha: BASE },
        },
      })
      expect(run.steps.every((step) => step.job?.status === "passed")).toBe(true)
      expect(
        run.steps.every(
          (step) => step.job?.status === "passed" && step.job.startedAt !== "" && step.job.finishedAt !== "",
        ),
      ).toBe(true)
      const record = app.state().lines.records[run.id]
      expect(record).not.toHaveProperty("status")
      expect(record).not.toHaveProperty("jobIds")
      expect(record).not.toHaveProperty("shape")
    }
    expect(Object.values(app.state().bays.prs).map((pr) => pr.integration)).toEqual([
      { commit: MERGED, baseSha: BASE },
      { commit: MERGED, baseSha: BASE },
      { commit: MERGED, baseSha: BASE },
    ])
    expect(app.line.status("main").finished).toHaveLength(1)
    expect(app.line.status("release/2.0").finished).toHaveLength(1)
  })

  it("keeps completed history readable and refuses queued work after revision drift", async () => {
    const journal = createMemoryJournal()
    const first = await createLineApp({}, journal)
    await first.bays.submit({ branch: "task/completed", headSha: HEAD, base: "main" })
    const completed = await first.line.integrate({ prs: ["PR1"], steps: ["check"] }, runtime)
    await first.bays.submit({ branch: "task/queued", headSha: UPDATED, base: "main" })
    const queued = await first.dispatch(first.commands.line.integrate, { prs: ["PR2"], steps: ["check"] })
    const queuedJob = first.jobs.requested(queued)[0]
    if (queuedJob === undefined) throw new Error("line did not request a Job")
    await first.close()

    let changedExecutions = 0
    const changed = await createLineApp(
      {
        checkRevision: "check-v2",
        check: () => {
          changedExecutions++
          return { status: "passed", output: { checked: false } }
        },
      },
      journal,
    )
    expect(changed.line.get(completed[0]!.id)).toMatchObject({
      status: "passed",
      shape: { results: { check: { checked: true } } },
    })
    await expect(changed.jobs.run(queuedJob, runtime)).rejects.toThrow("definition revision")
    expect(changedExecutions).toBe(0)
    await changed.close()

    const bayJobs = createBayJobDefs(workspace())
    const withoutSteps = withLine({ steps: [] as const })
    const historyBase = pipe(createYrdDef(), withJobs({ definitions: bayJobs }), withBays({ jobs: bayJobs }))
    await using history = await createYrd(withoutSteps(historyBase), { inject: { journal } })
    expect(history.line.get(completed[0]!.id)).toMatchObject({ status: "passed" })
  })

  it("rejects before merge but preserves integration when deployment fails", async () => {
    let merged = false
    await using rejectedApp = await createLineApp({
      check: () => ({ status: "failed", error: { code: "check-failed", message: "tests failed" } }),
      merge: () => {
        merged = true
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const rejected = await submitBranch(rejectedApp, "task/rejected")
    expect((await rejectedApp.line.integrate({ prs: [rejected.id] }, runtime))[0]).toMatchObject({
      status: "failed",
      error: { code: "check-failed" },
    })
    expect(merged).toBe(false)
    expect(rejectedApp.state().bays.prs[rejected.id]).toMatchObject({ status: "rejected" })
    await rejectedApp.bays.submit({ branch: "task/rejected", headSha: UPDATED, base: "main" })
    expect(rejectedApp.state().bays.prs[rejected.id]).toMatchObject({
      status: "submitted",
      revision: 2,
      headSha: UPDATED,
      revisions: [
        { revision: 1, headSha: HEAD },
        { revision: 2, headSha: UPDATED },
      ],
    })

    await using deployApp = await createLineApp({
      batch: 2,
      deploy: () => ({ status: "failed", error: { code: "deploy-failed", message: "staging unavailable" } }),
    })
    const deployed = await submitBranch(deployApp, "task/deploy-fails")
    const companion = await submitBranch(deployApp, "task/deploy-companion")
    const run = (await deployApp.line.integrate({ prs: [deployed.id, companion.id] }, runtime))[0]
    expect(run).toMatchObject({ status: "failed", error: { code: "deploy-failed" } })
    expect(deployApp.state().bays.prs).toMatchObject({
      [deployed.id]: { status: "integrated" },
      [companion.id]: { status: "integrated" },
    })
  })

  it("allows unrelated work while waiting and refuses a completed stale revision", async () => {
    let merges = 0
    await using app = await createLineApp({
      check: (input) =>
        input.prs[0]?.branch === "task/next"
          ? { status: "passed", output: { checked: true } }
          : { status: "waiting", token: `remote-${input.prs[0]?.id}` },
      merge: () => {
        merges++
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const remote = await submitBranch(app, "task/remote")
    const waiting = (await app.line.integrate({ prs: [remote.id] }, runtime))[0]!
    const waitingJob = waiting.steps[0]?.job
    if (waitingJob?.status !== "waiting") throw new Error("check did not wait")
    expect(app.line.waiting(remote.id)).toMatchObject({
      run: { id: waiting.id },
      step: { name: "check", job: { id: waitingJob.id, status: "waiting" } },
    })

    const next = await submitBranch(app, "task/next")
    expect((await app.line.integrate({ prs: [next.id] }, runtime))[0]).toMatchObject({ status: "passed" })

    await app.bays.intake({ branch: remote.branch, headSha: UPDATED, base: "main" })
    expect(
      await app.line.finish(
        remote.id,
        {
          step: "check",
          token: waitingJob.token,
          result: { status: "passed", output: { checked: true } },
        },
        runtime,
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "stale-pr" },
    })
    await expect(
      app.line.finish(
        remote.id,
        {
          step: "check",
          token: waitingJob.token,
          result: { status: "passed", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow("no waiting 'check' step")
    expect(merges).toBe(1)
    expect(app.state().bays.prs[remote.id]).toMatchObject({ revision: 2, headSha: UPDATED, status: "pushed" })
  })

  it("recursively bisects a red batch and rejects only the isolated PR", async () => {
    const checked: string[][] = []
    await using app = await createLineApp({
      batch: 4,
      check: (input) => {
        const prs = input.prs.map((pr) => pr.id)
        checked.push(prs)
        return prs.includes("PR3")
          ? { status: "failed", error: { code: "check-failed", message: "bad PR" } }
          : { status: "passed", output: { checked: true } }
      },
    })
    await submitBranch(app, "task/one")
    await submitBranch(app, "task/two")
    await submitBranch(app, "task/bad")
    await submitBranch(app, "task/four")

    const runs = await app.line.integrate({ prs: [] }, runtime)

    expect(checked).toEqual([["PR1", "PR2", "PR3", "PR4"], ["PR1", "PR2"], ["PR3", "PR4"], ["PR3"], ["PR4"]])
    expect(runs.map((run) => [run.prs.map((pr) => pr.id), run.status])).toEqual([
      [["PR1", "PR2", "PR3", "PR4"], "failed"],
      [["PR1", "PR2"], "passed"],
      [["PR3", "PR4"], "failed"],
      [["PR3"], "failed"],
      [["PR4"], "passed"],
    ])
    expect(Object.fromEntries(Object.values(app.state().bays.prs).map((pr) => [pr.id, pr.status]))).toEqual({
      PR1: "integrated",
      PR2: "integrated",
      PR3: "rejected",
      PR4: "integrated",
    })
  })
})
