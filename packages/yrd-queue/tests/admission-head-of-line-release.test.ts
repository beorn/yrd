/**
 * @failure A refused member at the head of the admission queue ends the whole admission drain, so every ready member behind it waits out the refusal loop instead of composing.
 * @level l2
 * @consumer @yrd/queue admission drain
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { candidateRefFor, withMerge, withQueue, withStep, type CandidatePreparer, type Run } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

/** The habitant runner always installs `continueAdmissions` (it is how a drain
 * signal interrupts the loop), and that is exactly the shape that admits ONE
 * member per drain turn. A one-shot `queue run` leaves it undefined and
 * dispatches the whole queue in one turn, so only this shape can wedge
 * head-of-line. */
const HABITANT = { runner: "local", leaseMs: 60_000, continueAdmissions: () => true }

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
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

/** check (admission phase) + merge (integrates). The admission phase is the one
 * that drains one change per turn, so the refused candidate has to be refused there. */
function checkMergePlugin(prepareCandidate: CandidatePreparer) {
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
    prepareCandidate,
    // S7: the selectorless compose derives every member from its standing
    // submit fact, so the mint and the enrichment reader are what make a
    // branch admissible at all — there is no record lane left to seed one.
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
}

async function createApp(prepareCandidate: CandidatePreparer, log?: ReturnType<typeof createLogger>) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = checkMergePlugin(prepareCandidate)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

/** The whole delivery, post-S7: a branch and its standing submit fact. Each
 * branch gets its own head — an identical payload composes as a duplicate. */
async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string): Promise<string> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
  return branch
}

/** Refuse exactly the named branches the way an authored-gitlink carrier is
 * refused: a per-member refusal that prints its own deterministic remedy.
 * Keyed on the branch because that — not a store id — is what identifies a
 * derived member before any run has retained a snapshot for it. */
function refuseAuthoredGitlink(
  refused: ReadonlySet<string>,
  code: "authored-gitlink" | "recut-gitlink-conflict" = "authored-gitlink",
): CandidatePreparer {
  return (input) => {
    const poisoned = input.prs.find((pr) => refused.has(pr.branch))
    if (poisoned !== undefined) {
      throw createFailure({
        kind: "refusal",
        code,
        message:
          `yrd: change '${poisoned.id}' changes generated-only gitlinks [km]; authored root branches use ` +
          "tracked changes re-merge implicitly",
      })
    }
    const { prs: _prs, ...candidate } = input
    return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
  }
}

/** The preparation-path skip warn names the member by its minted id, so the
 * branch has to be resolved through the ledger row that carries both. */
function skipsForMember(events: readonly LogEvent[], pr: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> =>
      event.kind === "log" && event.props?.action === "compose-candidate-skip" && event.props?.pr === pr,
  )
}

/** Which branches a drain actually integrated. The run's own snapshot is the
 * post-S7 home of that fact: a derived member has no record to stamp. */
function integratedBranches(runs: readonly Run[]): readonly string[] {
  return runs
    .filter((run) => run.integration !== undefined)
    .flatMap((run) => run.prs.map((pr) => pr.branch))
    .toSorted()
}

function refusalFor(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  return Object.values(app.state().queues.admissionRefusals).find((row) => row.branch === branch)
}

describe("admission head-of-line release — a refused member never blocks the ready members behind it", () => {
  it("admits and integrates the trailing ready members in the SAME cycle that refuses the head", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const refused = new Set<string>(["issue/authored-gitlink-carrier"])
    await using app = await createApp(refuseAuthoredGitlink(refused, "recut-gitlink-conflict"), log)
    const head = await submitBranch(app, "issue/authored-gitlink-carrier")
    const trailing = [
      await submitBranch(app, "issue/ready-one"),
      await submitBranch(app, "issue/ready-two"),
      await submitBranch(app, "issue/ready-three"),
    ]

    const runs = await app.queue.run({}, HABITANT)

    // The head never integrated, and its refusal is on the durable ledger —
    // the only trace a recordless head-of-line wedge has.
    expect(integratedBranches(runs)).toEqual(trailing.toSorted())
    const wedged = refusalFor(app, head)
    expect(wedged).toMatchObject({ branch: head, code: "recut-gitlink-conflict", count: 1 })
    expect(skipsForMember(events, wedged?.pr ?? "").length).toBeGreaterThan(0)
    log.end()
  })

  it("admits one member per turn in GLOBAL order, holding a member on another base behind the head", async () => {
    // Fences `drainAdmissions`' `queued.slice(0, 1)`, which is the only place
    // global admission FIFO lives — and which nothing tested until now.
    //
    // TWO BASES, and that is the whole point of the fixture. The skip test's
    // `runningQueue(..., pr.base)` disjunct already serializes members sharing a
    // base, so a same-base version of this test passes whether ordering works or
    // not. Only a cross-base pair can tell the two apart: `admissionQueue` is
    // ordered and NOT base-filtered, so taking its head is what stops a
    // release-base member riding along in the head's turn.
    //
    // WHY THIS TEST EXISTS. A fourth disjunct in that same skip test,
    // `admissionLineHolder`, used to claim this job and had silently stopped
    // being able to fire (@refname-reach, by construction — post-S7 it was
    // called without the derived batch that IS `admissionQueue`'s population).
    // The first version of this test was written to catch that, and passed
    // identically against the broken code, because the property was never its to
    // enforce. That guard is deleted; this asserts the mechanism that really
    // carries the behaviour, at the site that carries it.
    const turns: string[][] = [[]]
    const prepare: CandidatePreparer = (input) => {
      for (const pr of input.prs) turns.at(-1)?.push(pr.branch)
      const { prs: _prs, ...candidate } = input
      return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
    }
    await using app = await createApp(prepare)
    const first = "issue/line-main"
    await app.bays.recordBranchSubmit({ branch: first, sha: "1".repeat(40), base: "main" })
    const second = "issue/line-release"
    await app.bays.recordBranchSubmit({ branch: second, sha: "2".repeat(40), base: "release/2.0" })

    await app.queue.run({}, { ...HABITANT, continueAdmissions: () => (turns.push([]), true) })

    // One member per turn, head first, across bases — and BOTH turns asserted,
    // because "the head went first" alone would also hold if the second member
    // never ran at all.
    expect(turns.filter((turn) => turn.length > 0)).toEqual([[first], [second]])
  })

  it("ledgers the refused head exactly once per cycle while the trailing members drain", async () => {
    const refused = new Set<string>(["issue/authored-gitlink-carrier"])
    await using app = await createApp(refuseAuthoredGitlink(refused))
    const head = await submitBranch(app, "issue/authored-gitlink-carrier")
    await submitBranch(app, "issue/ready-one")

    await app.queue.run({}, HABITANT)

    // One cycle, one streak increment — releasing the head must not turn a single
    // refusal into a per-turn retry loop against the same member.
    expect(refusalFor(app, head)).toMatchObject({
      branch: head,
      code: "authored-gitlink",
      count: 1,
    })
  })

  it("still drains every trailing member when EVERY earlier member in the queue is refused", async () => {
    const poisoned = ["issue/poison-one", "issue/poison-two", "issue/poison-three"]
    await using app = await createApp(refuseAuthoredGitlink(new Set(poisoned)))
    for (const branch of poisoned) await submitBranch(app, branch)
    const trailing = await submitBranch(app, "issue/ready-last")

    const runs = await app.queue.run({}, HABITANT)

    expect(integratedBranches(runs)).toEqual([trailing])
    for (const branch of poisoned) expect(refusalFor(app, branch)).toMatchObject({ code: "authored-gitlink" })
  })

  it("keeps the drain terminating when EVERY queued member is refused", async () => {
    const poisoned = ["issue/poison-one", "issue/poison-two"]
    await using app = await createApp(refuseAuthoredGitlink(new Set(poisoned)))
    for (const branch of poisoned) await submitBranch(app, branch)

    await expect(app.queue.run({}, HABITANT)).resolves.toEqual([])
  })
})
