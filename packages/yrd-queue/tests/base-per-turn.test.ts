/**
 * @failure A pass memoises its base at the start (`createBaseResolutionCycle`)
 * and forgets it only after its OWN merge (merge-when-green's `forget`). When
 * main moves for any OTHER reason — a direct root push, a merge by a previous
 * pass this pass composed against, a foreign carrier — every member already
 * checked at the old base is refused `stale-check` at merge AFTER all four
 * checks ran (measured 2026-09-01, pass 18:41-20:24: PR3153 and PR2462 lost
 * this way, 28 and 4 minutes of checks each), and members not yet dispatched
 * are checked at the stale base and refused the same way. The late-evening
 * rule that the root pin is pushed directly BETWEEN passes exists precisely to
 * dodge this; the L4 is that a pass must not need the courtesy.
 *
 * The rules under test:
 * 1. At the start of every drain turn the queue re-resolves its base from the
 *    ref (the read the top of a pass uses); on a move it forgets the memo,
 *    re-points the not-yet-dispatched members, and logs ONE INFO row
 *    `base-moved-between-turns` with old, new, and who moved it.
 * 2. A member green at X whose merge finds main at Y ≠ X is re-pointed at Y and
 *    re-checked on the next turn, keeping its position; the refusal row becomes
 *    an INFO `rechecked-at-moved-base` naming X, Y and the member.
 * 3. Nothing else changes: one member per turn at batch 1, merge-when-green as
 *    the turn's tail, and no external move ⇒ the merge-when-green timeline.
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
/** Where a direct push lands main while this pass is busy — nobody's merge run. */
const EXTERNAL = "e".repeat(40)
/** Named to sort FIRST in the admission order: the head. */
const HEAD_BRANCH = "issue/aaa-head"
const HEAD_SHA = "7".repeat(40)
/** The member behind it. */
const SECOND_BRANCH = "issue/zzz-second"
const SECOND_SHA = "8".repeat(40)
/** The merge commit each head lands as — and the base the member behind it is then checked at. */
const MERGED: Readonly<Record<string, string>> = { [HEAD_SHA]: "b".repeat(40), [SECOND_SHA]: "c".repeat(40) }
const CHECKS = ["typecheck", "manifest", "substrate", "tests"] as const
/** Every step callback records one of these, in invocation order — the pass's real timeline. */
type Call = Readonly<{ step: string; head: string; base: string }>
/** Bounds a spinning pass: a callback past this many calls throws instead of running forever. */
const CALL_CAP = 60
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
 * merge-when-green.test.ts's harness — four required checks ahead of the
 * merge, batch 1, a base that moves when a merge lands — plus the two things
 * this defect needs: the base can ALSO move under a step for a reason that is
 * nobody's merge run (`movedExternally`, a direct push landing while that
 * step ran), and the merge step behaves like the production one
 * (`validatePinnedCandidate`): a Candidate checked at a base that is no longer
 * where the ref points is refused `stale-check`, never merged.
 */
async function createApp(
  options: Readonly<{
    calls: Call[]
    log?: ReturnType<typeof createLogger>
    /** The sha a direct push moved the base to while this step ran, if any. */
    movedExternally?: (call: Call) => string | undefined
    /** A required check's verdict; success unless overridden. */
    checkVerdict?: (call: Call) => JobResult<CheckResult> | undefined
  }>,
) {
  let base = BASE
  const record = (call: Call): void => {
    options.calls.push(call)
    if (options.calls.length > CALL_CAP) throw new Error(`turn cap: ${String(CALL_CAP)} step callbacks exceeded`)
    const moved = options.movedExternally?.(call)
    if (moved !== undefined) base = moved
  }
  const checks = CHECKS.map((name) =>
    withStep(
      name,
      (input: StepExecution): JobResult<CheckResult> => {
        const call = { step: name, head: headOf(input), base: baseOf(input) }
        record(call)
        return options.checkVerdict?.(call) ?? { status: "completed", conclusion: "success", output: { checked: true } }
      },
      { revision: `${name}-v1`, output: CheckResultSchema },
    ),
  )
  const merge = withMerge(
    async (input: StepExecution): Promise<JobResult<IntegrationProof>> => {
      const head = headOf(input)
      const checked = baseOf(input)
      record({ step: "merge", head, base: checked })
      // The production merge reads the ref itself and refuses a Candidate
      // pinned at any other base (command.ts `validatePinnedCandidate`).
      if (checked !== base) {
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "stale-check", message: `queue 'main' moved from checked base '${checked}' to '${base}'` },
        }
      }
      base = mergedFor(head)
      return { status: "completed", conclusion: "success", output: { commit: mergedFor(head), baseSha: checked } }
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

/** Every row this pass logged whose props carry this refusal code. */
function rowsWithCode(events: readonly LogEvent[], code: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.code === code,
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

describe("the base is re-resolved every drain turn, and a member whose merge finds a moved base is re-checked there", () => {
  it("(a) main moves externally between turn 1 and turn 2: turn 2's member is checked at the NEW base, no stale-check, one base-moved row", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    // Turn 1 is the head's checks; its last check fails on content, and while
    // it ran a direct push moved main. Turn 2 is the second member's turn.
    await using app = await createApp({
      calls,
      log,
      movedExternally: (call) => (call.step === "tests" && call.head === HEAD_SHA ? EXTERNAL : undefined),
      checkVerdict: (call) =>
        call.step === "tests" && call.head === HEAD_SHA
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "tests-failed", message: "3 tests failed in packages/yrd-queue" },
            }
          : undefined,
    })
    await submitBothDerived(app)

    const runs = await app.queue.run({}, runtime)

    // The second member landed: it was checked at the base main had moved to,
    // and its merge found that same base. On the code before this rule it was
    // checked at the pass's memoised base and refused `stale-check` after all
    // four checks.
    expect(mergedShas(runs)).toEqual([SECOND_SHA])
    expect(timeline(calls)).toEqual([...A_CHECKS, ...B_CHECKS, "merge:B"])
    expect(calls.filter((call) => call.head === SECOND_SHA).map((call) => call.base)).toEqual(
      [...CHECKS, "merge"].map(() => EXTERNAL),
    )
    expect(rowsWithCode(events, "stale-check")).toEqual([])
    // ONE INFO row says the base moved between turns, from what to what, and
    // that no run in this journal is the mover.
    const moved = rowsWith(events, "base-moved-between-turns")
    expect(moved).toHaveLength(1)
    expect(moved[0]?.level).toBe("info")
    expect(moved[0]?.props).toMatchObject({ base: "main", from: BASE, to: EXTERNAL, movedBy: "external" })
    expect(rowsWith(events, "rechecked-at-moved-base")).toEqual([])
    expect(events.filter((event) => event.kind === "log" && event.level === "error")).toEqual([])
    log.end()
  }, 30_000)

  it("(b) a member checked at X whose merge sees Y is re-checked at Y on the next turn, keeping its position, and then merges", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    // A direct push moves main while the head's LAST check runs at the starting
    // base, so the head is green at X and its merge finds Y.
    await using app = await createApp({
      calls,
      log,
      movedExternally: (call) =>
        call.step === "tests" && call.head === HEAD_SHA && call.base === BASE ? EXTERNAL : undefined,
    })
    await submitBothDerived(app)

    const runs = await app.queue.run({}, runtime)

    // Both landed, head first: the head was re-checked at Y and merged there
    // BEFORE the second member's first check — it kept its position. Before
    // this rule the head was refused `stale-check`, released, and the second
    // member was checked at X and refused the same way: nothing merged.
    expect(mergedShas(runs)).toEqual([HEAD_SHA, SECOND_SHA])
    expect(timeline(calls)).toEqual([...A_CHECKS, "merge:A", ...A_CHECKS, "merge:A", ...B_CHECKS, "merge:B"])
    const headBases = calls.filter((call) => call.head === HEAD_SHA).map((call) => call.base)
    expect(headBases).toEqual([...CHECKS.map(() => BASE), BASE, ...CHECKS.map(() => EXTERNAL), EXTERNAL])
    // The second member's checks and merge ran at the base the head's merge moved main to.
    expect(calls.filter((call) => call.head === SECOND_SHA).map((call) => call.base)).toEqual(
      [...CHECKS, "merge"].map(() => mergedFor(HEAD_SHA)),
    )
    expect(runs.flatMap((run) => (run.integration === undefined ? [] : [run.integration]))).toEqual([
      { commit: mergedFor(HEAD_SHA), baseSha: EXTERNAL },
      { commit: mergedFor(SECOND_SHA), baseSha: mergedFor(HEAD_SHA) },
    ])
    // The refusal row became an INFO row naming the member, X, Y and the merge run that found Y.
    const headId = derivedId(events, HEAD_BRANCH)
    const rechecked = rowsWith(events, "rechecked-at-moved-base")
    expect(rechecked).toHaveLength(1)
    expect(rechecked[0]?.level).toBe("info")
    expect(rechecked[0]?.props).toMatchObject({
      pr: headId,
      branch: HEAD_BRANCH,
      run: runs[0]?.id,
      from: BASE,
      to: EXTERNAL,
    })
    expect(rowsWith(events, "admission-head-merge-failed")).toEqual([])
    // The re-check's Jobs are keyed at Y: the durable fact a later pass reads
    // to know which base the head was proven on (and reuses, never re-runs).
    for (const [index, name] of CHECKS.entries()) {
      expect(app.state().jobs.byKey[`admission:${headId}:1:${EXTERNAL}:${String(index)}:${name}-v1`]).toBeDefined()
    }
    expect(events.filter((event) => event.kind === "log" && event.level === "error")).toEqual([])
    log.end()
  }, 30_000)

  it("(c) CONTROL: no external move — the merge-when-green timeline, and neither row fires", async () => {
    const calls: Call[] = []
    const events: LogEvent[] = []
    const log = capturingLog(events)
    await using app = await createApp({ calls, log })
    await submitBothDerived(app)

    const runs = await app.queue.run({}, runtime)

    expect(mergedShas(runs)).toEqual([HEAD_SHA, SECOND_SHA])
    expect(timeline(calls)).toEqual([...A_CHECKS, "merge:A", ...B_CHECKS, "merge:B"])
    // The pass's OWN merge moves the base, and that move is merge-when-green's
    // (`admission-head-merged`), not a move between turns.
    expect(rowsWith(events, "base-moved-between-turns")).toEqual([])
    expect(rowsWith(events, "rechecked-at-moved-base")).toEqual([])
    expect(rowsWith(events, "admission-head-merged")).toHaveLength(2)
    expect(events.filter((event) => event.kind === "log" && event.level === "error")).toEqual([])
    log.end()
  }, 30_000)
})
