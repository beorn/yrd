/**
 * @failure A change that moves a private submodule's gitlink is admitted although no Yrd environment holds the
 *          child, so nothing Yrd runs could verify it (27147).
 * @level   l1 (real repository; the parent's trees only)
 * @consumer `yrd submit` from every seat
 * @testonly none
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { declaredPrivateSubmodules, refuseMovedPrivateGitlinks } from "../src/private-submodules.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const FIRST = "1".repeat(40)
const SECOND = "2".repeat(40)

/** A parent whose `.gitmodules` declares vendor/secret private and pins it by plumbing; no child exists anywhere. */
async function parent(): Promise<Readonly<{ git: ReturnType<typeof gitIn>; repo: string; base: string }>> {
  const repo = mkdtempSync(join(tmpdir(), "yrd-private-submodules-"))
  roots.push(repo)
  const git = gitIn(repo)
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "private@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(
    join(repo, ".gitmodules"),
    '[submodule "vendor/secret"]\n\tpath = vendor/secret\n\turl = https://example.invalid/secret.git\n\tprivate = true\n',
  )
  await git(["add", ".gitmodules"])
  await git(["update-index", "--add", "--cacheinfo", `160000,${FIRST},vendor/secret`])
  await git(["commit", "--quiet", "-m", "declare a private child"])
  return { git, repo, base: (await git(["rev-parse", "HEAD"])).trim() }
}

async function commitPin(git: ReturnType<typeof gitIn>, pin: string, message: string): Promise<string> {
  await git(["update-index", "--cacheinfo", `160000,${pin},vendor/secret`])
  await git(["commit", "--quiet", "-m", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}

describe("private submodules (27147)", () => {
  it("reads the paths a commit declares private = true through git-super's reader", async () => {
    const { git, repo, base } = await parent()
    expect(await declaredPrivateSubmodules(git, repo, base)).toEqual(["vendor/secret"])
  })

  it("admits a change that leaves the private gitlink where it was", async () => {
    const { git, repo, base } = await parent()
    writeFileSync(join(repo, "README"), "unrelated\n")
    await git(["add", "README"])
    await git(["commit", "--quiet", "-m", "touch something else"])
    const head = (await git(["rev-parse", "HEAD"])).trim()

    await expect(refuseMovedPrivateGitlinks(git, repo, "task/other", base, head)).resolves.toBeUndefined()
  })

  it("refuses, by name, a change that moves the private gitlink", async () => {
    const { git, repo, base } = await parent()
    const head = await commitPin(git, SECOND, "move the private pin")

    await expect(refuseMovedPrivateGitlinks(git, repo, "task/move", base, head)).rejects.toThrow(
      `yrd: task/move at ${head} changes the gitlink of private submodule vendor/secret (declared private = true in .gitmodules); ` +
        "a Yrd environment does not hold vendor/secret, so a change to its gitlink cannot be verified here",
    )
  })

  it("still refuses the move when the same change drops the declaration", async () => {
    const { git, repo, base } = await parent()
    await git(["config", "--file", ".gitmodules", "--unset", "submodule.vendor/secret.private"])
    await git(["add", ".gitmodules"])
    const head = await commitPin(git, SECOND, "undeclare and move")

    await expect(refuseMovedPrivateGitlinks(git, repo, "task/sneak", base, head)).rejects.toThrow(
      /changes the gitlink of private submodule vendor\/secret/u,
    )
  })
})
