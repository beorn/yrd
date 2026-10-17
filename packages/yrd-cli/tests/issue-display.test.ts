/**
 * @failure  `yrd queue show`'s issue line is read through the issues interface (29644 Y1, @cto rulings 0e9e794e /
 *           b59e0e09 / 6a06588f). If `--project-root` did not reach the display read, show would decorate from the wrong
 *           project or not at all; if the read bypassed `runIssuesVerb`, a second reader of issue state would
 *           grow beside `yrd issues`; if a declaration in force still holding `issuesProvider.read` were ignored in
 *           silence, a retired mechanism would go unsaid; and if the 10 s bound did not kill the provider, one hung
 *           tracker would hold every `show` open.
 * @level    l2 (a real queue in a real Git worktree, a real issues.yml project and provider process)
 * @consumer an operator or agent reading `yrd queue show` for a change bound to an issue
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { submit } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { readIssueDisplay } from "../src/issue-resolver.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const PROVIDER = resolve(import.meta.dirname, "support/fake-issues-provider.ts")
const BUN = process.execPath
const TMP = realpathSync(tmpdir())
const roots: string[] = []

afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: TMP, allowedRoots: [TMP], allowMissing: true })
})

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(TMP, prefix)))
  roots.push(root)
  return root
}

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([BUN, "/usr/local/bin/yrd", ...args], io)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

/** A project whose committed `main` declares `view` as the fake provider in `mode`. */
async function issuesProject(mode: string): Promise<string> {
  const dir = join(scratch("yrd-issue-display-project-"), "project")
  mkdirSync(dir)
  const git = gitIn(dir)
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "issues@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(dir, "issues.yml"), `view: ${JSON.stringify([BUN, PROVIDER, mode, "<key>"])}\n`)
  await git(["add", "issues.yml"])
  await git(["commit", "--quiet", "-m", "declare view"])
  return dir
}

/** A queue whose one change is bound to issue 29644. */
async function queueWithIssueChange(extraYrdYml = ""): Promise<string> {
  const root = scratch("yrd-issue-display-queue-")
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), `checks:\n  - verify:\n      run: test -f pass.txt\n${extraYrdYml}`)
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await birthEventQueue(work)
  await git(["checkout", "--quiet", "-b", "task/one", "main"])
  writeFileSync(join(work, "one.txt"), "one\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "task/one does its work\n\nRefs: 29644"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/one",
    issue: "29644",
    submitter: "@dev/12",
    target: { branch: "main", remote: "origin" },
  })
  return work
}

describe("yrd queue show's issue display read (29644 Y1)", () => {
  it("--project-root reaches the display read, which runs the project's view (rule: threading, one reader)", async () => {
    const work = await queueWithIssueChange()
    const project = await issuesProject("json")
    const shown = await yrd(work, "queue", "show", "task/one", "--json", "--fresh", "--project-root", project)
    expect(shown.exitCode, shown.report).toBe(0)
    expect(shown.stderr, shown.report).toContain('yrd: issue info 29644: {"argv":["29644"]}')
  })

  it("makes no display read without --project-root (rule: absent root, no issue line)", async () => {
    const work = await queueWithIssueChange()
    const shown = await yrd(work, "queue", "show", "task/one", "--json", "--fresh")
    expect(shown.exitCode, shown.report).toBe(0)
    expect(shown.stderr, shown.report).not.toContain("issue info")
  })

  it("says out loud when the declaration in force still holds issuesProvider.read, and never runs it (rule: retired key said out loud)", async () => {
    const marker = join(scratch("yrd-issue-display-retired-"), "ran")
    const work = await queueWithIssueChange(
      `issuesProvider:\n  read: ${JSON.stringify(["sh", "-c", `touch ${JSON.stringify(marker)}`, "read", "<key>"])}\n`,
    )
    const shown = await yrd(work, "queue", "show", "task/one", "--json", "--fresh")
    expect(shown.exitCode, shown.report).toBe(0)
    expect(shown.stderr, shown.report).toContain(
      "yrd: .yrd.yml issuesProvider.read: retired (29644 Y1) and ignored; the issue display is issues.yml's view, read by yrd queue show --project-root <root>; delete this key",
    )
    expect(existsSync(marker)).toBe(false)
  })

  it("names a failed read unavailable with the reader's cause (rule: failure shows unavailable)", async () => {
    const project = await issuesProject("exit3")
    const display = await readIssueDisplay({ key: "k", projectRoot: project, cwd: project, stderr: () => {} })
    expect(display).toMatchObject({
      available: false,
      reason: expect.stringContaining("issue info unavailable: yrd-issues-provider-failed: view"),
    })
  })

  it("kills the provider at the display bound and says so (rule: bounded display read)", async () => {
    const project = await issuesProject("sleep")
    const started = Date.now()
    const display = await readIssueDisplay({
      key: "k",
      projectRoot: project,
      cwd: project,
      timeoutMs: 300,
      stderr: () => {},
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(display).toMatchObject({
      available: false,
      reason: expect.stringContaining("issue info unavailable: yrd-issues-provider-timed-out: view"),
    })
  })
})
