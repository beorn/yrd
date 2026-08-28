/**
 * @failure A queued run whose not-yet-started next step drifts from the installed step revision throws `command-refused` at the advance path, killing the selectorless habitant compose instead of releasing the run for a fresh re-admission.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  deriveRunMemberArgs,
  withStep,
  withQueue,
  Queues,
  type DerivedRunMember,
  type StepExecution,
} from "@yrd/queue"

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
  return withQueue({
    steps: [first, second] as const,
    batch: false,
    defaultSteps: ["first", "second"],
    resolveBaseSha: () => BASE,
  })
}

async function createApp(secondRevision: string, journal = createMemoryJournal(), id: () => string = ids()) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = twoStepPlugin(secondRevision)
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
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

/** The branch's standing submit fact IS the delivery (S7 branch-is-change);
 * the member the queue would compose from it is derived here so the low-level
 * `queue.run` dispatch below can name exactly one. */
async function submitBranch(
  app: Awaited<ReturnType<typeof createApp>>,
  branch: string,
): Promise<DerivedRunMember> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: volatilePrNumberMint(),
    branch,
  })
}

/** Re-derive an already-run branch's member so an explicit re-admission can
 * name it. Post-S7 a bare `prs: ["PR1"]` no longer resolves: `explicitPRs`
 * looks selectors up in the materialized derived batch, and only a
 * SELECTORLESS compose derives on its own. The id is reused from the run
 * snapshot, so the mint must already stand at that high-water. */
function rederive(app: Awaited<ReturnType<typeof createApp>>, branch: string): DerivedRunMember {
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: volatilePrNumberMint(1),
    branch,
  })
}

describe("stale-steps release — a drifted next step frees the run instead of killing compose", () => {
  it("releases a pending run whose not-yet-started next step revision drifted, keeping the change submitted", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const member = await submitBranch(app, "issue/stale-next-step")
      // `prs: []` beside a non-empty `derived` selects exactly those derived
      // members — the post-S7 spelling of naming one member explicitly.
      await app.dispatch(app.commands.queue.run, {
        prs: [],
        derived: [member],
        steps: ["first", "second"],
        baseSha: BASE,
      })
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
    // Authority released and the branch approval survives the release — the
    // derived lane's "stays submitted", so it re-admits fresh.
    expect(replayed.state().queues.authority.runs).toBeDefined()
    expect(replayed.state().bays.submits["issue/stale-next-step"]).toMatchObject({ sha: "1".repeat(40) })
  })

  it("releases a queued current step whose requested Job revision drifted before execution", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const member = await submitBranch(app, "issue/stale-current-step")
      await app.dispatch(app.commands.queue.run, {
        prs: [],
        derived: [member],
        steps: ["first", "second"],
        baseSha: BASE,
      })
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
    await expect(
      replayed.queue.run({ derived: [rederive(replayed, "issue/stale-current-step")] }, runtime),
    ).resolves.toBeDefined()
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: expect.objectContaining({ code: "stale-steps" }),
    })
    expect(replayed.state().bays.submits["issue/stale-current-step"]).toMatchObject({ sha: "1".repeat(40) })

    const readmitted = await replayed.queue.run(
      { derived: [rederive(replayed, "issue/stale-current-step")] },
      runtime,
    )
    expect(readmitted.at(-1)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(Queues.ids(replayed.state().queues)).toContain("R2")
  })

  it("queue recover reports and releases a queued current step with a stale Job revision", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const member = await submitBranch(app, "issue/recover-stale-current-step")
      await app.dispatch(app.commands.queue.run, {
        prs: [],
        derived: [member],
        steps: ["first", "second"],
        baseSha: BASE,
      })
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
    expect(replayed.state().bays.submits["issue/recover-stale-current-step"]).toMatchObject({ sha: "1".repeat(40) })
  })

  it("re-admits the still-submitted PR under the installed config after a stale-steps release", async () => {
    const journal = createMemoryJournal()
    const id = ids()

    {
      await using app = await createApp("second-v1", journal, id)
      const member = await submitBranch(app, "issue/stale-then-readmit")
      await app.dispatch(app.commands.queue.run, {
        prs: [],
        derived: [member],
        steps: ["first", "second"],
        baseSha: BASE,
      })
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
    const readmitted = await replayed.queue.run(
      { derived: [rederive(replayed, "issue/stale-then-readmit")], steps: ["first", "second"] },
      runtime,
    )
    expect(readmitted.at(-1)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(Queues.ids(replayed.state().queues)).toContain("R2")
  })
})
