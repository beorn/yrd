/**
 * @failure A `.git` entry that EXISTS but cannot be read was swallowed by a bare catch in
 *          `worktreeAdminDir`, whose `undefined` the plain-removal guard reads as "no admin dir, nothing to
 *          protect": the checkout — and any declared-private submodule store in its admin dir — was then
 *          deleted without the declaration ever being consulted (the no-silent-fallbacks guard, 28661).
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
 * Only `lstat` is narrowed. A `.git` that `existsSync` reports and `lstatSync` refuses to read is the exact
 * split the cure must not swallow, and it is the one shape a real test cannot produce here: the suite runs as
 * uid 0, so EACCES does not bite. Every other read delegates to the real module.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const lstatSync = (path: Parameters<typeof actual.lstatSync>[0], ...rest: never[]): unknown => {
    if (String(path).endsWith(".git")) {
      const refused = new Error(`EACCES: permission denied, lstat '${String(path)}'`) as NodeJS.ErrnoException
      refused.code = "EACCES"
      throw refused
    }
    return (actual.lstatSync as (at: unknown, ...tail: never[]) => unknown)(path, ...rest)
  }
  return { ...actual, lstatSync: lstatSync as typeof actual.lstatSync }
})

import { refusePrivateStoreRemoval } from "../src/worktree.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** A git seam that FAILS the test if it is reached: both cases below are decided before any git call. */
const unreached = async (): Promise<string> => {
  throw new Error("git must not be asked: the answer is decided from the `.git` entry alone")
}

const checkoutUnder = (): string => {
  const root = mkdtempSync(join(tmpdir(), "yrd-unreadable-dotgit-"))
  roots.push(root)
  const checkout = join(root, "checkout")
  mkdirSync(checkout, { recursive: true })
  return checkout
}

describe("an unreadable .git refuses by name instead of reading as 'nothing to protect' (28661)", () => {
  it("throws PrivateStoreRefusalError naming the entry and the cause, and keeps the checkout", async () => {
    const checkout = checkoutUnder()
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

  it("keeps an ABSENT .git a plain answer: no admin dir, nothing to protect, no refusal", async () => {
    const checkout = checkoutUnder()

    await expect(refusePrivateStoreRemoval(unreached, checkout, checkout)).resolves.toBeUndefined()
  })
})
