/**
 * @failure contest lifecycle diverges from durable EffectRuns
 * @level l3
 * @consumer @yrd/contest orchestration
 */
import { resolveSubmission, withBays, type BayWorkspaceAdapter } from "@yrd/bay"
import { createMemoryEventStore, createYrd, pipe, withEffects, type EffectOutcome, type YrdEventStore } from "@yrd/core"
import { withTasks } from "@yrd/task"
import { describe, expect, it } from "vitest"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorAdapter,
  type ContestGitAdapter,
  type ContestRunnerAdapter,
} from "../src/index.ts"

const BASE_SHA = "a".repeat(40)
const CODEX_SHA = "1".repeat(40)
const CLAUDE_SHA = "2".repeat(40)
const runtime = { executor: "test", leaseMs: 60_000, concurrency: 1, now: () => 0 }

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function workspace(): BayWorkspaceAdapter {
  return {
    provision(input) {
      if (input.baseSha !== BASE_SHA) {
        return { status: "failed", error: { code: "wrong-base", message: "contest Bay was not pinned" } }
      }
      return { status: "passed", output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA } }
    },
    refresh(input) {
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA, dirty: false },
      }
    },
    deprovision() {
      return { status: "passed", output: {} }
    },
  }
}

function outputFor(attempt: string, model: string, bay: string, branch: string): AttemptRunOutput {
  const commit = model === "codex" ? CODEX_SHA : CLAUDE_SHA
  return {
    pin: { commit, ref: `refs/yrd/attempts/C1/${attempt}`, bay, branch, baseSha: BASE_SHA },
    wallTimeMs: model === "codex" ? 12_000 : 15_000,
    tokens: { input: 1_000, output: 400, cachedInput: 700, cacheWrite: 20, reasoning: 80 },
    cost: model === "codex" ? { kind: "reported", usd: 0.42, source: "ag" } : { kind: "missing", reason: "omitted" },
    artifacts: [{ kind: "patch", uri: `git:${commit}` }],
  }
}

function fixtures(options: { waitingRunner?: string; waitingEvaluator?: boolean } = {}) {
  const pins = new Map<string, string>([["main", BASE_SHA]])
  const control = { waitingEvaluator: options.waitingEvaluator ?? false }
  let active = 0
  let maxActive = 0
  const runner: ContestRunnerAdapter = {
    harness: "ag",
    async run(input): Promise<EffectOutcome<AttemptRunOutput>> {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      try {
        if (input.competitor.model === options.waitingRunner) {
          return { status: "waiting", token: `remote-${input.attempt}`, detail: "capacity pending" }
        }
        const output = outputFor(input.attempt, input.competitor.model, input.bay.id, input.bay.branch)
        pins.set(output.pin.ref, output.pin.commit)
        return { status: "passed", output }
      } finally {
        active -= 1
      }
    },
  }
  const heldOut: ContestEvaluatorAdapter = {
    id: "held-out",
    authority: "held-out",
    evaluate(input) {
      if (control.waitingEvaluator && input.attempt === "A2") {
        return { status: "waiting", token: "eval-A2", artifacts: [{ kind: "queue", uri: "artifact://eval/A2" }] }
      }
      return {
        status: "passed",
        output: { verdict: "passed", summary: "private tests passed", artifacts: [], scores: { tests: 1 } },
      }
    },
  }
  const advisory: ContestEvaluatorAdapter = {
    id: "review",
    authority: "advisory",
    evaluate(input) {
      return { status: "passed", output: { verdict: input.attempt === "A2" ? "failed" : "passed", artifacts: [] } }
    },
  }
  const git: ContestGitAdapter = { resolveCommit: (ref) => pins.get(ref) }
  return { pins, control, runner, heldOut, advisory, git, maxActive: () => maxActive }
}

function createApp(store: YrdEventStore, setup = fixtures()) {
  return pipe(
    createYrd({ store, clock: () => "2026-07-09T12:00:00.000Z", idGen: ids() }),
    withEffects(),
    withTasks({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Finish Yrd", revision: "r7" }) }] }),
    withBays({ workspace: workspace(), defaultBase: "main" }),
    withContests({ runners: [setup.runner], evaluators: [setup.heldOut, setup.advisory], git: setup.git }),
  )
}

async function startContest(app: ReturnType<typeof createApp>): Promise<void> {
  const task = await app.tasks.resolve({ source: "km", id: "@yrd/core/21012" })
  const base = await app.contests.resolveBase()
  await app.command(app.commands.task.compete, {
    task,
    competitors: [
      { model: "codex", harness: "ag", config: { effort: "max" } },
      { model: "claude", harness: "ag", config: { effort: "max" } },
    ],
    evaluators: ["held-out", "review"],
    base: base.base,
    baseSha: base.sha,
  })
}

describe("withContests", () => {
  it("derives a bounded run, exact promotion, and replay from EffectsState and BaysState", async () => {
    const store = createMemoryEventStore()
    const setup = fixtures()
    const app = createApp(store, setup)
    await startContest(app)

    const ready = await app.contests.run("C1", runtime)
    expect(setup.maxActive()).toBe(1)
    expect(ready.attempts.A1?.runner.error).toBeUndefined()
    expect(ready.attempts.A1?.evaluations["held-out"]?.error).toBeUndefined()
    expect(ready).toMatchObject({ id: "C1", status: "ready", attemptOrder: ["A1", "A2"] })
    expect(ready.attempts.A1).toMatchObject({
      status: "passing",
      pin: { commit: CODEX_SHA, bay: "B1" },
      wallTimeMs: 12_000,
      evaluations: { "held-out": { result: { verdict: "passed" } } },
    })
    expect(ready.attempts.A2).toMatchObject({
      status: "passing",
      evaluations: { review: { result: { verdict: "failed" } } },
    })

    const durable = (await app.state()).contests.records.C1!
    expect(durable.attempts.A1).toMatchObject({
      bay: "B1",
      runnerEffect: expect.any(String),
      evaluationEffects: { "held-out": expect.any(String), review: expect.any(String) },
    })
    expect(durable).not.toHaveProperty("status")
    expect(durable.attempts.A1).not.toHaveProperty("runner")
    expect(durable.attempts.A1).not.toHaveProperty("pin")
    expect("contestEffects" in app).toBe(false)

    await app.command(app.commands.contest.select, { contest: "C1", attempt: "A2", selectedBy: "human" })
    await app.command(app.commands.contest.promote, { contest: "C1" })
    const promoted = await app.contests.run("C1", runtime)
    expect(promoted).toMatchObject({
      status: "promoted",
      selection: { attempt: "A2", method: "manual" },
      promotion: { attempt: "A2", status: "passed", output: { submission: "PR1", commit: CLAUDE_SHA } },
    })
    expect(resolveSubmission((await app.state()).bays, "PR1")).toMatchObject({
      bay: "B2",
      headSha: CLAUDE_SHA,
      status: "submitted",
    })
    expect((await app.state()).contests.records.C1?.promotion).not.toHaveProperty("status")

    const eventCount = await Array.fromAsync(app.events()).then((events) => events.length)
    expect(await app.contests.list()).toEqual([promoted])
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(eventCount)
    expect(await createApp(store).contests.show("C1")).toEqual(promoted)
  })

  it("refuses promotion when the write-once attempt ref no longer resolves to its pin", async () => {
    const setup = fixtures()
    const app = createApp(createMemoryEventStore(), setup)
    await startContest(app)
    await app.contests.run("C1", runtime)
    await app.command(app.commands.contest.select, { contest: "C1", attempt: "A1" })
    await app.command(app.commands.contest.promote, { contest: "C1" })
    setup.pins.set("refs/yrd/attempts/C1/A1", CLAUDE_SHA)

    expect(await app.contests.run("C1", runtime)).toMatchObject({
      status: "promotion-failed",
      promotion: { status: "failed", error: { code: "pin-moved" } },
    })
    expect(Object.keys((await app.state()).bays.submissions)).toEqual([])
  })

  it("keeps waiting, lost, and retry authority on one EffectRun", async () => {
    const setup = fixtures({ waitingRunner: "claude", waitingEvaluator: true })
    const app = createApp(createMemoryEventStore(), setup)
    await startContest(app)
    expect(await app.contests.run("C1", runtime)).toMatchObject({
      attempts: { A2: { status: "waiting", runner: { status: "waiting", run: { attempt: 1, token: "remote-A2" } } } },
    })

    const runner = (await app.state()).contests.records.C1!.attempts.A2!.runnerEffect!
    const output = outputFor("A2", "claude", "B2", "task/contest-c1-a2")
    setup.pins.set(output.pin.ref, output.pin.commit)
    await app.command(app.commands.effect.transition, {
      type: "finish",
      id: runner,
      attempt: 1,
      token: "remote-A2",
      outcome: { status: "passed", output },
    })
    expect(await app.contests.run("C1", runtime)).toMatchObject({
      attempts: { A2: { status: "waiting", evaluations: { "held-out": { status: "waiting", run: { attempt: 1 } } } } },
    })

    const evaluation = (await app.state()).contests.records.C1!.attempts.A2!.evaluationEffects["held-out"]!
    expect(await app.effectRuns.recover({ now: "1970-01-01T00:01:01.000Z" })).toEqual([evaluation])
    expect(await app.contests.show("C1")).toMatchObject({
      attempts: { A2: { status: "lost", evaluations: { "held-out": { status: "lost", run: { attempt: 1 } } } } },
    })

    setup.control.waitingEvaluator = false
    await app.command(app.commands.effect.transition, { type: "retry", id: evaluation })
    const retried = await app.contests.run("C1", runtime)
    expect(retried.attempts.A2).toMatchObject({
      status: "passing",
      evaluations: { "held-out": { effect: evaluation, status: "passed", run: { attempt: 2 } } },
    })
    expect((await app.state()).effects.runs[evaluation]).toMatchObject({ status: "passed", attempt: 2 })
  })
})
