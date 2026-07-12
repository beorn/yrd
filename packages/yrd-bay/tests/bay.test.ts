/**
 * @failure Bay and PR lifecycle state diverges from durable Jobs or accepts invalid transitions.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type CommandResult } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import type { DeprovisionedBay, ProvisionedBay, RefreshedBay } from "../src/model.ts"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)
const runtime = { executor: "local", leaseMs: 60_000 }

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

async function createApp(workspace: BayWorkspace) {
  const jobs = createBayJobDefs(workspace)
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
  return createYrd(definition, {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-01-01T00:00:00.000Z",
      id: ids(),
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

async function createHarness() {
  const harness = createWorkspaceHarness()
  return { ...harness, app: await createApp(harness.adapter) }
}

type TestApp = Awaited<ReturnType<typeof createApp>>

async function finishJob(app: TestApp, result: CommandResult): Promise<void> {
  const id = app.jobs.requested(result)[0]
  if (id === undefined) throw new Error("expected one Bay workspace job")
  await app.jobs.run(id, { executor: "local", leaseMs: 60_000 })
}

describe("withBays", () => {
  it("runs a pinned bay through refresh, PR revisions, withdrawal, and close", async () => {
    const { app, workspace } = await createHarness()

    const opened = await app.bays.open({ name: "fix-release", baseSha: BASE })
    expect(app.bays.state().byId.B1?.status).toBe("opening")
    await finishJob(app, opened)
    expect(app.bays.get("fix-release")).toMatchObject({
      id: "B1",
      name: "fix-release",
      branch: "task/fix-release",
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
      branch: "task/fix-release",
      base: "main",
      status: "pushed",
      revision: 2,
      headSha: HEAD_2,
      revisions: [
        { revision: 1, headSha: HEAD_1, base: "main", baseSha: BASE },
        { revision: 2, headSha: HEAD_2, base: "main", baseSha: BASE },
      ],
    })

    await expect(app.bays.close({ bay: "B1" })).rejects.toThrow("integrate it or close with withdraw=true")
    workspace.dirty = true
    const refused = await app.bays.close({ bay: "B1", withdraw: true })
    await finishJob(app, refused)
    expect(app.bays.state()).toMatchObject({
      prs: { PR1: { status: "withdrawn" } },
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

  it("withdraws a direct bayless PR so it leaves live selection while history remains", async () => {
    const { app, workspace } = await createHarness()

    // Direct (bayless) submission — the superseded-PR shape that has no Bay to close.
    await app.bays.submit({ branch: "task/chief-state-20979-r1", headSha: HEAD_1 })
    const live = app.bays.pr("PR1")
    expect(live).toMatchObject({ id: "PR1", status: "submitted" })
    expect(live?.bay).toBeUndefined()

    // PR-native withdrawal requires no Bay.
    await app.bays.withdraw({ pr: "PR1" })
    const withdrawn = app.bays.pr("PR1")
    // "withdrawn" is exactly the status the Line and status view exclude from OPEN selection.
    expect(withdrawn).toMatchObject({ id: "PR1", status: "withdrawn" })
    expect(withdrawn?.withdrawnAt).toBe("2026-01-01T00:00:00.000Z")
    // History remains: the PR still resolves and keeps its revision trail.
    expect(withdrawn?.revisions).toHaveLength(1)
    // A pure state transition — no bay/workspace job runs.
    expect(workspace.calls).toEqual([])

    await app.close()
  })

  it("refuses to withdraw a terminal or unknown PR, and can withdraw a bay-backed PR", async () => {
    const { app } = await createHarness()

    // A rejected direct PR is still live (pollutes selection) and can be withdrawn.
    await app.bays.submit({ branch: "task/superseded", headSha: HEAD_1 })
    await app.bays.withdraw({ pr: "PR1" })
    // Already withdrawn (terminal) — refuse loudly, never a silent no-op.
    await expect(app.bays.withdraw({ pr: "PR1" })).rejects.toThrow("PR 'PR1' is withdrawn")
    // Unknown selector — refuse.
    await expect(app.bays.withdraw({ pr: "PR404" })).rejects.toThrow("no PR 'PR404'")

    // The same verb resolves a bay-backed PR by its branch spelling.
    await app.bays.submit({ branch: "task/other", headSha: HEAD_2 })
    await app.bays.withdraw({ pr: "task/other" })
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
    const { app } = await createHarness()
    await app.bays.intake({ branch: "task/feature", base: "main", headSha: HEAD_1, baseSha: BASE })
    expect(app.bays.pr("PR1")).toMatchObject({ branch: "task/feature", status: "pushed" })

    const options = {
      base: "main",
      resolveRevision: async (ref: string) => (ref === "origin/task/feature" ? HEAD_1 : undefined),
      run: runtime,
    }
    const submitted = await app.bays.submitSelection("origin/task/feature", options)
    const repeated = await app.bays.submitSelection("origin/task/feature", options)

    expect(submitted).toMatchObject({ id: "PR1", branch: "task/feature", status: "submitted" })
    expect(repeated).toMatchObject({ id: "PR1", status: "submitted" })
    expect(Object.keys(app.bays.state().prs)).toEqual(["PR1"])
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
})
