/**
 * @failure The A2 fact-keyed grandfather: a factless `yrd pr submit` of a plain
 * branch MINTS a legacy Change record post-S6, so the record store keeps
 * growing after the door and two lanes derive "what is a change" in parallel —
 * the exact no-parallel-derivation violation behind the PR2135 frontier
 * invalidation and the PR2139 double-merge (2026-08-27). Post-purge the verb
 * still works, but a recordless branch routes to the DERIVED lane: the submit
 * writes the branch/submitted fact and mints nothing; compose admits it under
 * the synthetic identity. A live record keeps the record path until S7 deletes
 * the store wholesale.
 * @level l2
 * @consumer @yrd/bay `yrd pr submit` / `bay submit`; the 22991 S7 chain
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"

const HEAD_1 = "1".repeat(40)
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

async function emptyApp() {
  const nextId = ids()
  const jobs = createBayJobDefs(workspaceAdapter())
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
  return createYrd(definition, {
    inject: {
      journal: createMemoryJournal([]),
      clock: () => "2026-01-01T00:00:00.000Z",
      id: nextId,
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

const mint = (tip: string) => ({ base: "main", resolveRevision: async () => tip, run: runtime })

describe("legacy mint purge — pr.submit routes recordless branches to the derived lane", () => {
  it("a factless branch submit writes the submit fact and mints NO record", async () => {
    await using app = await emptyApp()
    await app.bays.submitSelection("topic/fresh", mint(HEAD_1))
    const state = app.state()
    expect(state.bays.submits["topic/fresh"], "the derived lane's submit fact").toBeDefined()
    expect(state.bays.submits["topic/fresh"]?.sha).toBe(HEAD_1)
    const minted = Object.values(state.bays.prs).filter((pr) => pr.branch === "topic/fresh")
    expect(minted, "no legacy record may mint post-purge").toHaveLength(0)
  })
})
