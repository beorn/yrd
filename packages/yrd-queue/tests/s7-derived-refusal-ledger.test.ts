/**
 * @failure A DERIVED member's first-admission check failure journals NOTHING
 * durable (wave defect 1, cli-conv obs 2): `noteCandidateRefusal` resolves the
 * member by id, a first-admission derived member has neither a record nor a
 * retained run snapshot, so the refusal is silently skipped and
 * `admissionRefusals` stays `{}` — the 22395 head-of-line blindness, back for
 * the lane that is becoming the ONLY lane. And because identity reuse anchors
 * only on retained snapshots, every refused compose re-mints a fresh PR number
 * for the same branch (host-conv gap D — number burn). The cure is one row:
 * the refusal ledger records the synthetic id WITH its branch and exact
 * refused tree, the streak survives (and compacts on the fact, not the store),
 * and `mintDerivedMemberIdentity` reuses the row's identity across refused
 * composes. The standing unrecorded-submit row must also name the action the
 * skip actually fires (`compose-candidate-skip`), not only the derivation
 * refusal (`compose-derived-refused`).
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
import { mintDerivedMemberIdentity } from "../src/derived-member.ts"
import { Queues } from "../src/model.ts"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const RESUBMIT_SHA = "8".repeat(40)
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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/** The armed-door harness with the one admission check FAILING — the exact
 * regime of wave defect 1: a derived branch whose first admission is refused
 * before any run can retain its identity. */
async function createFailingCheckApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
  }> = {},
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-failed", message: "'check' exited 1" },
    }),
    { revision: "check-v1", output: CheckResultSchema },
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
    prepareCandidate: mergeableCandidate,
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
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
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

describe("durable derived refusal ledger (wave defect 1 — 22395 for the derived lane)", () => {
  it("a derived member's FIRST-admission check failure records a refusal row keyed by the synthetic id, with branch and exact refused tree", async () => {
    await using app = await createFailingCheckApp()
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)

    // No record, no run — before the fix the resolve-by-id skip left this {}.
    expect(app.state().bays.prs).toEqual({})
    expect(Queues.values(app.state().queues)).toEqual([])
    expect(
      app.state().queues.admissionRefusals.PR1,
      "a refused derived first admission must leave a durable trace — the ledger row is its ONLY home",
    ).toMatchObject({
      pr: "PR1",
      branch: "issue/derived",
      revision: 1,
      headSha: SHA,
      code: "check-failed",
      count: 1,
    })
  })

  it("refused composes REUSE the row's identity instead of burning a number per cycle (host-conv gap D)", async () => {
    const queueMint = volatilePrNumberMint()
    await using app = await createFailingCheckApp({ queueMint })
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    expect(queueMint.highWater()).toBe(1)

    await app.queue.run({}, runtime)
    expect(
      queueMint.highWater(),
      "the second refused compose must reuse PR1 from the refusal row, not mint PR2",
    ).toBe(1)
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ pr: "PR1", branch: "issue/derived" })
    expect(app.state().queues.admissionRefusals.PR2).toBeUndefined()
  })

  it("a re-push continues the SAME identity at the next revision, and the row follows the new tree", async () => {
    const queueMint = volatilePrNumberMint()
    await using app = await createFailingCheckApp({ queueMint })
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ revision: 1, headSha: SHA })

    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater()).toBe(1)
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({
      pr: "PR1",
      branch: "issue/derived",
      revision: 2,
      headSha: RESUBMIT_SHA,
      count: 1,
    })
  })

  it("the row replays: branch-carrying refusal facts parse and converge on a fresh projection", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createFailingCheckApp({ journal, id, queueMint })
      await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })
      await app.queue.run({}, runtime)
      expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ branch: "issue/derived" })
    }
    await using replayed = await createFailingCheckApp({ journal, id, queueMint })
    expect(replayed.state().queues.admissionRefusals.PR1).toMatchObject({
      pr: "PR1",
      branch: "issue/derived",
      headSha: SHA,
      code: "check-failed",
    })
  })

  it("mintDerivedMemberIdentity anchors on the refusal row: same tree keeps the refused revision, a new tree continues above it", () => {
    const bays = {
      byId: {},
      prs: {},
      receipts: {},
      submits: { "issue/derived": { sha: SHA, base: "main", at: "2026-01-01T00:00:00.000Z" } },
    }
    const queues = {
      ...Queues.empty({ batchSize: 1 }),
      admissionRefusals: {
        PR7: {
          pr: "PR7",
          branch: "issue/derived",
          revision: 3,
          headSha: SHA,
          code: "check-failed",
          reason: "'check' exited 1",
          count: 2,
          firstAt: "2026-01-01T00:00:00.000Z",
          lastAt: "2026-01-01T00:01:00.000Z",
        },
      },
    }
    const mint = volatilePrNumberMint(7)
    const sameTree = mintDerivedMemberIdentity({ mint, bays: bays as never, queues, branch: "issue/derived" })
    expect(sameTree).toMatchObject({ id: "PR7", revision: 3, minted: false })

    const repushed = {
      ...bays,
      submits: { "issue/derived": { sha: RESUBMIT_SHA, base: "main", at: "2026-01-01T00:02:00.000Z" } },
    }
    const nextTree = mintDerivedMemberIdentity({ mint, bays: repushed as never, queues, branch: "issue/derived" })
    expect(nextTree).toMatchObject({ id: "PR7", revision: 4, minted: false })

    const otherBranch = mintDerivedMemberIdentity({ mint, bays: repushed as never, queues, branch: "issue/other" })
    expect(otherBranch).toMatchObject({ id: "PR8", minted: true })
  })

  it("the standing unrecorded-submit row names BOTH skip actions — the derivation refusal and the admission skip", async () => {
    await using app = await createFailingCheckApp()
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)

    const rows = app.queue.unrecordedSubmits()
    expect(rows).toHaveLength(1)
    const message = rows[0]?.reason.message ?? ""
    expect(message).toContain("compose-derived-refused")
    expect(
      message,
      "an admission-check refusal fires 'compose-candidate-skip' — the row must not point readers at the wrong grep string (22395-shaped)",
    ).toContain("compose-candidate-skip")
  })
})
