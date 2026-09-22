/**
 * @failure A remote's IDENTITY is read through `git remote get-url`, which expands
 *          `url.<base>.insteadOf`, so under any transport rewrite `resolveRemote` refuses the
 *          `yrd` remote it declared and a published gitlink records the rewritten transport
 *          instead of the declared submodule URL.
 * @level   l2 (real repositories reached through a real insteadOf rewrite in a test HOME)
 * @consumer yrd submit (the `yrd` remote and the published-gitlink records it writes)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { gitIn } from "../src/git.ts"
import { resolveRemote } from "../src/remote.ts"
import { publishMovedGitlinks } from "../src/submit.ts"

const root = mkdtempSync(join(tmpdir(), "yrd-remote-identity-rewrite-"))
const home = join(root, "home")
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
const author = ["-c", "user.email=remote-identity@yrd.test", "-c", "user.name=yrd"] as const

// Declared URLs on a host that never resolves: a pass proves git went through the rewrite.
const productUrl = "https://yrd-rewrite.invalid/org/product.git"
const dependencyUrl = "https://yrd-rewrite.invalid/org/dep.git"
const product = join(root, "product.git")
const dependency = join(root, "dep.git")

beforeAll(() => {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, ".gitconfig"),
    [
      '[protocol "file"]',
      "\tallow = always",
      `[url "${product}"]`,
      `\tinsteadOf = ${productUrl}`,
      `\tpushInsteadOf = ${productUrl}`,
      `[url "${dependency}"]`,
      `\tinsteadOf = ${dependencyUrl}`,
      `\tpushInsteadOf = ${dependencyUrl}`,
      "",
    ].join("\n"),
  )
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, ".config")
})

afterAll(() => {
  process.env.HOME = saved.HOME
  process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME
  rmSync(root, { force: true, recursive: true })
})

async function commitFile(dir: string, file: string): Promise<string> {
  const git = gitIn(dir)
  writeFileSync(join(dir, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
  return (await git(["rev-parse", "HEAD"])).trim()
}

describe("remote identity behind a transport rewrite", () => {
  it("resolveRemote accepts the yrd remote whose DECLARED url is the declared remote", async () => {
    const work = join(root, "resolve")
    mkdirSync(work, { recursive: true })
    const git = gitIn(work)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git(["remote", "add", "yrd", productUrl])
    // The rewrite is what git would transport to, and that is not a different remote.
    expect((await git(["remote", "get-url", "yrd"])).trim()).toBe(product)

    expect(await resolveRemote(git, productUrl)).toBe("yrd")
    // A yrd remote DECLARED at another address is still refused, loudly.
    await expect(resolveRemote(git, "https://yrd-rewrite.invalid/org/other.git")).rejects.toThrow(
      /the remote yrd is at https:\/\/yrd-rewrite\.invalid\/org\/product\.git, not at the declared https:\/\/yrd-rewrite\.invalid\/org\/other\.git/,
    )
  })

  it("a published gitlink records the submodule's DECLARED url, not the rewritten transport", async () => {
    const seed = join(root, "dep-seed")
    mkdirSync(seed, { recursive: true })
    await gitIn(seed)(["init", "--quiet", "--initial-branch=main"])
    await commitFile(seed, "dep.txt")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, dependency])

    const work = join(root, "publish")
    mkdirSync(work, { recursive: true })
    const git = gitIn(work)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git(["submodule", "add", "--quiet", dependencyUrl, "vendor/dep"])
    await git([...author, "commit", "--quiet", "--message", "add vendor/dep"])
    const from = (await git(["rev-parse", "HEAD"])).trim()

    const pin = await commitFile(join(work, "vendor/dep"), "moved.txt")
    await git(["add", "vendor/dep"])
    await git([...author, "commit", "--quiet", "--message", "move vendor/dep"])
    const to = (await git(["rev-parse", "HEAD"])).trim()

    const published = await publishMovedGitlinks(git, work, from, to)

    expect(published.map(({ path, sha, remote }) => ({ path, sha, remote }))).toEqual([
      { path: "vendor/dep", sha: pin, remote: dependencyUrl },
    ])
  }, 60_000)
})
