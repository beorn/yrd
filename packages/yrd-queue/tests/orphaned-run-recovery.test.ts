/**
 * @failure A queue run with no Job at its cursor step projects as `running` forever — `advance` no-ops without a Job and `jobs.recover()` has no Job to reclaim — so a finished PR keeps a phantom `● run` row whose clock ticks up indefinitely (live incident R1582: 45h over an already-integrated change).
 *
 * S7 conversion note (branch-is-change, @i/10 22991): every member below is
 * DERIVED — a branch plus its standing submit fact, composed into a run member
 * — because `bays.submit` now refuses `record-mint-retired` and there is no
 * record store to mint into. The run-shaped contracts (jobless projection,
 * `orphaned-run` audit and settlement, the orphan grace, lease lapse) are
 * queue-side and unchanged. The file's former `draft stranded` suite is gone
 * with its subject: `draft-stranded` is a RECORD-lane finding over changes whose
 * delivery state is `pushed` but never `submitted`, and post-S7 a branch either
 * carries a submit fact or is not a delivery at all. Its surviving cousin is
 * `unrecorded-submit` (a submitted branch the queue has not composed), covered
 * by `derived-admission.test.ts` and `submit-intake.test.ts`.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { deriveRunMemberArgs, withStep, withQueue, type DerivedRunMember } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const START = "2026-01-01T00:00:00.000Z"
/** Past the orphan grace (15m) the writer is gone. */
const STALE = "2026-01-01T01:00:00.000Z"
/** Inside the grace: a run that just started is still legitimately jobless for a moment. */
const FRESH = "2026-01-01T00:01:00.000Z"

function ids(initial = 0): () => string {
  let value = initial
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

async function createApp(
  journal: Journal<unknown> = createMemoryJournal(),
  id: () => string = ids(),
  log?: ReturnType<typeof createLogger>,
) {
  const bayJobs = createBayJobDefs(workspace())
  const first = withStep(
    "first",
    (): JobResult<{ first: boolean }> => ({ status: "completed", conclusion: "success", output: { first: true } }),
    {
      revision: "first-v1",
      output: z.object({ first: z.boolean() }).strict(),
    },
  )
  const queue = withQueue({ steps: [first] as const, batch: false, defaultSteps: ["first"] })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => START, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

/** ONE PR-number mint per app. `deriveRunMemberArgs` commits its number through
 * the mint it is handed, so a fresh mint per call would re-issue `PR1` for every
 * branch and collide two members of the same run. */
const mints = new WeakMap<object, PrNumberMint>()
function mintFor(app: object): PrNumberMint {
  const existing = mints.get(app)
  if (existing !== undefined) return existing
  const created = volatilePrNumberMint()
  mints.set(app, created)
  return created
}

/** The branch's standing submit fact IS the delivery (S7 branch-is-change);
 * the member the queue would compose from it is derived here so the `queue.run`
 * dispatches below can name exactly one. */
async function submitBranch(
  app: Awaited<ReturnType<typeof createApp>>,
  branch: string,
): Promise<DerivedRunMember> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: mintFor(app),
    branch,
  })
}

type Fact = Readonly<{ name: string; data?: unknown }>
type Frame = Readonly<{ events?: readonly Fact[] }>

async function frames(journal: Journal<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected
}

/** Drop every Job event from a journal, keeping the Queue's own facts.
 *
 * This is the live shape the incident produced: Job retention (`compactJobsState`)
 * prunes a finished root's Jobs while the Queue RECORD survives, so the record
 * meets a Jobs projection that no longer holds its steps' Jobs. Replaying without
 * Job events reproduces exactly that record-without-Jobs state. */
async function withoutJobEvents(journal: Journal<unknown>): Promise<Journal<unknown>> {
  const kept = (await frames(journal)).map((value) => {
    const frame = value as Frame
    if (frame.events === undefined) return value
    return { ...frame, events: frame.events.filter((event) => !event.name.startsWith("job/")) }
  })
  return createMemoryJournal(kept)
}

/** A run started but never Job-backed: the record exists, its steps have no Job. */
async function joblessRun(log?: ReturnType<typeof createLogger>) {
  const journal = createMemoryJournal()
  {
    await using seed = await createApp(journal)
    const member = await submitBranch(seed, "issue/orphaned-run")
    // `prs: []` beside a non-empty `derived` selects exactly those derived
    // members — the post-S7 spelling of naming one member explicitly.
    await seed.dispatch(seed.commands.queue.run, { prs: [], derived: [member], steps: ["first"] })
    expect(seed.queue.get("R1")?.steps[0]?.job, "seed must start with a Job so the surgery is meaningful").toBeDefined()
  }
  return createApp(await withoutJobEvents(journal), ids(100), log)
}

describe("orphaned run recovery — a run with no Job at its cursor step can never settle itself", () => {
  it("projects a jobless run as queued, and neither advance nor job recovery can move it", async () => {
    await using app = await joblessRun()

    const run = app.queue.get("R1")
    expect(run?.steps[0]?.job, "the surgery must leave the run Job-less").toBeUndefined()
    // This is the defect's shape: no Job to reclaim, and advance emits nothing.
    expect(run?.status).toBe("queued")
    expect(await app.jobs.recover({ now: STALE, reason: "lease sweep" })).toEqual([])
    await app.dispatch(app.commands.queue.advance, { run: "R1" })
    expect(app.queue.get("R1")?.status, "advance cannot move a run with no job at its cursor").toBe("queued")
  })

  it("audit flags the jobless run instead of printing clean", async () => {
    await using app = await joblessRun()

    const finding = app.queue.audit().findings.find((item) => item.code === "orphaned-run")
    expect(finding, "audit must flag a run that can never advance").toBeDefined()
    expect(finding?.run).toBe("R1")
    expect(finding?.step).toBe("first")
  })

  it("recover settles a stale jobless run with a truthful reason and a loud result", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await joblessRun(log)

    await app.queue.recover({ recoveryTime: STALE, reason: "habitant restart" })

    const run = app.queue.get("R1")
    expect(run?.status).toBe("completed")
    expect(run?.finishedAt, "a settled run must carry a finish instant").toBeDefined()
    expect(run?.error?.code).toBe("orphaned-run")
    // Truthful and specific: this is NOT lease expiry — there was never a Job.
    expect(run?.error?.message).toContain("runner disappeared before step 'first' started")
    expect(run?.error?.message).toContain(START)
    expect(app.queue.audit().findings.some((item) => item.code === "orphaned-run")).toBe(false)

    const result = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "recover-orphan-run-settle",
    )
    expect(result, "recover must emit a loud structured result for settled orphan runs").toBeDefined()
    expect(result?.props).toMatchObject({ reason: "orphaned-run", runs: ["R1"], steps: ["first"] })
    log.end()
  })

  it("recover leaves a freshly started jobless run alone", async () => {
    await using app = await joblessRun()

    // The legitimate transient window: a run whose cursor step is between the
    // previous Job finishing and the next advance. Settling here would abort live work.
    await app.queue.recover({ recoveryTime: FRESH, reason: "habitant restart" })

    expect(app.queue.get("R1")?.status, "a run inside the orphan grace is still live").toBe("queued")
    expect(app.queue.get("R1")?.error).toBeUndefined()
  })

  it("settling an orphan twice is a no-op, not a duplicate failure", async () => {
    await using app = await joblessRun()

    await app.queue.recover({ recoveryTime: STALE, reason: "habitant restart" })
    const settled = app.queue.get("R1")
    await app.queue.recover({ recoveryTime: STALE, reason: "habitant restart" })

    expect(app.queue.get("R1")).toEqual(settled)
  })

  it("refuses to settle a run that still has a job at its cursor", async () => {
    await using app = await createApp()
    const member = await submitBranch(app, "issue/live-run")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [member], steps: ["first"] })

    await expect(
      app.dispatch(app.commands.queue.settleOrphanedRun, { run: "R1", reason: "not an orphan" }),
    ).rejects.toThrow(/has a job at step 'first'/u)
  })
})

describe("a finished run stays terminal after its Jobs are pruned", () => {
  it("projects passed from the record's own settlement proof, not from retained Jobs", async () => {
    const journal = createMemoryJournal()
    {
      await using seed = await createApp(journal)
      const member = await submitBranch(seed, "issue/passes")
      await seed.queue.run({ prs: [], derived: [member], steps: ["first"] }, { runner: "local", leaseMs: 60_000 })
      expect(seed.queue.get("R1")?.status, "the seed run must reach passed").toBe("completed")
    }

    // Job retention prunes a finished root's Jobs; the Queue record outlives them.
    await using pruned = await createApp(await withoutJobEvents(journal), ids(100))

    const run = pruned.queue.get("R1")
    expect(run?.status, "a settled passed run must not resurrect as a phantom `running`").toBe("completed")
    expect(run?.finishedAt).toBeDefined()
    expect(pruned.queue.audit().findings.some((item) => item.code === "orphaned-run")).toBe(false)
  })
})

/**
 * The read side of the lease seam (@yrd/core/21085-target-model/21094, #undead).
 * The sibling defect above is a run with NO Job. This one has a Job, still
 * `in_progress`, whose runner is gone — so it projects as healthily running
 * for as long as nobody sweeps it. Live R1740: the lease expired 20:35:03.925Z
 * and the `lose` transition was not written until 20:45:27.620Z; for 10m24s
 * the queue view showed a live run and `queue audit` reported nothing at all.
 */
describe("lapsed runner lease — a Job-backed run projects as running with nothing renewing it", () => {
  const LEASE_EXPIRES = "2026-01-01T00:00:30.000Z"

  async function leasedRun() {
    const app = await createApp()
    const member = await submitBranch(app, "issue/lease-lapsed")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [member], steps: ["first"] })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("the run must be Job-backed for a lease to exist at all")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "yrd-cli:404",
      leaseExpiresAt: LEASE_EXPIRES,
    })
    expect(app.queue.get("R1")?.steps[0]?.job?.status, "the run must read as running for the gap to exist").toBe(
      "in_progress",
    )
    return app
  }

  it("flags the lapse and how long it has stood", async () => {
    await using app = await leasedRun()

    const finding = app.queue.audit({ now: STALE }).findings.find((item) => item.code === "run-lease-expired")
    expect(finding, "a lapsed lease must not read as a healthy run").toBeDefined()
    expect(finding?.run).toBe("R1")
    expect(finding?.step).toBe("first")
    expect(finding?.since).toBe(LEASE_EXPIRES)
    expect(finding?.blockedMs, "the operator needs the age of the gap, not just its existence").toBe(
      Date.parse(STALE) - Date.parse(LEASE_EXPIRES),
    )
  })

  it("stays silent while the lease is still live", async () => {
    await using app = await leasedRun()

    // The control that keeps the check honest. It must sit INSIDE the lease
    // window — note FRESH does not, it is 00:01:00 against a 00:00:30 expiry, so
    // using it here asserted the opposite of what it read. Without a control the
    // check above could pass while flagging every healthy run too.
    const live = "2026-01-01T00:00:10.000Z"
    expect(Date.parse(live)).toBeLessThan(Date.parse(LEASE_EXPIRES))
    expect(app.queue.audit({ now: live }).findings.some((item) => item.code === "run-lease-expired")).toBe(false)
  })
})
