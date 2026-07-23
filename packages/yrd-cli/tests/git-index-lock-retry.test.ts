/**
 * @failure Transient Git index-lock contention escapes Yrd as a raw failure, so operators delete locks by hand.
 * @level l3
 * @consumer @yrd/cli composition root
 */
import { describe, expect, it } from "vitest"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"
import { runWithGitIndexLockRetry, withGitIndexLockRetry } from "../src/git-index-lock-retry.ts"

function result(exitCode: number, stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, durationMs: 1, timedOut: false }
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
  argv: ["git", "-C", "/repo", "update-ref", "refs/heads/main", "abc"],
  cwd: "/repo",
} satisfies ProcessRequest

describe("runWithGitIndexLockRetry", () => {
  it("retries exact index-lock contention with bounded backoff, then returns success", async () => {
    const process = runner([
      result(128, "fatal: Unable to create '/repo/.git/index.lock': File exists."),
      result(128, "fatal: Unable to create '/repo/.git/index.lock': File exists."),
      result(0),
    ])
    const delays: number[] = []

    const completed = await runWithGitIndexLockRetry(process, gitRequest, {
      delaysMs: [10, 20],
      sleep: async (delayMs) => void delays.push(delayMs),
    })

    expect(completed.exitCode).toBe(0)
    expect(process.requests).toHaveLength(3)
    expect(delays).toEqual([10, 20])
  })

  it("does not retry another Git failure or a non-Git command with lock-like stderr", async () => {
    const auth = runner([result(1, "fatal: authentication failed")])
    expect((await runWithGitIndexLockRetry(auth, gitRequest)).exitCode).toBe(1)
    expect(auth.requests).toHaveLength(1)

    const shell = runner([result(1, "fatal: Unable to create '/repo/.git/index.lock': File exists.")])
    expect(
      (
        await runWithGitIndexLockRetry(
          shell,
          { argv: ["sh", "-c", "echo safe"], cwd: "/repo" },
          {
            delaysMs: [0],
          },
        )
      ).exitCode,
    ).toBe(1)
    expect(shell.requests).toHaveLength(1)
  })

  it("returns the final Git failure with a safe, actionable alternative after exhaustion", async () => {
    const locked = result(128, "fatal: Unable to create '/repo/.git/index.lock': File exists.")
    const process = runner([locked, locked, locked])

    const completed = await runWithGitIndexLockRetry(process, gitRequest, {
      delaysMs: [0, 0],
      sleep: async () => undefined,
    })

    expect(process.requests).toHaveLength(3)
    expect(completed.stderr).toContain("Yrd retried Git index-lock contention 3 times")
    expect(completed.stderr).toMatch(/wait for the active Git writer/iu)
    expect(completed.stderr).toContain("Never delete a live lock")
  })

  it("preserves the Process lifecycle at the CLI composition root", async () => {
    let closes = 0
    let disposals = 0
    const process: Process = {
      run: async () => result(0),
      close: async () => void (closes += 1),
      [Symbol.asyncDispose]: async () => void (disposals += 1),
    }

    const wrapped = withGitIndexLockRetry(process)
    await wrapped.close()
    await wrapped[Symbol.asyncDispose]()

    expect(closes).toBe(1)
    expect(disposals).toBe(1)
  })
})
