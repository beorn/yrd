/**
 * @failure A DERIVED member's revision ordinal moves on a bare admission
 * cycle, so its admission job key (`admission:<pr>:<revision>:<baseSha>`)
 * changes every pass, no attempt is ever recognized as the same attempt, and
 * the queue re-admits forever while merging nothing
 * (@i/10-yrd/admission-passes-nothing-merges; one carrier reached revision
 * 66). 303e7845 fixed that loop on the RECORD lane, and its regression test
 * drives `bays.recut` — a record-lane API. This is the same acceptance
 * criterion on the lane that carries production traffic: the ordinal is
 * derived from retained run records, so it must move for NEW CONTENT and for
 * nothing else.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  deriveRunMemberArgs,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

function ids(): () => string {
  let value = 0
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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

async function createApp(
  options: Readonly<{
    calls?: Map<string, number>
    mergeRun?: () => JobResult<IntegrationProof>
  }> = {},
) {
  const count = (step: string): void => {
    const calls = options.calls
    if (calls !== undefined) calls.set(step, (calls.get(step) ?? 0) + 1)
  }
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => {
      count("check")
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => {
      count("merge")
      return options.mergeRun === undefined
        ? { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
        : options.mergeRun()
    },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

function mintedRevision(app: App, branch: string): number {
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: volatilePrNumberMint(1),
    branch,
    enrichment: { changeId: `I${SHA}` },
  }).revision
}

const recordCount = (app: App): number => Object.keys(app.state().queues.records).length

describe("a derived member's revision ordinal moves only for new content", () => {
  it("freezes the ordinal, the run count and both step counters across repeated admission cycles", async () => {
    const calls = new Map<string, number>()
    await using app = await createApp({
      calls,
      mergeRun: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "merge-refused", message: "probe: merge never succeeds" },
      }),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/probe", sha: SHA, base: "main" })

    const state = (): string => {
      const submit = app.state().bays.submits["issue/probe"]
      let lane = "derivable"
      try {
        mintedRevision(app, "issue/probe")
      } catch (error) {
        lane = `NOT-DERIVABLE(${error instanceof Error ? error.message.slice(0, 60) : String(error)})`
      }
      return `submitFact=${submit === undefined ? "GONE" : submit.sha.slice(0, 4)} lane=${lane}`
    }
    const observed: string[] = []
    observed.push(`cycle 0: revision=${mintedRevision(app, "issue/probe")} records=${recordCount(app)} ${state()}`)
    for (let cycle = 1; cycle <= 4; cycle++) {
      await app.queue.run({}, runtime)
      observed.push(
        `cycle ${cycle}: revision=${mintedRevision(app, "issue/probe")} records=${recordCount(app)} ` +
          `check=${calls.get("check") ?? 0} merge=${calls.get("merge") ?? 0} ${state()}`,
      )
    }
    // The claim: repeating the cycle on an unchanged, still-live member is a
    // no-op. The ordinal, the run count and both step counters all freeze
    // after the first compose, so nothing re-admits and nothing re-executes.
    expect(observed).toEqual([
      "cycle 0: revision=1 records=0 submitFact=7777 lane=derivable",
      "cycle 1: revision=2 records=1 check=1 merge=1 submitFact=7777 lane=derivable",
      "cycle 2: revision=2 records=1 check=1 merge=1 submitFact=7777 lane=derivable",
      "cycle 3: revision=2 records=1 check=1 merge=1 submitFact=7777 lane=derivable",
      "cycle 4: revision=2 records=1 check=1 merge=1 submitFact=7777 lane=derivable",
    ])

    // POSITIVE CONTROL: "frozen" proves nothing unless this instrument can
    // show movement. A real re-push renews the per-push submit authority, and
    // the ordinal and both counters must move — only NEW CONTENT moves them.
    await app.bays.recordBranchSubmit({ branch: "issue/probe", sha: "3".repeat(40), base: "main" })
    await app.queue.run({}, runtime)
    expect(
      `revision=${mintedRevision(app, "issue/probe")} check=${calls.get("check") ?? 0} merge=${calls.get("merge") ?? 0}`,
    ).toBe("revision=3 check=2 merge=2")
  })
})
