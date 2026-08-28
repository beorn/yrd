/**
 * @failure A branch approved only in git (refs/yrd/submit) cannot run at all,
 * loses a whole compose to one poisoned branch, or its identity is minted
 * without the commit-before-escape contract. This file is the compose surface
 * for the derived lane (@i/10-merge-queue/s6-door-design §5 item 4, replacing
 * the retired 2b intake sweep): ref-only approvals run as DERIVED members —
 * selected, admitted and integrated — and the sweep's loud edges keep their
 * exact policy in the derived lane.
 *
 * S7 (branch-is-change, @i/10 22991) deleted the change-record store, so the
 * "zero record writes" half of the original contract is now structural rather
 * than asserted: there is nothing left to write to. What these tests still
 * own is the identity contract — a derived member's ONLY durable home is the
 * run snapshot it starts, the number mint commits before the id escapes, and
 * a branch the compose will not select never burns a number.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, raiseFailure } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  duplicatePayloadSubmits,
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
const RESUBMIT_SHA = "8".repeat(40)
const OTHER_SHA = "c".repeat(40)
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

/** A queue with no review requirement and no required checks, so a standing
 * submit fact is runnable and one selectorless compose carries it to integration. */
async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
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
    withBays({ jobs: bayJobs }),
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

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

function runsForBranch(app: App, branch: string) {
  return Queues.values(app.state().queues).filter((run) => run.prs.some((member) => member.branch === branch))
}

describe("queue compose runs ref-only submits as DERIVED members", () => {
  it("an author's branch + submit ref alone is derived, admitted and integrated by one selectorless compose", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, id, log, queueMint })
      // The author pushed refs/heads/issue/ref-only and refs/yrd/submit/issue/ref-only,
      // nothing else. The receiver accepted the submit ref and projected the fact —
      // this dispatch IS post-receive's exact write.
      await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })
      expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/ref-only"])

      const runs = await app.queue.run({}, runtime)
      expect(runs).toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])

      // The run's snapshot is the identity's only durable home, the submit fact
      // still stands (no takeover act exists), and the served branch's refusal
      // row retired. The durable mint committed the number before it escaped.
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
      expect(app.queue.unrecordedSubmits()).toEqual([])
      expect(actionsLogged(events)).toContain("compose-derived-admitted")
      // The id-seam answers the recordless id from that retained snapshot.
      expect(app.queue.resolveMember("PR1")).toMatchObject({ source: "snapshot", id: "PR1" })

      // Idempotence: the authority is consumed by the retained merge run, so
      // the next compose derives nothing new and runs nothing.
      await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    }

    // Identity-neutral by construction: every event the compose wrote is an
    // already-registered one, so a fresh projection over the same journal
    // converges on the same state.
    await using replayed = await createApp({ journal, id, queueMint })
    const replayedRun = Queues.values(replayed.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR1"))
    expect(replayedRun?.prs[0]).toMatchObject({ id: "PR1", headSha: SHA })
  })

  it("an explicit run never mints an identity for a branch it will not select", async () => {
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ queueMint })
    // One branch the compose has already served, re-approved so it is runnable
    // again — an explicit run needs a member id, and a derived member only has
    // one once a run retained its snapshot.
    await app.bays.recordBranchSubmit({ branch: "issue/existing", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater()).toBe(1)
    await app.bays.recordBranchSubmit({ branch: "issue/existing", sha: RESUBMIT_SHA, base: "main" })

    // A second branch arrives approved-only-in-git while the explicit run is aimed elsewhere.
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: OTHER_SHA, base: "main" })

    await app.queue.run({ prs: ["PR1"] }, runtime)

    // The explicit run integrated its target; the ref-only branch was neither
    // minted nor selected — a number minted during a run that will not select
    // it would escape nowhere and burn. Its row stands for the next
    // selectorless compose.
    expect(runsForBranch(app, "issue/existing").at(-1)?.prs[0]).toMatchObject({ headSha: RESUBMIT_SHA })
    expect(runsForBranch(app, "issue/ref-only")).toEqual([])
    expect(queueMint.highWater()).toBe(1)
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/ref-only"])
    expect(app.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: OTHER_SHA })
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
    // Nothing derived, nothing consumed: no run, and the projected approval
    // still stands as the visible row it was.
    expect(runsForBranch(app, "issue/ref-only")).toEqual([])
    expect(app.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: SHA, base: "main" })
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/ref-only"])
  })

  it("two branches approved at the SAME sha are grouped into one collision row naming both", async () => {
    // Pre-S7 this was a loud REFUSAL, caught because one of the two branches
    // had a change record carrying the payload. With the store gone the fence
    // needs no record — the standing submit facts group by sha — but the
    // policy changed with it (@chief 2026-08-27): a rename or a re-push under
    // a new name is a legitimate way for one payload to stand under two
    // branches, so refusing would break real workflows. It reports instead,
    // and whichever merges second is caught by the already-landed guard on the
    // next pass. Leaving it unfenced AND unsaid is the silent-loss failure.
    await using app = await createApp({})
    await app.bays.recordBranchSubmit({ branch: "issue/first", sha: SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/duplicate", sha: SHA, base: "main" })
    // A third branch at its OWN sha is the negative control: without it, a
    // function that reported EVERY branch would pass the assertion below.
    await app.bays.recordBranchSubmit({ branch: "issue/distinct", sha: RESUBMIT_SHA, base: "main" })

    // ONE row per collision, not one per branch — a report that fires per
    // member turns a single ambiguity into recurring noise.
    expect(duplicatePayloadSubmits(app.state().bays)).toEqual([
      { sha: SHA, branches: ["issue/duplicate", "issue/first"] },
    ])
  })

  it("the collision is not a refusal: both branches still compose", async () => {
    await using app = await createApp({})
    await app.bays.recordBranchSubmit({ branch: "issue/first", sha: SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/duplicate", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    expect(runs.length, "a payload collision must never stop the compose").toBeGreaterThan(0)
  })

  it("the compose says the collision out loud, naming both branches", async () => {
    // The reporting half. `duplicatePayloadSubmits` computing the right answer
    // is worth nothing if no compose ever calls it — an unread function is the
    // same silence as no function, which is exactly the state S7 left this in.
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp({ log })
    await app.bays.recordBranchSubmit({ branch: "issue/first", sha: SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/duplicate", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)

    const collisions = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.props?.action === "compose-derived-duplicate-payload",
    )
    expect(collisions, "one warn per collision").toHaveLength(1)
    expect(collisions[0]?.level).toBe("warn")
    expect(collisions[0]?.props).toMatchObject({ sha: SHA })
    // Both colliding branches are named: a warn that says "some branches
    // collide" without saying WHICH is not actionable.
    expect(collisions[0]?.props?.branches).toEqual(["issue/duplicate", "issue/first"])
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
    // the rest.
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    const healthyRun = runsForBranch(app, "issue/healthy")[0]
    expect(healthyRun?.prs[0]).toMatchObject({ headSha: SHA })
    expect(runsForBranch(app, "issue/gone")).toEqual([])
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/gone"])
    const skip = events.find(
      (event) =>
        event.kind === "log" &&
        event.props?.action === "compose-derived-refused" &&
        event.props?.code === "derived-commit-vanished",
    )
    expect(skip, "the vanished commit must be skipped loudly, never silently").toBeDefined()
  })
})
