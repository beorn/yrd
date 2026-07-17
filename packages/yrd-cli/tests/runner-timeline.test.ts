/**
 * @failure The resident runner reports more than one human row per step, buries the failing step's err slug, drops a run-owned failure into silence, repeats the scope-bound runner/host/pane, or loses the structured JSON tail behind the scannable grammar.
 * @level l2
 * @consumer @yrd/cli resident follow-runner operators
 */
import { describe, expect, it } from "vitest"
import type { Event } from "loggily"
import { formatResidentLogLine } from "../src/runner-timeline.ts"

// A fixed event time so the loggily lead-in `HH:MM:SS` is deterministic.
const AT = Date.parse("2026-07-16T18:40:23.000Z")

// The session-constant identity the resident binds ONCE at its logger scope.
const RUNNER_SCOPE = { runner: "yrd-cli:42", host: "unimac", pane: "wC:p7" }

function log(namespace: string, level: string, message: string, props: Record<string, unknown>): Event {
  return { kind: "log", namespace, level, message, time: AT, props } as unknown as Event
}

/** The scannable grammar sits before the JSON tail (which starts at ` {`). */
function grammar(row: string | undefined): string {
  const at = row?.indexOf(' {"') ?? -1
  return at < 0 ? (row ?? "") : (row ?? "").slice(0, at)
}

describe("resident runner step-row grammar", () => {
  const stepPassed = log("yrd:jobs:check", "info", "check succeeded", {
    ...RUNNER_SCOPE,
    lifecycle: "check",
    run: "R324",
    base: "main",
    step: "check",
    index: 0,
    attempt: 1,
    status: "passed",
    outcome: "succeeded",
    durationMs: 34_000,
    prs: [{ pr: "PR411", revision: 2, branch: "topic/six" }],
  })

  it("reports a passing step as ONE INFO row: time, level, run scope, [base#run index:step] done duration", () => {
    const plain = formatResidentLogLine(stepPassed, { color: false })
    expect(grammar(plain)).toBe("18:40:23 INFO yrd:queue:run [main#324 1:check] done 34s · PR411.2 topic/six")
    // Exactly one row.
    expect(plain?.split("\n").filter(Boolean)).toHaveLength(1)
  })

  it("presents the step under the single run scope, never a per-run child namespace", () => {
    const plain = formatResidentLogLine(stepPassed, { color: false })
    expect(plain).toContain("yrd:queue:run")
    expect(plain).not.toContain("yrd:jobs:check ")
  })

  it("carries the full structured record as a JSON tail, minus the session-constant scope identity", () => {
    const plain = formatResidentLogLine(stepPassed, { color: false })
    // The friendly grammar is a readable PREFIX to the full record.
    expect(plain).toContain('{"lifecycle":"check"')
    expect(plain).toContain('"base":"main"')
    expect(plain).toContain('"step":"check"')
    // runner/host/pane are bound once at the scope, never repeated per row.
    expect(plain).not.toContain("yrd-cli:42")
    expect(plain).not.toContain("unimac")
    expect(plain).not.toContain("wC:p7")
  })

  it("colorizes a passing step: dim time, blue INFO, cyan scope, bold run ref, GREEN done, dim duration", () => {
    const colored = formatResidentLogLine(stepPassed, { color: true })
    expect(colored).toContain("\x1b[34mINFO") // blue level
    expect(colored).toContain("\x1b[36myrd:queue:run") // cyan scope
    expect(colored).toContain("\x1b[1mmain#324") // bold run ref
    expect(colored).toContain("\x1b[32mdone") // green verb
    expect(colored).toContain("\x1b[2m34s") // dim duration
  })

  const stepFailed = log("yrd:jobs:merge", "error", "merge failed", {
    ...RUNNER_SCOPE,
    lifecycle: "merge",
    run: "R324",
    base: "main",
    step: "merge",
    index: 1,
    attempt: 1,
    status: "failed",
    outcome: "failed",
    durationMs: 3_400,
    error: { code: "merge-conflict", message: "refused to merge unrelated histories" },
    prs: [{ pr: "PR411", revision: 2, branch: "topic/six" }],
  })

  it("reports a failing step as ONE ERROR row with the canonical err slug", () => {
    const plain = formatResidentLogLine(stepFailed, { color: false })
    expect(grammar(plain)).toBe("18:40:23 ERROR yrd:queue:run [main#324 2:merge] failed 3.4s err=merge-conflict · PR411.2 topic/six")
    const colored = formatResidentLogLine(stepFailed, { color: true })
    expect(colored).toContain("\x1b[31mERROR") // red level
    expect(colored).toContain("\x1b[31mfailed") // red verb
  })

  it("marks a retry attempt (>1) in the step token as index:step#attempt", () => {
    const retry = log("yrd:jobs:merge", "error", "merge failed", {
      ...stepFailed.props,
      attempt: 2,
    } as Record<string, unknown>)
    expect(grammar(formatResidentLogLine(retry, { color: false }))).toContain("[main#324 2:merge#2] failed")
  })

  it("keeps a batched run identifiable on failure by listing every PR ref", () => {
    const batch = log("yrd:jobs:merge", "error", "merge failed", {
      ...RUNNER_SCOPE,
      run: "R330",
      base: "main",
      step: "merge",
      index: 1,
      status: "failed",
      outcome: "failed",
      durationMs: 5_000,
      error: { code: "batch-conflict" },
      prs: [
        { pr: "PR411", revision: 2 },
        { pr: "PR412", revision: 1 },
        { pr: "PR413", revision: 3 },
      ],
    })
    const plain = grammar(formatResidentLogLine(batch, { color: false }))
    expect(plain).toContain("[main#330 2:merge] failed 5.0s err=batch-conflict")
    expect(plain).toContain("PR411.2 PR412.1 PR413.3")
  })

  it("surfaces a run-owned failure (no step owns it) as a run-scoped ERROR row — never silent", () => {
    // A pinned/stale-base refusal fails the run before any step Job ran, so
    // queueRunOutcome escalates it to ERROR at yrd:queue:run. It has no step
    // token, so the bracket names the run alone.
    const runOwned = log("yrd:queue:run", "error", "run failed", {
      ...RUNNER_SCOPE,
      lifecycle: "run",
      run: "R7",
      base: "main",
      status: "failed",
      outcome: "failed",
      durationMs: 120,
      steps: ["check", "merge"],
      error: { code: "stale-pr", message: "pinned base moved" },
      prs: [{ pr: "PR9", revision: 1, branch: "issue/stale" }],
    })
    const plain = grammar(formatResidentLogLine(runOwned, { color: false }))
    expect(plain).toBe("18:40:23 ERROR yrd:queue:run [main#7] failed 120ms err=stale-pr · PR9.1 issue/stale")
  })
})

describe("resident runner roll-up suppression (kept in JSONL, dropped from the human stream)", () => {
  it("suppresses the redundant run settlement (INFO) — each step already reported once", () => {
    const runSettled = log("yrd:queue:run", "info", "run settled", {
      ...RUNNER_SCOPE,
      run: "R324",
      base: "main",
      status: "failed",
      outcome: "settled",
      steps: ["check", "merge"],
      durationMs: 78_000,
    })
    expect(formatResidentLogLine(runSettled, { color: false })).toBeUndefined()
  })

  it("suppresses the redundant compose settlement (INFO), success or mixed", () => {
    const composeDone = log("yrd:queue:compose", "info", "compose succeeded", {
      ...RUNNER_SCOPE,
      outcome: "succeeded",
      durationMs: 90_000,
    })
    const composeMixed = log("yrd:queue:compose", "info", "compose settled: 1 failed, 1 passed", {
      ...RUNNER_SCOPE,
      outcome: "settled",
      summary: "settled: 1 failed, 1 passed",
      durationMs: 90_000,
    })
    expect(formatResidentLogLine(composeDone, { color: false })).toBeUndefined()
    expect(formatResidentLogLine(composeMixed, { color: false })).toBeUndefined()
  })

  it("suppresses low-level journal chatter (INFO/DEBUG) — it stays in the JSONL sink", () => {
    const lock = log("yrd:journal:lock", "info", "lock succeeded", {
      ...RUNNER_SCOPE,
      path: "/x/writer.lock",
      outcome: "succeeded",
      durationMs: 0,
    })
    expect(formatResidentLogLine(lock, { color: false })).toBeUndefined()
  })
})

describe("resident runner notices (non-outcome events always surface once)", () => {
  it("surfaces a compose-level refusal (WARN) as a notice with its message and JSON tail", () => {
    const refusal = log("yrd:queue:compose", "warn", "compose refused — queue busy", {
      ...RUNNER_SCOPE,
      outcome: "refused",
      reason: "another run is composing",
    })
    const plain = formatResidentLogLine(refusal, { color: false })
    expect(plain).toContain("18:40:23 WARN yrd:queue:compose compose refused — queue busy")
    expect(plain).toContain('"reason":"another run is composing"')
    expect(plain).not.toContain("unimac")
  })

  it("surfaces the graceful-drain notice with its structured hint fields", () => {
    const drain = log("yrd:runner", "warn", "graceful drain requested — finishing the active run before exit", {
      ...RUNNER_SCOPE,
      signal: "SIGINT",
      mode: "drain",
      recovery: "yrd queue recover",
    })
    const plain = formatResidentLogLine(drain, { color: false })
    expect(plain).toContain("graceful drain requested")
    expect(plain).toContain('"recovery":"yrd queue recover"')
    expect(plain).not.toContain("yrd-cli:42")
  })

  it("does NOT mistake a duration-invalid diagnostic for a second step row", () => {
    // The backwards-clock diagnostic shares outcome:"succeeded" but carries a
    // `diagnostic` field; it must render as its own notice, never a done row.
    const diag = log("yrd:jobs:check", "error", "check duration invalid", {
      ...RUNNER_SCOPE,
      run: "R9",
      base: "main",
      step: "check",
      index: 0,
      outcome: "succeeded",
      diagnostic: "invalid-duration",
      durationMs: 0,
    })
    const plain = formatResidentLogLine(diag, { color: false })
    expect(plain).toContain("check duration invalid")
    expect(plain).not.toContain("done")
    expect(plain).not.toContain("failed")
  })

  it("ignores span events on the human stream", () => {
    expect(formatResidentLogLine({ kind: "span" } as unknown as Event, { color: false })).toBeUndefined()
  })
})
