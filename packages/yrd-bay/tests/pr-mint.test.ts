/**
 * @failure A re-initialized store re-issues PR numbers, a minted id escapes
 * before its high-water is durable, or a broken mint store degrades silently
 * to the record-set scan.
 * @level l2
 * @consumer @yrd/bay
 */
import { mkdirSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkpointMigrationManifest, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createDurablePrNumberMint } from "@yrd/persistence"
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import {
  createBayJobDefs,
  mintChangeId,
  volatilePrNumberMint,
  withBays,
  type BayWorkspace,
  type PrNumberMint,
} from "../src/plugin.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const HEAD_3 = "3".repeat(40)
const BASE = "a".repeat(40)
const silentLog = createLogger("test", [{ level: "silent" }])

// Intake never runs a workspace job, so the stub only has to exist.
const unusedWorkspace: BayWorkspace = {
  revision: "pr-mint-test-v1",
  provision: (): never => {
    throw new Error("unused in pr-mint tests")
  },
  refresh: (): never => {
    throw new Error("unused in pr-mint tests")
  },
  checkpoint: (): never => {
    throw new Error("unused in pr-mint tests")
  },
  deprovision: (): never => {
    throw new Error("unused in pr-mint tests")
  },
}

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function composeDefinition(mint: PrNumberMint) {
  const jobs = createBayJobDefs(unusedWorkspace)
  return pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({ jobs, prNumberMint: mint, defaultBase: "main" }),
  )
}

async function createApp(mint: PrNumberMint) {
  return createYrd(composeDefinition(mint), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-01-01T00:00:00.000Z",
      id: ids(),
      log: silentLog,
    },
  })
}

describe("PR-number mint", () => {
  it("keeps counting after the store is re-initialized, never re-issuing a number", async () => {
    // The 22986 shape: the journal bootstraps "fresh", every PR record is
    // gone, and a record-set scan would restart at PR1. A warm-store test
    // proves nothing here — the whole point is surviving the bootstrap path,
    // so this test rebuilds the app on an EMPTY journal with only the durable
    // mint's directory shared.
    const dir = await mkdtemp(join(tmpdir(), "yrd-pr-mint-bay-"))
    const before = await createApp(createDurablePrNumberMint({ dir }))
    await before.bays.intake({ branch: "topic/first", headSha: HEAD_1, baseSha: BASE })
    await before.bays.intake({ branch: "topic/second", headSha: HEAD_2, baseSha: BASE })
    expect(Object.keys(before.state().bays.prs)).toEqual(["PR1", "PR2"])

    const reinitialized = await createApp(createDurablePrNumberMint({ dir }))
    expect(Object.keys(reinitialized.state().bays.prs)).toEqual([])
    await reinitialized.bays.intake({ branch: "topic/third", headSha: HEAD_3, baseSha: BASE })
    expect(Object.keys(reinitialized.state().bays.prs)).toEqual(["PR3"])
  })

  it("commits the high-water before the id escapes, so a failing store mints nothing", async () => {
    const order: string[] = []
    const observed = volatilePrNumberMint()
    const recording: PrNumberMint = {
      highWater: () => {
        order.push("highWater")
        return observed.highWater()
      },
      commit: (next) => {
        order.push(`commit:${String(next)}`)
        observed.commit(next)
      },
    }
    const app = await createApp(recording)
    await app.bays.intake({ branch: "topic/ordered", headSha: HEAD_1, baseSha: BASE })
    expect(order).toEqual(["highWater", "commit:1"])
    expect(observed.highWater()).toBe(1)

    const failing: PrNumberMint = {
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: mint store down (test)")
      },
    }
    const broken = await createApp(failing)
    await expect(broken.bays.intake({ branch: "topic/doomed", headSha: HEAD_2, baseSha: BASE })).rejects.toThrow(
      /mint store down/u,
    )
    expect(Object.keys(broken.state().bays.prs)).toEqual([])
  })

  it("refuses intake loudly when the durable store is unreadable, never falling back to the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yrd-pr-mint-broken-"))
    mkdirSync(join(dir, "pr-mint.json"))
    const app = await createApp(createDurablePrNumberMint({ dir }))
    await expect(app.bays.intake({ branch: "topic/refused", headSha: HEAD_1, baseSha: BASE })).rejects.toThrow(
      /PR-number mint store/u,
    )
    expect(Object.keys(app.state().bays.prs)).toEqual([])
  })

  it("mints above both the durable high-water and the surviving record set", () => {
    // Counter ahead of the records: the reinit direction.
    const ahead = volatilePrNumberMint(100)
    expect(mintChangeId(ahead, {})).toBe("PR101")
    expect(ahead.highWater()).toBe(101)
    // Records ahead of the counter: the mint store was lost but the journal
    // survived; the record max keeps the sequence moving forward.
    const behind = volatilePrNumberMint()
    expect(mintChangeId(behind, { PR1: {}, PR7: {}, B12: {} })).toBe("PR8")
    expect(behind.highWater()).toBe(8)
  })

  it("is not a checkpoint-identity input: any mint composes to the same identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yrd-pr-mint-identity-"))
    const baseline = checkpointMigrationManifest(composeDefinition(volatilePrNumberMint()))
    expect(checkpointMigrationManifest(composeDefinition(volatilePrNumberMint(9999)))).toEqual(baseline)
    expect(checkpointMigrationManifest(composeDefinition(createDurablePrNumberMint({ dir })))).toEqual(baseline)
  })
})
