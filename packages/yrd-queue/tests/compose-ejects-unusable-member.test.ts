/**
 * @failure ONE member whose required check holds an UNUSABLE Job — one that
 * reached no verdict because it was lost, cancelled, killed or skipped —
 * aborts the compose for EVERY member. Measured 2026-09-01: a one-shot queue
 * pass was killed by SIGTERM at 16:30, leaving derived member PR3154's
 * `affected-tests` check with a terminal `job-lost` Job; every pass after it
 * died identically at the compose stage (`ERROR yrd:queue:compose failed
 * [job-lost]`, process exit 3, ZERO merges, no drain attempted at all) and six
 * unrelated eligible changes could not merge for 1h23m behind that one member.
 *
 * The fixture reproduces the shape exactly rather than the timeline: the
 * unusable member's check Job is reclaimed WHILE its callback runs — the same
 * thing a dead runner's recovery does to a job the next pass then submits — so
 * `admitChangeRevision` observes a terminal Job with no verdict, which is the
 * one state that reaches the guard.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobContext, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
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
/** The member that ends up holding an unusable Job. Named to sort FIRST in the
 * admission order, so the pass must also release the line it would otherwise
 * hold: a member ejected without releasing the order withholds every member
 * behind it with `admission-order-held`, which is the same wedge in a new hat. */
const UNUSABLE_BRANCH = "issue/aaa-unusable"
const UNUSABLE_SHA = "7".repeat(40)
const HEALTHY_BRANCH = "issue/zzz-healthy"
const HEALTHY_SHA = "8".repeat(40)
const SIGTERM = "one-shot queue runner interrupted by SIGTERM"
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

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

type App = Awaited<ReturnType<typeof createApp>>

/** derived-admission-execution.test.ts's reference configuration, with the one
 * knob these properties need: a check callback that also receives its own
 * `JobContext`, so a fixture can reclaim the very Job it is running under. */
async function createApp(
  options: Readonly<{
    checkRun?: (
      input: StepExecution,
      context: JobContext,
    ) => JobResult<z.infer<typeof CheckResultSchema>> | Promise<JobResult<z.infer<typeof CheckResultSchema>>>
    log?: ReturnType<typeof createLogger>
  }> = {},
) {
  const check = withStep(
    "check",
    async (input: StepExecution, context: JobContext): Promise<JobResult<z.infer<typeof CheckResultSchema>>> =>
      (await options.checkRun?.(input, context)) ?? {
        status: "completed",
        conclusion: "success",
        output: { checked: true },
      },
    { revision: "check-v1", output: CheckResultSchema },
  )
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
    prNumberMint: volatilePrNumberMint(),
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

/** The 16:30 kill, reproduced against exactly one member: the check callback
 * for `UNUSABLE_BRANCH` reclaims its OWN in-flight Job (`runner` names the
 * runner as dead, which is what a habitant's startup recovery asserts about the
 * process SIGTERM took), so the Job goes terminal `timed_out` with NO verdict
 * and `admitChangeRevision` observes it that way. Fires once: a re-drive on a
 * later pass must be free to reach a real verdict. */
function reclaimedMidCheck(
  app: () => App | undefined,
): (input: StepExecution, context: JobContext) => Promise<JobResult<z.infer<typeof CheckResultSchema>>> {
  let fired = false
  return async (input, context) => {
    const passing = { status: "completed", conclusion: "success", output: { checked: true } } as const
    if (fired || !input.prs.some((pr) => pr.headSha === UNUSABLE_SHA)) return passing
    fired = true
    await app()?.jobs.recover({ now: "2026-01-01T00:00:00.000Z", runner: context.runner, reason: SIGTERM })
    return passing
  }
}

/** Every row this pass logged under `action`. */
function rowsWith(events: readonly LogEvent[], action: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.action === action,
  )
}

/** Every `admission-ejected` finding this pass reported. */
function ejectionRows(events: readonly LogEvent[]): Extract<LogEvent, { kind: "log" }>[] {
  return rowsWith(events, "admission-ejected")
}

function capturingLog(events: LogEvent[]): ReturnType<typeof createLogger> {
  return createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
}

async function submitBoth(app: App): Promise<void> {
  await app.bays.recordBranchSubmit({ branch: UNUSABLE_BRANCH, sha: UNUSABLE_SHA, base: "main" })
  await app.bays.recordBranchSubmit({ branch: HEALTHY_BRANCH, sha: HEALTHY_SHA, base: "main" })
}

/** WHICH members a pass actually merged, by head sha. The sha is the stable
 * identity here: a derived member's PR id is minted per pass and has no record
 * to look it up in, but the sha is the author's own push. */
function mergedShas(runs: readonly { readonly prs: readonly { readonly headSha?: string }[] }[]): string[] {
  return runs.flatMap((run) => run.prs.flatMap((pr) => (pr.headSha === undefined ? [] : [pr.headSha])))
}

describe("one member's unusable Job is ejected from the pass, never the whole pass", () => {
  it("merges the healthy member in the SAME pass and resolves — the unusable one is ejected, not fatal", async () => {
    const events: LogEvent[] = []
    const log = capturingLog(events)
    let app: App | undefined
    await using created = await createApp({ log, checkRun: reclaimedMidCheck(() => app) })
    app = created
    await submitBoth(created)

    // Pre-fix this REJECTS with `yrd: derived member 'PR1' required check
    // 'check' failed without a verdict (job-lost): one-shot queue runner
    // interrupted by SIGTERM` — the outage's own string — and nothing merges.
    const runs = await created.queue.run({}, runtime)

    // Property 1: the healthy member merged in that same pass, and the pass
    // itself resolved (the CLI's exit code is this promise settling).
    expect(mergedShas(runs)).toEqual([HEALTHY_SHA])
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The unusable member is the one that was ejected, and it is the member
    // that sorts FIRST — so the healthy one behind it was admitted rather than
    // withheld `admission-order-held` by a head the pass had given up on.
    expect(ejectionRows(events).map((row) => row.props?.branch)).toEqual([UNUSABLE_BRANCH])
    log.end()
  })

  it("reports the ejected member EXACTLY once, naming the change, the check, the job's failure code and the cure", async () => {
    const events: LogEvent[] = []
    const log = capturingLog(events)
    let app: App | undefined
    await using created = await createApp({ log, checkRun: reclaimedMidCheck(() => app) })
    app = created
    await submitBoth(created)

    await created.queue.run({}, runtime)

    // Property 2: ONE finding, not a bare warn and not one per member per pass.
    const rows = ejectionRows(events)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.level).toBe("warn")
    expect(row?.props).toMatchObject({
      action: "admission-ejected",
      branch: UNUSABLE_BRANCH,
      step: "check",
      code: "job-lost",
    })
    // The change, the check, the code, the Job, and what unsticks it — all in
    // the row a reader actually sees.
    expect(row?.message).toContain(String(row?.props?.pr))
    expect(row?.message).toContain(UNUSABLE_BRANCH)
    expect(row?.message).toContain("job-lost")
    expect(row?.message).toContain("check")
    expect(row?.message).toContain(SIGTERM)
    expect(row?.message).toContain(`re-push refs/yrd/submit/${UNUSABLE_BRANCH}`)
    expect(row?.props?.job).toBe(created.state().jobs.byKey[`admission:${String(row?.props?.pr)}:1:${BASE}:0:check-v1`])
    log.end()
  })

  it("leaves the ejected member's submit fact STANDING — an infrastructure failure never consumes a submission", async () => {
    const events: LogEvent[] = []
    const log = capturingLog(events)
    let app: App | undefined
    await using created = await createApp({ log, checkRun: reclaimedMidCheck(() => app) })
    app = created
    await submitBoth(created)

    await created.queue.run({}, runtime)

    // Property 3: the author pushed nothing wrong, so the fact they pushed is
    // untouched — same sha, still live, ready for the next pass. The retirement
    // funnel was never entered either, which is the mechanism behind it: an
    // ejection does not pass through `refuseRevisionAdmission` at all.
    expect(created.state().bays.submits[UNUSABLE_BRANCH]).toMatchObject({ sha: UNUSABLE_SHA, base: "main" })
    expect(rowsWith(events, "submit-fact-retired")).toEqual([])
    log.end()
  })

  it("REFUSES, never ejects, a member whose required check reached a real verdict", async () => {
    const events: LogEvent[] = []
    const log = capturingLog(events)
    await using created = await createApp({
      log,
      checkRun: (input) =>
        input.prs.some((pr) => pr.headSha === UNUSABLE_SHA)
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "check-failed", message: "3 tests failed" },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    })
    await submitBoth(created)

    const runs = await created.queue.run({}, runtime)

    // Property 4, the discrimination that matters: a FAILING check is a VERDICT
    // about the author's content, so it takes `refuseRevisionAdmission`'s one
    // funnel exactly as before — the funnel that RETIRES the derived submit
    // fact, making the cure a re-push — and it produces no ejection row at all.
    // Retiring the fact is precisely what an ejection must never do, so this
    // row is the sharpest available contrast with the property above.
    expect(ejectionRows(events)).toEqual([])
    expect(rowsWith(events, "submit-fact-retired")).toMatchObject([
      { props: { branch: UNUSABLE_BRANCH, sha: UNUSABLE_SHA, code: "check-failed" } },
    ])
    expect(rowsWith(events, "compose-candidate-skip")).toMatchObject([{ props: { code: "check-failed" } }])
    // And the pass survives a refusal exactly as it always did: the healthy
    // member still merges. This arm is untouched, which is the point.
    expect(mergedShas(runs)).toEqual([HEALTHY_SHA])
    log.end()
  })

  it("writes nothing a later pass must clean up — the ejection is per-pass and stateless", async () => {
    const events: LogEvent[] = []
    const log = capturingLog(events)
    let app: App | undefined
    await using created = await createApp({ log, checkRun: reclaimedMidCheck(() => app) })
    app = created
    await submitBoth(created)

    await created.queue.run({}, runtime)
    const ejectedId = String(ejectionRows(events)[0]?.props?.pr)

    // Property 5: no refusal ledger row, no admission record, no queue record —
    // nothing keyed to the ejected member that a later pass has to settle,
    // retire or sweep.
    expect(created.state().queues.admissionRefusals[ejectedId]).toBeUndefined()
    expect(created.state().bays.prs[ejectedId]).toBeUndefined()

    // And the proof that "nothing to clean up" is not just an absent key: the
    // next pass appends nothing at all for this member.
    const before = await Array.fromAsync(created.events())
    await created.queue.run({}, runtime)
    const appended = (await Array.fromAsync(created.events())).slice(before.length)
    expect(appended.filter((event) => JSON.stringify(event).includes(`"${ejectedId}"`))).toEqual([])
    log.end()
  })
})
