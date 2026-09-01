/**
 * @failure The compose pass re-reports the same spent submit facts forever and
 * charges a person for the cure. Measured 2026-09-01 on hh (yrd c6722049): one
 * hand-run pass emitted 21 `compose-derived-fact-already-landed` rows, each
 * printing `git push bay :refs/yrd/submit/<branch>`, and a human ran all 21.
 * Nothing in the pass had changed since the pass before it, and nothing would
 * have changed in the pass after — the queue had proven the facts spent and
 * then asked someone else to act on its own proof.
 *
 * What makes the repeat impossible is removing the FACT, not annotating it.
 * `bays.submits` is a journal projection of receiver events, so a
 * `branch/unsubmitted { reason: "landed" }` is enough: the next scan cannot see
 * what is not there, and no dedup memo, expiry or clearing verb is involved.
 *
 * The proof that licenses it is exact and narrow. `derivedSubmitRetirements`
 * (@yrd/core/22991 — built, and unwired until this) splits the three landings
 * `landedSubmitBranches` folds into one bare "landed", and only
 * `via: "ancestry"` — the fact's OWN commit on the base — is retired here. A
 * `via: "change-id"` landing keeps its row and its remedy, because the ref is
 * then the only pointer to work that may never have landed and no machine can
 * tell an abandoned revision from an author error.
 *
 * @level l2
 * @consumer @yrd/queue `deriveRefOnlyMembers` (the S6 compose door)
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BaysState, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, parseJournalFrame, pipe, type DeepReadonly } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  Queues,
  candidateRefFor,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type LandedSubmitScan,
  type StepExecution,
} from "@yrd/queue"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
/** A fact whose OWN commit the base already carries — the retirable arm. */
const ANCESTRY_SHA = "c".repeat(40)
/** A fact whose CHANGE landed under a different commit — never retired here. */
const CHANGE_ID_SHA = "d".repeat(40)
/** A fact still genuinely waiting: nothing about it has landed. */
const LIVE_SHA = "7".repeat(40)
/** The merge commit a change-id landing names, so the row can carry it. */
const CARRIER = "e".repeat(40)
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
      output: { path: `/repo/.bays/${input.bay}`, headSha: LIVE_SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? "/repo/.bays/bay", headSha: LIVE_SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: LIVE_SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/**
 * The host's landed scan, keyed by the sha each fact stands at, so one app can
 * hold all three arms at once and each case asserts the DELTA between them
 * rather than a claim about one branch in isolation.
 */
function scanner(proofs: ReadonlyMap<string, "ancestry" | "change-id">) {
  return ({ bays }: Readonly<{ bays: DeepReadonly<BaysState> }>): Promise<LandedSubmitScan> =>
    Promise.resolve({
      landed: Object.entries(bays.submits).flatMap(([branch, fact]) => {
        const via = proofs.get(fact.sha)
        if (via === undefined) return []
        return [{ branch, sha: fact.sha, via, ...(via === "change-id" ? { mergeCommit: CARRIER } : {}) }]
      }),
      unresolved: [],
      facts: Object.keys(bays.submits).length,
    })
}

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    log?: ReturnType<typeof createLogger>
    proofs?: ReadonlyMap<string, "ancestry" | "change-id">
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
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }: Readonly<{ sha: string }>) => ({ changeId: `I${sha}` }),
    scanLandedSubmits: scanner(options.proofs ?? new Map()),
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
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

function recorder(): Readonly<{ log: ReturnType<typeof createLogger>; events: LogEvent[] }> {
  const events: LogEvent[] = []
  return { log: createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }]), events }
}

function rows(events: readonly LogEvent[], action: string): readonly Readonly<Record<string, unknown>>[] {
  return events.flatMap((event) => (event.kind === "log" && event.props?.action === action ? [event.props] : []))
}

async function unsubmitted(
  journal: ReturnType<typeof createMemoryJournal>,
): Promise<readonly Readonly<{ branch: string; reason: string }>[]> {
  const out: Readonly<{ branch: string; reason: string }>[] = []
  for await (const batch of journal.read(0)) {
    for (const value of batch.values) {
      for (const applied of parseJournalFrame(value).events) {
        if (applied.name === "branch/unsubmitted") out.push(applied.data as { branch: string; reason: string })
      }
    }
  }
  return out
}

describe("the compose retires the standing facts it has proven landed (2026-09-01, 21 hand-applied cures)", () => {
  it("retires an ancestry-landed fact with a loud row, and says nothing about it on the next pass", async () => {
    const journal = createMemoryJournal()
    const { log, events } = recorder()
    await using app = await createApp({ journal, log, proofs: new Map([[ANCESTRY_SHA, "ancestry"]]) })
    await app.bays.recordBranchSubmit({ branch: "task/spent", sha: ANCESTRY_SHA, base: "main" })

    await expect(app.queue.run({}, runtime), "spent content composes nothing").resolves.toEqual([])

    // The act, not a cure for someone else to run: the row names the branch,
    // the sha, the base and the ref it did NOT delete.
    expect(rows(events, "compose-derived-fact-retired-landed")).toEqual([
      {
        action: "compose-derived-fact-retired-landed",
        branch: "task/spent",
        sha: ANCESTRY_SHA,
        base: "main",
        ref: "refs/yrd/submit/task/spent",
      },
    ])
    // The old chore row is not ALSO emitted for a fact this pass retired.
    expect(rows(events, "compose-derived-fact-already-landed")).toEqual([])

    // The retirement is the receiver's own vocabulary, under the reason that
    // says which lane spent it.
    expect(await unsubmitted(journal)).toEqual([{ branch: "task/spent", reason: "landed" }])
    expect(app.state().bays.submits["task/spent"]).toBeUndefined()

    // Idempotent by construction: the fact is gone, so the next scan has
    // nothing to answer for and neither row can repeat.
    const before = events.length
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    expect(rows(events.slice(before), "compose-derived-fact-retired-landed")).toEqual([])
    expect(rows(events.slice(before), "compose-derived-fact-already-landed")).toEqual([])
    expect(await unsubmitted(journal), "and no second journal write").toHaveLength(1)
  })

  it("CONTROL: a change-id landing keeps warning, keeps its fact, and is told what to do instead of the bare cure", async () => {
    const journal = createMemoryJournal()
    const { log, events } = recorder()
    await using app = await createApp({ journal, log, proofs: new Map([[CHANGE_ID_SHA, "change-id"]]) })
    await app.bays.recordBranchSubmit({ branch: "task/suspect", sha: CHANGE_ID_SHA, base: "main" })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // NOT retired: the CHANGE landed under a different commit, so this fact's
    // own content is unproven and the ref may be the only pointer to it.
    expect(rows(events, "compose-derived-fact-retired-landed")).toEqual([])
    expect(app.state().bays.submits["task/suspect"]).toMatchObject({ sha: CHANGE_ID_SHA })
    expect(await unsubmitted(journal)).toEqual([])

    const warned = rows(events, "compose-derived-fact-already-landed")
    expect(warned).toEqual([
      {
        action: "compose-derived-fact-already-landed",
        branch: "task/suspect",
        sha: CHANGE_ID_SHA,
        via: "change-id",
        mergeCommit: CARRIER,
      },
    ])
    // A person decides, and the message names BOTH exits — never the bare
    // delete, which on this arm destroys the evidence it is deciding about.
    const message = events.find(
      (event) => event.kind === "log" && event.props?.action === "compose-derived-fact-already-landed",
    )
    expect(message?.kind === "log" ? message.message : "").toContain("resubmit it under a fresh Change-Id")

    // And it is still there to decide about on the pass after.
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    expect(app.state().bays.submits["task/suspect"]).toMatchObject({ sha: CHANGE_ID_SHA })
  })

  it("CONTROL: a fact nothing has landed is untouched and still composes", async () => {
    const journal = createMemoryJournal()
    const { log, events } = recorder()
    // All three arms in one pass, so the sweep's selectivity is the assertion.
    await using app = await createApp({
      journal,
      log,
      proofs: new Map([
        [ANCESTRY_SHA, "ancestry"],
        [CHANGE_ID_SHA, "change-id"],
      ]),
    })
    await app.bays.recordBranchSubmit({ branch: "task/spent", sha: ANCESTRY_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "task/suspect", sha: CHANGE_ID_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "task/live", sha: LIVE_SHA, base: "main" })

    const runs = await app.queue.run({}, runtime)
    expect(runs, "the live fact is the only work here").toMatchObject([{ status: "completed", conclusion: "success" }])

    // Exactly one retirement, and it names the one proven arm.
    expect(await unsubmitted(journal)).toEqual([{ branch: "task/spent", reason: "landed" }])
    expect(rows(events, "compose-derived-fact-retired-landed").map((row) => row.branch)).toEqual(["task/spent"])
    expect(rows(events, "compose-derived-fact-already-landed").map((row) => row.branch)).toEqual(["task/suspect"])

    // The live fact keeps its consent triple and composed a member from it.
    expect(app.state().bays.submits["task/live"]).toMatchObject({ sha: LIVE_SHA, base: "main" })
    const composed = Queues.values(app.state().queues).flatMap((run) =>
      run.prs.flatMap((member) => (member.branch === undefined ? [] : [member.branch])),
    )
    expect(composed).toContain("task/live")
    expect(composed, "a retired fact composes nothing").not.toContain("task/spent")
  })
})
