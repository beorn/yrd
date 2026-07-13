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

function linePlugin(
  options: Readonly<{
    batch?: false | number
    check?: (input: StepExecution<PRShape>) => JobResult<CheckResult>
    merge?: (input: StepExecution<ReviewedShape>) => JobResult<{ commit: string; baseSha: string }>
    deploy?: (input: StepExecution<MergedShape>) => JobResult<DeployResult>
    checkRevision?: string
    requires?: readonly ["review"]
    resolveBaseSha?: (base: string) => string | Promise<string>
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
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.resolveBaseSha === undefined ? {} : { resolveBaseSha: options.resolveBaseSha }),
  })
}

async function createLineApp(
  options: Parameters<typeof linePlugin>[0] = {},
  journal = createMemoryJournal(),
  clock: () => string = () => "2026-01-01T00:00:00.000Z",
  id: () => string = ids(),
) {
  const bayJobs = createBayJobDefs(workspace())
  const line = linePlugin(options)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, line.jobDefs] }), withBays({ jobs: bayJobs }))
  const definition = line(base)
  return createYrd(definition, {
    inject: { journal, id, clock },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createLineApp>>, branch: string, base = "main") {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base, baseSha: BASE })
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

  it("reconciles historical same-payload PRs from one integration proof", async () => {
    const journal = createMemoryJournal<unknown>()
    await using app = await createLineApp({}, journal)
    const canonical = await submitBranch(app, "task/one")
    const run = (await app.line.integrate({ prs: [canonical.id], steps: ["check", "review", "merge"] }, runtime))[0]
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
                branch: "origin/task/one",
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

    const reconciled = await app.dispatch(app.commands.line.advance, { run: run?.id ?? "missing" })

    expect(run).toMatchObject({ status: "passed", integration: { commit: MERGED } })
    expect(reconciled.events).toEqual([
      expect.objectContaining({ name: "pr/integrated", data: expect.objectContaining({ pr: "PR2" }) }),
    ])
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "integrated", integration: run?.integration })
    expect(app.state().bays.prs.PR2).toMatchObject({ status: "integrated", integration: run?.integration })
  })

  it("integrates the implicit queue in PR revision submission order", async () => {
    let tick = 0
    await using app = await createLineApp({ batch: 1 }, createMemoryJournal(), () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    )
    await app.bays.intake({ branch: "task/created-first", headSha: HEAD, base: "main" })
    await app.bays.intake({ branch: "task/submitted-first", headSha: UPDATED, base: "main" })
    await app.bays.submit({ pr: "PR2" })
    await app.bays.submit({ pr: "PR1" })

    const runs = await app.line.integrate({}, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR2"], ["PR1"]])
  })

  it("uses one typed eligibility projection for draft, review, and revision freshness", async () => {
    await using app = await createLineApp({ requires: ["review"] })
    await app.bays.submit({ branch: "task/review-me", headSha: HEAD, base: "main", draft: true })

    expect(app.line.eligibility("PR1")).toMatchObject({
      pr: "PR1",
      runnable: false,
      reason: { code: "draft", message: "PR 'PR1' is pushed, not ready" },
      review: { required: true, approved: false },
    })
    await app.bays.comment({ pr: "PR1", actor: "@cto", ref: "question-1", note: "Why this shape?" })
    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "reject", ref: "verdict-red" })
    await app.bays.ready({ pr: "PR1" })
    expect(app.line.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "review-rejected", message: "PR 'PR1' was rejected by @cto for revision 1" },
      review: { required: true, approved: false, decision: "reject", actor: "@cto", ref: "verdict-red" },
    })
    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "approve", ref: "verdict-1" })
    expect(app.line.eligibility("PR1")).toMatchObject({
      runnable: true,
      review: { required: true, approved: true, decision: "approve", actor: "@cto", ref: "verdict-1" },
    })

    await app.bays.ready({ pr: "PR1" })
    expect(app.line.eligibility("PR1")).toMatchObject({ runnable: true })
    expect(app.line.eligibility("PR1").reason).toBeUndefined()
    await expect(app.line.integrate({ prs: ["PR1"] }, runtime)).resolves.toHaveLength(1)

    await app.bays.submit({ branch: "task/review-stales", headSha: UPDATED, base: "main", draft: true })
    await app.bays.review({ pr: "PR2", actor: "@cto", decision: "approve", ref: "verdict-2" })
    await app.bays.ready({ pr: "PR2" })
    await app.bays.intake({ branch: "task/review-stales", headSha: "4".repeat(40), base: "main" })
    await app.bays.ready({ pr: "PR2" })
    expect(app.line.eligibility("PR2")).toMatchObject({
      runnable: false,
      reason: { code: "review-required" },
      review: { required: true, approved: false, stale: true },
    })
    await expect(app.line.integrate({ prs: ["PR2"] }, runtime)).rejects.toThrow(
      "PR 'PR2' needs approval for revision 2",
    )

    await app.bays.submit({ branch: "task/rejection-stales", headSha: "5".repeat(40), base: "main", draft: true })
    await app.bays.review({ pr: "PR3", actor: "@cto", decision: "reject", ref: "verdict-3" })
    await app.bays.ready({ pr: "PR3" })
    expect(app.line.eligibility("PR3")).toMatchObject({
      runnable: false,
      reason: { code: "review-rejected" },
      review: { required: true, approved: false, decision: "reject", stale: false },
    })
    await app.bays.intake({ branch: "task/rejection-stales", headSha: "6".repeat(40), base: "main" })
    await app.bays.ready({ pr: "PR3" })
    expect(app.line.eligibility("PR3")).toMatchObject({
      runnable: false,
      reason: { code: "review-required" },
      review: { required: true, approved: false, stale: true },
    })

    expect(app.state().lines.records).toHaveProperty("R1")
    expect(Object.keys(app.state().lines.records)).toHaveLength(1)
  })

  it("admits configured checks through Line once and reuses their journaled result for integration", async () => {
    let checks = 0
    await using app = await createLineApp({
      check: () => {
        checks++
        return { status: "passed", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "task/admitted")
    await app.bays.requestChecks({ pr: pr.id })

    expect(app.line.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "checks-pending" },
      checks: { status: "queued", position: 1, queuedAt: expect.any(String) },
    })
    const admission = (await app.line.admit({ prs: [pr.id] }))[0]
    expect(admission).toMatchObject({
      id: "R1",
      status: "running",
      prs: [{ id: pr.id, headSha: pr.headSha }],
      steps: [{ name: "check" }, { name: "review" }],
    })
    expect(checks).toBe(0)
    expect(app.line.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "checking" },
      checks: { status: "checking", run: "R1" },
    })

    expect(await app.line.run("R1", runtime)).toMatchObject({ status: "passed" })
    expect(checks).toBe(1)
    expect(app.line.eligibility(pr.id)).toMatchObject({
      runnable: true,
      checks: { status: "passed", run: "R1" },
    })

    const integrated = (await app.line.integrate({ prs: [pr.id] }, runtime))[0]
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

  it("owns the admission drain inside Line before integrating the same cached proof", async () => {
    let checks = 0
    await using app = await createLineApp({
      check: () => {
        checks++
        return { status: "passed", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "task/line-owned-drain")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.line.admit({ prs: [pr.id] })).toHaveLength(1)
    expect(checks).toBe(0)

    const integrated = await app.line.integrate({ prs: [pr.id] }, runtime)

    expect(integrated).toMatchObject([{ id: "R2", status: "passed", reusedFrom: "R1" }])
    expect(checks).toBe(1)
  })

  it("does not let an unrelated waiting admission monopolize Line capacity", async () => {
    await using app = await createLineApp({
      check: (input) =>
        input.prs[0]?.id === "PR1"
          ? { status: "waiting", token: "remote-one" }
          : { status: "passed", output: { checked: true } },
    })
    const waiting = await submitBranch(app, "task/waiting-check")
    const healthy = await submitBranch(app, "task/healthy-check")
    await app.bays.requestChecks({ pr: waiting.id })
    await app.bays.requestChecks({ pr: healthy.id })

    expect(await app.line.admit({ prs: [waiting.id] }, runtime)).toMatchObject([
      { status: "waiting", prs: [{ id: waiting.id }] },
    ])
    expect(await app.line.admit({ prs: [healthy.id] }, runtime)).toMatchObject([
      { status: "passed", prs: [{ id: healthy.id }] },
    ])
    expect(app.line.eligibility(waiting.id)).toMatchObject({ checks: { status: "checking" } })
    expect(app.line.eligibility(healthy.id)).toMatchObject({ checks: { status: "passed" } })
  })

  it("keys admission reuse by the freshly resolved base SHA", async () => {
    let baseSha = BASE
    let checks = 0
    const checkedBases: Array<string | undefined> = []
    await using app = await createLineApp({
      resolveBaseSha: () => baseSha,
      check: (input) => {
        checks++
        checkedBases.push(input.prs[0]?.baseSha)
        return { status: "passed", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "task/base-keyed-cache")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.line.admit({ prs: [pr.id] }, runtime)).toMatchObject([{ status: "passed" }])
    expect(checks).toBe(1)

    baseSha = UPDATED
    const integrated = await app.line.integrate({ prs: [pr.id] }, runtime)

    expect(integrated).toMatchObject([{ status: "passed", reusedFrom: "R2" }])
    expect(checks).toBe(2)
    expect(checkedBases).toEqual([BASE, UPDATED])
    expect(app.line.get("R2")?.prs).toMatchObject([{ baseSha: UPDATED }])
  })

  it("projects a pinned-run failure as a failed check fact before its Job starts", async () => {
    await using app = await createLineApp()
    const pr = await submitBranch(app, "task/stale-before-job")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.line.admit({ prs: [pr.id] })).toHaveLength(1)
    await app.bays.closePr({ pr: pr.id })

    expect(await app.line.run("R1", runtime)).toMatchObject({ status: "failed", error: { code: "stale-pr" } })
    expect(app.line.checks([pr.id])).toMatchObject([
      { pr: pr.id, revision: 1, run: "R1", step: "check", status: "failed", error: { code: "stale-pr" } },
    ])
  })

  it("keeps admission globally FIFO even when a later PR is selected explicitly", async () => {
    const checked: string[] = []
    await using app = await createLineApp({
      check: (input) => {
        checked.push(input.prs[0]!.id)
        return { status: "passed", output: { checked: true } }
      },
    })
    const first = await submitBranch(app, "task/first-check")
    const second = await submitBranch(app, "task/second-check")
    await app.bays.requestChecks({ pr: first.id })
    await app.bays.requestChecks({ pr: second.id })

    expect(app.line.eligibility(second.id)).toMatchObject({ checks: { status: "queued", position: 2 } })
    expect(await app.line.admit({ prs: [second.id] })).toEqual([])
    const firstRun = (await app.line.admit({}))[0]
    if (firstRun === undefined) throw new Error("expected the first queued admission")
    expect(firstRun.prs).toMatchObject([{ id: first.id }])
    await app.line.run(firstRun.id, runtime)

    const secondRun = (await app.line.admit({}))[0]
    if (secondRun === undefined) throw new Error("expected the second queued admission")
    expect(secondRun.prs).toMatchObject([{ id: second.id }])
    await app.line.run(secondRun.id, runtime)
    expect(checked).toEqual([first.id, second.id])
  })

  it("orders admission age and position from the check request fact, not the earlier push", async () => {
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createLineApp({}, createMemoryJournal(), () => now)
    const pushedFirst = await submitBranch(app, "task/pushed-first")
    now = "2026-01-01T00:01:00.000Z"
    const requestedFirst = await submitBranch(app, "task/requested-first")
    now = "2026-01-01T00:02:00.000Z"
    await app.bays.requestChecks({ pr: requestedFirst.id })
    now = "2026-01-01T00:03:00.000Z"
    await app.bays.requestChecks({ pr: pushedFirst.id })

    expect(app.line.eligibility(requestedFirst.id)).toMatchObject({
      checks: { status: "queued", position: 1, queuedAt: "2026-01-01T00:02:00.000Z" },
    })
    expect(app.line.eligibility(pushedFirst.id)).toMatchObject({
      checks: { status: "queued", position: 2, queuedAt: "2026-01-01T00:03:00.000Z" },
    })
    const admitted = (await app.line.admit({}))[0]
    expect(admitted?.prs).toMatchObject([{ id: requestedFirst.id }])
  })

  it("naturally misses the journal cache when the installed-step identity changes", async () => {
    const journal = createMemoryJournal()
    const first = await createLineApp({}, journal)
    const pr = await submitBranch(first, "task/cache-identity")
    await first.bays.requestChecks({ pr: pr.id })
    const admitted = (await first.line.admit({ prs: [pr.id] }))[0]
    if (admitted === undefined) throw new Error("expected an admission run")
    await first.line.run(admitted.id, runtime)
    await first.close()

    let changedChecks = 0
    await using changed = await createLineApp(
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
    const readmission = (await changed.line.admit({ prs: [pr.id] }))[0]
    if (readmission === undefined) throw new Error("expected a cache-miss admission run")
    expect(readmission).toMatchObject({
      status: "running",
      steps: [{ name: "check", revision: "check-v2" }, { name: "review" }],
    })
    await changed.line.run(readmission.id, runtime)

    const integrated = (await changed.line.integrate({ prs: [pr.id] }, runtime))[0]
    expect(integrated).toMatchObject({
      status: "passed",
      reusedFrom: readmission.id,
      steps: [{ name: "merge" }, { name: "deploy" }],
    })
    expect(changedChecks).toBe(1)
  })

  it("keeps a draft admission failure ineligible after ready until an explicit retry", async () => {
    let fail = true
    await using app = await createLineApp({
      check: (input) =>
        fail && input.prs[0]?.id === "PR1"
          ? { status: "failed", error: { code: "typecheck-failed", message: "src/model.ts:12 failed" } }
          : { status: "passed", output: { checked: true } },
    })
    await app.bays.submit({ branch: "task/draft-red", headSha: HEAD, base: "main", baseSha: BASE, draft: true })
    await app.bays.requestChecks({ pr: "PR1" })
    const admitted = (await app.line.admit({ prs: ["PR1"] }))[0]
    if (admitted === undefined) throw new Error("expected an admission run")
    expect(await app.line.run(admitted.id, runtime)).toMatchObject({ status: "failed" })
    expect(app.state().bays.prs.PR1?.status).toBe("pushed")

    const healthy = await submitBranch(app, "task/healthy-after-red")
    await app.bays.requestChecks({ pr: healthy.id })
    const healthyAdmission = (await app.line.admit({}))[0]
    if (healthyAdmission === undefined) throw new Error("expected unrelated checks to bypass failed history")
    expect(healthyAdmission.prs).toMatchObject([{ id: healthy.id }])
    await app.line.run(healthyAdmission.id, runtime)

    await app.bays.ready({ pr: "PR1" })
    expect(app.line.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "checks-failed" },
      checks: { status: "failed", run: "R1" },
    })
    await expect(app.line.integrate({ prs: ["PR1"] }, runtime)).rejects.toThrow("checks failed in R1")

    fail = false
    const retry = (await app.line.admit({ prs: ["PR1"], retry: true }))[0]
    if (retry === undefined) throw new Error("expected a retry admission run")
    await app.line.run(retry.id, runtime)
    expect(app.line.eligibility("PR1")).toMatchObject({ runnable: true, checks: { status: "passed" } })
  })

  it("persists a line hold and refuses unlisted PRs before creating a run", async () => {
    const journal = createMemoryJournal()
    const first = await createLineApp({}, journal)
    const allowed = await submitBranch(first, "task/allowed")
    const blocked = await submitBranch(first, "task/blocked")

    await first.line.hold({ base: "main", reason: "operator freeze", allowedPRs: [allowed.id] })

    expect(first.line.status("main").hold).toMatchObject({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [allowed.id],
    })
    await expect(first.line.integrate({ prs: [blocked.id] }, runtime)).rejects.toThrow(
      `line 'main' is held: operator freeze`,
    )
    await expect(first.dispatch(first.commands.line.integrate, { prs: [blocked.id] })).rejects.toThrow(
      `line 'main' is held: operator freeze`,
    )
    expect(first.state().lines.records).toEqual({})
    await expect(first.line.integrate({ prs: [allowed.id] }, runtime)).resolves.toHaveLength(1)
    await first.line.release("main")
    await expect(first.line.integrate({ prs: [blocked.id] }, runtime)).resolves.toHaveLength(1)
    expect(first.line.status("main").hold).toBeUndefined()
    await first.line.hold({ base: "main", reason: "operator freeze", allowedPRs: [allowed.id] })
    await first.close()

    await using replay = await createLineApp({}, journal)
    expect(replay.line.status("main").hold).toMatchObject({ allowedPRs: [allowed.id] })
  })

  it("selects the first queue-ordered eligible submitted PR under a hold", async () => {
    let tick = 0
    await using app = await createLineApp({ batch: 23 }, createMemoryJournal(), () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    )
    const prs = []
    for (let index = 1; index <= 23; index++) {
      await app.bays.submit({
        branch: `task/pr-${index}`,
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

    await app.line.integrate(
      {
        prs: prs.filter((pr) => pr.id !== oldExcluded.id && pr.id !== allowed.id).map((pr) => pr.id),
        steps: ["check", "review", "merge"],
      },
      runtime,
    )
    expect(app.state().bays.prs.PR11?.status).toBe("submitted")
    expect(app.state().bays.prs.PR23?.status).toBe("submitted")
    await app.line.hold({ base: "main", reason: "operator freeze", allowedPRs: ["PR23"] })

    const runs = await app.line.integrate({}, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR23"]])
    expect(app.state().bays.prs.PR11?.status).toBe("submitted")
    expect(app.state().bays.prs.PR23?.status).toBe("integrated")
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

    let deploymentAvailable = false
    await using deployApp = await createLineApp({
      batch: 2,
      deploy: () =>
        deploymentAvailable
          ? { status: "passed", output: { environment: "staging" } }
          : { status: "failed", error: { code: "deploy-failed", message: "staging unavailable" } },
    })
    const deployed = await submitBranch(deployApp, "task/deploy-fails")
    const companion = await submitBranch(deployApp, "task/deploy-companion")
    const run = (await deployApp.line.integrate({ prs: [deployed.id, companion.id] }, runtime))[0]
    expect(run).toMatchObject({ status: "failed", error: { code: "deploy-failed" } })
    expect(deployApp.state().bays.prs).toMatchObject({
      [deployed.id]: { status: "integrated" },
      [companion.id]: { status: "integrated" },
    })
    deploymentAvailable = true
    expect(
      (await deployApp.line.integrate({ prs: [deployed.id, companion.id], steps: ["deploy"] }, runtime))[0],
    ).toMatchObject({ status: "passed", steps: [{ name: "deploy" }] })
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
