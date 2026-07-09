import { describe, expect, it } from "vitest"
import { createMemoryEventStore, createYrd, pipe, withEffects, type EffectOutcome } from "@yrd/core"
import { withBays, type BayWorkspaceAdapter, type DeprovisionedBay, type ProvisionedBay } from "../src/index.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const BASE = "a".repeat(40)

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function createWorkspace() {
  const calls: string[] = []
  let dirty = false
  const workspace: BayWorkspaceAdapter = {
    provision(input): EffectOutcome<ProvisionedBay> {
      calls.push(`provision:${input.bay}`)
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE },
      }
    },
    deprovision(input): EffectOutcome<DeprovisionedBay> {
      calls.push(`deprovision:${input.bay}`)
      return dirty
        ? { status: "failed", error: { code: "dirty-worktree", message: "workspace has uncommitted work" } }
        : { status: "passed", output: { preservedRef: `refs/yrd/closed/${input.bay}` } }
    },
  }
  return {
    workspace,
    calls,
    setDirty(value: boolean) {
      dirty = value
    },
  }
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

async function openActiveBay(app: ReturnType<typeof createApp>, name = "fix-release") {
  const opened = await app.command(app.commands.bay.open, { name })
  const bay = (await app.state()).bays.bays.B1!
  expect(bay.status).toBe("opening")
  await app.effectRuns.run(opened.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
  return (await app.state()).bays.bays.B1!
}

describe("withBays", () => {
  it("projects public bay commands from typed refs and provisions through a durable effect", async () => {
    const fake = createWorkspace()
    const app = createApp(fake.workspace)

    expect(app.commands.bay.open.visibility).toBe("public")
    expect(app.commands.bay.intake.visibility).toBe("internal")
    expect(app.operation(app.commands.bay.open, { name: "fix-release" })).toEqual({
      op: "bay.open",
      args: { name: "fix-release" },
    })

    const active = await openActiveBay(app)
    expect(active).toMatchObject({
      id: "B1",
      name: "fix-release",
      branch: "task/fix-release",
      base: "main",
      status: "active",
      path: "/repo/.bays/B1",
      headSha: HEAD_1,
      baseSha: BASE,
    })
    expect(fake.calls).toEqual(["provision:B1"])
  })

  it("keeps every pushed commit as an immutable revision and submits the pinned tip", async () => {
    const app = createApp(createWorkspace().workspace)
    await openActiveBay(app)

    await app.command(app.commands.bay.intake, { bay: "B1", headSha: HEAD_1, baseSha: BASE })
    expect((await app.state()).bays.submissions.S1).toMatchObject({
      status: "pushed",
      revision: 1,
      headSha: HEAD_1,
    })

    await app.command(app.commands.bay.submit, { submission: "S1" })
    expect((await app.state()).bays.submissions.S1?.status).toBe("submitted")

    await app.command(app.commands.bay.intake, { bay: "B1", headSha: HEAD_2, baseSha: BASE })
    const submission = (await app.state()).bays.submissions.S1!
    expect(submission).toMatchObject({ status: "pushed", revision: 2, headSha: HEAD_2 })
    expect(submission.revisions).toEqual([
      { revision: 1, headSha: HEAD_1, base: "main", baseSha: BASE, pushedAt: "2026-01-01T00:00:00.000Z" },
      { revision: 2, headSha: HEAD_2, base: "main", baseSha: BASE, pushedAt: "2026-01-01T00:00:00.000Z" },
    ])
  })

  it("submits a prepared branch without provisioning a bay", async () => {
    const app = createApp(createWorkspace().workspace)
    await app.command(app.commands.bay.submit, {
      branch: "release/fix",
      headSha: HEAD_1,
      base: "release/2.0",
      name: "release-fix",
    })

    const submission = (await app.state()).bays.submissions.S1!
    expect(submission).toMatchObject({
      branch: "release/fix",
      base: "release/2.0",
      status: "submitted",
      revision: 1,
      headSha: HEAD_1,
    })
    expect("bay" in submission).toBe(false)
  })

  it("refuses live-work close, withdraws explicitly, and never closes a dirty workspace", async () => {
    const fake = createWorkspace()
    const app = createApp(fake.workspace)
    await openActiveBay(app)
    await app.command(app.commands.bay.intake, { bay: "B1", headSha: HEAD_1 })
    await app.command(app.commands.bay.submit, { submission: "S1" })

    await expect(app.command(app.commands.bay.close, { bay: "B1" })).rejects.toThrow(
      "integrate it or close with withdraw=true",
    )

    fake.setDirty(true)
    const closing = await app.command(app.commands.bay.close, { bay: "B1", withdraw: true })
    expect((await app.state()).bays.submissions.S1?.status).toBe("withdrawn")
    await app.effectRuns.run(closing.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect((await app.state()).bays.bays.B1).toMatchObject({
      status: "active",
      failure: { code: "dirty-worktree" },
    })

    fake.setDirty(false)
    const retry = await app.command(app.commands.bay.close, { bay: "B1" })
    await app.effectRuns.run(retry.effectIds[0]!, { executor: "local", leaseMs: 60_000 })
    expect((await app.state()).bays.bays.B1).toMatchObject({ status: "closed" })
  })

  it("enforces effect-before-bay plugin ordering in TypeScript", () => {
    const bare = createYrd({ store: createMemoryEventStore() })
    const compileOnly = (_check: () => void): void => {}
    compileOnly(() => {
      // @ts-expect-error withBays requires durable effects first
      withBays({ workspace: createWorkspace().workspace })(bare)
    })
    withBays({ workspace: createWorkspace().workspace })(pipe(bare, withEffects()))
  })
})
