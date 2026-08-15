/**
 * The composed CLI app the `yrd log` tests drive, with the journal left open as
 * a parameter.
 *
 * `log` is the one command whose behaviour depends on how the journal STORES
 * history rather than on what the queue holds: its coverage probe replays
 * frames, and `--all` replays every frame there has ever been. So its tests
 * come in pairs that share a composition and differ only in the journal behind
 * it — a counting memory journal to measure what a replay costs
 * (`log-replay-cost.test.ts`), a real SQLite journal with a retention window to
 * prove what it does once history has been evicted
 * (`log-evicted-history.test.ts`). This module is that shared half.
 */
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createYrd, createYrdDef, JsonSchema, pipe, type Journal, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd as runYrdRaw, type YrdCliIO } from "@yrd/cli"
import { withMerge, withQueue, withStep, type PRShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { withIntents } from "@yrd/intent"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import { createLogger } from "loggily"

export const HEAD_SHA = "1".repeat(40)
export const BASE_SHA = "a".repeat(40)
export const MERGED_SHA = "b".repeat(40)

export function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "log-app-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: HEAD_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/** Contest adapters the composed CLI app requires; nothing here enters a contest. */
function contestAdapters() {
  const runner: ContestRunnerDef = {
    id: "fixture",
    revision: "fixture-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      return {
        status: "completed",
        conclusion: "success",
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
          cost: { kind: "reported", usd: 0, source: "fixture" },
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
      return { status: "completed", conclusion: "success", output: { verdict: "passed", artifacts: [] } }
    },
  }
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  return { runner, evaluator, git }
}

export async function createCliApp(journal: Journal<unknown>, id: () => string = ids()) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (
      _input: StepExecution<PRShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
      status: "completed",
      conclusion: "success",
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
    withIntents(),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal,
      clock: () => "2026-07-09T12:00:00.000Z",
      id,
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

export type CliApp = Awaited<ReturnType<typeof createCliApp>>

export function outputIO() {
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
    runner: "log-app-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

export function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Append history the way the product does: submit PRs, so the journal grows
 * through real commands rather than hand-written frames. */
export async function appendHistory(app: CliApp, prefix: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const branch = `${prefix}/${String(index)}`
    // A distinct head per PR: identical payloads are refused as duplicates.
    const headSha = Bun.SHA1.hash(branch, "hex")
    await app.bays.submit({ branch, headSha, base: "main", baseSha: BASE_SHA })
  }
}

/** The attempt read model, stubbed to read nothing.
 *
 * Production's is view-backed: `createYrdHost` answers attempts out of the
 * journal's `queue_attempts` table, which is why a live `yrd log` shows exactly
 * one from-zero journal read and not two. The shared in-memory double
 * (`testQueueReadModel`) instead replays `app.events()` unbounded, which is
 * sound for the behaviour tests that use it and fatal for the replay-cost
 * measurement: it would dominate the frame count. Reading nothing keeps every
 * counted frame attributable to the CLI's own journal use — and keeps the
 * eviction tests measuring the CLI's own cursor-0 readers rather than the
 * double's. */
export function stubReadModel(app: CliApp) {
  return {
    async snapshot() {
      return { cursor: (await app.journalSnapshot()).asOf.cursor, generation: 0, attempts: [] }
    },
  }
}

/** Run one CLI invocation against the composed app and return what it wrote. */
export async function runLog(
  app: CliApp,
  ...args: string[]
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const output = outputIO()
  const code = await runYrdRaw(app, yrd(...args), output.io, { queueReadModel: stubReadModel(app) })
  return { code, stdout: output.stdout(), stderr: output.stderr() }
}
