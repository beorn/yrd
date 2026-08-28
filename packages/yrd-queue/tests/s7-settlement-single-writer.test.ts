/**
 * @failure THREE writers emit `pr/integrated` — the advance-path record loop,
 * the `reconcileMerge` repository-index reconciler, and the `settled`
 * command's derived batch — and S7 deletes the record store those first two
 * exist to feed. Post-S7 exactly ONE survives: the `settled` command emits
 * every non-intent member's terminal, sourced from the run's own snapshots,
 * in the SAME journal write as `queue/run/settled` (once-per-run is
 * structural: the settlement retires the root). `reconcileMerge` retires with
 * a typed refusal naming the replacement (merged-truth); its repository-proven
 * merges are read directly, never reconciled INTO an index.
 *
 * S7 conversion note (branch-is-change, @i/10 22991): the cross-lane parity
 * legs are gone with the lane. `bays.submit` now refuses `record-mint-retired`,
 * so no record member can be minted and the advance loop's byte-parity — store
 * dedupe, and the `branch/unsubmitted` submit-fact retirement riding the
 * settlement batch — has no reachable subject here (`submitFactRetirement` is
 * documented record-terminal-only). Every member below is derived, and the
 * single-writer, once-per-run, and replay-stability contracts are unchanged.
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
const FIRST = "1".repeat(40)
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
  it("a run settles BOTH members' terminals exactly once, in the settlement's own journal write, replay-stable", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const queueMint = volatilePrNumberMint()
    {
      await using app = await createApp({ journal, id, queueMint })
      // Two derived members — recordless branches submitted only in git. Post-S7
      // this is the only lane: `bays.submit` refuses `record-mint-retired`.
      await app.bays.recordBranchSubmit({ branch: "task/first", sha: FIRST, base: "main" })
      await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: SHA, base: "main" })

      const runs = await app.queue.run({}, runtime)
      expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
      expect(runs[0]?.prs.map((member) => member.branch).toSorted()).toEqual(["issue/derived", "task/first"])

      const frames = await journalFrames(journal)
      const integrated = eventsNamed(frames, "pr/integrated")
      expect(integrated).toHaveLength(2)
      // One terminal per member, each carrying the run's own merge proof — the
      // fields the deleted advance loop used to write onto the record.
      const byHead = new Map(
        integrated.map((event) => [(event.data as { headSha: string }).headSha, event.data as object]),
      )
      expect([...byHead.keys()].toSorted()).toEqual([FIRST, SHA].toSorted())
      for (const terminal of byHead.values()) {
        expect(terminal).toMatchObject({ commit: MERGED, baseSha: BASE })
      }

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

      // A derived member's fact deliberately outlives its run — consumption is
      // derived from run history, and a re-push renews authority — so the
      // settlement retires nothing (`submitFactRetirement` is record-only).
      expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })
      expect(app.state().bays.submits["task/first"]).toMatchObject({ sha: FIRST })
      expect(eventsNamed(frames, "branch/unsubmitted")).toEqual([])

      // Once per run is structural: another selectorless compose emits no
      // second terminal for either member.
      await app.queue.run({}, runtime)
      expect(eventsNamed(await journalFrames(journal), "pr/integrated")).toHaveLength(2)
    }

    // Replay converges: the same journal projects the same settled run and
    // re-emits nothing.
    await using replayed = await createApp({ journal, id, queueMint })
    const settled = Queues.values(replayed.state().queues).filter((run) => run.passedAt !== undefined)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.prs.map((member) => member.branch).toSorted()).toEqual(["issue/derived", "task/first"])
    expect(eventsNamed(await journalFrames(journal), "pr/integrated")).toHaveLength(2)
  })

  it("reconcileMerge is retired: typed refusal naming the merged-truth replacement, and no emission", async () => {
    const journal = createMemoryJournal()
    await using app = await createApp({ journal })
    // A live derived member the reconciler would have indexed. Its args are
    // synthetic because the record it used to name can no longer be minted —
    // the refusal fires before any lookup, which is the point.
    await app.bays.recordBranchSubmit({ branch: "task/first", sha: FIRST, base: "main" })

    await expect(
      app.queue.reconcileMerge({
        pr: "PR1",
        revision: 1,
        headSha: FIRST,
        run: "R-recovered",
        commit: MERGED,
        landingSha: MERGED,
        baseSha: BASE,
        changeId: `I${"c".repeat(40)}`,
      }),
    ).rejects.toThrow(/retired.*merged-truth|merged-truth.*retired/su)

    // Nothing was emitted and the member's approval is untouched: a retired
    // command must not be a half-writer.
    expect(eventsNamed(await journalFrames(journal), "pr/integrated")).toHaveLength(0)
    expect(app.state().bays.submits["task/first"]).toMatchObject({ sha: FIRST })
  })
})
