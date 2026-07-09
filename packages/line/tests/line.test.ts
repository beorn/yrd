import { describe, expect, it } from "vitest"
import { createMemoryEventStore, createYrd, pipe, withEffects, type EffectOutcome } from "@yrd/core"
import { withBays, type BayWorkspaceAdapter } from "@yrd/bay"
import {
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
    deprovision() {
      return { status: "passed", output: {} }
    },
  }
}

function createLineApp(
  options: {
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
