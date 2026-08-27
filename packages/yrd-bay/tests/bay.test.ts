/**
 * @failure Bay and PR lifecycle state diverges from durable Jobs or accepts invalid transitions.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it, vi } from "vitest"
import {
  Command,
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  pipe,
  type CommandResult,
  type JsonValue,
} from "@yrd/core"
import { withJobs, type JobContext, type JobResult } from "@yrd/job"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import {
  GitShaSchema,
  ChangeAdmissionRecordedFactSchema,
  ChangeRejectedFactSchema,
  currentChangeRev,
  isTracked,
  normalizeV2By,
  normalizeV2Submitter,
  changeDeliveryState,
  projectBranchLifecycles,
  resolveBase,
  type DeprovisionedBay,
  type Change,
  type ProvisionedBay,
  type RefreshedBay,
} from "../src/model.ts"
import { type Bays,
  createBayJobDefs,
  withBays,
  volatilePrNumberMint,
  type BayWorkspace,
  type ResolveBayBase,
} from "../src/plugin.ts"
import type { DerivedSubmission } from "../src/model.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const silentLog = createLogger("test", [{ level: "silent" }])

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

async function createApp(
  workspace: BayWorkspace,
  log?: ConditionalLogger,
  defaultSubmitter?: string,
  resolveBase?: ResolveBayBase,
) {
  const jobs = createBayJobDefs(workspace)
  const definition = pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs,
      defaultBase: "main",
      ...(defaultSubmitter === undefined ? {} : { defaultSubmitter }),
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

function changeFacts(pr: Change | DerivedSubmission | undefined) {
  if (pr === undefined) throw new Error("expected PR")
  if ("lane" in pr) throw new Error("expected a record-lane Change, got a derived submission")
  return { ...pr, delivery: changeDeliveryState(pr), current: currentChangeRev(pr) }
}

function record(result: Awaited<ReturnType<Bays["submitSelection"]>>): Change {
  if ("lane" in result) throw new Error("expected a record-lane Change, got a derived submission")
  return result
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
    const nextId = ids()
    const at = "2026-01-01T00:00:00.000Z"
    const seededCommand = { id: nextId(), op: "fixture.retired-pr-session" }
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: at,
            data: {
              pr: "PR1",
              branch: "task/session-history",
              base: "main",
              headSha: HEAD_1,
              revision: 1,
            },
          },
          {
            id: nextId(),
            name: "pr/session-started",
            ts: at,
            data: { pr: "PR1", launchId: "hab-launch-1" },
          },
          {
            id: nextId(),
            name: "pr/session-ended",
            ts: at,
            data: { pr: "PR1", launchId: "hab-launch-1", outcome: "completed" },
          },
        ],
      },
    ])
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    )
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => at, id: nextId, log: silentLog },
    })

    expect(Object.keys(app.commands.pr)).not.toEqual(expect.arrayContaining(["startSession", "stopSession"]))
    expect(Object.keys(app.bays)).not.toEqual(expect.arrayContaining(["startSession", "stopSession"]))
    expect(app.bays.pr("PR1")).not.toHaveProperty("sessions")
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).toEqual([
      "pr/pushed",
      "pr/session-started",
      "pr/session-ended",
    ])
  })

  it("projects GitHub-shaped PR state with immutable submitted revisions", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "topic/target-model", headSha: HEAD_1, base: "main", baseSha: BASE })

    const pr = app.bays.pr("PR1")
    expect(pr).toMatchObject({
      id: "PR1",
      state: "open",
      merged: false,
      revs: [{ n: 1, head: HEAD_1, submittedAt: "2026-01-01T00:00:00.000Z" }],
    })
    expect(pr).not.toHaveProperty("status")
    expect(pr).not.toHaveProperty("revision")
    expect(pr).not.toHaveProperty("headSha")
    expect(pr).not.toHaveProperty("revisions")

    await app.bays.closePr({ pr: "PR1" })
    expect(app.bays.pr("PR1")).toMatchObject({
      state: "closed",
      merged: false,
      revs: [{ n: 1, head: HEAD_1 }],
    })
  })

  it("records the submitter on strict current revision facts", async () => {
    await using app = await createApp(createWorkspaceHarness().adapter, undefined, "@agent/7")

    const submitted = await app.bays.submit({ branch: "topic/owned", headSha: HEAD_1 })

    expect(submitted.events.map(({ name, data }) => ({ name, data }))).toEqual([
      expect.objectContaining({ name: "pr/pushed", data: expect.objectContaining({ submitter: "@agent/7" }) }),
      expect.objectContaining({ name: "pr/submitted", data: expect.objectContaining({ submitter: "@agent/7" }) }),
    ])
    expect(app.bays.pr("PR1")?.revs).toEqual([expect.objectContaining({ n: 1, head: HEAD_1, submitter: "@agent/7" })])
  })

  it("resolves Bay, PR, and base selectors without changing canonical identity", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "Topic/One", headSha: HEAD_1 })

    expect(app.bays.pr("pr1")).toMatchObject({ id: "PR1", branch: "Topic/One" })
    expect(app.bays.pr("topic/one")).toMatchObject({ id: "PR1", branch: "Topic/One" })

    const opened = await app.bays.open({ name: "Case-Bay", by: "test" })
    await finishJob(app, opened)
    expect(app.bays.get("case-bay")).toMatchObject({ id: "B1", name: "Case-Bay" })

    expect(app.bays.pr("PR1")).toMatchObject({ id: "PR1" })

    expect(resolveBase(["main"], "ORIGIN/MAIN")).toBe("main")
    expect(resolveBase(["Main", "main"], "Main")).toBe("Main")
    expect(() => resolveBase(["Main", "main"], "MAIN")).toThrow("yrd: base selector 'MAIN' is ambiguous: Main, main")
  })

  it("journals an exact revision-bound issue join when a change is withdrawn", async () => {
    await using app = (await createHarness()).app
    const issueRef = "@km/all/21063-steering-laser"
    const props = { request: "21091-withdrawn" }
    await app.bays.submit({
      branch: "topic/mentions-2106-but-not-the-issue",
      headSha: HEAD_1,
      issue: issueRef,
      props,
    })

    const retired = await app.bays.closePr({ pr: "PR1" })

    expect(retired.events).toContainEqual(
      expect.objectContaining({
        name: "pr/withdrawn",
        data: { pr: "PR1", revision: 1, headSha: HEAD_1, issueRef, props, submitter: "operator" },
      }),
    )
  })

  it("attaches one issue to a live change and refuses to rehome its materialized join", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "topic/attach-once", headSha: HEAD_1 })

    await app.bays.editPr({ pr: "PR1", issue: "@km/all/21091-original" })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      issue: "@km/all/21091-original",
      state: "open",
      merged: false,
      delivery: "submitted",
    })

    await expect(app.bays.editPr({ pr: "PR1", issue: "@km/all/21091-rehome" })).rejects.toThrow(
      /already linked|withdraw/i,
    )
    await expect(
      app.bays.intake({
        branch: "topic/attach-once",
        headSha: HEAD_2,
        issue: "@km/all/21091-rehome",
      }),
    ).rejects.toThrow(/already linked|withdraw/i)
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      issue: "@km/all/21091-original",
      delivery: "submitted",
      current: { n: 1, head: HEAD_1 },
    })
  })

  it("preserves an explicit PR issue when a later Bay revision omits --issue", async () => {
    const { app } = await createHarness()
    const explicitIssue = "@km/all/21091-explicit-pr-issue"
    const bayDefault = "@km/all/21091-bay-default"
    await finishJob(app, await app.bays.open({ name: "issue-default", issue: bayDefault, by: "test" }))
    await app.bays.intake({ bay: "B1", headSha: HEAD_1, baseSha: BASE, issue: explicitIssue })
    await app.bays.submit({ pr: "PR1" })

    const revised = record(await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      resolveParents: async () => ["0".repeat(40)],
      run: runtime,
    }))

    expect(changeFacts(revised)).toMatchObject({
      id: "PR1",
      issue: explicitIssue,
      delivery: "submitted",
      current: { n: 2, head: HEAD_2 },
    })
    await app.close()
  })

  it("refuses a bay-less draft: draft records retired with the legacy mint", async () => {
    await using app = (await createHarness()).app
    // Bay-less drafts were record-lane creatures; a recordless branch now
    // routes to the derived lane and a draft has nothing to draft. The
    // moved-tip re-resolution the old draft flow proved lives on in the
    // closed-Bay sibling below, whose id-addressed retry still reads the
    // CURRENT tip from a record draft.
    await expect(
      app.bays.submitSelection("topic/moving-draft", {
        base: "main",
        resolveRevision: async () => HEAD_1,
        run: runtime,
        draft: true,
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "record-mint-retired" } })
  })

  it("re-resolves a moved branch tip for a closed-Bay draft addressed by PR id or Bay id", async () => {
    // Only an ACTIVE Bay reads its head from a workspace. A closed Bay owns no
    // workspace, so an id-addressed retry must re-resolve the branch tip exactly
    // like the bay-less path — never re-present the recorded head at exit 0.
    const HEAD_3 = "3".repeat(40)
    await using app = (await createHarness()).app
    await finishJob(app, await app.bays.open({ name: "retired-draft", by: "test" }))
    await app.bays.intake({ bay: "B1", headSha: HEAD_1, baseSha: BASE })
    await finishJob(app, await app.bays.close({ bay: "B1" }))
    expect(app.bays.get("B1")?.status).toBe("closed")

    let tip = HEAD_1
    const create = (selector: string) =>
      app.bays.submitSelection(selector, { resolveRevision: async () => tip, run: runtime, draft: true }).then(record)

    const drafted = await create("PR1")
    expect(changeFacts(drafted)).toMatchObject({ id: "PR1", delivery: "pushed", current: { n: 1, head: HEAD_1 } })

    // The branch advances after the Bay was retired. Retrying `pr create` by PR
    // id must record the CURRENT tip, not the stale revision-1 head.
    tip = HEAD_2
    const byPrId = await create("PR1")
    expect(changeFacts(byPrId)).toMatchObject({ id: "PR1", delivery: "pushed", current: { n: 2, head: HEAD_2 } })

    // Same for the closed Bay's own id — the selector that resolves the Bay
    // without matching its branch name.
    tip = HEAD_3
    const byBayId = await create("B1")
    expect(changeFacts(byBayId)).toMatchObject({ id: "PR1", delivery: "pushed", current: { n: 3, head: HEAD_3 } })

    // An unmoved tip stays idempotent — no spurious revision.
    const stable = await create("PR1")
    expect(changeFacts(stable)).toMatchObject({ id: "PR1", delivery: "pushed", current: { n: 3, head: HEAD_3 } })
    expect(stable.bay).toBe("B1")
  })

  it("re-enters a new head on a merged branch through the derived lane (Q1), no record minted", async () => {
    const nextId = ids()
    const seededCommand = { id: nextId(), op: "fixture.integrated-branch" }
    const at = "2026-01-01T00:00:00.000Z"
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: at,
            data: {
              pr: "PR1",
              branch: "topic/merged",
              base: "main",
              headSha: HEAD_1,
              baseSha: BASE,
              revision: 1,
            },
          },
          {
            id: nextId(),
            name: "pr/submitted",
            ts: at,
            data: { pr: "PR1", revision: 1, headSha: HEAD_1 },
          },
          {
            id: nextId(),
            name: "pr/integrated",
            ts: at,
            data: {
              pr: "PR1",
              revision: 1,
              headSha: HEAD_1,
              run: "R1",
              commit: BASE,
              landingSha: BASE,
              baseSha: BASE,
            },
          },
        ],
      },
    ])
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    )
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => at, id: nextId },
    })
    const submitOptions = {
      base: "main",
      resolveRevision: async () => HEAD_2,
      run: runtime,
    }
    // Q1: resubmitting the merged branch with a NEW head re-enters through the
    // DERIVED lane — the submit fact is the submission, the queue composes it
    // under a fresh derived identity, and no record mints. The integrated PR1
    // stays frozen.
    const reentered = await app.bays.submitSelection("topic/merged", submitOptions)
    expect(reentered).toMatchObject({ lane: "derived", branch: "topic/merged", sha: HEAD_2, base: "main" })
    expect(app.bays.state().submits["topic/merged"]).toMatchObject({ sha: HEAD_2 })
    expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "integrated", current: { head: HEAD_1 } })
    // With no live record the branch selector read-resolves the frozen change.
    expect(changeFacts(app.bays.pr("topic/merged"))).toMatchObject({ id: "PR1", delivery: "integrated" })
  })

  it("refuses a terminal result that does not transition the current PR revision", async () => {
    const journal = createMemoryJournal()
    const staleWithdraw = command({
      title: "Emit a stale change withdrawal",
      apply: () => ({
        events: [event("pr/withdrawn", { pr: "PR1", revision: 1, headSha: HEAD_1 })],
      }),
    })
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    ).extend({ commands: { fixture: { staleWithdraw } } })
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => "2026-01-01T00:00:00.000Z", id: ids() },
    })
    await app.bays.submit({ branch: "topic/stale-terminal", headSha: HEAD_1 })
    await app.bays.intake({ branch: "topic/stale-terminal", headSha: HEAD_2, baseSha: BASE })
    await app.bays.submit({ pr: "PR1" })
    const before = await Array.fromAsync(app.events())

    await expect(app.dispatch(app.commands.fixture.staleWithdraw, undefined)).rejects.toThrow(/stale terminal.*PR1/iu)

    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "submitted",
      current: { n: 2, head: HEAD_2 },
    })
  })

  it("replays historical current and legacy terminal payloads without accepting legacy appends", async () => {
    const nextId = ids()
    const seededCommand = { id: nextId(), op: "fixture.legacy-pr-terminals" }
    const issueRef = "@km/all/21063-steering-laser"
    const at = "2026-01-01T00:00:00.000Z"
    const pushed = (pr: string, branch: string, headSha: string, submitter?: string) => ({
      id: nextId(),
      name: "pr/pushed",
      ts: at,
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
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          pushed("PR1", "topic/legacy-rejected", HEAD_1),
          {
            id: nextId(),
            name: "pr/submitted",
            ts: at,
            data: { pr: "PR1", revision: 1, headSha: HEAD_1 },
          },
          {
            id: nextId(),
            name: "pr/rejected",
            ts: at,
            data: { pr: "PR1", revision: 1, detail: "historical check failure" },
          },
          {
            id: nextId(),
            name: "pr/edited",
            ts: at,
            data: { pr: "PR1", issue: "@km/all/obsolete-post-terminal-rehome" },
          },
          pushed("PR2", "topic/legacy-integrated", HEAD_2),
          {
            id: nextId(),
            name: "pr/integrated",
            ts: at,
            data: { pr: "PR2", revision: 1, headSha: HEAD_2, commit: BASE, baseSha: BASE },
          },
          pushed("PR3", "topic/legacy-withdrawn", HEAD_1),
          { id: nextId(), name: "pr/withdrawn", ts: at, data: { pr: "PR3" } },
          pushed("PR4", "topic/current-integrated", HEAD_2),
          {
            id: nextId(),
            name: "pr/integrated",
            ts: at,
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
          {
            id: nextId(),
            name: "pr/submitted",
            ts: at,
            data: { pr: "PR5", revision: 1, headSha: HEAD_1 },
          },
          {
            id: nextId(),
            name: "pr/rejected",
            ts: at,
            data: {
              pr: "PR5",
              revision: 1,
              headSha: HEAD_1,
              issueRef,
              run: "R92",
              detail: "current check failure",
            },
          },
          pushed("PR6", "topic/current-canceled", HEAD_2),
          {
            id: nextId(),
            name: "pr/canceled",
            ts: at,
            data: {
              pr: "PR6",
              revision: 1,
              headSha: HEAD_2,
              issueRef,
              run: "R93",
              by: "@ci",
              reason: "superseded",
            },
          },
          pushed("PR7", "topic/legacy-recut-with-provenance", HEAD_1, "@dev/3"),
          {
            id: nextId(),
            name: "pr/recut",
            ts: at,
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
            id: nextId(),
            name: "pr/recut",
            ts: at,
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
      },
    ])
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
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    ).extend({
      commands: {
        fixture: { legacyWithdraw, legacyReject, transitionalReject, legacyIntegrate, legacyPush, legacySubmit },
      },
    })
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => at, id: nextId },
    })

    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "rejected", issue: issueRef })
    expect(app.bays.pr("PR1")?.revs).toEqual([expect.not.objectContaining({ submitter: expect.anything() })])
    expect(changeFacts(app.bays.pr("PR2"))).toMatchObject({
      state: "closed",
      merged: true,
      delivery: "integrated",
      issue: issueRef,
      integration: { commit: BASE, baseSha: BASE },
    })
    expect(changeFacts(app.bays.pr("PR3"))).toMatchObject({ delivery: "withdrawn", issue: issueRef })
    expect(changeFacts(app.bays.pr("PR4"))).toMatchObject({ delivery: "integrated", terminalRun: "R91" })
    expect(changeFacts(app.bays.pr("PR5"))).toMatchObject({
      delivery: "rejected",
      terminalRun: "R92",
      detail: "current check failure",
    })
    expect(changeFacts(app.bays.pr("PR6"))).toMatchObject({
      delivery: "canceled",
      terminalRun: "R93",
      canceledBy: "@ci",
      cancelReason: "superseded",
    })
    expect(changeFacts(app.bays.pr("PR7"))).toMatchObject({
      delivery: "pushed",
      current: { n: 2, head: HEAD_2, submitter: "@dev/3", recut: { fromRevision: 1 } },
    })
    expect(changeFacts(app.bays.pr("PR8"))).toMatchObject({
      delivery: "pushed",
      current: { n: 2, head: HEAD_2, recut: { fromRevision: 1 } },
    })
    expect(currentChangeRev(app.bays.pr("PR8")!)).not.toHaveProperty("submitter")
    await expect(app.dispatch(app.commands.fixture.legacyWithdraw, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacyReject, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.transitionalReject, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacyIntegrate, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacyPush, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacySubmit, undefined)).rejects.toThrow()
  })

  it("persists one opaque props on a draft revision and preserves it through ready", async () => {
    await using app = (await createHarness()).app
    const props = { request: "review-20925/custom 61's docs" }

    const drafted = await app.bays.submit({
      branch: "issue/correlated-draft",
      headSha: HEAD_1,
      draft: true,
      props,
    })
    expect(drafted.events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ props }),
      }),
    )
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "pushed",
      current: { n: 1, props },
      revs: [{ n: 1, props }],
    })

    expect((await app.bays.submit({ pr: "PR1", props })).events).toEqual([])
    await expect(
      app.bays.submit({
        pr: "PR1",
        props: { request: "review-20925/conflicting" },
      }),
    ).rejects.toThrow("already carries prop 'request=review-20925/custom 61's docs'")

    const ready = await app.bays.ready({ pr: "PR1" })
    expect(ready.events).toHaveLength(1)
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "submitted",
      current: { n: 1, props },
      revs: [{ n: 1, props }],
    })
  })

  it("runs a pinned bay through refresh, PR revisions, withdrawal, and close", async () => {
    const { app, workspace } = await createHarness(createLogger("test", [{ level: "silent" }]))

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

    const result = "f".repeat(64)
    const pushed = { bay: "B1", headSha: HEAD_1, baseSha: BASE, receipt: result }
    expect((await app.bays.intake(pushed)).events).toHaveLength(1)
    expect((await app.bays.intake(pushed)).events).toHaveLength(0)
    await expect(app.bays.intake({ ...pushed, headSha: HEAD_2 })).rejects.toThrow(
      `receiver result '${result}' does not match its recorded intake`,
    )
    await app.bays.submit({ pr: "PR1" })

    const refreshed = await app.bays.refresh({ bay: "B1" })
    await finishJob(app, refreshed)
    expect(app.bays.get("B1")).toMatchObject({ status: "active", headSha: HEAD_2, baseSha: BASE, dirty: false })
    await app.bays.intake({ bay: "B1", headSha: HEAD_2, baseSha: BASE })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      id: "PR1",
      bay: "B1",
      branch: "issue/fix-release",
      base: "main",
      delivery: "pushed",
      current: { n: 2, head: HEAD_2 },
      revs: [
        {
          n: 1,
          head: HEAD_1,
          base: "main",
          baseSha: BASE,
          pushedAt: "2026-01-01T00:00:00.000Z",
          submittedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          n: 2,
          head: HEAD_2,
          base: "main",
          baseSha: BASE,
          pushedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })

    workspace.dirty = true
    const refused = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, refused)
    expect(changeFacts(app.bays.state().prs.PR1)).toMatchObject({
      state: "closed",
      merged: false,
      delivery: "withdrawn",
      revs: [
        { n: 1, submittedAt: "2026-01-01T00:00:00.000Z" },
        {
          n: 2,
          terminal: { kind: "withdrawn", at: "2026-01-01T00:00:00.000Z" },
        },
      ],
    })
    expect(app.bays.state()).toMatchObject({
      byId: { B1: { status: "active", failure: { code: "dirty-worktree" } } },
    })

    const withdrawn = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, withdrawn)
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "withdrawn",
      revs: [
        { n: 1, submittedAt: "2026-01-01T00:00:00.000Z" },
        { n: 2, terminal: { kind: "withdrawn", at: "2026-01-01T00:00:00.000Z" } },
      ],
    })

    workspace.dirty = false
    const closed = await app.bays.close({ bay: "B1" })
    await finishJob(app, closed)
    expect(app.bays.state().byId.B1?.status).toBe("closed")
    expect(workspace.calls).toEqual([
      `provision:B1:${BASE}`,
      "refresh:B1",
      "deprovision:B1",
      "deprovision:B1",
      "deprovision:B1",
    ])
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

    await app.bays.intake({ bay: "B1", headSha: HEAD_2 })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/handoff-ready",
      status: "open",
    })
  })

  it("projects pushed, submitted, and proof-bearing archived branch states", async () => {
    const harness = createWorkspaceHarness()
    await using app = await createApp(harness.adapter, undefined, "@dev/3")
    const opened = await app.bays.open({ name: "branch-lifecycle", by: "yrd:4242" })
    await finishJob(app, opened)
    await app.bays.certifyHandoff({
      bay: "B1",
      branch: "issue/branch-lifecycle",
      headSha: HEAD_1,
      evidence: "@km/handoff/branch-lifecycle.md",
    })

    await app.bays.intake({ bay: "B1", headSha: HEAD_1 })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      status: "handoff-ready",
      by: "yrd:4242",
      submitter: "@dev/3",
    })

    await app.bays.submit({ pr: "PR1" })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/branch-lifecycle",
      headSha: HEAD_1,
      by: "yrd:4242",
      submitter: "@dev/3",
      status: "submitted",
      submitted: { pr: "PR1", revision: 1, at: "2026-01-01T00:00:00.000Z" },
    })

    const closing = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, closing)
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/branch-lifecycle",
      headSha: HEAD_1,
      by: "yrd:4242",
      submitter: "@dev/3",
      status: "archived",
      archived: {
        at: "2026-01-01T00:00:00.000Z",
        eventId: expect.any(String),
        preservedRef: "refs/yrd/closed/B1",
      },
    })
  })

  it("keeps the exact historical revision submitter after the change is recut", async () => {
    const harness = createWorkspaceHarness()
    await using app = await createApp(harness.adapter, undefined, "@dev/3")
    const opened = await app.bays.open({ name: "recut-lifecycle", by: "yrd:4242" })
    await finishJob(app, opened)
    await app.bays.certifyHandoff({
      bay: "B1",
      branch: "issue/recut-lifecycle",
      headSha: HEAD_1,
      evidence: "@km/handoff/recut-lifecycle.md",
    })
    await app.bays.intake({ bay: "B1", headSha: HEAD_1 })

    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })

    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/recut-lifecycle",
      headSha: HEAD_1,
      by: "yrd:4242",
      submitter: "@dev/3",
      status: "open",
    })

    const snapshot = app.state().bays
    const recorded = snapshot.prs.PR1
    if (recorded === undefined) throw new Error("expected PR1")
    const { bay: _bay, ...unassociated } = recorded
    // A carrier submitted as a bare branch (refs/for, `bay.submit` of a branch)
    // never gets an explicit bay pointer, and old journal rows can never gain
    // one. The recorded exact-head submitter must still reach the lifecycle
    // through the branch association.
    expect(
      projectBranchLifecycles({
        ...snapshot,
        prs: { ...snapshot.prs, PR1: unassociated },
      })[0],
    ).toMatchObject({ submitter: "@dev/3" })

    const firstRevision = unassociated.revs[0]
    if (firstRevision === undefined) throw new Error("expected revision 1")
    // Two branch-matched PRs disagreeing at the same head is the one shape a
    // branch association cannot attribute — it must stay unknown, not guess.
    expect(
      projectBranchLifecycles({
        ...snapshot,
        prs: {
          ...snapshot.prs,
          PR1: unassociated,
          PR2: {
            ...unassociated,
            id: "PR2",
            revs: [{ ...firstRevision, submitter: "@dev/4" }],
          },
        },
      })[0],
    ).not.toHaveProperty("submitter")

    const closing = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, closing)
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      headSha: HEAD_1,
      status: "archived",
      submitter: "@dev/3",
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

  it("does not infer a lifecycle submitter from Bay process ownership", async () => {
    await using app = (await createHarness()).app
    const opened = await app.bays.open({ name: "unknown-submitter", by: "yrd:4242" })
    await finishJob(app, opened)
    await app.bays.certifyHandoff({
      bay: "B1",
      branch: "issue/unknown-submitter",
      headSha: HEAD_1,
      evidence: "@km/handoff/unknown-submitter.md",
    })

    await app.bays.intake({ bay: "B1", headSha: HEAD_1 })

    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      status: "handoff-ready",
      by: "yrd:4242",
      submitter: "operator",
    })
    expect(app.bays.branchLifecycles()[0]).not.toMatchObject({ submitter: "yrd:4242" })

    await app.bays.intake({ branch: "issue/unknown-submitter", headSha: HEAD_2 })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      status: "open",
      headSha: HEAD_1,
      by: "yrd:4242",
      submitter: "operator",
    })
    expect(app.bays.branchLifecycles()[0]).not.toMatchObject({ submitter: "yrd:4242" })
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

  it("projects an exact integrated revision as merged even after its Bay closes", async () => {
    const identity: { changeId?: string } = {}
    const integrate = command({
      title: "Integrate the lifecycle fixture",
      apply: () => {
        if (identity.changeId === undefined) throw new Error("missing fixture Change-Id")
        return {
          events: [
            event("pr/integrated", {
              pr: "PR1",
              revision: 1,
              headSha: HEAD_1,
              run: "R1",
              commit: BASE,
              landingSha: BASE,
              baseSha: BASE,
              changeId: identity.changeId,
            }),
          ],
        }
      },
    })
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    ).extend({ commands: { fixture: { integrate } } })
    await using app = await createYrd(definition, {
      inject: { journal: createMemoryJournal(), clock: () => "2026-01-01T00:00:00.000Z", id: ids() },
    })
    const opened = await app.bays.open({ name: "merged-lifecycle", by: "test" })
    await finishJob(app, opened)
    await app.bays.intake({ bay: "B1", headSha: HEAD_1 })
    await app.bays.submit({ pr: "PR1" })
    identity.changeId = currentChangeRev(app.bays.pr("PR1")!).changeId

    await app.dispatch(app.commands.fixture.integrate, undefined)
    expect(app.bays.branchLifecycles()[0]).toMatchObject({
      bay: "B1",
      branch: "issue/merged-lifecycle",
      headSha: HEAD_1,
      status: "landed",
      landed: { pr: "PR1", revision: 1, at: "2026-01-01T00:00:00.000Z", commit: BASE },
    })

    const closing = await app.bays.close({ bay: "B1" })
    await finishJob(app, closing)
    expect(app.bays.branchLifecycles()[0]).toMatchObject({ status: "landed" })
  })

  it("submits prepared branches with monotonic PR ids and selected bases", async () => {
    const { app, workspace } = await createHarness()

    await app.bays.submit({ branch: "release/fix", headSha: HEAD_1, base: "release/2.0", name: "release-fix" })
    await app.bays.submit({ branch: "hotfix/next", headSha: HEAD_2 })

    expect(app.bays.state().byId).toEqual({})
    expect(changeFacts(app.bays.state().prs.PR1)).toMatchObject({
      branch: "release/fix",
      base: "release/2.0",
      delivery: "submitted",
      current: { head: HEAD_1 },
    })
    expect(changeFacts(app.bays.state().prs.PR2)).toMatchObject({
      branch: "hotfix/next",
      base: "main",
      delivery: "submitted",
      current: { head: HEAD_2 },
    })
    await expect(app.bays.submit({ branch: "release/fix", headSha: HEAD_2 })).rejects.toThrow(
      "branch 'release/fix' already has live change 'PR1'",
    )
    expect(workspace.calls).toEqual([])
    await app.close()
  })

  it("journals revision-bound review and comment facts without inventing a draft status", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/review-me", headSha: HEAD_1, draft: true })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "pushed",
      current: { n: 1, head: HEAD_1 },
    })
    const requestChecks = async (baseSha: string) =>
      (await app.bays.requestChecks({ pr: "PR1", baseSha })).events.map(({ name, data }) => ({ name, data }))
    const fact = (baseSha: string) => [
      {
        name: "pr/checks-requested",
        data: { pr: "PR1", revision: 1, headSha: HEAD_1, baseSha },
      },
    ]
    expect(await requestChecks(BASE)).toEqual(fact(BASE))
    expect(await requestChecks(BASE)).toEqual(fact(BASE))
    expect(await requestChecks(HEAD_2)).toEqual(fact(HEAD_2))
    expect(app.bays.checksRequested("PR1")).toBe(true)
    expect(app.bays.pr("PR1")?.checkRequests.at(-1)).toMatchObject({ baseSha: HEAD_2 })

    const comment = {
      pr: "PR1",
      by: "@cto",
      ref: "dialog-1",
      note: "Please explain the failure mode.",
    }
    expect((await app.bays.comment(comment)).events).toHaveLength(1)
    expect((await app.bays.comment(comment)).events).toHaveLength(0)

    const approval = {
      pr: "PR1",
      by: "@cto",
      decision: "approve" as const,
      ref: "verdict-1",
      note: "Exact revision reviewed.",
    }
    expect((await app.bays.review(approval)).events).toHaveLength(1)
    expect((await app.bays.review(approval)).events).toHaveLength(0)
    await expect(app.bays.review({ ...approval, decision: "reject" })).rejects.toThrow(
      "review ref 'verdict-1' already records a different fact",
    )
    const { note: _note, ...approvalWithoutNote } = approval
    await expect(app.bays.review(approvalWithoutNote)).rejects.toThrow(
      "review ref 'verdict-1' already records a different fact",
    )

    expect(app.bays.reviewState("PR1")).toMatchObject({
      approved: true,
      current: { revision: 1, headSha: HEAD_1, by: "@cto", decision: "approve", ref: "verdict-1" },
      stale: [],
    })
    expect(app.bays.reviewState("PR1").current).not.toHaveProperty("pr")
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "pushed",
      reviews: [{ revision: 1, headSha: HEAD_1, decision: "approve", by: "@cto", ref: "verdict-1" }],
      comments: [{ revision: 1, headSha: HEAD_1, by: "@cto", ref: "dialog-1" }],
    })

    expect((await app.bays.ready({ pr: "PR1" })).events).toHaveLength(1)
    expect((await app.bays.ready({ pr: "PR1" })).events).toHaveLength(0)
    expect(changeFacts(app.bays.pr("PR1")).delivery).toBe("submitted")

    await app.bays.intake({ branch: "issue/review-me", headSha: HEAD_2, base: "main" })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "pushed",
      current: { n: 2, head: HEAD_2 },
    })
    expect(app.bays.reviewState("PR1")).toMatchObject({
      approved: false,
      stale: [{ revision: 1, headSha: HEAD_1, decision: "approve", ref: "verdict-1" }],
    })
    expect(app.bays.reviewState("PR1").current).toBeUndefined()
    expect(app.bays.checksRequested("PR1")).toBe(false)
  })

  it("journals declarative reviewer-request sets with latest-wins replace and terminal refusal", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/request-review", headSha: HEAD_1 })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "submitted",
      current: { n: 1 },
      requestedReviewers: [],
    })
    expect(app.bays.needsReview("PR1")).toBe(false)

    const arbitraryReviewer = "reviewer id/with spaces:7"
    const first = await app.bays.requestReview({ pr: "PR1", reviewers: ["@cto", arbitraryReviewer] })
    expect(first.events.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "pr/review-requested",
        data: { pr: "PR1", reviewers: ["@cto", arbitraryReviewer], requestedBy: "operator" },
      },
    ])
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual(["@cto", arbitraryReviewer])

    expect((await app.bays.requestReview({ pr: "PR1", reviewers: ["@cto", arbitraryReviewer] })).events).toEqual([])

    const replaced = await app.bays.requestReview({ pr: "PR1", reviewers: ["@agent/5"], by: "@chief" })
    expect(replaced.events.map(({ name, data }) => ({ name, data }))).toEqual([
      { name: "pr/review-requested", data: { pr: "PR1", reviewers: ["@agent/5"], requestedBy: "@chief" } },
    ])
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual(["@agent/5"])

    expect((await app.bays.requestReview({ pr: "PR1", reviewers: [] })).events).toHaveLength(1)
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual([])

    await app.bays.closePr({ pr: "PR1" })
    await expect(app.bays.requestReview({ pr: "PR1", reviewers: ["@cto"] })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "terminal-target" },
    })
  })

  it("projects the needs-review matrix from requested reviewers and revision-bound verdicts", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/needs-review", headSha: HEAD_1 })
    expect(app.bays.needsReview("PR1")).toBe(false)

    await app.bays.requestReview({ pr: "PR1", reviewers: ["@cto", "@agent/5"] })
    expect(app.bays.needsReview("PR1")).toBe(true)
    expect(app.bays.needsReview("PR1", "@cto")).toBe(true)
    expect(app.bays.needsReview("PR1", "@stranger")).toBe(false)

    await app.bays.review({ pr: "PR1", by: "@stranger", decision: "approve", ref: "stranger-1" })
    expect(app.bays.needsReview("PR1")).toBe(true)

    await app.bays.review({ pr: "PR1", by: "@cto", decision: "reject", ref: "verdict-1" })
    expect(app.bays.needsReview("PR1")).toBe(false)
    expect(app.bays.needsReview("PR1", "@cto")).toBe(false)
    expect(app.bays.needsReview("PR1", "@agent/5")).toBe(true)

    await app.bays.intake({ branch: "issue/needs-review", headSha: HEAD_2, base: "main" })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "pushed", current: { n: 2 } })
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual(["@cto", "@agent/5"])
    expect(app.bays.needsReview("PR1")).toBe(false)

    await app.bays.ready({ pr: "PR1" })
    expect(app.bays.needsReview("PR1")).toBe(true)

    await app.bays.requestReview({ pr: "PR1", reviewers: [] })
    expect(app.bays.needsReview("PR1")).toBe(false)
  })

  it("keeps the requested set through recut and reopens needs-review when approval is not carried", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/recut-request", headSha: HEAD_1, baseSha: BASE })
    await app.bays.requestReview({ pr: "PR1", reviewers: ["@cto"] })
    await app.bays.review({ pr: "PR1", by: "@cto", decision: "approve", ref: "verdict-1" })
    expect(app.bays.needsReview("PR1")).toBe(false)

    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "pushed", current: { n: 2 } })
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual(["@cto"])

    await app.bays.ready({ pr: "PR1" })
    expect(app.bays.needsReview("PR1")).toBe(true)
    expect(app.bays.needsReview("PR1", "@cto")).toBe(true)
  })

  it("emits reviewer requests from submit right after the submission fact", async () => {
    await using app = (await createHarness()).app

    const result = await app.bays.submit({ branch: "issue/submit-reviewers", headSha: HEAD_1, reviewers: ["@cto"] })
    expect(result.events.map(({ name }) => name)).toEqual(["pr/pushed", "pr/submitted", "pr/review-requested"])
    expect(result.events.at(-1)?.data).toEqual({ pr: "PR1", reviewers: ["@cto"], requestedBy: "operator" })
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual(["@cto"])

    const draft = await app.bays.submit({
      branch: "issue/submit-draft-reviewers",
      headSha: HEAD_2,
      draft: true,
      reviewers: ["@agent/5"],
    })
    expect(draft.events.map(({ name }) => name)).toEqual(["pr/pushed", "pr/review-requested"])
    expect(app.bays.pr("PR2")?.requestedReviewers).toEqual(["@agent/5"])
    expect(app.bays.needsReview("PR2")).toBe(false)

    const plain = await app.bays.submit({ branch: "issue/submit-no-reviewers", headSha: "3".repeat(40) })
    expect(plain.events.map(({ name }) => name)).toEqual(["pr/pushed", "pr/submitted"])
  })

  it("replays journals containing pr/review-requested facts through the production decoder", async () => {
    const nextId = ids()
    const seededCommand = { id: nextId(), op: "fixture.review-requested" }
    const at = "2026-01-01T00:00:00.000Z"
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: at,
            data: { pr: "PR1", branch: "topic/replay-request", base: "main", headSha: HEAD_1, revision: 1 },
          },
          {
            id: nextId(),
            name: "pr/submitted",
            ts: at,
            data: { pr: "PR1", revision: 1, headSha: HEAD_1 },
          },
          {
            id: nextId(),
            name: "pr/review-requested",
            ts: at,
            data: { pr: "PR1", reviewers: ["@cto"], requestedBy: "@chief" },
          },
          {
            id: nextId(),
            name: "pr/review-requested",
            ts: at,
            data: { pr: "PR1", reviewers: ["@agent/5", "@cto"], requestedBy: "@chief" },
          },
        ],
      },
    ])
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    )
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => at, id: nextId },
    })

    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      delivery: "submitted",
      requestedReviewers: ["@agent/5", "@cto"],
    })
    expect(app.bays.needsReview("PR1")).toBe(true)
    expect(app.bays.needsReview("PR1", "@agent/5")).toBe(true)
    expect(app.bays.needsReview("PR1", "@stranger")).toBe(false)
  })

  it("recuts one Change-Id lineage as a new immutable revision and carries exact approval", async () => {
    await using app = (await createHarness()).app
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const changeId = "I10db26abe7d1f6cae0a29e37b3d6b9b5d0e9a3da"

    const props = { request: "recut-identity" }
    const pushed = await app.bays.submit({
      branch: "issue/recut",
      headSha: HEAD_1,
      baseSha: BASE,
      props,
      submitter: "@dev/3",
      draft: true,
    })
    expect(pushed.events).toContainEqual(
      expect.objectContaining({
        name: "pr/pushed",
        data: expect.objectContaining({ changeId }),
      }),
    )
    await app.bays.review({
      pr: "PR1",
      by: "@cto",
      decision: "approve",
      ref: "review-revision-1",
      note: "Reviewed immutable payload.",
    })

    const args = {
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: nextBase,
      treeSha,
      patchId,
      reviewCarried: true,
    } as const
    const remerge = await app.bays.recut(args)

    expect(remerge.events).toContainEqual(
      expect.objectContaining({
        name: "pr/recut",
        data: {
          pr: "PR1",
          changeId,
          fromRevision: 1,
          patchId,
          baseSha: nextBase,
          treeSha,
          reviewCarried: true,
          submitter: "@dev/3",
          predecessor: { revision: 1, headSha: HEAD_1, baseSha: BASE },
          successor: { revision: 2, headSha: HEAD_2, baseSha: nextBase },
        },
      }),
    )
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      id: "PR1",
      branch: "issue/recut",
      delivery: "pushed",
      current: {
        n: 2,
        changeId,
        head: HEAD_2,
        baseSha: nextBase,
        props,
        submitter: "@dev/3",
        recut: { fromRevision: 1, patchId, treeSha, reviewCarried: true },
      },
      revs: [
        { n: 1, changeId, head: HEAD_1, props, submitter: "@dev/3" },
        {
          n: 2,
          changeId,
          head: HEAD_2,
          baseSha: nextBase,
          props,
          submitter: "@dev/3",
          recut: { fromRevision: 1, patchId, treeSha, reviewCarried: true },
        },
      ],
      reviews: [
        { revision: 1, headSha: HEAD_1, ref: "review-revision-1" },
        { revision: 2, headSha: HEAD_2, carriedFrom: { revision: 1, headSha: HEAD_1 } },
      ],
    })
    expect(app.bays.reviewState("PR1")).toMatchObject({
      approved: true,
      current: { revision: 2, headSha: HEAD_2, carriedFrom: { revision: 1, headSha: HEAD_1 } },
    })
    expect((await app.bays.recut(args)).events).toEqual([])
    await app.bays.closePr({ pr: "PR1" })
    await expect(app.bays.recut(args)).rejects.toMatchObject({
      failure: { kind: "refusal", code: "terminal-target" },
    })
  })

  it("refuses to carry an approval superseded by the effective exact-current rejection", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "issue/rejected-recut", headSha: HEAD_1, baseSha: BASE, draft: true })
    await app.bays.review({ pr: "PR1", by: "@cto", decision: "approve", ref: "approved-r1" })
    await app.bays.review({ pr: "PR1", by: "@cto", decision: "reject", ref: "rejected-r1" })
    const beforeEvents = await Array.fromAsync(app.events())

    await expect(
      app.bays.recut({
        pr: "PR1",
        fromRevision: 1,
        headSha: HEAD_2,
        baseSha: "b".repeat(40),
        treeSha: "c".repeat(40),
        patchId: "d".repeat(40),
        reviewCarried: true,
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "review-carry-invalid" } })
    expect(await Array.fromAsync(app.events())).toEqual(beforeEvents)
    expect(app.bays.pr("PR1")?.revs).toHaveLength(1)
  })

  it("refuses replay when a recut carries an approval superseded by an exact-current rejection", async () => {
    const nextId = ids()
    const seededCommand = { id: nextId(), op: "fixture.recut-rejected-review" }
    const at = "2026-01-01T00:00:00.000Z"
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: at,
            data: {
              pr: "PR1",
              branch: "issue/rejected-recut",
              base: "main",
              headSha: HEAD_1,
              baseSha: BASE,
              revision: 1,
            },
          },
          {
            id: nextId(),
            name: "pr/reviewed",
            ts: at,
            data: {
              pr: "PR1",
              revision: 1,
              headSha: HEAD_1,
              [["act", "or"].join("")]: "@cto",
              decision: "approve",
              ref: "approved-r1",
            },
          },
          {
            id: nextId(),
            name: "pr/reviewed",
            ts: at,
            data: { pr: "PR1", revision: 1, headSha: HEAD_1, by: "@cto", decision: "reject", ref: "rejected-r1" },
          },
          {
            id: nextId(),
            name: "pr/recut",
            ts: at,
            data: {
              pr: "PR1",
              fromRevision: 1,
              patchId: "d".repeat(40),
              baseSha: "b".repeat(40),
              treeSha: "c".repeat(40),
              reviewCarried: true,
              predecessor: { revision: 1, headSha: HEAD_1, baseSha: BASE },
              successor: { revision: 2, headSha: HEAD_2, baseSha: "b".repeat(40) },
            },
          },
        ],
      },
    ])
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    )

    await expect(createYrd(definition, { inject: { journal, clock: () => at, id: nextId } })).rejects.toThrow(
      "rebuild carries a missing approval",
    )
  })

  it("atomically records admitted-to-refreshed recuts without overwriting a newer authored revision", async () => {
    await using app = (await createHarness()).app
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)

    await app.bays.submit({ branch: "issue/queue-refresh", headSha: HEAD_1, baseSha: BASE, draft: true })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE })
    const refresh = {
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: nextBase,
      treeSha,
      patchId,
      reviewCarried: false,
      expectedCurrent: { revision: 1, headSha: HEAD_1 },
      transition: { from: "admitted", to: "refreshed" },
    } as unknown as Parameters<typeof app.bays.recut>[0]

    const recorded = await app.bays.recut(refresh)
    expect(recorded.events).toContainEqual(
      expect.objectContaining({
        name: "pr/recut",
        data: expect.objectContaining({ transition: { from: "admitted", to: "refreshed" } }),
      }),
    )
    const refreshed = app.bays.pr("PR1")!
    expect(currentChangeRev(refreshed).recut).toMatchObject({
      fromRevision: 1,
      patchId,
      transition: { from: "admitted", to: "refreshed" },
    })
    expect(changeDeliveryState(refreshed)).toBe("submitted")
    expect(currentChangeRev(refreshed)).toMatchObject({ n: 2, head: HEAD_2 })
    expect(app.bays.checksRequested("PR1")).toBe(true)
    expect(recorded.events.map(({ name }) => name)).toEqual(["pr/recut", "pr/submitted", "pr/checks-requested"])
    // A crash-retry of the exact result is idempotent even though its expected
    // predecessor is no longer current.
    expect((await app.bays.recut(refresh)).events).toEqual([])
    await expect(
      app.bays.recut({
        ...refresh,
        fromRevision: 2,
        headSha: "6".repeat(40),
        expectedCurrent: { revision: 2, headSha: HEAD_2 },
        patchId: "e".repeat(40),
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "recut-patch-drift" } })
    expect(app.bays.pr("PR1")?.revs).toHaveLength(2)

    await app.bays.submit({ branch: "issue/queue-refresh-race", headSha: "3".repeat(40), baseSha: BASE, draft: true })
    await app.bays.ready({ pr: "PR2" })
    await app.bays.requestChecks({ pr: "PR2", baseSha: BASE })
    await app.bays.intake({
      branch: "issue/queue-refresh-race",
      headSha: "4".repeat(40),
      base: "main",
      baseSha: nextBase,
    })
    const staleRefresh = {
      pr: "PR2",
      fromRevision: 1,
      headSha: "5".repeat(40),
      baseSha: nextBase,
      treeSha,
      patchId,
      reviewCarried: false,
      expectedCurrent: { revision: 1, headSha: "3".repeat(40) },
      transition: { from: "admitted", to: "refreshed" },
    } as unknown as Parameters<typeof app.bays.recut>[0]

    await expect(app.bays.recut(staleRefresh)).rejects.toMatchObject({
      failure: { kind: "refusal", code: "recut-current-changed" },
    })
    const authored = app.bays.pr("PR2")!
    expect(changeDeliveryState(authored)).toBe("pushed")
    expect(currentChangeRev(authored)).toMatchObject({ n: 2, head: "4".repeat(40) })
    expect(authored.revs).toMatchObject([{ n: 1 }, { n: 2 }])
  })

  it("guards observed tracking intent on intake and its revision-bound settlement comment", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/tracked-race", headSha: HEAD_1, baseSha: BASE, draft: true })
    await app.bays.editPr({ pr: "PR1", track: true })
    const expectedCurrent = { pr: "PR1", revision: 1, headSha: HEAD_1, track: true }
    await app.bays.editPr({ pr: "PR1", track: false })

    await expect(
      app.bays.intake({
        branch: "issue/tracked-race",
        headSha: HEAD_2,
        expectedCurrent,
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "intake-current-changed" } })
    await expect(
      app.bays.comment({
        pr: "PR1",
        by: "yrd-cli",
        note: "operator decision required",
        ref: `yrd:track-preflight-needs-person:PR1:1:${HEAD_1}`,
        expectedCurrent,
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "comment-current-changed" } })
    await expect(app.bays.submit({ pr: "PR1", expectedCurrent })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "submit-current-changed" },
    })
    await expect(app.bays.ready({ pr: "PR1", expectedCurrent })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "ready-current-changed" },
    })
    await expect(app.bays.requestChecks({ pr: "PR1", expectedCurrent })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "request-checks-current-changed" },
    })

    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 1, head: HEAD_1 })
    expect(app.bays.pr("PR1")?.comments).toEqual([])

    await app.bays.submit({ branch: "issue/tracked-close-race", headSha: HEAD_2, baseSha: BASE, draft: true })
    await app.bays.editPr({ pr: "PR2", track: true })
    const closedExpectedCurrent = { pr: "PR2", revision: 1, headSha: HEAD_2, track: true }
    await app.bays.closePr({ pr: "PR2" })
    await expect(
      app.bays.comment({
        pr: "PR2",
        by: "yrd-cli",
        note: "operator decision required",
        ref: `yrd:track-preflight-needs-person:PR2:1:${HEAD_2}`,
        expectedCurrent: closedExpectedCurrent,
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "comment-current-changed" } })
    expect(app.bays.pr("PR2")?.comments).toEqual([])
  })

  it("refuses to record tracking on a terminal change but stays idempotent on its effective bit", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/track-terminal", headSha: HEAD_1, baseSha: BASE, draft: true })
    await app.bays.editPr({ pr: "PR1", track: false })
    await app.bays.closePr({ pr: "PR1" })

    // Changing the bit on a terminal change would record something nothing
    // will ever read; the submit path warns and skips, the direct edit refuses.
    await expect(app.bays.editPr({ pr: "PR1", track: true })).rejects.toMatchObject({
      failure: { kind: "refusal", code: "track-terminal" },
    })
    // Restating the recorded value is a no-op, never a refusal, so an
    // idempotent resubmit script can replay its own edit after the close.
    expect((await app.bays.editPr({ pr: "PR1", track: false })).events).toEqual([])
    // Metadata edits that do not touch tracking still land on a terminal change.
    await app.bays.editPr({ pr: "PR1", title: "feat(bay): terminal title edit" })
    expect(app.bays.pr("PR1")?.title).toBe("feat(bay): terminal title edit")
    expect(isTracked(app.bays.pr("PR1")!)).toBe(false)
  })

  it("settles a refresh-superseded recut revision without minting an empty successor (22528)", async () => {
    await using app = (await createHarness()).app
    const nextBase = "b".repeat(40)
    const baseTreeSha = "c".repeat(40)
    const patchId = "d".repeat(40)

    await app.bays.submit({ branch: "issue/refresh-superseded", headSha: HEAD_1, baseSha: BASE, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: BASE,
      treeSha: "e".repeat(40),
      patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE })

    await expect(
      app.bays.settleSuperseded({
        pr: "PR1",
        revision: 2,
        headSha: HEAD_2,
        baseSha: nextBase,
        baseTreeSha,
        patchId: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "recut-patch-drift" } })

    const settled = await app.bays.settleSuperseded({
      pr: "PR1",
      revision: 2,
      headSha: HEAD_2,
      baseSha: nextBase,
      baseTreeSha,
      patchId,
    })
    expect(settled.events).toEqual([
      expect.objectContaining({
        name: "pr/already-landed",
        data: expect.objectContaining({
          pr: "PR1",
          revision: 2,
          headSha: HEAD_2,
          baseSha: nextBase,
          candidateSha: nextBase,
          candidateTreeSha: baseTreeSha,
          baseTreeSha,
          settlement: {
            kind: "refresh-superseded",
            proof: "payload-already-contained",
            patchId,
          },
        }),
      }),
    ])
    const pr = app.bays.pr("PR1")!
    expect(changeDeliveryState(pr)).toBe("already-landed")
    expect(currentChangeRev(pr)).toMatchObject({
      n: 2,
      head: HEAD_2,
      terminal: { kind: "already-landed" },
    })
    expect(pr.revs).toHaveLength(2)
    expect(pr.terminalRun).toBeUndefined()
    expect(pr.alreadyLanded).toMatchObject({
      baseSha: nextBase,
      candidateSha: nextBase,
      candidateTreeSha: baseTreeSha,
      baseTreeSha,
      settlement: { kind: "refresh-superseded", proof: "payload-already-contained", patchId },
    })
  })

  it("retires the current recut proof when a new authored head starts another revision", async () => {
    await using app = (await createHarness()).app
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)

    await app.bays.submit({
      branch: "issue/recut-then-author",
      headSha: HEAD_1,
      baseSha: BASE,
      draft: true,
    })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: BASE,
      treeSha,
      patchId,
      reviewCarried: false,
    })

    await app.bays.intake({
      branch: "issue/recut-then-author",
      headSha: "3".repeat(40),
      base: "main",
      baseSha: BASE,
    })

    const pr = app.bays.pr("PR1")
    expect(changeFacts(pr)).toMatchObject({
      current: { n: 3, head: "3".repeat(40) },
      revs: [
        { n: 1, head: HEAD_1 },
        { n: 2, head: HEAD_2, recut: { fromRevision: 1, treeSha, patchId } },
        { n: 3, head: "3".repeat(40) },
      ],
    })
    expect(pr === undefined ? undefined : currentChangeRev(pr).recut).toBeUndefined()
    expect(pr?.revs[2]?.recut).toBeUndefined()
  })

  it("keeps the selected immutable revision props when recutting an older payload", async () => {
    await using app = (await createHarness()).app
    const sourceProps = { request: "source" }
    const currentProps = { request: "current" }
    await app.bays.submit({
      branch: "issue/recut-source",
      headSha: HEAD_1,
      props: sourceProps,
      draft: true,
    })
    await app.bays.intake({ branch: "issue/recut-source", headSha: HEAD_2, base: "main" })
    await app.bays.submit({ pr: "PR1", props: currentProps })

    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: "3".repeat(40),
      baseSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })

    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      current: { n: 3, props: sourceProps },
      revs: [
        { n: 1, props: sourceProps },
        { n: 2, props: currentProps },
        { n: 3, props: sourceProps, recut: { fromRevision: 1 } },
      ],
    })

    await app.bays.submit({ branch: "issue/recut-uncorrelated", headSha: "4".repeat(40), draft: true })
    await app.bays.intake({ branch: "issue/recut-uncorrelated", headSha: "5".repeat(40), base: "main" })
    await app.bays.submit({ pr: "PR2", props: currentProps })
    await app.bays.recut({
      pr: "PR2",
      fromRevision: 1,
      headSha: "6".repeat(40),
      baseSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })
    expect(changeFacts(app.bays.pr("PR2")).current.props).toBeUndefined()
    expect(app.bays.pr("PR2")?.revs[2]?.props).toBeUndefined()
  })

  it("refuses to append check requests to terminal change history", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "issue/terminal-checks", headSha: HEAD_1 })
    await app.bays.closePr({ pr: "PR1" })

    await expect(app.bays.requestChecks({ pr: "PR1", baseSha: BASE })).rejects.toThrow(
      "change 'PR1' is withdrawn, not checkable",
    )
  })

  it("journals normalized source compositions and rejects ambiguous payload paths", async () => {
    const { app } = await createHarness()
    await app.bays.intake({
      branch: "issue/composed",
      headSha: HEAD_1,
      composition: {
        version: 1,
        sources: [
          {
            repo: "vendor/example",
            branch: "issue/source",
            baseSha: "2".repeat(40),
            tipSha: "3".repeat(40),
            payload: ["src/z.ts", "src/a.ts"],
          },
        ],
      },
    })

    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      current: {
        composition: {
          version: 1,
          sources: [{ repo: "vendor/example", payload: ["src/a.ts", "src/z.ts"] }],
        },
      },
      revs: [
        {
          composition: {
            version: 1,
            sources: [{ repo: "vendor/example", payload: ["src/a.ts", "src/z.ts"] }],
          },
        },
      ],
    })
    await expect(
      app.bays.intake({
        branch: "issue/invalid",
        headSha: HEAD_2,
        composition: {
          version: 1,
          sources: [
            {
              repo: "../escape",
              branch: "issue/source",
              baseSha: "2".repeat(40),
              tipSha: "3".repeat(40),
              payload: ["src/a.ts", "src/a.ts"],
            },
          ],
        },
      }),
    ).rejects.toThrow("normalized repository-relative Git path")
    await app.close()
  })

  it("preserves an existing recorded composition when resubmitting a selection", async () => {
    const { app } = await createHarness()
    await app.bays.intake({
      branch: "issue/composed",
      headSha: HEAD_1,
      composition: {
        version: 1,
        sources: [
          {
            repo: "vendor/example",
            branch: "issue/source",
            baseSha: "2".repeat(40),
            tipSha: "3".repeat(40),
            payload: ["src/a.ts", "src/z.ts"],
          },
        ],
      },
    })
    const original = app.bays.pr("PR1")
    const originalComposition = original === undefined ? undefined : currentChangeRev(original).composition

    const omittedRepeat = record(await app.bays.submitSelection("issue/composed", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
    }))

    expect(changeFacts(omittedRepeat)).toMatchObject({ current: { n: 1, composition: originalComposition } })
    expect(app.bays.pr("PR1")?.revs).toHaveLength(1)
    await app.close()
  })

  it("closes a direct bayless PR so it leaves live selection while history remains", async () => {
    const { app, workspace } = await createHarness()

    // Direct (bayless) submission — the superseded-PR shape with no Bay to close.
    await app.bays.submit({ branch: "issue/chief-state-20979-r1", headSha: HEAD_1 })
    const live = app.bays.pr("PR1")
    expect(changeFacts(live)).toMatchObject({ id: "PR1", state: "open", merged: false, delivery: "submitted" })
    expect(live?.bay).toBeUndefined()

    // PR-native close requires no Bay.
    await app.bays.closePr({ pr: "PR1" })
    const closed = app.bays.pr("PR1")
    // Closed and unmerged is exactly the GitHub shape Queue selection excludes.
    expect(changeFacts(closed)).toMatchObject({ id: "PR1", state: "closed", merged: false, delivery: "withdrawn" })
    expect(closed?.withdrawnAt).toBe("2026-01-01T00:00:00.000Z")
    // History remains: the change still resolves and keeps its revision trail.
    expect(closed?.revs).toHaveLength(1)
    // A pure state transition — no bay/workspace job runs.
    expect(workspace.calls).toEqual([])

    await app.close()
  })

  it("refuses to close a terminal or unknown PR, and closes a bay-backed PR", async () => {
    const { app } = await createHarness()

    // A rejected/submitted direct PR is still live (pollutes selection) and can be closed.
    await app.bays.submit({ branch: "issue/superseded", headSha: HEAD_1 })
    await app.bays.closePr({ pr: "PR1" })
    // Already withdrawn (terminal) — refuse loudly, never a silent no-op.
    await expect(app.bays.closePr({ pr: "PR1" })).rejects.toThrow("change 'PR1' is withdrawn")
    // Unknown selector — refuse.
    await expect(app.bays.closePr({ pr: "PR404" })).rejects.toThrow("no change 'PR404'")

    // The same verb resolves a bay-backed PR by its branch spelling.
    await app.bays.submit({ branch: "issue/other", headSha: HEAD_2 })
    await app.bays.closePr({ pr: "issue/other" })
    expect(changeFacts(app.bays.pr("PR2"))).toMatchObject({ state: "closed", merged: false, delivery: "withdrawn" })

    await app.close()
  })

  it("owns the complete bay and direct-branch submission flow", async () => {
    const { app, workspace } = await createHarness()
    await finishJob(app, await app.bays.open({ name: "domain-submit", by: "test" }))
    const resolved: string[] = []
    const resolveRevision = async (ref: string): Promise<string | undefined> => {
      resolved.push(ref)
      return ref === "release/fix" ? HEAD_1 : undefined
    }

    const bayPR = record(await app.bays.submitSelection("B1", {
      resolveRevision,
      resolveParents: async () => ["0".repeat(40)],
      run: runtime,
    }))
    expect(changeFacts(bayPR)).toMatchObject({
      bay: "B1",
      delivery: "submitted",
      current: { head: HEAD_2 },
      base: "main",
    })
    expect(workspace.calls).toEqual([`provision:B1:current`, "refresh:B1"])

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
    expect(app.bays.state().submits["release/fix"]).toMatchObject({ sha: HEAD_1, base: "release/2.0" })
    expect(resolved).toEqual(["release/fix"])
    // Dirty-worktree submit is a D3 door disposition covered by its own test in
    // "submit ledger-write door dispositions" (warn + committed-head submit).
    await app.close()
  })

  it("reuses one live change when another branch spelling resolves to the same payload", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const { app } = await createHarness(log)
    await app.bays.intake({ branch: "issue/feature", base: "main", headSha: HEAD_1, baseSha: BASE })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ branch: "issue/feature", delivery: "pushed" })

    const options = {
      base: "main",
      resolveRevision: async (ref: string) => (ref === "origin/issue/feature" ? HEAD_1 : undefined),
      run: runtime,
    }
    const submitted = record(await app.bays.submitSelection("PR1", options))
    const repeated = record(await app.bays.submitSelection("origin/issue/feature", options))

    expect(changeFacts(submitted)).toMatchObject({ id: "PR1", branch: "issue/feature", delivery: "submitted" })
    expect(changeFacts(repeated)).toMatchObject({ id: "PR1", delivery: "submitted" })
    expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
    expect(
      events.filter(
        (event) => event.kind === "log" && event.namespace === "yrd:bay:submit" && event.props?.outcome === "succeeded",
      ),
    ).toHaveLength(2)
    await app.close()
    log.end()
  })

  it("requires durable Jobs before Bay composition in TypeScript", () => {
    const { adapter } = createWorkspaceHarness()
    const jobs = createBayJobDefs(adapter)
    const invalid = () => {
      // @ts-expect-error Bay workspaces require the explicit Jobs capability.
      return withBays({ prNumberMint: volatilePrNumberMint(), jobs })(createYrdDef())
    }
    void invalid
  })

  it("sets and mutably re-edits a change title and description via editPr", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "topic/metadata", headSha: HEAD_1 })

    await app.bays.editPr({
      pr: "PR1",
      title: "feat(bay): add pr metadata",
      description: "Adds a durable title and description to the change record.",
    })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      title: "feat(bay): add pr metadata",
      description: "Adds a durable title and description to the change record.",
      delivery: "submitted",
    })

    // Unlike the immutable issue join, title and description are editable metadata.
    await app.bays.editPr({ pr: "PR1", title: "feat(bay): pr title + description" })
    expect(app.bays.pr("PR1")).toMatchObject({
      title: "feat(bay): pr title + description",
      description: "Adds a durable title and description to the change record.",
    })

    // A no-op edit (unchanged values) emits nothing.
    expect((await app.bays.editPr({ pr: "PR1", title: "feat(bay): pr title + description" })).events).toEqual([])
  })

  it("binds a title and description at submit through submitSelection options", async () => {
    await using app = (await createHarness()).app
    // Metadata binds to change RECORDS. Seed the record first (the record
    // lane still writes through explicit submit until S7), then resubmit
    // through submitSelection with the metadata options.
    await app.bays.submit({ branch: "topic/submit-metadata", headSha: HEAD_1, draft: true })
    const submitted = record(await app.bays.submitSelection("topic/submit-metadata", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
      base: "main",
      title: "fix(queue): scope superseded runs",
      description: "Scopes superseded-revision runs in the watch detail pane.",
    }))
    expect(changeFacts(submitted)).toMatchObject({
      delivery: "submitted",
      title: "fix(queue): scope superseded runs",
      description: "Scopes superseded-revision runs in the watch detail pane.",
    })
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
    expect(app.bays.state().submits["topic/derived-metadata"]).toMatchObject({ sha: HEAD_1 })
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

  it("stage stops where draft stops on a record path: the staging pass never runs the real submit", async () => {
    await using app = (await createHarness()).app
    // The CLI's pre-submit staging pass sends stage:true through the same
    // selection. On a pushed record that pass once fell through to the real
    // submit — mutating delivery state BEFORE gates ran (the PR1128 window).
    await app.bays.submit({ branch: "topic/staged", headSha: HEAD_1, draft: true })
    const staged = record(await app.bays.submitSelection("topic/staged", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
      base: "main",
      stage: true,
    }))
    expect(changeFacts(staged)).toMatchObject({ delivery: "pushed", current: { n: 1, head: HEAD_1 } })
    expect(changeFacts(app.bays.pr("topic/staged"))).toMatchObject({ delivery: "pushed" })
  })

  it("carries title and description forward across a resubmitted revision", async () => {
    await using app = (await createHarness()).app
    // Seed the record (record lane), then exercise the record resubmit path.
    await app.bays.submit({ branch: "topic/carry-forward", headSha: HEAD_1, draft: true })
    let tip = HEAD_1
    const submit = (extra: Record<string, unknown> = {}) =>
      app.bays.submitSelection("topic/carry-forward", {
        resolveRevision: async () => tip,
        run: runtime,
        base: "main",
        ...extra,
      })

    await submit({ title: "feat: carried title", description: "Carried description body." })
    tip = HEAD_2
    const resubmitted = record(await submit())
    expect(changeFacts(resubmitted)).toMatchObject({
      current: { n: 2, head: HEAD_2 },
      title: "feat: carried title",
      description: "Carried description body.",
    })
  })

  it("carries title and description forward across a mechanical recut", async () => {
    await using app = (await createHarness()).app
    const nextBase = "b".repeat(40)
    await app.bays.submit({ branch: "issue/recut-metadata", headSha: HEAD_1, baseSha: BASE, draft: true })
    await app.bays.editPr({
      pr: "PR1",
      issue: "@km/all/21091-issue",
      title: "feat: recut carries metadata",
      description: "Recut must not drop the authored title or description.",
    })

    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD_2,
      baseSha: nextBase,
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      current: { n: 2, head: HEAD_2 },
      issue: "@km/all/21091-issue",
      title: "feat: recut carries metadata",
      description: "Recut must not drop the authored title or description.",
    })
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

    // A closed Bay owns no workspace and left no record here: its branch is a
    // plain branch, and a plain branch submits as a derived member.
    await expect(
      app.bays.submitSelection(branch, { ...directOptions(HEAD_2), draft: true }),
    ).rejects.toMatchObject({ failure: { kind: "refusal", code: "record-mint-retired" } })

    const submitted = await app.bays.submitSelection(branch, directOptions(HEAD_2))
    expect(submitted).toMatchObject({ lane: "derived", branch, sha: HEAD_2 })
    expect(app.bays.state().submits[branch]).toMatchObject({ sha: HEAD_2 })
  })

  it("D2 retired: a withdrawn branch's resubmit re-enters through the derived lane; the record stays withdrawn", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "topic/redeliver", headSha: HEAD_1 })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
      id: "PR1",
      branch: "topic/redeliver",
      delivery: "submitted",
      current: { n: 1, head: HEAD_1 },
    })

    await app.bays.closePr({ pr: "PR1", reason: "pulled back" })
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "withdrawn" })

    // The reopen door retired with the legacy mint: resubmitting the branch
    // writes the submit fact and the queue composes it as a derived member
    // (Q1 re-entry). The withdrawn record keeps its frozen history — direct
    // branches derive identity from content now, not from record continuity.
    const reentered = await app.bays.submitSelection("topic/redeliver", directOptions(HEAD_2))
    expect(reentered).toMatchObject({ lane: "derived", branch: "topic/redeliver", sha: HEAD_2 })
    expect(app.bays.state().submits["topic/redeliver"]).toMatchObject({ sha: HEAD_2 })
    expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
    expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "withdrawn", current: { n: 1, head: HEAD_1 } })
    expect(app.bays.pr("PR1")?.withdrawnAt).toBeTypeOf("string")
  })

  it("Q1: resubmitting a merged branch at the SAME head is an 'already merged' no-op, not a refusal or a new revision", async () => {
    const nextId = ids()
    const at = "2026-01-01T00:00:00.000Z"
    const seededCommand = { id: nextId(), op: "fixture.integrated" }
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: at,
            data: { pr: "PR1", branch: "topic/merged", base: "main", headSha: HEAD_1, baseSha: BASE, revision: 1 },
          },
          { id: nextId(), name: "pr/submitted", ts: at, data: { pr: "PR1", revision: 1, headSha: HEAD_1 } },
          {
            id: nextId(),
            name: "pr/integrated",
            ts: at,
            data: { pr: "PR1", revision: 1, headSha: HEAD_1, run: "R1", commit: BASE, landingSha: BASE, baseSha: BASE },
          },
        ],
      },
    ])
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
    )
    await using app = await createYrd(definition, { inject: { journal, clock: () => at, id: nextId } })

    const before = await Array.fromAsync(app.events())
    // Same merged head → returns the frozen integrated change (with its merge SHA),
    // no throw, no new PR, no new revision, no journal event.
    const already = record(await app.bays.submitSelection("topic/merged", directOptions(HEAD_1)))
    expect(changeFacts(already)).toMatchObject({
      id: "PR1",
      delivery: "integrated",
      current: { head: HEAD_1 },
      integration: { commit: BASE },
    })
    expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it("D3: a dirty worktree submit warns in the result envelope AND the log, and records the committed head", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const { app, workspace } = await createHarness(log)
    await finishJob(app, await app.bays.open({ name: "dirty", by: "test" }))
    workspace.dirty = true

    const warnings: string[] = []
    const pr = record(await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      resolveParents: async () => ["0".repeat(40)],
      run: runtime,
      warnings,
    }))
    // Submitted the committed head (HEAD_2 from refresh), never refused.
    expect(changeFacts(pr)).toMatchObject({ bay: "B1", delivery: "submitted", current: { head: HEAD_2 } })
    // Loud by construction: the caveat rides the result envelope (warnings array)…
    expect(warnings).toHaveLength(1)
    // …AND the structured log stream.
    expect(events.some((event) => event.kind === "log" && event.props?.action === "submit-dirty-worktree")).toBe(true)
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
  // content dedupe is the queue's job at compose. The record-lane dedupe
  // survives only inside the explicit `submit` command, which still writes
  // records until S7 deletes the store.
  describe("withdrawn payload re-enters through the derived lane", () => {
    it("the identical head re-enters on a NEW branch — the spent-payload refusal is retired", async () => {
      await using app = (await createHarness()).app
      await app.bays.submit({ branch: "topic/burned", headSha: HEAD_1 })
      await app.bays.closePr({ pr: "PR1", reason: "withdrawn by mistake" })
      expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "withdrawn" })

      // The bead's specimen: the identical head, offered on a NEW branch.
      // Pre-purge this refused ("payload already recorded"); now the record
      // lane no longer owns direct branches, so it composes as derived.
      const reentered = await app.bays.submitSelection("topic/rebuilt", directOptions(HEAD_1))
      expect(reentered).toMatchObject({ lane: "derived", branch: "topic/rebuilt", sha: HEAD_1 })
      expect(app.bays.state().submits["topic/rebuilt"]).toMatchObject({ sha: HEAD_1 })
      expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
    })

    it("resubmitting the withdrawn branch itself re-enters the same content as a derived member", async () => {
      await using app = (await createHarness()).app
      await app.bays.submit({ branch: "topic/burned", headSha: HEAD_1 })
      await app.bays.closePr({ pr: "PR1", reason: "withdrawn by mistake" })

      // Same branch, same head: withdrawal withdrew the RECORD; resubmitting
      // the content runs it again. Re-entry composes fresh — no reopen, the
      // record keeps its withdrawn history.
      const reentered = await app.bays.submitSelection("topic/burned", directOptions(HEAD_1))
      expect(reentered).toMatchObject({ lane: "derived", branch: "topic/burned", sha: HEAD_1 })
      expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({
        delivery: "withdrawn",
        current: { n: 1, head: HEAD_1 },
      })
      expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
    })

    it("keeps the bare refusal for a LIVE collision inside the record-lane submit command", async () => {
      await using app = (await createHarness()).app
      await app.bays.submit({ branch: "topic/live", headSha: HEAD_1, base: "main", baseSha: BASE })
      expect(changeFacts(app.bays.pr("PR1"))).toMatchObject({ delivery: "submitted" })

      // The explicit `submit` command still writes records, so IT still owns
      // the payload-dedupe refusal for its own lane. A live change is not
      // reopenable; printing a reopen command here would be a wrong
      // instruction, so the refusal carries none.
      const refused = await app.bays
        .submit({ branch: "topic/other", headSha: HEAD_1, base: "main", baseSha: BASE })
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message)

      expect(refused).toContain("payload already recorded as change 'PR1'")
      expect(refused).not.toContain("yrd pr submit")
      expect(refused).not.toContain("withdrawn")
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
    const app = await createApp(harness.adapter, undefined, undefined, resolveBase)
    return { app, liveSha }
  }

  it("accepts a managed bay whose recorded base still names the live queue after the stored pin ages", async () => {
    const liveSha = { current: BASE }
    const { app } = await createPinnedApp(liveSha)
    await finishJob(app, await app.bays.open({ name: "b160", base: "main", baseSha: BASE, by: "test" }))
    expect(app.bays.get("B1")).toMatchObject({ base: "main", baseSha: BASE })

    liveSha.current = LIVE
    const created = record(await app.bays.submitSelection("B1", {
      resolveRevision: async () => HEAD_1,
      resolveParents: async () => ["0".repeat(40)],
      run: runtime,
      draft: true,
    }))
    expect(changeFacts(created)).toMatchObject({
      delivery: "pushed",
      base: "main",
    })
    expect(created.revs[0]?.baseSha).toBe(LIVE)
    await app.close()
  })

  it("honours explicit --base instead of silently replacing it with the bay pin", async () => {
    const liveSha = { current: BASE }
    const { app } = await createPinnedApp(liveSha)
    await finishJob(app, await app.bays.open({ name: "b159", base: "main", baseSha: BASE, by: "test" }))
    liveSha.current = LIVE

    const created = record(await app.bays.submitSelection("B1", {
      resolveRevision: async () => HEAD_1,
      resolveParents: async () => ["0".repeat(40)],
      run: runtime,
      base: "main",
      draft: true,
    }))
    expect(created.revs[0]?.baseSha).toBe(LIVE)
    expect(created.revs[0]?.baseSha).not.toBe(STALE)
    await app.close()
  })

  it("refuses an explicit pin that contradicts the live queue, naming both authorities", async () => {
    const liveSha = { current: BASE }
    const { app } = await createPinnedApp(liveSha)
    await finishJob(app, await app.bays.open({ name: "conflict", base: "main", baseSha: BASE, by: "test" }))
    liveSha.current = LIVE
    await expect(app.bays.intake({ bay: "B1", headSha: HEAD_1, baseSha: STALE })).rejects.toMatchObject({
      failure: {
        code: "base-authority-conflict",
        message: expect.stringMatching(/555555555555.*cccccccccccc/),
      },
    })
    await app.close()
  })

  it("exposes one effective-base SHA that matches pr create after the stored pin ages", async () => {
    const liveSha = { current: BASE }
    const { app } = await createPinnedApp(liveSha)
    await finishJob(app, await app.bays.open({ name: "effective", base: "main", baseSha: BASE, by: "test" }))
    liveSha.current = LIVE
    const shown = await app.bays.effectiveBase("B1")
    const created = record(await app.bays.submitSelection("B1", {
      resolveRevision: async () => HEAD_1,
      resolveParents: async () => ["0".repeat(40)],
      run: runtime,
      draft: true,
    }))
    expect(shown).toEqual({ base: "main", baseSha: LIVE })
    expect(created.revs[0]?.baseSha).toBe(shown.baseSha)
    expect(shown.baseSha).not.toBe(app.bays.get("B1")?.baseSha)
    await app.close()
  })
})
