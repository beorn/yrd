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
import { describe, expect, it, vi } from "vitest"
import { createBayJobDefs, currentChangeRev, changeAdmission, changeDeliveryState, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { runYrd, type PruneGitFacts, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { withMerge, withQueue, withStep, type ChangeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import type { ProcessRequest } from "@yrd/process"
import { withIssues } from "@yrd/issue"
import { createLogger } from "loggily"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import * as runInternals from "../src/run.ts"

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
const RECUT_HEAD = "9".repeat(40)
const RECUT_TREE = "8".repeat(40)
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

/** Minimal contest adapters so the composed app matches YrdCliApp; tracking
 * never enters a contest, so passing stubs suffice. */
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

async function createCliApp(behavior: Readonly<{ failingCheck?: boolean }> = {}) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> =>
      behavior.failingCheck === true
        ? {
            status: "completed",
            conclusion: "failure",
            error: { code: "authored-failure", message: "authored revision needs work" },
          }
        : { status: "completed", conclusion: "success", output: { checked: true } },
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
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-07-27T12:00:00.000Z",
      id: ids(),
      log: createLogger("yrd", [{ level: "silent" }]),
    },
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
      return ref === BASE_SHA ||
        ref === RECORDED_HEAD ||
        ref === LIVE_HEAD ||
        ref === NEXT_LIVE_HEAD ||
        ref === RECUT_HEAD
        ? ref
        : undefined
    },
    isAncestor: () => false,
    // The merged tree differs from the target tip's tree, so the payload is
    // genuinely unlanded: the preflight verdict is RECUT, not SUBSUMED.
    mergeTree: () => OTHER_TREE,
    treeOf: (sha) => {
      if (sha === TARGET_BASE_SHA) return BASE_TREE
      if (sha === RECORDED_HEAD) return RECORDED_TREE
      if (sha === LIVE_HEAD || sha === NEXT_LIVE_HEAD) return LIVE_TREE
      throw new Error(`unexpected tree lookup for ${sha}`)
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

const noRequiredChecks: YrdCliServices = {
  checks: {
    names: [],
    install: async () => "/repo/.git/yrd/hooks/pre-submit",
    run: async () => {
      throw new Error("no configured required check should run")
    },
  },
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
    "To record the live head and finish the requested recut:\n" +
    `  yrd pr submit ${BRANCH}\n` +
    "  yrd pr recut PR1 --queue\n" +
    "To deliberately replay the recorded revision:\n" +
    `  yrd pr recut PR1 --revision ${String(revision)} --preflight --queue`
  )
}

async function submitBranch(app: CliApp, head: () => string, ...flags: string[]): Promise<void> {
  const output = outputIO(head)
  const exit = await runYrd(
    app,
    yrd("pr", "submit", BRANCH, "--issue", "km#22454", "--json", ...flags),
    output.io,
    noRequiredChecks,
  )
  expect(exit, output.stderr()).toBe(0)
}

describe("pr submit --track", () => {
  it("records tracking on the PR and exposes it in the delivery envelope", async () => {
    const app = await createCliApp()
    const output = outputIO(() => RECORDED_HEAD)

    expect(
      await runYrd(app, yrd("pr", "submit", BRANCH, "--track", "--json"), output.io, noRequiredChecks),
      output.stderr(),
    ).toBe(0)
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
    expect(currentChangeRev(app.bays.pr("PR1")!).n).toBe(1)
  })

  it("prints a complete recovery that records and queues a moved draft without another remedy", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    const created = outputIO(() => head)
    expect(
      await runYrd(app, yrd("pr", "create", BRANCH, "--issue", "km#22454", "--json"), created.io, noRequiredChecks),
      created.stderr(),
    ).toBe(0)

    head = LIVE_HEAD
    const refused = outputIO(() => head)
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), refused.io)).toBe(1)
    expect(failureMessage(refused.stderr())).toContain(
      "To record the live head and finish the requested recut:\n" +
        `  yrd pr create ${BRANCH}\n` +
        "  yrd pr recut PR1 --queue",
    )
    expect(failureMessage(refused.stderr())).not.toContain("yrd pr recut PR1 --preflight --queue")

    const refreshed = outputIO(() => head)
    expect(
      await runYrd(app, yrd("pr", "create", BRANCH, "--json"), refreshed.io, noRequiredChecks),
      refreshed.stderr(),
    ).toBe(0)
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: LIVE_HEAD })

    const remerge = vi.fn(async () => ({
      headSha: RECUT_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: false,
    }))
    const queued = outputIO(() => head)
    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), queued.io, {
        ...noRequiredChecks,
        recut: { recut: remerge },
      }),
      queued.stderr(),
    ).toBe(0)
    expect(JSON.parse(queued.stdout())).toMatchObject({ pr: "PR1", revision: 3 })
    expect(remerge).toHaveBeenCalledWith(expect.objectContaining({ id: "PR1", revision: 2, headSha: LIVE_HEAD }))
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
    expect(app.bays.checksRequested("PR1")).toBe(true)
  })

  it("preflights a tracked live candidate without recording a provisional revision", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")

    head = LIVE_HEAD
    const tracked = outputIO(() => head)

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--json"), tracked.io),
      tracked.stderr(),
    ).toBe(0)
    expect(tracked.stderr()).toBe("")
    expect(tracked.stderr()).not.toContain("will not silently replay stale work")

    const recorded = app.bays.pr("PR1")!
    expect(currentChangeRev(recorded)).toMatchObject({ n: 1, head: RECORDED_HEAD })
    expect(changeDeliveryState(recorded)).toBe("submitted")
    expect(recorded.track).toBe(true)
    expect(JSON.parse(tracked.stdout())).toMatchObject({
      pr: "PR1",
      revision: 1,
      verdict: "RECUT",
      evidence: { headSha: RECORDED_HEAD, proposedHeadSha: LIVE_HEAD },
    })
  })

  it("certifies an equivalent tracked candidate instead of leaving the recorded head stale", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-equivalent-r1" })
    head = LIVE_HEAD

    const git = trackGit(() => head)
    const output = outputIO(() => head)
    const io: YrdCliIO = {
      ...output.io,
      pruneGit: () => ({
        ...git,
        patchMatch: () => ({ patchId: OTHER_PATCH_ID, targetSha: LIVE_HEAD }),
      }),
    }
    const remerge = vi.fn(async () => ({
      headSha: LIVE_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: true,
    }))

    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: remerge } } as YrdCliServices, io),
    ).resolves.toMatchObject([
      {
        status: "applied",
        pr: "PR1",
        sourceRevision: 1,
        sourceHead: RECORDED_HEAD,
        currentRevision: 2,
        verdict: "RECUT",
      },
    ])
    expect(remerge).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, headSha: RECORDED_HEAD, proposedHeadSha: LIVE_HEAD }),
    )
    expect(app.bays.pr("PR1")?.revs).toMatchObject([
      { n: 1, head: RECORDED_HEAD },
      { n: 2, head: LIVE_HEAD },
    ])
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

  it("refuses explicit --revision replay when the recorded and live trees differ", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")

    head = LIVE_HEAD
    const replay = outputIO(() => head)

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--revision", "1", "--queue", "--json"), replay.io)).toBe(1)
    expect(failureMessage(replay.stderr())).toContain(
      `recorded revision 1 tree '${RECORDED_TREE}' differs from live branch '${BRANCH}' tree '${LIVE_TREE}'`,
    )
    expect(replay.stderr()).not.toContain("tracks")
    expect(currentChangeRev(app.bays.pr("PR1")!).n).toBe(1)
    expect(replay.stdout()).toBe("")
  })
})

describe("resident merge-into-latest", () => {
  it("certifies a tracked branch push directly and queues the frozen recut without an operator turn", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-resident-r1" })
    head = LIVE_HEAD

    const output = outputIO(() => head)
    const controller = new AbortController()
    const drain = new AbortController()
    const io: YrdCliIO = {
      ...output.io,
      drainSignal: drain.signal,
      resolveQueueTarget: async () => ({ base: "main", sha: TARGET_BASE_SHA }),
      scope: {
        signal: controller.signal,
        sleep: async () => {
          drain.abort()
        },
      },
    }
    const remerge = vi.fn(async () => ({
      headSha: RECUT_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: false,
    }))
    const gate = vi.fn(async () => undefined)

    await expect(
      runInternals.followQueueRuns(app, [], { json: true, interval: 1 }, io, gate, {
        recut: { recut: remerge },
      } as YrdCliServices),
    ).resolves.toBe(0)

    expect(remerge).toHaveBeenCalledOnce()
    expect(remerge).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "PR1",
        revision: 1,
        headSha: RECORDED_HEAD,
        proposedHeadSha: LIVE_HEAD,
      }),
    )
    expect(app.bays.pr("PR1")).toMatchObject({
      track: true,
      revs: [
        { n: 1, head: RECORDED_HEAD },
        { n: 2, head: RECUT_HEAD, recut: { fromRevision: 1, certificate: "frozen-code-carrier-v1" } },
      ],
    })
    expect(output.stderr()).toBe("")
  })

  it("resumes after the live revision was recorded but its preflight was interrupted", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")

    head = LIVE_HEAD
    await app.bays.submitSelection(BRANCH, {
      resolveRevision: async () => head,
      run: { runner: "track-test", leaseMs: 60_000 },
    })
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: LIVE_HEAD })
    expect(app.bays.checksRequested("PR1")).toBe(false)

    const output = outputIO(() => head)
    const remerge = vi.fn(async () => ({
      headSha: RECUT_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: false,
    }))
    const services = { recut: { recut: remerge } } as YrdCliServices

    await expect(runInternals.refreshTrackedQueueRevisions(app, services, output.io)).resolves.toMatchObject([
      {
        status: "applied",
        pr: "PR1",
        recorded: false,
        sourceRevision: 2,
        sourceHead: LIVE_HEAD,
        currentRevision: 3,
        verdict: "RECUT",
      },
    ])
    expect(remerge).toHaveBeenCalledOnce()
    expect(app.bays.checksRequested("PR1")).toBe(true)

    // A completed cycle is idempotent until the branch moves again.
    await expect(runInternals.refreshTrackedQueueRevisions(app, services, output.io)).resolves.toEqual([])
    expect(remerge).toHaveBeenCalledOnce()
  })

  it("does not observe or re-record an untracked branch", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head)
    head = LIVE_HEAD

    const remerge = vi.fn()
    const output = outputIO(() => head)
    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: remerge } } as YrdCliServices, output.io),
    ).resolves.toEqual([])
    expect(remerge).not.toHaveBeenCalled()
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 1, head: RECORDED_HEAD })
  })

  it("preserves an authored push that arrives while the tracked recut is computing", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-race-r1" })
    head = LIVE_HEAD

    const output = outputIO(() => head)
    let attempt = 0
    const remerge = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        head = NEXT_LIVE_HEAD
        await app.bays.submitSelection(BRANCH, {
          resolveRevision: async () => head,
          run: { runner: "track-test", leaseMs: 60_000 },
        })
      }
      return {
        headSha: RECUT_HEAD,
        baseSha: TARGET_BASE_SHA,
        treeSha: RECUT_TREE,
        patchId: OTHER_PATCH_ID,
        unchanged: false,
      }
    })
    const services = { recut: { recut: remerge } } as YrdCliServices

    await expect(runInternals.refreshTrackedQueueRevisions(app, services, output.io)).resolves.toMatchObject([
      {
        status: "deferred",
        pr: "PR1",
        code: "recut-current-changed",
      },
    ])
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: NEXT_LIVE_HEAD })

    await expect(runInternals.refreshTrackedQueueRevisions(app, services, output.io)).resolves.toMatchObject([
      {
        status: "applied",
        pr: "PR1",
        sourceRevision: 2,
        sourceHead: NEXT_LIVE_HEAD,
        currentRevision: 3,
      },
    ])
    expect(remerge).toHaveBeenCalledTimes(2)
    expect(app.bays.pr("PR1")?.revs).toMatchObject([
      { n: 1, head: RECORDED_HEAD },
      { n: 2, head: NEXT_LIVE_HEAD },
      { n: 3, head: RECUT_HEAD },
    ])
  })

  it("does not apply a RECUT verdict after a newer authored revision arrives during preflight", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-preflight-r1" })
    head = LIVE_HEAD

    const output = outputIO(() => head)
    const git = trackGit(() => head)
    let advanced = false
    const io: YrdCliIO = {
      ...output.io,
      pruneGit: () => ({
        ...git,
        patchMatch: async (...args) => {
          if (!advanced) {
            advanced = true
            head = NEXT_LIVE_HEAD
            await app.bays.submitSelection(BRANCH, {
              resolveRevision: async () => head,
              run: { runner: "track-test", leaseMs: 60_000 },
            })
          }
          return git.patchMatch!(...args)
        },
      }),
    }
    const remerge = vi.fn()

    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: remerge } } as YrdCliServices, io),
    ).resolves.toMatchObject([
      {
        status: "deferred",
        pr: "PR1",
        revision: 1,
        headSha: RECORDED_HEAD,
        code: "recut-current-changed",
      },
    ])
    expect(remerge).not.toHaveBeenCalled()
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: NEXT_LIVE_HEAD })
  })

  it("does not apply a RECUT verdict after tracking is disabled while the recut is computing", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-untrack-r1" })
    head = LIVE_HEAD

    const remerge = vi.fn(async () => {
      await app.bays.editPr({ pr: "PR1", track: false })
      return {
        headSha: RECUT_HEAD,
        baseSha: TARGET_BASE_SHA,
        treeSha: RECUT_TREE,
        patchId: OTHER_PATCH_ID,
        unchanged: false,
      }
    })

    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: remerge } } as YrdCliServices, outputIO(() => head).io),
    ).resolves.toMatchObject([
      {
        status: "deferred",
        pr: "PR1",
        revision: 1,
        headSha: RECORDED_HEAD,
        code: "recut-current-changed",
      },
    ])
    expect(app.bays.pr("PR1")?.track).toBe(false)
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 1, head: RECORDED_HEAD })
  })

  it("does not cancel a successor by PR wildcard when it arrives during pin inspection", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-pin-r1" })
    head = LIVE_HEAD

    let advanced = false
    const process = {
      // Pin inspection opens by asking Git where the branch diverged from its
      // base; answering that with silence would say this repository has no
      // shared history, and inspection would refuse before it reaches the
      // successor race this test is about.
      run: async (request: ProcessRequest) => {
        if (!advanced) {
          advanced = true
          head = NEXT_LIVE_HEAD
          await app.bays.submitSelection(BRANCH, {
            resolveRevision: async () => head,
            run: { runner: "track-test", leaseMs: 60_000 },
          })
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: request.argv.includes("merge-base") ? `${BASE_SHA}\n` : "",
          stderr: "",
          durationMs: 1,
          timedOut: false as const,
        }
      },
      reapPath: async () => ({ targetedPids: [], survivorPids: [], forcedKill: false, signalFailures: [] }),
    }
    const broadCancel = vi.fn(app.queue.cancel.bind(app.queue))
    const residentApp = { ...app, queue: { ...app.queue, cancel: broadCancel } }
    const remerge = vi.fn(async () => ({
      headSha: RECUT_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: false,
    }))

    await expect(
      runInternals.refreshTrackedQueueRevisions(
        residentApp,
        { process, recut: { recut: remerge } } as YrdCliServices,
        outputIO(() => head).io,
      ),
    ).resolves.toMatchObject([
      {
        status: "deferred",
        pr: "PR1",
        revision: 1,
        headSha: RECORDED_HEAD,
        code: "ready-current-changed",
      },
    ])
    expect(broadCancel).not.toHaveBeenCalled()
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 3, head: NEXT_LIVE_HEAD })
  })

  it("does not route direct tracked certification through authored submit", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-no-submit-r1" })
    head = LIVE_HEAD

    const submit = vi.fn(app.bays.submit.bind(app.bays))
    const bays = {
      ...app.bays,
      submit,
    }
    const residentApp = { ...app, bays }
    const remerge = vi.fn(async () => ({
      headSha: RECUT_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: false,
    }))

    await expect(
      runInternals.refreshTrackedQueueRevisions(
        residentApp,
        { recut: { recut: remerge } } as YrdCliServices,
        outputIO(() => head).io,
      ),
    ).resolves.toMatchObject([
      {
        status: "applied",
        pr: "PR1",
        sourceRevision: 1,
        currentRevision: 2,
      },
    ])
    expect(submit).not.toHaveBeenCalled()
    expect(remerge).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, headSha: RECORDED_HEAD, proposedHeadSha: LIVE_HEAD }),
    )
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: RECUT_HEAD })
  })

  it("does not record stale tracking intent when --untrack wins during branch observation", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    head = LIVE_HEAD

    const output = outputIO(() => head)
    const git = trackGit(() => head)
    let untracked = false
    const io: YrdCliIO = {
      ...output.io,
      pruneGit: () => ({
        ...git,
        resolveCommit: async (ref) => {
          if (!untracked && ref === `origin/${BRANCH}`) {
            untracked = true
            await app.bays.editPr({ pr: "PR1", track: false })
          }
          return git.resolveCommit(ref)
        },
      }),
    }
    const remerge = vi.fn()

    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: remerge } } as YrdCliServices, io),
    ).resolves.toMatchObject([{ status: "deferred", pr: "PR1", code: "recut-current-changed" }])
    expect(app.bays.pr("PR1")?.track).toBe(false)
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 1, head: RECORDED_HEAD })
    expect(remerge).not.toHaveBeenCalled()
  })

  it("records a decision-required preflight comment once for the exact tracked source", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    head = LIVE_HEAD

    const output = outputIO(() => head)
    const git = trackGit(() => head)
    const io: YrdCliIO = {
      ...output.io,
      pruneGit: () => ({ ...git, isAncestor: () => true }),
    }
    const services = { recut: { recut: vi.fn() } } as YrdCliServices

    const expected = [
      {
        status: "needs-person",
        pr: "PR1",
        revision: 1,
        headSha: RECORDED_HEAD,
        code: "refusal-remedy-needs-withdraw",
      },
    ] as const
    await expect(runInternals.refreshTrackedQueueRevisions(app, services, io)).resolves.toMatchObject(expected)
    expect(app.bays.pr("PR1")?.comments).toHaveLength(1)
    await expect(runInternals.refreshTrackedQueueRevisions(app, services, io)).resolves.toMatchObject(expected)
    expect(app.bays.pr("PR1")?.comments).toHaveLength(1)
  })

  it("does not attach a stale decision-required verdict to a newer authored revision", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    head = LIVE_HEAD

    const output = outputIO(() => head)
    const git = trackGit(() => head)
    let advanced = false
    const io: YrdCliIO = {
      ...output.io,
      pruneGit: () => ({
        ...git,
        isAncestor: async () => {
          if (!advanced) {
            advanced = true
            head = NEXT_LIVE_HEAD
            await app.bays.submitSelection(BRANCH, {
              resolveRevision: async () => head,
              run: { runner: "track-test", leaseMs: 60_000 },
            })
          }
          return true
        },
      }),
    }
    const services = { recut: { recut: vi.fn() } } as YrdCliServices

    await expect(runInternals.refreshTrackedQueueRevisions(app, services, io)).resolves.toMatchObject([
      {
        status: "deferred",
        pr: "PR1",
        revision: 1,
        headSha: RECORDED_HEAD,
        code: "comment-current-changed",
      },
    ])
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: NEXT_LIVE_HEAD })
    expect(app.bays.pr("PR1")?.comments).toEqual([])
  })

  it("does not apply a FRESH-NOOP verdict after a newer authored revision arrives during preflight", async () => {
    const app = await createCliApp()
    let head = RECORDED_HEAD
    await submitBranch(app, () => head, "--track")
    head = LIVE_HEAD
    await app.bays.submitSelection(BRANCH, {
      resolveRevision: async () => head,
      run: { runner: "track-test", leaseMs: 60_000 },
    })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 2,
      headSha: RECUT_HEAD,
      baseSha: BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      reviewCarried: false,
      expectedCurrent: { revision: 2, headSha: LIVE_HEAD },
    })
    await app.bays.submit({ pr: "PR1" })
    head = RECUT_HEAD
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 3, head: RECUT_HEAD })
    expect(app.bays.checksRequested("PR1")).toBe(false)

    const output = outputIO(() => head)
    const git = trackGit(() => head)
    let advanced = false
    const io: YrdCliIO = {
      ...output.io,
      pruneGit: () => ({
        ...git,
        resolveCommit: (ref) => (ref === "origin/main" ? BASE_SHA : git.resolveCommit(ref)),
        treeOf: (sha) => (sha === BASE_SHA ? BASE_TREE : git.treeOf(sha)),
        pinDistance: () => ({ sourceOnly: 0, targetOnly: 0 }),
        patchMatch: async (...args) => {
          if (!advanced) {
            advanced = true
            head = NEXT_LIVE_HEAD
            await app.bays.submitSelection(BRANCH, {
              resolveRevision: async () => head,
              run: { runner: "track-test", leaseMs: 60_000 },
            })
          }
          return git.patchMatch!(...args)
        },
      }),
    }

    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: vi.fn() } } as YrdCliServices, io),
    ).resolves.toMatchObject([
      {
        status: "deferred",
        pr: "PR1",
        revision: 3,
        headSha: RECUT_HEAD,
        code: "recut-current-changed",
      },
    ])
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 4, head: NEXT_LIVE_HEAD })
    expect(app.bays.checksRequested("PR1")).toBe(false)
  })

  it("observes the next push for a tracked PR whose prior checks failed", async () => {
    const behavior = { failingCheck: true }
    const app = await createCliApp(behavior)
    let head = RECORDED_HEAD
    const submitted = outputIO(() => head)
    expect(
      await runYrd(
        app,
        yrd("pr", "submit", BRANCH, "--issue", "km#22454", "--track", "--json"),
        submitted.io,
        noRequiredChecks,
      ),
      submitted.stderr(),
    ).toBe(0)
    await expect(app.queue.run({ prs: ["PR1"] }, { runner: "track-test", leaseMs: 60_000 })).resolves.toEqual([])
    const failed = app.bays.pr("PR1")
    if (failed === undefined) throw new Error("expected PR1")
    expect(changeAdmission(failed)).toMatchObject({
      status: "refused",
      kind: "failure",
      receipt: { code: "authored-failure" },
    })
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
    expect(app.queue.eligibility("PR1")).toMatchObject({ checks: { status: "failed" } })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-after-failure-r1" })

    behavior.failingCheck = false
    head = LIVE_HEAD
    const output = outputIO(() => head)
    const remerge = vi.fn(async () => ({
      headSha: RECUT_HEAD,
      baseSha: TARGET_BASE_SHA,
      treeSha: RECUT_TREE,
      patchId: OTHER_PATCH_ID,
      unchanged: false,
    }))
    await expect(
      runInternals.refreshTrackedQueueRevisions(app, { recut: { recut: remerge } } as YrdCliServices, output.io),
    ).resolves.toMatchObject([
      {
        status: "applied",
        pr: "PR1",
        recorded: true,
        sourceRevision: 1,
        sourceHead: RECORDED_HEAD,
        currentRevision: 2,
      },
    ])
    expect(remerge).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, headSha: RECORDED_HEAD, proposedHeadSha: LIVE_HEAD }),
    )
    expect(app.bays.checksRequested("PR1")).toBe(true)
  })
})
