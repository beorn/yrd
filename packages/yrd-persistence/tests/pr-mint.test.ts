/**
 * @failure PR numbers recycle after store re-initialization because the mint
 * high-water was lost, rolled back, or silently guessed from a broken store.
 * @level l1
 * @consumer @yrd/persistence
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createDurablePrNumberMint } from "../src/pr-mint.ts"

async function mintDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yrd-pr-mint-"))
}

describe("createDurablePrNumberMint", () => {
  it("reads 0 for a store that has never minted, including a missing directory", async () => {
    const dir = await mintDir()
    expect(createDurablePrNumberMint({ dir }).highWater()).toBe(0)
    expect(createDurablePrNumberMint({ dir: join(dir, "never-created") }).highWater()).toBe(0)
  })

  it("persists the high-water across instances, surviving a process restart", async () => {
    const dir = await mintDir()
    createDurablePrNumberMint({ dir }).commit(1340)
    expect(createDurablePrNumberMint({ dir }).highWater()).toBe(1340)
  })

  it("survives the journal database being deleted and rebuilt", async () => {
    const dir = await mintDir()
    // The mint is a sibling FILE of journal.sqlite, deliberately not a table
    // inside it: the 22986 re-initialization class includes the database being
    // snapshot-restored or deleted outright, which a table rides along with.
    writeFileSync(join(dir, "journal.sqlite"), "stand-in journal")
    const mint = createDurablePrNumberMint({ dir })
    mint.commit(1340)
    rmSync(join(dir, "journal.sqlite"))
    expect(createDurablePrNumberMint({ dir }).highWater()).toBe(1340)
  })

  it("refuses to move the high-water backwards or sideways", async () => {
    const dir = await mintDir()
    const mint = createDurablePrNumberMint({ dir })
    mint.commit(10)
    expect(() => mint.commit(10)).toThrow(/refuses to move its high-water backwards/u)
    expect(() => mint.commit(3)).toThrow(/refuses to move its high-water backwards/u)
    mint.commit(11)
    expect(mint.highWater()).toBe(11)
  })

  it("refuses non-positive and non-integer high-waters", async () => {
    const dir = await mintDir()
    const mint = createDurablePrNumberMint({ dir })
    expect(() => mint.commit(0)).toThrow(/non-positive high-water/u)
    expect(() => mint.commit(-4)).toThrow(/non-positive high-water/u)
    expect(() => mint.commit(1.5)).toThrow(/non-positive high-water/u)
  })

  it("refuses loudly on a corrupt store instead of guessing 0", async () => {
    const dir = await mintDir()
    const path = join(dir, "pr-mint.json")
    const mint = createDurablePrNumberMint({ dir })
    for (const [content, reason] of [
      ["not json at all", /malformed JSON/u],
      ["[1]", /unexpected shape/u],
      ['{"v":2,"prHighWater":9}', /unsupported version/u],
      ['{"v":1,"prHighWater":"9"}', /invalid high-water/u],
      ['{"v":1,"prHighWater":-1}', /invalid high-water/u],
      ['{"v":1,"prHighWater":1.5}', /invalid high-water/u],
      ['{"v":1}', /invalid high-water/u],
    ] as const) {
      writeFileSync(path, content)
      expect(() => mint.highWater(), content).toThrow(reason)
      expect(() => mint.highWater(), content).toThrow(/PR-number mint store/u)
      // commit reads before writing, so a corrupt store refuses writes too.
      expect(() => mint.commit(99), content).toThrow(reason)
    }
  })

  it("refuses loudly on an unreadable store instead of guessing 0", async () => {
    const dir = await mintDir()
    mkdirSync(join(dir, "pr-mint.json"))
    const mint = createDurablePrNumberMint({ dir })
    expect(() => mint.highWater()).toThrow(/PR-number mint store .* is unreadable/u)
    expect(() => mint.commit(1)).toThrow(/PR-number mint store/u)
  })

  it("replaces the store atomically, leaving no temp litter behind", async () => {
    const dir = await mintDir()
    const mint = createDurablePrNumberMint({ dir })
    mint.commit(1)
    mint.commit(2)
    mint.commit(3)
    expect(readdirSync(dir)).toEqual(["pr-mint.json"])
    expect(mint.highWater()).toBe(3)
  })
})
