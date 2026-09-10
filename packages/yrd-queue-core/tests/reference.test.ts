/**
 * @failure The queue's reference repository holds no object store for a gitlink, so every
 *          compose clones that submodule from the network instead of borrowing it.
 * @level   l2 (real repositories, real submodules, real `git super worktree add`)
 * @consumer every queue run, `yrd check` and `yrd env` compose — all borrow from one reference
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "../src/git.ts"
import type { LogWrite } from "../src/log.ts"
import { GitlinkNotOnRemote, populateReferenceStores, ReferenceUnpopulated } from "../src/reference.ts"
import { freshWorktree } from "../src/worktree.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=reference@yrd.test", "-c", "user.name=yrd"] as const

/**
 * The git-super this repository PINS, not whichever one the host happens to
 * have on PATH.
 *
 * A subcommand is a PATH lookup, so a compose silently takes the ambient
 * binary — and the ambient one is a different build with different refusals. A
 * test asserting that the compose refuses would then be asserting something
 * about the machine it ran on.
 */
const gitSuperBin = resolve(Bun.resolveSync("git-super", import.meta.dirname), "../../bin")
const superEnv = { ...process.env, PATH: `${gitSuperBin}:${process.env.PATH ?? ""}` }

/** A Git that composes through the pinned build, and hands the same PATH to whatever it starts. */
function composingGit(cwd: string): ReturnType<typeof gitIn> {
  return gitIn(cwd, undefined, undefined, { env: superEnv })
}

async function repository(path: string, file: string): Promise<string> {
  mkdirSync(path, { recursive: true })
  const git = gitIn(path)
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(path, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
  return (await git(["rev-parse", "HEAD"])).trim()
}

/**
 * A superproject whose submodule has a submodule of its own.
 *
 * The nesting is the point, not decoration: git-super borrows a nested gitlink
 * from `<reference>/<parent>/<child>`, so a reference given a store for the
 * parent and none for the child is refused one level down and the whole
 * population is worthless. km carries exactly this shape (`apps/maddoc`).
 */
async function superproject(root: string): Promise<Readonly<{ nested: string; product: string; vendor: string }>> {
  const nested = join(root, "nested")
  const vendor = join(root, "vendor-dep")
  const product = join(root, "product")
  await repository(nested, "nested.txt")
  await repository(vendor, "vendor.txt")
  const vendorGit = gitIn(vendor)
  await vendorGit(["submodule", "add", "--quiet", nested, "apps/nested"])
  await vendorGit([...author, "commit", "--quiet", "--message", "add apps/nested"])
  await repository(product, "product.txt")
  const productGit = gitIn(product)
  await productGit(["submodule", "add", "--quiet", vendor, "vendor/dep"])
  await productGit([...author, "commit", "--quiet", "--message", "add vendor/dep"])
  return { nested, product, vendor }
}

/** The queue's own shape: `--no-checkout`, so no submodule was ever materialized under it. */
async function queueClone(root: string, product: string): Promise<string> {
  const repo = join(root, "queue-clone")
  await gitIn(root)(["clone", "--quiet", "--no-checkout", "--origin", "origin", product, repo])
  return repo
}

describe("populateReferenceStores", () => {
  it("gives every gitlink a real store with its own origin refs, nested ones included", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-populate-"))
    roots.push(root)
    const { product } = await superproject(root)
    const repo = await queueClone(root, product)
    // The state that cost four hours on 2026-09-09: a reference with nothing
    // under it at all, which every compose then read as fifteen cold fetches.
    expect(existsSync(join(repo, "vendor/dep"))).toBe(false)

    const created = await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })

    expect(created.map(({ path }) => path)).toEqual(["vendor/dep", "vendor/dep/apps/nested"])
    for (const { path } of created) {
      const store = join(repo, path)
      // A REAL clone with its own refs, not an alternates pointer at somebody
      // else's store: an alternates borrow leaves these objects unreferenced
      // where they came from, and a later repack there strands them.
      expect((await gitIn(store)(["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim()).toBe(store)
      expect(await gitIn(store)(["for-each-ref", "--format=%(refname)"])).toContain("refs/remotes/origin/main")
      expect(existsSync(join(store, "objects/info/alternates"))).toBe(false)
    }
    expect(created.every(({ ms }) => ms >= 0)).toBe(true)
  }, 60_000)

  it("leaves a store that is already there exactly as it is", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-idempotent-"))
    roots.push(root)
    const { product } = await superproject(root)
    const repo = await queueClone(root, product)
    const first = await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })
    expect(first.length).toBe(2)
    const head = (await gitIn(join(repo, "vendor/dep"))(["rev-parse", "HEAD"])).trim()

    const announced: string[] = []
    const second = await populateReferenceStores({
      gitIn: (cwd) => gitIn(cwd),
      populated: (store) => void announced.push(store.path),
      repo,
    })

    // Nothing created and nothing said. A populate that re-clones is a populate
    // that runs on every compose, which is the cost this exists to remove.
    expect(second).toEqual([])
    expect(announced).toEqual([])
    expect((await gitIn(join(repo, "vendor/dep"))(["rev-parse", "HEAD"])).trim()).toBe(head)
  }, 60_000)

  /**
   * @failure A pin fetched by sha lands unreachable, and the next gc in that store takes it.
   *
   * The second populate is what makes this a real test: the store already
   * exists and does NOT hold the raised pin, which is the only path that
   * fetches. `refs/remotes/origin/main` still names the first commit, so the
   * raised one is reachable through the pin ref or through nothing at all —
   * and `gc --prune=now` is the same collection that made a submodule
   * un-checkout-able at its raised pin on 2026-09-09.
   */
  it("keeps a pin it fetched reachable, so a later gc in that store cannot take it", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-pinned-"))
    roots.push(root)
    const { product, vendor } = await superproject(root)
    const repo = await queueClone(root, product)
    const first = await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })
    expect(first.length).toBe(2)
    const store = join(repo, "vendor/dep")
    const storeGit = gitIn(store)
    // A pin already in the store is pinned too: it arrived on a branch, and a
    // branch moves.
    const cloned = (await storeGit(["rev-parse", "HEAD"])).trim()
    expect(await storeGit(["for-each-ref", "--format=%(refname)", "refs/yrd/pins"])).toContain(cloned)

    // Raise the gitlink to a commit the store has never seen.
    const vendorGit = gitIn(vendor)
    writeFileSync(join(vendor, "vendor.txt"), "vendor moved\n")
    await vendorGit(["add", "--all"])
    await vendorGit([...author, "commit", "--quiet", "--message", "advance vendor"])
    const raised = (await vendorGit(["rev-parse", "HEAD"])).trim()
    const productGit = gitIn(product)
    await productGit(["-C", "vendor/dep", "fetch", "--quiet", "origin"])
    await productGit(["-C", "vendor/dep", "checkout", "--quiet", "--detach", raised])
    await productGit([...author, "commit", "--quiet", "--all", "--message", "raise vendor/dep"])
    await gitIn(repo)(["fetch", "--quiet", "origin", "main"])
    const head = (await gitIn(repo)(["rev-parse", "FETCH_HEAD"])).trim()
    await expect(storeGit(["cat-file", "-e", `${raised}^{commit}`])).rejects.toThrow()

    await populateReferenceStores({ commit: head, gitIn: (cwd) => gitIn(cwd), repo })

    expect(await storeGit(["for-each-ref", "--format=%(refname)", "refs/yrd/pins"])).toContain(raised)
    // The remote-tracking ref still names the OLD commit, so nothing but the
    // pin ref stands between the raised one and the collector.
    expect((await storeGit(["rev-parse", "refs/remotes/origin/main"])).trim()).toBe(cloned)
    await storeGit(["gc", "--prune=now", "--quiet"])
    expect(await storeGit(["cat-file", "-t", raised])).toContain("commit")
  }, 60_000)

  /**
   * The two causes of an unfetchable pin, told apart by one probe. Both
   * fixtures raise the SAME gitlink to the SAME unpushed commit; the only
   * difference is whether the component's remote answers, which is the only
   * thing that decides who is billed.
   */
  it.each([
    ["reachable", true],
    ["unreachable", false],
  ] as const)(
    "bills a pin missing from a %s remote to the right owner",
    async (_name, reachable) => {
      const root = mkdtempSync(join(tmpdir(), `yrd-reference-${_name}-`))
      roots.push(root)
      const { product, vendor } = await superproject(root)
      const repo = await queueClone(root, product)
      await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })

      // A component commit that never left its author's bay: made in a clone,
      // never pushed, and the root carrier raised to it anyway.
      const bay = join(root, "vendor-bay")
      await gitIn(root)(["clone", "--quiet", vendor, bay])
      const bayGit = gitIn(bay)
      writeFileSync(join(bay, "vendor.txt"), "only in the bay\n")
      await bayGit(["add", "--all"])
      await bayGit([...author, "commit", "--quiet", "--message", "unpushed component commit"])
      const unpushed = (await bayGit(["rev-parse", "HEAD"])).trim()
      const productGit = gitIn(product)
      await productGit(["update-index", "--add", "--cacheinfo", `160000,${unpushed},vendor/dep`])
      await productGit([...author, "commit", "--quiet", "--message", "raise vendor/dep to an unpushed commit"])
      await gitIn(repo)(["fetch", "--quiet", "origin", "main"])
      const head = (await gitIn(repo)(["rev-parse", "FETCH_HEAD"])).trim()
      // The store's origin is the component's real remote; taking it away is the
      // only difference between the two cases.
      if (!reachable) rmSync(vendor, { force: true, recursive: true })

      const populating = populateReferenceStores({ commit: head, gitIn: (cwd) => gitIn(cwd), repo })

      if (reachable) {
        // The remote answered and does not hold the commit: the submitter's.
        await expect(populating).rejects.toBeInstanceOf(GitlinkNotOnRemote)
        await expect(populating).rejects.toMatchObject({ path: "vendor/dep", sha: unpushed, url: vendor })
      } else {
        // Nothing answered, so nothing can be attributed: the queue's ground.
        await expect(populating).rejects.toBeInstanceOf(ReferenceUnpopulated)
        await expect(populating).rejects.toThrow(/could not be reached either/u)
      }
    },
    60_000,
  )

  it("refuses a gitlink whose remote cannot be cloned, naming the store it could not make", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-unreachable-"))
    roots.push(root)
    const { product, vendor } = await superproject(root)
    const repo = await queueClone(root, product)
    // The remote the declaration names is gone, so no store can be made for it.
    // Reporting an empty result here would hand a caller a reference it has
    // been told is self-contained and is not.
    rmSync(vendor, { force: true, recursive: true })

    await expect(populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })).rejects.toThrow(/vendor\/dep/u)
  }, 60_000)
})

describe("freshWorktree", () => {
  it("populates the reference for the composed commit, then borrows instead of fetching", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-compose-"))
    roots.push(root)
    const { product } = await superproject(root)
    const repo = await queueClone(root, product)
    const git = composingGit(repo)
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const journal: LogWrite[] = []
    const plumbing = { journal: (record: LogWrite) => void journal.push(record) }

    const worktree = await freshWorktree(git, repo, commit, join(root, "candidate"), {
      env: superEnv,
      plumbing,
      populateReference: true,
    })

    // Populated on the way in, and reported as records rather than as a trace
    // line nobody turned on.
    expect(journal.filter(({ kind }) => kind === "reference").map((record) => record["path"])).toEqual([
      "vendor/dep",
      "vendor/dep/apps/nested",
    ])
    // THE WHOLE CLAIM. Every gitlink came off local disk, so no `warning` row
    // was written: a compose that fetched or found no reference is the degraded
    // one, and it is exactly what read as ordinary for four hours.
    expect(journal.filter(({ kind }) => kind === "warning")).toEqual([])
    expect(existsSync(join(worktree.path, "vendor/dep/vendor.txt"))).toBe(true)
    expect(existsSync(join(worktree.path, "vendor/dep/apps/nested/nested.txt"))).toBe(true)

    // A second compose finds the reference already self-contained: no store to
    // make, so no row to write, and it still borrows.
    const again: LogWrite[] = []
    const second = await freshWorktree(git, repo, commit, join(root, "candidate-2"), {
      env: superEnv,
      plumbing: { journal: (record: LogWrite) => void again.push(record) },
      populateReference: true,
    })
    expect(again.filter(({ kind }) => kind === "reference")).toEqual([])
    expect(again.filter(({ kind }) => kind === "warning")).toEqual([])
    expect(existsSync(join(second.path, "vendor/dep/apps/nested/nested.txt"))).toBe(true)
  }, 120_000)

  /**
   * The other branch of the same boolean, and the reason it exists.
   *
   * `yrd check` and `yrd env` compose from the SEAT's own checkout, so `repo`
   * there is a tree somebody is working in. Populating it would write a clone
   * into an uninitialized submodule directory as a side effect of a command
   * that asked for nothing of the kind. The compose refuses instead, and
   * git-super's refusal carries the `submodule update --init` that fixes it, so
   * the person reading it owns that decision rather than having it made for
   * them.
   */
  it("leaves the tree alone and lets git-super name the remedy when the repository is not the queue's", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-not-owned-"))
    roots.push(root)
    const { product } = await superproject(root)
    const repo = await queueClone(root, product)
    const git = composingGit(repo)
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const journal: LogWrite[] = []

    // The default: no flag, no population.
    const composing = freshWorktree(git, repo, commit, join(root, "candidate"), {
      env: superEnv,
      plumbing: { journal: (record: LogWrite) => void journal.push(record) },
    })

    await expect(composing).rejects.toBeInstanceOf(ReferenceUnpopulated)
    await expect(composing).rejects.toThrow(/holds no object store for/u)
    // The remedy reaches the reader through the refusal, unedited.
    await expect(composing).rejects.toThrow(new RegExp(`submodule update --init -- vendor/dep`, "u"))
    // Nothing was created and nothing was said: the tree is exactly as found.
    expect(existsSync(join(repo, "vendor/dep"))).toBe(false)
    expect(journal).toEqual([])
  }, 60_000)

  /**
   * The reference is REAL and already self-contained here, so the populate step
   * is a genuine no-op; only git-super's answer is stubbed. That is the only way
   * to reach this row from a local fixture, because populating for the composed
   * commit is precisely what stops a pin from needing a fetch — which is the
   * point of the change, and also why the degraded case has to be provoked
   * rather than arranged.
   */
  it("writes a warning row naming the paths when a compose did not borrow", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-degraded-"))
    roots.push(root)
    const { product } = await superproject(root)
    const repo = await queueClone(root, product)
    await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })
    const commit = (await gitIn(repo)(["rev-parse", "HEAD"])).trim()
    const path = join(root, "candidate")
    const journal: LogWrite[] = []
    const composed = {
      commit,
      gitlinks: { absent: 0, borrowed: 0, considered: 1, fetched: 1, fetchedPaths: ["vendor/dep"] },
      gitmodules: true,
      partial: false,
      path,
      repositories: [{ refs: [], repository: repo, state: "updated" }],
      requested: commit,
      state: "updated",
    }
    const stubbed = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "ls-tree") return `100644 blob 0\t.gitmodules\n`
      if (args[0] === "super") return JSON.stringify(composed)
      throw new Error(`the degraded-compose stub was asked for ${args.join(" ")}`)
    }

    await freshWorktree(stubbed, repo, commit, path, { plumbing: { journal: (r) => void journal.push(r) } })

    const warnings = journal.filter(({ kind }) => kind === "warning")
    expect(warnings.length).toBe(1)
    // The count alone sends a reader back to re-derive which store to repair,
    // which is the cost the paths exist to remove.
    expect(warnings[0]).toMatchObject({
      absent: 0,
      considered: 1,
      fetched: 1,
      paths: ["vendor/dep"],
      reason: "reference-not-borrowed",
      reference: repo,
    })
  }, 60_000)
})
