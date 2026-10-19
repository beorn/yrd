/**
 * @reach fs-walk <fixture-only: bare component stores under a temporary root>
 * @failure yrd drop --local aimed at a cold retained module store resolves the
 * shared root instead, reports the branch absent there, and never retires it.
 * @level l2 (`runYrdProcess` against a real bare component store and its origin)
 * @consumer yrd drop cleanup of retained/cold component stores.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  const sharedRoot = join(root, "shared-root")
  await storeSeed(["init", "--quiet", "--bare", "--initial-branch=main", sharedRoot])
  return { root, sharedRoot, store, origin, branch, tip }
}

it("retires a branch held in a cold retained module store and leaves the shared root untouched", async () => {
  const world = await retainedWorld({ withOrigin: true })
  const sharedRefsBefore = (await gitIn(world.sharedRoot)(["for-each-ref"])).trim()
  const observed = capture(world.store)
  const code = await runYrdProcess(
    ["bun", "yrd", "drop", world.branch, "--local", "--tip", world.tip, "--submitter", "fixture", "--json"],
    observed.io,
  )
  expect(code, observed.stderr()).toBe(0)
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
