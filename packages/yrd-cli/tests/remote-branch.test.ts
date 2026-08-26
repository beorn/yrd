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

function okCommonDir(): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "/repo/.git\n", stderr: "", durationMs: 1, timedOut: false }
}

function noStore(): ProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: "fatal: not a git repository: '/repo/.git/yrd/prs.git'",
    durationMs: 1,
    timedOut: false,
  }
}

function storeRefMissing(): ProcessResult {
  return { exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }
}

function okStoreRef(sha: string): ProcessResult {
  return { exitCode: 0, signal: null, stdout: `${sha}\n`, stderr: "", durationMs: 1, timedOut: false }
}

function failedFetch(): ProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: "fatal: couldn't find remote ref refs/heads/topic",
    durationMs: 5,
    timedOut: false,
  }
}

const STORE_GIT_DIR = "--git-dir=/repo/.git/yrd/prs.git"

describe("observeFreshRemoteBranch timeout retry", () => {
  it("retries a timed-out fetch, then resolves the tracking ref", async () => {
    const process = runner([okCommonDir(), noStore(), timedOut(), okFetch(), okRevParse()])
    const observed = await observeFreshRemoteBranch(process, "/repo", "topic")
    expect(observed).toEqual({
      ok: true,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      target: "refs/remotes/origin/topic",
    })
    expect(process.requests).toHaveLength(5)
    expect(process.requests[2]?.argv.slice(0, 4)).toEqual(["git", "-C", "/repo", "fetch"])
  })
})

describe("observeFreshRemoteBranch receiver-store-first resolution", () => {
  // The PR2081 shape (@i/10-merge-queue/refsfor-withdrawn-carrier): a
  // `refs/for/main/<issue>` push mints carrier `issue/<issue>` in the
  // repository's OWN receiver store, origin never hears of it, and the origin
  // observation's authoritative "absent" withdrew the change seconds after its
  // own intake. The store must answer first, and origin must not be asked at
  // all for a branch the store owns.
  const CARRIER = "issue/@i/10-merge-queue/22991-branch-is-change-delete-the-pr-record"
  const CARRIER_SHA = "b383a622da8605bdebaf2c03b6633d77b2a2e7c9"

  it("resolves a refs/for-minted carrier from the store's submit ref and never contacts origin", async () => {
    const process = runner([okCommonDir(), storeRefMissing(), okStoreRef(CARRIER_SHA)])
    const observed = await observeFreshRemoteBranch(process, "/repo", CARRIER)
    expect(observed).toEqual({ ok: true, head: CARRIER_SHA, target: `refs/yrd/submit/${CARRIER}` })
    // Exactly the three local probes: common-dir, store refs/heads, store
    // submit ref. No fetch and no ls-remote ever left the machine.
    expect(process.requests).toHaveLength(3)
    expect(process.requests[1]?.argv).toContain(STORE_GIT_DIR)
    expect(process.requests[2]?.argv).toContain(`refs/yrd/submit/${CARRIER}^{commit}`)
    expect(process.requests.some((request) => request.argv.includes("fetch"))).toBe(false)
    expect(process.requests.some((request) => request.argv.includes("ls-remote"))).toBe(false)
  })

  it("resolves a branch delivered straight to the receiver from the store's refs/heads", async () => {
    const process = runner([okCommonDir(), okStoreRef(CARRIER_SHA)])
    const observed = await observeFreshRemoteBranch(process, "/repo", "task/bay-delivered")
    expect(observed).toEqual({ ok: true, head: CARRIER_SHA, target: "refs/heads/task/bay-delivered" })
    expect(process.requests).toHaveLength(2)
    expect(process.requests[1]?.argv).toContain("refs/heads/task/bay-delivered^{commit}")
  })

  it("keeps full origin authority when no receiver store exists (the ordinary repository)", async () => {
    // Exit 128 on the first store probe says there is no store repository at
    // all; the second store spelling is pointless and origin's flow is
    // byte-identical to before the store existed.
    const process = runner([okCommonDir(), noStore(), okFetch(), okRevParse()])
    const observed = await observeFreshRemoteBranch(process, "/repo", "topic")
    expect(observed).toEqual({
      ok: true,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      target: "refs/remotes/origin/topic",
    })
    expect(process.requests).toHaveLength(4)
    expect(process.requests[1]?.argv).toContain(STORE_GIT_DIR)
    expect(process.requests[2]?.argv.slice(0, 4)).toEqual(["git", "-C", "/repo", "fetch"])
  })

  it("still reports authoritative absence when neither the store nor origin owns the branch", async () => {
    const process = runner([okCommonDir(), storeRefMissing(), storeRefMissing(), failedFetch(), absentLsRemote()])
    const observed = await observeFreshRemoteBranch(process, "/repo", "topic")
    expect(observed.ok).toBe(false)
    if (observed.ok) throw new Error("expected failure")
    expect(observed.phase).toBe("absent")
    expect(observed.detail).toContain("origin no longer advertises 'refs/heads/topic'")
    expect(observed.detail).toContain("the receiver store does not own 'topic'")
  })

  it("refuses to answer when the store probe times out, instead of letting origin declare absence", async () => {
    // A store that cannot be read is not evidence of anything; falling
    // through to origin here would let a local transport fault mature into an
    // authoritative "absent" and, downstream, a withdraw.
    const process = runner([okCommonDir(), timedOut(), timedOut(), timedOut()])
    const observed = await observeFreshRemoteBranch(process, "/repo", CARRIER)
    expect(observed.ok).toBe(false)
    if (observed.ok) throw new Error("expected failure")
    expect(observed.phase).toBe("fetch")
    expect(observed.detail).toContain("receiver store did not answer")
  })
})
