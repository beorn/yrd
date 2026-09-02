/**
 * @failure With an ERROR row now fatal to the pass (operator ruling
 *          2026-09-01), every ERROR the queue emitted for a HANDLED condition
 *          became a runner death: a red required check killed the pass that
 *          refused it, and the compose-eject row — emitted on EVERY pass while
 *          a member's check job stays lost, ~55 an hour of one-shots — would
 *          have killed every pass forever for one member.
 * @level l2
 * @consumer @yrd/queue · @yrd/job
 *
 * The rule the demotions follow: WARN is where a handled condition lives (the
 * pass records the verdict and continues; the row is the list of work it
 * leaves), ERROR is reserved for what the queue cannot continue past. The
 * fixture is `compose-ejects-unusable-member.test.ts`'s, with the journal
 * left open as a parameter so a SECOND pass can run in a fresh process —
 * which is what a one-shot loop is, and where the reporter's dedup memo does
 * not exist.
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type JsonValue } from "@yrd/core"
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
} from "../src/index.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const STUCK_BRANCH = "issue/aaa-stuck"
const STUCK_SHA = "7".repeat(40)
const HEALTHY_BRANCH = "issue/zzz-healthy"
const HEALTHY_SHA = "8".repeat(40)
const SIGTERM = "one-shot queue runner interrupted by SIGTERM"
const CLOCK = "2026-01-01T00:00:00.000Z"
const TEN_MINUTES_LATER = "2026-01-01T00:10:00.000Z"
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

type CheckRun = (
  input: StepExecution,
  context: JobContext,
) => JobResult<z.infer<typeof CheckResultSchema>> | Promise<JobResult<z.infer<typeof CheckResultSchema>>>

type App = Awaited<ReturnType<typeof createApp>>

/** A journal and a PR-number mint that outlive one app: what "the next pass in
 * a fresh process" shares with the pass before it — the durable state — and
 * nothing else (no condition reporter, no memo). */
function durableState() {
  return { journal: createMemoryJournal<JsonValue>(), mint: volatilePrNumberMint(), id: ids() }
}

async function createApp(
  options: Readonly<{
    checkRun?: CheckRun
    log: ReturnType<typeof createLogger>
    durable?: ReturnType<typeof durableState>
  }>,
) {
  const durable = options.durable ?? durableState()
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
    prNumberMint: durable.mint,
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: durable.mint, jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: durable.journal,
      id: durable.id,
      clock: () => CLOCK,
      log: options.log,
    },
  })
}

/** The 16:30 kill, on exactly one member: its check reclaims its OWN Job, so
 * the Job goes terminal with NO verdict and the member is ejected. */
function reclaimedMidCheck(app: () => App | undefined): CheckRun {
  let fired = false
  return async (input, context) => {
    const passing = { status: "completed", conclusion: "success", output: { checked: true } } as const
    if (fired || !input.prs.some((pr) => pr.headSha === STUCK_SHA)) return passing
    fired = true
    await app()?.jobs.recover({ now: CLOCK, runner: context.runner, reason: SIGTERM })
    return passing
  }
}

function logRows(events: readonly LogEvent[]): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter((event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log")
}

function rowsWith(events: readonly LogEvent[], action: string): Extract<LogEvent, { kind: "log" }>[] {
  return logRows(events).filter((event) => event.props?.action === action)
}

function errorRows(events: readonly LogEvent[]): Extract<LogEvent, { kind: "log" }>[] {
  return logRows(events).filter((event) => event.level === "error")
}

function capturingLog(events: LogEvent[]): ReturnType<typeof createLogger> {
  return createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
}

async function submitBoth(app: App): Promise<void> {
  await app.bays.recordBranchSubmit({ branch: STUCK_BRANCH, sha: STUCK_SHA, base: "main" })
  await app.bays.recordBranchSubmit({ branch: HEALTHY_BRANCH, sha: HEALTHY_SHA, base: "main" })
}

function mergedShas(runs: readonly { readonly prs: readonly { readonly headSha?: string }[] }[]): string[] {
  return runs.flatMap((run) => run.prs.flatMap((pr) => (pr.headSha === undefined ? [] : [pr.headSha])))
}

describe("a demoted condition does not end the pass", () => {
  it("logs a failed REQUIRED check at WARN — a verdict the queue records and moves past — and merges the rest", async () => {
    const events: LogEvent[] = []
    await using app = await createApp({
      log: capturingLog(events),
      checkRun: (input) =>
        input.prs.some((pr) => pr.headSha === STUCK_SHA)
          ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "3 tests failed" } }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    })
    await submitBoth(app)

    const runs = await app.queue.run({}, runtime)

    // The failed check's own row: WARN, still printed at the default level,
    // still naming the code. It was ERROR — and an ERROR row now ends the pass,
    // which would make every red PR a runner death.
    const verdict = logRows(events).find((row) => row.namespace === "yrd:jobs:check" && row.props?.outcome === "failed")
    expect(verdict?.level).toBe("warn")
    expect(verdict?.props).toMatchObject({ error: { code: "check-failed" } })
    // And nothing in the whole pass is ERROR: the pass had nothing it could
    // not continue past.
    expect(errorRows(events).map((row) => [row.namespace, row.message])).toEqual([])
    // The pass continued: the healthy member merged in the same pass.
    expect(mergedShas(runs)).toEqual([HEALTHY_SHA])
  })

  it("keeps a check ended by SIGKILL at ERROR — machinery, not a verdict (negative control)", async () => {
    // Not a fail-on-base proof: this level is unchanged. It pins the line the
    // demotion stops at — `isMachineryJobFailure` — so a later reader knows
    // WARN was a decision about verdicts, not a blanket downgrade.
    const events: LogEvent[] = []
    await using app = await createApp({
      log: capturingLog(events),
      checkRun: (input) =>
        input.prs.some((pr) => pr.headSha === STUCK_SHA)
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "check-infrastructure-signal", message: "check command ended by SIGKILL (exit 137)" },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    })
    await submitBoth(app)
    await app.queue.run({}, runtime)
    const machinery = logRows(events).find(
      (row) => row.namespace === "yrd:jobs:check" && row.props?.outcome === "failed",
    )
    expect(machinery?.level).toBe("error")
  })
})

describe("the compose-eject row under the fatal rule", () => {
  it("is WARN, and carries the member, the check, the code, and how long it has been stuck", async () => {
    const events: LogEvent[] = []
    let app: App | undefined
    await using created = await createApp({ log: capturingLog(events), checkRun: reclaimedMidCheck(() => app) })
    app = created
    await submitBoth(created)

    // `now` is the pass's clock for the age: ten minutes after the fixture's
    // journal clock, which is when the reclaimed Job went terminal.
    const runs = await created.queue.run({}, { ...runtime, now: () => Date.parse(TEN_MINUTES_LATER) })

    const rows = rowsWith(events, "admission-ejected")
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.level).toBe("warn")
    expect(row?.props).toMatchObject({
      branch: STUCK_BRANCH,
      step: "check",
      code: "job-lost",
      since: CLOCK,
      ageMs: 10 * 60_000,
      age: "10m",
    })
    expect(row?.message).toContain(String(row?.props?.pr))
    expect(row?.message).toContain("stuck for 10m")
    expect(row?.message).toContain(`re-push refs/yrd/submit/${STUCK_BRANCH}`)
    // The pass continued past it.
    expect(errorRows(events)).toEqual([])
    expect(mergedShas(runs)).toEqual([HEALTHY_SHA])
  })

  it("produces NO ERROR row on the second pass in a FRESH process over the same journal", async () => {
    // A one-shot loop is a new process per pass, with a new condition
    // reporter and no memo of anything the previous pass announced. Under the
    // fatal rule an ERROR about the stuck member would have killed the pass
    // that met it and every one after, for as long as nothing re-drove the
    // check. What the member costs a later pass is a WARN naming it — the
    // list of work — and nothing that stops the queue.
    const durable = durableState()
    const firstEvents: LogEvent[] = []
    {
      let app: App | undefined
      await using first = await createApp({
        log: capturingLog(firstEvents),
        checkRun: reclaimedMidCheck(() => app),
        durable,
      })
      app = first
      await submitBoth(first)
      await first.queue.run({}, runtime)
      const ejected = rowsWith(firstEvents, "admission-ejected")
      expect(ejected).toHaveLength(1)
      expect(ejected[0]?.level).toBe("warn")
      expect(errorRows(firstEvents)).toEqual([])
    }

    // "Process 2": the same durable state, nothing else.
    const secondEvents: LogEvent[] = []
    await using second = await createApp({ log: capturingLog(secondEvents), durable })
    await second.queue.recover({ recoveryTime: "1970-01-01T00:00:00.000Z", runner: runtime.runner, reason: SIGTERM })
    await second.queue.run({}, runtime)

    // The member is still stuck (its lost Job is in the journal, nothing
    // re-drove it) and this pass says so — at WARN, naming the change.
    const stuckId = String(rowsWith(firstEvents, "admission-ejected")[0]?.props?.pr)
    const aboutStuck = logRows(secondEvents).filter(
      (row) => row.props?.pr === stuckId || row.props?.branch === STUCK_BRANCH || row.message.includes(stuckId),
    )
    expect(aboutStuck.length).toBeGreaterThan(0)
    expect(aboutStuck.map((row) => row.level)).not.toContain("error")
    expect(errorRows(secondEvents).map((row) => [row.namespace, row.message])).toEqual([])
    // And still no verdict against the author: the submit fact stands.
    expect(second.state().bays.submits[STUCK_BRANCH]).toMatchObject({ sha: STUCK_SHA, base: "main" })
  })
})
