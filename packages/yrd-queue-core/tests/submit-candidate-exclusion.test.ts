/**
 * @reach fs-walk <fixture-only: temporary superproject with two components and a named git-super binary>
 * @failure A submit that moves one component still builds, merges, anchors and removes every component of its
 *          candidate (29560: about 1,580 local git processes per real submit). Or the partial candidate is wrong: an
 *          unmoved component is materialized, a component main moved since the branch's base is left out, a
 *          criss-cross history is left partial, or the receipt grows one "as written" row per untouched component.
 *          Or a component whose .gitmodules entry changed is left out, an unmoved component git-super cannot read is
 *          kept with no reason and no warning, or a fresh worktree silently drops an exclusion its commit cannot honour.
 * @level   l2 (real repositories, real submodules, real `git super worktree add`, merge and removal)
 * @consumer `yrd submit` and its dry run from every seat (composeSubmit, the submission receipt)
 * @testonly none
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"
import { populateReferenceStores } from "../src/reference.ts"
import { inspectSubmit, submit, type SubmitRequest, type SubmitVerification } from "../src/submit.ts"
import * as verifying from "../src/verifying.ts"
import { freshWorktree, registeredWorktrees } from "../src/worktree.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=exclusion@yrd.test", "-c", "user.name=yrd"] as const
/** A second hosted name for vendor/b's repository, so a branch can change vendor/b's url and still resolve it. */
const HOSTED_B2 = "https://github.com/beorn/yrd-exclusion-b2-fixture.git"
/** The git-super this repository pins, never the host's PATH one. */
const superEnv = { ...process.env, PATH: `${gitSuperBin}:${process.env.PATH ?? ""}` }

async function repository(path: string, file: string): Promise<string> {
  mkdirSync(path, { recursive: true })
  const git = gitIn(path)
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(path, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
  return (await git(["rev-parse", "HEAD"])).trim()
}

async function commitIn(path: string, file: string, branch?: string): Promise<string> {
  const git = gitIn(path)
  if (branch !== undefined) await git(["checkout", "--quiet", "-b", branch])
  writeFileSync(join(path, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
  const sha = (await git(["rev-parse", "HEAD"])).trim()
  if (branch !== undefined) await git(["checkout", "--quiet", "main"])
  return sha
}

type World = Readonly<{
  root: string
  /** Hosted remote names rewritten to the fixture's local repositories: a frozen push intent needs a hosted identity. */
  env: NodeJS.ProcessEnv
  a: string
  b: string
  product: string
  repo: string
  a0: string
  b0: string
  /** vendor/a's pin a candidate branch moves to; held on vendor/a's `side` branch. */
  a1: string
}>

/** A product with vendor/a and vendor/b, and the queue's own --no-checkout clone with populated stores. */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-submit-exclusion-"))
  roots.push(root)
  const a = join(root, "comp-a")
  const b = join(root, "comp-b")
  const product = join(root, "product")
  const a0 = await repository(a, "a.txt")
  const b0 = await repository(b, "b.txt")
  await repository(product, "product.txt")
  const productGit = gitIn(product)
  await productGit(["submodule", "add", "--quiet", "-b", "main", a, "vendor/a"])
  await productGit(["submodule", "add", "--quiet", "-b", "main", b, "vendor/b"])
  const hostedA = "https://github.com/beorn/yrd-exclusion-a-fixture.git"
  const hostedB = "https://github.com/beorn/yrd-exclusion-b-fixture.git"
  const hostedOrigin = "https://github.com/beorn/yrd-exclusion-fixture.git"
  await productGit(["config", "-f", ".gitmodules", "submodule.vendor/a.url", hostedA])
  await productGit(["config", "-f", ".gitmodules", "submodule.vendor/b.url", hostedB])
  writeFileSync(join(product, ".yrd.yml"), "{}\n")
  await productGit(["add", "--all"])
  await productGit([...author, "commit", "--quiet", "--message", "add vendor/a and vendor/b"])
  const a1 = await commitIn(a, "a-side.txt", "side")
  const env = {
    ...superEnv,
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.${a}.insteadOf`,
    GIT_CONFIG_VALUE_1: hostedA,
    GIT_CONFIG_KEY_2: `url.${b}.insteadOf`,
    GIT_CONFIG_VALUE_2: hostedB,
    GIT_CONFIG_KEY_3: `url.${product}.insteadOf`,
    GIT_CONFIG_VALUE_3: hostedOrigin,
    GIT_CONFIG_KEY_4: `url.${b}.insteadOf`,
    GIT_CONFIG_VALUE_4: HOSTED_B2,
  }
  const repo = join(root, "queue-clone")
  await gitIn(root)(["clone", "--quiet", "--no-checkout", "--origin", "origin", product, repo])
  await gitIn(repo)(["remote", "set-url", "origin", hostedOrigin])
  await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd, undefined, undefined, { env }), repo })
  await gitIn(join(repo, "vendor/a"), undefined, undefined, { env })(["fetch", "--quiet", "origin", "side"])
  return { root, env, a, b, product, repo, a0, b0, a1 }
}

/** A Git in the queue clone (or below it) that resolves the hosted names. */
function queueGit(w: World, path = ""): ReturnType<typeof gitIn> {
  return gitIn(path === "" ? w.repo : join(w.repo, path), undefined, undefined, { env: w.env })
}

/** A product branch from `from` that moves vendor/a to a1, fetched into the queue clone as `branch`. */
async function candidateBranch(w: World, branch: string, from = "main"): Promise<void> {
  const productGit = gitIn(w.product)
  await productGit(["checkout", "--quiet", "-b", branch, from])
  await productGit(["update-index", "--cacheinfo", `160000,${w.a1},vendor/a`])
  await productGit([...author, "commit", "--quiet", "--message", "move vendor/a"])
  await productGit(["checkout", "--quiet", "main"])
  await queueGit(w)(["fetch", "--quiet", "origin", `${branch}:${branch}`, "main:refs/remotes/origin/main"])
}

function requestFor(branch: string): SubmitRequest {
  return { branch, submitter: "@dev/8", target: { remote: "origin", branch: "main" } }
}

type Seen = Readonly<{ excluded: readonly string[] | undefined; aMaterialized: boolean; bEntries: number }>

/** Pass through to the real compose, recording what the candidate holds when git-super is about to merge. */
function watchCandidate(): Readonly<{ seen: Seen[]; restore: () => void }> {
  const seen: Seen[] = []
  const actual = verifying.verifyCandidate
  const spy = vi.spyOn(verifying, "verifyCandidate").mockImplementation(async (options) => {
    const before = options.beforeMerge
    return actual({
      ...options,
      beforeMerge: async (candidate) => {
        seen.push({
          excluded: options.worktree?.excludedSubmodules,
          aMaterialized: existsSync(join(candidate, "vendor/a/a.txt")),
          bEntries: readdirSync(join(candidate, "vendor/b")).length,
        })
        await before?.(candidate)
      },
    })
  })
  return { seen, restore: () => spy.mockRestore() }
}

async function withSuperPath<T>(w: World, work: () => Promise<T>): Promise<T> {
  for (const [key, value] of Object.entries(w.env)) {
    if ((key === "PATH" || key.startsWith("GIT_CONFIG_")) && value !== undefined) vi.stubEnv(key, value)
  }
  try {
    return await work()
  } finally {
    vi.unstubAllEnvs()
  }
}

describe("submit's candidate leaves out the components nobody moved (29560)", () => {
  it("leaves the unmoved component empty, names it once in the receipt, and submits through removal", async () => {
    const w = await world()
    await candidateBranch(w, "task/one")
    const git = queueGit(w)
    const watch = watchCandidate()
    try {
      const actions: readonly ((
        ...args: Parameters<typeof inspectSubmit>
      ) => Promise<{ verifying: SubmitVerification }>)[] = [inspectSubmit, submit]
      for (const action of actions) {
        const receipt = await withSuperPath(w, () => action(git, "origin", requestFor("task/one")))
        if (receipt.verifying.state !== "verified") throw new Error("fixture did not verify")
        expect(receipt.verifying.excludedSubmodules).toEqual(["vendor/b"])
        expect(receipt.verifying.gitlinks.map((row) => row.path)).toEqual(["vendor/a"])
        expect(receipt.verifying.gitlinks[0]).toMatchObject({ path: "vendor/a", landingPin: w.a1 })
      }
    } finally {
      watch.restore()
    }
    // The candidate held vendor/a and an empty, uninitialized vendor/b when git-super merged, both times.
    expect(watch.seen).toEqual([
      { excluded: ["vendor/b"], aMaterialized: true, bEntries: 0 },
      { excluded: ["vendor/b"], aMaterialized: true, bEntries: 0 },
    ])
    // Removal custody ran over the partial candidate and left nothing registered.
    const left = (await registeredWorktrees(git)).filter((row) => row.path.includes("yrd-submit-verifying-"))
    expect(left).toEqual([])
    // The real submit opened its change.
    expect((await git(["ls-remote", "origin", "refs/yrd/main/changes/task/one"])).trim()).not.toBe("")
  }, 180_000)

  it("materializes a component main moved since the branch's base", async () => {
    const w = await world()
    await candidateBranch(w, "task/behind")
    const b1 = await commitIn(w.b, "b-main.txt")
    const productGit = gitIn(w.product)
    await productGit(["update-index", "--cacheinfo", `160000,${b1},vendor/b`])
    await productGit([...author, "commit", "--quiet", "--message", "advance vendor/b on main"])
    await queueGit(w)(["fetch", "--quiet", "origin", "main:refs/remotes/origin/main"])
    await queueGit(w, "vendor/b")(["fetch", "--quiet", "origin", "main"])
    const git = queueGit(w)
    const watch = watchCandidate()
    let receipt: Awaited<ReturnType<typeof inspectSubmit>>
    try {
      receipt = await withSuperPath(w, () => inspectSubmit(git, "origin", requestFor("task/behind")))
    } finally {
      watch.restore()
    }
    if (receipt.verifying.state !== "verified") throw new Error("fixture did not verify")
    expect(receipt.verifying.excludedSubmodules).toBeUndefined()
    expect(watch.seen).toEqual([{ excluded: undefined, aMaterialized: true, bEntries: expect.any(Number) }])
    expect(watch.seen[0]?.bEntries).toBeGreaterThan(0)
  }, 180_000)

  it("leaves nothing out when the branch and the target have two merge bases", async () => {
    const w = await world()
    const productGit = gitIn(w.product)
    // Criss-cross: X on the branch and Y on main, each merged into the other.
    await productGit(["checkout", "--quiet", "-b", "task/criss", "main"])
    await productGit([...author, "commit", "--quiet", "--allow-empty", "--message", "X"])
    await productGit(["checkout", "--quiet", "main"])
    await productGit([...author, "commit", "--quiet", "--allow-empty", "--message", "Y"])
    const y = (await productGit(["rev-parse", "HEAD"])).trim()
    const x = (await productGit(["rev-parse", "task/criss"])).trim()
    await productGit([...author, "merge", "--quiet", "--no-ff", "--no-edit", x])
    await productGit(["checkout", "--quiet", "task/criss"])
    await productGit([...author, "merge", "--quiet", "--no-ff", "--no-edit", y])
    await productGit(["update-index", "--cacheinfo", `160000,${w.a1},vendor/a`])
    await productGit([...author, "commit", "--quiet", "--message", "move vendor/a"])
    await productGit(["checkout", "--quiet", "main"])
    const git = queueGit(w)
    await queueGit(w)(["fetch", "--quiet", "origin", "task/criss:task/criss", "main:refs/remotes/origin/main"])
    expect((await git(["merge-base", "--all", "task/criss", "origin/main"])).trim().split("\n")).toHaveLength(2)
    const watch = watchCandidate()
    let receipt: Awaited<ReturnType<typeof inspectSubmit>>
    try {
      receipt = await withSuperPath(w, () => inspectSubmit(git, "origin", requestFor("task/criss")))
    } finally {
      watch.restore()
    }
    if (receipt.verifying.state !== "verified") throw new Error("fixture did not verify")
    expect(receipt.verifying.excludedSubmodules).toBeUndefined()
    expect(watch.seen.map((row) => row.excluded)).toEqual([undefined])
    expect(watch.seen[0]?.bEntries).toBeGreaterThan(0)
  }, 180_000)

  it("materializes a component whose .gitmodules entry the branch changed, though its gitlink stands still", async () => {
    const w = await world()
    const productGit = gitIn(w.product)
    await productGit(["checkout", "--quiet", "-b", "task/config", "main"])
    await productGit(["update-index", "--cacheinfo", `160000,${w.a1},vendor/a`])
    await productGit(["config", "-f", ".gitmodules", "submodule.vendor/b.url", HOSTED_B2])
    await productGit(["add", ".gitmodules"])
    await productGit([
      ...author,
      "commit",
      "--quiet",
      "--message",
      "move vendor/a; vendor/b's url changes, its pin does not",
    ])
    await productGit(["checkout", "--quiet", "main"])
    const git = queueGit(w)
    await git(["fetch", "--quiet", "origin", "task/config:task/config", "main:refs/remotes/origin/main"])
    expect((await git(["rev-parse", "task/config:vendor/b"])).trim()).toBe(w.b0)
    const watch = watchCandidate()
    let receipt: Awaited<ReturnType<typeof inspectSubmit>>
    try {
      receipt = await withSuperPath(w, () => inspectSubmit(git, "origin", requestFor("task/config")))
    } finally {
      watch.restore()
    }
    if (receipt.verifying.state !== "verified") throw new Error("fixture did not verify")
    expect(receipt.verifying.excludedSubmodules).toBeUndefined()
    expect(receipt.verifying.keptUnmoved).toBeUndefined()
    expect(watch.seen.map((row) => row.excluded)).toEqual([undefined])
    expect(watch.seen[0]?.bEntries).toBeGreaterThan(0)
  }, 180_000)

  it("materializes an unmoved component git-super cannot read, names its reason and warns", async () => {
    const w = await world()
    await candidateBranch(w, "task/unreadable")
    const git = queueGit(w)
    // vendor/b's local main is gone from its store, so the local-only query cannot answer for it.
    await queueGit(w, "vendor/b")(["update-ref", "-d", "refs/remotes/origin/main"])
    const watch = watchCandidate()
    const warnings: string[] = []
    const warned = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line))
    })
    let receipt: Awaited<ReturnType<typeof inspectSubmit>>
    try {
      receipt = await withSuperPath(w, () => inspectSubmit(git, "origin", requestFor("task/unreadable")))
    } finally {
      watch.restore()
      warned.mockRestore()
    }
    if (receipt.verifying.state !== "verified") throw new Error("fixture did not verify")
    expect(receipt.verifying.excludedSubmodules).toBeUndefined()
    expect(receipt.verifying.keptUnmoved).toEqual([
      { path: "vendor/b", reason: expect.stringContaining("refs/remotes/origin/main is unreadable") },
    ])
    expect(watch.seen[0]?.bEntries).toBeGreaterThan(0)
    expect(warnings.filter((line) => line.includes("keeps unmoved vendor/b"))).toEqual([
      expect.stringContaining("git-super could not read its local main"),
    ])
  }, 180_000)

  it("a fresh worktree refuses to leave out a path its commit does not declare, by name", async () => {
    const w = await world()
    const git = queueGit(w)
    const head = (await git(["rev-parse", "refs/remotes/origin/main"])).trim()
    const bare = (await git(["rev-list", "--max-parents=0", "refs/remotes/origin/main"])).trim()
    expect((await git(["ls-tree", bare, "--", ".gitmodules"])).trim()).toBe("")
    await expect(
      withSuperPath(w, () =>
        freshWorktree(git, w.repo, head, join(w.root, "undeclared"), { excludedSubmodules: ["vendor/none"] }),
      ),
    ).rejects.toThrow(/cannot leave out vendor\/none, because that commit's \.gitmodules declares no submodule/u)
    await expect(
      withSuperPath(w, () =>
        freshWorktree(git, w.repo, bare, join(w.root, "no-modules"), { excludedSubmodules: ["vendor/a"] }),
      ),
    ).rejects.toThrow(/cannot leave out vendor\/a, because that commit records no \.gitmodules/u)
    expect(existsSync(join(w.root, "undeclared"))).toBe(false)
    expect(existsSync(join(w.root, "no-modules"))).toBe(false)
  }, 180_000)

  it("throws by name when the compose reports an excluded path as anything but as-written at the target's pin", async () => {
    const w = await world()
    await candidateBranch(w, "task/forged")
    const git = queueGit(w)
    const actual = verifying.verifyCandidate
    const spy = vi.spyOn(verifying, "verifyCandidate").mockImplementation(async (options) => {
      const result = await actual(options)
      if (result.state !== "verified") return result
      return {
        ...result,
        verifying: {
          ...result.verifying,
          gitlinks: result.verifying.gitlinks.map((row) =>
            row.path === "vendor/b" ? { ...row, state: "kept-ahead" as const } : row,
          ),
        },
      }
    })
    try {
      await expect(withSuperPath(w, () => inspectSubmit(git, "origin", requestFor("task/forged")))).rejects.toThrow(
        new RegExp(
          `vendor/b: left out of the candidate as unmoved at ${w.b0}, but the compose reported kept-ahead`,
          "u",
        ),
      )
    } finally {
      spy.mockRestore()
    }
  }, 180_000)
})
