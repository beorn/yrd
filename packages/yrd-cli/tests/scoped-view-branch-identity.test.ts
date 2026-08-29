/**
 * @failure A scoped view resolves its scope to minted change ids ALONE, so a
 * DERIVED-lane row — projected from a standing submit fact that predates any
 * mint, whose only identity is its BRANCH — can never be matched by that
 * scope, and the surviving filter admits it anyway: naming one delivery still
 * renders an unrelated branch's submission (23238). The rule it rode in on was
 * a disjunction (selected OR non-terminal), so a scope could only ever ADD
 * rows to a surface, never remove one.
 * @level l2
 * @consumer @yrd/cli every operator who scopes a queue view to one delivery
 */
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import {
  createBayJobDefs,
  volatilePrNumberMint,
  withBays,
  type BaysState,
  type Change,
  type ProjectedBranchSubmit,
} from "@yrd/bay"
import { runYrd as runYrdRaw, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type CommitResolver,
  type ContestRunnerDef,
} from "@yrd/contest"
import { createLogger } from "loggily"

import { fixturePr } from "../dev/queue-timeline-fixtures.ts"
import {
  humanQueueProjection,
  queueStatusRows,
  QueueStatusView,
  type QueueStatusResult,
} from "../src/queue-status-view.tsx"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
/** The unrelated delivery: a branch standing on its own submit fact, with no
 * record and therefore no minted id — the shape `git push bay
 * HEAD:refs/for/main/<issue>` leaves behind post-S6. */
const OTHER_BRANCH = "@i/10-yrd/23238-unrelated-branch"
const OTHER_SHA = "d".repeat(40)
const RESUBMIT_SHA = "e".repeat(40)
const NOW = Date.parse("2026-07-09T12:10:00.000Z")

function submitFact(sha: string, at = "2026-07-09T12:05:00.000Z"): ProjectedBranchSubmit {
  return { sha, base: "main", at }
}

function baysState(prs: readonly Change[], submits: Readonly<Record<string, ProjectedBranchSubmit>>): BaysState {
  return { byId: {}, prs: Object.fromEntries(prs.map((pr) => [pr.id, pr])), receipts: {}, submits }
}

function result(prs: readonly Change[], admissionOrder: readonly string[]): QueueStatusResult {
  return {
    base: "main",
    headSha: BASE_SHA,
    prs: [...prs],
    admissionOrder: [...admissionOrder],
    running: [],
    waiting: [],
    finished: [],
  }
}

/** The scope exactly as `resolveQueueTargets` now mints it: BOTH spellings of
 * the named delivery's identity, because the rows it must filter are keyed
 * either way. */
function scopeOf(pr: Change): ReadonlySet<string> {
  return new Set([pr.id, pr.branch])
}

/** The pre-fix scope: minted ids only. Kept as the negative control — every
 * exclusion below must fail against it, or the test is not measuring the fix. */
function idOnlyScopeOf(pr: Change): ReadonlySet<string> {
  return new Set([pr.id])
}

describe("a scoped view resolves both spellings of a delivery's identity", () => {
  it("renders the unrelated branch when nothing is scoped — the rule the fix must not break", () => {
    const recorded = fixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Recorded change")
    const projection = humanQueueProjection(result([recorded], ["PR1"]), NOW, {
      state: baysState([recorded], { [OTHER_BRANCH]: submitFact(OTHER_SHA) }),
    })

    expect(projection.open, "one record plus one standing fact").toBe(2)
    expect(projection.queue.map((row) => row.pr)).toEqual(["PR1", OTHER_BRANCH])
  })

  it("drops the unrelated branch's standing fact once one delivery is named", () => {
    const recorded = fixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Recorded change")
    const state = baysState([recorded], { [OTHER_BRANCH]: submitFact(OTHER_SHA) })
    const scoped = humanQueueProjection(result([recorded], ["PR1"]), NOW, { selected: scopeOf(recorded), state })

    expect(scoped.open, "the named delivery, and nothing else").toBe(1)
    expect(scoped.queue.map((row) => row.pr)).toEqual(["PR1"])
    expect(
      scoped.queue.map((row) => row.branch),
      "a scope that cannot exclude is a scope that only ever adds",
    ).not.toContain(OTHER_BRANCH)
  })

  it("keeps the NAMED delivery's own branch-keyed fact — exclusion is by identity, not by lane", () => {
    // A merged record whose branch carries a NEW head: terminal record plus a
    // different-sha submit is the derived lane's re-entry cell, so this row is
    // keyed by BRANCH even though the delivery has a minted id.
    const merged = fixturePr("PR1", "integrated", "2026-07-09T12:00:00.000Z", "Merged change", {
      integratedAt: "2026-07-09T12:02:00.000Z",
      integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
    })
    const state = baysState([merged], {
      [merged.branch]: submitFact(RESUBMIT_SHA, "2026-07-09T12:06:00.000Z"),
      [OTHER_BRANCH]: submitFact(OTHER_SHA),
    })
    const scoped = humanQueueProjection(result([merged], []), NOW, { selected: scopeOf(merged), state })

    expect(scoped.open, "the named branch's own resubmission, and only that").toBe(1)
    expect(scoped.queue.map((row) => row.pr)).toEqual([merged.branch])
    expect(scoped.queue[0]).toMatchObject({ branch: merged.branch, factOnly: true, revision: 0 })

    const idOnly = humanQueueProjection(result([merged], []), NOW, { selected: idOnlyScopeOf(merged), state })
    expect(
      idOnly.queue.map((row) => row.pr),
      "control: an id-only scope matches NEITHER branch-keyed row, so scoping is blind either way",
    ).toEqual([])
  })

  it("shows the operator only the named delivery in the rendered frame", async () => {
    const recorded = fixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Recorded change")
    const state = baysState([recorded], { [OTHER_BRANCH]: submitFact(OTHER_SHA) })
    const frame = async (selected: ReadonlySet<string>) =>
      renderString(
        createElement(QueueStatusView, { state, results: [result([recorded], ["PR1"])], selected, now: NOW }),
        {
          width: 160,
          height: 24,
          plain: true,
        },
      )

    const unscoped = await frame(new Set<string>())
    expect(unscoped, "control: the unscoped surface still shows live work").toContain(OTHER_BRANCH)
    expect(unscoped).toContain("OPEN 2")

    const scoped = await frame(scopeOf(recorded))
    expect(scoped).toContain("OPEN 1")
    expect(scoped, "the leak the operator sees").not.toContain(OTHER_BRANCH)
    expect(scoped, "the named delivery is still there").toContain("pr#1.1")
  })
})

describe("the terminal rule and the scope are two rules, not one disjunction", () => {
  const live = fixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Live change")
  const done = fixturePr("PR2", "integrated", "2026-07-09T11:00:00.000Z", "Merged change", {
    integratedAt: "2026-07-09T11:30:00.000Z",
    integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
  })
  const state = baysState([live, done], { [OTHER_BRANCH]: submitFact(OTHER_SHA) })
  const snapshot = result([live, done], ["PR1"])

  it("unscoped, keeps every non-terminal row and hides the terminal one — unchanged", () => {
    const rows = queueStatusRows(state, snapshot, new Set<string>(), NOW)

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.pr)).toEqual(["PR1", OTHER_BRANCH])
  })

  it("scoped, keeps the named delivery even when terminal and nothing else", () => {
    const rows = queueStatusRows(state, snapshot, scopeOf(done), NOW)

    expect(rows).toHaveLength(1)
    expect(rows.map((row) => row.pr)).toEqual(["PR2"])
    expect(
      rows.map((row) => row.pr),
      "a non-terminal row can no longer ride in on the second arm",
    ).not.toContain(OTHER_BRANCH)
  })
})

function workspace() {
  return {
    revision: "scoped-view-workspace-v1",
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

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

/** Stub contest adapters so the composed app satisfies YrdCliApp; nothing here
 * enters a contest. */
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
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
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
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-07-09T12:00:00.000Z",
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
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
    runner: "scoped-view-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

describe("the CLI scope carries the branch through to the rendered surface", () => {
  /** One record on `topic/one`, plus an unrelated branch standing on its own
   * submit fact. Naming the record BY ITS BRANCH is the whole point: the
   * selector the operator typed must survive into the scope, or a branch-keyed
   * row has nothing to be compared against. */
  async function twoLaneApp() {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.recordBranchSubmit({ branch: OTHER_BRANCH, sha: OTHER_SHA, base: "main" })
    return app
  }

  it("shows both branches unscoped and only the named one when scoped", async () => {
    const app = await twoLaneApp()

    const unscoped = outputIO()
    expect(await runYrd(app, yrd(), unscoped.io), unscoped.stderr()).toBe(0)
    expect(unscoped.stdout(), "control: the unscoped surface still shows the derived lane").toContain(OTHER_BRANCH)

    const scoped = outputIO()
    expect(await runYrd(app, yrd("--base", "topic/one"), scoped.io), scoped.stderr()).toBe(0)
    expect(scoped.stdout(), "the named delivery survives its own scope").toContain("pr#1.1")
    expect(scoped.stdout(), "an unrelated branch does not").not.toContain(OTHER_BRANCH)
  })
})
