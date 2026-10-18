/**
 * @failure `drop --issue` treats a registered checkout whose root vanished as an
 * unreadable store and fails the issue, or treats an inner loss as gone.
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
      branchIssue: ({ recordedIssue }) => recordedIssue,
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

function reportOf(stdout: string): { gone?: GoneRow[]; failed: FailedRow[] } {
  return JSON.parse(stdout) as { gone?: GoneRow[]; failed: FailedRow[] }
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
    expect(report.gone).toContainEqual(
      expect.objectContaining({
        path: extra,
        adminDirectoryExists: true,
        adminDirectory: expect.stringContaining("/worktrees/"),
      }),
    )
    const human = await drop(repo, false)
    expect(human.exit, human.stderr).toBe(0)
    expect(human.stdout).toContain(`${extra}: gone`)
    expect(human.stdout).toContain("module stores were not inspected")
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
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(1)
    const report = reportOf(json.stdout)
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.failed).toContainEqual(
      expect.objectContaining({
        repo: extra,
        reason: "unreadable",
        detail: expect.stringContaining("checkout Git pointer is absent"),
      }),
    )
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
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(1)
    const report = reportOf(json.stdout)
    expect(report.gone ?? []).not.toContainEqual(expect.objectContaining({ path: extra }))
    expect(report.failed).toContainEqual(
      expect.objectContaining({
        repo: extra,
        reason: "unreadable",
        detail: expect.stringMatching(/EACCES|Permission denied/),
      }),
    )
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
  await git(["commit", "--quiet", "-am", "register child"])
  await git(["push", "--quiet", "origin", "main"])
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

it("reports a checkout removed during the walk as gone after re-stat", async () => {
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
    expect(existsSync(`${extra}.during`), "wrapper did not move the checkout during visit").toBe(true)
    expect(json.exit, `${json.stderr}\n${json.stdout}`).toBe(0)
    const report = reportOf(json.stdout)
    expect(report.failed).toEqual([])
    expect(report.gone).toContainEqual(expect.objectContaining({ path: extra, adminDirectoryExists: true }))
  } finally {
    process.env.PATH = previous
    if (!existsSync(extra) && existsSync(`${extra}.during`)) renameSync(`${extra}.during`, extra)
  }
}, 60_000)
