/**
 * @failure Reading the environment format starts the queue's load-time identity probes.
 * @level l1 (the public data-reader import, with process creation observed)
 * @consumer host cleanup, worktree pool and post-close inventory readers
 * @testonly none
 */
import { expect, it, vi } from "vitest"

it("imports the public environment reader without starting a process", async () => {
  using spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("unexpected process on data import")
  })
  using spawnSync = vi.spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("unexpected sync process on data import")
  })
  await import("@yrd/cli/environments")
  expect(spawn).not.toHaveBeenCalled()
  expect(spawnSync).not.toHaveBeenCalled()
})
