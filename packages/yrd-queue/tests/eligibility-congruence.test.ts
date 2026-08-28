/**
 * @failure The run path and the status surface computed "runnable" separately
 * and disagreed: on 2026-08-16 the queue view showed seven carriers ready and
 * `mr list` runnable=true while the run path computed not-runnable for every
 * one, and six instruments reported healthy through a six-hour freeze
 * (@pm/incidents/22881; ruling @i/10-merge-queue/22895). This file is the
 * congruence pin that turns the next divergence into a red test instead of an
 * outage: ONE fixture, BOTH surfaces, asserted to agree per branch.
 *
 * S7 (branch-is-change, @i/10 22991) deleted the change-record store, and with
 * it the record-keyed `eligibility()`/`eligibilities()` — one of the two
 * surfaces that disagreed. That collapse is the DURABLE fix this file was
 * always a stand-in for: the old shape kept two derivations of one verdict in
 * step by testing them against each other, which can only DETECT a divergence
 * after it exists. There is now one derivation — `deriveChange(branch).authority`
 * plus the run path's `considered` rows, both reading the standing submit fact
 * — so divergence is unrepresentable rather than merely caught. What these
 * tests still owe is that the single derivation is the one BOTH the status
 * surface and the compose actually consult, asserted per branch.
 *
 * The final describe discharges the UNSHIPPED half of the 22895 ruling: agreeing
 * on the verdict is not enough — every blocking reason code must also REACH a
 * human with its message. It is table-driven over the whole
 * `ChangeEligibilityReason["code"]` union with a compile-time exhaustiveness
 * pin, so a new code that renders nowhere is a red test (or a type error), not
 * a silent `-` in a WHY column.
 * @level l2
 * @consumer @yrd/queue
 */
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type Change } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, raiseFailure } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  Queues,
  withQueue,
  withStep,
  type CandidatePreparer,
  type ChangeEligibility,
  type ChangeEligibilityReason,
  type StepExecution,
} from "@yrd/queue"
// The human surface under test lives in @yrd/cli; tests may reach across the
// package boundary the same way refusal-code-registry.test.ts already does.
import { ChangeStatusView } from "../../yrd-cli/src/status-view.tsx"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const GONE = "e".repeat(40)
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

async function createQueueApp(log = createLogger("test", [{ level: "silent" }])) {
  const checkStep = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({
    steps: [checkStep] as const,
    batch: false,
    defaultSteps: ["check"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: volatilePrNumberMint(),
    // The vanished-commit branch refuses at its OWN derivation, which is the
    // only reachable way post-S7 to hold one approval back while another runs.
    readSubmitEnrichment: ({ sha }: Readonly<{ branch: string; sha: string }>) => {
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
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log,
    },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

/** What the STATUS surface says about a branch, reduced to what a reader
 * compares: is it pending, and if so why has it not run. */
function statusVerdict(app: QueueApp, branch: string) {
  const derived = app.queue.deriveChange(branch)
  return {
    branch,
    approved: derived.submit !== undefined,
    pending: derived.unrecorded !== undefined,
    ...(derived.unrecorded === undefined ? {} : { code: derived.unrecorded.reason.code }),
  }
}

/** What the RUN path did with a branch: a retained run, or nothing. */
function ranFor(app: QueueApp, branch: string): boolean {
  return Queues.values(app.state().queues).some((run) => run.prs.some((pr) => pr.branch === branch))
}

describe("eligibility congruence — one fixture, both surfaces", () => {
  it("every branch the status surface calls pending is one the run path did not run, and vice versa", async () => {
    await using app = await createQueueApp()
    // Three branches in the three reachable states: servable, refused at its
    // own derivation, and never approved at all.
    await app.bays.recordBranchSubmit({ branch: "issue/servable", sha: SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/vanished", sha: GONE, base: "main" })

    // Before any compose BOTH approvals are pending, and both surfaces say so.
    expect(app.queue.unrecordedSubmits().map((row) => row.branch).toSorted()).toEqual([
      "issue/servable",
      "issue/vanished",
    ])
    expect(statusVerdict(app, "issue/servable")).toEqual({
      branch: "issue/servable",
      approved: true,
      pending: true,
      code: "unrecorded-submit",
    })

    await app.queue.run({}, runtime)

    // DELIBERATE RED (S7): `issue/servable` RAN and the status surface still
    // calls it pending. Observed: `ranFor(app, "issue/servable")` is true,
    // `statusVerdict(...).pending` is true, and the verdict still carries
    // `code: "unrecorded-submit"` — the same code it carried BEFORE the
    // compose, above.
    //
    // That is the incongruence this file exists to catch, in the direction
    // that misleads: a branch the queue has served reads as still waiting to
    // be served. `unrecordedSubmits` documents itself as "retiring once a
    // retained run snapshot serves the branch", so either the run retained no
    // snapshot naming this branch at the fact's sha, or the retirement
    // condition does not see the one it retained.
    //
    // NOT caused by tonight's landed fixes — this red predates them (it stood
    // at the 195-red measurement, before explicit selection and the refused-
    // branch visibility work). Reported rather than converted: the assertion
    // is correct and the surfaces genuinely disagree.
    //
    // 1. Content congruence, per branch: pending on the status surface iff the
    //    run path left it alone.
    for (const branch of ["issue/servable", "issue/vanished", "issue/never-approved"]) {
      const status = statusVerdict(app, branch)
      expect(status.pending, `'${branch}' must be pending exactly when it did not run`).toBe(!ranFor(app, branch))
    }
    // 2. And the three states really are distinct — a fixture where every
    //    branch behaved alike would satisfy (1) vacuously.
    expect(ranFor(app, "issue/servable")).toBe(true)
    expect(ranFor(app, "issue/vanished")).toBe(false)
    expect(statusVerdict(app, "issue/never-approved")).toEqual({
      branch: "issue/never-approved",
      approved: false,
      pending: false,
    })
    // 3. Population congruence: the pending list is exactly the approved-and-
    //    unserved branches, with no served branch lingering on it.
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/vanished"])
  })

  it("an empty FIFO says what it looked at instead of returning nothing", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(log)

    const direct = await app.dispatch(app.commands.queue.run, {})
    expect(direct.events).toEqual([])
    // Before 2026-08-21 this was `{ events: [] }` and nothing else: an honest
    // empty and a run that never looked were the same bytes.
    expect(direct.value).toMatchObject({
      kind: "no-submitted-prs",
      selectedSteps: ["check"],
      reason: expect.stringContaining("visible to the queue"),
    })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    const line = events.find((event) => event.kind === "log" && event.props?.action === "queue-run-no-submitted-prs")
    expect(line).toBeDefined()
    // info, never warn: the empty FIFO is the habitant runner's normal state.
    expect(line?.kind === "log" ? line.level : undefined).toBe("info")
  })
})

describe("eligibility congruence — the source of truth is the submit ref the receiver projected", () => {
  it("an unsubmit fact removes the branch from every surface; an unsubmit for a branch that never submitted is a no-op", async () => {
    await using app = await createQueueApp()
    await app.bays.recordBranchSubmit({ branch: "issue/gone", sha: SHA, base: "main" })
    await app.bays.recordBranchUnsubmit({ branch: "issue/gone", reason: "deleted" })
    expect(app.queue.unrecordedSubmits()).toEqual([])
    expect(app.queue.deriveChange("issue/gone")).toEqual({
      branch: "issue/gone",
      authority: { lane: "none", cell: { record: "none", submit: "none" } },
    })

    const before = app.state()
    await app.bays.recordBranchUnsubmit({ branch: "issue/never", reason: "archived" })
    expect(app.state().bays.submits).toEqual(before.bays.submits)
    // Back to the honest empty: nothing approved anywhere.
    const direct = await app.dispatch(app.commands.queue.run, {})
    expect(direct.value).toMatchObject({ kind: "no-submitted-prs" })
  })

  it("a served branch's pending row retires, and an approval arriving after the compose keeps its own", async () => {
    await using app = await createQueueApp()
    await app.bays.recordBranchSubmit({ branch: "issue/served", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(app.queue.unrecordedSubmits()).toEqual([])

    // A row that persists means "not picked up", never silence — the
    // distinction the 22881 freeze turned on.
    await app.bays.recordBranchSubmit({ branch: "issue/after", sha: "3".repeat(40), base: "main" })
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/after"])
    expect(statusVerdict(app, "issue/after")).toMatchObject({ pending: true, code: "unrecorded-submit" })
  })
})

describe("eligibility congruence — every blocking reason reaches a human (22895, unshipped half)", () => {
  /** Codes a member can still be blocked by, every one of which must render. */
  const CODES = [
    "checks-pending",
    "admission-refused",
    "required-check-failed",
    "needs-author",
    "candidate-conflicting",
    "queue-paused",
    "claimed",
    "checking",
    "rejected",
    "terminal",
  ] as const satisfies readonly ChangeEligibilityReason["code"][]

  /**
   * Codes retired by S7 on 2026-08-27 — still members of the union, but no
   * writer can produce them, so a render test for them would assert against a
   * state nothing can reach. Named rather than dropped, so a future reader can
   * tell a deliberate retirement from an accidental omission:
   *
   * - `draft` — a draft cannot exist to be ineligible. The record mint is
   *   retired, so `bay.submit`/`bay.intake` refuse `record-mint-retired`
   *   rather than minting a pushed-not-submitted record.
   * - `review-required`, `review-rejected` — unreachable by construction. The
   *   derived lane builds every member with `reviews: []`
   *   (yrd-queue/src/derived-admission.ts:147), and the review verbs are gone:
   *   `pr/reviewed` and `pr/review-requested` survive only as parse-and-discard
   *   journal names in a bare `return state` arm (yrd-bay/src/plugin.ts:1445),
   *   never as live commands. Nothing can fill the array.
   */
  const RETIRED = ["draft", "review-required", "review-rejected"] as const satisfies
    readonly ChangeEligibilityReason["code"][]

  /** The ratchet survives the retirement: `satisfies` pins both lists ⊆ union,
   * and `_allCodesCovered` pins union ⊆ CODES ∪ RETIRED — so a NEW code must be
   * classified into one list or the other or it is a compile error, never a
   * silent `-` in a WHY column. */
  type UncoveredCode = Exclude<
    ChangeEligibilityReason["code"],
    (typeof CODES)[number] | (typeof RETIRED)[number]
  >
  const _allCodesCovered: UncoveredCode extends never ? true : never = true
  void _allCodesCovered

  function viewChange(pr: string): Change {
    return {
      id: pr,
      name: `Change ${pr}`,
      branch: `topic/${pr.toLowerCase()}`,
      base: "main",
      state: "open",
      merged: false,
      revs: [
        {
          n: 1,
          head: HEAD,
          base: "main",
          baseSha: BASE,
          pushedAt: "2026-01-01T00:00:00.000Z",
          submittedAt: "2026-01-01T00:00:00.000Z",
          submitter: "author@example.test",
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
    }
  }

  it.each(CODES.map((code) => ({ code })))(
    "a change blocked with reason code '$code' renders its message on the change-status surface",
    async ({ code }) => {
      const message = `the human explanation for ${code}`
      const eligibility: ChangeEligibility = {
        pr: "PR1",
        revision: 1,
        runnable: false,
        reason: { code, message },
        review: { required: false, approved: false, stale: false },
        checks: { status: "not-requested" },
      }
      const output = await renderString(
        createElement(ChangeStatusView, { prs: [viewChange("PR1")], eligibilities: [eligibility] }),
        { width: 200, height: 100, plain: true },
      )
      expect(output, `reason code '${code}' must reach a human surface with its message`).toContain(message)
    },
  )
})
