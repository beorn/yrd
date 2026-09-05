/**
 * @failure  `yrd queue stats` is the retro's and pm-metrics' source: a flag
 *           that parses wrong, a JSON that is not the documented shape, or a
 *           document cut at 64 KiB on its way into a file makes twelve seats
 *           count by hand again (@i/10-yrd/24164; the cut measured by @dev/3
 *           on `yrd queue list --json | jq`, 2a71e626).
 * @consumer the operator's retro · pm-metrics (@hh/tooling/pm-metrics)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, submit } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

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
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

/**
 * A bare remote whose main declares the queue, a clone, one change submitted
 * from it, and one branch pushed without a submit (plan E2): the smallest
 * queue with every number the stats command counts.
 */
async function queueWithOneChangeAndOnePush(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-stats-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "target: origin#main\nchecks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["checkout", "--quiet", "-b", "task/one", "main"])
  writeFileSync(join(work, "pass.txt"), "pass\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "task/one does its work"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/one",
    submitter: "@dev/10",
    target: { branch: "main", remote: "origin" },
  })
  // Pushed, never submitted: at the remote, no change ref.
  await git(["checkout", "--quiet", "-b", "task/pushed-only", "main"])
  writeFileSync(join(work, "note.txt"), "pushed only\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "task/pushed-only is pushed and never submitted"])
  await git(["push", "--quiet", "origin", "task/pushed-only"])
  await git(["checkout", "--quiet", "main"])
  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

describe("yrd queue stats through the process entry", () => {
  it("prints the table with the queue line, the submitter line and the pushed-never-submitted count", async () => {
    const work = await queueWithOneChangeAndOnePush()
    const ran = await yrd(work, "queue", "stats")
    expect(ran.exitCode, ran.report).toBe(0)
    const lines = ran.stdout.trimEnd().split("\n")
    expect(lines[0]).toContain("#main · stats at ")
    expect(lines[0]).toContain("the default seven days")
    expect(lines[0]).toContain("by submitter")
    expect(lines[2]).toMatch(/^queue\s+1\s+0\s+0\s+0\s+0\s+1\s+0\s+1\s+0\s+0\s+—\s+—$/u)
    expect(lines[3]).toMatch(/^@dev\/10\s+1\b/u)
    expect(ran.stdout).toContain("pushed, never submitted: 1 (oldest 0:0")
  })

  it("--json is the documented document: queue name, window, total, groups, pushed refs; --by branch groups by branch", async () => {
    const work = await queueWithOneChangeAndOnePush()
    const ran = await yrd(work, "queue", "stats", "--json", "--since", "1d", "--by", "branch")
    expect(ran.exitCode, ran.report).toBe(0)
    const document = JSON.parse(ran.stdout) as {
      queue: string
      at: string
      since: string
      defaultWindow: boolean
      by: string
      total: { rows: number; changes: number; branches: number; latency: { count: number } }
      groups: readonly { key: string; rows: number }[]
      pushedNeverSubmitted: { count: number; ageUnknown: number; refs: readonly { branch: string; ageMs?: number }[] }
    }
    expect(document.queue).toMatch(/remote\.git#main$/u)
    expect(document.defaultWindow).toBe(false)
    expect(new Date(document.at).getTime() - new Date(document.since).getTime()).toBe(86_400_000)
    expect(document.by).toBe("branch")
    expect(document.total).toMatchObject({ branches: 1, changes: 1, rows: 1 })
    expect(document.groups).toEqual([expect.objectContaining({ key: "task/one", rows: 1 })])
    expect(document.pushedNeverSubmitted.count).toBe(1)
    expect(document.pushedNeverSubmitted.ageUnknown).toBe(0)
    expect(document.pushedNeverSubmitted.refs[0]?.branch).toBe("task/pushed-only")
  })

  it("--since takes a commit this repository has, and refuses what it cannot read, naming the forms", async () => {
    const work = await queueWithOneChangeAndOnePush()
    const byCommit = await yrd(work, "queue", "stats", "--json", "--since", "main")
    expect(byCommit.exitCode, byCommit.report).toBe(0)
    expect((JSON.parse(byCommit.stdout) as { defaultWindow: boolean }).defaultWindow).toBe(false)

    const refused = await yrd(work, "queue", "stats", "--since", "nope")
    expect(refused.exitCode).toBe(2)
    expect(refused.stderr).toContain("--since nope is not a duration (3h, 45m, 2d, 1w), an instant, or a commit")

    const badBy = await yrd(work, "queue", "stats", "--by", "author")
    expect(badBy.exitCode).toBe(2)
    expect(badBy.stderr).toContain("--by takes submitter or branch, not author")
  })
})

describe("the executable's stdout reaches a pipe whole", () => {
  it("a document far larger than a pipe's buffer arrives complete and the process exits 0", async () => {
    // The writer the executable installs, driven from a child so the pipe is real.
    const root = mkdtempSync(join(tmpdir(), "yrd-fd-"))
    roots.push(root)
    const script = join(root, "emit.ts")
    const writer = join(import.meta.dirname, "../src/stdout-fd.ts")
    writeFileSync(
      script,
      `import { fdWriters } from ${JSON.stringify(writer)}\n` +
        'const line = "x".repeat(1023) + "\\n"\n' +
        "fdWriters.stdout(line.repeat(512))\n" + // 512 KiB, eight times the 64 KiB cut
        "process.exit(0)\n",
    )
    const child = Bun.spawn([process.execPath, script], { stderr: "pipe", stdout: "pipe" })
    // Read late on purpose: the child must not lose bytes to a reader that is slow to start.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.length).toBe(512 * 1024)
    expect(stdout.endsWith("x\n")).toBe(true)
  })
})
