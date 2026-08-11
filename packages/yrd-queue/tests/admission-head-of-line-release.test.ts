/**
 * @failure A refused PR at the head of the admission queue ends the whole admission drain, so every ready PR behind it waits out the refusal loop instead of composing.
 * @level l2
 * @consumer @yrd/queue admission drain
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withQueue, withStep, type CandidatePreparer } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

/** The resident runner always installs `continueAdmissions` (it is how a drain
 * signal interrupts the loop), and that is exactly the shape that admits ONE PR
 * per drain turn. A one-shot `queue run` leaves it undefined and dispatches the
 * whole queue in one turn, so only this shape can wedge head-of-line. */
const RESIDENT = { runner: "local", leaseMs: 60_000, continueAdmissions: () => true }

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
 * that drains one PR per turn, so the refused candidate has to be refused there. */
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

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  // `yrd pr submit` requests the checks; without them the PR is never admission
  // work and the drain this test exercises is skipped entirely.
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr
}

/** Refuse exactly the named PRs the way an authored-gitlink carrier is refused:
 * a per-PR refusal that prints its own deterministic remedy. */
function refuseAuthoredGitlink(
  refused: ReadonlySet<string>,
  code: "authored-gitlink" | "recut-gitlink-conflict" = "authored-gitlink",
): CandidatePreparer {
  return (input) => {
    const poisoned = input.prs.find((pr) => refused.has(pr.id))
    if (poisoned !== undefined) {
      throw createFailure({
        kind: "refusal",
        code,
        message:
          `yrd: PR '${poisoned.id}' changes generated-only gitlinks [km]; authored root branches use ` +
          `'yrd pr submit <branch>', then 'yrd pr recut ${poisoned.id} --preflight --queue --apply'`,
      })
    }
    const { prs: _prs, ...candidate } = input
    return { ...candidate, sha: MERGED, ref: `refs/yrd/candidates/${input.id}`, mergeability: "mergeable" }
  }
}

function skipsFor(events: readonly LogEvent[], pr: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> =>
      event.kind === "log" && event.props?.action === "compose-candidate-skip" && event.props?.pr === pr,
  )
}

describe("admission head-of-line release — a refused PR never blocks the ready PRs behind it", () => {
  it("admits and integrates the trailing ready PRs in the SAME cycle that refuses the head", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const refused = new Set<string>()
    await using app = await createApp(refuseAuthoredGitlink(refused, "recut-gitlink-conflict"), log)
    const head = await submitBranch(app, "issue/authored-gitlink-carrier")
    refused.add(head.id)
    const trailing = [
      await submitBranch(app, "issue/ready-one"),
      await submitBranch(app, "issue/ready-two"),
      await submitBranch(app, "issue/ready-three"),
    ]

    await app.queue.run({}, RESIDENT)

    const state = app.state()
    expect(state.bays.prs[head.id]?.integration).toBeUndefined()
    expect(state.queues.admissionRefusals[head.id]?.settlement).toMatchObject({ disposition: "needs-person" })
    for (const pr of trailing) {
      expect(state.bays.prs[pr.id]?.integration, `expected PR '${pr.id}' to integrate behind the refused head`).toEqual(
        expect.objectContaining({ commit: MERGED }),
      )
    }
    expect(skipsFor(events, head.id).length).toBeGreaterThan(0)
    log.end()
  })

  it("ledgers the refused head exactly once per cycle while the trailing PRs drain", async () => {
    const refused = new Set<string>()
    await using app = await createApp(refuseAuthoredGitlink(refused))
    const head = await submitBranch(app, "issue/authored-gitlink-carrier")
    refused.add(head.id)
    await submitBranch(app, "issue/ready-one")

    await app.queue.run({}, RESIDENT)

    // One cycle, one streak increment — releasing the head must not turn a single
    // refusal into a per-turn retry loop against the same PR.
    expect(app.state().queues.admissionRefusals[head.id]).toMatchObject({
      pr: head.id,
      code: "authored-gitlink",
      count: 1,
    })
  })

  it("still drains every trailing PR when EVERY earlier PR in the queue is refused", async () => {
    const refused = new Set<string>()
    await using app = await createApp(refuseAuthoredGitlink(refused))
    const poisoned = [
      await submitBranch(app, "issue/poison-one"),
      await submitBranch(app, "issue/poison-two"),
      await submitBranch(app, "issue/poison-three"),
    ]
    for (const pr of poisoned) refused.add(pr.id)
    const trailing = await submitBranch(app, "issue/ready-last")

    await app.queue.run({}, RESIDENT)

    const state = app.state()
    for (const pr of poisoned) expect(state.bays.prs[pr.id]?.integration).toBeUndefined()
    expect(state.bays.prs[trailing.id]?.integration).toEqual(expect.objectContaining({ commit: MERGED }))
  })

  it("keeps the drain terminating when EVERY queued PR is refused", async () => {
    const refused = new Set<string>()
    await using app = await createApp(refuseAuthoredGitlink(refused))
    for (const branch of ["issue/poison-one", "issue/poison-two"]) {
      refused.add((await submitBranch(app, branch)).id)
    }

    await expect(app.queue.run({}, RESIDENT)).resolves.toEqual([])
  })
})
