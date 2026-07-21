/**
 * @failure Queue composition or projection can accept corrupt runs, lose pinned plans, or misstate integration results.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, currentPRRev, prDeliveryState, withBays, type BayWorkspace, type PR } from "@yrd/bay"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { localRunner, withJobs, type JobResult, type Jobs, type Runner, type RunnerSubmission } from "@yrd/job"
import { defineConfig, selectFlow, yrd, type YrdConfig } from "@yrd/config"
import * as z from "zod"
import {
  withQueue,
  projectQueueStarted,
  withMerge,
  withStep,
  Queues,
  QueueRecordSchema,
  ReplayQueueRecordSchema,
  type AddStepResult,
  type IntegratedShape,
  type Queue,
  type QueueProjectionLookup,
  type QueueProjectionLookupNode,
  type QueueRecord,
  type PRShape,
  type StepExecution,
  type StepRunner,
} from "@yrd/queue"
import {
  activeQueueRootIds,
  childRunId,
  emptyQueueProjectionIndex,
  indexQueueStart,
  latestExactRunId,
  latestPrefixRunId,
  projectionLookupGet,
  projectionLookupSet,
  queueLookupKey,
  recordReleasedAdmissionFailure,
  releasedAdmissionFailures,
} from "../src/projection-index.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const UPDATED = "3".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
const ReviewResultSchema = z.object({ approved: z.boolean() }).strict()
const DeployResultSchema = z.object({ environment: z.string() }).strict()

type LookupCounters = { reads: number; enumerations: number }

function deepFreeze<Value>(value: Value): Value {
  const pending: object[] = []
  const seen = new WeakSet<object>()
  if (typeof value === "object" && value !== null) pending.push(value)
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child)
    }
    Object.freeze(current)
  }
  return value
}

function observeProjectionLookup<Value>(
  lookup: Readonly<QueueProjectionLookup<Value>>,
  counters: LookupCounters,
): QueueProjectionLookup<Value> {
  const nodes = new WeakMap<object, QueueProjectionLookupNode<Value>>()
  const children = new WeakMap<object, Readonly<Record<string, QueueProjectionLookupNode<Value>>>>()
  const wrapNode = (node: Readonly<QueueProjectionLookupNode<Value>>): QueueProjectionLookupNode<Value> => {
    const cached = nodes.get(node)
    if (cached !== undefined) return cached
    const proxy = new Proxy(
      { ...node },
      {
        get(target, property, receiver) {
          counters.reads += 1
          if (property === "children") return wrapChildren(target.children)
          return Reflect.get(target, property, receiver)
        },
        ownKeys(target) {
          counters.enumerations += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    nodes.set(node, proxy)
    return proxy
  }
  const wrapChildren = (
    value: Readonly<Record<string, QueueProjectionLookupNode<Value>>>,
  ): Readonly<Record<string, QueueProjectionLookupNode<Value>>> => {
    const cached = children.get(value)
    if (cached !== undefined) return cached
    const proxy = new Proxy(
      { ...value },
      {
        get(target, property, receiver) {
          counters.reads += 1
          const result = Reflect.get(target, property, receiver) as QueueProjectionLookupNode<Value> | undefined
          return result === undefined ? undefined : wrapNode(result)
        },
        ownKeys(target) {
          counters.enumerations += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    children.set(value, proxy)
    return proxy
  }
  return lookup.root === undefined ? {} : { root: wrapNode(lookup.root) }
}

type CheckResult = z.infer<typeof CheckResultSchema>
type ReviewResult = z.infer<typeof ReviewResultSchema>
type DeployResult = z.infer<typeof DeployResultSchema>
type CheckedShape = AddStepResult<PRShape, "check", CheckResult>
type ReviewedShape = AddStepResult<CheckedShape, "review", ReviewResult>
type MergedShape = ReviewedShape & IntegratedShape
type DeployedShape = AddStepResult<MergedShape, "deploy", DeployResult>

function prFacts(pr: PR | undefined) {
  if (pr === undefined) throw new Error("expected PR")
  const revision = currentPRRev(pr)
  return {
    ...pr,
    delivery: prDeliveryState(pr),
    current: revision,
    revision: revision.n,
    headSha: revision.head,
    baseSha: revision.baseSha,
    correlation: revision.correlation,
    composition: revision.composition,
    recut: revision.recut,
  }
}

function deliveryOf(pr: PR | undefined): string | undefined {
  return pr === undefined ? undefined : prDeliveryState(pr)
}

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

function queuePlugin(
  options: Readonly<{
    batch?: false | number
    check?: StepRunner<PRShape, CheckResult>
    merge?: (
      input: StepExecution<ReviewedShape>,
    ) => JobResult<{ commit: string; baseSha: string }> | Promise<JobResult<{ commit: string; baseSha: string }>>
    deploy?: (input: StepExecution<MergedShape>) => JobResult<DeployResult>
    checkRevision?: string
    checkClassification?: "base" | "carrier"
    requires?: readonly ["review"]
    defaultSteps?: readonly ("check" | "review" | "merge" | "deploy")[]
    resolveBaseSha?: (base: string) => string | Promise<string>
    prepareCandidate?: (input: {
      id: string
      queueId: string
      baseSha: string
      revs: readonly { pr: string; n: number; head: string }[]
      prs: readonly unknown[]
    }) =>
      | Readonly<{
          id: string
          queueId: string
          baseSha: string
          revs: readonly { pr: string; n: number; head: string }[]
          sha?: string
          ref?: string
          mergeability: "mergeable" | "conflicting"
        }>
      | Promise<
          Readonly<{
            id: string
            queueId: string
            baseSha: string
            revs: readonly { pr: string; n: number; head: string }[]
            sha?: string
            ref?: string
            mergeability: "mergeable" | "conflicting"
          }>
        >
    runner?: (jobs: Jobs) => Runner
    flowConfig?: YrdConfig
  }> = {},
) {
  const check = withStep(
    "check",
    (input, context): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      options.check?.(input, context) ?? {
        status: "completed",
        conclusion: "success",
        output: { checked: true },
      },
    {
      revision: options.checkRevision ?? "check-v1",
      output: CheckResultSchema,
      ...(options.checkClassification === undefined ? {} : { classification: options.checkClassification }),
    },
  )
  const review = withStep(
    "review",
    (_input: StepExecution<CheckedShape>): JobResult<ReviewResult> => ({
      status: "completed",
      conclusion: "success",
      output: { approved: true },
    }),
    { revision: "review-v1", output: ReviewResultSchema },
  )
  const merge = withMerge(
    (
      input: StepExecution<ReviewedShape>,
    ): JobResult<{ commit: string; baseSha: string }> | Promise<JobResult<{ commit: string; baseSha: string }>> =>
      options.merge?.(input) ?? {
        status: "completed",
        conclusion: "success",
        output: { commit: MERGED, baseSha: BASE },
      },
    { revision: "merge-v1" },
  )
  const deploy = withStep(
    "deploy",
    (input: StepExecution<MergedShape>): JobResult<DeployResult> =>
      options.deploy?.(input) ?? {
        status: "completed",
        conclusion: "success",
        output: { environment: "staging" },
      },
    { revision: "deploy-v1", kind: "action", output: DeployResultSchema },
  )
  return withQueue({
    steps: [check, review, merge, deploy] as const,
    batch: options.batch ?? false,
    defaultSteps: options.defaultSteps ?? ["check", "review", "merge", "deploy"],
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    resolveBaseSha: options.resolveBaseSha ?? (() => BASE),
    ...(options.prepareCandidate === undefined ? {} : { prepareCandidate: options.prepareCandidate }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.flowConfig === undefined ? {} : { flows: options.flowConfig }),
  })
}

async function createQueueApp(
  options: Parameters<typeof queuePlugin>[0] = {},
  journal = createMemoryJournal(),
  clock: () => string = () => "2026-01-01T00:00:00.000Z",
  id: () => string = ids(),
  log?: ConditionalLogger,
  flowConfig?: YrdConfig,
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = queuePlugin({ ...options, ...(flowConfig === undefined ? {} : { flowConfig }) })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({
      jobs: bayJobs,
      ...(flowConfig === undefined
        ? {}
        : { selectFlow: (submission: Parameters<typeof selectFlow>[1]) => selectFlow(flowConfig, submission).pin }),
    }),
  )
  const definition = queue(base)
  return createYrd(definition, {
    inject: { journal, id, clock, ...(log === undefined ? {} : { log }) },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createQueueApp>>, branch: string, base = "main") {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base, baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return prFacts(pr)
}

describe("Queue", () => {
  it("materializes the immutable Candidate before admitting its first Job", async () => {
    const prepared: string[] = []
    await using app = await createQueueApp({
      prepareCandidate: (input) => {
        prepared.push(input.id)
        const { prs: _prs, ...candidate } = input
        return {
          ...candidate,
          sha: MERGED,
          ref: `refs/yrd/candidates/${input.id}`,
          mergeability: "mergeable",
        }
      },
    })
    const pr = await submitBranch(app, "topic/materialized-candidate")

    const [run] = await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)

    expect(prepared).toEqual(["C1"])
    expect(app.state().queues.candidates[run!.candidateId]).toMatchObject({
      id: "C1",
      sha: MERGED,
      ref: "refs/yrd/candidates/C1",
      mergeability: "mergeable",
      revs: [{ pr: pr.id, n: 1, head: HEAD }],
    })
    expect(run?.steps[0]?.job).toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("records a conflicting Candidate without admitting an expensive Job", async () => {
    let checkCalls = 0
    let candidatePreparations = 0
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        check: () => {
          checkCalls += 1
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
        prepareCandidate: (input) => {
          candidatePreparations += 1
          const { prs: _prs, ...candidate } = input
          return { ...candidate, mergeability: "conflicting" }
        },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "topic/conflicting-candidate")

    const [run] = await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)

    expect(checkCalls).toBe(0)
    expect(run).toMatchObject({
      id: "R1",
      candidateId: "C1",
      status: "completed",
      conclusion: "failure",
      jobs: [],
      error: { code: "candidate-conflicting", message: "Candidate 'C1' conflicts before Job admission" },
    })
    expect(app.state().queues.candidates.C1).toMatchObject({
      id: "C1",
      mergeability: "conflicting",
      revs: [{ pr: pr.id, n: 1, head: HEAD }],
    })
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "candidate-conflicting", message: "PR 'PR1' revision 1 conflicts in Candidate 'C1'" },
    })
    await expect(app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)).rejects.toThrow(
      "conflicts in Candidate 'C1'",
    )
    const runErrors = events.filter(
      (event) =>
        event.kind === "log" &&
        event.namespace === "yrd:queue:run" &&
        event.level === "error" &&
        event.props?.run === "R1",
    )
    expect(runErrors).toHaveLength(1)
    expect(runErrors[0]?.props).toMatchObject({
      lifecycle: "run",
      outcome: "failed",
      error: { code: "candidate-conflicting" },
    })
    expect(candidatePreparations).toBe(1)
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    log.end()
  })

  it("settles a conflicting child Candidate as a Job-free bisection Run", async () => {
    const checked: string[][] = []
    await using app = await createQueueApp({
      batch: 2,
      check: (input) => {
        checked.push(input.prs.map((pr) => pr.id))
        return input.prs.length > 1
          ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "bisect" } }
          : { status: "completed", conclusion: "success", output: { checked: true } }
      },
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        const conflicting = input.revs.length === 1 && input.revs[0]?.pr === "PR1"
        return {
          ...candidate,
          ...(conflicting ? {} : { sha: MERGED, ref: `refs/yrd/candidates/${input.id}` }),
          mergeability: conflicting ? "conflicting" : "mergeable",
        }
      },
    })
    const first = await submitBranch(app, "topic/conflicting-child")
    const second = await submitBranch(app, "topic/passing-child")

    const runs = await app.queue.run({ prs: [first.id, second.id], steps: ["check"] }, runtime)

    expect(runs).toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure" },
      {
        id: "R2",
        candidateId: "C2",
        parent: "R1",
        status: "completed",
        conclusion: "failure",
        jobs: [],
        error: { code: "candidate-conflicting" },
      },
      { id: "R3", candidateId: "C3", parent: "R1", status: "completed", conclusion: "success" },
    ])
    expect(checked).toEqual([["PR1", "PR2"], ["PR2"]])
    expect(Object.values(app.state().queues.candidates).map(({ id, mergeability }) => ({ id, mergeability }))).toEqual([
      { id: "C1", mergeability: "mergeable" },
      { id: "C2", mergeability: "conflicting" },
      { id: "C3", mergeability: "mergeable" },
    ])
    for (const child of runs.slice(1)) expect(child).not.toHaveProperty("isolationPart")
  })

  it("submits Candidate work through the configured Runner and Context seam", async () => {
    const submissions: RunnerSubmission[] = []
    await using app = await createQueueApp({
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        return {
          ...candidate,
          sha: MERGED,
          ref: `refs/yrd/candidates/${input.id}`,
          mergeability: "mergeable",
        }
      },
      runner: (jobs) => {
        const runner = localRunner({ id: "composed-runner", jobs, leaseMs: 60_000, maxInFlight: 2 })
        return {
          ...runner,
          submit(input) {
            submissions.push(input)
            return runner.submit(input)
          },
        }
      },
    })
    const pr = await submitBranch(app, "topic/runner-candidate-context")

    const [run] = await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)

    expect(submissions).toEqual([
      {
        job: run?.steps[0]?.job?.id,
        candidateRef: "refs/yrd/candidates/C1",
        context: { scope: "job", candidate: "rw", capabilities: ["git"] },
      },
    ])
    expect(run?.steps[0]?.job).toMatchObject({ runner: "composed-runner", context: "composed-runner:context:1" })
  })

  it("persists one StepDef kind instead of parallel integration booleans", async () => {
    await using app = await createQueueApp()

    expect(app.queue.steps()).toMatchObject([
      { name: "check", kind: "check" },
      { name: "review", kind: "check" },
      { name: "merge", kind: "merge" },
      { name: "deploy", kind: "action" },
    ])
    for (const step of app.queue.steps()) {
      expect(step).not.toHaveProperty("integrates")
      expect(step).not.toHaveProperty("needsIntegration")
    }
  })

  it("runs checks across independent bases concurrently under Runner admission", async () => {
    const entered = new Set<string>()
    const bothEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await using app = await createQueueApp({
      check: async (input) => {
        const base = input.prs[0]?.base
        if (base === undefined) throw new Error("check lost its base")
        entered.add(base)
        if (entered.size === 2) bothEntered.resolve()
        await release.promise
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const main = await submitBranch(app, "topic/main-check", "main")
    const releaseBranch = await submitBranch(app, "topic/release-check", "release")

    const running = Promise.all([
      app.queue.run({ prs: [main.id], steps: ["check"] }, runtime),
      app.queue.run({ prs: [releaseBranch.id], steps: ["check"] }, runtime),
    ])
    await bothEntered.promise
    expect([...entered].toSorted()).toEqual(["main", "release"])
    release.resolve()
    await expect(running).resolves.toMatchObject([
      [{ status: "completed", conclusion: "success" }],
      [{ status: "completed", conclusion: "success" }],
    ])
  })

  it("serializes merge Jobs for Candidates targeting the same base", async () => {
    let activeMerges = 0
    let peakMerges = 0
    await using app = await createQueueApp({
      merge: async () => {
        activeMerges += 1
        peakMerges = Math.max(peakMerges, activeMerges)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeMerges -= 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const first = await submitBranch(app, "topic/first-merge")
    const second = await submitBranch(app, "topic/second-merge")

    const runs = await app.queue.run({ prs: [first.id, second.id] }, runtime)

    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === "completed" && run.conclusion === "success")).toBe(true)
    expect(peakMerges).toBe(1)
  })

  it("pins the enrolled Flow on the PR revision snapshot and every Run", async () => {
    const config = defineConfig(
      yrd.flow({
        name: "docs",
        rev: "5",
        on: () => true,
        steps: [yrd.check("check"), yrd.merge()],
      }),
    )
    await using app = await createQueueApp({}, undefined, undefined, undefined, undefined, config)
    await submitBranch(app, "docs/target-model")

    const [run] = await app.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)

    expect(run).toMatchObject({
      queueId: "docs/main",
      flow: { name: "docs", rev: "5", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      prs: [
        {
          id: "PR1",
          flow: { name: "docs", rev: "5", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        },
      ],
    })
    expect(app.state().queues.candidates.C1?.queueId).toBe("docs/main")
  })

  it("refuses to finish waiting work across a base-authority Flow revision change", async () => {
    const flow = (rev: string) =>
      defineConfig(yrd.flow({ name: "main", rev, on: () => true, steps: [yrd.check("check"), yrd.merge()] }))
    const journal = createMemoryJournal()
    const original = await createQueueApp(
      { check: () => ({ status: "waiting", token: "remote-flow" }) },
      journal,
      undefined,
      undefined,
      undefined,
      flow("1"),
    )
    await submitBranch(original, "topic/flow-revision")
    const [waiting] = await original.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)
    const job = waiting?.steps[0]?.job
    if (job?.status !== "waiting") throw new Error("expected waiting Flow Job")
    await original.close()

    await using resumed = await createQueueApp(
      { check: () => ({ status: "waiting", token: "remote-flow" }) },
      journal,
      undefined,
      ids(20),
      undefined,
      flow("2"),
    )
    await expect(
      resumed.queue.finish(
        "R1",
        {
          job: job.id,
          step: "check",
          attempt: job.attempt,
          runner: job.runner,
          token: job.token,
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow("revision 1 cannot resume under revision 2")
    expect(resumed.queue.get("R1")?.steps[0]?.job?.status).toBe("waiting")
  })

  it("projects immutable Candidates separately from GitHub-shaped Runs", async () => {
    await using app = await createQueueApp()
    await submitBranch(app, "topic/target-model")

    const [run] = await app.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)

    expect(app.state().queues.candidates).toMatchObject({
      C1: {
        id: "C1",
        queueId: "main",
        baseSha: BASE,
        revs: [{ pr: "PR1", n: 1, head: HEAD }],
        mergeability: "unknown",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })
    expect(run).toMatchObject({
      id: "R1",
      queueId: "main",
      candidateId: "C1",
      jobs: [expect.any(String)],
    })
  })

  it("resolves PR, Run, and base selectors while preserving canonical records", async () => {
    await using app = await createQueueApp()
    await submitBranch(app, "Topic/Selectors")

    const runs = await app.queue.run({ prs: ["pr1"], steps: ["check"] }, runtime)
    expect(runs).toMatchObject([{ id: "R1", prs: [{ id: "PR1", base: "main" }] }])
    expect(app.queue.get("r1")).toMatchObject({ id: "R1", prs: [{ id: "PR1" }] })
    expect(app.queue.status("MAIN")).toMatchObject({ base: "main", finished: [{ id: "R1" }] })
    expect(app.queue.status("ORIGIN/MAIN")).toMatchObject({ base: "main", finished: [{ id: "R1" }] })
    expect(activeQueueRootIds(app.state().queues.authority)).toEqual([])
  })

  it("resolves a canonical Queue run without enumerating history while preserving selector fallback", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/bounded-run-resolution")
    await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
    const target = Queues.get(app.state().queues, "R1")
    if (target === undefined) throw new Error("expected canonical R1")

    let records = app.state().queues.records
    for (let index = 0; index < 1_380; index += 1) {
      const id = `R${index + 2}`
      records = projectionLookupSet(records, id, { ...target, id })
    }
    records = deepFreeze(records)

    const exactCounters: LookupCounters = { reads: 0, enumerations: 0 }
    const exactState = {
      ...app.state().queues,
      records: observeProjectionLookup(records, exactCounters),
    }
    expect(Queues.resolve(exactState, "R1")?.id).toBe("R1")
    expect(exactCounters.enumerations).toBe(0)
    expect(exactCounters.reads).toBeLessThanOrEqual(256)

    const fallbackCounters: LookupCounters = { reads: 0, enumerations: 0 }
    const fallbackState = {
      ...app.state().queues,
      records: observeProjectionLookup(records, fallbackCounters),
    }
    expect(Queues.resolve(fallbackState, "r1")?.id).toBe("R1")
    expect(fallbackCounters.enumerations).toBeGreaterThan(0)
  })

  it("removes ordinary failed roots from the live authority projection after settlement", async () => {
    await using app = await createQueueApp({
      check: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "tests failed" },
      }),
    })
    const pr = await submitBranch(app, "issue/settled-failure")

    await expect(app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure" },
    ])
    expect(activeQueueRootIds(app.state().queues.authority)).toEqual([])
  })

  it("drains the next submitted PR after releasing a passed check-only root", async () => {
    await using app = await createQueueApp({ defaultSteps: ["check"] })
    await submitBranch(app, "issue/resident-first")

    await expect(app.queue.run({}, runtime)).resolves.toMatchObject([
      { id: "R1", status: "completed", conclusion: "success" },
    ])
    await submitBranch(app, "issue/resident-second")

    await expect(app.queue.run({}, runtime)).resolves.toMatchObject([
      { id: "R2", status: "completed", conclusion: "success" },
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
  })

  it("releases a replayed terminal root after a crash before its settled event", async () => {
    const inner = createMemoryJournal()
    let refuseSettlement = true
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = value as { events?: readonly { name?: string }[] }
        if (refuseSettlement && frame.events?.some((event) => event.name === "queue/run/settled")) {
          refuseSettlement = false
          throw new Error("yrd: settled append refused (injected crash)")
        }
        return inner.append(value, cursor)
      },
    }
    const id = ids()

    {
      await using app = await createQueueApp({}, journal, undefined, id)
      const pr = await submitBranch(app, "issue/settled-crash-gap")
      await expect(app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)).rejects.toThrow("settled append refused")
      expect(app.queue.get("R1")).toMatchObject({
        status: "completed",
        conclusion: "success",
        steps: [{ job: { status: "completed", conclusion: "success" } }],
      })
      expect(activeQueueRootIds(app.state().queues.authority)).toEqual(["R1"])
    }

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual(["R1"])
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "completed", conclusion: "success" }),
    ])
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual([])
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
    const appended = (await Array.fromAsync(replayed.events())).slice(before.length)
    expect(appended.map(({ name }) => name)).toEqual(["queue/run/settled"])
  })

  it("does not manufacture active roots when replaying terminal pre-settlement journals", async () => {
    const inner = createMemoryJournal()
    let refuseSettlement = true
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = structuredClone(value) as {
          events?: { name?: string; data?: { run?: Record<string, unknown> } }[]
        }
        for (const event of frame.events ?? []) {
          if (event.name === "queue/run/started" && event.data?.run !== undefined) {
            delete event.data.run.settlement
          }
        }
        if (refuseSettlement && frame.events?.some((event) => event.name === "queue/run/settled")) {
          refuseSettlement = false
          throw new Error("yrd: settled append refused (legacy fixture boundary)")
        }
        return inner.append(frame, cursor)
      },
    }
    const id = ids()

    {
      await using app = await createQueueApp({}, journal, undefined, id)
      const pr = await submitBranch(app, "issue/legacy-terminal-root")
      await expect(app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)).rejects.toThrow(
        "legacy fixture boundary",
      )
    }

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(replayed.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "success" })
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual([])
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(replayed.events())).toEqual(before)
  })

  it("refuses to migrate an unfinished pre-settlement Queue root", async () => {
    const inner = createMemoryJournal()
    let refuseFinish = true
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = structuredClone(value) as {
          events?: { name?: string; data?: { run?: Record<string, unknown>; type?: string } }[]
        }
        for (const event of frame.events ?? []) {
          if (event.name === "queue/run/started" && event.data?.run !== undefined) {
            delete event.data.run.settlement
          }
        }
        if (
          refuseFinish &&
          frame.events?.some((event) => event.name === "job/transitioned" && event.data?.type === "finish")
        ) {
          refuseFinish = false
          throw new Error("yrd: job finish refused (legacy active fixture)")
        }
        return inner.append(frame, cursor)
      },
    }
    const id = ids()

    {
      await using app = await createQueueApp({}, journal, undefined, id)
      const pr = await submitBranch(app, "issue/legacy-active-root")
      await expect(app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)).rejects.toThrow("legacy active fixture")
    }

    await expect(createQueueApp({}, journal, undefined, id)).rejects.toThrow(
      "Queue projection migration requires quiesced legacy roots; finish with the previous writer: R1",
    )
  })

  it.each([10, 10_000, 100_000])(
    "advances one canonical run without enumerating %i historical runs",
    async (historicalRuns) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/bounded-advance")
      await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
      const records = app.state().queues.records
      const target = Queues.get(app.state().queues, "R1")
      if (target === undefined) throw new Error("expected canonical R1")
      const history = Array.from(
        { length: historicalRuns },
        (_, index): QueueRecord => ({ ...target, id: `R${index + 2}` }),
      )
      let enumerations = 0
      const originalValues = Object.values
      const values = vi.spyOn(Object, "values").mockImplementation(((value: object) => {
        if (value === records) {
          enumerations += 1
          return [target, ...history]
        }
        return originalValues(value)
      }) as typeof Object.values)
      try {
        await app.dispatch(app.commands.queue.advance, { run: "R1" })
      } finally {
        values.mockRestore()
      }

      expect(enumerations).toBe(0)
    },
  )

  it("matches the former replay-order scans for every Queue projection index lookup", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/index-contract")
    await app.queue.run({ prs: [pr.id], steps: ["check", "review"] }, runtime)
    const seed = Queues.get(app.state().queues, "R1")
    if (seed?.prs[0] === undefined) throw new Error("expected R1 projection fixture")
    const later: QueueRecord = { ...seed, id: "R10" }
    const child: QueueRecord = { ...seed, id: "R11", parent: later.id, isolationPart: 1 }
    const replayedLast: QueueRecord = { ...seed, id: "R0" }

    const replayOrder = [seed, later, child, replayedLast]
    const formerScanOrder = replayOrder.toSorted((left, right) =>
      left.id.localeCompare(right.id, undefined, { numeric: true }),
    )
    let index = emptyQueueProjectionIndex()
    for (const record of replayOrder) index = indexQueueStart(index, record)
    const released = [
      { ...later, stepSelection: { authority: "admission" as const, steps: ["check", "review"] } },
      { ...later, stepSelection: { authority: "admission" as const, steps: ["check", "review"] } },
    ]
    for (const record of released) index = recordReleasedAdmissionFailure(index, record)

    const exactKey = queueLookupKey(seed.prs[0], seed.steps)
    const prefix = seed.steps.slice(0, 1)
    const prefixKey = queueLookupKey(seed.prs[0], prefix)
    const scanChild = formerScanOrder.find((record) => record.parent === later.id && record.isolationPart === 1)?.id
    const scanExact = formerScanOrder
      .filter(
        (record) =>
          record.prs.length === 1 &&
          record.prs[0] !== undefined &&
          queueLookupKey(record.prs[0], record.steps) === exactKey,
      )
      .at(-1)?.id
    const scanPrefix = formerScanOrder
      .filter(
        (record) =>
          record.prs.length === 1 &&
          record.prs[0] !== undefined &&
          record.steps.length >= prefix.length &&
          queueLookupKey(record.prs[0], record.steps.slice(0, prefix.length)) === prefixKey,
      )
      .at(-1)?.id
    const scanFailures = released.filter(
      (record) =>
        record.stepSelection?.authority === "admission" &&
        record.prs[0] !== undefined &&
        queueLookupKey(record.prs[0], record.steps) === exactKey,
    ).length

    expect(childRunId(index, later.id, 1)).toBe(scanChild)
    expect(latestExactRunId(index, seed.prs[0], seed.steps)).toBe(scanExact)
    expect(latestPrefixRunId(index, seed.prs[0], prefix)).toBe(scanPrefix)
    expect(releasedAdmissionFailures(index, seed.prs[0], seed.steps)).toBe(scanFailures)
    expect(index.nextRunNumber).toBe(12)
  })

  it("round-trips a projection lookup through JSON and extends a deeply frozen value immutably", () => {
    const seeded = projectionLookupSet({}, "alpha", { latestExact: "R1" })
    const restored = deepFreeze(
      JSON.parse(JSON.stringify(seeded)) as QueueProjectionLookup<Readonly<{ latestExact: string }>>,
    )

    const extended = projectionLookupSet(restored, "beta", { latestExact: "R2" })

    expect(projectionLookupGet(restored, "alpha")).toEqual({ latestExact: "R1" })
    expect(projectionLookupGet(restored, "beta")).toBeUndefined()
    expect(projectionLookupGet(extended, "alpha")).toEqual({ latestExact: "R1" })
    expect(projectionLookupGet(extended, "beta")).toEqual({ latestExact: "R2" })
  })

  it.each([10, 10_000, 100_000])(
    "looks up a canonical Queue plan with bounded radix work across %i historical keys",
    (size) => {
      const snapshot = {
        id: "PR-target",
        branch: "issue/target",
        revision: 1,
        headSha: HEAD,
        base: "main",
        baseSha: BASE,
      }
      const steps = [
        {
          name: "check",
          title: "check",
          revision: "check-v1",
          kind: "check" as const,
        },
      ]
      const key = queueLookupKey(snapshot, steps)
      let plans = emptyQueueProjectionIndex().plans
      for (let index = 0; index < size; index += 1) {
        plans = projectionLookupSet(plans, `history-${index}`, { latestExact: `R${index + 1}` })
      }
      plans = deepFreeze(projectionLookupSet(plans, key, { latestExact: "R-target" }))
      const counters: LookupCounters = { reads: 0, enumerations: 0 }
      const index = { ...emptyQueueProjectionIndex(), plans: observeProjectionLookup(plans, counters) }

      expect(latestExactRunId(index, snapshot, steps)).toBe("R-target")
      expect(counters.enumerations).toBe(0)
      expect(counters.reads).toBeLessThanOrEqual(256)
    },
  )

  it.each([10, 10_000, 100_000])(
    "indexes a new Queue run without enumerating %i historical lookup keys",
    async (size) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/bounded-index-write")
      await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
      const record = Queues.get(app.state().queues, "R1")
      const snapshot = record?.prs[0]
      if (record === undefined || snapshot === undefined) throw new Error("expected bounded index-write fixture")
      let plans = emptyQueueProjectionIndex().plans
      for (let index = 0; index < size; index += 1) {
        plans = projectionLookupSet(plans, `history-${index}`, { latestExact: `R${index + 2}` })
      }
      plans = deepFreeze(plans)
      const counters: LookupCounters = { reads: 0, enumerations: 0 }
      const index = Object.freeze({
        ...emptyQueueProjectionIndex(),
        plans: observeProjectionLookup(plans, counters),
      })
      const next = indexQueueStart(index, { ...record, id: `R${size + 2}` })

      expect(projectionLookupGet(index.plans, "history-0")).toEqual({ latestExact: "R2" })
      expect(latestExactRunId(index, snapshot, record.steps)).toBeUndefined()
      expect(projectionLookupGet(next.plans, "history-0")).toEqual({ latestExact: "R2" })
      expect(latestExactRunId(next, snapshot, record.steps)).toBe(`R${size + 2}`)
      expect(latestPrefixRunId(next, snapshot, record.steps)).toBe(`R${size + 2}`)
      expect(Object.isFrozen(plans.root)).toBe(true)
      expect(counters.enumerations).toBeLessThanOrEqual(128)
    },
  )

  it.each([10, 10_000, 100_000])(
    "projects an actual Queue start without enumerating %i historical records or authorities",
    async (size) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/bounded-start-projection")
      await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
      const seed = Queues.get(app.state().queues, "R1")
      const seedAuthority = Queues.authorityRun(app.state().queues.authority, "R1")
      if (seed === undefined || seedAuthority === undefined) throw new Error("expected Queue projection seed")

      let records = app.state().queues.records
      let runs = app.state().queues.authority.runs
      for (let index = 0; index < size; index += 1) {
        const id = `R${index + 2}`
        records = projectionLookupSet(records, id, { ...seed, id })
        runs = projectionLookupSet(runs, id, seedAuthority)
      }
      records = deepFreeze(records)
      runs = deepFreeze(runs)
      const recordCounters: LookupCounters = { reads: 0, enumerations: 0 }
      const authorityCounters: LookupCounters = { reads: 0, enumerations: 0 }
      const observed = {
        ...app.state().queues,
        records: observeProjectionLookup(records, recordCounters),
        authority: {
          ...app.state().queues.authority,
          runs: observeProjectionLookup(runs, authorityCounters),
        },
      }
      const id = `R${size + 2}`
      const projected = projectQueueStarted(observed, { ...seed, id })

      expect(Queues.get(observed, id)).toBeUndefined()
      expect(Queues.get(projected, id)?.id).toBe(id)
      expect(Queues.authorityRun(observed.authority, id)).toBeUndefined()
      expect(Queues.authorityRun(projected.authority, id)).toBeDefined()
      expect(recordCounters.enumerations).toBeLessThanOrEqual(128)
      expect(authorityCounters.enumerations).toBeLessThanOrEqual(128)
      expect(recordCounters.reads).toBeLessThanOrEqual(1_024)
      expect(authorityCounters.reads).toBeLessThanOrEqual(1_024)
    },
  )

  it("rejects a Queue start whose execution receipt diverges from its Candidate", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/candidate-run-receipt")
    await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
    const seed = Queues.get(app.state().queues, "R1")
    const snapshot = seed?.prs[0]
    if (seed === undefined || snapshot === undefined) throw new Error("expected Candidate receipt fixture")

    const mismatches: readonly (readonly [string, QueueRecord])[] = [
      ["queue identity", { ...seed, id: "R2", queueId: "other" }],
      ["queue target", { ...seed, id: "R3", base: "other" }],
      ["snapshot queue", { ...seed, id: "R4", prs: [{ ...snapshot, base: "other" }] }],
      ["base SHA", { ...seed, id: "R5", prs: [{ ...snapshot, baseSha: UPDATED }] }],
      ["ordered PR revisions", { ...seed, id: "R6", prs: [{ ...snapshot, headSha: UPDATED }] }],
    ]

    for (const [label, record] of mismatches) {
      expect(() => projectQueueStarted(app.state().queues, record), label).toThrow(/Queue run 'R\d+' .* Candidate 'C1'/)
    }
  })

  it.each([10, 10_000, 100_000])(
    "keeps child, prefix, retry, claim, and next-id work independent of %i terminal runs",
    async (size) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/all-bounded-lookups")
      await app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
      const record = Queues.get(app.state().queues, "R1")
      if (record?.prs[0] === undefined) throw new Error("expected bounded lookup fixture")
      const key = queueLookupKey(record.prs[0], record.steps)
      let plans = emptyQueueProjectionIndex().plans
      let children = emptyQueueProjectionIndex().childByParentPart
      for (let index = 0; index < size; index += 1) {
        plans = projectionLookupSet(plans, `history-${index}`, {
          latestExact: `R${index + 2}`,
          latestPrefix: `R${index + 2}`,
        })
        children = projectionLookupSet(children, `history-${index}`, `R${index + 2}`)
      }
      plans = deepFreeze(
        projectionLookupSet(plans, key, {
          latestExact: "R1",
          latestPrefix: "R1",
          releasedAdmissionFailures: 2,
        }),
      )
      children = deepFreeze(projectionLookupSet(children, `R1\0${1}`, "R-child"))
      const counters: LookupCounters = { reads: 0, enumerations: 0 }
      const index = {
        ...emptyQueueProjectionIndex(),
        nextRunNumber: size + 2,
        childByParentPart: observeProjectionLookup(children, counters),
        plans: observeProjectionLookup(plans, counters),
      }

      expect(childRunId(index, "R1", 1)).toBe("R-child")
      expect(latestExactRunId(index, record.prs[0], record.steps)).toBe("R1")
      expect(latestPrefixRunId(index, record.prs[0], record.steps)).toBe("R1")
      expect(releasedAdmissionFailures(index, record.prs[0], record.steps)).toBe(2)
      expect(Queues.nextId({ ...app.state().queues, index })).toBe(`R${size + 2}`)
      expect(counters.enumerations).toBe(0)
      expect(counters.reads).toBeLessThanOrEqual(1_024)

      let historicalRunEnumerations = 0
      const runs = new Proxy(app.state().queues.authority.runs, {
        ownKeys(target) {
          historicalRunEnumerations += 1
          return Reflect.ownKeys(target)
        },
      })
      activeQueueRootIds({ ...app.state().queues.authority, runs })
      expect(historicalRunEnumerations).toBe(0)
    },
  )

  it("emits one terminal run lifecycle with lossless PR revision and correlation identity", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp({}, undefined, undefined, undefined, log)
    await app.bays.submit({
      branch: "issue/observable",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
      correlation: { namespace: "review", id: "21125" },
    })

    await expect(app.queue.run({ prs: ["PR1"], steps: ["check", "review", "merge"] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "completed", conclusion: "success" },
    ])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:queue:run",
        level: "info",
        props: expect.objectContaining({
          lifecycle: "run",
          outcome: "succeeded",
          run: "R1",
          prs: [
            expect.objectContaining({
              pr: "PR1",
              revision: 1,
              headSha: HEAD,
              correlation: { namespace: "review", id: "21125" },
            }),
          ],
          durationMs: expect.any(Number),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:jobs:check",
        level: "info",
        props: expect.objectContaining({
          lifecycle: "check",
          outcome: "succeeded",
          run: "R1",
          step: "check",
          job: expect.any(String),
          attempt: 1,
          runner: "local",
          prs: [expect.objectContaining({ pr: "PR1", revision: 1, headSha: HEAD })],
          durationMs: expect.any(Number),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:jobs:merge",
        level: "info",
        props: expect.objectContaining({
          lifecycle: "merge",
          outcome: "succeeded",
          run: "R1",
          step: "merge",
          runner: "local",
          prs: [expect.objectContaining({ pr: "PR1", revision: 1, headSha: HEAD })],
          durationMs: expect.any(Number),
        }),
      }),
    )
    log.end()
  })

  it("owns the step artifact projection across output, waiting, and nested failure evidence", () => {
    const ArtifactSchema = z
      .object({
        name: z.string().optional(),
        path: z.string().optional(),
        kind: z.string().optional(),
        uri: z.string().optional(),
      })
      .strict()
    const ArtifactResultSchema = z
      .object({
        checked: z.boolean(),
        artifacts: z.array(ArtifactSchema).optional(),
        nested: z
          .object({ artifacts: z.array(ArtifactSchema) })
          .strict()
          .optional(),
      })
      .strict()
    const step = withStep(
      "check",
      async (): Promise<JobResult<z.infer<typeof ArtifactResultSchema>>> => ({
        status: "completed",
        conclusion: "success",
        output: { checked: true },
      }),
      { revision: "check-v1", output: ArtifactResultSchema },
    )
    const local = { name: "stderr", path: "/artifacts/R1/check/stderr.log" }
    const remote = { kind: "report", uri: "artifact://R1/check/report.json" }
    const unrelated = { name: "nested-output", path: "/not/a/step-artifact.log" }

    expect(
      step.job.observeResult?.({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "check-failed",
          message: "candidate failed",
          evidence: { comparison: { error: { evidence: { artifacts: [remote] } } } },
        },
        output: { checked: false, artifacts: [local], nested: { artifacts: [unrelated] } },
      }),
    ).toEqual({ artifacts: [local, remote] })

    expect(
      step.job.observeResult?.({
        status: "waiting",
        token: "remote-1",
        artifacts: [remote],
      }),
    ).toEqual({ artifacts: [remote] })
  })

  it("reports ONE failure ERROR at the deepest job — the enclosing run and compose settle at INFO", async () => {
    // A single failure must not fire ERROR three times (jobs:check + queue:run +
    // queue:compose). The failing Job owns the one ERROR; the run and compose
    // that merely contain it settle at INFO, so operators see the failure once.
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        check: () => ({
          status: "completed",
          conclusion: "failure",
          error: { code: "check-failed", message: "candidate failed" },
        }),
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    await submitBranch(app, "issue/one-error")
    await app.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)

    const errors = events
      .filter((event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.level === "error")
      .map((event) => event.namespace)
    expect(errors).toEqual(["yrd:jobs:check"])

    const run = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:queue:run" && event.props?.outcome !== "started",
    )
    expect(run).toMatchObject({ level: "info", props: expect.objectContaining({ outcome: "settled", run: "R1" }) })
    const compose = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:queue:compose" && event.props?.outcome !== "started",
    )
    expect(compose).toMatchObject({ level: "info", props: expect.objectContaining({ outcome: "settled" }) })
    log.end()
  })

  it("labels a mixed compose with per-run outcomes instead of a flat compose failed", async () => {
    // A compose whose runs array carries a PASSED run alongside a failed one must
    // not read "compose failed": the message names the mix so no passing run is
    // misrepresented.
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        batch: 1,
        check: (input) =>
          input.prs.some((pr) => pr.branch.includes("fail"))
            ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "bad candidate" } }
            : { status: "completed", conclusion: "success", output: { checked: true } },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    await submitBranch(app, "issue/pass-me")
    await submitBranch(app, "issue/fail-me")
    const runs = await app.queue.run({ prs: ["PR1", "PR2"], steps: ["check"] }, runtime)
    expect(
      runs.map((run) => run.conclusion).toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["failure", "success"])

    const compose = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:queue:compose" && event.props?.outcome === "settled",
    )
    expect(compose).toMatchObject({
      level: "info",
      message: "compose settled: 1 failed, 1 passed",
      props: expect.objectContaining({ outcome: "settled", summary: "settled: 1 failed, 1 passed" }),
    })
    log.end()
  })

  it("never re-reports an already-terminal run as a fresh settlement on a later cycle", async () => {
    // A terminal bisection parent whose isolated children are still waiting is
    // re-encountered every drain cycle. Its own outcome is fixed, so its run
    // lifecycle must emit exactly ONCE — never a fresh started/settled pair with
    // a bogus few-millisecond duration on each later cycle (the "R603 re-reported
    // 6 min later, durationMs:3" artifact).
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        batch: 2,
        // The 2-PR batch check fails (forcing a bisect); each isolated single-PR
        // child then WAITS on an external check, so the batch parent stays
        // terminal-failed with unsettled children across cycles.
        check: (input) =>
          input.prs.length > 1
            ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "red batch" } }
            : { status: "waiting", token: `remote-${input.prs[0]?.id}` },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    await submitBranch(app, "issue/batch-a")
    await submitBranch(app, "issue/batch-b")

    const runStartedForR1 = () =>
      events.filter(
        (event) =>
          event.kind === "log" &&
          event.namespace === "yrd:queue:run" &&
          event.props?.run === "R1" &&
          event.props?.outcome === "started",
      ).length

    await app.queue.run({ prs: [] }, runtime)
    expect(app.queue.get("R1")?.status).toBe("completed")
    expect(runStartedForR1()).toBe(1)

    // Recovery sees the same failed-parent/waiting-child tree, but neither an
    // expired lease nor a newly settled root. It must not manufacture progress.
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:00:30.000Z" })).resolves.toEqual([])

    // A second drain cycle re-encounters the still-unsettled bisection tree.
    await app.queue.run({ prs: [] }, runtime)
    // The terminal batch parent R1 did NOT re-emit its run lifecycle.
    expect(runStartedForR1()).toBe(1)
    log.end()
  })

  it("classifies a waiting queue lifecycle as progress rather than failure", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      { check: () => ({ status: "waiting", token: "remote-check" }) },
      undefined,
      undefined,
      undefined,
      log,
    )
    await submitBranch(app, "issue/waiting")

    await expect(app.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "waiting" },
    ])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:queue:run",
        level: "trace",
        props: expect.objectContaining({ lifecycle: "run", outcome: "progress", run: "R1" }),
      }),
    )
    log.end()
  })

  it("composes one immutable typed plan and rejects a pre-merge deploy", async () => {
    await using app = await createQueueApp()
    expectTypeOf(app.queue).toMatchTypeOf<Queue<DeployedShape>>()
    expectTypeOf(app.queue.recover)
      .parameter(0)
      .toEqualTypeOf<Readonly<{ recoveryTime: string; reason?: string; runner?: string }>>()
    expect(app.queue.steps().map((step) => step.name)).toEqual(["check", "review", "merge", "deploy"])

    const check = withStep(
      "check",
      (_input: StepExecution<PRShape>) => ({
        status: "completed",
        conclusion: "success" as const,
        output: { checked: true },
      }),
      { revision: "check-v1", output: CheckResultSchema },
    )
    const deploy = withStep(
      "deploy",
      (_input: StepExecution<MergedShape>) => ({
        status: "completed",
        conclusion: "success" as const,
        output: { environment: "test" },
      }),
      { revision: "deploy-v1", kind: "action", output: DeployResultSchema },
    )
    const invalid = (): void => {
      // @ts-expect-error deploy requires the shape produced by withMerge
      void withQueue({ steps: [check, deploy] as const })
    }
    void invalid
  })

  it("journals exact issue joins for integrated PRs while failed Runs leave the proposal open", async () => {
    const issueRef = "@km/all/21063-steering-laser"
    const correlation = { namespace: "tribe-request", id: "21091-terminal-join" }

    await using integratedApp = await createQueueApp()
    await integratedApp.bays.submit({
      branch: "topic/partial-2106-token",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
      issue: issueRef,
      correlation,
    })
    await integratedApp.queue.run({ prs: ["PR1"] }, runtime)

    expect(await Array.fromAsync(integratedApp.events())).toContainEqual(
      expect.objectContaining({
        name: "pr/integrated",
        data: {
          pr: "PR1",
          revision: 1,
          headSha: HEAD,
          issueRef,
          run: "R1",
          commit: MERGED,
          landingSha: MERGED,
          baseSha: BASE,
          correlation,
          actor: "operator",
        },
      }),
    )

    await using rejectedApp = await createQueueApp(
      {
        check: () => ({
          status: "completed",
          conclusion: "failure",
          error: {
            code: "check-failed",
            message: "typed bounce",
            evidence: { artifacts: [{ name: "stderr", path: "artifact://R1/check/stderr.log" }] },
          },
        }),
      },
      createMemoryJournal(),
      () => "2026-01-01T00:00:00.000Z",
      ids(),
      createLogger("test", [{ level: "silent" }]),
    )
    await rejectedApp.bays.submit({
      branch: "topic/unrelated-20685-subject",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
      issue: issueRef,
      correlation,
    })
    await rejectedApp.queue.run({ prs: ["PR1"] }, runtime)

    const failedEvents = await Array.fromAsync(rejectedApp.events())
    expect(failedEvents.map(({ name }) => name)).not.toContain("pr/rejected")
    expect(failedEvents).toContainEqual(
      expect.objectContaining({
        name: "queue/run/failed",
        data: {
          run: "R1",
          error: {
            code: "check-failed",
            message: "typed bounce",
            evidence: { artifacts: [{ name: "stderr", path: "artifact://R1/check/stderr.log" }] },
          },
          job: { id: expect.any(String), attempt: 1 },
          prs: [{ pr: "PR1", revision: 1, headSha: HEAD, actor: "operator" }],
        },
      }),
    )
    expect(rejectedApp.state().bays.prs.PR1).toMatchObject({
      state: "open",
      merged: false,
      issue: issueRef,
      revs: [{ n: 1, head: HEAD, actor: "operator", correlation }],
    })
    const rejectedRun = rejectedApp.queue.get("R1")
    expect(rejectedRun).toMatchObject({
      status: "completed",
      conclusion: "failure",
      prs: [{ id: "PR1", revision: 1, headSha: HEAD, correlation }],
    })
    expect(rejectedRun?.steps[0]).toMatchObject({
      name: "check",
      job: {
        status: "completed",
        conclusion: "failure",
        error: {
          code: "check-failed",
          message: "typed bounce",
          evidence: { artifacts: [{ name: "stderr", path: "artifact://R1/check/stderr.log" }] },
        },
      },
    })
  })

  it("binds an issue attached while checks wait to the eventual terminal fact", async () => {
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "remote-issue-attach" }),
    })
    const pr = await submitBranch(app, "issue/attach-while-waiting")
    const waiting = (await app.queue.run({ prs: [pr.id] }, runtime))[0]
    const job = waiting?.steps[0]?.job
    if (job?.status !== "waiting") throw new Error("check did not wait")

    const issueRef = "@km/all/21091-attached-while-waiting"
    await app.bays.editPr({ pr: pr.id, issue: issueRef })
    expect(
      await app.queue.finish(
        pr.id,
        {
          job: job.id,
          step: "check",
          attempt: job.attempt,
          runner: job.runner,
          token: job.token,
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).toMatchObject({ status: "completed", conclusion: "success" })
    expect(await Array.fromAsync(app.events())).toContainEqual(
      expect.objectContaining({
        name: "pr/integrated",
        data: expect.objectContaining({
          pr: pr.id,
          revision: 1,
          headSha: HEAD,
          issueRef,
          run: "R1",
          landingSha: MERGED,
        }),
      }),
    )
  })

  it("treats an explicit empty step selection as a true no-op", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/no-steps")

    const result = await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: [] })
    expect(result.events).toEqual([])
    await expect(app.queue.run({ prs: [pr.id], steps: [] }, runtime)).resolves.toEqual([])
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("submitted")
  })

  it("persists configured omissions without mislabeling unconfigured steps", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const expectedSelection = {
      authority: "explicit",
      steps: ["merge"],
      omittedSteps: [
        { name: "check", index: 0, revision: "check-v1", status: "skipped", reason: "not-selected" },
        { name: "deploy", index: 2, revision: "deploy-v1", status: "skipped", reason: "not-selected" },
      ],
    }

    {
      await using app = await createQueueApp({ defaultSteps: ["check", "merge", "deploy"] }, journal, undefined, id)
      const pr = await submitBranch(app, "issue/auditable-merge-only")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["merge"] })
      expect(JSON.parse(JSON.stringify(Queues.get(app.state().queues, "R1")?.stepSelection))).toMatchObject(
        expectedSelection,
      )
      const record = Queues.get(app.state().queues, "R1")
      if (record === undefined) throw new Error("expected a durable merge-only Run")
      const legacyRecord = {
        ...record,
        stepSelection: { authority: "explicit", steps: ["merge"], omittedChecks: ["check"] },
      }
      expect(() => QueueRecordSchema.parse(legacyRecord)).toThrow()
      expect(ReplayQueueRecordSchema.parse(legacyRecord).stepSelection).toEqual(legacyRecord.stepSelection)
    }

    await using replayed = await createQueueApp({ defaultSteps: ["check", "merge", "deploy"] }, journal, undefined, id)
    expect(JSON.parse(JSON.stringify(replayed.queue.get("R1")?.stepSelection))).toMatchObject(expectedSelection)
  })

  it("keeps recovery execution-free for requested merge work", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      merge: () => {
        mergeCalls += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/requested-merge")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["merge"] })
    const before = await Array.fromAsync(app.events())

    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([])

    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("queued")
    expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("submitted")
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
          return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
        },
        merge: () => {
          mergeCalls += 1
          return {
            status: "completed" as const,
            conclusion: "success" as const,
            output: { commit: MERGED, baseSha: BASE },
          }
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
        expect.objectContaining({ id: "R1", status: "completed", conclusion: "success" }),
      ])
      expect(deliveryOf(replayed.state().bays.prs.PR1)).toBe("integrated")
      expect(checkCalls).toBe(1)
      expect(mergeCalls).toBe(1)
    },
  )

  it("refuses mismatched replayed steps before starting their configured process", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return {
          status: "completed" as const,
          conclusion: "success" as const,
          output: { commit: MERGED, baseSha: BASE },
        }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/mismatched-resume")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["check", "merge"] })
      expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("queued")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({ prs: ["PR1"], steps: ["merge"] }, runtime)).rejects.toThrow(
      "PR 'PR1' is already in active queue run 'R1'",
    )
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      stepSelection: { authority: "explicit", steps: ["check", "merge"] },
      steps: [{ name: "check", job: { status: "queued" } }, { name: "merge" }],
    })
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
  })

  it("refuses to resume a replayed batch for only part of its pinned PR set", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      batch: 2,
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return {
          status: "completed" as const,
          conclusion: "success" as const,
          output: { commit: MERGED, baseSha: BASE },
        }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const first = await submitBranch(app, "issue/batch-one")
      const second = await submitBranch(app, "issue/batch-two")
      await app.dispatch(app.commands.queue.run, {
        prs: [first.id, second.id],
        steps: ["check", "merge"],
      })
      expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("queued")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({ prs: ["PR1"], steps: ["check", "merge"] }, runtime)).rejects.toThrow(
      "PR 'PR1' is already in active queue run 'R1'",
    )
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      prs: [{ id: "PR1" }, { id: "PR2" }],
      steps: [{ name: "check", job: { status: "queued" } }, { name: "merge" }],
    })
  })

  it("refuses to relabel configured replay authority as an explicit selection", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/configured-authority")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id] })
      expect(app.queue.get("R1")).toMatchObject({
        status: "queued",
        stepSelection: { authority: "configured", steps: ["check", "review", "merge", "deploy"] },
      })
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(
      replayed.queue.run({ prs: ["PR1"], steps: ["check", "review", "merge", "deploy"] }, runtime),
    ).rejects.toThrow("PR 'PR1' is already in active queue run 'R1'")
    expect(checkCalls).toBe(0)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      stepSelection: { authority: "configured" },
    })
    expect(replayed.queue.get("R1")?.steps[0]).toMatchObject({ name: "check", job: { status: "queued" } })
  })

  it("does not mistake a configured check-only Run for supersedable admission", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      defaultSteps: ["check"] as const,
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/configured-check-only")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id] })
      expect(app.queue.get("R1")).toMatchObject({
        status: "queued",
        stepSelection: { authority: "configured", steps: ["check"] },
      })
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)).rejects.toThrow(
      "PR 'PR1' is already in active queue run 'R1'",
    )
    expect(checkCalls).toBe(0)
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      stepSelection: { authority: "configured", steps: ["check"] },
    })
  })

  it("settles a stale revision and admits its resubmission in one explicit run", async () => {
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
    })
    const pr = await submitBranch(app, "issue/one-call-resubmit")
    const first = (await app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime))[0]
    expect(first).toMatchObject({ id: "R1", status: "waiting" })

    await app.bays.intake({ branch: pr.branch, headSha: UPDATED, base: "main" })
    await app.bays.submit({ pr: pr.id })
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      revision: 2,
      delivery: "submitted",
      headSha: UPDATED,
    })

    await expect(app.queue.run({ prs: [pr.id], steps: ["check", "merge"] }, runtime)).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        error: expect.objectContaining({ code: "stale-pr" }),
      }),
      expect.objectContaining({ id: "R2", status: "waiting" }),
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      revision: 2,
      delivery: "submitted",
      headSha: UPDATED,
    })
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
          return {
            status: "completed" as const,
            conclusion: "success" as const,
            output: { commit: MERGED, baseSha: BASE },
          }
        },
        deploy: () => {
          deployCalls += 1
          return { status: "completed" as const, conclusion: "success" as const, output: { environment: "staging" } }
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
          expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("integrated")
          expect(app.queue.get("R1")?.steps[1]?.job?.status).toBe("queued")
          await app.queue.pause({ base: "main", reason: "maintenance", allowedPRs: [] })
        }
      }

      await using replayed = await createQueueApp(options, journal, undefined, id)
      await expect(replayed.queue.run({}, runtime)).resolves.toEqual([
        expect.objectContaining({ id: "R1", status: "completed", conclusion: "success" }),
      ])
      await expect(replayed.queue.run({}, runtime)).resolves.toEqual([])
      expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
      expect(deliveryOf(replayed.state().bays.prs.PR1)).toBe("integrated")
      expect(mergeCalls).toBe(1)
      expect(deployCalls).toBe(crashPoint === "post-merge-requested" ? 1 : 0)
    },
  )

  it("resumes one waiting deploy-only run for an already integrated PR without admitting a duplicate", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let deployCalls = 0
    const options = {
      deploy: () => {
        deployCalls += 1
        return { status: "waiting" as const, token: "deploy-pending" }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/deploy-only-resume")
      await expect(app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).resolves.toMatchObject([
        { id: "R1", status: "completed", conclusion: "success" },
      ])
      expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("integrated")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["deploy"] })
      expect(app.queue.get("R2")).toMatchObject({ status: "queued", steps: [{ name: "deploy" }] })
      expect(activeQueueRootIds(app.state().queues.authority)).toEqual(["R2"])
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({ prs: ["PR1"], steps: ["deploy"] }, runtime)).resolves.toMatchObject([
      { id: "R2", status: "waiting" },
    ])
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual(["R2"])
    expect(deployCalls).toBe(1)
  })

  it.each([10, 10_000, 100_000])("allocates a Queue run id without enumerating %i historical records", (size) => {
    let enumerations = 0
    const records = new Proxy<Record<string, QueueRecord>>(
      {},
      {
        ownKeys() {
          enumerations += 1
          return Array.from({ length: size }, (_, index) => `R${index + 1}`)
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true }
        },
      },
    )
    const state = {
      ...Queues.empty({ batchSize: 1 }),
      records,
      index: { ...emptyQueueProjectionIndex(), nextRunNumber: size + 1 },
    }

    expect(Queues.nextId(state as Parameters<typeof Queues.nextId>[0])).toBe(`R${size + 1}`)
    expect(enumerations).toBe(0)
  })

  it("returns a replayed running Job without stealing it or admitting same-base intake", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
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
      expect.objectContaining({ id: "R1", status: "in_progress" }),
    ])
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
    expect(deliveryOf(replayed.state().bays.prs.PR2)).toBe("submitted")
    expect(checkCalls).toBe(0)
  })

  it("recovers an expired batch without executing, bisecting, or landing", async () => {
    let checkCalls = 0
    let mergeCalls = 0
    await using app = await createQueueApp({
      batch: 2,
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
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
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(deliveryOf(app.state().bays.prs[first.id])).toBe("submitted")
    expect(deliveryOf(app.state().bays.prs[second.id])).toBe("submitted")
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)

    const settled = await Array.fromAsync(app.events())
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(app.events())).toEqual(settled)
  })

  it("reconciles a named dead runner's live-leased run and ignores other runners", async () => {
    let checkCalls = 0
    await using app = await createQueueApp({
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/dead-resident")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["check", "merge"] })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("expected requested check")
    // A LIVE lease far in the future: only the named-runner reclaim releases it.
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "yrd-cli:4242",
      leaseExpiresAt: "2026-01-01T01:00:00.000Z",
    })

    // A different runner's reclaim leaves the live lease alone.
    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:00:30.000Z", runner: "yrd-cli:9999" }),
    ).resolves.toEqual([])
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "in_progress", runner: "yrd-cli:4242" })

    // The dead runner's reclaim releases the run and advances it to a terminal failure.
    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:00:30.000Z", runner: "yrd-cli:4242" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(checkCalls).toBe(0)
  })

  it("releases a replayed lost job before an explicit same-revision retry", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return {
          status: "completed" as const,
          conclusion: "success" as const,
          output: { commit: MERGED, baseSha: BASE },
        }
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
      expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("submitted")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "completed", conclusion: "failure" }),
    ])
    expect(deliveryOf(replayed.state().bays.prs.PR1)).toBe("submitted")
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    const appended = (await Array.fromAsync(replayed.events())).slice(before.length)
    expect(appended).toMatchObject([
      {
        name: "queue/run/failed",
        data: {
          run: "R1",
          error: { code: "job-lost" },
          prs: [{ pr: "PR1", revision: 1, headSha: HEAD, actor: "operator" }],
        },
      },
    ])
    const failed = appended[0]
    if (failed === undefined) throw new Error("expected job loss to append queue/run/failed")
    const authority = Queues.authorityRun(replayed.state().queues.authority, "R1")
    expect(authority?.released).toEqual({ reason: "job-lost", ref: failed.id })
    expect(appended.map(({ name }) => name)).not.toContain("pr/rejected")

    const reconciled = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:03:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(replayed.events())).toEqual(reconciled)

    const retried = await replayed.queue.run({ prs: ["PR1"], steps: ["check", "merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      { id: "R2", status: "completed", conclusion: "success", prs: [{ id: "PR1", revision: 1, headSha: HEAD }] },
    ])
    expect(prFacts(replayed.state().bays.prs.PR1)).toMatchObject({
      delivery: "integrated",
      revision: 1,
      headSha: HEAD,
    })
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])
    expect(checkCalls).toBe(1)
    expect(mergeCalls).toBe(1)
  })

  it("cooperatively aborts a claimed Job when a closed PR terminalizes its Queue Run", async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const log = createLogger("yrd", [{ level: "trace" }, { write: () => {} }])
    await using app = await createQueueApp(
      {
        check: async (_input, context) => {
          started.resolve()
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              aborted.resolve()
              resolve()
            }
            if (context.signal.aborted) onAbort()
            else context.signal.addEventListener("abort", onAbort, { once: true })
          })
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "issue/claimed-cancel")
    const running = app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
    await started.promise

    await app.bays.closePr({ pr: pr.id })
    await expect(app.queue.cancel({ prs: [pr.id], by: "@chief", reason: "PR withdrawn" })).resolves.toMatchObject([
      {
        status: "completed",
        conclusion: "failure",
        steps: [{ job: { status: "completed", conclusion: "cancelled", attempt: 1, runner: "local" } }],
      },
    ])

    await aborted.promise
    await expect(running).resolves.toMatchObject([{ status: "completed", conclusion: "failure" }])
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
    const revision = currentPRRev(pr)
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
          revision: revision.n,
          headSha: revision.head,
          run: "R1",
          correlation,
          actor: "operator",
          by: "@chief",
          reason: "authorization revoked",
        },
      },
    ])
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      delivery: "canceled",
      revision: revision.n,
      headSha: revision.head,
      correlation,
      revs: [
        {
          n: revision.n,
          head: revision.head,
          terminal: { kind: "canceled", at: "2026-01-01T00:00:00.000Z" },
        },
      ],
    })
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      error: { code: "run-canceled" },
      prs: [{ id: pr.id, revision: revision.n, headSha: revision.head, correlation }],
      steps: [
        expect.objectContaining({
          job: expect.objectContaining({
            status: "completed",
            conclusion: "cancelled",
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
      status: "completed",
      conclusion: "cancelled",
      prs: [{ id: pr.id, revision: revision.n, headSha: revision.head, correlation }],
    })
    expect(prFacts(replayed.state().bays.prs[pr.id])).toMatchObject({
      delivery: "canceled",
      revs: [{ terminal: { kind: "canceled", at: "2026-01-01T00:00:00.000Z" } }],
    })
  })

  it("keys a selected step suffix by run order rather than installed order", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/selected-suffix")

    const run = (await app.queue.run({ prs: [pr.id], steps: ["merge", "deploy"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      steps: [{ name: "merge" }, { name: "deploy" }],
      shape: { integration: { commit: MERGED }, results: { deploy: { environment: "staging" } } },
    })
    expect(Queues.get(app.state().queues, "R1")?.steps).toEqual([
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
      deploy: (input) => ({ status: "completed", conclusion: "success", output: { environment: input.prs[0]!.base } }),
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
        status: "completed",
        conclusion: "success",
        shape: {
          results: {
            check: { checked: true },
            review: { approved: true },
            deploy: { environment: run.base },
          },
          integration: { commit: MERGED, baseSha: BASE },
        },
      })
      expect(run.steps.every((step) => step.job?.status === "completed" && step.job.conclusion === "success")).toBe(
        true,
      )
      expect(
        run.steps.every(
          (step) =>
            step.job?.status === "completed" &&
            step.job.conclusion === "success" &&
            step.job.startedAt !== "" &&
            step.job.finishedAt !== "",
        ),
      ).toBe(true)
      const record = Queues.get(app.state().queues, run.id)
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

    expect(run).toMatchObject({ status: "completed", conclusion: "success", integration: { commit: MERGED } })
    expect(reconciled.events).toEqual([
      expect.objectContaining({ name: "pr/integrated", data: expect.objectContaining({ pr: "PR2" }) }),
    ])
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      delivery: "integrated",
      integration: run?.integration,
    })
    expect(prFacts(app.state().bays.prs.PR2)).toMatchObject({
      delivery: "integrated",
      integration: run?.integration,
    })
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
    expect(prFacts(app.state().bays.prs.PR2)).toMatchObject({ delivery: "canceled", canceledBy: "@chief" })
  })

  it("does not reconcile a same-root PR with a different source composition", async () => {
    await using app = await createQueueApp()
    const composition = (tip: string) => ({
      version: 1 as const,
      sources: [
        {
          repo: "vendor/example",
          branch: `issue/source-${tip[0]}`,
          baseSha: "2".repeat(40),
          tipSha: tip,
          payload: [`src/${tip[0]}.ts`],
        },
      ],
    })
    await app.bays.submit({
      branch: "issue/root-a",
      base: "main",
      headSha: HEAD,
      composition: composition("3".repeat(40)),
    })
    await app.bays.submit({
      branch: "issue/root-b",
      base: "main",
      headSha: HEAD,
      composition: composition("4".repeat(40)),
    })

    const run = (await app.queue.run({ prs: ["PR1"], steps: ["check", "review", "merge"] }, runtime))[0]

    expect(run).toMatchObject({ status: "completed", conclusion: "success", integration: { commit: MERGED } })
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      delivery: "integrated",
      integration: run?.integration,
    })
    expect(prFacts(app.state().bays.prs.PR2)).toMatchObject({ delivery: "submitted" })
    expect(app.state().bays.prs.PR2?.integration).toBeUndefined()
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

    expect(Queues.get(app.state().queues, "R1")).toBeDefined()
    expect(Queues.ids(app.state().queues)).toHaveLength(1)
  })

  it("admits configured checks through Queue once and reuses their journaled result for integration", async () => {
    let checks = 0
    await using app = await createQueueApp({
      check: () => {
        checks++
        return { status: "completed", conclusion: "success", output: { checked: true } }
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
      status: "queued",
      prs: [{ id: pr.id, headSha: pr.headSha }],
      steps: [{ name: "check" }, { name: "review" }],
    })
    expect(checks).toBe(0)
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "checking" },
      checks: { status: "checking", run: "R1" },
    })

    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
    expect(checks).toBe(1)
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: true,
      checks: { status: "passed", run: "R1" },
    })

    const integrated = (await app.queue.run({ prs: [pr.id] }, runtime))[0]
    expect(integrated).toMatchObject({
      id: "R2",
      status: "completed",
      conclusion: "success",
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
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/queue-owned-drain")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.queue.admit({ prs: [pr.id] })).toHaveLength(1)
    expect(checks).toBe(0)

    const integrated = await app.queue.run({ prs: [pr.id] }, runtime)

    expect(integrated).toMatchObject([{ id: "R2", status: "completed", conclusion: "success", reusedFrom: "R1" }])
    expect(checks).toBe(1)
  })

  it("bounds environment-refused admission retries and parks unchanged check authority", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let refuseEnvironment = true
    let checks = 0
    const options = {
      resolveBaseSha: () => BASE,
      check: () => {
        checks++
        return refuseEnvironment
          ? {
              status: "completed",
              conclusion: "failure",
              error: {
                code: "queue-environment-refused",
                message: "inherited-red check environment is unavailable",
              },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } }
      },
    } satisfies Parameters<typeof queuePlugin>[0]
    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/bounded-admission-retry")
      await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })

      let drainTurns = 0
      const refused = await app.queue.run({ prs: [pr.id] }, { ...runtime, continueAdmissions: () => ++drainTurns <= 6 })

      expect(refused.map(({ id }) => id)).toEqual(["R1", "R2"])
      expect(checks).toBe(2)
      expect(app.queue.eligibility(pr.id)).toMatchObject({
        runnable: false,
        reason: { code: "checks-failed" },
        checks: { status: "failed", run: "R2" },
      })
      expect(
        (await Array.fromAsync(app.events()))
          .filter(({ name }) => name === "queue/run/failed")
          .map(({ data }) => (data as Readonly<{ run: string }>).run),
      ).toEqual(["R1", "R2"])
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    expect(replayed.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "checks-failed" },
      checks: { status: "failed", run: "R2" },
    })

    let residentTurns = 0
    expect(await replayed.queue.run({}, { ...runtime, continueAdmissions: () => ++residentTurns <= 3 })).toEqual([])
    expect(checks).toBe(2)
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])

    refuseEnvironment = false
    await replayed.bays.requestChecks({ pr: "PR1", baseSha: BASE })
    expect(await replayed.queue.run({ prs: ["PR1"] }, runtime)).toMatchObject([
      { id: "R4", status: "completed", conclusion: "success", reusedFrom: "R3" },
    ])
    expect(checks).toBe(3)
  })

  it("does not let an unrelated waiting admission monopolize Queue capacity", async () => {
    await using app = await createQueueApp({
      check: (input) =>
        input.prs[0]?.id === "PR1"
          ? { status: "waiting", token: "remote-one" }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    })
    const waiting = await submitBranch(app, "issue/waiting-check")
    const healthy = await submitBranch(app, "issue/healthy-check")
    await app.bays.requestChecks({ pr: waiting.id })
    await app.bays.requestChecks({ pr: healthy.id })

    expect(await app.queue.admit({ prs: [waiting.id] }, runtime)).toMatchObject([
      { status: "waiting", prs: [{ id: waiting.id }] },
    ])
    expect(await app.queue.admit({ prs: [healthy.id] }, runtime)).toMatchObject([
      { status: "completed", conclusion: "success", prs: [{ id: healthy.id }] },
    ])
    expect(app.queue.eligibility(waiting.id)).toMatchObject({ checks: { status: "checking" } })
    expect(app.queue.eligibility(healthy.id)).toMatchObject({ checks: { status: "passed" } })
  })

  it("does not supersede another PR's unstarted admission for an explicit merge", async () => {
    let checkCalls = 0
    let mergeCalls = 0
    await using app = await createQueueApp({
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const first = await submitBranch(app, "issue/first-admission")
    const second = await submitBranch(app, "issue/second-merge")
    await app.bays.requestChecks({ pr: first.id })
    expect(await app.queue.admit({ prs: [first.id] })).toMatchObject([
      { id: "R1", status: "queued", prs: [{ id: first.id }] },
    ])
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "queued" })

    await expect(app.queue.run({ prs: [second.id], steps: ["merge"] }, runtime)).rejects.toThrow(
      "queue 'main' is running 'R1'",
    )
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect(app.queue.get("R1")).toMatchObject({ status: "queued", prs: [{ id: first.id }] })
    expect(prFacts(app.state().bays.prs[second.id])).toMatchObject({ delivery: "submitted" })
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
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/base-keyed-cache")
    await app.bays.requestChecks({ pr: pr.id })
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
    expect(checks).toBe(1)

    baseSha = UPDATED
    const integrated = await app.queue.run({ prs: [pr.id] }, runtime)

    expect(integrated).toMatchObject([{ status: "completed", conclusion: "success", reusedFrom: "R2" }])
    expect(checks).toBe(2)
    expect(checkedBases).toEqual([BASE, UPDATED])
    expect(app.queue.get("R2")?.prs).toMatchObject([{ baseSha: UPDATED }])
  })

  it("resolves each queue base once per cycle instead of once per PR", async () => {
    const resolvedBases: string[] = []
    await using app = await createQueueApp({
      batch: 4,
      resolveBaseSha: (base) => {
        resolvedBases.push(base)
        return BASE
      },
    })
    const prs = [
      await submitBranch(app, "issue/main-a"),
      await submitBranch(app, "issue/main-b", "origin/main"),
      await submitBranch(app, "issue/release-a", "release"),
      await submitBranch(app, "issue/release-b", "refs/heads/release"),
    ]
    for (const pr of prs) await app.bays.requestChecks({ pr: pr.id })

    await app.queue.run({ prs: prs.map((pr) => pr.id) }, runtime)

    expect(resolvedBases).toEqual(["main", "release"])
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
          return {
            status: "completed",
            conclusion: "failure",
            error: { code: "base-red", message: "same-base main-health lock is red" },
          }
        }
        mainHealth = "green"
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      merge: () => {
        merges++
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/main-health-turns-red")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })

    expect(mainHealth).toBe("clear")
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toMatchObject([
      { id: "R1", status: "completed", conclusion: "success", prs: [{ baseSha: BASE }] },
    ])
    expect(mainHealth).toBe("green")
    expect(checks).toBe(1)

    mainHealth = "red"
    const refused = await app.queue.run({ prs: [pr.id] }, runtime)

    expect(refused).toMatchObject([
      {
        id: "R2",
        status: "completed",
        conclusion: "failure",
        prs: [{ baseSha: BASE }],
      },
    ])
    expect(refused[0]?.steps[0]).toMatchObject({
      name: "check",
      classification: "base",
      job: { status: "completed", conclusion: "failure", error: { code: "base-red" } },
    })
    expect(refused[0]).not.toHaveProperty("reusedFrom")
    expect(checks).toBe(2)
    expect(merges).toBe(0)
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      delivery: "submitted",
      state: "open",
      merged: false,
    })
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
      { status: "completed", conclusion: "failure", error: { code: "stale-pr" } },
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
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const first = await submitBranch(app, "issue/first-check")
    const second = await submitBranch(app, "issue/second-check")
    await app.bays.requestChecks({ pr: first.id })
    await app.bays.requestChecks({ pr: second.id })

    expect(app.queue.eligibility(second.id)).toMatchObject({ checks: { status: "queued", position: 2 } })
    expect(await app.queue.admit({ prs: [second.id] })).toEqual([])
    expect(await app.queue.admit({}, runtime)).toMatchObject([
      { status: "completed", conclusion: "success", prs: [{ id: first.id }] },
      { status: "completed", conclusion: "success", prs: [{ id: second.id }] },
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
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
      },
      journal,
      () => "2026-01-01T00:00:00.000Z",
      ids(100),
    )
    const readmission = (await changed.queue.admit({ prs: [pr.id] }))[0]
    if (readmission === undefined) throw new Error("expected a cache-miss admission run")
    expect(readmission).toMatchObject({
      status: "queued",
      steps: [{ name: "check", revision: "check-v2" }, { name: "review" }],
    })
    await changed.queue.admit({ prs: [pr.id] }, runtime)

    const integrated = (await changed.queue.run({ prs: [pr.id] }, runtime))[0]
    expect(integrated).toMatchObject({
      status: "completed",
      conclusion: "success",
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
              status: "completed" as const,
              conclusion: "failure" as const,
              error: {
                code: "queue-environment-refused",
                message: "merge environment is temporarily unavailable",
              },
            }
          : { status: "completed" as const, conclusion: "success" as const, output: { commit: MERGED, baseSha: BASE } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/environment-refused")

      expect(await app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).toMatchObject([
        {
          id: "R1",
          status: "completed",
          conclusion: "failure",
          error: { code: "queue-environment-refused" },
          prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha }],
        },
      ])
      expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
        delivery: "submitted",
        revision: pr.revision,
        headSha: pr.headSha,
      })

      const events = await Array.fromAsync(app.events())
      const failed = events.find(
        (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
      )
      if (failed === undefined) throw new Error("expected the environment refusal to append queue/run/failed")
      const authority = Queues.authorityRun(app.state().queues.authority, "R1")
      expect(authority?.released).toEqual({ reason: "queue-environment-refused", ref: failed.id })
      expect(events.map(({ name }) => name)).not.toContain("pr/rejected")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const replayedEvents = await Array.fromAsync(replayed.events())
    const replayedFailure = replayedEvents.find(
      (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
    )
    if (replayedFailure === undefined) throw new Error("expected replay to retain queue/run/failed")
    const replayedAuthority = Queues.authorityRun(replayed.state().queues.authority, "R1")
    expect(replayedAuthority?.released).toEqual({
      reason: "queue-environment-refused",
      ref: replayedFailure.id,
    })

    const retried = await replayed.queue.run({ prs: ["PR1"], steps: ["merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      {
        id: "R2",
        status: "completed",
        conclusion: "success",
        prs: [{ id: "PR1", revision: 1, headSha: HEAD }],
      },
    ])
    expect(prFacts(replayed.state().bays.prs.PR1)).toMatchObject({
      delivery: "integrated",
      revision: 1,
      headSha: HEAD,
    })
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])
    expect(mergeCalls).toBe(2)
  })

  it("keeps a failed Candidate consumed until a new revision supplies submit authority", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "merge-conflict", message: "payload does not merge" },
            }
          : { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/merit-rejection")

    expect(await app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure", error: { code: "merge-conflict" } },
    ])
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      delivery: "submitted",
      state: "open",
      merged: false,
      revision: pr.revision,
      headSha: pr.headSha,
    })
    expect(Queues.authorityRun(app.state().queues.authority, "R1")).not.toHaveProperty("released")
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).not.toContain("pr/rejected")

    const beforeRetry = await Array.fromAsync(app.events())
    await expect(app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)).rejects.toThrow(
      /submit authority was consumed/iu,
    )
    expect(await Array.fromAsync(app.events())).toEqual(beforeRetry)
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(mergeCalls).toBe(1)

    await app.bays.intake({ branch: pr.branch, headSha: UPDATED, base: pr.base, baseSha: BASE })
    await app.bays.submit({ pr: pr.id })
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      delivery: "submitted",
      revision: 2,
      headSha: UPDATED,
    })

    const revised = await app.queue.run({ prs: [pr.id], steps: ["merge"] }, runtime)
    const newRuns = revised.filter(({ id: run }) => run === "R2")
    expect(newRuns).toHaveLength(1)
    expect(newRuns).toMatchObject([
      { id: "R2", status: "completed", conclusion: "success", prs: [{ id: pr.id, revision: 2, headSha: UPDATED }] },
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
    expect(prFacts(app.state().bays.prs[pr.id])).toMatchObject({
      delivery: "integrated",
      revision: 2,
      headSha: UPDATED,
    })
    expect(mergeCalls).toBe(2)
  })

  it("audits a failed revision retry without fresh submit ancestry and keeps authorized controls clean", async () => {
    const journal = createMemoryJournal<unknown>()
    const original = await createQueueApp(
      {
        check: () => ({
          status: "completed",
          conclusion: "failure",
          error: { code: "check-failed", message: "reject R1" },
        }),
      },
      journal,
    )
    const retried = await submitBranch(original, "issue/retry-without-submit")
    const first = (await original.queue.run({ prs: [retried.id] }, runtime))[0]
    if (first === undefined) throw new Error("expected authorized R1")
    expect(first).toMatchObject({ id: "R1", status: "completed", conclusion: "failure" })
    expect(deliveryOf(original.state().bays.prs[retried.id])).toBe("submitted")
    const firstRecord = Queues.get(original.state().queues, "R1")
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
    expect(legacyRetry).toMatchObject({ status: "completed", conclusion: "failure", prs: [{ id: retried.id }] })
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
    expect(deliveryOf(app.state().bays.prs.PR3)).toBe("pushed")

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
    "refuses stale revision-one %s before projecting a terminal receipt",
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
      expect(prFacts(original.state().bays.prs[stale.id])).toMatchObject({ revision: 2, headSha: UPDATED })
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

      await expect(createQueueApp({}, journal, undefined, ids(500))).rejects.toThrow(
        new RegExp(`stale terminal '${terminal}'.*${stale.id}`, "iu"),
      )
    },
  )

  it("reauthorizes a failed draft admission through a fresh exact check request", async () => {
    let fail = true
    await using app = await createQueueApp({
      check: (input) =>
        fail && input.prs[0]?.id === "PR1"
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "typecheck-failed", message: "src/model.ts:12 failed" },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    })
    await app.bays.submit({ branch: "issue/draft-red", headSha: HEAD, base: "main", baseSha: BASE, draft: true })
    await app.bays.requestChecks({ pr: "PR1" })
    const admitted = (await app.queue.admit({ prs: ["PR1"] }))[0]
    if (admitted === undefined) throw new Error("expected an admission run")
    expect(await app.queue.admit({ prs: ["PR1"] }, runtime)).toMatchObject([
      { status: "completed", conclusion: "failure" },
    ])
    expect(deliveryOf(app.state().bays.prs.PR1)).toBe("pushed")

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
    expect(readmitted).toMatchObject({
      id: "R2",
      status: "completed",
      conclusion: "success",
      prs: [{ id: "PR1", headSha: HEAD }],
    })
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: true,
      checks: { status: "passed", run: "R2" },
    })
  })

  it("indexes a released canceled admission exactly like the former terminal scan", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/canceled-admission-index")
    await app.bays.requestChecks({ pr: pr.id })
    const admitted = (await app.queue.admit({ prs: [pr.id] }))[0]
    if (admitted?.prs[0] === undefined) throw new Error("expected admission run")
    expect(releasedAdmissionFailures(app.state().queues.index, admitted.prs[0], admitted.steps)).toBe(0)

    await app.queue.cancelRun({ run: admitted.id, by: "operator", reason: "replace runner" })

    expect(releasedAdmissionFailures(app.state().queues.index, admitted.prs[0], admitted.steps)).toBe(1)
    expect(Queues.authorityRun(app.state().queues.authority, admitted.id)?.released).toMatchObject({
      reason: "run-canceled",
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
    expect(Queues.ids(first.state().queues)).toEqual([])
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
    expect(Queues.ids(app.state().queues)).toEqual([])
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
    expect(deliveryOf(app.state().bays.prs.PR11)).toBe("submitted")
    expect(deliveryOf(app.state().bays.prs.PR23)).toBe("submitted")
    await app.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: ["PR23"] })

    const runs = await app.queue.run({}, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR23"]])
    expect(deliveryOf(app.state().bays.prs.PR11)).toBe("submitted")
    expect(deliveryOf(app.state().bays.prs.PR23)).toBe("integrated")
  })

  it("keeps completed history readable and refuses queued work after revision drift", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    await first.bays.submit({ branch: "issue/completed", headSha: HEAD, base: "main" })
    const completed = await first.queue.run({ prs: ["PR1"], steps: ["check"] }, runtime)
    await first.bays.submit({ branch: "issue/queued", headSha: UPDATED, base: "main" })
    const queued = await first.dispatch(first.commands.queue.run, {
      prs: ["PR2"],
      steps: ["check"],
      baseSha: BASE,
    })
    const queuedJob = first.jobs.requested(queued)[0]
    if (queuedJob === undefined) throw new Error("queue did not request a Job")
    await first.close()

    let changedExecutions = 0
    const changed = await createQueueApp(
      {
        checkRevision: "check-v2",
        check: () => {
          changedExecutions++
          return { status: "completed", conclusion: "success", output: { checked: false } }
        },
      },
      journal,
    )
    expect(changed.queue.get(completed[0]!.id)).toMatchObject({
      status: "completed",
      conclusion: "success",
      shape: { results: { check: { checked: true } } },
    })
    await expect(changed.jobs.run(queuedJob, runtime)).rejects.toThrow("definition revision")
    expect(changedExecutions).toBe(0)
    await changed.close()

    const bayJobs = createBayJobDefs(workspace())
    const withoutSteps = withQueue({ steps: [] as const })
    const historyBase = pipe(createYrdDef(), withJobs({ definitions: bayJobs }), withBays({ jobs: bayJobs }))
    await using history = await createYrd(withoutSteps(historyBase), { inject: { journal } })
    expect(history.queue.get(completed[0]!.id)).toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("leaves a pre-merge failure open but preserves integration when deployment fails", async () => {
    let merged = false
    await using rejectedApp = await createQueueApp({
      check: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "tests failed" },
      }),
      merge: () => {
        merged = true
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const rejected = await submitBranch(rejectedApp, "issue/rejected")
    expect((await rejectedApp.queue.run({ prs: [rejected.id] }, runtime))[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-failed" },
    })
    expect(merged).toBe(false)
    expect(prFacts(rejectedApp.state().bays.prs[rejected.id])).toMatchObject({
      delivery: "submitted",
      state: "open",
      merged: false,
    })
    await rejectedApp.bays.intake({ branch: "issue/rejected", headSha: UPDATED, base: "main" })
    await rejectedApp.bays.submit({ pr: rejected.id })
    expect(prFacts(rejectedApp.state().bays.prs[rejected.id])).toMatchObject({
      delivery: "submitted",
      revision: 2,
      headSha: UPDATED,
      revs: [
        { n: 1, head: HEAD },
        { n: 2, head: UPDATED },
      ],
    })

    let deployAttempts = 0
    await using deployApp = await createQueueApp({
      batch: 2,
      deploy: () => {
        deployAttempts += 1
        return deployAttempts === 1
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "deploy-failed", message: "staging unavailable" },
            }
          : { status: "completed", conclusion: "success", output: { environment: "staging" } }
      },
    })
    const deployed = await submitBranch(deployApp, "issue/deploy-fails")
    const companion = await submitBranch(deployApp, "issue/deploy-companion")
    const run = (await deployApp.queue.run({ prs: [deployed.id, companion.id] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "deploy-failed" } })
    expect(deliveryOf(deployApp.state().bays.prs[deployed.id])).toBe("integrated")
    expect(deliveryOf(deployApp.state().bays.prs[companion.id])).toBe("integrated")

    const deployJob = run?.steps.find((step) => step.name === "deploy")?.job
    if (deployJob === undefined) throw new Error("expected failed post-merge action Job")
    expect(deployJob).toMatchObject({ status: "completed", conclusion: "failure" })
    await deployApp.jobs.retry(deployJob.id)

    const retried = (await deployApp.queue.run({ prs: [deployed.id, companion.id] }, runtime))[0]
    expect(retried).toMatchObject({ status: "completed", conclusion: "success" })
    expect(deliveryOf(deployApp.state().bays.prs[deployed.id])).toBe("integrated")
    expect(deliveryOf(deployApp.state().bays.prs[companion.id])).toBe("integrated")
    expect(deployAttempts).toBe(2)
  })

  it("allows unrelated work while waiting and refuses a completed stale revision", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: (input) =>
        input.prs[0]?.branch === "issue/next"
          ? { status: "completed", conclusion: "success", output: { checked: true } }
          : { status: "waiting", token: `remote-${input.prs[0]?.id}` },
      merge: () => {
        merges++
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
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
    expect((await app.queue.run({ prs: [next.id] }, runtime))[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    })

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
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).toMatchObject({
      status: "completed",
      conclusion: "failure",
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
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow("no waiting 'check' step")
    expect(merges).toBe(1)
    expect(prFacts(app.state().bays.prs[remote.id])).toMatchObject({
      revision: 2,
      headSha: UPDATED,
      delivery: "pushed",
    })
  })

  it("refuses a delayed completion from an earlier attempt when a retry reuses its token", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
      merge: () => {
        merges += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
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
      result: {
        status: "completed",
        conclusion: "failure",
        error: { code: "remote-failed", message: "retry requested" },
      },
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
      result: { status: "completed" as const, conclusion: "success" as const, output: { checked: true } },
    }
    await expect(app.queue.finish(pr.id, delayedAttemptOne, runtime)).rejects.toThrow("attempt 1 is stale")

    expect(app.queue.get(first!.id)?.steps[0]?.job).toMatchObject({
      status: "waiting",
      attempt: 2,
      runner: "runner-2",
    })
    expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("submitted")
    expect(merges).toBe(0)
  })

  it("refuses a delayed completion from an earlier Job with the same owner credential", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
      merge: () => {
        merges += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
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
      result: {
        status: "completed",
        conclusion: "failure",
        error: { code: "remote-failed", message: "resubmit requested" },
      },
    })
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:03:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: first?.id, status: "completed", conclusion: "failure" }),
    ])
    expect(app.queue.get(first!.id)).toMatchObject({ status: "completed", conclusion: "failure" })

    await app.bays.intake({ branch: pr.branch, headSha: UPDATED, base: "main" })
    await app.bays.submit({ pr: pr.id })
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
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow(firstJob.id)
    expect(app.queue.get(second!.id)?.steps[0]?.job).toMatchObject({ id: secondJob.id, status: "waiting" })
    expect(deliveryOf(app.state().bays.prs[pr.id])).toBe("submitted")
    expect(merges).toBe(0)
  })

  it("recursively bisects a red batch while the isolated failing PR stays open", async () => {
    const checked: string[][] = []
    await using app = await createQueueApp({
      batch: 4,
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        const digit = input.id.slice(1)
        return {
          ...candidate,
          sha: digit.repeat(40).slice(0, 40),
          ref: `refs/yrd/candidates/${input.id}`,
          mergeability: "mergeable",
        }
      },
      check: (input) => {
        const prs = input.prs.map((pr) => pr.id)
        checked.push(prs)
        return prs.includes("PR3")
          ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "bad PR" } }
          : { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    await submitBranch(app, "issue/one")
    await submitBranch(app, "issue/two")
    await submitBranch(app, "issue/bad")
    await submitBranch(app, "issue/four")

    const runs = await app.queue.run({ prs: [] }, runtime)

    expect(checked).toEqual([["PR1", "PR2", "PR3", "PR4"], ["PR1", "PR2"], ["PR3", "PR4"], ["PR3"], ["PR4"]])
    expect(runs.map((run) => [run.prs.map((pr) => pr.id), run.conclusion])).toEqual([
      [["PR1", "PR2", "PR3", "PR4"], "failure"],
      [["PR1", "PR2"], "success"],
      [["PR3", "PR4"], "failure"],
      [["PR3"], "failure"],
      [["PR4"], "success"],
    ])
    expect(
      Object.values(app.state().queues.candidates).map((candidate) => ({
        id: candidate.id,
        revs: candidate.revs.map(({ pr }) => pr),
        sha: candidate.sha,
        ref: candidate.ref,
        mergeability: candidate.mergeability,
      })),
    ).toEqual([
      {
        id: "C1",
        revs: ["PR1", "PR2", "PR3", "PR4"],
        sha: "1".repeat(40),
        ref: "refs/yrd/candidates/C1",
        mergeability: "mergeable",
      },
      {
        id: "C2",
        revs: ["PR1", "PR2"],
        sha: "2".repeat(40),
        ref: "refs/yrd/candidates/C2",
        mergeability: "mergeable",
      },
      {
        id: "C3",
        revs: ["PR3", "PR4"],
        sha: "3".repeat(40),
        ref: "refs/yrd/candidates/C3",
        mergeability: "mergeable",
      },
      {
        id: "C4",
        revs: ["PR3"],
        sha: "4".repeat(40),
        ref: "refs/yrd/candidates/C4",
        mergeability: "mergeable",
      },
      {
        id: "C5",
        revs: ["PR4"],
        sha: "5".repeat(40),
        ref: "refs/yrd/candidates/C5",
        mergeability: "mergeable",
      },
    ])
    expect(runs.map(({ candidateId, parent }) => ({ candidateId, parent }))).toEqual([
      { candidateId: "C1", parent: undefined },
      { candidateId: "C2", parent: "R1" },
      { candidateId: "C3", parent: "R1" },
      { candidateId: "C4", parent: "R3" },
      { candidateId: "C5", parent: "R3" },
    ])
    for (const child of runs.slice(1)) expect(child).not.toHaveProperty("isolationPart")
    expect(Object.fromEntries(Object.values(app.state().bays.prs).map((pr) => [pr.id, prDeliveryState(pr)]))).toEqual({
      PR1: "integrated",
      PR2: "integrated",
      PR3: "submitted",
      PR4: "integrated",
    })
    expect(app.state().bays.prs.PR3).toMatchObject({ state: "open", merged: false })
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).not.toContain("pr/rejected")
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
          return {
            status: "completed",
            conclusion: "failure",
            error: { code: "check-failed", message: "batch is merit-red" },
          }
        }
        if (prs[0] === "PR1" && ++isolatedPR1Checks === 1) {
          return {
            status: "completed",
            conclusion: "failure",
            error: { code: "queue-environment-refused", message: "isolated runner unavailable" },
          }
        }
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const first = await submitBranch(app, "issue/environment-child")
    const second = await submitBranch(app, "issue/passing-child")

    const runs = await app.queue.run({ prs: [first.id, second.id] }, runtime)

    expect(runs).toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure", error: { code: "check-failed" } },
      {
        id: "R2",
        parent: "R1",
        status: "completed",
        conclusion: "failure",
        error: { code: "queue-environment-refused" },
      },
      { id: "R3", parent: "R1", status: "completed", conclusion: "success" },
    ])
    expect(checked).toEqual([["PR1", "PR2"], ["PR1"], ["PR2"]])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2", "R3"])
    expect(Object.fromEntries(Object.values(app.state().bays.prs).map((pr) => [pr.id, prDeliveryState(pr)]))).toEqual({
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
    expect(Queues.authorityRun(app.state().queues.authority, "R1")).not.toHaveProperty("released")
    expect(Queues.authorityRun(app.state().queues.authority, "R2")).toMatchObject({
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
        status: "completed",
        conclusion: "success",
        prs: [{ id: first.id, revision: first.revision, headSha: first.headSha }],
      },
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2", "R3", "R4"])
    expect(prFacts(app.state().bays.prs[first.id])).toMatchObject({
      delivery: "integrated",
      revision: first.revision,
      headSha: first.headSha,
    })
  })
})

describe("Queue — a peer-canceled Job mid-execution never kills the composing runner (merge-queue R43)", () => {
  it("records the raced settlement as a visible typed skip and keeps composing", async () => {
    const journal = createMemoryJournal()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const executing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<JobResult<{ checked: boolean }>>()
    let checks = 0
    await using app = await createQueueApp(
      {
        check: () => {
          checks += 1
          if (checks > 1) return { status: "completed", conclusion: "success", output: { checked: true } }
          executing.resolve()
          return release.promise
        },
      },
      journal,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "issue/peer-canceled")
    const running = app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)
    await executing.promise

    // A peer runtime over the same journal (a separate process in production)
    // cancels the PR while this runtime's step executes. This runtime's
    // projection stays stale until its settlement commit re-folds the journal,
    // where the finish transition meets the already-canceled Job.
    await using peer = await createQueueApp({}, journal, undefined, ids(1000))
    await peer.queue.cancel({ prs: [pr.id], by: "@peer", reason: "superseded" })

    release.resolve({ status: "completed", conclusion: "success", output: { checked: true } })
    const runs = await running
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ steps: [{ job: { status: "completed", conclusion: "cancelled" } }] })

    // The skip is LOUD and typed — never a silent swallow.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:queue",
        level: "warn",
        props: expect.objectContaining({
          action: "canceled-skip",
          run: runs[0]!.id,
          status: "completed",
          conclusion: "cancelled",
        }),
      }),
    )

    // The runner keeps processing subsequent work after the raced skip.
    const next = await submitBranch(app, "issue/after-cancel")
    await expect(app.queue.run({ prs: [next.id], steps: ["check"] }, runtime)).resolves.toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
  })

  it("still propagates settlement failures of a live Job loudly — the skip is terminal-state-verified, not a blanket catch", async () => {
    // Refuse exactly the finish-settlement append while the Job stays RUNNING:
    // a genuine infrastructure failure must escape the R43 skip and reject the
    // composing caller — proving the catch is narrow.
    const inner = createMemoryJournal()
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = value as { events?: readonly { name?: string; data?: { type?: string } }[] }
        if (frame.events?.some((event) => event.name === "job/transitioned" && event.data?.type === "finish")) {
          throw new Error("yrd: journal write refused (injected)")
        }
        return inner.append(value, cursor)
      },
    }
    await using app = await createQueueApp({}, journal)
    const pr = await submitBranch(app, "issue/journal-refused")
    await expect(app.queue.run({ prs: [pr.id], steps: ["check"] }, runtime)).rejects.toThrow(
      "journal write refused (injected)",
    )
  })
})
