/**
 * @failure An intent whose landing is refused by the ENVIRONMENT — a candidate
 *          workspace that cannot be provisioned, a check launcher that never
 *          produces a verdict — retries forever at the head of the intent lane.
 *
 *          These refusals are marked retryable and RELEASE the run's queue
 *          authority, so the `queue/run/failed` frame carries no `job` and the
 *          run's failure is projected rather than owned by a step. That is a
 *          different shape from the deterministic check failure the parking
 *          budget was written against, and it looks exactly like a shape a
 *          budget would skip. It is not skipped, and these tests are what says
 *          so: parking reads the run's own failure, so the released-authority
 *          path fingerprints and counts like any other.
 *
 *          Written because yrdpin#215 burned seven identical
 *          `candidate-provision-failed` attempts in ten minutes on 2026-08-14
 *          (runs R2303-R2309) and was cleared by a human withdrawal, which read
 *          as a hole in this budget. It was not one — the resident runner was
 *          executing yrd 49a3e6ec, thirty-five commits behind the parking
 *          commit, so no park predicate ran at all. The lane spun for a
 *          deployment reason, and these tests exist so nobody re-derives that
 *          the hard way: if the coverage ever DOES regress, it goes red here
 *          instead of costing another night.
 * @level    l2 (queue drain over a git-free intent harness)
 * @consumer @yrd/core/lane-head-spins-on-dead-intent
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withIntents } from "@yrd/intent"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withQueue, withStep } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

const ALPHA = "components/alpha"
const BETA = "components/beta"
const RUNTIME = { runner: "local", leaseMs: 60_000 }

/**
 * The specimen sentence, rendered once per attempt.
 *
 * The real one names the bay worktree the attempt provisioned —
 * `/hh/.bays/yrd-warm-H5wDPW`, then `yrd-warm-d6RsK2`, then `yrd-warm-bCILnV` —
 * so no two attempts ever produce the same string. A budget keyed on the
 * message would count to one forever; this is what keeps the test honest about
 * fingerprinting the cause tuple instead.
 */
function provisionRefusal(bay: string): string {
  return (
    `typecheck candidate command could not run: yrd: required check 'typecheck' workspace ` +
    `could not install its dependencies in /repo/.bays/${bay}/worktree; ` +
    `bun install --frozen-lockfile --ignore-scripts child exited 1`
  )
}

function pin(seed: string): string {
  return seed.repeat(40).slice(0, 40)
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

/** What the check step does on the Nth attempt for a component. */
type Refusal = Readonly<{ code: string; message: string }> | undefined

/**
 * check + merge, where the CHECK step is refused by the environment for the
 * named components. This is the yrdpin#215 shape and not the shape the parking
 * base was built for: an environment refusal releases the run's queue
 * authority, so the run is failed but owns no failed Job, and the check never
 * returns a verdict about the candidate at all.
 */
function intentPlugin(refusals: (component: string, attempt: number) => Refusal, attempts: Map<string, number>) {
  const check = withStep(
    "check",
    (input): JobResult<{ checked: boolean }> => {
      const component = input.prs[0]?.intent?.authored.component
      if (component !== undefined) {
        const attempt = (attempts.get(component) ?? 0) + 1
        attempts.set(component, attempt)
        const refusal = refusals(component, attempt)
        if (refusal !== undefined) {
          return { status: "completed", conclusion: "failure", error: refusal }
        }
      }
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    (): JobResult<{ commit: string; baseSha: string }> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  return withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultBase: "main",
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: (input) => {
      const { prs: _prs, ...candidate } = input
      return {
        ...candidate,
        sha: MERGED,
        treeSha: pin("e"),
        ref: `refs/yrd/candidates/${input.id}`,
        mergeability: "mergeable",
      }
    },
    evaluateIntent: ({ intent }) => {
      if (intent.target === undefined) throw new Error("test evaluator requires an authored target")
      return { admitted: true as const, currentPin: pin("c"), target: intent.target, relation: "advance" as const }
    },
  })
}

async function createApp(refusals: (component: string, attempt: number) => Refusal) {
  const attempts = new Map<string, number>()
  const bayJobs = createBayJobDefs(workspace())
  const queue = intentPlugin(refusals, attempts)
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withIntents(),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
  })
}

type IntentApp = Awaited<ReturnType<typeof createApp>>

let submitted = 0
async function submitIntent(app: IntentApp, component: string, slug: string) {
  submitted += 1
  return app.intents.submit({
    intentId: `00000000-0000-7000-8000-${submitted.toString(16).padStart(12, "0")}`,
    issue: { source: "km", id: `@yrd/core/${slug}` },
    component,
    target: pin((submitted % 10).toString()),
    submitter: "@dev/11",
  })
}

async function drain(app: IntentApp): Promise<string[]> {
  const runs = await app.queue.run({}, RUNTIME)
  return runs.map((run) => `${run.prs[0]?.id}:${run.conclusion ?? run.status}:${run.error?.code}`)
}

/** A refusal identical in everything a fingerprint reads, fresh in its sentence. */
const identicalProvisionRefusal = (_component: string, attempt: number): Refusal => ({
  code: "queue-environment-refused",
  message: provisionRefusal(`yrd-warm-${attempt}xKq`),
})

describe("intent parking — a retryable environment refusal is bounded, not endless", () => {
  it("parks the head after a bounded run of identical environment refusals", async () => {
    await using app = await createApp(identicalProvisionRefusal)
    const dead = await submitIntent(app, ALPHA, "env-refused-head")

    const passes: string[][] = []
    // Three attempts arm the budget; the turn after it parks the record. Same
    // shape as a check failure, which is the whole point — the lane must not
    // care WHICH kind of dead an intent is.
    for (let turn = 0; turn < 4; turn += 1) passes.push(await drain(app))

    expect(passes.slice(0, 3).flat(), JSON.stringify(passes)).toEqual([
      `${dead.id}:failure:queue-environment-refused`,
      `${dead.id}:failure:queue-environment-refused`,
      `${dead.id}:failure:queue-environment-refused`,
    ])
    expect(app.intents.get(dead.id), JSON.stringify(passes)).toMatchObject({
      status: "parked",
      disposition: { code: "intent-attempts-exhausted" },
      parked: {
        attempts: 3,
        failure: { code: "queue-environment-refused", component: ALPHA, step: "check" },
        fingerprint: expect.stringMatching(/^queue-environment-refused:[0-9a-f]{16}$/u),
      },
    })
    // The operator's page has to name the environment, not the queue: the
    // refusal code says only "something outside refused", and the cause is in
    // the message the environment produced.
    expect(app.intents.get(dead.id)?.parked?.failure.reason).toContain("could not install its dependencies")
    expect(app.intents.get(dead.id)?.parked?.remedySummary).toContain(ALPHA)

    // Scope guard, and the reason this file is not redundant with the
    // check-failure parking tests: every one of those refusals took the
    // AUTHORITY-RELEASED path, whose failure frame owns no `job`. If a future
    // change routes environment refusals through the ordinary job-owned failure
    // instead, the assertions above would keep passing while the shape this
    // file exists to cover stopped being exercised at all.
    const events = await Array.fromAsync(app.events())
    const failed = events.filter((applied) => applied.name === "queue/run/failed")
    expect(failed).toHaveLength(3)
    for (const applied of failed) {
      expect(Object.keys(applied.data as object)).not.toContain("job")
    }
  })

  it("stops re-attempting a parked environment refusal and lets the lane move", async () => {
    await using app = await createApp((component, attempt) =>
      component === ALPHA ? identicalProvisionRefusal(component, attempt) : undefined,
    )
    const dead = await submitIntent(app, ALPHA, "env-parks-out")
    for (let turn = 0; turn < 4; turn += 1) await drain(app)
    expect(app.intents.get(dead.id)).toMatchObject({ status: "parked" })

    const successor = await submitIntent(app, BETA, "env-after-park")
    expect(await drain(app)).toEqual([`${successor.id}:success:undefined`])
    expect(app.intents.get(successor.id)).toMatchObject({ status: "integrated" })
  })

  it("keeps retrying when consecutive environment refusals carry DIFFERENT fingerprints", async () => {
    // A bay that cannot be provisioned, then a launcher that died, then the bay
    // again: each is a different question and retrying can still answer it. An
    // alternating environment is exactly the flake the budget must not bury.
    const codes = ["queue-environment-refused", "job-lost", "queue-environment-refused", "job-lost"]
    await using app = await createApp((_component, attempt) => ({
      code: codes[(attempt - 1) % codes.length] ?? "queue-environment-refused",
      message: provisionRefusal(`yrd-warm-${attempt}xKq`),
    }))
    const flaky = await submitIntent(app, ALPHA, "env-alternating")

    for (let turn = 0; turn < 5; turn += 1) await drain(app)

    expect(app.intents.get(flaky.id)).toMatchObject({ status: "open" })
  })

  it("resets the budget when the environment recovers, so a later refusal starts fresh", async () => {
    // Two refusals, then a landing: the run of identical refusals is broken by
    // success, and nothing may carry over to a future submission's tally.
    await using app = await createApp((_component, attempt) =>
      attempt <= 2 ? identicalProvisionRefusal(_component, attempt) : undefined,
    )
    const recovers = await submitIntent(app, ALPHA, "env-recovers")

    for (let turn = 0; turn < 3; turn += 1) await drain(app)

    expect(app.intents.get(recovers.id)).toMatchObject({ status: "integrated" })
  })

  it("reports the environment stall to the audit before the lane clears it", async () => {
    await using app = await createApp(identicalProvisionRefusal)
    const dead = await submitIntent(app, ALPHA, "env-audit-head")

    for (let turn = 0; turn < 3; turn += 1) await drain(app)

    const stalled = app.queue.audit().findings.filter((finding) => finding.code === "intent-lane-stalled")
    expect(stalled).toHaveLength(1)
    expect(stalled[0]?.message).toContain(dead.id)
    expect(stalled[0]?.count).toBe(3)
    expect(stalled[0]?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(stalled[0]?.blockedMs).toBeGreaterThanOrEqual(0)
  })

  it("names the owner in both stall shapes, so a finding routes without a second lookup", async () => {
    // The remedy tells the reader WHAT to do; without the submitter nothing on
    // the finding says WHO, and `queue audit` is read by whoever is on rotation
    // rather than by the person who submitted. The parked shape matters most:
    // it is the one that outlives the drain turn and sits until someone acts.
    await using app = await createApp(identicalProvisionRefusal)
    const dead = await submitIntent(app, ALPHA, "env-audit-owner")

    for (let turn = 0; turn < 3; turn += 1) await drain(app)
    const live = app.queue.audit().findings.filter((finding) => finding.code === "intent-lane-stalled")
    expect(live).toHaveLength(1)
    expect(live[0]?.message).toContain("@dev/11")

    await drain(app)
    expect(app.intents.get(dead.id)).toMatchObject({ status: "parked" })
    const parked = app.queue.audit().findings.filter((finding) => finding.code === "intent-lane-stalled")
    expect(parked).toHaveLength(1)
    expect(parked[0]?.message).toContain("@dev/11")
  })
})
