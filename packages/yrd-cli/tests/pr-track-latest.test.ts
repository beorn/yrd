/**
 * @failure A tracked PR (`yrd pr submit --track`) still refuses an implicit recut
 * when its branch moved instead of re-recording the live head, or tracking leaks
 * into an untracked PR and silently replays a moved branch as if it were the
 * recorded source.
 * @level l2
 * @consumer @yrd/cli
 *
 * Drives the real `runYrd` command surface like selector-surfaces.test.ts; the
 * live branch head is injected through YrdCliIO.pruneGit + resolveRevision, so
 * "the branch moved" is a deterministic fact rather than a Git race.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, currentPRRev, prDeliveryState, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd, type PruneGitFacts, type YrdCliIO } from "@yrd/cli"
import { withMerge, withQueue, withStep, type PRShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"

const BRANCH = "task/@yrd/core/22454-pr-track-latest"
const RECORDED_HEAD = "4d8615400959a1443b1664e707eecee10d6ebe95"
const LIVE_HEAD = "b3fae22ec7a08288b586a28b123a9e11ad3bca91"
const BASE_SHA = "a".repeat(40)
const TARGET_BASE_SHA = "d".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BASE_TREE = "e".repeat(40)
const OTHER_TREE = "f".repeat(40)
const OTHER_PATCH_ID = "172a29302878f4f7fd0dcfad917ddbf434e78d04"

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

/** Minimal contest adapters so the composed app matches YrdCliApp; tracking
 * never enters a contest, so passing stubs suffice. */
function contestAdapters() {
  const runner: ContestRunnerDef = {
    harness: "ag",
    revision: "ag-runner-v1",
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
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: { journal: createMemoryJournal(), clock: () => "2026-07-27T12:00:00.000Z", id: ids() },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

/** One mutable live branch tip drives every Git fact: `branchHead()` is what
 * `origin/<branch>` resolves to right now, exactly as a seat's push would move
 * it between two Yrd invocations. */
function trackGit(branchHead: () => string): PruneGitFacts {
  return {
    resolveCommit: (ref) => {
      if (ref === "origin/main") return TARGET_BASE_SHA
      if (ref === BRANCH || ref === `origin/${BRANCH}`) return branchHead()
      return ref === BASE_SHA || ref === RECORDED_HEAD || ref === LIVE_HEAD ? ref : undefined
    },
    isAncestor: () => false,
    // The merged tree differs from the target tip's tree, so the payload is
    // genuinely unlanded: the preflight verdict is RECUT, not SUBSUMED.
    mergeTree: () => OTHER_TREE,
    treeOf: (sha) => {
      if (sha !== TARGET_BASE_SHA) throw new Error(`treeOf must only inspect the target tip, got ${sha}`)
      return BASE_TREE
    },
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

/** `--json` renders a refusal as the failure envelope; its `message` is the exact
 * text a human sees on the plain surface. */
function failureMessage(stderr: string): string {
  return (JSON.parse(stderr) as { failure: { message: string } }).failure.message
}

/** The exact author-facing refusal an UNTRACKED moved branch must keep printing.
 * Tracking is opt-in; this text is the contract for everyone who did not opt in. */
function staleHeadRefusal(revision: number, recordedHead: string): string {
  return (
    `yrd: PR 'PR1' recorded revision ${String(revision)} head '${recordedHead}', but live branch ` +
    `'${BRANCH}' is '${LIVE_HEAD}'. Recut-by-PR is reproducible and will not silently replay stale work.\n` +
    "commits between: supplied observer did not enumerate the range\n" +
    `inspect: git log --oneline ${recordedHead}..${LIVE_HEAD}\n` +
    "To record the live head for fresh review:\n" +
    `  yrd pr submit ${BRANCH}\n` +
    "  yrd pr recut PR1 --preflight --queue\n" +
    "To deliberately replay the recorded revision:\n" +
    `  yrd pr recut PR1 --revision ${String(revision)} --preflight --queue`
  )
}

async function submitBranch(app: CliApp, head: () => string, ...flags: string[]): Promise<void> {
  const output = outputIO(head)
  const exit = await runYrd(app, yrd("pr", "submit", BRANCH, "--issue", "km#22454", "--json", ...flags), output.io)
  expect(exit, output.stderr()).toBe(0)
}

describe("pr submit --track", () => {
  it("records tracking on the PR and exposes it in the delivery envelope", async () => {
    const app = await createCliApp()
    const output = outputIO(() => RECORDED_HEAD)

    expect(await runYrd(app, yrd("pr", "submit", BRANCH, "--track", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ command: "pr.submit", prs: [{ id: "PR1", track: true }] })
    expect(app.bays.pr("PR1")?.track).toBe(true)
  })

  it("leaves an ordinary submit untracked", async () => {
    const app = await createCliApp()
    await submitBranch(app, () => RECORDED_HEAD)
    expect(app.bays.pr("PR1")?.track).toBeUndefined()
  })
})

describe("implicit recut of a moved branch", () => {
  it("refuses an UNTRACKED PR with the full reproducibility refusal", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head)

    head = LIVE_HEAD
    const refused = outputIO(() => head)
    const before = (await Array.fromAsync(app.events())).length

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--json"), refused.io)).toBe(1)
    expect(failureMessage(refused.stderr())).toBe(staleHeadRefusal(1, RECORDED_HEAD))
    expect((await Array.fromAsync(app.events())).length).toBe(before)
    expect(currentPRRev(app.bays.pr("PR1")!).n).toBe(1)
  })

  it("re-records the live head for a TRACKED PR and recuts the fresh revision", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    expect(prDeliveryState(app.bays.pr("PR1")!)).toBe("ready")

    head = LIVE_HEAD
    const tracked = outputIO(() => head)

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--json"), tracked.io),
      tracked.stderr(),
    ).toBe(0)
    // ONE line states what moved: old head, new head, old revision, new revision.
    expect(tracked.stderr()).toContain(
      `yrd: PR 'PR1' tracks '${BRANCH}'; recorded ${RECORDED_HEAD} -> ${LIVE_HEAD} (revision 1 -> 2)`,
    )
    expect(tracked.stderr()).not.toContain("will not silently replay stale work")

    const recorded = app.bays.pr("PR1")!
    expect(currentPRRev(recorded).n).toBe(2)
    expect(currentPRRev(recorded).head).toBe(LIVE_HEAD)
    // Re-recording an admitted PR creates a fresh submitted revision, and
    // tracking survives so the NEXT push re-records itself too.
    expect(prDeliveryState(recorded)).toBe("submitted")
    expect(recorded.track).toBe(true)
    // The recut then classifies the FRESH revision, not the stale one.
    expect(JSON.parse(tracked.stdout())).toMatchObject({ pr: "PR1", revision: 2, verdict: "RECUT" })
  })

  it("stops re-recording as soon as `pr edit --untrack` clears the opt-in", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")

    const edited = outputIO(() => head)
    expect(await runYrd(app, yrd("pr", "edit", "PR1", "--untrack", "--json"), edited.io), edited.stderr()).toBe(0)
    expect(app.bays.pr("PR1")?.track).toBe(false)

    head = LIVE_HEAD
    const refused = outputIO(() => head)
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--json"), refused.io)).toBe(1)
    expect(failureMessage(refused.stderr())).toBe(staleHeadRefusal(1, RECORDED_HEAD))
  })

  it("keeps the explicit --revision replay spelling exempt for a tracked PR", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")

    head = LIVE_HEAD
    const replay = outputIO(() => head)

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--revision", "1", "--preflight", "--queue", "--json"), replay.io),
      replay.stderr(),
    ).toBe(0)
    // An explicit replay is a deliberate operator choice: no auto-record, and the
    // recorded revision stays the one classified.
    expect(replay.stderr()).not.toContain("tracks")
    expect(currentPRRev(app.bays.pr("PR1")!).n).toBe(1)
    expect(JSON.parse(replay.stdout())).toMatchObject({ pr: "PR1", revision: 1 })
  })
})
