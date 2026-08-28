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
import { runYrd as runYrdRaw, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import { seededChangesEntry, type ChangeSeed } from "./support/seeded-changes.ts"
import { withMerge, withQueue, withStep, type ChangeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
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

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "selector-workspace-v1",
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

/** Minimal contest adapters so the composed app matches YrdCliApp; the selector
 * surfaces under test never enter a contest, so passing stubs suffice. */
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

async function createCliApp(overrides: { check?: () => JobResult<JsonValue>; seeds?: readonly ChangeSeed[] } = {}) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    overrides.check ??
      ((): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } })),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (
      _input: StepExecution<ChangeShape>,
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
    withBays({
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal:
        overrides.seeds === undefined
          ? createMemoryJournal()
          : createMemoryJournal([seededChangesEntry(overrides.seeds)]),
      clock: () => "2026-07-09T12:00:00.000Z",
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
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

function remergeOutputIO() {
  return outputIO({
    pruneGit: () => ({
      resolveCommit: (ref) => (ref === "origin/Topic/One" || ref === "Topic/One" ? HEAD_SHA : undefined),
      isAncestor: () => false,
      mergeTree: () => undefined,
      treeOf: () => HEAD_SHA,
    }),
  })
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** One seeded change whose canonical identity (PR1 / main) never matches the
 * lowercase or uppercase selectors the operator will type. S7: records no
 * longer mint, so the record state is seeded as journal history. */
const ONE_PR_SEED: readonly ChangeSeed[] = [
  { pr: "PR1", branch: "Topic/One", base: "main", revs: [{ headSha: HEAD_SHA, baseSha: BASE_SHA }] },
]

describe("case-insensitive CLI selector surfaces", () => {
  it.each([
    {
      surface: "pr runs",
      args: ["pr", "runs", "pr1", "--json"],
      expected: { command: "pr.runs", pr: { id: "PR1" } },
    },
    {
      surface: "pr runs (copy-pasted display identity)",
      args: ["pr", "runs", "pr#1.1", "--json"],
      expected: { command: "pr.runs", pr: { id: "PR1", revs: [{ n: 1 }] } },
    },
    {
      surface: "pr runs (branch alias, folded)",
      args: ["pr", "runs", "topic/one", "--json"],
      expected: { command: "pr.runs", pr: { id: "PR1", branch: "Topic/One" } },
    },
    // "pr close" row deleted (S7 branch-is-change, @i/10 22991): `pr close`
    // refuses close-retired before resolving any selector, so the fold is no
    // longer observable on that surface.
    {
      surface: "queue run",
      args: ["queue", "run", "pr1", "--json"],
      expected: { command: "queue.run", results: [{ prs: [{ id: "PR1" }] }] },
    },
    {
      surface: "pr checks",
      args: ["pr", "checks", "pr1", "--json"],
      expected: { kind: "pr.check", pr: "PR1" },
      // This row's subject is the SELECTOR, and the canonical row it prints is
      // unchanged. The exit moved because nothing has judged this PR yet, and
      // `pr checks` no longer reads an absent verdict as a pass
      // (@i/10-merge-queue/failed-check-erased).
      exit: 1,
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
  ])(
    "$surface resolves the folded selector and preserves canonical output",
    async ({ args, expected, exit }: { args: readonly string[]; expected: object; exit?: number }) => {
      const app = await createCliApp({ seeds: ONE_PR_SEED })
      const output = outputIO()

      expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(exit ?? 0)
      expect(JSON.parse(output.stdout())).toMatchObject(expected)
    },
  )

  it("keeps merge teaching case-insensitive while naming the canonical PR", async () => {
    const app = await createCliApp({ seeds: ONE_PR_SEED })
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "merge", "pr1", "--json"), output.io)).toBe(1)
    expect(JSON.parse(output.stderr())).toMatchObject({ command: "pr.merge", pr: "PR1" })
  })

  it("applies canonical PR and base scopes to bounded watch projections", async () => {
    const app = await createCliApp({ seeds: ONE_PR_SEED })

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
    const app = await createCliApp({
      seeds: [
        { pr: "PR1", branch: "Topic/Upper", base: "Main", revs: [{ headSha: HEAD_SHA, baseSha: BASE_SHA }] },
        { pr: "PR2", branch: "Topic/Lower", base: "main", revs: [{ headSha: MERGED_SHA, baseSha: BASE_SHA }] },
      ],
    })
    const output = outputIO()

    expect(await runYrd(app, yrd("queue", "--base", "MAIN", "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain("base selector 'MAIN' is ambiguous: Main, main")
  })

  it("teaches an accepted form when a copied PR-shaped selector is malformed", async () => {
    const app = await createCliApp({ seeds: ONE_PR_SEED })
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "runs", "pr#1.bad", "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain("accepted form: pr#1.1")
  })

  it("applies canonical PR and base scopes to log projections", async () => {
    const app = await createCliApp({ seeds: ONE_PR_SEED })
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
    expect(missing.stderr()).toContain("no change 'missing'")
  })

  /**
   * Every selector surface that refuses with "no PR" states what it searched.
   *
   * `pr view` was widened first and read as the whole job. It was one of
   * twelve emitters: nine in the queue package, plus `pr withdraw` and the
   * `--pr` create guard. Counting the population instead of the one surface in
   * front of me is the difference between a fix and an anecdote — an operator
   * who hit any of the other eleven still got an empty answer that reads like
   * their own mistake, which is the self-blame mechanism this bead is about.
   *
   * `--pr` on the create flow keeps its own sentence: `refusal()` adds no
   * prefix, so the shared builder's `yrd: ` would double up, and that site
   * already names a remedy rather than leaving the operator to guess.
   */
  // "pr withdraw" row deleted (S7 branch-is-change, @i/10 22991): withdraw
  // refuses withdraw-retired before searching anything, so it no longer emits
  // the searched-population sentence.
  it.each([
    { surface: "queue run", args: ["queue", "run", "nope", "--json"] },
    { surface: "log --pr", args: ["log", "--pr", "nope", "--json"] },
    { surface: "pr view", args: ["pr", "view", "nope", "--json"] },
  ])("$surface says what it searched when a selector finds nothing", async ({ args }) => {
    const app = await createCliApp({ seeds: ONE_PR_SEED })
    const output = outputIO()

    expect(await runYrd(app, yrd(...args), output.io)).toBe(1)
    expect(output.stderr()).toContain("no change 'nope'")
    expect(output.stderr()).toContain("searched 1 change(s)")
  })

  /** A remerger whose output never depends on selector casing. */
  function stubRemerger(): { recut: YrdCliServices["recut"] } {
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

  it("retries a required-check-failed PR through folded selectors without renaming it", async () => {
    let attempts = 0
    const app = await createCliApp({
      check: (): JobResult<JsonValue> =>
        ++attempts === 1
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "check-failed", message: "first attempt fails" },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } },
      seeds: ONE_PR_SEED,
    })

    const rejected = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "pr1", "--json"), rejected.io)).toBe(1)
    expect(JSON.parse(rejected.stdout())).toMatchObject({
      command: "queue.run",
      results: [{ status: "completed", conclusion: "failure", prs: [{ id: "PR1" }] }],
    })

    // A direct re-run refuses, but the refusal proves the folded selector
    // resolved to the canonical identity on the retry path.
    const refused = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "pr1", "--json"), refused.io)).not.toBe(0)
    expect(refused.stderr()).toContain("change 'PR1' required check failed in R1")
  })
})
