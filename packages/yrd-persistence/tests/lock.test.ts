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

  // The type already requires `holder`, and a TypeScript caller cannot omit it.
  // A caller TypeScript never sees can, and one does: `tools/yrd-runtime.mjs`
  // in the superproject is a hand-written .mjs mirror of `drainSettlements`
  // that takes this same lock. While the field was optional it acquired it
  // anonymously, which is why every starvation message on that lock read
  // `holder=unknown operation` and the incident could not be attributed. The
  // cast below is the point of the test: it reproduces the shape a .mjs caller
  // presents, which no type can refuse.
  it("refuses an unnamed holder from a caller no type can reach, and says what to pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-exclusive-unnamed-"))
    try {
      const untyped = createExclusive(root, { timeoutMs: 0 }) as unknown as {
        run(operation: () => Promise<void>): Promise<void>
      }
      await expect(untyped.run(() => Promise.resolve())).rejects.toThrow(/requires \{ holder \}/u)
      // The remedy has to name the lock, or the reader cannot tell WHICH one.
      await expect(untyped.run(() => Promise.resolve())).rejects.toThrow(/writer\.lock/u)
      // And it must not be the raw property access it used to be.
      await expect(untyped.run(() => Promise.resolve())).rejects.not.toThrow(/undefined is not an object/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
