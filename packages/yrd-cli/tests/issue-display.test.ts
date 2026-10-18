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
import { spawnSync } from "node:child_process"
import { shellQuote } from "git-super/shell-command"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
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
    localBranchProtections: null,
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
async function issuesProject(mode: string, extraArgs: readonly string[] = []): Promise<string> {
  const dir = join(scratch("yrd-issue-display-project-"), "project's view")
  mkdirSync(dir)
  const git = gitIn(dir)
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "issues@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(dir, "issues.yml"), `view: ${JSON.stringify([BUN, PROVIDER, mode, "<key>", ...extraArgs])}\n`)
  await git(["add", "issues.yml"])
  await git(["commit", "--quiet", "-m", "declare view"])
  return dir
}

/** A real queue with distinct historical issue bindings on one branch. */
async function queueWithIssueHistory(issueCount = 1, extraYrdYml = ""): Promise<string> {
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
  await git(["commit", "--quiet", "-m", "task/one does its work"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/one",
    issue: "29644",
    submitter: "@dev/12",
    target: { branch: "main", remote: "origin" },
  })
  for (let index = 1; index < issueCount; index++) {
    await git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(work, "one.txt"), String(index))
    await git(["add", "one.txt"])
    await git(["commit", "--quiet", "-m", "historical revision " + String(index)])
    await git(["checkout", "--quiet", "main"])
    await submit(git, "origin", {
      branch: "task/one",
      issue: "issue-" + String(index),
      submitter: "@dev/12",
      target: { branch: "main", remote: "origin" },
    })
  }
  return work
}

describe("yrd queue show's issue display read (29644 Y1)", () => {
  it("--project-root reaches the display read, which runs the project's view (rule: threading, one reader)", async () => {
    const work = await queueWithIssueHistory()
    const project = await issuesProject("json")
    const shown = await yrd(work, "queue", "show", "task/one", "--json", "--fresh", "--project-root", project)
    expect(shown.exitCode, shown.report).toBe(0)
    expect(shown.stderr, shown.report).toContain('yrd: issue info 29644: {"argv":["29644"]}')
  })

  it("makes no display read without --project-root (rule: absent root, no issue line)", async () => {
    const work = await queueWithIssueHistory()
    const shown = await yrd(work, "queue", "show", "task/one", "--json", "--fresh")
    expect(shown.exitCode, shown.report).toBe(0)
    expect(shown.stderr, shown.report).not.toContain("issue info")
    const all = await yrd(work, "queue", "show", "--all", "--json", "--fresh")
    expect(all.exitCode, all.report).toBe(0)
    expect(all.stderr, all.report).not.toContain("issue display")
  })

  // Five distinct real bindings expose the whole-history read storm without
  // launching thousands of providers (29673, CTO plan amendment).

  it("whole-history show emits every change without attempting optional issue reads", async () => {
    const work = await queueWithIssueHistory(5)
    const project = await issuesProject("json")
    const shown = await yrd(work, "queue", "show", "--all", "--json", "--fresh", "--project-root", project)
    expect(shown.exitCode, shown.report).toBe(0)
    const history = JSON.parse(shown.stdout) as { changes: readonly { issue: string }[] }
    expect(history.changes).toHaveLength(5)
    expect(new Set(history.changes.map((change) => change.issue)).size).toBe(5)
    expect(shown.stderr, shown.report).not.toContain("fake provider:")
    expect(shown.stderr, shown.report).toContain("command syntax: yrd queue show <branch> --project-root <root>")
  })

  // The old one-key suite cannot expose eager startup, an excessive batch, or
  // one failed lookup hiding successful siblings. Four of five keys prove all three.
  it("reads at most four newest distinct branch issues after queue output and preserves siblings on failure", async () => {
    const work = await queueWithIssueHistory(5)
    const trace = scratch("yrd-issue-display-trace-")
    const outputMarker = join(trace, "queue-output")
    const starts = join(trace, "starts.jsonl")
    const project = await issuesProject("trace", [outputMarker, starts])
    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      [BUN, "/usr/local/bin/yrd", "queue", "show", "task/one", "--json", "--fresh", "--project-root", project],
      {
        color: false,
        localBranchProtections: null,
        cwd: work,
        stdout(text) {
          stdout += text
          const history = JSON.parse(stdout) as { changes: readonly unknown[] }
          if (history.changes.length === 5) writeFileSync(outputMarker, "complete")
        },
        stderr(text) {
          stderr += text
        },
      },
    )
    expect(exitCode, stderr).toBe(0)
    expect((JSON.parse(stdout) as { changes: readonly unknown[] }).changes).toHaveLength(5)
    const observed = readFileSync(starts, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { key: string; queueOutputEmitted: boolean })
    expect(observed.map(({ key }) => key).sort(), stderr).toEqual(["issue-1", "issue-2", "issue-3", "issue-4"])
    expect(
      observed.every(({ queueOutputEmitted }) => queueOutputEmitted),
      stderr,
    ).toBe(true)
    expect(stderr).toContain("yrd: issue display: omitted 1 older distinct issue; showing at most 4")
    expect(stderr).toContain("yrd: issue issue-3: issue info unavailable:")
    expect(stderr).toContain('yrd: issue info issue-4: {"key":"issue-4","queueOutputEmitted":true}')
    expect(stderr).toContain('yrd: issue info issue-2: {"key":"issue-2","queueOutputEmitted":true}')
    expect(stderr).toContain('yrd: issue info issue-1: {"key":"issue-1","queueOutputEmitted":true}')
  })

  it("says out loud when the declaration in force still holds issuesProvider.read, and never runs it (rule: retired key said out loud)", async () => {
    const marker = join(scratch("yrd-issue-display-retired-"), "ran")
    const work = await queueWithIssueHistory(
      1,
      `issuesProvider:\n  read: ${JSON.stringify(["sh", "-c", `touch ${JSON.stringify(marker)}`, "read", "<key>"])}\n`,
    )
    const shown = await yrd(work, "queue", "show", "task/one", "--json", "--fresh")
    expect(shown.exitCode, shown.report).toBe(0)
    expect(shown.stderr, shown.report).toContain("issuesProvider.read: retired")
    expect(shown.stderr, shown.report).toContain("command syntax: yrd queue show <branch> --project-root <root>")
    const project = await issuesProject("json")
    const remote = join(work, "..", "remote.git")
    const refs = await gitIn(remote)(["for-each-ref", "--format=%(refname) %(objectname)"])
    const commands: { argv: readonly string[]; cwd: string; recipe: string }[] = []
    let stderr = ""
    const code = await runYrdProcess(
      [BUN, "/usr/local/bin/yrd", "queue", "show", "task/one", "--json", "--fresh", "--project-root", project],
      {
        color: false,
        localBranchProtections: null,
        cwd: work,
        stdout: () => {},
        stderr: (text) => {
          stderr += text
        },
        formatYrdCommand: (argv, cwd) => {
          const recipe = `cd ${shellQuote(cwd)} && ${shellQuote(BUN)} ${shellQuote(resolve(import.meta.dirname, "../../../bin/yrd.ts"))} ${argv.map(shellQuote).join(" ")}`
          commands.push({ argv, cwd, recipe })
          return recipe
        },
      },
    )
    expect(code, stderr).toBe(0)
    expect(commands, stderr).toHaveLength(1)
    const command = commands[0]!
    expect(command.argv).toEqual([
      "queue",
      "show",
      "task/one",
      "--project-root",
      project,
      "--queue",
      `${resolve(remote)}#main`,
    ])
    expect(command.cwd).toBe(work)
    expect(stderr).toContain(command.recipe)
    const copied = spawnSync("/bin/sh", ["-c", command.recipe], { cwd: TMP, encoding: "utf8" })
    expect(copied.status, copied.stderr).toBe(0)
    expect(copied.stdout).toContain("task/one")
    expect(copied.stderr).toContain('yrd: issue info 29644: {"argv":["29644"]}')
    expect(await gitIn(remote)(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs)
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
