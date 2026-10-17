/**
 * @reach fs-walk <fixture-only: submit refusal runs against a temporary local repository>
 * @failure a submit whose branch cannot be composed with the target must exit nonzero and
 *          name the refusal; a submit that opens no change must never read as success
 *          (NO SILENT ERRORS). 28928: a reported "exit 0, no change" on a conflicting
 *          branch was a pipeline artifact (`... | tail -40` returns tail status, never
 *          yrd status), and yrd already returns 2 with a named reason on every throw.
 *          This test pins the contract the report supposed was missing: a conflicting
 *          submit refuses at exit 2 with "cannot be composed"/"merge-conflict", so it can
 *          never read as a silent success.
 * @level   l2 (the public CLI, a real remote and a real event queue)
 * @consumer seats running yrd submit when their branch conflicts with the target
 * @testonly none
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ root: string; remote: string; work: string }>

async function yrd(
  work: string,
  ...args: string[]
): Promise<Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
    color: false,
    cwd: work,
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
  const root = mkdtempSync(join(tmpdir(), "yrd-submit-conflict-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])

  const git = gitIn(work)
  await git(["config", "user.email", "submit-conflict@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])

  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f .yrd.yml\n")
  writeFileSync(join(work, "conflict.txt"), "base\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "initial main"])
  await git(["push", "--quiet", "origin", "main"])
  // Since 25041 a queue is its event ref: submit refuses a target without one.
  await birthEventQueue(work, "main", { localStore: false })
  return { root, remote, work }
}

describe("yrd submit refusal when the branch conflicts with the target (28928)", () => {
  it("exits nonzero and names the merge-conflict instead of opening nothing", async () => {
    const w = await world()
    const git = gitIn(w.work)

    // The branch moves conflict.txt one way...
    await git(["checkout", "--quiet", "-b", "task/conflict"])
    writeFileSync(join(w.work, "conflict.txt"), "branch side\n")
    await git(["add", "conflict.txt"])
    await git(["commit", "--quiet", "-m", "task/conflict: branch side"])

    // ...and the target moves the SAME line the other way.
    await git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "conflict.txt"), "main side\n")
    await git(["add", "conflict.txt"])
    await git(["commit", "--quiet", "-m", "main moves the same line"])
    await git(["push", "--quiet", "origin", "main"])

    const res = await yrd(w.work, "submit", "task/conflict", "--submitter", "@dev/luna1")
    expect(res.exitCode, res.report).not.toBe(0)
    expect(res.exitCode, res.report).toBe(2)
    expect(`${res.stdout}${res.stderr}`).toContain("cannot be composed")
    expect(`${res.stdout}${res.stderr}`).toContain("merge-conflict")
  })
})
