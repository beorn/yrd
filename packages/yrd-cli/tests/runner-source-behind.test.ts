/**
 * @failure Nothing computed how far a resident runner's booted source has
 *          fallen behind the checkout it is running from, so the RUNNER
 *          box's `source git:<sha>` line could not flag staleness inline.
 * @level   l2
 * @consumer @yrd/cli queue watch
 *
 * Box 2 of @yrd/core/stale-runner-never-recycles. `runnerSourceBehind` is the
 * observation-time computation (never on the render path); the render-level
 * proof that the box shows/hides the flag lives in
 * runner-box-source-staleness.test.ts.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { runnerSourceBehind } from "../src/run.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "yrd-source-behind-repo-"))
  roots.push(repo)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"])
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
  return repo
}

function commit(repo: string, message: string): string {
  writeFileSync(join(repo, "f.txt"), `${message}\n${Math.random()}`)
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message])
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim()
}

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

describe("runnerSourceBehind (@yrd/core/stale-runner-never-recycles box 2)", () => {
  it("is undefined when the resident's booted sha is exactly the checkout's HEAD", () => {
    const repo = initRepo()
    const sha = commit(repo, "first")
    expect(runnerSourceBehind(repo, `git:${sha}`, Date.now())).toBeUndefined()
  })

  it("counts the commits the checkout has advanced past the resident's booted sha", () => {
    const repo = initRepo()
    const bootedSha = commit(repo, "first")
    commit(repo, "second")
    commit(repo, "third")
    commit(repo, "fourth")
    expect(runnerSourceBehind(repo, `git:${bootedSha}`, Date.now())).toBe(3)
  })

  it("is undefined for a non-git implementation source and does not throw", () => {
    const repo = initRepo()
    commit(repo, "first")
    expect(runnerSourceBehind(repo, "dirty:abc123", Date.now())).toBeUndefined()
    expect(runnerSourceBehind(repo, undefined, Date.now())).toBeUndefined()
  })

  it("is undefined, not a thrown error, when cwd is not a Git repository", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "yrd-source-behind-not-a-repo-"))
    roots.push(notARepo)
    const fakeSha = "1".repeat(40)
    expect(() => runnerSourceBehind(notARepo, `git:${fakeSha}`, Date.now())).not.toThrow()
    expect(runnerSourceBehind(notARepo, `git:${fakeSha}`, Date.now())).toBeUndefined()
  })

  it("does not fork git again within the TTL window for the same booted sha", () => {
    const repo = initRepo()
    const bootedSha = commit(repo, "first")
    commit(repo, "second")
    const counter = installGitCounter()
    try {
      const now = Date.now()
      expect(runnerSourceBehind(repo, `git:${bootedSha}`, now)).toBe(1)
      const afterFirst = invocationCount(counter.logPath)
      expect(afterFirst).toBeGreaterThan(0)
      // Same cwd, same booted sha, well inside the TTL: a cache hit, not a fork.
      // This is the per-focus-change refresh path (`observeQueueList` runs on
      // every cursor move, not just the poll tick) that `queueGitDir`'s own
      // doc comment names as the regression class to avoid repeating.
      for (let i = 0; i < 10; i += 1) {
        expect(runnerSourceBehind(repo, `git:${bootedSha}`, now + i)).toBe(1)
      }
      expect(invocationCount(counter.logPath)).toBe(afterFirst)
    } finally {
      counter.restore()
    }
  })

  it("is undefined when the booted sha is not an ANCESTOR of HEAD, even though both resolve", () => {
    // The live specimen, reduced. `implementationSource` names a commit of the
    // YRD repository; the queue repository `/hh` it is serving happens to hold
    // Yrd's objects too, so `rev-list --count` answered across two unrelated
    // histories instead of failing: a resident sitting exactly on its checkout's
    // HEAD measured 37576 behind, and the box rendered that as a warning. A
    // count is only a distance when one commit descends from the other.
    const repo = initRepo()
    const unrelated = commit(repo, "history A")
    execFileSync("git", ["-C", repo, "checkout", "-q", "--orphan", "history-b"])
    commit(repo, "history B first")
    commit(repo, "history B second")
    commit(repo, "history B third")

    // Both shas are resolvable in this one repository — the precondition that
    // made the bug silent rather than loud.
    expect(() => execFileSync("git", ["-C", repo, "cat-file", "-t", unrelated])).not.toThrow()
    expect(runnerSourceBehind(repo, `git:${unrelated}`, Date.now())).toBeUndefined()
  })

  it("is undefined when the checkout REWOUND past the resident — behind is not the same as different", () => {
    // The 2026-08-14 staged-rewind incident: the checkout sat 18 commits behind
    // its own pin. The resident is then AHEAD of its source, which no restart
    // improves, so it must not read as a recycle-worthy gap.
    const repo = initRepo()
    const base = commit(repo, "first")
    const ahead = commit(repo, "second")
    execFileSync("git", ["-C", repo, "checkout", "-q", "--detach", base])
    expect(runnerSourceBehind(repo, `git:${ahead}`, Date.now())).toBeUndefined()
  })

  it("recomputes once the TTL has elapsed, picking up a newly landed pin", () => {
    const repo = initRepo()
    const bootedSha = commit(repo, "first")
    const now = Date.now()
    expect(runnerSourceBehind(repo, `git:${bootedSha}`, now)).toBeUndefined()
    commit(repo, "second")
    commit(repo, "third")
    // Still inside the TTL: the cached "current" answer stands even though a
    // new commit landed — this is the deliberate cost of the cache, bounded
    // by the TTL below.
    expect(runnerSourceBehind(repo, `git:${bootedSha}`, now + 1_000)).toBeUndefined()
    // Past the TTL: recomputes and sees the advance.
    expect(runnerSourceBehind(repo, `git:${bootedSha}`, now + 16_000)).toBe(2)
  })
})
