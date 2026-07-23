/**
 * @failure A single poisoned candidate (a stuck run whose drifted post-merge step refuses the advance) aborts the WHOLE selectorless compose and kills the resident, instead of being skipped loud so the rest of the drain proceeds.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withStep, withQueue, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const DeployResultSchema = z.object({ environment: z.string() }).strict()

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({ status: "passed", output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE } }),
    refresh: (input) => ({
      status: "passed",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    deprovision: () => ({ status: "passed", output: {} }),
  }
}

/** merge (integrates) + deploy (needsIntegration) with a caller-tunable deploy
 * revision, so a replay under a bumped deploy revision leaves R1 stuck AFTER the
 * merge integrated but BEFORE the drifted deploy — the throw that must be skipped
 * (not fatal) in a selectorless compose. */
function mergeDeployPlugin(deployRevision: string) {
  const merge = withMerge(
    (): JobResult<{ commit: string; baseSha: string }> => ({ status: "passed", output: { commit: MERGED, baseSha: BASE } }),
    { revision: "merge-v1" },
  )
  const deploy = withStep(
    "deploy",
    (_input: StepExecution): JobResult<{ environment: string }> => ({ status: "passed", output: { environment: "staging" } }),
    { revision: deployRevision, needsIntegration: true, output: DeployResultSchema },
  )
  return withQueue({ steps: [merge, deploy] as const, batch: false, defaultSteps: ["merge", "deploy"] })
}

async function createApp(
  deployRevision: string,
  journal = createMemoryJournal(),
  id: () => string = ids(),
  log?: ReturnType<typeof createLogger>,
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = mergeDeployPlugin(deployRevision)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => "2026-01-01T00:00:00.000Z", ...(log === undefined ? {} : { log }) },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

/** Seed R1 with a passed merge whose deploy step was never requested, then reopen
 * under a bumped deploy revision so advancing R1 refuses (the integrated boundary
 * keeps frozen semantics — the drift stays a loud throw, unlike the pre-merge
 * stale-steps release). */
async function seedStuckRun(deployRevision: string, journal: ReturnType<typeof createMemoryJournal>, id: () => string) {
  await using app = await createApp("deploy-v1", journal, id)
  const pr = await submitBranch(app, "issue/stuck-post-merge")
  await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["merge", "deploy"] })
  const mergeJob = app.queue.get("R1")?.steps[0]?.job
  if (mergeJob === undefined) throw new Error("expected requested merge")
  await app.jobs.run(mergeJob.id, runtime)
  expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("passed")
  expect(app.queue.get("R1")?.steps[1]?.job).toBeUndefined()
}

describe("compose candidate isolation — one poisoned candidate never aborts the whole selectorless drain", () => {
  it("skips a poisoned resumable run with a loud warn and keeps the compose alive", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    await seedStuckRun("deploy-v2", journal, id)

    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using replayed = await createApp("deploy-v2", journal, id, log)

    // The selectorless compose survives — it does NOT throw the command-refused
    // that would otherwise kill the resident.
    await expect(replayed.queue.run({}, runtime)).resolves.toBeDefined()

    const skips = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.namespace === "yrd:queue",
    )
    const skip = skips.find((event) => event.props?.action === "compose-candidate-skip")
    expect(skip, "expected a compose-candidate-skip warn").toBeDefined()
    expect(skip?.props).toMatchObject({ action: "compose-candidate-skip", run: "R1", code: "command-refused" })
    expect(String(skip?.props?.reason)).toContain("deploy")
    log.end()
  })

  it("still fails loud for a one-shot targeted run of the same poisoned candidate", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    await seedStuckRun("deploy-v2", journal, id)

    await using replayed = await createApp("deploy-v2", journal, id)
    // An explicit selector compose names its single target — it is NOT selectorless,
    // so the candidate-skip tolerance never applies: any refusal touching the target
    // propagates (fail-loud) instead of being swallowed. The raw advance proves the
    // underlying drift refusal is real and loud.
    await expect(replayed.queue.run({ prs: ["PR1"], steps: ["merge", "deploy"] }, runtime)).rejects.toThrow()
    await expect(replayed.dispatch(replayed.commands.queue.advance, { run: "R1" })).rejects.toThrow(
      "does not match installed revision",
    )
  })
})
