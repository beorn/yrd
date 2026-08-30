/**
 * @failure One member's checks-before-queueing preparation raises an
 * INFRASTRUCTURE fact (an environment fault, not a verdict about the
 * change), and the whole pass aborts: `dispatchAdmissions`'s per-selector
 * catch absorbed only a "refusal"-kind fact, so an "infrastructure"-kind
 * fact rethrows past the `compose-candidate-skip` warn and the
 * refusal-ledger write, escaping the enclosing `for` loop. Every selector
 * BEHIND the raising one in the same pass was left with zero checking
 * attempts and zero ledger rows — indistinguishable from never having been
 * submitted (@i/10-yrd/checks-survive-one-raise).
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import {
  changeAdmission,
  createBayJobDefs,
  withBays,
  volatilePrNumberMint,
  type BayWorkspace,
  type Change,
} from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { candidateRefFor, withQueue, withStep, type CandidatePreparer, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
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

/** Check-only plan: every configured step is checks-before-queueing work, so
 * a raise here surfaces from `dispatchAdmissions` — the pass this bead
 * covers, never the later merge/compose isolation `compose-candidate-
 * isolation.test.ts` already guards. */
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

async function createApp(prepareCandidate: CandidatePreparer, log?: ReturnType<typeof createLogger>) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = checkOnlyPlugin(prepareCandidate)
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
      log: log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

async function submitAndRequestChecks(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (app.bays.prs().length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = app.bays.prs().find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr
}

/** A Candidate preparer that raises an INFRASTRUCTURE fact for one change
 * forever — an unreachable submodule origin, a network blip: a fact about
 * the ENVIRONMENT, never a verdict about the change's content. Every other
 * change composes cleanly, mirroring `refuseForever` in
 * admission-refusal-oracle.test.ts but for the "infrastructure" kind that
 * sibling never exercises. */
function raiseInfrastructureForever(blocked: () => string): CandidatePreparer {
  return (input) => {
    if (input.prs.some((pr) => pr.id === blocked())) {
      throw createFailure({
        kind: "infrastructure",
        code: "unreachable-submodule-origin",
        message: `yrd: change '${blocked()}' could not resolve its submodule origin`,
      })
    }
    const { prs: _prs, ...candidate } = input
    return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
  }
}

describe("a checks-before-queueing pass survives one infrastructure raise", () => {
  it("parks the raising member with a durable finding and still gives the selector behind it its own attempt", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    let blocked = ""
    const app = await createApp(
      raiseInfrastructureForever(() => blocked),
      log,
    )

    const first = await submitAndRequestChecks(app, "issue/first")
    const second = await submitAndRequestChecks(app, "issue/second")
    const third = await submitAndRequestChecks(app, "issue/third")
    blocked = second.id

    const admissionOf = (id: string) => {
      const pr = app.state().bays.prs[id]
      if (pr === undefined) throw new Error(`PR was not recorded: ${id}`)
      return changeAdmission(pr as Change)
    }

    // Pre-fix this pass rejects with the raw infrastructure fact and never
    // reaches `third` at all; post-fix it resolves (check-only plan mints no
    // Run records, so `[]` is the correct settled shape either way once it
    // stops throwing).
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // The raising member is parked with a durable, distinguishable finding —
    // never silently relabeled as a verdict about the change's content.
    expect(app.state().queues.admissionRefusals[second.id]).toMatchObject({
      pr: second.id,
      code: "unreachable-submodule-origin",
      kind: "infrastructure",
      count: 1,
    })
    const skip = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.level === "warn" &&
        event.props?.action === "compose-candidate-skip" &&
        event.props?.pr === second.id,
    )
    expect(skip?.props).toMatchObject({ code: "unreachable-submodule-origin", kind: "infrastructure" })

    // The member-level rethrow policy is unchanged: the change's own
    // admission record still carries the raw infrastructure fact, never a
    // refusal-typed verdict.
    expect(admissionOf(second.id)).toMatchObject({ status: "refused", kind: "infrastructure" })

    // Every selector BEHIND the raising one still got its own checking
    // attempt — the measured defect was zero admission Jobs, indistinguishable
    // from never having been submitted. (`first`, ahead of the raise, was
    // never at risk; asserting it too proves the fix costs it nothing.)
    expect(admissionOf(first.id)).toMatchObject({ status: "passed" })
    expect(admissionOf(third.id)).toMatchObject({ status: "passed" })

    log.end()
  })
})
