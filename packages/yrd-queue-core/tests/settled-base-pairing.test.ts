/**
 * @failure A raised submodule pin is composed onto the target without the root lockfile the same change authored, so the
 * settled base is internally inconsistent and a check judges a tree the submitter never wrote.
 * @level l3
 * @consumer Yrd queue operator and submitter (hh #38155, bearly 7692206 / durable-file 0.1.0 -> 0.2.0)
 * @reach fs-walk <fixture-only: temporary Git repositories and bare remotes the cases build under the OS temp root>
 * @testonly none
 *
 * The defect these cases stand against (hh-dev, merge 9d067f69c2a, 2026-11-24 11:15-11:27Z): the composer raised
 * vendor/bearly to 7692206, whose workspace member reads 0.2.0, while the base kept the target's bun.lock, which
 * still describes 0.1.0. lockfile-agreement then refused a tree with no author behind it. The invariant is that a
 * composed base carries a raised gitlink TOGETHER with that change's root lockfile, so
 * `bun install --frozen-lockfile` passes on the base before any change is judged.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { testGitIn } from "../../../tests/support/test-git-in.ts"
import { settledBaseCommit } from "../src/settled-base.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A root repo whose one gitlink can be raised, plus the candidate that raises it and moves the root lock with it. */
async function raiseFixture(candidateLock = "durable-file 0.2.0\n"): Promise<{
  root: string
  git: ReturnType<typeof testGitIn>
  target: string
  candidate: string
  before: string
  after: string
}> {
  const root = mkdtempSync(join(tmpdir(), "yrd-settled-pairing-"))
  roots.push(root)
  const git = testGitIn(root)
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "yrd@example.test"])
  await git(["config", "user.name", "yrd"])
  // The two component commits the gitlink moves between; nothing here needs a checkout, only the objects.
  const component = async (version: string): Promise<string> => {
    const tree = (await git(["mktree"], `100644 blob ${(await git(["hash-object", "-w", "--stdin"], version)).trim()}\tpackage.json\n`)).trim()
    return (await git(["commit-tree", tree, "-m", `durable-file ${version}`])).trim()
  }
  const before = await component("0.1.0")
  const after = await component("0.2.0")
  writeFileSync(join(root, "package.json"), '{ "name": "root", "version": "1.0.0" }\n')
  writeFileSync(join(root, "bun.lock"), "durable-file 0.1.0\n")
  await git(["add", "bun.lock", "package.json"])
  await git(["update-index", "--add", "--cacheinfo", `160000,${before},vendor/component`])
  await git(["commit", "--quiet", "-m", "target pins durable-file 0.1.0"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  writeFileSync(join(root, "bun.lock"), candidateLock)
  await git(["add", "bun.lock"])
  await git(["update-index", "--add", "--cacheinfo", `160000,${after},vendor/component`])
  await git(["commit", "--quiet", "-m", "raise durable-file to 0.2.0 and regenerate the lock"])
  const candidate = (await git(["rev-parse", "HEAD"])).trim()
  return { root, git, target, candidate, before, after }
}

describe("settled base pairing", () => {
  it("carries the raised gitlink together with the root lockfile that change authored", async () => {
    const fixture = await raiseFixture()
    const settled = await settledBaseCommit({
      git: fixture.git,
      repo: fixture.root,
      targetSha: fixture.target,
      candidate: fixture.candidate,
      rootPaths: ["bun.lock"],
      raises: [{ path: "vendor/component", mode: "160000", from: fixture.before, to: fixture.after }],
      path: mkdtempSync(join(tmpdir(), "yrd-settled-compose-")),
      branch: "task/raise",
    })
    expect(settled).not.toBe(fixture.target)
    expect((await fixture.git(["ls-tree", "--object-only", settled, "vendor/component"])).trim()).toBe(fixture.after)
    expect((await fixture.git(["show", `${settled}:bun.lock`])).trim()).toBe("durable-file 0.2.0")
  })

  it("leaves the target lockfile alone when the change did not move it", async () => {
    const fixture = await raiseFixture("durable-file 0.1.0\n")
    const settled = await settledBaseCommit({
      git: fixture.git,
      repo: fixture.root,
      targetSha: fixture.target,
      candidate: fixture.candidate,
      rootPaths: ["bun.lock"],
      raises: [{ path: "vendor/component", mode: "160000", from: fixture.before, to: fixture.after }],
      path: mkdtempSync(join(tmpdir(), "yrd-settled-compose-")),
      branch: "task/raise-no-lock",
    })
    expect((await fixture.git(["ls-tree", "--object-only", settled, "vendor/component"])).trim()).toBe(fixture.after)
    expect((await fixture.git(["show", `${settled}:bun.lock`])).trim()).toBe("durable-file 0.1.0")
  })

  it("composes the gitlink alone when the caller names no candidate", async () => {
    const fixture = await raiseFixture()
    const settled = await settledBaseCommit({
      git: fixture.git,
      repo: fixture.root,
      targetSha: fixture.target,
      raises: [{ path: "vendor/component", mode: "160000", from: fixture.before, to: fixture.after }],
      path: mkdtempSync(join(tmpdir(), "yrd-settled-compose-")),
      branch: "task/raise-bare",
    })
    expect((await fixture.git(["ls-tree", "--object-only", settled, "vendor/component"])).trim()).toBe(fixture.after)
    expect((await fixture.git(["show", `${settled}:bun.lock`])).trim()).toBe("durable-file 0.1.0")
  })

  it("pairs only the paths the target declares: an undeclared lockfile stays the target's", async () => {
    const fixture = await raiseFixture()
    const settled = await settledBaseCommit({
      git: fixture.git,
      repo: fixture.root,
      targetSha: fixture.target,
      candidate: fixture.candidate,
      rootPaths: ["package.json"],
      raises: [{ path: "vendor/component", mode: "160000", from: fixture.before, to: fixture.after }],
      path: mkdtempSync(join(tmpdir(), "yrd-settled-compose-")),
      branch: "task/raise-undeclared-lock",
    })
    expect((await fixture.git(["ls-tree", "--object-only", settled, "vendor/component"])).trim()).toBe(fixture.after)
    expect((await fixture.git(["show", `${settled}:bun.lock`])).trim()).toBe("durable-file 0.1.0")
  })

  it("refuses by name when the change also edits a root manifest, because then the lock is not the raise's alone", async () => {
    const fixture = await raiseFixture()
    await fixture.git(["checkout", "--quiet", "-b", "manifest"])
    writeFileSync(join(fixture.root, "package.json"), '{ "name": "root", "version": "1.0.0", "dependencies": {} }\n')
    await fixture.git(["add", "package.json"])
    await fixture.git(["commit", "--quiet", "-m", "edit the root manifest with the raise"])
    const both = (await fixture.git(["rev-parse", "HEAD"])).trim()
    await expect(
      settledBaseCommit({
        git: fixture.git,
        repo: fixture.root,
        targetSha: fixture.target,
        candidate: both,
        rootPaths: ["bun.lock"],
        raises: [{ path: "vendor/component", mode: "160000", from: fixture.before, to: fixture.after }],
        path: mkdtempSync(join(tmpdir(), "yrd-settled-compose-")),
        branch: "task/raise-and-manifest",
      }),
    ).rejects.toThrow(
      /change raises vendor\/component and edits root manifests package\.json; the base cannot pair its lock\. Submit the raise separately\./u,
    )
  })
})
