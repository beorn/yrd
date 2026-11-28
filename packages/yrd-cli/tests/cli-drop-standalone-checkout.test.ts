/**
 * @reach fs-walk <fixture-only: a standalone checkout and its bare origin under a temporary root>
 * @failure yrd drop --local aimed at a standalone checkout (no superproject, no .yrd.yml on its origin main, not a
 * retained store, such as /hh/hallo) refuses "drop --local needs a queue", so a landed branch there has no allowed
 * route at all once the command guard refuses `git branch -d`; or it retires an unmerged branch instead of keeping it.
 * @level l2 (`runYrdProcess` against a real checkout and its origin)
 * @consumer the guard's branch-delete remedy for checkouts outside the dev queue (@chief 5b9098ee, @dev/hallo 8dd4821d).
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
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
      branchIssue: () => undefined,
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

/** A plain clone of a bare origin, with a local branch whose tip origin main has (or has not) landed. */
async function standaloneWorld(merged: boolean) {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-standalone-"))
  roots.push(root)
  const origin = join(root, "origin.git")
  const checkout = join(root, "checkout")
  const branch = "task/landed-elsewhere"
  await gitIn(root)(["init", "--quiet", "--bare", "--initial-branch=main", origin])
  await gitIn(root)(["clone", "--quiet", origin, checkout])
  const git = gitIn(checkout)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(checkout, "README.md"), "standalone\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "main"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["checkout", "--quiet", "-b", branch])
  writeFileSync(join(checkout, "work.txt"), "the branch's work\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "branch work"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  if (merged) await git(["push", "--quiet", "origin", `${branch}:main`])
  await git(["checkout", "--quiet", "main"])
  if (merged) await git(["merge", "--quiet", "--ff-only", "origin/main"])
  return { root, origin, checkout, branch, tip, git }
}

it("retires a landed branch in a standalone checkout named with --repo, pushing and archiving nothing", async () => {
  const world = await standaloneWorld(true)
  const originBefore = await world.git(["ls-remote", "origin"])
  const observed = capture(world.checkout)
  const code = await runYrdProcess(
    [
      "bun",
      "yrd",
      "drop",
      world.branch,
      "--local",
      "--repo",
      world.checkout,
      "--tip",
      world.tip,
      "--submitter",
      "fixture",
      "--json",
    ],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(0)
  expect(observed.stderr()).not.toContain("needs a queue")
  const report = JSON.parse(observed.stdout()) as { removed: { branch: string; head: string; archiveRef?: string }[] }
  expect(report.removed).toEqual([expect.objectContaining({ branch: world.branch, head: world.tip })])
  expect(report.removed[0]).not.toHaveProperty("archiveRef")
  await expect(world.git(["rev-parse", "--verify", `refs/heads/${world.branch}`])).rejects.toThrow()
  expect(await world.git(["ls-remote", "origin"])).toBe(originBefore)
})

it("keeps and reports an unmerged branch in a standalone checkout, pushing nothing", async () => {
  const world = await standaloneWorld(false)
  const originBefore = await world.git(["ls-remote", "origin"])
  const observed = capture(world.checkout)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(1)
  const report = JSON.parse(observed.stdout()) as {
    removed: unknown[]
    kept: { branch: string; head: string; detail?: string }[]
  }
  expect(report.removed).toEqual([])
  expect(report.kept).toEqual([
    expect.objectContaining({ branch: world.branch, head: world.tip, detail: expect.stringContaining("is not merged") }),
  ])
  expect((await world.git(["rev-parse", `refs/heads/${world.branch}`])).trim()).toBe(world.tip)
  expect(await world.git(["ls-remote", "origin"])).toBe(originBefore)
})
