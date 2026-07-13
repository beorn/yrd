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

function queuePlugin(
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
  return withQueue({
    steps: [check, review, merge, deploy] as const,
    batch: options.batch ?? false,
    defaultSteps: ["check", "review", "merge", "deploy"],
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
  await app.bays.submit({ branch, headSha: digit.repeat(40), base })
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

  it("reconciles a replayed lost job without granting recovery execution authority", async () => {
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
    expect(replayed.state().bays.prs.PR1?.status).toBe("rejected")
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect((await Array.fromAsync(replayed.events())).slice(before.length)).toMatchObject([{ name: "pr/rejected" }])

    const reconciled = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:03:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(replayed.events())).toEqual(reconciled)
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
      app.queue.finish(
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
})
