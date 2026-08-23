import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createExclusive } from "../src/lock.ts"

describe("POSIX writer lock", () => {
  it("names the holding operation when a contender times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-exclusive-holder-"))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = createExclusive(root).run(
      async () => {
        entered.resolve()
        await release.promise
      },
      { holder: "deployment D1 worktree add" },
    )
    await entered.promise

    try {
      await expect(
        createExclusive(root, { timeoutMs: 0 }).run(() => Promise.resolve(), {
          holder: "queue PR7 merge remove",
        }),
      ).rejects.toThrow(/holder=deployment D1 worktree add/iu)
    } finally {
      release.resolve()
      await held
      await rm(root, { recursive: true, force: true })
    }
  })
})
