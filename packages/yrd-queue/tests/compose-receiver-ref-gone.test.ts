/**
 * @failure `BaysState.submits` is a MIRROR of the receiver store's
 * `refs/yrd/submit/<branch>` refs, and the compose derives its admission
 * universe from that mirror alone. A ref deleted with `git update-ref -d` in
 * the store journals nothing — only the receive hook writes
 * `branch/unsubmitted` — so the mirror row outlives its ref and the derived
 * lane re-admits it on every pass, forever. Measured 2026-09-02:
 * `task/w28-silentsites` at b3e5141d (journal record PR2749 r2) kept being
 * re-composed after every ref of it had been deleted from
 * `/hh/dev/.git/yrd/prs.git`.
 *
 * GIT IS THE TRUTH (docs/@adr/0001). This file pins the MECHANISM for that
 * rule: the compose asks the receiver store which submit refs exist, and never
 * admits a mirror fact the store has no ref for, saying so loudly.
 *
 * Reported, not journaled, and deliberately so. Every other retirement records
 * a verdict git cannot answer again; this one is re-derived from the store on
 * every pass, so a durable row would be a second copy of an answer git already
 * holds — which is how the mirror this fix is about came to disagree with its
 * refs in the first place.
 *
 * NOT YET WIRED, and the last case in this file is why. "No ref" is not the
 * same question as "ref deleted": the receiver writes a ref before journaling
 * its fact, but `yrd pr submit <branch>` journals a fact and writes no ref at
 * all, so this mechanism retires every local submission it is shown. Nothing
 * readable in the store separates the two producers. That case is pinned here
 * as a blocker, not a cure, and the yrd-cli host says the same at its
 * (commented-out) wiring site.
 *
 * The mandatory negative control rides every case: a fact WITH a ref, built
 * from the same fixture, must still compose. Dropping a live approval is the
 * one outcome worse than re-admitting a dead one.
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
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
  type SubmitRefScan,
} from "@yrd/queue"

/** The capability's own shape, named once so every fixture matches it. */
type ScanSubmitRefs = (
  input: Readonly<{ facts: readonly Readonly<{ branch: string; sha: string }>[] }>,
) => Promise<SubmitRefScan>

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
/** The incident's own two facts: one whose ref still stands in the store, one
 * whose ref was deleted by hand. Both mirror rows read identically. */
const LIVE_BRANCH = "task/w28-live"
const LIVE_SHA = "7".repeat(40)
const GONE_BRANCH = "task/w28-silentsites"
const GONE_SHA = "b3e5141d".padEnd(40, "0")
const STORE = "/hh/dev/.git/yrd/prs.git"
const CHANGE_ID = `I${"c".repeat(40)}`
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

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

/** A receiver-store reader over a hand-named ref set — the shape
 * `landedSubmitScanner`'s sibling wiring supplies in the CLI host. `undefined`
 * omits the capability entirely, which is the "nobody can ask" case. */
function refScanner(branches: readonly string[] | undefined, fail?: Error): ScanSubmitRefs | undefined {
  if (fail !== undefined) {
    return () => {
      throw fail
    }
  }
  if (branches === undefined) return undefined
  return () =>
    Promise.resolve({
      answered: true as const,
      store: STORE,
      refs: new Map(branches.map((branch) => [branch, branch === GONE_BRANCH ? GONE_SHA : LIVE_SHA])),
    })
}

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
    scanSubmitRefs?: ScanSubmitRefs
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
    prepareCandidate: mergeableCandidate,
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
    readSubmitEnrichment: () => ({ changeId: CHANGE_ID }),
    ...(options.scanSubmitRefs === undefined ? {} : { scanSubmitRefs: options.scanSubmitRefs }),
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
      clock: () => "2026-09-02T12:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

function rows(events: readonly LogEvent[], action: string): LogEvent[] {
  return events.filter((event) => event.kind === "log" && event.props?.action === action)
}

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

/** Every event name the journal holds, in order. */
async function journaledEventNames(journal: ReturnType<typeof createMemoryJournal>): Promise<string[]> {
  const names: string[] = []
  for await (const page of journal.read()) {
    for (const frame of page.values as readonly Readonly<{ events: readonly Readonly<{ name: string }>[] }>[]) {
      names.push(...frame.events.map((event) => event.name))
    }
  }
  return names
}

function tracingLog(events: LogEvent[]): ReturnType<typeof createLogger> {
  return createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
}

describe("compose admits only mirror facts a receiver ref still stands behind", () => {
  it("the PR2749 reproduction: a fact that composed, then lost its ref, is retired and never composes again", async () => {
    const events: LogEvent[] = []
    const journal = createMemoryJournal()
    const queueMint = volatilePrNumberMint()
    // The store as it was when both branches were pushed: a ref for each.
    let present = [LIVE_BRANCH, GONE_BRANCH]
    await using app = await createApp({
      log: tracingLog(events),
      journal,
      queueMint,
      scanSubmitRefs: () =>
        Promise.resolve({
          answered: true as const,
          store: STORE,
          refs: new Map(present.map((branch) => [branch, branch === GONE_BRANCH ? GONE_SHA : LIVE_SHA])),
        }),
    })

    await app.bays.recordBranchSubmit({ branch: LIVE_BRANCH, sha: LIVE_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: GONE_SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(
      rows(events, "compose-derived-admitted").map((row) => row.props?.branch),
      "both compose while both refs stand — the state the incident started from",
    ).toEqual(expect.arrayContaining([LIVE_BRANCH, GONE_BRANCH]))

    // `git --git-dir=prs.git update-ref -d refs/yrd/submit/task/w28-silentsites`.
    // This journals NOTHING: only the receive hook writes `branch/unsubmitted`,
    // so the projection stands with nothing behind it. Before this fix the lane
    // re-admitted it on every pass, forever.
    present = [LIVE_BRANCH]
    events.length = 0
    await app.queue.run({}, runtime)

    const admitted = rows(events, "compose-derived-admitted").map((row) => row.props?.branch)
    expect(admitted, "a mirror fact with no ref behind it must never be admitted again").not.toContain(GONE_BRANCH)

    // Exactly one WARN record, naming everything an operator needs to act on
    // without going and measuring it by hand.
    const warned = rows(events, "compose-derived-fact-receiver-ref-gone")
    expect(warned).toHaveLength(1)
    expect(warned[0]?.kind === "log" ? warned[0].level : undefined).toBe("warn")
    expect(warned[0]?.props).toMatchObject({ branch: GONE_BRANCH, sha: GONE_SHA, store: STORE })
    expect(warned[0]?.kind === "log" ? warned[0].message : "").toContain(STORE)

    // Nothing journaled: the verdict is re-derived from the store every pass,
    // so there is no second copy of it to fall out of step with the refs.
    expect(
      (await journaledEventNames(journal)).filter((name) => name === "queue/submit/retired"),
      "the exclusion writes no durable row",
    ).toEqual([])
    expect(app.state().queues.retiredSubmits[GONE_BRANCH]).toBeUndefined()
    expect(app.state().queues.retiredSubmits[LIVE_BRANCH], "the live fact is untouched").toBeUndefined()

    // The scan that found what it expected says so, at info.
    const found = rows(events, "compose-submit-refs-scanned")
    expect(found).toHaveLength(1)
    expect(found[0]?.kind === "log" ? found[0].level : undefined).toBe("info")
    expect(found[0]?.props).toMatchObject({ store: STORE, refs: 1, missing: 1 })
  })

  it("the retirement is idempotent: a later pass re-warns nothing and re-retires nothing", async () => {
    const events: LogEvent[] = []
    const journal = createMemoryJournal()
    let present = [GONE_BRANCH]
    await using app = await createApp({
      log: tracingLog(events),
      journal,
      scanSubmitRefs: () =>
        Promise.resolve({
          answered: true as const,
          store: STORE,
          refs: new Map(present.map((branch) => [branch, GONE_SHA])),
        }),
    })

    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: GONE_SHA, base: "main" })
    await app.queue.run({}, runtime)
    present = []
    events.length = 0
    await app.queue.run({}, runtime)
    await app.queue.run({}, runtime)

    // The condition reporter dedups by key (branch + sha), so a standing dead
    // fact announces once and is suppressed after — not one row per pass.
    expect(
      rows(events, "compose-derived-fact-receiver-ref-gone"),
      "one announcement per dead fact, not one per pass",
    ).toHaveLength(1)
    expect(
      (await journaledEventNames(journal)).filter((name) => name === "queue/submit/retired"),
      "and nothing durable is written on any pass",
    ).toEqual([])
  })

  it("a re-push at a NEW sha is newer consent: the ref returns and the branch derives again", async () => {
    const queueMint = volatilePrNumberMint()
    const rebased = "9".repeat(40)
    let present: string[] = []
    await using app = await createApp({
      queueMint,
      scanSubmitRefs: () =>
        Promise.resolve({ answered: true as const, store: STORE, refs: new Map(present.map((b) => [b, rebased])) }),
    })

    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: GONE_SHA, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater(), "the dead fact derives nothing").toBe(0)

    present = [GONE_BRANCH]
    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: rebased, base: "main" })
    await app.queue.run({}, runtime)
    expect(queueMint.highWater(), "new content is not blocked by the old retirement").toBe(1)
  })

  it("a store that cannot be read FAILS the compose loudly, naming the store", async () => {
    const events: LogEvent[] = []
    await using app = await createApp({
      log: tracingLog(events),
      scanSubmitRefs: refScanner(
        undefined,
        new Error(`yrd: could not list receiver submit refs in '${STORE}': ENOENT`),
      ),
    })

    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: GONE_SHA, base: "main" })
    await expect(app.queue.run({}, runtime)).rejects.toThrow(new RegExp(STORE.replaceAll("/", "\\/"), "u"))
    expect(actionsLogged(events), "an unreadable store never admits anything").not.toContain("compose-derived-admitted")
    expect(app.state().queues.retiredSubmits[GONE_BRANCH], "an unread store retires nothing").toBeUndefined()
  })

  it("no reader configured says so LOUDLY while the lane is exposed, and excludes nothing", async () => {
    const events: LogEvent[] = []
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ log: tracingLog(events), queueMint })

    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: GONE_SHA, base: "main" })
    await app.queue.run({}, runtime)

    const unwired = rows(events, "compose-submit-refs-unconfigured")
    expect(unwired).toHaveLength(1)
    expect(unwired[0]?.props).toMatchObject({ exposed: 1 })
    // WARN, not ERROR: an ERROR row ENDS the pass (operator ruling 2026-09-01,
    // pinned by error-is-fatal-levels.test.ts), and a missing optional reader
    // must not convert into a permanent no-drain outage. The condition is
    // handled — the pass admits unchecked and says exactly that.
    expect(unwired[0]?.kind === "log" ? unwired[0].level : undefined).toBe("warn")
    expect(
      queueMint.highWater(),
      "dropping every submission on an unwired reader is worse than the defect: it composes, loudly",
    ).toBe(1)
  })

  it("THE BLOCKER, pinned: a `yrd pr submit` fact is indistinguishable here, and this mechanism retires it", async () => {
    // Read this before wiring `scanSubmitRefs` into any host.
    //
    // TWO producers write a standing submit fact and only ONE writes a ref.
    // The receiver's `writeSubmitRefForCarrier` writes
    // `refs/yrd/submit/<branch>` and only then journals the fact; `yrd pr
    // submit <branch>` on the derived lane journals the fact ALONE
    // (yrd-bay/plugin.ts) because the commit was never pushed to the store.
    // So "no ref" does not mean "ref deleted", and this mechanism cannot tell
    // the two apart — it retires the local submission, exactly as shown here.
    //
    // Probing the store for the fact's commit does NOT separate them: prs.git
    // shares the repository's object database, so the probe answers "present"
    // for a commit that was never pushed (measured 2026-09-02, which is why
    // the probe this file once carried was removed rather than kept as a
    // safeguard that never fires).
    //
    // The separation has to be RECORDED at submit time — a marker on the fact,
    // or retiring the ref-less `pr submit` path in favour of the receiver push.
    // That is a design call. Until it is made, no host wires this, and the
    // yrd-cli host says so at the wiring site.
    const events: LogEvent[] = []
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({
      log: tracingLog(events),
      queueMint,
      // A real, readable store that simply holds no ref for this branch —
      // which is what a `yrd pr submit` submission looks like from here.
      scanSubmitRefs: refScanner([]),
    })

    await app.bays.recordBranchSubmit({ branch: GONE_BRANCH, sha: GONE_SHA, base: "main" })
    await app.queue.run({}, runtime)

    expect(queueMint.highWater(), "the local submission is held back instead of composing — THE BLOCKER").toBe(0)
    expect(actionsLogged(events)).toContain("compose-derived-fact-receiver-ref-gone")
  })

  it("a store that does not exist yet is UNANSWERED, never an empty ref set", async () => {
    // The catastrophic misreading this pins out: a missing store read as "no
    // refs exist" declares every standing projection dead and retires the lot
    // on the strength of a missing directory.
    const events: LogEvent[] = []
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({
      log: tracingLog(events),
      queueMint,
      scanSubmitRefs: () =>
        Promise.resolve({
          answered: false as const,
          store: STORE,
          reason: "the receiver store does not exist, so no push has ever been drained in this repository",
        }),
    })

    await app.bays.recordBranchSubmit({ branch: LIVE_BRANCH, sha: LIVE_SHA, base: "main" })
    await app.queue.run({}, runtime)

    const unavailable = rows(events, "compose-submit-refs-unavailable")
    expect(unavailable).toHaveLength(1)
    expect(unavailable[0]?.kind === "log" ? unavailable[0].level : undefined).toBe("warn")
    expect(unavailable[0]?.props).toMatchObject({ store: STORE, exposed: 1 })
    expect(app.state().queues.retiredSubmits[LIVE_BRANCH], "an unread store retires nothing").toBeUndefined()
    expect(queueMint.highWater(), "and it strands nothing either — the pass composes, unchecked").toBe(1)
  })

  it("nothing the lane would admit asks nothing and says nothing — no reader, no rows", async () => {
    const events: LogEvent[] = []
    await using app = await createApp({ log: tracingLog(events) })

    await app.queue.run({}, runtime)

    expect(actionsLogged(events)).not.toContain("compose-submit-refs-unconfigured")
    expect(actionsLogged(events)).not.toContain("compose-submit-refs-scanned")
  })
})
