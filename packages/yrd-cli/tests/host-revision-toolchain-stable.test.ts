/**
 * @failure Two bun binaries on one host produced two revision families that the resident and operators swapped forever (22374).
 * @level l1
 * @consumer @yrd/cli installed-baseline
 */
import { describe, expect, it } from "vitest"
import { queueStepRevision, type ToolchainFingerprint } from "../src/host-revision.ts"

const config = { run: "true", runner: "local" as const } as const

function revision(toolchain: ToolchainFingerprint): string {
  return queueStepRevision({
    repo: "/repo",
    stateDir: "/repo/.git/yrd",
    name: "check",
    config,
    timeoutMs: 1,
    noProgressMs: 1,
    toolchain,
  })
}

/**
 * A step's identity must depend on what the step DOES, not on which launcher
 * happened to invoke `yrd`. The live specimen: the same host carried
 * `bun 1.3.14` on operator shells and `bun 1.3.13` on the supervisor's frozen
 * PATH, so the resident and every operator computed different revisions for
 * byte-identical config and overwrote each other's installed baseline on every
 * drain. The visible symptom was `config-drift` — naming the config, which had
 * never changed.
 *
 * Recurrence of 22334: identity leaking an environment accident. That one was
 * fixed for paths alone (`stablePath`), and the class was left open.
 */
describe("queueStepRevision toolchain stability (22374)", () => {
  it("is unchanged by the launcher's bun and node versions", () => {
    const operator = revision({ bun: "1.3.14", node: "24.3.0", platform: "darwin", arch: "arm64" })
    const supervised = revision({ bun: "1.3.13", node: "24.2.0", platform: "darwin", arch: "arm64" })
    expect(supervised).toBe(operator)
  })

  it("still separates hosts whose steps would actually run different binaries", () => {
    const mac = revision({ bun: "1.3.14", node: "24.3.0", platform: "darwin", arch: "arm64" })
    const linux = revision({ bun: "1.3.14", node: "24.3.0", platform: "linux", arch: "arm64" })
    const rosetta = revision({ bun: "1.3.14", node: "24.3.0", platform: "darwin", arch: "x64" })
    expect(new Set([mac, linux, rosetta]).size, "platform and arch remain part of step identity").toBe(3)
  })
})
