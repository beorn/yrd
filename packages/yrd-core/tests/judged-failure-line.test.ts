/**
 * @failure A check step's refusal says only `<name> command exited 1`. The
 * line that judged the failure — the named test, the TS error, the guard's own
 * refusal sentence — sat in the artifact nobody was told to open, so a reader
 * had the code and the exit status and no way to act on either. Measured on
 * PR2695/6/7 and PR2699, 2026-08-29.
 * @level l1
 * @consumer @yrd/queue (configuredCommand's non-zero-exit failure message)
 */
import { describe, expect, it } from "vitest"
import { firstJudgedFailureLine } from "../src/output-digest.ts"

describe("firstJudgedFailureLine names the line that judged the failure", () => {
  it("names the failing vitest file and test, not the run summary", () => {
    const output = [
      "",
      " RUN  v4.1.10 /hh/dev",
      "",
      " ❯ packages/yrd-queue/tests/refusal-code-registry.test.ts (12 tests | 2 failed)",
      " FAIL  packages/yrd-queue/tests/refusal-code-registry.test.ts > the vocabulary is closed > resolves every derived emitted code",
      "AssertionError: expected undefined to be defined",
      "",
      " Test Files  1 failed (1)",
    ].join("\n")
    expect(firstJudgedFailureLine(output)).toBe(
      "FAIL  packages/yrd-queue/tests/refusal-code-registry.test.ts > the vocabulary is closed > resolves every derived emitted code",
    )
  })

  it("names a TypeScript diagnostic", () => {
    const output = [
      "> tsc --noEmit",
      "src/queue.ts(88,3): error TS2345: Argument of type 'string' is not assignable.",
    ].join("\n")
    expect(firstJudgedFailureLine(output)).toBe(
      "src/queue.ts(88,3): error TS2345: Argument of type 'string' is not assignable.",
    )
  })

  it("names a guard's own refusal sentence when the guard prints one", () => {
    const output = [
      "checking 4 guarded verbs",
      "error: 'gitlink advance' is registered by yrd-cli but has no row in YRD_VERB_ACCESS",
    ].join("\n")
    expect(firstJudgedFailureLine(output)).toBe(
      "error: 'gitlink advance' is registered by yrd-cli but has no row in YRD_VERB_ACCESS",
    )
  })

  it("takes the FIRST judged line — the later ones are usually its consequences", () => {
    const output = ["FAIL  a.test.ts > first", "FAIL  b.test.ts > second"].join("\n")
    expect(firstJudgedFailureLine(output)).toBe("FAIL  a.test.ts > first")
  })

  it("fabricates nothing: output with no recognized judgement yields undefined", () => {
    expect(firstJudgedFailureLine("built 404 modules\ncompiled in 1.2s\nsilvery@1.500.0")).toBeUndefined()
    expect(firstJudgedFailureLine("")).toBeUndefined()
  })

  it("bounds a runaway line so one refusal cannot become the whole log", () => {
    const line = `error: ${"x".repeat(600)}`
    const judged = firstJudgedFailureLine(line)
    expect(judged).toBeDefined()
    expect((judged ?? "").length).toBeLessThanOrEqual(200)
    expect(judged).toMatch(/…$/u)
  })
})
