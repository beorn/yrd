/**
 * @failure A required check RUNS, FAILS, and every operator surface still
 * reports the branch as healthy: `pr merge` tells the author to wait for a pass
 * that can never come, `pr checks` calls a check that exited 7
 * "not-requested", `queue audit` answers clean, and `pr list`/`pr view`/`pr
 * status` say "pending" — while `queues.admissionRefusals` holds the streak the
 * whole time.
 * @level l2
 * @consumer @yrd/cli pr merge · pr checks · pr list · pr view · pr status · queue audit
 *
 * S7 (branch-is-change, @i/10 22991) caused this, which is why it is a
 * REGRESSION and not an inherited gap: before the cutover an admission refusal
 * produced a run member, and the run-shaped surfaces rendered it. Now the
 * refusal IS the reason no member exists, and `derivedDeliveryStatus`
 * (src/run.ts) reads the ledger as `admissionRefusals[member.id]` — so the one
 * lookup that could report the failure is gated on the thing the failure
 * prevented, and every surface built on it falls through to "pending".
 *
 * The rows are ordered worst-first, because they are not equally bad:
 *
 *   `pr merge`    issues a WRONG INSTRUCTION — "wait" — to the one person who
 *                 could act on the failure, at the moment they try to land.
 *   `pr checks`   asserts something FALSE: `not-requested` for a check that ran.
 *   `queue audit` gives a FALSE ALL-CLEAR from the tool whose job is wedges.
 *   the readers    are merely silent.
 *
 * Every assertion below names the refusal CODE, because "something is wrong" is
 * not what an operator needs at 2am — the code is what routes them.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, volatilePrNumberMint, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type ContestGit } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { runYrd as runYrdRaw, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BRANCH = "topic/refused"
/** The exact code the queue ledgers for a check that ran and exited non-zero. */
const REFUSAL_CODE = "check-failed"

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "refusal-visibility-workspace-v1",
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

/** An app whose one required check FAILS, so a compose refuses the branch at
 * admission — the exact live shape, not a seeded ledger row. */
async function createCliApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({
      status: "completed",
      conclusion: "failure",
      error: { code: REFUSAL_CODE, message: "check command exited 7" },
      output: { exitCode: 7 },
    }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  // Both knobs are load-bearing since S7: a derived member's identity mints at
  // ADMISSION and it carries no baseSha of its own, so without them admission
  // refuses for the WRONG reason and this fixture would prove nothing.
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    prNumberMint: volatilePrNumberMint(),
    resolveBaseSha: () => BASE_SHA,
  })
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-08-28T12:00:00.000Z",
      id: ids(),
      log: createLogger("yrd", [{ level: "silent" }]),
    },
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
    columns: 120,
    runner: "refusal-visibility-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-08-28T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function runYrd(app: CliApp, argv: readonly string[], io: YrdCliIO) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app) })
}

/**
 * Submit the branch, run one pass, and prove the pass refused it at ADMISSION:
 * no run was minted, and the ledger carries the streak at exactly this head.
 *
 * Asserted here rather than in each test so a fixture that stopped producing
 * the refusal fails as a fixture, never as a surface that "reports correctly".
 */
/** @param passes how many compose cycles refuse the branch. One is the case an
 * author sees and the one every assertion here uses; the parameter exists so a
 * streak-length test can be written without rebuilding the fixture. */
async function refusedBranch(passes = 1): Promise<CliApp> {
  const app = await createCliApp()
  await app.bays.recordBranchSubmit({ branch: BRANCH, sha: HEAD_SHA, base: "main" })
  for (let pass = 0; pass < passes; pass += 1) {
    const runs = await app.queue.run({}, { runner: "refusal-visibility-test", leaseMs: 60_000 })
    expect(runs, "the check must refuse at admission, minting no run").toEqual([])
  }

  const ledger = Object.values(app.state().queues.admissionRefusals)
  expect(ledger, "the queue must hold exactly one refusal streak for the branch").toMatchObject([
    { branch: BRANCH, headSha: HEAD_SHA, code: REFUSAL_CODE, kind: "failure", sameCodeCount: passes },
  ])
  return app
}

describe("a refused branch is visible on the surfaces an operator reaches for", () => {
  it("pr merge names the refusal instead of teaching the author to wait", async () => {
    // WORST FIRST: every other row withholds information; this one issues a
    // wrong instruction. `next: "yrd watch"` tells the one person who could fix
    // the branch to sit and wait for a pass that cannot come.
    await using app = await refusedBranch()
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "merge", BRANCH, "--json"), output.io)).toBe(1)
    const refusal = JSON.parse(output.stderr()) as Readonly<{
      status?: string
      next?: string
      refusal?: Readonly<{ code?: string }>
    }>
    expect(refusal.status, "a refused delivery is not pending").not.toBe("pending")
    expect(refusal.next, "waiting is the one instruction that cannot help").not.toBe("yrd watch")
    expect(JSON.stringify(refusal), "the envelope must name the refusal code").toContain(REFUSAL_CODE)
  })

  it("pr checks reports the failed check instead of calling it not-requested", async () => {
    // `not-requested` for a check that RAN and exited 7 is affirmatively false,
    // which is worse than silence: it answers the operator's question wrongly.
    await using app = await refusedBranch()
    const output = outputIO()

    const exit = await runYrd(app, yrd("pr", "checks", BRANCH, "--json"), output.io)
    const body = `${output.stdout()}${output.stderr()}`
    expect(body, "a check that ran and failed is not 'not-requested'").not.toContain("not-requested")
    expect(body).toContain(REFUSAL_CODE)
    expect(exit, "a failed check must not answer 0").not.toBe(0)
  })

  it("the wedge-finder stays quiet while the reader surfaces speak, for the same state", async () => {
    // `queue audit` answering clean here is CORRECT and was never the bug —
    // I had it in the defect list and I was wrong. One failed check is an
    // author's business, not a stuck queue; a repeated identical refusal
    // becomes `admission-refusal-loop` only at ADMISSION_REFUSAL_LOOP_THRESHOLD,
    // deliberately, because an audit that reports every first failure is an
    // audit nobody reads.
    //
    // What was broken is the DIVERGENCE: with audit correctly silent, the
    // reader surfaces were silent too, so the operator had nowhere left to
    // learn the check had failed. This asserts both halves against ONE app,
    // which is the only way to state the contract — silence in the wedge
    // finder is only acceptable while the readers are loud.
    await using app = await refusedBranch()

    const audit = outputIO()
    expect(await runYrd(app, yrd("queue", "audit", "--json"), audit.io), audit.stderr()).toBe(0)
    const parsed = JSON.parse(audit.stdout()) as Readonly<{ findings?: readonly Readonly<{ code?: string }>[] }>
    expect(parsed.findings ?? [], "one failing check is not yet a queue wedge").toEqual([])

    const view = outputIO()
    expect(await runYrd(app, yrd("pr", "view", BRANCH, "--json"), view.io), view.stderr()).toBe(0)
    expect(
      JSON.parse(view.stdout()),
      "the reader must carry what the wedge-finder deliberately withholds",
    ).toMatchObject({ derived: { state: "refused", refusal: { code: REFUSAL_CODE } } })
  })

  it("pr list, pr view and pr status all report the branch as refused", async () => {
    // One lookup feeds all three, so they light up together or not at all.
    await using app = await refusedBranch()

    const list = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), list.io), list.stderr()).toBe(0)
    expect(JSON.parse(list.stdout())).toMatchObject({
      live: [{ branch: BRANCH, state: "refused", refusal: { code: REFUSAL_CODE } }],
    })

    const view = outputIO()
    expect(await runYrd(app, yrd("pr", "view", BRANCH, "--json"), view.io), view.stderr()).toBe(0)
    expect(JSON.parse(view.stdout())).toMatchObject({
      derived: { branch: BRANCH, state: "refused", refusal: { code: REFUSAL_CODE } },
    })

    const status = outputIO({ currentBranch: () => BRANCH })
    expect(await runYrd(app, yrd("pr", "status", "--json"), status.io), status.stderr()).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      derived: { branch: BRANCH, state: "refused", refusal: { code: REFUSAL_CODE } },
    })
  })

  it("the human read of a refused branch names the code and the evidence on disk", async () => {
    // The bytes ARE captured — the admission job's evidence carries both
    // artifacts — and nothing prints where. An operator holding the evidence
    // with no way to be told it exists is the difference between the ledger
    // being a record and being a rumour.
    await using app = await refusedBranch()
    const view = outputIO()

    expect(await runYrd(app, yrd("pr", "view", BRANCH), view.io), view.stderr()).toBe(0)
    expect(view.stdout()).toContain("refused")
    expect(view.stdout()).toContain(REFUSAL_CODE)
  })

  it("keeps a re-pushed branch out of the refused state its previous head earned", async () => {
    // The correctness constraint on the fix: the member-keyed lookup compared
    // `refusal.headSha === submit.sha`, and the branch-keyed row carries
    // `headSha` too. Drop that comparison and a fixed-and-repushed branch reads
    // "refused" forever — a worse lie than the silence being fixed.
    await using app = await refusedBranch()
    const nextHead = "2".repeat(40)
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: nextHead, base: "main" })

    const list = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), list.io), list.stderr()).toBe(0)
    const live = (JSON.parse(list.stdout()) as { live: readonly Readonly<{ sha: string; state: string }>[] }).live
    expect(live).toMatchObject([{ sha: nextHead }])
    expect(live[0]?.state, "the refusal belongs to the head that earned it").not.toBe("refused")
  })
})
