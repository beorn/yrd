/**
 * @failure A recordless direct-branch submit mints a change record instead of
 * routing to the derived lane, or a record-only tracking option is dropped
 * silently instead of riding the result envelope's warnings.
 * @level l2
 * @consumer @yrd/cli
 *
 * Drives the real `runYrd` command surface like selector-surfaces.test.ts; the
 * live branch head is injected through YrdCliIO.pruneGit + resolveRevision.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd, type PruneGitFacts, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { withMerge, withQueue, withStep, type ChangeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import { createLogger } from "loggily"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type CommitResolver,
  type ContestRunnerDef,
} from "@yrd/contest"

const BRANCH = "task/@yrd/core/22454-pr-track-latest"
const RECORDED_HEAD = "4d8615400959a1443b1664e707eecee10d6ebe95"
const LIVE_HEAD = "b3fae22ec7a08288b586a28b123a9e11ad3bca91"
const NEXT_LIVE_HEAD = "c".repeat(40)
const BASE_SHA = "a".repeat(40)
const TARGET_BASE_SHA = "d".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BASE_TREE = "e".repeat(40)
const OTHER_TREE = "f".repeat(40)
const OTHER_PATCH_ID = "172a29302878f4f7fd0dcfad917ddbf434e78d04"
const REMERGE_HEAD = "9".repeat(40)
const RECORDED_TREE = "1".repeat(40)
const LIVE_TREE = "2".repeat(40)

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "track-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: RECORDED_HEAD, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: {
        path: input.path ?? `/repo/.bays/${input.bay}`,
        headSha: RECORDED_HEAD,
        baseSha: BASE_SHA,
        dirty: false,
      },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: RECORDED_HEAD, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/** Minimal contest adapters so the composed app matches YrdCliApp; a direct
 * submit never enters a contest, so passing stubs suffice. */
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
      clock: () => "2026-07-27T12:00:00.000Z",
      id: ids(),
      log: createLogger("yrd", [{ level: "silent" }]),
    },
  })
}

/** One mutable live branch tip drives every Git fact: `branchHead()` is what
 * `origin/<branch>` resolves to right now, exactly as a seat's push would move
 * it between two Yrd invocations. */
function trackGit(branchHead: () => string): PruneGitFacts {
  return {
    resolveCommit: (ref) => {
      if (ref === "origin/main") return TARGET_BASE_SHA
      if (ref === BRANCH || ref === `origin/${BRANCH}`) return branchHead()
      return ref === BASE_SHA ||
        ref === RECORDED_HEAD ||
        ref === LIVE_HEAD ||
        ref === NEXT_LIVE_HEAD ||
        ref === REMERGE_HEAD
        ? ref
        : undefined
    },
    isAncestor: () => false,
    // The merged tree differs from the target tip's tree, so the payload is
    // genuinely unmerged.
    mergeTree: () => OTHER_TREE,
    treeOf: (sha) => {
      if (sha === TARGET_BASE_SHA) return BASE_TREE
      if (sha === RECORDED_HEAD) return RECORDED_TREE
      if (sha === LIVE_HEAD || sha === NEXT_LIVE_HEAD) return LIVE_TREE
      throw new Error(`unexpected tree lookup for ${sha}`)
    },
    // Linear by default: the preflight linear-root gate counts parents.
    parents: () => [BASE_SHA],
    pinDistance: () => ({ sourceOnly: 0, targetOnly: 3 }),
    patchMatch: () => ({ patchId: OTHER_PATCH_ID }),
  } as PruneGitFacts
}

function outputIO(branchHead: () => string) {
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
    runner: "track-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-27T12:01:00.000Z"),
    pruneGit: () => trackGit(branchHead),
    resolveRevision: async (ref) =>
      ref === BRANCH || ref === `origin/${BRANCH}` ? branchHead() : ref === BASE_SHA ? ref : undefined,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

const noRequiredChecks: YrdCliServices = {
  checks: {
    names: [],
    install: async () => "/repo/.git/yrd/hooks/pre-submit",
    run: async () => {
      throw new Error("no configured required check should run")
    },
  },
}

type SubmitEnvelope = Readonly<{
  command: string
  prs: readonly unknown[]
  derived: readonly unknown[]
  warnings?: readonly string[]
}>

const DERIVED_ACCEPTANCE_LINE = `submitted to the derived lane: ${BRANCH} @ ${RECORDED_HEAD.slice(0, 12)} (base main) — composes as a derived member on the next queue pass`

describe("pr submit tracking default", () => {
  // run.ts resolves the submitter seat from `process.env`, never from the
  // injected io (@i/10-yrd/24028): a real submit with no seat identity warns
  // "no submitter seat is recorded" (packages/yrd-cli/src/run.ts). These two
  // cases assert an exact `warnings` list for the derived-lane/track behavior
  // this block actually covers, so they must pin a submitter seat themselves
  // instead of inheriting whatever the ambient shell happens to have set —
  // the same guard cli.test.ts's withSubmitterEnv uses for the same reason.
  const priorSubmitter = process.env.YRD_DEFAULT_SUBMITTER
  beforeEach(() => {
    process.env.YRD_DEFAULT_SUBMITTER = "@dev/9"
  })
  afterEach(() => {
    if (priorSubmitter === undefined) delete process.env.YRD_DEFAULT_SUBMITTER
    else process.env.YRD_DEFAULT_SUBMITTER = priorSubmitter
  })

  it("an ordinary submit routes derived with no tracking bit", async () => {
    const app = await createCliApp()
    const output = outputIO(() => RECORDED_HEAD)

    expect(await runYrd(app, yrd("pr", "submit", BRANCH, "--json"), output.io, noRequiredChecks), output.stderr()).toBe(
      0,
    )
    const envelope = JSON.parse(output.stdout()) as SubmitEnvelope
    expect(envelope.command).toBe("pr.submit")
    expect(envelope.prs).toEqual([])
    expect(envelope.derived).toEqual([{ lane: "derived", branch: BRANCH, sha: RECORDED_HEAD, base: "main" }])
    // The CLI forwards no track option when neither flag was given, so the
    // derived route drops nothing: the only warning is the acceptance line,
    // never a record-only drop.
    expect(envelope.warnings).toEqual([DERIVED_ACCEPTANCE_LINE])
    // The fact is the submission — no change record mints.
    expect(app.bays.prs()).toEqual([])
  })

  it("--no-track warns record-only and the submit still lands derived", async () => {
    const app = await createCliApp()
    const output = outputIO(() => RECORDED_HEAD)

    expect(
      await runYrd(app, yrd("pr", "submit", BRANCH, "--no-track", "--json"), output.io, noRequiredChecks),
      output.stderr(),
    ).toBe(0)
    const envelope = JSON.parse(output.stdout()) as SubmitEnvelope
    expect(envelope.command).toBe("pr.submit")
    expect(envelope.prs).toEqual([])
    expect(envelope.derived).toEqual([{ lane: "derived", branch: BRANCH, sha: RECORDED_HEAD, base: "main" }])
    // track binds to change records; on the derived lane it is dropped LOUDLY
    // in the envelope warnings while the submit succeeds.
    expect(envelope.warnings).toEqual([
      `track binds to change records; the derived lane reads identity from the branch and metadata from the commit, so they were not recorded — amend the commit on '${BRANCH}' to carry them`,
      DERIVED_ACCEPTANCE_LINE,
    ])
    expect(app.bays.prs()).toEqual([])
  })
})

// Deleted with the legacy record mint (2026-08-27): the blocks "implicit recut
// of a moved branch" and "habitant merge-into-latest" covered record-tracking
// machinery (tracked recuts, preflight verdicts, untrack races) whose fixtures
// minted records via direct-branch submits, which no longer exist; the derived
// lane recomposes against current main every pass, subsuming merge-into-latest
// for direct branches, and the record store deletes at S7 (@i/10-merge-queue 22991).
//
// implicit recut of a moved branch:
//   - certifies an equivalent tracked candidate instead of leaving the recorded head stale
// habitant merge-into-latest:
//   - certifies a tracked branch push directly and queues the frozen recut without an operator turn
//   - resumes after the live revision was recorded but its preflight was interrupted
//   - does not observe or re-record an explicitly untracked branch
//   - preserves an authored push that arrives while the tracked recut is computing
//   - does not apply a RECUT verdict after a newer authored revision arrives during preflight
//   - does not apply a RECUT verdict after tracking is disabled while the recut is computing
//   - does not cancel a successor by PR wildcard when it arrives during pin inspection
//   - does not route direct tracked certification through authored submit
//   - does not record stale tracking intent when --untrack wins during branch observation
//   - records a decision-required preflight comment once for the exact tracked source
//   - does not attach a stale decision-required verdict to a newer authored revision
//   - does not apply a FRESH-NOOP verdict after a newer authored revision arrives during preflight
//   - observes the next push for a tracked change whose prior checks failed
