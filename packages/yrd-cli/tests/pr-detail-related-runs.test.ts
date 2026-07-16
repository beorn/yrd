// @failure A PR's detail pane lists queue runs the PR never rode in as RELATED RUNS
// @level l1
// @consumer @yrd/cli

import type { PR } from "@yrd/bay"
import type { QueueRun } from "@yrd/queue"
import { describe, expect, test } from "vitest"
import { prDetailData } from "../src/queue-status-view.tsx"

const BASE_SHA = "a".repeat(40)

function fixturePr(id: string, submittedAt: string): PR {
  const digit = id.replace(/\D/gu, "").at(-1) ?? "1"
  const headSha = digit.repeat(40)
  return {
    id,
    name: `Fixture ${id}`,
    branch: `topic/${id.toLocaleLowerCase()}`,
    base: "main",
    status: "submitted",
    revision: 1,
    headSha,
    baseSha: BASE_SHA,
    revisions: [{ revision: 1, headSha, base: "main", baseSha: BASE_SHA, pushedAt: submittedAt, submittedAt }],
    submittedAt,
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

function fixtureRun(id: string, prs: readonly PR[], status: QueueRun["status"], startedAt: string): QueueRun {
  return {
    id,
    prs: prs.map((pr) => ({
      id: pr.id,
      name: pr.name,
      branch: pr.branch,
      base: pr.base,
      revision: pr.revision,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    })),
    base: "main",
    steps: [],
    startedAt,
    cursor: 0,
    shape: { results: {} },
    status,
  }
}

describe("prDetailData related runs", () => {
  const pr1 = fixturePr("PR1", "2026-07-13T09:00:00.000Z")
  const pr2 = fixturePr("PR2", "2026-07-13T09:05:00.000Z")
  const pr1RetryRun = fixtureRun("R1", [pr1], "failed", "2026-07-13T10:00:00.000Z")
  const pr2Run = fixtureRun("R2", [pr2], "failed", "2026-07-13T10:30:00.000Z")
  const pr1LatestRun = fixtureRun("R3", [pr1], "running", "2026-07-13T11:00:00.000Z")
  const runs = [pr1RetryRun, pr2Run, pr1LatestRun]

  test("includes only runs the PR is a member of, keeping order", () => {
    const detail = prDetailData(pr1, runs)

    expect(detail.runs.map((run) => run.run)).toEqual(["R1", "R3"])
    expect(detail.run?.run).toBe("R3")
  })

  test("a sibling PR sees only its own runs", () => {
    const detail = prDetailData(pr2, runs)

    expect(detail.runs.map((run) => run.run)).toEqual(["R2"])
    expect(detail.run?.run).toBe("R2")
  })
})
