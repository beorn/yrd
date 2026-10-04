/**
 * #27363 — the compose revert guard sees content a candidate put back one component store down.
 *
 * The measured incident was a fast-forward km pin move whose INTERIOR content restored a target
 * advance (the write-log cap 480 -> 416 MiB). The root diff shows one mode-160000 entry, so the
 * guard descends into the owning component store; a reused target pin swallows the incoming
 * correction rather than moving the pin at all.
 *
 * @failure Yrd composes a stale-base branch that silently reverts later target changes inside a
 *          component, and the fleet-wide km write deferral repeats unseen.
 * @level l1 (real repositories; local git only, no compose)
 * @consumer `yrd submit` and every queue compose (verifying.ts)
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { detectReverted, revertedPathsFinding, revertGuardAction, type RevertGuardReport } from "../src/revert-guard.ts"
import { verifyCandidate } from "../src/verifying.ts"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
}
const author = ["-c", "user.email=revert@yrd.test", "-c", "user.name=yrd"] as const

async function commit(
  repo: string,
  files: Readonly<Record<string, string>>,
  message: string,
  environment: NodeJS.ProcessEnv = env,
): Promise<string> {
  const git = gitIn(repo, undefined, undefined, { env: environment })
  for (const [name, body] of Object.entries(files)) {
    const full = join(repo, name)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body)
  }
  await git(["add", "-A"])
  await git([...author, "commit", "--quiet", "--allow-empty", "--message", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}

/** Record one submodule at `path` pinned to `sha`, with the local `url` its checkout needs. */
async function pin(
  repo: string,
  path: string,
  url: string,
  sha: string,
  message: string,
  environment: NodeJS.ProcessEnv = env,
): Promise<string> {
  const git = gitIn(repo, undefined, undefined, { env: environment })
  writeFileSync(join(repo, ".gitmodules"), `[submodule "${path}"]\n\tpath = ${path}\n\turl = ${url}\n`)
  await git(["add", "--", ".gitmodules"])
  await git(["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`])
  await git([...author, "commit", "--quiet", "--allow-empty", "--message", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}

type World = Readonly<{
  root: string
  product: string
  dep: string
  target: string
  head: string
  candidateStale: string
  candidateMetadata: string
  candidateNormal: string
  checkoutAt: (commit: string) => Promise<string>
}>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-guard-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "a.txt": "base\n" }, "base")
  const c1 = await commit(dep, { "a.txt": "target\n" }, "target advance")
  const c2 = await commit(dep, { "a.txt": "base\n" }, "stale restore")
  const c3 = await commit(dep, { "a.txt": "target\n", "b.txt": "extra\n" }, "incoming advance")
  const c4 = await commit(dep, {}, "metadata-only rebuild")
  const product = join(root, "product")
  mkdirSync(product)
  const productGit = gitIn(product, undefined, undefined, { env })
  await productGit(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, c1, "target pins the advance")
  const head = await pin(product, "vendor/dep", dep, c3, "head asks for the incoming advance")
  const candidateStale = await pin(product, "vendor/dep", dep, c2, "candidate restores the stale value")
  const candidateMetadata = await pin(product, "vendor/dep", dep, c4, "candidate re-pins the same tree")
  const candidateNormal = await pin(product, "vendor/dep", dep, c3, "candidate merges the incoming advance")
  const checkoutAt = async (sha: string): Promise<string> => {
    const dir = join(root, `checkout-${sha.slice(0, 12)}`)
    await productGit(["worktree", "add", "--quiet", "--detach", dir, sha])
    await gitIn(dir, undefined, undefined, { env })(["submodule", "update", "--init", "--recursive", "--quiet"])
    return dir
  }
  return { candidateMetadata, candidateNormal, candidateStale, checkoutAt, dep, head, product, root, target }
}

async function detect(
  w: Readonly<{ checkoutAt: (commit: string) => Promise<string>; target: string }>,
  candidate: string,
  head: string,
  targetHead: string = w.target,
): Promise<Awaited<ReturnType<typeof detectReverted>>> {
  const root = await w.checkoutAt(candidate)
  return detectReverted({
    candidate,
    git: gitIn(root, undefined, undefined, { env }),
    head,
    root,
    targetHead,
  })
}

describe("revert guard (27363)", () => {
  it("S2: a fast-forward pin move that restores a target advance is a reverted path", async () => {
    const w = await world()
    const report = await detect(w, w.candidateStale, w.head)
    expect(report.coverage).toBe("complete")
    expect(report.swallowed).toEqual([])
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
    expect(report.count).toBe(report.paths.length)
    expect(report.base.state).toBe("single")
  })

  it("S3: a candidate that reuses the target pin swallows the incoming correction", async () => {
    const w = await world()
    const report = await detect(w, w.target, w.head)
    expect(report.paths).toEqual([])
    expect(report.swallowed.map((row) => row.path)).toContain("vendor/dep")
  })

  it("negative: a metadata-only re-pin with equal trees is not a hit", async () => {
    const w = await world()
    const report = await detect(w, w.candidateMetadata, w.candidateMetadata)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("negative: a normal merge of a genuinely advancing pin is clean", async () => {
    const w = await world()
    const report = await detect(w, w.candidateNormal, w.candidateNormal)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("negative: an incoming pin behind the target is kept-ahead, never swallowed", async () => {
    const w = await world()
    const report = await detect(w, w.head, w.target, w.head)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("bounds: a path cap names the gap and never reports clean", async () => {
    const w = await world()
    const root = await w.checkoutAt(w.candidateStale)
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 0, window: 50 },
      candidate: w.candidateStale,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.head,
      root,
      targetHead: w.target,
    })
    expect(report.coverage).toBe("incomplete")
    expect(report.gaps.some((gap) => gap.reason.includes("path cap"))).toBe(true)
  })

  it("nested: a gitlink inside a component recurses to the inner path", async () => {
    const w = await nestedWorld()
    const report = await detect(w, w.candidateStale, w.head)
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/vendor/inner/x.txt")
  })

  it("the durable finding is silent only for a complete, hit-free report", () => {
    expect(revertedPathsFinding(undefined)).toBeUndefined()
    expect(
      revertedPathsFinding({
        base: { base: "a".repeat(40), state: "single" },
        count: 0,
        coverage: "complete",
        gaps: [],
        paths: [],
        swallowed: [],
      }),
    ).toBeUndefined()
    const hit = revertedPathsFinding({
      base: { base: "a".repeat(40), state: "single" },
      count: 1,
      coverage: "complete",
      gaps: [],
      paths: [{ base: "b", candidate: "c", mode: "100644", path: "vendor/dep/a.txt", target: "t" }],
      swallowed: [],
    })
    expect(hit?.reason).toContain("vendor/dep/a.txt")
    expect(hit?.reason).toContain('"count":1')
    const gap = revertedPathsFinding({
      base: { count: 2, state: "ambiguous" },
      count: 0,
      coverage: "incomplete",
      gaps: [],
      paths: [],
      swallowed: [],
    })
    expect(gap?.coverage).toBe("incomplete")
    expect(gap?.reason).toContain("ambiguous")
  })

  it("policy: a hit warns by default and sticks only under refuse, and a gap never goes clean", () => {
    const clean: RevertGuardReport = {
      base: { base: "a".repeat(40), state: "single" },
      count: 0,
      coverage: "complete",
      gaps: [],
      paths: [],
      swallowed: [],
    }
    expect(revertGuardAction(clean, "observe")).toBe("clean")
    expect(revertGuardAction(clean, "refuse")).toBe("clean")
    const hit: RevertGuardReport = {
      ...clean,
      count: 1,
      paths: [{ base: "b", candidate: "c", mode: "100644", path: "vendor/dep/a.txt", target: "t" }],
    }
    expect(revertGuardAction(hit, "observe")).toBe("warn")
    expect(revertGuardAction(hit, "refuse")).toBe("stick")
    const gap: RevertGuardReport = {
      base: { count: 2, state: "ambiguous" },
      count: 0,
      coverage: "incomplete",
      gaps: [],
      paths: [],
      swallowed: [],
    }
    expect(revertGuardAction(gap, "observe")).toBe("warn")
    expect(revertGuardAction(gap, "refuse")).toBe("stick")
    expect(revertGuardAction(undefined, "refuse")).toBe("clean")
  })

  it("the compose wires the finding through: a stale-base candidate reports the reverted interior path", async () => {
    const w = await composeWorld()
    const verified = await verifyCandidate({
      env: w.env,
      git: w.git,
      head: w.head,
      message: "compose a stale-base candidate",
      noFetch: true,
      path: join(w.root, "verifying"),
      repo: w.repo,
      targetHead: w.targetHead,
      worktree: { env: w.env },
    })
    if (verified.state !== "verified") throw new Error(JSON.stringify(verified.verifying.detail))
    expect(verified.verifying.reverted?.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
    expect(verified.verifying.reverted?.coverage).toBe("complete")
  }, 120_000)
})

type ComposeWorld = Readonly<{
  root: string
  repo: string
  env: NodeJS.ProcessEnv
  git: ReturnType<typeof gitIn>
  targetHead: string
  head: string
}>

/** A queue clone, a real git-super compose, and a candidate whose component pin is a stale restore. */
async function composeWorld(): Promise<ComposeWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-guard-compose-"))
  roots.push(root)
  const depPath = join(root, "dep")
  mkdirSync(depPath)
  const productRemote = "https://github.com/beorn/yrd-27363-product-fixture.git"
  const depRemote = "https://github.com/beorn/yrd-27363-dep-fixture.git"
  const remotePath = join(root, "product.git")
  const environment = {
    ...process.env,
    PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.${remotePath}.insteadOf`,
    GIT_CONFIG_VALUE_1: productRemote,
    GIT_CONFIG_KEY_2: `url.${depPath}.insteadOf`,
    GIT_CONFIG_VALUE_2: depRemote,
  }
  await gitIn(root, undefined, undefined, { env: environment })([
    "init",
    "--quiet",
    "--bare",
    "--initial-branch=main",
    remotePath,
  ])
  await gitIn(depPath, undefined, undefined, { env: environment })(["init", "--quiet", "--initial-branch=main"])
  await commit(depPath, { "a.txt": "base\n" }, "base", environment)
  const c1 = await commit(depPath, { "a.txt": "target\n" }, "target advance", environment)
  const c2 = await commit(depPath, { "a.txt": "base\n" }, "stale restore", environment)
  const productPath = join(root, "product")
  mkdirSync(productPath)
  const productGit = gitIn(productPath, undefined, undefined, { env: environment })
  await productGit(["init", "--quiet", "--initial-branch=main"])
  await commit(productPath, { "readme.txt": "product\n" }, "product base", environment)
  await pin(productPath, "vendor/dep", depRemote, c1, "base pins the advance", environment)
  await productGit(["remote", "add", "origin", productRemote])
  await productGit(["push", "--quiet", "origin", "main"])
  await productGit(["checkout", "--quiet", "-b", "candidate"])
  await pin(productPath, "vendor/dep", depRemote, c2, "candidate restores the stale value", environment)
  const head = (await productGit(["rev-parse", "HEAD"])).trim()
  await productGit(["checkout", "--quiet", "main"])
  await commit(productPath, { "main-only.txt": "main\n" }, "advance main", environment)
  const targetHead = (await productGit(["rev-parse", "HEAD"])).trim()
  await productGit(["push", "--quiet", "origin", "main", "candidate"])
  const repo = join(root, "queue-clone")
  await gitIn(root, undefined, undefined, { env: environment })([
    "clone",
    "--quiet",
    "--no-checkout",
    productRemote,
    repo,
  ])
  const git = gitIn(repo, undefined, undefined, { env: environment })
  await git(["fetch", "--quiet", "origin", "main", "candidate"])
  await git(["checkout", "--quiet", "main"])
  await git(["submodule", "update", "--init", "--quiet", "--", "vendor/dep"])
  return { env: environment, git, head, repo, root, targetHead }
}

type NestedWorld = Readonly<{
  target: string
  head: string
  candidateStale: string
  checkoutAt: (commit: string) => Promise<string>
}>

async function nestedWorld(): Promise<NestedWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-guard-nested-"))
  roots.push(root)
  const inner = join(root, "inner")
  mkdirSync(inner)
  await gitIn(inner, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(inner, { "x.txt": "base\n" }, "inner base")
  const i1 = await commit(inner, { "x.txt": "target\n" }, "inner target advance")
  const i2 = await commit(inner, { "x.txt": "base\n" }, "inner stale restore")
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "dep.txt": "dep\n" }, "dep base")
  const d1 = await pin(dep, "vendor/inner", inner, i1, "dep pins the inner advance")
  const d2 = await pin(dep, "vendor/inner", inner, i2, "dep restores the inner stale value")
  const product = join(root, "product")
  mkdirSync(product)
  const productGit = gitIn(product, undefined, undefined, { env })
  await productGit(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, d1, "target pins the dep advance")
  const head = await pin(product, "vendor/dep", dep, d1, "head keeps the dep advance")
  const candidateStale = await pin(product, "vendor/dep", dep, d2, "candidate restores the dep stale value")
  const checkoutAt = async (sha: string): Promise<string> => {
    const dir = join(root, `checkout-${sha.slice(0, 12)}`)
    await productGit(["worktree", "add", "--quiet", "--detach", dir, sha])
    await gitIn(dir, undefined, undefined, { env })(["submodule", "update", "--init", "--recursive", "--quiet"])
    return dir
  }
  return { candidateStale, checkoutAt, head, target }
}
