/**
 * @failure `queue.eligibilities()` — the PLURAL — enumerated the record store
 * only, so a derived member was absent from the whole-population eligibility
 * read while the SINGULAR `queue.eligibility(selector)` two lines above it in
 * `queue.ts` had already been cut over to the change population. A
 * half-migration: the singular carries a comment naming the record-lane read
 * as "what made every `pr` verb refuse a change the queue was actively
 * running", and the plural beside it kept doing exactly that.
 *
 * `eligibility-congruence.test.ts` could not catch this and still cannot on
 * its own fixture: its congruence loop iterates the PLURAL and checks each
 * entry against the singular, so a change MISSING from the plural is never
 * visited. It is one-directional by construction and passes identically with
 * the defect present. This file supplies the other direction: it asserts the
 * plural's POPULATION, not the agreement of the rows it happened to yield.
 *
 * The derived member is handed in as a projected snapshot rather than composed,
 * because `eligibilities(projected)` takes one and the fixture then states the
 * condition under test directly — a retained run naming an id no record
 * carries, with `bays.prs` empty, so every returned row must have come from the
 * derived lane. Verified to discriminate: with the record-lane read restored
 * this asserts `expected [] to deeply equal [ 'PR9001' ]`.
 * @level l2
 * @consumer @yrd/queue · every surface that reads whole-population eligibility
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import {
  Queues,
  withMerge,
  withQueue,
  withStep,
  type ChangeShape,
  type ChangeSnapshot,
  type InstalledStep,
  type QueueRecord,
  type StepExecution,
} from "@yrd/queue"
import { createLogger } from "loggily"

const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const SUBMIT_SHA = "c".repeat(40)
const BRANCH = "issue/eligibilities-both-lanes"
const SUBMITTED_AT = "2026-08-31T12:00:00.000Z"

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "eligibilities-both-lanes-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: BASE_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/** Production's wiring: the same durable mint handed to both plugins, which is
 * what makes a recordless submit fact derivable at all. */
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
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const mint = volatilePrNumberMint()
  const queue = withQueue({ steps: [check, merge] as const, batch: false, prNumberMint: mint })
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: mint,
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => SUBMITTED_AT,
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

const MERGE_STEP: InstalledStep = { name: "merge", title: "Merge", revision: "merge-v1", kind: "merge" }

/** A retained run whose member names an id no record carries — the post-S6
 * derived member, which is the only home that identity has. */
function derivedRun(id: string, member: ChangeSnapshot): QueueRecord {
  return {
    id,
    queueId: "main",
    candidateId: "C1",
    prs: [member],
    base: "main",
    steps: [MERGE_STEP],
    startedAt: SUBMITTED_AT,
    passedAt: SUBMITTED_AT,
    integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
  }
}

describe("whole-population eligibility reads both admission lanes", () => {
  it("a DERIVED member appears in eligibilities() — the half-migration this pins", async () => {
    const app = await createApp()
    try {
      const state = app.state()
      expect(
        Object.keys(state.bays.prs).length,
        "precondition: no records at all, so every row the plural returns must come from the derived lane",
      ).toBe(0)

      const member: ChangeSnapshot = {
        id: "PR9001",
        branch: BRANCH,
        base: "main",
        revision: 1,
        headSha: SUBMIT_SHA,
      }
      const empty = Queues.empty({ batchSize: 1 })
      const projected = {
        ...state,
        queues: { ...empty, records: Queues.set(empty.records, derivedRun("R1", member)) },
      }

      const eligibilities = app.queue.eligibilities(projected)
      expect(
        eligibilities.map((eligibility) => eligibility.pr),
        "the derived member is missing from the plural read — the record-lane enumeration",
      ).toEqual(["PR9001"])
    } finally {
      await app.close()
    }
  })
})
