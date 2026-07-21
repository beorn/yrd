/**
 * @failure A branch selector resolves to a frozen terminal PR instead of the
 * live delivery (or a mutating verb targets a landed PR), or a new mutating
 * verb forgets the shared live-PR guard and silently mutates by a stale branch.
 * @level l2
 * @consumer @yrd/bay
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
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
})

describe("requireLivePR coverage — every PR-selector mutation routes through the one guard", () => {
  const pluginSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "plugin.ts"), "utf8")
  const count = (pattern: RegExp) => pluginSource.match(pattern)?.length ?? 0

  it("routes exactly the derived mutating reducers through requireLivePR and leaves no raw resolve", () => {
    // Grep-derived, never hand-listed: a NEW mutating reducer that resolves a PR
    // selector with the raw `required(resolvePR(state.bays, args.pr))` pattern
    // reddens the zero-raw assertion; one that adds a requireLivePR call reddens
    // the count assertion, forcing a deliberate review of the expected total.
    const routed = count(/requireLivePR\(state\.bays, args\.pr\)/g)
    const raw = count(/required\(resolvePR\(state\.bays, args\.pr\)/g)
    // ready, recut, requestReview, review, comment, requestChecks,
    // recordRegression, close, edit — 9 mutating verbs.
    expect(routed).toBe(9)
    expect(raw).toBe(0)
  })

  it("keeps submit as the ONE documented exemption (it owns terminal-branch semantics via D2/Q1)", () => {
    // submit resolves its selector through submitSelectionOperation's D2/Q1
    // reopen/mint logic, not requireLivePR — the sole mutating-resolve site that
    // uses a different local binding. If this drops to 0, submit stopped
    // resolving by selector; if it climbs, a new verb copied submit's pattern
    // instead of routing through requireLivePR.
    expect(count(/required\(resolvePR\(current, args\.pr\)/g)).toBe(1)
  })
})
