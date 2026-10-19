/**
 * @reach fs-walk <fixture-only: temporary origin and clone>
 * @failure yrd drop --local reports an origin archive it never pushed: the
 * archive ref is written locally only, and the report still says origin.
 * @level l2 (`runYrdProcess` against a real remote and clone)
 * @consumer yrd drop --local custody message and recovery command.
 * @testonly none
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { createEventQueue, createEventStore, readConfig } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stderr = ""
  let stdout = ""
  return {
    io: {
      localBranchProtections: null,
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
      branchIssue: () => undefined,
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

it("pushes the archive ref to origin and reads it back before reporting success", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-archive-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )
  // A lane branch that was never submitted: no change record, no archive row.
  await git(["checkout", "--quiet", "-b", "task/never-submitted"])
  writeFileSync(join(repo, "held.txt"), "held\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "held"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])

  const observed = capture(repo)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", "task/never-submitted", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr()).toBe(0)
  const report = JSON.parse(observed.stdout()) as {
    removed: { branch: string; archiveRef?: string; recovery?: string }[]
  }
  expect(report.removed).toEqual([expect.objectContaining({ branch: "task/never-submitted" })])
  const archiveRef = report.removed[0]?.archiveRef
  expect(archiveRef).toBeDefined()
  // The origin really holds the archive, not just the local store.
  const atOrigin = (await git(["ls-remote", "origin", archiveRef!])).trim()
  expect(atOrigin.split("\t")[0]).toBe(tip)
  // And the reported recovery command is the origin one, because that is where custody lives.
  expect(report.removed[0]?.recovery).toContain("fetch")
})

it("refuses loudly and keeps the branch when origin will not take the archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-refuse-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  const hook = join(remote, "hooks", "pre-receive")
  writeFileSync(
    hook,
    "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/archive/*) echo 'archive refs are read-only here' >&2; exit 1;; esac; done\nexit 0\n",
  )
  chmodSync(hook, 0o755)
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )
  await git(["checkout", "--quiet", "-b", "task/never-submitted"])
  writeFileSync(join(repo, "held.txt"), "held\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "held"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])

  const observed = capture(repo)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", "task/never-submitted", "--local", "--tip", tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  // The archive could not reach origin, so the drop must not claim success or delete the branch.
  expect(code).not.toBe(0)
  expect(observed.stdout() + observed.stderr()).toContain("refs/archive/")
  expect((await git(["rev-parse", "refs/heads/task/never-submitted"])).trim()).toBe(tip)
})

it("treats an already-gone branch as a no-op success (28385 area 11, ruled 2026-10-19)", async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-gone-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - verify: {run: "true"}\n')
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture lost .yrd.yml")
  await createEventQueue(
    createEventStore(repo, "origin", git.selection),
    "main",
    target,
    config,
    new Date("2020-01-01T00:00:00.000Z"),
  )

  const observed = capture(repo)
  const code = await runYrdProcess(
    [
      "bun",
      "yrd",
      "drop",
      "task/never-existed",
      "--local",
      "--tip",
      "0000000000000000000000000000000000000000",
      "--submitter",
      "fixture",
      "--json",
    ],
    observed.io,
  )
  // The requested post-condition already holds: a retry must report a no-op, not a failure.
  expect(code, observed.stderr()).toBe(0)
  const report = JSON.parse(observed.stdout()) as { removed: unknown[]; detail?: string }
  expect(report.removed).toEqual([])
  expect(report.detail).toContain("already gone")
})
