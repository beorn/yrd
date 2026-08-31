/**
 * @failure The habitant heartbeat's published merge position enumerated the
 * RECORD store only, so a derived-lane merge never advanced it. A recordless
 * branch is composed at the S6 door and leaves `bays.prs` empty BY DESIGN, and
 * nearly all fleet traffic now arrives that way — so the position froze at the
 * last record-lane merge and every reader of it went blind together: the
 * dashboard's "no merge for N" line, the `resident-runner-driver-stale`
 * identity probe, and the `resident-runner-stalled-no-merge` dead-man.
 *
 * Measured on the live queue 2026-08-31: main advanced to 07218650a6 at
 * 19:09:42Z (its reflog entry, corroborated by the run record's merge step at
 * 19:10:10Z) while the heartbeat still published dd3f0f3cb3 at 17:09:57Z, so
 * the dashboard read "no merge for 2:11:32" over a queue that had merged
 * twelve minutes earlier.
 *
 * The dead-man degrades worse than the display does. It tests runner uptime
 * and no-merge age against the SAME 3h threshold, so a position that stops
 * advancing at runner start makes the second test pass whenever the first
 * does — the alarm stops being a claim about merging and becomes a claim about
 * uptime. That is the shape of a false-positive machine, and this suite is the
 * discriminating half: the sibling reads (`eligibilities-both-lanes`,
 * `tracker-bridge-derived`) pin the same record-vs-population defect in two
 * other consumers and cannot see this one.
 *
 * Verified to discriminate: with `recordChanges(state.bays)` restored, the
 * first case asserts `expected null to be an object`.
 * @level l2
 * @consumer @yrd/cli habitant heartbeat · runner health probe · queue dashboard
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { createLogger } from "loggily"
import { habitantDriverLastMerged } from "../src/run.ts"
import type { YrdCliApp } from "../src/types.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BRANCH = "topic/derived-lands"
const RUNTIME = { runner: "cli-test", leaseMs: 60_000 }

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${String(++value).padStart(12, "0")}`
}

/** Advancing clock so the merge position's `at` is a real stamp the assertion
 * can name, rather than one frozen value every field shares. */
function tickingClock(): () => string {
  let at = Date.parse("2026-08-31T12:00:00.000Z")
  return () => new Date((at += 1000)).toISOString()
}

function workspace() {
  return {
    revision: "driver-last-merged-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: HEAD_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/** Production's S6 wiring: ONE durable mint shared by `withBays` and
 * `withQueue`, which is what makes a recordless submit fact composable into a
 * derived member at all. */
async function createApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: BASE_SHA },
    }),
    { revision: "merge-v1" },
  )
  const mint = volatilePrNumberMint()
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    prNumberMint: mint,
    // A derived member carries no baseSha of its own; production wires the git
    // resolver here (same note as `tracker-bridge-derived`).
    resolveBaseSha: () => BASE_SHA,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: mint,
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      clock: tickingClock(),
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

describe("the habitant driver's published merge position reads both admission lanes", () => {
  it("advances for a DERIVED merge — the frozen position this pins", async () => {
    const app = await createApp()
    try {
      await app.bays.recordBranchSubmit({ branch: BRANCH, sha: HEAD_SHA, base: "main" })
      expect(await app.queue.run({}, RUNTIME)).toMatchObject([{ status: "completed", conclusion: "success" }])
      expect(
        app.state().bays.prs,
        "precondition: the merge left NO record, so any position returned came from the derived lane",
      ).toEqual({})

      const merged = habitantDriverLastMerged(app as unknown as YrdCliApp, "main")
      expect(merged, "the derived merge is invisible to the record-lane read").toMatchObject({ commit: MERGED_SHA })
      // The integration's own SETTLEMENT stamp, which is a tick or two after the
      // run finished — not the run's `finishedAt`, and never the reader's clock.
      // Named here because a dead-man subtracts `now` from exactly this field.
      const finishedAt = app.queue.get("R1")?.finishedAt
      expect(finishedAt).toBeDefined()
      expect(merged?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
      expect(
        Date.parse(merged?.at ?? ""),
        "the position is stamped when the merge settled, never before the run that produced it finished",
      ).toBeGreaterThanOrEqual(Date.parse(finishedAt ?? ""))
    } finally {
      await app.close()
    }
  })

  it("reports null — never a stale position — when nothing has merged on the base", async () => {
    const app = await createApp()
    try {
      await app.bays.recordBranchSubmit({ branch: BRANCH, sha: HEAD_SHA, base: "main" })
      expect(
        habitantDriverLastMerged(app as unknown as YrdCliApp, "main"),
        "a submitted-but-unmerged branch is not a merge position",
      ).toBeNull()
    } finally {
      await app.close()
    }
  })

  it("does not answer one base with another base's merge", async () => {
    const app = await createApp()
    try {
      await app.bays.recordBranchSubmit({ branch: BRANCH, sha: HEAD_SHA, base: "main" })
      expect(await app.queue.run({}, RUNTIME)).toMatchObject([{ status: "completed", conclusion: "success" }])
      expect(habitantDriverLastMerged(app as unknown as YrdCliApp, "release/2.0")).toBeNull()
    } finally {
      await app.close()
    }
  })
})
