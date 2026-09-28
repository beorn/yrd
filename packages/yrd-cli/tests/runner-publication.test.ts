/**
 * @failure A runner could overwrite a second live runner, or refuse a safe restart after a stopped claim.
 * @level l2 (two real Git repositories and a leased remote ref)
 * @consumer the resident queue runner and off-machine status readers
 * @testonly none
 */
import { mkdtempSync, readlinkSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, readRemoteCommit, roundHealthDocument, runnerRef, type RunnerClaim } from "@yrd/queue-core"
import { processStartIdentity } from "@yrd/process"
import { readPublishedRunner, RunnerPublisher } from "../src/runner-publication.ts"
import { runnerLine } from "../src/watch-runner.ts"

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
  const replace = async (claim: RunnerClaim, tail = "") => {
    const tree = (await git(["mktree"], "")).trim()
    const body = `yrd runner claim\n\nRunner: ${claim.host}/${String(claim.pid)}\nStarted: ${claim.started}\nAt: ${claim.at}\nBeat: ${String(claim.beatMs)}ms\nState: ${claim.state}\nSince: ${claim.since}\n${tail}`
    const oid = (await git(["commit-tree", tree, "-m", body])).trim()
    const prior = await remoteTip()
    await git(["push", "--quiet", `--force-with-lease=${ref}:${prior ?? "0".repeat(40)}`, "origin", `${oid}:${ref}`])
    return oid
  }
  return { git, own, publisher, ref, remoteTip, replace, statuses, notices }
}

describe("runner ref publication", () => {
  /** @failure A killed same-host runner kept its fresh claim and made every replacement exit before the three-beat silence bound. @level l2 */
  it.skipIf(process.platform !== "linux")("takes over a killed same-host runner within five seconds", async () => {
    const f = await fixture()
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      const identity = processStartIdentity(child.pid)
      expect(identity.boot).toBeDefined()
      expect(identity.tick).toBeDefined()
      const prior = { ...f.own, host: hostname(), pid: child.pid }
      const namespace = readlinkSync(`/proc/${String(child.pid)}/ns/pid`)
      const oldTip = await f.replace(
        prior,
        `Boot: ${identity.boot}\nPidNamespace: ${namespace}\nStartTick: ${String(identity.tick)}\n`,
      )
      child.kill("SIGKILL")
      await child.exited
      expect(() => process.kill(child.pid, 0)).toThrow()

      const began = performance.now()
      const ownIdentity = processStartIdentity(process.pid)
      await f.publisher.publish({
        ...f.own,
        host: hostname(),
        pid: process.pid,
        boot: ownIdentity.boot,
        pidNamespace: readlinkSync("/proc/self/ns/pid"),
        startTick: ownIdentity.tick,
      } as RunnerClaim)
      expect(performance.now() - began).toBeLessThan(5_000)
      expect(f.publisher.conflict).toBeUndefined()
      expect(await f.remoteTip()).not.toBe(oldTip)
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  })

  /** @failure A recycled PID could block recovery, or a live PID could be stolen. @level l2 */
  it.skipIf(process.platform !== "linux")("distinguishes a live runner from a reused PID", async () => {
    const identity = processStartIdentity(process.pid)
    expect(identity.boot).toBeDefined()
    expect(identity.tick).toBeDefined()
    const namespace = readlinkSync("/proc/self/ns/pid")
    for (const reused of [false, true]) {
      const f = await fixture()
      const started = new Date(Date.parse(f.own.started) - 1000).toISOString()
      const prior = { ...f.own, host: hostname(), pid: process.pid, started }
      const oldTip = await f.replace(
        prior,
        `Boot: ${identity.boot}\nPidNamespace: ${namespace}\nStartTick: ${String(identity.tick! + (reused ? 1 : 0))}\n`,
      )
      await f.publisher.publish({
        ...f.own,
        host: hostname(),
        pid: process.pid,
        boot: identity.boot,
        pidNamespace: namespace,
        startTick: identity.tick,
      } as RunnerClaim)
      if (reused) {
        expect(f.publisher.conflict).toBeUndefined()
        expect(await f.remoteTip()).not.toBe(oldTip)
      } else {
        expect(f.publisher.conflict?.name).toBe("RunnerConflict")
        expect(await f.remoteTip()).toBe(oldTip)
      }
    }
  })

  /** @failure A legacy or foreign PID domain could be misread as dead, or a candidate could start a round early. @level l2 */
  it("waits without publishing for unproven same-host claims and re-reads after a beat", async () => {
    for (const kind of ["legacy", "boot", "namespace", "partial"] as const) {
      const f = await fixture()
      const prior = { ...f.own, host: hostname(), pid: process.pid + 100_000 }
      const group =
        kind === "legacy" ? "" :
        kind === "partial" ? "Boot: other-boot\n" :
        `Boot: ${kind === "boot" ? "other-boot" : "same-boot"}\nPidNamespace: ${kind === "namespace" ? "pid:[other]" : "pid:[same]"}\nStartTick: 1\n`
      const oldTip = await f.replace(prior, group)
      await f.publisher.publish({
        ...f.own,
        host: hostname(),
        pid: process.pid,
        boot: "same-boot",
        pidNamespace: "pid:[same]",
        startTick: 2,
      })
      expect(f.publisher.waiting, kind).toContain("waiting for")
      expect(f.publisher.owns, kind).toBe(false)
      expect(f.publisher.conflict, kind).toBeUndefined()
      expect(await f.remoteTip(), kind).toBe(oldTip)
      const stale = new Date(Date.now() - 4 * 60_000).toISOString()
      await f.replace({ ...prior, started: stale, at: stale, since: stale })
      await f.publisher.publish({
        ...f.own,
        host: hostname(),
        pid: process.pid,
        boot: "same-boot",
        pidNamespace: "pid:[same]",
        startTick: 2,
      })
      expect(f.publisher.owns, kind).toBe(true)
      expect(f.publisher.waiting, kind).toBeUndefined()
    }
  })

  /** @failure A newer claim looked fresh by beat but hid trailers this reader could not judge. @level l2 */
  it("keeps a future trailer in the published claim and names it on the human row", async () => {
    const f = await fixture()
    const deadline = new Date(Date.parse(f.own.at) + 30 * 60_000).toISOString()
    const tip = await f.replace({ ...f.own, state: "checking" }, `Deadline: ${deadline}\nIntent: later\n`)
    const published = await readPublishedRunner(f.git, "main", "origin", tip, new Date(f.own.at))
    expect(published).toMatchObject({
      signal: "fresh",
      claim: { Deadline: deadline, Intent: "later" },
      phase: { status: "within" },
      unjudgedTrailers: ["Intent"],
    })
    expect(
      runnerLine(
        { journalDir: "/no-local-journal", service: { kind: "absent", why: "no local document" }, published },
        new Date(f.own.at),
      ).detail,
    ).toContain("unjudged trailers: Intent")
    const skewed = await readPublishedRunner(f.git, "main", "origin", tip, new Date(Date.parse(f.own.at) - 31_000))
    expect(skewed).toMatchObject({ signal: "unreadable", unjudgedTrailers: ["Intent"] })
    expect(
      runnerLine(
        { journalDir: "/no-local-journal", service: { kind: "absent", why: "no local document" }, published: skewed },
        new Date(Date.parse(f.own.at) - 31_000),
      ).detail,
    ).toContain("unjudged trailers: Intent")
  })

  it("uses the shared deadline judgment for a fresh remote claim", async () => {
    const f = await fixture()
    const now = Date.parse(f.own.at)
    const since = new Date(now - 40 * 60_000).toISOString()
    const deadline = new Date(now - 10 * 60_000).toISOString()
    await f.publisher.publish({ ...f.own, started: since, since, deadline, state: "checking" })
    expect(await readPublishedRunner(f.git, "main", "origin", await f.remoteTip(), new Date(now))).toMatchObject({
      signal: "fresh",
      claim: { Deadline: deadline },
      phase: { status: "overdue" },
    })
  })

  /** @failure The remote RUNNER row and local health page could disagree about a cycling round's total Due. @level l2 */
  it("uses the identical whole-round Due sentence remotely and locally", async () => {
    const f = await fixture()
    const now = Date.parse(f.own.at)
    const started = new Date(now - 100 * 60_000).toISOString()
    const round = new Date(now - 79 * 60_000).toISOString()
    const since = new Date(now - 60_000).toISOString()
    const due = new Date(now - 4 * 60_000).toISOString()
    const deadline = new Date(now + 29 * 60_000).toISOString()
    const claim: RunnerClaim = { ...f.own, started, round, since, due, deadline, candidates: 3, state: "checking" }
    await f.publisher.publish(claim)
    const published = await readPublishedRunner(f.git, "main", "origin", await f.remoteTip(), new Date(now))
    expect(published).toMatchObject({
      signal: "fresh",
      phase: { status: "within" },
      round: { status: "overdue" },
      claim: { Due: due, Round: round, Candidates: "3" },
    })
    const local = roundHealthDocument("yrd", undefined, 120_000, new Date(now), {
      flow: { waiting: 3, roundOpen: { startedAt: round, phase: "hold" } },
      threshold: { ms: 45 * 60_000, declared: false },
      claim,
    })
    expect(local.error?.cause).toBe(published.round?.reason)
    expect(
      runnerLine(
        { journalDir: "/no-local-journal", service: { kind: "absent", why: "no local document" }, published },
        new Date(now),
      ).detail,
    ).toContain(published.round?.reason)
  })

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
      await f.publisher.publish({
        ...f.own,
        state: "checking",
        deadline: new Date(Date.parse(f.own.since) + 30 * 60_000).toISOString(),
      })
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
    await live.publisher.publish({
      ...live.own,
      state: "provisioning",
      deadline: new Date(Date.parse(live.own.since) + 30 * 60_000).toISOString(),
    })
    expect(live.publisher.conflict?.name).toBe("RunnerConflict")
    expect(await live.remoteTip()).toBe(rival)
    expect(live.statuses.at(-1)).toBe("failed")
  })

  it("names the safe removal command when a foreign claim is unreadable", async () => {
    const f = await fixture()
    const future = new Date(Date.now() + 60_000).toISOString()
    await f.replace({ ...f.own, host: "rival", pid: 8, at: future })
    await f.publisher.publish(f.own)
    expect(f.statuses).toEqual(["failed"])
    expect(f.notices.join(" ")).toContain("verifying no live runner")
    expect(f.notices.join(" ")).toContain(`git push origin :${f.ref}`)
  })
})
