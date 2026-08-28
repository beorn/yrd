/**
 * @failure A re-initialized store re-issues PR numbers, a minted id escapes
 * before its high-water is durable, or a broken mint store degrades silently
 * to the record-set scan.
 * @level l2
 * @consumer @yrd/bay `mintChangeId` (the queue's derived-member mint since S7)
 *
 * S7 note (branch-is-change, @i/10 22991): the bay plugin's own mint sites
 * (intakePR/submitWork) retired, so these fences drive `mintChangeId`
 * directly — the exact function @yrd/queue's mintDerivedMemberIdentity calls
 * for every derived member. The 22986 obligations are unchanged: durable
 * high-water first, commit before the id escapes, loud refusal on a broken
 * store, never a silent record-set fallback.
 */
import { mkdirSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDurablePrNumberMint } from "@yrd/persistence"
import { describe, expect, it } from "vitest"
import { mintChangeId, volatilePrNumberMint, type PrNumberMint } from "../src/plugin.ts"

describe("PR-number mint", () => {
  it("keeps counting after the store is re-initialized, never re-issuing a number", async () => {
    // The 22986 shape: the journal bootstraps "fresh", every PR record is
    // gone, and a record-set scan would restart at PR1. A warm-store test
    // proves nothing here — the whole point is surviving the bootstrap path,
    // so this test re-creates the mint on an EMPTY record set with only the
    // durable mint's directory shared.
    const dir = await mkdtemp(join(tmpdir(), "yrd-pr-mint-bay-"))
    const before = createDurablePrNumberMint({ dir })
    expect(mintChangeId(before, {})).toBe("PR1")
    expect(mintChangeId(before, { PR1: {} })).toBe("PR2")

    const reinitialized = createDurablePrNumberMint({ dir })
    expect(mintChangeId(reinitialized, {})).toBe("PR3")
  })

  it("commits the high-water before the id escapes, so a failing store mints nothing", () => {
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
    expect(mintChangeId(recording, {})).toBe("PR1")
    expect(order).toEqual(["highWater", "commit:1"])
    expect(observed.highWater()).toBe(1)

    const failing: PrNumberMint = {
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: mint store down (test)")
      },
    }
    expect(() => mintChangeId(failing, {})).toThrow(/mint store down/u)
  })

  it("refuses loudly when the durable store is unreadable, never falling back to the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yrd-pr-mint-broken-"))
    mkdirSync(join(dir, "pr-mint.json"))
    const broken = createDurablePrNumberMint({ dir })
    expect(() => mintChangeId(broken, {})).toThrow(/PR-number mint store/u)
  })

  it("mints above both the durable high-water and the surviving record set", () => {
    // Counter ahead of the records: the reinit direction.
    const ahead = volatilePrNumberMint(100)
    expect(mintChangeId(ahead, {})).toBe("PR101")
    expect(ahead.highWater()).toBe(101)
    // Records ahead of the counter: the mint store was lost but the journal
    // survived; the record max keeps the sequence moving forward. Post-S7 the
    // caller-supplied record set is the queue's retained-snapshot max.
    const behind = volatilePrNumberMint()
    expect(mintChangeId(behind, { PR1: {}, PR7: {}, B12: {} })).toBe("PR8")
    expect(behind.highWater()).toBe(8)
  })
})
