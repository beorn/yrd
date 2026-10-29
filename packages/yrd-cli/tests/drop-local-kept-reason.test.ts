/**
 * @failure `yrd drop <branch> --local --tip` keeps an ineligible branch, prints no
 * eligibility rule, and exits 0 as if it had retired it.
 * @level l3
 * @consumer Authors retiring one local branch after a merged landing
 * @testonly none
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-kept-"))
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

async function drop(
  repo: string,
  branch: string,
  tip: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out = capture(repo)
  const exit = await runYrdProcess(
    ["bun", "yrd", "drop", branch, "--local", "--tip", tip, "--submitter", "fixture"],
    out.io,
  )
  return { exit, stdout: out.stdout(), stderr: out.stderr() }
}

it("retires the merged branch and refuses the unmerged one with a named rule and a non-zero exit", async () => {
  const repo = await world()
  const git = gitIn(repo)

  await git(["checkout", "--quiet", "-b", "topic-merged"])
  writeFileSync(join(repo, "merged.txt"), "merged\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "merged work"])
  const mergedTip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  await git(["merge", "--quiet", "--no-ff", "-m", "merge topic-merged", "topic-merged"])

  await git(["checkout", "--quiet", "-b", "topic-kept"])
  writeFileSync(join(repo, "kept.txt"), "kept\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "work that moves the tip"])
  const staleTip = (await git(["rev-parse", "HEAD~1"])).trim()
  await git(["checkout", "--quiet", "main"])

  const retired = await drop(repo, "topic-merged", mergedTip)
  expect(retired.exit, `${retired.stderr}\n${retired.stdout}`).toBe(0)
  expect(retired.stdout).toContain("retired 1")

  const kept = await drop(repo, "topic-kept", staleTip)
  expect(kept.stdout).toContain("kept 1")
  expect(kept.stdout, "the receipt must name the rule that kept the branch").toMatch(
    /differs from requested tip|advanced/,
  )
  const identity = `${realpathSync(join(repo, ".git"))}#refs/heads/topic-kept`
  expect(kept.stdout).toContain(identity)
  const keptJSON = capture(repo)
  expect(
    await runYrdProcess(
      ["bun", "yrd", "drop", "topic-kept", "--local", "--tip", staleTip, "--submitter", "fixture", "--json"],
      keptJSON.io,
    ),
  ).toBe(1)
  const detail = (JSON.parse(keptJSON.stdout()) as { kept: { detail: string }[] }).kept[0]!.detail
  expect(detail).toContain(identity)
  expect(kept.stdout).toContain(detail)
  expect((await git(["rev-parse", "refs/heads/topic-kept"])).trim()).not.toBe(staleTip)
  expect(kept.exit, `kept a branch but exited ${kept.exit}:\n${kept.stderr}\n${kept.stdout}`).not.toBe(0)
}, 60_000)

// #31083: `--discard` needs an actor and a reason, but its help named neither; an author spent two attempts finding
// --submitter and --reason (@dev/luna5, 2026-10-27). The held keep's human line is pinned in cli-drop-local-origin-archive.
it("names --submitter and --reason in the --discard help", async () => {
  const help = capture(process.cwd())
  await runYrdProcess(["bun", "yrd", "drop", "--help"], help.io).catch(() => undefined)
  const discardHelp = help.stdout().replace(/\s+/gu, " ").match(/--discard (.*?) --release-checkout/u)?.[1] ?? ""
  expect(discardHelp, help.stdout()).toContain("--reason")
  expect(discardHelp).toContain("--submitter")
})
