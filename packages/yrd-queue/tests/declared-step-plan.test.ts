/**
 * @failure A Queue plans from the step list a stored checkpoint carries instead of the list its configuration declares, so a newly declared check never executes and no restart can activate it.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal, type JournalCheckpoint } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  deriveRunMemberArgs,
  withMerge,
  withQueue,
  withStep,
  type DerivedRunMember,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

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
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => "2026-01-01T00:00:00.000Z", log: createLogger("t", [{ level: "silent" }]) },
  })
}

/** The branch's standing submit fact IS the delivery (S7 branch-is-change), and
 * the member the queue composes from it is derived here and HANDED to each run
 * below, which is what makes the run name exactly one member: this file's queue
 * plugin configures no `prNumberMint`, so a bare selectorless compose cannot
 * self-derive a ref-only branch and would run nothing at all. `mint` is per-JOURNAL: identities are reused by branch and a
 * reused id above the mint's high-water refuses, so a replaying second session
 * must carry the first session's mint. */
async function submit(
  app: Awaited<ReturnType<typeof createApp>>,
  branch: string,
  digit: string,
  mint: PrNumberMint,
): Promise<DerivedRunMember> {
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
  return deriveRunMemberArgs({ bays: app.state().bays, queues: app.state().queues, mint, branch })
}

/**
 * FOUR DELIBERATE REDS in this file (S7), all one src defect. The standalone
 * ADMISSION drain executes its own steps under the process/declared plan,
 * independently of the run's step authority, and the root run does not reuse
 * that verdict when a declared plan is in play. Observed, not inferred:
 *
 *   - "keeps an explicit --steps selection authoritative": ran
 *     ['check','review','check','merge'] for `steps: ["check","merge"]`. The
 *     admission ran the DECLARED plan's `review` even though the caller's step
 *     selection is supposed to be authoritative, then the root ran check+merge.
 *   - "runs the plan the base ref's config declares": ran
 *     ['check','check','review','merge'] — `check` executed twice, once as the
 *     admission and once in the root run.
 *   - "refuses a base ref that declares a step this process cannot execute":
 *     ran ['check'] where nothing may execute. The admission ran a check
 *     BEFORE the root run refused the unexecutable plan — the silent-partial
 *     execution 23192 records.
 *   - "executes a check the declared config added after the stored checkpoint":
 *     ran ['merge'] — the newly declared checks did not execute at all.
 *
 * Mechanism for the sharpest of them: in the compose, `explicitStepAuthority`
 * (`args.steps !== undefined`) empties `checked`, but `admissible` is gated on
 * `selectorless` alone. A run passing `steps` with no `prs` selector is still
 * selectorless, so `drainAdmissions` runs with `selection` undefined and never
 * sees `args.steps`. `derived-admission-execution.test.ts` pins the intended
 * contract for the matching-plan case: one admission, one invocation.
 *
 * Verified NOT a fixture artifact: threading a `prNumberMint` into the plugin
 * and letting the compose SELF-DERIVE the branch (the production path, no
 * caller-supplied `derived`) reproduces the double `check` identically.
 */
describe("declared step plan", () => {
  it("executes a check the declared config added after the stored checkpoint was written", async () => {
    const cache = checkpointJournal(createMemoryJournal())
    const id = ids()
    const ran: string[] = []
    const mint = volatilePrNumberMint()

    {
      await using first = await createApp(["check", "merge"], cache.journal, id, ran)
      const one = await submit(first, "topic/one", "1", mint)
      await first.queue.run({ derived: [one] }, runtime)
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

    const two = await submit(second, "topic/two", "2", mint)
    await second.queue.run({ derived: [two] }, runtime)
    expect(ran, "the newly declared check must run without a --steps flag").toEqual(["check", "review", "merge"])
    expect(second.queue.get("R2")?.steps.map((step) => step.name)).toEqual(["check", "review", "merge"])
  })

  it("names the plan that judged a run and where the plan came from", async () => {
    const ran: string[] = []
    const id = ids()
    const mint = volatilePrNumberMint()
    await using app = await createApp(["check", "review", "merge"], createMemoryJournal(), id, ran)

    const configured = await submit(app, "topic/configured", "1", mint)
    await app.queue.run({ derived: [configured] }, runtime)
    expect(app.state().queues.records.root?.entries?.[0]?.value?.stepSelection).toEqual({
      authority: "configured",
      source: "declared-at-base",
      steps: ["check", "review", "merge"],
    })

    const explicit = await submit(app, "topic/explicit", "2", mint)
    await app.queue.run({ derived: [explicit], steps: ["check", "merge"] }, runtime)
    expect(app.queue.get("R2")?.stepSelection).toMatchObject({ authority: "explicit", source: "explicit" })
  })

  it("runs the plan the base ref's config declares, recorded with its base and blob shas", async () => {
    const ran: string[] = []
    const blob = "c".repeat(40)
    await using app = await createApp(["check", "merge"], createMemoryJournal(), ids(), ran, () => ({
      configBlobSha: blob,
      steps: ["check", "review", "merge"],
    }))

    const declaredMember = await submit(app, "topic/declared", "1", volatilePrNumberMint())
    await app.queue.run({ derived: [declaredMember] }, runtime)

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
    const unknown = await submit(app, "topic/unknown", "1", volatilePrNumberMint())
    await expect(app.queue.run({ derived: [unknown] }, runtime)).rejects.toThrow(/publish/u)
    expect(ran, "nothing may execute under a plan this process cannot honour").toEqual([])
  })

  it("keeps an explicit --steps selection authoritative over the declared plan", async () => {
    const ran: string[] = []
    await using app = await createApp(["check", "review", "merge"], createMemoryJournal(), ids(), ran, () => ({
      configBlobSha: "e".repeat(40),
      steps: ["check", "review", "merge"],
    }))

    const explicit = await submit(app, "topic/explicit", "1", volatilePrNumberMint())
    await app.queue.run({ derived: [explicit], steps: ["check", "merge"] }, runtime)

    expect(ran).toEqual(["check", "merge"])
    expect(app.queue.get("R1")?.stepSelection).toMatchObject({ authority: "explicit", source: "explicit" })
  })
})
