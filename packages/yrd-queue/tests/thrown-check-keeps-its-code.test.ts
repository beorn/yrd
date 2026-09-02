/**
 * @failure A required check that THREW its typed failure lost the type on the
 * way to the terminal record. `ensureScratchRoot` raises
 * `scratch-root-unavailable`, kind `infrastructure`, before any check child is
 * spawned (@i/10-yrd/24031 row 5) — the job layer filed every throw as
 * `runner-error`, which sits in no environment-owned bucket, so
 * `admissionFailureKind` called a host fault the AUTHOR's and the record lane
 * spent that author's check authority on it. Measured on yrd `ab994e84`
 * (@i/10-yrd/24038).
 *
 * Both lanes are pinned here because the same dropped type reads two different
 * ways: the DERIVED lane recognised the throw by its code and stopped the pass
 * on it — right answer, unusable reason, since the row named `runner-error`
 * instead of the environment fault a human has to go fix — while the RECORD
 * lane, which never sees that arm, billed it to the submission.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { changeAdmission, createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
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
const BRANCH = "issue/thrown-scratch-root"
const SHA = "7".repeat(40)
/** The code `ensureScratchRoot` raises, registered and bucketed `infra-retry`. */
const SCRATCH_ROOT_UNAVAILABLE = "scratch-root-unavailable"
const SCRATCH_MESSAGE =
  "yrd: check: the repository's declared scratch root '/nope' (.yrd.yml scratch:) is not writable: EACCES. " +
  "Every step child gets it as TMPDIR, so no child was spawned"
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

/**
 * The host, as the step sees it: the declared scratch root is unwritable until
 * an operator repairs it, and the step RAISES rather than returning a verdict —
 * which is the whole point. `ensureScratchRoot` runs before a child exists, so
 * there is no exit code to read and nothing has judged the content.
 */
function unwritableScratch() {
  let broken = true
  let runs = 0
  return {
    repair: () => {
      broken = false
    },
    runs: () => runs,
    check: (_input: StepExecution): JobResult<CheckResult> => {
      runs += 1
      if (broken) {
        throw createFailure({ kind: "infrastructure", code: SCRATCH_ROOT_UNAVAILABLE, message: SCRATCH_MESSAGE })
      }
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
  }
}

async function createApp(check: (input: StepExecution) => JobResult<CheckResult>) {
  const queue = withQueue({
    steps: [
      withStep("check", check, { revision: "check-v1", output: CheckResultSchema }),
      withMerge(
        async (): Promise<JobResult<IntegrationProof>> => ({
          status: "completed",
          conclusion: "success",
          output: { commit: MERGED, baseSha: BASE },
        }),
        { revision: "merge-v1" },
      ),
    ] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock: () => "2026-01-01T00:00:00.000Z" },
  })
}

describe("a check step that throws a typed failure keeps that type through the terminal record", () => {
  it("RECORD lane: refuses kind infrastructure under the thrown code, spends no check authority, and keeps the submission", async () => {
    const scratch = unwritableScratch()
    await using app = await createApp(scratch.check)
    await app.bays.submit({ branch: BRANCH, headSha: SHA, base: "main", baseSha: BASE })
    const pr = Object.values(app.state().bays.prs).find((change) => change.branch === BRANCH)
    if (pr === undefined) throw new Error("expected a change record for the record lane")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })

    await app.queue.run({}, runtime)
    expect(scratch.runs(), "the step ran and raised before any child existed").toBe(1)

    const refused = changeAdmission(app.bays.pr(pr.id)!)
    // The typed code survives, so the bucket lookup can reach the right answer
    // at all: `runner-error` is in no environment-owned set and the same
    // refusal read `kind: "failure"` — the author's — before 24038.
    expect(refused).toMatchObject({
      status: "refused",
      kind: "infrastructure",
      step: "check",
      receipt: { code: SCRATCH_ROOT_UNAVAILABLE, message: SCRATCH_MESSAGE },
    })
    // NO CHECK AUTHORITY SPENT. An environment fault is not a verdict, so the
    // request the author granted is still there to spend; recording it by
    // omission would be read as one legacy authority instead.
    expect(refused).toMatchObject({ requestCount: 0 })
    expect(app.state().queues.retiredSubmits[BRANCH], "an environment fault consumes no submission").toBeUndefined()
    // The refusal a reader reaches names the cure, and the cure asks the author
    // for no new content — the ruling is "yrd broken => fix yrd".
    const ledger = app.state().queues.admissionRefusals[pr.id]
    expect(ledger).toMatchObject({ code: SCRATCH_ROOT_UNAVAILABLE, kind: "infrastructure" })
    expect(ledger?.reason).toContain("spent no check authority")
    expect(ledger?.reason).toContain(SCRATCH_MESSAGE)
    expect(ledger?.reason).not.toContain("push a new revision")
  })

  it("RECORD lane: the authority the outage did not spend still buys the retry it was granted for", async () => {
    // The teeth on "spends no check authority". Two requests stood against this
    // head; the fault refused on the first attempt. Billing them — the old
    // `requestCount: verdictRequestCount(...)`, which records the FULL tally —
    // left `hasFreshRevisionCheckAuthority` reading two spent against two
    // granted, so the second request bought nothing and the change sat refused
    // on a host fault until someone re-pushed. Spending nothing, the attempt
    // count alone bounds it, and the granted request still runs the check.
    const scratch = unwritableScratch()
    await using app = await createApp(scratch.check)
    await app.bays.submit({ branch: BRANCH, headSha: SHA, base: "main", baseSha: BASE })
    const pr = Object.values(app.state().bays.prs).find((change) => change.branch === BRANCH)
    if (pr === undefined) throw new Error("expected a change record for the record lane")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })

    await app.queue.run({}, runtime)
    expect(scratch.runs()).toBe(1)
    expect(changeAdmission(app.bays.pr(pr.id)!)).toMatchObject({ kind: "infrastructure", requestCount: 0 })

    // The operator repairs the host. The author does nothing.
    scratch.repair()
    await app.queue.run({}, runtime)

    expect(scratch.runs(), "the granted-but-unspent request runs the check again").toBe(2)
    expect(changeAdmission(app.bays.pr(pr.id)!)).toMatchObject({ status: "passed", baseSha: BASE })
  })

  it("DERIVED lane: still stops the pass, and the row names the thrown code instead of runner-error", async () => {
    // Behaviour unchanged and deliberately so — a step that broke breaks the
    // same way for every member behind it, so it needs a human rather than a
    // retry loop. What changes is that the human is told WHICH fault: the arm
    // reads the structural thrown marker now, and reports the code the thrower
    // chose.
    const scratch = unwritableScratch()
    await using app = await createApp(scratch.check)
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: SHA, base: "main" })

    const raised = await app.queue.run({}, runtime).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(raised, "a thrown step still stops the pass on the derived lane").toBeInstanceOf(Error)
    expect((raised as Error).message).toContain(SCRATCH_ROOT_UNAVAILABLE)
    expect((raised as Error).message).toContain("PR1")
    expect((raised as Error).message, "the row names the fault, not the fact that something threw").not.toContain(
      "runner-error",
    )
    expect(scratch.runs()).toBe(1)
  })
})
