/**
 * @failure A standing submit fact whose candidate can never merge is derived
 * afresh on EVERY compose pass, minting a new change number each time. The
 * live specimen (2026-08-29/30, PR2605…PR2692) minted 79 phantom changes for
 * two facts over ~17 h: derive → `candidate-conflicting` before required
 * checks → the refusal returns BEFORE any run record exists → the
 * fact's authority is never consumed → the next pass derives it again. None
 * were checked, none merged, and none were visible to `yrd pr list` (derived
 * changes carry no record). This file pins the invariant the loop broke: one
 * standing fact derives at most ONE live change, and a candidate that
 * conflicts before its checks retires the fact to a terminal finding instead
 * of leaving it standing for the next pass.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
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

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

/** The live specimen's conflicting path: a `vendor/yrd` gitlink on a sibling
 * lineage of main's, which conflicts on exactly one path and can never merge
 * without the author rebasing. */
const GITLINK_PATH = "vendor/yrd"

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

/** The specimen: preparation finds the candidate conflicting on exactly one
 * path — the `vendor/yrd` gitlink — before any required check runs. */
const conflictingCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return {
    ...candidate,
    sha: MERGED,
    ref: candidateRefFor(MERGED),
    mergeability: "conflicting",
    conflicts: [GITLINK_PATH],
  }
}

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
    prepareCandidate?: CandidatePreparer
  }> = {},
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
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
    prepareCandidate: options.prepareCandidate ?? mergeableCandidate,
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

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

/** Every run any pass retained. A change refused before its checks are queued never reaches a
 * run, which is exactly why its refusal had no durable home before this fix —
 * measured at yrd bc313acb: after a conflicting pass this is empty, and so are
 * `bays.prs` and `queues.admissionRefusals`. */
function retainedRuns(app: Awaited<ReturnType<typeof createApp>>): unknown[] {
  return [...Queues.values(app.state().queues)]
}

describe("a standing submit fact derives at most ONE live change", () => {
  it("a candidate that conflicts before its checks retires the fact; the next compose pass does not derive it again", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ log, queueMint, prepareCandidate: conflictingCandidate })

    // The author pushed refs/heads/issue/conflicting and refs/yrd/submit/issue/conflicting.
    // Its `vendor/yrd` gitlink is a sibling lineage of main's, so the candidate
    // conflicts on exactly that one path and can never merge as it stands.
    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)
    const afterFirst = queueMint.highWater()
    expect(afterFirst, "the first pass derives exactly one change").toBe(1)
    expect(actionsLogged(events)).toContain("compose-derived-admitted")

    // THE REGRESSION. The candidate conflicted before its required checks, so
    // the refusal returned before any run record existed and nothing
    // consumed the fact's authority. Today the fact stands untouched and this
    // second pass mints PR2 — the 79-phantom loop, one turn of it.
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "the fact must not be derived a second time").toBe(afterFirst)

    // The fact is retired at exactly the sha that could not progress, and the
    // row names the change the mint already spent — the durable trace that did
    // not exist before, and the reason nothing derives here again.
    const retired = app.state().queues.retiredSubmits
    expect(Object.keys(retired), "one fact, one retirement").toEqual(["issue/conflicting"])
    expect(retired["issue/conflicting"]).toMatchObject({
      branch: "issue/conflicting",
      sha: SHA,
      pr: "PR1",
      code: "candidate-conflicting",
      paths: [GITLINK_PATH],
    })
    // The refusal comes before its checks are queued, so it never reached a run — the state that
    // made the loop invisible everywhere. The retirement row is the only place
    // this change is recorded, which is why it has to exist.
    expect(retainedRuns(app), "a conflicting candidate never reaches a run").toEqual([])
    expect(actionsLogged(events)).toContain("submit-fact-retired")
    expect(actionsLogged(events)).toContain("compose-derived-fact-retired")
  })

  it("a rebased push re-projects the fact at a new sha, and the retirement stops applying", async () => {
    const queueMint = volatilePrNumberMint()
    // Mergeable on the SECOND pass models the author's cure: the retirement is
    // pinned to a sha, so new content is not blocked by the old verdict.
    let conflicting = true
    const prepare: CandidatePreparer = (input) =>
      conflicting ? conflictingCandidate(input) : mergeableCandidate(input)
    await using app = await createApp({ queueMint, prepareCandidate: prepare })

    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater()).toBe(1)

    // The author rebases and pushes; the receiver re-projects the fact at the
    // new sha. Nothing clears the retirement — it simply stops matching.
    conflicting = false
    const rebased = "9".repeat(40)
    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: rebased, base: "main" })
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "the cure must be derivable again").toBe(2)
  })

  it("the retirement is a terminal finding naming the conflicting path and the cure", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp({ log, prepareCandidate: conflictingCandidate })
    await app.bays.recordBranchSubmit({ branch: "issue/conflicting", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)

    const findings = (await app.queue.audit()).findings
    const retired = findings.find((finding) => finding.code === "submit-fact-conflicting")
    expect(
      retired,
      `expected a submit-fact-conflicting finding, got: ${findings.map((f) => f.code).join(", ")}`,
    ).toBeDefined()
    // The finding must name WHAT conflicted, not only that something did.
    expect(retired?.message).toContain(GITLINK_PATH)
    expect(retired?.pr).toBe("PR1")
    expect(retired?.refusal).toBe("candidate-conflicting")
    // The cure is the operator's next act, so the finding carries it as steps:
    // rebase onto the base, and — for a gitlink — a DESCENDANT, never a sibling
    // lineage, which is the exact shape that minted 79 phantom changes.
    const resolution = (retired?.resolution ?? []).join("\n")
    expect(resolution).toContain("rebase origin/main")
    expect(resolution).toContain(GITLINK_PATH)
    expect(resolution).toContain("DESCENDANT")
  })
})
