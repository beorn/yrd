/**
 * @failure `queue recover` shared one eager per-row reader with every other queue path, so a single run record that reader rejects threw out of recovery — the tool whose whole job is repairing exactly that record — leaving the state unrecoverable by construction.
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
/** Past the 15m orphan grace, so a jobless run is genuinely recoverable. */
const LATER = "2026-01-01T02:00:00.000Z"
const RUNTIME = { runner: "local", leaseMs: 60_000 }

/** The exact refusal the eager reader raises over the seeded record. Pinned as a
 * literal because "the tolerant reader accepts it" is only meaningful against
 * the specific read that used to fail. */
const EAGER_REFUSAL = "yrd: queue run 'R1' requested steps out of order"

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function tracing(): Readonly<{ log: ReturnType<typeof createLogger>; events: LogEvent[] }> {
  const events: LogEvent[] = []
  return { log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]), events }
}

function result(events: readonly LogEvent[], action: string) {
  return events.find(
    (event): event is Extract<LogEvent, { kind: "log" }> =>
      event.kind === "log" && event.level === "warn" && event.props?.action === action,
  )
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
    { revision: "first-v1", output: z.object({ first: z.boolean() }).strict() },
  )
  const second = withStep(
    "second",
    (): JobResult<{ second: boolean }> => ({ status: "completed", conclusion: "success", output: { second: true } }),
    { revision: "second-v1", output: z.object({ second: z.boolean() }).strict() },
  )
  const queue = withQueue({ steps: [first, second] as const, batch: false, defaultSteps: ["first", "second"] })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => START, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

type Fact = Readonly<{ id?: string; name: string; data?: unknown }>
type Frame = Readonly<{ events?: readonly Fact[] }>

async function frames(journal: Journal<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected
}

/** Remove one step's Job history from a journal, leaving every other event.
 *
 * A Job's id is its own `job/requested` event id, so dropping that request plus
 * every transition naming it leaves the RUN record fully intact while its step
 * key goes unbound. Applied to a middle step this opens a HOLE in the run's job
 * sequence — the shape the eager reader refuses outright; applied to a run's
 * only step it produces the ordinary jobless orphan `recover` settles. */
async function withoutJobForKey(journal: Journal<unknown>, key: string): Promise<Journal<unknown>> {
  const all = await frames(journal)
  const dropped = new Set<string>()
  for (const value of all) {
    for (const event of (value as Frame).events ?? []) {
      if (event.name !== "job/requested") continue
      if ((event.data as Readonly<{ key?: string }> | undefined)?.key !== key) continue
      if (event.id !== undefined) dropped.add(event.id)
    }
  }
  // Fail loud rather than returning an unmodified journal: a surgery that
  // silently did nothing would make every assertion below vacuously true.
  if (dropped.size !== 1) throw new Error(`expected exactly one requested Job for key '${key}'; got ${dropped.size}`)
  const kept = all.map((value) => {
    const frame = value as Frame
    if (frame.events === undefined) return value
    return {
      ...frame,
      events: frame.events.filter((event) => {
        if (event.name === "job/requested") return event.id === undefined || !dropped.has(event.id)
        if (event.name !== "job/transitioned") return true
        const id = (event.data as Readonly<{ id?: string }> | undefined)?.id
        return id === undefined || !dropped.has(id)
      }),
    }
  })
  return createMemoryJournal(kept)
}

/**
 * The population under test: ONE unreadable record and one repairable one.
 *
 * R1 finished both steps and then lost its step-0 Job history — the record the
 * eager reader rejects. R2 started and lost its only Job — an ordinary jobless
 * orphan that `recover` is supposed to settle. Two rows is the whole point: a
 * reader that vetoes the population repairs neither, and "recover did not throw"
 * proves nothing on its own.
 *
 * `seed` optionally adds the PR1128 shape (a submitted PR with no check request
 * carrying an unsettled admission refusal) to the same journal.
 */
async function seedMixedPopulation(
  seed?: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
): Promise<Journal<unknown>> {
  const journal = createMemoryJournal()
  {
    await using app = await createApp(journal)
    const unreadable = await submitBranch(app, "issue/unreadable-run")
    await app.queue.run({ prs: [unreadable.id], steps: ["first", "second"] }, RUNTIME)
    expect(app.queue.get("R1"), "the seed run must finish so both steps carry a Job").toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(app.queue.get("R1")?.steps.map((step) => step.job !== undefined)).toEqual([true, true])

    const orphan = await submitBranch(app, "issue/jobless-orphan")
    await app.dispatch(app.commands.queue.run, { prs: [orphan.id], steps: ["first", "second"] })
    expect(app.queue.get("R2")?.steps[0]?.job, "the orphan seed must start with a Job").toBeDefined()

    await seed?.(app)
  }
  return await withoutJobForKey(await withoutJobForKey(journal, "queue:R1:0"), "queue:R2:0")
}

/** The same two runs with no surgery at all: the control for every parity claim. */
async function seedValidPopulation(): Promise<Journal<unknown>> {
  const journal = createMemoryJournal()
  {
    await using app = await createApp(journal)
    const passed = await submitBranch(app, "issue/unreadable-run")
    await app.queue.run({ prs: [passed.id], steps: ["first", "second"] }, RUNTIME)
    const orphan = await submitBranch(app, "issue/jobless-orphan")
    await app.dispatch(app.commands.queue.run, { prs: [orphan.id], steps: ["first", "second"] })
  }
  return await withoutJobForKey(journal, "queue:R2:0")
}

describe("the eager reader rejects the record recovery exists to repair", () => {
  it("still refuses the seeded record, so the tolerant reader has something to accept", async () => {
    await using app = await createApp(await seedMixedPopulation(), ids(100))

    // `queue.get` is the ordinary single-record read and stays eager on purpose:
    // asking for ONE run by name must say why that run cannot be read, not
    // quietly answer `undefined`. This is the failure every population walk used
    // to inherit, pinned here as the exact text the quarantine preserves below.
    expect(() => app.queue.get("R1")).toThrow(EAGER_REFUSAL)
  })
})

describe("recovery reads a queue population one record at a time", () => {
  it("repairs every readable row over an unreadable one, instead of being vetoed by it", async () => {
    const { log, events } = tracing()
    await using app = await createApp(await seedMixedPopulation(), ids(100), log)

    await app.queue.recover({ recoveryTime: LATER, reason: "habitant restart" })

    // The repair that used to be unreachable: R2 is the jobless orphan, and
    // nothing but `recover` can settle it.
    const repaired = app.queue.get("R2")
    expect(repaired?.status).toBe("completed")
    expect(repaired?.error?.code).toBe("orphaned-run")
    expect(repaired?.error?.message).toContain("runner disappeared before step 'first' started")
    expect(result(events, "recover-orphan-run-settle")?.props).toMatchObject({
      reason: "orphaned-run",
      runs: ["R2"],
      steps: ["first"],
    })
    log.end()
  })

  it("discloses every quarantined record with what, where and why", async () => {
    const { log, events } = tracing()
    await using app = await createApp(await seedMixedPopulation(), ids(100), log)

    await app.queue.recover({ recoveryTime: LATER, reason: "habitant restart" })

    const quarantine = result(events, "recover-unreadable-run-quarantine")
    expect(quarantine, "a skipped record must be reported, never swallowed").toBeDefined()
    expect(quarantine?.props).toMatchObject({ reason: "unreadable-run", runs: ["R1"] })
    // WHY, verbatim: the reader's own refusal, not a summary of it.
    expect(quarantine?.props?.details).toEqual([EAGER_REFUSAL])
    log.end()
  })

  it("reports one unreadable record once, however many walks meet it", async () => {
    const { log, events } = tracing()
    await using app = await createApp(await seedMixedPopulation(), ids(100), log)

    await app.queue.recover({ recoveryTime: LATER, reason: "habitant restart" })

    // Recovery walks this population four times over (tree, orphaned jobs,
    // jobless runs, stale plans). One bad row is one incident, not four.
    expect(result(events, "recover-unreadable-run-quarantine")?.props?.runs).toEqual(["R1"])
    expect(app.queue.audit().findings.filter((finding) => finding.code === "invalid-run")).toEqual([
      { code: "invalid-run", message: EAGER_REFUSAL, run: "R1" },
    ])
    log.end()
  })

  it("is idempotent over the unreadable row: a second pass repeats the quarantine and settles nothing new", async () => {
    const { log, events } = tracing()
    await using app = await createApp(await seedMixedPopulation(), ids(100), log)

    await app.queue.recover({ recoveryTime: LATER, reason: "first pass" })
    const settled = app.queue.get("R2")
    await app.queue.recover({ recoveryTime: LATER, reason: "second pass" })

    expect(app.queue.get("R2")).toEqual(settled)
    expect(
      events.filter((event) => event.kind === "log" && event.props?.action === "recover-unreadable-run-quarantine")
        .length,
      "the quarantine is a standing condition, so every pass restates it",
    ).toBe(2)
    log.end()
  })
})

describe("the audit walks the same population through the same reader", () => {
  it("emits invalid-run instead of throwing out past the finding written to report it", async () => {
    await using app = await createApp(await seedMixedPopulation(), ids(100))

    // Before the shared reader, `auditQueues` caught this in its own record walk
    // and then called the eager reader again from three later population walks —
    // so `queue audit` died on the very state `invalid-run` exists to name.
    const findings = app.queue.audit({ now: LATER }).findings
    expect(findings).toContainEqual({ code: "invalid-run", message: EAGER_REFUSAL, run: "R1" })
    // The unrelated finding still merges: quarantining R1 must not cost R2 its report.
    expect(findings).toContainEqual(expect.objectContaining({ code: "orphaned-run", run: "R2", step: "first" }))
  })
})

describe("valid state reads exactly as it did before", () => {
  it("quarantines nothing, and recovers the orphan with no quarantine result", async () => {
    const { log, events } = tracing()
    await using app = await createApp(await seedValidPopulation(), ids(100), log)

    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "success" })
    expect(app.queue.audit({ now: LATER }).findings.some((finding) => finding.code === "invalid-run")).toBe(false)

    await app.queue.recover({ recoveryTime: LATER, reason: "habitant restart" })

    expect(app.queue.get("R2")?.error?.code).toBe("orphaned-run")
    expect(app.queue.get("R1"), "a readable finished run is untouched by recovery").toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(result(events, "recover-unreadable-run-quarantine")).toBeUndefined()
    log.end()
  })
})

/**
 * The PR1128 shape itself (2026-08-17, @i/10-merge-queue): `bay submit` queued a
 * carrier and the authored-gitlink refusal was ledgered against it BEFORE any
 * check request existed. `admission-refusal-oracle.test.ts` pins that the AUDIT
 * survives that PR — the throwing comparator is deleted and the ordering is
 * total. What is pinned here is the other end of the incident: `queue recover`,
 * the tool the fleet needed and could not run, executing over that PR while an
 * unreadable run record stands beside it, and the remedy settlement merge
 * afterwards.
 */
describe("recover reaches the PR1128 shape with an unreadable record in the same population", () => {
  it("runs over a submitted PR with no check request and lets its refusal be settled", async () => {
    const wedged = { id: "", head: "9".repeat(40) }
    const journal = await seedMixedPopulation(async (app) => {
      await app.bays.submit({ branch: "task/pr1128-shape", headSha: wedged.head, base: "main", baseSha: BASE })
      const pr = Object.values(app.state().bays.prs).find((item) => item.branch === "task/pr1128-shape")
      if (pr === undefined) throw new Error("PR was not recorded")
      wedged.id = pr.id
      expect(pr.checkRequests, "the incident's carrier never started required checks").toEqual([])
      await app.queue.recordAdmissionRefusal({
        pr: pr.id,
        code: "authored-gitlink",
        kind: "refusal",
        reason: `PR '${pr.id}' changes generated-only gitlinks [ag]`,
      })
    })
    await using app = await createApp(journal, ids(100))
    expect(app.state().queues.admissionRefusals[wedged.id]).toMatchObject({ code: "authored-gitlink" })

    await app.queue.recover({ recoveryTime: LATER, reason: "habitant restart" })

    await app.queue.settleAdmissionRefusal({
      pr: wedged.id,
      revision: 1,
      headSha: wedged.head,
      disposition: "needs-person",
      reason: "authored gitlink: pin work belongs to an intent, not this carrier",
    })
    expect(app.state().queues.admissionRefusals[wedged.id]).toMatchObject({
      settlement: expect.objectContaining({ disposition: "needs-person" }),
    })
    // And the whole reason recovery had to reach this state at all: the jobless
    // orphan sharing the population got repaired in the same pass.
    expect(app.queue.get("R2")?.error?.code).toBe("orphaned-run")
  })
})
