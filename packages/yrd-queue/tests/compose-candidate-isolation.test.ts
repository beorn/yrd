/**
 * @failure A single poisoned candidate (a stuck run whose drifted post-merge step refuses the advance) aborts the WHOLE selectorless compose and kills the habitant, instead of being skipped loud so the rest of the drain proceeds.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  deriveRunMemberArgs,
  withMerge,
  withStep,
  withQueue,
  type CandidatePreparer,
  type DerivedRunMember,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const DeployResultSchema = z.object({ environment: z.string() }).strict()

function ids(initial = 0): () => string {
  let value = initial
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

/** One app's knobs. `mint` is REQUIRED and shared with the test body: post-S7
 * the queue plugin owns the derived-admission mint, and a test that derives its
 * own member identities must burn numbers from the SAME mint the compose does,
 * or the ids the assertions name are not the ids the drain runs. */
type AppOptions = Readonly<{
  mint: PrNumberMint
  journal?: ReturnType<typeof createMemoryJournal>
  id?: () => string
  log?: ReturnType<typeof createLogger>
  mergeRun?: () => JobResult<{ commit: string; baseSha: string }>
  prepareCandidate?: CandidatePreparer
  batch?: false | number
}>

/** merge (integrates) + deploy (needsIntegration) with a caller-tunable deploy
 * revision, so a replay under a bumped deploy revision leaves R1 stuck AFTER the
 * merge integrated but BEFORE the drifted deploy — the throw that must be skipped
 * (not fatal) in a selectorless compose. */
function mergeDeployPlugin(deployRevision: string, options: AppOptions) {
  const mergeRun =
    options.mergeRun ??
    (() => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { commit: MERGED, baseSha: BASE },
    }))
  const merge = withMerge(mergeRun, { revision: "merge-v1" })
  const deploy = withStep(
    "deploy",
    (_input: StepExecution): JobResult<{ environment: string }> => ({
      status: "completed",
      conclusion: "success",
      output: { environment: "staging" },
    }),
    { revision: deployRevision, kind: "action", output: DeployResultSchema },
  )
  return withQueue({
    steps: [merge, deploy] as const,
    batch: options.batch ?? false,
    defaultSteps: ["merge", "deploy"],
    // A submit FACT carries no baseSha (the record revision that used to carry
    // one is gone), so the host's base resolver is now the compose's only
    // source for the exact merge-queue base a Candidate is prepared against.
    resolveBaseSha: () => BASE,
    // The derived lane's admission mint lives on the QUEUE plugin post-S7 —
    // `withBays` lost `prNumberMint` with the record store it minted for.
    prNumberMint: options.mint,
    ...(options.prepareCandidate === undefined ? {} : { prepareCandidate: options.prepareCandidate }),
  })
}

async function createApp(deployRevision: string, options: AppOptions) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = mergeDeployPlugin(deployRevision, options)
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

/** Post-S7 the submit FACT is the delivery: no record is minted, and the member
 * the compose runs is derived from the fact. Deriving it here (under the app's
 * own mint) hands the test the very identity the drain will use, so every
 * `member.id` assertion below still names the member that actually ran. */
async function submitBranch(
  app: Awaited<ReturnType<typeof createApp>>,
  mint: PrNumberMint,
  branch: string,
): Promise<DerivedRunMember> {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
  return deriveRunMemberArgs({ bays: app.state().bays, queues: app.state().queues, mint, branch })
}

/** Seed R1 with a passed merge whose deploy step was never requested, then reopen
 * under a bumped deploy revision so advancing R1 refuses (the integrated boundary
 * keeps frozen semantics — the drift stays a loud throw, unlike the pre-merge
 * stale-steps release). */
async function seedStuckRun(
  deployRevision: string,
  journal: ReturnType<typeof createMemoryJournal>,
  id: () => string,
  mint: PrNumberMint,
): Promise<DerivedRunMember> {
  await using app = await createApp("deploy-v1", { mint, journal, id })
  const member = await submitBranch(app, mint, "issue/stuck-post-merge")
  // `prs: []` beside a non-empty `derived` selects exactly this derived member.
  // The low-level command has no base resolver, so the driver supplies the
  // exact base sha the facade's `resolveBaseSha` would have resolved.
  await app.dispatch(app.commands.queue.run, {
    prs: [],
    derived: [member],
    steps: ["merge", "deploy"],
    baseSha: BASE,
  })
  const mergeJob = app.queue.get("R1")?.steps[0]?.job
  if (mergeJob === undefined) throw new Error("expected requested merge")
  await app.jobs.run(mergeJob.id, runtime)
  expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("completed")
  expect(app.queue.get("R1")?.steps[1]?.job).toBeUndefined()
  return member
}

describe("compose candidate isolation — one poisoned candidate never aborts the whole selectorless drain", () => {
  it("skips an infrastructure-refused Candidate preparation and still integrates its healthy peer", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    let poisonedId = ""
    const prepareCandidate: CandidatePreparer = (input) => {
      if (input.prs.some((pr) => pr.id === poisonedId)) {
        throw createFailure({
          kind: "infrastructure",
          code: "candidate-ref-refused",
          message: `yrd: Candidate ref '${candidateRefFor(MERGED)}' could not be created`,
        })
      }
      const { prs: _prs, ...candidate } = input
      return {
        ...candidate,
        sha: MERGED,
        ref: candidateRefFor(MERGED),
        mergeability: "mergeable",
      }
    }
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", { mint, log, prepareCandidate })
    const poisoned = await submitBranch(app, mint, "issue/ref-write-refused")
    poisonedId = poisoned.id
    const healthy = await submitBranch(app, mint, "issue/healthy-peer")

    // `prs` ABSENT keeps the compose selectorless — the tolerance under test —
    // while `derived` hands it these two identities instead of re-minting.
    const drained = await app.queue.run({ derived: [poisoned, healthy] }, runtime)

    expect(drained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conclusion: "success",
          prs: [expect.objectContaining({ id: healthy.id })],
        }),
      ]),
    )
    // The poisoned member never integrates. A derived member has no record to
    // read `integration` off, and the run snapshot is its only durable home —
    // so "not integrated" is "it reached no run in this drain at all".
    expect(
      drained.flatMap((run) => run.prs).map((pr) => pr.id),
      "the poisoned member must not appear in any run the drain produced",
    ).not.toContain(poisoned.id)
    const skip = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.level === "warn" &&
        event.namespace === "yrd:queue" &&
        event.props?.action === "compose-candidate-skip" &&
        event.props?.pr === poisoned.id,
    )
    expect(skip?.props).toMatchObject({
      action: "compose-candidate-skip",
      code: "candidate-ref-refused",
      pr: poisoned.id,
    })
    log.end()
  })

  it("keeps the same Candidate preparation refusal loud when explicitly targeted", async () => {
    const prepareCandidate: CandidatePreparer = () => {
      throw createFailure({
        kind: "infrastructure",
        code: "candidate-ref-refused",
        message: `yrd: Candidate ref '${candidateRefFor(MERGED)}' could not be created`,
      })
    }
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", { mint, prepareCandidate })
    const poisoned = await submitBranch(app, mint, "issue/ref-write-refused")

    // Naming the target still means naming it: post-S7 the selector resolves
    // out of the run's own derived batch, so the member rides `derived` and the
    // NON-EMPTY `prs` is what keeps the compose off its selectorless tolerance.
    await expect(app.queue.run({ prs: [poisoned.id], derived: [poisoned] }, runtime)).rejects.toMatchObject({
      failure: { kind: "infrastructure", code: "candidate-ref-refused" },
    })
  })

  it("ejects a Candidate whose submit authority was consumed and still integrates its healthy peer", async () => {
    let mergeCalls = 0
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", {
      mint,
      log,
      mergeRun: () => {
        mergeCalls += 1
        return mergeCalls === 1
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "merge-conflict", message: "poisoned Candidate does not merge" },
            }
          : { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const poisoned = await submitBranch(app, mint, "issue/consumed-authority")
    const first = await app.queue.run({ prs: [poisoned.id], derived: [poisoned], steps: ["merge"] }, runtime)
    expect(first).toMatchObject([{ conclusion: "failure", error: { code: "merge-conflict" } }])
    const healthy = await submitBranch(app, mint, "issue/healthy-peer")

    const drained = await app.queue.run({ derived: [poisoned, healthy] }, runtime)

    expect(drained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conclusion: "success",
          prs: [expect.objectContaining({ id: healthy.id })],
        }),
      ]),
    )
    expect(mergeCalls).toBe(2)
    const skip = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.level === "warn" &&
        event.namespace === "yrd:queue" &&
        event.props?.action === "compose-candidate-skip",
    )
    // The eject still names the guilty member AND still hands the author the
    // remedy — the message the record-lane `pr/needs-author` receipt carried.
    expect(skip?.props).toMatchObject({
      action: "compose-candidate-skip",
      code: "queue-submit-authority-consumed",
      pr: poisoned.id,
      remedy: expect.stringContaining("tracked changes re-merge implicitly"),
    })
    // A derived member has no record for the eject to write `pr/needs-author`
    // on, so the durable trace of the same fact is the refusal ledger row —
    // the thing `queue audit` reads, keyed by the guilty member alone.
    expect(app.state().queues.admissionRefusals[poisoned.id]).toMatchObject({
      pr: poisoned.id,
      branch: "issue/consumed-authority",
      code: "queue-submit-authority-consumed",
    })
    expect(app.state().queues.admissionRefusals[healthy.id]).toBeUndefined()
    await expect(app.queue.run({ derived: [poisoned, healthy] }, runtime)).resolves.toEqual([])
    log.end()
  })

  it("skips a poisoned resumable run with a loud warn and keeps the compose alive", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const mint = volatilePrNumberMint()
    await seedStuckRun("deploy-v2", journal, id, mint)

    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using replayed = await createApp("deploy-v2", { mint, journal, id, log })

    // The selectorless compose survives — it does NOT throw the command-refused
    // that would otherwise kill the habitant.
    await expect(replayed.queue.run({}, runtime)).resolves.toBeDefined()

    const skips = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.namespace === "yrd:queue",
    )
    // The RUN-scoped skip. The same drain also skips the branch's freshly
    // derived member for the submit authority R1 already spent, so the finder
    // has to name the run it is about rather than take the first skip it sees.
    const skip = skips.find((event) => event.props?.action === "compose-candidate-skip" && event.props?.run === "R1")
    expect(
      skip,
      "expected a compose-candidate-skip warn for R1 — absent means the selectorless compose never even SAW the " +
        "stuck run: `activeQueueRootIds` derives the resumable set from `authority.claims`, `projectRunAuthority` " +
        "mints a claim only when `authority.current[pr]` exists, and `authority.current` is written solely by the " +
        "record-lane pr/pushed|recut|submitted|checks-requested events, none of which fire on the derived lane",
    ).toBeDefined()
    expect(skip?.props).toMatchObject({ action: "compose-candidate-skip", run: "R1", code: "command-refused" })
    expect(String(skip?.props?.reason)).toContain("deploy")
    log.end()
  })

  it("still fails loud for a one-shot targeted run of the same poisoned candidate", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const mint = volatilePrNumberMint()
    const member = await seedStuckRun("deploy-v2", journal, id, mint)

    await using replayed = await createApp("deploy-v2", { mint, journal, id })
    // An explicit selector compose names its single target — it is NOT selectorless,
    // so the candidate-skip tolerance never applies: any refusal touching the target
    // propagates (fail-loud) instead of being swallowed. The raw advance proves the
    // underlying drift refusal is real and loud.
    await expect(
      replayed.queue.run({ prs: [member.id], derived: [member], steps: ["merge", "deploy"] }, runtime),
    ).rejects.toThrow()
    await expect(replayed.dispatch(replayed.commands.queue.advance, { run: "R1" })).rejects.toThrow(
      "does not match installed revision",
    )
  })
})

/**
 * @failure One member that refuses Candidate preparation zeroes its ENTIRE partition and stains every
 * innocent peer with the guilty member's refusal record, so `queue audit` replays the stain each cycle.
 * @level l2
 * @consumer @yrd/queue
 */
describe("compose member isolation — one refusing member never zeroes its whole partition", () => {
  const BATCH = 8

  /**
   * A preparer that refuses whichever members are poisoned, naming the guilty
   * member STRUCTURALLY — the attribution `prepareCandidate` stamps at its loop
   * boundary in the real pipeline. Without the `pr` field the drain cannot tell
   * which member refused and must punish all of them, which is the defect.
   */
  function poisonedPreparer(poisoned: readonly string[]): CandidatePreparer {
    return (input) => {
      const guilty = input.prs.find((pr) => poisoned.includes(pr.id))
      if (guilty !== undefined) {
        throw createFailure({
          kind: "refusal",
          code: "recut-certificate",
          message: `change '${guilty.id}' recomposed change did not survive the advanced base`,
          pr: guilty.id,
        })
      }
      const { prs: _prs, ...candidate } = input
      return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
    }
  }

  it("ejects the recut-poisoned member and integrates BOTH healthy peers in one drain", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const poisoned: string[] = []
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", {
      mint,
      log,
      prepareCandidate: poisonedPreparer(poisoned),
      batch: BATCH,
    })
    const guilty = await submitBranch(app, mint, "issue/recut-poisoned")
    poisoned.push(guilty.id)
    const firstHealthy = await submitBranch(app, mint, "issue/healthy-one")
    const secondHealthy = await submitBranch(app, mint, "issue/healthy-two")

    // ONE drain. The whole point: the survivors must not wait for a later cycle.
    const drained = await app.queue.run({ derived: [guilty, firstHealthy, secondHealthy] }, runtime)

    expect(drained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conclusion: "success",
          prs: expect.arrayContaining([
            expect.objectContaining({ id: firstHealthy.id }),
            expect.objectContaining({ id: secondHealthy.id }),
          ]),
        }),
      ]),
    )
    // Ejected means ejected: the guilty member rides no run this drain produced,
    // which is what "never integrated" reads as for a recordless member.
    expect(
      drained.flatMap((run) => run.prs).map((pr) => pr.id),
      "the ejected member must not appear in any run the drain produced",
    ).not.toContain(guilty.id)

    const ejection = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.level === "warn" &&
        event.namespace === "yrd:queue" &&
        event.props?.action === "compose-candidate-skip",
    )
    expect(ejection?.props).toMatchObject({
      action: "compose-candidate-skip",
      code: "recut-certificate",
      pr: guilty.id,
      remedy: "tracked changes re-merge implicitly when the branch moves; fallback: 'yrd pr submit <branch>'",
    })
    // The warn names the guilty member ALONE — never the partition.
    expect(ejection?.props?.prs).toBeUndefined()
    log.end()
  })

  it("records the refusal against the guilty member ONLY, leaving innocents unstained", async () => {
    const poisoned: string[] = []
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", {
      mint,
      prepareCandidate: poisonedPreparer(poisoned),
      batch: BATCH,
    })
    const guilty = await submitBranch(app, mint, "issue/recut-poisoned")
    poisoned.push(guilty.id)
    const firstHealthy = await submitBranch(app, mint, "issue/healthy-one")
    const secondHealthy = await submitBranch(app, mint, "issue/healthy-two")

    await app.queue.run({ derived: [guilty, firstHealthy, secondHealthy] }, runtime)

    // This record is what `queue audit` reads. A stain here replays as a finding
    // against an innocent carrier every cycle until a human reads the carrier.
    const refusals = app.state().queues.admissionRefusals
    expect(refusals[guilty.id]).toBeDefined()
    expect(refusals[firstHealthy.id]).toBeUndefined()
    expect(refusals[secondHealthy.id]).toBeUndefined()
  })

  it("ejects TWO poisoned members in one bounded drain and still merges the survivors", async () => {
    const poisoned: string[] = []
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", {
      mint,
      prepareCandidate: poisonedPreparer(poisoned),
      batch: BATCH,
    })
    const firstGuilty = await submitBranch(app, mint, "issue/poisoned-one")
    poisoned.push(firstGuilty.id)
    const firstHealthy = await submitBranch(app, mint, "issue/healthy-one")
    const secondGuilty = await submitBranch(app, mint, "issue/poisoned-two")
    poisoned.push(secondGuilty.id)
    const secondHealthy = await submitBranch(app, mint, "issue/healthy-two")

    const drained = await app.queue.run({ derived: [firstGuilty, firstHealthy, secondGuilty, secondHealthy] }, runtime)

    expect(drained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conclusion: "success",
          prs: expect.arrayContaining([
            expect.objectContaining({ id: firstHealthy.id }),
            expect.objectContaining({ id: secondHealthy.id }),
          ]),
        }),
      ]),
    )
    const refusals = app.state().queues.admissionRefusals
    expect(refusals[firstGuilty.id]).toBeDefined()
    expect(refusals[secondGuilty.id]).toBeDefined()
    expect(refusals[firstHealthy.id]).toBeUndefined()
    expect(refusals[secondHealthy.id]).toBeUndefined()
  })

  it("keeps a whole-partition refusal shared when the fact names no member", async () => {
    const unattributable: CandidatePreparer = () => {
      throw createFailure({
        kind: "infrastructure",
        code: "candidate-ref-refused",
        message: `yrd: Candidate ref '${candidateRefFor(MERGED)}' could not be created`,
      })
    }
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", { mint, prepareCandidate: unattributable, batch: BATCH })
    const first = await submitBranch(app, mint, "issue/one")
    const second = await submitBranch(app, mint, "issue/two")

    await app.queue.run({ derived: [first, second] }, runtime)

    // Unattributable means unattributable: isolation must not invent a culprit,
    // so the pre-existing whole-partition behaviour stands.
    const refusals = app.state().queues.admissionRefusals
    expect(refusals[first.id]).toBeDefined()
    expect(refusals[second.id]).toBeDefined()
  })

  it("ignores attribution naming a member this partition does not contain", async () => {
    const foreign: CandidatePreparer = () => {
      throw createFailure({
        kind: "refusal",
        code: "recut-certificate",
        message: "change 'PR999' recomposed change did not survive the advanced base",
        pr: "PR999",
      })
    }
    const mint = volatilePrNumberMint()
    await using app = await createApp("deploy-v1", { mint, prepareCandidate: foreign, batch: BATCH })
    const first = await submitBranch(app, mint, "issue/one")
    const second = await submitBranch(app, mint, "issue/two")

    await app.queue.run({ derived: [first, second] }, runtime)

    // A `pr` from somewhere else is not attribution. Acting on it would eject an
    // innocent and leave the real refuser in place, so it degrades to shared.
    const refusals = app.state().queues.admissionRefusals
    expect(refusals[first.id]).toBeDefined()
    expect(refusals[second.id]).toBeDefined()
  })
})
