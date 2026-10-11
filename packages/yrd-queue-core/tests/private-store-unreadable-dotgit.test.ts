/**
 * @failure An unreadable `.git` entry read as "no admin dir, nothing to protect", so a plain removal deleted a
 *          checkout — and the declared-private store in its admin dir — without the declaration ever being
 *          consulted. The first cure decided absence from `existsSync`, which answers FALSE for an entry the
 *          kernel refuses with EACCES (@dev/fixer's uid-3001 reproduction: `exists false`, `lstat EACCES`,
 *          removal ALLOWED, 0 git calls), so the hole stayed open behind a green test.
 * @level   l1
 * @consumer refusePrivateStoreRemoval, the guard every PLAIN removal (rmSync + prune, safeRemoveSync) asks
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { PrivateStoreRefusalError } from "git-super/worktree"

/**
 * BOTH seams, because the pair is what the failure was: `lstatSync` is the kernel's refusal — a `.git` under a
 * directory named `unreadable-…` throws the EACCES a permission-denied entry really gives — and `existsSync` is
 * made to answer FALSE for every `.git` probe, exactly the way it answers an EACCES. A cure that decides "absent"
 * from `existsSync` therefore fails these tests instead of shipping a blind cleanup. Every other read delegates
 * to the real module, so the absent case exercises the real ENOENT.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const isDotGit = (path: unknown): boolean => String(path).endsWith(".git")
  return {
    ...actual,
    existsSync: ((path: Parameters<typeof actual.existsSync>[0]) =>
      isDotGit(path) ? false : actual.existsSync(path)) as typeof actual.existsSync,
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], ...rest: never[]) => {
      if (isDotGit(path) && String(path).includes("unreadable-")) {
        const refused = new Error(`EACCES: permission denied, lstat '${String(path)}'`) as NodeJS.ErrnoException
        refused.code = "EACCES"
        throw refused
      }
      return (actual.lstatSync as (at: unknown, ...tail: never[]) => unknown)(path, ...rest)
    }) as typeof actual.lstatSync,
  }
})

import { refusePrivateStoreRemoval } from "../src/worktree.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** A git seam that FAILS the test if it is reached: both cases are decided before any git call. */
const unreached = async (): Promise<string> => {
  throw new Error("git must not be asked: the answer is decided from the `.git` entry alone")
}

const checkoutUnder = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const checkout = join(root, "checkout")
  mkdirSync(checkout, { recursive: true })
  return checkout
}

describe("an unreadable .git refuses by name instead of reading as 'nothing to protect' (28661)", () => {
  it("refuses BY NAME when `.git` exists but the kernel refuses it (EACCES, and existsSync says false)", async () => {
    const checkout = checkoutUnder("yrd-unreadable-dotgit-")
    writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere\n")

    const error = await refusePrivateStoreRemoval(unreached, checkout, checkout).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(PrivateStoreRefusalError)
    expect(String(error)).toContain(join(checkout, ".git"))
    expect(String(error)).toContain("cannot be read")
    expect(String(error)).toContain("EACCES")
    expect(existsSync(checkout), "a checkout whose store cannot be verified is kept").toBe(true)
  })

  it("keeps TRUE absence a plain answer: nothing at that name, nothing to protect, no refusal", async () => {
    const checkout = checkoutUnder("yrd-absent-dotgit-")

    await expect(refusePrivateStoreRemoval(unreached, checkout, checkout)).resolves.toBeUndefined()
  })
})
