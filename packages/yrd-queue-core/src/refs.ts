/**
 * Every name the queue owns in the one store, which is the git repository
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Store).
 *
 * Git refs are file paths, so a ref AT a name forbids any ref UNDER that name:
 * `refs/yrd/changes/task/x` and `refs/yrd/changes/task/x/y` cannot both exist.
 * The change ref therefore always ends in the head sha, which is why a branch
 * and the change it opened never collide however the branch is named. A branch
 * itself is `refs/heads/<branch>` at the queue's remote, git's own name.
 */

/** Where a branch's changes live. */
export const CHANGES = "refs/yrd/changes"

/** The change a branch opened at one head. */
export function changeRef(branch: string, head: string): string {
  const trimmed = branch.replace(/^\/+|\/+$/gu, "")
  if (trimmed === "") throw new Error("a change needs a branch name; got an empty one")
  return `${CHANGES}/${trimmed}/${head}`
}

/** The branch and head a change ref names, or undefined when the ref is not one. */
export function parseChangeRef(ref: string): Readonly<{ branch: string; head: string }> | undefined {
  if (!ref.startsWith(`${CHANGES}/`)) return undefined
  const rest = ref.slice(CHANGES.length + 1)
  const cut = rest.lastIndexOf("/")
  if (cut <= 0) return undefined
  const head = rest.slice(cut + 1)
  if (!/^[0-9a-f]{40}$/u.test(head)) return undefined
  return { branch: rest.slice(0, cut), head }
}
