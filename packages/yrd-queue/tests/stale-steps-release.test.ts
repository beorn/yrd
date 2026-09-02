/**
 * @failure A queued run whose not-yet-started next step drifts from the installed step revision throws `command-refused` at the advance path, killing the selectorless habitant compose instead of releasing the run for a fresh re-admission.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, changeDeliveryState, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withStep, withQueue, Queues, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const FirstResultSchema = z.object({ first: z.boolean() }).strict()
const SecondResultSchema = z.object({ second: z.boolean() }).strict()

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

/** Two plain (non-integrating) steps; the SECOND step's revision is caller-tunable
 * so a replay under a bumped revision reproduces the "installed step revision
 * moved out from under a pending run" drift at the advance path. */
function twoStepPlugin(secondRevision: string) {
  const first = withStep(
    "first",
    (): JobResult<{ first: boolean }> => ({ status: "completed", conclusion: "success", output: { first: true } }),
    { revision: "first-v1", output: FirstResultSchema },
  )
  const second = withStep(
    "second",
    (_input: StepExecution): JobResult<{ second: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { second: true },
    }),
    { revision: secondRevision, output: SecondResultSchema },
  )
  return withQueue({ steps: [first, second] as const, batch: false, defaultSteps: ["first", "second"] })
}

async function createApp(secondRevision: string, journal = createMemoryJournal(), id: () => string = ids()) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = twoStepPlugin(secondRevision)
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal,
      id,
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

describe("stale-steps release — a drifted next step frees the run instead of killing compose", () => {
  it("releases a pending run whose not-yet-started next step revision drifted, keeping the change submitted", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const pr = await submitBranch(app, "issue/stale-next-step")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first", "second"] })
      const firstJob = app.queue.get("R1")?.steps[0]?.job
      if (firstJob === undefined) throw new Error("expected requested first step")
      await app.jobs.run(firstJob.id, runtime)
      // First passed; the SECOND step was never requested — that is the pending
      // boundary the drift merges on when the config moves.
      expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("completed")
      expect(app.queue.get("R1")?.steps[1]?.job).toBeUndefined()
    }

    // Replay under a bumped `second` revision: advancing R1 must NOT throw
    // `command-refused`; it releases R1 as a typed stale-steps failure.
    await using replayed = await createApp("second-v2", journal, id)
    await expect(replayed.dispatch(replayed.commands.queue.advance, { run: "R1" })).resolves.toBeDefined()

    expect(replayed.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: expect.objectContaining({ code: "stale-steps" }),
    })
    // Authority released and the change stays submitted, so it re-admits fresh.
    expect(replayed.state().queues.authority.runs).toBeDefined()
    expect(changeDeliveryState(replayed.state().bays.prs.PR1!)).toBe("submitted")
  })

  it("releases a queued current step whose requested Job revision drifted before execution", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const pr = await submitBranch(app, "issue/stale-current-step")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first", "second"] })
      const firstJob = app.queue.get("R1")?.steps[0]?.job
      if (firstJob === undefined) throw new Error("expected requested first step")
      await app.jobs.run(firstJob.id, runtime)
      await app.dispatch(app.commands.queue.advance, { run: "R1" })
      expect(app.queue.get("R1")?.steps[1]?.job).toMatchObject({
        status: "queued",
        revision: "second-v1",
      })
    }

    // Replay after the requested current Job's definition moved. The habitant
    // compose path must retire R1 before Jobs.run sees the stale revision.
    await using replayed = await createApp("second-v2", journal, id)
    await expect(replayed.queue.run({ prs: ["PR1"] }, runtime)).resolves.toBeDefined()
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: expect.objectContaining({ code: "stale-steps" }),
    })
    expect(changeDeliveryState(replayed.state().bays.prs.PR1!)).toBe("submitted")

    // ONE pass, not two (24030): the release happens at the pass START, before
    // the compose selects, so the same pass re-admits the still-submitted PR
    // under the installed config and runs it to success as R2. A second pass
    // finds that revision already covered and composes nothing new.
    expect(Queues.ids(replayed.state().queues)).toContain("R2")
    expect(replayed.queue.get("R2")).toMatchObject({ status: "completed", conclusion: "success" })
    await expect(replayed.queue.run({ prs: ["PR1"] }, runtime)).resolves.toEqual([])
  })

  it("queue recover reports and releases a queued current step with a stale Job revision", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const pr = await submitBranch(app, "issue/recover-stale-current-step")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first", "second"] })
      const firstJob = app.queue.get("R1")?.steps[0]?.job
      if (firstJob === undefined) throw new Error("expected requested first step")
      await app.jobs.run(firstJob.id, runtime)
      await app.dispatch(app.commands.queue.advance, { run: "R1" })
    }

    await using replayed = await createApp("second-v2", journal, id)
    expect(replayed.queue.audit().findings).toMatchObject([
      expect.objectContaining({ code: "step-revision-drift", run: "R1", step: "second" }),
    ])

    const recovered = await replayed.queue.recover({
      recoveryTime: "2026-01-01T00:05:00.000Z",
      reason: "operator recovery",
    })
    expect(recovered).toMatchObject([
      {
        id: "R1",
        status: "completed",
        conclusion: "failure",
        error: expect.objectContaining({ code: "stale-steps" }),
      },
    ])
    expect(replayed.queue.audit().findings).not.toContainEqual(
      expect.objectContaining({ code: "step-revision-drift", run: "R1" }),
    )
    expect(changeDeliveryState(replayed.state().bays.prs.PR1!)).toBe("submitted")
  })

  it("re-admits the still-submitted PR under the installed config after a stale-steps release", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const pr = await submitBranch(app, "issue/stale-then-readmit")
      await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first", "second"] })
      const firstJob = app.queue.get("R1")?.steps[0]?.job
      if (firstJob === undefined) throw new Error("expected requested first step")
      await app.jobs.run(firstJob.id, runtime)
    }

    await using replayed = await createApp("second-v2", journal, id)
    await replayed.dispatch(replayed.commands.queue.advance, { run: "R1" })
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: expect.objectContaining({ code: "stale-steps" }),
    })

    // A fresh explicit run composes a NEW run under the installed (v2) revision.
    const readmitted = await replayed.queue.run({ prs: ["PR1"], steps: ["first", "second"] }, runtime)
    expect(readmitted.at(-1)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(Queues.ids(replayed.state().queues)).toContain("R2")
  })
})
