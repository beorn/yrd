/**
 * @failure  Temporary refs created during check runs (refs/yrd-check/* and yrd-check/*)
 *           are left behind in repositories, causing seats to attempt manual deletion
 *           which trips the destructive ref-delete refusal gate (#27514).
 * @level    l2 (hermetic git repositories, real refs, real lifecycle)
 * @consumer Yrd check runner, seat environments, yrd check command
 * @testonly none
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  CHECK_REF_NAMESPACE,
  BRANCH_CHECK_REF_NAMESPACE,
  isCheckRef,
  removeCheckRef,
  sweepCheckRefs,
} from "../src/check-refs.ts"
import { type Git } from "../src/index.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

const checkRefFor = (name: string) => `${CHECK_REF_NAMESPACE}/${name.replace(/^\/+|\/+$/gu, "")}`
const branchCheckRefFor = (name: string) => `${BRANCH_CHECK_REF_NAMESPACE}/${name.replace(/^\/+|\/+$/gu, "")}`

async function createCheckRef(git: Git, name: string, sha: string): Promise<string> {
  const ref = checkRefFor(name)
  await git(["update-ref", ref, sha])
  return ref
}

async function withCheckRef<T>(git: Git, name: string, sha: string, action: (ref: string) => Promise<T>): Promise<T> {
  const ref = await createCheckRef(git, name, sha)
  try {
    return await action(ref)
  } finally {
    await removeCheckRef(git, ref, sha)
  }
}

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yrd-check-refs-test-"))
  roots.push(root)
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--initial-branch=main", work])

  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(work, "init.txt"), "init\n")
  await git(["add", "init.txt"])
  await git(["commit", "--quiet", "-m", "init"])

  const createCommit = async (msg: string): Promise<string> => {
    writeFileSync(join(work, `${msg}.txt`), `${msg}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", msg])
    return (await git(["rev-parse", "HEAD"])).trim()
  }

  return { root, work, git, createCommit }
}

describe("check-refs naming and classification", () => {
  it("defines standard check ref namespaces and helper formatters", () => {
    expect(CHECK_REF_NAMESPACE).toBe("refs/yrd-check")
    expect(BRANCH_CHECK_REF_NAMESPACE).toBe("refs/heads/yrd-check")
    expect(checkRefFor("task/foo")).toBe("refs/yrd-check/task/foo")
    expect(branchCheckRefFor("task/foo")).toBe("refs/heads/yrd-check/task/foo")
  })

  it("classifies check refs correctly", () => {
    expect(isCheckRef("refs/yrd-check/task/123")).toBe(true)
    expect(isCheckRef("refs/yrd-check/luna2-27463")).toBe(true)
    expect(isCheckRef("refs/heads/yrd-check/task/123")).toBe(true)
    expect(isCheckRef("yrd-check/task/123")).toBe(true)
    expect(isCheckRef("refs/heads/main")).toBe(false)
    expect(isCheckRef("refs/yrd/main/queue")).toBe(false)
    expect(isCheckRef("refs/heads/yrd/candidates/abc")).toBe(false)
  })
})

describe("createCheckRef and removeCheckRef", () => {
  it("creates a temporary check ref and removes it cleanly", async () => {
    const { git, createCommit } = await createFixture()
    const sha = await createCommit("c1")

    const ref = await createCheckRef(git, "test-branch", sha)
    expect(ref).toBe("refs/yrd-check/test-branch")

    const current = (await git(["rev-parse", ref])).trim()
    expect(current).toBe(sha)

    const removed = await removeCheckRef(git, ref, sha)
    expect(removed).toBe(true)

    const list = await git(["for-each-ref", "refs/yrd-check"])
    expect(list.trim()).toBe("")
  })

  it("handles removeCheckRef idempotently when ref is already gone", async () => {
    const { git } = await createFixture()
    const removed = await removeCheckRef(git, "refs/yrd-check/nonexistent")
    expect(removed).toBe(false)
  })

  it("returns false and does not remove ref when expectedSha does not match", async () => {
    const { git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")
    const ref = await createCheckRef(git, "test-mismatch", sha2)
    const removed = await removeCheckRef(git, ref, sha1)
    expect(removed).toBe(false)
    expect((await git(["rev-parse", ref])).trim()).toBe(sha2)
  })

  it("preserves check ref when concurrently replaced during cleanup (CAS ownership loss reproduction)", async () => {
    const { git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")

    const ref = await createCheckRef(git, "test-concurrent", sha1)
    expect((await git(["rev-parse", ref])).trim()).toBe(sha1)

    // Intercept git execution so that right before update-ref -d with sha1 executes,
    // a concurrent process updates ref to sha2 in the actual git repository.
    let simulatedRaceOccurred = false
    const racingGit: Git = async (args) => {
      if (args[0] === "update-ref" && args[1] === "-d" && args.includes(sha1)) {
        simulatedRaceOccurred = true
        // Concurrent update in native git
        await git(["update-ref", ref, sha2])
      }
      return git(args)
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const removed = await removeCheckRef(racingGit, ref, sha1)
      expect(simulatedRaceOccurred).toBe(true)

      // Expected-SHA check is preserved: removeCheckRef returns false,
      // and ref remains intact pointing to sha2.
      expect(removed).toBe(false)
      const currentSha = (await git(["rev-parse", ref])).trim()
      expect(currentSha).toBe(sha2)

      // Retains error diagnostic
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`yrd: failed to remove check ref ${ref}`))
    } finally {
      warn.mockRestore()
    }
  })
})

describe("withCheckRef scoped lifecycle", () => {
  it("creates temporary ref and removes it on successful action", async () => {
    const { git, createCommit } = await createFixture()
    const sha = await createCommit("c1")

    let observedRef = ""
    let observedSha = ""
    await withCheckRef(git, "scoped-pass", sha, async (ref) => {
      observedRef = ref
      observedSha = (await git(["rev-parse", ref])).trim()
    })

    expect(observedRef).toBe("refs/yrd-check/scoped-pass")
    expect(observedSha).toBe(sha)

    // Verify ref is deleted after withCheckRef settles
    const checkRefs = await git(["for-each-ref", "refs/yrd-check"])
    expect(checkRefs.trim()).toBe("")
  })

  it("removes temporary ref even when the action throws an error (failure path)", async () => {
    const { git, createCommit } = await createFixture()
    const sha = await createCommit("c1")

    let observedRef = ""
    await expect(
      withCheckRef(git, "scoped-fail", sha, async (ref) => {
        observedRef = ref
        throw new Error("simulated check execution failure")
      }),
    ).rejects.toThrow("simulated check execution failure")

    expect(observedRef).toBe("refs/yrd-check/scoped-fail")

    // Verify ref is deleted after failure
    const checkRefs = await git(["for-each-ref", "refs/yrd-check"])
    expect(checkRefs.trim()).toBe("")
  })
})

describe("sweepCheckRefs", () => {
  it("sweeps both refs/yrd-check/* and refs/heads/yrd-check/* leftovers", async () => {
    const { git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")

    // Simulate leftover temporary check refs from prior check runs
    await git(["update-ref", "refs/yrd-check/26876", sha1])
    await git(["update-ref", "refs/yrd-check/task/27488", sha2])
    await git(["update-ref", "refs/heads/yrd-check/luna2-27463", sha1])

    // Queue authority and ordinary branches must survive the local cleanup.
    const protectedRefs = ["refs/heads/main", "refs/yrd/main/changes/protected"]
    for (const ref of protectedRefs) {
      await git(["update-ref", ref, sha2])
      await expect(removeCheckRef(git, ref, sha2)).rejects.toThrow(`cannot remove non-check ref: ${ref}`)
    }

    const before = await git(["for-each-ref", "--format=%(refname)", "refs/yrd-check", "refs/heads/yrd-check"])
    const beforeList = before.trim().split("\n").sort()
    expect(beforeList).toEqual([
      "refs/heads/yrd-check/luna2-27463",
      "refs/yrd-check/26876",
      "refs/yrd-check/task/27488",
    ])

    const swept = await sweepCheckRefs(git)
    expect([...swept].sort()).toEqual([
      "refs/heads/yrd-check/luna2-27463",
      "refs/yrd-check/26876",
      "refs/yrd-check/task/27488",
    ])

    const after = await git(["for-each-ref", "--format=%(refname)", "refs/yrd-check", "refs/heads/yrd-check"])
    expect(after.trim()).toBe("")
    for (const ref of protectedRefs) {
      expect((await git(["rev-parse", ref])).trim()).toBe(sha2)
    }
  })
})
