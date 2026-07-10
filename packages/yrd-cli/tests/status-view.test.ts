/**
 * @failure Contest status hides held-out evaluator verdicts or evidence, or loses attempt identity when narrow.
 * @level l1
 * @consumer @yrd/cli contest status
 */
import type {
  Contest,
  ContestArtifact,
  ContestAttempt,
  ContestEvaluation,
  ContestEvaluationRun,
  EvaluatorResult,
} from "@yrd/contest"
import type { Job } from "@yrd/job"
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { ContestStatusView } from "../src/status-view.tsx"

const BASE_SHA = "a".repeat(40)
const AT = "2026-07-09T12:01:00.000Z"

function artifact(attempt: string, kind: string, file: string): ContestArtifact {
  return { kind, uri: `file:///evidence/${attempt}/${file}` }
}

function settledRun(
  evaluator: string,
  generation: number,
  verdict: "passed" | "failed",
  summary: string,
  artifacts: readonly ContestArtifact[],
): ContestEvaluationRun {
  const result: EvaluatorResult = { verdict, summary, artifacts }
  const job: Job = {
    id: `job-${evaluator}-${generation}`,
    definition: `contest.evaluator.${evaluator}`,
    revision: String(generation),
    input: {},
    attempt: 1,
    requestedAt: AT,
    changedAt: AT,
    status: "passed",
    startedAt: AT,
    executor: "test",
    finishedAt: AT,
    output: result,
  }
  return { generation, job, result }
}

function evaluation(
  evaluator: string,
  verdict: "passed" | "failed",
  summary: string,
  artifacts: readonly ContestArtifact[],
  authority: "held-out" | "advisory" = "held-out",
): ContestEvaluation {
  return { evaluator, authority, runs: [settledRun(evaluator, 1, verdict, summary, artifacts)] }
}

function waitingEvaluation(evaluator: string): ContestEvaluation {
  const job: Job = {
    id: `job-${evaluator}`,
    definition: `contest.evaluator.${evaluator}`,
    revision: "1",
    input: {},
    attempt: 1,
    requestedAt: AT,
    changedAt: AT,
    status: "waiting",
    startedAt: AT,
    executor: "test",
    token: "resume-token",
    detail: "awaiting external evaluator",
    url: "https://example.test/jobs/gate",
  }
  return { evaluator, authority: "held-out", runs: [{ generation: 1, job }] }
}

function attempt(
  id: string,
  status: ContestAttempt["status"],
  evaluations: Readonly<Record<string, ContestEvaluation>>,
): ContestAttempt {
  return {
    id,
    competitor: { id: `competitor-${id}`, model: `model-${id}`, harness: "ag", config: {} },
    bayName: `contest-c1-${id.toLowerCase()}`,
    branch: `contest/c1/${id.toLowerCase()}`,
    base: "main",
    status,
    evaluations,
    artifacts: [],
  }
}

function contestFixture(): Contest {
  const a1OldManifest = artifact("A1/old", "evaluator-manifest", "manifest.json")
  const a1Manifest = artifact("A1", "evaluator-manifest", "manifest.json")
  const a1Stdout = artifact("A1", "stdout", "stdout.log")
  const a1GateStdout = artifact("A1/gate", "stdout", "stdout.log")
  const a2Manifest = artifact("A2", "evaluator-manifest", "manifest.json")
  const a2Stdout = artifact("A2", "stdout", "stdout.log")

  return {
    id: "C1",
    task: { ref: { source: "km", id: "T1" }, title: "Exercise contest status" },
    base: "main",
    baseSha: BASE_SHA,
    createdAt: "2026-07-09T12:00:00.000Z",
    evaluators: [
      { id: "verify", authority: "held-out" },
      { id: "gate", authority: "held-out" },
      { id: "review", authority: "advisory" },
    ],
    attemptOrder: ["A1", "A2"],
    attempts: {
      A1: attempt("A1", "passing", {
        verify: {
          evaluator: "verify",
          authority: "held-out",
          runs: [
            settledRun("verify", 1, "failed", "old private failure", [a1OldManifest]),
            settledRun("verify", 2, "passed", "verify exited 0", [a1Stdout, a1Manifest]),
          ],
        },
        gate: evaluation("gate", "passed", "gate exited 0", [a1GateStdout]),
        review: evaluation("review", "failed", "advisory only", [], "advisory"),
      }),
      A2: attempt("A2", "waiting", {
        verify: evaluation("verify", "failed", "two private failures", [a2Stdout, a2Manifest]),
        gate: waitingEvaluation("gate"),
        review: evaluation("review", "passed", "advisory only", [], "advisory"),
      }),
    },
    status: "running",
  }
}

async function render(contest: Contest, width: number, plain = true): Promise<string> {
  return renderString(createElement(ContestStatusView, { contest }), { width, height: 100, plain })
}

describe("ContestStatusView held-out evaluations", () => {
  it("shows every evaluation generation with its verdict and summary", async () => {
    const output = await render(contestFixture(), 160)
    const rows = output.split("\n").filter((line) => /\b(?:verify|gate)\b/u.test(line))

    expect(rows).toHaveLength(5)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/A1\s+passing\s+verify\s+1\s+failed\s+old private failure/u),
        expect.stringMatching(/A1\s+passing\s+verify\s+2\s+passed\s+verify exited 0/u),
        expect.stringMatching(/A1\s+passing\s+gate\s+1\s+passed\s+gate exited 0/u),
        expect.stringMatching(/A2\s+waiting\s+verify\s+1\s+failed\s+two private failures/u),
        expect.stringMatching(/A2\s+waiting\s+gate\s+1\s+waiting\s+awaiting external evaluator/u),
      ]),
    )
    expect(output).not.toContain("advisory only")
  })

  it("links only the primary evidence artifact in each evaluator row", async () => {
    const output = await render(contestFixture(), 160, false)

    expect(output).toContain("file:///evidence/A1/old/manifest.json")
    expect(output).toContain("file:///evidence/A1/manifest.json")
    expect(output).not.toContain("file:///evidence/A1/stdout.log")
    expect(output).toContain("file:///evidence/A1/gate/stdout.log")
    expect(output).toContain("file:///evidence/A2/manifest.json")
    expect(output).not.toContain("file:///evidence/A2/stdout.log")
    expect(output).toContain("https://example.test/jobs/gate")
  })

  it("preserves each evaluation row's attempt ID and state while shrinking", async () => {
    const output = await render(contestFixture(), 26)
    const lines = output.split("\n")

    expect(lines.filter((line) => /A1\s+passing/u.test(line))).toHaveLength(3)
    expect(lines.filter((line) => /A2\s+waiting/u.test(line))).toHaveLength(2)
  })
})
