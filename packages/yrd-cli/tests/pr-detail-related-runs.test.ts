// @failure A PR's detail pane lists queue runs the PR never rode in as RELATED RUNS
// @level l1
// @consumer @yrd/cli

import { currentPRRev, prBaseSha, prHead, prRevisionNumber, type PR } from "@yrd/bay"
import type { Run } from "@yrd/queue"
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
    state: "open",
    merged: false,
    revs: [{ n: 1, head: headSha, base: "main", baseSha: BASE_SHA, pushedAt: submittedAt, submittedAt }],
    submittedAt,
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

function fixtureRun(
  id: string,
  prs: readonly PR[],
  status: Run["status"],
  startedAt: string,
  conclusion?: Run["conclusion"],
): Run {
  return {
    id,
    queueId: "Q:main",
    candidateId: `C:${id}`,
    prs: prs.map((pr) => ({
      id: pr.id,
      name: pr.name,
      branch: pr.branch,
      base: pr.base,
      revision: prRevisionNumber(pr),
      headSha: prHead(pr),
      baseSha: prBaseSha(pr),
    })),
    base: "main",
    steps: [],
    startedAt,
    cursor: 0,
    shape: { results: {} },
    status,
    ...(conclusion === undefined ? {} : { conclusion }),
  }
}

describe("prDetailData related runs", () => {
  const pr1 = fixturePr("PR1", "2026-07-13T09:00:00.000Z")
  const pr2 = fixturePr("PR2", "2026-07-13T09:05:00.000Z")
  const pr1RetryRun = fixtureRun("R1", [pr1], "completed", "2026-07-13T10:00:00.000Z", "failure")
  const pr2Run = fixtureRun("R2", [pr2], "completed", "2026-07-13T10:30:00.000Z", "failure")
  const pr1LatestRun = fixtureRun("R3", [pr1], "in_progress", "2026-07-13T11:00:00.000Z")
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
