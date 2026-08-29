/**
 * @failure A branch approved only in git (refs/yrd/submit, no PR record)
 * cannot run at all post-door, runs with a silently minted record (the store
 * the S6 door froze), loses a whole compose to one poisoned branch, or its
 * identity is minted without the commit-before-escape contract. This file is
 * the door's compose surface (@i/10-merge-queue/s6-door-design §5 item 4,
 * replacing the retired 2b intake sweep): ref-only approvals run as DERIVED
 * members — selected, admitted and integrated with zero record writes — and
 * the sweep's loud edges keep their exact policy in the derived lane.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import {
  changeDeliveryState,
  changeHead,
  createBayJobDefs,
  withBays,
  volatilePrNumberMint,
  type BayWorkspace,
  type PrNumberMint,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, raiseFailure } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  Queues,
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
const SHA = "7".repeat(40)
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

/** A queue with no review requirement and no required checks, so a submitted
 * record is runnable and one selectorless compose can carry it to integration. */
async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    mint?: PrNumberMint
    /** The queue-side durable mint arming derived admission; defaults to a
     * fresh volatile store. Pass the SAME object across app rebuilds to model
     * the durable pr-mint.json. */
    queueMint?: PrNumberMint
    readSubmitEnrichment?: (input: Readonly<{ branch: string; sha: string }>) => { changeId?: string }
    prepareCandidate?: CandidatePreparer
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
    prepareCandidate: options.prepareCandidate ?? mergeableCandidate,
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
    // The real host reads the tip commit's trailers; a sha-derived Change-Id
    // keeps the fixture deterministic and unique per tree.
    readSubmitEnrichment: options.readSubmitEnrichment ?? (({ sha }) => ({ changeId: `I${sha}` })),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: options.mint ?? volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

/** An authored record via `bay.submit`, for the collision fixtures. */
async function submitBranch(app: App, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr
}

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

describe("queue compose runs ref-only submits as DERIVED members (S6 door)", () => {
  it("an author's branch + submit ref alone — no record — is derived, admitted and integrated by one selectorless compose, with zero record writes", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, id, log, queueMint })
      // The author pushed refs/heads/issue/ref-only and refs/yrd/submit/issue/ref-only,
      // nothing else. The receiver accepted the submit ref and projected the fact —
      // this dispatch IS post-receive's exact write. No `pr create`, no record, ever.
      await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })
      expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/ref-only"])
      expect(app.state().bays.prs).toEqual({})

      const runs = await app.queue.run({}, runtime)
      expect(runs).toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])

      // The DERIVED regime end to end: no record minted, the run's snapshot is
      // the identity's only durable home, the submit fact still stands (no
      // takeover act exists post-door), and the served branch's refusal row
      // retired. The durable mint committed the number before it escaped.
      expect(app.state().bays.prs).toEqual({})
      const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR1"))
      expect(record?.prs[0]).toMatchObject({
        id: "PR1",
        branch: "issue/ref-only",
        headSha: SHA,
        revision: 1,
        changeId: `I${SHA}`,
      })
      expect(queueMint.highWater()).toBe(1)
      expect(app.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: SHA, base: "main" })
      expect(await app.queue.unrecordedSubmits()).toEqual([])
      expect(actionsLogged(events)).toContain("compose-derived-admitted")

      // Idempotence: the authority is consumed by the retained merge run, so
      // the next compose derives nothing new and runs nothing.
      await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    }

    // Identity-neutral by construction: every event the door wrote is an
    // already-registered one, so a fresh projection over the same journal
    // converges on the same recordless state.
    await using replayed = await createApp({ journal, id, queueMint })
    expect(replayed.state().bays.prs).toEqual({})
    const replayedRun = Queues.values(replayed.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR1"))
    expect(replayedRun?.prs[0]).toMatchObject({ id: "PR1", headSha: SHA })
  })

  it("an explicit run does NOT derive ref-only branches: a derived identity's only durable home is the run it starts", async () => {
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ queueMint })
    const existing = await submitBranch(app, "issue/existing")
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })

    await app.queue.run({ prs: [existing.id] }, runtime)

    // The explicit run integrated its target; the ref-only branch was neither
    // minted nor selected — a number minted during a run that will not select
    // it would escape nowhere and burn. Its row stands for the next
    // selectorless compose.
    expect(changeDeliveryState(app.state().bays.prs[existing.id] ?? existing)).toBe("integrated")
    expect(Object.values(app.state().bays.prs).some((pr) => pr.branch === "issue/ref-only")).toBe(false)
    expect(queueMint.highWater()).toBe(0)
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/ref-only"])
    expect(app.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: SHA })
  })

  it("a mint failure propagates loudly and derives nothing — the refusal row stands for the next compose", async () => {
    const broken: PrNumberMint = Object.freeze({
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: PR-number mint store at '/broken/pr-mint.json' is unwritable: EIO")
      },
    })
    await using app = await createApp({ queueMint: broken })
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })

    await expect(app.queue.run({}, runtime)).rejects.toThrow("PR-number mint store")
    // Nothing derived, nothing consumed: no record, no run, and the projected
    // approval still stands as the visible row it was.
    expect(app.state().bays.prs).toEqual({})
    expect(app.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: SHA, base: "main" })
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/ref-only"])
  })

  it("a submit whose exact payload an open record already carries fails the compose loudly and derives nothing", async () => {
    await using app = await createApp({})
    await app.bays.submit({ branch: "issue/first", headSha: SHA, base: "main", baseSha: BASE })
    await app.bays.recordBranchSubmit({ branch: "issue/duplicate", sha: SHA, base: "main" })

    // Deliberately a propagated failure, not a skip: one payload claimed by two
    // branch identities needs a human. The derived materialization refuses it
    // as the untyped duplicate-payload error, which the compose never swallows.
    await expect(app.queue.run({}, runtime)).rejects.toThrow("payload already recorded as change 'PR1'")
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/duplicate"])
  })

  it("a terminal-record branch re-submitted in git at a NEW head COMPOSES as its derived re-entry (Q1)", async () => {
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ queueMint })
    const pr = await submitBranch(app, "issue/terminal")
    await app.bays.closePr({ pr: pr.id, reason: "superseded" })
    // The author re-pushes the branch and its submit ref at a NEW sha. The
    // record is HISTORY, not ownership: post-purge (the legacy mint is
    // retired) the derived lane is the only re-entry for a terminal branch's
    // next head, so this composes — the PR2139 double-merge stays fenced by
    // the live-ownership exclusion, the landed-content exclusion, and the
    // fact-retirement at every merge, none of which this state trips.
    await app.bays.recordBranchSubmit({ branch: "issue/terminal", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The withdrawn record is untouched history; the new head ran under a
    // FRESH derived identity beside it.
    const terminal = app.state().bays.prs[pr.id]
    if (terminal === undefined) throw new Error("expected the withdrawn record to survive")
    expect(changeDeliveryState(terminal)).toBe("withdrawn")
    expect(Object.keys(app.state().bays.prs)).toEqual([pr.id])
    expect(queueMint.highWater()).toBeGreaterThan(0)
    const reentry = Queues.values(app.state().queues).find((run) =>
      run.prs.some((member) => member.branch === "issue/terminal" && member.headSha === SHA),
    )
    expect(reentry, "the new head must run as a derived member").toBeDefined()
    expect(reentry?.prs[0]?.id).not.toBe(pr.id)
  })

  it("the collision rule under the sweep's race: bay.intake mints a fresh identity for a terminal record and no-ops an identical live one", async () => {
    await using app = await createApp({})
    const pr = await submitBranch(app, "issue/raced")
    await app.bays.closePr({ pr: pr.id, reason: "superseded" })

    // The dispatch the sweep would make, arriving after the branch gained a
    // TERMINAL record: a fresh identity is minted — never a reopen (D2 reopening
    // belongs to the author's `pr submit`; integrated identities stay frozen per Q1).
    await app.bays.intake({ branch: "issue/raced", headSha: SHA, base: "main", submit: true, submitter: "yrd/queue" })
    const fresh = Object.values(app.state().bays.prs).find((item) => item.branch === "issue/raced" && item.id !== pr.id)
    if (fresh === undefined) throw new Error("expected a fresh identity beside the withdrawn record")
    expect(fresh.revs[0]?.n).toBe(1)
    const withdrawn = app.state().bays.prs[pr.id]
    if (withdrawn === undefined) throw new Error("expected the withdrawn record to survive")
    expect(changeDeliveryState(withdrawn)).toBe("withdrawn")

    // The same dispatch arriving after the branch gained an identical LIVE
    // record: a zero-event no-op, which the sweep reports and never supersedes.
    const replay = await app.bays.intake({
      branch: "issue/raced",
      headSha: SHA,
      base: "main",
      submit: true,
      submitter: "yrd/queue",
    })
    expect(replay.events).toEqual([])
  })

  it("a submit whose commit is gone is refused at its OWN derivation — the healthy submit still lands in the same compose", async () => {
    const GONE = "e".repeat(40)
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp({
      log,
      // What the real host's enrichment reader does when the approved commit
      // no longer resolves: the typed vanished-commit refusal (R2), which the
      // compose attributes to the ONE branch.
      readSubmitEnrichment: ({ sha }) => {
        if (sha === GONE) {
          raiseFailure(
            "refusal",
            "derived-commit-vanished",
            `yrd: submitted commit ${GONE.slice(0, 12)} is not in this repository`,
          )
        }
        return { changeId: `I${sha}` }
      },
    })
    await app.bays.recordBranchSubmit({ branch: "issue/gone", sha: GONE, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/healthy", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    // The vanished one was skipped LOUD at its own derivation and its row
    // stays visible for the audit to age; the healthy one integrated as a
    // derived member in the same compose — one poisoned branch never zeroes
    // the rest, and no record exists anywhere.
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().bays.prs).toEqual({})
    const healthyRun = Queues.values(app.state().queues).find((run) =>
      run.prs.some((member) => member.branch === "issue/healthy"),
    )
    expect(healthyRun?.prs[0]).toMatchObject({ headSha: SHA })
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["issue/gone"])
    const skip = events.find(
      (event) =>
        event.kind === "log" &&
        event.props?.action === "compose-derived-refused" &&
        event.props?.code === "derived-commit-vanished",
    )
    expect(skip, "the vanished commit must be skipped loudly, never silently").toBeDefined()
  })
})
