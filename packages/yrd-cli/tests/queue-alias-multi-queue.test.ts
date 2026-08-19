/**
 * @failure The multi-queue listing is unreachable from a composition host: the
 *          alias adapter names one base for every aliased read, so `yrd queue
 *          code --watch` — the invocation operators actually type — shows one
 *          queue with no labels, no legend and no digit toggles, while the
 *          feature looks live because direct `yrd watch` still renders it.
 * @level   l2
 * @consumer @yrd/cli queue alias adapter -> queue list projection
 *
 * The composition host rewrites `yrd queue <repository> …` into a
 * `--repo <path> queue list …` invocation. That rewrite decides which question
 * the listing answers, so the multi-queue directive (2026-08-13) is only real
 * if the rewritten argv still asks about the REPOSITORY.
 */
import { withBays, createBayJobDefs } from "@yrd/bay"
import { normalizeYrdRepositoryAliasInvocation, runYrd as runYrdRaw, type YrdCliIO } from "@yrd/cli"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type ContestEvaluatorDef, type ContestGit, type ContestRunnerDef } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { describe, expect, it } from "vitest"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const HEAD_SHA = "1".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

const DECLARATIONS = [{ repository: { name: "code", path: "/repo" }, queue: { base: "main" } }] as const

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "alias-multi-queue-workspace-v1",
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
    async run() {
      throw new Error("this fixture never runs a contest attempt")
    },
  }
  const evaluator: ContestEvaluatorDef = {
    id: "held-out",
    revision: "held-out-v1",
    authority: "held-out",
    async evaluate() {
      throw new Error("this fixture never evaluates a contest attempt")
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
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  const app = await createYrd(contests(queue(base)), {
    inject: { journal: createMemoryJournal(), clock: () => "2026-08-13T12:00:00.000Z", id: ids() },
  })
  await app.bays.submit({ branch: "topic/on-main", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
  await app.bays.submit({
    branch: "topic/on-release",
    headSha: "2".repeat(40),
    base: "release/next",
    baseSha: BASE_SHA,
  })
  return app
}

function outputIO(): { io: YrdCliIO; stdout: () => string; stderr: () => string } {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      cwd: "/repo",
      runner: "alias-multi-queue-test",
      leaseMs: 60_000,
      now: () => Date.parse("2026-08-13T12:01:00.000Z"),
      // Each base resolves to itself: this repository really does carry two
      // queues, which is the condition the labels exist for.
      resolveQueueTarget: async (ref: string) => ({ base: ref, sha: BASE_SHA }),
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

type QueuesPayload = Readonly<{
  projection: Readonly<{ queues: readonly Readonly<{ label: number; base: string }>[] }>
}>

/**
 * Run what the host's rewrite produced. `--repo <path>` selects the repository
 * for a bootstrapping process; this in-memory app IS that repository, so the
 * selector pair is dropped here and the REST of the rewrite — the part that
 * decides which question the listing answers — is executed verbatim.
 */
async function listAs(
  app: Awaited<ReturnType<typeof createCliApp>>,
  argv: readonly string[],
  services: Parameters<typeof runYrdRaw>[3] = {},
): Promise<QueuesPayload> {
  const repoIndex = argv.indexOf("--repo")
  expect(repoIndex, "the host rewrite must select the repository").toBe(0)
  const rest = argv.slice(2)
  const out = outputIO()
  const exit = await runYrdRaw(app, ["/usr/bin/bun", "/repo/bin/yrd.ts", ...rest, "--json"], out.io, {
    queueReadModel: testQueueReadModel(app),
    ...services,
  })
  expect(exit, out.stderr()).toBe(0)
  return JSON.parse(out.stdout()) as QueuesPayload
}

describe("an aliased repository read reaches the multi-queue listing (@yrd/cli/queue-alias-multi-queue)", () => {
  it("carries no base of its own, so the repository's every queue is in scope", async () => {
    const invocation = normalizeYrdRepositoryAliasInvocation(["queue", "code", "--watch"], DECLARATIONS)
    expect(invocation.args).toEqual(["--repo", "/repo", "queue", "list", "--watch"])
    expect(invocation.args, "an injected base narrows every aliased read to one queue").not.toContain("--base")
  })

  it("labels both queues 1..N for the invocation an operator actually types", async () => {
    const app = await createCliApp()
    const { args } = normalizeYrdRepositoryAliasInvocation(["queue", "code"], DECLARATIONS)
    const payload = await listAs(app, args)
    expect(payload.projection.queues).toEqual([
      { label: 1, base: "main" },
      { label: 2, base: "release/next" },
    ])
  })

  it("shows one queue only when the operator names one", async () => {
    const app = await createCliApp()
    const { args } = normalizeYrdRepositoryAliasInvocation(["queue", "code", "--base", "release/next"], DECLARATIONS)
    expect(args).toEqual(["--repo", "/repo", "queue", "list", "--base", "release/next"])
    expect((await listAs(app, args)).projection.queues).toEqual([{ label: 1, base: "release/next" }])
  })

  it("puts the repository's CONFIGURED base first when nobody named one", async () => {
    // Label 1 is the primary queue: the base the runner and pause facts are
    // read from. With no base in the argv it comes from the repository's own
    // configuration, so a repository whose queue is `release/next` does not
    // find `main` at the front of its own legend.
    const app = await createCliApp()
    const { args } = normalizeYrdRepositoryAliasInvocation(["queue", "code"], DECLARATIONS)
    expect((await listAs(app, args, { base: "release/next" })).projection.queues).toEqual([
      { label: 1, base: "release/next" },
      { label: 2, base: "main" },
    ])
  })
})
