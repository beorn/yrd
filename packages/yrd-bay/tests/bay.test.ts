/**
 * @failure Bay and PR lifecycle state diverges from durable Jobs or accepts invalid transitions.
 * @level l2
 * @consumer @yrd/bay
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
} from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import {
  GitShaSchema,
  resolveBase,
  type DeprovisionedBay,
  type ProvisionedBay,
  type RefreshedBay,
} from "../src/model.ts"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

async function createApp(workspace: BayWorkspace, log?: ConditionalLogger, defaultActor?: string) {
  const jobs = createBayJobDefs(workspace)
  const definition = pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({ jobs, defaultBase: "main", ...(defaultActor === undefined ? {} : { defaultActor }) }),
  )
  return createYrd(definition, {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-01-01T00:00:00.000Z",
      id: ids(),
      ...(log === undefined ? {} : { log }),
    },
  })
}

function createWorkspaceHarness() {
  const workspace = { calls: [] as string[], dirty: false }
  const adapter: BayWorkspace = {
    revision: "test-workspace-v1",
    provision(input): JobResult<ProvisionedBay> {
      workspace.calls.push(`provision:${input.bay}:${input.baseSha ?? "current"}`)
      return { status: "passed", output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE } }
    },
    refresh(input): JobResult<RefreshedBay> {
      workspace.calls.push(`refresh:${input.bay}`)
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_2, baseSha: BASE, dirty: workspace.dirty },
      }
    },
    deprovision(input): JobResult<DeprovisionedBay> {
      workspace.calls.push(`deprovision:${input.bay}`)
      return workspace.dirty
        ? { status: "failed", error: { code: "dirty-worktree", message: "workspace has uncommitted work" } }
        : { status: "passed", output: { preservedRef: `refs/yrd/closed/${input.bay}` } }
    },
  }
  return { adapter, workspace }
}

async function createHarness(log?: ConditionalLogger) {
  const harness = createWorkspaceHarness()
  return { ...harness, app: await createApp(harness.adapter, log) }
}

type TestApp = Awaited<ReturnType<typeof createApp>>

describe("GitShaSchema", () => {
  it("accepts only native SHA-1 and SHA-256 object widths", () => {
    expect(GitShaSchema.safeParse("a".repeat(40)).success).toBe(true)
    expect(GitShaSchema.safeParse("b".repeat(64)).success).toBe(true)
    expect(GitShaSchema.safeParse("c".repeat(39)).success).toBe(false)
    expect(GitShaSchema.safeParse("d".repeat(48)).success).toBe(false)
    expect(GitShaSchema.safeParse("e".repeat(65)).success).toBe(false)
  })
})

async function finishJob(app: TestApp, result: CommandResult): Promise<void> {
  const id = app.jobs.requested(result)[0]
  if (id === undefined) throw new Error("expected one Bay workspace job")
  await app.jobs.run(id, { runner: "local", leaseMs: 60_000 })
}

describe("withBays", () => {
  it("records the submitting actor on strict current revision facts", async () => {
    await using app = await createApp(createWorkspaceHarness().adapter, undefined, "@agent/7")

    const submitted = await app.bays.submit({ branch: "topic/owned", headSha: HEAD_1 })

    expect(submitted.events.map(({ name, data }) => ({ name, data }))).toEqual([
      expect.objectContaining({ name: "pr/pushed", data: expect.objectContaining({ actor: "@agent/7" }) }),
      expect.objectContaining({ name: "pr/submitted", data: expect.objectContaining({ actor: "@agent/7" }) }),
    ])
    expect(app.bays.pr("PR1")?.revisions).toEqual([
      expect.objectContaining({ revision: 1, headSha: HEAD_1, actor: "@agent/7" }),
    ])
  })

  it("resolves Bay, PR, and base selectors without changing canonical identity", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "Topic/One", headSha: HEAD_1 })

    expect(app.bays.pr("pr1")).toMatchObject({ id: "PR1", branch: "Topic/One" })
    expect(app.bays.pr("topic/one")).toMatchObject({ id: "PR1", branch: "Topic/One" })

    const opened = await app.bays.open({ name: "Case-Bay" })
    await finishJob(app, opened)
    expect(app.bays.get("case-bay")).toMatchObject({ id: "B1", name: "Case-Bay" })

    expect(app.bays.pr("PR1")).toMatchObject({ id: "PR1" })

    expect(resolveBase(["main"], "ORIGIN/MAIN")).toBe("main")
    expect(resolveBase(["Main", "main"], "Main")).toBe("Main")
    expect(() => resolveBase(["Main", "main"], "MAIN")).toThrow("yrd: base selector 'MAIN' is ambiguous: Main, main")
  })

  it("journals an exact revision-bound issue join when a PR is withdrawn", async () => {
    await using app = (await createHarness()).app
    const issueRef = "@km/all/21063-steering-laser"
    const correlation = { namespace: "tribe-request", id: "21091-withdrawn" }
    await app.bays.submit({
      branch: "topic/mentions-2106-but-not-the-issue",
      headSha: HEAD_1,
      issue: issueRef,
      correlation,
    })

    const retired = await app.bays.closePr({ pr: "PR1" })

    expect(retired.events).toContainEqual(
      expect.objectContaining({
        name: "pr/withdrawn",
        data: { pr: "PR1", revision: 1, headSha: HEAD_1, issueRef, correlation, actor: "operator" },
      }),
    )
  })

  it("attaches one issue to a live PR and refuses to rehome its materialized join", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "topic/attach-once", headSha: HEAD_1 })

    await app.bays.editPr({ pr: "PR1", issue: "@km/all/21091-original" })
    expect(app.bays.pr("PR1")).toMatchObject({ issue: "@km/all/21091-original", status: "submitted" })

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
    expect(app.bays.pr("PR1")).toMatchObject({
      issue: "@km/all/21091-original",
      revision: 1,
      headSha: HEAD_1,
      status: "submitted",
    })
  })

  it("preserves an explicit PR issue when a later Bay revision omits --issue", async () => {
    const { app } = await createHarness()
    const explicitIssue = "@km/all/21091-explicit-pr-issue"
    const bayDefault = "@km/all/21091-bay-default"
    await finishJob(app, await app.bays.open({ name: "issue-default", issue: bayDefault }))
    await app.bays.intake({ bay: "B1", headSha: HEAD_1, baseSha: BASE, issue: explicitIssue })
    await app.bays.submit({ pr: "PR1" })

    const revised = await app.bays.submitSelection("B1", {
      resolveRevision: async () => undefined,
      run: runtime,
    })

    expect(revised).toMatchObject({
      id: "PR1",
      issue: explicitIssue,
      revision: 2,
      headSha: HEAD_2,
      status: "submitted",
    })
    await app.close()
  })

  it("re-resolves a moved branch tip when re-submitting a bay-less pushed (draft) PR", async () => {
    await using app = (await createHarness()).app
    let tip = HEAD_1
    const submitOptions = () => ({ resolveRevision: async () => tip, run: runtime, base: "main" })

    const drafted = await app.bays.submitSelection("topic/moving-draft", { ...submitOptions(), draft: true })
    expect(drafted).toMatchObject({ status: "pushed", revision: 1, headSha: HEAD_1 })

    // The branch advances to a new commit after the draft was pushed. A non-draft
    // re-submit must register the moved head, not reuse the stored revision-1 head.
    tip = HEAD_2
    const resubmitted = await app.bays.submitSelection("topic/moving-draft", submitOptions())
    expect(resubmitted).toMatchObject({ status: "submitted", revision: 2, headSha: HEAD_2 })
    expect(resubmitted.revisions).toMatchObject([
      { revision: 1, headSha: HEAD_1 },
      { revision: 2, headSha: HEAD_2 },
    ])

    // A further re-submit with the branch unmoved must not manufacture a spurious revision.
    const stable = await app.bays.submitSelection("topic/moving-draft", submitOptions())
    expect(stable).toMatchObject({ status: "submitted", revision: 2, headSha: HEAD_2 })
  })

  it("refuses a terminal receipt that does not transition the current PR revision", async () => {
    const journal = createMemoryJournal()
    const staleWithdraw = command({
      title: "Emit a stale PR withdrawal",
      apply: () => ({
        events: [event("pr/withdrawn", { pr: "PR1", revision: 1, headSha: HEAD_1 })],
      }),
    })
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(
      createYrdDef(),
      withJobs({ definitions: jobs }),
      withBays({ jobs, defaultBase: "main" }),
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
    expect(app.bays.pr("PR1")).toMatchObject({ status: "submitted", revision: 2, headSha: HEAD_2 })
  })

  it("replays historical current and legacy terminal payloads without accepting legacy appends", async () => {
    const nextId = ids()
    const seededCommand = { id: nextId(), op: "fixture.legacy-pr-terminals" }
    const issueRef = "@km/all/21063-steering-laser"
    const at = "2026-01-01T00:00:00.000Z"
    const pushed = (pr: string, branch: string, headSha: string) => ({
      id: nextId(),
      name: "pr/pushed",
      ts: at,
      data: { pr, branch, base: "main", headSha, issue: issueRef, revision: 1 },
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
      withBays({ jobs, defaultBase: "main" }),
    ).extend({
      commands: {
        fixture: { legacyWithdraw, legacyReject, transitionalReject, legacyIntegrate, legacyPush, legacySubmit },
      },
    })
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => at, id: nextId },
    })

    expect(app.bays.pr("PR1")).toMatchObject({ status: "rejected", issue: issueRef })
    expect(app.bays.pr("PR1")?.revisions).toEqual([expect.not.objectContaining({ actor: expect.anything() })])
    expect(app.bays.pr("PR2")).toMatchObject({
      status: "integrated",
      issue: issueRef,
      integration: { commit: BASE, baseSha: BASE },
    })
    expect(app.bays.pr("PR3")).toMatchObject({ status: "withdrawn", issue: issueRef })
    expect(app.bays.pr("PR4")).toMatchObject({ status: "integrated", terminalRun: "R91" })
    expect(app.bays.pr("PR5")).toMatchObject({
      status: "rejected",
      terminalRun: "R92",
      detail: "current check failure",
    })
    expect(app.bays.pr("PR6")).toMatchObject({
      status: "canceled",
      terminalRun: "R93",
      canceledBy: "@ci",
      cancelReason: "superseded",
    })
    await expect(app.dispatch(app.commands.fixture.legacyWithdraw, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacyReject, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.transitionalReject, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacyIntegrate, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacyPush, undefined)).rejects.toThrow()
    await expect(app.dispatch(app.commands.fixture.legacySubmit, undefined)).rejects.toThrow()
  })

  it("fails replay loudly when a regression event names a different integrated tuple", async () => {
    const nextId = ids()
    const seededCommand = { id: nextId(), op: "fixture.invalid-regression-tuple" }
    const originalIssue = "@km/all/21091-original"
    const repairIssue = "@km/all/21091-repair"
    const originalLanding = "c".repeat(40)
    const repairLanding = "d".repeat(40)
    const at = (hour: number) => `2026-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`
    const pushed = (pr: string, branch: string, headSha: string, issue: string, ts: string) => ({
      id: nextId(),
      name: "pr/pushed",
      ts,
      data: { pr, branch, base: "main", baseSha: BASE, headSha, issue, revision: 1 },
    })
    const integrated = (
      pr: string,
      headSha: string,
      issueRef: string,
      run: string,
      landingSha: string,
      ts: string,
    ) => ({
      id: nextId(),
      name: "pr/integrated",
      ts,
      data: {
        pr,
        revision: 1,
        headSha,
        issueRef,
        run,
        commit: landingSha,
        landingSha,
        baseSha: BASE,
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
          pushed("PR1", "topic/original", HEAD_1, originalIssue, at(12)),
          integrated("PR1", HEAD_1, originalIssue, "R1", originalLanding, at(12)),
          pushed("PR2", "topic/repair", HEAD_2, repairIssue, at(14)),
          integrated("PR2", HEAD_2, repairIssue, "R2", repairLanding, at(14)),
          {
            id: nextId(),
            name: "pr/regression-recorded",
            ts: at(15),
            data: {
              pr: "PR1",
              issueRef: originalIssue,
              revision: 1,
              headSha: HEAD_1,
              run: "R1",
              landingSha: "e".repeat(40),
              detectedAt: at(13),
              severity: "high",
              evidence: "artifact://regression",
              implementationRunRef: "hab:turn/original",
              reviewRef: "tribe:review/original",
              repairIssueRef: repairIssue,
              repairPr: "PR2",
              repairRun: "R2",
              repairLandingSha: repairLanding,
            },
          },
        ],
      },
    ])
    const jobs = createBayJobDefs(createWorkspaceHarness().adapter)
    const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))

    await expect(createYrd(definition, { inject: { journal, clock: () => at(15), id: nextId } })).rejects.toThrow(
      "regression tuple does not match",
    )
  })

  it("persists one opaque correlation on a draft revision and preserves it through ready", async () => {
    await using app = (await createHarness()).app
    const correlation = { namespace: "tribe-request", id: "review-20925/custom 61's docs" }

    const drafted = await app.bays.submit({
      branch: "issue/correlated-draft",
      headSha: HEAD_1,
      draft: true,
      correlation,
    })
    expect(drafted.events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ correlation }),
      }),
    )
    expect(app.bays.pr("PR1")).toMatchObject({
      status: "pushed",
      revision: 1,
      correlation,
      revisions: [{ revision: 1, correlation }],
    })

    expect((await app.bays.submit({ pr: "PR1", correlation })).events).toEqual([])
    await expect(
      app.bays.submit({
        pr: "PR1",
        correlation: { namespace: "tribe-request", id: "review-20925/conflicting" },
      }),
    ).rejects.toThrow("already bound to correlation 'tribe-request:review-20925/custom 61's docs'")

    const ready = await app.bays.ready({ pr: "PR1" })
    expect(ready.events).toHaveLength(1)
    expect(app.bays.pr("PR1")).toMatchObject({
      status: "submitted",
      revision: 1,
      correlation,
      revisions: [{ revision: 1, correlation }],
    })
  })

  it("runs a pinned bay through refresh, PR revisions, withdrawal, and close", async () => {
    const { app, workspace } = await createHarness()

    const opened = await app.bays.open({ name: "fix-release", baseSha: BASE })
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

    const receipt = "f".repeat(64)
    const pushed = { bay: "B1", headSha: HEAD_1, baseSha: BASE, receipt }
    expect((await app.bays.intake(pushed)).events).toHaveLength(1)
    expect((await app.bays.intake(pushed)).events).toHaveLength(0)
    await expect(app.bays.intake({ ...pushed, headSha: HEAD_2 })).rejects.toThrow(
      `receiver receipt '${receipt}' does not match its recorded intake`,
    )
    await app.bays.submit({ pr: "PR1" })

    const refreshed = await app.bays.refresh({ bay: "B1" })
    await finishJob(app, refreshed)
    expect(app.bays.get("B1")).toMatchObject({ status: "active", headSha: HEAD_2, baseSha: BASE, dirty: false })
    await app.bays.intake({ bay: "B1", headSha: HEAD_2, baseSha: BASE })
    expect(app.bays.pr("PR1")).toMatchObject({
      id: "PR1",
      bay: "B1",
      branch: "issue/fix-release",
      base: "main",
      status: "pushed",
      revision: 2,
      headSha: HEAD_2,
      revisions: [
        {
          revision: 1,
          headSha: HEAD_1,
          base: "main",
          baseSha: BASE,
          pushedAt: "2026-01-01T00:00:00.000Z",
          submittedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          revision: 2,
          headSha: HEAD_2,
          base: "main",
          baseSha: BASE,
          pushedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })

    await expect(app.bays.close({ bay: "B1" })).rejects.toThrow(
      "run it through the queue or withdraw it before closing",
    )
    workspace.dirty = true
    const refused = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, refused)
    expect(app.bays.state()).toMatchObject({
      prs: {
        PR1: {
          status: "withdrawn",
          revisions: [
            { revision: 1, submittedAt: "2026-01-01T00:00:00.000Z" },
            {
              revision: 2,
              terminal: { status: "withdrawn", at: "2026-01-01T00:00:00.000Z" },
            },
          ],
        },
      },
      byId: { B1: { status: "active", failure: { code: "dirty-worktree" } } },
    })

    workspace.dirty = false
    const closed = await app.bays.close({ bay: "B1" })
    await finishJob(app, closed)
    expect(app.bays.state().byId.B1?.status).toBe("closed")
    expect(workspace.calls).toEqual([`provision:B1:${BASE}`, "refresh:B1", "deprovision:B1", "deprovision:B1"])
    await app.close()
  })

  it("submits prepared branches with monotonic PR ids and selected bases", async () => {
    const { app, workspace } = await createHarness()

    await app.bays.submit({ branch: "release/fix", headSha: HEAD_1, base: "release/2.0", name: "release-fix" })
    await app.bays.submit({ branch: "hotfix/next", headSha: HEAD_2 })

    expect(app.bays.state()).toMatchObject({
      byId: {},
      prs: {
        PR1: { branch: "release/fix", base: "release/2.0", status: "submitted", headSha: HEAD_1 },
        PR2: { branch: "hotfix/next", base: "main", status: "submitted", headSha: HEAD_2 },
      },
    })
    await expect(app.bays.submit({ branch: "release/fix", headSha: HEAD_2 })).rejects.toThrow(
      "branch 'release/fix' already has live PR 'PR1'",
    )
    expect(workspace.calls).toEqual([])
    await app.close()
  })

  it("journals revision-bound review and comment facts without inventing a draft status", async () => {
    await using app = (await createHarness()).app

    await app.bays.submit({ branch: "issue/review-me", headSha: HEAD_1, draft: true })
    expect(app.bays.pr("PR1")).toMatchObject({ status: "pushed", revision: 1, headSha: HEAD_1 })
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
      actor: "@cto",
      ref: "dialog-1",
      note: "Please explain the failure mode.",
    }
    expect((await app.bays.comment(comment)).events).toHaveLength(1)
    expect((await app.bays.comment(comment)).events).toHaveLength(0)

    const approval = {
      pr: "PR1",
      actor: "@cto",
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
      current: { revision: 1, headSha: HEAD_1, actor: "@cto", decision: "approve", ref: "verdict-1" },
      stale: [],
    })
    expect(app.bays.pr("PR1")).toMatchObject({
      status: "pushed",
      reviews: [{ revision: 1, headSha: HEAD_1, decision: "approve", actor: "@cto", ref: "verdict-1" }],
      comments: [{ revision: 1, headSha: HEAD_1, actor: "@cto", ref: "dialog-1" }],
    })

    expect((await app.bays.ready({ pr: "PR1" })).events).toHaveLength(1)
    expect((await app.bays.ready({ pr: "PR1" })).events).toHaveLength(0)
    expect(app.bays.pr("PR1")?.status).toBe("submitted")

    await app.bays.intake({ branch: "issue/review-me", headSha: HEAD_2, base: "main" })
    expect(app.bays.pr("PR1")).toMatchObject({ status: "pushed", revision: 2, headSha: HEAD_2 })
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
    expect(app.bays.pr("PR1")).toMatchObject({ status: "submitted", revision: 1, requestedReviewers: [] })
    expect(app.bays.needsReview("PR1")).toBe(false)

    const arbitraryActor = "reviewer id/with spaces:7"
    const first = await app.bays.requestReview({ pr: "PR1", reviewers: ["@cto", arbitraryActor] })
    expect(first.events.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "pr/review-requested",
        data: { pr: "PR1", reviewers: ["@cto", arbitraryActor], requestedBy: "operator" },
      },
    ])
    expect(app.bays.pr("PR1")?.requestedReviewers).toEqual(["@cto", arbitraryActor])

    expect((await app.bays.requestReview({ pr: "PR1", reviewers: ["@cto", arbitraryActor] })).events).toEqual([])

    const replaced = await app.bays.requestReview({ pr: "PR1", reviewers: ["@agent/5"], actor: "@chief" })
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

    await app.bays.review({ pr: "PR1", actor: "@stranger", decision: "approve", ref: "stranger-1" })
    expect(app.bays.needsReview("PR1")).toBe(true)

    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "reject", ref: "verdict-1" })
    expect(app.bays.needsReview("PR1")).toBe(false)
    expect(app.bays.needsReview("PR1", "@cto")).toBe(false)
    expect(app.bays.needsReview("PR1", "@agent/5")).toBe(true)

    await app.bays.intake({ branch: "issue/needs-review", headSha: HEAD_2, base: "main" })
    expect(app.bays.pr("PR1")).toMatchObject({ status: "pushed", revision: 2 })
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
    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "approve", ref: "verdict-1" })
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
    expect(app.bays.pr("PR1")).toMatchObject({ status: "pushed", revision: 2 })
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
    const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
    await using app = await createYrd(definition, {
      inject: { journal, clock: () => at, id: nextId },
    })

    expect(app.bays.pr("PR1")).toMatchObject({
      status: "submitted",
      requestedReviewers: ["@agent/5", "@cto"],
    })
    expect(app.bays.needsReview("PR1")).toBe(true)
    expect(app.bays.needsReview("PR1", "@agent/5")).toBe(true)
    expect(app.bays.needsReview("PR1", "@stranger")).toBe(false)
  })

  it("recuts one immutable payload as a new revision of the same PR and carries exact approval", async () => {
    await using app = (await createHarness()).app
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)

    const correlation = { namespace: "tribe-request", id: "recut-identity" }
    await app.bays.submit({
      branch: "issue/recut",
      headSha: HEAD_1,
      baseSha: BASE,
      correlation,
      draft: true,
    })
    await app.bays.review({
      pr: "PR1",
      actor: "@cto",
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
    const recut = await app.bays.recut(args)

    expect(recut.events).toContainEqual(
      expect.objectContaining({
        name: "pr/recut",
        data: {
          pr: "PR1",
          fromRevision: 1,
          patchId,
          baseSha: nextBase,
          treeSha,
          reviewCarried: true,
          predecessor: { revision: 1, headSha: HEAD_1, baseSha: BASE },
          successor: { revision: 2, headSha: HEAD_2, baseSha: nextBase },
        },
      }),
    )
    expect(app.bays.pr("PR1")).toMatchObject({
      id: "PR1",
      branch: "issue/recut",
      status: "pushed",
      revision: 2,
      headSha: HEAD_2,
      baseSha: nextBase,
      correlation,
      recut: { fromRevision: 1, patchId, treeSha, reviewCarried: true },
      revisions: [
        { revision: 1, headSha: HEAD_1, correlation },
        {
          revision: 2,
          headSha: HEAD_2,
          baseSha: nextBase,
          correlation,
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

  it("keeps the selected immutable revision correlation when recutting an older payload", async () => {
    await using app = (await createHarness()).app
    const sourceCorrelation = { namespace: "tribe-request", id: "source" }
    const currentCorrelation = { namespace: "tribe-request", id: "current" }
    await app.bays.submit({
      branch: "issue/recut-source",
      headSha: HEAD_1,
      correlation: sourceCorrelation,
      draft: true,
    })
    await app.bays.intake({ branch: "issue/recut-source", headSha: HEAD_2, base: "main" })
    await app.bays.submit({ pr: "PR1", correlation: currentCorrelation })

    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: "3".repeat(40),
      baseSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })

    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 3,
      correlation: sourceCorrelation,
      revisions: [
        { revision: 1, correlation: sourceCorrelation },
        { revision: 2, correlation: currentCorrelation },
        { revision: 3, correlation: sourceCorrelation, recut: { fromRevision: 1 } },
      ],
    })

    await app.bays.submit({ branch: "issue/recut-uncorrelated", headSha: "4".repeat(40), draft: true })
    await app.bays.intake({ branch: "issue/recut-uncorrelated", headSha: "5".repeat(40), base: "main" })
    await app.bays.submit({ pr: "PR2", correlation: currentCorrelation })
    await app.bays.recut({
      pr: "PR2",
      fromRevision: 1,
      headSha: "6".repeat(40),
      baseSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })
    expect(app.bays.pr("PR2")?.correlation).toBeUndefined()
    expect(app.bays.pr("PR2")?.revisions[2]?.correlation).toBeUndefined()
  })

  it("refuses to append check requests to terminal PR history", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "issue/terminal-checks", headSha: HEAD_1 })
    await app.bays.closePr({ pr: "PR1" })

    await expect(app.bays.requestChecks({ pr: "PR1", baseSha: BASE })).rejects.toThrow(
      "PR 'PR1' is withdrawn, not checkable",
    )
  })

  it("journals normalized source compositions and rejects ambiguous payload paths", async () => {
    const { app } = await createHarness()
    await app.bays.submit({
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

    expect(app.bays.pr("PR1")).toMatchObject({
      composition: {
        version: 1,
        sources: [{ repo: "vendor/example", payload: ["src/a.ts", "src/z.ts"] }],
      },
      revisions: [
        {
          composition: {
            version: 1,
            sources: [{ repo: "vendor/example", payload: ["src/a.ts", "src/z.ts"] }],
          },
        },
      ],
    })
    await expect(
      app.bays.submit({
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

  it("preserves and canonicalizes an existing composition when resubmitting a selection", async () => {
    const { app } = await createHarness()
    await app.bays.submit({
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

    const canonicalRepeat = await app.bays.submitSelection("issue/composed", {
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
      resolveRevision: async () => HEAD_1,
      run: runtime,
    })
    const omittedRepeat = await app.bays.submitSelection("issue/composed", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
    })

    expect(canonicalRepeat).toMatchObject({ revision: 1, composition: original?.composition })
    expect(omittedRepeat).toMatchObject({ revision: 1, composition: original?.composition })
    expect(app.bays.pr("PR1")?.revisions).toHaveLength(1)
    await app.close()
  })

  it("closes a direct bayless PR so it leaves live selection while history remains", async () => {
    const { app, workspace } = await createHarness()

    // Direct (bayless) submission — the superseded-PR shape with no Bay to close.
    await app.bays.submit({ branch: "issue/chief-state-20979-r1", headSha: HEAD_1 })
    const live = app.bays.pr("PR1")
    expect(live).toMatchObject({ id: "PR1", status: "submitted" })
    expect(live?.bay).toBeUndefined()

    // PR-native close requires no Bay.
    await app.bays.closePr({ pr: "PR1" })
    const closed = app.bays.pr("PR1")
    // "withdrawn" is exactly the status the Queue and status view exclude from OPEN selection.
    expect(closed).toMatchObject({ id: "PR1", status: "withdrawn" })
    expect(closed?.withdrawnAt).toBe("2026-01-01T00:00:00.000Z")
    // History remains: the PR still resolves and keeps its revision trail.
    expect(closed?.revisions).toHaveLength(1)
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
    await expect(app.bays.closePr({ pr: "PR1" })).rejects.toThrow("PR 'PR1' is withdrawn")
    // Unknown selector — refuse.
    await expect(app.bays.closePr({ pr: "PR404" })).rejects.toThrow("no PR 'PR404'")

    // The same verb resolves a bay-backed PR by its branch spelling.
    await app.bays.submit({ branch: "issue/other", headSha: HEAD_2 })
    await app.bays.closePr({ pr: "issue/other" })
    expect(app.bays.pr("PR2")).toMatchObject({ status: "withdrawn" })

    await app.close()
  })

  it("owns the complete bay and direct-branch submission flow", async () => {
    const { app, workspace } = await createHarness()
    await finishJob(app, await app.bays.open({ name: "domain-submit" }))
    const resolved: string[] = []
    const resolveRevision = async (ref: string): Promise<string | undefined> => {
      resolved.push(ref)
      return ref === "release/fix" ? HEAD_1 : undefined
    }

    const bayPR = await app.bays.submitSelection("B1", { resolveRevision, run: runtime })
    expect(bayPR).toMatchObject({ bay: "B1", status: "submitted", headSha: HEAD_2, base: "main" })
    expect(workspace.calls).toEqual([`provision:B1:current`, "refresh:B1"])

    const branchPR = await app.bays.submitSelection("release/fix", {
      base: "release/2.0",
      resolveRevision,
      run: runtime,
    })
    expect(branchPR).toMatchObject({ branch: "release/fix", status: "submitted", headSha: HEAD_1, base: "release/2.0" })
    expect(resolved).toEqual(["release/fix"])

    workspace.dirty = true
    await finishJob(app, await app.bays.open({ name: "dirty-submit" }))
    await expect(app.bays.submitSelection("B2", { resolveRevision, run: runtime })).rejects.toThrow("uncommitted work")
    await app.close()
  })

  it("reuses one live PR when another branch spelling resolves to the same payload", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const { app } = await createHarness(log)
    await app.bays.intake({ branch: "issue/feature", base: "main", headSha: HEAD_1, baseSha: BASE })
    expect(app.bays.pr("PR1")).toMatchObject({ branch: "issue/feature", status: "pushed" })

    const options = {
      base: "main",
      resolveRevision: async (ref: string) => (ref === "origin/issue/feature" ? HEAD_1 : undefined),
      run: runtime,
    }
    const submitted = await app.bays.submitSelection("PR1", options)
    const repeated = await app.bays.submitSelection("origin/issue/feature", options)

    expect(submitted).toMatchObject({ id: "PR1", branch: "issue/feature", status: "submitted" })
    expect(repeated).toMatchObject({ id: "PR1", status: "submitted" })
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
      return withBays({ jobs })(createYrdDef())
    }
    void invalid
  })

  it("sets and mutably re-edits a PR title and description via editPr", async () => {
    await using app = (await createHarness()).app
    await app.bays.submit({ branch: "topic/metadata", headSha: HEAD_1 })

    await app.bays.editPr({
      pr: "PR1",
      title: "feat(bay): add pr metadata",
      description: "Adds a durable title and description to the PR record.",
    })
    expect(app.bays.pr("PR1")).toMatchObject({
      title: "feat(bay): add pr metadata",
      description: "Adds a durable title and description to the PR record.",
      status: "submitted",
    })

    // Unlike the immutable issue join, title and description are editable metadata.
    await app.bays.editPr({ pr: "PR1", title: "feat(bay): pr title + description" })
    expect(app.bays.pr("PR1")).toMatchObject({
      title: "feat(bay): pr title + description",
      description: "Adds a durable title and description to the PR record.",
    })

    // A no-op edit (unchanged values) emits nothing.
    expect((await app.bays.editPr({ pr: "PR1", title: "feat(bay): pr title + description" })).events).toEqual([])
  })

  it("binds a title and description at submit through submitSelection options", async () => {
    await using app = (await createHarness()).app
    const submitted = await app.bays.submitSelection("topic/submit-metadata", {
      resolveRevision: async () => HEAD_1,
      run: runtime,
      base: "main",
      title: "fix(queue): scope superseded runs",
      description: "Scopes superseded-revision runs in the watch detail pane.",
    })
    expect(submitted).toMatchObject({
      status: "submitted",
      title: "fix(queue): scope superseded runs",
      description: "Scopes superseded-revision runs in the watch detail pane.",
    })
  })

  it("carries title and description forward across a resubmitted revision", async () => {
    await using app = (await createHarness()).app
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
    const resubmitted = await submit()
    expect(resubmitted).toMatchObject({
      revision: 2,
      headSha: HEAD_2,
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
    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 2,
      headSha: HEAD_2,
      issue: "@km/all/21091-issue",
      title: "feat: recut carries metadata",
      description: "Recut must not drop the authored title or description.",
    })
  })
})
