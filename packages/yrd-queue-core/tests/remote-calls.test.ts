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
import { createLegacyBackend, gitIn, readRemoteCommit } from "../src/git.ts"
import { readRemoteCalls, roundRemoteCallsRow, traceRemoteCalls, withRemoteSeam } from "../src/remote-calls.ts"

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

  /** @failure A round's total hid the 15 component-main refreshes, so its beyond-refresh SSH cost was unknowable. */
  it("keeps a proven refresh split and names the SSH commands after Trace2 is removed (26232)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-round-refresh-"))
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
    const ssh = join(root, "fake-ssh")
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    chmodSync(ssh, 0o755)
    const trace = traceRemoteCalls(join(root, "trace2"), { refresh: true })
    const base = { ...process.env, ...trace.env, GIT_SSH_COMMAND: ssh }
    const url = `ssh://calls.invalid${remote}`
    await git(["remote", "add", "origin", url])
    await gitIn(seed, undefined, undefined, { env: { ...base, GIT_SUPER_PHASE: "refresh" } })([
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ])
    await gitIn(seed, undefined, undefined, { env: base })(["ls-remote", url, "refs/heads/main"])
    const row = roundRemoteCallsRow(trace.end())
    expect(row).toMatchObject({
      ssh_children: 2,
      refresh_ssh_children: 1,
      beyond_refresh_ssh_children: 1,
      unreadable: 0,
    })
    expect(row.refresh_calls).toEqual([`1 fetch @ ${seed}`])
    expect(row.beyond_refresh_calls).toEqual([`1 ls-remote @ ${seed}`])
    expect(existsSync(join(root, "trace2"))).toBe(false)

    // An older git-super still makes the same refresh fetch but cannot mark it;
    // the round must warn instead of publishing a plausible zero refresh count.
    const oldTrace = traceRemoteCalls(join(root, "old-trace2"), { refresh: true })
    await gitIn(seed, undefined, undefined, {
      env: { ...process.env, ...oldTrace.env, GIT_SSH_COMMAND: ssh },
    })(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"])
    expect(() => roundRemoteCallsRow(oldTrace.end())).toThrow(/untagged component-main refresh/u)
    expect(existsSync(join(root, "old-trace2"))).toBe(false)

    // Submit observes the same Git call but has no round refresh boundary.
    const submitTrace = traceRemoteCalls(join(root, "submit-trace2"), { seams: true })
    await gitIn(seed, undefined, undefined, {
      env: { ...process.env, ...submitTrace.env, GIT_SSH_COMMAND: ssh },
    })(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"])
    expect(submitTrace.end().sshChildren).toBe(1)
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

  it("attributes real Git and Gitomic remote reads to their calling seams (25626)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-seams-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=seams@yrd.test",
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
    const traced = traceRemoteCalls(join(root, "trace2"), { seams: true })
    const caller = gitIn(seed, undefined, undefined, { env: { ...process.env, ...traced.env } })
    expect(await withRemoteSeam("readRemoteCommit", () => readRemoteCommit(caller, remote, "refs/heads/main"))).toMatch(
      /^[0-9a-f]{40}$/u,
    )
    await withRemoteSeam("listBranch", () => caller(["ls-remote", remote, "refs/heads/main"]))
    await caller(["ls-remote", remote, "refs/heads/main"])
    const calls = traced.end()
    expect(calls.seams).toMatchObject({
      readRemoteCommit: { fetch: 1 },
      listBranch: { "ls-remote": 1 },
    })
    expect(calls.seams.unattributed).toMatchObject({ "ls-remote": 1 })
    expect(calls.unreadable).toBe(0)
  })

  it("labels each fetch on one long-lived Gitomic backend with its calling seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-gitomic-seams-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=seams@yrd.test",
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
    const traced = traceRemoteCalls(join(root, "trace2"), { seams: true })
    const backend = createLegacyBackend()
    const store = (await git(["rev-parse", "--absolute-git-dir"])).trim()
    if (backend.fetchRefs === undefined) throw new Error("Gitomic backend lacks fetchRefs")
    await withRemoteSeam("firstRead", () => backend.fetchRefs!(store, "refs/heads/main", remote))
    await withRemoteSeam("secondRead", () => backend.fetchRefs!(store, "refs/heads/main", remote))
    const calls = traced.end()
    expect(calls.seams.firstRead?.fetch).toBe(1)
    expect(calls.seams.secondRead?.fetch).toBe(1)
    expect(calls.seams.unattributed).toBeUndefined()
  })

  it("refuses a trace directory that does not exist, rather than reporting zero calls", () => {
    expect(() => readRemoteCalls(join(tmpdir(), "yrd-remote-calls-absent-25570"))).toThrow(/trace2 directory/u)
  })
})
