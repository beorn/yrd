/**
 * @failure ONE submit fact is consumed by BOTH lanes. Measured live 2026-08-27
 * (hh main): branch task/materializer-root-fence carried a record-lane Change
 * AND a live refs/yrd/submit fact; the record lane merged revision 1, the fact
 * survived, and the next selectorless compose arbitrated the branch DERIVED
 * (terminal×different-sha) and merged an empty revision 2 whose second parent
 * was revision 1's own merge commit — a phantom revision and a second merge
 * commit for one approval. The invariant these tests fence: one lane consumes
 * one push, decided by LIVE ownership plus landed content — a live record's
 * branch never composes derived (the fact is that record's pending signal), a
 * fact pointing AT a terminal record's landing commit never composes (stale
 * landed content, the incident's exact signature), and the record lane's
 * merge retires the branch's fact in the same journal write as the terminal.
 * A terminal branch's genuinely NEW head DOES compose: post-purge the derived
 * lane is the only re-entry (Q1), and recordless branches are its population.
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
  derivedLaneBranches,
  Queues,
  alreadyLandedSubmits,
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

/** submit-intake.test.ts's reference configuration: no review requirement, no
 * required checks, derived self-composition ARMED (mint + enrichment) — the
 * exact regime the incident's runner was in. */
async function createApp(
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

type App = Awaited<ReturnType<typeof createApp>>

/** An authored record via `bay.submit`; head is unique per record count. */
async function submitBranch(app: App, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr
}

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

describe("one lane consumes a branch approval (PR2139 double-merge, 2026-08-27)", () => {
  it("the incident: a branch whose record already MERGED is never composed by the derived lane, even while a submit fact stands at a new sha", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = createMemoryJournal()
    await using app = await createApp({ journal, log })

    // The two-lane state `yrd pr submit` + the refs/for dual-write produce: a
    // record AND a live submit fact for the same branch at the record's head.
    const pr = await submitBranch(app, "task/fence")
    const head = pr.revs[0]?.head
    if (head === undefined) throw new Error("record has no revision head")
    await app.bays.recordBranchSubmit({ branch: "task/fence", sha: head, base: "main" })

    // Revision 1 merges through the RECORD lane.
    const first = await app.queue.run({ prs: [pr.id] }, runtime)
    expect(first).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(await journalEvents(journal, "pr/integrated")).toHaveLength(1)

    // The measured post-landing state: a submit fact stands again for the
    // branch at the revision-1 MERGE COMMIT itself (the ref survived and was
    // re-projected after landing). Terminal record × different-sha — the cell
    // the old universe ruled DERIVED.
    await app.bays.recordBranchSubmit({ branch: "task/fence", sha: MERGED, base: "main" })
    expect(derivedLaneBranches(app.state().bays)).toEqual([])
    expect(alreadyLandedSubmits(app.state().bays).map((row) => row.branch)).toEqual(["task/fence"])

    // The next selectorless compose — where the empty revision 2 was minted
    // and merged live — must compose NOTHING for this branch.
    const again = await app.queue.run({}, runtime)
    expect(again, "one submit fact must never be consumed by two lanes").toEqual([])
    expect(await journalEvents(journal, "pr/integrated")).toHaveLength(1)
    const doubled = Queues.values(app.state().queues).filter((run) =>
      run.prs.some((member) => member.branch === "task/fence" && member.id !== pr.id),
    )
    expect(doubled, "no derived run may exist beside the record lane's merge").toEqual([])

    // NO SILENT ERRORS: the exclusion says so, names the branch, and names the
    // cure — the fact is stale landed content, retire it.
    expect(actionsLogged(events)).toContain("compose-derived-fact-already-landed")
  })

  it("the record lane's merge retires the branch's submit fact in the same journal write (reason: superseded)", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, id, queueMint })
      const pr = await submitBranch(app, "task/retired")
      const head = pr.revs[0]?.head
      if (head === undefined) throw new Error("record has no revision head")
      await app.bays.recordBranchSubmit({ branch: "task/retired", sha: head, base: "main" })
      expect(app.state().bays.submits["task/retired"]).toMatchObject({ sha: head })

      const runs = await app.queue.run({ prs: [pr.id] }, runtime)
      expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

      // The consumption is recorded WITH the terminal: the fact is gone, and
      // the journal says why — the merge superseded the standing approval.
      expect(app.state().bays.submits["task/retired"]).toBeUndefined()
      const retired = await journalEvents(journal, "branch/unsubmitted")
      expect(retired.map((event) => event.data)).toEqual([{ branch: "task/retired", reason: "superseded" }])

      // Nothing is left for the derived lane even BEFORE its own admission
      // filter: the next compose has no fact to derive from.
      expect(derivedLaneBranches(app.state().bays)).toEqual([])
      await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    }

    // The retirement replays: the event is registered and schema-valid, so a
    // fresh projection over the same journal converges on the retired state.
    await using replayed = await createApp({ journal, id, queueMint })
    expect(replayed.state().bays.submits["task/retired"]).toBeUndefined()
  })

  it("a mid-run re-push survives the merge and COMPOSES as the branch's derived re-entry (Q1)", async () => {
    await using app = await createApp({})
    const pr = await submitBranch(app, "task/repushed")
    // The author approved NEWER content than the revision the run pins.
    await app.bays.recordBranchSubmit({ branch: "task/repushed", sha: RESUBMIT_SHA, base: "main" })

    const runs = await app.queue.run({ prs: [pr.id] }, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

    // The standing consent is for content the merge did NOT land — it stands,
    // and post-purge the derived lane IS the terminal branch's re-entry: the
    // record is history, the new head is new work (Q1). Excluding record
    // history wholesale would strand every resubmit of a merged branch.
    expect(app.state().bays.submits["task/repushed"]).toMatchObject({ sha: RESUBMIT_SHA })
    expect(alreadyLandedSubmits(app.state().bays)).toEqual([])
    expect(derivedLaneBranches(app.state().bays)).toEqual(["task/repushed"])
    const again = await app.queue.run({}, runtime)
    expect(again).toMatchObject([{ status: "completed", conclusion: "success" }])
    const reentry = Queues.values(app.state().queues).find((run) =>
      run.prs.some((member) => member.branch === "task/repushed" && member.headSha === RESUBMIT_SHA),
    )
    expect(reentry, "the new head runs as a derived member").toBeDefined()
    expect(reentry?.prs[0]?.id).not.toBe(pr.id)
  })

  it("a genuinely recordless branch still composes, runs and merges as a derived member", async () => {
    await using app = await createApp({})
    await app.bays.recordBranchSubmit({ branch: "issue/recordless", sha: RECORDLESS_SHA, base: "main" })
    expect(derivedLaneBranches(app.state().bays)).toEqual(["issue/recordless"])
    expect(alreadyLandedSubmits(app.state().bays)).toEqual([])

    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().bays.prs).toEqual({})
    const record = Queues.values(app.state().queues).find((run) =>
      run.prs.some((member) => member.branch === "issue/recordless"),
    )
    expect(record?.prs[0]).toMatchObject({ branch: "issue/recordless", headSha: RECORDLESS_SHA })
  })

  it("the derived universe: live ownership and landed content exclude; terminal history with a NEW head composes", async () => {
    await using app = await createApp({})
    // Open record + fact: record-lane pendency, excluded — the fact is the
    // live record's own pending signal.
    await submitBranch(app, "task/open")
    await app.bays.recordBranchSubmit({ branch: "task/open", sha: SHA, base: "main" })
    // Withdrawn record + NEW-head fact: the terminal branch's derived
    // re-entry (Q1) — composes.
    const withdrawn = await submitBranch(app, "task/withdrawn")
    await app.bays.closePr({ pr: withdrawn.id, reason: "superseded" })
    await app.bays.recordBranchSubmit({ branch: "task/withdrawn", sha: RESUBMIT_SHA, base: "main" })
    // Merged record + fact AT the landing commit: the incident cell — stale
    // landed content, excluded.
    const merged = await submitBranch(app, "task/merged")
    await app.queue.run({ prs: [merged.id] }, runtime)
    await app.bays.recordBranchSubmit({ branch: "task/merged", sha: MERGED, base: "main" })
    // Recordless: the derived lane's own population.
    await app.bays.recordBranchSubmit({ branch: "issue/recordless", sha: RECORDLESS_SHA, base: "main" })

    expect(derivedLaneBranches(app.state().bays)).toEqual(["issue/recordless", "task/withdrawn"])
    expect(alreadyLandedSubmits(app.state().bays).map((row) => row.branch)).toEqual(["task/merged"])
  })
})
