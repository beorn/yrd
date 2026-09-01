/**
 * @failure A standing submit fact whose derived change cannot progress is
 * derived afresh on EVERY compose pass, minting a new change number each time.
 * The fact's authority is never consumed, so the next pass derives it again,
 * and none of it is visible to `yrd pr list` (derived changes carry no record).
 *
 * TWO live shapes, 2026-08-29/30, and they are why the invariant here is
 * outcome-agnostic:
 *   - `candidate-conflicting` before required checks — PR2605…PR2692, 79
 *     phantom changes across two facts in ~17 h. The refusal returns BEFORE any
 *     run record exists, so the journal held nothing but the standing fact.
 *   - `required-check-failed` — issue/sop-due-harness-r2 at 6e4952c0 derived
 *     PR2695 (failed 01:14), PR2696 (01:25), PR2697 (01:32): one identical sha,
 *     three changes, three FULL check runs burned. Nothing conflicted here.
 *
 * Keying the cure on either code would have fixed one shape and left the other
 * bleeding. This file pins what the loop actually broke: a standing fact
 * derives at most ONE live change, and once a candidate has been BUILT for it
 * and judged, the fact is terminal with a finding — whatever the verdict was
 * called.
 *
 * It also pins the boundary, which matters as much as the rule: a refusal
 * raised while PREPARING the candidate never evaluated the content and is a
 * PARK, not a verdict. `min-commit-unpublished` names an arrangement around the
 * change; someone satisfies it and the same fact integrates with no resubmit.
 * "Any refusal retires the fact" would have broken that contract, which is why
 * the discriminator is a candidate in hand rather than a list of codes.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, raiseFailure } from "@yrd/core"
import { localRunner, withJobs, type Jobs, type JobResult, type Runner } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  deriveRunMemberArgs,
  Queues,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"
import { indexedJournal } from "./support/indexed-journal.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

/** The live specimen's conflicting path: a `vendor/yrd` gitlink on a sibling
 * lineage of main's, which conflicts on exactly one path and can never merge
 * without the author rebasing. */
const GITLINK_PATH = "vendor/yrd"

function ids(): () => string {
  let value = 0
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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/** The specimen: preparation finds the candidate conflicting on exactly one
 * path — the `vendor/yrd` gitlink — before any required check runs. */
const conflictingCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return {
    ...candidate,
    sha: MERGED,
    ref: candidateRefFor(MERGED),
    mergeability: "conflicting",
    conflicts: [GITLINK_PATH],
  }
}

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
    prepareCandidate?: CandidatePreparer
    resolveBaseSha?: () => string
    /** The OTHER non-progressing shape, measured live 2026-08-30 01:10-01:32:
     * the candidate merges fine and its required check fails. */
    failCheck?: () => boolean | Promise<boolean>
    checkResult?: (input: StepExecution) => JobResult<CheckResult> | Promise<JobResult<CheckResult>>
    runner?: (jobs: Jobs) => Runner
  }> = {},
) {
  const check = withStep(
    "check",
    async (input: StepExecution): Promise<JobResult<CheckResult>> =>
      options.checkResult !== undefined
        ? options.checkResult(input)
        : (await options.failCheck?.()) === true
          ? {
              status: "completed",
              conclusion: "failure",
              // A VERDICT, not a runner-error: the check ran and said no. A
              // verdictless failure is infrastructure and follows the bounded
              // retry path exercised below.
              error: { code: "check-failed", message: "the required check failed on this content" },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: options.resolveBaseSha?.() ?? BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: options.resolveBaseSha ?? (() => BASE),
    prepareCandidate: options.prepareCandidate ?? mergeableCandidate,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

/** Every run any pass retained. A change refused before its checks are queued never reaches a
 * run, which is exactly why its refusal had no durable home before this fix —
 * measured at yrd bc313acb: after a conflicting pass this is empty, and so are
 * `bays.prs` and `queues.admissionRefusals`. */
function retainedRuns(app: Awaited<ReturnType<typeof createApp>>): unknown[] {
  return [...Queues.values(app.state().queues)]
}

describe("a standing submit fact derives at most ONE live change", () => {
  it("a candidate that conflicts before its checks retires the fact; the next compose pass does not derive it again", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ log, queueMint, prepareCandidate: conflictingCandidate })

    // The author pushed refs/heads/issue/conflicting and refs/yrd/submit/issue/conflicting.
    // Its `vendor/yrd` gitlink is a sibling lineage of main's, so the candidate
    // conflicts on exactly that one path and can never merge as it stands.
    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    const afterFirst = queueMint.highWater()
    expect(afterFirst, "the first pass derives exactly one change").toBe(1)
    expect(actionsLogged(events)).toContain("compose-derived-admitted")

    // THE REGRESSION. The candidate conflicted before its required checks, so
    // the refusal returned before any run record existed and nothing
    // consumed the fact's authority. Today the fact stands untouched and this
    // second pass mints PR2 — the 79-phantom loop, one turn of it.
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "the fact must not be derived a second time").toBe(afterFirst)

    // The fact is retired at exactly the sha that could not progress, and the
    // row names the change the mint already spent — the durable trace that did
    // not exist before, and the reason nothing derives here again.
    const retired = app.state().queues.retiredSubmits
    expect(Object.keys(retired), "one fact, one retirement").toEqual(["issue/conflicting"])
    expect(retired["issue/conflicting"]).toMatchObject({
      branch: "issue/conflicting",
      sha: SHA,
      pr: "PR1",
      code: "candidate-conflicting",
      paths: [GITLINK_PATH],
    })
    // The refusal comes before its checks are queued, so it never reached a run — the state that
    // made the loop invisible everywhere. The retirement row is the only place
    // this change is recorded, which is why it has to exist.
    expect(retainedRuns(app), "a conflicting candidate never reaches a run").toEqual([])
    expect(actionsLogged(events)).toContain("submit-fact-retired")
    expect(actionsLogged(events)).toContain("compose-derived-fact-retired")
  })

  it("the retirement survives a fresh projection over the same journal", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, id, queueMint, prepareCandidate: conflictingCandidate })
      await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })
      await app.queue.run({}, runtime)
      expect(app.state().queues.retiredSubmits["issue/conflicting"]).toMatchObject({ sha: SHA, pr: "PR1" })
    }

    // A restart must not un-retire the fact: if the row lived only in memory,
    // the next process would derive the fact afresh and the loop would resume
    // on every runner restart — which is exactly how a 17-hour one goes
    // unnoticed. The retirement is a journal event, so it replays.
    await using replayed = await createApp({ journal, id, queueMint, prepareCandidate: conflictingCandidate })
    expect(replayed.state().queues.retiredSubmits["issue/conflicting"]).toMatchObject({ sha: SHA, pr: "PR1" })
    await replayed.queue.run({}, runtime)
    expect(queueMint.highWater(), "a restart must not re-derive a retired fact").toBe(1)
  })

  it("a rebased push re-projects the fact at a new sha, and the retirement stops applying", async () => {
    const queueMint = volatilePrNumberMint()
    // Mergeable on the SECOND pass models the author's cure: the retirement is
    // pinned to a sha, so new content is not blocked by the old verdict.
    let conflicting = true
    const prepare: CandidatePreparer = (input) =>
      conflicting ? conflictingCandidate(input) : mergeableCandidate(input)
    await using app = await createApp({ queueMint, prepareCandidate: prepare })

    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater()).toBe(1)

    // The author rebases and pushes; the receiver re-projects the fact at the
    // new sha. Nothing clears the retirement — it simply stops matching.
    conflicting = false
    const rebased = "9".repeat(40)
    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: rebased, base: "main" })
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "the cure must be derivable again").toBe(2)
  })

  it("a failed derived member retires once while a new member still admits normally", async () => {
    // The SECOND live shape, measured 2026-08-30 01:10-01:32: fact
    // issue/sop-due-harness-r2 at 6e4952c0 derived PR2695 (check failed 01:14),
    // then PR2696 (failed 01:25), then PR2697 (failed 01:32) — one identical
    // sha, three changes, three FULL check runs burned. Nothing conflicted
    // here; the candidate merged fine and its required check failed. Keying
    // the retirement on `candidate-conflicting` would have fixed one shape and
    // left this one bleeding, so the invariant is about the fact having
    // produced a change that reached an outcome, never about which outcome.
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    let checksFail = true
    await using app = await createApp({ log, queueMint, failCheck: () => checksFail })
    await app.bays.recordBranchSubmit({ branch: "issue/failing-check", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    expect(queueMint.highWater(), "the first pass derives exactly one change").toBe(1)

    const identity = app.state().queues.derivedIdentities["issue/failing-check"]?.[SHA]
    expect(identity, "the failing fact has one durable logical identity").toMatchObject({ id: "PR1", revision: 1 })

    const refusal = app.state().queues.admissionRefusals["PR1"]
    const failingMemberComposeCount = events.filter(
      (event) =>
        event.kind === "log" &&
        event.props?.action === "compose-derived-admitted" &&
        event.props.branch === "issue/failing-check",
    ).length
    expect(failingMemberComposeCount, "the failing member composes once").toBe(1)
    expect(refusal, "the refusal ledger stays keyed to the derived identity").toMatchObject({
      pr: "PR1",
      code: "check-failed",
      count: 1,
      sameCodeCount: failingMemberComposeCount,
    })

    await app.queue.run({}, runtime)
    expect(queueMint.highWater(), "a failed check must not mint a second change").toBe(1)

    expect(
      events.filter(
        (event) =>
          event.kind === "log" &&
          event.props?.action === "compose-derived-admitted" &&
          event.props.branch === "issue/failing-check",
      ),
      "the next pass must not re-admit the retired fact",
    ).toHaveLength(failingMemberComposeCount)
    expect(app.state().queues.admissionRefusals["PR1"]?.sameCodeCount).toBe(failingMemberComposeCount)

    const retired = app.state().queues.retiredSubmits["issue/failing-check"]
    expect(retired, "the fact is retired on this shape too").toBeDefined()
    expect(retired).toMatchObject({
      branch: "issue/failing-check",
      sha: SHA,
      pr: "PR1",
      code: "check-failed",
      reason: "the required check failed on this content",
    })

    const finding = (await app.queue.audit()).findings.find(
      (candidate) => candidate.code === "submit-fact-terminal" && candidate.pr === "PR1",
    )
    expect(finding, "the retired failure must be loud in queue audit").toBeDefined()
    expect(finding?.refusal).toBe("check-failed")
    expect(finding?.message).toContain("the required check failed on this content")
    expect(actionsLogged(events)).toContain("submit-fact-retired")

    // A terminal verdict belongs only to this exact submit fact. A different
    // member arriving behind it must still use the normal derived admission
    // path and integrate; otherwise retirement has become a lane-wide park.
    checksFail = false
    const nextSha = "8".repeat(40)
    await app.bays.recordBranchSubmit({ branch: "issue/new-member", sha: nextSha, base: "main" })
    const runs = await app.queue.run({}, runtime)

    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(queueMint.highWater(), "the new member uses the next identity normally").toBe(2)
    expect(app.state().queues.derivedIdentities["issue/new-member"]?.[nextSha]).toMatchObject({
      id: "PR2",
      revision: 1,
    })
    expect(app.state().queues.retiredSubmits["issue/new-member"]).toBeUndefined()
  })

  it("derived admission machinery shares one bounded retry budget across cancellation and runner failure", async () => {
    let checkCalls = 0
    let currentBase = BASE
    let holdJob = true
    const branch = "issue/infrastructure-retry"
    await using app = await createApp({
      journal: indexedJournal(),
      resolveBaseSha: () => currentBase,
      runner: (jobs) => {
        const active = localRunner({ id: "local", jobs, leaseMs: 60_000 })
        return {
          ...active,
          submit: async (input) => {
            if (!holdJob) return active.submit(input)
            const held = jobs.get(input.job)
            if (held === undefined) throw new Error(`expected admission Job '${input.job}'`)
            return held
          },
        }
      },
      checkResult: (input) => {
        checkCalls += 1
        if (input.prs[0]?.branch === branch) {
          throw new Error("required-check runner disappeared before producing a verdict")
        }
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    await app.bays.recordBranchSubmit({ branch, sha: SHA, base: "main" })

    let firstTurn = true
    await expect(
      app.queue.run(
        {},
        {
          ...runtime,
          continueAdmissions: () => {
            const run = firstTurn
            firstTurn = false
            return run
          },
        },
      ),
      "the first pass leaves one admission Job queued",
    ).resolves.toEqual([])
    const pending = Object.values(app.state().jobs.byId).find((job) => job.key?.startsWith("admission:PR1:1:"))
    expect(pending).toMatchObject({ status: "queued", attempt: 0 })
    if (pending === undefined) throw new Error("expected the derived admission Job")
    await app.jobs.cancel({ id: pending.id, attempt: pending.attempt, by: "yrd/queue", reason: "runner cycled" })

    for (const outcome of [
      { code: "run-canceled", count: 1, sameCodeCount: 1, checkCalls: 0 },
      { code: "runner-error", count: 2, sameCodeCount: 1, checkCalls: 1 },
      { code: "runner-error", count: 3, sameCodeCount: 2, checkCalls: 2 },
      { code: "runner-error", count: 4, sameCodeCount: 3, checkCalls: 3 },
    ]) {
      const label = `verdictless outcome ${outcome.count} stays pass-local`
      const { checkCalls: expectedCheckCalls, ...refusal } = outcome
      await expect(app.queue.run({}, runtime), label).resolves.toEqual([])
      expect(checkCalls, label).toBe(expectedCheckCalls)
      expect(app.state().queues.admissionRefusals.PR1, label).toMatchObject({
        pr: "PR1",
        revision: 1,
        headSha: SHA,
        baseSha: BASE,
        kind: "infrastructure",
        verdictless: true,
        ...refusal,
      })
      if (outcome.count === 1) {
        expect(app.jobs.get(pending.id), "the cancellation atomically requeues its Job").toMatchObject({
          status: "queued",
          attempt: 0,
        })
        holdJob = false
      }
    }

    await expect(app.queue.run({}, runtime), "the fifth pass observes the cap without spinning").resolves.toEqual([])
    expect(checkCalls, "one cancellation plus at most three fresh runner attempts").toBe(3)
    expect(app.state().queues.derivedIdentities[branch]?.[SHA]).toMatchObject({ id: "PR1", revision: 1 })
    expect(app.state().queues.retiredSubmits[branch], "machinery failure is not a content verdict").toBeUndefined()
    expect(app.state().bays.submits[branch]?.sha, "the submit fact remains standing for an operator cure").toBe(SHA)
    const finding = (await app.queue.audit()).findings.find(
      (candidate) => candidate.code === "admission-verdictless-repeat" && candidate.pr === "PR1",
    )
    expect(finding).toMatchObject({ refusal: "runner-error", count: 4 })
    expect(finding?.message).toContain("four verdictless required-check outcomes")

    currentBase = "4".repeat(40)
    await expect(app.queue.run({}, runtime), "a new base re-arms the standing member").resolves.toEqual([])
    expect(checkCalls, "the new base gets a fresh first attempt").toBe(4)
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({
      baseSha: currentBase,
      code: "runner-error",
      count: 1,
      sameCodeCount: 1,
      verdictless: true,
    })

    const healthySha = "5".repeat(40)
    await app.bays.recordBranchSubmit({ branch: "issue/healthy-after-infrastructure", sha: healthySha, base: "main" })
    await expect(app.queue.run({}, runtime)).resolves.toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().queues.derivedIdentities["issue/healthy-after-infrastructure"]?.[healthySha]).toMatchObject({
      id: "PR2",
      revision: 1,
    })
  })

  it("does not stamp an old derived failure onto a submit fact that moved while its check ran", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    const branch = "issue/moved-during-check"
    const nextSha = "6".repeat(40)
    let moveDuringCheck = true
    let checksFail = true
    const appRef: { current?: Awaited<ReturnType<typeof createApp>> } = {}
    await using app = await createApp({
      log,
      queueMint,
      failCheck: async () => {
        if (moveDuringCheck) {
          moveDuringCheck = false
          if (appRef.current === undefined) throw new Error("test app is not initialized")
          await appRef.current.bays.recordBranchSubmit({ branch, sha: nextSha, base: "main" })
        }
        return checksFail
      },
    })
    appRef.current = app
    await app.bays.recordBranchSubmit({ branch, sha: SHA, base: "main" })

    await app.queue.run({}, runtime)

    expect(app.state().bays.submits[branch]?.sha).toBe(nextSha)
    expect(app.state().queues.derivedIdentities[branch]?.[SHA]).toMatchObject({ id: "PR1", revision: 1 })
    expect(app.state().queues.admissionRefusals.PR1, "the old verdict must not attach to fresh content").toBeUndefined()
    expect(actionsLogged(events), "the stale attribution must be loud").toContain("admission-refusal-stale")

    checksFail = false
    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(queueMint.highWater()).toBe(2)
    expect(app.state().queues.derivedIdentities[branch]?.[nextSha]).toMatchObject({ id: "PR2", revision: 1 })
  })

  it("keeps a canonical derived member distinct from a record alias throughout mixed explicit compose", async () => {
    const queueMint = volatilePrNumberMint(2)
    await using app = await createApp({ queueMint })
    await app.bays.submit({ branch: "PR3", headSha: "3".repeat(40), base: "main", baseSha: BASE })
    const branch = "issue/mixed-explicit-derived"
    await app.bays.recordBranchSubmit({ branch, sha: SHA, base: "main" })
    const derived = deriveRunMemberArgs({
      bays: app.state().bays,
      queues: app.state().queues,
      mint: queueMint,
      branch,
      enrichment: { changeId: `I${SHA}` },
    })
    expect(derived.id).toBe("PR3")

    const runs = await app.queue.run({ prs: ["PR1"], derived: [derived] }, runtime)

    expect(runs).toHaveLength(2)
    expect(runs.flatMap((run) => run.prs.map((member) => member.id)).toSorted()).toEqual(["PR1", "PR3"])
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed", conclusion: "success" }),
        expect.objectContaining({ status: "completed", conclusion: "success" }),
      ]),
    )
  })

  it("a refusal raised while PREPARING the candidate is a park, not a verdict: the same fact still integrates", async () => {
    // THE BOUNDARY, and the reason the rule is not "any refusal retires the
    // fact". A refusal raised before a candidate exists never evaluated this
    // content — it names an arrangement AROUND the change, which someone can
    // satisfy without the author touching the branch. `min-commit-unpublished`
    // is the live one: push the submodule's own main and the SAME fact
    // integrates on the next pass, no resubmit (contract-tested end-to-end in
    // yrd-cli's host suite). Retiring on it would demand a re-push to recover
    // from a condition a re-push does not address, so the discriminator is
    // whether a candidate was BUILT and judged — never the refusal's code.
    const queueMint = volatilePrNumberMint()
    let arrangementMissing = true
    const prepare: CandidatePreparer = (input) => {
      if (arrangementMissing) {
        raiseFailure(
          "refusal",
          "min-commit-unpublished",
          "change cannot fill the shaset: push it to the submodule's own main first",
        )
      }
      return mergeableCandidate(input)
    }
    await using app = await createApp({ queueMint, prepareCandidate: prepare })
    await app.bays.recordBranchSubmit({ branch: "issue/parked", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    expect(app.state().queues.retiredSubmits["issue/parked"], "a park must not retire the fact").toBeUndefined()
    expect(app.state().queues.admissionRefusals.PR1, "a park must not acquire a refusal-ledger row").toBeUndefined()
    expect(app.state().queues.derivedIdentities["issue/parked"]?.[SHA]).toMatchObject({ id: "PR1", revision: 1 })
    expect(queueMint.highWater(), "a park keeps the first identity live").toBe(1)

    // The arrangement the refusal named now exists. The durable fact alone
    // carries the next pass.
    arrangementMissing = false
    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(queueMint.highWater(), "the recovery pass reuses the parked identity").toBe(1)
    expect(app.state().queues.derivedIdentities["issue/parked"]?.[SHA]).toMatchObject({ id: "PR1", revision: 1 })
  })

  it("the retirement is a terminal finding naming the conflicting path and the cure", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp({ log, prepareCandidate: conflictingCandidate })
    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)

    const findings = (await app.queue.audit()).findings
    const retired = findings.find((finding) => finding.code === "submit-fact-terminal")
    expect(
      retired,
      `expected a submit-fact-terminal finding, got: ${findings.map((f) => f.code).join(", ")}`,
    ).toBeDefined()
    // The finding must name WHAT conflicted, not only that something did.
    expect(retired?.message).toContain(GITLINK_PATH)
    expect(retired?.pr).toBe("PR1")
    expect(retired?.refusal).toBe("candidate-conflicting")
    // The cure is the operator's next act, so the finding carries it as steps:
    // rebase onto the base, and — for a gitlink — a DESCENDANT, never a sibling
    // lineage, which is the exact shape that minted 79 phantom changes.
    const resolution = (retired?.resolution ?? []).join("\n")
    expect(resolution).toContain("rebase origin/main")
    expect(resolution).toContain(GITLINK_PATH)
    expect(resolution).toContain("DESCENDANT")
    expect(resolution).toContain("git push --no-recurse-submodules bay HEAD:refs/for/main/<issue>")
  })
})
