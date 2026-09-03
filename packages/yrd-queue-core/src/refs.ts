/**
 * Every name the queue owns in the one store, which is the git repository
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Store).
 *
 * A change is named `<branch>@<sha>`, the branch and the full head sha, and
 * its ref is that name under `refs/yrd/changes/` (operator, 2026-09-02): no
 * translation anywhere, the name IS the last part of the ref. Git allows `@`
 * in a ref name (only `@{` and a lone `@` are refused), so the name is read
 * from the right: the sha is the forty hex characters after the last `@`, and
 * everything before that `@` is the branch, which may itself carry `@`.
 *
 * Git refs are file paths, so a ref AT a name forbids any ref UNDER it. With
 * the sha inside the branch's last segment, one change's ref is never a
 * directory of another's, and a branch named like another change's path no
 * longer collides. The one spelling git still refuses — a branch with a
 * segment spelled exactly like an existing change's name, `<x>@<sha>`, and
 * more segments after it — fails the atomic push at submit, loudly. A branch
 * itself is `refs/heads/<branch>` at the queue's remote, git's own name.
 */

/** Where every change lives. */
export const CHANGES = "refs/yrd/changes"

/** The name of the change a branch opened at one head: `<branch>@<sha>`. */
export function changeName(branch: string, head: string): string {
  const trimmed = branch.replace(/^\/+|\/+$/gu, "")
  if (trimmed === "") throw new Error("a change needs a branch name; got an empty one")
  return `${trimmed}@${head}`
}

/** The change a branch opened at one head: its name under `refs/yrd/changes/`. */
export function changeRef(branch: string, head: string): string {
  return `${CHANGES}/${changeName(branch, head)}`
}

/**
 * The branch and head a change name spells, or undefined when the text is not
 * one. The sha has no `@` and no `/`, so the last `@` of the whole name is the
 * one before it, and a name whose tail is not a full sha is not a change name.
 */
export function parseChangeName(name: string): Readonly<{ branch: string; head: string }> | undefined {
  const cut = name.lastIndexOf("@")
  if (cut <= 0) return undefined
  const head = name.slice(cut + 1)
  if (!/^[0-9a-f]{40}$/u.test(head)) return undefined
  return { branch: name.slice(0, cut), head }
}

/** The branch and head a change ref names, or undefined when the ref is not one. */
export function parseChangeRef(ref: string): Readonly<{ branch: string; head: string }> | undefined {
  if (!ref.startsWith(`${CHANGES}/`)) return undefined
  return parseChangeName(ref.slice(CHANGES.length + 1))
}
