/**
 * @failure The admission lane (`admissionQueue`) and the run lane
 * (`ChangeEligibility`/`checkEligibility`) are two hand-maintained
 * derivations over the SAME per-PR facts, and they have drifted. This file
 * pins two concrete divergences as CURRENT, documented behavior — not as
 * desired behavior — so a coming unification proves its fix by editing
 * exactly the assertions marked "KNOWN DEFECT" below, nothing else:
 *
 * D1 — a change with no live check request for its current head is EXCLUDED
 * by the admission lane (correct: nothing has asked for checks yet) but
 * reported RUNNABLE by the run lane (wrong: the cascade has no branch for
 * "not-requested", so absence of check evidence falls through every refusal
 * and reaches the default success).
 *
 * D2 — a cached PASSED admission record for a base-classified step is
 * trusted, unconditionally, by the admission lane's freshness check
 * (`admission.status === "passed" && steps.length === selected.length`, no
 * classification guard) — which permanently retires the change from every
 * future selectorless admit. The run lane's twin of the same check adds
 * `selected.every(step => step.classification !== "base")` before trusting
 * the cache, so for a base-classified step it correctly refuses to call the
 * change "passed" from a stale record alone. The two lanes end up
 * disagreeing forever on the SAME state: the run lane reports the change
 * still queued and waiting its turn; the admission lane will never dispatch
 * it again to give that turn any evidence.
 *
 * Both fixtures below plant their admission record directly via bays' own
 * `recordAdmission` fact-recorder — no job or run is ever dispatched — so
 * `state.jobs` and `state.queues.index` stay empty for the change. That is
 * deliberate: it is the shape a real record settles into once whatever
 * produced it (a Job, a Run) has been retired from state while the cached
 * fact and the change itself are untouched, without needing to reconstruct
 * that retirement through journal replay.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { changeAdmission, createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withQueue, withStep, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
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

/** One "check" admission step, optionally classified `base` — the exact
 * dimension D2 splits the two lanes on. */
async function createReadinessApp(classification?: "base" | "carrier") {
  const checkStep = withStep(
    "check",
    (): JobResult<CheckResult> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: CheckResultSchema, ...(classification === undefined ? {} : { classification }) },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type ReadinessApp = Awaited<ReturnType<typeof createReadinessApp>>

function recorded(app: ReadinessApp, branch: string): string {
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr.id
}

async function submitAndRequestChecks(app: ReadinessApp, branch: string): Promise<string> {
  await app.bays.submit({ branch, headSha: HEAD, base: "main", baseSha: BASE })
  const pr = recorded(app, branch)
  await app.bays.requestChecks({ pr })
  return pr
}

/** A change with a passed, complete, matching admission record — but no job
 * or run in state to re-derive that answer from. Both lanes read the SAME
 * cached record; D2 is about whether each one trusts it. */
async function submitWithCachedPass(app: ReadinessApp, branch: string): Promise<string> {
  const pr = await submitAndRequestChecks(app, branch)
  await app.bays.recordAdmission({
    pr,
    revision: 1,
    headSha: HEAD,
    admission: {
      status: "passed",
      baseSha: BASE,
      steps: [{ name: "check", revision: "check-v1", job: "job-cached-1", status: "passed", output: { checked: true } }],
    },
  })
  return pr
}

describe("admission lane vs run lane readiness — today's two divergences", () => {
  describe("D1 — a change with no live check request for its current head", () => {
    it("is excluded by the admission lane but reported runnable by the run lane", async () => {
      await using app = await createReadinessApp()
      await app.bays.submit({ branch: "topic/no-checks-yet", headSha: HEAD, base: "main", baseSha: BASE })
      const pr = recorded(app, "topic/no-checks-yet")

      // Admission lane's own view of this state, correct today: `checksRequested(pr)`
      // is false, so the change is excluded before it is ever a candidate for
      // (re-)dispatch. A selectorless admit sees nothing to do.
      await expect(app.queue.admit({}, runtime)).resolves.toEqual([])

      // KNOWN DEFECT (D1): the run lane's `checkEligibility` reports
      // "not-requested" for the same state (no branch in the cascade tests for
      // it), so `ChangeEligibility` falls through delivery/candidate/refusal/
      // checks/review checks all the way to the default success. A change with
      // ZERO check evidence for its current head is reported runnable. The
      // coming unification adds a `checks-not-requested` refusal branch ahead
      // of the existing `checks-pending` branch; when that lands, this
      // resolves to `runnable: false` with `reason.code === "checks-not-requested"`.
      expect(app.queue.eligibility(pr)).toEqual({
        pr,
        revision: 1,
        runnable: true,
        review: { required: false, approved: false, stale: false },
        checks: { status: "not-requested" },
      })
    })
  })

  describe("D2 — a cached passed admission record for a base-classified step", () => {
    it("control: a non-base step's cached pass is trusted by the run lane (not a divergence)", async () => {
      await using app = await createReadinessApp(undefined)
      const pr = await submitWithCachedPass(app, "topic/cached-pass-non-base")

      const current = app.state().bays.prs[pr]
      if (current === undefined) throw new Error("expected PR")
      expect(changeAdmission(current)).toMatchObject({ status: "passed", baseSha: BASE })

      // No `classification` on the sole selected step, so `checkEligibility`'s
      // cache-trust branch applies and both lanes agree the change is settled.
      expect(app.queue.eligibility(pr)).toMatchObject({ runnable: true, checks: { status: "passed" } })
      // The admission lane naturally excludes an already-passed, complete
      // change from further dispatch too — correct here, since the run lane
      // already accepts the cached answer.
      await expect(app.queue.admit({}, runtime)).resolves.toEqual([])
    })

    it("the run lane reports the change still queued while the admission lane has already retired it forever", async () => {
      await using app = await createReadinessApp("base")
      const pr = await submitWithCachedPass(app, "topic/cached-pass-base")

      // Run lane's view: `checkEligibility`'s cache-trust branch requires
      // `selected.every(step => step.classification !== "base")`; the sole
      // selected step IS base-classified, so the shortcut is skipped. With no
      // job or run in state to re-derive a fresh answer from, the derivation
      // falls through to the ordinary queued/position read instead of
      // blindly reporting "passed" from the stale record — correct, so far.
      expect(app.queue.eligibility(pr)).toMatchObject({
        runnable: false,
        reason: { code: "checks-pending" },
        checks: { status: "queued", position: 1 },
      })

      // KNOWN DEFECT (D2): the admission lane's own freshness check has no
      // such guard — `admission.status === "passed" && steps.length ===
      // selected.length` alone retires the change from every future
      // selectorless admit, regardless of classification. Nothing above
      // changed state, and nothing here ever will on its own: the exclusion
      // is a pure function of this same cached record, so the "queued" answer
      // the run lane just gave is permanent, not merely not-yet-dispatched —
      // the starvation. The coming unification extracts one shared freshness
      // predicate so both lanes apply the SAME classification guard; when
      // that lands this resolves to a non-empty admit, not a silent `[]`.
      await expect(app.queue.admit({}, runtime)).resolves.toEqual([])
    })
  })
})
