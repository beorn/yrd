/**
 * @failure A change delivered through the `refs/for/<base>/<change>` receiver
 * is invisible to every `change`/`pr` verb: `yrd pr view PR2706` answers
 * `no change 'PR2706' — searched 2155 change(s)` while the queue is running
 * PR2706's checks and has already merged PR2651 and PR2702–PR2705, and
 * `pr list` tops out at the last change the RECORD lane ever minted (PR2599).
 * Post-S6 a receiver push writes a `branch/submitted` fact and mints no record
 * on purpose, so `BaysState.prs` stopped being the population while every one
 * of those verbs kept reading it — and the not-found denominator, the one
 * number built to make an empty answer falsifiable, reported the record
 * store's size as if it were the whole search (live specimen 2026-08-30,
 * @i/10-yrd). Or the count widens but the two verbs derive their population
 * separately and drift apart again.
 * @level l2
 * @consumer @yrd/cli every operator running a `change` verb, and every script
 *   that scrapes `pr list --json`
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint, recordChangeCount } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import {
  candidateRefFor,
  Queues,
  queueChangeCount,
  queueChanges,
  resolveQueueChange,
  withMerge,
  withQueue,
  withStep,
  type ChangeShape,
  type SourceRewrite,
  type StepExecution,
} from "@yrd/queue"
import { runYrd as runYrdRaw, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { createLogger } from "loggily"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const HEAD_SHA = "1".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const RECEIVER_SHA = "7".repeat(40)
const RECEIVER_BRANCH = "issue/ag-advance-needs-person"
const RUNTIME = { runner: "receiver-visibility-test", leaseMs: 60_000 }

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "receiver-visibility-workspace-v1",
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

type JournalFrame = Readonly<{ command?: Readonly<{ op?: string }>; events?: readonly Readonly<{ name?: string }>[] }>

async function createCliApp() {
  const journal = createMemoryJournal<JournalFrame>()
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
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE_SHA,
    prepareCandidate: (input) => {
      const { prs: _prs, ...candidate } = input
      return { ...candidate, sha: MERGED_SHA, ref: candidateRefFor(MERGED_SHA), mergeability: "mergeable" }
    },
    // The derived lane's two admission-time inputs: the mint that gives a
    // recordless submission its id, and the tip-commit read that supplies the
    // Change-Id. Without them a `refs/for/` push composes no member at all,
    // which would make this fixture pass for the wrong reason.
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }: { sha: string }) => ({ changeId: `I${sha}` }),
  })
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
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
  const app = await createYrd(contests(queue(base)), {
    inject: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the journal's frame type is the app's, not ours
      journal: journal as never,
      clock: () => "2026-08-30T12:00:00.000Z",
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
  return { app, journal }
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>["app"]

function runYrd(app: CliApp, argv: readonly string[], io: YrdCliIO, services: YrdCliServices = {}) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

/** `pr view` observes the live branch before it renders. A resolver that
 * answers for every ref keeps the fixture off git without weakening the
 * surface under test — the observation is not what this file is about. */
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
    columns: 120,
    runner: "receiver-visibility-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-08-30T12:01:00.000Z"),
    pruneGit: () => ({
      resolveCommit: () => RECEIVER_SHA,
      isAncestor: () => false,
      mergeTree: () => undefined,
      treeOf: () => RECEIVER_SHA,
    }),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/**
 * The receiver path, exactly as `host.ts` drives it: a `refs/for/` push writes
 * the submit fact through `branch.recordSubmit` and dispatches NO intake (the
 * S6 door's conditional — a recordless branch belongs to the derived lane).
 * The queue's next pass mints the identity and starts the run.
 */
async function deliverThroughReceiver(app: CliApp, branch = RECEIVER_BRANCH, sha = RECEIVER_SHA): Promise<string> {
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
  await app.queue.run({}, RUNTIME)
  const admitted = Queues.values(app.state().queues)
    .flatMap((record) => record.prs)
    .find((member) => member.branch === branch)
  if (admitted === undefined) throw new Error(`fixture: the queue admitted no member for '${branch}'`)
  return admitted.id
}

async function frames(journal: Awaited<ReturnType<typeof createCliApp>>["journal"]): Promise<JournalFrame[]> {
  const collected: JournalFrame[] = []
  for await (const page of journal.read(0)) collected.push(...page.values)
  return collected
}

describe("a change delivered through the receiver is visible to the change verbs", () => {
  it("pr view finds it, by id and by branch, while the queue is running it", async () => {
    const { app } = await createCliApp()
    const id = await deliverThroughReceiver(app)

    const byId = outputIO()
    expect(await runYrd(app, yrd("pr", "view", id, "--json"), byId.io), byId.stderr()).toBe(0)
    expect(JSON.parse(byId.stdout())).toMatchObject({
      command: "pr.view",
      pr: { id, branch: RECEIVER_BRANCH },
    })

    // The branch is what the operator pushed; the id is something the queue
    // minted afterwards, so a selector that names the branch must work too.
    const byBranch = outputIO()
    expect(await runYrd(app, yrd("pr", "view", RECEIVER_BRANCH, "--json"), byBranch.io), byBranch.stderr()).toBe(0)
    expect(JSON.parse(byBranch.stdout())).toMatchObject({ pr: { id } })
  })

  it("pr list carries it beside the record lane instead of topping out at the last minted record", async () => {
    const { app } = await createCliApp()
    // One record-lane change, so the assertion proves a UNION rather than a
    // swap: widening the population must not cost the store its rows.
    await app.bays.submit({ branch: "topic/recorded", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const recorded = recordChangeCount(app.state().bays)
    const id = await deliverThroughReceiver(app)

    const listed = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), listed.io), listed.stderr()).toBe(0)
    const rows = (JSON.parse(listed.stdout()) as { prs: readonly { id: string; branch: string }[] }).prs
    expect(rows.map((row) => row.branch)).toContain(RECEIVER_BRANCH)
    expect(rows.map((row) => row.id)).toContain(id)
    expect(rows.length, "the record lane keeps every row it had").toBeGreaterThan(recorded)
  })

  it("the not-found denominator counts both lanes, so an absence stays falsifiable", async () => {
    const { app } = await createCliApp()
    await app.bays.submit({ branch: "topic/recorded", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await deliverThroughReceiver(app)
    const state = app.state()

    // The parity assertion: what the sentence claims to have searched IS the
    // population the lookup walks. Read separately from the CLI so a shared
    // mistake in one expression cannot satisfy both sides.
    const population = queueChanges(state.bays, state.queues)
    expect(queueChangeCount(state.bays, state.queues)).toBe(population.length)
    expect(population.length, "one record plus one derived member").toBe(recordChangeCount(state.bays) + 1)

    const missing = outputIO()
    expect(await runYrd(app, yrd("pr", "view", "nope", "--json"), missing.io)).toBe(1)
    expect(missing.stderr()).toContain("no change 'nope'")
    expect(missing.stderr()).toContain(`searched ${String(population.length)} change(s)`)
  })
})

describe("both delivery paths write one creation fact", () => {
  it("the receiver's push and `pr submit` of a recordless branch write the same journal event and mint no record", async () => {
    const receiver = await createCliApp()
    await receiver.app.bays.recordBranchSubmit({ branch: RECEIVER_BRANCH, sha: RECEIVER_SHA, base: "main" })

    // `yrd pr submit <branch>`'s own entry point, not the low-level record
    // mint: this is the path an author takes, and post-S6 it routes a
    // recordless branch to the derived lane exactly as the receiver does.
    const submitted = await createCliApp()
    await submitted.app.bays.submitSelection(RECEIVER_BRANCH, {
      resolveRevision: () => Promise.resolve(RECEIVER_SHA),
      base: "main",
      run: RUNTIME,
    })

    const creationEvents = async (fixture: Awaited<ReturnType<typeof createCliApp>>): Promise<string[]> =>
      (await frames(fixture.journal)).flatMap((frame) =>
        (frame.events ?? []).flatMap((event) => (event.name === undefined ? [] : [event.name])),
      )

    // The SAME fact, not two shapes of it: the record-minting ops the pre-door
    // era wrote for a submission (`pr/opened`, `pr/submitted`, …) appear on
    // neither side.
    expect(await creationEvents(receiver)).toEqual(["branch/submitted"])
    expect(await creationEvents(submitted)).toEqual(["branch/submitted"])
    expect(recordChangeCount(receiver.app.state().bays)).toBe(0)
    expect(recordChangeCount(submitted.app.state().bays)).toBe(0)
    expect(receiver.app.state().bays.submits[RECEIVER_BRANCH]).toMatchObject({ sha: RECEIVER_SHA, base: "main" })
    expect(submitted.app.state().bays.submits[RECEIVER_BRANCH]).toMatchObject({ sha: RECEIVER_SHA, base: "main" })
  })

  it("a change already minted by the receiver stays addressable after its submit fact is gone", async () => {
    const { app } = await createCliApp()
    const id = await deliverThroughReceiver(app)
    // Merging sweeps the standing ref, which is what makes the ~55 changes the
    // receiver had already minted the interesting case: nothing about them
    // lives in `bays.submits` any more, and a fix that only read submit facts
    // would go blind exactly where the bug was reported.
    await app.bays.recordBranchUnsubmit({ branch: RECEIVER_BRANCH, reason: "deleted" })
    const state = app.state()
    expect(state.bays.submits[RECEIVER_BRANCH]).toBeUndefined()

    const resolved = resolveQueueChange(state.bays, state.queues, id)
    expect(resolved).toMatchObject({ id, branch: RECEIVER_BRANCH })
    expect(resolved?.submittedAt, "the run that admitted it dates it once the fact is swept").toBeDefined()

    const view = outputIO()
    expect(await runYrd(app, yrd("pr", "view", id, "--json"), view.io), view.stderr()).toBe(0)
  })
})
