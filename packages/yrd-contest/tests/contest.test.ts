/**
 * @failure contest lifecycle diverges from durable Jobs
 * @level l3
 * @consumer @yrd/contest orchestration
 */
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { withTasks } from "@yrd/task"
import { describe, expect, it } from "vitest"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "../src/index.ts"

const BASE_SHA = "a".repeat(40)
const CODEX_SHA = "1".repeat(40)
const CLAUDE_SHA = "2".repeat(40)
const runtime = { executor: "test", leaseMs: 60_000, concurrency: 1 }

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
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
  const runner: ContestRunnerDef = {
    harness: "ag",
    revision: "ag-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
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
  const heldOut: ContestEvaluatorDef = {
    id: "held-out",
    revision: "held-out-v1",
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
  const advisory: ContestEvaluatorDef = {
    id: "review",
    revision: "review-v1",
    authority: "advisory",
    evaluate(input) {
      return { status: "passed", output: { verdict: input.attempt === "A2" ? "failed" : "passed", artifacts: [] } }
    },
  }
  const git: ContestGit = { revision: "git-v1", resolveCommit: (ref) => pins.get(ref) }
  return { pins, control, runner, heldOut, advisory, git, maxActive: () => maxActive }
}

async function createApp(journal: Journal<unknown>, setup = fixtures()) {
  const bayJobs = createBayJobDefs(workspace())
  const contests = withContests({
    runners: [setup.runner],
    evaluators: [setup.heldOut, setup.advisory],
    git: setup.git,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, contests.jobDefs] }),
    withTasks({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Finish Yrd", revision: "r7" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main" }),
  )
  return createYrd(contests(base), {
    inject: { journal, clock: () => "2026-07-09T12:00:00.000Z", id: ids() },
  })
}

async function startContest(app: Awaited<ReturnType<typeof createApp>>): Promise<void> {
  const task = await app.tasks.resolve({ source: "km", id: "@yrd/core/21012" })
  const base = await app.contests.resolveBase()
  await app.contests.compete({
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

describe("Contests", () => {
  it("composes immutable definitions and derives a bounded run, exact promotion, and replay", async () => {
    const journal = createMemoryJournal()
    const setup = fixtures()
    const app = await createApp(journal, setup)
    await startContest(app)

    const ready = await app.contests.run("C1", runtime)
    expect(setup.maxActive()).toBe(1)
    expect(ready).toMatchObject({ id: "C1", status: "ready", attemptOrder: ["A1", "A2"] })
    expect(ready.attempts.A1).toMatchObject({
      status: "passing",
      runner: { status: "passed" },
      pin: { commit: CODEX_SHA, bay: "B1" },
      wallTimeMs: 12_000,
      evaluations: { "held-out": { job: { status: "passed" }, result: { verdict: "passed" } } },
    })
    expect(ready.attempts.A2).toMatchObject({
      status: "passing",
      evaluations: { review: { job: { status: "passed" }, result: { verdict: "failed" } } },
    })

    const durable = app.state().contests.records.C1!
    expect(durable).not.toHaveProperty("status")
    expect(durable.attempts.A1).not.toHaveProperty("bay")
    expect(durable.attempts.A1).not.toHaveProperty("runner")
    expect(durable.attempts.A1).not.toHaveProperty("pin")
    expect(app.state().jobs.byKey["contest:C1:attempt:A1:runner"]).toBe(ready.attempts.A1?.runner?.id)

    await app.contests.select({ contest: "C1", attempt: "A2", selectedBy: "human" })
    const promoted = await app.contests.promote({ contest: "C1" }, runtime)
    expect(promoted).toMatchObject({
      status: "promoted",
      selection: { attempt: "A2", method: "manual" },
      promotion: {
        attempt: "A2",
        commit: CLAUDE_SHA,
        job: { status: "passed" },
        pr: { id: "PR1", status: "submitted", headSha: CLAUDE_SHA },
      },
    })
    expect(app.bays.pr("PR1")).toMatchObject({ bay: "B2", headSha: CLAUDE_SHA, status: "submitted" })
    expect(app.state().contests.records.C1?.promotion).not.toHaveProperty("status")
    expect(app.state().contests.records.C1?.promotion).not.toHaveProperty("job")

    const eventCount = await Array.fromAsync(app.events()).then((events) => events.length)
    expect(app.contests.list()).toEqual([promoted])
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(eventCount)
    await app.close()

    await using replay = await createApp(journal)
    expect(replay.contests.get("C1")).toEqual(promoted)
  })

  it("refuses promotion when the write-once attempt ref no longer resolves to its pin", async () => {
    const setup = fixtures()
    await using app = await createApp(createMemoryJournal(), setup)
    await startContest(app)
    await app.contests.run("C1", runtime)
    await app.contests.select({ contest: "C1", attempt: "A1" })
    await app.command(app.commands.contest.promote, { contest: "C1" })
    setup.pins.set("refs/yrd/attempts/C1/A1", CLAUDE_SHA)

    expect(await app.contests.run("C1", runtime)).toMatchObject({
      status: "promotion-failed",
      promotion: { job: { status: "failed", error: { code: "pin-moved" } } },
    })
    expect(app.bays.prs()).toEqual([])
  })

  it("keeps waiting and retry authority on one durable Job", async () => {
    const setup = fixtures({ waitingRunner: "claude", waitingEvaluator: true })
    await using app = await createApp(createMemoryJournal(), setup)
    await startContest(app)
    expect(await app.contests.run("C1", runtime)).toMatchObject({
      attempts: { A2: { status: "waiting", runner: { status: "waiting", attempt: 1, token: "remote-A2" } } },
    })

    const runner = app.contests.get("C1")?.attempts.A2?.runner
    if (runner?.status !== "waiting") throw new Error("runner did not remain waiting")
    const output = outputFor("A2", "claude", "B2", "task/contest-c1-a2")
    setup.pins.set(output.pin.ref, output.pin.commit)
    await app.jobs.finish(runner.id, {
      attempt: runner.attempt,
      executor: runner.executor,
      token: runner.token,
      result: { status: "passed", output },
    })
    expect(await app.contests.run("C1", runtime)).toMatchObject({
      attempts: { A2: { status: "waiting", evaluations: { "held-out": { job: { status: "waiting", attempt: 1 } } } } },
    })

    const evaluation = app.contests.get("C1")?.attempts.A2?.evaluations["held-out"]?.job
    if (evaluation?.status !== "waiting") throw new Error("evaluation did not remain waiting")
    expect(await app.jobs.recover({ now: "1970-01-01T00:01:01.000Z" })).toEqual([])
    await app.jobs.finish(evaluation.id, {
      attempt: evaluation.attempt,
      executor: evaluation.executor,
      token: evaluation.token,
      result: { status: "failed", error: { code: "remote-timeout", message: "remote evaluator timed out" } },
    })
    expect(app.contests.get("C1")).toMatchObject({
      attempts: { A2: { status: "failed", evaluations: { "held-out": { job: { status: "failed", attempt: 1 } } } } },
    })

    setup.control.waitingEvaluator = false
    await app.jobs.retry(evaluation.id)
    const retried = await app.contests.run("C1", runtime)
    expect(retried.attempts.A2).toMatchObject({
      status: "passing",
      evaluations: { "held-out": { job: { id: evaluation.id, status: "passed", attempt: 2 } } },
    })
  })
})
