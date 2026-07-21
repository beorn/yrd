/**
 * @failure A branch selector resolves to a frozen terminal PR instead of the
 * live delivery (or a mutating verb targets a landed PR), or a new mutating
 * verb forgets the shared live-PR guard and silently mutates by a stale branch.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it } from "vitest"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"

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
    provision: (input) => ({ status: "passed", output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE } }),
    refresh: (input) => ({ status: "passed", output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE, dirty: false } }),
    deprovision: () => ({ status: "passed", output: {} }),
  }
}

/** Seed a journal with one integrated PR per entry (all on the given branch, so
 * the branch collides), then boot an app on it. */
async function appWithIntegrated(branch: string, seeds: ReadonlyArray<{ pr: string; headSha: string; commit: string }>) {
  const nextId = ids()
  const at = "2026-01-01T00:00:00.000Z"
  const seededCommand = { id: nextId(), op: "fixture.seed" }
  const events = seeds.flatMap(({ pr, headSha, commit }) => [
    { id: nextId(), name: "pr/pushed", ts: at, data: { pr, branch, base: "main", headSha, baseSha: BASE, revision: 1 } },
    { id: nextId(), name: "pr/submitted", ts: at, data: { pr, revision: 1, headSha } },
    { id: nextId(), name: "pr/integrated", ts: at, data: { pr, revision: 1, headSha, run: `R-${pr}`, commit, landingSha: commit, baseSha: BASE } },
  ])
  const journal = createMemoryJournal([
    { command: seededCommand, cause: { id: nextId(), commandId: seededCommand.id, op: seededCommand.op, commandHash: Command.hash(seededCommand) }, events },
  ])
  const jobs = createBayJobDefs(workspaceAdapter())
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
  return createYrd(definition, { inject: { journal, clock: () => at, id: nextId } })
}

const mint = (tip: string) => ({ base: "main", resolveRevision: async () => tip, run: runtime })

describe("resolvePR live-preference + requireLivePR mutation guard", () => {
  it("resolves a branch with one terminal + one live PR to the live one, for reads and mutating verbs", async () => {
    await using app = await appWithIntegrated("topic/b", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // Q1 mints a fresh live delivery (PR2) on the landed branch.
    await app.bays.submitSelection("topic/b", mint(HEAD_2))

    // Read: the branch selector resolves the LIVE PR, not the frozen integrated one.
    expect(app.bays.pr("topic/b")).toMatchObject({ id: "PR2", status: "submitted" })
    // Mutate (withdraw) by branch: acts on the live delivery.
    await app.bays.closePr({ pr: "topic/b" })
    expect(app.bays.pr("PR2")).toMatchObject({ status: "withdrawn" })
    expect(app.bays.pr("PR1")).toMatchObject({ status: "integrated" })
  })

  it("resolves a branch with multiple terminal PRs + one live PR to the live one", async () => {
    await using app = await appWithIntegrated("topic/c", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, commit: "b".repeat(40) },
    ])
    // Two integrated PRs already collide on topic/c; a new head mints the live PR3.
    await app.bays.submitSelection("topic/c", mint(HEAD_3))

    expect(app.bays.pr("topic/c")).toMatchObject({ id: "PR3", status: "submitted" })
    await app.bays.requestChecks({ pr: "topic/c" })
    expect(app.bays.pr("PR3")).toMatchObject({ checkRequests: [expect.objectContaining({ headSha: HEAD_3 })] })
  })

  it("read-resolves an all-terminal branch to the most recent terminal, but refuses a mutating verb", async () => {
    await using app = await appWithIntegrated("topic/d", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, commit: "b".repeat(40) },
    ])
    // Read: an all-terminal branch resolves the MOST RECENT terminal (PR2).
    expect(app.bays.pr("topic/d")).toMatchObject({ id: "PR2", status: "integrated" })
    // Mutate by branch: no live delivery → loud, typed refusal that points at PR id.
    await expect(app.bays.closePr({ pr: "topic/d" })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "no-live-pr" },
    })
    await expect(app.bays.closePr({ pr: "topic/d" })).rejects.toThrow("no live PR for branch 'topic/d'; use PR id")
  })

  it("passes an id-addressed terminal PR through to the verb's own state guard, not the branch refusal", async () => {
    await using app = await appWithIntegrated("topic/e", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // Addressed by its exact id, a terminal PR is NOT branch-refused; the verb's
    // own precondition decides (closePr: only a live PR can be closed).
    await expect(app.bays.closePr({ pr: "PR1" })).rejects.toThrow(/only a live PR|run it through the queue/i)
    await expect(app.bays.closePr({ pr: "PR1" })).rejects.not.toThrow("no live PR for branch")
  })

  it("folds case on an id-addressed terminal PR: 'pr1' addresses canonical PR1, same as resolveSelector", async () => {
    await using app = await appWithIntegrated("topic/f", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // resolveSelector folds case ('pr1' → PR1); the guard's exact-id arm must
    // fold identically, or a lowercase exact id is misclassified as a live-less
    // BRANCH and refused with no-live-pr.
    await expect(app.bays.closePr({ pr: "pr1" })).rejects.toThrow(/only a live PR|run it through the queue/i)
    await expect(app.bays.closePr({ pr: "pr1" })).rejects.not.toThrow("no live PR for branch")
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
})
