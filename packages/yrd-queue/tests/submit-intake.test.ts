/**
 * @failure A branch approved only in git (refs/yrd/submit, no PR record) stays
 * refused forever, or the queue mints its record silently wrong: reopening a
 * terminal identity, double-minting under a broken mint, or swallowing an
 * intake failure so the approval goes dark (branch-is-change phase 2b,
 * @i/10-merge-queue/23005).
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
  return events.flatMap((event) => (event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : []))
}

describe("queue compose intakes ref-only submits (branch-is-change phase 2b)", () => {
  it("an author's branch + submit ref alone — no record — is minted and run to integration by one selectorless compose", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = createMemoryJournal()
    const id = ids()
    {
      await using app = await createApp({ journal, id, log })
      // The author pushed refs/heads/issue/ref-only and refs/yrd/submit/issue/ref-only,
      // nothing else. The receiver accepted the submit ref and projected the fact —
      // this dispatch IS post-receive's exact write. No `pr create`, no record.
      await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })
      expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/ref-only"])
      expect(app.state().bays.prs).toEqual({})

      const runs = await app.queue.run({}, runtime)
      expect(runs).toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])

      // The record is a queue-minted artifact: the durable mint's PR1, the ref's
      // exact sha, pushed + submitted + checks-requested in one intake, and
      // integrated by the same compose that used to refuse it.
      const pr = app.state().bays.prs.PR1
      if (pr === undefined) throw new Error("expected the compose to mint PR1")
      expect(pr.branch).toBe("issue/ref-only")
      expect(changeHead(pr)).toBe(SHA)
      expect(pr.revs).toHaveLength(1)
      expect(pr.revs[0]?.submitter).toBe("yrd/queue")
      expect(pr.revs[0]?.submittedAt).toBeDefined()
      // The intake's own request first; the compose may re-point a later one at
      // the cycle base, which is its ordinary revalidation, not a new revision.
      expect(pr.checkRequests[0]).toMatchObject({ revision: 1, headSha: SHA })
      expect(changeDeliveryState(pr)).toBe("integrated")

      // The intaken record took over the approval: the projected fact retired
      // (`superseded`), no refusal row survives anywhere, and the act was loud.
      expect(app.state().bays.submits).toEqual({})
      expect(app.queue.unrecordedSubmits()).toEqual([])
      expect(actionsLogged(events)).toContain("compose-submit-intaken")

      // Idempotence: the next compose finds nothing to intake and nothing to run.
      await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    }

    // Identity-neutral by construction: every event the sweep wrote is an
    // already-registered one, so a fresh projection over the same journal
    // converges on the same state.
    await using replayed = await createApp({ journal, id })
    expect(replayed.state().bays.submits).toEqual({})
    const replayedPr = replayed.state().bays.prs.PR1
    if (replayedPr === undefined) throw new Error("expected the replayed projection to hold PR1")
    expect(changeDeliveryState(replayedPr)).toBe("integrated")
  })

  it("an explicit run mints the record too — the encounter is the projection, not the selector", async () => {
    await using app = await createApp({})
    const existing = await submitBranch(app, "issue/existing")
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })

    await app.queue.run({ prs: [existing.id] }, runtime)

    const minted = Object.values(app.state().bays.prs).find((pr) => pr.branch === "issue/ref-only")
    if (minted === undefined) throw new Error("expected the explicit compose to mint the ref-only record")
    // Minted and submitted, but not selected: the explicit run targeted PR1 only.
    expect(changeDeliveryState(minted)).toBe("submitted")
    expect(app.state().bays.submits).toEqual({})
    expect(changeDeliveryState(app.state().bays.prs[existing.id] ?? existing)).toBe("integrated")
  })

  it("a mint failure propagates loudly and mints nothing — the refusal row stands for the next compose", async () => {
    const broken: PrNumberMint = Object.freeze({
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: PR-number mint store at '/broken/pr-mint.json' is unwritable: EIO")
      },
    })
    await using app = await createApp({ mint: broken })
    await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: SHA, base: "main" })

    await expect(app.queue.run({}, runtime)).rejects.toThrow("PR-number mint store")
    // Nothing minted, nothing consumed: the record set is untouched and the
    // projected approval still stands as the refusal row it was before 2b.
    expect(app.state().bays.prs).toEqual({})
    expect(app.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: SHA, base: "main" })
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/ref-only"])
  })

  it("a submit whose exact payload another record already carries fails the compose loudly and mints nothing", async () => {
    await using app = await createApp({})
    await app.bays.submit({ branch: "issue/first", headSha: SHA, base: "main", baseSha: BASE })
    await app.bays.recordBranchSubmit({ branch: "issue/duplicate", sha: SHA, base: "main" })

    // Deliberately a propagated failure, not a skip: one payload claimed by two
    // branch identities needs a human, and `bay.intake` refuses it as the
    // untyped duplicate-payload error, which the sweep never swallows.
    await expect(app.queue.run({}, runtime)).rejects.toThrow("payload already recorded as change 'PR1'")
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/duplicate"])
  })

  it("a branch with a record in ANY state — terminal included — is never re-intaken: reopen stays the author's act", async () => {
    await using app = await createApp({})
    const pr = await submitBranch(app, "issue/terminal")
    await app.bays.closePr({ pr: pr.id, reason: "superseded" })
    // The submit ref still stands for the same branch and the receiver
    // (re-)projects it. The record — though withdrawn — wins in any state.
    await app.bays.recordBranchSubmit({ branch: "issue/terminal", sha: SHA, base: "main" })
    expect(app.queue.unrecordedSubmits()).toEqual([])

    const before = Object.keys(app.state().bays.prs)
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    expect(Object.keys(app.state().bays.prs)).toEqual(before)
    const terminal = app.state().bays.prs[pr.id]
    if (terminal === undefined) throw new Error("expected the withdrawn record to survive")
    expect(changeDeliveryState(terminal)).toBe("withdrawn")
    // Nothing superseded the fact either: no record took the approval over.
    expect(app.state().bays.submits["issue/terminal"]).toMatchObject({ sha: SHA, base: "main" })
  })

  it("the collision rule under the sweep's race: bay.intake mints a fresh identity for a terminal record and no-ops an identical live one", async () => {
    await using app = await createApp({})
    const pr = await submitBranch(app, "issue/raced")
    await app.bays.closePr({ pr: pr.id, reason: "superseded" })

    // The dispatch the sweep would make, arriving after the branch gained a
    // TERMINAL record: a fresh identity is minted — never a reopen (D2 reopening
    // belongs to the author's `pr submit`; integrated identities stay frozen per Q1).
    await app.bays.intake({ branch: "issue/raced", headSha: SHA, base: "main", submit: true, submitter: "yrd/queue" })
    const fresh = Object.values(app.state().bays.prs).find(
      (item) => item.branch === "issue/raced" && item.id !== pr.id,
    )
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

  it("a submit whose commit is gone fails candidate preparation loudly without wedging the drain — the healthy submit still lands", async () => {
    const GONE = "e".repeat(40)
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp({
      log,
      // What the real git-backed preparer does when the approved commit no
      // longer resolves: a typed refusal at Candidate preparation.
      prepareCandidate: (input) => {
        if (input.revs.some((rev) => rev.head === GONE)) {
          raiseFailure("refusal", "git-commit-missing", `yrd: no Git commit '${GONE}'`)
        }
        return mergeableCandidate(input)
      },
    })
    await app.bays.recordBranchSubmit({ branch: "issue/gone", sha: GONE, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/healthy", sha: SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)

    // Both approvals were minted; the vanished one was skipped LOUD at its own
    // candidate and stays submitted for the audit to age, while the healthy one
    // integrated in the same compose — one poisoned member never zeroes the rest.
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    const byBranch = Object.fromEntries(Object.values(app.state().bays.prs).map((item) => [item.branch, item]))
    const gone = byBranch["issue/gone"]
    const healthy = byBranch["issue/healthy"]
    if (gone === undefined || healthy === undefined) throw new Error("expected both approvals to be minted")
    expect(changeDeliveryState(gone)).toBe("submitted")
    expect(changeDeliveryState(healthy)).toBe("integrated")
    expect(app.state().bays.submits).toEqual({})
    const skip = events.find(
      (event) =>
        event.kind === "log" &&
        event.props?.action === "compose-candidate-skip" &&
        event.props?.code === "git-commit-missing",
    )
    expect(skip, "the vanished commit must be skipped loudly, never silently").toBeDefined()
  })
})
