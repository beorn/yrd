/**
 * @failure Bay lifecycle state diverges from durable Jobs, replayed record
 * history stops parsing, a legacy pr/* payload starts being accepted as a live
 * append, or a retired record verb quietly comes back.
 * @level l2
 * @consumer @yrd/bay
 *
 * S7 conversion note (branch-is-change, @i/10 22991): every test that drove a
 * record VERB (intake, submit-by-record, ready, recut, review, comment,
 * requestChecks, requestReview, recordAdmission, editPr, closePr,
 * settleSuperseded, publication) was deleted with the verbs; tests of surviving
 * flows (bay workspace lifecycle, derived-lane submission, replay, refusals)
 * converted. The record store is gone, so a fixture's seeded pr/* history
 * projects NOTHING — it is journal content, and every assertion that used to
 * read a materialized record now reads the journal instead. "No record minted"
 * means no pr/* frame appended.
 */
import { describe, expect, it } from "vitest"
import {
  Command,
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  pipe,
  type CommandResult,
  type CommandTree,
  type JsonValue,
} from "@yrd/core"
import { withJobs, type JobContext, type JobResult } from "@yrd/job"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import {
  GitShaSchema,
  ChangeAdmissionRecordedFactSchema,
  ChangeRejectedFactSchema,
  normalizeV2By,
  normalizeV2Submitter,
  resolveBase,
  type BaysState,
  type DeprovisionedBay,
  type ProvisionedBay,
  type RefreshedBay,
} from "../src/model.ts"
import { createBayJobDefs, withBays, type BayWorkspace, type ResolveBayBase } from "../src/plugin.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const silentLog = createLogger("test", [{ level: "silent" }])

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

async function createApp(workspace: BayWorkspace, log?: ConditionalLogger, resolveBase?: ResolveBayBase) {
  const jobs = createBayJobDefs(workspace)
  const definition = pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({
      jobs,
      defaultBase: "main",
      ...(resolveBase === undefined ? {} : { resolveBase }),
    }),
  )
  return createYrd(definition, {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-01-01T00:00:00.000Z",
      id: ids(),
      log: log ?? silentLog,
    },
  })
}

function createWorkspaceHarness() {
  const workspace = { calls: [] as string[], dirty: false }
  const adapter: BayWorkspace = {
    revision: "test-workspace-v1",
    provision(input): JobResult<ProvisionedBay> {
      workspace.calls.push(`provision:${input.bay}:${input.baseSha ?? "current"}`)
      return {
        status: "completed",
        conclusion: "success",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE },
      }
    },
    refresh(input): JobResult<RefreshedBay> {
      workspace.calls.push(`refresh:${input.bay}`)
      return {
        status: "completed",
        conclusion: "success",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_2, baseSha: BASE, dirty: workspace.dirty },
      }
    },
    checkpoint(input) {
      workspace.calls.push(`checkpoint:${input.bay}`)
      return {
        status: "completed",
        conclusion: "success",
        output: { headSha: HEAD_2, pushed: true, wip: workspace.dirty },
      }
    },
    deprovision(input): JobResult<DeprovisionedBay> {
      workspace.calls.push(`deprovision:${input.bay}`)
      return workspace.dirty
        ? {
            status: "completed",
            conclusion: "failure",
            error: { code: "dirty-worktree", message: "workspace has uncommitted work" },
          }
        : {
            status: "completed",
            conclusion: "success",
            output: { headSha: HEAD_1, preservedRef: `refs/yrd/closed/${input.bay}` },
          }
    },
  }
  return { adapter, workspace }
}

type BayJobDefinition = keyof ReturnType<typeof createBayJobDefs>
type BayWorkspaceJobDefinition = Extract<BayJobDefinition, `bay.${string}`>
type FailureTransition = "failure" | "lost"

const BAY_JOB_DEFINITIONS = [
  "bay.provision",
  "bay.refresh",
  "bay.checkpoint",
  "bay.deprovision",
] as const satisfies readonly BayWorkspaceJobDefinition[]

function createFailOnceWorkspace(definition: BayWorkspaceJobDefinition, transition: FailureTransition) {
  const base = createWorkspaceHarness().adapter
  let failed = false
  let startedResolve: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve
  })
  const intercept = <Output extends JsonValue>(
    current: BayWorkspaceJobDefinition,
    context: JobContext,
    success: () => JobResult<Output> | Promise<JobResult<Output>>,
  ): JobResult<Output> | Promise<JobResult<Output>> => {
    if (current !== definition || failed) return success()
    failed = true
    if (transition === "failure") {
      return {
        status: "completed",
        conclusion: "failure",
        error: { code: `fixture-${definition}`, message: `${definition} failed in its fixture state` },
      }
    }
    startedResolve?.()
    return new Promise((resolve) => {
      context.signal.addEventListener(
        "abort",
        () =>
          resolve({
            status: "completed",
            conclusion: "failure",
            error: { code: `aborted-${definition}`, message: `${definition} lost its runner` },
          }),
        { once: true },
      )
    })
  }
  const adapter: BayWorkspace = {
    revision: "failure-path-workspace-v1",
    provision: (input, context) => intercept("bay.provision", context, () => base.provision(input, context)),
    refresh: (input, context) => intercept("bay.refresh", context, () => base.refresh(input, context)),
    checkpoint: (input, context) => intercept("bay.checkpoint", context, () => base.checkpoint(input, context)),
    deprovision: (input, context) => intercept("bay.deprovision", context, () => base.deprovision(input, context)),
  }
  return { adapter, started }
}

async function createHarness(log?: ConditionalLogger) {
  const harness = createWorkspaceHarness()
  return { ...harness, app: await createApp(harness.adapter, log) }
}

type TestApp = Awaited<ReturnType<typeof createApp>>

const bays = (app: TestApp): BaysState => app.bays.state() as BaysState

type SeedEvent = { name: string; data: Record<string, unknown> }

/** Boot an app on a journal seeded with the given events (plus optional extra
 * fixture commands), replaying record history the way an old journal would.
 * Dispatch a fixture command via its own const — the registry keys command
 * nodes by identity, and extend merges them in by reference. */
async function seededApp(events: readonly SeedEvent[], extraCommands: CommandTree = {}) {
  const nextId = ids()
  const at = "2026-01-01T00:00:00.000Z"
  const seededCommand = { id: nextId(), op: "fixture.seed" }
  const journal = createMemoryJournal([
    {
      command: seededCommand,
      cause: {
        id: nextId(),
        commandId: seededCommand.id,
        op: seededCommand.op,
        commandHash: Command.hash(seededCommand),
      },
      events: events.map(({ name, data }) => ({ id: nextId(), name, ts: at, data })),
    },
  ])
  const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
  let definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
  if (Object.keys(extraCommands).length > 0) {
    definition = definition.extend({ commands: { fixture: extraCommands } }) as typeof definition
  }
  return createYrd(definition, { inject: { journal, clock: () => at, id: nextId, log: silentLog } })
}

describe("GitShaSchema", () => {
  it("accepts only native SHA-1 and SHA-256 object widths", () => {
    expect(GitShaSchema.safeParse("a".repeat(40)).success).toBe(true)
    expect(GitShaSchema.safeParse("b".repeat(64)).success).toBe(true)
    expect(GitShaSchema.safeParse("c".repeat(39)).success).toBe(false)
    expect(GitShaSchema.safeParse("d".repeat(48)).success).toBe(false)
    expect(GitShaSchema.safeParse("e".repeat(65)).success).toBe(false)
  })
})

describe("pre-cutover provenance normalization", () => {
  const previousRoleKey = ["act", "or"].join("")

  it("maps Bay ownership to by and revision ownership to submitter", () => {
    expect(normalizeV2By({ id: "B1", [previousRoleKey]: "@dev/1" })).toEqual({ id: "B1", by: "@dev/1" })
    expect(normalizeV2Submitter({ pr: "PR1", [previousRoleKey]: "@dev/1" })).toEqual({
      pr: "PR1",
      submitter: "@dev/1",
    })
  })

  it("replays rejection provenance through the current schema", () => {
    expect(
      ChangeRejectedFactSchema.parse({
        pr: "PR1",
        revision: 1,
        headSha: HEAD_1,
        run: "R1",
        [previousRoleKey]: "@dev/1",
        step: "check",
      }),
    ).toMatchObject({ submitter: "@dev/1" })
  })
})

async function finishJob(app: TestApp, result: CommandResult): Promise<void> {
  const id = app.jobs.requested(result)[0]
  if (id === undefined) throw new Error("expected one Bay workspace job")
  await app.jobs.run(id, { runner: "local", leaseMs: 60_000 })
}

async function settleFailureTransition(
  app: TestApp,
  result: CommandResult,
  transition: FailureTransition,
  started: Promise<void>,
): Promise<void> {
  const id = app.jobs.requested(result)[0]
  if (id === undefined) throw new Error("expected one Bay workspace job")
  if (transition === "failure") {
    await app.jobs.run(id, runtime)
    return
  }
  const running = app.jobs.run(id, { ...runtime, heartbeatMs: 5 })
  await started
  const job = app.jobs.get(id)
  if (job?.status !== "in_progress") throw new Error(`expected in-progress Bay job '${id}'`)
  await app.dispatch(app.commands.job.transition, {
    type: "lose",
    id,
    attempt: job.attempt,
    runner: job.runner,
    leaseExpiresAt: job.leaseExpiresAt,
    reason: `${job.definition} fixture runner lost`,
  })
  await running
}

describe("withBays", () => {
  it("enumerates every Bay workspace job definition in the terminal-reapability property", () => {
    expect(
      Object.keys(createBayJobDefs(createWorkspaceHarness().adapter))
        .filter((definition) => definition.startsWith("bay."))
        .sort(),
    ).toEqual([...BAY_JOB_DEFINITIONS].sort())
  })

  it.each(
    BAY_JOB_DEFINITIONS.flatMap((definition) =>
      (["failure", "lost"] as const).map((transition) => ({ definition, transition })),
    ),
  )("$definition $transition records do not strand a workspace", async ({ definition, transition }) => {
    const failure = createFailOnceWorkspace(definition, transition)
    await using app = await createApp(failure.adapter)
    const opened = await app.bays.open({ name: "terminal-reapability", by: "test" })
    let failed: CommandResult
    if (definition === "bay.provision") {
      failed = opened
    } else {
      await finishJob(app, opened)
      failed =
        definition === "bay.refresh"
          ? await app.bays.refresh({ bay: "B1" })
          : definition === "bay.checkpoint"
            ? await app.bays.checkpoint({ bay: "B1", claim: "@yrd/core/22646" })
            : await app.bays.close({ bay: "B1" })
    }
    await settleFailureTransition(app, failed, transition, failure.started)

    if (definition === "bay.provision") {
      expect(app.bays.get("B1")).toMatchObject({
        status: "closed",
        closure: { kind: "closed-degenerate" },
        failure: { code: transition === "failure" ? `fixture-${definition}` : "job-lost" },
      })
      expect(app.bays.get("B1")).not.toHaveProperty("path")
    } else {
      expect(app.bays.get("B1")).toMatchObject({
        status: "active",
        failure: { code: transition === "failure" ? `fixture-${definition}` : "job-lost" },
      })
      await finishJob(app, await app.bays.close({ bay: "B1" }))
      expect(app.bays.get("B1")).toMatchObject({ status: "closed" })
      expect(app.bays.get("B1")?.failure).toBeUndefined()
    }
  })

  it("keeps Hab sessions outside Bay while replaying retired session facts as no-ops", async () => {
    await using app = await seededApp([
      {
        name: "pr/pushed",
        data: { pr: "PR1", branch: "task/session-history", base: "main", headSha: HEAD_1, revision: 1 },
      },
      { name: "pr/session-started", data: { pr: "PR1", launchId: "hab-launch-1" } },
      { name: "pr/session-ended", data: { pr: "PR1", launchId: "hab-launch-1", outcome: "completed" } },
    ])

    expect((app.commands as Record<string, unknown>).pr).toBeUndefined()
    expect(Object.keys(app.bays)).not.toEqual(expect.arrayContaining(["startSession", "stopSession"]))
    // The retired session facts replay (the journal below still holds all
    // three) and project nothing at all: no bay, no submit fact. There is no
    // session-bearing state left for a Hab launch to leak into.
    expect(app.bays.list()).toEqual([])
    expect(bays(app).submits).toEqual({})
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([
      "pr/pushed",
      "pr/session-started",
      "pr/session-ended",
    ])
  })

  it("refuses a bay-less draft: draft records retired with the legacy mint", async () => {
    await using app = (await createHarness()).app
    // Bay-less drafts were record-lane creatures; a recordless branch routes
    // to the derived lane and a draft has nothing to draft.
    await expect(
      app.bays.submitSelection("topic/moving-draft", {
        base: "main",
        resolveRevision: async () => HEAD_1,
        run: runtime,
        draft: true,
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "record-mint-retired" } })
  })

  it("re-enters a new head on a merged branch through the derived lane (Q1), no record minted", async () => {
    await using app = await seededApp([
      {
        name: "pr/pushed",
        data: { pr: "PR1", branch: "topic/merged", base: "main", headSha: HEAD_1, baseSha: BASE, revision: 1 },
      },
      { name: "pr/submitted", data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
      {
        name: "pr/integrated",
        data: { pr: "PR1", revision: 1, headSha: HEAD_1, run: "R1", commit: BASE, landingSha: BASE, baseSha: BASE },
      },
    ])
    const submitOptions = {
      base: "main",
      resolveRevision: async () => HEAD_2,
      run: runtime,
    }
    // Q1: resubmitting the merged branch with a NEW head re-enters through the
    // DERIVED lane — the submit fact is the submission, the queue composes it
    // under a fresh derived identity, and no record mints.
    const seeded = (await Array.fromAsync(app.events())).map(({ name }) => name)
    const reentered = await app.bays.submitSelection("topic/merged", submitOptions)
    expect(reentered).toMatchObject({ lane: "derived", branch: "topic/merged", sha: HEAD_2, base: "main" })
    expect(bays(app).submits["topic/merged"]).toMatchObject({ sha: HEAD_2 })
    // "No record minted" is a claim about the JOURNAL now: the branch's landed
    // pr/* history is neither extended nor rewritten, and the re-entry appends
    // exactly one derived-lane fact beside it.
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([...seeded, "branch/submitted"])
  })

  it("accepts a terminal frame naming a superseded revision, and projects nothing from it", async () => {
    // COVERAGE RETIRED WITH ITS SUBJECT, not converted (S7, @i/10 22991): this
    // test used to prove the reducer REFUSED a terminal whose revision had been
    // superseded ("stale terminal 'pr/withdrawn' for change 'PR1'"). Staleness
    // is a comparison against a record's CURRENT revision, and the store that
    // held one is deleted — `assertTerminalApplies` still stands in plugin.ts
    // with no caller. No surviving @yrd/bay surface judges a terminal against a
    // revision. What the package still owes is what this now pins: the frame is
    // well-formed, so the append registry ACCEPTS it, and it projects nothing.
    const staleWithdraw = command({
      title: "Emit a stale change withdrawal",
      apply: () => ({
        events: [event("pr/withdrawn", { pr: "PR1", revision: 1, headSha: HEAD_1 })],
      }),
    })
    await using app = await seededApp(
      [
        {
          name: "pr/pushed",
          data: { pr: "PR1", branch: "topic/stale-terminal", base: "main", headSha: HEAD_1, revision: 1 },
        },
        { name: "pr/submitted", data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
        {
          name: "pr/pushed",
          data: {
            pr: "PR1",
            branch: "topic/stale-terminal",
            base: "main",
            headSha: HEAD_2,
            baseSha: BASE,
            revision: 2,
          },
        },
        { name: "pr/submitted", data: { pr: "PR1", revision: 2, headSha: HEAD_2 } },
      ],
      { staleWithdraw },
    )
    const before = (await Array.fromAsync(app.events())).map(({ name }) => name)

    await app.dispatch(staleWithdraw, undefined)

    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([...before, "pr/withdrawn"])
    // Four seeded pr/* frames carrying two revisions, plus a fifth naming the
    // first — and the projection is empty. Acceptance without projection, for
    // a frame no reducer is left to judge.
    expect(app.bays.state()).toEqual({ byId: {}, submits: {} })
  })

  it("replays historical current and legacy terminal payloads without accepting legacy appends", async () => {
    const issueRef = "@km/all/21063-steering-laser"
    const pushed = (pr: string, branch: string, headSha: string, submitter?: string): SeedEvent => ({
      name: "pr/pushed",
      data: {
        pr,
        branch,
        base: "main",
        headSha,
        issue: issueRef,
        revision: 1,
        ...(submitter === undefined ? {} : { submitter }),
      },
    })
    const legacyWithdraw = command({
      title: "Emit a legacy PR withdrawal",
      apply: () => ({ events: [event("pr/withdrawn", { pr: "PR3" })] }),
    })
    const legacyReject = command({
      title: "Emit a legacy PR rejection",
      apply: () => ({ events: [event("pr/rejected", { pr: "PR1", revision: 1, detail: "legacy rejection" })] }),
    })
    const transitionalReject = command({
      title: "Emit a transitional PR rejection",
      apply: () => ({
        events: [
          event("pr/rejected", {
            pr: "PR5",
            revision: 1,
            headSha: HEAD_1,
            issueRef,
            run: "R92",
            detail: "current check failure",
          }),
        ],
      }),
    })
    const legacyIntegrate = command({
      title: "Emit a legacy PR integration",
      apply: () => ({
        events: [
          event("pr/integrated", {
            pr: "PR2",
            revision: 1,
            headSha: HEAD_2,
            commit: BASE,
            baseSha: BASE,
          }),
        ],
      }),
    })
    const legacyPush = command({
      title: "Emit a legacy PR push",
      apply: () => ({
        events: [
          event("pr/pushed", {
            pr: "PR4",
            branch: "topic/legacy-push-append",
            base: "main",
            headSha: HEAD_1,
            revision: 1,
          }),
        ],
      }),
    })
    const legacySubmit = command({
      title: "Emit a legacy PR submit",
      apply: () => ({ events: [event("pr/submitted", { pr: "PR1", revision: 1, headSha: HEAD_1 })] }),
    })
    await using app = await seededApp(
      [
        pushed("PR1", "topic/legacy-rejected", HEAD_1),
        { name: "pr/submitted", data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
        { name: "pr/rejected", data: { pr: "PR1", revision: 1, detail: "historical check failure" } },
        { name: "pr/edited", data: { pr: "PR1", issue: "@km/all/obsolete-post-terminal-rehome" } },
        pushed("PR2", "topic/legacy-integrated", HEAD_2),
        { name: "pr/integrated", data: { pr: "PR2", revision: 1, headSha: HEAD_2, commit: BASE, baseSha: BASE } },
        pushed("PR3", "topic/legacy-withdrawn", HEAD_1),
        { name: "pr/withdrawn", data: { pr: "PR3" } },
        pushed("PR4", "topic/current-integrated", HEAD_2),
        {
          name: "pr/integrated",
          data: {
            pr: "PR4",
            revision: 1,
            headSha: HEAD_2,
            issueRef,
            run: "R91",
            commit: BASE,
            landingSha: BASE,
            baseSha: BASE,
          },
        },
        pushed("PR5", "topic/current-rejected", HEAD_1),
        { name: "pr/submitted", data: { pr: "PR5", revision: 1, headSha: HEAD_1 } },
        {
          name: "pr/rejected",
          data: { pr: "PR5", revision: 1, headSha: HEAD_1, issueRef, run: "R92", detail: "current check failure" },
        },
        pushed("PR6", "topic/current-canceled", HEAD_2),
        {
          name: "pr/canceled",
          data: { pr: "PR6", revision: 1, headSha: HEAD_2, issueRef, run: "R93", by: "@ci", reason: "superseded" },
        },
        pushed("PR7", "topic/legacy-recut-with-provenance", HEAD_1, "@dev/3"),
        {
          name: "pr/recut",
          data: {
            pr: "PR7",
            fromRevision: 1,
            patchId: "d".repeat(40),
            baseSha: BASE,
            treeSha: "c".repeat(40),
            reviewCarried: false,
            predecessor: { revision: 1, headSha: HEAD_1 },
            successor: { revision: 2, headSha: HEAD_2, baseSha: BASE },
          },
        },
        pushed("PR8", "topic/legacy-recut-without-provenance", HEAD_1),
        {
          name: "pr/recut",
          data: {
            pr: "PR8",
            fromRevision: 1,
            patchId: "e".repeat(40),
            baseSha: BASE,
            treeSha: "f".repeat(40),
            reviewCarried: false,
            predecessor: { revision: 1, headSha: HEAD_1 },
            successor: { revision: 2, headSha: HEAD_2, baseSha: BASE },
          },
        },
      ],
      { legacyWithdraw, legacyReject, transitionalReject, legacyIntegrate, legacyPush, legacySubmit },
    )

    // The REPLAY half: eight changes' worth of legacy and current terminal
    // payloads — a withdrawal carrying only its id, an integration with no
    // landingSha, a rejection with no headSha, recuts with and without
    // submitter provenance, an edit landing after its terminal — all parsed by
    // the permissive `replayEvents` schemas rather than quarantined. Booting at
    // all is that proof; projecting nothing is S7.
    expect(app.bays.state()).toEqual({ byId: {}, submits: {} })

    // The APPEND half, and why the two registries are not one: `replayEvents`
    // accepts every shape above, `events` accepts only the current one. Each
    // command below re-offers a seeded payload as a LIVE append and is refused
    // there, named to the field the modern shape requires and the legacy one
    // lacks. Pinned to that field rather than left as a bare `toThrow()`: with
    // the materialization half of this test gone, these six ARE the test, and a
    // bare throw would read as green for an unrelated crash — or, worse, keep
    // reading green if a widened append schema started taking legacy frames and
    // something else happened to throw.
    await expect(app.dispatch(legacyWithdraw, undefined)).rejects.toThrow(/"revision"[\s\S]*received undefined/u)
    await expect(app.dispatch(legacyReject, undefined)).rejects.toThrow(/"headSha"[\s\S]*received undefined/u)
    await expect(app.dispatch(transitionalReject, undefined)).rejects.toThrow(/"step"[\s\S]*received undefined/u)
    await expect(app.dispatch(legacyIntegrate, undefined)).rejects.toThrow(/"landingSha"[\s\S]*received undefined/u)
    await expect(app.dispatch(legacyPush, undefined)).rejects.toThrow(/"changeId"[\s\S]*received undefined/u)
    await expect(app.dispatch(legacySubmit, undefined)).rejects.toThrow(/"submitter"[\s\S]*received undefined/u)
  })

  it("runs a pinned bay through refresh, derived submission, the close guard, and close", async () => {
    const { app, workspace } = await createHarness(silentLog)

    const opened = await app.bays.open({ name: "fix-release", baseSha: BASE, by: "test" })
    expect(app.bays.state().byId.B1?.status).toBe("opening")
    await finishJob(app, opened)
    expect(app.bays.get("fix-release")).toMatchObject({
      id: "B1",
      name: "fix-release",
      branch: "issue/fix-release",
      base: "main",
      status: "active",
      path: "/repo/.bays/B1",
      headSha: HEAD_1,
      baseSha: BASE,
    })

    // S7: a bay submission is refresh + checkpoint + the branch/submitted
    // fact — a branch push like everything else, no record intake.
    const submitted = await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      run: runtime,
    })
    expect(submitted).toMatchObject({ lane: "derived", branch: "issue/fix-release", sha: HEAD_2, base: "main" })
    expect(bays(app).submits["issue/fix-release"]).toMatchObject({ sha: HEAD_2, base: "main" })
    // No record intake anywhere in the bay's life: its journal is bay/* facts
    // plus the one derived-lane submission.
    expect((await Array.fromAsync(app.events())).filter(({ name }) => name.startsWith("pr/"))).toEqual([])
    expect(workspace.calls).toEqual([`provision:B1:${BASE}`, "refresh:B1", "checkpoint:B1"])

    // The close guard re-keys on the standing submit fact: closing while the
    // submission stands needs --withdraw (or the fact retired), and the cure
    // names the receiver-side retraction.
    await expect(app.bays.close({ bay: "B1" })).rejects.toThrow(/live submission.*--withdraw/su)
    await expect(app.bays.close({ bay: "B1" })).rejects.toThrow(":refs/yrd/submit/issue/fix-release")

    // A failed deprovision keeps the bay active with the failure recorded.
    workspace.dirty = true
    const refused = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, refused)
    expect(app.bays.state()).toMatchObject({
      byId: { B1: { status: "active", failure: { code: "dirty-worktree" } } },
    })

    workspace.dirty = false
    const closed = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, closed)
    expect(app.bays.state().byId.B1?.status).toBe("closed")
    // No pr/* event anywhere in the run: the journal holds only bay/branch/job facts.
    const names = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(names.filter((name) => name.startsWith("pr/"))).toEqual([])
    expect(names).toContain("branch/submitted")
    await app.close()
  })

  it("certifies handoff readiness for the exact current Bay branch and head", async () => {
    await using app = (await createHarness()).app
    const opened = await app.bays.open({ name: "handoff-ready", by: "test" })
    await finishJob(app, opened)

    expect(app.bays.branchLifecycles()).toEqual([
      expect.objectContaining({
        bay: "B1",
        branch: "issue/handoff-ready",
        headSha: HEAD_1,
        status: "open",
      }),
    ])
    await expect(
      app.bays.certifyHandoff({
        bay: "B1",
        branch: "issue/handoff-ready",
        headSha: HEAD_2,
        evidence: "@km/handoff/handoff-ready.md",
      }),
    ).rejects.toThrow("does not match current head")

    const certified = await app.bays.certifyHandoff({
      bay: "B1",
      branch: "issue/handoff-ready",
      headSha: HEAD_1,
      evidence: "@km/handoff/handoff-ready.md",
    })
    expect(certified.events.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "bay/handoff-certified",
        data: {
          bay: "B1",
          branch: "issue/handoff-ready",
          headSha: HEAD_1,
          evidence: "@km/handoff/handoff-ready.md",
        },
      },
    ])
    expect(
      (
        await app.bays.certifyHandoff({
          bay: "B1",
          branch: "issue/handoff-ready",
          headSha: HEAD_1,
          evidence: "@km/handoff/handoff-ready.md",
        })
      ).events,
    ).toEqual([])
    expect(app.bays.branchLifecycles()).toEqual([
      expect.objectContaining({
        bay: "B1",
        branch: "issue/handoff-ready",
        headSha: HEAD_1,
        status: "handoff-ready",
        ready: {
          at: "2026-01-01T00:00:00.000Z",
          eventId: certified.events[0]?.id,
          evidence: "@km/handoff/handoff-ready.md",
        },
      }),
    ])

    // A submission moves the head (refresh + checkpoint land on HEAD_2) and
    // stands a fact at it — the submitted arm now outranks handoff-ready.
    await app.bays.submitSelection("B1", { resolveRevision: async () => undefined, run: runtime })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/handoff-ready",
      status: "submitted",
    })
  })

  it("projects open, submitted-from-fact, and proof-bearing archived branch states", async () => {
    const harness = createWorkspaceHarness()
    await using app = await createApp(harness.adapter)
    const opened = await app.bays.open({ name: "branch-lifecycle", by: "yrd:4242" })
    await finishJob(app, opened)
    await app.bays.certifyHandoff({
      bay: "B1",
      branch: "issue/branch-lifecycle",
      headSha: HEAD_1,
      evidence: "@km/handoff/branch-lifecycle.md",
    })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({ status: "handoff-ready", by: "yrd:4242" })
    // S7: the record-joined submitter is gone from lifecycles — the derived
    // lane records no submitter in bay state.
    expect(app.bays.branchLifecycles()[0]).not.toHaveProperty("submitter")

    await app.bays.submitSelection("B1", { resolveRevision: async () => undefined, run: runtime })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/branch-lifecycle",
      headSha: HEAD_2,
      by: "yrd:4242",
      status: "submitted",
      submitted: { sha: HEAD_2, base: "main", at: "2026-01-01T00:00:00.000Z" },
    })

    const closing = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, closing)
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/branch-lifecycle",
      headSha: HEAD_1,
      by: "yrd:4242",
      status: "archived",
      archived: {
        at: "2026-01-01T00:00:00.000Z",
        eventId: expect.any(String),
        preservedRef: "refs/yrd/closed/B1",
      },
    })
  })

  it("refuses to open a Bay without explicit process ownership", async () => {
    await using app = (await createHarness()).app

    await expect(app.bays.open({ name: "missing-owner" })).rejects.toThrow("Bay open requires non-empty 'by'")
  })

  it("refuses to open a Bay whose branch is its own base", async () => {
    await using app = (await createHarness()).app

    // A Bay's pushes reach materializeCarrier, which fast-forwards
    // refs/heads/<branch>. A Bay sitting on the mainline turns that into a
    // second writer to the ref the queue must own alone.
    await expect(app.bays.open({ name: "mainline", branch: "main", base: "main", by: "test" })).rejects.toThrow(
      "a bay's branch must differ from its base; branch 'main' and base 'main' are the same ref",
    )

    // Ref identity, not string equality. `base` is canonical by the time
    // openBay sees it, so it is the branch side that has to be resolved.
    await expect(
      app.bays.open({ name: "mainline-origin", branch: "origin/main", base: "main", by: "test" }),
    ).rejects.toThrow("branch 'origin/main' and base 'main' are the same ref")
    await expect(
      app.bays.open({ name: "mainline-refs", branch: "refs/heads/main", base: "origin/main", by: "test" }),
    ).rejects.toThrow("branch 'refs/heads/main' and base 'main' are the same ref")

    // `from` is the other spelling openBay resolves a branch out of, and here
    // the base is the default rather than an argument.
    await expect(app.bays.open({ name: "mainline-from", from: "main", by: "test" })).rejects.toThrow(
      "branch 'main' and base 'main' are the same ref",
    )

    // A Bay off the mainline is untouched by the guard.
    await expect(app.bays.open({ name: "ordinary", base: "main", by: "test" })).resolves.toBeDefined()
  })

  it("keeps a replay-compatible close without archive proof explicitly unmanaged", async () => {
    const harness = createWorkspaceHarness()
    const adapter: BayWorkspace = {
      ...harness.adapter,
      revision: "legacy-workspace-v1",
      deprovision(input): JobResult<DeprovisionedBay> {
        return {
          status: "completed",
          conclusion: "success",
          output: { preservedRef: `refs/yrd/closed/${input.bay}` },
        }
      },
    }
    await using app = await createApp(adapter)
    await finishJob(app, await app.bays.open({ name: "legacy-close", by: "test" }))

    await finishJob(app, await app.bays.close({ bay: "B1" }))

    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/legacy-close",
      headSha: HEAD_1,
      status: "unmanaged",
      reason: "archive-proof-unavailable",
    })
  })

  it("owns the complete bay and direct-branch submission flow", async () => {
    const { app, workspace } = await createHarness()
    await finishJob(app, await app.bays.open({ name: "domain-submit", by: "test" }))
    const resolved: string[] = []
    const resolveRevision = async (ref: string): Promise<string | undefined> => {
      resolved.push(ref)
      return ref === "release/fix" ? HEAD_1 : undefined
    }

    // The bay arm never asks the remote question — it reads the managed
    // workspace's committed head after refresh, checkpoints (pushes), and the
    // fact is the submission.
    const baySubmission = await app.bays.submitSelection("B1", { resolveRevision, run: runtime })
    expect(baySubmission).toMatchObject({
      lane: "derived",
      branch: "issue/domain-submit",
      sha: HEAD_2,
      base: "main",
    })
    expect(bays(app).submits["issue/domain-submit"]).toMatchObject({ sha: HEAD_2, base: "main" })
    expect(workspace.calls).toEqual(["provision:B1:current", "refresh:B1", "checkpoint:B1"])
    expect(resolved).toEqual([])

    // A recordless direct branch routes to the derived lane: the submit fact
    // is the submission, and the explicit base rides the fact.
    const branchSubmission = await app.bays.submitSelection("release/fix", {
      base: "release/2.0",
      resolveRevision,
      run: runtime,
    })
    expect(branchSubmission).toMatchObject({
      lane: "derived",
      branch: "release/fix",
      sha: HEAD_1,
      base: "release/2.0",
    })
    expect(bays(app).submits["release/fix"]).toMatchObject({ sha: HEAD_1, base: "release/2.0" })
    expect(resolved).toEqual(["release/fix"])
    await app.close()
  })

  it("requires durable Jobs before Bay composition in TypeScript", () => {
    const { adapter } = createWorkspaceHarness()
    const jobs = createBayJobDefs(adapter)
    const invalid = () => {
      // @ts-expect-error Bay workspaces require the explicit Jobs capability.
      return withBays({ jobs })(createYrdDef())
    }
    void invalid
  })

  it("warns when record-only metadata is dropped on a derived-lane submit — loud, never refused", async () => {
    await using app = (await createHarness()).app
    // Pre-purge these options bound to the minted record. The CLI derives
    // title/description from the head commit on EVERY submit, so refusing
    // would break every direct-branch flow; dropping silently would be a
    // silent error. D3-style: proceed, and the drop rides the warnings sink
    // naming the cure.
    const warnings: string[] = []
    const submitted = await app.bays.submitSelection("topic/derived-metadata", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
      base: "main",
      title: "feat: from the commit anyway",
      description: "Commit-derived body.",
      warnings,
    })
    expect(submitted).toMatchObject({ lane: "derived", branch: "topic/derived-metadata", sha: HEAD_1 })
    expect(bays(app).submits["topic/derived-metadata"]).toMatchObject({ sha: HEAD_1 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("title/description")
    expect(warnings[0]).toContain("amend the commit")

    // The fence for the warning's own noise floor: a bare derived submit —
    // no metadata options — must warn NOTHING. (The CLI once forwarded
    // commit-derived title/description into this path, tripping the drop
    // warning on every plain submit: "amend the commit to carry" a title
    // that was read FROM the commit.)
    const quiet: string[] = []
    const bare = await app.bays.submitSelection("topic/derived-quiet", {
      resolveRevision: async () => HEAD_2,
      run: runtime,
      base: "main",
      warnings: quiet,
    })
    expect(bare).toMatchObject({ lane: "derived", branch: "topic/derived-quiet", sha: HEAD_2 })
    expect(quiet).toEqual([])
  })

  it("stage is a pure preview on both arms: derived acceptance returns, nothing writes", async () => {
    const { app, workspace } = await createHarness()
    // Direct branch: the preview names the tip and records no fact.
    const preview = await app.bays.submitSelection("topic/staged", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
      base: "main",
      stage: true,
    })
    expect(preview).toMatchObject({ lane: "derived", branch: "topic/staged", sha: HEAD_1, base: "main" })
    expect(bays(app).submits["topic/staged"]).toBeUndefined()

    // Bay arm: refresh answers "what is checked out", but the staging pass
    // stops before checkpoint (no push) and before the fact.
    await finishJob(app, await app.bays.open({ name: "staged-bay", by: "test" }))
    const bayPreview = await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      run: runtime,
      stage: true,
    })
    expect(bayPreview).toMatchObject({ lane: "derived", branch: "issue/staged-bay", sha: HEAD_2, base: "main" })
    expect(bays(app).submits["issue/staged-bay"]).toBeUndefined()
    expect(workspace.calls).toEqual(["provision:B1:current", "refresh:B1"])
    const names = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(names).not.toContain("branch/submitted")
    await app.close()
  })
})

describe("S7 record-verb retirement refusals", () => {
  it("bay.intake refuses record-mint-retired and names the push path", async () => {
    await using app = (await createHarness()).app
    const refused = app.bays.intake({ branch: "topic/late-intake", headSha: HEAD_1, baseSha: BASE })
    await expect(refused).rejects.toMatchObject({ failure: { kind: "refusal", code: "record-mint-retired" } })
    await expect(app.bays.intake({ branch: "topic/late-intake", headSha: HEAD_1, baseSha: BASE })).rejects.toThrow(
      /git push bay HEAD:refs\/for\//u,
    )
  })

  it("bay.submit refuses record-mint-retired naming 'yrd pr submit <branch>' for both arg shapes", async () => {
    await using app = (await createHarness()).app
    await expect(app.bays.submit({ branch: "topic/late-submit", headSha: HEAD_1 })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "record-mint-retired" },
    })
    await expect(app.bays.submit({ branch: "topic/late-submit", headSha: HEAD_1 })).rejects.toThrow(
      "'yrd pr submit topic/late-submit'",
    )
    await expect(app.bays.submit({ pr: "PR9" })).rejects.toThrow("'yrd pr submit PR9'")
  })
})

describe("submit ledger-write door dispositions (D2/D3/D5)", () => {
  const directOptions = (tip: string | undefined = HEAD_2) => ({
    base: "main",
    resolveRevision: async () => tip,
    run: runtime,
  })

  it("routes a closed Bay branch to the derived lane; drafts refuse with the retirement cure", async () => {
    await using app = (await createHarness()).app
    await finishJob(app, await app.bays.open({ name: "retired", by: "test" }))
    const branch = app.bays.get("B1")?.branch
    if (branch === undefined) throw new Error("expected opened Bay branch")
    await finishJob(app, await app.bays.close({ bay: "B1" }))
    expect(app.bays.get("B1")?.status).toBe("closed")

    // A closed Bay owns no workspace: its branch is a plain branch, and a
    // plain branch submits as a derived member.
    await expect(app.bays.submitSelection(branch, { ...directOptions(HEAD_2), draft: true })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "record-mint-retired" },
    })

    const submitted = await app.bays.submitSelection(branch, directOptions(HEAD_2))
    expect(submitted).toMatchObject({ lane: "derived", branch, sha: HEAD_2 })
    expect(bays(app).submits[branch]).toMatchObject({ sha: HEAD_2 })
  })

  it("D2 retired: a withdrawn branch's resubmit re-enters through the derived lane; the withdrawn history stays frozen", async () => {
    await using app = await seededApp([
      {
        name: "pr/pushed",
        data: { pr: "PR1", branch: "topic/redeliver", base: "main", headSha: HEAD_1, revision: 1 },
      },
      { name: "pr/submitted", data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
      { name: "pr/withdrawn", data: { pr: "PR1", revision: 1, headSha: HEAD_1, reason: "pulled back" } },
    ])
    const seeded = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(seeded, "the seeded history ends withdrawn").toEqual(["pr/pushed", "pr/submitted", "pr/withdrawn"])

    // The reopen door retired with the legacy mint: resubmitting the branch
    // writes the submit fact and the queue composes it as a derived member.
    // Direct branches derive identity from content now, not from record
    // continuity — so the withdrawal is still the last word on the old
    // history, and no reopen frame joins it.
    const reentered = await app.bays.submitSelection("topic/redeliver", directOptions(HEAD_2))
    expect(reentered).toMatchObject({ lane: "derived", branch: "topic/redeliver", sha: HEAD_2 })
    expect(bays(app).submits["topic/redeliver"]).toMatchObject({ sha: HEAD_2 })
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([...seeded, "branch/submitted"])
  })

  it("Q1 simplified: resubmitting a merged branch at the SAME head routes to the derived lane too", async () => {
    // S7 dropped the terminal-branch interception (inventory: "always route to
    // derived") — a same-head resubmit re-projects the fact, and the queue's
    // compose settles an already-landed member at run time, loudly, from its
    // tree-containment proof. The landed pr/* history is untouched.
    await using app = await seededApp([
      {
        name: "pr/pushed",
        data: { pr: "PR1", branch: "topic/merged", base: "main", headSha: HEAD_1, baseSha: BASE, revision: 1 },
      },
      { name: "pr/submitted", data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
      {
        name: "pr/integrated",
        data: { pr: "PR1", revision: 1, headSha: HEAD_1, run: "R1", commit: BASE, landingSha: BASE, baseSha: BASE },
      },
    ])

    const before = (await Array.fromAsync(app.events())).length
    const already = await app.bays.submitSelection("topic/merged", directOptions(HEAD_1))
    expect(already).toMatchObject({ lane: "derived", branch: "topic/merged", sha: HEAD_1, base: "main" })
    expect(bays(app).submits["topic/merged"]).toMatchObject({ sha: HEAD_1 })
    const after = await Array.fromAsync(app.events())
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)?.name).toBe("branch/submitted")
  })

  it("D3 revised: a dirty worktree submit checkpoints the WIP into the submission and warns in the envelope AND the log", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const { app, workspace } = await createHarness(log)
    await finishJob(app, await app.bays.open({ name: "dirty", by: "test" }))
    workspace.dirty = true

    const warnings: string[] = []
    const submitted = await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      run: runtime,
      warnings,
    })
    // Submitted the checkpointed head (HEAD_2), never refused; the WIP is IN.
    expect(submitted).toMatchObject({ lane: "derived", branch: "issue/dirty", sha: HEAD_2 })
    expect(workspace.calls).toEqual(["provision:B1:current", "refresh:B1", "checkpoint:B1"])
    // Loud by construction: the caveat rides the result envelope (warnings array)…
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("checkpoint committed it")
    // …AND the structured log stream.
    expect(
      events.some((event) => event.kind === "log" && event.props?.action === "submit-dirty-worktree-checkpointed"),
    ).toBe(true)
    await app.close()
    log.end()
  })

  it("D5: still refuses loudly when the submitted branch resolves to no Git commit", async () => {
    await using app = (await createHarness()).app
    await expect(
      app.bays.submitSelection("topic/ghost", { base: "main", resolveRevision: async () => undefined, run: runtime }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "git-commit-missing" } })
  })

  // Pre-purge, a withdrawal SPENT the payload identity: no other branch could
  // carry that commit, and the only door back was reopening the withdrawn PR
  // in place. The legacy mint's retirement retires the door with it — a
  // withdrawn payload re-enters through the DERIVED lane on any branch, and
  // content dedupe is the queue's job at compose. (The record-lane dedupe died
  // with the submit command at S7.)
  describe("withdrawn payload re-enters through the derived lane", () => {
    const withdrawnSeed: SeedEvent[] = [
      { name: "pr/pushed", data: { pr: "PR1", branch: "topic/burned", base: "main", headSha: HEAD_1, revision: 1 } },
      { name: "pr/submitted", data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
      { name: "pr/withdrawn", data: { pr: "PR1", revision: 1, headSha: HEAD_1, reason: "withdrawn by mistake" } },
    ]

    it("the identical head re-enters on a NEW branch — the spent-payload refusal is retired", async () => {
      await using app = await seededApp(withdrawnSeed)
      const seeded = (await Array.fromAsync(app.events())).map(({ name }) => name)

      // The bead's specimen: the identical head, offered on a NEW branch.
      // Pre-purge this refused ("payload already recorded"); now the record
      // lane no longer owns direct branches, so it composes as derived.
      const reentered = await app.bays.submitSelection("topic/rebuilt", directOptions(HEAD_1))
      expect(reentered).toMatchObject({ lane: "derived", branch: "topic/rebuilt", sha: HEAD_1 })
      expect(bays(app).submits["topic/rebuilt"]).toMatchObject({ sha: HEAD_1 })
      expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([...seeded, "branch/submitted"])
    })

    it("resubmitting the withdrawn branch itself re-enters the same content as a derived member", async () => {
      await using app = await seededApp(withdrawnSeed)
      const seeded = (await Array.fromAsync(app.events())).map(({ name }) => name)

      // Same branch, same head: the withdrawal withdrew a RECORD; resubmitting
      // the content runs it again. Re-entry composes fresh — no reopen, and
      // the withdrawn history keeps its own last word.
      const reentered = await app.bays.submitSelection("topic/burned", directOptions(HEAD_1))
      expect(reentered).toMatchObject({ lane: "derived", branch: "topic/burned", sha: HEAD_1 })
      expect(bays(app).submits["topic/burned"]).toMatchObject({ sha: HEAD_1 })
      expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([...seeded, "branch/submitted"])
    })
  })
})

describe("admission request-count fact", () => {
  const record = (requestCount: unknown) => ({
    pr: "PR1",
    revision: 1,
    headSha: "1".repeat(40),
    admission: {
      status: "passed",
      baseSha: "a".repeat(40),
      ...(requestCount === undefined ? {} : { requestCount }),
      steps: [],
    },
  })

  // Three states, three meanings, and no producer may coerce one into another.
  // Absent is the legacy shape and reads as one authority (`requestCount ?? 1`);
  // zero says a verdict consumed none, which is ordinary once a request's base
  // is allowed to lag the queue's; "unresolved" says the counter could not read
  // some request's base at all, which is neither of the first two and must not
  // be spent as if it were (@yrd/core/rebuilt-carrier-denied-retry).
  it("keeps absent, zero and unresolved as three distinct facts", () => {
    expect(ChangeAdmissionRecordedFactSchema.parse(record(undefined)).admission.requestCount).toBeUndefined()
    expect(ChangeAdmissionRecordedFactSchema.parse(record(0)).admission.requestCount).toBe(0)
    expect(ChangeAdmissionRecordedFactSchema.parse(record(3)).admission.requestCount).toBe(3)
    expect(ChangeAdmissionRecordedFactSchema.parse(record("unresolved")).admission.requestCount).toBe("unresolved")
  })

  it("refuses a count that is neither a whole number of authorities nor the unresolved fact", () => {
    expect(() => ChangeAdmissionRecordedFactSchema.parse(record(-1))).toThrow()
    expect(() => ChangeAdmissionRecordedFactSchema.parse(record(1.5))).toThrow()
    expect(() => ChangeAdmissionRecordedFactSchema.parse(record("unknown"))).toThrow()
  })
})

/**
 * @failure A managed bay's historical pin silently overrules both its own recorded
 * base and an explicit `--base`. @yrd/core/bay-base-authority (B159/B160).
 */
describe("bay-base authority vs live queue", () => {
  const STALE = "5".repeat(40)
  const LIVE = "c".repeat(40)

  async function createPinnedApp(liveSha: { current: string }) {
    const harness = createWorkspaceHarness()
    const resolveBase: ResolveBayBase = async (base) => ({ base, baseSha: liveSha.current })
    const app = await createApp(harness.adapter, undefined, resolveBase)
    return { app, liveSha }
  }

  it("submits a managed bay against the LIVE queue base even after the stored pin ages", async () => {
    const liveSha = { current: BASE }
    const { app } = await createPinnedApp(liveSha)
    await finishJob(app, await app.bays.open({ name: "b160", base: "main", baseSha: BASE, by: "test" }))
    expect(app.bays.get("B1")).toMatchObject({ base: "main", baseSha: BASE })

    liveSha.current = LIVE
    const submitted = await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      run: runtime,
    })
    // The fact's base is resolved through the live authority (resolveBase),
    // never the historical bay pin; the stored pin stays a provisioning fact.
    expect(submitted).toMatchObject({ lane: "derived", branch: "issue/b160", base: "main" })
    expect(bays(app).submits["issue/b160"]).toMatchObject({ base: "main" })
    await app.close()
  })

  it("refuses an explicit pin that contradicts the live queue at open, naming both authorities", async () => {
    const liveSha = { current: LIVE }
    const { app } = await createPinnedApp(liveSha)
    await expect(app.bays.open({ name: "conflict", base: "main", baseSha: STALE, by: "test" })).rejects.toMatchObject({
      failure: {
        code: "base-authority-conflict",
        message: expect.stringMatching(/555555555555.*cccccccccccc/),
      },
    })
    await app.close()
  })

  it("exposes one effective-base SHA that names the live queue after the stored pin ages", async () => {
    const liveSha = { current: BASE }
    const { app } = await createPinnedApp(liveSha)
    await finishJob(app, await app.bays.open({ name: "effective", base: "main", baseSha: BASE, by: "test" }))
    liveSha.current = LIVE
    const shown = await app.bays.effectiveBase("B1")
    expect(shown).toEqual({ base: "main", baseSha: LIVE })
    expect(shown.baseSha).not.toBe(app.bays.get("B1")?.baseSha)
    await app.close()
  })
})
