/**
 * @reach fs-walk <fixture-only: bare component stores under a temporary root>
 * @failure yrd drop --local aimed at a cold retained module store resolves the
 * shared root instead, reports the branch absent there, and never retires it.
 * @level l2 (`runYrdProcess` against a real bare component store and its origin)
 * @consumer yrd drop cleanup of retained/cold component stores.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

type World = Readonly<{
  root: string
  sharedRoot: string
  store: string
  origin: string
  branch: string
  tip: string
  legacyArchiveRef: string
}>

/** A cold retained component store: a bare repository with its own origin, and a branch held only there. */
async function retainedWorld(options: Readonly<{ withOrigin: boolean }>): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-drop-retained-"))
  roots.push(root)
  const origin = join(root, "component-origin.git")
  const seed = join(root, "seed")
  const branch = "task/retained-only"
  const seedGit = gitIn(root)
  await seedGit(["init", "--quiet", "--bare", "--initial-branch=main", origin])
  await seedGit(["clone", "--quiet", origin, seed])
  const git = gitIn(seed)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(seed, "README.md"), "component\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "component main"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["checkout", "--quiet", "-b", branch])
  writeFileSync(join(seed, "held.txt"), "held only in the cold store\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "held branch"])
  const tip = (await git(["rev-parse", "HEAD"])).trim()
  await git(["push", "--quiet", "origin", branch])

  const store = join(root, "retained-modules", "demo", "modules", "ag")
  mkdirSync(dirname(store), { recursive: true })
  const storeSeed = gitIn(root)
  await storeSeed(["init", "--quiet", "--bare", store])
  const storeGit = gitIn(store)
  if (options.withOrigin) await storeGit(["remote", "add", "origin", origin])
  await storeGit(["fetch", "--quiet", options.withOrigin ? origin : seed, `refs/heads/*:refs/heads/*`])
  // An unrelated legacy archive at the same tip used to abort readArchiveRows, so findArchiveRefFor
  // refused this drop before it could retire the branch (30263).
  const legacyArchiveRef = "refs/archive/2026-10-01/@dev/13/task/unrelated-legacy"
  await storeGit(["update-ref", legacyArchiveRef, tip])

  const sharedRoot = join(root, "shared-root")
  await storeSeed(["init", "--quiet", "--bare", "--initial-branch=main", sharedRoot])
  return { root, sharedRoot, store, origin, branch, tip, legacyArchiveRef }
}

it("retires a branch held in a cold retained module store and leaves the shared root untouched", async () => {
  const world = await retainedWorld({ withOrigin: true })
  const sharedRefsBefore = (await gitIn(world.sharedRoot)(["for-each-ref"])).trim()
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(0)
  const report = JSON.parse(observed.stdout()) as {
    removed: { branch: string; head: string; archiveRef?: string }[]
  }
  expect(report.removed).toEqual([expect.objectContaining({ branch: world.branch, head: world.tip })])
  // The branch left the store it was aimed at.
  await expect(gitIn(world.store)(["rev-parse", "--verify", `refs/heads/${world.branch}`])).rejects.toThrow()
  // The shared root store never held or lost anything.
  expect((await gitIn(world.sharedRoot)(["for-each-ref"])).trim()).toBe(sharedRefsBefore)
  await expect(gitIn(world.sharedRoot)(["rev-parse", "--verify", `refs/heads/${world.branch}`])).rejects.toThrow()
  // It was archived at that store's origin before removal.
  const archived = report.removed[0]?.archiveRef
  expect(archived).toBeDefined()
  const archivedTip = (await gitIn(world.origin)(["rev-parse", archived!])).trim()
  expect(archivedTip).toBe(world.tip)
  // The unrelated legacy custody is evidence, so the drop neither read it as branch custody nor removed it.
  expect((await gitIn(world.store)(["rev-parse", world.legacyArchiveRef])).trim()).toBe(world.tip)
})

it("refuses loudly and names the store when the cold store has no origin", async () => {
  const world = await retainedWorld({ withOrigin: false })
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code).toBe(2)
  expect(observed.stderr()).toContain(world.store)
  expect(observed.stderr()).not.toContain(world.sharedRoot)
  expect((await gitIn(world.store)(["rev-parse", `refs/heads/${world.branch}`])).trim()).toBe(world.tip)
})

/**
 * The same cold store moved inside a Git root: a `.git` walk-up from the store
 * now finds the enclosing repository first, which is how a retained module
 * store under /hh resolved to STATE instead of itself (30094 counterexample).
 */
async function nestedRetainedWorld(): Promise<World & { enclosing: string }> {
  const world = await retainedWorld({ withOrigin: true })
  const enclosing = join(world.root, "enclosing-root")
  mkdirSync(enclosing, { recursive: true })
  const enclosingGit = gitIn(enclosing)
  await enclosingGit(["init", "--quiet", "--initial-branch=main"])
  await enclosingGit(["config", "user.name", "yrd test"])
  await enclosingGit(["config", "user.email", "yrd@test.invalid"])
  writeFileSync(join(enclosing, "README.md"), "enclosing root\n")
  await enclosingGit(["add", "."])
  await enclosingGit(["commit", "--quiet", "-m", "enclosing root"])
  const store = join(enclosing, "var", "retained-modules", "demo", "modules", "ag")
  mkdirSync(dirname(store), { recursive: true })
  renameSync(world.store, store)
  return { ...world, store, enclosing }
}

it("retires a branch in a retained store nested inside a Git root and leaves that root untouched", async () => {
  const world = await nestedRetainedWorld()
  const enclosingRefsBefore = (await gitIn(world.enclosing)(["for-each-ref"])).trim()
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(0)
  await expect(gitIn(world.store)(["rev-parse", "--verify", `refs/heads/${world.branch}`])).rejects.toThrow()
  expect((await gitIn(world.enclosing)(["for-each-ref"])).trim()).toBe(enclosingRefsBefore)
})

it("exits 1 when a nested retained store keeps the branch", async () => {
  const world = await nestedRetainedWorld()
  const mainTip = (await gitIn(world.origin)(["rev-parse", "refs/heads/main"])).trim()
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", mainTip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(1)
  expect((await gitIn(world.store)(["rev-parse", `refs/heads/${world.branch}`])).trim()).toBe(world.tip)
})

it("names the store, never the enclosing root, when --release-checkout aims at a retained store", async () => {
  const world = await nestedRetainedWorld()
  const observed = capture(world.store)
  const code = await runYrdProcess(
    [
      "bun",
      "yrd",
      "drop",
      world.branch,
      "--local",
      "--tip",
      world.tip,
      "--submitter",
      "fixture",
      "--issue",
      "@yrd/30094",
      "--reason",
      "fixture",
      "--release-checkout",
    ],
    observed.io,
  )
  expect(code).toBe(2)
  expect(observed.stderr()).toContain(world.store)
  expect(observed.stderr()).not.toContain(`cd '${world.enclosing}'`)
})

it("detaches a retained store's attached HEAD in place at the verified tip and retires the branch", async () => {
  const world = await nestedRetainedWorld()
  const storeGit = gitIn(world.store)
  await storeGit(["symbolic-ref", "HEAD", `refs/heads/${world.branch}`])
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(0)
  const report = JSON.parse(observed.stdout()) as {
    removed: { headMove?: { before: { symbolic: string; tip: string }; after: { detached: string } } }[]
  }
  expect(report.removed[0]?.headMove).toEqual({
    before: { symbolic: `refs/heads/${world.branch}`, tip: world.tip },
    after: { detached: world.tip },
  })
  await expect(storeGit(["symbolic-ref", "-q", "HEAD"])).rejects.toThrow()
  expect((await storeGit(["rev-parse", "HEAD"])).trim()).toBe(world.tip)
  await expect(storeGit(["rev-parse", "--verify", `refs/heads/${world.branch}`])).rejects.toThrow()
})

it("an archive that reads back at a different commit leaves HEAD attached and the branch in place", async () => {
  const world = await nestedRetainedWorld()
  const storeGit = gitIn(world.store)
  await storeGit(["symbolic-ref", "HEAD", `refs/heads/${world.branch}`])
  const date = new Date().toISOString().slice(0, 10)
  const archiveRef = `refs/archive/${date}/fixture/${world.branch}`
  const other = (await gitIn(world.origin)(["rev-parse", "refs/heads/main"])).trim()
  await gitIn(world.origin)(["update-ref", archiveRef, other])
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr() + observed.stdout()).toBe(1)
  expect((await storeGit(["symbolic-ref", "-q", "HEAD"])).trim()).toBe(`refs/heads/${world.branch}`)
  expect((await storeGit(["rev-parse", `refs/heads/${world.branch}`])).trim()).toBe(world.tip)
})
