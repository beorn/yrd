import { describe, expect, it } from "vitest"
import { createMemoryEventStore, createYrd, pipe, withEffects, type EffectOutcome } from "@yrd/core"
import {
  withBays,
  type BayWorkspaceAdapter,
  type DeprovisionedBay,
  type ProvisionedBay,
  type RefreshedBay,
} from "../src/index.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function createApp(workspace: BayWorkspaceAdapter) {
  return pipe(
    createYrd({
      store: createMemoryEventStore(),
      clock: () => "2026-01-01T00:00:00.000Z",
      idGen: ids(),
    }),
    withEffects(),
    withBays({ workspace, defaultBase: "main" }),
  )
}

function createHarness() {
  const workspace = { calls: [] as string[], dirty: false }
  const adapter: BayWorkspaceAdapter = {
    provision(input): EffectOutcome<ProvisionedBay> {
      workspace.calls.push(`provision:${input.bay}:${input.baseSha ?? "current"}`)
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE },
      }
    },
    refresh(input): EffectOutcome<RefreshedBay> {
      workspace.calls.push(`refresh:${input.bay}`)
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_2, baseSha: BASE, dirty: workspace.dirty },
      }
    },
    deprovision(input): EffectOutcome<DeprovisionedBay> {
      workspace.calls.push(`deprovision:${input.bay}`)
      return workspace.dirty
        ? { status: "failed", error: { code: "dirty-worktree", message: "workspace has uncommitted work" } }
        : { status: "passed", output: { preservedRef: `refs/yrd/closed/${input.bay}` } }
    },
  }
  return { app: createApp(adapter), adapter, workspace }
}

type TestApp = ReturnType<typeof createApp>

async function finishEffect(app: TestApp, run: { effectIds: string[] }): Promise<void> {
  const id = run.effectIds[0]
  if (id === undefined) throw new Error("expected one Bay workspace effect")
  await app.effectRuns.run(id, { executor: "local", leaseMs: 60_000 })
}

describe("withBays", () => {
  it("runs a pinned bay through refresh, PR revisions, withdrawal, and close", async () => {
    const { app, workspace } = createHarness()

    const opened = await app.command(app.commands.bay.open, { name: "fix-release", baseSha: BASE })
    expect((await app.state()).bays.bays.B1?.status).toBe("opening")
    await finishEffect(app, opened)
    expect((await app.state()).bays.bays.B1).toMatchObject({
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
    expect((await app.command(app.commands.bay.intake, pushed)).events).toHaveLength(1)
    expect((await app.command(app.commands.bay.intake, pushed)).events).toHaveLength(0)
    await expect(app.command(app.commands.bay.intake, { ...pushed, headSha: HEAD_2 })).rejects.toThrow(
      `receiver receipt '${receipt}' does not match its recorded intake`,
    )
    await app.command(app.commands.bay.submit, { submission: "PR1" })

    const refreshed = await app.command(app.commands.bay.refresh, { bay: "B1" })
    await finishEffect(app, refreshed)
    expect((await app.state()).bays.bays.B1).toMatchObject({
      status: "active",
      headSha: HEAD_2,
      baseSha: BASE,
      dirty: false,
    })
    await app.command(app.commands.bay.intake, { bay: "B1", headSha: HEAD_2, baseSha: BASE })
    expect((await app.state()).bays.submissions.PR1).toMatchObject({
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

    await expect(app.command(app.commands.bay.close, { bay: "B1" })).rejects.toThrow(
      "integrate it or close with withdraw=true",
    )
    workspace.dirty = true
    const refused = await app.command(app.commands.bay.close, { bay: "B1", withdraw: true })
    await finishEffect(app, refused)
    expect((await app.state()).bays).toMatchObject({
      submissions: { PR1: { status: "withdrawn" } },
      bays: { B1: { status: "active", failure: { code: "dirty-worktree" } } },
    })

    workspace.dirty = false
    const closed = await app.command(app.commands.bay.close, { bay: "B1" })
    await finishEffect(app, closed)
    expect((await app.state()).bays.bays.B1?.status).toBe("closed")
    expect(workspace.calls).toEqual([`provision:B1:${BASE}`, "refresh:B1", "deprovision:B1", "deprovision:B1"])
  })

  it("submits prepared branches with monotonic PR ids and their selected bases", async () => {
    const { app, workspace } = createHarness()

    await app.command(app.commands.bay.submit, {
      branch: "release/fix",
      headSha: HEAD_1,
      base: "release/2.0",
      name: "release-fix",
    })
    await app.command(app.commands.bay.submit, { branch: "hotfix/next", headSha: HEAD_2 })

    expect((await app.state()).bays).toMatchObject({
      bays: {},
      submissions: {
        PR1: { branch: "release/fix", base: "release/2.0", status: "submitted", headSha: HEAD_1 },
        PR2: { branch: "hotfix/next", base: "main", status: "submitted", headSha: HEAD_2 },
      },
    })
    await expect(app.command(app.commands.bay.submit, { branch: "release/fix", headSha: HEAD_2 })).rejects.toThrow(
      "branch 'release/fix' already has live submission 'PR1'",
    )
    expect(workspace.calls).toEqual([])
  })

  it("requires durable effects before Bay composition in TypeScript", () => {
    const bare = createYrd({ store: createMemoryEventStore() })
    const { adapter } = createHarness()
    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error withBays requires durable effects first
      withBays({ workspace: adapter })(bare)
    })
    withBays({ workspace: adapter })(pipe(bare, withEffects()))
  })
})
