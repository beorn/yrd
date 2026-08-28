/**
 * @failure ONE submit fact is consumed TWICE, so one approval produces two
 * merge commits. Measured live 2026-08-27 (hh main): branch
 * task/materializer-root-fence carried a record-lane Change AND a live
 * refs/yrd/submit fact; the record lane merged revision 1, the fact survived,
 * and the next selectorless compose arbitrated the branch derived and merged
 * an empty revision 2 whose second parent was revision 1's own merge commit —
 * a phantom revision and a second merge commit for one approval.
 *
 * S7 (branch-is-change, @i/10 22991) deletes the record store, so the
 * two-LANE half of the original incident is structurally impossible: there is
 * one lane. What survives — and is the half that actually did the damage — is
 * the CONSUMPTION rule: a standing submit fact is one push's consent, spent by
 * exactly one run, and renewed only by the author pushing again. Without it a
 * single approval re-composes every drain cycle forever, which is the same
 * double-merge with one lane instead of two. These tests fence that rule on
 * the production path (submit fact in, compose out), plus the incident's own
 * signature — a fact standing at content the queue already landed never mints
 * a second merge.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, parseJournalFrame, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  Queues,
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
const RESUBMIT_SHA = "8".repeat(40)
const RECORDLESS_SHA = "9".repeat(40)
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

/** The incident's own candidate answer: the approved tree is already contained
 * in the base, so merging it adds nothing and the "candidate" IS the base
 * commit. Post-S7 this — not a record's integration stamp — is how the queue
 * recognises landed content. */
const containedCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: input.baseSha, ref: candidateRefFor(input.baseSha), mergeability: "mergeable" }
}

/** submit-intake.test.ts's reference configuration: no review requirement, no
 * required checks, derived self-composition ARMED (mint + enrichment) — the
 * exact regime the incident's runner was in. */
async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
    prepare?: CandidatePreparer
  }> = {},
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
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
    prepareCandidate: options.prepare ?? mergeableCandidate,
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
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

async function journalEvents(
  journal: ReturnType<typeof createMemoryJournal>,
  name: string,
): Promise<readonly Readonly<{ name: string; data: unknown }>[]> {
  const out: Readonly<{ name: string; data: unknown }>[] = []
  for await (const batch of journal.read(0)) {
    for (const value of batch.values) {
      const frame = parseJournalFrame(value)
      for (const applied of frame.events) if (applied.name === name) out.push(applied)
    }
  }
  return out
}

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

/** Every run that carried a member on `branch` — the post-S7 home of "did this
 * branch merge", since a derived member has no record to stamp. */
function runsForBranch(app: App, branch: string) {
  return Queues.values(app.state().queues).filter((run) => run.prs.some((member) => member.branch === branch))
}

describe("one submit fact is consumed by one run (PR2139 double-merge, 2026-08-27)", () => {
  it("the incident: a standing fact spent by a merge never composes a second merge for the same push", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal })
    await app.bays.recordBranchSubmit({ branch: "task/fence", sha: SHA, base: "main" })

    // The push merges once.
    const first = await app.queue.run({}, runtime)
    expect(first).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(await journalEvents(journal, "pr/integrated")).toHaveLength(1)

    // The next selectorless compose — where the empty revision 2 was minted
    // and merged live — must compose NOTHING for this branch: the consent was
    // spent, and nothing has renewed it.
    const again = await app.queue.run({}, runtime)
    expect(again, "one submit fact must never be consumed twice").toEqual([])
    expect(await journalEvents(journal, "pr/integrated")).toHaveLength(1)
    expect(runsForBranch(app, "task/fence")).toHaveLength(1)
  })

  it("the consumption is durable and named: the ledger says the authority was spent, not that the branch is unknown", async () => {
    await using app = await createApp({})
    await app.bays.recordBranchSubmit({ branch: "task/spent", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // NO SILENT ERRORS: a branch that stops composing must say why, with the
    // cure (re-push) implied by the code rather than vanishing from every
    // surface.
    const row = Object.values(app.state().queues.admissionRefusals).find((entry) => entry.branch === "task/spent")
    expect(row).toMatchObject({ branch: "task/spent", code: "queue-submit-authority-consumed" })
  })

  it("a re-push renews the consent and composes the branch's derived re-entry as a NEW revision of the SAME identity", async () => {
    await using app = await createApp({})
    await app.bays.recordBranchSubmit({ branch: "task/repushed", sha: SHA, base: "main" })
    const first = await app.queue.run({}, runtime)
    expect(first).toMatchObject([{ status: "completed", conclusion: "success" }])
    const firstMember = runsForBranch(app, "task/repushed")[0]?.prs[0]
    expect(firstMember).toMatchObject({ headSha: SHA, revision: 1 })

    // The author approves NEWER content: per-push consent, so the branch is
    // runnable again — post-S7 the derived lane is the only re-entry there is.
    await app.bays.recordBranchSubmit({ branch: "task/repushed", sha: RESUBMIT_SHA, base: "main" })
    const again = await app.queue.run({}, runtime)
    expect(again).toMatchObject([{ status: "completed", conclusion: "success" }])

    const reentry = runsForBranch(app, "task/repushed").find((run) =>
      run.prs.some((member) => member.headSha === RESUBMIT_SHA),
    )
    expect(reentry, "the new head runs as a derived member").toBeDefined()
    // Branch continuity: the same change identity, the next revision — not a
    // second change competing for the same branch.
    expect(reentry?.prs[0]).toMatchObject({
      id: firstMember?.id,
      changeId: firstMember?.changeId,
      revision: 2,
      headSha: RESUBMIT_SHA,
    })
  })

  it("the incident's signature: a fact standing at content the base already holds is parked, never merged a second time", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = createMemoryJournal()
    await using app = await createApp({ journal, log, prepare: containedCandidate })
    await app.bays.recordBranchSubmit({ branch: "task/landed", sha: MERGED, base: "main" })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    expect(await journalEvents(journal, "pr/integrated")).toEqual([])

    // Named, durable, and pointed at the cure — the stale fact is retired, not
    // resubmitted.
    const row = Object.values(app.state().queues.admissionRefusals).find((entry) => entry.branch === "task/landed")
    expect(row).toMatchObject({ branch: "task/landed", code: "candidate-already-landed" })
    expect(row?.reason).toMatch(/refs\/yrd\/submit\/task\/landed/u)
    expect(actionsLogged(events)).toContain("compose-candidate-skip")
  })

  it("a retired fact composes nothing, and an unrelated standing fact in the same drain still merges", async () => {
    await using app = await createApp({})
    await app.bays.recordBranchSubmit({ branch: "task/withdrawn", sha: SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/recordless", sha: RECORDLESS_SHA, base: "main" })
    // The author withdraws one approval before any compose sees it.
    await app.bays.recordBranchUnsubmit({ branch: "task/withdrawn", reason: "deleted" })
    expect(app.state().bays.submits["task/withdrawn"]).toBeUndefined()

    const runs = await app.queue.run({}, runtime)

    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(runsForBranch(app, "task/withdrawn")).toEqual([])
    expect(runsForBranch(app, "issue/recordless")[0]?.prs[0]).toMatchObject({
      branch: "issue/recordless",
      headSha: RECORDLESS_SHA,
    })
  })
})
