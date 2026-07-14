/**
 * @failure Queue composition or projection can accept corrupt runs, lose pinned plans, or misstate integration results.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type IntegratedShape,
  type Queue,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const UPDATED = "3".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
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

function ids(initial = 0): () => string {
  let value = initial
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

function queuePlugin(
  options: Readonly<{
    batch?: false | number
    check?: (input: StepExecution<PRShape>) => JobResult<CheckResult> | Promise<JobResult<CheckResult>>
    merge?: (input: StepExecution<ReviewedShape>) => JobResult<{ commit: string; baseSha: string }>
    deploy?: (input: StepExecution<MergedShape>) => JobResult<DeployResult>
    checkRevision?: string
    checkClassification?: "base" | "carrier"
    requires?: readonly ["review"]
    resolveBaseSha?: (base: string) => string | Promise<string>
  }> = {},
) {
  const check = withStep(
    "check",
    (input: StepExecution<PRShape>): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      options.check?.(input) ?? { status: "passed", output: { checked: true } },
    {
      revision: options.checkRevision ?? "check-v1",
      output: CheckResultSchema,
      ...(options.checkClassification === undefined ? {} : { classification: options.checkClassification }),
    },
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
  return withQueue({
    steps: [check, review, merge, deploy] as const,
    batch: options.batch ?? false,
    defaultSteps: ["check", "review", "merge", "deploy"],
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.resolveBaseSha === undefined ? {} : { resolveBaseSha: options.resolveBaseSha }),
  })
}

async function createQueueApp(
  options: Parameters<typeof queuePlugin>[0] = {},
  journal = createMemoryJournal(),
  clock: () => string = () => "2026-01-01T00:00:00.000Z",
  id: () => string = ids(),
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = queuePlugin(options)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  const definition = queue(base)
  return createYrd(definition, {
    inject: { journal, id, clock },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createQueueApp>>, branch: string, base = "main") {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base, baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

describe("Queue", () => {
  it("composes one immutable typed plan and rejects a pre-merge deploy", async () => {
    await using app = await createQueueApp()
    expectTypeOf(app.queue).toMatchTypeOf<Queue<DeployedShape>>()
    expectTypeOf(app.queue.recover).parameter(0).toEqualTypeOf<Readonly<{ recoveryTime: string; reason?: string }>>()
    expect(app.queue.steps().map((step) => step.name)).toEqual(["check", "review", "merge", "deploy"])

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
      void withQueue({ steps: [check, deploy] as const })
    }
    void invalid
  })

  it("treats an explicit empty step selection as a true no-op", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/no-steps")

    const result = await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: [] })
    expect(result.events).toEqual([])
    await expect(app.queue.run({ prs: [pr.id], steps: [] }, runtime)).resolves.toEqual([])
    expect(app.state().queues.records).toEqual({})
    expect(app.state().bays.prs[pr.id]?.status).toBe("submitted")
  })

  it("keeps recovery execution-free for requested merge work", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      merge: () => {
        mergeCalls += 1
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/requested-merge")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["merge"] })
    const before = await Array.fromAsync(app.events())

    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([])

    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("requested")
    expect(app.state().bays.prs[pr.id]?.status).toBe("submitted")
    expect(mergeCalls).toBe(0)
  })

  it.each(["requested", "passed"] as const)(
    "resumes a replayed %s Job only when queue.run grants execution authority",
    async (crashPoint) => {
      const journal = createMemoryJournal()
      const id = ids()
      let checkCalls = 0
      let mergeCalls = 0
      const options = {
        check: () => {
          checkCalls += 1
          return { status: "passed" as const, output: { checked: true } }
        },
        merge: () => {
          mergeCalls += 1
          return { status: "passed" as const, output: { commit: MERGED, baseSha: BASE } }
        },
      }

      {
        await using app = await createQueueApp(options, journal, undefined, id)
        const pr = await submitBranch(app, `issue/${crashPoint}-resume`)
        await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["check", "merge"] })
        const job = app.queue.get("R1")?.steps[0]?.job
        if (job === undefined) throw new Error(`expected ${crashPoint} crash-window Job`)
        if (crashPoint === "passed") await app.jobs.run(job.id, runtime)
      }

      await using replayed = await createQueueApp(options, journal, undefined, id)
      await expect(replayed.queue.run({ prs: ["PR1"], steps: ["check", "merge"] }, runtime)).resolves.toEqual([
        expect.objectContaining({ id: "R1", status: "passed" }),
      ])
      expect(replayed.state().bays.prs.PR1?.status).toBe("integrated")
      expect(checkCalls).toBe(1)
      expect(mergeCalls).toBe(1)
    },
  )

  it("settles a stale revision and admits its resubmission in one explicit run", async () => {
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
    })
    const pr = await submitBranch(app, "issue/one-call-resubmit")
    const first = (await app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime))[0]
    expect(first).toMatchObject({ id: "R1", status: "waiting" })

    await app.bays.intake({ branch: pr.branch, headSha: UPDATED, base: "main" })
    await app.bays.submit({ pr: pr.id })
    expect(app.state().bays.prs[pr.id]).toMatchObject({ revision: 2, status: "submitted", headSha: UPDATED })

    await expect(app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime)).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "failed",
        error: expect.objectContaining({ code: "stale-pr" }),
      }),
      expect.objectContaining({ id: "R2", status: "waiting" }),
    ])
    expect(Object.keys(app.state().queues.records)).toEqual(["R1", "R2"])
    expect(app.state().bays.prs[pr.id]).toMatchObject({ revision: 2, status: "submitted", headSha: UPDATED })
  })

  it.each(["merge-passed", "post-merge-requested"] as const)(
    "settles a replayed %s fact once without admitting a duplicate run",
    async (crashPoint) => {
      const journal = createMemoryJournal()
      const id = ids()
      let mergeCalls = 0
      let deployCalls = 0
      const options = {
        merge: () => {
          mergeCalls += 1
          return { status: "passed" as const, output: { commit: MERGED, baseSha: BASE } }
        },
        deploy: () => {
          deployCalls += 1
          return { status: "passed" as const, output: { environment: "staging" } }
        },
      }

      {
        await using app = await createQueueApp(options, journal, undefined, id)
        const pr = await submitBranch(app, `issue/${crashPoint}`)
        await app.dispatch(app.commands.queue.run, {
          prs: [pr.id],
          steps: crashPoint === "merge-passed" ? ["merge"] : ["merge", "deploy"],
        })
        const mergeJob = app.queue.get("R1")?.steps[0]?.job
        if (mergeJob === undefined) throw new Error("expected requested merge")
        await app.jobs.run(mergeJob.id, runtime)
        if (crashPoint === "post-merge-requested") {
          await app.dispatch(app.commands.queue.advance, { run: "R1" })
          expect(app.state().bays.prs[pr.id]?.status).toBe("integrated")
          expect(app.queue.get("R1")?.steps[1]?.job?.status).toBe("requested")
          await app.queue.pause({ base: "main", reason: "maintenance", allowedPRs: [] })
        }
      }

      await using replayed = await createQueueApp(options, journal, undefined, id)
      await expect(replayed.queue.run({}, runtime)).resolves.toEqual([
        expect.objectContaining({ id: "R1", status: "passed" }),
      ])
      await expect(replayed.queue.run({}, runtime)).resolves.toEqual([])
      expect(Object.keys(replayed.state().queues.records)).toEqual(["R1"])
      expect(replayed.state().bays.prs.PR1?.status).toBe("integrated")
      expect(mergeCalls).toBe(1)
      expect(deployCalls).toBe(crashPoint === "post-merge-requested" ? 1 : 0)
    },
  )

  it("returns a replayed running Job without stealing it or admitting same-base intake", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "passed" as const, output: { checked: true } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const active = await submitBranch(app, "issue/active")
      await submitBranch(app, "issue/queued")
      await app.dispatch(app.commands.queue.run, { prs: [active.id], steps: ["check"] })
      const job = app.queue.get("R1")?.steps[0]?.job
      if (job === undefined) throw new Error("expected requested active Job")
      await app.dispatch(app.commands.job.transition, {
        type: "start",
        id: job.id,
        attempt: 1,
        runner: "active-runner",
        leaseExpiresAt: "2026-01-01T00:05:00.000Z",
      })
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({}, runtime)).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "running" }),
    ])
    expect(Object.keys(replayed.state().queues.records)).toEqual(["R1"])
    expect(replayed.state().bays.prs.PR2?.status).toBe("submitted")
    expect(checkCalls).toBe(0)
  })

  it("recovers an expired batch without executing, bisecting, or landing", async () => {
    let checkCalls = 0
    let mergeCalls = 0
    await using app = await createQueueApp({
      batch: 2,
      check: () => {
        checkCalls += 1
        return { status: "passed", output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const first = await submitBranch(app, "issue/batch-one")
    const second = await submitBranch(app, "issue/batch-two")
    await app.dispatch(app.commands.queue.run, { prs: [first.id, second.id], steps: ["check", "merge"] })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("expected requested batch check")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "expired-runner",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })

    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z", reason: "runner disappeared" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "failed",
        steps: [expect.objectContaining({ job: expect.objectContaining({ status: "lost" }) }), expect.anything()],
      }),
    ])
    expect(Object.keys(app.state().queues.records)).toEqual(["R1"])
    expect(app.state().bays.prs[first.id]?.status).toBe("submitted")
    expect(app.state().bays.prs[second.id]?.status).toBe("submitted")
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)

    const settled = await Array.fromAsync(app.events())
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(app.events())).toEqual(settled)
  })

  it("releases a replayed lost job before an explicit same-revision retry", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "passed" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return { status: "passed" as const, output: { commit: MERGED, baseSha: BASE } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/crash-gap")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["check", "merge"] })
      const job = app.queue.get("R1")?.steps[0]?.job
      if (job === undefined) throw new Error("expected requested crash-gap check")
      await app.dispatch(app.commands.job.transition, {
        type: "start",
        id: job.id,
        attempt: 1,
        runner: "expired-runner",
        leaseExpiresAt: "2026-01-01T00:00:01.000Z",
      })
      await expect(app.jobs.recover({ now: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([job.id])
      expect(app.state().bays.prs[pr.id]?.status).toBe("submitted")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "failed" }),
    ])
    expect(replayed.state().bays.prs.PR1?.status).toBe("submitted")
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    const appended = (await Array.fromAsync(replayed.events())).slice(before.length)
    expect(appended).toMatchObject([{ name: "queue/run/failed", data: { run: "R1", error: { code: "job-lost" } } }])
    const failed = appended[0]
    if (failed === undefined) throw new Error("expected job loss to append queue/run/failed")
    const authority = replayed.state().queues.authority.runs.R1
    expect(authority?.released).toEqual({ reason: "job-lost", ref: failed.id })
    expect(appended.map(({ name }) => name)).not.toContain("pr/rejected")

    const reconciled = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:03:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(replayed.events())).toEqual(reconciled)

    const retried = await replayed.queue.run({ prs: ["PR1"], steps: ["check", "merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([{ id: "R2", status: "passed", prs: [{ id: "PR1", revision: 1, headSha: HEAD }] }])
    expect(replayed.state().bays.prs.PR1).toMatchObject({
      status: "integrated",
      revision: 1,
      headSha: HEAD,
    })
    expect(Object.keys(replayed.state().queues.records)).toEqual(["R1", "R2"])
    expect(checkCalls).toBe(1)
    expect(mergeCalls).toBe(1)
  })

  it("cancels a correlated PR when its active Queue Job is canceled", async () => {
    const correlation = { namespace: "tribe-request", id: "request-20925" } as const
    const journal = createMemoryJournal()
    const id = ids()
    await using app = await createQueueApp({}, journal, undefined, id)
    await app.bays.submit({
      branch: "issue/canceled",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
      correlation,
    })
    const pr = app.state().bays.prs.PR1
    if (pr === undefined) throw new Error("correlated PR was not recorded")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["check"] })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("Queue did not request a Job")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "worker-1",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    })
    await app.jobs.cancel({ id: job.id, attempt: 1, by: "@chief", reason: "authorization revoked" })

    const advanced = await app.dispatch(app.commands.queue.advance, { run: "R1" })

    expect(advanced.events.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "pr/canceled",
        data: {
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          correlation,
          by: "@chief",
          reason: "authorization revoked",
        },
      },
    ])
    expect(app.state().bays.prs[pr.id]).toMatchObject({
      status: "canceled",
      revision: pr.revision,
      headSha: pr.headSha,
      correlation,
      revisions: [
        {
          revision: pr.revision,
          headSha: pr.headSha,
          terminal: { status: "canceled", at: "2026-01-01T00:00:00.000Z" },
        },
      ],
    })
    expect(app.queue.get("R1")).toMatchObject({
      status: "failed",
      error: { code: "run-canceled" },
      prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha, correlation }],
      steps: [
        expect.objectContaining({
          job: expect.objectContaining({
            status: "canceled",
            canceledBy: "@chief",
            cancelReason: "authorization revoked",
          }),
        }),
      ],
    })
    const eventNames = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(eventNames).not.toContain("pr/rejected")
    expect(app.queue.get("R1")?.error?.code).not.toBe("job-lost")

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "failed",
      prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha, correlation }],
    })
    expect(replayed.state().bays.prs[pr.id]).toMatchObject({
      status: "canceled",
      revisions: [{ terminal: { status: "canceled", at: "2026-01-01T00:00:00.000Z" } }],
    })
  })

  it("keys a selected step suffix by run order rather than installed order", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/selected-suffix")

    const run = (await app.queue.run({ prs: [pr.id], steps: ["merge", "deploy"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "passed",
      steps: [{ name: "merge" }, { name: "deploy" }],
      shape: { integration: { commit: MERGED }, results: { deploy: { environment: "staging" } } },
    })
    expect(app.state().queues.records.R1?.steps).toEqual([
      expect.not.objectContaining({ index: expect.anything() }),
      expect.not.objectContaining({ index: expect.anything() }),
    ])
    expect(app.state().jobs.byKey).toMatchObject({ "queue:R1:0": expect.any(String), "queue:R1:1": expect.any(String) })
  })

  it("rejects a failure event for an unknown Queue run as journal corruption", async () => {
    const journal = createMemoryJournal([
      {
        cause: {
          id: "00000000-0000-7000-8000-000000000002",
          commandId: "00000000-0000-7000-8000-000000000001",
          op: "queue.advance",
          commandHash: Command.hash({ op: "queue.advance" }),
        },
        command: { id: "00000000-0000-7000-8000-000000000001", op: "queue.advance" },
        events: [
          {
            id: "00000000-0000-7000-8000-000000000003",
            name: "queue/run/failed",
            ts: "2026-07-10T00:00:00.000Z",
            data: { run: "R404", error: { code: "missing-run", message: "missing" } },
          },
        ],
      },
    ])

    await expect(createQueueApp({}, journal)).rejects.toThrow("no queue run 'R404'")
  })

  it("runs checks, merge, and deploy across base queues and derives every Job field", async () => {
    await using app = await createQueueApp({
      batch: 2,
      deploy: (input) => ({ status: "passed", output: { environment: input.prs[0]!.base } }),
    })
    const first = await submitBranch(app, "issue/one")
    const second = await submitBranch(app, "issue/two")
    const release = await submitBranch(app, "issue/release", "release/2.0")

    const runs = await app.queue.run({ prs: [] }, runtime)

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
      const record = app.state().queues.records[run.id]
      expect(record).not.toHaveProperty("status")
      expect(record).not.toHaveProperty("jobIds")
      expect(record).not.toHaveProperty("shape")
    }
    expect(Object.values(app.state().bays.prs).map((pr) => pr.integration)).toEqual([
      { commit: MERGED, baseSha: BASE },
      { commit: MERGED, baseSha: BASE },
      { commit: MERGED, baseSha: BASE },
    ])
    expect(app.queue.status("main").finished).toHaveLength(1)
    expect(app.queue.status("release/2.0").finished).toHaveLength(1)
  })

  it("reconciles historical same-payload PRs from one integration proof", async () => {
    const journal = createMemoryJournal<unknown>()
    await using app = await createQueueApp({}, journal)
    const canonical = await submitBranch(app, "issue/one")
    const run = (await app.queue.run({ prs: [canonical.id], steps: ["check", "review", "merge"] }, runtime))[0]
    let cursor = 0
    for await (const batch of journal.read()) cursor = batch.cursor
    const command = { id: "00000000-0000-7000-8000-000000000101", op: "fixture.duplicate" }
    expect(
      await journal.append(
        {
          command,
          cause: {
            id: "00000000-0000-7000-8000-000000000102",
            commandId: command.id,
            op: command.op,
            commandHash: Command.hash(command),
          },
          events: [
            {
              id: "00000000-0000-7000-8000-000000000103",
              name: "pr/pushed",
              ts: "2026-01-01T00:00:01.000Z",
              data: {
                pr: "PR2",
                branch: "origin/issue/one",
                base: "main",
                headSha: canonical.headSha,
                revision: 1,
              },
            },
            {
              id: "00000000-0000-7000-8000-000000000104",
              name: "pr/submitted",
              ts: "2026-01-01T00:00:01.001Z",
              data: { pr: "PR2", revision: 1, headSha: canonical.headSha },
            },
          ],
        },
        cursor,
      ),
    ).toMatchObject({ appended: true })

    const reconciled = await app.dispatch(app.commands.queue.advance, { run: run?.id ?? "missing" })

    expect(run).toMatchObject({ status: "passed", integration: { commit: MERGED } })
    expect(reconciled.events).toEqual([
      expect.objectContaining({ name: "pr/integrated", data: expect.objectContaining({ pr: "PR2" }) }),
    ])
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "integrated", integration: run?.integration })
    expect(app.state().bays.prs.PR2).toMatchObject({ status: "integrated", integration: run?.integration })
  })

  it("does not integrate canceled historical PRs that share the current payload", async () => {
    const journal = createMemoryJournal<unknown>()
    const original = await createQueueApp({}, journal)
    const current = await submitBranch(original, "issue/current-payload")
    await original.close()

    let cursor = 0
    for await (const batch of journal.read()) cursor = batch.cursor
    const command = { id: "00000000-0000-7000-8000-000000000111", op: "fixture.canceled-duplicate" }
    expect(
      await journal.append(
        {
          command,
          cause: {
            id: "00000000-0000-7000-8000-000000000112",
            commandId: command.id,
            op: command.op,
            commandHash: Command.hash(command),
          },
          events: [
            {
              id: "00000000-0000-7000-8000-000000000113",
              name: "pr/pushed",
              ts: "2026-01-01T00:00:01.000Z",
              data: {
                pr: "PR2",
                branch: "issue/canceled-history",
                base: "main",
                baseSha: BASE,
                headSha: current.headSha,
                revision: 1,
              },
            },
            {
              id: "00000000-0000-7000-8000-000000000114",
              name: "pr/submitted",
              ts: "2026-01-01T00:00:01.001Z",
              data: { pr: "PR2", revision: 1, headSha: current.headSha },
            },
            {
              id: "00000000-0000-7000-8000-000000000115",
              name: "pr/canceled",
              ts: "2026-01-01T00:00:01.002Z",
              data: {
                pr: "PR2",
                revision: 1,
                headSha: current.headSha,
                by: "@chief",
                reason: "superseded",
              },
            },
          ],
        },
        cursor,
      ),
    ).toMatchObject({ appended: true })

    await using app = await createQueueApp({}, journal, undefined, ids(500))
    const before = (await Array.fromAsync(app.events())).length
    await app.queue.run({ prs: [current.id], steps: ["check", "review", "merge"] }, runtime)
    const integrated = (await Array.fromAsync(app.events()))
      .slice(before)
      .filter((applied) => applied.name === "pr/integrated")
      .map((applied) => (applied.data as { pr: string }).pr)

    expect(integrated).toEqual([current.id])
    expect(app.state().bays.prs.PR2).toMatchObject({ status: "canceled", canceledBy: "@chief" })
  })

  it("integrates the implicit queue in PR revision submission order", async () => {
    let tick = 0
    await using app = await createQueueApp({ batch: 1 }, createMemoryJournal(), () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    )
    await app.bays.intake({ branch: "issue/created-first", headSha: HEAD, base: "main" })
    await app.bays.intake({ branch: "issue/submitted-first", headSha: UPDATED, base: "main" })
    await app.bays.submit({ pr: "PR2" })
    await app.bays.submit({ pr: "PR1" })

    const runs = await app.queue.run({}, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR2"], ["PR1"]])
  })

  it("uses one typed eligibility projection for draft, review, and revision freshness", async () => {
    await using app = await createQueueApp({ requires: ["review"] })
    await app.bays.submit({ branch: "issue/review-me", headSha: HEAD, base: "main", baseSha: BASE, draft: true })

    expect(app.queue.eligibility("PR1")).toMatchObject({
      pr: "PR1",
      runnable: false,
      reason: { code: "draft", message: "PR 'PR1' is pushed, not ready" },
      review: { required: true, approved: false },
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.comment({ pr: "PR1", actor: "@cto", ref: "question-1", note: "Why this shape?" })
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "review-required", message: "PR 'PR1' needs approval for revision 1" },
      review: { required: true, approved: false },
    })
    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "reject", ref: "verdict-red" })
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "review-rejected", message: "PR 'PR1' was rejected by @cto for revision 1" },
      review: { required: true, approved: false, decision: "reject", actor: "@cto", ref: "verdict-red" },
    })
    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "approve", ref: "verdict-1" })
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: true,
      review: { required: true, approved: true, decision: "approve", actor: "@cto", ref: "verdict-1" },
    })

    await app.bays.ready({ pr: "PR1" })
    expect(app.queue.eligibility("PR1")).toMatchObject({ runnable: true })
    expect(app.queue.eligibility("PR1").reason).toBeUndefined()
    await expect(app.queue.run({ prs: ["PR1"] }, runtime)).resolves.toHaveLength(1)

    await app.bays.submit({
      branch: "issue/review-stales",
      headSha: UPDATED,
      base: "main",
      baseSha: BASE,
      draft: true,
    })
    await app.bays.review({ pr: "PR2", actor: "@cto", decision: "approve", ref: "verdict-2" })
    await app.bays.ready({ pr: "PR2" })
    await app.bays.intake({ branch: "issue/review-stales", headSha: "4".repeat(40), base: "main", baseSha: BASE })
    await app.bays.ready({ pr: "PR2" })
    expect(app.queue.eligibility("PR2")).toMatchObject({
      runnable: false,
      reason: { code: "review-required" },
      review: { required: true, approved: false, stale: true },
    })
    await expect(app.queue.run({ prs: ["PR2"] }, runtime)).rejects.toThrow("PR 'PR2' needs approval for revision 2")

    await app.bays.submit({
      branch: "issue/rejection-stales",
      headSha: "5".repeat(40),
      base: "main",
      baseSha: BASE,
      draft: true,
    })
    await app.bays.review({ pr: "PR3", actor: "@cto", decision: "reject", ref: "verdict-3" })
    await app.bays.ready({ pr: "PR3" })
    expect(app.queue.eligibility("PR3")).toMatchObject({
      runnable: false,
      reason: { code: "review-rejected" },
      review: { required: true, approved: false, decision: "reject", stale: false },
    })
    await app.bays.intake({
      branch: "issue/rejection-stales",
      headSha: "6".repeat(40),
      base: "main",
      baseSha: BASE,
    })
    await app.bays.ready({ pr: "PR3" })
    expect(app.queue.eligibility("PR3")).toMatchObject({
      runnable: false,
      reason: { code: "review-required" },
      review: { required: true, approved: false, stale: true },
    })

    expect(app.state().queues.records).toHaveProperty("R1")
    expect(Object.keys(app.state().queues.records)).toHaveLength(1)
  })

  it("admits configured checks through Queue once and reuses their journaled result for integration", async () => {
    let checks = 0
    await using app = await createQueueApp({
      check: () => {
        checks++
        return { status: "passed", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/admitted")
    await app.bays.requestChecks({ pr: pr.id })

    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "checks-pending" },
      checks: { status: "queued", position: 1, queuedAt: expect.any(String) },
    })
    const admission = (await app.queue.admit({ prs: [pr.id] }))[0]
    expect(admission).toMatchObject({
      id: "R1",
      status: "running",
      prs: [{ id: pr.id, headSha: pr.headSha }],
      steps: [{ name: "check" }, { name: "review" }],
    })
    expect(checks).toBe(0)
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "checking" },
      checks: { status: "checking", run: "R1" },
    })

    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([{ status: "passed" }])
    expect(checks).toBe(1)
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: true,
      checks: { status: "passed", run: "R1" },
    })

    const integrated = (await app.queue.run({ prs: [pr.id] }, runtime))[0]
    expect(integrated).toMatchObject({
      id: "R2",
      status: "passed",
      steps: [{ name: "merge" }, { name: "deploy" }],
      shape: {
        results: { check: { checked: true }, review: { approved: true }, deploy: { environment: "staging" } },
        integration: { commit: MERGED, baseSha: BASE },
      },
    })
    expect(checks).toBe(1)
  })

  it("owns the admission drain inside Queue before integrating the same cached proof", async () => {
    let checks = 0
    await using app = await createQueueApp({
      check: () => {
        checks++
        return { status: "passed", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/queue-owned-drain")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.queue.admit({ prs: [pr.id] })).toHaveLength(1)
    expect(checks).toBe(0)

    const integrated = await app.queue.run({ prs: [pr.id] }, runtime)

    expect(integrated).toMatchObject([{ id: "R2", status: "passed", reusedFrom: "R1" }])
    expect(checks).toBe(1)
  })

  it("does not let an unrelated waiting admission monopolize Queue capacity", async () => {
    await using app = await createQueueApp({
      check: (input) =>
        input.prs[0]?.id === "PR1"
          ? { status: "waiting", token: "remote-one" }
          : { status: "passed", output: { checked: true } },
    })
    const waiting = await submitBranch(app, "issue/waiting-check")
    const healthy = await submitBranch(app, "issue/healthy-check")
    await app.bays.requestChecks({ pr: waiting.id })
    await app.bays.requestChecks({ pr: healthy.id })

    expect(await app.queue.admit({ prs: [waiting.id] }, runtime)).toMatchObject([
      { status: "waiting", prs: [{ id: waiting.id }] },
    ])
    expect(await app.queue.admit({ prs: [healthy.id] }, runtime)).toMatchObject([
      { status: "passed", prs: [{ id: healthy.id }] },
    ])
    expect(app.queue.eligibility(waiting.id)).toMatchObject({ checks: { status: "checking" } })
    expect(app.queue.eligibility(healthy.id)).toMatchObject({ checks: { status: "passed" } })
  })

  it("keys admission reuse by the freshly resolved base SHA", async () => {
    let baseSha = BASE
    let checks = 0
    const checkedBases: Array<string | undefined> = []
    await using app = await createQueueApp({
      resolveBaseSha: () => baseSha,
      check: (input) => {
        checks++
        checkedBases.push(input.prs[0]?.baseSha)
        return { status: "passed", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/base-keyed-cache")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([{ status: "passed" }])
    expect(checks).toBe(1)

    baseSha = UPDATED
    const integrated = await app.queue.run({ prs: [pr.id] }, runtime)

    expect(integrated).toMatchObject([{ status: "passed", reusedFrom: "R2" }])
    expect(checks).toBe(2)
    expect(checkedBases).toEqual([BASE, UPDATED])
    expect(app.queue.get("R2")?.prs).toMatchObject([{ baseSha: UPDATED }])
  })

  it("refuses integration when a clear main-health admission turns green then same-base red", async () => {
    let mainHealth: "clear" | "green" | "red" = "clear"
    let checks = 0
    let merges = 0
    await using app = await createQueueApp({
      checkClassification: "base",
      check: () => {
        checks++
        if (mainHealth === "red") {
          return { status: "failed", error: { code: "base-red", message: "same-base main-health lock is red" } }
        }
        mainHealth = "green"
        return { status: "passed", output: { checked: true } }
      },
      merge: () => {
        merges++
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/main-health-turns-red")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })

    expect(mainHealth).toBe("clear")
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([
      { id: "R1", status: "passed", prs: [{ baseSha: BASE }] },
    ])
    expect(mainHealth).toBe("green")
    expect(checks).toBe(1)

    mainHealth = "red"
    const refused = await app.queue.run({ prs: [pr.id] }, runtime)

    expect(refused).toMatchObject([
      {
        id: "R2",
        status: "failed",
        prs: [{ baseSha: BASE }],
      },
    ])
    expect(refused[0]?.steps[0]).toMatchObject({
      name: "check",
      classification: "base",
      job: { status: "failed", error: { code: "base-red" } },
    })
    expect(refused[0]).not.toHaveProperty("reusedFrom")
    expect(checks).toBe(2)
    expect(merges).toBe(0)
    expect(app.state().bays.prs[pr.id]).toMatchObject({ status: "rejected" })
    expect(app.state().bays.prs[pr.id]?.integration).toBeUndefined()
    expect(app.queue.eligibility(pr.id)).toMatchObject({ checks: { status: "failed", run: "R2" } })
    expect(app.queue.checks([pr.id])).toMatchObject([
      {
        pr: pr.id,
        revision: 1,
        run: "R2",
        step: "check",
        status: "failed",
        classification: "base",
        error: { code: "base-red" },
      },
    ])
  })

  it("projects a pinned-run failure as a failed check fact before its Job starts", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/stale-before-job")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.queue.admit({ prs: [pr.id] })).toHaveLength(1)
    await app.bays.closePr({ pr: pr.id })

    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([
      { status: "failed", error: { code: "stale-pr" } },
    ])
    expect(app.queue.checks([pr.id])).toMatchObject([
      { pr: pr.id, revision: 1, run: "R1", step: "check", status: "failed", error: { code: "stale-pr" } },
    ])
  })

  it("keeps admission globally FIFO even when a later PR is selected explicitly", async () => {
    const checked: string[] = []
    await using app = await createQueueApp({
      check: (input) => {
        checked.push(input.prs[0]!.id)
        return { status: "passed", output: { checked: true } }
      },
    })
    const first = await submitBranch(app, "issue/first-check")
    const second = await submitBranch(app, "issue/second-check")
    await app.bays.requestChecks({ pr: first.id })
    await app.bays.requestChecks({ pr: second.id })

    expect(app.queue.eligibility(second.id)).toMatchObject({ checks: { status: "queued", position: 2 } })
    expect(await app.queue.admit({ prs: [second.id] })).toEqual([])
    expect(await app.queue.admit({}, runtime)).toMatchObject([
      { status: "passed", prs: [{ id: first.id }] },
      { status: "passed", prs: [{ id: second.id }] },
    ])
    expect(checked).toEqual([first.id, second.id])
  })

  it("orders admission age and position from the check request fact, not the earlier push", async () => {
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp({}, createMemoryJournal(), () => now)
    const pushedFirst = await submitBranch(app, "issue/pushed-first")
    now = "2026-01-01T00:01:00.000Z"
    const requestedFirst = await submitBranch(app, "issue/requested-first")
    now = "2026-01-01T00:02:00.000Z"
    await app.bays.requestChecks({ pr: requestedFirst.id })
    now = "2026-01-01T00:03:00.000Z"
    await app.bays.requestChecks({ pr: pushedFirst.id })

    expect(app.queue.eligibility(requestedFirst.id)).toMatchObject({
      checks: { status: "queued", position: 1, queuedAt: "2026-01-01T00:02:00.000Z" },
    })
    expect(app.queue.eligibility(pushedFirst.id)).toMatchObject({
      checks: { status: "queued", position: 2, queuedAt: "2026-01-01T00:03:00.000Z" },
    })
    const admitted = (await app.queue.admit({}))[0]
    expect(admitted?.prs).toMatchObject([{ id: requestedFirst.id }])
  })

  it("naturally misses the journal cache when the installed-step identity changes", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    const pr = await submitBranch(first, "issue/cache-identity")
    await first.bays.requestChecks({ pr: pr.id })
    const admitted = (await first.queue.admit({ prs: [pr.id] }))[0]
    if (admitted === undefined) throw new Error("expected an admission run")
    await first.queue.admit({ prs: [pr.id] }, runtime)
    await first.close()

    let changedChecks = 0
    await using changed = await createQueueApp(
      {
        checkRevision: "check-v2",
        check: () => {
          changedChecks++
          return { status: "passed", output: { checked: true } }
        },
      },
      journal,
      () => "2026-01-01T00:00:00.000Z",
      ids(100),
    )
    const readmission = (await changed.queue.admit({ prs: [pr.id] }))[0]
    if (readmission === undefined) throw new Error("expected a cache-miss admission run")
    expect(readmission).toMatchObject({
      status: "running",
      steps: [{ name: "check", revision: "check-v2" }, { name: "review" }],
    })
    await changed.queue.admit({ prs: [pr.id] }, runtime)

    const integrated = (await changed.queue.run({ prs: [pr.id] }, runtime))[0]
    expect(integrated).toMatchObject({
      status: "passed",
      reusedFrom: readmission.id,
      steps: [{ name: "merge" }, { name: "deploy" }],
    })
    expect(changedChecks).toBe(1)
  })

  it("releases an environment-refused run and re-admits its unchanged revision after replay", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let mergeCalls = 0
    const options = {
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? {
              status: "failed" as const,
              error: {
                code: "queue-environment-refused",
                message: "merge environment is temporarily unavailable",
              },
            }
          : { status: "passed" as const, output: { commit: MERGED, baseSha: BASE } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/environment-refused")

      expect(await app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).toMatchObject([
        {
          id: "R1",
          status: "failed",
          error: { code: "queue-environment-refused" },
          prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha }],
        },
      ])
      expect(app.state().bays.prs[pr.id]).toMatchObject({
        status: "submitted",
        revision: pr.revision,
        headSha: pr.headSha,
      })

      const events = await Array.fromAsync(app.events())
      const failed = events.find(
        (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
      )
      if (failed === undefined) throw new Error("expected the environment refusal to append queue/run/failed")
      const authority = app.state().queues.authority.runs.R1
      expect(authority?.released).toEqual({ reason: "queue-environment-refused", ref: failed.id })
      expect(events.map(({ name }) => name)).not.toContain("pr/rejected")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const replayedEvents = await Array.fromAsync(replayed.events())
    const replayedFailure = replayedEvents.find(
      (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
    )
    if (replayedFailure === undefined) throw new Error("expected replay to retain queue/run/failed")
    const replayedAuthority = replayed.state().queues.authority.runs.R1
    expect(replayedAuthority?.released).toEqual({
      reason: "queue-environment-refused",
      ref: replayedFailure.id,
    })

    const retried = await replayed.queue.run({ prs: ["PR1"], steps: ["merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      {
        id: "R2",
        status: "passed",
        prs: [{ id: "PR1", revision: 1, headSha: HEAD }],
      },
    ])
    expect(replayed.state().bays.prs.PR1).toMatchObject({
      status: "integrated",
      revision: 1,
      headSha: HEAD,
    })
    expect(Object.keys(replayed.state().queues.records)).toEqual(["R1", "R2"])
    expect(mergeCalls).toBe(2)
  })

  it("keeps merit rejection consumed until a new revision supplies submit authority", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? { status: "failed", error: { code: "merge-conflict", message: "payload does not merge" } }
          : { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/merit-rejection")

    expect(await app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).toMatchObject([
      { id: "R1", status: "failed", error: { code: "merge-conflict" } },
    ])
    expect(app.state().bays.prs[pr.id]).toMatchObject({
      status: "rejected",
      revision: pr.revision,
      headSha: pr.headSha,
    })
    expect(app.state().queues.authority.runs.R1).not.toHaveProperty("released")
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toContain("pr/rejected")

    const beforeRetry = await Array.fromAsync(app.events())
    await expect(app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).rejects.toThrow(/rejected/iu)
    expect(await Array.fromAsync(app.events())).toEqual(beforeRetry)
    expect(Object.keys(app.state().queues.records)).toEqual(["R1"])
    expect(mergeCalls).toBe(1)

    await app.bays.submit({ branch: pr.branch, headSha: UPDATED, base: pr.base, baseSha: BASE })
    expect(app.state().bays.prs[pr.id]).toMatchObject({ status: "submitted", revision: 2, headSha: UPDATED })

    const revised = await app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)
    const newRuns = revised.filter(({ id: run }) => run === "R2")
    expect(newRuns).toHaveLength(1)
    expect(newRuns).toMatchObject([{ id: "R2", status: "passed", prs: [{ id: pr.id, revision: 2, headSha: UPDATED }] }])
    expect(Object.keys(app.state().queues.records)).toEqual(["R1", "R2"])
    expect(app.state().bays.prs[pr.id]).toMatchObject({ status: "integrated", revision: 2, headSha: UPDATED })
    expect(mergeCalls).toBe(2)
  })

  it("audits a rejected revision retry without fresh submit ancestry and keeps authorized controls clean", async () => {
    const journal = createMemoryJournal<unknown>()
    const original = await createQueueApp(
      { check: () => ({ status: "failed", error: { code: "check-failed", message: "reject R1" } }) },
      journal,
    )
    const retried = await submitBranch(original, "issue/retry-without-submit")
    const first = (await original.queue.run({ prs: [retried.id] }, runtime))[0]
    if (first === undefined) throw new Error("expected authorized R1")
    expect(first).toMatchObject({ id: "R1", status: "failed" })
    expect(original.state().bays.prs[retried.id]?.status).toBe("rejected")
    const firstRecord = original.state().queues.records.R1
    if (firstRecord === undefined) throw new Error("expected persisted R1")
    const uncorrelatedSnapshot = firstRecord.prs[0]
    if (uncorrelatedSnapshot === undefined) throw new Error("expected persisted uncorrelated PR snapshot")
    expect(uncorrelatedSnapshot).not.toHaveProperty("correlation")
    await original.close()

    let cursor = 0
    for await (const batch of journal.read()) cursor = batch.cursor
    const command = { id: "00000000-0000-7000-9000-000000009201", op: "fixture.r92-retry" }
    expect(
      await journal.append(
        {
          command,
          cause: {
            id: "00000000-0000-7000-9000-000000009202",
            commandId: command.id,
            op: command.op,
            commandHash: Command.hash(command),
          },
          events: [
            {
              id: "00000000-0000-7000-9000-000000009203",
              name: "queue/run/started",
              ts: "2026-01-01T00:01:00.000Z",
              data: {
                run: {
                  id: "R2",
                  prs: firstRecord.prs,
                  base: firstRecord.base,
                  steps: firstRecord.steps,
                },
              },
            },
            {
              id: "00000000-0000-7000-9000-000000009204",
              name: "queue/run/failed",
              ts: "2026-01-01T00:01:00.001Z",
              data: {
                run: "R2",
                error: { code: "legacy-retry-terminal", message: "R2 ended without a fresh submit" },
              },
            },
          ],
        },
        cursor,
      ),
    ).toMatchObject({ appended: true })

    await using app = await createQueueApp({}, journal, undefined, ids(500))
    const legacyRetry = app.queue.get("R2")
    expect(legacyRetry).toMatchObject({ status: "failed", prs: [{ id: retried.id }] })
    const legacySnapshot = legacyRetry?.prs[0]
    if (legacySnapshot === undefined) throw new Error("expected replayed legacy PR snapshot")
    expect(legacySnapshot).not.toHaveProperty("correlation")

    const submitted = await submitBranch(app, "issue/submitted-control")
    const submittedRun = (await app.queue.run({ prs: [submitted.id] }, runtime))[0]
    if (submittedRun === undefined) throw new Error("expected submitted control run")

    await app.bays.submit({
      branch: "issue/draft-check-control",
      headSha: UPDATED,
      base: "main",
      baseSha: BASE,
      draft: true,
    })
    await app.bays.requestChecks({ pr: "PR3" })
    const draftCheck = (await app.queue.admit({ prs: ["PR3"] }, runtime))[0]
    if (draftCheck === undefined) throw new Error("expected pushed draft-check control run")
    expect(app.state().bays.prs.PR3?.status).toBe("pushed")

    expect(app.queue.audit().findings).toEqual([
      expect.objectContaining({ code: "run-without-submit-ancestry", run: "R2", pr: retried.id }),
    ])
  })

  it("schema-refuses queue.run retry authority without appending events", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/retry-schema")
    const before = await Array.fromAsync(app.events())
    const untrusted = { prs: [pr.id], retry: true }

    await expect(app.dispatch(app.commands.queue.run, untrusted)).rejects.toThrow(/retry/iu)

    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it.each(["pr/withdrawn", "pr/canceled"] as const)(
    "does not let stale revision-one %s invalidate revision-two authority",
    async (terminal) => {
      const journal = createMemoryJournal<unknown>()
      const original = await createQueueApp({}, journal)
      const stale = await submitBranch(original, `issue/stale-${terminal}`)
      await original.bays.intake({
        branch: stale.branch,
        headSha: UPDATED,
        base: stale.base,
        baseSha: BASE,
      })
      await original.bays.submit({ pr: stale.id })
      await original.bays.requestChecks({ pr: stale.id, baseSha: BASE })
      expect(original.state().bays.prs[stale.id]).toMatchObject({ revision: 2, headSha: UPDATED })
      await original.close()

      let cursor = 0
      for await (const batch of journal.read()) cursor = batch.cursor
      const command = { id: "00000000-0000-7000-9000-000000009211", op: "fixture.stale-terminal" }
      expect(
        await journal.append(
          {
            command,
            cause: {
              id: "00000000-0000-7000-9000-000000009212",
              commandId: command.id,
              op: command.op,
              commandHash: Command.hash(command),
            },
            events: [
              {
                id: "00000000-0000-7000-9000-000000009213",
                name: terminal,
                ts: "2026-01-01T00:01:00.000Z",
                data: {
                  pr: stale.id,
                  revision: stale.revision,
                  headSha: stale.headSha,
                  ...(terminal === "pr/canceled" ? { by: "@chief", reason: "stale cancellation" } : {}),
                },
              },
            ],
          },
          cursor,
        ),
      ).toMatchObject({ appended: true })

      await using app = await createQueueApp({}, journal, undefined, ids(500))
      expect(app.state().bays.prs[stale.id]).toMatchObject({ status: "submitted", revision: 2, headSha: UPDATED })
      expect(app.state().queues.authority).toMatchObject({
        statuses: { [stale.id]: "submitted" },
        submits: { [stale.id]: { revision: 2, headSha: UPDATED } },
        checks: { [stale.id]: { revision: 2, headSha: UPDATED } },
      })
    },
  )

  it("reauthorizes a failed draft admission through a fresh exact check request", async () => {
    let fail = true
    await using app = await createQueueApp({
      check: (input) =>
        fail && input.prs[0]?.id === "PR1"
          ? { status: "failed", error: { code: "typecheck-failed", message: "src/model.ts:12 failed" } }
          : { status: "passed", output: { checked: true } },
    })
    await app.bays.submit({ branch: "issue/draft-red", headSha: HEAD, base: "main", baseSha: BASE, draft: true })
    await app.bays.requestChecks({ pr: "PR1" })
    const admitted = (await app.queue.admit({ prs: ["PR1"] }))[0]
    if (admitted === undefined) throw new Error("expected an admission run")
    expect(await app.queue.admit({ prs: ["PR1"] }, runtime)).toMatchObject([{ status: "failed" }])
    expect(app.state().bays.prs.PR1?.status).toBe("pushed")

    await app.bays.ready({ pr: "PR1" })
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "checks-failed" },
      checks: { status: "failed", run: "R1" },
    })
    await expect(app.queue.run({ prs: ["PR1"] }, runtime)).rejects.toThrow("checks failed in R1")

    fail = false
    const reauthorization = await app.bays.requestChecks({ pr: "PR1" })
    expect(reauthorization.events.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "pr/checks-requested",
        data: { pr: "PR1", revision: 1, headSha: HEAD, baseSha: BASE },
      },
    ])
    const readmitted = (await app.queue.admit({ prs: ["PR1"] }, runtime))[0]
    if (readmitted === undefined) throw new Error("expected an explicitly reauthorized admission run")
    expect(readmitted).toMatchObject({ id: "R2", status: "passed", prs: [{ id: "PR1", headSha: HEAD }] })
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: true,
      checks: { status: "passed", run: "R2" },
    })
  })

  it("persists a queue pause and refuses unlisted PRs before creating a run", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    const allowed = await submitBranch(first, "issue/allowed")
    const blocked = await submitBranch(first, "issue/blocked")

    await first.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: [allowed.id] })

    expect(first.queue.status("main").pause).toMatchObject({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [allowed.id],
    })
    await expect(first.queue.run({ prs: [blocked.id] }, runtime)).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )
    await expect(first.dispatch(first.commands.queue.run, { prs: [blocked.id] })).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )
    expect(first.state().queues.records).toEqual({})
    await expect(first.queue.run({ prs: [allowed.id] }, runtime)).resolves.toHaveLength(1)
    await first.queue.resume("main")
    await expect(first.queue.run({ prs: [blocked.id] }, runtime)).resolves.toHaveLength(1)
    expect(first.queue.status("main").pause).toBeUndefined()
    await first.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: [allowed.id] })
    await first.close()

    await using replay = await createQueueApp({}, journal)
    expect(replay.queue.status("main").pause).toMatchObject({ allowedPRs: [allowed.id] })
  })

  it("does not bypass a canonical pause through a base alias", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/alias-paused", "origin/main")
    await app.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: [] })

    await expect(app.queue.run({ prs: [pr.id] }, runtime)).rejects.toThrow(`queue 'main' is paused: operator freeze`)
    await expect(app.dispatch(app.commands.queue.run, { prs: [pr.id] })).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )
    expect(app.state().queues.records).toEqual({})
  })

  it("treats base aliases as one active queue before a second run starts", async () => {
    const firstEntered = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let checkCalls = 0
    await using app = await createQueueApp({
      batch: 1,
      check: async (input) => {
        checkCalls++
        if (input.prs[0]?.branch === "issue/active-main") {
          firstEntered.resolve()
          await releaseFirst.promise
        }
        return { status: "waiting", token: `remote-${input.prs[0]?.id}` }
      },
    })
    const main = await submitBranch(app, "issue/active-main", "main")
    const alias = await submitBranch(app, "issue/active-alias", "origin/main")

    const firstRun = app.queue.run({ prs: [main.id] }, runtime)
    await firstEntered.promise
    let secondError: unknown
    try {
      await app.queue.run({ prs: [alias.id] }, runtime)
    } catch (error) {
      secondError = error
    } finally {
      releaseFirst.resolve()
      await firstRun
    }

    expect(secondError).toMatchObject({ message: "yrd: queue 'main' is running 'R1'" })
    expect(checkCalls).toBe(1)
  })

  it("canonically replays historical base aliases before pause lookup and partitioning", async () => {
    const command = { id: "00000000-0000-7000-8000-000000000201", op: "legacy.queue.fixture" }
    const journal = createMemoryJournal<unknown>([
      {
        command,
        cause: {
          id: "00000000-0000-7000-8000-000000000202",
          commandId: command.id,
          op: command.op,
          commandHash: Command.hash(command),
        },
        events: [
          {
            id: "00000000-0000-7000-8000-000000000203",
            name: "pr/pushed",
            ts: "2026-01-01T00:00:00.000Z",
            data: { pr: "PR1", branch: "issue/legacy-main", base: "main", headSha: HEAD, revision: 1 },
          },
          {
            id: "00000000-0000-7000-8000-000000000204",
            name: "pr/submitted",
            ts: "2026-01-01T00:00:00.001Z",
            data: { pr: "PR1", revision: 1, headSha: HEAD },
          },
          {
            id: "00000000-0000-7000-8000-000000000205",
            name: "pr/pushed",
            ts: "2026-01-01T00:00:00.002Z",
            data: { pr: "PR2", branch: "issue/legacy-alias", base: "origin/main", headSha: UPDATED, revision: 1 },
          },
          {
            id: "00000000-0000-7000-8000-000000000206",
            name: "pr/submitted",
            ts: "2026-01-01T00:00:00.003Z",
            data: { pr: "PR2", revision: 1, headSha: UPDATED },
          },
          {
            id: "00000000-0000-7000-8000-000000000207",
            name: "queue/paused",
            ts: "2026-01-01T00:00:00.004Z",
            data: {
              base: "origin/main",
              reason: "legacy freeze",
              allowedPRs: ["PR1", "PR2"],
            },
          },
        ],
      },
    ])
    await using app = await createQueueApp({ batch: 2 }, journal)

    expect(Object.values(app.state().bays.prs).map((pr) => pr.base)).toEqual(["main", "main"])
    expect(Object.keys(app.state().queues.pauses)).toEqual(["main"])
    expect(app.queue.status("origin/main")).toMatchObject({
      base: "main",
      pause: { base: "main", allowedPRs: ["PR1", "PR2"] },
    })

    const runs = await app.queue.run({}, runtime)
    expect(runs.map((run) => [run.base, run.prs.map((pr) => pr.id)])).toEqual([["main", ["PR1", "PR2"]]])
  })

  it("selects the first queue-ordered eligible submitted PR under a pause", async () => {
    let tick = 0
    await using app = await createQueueApp({ batch: 23 }, createMemoryJournal(), () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    )
    const prs = []
    for (let index = 1; index <= 23; index++) {
      await app.bays.submit({
        branch: `issue/pr-${index}`,
        headSha: index.toString(16).padStart(40, "0"),
        base: "main",
      })
      const pr = app.state().bays.prs[`PR${index}`]
      if (pr === undefined) throw new Error(`PR${index} was not recorded`)
      prs.push(pr)
    }
    const oldExcluded = prs[10]
    const allowed = prs[22]
    if (oldExcluded === undefined || allowed === undefined) throw new Error("PR fixture is incomplete")
    expect([oldExcluded.id, allowed.id]).toEqual(["PR11", "PR23"])

    await app.queue.run(
      {
        prs: prs.filter((pr) => pr.id !== oldExcluded.id && pr.id !== allowed.id).map((pr) => pr.id),
        steps: ["check", "review", "merge"],
      },
      runtime,
    )
    expect(app.state().bays.prs.PR11?.status).toBe("submitted")
    expect(app.state().bays.prs.PR23?.status).toBe("submitted")
    await app.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: ["PR23"] })

    const runs = await app.queue.run({}, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR23"]])
    expect(app.state().bays.prs.PR11?.status).toBe("submitted")
    expect(app.state().bays.prs.PR23?.status).toBe("integrated")
  })

  it("keeps completed history readable and refuses queued work after revision drift", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    await first.bays.submit({ branch: "issue/completed", headSha: HEAD, base: "main" })
    const completed = await first.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)
    await first.bays.submit({ branch: "issue/queued", headSha: UPDATED, base: "main" })
    const queued = await first.dispatch(first.commands.queue.run, { prs: ["PR2"], steps: ["check"] })
    const queuedJob = first.jobs.requested(queued)[0]
    if (queuedJob === undefined) throw new Error("queue did not request a Job")
    await first.close()

    let changedExecutions = 0
    const changed = await createQueueApp(
      {
        checkRevision: "check-v2",
        check: () => {
          changedExecutions++
          return { status: "passed", output: { checked: false } }
        },
      },
      journal,
    )
    expect(changed.queue.get(completed[0]!.id)).toMatchObject({
      status: "passed",
      shape: { results: { check: { checked: true } } },
    })
    await expect(changed.jobs.run(queuedJob, runtime)).rejects.toThrow("definition revision")
    expect(changedExecutions).toBe(0)
    await changed.close()

    const bayJobs = createBayJobDefs(workspace())
    const withoutSteps = withQueue({ steps: [] as const })
    const historyBase = pipe(createYrdDef(), withJobs({ definitions: bayJobs }), withBays({ jobs: bayJobs }))
    await using history = await createYrd(withoutSteps(historyBase), { inject: { journal } })
    expect(history.queue.get(completed[0]!.id)).toMatchObject({ status: "passed" })
  })

  it("rejects before merge but preserves integration when deployment fails", async () => {
    let merged = false
    await using rejectedApp = await createQueueApp({
      check: () => ({ status: "failed", error: { code: "check-failed", message: "tests failed" } }),
      merge: () => {
        merged = true
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const rejected = await submitBranch(rejectedApp, "issue/rejected")
    expect((await rejectedApp.queue.run({ prs: [rejected.id] }, runtime))[0]).toMatchObject({
      status: "failed",
      error: { code: "check-failed" },
    })
    expect(merged).toBe(false)
    expect(rejectedApp.state().bays.prs[rejected.id]).toMatchObject({ status: "rejected" })
    await rejectedApp.bays.submit({ branch: "issue/rejected", headSha: UPDATED, base: "main" })
    expect(rejectedApp.state().bays.prs[rejected.id]).toMatchObject({
      status: "submitted",
      revision: 2,
      headSha: UPDATED,
      revisions: [
        { revision: 1, headSha: HEAD },
        { revision: 2, headSha: UPDATED },
      ],
    })

    await using deployApp = await createQueueApp({
      batch: 2,
      deploy: () => ({ status: "failed", error: { code: "deploy-failed", message: "staging unavailable" } }),
    })
    const deployed = await submitBranch(deployApp, "issue/deploy-fails")
    const companion = await submitBranch(deployApp, "issue/deploy-companion")
    const run = (await deployApp.queue.run({ prs: [deployed.id, companion.id] }, runtime))[0]
    expect(run).toMatchObject({ status: "failed", error: { code: "deploy-failed" } })
    expect(deployApp.state().bays.prs).toMatchObject({
      [deployed.id]: { status: "integrated" },
      [companion.id]: { status: "integrated" },
    })
  })

  it("allows unrelated work while waiting and refuses a completed stale revision", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: (input) =>
        input.prs[0]?.branch === "issue/next"
          ? { status: "passed", output: { checked: true } }
          : { status: "waiting", token: `remote-${input.prs[0]?.id}` },
      merge: () => {
        merges++
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const remote = await submitBranch(app, "issue/remote")
    const waiting = (await app.queue.run({ prs: [remote.id] }, runtime))[0]!
    const waitingJob = waiting.steps[0]?.job
    if (waitingJob?.status !== "waiting") throw new Error("check did not wait")
    expect(app.queue.waiting(remote.id)).toMatchObject({
      run: { id: waiting.id },
      step: { name: "check", job: { id: waitingJob.id, status: "waiting" } },
    })

    const next = await submitBranch(app, "issue/next")
    expect((await app.queue.run({ prs: [next.id] }, runtime))[0]).toMatchObject({ status: "passed" })

    await app.bays.intake({ branch: remote.branch, headSha: UPDATED, base: "main" })
    expect(
      await app.queue.finish(
        remote.id,
        {
          job: waitingJob.id,
          step: "check",
          attempt: waitingJob.attempt,
          runner: waitingJob.runner,
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
      app.queue.finish(
        remote.id,
        {
          job: waitingJob.id,
          step: "check",
          attempt: waitingJob.attempt,
          runner: waitingJob.runner,
          token: waitingJob.token,
          result: { status: "passed", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow("no waiting 'check' step")
    expect(merges).toBe(1)
    expect(app.state().bays.prs[remote.id]).toMatchObject({ revision: 2, headSha: UPDATED, status: "pushed" })
  })

  it("refuses a delayed completion from an earlier attempt when a retry reuses its token", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
      merge: () => {
        merges += 1
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/reused-token")
    const first = (
      await app.queue.run(
        { prs: [pr.id], steps: ["check", "merge"] },
        {
          runner: "runner-1",
          leaseMs: 60_000,
        },
      )
    )[0]
    const firstJob = first?.steps[0]?.job
    if (firstJob?.status !== "waiting") throw new Error("first attempt did not wait")

    await app.jobs.finish(firstJob.id, {
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
      result: { status: "failed", error: { code: "remote-failed", message: "retry requested" } },
    })
    await app.jobs.retry(firstJob.id)
    const retried = await app.jobs.run(firstJob.id, { runner: "runner-2", leaseMs: 60_000 })
    expect(retried).toMatchObject({
      id: firstJob.id,
      status: "waiting",
      attempt: 2,
      runner: "runner-2",
      token: "shared-token",
    })

    const delayedAttemptOne = {
      job: firstJob.id,
      step: "check",
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
      result: { status: "passed" as const, output: { checked: true } },
    }
    await expect(app.queue.finish(pr.id, delayedAttemptOne, runtime)).rejects.toThrow("attempt 1 is stale")

    expect(app.queue.get(first!.id)?.steps[0]?.job).toMatchObject({
      status: "waiting",
      attempt: 2,
      runner: "runner-2",
    })
    expect(app.state().bays.prs[pr.id]?.status).toBe("submitted")
    expect(merges).toBe(0)
  })

  it("refuses a delayed completion from an earlier Job with the same owner credential", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
      merge: () => {
        merges += 1
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/reused-owner")
    const first = (await app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime))[0]
    const firstJob = first?.steps[0]?.job
    if (firstJob?.status !== "waiting") throw new Error("first Job did not wait")

    await app.jobs.finish(firstJob.id, {
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
      result: { status: "failed", error: { code: "remote-failed", message: "resubmit requested" } },
    })
    await expect(app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime)).resolves.toEqual([
      expect.objectContaining({ id: first?.id, status: "failed" }),
    ])

    await app.bays.submit({ branch: pr.branch, headSha: UPDATED, base: "main" })
    const second = (await app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime)).find(
      (run) => run.id === "R2",
    )
    const secondJob = second?.steps[0]?.job
    if (secondJob?.status !== "waiting") throw new Error("second Job did not wait")
    expect(secondJob).toMatchObject({
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
    })
    expect(secondJob.id).not.toBe(firstJob.id)

    await expect(
      app.queue.finish(
        pr.id,
        {
          job: firstJob.id,
          step: "check",
          attempt: firstJob.attempt,
          runner: firstJob.runner,
          token: firstJob.token,
          result: { status: "passed", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow(firstJob.id)
    expect(app.queue.get(second!.id)?.steps[0]?.job).toMatchObject({ id: secondJob.id, status: "waiting" })
    expect(app.state().bays.prs[pr.id]?.status).toBe("submitted")
    expect(merges).toBe(0)
  })

  it("recursively bisects a red batch and rejects only the isolated PR", async () => {
    const checked: string[][] = []
    await using app = await createQueueApp({
      batch: 4,
      check: (input) => {
        const prs = input.prs.map((pr) => pr.id)
        checked.push(prs)
        return prs.includes("PR3")
          ? { status: "failed", error: { code: "check-failed", message: "bad PR" } }
          : { status: "passed", output: { checked: true } }
      },
    })
    await submitBranch(app, "issue/one")
    await submitBranch(app, "issue/two")
    await submitBranch(app, "issue/bad")
    await submitBranch(app, "issue/four")

    const runs = await app.queue.run({ prs: [] }, runtime)

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

  it("releases root-owned authority when an isolated child is environment-refused", async () => {
    const checked: string[][] = []
    let isolatedPR1Checks = 0
    await using app = await createQueueApp({
      batch: 2,
      check: (input) => {
        const prs = input.prs.map((pr) => pr.id)
        checked.push(prs)
        if (prs.length === 2) {
          return { status: "failed", error: { code: "check-failed", message: "batch is merit-red" } }
        }
        if (prs[0] === "PR1" && ++isolatedPR1Checks === 1) {
          return {
            status: "failed",
            error: { code: "queue-environment-refused", message: "isolated runner unavailable" },
          }
        }
        return { status: "passed", output: { checked: true } }
      },
    })
    const first = await submitBranch(app, "issue/environment-child")
    const second = await submitBranch(app, "issue/passing-child")

    const runs = await app.queue.run({ prs: [first.id, second.id] }, runtime)

    expect(runs).toMatchObject([
      { id: "R1", status: "failed", error: { code: "check-failed" } },
      { id: "R2", parent: "R1", status: "failed", error: { code: "queue-environment-refused" } },
      { id: "R3", parent: "R1", status: "passed" },
    ])
    expect(checked).toEqual([["PR1", "PR2"], ["PR1"], ["PR2"]])
    expect(Object.keys(app.state().queues.records)).toEqual(["R1", "R2", "R3"])
    expect(Object.fromEntries(Object.values(app.state().bays.prs).map((pr) => [pr.id, pr.status]))).toEqual({
      PR1: "submitted",
      PR2: "integrated",
    })

    const events = await Array.fromAsync(app.events())
    const childFailure = events.find((applied) => {
      if (applied.name !== "queue/run/failed") return false
      const data = applied.data as Readonly<{ run?: unknown; error?: Readonly<{ code?: unknown }> }>
      return data.run === "R2" && data.error?.code === "queue-environment-refused"
    })
    if (childFailure === undefined) throw new Error("expected isolated environment refusal to fail R2")
    expect(app.state().queues.authority.runs.R1).not.toHaveProperty("released")
    expect(app.state().queues.authority.runs.R2).toMatchObject({
      inheritedFrom: "R1",
      released: { reason: "queue-environment-refused", ref: childFailure.id },
    })
    expect(app.state().queues.authority.submits.PR1).toEqual({
      pr: first.id,
      revision: first.revision,
      headSha: first.headSha,
    })
    expect(events.filter(({ name }) => name === "queue/batch/isolated")).toHaveLength(2)

    const retried = await app.queue.run({ prs: [first.id] }, runtime)
    const newRuns = retried.filter(({ id: run }) => run === "R4")
    expect(newRuns).toHaveLength(1)
    expect(newRuns).toMatchObject([
      {
        id: "R4",
        status: "passed",
        prs: [{ id: first.id, revision: first.revision, headSha: first.headSha }],
      },
    ])
    expect(Object.keys(app.state().queues.records)).toEqual(["R1", "R2", "R3", "R4"])
    expect(app.state().bays.prs[first.id]).toMatchObject({
      status: "integrated",
      revision: first.revision,
      headSha: first.headSha,
    })
  })
})
