/**
 * @failure The resident runner dumps raw JSON log payloads instead of scannable watch-timeline rows, or repeats scope-bound runner/host/pane on every human line.
 * @level l2
 * @consumer @yrd/cli resident follow-runner operators
 */
import { describe, expect, it } from "vitest"
import type { Event } from "loggily"
import { formatResidentLogLine, TIMELINE_BRANCH_ICON } from "../src/runner-timeline.ts"

function log(namespace: string, level: string, message: string, props: Record<string, unknown>): Event {
  return { kind: "log", namespace, level, message, props } as unknown as Event
}

const RUNNER_SCOPE = { runner: "yrd-cli:42", host: "unimac", pane: "wC:p7" }

describe("resident runner timeline row grammar", () => {
  const runSucceeded = log("yrd:queue:run", "info", "run succeeded", {
    ...RUNNER_SCOPE,
    run: "R604",
    base: "main",
    steps: ["merge"],
    status: "passed",
    outcome: "succeeded",
    durationMs: 78_000,
    prs: [{ pr: "PR411", revision: 2, headSha: "abc", branch: "task/yrd-r6-bump-ci-r1" }],
  })

  it("renders a passing run as a one-line timeline row: run, PR.rev, branch, (step ✓), duration", () => {
    const plain = formatResidentLogLine(runSucceeded, { color: false })
    expect(plain).toBe(`R604 PR411.2  ${TIMELINE_BRANCH_ICON} task/yrd-r6-bump-ci-r1 (merge ✓) 1m`)
    // Exactly one line, no JSON payload dumped inline.
    expect(plain).not.toContain("{")
    expect(plain?.split("\n").filter(Boolean)).toHaveLength(1)
  })

  it("never repeats the scope-bound runner/host/pane on the human line", () => {
    const plain = formatResidentLogLine(runSucceeded, { color: false })
    expect(plain).not.toContain("yrd-cli:42")
    expect(plain).not.toContain("unimac")
    expect(plain).not.toContain("wC:p7")
  })

  it("colorizes a passing step GREEN, bolds the PR id, and dims the duration when color is on", () => {
    const colored = formatResidentLogLine(runSucceeded, { color: true })
    expect(colored).toContain("\x1b[32m") // green status
    expect(colored).toContain("\x1b[1m") // bold PR id.revision
    expect(colored).toContain("\x1b[2m") // dim duration
    expect(colored).toContain("✓")
    // The branch-glyph prefixes the branch name.
    expect(colored).toContain(TIMELINE_BRANCH_ICON)
  })

  it("colorizes a failed step RED with the failure glyph", () => {
    const failed = log("yrd:jobs:merge", "error", "merge failed", {
      ...RUNNER_SCOPE,
      run: "R603",
      step: "merge",
      status: "failed",
      outcome: "failed",
      durationMs: 3_400,
      prs: [{ pr: "PR410", revision: 1, headSha: "def", branch: "topic/x" }],
    })
    const plain = formatResidentLogLine(failed, { color: false })
    expect(plain).toBe(`R603 PR410.1  ${TIMELINE_BRANCH_ICON} topic/x (merge ×) 3.4s`)
    const colored = formatResidentLogLine(failed, { color: true })
    expect(colored).toContain("\x1b[31m") // red
    expect(colored).toContain("×")
  })

  it("renders a running step BLUE with the in-progress glyph", () => {
    const running = log("yrd:jobs:check", "info", "check progress", {
      ...RUNNER_SCOPE,
      run: "R605",
      step: "check",
      status: "running",
      durationMs: 1_200,
      prs: [{ pr: "PR412", revision: 1, headSha: "aaa", branch: "topic/y" }],
    })
    const colored = formatResidentLogLine(running, { color: true })
    expect(colored).toContain("\x1b[34m") // blue
    expect(colored).toContain("●")
  })

  it("renders a mixed compose settlement as its labelled summary line", () => {
    const compose = log("yrd:queue:compose", "info", "compose settled: 1 failed, 1 passed", {
      ...RUNNER_SCOPE,
      outcome: "settled",
      summary: "settled: 1 failed, 1 passed",
      durationMs: 90_000,
      runs: [
        { run: "R1", status: "failed" },
        { run: "R2", status: "passed" },
      ],
    })
    const plain = formatResidentLogLine(compose, { color: false })
    expect(plain).toBe("compose settled: 1 failed, 1 passed 1m")
    expect(plain).not.toContain("{")
  })

  it("suppresses low-level journal chatter from the human stream (it stays in the JSONL sink)", () => {
    const lock = log("yrd:journal:lock", "info", "lock succeeded", {
      ...RUNNER_SCOPE,
      path: "/x/writer.lock",
      outcome: "succeeded",
      durationMs: 0,
    })
    expect(formatResidentLogLine(lock, { color: false })).toBeUndefined()
    const append = log("yrd:journal:append", "info", "append succeeded", { ...RUNNER_SCOPE, outcome: "succeeded" })
    expect(formatResidentLogLine(append, { color: false })).toBeUndefined()
  })

  it("renders a warn/error notice as a compact level+message line without the scope payload", () => {
    const drain = log("yrd:runner", "warn", "graceful drain requested — finishing the active run before exit", {
      ...RUNNER_SCOPE,
      signal: "SIGINT",
      mode: "drain",
      forceStop: "press Ctrl-C again to force stop",
      recovery: "yrd queue recover",
    })
    const plain = formatResidentLogLine(drain, { color: false })
    expect(plain).toContain("graceful drain requested")
    expect(plain).not.toContain("yrd-cli:42")
    expect(plain).not.toContain("unimac")
    // Structured hint fields are surfaced compactly, not as a raw JSON blob.
    expect(plain).toContain("recovery=yrd queue recover")
    expect(plain).not.toContain("{")
  })
})
