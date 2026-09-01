/**
 * @failure A check that was KILLED before it could judge the content reports the
 * same shape as a check that judged it and said no, so every consumer downstream
 * has to guess which one it holds — and guessing wrong bills a queue fault to
 * the author.
 *
 * The specimen, 2026-09-01: admission PR3141 rev1 ran step `3-affected-tests`
 * for 15m45s against a host carrying a load of 40-61, and the step's import
 * phase went quiet long enough for the no-progress watchdog to kill it. The
 * queue read `affected-tests-stalled` as an ordinary red, retired the author's
 * standing submit fact, and told them to push a fresh sha. Nothing had judged
 * their change; the host was busy.
 *
 * The cure is a fact, not a list. `code` keeps naming the specific fault, and a
 * second field says whether the process ever reached a verdict — written once,
 * where both halves are in hand, and read as a boolean everywhere else. A code
 * list cannot do this job: the codes are built from CONFIGURED step names, so
 * every repository invents its own and any list is wrong the day a step is
 * added. `affected-tests-stalled` was in no list, which is exactly why PR3141
 * was consumed.
 * @level l2
 * @consumer @yrd/queue command steps, @yrd/queue admission
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ProcessResult } from "@yrd/process"
import { CommandEvidenceSchema, configuredCommandStep } from "@yrd/queue"
import type { ChangeShape } from "@yrd/queue"

const FIXTURE_CHANGE_ID = `I${"c0ffee12".repeat(5)}`
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function runStep(
  result: ProcessResult,
  options: Readonly<{ noProgressTimeoutMs?: number; timeoutMs?: number }> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "yrd-verdictless-"))
  roots.push(cwd)
  const step = configuredCommandStep<ChangeShape>({
    inject: { process: { run: () => Promise.resolve(result) } },
    command: ["false"],
    cwd,
    purpose: "check",
    artifactRoot: join(cwd, "artifacts"),
    ...options,
  })
  return step(
    {
      run: "R1",
      step: "check",
      index: 0,
      prs: [
        {
          id: "PR1",
          changeId: FIXTURE_CHANGE_ID,
          branch: "issue/feature",
          base: "main",
          revision: 1,
          headSha: "a".repeat(40),
        },
      ],
      shape: { results: {} },
    },
    { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
  )
}

function failure(outcome: Awaited<ReturnType<typeof runStep>>) {
  if (outcome.status !== "completed" || outcome.conclusion !== "failure") {
    throw new Error(`configured command was ${outcome.status}`)
  }
  return outcome
}

/** The judged line the check itself printed. Present in every JUDGED case below
 * so the discrimination cannot be read off "did the output say anything" — a
 * killed process may well have printed a failing name before it died, which is
 * precisely the case a second, independently-derived boolean would get wrong. */
const JUDGED_OUTPUT = " FAIL  src/thing.test.ts > it adds two numbers\n"

describe("a check killed before it could judge the content says so", () => {
  it("marks an output-progress stall verdictless — the PR3141 specimen", async () => {
    const outcome = failure(
      await runStep(
        {
          exitCode: 137,
          signal: "SIGKILL",
          stdout: "partial output\n",
          stderr: "",
          durationMs: 945_000,
          timedOut: false,
          stalled: true,
          verdict: "STALLED",
          lastProgressAtMs: 120_000,
          lastProgressBytes: 42,
        },
        { noProgressTimeoutMs: 120_000 },
      ),
    )

    expect(outcome.error.code).toBe("check-stalled")
    expect(outcome.error.verdictless, "a watchdog kill is never a verdict on the content").toBe(true)
    // The whole point of the second field: `code` is unchanged, so every
    // existing reader that keys on it keeps working, and nobody has to enumerate
    // which configured step names can stall.
    expect(outcome.error.message).toContain("stalled after 120000ms")
  })

  it("marks a wall-clock settlement verdictless", async () => {
    const outcome = failure(
      await runStep(
        {
          exitCode: 143,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          durationMs: 600_000,
          timedOut: true,
          verdict: "TIMED_OUT",
        },
        { timeoutMs: 600_000 },
      ),
    )

    expect(outcome.error.code).toBe("check-timeout")
    expect(outcome.error.verdictless).toBe(true)
  })

  it("marks a SIGKILL verdictless even when the check had already printed a failing name", async () => {
    // The case that makes this ONE decision rather than two booleans. An
    // out-of-memory kill lands on a process mid-run, so its output can carry a
    // judged line AND the process can have been killed. Deriving "was it
    // judged" separately from "was it killed" reads true for both, and a reader
    // holding both has no rule for which wins.
    const outcome = failure(
      await runStep({
        exitCode: 137,
        signal: null,
        stdout: JUDGED_OUTPUT,
        stderr: "",
        durationMs: 4_000,
        timedOut: false,
      }),
    )

    expect(outcome.error.code).toBe("check-infrastructure-signal")
    expect(outcome.error.verdictless).toBe(true)
    const evidence = CommandEvidenceSchema.parse(outcome.output)
    expect(evidence.judgedFailure, "killed and judged are mutually exclusive by construction").toBeUndefined()
  })

  it("marks an escaped descendant verdictless even though the child exited zero", async () => {
    const outcome = failure(
      await runStep({
        exitCode: 0,
        signal: null,
        stdout: JUDGED_OUTPUT,
        stderr: "",
        durationMs: 30_000,
        timedOut: false,
        stalled: true,
        verdict: "STALLED",
        lastProgressAtMs: 20_000,
        lastProgressBytes: 8,
        escapedDescendant: true,
      }),
    )

    expect(outcome.error.code).toBe("check-stalled-escaped-descendant")
    expect(outcome.error.verdictless).toBe(true)
  })

  it("records the host load beside a verdictless outcome, and only there", async () => {
    // Cheap and decisive for whoever reads the failure next: the specimen's
    // answer was a load of 40-61 on a host running parallel full suites, and
    // nothing in the record said so.
    const stalled = failure(
      await runStep(
        {
          exitCode: 137,
          signal: "SIGKILL",
          stdout: "",
          stderr: "",
          durationMs: 945_000,
          timedOut: false,
          stalled: true,
          verdict: "STALLED",
          lastProgressAtMs: 120_000,
          lastProgressBytes: 0,
        },
        { noProgressTimeoutMs: 120_000 },
      ),
    )
    const stalledEvidence = CommandEvidenceSchema.parse(stalled.output)
    expect(stalledEvidence.loadAverage).toHaveLength(3)
    for (const sample of stalledEvidence.loadAverage ?? []) expect(sample).toBeGreaterThanOrEqual(0)

    const judged = failure(
      await runStep({
        exitCode: 1,
        signal: null,
        stdout: JUDGED_OUTPUT,
        stderr: "",
        durationMs: 4_000,
        timedOut: false,
      }),
    )
    expect(
      CommandEvidenceSchema.parse(judged.output).loadAverage,
      "a judged red already names its own cause; the host's load is not it",
    ).toBeUndefined()
  })
})

describe("a check that ran to its own exit is NOT verdictless", () => {
  it("leaves an ordinary judged red unmarked", async () => {
    const outcome = failure(
      await runStep({
        exitCode: 1,
        signal: null,
        stdout: JUDGED_OUTPUT,
        stderr: "",
        durationMs: 4_000,
        timedOut: false,
      }),
    )

    expect(outcome.error.code).toBe("check-failed")
    expect(outcome.error.verdictless, "the check ran to its own exit and said what failed").toBeUndefined()
    expect(CommandEvidenceSchema.parse(outcome.output).judgedFailure).toBe(true)
  })

  it("leaves a red whose output states nothing unmarked too", async () => {
    // Absent means "not known to be verdictless", never "judged". A red this
    // cannot read is still a process that chose to exit nonzero, so it keeps
    // the ordinary retry threshold rather than being promoted to an
    // infrastructure fault on the strength of an unparsed message.
    const outcome = failure(
      await runStep({
        exitCode: 2,
        signal: null,
        stdout: "something went wrong somewhere\n",
        stderr: "",
        durationMs: 4_000,
        timedOut: false,
      }),
    )

    expect(outcome.error.verdictless).toBeUndefined()
    expect(CommandEvidenceSchema.parse(outcome.output).judgedFailure).toBeUndefined()
  })

  it("leaves a success with no error at all", async () => {
    const outcome = await runStep({
      exitCode: 0,
      signal: null,
      stdout: "all good\n",
      stderr: "",
      durationMs: 4_000,
      timedOut: false,
    })

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
  })
})
