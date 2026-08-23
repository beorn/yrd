/**
 * @failure Relative vs absolute repo/stateDir paths produced two revision families (22334).
 * @level l1
 * @consumer @yrd/queue step-revision-drift
 */
import { describe, expect, it } from "vitest"
import { queueStepRevision } from "../src/host-revision.ts"

const toolchain = { bun: "1.0.0", node: "20.0.0", platform: "darwin", arch: "arm64" } as const

describe("queueStepRevision path stability (22334)", () => {
  it("hashes relative and absolute paths to the same revision", () => {
    const abs = process.cwd()
    const relative = "."
    const config = { run: "true", runner: "local" as const }
    const a = queueStepRevision({
      repo: abs,
      stateDir: `${abs}/.git/yrd`,
      name: "check",
      config,
      timeoutMs: 1,
      noProgressMs: 1,
      toolchain,
      checkoutParent: `${abs}/.git/yrd/bays`,
    })
    const b = queueStepRevision({
      repo: relative,
      stateDir: "./.git/yrd",
      name: "check",
      config,
      timeoutMs: 1,
      noProgressMs: 1,
      toolchain,
      checkoutParent: "./.git/yrd/bays",
    })
    expect(a).toBe(b)
  })
})
