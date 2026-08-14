/**
 * @failure One `yrd log` invocation decodes every frame the journal holds, so the command's cost grows with the journal's age rather than with the rows it prints — the cold-replay defect `@yrd/core/21012-monorepo/21566-journal-sqlite-container-swap` closed once already and that regrew as the journal did.
 * @level l2
 * @consumer @yrd/cli
 *
 * WHY FRAMES AND NOT MILLISECONDS. The prior fix for this defect had no
 * regression pin at all, which is why journal growth silently re-created it and
 * the bead came back `#undead`. A wall-clock assertion would be the obvious pin
 * and the wrong one: this repo's tests run alongside dozens of live agents, so a
 * millisecond budget either flakes under load or is set so loose it stops
 * catching anything. Frames decoded per invocation is the same quantity without
 * the load sensitivity — it is what actually grew (11,878 frames in 2026-07,
 * 42,011 today) and what the fix bounds.
 *
 * WHAT THE ASSERTION IS. Not "under N frames" — a constant is a number someone
 * has to keep true. The invariant is that the count does NOT move when the
 * journal does: measure one `log` invocation, append more history, measure
 * again, and require the same count. At the base this file was written against,
 * both counts equalled their journal's whole size, so growing the journal grew
 * the read; that is exactly the shape this refuses.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type Journal, type JsonValue } from "@yrd/core"
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

const HEAD_SHA = "1".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

/** A memory journal that counts the frames its reads hand back, so a test can
 * ask what one CLI invocation cost the journal rather than what it cost the
 * clock. Counting at `read` covers every consumer — projection fold, coverage
 * probe, history scan — because they all come through this one method. */
function countingJournal() {
  const inner = createMemoryJournal<unknown>()
  let frames = 0
  const journal: Journal<unknown> = {
    async *read(after, before) {
      for await (const batch of inner.read(after, before)) {
        frames += batch.values.length
        yield batch
      }
    },
    append: (value, expectedCursor) => inner.append(value, expectedCursor),
  }
  return { journal, framesRead: () => frames, reset: () => void (frames = 0) }
}

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "replay-cost-workspace-v1",
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

async function createCliApp(journal: Journal<unknown>) {
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
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

function outputIO() {
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
    runner: "replay-cost-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Append history the way the product does: submit PRs, so the journal grows
 * through real commands rather than hand-written frames. */
async function appendHistory(app: CliApp, prefix: string, count: number): Promise<void> {
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
 * sound for the behaviour tests that use it and fatal here: it would dominate
 * the frame count and this file would be measuring the test double rather than
 * the command. Reading nothing keeps every counted frame attributable to the
 * CLI's own journal use. */
function stubReadModel(app: CliApp) {
  return {
    async snapshot() {
      return { cursor: (await app.journalSnapshot()).asOf.cursor, generation: 0, attempts: [] }
    },
  }
}

/** Run `log --json` and report what the journal handed the invocation. */
async function logInvocation(app: CliApp, meter: ReturnType<typeof countingJournal>): Promise<number> {
  meter.reset()
  const output = outputIO()
  const code = await runYrdRaw(app, yrd("log", "--json"), output.io, { queueReadModel: stubReadModel(app) })
  expect(code, output.stderr()).toBe(0)
  return meter.framesRead()
}

describe("yrd log cold-replay cost", () => {
  it("reads the same number of frames however much history the journal holds", async () => {
    const meter = countingJournal()
    await using app = await createCliApp(meter.journal)

    await appendHistory(app, "early", 12)
    const smallCursor = (await app.journalSnapshot()).asOf.cursor
    const smallFrames = await logInvocation(app, meter)

    await appendHistory(app, "later", 12)
    const grownCursor = (await app.journalSnapshot()).asOf.cursor
    const grownFrames = await logInvocation(app, meter)

    // The fixture has to actually grow, or the invariant below proves nothing.
    expect(grownCursor).toBeGreaterThan(smallCursor)
    // ...and it has to outgrow the coverage probe's window, or an unbounded
    // read would look bounded here for the wrong reason.
    expect(smallCursor).toBeGreaterThan(8)

    expect(grownFrames).toBe(smallFrames)
    expect(smallFrames).toBeLessThan(smallCursor)
  })
})
