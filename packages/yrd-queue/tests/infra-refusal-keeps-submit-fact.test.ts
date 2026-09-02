/**
 * @failure An environment fault INSIDE a required check — a full `/tmp`, an
 * unreachable submodule origin — reaches `refuseRevisionAdmission` as a
 * `failure`-conclusion Job carrying an `infra-retry` bucket code,
 * `admissionFailureKind` names it an author-owned "failure" because it reads
 * only the caller's flag, and the one retirement funnel consumes the author's
 * standing submit fact on it. Measured 2026-09-01 22:24 PDT: `/tmp` (a quota'd
 * tmpfs) hit `Disk quota exceeded` inside `affected-tests` for PR3159 and
 * PR3175; yrd coded both `affected-tests-failed`, journaled
 * `submit-fact-retired` twice, and two healthy submissions needed a re-push to
 * recover from a condition a re-push does not address (@i/10-yrd/24031).
 *
 * Operator ruling: within ten minutes of a merge attempt the decision is
 * either "yrd is broken => fix yrd" or "PR broken => send it back", and an
 * ENOSPC/EDQUOT is the first, never the second. So the invariants pinned here
 * are about the DISPOSITION, never about a code: an infrastructure refusal
 * keeps the fact, ledgers itself as infrastructure with the cure, and hands
 * the member back to the next pass; an author refusal retires exactly as
 * before. The control is what gives the first half teeth — the same harness,
 * one code apart, must still retire.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  COMPOSITION_FAILURE_BUCKETS,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
/** The submission the environment fault strikes. */
const ENV_BRANCH = "issue/aaa-env-fault"
const ENV_SHA = "7".repeat(40)
/** A healthy sibling BEHIND it in the admission order, so a pass that wedges
 * on the faulted head is visible as a sibling that never merged. */
const HEALTHY_BRANCH = "issue/zzz-healthy"
const HEALTHY_SHA = "8".repeat(40)
/** An `infra-retry` bucket member a check step can carry today — the
 * scratch-preparation twin of the incident's own storage exhaustion. */
const STORAGE_EXHAUSTED = "worktree-storage-exhausted"
/** The incident's own code: the dynamic `<purpose>-failed` family, which is an
 * AUTHOR disposition and must keep retiring. */
const AUTHOR_CODE = "affected-tests-failed"
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

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

const passing: JobResult<CheckResult> = { status: "completed", conclusion: "success", output: { checked: true } }

/** A check that ran and came back with a typed failure: the shape a command
 * step produces when its process exits non-zero — the same `failure`
 * conclusion whether the output said "3 tests failed" or "Disk quota
 * exceeded". Only the CODE tells the two apart, which is the whole bug. */
function failedCheck(code: string, message: string): JobResult<CheckResult> {
  return { status: "completed", conclusion: "failure", error: { code, message } }
}

/** The environment, as the check sees it: broken until repaired. Counts how
 * many times the faulted member's check actually RAN, which is the fact the
 * next-pass properties turn on — a member that is re-admitted without its
 * check running again has not been re-admitted at all. */
function environment(code: string, message: string) {
  let broken = true
  const runs = new Map<string, number>()
  return {
    repair: () => {
      broken = false
    },
    runsFor: (sha: string) => runs.get(sha) ?? 0,
    check: (input: StepExecution): JobResult<CheckResult> => {
      for (const pr of input.prs) runs.set(pr.headSha, (runs.get(pr.headSha) ?? 0) + 1)
      const faulted = input.prs.some((pr) => pr.headSha === ENV_SHA)
      return faulted && broken ? failedCheck(code, message) : passing
    },
  }
}

async function createApp(
  options: Readonly<{
    check: (input: StepExecution) => JobResult<CheckResult>
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
  }>,
) {
  const check = withStep("check", options.check, { revision: "check-v1", output: CheckResultSchema })
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
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
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

function capturingLog(events: LogEvent[]): ReturnType<typeof createLogger> {
  return createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
}

/** Every row this pass logged under `action`. */
function rowsWith(events: readonly LogEvent[], action: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.action === action,
  )
}

/** Every journal event of one name — the durable record, as a replay reads it. */
async function journaled(app: App, name: string): Promise<unknown[]> {
  return (await Array.fromAsync(app.events())).filter((event) => event.name === name)
}

/** WHICH members a pass merged, by head sha — the author's own push, stable
 * across passes where a derived member's minted id is not. */
function mergedShas(runs: readonly { readonly prs: readonly { readonly headSha?: string }[] }[]): string[] {
  return runs.flatMap((run) => run.prs.flatMap((pr) => (pr.headSha === undefined ? [] : [pr.headSha])))
}

const DISK_FULL =
  "yrd: scratch preparation ran out of space — filesystem backing '/tmp' is exhausted; " +
  "Underlying error: Disk quota exceeded"

describe("an infrastructure-disposed check failure never retires the submission", () => {
  it("keeps the fact standing, journals no retirement, and ledgers the refusal as infrastructure naming the cure", async () => {
    const events: LogEvent[] = []
    const env = environment(STORAGE_EXHAUSTED, DISK_FULL)
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ check: env.check, log: capturingLog(events), queueMint })
    await app.bays.recordBranchSubmit({ branch: ENV_BRANCH, sha: ENV_SHA, base: "main" })

    // Pre-fix: the check's `failure` conclusion reaches the one funnel as an
    // author-owned "failure", `submit-fact-retired` is journaled, and the
    // author is told to push new content for a filesystem they do not own.
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    expect(queueMint.highWater(), "the first pass derives exactly one change").toBe(1)
    expect(env.runsFor(ENV_SHA), "the check ran and judged the environment").toBe(1)

    // The submission is NOT consumed: same fact, same sha, still live.
    const state = app.state()
    expect(state.bays.submits[ENV_BRANCH]).toMatchObject({ sha: ENV_SHA, base: "main" })
    expect(state.queues.retiredSubmits[ENV_BRANCH], "no retirement row").toBeUndefined()
    expect(await journaled(app, "queue/submit/retired"), "no retirement event in the journal").toEqual([])
    expect(rowsWith(events, "submit-fact-retired")).toEqual([])

    // ONE row says the fact was kept, and names the code and the cure.
    const kept = rowsWith(events, "submit-fact-kept")
    expect(kept).toHaveLength(1)
    expect(kept[0]?.props).toMatchObject({
      branch: ENV_BRANCH,
      sha: ENV_SHA,
      pr: "PR1",
      code: STORAGE_EXHAUSTED,
      kind: "infrastructure",
      reason: DISK_FULL,
    })
    expect(kept[0]?.message).toContain("no re-push needed")
    expect(String(kept[0]?.props?.remedy)).toContain(ENV_BRANCH)

    // The refusal itself is durable and DISTINGUISHABLE from a verdict about
    // the content: kind "infrastructure", and its reason carries the cure.
    expect(state.queues.admissionRefusals.PR1).toMatchObject({
      pr: "PR1",
      code: STORAGE_EXHAUSTED,
      kind: "infrastructure",
      count: 1,
    })
    expect(state.queues.admissionRefusals.PR1?.reason).toContain(DISK_FULL)
    expect(state.queues.admissionRefusals.PR1?.reason).toContain("remedy: no re-push needed")
    expect(state.queues.admissionRefusals.PR1?.settlement, "an environment fault settles nothing").toBeUndefined()
    expect(rowsWith(events, "compose-candidate-skip")).toMatchObject([
      { props: { pr: "PR1", code: STORAGE_EXHAUSTED, kind: "infrastructure" } },
    ])
  })

  it("admits the SAME member again on the next pass and merges it once the environment is repaired", async () => {
    const env = environment(STORAGE_EXHAUSTED, DISK_FULL)
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ check: env.check, queueMint })
    await app.bays.recordBranchSubmit({ branch: ENV_BRANCH, sha: ENV_SHA, base: "main" })

    await app.queue.run({}, runtime)
    expect(env.runsFor(ENV_SHA)).toBe(1)

    // The operator frees the filesystem. The author does nothing.
    env.repair()
    const runs = await app.queue.run({}, runtime)

    // The check RAN again — a kept fact alone re-admits nothing, because the
    // failed Job is reused by key and a derived member has no record for the
    // authority-counted retry to hang off — under the SAME identity, never a
    // phantom re-mint, and the member merged.
    expect(env.runsFor(ENV_SHA), "the next pass re-runs the check").toBe(2)
    expect(queueMint.highWater(), "one fact, one identity — no second change minted").toBe(1)
    expect(mergedShas(runs)).toEqual([ENV_SHA])
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().queues.retiredSubmits[ENV_BRANCH]).toBeUndefined()
  })

  it("stays bounded while the environment stays broken: one attempt per pass, one identity, and the pass never wedges", async () => {
    const events: LogEvent[] = []
    const env = environment(STORAGE_EXHAUSTED, DISK_FULL)
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ check: env.check, log: capturingLog(events), queueMint })
    await app.bays.recordBranchSubmit({ branch: ENV_BRANCH, sha: ENV_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: HEALTHY_BRANCH, sha: HEALTHY_SHA, base: "main" })

    // The faulted member sorts FIRST. A pass that wedged on it would leave the
    // healthy sibling behind it unmerged; a pass that spun on it would run its
    // check more than once per pass.
    const first = await app.queue.run({}, runtime)
    expect(mergedShas(first), "the healthy sibling merges in the same pass").toEqual([HEALTHY_SHA])
    expect(env.runsFor(ENV_SHA)).toBe(1)

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    expect(env.runsFor(ENV_SHA), "exactly one attempt per pass").toBe(3)
    expect(queueMint.highWater(), "two facts, two identities, none re-minted").toBe(2)
    expect(app.state().bays.submits[ENV_BRANCH]).toMatchObject({ sha: ENV_SHA })
    expect(rowsWith(events, "submit-fact-retired")).toEqual([])
    // The refusal streak is the existing bound: it counts one per pass, and
    // `queue audit` reports it at ADMISSION_REFUSAL_LOOP_THRESHOLD. Nothing
    // new limits this; nothing needs to.
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ code: STORAGE_EXHAUSTED, count: 3 })
    expect(rowsWith(events, "submit-fact-kept")).toHaveLength(3)
  })

  it.each([...COMPOSITION_FAILURE_BUCKETS["infra-retry"]].toSorted())(
    "by construction — every `infra-retry` bucket member keeps the fact: %s",
    async (code) => {
      // The kind is derived from the bucket, not from a list this test could
      // fall out of step with: a member added to the bucket tomorrow is
      // infrastructure here the same day.
      const events: LogEvent[] = []
      const env = environment(code, `yrd: ${code} struck while checking`)
      await using app = await createApp({ check: env.check, log: capturingLog(events) })
      await app.bays.recordBranchSubmit({ branch: ENV_BRANCH, sha: ENV_SHA, base: "main" })

      await app.queue.run({}, runtime)

      expect(app.state().bays.submits[ENV_BRANCH]).toMatchObject({ sha: ENV_SHA })
      expect(app.state().queues.retiredSubmits[ENV_BRANCH]).toBeUndefined()
      expect(rowsWith(events, "submit-fact-kept")).toMatchObject([{ props: { code, kind: "infrastructure" } }])
      expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ code, kind: "infrastructure" })
    },
  )

  it("CONTROL: an author-disposed check failure still retires the fact exactly as before", async () => {
    // The incident's own code, `affected-tests-failed`, is the dynamic
    // `<purpose>-failed` family: a check that ran and judged the CONTENT.
    // That is the author's to fix, and the retirement is what stops the
    // 79-phantom re-mint loop this funnel was built against. Same harness,
    // one code apart — this is what gives the properties above their teeth.
    const events: LogEvent[] = []
    const env = environment(AUTHOR_CODE, "affected-tests command exited 1: 3 tests failed; full output: output.log")
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ check: env.check, log: capturingLog(events), queueMint })
    await app.bays.recordBranchSubmit({ branch: ENV_BRANCH, sha: ENV_SHA, base: "main" })

    await app.queue.run({}, runtime)

    expect(rowsWith(events, "submit-fact-kept")).toEqual([])
    expect(rowsWith(events, "submit-fact-retired")).toMatchObject([
      { props: { branch: ENV_BRANCH, sha: ENV_SHA, pr: "PR1", code: AUTHOR_CODE } },
    ])
    expect(app.state().queues.retiredSubmits[ENV_BRANCH]).toMatchObject({ sha: ENV_SHA, pr: "PR1", code: AUTHOR_CODE })
    expect(await journaled(app, "queue/submit/retired")).toHaveLength(1)
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ code: AUTHOR_CODE, kind: "failure" })
    expect(app.state().queues.admissionRefusals.PR1?.reason).not.toContain("remedy: no re-push")

    // And the retirement still holds: the next pass neither re-mints nor
    // re-runs the check for a fact whose verdict was the author's.
    await app.queue.run({}, runtime)
    expect(queueMint.highWater()).toBe(1)
    expect(env.runsFor(ENV_SHA), "an author verdict is not retried").toBe(1)
  })
})
