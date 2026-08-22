/**
 * @failure N=90 git calls per queue run at 20–40% per-call stall is
 *          overdetermined failure; a single-shot timeout cannot land.
 * @level l3
 * @consumer @yrd/queue createGit and @yrd/cli pr submit
 */
import { describe, expect, it } from "vitest"
import type { Process, ProcessRequest, ProcessResult } from "../src/index.ts"
import { runWithGitTimeoutRetry, withGitTimeoutRetry } from "../src/git-timeout-retry.ts"

function ok(): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "ok\n", stderr: "", durationMs: 2, timedOut: false }
}

function timedOut(): ProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 30_000,
    timedOut: true,
    verdict: "TIMED_OUT",
  }
}

function failed(): ProcessResult {
  return { exitCode: 1, signal: null, stdout: "", stderr: "fatal: auth", durationMs: 2, timedOut: false }
}

function runner(results: readonly ProcessResult[]): Pick<Process, "run"> & { requests: ProcessRequest[] } {
  const pending = [...results]
  const requests: ProcessRequest[] = []
  return {
    requests,
    async run(request) {
      requests.push(request)
      const next = pending.shift()
      if (next === undefined) throw new Error("test runner exhausted")
      return next
    },
  }
}

const gitRequest = {
  argv: ["git", "-C", "/repo", "ls-remote", "--exit-code", "origin", "main"],
  cwd: "/repo",
  timeoutMs: 30_000,
} satisfies ProcessRequest

describe("runWithGitTimeoutRetry", () => {
  it("retries a timed-out git child and succeeds on a later attempt", async () => {
    const process = runner([timedOut(), timedOut(), ok()])
    const delays: number[] = []
    const completed = await runWithGitTimeoutRetry(process, gitRequest, {
      delaysMs: [10, 20],
      sleep: async (delayMs) => void delays.push(delayMs),
    })
    expect(completed.timedOut).toBe(false)
    expect(completed.exitCode).toBe(0)
    expect(process.requests).toHaveLength(3)
    expect(delays).toEqual([10, 20])
  })

  it("does not retry a non-timeout git failure or a non-git command", async () => {
    const gitFail = runner([failed()])
    expect((await runWithGitTimeoutRetry(gitFail, gitRequest)).exitCode).toBe(1)
    expect(gitFail.requests).toHaveLength(1)

    const other = runner([timedOut()])
    const completed = await runWithGitTimeoutRetry(
      other,
      { argv: ["bash", "-c", "sleep 1"], cwd: "/repo" },
      { delaysMs: [10] },
    )
    expect(completed.timedOut).toBe(true)
    expect(other.requests).toHaveLength(1)
  })

  it("exhausts retries on a persistent timeout and returns the last timeout", async () => {
    const process = runner([timedOut(), timedOut(), timedOut()])
    const completed = await runWithGitTimeoutRetry(process, gitRequest, {
      delaysMs: [0, 0],
      sleep: async () => undefined,
      announce: () => undefined,
    })
    expect(completed.timedOut).toBe(true)
    expect(process.requests).toHaveLength(3)
  })
})

describe("withGitTimeoutRetry", () => {
  it("wraps run() so callers share one policy", async () => {
    const inner = runner([timedOut(), ok()])
    const wrapped = withGitTimeoutRetry(inner, { delaysMs: [0], sleep: async () => undefined })
    const completed = await wrapped.run(gitRequest)
    expect(completed.exitCode).toBe(0)
    expect(inner.requests).toHaveLength(2)
  })

  it("opens a consecutive-timeout breaker and fails through without spawning", async () => {
    const inner = runner([timedOut(), timedOut(), timedOut(), ok()])
    const announcements: string[] = []
    const wrapped = withGitTimeoutRetry(inner, {
      delaysMs: [0, 0, 0, 0],
      sleep: async () => undefined,
      consecutiveTimeoutLimit: 3,
      announce: (message) => void announcements.push(message),
    })
    const first = await wrapped.run(gitRequest)
    expect(first.timedOut).toBe(true)
    expect(inner.requests).toHaveLength(3)
    expect(announcements).toHaveLength(1)
    expect(announcements[0]).toContain("circuit breaker open")
    expect(announcements[0]).toContain("3 consecutive timeouts")

    const second = await wrapped.run(gitRequest)
    expect(second.timedOut).toBe(true)
    expect(second.stderr).toContain("circuit breaker open")
    expect(inner.requests).toHaveLength(3)
  })

  it("resets consecutive timeouts on a non-timeout git answer", async () => {
    const inner = runner([timedOut(), timedOut(), failed(), timedOut(), ok()])
    const wrapped = withGitTimeoutRetry(inner, {
      delaysMs: [0],
      sleep: async () => undefined,
      consecutiveTimeoutLimit: 3,
      announce: () => undefined,
    })
    expect((await wrapped.run(gitRequest)).timedOut).toBe(true)
    expect((await wrapped.run({ ...gitRequest, argv: ["git", "status"] })).exitCode).toBe(1)
    const recovered = await wrapped.run(gitRequest)
    expect(recovered.timedOut).toBe(false)
    expect(recovered.exitCode).toBe(0)
    expect(inner.requests).toHaveLength(5)
  })

  it("closes the breaker after its window and attempts again", async () => {
    let nowMs = 1_000
    const inner = runner([timedOut(), timedOut(), timedOut(), ok()])
    const wrapped = withGitTimeoutRetry(inner, {
      delaysMs: [0, 0],
      sleep: async () => undefined,
      consecutiveTimeoutLimit: 3,
      breakerWindowMs: 60_000,
      now: () => nowMs,
      announce: () => undefined,
    })
    expect((await wrapped.run(gitRequest)).timedOut).toBe(true)
    expect(inner.requests).toHaveLength(3)
    const inWindow = await wrapped.run(gitRequest)
    expect(inWindow.timedOut).toBe(true)
    expect(inWindow.stderr).toContain("circuit breaker open")
    expect(inner.requests).toHaveLength(3)
    nowMs += 60_000
    const recovered = await wrapped.run(gitRequest)
    expect(recovered.exitCode).toBe(0)
    expect(inner.requests).toHaveLength(4)
  })
})
