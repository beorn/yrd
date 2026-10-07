/**
 * @reach fs-walk <fixture-only: temporary superproject with a nested submodule>
 * @failure A preview's candidate closure is unreadable once its scratch is gone (27510), or its custody grows without
 *          bound, loses the prior candidate on a failed attempt, renews its age on a retry, or leaks across subjects.
 * @level   l2 (real repositories, real submodule stores, real refs)
 * @consumer yrd submit and its preview (verifyCandidate's previewCustody), 27510 AC1-AC3
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import {
  anchorPreviewCustody,
  PREVIEW_MAX_AGE_MS,
  previewCloneKey,
  previewSubjectPrefix,
} from "../src/preview-custody.ts"
import { ReferenceUnpopulated } from "../src/reference.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=preview@yrd.test", "-c", "user.name=yrd"] as const

async function repository(path: string, file: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  const git = gitIn(path)
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(path, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
}

/** An author's main worktree whose component and its nested component are both initialized stores. */
async function author_clone(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-preview-custody-"))
  roots.push(root)
  await repository(join(root, "nested"), "nested.txt")
  await repository(join(root, "dep"), "dep.txt")
  await gitIn(join(root, "dep"))(["submodule", "add", "--quiet", join(root, "nested"), "apps/nested"])
  await gitIn(join(root, "dep"))([...author, "commit", "--quiet", "--message", "add apps/nested"])
  const product = join(root, "product")
  await repository(product, "product.txt")
  await gitIn(product)(["submodule", "add", "--quiet", join(root, "dep"), "vendor/dep"])
  await gitIn(product)(["submodule", "update", "--init", "--recursive", "--quiet"])
  await gitIn(product)([...author, "commit", "--quiet", "--message", "add vendor/dep"])
  return product
}

/** A new candidate root: the component moves one commit, and the root records it. */
async function candidate(product: string, name: string): Promise<Readonly<{ root: string; dep: string }>> {
  const dep = gitIn(join(product, "vendor/dep"))
  writeFileSync(join(product, "vendor/dep", `${name}.txt`), `${name}\n`)
  await dep(["add", "--all"])
  await dep([...author, "commit", "--quiet", "--message", name])
  const git = gitIn(product)
  await git(["add", "vendor/dep"])
  await git([...author, "commit", "--quiet", "--message", `candidate ${name}`])
  return {
    dep: (await dep(["rev-parse", "HEAD"])).trim(),
    root: (await gitIn(product)(["rev-parse", "HEAD"])).trim(),
  }
}

async function anchorsIn(store: string, prefix = "refs/yrd/preview/"): Promise<Record<string, string>> {
  const listed = (await gitIn(store)(["for-each-ref", "--format=%(refname) %(objectname)", prefix])).trim()
  return Object.fromEntries(listed === "" ? [] : listed.split("\n").map((line) => line.split(" ") as [string, string]))
}

function anchor(product: string, subject: string, root: string): string {
  return `${previewSubjectPrefix(previewCloneKey(join(product, ".git")), subject)}${root}`
}

function custody(
  product: string,
  root: string,
  subject = "task/a",
  extra: Partial<Parameters<typeof anchorPreviewCustody>[0]> = {},
) {
  return anchorPreviewCustody({
    candidate: root,
    excludedSubmodules: [],
    git: gitIn(product),
    gitIn: (cwd) => gitIn(cwd),
    source: product,
    subject,
    ...extra,
  })
}

describe("anchorPreviewCustody (27510)", () => {
  it("keeps the root, its component and the nested component readable through one same-named anchor each", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    const nested = (await gitIn(join(product, "vendor/dep/apps/nested"))(["rev-parse", "HEAD"])).trim()

    const kept = await custody(product, first.root)

    const name = anchor(product, "task/a", first.root)
    expect(kept).toEqual({ anchor: name, retired: [], superseded: [] })
    expect(await anchorsIn(product)).toEqual({ [name]: first.root })
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual({ [name]: first.dep })
    expect(await anchorsIn(join(product, "vendor/dep/apps/nested"))).toEqual({ [name]: nested })
  }, 60_000)

  it("supersedes root first: the prior candidate's anchors are gone and the prefix names only the successor", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root)
    const second = await candidate(product, "second")

    const kept = await custody(product, second.root)

    const prior = anchor(product, "task/a", first.root)
    const next = anchor(product, "task/a", second.root)
    expect(kept.superseded).toEqual([prior])
    expect(await anchorsIn(product)).toEqual({ [next]: second.root })
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual({ [next]: second.dep })
    expect(Object.keys(await anchorsIn(join(product, "vendor/dep/apps/nested")))).toEqual([next])
  }, 60_000)

  it("treats the same candidate again as a no-op that keeps the anchor's first reflog entry", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root)
    const name = anchor(product, "task/a", first.root)
    const reflog = await gitIn(product)(["reflog", "show", "--format=%H %gd", name])

    expect(await custody(product, first.root)).toEqual({ anchor: name, retired: [], superseded: [] })
    expect(await gitIn(product)(["reflog", "show", "--format=%H %gd", name])).toBe(reflog)
  }, 60_000)

  it("fails by name on a store the author never initialized, leaving the prior custody and none of its own", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root)
    const before = {
      dep: await anchorsIn(join(product, "vendor/dep")),
      root: await anchorsIn(product),
    }
    // A candidate that also records a component whose store this clone never created.
    const git = gitIn(product)
    const dep = (await gitIn(join(product, "vendor/dep"))(["rev-parse", "HEAD"])).trim()
    await git(["config", "--file", ".gitmodules", "submodule.vendor/missing.path", "vendor/missing"])
    await git(["config", "--file", ".gitmodules", "submodule.vendor/missing.url", join(product, "..", "dep")])
    await git(["add", ".gitmodules"])
    await git(["update-index", "--add", "--cacheinfo", `160000,${dep},vendor/missing`])
    await git([...author, "commit", "--quiet", "--message", "record an uninitialized component"])
    const failing = (await git(["rev-parse", "HEAD"])).trim()

    const attempt = custody(product, failing)

    await expect(attempt).rejects.toBeInstanceOf(ReferenceUnpopulated)
    await expect(attempt).rejects.toThrow(/vendor\/missing/u)
    expect(await anchorsIn(product)).toEqual(before.root)
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual(before.dep)
  }, 60_000)

  it("keeps each subject's custody independent of the others", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/a")
    const second = await candidate(product, "second")

    await custody(product, second.root, "task/b")

    expect(await anchorsIn(product)).toEqual({
      [anchor(product, "task/a", first.root)]: first.root,
      [anchor(product, "task/b", second.root)]: second.root,
    })
  }, 60_000)

  it("sweeps a component anchor whose root anchor is gone", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    const orphan = anchor(product, "task/gone", "0".repeat(40))
    await gitIn(join(product, "vendor/dep"))(["update-ref", orphan, first.dep])

    await custody(product, first.root)

    expect(Object.keys(await anchorsIn(join(product, "vendor/dep")))).toEqual([anchor(product, "task/a", first.root)])
  }, 60_000)

  it("retires an ended subject's custody root first, then sweeps its components", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/landed")
    const second = await candidate(product, "second")

    const kept = await custody(product, second.root, "task/a", { retired: new Set(["task/landed"]) })

    expect(kept.retired).toEqual([anchor(product, "task/landed", first.root)])
    const live = anchor(product, "task/a", second.root)
    expect(await anchorsIn(product)).toEqual({ [live]: second.root })
    expect(Object.keys(await anchorsIn(join(product, "vendor/dep")))).toEqual([live])
  }, 60_000)

  it("retires another subject whose anchor's first reflog entry is past seven days, and keeps a younger one", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/old")
    const second = await candidate(product, "second")
    const young = await custody(product, second.root, "task/a", { now: () => Date.now() + PREVIEW_MAX_AGE_MS - 60_000 })
    expect(young.retired).toEqual([])

    const third = await candidate(product, "third")
    const aged = await custody(product, third.root, "task/a", { now: () => Date.now() + PREVIEW_MAX_AGE_MS + 60_000 })

    expect(aged.retired).toEqual([anchor(product, "task/old", first.root)])
  }, 60_000)

  it("keeps, and names, another subject's anchor whose age cannot be read", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    // No --create-reflog: an anchor written outside custody has no first entry to date it.
    const ageless = anchor(product, "task/ageless", first.root)
    await gitIn(product)(["update-ref", ageless, first.root])
    const second = await candidate(product, "second")
    const named: string[] = []

    const kept = await custody(product, second.root, "task/a", {
      leftover: (why) => void named.push(why),
      now: () => Date.now() + 10 * PREVIEW_MAX_AGE_MS,
    })

    expect(kept.retired).toEqual([])
    expect(Object.keys(await anchorsIn(product))).toContain(ageless)
    expect(named.join("\n")).toContain(`${ageless}'s age is unknown, so it is kept`)
  }, 60_000)
})
