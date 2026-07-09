import { describe, expect, it } from "vitest"
import { createMemoryEventStore, createYrd, pipe, withEffects, type EffectOutcome } from "@yrd/core"
import { withBays, type BayWorkspaceAdapter } from "@yrd/bay"
import {
  withBatch,
  withDefaultSteps,
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type IntegratedShape,
  type StepExecution,
  type SubmissionShape,
} from "@yrd/line"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const UPDATED = "3".repeat(40)

type CheckResult = { checked: true }
type CheckedShape = AddStepResult<SubmissionShape, "check", CheckResult>
type MergedShape = IntegratedShape

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function workspace(): BayWorkspaceAdapter {
  return {
    provision(input) {
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
      }
    },
    refresh(input) {
      return {
        status: "passed",
        output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
      }
    },
    deprovision() {
      return { status: "passed", output: {} }
    },
  }
}

function createLineApp(
  options: {
    batch?: false | number
    defaultSteps?: readonly string[]
    check?: (input: StepExecution<SubmissionShape>) => EffectOutcome<CheckResult>
    merge?: (input: StepExecution<CheckedShape>) => EffectOutcome<{ commit: string; baseSha: string }>
    deploy?: (input: StepExecution<MergedShape>) => EffectOutcome<{ environment: string }>
  } = {},
) {
  return pipe(
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
    withMerge(
      (input: StepExecution<CheckedShape>): EffectOutcome<{ commit: string; baseSha: string }> =>
        options.merge?.(input) ?? {
          status: "passed",
          output: { commit: MERGED, baseSha: MERGED },
        },
    ),
    withStep(
      "deploy",
      (input: StepExecution<MergedShape>): EffectOutcome<{ environment: string }> =>
        options.deploy?.(input) ?? {
          status: "passed",
          output: { environment: "staging" },
        },
      { needsIntegration: true },
    ),
    withDefaultSteps(options.defaultSteps ?? ["check", "merge", "deploy"]),
  )
}

async function submitBranch(app: ReturnType<typeof createLineApp>, branch = "task/one", base = "main") {
  await app.command(app.commands.bay.submit, { branch, headSha: HEAD, base })
  const submission = Object.values((await app.state()).bays.submissions).find((item) => item.branch === branch)
  if (submission === undefined) throw new Error("submission was not recorded")
  return submission
}

const runOptions = { executor: "local", leaseMs: 60_000 }

describe("withLine", () => {
  it.each([
    [false, 1],
    [0, 1],
    [1, 1],
    [4, 4],
  ] as const)("normalizes batch setting %s to max size %i", async (batch, expected) => {
    expect((await createLineApp({ batch }).state()).lines.batchSize).toBe(expected)
  })

  it("rejects a non-integer batch size", () => {
    expect(() => createLineApp({ batch: 1.5 })).toThrow("batch size must be false or a non-negative integer")
  })

  it("projects a validated default step sequence into state and uses it when --steps is omitted", async () => {
    const app = createLineApp({ defaultSteps: ["check", "merge"] })
    const submission = await submitBranch(app)

    expect((await app.state()).lines.defaultSteps).toEqual(["check", "merge"])
    expect((await app.line.integrate({ submission: submission.id }, runOptions)).steps.map((step) => step.name)).toEqual([
      "check",
      "merge",
    ])
    expect(() => createLineApp({ defaultSteps: ["missing"] })).toThrow("unknown default line step 'missing'")
  })

  it("registers typed steps in state and integrates the exact pinned revision", async () => {
    const app = createLineApp()
    const submission = await submitBranch(app)

    expect((await app.state()).lines.installed).toEqual({
      check: { name: "check", title: "check", index: 0, kind: "step", needsIntegration: false },
      merge: { name: "merge", title: "merge", index: 1, kind: "merge", needsIntegration: false },
      deploy: { name: "deploy", title: "deploy", index: 2, kind: "step", needsIntegration: true },
    })
    expect(app.operation(app.commands.line.integrate, { submission: submission.id })).toEqual({
      op: "line.integrate",
      args: { submission: submission.id },
    })
    expect(
      app.commandRegistry
        .entries()
        .filter((entry) => entry.path[0] === "line")
        .map((entry) => [entry.path.join("."), entry.command.visibility]),
    ).toEqual([
      ["line.integrate", "public"],
      ["line.advance", "internal"],
      ["line.resume", "internal"],
      ["line.isolate", "internal"],
    ])

    const run = await app.line.integrate({ submission: submission.id }, runOptions)
    expect(run.status).toBe("passed")
    expect(run.steps.map((step) => [step.name, step.status])).toEqual([
      ["check", "passed"],
      ["merge", "passed"],
      ["deploy", "passed"],
    ])
    expect(run.shape).toMatchObject({
      submission: { id: submission.id, revision: 1, headSha: HEAD },
      results: { check: { checked: true }, deploy: { environment: "staging" } },
      integration: { commit: MERGED, baseSha: MERGED },
    })
    expect((await app.state()).bays.submissions[submission.id]).toMatchObject({
      status: "integrated",
      revision: 1,
      headSha: HEAD,
      integration: { commit: MERGED, baseSha: MERGED },
    })

    const deployOnly = await app.line.integrate({ submission: submission.id, steps: ["deploy"] }, runOptions)
    expect(deployOnly.steps.map((step) => step.name)).toEqual(["deploy"])
    expect(deployOnly.status).toBe("passed")
  })

  it("rejects a red pre-merge step without invoking merge", async () => {
    let merged = false
    const app = createLineApp({
      check: () => ({ status: "failed", error: { code: "check-failed", message: "tests failed" } }),
      merge: () => {
        merged = true
        return { status: "passed", output: { commit: MERGED, baseSha: MERGED } }
      },
    })
    const submission = await submitBranch(app)

    const run = await app.line.integrate({ submission: submission.id }, runOptions)
    expect(run).toMatchObject({ status: "failed", error: { code: "check-failed" } })
    expect(merged).toBe(false)
    expect((await app.state()).bays.submissions[submission.id]).toMatchObject({ status: "rejected" })
  })

  it("parks remote work, releases the base line, and resumes from the durable effect", async () => {
    const app = createLineApp({
      check: (input) =>
        input.submission.branch === "task/one"
          ? {
              status: "waiting",
              token: "remote-1",
              url: "https://ci.invalid/1",
              detail: "queued on remote runner",
              artifacts: [{ kind: "queue-log", uri: "artifact://remote-1/queue" }],
            }
          : { status: "passed", output: { checked: true } },
    })
    const first = await submitBranch(app, "task/one")
    const waiting = await app.line.integrate({ submission: first.id }, runOptions)
    expect(waiting).toMatchObject({ status: "waiting" })
    expect(waiting.steps[0]).toMatchObject({
      status: "waiting",
      token: "remote-1",
      url: "https://ci.invalid/1",
      detail: "queued on remote runner",
      artifacts: [{ kind: "queue-log", uri: "artifact://remote-1/queue" }],
    })

    const second = await submitBranch(app, "task/two")
    expect(await app.line.integrate({ submission: second.id }, runOptions)).toMatchObject({ status: "passed" })

    const effectId = waiting.steps[0]!.effectId!
    const effectRun = (await app.state()).effects.runs[effectId]!
    await app.command(app.commands.effect.finish, {
      id: effectId,
      attempt: effectRun.attempt,
      token: "remote-1",
      outcome: { status: "passed", output: { checked: true } },
    })
    expect(await app.line.run(waiting.id, runOptions)).toMatchObject({ status: "passed" })
  })

  it("refuses to continue a parked run after its pinned submission revision changes", async () => {
    let merged = false
    const app = createLineApp({
      check: () => ({ status: "waiting", token: "remote-stale" }),
      merge: () => {
        merged = true
        return { status: "passed", output: { commit: MERGED, baseSha: MERGED } }
      },
    })
    const submission = await submitBranch(app, "task/stale")
    const waiting = await app.line.integrate({ submission: submission.id }, runOptions)
    const effectId = waiting.steps[0]!.effectId!
    const effectRun = (await app.state()).effects.runs[effectId]!

    await app.command(app.commands.bay.intake, { branch: submission.branch, headSha: UPDATED, base: "main" })
    await app.command(app.commands.effect.finish, {
      id: effectId,
      attempt: effectRun.attempt,
      token: "remote-stale",
      outcome: { status: "passed", output: { checked: true } },
    })

    expect(await app.line.run(waiting.id, runOptions)).toMatchObject({
      status: "failed",
      error: { code: "stale-submission" },
    })
    expect(merged).toBe(false)
    expect((await app.state()).bays.submissions[submission.id]).toMatchObject({
      revision: 2,
      headSha: UPDATED,
      status: "pushed",
    })
  })

  it("records a post-merge deploy failure without revoking integration", async () => {
    const app = createLineApp({
      deploy: () => ({ status: "failed", error: { code: "deploy-failed", message: "staging unavailable" } }),
    })
    const submission = await submitBranch(app)
    const run = await app.line.integrate({ submission: submission.id }, runOptions)

    expect(run).toMatchObject({ status: "failed", error: { code: "deploy-failed" } })
    expect((await app.state()).bays.submissions[submission.id]).toMatchObject({
      status: "integrated",
      integration: { commit: MERGED },
    })
  })

  it("runs an eligible all-pass batch once and integrates every pinned revision", async () => {
    const checked: string[][] = []
    const merged: string[][] = []
    const app = createLineApp({
      batch: 4,
      check: (input) => {
        checked.push(input.submissions.map((submission) => submission.id))
        return { status: "passed", output: { checked: true } }
      },
      merge: (input) => {
        merged.push(input.submissions.map((submission) => submission.id))
        return { status: "passed", output: { commit: MERGED, baseSha: MERGED } }
      },
    })
    const first = await submitBranch(app, "task/one")
    const second = await submitBranch(app, "task/two")
    const third = await submitBranch(app, "task/three")

    const runs = await app.line.integrate({ submissions: [] }, runOptions)

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: "passed",
      submissions: [
        { id: first.id, revision: 1, headSha: HEAD },
        { id: second.id, revision: 1, headSha: HEAD },
        { id: third.id, revision: 1, headSha: HEAD },
      ],
    })
    expect(checked).toEqual([[first.id, second.id, third.id]])
    expect(merged).toEqual([[first.id, second.id, third.id]])
    expect(Object.values((await app.state()).bays.submissions).map((submission) => submission.status)).toEqual([
      "integrated",
      "integrated",
      "integrated",
    ])
  })

  it("recursively bisects a red batch and rejects only the isolated failure", async () => {
    const checked: string[][] = []
    const app = createLineApp({
      batch: 4,
      check: (input) => {
        const ids = input.submissions.map((submission) => submission.id)
        checked.push(ids)
        return ids.includes("S3")
          ? { status: "failed", error: { code: "check-failed", message: "bad submission" } }
          : { status: "passed", output: { checked: true } }
      },
    })
    await submitBranch(app, "task/one")
    await submitBranch(app, "task/two")
    await submitBranch(app, "task/bad")
    await submitBranch(app, "task/four")

    const runs = await app.line.integrate({ submissions: [] }, runOptions)
    const submissions = (await app.state()).bays.submissions

    expect(checked).toEqual([["S1", "S2", "S3", "S4"], ["S1", "S2"], ["S3", "S4"], ["S3"], ["S4"]])
    expect(runs.map((run) => [run.submissions.map((submission) => submission.id), run.status])).toEqual([
      [["S1", "S2", "S3", "S4"], "failed"],
      [["S1", "S2"], "passed"],
      [["S3", "S4"], "failed"],
      [["S3"], "failed"],
      [["S4"], "passed"],
    ])
    expect(
      Object.fromEntries(Object.values(submissions).map((submission) => [submission.id, submission.status])),
    ).toEqual({
      S1: "integrated",
      S2: "integrated",
      S3: "rejected",
      S4: "integrated",
    })
  })

  it("does not bisect a post-merge batch failure or revoke any integration", async () => {
    const app = createLineApp({
      batch: 4,
      deploy: () => ({ status: "failed", error: { code: "deploy-failed", message: "staging unavailable" } }),
    })
    const first = await submitBranch(app, "task/one")
    const second = await submitBranch(app, "task/two")

    const runs = await app.line.integrate({ submissions: [first.id, second.id] }, runOptions)

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "failed", error: { code: "deploy-failed" } })
    expect((await app.state()).bays.submissions).toMatchObject({
      [first.id]: { status: "integrated", integration: { commit: MERGED } },
      [second.id]: { status: "integrated", integration: { commit: MERGED } },
    })
  })

  it("uses TypeScript state shapes to reject a post-integration step before merge", () => {
    const base = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: workspace() }),
      withLine(),
    )
    const deploy = withStep(
      "deploy",
      (_input: StepExecution<IntegratedShape>) => ({ status: "passed" as const, output: { environment: "test" } }),
      { needsIntegration: true },
    )
    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error deploy's input requires withMerge output
      deploy(base)
    })
  })
})
