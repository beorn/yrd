/**
 * @failure yrd pr submit/create fails closed on a 30s ls-remote/fetch timeout
 *          while a clear-window probe of the same ref is 1.8s and a loaded
 *          window is 45s+ — workers cannot merge (hh @i/16-work/bead-close-204).
 * @level l3
 * @consumer yrd pr submit / pr create origin advertisement
 */
import { describe, expect, it } from "vitest"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"
import { observeFreshRemoteBranch, observeOriginBranchAdvertisement } from "../src/remote-branch.ts"
import { GIT_PLUMBING_TIMEOUT_MS } from "../src/git-timeouts.ts"

function okLsRemote(): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "abc\trefs/heads/topic\n", stderr: "", durationMs: 2, timedOut: false }
}

function absentLsRemote(): ProcessResult {
  return { exitCode: 2, signal: null, stdout: "", stderr: "", durationMs: 2, timedOut: false }
}

function timedOut(): ProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: GIT_PLUMBING_TIMEOUT_MS,
    timedOut: true,
    verdict: "TIMED_OUT",
  }
}

function okFetch(): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 5, timedOut: false }
}

function okRevParse(): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    stderr: "",
    durationMs: 1,
    timedOut: false,
  }
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

describe("observeOriginBranchAdvertisement timeout retry", () => {
  it("retries a timed-out ls-remote and succeeds on a later attempt", async () => {
    const process = runner([timedOut(), timedOut(), okLsRemote()])
    const observed = await observeOriginBranchAdvertisement(process, "/repo", "topic")
    expect(observed).toEqual({ ok: true, advertised: true })
    expect(process.requests).toHaveLength(3)
    expect(process.requests[0]?.timeoutMs).toBe(GIT_PLUMBING_TIMEOUT_MS)
    expect(process.requests[0]?.argv).toEqual([
      "git",
      "-C",
      "/repo",
      "ls-remote",
      "--heads",
      "--exit-code",
      "origin",
      "refs/heads/topic",
    ])
  })

  it("does not retry an authoritative absence (exit 2)", async () => {
    const process = runner([absentLsRemote()])
    const observed = await observeOriginBranchAdvertisement(process, "/repo", "topic")
    expect(observed).toEqual({ ok: true, advertised: false })
    expect(process.requests).toHaveLength(1)
  })

  it("exhausts retries on a persistent timeout and stays loud", async () => {
    const process = runner([timedOut(), timedOut(), timedOut()])
    const observed = await observeOriginBranchAdvertisement(process, "/repo", "topic")
    expect(observed.ok).toBe(false)
    if (observed.ok) throw new Error("expected failure")
    expect(observed.timedOut).toBe(true)
    expect(observed.detail).toMatch(/timed out after 30000ms/)
    expect(process.requests).toHaveLength(3)
  })
})

describe("observeFreshRemoteBranch timeout retry", () => {
  it("retries a timed-out fetch, then resolves the tracking ref", async () => {
    const process = runner([timedOut(), okFetch(), okRevParse()])
    const observed = await observeFreshRemoteBranch(process, "/repo", "topic")
    expect(observed).toEqual({
      ok: true,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      target: "refs/remotes/origin/topic",
    })
    expect(process.requests).toHaveLength(3)
    expect(process.requests[0]?.argv.slice(0, 4)).toEqual(["git", "-C", "/repo", "fetch"])
  })
})
