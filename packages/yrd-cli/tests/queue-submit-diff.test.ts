// @failure Round-6 Revision B's synthetic submit tab either fabricates 0/0
//   diffs or cannot expand revision-bound changed files and patch text.
// @level l2
// @consumer @yrd/cli watch

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fixturePr } from "../dev/queue-timeline-fixtures.ts"
import { queuePrDiff } from "../src/run.ts"

const dirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("queue submit diff projection", () => {
  it("projects numstat, changed files, and patch text; pruned refs stay explicit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yrd-submit-diff-"))
    dirs.push(cwd)
    git(cwd, "init", "-q")
    git(cwd, "config", "user.email", "test@example.test")
    git(cwd, "config", "user.name", "Yrd Test")
    writeFileSync(join(cwd, "detail.txt"), "old\n")
    git(cwd, "add", "detail.txt")
    git(cwd, "commit", "-qm", "base")
    const baseSha = git(cwd, "rev-parse", "HEAD")

    writeFileSync(join(cwd, "detail.txt"), "new\nsecond\n")
    writeFileSync(join(cwd, "watch.txt"), "watch\n")
    git(cwd, "add", "detail.txt", "watch.txt")
    git(cwd, "commit", "-qm", "candidate")
    const headSha = git(cwd, "rev-parse", "HEAD")
    const pr = fixturePr("PR8", "submitted", "2026-07-19T01:00:00.000Z", "Diff", {
      headSha,
      revisions: [
        {
          n: 1,
          head: headSha,
          base: "main",
          baseSha,
          pushedAt: "2026-07-19T01:00:00.000Z",
          submittedAt: "2026-07-19T01:00:00.000Z",
        },
      ],
    })

    expect(queuePrDiff(cwd, pr)).toMatchObject({
      pr: "PR8",
      revision: 1,
      additions: 3,
      deletions: 1,
      files: ["detail.txt", "watch.txt"],
      patch: expect.stringContaining("+second"),
    })
    expect(
      queuePrDiff(cwd, { ...pr, revs: pr.revs.map((revision) => ({ ...revision, head: "f".repeat(40) })) }),
    ).toEqual({
      pr: "PR8",
      revision: 1,
      unavailable: "refs-pruned",
    })
    const notARepo = mkdtempSync(join(tmpdir(), "yrd-submit-diff-not-repo-"))
    dirs.push(notARepo)
    expect(() => queuePrDiff(notARepo, pr)).toThrow()

    writeFileSync(join(cwd, "later.txt"), "later revision\n")
    git(cwd, "add", "later.txt")
    git(cwd, "commit", "-qm", "revision two")
    const latestHeadSha = git(cwd, "rev-parse", "HEAD")
    const recut = fixturePr("PR8", "submitted", "2026-07-19T01:05:00.000Z", "Diff", {
      revision: 2,
      headSha: latestHeadSha,
      revisions: [
        {
          revision: 1,
          headSha,
          base: "main",
          baseSha,
          pushedAt: "2026-07-19T01:00:00.000Z",
          submittedAt: "2026-07-19T01:00:00.000Z",
        },
        {
          revision: 2,
          headSha: latestHeadSha,
          base: "main",
          baseSha,
          pushedAt: "2026-07-19T01:05:00.000Z",
          submittedAt: "2026-07-19T01:05:00.000Z",
        },
      ],
    })
    expect(queuePrDiff(cwd, recut, 1)).toMatchObject({
      pr: "PR8",
      revision: 1,
      additions: 3,
      deletions: 1,
      files: ["detail.txt", "watch.txt"],
    })
  })
})
