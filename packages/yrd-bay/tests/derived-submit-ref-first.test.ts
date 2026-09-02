/**
 * @failure Two producers wrote a standing submit fact and only ONE wrote a ref.
 * The receiver's carrier path writes `refs/yrd/submit/<branch>` and only then
 * journals (`writeSubmitRefForCarrier`); the derived lane's local `yrd pr
 * submit <branch>` journaled the fact ALONE. A fact with no ref behind it is
 * then indistinguishable from a projection whose ref was deleted in the store,
 * so the queue could not tell a live local submission from a dead one and
 * re-admitted the dead one on every pass, forever (PR2749, 2026-09-02:
 * `task/w28-silentsites` at b3e5141d).
 *
 * The cure is one producer contract, not a marker beside the fact: the receiver
 * ref is the only admission token, so EVERY producer writes it, ref first and
 * journal second. This file pins that order on the local path — the half that
 * did not have it.
 * @level l2
 * @consumer @yrd/bay `yrd pr submit` derived lane
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "../src/plugin.ts"

const HEAD_1 = "1".repeat(40)
const BASE = "a".repeat(40)
const BRANCH = "task/w28-silentsites"
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
  const definition = pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
  )
  return createYrd(definition, {
    inject: {
      journal: createMemoryJournal([]),
      clock: () => "2026-09-02T00:00:00.000Z",
      id: nextId,
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

describe("the derived lane writes its receiver ref before it journals the fact", () => {
  it("calls publishSubmitRef with the exact submission, and journals the fact after it returns", async () => {
    await using app = await emptyApp()
    const calls: { branch: string; sha: string; base: string; factAtCallTime: unknown }[] = []

    await app.bays.submitSelection(BRANCH, {
      base: "main",
      resolveRevision: async () => HEAD_1,
      run: runtime,
      publishSubmitRef: async (input) => {
        // Read the projection FROM INSIDE the publisher: the fact must not
        // exist yet. This is the whole ordering claim — a fact journaled first
        // and reffed second has a window in which it reads exactly like the
        // dead projection this contract exists to make impossible.
        calls.push({ ...input, factAtCallTime: app.state().bays.submits[BRANCH] })
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ branch: BRANCH, sha: HEAD_1, base: "main" })
    expect(calls[0]?.factAtCallTime, "the ref is written BEFORE the fact is journaled").toBeUndefined()
    expect(app.state().bays.submits[BRANCH]?.sha, "and the fact is journaled after").toBe(HEAD_1)
  })

  it("a publisher that throws journals NOTHING — a submission whose ref did not land is not a submission", async () => {
    await using app = await emptyApp()

    await expect(
      app.bays.submitSelection(BRANCH, {
        base: "main",
        resolveRevision: async () => HEAD_1,
        run: runtime,
        publishSubmitRef: () => {
          throw new Error("yrd: could not write refs/yrd/submit/task/w28-silentsites at … in the receiver store")
        },
      }),
    ).rejects.toThrow(/could not write refs\/yrd\/submit/u)

    expect(
      app.state().bays.submits[BRANCH],
      "no fact may be journaled for a submission whose ref did not land",
    ).toBeUndefined()
  })

  it("NEGATIVE CONTROL: with no publisher supplied the fact is still journaled (pre-flag-day hosts)", async () => {
    // The capability is optional so an embedded host without a receiver store
    // keeps working. That host's facts are the ones the queue's own scan
    // reports as unverifiable — it is not silent about them.
    await using app = await emptyApp()
    await app.bays.submitSelection(BRANCH, { base: "main", resolveRevision: async () => HEAD_1, run: runtime })
    expect(app.state().bays.submits[BRANCH]?.sha).toBe(HEAD_1)
  })
})
