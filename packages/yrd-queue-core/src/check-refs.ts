/**
 * Temporary check ref naming, classification, lifecycle, and teardown cleanup (27514).
 *
 * Temporary check refs exist under:
 * - `refs/yrd-check/*` (direct check ref namespace)
 * - `refs/heads/yrd-check/*` (branch-shaped check ref namespace)
 *
 * Check runs create temporary refs under these namespaces during verification
 * and check execution. When checks complete (pass or fail) or encounter errors,
 * the creating tool (Yrd / check runner) cleans up and removes its temporary refs
 * rather than leaving them behind for manual deletion by seats, which trips the
 * destructive ref-delete refusal gate (core.git:update-ref-delete).
 */

import type { Git } from "./git.ts"

export const CHECK_REF_NAMESPACE = "refs/yrd-check"
export const BRANCH_CHECK_REF_NAMESPACE = "refs/heads/yrd-check"

/** Whether a ref name belongs to either temporary check ref namespace. */
export function isCheckRef(ref: string): boolean {
  return (
    ref.startsWith(`${CHECK_REF_NAMESPACE}/`) ||
    ref.startsWith(`${BRANCH_CHECK_REF_NAMESPACE}/`) ||
    ref.startsWith("yrd-check/")
  )
}

/**
 * Remove a specific temporary check ref using git update-ref -d.
 * If expectedSha is given, deletes only when the ref points to expectedSha.
 * Returns true if the ref was deleted, false if it was not present.
 */
export async function removeCheckRef(git: Git, ref: string, expectedSha?: string): Promise<boolean> {
  if (!isCheckRef(ref)) {
    throw new Error(`cannot remove non-check ref: ${ref}`)
  }

  const listing = (await git(["for-each-ref", "--format=%(objectname)", ref])).trim()
  if (listing === "") return false
  const actualSha = listing.split("\n")[0]
  if (expectedSha !== undefined && expectedSha !== "" && actualSha !== expectedSha) {
    return false
  }

  const args = ["update-ref", "-d", ref]
  if (expectedSha !== undefined && expectedSha !== "") {
    args.push(expectedSha)
  }
  try {
    await git(args)
    return true
  } catch (err) {
    // silent-fallback-allow: ref was concurrently removed by another process or unlinked
    console.warn(`yrd: failed to remove check ref ${ref}: ${String(err)}`)
    return false
  }
}

/**
 * Sweep and remove all temporary check refs under refs/yrd-check/* and refs/heads/yrd-check/*
 * from the local repository.
 * Returns the list of deleted ref names.
 */
export async function sweepCheckRefs(git: Git): Promise<readonly string[]> {
  const listing = await git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    CHECK_REF_NAMESPACE,
    BRANCH_CHECK_REF_NAMESPACE,
  ])

  const deleted: string[] = []
  for (const line of listing.trim().split("\n")) {
    if (line === "") continue
    const [ref, sha] = line.split(/\s+/u)
    if (ref === undefined || sha === undefined || ref === "" || sha === "") continue
    if (!isCheckRef(ref)) continue

    const removed = await removeCheckRef(git, ref, sha)
    if (removed) {
      deleted.push(ref)
    }
  }

  return deleted
}
