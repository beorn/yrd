/**
 * @failure A FAILED bisectable batch whose recorded plan drifted from the installed catalog can never isolate — the isolate command refuses every compose cycle forever (a permanent zombie), invisible to audit and never settled by recover.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withStep, withQueue, Queues, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

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

/** A single check-only step (caller-tunable revision), batch size 2. The check
 * FAILS for a >1-PR batch — forcing a bisection — and passes a lone PR. */
function checkBatchPlugin(checkRevision: string) {
  const check = withStep(
    "check",
    (input: StepExecution): JobResult<{ checked: boolean }> =>
      input.prs.length > 1
        ? { status: "failed", error: { code: "check-failed", message: "red batch" } }
        : { status: "passed", output: { checked: true } },
    { revision: checkRevision, output: CheckResultSchema },
  )
  return withQueue({ steps: [check] as const, batch: 2, defaultSteps: ["check"] })
}

async function createApp(checkRevision: string, journal: Journal<unknown> = createMemoryJournal(), id: () => string = ids(), log?: ReturnType<typeof createLogger>) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = checkBatchPlugin(checkRevision)
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

/** Seed R1 = a FAILED 2-PR batch (bisectable) whose check step was NOT yet
 * isolated, then reopen under a bumped check revision so its recorded plan has
 * drifted — the un-isolable stale-plan zombie. */
async function seedStalePlanBatch(journal: Journal<unknown>, id: () => string, log?: ReturnType<typeof createLogger>) {
  {
    await using app = await createApp("check-v1", journal, id)
    const a = await submitBranch(app, "issue/batch-a")
    const b = await submitBranch(app, "issue/batch-b")
    await app.dispatch(app.commands.queue.run, { prs: [a.id, b.id], steps: ["check"] })
    const checkJob = app.queue.get("R1")?.steps[0]?.job
    if (checkJob === undefined) throw new Error("expected requested batch check")
    await app.jobs.run(checkJob.id, runtime)
    const r1 = app.queue.get("R1")
    // Failed 2-PR batch, no isolation children yet — the bisectable pre-condition.
    expect(r1?.status).toBe("failed")
    expect(r1?.prs.length).toBe(2)
  }
  // Reopen under the drifted revision.
  return createApp("check-v2", journal, id, log)
}

describe("stale-plan retirement — an un-isolable drifted batch is retired, not refused forever", () => {
  it("compose retires the batch with a typed stale-plan release and a loud receipt instead of re-refusing every cycle", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using replayed = await seedStalePlanBatch(journal, id, log)

    // Before: audit flags the un-isolable batch (no more "audit clean" lie).
    expect(replayed.queue.audit().findings.some((f) => f.code === "unisolable-stale-plan")).toBe(true)

    // The selectorless compose survives and retires R1 — it neither throws nor
    // loops forever refusing isolation.
    await expect(replayed.queue.run({}, runtime)).resolves.toBeDefined()

    const r1 = replayed.queue.get("R1")
    expect(r1).toMatchObject({ status: "failed", error: expect.objectContaining({ code: "stale-plan" }) })

    const retire = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "compose-stale-plan-retire",
    )
    expect(retire, "expected a compose-stale-plan-retire receipt").toBeDefined()
    expect(retire?.props).toMatchObject({ run: "R1", code: "stale-plan" })

    // After retirement the audit is clean AND a second compose cycle does NOT
    // re-touch R1 (authority released → excluded from the resumable set).
    expect(replayed.queue.audit().findings.some((f) => f.code === "unisolable-stale-plan")).toBe(false)
    const before = events.filter((e) => e.kind === "log" && e.props?.action === "compose-stale-plan-retire").length
    await replayed.queue.run({}, runtime)
    const after = events.filter((e) => e.kind === "log" && e.props?.action === "compose-stale-plan-retire").length
    expect(after).toBe(before)
    log.end()
  })

  it("recover settles the un-isolable batch with a loud receipt and clears the audit finding", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using replayed = await seedStalePlanBatch(journal, id, log)

    expect(replayed.queue.audit().findings.some((f) => f.code === "unisolable-stale-plan")).toBe(true)

    await replayed.queue.recover({ recoveryTime: "2026-01-01T00:05:00.000Z", reason: "stale-plan hygiene test" })

    expect(replayed.queue.get("R1")).toMatchObject({ status: "failed", error: expect.objectContaining({ code: "stale-plan" }) })
    expect(replayed.queue.audit().findings.some((f) => f.code === "unisolable-stale-plan")).toBe(false)

    const receipt = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "recover-stale-plan-retire",
    )
    expect(receipt, "expected a recover-stale-plan-retire receipt").toBeDefined()
    expect(receipt?.props).toMatchObject({ reason: "stale-plan", runs: ["R1"] })
    log.end()
  })

  it("still fails loud on a direct isolate of the un-isolable batch — only retirement settles it", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    await using replayed = await seedStalePlanBatch(journal, id)

    // A direct isolate dispatch is fail-loud: it raises the TYPED stale-plan
    // refusal (not a silent skip, not an auto-retire) so an operator poking the
    // batch sees exactly why it cannot bisect.
    await expect(replayed.dispatch(replayed.commands.queue.isolate, { run: "R1", part: 0 } as const)).rejects.toThrow(
      "cannot isolate",
    )
    // The failed attempt did NOT retire it — still bisectable and flagged; only an
    // explicit retirement (compose/recover) settles this class.
    expect(replayed.queue.audit().findings.some((f) => f.code === "unisolable-stale-plan")).toBe(true)
    expect(Queues.ids(replayed.state().queues)).toContain("R1")

    // retireStalePlan is idempotent and definitive: it settles once, then no-ops.
    await replayed.dispatch(replayed.commands.queue.retireStalePlan, { run: "R1" })
    expect(replayed.queue.get("R1")).toMatchObject({ status: "failed", error: expect.objectContaining({ code: "stale-plan" }) })
    expect(replayed.queue.audit().findings.some((f) => f.code === "unisolable-stale-plan")).toBe(false)
    const again = await replayed.dispatch(replayed.commands.queue.retireStalePlan, { run: "R1" })
    expect(again.events).toEqual([])
  })
})
