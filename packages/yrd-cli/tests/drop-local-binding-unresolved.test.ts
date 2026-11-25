/**
 * @failure `yrd drop <branch> --local` keeps a landed branch forever when the host can read no bead for its
 *          free-text recorded binding (@cto c95d0a0d, 38545). The host may now allow that drop, so the exception
 *          must reach the JSON report as `bindingUnresolved` and say one loud line on stderr.
 * @level l3
 * @consumer Authors retiring one landed local branch after a merge, and the queue sweep that reads --json
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const BINDING = "416acf56"
const UNRESOLVED =
  `branch topic-landed: recorded binding "${BINDING}" is free text that resolves to no bead, ` +
  "so no issue-scoped holds could be read; the tip is already in origin/main"

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stderr = ""
  let stdout = ""
  return {
    io: {
      // The host adapter's own landed exception: an unreadable binding on a landed tip returns the field.
      localBranchProtections: async (input) => ({
        protections: [],
        evidence: [],
        ...(input.issue === BINDING ? { bindingUnresolved: UNRESOLVED } : {}),
      }),
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
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-local-binding-"))
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

it("reports a landed free-text binding in --json and on stderr, and retires the branch", async () => {
  const repo = await world()
  const git = gitIn(repo)
  await git(["checkout", "--quiet", "-b", "topic-landed"])
  writeFileSync(join(repo, "landed.txt"), "landed\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "landed work"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  await git(["merge", "--quiet", "--no-ff", "-m", "merge topic-landed", "topic-landed"])

  const out = capture(repo)
  const exit = await runYrdProcess(
    [
      "bun",
      "yrd",
      "drop",
      "topic-landed",
      "--local",
      "--tip",
      tip,
      "--issue",
      BINDING,
      "--reason",
      "landed sweep",
      "--submitter",
      "fixture",
      "--json",
    ],
    out.io,
  )
  expect(exit, `${out.stderr()}\n${out.stdout()}`).toBe(0)
  const report = JSON.parse(out.stdout()) as {
    removed: { branch: string }[]
    kept: unknown[]
    failed: unknown[]
    bindingUnresolved?: string
  }
  expect(report.bindingUnresolved, out.stdout()).toBe(UNRESOLVED)
  expect(report.removed.map((row) => row.branch)).toEqual(["topic-landed"])
  expect(out.stderr(), "the exception is loud, once").toContain(`yrd: ${UNRESOLVED}`)
  expect(out.stderr().split(`yrd: ${UNRESOLVED}`).length - 1).toBe(1)
  await expect(git(["rev-parse", "--verify", "refs/heads/topic-landed"])).rejects.toThrow()
}, 60_000)
