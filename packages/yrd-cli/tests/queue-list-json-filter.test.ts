/**
 * @failure `queue list --json` ignores the display filters the human renderer honours, so `--status running --json` answers a different question than `--status running` — it emitted every retained run (669 runs / 14 MB on the live estate) while the same command without `--json` showed one row.
 * @level l2
 * @consumer @yrd/cli
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd, type YrdCliIO } from "@yrd/cli"
import { withMerge, withQueue, withStep, type PRShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"

const HEAD_SHA = "1".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "json-filter-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "passed" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "passed" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    deprovision: () => ({ status: "passed" as const, output: {} }),
  }
}

/** Contest adapters the composed CLI app requires; this listing never enters a contest. */
function contestAdapters() {
  const runner: ContestRunnerDef = {
    harness: "ag",
    revision: "ag-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      return {
        status: "passed",
        output: {
          pin: {
            commit: "c".repeat(40),
            ref: `refs/yrd/attempts/${input.contest}/${input.attempt}`,
            bay: input.bay.id,
            branch: input.bay.branch,
            baseSha: BASE_SHA,
          },
          wallTimeMs: 100,
          tokens: { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0 },
          cost: { kind: "reported", usd: 0, source: "ag" },
          artifacts: [],
        },
      }
    },
  }
  const evaluator: ContestEvaluatorDef = {
    id: "held-out",
    revision: "held-out-v1",
    authority: "held-out",
    async evaluate() {
      return { status: "passed", output: { verdict: "passed", artifacts: [] } }
    },
  }
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  return { runner, evaluator, git }
}

async function createCliApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep("check", (): JobResult<JsonValue> => ({ status: "passed", output: { checked: true } }), {
    revision: "check-v1",
    output: JsonSchema,
    classification: "carrier",
  })
  const merge = withMerge(
    async (
      _input: StepExecution<PRShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
      status: "passed",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const contest = contestAdapters()
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: { journal: createMemoryJournal(), clock: () => "2026-07-09T12:00:00.000Z", id: ids() },
  })
}

function outputIO(overrides: Partial<YrdCliIO> = {}) {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: "/repo",
    runner: "json-filter-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

type ListPayload = Readonly<{
  projection: Readonly<{ rows: readonly Readonly<{ run?: string }>[] }>
  results: readonly Readonly<{
    running: readonly Readonly<{ id: string }>[]
    waiting: readonly Readonly<{ id: string }>[]
    finished: readonly Readonly<{ id: string }>[]
  }>[]
}>

function resultRunIds(payload: ListPayload): string[] {
  return payload.results
    .flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
    .map((run) => run.id)
    .toSorted()
}

function projectedRunIds(payload: ListPayload): string[] {
  return [...new Set(payload.projection.rows.flatMap((row) => (row.run === undefined ? [] : [row.run])))].toSorted()
}

async function list(app: Awaited<ReturnType<typeof createCliApp>>, ...args: string[]): Promise<ListPayload> {
  const out = outputIO()
  expect(await runYrd(app, yrd("queue", "list", ...args, "--json"), out.io), out.stderr()).toBe(0)
  return JSON.parse(out.stdout()) as ListPayload
}

describe("queue list --json answers the same question as the human renderer", () => {
  it("applies --status to the JSON payload, not only to the rendered rows", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/landed", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.queue.run({ prs: ["PR1"] }, { runner: "json-filter-test", leaseMs: 60_000 })
    await app.bays.submit({ branch: "topic/pending", headSha: "2".repeat(40), base: "main", baseSha: BASE_SHA })

    const all = await list(app)
    expect(resultRunIds(all), "the unfiltered listing must still carry the finished run").toContain("R1")

    const running = await list(app, "--status", "running")
    expect(projectedRunIds(running), "the finished run is not running").toEqual([])
    expect(resultRunIds(running), "--status must filter the JSON payload too").toEqual([])

    const integrated = await list(app, "--status", "integrated")
    expect(projectedRunIds(integrated)).toEqual(["R1"])
    expect(resultRunIds(integrated)).toEqual(["R1"])
  })
})
