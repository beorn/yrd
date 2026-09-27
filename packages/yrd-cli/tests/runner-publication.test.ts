/**
 * @failure A runner could overwrite a second live runner, or refuse a safe restart after a stopped claim.
 * @level l2 (two real Git repositories and a leased remote ref)
 * @consumer the resident queue runner and off-machine status readers
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, readRemoteCommit, runnerRef, type RunnerClaim } from "@yrd/queue-core"
import { readPublishedRunner, RunnerPublisher } from "../src/runner-publication.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yrd-runner-ref-"))
  roots.push(root)
  const boot = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await boot(["init", "--quiet", "--bare", remote])
  await boot(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "runner@yrd.test"])
  await git(["config", "user.name", "yrd runner"])
  const now = new Date().toISOString()
  const own: RunnerClaim = {
    host: "host",
    pid: 42,
    started: now,
    at: now,
    beatMs: 60_000,
    state: "idle",
    since: now,
  }
  const statuses: string[] = []
  const notices: string[] = []
  const publisher = new RunnerPublisher(
    git,
    "origin",
    "main",
    (status) => statuses.push(status.kind),
    (notice) => notices.push(notice),
  )
  const ref = runnerRef("main")
  const remoteTip = () => readRemoteCommit(git, "origin", ref)
  const replace = async (claim: RunnerClaim) => {
    const tree = (await git(["mktree"], "")).trim()
    const body = `yrd runner claim\n\nRunner: ${claim.host}/${String(claim.pid)}\nStarted: ${claim.started}\nAt: ${claim.at}\nBeat: ${String(claim.beatMs)}ms\nState: ${claim.state}\nSince: ${claim.since}\n`
    const oid = (await git(["commit-tree", tree, "-m", body])).trim()
    const prior = await remoteTip()
    await git(["push", "--quiet", `--force-with-lease=${ref}:${prior ?? "0".repeat(40)}`, "origin", `${oid}:${ref}`])
    return oid
  }
  return { git, own, publisher, ref, remoteTip, replace, statuses, notices }
}

describe("runner ref publication", () => {
  it("creates a leased parentless claim readable without a local journal", async () => {
    const f = await fixture()
    await f.publisher.publish(f.own)
    const tip = await f.remoteTip()
    expect(tip).toMatch(/^[0-9a-f]{40}$/u)
    expect((await f.git(["rev-list", "--parents", "-n", "1", tip!])).trim()).toBe(tip)
    expect(await readPublishedRunner(f.git, "main", "origin", tip)).toMatchObject({
      signal: "fresh",
      claim: { Runner: "host/42", State: "idle" },
    })
    expect(
      await readPublishedRunner(f.git, "main", "origin", tip, new Date(Date.parse(f.own.at) + 180_001)),
    ).toMatchObject({
      signal: "silent",
      claim: { Runner: "host/42" },
    })
    expect(
      await readPublishedRunner(f.git, "main", "origin", tip, new Date(Date.parse(f.own.at) - 30_001)),
    ).toMatchObject({
      signal: "unreadable",
      why: expect.stringContaining("clock-skew"),
    })
    expect(f.statuses).toEqual(["ok"])
  })

  it("re-reads a refused lease and recovers absence, its own identity, and a stale predecessor", async () => {
    for (const scenario of ["absent", "own", "stale"] as const) {
      const f = await fixture()
      await f.publisher.publish(f.own)
      const first = await f.remoteTip()
      if (scenario === "absent") await f.git(["push", "--quiet", "origin", `:${f.ref}`])
      if (scenario === "own") await f.replace({ ...f.own, state: "provisioning" })
      if (scenario === "stale") {
        const old = new Date(Date.now() - 4 * 60_000).toISOString()
        await f.replace({ ...f.own, host: "predecessor", pid: 7, started: old, at: old, since: old })
      }
      await f.publisher.publish({ ...f.own, state: "checking" })
      const after = await f.remoteTip()
      expect(after, scenario).not.toBe(first)
      expect(await readPublishedRunner(f.git, "main", "origin", after), scenario).toMatchObject({
        signal: "fresh",
        claim: { Runner: "host/42", State: "checking" },
      })
      expect(f.publisher.conflict, scenario).toBeUndefined()
    }
  })

  it("takes over a fresh stopped claim, but terminates on a fresh live second runner", async () => {
    const stopped = await fixture()
    const other = { ...stopped.own, host: "predecessor", pid: 7, state: "stopped" as const }
    await stopped.replace(other)
    await stopped.publisher.publish(stopped.own)
    expect(stopped.publisher.conflict).toBeUndefined()
    expect(stopped.notices.join(" ")).toContain("taking over relinquished runner predecessor/7 started")
    expect(await readPublishedRunner(stopped.git, "main", "origin", await stopped.remoteTip())).toMatchObject({
      signal: "fresh",
      claim: { Runner: "host/42" },
    })

    const live = await fixture()
    await live.publisher.publish(live.own)
    const rival = await live.replace({ ...live.own, host: "rival", pid: 8, state: "checking" })
    await live.publisher.publish({ ...live.own, state: "provisioning" })
    expect(live.publisher.conflict?.name).toBe("RunnerConflict")
    expect(await live.remoteTip()).toBe(rival)
    expect(live.statuses.at(-1)).toBe("failed")
  })
})
