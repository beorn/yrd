/**
 * @failure At batch 1 a one-shot `queue run --once` admits the WHOLE admission
 * order — every member's every required check, member after member — before it
 * enters its merge phase, so the head's merge is up to an hour out even though
 * its own checks were green in the first minutes. Measured 2026-09-01,
 * pass-181838: PR3153 green on all four checks at 18:22:47, next row
 * `typecheck started PR3160`, no merge row; a later pass ran 50 minutes with
 * zero merges. The mechanism is that a DERIVED member never gets a stored
 * admission record (the Jobs ARE the facts), so nothing between the drain and
 * the post-drain selection turns four green Jobs into a merge, and the drain
 * itself only admitted (queue.ts `const turn = … ? queued : queued.slice(0, 1)`
 * followed by `await drainAdmissions(…)` ahead of the merge loop).
 *
 * The rule under test (@cto design, 2026-09-01): at batch 1 the head merges as
 * soon as its own required checks are all green at the cycle base — its merge
 * Job is enqueued BEFORE any other member is admitted and counts as the turn's
 * progress; merged, the member leaves the queue and the base moves so the next
 * member is checked at the NEW base; failed, the member is refused with the
 * merge Job's reason and the next member gets its turn. Record-lane members
 * keep their stored-admission path (the control below).
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
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

const BASE = "a".repeat(40)
/** Named to sort FIRST in the admission order: the head whose merge the rule is about. */
const HEAD_BRANCH = "issue/aaa-head"
const HEAD_SHA = "7".repeat(40)
/** The member behind it, whose first check must not start before the head's merge is enqueued. */
const SECOND_BRANCH = "issue/zzz-second"
const SECOND_SHA = "8".repeat(40)
/** The merge commit each head lands as — and the base the member behind it is then checked at. */
const MERGED: Readonly<Record<string, string>> = { [HEAD_SHA]: "b".repeat(40), [SECOND_SHA]: "c".repeat(40) }
const CHECKS = ["typecheck", "manifest", "substrate", "tests"] as const
/** Every step callback records one of these, in invocation order — the pass's real timeline. */
type Call = Readonly<{ step: string; head: string; base: string }>
/** Bounds a spinning pass: a callback past this many calls throws instead of running forever. */
const CALL_CAP = 40
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
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD_SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

function mergedFor(head: string): string {
  const merged = MERGED[head]
  if (merged === undefined) throw new Error(`no merge commit configured for head ${head}`)
  return merged
}

function headOf(input: StepExecution): string {
  const head = input.prs[0]?.headSha
  if (head === undefined || input.prs.length !== 1) throw new Error("expected a one-member candidate")
  return head
}

function baseOf(input: StepExecution): string {
  const base = input.candidate?.baseSha
  if (base === undefined) throw new Error("expected the step to carry its Candidate's base")
  return base
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  const head = input.revs[0]?.head
  if (head === undefined || input.revs.length !== 1) throw new Error("expected a one-member candidate")
  return { ...candidate, sha: mergedFor(head), ref: candidateRefFor(mergedFor(head)), mergeability: "mergeable" }
}

type App = Awaited<ReturnType<typeof createApp>>

/**
 * compose-ejects-unusable-member.test.ts's reference configuration with the
 * production plan shape: four required checks ahead of the merge, batch 1, a
 * base that MOVES when a merge lands (the way main does), and every step
 * callback recording its invocation so the pass's order is observable.
 */
async function createApp(
  options: Readonly<{
    calls: Call[]
    log?: ReturnType<typeof createLogger>
    /** The merge verdict for a given head; success unless overridden. */
    mergeVerdict?: (head: string) => JobResult<IntegrationProof> | undefined
    /** Whether a landed merge moves the base the resolver answers (default: yes). */
    movesBase?: boolean
  }>,
) {
  let base = BASE
  const record = (call: Call): void => {
    options.calls.push(call)
    if (options.calls.length > CALL_CAP) throw new Error(`turn cap: ${String(CALL_CAP)} step callbacks exceeded`)
  }
  const checks = CHECKS.map((name) =>
    withStep(
      name,
      (input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => {
        record({ step: name, head: headOf(input), base: baseOf(input) })
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      { revision: `${name}-v1`, output: CheckResultSchema },
    ),
  )
  const merge = withMerge(
    async (input: StepExecution): Promise<JobResult<IntegrationProof>> => {
      const head = headOf(input)
      record({ step: "merge", head, base: baseOf(input) })
      const verdict = options.mergeVerdict?.(head)
      if (verdict !== undefined) return verdict
      if (options.movesBase !== false) base = mergedFor(head)
      return { status: "completed", conclusion: "success", output: { commit: mergedFor(head), baseSha: baseOf(input) } }
    },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [...checks, merge] as const,
    batch: false,
    defaultSteps: [...CHECKS, "merge"],
    resolveBaseSha: () => base,
    prepareCandidate: mergeableCandidate,
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }: Readonly<{ sha: string }>) => ({ changeId: `I${sha}` }),
  } as never as Parameters<typeof withQueue>[0])
  const bayJobs = createBayJobDefs(workspace())
  const app = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(app), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

/** Every row this pass logged under `action`. */
function rowsWith(events: readonly LogEvent[], action: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.action === action,
  )
}

function capturingLog(events: LogEvent[]): ReturnType<typeof createLogger> {
  return createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
}

/** Two branches submitted only in git — the derived lane, which is the whole fleet since the door opened. */
async function submitBothDerived(app: App): Promise<void> {
  await app.bays.recordBranchSubmit({ branch: HEAD_BRANCH, sha: HEAD_SHA, base: "main" })
  await app.bays.recordBranchSubmit({ branch: SECOND_BRANCH, sha: SECOND_SHA, base: "main" })
}

/** The record lane: `yrd pr submit` mints a record and requests its checks. */
async function submitBothRecorded(app: App): Promise<void> {
  for (const [branch, sha] of [
    [HEAD_BRANCH, HEAD_SHA],
    [SECOND_BRANCH, SECOND_SHA],
  ] as const) {
    await app.bays.submit({ branch, headSha: sha, base: "main", baseSha: BASE })
    const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
    if (pr === undefined) throw new Error(`no record for '${branch}'`)
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  }
}

/** The pass's timeline as `step:head` labels, A for the head and B for the member behind it. */
function timeline(calls: readonly Call[]): string[] {
  const label = (head: string): string => (head === HEAD_SHA ? "A" : head === SECOND_SHA ? "B" : head)
  return calls.map((call) => `${call.step}:${label(call.head)}`)
}

/** WHICH members a pass merged, by head sha, in run order. */
function mergedShas(
  runs: readonly { readonly integration?: IntegrationProof; readonly prs: readonly { readonly headSha?: string }[] }[],
): string[] {
  return runs.flatMap((run) =>
    run.integration === undefined ? [] : run.prs.flatMap((pr) => (pr.headSha === undefined ? [] : [pr.headSha])),
  )
}

/** The minted derived id for a branch, from the compose's own admission row. */
function derivedId(events: readonly LogEvent[], branch: string): string {
  const row = rowsWith(events, "compose-derived-admitted").find((candidate) => candidate.props?.branch === branch)
  if (row === undefined) throw new Error(`no compose-derived-admitted row for '${branch}'`)
  return String(row.props?.pr)
}

const A_CHECKS = CHECKS.map((name) => `${name}:A`)
const B_CHECKS = CHECKS.map((name) => `${name}:B`)

describe("merge-when-green at batch 1: the head merges as soon as its own required checks are green", () => {
  it("(a) a derived head with four green check Jobs gets its merge Job enqueued on the next turn, before the second member's typecheck starts", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    await using app = await createApp({ calls, log })
    await submitBothDerived(app)

    const runs = await app.queue.run({}, runtime)

    // Both landed, in admission order …
    expect(mergedShas(runs)).toEqual([HEAD_SHA, SECOND_SHA])
    // … and the head's merge came straight after its fourth green check, ahead
    // of the second member's FIRST check. On the code before this rule the
    // timeline is [A×4, B×4, merge:A, merge:B]: every member's every check
    // before any merge.
    const order = timeline(calls)
    expect(order.slice(0, 5)).toEqual([...A_CHECKS, "merge:A"])
    expect(order.indexOf("merge:A")).toBeLessThan(order.indexOf("typecheck:B"))
    expect(order).toEqual([...A_CHECKS, "merge:A", ...B_CHECKS, "merge:B"])
    // The pass said so, naming the head, the base it was green at, and the run.
    const headId = derivedId(events, HEAD_BRANCH)
    expect(rowsWith(events, "admission-head-green").map((row) => row.props)).toMatchObject([
      { pr: headId, branch: HEAD_BRANCH, baseSha: BASE },
      { branch: SECOND_BRANCH, baseSha: mergedFor(HEAD_SHA) },
    ])
    expect(rowsWith(events, "admission-head-merged").map((row) => row.props)).toMatchObject([
      { pr: headId, branch: HEAD_BRANCH, run: runs[0]?.id },
      { branch: SECOND_BRANCH },
    ])
    log.end()
  }, 30_000)

  it("(b) a terminal successful merge Job removes the member and the queue advances to the next member checked at the NEW base", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    await using app = await createApp({ calls, log })
    await submitBothDerived(app)

    const runs = await app.queue.run({}, runtime)

    // The head merged onto the pass's starting base and moved it; the second
    // member's checks — every one of them — ran at the MOVED base, and its own
    // merge proves against that base. Before this rule the pass memoized the
    // base it started on, so the second member was admitted against a base
    // that no longer existed.
    const headMerge = mergedFor(HEAD_SHA)
    expect(calls.filter((call) => call.head === SECOND_SHA && call.step !== "merge").map((call) => call.base)).toEqual(
      CHECKS.map(() => headMerge),
    )
    expect(runs.map((run) => run.integration)).toEqual([
      { commit: headMerge, baseSha: BASE },
      { commit: mergedFor(SECOND_SHA), baseSha: headMerge },
    ])
    // The second member's required-check Jobs are keyed at the moved base —
    // the durable fact a later pass reads to know which base it was proven on.
    const secondId = derivedId(events, SECOND_BRANCH)
    for (const [index, name] of CHECKS.entries()) {
      expect(app.state().jobs.byKey[`admission:${secondId}:1:${headMerge}:${String(index)}:${name}-v1`]).toBeDefined()
    }
    // And the merged head is gone from the queue: nothing is waiting behind it.
    expect(app.queue.admissionOrder()).toEqual([])
    log.end()
  }, 30_000)

  it("(c) a failed merge Job refuses the member with that reason and dispatches the next member", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    const reason = "yrd: the candidate no longer applies cleanly to main (conflict in packages/yrd-queue/src/queue.ts)"
    await using app = await createApp({
      calls,
      log,
      mergeVerdict: (head) =>
        head === HEAD_SHA
          ? { status: "completed", conclusion: "failure", error: { code: "merge-conflict", message: reason } }
          : undefined,
    })
    await submitBothDerived(app)

    // The pass survives the head's merge failure and lands the member behind it.
    const runs = await app.queue.run({}, runtime)
    expect(mergedShas(runs)).toEqual([SECOND_SHA])
    expect(runs.map((run) => [run.status, run.conclusion])).toEqual([
      ["completed", "failure"],
      ["completed", "success"],
    ])
    // The head's merge was attempted BEFORE the second member's first check,
    // and the second member was then checked at the unmoved base.
    const order = timeline(calls)
    expect(order).toEqual([...A_CHECKS, "merge:A", ...B_CHECKS, "merge:B"])
    expect(calls.filter((call) => call.head === SECOND_SHA).map((call) => call.base)).toEqual(
      [...CHECKS, "merge"].map(() => BASE),
    )
    // The refusal names the member, the merge run, the Job's code and its reason.
    const headId = derivedId(events, HEAD_BRANCH)
    const refused = rowsWith(events, "admission-head-merge-failed")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.level).toBe("warn")
    expect(refused[0]?.props).toMatchObject({
      pr: headId,
      branch: HEAD_BRANCH,
      run: runs[0]?.id,
      code: "merge-conflict",
      reason,
    })
    expect(String(refused[0]?.message)).toContain(reason)
    expect(String(refused[0]?.message)).toContain("the next member takes the turn")
    // No ERROR row: a merge verdict on the head's content is not a fault in the queue.
    expect(events.filter((event) => event.kind === "log" && event.level === "error")).toEqual([])
    log.end()
  }, 30_000)

  it("(d) CONTROL: record-lane members keep their stored-admission path — every check, then the merges", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    await using app = await createApp({ calls, log, movesBase: false })
    await submitBothRecorded(app)

    const runs = await app.queue.run({}, runtime)

    // The record lane's verdict is its stored admission record, which feeds
    // selection after the drain exactly as before: both members are checked,
    // then both merge. The merge-when-green rows never fire for a record.
    expect(mergedShas(runs)).toEqual([HEAD_SHA, SECOND_SHA])
    expect(timeline(calls)).toEqual([...A_CHECKS, ...B_CHECKS, "merge:A", "merge:B"])
    expect(rowsWith(events, "admission-head-green")).toEqual([])
    expect(rowsWith(events, "admission-head-merged")).toEqual([])
    log.end()
  }, 30_000)
})
