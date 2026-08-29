/**
 * @failure A branch selector resolves to a frozen terminal change instead of the
 * live delivery (or a mutating verb targets a merged PR), or a new mutating
 * verb forgets the shared live-PR guard and silently mutates by a stale branch.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { type Bays, createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "../src/plugin.ts"
import type { DerivedSubmission } from "../src/model.ts"
import { currentChangeRev, changeDeliveryState, type Change } from "../src/model.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const HEAD_3 = "3".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspaceAdapter(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD_1, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

function changeFacts(pr: Change | DerivedSubmission | undefined) {
  if (pr === undefined) throw new Error("expected PR")
  if ("lane" in pr) throw new Error("expected a record-lane Change, got a derived submission")
  return { ...pr, delivery: changeDeliveryState(pr), current: currentChangeRev(pr) }
}

function record(result: Awaited<ReturnType<Bays["submitSelection"]>>): Change {
  if ("lane" in result) throw new Error("expected a record-lane Change, got a derived submission")
  return result
}

/** Seed a journal with one change per entry (all on the given branch, so the
 * branch collides), then boot an app on it. A seed with `live: true` stops at
 * pushed+submitted (a live delivery, as the record lane would have left it);
 * otherwise it is integrated at `commit`. The live seeds replaced the
 * direct-branch Q1 mint these fixtures used before the legacy mint retired —
 * a direct resubmit now routes to the derived lane and mints nothing. */
async function appWithIntegrated(
  branch: string,
  seeds: ReadonlyArray<{ pr: string; headSha: string; commit?: string; live?: boolean }>,
) {
  const nextId = ids()
  const at = "2026-01-01T00:00:00.000Z"
  const seededCommand = { id: nextId(), op: "fixture.seed" }
  const events = seeds.flatMap(({ pr, headSha, commit, live }) => {
    const delivered = [
      {
        id: nextId(),
        name: "pr/pushed",
        ts: at,
        // The stable Change-Id (shape `I` + 40 hex) lets revision intake
        // rebuild identity on the live seed; only the shape is validated. The
        // modern pushed-event arm requires changeId and submitter together.
        data: {
          pr,
          branch,
          base: "main",
          headSha,
          baseSha: BASE,
          revision: 1,
          changeId: `I${headSha.slice(0, 40)}`,
          submitter: "fixture",
        },
      },
      { id: nextId(), name: "pr/submitted", ts: at, data: { pr, revision: 1, headSha } },
    ]
    if (live === true) return delivered
    if (commit === undefined) throw new Error(`seed ${pr}: an integrated seed needs its merge commit`)
    return [
      ...delivered,
      {
        id: nextId(),
        name: "pr/integrated",
        ts: at,
        data: { pr, revision: 1, headSha, run: `R-${pr}`, commit, landingSha: commit, baseSha: BASE },
      },
    ]
  })
  const journal = createMemoryJournal([
    {
      command: seededCommand,
      cause: {
        id: nextId(),
        commandId: seededCommand.id,
        op: seededCommand.op,
        commandHash: Command.hash(seededCommand),
      },
      events,
    },
  ])
  const jobs = createBayJobDefs(workspaceAdapter())
  const definition = pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
  )
  return createYrd(definition, {
    inject: { journal, clock: () => at, id: nextId, log: createLogger("test", [{ level: "silent" }]) },
  })
}

const mint = (tip: string) => ({ base: "main", resolveRevision: async () => tip, run: runtime })

describe("resolvePR live-preference + requireLivePR mutation guard", () => {
  it("resolves a branch with one terminal + one live change to the live one, for reads and mutating verbs", async () => {
    // PR2 is the live delivery colliding with the integrated PR1 on topic/b.
    await using app = await appWithIntegrated("topic/b", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, live: true },
    ])

    // Read: the branch selector resolves the LIVE PR, not the frozen integrated one.
    expect(changeFacts(app.bays.pr("topic/b"))).toMatchObject({ id: "PR2", delivery: "submitted" })
    // Mutate (withdraw) by branch: acts on the live delivery.
    await app.bays.closePr({ pr: "topic/b" })
    expect(changeFacts(app.bays.pr("PR2"))).toMatchObject({ delivery: "withdrawn" })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "integrated" })
  })

  it("resolves a branch with multiple terminal PRs + one live change to the live one", async () => {
    // Two integrated PRs already collide on topic/c; PR3 is the live delivery.
    await using app = await appWithIntegrated("topic/c", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, commit: "b".repeat(40) },
      { pr: "PR3", headSha: HEAD_3, live: true },
    ])

    expect(changeFacts(app.bays.pr("topic/c"))).toMatchObject({ id: "PR3", delivery: "submitted" })
    await app.bays.requestChecks({ pr: "topic/c" })
    expect(app.bays.pr("PR3")).toMatchObject({ checkRequests: [expect.objectContaining({ headSha: HEAD_3 })] })
  })

  it("read-resolves an all-terminal branch to the most recent terminal, but refuses a mutating verb", async () => {
    await using app = await appWithIntegrated("topic/d", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, commit: "b".repeat(40) },
    ])
    // Read: an all-terminal branch resolves the MOST RECENT terminal (PR2).
    expect(changeFacts(app.bays.pr("topic/d"))).toMatchObject({ id: "PR2", delivery: "integrated" })
    // Mutate by branch: no live delivery → loud, typed refusal that points at PR id.
    await expect(app.bays.closePr({ pr: "topic/d" })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "no-live-pr" },
    })
    await expect(app.bays.closePr({ pr: "topic/d" })).rejects.toThrow("no live change for branch 'topic/d'; use PR id")
  })

  it("passes an id-addressed terminal change through to the verb's own state guard, not the branch refusal", async () => {
    await using app = await appWithIntegrated("topic/e", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // Addressed by its exact id, a terminal change is NOT branch-refused; the verb's
    // own precondition decides (closePr: only a live change can be closed).
    await expect(app.bays.closePr({ pr: "PR1" })).rejects.toThrow(/only a live change|run it through the queue/i)
    await expect(app.bays.closePr({ pr: "PR1" })).rejects.not.toThrow("no live change for branch")
  })

  it("folds case on an id-addressed terminal change: 'pr1' addresses canonical PR1, same as resolveSelector", async () => {
    await using app = await appWithIntegrated("topic/f", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // resolveSelector folds case ('pr1' → PR1); the guard's exact-id arm must
    // fold identically, or a lowercase exact id is misclassified as a live-less
    // BRANCH and refused with no-live-pr.
    await expect(app.bays.closePr({ pr: "pr1" })).rejects.toThrow(/only a live change|run it through the queue/i)
    await expect(app.bays.closePr({ pr: "pr1" })).rejects.not.toThrow("no live change for branch")
  })

  it("routes submit through the same live guard: a live-less branch selector refuses no-live-pr", async () => {
    await using app = await appWithIntegrated("topic/g", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // topic/g's only PR is integrated. Submitting BY BRANCH now routes through
    // requireLivePR like every other mutating verb — submit no longer owns a
    // resolve exemption — so a live-less branch selector gets the shared typed
    // no-live-pr guidance, not a generic 'not pushed'. An id-addressed integrated
    // PR still passes the guard (matchedBy canonical) to submit's own state check.
    await expect(app.bays.submit({ pr: "topic/g" })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "no-live-pr" },
    })
    await expect(app.bays.submit({ pr: "PR1" })).rejects.toThrow(/is integrated, not pushed/i)
  })

  it("refuses a historical revision selector at the submit-selection mutation boundary", async () => {
    await using app = await appWithIntegrated("topic/h", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, live: true },
    ])
    await app.bays.intake({ branch: "topic/h", headSha: HEAD_3, baseSha: BASE })
    await app.bays.submit({ pr: "PR2" })

    await expect(app.bays.submitSelection("pr#2.1", mint(HEAD_3))).rejects.toMatchObject({
      failure: { kind: "refusal", code: "historical-pr-revision" },
    })
  })
})
