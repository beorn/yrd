import { describe, expect, it } from "vitest"
import {
  resolveSubmission,
  type BayWorkspaceAdapter,
  type DeprovisionedBay,
  type ProvisionedBay,
  type RefreshedBay,
} from "@yrd/bay"
import {
  createMemoryEventStore,
  createYrd,
  pipe,
  withEffects,
  type Command,
  type EffectOutcome,
  type YrdEventStore,
} from "@yrd/core"
import { withTasks } from "@yrd/task"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorAdapter,
  type ContestGitAdapter,
  type ContestRunnerAdapter,
} from "../src/index.ts"
import { withBays } from "@yrd/bay"

const BASE_SHA = "a".repeat(40)
const CODEX_SHA = "1".repeat(40)
const CLAUDE_SHA = "2".repeat(40)

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function workspace(): BayWorkspaceAdapter {
  return {
    provision(input): EffectOutcome<ProvisionedBay> {
      if (input.baseSha !== BASE_SHA) {
        return { status: "failed", error: { code: "wrong-base", message: "contest Bay was not pinned" } }
      }
      if (input.from !== undefined) {
        return {
          status: "failed",
          error: { code: "missing-source-branch", message: `test repo has no existing branch '${input.from}'` },
        }
      }
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA },
      }
    },
    refresh(input): EffectOutcome<RefreshedBay> {
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA, dirty: false },
      }
    },
    deprovision(): EffectOutcome<DeprovisionedBay> {
      return { status: "passed", output: {} }
    },
  }
}

function outputFor(attempt: string, model: string, bay: string, branch: string): AttemptRunOutput {
  const commit = model === "codex" ? CODEX_SHA : CLAUDE_SHA
  return {
    pin: { commit, ref: `refs/yrd/attempts/${attempt}`, bay, branch },
    wallTimeMs: model === "codex" ? 12_000 : 15_000,
    tokens: {
      input: 1_000,
      output: 400,
      cachedInput: 700,
      cacheWrite: 20,
      reasoning: model === "codex" ? 80 : 120,
    },
    cost:
      model === "codex"
        ? { kind: "reported", usd: 0.42, source: "ag" }
        : { kind: "missing", reason: "provider omitted cost" },
    artifacts: [
      { kind: "log", uri: `artifact://runs/${attempt}/trace.json`, digest: `sha256:${attempt}` },
      { kind: "patch", uri: `git:${commit}` },
    ],
  }
}

function fixtures(options: { waitingModel?: string } = {}) {
  const pins = new Map<string, string>()
  pins.set("main", BASE_SHA)
  const runner: ContestRunnerAdapter = {
    harness: "ag",
    async run(input) {
      if (input.competitor.model === options.waitingModel) {
        return {
          status: "waiting",
          token: `remote-${input.attempt}`,
          url: `https://runner.invalid/${input.attempt}`,
          detail: "runner capacity pending",
          artifacts: [{ kind: "queue-log", uri: `artifact://runs/${input.attempt}/queue.json` }],
        }
      }
      const output = outputFor(input.attempt, input.competitor.model, input.bay.id, input.bay.branch)
      pins.set(output.pin.ref, output.pin.commit)
      return { status: "passed", output }
    },
  }
  const heldOut: ContestEvaluatorAdapter = {
    id: "held-out-tests",
    authority: "held-out",
    async evaluate(input) {
      return {
        status: "passed",
        output: {
          verdict: "passed",
          summary: `${input.pin.commit.slice(0, 7)} passed private acceptance tests`,
          artifacts: [{ kind: "test-report", uri: `artifact://evals/${input.attempt}/junit.xml` }],
          scores: { tests: 1 },
        },
      }
    },
  }
  const advisory: ContestEvaluatorAdapter = {
    id: "review-notes",
    authority: "advisory",
    async evaluate(input) {
      return {
        status: "passed",
        output: {
          verdict: input.competitor.model === "claude" ? "failed" : "passed",
          summary: "advisory review only",
          artifacts: [],
        },
      }
    },
  }
  const git: ContestGitAdapter = {
    resolveCommit(ref) {
      return pins.get(ref)
    },
  }
  return { pins, runner, heldOut, advisory, git }
}

function createApp(store: YrdEventStore, setup = fixtures()) {
  return pipe(
    createYrd({ store, clock: () => "2026-07-09T12:00:00.000Z", idGen: ids() }),
    withEffects(),
    withTasks(),
    withBays({ workspace: workspace(), defaultBase: "main" }),
    withContests({ runners: [setup.runner], evaluators: [setup.heldOut, setup.advisory], git: setup.git }),
  )
}

async function recordTask(app: ReturnType<typeof createApp>): Promise<void> {
  await app.tasks.record({
    ref: { source: "km", id: "@yrd/core/21012" },
    title: "Finish Yrd",
    description: "Implement and verify the final orchestration system",
    revision: "r7",
  })
}

async function startContest(app: ReturnType<typeof createApp>) {
  await recordTask(app)
  const base = await app.contests.resolveBase("main")
  await app.command(app.commands.task.compete, {
    task: { source: "km", id: "@yrd/core/21012" },
    competitors: [
      { model: "codex", harness: "ag", config: { effort: "max", routing: { tier: "apex" } } },
      { model: "claude", harness: "ag", config: { effort: "max", routing: { tier: "frontier" } } },
    ],
    evaluators: ["held-out-tests", "review-notes"],
    base: base.base,
    baseSha: base.sha,
  })
  return await app.contests.show("C1")
}

async function runWork(app: ReturnType<typeof createApp>, kind: string): Promise<void> {
  const work = await app.contestEffects.reconcile("C1")
  for (const item of work.filter((candidate) => candidate.kind === kind && candidate.status === "requested")) {
    await app.effectRuns.run(item.effect, { executor: "test", leaseMs: 60_000, now: () => 0 })
  }
}

async function finishAttempts(app: ReturnType<typeof createApp>): Promise<void> {
  await runWork(app, "bay")
  await runWork(app, "runner")
  await runWork(app, "evaluator")
}

describe("withContests", () => {
  it("records real-task competitors, immutable attempt evidence, and held-out results without auto-selecting", async () => {
    const store = createMemoryEventStore()
    const app = createApp(store)
    const opened = await startContest(app)

    expect(opened.task).toMatchObject({ ref: { source: "km", id: "@yrd/core/21012" }, revision: "r7" })
    expect(opened).toMatchObject({ base: "main", baseSha: BASE_SHA })
    expect(opened.attemptOrder).toEqual(["A1", "A2"])
    expect(opened.attempts.A1?.competitor).toMatchObject({ model: "codex", harness: "ag" })
    expect(opened.attempts.A1?.competitor.id).not.toBe(opened.attempts.A2?.competitor.id)
    expect(opened.selection).toBeUndefined()

    await finishAttempts(app)
    const contest = await app.contests.show("C1")
    expect(contest.status).toBe("ready")
    expect(contest.selection).toBeUndefined()
    expect(contest.attempts.A1).toMatchObject({
      status: "passing",
      pin: { commit: CODEX_SHA, ref: "refs/yrd/attempts/A1", bay: "B1", branch: "task/contest-c1-a1" },
      wallTimeMs: 12_000,
      tokens: { cachedInput: 700, cacheWrite: 20, reasoning: 80 },
      cost: { kind: "reported", usd: 0.42, source: "ag" },
    })
    expect(contest.attempts.A2).toMatchObject({
      status: "passing",
      cost: { kind: "missing", reason: "provider omitted cost" },
      evaluations: {
        "held-out-tests": { result: { verdict: "passed" } },
        "review-notes": { result: { verdict: "failed" } },
      },
    })

    const eventCount = await Array.fromAsync(app.events()).then((events) => events.length)
    expect(await app.contests.show("C1")).toEqual(contest)
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(eventCount)
    expect("show" in app.commands.contest).toBe(false)
    expect(
      app.commandRegistry
        .entries()
        .filter(({ command }) => command.visibility === "public")
        .map(({ path }) => path.join("."))
        .filter((path) => path === "task.compete" || path.startsWith("contest.")),
    ).toEqual(["task.compete", "contest.select", "contest.promote"])

    const replay = createApp(store, fixtures())
    expect(await replay.contests.show("C1")).toEqual(contest)
  })

  it("selects manually and promotes only the exact verified pin through Bay", async () => {
    const setup = fixtures()
    const app = createApp(createMemoryEventStore(), setup)
    await startContest(app)
    await finishAttempts(app)

    await expect(app.command(app.commands.contest.promote, { contest: "C1" })).rejects.toThrow("no selected attempt")
    await app.command(app.commands.contest.select, {
      contest: "C1",
      attempt: "A2",
      selectedBy: "human:beorn",
      reason: "best implementation after review",
    })
    const selected = await app.contests.show("C1")
    expect(selected.selection).toEqual({
      attempt: "A2",
      method: "manual",
      selectedBy: "human:beorn",
      reason: "best implementation after review",
      selectedAt: "2026-07-09T12:00:00.000Z",
    })

    const requested = await app.command(app.commands.contest.promote, { contest: "C1" })
    expect(requested.effectIds).toHaveLength(1)
    await app.effectRuns.run(requested.effectIds[0]!, { executor: "test", leaseMs: 60_000 })

    const promoted = await app.contests.show("C1")
    expect(promoted.status).toBe("promoted")
    expect(promoted.promotion).toMatchObject({
      status: "passed",
      attempt: "A2",
      commit: CLAUDE_SHA,
      output: { commit: CLAUDE_SHA, submission: "PR1", revision: 1 },
    })
    const bayState = (await app.state()).bays
    expect(resolveSubmission(bayState, "PR1")).toMatchObject({
      bay: "B2",
      branch: "task/contest-c1-a2",
      headSha: CLAUDE_SHA,
      status: "submitted",
    })

    const moved = createApp(createMemoryEventStore(), setup)
    await startContest(moved)
    await finishAttempts(moved)
    await moved.command(moved.commands.contest.select, { contest: "C1", attempt: "A2" })
    setup.pins.set("refs/yrd/attempts/A2", CODEX_SHA)
    const stale = await moved.command(moved.commands.contest.promote, { contest: "C1" })
    await moved.effectRuns.run(stale.effectIds[0]!, { executor: "test", leaseMs: 60_000 })
    expect((await moved.contests.show("C1")).promotion).toMatchObject({
      status: "failed",
      error: { code: "pin-moved" },
    })
  })

  it("retains waiting and crash recovery evidence across effect attempts", async () => {
    const setup = fixtures({ waitingModel: "claude" })
    const app = createApp(createMemoryEventStore(), setup)
    await startContest(app)
    await runWork(app, "bay")
    await runWork(app, "runner")

    let contest = await app.contests.show("C1")
    expect(contest.attempts.A2).toMatchObject({
      status: "waiting",
      runner: {
        status: "waiting",
        attempt: 1,
        token: "remote-A2",
        url: "https://runner.invalid/A2",
        detail: "runner capacity pending",
        artifacts: [{ kind: "queue-log", uri: "artifact://runs/A2/queue.json" }],
      },
    })
    const runner = (await app.contestEffects.reconcile("C1")).find(
      (work) => work.kind === "runner" && work.attempt === "A2",
    )!
    const remoteOutput = outputFor("A2", "claude", "B2", "task/contest-c1-a2")
    setup.pins.set(remoteOutput.pin.ref, remoteOutput.pin.commit)
    await app.command(app.commands.effect.finish, {
      id: runner.effect,
      attempt: 1,
      token: "remote-A2",
      outcome: { status: "passed", output: remoteOutput },
    })

    const evaluations = await app.contestEffects.reconcile("C1")
    const crashed = evaluations.find(
      (work) => work.kind === "evaluator" && work.attempt === "A2" && work.evaluator === "held-out-tests",
    )!
    await app.command(app.commands.effect.start, {
      id: crashed.effect,
      executor: "dead-runner",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })
    expect(await app.effectRuns.recover({ now: "2026-01-01T00:00:02.000Z" })).toContain(crashed.effect)
    contest = await app.contests.show("C1")
    expect(contest.attempts.A2?.evaluations["held-out-tests"]).toMatchObject({
      status: "lost",
      attempt: 1,
      error: { code: "effect-lost" },
    })

    await app.command(app.commands.effect.retry, { id: crashed.effect })
    await app.effectRuns.run(crashed.effect, { executor: "replacement", leaseMs: 60_000 })
    expect((await app.contests.show("C1")).attempts.A2?.evaluations["held-out-tests"]).toMatchObject({
      status: "passed",
      attempt: 2,
      result: { verdict: "passed" },
      history: [
        { attempt: 1, status: "lost", error: { code: "effect-lost" } },
        { attempt: 2, status: "passed" },
      ],
    })
  })

  it("retries promotion after a post-intake crash without creating another Bay revision", async () => {
    const app = createApp(createMemoryEventStore())
    await startContest(app)
    await finishAttempts(app)
    await app.command(app.commands.contest.select, { contest: "C1", attempt: "A1" })
    const requested = await app.command(app.commands.contest.promote, { contest: "C1" })
    const promotion = requested.effectIds[0]!

    const command = app.command
    let crash = true
    app.command = async <Args>(
      ref: Command<Args, any>,
      args: Args,
      options?: { traceId?: string; spanId?: string },
    ) => {
      const result = await command(ref, args, options)
      if (crash && Object.is(ref, app.commands.bay.intake)) {
        crash = false
        throw new Error("executor crashed after durable intake")
      }
      return result
    }

    await app.effectRuns.run(promotion, { executor: "crashing-host", leaseMs: 60_000 })
    expect((await app.contests.show("C1")).promotion).toMatchObject({
      status: "failed",
      error: { code: "promotion-error", message: "executor crashed after durable intake" },
    })
    expect((await app.state()).bays.submissions.PR1).toMatchObject({ revision: 1, status: "pushed", headSha: CODEX_SHA })

    app.command = command
    await app.command(app.commands.effect.retry, { id: promotion })
    await app.effectRuns.run(promotion, { executor: "replacement", leaseMs: 60_000 })
    expect((await app.contests.show("C1")).promotion).toMatchObject({ status: "passed", attemptNumber: 2 })
    expect((await app.state()).bays.submissions.PR1).toMatchObject({
      revision: 1,
      status: "submitted",
      headSha: CODEX_SHA,
    })
  })

  it("rejects missing tasks, duplicate identities, unselected, non-passing, and unpinned promotion", async () => {
    const app = createApp(createMemoryEventStore())
    const args = {
      task: { source: "km", id: "missing" },
      competitors: [
        { model: "codex", harness: "ag", config: { a: 1, b: 2 } },
        { model: "codex", harness: "ag", config: { b: 2, a: 1 } },
      ],
      evaluators: ["held-out-tests"],
      base: "main",
      baseSha: BASE_SHA,
    }
    await expect(app.command(app.commands.task.compete, args)).rejects.toThrow("task 'km:missing' is not recorded")
    await recordTask(app)
    await expect(
      app.command(app.commands.task.compete, { ...args, task: { source: "km", id: "@yrd/core/21012" } }),
    ).rejects.toThrow("duplicate competitor identity")

    const rejectedSetup = fixtures()
    const rejectedEvaluator: ContestEvaluatorAdapter = {
      ...rejectedSetup.heldOut,
      evaluate() {
        return { status: "passed", output: { verdict: "failed", summary: "held-out regression", artifacts: [] } }
      },
    }
    const rejected = createApp(createMemoryEventStore(), { ...rejectedSetup, heldOut: rejectedEvaluator })
    await startContest(rejected)
    await finishAttempts(rejected)
    await rejected.command(rejected.commands.contest.select, { contest: "C1", attempt: "A1" })
    await expect(rejected.command(rejected.commands.contest.promote, { contest: "C1" })).rejects.toThrow(
      "is rejected, not passing",
    )

    const unpinnedSetup = fixtures()
    const failedRunner: ContestRunnerAdapter = {
      ...unpinnedSetup.runner,
      run() {
        return { status: "failed", error: { code: "agent-failed", message: "agent produced no commit" } }
      },
    }
    const unpinned = createApp(createMemoryEventStore(), { ...unpinnedSetup, runner: failedRunner })
    await startContest(unpinned)
    await runWork(unpinned, "bay")
    await runWork(unpinned, "runner")
    await unpinned.command(unpinned.commands.contest.select, { contest: "C1", attempt: "A1" })
    await expect(unpinned.command(unpinned.commands.contest.promote, { contest: "C1" })).rejects.toThrow(
      "has no immutable Git pin",
    )
  })

  it("enforces effects, tasks, and Bays before contests in plugin composition", () => {
    const setup = fixtures()
    const bare = createYrd({ store: createMemoryEventStore() })
    const install = withContests({
      runners: [setup.runner],
      evaluators: [setup.heldOut],
      git: setup.git,
    })
    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error contests require durable effects, tasks, and Bays first
      install(bare)
    })
    install(pipe(bare, withEffects(), withTasks(), withBays({ workspace: workspace() })))
  })
})
