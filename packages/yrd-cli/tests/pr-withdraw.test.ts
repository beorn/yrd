/**
 * @failure A retired change-record verb (`pr close`, its hidden `pr withdraw`
 * alias, `admin pr prune`) half-runs, silently no-ops, or answers "unknown
 * command" instead of refusing loud and naming the branch-state verbs that
 * replaced it; or root `cancel` ends the delivery instead of stopping only the
 * attempt.
 * @level l2
 * @consumer @yrd/cli
 *
 * Drives the real `runYrd` command surface with JSON output like
 * selector-surfaces.test.ts. Git facts for the retired prune scan are injected
 * through YrdCliIO.pruneGit, so the refusal is proven to precede every Git read
 * the verb used to perform.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd as runYrdRaw, type PruneGitFacts, type YrdCliIO } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import {
  deriveRunMemberArgs,
  withMerge,
  withQueue,
  withStep,
  type ChangeShape,
  type DerivedRunMember,
  type StepExecution,
} from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: Parameters<typeof runYrdRaw>[3] = {},
) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

const HEAD_SHA = "1".repeat(40)
const HEAD2_SHA = "2".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BASE_TREE = "e".repeat(40)

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "withdraw-workspace-v1",
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

/** Minimal contest adapters so the composed app matches YrdCliApp; the retired
 * verbs and `cancel` never enter a contest, so passing stubs suffice. */
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
    {
      revision: "check-v1",
      output: JsonSchema,
      classification: "carrier",
    },
  )
  const merge = withMerge(
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
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
    inject: { journal: createMemoryJournal(), clock: () => "2026-07-15T12:00:00.000Z", id: ids() },
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
    runner: "cli-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-15T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Submit a branch and derive the run member that admission would carry for it
 * — the post-S7 spelling of "put this change in front of the queue": there is
 * no record to name, so a run's batch IS its derived membership. */
async function submitBranch(app: CliApp, branch: string, sha: string): Promise<DerivedRunMember> {
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: volatilePrNumberMint(),
    branch,
  })
}

async function journaledEvents(app: CliApp, name: string): Promise<Record<string, unknown>[]> {
  const events = await Array.fromAsync(app.events())
  return events.filter((event) => event.name === name).map((event) => event.data as Record<string, unknown>)
}

/** Deterministic Git facts: origin/main resolves to BASE_SHA, known head SHAs
 * resolve to themselves, and every check not overridden refuses to run, so a
 * test proves exactly which plumbing its scenario consulted — none, for a
 * retired verb. */
function pruneGit(overrides: Partial<PruneGitFacts> = {}): PruneGitFacts {
  return {
    resolveCommit: (ref) =>
      ref === "origin/main" ? BASE_SHA : ref === HEAD_SHA || ref === HEAD2_SHA ? ref : undefined,
    isAncestor: () => false,
    mergeTree: () => {
      throw new Error("mergeTree must not run in this scenario")
    },
    treeOf: (sha) => {
      if (sha !== BASE_SHA) throw new Error(`treeOf must only inspect the base tip, got ${sha}`)
      return BASE_TREE
    },
    ...overrides,
  }
}

/**
 * `pr close` and its hidden `withdraw` alias ended a delivery by writing a
 * terminal revision onto the change record. Both are retired with that store
 * (branch-is-change, @i/10 22991): a branch IS the change, so ending its
 * delivery is `yrd cancel` plus a branch-state verb. They stay REGISTERED and
 * hidden so an old runbook gets a refusal that teaches the replacement instead
 * of a command-not-found from the argument parser.
 */
describe("retired change-record verbs refuse loud and teach the branch-state verbs", () => {
  it("pr withdraw refuses as retired, emits nothing, and leaves the submission standing", async () => {
    const app = await createCliApp()
    await app.bays.recordBranchSubmit({ branch: "topic/stale", sha: HEAD_SHA, base: "main" })

    const output = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "topic/stale", "--reason", "superseded by rework"), output.io)).toBe(
      1,
    )
    expect(output.stdout()).toBe("")
    expect(output.stderr()).toContain("pr withdraw is retired with the change-record store")
    expect(output.stderr()).toContain("yrd cancel <selector>")
    expect(output.stderr()).toContain("yrd draft <branch>")
    expect(output.stderr()).toContain("yrd archive <branch>")
    // Nothing was written: no terminal revision, and the standing submit fact
    // — which IS the delivery now — is untouched.
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([])
    expect(app.state().bays.submits["topic/stale"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
  })

  it("mr close refuses as retired and says payload identity is not spent", async () => {
    const app = await createCliApp()
    await app.bays.recordBranchSubmit({ branch: "topic/one", sha: HEAD_SHA, base: "main" })

    const output = outputIO()
    expect(await runYrd(app, yrd("mr", "close", "topic/one", "--reason", "looked stale"), output.io)).toBe(1)
    expect(output.stdout()).toBe("")
    expect(output.stderr()).toContain("pr close is retired with the change-record store")
    // The pre-spend disclosure this verb used to demand died with payload
    // identity; the refusal says so rather than leaving an operator hunting
    // for the acknowledgement flag that no longer gates anything.
    expect(output.stderr()).toContain("Nothing is spent and nothing needs burning")
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([])
    expect(app.state().bays.submits["topic/one"]).toMatchObject({ sha: HEAD_SHA })
  })

  it("keeps both spellings registered but hidden, and ignores their old flags", async () => {
    const app = await createCliApp()
    await app.bays.recordBranchSubmit({ branch: "topic/one", sha: HEAD_SHA, base: "main" })

    const help = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("mr"), help.io), help.stderr()).toBe(0)
    expect(help.stdout()).not.toMatch(/^\s{2}withdraw/mu)
    expect(help.stdout()).not.toMatch(/^\s{2}close/mu)

    // Hidden is not absent: the old spellings, with the old flags, still reach
    // their own refusal instead of the parser's "unknown command".
    for (const argv of [
      yrd("pr", "withdraw", "topic/one", "--burn-payload", "--json"),
      yrd("mr", "close", "topic/one", "--burn-payload", "--json"),
    ]) {
      const output = outputIO()
      expect(await runYrd(app, argv, output.io)).toBe(1)
      expect(output.stderr()).toContain("is retired with the change-record store")
      expect(output.stderr()).not.toContain("unknown command")
    }
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([])
  })

  it("admin pr prune refuses as retired, naming compose and the archive verb", async () => {
    // The live-record scan the verb pruned is retired with the change-record
    // store (branch-is-change, @i/10 22991): compose settles already-contained
    // payloads itself, and `yrd archive <branch>` shelves a branch main
    // already carries. The verb stays registered, hidden, so an old runbook
    // gets this refusal — and emits nothing. The injected `isAncestor` would
    // have said "contained" for every candidate, so a verb that still scanned
    // would have pruned here.
    const app = await createCliApp()
    await app.bays.recordBranchSubmit({ branch: "topic/one", sha: HEAD_SHA, base: "main" })

    const output = outputIO({ pruneGit: () => pruneGit({ isAncestor: () => true }) })
    expect(await runYrd(app, yrd("admin", "pr", "prune"), output.io)).toBe(1)
    expect(output.stdout()).toBe("")
    expect(output.stderr()).toContain("admin pr prune is retired with the change-record store")
    expect(output.stderr()).toContain("payload-already-contained")
    expect(output.stderr()).toContain("resolve: yrd archive <branch>")
    expect(app.state().bays.submits["topic/one"]).toMatchObject({ sha: HEAD_SHA })
  })
})

describe("root cancel (chief ruling b9bf30f2) stops the attempt, never the delivery", () => {
  it("cancels the run and leaves the branch submitted", async () => {
    const app = await createCliApp()
    const member = await submitBranch(app, "topic/one", HEAD_SHA)
    // `prs: []` beside a non-empty `derived` selects exactly those derived
    // members — the post-S7 spelling of naming one member explicitly.
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [member], steps: ["check"], baseSha: BASE_SHA })

    const output = outputIO()
    expect(
      await runYrd(app, yrd("cancel", "topic/one", "--reason", "bad attempt", "--json"), output.io),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ command: "queue.cancel" })
    // Attempt-scoped: the run is canceled, the submission still stands, so the
    // next queue pass composes the same branch again.
    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "cancelled" })
    expect(app.state().bays.submits["topic/one"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([])
  })

  it("fails loud with no active attempt and teaches the branch-state verbs", async () => {
    const app = await createCliApp()
    await app.bays.recordBranchSubmit({ branch: "topic/one", sha: HEAD_SHA, base: "main" })

    const output = outputIO()
    expect(await runYrd(app, yrd("cancel", "topic/one"), output.io)).toBe(1)
    expect(output.stderr()).toContain("no running or waiting attempt")
    // Cancel stops an attempt; ending DELIVERY is the branch-state verbs' job,
    // and the refusal teaches both spellings (S7: `mr close --burn-payload`
    // died with payload identity).
    expect(output.stderr()).toContain("yrd draft topic/one")
    expect(output.stderr()).toContain("yrd archive topic/one")
  })
})
