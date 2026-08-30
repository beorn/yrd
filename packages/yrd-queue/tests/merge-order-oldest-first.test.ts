/**
 * @failure The merge pass ranks ready candidates by the CURRENT revision's submit clock — a clock every mechanical re-merge resets — so the change that has been in the queue longest is composed LAST and starves behind newcomers admitted after it.
 * @level l2
 * @consumer @yrd/queue merge selection
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { candidateRefFor, withMerge, withQueue, withStep, type CandidatePreparer } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

/** The habitant runner's shape: `continueAdmissions` installed, so the drain
 * admits ONE change per turn and the Candidate sequence records the order
 * admission actually ran in. */
const HABITANT = { runner: "local", leaseMs: 60_000, continueAdmissions: () => true }

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

/** A clock the test moves by hand, so a change's submit clock and its
 * check-request clock can be skewed apart exactly the way a mechanical re-merge
 * skews them in production: the re-merge stamps a NEW `submittedAt` on the
 * carrier's revision while its content-keyed check request — and so its place in
 * the admission order — stay where they were. */
function settableClock(): Readonly<{ read: () => string; set: (second: number) => void }> {
  let second = 0
  return {
    read: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + second * 1000).toISOString(),
    set: (value: number) => {
      second = value
    },
  }
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const preparer: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/** check (admission) + merge (integrates), batch off so every change is its own
 * partition and the compose order is directly readable as the Run order. */
function checkMergePlugin() {
  const check = withStep(
    "check",
    (): JobResult<{ checked: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    () => ({ status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }),
    { revision: "merge-v1" },
  )
  return withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: preparer,
  })
}

async function createApp(clock: () => string) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = checkMergePlugin()
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock,
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

/** Submit WITHOUT requesting checks: the two clocks are what this test skews,
 * so it stamps them one at a time. */
async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

/** The order admission actually ran in, read off the journal's own Candidate
 * sequence — `C<n>` is minted from the running maximum when admission builds the
 * Candidate, so ascending `n` IS ascending admission order. */
function admissionOrder(app: Awaited<ReturnType<typeof createApp>>): string[] {
  return Object.values(app.state().queues.candidates)
    .toSorted((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)))
    .flatMap((candidate) => candidate.revs.map((rev) => rev.pr))
}

/** The order the merge pass composed them in, one entry per minted merge Run. */
function composeOrder(runs: readonly { prs: readonly { id: string }[] }[]): string[] {
  return runs.flatMap((run) => run.prs.map((pr) => pr.id))
}

describe("merge order — the pass composes the OLDEST ready candidate first", () => {
  it("composes in admission order, not in current-revision submit order", async () => {
    const clock = settableClock()
    await using app = await createApp(clock.read)

    // Submitted in the REVERSE of the order they will be admitted in.
    // `admittedFirst` stands for the veteran whose re-merge restamped its
    // revision's `submittedAt`, while the two newcomers still carry the earlier
    // one they were first submitted with.
    clock.set(1)
    const admittedThird = await submitBranch(app, "issue/newcomer-two")
    clock.set(2)
    const admittedSecond = await submitBranch(app, "issue/newcomer-one")
    clock.set(3)
    const admittedFirst = await submitBranch(app, "issue/veteran")

    // Checks requested veteran-first, which is the order admission walks
    // (`admissionQueue` ranks by check-request time).
    clock.set(4)
    await app.bays.requestChecks({ pr: admittedFirst.id, baseSha: BASE })
    clock.set(5)
    await app.bays.requestChecks({ pr: admittedSecond.id, baseSha: BASE })
    clock.set(6)
    await app.bays.requestChecks({ pr: admittedThird.id, baseSha: BASE })

    clock.set(7)
    const drained = await app.queue.run({}, HABITANT)

    // The given: admission really did run veteran-first.
    expect(admissionOrder(app)).toEqual([admittedFirst.id, admittedSecond.id, admittedThird.id])
    // The claim: the merge pass follows it. Ranking by `submittedAt` produced
    // the exact inversion — [admittedThird, admittedSecond, admittedFirst] —
    // that carried PR2710 to a seventh revision without ever failing a check.
    expect(composeOrder(drained)).toEqual([admittedFirst.id, admittedSecond.id, admittedThird.id])
  })

  it("keeps a change with no admitted Candidate behind every change that has one", async () => {
    const clock = settableClock()
    await using app = await createApp(clock.read)

    clock.set(1)
    const unadmitted = await submitBranch(app, "issue/no-checks-requested")
    clock.set(2)
    const admitted = await submitBranch(app, "issue/admitted")

    // Only one of them ever asks for checks, so only one has been through
    // admission when the merge pass ranks them. The other has no Candidate to be
    // ordered by, and must not take the line from the change that does however
    // much earlier it was submitted — which is what ranking by `submittedAt`
    // gave it. (The compose loop then prepares the straggler's own Candidate, so
    // it holds the SECOND ordinal, not none.)
    clock.set(3)
    await app.bays.requestChecks({ pr: admitted.id, baseSha: BASE })

    clock.set(4)
    const drained = await app.queue.run({}, HABITANT)

    expect(admissionOrder(app)[0], "admission ran the checked change first").toBe(admitted.id)
    expect(composeOrder(drained)).toEqual([admitted.id, unadmitted.id])
  })
})
