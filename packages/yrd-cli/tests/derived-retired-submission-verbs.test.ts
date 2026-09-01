/**
 * @failure Both disposal verbs print a cure that cannot resolve, for a derived
 * change whose submit fact is gone.
 *
 * Live specimen PR2131 (issue/sop-sherif-sort-recut, 2026-09-01), in order:
 *   - `yrd pr view PR2131` refused `pr-view-branch-absent` and printed
 *     `yrd pr withdraw PR2131 --burn-payload --reason …`
 *   - `yrd pr withdraw PR2131 --burn-payload` refused `pr-derived-lane`
 *     ("no record to withdraw") and printed
 *     `git push bay :refs/yrd/submit/issue/sop-sherif-sort-recut`
 *   - the receiver store held NO such ref, so the second cure was a no-op that
 *     reports "nothing to retire" — two verbs, two cures, one loop.
 *
 * Both cures were downstream of ONE lie: the change read `open`/`submitted` off
 * its retained run snapshot long after the receiver swept its ref. `pr view`
 * picked `disposalRemedy` because `remedyAdmissibleIn("withdraw", "submitted")`
 * is true; `pr withdraw` fell past its terminal guard into the derived-lane arm
 * because `isLiveChange` was true. Neither printer was wrong about its own
 * state — they were both told the wrong state.
 *
 * So this file drives the REAL verbs against the real receiver path and pins
 * what they print now, with no new verb added: the projection is honest
 * (`derived-retired-submission.test.ts` pins that), and each printer's existing
 * guard does the rest. The remedy table's own executability is already pinned
 * by `remedy-executable-in-emitting-state.test.ts` for every terminal state;
 * what is pinned HERE is the join — that the ghost reaches those guards as
 * `withdrawn`.
 * @level l2
 * @consumer @yrd/cli every operator trying to dispose of a stuck queue head
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint, changeDeliveryState, currentChangeRev } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import {
  candidateRefFor,
  Queues,
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
import { unobservableBranchRemedy } from "../src/remedy-admissibility.ts"

const HEAD_SHA = "1".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const RECEIVER_SHA = "7".repeat(40)
/** The live specimen's branch. */
const BRANCH = "issue/sop-sherif-sort-recut"
const RUNTIME = { runner: "retired-submission-test", leaseMs: 60_000 }

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "retired-submission-workspace-v1",
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

/**
 * The specimen's own plan: `check` is the only declared default, so the run
 * ADMITS the member and never merges it. That is what PR2131 was — one check
 * request from 2026-08-27, `runnable false`, no landing — and it is the state
 * the retired arm has to judge. A merging default would land the member and
 * the fixture would pass for the wrong reason.
 */
async function createCliApp() {
  const journal = createMemoryJournal()
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
    defaultSteps: ["check"],
    resolveBaseSha: () => BASE_SHA,
    prepareCandidate: (input) => {
      const { prs: _prs, ...candidate } = input
      return { ...candidate, sha: MERGED_SHA, ref: candidateRefFor(MERGED_SHA), mergeability: "mergeable" }
    },
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
  return createYrd(contests(queue(base)), {
    inject: {
      journal: journal as never,
      clock: () => "2026-08-27T14:19:42.000Z",
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

function runYrd(app: CliApp, argv: readonly string[], io: YrdCliIO, services: YrdCliServices = {}) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
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
    columns: 120,
    runner: RUNTIME.runner,
    leaseMs: RUNTIME.leaseMs,
    now: () => Date.parse("2026-09-01T12:00:00.000Z"),
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
 * The ghost, built the way the world built it: a `refs/for/` push writes the
 * submit fact, the queue's next pass mints an identity and admits the member
 * into a run — then the branch is deleted and the receiver sweeps the fact,
 * days before anyone reads the change.
 */
async function admitThenSweep(app: CliApp): Promise<string> {
  await app.bays.recordBranchSubmit({ branch: BRANCH, sha: RECEIVER_SHA, base: "main" })
  await app.queue.run({}, RUNTIME)
  const admitted = Queues.values(app.state().queues)
    .flatMap((record) => record.prs)
    .find((member) => member.branch === BRANCH)
  if (admitted === undefined) throw new Error(`fixture: the queue admitted no member for '${BRANCH}'`)
  await app.bays.recordBranchUnsubmit({ branch: BRANCH, reason: "deleted" })
  if (app.state().bays.submits[BRANCH] !== undefined) throw new Error("fixture: the submit fact was not swept")
  return admitted.id
}

describe("the verbs stop printing cures that cannot resolve", () => {
  it("pr withdraw refuses TERMINAL, naming no submit ref that is not there", async () => {
    const app = await createCliApp()
    const id = await admitThenSweep(app)

    const withdraw = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", id, "--burn-payload"), withdraw.io)).toBe(1)

    // The whole point: the printed refusal must not send an operator to a ref
    // the receiver already swept. Asserted on the LITERAL prefix the old cure
    // printed, so a reworded version of the same wrong instruction still fails.
    expect(withdraw.stderr()).not.toContain("refs/yrd/submit/")
    expect(withdraw.stderr()).not.toContain("no record to withdraw")
    expect(withdraw.stderr()).toContain("withdrawn")
    expect(withdraw.stderr()).toContain("terminal change cannot be withdrawn")
  })

  it("pr view's absent-branch remedy names no disposal verb", async () => {
    const app = await createCliApp()
    const id = await admitThenSweep(app)
    const state = app.state()
    const pr = resolveQueueChange(state.bays, state.queues, id)
    if (pr === undefined) throw new Error("fixture: the change left the population")

    // The JOIN, not a second copy of the printer's own test: the printer is
    // already pinned executable for every terminal state
    // (remedy-executable-in-emitting-state.test.ts), so all that is needed here
    // is that the ghost reaches it as `withdrawn` — the state that selects
    // `settledAbsenceRemedy` over the `--burn-payload` disposal cure.
    expect(changeDeliveryState(pr)).toBe("withdrawn")
    const remedy = unobservableBranchRemedy("absent", pr, changeDeliveryState(pr), currentChangeRev(pr), "")
    expect(remedy.verb, "a terminal change has nothing left to dispose of").toBeUndefined()
    expect(remedy.text).not.toContain("--burn-payload")
  })

  it("pr list carries it as a closed, withdrawn row instead of a queued one", async () => {
    const app = await createCliApp()
    const id = await admitThenSweep(app)

    const listed = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), listed.io), listed.stderr()).toBe(0)
    const rows = (JSON.parse(listed.stdout()) as { prs: readonly { id: string; status?: string }[] }).prs
    const row = rows.find((candidate) => candidate.id === id)

    expect(row, "it stays LISTED — erasing it would hide work someone has to judge").toBeDefined()
    expect(row?.status).toBe("withdrawn")
  })

  it("stays addressable by id and by branch, exactly as before", async () => {
    // The property `change-population.ts` exists to protect: the ghost is
    // retired, not erased. A fix that dropped it from the population would put
    // back the "no change 'PR2131' — searched N change(s)" sentence that reads
    // as a typo.
    const app = await createCliApp()
    const id = await admitThenSweep(app)
    const state = app.state()

    expect(resolveQueueChange(state.bays, state.queues, id)?.id).toBe(id)
    expect(resolveQueueChange(state.bays, state.queues, BRANCH)?.id).toBe(id)
  })
})
