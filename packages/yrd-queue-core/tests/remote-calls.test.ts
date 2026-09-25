/**
 * @failure The fleet's GitHub logins were refused in bursts (25282) and nobody could say how many remote calls one
 *          round or one submit made: yrd's journal saw only its own Git rows, never Gitomic's reads or git-super's
 *          children, and no row counted SSH logins (25570 row 3).
 * @level   l2 (real git processes writing git's own trace2 event log; a stand-in ssh that runs upload-pack locally)
 * @consumer the round's `remote-calls` journal row and submit's stderr summary
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "../src/git.ts"
import { readRemoteCalls, traceRemoteCalls } from "../src/remote-calls.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

describe("remote calls are counted from git's trace2 event log", () => {
  it("counts each remote verb once per process and each ssh transport as a login", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-calls-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=calls@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    // An ssh that runs the remote command here: git still classifies the child as transport/ssh.
    const ssh = join(root, "fake-ssh")
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    chmodSync(ssh, 0o755)
    const trace = join(root, "trace2")
    mkdirSync(trace)
    const traced = gitIn(root, undefined, undefined, {
      env: { ...process.env, GIT_TRACE2_EVENT: trace, GIT_SSH_COMMAND: ssh },
    })

    await traced(["ls-remote", `ssh://calls.invalid${remote}`, "refs/heads/main"])
    await traced(["-C", seed, "fetch", "--quiet", "--no-tags", `ssh://calls.invalid${remote}`, "refs/heads/main"])
    await traced(["-C", seed, "fetch", "--quiet", "--no-tags", remote, "refs/heads/main"])
    await traced(["rev-parse", "--git-dir"]).catch(() => "")

    const calls = readRemoteCalls(trace)
    expect(calls.verbs).toEqual({ fetch: 2, "ls-remote": 1 })
    expect(calls.sshChildren).toBe(2)
    expect(calls.remoteMs).toBeGreaterThan(0)
    expect(calls.unreadable).toBe(0)
    expect(calls.processes).toBeGreaterThanOrEqual(4)
  }, 60_000)

  it("removes its trace directory once it has counted it, so no round leaves its trace2 log behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-calls-removed-"))
    roots.push(root)
    const directory = join(root, "logs", "round", "trace2")
    const traced = traceRemoteCalls(directory)
    await gitIn(root, undefined, undefined, { env: { ...process.env, ...traced.env } })([
      "init",
      "-q",
      join(root, "repo"),
    ])
    expect(traced.end().processes).toBeGreaterThanOrEqual(1)
    expect(existsSync(directory)).toBe(false)

    // A trace that cannot be read is still removed: the count failing is reported, the directory never kept.
    const unread = traceRemoteCalls(join(root, "unread", "trace2"))
    rmSync(join(root, "unread", "trace2"), { recursive: true })
    expect(() => unread.end()).toThrow(/trace2 directory/u)
    expect(existsSync(join(root, "unread", "trace2"))).toBe(false)
  })

  it("refuses a trace directory that does not exist, rather than reporting zero calls", () => {
    expect(() => readRemoteCalls(join(tmpdir(), "yrd-remote-calls-absent-25570"))).toThrow(/trace2 directory/u)
  })
})
