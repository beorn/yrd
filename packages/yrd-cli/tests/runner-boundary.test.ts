/**
 * @failure CLI-owned generic Jobs bypass the configured Runner and therefore
 * lose its admission, Context, cancellation, and runtime-identity contract.
 * @level l2
 * @consumer @yrd/cli Job execution boundary
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Runner boundary", () => {
  it("submits CLI-owned Jobs through the app Runner instead of driving Jobs directly", () => {
    const source = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8")

    expect(source).not.toContain("app.jobs.runMany")
    expect(source).toContain("app.runner.submit")
  })
})
