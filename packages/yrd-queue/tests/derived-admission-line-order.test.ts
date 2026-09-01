/**
 * @failure A DERIVED (S6, recordless) member is ordered behind EVERY
 * record-lane change regardless of how much older its submit fact is, because
 * `admissionLineHolder` computed the line from `admissionQueue(state, steps)`
 * — the record lane alone, which a derived member is never in — so its
 * position was always -1 and the `position < 0` arm handed it the whole queue
 * as "ahead". `dispatchAdmissions` then withheld it with a bare `continue`:
 * no journal event, no refusal ledger row, no log line. Under the habitant
 * drain (one admission per turn, which is what the resident runner installs)
 * the withheld head is neither admitted nor refused, so the head-of-line
 * release never fires and the whole drain ends having admitted NOTHING —
 * every pass, forever.
 *
 * Measured 2026-09-01 on hh main at yrd caacf98e: derived PR2916
 * (task/base-health-trailer-pointer) passed its four required checks four
 * times over and lost four consecutive queue runs to `stale-check` as main
 * moved under it (R3715, R3719, R3722, R3724). Every one of those runs
 * released its authority with reason `stale-check`, exactly as designed, and
 * the compose re-derived the member as revision 5 on every subsequent pass —
 * and then withheld it. 6h07m, 1471 compose passes, zero merges queue-wide,
 * and ZERO journal events naming PR2916 after 12:43:21.
 *
 * The silence was total: `unrecordedSubmits` suppresses the waiting-list row
 * for a branch holding a retained snapshot at the standing sha (its truth
 * "lives in run/status rows"), so `queue audit` did not name it either, and
 * the runner's own status.json never mentioned it once.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  Queues,
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
const DERIVED_SHA = "7".repeat(40)
/** The resident runner's drain: ONE admission per turn, so a drain signal can
 * interrupt between admissions. Every production compose runs this shape. */
const runtime = { runner: "local", leaseMs: 60_000, continueAdmissions: () => true }
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

type Options = Readonly<{
  /** Clock the fixture advances, so submit facts get distinct queue times. */
  now: () => string
  /** Every change whose required checks this compose executed, in order. */
  checked: string[]
  /** Every change whose merge this compose attempted, in order. */
  merged?: string[]
  /** Merge verdict per attempt; the default integrates. */
  merge?: () => JobResult<IntegrationProof>
  log?: ReturnType<typeof createLogger>
}>

async function createApp(options: Options) {
  const check = withStep(
    "check",
    (input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => {
      options.checked.push((input as unknown as { prs?: readonly { id: string }[] }).prs?.[0]?.id ?? "?")
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (input: StepExecution): Promise<JobResult<IntegrationProof>> => {
      options.merged?.push((input as unknown as { prs?: readonly { id: string }[] }).prs?.[0]?.id ?? "?")
      return options.merge === undefined
        ? { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
        : options.merge()
    },
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
      clock: options.now,
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

/** A record-lane change with a live check request — the population
 * `admissionLineHolder` was ordering derived members against. */
async function recordChange(app: App, branch: string): Promise<string> {
  await app.bays.submit({ branch, headSha: HEAD, base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((candidate) => candidate.branch === branch)
  if (pr === undefined) throw new Error(`no record minted for '${branch}'`)
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr.id
}

/** The one derived member in a run's snapshot, by branch. */
function ranForBranch(app: App, branch: string): boolean {
  return Queues.values(app.state().queues).some((record) => record.prs.some((pr) => pr.branch === branch))
}

describe("a derived member holds its own place in the admission line", () => {
  // THE CONTROL, and it passes on the unfixed tree — which is the finding, not a
  // gap in the suite. A record-lane change IS in the list `admissionLineHolder`
  // computes, so it gets a real position and is never ordered behind the queue
  // it belongs to. Stale-check re-drive was therefore never broken in general:
  // it is broken for exactly the members the line cannot see. Without this
  // control the red tests below read as "stale-check re-drive is broken", and
  // the fix would have been aimed at the release path, which works.
  it("CONTROL: a record-lane member already re-drives after every stale-check loss", async () => {
    const checked: string[] = []
    const merged: string[] = []
    const now = (): string => "2026-01-01T00:00:00.000Z"
    await using app = await createApp({
      now,
      checked,
      merged,
      merge: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "stale-check", message: "queue 'main' moved" },
      }),
    })
    const only = await recordChange(app, "issue/record-only")

    for (let pass = 0; pass < 4; pass += 1) await app.queue.run({}, runtime)

    expect(merged, "the record lane re-drives on every pass, unfixed tree included").toEqual([
      only,
      only,
      only,
      only,
    ])
  })

  it("re-drives a member whose run lost to stale-check, past a younger record-lane change", async () => {
    const checked: string[] = []
    let day = 1
    const now = (): string => `2026-01-0${day}T00:00:00.000Z`
    // The base races forever: every merge attempt finds main already moved, which
    // is a blameless environmental failure — `queueAuthorityReleaseReason` releases
    // the run's authority so the still-submitted member re-admits against the fresh
    // base. That release is the ONLY thing standing between this member and a
    // terminal rejection, and it worked; what follows must not undo it.
    const merged: string[] = []
    let attempt = 0
    await using app = await createApp({
      now,
      checked,
      merged,
      merge: () => {
        attempt += 1
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "stale-check", message: `queue 'main' moved (attempt ${String(attempt)})` },
        }
      },
    })

    // The derived member's submit fact stands FIRST — it is the oldest thing in
    // the queue, and FIFO admission owes it the head of the line.
    await app.bays.recordBranchSubmit({ branch: "issue/derived-oldest", sha: DERIVED_SHA, base: "main" })
    day = 2
    const younger = await recordChange(app, "issue/record-younger")
    day = 3

    // Three compose passes: the first admits and loses to the base race, and the
    // next two must re-drive it. Two consecutive stale-check losses is the exact
    // shape measured on PR2916 (R3722 then R3724, 13 minutes apart).
    for (let pass = 0; pass < 3; pass += 1) await app.queue.run({}, runtime)

    expect(
      merged.filter((id) => id !== younger),
      "each compose must re-drive the released member into a fresh merge attempt against the new base",
    ).toHaveLength(3)
    expect(
      checked.filter((id) => id !== younger),
      "the derived member's required checks must run on every pass, against the fresh base",
    ).toHaveLength(3)
    expect(ranForBranch(app, "issue/derived-oldest"), "the derived member must reach a queue run").toBe(true)
  })

  it("admits the older derived member BEFORE the younger record-lane change", async () => {
    const checked: string[] = []
    let day = 1
    const now = (): string => `2026-01-0${day}T00:00:00.000Z`
    await using app = await createApp({ now, checked })

    await app.bays.recordBranchSubmit({ branch: "issue/derived-oldest", sha: DERIVED_SHA, base: "main" })
    day = 2
    const younger = await recordChange(app, "issue/record-younger")
    day = 3

    // The habitant drain takes ONE change per turn, and FIFO says which: the
    // oldest. Ordering the derived member behind the record lane did not merely
    // reverse that — because a withheld member is neither admitted nor refused,
    // the head-of-line release never fired and the drain admitted NOTHING,
    // which is why the emptiness has to be asserted here too.
    await app.queue.run({}, runtime)

    expect(checked.length, "the drain must admit work at all").toBeGreaterThan(0)
    expect(checked[0], "and the first turn takes the oldest member: the derived one").not.toBe(younger)
  })

  it("names the guard that withheld a change instead of skipping it in silence", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const checked: string[] = []
    let day = 1
    const now = (): string => `2026-01-0${day}T00:00:00.000Z`
    await using app = await createApp({ now, checked, log })

    const held = await recordChange(app, "issue/withheld")
    day = 2
    // A pause is the one withholding an operator can produce on demand, and it
    // leaves through the SAME `continue` the admission line does — which is the
    // point. All four guards used to share one boolean and one bare `continue`,
    // so a member none of them could ever release was invisible to the journal,
    // to `queue audit` and to the runner's status at the same time.
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-09T00:00:00.000Z",
    })

    await app.queue.admit({ prs: [held] })

    expect(checked, "a paused queue admits nothing").toHaveLength(0)
    const withheld = events.flatMap((event) =>
      event.kind === "log" && (event.props as { action?: string } | undefined)?.action === "admission-withheld"
        ? [event.props as { pr?: string; code?: string; reason?: string; remedy?: string }]
        : [],
    )
    expect(withheld.length, "a withheld admission must leave a row").toBeGreaterThan(0)
    expect(withheld[0]?.code).toBe("queue-paused")
    // Reason AND remedy, on the row: whoever is waiting for this change to merge
    // has to be able to read why it did not, and what clears it.
    expect(withheld[0]?.reason ?? "").toContain("paused")
    expect(withheld[0]?.remedy ?? "").not.toBe("")
  })
})
