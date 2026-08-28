// @failure The tracker bridges go blind on DERIVED deliveries: a branch the
// door composes from its submit fact is recordless BY DESIGN, so a bridge that
// projects only change records shows the tent tracker bridge NOTHING for any
// fleet delivery, pending or terminal, and every delivery cursor written into
// coordination state goes dark post-purge. S7 (branch-is-change, @i/10 22991)
// deleted the record store outright, so EVERY delivery is now derived and this
// is the bridges' only remaining input.
// @level l2
// @consumer @yrd/cli

import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import {
  createBayJobDefs,
  volatilePrNumberMint,
  withBays,
  type BayWorkspace,
} from "@yrd/bay"
import { runYrd as runYrdRaw, type YrdCliIO } from "@yrd/cli"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import {
  withMerge,
  withQueue,
  withStep,
  type ChangeShape,
  type SourceRewrite,
  type StepExecution,
} from "@yrd/queue"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
const CHANGE_ID = `I${"c".repeat(40)}`
// The design-named fixture ref: enrichment is what carries `issue` onto a
// derived member's snapshot (records no longer mint, so admission is where
// identity enters).
const FIXTURE_ISSUE = "km:@yrd/core/21096-cli-ux/fixture-issue"
const RUNTIME = { runner: "cli-test", leaseMs: 60_000 }

function ids(start = 0): () => string {
  let value = start
  return () => `00000000-0000-7000-8000-${String(++value).padStart(12, "0")}`
}

/** Advancing frame clock so the submit FACT's `at` is distinguishable from
 * every run-side stamp — the "submitted" rows below assert the fact's `at`
 * specifically, which a fixed clock could not discriminate. */
function tickingClock(): () => string {
  let at = Date.parse("2026-07-09T12:00:00.000Z")
  return () => new Date((at += 1000)).toISOString()
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD_SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

function contestAdapters() {
  const runner: ContestRunnerDef = {
    id: "fixture",
    revision: "fixture-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      const commit = "d".repeat(40)
      return {
        status: "completed",
        conclusion: "success",
        output: {
          pin: {
            commit,
            ref: `refs/yrd/attempts/${input.contest}/${input.attempt}`,
            bay: input.bay.id,
            branch: input.bay.branch,
            baseSha: BASE_SHA,
          },
          wallTimeMs: 100,
          tokens: { input: 10, output: 4, cachedInput: 2, cacheWrite: 0, reasoning: 1 },
          cost: { kind: "reported", usd: 0.01, source: "fixture" },
          artifacts: [],
        },
      }
    },
  }
  const evaluator: ContestEvaluatorDef = {
    id: "held-out",
    revision: "held-out-v1",
    authority: "held-out",
    evaluate: async () => ({ status: "completed", conclusion: "success", output: { verdict: "passed", artifacts: [] } }),
  }
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  return { runner, evaluator, git }
}

/** The cli.test.ts composition pattern, pared to this suite's needs: the queue
 * owns the mint (S7 — derived-member identities mint at admission), injected
 * journal/clock/ids, a passing check step, and `readSubmitEnrichment`
 * answering the submitted sha with the fixture issue. */
async function createApp(
  options: {
    clock?: () => string
    failingMerge?: boolean
    mergeCommits?: readonly string[]
    mergeAlreadyLanded?: Readonly<{ candidateSha: string; candidateTreeSha: string; baseTreeSha: string }>
    mergeWait?: Readonly<{ started: () => void; until: Promise<void> }>
  } = {},
) {
  const contest = contestAdapters()
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (_input: StepExecution<ChangeShape>): JobResult<JsonValue> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  let mergeIndex = 0
  const merge = withMerge(
    async (
      _input: StepExecution<ChangeShape>,
    ): Promise<
      JobResult<{
        commit: string
        baseSha: string
        alreadyLanded?: Readonly<{ candidateSha: string; candidateTreeSha: string; baseTreeSha: string }>
        sourceRewrites?: readonly SourceRewrite[]
      }>
    > => {
      options.mergeWait?.started()
      if (options.mergeWait !== undefined) await options.mergeWait.until
      if (options.failingMerge === true) {
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "merge-failed", message: "yrd: fixture merge refused the candidate" },
        }
      }
      const commit = options.mergeCommits?.[mergeIndex++] ?? MERGED_SHA
      return {
        status: "completed",
        conclusion: "success",
        output: {
          commit,
          baseSha: commit,
          ...(options.mergeAlreadyLanded === undefined ? {} : { alreadyLanded: options.mergeAlreadyLanded }),
        },
      }
    },
    { revision: "merge-v1" },
  )
  const prNumberMint = volatilePrNumberMint(0)
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    prNumberMint,
    // A derived member carries no baseSha of its own; production wires the git
    // resolver here (same note as cli.test.ts).
    resolveBaseSha: () => BASE_SHA,
    readSubmitEnrichment: ({ sha }) =>
      sha === HEAD_SHA ? { changeId: CHANGE_ID, issue: FIXTURE_ISSUE, title: "Fixture issue" } : {},
  })
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (base) => ({ base, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: options.clock ?? tickingClock(),
      id: ids(),
      log: createLogger("yrd", [{ level: "silent" }]),
    },
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
    runner: "cli-test",
    leaseMs: 60_000,
    implementationSource: `git:${"1".repeat(40)}`,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    parents: async () => ["0".repeat(40)],
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function runYrd(app: Parameters<typeof runYrdRaw>[0], argv: readonly string[], io: YrdCliIO) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app) })
}

type Bridge = Readonly<{
  version: number
  asOf: Readonly<{ cursor: number; at?: string }>
  deliveries: readonly Readonly<Record<string, unknown>>[]
}>

async function readBridges(app: Parameters<typeof runYrdRaw>[0]): Promise<Readonly<{ v1: Bridge; v2: Bridge }>> {
  const output = outputIO()
  expect(await runYrd(app, yrd("issue", "--json"), output.io), output.stderr()).toBe(0)
  const parsed = JSON.parse(output.stdout()) as Readonly<{ trackerBridge?: Bridge; trackerBridgeV2?: Bridge }>
  if (parsed.trackerBridge === undefined || parsed.trackerBridgeV2 === undefined) {
    throw new Error("expected trackerBridge and trackerBridgeV2 JSON envelopes")
  }
  return { v1: parsed.trackerBridge, v2: parsed.trackerBridgeV2 }
}

describe("tracker bridges — DERIVED deliveries", () => {
  it("projects an integrated derived delivery with its landing sha in both bridge versions", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "topic/derived-lands", sha: HEAD_SHA, base: "main" })

    // Selectorless drain: the S6 door composes the derived member from the
    // standing fact, mints PR1 at admission, and runs check+merge to an
    // integration proof.
    expect(await app.queue.run({}, RUNTIME)).toMatchObject([{ status: "completed", conclusion: "success" }])
    const run = app.queue.get("R1")
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    // The delivery the bridge projects below is carried by the standing submit
    // fact — the branch IS the change (S7). Asserting the fact still stands at
    // the submitted sha is what makes the bridge row derived-lane by evidence
    // rather than by naming.
    expect(app.state().bays.submits["topic/derived-lands"]).toMatchObject({ sha: HEAD_SHA, base: "main" })

    const { v1, v2 } = await readBridges(app)
    const expected = {
      issueRef: FIXTURE_ISSUE,
      pr: "PR1",
      revision: 1,
      headSha: HEAD_SHA,
      status: "integrated",
      at: run?.finishedAt,
      landingSha: MERGED_SHA,
      runs: ["R1"],
    }
    expect(v2.deliveries).toHaveLength(1)
    expect(v2).toMatchObject({ version: 2, deliveries: [expected] })
    expect(v1.deliveries).toHaveLength(1)
    expect(v1).toMatchObject({ version: 1, deliveries: [expected] })
  })

  it("projects a not-yet-settled derived run as submitted, carrying the FACT's own timestamp", async () => {
    const mergeStarted = Promise.withResolvers<void>()
    const releaseMerge = Promise.withResolvers<void>()
    await using app = await createApp({
      mergeWait: { started: () => mergeStarted.resolve(), until: releaseMerge.promise },
    })
    await app.bays.recordBranchSubmit({ branch: "topic/derived-active", sha: HEAD_SHA, base: "main" })
    const factAt = app.bays.state().submits["topic/derived-active"]?.at
    expect(factAt).toBeDefined()

    const running = app.queue.run({}, RUNTIME)
    await mergeStarted.promise
    try {
      const { v1, v2 } = await readBridges(app)
      const expected = {
        issueRef: FIXTURE_ISSUE,
        pr: "PR1",
        revision: 1,
        headSha: HEAD_SHA,
        status: "submitted",
        // The fact's `at`, not the run's start: the standing submit ref IS the
        // submission the tracker is cursoring.
        at: factAt,
        runs: ["R1"],
      }
      expect(v2.deliveries).toHaveLength(1)
      expect(v2.deliveries).toMatchObject([expected])
      expect(v1.deliveries).toMatchObject([expected])
    } finally {
      releaseMerge.resolve()
      await running
    }

    // Same journal, after settlement: the row graduates to integrated.
    const settled = await readBridges(app)
    expect(settled.v2.deliveries).toMatchObject([{ pr: "PR1", status: "integrated", landingSha: MERGED_SHA }])
  })

  it("keeps a failed derived run visible as submitted while its fact still stands", async () => {
    await using app = await createApp({ failingMerge: true })
    await app.bays.recordBranchSubmit({ branch: "topic/derived-fails", sha: HEAD_SHA, base: "main" })
    const factAt = app.bays.state().submits["topic/derived-fails"]?.at

    expect(await app.queue.run({}, RUNTIME)).toMatchObject([{ status: "completed", conclusion: "failure" }])
    // The fact is standing consent: the queue re-serves it or the author
    // re-pushes, so the delivery is not terminally resolved — "submitted" is
    // true but imprecise until the durable refusal ledger (wave item) gives
    // derived members needs-author precision.
    expect(app.bays.state().submits["topic/derived-fails"]).toMatchObject({ sha: HEAD_SHA })

    const { v1, v2 } = await readBridges(app)
    const expected = {
      issueRef: FIXTURE_ISSUE,
      pr: "PR1",
      revision: 1,
      headSha: HEAD_SHA,
      status: "submitted",
      at: factAt,
      runs: ["R1"],
    }
    expect(v2.deliveries).toHaveLength(1)
    expect(v2.deliveries).toMatchObject([expected])
    expect(v1.deliveries).toMatchObject([expected])
  })

  it("keeps a passed check-only run — no integration proof — visible as submitted while its fact stands", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "topic/derived-checked", sha: HEAD_SHA, base: "main" })
    const factAt = app.bays.state().submits["topic/derived-checked"]?.at

    // A successful run with NO integration proof: the merge step never ran, so
    // the branch sits in the staged-but-unlanded window — checked, consented,
    // merge still pending. The standing fact keeps the row "submitted"; only
    // an integration proof graduates it.
    expect(await app.queue.run({ steps: ["check"] }, RUNTIME)).toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
    const run = app.queue.get("R1")
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    expect(run?.integration).toBeUndefined()
    expect(app.bays.state().submits["topic/derived-checked"]).toMatchObject({ sha: HEAD_SHA })

    const { v1, v2 } = await readBridges(app)
    const expected = {
      issueRef: FIXTURE_ISSUE,
      pr: "PR1",
      revision: 1,
      headSha: HEAD_SHA,
      status: "submitted",
      at: factAt,
      runs: ["R1"],
    }
    expect(v2.deliveries).toHaveLength(1)
    expect(v2.deliveries).toMatchObject([expected])
    expect(v1.deliveries).toMatchObject([expected])
  })

  it("projects NOTHING for a submit fact no compose has retained a run for yet", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "topic/derived-pending", sha: HEAD_SHA, base: "main" })

    // Deliberate absence, not an oversight: a fact with no retained run has no
    // member snapshot to project identity from. The pending window between
    // submit and first compose is the bridge's declared blind spot — a known
    // wave item (alongside the durable refusal ledger), kept loud here so its
    // closure has a fence to flip.
    const { v1, v2 } = await readBridges(app)
    expect(v2.deliveries).toEqual([])
    expect(v1.deliveries).toEqual([])
  })

  it("preserves already-landed equivalence evidence for a derived delivery in both bridge versions", async () => {
    const equivalentTreeSha = "e".repeat(40)
    await using app = await createApp({
      mergeCommits: [BASE_SHA],
      mergeAlreadyLanded: {
        candidateSha: HEAD_SHA,
        candidateTreeSha: equivalentTreeSha,
        baseTreeSha: equivalentTreeSha,
      },
    })
    await app.bays.recordBranchSubmit({ branch: "topic/derived-already", sha: HEAD_SHA, base: "main" })
    expect(await app.queue.run({}, RUNTIME)).toMatchObject([{ status: "completed", conclusion: "success" }])

    const { v1, v2 } = await readBridges(app)
    const expected = {
      issueRef: FIXTURE_ISSUE,
      pr: "PR1",
      revision: 1,
      headSha: HEAD_SHA,
      status: "already-landed",
      baseSha: BASE_SHA,
      candidateSha: HEAD_SHA,
      candidateTreeSha: equivalentTreeSha,
      baseTreeSha: equivalentTreeSha,
      runs: ["R1"],
    }
    expect(v2.deliveries).toHaveLength(1)
    expect(v2.deliveries).toMatchObject([expected])
    expect(v1.deliveries).toMatchObject([expected])
  })
})
