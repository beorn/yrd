/**
 * @reach fs-walk <fixture-only: submit refusal runs against a temporary local repository>
 * @failure An unreadable queue produces a host-specific retry or invents a current executable without host authority.
 * @level   l2
 * @consumer seats running yrd submit when the worktree's yrd is older than the queue's writer
 * @testonly none
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it, vi } from "vitest"
import { shellQuote } from "git-super/shell-command"
import { openEvents } from "gitomic/events"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  root: string
  remote: string
  work: string
}>

async function yrd(
  work: string,
  args: readonly string[],
  formatYrdCommand?: YrdCliIO["formatYrdCommand"],
): Promise<
  Readonly<{
    exitCode: YrdCliExitCode
    stdout: string
    stderr: string
    report: string
  }>
> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
    color: false,
    cwd: work,
    ...(formatYrdCommand === undefined ? {} : { formatYrdCommand }),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return { exitCode, stdout, stderr, report: `yrd ${args.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}` }
}

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-submit-skew-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work's checkout")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])

  const git = gitIn(work)
  await git(["config", "user.email", "submit-skew@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])

  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f .yrd.yml\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "initial main with .yrd.yml"])
  await git(["push", "--quiet", "origin", "main"])
  await birthEventQueue(work, "main", { localStore: false })

  return { root, remote, work }
}

describe("yrd submit refusal when queue carries an unreadable event shape (#26814)", () => {
  it("diagnoses version skew and uses the selected host retry when queue event type is unknown", async () => {
    const w = await world()
    const git = gitIn(w.work)
    await git(["fetch", "--quiet", "origin", "refs/yrd/main/queue:refs/yrd/main/queue"])

    // Append an unreadable event (future event type) to the queue
    const chain = await openEvents({ repo: w.work, ref: "refs/yrd/main/queue", writer: "future-runner" })
    const head = await chain.head()
    await chain.append(
      [
        {
          type: "future-migration-v99",
          props: [
            ["Queue", head!],
            ["Time", new Date().toISOString()],
          ],
        },
      ],
      {
        expect: head,
      },
    )
    await git(["push", "--quiet", "origin", "refs/yrd/main/queue"])

    // Create a new change to submit
    await git(["checkout", "--quiet", "-b", "task/future-skew"])
    writeFileSync(join(w.work, "change.txt"), "hello\n")
    await git(["add", "change.txt"])
    await git(["commit", "--quiet", "-m", "task/future-skew: change"])

    const executable = join(w.root, "root-v1")
    symlinkSync(process.execPath, executable)
    const entry = fileURLToPath(new URL("../../../bin/yrd.ts", import.meta.url))
    const format = vi.fn(
      (args: readonly string[], cwd: string) =>
        `cd ${shellQuote(cwd)} && ${[executable, entry, ...args].map(shellQuote).join(" ")}`,
    )
    const args = ["submit", "task/future-skew", "--submitter", "fixture"]
    const res = await yrd(w.work, args, format)
    expect(res.exitCode, res.report).toBe(2)
    expect(res.stderr, res.report).toContain("this CLI is older than the queue's writer")
    expect(res.stderr, res.report).toContain("current build of Yrd")
    expect(res.stderr, res.report).not.toContain("@in")
    expect(format).toHaveBeenCalledExactlyOnceWith(args, w.work)
    const printed = res.stderr.split("After selecting a current build, retry:\n  ")[1]?.split("\n")[0]
    expect(printed, res.report).toBeDefined()
    const retried = spawnSync("bash", ["-c", printed!], { cwd: w.root, encoding: "utf8" })
    // The fixture deliberately retains the future writer: the printed retry must reach that queue from outside it.
    expect(retried.status, retried.stderr).toBe(2)
    expect(retried.stderr).toContain("this CLI is older than the queue's writer")
  })

  it("diagnoses version skew without inventing a retry executable when merge-fenced writer fails validation", async () => {
    const w = await world()
    const git = gitIn(w.work)
    await git(["fetch", "--quiet", "origin", "refs/yrd/main/queue:refs/yrd/main/queue"])

    // Append a merge-fenced event with non-runner writer to simulate writer trailer retirement / version mismatch
    const chain = await openEvents({ repo: w.work, ref: "refs/yrd/main/queue", writer: "wrong-writer" })
    const head = await chain.head()
    await chain.append(
      [
        {
          type: "merge-fenced",
          props: [
            ["Queue", head!],
            ["Time", new Date().toISOString()],
            ["For", "0".repeat(40)],
            ["Branch", "task/dummy"],
            ["Commit", "0".repeat(40)],
            ["Ops", JSON.stringify({ version: 1, pause: null, overrides: [] })],
          ],
        },
      ],
      { expect: head },
    )
    await git(["push", "--quiet", "origin", "refs/yrd/main/queue"])

    await git(["checkout", "--quiet", "-b", "task/fence-skew"])
    writeFileSync(join(w.work, "change.txt"), "world\n")
    await git(["add", "change.txt"])
    await git(["commit", "--quiet", "-m", "task/fence-skew: change"])

    const res = await yrd(w.work, ["submit", "task/fence-skew", "--submitter", "fixture", "--dry-run"])
    expect(res.exitCode, res.report).toBe(2)
    expect(res.stderr, res.report).toContain("this CLI is older than the queue's writer")
    expect(res.stderr, res.report).toContain("repeat this invocation with a current build of Yrd")
    expect(res.stderr, res.report).not.toContain("@in")
    expect(res.stderr, res.report).not.toContain("\n  ")
  })
})
