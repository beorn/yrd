/**
 * @failure A superseded revision of a change lives in TWO receiver-store rows —
 * `refs/yrd/submit/<branch>` (the submit fact) and `refs/for/<base>/<branch>`
 * (the landing request). Retiring only the submit fact does not remove the
 * revision: the `refs/for` row re-projects the fact at the row's own sha, and
 * the next compose pass derives a fresh change from it. Measured 2026-09-01
 * 20:15-20:34 PDT: the follower pass composed PR3186 from
 * refs/for/main/@i/19-hab-tsx/wave2-slice6-continuation-gate ten minutes after
 * its submit fact was retired (journal cursor 126175), and a Change-Id audit
 * then found 13 more superseded refs/for-only rows that only a hand audit
 * could see.
 *
 * This file pins the compose half of the cure: a refs/for row whose revision
 * was JOURNALED as retired (`queue/revision/retired`, written by `yrd pr
 * retire`) derives nothing, however many times the row re-projects the fact —
 * and the same row WITHOUT a retirement fact still derives, because that is a
 * genuinely git-only submission and today's behaviour for it is correct.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  REVISION_RETIRED_CODE,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
/** The refs/for row's tip — the sha every re-projection of the row carries. */
const ROW_SHA = "7".repeat(40)
const BRANCH = "@i/19-hab-tsx/wave2-slice6-continuation-gate"
const CHANGE_ID = `I${"c".repeat(40)}`
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

function ids(): () => string {
  let value = 0
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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
  }> = {},
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
    readSubmitEnrichment: () => ({ changeId: CHANGE_ID }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: ids(),
      clock: () => "2026-09-01T20:15:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

/** The retirement `yrd pr retire` journals for revision 1 of the change on
 * this branch: the submit fact was already gone (retired by hand), only the
 * refs/for row survived, and that row is what this retires. */
const retirement = {
  branch: BRANCH,
  base: "main",
  changeId: CHANGE_ID,
  revision: 1,
  forRef: `refs/for/main/${BRANCH}`,
  forSha: ROW_SHA,
  by: "@cto",
  reason: "superseded by revision 2",
} as const

describe("compose treats a refs/for row whose revision was journaled as retired as retired", () => {
  it("the PR3186 reproduction: submit fact deleted, refs/for present, retirement journaled — compose derives nothing", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ log, queueMint })

    // The row's submission, as the receiver projected it when the refs/for
    // push was drained: refs/yrd/submit/<branch> at the row's sha.
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: ROW_SHA, base: "main" })
    // The submit fact is then deleted by hand in prs.git (`update-ref -d`),
    // which journals nothing — so the projection still stands. `yrd pr retire`
    // journals the retirement of exactly this revision.
    await app.queue.retireRevision(retirement)
    expect(app.state().bays.submits[BRANCH], "the retirement drops the standing projection in the same act").toBe(
      undefined,
    )
    expect(app.state().queues.retiredSubmits[BRANCH]).toMatchObject({
      branch: BRANCH,
      sha: ROW_SHA,
      code: REVISION_RETIRED_CODE,
      pr: CHANGE_ID,
    })
    expect(app.state().queues.retiredSubmits[BRANCH]?.reason).toContain("revision 1 of change")
    expect(app.state().queues.retiredSubmits[BRANCH]?.reason).toContain("@cto")

    // Ten minutes later the refs/for row re-projects the fact at its own sha
    // — the drain of a pending inbox result, a re-run of the dual-write, any
    // path that reads the surviving row. Then the follower pass composes.
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: ROW_SHA, base: "main" })
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "compose must derive nothing for a retired revision").toBe(0)
    expect(actionsLogged(events)).not.toContain("compose-derived-admitted")
    expect(actionsLogged(events)).toContain("compose-dead-fact-retired")
    const retiredRow = events.find(
      (event) => event.kind === "log" && event.props?.action === "compose-dead-fact-retired",
    )
    expect(retiredRow?.kind === "log" ? retiredRow.message : "").toContain("a revision an operator retired")
  })

  it("control: the same refs/for row WITHOUT a retirement fact still derives (a genuinely git-only submission)", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ log, queueMint })

    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: ROW_SHA, base: "main" })
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "an unretired git-only submission derives exactly one change").toBe(1)
    expect(actionsLogged(events)).toContain("compose-derived-admitted")
    expect(actionsLogged(events)).not.toContain("compose-dead-fact-retired")
  })

  it("the retirement survives a fresh projection over the same journal", async () => {
    const journal = createMemoryJournal()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, queueMint })
      await app.bays.recordBranchSubmit({ branch: BRANCH, sha: ROW_SHA, base: "main" })
      await app.queue.retireRevision(retirement)
    }
    await using replayed = await createApp({ journal, queueMint })
    expect(replayed.state().queues.retiredSubmits[BRANCH]).toMatchObject({ sha: ROW_SHA, code: REVISION_RETIRED_CODE })
    await replayed.bays.recordBranchSubmit({ branch: BRANCH, sha: ROW_SHA, base: "main" })
    await replayed.queue.run({}, runtime)
    expect(queueMint.highWater(), "a restart must not re-derive a retired revision").toBe(0)
  })

  it("a re-push at a NEW sha is newer consent: the retirement stops matching and the branch derives again", async () => {
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ queueMint })
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: ROW_SHA, base: "main" })
    await app.queue.retireRevision(retirement)

    const rebased = "9".repeat(40)
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: rebased, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater(), "new content is not blocked by the old retirement").toBe(1)
  })

  it("refuses to retire a revision whose projected fact moved since the rows were read", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: "9".repeat(40), base: "main" })
    await expect(app.queue.retireRevision(retirement)).rejects.toThrow(/re-pushed since this retirement was read/u)
    expect(app.state().bays.submits[BRANCH]?.sha, "the moved fact is untouched").toBe("9".repeat(40))
    expect(app.state().queues.retiredSubmits[BRANCH]).toBeUndefined()
  })
})
