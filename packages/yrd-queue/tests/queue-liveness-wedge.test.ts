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

/**
 * `livenessEpoch` — whose silence is this (@i/10-yrd/liveness-is-health).
 *
 * A queue's history is older than any one runner, so measured from the journal
 * alone this finding answers "has this queue merged lately" while being read as
 * "has THIS runner stopped draining". Measured 2026-09-02: a resident booted
 * into a queue whose last merge was 1h25m old emitted the finding before
 * attempting a single member, and under the any-ERROR rule exited 17 — over and
 * over, so the queue drained never. A caller that owns a runner declares its own
 * floor here and the clock starts there.
 */
describe("queue-liveness-wedged — measured from the observer's own epoch", () => {
  /** The standing specimen: one PR wedged inside a merge attempt since
   * 00:00:00, read an hour later. Every case below is the SAME queue state,
   * differing only in who is asking. */
  async function wedgedForAnHour() {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const app = await createDeliveryApp(clock.read, true)
    const pr = await submitAndRequestChecks(app, "issue/stuck-forever")
    await app.queue.run({}, runtime)
    return { app, pr }
  }

  const NOW = "2026-01-01T01:00:00.000Z"
  const wedged = expect.objectContaining({ code: "queue-liveness-wedged" })

  it("emits nothing to a runner that booted after the wedge began — it cannot have stopped what it never started", async () => {
    await using app = (await wedgedForAnHour()).app

    // CONTROL, and the whole point: the SAME audit at the SAME instant still
    // reports the wedge when nobody declares an epoch. The absence below is
    // the epoch's doing, not an empty queue or a mis-set clock.
    expect(app.queue.audit({ now: NOW }).findings).toContainEqual(wedged)

    // A resident five minutes old. The journal's hour is its predecessors'.
    expect(app.queue.audit({ now: NOW, livenessEpoch: "2026-01-01T00:55:00.000Z" }).findings).not.toContainEqual(wedged)
  })

  it("still emits to a runner that has been up across the whole wedge — the epoch narrows the claim, it does not disable it", async () => {
    await using app = (await wedgedForAnHour()).app

    // Up since before the work became eligible: the full hour is this
    // runner's, so the finding stands and reports the SAME span it always did.
    expect(app.queue.audit({ now: NOW, livenessEpoch: "2025-12-31T23:00:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({ code: "queue-liveness-wedged", blockedMs: 3_600_000 }),
    )
  })

  it("measures the span from the epoch when the epoch is the later floor, and fires exactly at the threshold", async () => {
    await using app = (await wedgedForAnHour()).app

    // Epoch at 00:30, read at 01:00: 30 minutes of THIS runner's silence, which
    // is exactly the default `noLandingMs`. One millisecond earlier, nothing.
    expect(
      app.queue.audit({ now: "2026-01-01T00:59:59.999Z", livenessEpoch: "2026-01-01T00:30:00.000Z" }).findings,
    ).not.toContainEqual(wedged)
    expect(app.queue.audit({ now: NOW, livenessEpoch: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-liveness-wedged",
        blockedMs: 1_800_000,
        since: "2026-01-01T00:30:00.000Z",
      }),
    )
  })
})
