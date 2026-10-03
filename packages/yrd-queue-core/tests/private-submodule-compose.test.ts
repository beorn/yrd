/**
 * @reach fs-walk <fixture-only: temporary repos and the pinned git-super binary>
 * @failure The queue's own trees (submit's verifying compose, every queue compose, the reference population) read or
 *          populate a submodule the commit declares `private = true`, which no Yrd environment holds (27147, 27157).
 * @level   l2 (real repositories, real `git super worktree add` and `git super merge`)
 * @consumer `yrd submit` (verifying) and every queue run
 * @testonly none
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { LogWrite } from "../src/log.ts"
import { verifyCandidate } from "../src/verifying.ts"
import { freshWorktree } from "../src/worktree.ts"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=private@yrd.test", "-c", "user.name=yrd"] as const
const superEnv = {
  ...process.env,
  PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
}
/** A pin that exists in no repository anywhere: anything that tries to read it fails. */
const SECRET_PIN = "5".repeat(40)
const MOVED_PIN = "6".repeat(40)
const PRODUCT_REMOTE = "https://github.com/beorn/yrd-private-compose-fixture.git"
const DEP_REMOTE = "https://github.com/beorn/yrd-private-compose-dep-fixture.git"

/** Stages only what it names: `add --all` would stage the private gitlink's deletion, since nothing is on disk there. */
async function commitFiles(git: ReturnType<typeof gitIn>, files: readonly string[], message: string): Promise<string> {
  await git(["add", "--", ...files])
  await git([...author, "commit", "--quiet", "--message", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}

/**
 * A product with one public submodule and one declared `private = true` whose url names a path that does not exist
 * and whose pin is in no repository. The queue clone is `--no-checkout`, as the queue's own is.
 */
async function fixture(): Promise<
  Readonly<{
    root: string
    repo: string
    env: NodeJS.ProcessEnv
    product: ReturnType<typeof gitIn>
    git: ReturnType<typeof gitIn>
  }>
> {
  const root = mkdtempSync(join(tmpdir(), "yrd-private-compose-"))
  roots.push(root)
  const productPath = join(root, "product")
  const dep = join(root, "dep")
  // git-super's push intent needs a hosted identity for every included remote. The private child keeps a local
  // path that does not exist, so any read of it fails.
  const env = {
    ...superEnv,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_1: `url.${productPath}.insteadOf`,
    GIT_CONFIG_VALUE_1: PRODUCT_REMOTE,
    GIT_CONFIG_KEY_2: `url.${dep}.insteadOf`,
    GIT_CONFIG_VALUE_2: DEP_REMOTE,
  }
  mkdirSync(dep)
  const depGit = gitIn(dep)
  await depGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(dep, "dep.txt"), "dep\n")
  await commitFiles(depGit, ["dep.txt"], "dep")
  mkdirSync(productPath)
  const product = gitIn(productPath, undefined, undefined, { env })
  await product(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(productPath, "product.txt"), "product\n")
  await commitFiles(product, ["product.txt"], "product")
  await product(["submodule", "add", "--quiet", DEP_REMOTE, "vendor/dep"])
  writeFileSync(
    join(productPath, ".gitmodules"),
    `[submodule "vendor/dep"]\n\tpath = vendor/dep\n\turl = ${DEP_REMOTE}\n` +
      `[submodule "vendor/secret"]\n\tpath = vendor/secret\n\turl = ${join(root, "absent-secret")}\n\tprivate = true\n`,
  )
  await product(["update-index", "--add", "--cacheinfo", `160000,${SECRET_PIN},vendor/secret`])
  await commitFiles(product, [".gitmodules"], "declare a public and a private child")
  const repo = join(root, "queue-clone")
  await gitIn(root, undefined, undefined, { env })([
    "clone",
    "--quiet",
    "--no-checkout",
    "--origin",
    "origin",
    PRODUCT_REMOTE,
    repo,
  ])
  return { root, repo, env, product, git: gitIn(repo, undefined, undefined, { env }) }
}

/** A candidate branch and an independently advanced main, so the merge is a real two-parent compose. */
async function diverge(
  product: ReturnType<typeof gitIn>,
  git: ReturnType<typeof gitIn>,
  candidate: (product: ReturnType<typeof gitIn>) => Promise<void>,
): Promise<Readonly<{ head: string; targetHead: string }>> {
  const productPath = (await product(["rev-parse", "--show-toplevel"])).trim()
  await product(["checkout", "--quiet", "-b", "candidate"])
  await candidate(product)
  await product(["checkout", "--quiet", "main"])
  writeFileSync(join(productPath, "main-only.txt"), "main\n")
  await commitFiles(product, ["main-only.txt"], "advance main")
  await git(["fetch", "--quiet", "origin", "main", "candidate"])
  return {
    head: (await git(["rev-parse", "origin/candidate"])).trim(),
    targetHead: (await git(["rev-parse", "origin/main"])).trim(),
  }
}

describe("the queue's trees leave a declared-private submodule out (27147 carrier 2)", () => {
  it("freshWorktree reads the declaration at its commit, never populates the private store, and returns the list", async () => {
    const { root, repo, env, git } = await fixture()
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const journal: LogWrite[] = []

    const worktree = await freshWorktree(git, repo, commit, join(root, "tree"), {
      env,
      plumbing: { journal: (record) => void journal.push(record) },
      populateReference: true,
    })

    expect(worktree.excludedSubmodules).toEqual(["vendor/secret"])
    expect(existsSync(join(worktree.path, "vendor/dep/dep.txt"))).toBe(true)
    expect(readdirSync(join(worktree.path, "vendor/secret"))).toEqual([])
    expect(existsSync(join(repo, "vendor/secret"))).toBe(false)
    expect(journal.filter((record) => JSON.stringify(record).includes("vendor/secret"))).toEqual([])
    await worktree.remove()
  }, 120_000)

  it("the queue's verifying compose passes the same list to merge and to the population after it", async () => {
    const { root, repo, env, product, git } = await fixture()
    const { head, targetHead } = await diverge(product, git, async (candidate) => {
      const top = (await candidate(["rev-parse", "--show-toplevel"])).trim()
      writeFileSync(join(top, "candidate-only.txt"), "candidate\n")
      await commitFiles(candidate, ["candidate-only.txt"], "candidate change")
    })
    const journal: LogWrite[] = []

    const verified = await verifyCandidate({
      env,
      git,
      head,
      message: "compose beside a private child",
      noFetch: true,
      path: join(root, "verifying"),
      repo,
      targetHead,
      worktree: { env, plumbing: { journal: (record) => void journal.push(record) }, populateReference: true },
    })

    if (verified.state !== "verified") throw new Error(JSON.stringify(verified.verifying.detail))
    // Reported as written and never compared: its pin is the one the target already holds.
    expect(verified.verifying.gitlinks.find(({ path }) => path === "vendor/secret")).toEqual({
      from: SECRET_PIN,
      path: "vendor/secret",
      state: "as-written",
      to: SECRET_PIN,
    })
    expect((await git(["rev-parse", `${verified.verifying.candidate}:vendor/secret`])).trim()).toBe(SECRET_PIN)
    expect(existsSync(join(repo, "vendor/secret"))).toBe(false)
    expect(journal.filter((record) => JSON.stringify(record).includes("vendor/secret"))).toEqual([])
  }, 120_000)

  it("submit's verifying compose from a seat checkout reads no private store and lists none as an unbounded local main (27157)", async () => {
    const { root, env, product, git: queueGit } = await fixture()
    const { head, targetHead } = await diverge(product, queueGit, async (candidate) => {
      const top = (await candidate(["rev-parse", "--show-toplevel"])).trim()
      writeFileSync(join(top, "candidate-only.txt"), "candidate\n")
      await commitFiles(candidate, ["candidate-only.txt"], "candidate change")
    })
    // The seat's own checkout: the public child initialized, the private one never.
    const seat = join(root, "seat")
    await gitIn(root, undefined, undefined, { env })(["clone", "--quiet", PRODUCT_REMOTE, seat])
    const seatGit = gitIn(seat, undefined, undefined, { env })
    await seatGit(["submodule", "update", "--quiet", "--init", "--", "vendor/dep"])
    await seatGit(["fetch", "--quiet", "origin", "candidate"])

    const verified = await verifyCandidate({
      env,
      git: seatGit,
      head,
      message: "verify from a seat",
      noFetch: true,
      path: join(root, "seat-verifying"),
      repo: seat,
      targetHead,
      unboundedLocalMain: true,
    })

    if (verified.state !== "verified") throw new Error(JSON.stringify(verified.verifying.detail))
    expect((verified.verifying.unboundedLocalMains ?? []).map(({ path }) => path)).not.toContain("vendor/secret")
    expect(readdirSync(join(seat, "vendor/secret"))).toEqual([])
  }, 120_000)

  it("a candidate that moves the private gitlink is refused by merge's own admission, by name", async () => {
    const { root, repo, env, product, git } = await fixture()
    const { head, targetHead } = await diverge(product, git, async (candidate) => {
      await candidate(["update-index", "--cacheinfo", `160000,${MOVED_PIN},vendor/secret`])
      await candidate([...author, "commit", "--quiet", "--message", "move the private pin"])
    })

    const verified = await verifyCandidate({
      env,
      git,
      head,
      message: "compose a moved private pin",
      noFetch: true,
      path: join(root, "refused"),
      repo,
      targetHead,
      worktree: { env, populateReference: true },
    })

    expect(verified.state).toBe("failed")
    if (verified.state !== "failed") return
    expect(verified.verifying.detail).toMatchObject({ code: "excluded-submodule-unproven" })
    expect(verified.verifying.detail.message).toContain("vendor/secret")
    await verified.failedWorktree.remove()
    expect(existsSync(join(repo, "vendor/secret"))).toBe(false)
  }, 120_000)
})
