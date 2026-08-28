/**
 * @failure A composition refusal that reaches the runner is misreported as a
 * plain `required-check-failed`, hiding that the author must re-author the
 * candidate — or the reverse, an ordinary red check billing the author and
 * consuming their submit authority. The distinction is the whole file: an
 * author-owned refusal code bills the member `refusal` (needs-author) and
 * emits the durable `pr/needs-author` fact; an ordinary check failure bills
 * `failure` and emits none.
 *
 * S7 (branch-is-change, @i/10 22991): the change-record store is gone, so
 * needs-author no longer lands as a stored delivery state on a Change. Its
 * durable homes are the journaled `pr/needs-author` fact (re-sourced from the
 * run's own snapshot) and the admission-refusal ledger row's `code` + `kind`.
 * Those are what these tests read; the classification they fence is unchanged.
 *
 * THE ORDINARY-RED-CHECK TEST IS A CONTROL, not a third example. Billing every
 * failure to the author would satisfy both author-owned assertions above it,
 * leaving them decorative — only a code that must NOT bill the author proves
 * the classification is a decision rather than a constant. Do not delete it as
 * redundant.
 *
 * Identifying the member: `ChangeNeedsAuthorFactSchema` is `.strict()` and
 * carries no `branch`, so the fact names its member only by a minted `PRId`
 * that no store resolves. The branch is recovered through the fact's required
 * `run` and that run's retained snapshot. Adding `branch` to the schema is the
 * honest fix and is DEFERRED on purpose (@chief 2026-08-27): an event-schema
 * change moves the projection checkpoint identity, which the store deletion is
 * already moving once across a one-way migration edge, and the join works
 * today. Recorded as a follow-up, not an oversight.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, parseJournalFrame, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  Queues,
  withMerge,
  withQueue,
  withStep,
  type AddStepResult,
  type CandidatePreparer,
  type ChangeShape,
  type StepExecution,
  type StepRunner,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
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

/** Derived-lane arming: the mint plus the enrichment reader are what make a
 * standing submit fact admissible at all — there is no record lane to seed
 * one. A fresh mint per app, so one test's high-water never leaks into another. */
function derivedArming() {
  return {
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }: Readonly<{ branch: string; sha: string }>) => ({ changeId: `I${sha}` }),
  }
}

async function createQueueApp(check?: StepRunner<ChangeShape, CheckResult>, journal = createMemoryJournal()) {
  const checkStep = withStep(
    "check",
    (input: StepExecution, context): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      check?.(input, context) ?? { status: "completed", conclusion: "success", output: { checked: true } },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({
    steps: [checkStep] as const,
    batch: false,
    defaultSteps: ["check"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    ...derivedArming(),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal,
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type CheckedShape = AddStepResult<ChangeShape, "check", CheckResult>

/** A check(passes) → merge(integrating) queue, so a composition refusal can be
 * placed SOLELY on the integrating step while a passed check record is also
 * present — the exact shape projectPRChecks filters out. */
async function createIntegratingApp(
  merge: (input: StepExecution<CheckedShape>) => JobResult<{ commit: string; baseSha: string }>,
  journal = createMemoryJournal(),
) {
  const checkStep = withStep(
    "check",
    (): JobResult<CheckResult> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    {
      revision: "check-v1",
      output: CheckResultSchema,
    },
  )
  const mergeStep = withMerge(merge, { revision: "merge-v1" })
  const queue = withQueue({
    steps: [checkStep, mergeStep] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    ...derivedArming(),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal,
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

/** The whole delivery, post-S7: a branch and its standing submit fact. The
 * fact IS the check request — there is no second `requestChecks` act. */
async function submitBranch(app: Pick<QueueApp, "bays">, branch: string, sha = HEAD): Promise<string> {
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
  return branch
}

async function journalEvents(
  journal: ReturnType<typeof createMemoryJournal>,
  name: string,
): Promise<readonly Readonly<{ name: string; data: unknown }>[]> {
  const out: Readonly<{ name: string; data: unknown }>[] = []
  for await (const batch of journal.read(0)) {
    for (const value of batch.values) {
      const frame = parseJournalFrame(value)
      for (const applied of frame.events) if (applied.name === name) out.push(applied)
    }
  }
  return out
}

function refusalFor(app: { state: QueueApp["state"] }, branch: string) {
  return Object.values(app.state().queues.admissionRefusals).find((row) => row.branch === branch)
}

describe("native needs-author lifecycle", () => {
  it("bills an author-owned composition refusal that reached the runner as needs-author, with its result", async () => {
    const journal = createMemoryJournal()
    await using app = await createQueueApp(
      () => ({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "composition-retired",
          message: "change 'PR1' declares a source composition; composed revisions are retired",
        },
      }),
      journal,
    )
    const branch = await submitBranch(app, "topic/authored-root")

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // The durable ledger bills the AUTHOR: kind 'refusal', not the generic
    // 'failure' an ordinary red check earns.
    expect(refusalFor(app, branch)).toMatchObject({
      branch,
      code: "composition-retired",
      kind: "refusal",
      revision: 1,
      headSha: HEAD,
    })

    // And the fact reaches settlement's hook, re-sourced from the run's own
    // snapshot — the only home a recordless member's identity has. The fact
    // schema is strict and carries no branch, so it is keyed on the minted id
    // the ledger row records for this branch.
    const needsAuthor = await journalEvents(journal, "pr/needs-author")
    expect(needsAuthor).toHaveLength(1)
    expect(needsAuthor[0]?.data).toMatchObject({
      pr: refusalFor(app, branch)?.pr,
      revision: 1,
      headSha: HEAD,
      step: "check",
      receipt: {
        code: "composition-retired",
        message: "change 'PR1' declares a source composition; composed revisions are retired",
      },
    })
    // A refused admission mints no run record.
    expect(Queues.ids(app.state().queues)).toEqual([])
    // The delivery-status copy is deleted (22991): nothing about needs-author
    // lives in queue authority.
    expect(app.state().queues.authority).not.toHaveProperty("statuses")
  })

  it("surfaces a refusal attached SOLELY to the integrating step (with a passed check present)", async () => {
    // The traced hole: projectPRChecks filters integrating steps and its
    // run.error fallback only fires with zero other records, so a composition
    // refusal on the merge step alongside a passed check record was invisible.
    const journal = createMemoryJournal()
    await using app = await createIntegratingApp(
      () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "wrapper-mismatch", message: "change 'PR1' generated wrapper paths differ" },
      }),
      journal,
    )
    const branch = await submitBranch(app, "topic/merge-refusal")

    await app.queue.run({}, runtime)

    // The refusal fired inside a started run, so the member's identity comes
    // from that run's retained snapshot — the fact itself carries no branch.
    const run = Queues.values(app.state().queues).find((record) => record.prs.some((pr) => pr.branch === branch))
    expect(run, "the merge-step refusal must happen inside a started run").toBeDefined()
    const needsAuthor = await journalEvents(journal, "pr/needs-author")
    expect(needsAuthor, "a merge-step refusal beside a passed check must still reach a human").toHaveLength(1)
    expect(needsAuthor[0]?.data).toMatchObject({
      pr: run?.prs[0]?.id,
      run: run?.id,
      step: "merge",
      receipt: { code: "wrapper-mismatch" },
    })
  })

  it("keeps an ordinary check failure (tests/lint) off the needs-author path", async () => {
    // An ordinary red check bills 'failure', never the author-owned 'refusal'
    // — which is reserved for a composition the queue could not build. This is
    // the control for the two tests above: without it, billing EVERYTHING to
    // the author would pass them both.
    const journal = createMemoryJournal()
    await using app = await createQueueApp(
      () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "unit tests failed" },
      }),
      journal,
    )
    const branch = await submitBranch(app, "topic/red-tests")

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    expect(refusalFor(app, branch)).toMatchObject({ branch, code: "check-failed", kind: "failure" })
    expect(await journalEvents(journal, "pr/needs-author")).toEqual([])
  })

  it("lets a later queue run discover a standing submit fact that no run has drained", async () => {
    // `recordBranchSubmit` projects the approval and dispatches nothing; with
    // no runner active it drains nothing. A subsequent compose must still find
    // it in the admission queue and settle it.
    await using app = await createQueueApp()
    const branch = await submitBranch(app, "topic/late-drain")

    // Nothing has run yet: the approval is visible and explicitly not served.
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual([branch])
    expect(Queues.ids(app.state().queues)).toEqual([])

    await app.queue.run({}, runtime)

    // The later run found it and settled its checks.
    expect(app.queue.unrecordedSubmits()).toEqual([])
    const served = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.branch === branch))
    expect(served?.prs[0]).toMatchObject({ branch, headSha: HEAD, revision: 1 })
  })

  it("keeps submission open while another candidate runs and while processing is paused", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await using app = await createQueueApp(async () => {
      started.resolve()
      await release.promise
      return { status: "completed", conclusion: "success", output: { checked: true } }
    })
    await submitBranch(app, "topic/active")
    const running = app.queue.run({}, runtime)
    // Raced against the run itself: if the compose rejects before the check
    // step is reached, `started` never resolves and a bare await would hang
    // until the suite timeout instead of reporting the real failure.
    await Promise.race([started.promise, running])

    const duringRun = await submitBranch(app, "topic/during-run", "2".repeat(40))
    expect(app.state().bays.submits[duringRun]).toMatchObject({ sha: "2".repeat(40), base: "main" })

    release.resolve()
    await running

    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })
    const duringPause = await submitBranch(app, "topic/during-pause", "3".repeat(40))
    expect(app.state().bays.submits[duringPause]).toMatchObject({ sha: "3".repeat(40), base: "main" })

    // Both are queued work the pause is holding, not lost submissions.
    expect(app.queue.unrecordedSubmits().map((row) => row.branch).toSorted()).toEqual(
      [duringPause, duringRun].toSorted(),
    )
  })
})
