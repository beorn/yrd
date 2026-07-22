/**
 * @failure The resident runner reports more than one human row per event, buries the failing step's err slug, drops a run-owned failure into silence, repeats scope-bound identity, inlines output spew, or points at an artifact that does not exist.
 * @level l2
 * @consumer @yrd/cli resident follow-runner operators
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Event } from "loggily"
import { formatResidentLogLine } from "../src/runner-timeline.ts"

// A fixed event time so the loggily lead-in `HH:MM:SS` is deterministic.
const AT = Date.parse("2026-07-16T18:40:23.000Z")

// The session-constant identity the resident binds ONCE at its logger scope.
const RUNNER_SCOPE = { runner: "yrd-cli:42", host: "unimac", pane: "wC:p7" }

let priorTZ: string | undefined
beforeAll(() => {
  priorTZ = process.env.TZ
  process.env.TZ = "UTC"
})
afterAll(() => {
  if (priorTZ === undefined) delete process.env.TZ
  else process.env.TZ = priorTZ
})

function log(namespace: string, level: string, message: string, props: Record<string, unknown>): Event {
  return { kind: "log", namespace, level, message, time: AT, props } as unknown as Event
}

/** Strip a generic notice JSON tail when a test only targets the grammar. */
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

  it("renders the same system-local clock as queue watch", () => {
    process.env.TZ = "Asia/Kolkata"
    try {
      const plain = formatResidentLogLine(stepPassed, { color: false })
      expect(grammar(plain)).toBe("00:10:23 INFO yrd:queue:run [main#324 1:check] done 34s · PR411.2 topic/six")
    } finally {
      process.env.TZ = "UTC"
    }
  })

  it("presents the step under the single run scope, never a per-run child namespace", () => {
    const plain = formatResidentLogLine(stepPassed, { color: false })
    expect(plain).toContain("yrd:queue:run")
    expect(plain).not.toContain("yrd:jobs:check ")
  })

  it("keeps the full structured record in JSONL instead of the human narration row", () => {
    const plain = formatResidentLogLine(stepPassed, { color: false })
    expect(plain).not.toContain('{"')
    expect(plain).not.toContain('"lifecycle"')
    expect(plain).not.toContain("yrd-cli:42")
    expect(plain).not.toContain("unimac")
    expect(plain).not.toContain("wC:p7")
  })

  it("narrates run admission and step start with clickable artifact locations", () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-runner-starts-"))
    const runDir = join(artifactRoot, "R324")
    const stepDir = join(runDir, "0-check", "attempt-1")
    mkdirSync(stepDir, { recursive: true })
    const runStarted = log("yrd:queue:run", "debug", "run started", {
      ...RUNNER_SCOPE,
      lifecycle: "run",
      run: "R324",
      base: "main",
      outcome: "started",
      prs: [{ pr: "PR411", revision: 2, branch: "topic/six" }],
    })
    const stepStarted = log("yrd:jobs:check", "debug", "check started", {
      ...RUNNER_SCOPE,
      lifecycle: "check",
      run: "R324",
      base: "main",
      step: "check",
      index: 0,
      attempt: 1,
      outcome: "started",
      prs: [{ pr: "PR411", revision: 2, branch: "topic/six" }],
    })

    try {
      const runRow = formatResidentLogLine(runStarted, { color: false, artifactRoot })
      expect(grammar(runRow)).toContain("[main#324] admitted")
      expect(runRow).toContain(`\x1b]8;;${pathToFileURL(runDir).href}`)

      const stepRow = formatResidentLogLine(stepStarted, { color: false, artifactRoot })
      expect(grammar(stepRow)).toContain("[main#324 1:check] started")
      expect(stepRow).toContain(`\x1b]8;;${pathToFileURL(stepDir).href}`)
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("does not rename external completion processing as a second step start", () => {
    const completionStarted = log("yrd:jobs:check", "debug", "check started", {
      ...RUNNER_SCOPE,
      lifecycle: "check",
      run: "R324",
      base: "main",
      step: "check",
      index: 0,
      attempt: 1,
      outcome: "started",
      completion: true,
    })
    expect(formatResidentLogLine(completionStarted, { color: false })).toBeUndefined()
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
    expect(grammar(plain)).toBe(
      '18:40:23 ERROR yrd:queue:run [main#324 2:merge] failed 3.4s err=merge-conflict cause="refused to merge unrelated histories" · PR411.2 topic/six',
    )
    const colored = formatResidentLogLine(stepFailed, { color: true })
    expect(colored).toContain("\x1b[31mERROR") // red level
    expect(colored).toContain("\x1b[31mfailed") // red verb
  })

  it("points a failed step row at its recorded clickable stderr artifact", () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-runner-recorded-"))
    const stderr = join(artifactRoot, "R324", "1-merge", "attempt-1", "recorded-stderr.log")
    mkdirSync(dirname(stderr), { recursive: true })
    writeFileSync(stderr, "merge failed\n")
    const withArtifact = log("yrd:jobs:merge", "error", "merge failed", {
      ...(stepFailed.props as Record<string, unknown>),
      artifacts: [{ name: "stderr", path: stderr }],
    })
    try {
      const plain = formatResidentLogLine(withArtifact, { color: false, artifactRoot })
      expect(grammar(plain)).toContain("log=")
      expect(grammar(plain)).toContain("recorded-stderr.log")
      expect(plain).toContain(`\x1b]8;;${pathToFileURL(stderr).href}`)
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("links the existing attempt directory when a failed step recorded no stream file", () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-runner-fallback-"))
    const attemptDir = join(artifactRoot, "R324", "1-merge", "attempt-1")
    mkdirSync(attemptDir, { recursive: true })
    try {
      const plain = formatResidentLogLine(stepFailed, { color: false, artifactRoot })
      expect(grammar(plain)).toContain("log=")
      expect(grammar(plain)).toContain("logs")
      expect(plain).toContain(`\x1b]8;;${pathToFileURL(attemptDir).href}`)
      expect(plain).not.toContain(pathToFileURL(join(attemptDir, "stderr.log")).href)
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("never fabricates a link when neither a recorded artifact nor attempt home exists", () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-runner-missing-"))
    try {
      const plain = formatResidentLogLine(stepFailed, { color: false, artifactRoot })
      expect(grammar(plain)).not.toContain("log=")
      expect(plain).not.toContain("\x1b]8;;")
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("preserves a recorded URI artifact instead of corrupting it into a file URL", () => {
    const uri = "artifact://R324/merge/attempt-1/stderr.log"
    const withArtifact = log("yrd:jobs:merge", "error", "merge failed", {
      ...(stepFailed.props as Record<string, unknown>),
      artifacts: [{ kind: "stderr", uri }],
    })
    const plain = formatResidentLogLine(withArtifact, { color: false })
    expect(grammar(plain)).toContain("stderr")
    expect(plain).toContain(`\x1b]8;;${uri}`)
    expect(plain).not.toContain("file://")
  })

  it("bounds a multiline failure cause so command output cannot become a one-line dump", () => {
    const marker = "UNBOUNDED_GIT_OUTPUT"
    const withLongCause = log("yrd:jobs:merge", "error", "merge failed", {
      ...(stepFailed.props as Record<string, unknown>),
      error: {
        code: "merge-push-failed",
        message: `push failed\n${marker.repeat(1_000)}`,
      },
    })
    const plain = grammar(formatResidentLogLine(withLongCause, { color: false }))
    expect(plain).toContain('cause="push failed ')
    expect(plain).toContain("…")
    expect(plain.length).toBeLessThan(500)
    expect(plain).not.toContain(marker.repeat(20))
  })

  it("never inlines command output spew into a runner narration row", () => {
    const withSpew = log("yrd:jobs:merge", "error", "merge failed", {
      ...(stepFailed.props as Record<string, unknown>),
      stdout: "thousands of stdout lines",
      stderr: "thousands of stderr lines",
    })
    const plain = formatResidentLogLine(withSpew, { color: false, artifactRoot: "/repo/.git/yrd/artifacts" })
    expect(plain).not.toContain("thousands of stdout lines")
    expect(plain).not.toContain("thousands of stderr lines")
  })

  it("marks a retry attempt (>1) in the step token as index:step#attempt", () => {
    const retry = log("yrd:jobs:merge", "error", "merge failed", {
      ...stepFailed.props,
      attempt: 2,
    } as Record<string, unknown>)
    expect(grammar(formatResidentLogLine(retry, { color: false }))).toContain("[main#324 2:merge#2] failed")
  })

  it("uses the shared short slug vocabulary in resident log rows", () => {
    const recutFailure = log("yrd:jobs:merge", "error", "merge failed", {
      ...stepFailed.props,
      error: { code: "recut-certificate-missing", message: "certificate absent" },
    } as Record<string, unknown>)

    expect(grammar(formatResidentLogLine(recutFailure, { color: false }))).toContain("err=recut-cert-missing")
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
    expect(plain).toBe(
      '18:40:23 ERROR yrd:queue:run [main#7] failed 120ms err=stale-pr cause="pinned base moved" · PR9.1 issue/stale',
    )
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

describe("resident runner notices", () => {
  it("keeps non-lifecycle DEBUG bookkeeping in JSONL only", () => {
    const processExit = log("yrd:process", "debug", "process exited", {
      argv: ["git", "status"],
      stdout: "large command output",
      exitCode: 0,
    })
    expect(formatResidentLogLine(processExit, { color: false })).toBeUndefined()
  })

  it("surfaces non-lifecycle DEBUG when the operator explicitly requested debug", () => {
    const processExit = log("yrd:process", "debug", "process exited", {
      argv: ["git", "status"],
      exitCode: 0,
    })
    const plain = formatResidentLogLine(processExit, { color: false, includeDebug: true })
    expect(plain).toContain("DEBUG yrd:process process exited")
    expect(plain).toContain('"exitCode":0')
  })

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
