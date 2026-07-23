/**
 * @failure A requested Job stranded under a terminal (or absent) queue run is invisible to `queue audit` ("audit clean" prints over it) and `queue recover` never settles it, so a state upgrade leaves it orphaned forever.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withStep, withQueue } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({ status: "passed", output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE } }),
    refresh: (input) => ({
      status: "passed",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    deprovision: () => ({ status: "passed", output: {} }),
  }
}

async function createApp(journal = createMemoryJournal(), id: () => string = ids(), log?: ReturnType<typeof createLogger>) {
  const bayJobs = createBayJobDefs(workspace())
  const first = withStep(
    "first",
    (): JobResult<{ first: boolean }> => ({ status: "passed", output: { first: true } }),
    { revision: "first-v1", output: z.object({ first: z.boolean() }).strict() },
  )
  const queue = withQueue({ steps: [first] as const, batch: false, defaultSteps: ["first"] })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => "2026-01-01T00:00:00.000Z", ...(log === undefined ? {} : { log }) },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

/** Seed R1 with a still-requested `first` Job, then cancel the RUN via the
 * low-level command — which marks R1 terminal (canceled) but does NOT terminalize
 * its pending Job. That leftover requested Job is the orphan a state upgrade
 * strands. */
async function seedOrphan(app: Awaited<ReturnType<typeof createApp>>) {
  const pr = await submitBranch(app, "issue/orphaned-requested")
  await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first"] })
  const job = app.queue.get("R1")?.steps[0]?.job
  if (job === undefined) throw new Error("expected requested first step")
  await app.dispatch(app.commands.queue.cancelRun, { run: "R1", by: "tester", reason: "seed orphan" })
  // The run is terminal (canceled) but the low-level cancelRun command does NOT
  // terminalize the pending Job — that is exactly the strand.
  expect(app.queue.get("R1")?.status).toBe("canceled")
  expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("requested")
  return job.id
}

describe("recover orphan hygiene — a stranded requested Job is flagged and settled", () => {
  it("audit flags an orphaned requested job under a terminal run", async () => {
    await using app = await createApp()
    await seedOrphan(app)

    const finding = app.queue.audit().findings.find((f) => f.code === "orphaned-requested-job")
    expect(finding, "audit must flag the orphaned requested job (not print 'clean')").toBeDefined()
    expect(finding?.run).toBe("R1")
    expect(finding?.message).toContain("terminal")
  })

  it("recover settles the orphaned requested job with a loud receipt and clears the audit finding", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp(createMemoryJournal(), ids(), log)
    const jobId = await seedOrphan(app)

    // Precondition: the orphan is live before recovery.
    expect(app.state().jobs.byId[jobId]?.status).toBe("requested")
    expect(app.queue.audit().findings.some((f) => f.code === "orphaned-requested-job")).toBe(true)

    await app.queue.recover({ recoveryTime: "2026-01-01T00:05:00.000Z", reason: "orphan-hygiene test" })

    // The Job is settled (canceled) and the audit no longer flags it.
    expect(app.state().jobs.byId[jobId]?.status).toBe("canceled")
    expect(app.queue.audit().findings.some((f) => f.code === "orphaned-requested-job")).toBe(false)

    const receipt = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "recover-orphan-settle",
    )
    expect(receipt, "recover must emit a loud structured receipt for settled orphans").toBeDefined()
    expect(receipt?.props).toMatchObject({ reason: "orphaned-requested-job", jobs: [jobId], runs: ["R1"] })
    log.end()
  })
})
