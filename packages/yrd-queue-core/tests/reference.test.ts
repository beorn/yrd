/**
 * @reach fs-walk <fixture-only: reference cases use temporary repos and a named git-super binary>
 * @failure The queue's reference repository holds no object store for a gitlink, so every
 *          compose clones that submodule from the network instead of borrowing it.
 * @level   l2 (real repositories, real submodules, real `git super worktree add`)
 * @consumer every queue run, `yrd check` and `yrd env` compose — all borrow from one reference
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireExclusive } from "git-super/exclusive"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it, vi } from "vitest"
import { type Git } from "../src/git.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import type { LogWrite } from "../src/log.ts"
import {
  GitlinkNotOnRemote,
  gitlinksAt,
  populateReferenceStores,
  readComponentMain,
  type ReferenceAcquisition,
  ReferenceUnpopulated,
} from "../src/reference.ts"
import { verifyCandidate } from "../src/verifying.ts"
import * as verifying from "../src/verifying.ts"
import { inspectSubmit, submit } from "../src/submit.ts"
import { freshWorktree, registeredWorktrees } from "../src/worktree.ts"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=reference@yrd.test", "-c", "user.name=yrd"] as const

it("reports the reference store and query when component main cannot be read", async () => {
  const store = mkdtempSync(join(tmpdir(), "yrd-reference-main-read-"))
  roots.push(store)
  const git = vi.fn<Git>().mockResolvedValueOnce("").mockRejectedValueOnce(new Error("object database unreadable"))
  await expect(
    readComponentMain(
      () => git,
      store,
      () => undefined,
    ),
  ).rejects.toThrow(
    `readComponentMain: cannot read refs/remotes/origin/main^{commit} in ${store}: object database unreadable`,
  )
})

/**
 * The git-super this repository PINS, not whichever one the host happens to
 * have on PATH.
 *
 * A subcommand is a PATH lookup, so a compose silently takes the ambient
 * binary — and the ambient one is a different build with different refusals. A
 * test asserting that the compose refuses would then be asserting something
 * about the machine it ran on.
 */
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
  it("refuses a mismatched root object view before pin publication without an observer", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-root-owner-"))
    roots.push(root)
    const repo = join(root, "reference")
    const baseline = await repository(repo, "root.txt")
    const directory = join(root, "other-objects")
    mkdirSync(directory)
    const selected = gitIn(repo, undefined, undefined, {
      objects: { directory, alternates: [join(repo, ".git/objects")] },
    })
    await expect(populateReferenceStores({ repo, gitIn: () => selected })).rejects.toThrow(
      "does not belong to selected common owner",
    )
    await expect(gitIn(repo)(["rev-parse", "--verify", `refs/yrd/pins/${baseline}`])).rejects.toThrow()
  })
  it("gives every gitlink a real store with its own origin refs, nested ones included", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-populate-"))
    roots.push(root)
    const { product } = await superproject(root)
    const repo = await queueClone(root, product)
    // The state that cost four hours on 2026-09-09: a reference with nothing
    // under it at all, which every compose then read as fifteen cold fetches.
    expect(existsSync(join(repo, "vendor/dep"))).toBe(false)

    const acquired: ReferenceAcquisition[] = []
    const created = await populateReferenceStores({
      gitIn: (cwd) => gitIn(cwd),
      repo,
      acquired: (pin) => void acquired.push(pin),
    })

    const rootHead = (await gitIn(repo)(["rev-parse", "HEAD"])).trim()
    expect((await gitIn(repo)(["rev-parse", `refs/yrd/pins/${rootHead}`])).trim()).toBe(rootHead)
    expect(acquired.map(({ path }) => path)).toEqual([".", "vendor/dep", "vendor/dep/apps/nested"])
    for (const pin of acquired) {
      const owner = pin.objectOwner
      expect(owner).toBeDefined()
      const storeGit = gitIn(join(repo, pin.path))
      expect(owner.gitDirectory).toBe(
        realpathSync((await storeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()),
      )
      expect(owner.objects).toBe(join(owner.gitDirectory, "objects"))
      expect(owner.retained).toEqual([{ ref: `refs/yrd/pins/${pin.sha}`, oid: pin.sha }])
      expect((await storeGit(["rev-parse", "--verify", owner.retained[0]!.ref])).trim()).toBe(pin.sha)
      expect((await storeGit(["cat-file", "-t", pin.sha])).trim()).toBe("commit")
    }

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

    expect((await gitIn(repo)(["rev-parse", `refs/yrd/pins/${head}`])).trim()).toBe(head)

    expect(await storeGit(["for-each-ref", "--format=%(refname)", "refs/yrd/pins"])).toContain(raised)
    // The remote-tracking ref still names the OLD commit, so nothing but the
    // pin ref stands between the raised one and the collector.
    expect((await storeGit(["rev-parse", "refs/remotes/origin/main"])).trim()).toBe(cloned)
    await storeGit(["gc", "--prune=now", "--quiet"])
    expect(await storeGit(["cat-file", "-t", raised])).toContain("commit")
  }, 60_000)

  it("promotes a locally held candidate pin into the owner reference without contacting its origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-local-pin-"))
    roots.push(root)
    const { nested, product, vendor } = await superproject(root)
    const repo = await queueClone(root, product)
    await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })

    const source = join(root, "composition-source")
    const bay = join(source, "vendor/dep")
    const nestedSource = join(bay, "apps/nested")
    await gitIn(root)(["clone", "--quiet", vendor, bay])
    await gitIn(root)(["clone", "--quiet", nested, nestedSource])
    const bayGit = gitIn(bay)
    writeFileSync(join(bay, "vendor.txt"), "held locally\n")
    await bayGit(["add", "--all"])
    await bayGit([...author, "commit", "--quiet", "--message", "local candidate pin"])
    const candidate = (await bayGit(["rev-parse", "HEAD"])).trim()
    const productGit = gitIn(product)
    await productGit(["update-index", "--add", "--cacheinfo", `160000,${candidate},vendor/dep`])
    await productGit([...author, "commit", "--quiet", "--message", "raise vendor/dep to local pin"])
    await gitIn(repo)(["fetch", "--quiet", "origin", "main"])
    const head = (await gitIn(repo)(["rev-parse", "FETCH_HEAD"])).trim()
    // The candidate exists in the caller's temporary composition store, while
    // the persistent store's declared origin is deliberately unavailable.
    rmSync(vendor, { force: true, recursive: true })

    await populateReferenceStores({
      commit: head,
      gitIn: (cwd) => gitIn(cwd),
      repo,
      source,
    })

    const storeGit = gitIn(join(repo, "vendor/dep"))
    expect(await storeGit(["cat-file", "-t", candidate])).toContain("commit")
    expect(await storeGit(["for-each-ref", "--format=%(refname)", "refs/yrd/pins"])).toContain(candidate)
  }, 60_000)

  it("falls back to the component origin when the optional local source is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-missing-source-"))
    roots.push(root)
    const { product, vendor } = await superproject(root)
    const repo = await queueClone(root, product)
    await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })

    const vendorGit = gitIn(vendor)
    writeFileSync(join(vendor, "vendor.txt"), "available from origin\n")
    await vendorGit(["add", "--all"])
    await vendorGit([...author, "commit", "--quiet", "--message", "origin pin"])
    const candidate = (await vendorGit(["rev-parse", "HEAD"])).trim()
    const productGit = gitIn(product)
    await productGit(["update-index", "--add", "--cacheinfo", `160000,${candidate},vendor/dep`])
    await productGit([...author, "commit", "--quiet", "--message", "raise vendor/dep to origin pin"])
    await gitIn(repo)(["fetch", "--quiet", "origin", "main"])
    const head = (await gitIn(repo)(["rev-parse", "FETCH_HEAD"])).trim()
    const source = join(root, "composition-source")
    mkdirSync(source)
    const acquired: ReferenceAcquisition[] = []

    await populateReferenceStores({
      commit: head,
      gitIn: (cwd) => gitIn(cwd),
      repo,
      source,
      acquired: (record) => void acquired.push(record),
    })

    const storeGit = gitIn(join(repo, "vendor/dep"))
    expect(await storeGit(["cat-file", "-t", candidate])).toContain("commit")
    expect(await storeGit(["for-each-ref", "--format=%(refname)", "refs/yrd/pins"])).toContain(candidate)
    expect(acquired).toContainEqual({
      objectOwner: expect.objectContaining({ retained: [{ ref: `refs/yrd/pins/${candidate}`, oid: candidate }] }),
      localMiss: expect.objectContaining({
        localSource: join(source, "vendor/dep"),
        reason: expect.any(String),
      }),
      path: "vendor/dep",
      sha: candidate,
      source: "remote",
    })
  }, 60_000)

  it("fails loudly when the local source contains a corrupt object for the requested pin", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-corrupt-source-"))
    roots.push(root)
    const { nested, product, vendor } = await superproject(root)
    const repo = await queueClone(root, product)
    await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })

    const vendorGit = gitIn(vendor)
    writeFileSync(join(vendor, "vendor.txt"), "valid origin copy\n")
    await vendorGit(["add", "--all"])
    await vendorGit([...author, "commit", "--quiet", "--message", "pin with a corrupt local copy"])
    const candidate = (await vendorGit(["rev-parse", "HEAD"])).trim()
    const productGit = gitIn(product)
    await productGit(["update-index", "--add", "--cacheinfo", `160000,${candidate},vendor/dep`])
    await productGit([...author, "commit", "--quiet", "--message", "raise vendor/dep to valid origin pin"])
    await gitIn(repo)(["fetch", "--quiet", "origin", "main"])
    const head = (await gitIn(repo)(["rev-parse", "FETCH_HEAD"])).trim()
    const source = join(root, "corrupt-source")
    const sourceStore = join(source, "vendor/dep")
    const nestedSource = join(sourceStore, "apps/nested")
    await gitIn(root)(["clone", "--quiet", "--no-hardlinks", vendor, sourceStore])
    await gitIn(root)(["clone", "--quiet", nested, nestedSource])
    const object = join(sourceStore, ".git", "objects", candidate.slice(0, 2), candidate.slice(2))
    expect(existsSync(object)).toBe(true)
    chmodSync(object, 0o644)
    writeFileSync(object, "corrupt object bytes\n")

    await expect(
      populateReferenceStores({
        commit: head,
        gitIn: (cwd) => gitIn(cwd),
        repo,
        source,
      }),
    ).rejects.toThrow()
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
    safeRemoveSync(vendor, { within: realpathSync(tmpdir()) })

    await expect(populateReferenceStores({ gitIn: (cwd) => gitIn(cwd), repo })).rejects.toThrow(/vendor\/dep/u)
  }, 60_000)
})

/**
 * @failure A queue prune runs while another git-super worktree mutation of the
 * same repository is in flight, bypassing its worktree mutation lock (26240).
 * @level l2 (real repositories and real Git)
 * @consumer Worktree.remove after a queue check
 */
describe("queue worktree removal shares git-super's worktree lock", () => {
  async function lockedRepository(
    name: string,
  ): Promise<Readonly<{ root: string; repo: string; git: Git; commit: string; lock: string }>> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `yrd-worktree-prune-${name}-`)))
    roots.push(root)
    const repo = join(root, "repo")
    const commit = await repository(repo, "one.txt")
    const git = gitIn(repo)
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    return { commit, git, lock: join(common, "yrd-worktree-mutations"), repo, root }
  }

  async function registered(git: Git): Promise<readonly string[]> {
    return (await registeredWorktrees(git)).map((worktree) => worktree.path)
  }

  async function stillRunningAfter(operation: Promise<unknown>, ms: number): Promise<boolean> {
    const running = Symbol("running")
    const first = await Promise.race([
      operation.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(running), ms)),
    ])
    return first === running
  }

  it("remove drops the directory first and waits to forget registration", async () => {
    const { commit, git, lock, repo, root } = await lockedRepository("remove")
    const worktree = await freshWorktree(git, repo, commit, join(root, "candidate"))
    expect(await registered(git)).toContain(worktree.path)

    const held = await acquireExclusive(lock, {}, "a bay being provisioned")
    let removing: Promise<void> | undefined
    try {
      removing = worktree.remove()
      expect(await stillRunningAfter(removing, 500)).toBe(true)
      expect(existsSync(worktree.path)).toBe(false)
      expect(await registered(git)).toContain(worktree.path)
    } finally {
      held.release()
    }
    await removing
    expect(await registered(git)).not.toContain(worktree.path)
  })
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
    expect(
      journal
        .filter((record) => record["kind"] === "reference" && record["action"] !== "acquired")
        .map((record) => record["path"]),
    ).toEqual(["vendor/dep", "vendor/dep/apps/nested"])
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
    expect(again.filter((record) => record["kind"] === "reference" && record["action"] !== "acquired")).toEqual([])
    expect(again.filter(({ kind }) => kind === "warning")).toEqual([])
    expect(existsSync(join(second.path, "vendor/dep/apps/nested/nested.txt"))).toBe(true)
  }, 120_000)

  it("keeps a verifyCandidate-local moved pin borrowable after its composition source is removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-reference-verify-custody-"))
    roots.push(root)
    const { nested, product, vendor } = await superproject(root)
    const nestedRemote = "https://github.com/beorn/yrd-reference-nested-fixture.git"
    const componentRemote = "https://github.com/beorn/yrd-reference-component-fixture.git"
    const vendorGit = gitIn(vendor)
    await vendorGit(["config", "-f", ".gitmodules", "submodule.apps/nested.url", nestedRemote])
    await vendorGit(["add", ".gitmodules"])
    await vendorGit([...author, "commit", "--quiet", "--message", "name hosted nested remote"])
    const productGit = gitIn(product)
    await productGit(["config", "-f", ".gitmodules", "submodule.vendor/dep.url", componentRemote])
    const componentBase = (await vendorGit(["rev-parse", "HEAD"])).trim()
    await productGit(["update-index", "--add", "--cacheinfo", `160000,${componentBase},vendor/dep`])
    writeFileSync(join(product, ".yrd.yml"), "{}\n")
    await productGit(["add", ".gitmodules", ".yrd.yml"])
    await productGit([...author, "commit", "--quiet", "--message", "name hosted component remote"])
    const repo = await queueClone(root, product)
    const logicalOrigin = "https://github.com/beorn/yrd-reference-fixture.git"
    const fixtureEnv = {
      ...superEnv,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
      GIT_CONFIG_KEY_1: `url.${vendor}.insteadOf`,
      GIT_CONFIG_VALUE_1: componentRemote,
      GIT_CONFIG_KEY_2: `url.${product}.insteadOf`,
      GIT_CONFIG_VALUE_2: logicalOrigin,
      GIT_CONFIG_KEY_3: `url.${nested}.insteadOf`,
      GIT_CONFIG_VALUE_3: nestedRemote,
    }
    const git = gitIn(repo, undefined, undefined, { env: fixtureEnv })
    await git(["remote", "set-url", "origin", logicalOrigin])
    await populateReferenceStores({ gitIn: (cwd) => gitIn(cwd, undefined, undefined, { env: fixtureEnv }), repo })

    // The submitted child pin and component main diverge from their shared
    // base. Git Super must compose the two independent file changes into a new
    // child commit while verifying the root candidate.
    const component = join(root, "candidate-component")
    await gitIn(root)(["clone", "--quiet", vendor, component])
    const componentGit = gitIn(component)
    writeFileSync(join(component, "candidate-only.txt"), "submitted side\n")
    await componentGit(["add", "--all"])
    await componentGit([...author, "commit", "--quiet", "--message", "candidate component side"])
    const candidatePin = (await componentGit(["rev-parse", "HEAD"])).trim()
    await componentGit(["push", "--quiet", "origin", `${candidatePin}:refs/heads/candidate-side`])

    const baseRoot = (await productGit(["rev-parse", "HEAD"])).trim()
    await productGit(["checkout", "--quiet", "-b", "candidate"])
    await productGit(["update-index", "--add", "--cacheinfo", `160000,${candidatePin},vendor/dep`])
    await productGit([...author, "commit", "--quiet", "--message", "candidate root pin"])
    const candidateRoot = (await productGit(["rev-parse", "HEAD"])).trim()
    await productGit(["checkout", "--quiet", "main"])
    expect((await productGit(["rev-parse", "HEAD"])).trim()).toBe(baseRoot)

    writeFileSync(join(vendor, "main-only.txt"), "main side\n")
    await vendorGit(["add", "--all"])
    await vendorGit([...author, "commit", "--quiet", "--message", "advance component main independently"])
    const mainPin = (await vendorGit(["rev-parse", "HEAD"])).trim()
    const nestedGit = gitIn(nested)
    const nestedPin = (await nestedGit(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(nested, "nested.txt"), "nested main advanced\n")
    await nestedGit(["add", "nested.txt"])
    await nestedGit([...author, "commit", "--quiet", "--message", "advance nested main independently"])
    const nestedMain = (await nestedGit(["rev-parse", "HEAD"])).trim()
    await gitIn(join(repo, "vendor/dep/apps/nested"), undefined, undefined, { env: fixtureEnv })([
      "fetch",
      "--quiet",
      "origin",
      "main",
    ])
    await gitIn(join(repo, "vendor/dep"), undefined, undefined, { env: fixtureEnv })([
      "fetch",
      "--quiet",
      "origin",
      "main",
    ])
    await productGit(["update-index", "--add", "--cacheinfo", `160000,${mainPin},vendor/dep`])
    await productGit([...author, "commit", "--quiet", "--message", "advance root target to component main"])
    await git(["fetch", "--quiet", "origin", "main"])
    const targetHead = (await git(["rev-parse", "FETCH_HEAD"])).trim()
    await git(["fetch", "--quiet", "origin", "candidate"])
    const head = (await git(["rev-parse", "FETCH_HEAD"])).trim()

    const verified = await verifyCandidate({
      git,
      env: fixtureEnv,
      head,
      message: "verify a root candidate carrying a local component pin",
      path: join(root, "verification-worktree"),
      repo,
      targetHead,
      worktree: {
        env: fixtureEnv,
        populateReference: true,
      },
    })
    if (verified.state !== "verified") {
      throw new Error(`candidate verification failed: ${JSON.stringify(verified.verifying.detail)}`)
    }

    const verifiedRoot = verified.verifying.candidate
    const mergedGitlink = verified.verifying.gitlinks.find(({ path }) => path === "vendor/dep")
    expect(mergedGitlink).toMatchObject({ path: "vendor/dep", state: "merged" })
    const composedPin = (await git(["rev-parse", `${verifiedRoot}:vendor/dep`])).trim()
    expect(composedPin).not.toBe(candidatePin)
    // 26404: the tree records `from` (the two-parent composition). `composition.pin`
    // is the author's second parent; `to` / `composition.parent` is component main.
    expect(mergedGitlink?.from).toBe(composedPin)
    expect(mergedGitlink?.to).toBe(mainPin)
    expect(mergedGitlink?.composition).toMatchObject({ parent: mainPin, pin: candidatePin })
    expect(verified.verifying.gitlinks.find(({ path }) => path === "vendor/dep/apps/nested")).toMatchObject({
      state: "kept-behind",
      from: nestedPin,
      to: nestedMain,
    })
    // Nested receipts must read the pin in the owning commit, and cannot
    // silently use the enclosing repository when the parent store is absent.
    const nestedPath = "vendor/dep/apps/nested"
    expect(await gitlinksAt(git, verifiedRoot, ["vendor/dep", nestedPath])).toEqual([
      { path: "vendor/dep", sha: composedPin },
      { path: nestedPath, sha: nestedPin },
    ])
    const parentStore = join(repo, "vendor/dep")
    renameSync(parentStore, `${parentStore}-held`)
    try {
      await expect(gitlinksAt(git, verifiedRoot, [nestedPath])).rejects.toThrow(/vendor\/dep.*store/u)
      mkdirSync(parentStore)
      await gitIn(parentStore)(["init", "--quiet", "--initial-branch=main"])
      await expect(gitlinksAt(git, verifiedRoot, [nestedPath])).rejects.toThrow(
        new RegExp(`level vendor/dep: store .* does not hold parent commit ${composedPin}`, "u"),
      )
    } finally {
      if (existsSync(parentStore)) safeRemoveSync(parentStore, { within: realpathSync(tmpdir()) })
      renameSync(`${parentStore}-held`, parentStore)
    }
    const unreadable = new Error("fixture cannot read parent tree")
    const unreadableParent: Git = (args, input) => {
      if (args[0] === "-C" && args[1] === parentStore && args[2] === "ls-tree") return Promise.reject(unreadable)
      return git(args, input)
    }
    await expect(gitlinksAt(unreadableParent, verifiedRoot, [nestedPath])).rejects.toMatchObject({
      message: expect.stringContaining(`at level vendor/dep in store ${parentStore}`),
      cause: unreadable,
    })

    // @failure 26835: outward receipts identify component main as the output.
    // @level l2 @consumer library preview and submit
    // The custody assertions above never inspect the outward receipt contract.
    await git(["branch", "candidate", head])
    for (const [key, value] of Object.entries(fixtureEnv)) {
      if ((key === "PATH" || key.startsWith("GIT_CONFIG_")) && value !== undefined) vi.stubEnv(key, value)
    }
    try {
      for (const action of [inspectSubmit, submit]) {
        const receipt = await action(git, "origin", {
          branch: "candidate",
          submitter: "@dev/2",
          target: { remote: "origin", branch: "main" },
        })
        if (receipt.verifying.state !== "verified") throw new Error("receipt fixture did not verify")
        const recordedPin = (await git(["rev-parse", `${receipt.verifying.candidate}:vendor/dep`])).trim()
        expect(receipt.verifying.gitlinks.find(({ path }) => path === "vendor/dep")).toMatchObject({
          state: "merged",
          recorded: recordedPin,
          from: recordedPin,
          to: mainPin,
          composition: { parent: mainPin, pin: candidatePin },
        })
        const parentGit = gitIn(join(repo, "vendor/dep"), undefined, undefined, { env: fixtureEnv })
        const recordedNested = (await parentGit(["rev-parse", `${recordedPin}:apps/nested`])).trim()
        expect(recordedNested).toBe(nestedPin)
        expect(receipt.verifying.gitlinks.find(({ path }) => path === "vendor/dep/apps/nested")).toMatchObject({
          state: "kept-behind",
          recorded: recordedNested,
          from: nestedPin,
          to: nestedMain,
        })
      }
      // A producer disagreement must fail before a misleading receipt escapes.
      const actualVerify = verifying.verifyCandidate
      using forged = vi.spyOn(verifying, "verifyCandidate").mockImplementation(async (options) => {
        const result = await actualVerify(options)
        if (result.state !== "verified") return result
        return {
          ...result,
          verifying: {
            ...result.verifying,
            gitlinks: result.verifying.gitlinks.map((row) =>
              row.path === "vendor/dep" ? { ...row, from: mainPin } : row,
            ),
          },
        }
      })
      await expect(
        inspectSubmit(git, "origin", {
          branch: "candidate",
          submitter: "@dev/2",
          target: { remote: "origin", branch: "main" },
        }),
      ).rejects.toThrow(new RegExp(`vendor/dep state merged: producer ${mainPin}, candidate tree [0-9a-f]+`, "u"))
    } finally {
      vi.unstubAllEnvs()
    }
    const store = join(repo, "vendor/dep")
    const storeGit = gitIn(store)
    await expect(storeGit(["cat-file", "-e", `${composedPin}^{commit}`])).resolves.toBe("")
    expect(await storeGit(["show", `${composedPin}:candidate-only.txt`])).toContain("submitted side")
    expect(await storeGit(["show", `${composedPin}:main-only.txt`])).toContain("main side")

    // verifyCandidate removed its composed worktree. Disable the component
    // origin, then prove the owner can compose the verified root from custody.
    safeRemoveSync(vendor, { within: realpathSync(tmpdir()) })

    // Remove the fixture's exact origin rewrites so Git Super's exact local
    // borrow rewrites take precedence. Equal-length insteadOf entries would
    // otherwise point at the removed fixture origin instead of owner custody.
    const borrowEnv = {
      ...superEnv,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
    }
    const borrowGit = gitIn(repo, undefined, undefined, { env: borrowEnv })
    const worktree = await freshWorktree(borrowGit, repo, verifiedRoot, join(root, "after-verification"), {
      env: borrowEnv,
      populateReference: true,
    })
    expect((await gitIn(worktree.path)(["-C", "vendor/dep", "rev-parse", "HEAD"])).trim()).toBe(composedPin)
    await worktree.remove()

    expect(await storeGit(["for-each-ref", "--format=%(refname)", "refs/yrd/pins"])).toContain(composedPin)
    await storeGit(["gc", "--prune=now", "--quiet"])
    expect(await storeGit(["cat-file", "-t", composedPin])).toContain("commit")
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
    // Preserve the selected runner and stub only git-super's degraded result;
    // a bare callback cannot carry its object context and execution ownership.
    const stubbed = new Proxy(gitIn(repo), {
      apply(target, thisArg, args) {
        if ((args[0] as readonly string[])[0] === "super") return Promise.resolve(JSON.stringify(composed))
        return Reflect.apply(target, thisArg, args)
      },
    })

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
