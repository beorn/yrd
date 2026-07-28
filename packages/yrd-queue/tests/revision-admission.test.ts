/**
 * @failure Admission is modeled as a Queue Run, so one PR revision produces an
 * admission row and a landing row instead of owning one revision-bound verdict.
 * @level l2
 * @consumer @yrd/queue revision admission
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, currentPRRev, prDeliveryState, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withQueue, withStep, type PRShape, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MOVED_BASE = "b".repeat(40)
const LANDED = "c".repeat(40)
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

async function createApp(
  check: (input: StepExecution<PRShape>) => JobResult<{ checked: boolean }>,
  resolveBaseSha: () => string,
) {
  const checkStep = withStep("check", check, {
    revision: "check-v1",
    output: CheckResultSchema,
  })
  const mergeStep = withMerge(
    () => ({
      status: "completed",
      conclusion: "success",
      output: { commit: LANDED, baseSha: resolveBaseSha() },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [checkStep, mergeStep] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha,
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-07-27T20:35:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

async function submit(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  await app.bays.submit({ branch: "task/revision-admission", headSha: HEAD, base: "main", baseSha: BASE })
  const pr = app.bays.pr("task/revision-admission")
  if (pr === undefined) throw new Error("PR was not recorded")
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr.id
}

describe("revision-owned admission", () => {
  it("records a ready verdict on the PR revision and mints only the landing Queue Run", async () => {
    let checks = 0
    await using app = await createApp(
      () => {
        checks += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      () => BASE,
    )
    const pr = await submit(app)

    expect(prDeliveryState(app.bays.pr(pr)!)).toBe("submitted")
    await app.queue.admitRevision({ prs: [pr] }, runtime)

    expect(checks).toBe(1)
    expect(prDeliveryState(app.bays.pr(pr)!)).toBe("ready")
    expect(currentPRRev(app.bays.pr(pr)!)).toMatchObject({
      admission: {
        status: "passed",
        baseSha: BASE,
        steps: [{ name: "check", revision: "check-v1", status: "passed", output: { checked: true } }],
      },
    })
    expect(await app.queue.history()).toEqual([])

    const landed = await app.queue.run({ prs: [pr] }, runtime)

    expect(landed).toHaveLength(1)
    expect(landed[0]).toMatchObject({
      id: "R1",
      steps: [{ name: "merge" }],
      integration: { commit: LANDED, baseSha: BASE },
    })
    expect(checks).toBe(1)
    expect((await app.queue.history()).map((run) => run.id)).toEqual(["R1"])
  })

  it("revalidates revision admission without minting a check Run when the landing base moved", async () => {
    let base = BASE
    let checks = 0
    await using app = await createApp(
      () => {
        checks += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      () => base,
    )
    const pr = await submit(app)
    await app.queue.admitRevision({ prs: [pr] }, runtime)

    base = MOVED_BASE
    const landed = await app.queue.run({ prs: [pr] }, runtime)

    expect(checks).toBe(2)
    expect(currentPRRev(app.bays.pr(pr)!)).toMatchObject({
      admission: { status: "passed", baseSha: MOVED_BASE },
    })
    expect(landed).toHaveLength(1)
    expect(landed[0]).toMatchObject({ id: "R1", steps: [{ name: "merge" }] })
    expect((await app.queue.history()).map((run) => run.id)).toEqual(["R1"])
  })

  it("records the typed refusal on the revision without minting a Queue Run", async () => {
    await using app = await createApp(
      () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "typecheck found an authored error" },
      }),
      () => BASE,
    )
    const pr = await submit(app)

    await app.queue.admitRevision({ prs: [pr] }, runtime)

    expect(prDeliveryState(app.bays.pr(pr)!)).toBe("needs-author")
    expect(currentPRRev(app.bays.pr(pr)!)).toMatchObject({
      admission: {
        status: "refused",
        baseSha: BASE,
        step: "check",
        receipt: { code: "check-failed", message: "typecheck found an authored error" },
      },
    })
    expect(app.queue.eligibility(pr)).toMatchObject({
      runnable: false,
      reason: {
        code: "needs-author",
        receipt: { code: "check-failed", message: "typecheck found an authored error" },
      },
      checks: { status: "failed" },
    })
    expect(await app.queue.history()).toEqual([])
  })
})
