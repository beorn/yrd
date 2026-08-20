/**
 * @failure The RUNNER box's "N behind pin" figure counted the OBSERVER'S OWN
 *          Yrd checkout (`runnerSha..HEAD` in `yrdSourceCheckout()`), so the
 *          number tracked whoever was looking, not the queue's recorded pin:
 *          an observer two commits ahead rendered a pin-exact resident as
 *          "28 behind pin", and moving the recorded pin did not move the
 *          display.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * @i/10-merge-queue/23041-staleness-measures-the-observer. `runnerPinBehind`
 * derives the figure from the RECORDED PIN — the queue repository's
 * `origin/main` gitlink for its Yrd submodule — never from any checkout's
 * HEAD. When the pin cannot be resolved it answers a LOUD unknown, never a
 * number computed from a different base. The render-level proof lives in
 * runner-box-source-staleness.test.ts.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { runnerPinBehind } from "../src/run.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  roots.push(repo)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"])
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
  execFileSync("git", ["-C", repo, "config", "protocol.file.allow", "always"])
  return repo
}

function commit(repo: string, message: string): string {
  writeFileSync(join(repo, "f.txt"), `${message}\n${Math.random()}`)
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message])
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim()
}

/** A source repository that IDENTIFIES as the Yrd distribution — the same
 * package.json name check `yrdSourceRoot` applies to the running code is what
 * `runnerPinBehind` uses to find the queue repo's Yrd submodule, so the
 * fixture must satisfy it rather than merely look like a repo. */
function initYrdShapedSource(): string {
  const repo = initRepo("yrd-pin-source-")
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "git-yrd", version: "0.0.0-test" })}\n`)
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "identity"])
  return repo
}

type QueueFixture = Readonly<{ queueRoot: string; sourceRepo: string; submoduleRoot: string }>

/** A queue repository whose `origin/main` records `sourceRepo` as a submodule
 * pin at `vendor/yrd`, with the submodule working tree materialized the way
 * the resident's own deployment is. `origin/main` is a genuine remote ref
 * (`refs/remotes/origin/main`), advanced by `recordPin`, so the helper reads
 * exactly the surface production reads. */
function initQueueRepo(sourceRepo: string, pinSha: string): QueueFixture {
  const queueRoot = initRepo("yrd-pin-queue-")
  commit(queueRoot, "queue history")
  execFileSync("git", [
    "-C",
    queueRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    sourceRepo,
    "vendor/yrd",
  ])
  const submoduleRoot = join(queueRoot, "vendor/yrd")
  execFileSync("git", ["-C", submoduleRoot, "checkout", "-q", pinSha])
  execFileSync("git", ["-C", queueRoot, "add", "vendor/yrd"])
  execFileSync("git", ["-C", queueRoot, "commit", "-q", "-m", "pin yrd"])
  execFileSync("git", ["-C", queueRoot, "update-ref", "refs/remotes/origin/main", "HEAD"])
  return { queueRoot, sourceRepo, submoduleRoot }
}

/** Advance the RECORDED pin — the fact the display must follow — without
 * touching any checkout's HEAD beyond the gitlink commit itself. */
function recordPin(fixture: QueueFixture, pinSha: string): void {
  execFileSync("git", ["-C", fixture.submoduleRoot, "fetch", "-q", "origin"])
  execFileSync("git", ["-C", fixture.submoduleRoot, "checkout", "-q", pinSha])
  execFileSync("git", ["-C", fixture.queueRoot, "add", "vendor/yrd"])
  execFileSync("git", ["-C", fixture.queueRoot, "commit", "-q", "-m", "advance pin"])
  execFileSync("git", ["-C", fixture.queueRoot, "update-ref", "refs/remotes/origin/main", "HEAD"])
}

describe("runnerPinBehind (@i/10-merge-queue/23041-staleness-measures-the-observer)", () => {
  it("answers at-pin for a resident booted exactly at the recorded pin", () => {
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const fixture = initQueueRepo(source, pin)
    expect(runnerPinBehind(fixture.queueRoot, `git:${pin}`, Date.now())).toEqual({ state: "at" })
  })

  it("keeps answering at-pin while OTHER checkouts advance — the observer's own history weighs nothing", () => {
    // The live specimen's first two table rows: the runner never moved, the
    // observer's checkout gained commits, and the display counted the observer.
    // Here the upstream source (any checkout that is not the recorded pin)
    // advances twice; the recorded pin and the resident stay put, so the
    // answer must not move.
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const fixture = initQueueRepo(source, pin)
    commit(source, "observer-only advance 1")
    commit(source, "observer-only advance 2")
    expect(runnerPinBehind(fixture.queueRoot, `git:${pin}`, Date.now())).toEqual({ state: "at" })
  })

  it("counts behind against the recorded pin, and the count FOLLOWS a pin advance", () => {
    // The decisive third table row, inverted to the fix: moving the recorded
    // pin is the only thing that may move the number.
    const source = initYrdShapedSource()
    const booted = commit(source, "booted")
    const fixture = initQueueRepo(source, booted)
    const next = commit(source, "pin advance 1")
    recordPin(fixture, next)
    expect(runnerPinBehind(fixture.queueRoot, `git:${booted}`, Date.now())).toEqual({ state: "behind", commits: 1 })
    const further = commit(source, "pin advance 2")
    recordPin(fixture, further)
    // Fresh timestamp past the TTL so the second read is a recompute.
    expect(runnerPinBehind(fixture.queueRoot, `git:${booted}`, Date.now() + 60_000)).toEqual({
      state: "behind",
      commits: 2,
    })
  })

  it("answers a LOUD unknown naming AHEAD when the resident descends from the recorded pin", () => {
    // The counter-caution in the bead: a runtime NEWER than the recorded pin
    // is the direction that crashed settlement drain, and it must neither
    // read as behind nor as silently current.
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const ahead = commit(source, "newer than pin")
    const fixture = initQueueRepo(source, pin)
    execFileSync("git", ["-C", fixture.submoduleRoot, "fetch", "-q", "origin"])
    const answer = runnerPinBehind(fixture.queueRoot, `git:${ahead}`, Date.now())
    expect(answer.state).toBe("unknown")
    expect(answer.state === "unknown" && answer.reason).toMatch(/ahead/i)
  })

  it("answers a LOUD unknown when the queue repository has no origin/main to read a pin from", () => {
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const fixture = initQueueRepo(source, pin)
    execFileSync("git", ["-C", fixture.queueRoot, "update-ref", "-d", "refs/remotes/origin/main"])
    const answer = runnerPinBehind(fixture.queueRoot, `git:${pin}`, Date.now())
    expect(answer.state).toBe("unknown")
    expect(answer.state === "unknown" && answer.reason).toMatch(/origin\/main/)
  })

  it("answers a LOUD unknown when the booted sha cannot be related to the pin", () => {
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const fixture = initQueueRepo(source, pin)
    const stranger = "f".repeat(40)
    const answer = runnerPinBehind(fixture.queueRoot, `git:${stranger}`, Date.now())
    expect(answer.state).toBe("unknown")
  })

  it("answers unpinned, not unknown, when origin/main records no Yrd submodule", () => {
    // A queue repository without a Yrd pin is a normal deployment, not a
    // failure — silence is the honest render, and it must be distinguishable
    // from a pin we FAILED to read.
    const queueRoot = initRepo("yrd-pin-plain-queue-")
    commit(queueRoot, "no submodules here")
    execFileSync("git", ["-C", queueRoot, "update-ref", "refs/remotes/origin/main", "HEAD"])
    const sha = "a".repeat(40)
    expect(runnerPinBehind(queueRoot, `git:${sha}`, Date.now())).toEqual({ state: "unpinned" })
  })

  it("answers unpinned for a non-git implementation source and does not throw", () => {
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const fixture = initQueueRepo(source, pin)
    expect(runnerPinBehind(fixture.queueRoot, "dirty:abc123", Date.now())).toEqual({ state: "unpinned" })
    expect(runnerPinBehind(fixture.queueRoot, undefined, Date.now())).toEqual({ state: "unpinned" })
  })

  it("does not fork git again within the TTL window for the same booted sha", () => {
    const source = initYrdShapedSource()
    const pin = commit(source, "pinned")
    const fixture = initQueueRepo(source, pin)
    const counter = installGitCounter()
    try {
      const now = Date.now() + 120_000
      expect(runnerPinBehind(fixture.queueRoot, `git:${pin}`, now)).toEqual({ state: "at" })
      const afterFirst = invocationCount(counter.logPath)
      expect(afterFirst).toBeGreaterThan(0)
      // Same queue repo, same booted sha, well inside the TTL: a cache hit,
      // not a fork — `observeQueueList` runs on every cursor move, and this
      // read now walks .gitmodules too, so the per-keystroke cost matters
      // even more than it did for the single rev-list it replaces.
      for (let i = 0; i < 10; i += 1) {
        expect(runnerPinBehind(fixture.queueRoot, `git:${pin}`, now + i)).toEqual({ state: "at" })
      }
      expect(invocationCount(counter.logPath)).toBe(afterFirst)
    } finally {
      counter.restore()
    }
  })
})

/** Counts real `git` invocations, same technique as queue-git-dir-memo.test.ts:
 * the regression being guarded (a fork on every observation tick) is only
 * provable by observing the actual subprocess. */
function installGitCounter(): Readonly<{ logPath: string; restore: () => void }> {
  const home = mkdtempSync(join(tmpdir(), "yrd-git-counter-"))
  roots.push(home)
  const binDir = join(home, "bin")
  mkdirSync(binDir)
  const logPath = join(home, "git-invocations.log")
  writeFileSync(logPath, "")
  const originalPath = process.env.PATH ?? ""
  writeFileSync(
    join(binDir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nPATH=${JSON.stringify(originalPath)} exec git "$@"\n`,
  )
  chmodSync(join(binDir, "git"), 0o755)
  process.env.PATH = `${binDir}:${originalPath}`
  return {
    logPath,
    restore: () => {
      process.env.PATH = originalPath
    },
  }
}

function invocationCount(logPath: string): number {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length
}
