/**
 * @failure A PR refused at ADMISSION never becomes a run record, so `auditQueues` (which walks run records only) is structurally blind to a head-of-line refusal loop — `queue audit` returned `findings: []` through a 5h46m block while every compose cycle logged a loggily-only `compose-candidate-skip`.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withStep, withQueue, Queues, type CandidatePreparer, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

/** The wedge's wall clock: the test moves it, so `firstAt`/`lastAt`/`blockedMs`
 * are exact rather than whatever the drain happened to append. */
function movableClock(initial: string) {
  let now = initial
  return {
    read: () => now,
    set: (at: string) => {
      now = at
    },
  }
}

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

/** Check-only plan: every configured step is admission work, so a refusal here
 * lands in `dispatchAdmissions` — the path that never mints a run record. */
function checkOnlyPlugin(prepareCandidate: CandidatePreparer) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<{ checked: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  return withQueue({ steps: [check] as const, batch: false, defaultSteps: ["check"], prepareCandidate })
}

async function createApp(
  prepareCandidate: CandidatePreparer,
  clock: () => string,
  journal: Journal<unknown> = createMemoryJournal(),
  id: () => string = ids(),
  log?: ReturnType<typeof createLogger>,
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = checkOnlyPlugin(prepareCandidate)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

async function submitAndRequestChecks(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr
}

/** A Candidate preparer that refuses for one PR forever — the shape of every
 * real head-of-line admission wedge (authored gitlink, stale recut certificate,
 * unresolvable base): typed `refusal`, so the selectorless drain survives it and
 * retries the identical PR on the next cycle, forever. */
function refuseForever(blocked: () => string): CandidatePreparer {
  return (input) => {
    if (input.prs.some((pr) => pr.id === blocked())) {
      throw createFailure({
        kind: "refusal",
        code: "authored-gitlink",
        message: `yrd: PR '${blocked()}' authors a gitlink bump; recut it before admission`,
      })
    }
    const { prs: _prs, ...candidate } = input
    return { ...candidate, sha: MERGED, ref: `refs/yrd/candidates/${input.id}`, mergeability: "mergeable" }
  }
}

describe("admission refusal oracle — a head-of-line PR refused at admission is visible to queue audit", () => {
  it("counts consecutive admission refusals and names the PR, code, count, and block span", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = ""
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp(
      refuseForever(() => blocked),
      clock.read,
      createMemoryJournal(),
      ids(),
      log,
    )
    const pr = await submitAndRequestChecks(app, "issue/head-of-queue-wedge")
    blocked = pr.id

    // Three compose cycles spread over the real 22395 block window. Every cycle
    // refuses the same PR at admission, so no queue run record ever exists.
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    clock.set("2026-01-01T02:00:00.000Z")
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    clock.set("2026-01-01T05:46:00.000Z")
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // The record walk really is blind: no run record was ever minted, so every
    // one of `auditQueues`' six run-record codes has nothing to walk.
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(
      events.filter(
        (event): event is Extract<LogEvent, { kind: "log" }> =>
          event.kind === "log" && event.props?.action === "compose-candidate-skip" && event.props?.pr === pr.id,
      ),
    ).toHaveLength(3)

    expect(app.queue.audit().findings).toContainEqual({
      code: "admission-refusal-loop",
      message: expect.stringContaining(`PR '${pr.id}'`),
      pr: pr.id,
      refusal: "authored-gitlink",
      count: 3,
      since: "2026-01-01T00:00:00.000Z",
      blockedMs: 5 * 3_600_000 + 46 * 60_000,
    })
    const finding = app.queue.audit().findings.find((item) => item.code === "admission-refusal-loop")
    expect(finding?.message).toBe(
      `PR '${pr.id}' at the head of the admission queue was refused 3 consecutive times over 5h46m ` +
        `(since 2026-01-01T00:00:00.000Z) without ever being admitted; latest refusal 'authored-gitlink': ` +
        `yrd: PR '${pr.id}' authors a gitlink bump; recut it before admission`,
    )
    log.end()
  })

  it("stays quiet below the loop threshold and survives replay from the journal", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const journal = createMemoryJournal()
    const id = ids()
    let blocked = ""
    {
      await using app = await createApp(
        refuseForever(() => blocked),
        clock.read,
        journal,
        id,
      )
      const pr = await submitAndRequestChecks(app, "issue/head-of-queue-wedge")
      blocked = pr.id

      await app.queue.run({}, runtime)
      expect(app.queue.audit().findings).toEqual([])
      clock.set("2026-01-01T00:10:00.000Z")
      await app.queue.run({}, runtime)
      expect(app.queue.audit().findings).toEqual([])
      clock.set("2026-01-01T00:20:00.000Z")
      await app.queue.run({}, runtime)
      expect(app.queue.audit().findings).toContainEqual(
        expect.objectContaining({ code: "admission-refusal-loop", count: 3 }),
      )
    }

    // A fresh process replaying the same journal sees the same wedge: the ledger
    // is journal-derived state, not in-process bookkeeping.
    await using replayed = await createApp(
      refuseForever(() => blocked),
      clock.read,
      journal,
      id,
    )
    expect(replayed.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-loop",
        pr: "PR1",
        refusal: "authored-gitlink",
        count: 3,
        since: "2026-01-01T00:00:00.000Z",
        blockedMs: 20 * 60_000,
      }),
    )
  })

  it("clears the streak when the PR is finally admitted", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = ""
    await using app = await createApp(
      refuseForever(() => blocked),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/transient-wedge")
    blocked = pr.id

    for (const at of ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z", "2026-01-01T00:10:00.000Z"]) {
      clock.set(at)
      await app.queue.run({}, runtime)
    }
    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({ code: "admission-refusal-loop", count: 3 }),
    )

    blocked = ""
    clock.set("2026-01-01T00:15:00.000Z")
    await app.queue.run({}, runtime)
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(app.queue.eligibility(pr.id)).toMatchObject({ checks: { status: "passed", run: "R1" } })
    expect(app.state().queues.admissionRefusals).toEqual({})
    expect(app.queue.audit().findings).toEqual([])
  })
})
