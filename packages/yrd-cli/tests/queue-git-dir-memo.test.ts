/**
 * @failure `yrd watch` blocks the terminal on a synchronous `git rev-parse --git-common-dir` fork for every 1s poll tick and every cursor movement, because the queue's git-common-dir lookup is recomputed instead of memoized.
 * @level l2
 * @consumer @yrd/cli `queue list --watch` operators
 */
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { residentRunnerStatus } from "../src/run.ts"

const roots: string[] = []

/** Counts real `git` invocations by putting a logging wrapper first on PATH.
 * Counting the actual subprocess (rather than a mocked `execFileSync`) is the
 * point: the regression being pinned is a process fork per keypress, so the
 * fork itself is what has to be observed. */
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

function commonDirForks(logPath: string): number {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("--git-common-dir")).length
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("queue git-common-dir lookup", () => {
  it("forks git once per repository no matter how many watch ticks read the runner status", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-git-dir-memo-repo-"))
    roots.push(repo)
    execFileSync("git", ["init", "-q", repo])
    const counter = installGitCounter()
    try {
      // One `queueListSnapshot` calls `residentRunnerStatus` once, and `yrd watch`
      // runs a snapshot per 1s tick AND per focus/cursor change. 25 stands in for
      // 25 keypresses: the fork budget must not grow with them.
      for (let tick = 0; tick < 25; tick++) {
        expect(await residentRunnerStatus(repo)).toBeNull()
      }
      expect(commonDirForks(counter.logPath)).toBe(1)
    } finally {
      counter.restore()
    }
  })

  it("forks git once for a directory that is not a repository, so absence is not re-derived either", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "yrd-git-dir-memo-bare-"))
    roots.push(notARepo)
    const counter = installGitCounter()
    try {
      for (let tick = 0; tick < 25; tick++) {
        expect(await residentRunnerStatus(notARepo)).toBeNull()
      }
      expect(commonDirForks(counter.logPath)).toBe(1)
    } finally {
      counter.restore()
    }
  })
})
