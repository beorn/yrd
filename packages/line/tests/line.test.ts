import { describe, expect, expectTypeOf, it } from "vitest"
import { withBays, type BayWorkspaceAdapter } from "@yrd/bay"
import { createMemoryEventStore, createYrd, pipe, withEffects, type EffectOutcome } from "@yrd/core"
import {
  withBatch,
  withDefaultSteps,
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type IntegratedShape,
  type LineRuntime,
  type StepEvidence,
  type StepExecution,
  type SubmissionShape,
} from "@yrd/line"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const UPDATED = "3".repeat(40)
const runtime = { executor: "local", leaseMs: 60_000 }

type CheckResult = { checked: true }
type ReviewResult = { approved: true }
type DeployResult = { environment: string }
type CheckedShape = AddStepResult<SubmissionShape, "check", CheckResult>
type ReviewedShape = AddStepResult<CheckedShape, "review", ReviewResult>

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function workspace(): BayWorkspaceAdapter {
  return {
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

function createLineApp(
  options: {
    batch?: false | number
    check?: (input: StepExecution<SubmissionShape>) => EffectOutcome<CheckResult>
    merge?: (input: StepExecution<ReviewedShape>) => EffectOutcome<{ commit: string; baseSha: string }>
    deploy?: (input: StepExecution<IntegratedShape>) => EffectOutcome<DeployResult>
  } = {},
) {
  const merged = pipe(
    createYrd({ store: createMemoryEventStore(), idGen: ids(), clock: () => "2026-01-01T00:00:00.000Z" }),
    withEffects(),
    withBays({ workspace: workspace() }),
    withLine(),
    withBatch(options.batch ?? false),
    withStep(
      "check",
      (input: StepExecution<SubmissionShape>): EffectOutcome<CheckResult> =>
        options.check?.(input) ?? { status: "passed", output: { checked: true } },
    ),
    withStep("review", (_input: StepExecution<CheckedShape>) => ({
      status: "passed" as const,
      output: { approved: true as const },
    })),
    withMerge(
      (input: StepExecution<ReviewedShape>): EffectOutcome<{ commit: string; baseSha: string }> =>
        options.merge?.(input) ?? { status: "passed", output: { commit: MERGED, baseSha: BASE } },
    ),
  )
  return pipe(
    merged,
    withStep(
      "deploy",
      (input: StepExecution<IntegratedShape>): EffectOutcome<DeployResult> =>
        options.deploy?.(input) ?? { status: "passed", output: { environment: "staging" } },
      { needsIntegration: true },
    ),
    withDefaultSteps(["check", "review", "merge", "deploy"]),
  )
}

async function submitBranch(app: ReturnType<typeof createLineApp>, branch: string, base = "main") {
  await app.command(app.commands.bay.submit, { branch, headSha: HEAD, base })
  const submission = Object.values((await app.state()).bays.submissions).find((item) => item.branch === branch)
  if (submission === undefined) throw new Error("submission was not recorded")
  return submission
}

describe("line composition", () => {
  it("composes typed plugin state and rejects impossible step evidence", () => {
    const base = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: workspace() }),
      withLine(),
    )
    const checked = withStep("check", (_input: StepExecution<SubmissionShape>) => ({
      status: "passed" as const,
      output: { checked: true as const },
    }))(base)
    const reviewed = withStep("review", (_input: StepExecution<CheckedShape>) => ({
      status: "passed" as const,
      output: { approved: true as const },
    }))(checked)
    const merged = withMerge((_input: StepExecution<ReviewedShape>) => ({
      status: "passed" as const,
      output: { commit: MERGED, baseSha: BASE },
    }))(reviewed)
    const deploy = withStep(
      "deploy",
      (_input: StepExecution<IntegratedShape>) => ({
        status: "passed" as const,
        output: { environment: "test" },
      }),
      { needsIntegration: true },
    )

    expectTypeOf(checked.line).toMatchTypeOf<LineRuntime<CheckedShape>>()
    expect(
      deploy(merged)
        .line.steps()
        .map((step) => step.name),
    ).toEqual(["check", "review", "merge", "deploy"])

    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error deploy requires the state produced by withMerge
      deploy(reviewed)
    })

    const queued = { name: "check", index: 0, status: "queued" } satisfies StepEvidence
    expect(queued.status).toBe("queued")
    // @ts-expect-error queued steps cannot already own a durable effect
    const impossibleQueued: StepEvidence = { ...queued, effectId: "effect-1" }
    expect(impossibleQueued).toBeDefined()
  })

  it("runs check, review, exact merge, and deploy across independent base lines and batches", async () => {
    const app = createLineApp({
      batch: 2,
      deploy: (input) => ({ status: "passed", output: { environment: input.submission.base } }),
    })
    const first = await submitBranch(app, "task/one")
    const second = await submitBranch(app, "task/two")
    const release = await submitBranch(app, "task/release", "release/2.0")

    const runs = await app.line.integrate({ submissions: [] }, runtime)

    expect(runs.map((run) => [run.base, run.submissions.map((submission) => submission.id)])).toEqual([
      ["main", [first.id, second.id]],
      ["release/2.0", [release.id]],
    ])
    for (const run of runs) {
      expect(run.steps.map((step) => step.name)).toEqual(["check", "review", "merge", "deploy"])
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
    }
    const state = await app.state()
    for (const run of runs) {
      const record = state.lines.records[run.id]
      if (record === undefined) throw new Error(`missing line record ${run.id}`)
      expect(Object.keys(record)).not.toEqual(
        expect.arrayContaining(["status", "steps", "shape", "output", "error", "finishedAt"]),
      )
      expect(run.steps.map((step) => [step.effectId, step.status, step.attempt, step.output, step.error])).toEqual(
        run.effectIds.map((id) => {
          const effect = state.effects.runs[id]
          return [id, effect?.status, effect?.attempt, effect?.output, effect?.error]
        }),
      )
      expect(run.steps.every((step) => step.startedAt !== undefined && step.finishedAt !== undefined)).toBe(true)
    }
    expect(Object.values(state.bays.submissions).map((submission) => submission.integration)).toEqual([
      { commit: MERGED, baseSha: BASE },
      { commit: MERGED, baseSha: BASE },
      { commit: MERGED, baseSha: BASE },
    ])
    expect((await app.line.status("main")).finished).toHaveLength(1)
    expect((await app.line.status("release/2.0")).finished).toHaveLength(1)
    const names: string[] = []
    for await (const applied of app.events()) names.push(applied.name)
    expect(names).toContain("line/run/integrated")
    expect(names).not.toContain("line/step/finished")
    expect(names).not.toContain("line/run/finished")
    expect(names).not.toContain("line/run/resumed")
  })

  it("stops before merge on a rejected check but never revokes a completed merge", async () => {
    let merged = false
    const rejectedApp = createLineApp({
      check: () => ({ status: "failed", error: { code: "check-failed", message: "tests failed" } }),
      merge: () => {
        merged = true
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const rejected = await submitBranch(rejectedApp, "task/rejected")
    expect(await rejectedApp.line.integrate({ submission: rejected.id }, runtime)).toMatchObject({
      status: "failed",
      error: { code: "check-failed" },
    })
    expect(merged).toBe(false)
    expect((await rejectedApp.state()).bays.submissions[rejected.id]).toMatchObject({ status: "rejected" })

    const deployApp = createLineApp({
      batch: 2,
      deploy: () => ({ status: "failed", error: { code: "deploy-failed", message: "staging unavailable" } }),
    })
    const deployed = await submitBranch(deployApp, "task/deploy-fails")
    const companion = await submitBranch(deployApp, "task/deploy-companion")
    const deployRuns = await deployApp.line.integrate({ submissions: [deployed.id, companion.id] }, runtime)
    expect(deployRuns).toHaveLength(1)
    expect(deployRuns[0]).toMatchObject({
      status: "failed",
      error: { code: "deploy-failed" },
    })
    expect((await deployApp.state()).bays.submissions).toMatchObject({
      [deployed.id]: { status: "integrated", integration: { commit: MERGED, baseSha: BASE } },
      [companion.id]: { status: "integrated", integration: { commit: MERGED, baseSha: BASE } },
    })
  })

  it("resumes durable remote work but refuses it after the pinned submission changes", async () => {
    let merges = 0
    const app = createLineApp({
      check: (input) => {
        if (input.submission.branch === "task/remote") {
          return { status: "waiting", token: "remote-1" }
        }
        return input.submission.branch === "task/stale"
          ? { status: "waiting", token: "remote-stale" }
          : { status: "passed", output: { checked: true } }
      },
      merge: () => {
        merges++
        return { status: "passed", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const remote = await submitBranch(app, "task/remote")
    const waiting = await app.line.integrate({ submission: remote.id }, runtime)
    const waitingStep = waiting.steps[0]
    if (waitingStep?.status !== "waiting") throw new Error("check did not park")
    expect(waitingStep.token).toBe("remote-1")

    const next = await submitBranch(app, "task/next")
    expect(await app.line.integrate({ submission: next.id }, runtime)).toMatchObject({ status: "passed" })

    const effectRun = (await app.state()).effects.runs[waitingStep.effectId]
    if (effectRun === undefined) throw new Error("waiting effect was not projected")
    await app.command(app.commands.effect.transition, {
      type: "finish",
      id: effectRun.id,
      attempt: effectRun.attempt,
      token: waitingStep.token,
      outcome: { status: "passed", output: { checked: true } },
    })
    expect(await app.line.run(waiting.id, runtime)).toMatchObject({ status: "passed" })
    const mergesBeforeStaleRun = merges

    const stale = await submitBranch(app, "task/stale")
    const staleRun = await app.line.integrate({ submission: stale.id }, runtime)
    const staleStep = staleRun.steps[0]
    if (staleStep?.status !== "waiting") throw new Error("stale check did not park")
    const staleEffect = (await app.state()).effects.runs[staleStep.effectId]
    if (staleEffect === undefined) throw new Error("stale effect was not projected")
    await app.command(app.commands.bay.intake, { branch: stale.branch, headSha: UPDATED, base: "main" })
    await app.command(app.commands.effect.transition, {
      type: "finish",
      id: staleEffect.id,
      attempt: staleEffect.attempt,
      token: staleStep.token,
      outcome: { status: "passed", output: { checked: true } },
    })

    expect(await app.line.run(staleRun.id, runtime)).toMatchObject({
      status: "failed",
      error: { code: "stale-submission" },
    })
    expect(merges).toBe(mergesBeforeStaleRun)
    expect((await app.state()).bays.submissions[stale.id]).toMatchObject({
      revision: 2,
      headSha: UPDATED,
      status: "pushed",
    })
  })

  it("recursively bisects a red batch and rejects only the isolated submission", async () => {
    const checked: string[][] = []
    const app = createLineApp({
      batch: 4,
      check: (input) => {
        const submissions = input.submissions.map((submission) => submission.id)
        checked.push(submissions)
        return submissions.includes("PR3")
          ? { status: "failed", error: { code: "check-failed", message: "bad submission" } }
          : { status: "passed", output: { checked: true } }
      },
    })
    await submitBranch(app, "task/one")
    await submitBranch(app, "task/two")
    await submitBranch(app, "task/bad")
    await submitBranch(app, "task/four")

    const runs = await app.line.integrate({ submissions: [] }, runtime)

    expect(checked).toEqual([["PR1", "PR2", "PR3", "PR4"], ["PR1", "PR2"], ["PR3", "PR4"], ["PR3"], ["PR4"]])
    expect(runs.map((run) => [run.submissions.map((submission) => submission.id), run.status])).toEqual([
      [["PR1", "PR2", "PR3", "PR4"], "failed"],
      [["PR1", "PR2"], "passed"],
      [["PR3", "PR4"], "failed"],
      [["PR3"], "failed"],
      [["PR4"], "passed"],
    ])
    expect(
      Object.fromEntries(
        Object.values((await app.state()).bays.submissions).map((submission) => [submission.id, submission.status]),
      ),
    ).toEqual({ PR1: "integrated", PR2: "integrated", PR3: "rejected", PR4: "integrated" })
  })
})
