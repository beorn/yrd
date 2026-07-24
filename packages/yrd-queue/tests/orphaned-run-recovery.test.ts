/**
 * @failure A queue run with no Job at its cursor step projects as `running` forever — `advance` no-ops without a Job and `jobs.recover()` has no Job to reclaim — so a finished PR keeps a phantom `● run` row whose clock ticks up indefinitely (live incident R1582: 45h over an already-integrated PR).
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withStep, withQueue } from "@yrd/queue"

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
      status: "passed",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "passed",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    deprovision: () => ({ status: "passed", output: {} }),
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
    (): JobResult<{ first: boolean }> => ({ status: "passed", output: { first: true } }),
    {
      revision: "first-v1",
      output: z.object({ first: z.boolean() }).strict(),
    },
  )
  const queue = withQueue({ steps: [first] as const, batch: false, defaultSteps: ["first"] })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => START, ...(log === undefined ? {} : { log }) },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

type Frame = Readonly<{ events?: readonly Readonly<{ name: string }>[] }>

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
    const pr = await submitBranch(seed, "issue/orphaned-run")
    await seed.dispatch(seed.commands.queue.run, { prs: [pr.id], steps: ["first"] })
    expect(seed.queue.get("R1")?.steps[0]?.job, "seed must start with a Job so the surgery is meaningful").toBeDefined()
  }
  return createApp(await withoutJobEvents(journal), ids(100), log)
}

describe("orphaned run recovery — a run with no Job at its cursor step can never settle itself", () => {
  it("projects a jobless run as running, and neither advance nor job recovery can move it", async () => {
    await using app = await joblessRun()

    const run = app.queue.get("R1")
    expect(run?.steps[0]?.job, "the surgery must leave the run Job-less").toBeUndefined()
    // This is the defect's shape: no Job to reclaim, and advance emits nothing.
    expect(run?.status).toBe("running")
    expect(await app.jobs.recover({ now: STALE, reason: "lease sweep" })).toEqual([])
    await app.dispatch(app.commands.queue.advance, { run: "R1" })
    expect(app.queue.get("R1")?.status, "advance cannot move a run with no job at its cursor").toBe("running")
  })

  it("audit flags the jobless run instead of printing clean", async () => {
    await using app = await joblessRun()

    const finding = app.queue.audit().findings.find((item) => item.code === "orphaned-run")
    expect(finding, "audit must flag a run that can never advance").toBeDefined()
    expect(finding?.run).toBe("R1")
    expect(finding?.step).toBe("first")
  })

  it("recover settles a stale jobless run with a truthful reason and a loud receipt", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await joblessRun(log)

    await app.queue.recover({ recoveryTime: STALE, reason: "resident restart" })

    const run = app.queue.get("R1")
    expect(run?.status).toBe("failed")
    expect(run?.finishedAt, "a settled run must carry a finish instant").toBeDefined()
    expect(run?.error?.code).toBe("orphaned-run")
    // Truthful and specific: this is NOT lease expiry — there was never a Job.
    expect(run?.error?.message).toContain("runner disappeared before step 'first' started")
    expect(run?.error?.message).toContain(START)
    expect(app.queue.audit().findings.some((item) => item.code === "orphaned-run")).toBe(false)

    const receipt = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "recover-orphan-run-settle",
    )
    expect(receipt, "recover must emit a loud structured receipt for settled orphan runs").toBeDefined()
    expect(receipt?.props).toMatchObject({ reason: "orphaned-run", runs: ["R1"], steps: ["first"] })
    log.end()
  })

  it("recover leaves a freshly started jobless run alone", async () => {
    await using app = await joblessRun()

    // The legitimate transient window: a run whose cursor step is between the
    // previous Job finishing and the next advance. Settling here would abort live work.
    await app.queue.recover({ recoveryTime: FRESH, reason: "resident restart" })

    expect(app.queue.get("R1")?.status, "a run inside the orphan grace is still live").toBe("running")
    expect(app.queue.get("R1")?.error).toBeUndefined()
  })

  it("settling an orphan twice is a no-op, not a duplicate failure", async () => {
    await using app = await joblessRun()

    await app.queue.recover({ recoveryTime: STALE, reason: "resident restart" })
    const settled = app.queue.get("R1")
    await app.queue.recover({ recoveryTime: STALE, reason: "resident restart" })

    expect(app.queue.get("R1")).toEqual(settled)
  })

  it("refuses to settle a run that still has a job at its cursor", async () => {
    await using app = await createApp()
    const pr = await submitBranch(app, "issue/live-run")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first"] })

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
      const pr = await submitBranch(seed, "issue/passes")
      await seed.queue.run({ prs: [pr.id], steps: ["first"] }, { runner: "local", leaseMs: 60_000 })
      expect(seed.queue.get("R1")?.status, "the seed run must reach passed").toBe("passed")
    }

    // Job retention prunes a finished root's Jobs; the Queue record outlives them.
    await using pruned = await createApp(await withoutJobEvents(journal), ids(100))

    const run = pruned.queue.get("R1")
    expect(run?.status, "a settled passed run must not resurrect as a phantom `running`").toBe("passed")
    expect(run?.finishedAt).toBeDefined()
    expect(pruned.queue.audit().findings.some((item) => item.code === "orphaned-run")).toBe(false)
  })
})
