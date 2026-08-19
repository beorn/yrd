/**
 * @failure `yrd queue <repository> list` silently answers a DIFFERENT question:
 *          the trailing `list` falls through the alias adapter as a positional
 *          filter term, so the natural spelling of the list command searches the
 *          timeline for the word "list". Measured live 2026-08-14 against the
 *          `code` repository: 1,091 rows without it, 8 rows with it, no note.
 *          The same hole swallows `run`, `audit`, `uncarried`, `cancel` and the
 *          rest of the family — `yrd queue code run` quietly LISTS.
 * @level   l2
 * @consumer @yrd/cli — tools/installed/yrd-wrapper.mjs normalizes every hh
 *           `yrd queue …` invocation through normalizeYrdRepositoryAliasInvocation
 * @bead    @yrd/cli/named-list-becomes-a-filter
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { normalizeYrdRepositoryAliasInvocation, runYrd as runYrdRaw, type YrdCliIO } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import { withMerge, withQueue, withStep, type changeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
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

const REPOSITORIES = [{ repository: { name: "code", path: "." }, queue: { base: "main" } }] as const

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: Parameters<typeof runYrdRaw>[3] = {},
) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "named-subcommand-workspace-v1",
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

/** Contest adapters the composed CLI app requires; this listing never enters a contest. */
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

async function createCliApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (
      _input: StepExecution<changeShape>,
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
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: { journal: createMemoryJournal(), clock: () => "2026-07-09T12:00:00.000Z", id: ids() },
  })
}

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
    runner: "named-subcommand-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

type ListPayload = Readonly<{
  projection: Readonly<{ rows: readonly Readonly<{ run?: string }>[] }>
  results: readonly Readonly<{
    running: readonly Readonly<{ id: string }>[]
    waiting: readonly Readonly<{ id: string }>[]
    finished: readonly Readonly<{ id: string }>[]
  }>[]
}>

function runIds(payload: ListPayload): string[] {
  return payload.results
    .flatMap((result) => [...result.running, ...result.waiting, ...result.finished])
    .map((run) => run.id)
    .toSorted()
}

/** Exactly what the hh wrapper runs: the host spelling, normalized, then executed. */
async function hostSpelling(
  app: Awaited<ReturnType<typeof createCliApp>>,
  ...spelling: string[]
): Promise<ListPayload> {
  const normalized = normalizeYrdRepositoryAliasInvocation([...spelling, "--json"], REPOSITORIES)
  // `--repo` is a BOOTSTRAP selector: the wrapper uses it to pick which
  // repository to open, and the runtime only registers the flag when it has to
  // build the app itself. This test supplies the app, so the selector has
  // already done its job and the flag is not part of the command surface here.
  const repoIndex = normalized.args.indexOf("--repo")
  expect(repoIndex, `${spelling.join(" ")} lost its repository selector`).toBeGreaterThanOrEqual(0)
  const args = normalized.args.toSpliced(repoIndex, 2)
  const out = outputIO()
  const code = await runYrd(app, ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args], out.io)
  expect(code, `${spelling.join(" ")} exited ${code}: ${out.stderr()}`).toBe(0)
  return JSON.parse(out.stdout()) as ListPayload
}

async function fixture() {
  const app = await createCliApp()
  // Distinct head SHAs: the bay refuses a duplicate payload, so three branches
  // sharing one SHA would submit as one PR and shrink the comparison set.
  for (const [index, branch] of ["topic/one", "topic/two", "topic/three"].entries()) {
    await app.bays.submit({ branch, headSha: `${index + 1}`.repeat(40), base: "main", baseSha: BASE_SHA })
  }
  await app.queue.run({ prs: ["PR1"] }, { runner: "named-subcommand-test", leaseMs: 60_000 })
  return app
}

describe("a queue subcommand after the repository name is the command, not a filter term", () => {
  it("answers `queue code list` with the same rows as `queue code`", async () => {
    const app = await fixture()
    const bare = runIds(await hostSpelling(app, "queue", "code"))
    // Non-vacuous: the fixture must actually carry rows, or an equality between
    // two empty listings would pass while the swallow was still live.
    expect(bare.length, "fixture must carry runs for the comparison to mean anything").toBeGreaterThan(0)
    expect(runIds(await hostSpelling(app, "queue", "code", "list")), "`list` was swallowed as a filter term").toEqual(
      bare,
    )
    expect(runIds(await hostSpelling(app, "queue", "code", "ls"))).toEqual(bare)
    expect(runIds(await hostSpelling(app, "queue", "code", "status"))).toEqual(bare)
  })

  it("scopes `queue list code` to the named repository instead of searching for it", () => {
    expect(normalizeYrdRepositoryAliasInvocation(["queue", "list", "code"], REPOSITORIES)).toEqual({
      kind: "repository-read",
      repository: { name: "code", path: "." },
      queue: { base: "main" },
      args: ["--repo", ".", "queue", "list"],
    })
  })
})

describe("a filter term spelled like a subcommand is refused, never answered silently", () => {
  it("refuses the term and names both readings", async () => {
    const app = await fixture()
    const out = outputIO()
    const code = await runYrd(app, ["/usr/bin/bun", "/repo/bin/yrd.ts", "queue", "list", "list", "--json"], out.io)
    expect(code, "a term that shadows a subcommand must not answer silently").toBe(2)
    expect(out.stderr()).toContain("'list' is a queue subcommand, not a filter term")
    expect(out.stderr()).toContain("--term list")
  })

  it("filters by the shadowing term when it is passed explicitly", async () => {
    const app = await fixture()
    const out = outputIO()
    const code = await runYrd(
      app,
      ["/usr/bin/bun", "/repo/bin/yrd.ts", "queue", "list", "--term", "list", "--json"],
      out.io,
    )
    expect(code, out.stderr()).toBe(0)
    expect(runIds(JSON.parse(out.stdout()) as ListPayload), "no branch is named 'list'").toEqual([])
  })

  it("accepts --term on the hidden default spelling too", async () => {
    // `yrd queue …` with no subcommand reaches `_list`, not `list`. A flag
    // registered on one spelling only is an escape hatch that is missing from
    // half the surface that needs it.
    const app = await fixture()
    const out = outputIO()
    const code = await runYrd(
      app,
      ["/usr/bin/bun", "/repo/bin/yrd.ts", "queue", "_list", "--term", "list", "--json"],
      out.io,
    )
    expect(code, out.stderr()).toBe(0)
    expect(runIds(JSON.parse(out.stdout()) as ListPayload)).toEqual([])
  })
})
