/**
 * @failure 2026-08-31: two changes `ready`, checks passed, facts standing, at
 *          queue positions 1 and 2. The resident runner composed every ~66s for
 *          over an hour and NEVER minted a run, and produced ZERO rows naming a
 *          cause — an hour of "no merge for 56m" with nothing to read. An
 *          EXPLICIT selector run (`yrd queue run code PR2764 --once`) minted and
 *          merged first try, twice. The hole was a two-exclusion-set skew:
 *          selection excluded `consumed ∪ pendingChecks ∪ authorityGaps` and
 *          then post-filtered on `activeBases`, while the empty-run diagnostic
 *          re-derived eligibility passing only `consumed` — so it saw the very
 *          changes selection had just dropped as "runnable", `rejected` came
 *          back empty, and BOTH of its report branches skipped. A change
 *          silently skipped and a change loudly refused were the same bytes.
 *
 *          THE SPEC (C5(1), ruled): a record-backed ready change must be either
 *          SELECTED or REFUSED BY NAME on every implicit pass. A queue that can
 *          only say "no merge for 56 minutes" while holding two green head
 *          changes has no observable difference between patience and paralysis.
 * @level l2
 * @consumer @yrd/queue selectorless compose, and the habitant runner's log
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withStep, withQueue, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

function ids(): () => string {
  let value = 0
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

/**
 * The incident's own machine: a merge step that never resolves, so the first
 * candidate to reach it holds base `main` forever. `merges` counts arrivals —
 * the test uses it as the `continueAdmissions` gate so exactly ONE run starts
 * per compose pass, which is the resident habitant's own one-per-turn cadence
 * and the only way a SECOND ready change survives the pass unclaimed.
 */
async function createStuckMergeApp(log?: ReturnType<typeof createLogger>) {
  const bayJobs = createBayJobDefs(workspace())
  // `checks` counts admission arrivals, so a test can stop the admission loop
  // after the FIRST turn and leave the change behind it never dispatched.
  let checks = 0
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<{ checked: boolean }> => {
      checks += 1
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
  let merges = 0
  const merge = withMerge(
    (): JobResult<{ commit: string; baseSha: string }> => {
      merges += 1
      return { status: "waiting", token: "merge-pending" }
    },
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  const app = await createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
  return { app, merges: () => merges, checks: () => checks }
}

/**
 * The shape that isolates the pass's OWN exclusions from eligibility: the merge
 * LANDS (so its change becomes `integrated` and leaves the ready population)
 * while a post-merge step never resolves (so the run stays non-terminal and
 * keeps holding base `main`). Whatever is behind it is then eligible on its own
 * merits and held by nothing but this pass — the incident's exact shape,
 * distilled.
 */
async function createStuckPublishApp(log: ReturnType<typeof createLogger>) {
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
  let merges = 0
  const merge = withMerge(
    (): JobResult<{ commit: string; baseSha: string }> => {
      merges += 1
      return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
    },
    { revision: "merge-v1" },
  )
  const publish = withStep(
    "publish",
    (_input: StepExecution): JobResult<{ checked: boolean }> => ({ status: "waiting", token: "publish-pending" }),
    { revision: "publish-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [check, merge, publish] as const, batch: false })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  const app = await createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock: () => "2026-01-01T00:00:00.000Z", log },
  })
  return { app, merges: () => merges }
}

/** A merge that lands, for the positive control: an unheld pass must still mint. */
async function createMergingApp(log: ReturnType<typeof createLogger>) {
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
    (): JobResult<{ commit: string; baseSha: string }> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock: () => "2026-01-01T00:00:00.000Z", log },
  })
}

type SubmissionApp = Readonly<{
  bays: Readonly<{
    submit: (args: { branch: string; headSha: string; base: string; baseSha: string }) => Promise<unknown>
    requestChecks: (args: { pr: string; baseSha: string }) => Promise<unknown>
    prs: () => readonly { id: string; branch: string }[]
  }>
}>

async function submitAndRequestChecks(app: SubmissionApp, branch: string): Promise<string> {
  const digit = (app.bays.prs().length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = app.bays.prs().find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`change for '${branch}' was not recorded`)
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr.id
}

function capture(): { log: ReturnType<typeof createLogger>; events: LogEvent[] } {
  const events: LogEvent[] = []
  return { log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]), events }
}

/** Every change this pass declined to select, keyed by change id. NAMED by the
 * unified accounting — the only row a reader gets, so this is the assertion
 * surface for "refused by name". */
function notSelected(events: readonly LogEvent[]): Map<string, { code: string; codes: string[]; run?: string }> {
  const rows = new Map<string, { code: string; codes: string[]; run?: string }>()
  for (const event of events) {
    if (event.kind !== "log" || event.props?.action !== "compose-implicit-not-selected") continue
    const props = event.props as { pr: string; code: string; codes: string[]; run?: string }
    rows.set(props.pr, { code: props.code, codes: props.codes, ...(props.run === undefined ? {} : { run: props.run }) })
  }
  return rows
}

describe("C5(1) — an implicit pass SELECTS a ready change or REFUSES it BY NAME", () => {
  it("names both ready head changes when the pass mints nothing — the 2026-08-31 acceptance scenario", async () => {
    const { log, events } = capture()
    const { app, merges } = await createStuckMergeApp(log)
    await using scoped = app
    const first = await submitAndRequestChecks(scoped, "issue/head-of-line")
    const second = await submitAndRequestChecks(scoped, "issue/right-behind-it")

    // Pass 1 — one run starts and hangs at merge, exactly as on 2026-08-31.
    // `continueAdmissions` flips once a candidate reaches merge, so the second
    // partition never starts: the resident habitant's own one-per-turn cadence.
    await scoped.queue.run({}, { ...runtime, continueAdmissions: () => merges() === 0 })
    expect(merges()).toBe(1)

    // Both changes are still record-backed and un-integrated: this is the
    // "two green head changes, positions 1 and 2" state, not a merged queue.
    expect(scoped.bays.pr(first)?.integratedAt).toBeUndefined()
    expect(scoped.bays.pr(second)?.integratedAt).toBeUndefined()

    // Pass 2 — the pass that produced ZERO rows for an hour.
    events.length = 0
    const runs = await scoped.queue.run({}, runtime)
    expect(runs.filter((run) => run.status === "queued" || run.status === "in_progress").map((run) => run.id)).toEqual(
      [],
    )

    // THE SPEC: neither change was selected, so BOTH carry a named refusal row.
    const rows = notSelected(events)
    expect([...rows.keys()].toSorted()).toEqual([first, second].toSorted())

    // And the rows are actionable, not just present: the head change names the
    // run that consumed it; the one behind it names the base that run holds.
    expect(rows.get(first)?.codes).toContain("claimed")
    expect(rows.get(second)?.codes).toContain("queue-base-active")
    expect(rows.get(second)?.run).toMatch(/^R/u)

    // CONTROL: the row is not a blanket "something is wrong" — it carries the
    // remedy, so an operator acts without a second lookup.
    const row = events.find(
      (event) =>
        event.kind === "log" && event.props?.action === "compose-implicit-not-selected" && event.props.pr === second,
    )
    expect(row?.kind === "log" ? row.props?.remedy : undefined).toContain("settles")
  })

  /**
   * `checks-pending` read `this pass's admission phase left its required checks
   * unsettled, so it owns the change for this tick` for members whose checks had
   * never been dispatched at all — four of them at 08:05:58 on 2026-09-02
   * (PR2909, PR3147, PR3161, PR2749) while batch 1 was held by PR3221. "Left
   * unsettled" describes an admission phase that ran and did not finish, which
   * is the opposite of what happened.
   */
  it("says checks have NOT STARTED, and names the batch holder, when the pass never dispatched them", async () => {
    const { log, events } = capture()
    const { app, merges } = await createStuckMergeApp(log)
    await using scoped = app
    await submitAndRequestChecks(scoped, "issue/head-of-line")

    // Pass 1 takes the batch: its merge hangs, so the run holds base 'main'.
    await scoped.queue.run({}, { ...runtime, continueAdmissions: () => merges() === 0 })
    expect(merges()).toBe(1)

    // The change that arrives with the batch already held. Its checks are
    // REQUESTED and nothing has dispatched them — the live shape at 08:05:58.
    const behind = await submitAndRequestChecks(scoped, "issue/right-behind-it")
    expect(scoped.queue.eligibility(behind).checks.status).toBe("queued")

    events.length = 0
    // Admissions stop before this pass dispatches anything, so the change is
    // considered and held without its checks ever starting.
    await scoped.queue.run({}, { ...runtime, continueAdmissions: () => false })
    expect(scoped.queue.eligibility(behind).checks.status, "still never started").toBe("queued")

    const row = events.find(
      (event) =>
        event.kind === "log" && event.props?.action === "compose-implicit-not-selected" && event.props.pr === behind,
    )
    const message = row?.kind === "log" ? row.message : undefined
    const codes = (row?.kind === "log" ? row.props?.codes : undefined) as readonly string[] | undefined
    expect(codes, "the change carries a checks-pending hold").toContain("checks-pending")
    // The reasons are the row's own prose — that is the only text a reader gets.
    expect(message).toContain("its required checks have not started")
    expect(message).toMatch(/the batch for base 'main' is held by run 'R\d+' \(checks-pending\)/u)
    expect(message, "never the phase-ran wording").not.toContain("left its required checks unsettled")
  })

  it("reports the zero-event run as no-selected-prs when every considered change is eligible and none runs", async () => {
    // The exact branch that did not exist. `rejected` is empty (the one change
    // considered IS runnable) and `decisions` is non-empty (something WAS
    // considered), so the old `no-runnable-prs` / `no-submitted-prs` pair BOTH
    // skipped and the pass reported nothing at all — an hour of "no merge" with
    // zero rows naming a cause.
    const { log, events } = capture()
    const { app, merges } = await createStuckPublishApp(log)
    await using scoped = app
    await submitAndRequestChecks(scoped, "issue/lands-then-hangs")
    const behind = await submitAndRequestChecks(scoped, "issue/green-and-waiting")

    await scoped.queue.run({}, { ...runtime, continueAdmissions: () => merges() === 0 })
    expect(merges()).toBe(1)
    // CONTROL for the fixture, not for the fix: the base holder really has left
    // the ready population, and the change behind it really is runnable. Without
    // both, the assertion below would pass through an older branch.
    expect(scoped.queue.eligibility(behind).runnable).toBe(true)
    expect(scoped.queue.eligibility(behind).reason).toBeUndefined()

    events.length = 0
    await scoped.queue.run({}, runtime)

    const zero = events.find((event) => event.kind === "log" && event.props?.action === "queue-run-no-selected-prs")
    expect(zero).toBeDefined()
    expect(zero?.kind === "log" ? zero.level : undefined).toBe("warn")
    expect(zero?.props).toMatchObject({
      kind: "no-selected-prs",
      reason: "every considered PR was held back by this pass's own exclusions",
      selectedSteps: ["check", "merge", "publish"],
    })
    const considered = (zero?.kind === "log" ? zero.props?.considered : undefined) as
      | readonly { pr: string; code: string; reason: string }[]
      | undefined
    expect(considered?.map((entry) => entry.pr)).toEqual([behind])
    expect(considered?.[0]?.code).toBe("queue-base-active")
    // The row carries the remedy, so the zero-event line stands alone.
    expect(considered?.[0]?.reason).toContain("batchSize serializes one candidate per base")

    // And the per-change row fired too: the zero-event value and the log row are
    // the same accounting, never two derivations that can disagree.
    expect([...notSelected(events).keys()]).toEqual([behind])

    // CONTROL: the two older shapes did NOT fire — this is a third branch, not
    // a rename of one of them.
    expect(events.some((event) => event.kind === "log" && event.props?.action === "queue-run-no-runnable-prs")).toBe(
      false,
    )
    expect(events.some((event) => event.kind === "log" && event.props?.action === "queue-run-no-submitted-prs")).toBe(
      false,
    )
  })

  it("stays silent about a change it SELECTS — a mint is not a refusal", async () => {
    // The other half of the spec, and the guard against a fix that just logs
    // everything: a change that runs earns no row.
    const { log, events } = capture()
    await using app = await createMergingApp(log)
    const merged = await submitAndRequestChecks(app, "issue/lands-cleanly")

    await app.queue.run({}, runtime)

    expect(app.bays.pr(merged)?.integratedAt).toBeDefined()
    expect([...notSelected(events).keys()]).toEqual([])
    // And no zero-event line either: the pass really did work, it did not
    // merely stay quiet about holding back.
    expect(events.some((event) => event.kind === "log" && event.props?.action === "queue-run-no-selected-prs")).toBe(
      false,
    )
  })
})
