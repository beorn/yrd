/**
 * @failure A PR admitted, checks passed, and stuck forever inside one
 *          long-running merge attempt reads as `runnable: false` ("claimed"
 *          by its own run) the instant compose starts it, so an eligibility-
 *          derived liveness reader would report it as `eligible: 0` — falsely
 *          idle — for as long as it stands. `queue-progress-stalled` misses
 *          it too, for a different reason: `admissionChecks` never
 *          accumulates a second attempt once a PR is past admission, so it
 *          never crosses `minAdmissionChecks` and stays permanently
 *          suppressed, not merely delayed. 2026-08-2x specimen: two standing
 *          submit facts could never merge and the habitant runner logged
 *          "recover succeeded ... runs: []" every ~60s for 17 hours while
 *          minting phantom changes; no alarm fired.
 * @level l2
 * @consumer @yrd/queue `queue audit`, and (via `habitantQueueProgress`)
 *           @yrd/cli service health and the habitant recover cycle's own log
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withStep, withQueue, DEFAULT_QUEUE_PROGRESS_POLICY, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

function movableClock(initial: string) {
  let now = initial
  return { read: () => now, set: (at: string) => (now = at) }
}

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "test-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: HEAD, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/** Reproduced from admission-refusal-oracle.test.ts's own `createDeliveryApp`
 * (this file's sibling): `waitForMerge` never resolves the merge step, so an
 * admitted, checks-passed PR stays claimed by its own run forever — the
 * "stuck compose pass" specimen, not a canned finding object. */
async function createDeliveryApp(clock: () => string, waitForMerge: boolean) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<{ checked: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    (): JobResult<{ commit: string; baseSha: string }> =>
      waitForMerge
        ? { status: "waiting", token: "merge-pending" }
        : { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    progress: { ...DEFAULT_QUEUE_PROGRESS_POLICY, refusalCount: 3 },
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock, log: createLogger("test", [{ level: "silent" }]) },
  })
}

type SubmissionApp = Readonly<{
  bays: Pick<Awaited<ReturnType<typeof createDeliveryApp>>["bays"], "submit" | "requestChecks" | "prs">
}>

async function submitAndRequestChecks(app: SubmissionApp, branch: string) {
  const digit = (app.bays.prs().length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = app.bays.prs().find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr
}

describe("queue-liveness-wedged — the (eligible, advanced-since-last-tick) pair", () => {
  it("names a PR stuck forever inside one merge attempt, which runnable-eligibility alone would miss", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    const pr = await submitAndRequestChecks(app, "issue/stuck-forever")

    await app.queue.run({}, runtime)

    // CONTROL: the PR really is claimed by its own run, not merely queued —
    // confirms this specimen is the "claimed" shape, not "checks-pending".
    expect(app.queue.eligibility(pr.id).reason?.code).toBe("claimed")
    expect(app.bays.pr(pr.id)?.integratedAt).toBeUndefined()

    // Below threshold: nothing yet.
    expect(app.queue.audit({ now: "2026-01-01T00:29:59.999Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-liveness-wedged" }),
    )

    // At and past the 30-minute default threshold: named, with the exact
    // count/blockedMs/since a reader needs.
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual({
      code: "queue-liveness-wedged",
      message:
        `Queue 'main' has 1 eligible change outstanding and no merge for 30m00s ` +
        `(since 2026-01-01T00:00:00.000Z); this reads independently of any admission-refusal finding and ` +
        `repeat-admission bar, and is never suppressed by either. Head: '${pr.id}'.`,
      pr: pr.id,
      specimen: "queue:main:liveness-wedged",
      count: 1,
      since: "2026-01-01T00:00:00.000Z",
      blockedMs: 1_800_000,
    })
  })

  it("fires while queue-progress-stalled stays permanently suppressed for the SAME stuck PR", async () => {
    // The differential this bead's acceptance is about: one admission check
    // request, then the run hangs — `admissionChecks` (check-requests since
    // the base went idle) never gets a second attempt to cross
    // `minAdmissionChecks`, so `queue-progress-stalled` is not merely late,
    // it never fires for this PR at all. `queue-liveness-wedged` carries no
    // such bar.
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    const pr = await submitAndRequestChecks(app, "issue/one-admission-only")
    await app.queue.run({}, runtime)

    const findings = app.queue.audit({ now: "2026-01-01T01:00:00.000Z" }).findings
    expect(findings).not.toContainEqual(expect.objectContaining({ code: "queue-progress-stalled" }))
    expect(findings).toContainEqual(expect.objectContaining({ code: "queue-liveness-wedged", pr: pr.id }))
  })

  it("reads healthy when nothing is outstanding — eligible=0 is correct however stale the tick", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, false)
    await submitAndRequestChecks(app, "issue/lands-cleanly")
    await app.queue.run({}, runtime)

    expect(app.bays.prs().every((candidate) => candidate.integratedAt !== undefined)).toBe(true)
    expect(app.queue.audit({ now: "2026-01-01T02:00:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-liveness-wedged" }),
    )
  })
})
