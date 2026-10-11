/**
 * @reach fs-walk <fixture-only: temporary repositories under the system temp dir>
 * @failure A plain removal (rmSync + prune, safeRemoveSync) deletes a declared-private submodule store
 *          without asking the declaration, because it never reaches git-super's own refusal (28661).
 * @level   l1
 * @consumer the queue's per-run tree removal and the warm pool's forget()
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { refusePrivateStoreRemoval } from "../src/worktree.ts"
import { testGitIn } from "../../../tests/support/test-git-in.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
}

const author = ["-c", "user.email=plain-removal@yrd.test", "-c", "user.name=yrd"] as const

/** A product with `vendor/dep` as a submodule, a linked worktree that INITIALIZED it, and the store that follows. */
async function fixture(
  root: string,
  declare: "never" | "head" | "main",
): Promise<Readonly<{ repo: string; linked: string; store: string }>> {
  const repo = join(root, "product")
  const component = join(root, "component")
  mkdirSync(repo, { recursive: true })
  mkdirSync(component, { recursive: true })
  const repoGit = testGitIn(repo, undefined, undefined, { env })
  const componentGit = testGitIn(component, undefined, undefined, { env })
  await componentGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(component, "dep.txt"), "dep\n")
  await componentGit(["add", "dep.txt"])
  await componentGit([...author, "commit", "--quiet", "--message", "dep"])
  await repoGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(repo, "root.txt"), "root\n")
  await repoGit(["add", "root.txt"])
  await repoGit([...author, "commit", "--quiet", "--message", "root"])
  await repoGit(["submodule", "add", "--name", "dep", component, "vendor/dep"])
  await repoGit([...author, "commit", "--quiet", "--message", "add the submodule"])
  const linked = join(root, "linked")
  await repoGit(["worktree", "add", "--quiet", "--detach", linked, "HEAD"])
  const linkedGit = testGitIn(linked, undefined, undefined, { env })
  await linkedGit(["submodule", "update", "--init", "vendor/dep"])
  const store = (await linkedGit(["rev-parse", "--path-format=absolute", "--git-path", "modules/dep"])).trim()
  if (declare !== "never") {
    await repoGit(["config", "-f", ".gitmodules", "submodule.dep.private", "true"])
    await repoGit(["add", ".gitmodules"])
    await repoGit([...author, "commit", "--quiet", "--message", "declare the submodule private"])
  }
  return { repo, linked, store }
}

describe("a plain removal asks the declaration before it deletes a checkout (28661)", () => {
  it("refuses when the worktree's own HEAD declares the submodule private", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-head-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "head")
    expect(existsSync(store)).toBe(true)

    const error = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(store)
    expect(existsSync(store)).toBe(true)
    expect(existsSync(linked)).toBe(true)
  })

  it("refuses when only current main declares it, for a target that predates the declaration", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-main-"))
    roots.push(root)
    const { repo, linked, store } = await fixture(root, "main")
    expect(existsSync(store)).toBe(true)

    const error = await refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(store)
    expect(existsSync(store)).toBe(true)
  })

  it("does not refuse an ordinary submodule that declares no privacy", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-plain-removal-public-"))
    roots.push(root)
    const { repo, linked } = await fixture(root, "never")

    await expect(refusePrivateStoreRemoval(testGitIn(repo, undefined, undefined, { env }), linked, repo)).resolves.toBe(
      undefined,
    )
  })
})
