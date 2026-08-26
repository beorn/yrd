/**
 * @failure A Queue plans from the step list a stored checkpoint carries instead of the list its configuration declares, so a newly declared check never executes and no restart can activate it.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal, type JournalCheckpoint } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withQueue, withStep, type IntegrationProof, type StepExecution } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const OkSchema = z.object({ ok: z.boolean() }).strict()

type StepName = "check" | "review" | "merge"

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

/** A journal that stores exactly one checkpoint and hands it back only to a
 * projection whose identity matches — the real store's contract, and the seam
 * this suite needs to prove that a config edit reuses the SAME checkpoint. */
function checkpointJournal(base: Journal<unknown>) {
  let stored: JournalCheckpoint | undefined
  const loads: string[] = []
  const journal: Journal<unknown> = {
    read: (after = 0, before?: number) => base.read(after, before),
    append: (value, expectedCursor) => base.append(value, expectedCursor),
    checkpoint: {
      load(identity) {
        loads.push(identity)
        return Promise.resolve(stored?.identity === identity ? structuredClone(stored) : undefined)
      },
      save(checkpoint) {
        stored = structuredClone(checkpoint)
        return Promise.resolve(true)
      },
    },
  }
  return {
    journal,
    loads,
    stored: () => stored,
    /** Rewrite the stored checkpoint's queue step list WITHOUT touching its
     * identity — a checkpoint written before the declared plan became the
     * authority, which is exactly the shape that silently won. */
    setStoredDefaultSteps(steps: readonly StepName[]) {
      const value = stored?.value as { state?: { queues?: Record<string, unknown> } } | undefined
      const queues = value?.state?.queues
      if (queues === undefined) throw new Error("no stored checkpoint to rewrite")
      queues.defaultSteps = [...steps]
    },
  }
}

function queuePlugin(
  declared: readonly StepName[],
  ran: string[],
  resolveDeclaredPlan?: (baseSha: string) => { configBlobSha: string; steps: readonly string[] },
) {
  const check = withStep(
    "check",
    (): JobResult<{ ok: boolean }> => {
      ran.push("check")
      return { status: "completed", conclusion: "success", output: { ok: true } }
    },
    { revision: "check-v1", output: OkSchema },
  )
  const review = withStep(
    "review",
    (_input: StepExecution): JobResult<{ ok: boolean }> => {
      ran.push("review")
      return { status: "completed", conclusion: "success", output: { ok: true } }
    },
    { revision: "review-v1", output: OkSchema },
  )
  const merge = withMerge(
    (_input: StepExecution): JobResult<IntegrationProof> => {
      ran.push("merge")
      return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
    },
    { revision: "merge-v1" },
  )
  return withQueue({
    steps: [check, review, merge] as const,
    batch: false,
    defaultSteps: declared,
    resolveBaseSha: () => BASE,
    ...(resolveDeclaredPlan === undefined ? {} : { resolveDeclaredPlan }),
  })
}

async function createApp(
  declared: readonly StepName[],
  journal: Journal<unknown>,
  id: () => string,
  ran: string[],
  resolveDeclaredPlan?: (baseSha: string) => { configBlobSha: string; steps: readonly string[] },
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = queuePlugin(declared, ran, resolveDeclaredPlan)
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => "2026-01-01T00:00:00.000Z", log: createLogger("t", [{ level: "silent" }]) },
  })
}

async function submit(app: Awaited<ReturnType<typeof createApp>>, branch: string, digit: string) {
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr.id
}

describe("declared step plan", () => {
  it("executes a check the declared config added after the stored checkpoint was written", async () => {
    const cache = checkpointJournal(createMemoryJournal())
    const id = ids()
    const ran: string[] = []

    {
      await using first = await createApp(["check", "merge"], cache.journal, id, ran)
      await first.queue.run({ prs: [await submit(first, "topic/one", "1")] }, runtime)
      expect(ran).toEqual(["check", "merge"])
    }
    const storedIdentity = cache.stored()?.identity
    expect(storedIdentity, "the first session must have written a checkpoint").toBeDefined()

    ran.length = 0
    await using second = await createApp(["check", "review", "merge"], cache.journal, id, ran)
    // The declared check set is not a projection schema: widening it must reuse
    // the SAME checkpoint, because discarding it forces a full replay that a
    // journal with an evicted prefix cannot serve.
    expect(cache.loads.at(-1), "a .yrd.yml checks edit must not move the projection identity").toBe(storedIdentity)

    await second.queue.run({ prs: [await submit(second, "topic/two", "2")] }, runtime)
    expect(ran, "the newly declared check must run without a --steps flag").toEqual(["check", "review", "merge"])
    expect(second.queue.get("R2")?.steps.map((step) => step.name)).toEqual(["check", "review", "merge"])
  })

  it("names the plan that judged a run and where the plan came from", async () => {
    const ran: string[] = []
    const id = ids()
    await using app = await createApp(["check", "review", "merge"], createMemoryJournal(), id, ran)

    await app.queue.run({ prs: [await submit(app, "topic/configured", "1")] }, runtime)
    expect(app.state().queues.records.root?.entries?.[0]?.value?.stepSelection).toEqual({
      authority: "configured",
      source: "declared-at-base",
      steps: ["check", "review", "merge"],
    })

    await app.queue.run({ prs: [await submit(app, "topic/explicit", "2")], steps: ["check", "merge"] }, runtime)
    expect(app.queue.get("R2")?.stepSelection).toMatchObject({ authority: "explicit", source: "explicit" })
  })

  it("runs the plan the base ref's config declares, recorded with its base and blob shas", async () => {
    const ran: string[] = []
    const blob = "c".repeat(40)
    await using app = await createApp(["check", "merge"], createMemoryJournal(), ids(), ran, () => ({
      configBlobSha: blob,
      steps: ["check", "review", "merge"],
    }))

    await app.queue.run({ prs: [await submit(app, "topic/declared", "1")] }, runtime)

    // The process was constructed declaring two steps; the base ref declares
    // three. Git is the authority, so three run.
    expect(ran).toEqual(["check", "review", "merge"])
    expect(app.queue.get("R1")?.stepSelection).toMatchObject({
      source: "declared-at-base",
      baseSha: BASE,
      configBlobSha: blob,
      steps: ["check", "review", "merge"],
    })
  })

  it("refuses a base ref that declares a step this process cannot execute", async () => {
    const ran: string[] = []
    await using app = await createApp(["check", "merge"], createMemoryJournal(), ids(), ran, () => ({
      configBlobSha: "d".repeat(40),
      steps: ["check", "publish", "merge"],
    }))

    // Steps carry their runner-bound Job, registered when the process was
    // built. A step the base ref declares but this process never installed has
    // nothing to execute, and running the rest silently is exactly the defect
    // 23192 records — so the run refuses and names what is missing.
    await expect(app.queue.run({ prs: [await submit(app, "topic/unknown", "1")] }, runtime)).rejects.toThrow(/publish/u)
    expect(ran, "nothing may execute under a plan this process cannot honour").toEqual([])
  })

  it("keeps an explicit --steps selection authoritative over the declared plan", async () => {
    const ran: string[] = []
    await using app = await createApp(["check", "review", "merge"], createMemoryJournal(), ids(), ran, () => ({
      configBlobSha: "e".repeat(40),
      steps: ["check", "review", "merge"],
    }))

    await app.queue.run({ prs: [await submit(app, "topic/explicit", "1")], steps: ["check", "merge"] }, runtime)

    expect(ran).toEqual(["check", "merge"])
    expect(app.queue.get("R1")?.stepSelection).toMatchObject({ authority: "explicit", source: "explicit" })
  })
})
