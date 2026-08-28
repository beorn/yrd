/**
 * @failure A change refused at ADMISSION never becomes a run record, so `auditQueues` (which walks run records only) is structurally blind to a head-of-line refusal loop — `queue audit` returned `findings: []` through a 5h46m block while every compose cycle logged a loggily-only `compose-candidate-skip`.
 *
 * S7 (branch-is-change, @i/10 22991): members are derived from standing submit
 * facts, so the refusal ledger is the ONLY durable identity a member refused
 * before any run has — `mintDerivedMemberIdentity` reuses the ledger row's id
 * across refused composes, which is what makes a streak countable at all. The
 * fixtures below re-push nothing between cycles: a refused member never
 * consumed its authority, so every compose re-derives it, which is exactly the
 * forever-retry the header incident describes.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
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

/** Derived-lane arming. Without a mint and an enrichment reader the compose
 * cannot derive a member from a submit fact at all, so every fixture here
 * needs both — they are what the record lane's intake used to stand in for. */
function derivedArming(mint?: PrNumberMint) {
  return {
    prNumberMint: mint ?? volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }: Readonly<{ branch: string; sha: string }>) => ({ changeId: `I${sha}` }),
  }
}

/** Check-only plan: every configured step is admission work, so a refusal here
 * merges in `dispatchAdmissions` — the path that never mints a run record. */
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
    resolveBaseSha: () => BASE,
    prepareCandidate,
    progress,
    ...derivedArming(),
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
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal, id, clock, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
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
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    ...derivedArming(),
    ...(defaultSteps === undefined ? {} : { defaultSteps }),
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), id: ids(), clock, log: createLogger("test", [{ level: "silent" }]) },
  })
}

/** The whole delivery, post-S7: a branch and its standing submit fact. Each
 * branch needs its own head — an identical payload composes as a duplicate. */
async function submitBranch(
  app: Awaited<ReturnType<typeof createApp>> | Awaited<ReturnType<typeof createDeliveryApp>>,
  branch: string,
  sha?: string,
): Promise<string> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: sha ?? digit.repeat(40), base: "main" })
  return branch
}

/** The refusal ledger row a branch earned, and the id the mint reused for it.
 * A derived member has no store row, so this IS the member's identity. */
function refusalFor(
  app: Awaited<ReturnType<typeof createApp>> | Awaited<ReturnType<typeof createDeliveryApp>>,
  branch: string,
) {
  return Object.values(app.state().queues.admissionRefusals).find((row) => row.branch === branch)
}

function memberIdFor(
  app: Awaited<ReturnType<typeof createApp>> | Awaited<ReturnType<typeof createDeliveryApp>>,
  branch: string,
): string {
  const id = refusalFor(app, branch)?.pr
  if (id === undefined) throw new Error(`no refusal row identifies a member for branch '${branch}'`)
  return id
}

/** A Candidate preparer that refuses for one branch forever — the shape of every
 * real head-of-line admission wedge (authored gitlink, stale recut certificate,
 * unresolvable base): typed `refusal`, so the selectorless drain survives it and
 * retries the identical member on the next cycle, forever. Keyed on the branch
 * because a derived member's id is minted by the very compose being refused. */
function refuseForever(
  blocked: () => string,
  failure: Readonly<{ code: string; message: (pr: string) => string }> = {
    code: "authored-gitlink",
    message: (pr) => `yrd: change '${pr}' authors a gitlink bump`,
  },
): CandidatePreparer {
  return (input) => {
    const poisoned = input.prs.find((pr) => pr.branch === blocked())
    if (poisoned !== undefined) {
      throw createFailure({ kind: "refusal", code: failure.code, message: failure.message(poisoned.id) })
    }
    const { prs: _prs, ...candidate } = input
    return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
  }
}

describe("admission refusal oracle — a head-of-line member refused at admission is visible to queue audit", () => {
  it("records a refusal reported by an external queue preparation robot, under the identity the robot carried", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    await submitBranch(app, "issue/external-refusal", HEAD)
    // A robot outside the queue's own dispatcher has no member id to quote —
    // the id-seam cannot resolve one for a member no run has ever retained — so
    // it carries the identity itself. Without these fields the refusal
    // journaled nothing at all.
    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "issue/external-refusal",
      revision: 1,
      headSha: HEAD,
      code: "submodule-pin-unpublished",
      kind: "refusal",
      reason: "the refreshed revision contains an unpublished submodule pin",
    })

    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({
      pr: "PR1",
      branch: "issue/external-refusal",
      revision: 1,
      headSha: HEAD,
      code: "submodule-pin-unpublished",
      kind: "refusal",
      reason: "the refreshed revision contains an unpublished submodule pin",
      count: 1,
      sameCodeCount: 1,
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
    await submitBranch(app, "issue/configured-owner", HEAD)

    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "issue/configured-owner",
      revision: 1,
      headSha: HEAD,
      code: "authored-gitlink",
      kind: "refusal",
      reason: "the change touches generated-only gitlinks; an exact ruling is needed",
    })
    // The runner's own judgment classification settles a no-mechanical-remedy
    // refusal needs-person (applyRefusalRemedies -> settleAdmissionRefusal);
    // driven explicitly here since no refusal code auto-parks any more.
    await app.queue.settleAdmissionRefusal({
      pr: "PR1",
      revision: 1,
      headSha: HEAD,
      disposition: "needs-person",
      reason: "the change touches generated-only gitlinks; an exact ruling is needed",
    })

    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-needs-person",
        pr: "PR1",
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
    await submitBranch(app, "issue/blank-configured-owner", HEAD)

    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "issue/blank-configured-owner",
      revision: 1,
      headSha: HEAD,
      code: "authored-gitlink",
      kind: "refusal",
      reason: "the change touches generated-only gitlinks; an exact ruling is needed",
    })
    await app.queue.settleAdmissionRefusal({
      pr: "PR1",
      revision: 1,
      headSha: HEAD,
      disposition: "needs-person",
      reason: "the change touches generated-only gitlinks; an exact ruling is needed",
    })

    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-needs-person",
        pr: "PR1",
        owner: "unowned — no needsPerson.owner is configured in .yrd.yml",
      }),
    )
  })

  it("keeps the needs-person finding honest for a member no identity was ever recorded for", async () => {
    // `owner` is repository CONFIG, never journal identity. A DERIVED member is
    // the strongest form of this case: nothing anywhere records a submitter for
    // it, because no record was ever minted. The finding must still fire,
    // still carry the explicit unowned default, and invent no name
    // (@i/10-merge-queue/22918-needs-person-unowned).
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    await submitBranch(app, "issue/unattributed-permanent-refusal", HEAD)
    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "issue/unattributed-permanent-refusal",
      revision: 1,
      headSha: HEAD,
      code: "authored-gitlink",
      kind: "refusal",
      reason: "the change touches generated-only gitlinks; an exact ruling is needed",
    })
    await app.queue.settleAdmissionRefusal({
      pr: "PR1",
      revision: 1,
      headSha: HEAD,
      disposition: "needs-person",
      reason: "the change touches generated-only gitlinks; an exact ruling is needed",
    })

    const finding = app.queue.audit().findings.find((candidate) => candidate.code === "admission-refusal-needs-person")
    expect(finding, "an unattributed settlement still needs a person and must still flag").toBeDefined()
    expect(finding?.owner, "the empty owner slot is shown explicitly, never invented from identity").toBe(
      "unowned — no needsPerson.owner is configured in .yrd.yml",
    )
    expect(finding?.submitter, "no recorded identity means no field, never a plausible-looking owner").toBeUndefined()
    expect(finding?.message).toContain("Owner: unowned — no needsPerson.owner is configured in .yrd.yml.")
    expect(finding?.message).not.toContain("undefined")
  })

  it("keeps an I/O-flavored recut certificate refusal on the ordinary retry threshold", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    await submitBranch(app, "issue/unfetched-certified-base", HEAD)

    // The 2026-07-27 partition specimen: a certificate that could not be READ,
    // refused 106 consecutive cycles and cured by nothing but a retry.
    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "issue/unfetched-certified-base",
      revision: 1,
      headSha: HEAD,
      code: "recut-certificate",
      kind: "refusal",
      reason: "the certified base is not present in the candidate repository",
    })

    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ code: "recut-certificate", count: 1 })
    expect(app.state().queues.admissionRefusals.PR1?.settlement).toBeUndefined()
  })

  it("keeps a recoverable gitlink object gap on the ordinary retry threshold", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => ""),
      clock.read,
    )
    await submitBranch(app, "issue/recoverable-gitlink-object-gap", HEAD)

    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "issue/recoverable-gitlink-object-gap",
      revision: 1,
      headSha: HEAD,
      code: "recut-gitlink-object-missing",
      kind: "refusal",
      reason: "the pinned commit is not present locally; fetch it and retry",
    })

    expect(app.queue.audit().findings).not.toContainEqual(expect.objectContaining({ pr: "PR1" }))
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
      await submitBranch(app, "issue/typed-refusal-streak", HEAD)

      // No re-push between cycles: a refused member never consumed its
      // authority, so every compose re-derives it under the SAME id (the
      // ledger row anchors the reuse) and the streak grows.
      for (const at of ["2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z"]) {
        clock.set(at)
        await app.queue.run({}, runtime)
      }
      refusalCode = "base-moved"
      for (const at of ["2026-01-01T00:02:00.000Z", "2026-01-01T00:03:00.000Z", "2026-01-01T00:04:00.000Z"]) {
        clock.set(at)
        await app.queue.run({}, runtime)
      }

      prId = memberIdFor(app, "issue/typed-refusal-streak")
      expect(app.state().queues.admissionRefusals[prId]).toMatchObject({
        count: 5,
        sameCodeCount: 3,
        sameCodeFirstAt: "2026-01-01T00:02:00.000Z",
        code: "base-moved",
      })
      expect(app.queue.audit().findings).toContainEqual({
        code: "admission-refusal-loop",
        message: expect.stringContaining("exact refusal text for base-moved"),
        pr: prId,
        specimen: `pr:${prId}:refusal:base-moved`,
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

  it("counts consecutive admission refusals and names the change, code, count, and block span", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp(
      refuseForever(() => "issue/head-of-queue-wedge"),
      clock.read,
      createMemoryJournal(),
      ids(),
      log,
    )
    await submitBranch(app, "issue/head-of-queue-wedge", HEAD)

    // Three compose cycles spread over the real 22395 block window. Every cycle
    // refuses the same member at admission, so no queue run record ever exists.
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    clock.set("2026-01-01T02:00:00.000Z")
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    clock.set("2026-01-01T05:46:00.000Z")
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    const prId = memberIdFor(app, "issue/head-of-queue-wedge")
    // The record walk really is blind: no run record was ever minted, so every
    // one of `auditQueues`' six run-record codes has nothing to walk.
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(
      events.filter(
        (event): event is Extract<LogEvent, { kind: "log" }> =>
          event.kind === "log" && event.props?.action === "compose-candidate-skip" && event.props?.pr === prId,
      ),
    ).toHaveLength(3)

    expect(app.queue.audit().findings).toContainEqual({
      code: "admission-refusal-loop",
      message: expect.stringContaining(`change '${prId}'`),
      pr: prId,
      specimen: `pr:${prId}:refusal:authored-gitlink`,
      refusal: "authored-gitlink",
      count: 3,
      since: "2026-01-01T00:00:00.000Z",
      blockedMs: 5 * 3_600_000 + 46 * 60_000,
    })
    const finding = app.queue.audit().findings.find((item) => item.code === "admission-refusal-loop")
    expect(finding?.message).toBe(
      `change '${prId}' at the head of the required-check queue failed its entry checks 3 consecutive times over 5h46m ` +
        `(since 2026-01-01T00:00:00.000Z) without ever completing required checks; latest failure 'authored-gitlink': ` +
        `yrd: change '${prId}' authors a gitlink bump`,
    )
    log.end()
  })

  it("stays quiet below the loop threshold and survives replay from the journal", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const journal = createMemoryJournal()
    const id = ids()
    let prId = ""
    {
      await using app = await createApp(
        refuseForever(() => "issue/head-of-queue-wedge"),
        clock.read,
        journal,
        id,
      )
      await submitBranch(app, "issue/head-of-queue-wedge", HEAD)

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
      prId = memberIdFor(app, "issue/head-of-queue-wedge")
    }

    // A fresh process replaying the same journal sees the same wedge: the ledger
    // is journal-derived state, not in-process bookkeeping.
    await using replayed = await createApp(
      refuseForever(() => "issue/head-of-queue-wedge"),
      clock.read,
      journal,
      id,
    )
    expect(replayed.queue.audit().findings).toContainEqual(
      expect.objectContaining({
        code: "admission-refusal-loop",
        pr: prId,
        refusal: "authored-gitlink",
        count: 3,
        since: "2026-01-01T00:00:00.000Z",
        blockedMs: 20 * 60_000,
      }),
    )
  })

  it("clears the streak when the member is finally admitted", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = "issue/transient-wedge"
    await using app = await createApp(
      refuseForever(() => blocked),
      clock.read,
    )
    await submitBranch(app, "issue/transient-wedge", HEAD)

    for (const at of ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z", "2026-01-01T00:10:00.000Z"]) {
      clock.set(at)
      await app.queue.run({}, runtime)
    }
    expect(app.queue.audit().findings).toContainEqual(
      expect.objectContaining({ code: "admission-refusal-loop", count: 3 }),
    )

    // The wedge clears: the same member is admitted on the next cycle and the
    // durable streak goes with it — a stale ledger row is a phantom wedge.
    blocked = ""
    clock.set("2026-01-01T00:15:00.000Z")
    await app.queue.run({}, runtime)
    expect(app.state().queues.admissionRefusals).toEqual({})
    expect(app.queue.audit().findings).toEqual([])
  })

  it("makes one exact refusal loud without inventing a stalled live queue", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    let blocked = "issue/no-merge"
    await using app = await createApp(
      refuseForever(() => blocked),
      clock.read,
      createMemoryJournal(),
      ids(),
      undefined,
      { ...DEFAULT_QUEUE_PROGRESS_POLICY, refusalCount: 3 },
    )
    await submitBranch(app, "issue/no-merge", HEAD)
    await app.queue.run({}, runtime)

    // One refusal is a fact worth recording and NOT yet a wedge: the row
    // stands, the loop finding stays below threshold, and nothing invents a
    // stalled queue out of a check-only plan that cannot merge at all.
    expect(refusalFor(app, "issue/no-merge")).toMatchObject({ code: "authored-gitlink", count: 1 })
    expect(app.queue.audit({ now: "2026-01-01T00:10:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
    expect(app.queue.audit({ now: "2026-01-01T00:10:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "admission-refusal-loop" }),
    )

    blocked = ""
    clock.set("2026-01-01T00:10:01.000Z")
    await app.queue.run({}, runtime)
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
  })

  it("settles a needs-person refusal for one exact revision, and a genuinely new push clears it", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    const journal = createMemoryJournal()
    const id = ids()
    let blocked = "issue/needs-person"
    let preparations = 0
    const refusing = refuseForever(() => blocked)
    const prepare: CandidatePreparer = (input) => {
      preparations += 1
      return refusing(input)
    }
    let prId = ""
    {
      await using app = await createApp(prepare, clock.read, journal, id)
      await submitBranch(app, "issue/needs-person", HEAD)
      for (const at of ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z", "2026-01-01T00:10:00.000Z"]) {
        clock.set(at)
        await app.queue.run({}, runtime)
      }
      prId = memberIdFor(app, "issue/needs-person")
      await app.queue.settleAdmissionRefusal({
        pr: prId,
        revision: 1,
        headSha: HEAD,
        disposition: "needs-person",
        reason: "the recut certificate requires human judgment",
      })
      // The settlement is bound to the EXACT revision and head it named — that
      // bound is what lets a new push reopen the question.
      expect(app.state().queues.admissionRefusals[prId]).toMatchObject({
        pr: prId,
        revision: 1,
        headSha: HEAD,
        settlement: {
          disposition: "needs-person",
          reason: "the recut certificate requires human judgment",
        },
      })
    }

    // Replay: a settled refusal is not re-attempted, so the candidate preparer
    // is not called again and the journal does not grow.
    const beforeReplay = await Array.fromAsync(journal.read()).then((events) => events.length)
    await using replayed = await createApp(prepare, clock.read, journal, id)
    await expect(replayed.queue.run({}, runtime)).resolves.toEqual([])
    expect(preparations).toBe(3)
    expect(await Array.fromAsync(journal.read()).then((events) => events.length)).toBe(beforeReplay)
    expect(replayed.state().queues.admissionRefusals[prId]?.settlement).toMatchObject({
      disposition: "needs-person",
    })

    // A genuinely new push is new evidence: the durable settlement applies only
    // to the exact revision/head it named and must not suppress the new tree.
    blocked = ""
    await replayed.bays.recordBranchSubmit({ branch: "issue/needs-person", sha: "2".repeat(40), base: "main" })
    await replayed.queue.run({}, runtime)
    expect(replayed.state().queues.admissionRefusals).toEqual({})
  })

  it("a settled needs-person refusal carries its judgment and its owner durably, never a retry drill", async () => {
    // classifyRefusalRemedy already judged this refusal to have NO mechanical
    // remedy — the settlement is that judgment made durable. Before 2026-08-19
    // the surfaces still printed the recut drill after it, sending readers back
    // into the loop the settlement had closed.
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createApp(
      refuseForever(() => "issue/settled-judgment"),
      clock.read,
      createMemoryJournal(),
      ids(),
      undefined,
      undefined,
      "@queue-captain",
    )
    await submitBranch(app, "issue/settled-judgment", HEAD)
    await app.queue.run({}, runtime)
    const prId = memberIdFor(app, "issue/settled-judgment")
    await app.queue.settleAdmissionRefusal({
      pr: prId,
      revision: 1,
      headSha: HEAD,
      disposition: "needs-person",
      reason: "the recut certificate requires human judgment",
    })

    const row = app.state().queues.admissionRefusals[prId]
    expect(row?.settlement).toMatchObject({
      disposition: "needs-person",
      reason: "the recut certificate requires human judgment",
    })
    // The audit finding is the surface that names WHO decides, and it must not
    // decline to say so at the exact moment a reader asks.
    const finding = app.queue.audit().findings.find((item) => item.code === "admission-refusal-needs-person")
    expect(finding).toMatchObject({ pr: prId, owner: "@queue-captain" })
    expect(finding?.message).toContain("the recut certificate requires human judgment")
    expect(finding?.message).not.toContain("yrd pr recut")
    // And the settled member stops counting toward the retry loop.
    expect(app.queue.audit().findings).not.toContainEqual(
      expect.objectContaining({ code: "admission-refusal-loop", pr: prId }),
    )
  })
})

/**
 * The progress half of the oracle.
 *
 * THE POPULATION, stated (@chief ruling 2026-08-27), because a stalled-queue
 * test over a population that never fills is precisely the silent-empty
 * failure this file exists to catch — the same shape as the header incident,
 * one layer up. Pre-S7 the population was Change records filtered by
 * `checksRequested(pr)`, with the clock read from `ChangeCheckRequest.at`. S7
 * deletes both, because a standing submit fact IS the check request. So:
 *
 * - `queue-never-started` = a standing submit fact no compose has served —
 *   the `unrecordedSubmits()` population — dated from the fact's own `at`.
 * - `queue-progress-stalled` = that fact's age plus the admission-Job count,
 *   an admission ATTEMPT now being a compose cycle rather than a re-request.
 *
 * Both codes stay in YRD_QUEUE_AUDIT_FINDING_CODES and must keep firing. If a
 * test here goes green by finding nothing, that is the bug, not the pass —
 * which is why each fixture asserts the population is non-empty before
 * asserting what the audit says about it.
 */
describe("queue progress findings — a queue that is tried and does not move", () => {
  const attempts = DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks

  /** Admission attempts the queue actually dispatched — the post-S7 stand-in
   * for the `ChangeCheckRequest` count the stall predicate used to read. */
  function admissionJobs(app: Awaited<ReturnType<typeof createDeliveryApp>>): readonly string[] {
    return Object.keys(app.state().jobs.byKey).filter((key) => key.startsWith("admission:"))
  }

  it("keeps a passed admission in the no-merge progress population until delivery", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    await submitBranch(app, "issue/admitted-without-merge", HEAD)
    // Tried, repeatedly, and still not delivered: the merge step waits forever.
    for (let index = 0; index < attempts; index++) await app.queue.run({}, runtime)

    // The population is real before the audit is asked about it.
    expect(admissionJobs(app).length).toBeGreaterThan(0)

    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-progress-stalled",
        specimen: "queue:main",
        count: 1,
        since: "2026-01-01T00:00:00.000Z",
      }),
    )
  })

  it("reports approved work that no compose ever served", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    await submitBranch(app, "issue/never-started", HEAD)
    // No compose at all: the approval stands, visible and unserved.
    expect(app.queue.unrecordedSubmits().map((row) => row.branch)).toEqual(["issue/never-started"])

    expect(app.queue.audit({ now: "2026-01-01T00:29:59.999Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-never-started" }),
    )
    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-never-started",
        specimen: "queue:main:never-started",
        count: 1,
        since: "2026-01-01T00:00:00.000Z",
        blockedMs: 30 * 60_000,
      }),
    )
  })

  it("dates the never-started window from the OLDEST unserved approval, not the newest", async () => {
    // The readiness clock is a property of the approvals themselves: a later
    // approval joining the queue must not drag the window forward and shorten
    // a wedge that has been running for half an hour.
    //
    // NOTE (lost half): the original of this test also proved that an
    // UNRELATED MERGE does not reset the clock, by keeping one carrier out of
    // the compose as submitted-without-a-check-request. S7 deletes that state
    // — a standing submit fact IS the check request, so every approval the
    // runner can see is composable and there is no way to hold one back while
    // another merges. Re-fixturing that half needs the progress-population
    // referent decision; it is NOT covered here.
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read)
    await submitBranch(app, "issue/never-started", HEAD)
    clock.set("2026-01-01T00:20:00.000Z")
    await submitBranch(app, "issue/joined-later", "3".repeat(40))

    // Both approvals are genuinely unserved — the population the finding counts.
    expect(app.queue.unrecordedSubmits().map((row) => row.branch).toSorted()).toEqual([
      "issue/joined-later",
      "issue/never-started",
    ])

    expect(app.queue.audit({ now: "2026-01-01T00:30:00.000Z" }).findings).toContainEqual(
      expect.objectContaining({
        code: "queue-never-started",
        count: 2,
        since: "2026-01-01T00:00:00.000Z",
        blockedMs: 30 * 60_000,
      }),
    )
  })

  it("does not call a queue stalled on a single admission attempt", async () => {
    // ONE attempt is a queue barely tried, not a queue trying and failing. An
    // alarm that fires on the first attempt is an alarm somebody mutes.
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read, true)
    await submitBranch(app, "issue/one-admission-check", HEAD)

    await app.queue.run({}, runtime)

    // POSITIVE CONTROL. This test asserts an ABSENCE, so it passes for free if
    // the population is empty — the exact silent-empty failure the file is
    // about. The member must genuinely be in the queue, tried exactly once,
    // for the absence below to mean "not yet stalled" rather than "nothing here".
    expect(admissionJobs(app)).toHaveLength(1)
    expect(app.state().bays.submits["issue/one-admission-check"]).toBeDefined()

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
    await submitBranch(app, "issue/cli-shaped-selection", HEAD)
    for (let index = 0; index < attempts; index++) await app.queue.run({}, runtime)

    expect(admissionJobs(app).length).toBeGreaterThan(0)

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
    await submitBranch(app, "issue/merge-less-selection", HEAD)
    for (let index = 0; index < attempts; index++) await app.queue.run({}, runtime)

    // POSITIVE CONTROL for an absence assertion: the member is present and
    // tried the same number of times as the CLI-shaped test above, which DOES
    // flag. The only difference is the persisted merge-less selection, so the
    // silence below is attributable to the guard and not to an empty queue.
    expect(admissionJobs(app).length).toBeGreaterThan(0)
    expect(app.state().bays.submits["issue/merge-less-selection"]).toBeDefined()

    // Blocked for an hour, twice the default threshold, and silent.
    expect(app.queue.audit({ now: "2026-01-01T01:00:00.000Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
  })

  it("uses a real merge as the next progress clock while queued work remains", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    await using app = await createDeliveryApp(clock.read)
    await submitBranch(app, "issue/merges-first", HEAD)
    await submitBranch(app, "issue/remains-queued", "4".repeat(40))

    clock.set("2026-01-01T00:30:00.000Z")
    const merged = await app.queue.run({}, runtime)

    // POSITIVE CONTROL: a merge really happened (that is what restarts the
    // window) and work really remains behind it. Without both, the quiet below
    // is an empty queue rather than a freshly restarted one. The proof comes
    // from the returned Run — the retained QueueRecord carries no integration.
    expect(merged.some((run) => run.integration !== undefined)).toBe(true)
    expect(app.state().bays.submits["issue/remains-queued"]).toBeDefined()

    // No further attempts follow the merge on purpose. The merge restarts the
    // window, so the queued remainder now carries ZERO attempts inside it — the
    // shape of a runner asleep over ready work, which must stay loud once the
    // window elapses and stay quiet before it does.
    expect(app.queue.audit({ now: "2026-01-01T00:59:59.999Z" }).findings).not.toContainEqual(
      expect.objectContaining({ code: "queue-progress-stalled" }),
    )
  })
})

describe("a standing submit fact with a ledgered refusal and no run never wedges queue reads", () => {
  // The PR1128 incident (2026-08-17, @i/10-merge-queue): a carrier was queued,
  // then the authored-gitlink refusal was ledgered against it BEFORE any check
  // request existed. The audit's head-of-line sort compared that change with a
  // comparator that THREW on a missing current check request, so every surface
  // that computes audit findings died — pr list, queue audit, bay status, the
  // habitant runner's own progress probe (which crashlooped it into restart
  // suppression), and `queue recover`, the tool whose job is settling exactly
  // this shape. A comparator asserts nothing: the ordering is total and the
  // state is PRONOUNCED by findings instead.
  //
  // S7 keeps the shape reachable for a different reason: a derived member
  // refused at its FIRST admission has a ledger row and no run record at all,
  // which is the same "ledgered but nothing to sort by" state one layer down.
  it("audits a ledger-only member as findings instead of throwing", async () => {
    const clock = movableClock("2026-01-01T00:00:00.000Z")
    // The delivery app: progress findings require a merge step in the plan,
    // exactly like the production queue that wedged.
    await using app = await createDeliveryApp(clock.read)
    await submitBranch(app, "task/pr1127-shape", HEAD)
    await app.queue.recordAdmissionRefusal({
      pr: "PR1",
      branch: "task/pr1127-shape",
      revision: 1,
      headSha: HEAD,
      code: "carrier-drops-landed",
      kind: "refusal",
      reason: "the branch does not contain the merge-queue base",
    })
    // A second member in the same state: the head sort only ever runs its
    // comparator with two entries, so one row could never reproduce the throw.
    await submitBranch(app, "task/pr1128-shape", "9".repeat(40))
    await app.queue.recordAdmissionRefusal({
      pr: "PR2",
      branch: "task/pr1128-shape",
      revision: 1,
      headSha: "9".repeat(40),
      code: "authored-gitlink",
      kind: "refusal",
      reason: "change 'PR2' changes generated-only gitlinks [ag]",
    })
    expect(app.state().queues.admissionRefusals.PR2).toMatchObject({ code: "authored-gitlink" })

    // Pre-fix both of these threw out of the head sort. Post-fix the audit
    // simply computes — no run record exists for either member, and that is a
    // state to report, never to assert against.
    expect(() => app.queue.audit()).not.toThrow()
    expect(() => app.queue.audit({ now: "2026-01-01T06:00:00.000Z" })).not.toThrow()
    expect(Queues.ids(app.state().queues)).toEqual([])

    // And the settlement the remedy loop applies to this disposition still
    // merges — the repair path itself must stay reachable over this state.
    await app.queue.settleAdmissionRefusal({
      pr: "PR2",
      revision: 1,
      headSha: "9".repeat(40),
      disposition: "needs-person",
      reason: "authored gitlink: pin work belongs to an intent, not this carrier",
    })
    expect(app.state().queues.admissionRefusals.PR2).toMatchObject({
      settlement: expect.objectContaining({ disposition: "needs-person" }),
    })
    expect(() => app.queue.audit({ now: "2026-01-01T06:00:00.000Z" })).not.toThrow()
  })
})
