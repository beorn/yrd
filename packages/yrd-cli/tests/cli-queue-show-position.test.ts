/**
 * @failure  `yrd queue show <branch> --json` put `position: 1` on every waiting
 *           branch: its per-branch fold built a one-element in-line set, so the
 *           rank it reported could never be anything but first. `yrd queue list`
 *           read the same two branches as 1 and 2, so an agent reading one
 *           branch mistook a constant for its place in the merge line (29342).
 * @level    l2 (a real queue in a real Git worktree, read through the CLI)
 * @consumer an agent checking where its submitted change stands in the queue
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { submit } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

/** The CLI as the shell runs it: argv in, exit code and both streams out. */
async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
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
 * A bare remote whose `main` declares the queue, a clone of it, and TWO changes
 * submitted first and second in that order, so the queue holds a two-change line.
 */
async function queueWithTwoChanges(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-show-position-"))
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
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await birthEventQueue(work)
  for (const name of ["one", "two"]) {
    await git(["checkout", "--quiet", "-b", `task/${name}`, "main"])
    writeFileSync(join(work, `${name}.txt`), `${name}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", `task/${name} does its work`])
    await git(["checkout", "--quiet", "main"])
    await submit(git, "origin", {
      branch: `task/${name}`,
      submitter: "@dev/10",
      target: { branch: "main", remote: "origin" },
    })
  }
  return work
}

type Change = Readonly<{ branch: string; position?: number; state: string }>

/** The line positions a reading reports, keyed by branch, for the changes holding one. */
function positions(reading: Ran): Record<string, number> {
  const parsed = JSON.parse(reading.stdout) as { changes: readonly Change[] }
  const found: Record<string, number> = {}
  for (const change of parsed.changes) {
    if (change.position !== undefined) found[change.branch] = change.position
  }
  return found
}

describe("`yrd queue show` and the merge-line position (#29342)", () => {
  it("reports list's line position where it reads the line, and none where it reads one branch", async () => {
    const work = await queueWithTwoChanges()

    const list = await yrd(work, "queue", "list", "--json")
    expect(list.exitCode, list.report).toBe(0)
    expect(positions(list), list.report).toEqual({ "task/one": 1, "task/two": 2 })

    // `show --all` folds every change chain, so it knows the line and must agree with list.
    const all = await yrd(work, "queue", "show", "--all", "--json")
    expect(all.exitCode, all.report).toBe(0)
    expect(positions(all), all.report).toEqual(positions(list))

    // `show <branch>` folds one branch. It has no line to place the change in, so
    // `position` — "1-based place in line, absent otherwise" — must be absent, never
    // the constant 1 its one-element in-line set used to yield.
    for (const [branch, position] of Object.entries({ "task/one": 1, "task/two": 2 })) {
      const show = await yrd(work, "queue", "show", branch, "--json")
      expect(show.exitCode, show.report).toBe(0)
      const parsed = JSON.parse(show.stdout) as { changes: readonly Change[] }
      expect(
        parsed.changes.map((change) => change.branch),
        show.report,
      ).toContain(branch)
      expect(positions(show), show.report).toEqual({})
      expect(
        parsed.changes.every((change) => change.position === undefined),
        show.report,
      ).toBe(true)
      expect(positions(list)[branch], list.report).toBe(position)
    }
  })
})
