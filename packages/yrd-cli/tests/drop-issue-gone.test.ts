/**
 * @failure `drop --issue` treats a registered checkout whose root vanished as an
 * unreadable store and fails the issue, treats an inner loss as gone, or
 * inspects a component store that has no branch for the issue.
 * @level l3
 * @consumer Authors retiring one issue with `yrd drop --issue`
 * @testonly none
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { createEventQueue, createEventStore, readConfig } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
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
      branchIssue: ({ branch, recordedIssue }) => (branch === "task/30099-named" ? issue : recordedIssue),
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

async function world(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-gone-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, ".yrd.yml"), "checks: []\n")
  writeFileSync(join(repo, "README.md"), "queue\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const commit = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, commit, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture target lost .yrd.yml")
  await createEventQueue(createEventStore(repo, "origin", git.selection), "main", commit, config, new Date())
  return repo
}

const issue = "@example/30099-gone"

async function drop(repo: string, json: boolean): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out = capture(repo)
  const argv = ["bun", "yrd", "drop", "--issue", issue, "--submitter", "fixture", "--dry-run"]
  if (json) argv.push("--json")
  const exit = await runYrdProcess(argv, out.io)
  return { exit, stdout: out.stdout(), stderr: out.stderr() }
}

type GoneRow = { path: string; adminDirectory: string | null; adminDirectoryExists: boolean }
type FailedRow = { repo: string; reason: string; detail?: string }

function reportOf(stdout: string): { gone?: GoneRow[]; failed: FailedRow[]; inspected?: string[] } {
  return JSON.parse(stdout) as { gone?: GoneRow[]; failed: FailedRow[]; inspected?: string[] }
}

it("reports a registered checkout removed before the walk as gone and exits 0", async () => {
  const repo = await world()
  const git = gitIn(repo)
  const extra = join(dirname(repo), "vanished-before")
  await git(["worktree", "add", "--quiet", "--detach", extra, "HEAD"])
  const saved = `${extra}-saved`
  renameSync(extra, saved)
  try {
    const json = await drop(repo, true)
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
    const report = reportOf(json.stdout)
    expect(report.failed).toEqual([])
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.inspected ?? []).not.toContain(extra)
    const human = await drop(repo, false)
    expect(human.exit, human.stderr).toBe(0)
    expect(human.stdout).not.toContain(`${extra}: gone`)
  } finally {
    renameSync(saved, extra)
  }
}, 60_000)

it("keeps a root that still exists with a missing git pointer unreadable", async () => {
  const repo = await world()
  const extra = join(dirname(repo), "missing-pointer")
  await gitIn(repo)(["worktree", "add", "--quiet", "--detach", extra, "HEAD"])
  const pointer = join(extra, ".git")
  renameSync(pointer, `${pointer}-saved`)
  try {
    const json = await drop(repo, true)
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
    const report = reportOf(json.stdout)
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.failed).toEqual([])
    expect(report.inspected ?? []).not.toContain(extra)
  } finally {
    renameSync(`${pointer}-saved`, pointer)
  }
}, 60_000)

it("keeps a non-ENOENT checkout failure unreadable and exits 1", async () => {
  const repo = await world()
  const extra = join(dirname(repo), "damaged-mode")
  await gitIn(repo)(["worktree", "add", "--quiet", "--detach", extra, "HEAD"])
  // The directory stays, and Git does not call it prunable. The pointer itself cannot be read.
  const pointer = join(extra, ".git")
  chmodSync(pointer, 0)
  try {
    const json = await drop(repo, true)
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
    const report = reportOf(json.stdout)
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.failed).toEqual([])
    expect(report.inspected ?? []).not.toContain(extra)
  } finally {
    chmodSync(pointer, 0o644)
  }
}, 60_000)

it("keeps an inner loss unreadable while the registered root still exists", async () => {
  const repo = await world()
  const seed = await world()
  const git = gitIn(repo)
  await git([
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    join(dirname(seed), "remote.git"),
    "child",
  ])
  await git(["checkout", "--quiet", "-b", "task/30099-named"])
  await git(["commit", "--quiet", "-am", "register child"])
  await git(["push", "--quiet", "origin", "task/30099-named"])
  const extra = join(dirname(repo), "inner-loss-live-root")
  await git(["worktree", "add", "--quiet", "--detach", extra, "HEAD"])
  const pointer = join(repo, "child", ".git")
  renameSync(pointer, `${pointer}-saved`)
  try {
    const json = await drop(repo, true)
    expect(json.exit, json.stderr).toBe(1)
    const report = reportOf(json.stdout)
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: repo }))
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.failed).toContainEqual(
      expect.objectContaining({
        repo: join(repo, "child"),
        reason: "unreadable",
        detail: expect.stringContaining("checkout Git pointer is absent"),
      }),
    )
  } finally {
    renameSync(`${pointer}-saved`, pointer)
  }
}, 60_000)

it("does not visit a registered root, so a visit-time removal never runs", async () => {
  const repo = await world()
  const extra = join(dirname(repo), "vanished-during")
  await gitIn(repo)(["worktree", "add", "--quiet", "--detach", extra, "HEAD"])
  const found = spawnSync("which", ["git"], { encoding: "utf8" })
  if (found.status !== 0 || found.stdout.trim() === "") throw new Error(`which git failed: ${found.stderr}`)
  const realGit = found.stdout.trim()
  const bin = join(dirname(repo), "git-bin")
  mkdirSync(bin)
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncwd=$(pwd)\nif [ "$cwd" = ${quote(extra)} ]; then\n  mv ${quote(extra)} ${quote(`${extra}.during`)}\n  echo 'worktree removed during visit' >&2\n  exit 1\nfi\nexec ${quote(realGit)} "$@"\n`,
  )
  chmodSync(join(bin, "git"), 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous ?? ""}`
  try {
    const json = await drop(repo, true)
    expect(existsSync(`${extra}.during`), "the unvisited root was still entered").toBe(false)
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
    const report = reportOf(json.stdout)
    expect(report.failed).toEqual([])
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.inspected ?? []).not.toContain(extra)
  } finally {
    process.env.PATH = previous
    if (!existsSync(extra) && existsSync(`${extra}.during`)) renameSync(`${extra}.during`, extra)
  }
}, 60_000)

it("does not inspect a component store that has no branch for the issue", async () => {
  const repo = await world()
  const root = dirname(repo)
  const childRemote = join(root, "child.git")
  const childSeed = join(root, "child-seed")
  const host = gitIn(root)
  await host(["init", "--quiet", "--bare", "--initial-branch=main", childRemote])
  await host(["clone", "--quiet", childRemote, childSeed])
  const child = gitIn(childSeed)
  await child(["config", "user.name", "yrd test"])
  await child(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(childSeed, "CHILD.md"), "child\n")
  await child(["add", "CHILD.md"])
  await child(["commit", "--quiet", "-m", "child"])
  await child(["push", "--quiet", "origin", "main"])
  const repoGit = gitIn(repo)
  await repoGit(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", childRemote, "vendor/child"])
  await repoGit(["commit", "--quiet", "-m", "add child"])
  await repoGit(["push", "--quiet", "origin", "HEAD"])
  const childCheckout = join(repo, "vendor/child")
  const json = await drop(repo, true)
  expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
  const report = JSON.parse(json.stdout) as { inspected: string[]; failed: FailedRow[] }
  expect(report.failed).toEqual([])
  expect(report.inspected).toContain(repo)
  expect(report.inspected).not.toContain(childCheckout)
}, 60_000)

it("inspects and retires a component the issue names", async () => {
  const repo = await world()
  const root = dirname(repo)
  const childRemote = join(root, "named-child.git")
  const childSeed = join(root, "named-child-seed")
  const host = gitIn(root)
  await host(["init", "--quiet", "--bare", "--initial-branch=main", childRemote])
  await host(["clone", "--quiet", childRemote, childSeed])
  const child = gitIn(childSeed)
  await child(["config", "user.name", "yrd test"])
  await child(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(childSeed, "CHILD.md"), "child\n")
  await child(["add", "CHILD.md"])
  await child(["commit", "--quiet", "-m", "child"])
  await child(["push", "--quiet", "origin", "main"])
  await child(["branch", "task/30099-named"])
  await child(["push", "--quiet", "origin", "task/30099-named"])
  const repoGit = gitIn(repo)
  await repoGit(["checkout", "--quiet", "-b", "task/30099-named"])
  const component = "vendor/ümlaut"
  await repoGit(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", childRemote, component])
  await repoGit(["commit", "--quiet", "-m", "name child"])
  await repoGit(["push", "--quiet", "origin", "task/30099-named"])
  const json = await drop(repo, true)
  expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
  const report = JSON.parse(json.stdout) as {
    inspected: string[]
    failed: FailedRow[]
    eligible: { path: string; branch: string }[]
  }
  expect(report.failed).toEqual([])
  expect(report.inspected).toContain(join(repo, component))
  expect(report.eligible).toContainEqual(expect.objectContaining({ path: component, branch: "task/30099-named" }))
}, 60_000)

it("does not inspect a registered root or its initialized child removed after the inventory line", async () => {
  const repo = await world()
  const seed = await world()
  const git = gitIn(repo)
  await git([
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    join(dirname(seed), "remote.git"),
    "child",
  ])
  await git(["commit", "--quiet", "-am", "register child"])
  await git(["push", "--quiet", "origin", "main"])
  const extra = join(dirname(repo), "vanished-after-discovery")
  await git(["worktree", "add", "--quiet", "--detach", extra, "HEAD"])
  await gitIn(extra)(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet"])
  const saved = `${extra}-saved`
  const out = capture(repo)
  let moved = false
  try {
    const exit = await runYrdProcess(
      ["bun", "yrd", "drop", "--issue", issue, "--submitter", "fixture", "--dry-run", "--json"],
      {
        ...out.io,
        stderr(text) {
          out.io.stderr(text)
          if (!moved && text.includes("issue cleanup will inspect")) {
            renameSync(extra, saved)
            moved = true
          }
        },
      },
    )
    expect(moved, "registered root was not removed after the inventory line").toBe(true)
    const report = reportOf(out.stdout())
    expect(report.failed, out.stderr()).toEqual([])
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.inspected ?? []).not.toContain(extra)
    expect(report.inspected ?? []).not.toContain(join(extra, "child"))
    expect(exit, out.stderr()).toBe(0)
  } finally {
    if (moved) renameSync(saved, extra)
  }
}, 60_000)
