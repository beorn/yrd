/**
 * @failure A single poisoned candidate (a stuck run whose drifted post-merge step refuses the advance) aborts the WHOLE selectorless compose and kills the habitant, instead of being skipped loud so the rest of the drain proceeds.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { candidateRefFor, withMerge, withStep, withQueue, type CandidatePreparer, type StepExecution } from "@yrd/queue"

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

/** merge (integrates) + deploy (needsIntegration) with a caller-tunable deploy
 * revision, so a replay under a bumped deploy revision leaves R1 stuck AFTER the
 * merge integrated but BEFORE the drifted deploy — the throw that must be skipped
 * (not fatal) in a selectorless compose. */
function mergeDeployPlugin(
  deployRevision: string,
  mergeRun: () => JobResult<{ commit: string; baseSha: string }> = () => ({
    status: "completed",
    conclusion: "success",
    output: { commit: MERGED, baseSha: BASE },
  }),
  prepareCandidate?: CandidatePreparer,
  batch: false | number = false,
) {
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
    batch,
    defaultSteps: ["merge", "deploy"],
    ...(prepareCandidate === undefined ? {} : { prepareCandidate }),
  })
}

async function createApp(
  deployRevision: string,
  journal = createMemoryJournal(),
  id: () => string = ids(),
  log?: ReturnType<typeof createLogger>,
  mergeRun?: () => JobResult<{ commit: string; baseSha: string }>,
  prepareCandidate?: CandidatePreparer,
  batch: false | number = false,
) {
  const bayJobs = createBayJobDefs(workspace())
  const queue = mergeDeployPlugin(deployRevision, mergeRun, prepareCandidate, batch)
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal,
      id,
      clock: () => "2026-01-01T00:00:00.000Z",
      log: log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

/** Seed R1 with a passed merge whose deploy step was never requested, then reopen
 * under a bumped deploy revision so advancing R1 refuses (the integrated boundary
 * keeps frozen semantics — the drift stays a loud throw, unlike the pre-merge
 * stale-steps release). */
async function seedStuckRun(deployRevision: string, journal: ReturnType<typeof createMemoryJournal>, id: () => string) {
  await using app = await createApp("deploy-v1", journal, id)
  const pr = await submitBranch(app, "issue/stuck-post-merge")
  await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["merge", "deploy"] })
  const mergeJob = app.queue.get("R1")?.steps[0]?.job
  if (mergeJob === undefined) throw new Error("expected requested merge")
  await app.jobs.run(mergeJob.id, runtime)
  expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("completed")
  expect(app.queue.get("R1")?.steps[1]?.job).toBeUndefined()
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
    await using app = await createApp("deploy-v1", createMemoryJournal(), ids(), log, undefined, prepareCandidate)
    const poisoned = await submitBranch(app, "issue/ref-write-refused")
    poisonedId = poisoned.id
    const healthy = await submitBranch(app, "issue/healthy-peer")

    const drained = await app.queue.run({}, runtime)

    expect(drained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conclusion: "success",
          prs: [expect.objectContaining({ id: healthy.id })],
        }),
      ]),
    )
    expect(app.state().bays.prs[poisoned.id]?.integration).toBeUndefined()
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
    await using app = await createApp("deploy-v1", createMemoryJournal(), ids(), undefined, undefined, prepareCandidate)
    const poisoned = await submitBranch(app, "issue/ref-write-refused")

    await expect(app.queue.run({ prs: [poisoned.id] }, runtime)).rejects.toMatchObject({
      failure: { kind: "infrastructure", code: "candidate-ref-refused" },
    })
  })

  it("ejects a Candidate whose submit authority was consumed and still integrates its healthy peer", async () => {
    let mergeCalls = 0
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp("deploy-v1", createMemoryJournal(), ids(), log, () => {
      mergeCalls += 1
      return mergeCalls === 1
        ? {
            status: "completed",
            conclusion: "failure",
            error: { code: "merge-conflict", message: "poisoned Candidate does not merge" },
          }
        : { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
    })
    const poisoned = await submitBranch(app, "issue/consumed-authority")
    const first = await app.queue.run({ prs: [poisoned.id], steps: ["merge"] }, runtime)
    expect(first).toMatchObject([{ conclusion: "failure", error: { code: "merge-conflict" } }])
    const healthy = await submitBranch(app, "issue/healthy-peer")

    const drained = await app.queue.run({}, runtime)

    expect(drained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conclusion: "success",
          prs: [expect.objectContaining({ id: healthy.id })],
        }),
      ]),
    )
    expect(mergeCalls).toBe(2)
    // error, not warn (raised 2026-08-31): a candidate ejected with no
    // durable trace is exactly the queue-INTEGRITY case the operator's rule
    // calls out — the system cannot verify something it needs, loud
    // immediately.
    const skip = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" &&
        event.level === "error" &&
        event.namespace === "yrd:queue" &&
        event.props?.action === "compose-candidate-skip",
    )
    expect(skip?.props).toMatchObject({
      action: "compose-candidate-skip",
      code: "queue-submit-authority-consumed",
      pr: poisoned.id,
    })
    const journalEvents = await Array.fromAsync(app.events())
    const needsAuthor = journalEvents.find(
      (applied) =>
        applied.name === "pr/needs-author" && (applied.data as Readonly<{ pr?: unknown }>).pr === poisoned.id,
    )
    expect(needsAuthor?.data).toMatchObject({
      pr: poisoned.id,
      receipt: {
        code: "queue-submit-authority-consumed",
        message: expect.stringContaining("tracked changes re-merge implicitly"),
      },
    })
    expect(app.state().bays.prs[poisoned.id]).toMatchObject({
      needsAuthor: { receipt: { code: "queue-submit-authority-consumed" } },
    })
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    log.end()
  })

  it("skips a poisoned resumable run with a loud warn and keeps the compose alive", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    await seedStuckRun("deploy-v2", journal, id)

    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using replayed = await createApp("deploy-v2", journal, id, log)

    // The selectorless compose survives — it does NOT throw the command-refused
    // that would otherwise kill the habitant.
    await expect(replayed.queue.run({}, runtime)).resolves.toBeDefined()

    const skips = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.namespace === "yrd:queue",
    )
    const skip = skips.find((event) => event.props?.action === "compose-candidate-skip")
    expect(skip, "expected a compose-candidate-skip warn").toBeDefined()
    expect(skip?.props).toMatchObject({ action: "compose-candidate-skip", run: "R1", code: "command-refused" })
    expect(String(skip?.props?.reason)).toContain("deploy")
    log.end()
  })

  it("still fails loud for a one-shot targeted run of the same poisoned candidate", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    await seedStuckRun("deploy-v2", journal, id)

    await using replayed = await createApp("deploy-v2", journal, id)
    // An explicit selector compose names its single target — it is NOT selectorless,
    // so the candidate-skip tolerance never applies: any refusal touching the target
    // propagates (fail-loud) instead of being swallowed. The raw advance proves the
    // underlying drift refusal is real and loud.
    await expect(replayed.queue.run({ prs: ["PR1"], steps: ["merge", "deploy"] }, runtime)).rejects.toThrow()
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
    await using app = await createApp(
      "deploy-v1",
      createMemoryJournal(),
      ids(),
      log,
      undefined,
      poisonedPreparer(poisoned),
      BATCH,
    )
    const guilty = await submitBranch(app, "issue/recut-poisoned")
    poisoned.push(guilty.id)
    const firstHealthy = await submitBranch(app, "issue/healthy-one")
    const secondHealthy = await submitBranch(app, "issue/healthy-two")

    // ONE drain. The whole point: the survivors must not wait for a later cycle.
    const drained = await app.queue.run({}, runtime)

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
    expect(app.state().bays.prs[guilty.id]?.integration).toBeUndefined()

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
    await using app = await createApp(
      "deploy-v1",
      createMemoryJournal(),
      ids(),
      undefined,
      undefined,
      poisonedPreparer(poisoned),
      BATCH,
    )
    const guilty = await submitBranch(app, "issue/recut-poisoned")
    poisoned.push(guilty.id)
    const firstHealthy = await submitBranch(app, "issue/healthy-one")
    const secondHealthy = await submitBranch(app, "issue/healthy-two")

    await app.queue.run({}, runtime)

    // This record is what `queue audit` reads. A stain here replays as a finding
    // against an innocent carrier every cycle until a human reads the carrier.
    const refusals = app.state().queues.admissionRefusals
    expect(refusals[guilty.id]).toBeDefined()
    expect(refusals[firstHealthy.id]).toBeUndefined()
    expect(refusals[secondHealthy.id]).toBeUndefined()
  })

  it("ejects TWO poisoned members in one bounded drain and still merges the survivors", async () => {
    const poisoned: string[] = []
    await using app = await createApp(
      "deploy-v1",
      createMemoryJournal(),
      ids(),
      undefined,
      undefined,
      poisonedPreparer(poisoned),
      BATCH,
    )
    const firstGuilty = await submitBranch(app, "issue/poisoned-one")
    poisoned.push(firstGuilty.id)
    const firstHealthy = await submitBranch(app, "issue/healthy-one")
    const secondGuilty = await submitBranch(app, "issue/poisoned-two")
    poisoned.push(secondGuilty.id)
    const secondHealthy = await submitBranch(app, "issue/healthy-two")

    const drained = await app.queue.run({}, runtime)

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
    await using app = await createApp(
      "deploy-v1",
      createMemoryJournal(),
      ids(),
      undefined,
      undefined,
      unattributable,
      BATCH,
    )
    const first = await submitBranch(app, "issue/one")
    const second = await submitBranch(app, "issue/two")

    await app.queue.run({}, runtime)

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
    await using app = await createApp("deploy-v1", createMemoryJournal(), ids(), undefined, undefined, foreign, BATCH)
    const first = await submitBranch(app, "issue/one")
    const second = await submitBranch(app, "issue/two")

    await app.queue.run({}, runtime)

    // A `pr` from somewhere else is not attribution. Acting on it would eject an
    // innocent and leave the real refuser in place, so it degrades to shared.
    const refusals = app.state().queues.admissionRefusals
    expect(refusals[first.id]).toBeDefined()
    expect(refusals[second.id]).toBeDefined()
  })
})
