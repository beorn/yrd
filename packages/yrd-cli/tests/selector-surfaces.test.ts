/**
 * @failure A yrd CLI surface resolves an operator selector case-sensitively, or
 * silently rewrites the canonical PR/run/base identity while doing so, or fails
 * to reject an ambiguous folded selector.
 * @level l2
 * @consumer @yrd/cli
 *
 * The selector-resolution boundary itself (resolveSelector, resolvePR,
 * resolveBase, and the queue PR/run/base resolvers) is proven at the core, bay,
 * and queue layers. This file proves the CLI verbs hand the raw operator string
 * to that boundary and echo the canonical identity back — driving the real
 * `runYrd` command surface with JSON output, so it needs no Silvery renderer and
 * runs in a bare standalone clone.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
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
    revision: "selector-workspace-v1",
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

/** Minimal contest adapters so the composed app matches YrdCliApp; the selector
 * surfaces under test never enter a contest, so passing stubs suffice. */
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

async function createCliApp(overrides: { check?: () => JobResult<JsonValue> } = {}) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    overrides.check ?? ((): JobResult<JsonValue> => ({ status: "passed", output: { checked: true } })),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
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

type CliApp = Awaited<ReturnType<typeof createCliApp>>

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
    runner: "selector-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Submit one PR whose canonical identity (PR1 / main) never matches the
 * lowercase or uppercase selectors the operator will type. */
async function submitOnePR(app: CliApp): Promise<void> {
  await app.bays.submit({ branch: "Topic/One", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
}

describe("case-insensitive CLI selector surfaces", () => {
  it.each([
    {
      surface: "pr runs",
      args: ["pr", "runs", "pr1", "--json"],
      expected: { command: "pr.runs", pr: { id: "PR1" } },
    },
    {
      surface: "pr runs (branch alias, folded)",
      args: ["pr", "runs", "topic/one", "--json"],
      expected: { command: "pr.runs", pr: { id: "PR1", branch: "Topic/One" } },
    },
    {
      surface: "pr review",
      args: ["pr", "review", "pr1", "--approve", "--by", "@cto", "--json"],
      expected: { command: "pr.review", pr: { id: "PR1" } },
    },
    {
      surface: "pr close",
      args: ["pr", "close", "pr1", "--json"],
      expected: { command: "pr.close", prs: [{ id: "PR1" }] },
    },
    {
      surface: "queue run",
      args: ["queue", "run", "pr1", "--json"],
      expected: { command: "queue.run", results: [{ prs: [{ id: "PR1" }] }] },
    },
    {
      surface: "pr checks",
      args: ["pr", "checks", "pr1", "--json"],
      expected: { kind: "pr.check", pr: "PR1" },
    },
    {
      surface: "pr list base filter",
      args: ["pr", "list", "--base", "MAIN", "--json"],
      expected: { command: "pr.list", prs: [{ id: "PR1", base: "main" }] },
    },
    {
      surface: "queue list base filter",
      args: ["queue", "--base", "MAIN", "--json"],
      expected: { command: "queue.list", results: [{ base: "main", prs: [{ id: "PR1" }] }] },
    },
    {
      surface: "dashboard base filter",
      args: ["--base", "MAIN", "--json"],
      expected: { command: "dashboard", results: [{ base: "main", prs: [{ id: "PR1" }] }] },
    },
  ])("$surface resolves the folded selector and preserves canonical output", async ({ args, expected }) => {
    const app = await createCliApp()
    await submitOnePR(app)
    const output = outputIO()

    expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject(expected)
  })

  it.each(["1", "PR1.1", "1.1"])(
    "pr view resolves the human PR/revision selector %s without changing canonical identity",
    async (selector) => {
      const app = await createCliApp()
      await submitOnePR(app)
      const output = outputIO()

      expect(await runYrd(app, yrd("pr", "view", selector, "--json"), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({ command: "pr.view", pr: { id: "PR1", revision: 1 } })
    },
  )

  it("refuses a missing PR revision with the canonical identity and accepted selector forms", async () => {
    const app = await createCliApp()
    await submitOnePR(app)
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "view", "1.2", "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain("PR 'PR1' has no revision 2; available revisions: 1")
    expect(output.stderr()).toContain("accepted forms: PR1, 1, PR1.<revision>, 1.<revision>")
  })

  it("refuses a historical revision selector instead of silently acting on the current revision", async () => {
    const app = await createCliApp()
    await submitOnePR(app)
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: MERGED_SHA,
      baseSha: BASE_SHA,
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "view", "1.1", "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain("PR 'PR1' revision 1 is historical; current revision is 2")
    expect(output.stderr()).toContain("run 'yrd pr runs PR1' to inspect revision history")
  })

  it("keeps merge teaching case-insensitive while naming the canonical PR", async () => {
    const app = await createCliApp()
    await submitOnePR(app)
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "merge", "pr1", "--json"), output.io)).toBe(1)
    expect(JSON.parse(output.stderr())).toMatchObject({ command: "pr.merge", pr: "PR1" })
  })

  it("applies canonical PR and base scopes to bounded watch projections", async () => {
    const app = await createCliApp()
    await submitOnePR(app)

    for (const scope of [
      ["--pr", "pr1"],
      ["--base", "MAIN"],
    ] as const) {
      const controller = new AbortController()
      controller.abort()
      const output = outputIO({ scope: { signal: controller.signal, sleep: async () => {} } })
      expect(await runYrd(app, yrd("watch", ...scope, "--json"), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "queue.list",
        results: [{ base: "main", prs: [{ id: "PR1" }] }],
      })
    }
  })

  it("reports folded base collisions instead of choosing the first base", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "Topic/Upper", headSha: HEAD_SHA, base: "Main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "Topic/Lower", headSha: MERGED_SHA, base: "main", baseSha: BASE_SHA })
    const output = outputIO()

    expect(await runYrd(app, yrd("queue", "--base", "MAIN", "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain("base selector 'MAIN' is ambiguous: Main, main")
  })

  it("applies canonical PR and base scopes to log projections", async () => {
    const app = await createCliApp()
    await submitOnePR(app)
    const setup = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), setup.io), setup.stderr()).toBe(0)

    for (const scope of [
      ["--pr", "pr1"],
      ["--base", "MAIN"],
    ] as const) {
      const output = outputIO()
      expect(await runYrd(app, yrd("log", ...scope, "--json"), output.io), output.stderr()).toBe(0)
      const log = JSON.parse(output.stdout()) as { command: string; rows: readonly { prs?: readonly string[] }[] }
      expect(log.command).toBe("log")
      expect(log.rows.length).toBeGreaterThan(0)
      expect(JSON.stringify(log.rows)).toContain("PR1")
    }

    const missing = outputIO()
    expect(await runYrd(app, yrd("log", "--pr", "missing", "--json"), missing.io)).toBe(1)
    expect(missing.stderr()).toContain("no PR 'missing'")
  })

  /** A recutter whose output never depends on selector casing. */
  function stubRecutter(): { recut: YrdCliServices["recut"] } {
    return {
      recut: {
        recut: async () => ({
          headSha: "f".repeat(40),
          baseSha: BASE_SHA,
          treeSha: "d".repeat(40),
          patchId: "e".repeat(40),
          unchanged: false,
        }),
      },
    }
  }

  it("recuts through the folded selector and echoes the canonical PR", async () => {
    const app = await createCliApp()
    await submitOnePR(app)
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "recut", "pr1", "--json"), output.io, stubRecutter()), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ pr: "PR1" })
  })

  it("retries a rejected PR through folded selectors without renaming it", async () => {
    let attempts = 0
    const app = await createCliApp({
      check: (): JobResult<JsonValue> =>
        ++attempts === 1
          ? { status: "failed", error: { code: "check-failed", message: "first attempt fails" } }
          : { status: "passed", output: { checked: true } },
    })
    await submitOnePR(app)

    const rejected = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "pr1", "--json"), rejected.io)).toBe(1)
    expect(JSON.parse(rejected.stdout())).toMatchObject({
      command: "queue.run",
      results: [{ status: "failed", prs: [{ id: "PR1" }] }],
    })

    // A direct re-run refuses, but the refusal proves the folded selector
    // resolved to the canonical identity on the retry path.
    const refused = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "pr1", "--json"), refused.io)).not.toBe(0)
    expect(refused.stderr()).toContain("PR 'PR1' is rejected")

    // The sanctioned retry: recut the folded selector back into the queue.
    const requeued = outputIO()
    expect(
      await runYrd(app, yrd("pr", "recut", "pr1", "--queue", "--json"), requeued.io, stubRecutter()),
      requeued.stderr(),
    ).toBe(0)
    expect(JSON.parse(requeued.stdout())).toMatchObject({ pr: "PR1" })

    // The retried run passes and still names the canonical PR; the exit code
    // reflects the historical rejected run that the projection also returns.
    const retried = outputIO()
    await runYrd(app, yrd("queue", "run", "pr1", "--json"), retried.io)
    const parsed = JSON.parse(retried.stdout()) as {
      command: string
      results: readonly { status: string; prs: readonly { id: string }[] }[]
    }
    expect(parsed.command).toBe("queue.run")
    expect(parsed.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", prs: [expect.objectContaining({ id: "PR1" })] }),
      ]),
    )
  })

  it("records a regression through folded PR and run selectors", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "Topic/One", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA, issue: "km:1" })
    await app.bays.submit({
      branch: "Topic/Two",
      headSha: "2".repeat(40),
      base: "main",
      baseSha: BASE_SHA,
      issue: "km:1",
    })
    const setup = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "PR2", "--json"), setup.io), setup.stderr()).toBe(0)

    const output = outputIO()
    const args = [
      "pr",
      "regression",
      "pr1",
      "--run",
      "r1",
      "--detected-at",
      "2026-07-09T12:00:00.000Z",
      "--severity",
      "low",
      "--evidence",
      "evidence-1",
      "--implementation-run",
      "impl-1",
      "--review",
      "review-1",
      "--repair-pr",
      "pr2",
      "--repair-run",
      "r2",
      "--json",
    ]
    expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.regression",
      regression: { pr: "PR1", run: "R1", repairPr: "PR2", repairRun: "R2" },
    })
  })
})
