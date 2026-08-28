/**
 * @failure Two derived-lane admission holes observed live on 2026-08-28.
 * (1) Queue re-entry of landed content (specimen PR2145): a branch whose tree
 * the base already contains re-derives off its standing submit fact, the
 * candidate preparer's merge finds nothing to add and returns THE BASE ITSELF
 * (sha === baseSha), and admission then runs every required check against a
 * degenerate base-vs-base range (YRD_BASE_SHA == YRD_CANDIDATE_SHA == the main
 * tip) — range-shaped gates like substrate-pair refuse it, and the member can
 * never pass: every new tip mints a fresh degenerate check generation,
 * forever. The cure is to refuse the degenerate candidate BEFORE any check
 * dispatch with the structurally-permanent `candidate-already-landed` park
 * (first refusal settles; the message names the fact-retirement cure).
 * (2) A BASE-classified admission step's failure describes the target
 * environment, not the member — but `admissionFailureKind` billed it kind
 * "failure" (presented required-check-failed, owner author). Base-red must
 * never author-bill: it classifies "infrastructure", matching the carrier-only
 * rule the delta comparator already enforces on run-path attribution.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

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
      output: { path: `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

/** The preparer's containment answer, exactly as production returned it for
 * PR2145's re-entry (Candidate C4977): the merge of an already-landed tree
 * onto the base adds nothing, so the "candidate" IS the base commit. */
const containedCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: input.baseSha, ref: candidateRefFor(input.baseSha), mergeability: "mergeable" }
}

async function createApp(
  options: Readonly<{
    prepare?: CandidatePreparer
    checkResult?: () => JobResult<z.infer<typeof CheckResultSchema>>
    classification?: "base" | "carrier"
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    queueMint?: PrNumberMint
  }> = {},
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> =>
      options.checkResult?.() ?? { status: "completed", conclusion: "success", output: { checked: true } },
    {
      revision: "check-v1",
      output: CheckResultSchema,
      ...(options.classification === undefined ? {} : { classification: options.classification }),
    },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate:
      options.prepare ??
      ((input) => {
        const { prs: _prs, ...candidate } = input
        return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
      }),
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

describe("degenerate candidate — queue re-entry of landed content (specimen PR2145)", () => {
  it("refuses candidate-already-landed BEFORE any check dispatch, settles on first refusal, and names the fact-retirement cure", async () => {
    let checks = 0
    await using app = await createApp({
      prepare: containedCandidate,
      checkResult: () => {
        checks += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    await app.bays.recordBranchSubmit({ branch: "issue/landed-content", sha: SHA, base: "main" })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // No check generation was burned: the refusal fired before dispatch.
    expect(checks).toBe(0)
    expect(Object.keys(app.state().jobs.byKey).filter((key) => key.startsWith("admission:"))).toEqual([])

    // The ledger row carries the wedge durably, with the member's own identity
    // (a first-admission derived member has no record and no snapshot).
    const row = Object.values(app.state().queues.admissionRefusals)[0]
    expect(row).toMatchObject({
      code: "candidate-already-landed",
      branch: "issue/landed-content",
      headSha: SHA,
      revision: 1,
    })
    expect(row?.reason).toMatch(/git push bay :refs\/yrd\/submit\/issue\/landed-content/u)

    // Structurally permanent: the first refusal settles (a retry cannot change
    // containment), so audit parks it instead of counting to the loop
    // threshold while checks burn.
    expect(row?.settlement).toMatchObject({ disposition: "needs-person" })
  })

  it("re-refusals reuse the SAME identity — no number burn while the fact stands at the landed tree", async () => {
    await using app = await createApp({ prepare: containedCandidate })
    await app.bays.recordBranchSubmit({ branch: "issue/landed-content", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    await app.queue.run({}, runtime)
    await app.queue.run({}, runtime)

    const rows = Object.values(app.state().queues.admissionRefusals)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      code: "candidate-already-landed",
      branch: "issue/landed-content",
      revision: 1,
      headSha: SHA,
    })
  })
})

describe("base-classified admission failure — base-red never author-billed", () => {
  it("a failing BASE-classified step refuses with kind 'infrastructure', not the author-billed 'failure'", async () => {
    await using app = await createApp({
      classification: "base",
      checkResult: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "the base itself is red" },
      }),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    const row = Object.values(app.state().queues.admissionRefusals)[0]
    expect(row).toMatchObject({ code: "check-failed", branch: "issue/derived", kind: "infrastructure" })
  })

  it("control: the same failure on a CARRIER-classified step still bills the member (kind 'failure')", async () => {
    await using app = await createApp({
      classification: "carrier",
      checkResult: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "the member's tree is red" },
      }),
    })
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    const row = Object.values(app.state().queues.admissionRefusals)[0]
    expect(row).toMatchObject({ code: "check-failed", branch: "issue/derived", kind: "failure" })
  })
})
