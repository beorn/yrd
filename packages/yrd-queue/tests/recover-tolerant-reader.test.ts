/**
 * @failure `queue recover` shared one eager per-row reader with every other queue path, so a single run record that reader rejects threw out of recovery — the tool whose whole job is repairing exactly that record — leaving the state unrecoverable by construction.
 *
 * S7 conversion note (branch-is-change, @i/10 22991): every member seeded here
 * is DERIVED — a branch plus its standing submit fact — because `bays.submit`
 * refuses `record-mint-retired` and there is no record store to mint into. The
 * subject is unchanged: the reader walks QUEUE RUN records, and a run record is
 * as damageable as it ever was. What the derived lane changes is the PR1128
 * fixture below, where "a submitted carrier with no check request" stops being
 * an asserted precondition and becomes the structural shape of a derived member.
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
import { Queues } from "../src/model.ts"

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
 * branch — and this file seeds two and three members into a single app. */
const mints = new WeakMap<object, PrNumberMint>()
function mintFor(app: object): PrNumberMint {
  const existing = mints.get(app)
  if (existing !== undefined) return existing
  const created = volatilePrNumberMint()
  mints.set(app, created)
  return created
}

/** The branch's standing submit fact IS the delivery (S7 branch-is-change);
 * the member the queue would compose from it is derived here so each `queue.run`
 * below can name exactly the members its population needs. */
async function submitBranch(
  app: Awaited<ReturnType<typeof createApp>>,
  branch: string,
  sha?: string,
): Promise<DerivedRunMember> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: sha ?? digit.repeat(40), base: "main" })
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: mintFor(app),
    branch,
  })
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
    // `prs: []` beside a non-empty `derived` selects exactly those derived
    // members — the post-S7 spelling of naming one member explicitly.
    await app.queue.run({ prs: [], derived: [unreadable], steps: ["first", "second"] }, RUNTIME)
    expect(app.queue.get("R1"), "the seed run must finish so both steps carry a Job").toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(app.queue.get("R1")?.steps.map((step) => step.job !== undefined)).toEqual([true, true])

    const orphan = await submitBranch(app, "issue/jobless-orphan")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [orphan], steps: ["first", "second"] })
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
    await app.queue.run({ prs: [], derived: [passed], steps: ["first", "second"] }, RUNTIME)
    const orphan = await submitBranch(app, "issue/jobless-orphan")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [orphan], steps: ["first", "second"] })
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
 * survives that change — the throwing comparator is deleted and the ordering is
 * total. What is pinned here is the other end of the incident: `queue recover`,
 * the tool the fleet needed and could not run, executing over that change while an
 * unreadable run record stands beside it, and the remedy settlement merge
 * afterwards.
 *
 * S7: the wedged carrier is now a DERIVED member — a branch with a standing
 * submit fact that no run has picked up. That is the same population position
 * the incident's carrier held, reached without the record store, and "no check
 * request existed" stops being a record field and becomes the member's shape.
 */
describe("recover reaches the PR1128 shape with an unreadable record in the same population", () => {
  it("runs over a submitted PR with no check request and lets its refusal be settled", async () => {
    const wedged = { id: "", head: "9".repeat(40) }
    const journal = await seedMixedPopulation(async (app) => {
      // The incident's carrier never started required checks. Post-S7 that is
      // not an assertable field but the shape itself: a branch with a standing
      // submit fact and no run is a member composed from that fact alone —
      // there is no record to hang a check request on. The refusal below is
      // therefore ledgered against a member that has never been through a
      // check, exactly as PR1128 was.
      const member = await submitBranch(app, "task/pr1128-shape", wedged.head)
      wedged.id = member.id
      expect(
        Queues.values(app.state().queues).filter((run) => run.prs.some((pr) => pr.id === member.id)),
        "the incident's carrier never started required checks — no run carries it",
      ).toEqual([])
      await app.queue.recordAdmissionRefusal({
        pr: member.id,
        code: "authored-gitlink",
        kind: "refusal",
        reason: `change '${member.id}' changes generated-only gitlinks [ag]`,
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
