/**
 * @failure THREE writers emit `pr/integrated` — the advance-path record loop,
 * the `reconcileMerge` repository-index reconciler, and the `settled`
 * command's derived batch — and S7 deletes the record store those first two
 * exist to feed. Post-S7 exactly ONE survives: the `settled` command emits
 * every non-intent member's terminal, sourced from the run's own snapshots,
 * in the SAME journal write as `queue/run/settled` (once-per-run is
 * structural: the settlement retires the root). During the transition window
 * records still exist, so the settled batch must emit a record member's
 * terminal byte-identically to the advance loop it replaced — same fields,
 * same store dedupe, same submit-fact retirement riding the batch — or record
 * terminals double-emit across the cutover. `reconcileMerge` retires with a
 * typed refusal naming the replacement (merged-truth); its repository-proven
 * merges are read directly, never reconciled INTO an index.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, parseJournalFrame, pipe } from "@yrd/core"
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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
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
    batch: 2,
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
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

async function journalFrames(
  journal: ReturnType<typeof createMemoryJournal>,
): Promise<readonly (readonly Readonly<{ name: string; data: unknown }>[])[]> {
  const frames: (readonly Readonly<{ name: string; data: unknown }>[])[] = []
  for await (const batch of journal.read(0)) {
    for (const value of batch.values) {
      frames.push(parseJournalFrame(value).events)
    }
  }
  return frames
}

function eventsNamed(
  frames: readonly (readonly Readonly<{ name: string; data: unknown }>[])[],
  name: string,
): readonly Readonly<{ name: string; data: unknown }>[] {
  return frames.flat().filter((event) => event.name === name)
}

describe("settlement single-writer — the settled command is the ONE terminal emitter", () => {
  it("a run with a record member AND a derived member settles BOTH terminals exactly once, in the settlement's own journal write, replay-stable", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, id, queueMint })
      // Record member, with a standing submit fact at its head so the record
      // arm's fact retirement is observable (advance-loop byte parity).
      await app.bays.submit({ branch: "task/record", headSha: "1".repeat(40), base: "main", baseSha: BASE })
      const record = Object.values(app.state().bays.prs)[0]
      if (record === undefined) throw new Error("no record was created")
      const recordHead = record.revs[0]?.head
      if (recordHead === undefined) throw new Error("record has no head")
      await app.bays.recordBranchSubmit({ branch: "task/record", sha: recordHead, base: "main" })
      // Derived member: a recordless branch submitted only in git.
      await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

      const runs = await app.queue.run({}, runtime)
      expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
      expect(runs[0]?.prs.map((member) => member.branch).toSorted()).toEqual(["issue/derived", "task/record"])

      const frames = await journalFrames(journal)
      const integrated = eventsNamed(frames, "pr/integrated")
      expect(integrated).toHaveLength(2)
      const byPr = new Map(integrated.map((event) => [(event.data as { pr: string }).pr, event.data]))
      expect([...byPr.keys()].toSorted()).toEqual([record.id, "PR2"].toSorted())

      // Single writer: every terminal rides the settlement's OWN write — the
      // frame that carries `queue/run/settled` — never an advance frame.
      for (const frame of frames) {
        const terminals = frame.filter((event) => event.name === "pr/integrated")
        if (terminals.length === 0) continue
        expect(
          frame.some((event) => event.name === "queue/run/settled"),
          "a pr/integrated outside the settlement write means a second emitter survives",
        ).toBe(true)
      }

      // Record arm byte-parity legs: the store absorbed the terminal, and the
      // merge consumed the branch approval in the SAME write (superseded).
      expect(app.state().bays.prs[record.id]?.state).not.toBe("open")
      expect(app.state().bays.submits["task/record"]).toBeUndefined()
      const retired = eventsNamed(frames, "branch/unsubmitted")
      expect(retired.map((event) => event.data)).toEqual([{ branch: "task/record", reason: "superseded" }])
      const retirementFrame = frames.find((frame) => frame.some((event) => event.name === "branch/unsubmitted"))
      expect(retirementFrame?.some((event) => event.name === "queue/run/settled")).toBe(true)

      // The derived member's fact deliberately outlives its run.
      expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })

      // Once per run is structural: another selectorless compose emits no
      // second terminal for either member.
      await app.queue.run({}, runtime)
      expect(eventsNamed(await journalFrames(journal), "pr/integrated")).toHaveLength(2)
    }

    // Replay converges: the same journal projects the same terminal state and
    // re-emits nothing.
    await using replayed = await createApp({ journal, id, queueMint })
    const record = Object.values(replayed.state().bays.prs)[0]
    expect(record?.integration).toMatchObject({ commit: MERGED, baseSha: BASE })
    expect(eventsNamed(await journalFrames(journal), "pr/integrated")).toHaveLength(2)
  })

  it("reconcileMerge is retired: typed refusal naming the merged-truth replacement, no emission, store untouched", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal })
    await app.bays.submit({ branch: "task/record", headSha: "1".repeat(40), base: "main", baseSha: BASE })
    const record = Object.values(app.state().bays.prs)[0]
    if (record === undefined) throw new Error("no record was created")
    const revision = record.revs[0]
    if (revision === undefined) throw new Error("record has no revision")

    await expect(
      app.queue.reconcileMerge({
        pr: record.id,
        revision: revision.n,
        headSha: revision.head,
        run: "R-recovered",
        commit: MERGED,
        landingSha: MERGED,
        baseSha: BASE,
        changeId: revision.changeId ?? `I${"c".repeat(40)}`,
      }),
    ).rejects.toThrow(/retired.*merged-truth|merged-truth.*retired/su)

    expect(eventsNamed(await journalFrames(journal), "pr/integrated")).toHaveLength(0)
    expect(app.state().bays.prs[record.id]?.state).toBe("open")
  })
})
