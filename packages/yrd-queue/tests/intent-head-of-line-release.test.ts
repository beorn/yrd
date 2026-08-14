/**
 * @failure A dead intent at the head of the intent lane ends every compose turn, so intents for OTHER components wait out its whole failure streak instead of landing.
 * @level l2
 * @consumer @yrd/queue intent drain
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

/**
 * check + merge, where the merge step fails for the named components. That is
 * the specimen shape both 2026-08-14 dead heads had: merge-time evaluation
 * ADMITS the intent and the LANDING refuses it, identically, every attempt — so
 * the intent stays open and reclaims the head on the next selection.
 */
function intentPlugin(deadComponents: ReadonlySet<string>, evaluated: string[]) {
  const check = withStep(
    "check",
    (): JobResult<{ checked: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    (input): JobResult => {
      const component = input.prs[0]?.intent?.authored.component
      if (component !== undefined && deadComponents.has(component)) {
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "carrier-drops-landed", message: `yrd: '${component}' drops landed commits` },
        }
      }
      return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
    },
    { revision: "merge-v1" },
  )
  return withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultBase: "main",
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    // A landing records the checked tree identity of the candidate it landed, so
    // the synthesized intent carrier needs one even in a git-free harness.
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
      evaluated.push(intent.id)
      if (intent.target === undefined) throw new Error("test evaluator requires an authored target")
      return { admitted: true as const, currentPin: pin("c"), target: intent.target, relation: "advance" as const }
    },
  })
}

async function createApp(deadComponents: ReadonlySet<string> = new Set(), evaluated: string[] = []) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = intentPlugin(deadComponents, evaluated)
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

/** One drain turn, reported the way the resident sees it. */
async function drain(app: IntentApp): Promise<string[]> {
  const runs = await app.queue.run({}, RUNTIME)
  return runs.map((run) => `${run.prs[0]?.id}:${run.conclusion ?? run.status}`)
}

describe("intent head-of-line release — a dead intent never blocks another component's lane", () => {
  it("attempts BOTH components in one turn and lands the live one behind a dead head", async () => {
    const evaluated: string[] = []
    await using app = await createApp(new Set([ALPHA]), evaluated)
    const dead = await submitIntent(app, ALPHA, "dead-head")
    const live = await submitIntent(app, BETA, "live-behind")

    const passes = await drain(app)

    expect(passes).toEqual([`${dead.id}:failure`, `${live.id}:success`])
    expect(app.intents.get(live.id)).toMatchObject({ status: "integrated" })
    // The dead head keeps its position — releasing it is turn-scoped, not a
    // disposition — and it was tried exactly once, not re-selected behind itself.
    expect(app.intents.get(dead.id)).toMatchObject({ status: "open" })
    expect(evaluated.filter((id) => id === dead.id)).toHaveLength(1)
  })

  it("never tries a component's SECOND intent while its own head is still open", async () => {
    const evaluated: string[] = []
    await using app = await createApp(new Set([ALPHA]), evaluated)
    const head = await submitIntent(app, ALPHA, "dead-head")
    const behind = await submitIntent(app, ALPHA, "same-component-behind")

    const first = await drain(app)
    const second = await drain(app)

    // One attempt per turn for that component: releasing the head must not turn
    // one failure into a burn through the component's whole backlog.
    expect(first).toEqual([`${head.id}:failure`])
    expect(second).toEqual([`${head.id}:failure`])
    expect(evaluated.filter((id) => id === behind.id)).toHaveLength(0)
    expect(app.intents.get(behind.id)).toMatchObject({ status: "open" })
  })

  it("ends the turn on a landing and leaves the next component to the next turn", async () => {
    await using app = await createApp()
    const first = await submitIntent(app, ALPHA, "lands-first")
    const second = await submitIntent(app, BETA, "lands-next")

    expect(await drain(app)).toEqual([`${first.id}:success`])
    expect(app.intents.get(second.id)).toMatchObject({ status: "open" })
    expect(await drain(app)).toEqual([`${second.id}:success`])
  })

  it("terminates the turn when EVERY component's head is dead", async () => {
    const evaluated: string[] = []
    await using app = await createApp(new Set([ALPHA, BETA]), evaluated)
    const alpha = await submitIntent(app, ALPHA, "dead-alpha")
    const beta = await submitIntent(app, BETA, "dead-beta")

    const passes = await drain(app)

    expect(passes).toEqual([`${alpha.id}:failure`, `${beta.id}:failure`])
    expect(evaluated).toEqual([alpha.id, beta.id])
  })

  it("keeps a parked head out of selection instead of re-attempting it", async () => {
    const evaluated: string[] = []
    await using app = await createApp(new Set([ALPHA]), evaluated)
    const dead = await submitIntent(app, ALPHA, "parks-out")

    // Three identical failures arm the park; the fourth turn parks the record.
    for (let turn = 0; turn < 4; turn += 1) await drain(app)
    expect(app.intents.get(dead.id)).toMatchObject({ status: "parked" })

    const attemptsBeforeSuccessor = evaluated.length
    const successor = await submitIntent(app, BETA, "after-park")
    expect(await drain(app)).toEqual([`${successor.id}:success`])
    // The parked record is terminal: it holds no lane position and is never
    // evaluated again, in this turn or any later one.
    expect(evaluated.slice(attemptsBeforeSuccessor)).toEqual([successor.id])
  })

  it("preserves submission order within one component across turns", async () => {
    await using app = await createApp()
    const first = await submitIntent(app, ALPHA, "order-first")
    const second = await submitIntent(app, ALPHA, "order-second")
    const third = await submitIntent(app, ALPHA, "order-third")

    expect(await drain(app)).toEqual([`${first.id}:success`])
    expect(await drain(app)).toEqual([`${second.id}:success`])
    expect(await drain(app)).toEqual([`${third.id}:success`])
  })

  it("leaves the single-component drain exactly as it was", async () => {
    const evaluated: string[] = []
    await using app = await createApp(new Set([ALPHA]), evaluated)
    const dead = await submitIntent(app, ALPHA, "regression-dead")
    const behind = await submitIntent(app, ALPHA, "regression-behind")

    // One component, one head, one attempt, one run returned — the turn is
    // indistinguishable from the pre-release drain.
    expect(await drain(app)).toEqual([`${dead.id}:failure`])
    expect(evaluated).toEqual([dead.id])
    expect(app.intents.get(dead.id)).toMatchObject({ status: "open" })
    expect(app.intents.get(behind.id)).toMatchObject({ status: "open" })
  })

  it("keeps the audit's lane view on the single lane head", async () => {
    await using app = await createApp(new Set([ALPHA, BETA]))
    const alpha = await submitIntent(app, ALPHA, "audit-alpha")
    await submitIntent(app, BETA, "audit-beta")

    for (let turn = 0; turn < 3; turn += 1) await drain(app)

    // Selection is per component; the audit's stall finding is not. It still
    // reports the ONE lane head, so a per-component walk cannot multiply the
    // pages a single bad night produces.
    const stalled = app.queue.audit().findings.filter((finding) => finding.code === "intent-lane-stalled")
    expect(stalled).toHaveLength(1)
    expect(stalled[0]?.message).toContain(alpha.id)
  })
})
