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
import {
  candidateRefFor,
  withMerge,
  withStep,
  withQueue,
  Queues,
  DEFAULT_QUEUE_PROGRESS_POLICY,
  type CandidatePreparer,
  type QueueProgressPolicy,
  type StepExecution,
} from "@yrd/queue"

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
function checkOnlyPlugin(
  prepareCandidate: CandidatePreparer,
  /** Derived from the shipped default so a new policy field cannot silently
   * diverge here — this literal previously carried its own copy of every knob. */
  progress: QueueProgressPolicy = { ...DEFAULT_QUEUE_PROGRESS_POLICY, refusalCount: 3 },
  needsPersonOwner?: string,
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<{ checked: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  return withQueue({
    steps: [check] as const,
    batch: false,
    defaultSteps: ["check"],
    prepareCandidate,
    progress,
    ...(needsPersonOwner === undefined ? {} : { needsPersonOwner }),
  })
}

async function createApp(
  prepareCandidate: CandidatePreparer,
  clock: () => string,
  journal: Journal<unknown> = createMemoryJournal(),
  id: () => string = ids(),
  log?: ReturnType<typeof createLogger>,
  progress?: QueueProgressPolicy,
  needsPersonOwner?: string,
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = checkOnlyPlugin(prepareCandidate, progress, needsPersonOwner)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

async function createDeliveryApp(clock: () => string, waitForMerge = false, defaultSteps?: readonly string[]) {
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
        : {
            status: "completed",
            conclusion: "success",
            output: { commit: MERGED, baseSha: BASE },
          },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    progress: { ...DEFAULT_QUEUE_PROGRESS_POLICY, refusalCount: 3 },
    ...(defaultSteps === undefined ? {} : { defaultSteps }),
  })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock, log: createLogger("test", [{ level: "silent" }]) },
  })
}

type SubmissionApp = Readonly<{
  bays: Pick<Awaited<ReturnType<typeof createApp>>["bays"], "submit" | "requestChecks" | "prs">
}>

async function submitAndRequestChecks(app: SubmissionApp, branch: string) {
  const digit = (app.bays.prs().length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = app.bays.prs().find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr
}

/**
 * Admission attempts inside the current progress window. The stall predicate
 * asks whether the queue has been TRIED and still not moved, not merely whether
 * it has waited, so any fixture that probes the stalled finding has to supply
 * the attempts a real stalled queue accumulates. Timing matters: the window
 * restarts at the last landing, so attempts must be issued on the clock the
 * assertion is about.
 */
async function requestChecksTimes(app: SubmissionApp, pr: string, times: number): Promise<void> {
  for (let index = 0; index < times; index++) await app.bays.requestChecks({ pr, baseSha: BASE })
}

type JournalFact = Readonly<{ name: string; data?: unknown }>
type JournalFrame = Readonly<{ events?: readonly JournalFact[] }>

async function journalFrames(journal: Journal<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected
}

/** Reproduce `pr/pushed`/`pr/submitted` facts as journals wrote them before
 * revision identity existed: no `submitter` (and, on `pr/pushed`, no
 * `changeId` — the legacy replay schema is strict, so a fact carrying
 * `changeId` but no `submitter` matches no shape any journal holds, same
 * surgery as orphaned-run-recovery.test.ts's `withoutPushedIdentity`).
 * `bays.submit({branch, ...})` mints BOTH facts for one revision and each
 * independently carries `submitter` — stripping only `pr/pushed` leaves
 * `pr/submitted`'s copy standing in for it. */
async function withoutPushedIdentity(journal: Journal<unknown>): Promise<Journal<unknown>> {
  const kept = (await journalFrames(journal)).map((value) => {
    const frame = value as JournalFrame
    if (frame.events === undefined) return value
    return {
      ...frame,
      events: frame.events.map((event) => {
        if (event.name === "pr/pushed") {
          const { submitter: _submitter, changeId: _changeId, ...data } = event.data as Record<string, unknown>
          return { ...event, data }
        }
        if (event.name === "pr/submitted") {
          const { submitter: _submitter, ...data } = event.data as Record<string, unknown>
          return { ...event, data }
        }
        return event
      }),
    }
  })
  return createMemoryJournal(kept)
}

/** A Candidate preparer that refuses for one PR forever — the shape of every
 * real head-of-line admission wedge (authored gitlink, stale recut certificate,
 * unresolvable base): typed `refusal`, so the selectorless drain survives it and
 * retries the identical PR on the next cycle, forever. */
function refuseForever(
  blocked: () => string,
  failure: Readonly<{ code: string; message: (pr: string) => string }> = {
    code: "authored-gitlink",
    message: (pr) => `yrd: PR '${pr}' authors a gitlink bump`,
  },
): CandidatePreparer {
  return (input) => {
    if (input.prs.some((pr) => pr.id === blocked())) {
      throw createFailure({ kind: "refusal", code: failure.code, message: failure.message(blocked()) })
    }
    const { prs: _prs, ...candidate } = input
    return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
  }
}

/** The resident's own drain shape: `continueAdmissions` is how a drain signal
 * interrupts the loop, and it is also what makes admissions one PR per turn —
 * the only shape in which a refused head can hold the line. */
const RESIDENT = { ...runtime, continueAdmissions: () => true }

describe("admission refusal oracle — a head-of-line PR refused at admission is visible to queue audit", () => {
  it("records a refusal reported by an external queue preparation robot", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/external-refusal")
    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "submodule-pin-unpublished",
      kind: "refusal",
      reason: "the refreshed revision contains an unpublished submodule pin",
    })

    expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({
      pr: pr.id,
      revision: 1,
      headSha: HEAD,
      code: "submodule-pin-unpublished",
      kind: "refusal",
      reason: "the refreshed revision contains an unpublished submodule pin",
      count: 1,
      sameCodeCount: 1,
    })
  })

  it("parks a structurally permanent refusal as queue state on its first occurrence", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/permanent-head-refusal")

    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "recut-gitlink-conflict",
      kind: "refusal",
      reason: "two fixed gitlink commits are non-ancestral",
    })

    expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({
      code: "recut-gitlink-conflict",
      count: 1,
      settlement: {
        disposition: "needs-person",
        reason: "two fixed gitlink commits are non-ancestral",
      },
    })
    expect(app.queue.eligibility(pr.id).reason).toMatchObject({ code: "admission-refused" })
    // Parked at admission, never wedged — but NOT silent: settling a refusal
    // stops the RETRY, it must not also stop the REPORT
    // (@i/10-merge-queue/22918-needs-person-unowned). The finding names the
    // owner explicitly, even unconfigured — never an omitted field.
    expect(app.queue.audit().findings).toContainEqual({
      code: "admission-refusal-needs-person",
      message:
        `merge request '${pr.id}' needs a person: its entry-check failure 'recut-gitlink-conflict' has no ` +
        "mechanical remedy — two fixed gitlink commits are non-ancestral. " +
        "Owner: unowned — no needsPerson.owner is configured in .yrd.yml.",
      pr: pr.id,
      specimen: `pr:${pr.id}:needs-person`,
      refusal: "recut-gitlink-conflict",
      since: "2026-01-01T00:00:00.000Z",
      owner: "unowned — no needsPerson.owner is configured in .yrd.yml",
    })
  })

  it("names a configured needsPersonOwner on a needs-person finding instead of the unowned default", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
      createMemoryJournal(),
      ids(),
      undefined,
      undefined,
      "@ci",
    )
    const pr = await submitAndRequestChecks(app, "issue/configured-owner")

    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "recut-gitlink-conflict",
      kind: "refusal",
      reason: "two fixed gitlink commits are non-ancestral",
    })

    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-needs-person",
        pr: pr.id,
        owner: "@ci",
        message: expect.stringContaining("Owner: @ci."),
      }),
    )
  })

  it("falls back to the unowned default when needsPersonOwner is configured as blank", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
      createMemoryJournal(),
      ids(),
      undefined,
      undefined,
      "   ",
    )
    const pr = await submitAndRequestChecks(app, "issue/blank-configured-owner")

    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "recut-gitlink-conflict",
      kind: "refusal",
      reason: "two fixed gitlink commits are non-ancestral",
    })

    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-needs-person",
        pr: pr.id,
        owner: "unowned — no needsPerson.owner is configured in .yrd.yml",
      }),
    )
  })

  it("keeps the needs-person finding honest when the revision records no submitter", async () => {
    // `owner` is repository CONFIG, never journal identity — so a revision
    // with no recorded submitter anywhere in its history must still produce
    // the finding, still carrying the explicit unowned default: no invented
    // name resurrected from push identity, no crash on the missing fields
    // (@i/10-merge-queue/22918-needs-person-unowned), same principle as the
    // draft-stranded precedent (orphaned-run-recovery.test.ts).
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const seeded = createMemoryJournal()
    {
      await using seed = await createApp(refuseForever(() => ""), clock.read, seeded)
      const pr = await submitAndRequestChecks(seed, "issue/unattributed-permanent-refusal")
      await seed.queue.recordAdmissionRefusal({
        pr: pr.id,
        code: "recut-gitlink-conflict",
        kind: "refusal",
        reason: "two fixed gitlink commits are non-ancestral",
      })
    }
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
      await withoutPushedIdentity(seeded),
      ids(100),
    )
    const revision = Object.values(app.state().bays.prs)[0]?.revs.at(-1)
    expect(revision?.submitter, "the surgery must leave a genuinely unattributed revision").toBeUndefined()

    const finding = app.queue.audit().findings.find((candidate) => candidate.code === "admission-refusal-needs-person")
    expect(finding, "an unattributed settlement still needs a person and must still flag").toBeDefined()
    expect(finding?.owner, "the empty owner slot is shown explicitly, never invented from identity").toBe(
      "unowned — no needsPerson.owner is configured in .yrd.yml",
    )
    expect(finding?.submitter, "no recorded identity means no field, never a plausible-looking owner").toBeUndefined()
    expect(finding?.message).toContain("Owner: unowned — no needsPerson.owner is configured in .yrd.yml.")
    expect(finding?.message).not.toContain("undefined")
  })

  it("parks a deterministically stale recut base on its FIRST refusal and drains the PR behind it", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const blocked = { id: "" }
    const DIVERGED = "d".repeat(40)
    await using app = await createApp(
      refuseForever(() => blocked.id, {
        code: "recut-base-diverged",
        message: (pr) =>
          `yrd: PR '${pr}' certifies base '${DIVERGED}', but the authoritative candidate base is '${BASE}'`,
      }),
      clock.read,
    )
    const head = await submitAndRequestChecks(app, "issue/stale-recut-base")
    blocked.id = head.id
    const behind = await submitAndRequestChecks(app, "issue/ready-behind-the-stale-head")

    await app.queue.run({}, RESIDENT)

    const refusal = app.state().queues.admissionRefusals[head.id]
    expect(refusal).toMatchObject({
      code: "recut-base-diverged",
      count: 1,
      settlement: { disposition: "needs-person" },
    })
    // The result carries the discriminating fact: which base the revision
    // certifies and which one the queue actually holds.
    expect(refusal?.settlement?.reason).toContain(DIVERGED)
    expect(refusal?.settlement?.reason).toContain(BASE)
    expect(app.queue.eligibility(head.id).reason).toMatchObject({ code: "admission-refused" })
    // Parked at admission, not wedged: it no longer blocks the PR behind it —
    // but it is still visible and owned, never silently dropped
    // (@i/10-merge-queue/22918-needs-person-unowned).
    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-needs-person",
        message: expect.stringContaining(DIVERGED),
        pr: head.id,
        specimen: `pr:${head.id}:needs-person`,
        refusal: "recut-base-diverged",
        owner: "unowned — no needsPerson.owner is configured in .yrd.yml",
      }),
    )
    expect(app.queue.eligibility(behind.id).checks.status).toBe("passed")
  })

  it("keeps an I/O-flavored recut certificate refusal on the ordinary retry threshold", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/unfetched-certified-base")

    // The 2026-07-27 partition specimen: a certificate that could not be READ,
    // refused 106 consecutive cycles and cured by nothing but a retry.
    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "recut-certificate",
      kind: "refusal",
      reason: "the certified base is not present in the candidate repository",
    })

    expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({ code: "recut-certificate", count: 1 })
    expect(app.state().queues.admissionRefusals[pr.id]?.settlement).toBeUndefined()
  })

  it("keeps a recoverable gitlink object gap on the ordinary retry threshold", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/recoverable-gitlink-object-gap")

    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "recut-gitlink-object-missing",
      kind: "refusal",
      reason: "the pinned commit is not present locally; fetch it and retry",
    })

    expect(app.queue.audit().findings).not.toContainEqual(expect.objectContaining({ pr: pr.id }))
  })

  it("does not promote a structurally permanent refusal away from the queue head", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    const head = await submitAndRequestChecks(app, "issue/queue-head")
    const behind = await submitAndRequestChecks(app, "issue/permanent-refusal-behind-head")

    await app.queue.recordAdmissionRefusal({
      pr: behind.id,
      code: "recut-gitlink-conflict",
      kind: "refusal",
      reason: "two fixed gitlink commits are non-ancestral",
    })

    // Parked behind the head — it does not promote itself back into the
    // retry loop — but it is still visible and owned, never silently dropped
    // (@i/10-merge-queue/22918-needs-person-unowned).
    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({ code: "admission-refusal-needs-person", pr: behind.id }),
    )
    expect(app.queue.eligibility(head.id).checks.position).toBe(1)
  })

  it("keeps a passed admission in the no-landing progress population until delivery", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    const pr = await submitAndRequestChecks(app, "issue/admitted-without-landing")
    await requestChecksTimes(app, pr.id, DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks - 1)

    await app.queue.run({}, runtime)
    expect(app.queue.eligibility(pr.id).checks.status).toBe("passed")
    expect(app.bays.pr(pr.id)?.integratedAt).toBeUndefined()
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-progress-stalled",
        specimen: "queue:main",
        count: 1,
        since: "2026-01-01T00:00:00.000Z",
      }),
    )
  })

  it("reports submitted work that never started required checks", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    await app.bays.submit({
      branch: "issue/never-started",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
    })
    const pr = app.bays.prs().find((candidate) => candidate.branch === "issue/never-started")
    if (pr === undefined) throw new Error("submitted PR was not recorded")

    expect(app.bays.checksRequested(pr.id)).toBe(false)
    expect(app.queue.audit({ now: "2026-01-01T00:29:59.999Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-never-started" }),
    )
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual({
      code: "queue-never-started",
      message:
        `Queue 'main' has 1 submitted PR that never started required checks for 30m00s ` +
        `(since 2026-01-01T00:00:00.000Z); head is '${pr.id}'.`,
      resolution: [
        `Start or restart the resident queue runner, then verify it requests required checks for '${pr.id}'.`,
      ],
      pr: pr.id,
      specimen: "queue:main:never-started",
      count: 1,
      since: "2026-01-01T00:00:00.000Z",
      blockedMs: 30 * 60_000,
    })
  })

  it("does not let unrelated landings reset one never-started carrier's readiness clock", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read)
    await app.bays.submit({
      branch: "issue/never-started",
      headSha: HEAD,
      base: "main",
      baseSha: BASE,
    })
    const ignored = app.bays.prs().find((candidate) => candidate.branch === "issue/never-started")
    if (ignored === undefined) throw new Error("submitted PR was not recorded")

    clock.set("2026-01-01T00:20:00.000Z")
    const merged = await submitAndRequestChecks(app, "issue/unrelated-landing")
    await app.queue.run({ prs: [merged.id] }, runtime)
    expect(app.bays.pr(merged.id)?.integratedAt).toBe("2026-01-01T00:20:00.000Z")
    expect(app.bays.pr(ignored.id)?.integratedAt).toBeUndefined()
    expect(app.bays.checksRequested(ignored.id)).toBe(false)

    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-never-started",
        pr: ignored.id,
        since: "2026-01-01T00:00:00.000Z",
        blockedMs: 30 * 60_000,
      }),
    )
  })

  /**
   * Box 2 of @i/10-merge-queue/uptime-is-not-health. The bead's predicate is a
   * CONJUNCTION validated over the whole journal — runner heartbeat fresh AND
   * ready-set non-empty AND no merge request for the window AND at least ten
   * admission checks in it — which fired exactly 3 times, all genuine. The
   * duration test alone fires 37 times, and an alarm that fires 37 times is an
   * alarm somebody mutes.
   *
   * `queueProgressAuditFindings` implements the middle two conjuncts. The CLI
   * composes its result with the resident heartbeat rather than pushing runtime
   * liveness into the queue package. This pins the audit half: ONE admission check is a queue barely
   * tried, not a queue trying and failing, so it must not read as stalled. The
   * count is computable from state today — `PRCheckRequest` already carries `at`
   * — so this needs no new recording, only the predicate.
   *
   * The clocks deliberately stay separate: `QueueAuditOptions` is `{ now?: string }`,
   * and yrd-cli depends on @yrd/queue and not the reverse. The resident status
   * carries both a heartbeat time and a timestamped projection of this audit.
   */
  it("does not call a queue stalled on a single admission check", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    const pr = await submitAndRequestChecks(app, "issue/one-admission-check")

    await app.queue.run({}, runtime)

    expect(app.bays.pr(pr.id)?.checkRequests.length).toBe(1)
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
  })

  /**
   * The CLI shape. `host.ts` passes `config.steps` as `defaultSteps`, and
   * `config.ts` builds that array as `[...checks, "merge"]`, so a real
   * invocation always selects a merge step. Pinned here because the next test
   * pins what happens when it does not, and the pair is only meaningful
   * together.
   */
  it("puts a ready candidate in the progress population under the CLI's own step selection", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true, ["check", "merge"])
    const pr = await submitAndRequestChecks(app, "issue/cli-shaped-selection")
    await requestChecksTimes(app, pr.id, DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks - 1)

    await app.queue.run({}, runtime)

    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled", specimen: "queue:main" }),
    )
  })

  /**
   * `queueProgressQueue` opens with a guard that returns an EMPTY population
   * when the selection carries no merge step, and it says nothing when it does.
   *
   * This matters because the guard reads `state.queues.defaultSteps` — PERSISTED
   * state frozen at queue-install time — and not the config the CLI would
   * compute today. Nothing reconciles the two. A queue installed with a
   * merge-less selection therefore reports a clean audit forever, however long
   * it is blocked, and `selectSteps` does not throw because every named step is
   * still installed.
   *
   * Pinned as the CURRENT behaviour, not endorsed. A queue that cannot merge
   * arguably cannot stall, but a queue whose PERSISTED selection has drifted
   * from its installed steps is exactly the silent-empty class this file's
   * header incident is about, one layer down.
   */
  it("reports nothing at all when the persisted step selection carries no merge step", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true, ["check"])
    const pr = await submitAndRequestChecks(app, "issue/merge-less-selection")
    await requestChecksTimes(app, pr.id, DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks - 1)

    await app.queue.run({}, runtime)

    // Blocked for an hour, twice the default threshold, and silent.
    expect(app.queue.audit({ now: "2026-01-01T01:00:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
  })

  it("makes one exact refusal loud without inventing a stalled live queue", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = ""
    await using app = await createApp(
      refuseForever(() => blocked),
      clock.read,
      createMemoryJournal(),
      ids(),
      undefined,
      { ...DEFAULT_QUEUE_PROGRESS_POLICY, refusalCount: 3 },
    )
    const pr = await submitAndRequestChecks(app, "issue/no-landing")
    blocked = pr.id
    await app.queue.run({}, runtime)

    expect(app.queue.audit({ now: "2026-01-01T00:10:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: {
        code: "admission-refused",
        message: expect.stringContaining("authored-gitlink"),
      },
    })

    blocked = ""
    clock.set("2026-01-01T00:10:01.000Z")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
    await app.queue.run({}, runtime)
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
  })

  it("uses a real landing as the next progress clock while queued work remains", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read)
    const first = await submitAndRequestChecks(app, "issue/lands-first")
    const second = await submitAndRequestChecks(app, "issue/remains-queued")
    await requestChecksTimes(app, second.id, DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks - 2)

    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-progress-stalled",
        specimen: "queue:main",
        count: 2,
        since: "2026-01-01T00:00:00.000Z",
      }),
    )

    clock.set("2026-01-01T00:30:00.000Z")
    await app.queue.run({ prs: [first.id] }, runtime)
    expect(app.bays.pr(first.id)?.integratedAt).toBe("2026-01-01T00:30:00.000Z")
    expect(app.bays.pr(second.id)?.integratedAt).toBeUndefined()
    // No further attempts follow the landing on purpose. The landing restarts
    // the window, so `second` now carries ZERO checks inside it — the shape of a
    // runner asleep over ready work, which must stay loud.
    expect(app.queue.audit({ now: "2026-01-01T00:59:59.999Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
    expect(app.queue.audit({ now: "2026-01-01T01:00:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-progress-stalled",
        specimen: "queue:main",
        count: 1,
        since: "2026-01-01T00:30:00.000Z",
      }),
    )
  })

  it("counts one typed refusal streak and resets that streak when the refusal code changes", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const journal = createMemoryJournal()
    const id = ids()
    let refusalCode = "authored-gitlink"
    const prepare: CandidatePreparer = () => {
      throw createFailure({
        kind: "refusal",
        code: refusalCode,
        message: `yrd: exact refusal text for ${refusalCode}`,
      })
    }
    let prId = ""
    {
      await using app = await createApp(prepare, clock.read, journal, id)
      const pr = await submitAndRequestChecks(app, "issue/typed-refusal-streak")
      prId = pr.id

      for (const [index, at] of ["2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z"].entries()) {
        clock.set(at)
        if (index > 0) await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
        await app.queue.run({}, runtime)
      }
      refusalCode = "base-moved"
      for (const at of ["2026-01-01T00:02:00.000Z", "2026-01-01T00:03:00.000Z", "2026-01-01T00:04:00.000Z"]) {
        clock.set(at)
        await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
        await app.queue.run({}, runtime)
      }

      expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({
        count: 5,
        sameCodeCount: 3,
        sameCodeFirstAt: "2026-01-01T00:02:00.000Z",
        code: "base-moved",
      })
      expect(app.queue.audit().findings).toContainEqual({
        code: "admission-refusal-loop",
        message: expect.stringContaining("exact refusal text for base-moved"),
        pr: pr.id,
        specimen: `pr:${pr.id}:refusal:base-moved`,
        refusal: "base-moved",
        count: 3,
        since: "2026-01-01T00:02:00.000Z",
        blockedMs: 2 * 60_000,
      })
      expect(app.queue.audit({ now: "2026-01-01T00:20:00.000Z" }).findings).toHaveLength(1)
    }

    await using replayed = await createApp(prepare, clock.read, journal, id)
    expect(replayed.state().queues.admissionRefusals[prId]).toMatchObject({
      count: 5,
      sameCodeCount: 3,
      sameCodeFirstAt: "2026-01-01T00:02:00.000Z",
      code: "base-moved",
    })
    expect(replayed.queue.audit().findings).toContainEqual({
      code: "admission-refusal-loop",
      message: expect.stringContaining("exact refusal text for base-moved"),
      pr: prId,
      specimen: `pr:${prId}:refusal:base-moved`,
      refusal: "base-moved",
      count: 3,
      since: "2026-01-01T00:02:00.000Z",
      blockedMs: 2 * 60_000,
    })
  })

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
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    clock.set("2026-01-01T05:46:00.000Z")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
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
      specimen: `pr:${pr.id}:refusal:authored-gitlink`,
      refusal: "authored-gitlink",
      count: 3,
      since: "2026-01-01T00:00:00.000Z",
      blockedMs: 5 * 3_600_000 + 46 * 60_000,
    })
    const finding = app.queue.audit().findings.find((item) => item.code === "admission-refusal-loop")
    expect(finding?.message).toBe(
      `merge request '${pr.id}' at the head of the required-check queue failed its entry checks 3 consecutive times over 5h46m ` +
        `(since 2026-01-01T00:00:00.000Z) without ever completing required checks; latest failure 'authored-gitlink': ` +
        `yrd: PR '${pr.id}' authors a gitlink bump`,
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
      await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
      await app.queue.run({}, runtime)
      expect(app.queue.audit().findings).toEqual([])
      clock.set("2026-01-01T00:20:00.000Z")
      await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
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

    for (const [index, at] of [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:10:00.000Z",
    ].entries()) {
      clock.set(at)
      if (index > 0) await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
      await app.queue.run({}, runtime)
    }
    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({ code: "admission-refusal-loop", count: 3 }),
    )

    blocked = ""
    clock.set("2026-01-01T00:15:00.000Z")
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
    await app.queue.run({}, runtime)
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(app.queue.eligibility(pr.id)).toMatchObject({ checks: { status: "passed" } })
    expect(app.state().queues.admissionRefusals).toEqual({})
    expect(app.queue.audit().findings).toEqual([])
  })

  it("settles a needs-person refusal for one exact revision and preserves that bound across replay (22528)", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const journal = createMemoryJournal()
    const id = ids()
    let blocked = ""
    let preparations = 0
    const refusing = refuseForever(() => blocked)
    const prepare: CandidatePreparer = (input) => {
      preparations += 1
      return refusing(input)
    }
    {
      await using app = await createApp(prepare, clock.read, journal, id)
      const pr = await submitAndRequestChecks(app, "issue/needs-person")
      blocked = pr.id
      for (const [index, at] of [
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:05:00.000Z",
        "2026-01-01T00:10:00.000Z",
      ].entries()) {
        clock.set(at)
        if (index > 0) await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
        await app.queue.run({}, runtime)
      }
      const current = app.bays.pr(pr.id)!.revs.at(-1)!
      await app.queue.settleAdmissionRefusal({
        pr: pr.id,
        revision: current.n,
        headSha: current.head,
        disposition: "needs-person",
        reason: "the recut certificate requires human judgment",
      })
      expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({
        pr: pr.id,
        revision: current.n,
        headSha: current.head,
        settlement: {
          disposition: "needs-person",
          reason: "the recut certificate requires human judgment",
        },
      })
      expect(app.queue.eligibility(pr.id)).toMatchObject({
        runnable: false,
        reason: {
          code: "admission-refused",
          message: expect.stringContaining("Settled needs-person at 2026-01-01T00:10:00.000Z"),
        },
      })
      expect(app.queue.eligibility(pr.id).reason?.message).not.toContain("yrd pr recut")
      expect(app.queue.eligibility(pr.id).reason?.message).toContain("authored-gitlink")
    }

    const beforeReplay = await Array.fromAsync(journal.read()).then((events) => events.length)
    await using replayed = await createApp(prepare, clock.read, journal, id)
    await expect(replayed.queue.run({}, runtime)).resolves.toEqual([])
    expect(preparations).toBe(3)
    expect(await Array.fromAsync(journal.read()).then((events) => events.length)).toBe(beforeReplay)
    expect(replayed.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: {
        code: "admission-refused",
        message: expect.stringContaining("Settled needs-person at 2026-01-01T00:10:00.000Z"),
      },
    })

    // A genuinely new revision is new evidence: the durable settlement applies
    // only to the exact revision/head it named and must not suppress a new push.
    const nextHead = "2".repeat(40)
    await replayed.bays.intake({
      branch: "issue/needs-person",
      headSha: nextHead,
      base: "main",
      baseSha: BASE,
    })
    await replayed.bays.ready({ pr: "PR1" })
    await replayed.bays.requestChecks({ pr: "PR1", baseSha: BASE })
    blocked = ""
    await replayed.queue.run({}, runtime)
    expect(replayed.queue.eligibility("PR1")).toMatchObject({ checks: { status: "passed" } })
    expect(replayed.state().queues.admissionRefusals).toEqual({})
  })

  it("prints the settlement, never the recut drill, once a refusal is settled needs-person", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = ""
    await using app = await createApp(
      refuseForever(() => blocked),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/settled-judgment")
    blocked = pr.id
    await app.queue.run({}, runtime)
    const revision = app.bays.pr(pr.id)!.revs.at(-1)!
    await app.queue.settleAdmissionRefusal({
      pr: pr.id,
      revision: revision.n,
      headSha: revision.head,
      disposition: "needs-person",
      reason: "the recut certificate requires human judgment",
    })

    // classifyRefusalRemedy already judged this refusal to have NO mechanical
    // remedy — the settlement is that judgment made durable. The per-PR message
    // still printed the recut drill after it, sending readers back into the
    // loop the settlement had closed; the settled case must print the judgment
    // fact instead (2026-08-19).
    const message = app.queue.eligibility(pr.id).reason?.message
    expect(app.queue.eligibility(pr.id).reason?.code).toBe("admission-refused")
    expect(message).toContain("Settled needs-person at 2026-01-01T00:00:00.000Z")
    expect(message).toContain("the recut certificate requires human judgment")
    expect(message).not.toContain("yrd pr recut")
  })

  it("prints the settlement for a still-submitted PR whose refusal auto-settled needs-person", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = ""
    // recut-base-diverged is structurally permanent (auto-settles needs-person
    // on the first refusal) and is NOT a needs-author code, so the PR stays
    // `submitted` — the exact shape the resident's settleNeedsPerson leaves
    // behind, reaching the settled admission-refusal verdict directly.
    await using app = await createApp(
      refuseForever(() => blocked, {
        code: "recut-base-diverged",
        message: (pr) => `PR '${pr}' revision 1 certifies a base the authoritative candidate base never descended from`,
      }),
      clock.read,
    )
    const pr = await submitAndRequestChecks(app, "issue/settled-submitted")
    blocked = pr.id
    await app.queue.run({}, runtime)
    expect(app.state().queues.admissionRefusals[pr.id]?.settlement).toMatchObject({ disposition: "needs-person" })

    const message = app.queue.eligibility(pr.id).reason?.message
    expect(app.queue.eligibility(pr.id).reason?.code).toBe("admission-refused")
    expect(message).toContain("Settled needs-person at 2026-01-01T00:00:00.000Z")
    expect(message).not.toContain("yrd pr recut")
  })
})

describe("a submitted PR with no check request and a ledgered refusal never wedges queue reads", () => {
  // The PR1128 incident (2026-08-17, @i/10-merge-queue): `bay submit` queued a
  // carrier, then the authored-gitlink refusal was ledgered against it BEFORE
  // any check request existed. The audit's head-of-line sort compared that PR
  // with a comparator that THREW on a missing current check request, so every
  // surface that computes audit findings died — pr list, queue audit, bay
  // status, the resident runner's own progress probe (which crashlooped it into
  // restart suppression), and `queue recover`, the tool whose job is settling
  // exactly this shape. A comparator asserts nothing: the ordering is total
  // (check-request time, else source-ready time) and the state is PRONOUNCED
  // by findings instead.
  it("audits the PR1128 shape as findings instead of throwing", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    // The delivery app: progress findings require a merge step in the plan,
    // exactly like the production queue that wedged.
    await using app = await createDeliveryApp(clock.read)
    // The PR1127 analog: properly submitted WITH a check request, carrying its
    // own refusal row — the incident journal held refusal rows for both PRs,
    // and the head sort only ever runs its comparator with two entries.
    const ahead = await submitAndRequestChecks(app, "task/pr1127-shape")
    await app.queue.recordAdmissionRefusal({
      pr: ahead.id,
      code: "carrier-drops-landed",
      kind: "refusal",
      reason: "the branch does not contain the merge-queue base",
    })
    // Submitted, deliberately WITHOUT a check request — half the incident state.
    await app.bays.submit({ branch: "task/pr1128-shape", headSha: "9".repeat(40), base: "main", baseSha: BASE })
    const pr = app.bays.prs().find((item) => item.branch === "task/pr1128-shape")
    if (pr === undefined) throw new Error("PR was not recorded")
    expect(pr.checkRequests).toEqual([])
    // The ledgered, unsettled refusal — the other half (the incident's exact
    // journal event, op queue.admissionRefused).
    await app.queue.recordAdmissionRefusal({
      pr: pr.id,
      code: "authored-gitlink",
      kind: "refusal",
      reason: `PR '${pr.id}' changes generated-only gitlinks [ag]`,
    })
    expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({ code: "authored-gitlink" })

    // Pre-fix both of these threw "queued PR '<id>' has no current check
    // request" out of the head sort. Post-fix the state is a finding: the
    // never-started window names the PR the moment it exceeds the policy.
    expect(app.queue.audit().findings).toEqual([])
    expect(app.queue.audit({ now: "2026-01-01T06:00:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({ code: "queue-never-started", pr: pr.id }),
    )

    // And the settlement the remedy loop applies to this disposition still
    // lands — the repair path itself must stay reachable over this state.
    await app.queue.settleAdmissionRefusal({
      pr: pr.id,
      revision: 1,
      headSha: "9".repeat(40),
      disposition: "needs-person",
      reason: "authored gitlink: pin work belongs to an intent, not this carrier",
    })
    expect(app.state().queues.admissionRefusals[pr.id]).toMatchObject({
      settlement: expect.objectContaining({ disposition: "needs-person" }),
    })
    expect(app.queue.audit({ now: "2026-01-01T06:00:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({ code: "queue-never-started", pr: pr.id }),
    )
  })
})
